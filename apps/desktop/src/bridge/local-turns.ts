/**
 * The desktop's own generations take the work broker's one slot (#7, ruling 3).
 *
 * `WorkBroker` holds one slot and one first-come-first-served wait list. A
 * paired phone's turn and the desktop user's own turn share them, and whoever
 * waits is told, including the person at the desktop. This file puts the
 * desktop's `LlamaCpp.generate` and `LlamaCpp.benchmark` on that slot, WITHOUT
 * changing the Supervisor. The Supervisor still owns "every generation it
 * starts ends exactly once". This owns whether a decode may start yet.
 *
 * WHAT THE WRAPPER CHANGES, method by method:
 *
 *   - `generate` is admitted to the broker as a unit owned by the calling
 *     window (kind `window`, its `webContents.id`), keyed by its `requestId`.
 *     It reaches the fleet's facade only when the unit takes the slot. While
 *     it waits, the window receives `llamaWaiting { requestId, position }`, and
 *     `position: 0` once it starts.
 *   - `cancel` of a turn that is still WAITING ends it in the broker. It gets a
 *     `llamaEnd` with `stopReason: 'cancelled'` and its `generate` resolves the
 *     way a cancelled generation does. A running turn's cancel goes to the
 *     Supervisor exactly as before.
 *   - `benchmark` decodes too (a prefill and a run of tokens per repetition),
 *     so it takes the slot as well. It does NOT wait: the benchmark screen has
 *     no place in line to show, so a benchmark asked for while anything holds
 *     or waits for the slot is refused `SLOT_BUSY`, and one that is running
 *     makes every generation, local or phone, wait behind it.
 *   - Every other method is the facade's own and takes no slot: none of them
 *     decodes.
 *
 * A WINDOW'S UNIT IS ONE DECODE; A PHONE'S UNIT IS ONE TURN. The broker's slot
 * is taken per `generate` here, because that is the only boundary main can
 * see: a renderer's turn is a loop in `src/ai/engine.ts` (a tool call runs
 * between two generates, and a local approval sheet waits between them
 * holding nothing). So a phone's turn can take the slot between two decodes of
 * a local tool turn. The GPU never runs two decodes, which is what the slot
 * exists for; whether #169's "one turn at a time" also means a local tool loop
 * keeps the slot across its tool calls is the owner's to rule.
 *
 * A WORKER'S GENERATIONS RUN UNDER THE UNIT IT RUNS. Ruling 1 puts a phone's
 * turn in a hidden worker window (S5), whose engine calls `LlamaCpp.generate`
 * through this same plugin. That unit already holds the slot; admitting its
 * generate as a second unit would queue it behind itself for ever. So
 * `hostedUnitOf` names, for a window that is a worker, the unit it runs: its
 * `generate` goes straight to the host while that unit is running, one at a
 * time, and is refused otherwise; and its tokens are progress for that unit.
 * Main passes no `hostedUnitOf` until S5 creates a worker, so today every
 * window is a user's.
 *
 * EXACTLY ONE `llamaEnd`, STILL:
 *
 *   - A turn that STARTED gets its terminal from the Supervisor, whichever way
 *     it ends. If the broker ends it (a suspend, a quit, the broker's backstop
 *     deadline), the wrapper cancels it in the host through the facade, and the
 *     host's end is the one delivered. The `generate` promise, which is the
 *     page's authority (`supervisor.ts`), rejects with the broker's reason.
 *   - A turn that NEVER STARTED gets one synthesised `llamaEnd` from here,
 *     unless its window is gone. That matches `Supervisor.releaseRenderer`: no
 *     page, nothing delivered.
 *   - A turn the broker REFUSES gets no `llamaEnd`, the same as a generate the
 *     Supervisor refuses before starting it (a duplicate requestId, a closed
 *     host). So does a worker's generate refused for not running its unit.
 *
 * WHY `llamaWaiting` IS NOT IN `LLAMA_EVENTS`. The llama host is served with
 * `LLAMA_PLUGIN`, and the Supervisor drops any event that definition does not
 * declare. So the host cannot emit a waiting state it does not own. Only main,
 * registering `LOCAL_TURNS_PLUGIN`, lets a window subscribe to it. A platform
 * that registers the plain definition, such as the headless server, refuses
 * the subscription, and the renderer treats that as "never waits here".
 *
 * PLATFORM-FREE, like the rest of the bridge. `main.ts` cannot be imported by a
 * test, so the wiring lives here, where `tests/desktop-local-turns.test.ts`
 * drives it against a real Supervisor, a real HostFleet and a real WorkBroker.
 */

