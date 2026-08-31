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
 *      settled by exactly one of: a `ret` from the host, the host dying, the
 *      renderer that asked going away, or its own DEADLINE expiring. There is
 *      no fifth path, and no await in here that is not covered by one of the
 *      four.
 *
 *      The deadline is the one that took a defect to add, and it is the one
 *      that covers the failure the other three cannot see: a host that is
 *      alive but WEDGED. A spinning decode or a hung Metal call emits no
 *      `exit`, so the link never closes, the host never answers, and the
 *      renderer waits forever on an invoke that has no timeout. `#tick` is
 *      what makes that state terminate.
 *
 *   2. EXACTLY ONE `llamaEnd`, NEVER TWO. Four independent things can end a
 *      generation — the host's own `LlamaCppNode`, a host crash, a `ret` from
 *      a host that forgot to emit, and a deadline — and all four funnel
 *      through one idempotent `#settle`.
 *
 * AND THE HOST COMES BACK. A supervisor whose host dies once and is never
 * replaced turns one crash into a permanently broken app: `#closed` latches,
 * every later call short-circuits on it, and only relaunching helps. So the
 * supervisor owns the host's LIFECYCLE, not just one instance of it — it
 * spawns, it detects loss (by `exit` OR by an unanswered ping), it terminates
 * whatever is left, and it spawns again, up to a crash-loop cap. `HANDLE_LOST`
 * only means something because there is a live host to reload into.
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
  HostHandle,
  HostMessage,
  LlamaEventName,
  WireError,
} from './protocol.js';
import { HANDLE_LOST, HOST_TIMEOUT, fromWireError } from './protocol.js';

/** How the supervisor reaches the renderer. Supplied by `PluginHost`. */
export type NotifyListeners = (eventName: LlamaEventName, data: unknown) => void;

/**
 * The clock and the timers, injected.
 *
 * Not a convenience for the tests: a watchdog verified against the real clock
 * is a watchdog whose tests either take two minutes or assert a shortened
 * deadline that is not the shipped one. With this, a test can hold the wall
 * clock still, move it by an exact number of milliseconds, and assert what
 * fired — including that a deadline fires EXACTLY ONE terminal event.
 */
export interface SupervisorTimers {
  now(): number;
  /** Start a repeating tick; returns its canceller. */
  every(ms: number, fn: () => void): () => void;
  /** Run once after `ms`; returns its canceller. */
  after(ms: number, fn: () => void): () => void;
}

/** Every duration the supervisor's liveness behaviour depends on. */
export interface SupervisorPolicy {
  /** Deadline for a call that is not a generation. */
  readonly callTimeoutMs: number;
  /**
   * A generation's INACTIVITY deadline, reset by every token it produces.
   *
   * A fixed deadline would be wrong: a long answer is not a wedged host, and
   * capping total generation time would cut off exactly the workloads this app
   * exists for. What is never legitimate is a generation that produces nothing
   * for minutes, which is what a wedged decode looks like from here.
   */
  readonly generateIdleTimeoutMs: number;
  /** How often deadlines and the ping are looked at. */
  readonly tickMs: number;
  /** Gap between liveness pings. */
  readonly pingIntervalMs: number;
  /** How long an unanswered ping may stand before the host is declared lost. */
  readonly pingTimeoutMs: number;
  /** Pause before a replacement host is spawned. */
  readonly restartDelayMs: number;
  /** More than this many restarts inside `restartWindowMs` stops the loop. */
  readonly maxRestarts: number;
  readonly restartWindowMs: number;
}

export const DEFAULT_POLICY: SupervisorPolicy = Object.freeze({
  callTimeoutMs: 120_000,
  generateIdleTimeoutMs: 120_000,
  tickMs: 1_000,
  pingIntervalMs: 15_000,
  pingTimeoutMs: 10_000,
  restartDelayMs: 500,
  maxRestarts: 5,
  restartWindowMs: 60_000,
});

