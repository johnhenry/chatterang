/**
 * The engine: aimatey Router + Bridge, assembled (PRD §2).
 *
 * Everything above this file — chat, tasks, benchmarks, vision, the whole UI
 * — talks to `ChatterangEngine`. Everything below it is an aimatey backend
 * adapter. That is the seam that makes the Phase 2–4 runtime rollout additive
 * instead of invasive: a new engine is `router.register(id, adapter)` and a
 * manifest field, not a change to any call site.
 */

import { Bridge, Router } from '@johnhenry/aimatey-core';
import { GenericFrontendAdapter } from '@johnhenry/aimatey-frontend';
import { ChromeAIBackendAdapter, LiteRtLmBackendAdapter } from '@johnhenry/aimatey-backend-browser';
// Imported from subpaths, not the package barrel: the barrel pulls in the
// caching middleware, which imports Node's `crypto` and would be externalised
// (and then fail) inside a webview.
import { createLoggingMiddleware } from '@johnhenry/aimatey-middleware/logging';
import { createRetryMiddleware } from '@johnhenry/aimatey-middleware/retry';
import { ErrorCode } from '@johnhenry/aimatey-types';
import type {
  BackendAdapter,
  FinishReason,
  IRChatRequest,
  IRChatResponse,
  IRMessage,
  IRStreamChunk,
  Middleware,
  ToolUseContent,
} from '@johnhenry/aimatey-types';

import {
  LlamaCppBackendAdapter,
  type LlamaCppBackendConfig,
  type LlamaModelResolver,
} from '@/ai/backends/llama-cpp';
import {
  callNames,
  createToolMiddleware,
  cutUnfinishedCall,
  findToolCalls,
  runToolCalls,
  shownCalls,
  stripToolSyntax,
  unlessStopped,
  type ExecutedTool,
  type TextEnding,
  type ToolDestinationPolicy,
} from '@/ai/middleware/tools';
import {
  checkDevicePressure,
  classifyFailure,
  createResilienceMiddleware,
  type FallbackEvent,
  type FallbackReason,
} from '@/ai/middleware/resilience';
import {
  carriesTaint,
  clearForDestination,
  markTainted,
  taintedCharacters,
  type ClearedMessage,
} from '@/ai/taint';
import { toolRegistry, type ChatterangTool } from '@/ai/tools/registry';
import { fallbackWarning, mergeWarnings, warningsOf, type TurnWarning } from '@/ai/warnings';
import { connectionConfig, getProvider, type ProviderConnection } from '@/ai/providers';
import { CliBackendAdapter } from '@/ai/backends/cli';
import type { EngineId } from '@/domain/manifest';
import { isLocalEngine } from '@/domain/manifest';
import { REACH_DEVICE, REACH_REMOTE, closeReasoning, newId, type Reach } from '@/domain/chat';

/**
 * Execute → tools → execute round trips permitted per turn.
 *
 * Exported so a persona's `agentConfig.toolPolicy.maxToolRounds` (#23) has
 * something to be clamped against — a persona may ask for FEWER rounds than
 * this, never more.
 */
export const TOOL_ITERATIONS = 4;

/**
 * The one place a persona's `maxToolRounds` preference is turned into a
 * trustworthy round count, used at both boundaries that clamp it
 * (`narrowToolPolicy`, state/chat.ts, and this engine's own request
 * handling) so the failure mode below is fixed once, not twice (#23, #122;
 * adversarial review, MEDIUM).
 *
 * FOUND: `Math.min(NaN, TOOL_ITERATIONS)` is `NaN` — `typeof NaN ===
 * 'number'`, so a plain `typeof x === 'number'` guard let it straight
 * through `Math.max(0, Math.min(x, TOOL_ITERATIONS))`, which is ALSO
 * `NaN`. `iteration >= NaN` is never true for any `iteration`, so
 * `roundLimitReached` never fired and the loop's own hard
 * `iteration <= TOOL_ITERATIONS` bound became the only ceiling left — one
 * round WIDER than an absent preference gets, not narrower. Reproduced: 5
 * calls dispatched with `TOOL_ITERATIONS` at 4 and `maxToolRounds: NaN`,
 * against 4 with no `maxToolRounds` at all.
 *
 * So this checks `Number.isFinite`, not `typeof … === 'number'`: `NaN`,
 * `Infinity` and `-Infinity` all satisfy the latter and none satisfy the
 * former. Anything that fails the check — `NaN`, either infinity, a
 * string, `undefined` — behaves exactly as an ABSENT preference, returning
 * `TOOL_ITERATIONS` itself, never something looser AND never a value that
 * silently zeroes a turn's tool rounds because of a type it could not
 * parse. A finite non-integer (`2.5`) is truncated rather than rejected —
 * a persona that means "about 2" is not a persona sending nonsense.
 */
export function clampToolRounds(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return TOOL_ITERATIONS;
  return Math.max(0, Math.min(Math.trunc(value), TOOL_ITERATIONS));
}

/* ── Tool-output egress ─────────────────────────────────────────────── */

/**
 * What the user is being asked to allow.
 *
 * The shape is the sheet's shape on purpose: a destination, a model, and the
 * tools whose output would go with the request. "2,140 characters of your
 * conversations" is a thing a person can decide about; "the request contains a
 * tool message" is not.
 */
export interface ToolEgressRequest {
  /** Router registration id — the connection, not the provider family. */
  readonly backendId: string;
  readonly modelName: string;
  readonly tools: readonly ExecutedTool[];
  readonly characters: number;
}

/**
 * `turn` allows this request only; `conversation` allows this chat and this
 * destination until revoked; `deny` withholds.
 *
 * There is deliberately no app-wide "always". The shell's projection grows as
 * the user's data grows, so a grant made in January cannot speak for a chat
 * opened in June.
 */
export type ToolEgressDecision = 'turn' | 'conversation' | 'deny';

export interface ToolEgressPolicy {
  /** Grants this conversation already holds, by backend id. */
  isGranted(backendId: string): boolean;
  /**
   * Ask. Absent means there is nobody to ask, which is a refusal.
   *
   * `signal` is the turn's: a sheet raised here should come down when it
   * aborts. The engine does not rely on that — an answer that arrives after
   * Stop reaches nothing either way.
   */
  request?(request: ToolEgressRequest, signal?: AbortSignal): Promise<ToolEgressDecision>;
  /** Persist a `conversation` decision. */
  onGranted?(backendId: string): void;
  /**
   * How many times this destination's grants have been withdrawn — its
   * connection removed or switched off. A yes the turn is holding is honoured
   * only while this stands; see `decided` in `stream`. Absent means nothing
   * withdraws this policy's grants, and a yes is held for the turn.
   */
  revocations?(backendId: string): number;
}

/**
 * The string the model gets instead of the bytes.
 *
 * A note rather than a truncation, and rather than dropping the message: a
 * model handed an empty tool result concludes the command failed and runs it
 * again. A model told plainly what happened can say so, or answer without it.
 * The user still sees the real, complete output in the thread — the shell ran
 * locally and their answer is not what was withheld.
 */
function withheldNote(characters: number): string {
  return (
    'The user declined to send this off-device. It came from a tool that ran ' +
    `locally and produced ${characters.toLocaleString('en-US')} characters. Ask them to run the ` +
    'command themselves, or answer without it.'
  );
}

/**
 * The tool names this request declares, which are the app's own strings.
 *
 * `clearForDestination` keeps a withheld call's name only if it is in here.
 * Built from the registry rather than from the message array on purpose: the
 * names IN the array are whatever the model typed, and the whole point is to
 * compare them against a set the model did not write.
 */
function declaredToolNames(toolIds: readonly string[] | undefined): ReadonlySet<string> {
  return new Set((toolIds?.length ? toolRegistry.toIRTools(toolIds) : []).map((tool) => tool.name));
}

/**
 * The tools a request declares, as the registry holds them when it is built —
 * the same lookup `#toIR` makes to tell the model what it may call.
 *
 * Handed to the dispatcher only to name a call whose tool left the registry
 * before the call was dispatched (`declared` on `runToolCalls`, #92). Nothing is
 * ever run from it.
 */
function declaredTools(toolIds: readonly string[] | undefined): ChatterangTool[] {
  return (toolIds ?? []).flatMap((id) => {
    const tool = toolRegistry.get(id);
    return tool ? [tool] : [];
  });
}

/**
 * A round's words as they join the finished reply: any call the round ended
 * inside cut, when it could have written one (see `cutUnfinishedCall`), and its
 * finished calls stripped.
 *
 * `offered` is the names a call can give, as `callNames` gives them; `ran` is
 * whether a tool has run in the turn; `ended` is how the round's stream ended
 * (see `TextEnding`). A round the model ended keeps words that run on from
 * inside a call's value: they are a sentence that named its opening.
 */
function roundWords(
  text: string,
  { offered, ran, ended }: { readonly offered: readonly string[]; readonly ran: boolean; readonly ended: TextEnding },
): string {
  const cut = offered.length > 0 || ran ? cutUnfinishedCall(text, { ended, offered }) : text;
  return stripToolSyntax(cut, { offered, ran });
}

