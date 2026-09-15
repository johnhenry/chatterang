/**
 * The hidden worker that runs a paired device's turn, supervised like a host
 * and built on demand (#7 ruling 1).
 *
 * THE RULING: a phone's turn runs in a hidden worker whose loss is the loss of
 * its renderer (`render-process-gone` or `destroyed`), which is respawned
 * under a cap and destroyed when idle. S1 measured the transport: an
 * unchanged `Supervisor` serves the host envelope over a `MessagePort`, and
 * sees the port's close as loss (`docs/BACKGROUND-WORK-MEASUREMENTS.md`).
 *
 * WHY A `Supervisor` PER LIFE, AND NOT ONE LONG-LIVED ONE. A `Supervisor`
 * spawns in its constructor, its `dispose` is terminal, and its restart budget
 * is per instance (`supervisor.ts`). An on-demand worker needs all three the
 * other way round: nothing is spawned until a unit runs, an idle worker is
 * destroyed and a later unit builds another, and the cap on crashes has to
 * survive that. So each worker life gets its own `Supervisor`, which never
 * restarts anything itself, and THIS object owns what spans lives: when to
 * build one, when to retire it, and the restart budget.
 *
 * THE BUDGET IS ACROSS LIVES. A loss (the worker's port closing, the
 * `Supervisor` condemning it for an unanswered ping, its peer-turn deadline
 * expiring, the broker condemning it, or a spawn that failed) is counted
 * exactly as `Supervisor.#scheduleRestart` counts one: more than
 * `policy.maxRestarts` inside `policy.restartWindowMs` stops the loop, and
 * every later run is refused `WORKER_CRASH_LOOP` without spawning, until the
 * app restarts. An idle retire is not a loss and is not counted. Building the
 * next life on admission therefore cannot reset the cap.
 *
 * THE SENDER ID IS REAL. `spawnWorker` returns the worker window's own
 * `webContents.id`, which is what `PluginHost` sees when that window calls
 * `LlamaCpp.generate`, so `hostedUnitOf` can name the unit that window runs
 * (`local-turns.ts`). Never a number invented for it: the broker keys windows
 * by that id, and an invented one can collide with a user's window
 * (`work-broker.ts`). One that is not a positive integer is refused.
 *
 * ONE UNIT AT A TIME, AND EXACTLY ONE TERMINAL EACH. `run` resolves once, and
 * never rejects, with the worker's own end frame or a failure this file names.
 * A frame or an end that arrives after the terminal reaches nothing.
 *
 * `condemn` IS THE BROKER'S `condemnExecutor`, AND IT DOES NOT CALL
 * `broker.workerLost` ITSELF. The brief for this unit said it should; the code
 * says otherwise. `WorkBroker.#drainExpired` calls `this.workerLost(executor)`
 * as soon as the hook answers true (`work-broker.ts`). A hook that also called
 * it would re-enter the broker first: that call frees the slot and starts the
 * next waiting unit, which for a phone unit builds a new worker, and the
 * broker's own call then ends that NEW unit `WORKER_LOST`.
 * `tests/desktop-worker-host.test.ts` (test 5) fails on exactly that. On a
 * loss the broker did not start (a crash, an unanswered ping, a deadline),
 * this file does call `broker.workerLost(WORKER_EXECUTOR)`, once, and only if
 * a unit was running, so the broker ends it `WORKER_LOST` and frees the slot
 * at once.
 *
 * A RUN NEVER ENDS WHILE ITS WORKER MAY STILL BE WORKING, AND THE BROKER IS
 * THE ONLY DEADLINE. The broker frees the slot when a unit's work returns, and
 * the work is `run`. The broker also sees progress this file never does: the
 * worker window's own `LlamaCpp` tokens (`withTurnProgress` through
 * `hostedUnitOf`) and every relayed prompt answered or refused. So the peer
 * turn has no deadline of its own in the `Supervisor`
 * (`PEER_TURN_IDLE_TIMEOUT_MS` is infinite): a finite one, reset only by a
 * PeerTurn frame, killed a worker the broker still counted as running. A
 * silent unit is ended by the broker (`DEADLINE`, its drain, then `condemn`),
 * and a silent worker by the `Supervisor`'s ping. Were a `HOST_TIMEOUT` ever
 * to reach a run, it ends the life (kills the worker) before the run resolves.
 * `run` is a broker unit's work: one started outside the broker has no
 * deadline but the ping, its signal and `dispose`.
 *
 * PLATFORM-FREE, like the rest of the bridge (`tests/layering.test.ts`): no
 * Electron, no Node builtin, timers injected. `main.ts` wraps a hidden window
 * as the `HostHandle` (S5). LOGGING RULE, as in `main.ts`: nothing here logs a
 * turn, a frame, or a message a worker supplied.
 */

