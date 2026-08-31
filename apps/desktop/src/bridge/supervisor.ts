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
 * AND A TURN BELONGS TO ONE WINDOW. Every generation records the renderer that
 * started it. Its tokens and its `llamaEnd` are addressed at that renderer
 * alone, only that renderer can cancel it, and only that renderer going away
 * ends it. Before that, `PluginHost` discarded the invoking sender, so a second
 * window received the first window's answer token by token and either window
 * reloading cancelled both.
 *
 * AND A TURN BELONGS TO ONE ENGINE. Every plugin registered here gets its own
 * in-flight table, its own terminal-event name and its own cancel method, and
 * every call and every event on the wire carries the plugin it belongs to. The
 * old shape had one `#inflight` map keyed by requestId alone and one hard-coded
 * `llamaEnd`/`llamaToken`/`cancel` triple. With a second engine that is not a
 * missing feature but a corruption: two engines may legitimately use the same
 * requestId and may both call their terminal event `end`, so one engine's abort
 * would have settled the other engine's turn, its deadline would have posted a
 * `cancel` the wrong engine answered, and its tokens would have been delivered
 * against the wrong owner. The plugin dimension is what keeps those apart, and
 * `tests/desktop-bridge.test.ts` runs two engines in flight at once — sharing a
 * requestId on purpose — to show it does.
 *
 * The renderer's authority is (1), not (2). `src/ai/backends/llama-cpp.ts`
 * loops `while (!finished && !failure)`, both set by the `generate` promise;
 * nothing in `src/` consumes `llamaEnd` at all. That is also the RIGHT thing
 * to depend on across IPC: an invoke settles once by construction and cannot
 * be lost to a `removeAllListeners()` or a listener-registration race, and an
 * event can be. Building the terminal guarantee on the weaker mechanism would
 * be a choice to be fragile.
 */

import type { GenerateOptions, GenerationEndEvent } from '@chatterang/contracts';

import type { PluginImplementation } from './plugin-host.js';
import type {
  DshStatus,
  HostHandle,
  HostMessage,
  PluginDefinition,
  WireError,
} from './protocol.js';
import { HANDLE_LOST, HOST_TIMEOUT, LLAMA_PLUGIN, SENDER_SCOPED, fromWireError } from './protocol.js';

/**
 * How the supervisor reaches the renderer. Supplied by `PluginHost`.
 *
 * `pluginName` leads, because an event name alone does not identify an event:
 * `PluginHost` keys its subscription table by (plugin, event), and two engines
 * may both emit `end`. It used to be absent and `main.ts` supplied
 * `LLAMA_PLUGIN.name` at the call site, which is the same thing as asserting
 * that only one plugin will ever emit anything.
 *
 * `ownerId` addresses the event at the one window the generation belongs to.
 * Omitting it broadcasts, which is right for `llamaThermal` — a property of the
 * machine — and was wrong for everything else.
 */
export type NotifyListeners = (
  pluginName: string,
  eventName: string,
  data: unknown,
  ownerId?: number,
) => void;

/**
 * The streaming contract of ONE engine.
 *
 * Every name the supervisor used to hard-code — `generate`, `cancel`,
 * `llamaEnd`, `llamaToken` — lives here instead, per plugin. That is what lets
 * a second engine keep the same four guarantees without pretending to be
 * llama.cpp, and it is what stops the guarantees leaking across engines: a
 * terminal event is matched against the emitting plugin's `terminal`, so
 * another engine's identically named event cannot end this one's turn.
 *
 * A plugin with no `stream` is served too — `DshHost` is one — it simply has no
 * turns, no owners and no idle deadline.
 */
export interface StreamSpec {
  /** The method that starts a turn, keyed by `requestId`. */
  readonly start: string;
  /** The method that stops one. Posted by the deadline and by renderer loss. */
  readonly cancel: string;
  /** The event that ends a turn, exactly once. */
  readonly terminal: string;
  /**
   * Events that are proof of progress: delivered to the turn's owner alone,
   * and each one resets the turn's idle deadline.
   */
  readonly progress: readonly string[];
  /** Idle deadline for a turn. Falls back to `policy.generateIdleTimeoutMs`. */
  readonly idleTimeoutMs?: number;
  /**
   * Build the terminal payload for an end nobody reported.
   *
   * Used on the paths the engine never got to speak on: a host that died, a
   * deadline that expired, a `ret` that arrived with no event before it.
   */
  synthesise(requestId: string, error: string): unknown;
}