export interface SupervisorOptions {
  /**
   * Start one inference host.
   *
   * A FACTORY, not a link: the supervisor calls this again every time the host
   * it is talking to goes away. Supplying a single link would be supplying a
   * single life.
   */
  readonly spawn: () => HostHandle;
  /** Emit one plugin event to every subscribed renderer. */
  readonly notify: NotifyListeners;
  /** The inference host's DSH boot report, each time one arrives. */
  readonly onBoot?: (status: DshStatus) => void;
  /** Where anomalies go. Never a payload — see the logging rule in main.ts. */
  readonly warn?: (message: string) => void;
  readonly policy?: Partial<SupervisorPolicy>;
  readonly timers?: SupervisorTimers;
}

interface PendingCall {
  readonly method: string;
  /** Set only for a generation, so a timed-out one can be cancelled in the host. */
  readonly requestId?: string;
  /** When this call stops being worth waiting for. */
  deadlineAt: number;
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

/** Real timers, with the handles unref'd so a watchdog cannot hold a process open. */
export function systemTimers(): SupervisorTimers {
  const release = (handle: unknown): void => {
    (handle as { unref?: () => void }).unref?.();
  };
  return {
    now: () => Date.now(),
    every: (ms, fn) => {
      const handle = setInterval(fn, ms);
      release(handle);
      return () => clearInterval(handle);
    },
    after: (ms, fn) => {
      const handle = setTimeout(fn, ms);
      release(handle);
      return () => clearTimeout(handle);
    },
  };
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
  readonly #spawn: () => HostHandle;
  readonly #notify: NotifyListeners;
  readonly #onBoot: ((status: DshStatus) => void) | undefined;
  readonly #warn: (message: string) => void;
  readonly #policy: SupervisorPolicy;
  readonly #timers: SupervisorTimers;

  readonly #calls = new Map<number, PendingCall>();
  readonly #inflight = new Map<string, InflightGeneration>();
  #nextCallId = 1;
  #nextPingId = 1;
  #closed: string | null = null;
  #boot: DshStatus | null = null;

  /** The host we are talking to now, or null between one dying and the next. */
  #handle: HostHandle | null = null;
  /**
   * Which host generation a listener belongs to.
   *
   * `MessageLink` has no unsubscribe, so a retired link's listeners still point
   * at this object. Without an epoch, a late message from a host we have given
   * up on could settle a call belonging to its replacement — the call ids are
   * drawn from one counter, but a host that restarts starts answering from its
   * own. Stale generations are dropped.
   */
  #generation = 0;
  #restarts: number[] = [];
  #cancelTick: (() => void) | null = null;
  #cancelRestart: (() => void) | null = null;
  #pingId: number | null = null;
  #pingSentAt: number | null = null;
  #lastPingAt = 0;
  #disposed = false;
  /** Spawns performed. Exists so a test can prove a host was actually replaced. */
  #spawnCount = 0;

  constructor(options: SupervisorOptions) {
    this.#spawn = options.spawn;
    this.#notify = options.notify;
    this.#onBoot = options.onBoot;
    this.#warn = options.warn ?? ((): void => undefined);
    this.#policy = { ...DEFAULT_POLICY, ...options.policy };
    this.#timers = options.timers ?? systemTimers();

    this.#attach();
  }

  /** The inference host's DSH boot report, or null before it has arrived. */
  get bootStatus(): DshStatus | null {
    return this.#boot;
  }

  /** In-flight generations. Exists so a test can assert the map drains. */
  get inflightCount(): number {
    return this.#inflight.size;
  }

  /** How many hosts have been spawned. 1 until the first one is replaced. */
  get spawnCount(): number {
    return this.#spawnCount;
  }

  /**
   * What `DshHost.getStatus()` answers, about the host that is running NOW.
   *
   * Main used to hold the first `boot` report in a variable and serve it
   * forever. After a respawn that variable describes a process that no longer
   * exists — the worst kind of stale, because "mounted: true" is exactly what
   * a caller checks before deciding the inference stack is usable.
   */
  hostStatus(): DshStatus {
    if (this.#boot !== null) return this.#boot;
    if (this.#closed !== null) {
      return {
        mounted: false,
        services: [],
        routes: [],
        treeAssertion: 'not reported: no inference host is running',
        error: this.#closed,
      };
    }
    return {
      mounted: false,
      services: [],
      routes: [],
      treeAssertion: 'not reported: the inference host has not finished booting',
    };
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
    if (this.#handle === null) return;
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
    return this.#call('generate', [options], {
      timeoutMs: this.#policy.generateIdleTimeoutMs,
      requestId,
    }).then(
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

  /**
   * Stop supervising: no more ticks, no more restarts, and the current host
   * terminated. Called when the app is quitting.
   */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#cancelRestart?.();
    this.#cancelRestart = null;
    this.#cancelTick?.();
    this.#cancelTick = null;
    this.#onClose('the app is shutting down');
  }

  /* ── Internals ─────────────────────────────────────────────────────── */

  /**
   * Spawn a host and start talking to it.
   *
   * Everything the previous host left behind has already been cleared by
   * `#onClose` — this only has to make the supervisor usable again, which
   * means clearing `#closed`. That latch is what a dead host leaves behind,
   * and leaving it set was the whole of defect [2].
   */
  #attach(): void {
    if (this.#disposed) return;
    const epoch = ++this.#generation;
    let handle: HostHandle;
    try {
      handle = this.#spawn();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.#warn(`could not start the inference host: ${message}`);
      this.#closed = `The inference process could not be started (${message}).`;
      this.#scheduleRestart();
      return;
    }
    this.#spawnCount += 1;
    this.#handle = handle;
    this.#closed = null;
    this.#boot = null;
    this.#pingId = null;
    this.#pingSentAt = null;
    this.#lastPingAt = this.#timers.now();

    handle.link.onMessage((message) => {
      if (epoch !== this.#generation) return;
      this.#receive(message as HostMessage);
    });
    handle.link.onClose((reason) => {
      if (epoch !== this.#generation) return;
      this.#onClose(reason);
    });

    this.#cancelTick ??= this.#timers.every(this.#policy.tickMs, () => this.#tick());
  }

  #call(
    method: string,
    args: readonly unknown[],
    options?: { timeoutMs?: number; requestId?: string },
  ): Promise<unknown> {
    if (this.#closed !== null) return Promise.reject(codedError(this.#closed, HANDLE_LOST));
    const id = this.#nextCallId++;
    const deadlineAt = this.#timers.now() + (options?.timeoutMs ?? this.#policy.callTimeoutMs);
    return new Promise<unknown>((resolve, reject) => {
      const pending: PendingCall = { method, deadlineAt, resolve, reject };
      this.#calls.set(id, options?.requestId === undefined ? pending : { ...pending, requestId: options.requestId });
      this.#post({ k: 'call', id, method, args });
    });
  }

  #post(message: HostMessage): void {
    const handle = this.#handle;
    if (handle === null) return;
    try {
      handle.link.postMessage(message);
    } catch (error) {
      // A port that throws on post is telling us the far side is gone. Treat
      // it as the loss it is rather than letting it escape into a caller that
      // has no idea what a closed port is.
      const detail = error instanceof Error ? error.message : String(error);
      this.#onClose(`the link refused a message (${detail})`);
    }
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
        if (message.name === 'llamaToken') this.#extendDeadline(message.data);
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
      case 'pong': {
        if (this.#pingId !== message.id) return;
        this.#pingId = null;
        this.#pingSentAt = null;
        this.#lastPingAt = this.#timers.now();
        return;
      }
      default:
        this.#warn(`inference host sent an envelope this build does not understand.`);
    }
  }

  /**
   * A token is proof of progress, so it buys its generation more time.
   *
   * Without this, `generateIdleTimeoutMs` would be a cap on TOTAL generation
   * time and would cut long answers off mid-sentence — a timeout that breaks
   * working generations is worse than no timeout at all, because it is the
   * kind of thing people work around by raising it until it is useless.
   */
  #extendDeadline(data: unknown): void {
    const requestId = (data as { requestId?: unknown } | null)?.requestId;
    if (typeof requestId !== 'string') return;
    const entry = this.#inflight.get(requestId);
    if (entry === undefined) return;
    const pending = this.#calls.get(entry.callId);
    if (pending === undefined) return;
    pending.deadlineAt = this.#timers.now() + this.#policy.generateIdleTimeoutMs;
  }

  /**
   * The watchdog. Two jobs, and they answer different questions.
   *
   * DEADLINES answer "is this call ever coming back?" — settling it if not.
   * The PING answers "is this host worth sending the next one to?" — replacing
   * it if not. A wedged host needs both: without the deadline the current turn
   * hangs forever, and without the ping every turn after it does too.
   */
  #tick(): void {
    const now = this.#timers.now();

    for (const [id, pending] of [...this.#calls]) {
      if (pending.deadlineAt > now) continue;
      this.#calls.delete(id);
      // Whatever the host is doing for this call, we are no longer waiting for
      // it — so ask it to stop before the caller is told. A wedged host will
      // not hear this; a merely slow one will, and an abandoned generation
      // left decoding burns the GPU for nobody.
      if (pending.requestId !== undefined) {
        this.#post({
          k: 'call',
          id: this.#nextCallId++,
          method: 'cancel',
          args: [{ requestId: pending.requestId }],
        });
      }
      pending.reject(
        codedError(
          `The inference host stopped answering (${pending.method} produced nothing for too long).`,
          HOST_TIMEOUT,
        ),
      );
    }

    this.#pingTick(now);
  }