/**
 * The words of a round another round follows — one that called a tool, or one
 * whose stream died before the turn diverted to the fallback — as they join the
 * finished reply: see {@link roundWords}. And any reasoning it left open is
 * closed where it ended, so the next round's words are answer, not reasoning:
 * see `closeReasoning`.
 */
function endedRoundWords(
  text: string,
  reading: { readonly offered: readonly string[]; readonly ran: boolean; readonly ended: TextEnding },
): string {
  return closeReasoning(roundWords(text, reading));
}

/**
 * How a round's stream ended, from the reason its last chunk gave: the model
 * ending it, `stop` or `tool_calls`; or anything else — its limit on tokens, a
 * filter — which cut it short. See `TextEnding`.
 */
function endingOf(reason: FinishReason): TextEnding {
  return reason === 'stop' || reason === 'tool_calls' ? 'model' : 'cut';
}

interface TurnResult {
  text: string;
  stats: GenerationStatsSnapshot;
  /**
   * How the round's stream ended: `'model'` when its last chunk said the model
   * ended it, `'cut'` for anything else — its limit on tokens, a filter, an
   * error, or no last chunk at all. See `endingOf`.
   */
  ended: TextEnding;
  error?: string;
  /**
   * The IR error chunk's `code`, kept because the message alone is not enough
   * to say anything useful to the user. Dropping it here is what let
   * `No available backend for routing` reach a message row: the string was
   * rewrapped in a plain Error and the code that could have been mapped went
   * with it. The chunk carries no `isRetryable`, so a code that needs one is
   * read as the AdapterError default of false.
   */
  errorCode?: string;
}

/**
 * What to say when a target names a backend the router does not have.
 *
 * Two unrelated causes reach here, and only one of them is about the build.
 *
 * A remote target's `backendId` is a connection id, not an engine: it is
 * unregistered because `connectProvider` failed — a rotated key, an offline
 * self-hosted server, DNS — and `initialize` catches that, toasts it, and
 * leaves the connection `enabled` in state (src/state/app.ts). The build ships
 * every remote adapter it ever shipped; nothing is missing. Telling that user
 * their build lacks a runtime is false, and "choose another model" cannot fix
 * a wrong API key, so this points at the place that can.
 *
 * "Reconnect it in Settings" was the previous attempt at that, and it named a
 * button that does not exist. Measured by mounting the real `ProvidersPanel`
 * with exactly this state — a connection whose `connectProvider` threw:
 *
 *   <button role="switch" aria-checked="true" aria-label="Enable OpenAI">
 *   <button class="icon-btn" aria-label="Remove OpenAI">
 *
 * Three controls on the whole panel — enable, remove, add. No "Reconnect", no
 * edit control, and a toggle rendering CHECKED, because `enabled` stays true
 * when the connection fails. So that screen reports the provider as ON and
 * shows no problem whatsoever, and a user sent there arrives at a healthy row
 * with nothing to press. Naming a remedy that is not on the screen is the same
 * defect as the original bug, one layer in.
 *
 * What the screen can actually do is said instead, in the order that costs the
 * user least: toggling off and back on re-runs `connectProvider`
 * (`toggleConnection`, src/state/app.ts), which is the whole fix when the
 * service was merely unreachable; and remove-then-add is named for a wrong key
 * because with no edit control it is the only way to replace one. The warning
 * that it still shows as switched on is there so the user does not conclude,
 * from a screen that looks fine, that the message was wrong.
 *
 * The build sentence is reserved for a genuinely absent LOCAL engine, which is
 * the residual case the backstop exists for. It does not name the engine id:
 * `onnx-runtime` reads back as "the onnx-runtime runtime", and the id is an
 * aimatey registration name that means nothing to the person reading it.
 */
/**
 * Circuit-breaker settings, named because what the user reads is derived from
 * them. Written inline, the sentence could say "thirty seconds" long after the
 * timeout had been changed, which is the same class of defect as the vendor
 * string it replaces.
 */
const BREAKER_THRESHOLD = 3;
const BREAKER_TIMEOUT_MS = 30_000;

/**
 * What to say when there is no backend able to take the turn.
 *
 * The second leak of aimatey's vocabulary through the door
 * `unregisteredBackendMessage` closed, and the string is not the one it was
 * expected to be. #187 predicted `Circuit breaker is open for backend
 * 'conn_openai'` from `checkCircuitBreaker`. Measured, that string is
 * unreachable on this path: `selectBackend` (router.js:494) only prefers the
 * explicit backend `if (this.isBackendAvailable(preferredBackend))`, and an
 * open circuit makes it unavailable -- so selection SKIPS the backend rather
 * than executing it, and `checkCircuitBreaker` never runs. What the user
 * actually reads, once every circuit is open, is `No available backend for
 * routing` (NO_BACKEND_AVAILABLE), which says even less.
 *
 * Both codes are mapped, because they arrive by different routes:
 *
 *   NO_BACKEND_AVAILABLE  every backend is failing or paused -- the reachable
 *                         case, measured in tests/engine.test.ts
 *   PROVIDER_UNAVAILABLE  a specific backend refused. `chrome-ai` throws it
 *                         when the Prompt API is absent ("requires Chrome
 *                         138+ ... chrome://flags/#prompt-api-for-gemini-nano")
 *
 * TWO OUTCOMES, NOT ONE. A pause is temporary; a missing Prompt API is not.
 * Telling the second user to try again shortly would be a new false sentence,
 * so they are told apart STRUCTURALLY rather than by matching message text,
 * which aimatey is free to reword: a paused backend sets `isRetryable: true`
 * (router.js `checkCircuitBreaker`), a capability failure leaves it at the
 * `AdapterError` default of false. That flag is exactly the distinction the
 * two sentences turn on -- come back later, versus this will not work here.
 *
 * Neither sentence names a backend id. `conn_openai` is a registration name;
 * the model name is what the user chose.
 *
 * NOT COVERED, deliberately: which backend actually served a turn after
 * selection skipped the one that was asked for. That is #228, and it is a
 * consent defect rather than a wording one.
 */
function noBackendMessage(target: EngineTarget, retryable: boolean): string {
  if (!retryable) {
    // A capability gap. Nothing to wait for, so the remedy is another model.
    // "on this device" is only said where it is true: chrome-ai's missing
    // Prompt API is a property of the device, a refusing provider is not.
    return isLocalEngine(target.engine)
      ? `${target.modelName} is not available on this device. Choose another model.`
      : `${target.modelName} is not available. Choose another model.`;
  }
  const seconds = Math.round(BREAKER_TIMEOUT_MS / 1000);
  if (!isLocalEngine(target.engine)) {
    return (
      `${target.modelName} failed ${BREAKER_THRESHOLD} times in a row, so it is paused for ` +
      `${seconds} seconds. Try again in a moment. If it keeps failing, under Remote ` +
      `providers in Settings switch it off and on again, or remove it and add it again ` +
      `to enter a new key.`
    );
  }
  return (
    `${target.modelName} failed ${BREAKER_THRESHOLD} times in a row, so it is paused for ` +
    `${seconds} seconds. Try again in a moment, or choose another model.`
  );
}

/**
 * Whether an error means "nothing can take this turn", and if so whether
 * waiting could help. Null when it is some other failure.
 *
 * Matched on `code`, never on the message: the strings are aimatey's to
 * reword, and #187 exists because one of them reached a user verbatim.
 */
function noBackendRetryable(error: unknown): boolean | null {
  if (typeof error !== 'object' || error === null) return null;
  const candidate = error as { code?: unknown; isRetryable?: unknown };
  if (candidate.code === ErrorCode.NO_BACKEND_AVAILABLE) return true;
  if (candidate.code !== ErrorCode.PROVIDER_UNAVAILABLE) return null;
  return candidate.isRetryable === true;
}

function unregisteredBackendMessage(target: EngineTarget): string {
  if (!isLocalEngine(target.engine)) {
    return (
      `${target.modelName} is not connected — the key may be wrong, or the service ` +
      `unreachable. Under Remote providers in Settings it still shows as switched on: ` +
      `switch it off and on again to retry, or remove it and add it again to enter a new key.`
    );
  }
  return `${target.modelName} needs a runtime this build does not include. Choose another model.`;
}

/* ── Public surface ─────────────────────────────────────────────────── */

export interface EngineTarget {
  /** Backend id registered on the router. */
  readonly backendId: string;
  readonly engine: EngineId;
  /** Model id passed to the backend. */
  readonly modelId: string;
  readonly modelName: string;
  /**
   * How far this turn travels.
   *
   * Was `local: boolean`. One flag was answering three different questions
   * (#208), which had the same answer for every destination that existed at
   * the time and stop having one the moment a paired desktop appears:
   *
   *   1. may this turn divert to a cloud fallback?  -> runsOnThisDevice()
   *   2. do the bytes leave this device?            -> leavesThisDevice()
   *   3. does this app's taint mark survive?        -> keepsTaintMark()
   *
   * Since #112 those are PROJECTIONS of two axes rather than switches over one
   * value: (1) reads `reach.host`, (2) and (3) read `reach.reached`. A local
   * CLI with a vendor upstream is the case that separates them — it runs here
   * AND the bytes reach a third party, and the old single axis could only say
   * one of those. Read them through the predicates rather than off `reach`, so
   * the next destination is a change there and not an audit of every call site.
   */
  readonly reach: Reach;
}