import type { GenerateOptions, GenerationEndEvent } from '@chatterang/contracts';

import type { PluginImplementation } from './plugin-host.js';
import type { PluginDefinition } from './protocol.js';
import { LLAMA_EVENTS, LLAMA_METHODS, LLAMA_PLUGIN, SENDER_SCOPED } from './protocol.js';
import type { NotifyListeners, StreamSpec } from './supervisor.js';
import { LLAMA_ENGINE } from './supervisor.js';
import type { AdmitRefusal, BrokerNotice, Owner, UnitEnd, WorkBroker } from './work-broker.js';

/** The event that tells a window its generation is waiting, and where it is. */
export const TURN_WAITING_EVENT = 'llamaWaiting';

/** The executor name the desktop's generations run on, for `WorkBroker.workerLost`. */
export const LOCAL_EXECUTOR = 'llama';

/** The one non-streamed llama method that decodes, and so takes the slot. */
const BENCHMARK = 'benchmark';

/**
 * What main registers for `LlamaCpp`: the llama definition plus the waiting
 * event. The methods are the same array, not a copy, so the renderer's reach
 * cannot grow here by accident.
 */
export const LOCAL_TURNS_PLUGIN: PluginDefinition = Object.freeze({
  name: LLAMA_PLUGIN.name,
  methods: LLAMA_METHODS,
  events: Object.freeze([...LLAMA_EVENTS, TURN_WAITING_EVENT]),
});

/** The broker unit a worker window is running. */
export interface HostedUnit {
  readonly owner: Owner;
  readonly unitId: string;
}

/**
 * For a window that is a WORKER (S5), the unit whose work it runs; undefined
 * for every other window. Main's, because only main knows which windows it
 * created as workers.
 */
export type HostedUnitOf = (senderId: number) => HostedUnit | undefined;

/** The broker's `notifyWindow` for the desktop, plus forgetting a window that went away. */
export interface LocalTurnNotices {
  (windowId: number, notice: BrokerNotice): boolean;
  /** Forget everything remembered about a window. Its units' ends are never delivered to it. */
  release(windowId: number): void;
}

export interface LocalTurnsOptions {
  readonly broker: WorkBroker;
  /** The `PluginImplementation` the fleet built for llama.cpp. */
  readonly facade: PluginImplementation;
  /** Whatever releases a departed window's turns and sessions across every host. */
  readonly fleet: { releaseRenderer(senderId: number, reason: string): void };
  /** The notifier the broker was built with, so a departed window is forgotten there too. */
  readonly notices: LocalTurnNotices;
  /** Emit one plugin event, to one window when `ownerId` is given. */
  readonly notify: NotifyListeners;
  /** S5's worker windows. Omitted: no window is a worker. */
  readonly hostedUnitOf?: HostedUnitOf | undefined;
}

export interface LocalTurns {
  /** Register this for `LOCAL_TURNS_PLUGIN`. */
  readonly plugin: PluginImplementation;
  /**
   * A window went away. Its units leave the broker first, so a waiting turn
   * can never start for a page that is gone, and then the fleet releases what
   * it was running.
   */
  releaseRenderer(senderId: number, reason: string): void;
}

const REFUSED: Readonly<Record<AdmitRefusal, string>> = {
  DUPLICATE_UNIT:
    'desktop bridge: a generation with this requestId is already running or waiting. Each turn needs its own id.',
  OWNER_REVOKED: 'desktop bridge: this window may not start a generation.',
  OWNER_WAIT_LIST_FULL: 'This window already has turns waiting for the model. Wait for one to finish.',
  WAIT_LIST_FULL: 'Too many turns are waiting for the model on this computer. Try again when one finishes.',
  SLOT_BUSY: 'Another turn is using the model on this computer. Run the benchmark again when it has finished.',
  HOST_SUSPENDED: 'The computer is going to sleep, so no generation can start.',
  DESKTOP_QUITTING: 'The app is quitting, so no generation can start.',
};

