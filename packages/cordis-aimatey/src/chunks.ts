/**
 * aimatey `IRStreamChunk` -> DSH `StreamChunk`.
 *
 * The two protocols disagree about who owns block structure. DSH's stream is a
 * grammar — every delta must address a block that a `block-start` opened and a
 * `block-end` closes, usage may appear at most once, and the whole thing ends
 * in exactly one terminal `finish` (dsh-llm/lib/invariant.js). aimatey's IR has
 * none of that: it emits content deltas with no framing, and signals the end
 * with a `done` chunk, an `error` chunk, or — on abort — with nothing at all.
 *
 * So this module synthesizes the framing. The block table lives here, and the
 * terminal decision is made once, at a single exit, by an idempotent `settle`
 * called from the success path, the catch, and a `finally` backstop. That shape
 * is deliberate and is the same one `packages/inference-node` uses for its
 * terminal-event rule: a path that returns without a terminal leaves the
 * consumer waiting forever, and the invariant companion turns that into
 * "LLM stream ended without a terminal finish chunk".
 *
 * Throwing from here is safe and is the intended way to report a failure.
 * `LlmRuntime.adapterStream` catches whatever an adapter throws and converts it
 * into the terminal finish itself, and the invariant listener is installed
 * OUTSIDE that conversion (`ctx.waterfall('llm/stream', …)` with `prepend`), so
 * it validates the already-normalized stream. `invariant.js` also permits open
 * blocks when the finish kind is `error` or `aborted`.
 */

import { CallId, LlmError } from '@deepseek-ai/dsh-llm';
import type { FinishReason as DshFinishReason, StreamChunk } from '@deepseek-ai/dsh-llm';
import type {
  FinishReason as IRFinishReason,
  IRStreamChunk,
  IRUsage,
  IRWarning,
} from '@johnhenry/aimatey-types';

import { mapCode } from './errors.js';
import type { TranslationHooks } from './request.js';

/** One block this translator opened and still owes a `block-end`. */
type OpenBlock =
  | { readonly type: 'text'; readonly index: number; text: string }
  | { readonly type: 'tool-call'; readonly index: number; readonly id: string; name: string; args: string };

/** How the stream ended, decided exactly once. */
type Outcome =
  | { readonly kind: 'finish'; readonly reason: DshFinishReason }
  | { readonly kind: 'failure'; readonly code: string; readonly message: string }
  | { readonly kind: 'thrown'; readonly cause: unknown }
  /** The source iterator ran out without saying anything. */
  | { readonly kind: 'exhausted' };

/**
 * Map an IR finish reason onto DSH's, or onto a failure.
 *
 * `content_filter` deliberately does NOT become `{kind:'stop'}`: presenting a
 * censored response as a normal completion is precisely the quiet mislabel that
 * hides a regression.
 */
function mapFinish(reason: IRFinishReason): Outcome {
  switch (reason) {
    case 'stop':
      return { kind: 'finish', reason: { kind: 'stop' } };
    case 'tool_calls':
      return { kind: 'finish', reason: { kind: 'tool-calls' } };
    case 'length':
      return { kind: 'finish', reason: { kind: 'max-tokens' } };
    case 'content_filter':
      return {
        kind: 'failure',
        code: 'CONTENT_FILTER',
        message: 'provider stopped generation: content filter',
      };
    case 'cancelled':
      return { kind: 'failure', code: 'ABORTED', message: 'provider cancelled the request' };
    case 'error':
      return {
        kind: 'failure',
        code: 'PROVIDER_ERROR',
        message: 'provider reported a failed completion with no error payload',
      };
    default:
      return {
        kind: 'failure',
        code: 'UNKNOWN_ERROR',
        message: `provider reported an unrecognised finish reason "${String(reason)}"`,
      };
  }
}

/** Render one IR warning as a single log line. */
function formatWarning(warning: IRWarning): string {
  const parts = [`aimatey ${warning.category}/${warning.severity}: ${warning.message}`];
  if (warning.field !== undefined) parts.push(`field=${warning.field}`);
  if (warning.originalValue !== undefined) parts.push(`was=${String(warning.originalValue)}`);
  if (warning.transformedValue !== undefined) parts.push(`now=${String(warning.transformedValue)}`);
  return parts.join(' ');
}

/**
 * Translate one aimatey stream into a legal DSH chunk sequence.
 *
 * @param source - the Router's IR chunk stream.
 * @param signal - the same signal handed to `Router.executeStream`; the only
 *   evidence available that a silent end was an abort rather than an exhaustion.
 * @param hooks - where warnings and dropped detail are reported.
 * @returns the DSH chunks, ending in exactly one terminal finish — or a throw
 *   that `LlmRuntime` converts into one.
 */