/**
 * Does this turn execute on this device?
 *
 * The fallback question. Only a turn that was going to run here can be
 * diverted to the configured cloud provider by device pressure or by a
 * failure, because only then is there something to divert *from*.
 */
export function runsOnThisDevice(target: EngineTarget): boolean {
  return target.reach.host.kind === 'device';
}

/**
 * Do this turn's bytes leave this device?
 *
 * The egress question, and the one that made #208 a security ticket rather
 * than a naming one. A paired desktop is not a third party, but it is another
 * machine: tool output reaching it has left the phone, and the user is owed
 * the same sheet a provider raises. Registering the tunnel as "local" because
 * it is the user's own hardware would silently delete that sheet.
 */
export function leavesThisDevice(target: EngineTarget): boolean {
  return target.reach.reached !== 'device';
}

/**
 * Does this app's taint mark survive to the destination?
 *
 * Deliberately not the inverse of `leavesThisDevice`. The mark is this app's
 * private bookkeeping and means nothing to a third-party provider, so it is
 * stripped for one. A paired desktop is the one destination where the far
 * side is *this same application*, which runs `renderPrompt` itself and could
 * act on the mark -- so keeping it there is arguably correct.
 *
 * It is stripped today regardless, because nothing writes `paired` yet and a
 * flag whose only reader does not exist is a flag that will be wrong by the
 * time one does. The decision belongs with the tunnel adapter that first
 * produces a paired target; this predicate is where to make it.
 */
export function keepsTaintMark(target: EngineTarget): boolean {
  return target.reach.reached === 'device';
}

export interface GenerationRequest {
  readonly messages: readonly IRMessage[];
  readonly target: EngineTarget;
  readonly sampler?: {
    temperature?: number;
    topP?: number;
    topK?: number;
    maxTokens?: number;
    seed?: number | null;
    stopSequences?: readonly string[];
    frequencyPenalty?: number;
    presencePenalty?: number;
  };
  readonly toolIds?: readonly string[];
  /**
   * Consent for sending tool output to a non-local backend.
   *
   * Omitting it is a refusal, not a bypass. That is deliberate: the defect this
   * closes was that `stream` built one message array and handed it to whichever
   * backend `target` named at that instant, so a caller that had never thought
   * about egress leaked by default. Now a caller that has never thought about
   * it withholds by default, and the model is told why.
   */
  readonly egress?: ToolEgressPolicy;
  /**
   * Consent for sending an MCP tool call's arguments to its server (#6).
   *
   * Omitting it is a refusal, as with `egress`: no call that leaves the device
   * is sent. It is consulted whatever the target — a local model's call sends
   * its arguments to the server just as a remote model's does.
   *
   * An unattended caller must leave out `request`; see `ToolDestinationPolicy`.
   */
  readonly mcpEgress?: ToolDestinationPolicy;
  /**
   * A persona's `agentConfig.toolPolicy.maxToolRounds`, already narrowed to
   * at most `TOOL_ITERATIONS` by `narrowToolPolicy` (#23, #122) — clamped
   * AGAIN here regardless, since this request field is the one thing an
   * untrusted caller could hand a larger number to. Absent means the
   * engine's own `TOOL_ITERATIONS` applies, unchanged.
   */
  readonly maxToolRounds?: number;
  /**
   * Asked before a NON-destination tool call runs — `runToolCalls`'s
   * `confirmEachCall`, threaded through. The enforcement for
   * `agentConfig.toolPolicy.confirmPolicy === 'always-ask'` (#23, #122).
   */
  readonly confirmEachCall?: (call: ToolUseContent, signal?: AbortSignal) => Promise<boolean>;
  readonly signal?: AbortSignal;
}

export type GenerationEvent =
  | { readonly type: 'start'; readonly requestId: string }
  | { readonly type: 'delta'; readonly text: string }
  | {
      readonly type: 'tool';
      readonly tool: ExecutedTool;
      /**
       * How the round that wrote the call ended (see `TextEnding`): `'model'`
       * or `'cut'` as its stream said, `'stopped'` for a call Stop caught in a
       * round it cut short. The round's words are read by it where it ends.
       * Absent reads as `'cut'`.
       */
      readonly ended?: TextEnding;
    }
  | { readonly type: 'fallback'; readonly event: FallbackEvent }
  /** A request carrying tool output met a non-local backend. The receipt. */
  | {
      readonly type: 'egress';
      readonly backendId: string;
      readonly withheld: boolean;
      readonly toolNames: readonly string[];
      readonly characters: number;
    }
  | {
      readonly type: 'done';
      /**
       * Every round's words, each cut where a call it ended inside starts and
       * its finished calls stripped, joined by a blank line.
       */
      readonly text: string;
      readonly stats: GenerationStatsSnapshot;
      readonly provenance: ProvenanceSnapshot;
      readonly tools: readonly ExecutedTool[];
    }
  | { readonly type: 'error'; readonly message: string };

export interface GenerationStatsSnapshot {
  promptTokens?: number;
  cachedTokens?: number;
  completionTokens?: number;
  ttftMs?: number;
  totalMs?: number;
  tokensPerSecond?: number;
  draftAcceptance?: number;
  computeBackend?: string;
  peakMemoryBytes?: number;
}

export interface ProvenanceSnapshot {
  backendId: string;
  engine: EngineId;
  modelId: string;
  modelName: string;
  local: boolean;
  /**
   * The full three-valued reach, alongside `local` rather than instead of it
   * (#42, #112). `local` is `runsOnThisDevice(target)` — true for BOTH
   * `REACH_DEVICE` and `REACH_LOCAL_VIA_THIRD_PARTY`, since a local agent CLI
   * genuinely does run here — so a reader that reconstructed `Reach` from
   * `local` alone (as `state/chat.ts` used to) could never tell those two
   * apart: exactly `src/domain/chat.ts`'s `ranThroughLocalCli` needing more
   * than `ranOnDevice` to answer the question a reader is actually owed.
   * `local` stays for the callers pinned on it as a boolean (`tests/engine.test.ts`);
   * this field is what a caller that needs the real shape reads instead.
   */
  reach: Reach;
  fallbackFrom?: string;
  fallbackReason?: FallbackReason;
  /**
   * What went wrong on the way, if anything (#149).
   *
   * Absent when the turn was clean, which is almost every turn. Present means
   * there is a sentence to show the user -- `metadata.warnings` from the
   * response, plus the engine's own view of a divert, merged and deduplicated.
   */
  warnings?: readonly TurnWarning[];
  /**
   * Whether this reply's request carried tool output off the device.
   *
   * Absent when no tool output was in play — which is every turn that used no
   * tools, and every turn served locally. The chip only appears when there is
   * something to report.
   */
  toolEgress?: 'granted' | 'withheld';
}

export interface EngineOptions {
  resolver: LlamaModelResolver;
  /** Backend id used when the device cannot serve a request locally. */
  fallbackBackendId?: string | null;
  onWarning?: (message: string) => void;
  onFallback?: (event: FallbackEvent) => void;
  /** A local generation is waiting for the desktop's shared slot, or has started (#7). */
  onWaiting?: LlamaCppBackendConfig['onWaiting'];
  debug?: boolean;
}

/* ── Engine ─────────────────────────────────────────────────────────── */

export class ChatterangEngine {
  readonly router: Router;
  readonly llama: LlamaCppBackendAdapter;

  #bridge: Bridge<GenericFrontendAdapter>;
  #options: EngineOptions;
  #remotes = new Map<string, BackendAdapter>();
  /** Default model per registered backend, used when a fallback retargets. */
  #fallbackModels = new Map<string, string>();
  /**
   * Connection ids whose descriptor is `kind: 'local-cli'` (#42, #115).
   *
   * A CLI backend runs on THIS device but reaches its own vendor over a
   * login this app never sees — a divert to it would be the honest opposite
   * of what a cloud-pressure fallback is for. `setFallbackBackend` below is
   * the one place `#options.fallbackBackendId` is ever assigned, so refusing
   * a CLI connection id there is sufficient to keep `#resolveFallback` (the
   * one place that id is ever read back) from ever handing a divert to one —
   * there is no second path that sets this option.
   */
  #cliConnectionIds = new Set<string>();
  #pendingTools: ExecutedTool[] = [];
  #lastFallback: FallbackEvent | null = null;
  /** `metadata.warnings` from the response this turn produced (#149). */
  #responseWarnings: readonly TurnWarning[] = [];