const ENDED: Readonly<Record<Exclude<UnitEnd, 'COMPLETED' | 'FAILED'>, string>> = {
  WORKER_LOST: 'The process running this generation stopped.',
  OWNER_LOST: 'The window that started this generation went away.',
  OWNER_REVOKED: 'This generation’s owner is no longer allowed to run it.',
  CANCELLED: 'The generation was cancelled before it started.',
  DEADLINE: 'The generation produced nothing for too long.',
  HOST_SUSPENDED: 'The generation stopped because the computer went to sleep.',
  DESKTOP_QUITTING: 'The generation stopped because the app is quitting.',
};

const BENCHMARK_ENDED: Readonly<Record<Exclude<UnitEnd, 'COMPLETED' | 'FAILED'>, string>> = {
  WORKER_LOST: 'The process running the benchmark stopped.',
  OWNER_LOST: 'The window that started the benchmark went away.',
  OWNER_REVOKED: 'This window is no longer allowed to run the benchmark.',
  CANCELLED: 'The benchmark was cancelled.',
  DEADLINE: 'The benchmark took too long.',
  HOST_SUSPENDED: 'The benchmark stopped because the computer went to sleep.',
  DESKTOP_QUITTING: 'The benchmark stopped because the app is quitting.',
};

function codedError(message: string, code: string): Error {
  const error = new Error(message);
  Object.assign(error, { code });
  return error;
}

function llamaStream(): StreamSpec {
  const stream = LLAMA_ENGINE.stream;
  /* c8 ignore next */
  if (stream === undefined) throw new Error('desktop bridge: llama.cpp has no stream spec.');
  return stream;
}

/** A cancelled end for a turn that never reached the host. */
function cancelledEnd(requestId: string): GenerationEndEvent {
  return {
    requestId,
    text: '',
    promptTokens: 0,
    cachedTokens: 0,
    completionTokens: 0,
    ttftMs: 0,
    totalMs: 0,
    tokensPerSecond: 0,
    stopReason: 'cancelled',
  };
}

function requestIdOf(options: unknown): string | undefined {
  const requestId = (options as { requestId?: unknown } | null | undefined)?.requestId;
  return typeof requestId === 'string' && requestId.length > 0 ? requestId : undefined;
}

/**
 * Put the desktop's generations on the broker's slot.
 *
 * @throws Error at boot for a facade that is not the one the fleet builds: a
 *   missing method, or a sender scoping other than exactly the stream's start
 *   and cancel. Wrapping anything else would forward calls in a shape it does
 *   not take.
 */