import type { HostedUnit, HostedUnitOf } from './local-turns.js';
import type { HostHandle, PeerTurnEndEvent } from './protocol.js';
import { HANDLE_LOST, HOST_TIMEOUT, PEER_TURN_PLUGIN, PEER_TURN_STREAM } from './protocol.js';
import type { EngineSpec, NotifyListeners, SupervisorPolicy, SupervisorTimers } from './supervisor.js';
import { DEFAULT_POLICY, Supervisor, systemTimers } from './supervisor.js';
import type { WorkBroker } from './work-broker.js';

/** The executor name a device's units run on, for `WorkBroker.workerLost` and `condemnExecutor`. */
export const WORKER_EXECUTOR = 'worker';

/**
 * How long a worker with no unit is kept before it is destroyed.
 *
 * Two minutes. A person on a phone reads a reply and types the next message in
 * well under that, so a conversation keeps one warm worker; past it the
 * conversation has paused, and a hidden renderer is not kept for a person who
 * put the phone down. The cost of guessing short is a worker built again (its
 * window loading the app), not a lost turn.
 */
export const WORKER_IDLE_MS = 2 * 60_000;

/**
 * The peer turn's inactivity deadline in the `Supervisor`: none.
 *
 * THE BROKER IS THE AUTHORITY ON A DEVICE'S UNIT, and it resets that unit's
 * idle deadline on progress the `Supervisor` never sees: the worker window's
 * own hosted decode (`withTurnProgress`, `local-turns.ts`) and each relayed
 * prompt answered or refused (`WorkBroker.answerPrompt`). A finite deadline
 * here is reset only by a `peerTurnFrame`. It was 241 s (unit idle, prompt
 * answer, drain and one tick), and it killed a worker mid-turn, ending the
 * unit `WORKER_LOST` while the broker had it running: a decode that streamed
 * no frame, or two confirms answered in time with a bash run between them. No
 * finite value is safe, since each answered confirm buys the broker's unit
 * another `UNIT_IDLE_TIMEOUT_MS`. The default `generateIdleTimeoutMs` (120 s)
 * would be worse. The broker ends a silent unit itself (`DEADLINE`, then
 * `UNIT_DRAIN_TIMEOUT_MS`, then `condemn`), and the `Supervisor`'s ping still
 * ends a silent worker.
 */
export const PEER_TURN_IDLE_TIMEOUT_MS = Number.POSITIVE_INFINITY;

/** A zeroed end, for a peer turn the worker never got to end itself. Never a frame. */
function synthesisePeerTurnEnd(requestId: string, error: string): PeerTurnEndEvent {
  return { requestId, error };
}

/** The `Supervisor`'s engine for a worker life: `PEER_TURN_PLUGIN` and its one stream. */
export const PEER_TURN_ENGINE: EngineSpec = Object.freeze({
  definition: PEER_TURN_PLUGIN,
  stream: Object.freeze({
    ...PEER_TURN_STREAM,
    idleTimeoutMs: PEER_TURN_IDLE_TIMEOUT_MS,
    synthesise: synthesisePeerTurnEnd,
  }),
});