  constructor(options: EngineOptions) {
    this.#options = options;

    this.router = new Router({
      routingStrategy: 'explicit',
      fallbackStrategy: 'none', // Fallback is a consent decision, not automatic.
      trackLatency: true,
      enableCircuitBreaker: true,
      circuitBreakerThreshold: BREAKER_THRESHOLD,
      circuitBreakerTimeout: BREAKER_TIMEOUT_MS,
    });

    this.llama = new LlamaCppBackendAdapter({
      resolver: options.resolver,
      onWarning: options.onWarning,
      onWaiting: options.onWaiting,
    });
    this.router.register('llama-cpp', this.llama);

    // Browser/WebGPU on-device runtimes, registered when the platform has
    // them. Both are genuinely local, so they share the ember identity.
    if (hasPromptApi()) {
      this.router.register('chrome-ai', new ChromeAIBackendAdapter({}));
    }

    this.#bridge = new Bridge(new GenericFrontendAdapter(), this.router, {
      debug: options.debug ?? false,
      timeout: 300_000, // On-device prefill on a cold model is genuinely slow.
      autoRequestId: true,
    });

    for (const middleware of this.#middleware()) this.#bridge.use(middleware);
  }

  #middleware(): Middleware[] {
    const stack: Middleware[] = [];

    if (this.#options.debug) {
      stack.push(createLoggingMiddleware({ level: 'debug' }) as Middleware);
    }

    stack.push(
      createResilienceMiddleware({
        resolveFallback: () => this.#resolveFallback(),
        // NO `clearForFallback`, and leaving it out is the refusal. This
        // middleware returns early on streamed requests, so the only request it
        // acts on is `complete()`'s, and `complete()` must not divert (see
        // there). It still reads the device and passes a failure through untouched.
        onFallback: (event) => {
          this.#lastFallback = event;
          this.#options.onFallback?.(event);
        },
      }),
    );

    // Retries only an error its backend marked retryable (`isRetryable === true`,
    // aimatey's default predicate), and on the same backend: a retry runs the
    // rest of the stack again and never picks another backend, so it is not a
    // divert. No predicate is passed, so a local backend's error is retried too
    // when it is marked retryable; a plain Error, such as a local OOM, is not.
    // This used to say "the predicate excludes local backends". There is no
    // such predicate.
    stack.push(
      createRetryMiddleware({
        maxAttempts: 2,
        initialDelay: 400,
        maxDelay: 4_000,
        backoffMultiplier: 2,
      }) as Middleware,
    );

    stack.push(
      createToolMiddleware({
        registry: toolRegistry,
        maxIterations: TOOL_ITERATIONS,
        onToolExecuted: (tool) => this.#pendingTools.push(tool),
      }),
    );

    return stack;
  }

  /* ── Remote provider registration ───────────────────────────────── */

  async connectProvider(connection: ProviderConnection): Promise<void> {
    const descriptor = getProvider(connection.providerId);
    if (!descriptor) throw new Error(`Unknown provider "${connection.providerId}".`);

    const adapter = await descriptor.load(connectionConfig(connection));
    this.#remotes.set(connection.id, adapter);
    if (descriptor.kind === 'local-cli') {
      this.#cliConnectionIds.add(connection.id);
      // Round 6: `#resolveFallback` already refuses this id regardless, but
      // clearing the STORED value here too means `fallbackBackendId` (the
      // getter `app.ts` reads back to decide whether to correct the
      // persisted setting) stops lying the moment this connection's real
      // kind is known — not just at the one call site that reads it.
      if (this.#options.fallbackBackendId === connection.id) {
        this.#options = { ...this.#options, fallbackBackendId: null };
      }
    } else {
      this.#cliConnectionIds.delete(connection.id);
    }

    // Reconnecting an existing provider — the user rotated their API key, or
    // changed the endpoint — swaps the adapter in place. `register` would
    // throw on the duplicate name, and unregister-then-register would discard
    // the backend's latency and cost history (aimatey 0.2.0, ai.matey#49).
    if (this.router.has(connection.id)) {
      this.router.replace(connection.id, adapter);
    } else {
      this.router.register(connection.id, adapter);
    }

    const model = connection.defaultModel || descriptor.defaultModel;
    if (model) this.#fallbackModels.set(connection.id, model);
  }

  disconnectProvider(connectionId: string): void {
    this.#remotes.delete(connectionId);
    this.#fallbackModels.delete(connectionId);
    this.#cliConnectionIds.delete(connectionId);

    // Unregistering an absent backend still throws, so a double-disconnect
    // must not be able to take the settings screen down with it.
    try {
      this.router.unregister(connectionId);
    } catch {
      // Already gone.
    }

    if (this.#options.fallbackBackendId === connectionId) {
      this.#options = { ...this.#options, fallbackBackendId: null };
    }
  }

  /** Register a LiteRT-LM `.litertlm` bundle as an on-device backend. */
  registerLiteRtLm(backendId: string, modelUrl: string): void {
    this.router.register(backendId, new LiteRtLmBackendAdapter({ model: modelUrl }));
  }

  setFallbackBackend(backendId: string | null): void {
    // #42/#115: a local agent CLI is never fallback-eligible. Refusing here,
    // the one place `fallbackBackendId` is ever assigned, is what makes it
    // true regardless of what any future UI offers — see `#cliConnectionIds`.
    if (backendId !== null && this.#cliConnectionIds.has(backendId)) {
      throw new Error(
        `"${backendId}" is a local agent CLI connection and can never be the cloud-pressure fallback.`,
      );
    }
    this.#options = { ...this.#options, fallbackBackendId: backendId };
  }

  get fallbackBackendId(): string | null {
    return this.#options.fallbackBackendId ?? null;
  }

  listBackends(): readonly string[] {
    return this.router.listBackends();
  }

  hasBackend(id: string): boolean {
    return this.router.has(id);
  }

  /* ── Generation ─────────────────────────────────────────────────── */

  /**
   * Stream a completion. Yields UI-shaped events rather than IR chunks so
   * feature code never has to know the IR discriminated union.
   *
   * The middleware chain is driven here rather than by the Bridge, because
   * aimatey's `Bridge.use()` middleware is silently skipped for streamed
   * requests (johnhenry/ai.matey#46) and every turn in this app streams. That
   * is also the right shape for tools: a tool call cannot be executed
   * mid-stream, since its arguments are not complete until the turn ends.
   *
   * Order matches the non-streaming stack: device pressure, then generation,
   * then the tool loop.
   */
  async *stream(request: GenerationRequest): AsyncGenerator<GenerationEvent> {
    const requestId = newId('req');
    /*
     * THE TURN'S END, HOWEVER IT ENDS (#7, owner ruling). On the desktop a turn
     * that decoded locally holds the slot it shares with a paired phone's turns
     * from its first decode until it is over, its tool calls included, and a
     * phone's turn waits for all of it. Every decode of this turn carries this
     * one requestId; this is where the turn is over: finished, failed, stopped,
     * or ended by a consumer that stopped reading, which runs this `finally`
     * too. A turn that never decoded locally holds nothing, and the adapter
     * sends nothing for it.
     */
    try {
      yield* this.#turn(request, requestId);
    } finally {
      await this.llama.endTurn(requestId);
    }
  }

  /** The turn itself: `stream`, without its end. */
  async *#turn(request: GenerationRequest, requestId: string): AsyncGenerator<GenerationEvent> {
    this.#pendingTools = [];
    this.#lastFallback = null;
    this.#responseWarnings = [];

    const started = performance.now();
    yield { type: 'start', requestId };

    /*
     * ── The backstop, and the one failure that must NOT divert ──────────
     *
     * A target naming a backend this build never registered is a
     * configuration error, not a runtime failure. The difference matters
     * because of what the rest of this method does with a failure: there are
     * TWO places that divert a local turn to the configured cloud provider —
     * the device-pressure pre-flight just below, and the loop's failure
     * handler further down — and `target.local` is true for every on-device
     * engine, so either one will retarget the turn at the remote and answer
     * from there.
     *
     * Measured, before this check existed: selecting a speech model and
     * sending "my private note" with a fallback configured produced
     * ["start","fallback","delta","done"] — no error, a cloud answer, and the
     * message off the device — over a model the user chose precisely BECAUSE
     * it was local. The chain only "failed closed" for users who had no cloud
     * provider set up.
     *
     * It is checked HERE, before the pre-flight, and not merely before the
     * loop. Measured with the check sitting one block lower: a hot device
     * (thermal 0.95) plus an unregistered backend plus a configured fallback
     * produced that same ["start","fallback","delta","done"] and a cloud
     * answer, because the pre-flight diverted the turn before the check ever
     * ran. Nothing may retarget `target` above this line.
     *
     * Diverting cannot help here in any case: no remote provider can serve a
     * local model that has no runtime.
     *
     * Selection refuses long before this — the pickers do not offer a model
     * that cannot chat, and `resolveTarget` stops the persisted leftovers. This
     * stays because it is the only check that covers a target built by a caller
     * that never touched either: a future `text`-capable model on an engine
     * declared in ENGINE_IDS (`mlc-llm`, `cactus`, `executorch`) that nothing
     * registers would pass every capability check upstream and land here.
     */
    if (!this.router.has(request.target.backendId)) {
      yield { type: 'error', message: unregisteredBackendMessage(request.target) };
      return;
    }

    // ── Pre-flight: can this device take a local generation right now? ──
    let target = request.target;
    if (runsOnThisDevice(target)) {
      const pressure = await checkDevicePressure();
      const fallback = pressure ? this.#resolveFallback() : null;

      if (pressure && fallback) {
        const event: FallbackEvent = {
          reason: pressure.reason,
          from: target.backendId,
          to: fallback.name,
          detail: pressure.detail,
        };
        this.#lastFallback = event;
        this.#options.onFallback?.(event);
        yield { type: 'fallback', event };

        target = {
          backendId: fallback.name,
          engine: 'remote',
          modelId: fallback.modelId ?? target.modelId,
          modelName: fallback.modelId ?? fallback.name,
          reach: REACH_REMOTE,
        };
      }
    }

    /*
     * The router will not keep the turn on the backend we asked for.
     *
     * When a backend's circuit opens, `selectBackend` (router.js:494) stops
     * preferring the explicit backend -- `isBackendAvailable()` is false while
     * the circuit is open -- and falls through to "final fallback: first
     * available backend". Neither `routingStrategy: 'explicit'` nor
     * `fallbackStrategy: 'none'` stops that branch, so the promise made at the
     * Router construction above ("Fallback is a consent decision, not
     * automatic") was not being kept.
     *
     * Measured before this check existed: a turn targeted at a LOCAL model,
     * once the local circuits were open, was answered by a cloud provider --
     * `[start, delta, done]`, no fallback event, no egress prompt, nothing on
     * screen. The conversation left the device and the transcript would later
     * print `(remote)` for a turn the user had aimed at their own hardware.
     * That is #228.
     *
     * So the decision is made HERE rather than inside the router. It sits
     * before the egress gate deliberately: that gate keys on
     * `target.backendId`, so a substitution made after it would have taken
     * consent for one destination and used another.
     *
     * Only a backend the user nominated is diverted to. With none nominated,
     * the turn fails with a sentence about the model the user chose -- the
     * same one #187 wrote for the case where nothing can take the turn.
     *
     * `has()` guards the check because an unregistered backend is also
     * "unavailable", and that case has its own message further up.
     *
     * `isBackendAvailable` is `isHealthy && circuit !== open` -- the same
     * predicate selection itself uses, so this asks the router exactly the
     * question the router is about to answer. It was private when this guard
     * was written, which forced a narrower check against `isCircuitBreakerOpen`
     * and left a backend marked unhealthy WITHOUT an open circuit unobservable
     * from here. ai.matey#134 asked for it; aimatey-core 0.4.0 made it public,
     * and that gap is now closed.
     *
     * 0.4.0 also fixed the router-side half (ai.matey#135): `selectBackend`
     * now honours `fallbackStrategy: 'none'` for a named backend, so it
     * refuses rather than substituting. This check is kept regardless. It runs
     * BEFORE the egress gate, so it is what turns a refusal into a consented
     * divert with a chip, where the router alone would only produce an error.
     */
    if (this.router.has(target.backendId) && !this.router.isBackendAvailable(target.backendId)) {
      const nominated = runsOnThisDevice(target) ? this.#resolveFallback() : null;
      if (!nominated || !this.router.isBackendAvailable(nominated.name)) {
        yield { type: 'error', message: noBackendMessage(target, true) };
        return;
      }

      const event: FallbackEvent = {
        reason: 'engine-error',
        from: target.backendId,
        to: nominated.name,
        detail: 'the backend is paused after repeated failures',
      };
      this.#lastFallback = event;
      this.#options.onFallback?.(event);
      yield { type: 'fallback', event };

      target = {
        backendId: nominated.name,
        engine: 'remote',
        modelId: nominated.modelId ?? target.modelId,
        modelName: nominated.modelId ?? nominated.name,
        reach: REACH_REMOTE,
      };
    }

    // ── Generate, then run any tools, then generate again ───────────────
    let messages: IRMessage[] = [...request.messages];
    let text = '';
    /** How the round `text` holds ended, as its stream said: see `TurnResult.ended`. */
    let ended: TextEnding = 'cut';
    /**
     * The words of each round that called a tool, its calls taken out.
     *
     * `text` is reset after a tool round, so the finished reply used to be only
     * what the model wrote after its last tool ran: "Let me check your notes
     * first." streamed, a tool ran, "They mention a passphrase." followed, and
     * the stored reply was the second sentence alone.
     */
    const said: string[] = [];
    /** The tools the latest request declared, as the registry held them when it was built. */
    let offered: ChatterangTool[] = [];
    let stats: GenerationStatsSnapshot = {};
    const tools: ExecutedTool[] = [];

    // The names the app itself declared this turn, so a withheld call cannot
    // carry out a name the model invented.
    const declared = declaredToolNames(request.toolIds);

    // Egress state for this turn. `decided` caches per destination so a model
    // that immediately re-runs the same command hits the same answer instead
    // of a second sheet — a sheet that can be raised repeatedly is a sheet
    // people learn to tap through.
    //
    // A YES IS HELD WITH THE DESTINATION'S REVOCATION COUNT AS IT STOOD BEFORE
    // IT WAS DECIDED, and honoured only while that count stands. Switching a
    // connection off drops its grants, and switching it back on registers the
    // same id again, so nothing about `target` says the answer is stale:
    // without the count, the rest of the turn sent tool output there unasked,
    // and the privacy command's "Every grant is dropped when the provider it
    // named is removed or switched off" was false until the turn ended. That
    // goes for a "this turn" answer too, which fails closed. The count taken
    // BEFORE, not once the answer is known: a revocation that ran while the
    // sheet was up would otherwise be part of the count the answer is held
    // with, and never end it. A NO IS KEPT: withdrawing grants only takes
    // permission away, and asking again over a refusal is a second sheet about
    // something already refused.
    const decided = new Map<string, { readonly allowed: boolean; readonly revocations?: number }>();
    const revocationsOf = (backendId: string): number | undefined =>
      request.egress?.revocations?.(backendId);
    let toolEgress: 'granted' | 'withheld' | undefined;

    // Clamped, never trusted: `narrowToolPolicy` (state/chat.ts) already
    // clamps a persona's `maxToolRounds` to at most `TOOL_ITERATIONS` before
    // it ever reaches a request, but this is the one place a larger — or
    // malformed — number could still arrive, so it is clamped again here
    // through the same `clampToolRounds` (#23, #122). See that function's
    // own doc comment for why `typeof x === 'number'` alone was not enough.
    const effectiveMaxRounds = clampToolRounds(request.maxToolRounds);

    for (let iteration = 0; iteration <= TOOL_ITERATIONS; iteration += 1) {
      // The check sits here, between the message array and the backend,
      // because that is the only place that knows both — and because `target`
      // is reassigned inside this loop, so consent captured anywhere earlier
      // would be consent for a destination that no longer applies.
      // Cleared for THIS destination, this iteration. `target` is reassigned
      // inside the loop, so a clearance computed anywhere earlier would be a
      // clearance for a backend that no longer applies.
      let outgoing = clearForDestination(messages, {
        allowed: true,
        note: withheldNote,
        declaredToolNames: declared,
        local: keepsTaintMark(target),
      });

      if (leavesThisDevice(target) && carriesTaint(messages)) {
        const characters = taintedCharacters(messages);
        const held = decided.get(target.backendId);
        const revocations = revocationsOf(target.backendId);
        let allowed =
          held !== undefined && (!held.allowed || held.revocations === revocations) ? held.allowed : undefined;

        if (allowed === undefined) {
          if (request.egress?.isGranted(target.backendId)) {
            allowed = true;
            // A fallback has already fired this turn, so this destination was
            // chosen by a thermal event or an OOM rather than by the user.
          } else if (this.#lastFallback !== null || !request.egress?.request) {
            // Two ways to arrive here. Either there is nobody to ask — a
            // caller with no policy, which is a refusal and not a bypass — or
            // the destination was picked by a fallback: the user is already
            // waiting on a turn that is failing, and there is no honest moment
            // to interrupt them. The fallback's own promise is that the reply
            // still gets generated, and it still does; it just goes without
            // the tool output.
            allowed = false;
          } else {
            const asked = {
              backendId: target.backendId,
              modelName: target.modelName,
              tools,
              characters,
            };
            const decision = request.signal?.aborted
              ? undefined
              : await unlessStopped(request.egress.request(asked, request.signal), request.signal);
            // STOPPED WHILE ASKING, as the MCP gate is (#92, owner ruling OD7).
            // Read off the signal, not the answer: an answer given after Stop,
            // or a sheet Stop could not take down, sent the next request, the
            // tool's output in it on a yes. Nothing is sent, recorded or kept.
            if (request.signal?.aborted) break;
            // Allowed only on a yes. Anything else a policy hands back withholds.
            allowed = decision === 'turn' || decision === 'conversation';
            // An answer given while this destination's grants were being
            // withdrawn covers the request it was asked about, and nothing
            // more: it is not kept for the conversation, and — held with the
            // count from before it was asked — not for the rest of the turn.
            // Otherwise a connection switched off while its sheet was up came
            // back on holding a grant nobody gave it after that.
            if (decision === 'conversation' && revocationsOf(target.backendId) === revocations) {
              request.egress.onGranted?.(target.backendId);
            }
          }
          decided.set(target.backendId, { allowed, revocations });
        }

        if (!allowed) {
          outgoing = clearForDestination(messages, {
            allowed: false,
            note: withheldNote,
            declaredToolNames: declared,
          });
        }
        toolEgress = allowed ? 'granted' : 'withheld';
        yield {
          type: 'egress',
          backendId: target.backendId,
          withheld: !allowed,
          toolNames: [...new Set(tools.map((tool) => tool.name))],
          characters,
        };
      }

      // Taken as the request is built, beside the tool list `#toIR` declares.
      offered = declaredTools(request.toolIds);
      const irRequest = this.#toIR({ ...request, target }, outgoing, requestId, true);

      // STOPPED: no request goes to a backend, whether the turn was stopped
      // before it started, between tool rounds, or while the receipt above was
      // being read. The signal is handed to the adapter too, but whether an
      // adapter reads one already aborted before it sends is the adapter's
      // business, and a turn stopped before its first request still reached
      // the backend.
      if (request.signal?.aborted) break;

      let turn: TurnResult;
      let failure: unknown = null;

      try {
        turn = yield* this.#runTurn(irRequest, target, request.signal);
        // A backend may report failure as an error chunk rather than by
        // throwing. Both are the same event as far as diverting goes.
        if (turn.error) {
          failure = turn.errorCode
            ? Object.assign(new Error(turn.error), { code: turn.errorCode })
            : new Error(turn.error);
        }
      } catch (error) {
        turn = { text: '', stats: {}, ended: 'cut' };
        failure = error;
      }

      if (failure) {
        if (request.signal?.aborted) {
          /*
           * STOPPED MID-STREAM, with a call already complete in the text that
           * had streamed (#293). `turn.text` is whatever arrived before the
           * abort cut the turn short — that is why `failure` is set at all,
           * either as the thrown abort or as `#runTurn`'s own EMPTY_RESPONSE.
           * `findToolCalls` only reads a call whose syntax is finished: an
           * argument still being written when Stop landed fails to parse and
           * is left alone, so reading it here cannot turn an interruption
           * into a call that never happened. Every call found is dispatched
           * through the same path a finished turn's calls take, with the
           * turn's own (already aborted) signal — so `runToolCalls` records
           * each one as `stopped` and none of them run (owner ruling that
           * "not sent" covers every call that did not leave).
           *
           * Read with the names the request offered, as a finished turn's
           * calls are and as `stripToolSyntax` reads a fenced block: a fenced
           * JSON block is a call only when it names an offered tool. Read with
           * none, a stopped turn's fenced call to an offered tool was neither
           * recorded here nor kept in the words as an example — the stripper
           * took it out as a call — so the reply lost it and no record said
           * it had not gone.
           *
           * Read as STOPPED: reasoning the round had not closed when Stop
           * landed is still reasoning, and a call it drafted is not one the
           * model made. Read as a finished round, it was recorded as a call
           * not sent. The stored words, read from the reply's answer alone,
           * never held it.
           */
          // Only in a round whose request offered a tool, as a finished round
          // is read below.
          const strandedCalls =
            offered.length > 0
              ? findToolCalls({ role: 'assistant', content: turn.text }, callNames(offered), shownCalls(messages), {
                  stopped: true,
                })
              : [];
          if (strandedCalls.length > 0) {
            const batch = await runToolCalls(toolRegistry, strandedCalls, {
              enabledIds: request.toolIds ?? [],
              destinations: this.#mcpDestinations(request.mcpEgress),
              declared: offered,
              signal: request.signal,
              confirmEachCall: request.confirmEachCall,
            });
            tools.push(...batch.executed);
            for (const tool of batch.executed) yield { type: 'tool', tool, ended: 'stopped' };
          }
          break;
        }

        // A local failure can still divert: announced just below, then through
        // the egress gate at the top of the loop. This used to say "exactly as
        // the middleware would". The middleware no longer does this, because the
        // one request it acts on, `complete()`'s, can do neither.
        const fallback = runsOnThisDevice(target) ? this.#resolveFallback() : null;
        if (!fallback) {
          const retryable = noBackendRetryable(failure);
          yield {
            type: 'error',
            message:
              retryable === null
                ? failure instanceof Error
                  ? failure.message
                  : String(failure)
                : noBackendMessage(target, retryable),
          };
          return;
        }

        // THE DEAD ROUND'S WORDS STAY IN THE ANSWER, as a tool round's do, and
        // the fallback's follow them. They were dropped here, so a turn the
        // fallback finished was stored as the fallback's words alone: what the
        // person had watched the local model write was gone, while a turn
        // stopped or failed after the divert kept it. Its stream died, so it
        // ended wherever it was: `'cut'`.
        const deadWords = endedRoundWords(turn.text, {
          offered: callNames(offered),
          ran: tools.length > 0,
          ended: 'cut',
        });
        if (deadWords) said.push(deadWords);

        const { reason, detail } = classifyFailure(failure);
        const event: FallbackEvent = { reason, from: target.backendId, to: fallback.name, detail };
        this.#lastFallback = event;
        this.#options.onFallback?.(event);
        yield { type: 'fallback', event };

        target = {
          backendId: fallback.name,
          engine: 'remote',
          modelId: fallback.modelId ?? target.modelId,
          modelName: fallback.modelId ?? fallback.name,
          reach: REACH_REMOTE,
        };
        continue;
      }

      text = turn.text;
      ended = turn.ended;
      stats = { ...stats, ...turn.stats };

      // Past the turn's limit on tool rounds, a call is still read — the
      // model did write it, complete, in a turn that finished — but it is
      // never dispatched: the limit means no more tool rounds (#293). Reading
      // it is what lets `runToolCalls` below record it as `round-limit`
      // rather than let it vanish with only `stripToolSyntax` as a witness.
      const roundLimitReached = iteration >= effectiveMaxRounds;
      // Tool calls only become readable once the turn has finished.
      // `messages` is the history this round was shown, which holds every call
      // the turn's earlier rounds made: a copy of one in this app's history form
      // is the model recounting it, not calling the tool again. See `shownCalls`.
      //
      // ONLY IN A ROUND WHOSE REQUEST OFFERED A TOOL. A chat keeps an MCP tool's
      // id after its server is removed or disconnected, and its requests then
      // offer none: nothing such a round writes is a call. Read because the chat
      // still named a tool id, a reply showing Qwen's call format had its example
      // dispatched, answered "No tool named", followed by a second request, and
      // stripped from the words the person had watched arrive.
      const calls =
        offered.length > 0
          ? findToolCalls({ role: 'assistant', content: turn.text }, callNames(offered), shownCalls(messages))
          : [];

      if (calls.length === 0) break;

      // Whether any tool had ALREADY produced output when the model composed
      // these calls. If one had, the model could have read it — so the call's
      // arguments are tainted, and that is the exact route measured last
      // round: read a secret with one tool, paste it into the arguments of the
      // next, and it rides out in a block type a `tool_result` rule misses.
      const composedAfterOutput = tools.length > 0;

      const batch = await runToolCalls(toolRegistry, calls, {
        enabledIds: request.toolIds ?? [],
        destinations: this.#mcpDestinations(request.mcpEgress),
        declared: offered,
        signal: request.signal,
        roundLimitReached,
        confirmEachCall: request.confirmEachCall,
      });
      tools.push(...batch.executed);
      for (const tool of batch.executed) yield { type: 'tool', tool, ended };

      // STOPPED. What Stop held back is recorded above, and nothing more is
      // asked or sent: the model is not run again over those refusals, which
      // for a remote one would first raise the tool-output sheet after Stop.
      if (request.signal?.aborted) break;
      // PAST THE ROUND LIMIT. What it held back is recorded above; there is no
      // further round for a follow-up to run in, so the loop ends here exactly
      // as it did when `calls` was forced empty, before any of this could be
      // read.
      if (roundLimitReached) break;
      if (batch.results.length === 0) break;

      const assistantTurn: IRMessage = { role: 'assistant', content: [...calls] };
      messages = [
        ...messages,
        composedAfterOutput ? markTainted(assistantTurn) : assistantTurn,
        markTainted({ role: 'tool', content: batch.results }),
      ];

      // The round's words stay in the answer, and the next round's follow them.
      // A fenced call is stripped as one only when it names an offered tool, as
      // `findToolCalls` read it just above.
      // Its reasoning ends with it: a tag it left open would take the next
      // round's words into reasoning once the rounds are joined.
      // So does a call it ended inside — a second call cut off in its arguments,
      // or one with no closing tag — which has no end for `stripToolSyntax` to
      // match. Cut here, where the round ends: joined to the next round's words,
      // it was either cut with all of them or kept with its arguments. See
      // `cutUnfinishedCall`. Read as its stream said it ended: a round the model
      // ended keeps words that run on from inside a call's value.
      const words = endedRoundWords(text, { offered: callNames(offered), ran: true, ended });
      if (words) said.push(words);
      text = '';
    }

    const totalMs = Math.round(performance.now() - started);
    yield {
      type: 'done',
      // Every tool round's words, then the last round's, each cut where a call
      // it ended inside starts, where it ends, as its stream said it ended. The
      // last round is cut here as the others are: cut by the store once the
      // rounds were joined, an earlier round the model ended on a call's
      // opening named in prose, its words kept, would be read on to the end of
      // the reply and cut from it, every later round's words with it. A fenced
      // JSON block is a call only when it names a tool the request offered;
      // see `fencedCall`. A turn that offered no tool and ran none has nothing
      // stripped or cut.
      text: [...said, roundWords(text, { offered: callNames(offered), ran: tools.length > 0, ended })]
        .filter((part) => part !== '')
        .join('\n\n'),
      stats: {
        ...stats,
        totalMs,
        tokensPerSecond:
          stats.tokensPerSecond ??
          (stats.completionTokens
            ? Number(((stats.completionTokens / totalMs) * 1000).toFixed(2))
            : undefined),
      },
      provenance: { ...this.#provenance(target), toolEgress },
      tools,
    };
  }

  /**
   * The MCP gate for one batch of tool calls (#6).
   *
   * Built per batch, because a fallback can fire between batches. Once a turn
   * has diverted, the person is already waiting on a turn that is failing and
   * there is no honest moment to raise a sheet — the reason the tool-output
   * gate above refuses rather than asks. So the same rule: a grant this
   * conversation already holds still covers the call, and anything else is
   * refused without asking.
   *
   * Nothing is cached here. A `calls` answer covers the one batch it was
   * given over, and the next batch asks again.
   */
  #mcpDestinations(policy: ToolDestinationPolicy | undefined): ToolDestinationPolicy {
    const ask = this.#lastFallback === null ? policy?.request?.bind(policy) : undefined;
    return {
      isGranted: (destination) => policy?.isGranted(destination) === true,
      request: ask,
      onGranted: (destination) => policy?.onGranted?.(destination),
    };
  }

  /**
   * One generation turn. Yields deltas as they arrive and returns the
   * accumulated text plus whatever stats the backend reported.
   */
  async *#runTurn(
    irRequest: IRChatRequest,
    target: EngineTarget,
    signal?: AbortSignal,
  ): AsyncGenerator<GenerationEvent, TurnResult> {
    let text = '';
    let stats: GenerationStatsSnapshot = {};
    /** How the stream ended, once its `done` says: see `TurnResult.ended`. */
    let ended: TextEnding = 'cut';

    const stream = this.#bridge.chatStream(irRequest, {
      signal,
      backend: target.backendId,
    }) as AsyncGenerator<IRStreamChunk>;

    /*
     * #260: a stream that ends without a terminal chunk FAILS the turn.
     *
     * It used to be accepted silently — the loop ended, the function returned
     * `{ text, stats }`, and the engine emitted an ordinary `done`. So a
     * socket cut between the last content chunk and `done` was
     * indistinguishable from a reply that finished, which is #185.
     *
     * The repo answered this two ways before the ruling:
     * `packages/cordis-aimatey/src/chunks.ts:298` throws `EMPTY_RESPONSE` for
     * exactly this case, and this loop did not. The IR settles it — a consumer
     * that receives a stream that is not the stream that was sent "should fail
     * the turn rather than render it".
     *
     * UNIFORM DISPOSITION, TUNNEL-ONLY DETECTOR, which is deliberate and looks
     * inconsistent until you say it out loud: failing is the answer everywhere,
     * while `sequence` contiguity is only checked on streams that crossed a
     * wire. An async generator cannot drop its own yields, so enforcing
     * contiguity in-process would be paying for a check on a path where the
     * fault cannot occur.
     */
    let sawTerminal = false;

    for await (const chunk of stream) {
      switch (chunk.type) {
        case 'content':
          text += chunk.delta;
          yield { type: 'delta', text: chunk.delta };
          break;

        case 'metadata':
          stats = { ...stats, ...readStats(chunk.metadata?.custom), ...readUsage(chunk.usage) };
          // #149: a backend that sets `metadata.warnings` is telling us the
          // turn was degraded. Nothing read this before.
          this.#responseWarnings = mergeWarnings(
            this.#responseWarnings,
            warningsOf(chunk.metadata?.warnings),
          );
          break;

        case 'done': {
          // `StreamDoneChunk` carries no `metadata`, so warnings arrive only on
          // the `metadata` chunk above. Checked against ir.d.ts:1213 rather
          // than assumed -- reading a field that does not exist would have been
          // a silent no-op that looked like coverage.
          stats = { ...stats, ...readUsage(chunk.usage) };
          // #148: `chunk.message` used to be dropped here. It is the far side's
          // own accumulation, which makes it a free checksum on ours.
          const mismatch = streamIntegrityWarning(text, chunk.message);
          if (mismatch) {
            this.#responseWarnings = mergeWarnings(this.#responseWarnings, [mismatch]);
          }
          // Whether the model ended it, or its limit on tokens or a filter cut
          // it short: a text the model ended ends outside any call it wrote.
          ended = endingOf(chunk.finishReason);
          sawTerminal = true;
          break;
        }

        case 'error':
          return { text, stats, ended: 'cut', error: chunk.error.message, errorCode: chunk.error.code };

        default:
          break;
      }
    }

    if (!sawTerminal) {
      /*
       * The stream ran out with no `done` and no `error`. Per #260 that is a
       * failed turn, not a short one — and the message is written for the
       * person rather than for a log, because the store now keeps whatever
       * arrived and shows this beside it.
       */
      return {
        text,
        stats,
        ended: 'cut',
        error: 'This reply ended before it was complete — the connection stopped part-way.',
        errorCode: 'EMPTY_RESPONSE',
      };
    }

    return { text, stats, ended };
  }

  #resolveFallback(): { name: string; adapter: BackendAdapter; modelId?: string } | null {
    const id = this.#options.fallbackBackendId;
    if (!id) return null;
    const adapter = this.router.get(id);
    if (!adapter) return null;
    /*
     * #42/#115, round 6: `setFallbackBackend` refuses to ASSIGN a CLI
     * connection id, but the constructor assigns `options.fallbackBackendId`
     * unchecked (`src/state/app.ts`'s `initialize()` passes the persisted
     * setting in before `connectProvider` has even run, so at construction
     * time nothing yet knows this id names a CLI). This is the actual point
     * of use, and it checks the resolved ADAPTER's real kind directly --
     * `instanceof CliBackendAdapter` -- rather than `#cliConnectionIds.has(id)`
     * alone. The set is still maintained (`connectProvider`,
     * `disconnectProvider`) and still guards the setter, but a set is
     * bookkeeping that could fall out of sync with what is actually
     * registered; the adapter under `id` on the router right now cannot.
     * Whatever path put a `CliBackendAdapter` here -- `connectProvider`
     * today, a future caller tomorrow -- this refuses it the same way.
     */
    if (adapter instanceof CliBackendAdapter) return null;
    return { name: id, adapter, modelId: this.#fallbackModels.get(id) };
  }

  /**
   * Non-streaming completion.
   *
   * Nothing under `src/` calls it today; only tests do. This used to say it was
   * used by tools, titling, and benchmarks, none of which reach it. The caller
   * that is planned is #197's queue, which drains a turn through here with
   * nobody watching, and that is who the refusal below is for.
   *
   * It went through the taint gate only once `#toIR` started demanding a
   * `ClearedMessage[]`: before that it handed `request.messages` straight to
   * the bridge, so a caller that had assembled a history containing tool
   * output reached a remote backend without the stream path's check ever
   * running. There is no interactive moment here to raise a sheet in, so an
   * existing grant is the only thing that allows it.
   */
  async complete(request: GenerationRequest): Promise<IRChatResponse> {
    /*
     * The same backstop `stream` has, for the same sentence.
     *
     * Not for the same reason, though, and the difference is worth stating so
     * nobody later "simplifies" one into the other. In `stream` the backstop is
     * what keeps a missing runtime from being diverted to the cloud. Here
     * nothing is diverted at all (see below), so what was live was only the
     * string. Measured before this check, calling `complete` with the reported
     * target: "Requested backend 'onnx-runtime' is not registered. Registered
     * backends: llama-cpp" — aimatey's vocabulary about its own registration
     * table, reaching the user through the other public door.
     *
     * It throws rather than returning, because that is already how this method
     * fails: `bridge.chat` threw that exact error, and every caller is written
     * around a rejected promise.
     */
    if (!this.router.has(request.target.backendId)) {
      throw new Error(unregisteredBackendMessage(request.target));
    }

    /*
     * NO DIVERT ON THIS PATH, from either branch of the resilience middleware.
     *
     * The backstop's note above used to say there was no fallback here. There
     * was. This request is not streamed, so the middleware does not take its
     * early return, and on main it handed the request to the nominated fallback
     * on a hot device, and on ANY failure, remote and paired turns included.
     * Nobody was told before it went, and no gate ran for the new destination.
     * The request it forwarded had been cleared for `request.target`, so for a
     * local target tainted history reached the cloud still carrying this app's
     * taint mark. Measured in tests/complete-divert.test.ts.
     *
     * `stream()` diverts only a turn that runs here, announces the divert as an
     * event before anything is sent, and runs the egress gate again for the new
     * destination. This path has no event to announce it with and no sheet to
     * raise, and a grant in `request.egress` was given for `request.target`,
     * not for whichever backend a failure picks. So it refuses. The middleware
     * is built without `clearForFallback` (see `#middleware`): a failure
     * surfaces as the error, and on a hot device the local backend serves the
     * turn, which is what both already did with nothing nominated. Were that
     * hook supplied, the middleware still would not forward `outgoing` below,
     * which is cleared for `request.target`. It sends only what the hook
     * clears for the fallback.
     *
     * Whether an unattended caller should EVER divert, for instance under a
     * stored conversation grant for the fallback, is a ruling nobody has made
     * (#197). Until it is made, the answer here is no.
     */

    const allowed =
      !leavesThisDevice(request.target) ||
      request.egress?.isGranted(request.target.backendId) === true;
    const outgoing = clearForDestination(request.messages, {
      allowed,
      note: withheldNote,
      declaredToolNames: declaredToolNames(request.toolIds),
      local: runsOnThisDevice(request.target),
    });
    const irRequest = this.#toIR(request, outgoing, newId('req'), false);
    return (await this.#bridge.chat(irRequest, {
      signal: request.signal,
      backend: request.target.backendId,
    })) as IRChatResponse;
  }

  #provenance(target: EngineTarget): ProvenanceSnapshot {
    const fallback = this.#lastFallback;
    /*
     * Warnings from two sources, merged (#149).
     *
     * `#responseWarnings` is whatever the response's own `metadata.warnings`
     * carried -- which on the streaming path is nothing, because the
     * resilience middleware that writes them early-returns on every streamed
     * request and every chat turn streams.
     *
     * So the divert the engine performed itself is converted here, and the two
     * paths describe it identically instead of one saying it in metadata and
     * the other in an event nobody reads. `mergeWarnings` deduplicates, should
     * a response's own warnings ever describe the same divert. (This used to
     * name a non-streaming case where both do. There is none: `stream` is the
     * only caller of this, and `complete()` does not divert.)
     */
    const diverted = fallback ? fallbackWarning(fallback.reason, fallback.from) : null;
    const warnings = mergeWarnings(this.#responseWarnings, diverted ? [diverted] : []);
    return {
      backendId: fallback?.to ?? target.backendId,
      engine: fallback ? 'remote' : target.engine,
      modelId: target.modelId,
      modelName: target.modelName,
      local: fallback ? false : runsOnThisDevice(target),
      reach: fallback ? REACH_REMOTE : target.reach,
      fallbackFrom: fallback?.from,
      fallbackReason: fallback?.reason,
      // Omitted rather than empty: a chip that renders `warnings` should not
      // have to distinguish "none" from "an empty list someone built anyway".
      ...(warnings.length ? { warnings } : {}),
    };
  }

  /**
   * Build the IR request.
   *
   * Takes the messages separately, and takes them BRANDED: `ClearedMessage` is
   * produced only by `clearForDestination`, so every path that reaches a
   * backend has decided about taint for this destination. That is the same
   * enforcement shape `SafeMessage` gives the prompt templates — the unchecked
   * path does not typecheck rather than being caught by review.
   */
  #toIR(
    request: GenerationRequest,
    messages: readonly ClearedMessage[],
    requestId: string,
    stream: boolean,
  ): IRChatRequest {
    const tools = request.toolIds?.length ? toolRegistry.toIRTools(request.toolIds) : undefined;

    return {
      messages,
      tools,
      toolChoice: tools?.length ? 'auto' : undefined,
      parameters: {
        model: request.target.modelId,
        temperature: request.sampler?.temperature,
        topP: request.sampler?.topP,
        topK: request.sampler?.topK,
        maxTokens: request.sampler?.maxTokens,
        seed: request.sampler?.seed ?? undefined,
        stopSequences: request.sampler?.stopSequences
          ? [...request.sampler.stopSequences]
          : undefined,
        frequencyPenalty: request.sampler?.frequencyPenalty,
        presencePenalty: request.sampler?.presencePenalty,
      },
      metadata: {
        requestId,
        timestamp: Date.now(),
        provenance: { frontend: 'chatterang', router: 'chatterang-router' },
        custom: {
          // The router reads its backend selection from here.
          backend: request.target.backendId,
          local: runsOnThisDevice(request.target),
          engine: request.target.engine,
          // Which tools may actually RUN, as ids. `tools` above is only what
          // the model is told, and a name is not a grant; the tool middleware
          // reads this and runs nothing when it is absent.
          toolIds: request.toolIds ? [...request.toolIds] : [],
        },
      },
      stream,
      streamMode: 'delta',
    };
  }
}

