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
import type {
  BackendAdapter,
  IRChatRequest,
  IRChatResponse,
  IRMessage,
  IRStreamChunk,
  Middleware,
} from '@johnhenry/aimatey-types';

import { LlamaCppBackendAdapter, type LlamaModelResolver } from '@/ai/backends/llama-cpp';
import {
  createToolMiddleware,
  findToolCalls,
  runToolCalls,
  stripToolSyntax,
  type ExecutedTool,
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
import { toolRegistry } from '@/ai/tools/registry';
import { connectionConfig, getProvider, type ProviderConnection } from '@/ai/providers';
import type { EngineId } from '@/domain/manifest';
import { isLocalEngine } from '@/domain/manifest';
import { newId } from '@/domain/chat';

/** Execute → tools → execute round trips permitted per turn. */
const TOOL_ITERATIONS = 4;

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
  /** Ask. Absent means there is nobody to ask, which is a refusal. */
  request?(request: ToolEgressRequest): Promise<ToolEgressDecision>;
  /** Persist a `conversation` decision. */
  onGranted?(backendId: string): void;
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

interface TurnResult {
  text: string;
  stats: GenerationStatsSnapshot;
  error?: string;
}

/* ── Public surface ─────────────────────────────────────────────────── */

export interface EngineTarget {
  /** Backend id registered on the router. */
  readonly backendId: string;
  readonly engine: EngineId;
  /** Model id passed to the backend. */
  readonly modelId: string;
  readonly modelName: string;
  readonly local: boolean;
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
  readonly signal?: AbortSignal;
}

export type GenerationEvent =
  | { readonly type: 'start'; readonly requestId: string }
  | { readonly type: 'delta'; readonly text: string }
  | { readonly type: 'tool'; readonly tool: ExecutedTool }
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
  fallbackFrom?: string;
  fallbackReason?: FallbackReason;
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
  #pendingTools: ExecutedTool[] = [];
  #lastFallback: FallbackEvent | null = null;

  constructor(options: EngineOptions) {
    this.#options = options;

    this.router = new Router({
      routingStrategy: 'explicit',
      fallbackStrategy: 'none', // Fallback is a consent decision, not automatic.
      trackLatency: true,
      enableCircuitBreaker: true,
      circuitBreakerThreshold: 3,
      circuitBreakerTimeout: 30_000,
    });

    this.llama = new LlamaCppBackendAdapter({
      resolver: options.resolver,
      onWarning: options.onWarning,
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
        onFallback: (event) => {
          this.#lastFallback = event;
          this.#options.onFallback?.(event);
        },
      }),
    );

    // Retries only help transient remote failures; a local OOM will not fix
    // itself on a second attempt, so the predicate excludes local backends.
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
    this.#pendingTools = [];
    this.#lastFallback = null;

    const started = performance.now();
    yield { type: 'start', requestId };

    // ── Pre-flight: can this device take a local generation right now? ──
    let target = request.target;
    if (target.local) {
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
          local: false,
        };
      }
    }

    // ── Generate, then run any tools, then generate again ───────────────
    let messages: IRMessage[] = [...request.messages];
    let text = '';
    let stats: GenerationStatsSnapshot = {};
    const tools: ExecutedTool[] = [];

    // The names the app itself declared this turn, so a withheld call cannot
    // carry out a name the model invented.
    const declared = declaredToolNames(request.toolIds);

    // Egress state for this turn. `decided` caches per destination so a model
    // that immediately re-runs the same command hits the same answer instead
    // of a second sheet — a sheet that can be raised repeatedly is a sheet
    // people learn to tap through.
    const decided = new Map<string, boolean>();
    let toolEgress: 'granted' | 'withheld' | undefined;

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
        local: target.local,
      });

      if (!target.local && carriesTaint(messages)) {
        const characters = taintedCharacters(messages);
        let allowed = decided.get(target.backendId);

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
            const decision = await request.egress.request({
              backendId: target.backendId,
              modelName: target.modelName,
              tools,
              characters,
            });
            allowed = decision !== 'deny';
            if (decision === 'conversation') request.egress.onGranted?.(target.backendId);
          }
          decided.set(target.backendId, allowed);
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

      const irRequest = this.#toIR({ ...request, target }, outgoing, requestId, true);

      let turn: TurnResult;
      let failure: unknown = null;

      try {
        turn = yield* this.#runTurn(irRequest, target, request.signal);
        // A backend may report failure as an error chunk rather than by
        // throwing. Both are the same event as far as diverting goes.
        if (turn.error) failure = new Error(turn.error);
      } catch (error) {
        turn = { text: '', stats: {} };
        failure = error;
      }

      if (failure) {
        if (request.signal?.aborted) break;

        // A local failure can still divert, exactly as the middleware would.
        const fallback = target.local ? this.#resolveFallback() : null;
        if (!fallback) {
          yield {
            type: 'error',
            message: failure instanceof Error ? failure.message : String(failure),
          };
          return;
        }

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
          local: false,
        };
        continue;
      }

      text = turn.text;
      stats = { ...stats, ...turn.stats };

      // Tool calls only become readable once the turn has finished.
      const calls =
        request.toolIds?.length && iteration < TOOL_ITERATIONS
          ? findToolCalls({ role: 'assistant', content: turn.text })
          : [];

      if (calls.length === 0) break;

      // Whether any tool had ALREADY produced output when the model composed
      // these calls. If one had, the model could have read it — so the call's
      // arguments are tainted, and that is the exact route measured last
      // round: read a secret with one tool, paste it into the arguments of the
      // next, and it rides out in a block type a `tool_result` rule misses.
      const composedAfterOutput = tools.length > 0;

      const batch = await runToolCalls(toolRegistry, calls, { signal: request.signal });
      tools.push(...batch.executed);
      for (const tool of batch.executed) yield { type: 'tool', tool };

      if (batch.results.length === 0) break;

      const assistantTurn: IRMessage = { role: 'assistant', content: [...calls] };
      messages = [
        ...messages,
        composedAfterOutput ? markTainted(assistantTurn) : assistantTurn,
        markTainted({ role: 'tool', content: batch.results }),
      ];

      // The visible answer is whatever the model says after the tools ran.
      text = '';
    }

    const totalMs = Math.round(performance.now() - started);
    yield {
      type: 'done',
      text: stripToolSyntax(text),
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

    const stream = this.#bridge.chatStream(irRequest, {
      signal,
      backend: target.backendId,
    }) as AsyncGenerator<IRStreamChunk>;

    for await (const chunk of stream) {
      switch (chunk.type) {
        case 'content':
          text += chunk.delta;
          yield { type: 'delta', text: chunk.delta };
          break;

        case 'metadata':
          stats = { ...stats, ...readStats(chunk.metadata?.custom), ...readUsage(chunk.usage) };
          break;

        case 'done':
          stats = { ...stats, ...readUsage(chunk.usage) };
          break;

        case 'error':
          return { text, stats, error: chunk.error.message };

        default:
          break;
      }
    }

    return { text, stats };
  }

  #resolveFallback(): { name: string; adapter: BackendAdapter; modelId?: string } | null {
    const id = this.#options.fallbackBackendId;
    if (!id) return null;
    const adapter = this.router.get(id);
    if (!adapter) return null;
    return { name: id, adapter, modelId: this.#fallbackModels.get(id) };
  }

  /**
   * Non-streaming completion, used by tools, titling, and benchmarks.
   *
   * It went through the taint gate only once `#toIR` started demanding a
   * `ClearedMessage[]`: before that it handed `request.messages` straight to
   * the bridge, so a caller that had assembled a history containing tool
   * output reached a remote backend without the stream path's check ever
   * running. There is no interactive moment here to raise a sheet in, so an
   * existing grant is the only thing that allows it.
   */
  async complete(request: GenerationRequest): Promise<IRChatResponse> {
    const allowed =
      request.target.local || request.egress?.isGranted(request.target.backendId) === true;
    const outgoing = clearForDestination(request.messages, {
      allowed,
      note: withheldNote,
      declaredToolNames: declaredToolNames(request.toolIds),
      local: request.target.local,
    });
    const irRequest = this.#toIR(request, outgoing, newId('req'), false);
    return (await this.#bridge.chat(irRequest, {
      signal: request.signal,
      backend: request.target.backendId,
    })) as IRChatResponse;
  }

  #provenance(target: EngineTarget): ProvenanceSnapshot {
    const fallback = this.#lastFallback;
    return {
      backendId: fallback?.to ?? target.backendId,
      engine: fallback ? 'remote' : target.engine,
      modelId: target.modelId,
      modelName: target.modelName,
      local: fallback ? false : target.local,
      fallbackFrom: fallback?.from,
      fallbackReason: fallback?.reason,
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
          local: request.target.local,
          engine: request.target.engine,
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
export function targetFor(
  engine: EngineId,
  modelId: string,
  modelName: string,
  /** Router registration name. Not an EngineId — remote connections use their
   *  own generated ids. Defaults to the engine name, which is how the local
   *  engines are registered. */
  backendId: string = engine,
): EngineTarget {
  return { backendId, engine, modelId, modelName, local: isLocalEngine(engine) };
}