export function admitLocalTurns(options: LocalTurnsOptions): LocalTurns {
  const { broker, facade, fleet, notices, notify, hostedUnitOf } = options;
  const stream = llamaStream();
  const methods = facade as unknown as Record<string | symbol, unknown>;

  for (const name of LLAMA_METHODS) {
    if (typeof methods[name] !== 'function') {
      throw new Error(
        `desktop bridge: the llama facade has no "${name}". The slot can only wrap the facade the fleet built.`,
      );
    }
  }
  const scoped = methods[SENDER_SCOPED];
  if (
    !Array.isArray(scoped) ||
    scoped.length !== 2 ||
    !scoped.includes(stream.start) ||
    !scoped.includes(stream.cancel)
  ) {
    throw new Error(
      `desktop bridge: the llama facade must scope exactly "${stream.start}" and "${stream.cancel}" to the ` +
        'calling window; the slot is keyed by that window.',
    );
  }

  const call = (name: string, ...args: unknown[]): Promise<unknown> => {
    try {
      return Promise.resolve((methods[name] as (...given: unknown[]) => unknown)(...args));
    } catch (error) {
      return Promise.reject(error);
    }
  };

  /** Deliver one terminal we built ourselves. A failed delivery does not stop the promise settling. */
  const endOnce = (senderId: number, end: GenerationEndEvent): void => {
    try {
      notify(LLAMA_PLUGIN.name, stream.terminal, end, senderId);
    } catch {
      // The promise is the page's authority; a delivery that threw is logged
      // nowhere here because its payload would be the thing logged.
    }
  };

  /** Hosted units with a generate in flight: one decode at a time under one slot. */
  const hostedBusy = new Set<string>();

  /** A worker's generate: its unit's work, under its unit's slot. */
  const generateHosted = async (senderId: number, request: unknown, hosted: HostedUnit): Promise<unknown> => {
    const key = `${hosted.owner.kind}:${String(hosted.owner.id)} ${hosted.unitId}`;
    if (!broker.isRunning(hosted.owner, hosted.unitId)) {
      throw codedError(
        'desktop bridge: this worker’s unit does not hold the slot, so it may not generate.',
        'NOT_RUNNING',
      );
    }
    if (hostedBusy.has(key)) {
      throw codedError('desktop bridge: this worker already has a generation running under its unit.', 'SLOT_BUSY');
    }
    hostedBusy.add(key);
    try {
      return await call(stream.start, senderId, request as GenerateOptions);
    } finally {
      hostedBusy.delete(key);
    }
  };

  const generate = async (senderId: number, request: unknown): Promise<unknown> => {
    const requestId = requestIdOf(request);
    if (requestId === undefined) {
      throw new Error(`desktop bridge: ${LLAMA_PLUGIN.name}.${stream.start} requires a requestId.`);
    }
    const hosted = hostedUnitOf?.(senderId);
    if (hosted !== undefined) return generateHosted(senderId, request, hosted);

    const owner: Owner = { kind: 'window', id: senderId };
    const admission = broker.admit({
      owner,
      unitId: requestId,
      executor: LOCAL_EXECUTOR,
      start: (signal) => {
        // The broker decided this turn's end some other way. Stop the host's
        // work, so the host's own terminal is the one the page receives and
        // the slot is released only once it has actually stopped.
        signal.addEventListener(
          'abort',
          () => {
            void call(stream.cancel, senderId, { requestId }).catch(() => undefined);
          },
          { once: true },
        );
        return call(stream.start, senderId, request as GenerateOptions);
      },
    });
    if (!admission.admitted) throw codedError(REFUSED[admission.refusal], admission.refusal);

    const terminal = await admission.settled;
    if (terminal.end === 'COMPLETED') return terminal.value;
    if (terminal.end === 'FAILED') throw terminal.error;
    if (!terminal.started && terminal.end === 'CANCELLED') {
      const end = cancelledEnd(requestId);
      endOnce(senderId, end);
      return end;
    }
    const message = ENDED[terminal.end];
    if (!terminal.started && terminal.end !== 'OWNER_LOST') {
      endOnce(senderId, stream.synthesise(requestId, message) as GenerationEndEvent);
    }
    throw codedError(message, terminal.end);
  };

  const cancel = async (senderId: number, request: unknown): Promise<unknown> => {
    const requestId = requestIdOf(request);
    const owner: Owner = { kind: 'window', id: senderId };
    if (requestId !== undefined && (broker.positionOf(owner, requestId) ?? 0) > 0) {
      broker.cancel(owner, requestId);
      return undefined;
    }
    return call(stream.cancel, senderId, request);
  };

  let benchmarks = 0;
  const benchmark = async (senderId: number, request: unknown): Promise<unknown> => {
    benchmarks += 1;
    const admission = broker.admit({
      owner: { kind: 'window', id: senderId },
      // A benchmark has no requestId. Were a page ever to choose this same id
      // for a generation, one of the two is refused DUPLICATE_UNIT: never both
      // running.
      unitId: `benchmark ${String(benchmarks)}`,
      executor: LOCAL_EXECUTOR,
      wait: false,
      // Not sender-scoped below the wrapper: the facade takes the options alone.
      start: () => call(BENCHMARK, request),
    });
    if (!admission.admitted) throw codedError(REFUSED[admission.refusal], admission.refusal);
    const terminal = await admission.settled;
    if (terminal.end === 'COMPLETED') return terminal.value;
    if (terminal.end === 'FAILED') throw terminal.error;
    throw codedError(BENCHMARK_ENDED[terminal.end], terminal.end);
  };

  const implementation: Record<string | symbol, unknown> = {};
  for (const name of LLAMA_METHODS) {
    if (name === stream.start) implementation[name] = generate;
    else if (name === stream.cancel) implementation[name] = cancel;
    else if (name === BENCHMARK) implementation[name] = benchmark;
    else implementation[name] = (...args: unknown[]) => call(name, ...args);
  }
  // The benchmark is scoped HERE, for the slot's owner, and not below: the
  // facade's scoping is checked above to be exactly start and cancel.
  implementation[SENDER_SCOPED] = [stream.start, stream.cancel, BENCHMARK];

  return {
    plugin: implementation as unknown as PluginImplementation,
    releaseRenderer(senderId, reason) {
      broker.releaseWindow(senderId);
      notices.release(senderId);
      fleet.releaseRenderer(senderId, reason);
    },
  };
}