/* ── Helpers ────────────────────────────────────────────────────────── */

function hasPromptApi(): boolean {
  return typeof (globalThis as { LanguageModel?: unknown }).LanguageModel !== 'undefined';
}

/**
 * The boundary where native metrics become UI state.
 *
 * Exported for tests. A metric the plugin reports but this function forgets is
 * invisible everywhere downstream, which is exactly how `draftAcceptance`
 * reached the UI layer plumbed but unread for so long.
 */
export function readStats(custom: Record<string, unknown> | undefined): GenerationStatsSnapshot {
  if (!custom) return {};
  const pick = (key: string): number | undefined =>
    typeof custom[key] === 'number' ? (custom[key] as number) : undefined;
  return {
    ttftMs: pick('ttftMs'),
    cachedTokens: pick('cachedTokens'),
    tokensPerSecond: pick('tokensPerSecond'),
    draftAcceptance: pick('draftAcceptance'),
    peakMemoryBytes: pick('peakMemoryBytes'),
    computeBackend:
      typeof custom.computeBackend === 'string' ? (custom.computeBackend as string) : undefined,
  };
}

function readUsage(
  usage: { promptTokens?: number; completionTokens?: number } | undefined,
): GenerationStatsSnapshot {
  if (!usage) return {};
  return { promptTokens: usage.promptTokens, completionTokens: usage.completionTokens };
}

