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
 *   - A `generate` that carries `wholeTurn: true` is one decode of a turn that
 *     keeps the slot until the page ends it (see below). Its first decode is
 *     admitted as above; its later decodes run under the same unit.
 *   - `endTurn` is the page saying that turn is over, however it ended.
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
 * A DESKTOP TURN HOLDS THE SLOT FOR THE WHOLE TURN (owner ruling on #7). A
 * renderer's turn is a loop in `src/ai/engine.ts`: decode, tool call, decode,
 * with local approval sheets between. The ruling is that it keeps the slot from
 * its first decode until the turn settles (finished, failed, stopped, or
 * refused), tool calls included, and that a phone turn waits for the whole of
 * it: #169's "one turn at a time" is one turn, not one decode. Rejected:
 * admitting per decode, and a hold that gives the slot up after a long tool
 * call. Main sees only generates, so the page says which decodes are one turn:
 *
 *   - every decode of its streamed turn carries `wholeTurn: true` and the
 *     turn's one `requestId`. The flag is main's: it is taken off before the
 *     options reach the facade;
 *   - the first is admitted, waits and is told it waits like any generate. The
 *     unit's work is the whole turn, so the slot stays held when that decode
 *     returns, and the broker's idle deadline stops between decodes
 *     (`WorkBroker.betweenSteps`): a tool call reports no progress;
 *   - a later decode runs under that unit at once: no admission, no place in
 *     line, nothing said about waiting. One decode at a time;
 *   - `endTurn` ends the turn. A decode still running is cancelled in the host,
 *     and the slot is given back once it has returned. A first decode still
 *     waiting never starts;
 *   - if the broker ends the unit first (a suspend, a quit, its backstop
 *     deadline, the window going away), a decode running is cancelled in the
 *     host and its `generate` rejects with the broker's reason, and a later
 *     decode of that turn is refused with it and never reaches the host.
 *
 * A decode that FAILS does not end the turn: the page decides whether the turn
 * goes on (the engine may answer the error, or run on elsewhere), and it ends
 * it either way. What bounds a turn that never ends is its window: every turn
 * a window holds is released with it, a reload included (`did-start-navigation`
 * tears it down in `main.ts`). A generate without the flag is one decode, as
 * before: the non-streamed path sends none.
 *
 * A TURN ITS WINDOW'S TEARDOWN ENDED STAYS ENDED. A reload's teardown runs on
 * `did-start-navigation`, and the old document keeps running until the new one
 * commits, so that document's next decode can still reach main after the
 * teardown. Its turn was ended `OWNER_LOST`, and the page that would end it is
 * about to be replaced. Admitted as a new turn, that decode would keep the slot
 * between steps with no page left to end it, and every later turn would wait
 * behind it until the window went away again. So the window keeps the
 * requestIds its teardown ended, and a later decode of one of them is refused
 * `OWNER_LOST` and never reaches the host. The page's `endTurn` for that turn
 * removes the requestId. A page replaced before it could send one leaves its
 * requestId behind: one string per turn, kept for as long as main runs.
 *
 * A WORKER'S GENERATIONS RUN UNDER THE UNIT IT RUNS. Ruling 1 puts a phone's
 * turn in a hidden worker window (S5), whose engine calls `LlamaCpp.generate`
 * through this same plugin. That unit already holds the slot; admitting its
 * generate as a second unit would queue it behind itself for ever. So
 * `hostedUnitOf` names, for a window that is a worker, the unit it runs: its
 * `generate` goes straight to the host while that unit is running, one at a
 * time, and is refused otherwise; and its tokens are progress for that unit.
 * Its `wholeTurn` flag and its `endTurn` change nothing: the phone's unit is
 * the worker's work to end. Main passes no `hostedUnitOf` until S5 creates a
 * worker, so today every window is a user's.
 *
 * EXACTLY ONE `llamaEnd` PER DECODE, STILL:
 *
 *   - A decode that STARTED gets its terminal from the Supervisor, whichever
 *     way it ends. If the broker ends it (a suspend, a quit, the broker's
 *     backstop deadline), the wrapper cancels it in the host through the
 *     facade, and the host's end is the one delivered. The `generate` promise,
 *     which is the page's authority (`supervisor.ts`), rejects with the
 *     broker's reason.
 *   - A turn that NEVER STARTED gets one synthesised `llamaEnd` from here,
 *     unless its window is gone. That matches `Supervisor.releaseRenderer`: no
 *     page, nothing delivered.
 *   - A turn the broker REFUSES gets no `llamaEnd`, the same as a generate the
 *     Supervisor refuses before starting it (a duplicate requestId, a closed
 *     host). So does a worker's generate refused for not running its unit, and
 *     a later decode refused because its turn is over.
 *
 * WHY `llamaWaiting` IS NOT IN `LLAMA_EVENTS`, AND `endTurn` NOT IN
 * `LLAMA_METHODS`. The llama host is served with `LLAMA_PLUGIN`, and the
 * Supervisor drops any event that definition does not declare. So the host
 * cannot emit a waiting state it does not own, and the host protocol has no
 * turn to end. Only main, registering `LOCAL_TURNS_PLUGIN`, lets a window
 * subscribe to the one and call the other. A platform that registers the plain
 * definition, such as the headless server, refuses both, and the renderer
 * treats that as "never waits here" and "nothing held here".
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
import type { AdmitRefusal, BrokerNotice, Owner, UnitEnd, UnitTerminal, WorkBroker } from './work-broker.js';

/** The event that tells a window its generation is waiting, and where it is. */
export const TURN_WAITING_EVENT = 'llamaWaiting';

/** The method a page ends a whole turn with. */
export const TURN_END_METHOD = 'endTurn';

/** The `generate` option that marks one decode of a turn that holds the slot until `endTurn`. */
export const WHOLE_TURN_OPTION = 'wholeTurn';

/** The executor name the desktop's generations run on, for `WorkBroker.workerLost`. */
export const LOCAL_EXECUTOR = 'llama';

/** The one non-streamed llama method that decodes, and so takes the slot. */
const BENCHMARK = 'benchmark';

/**
 * What main registers for `LlamaCpp`: the llama definition plus the waiting
 * event and the turn's end. Both are main's own; the host protocol
 * (`LLAMA_PLUGIN`) has neither, so a host can neither emit the one nor be sent
 * the other.
 */
export const LOCAL_TURNS_PLUGIN: PluginDefinition = Object.freeze({
  name: LLAMA_PLUGIN.name,
  methods: Object.freeze([...LLAMA_METHODS, TURN_END_METHOD]),
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
   * can never start for a page that is gone and a turn it held gives the slot
   * back, and then the fleet releases what it was running. A whole turn it
   * held stays ended: a later decode of that turn is refused `OWNER_LOST`.
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

/** A turn the broker has already ended, or one its page already ended. */
const TURN_OVER = 'desktop bridge: this turn is over, so it may not generate again.';

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

/** Whether a page's `generate` is one decode of a whole turn. */
function isWholeTurn(options: unknown): boolean {
  return (options as Record<string, unknown> | null | undefined)?.[WHOLE_TURN_OPTION] === true;
}

/** The page's options as the host takes them: without the flag, which is main's. */
function forHost(options: unknown): unknown {
  if (typeof options !== 'object' || options === null || !(WHOLE_TURN_OPTION in options)) return options;
  const { [WHOLE_TURN_OPTION]: _flag, ...rest } = options as Record<string, unknown>;
  return rest;
}

/** A turn whose decodes share one broker unit, from its first decode until it ends. */
interface WholeTurn {
  readonly senderId: number;
  readonly requestId: string;
  /** The unit took the slot. */
  started: boolean;
  /** The decode running under the unit, if one is. */
  decoding: Promise<unknown> | null;
  /** The turn is over: its page ended it, or the broker decided the unit's end. */
  ending: boolean;
  /** The broker decided the unit's end (its signal aborted). */
  aborted: boolean;
  /** The unit's terminal, once decided. */
  readonly settled: Promise<UnitTerminal>;
  /** Report the unit's work done. Called once the turn is over and nothing decodes. */
  finish(): void;
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

  /** A unit that never started: what its page is told, as for any generate that never reached the host. */
  const neverStarted = (senderId: number, requestId: string, terminal: UnitTerminal): GenerationEndEvent => {
    /* c8 ignore next 3 */
    if (terminal.end === 'COMPLETED' || terminal.end === 'FAILED') {
      throw codedError(TURN_OVER, 'NOT_RUNNING');
    }
    if (terminal.end === 'CANCELLED') {
      const end = cancelledEnd(requestId);
      endOnce(senderId, end);
      return end;
    }
    const message = ENDED[terminal.end];
    if (terminal.end !== 'OWNER_LOST') {
      endOnce(senderId, stream.synthesise(requestId, message) as GenerationEndEvent);
    }
    throw codedError(message, terminal.end);
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

  /** Whole turns by window and requestId, from their first decode until their page ends them. */
  const wholeTurns = new Map<string, WholeTurn>();
  const turnKey = (senderId: number, requestId: string): string => `${String(senderId)} ${requestId}`;

  /**
   * By window, the requestIds of the whole turns its teardown ended that its
   * page has not ended since. A reload's old document can still ask to decode
   * one of them, and none may start again.
   */
  const endedByTeardown = new Map<number, Set<string>>();
  const forgetEndedByTeardown = (senderId: number, requestId: string): void => {
    const ended = endedByTeardown.get(senderId);
    if (ended === undefined) return;
    ended.delete(requestId);
    if (ended.size === 0) endedByTeardown.delete(senderId);
  };

  /** One decode under a whole turn's unit. */
  const decodeUnder = async (turn: WholeTurn, request: unknown): Promise<unknown> => {
    const owner: Owner = { kind: 'window', id: turn.senderId };
    const decoding = call(stream.start, turn.senderId, request as GenerateOptions);
    turn.decoding = decoding;
    let value: unknown;
    let failure: { error: unknown } | null = null;
    try {
      value = await decoding;
    } catch (error) {
      failure = { error };
    }
    turn.decoding = null;
    const endedByBroker = turn.aborted;
    // The turn is over and nothing decodes: the slot can be given back. If
    // not, the page is between two decodes, running a tool call or waiting on
    // a sheet, and the unit keeps the slot with its idle deadline stopped.
    if (turn.ending) turn.finish();
    else broker.betweenSteps(owner, turn.requestId);
    if (endedByBroker) {
      const { end } = await turn.settled;
      /* c8 ignore next */
      if (end === 'COMPLETED' || end === 'FAILED') throw codedError(TURN_OVER, 'NOT_RUNNING');
      throw codedError(ENDED[end], end);
    }
    if (failure !== null) throw failure.error;
    return value;
  };

  /** A decode of a whole turn: its first admits the turn's unit, and every later one runs under it. */
  const generateInTurn = async (senderId: number, requestId: string, request: unknown): Promise<unknown> => {
    const owner: Owner = { kind: 'window', id: senderId };
    const key = turnKey(senderId, requestId);
    const held = wholeTurns.get(key);

    if (endedByTeardown.get(senderId)?.has(requestId) === true) {
      // Its window's teardown ended this turn: a reload whose old document is
      // still running. Admitted again, it would hold the slot for a page that
      // can no longer end it.
      throw codedError(ENDED.OWNER_LOST, 'OWNER_LOST');
    }

    if (held !== undefined) {
      // One decode at a time, and none while the first still waits.
      if (held.decoding !== null || (!held.started && broker.positionOf(owner, requestId) !== undefined)) {
        throw codedError(REFUSED.DUPLICATE_UNIT, 'DUPLICATE_UNIT');
      }
      if (!broker.isRunning(owner, requestId)) {
        // The broker ended this turn between its decodes. The turn is over:
        // this decode never starts, and is refused with the reason.
        const { end } = await held.settled;
        /* c8 ignore next */
        if (end === 'COMPLETED' || end === 'FAILED') throw codedError(TURN_OVER, 'NOT_RUNNING');
        throw codedError(ENDED[end], end);
      }
      // The next step of the turn starts: its idle deadline counts again.
      broker.progress(owner, requestId);
      return decodeUnder(held, request);
    }

    let finishWork: () => void = () => undefined;
    const work = new Promise<void>((done) => {
      finishWork = done;
    });
    let reportSettled: (terminal: UnitTerminal) => void = () => undefined;
    const turn: WholeTurn = {
      senderId,
      requestId,
      started: false,
      decoding: null,
      ending: false,
      aborted: false,
      settled: new Promise<UnitTerminal>((done) => {
        reportSettled = done;
      }),
      finish: () => finishWork(),
    };
    let first: Promise<unknown> = Promise.resolve();
    let reportStarted: () => void = () => undefined;
    const began = new Promise<void>((done) => {
      reportStarted = done;
    });
    const admission = broker.admit({
      owner,
      unitId: requestId,
      executor: LOCAL_EXECUTOR,
      start: (signal) => {
        turn.started = true;
        reportStarted();
        // The broker decided this turn's end some other way. A decode running
        // is stopped in the host, so the host's own terminal is the one the
        // page receives and the slot is given back only once it has stopped.
        signal.addEventListener(
          'abort',
          () => {
            turn.ending = true;
            turn.aborted = true;
            if (turn.decoding !== null) void call(stream.cancel, senderId, { requestId }).catch(() => undefined);
            else turn.finish();
          },
          { once: true },
        );
        first = decodeUnder(turn, request);
        void first.catch(() => undefined);
        // The whole turn is the unit's work: it returns when the turn is over.
        return work;
      },
    });
    if (!admission.admitted) throw codedError(REFUSED[admission.refusal], admission.refusal);
    void admission.settled.then(reportSettled);
    wholeTurns.set(key, turn);

    // Waiting: until the unit takes the slot, or ends without having taken it.
    if (!turn.started) await Promise.race([began, admission.settled]);
    return turn.started ? first : neverStarted(senderId, requestId, await admission.settled);
  };

  const generate = async (senderId: number, request: unknown): Promise<unknown> => {
    const requestId = requestIdOf(request);
    if (requestId === undefined) {
      throw new Error(`desktop bridge: ${LLAMA_PLUGIN.name}.${stream.start} requires a requestId.`);
    }
    const wholeTurn = isWholeTurn(request);
    const options = forHost(request);
    const hosted = hostedUnitOf?.(senderId);
    if (hosted !== undefined) return generateHosted(senderId, options, hosted);
    if (wholeTurn) return generateInTurn(senderId, requestId, options);

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
        return call(stream.start, senderId, options as GenerateOptions);
      },
    });
    if (!admission.admitted) throw codedError(REFUSED[admission.refusal], admission.refusal);

    const terminal = await admission.settled;
    if (terminal.end === 'COMPLETED') return terminal.value;
    if (terminal.end === 'FAILED') throw terminal.error;
    if (!terminal.started) return neverStarted(senderId, requestId, terminal);
    throw codedError(ENDED[terminal.end], terminal.end);
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

  /**
   * The page's turn is over, however it ended. Nothing held for this window
   * under this requestId (a turn never decoded here, one already ended, another
   * window's, a worker's) is nothing to end.
   */
  const endTurn = async (senderId: number, request: unknown): Promise<unknown> => {
    const requestId = requestIdOf(request);
    if (requestId === undefined) {
      throw new Error(`desktop bridge: ${LLAMA_PLUGIN.name}.${TURN_END_METHOD} requires a requestId.`);
    }
    // A worker's generates run under its phone unit and open no whole turn, so
    // its page's end finds nothing here: the phone's unit is its work's to end.
    const key = turnKey(senderId, requestId);
    const turn = wholeTurns.get(key);
    if (turn === undefined) {
      // A turn its window's teardown ended: its page has ended it too.
      forgetEndedByTeardown(senderId, requestId);
      return undefined;
    }
    wholeTurns.delete(key);
    if (!turn.started) {
      // Still waiting for the slot, or ended before it took it: it never starts.
      broker.cancel({ kind: 'window', id: senderId }, requestId);
      return undefined;
    }
    if (turn.ending) return undefined;
    turn.ending = true;
    if (turn.decoding !== null) void call(stream.cancel, senderId, { requestId }).catch(() => undefined);
    else turn.finish();
    return undefined;
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
  implementation[TURN_END_METHOD] = endTurn;
  // The benchmark and the turn's end are scoped HERE, for the slot's owner, and
  // not below: the facade's scoping is checked above to be exactly start and
  // cancel, and the facade has no turn to end.
  implementation[SENDER_SCOPED] = [stream.start, stream.cancel, BENCHMARK, TURN_END_METHOD];

  return {
    plugin: implementation as unknown as PluginImplementation,
    releaseRenderer(senderId, reason) {
      broker.releaseWindow(senderId);
      for (const [key, turn] of wholeTurns) {
        if (turn.senderId !== senderId) continue;
        wholeTurns.delete(key);
        const ended = endedByTeardown.get(senderId) ?? new Set<string>();
        ended.add(turn.requestId);
        endedByTeardown.set(senderId, ended);
      }
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