/**
 * The broker's `notifyWindow` for the desktop: waiting positions become
 * `llamaWaiting` events addressed at the one window that owns the turn.
 *
 * `position: 0` is sent when a turn that was told it was waiting starts, and
 * only then; a turn that started at once hears nothing from here. A terminal
 * is not re-sent: a desktop generation's terminal is its `llamaEnd` and its
 * `generate` promise. Prompts are not relayed to windows: a desktop turn
 * answers its prompts in its own page.
 *
 * What it remembers about a window, it forgets on `release`: the broker never
 * tells a window that went away how its units ended.
 */
export function localTurnNotices(notify: NotifyListeners): LocalTurnNotices {
  const waited = new Map<number, Set<string>>();
  const notifier = (windowId: number, notice: BrokerNotice): boolean => {
    switch (notice.kind) {
      case 'waiting': {
        const units = waited.get(windowId) ?? new Set<string>();
        units.add(notice.unitId);
        waited.set(windowId, units);
        notify(LLAMA_PLUGIN.name, TURN_WAITING_EVENT, { requestId: notice.unitId, position: notice.position }, windowId);
        return true;
      }
      case 'started':
        if (forget(windowId, notice.unitId)) {
          notify(LLAMA_PLUGIN.name, TURN_WAITING_EVENT, { requestId: notice.unitId, position: 0 }, windowId);
        }
        return true;
      case 'terminal':
        forget(windowId, notice.terminal.unitId);
        return true;
      case 'prompt':
        return false;
    }
  };
  function forget(windowId: number, unitId: string): boolean {
    const units = waited.get(windowId);
    if (units === undefined || !units.delete(unitId)) return false;
    if (units.size === 0) waited.delete(windowId);
    return true;
  }
  return Object.assign(notifier, {
    release(windowId: number): void {
      waited.delete(windowId);
    },
  });
}

/**
 * The fleet's `notify` for the desktop: a llama.cpp progress event is proof of
 * progress for its turn's broker unit as well as for the Supervisor. For a
 * worker window (`hostedUnitOf`), that unit is the one the worker runs.
 *
 * Without this the broker's idle deadline would be a cap on total generation
 * time, which is the defect the Supervisor's own deadline was written not to
 * have. The event is forwarded unchanged, and a throw from `notify` still
 * reaches the Supervisor (defect [13]).
 */
export function withTurnProgress(
  broker: WorkBroker,
  notify: NotifyListeners,
  hostedUnitOf?: HostedUnitOf,
): NotifyListeners {
  const progress = new Set(llamaStream().progress);
  return (pluginName, eventName, data, ownerId) => {
    if (pluginName === LLAMA_PLUGIN.name && ownerId !== undefined && progress.has(eventName)) {
      const requestId = requestIdOf(data);
      if (requestId !== undefined) {
        const hosted = hostedUnitOf?.(ownerId);
        if (hosted !== undefined) broker.progress(hosted.owner, hosted.unitId);
        else broker.progress({ kind: 'window', id: ownerId }, requestId);
      }
    }
    notify(pluginName, eventName, data, ownerId);
  };
}