/** Build an engine target from a model id and the engine that serves it. */
/**
 * The text of an assembled reply, for comparison against accumulated deltas.
 *
 * Deliberately NOT `messageText` from `src/ai/prompt.ts`. That one renders
 * non-text blocks as placeholders -- `[image]`, `[tool foo({...})]` -- because
 * it builds a prompt for a model to read. Comparing that against a stream of
 * `delta` text would report a mismatch every time a reply contained anything
 * but plain text, which is a checksum that cries wolf.
 */
export function streamedTextOf(message: IRMessage): string {
  if (typeof message.content === 'string') return message.content;
  return message.content
    .map((block) => (block.type === 'text' ? block.text : ''))
    .join('');
}

/**
 * Did the far side's own accumulation agree with ours? (#148)
 *
 * `done.message` is the only place assembled tool calls can be read, and this
 * app has always ignored it -- so a free checksum was being thrown away. In
 * one process the two cannot disagree: the same generator writes both from one
 * buffer. Over a wire they can, and the way they disagree matters:
 *
 *   - a DROPPED content frame makes delta-accumulation short
 *   - a REORDERED pair makes delta-accumulation scrambled
 *
 * and `done.message`, assembled by the far side, is right in both cases. The
 * user currently reads a scrambled reply as the MODEL failing. It is the
 * transport, and blaming the wrong component is the actual defect.
 *
 * Returns null when they agree or when there is nothing to compare -- `message`
 * is optional and most in-process turns omit it.
 */