export async function* translate(
  source: AsyncIterable<IRStreamChunk>,
  signal: AbortSignal | undefined,
  hooks: TranslationHooks = {},
): AsyncGenerator<StreamChunk, void, undefined> {
  /** Open blocks in the order they were opened; `block-end`s follow it. */
  const open = new Map<number, OpenBlock>();
  const toolIndexById = new Map<string, number>();
  const warned = new Set<string>();
  let nextIndex = 0;
  let openTextIndex: number | undefined;
  /**
   * The last usage seen, from either a metadata chunk or the done chunk.
   *
   * Buffered rather than forwarded on sight, for two independent reasons.
   * aimatey's dominant pattern hangs usage off the terminal `done` chunk, where
   * DSH forbids anything after a finish; and this repo's own llama-cpp backend
   * reports usage on BOTH a metadata chunk and the done chunk, which would trip
   * "LLM stream emitted usage more than once".
   */
  let lastUsage: IRUsage | undefined;

  let settled = false;
  let outcome: Outcome = { kind: 'exhausted' };
  /** Record how the stream ended. The first call wins; later ones are no-ops. */
  const settle = (next: Outcome): void => {
    if (settled) return;
    settled = true;
    outcome = next;
  };
  /**
   * Read the decision back.
   *
   * Through a function because every write happens inside `settle`, which
   * TypeScript's control-flow analysis cannot follow — read directly, `outcome`
   * would still be narrowed to its initializer at the drain point below.
   */
  const decided = (): Outcome => outcome;

  const reportWarnings = (warnings: readonly IRWarning[] | undefined): void => {
    for (const warning of warnings ?? []) {
      const line = formatWarning(warning);
      // A start chunk carries the request's warnings and a later metadata chunk
      // may repeat them; one line per distinct warning is enough.
      if (warned.has(line)) continue;
      warned.add(line);
      hooks.warn?.(line);
    }
  };

  try {
    for await (const chunk of source) {
      switch (chunk.type) {
        case 'start':
          reportWarnings(chunk.metadata.warnings);
          hooks.debug?.(
            `aimatey: stream started on backend "${chunk.metadata.provenance?.backend ?? 'unknown'}"`,
          );
          break;

        case 'content': {
          if (openTextIndex === undefined) {
            openTextIndex = nextIndex++;
            open.set(openTextIndex, { type: 'text', index: openTextIndex, text: '' });
            yield { type: 'block-start', index: openTextIndex, blockType: 'text' };
          }
          const block = open.get(openTextIndex);
          // `accumulated` is ignored on purpose: under streamMode 'delta' it is
          // absent, and under 'accumulated' forwarding it would repeat the text.
          if (block?.type === 'text') block.text += chunk.delta;
          yield { type: 'text-delta', index: openTextIndex, text: chunk.delta };
          break;
        }

        case 'tool_use': {
          // StreamToolUseChunk.index is a tool-call ordinal in its own numbering
          // space, NOT a DSH block index. The id is the correlation key.
          let index = toolIndexById.get(chunk.id);
          if (index === undefined) {
            index = nextIndex++;
            toolIndexById.set(chunk.id, index);
            open.set(index, { type: 'tool-call', index, id: chunk.id, name: chunk.name, args: '' });
            yield { type: 'block-start', index, blockType: 'tool-call' };
          }
          const block = open.get(index);
          const delta = chunk.inputDelta ?? '';
          if (block?.type === 'tool-call') {
            block.args += delta;
            // Providers that only send the name on the first frame are already
            // normalized by aimatey, but a later non-empty name is still truth.
            if (chunk.name.length > 0) block.name = chunk.name;
          }
          // Both sides stream raw partial-JSON fragments. Never parse and
          // re-serialize: that would change what the model actually emitted.
          yield { type: 'tool-call-delta', index, id: CallId(chunk.id), name: chunk.name, argumentsDelta: delta };
          break;
        }

        case 'metadata':
          if (chunk.usage !== undefined) lastUsage = mergeUsage(lastUsage, chunk.usage);
          reportWarnings(chunk.metadata?.warnings);
          if (chunk.metadata?.custom !== undefined) {
            // tokensPerSecond, ttftMs, computeBackend, cachedTokens … DSH's
            // StreamChunk union has no carrier for any of it.
            hooks.debug?.(`aimatey: backend metadata ${JSON.stringify(chunk.metadata.custom)}`);
          }
          break;

        case 'done':
          if (chunk.usage !== undefined) lastUsage = mergeUsage(lastUsage, chunk.usage);
          settle(mapFinish(chunk.finishReason));
          break;

        case 'error':
          // An IR error chunk is terminal in practice. Forwarding it as a chunk
          // is impossible — DSH has no error chunk — so it is re-thrown below
          // and LlmRuntime turns it into the terminal finish.
          settle({ kind: 'failure', code: chunk.error.code, message: chunk.error.message });
          break;

        default:
          hooks.debug?.(
            `aimatey: ignored an unrecognised IR chunk type "${(chunk as { type: string }).type}"`,
          );
          break;
      }
      if (settled) break;
    }
    settle({ kind: 'exhausted' });
  } catch (cause) {
    settle({ kind: 'thrown', cause });
  } finally {
    // Backstop. A no-op on every path above, and the reason a new early exit
    // cannot break the terminal rule by accident. When the consumer abandons
    // the generator this runs and nothing further is yielded, which is correct:
    // there is nobody left to yield to.
    settle({ kind: 'exhausted' });
  }

  // One exit. Close what is open, report usage once, then terminate exactly
  // once — by yielding a finish, or by throwing so the runtime builds one.
  for (const block of open.values()) {
    yield block.type === 'text'
      ? { type: 'block-end', index: block.index, block: { type: 'text', text: block.text } }
      : {
          type: 'block-end',
          index: block.index,
          block: { type: 'tool-call', id: CallId(block.id), name: block.name, arguments: block.args },
        };
  }
  open.clear();

  if (lastUsage !== undefined) {
    yield {
      type: 'usage',
      usage: {
        // KIND mismatch, not a rename: DSH documents `inputTokens` as UNCACHED
        // input, disjoint from cacheReadTokens/cacheWriteTokens, while
        // IRUsage.promptTokens is an inclusive prompt count. For a provider
        // that reports cache hits this therefore OVERSTATES uncached input.
        // There is no cross-provider IR key to recover the split from, so the
        // number is passed through unchanged rather than adjusted by a guess.
        inputTokens: lastUsage.promptTokens,
        outputTokens: lastUsage.completionTokens,
        // cacheReadTokens, cacheWriteTokens and reasoningTokens are left
        // undefined, not zero. undefined means "not measured"; 0 would mean
        // "measured, and it was zero" — and a plausible-looking zero is how a
        // real regression becomes invisible.
      },
    };
  }

  const terminal = decided();
  switch (terminal.kind) {
    case 'finish':
      yield { type: 'finish', reason: terminal.reason };
      return;
    case 'failure':
      throw new LlmError(terminal.message, mapCode(terminal.code));
    case 'thrown':
      throw asLlmError(terminal.cause);
    case 'exhausted':
      // aimatey's Router breaks out of its loop on abort, counts a success and
      // returns — no done chunk, no error chunk, no throw (verified in
      // aimatey-core/dist/esm/router.js). The signal is the only evidence.
      if (signal?.aborted === true) throw new LlmError('request aborted', 'ABORTED');
      // Also reachable without an abort: this repo's llama-cpp backend returns
      // early when generation produced no result, and the Router forwards that
      // clean end as a success.
      throw new LlmError('provider stream ended without a terminal chunk', 'EMPTY_RESPONSE');
  }
}