/** One plugin the supervisor forwards to, and how its turns behave. */
export interface EngineSpec {
  readonly definition: PluginDefinition;
  /**
   * Methods called with the calling renderer's id in front.
   *
   * Defaults to the stream's `start` and `cancel`, which are exactly the two
   * that own per-renderer state. Naming anything else here is a claim that a
   * method's answer differs per window, and `PluginHost.register` refuses a
   * name the definition does not declare.
   */
  readonly senderScoped?: readonly string[];
  /** Omitted for a plugin with no turns. */
  readonly stream?: StreamSpec;
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

/**
 * llama.cpp's engine spec — the one this app ships.
 *
 * `llamaThermal` is deliberately NOT in `progress`: it describes the machine,
 * not a conversation, so it has no owner, it is broadcast, and it must not
 * extend anybody's deadline. A thermal reading arriving every second from a
 * host whose decode has wedged would otherwise keep the turn alive forever,
 * which is the exact failure the deadline exists to end.
 */
export const LLAMA_ENGINE: EngineSpec = Object.freeze({
  definition: LLAMA_PLUGIN,
  stream: Object.freeze({
    start: 'generate',
    cancel: 'cancel',
    terminal: 'llamaEnd',
    progress: Object.freeze(['llamaToken']),
    synthesise: synthesiseEnd,
  }),
});

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
  /**
   * The engines this supervisor forwards to. Defaults to llama.cpp alone.
   *
   * A call or an event naming a plugin that is not here is refused rather than
   * guessed at — see `#receive`. Milestone A3 adds its ONNX spec to this list;
   * nothing else about this class changes.
   */
  readonly engines?: readonly EngineSpec[];
  /** The inference host's DSH boot report, each time one arrives. */
  readonly onBoot?: (status: DshStatus) => void;
  /** Where anomalies go. Never a payload — see the logging rule in main.ts. */
  readonly warn?: (message: string) => void;
  readonly policy?: Partial<SupervisorPolicy>;
  readonly timers?: SupervisorTimers;
}

interface PendingCall {
  /** Which engine this call was addressed to. Chooses the cancel to post. */
  readonly plugin: string;
  readonly method: string;
  /** Set only for a turn, so a timed-out one can be cancelled in the host. */
  readonly requestId?: string;
  /** When this call stops being worth waiting for. */
  deadlineAt: number;
  resolve(value: unknown): void;
  reject(error: Error): void;
}

interface InflightGeneration {
  readonly callId: number;
  /** The renderer that started this turn, and the only one it belongs to. */
  readonly senderId: number;
  /** True once this turn's single terminal event has been DELIVERED. */
  ended: boolean;
}

/**
 * One engine's live state.
 *
 * The in-flight table is PER ENGINE, and that is the whole of the isolation
 * guarantee. One shared map keyed by requestId alone made two engines' turns
 * collide the moment they picked the same id — which they will, because ids are
 * per-caller and nothing coordinates them across engines.
 */
interface EngineState {
  readonly spec: EngineSpec;
  readonly inflight: Map<string, InflightGeneration>;
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

/** The requestId a turn-shaped payload names, if it names one. */
function requestIdOf(data: unknown): string | undefined {
  const requestId = (data as { requestId?: unknown } | null)?.requestId;
  return typeof requestId === 'string' ? requestId : undefined;
}

export class Supervisor {
  readonly #spawn: () => HostHandle;
  readonly #notify: NotifyListeners;
  readonly #onBoot: ((status: DshStatus) => void) | undefined;
  readonly #warn: (message: string) => void;
  readonly #policy: SupervisorPolicy;
  readonly #timers: SupervisorTimers;

  readonly #engines = new Map<string, EngineState>();
  readonly #calls = new Map<number, PendingCall>();
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