export function streamIntegrityWarning(
  accumulated: string,
  message: IRMessage | undefined,
): TurnWarning | null {
  if (!message) return null;
  const assembled = streamedTextOf(message);
  // An empty assembled message is a far side that sent no text blocks, not a
  // far side reporting that we received nothing. Comparing against it would
  // fail every turn whose reply was entirely tool calls.
  if (assembled === '' || assembled === accumulated) return null;
  const shortfall = assembled.length - accumulated.length;
  return {
    category: 'transport-degraded',
    severity: 'warning',
    message:
      shortfall > 0
        ? `This reply arrived incomplete: ${shortfall} characters did not reach this device.`
        : 'This reply did not arrive in the order it was sent, so what is shown may be scrambled.',
    source: 'stream',
  };
}

export function targetFor(
  engine: EngineId,
  modelId: string,
  modelName: string,
  /** Router registration name. Not an EngineId — remote connections use their
   *  own generated ids. Defaults to the engine name, which is how the local
   *  engines are registered. */
  backendId: string = engine,
  /**
   * Overrides the engine-derived reach. The tunnel adapter passes
   * `reachPaired(device)` here; nothing else needs it.
   */
  reach?: Reach,
): EngineTarget {
  return {
    backendId,
    engine,
    modelId,
    modelName,
    reach: reach ?? (isLocalEngine(engine) ? REACH_DEVICE : REACH_REMOTE),
  };
}