/** Why a run ended without the worker's own end frame. */
export type WorkerFailure =
  /** The worker went away mid-unit: its port closed, or it stopped answering pings. */
  | 'HANDLE_LOST'
  /**
   * The `Supervisor` gave up waiting on the start call; the worker was stopped
   * first. Not reached while `PEER_TURN_IDLE_TIMEOUT_MS` is infinite.
   */
  | 'HOST_TIMEOUT'
  /** The broker condemned it: its work did not stop after its abort. */
  | 'WORKER_CONDEMNED'
  /** It has been lost more than `maxRestarts` times inside `restartWindowMs`; nothing is spawned. */
  | 'WORKER_CRASH_LOOP'
  /** `spawnWorker` threw, or named no real sender id. */
  | 'WORKER_SPAWN_FAILED'
  /** A unit is already running; this one was not started. */
  | 'WORKER_BUSY'
  /** `dispose` was called: the app is quitting. */
  | 'WORKER_DISPOSED'
  /** The signal was already aborted: the unit was not started. */
  | 'ABORTED'
  /** The worker answered the start call without an end frame, or its start call threw. */
  | 'WORKER_FAILED';

/** A unit's one terminal. */
export type WorkerTurnEnd =
  | { readonly kind: 'ended'; readonly frame: Uint8Array }
  | { readonly kind: 'failed'; readonly code: WorkerFailure; readonly message: string };

/** One worker, started. */
export interface WorkerSpawn {
  readonly handle: HostHandle;
  /** The worker window's own `webContents.id`: a positive integer, never an invented one. */
  readonly senderId: number;
}

export interface WorkerHostOptions {
  /** Start one worker. Called only when a unit runs and no worker is live. */
  readonly spawnWorker: () => WorkerSpawn;
  /** The one broker. A unit's frames are its progress; a loss mid-unit is `workerLost`. */
  readonly broker: WorkBroker;
  readonly timers?: SupervisorTimers;
  /**
   * Each life's `Supervisor` policy, and the budget across lives:
   * `maxRestarts` within `restartWindowMs`. No `Supervisor` restarts a worker
   * itself.
   */
  readonly policy?: Partial<SupervisorPolicy>;
  /** Anomalies. Never a payload. */
  readonly warn?: (message: string) => void;
}

export interface WorkerHost {
  /**
   * Run one unit on the worker, building a worker first if none is live.
   *
   * Resolves exactly once and never rejects. Aborting `signal` asks the worker
   * to cancel; the terminal is still the worker's own end, or a failure.
   */
  run(
    unit: HostedUnit,
    encodedTurn: Uint8Array,
    signal: AbortSignal,
    onFrame: (frame: Uint8Array) => void,
  ): Promise<WorkerTurnEnd>;
  /**
   * `WorkBroker`'s `condemnExecutor`. True only for `WORKER_EXECUTOR`, and
   * only once the live worker has been killed; the broker then calls
   * `workerLost`. False when there is no worker, or its kill threw.
   */
  condemn(executor: string): boolean;
  /** For `admitLocalTurns`: the unit the worker window with this sender id is running, while it runs. */
  readonly hostedUnitOf: HostedUnitOf;
  /** The app is quitting: the worker is killed and no run starts again. */
  dispose(): void;
}

const MESSAGES: Readonly<Record<WorkerFailure, string>> = {
  HANDLE_LOST: 'The worker running this turn stopped.',
  HOST_TIMEOUT: 'The worker running this turn sent nothing for too long, so it was stopped.',
  WORKER_CONDEMNED: 'The worker running this turn did not stop when asked, so it was stopped.',
  WORKER_CRASH_LOOP:
    'The worker that runs turns from paired devices has stopped too many times in a row and is not being ' +
    'started again. Restart the app to try once more.',
  WORKER_SPAWN_FAILED: 'The worker that runs turns from paired devices could not be started.',
  WORKER_BUSY: 'The worker is already running a turn.',
  WORKER_DISPOSED: 'The app is quitting, so the worker runs no more turns.',
  ABORTED: 'The turn was cancelled before the worker started it.',
  WORKER_FAILED: 'The worker could not run this turn.',
};