    for (const spec of options.engines ?? [LLAMA_ENGINE]) {
      if (this.#engines.has(spec.definition.name)) {
        throw new Error(
          `desktop bridge: two engines are registered as "${spec.definition.name}". ` +
            'The plugin name is the wire address; two engines sharing one is ambiguous ' +
            'in both directions.',
        );
      }
      /*
       * An engine's stream names must exist in the definition it points at.
       *
       * Nothing checked this, and the failure is silent in the worst way: a
       * terminal event the definition does not declare is dropped on delivery,
       * so every turn on that engine runs to completion and then hangs waiting
       * for an end that was discarded — the exact unrecoverable wait the
       * terminal-event rule exists to prevent, reintroduced by a typo.
       *
       * ONNX is the first engine whose names nobody has typed twice, so this
       * lands before it rather than after.
       */
      const stream = spec.stream;
      if (stream !== undefined) {
        const events = new Set(spec.definition.events);
        const methods = new Set(spec.definition.methods);
        const missing: string[] = [];
        if (!events.has(stream.terminal)) missing.push(`event "${stream.terminal}" (terminal)`);
        for (const name of stream.progress) {
          if (!events.has(name)) missing.push(`event "${name}" (progress)`);
        }
        if (!methods.has(stream.start)) missing.push(`method "${stream.start}" (stream start)`);
        if (!methods.has(stream.cancel)) missing.push(`method "${stream.cancel}" (stream cancel)`);
        if (missing.length > 0) {
          throw new Error(
            `desktop bridge: engine "${spec.definition.name}" names ${missing.join(', ')}, ` +
              'which its plugin definition does not declare. A terminal event that is not ' +
              'declared is dropped on delivery, so every turn would hang rather than fail.',
          );
        }
      }

      this.#engines.set(spec.definition.name, { spec, inflight: new Map() });
    }

    this.#attach();
  }

  /** The inference host's DSH boot report, or null before it has arrived. */
  get bootStatus(): DshStatus | null {
    return this.#boot;
  }

  /** In-flight turns across every engine. Exists so a test can assert it drains. */
  get inflightCount(): number {
    let total = 0;
    for (const engine of this.#engines.values()) total += engine.inflight.size;
    return total;
  }

  /**
   * In-flight turns for ONE engine.
   *
   * The isolation assertion needs this: `inflightCount` staying at 1 after an
   * abort says a turn survived, but not WHOSE.
   */
  inflightCountFor(pluginName: string): number {
    return this.#engine(pluginName).inflight.size;
  }

  /** How many hosts have been spawned. 1 until the first one is replaced. */
  get spawnCount(): number {
    return this.#spawnCount;
  }

  /** The plugin names this supervisor serves, in registration order. */
  get engines(): readonly string[] {
    return [...this.#engines.keys()];
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
        entries: [],
        notChecked: 'not reported: no inference host is running',
        error: this.#closed,
      };
    }
    return {
      mounted: false,
      services: [],
      routes: [],
      entries: [],
      notChecked: 'not reported: the inference host has not finished booting',
    };
  }

  /* ── The plugin surface, per engine ────────────────────────────────── */

  /**
   * The `PluginImplementation` for one engine, built from its definition.
   *
   * Every declared method becomes a forwarder tagged with THIS plugin's name,
   * so a call can only ever reach the engine it was addressed to. The stream's
   * `start` and `cancel` get the two wrappers that own per-turn state; nothing
   * else is special-cased, which is what stops a second engine needing a second
   * copy of this class.
   *
   * Built fresh on each call rather than cached, because `PluginHost.register`
   * takes it once at boot and holds it — there is no benefit to sharing, and a
   * cache would be one more thing that can go stale across a respawn.
   *
   * @throws Error for a plugin this supervisor was not given an engine for.
   *   Registering a manifest entry the supervisor cannot serve would leave the
   *   renderer with channels whose every call fails at runtime.
   */
  plugin(pluginName: string): PluginImplementation {
    const engine = this.#engine(pluginName);
    const { definition, stream } = engine.spec;

    const methods: Record<string, (...args: readonly unknown[]) => unknown> = {};
    for (const method of definition.methods) {
      if (stream !== undefined && method === stream.start) {
        methods[method] = (senderId, ...args) => this.#startTurn(engine, senderId as number, args);
      } else if (stream !== undefined && method === stream.cancel) {
        methods[method] = (senderId, ...args) => this.#cancelTurn(engine, senderId as number, args);
      } else {
        methods[method] = (...args) => this.#call(pluginName, method, args);
      }
    }

    return {
      ...methods,
      [SENDER_SCOPED]:
        engine.spec.senderScoped ?? (stream === undefined ? [] : [stream.start, stream.cancel]),
    } as unknown as PluginImplementation;
  }