  #pingTick(now: number): void {
    if (this.#closed !== null || this.#handle === null) return;

    if (this.#pingSentAt !== null) {
      if (now - this.#pingSentAt < this.#policy.pingTimeoutMs) return;
      this.#onClose(
        `no answer to a liveness ping in ${String(now - this.#pingSentAt)}ms; the process may be wedged`,
      );
      return;
    }

    if (now - this.#lastPingAt < this.#policy.pingIntervalMs) return;
    this.#pingId = this.#nextPingId++;
    this.#pingSentAt = now;
    this.#post({ k: 'ping', id: this.#pingId });
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

  /**
   * The host is gone — by its own `exit`, or because it stopped answering.
   *
   * Settles everything it was carrying, terminates whatever is left of the
   * process, and schedules a replacement. `#closed` is set for the gap between
   * the two so a call made in that window fails fast with `HANDLE_LOST` rather
   * than being posted into nothing.
   */
  #onClose(reason: string): void {
    if (this.#closed !== null) return;
    const message = `The inference process stopped unexpectedly (${reason}).`;
    this.#closed = message;
    this.#boot = null;
    this.#pingId = null;
    this.#pingSentAt = null;

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

    this.#retire();
    this.#scheduleRestart();
  }

  /**
   * Terminate the host we are done with.
   *
   * Called on EVERY loss, including one signalled by `exit`, where it is a
   * no-op by construction. The case it exists for is the other one: a host
   * declared lost because it stopped answering pings is, as far as the OS is
   * concerned, still running — still holding the GPU, still holding the model
   * in memory. Spawning its replacement without this would double both.
   */
  #retire(): void {
    const handle = this.#handle;
    this.#handle = null;
    if (handle === null) return;
    try {
      handle.kill();
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.#warn(`could not terminate the inference host: ${detail}`);
    }
  }

  /**
   * Bring a host back, unless bringing it back is the problem.
   *
   * A host that dies on startup — a missing model directory, a native addon
   * that aborts on load — would otherwise be respawned forever, each attempt
   * costing a process. The cap turns an infinite loop into a permanent,
   * legible failure: `#closed` keeps its message and every call fails with it.
   */
  #scheduleRestart(): void {
    if (this.#disposed) return;
    const now = this.#timers.now();
    this.#restarts = this.#restarts.filter((at) => now - at < this.#policy.restartWindowMs);
    if (this.#restarts.length >= this.#policy.maxRestarts) {
      this.#closed =
        `The inference process has stopped ${String(this.#restarts.length)} times in a row and ` +
        'is not being restarted again. Restart the app to try once more.';
      this.#warn('the inference host is crash-looping; not restarting it again.');
      this.#cancelTick?.();
      this.#cancelTick = null;
      return;
    }
    this.#restarts.push(now);
    this.#cancelRestart?.();
    this.#cancelRestart = this.#timers.after(this.#policy.restartDelayMs, () => {
      this.#cancelRestart = null;
      this.#attach();
    });
  }
}