function failed(code: WorkerFailure): WorkerTurnEnd {
  return { kind: 'failed', code, message: MESSAGES[code] };
}

/** An error's class name only. A message could carry a turn. */
function errorKind(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

/** Bytes, whichever realm structured clone built them in. */
function isFrame(value: unknown): value is Uint8Array {
  return ArrayBuffer.isView(value) && Object.prototype.toString.call(value) === '[object Uint8Array]';
}

interface Life {
  readonly senderId: number;
  /** The worker's own kill, as `spawnWorker` returned it. */
  readonly kill: () => void;
  readonly facade: Record<string, (...args: unknown[]) => unknown>;
  supervisor: Supervisor | null;
  state: 'live' | 'ending';
  killed: boolean;
  cancelIdle: (() => void) | null;
}

interface Active {
  readonly life: Life;
  readonly unit: HostedUnit;
  readonly requestId: string;
  readonly onFrame: (frame: Uint8Array) => void;
  readonly resolve: (end: WorkerTurnEnd) => void;
  settled: boolean;
}

class OnDemandWorkerHost implements WorkerHost {
  readonly #spawnWorker: () => WorkerSpawn;
  readonly #broker: WorkBroker;
  readonly #timers: SupervisorTimers;
  readonly #policy: SupervisorPolicy;
  readonly #options: WorkerHostOptions;
  readonly #warn: (message: string) => void;

  #life: Life | null = null;
  #active: Active | null = null;
  /** Loss times inside the window, across every life. */
  #restarts: number[] = [];
  #crashLooped = false;
  #disposed = false;
  #nextRequest = 1;

  constructor(options: WorkerHostOptions) {
    this.#options = options;
    this.#spawnWorker = options.spawnWorker;
    this.#broker = options.broker;
    this.#timers = options.timers ?? systemTimers();
    this.#policy = { ...DEFAULT_POLICY, ...options.policy };
    this.#warn = options.warn ?? ((): void => undefined);
  }

  readonly hostedUnitOf: HostedUnitOf = (senderId) => {
    const active = this.#active;
    if (active === null || active.settled || active.life.state !== 'live') return undefined;
    return active.life.senderId === senderId ? active.unit : undefined;
  };

  run(
    unit: HostedUnit,
    encodedTurn: Uint8Array,
    signal: AbortSignal,
    onFrame: (frame: Uint8Array) => void,
  ): Promise<WorkerTurnEnd> {
    if (this.#disposed) return Promise.resolve(failed('WORKER_DISPOSED'));
    if (this.#active !== null) return Promise.resolve(failed('WORKER_BUSY'));
    if (signal.aborted) return Promise.resolve(failed('ABORTED'));

    const life = this.#life ?? this.#spawn();
    if (typeof life === 'string') return Promise.resolve(failed(life));
    life.cancelIdle?.();
    life.cancelIdle = null;

    const requestId = `peer-turn-${String(this.#nextRequest++)}`;
    return new Promise<WorkerTurnEnd>((resolve) => {
      const active: Active = { life, unit, requestId, onFrame, resolve, settled: false };
      this.#active = active;

      signal.addEventListener(
        'abort',
        () => {
          if (active.settled) return;
          void this.#call(life, PEER_TURN_STREAM.cancel, { requestId }).catch(() => undefined);
        },
        { once: true },
      );

      this.#call(life, PEER_TURN_STREAM.start, { requestId, frame: encodedTurn }).then(
        (value) => {
          if (active.settled) return;
          const frame = (value as { frame?: unknown } | null)?.frame;
          this.#settle(active, isFrame(frame) ? { kind: 'ended', frame } : failed('WORKER_FAILED'));
        },
        (error: unknown) => {
          if (active.settled) return;
          const code = (error as { code?: unknown } | null)?.code;
          if (code === HANDLE_LOST || code === HOST_TIMEOUT) {
            // Whatever the worker is doing, it is not answering: stop it before
            // the run ends, so the slot is never freed under work still running.
            if (life.state === 'live') this.#endLife(life, 'lost', failed(code));
            else this.#settle(active, failed(code));
            return;
          }
          this.#settle(active, failed('WORKER_FAILED'));
        },
      );
    });
  }

  condemn(executor: string): boolean {
    if (executor !== WORKER_EXECUTOR) return false;
    const life = this.#life;
    if (life === null || life.state !== 'live') return false;
    try {
      life.kill();
    } catch (error) {
      // Not confirmed dead: fail closed, and the broker keeps the slot.
      this.#warn(`worker host: killing a condemned worker threw (${errorKind(error)}).`);
      return false;
    }
    life.killed = true;
    this.#endLife(life, 'condemned', failed('WORKER_CONDEMNED'));
    return true;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    const life = this.#life;
    if (life !== null) this.#endLife(life, 'retire', failed('WORKER_DISPOSED'));
  }

  /* ── Lives ─────────────────────────────────────────────────────────── */

  /** Build one worker life, or say why not. */
  #spawn(): Life | WorkerFailure {
    if (this.#crashLooped) return 'WORKER_CRASH_LOOP';

    let spawned: WorkerSpawn;
    try {
      spawned = this.#spawnWorker();
    } catch (error) {
      this.#warn(`worker host: could not start a worker (${errorKind(error)}).`);
      this.#recordLoss();
      return 'WORKER_SPAWN_FAILED';
    }
    const { handle, senderId } = spawned;
    if (!Number.isInteger(senderId) || senderId <= 0) {
      this.#warn('worker host: a worker named no real sender id; it was stopped.');
      try {
        handle.kill();
      } catch (error) {
        this.#warn(`worker host: stopping it threw (${errorKind(error)}).`);
      }
      this.#recordLoss();
      return 'WORKER_SPAWN_FAILED';
    }

    let handed = false;
    const life: Life = {
      senderId,
      kill: () => handle.kill(),
      facade: {},
      supervisor: null,
      state: 'live',
      killed: false,
      cancelIdle: null,
    };
    const supervisor = new Supervisor({
      // ONE LIFE. The worker was spawned above; a second call would be the
      // Supervisor restarting it, which only this object may decide.
      spawn: () => {
        if (handed) throw new Error('worker host: a worker life is spawned once.');
        handed = true;
        return {
          link: handle.link,
          // Every loss the Supervisor decides ends in this kill: its port
          // closing, an unanswered ping, a link that refused a message.
          kill: () => {
            if (!life.killed) {
              life.killed = true;
              try {
                handle.kill();
              } catch (error) {
                this.#warn(`worker host: stopping a lost worker threw (${errorKind(error)}).`);
              }
            }
            if (life.state === 'live') this.#endLife(life, 'lost', failed('HANDLE_LOST'));
          },
        };
      },
      notify: this.#notifyFor(life),
      engines: [PEER_TURN_ENGINE],
      warn: (message) => this.#warn(`worker host: ${message}`),
      // Backstop: were a loss ever to reach the Supervisor's own restart, it
      // would refuse rather than spawn.
      policy: { ...this.#options.policy, maxRestarts: 0 },
      timers: this.#timers,
    });
    life.supervisor = supervisor;
    Object.assign(life.facade, supervisor.plugin(PEER_TURN_PLUGIN.name));
    this.#life = life;
    return life;
  }

  /**
   * A life is over. Idempotent, and the only door: the life is dropped, the
   * worker killed, a loss counted, the running unit's one terminal decided,
   * the Supervisor disposed, and, for a loss the broker did not decide,
   * `workerLost` said once.
   */
  #endLife(life: Life, cause: 'retire' | 'lost' | 'condemned', end: WorkerTurnEnd): void {
    if (life.state !== 'live') return;
    life.state = 'ending';
    if (this.#life === life) this.#life = null;
    life.cancelIdle?.();
    life.cancelIdle = null;

    if (!life.killed) {
      life.killed = true;
      try {
        life.kill();
      } catch (error) {
        this.#warn(`worker host: stopping a worker threw (${errorKind(error)}).`);
      }
    }
    if (cause !== 'retire') this.#recordLoss();

    const active = this.#active !== null && this.#active.life === life ? this.#active : null;
    if (active !== null) this.#settle(active, end);
    // After the terminal, so the end the Supervisor synthesises reaches nothing.
    life.supervisor?.dispose();

    // The broker's own condemn calls `workerLost` when `condemn` answers true.
    if (cause === 'lost' && active !== null) this.#broker.workerLost(WORKER_EXECUTOR);
  }

  /** Counted as `Supervisor.#scheduleRestart` counts a restart. */
  #recordLoss(): void {
    const now = this.#timers.now();
    this.#restarts = this.#restarts.filter((at) => now - at < this.#policy.restartWindowMs);
    if (this.#restarts.length >= this.#policy.maxRestarts) {
      if (!this.#crashLooped) this.#warn('worker host: the worker is crash-looping; not starting it again.');
      this.#crashLooped = true;
      return;
    }
    this.#restarts.push(now);
  }

  #armIdle(life: Life): void {
    life.cancelIdle?.();
    life.cancelIdle = this.#timers.after(WORKER_IDLE_MS, () => {
      life.cancelIdle = null;
      if (this.#life === life && this.#active === null) this.#endLife(life, 'retire', failed('WORKER_DISPOSED'));
    });
  }

  /* ── Units ─────────────────────────────────────────────────────────── */

  #settle(active: Active, end: WorkerTurnEnd): void {
    if (active.settled) return;
    active.settled = true;
    if (this.#active === active) this.#active = null;
    active.resolve(end);
    if (active.life.state === 'live' && this.#life === active.life && this.#active === null) {
      this.#armIdle(active.life);
    }
  }

  #call(life: Life, method: string, payload: unknown): Promise<unknown> {
    try {
      const fn = life.facade[method];
      /* c8 ignore next */
      if (fn === undefined) return Promise.reject(new Error(`worker host: no ${method}.`));
      return Promise.resolve(fn(life.senderId, payload));
    } catch (error) {
      return Promise.reject(error);
    }
  }

  /** The Supervisor's `notify` for one life: its frames and its end, for its running unit alone. */
  #notifyFor(life: Life): NotifyListeners {
    return (pluginName, eventName, data, ownerId) => {
      if (pluginName !== PEER_TURN_PLUGIN.name || ownerId !== life.senderId) return;
      const active = this.#active;
      if (active === null || active.life !== life || active.settled) return;
      const payload = data as { requestId?: unknown; frame?: unknown } | null;
      if (payload?.requestId !== active.requestId || !isFrame(payload.frame)) return;
      const { frame } = payload;

      if (eventName === PEER_TURN_STREAM.terminal) {
        this.#settle(active, { kind: 'ended', frame });
        return;
      }
      if (!(PEER_TURN_STREAM.progress as readonly string[]).includes(eventName)) return;
      this.#broker.progress(active.unit.owner, active.unit.unitId);
      // Progress can end the unit (a deadline that had passed); its frames stop there.
      if (active.settled) return;
      try {
        active.onFrame(frame);
      } catch (error) {
        this.#warn(`worker host: a frame's receiver threw (${errorKind(error)}).`);
      }
    };
  }
}

/**
 * The hidden worker's host. Builds nothing until the first `run`.
 *
 * `main.ts` (S5) passes `condemnExecutor: (executor) => host.condemn(executor)`
 * to the broker and `hostedUnitOf: host.hostedUnitOf` to `admitLocalTurns`.
 */
export function createWorkerHost(options: WorkerHostOptions): WorkerHost {
  return new OnDemandWorkerHost(options);
}