  #engine(pluginName: string): EngineState {
    const engine = this.#engines.get(pluginName);
    if (engine === undefined) {
      throw new Error(
        `desktop bridge: the supervisor serves no engine named "${pluginName}". ` +
          `It serves: ${[...this.#engines.keys()].join(', ') || '(none)'}.`,
      );
    }
    return engine;
  }

  /**
   * Start a turn.
   *
   * The in-flight record is created BEFORE the call is posted, so a host that
   * dies between the two still has its turn settled by `#onClose`.
   */
  #startTurn(engine: EngineState, senderId: number, args: readonly unknown[]): Promise<unknown> {
    const stream = engine.spec.stream;
    /* c8 ignore next */
    if (stream === undefined) return Promise.reject(new Error('unreachable: no stream spec'));
    const name = engine.spec.definition.name;

    const requestId = (args[0] as GenerateOptions | undefined)?.requestId;
    if (typeof requestId !== 'string' || requestId.length === 0) {
      return Promise.reject(
        new Error(`desktop bridge: ${name}.${stream.start} requires a requestId.`),
      );
    }
    if (this.#closed !== null) {
      return Promise.reject(codedError(this.#closed, HANDLE_LOST));
    }
    // DEFECT [12]. This used to `set` unconditionally, so a second generation
    // reusing a live requestId REPLACED the first one's record — and the record
    // is what carries `ended`. Two turns then shared one terminal event: the
    // first turn's `llamaEnd` was never emitted and its promise was left to the
    // deadline, while the second's arrived against a record that had already
    // been through `#settle`.
    //
    // Refused rather than merged, because the id is also the host's key: the
    // inference host tracks generations by requestId too, so two live turns
    // sharing one is ambiguous all the way down and there is no arrangement of
    // this map that fixes that. Cancelling by that id would be ambiguous, and
    // so would every token it emits.
    //
    // WITHIN ONE ENGINE. Two DIFFERENT engines using the same requestId is not
    // ambiguous at all — each host-side plugin keys its own generations — so
    // this map is per engine and the clash is not refused across them.
    if (engine.inflight.has(requestId)) {
      return Promise.reject(
        new Error(
          `desktop bridge: a generation with requestId "${requestId}" is already running. ` +
            'Each turn needs its own id; the inference host keys generations by it too.',
        ),
      );
    }

    const callId = this.#nextCallId;
    engine.inflight.set(requestId, { callId, senderId, ended: false });
    return this.#call(name, stream.start, args, {
      timeoutMs: stream.idleTimeoutMs ?? this.#policy.generateIdleTimeoutMs,
      requestId,
    }).then(
      (result) => {
        // A host that returned without emitting its own terminal event. Should
        // not happen — `LlamaCppNode` has a `finally` backstop — but a future
        // early return in that file must not be able to hang the UI.
        this.#settle(engine, requestId, result);
        engine.inflight.delete(requestId);
        return result;
      },
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        this.#settle(engine, requestId, stream.synthesise(requestId, message));
        engine.inflight.delete(requestId);
        throw error;
      },
    );
  }

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
   *
   * SCOPED TO ONE ENGINE as well as one window: the lookup is in THIS engine's
   * table, so an abort aimed at a transcription cannot find — and cannot stop —
   * a text generation that happens to share its requestId.
   */
  async #cancelTurn(
    engine: EngineState,
    senderId: number,
    args: readonly unknown[],
  ): Promise<void> {
    if (this.#handle === null) return;
    const stream = engine.spec.stream;
    /* c8 ignore next */
    if (stream === undefined) return;
    // A window may only cancel its own turn. Cancelling by requestId alone
    // would let any window stop any other window's generation, which is the
    // same missing ownership check as defect [11] pointing the other way.
    const requestId = requestIdOf(args[0]);
    if (requestId !== undefined) {
      const entry = engine.inflight.get(requestId);
      // Not in flight at all is a no-op per the contract; in flight for
      // SOMEONE ELSE is also a no-op, and deliberately indistinguishable from
      // it, so a cancel cannot be used to probe what another window is doing.
      if (entry === undefined || entry.senderId !== senderId) return;
    }
    await this.#call(engine.spec.definition.name, stream.cancel, args);
  }

  /* ── Lifecycle ─────────────────────────────────────────────────────── */

  /**
   * The renderer that owns these generations is gone — reloaded, navigated, or
   * closed.
   *
   * Three things happen, and the third is the subtle one: the turns are marked
   * ended WITHOUT emitting, because the page that would have received the
   * event no longer exists and a synthesised terminal event broadcast to
   * whatever page loaded next would be a turn it never started.
   *
   * SCOPED TO ONE RENDERER, which is defect [11]. This used to cancel EVERY
   * in-flight generation regardless of which window departed, because
   * `PluginHost` discarded the invoking sender and there was nothing here to
   * scope by. With two windows open that made one window's reload silently kill
   * the other window's answer mid-sentence — and the second window's `generate`
   * promise rejected with a reason ("the page that started this generation
   * navigated away") that was, for it, simply false.
   *
   * ACROSS EVERY ENGINE, because the window really is gone: a departing
   * renderer's transcription is as abandoned as its generation. Each engine is
   * cancelled with its OWN cancel method, on its own plugin address.
   */
  releaseRenderer(senderId: number, reason: string): void {
    for (const engine of this.#engines.values()) {
      const stream = engine.spec.stream;
      if (stream === undefined) continue;
      for (const [requestId, entry] of engine.inflight) {
        if (entry.senderId !== senderId) continue;
        entry.ended = true;
        this.#post({
          k: 'call',
          id: this.#nextCallId++,
          plugin: engine.spec.definition.name,
          method: stream.cancel,
          args: [{ requestId }],
        });
        const pending = this.#calls.get(entry.callId);
        this.#calls.delete(entry.callId);
        engine.inflight.delete(requestId);
        pending?.reject(codedError(reason, 'RENDERER_GONE'));
      }
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
    plugin: string,
    method: string,
    args: readonly unknown[],
    options?: { timeoutMs?: number; requestId?: string },
  ): Promise<unknown> {
    if (this.#closed !== null) return Promise.reject(codedError(this.#closed, HANDLE_LOST));
    const id = this.#nextCallId++;
    const deadlineAt = this.#timers.now() + (options?.timeoutMs ?? this.#policy.callTimeoutMs);
    return new Promise<unknown>((resolve, reject) => {
      const pending: PendingCall = { plugin, method, deadlineAt, resolve, reject };
      this.#calls.set(
        id,
        options?.requestId === undefined ? pending : { ...pending, requestId: options.requestId },
      );
      this.#post({ k: 'call', id, plugin, method, args });
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
        this.#event(message.plugin, message.name, message.data);
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
   * One event, routed by the plugin that emitted it.
   *
   * The two checks at the top are what the plugin dimension buys. An event
   * naming an engine we do not serve is DROPPED rather than broadcast, and so
   * is one naming an event the engine's own definition does not declare —
   * because `PluginHost` would otherwise be asked to deliver something no
   * renderer could ever have subscribed to, and because a host that has started
   * emitting names we do not know is a host we should be told about.
   */
  #event(plugin: string, name: string, data: unknown): void {
    const engine = this.#engines.get(plugin);
    if (engine === undefined) {
      this.#warn(`inference host sent a "${name}" for unknown plugin "${plugin}".`);
      return;
    }
    if (!engine.spec.definition.events.includes(name)) {
      this.#warn(`inference host sent "${name}", which "${plugin}" does not declare.`);
      return;
    }

    const stream = engine.spec.stream;
    if (stream !== undefined && name === stream.terminal) {
      const requestId = requestIdOf(data);
      if (requestId === undefined) {
        this.#warn(`inference host ended a ${plugin} generation with no requestId.`);
        return;
      }
      this.#settle(engine, requestId, data);
      return;
    }
    if (stream !== undefined && stream.progress.includes(name)) {
      this.#extendDeadline(engine, data);
      const owner = this.#ownerOf(engine, data);
      // A token for a generation this supervisor is not tracking is
      // DROPPED, not broadcast. Broadcasting it would put the text of one
      // window's answer into every other window — which is what the code
      // did for every token, and is the half of defect [11] that leaks data
      // rather than merely cancelling the wrong thing.
      if (owner === undefined) {
        this.#warn(`inference host sent a token for a generation that is not in flight.`);
        return;
      }
      this.#emit(plugin, name, data, owner);
      return;
    }
    // Everything else describes the machine, not a conversation. It has no
    // owner and every window subscribed to it is entitled to it.
    this.#emit(plugin, name, data);
  }

  /**
   * A token is proof of progress, so it buys its generation more time.
   *
   * Without this, `generateIdleTimeoutMs` would be a cap on TOTAL generation
   * time and would cut long answers off mid-sentence — a timeout that breaks
   * working generations is worse than no timeout at all, because it is the
   * kind of thing people work around by raising it until it is useless.
   */
  #extendDeadline(engine: EngineState, data: unknown): void {
    const requestId = requestIdOf(data);
    if (requestId === undefined) return;
    const entry = engine.inflight.get(requestId);
    if (entry === undefined) return;
    const pending = this.#calls.get(entry.callId);
    if (pending === undefined) return;
    pending.deadlineAt =
      this.#timers.now() + (engine.spec.stream?.idleTimeoutMs ?? this.#policy.generateIdleTimeoutMs);
  }

  /** Which renderer owns the generation this event belongs to, if any. */
  #ownerOf(engine: EngineState, data: unknown): number | undefined {
    const requestId = requestIdOf(data);
    if (requestId === undefined) return undefined;
    return engine.inflight.get(requestId)?.senderId;
  }

  /**
   * Deliver one event, and say whether it actually went out.
   *
   * The swallow lives HERE rather than in `main.ts`, and moving it is what
   * makes defect [13]'s fix real instead of decorative. `main.ts` used to wrap
   * `notifyListeners` in its own try/catch and log — so a delivery that threw
   * (a payload structured clone refuses, which `PluginHost` checks BEFORE it
   * delivers anything) never reached this class, and `#settle` had already
   * marked the turn ended. The page got no terminal event, ever, while the
   * `generate` promise resolved perfectly happily.
   *
   * @returns false when the event did not reach anyone, so the caller can
   *   decline to spend the turn's one terminal event on a delivery that failed.
   */
  #emit(pluginName: string, eventName: string, data: unknown, ownerId?: number): boolean {
    try {
      this.#notify(pluginName, eventName, data, ownerId);
      return true;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.#warn(`could not deliver ${pluginName}.${eventName}: ${detail}`);
      return false;
    }
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
      //
      // Addressed at the call's OWN plugin, with that plugin's own cancel
      // method. Posting a bare `cancel` was fine while one engine existed and
      // would, with two, ask llama.cpp to stop a transcription's requestId —
      // which either does nothing or stops a text turn that shares the id.
      const stream = this.#engines.get(pending.plugin)?.spec.stream;
      if (pending.requestId !== undefined && stream !== undefined) {
        this.#post({
          k: 'call',
          id: this.#nextCallId++,
          plugin: pending.plugin,
          method: stream.cancel,
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
   * The single door every terminal event goes through, per engine.
   *
   * The main-process mirror of `LlamaCppNode`'s own `settled` flag — the same
   * discipline, applied at the boundary that flag cannot see across. A double
   * terminal event is not a hang; it is a conversation turn counted twice,
   * which is data corruption and harder to notice.
   *
   * DEFECT [13] was the ORDER of the two statements below. `entry.ended = true`
   * came first, so a delivery that threw consumed the turn's one terminal event
   * without delivering it: the page never saw `llamaEnd`, and the later `ret`
   * from the host found `ended` already set, skipped silently, and resolved the
   * `generate` promise as a success. Marking it from the delivery's own result
   * means a failed delivery leaves the turn open for the next path — the
   * host's `ret`, or `#onClose`'s synthesised end — to try again, with a
   * payload we built ourselves rather than one the engine handed us.
   */
  #settle(engine: EngineState, requestId: string, end: unknown): void {
    const stream = engine.spec.stream;
    /* c8 ignore next */
    if (stream === undefined) return;
    const entry = engine.inflight.get(requestId);
    if (entry === undefined) {
      this.#warn(`inference host ended a generation that is not in flight.`);
      return;
    }
    if (entry.ended) return;
    entry.ended = this.#emit(engine.spec.definition.name, stream.terminal, end, entry.senderId);
  }

  /**
   * The host is gone — by its own `exit`, or because it stopped answering.
   *
   * Settles everything it was carrying, terminates whatever is left of the
   * process, and schedules a replacement. `#closed` is set for the gap between
   * the two so a call made in that window fails fast with `HANDLE_LOST` rather
   * than being posted into nothing.
   *
   * ONE process holds every engine, so losing it loses all of them: each
   * engine's turns get their own synthesised terminal event, on their own
   * event name.
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
    for (const engine of this.#engines.values()) {
      const stream = engine.spec.stream;
      for (const [requestId, entry] of engine.inflight) {
        if (entry.ended || stream === undefined) continue;
        entry.ended = this.#emit(
          engine.spec.definition.name,
          stream.terminal,
          stream.synthesise(requestId, message),
          entry.senderId,
        );
      }
      engine.inflight.clear();
    }

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
