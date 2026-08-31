/**
 * The terminal-event authority.
 *
 * This is the main-process object registered as the `LlamaCpp` plugin. It runs
 * no inference; it forwards to the inference host across a message port and
 * guarantees the one property the UI cannot survive without:
 *
 *   **Every generation ends exactly once, whatever happens to the host.**
 *
 * That splits into two guarantees, and only the first is load-bearing:
 *
 *   1. THE `generate` PROMISE ALWAYS SETTLES. `ipcRenderer.invoke` has no
 *      timeout — a main handler that never returns leaves the renderer's
 *      promise pending forever, silently. So every in-flight generation is
 *      settled by exactly one of: a `ret` from the host, the host dying, or
 *      the renderer that asked going away. There is no fourth path, and no
 *      await in here that is not covered by one of the three.
 *
 *   2. EXACTLY ONE `llamaEnd`, NEVER TWO. Three independent things can end a
 *      generation — the host's own `LlamaCppNode`, a host crash, and a `ret`
 *      from a host that forgot to emit — and all three funnel through one
 *      idempotent `#settle`.
 *
 * The renderer's authority is (1), not (2). `src/ai/backends/llama-cpp.ts`
 * loops `while (!finished && !failure)`, both set by the `generate` promise;
 * nothing in `src/` consumes `llamaEnd` at all. That is also the RIGHT thing
 * to depend on across IPC: an invoke settles once by construction and cannot
 * be lost to a `removeAllListeners()` or a listener-registration race, and an
 * event can be. Building the terminal guarantee on the weaker mechanism would
 * be a choice to be fragile.
 */

import type { GenerateOptions, GenerateResult, GenerationEndEvent } from '@chatterang/contracts';

import type {
  DshStatus,
  HostMessage,
  LlamaEventName,
  MessageLink,
  WireError,
} from './protocol.js';
import { HANDLE_LOST, fromWireError } from './protocol.js';

/** How the supervisor reaches the renderer. Supplied by `PluginHost`. */
export type NotifyListeners = (eventName: LlamaEventName, data: unknown) => void;

export interface SupervisorOptions {
  /** The link to the inference host. */
  readonly link: MessageLink;
  /** Emit one plugin event to every subscribed renderer. */
  readonly notify: NotifyListeners;
  /** The inference host's DSH boot report, when it arrives. */
  readonly onBoot?: (status: DshStatus) => void;
  /** Where anomalies go. Never a payload — see the logging rule in main.ts. */
  readonly warn?: (message: string) => void;
}

interface PendingCall {
  readonly method: string;
  resolve(value: unknown): void;
  reject(error: Error): void;
}

interface InflightGeneration {
  readonly callId: number;
  /** True once this turn's single `llamaEnd` has been emitted. */
  ended: boolean;
}

function codedError(message: string, code: string): Error {
  const error = new Error(message);
  Object.assign(error, { code });
  return error;
}

/** A zeroed result, for the ends the host never got to report itself. */
function synthesiseEnd(requestId: string, error: string): GenerationEndEvent {
  return {
    requestId,
    text: '',
    promptTokens: 0,
    cachedTokens: 0,
    completionTokens: 0,
    ttftMs: 0,
    totalMs: 0,
    tokensPerSecond: 0,
    stopReason: 'error',
    error,
  };
}

export class Supervisor {
  readonly #link: MessageLink;
  readonly #notify: NotifyListeners;
  readonly #onBoot: ((status: DshStatus) => void) | undefined;
  readonly #warn: (message: string) => void;

  readonly #calls = new Map<number, PendingCall>();
  readonly #inflight = new Map<string, InflightGeneration>();
  #nextCallId = 1;
  #closed: string | null = null;
  #boot: DshStatus | null = null;

  constructor(options: SupervisorOptions) {
    this.#link = options.link;
    this.#notify = options.notify;
    this.#onBoot = options.onBoot;
    this.#warn = options.warn ?? ((): void => undefined);

    this.#link.onMessage((message) => this.#receive(message as HostMessage));
    this.#link.onClose((reason) => this.#onClose(reason));
  }

  /** The inference host's DSH boot report, or null before it has arrived. */
  get bootStatus(): DshStatus | null {
    return this.#boot;
  }

  /** In-flight generations. Exists so a test can assert the map drains. */
  get inflightCount(): number {
    return this.#inflight.size;
  }

  /* ── The declared LlamaCpp surface ─────────────────────────────────── */

  getCapabilities = (): Promise<unknown> => this.#call('getCapabilities', []);
  getThermalState = (): Promise<unknown> => this.#call('getThermalState', []);
  load = (options: unknown): Promise<unknown> => this.#call('load', [options]);
  unload = (options: unknown): Promise<unknown> => this.#call('unload', [options]);
  listLoaded = (): Promise<unknown> => this.#call('listLoaded', []);
  tokenize = (options: unknown): Promise<unknown> => this.#call('tokenize', [options]);
  countTokens = (options: unknown): Promise<unknown> => this.#call('countTokens', [options]);
  benchmark = (options: unknown): Promise<unknown> => this.#call('benchmark', [options]);