/**
 * Fold a partial usage report into what is already known.
 *
 * A metadata chunk carries `Partial<IRUsage>`; a done chunk carries the whole
 * thing. Later fields win, but a later report that omits a field does not erase
 * an earlier measurement of it.
 */
function mergeUsage(previous: IRUsage | undefined, next: Partial<IRUsage>): IRUsage {
  const promptTokens = next.promptTokens ?? previous?.promptTokens ?? 0;
  const completionTokens = next.completionTokens ?? previous?.completionTokens ?? 0;
  return {
    promptTokens,
    completionTokens,
    totalTokens: next.totalTokens ?? previous?.totalTokens ?? promptTokens + completionTokens,
  };
}

/**
 * Re-throw whatever the Router threw under a DSH code.
 *
 * Only `HarnessError`-derived codes survive `normalizeLlmFailure`; a plain
 * `Error` carrying `.code = 'RATE_LIMIT'` reaches the consumer as `UNKNOWN`.
 */
function asLlmError(cause: unknown): LlmError {
  if (cause instanceof LlmError) return cause;
  const code = readCode(cause);
  const message = cause instanceof Error && cause.message.length > 0 ? cause.message : 'aimatey stream failed';
  return new LlmError(message, code === undefined ? 'UNKNOWN' : mapCode(code), { cause });
}

/** Read an aimatey `AdapterError`'s own `code` without invoking an accessor. */
function readCode(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, 'code');
  const code = descriptor !== undefined && 'value' in descriptor ? descriptor.value : undefined;
  return typeof code === 'string' && code.length > 0 ? code : undefined;
}