  /**
   * Cancel, which is the whole cancellation story.
   *
   * An `AbortSignal` never crosses either boundary — it is an `EventTarget`,
   * so structured clone refuses it outright, and `clone.ts` refuses it earlier
   * with a better message. It does not need to: the contract already keys
   * cancellation by `requestId`, and `src/ai/backends/llama-cpp.ts` already
   * converts the signal at the renderer edge. Across IPC that simply becomes a
   * second, independent invoke.
   *
   * Cancelling a request that is not running is a no-op, per the contract —
   * including when the host has already died, in which case the crash path has
   * settled the turn and there is nothing left to cancel.
   */
  cancel = async (options: unknown): Promise<void> => {
    if (this.#closed !== null) return;
    await this.#call('cancel', [options]);
  };

  /**
   * Generate.
   *
   * The in-flight record is created BEFORE the call is posted, so a host that
   * dies between the two still has its turn settled by `#onClose`.
   */
  generate = (options: unknown): Promise<GenerateResult> => {
    const requestId = (options as GenerateOptions | undefined)?.requestId;
    if (typeof requestId !== 'string' || requestId.length === 0) {
      return Promise.reject(new Error('desktop bridge: generate requires a requestId.'));
    }
    if (this.#closed !== null) {
      return Promise.reject(codedError(this.#closed, HANDLE_LOST));
    }

    const callId = this.#nextCallId;
    this.#inflight.set(requestId, { callId, ended: false });
    return this.#call('generate', [options]).then(
      (result) => {
        // A host that returned without emitting its own terminal event. Should
        // not happen — `LlamaCppNode` has a `finally` backstop — but a future
        // early return in that file must not be able to hang the UI.
        this.#settle(requestId, result as GenerationEndEvent);
        this.#inflight.delete(requestId);
        return result as GenerateResult;
      },
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        this.#settle(requestId, synthesiseEnd(requestId, message));
        this.#inflight.delete(requestId);
        throw error;
      },
    );
  };

  /* ── Lifecycle ─────────────────────────────────────────────────────── */

  /**
   * The renderer that owns these generations is gone — reloaded, navigated, or
   * closed.
   *
   * Three things happen, and the third is the subtle one: the turns are marked
   * ended WITHOUT emitting, because the page that would have received the
   * event no longer exists and a synthesised `llamaEnd` broadcast to whatever
   * page loaded next would be a turn it never started.
   *
   * SCOPE. This cancels EVERY in-flight generation, not only the ones the
   * departing renderer owned, because `PluginHost` does not pass the invoking
   * sender down to a plugin implementation. That is correct for A5, which
   * ships one window, and wrong the day a second one opens. The missing piece
   * is a sender id on the invoke path; it is named here rather than left for
   * someone to discover.
   */
  releaseRenderer(reason: string): void {
    for (const [requestId, entry] of this.#inflight) {
      entry.ended = true;
      this.#post({ k: 'call', id: this.#nextCallId++, method: 'cancel', args: [{ requestId }] });
      const pending = this.#calls.get(entry.callId);
      this.#calls.delete(entry.callId);
      this.#inflight.delete(requestId);
      pending?.reject(codedError(reason, 'RENDERER_GONE'));
    }
  }

  /* ── Internals ─────────────────────────────────────────────────────── */

  #call(method: string, args: readonly unknown[]): Promise<unknown> {
    if (this.#closed !== null) return Promise.reject(codedError(this.#closed, HANDLE_LOST));
    const id = this.#nextCallId++;
    return new Promise<unknown>((resolve, reject) => {
      this.#calls.set(id, { method, resolve, reject });
      this.#post({ k: 'call', id, method, args });
    });
  }

  #post(message: HostMessage): void {
    this.#link.postMessage(message);
  }

  #receive(message: HostMessage): void {
    switch (message.k) {
      case 'ret': {
        const pending = this.#calls.get(message.id);
        if (pending === undefined) {
          this.#warn(`inference host answered call ${message.id}, which is not in flight.`);
          return;
        }
        this.#calls.delete(message.id);
        if (message.ok) pending.resolve(message.data);
        else pending.reject(fromWireError(message.error as WireError));
        return;
      }
      case 'ev': {
        if (message.name === 'llamaEnd') {
          const end = message.data as GenerationEndEvent;
          this.#settle(end.requestId, end);
          return;
        }
        this.#notify(message.name, message.data);
        return;
      }
      case 'boot': {
        this.#boot = message.status;
        this.#onBoot?.(message.status);
        return;
      }
      default:
        this.#warn(`inference host sent an envelope this build does not understand.`);
    }
  }

  /**
   * The single door every terminal event goes through.
   *
   * The main-process mirror of `LlamaCppNode`'s own `settled` flag — the same
   * discipline, applied at the boundary that flag cannot see across. A double
   * `llamaEnd` is not a hang; it is a conversation turn counted twice, which
   * is data corruption and harder to notice.
   */
  #settle(requestId: string, end: GenerationEndEvent): void {
    const entry = this.#inflight.get(requestId);
    if (entry === undefined) {
      this.#warn(`inference host ended a generation that is not in flight.`);
      return;
    }
    if (entry.ended) return;
    entry.ended = true;
    this.#notify('llamaEnd', end);
  }

  #onClose(reason: string): void {
    if (this.#closed !== null) return;
    const message = `The inference process stopped unexpectedly (${reason}).`;
    this.#closed = message;

    // Terminal events first, so a listener sees the turn end before the
    // promise it is racing rejects.
    for (const [requestId, entry] of this.#inflight) {
      if (!entry.ended) {
        entry.ended = true;
        this.#notify('llamaEnd', synthesiseEnd(requestId, message));
      }
    }
    this.#inflight.clear();

    for (const [, pending] of this.#calls) pending.reject(codedError(message, HANDLE_LOST));
    this.#calls.clear();
  }
}
