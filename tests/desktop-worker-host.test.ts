import { afterEach, describe, expect, it } from 'vitest';

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  DEFAULT_POLICY,
  HANDLE_LOST,
  HOST_TIMEOUT,
  LOCAL_EXECUTOR,
  PEER_TURN_ENGINE,
  PEER_TURN_EVENTS,
  PEER_TURN_IDLE_TIMEOUT_MS,
  PEER_TURN_METHODS,
  PEER_TURN_PLUGIN,
  PROMPT_ANSWER_TIMEOUT_MS,
  Supervisor,
  UNIT_DRAIN_TIMEOUT_MS,
  UNIT_IDLE_TIMEOUT_MS,
  WORKER_EXECUTOR,
  WORKER_IDLE_MS,
  WorkBroker,
  createHostRuntime,
  createWorkerHost,
} from '@chatterang/desktop/bridge';
import type {
  BrokerNotice,
  HostMessage,
  HostedUnitOf,
  MessageLink,
  SupervisorPolicy,
  SupervisorTimers,
  UnitTerminal,
  WorkerSpawn,
  WorkerTurnEnd,
} from '@chatterang/desktop/bridge';

/**
 * #7 RULING 1: A HIDDEN WORKER, SUPERVISED LIKE A HOST, BUILT ON DEMAND.
 *
 * `apps/desktop/src/bridge/worker-host.ts` runs a paired device's turn in a
 * worker that speaks the host envelope over a message port (the transport S1
 * measured in `tests/desktop-background-measurements.test.ts`). Everything
 * between the test and the worker here is production code: the real
 * `WorkerHost`, the real `Supervisor` it builds per life, the real
 * `WorkBroker`, and on the far side of a real `MessageChannel` the real
 * `HostRuntime` serving `PEER_TURN_PLUGIN`. Only the worker's turn runner is a
 * double, which the test drives, and the clock is the test's.
 *
 * No listener is started and no window is opened: `spawnWorker` returns a port
 * and a kill, which is the shape `main.ts` will give a hidden window (S5).
 */

/* ── A clock the test owns ────────────────────────────────────────────── */

interface ManualClock extends SupervisorTimers {
  /** Move the clock by `ms` in one step, fire what is due, then run every tick. */
  advance(ms: number): Promise<void>;
}

function manualClock(): ManualClock {
  let now = 0;
  const ticks = new Set<() => void>();
  const pending = new Set<{ at: number; fn: () => void }>();
  return {
    now: () => now,
    every: (_ms, fn) => {
      ticks.add(fn);
      return () => ticks.delete(fn);
    },
    after: (ms, fn) => {
      const entry = { at: now + ms, fn };
      pending.add(entry);
      return () => pending.delete(entry);
    },
    async advance(ms: number): Promise<void> {
      now += ms;
      for (const entry of [...pending]) {
        if (entry.at > now) continue;
        pending.delete(entry);
        entry.fn();
      }
      for (const fn of [...ticks]) {
        if (ticks.has(fn)) fn();
      }
      await new Promise((done) => setTimeout(done, 0));
    },
  };
}

/** Real time for messages on a real port to arrive. Used only for "nothing more arrived". */
const flush = async (): Promise<void> => {
  await new Promise((done) => setTimeout(done, 25));
};

/** Wait, in real time, for something a real port delivers. */
async function until(check: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((done) => setTimeout(done, 2));
  }
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const bytes = (value: string): Uint8Array => encoder.encode(value);
const text = (value: Uint8Array): string => decoder.decode(value);

/** A terminal as one string: the worker's own end frame, or the failure code. */
function endOf(end: WorkerTurnEnd | undefined): string {
  if (end === undefined) return '(no terminal)';
  return end.kind === 'ended' ? text(end.frame) : end.code;
}

/* ── The worker, on the far side of a real MessageChannel ─────────────── */

interface NodePort {
  on(event: 'message', listener: (message: unknown) => void): void;
  on(event: 'close', listener: () => void): void;
  postMessage(message: unknown): void;
  close(): void;
}

const openPorts: NodePort[] = [];
afterEach(() => {
  for (const port of openPorts.splice(0)) port.close();
});

function portLink(port: NodePort): MessageLink {
  return {
    postMessage: (message) => port.postMessage(message),
    onMessage: (listener) => port.on('message', listener),
    onClose: (listener) => port.on('close', () => listener('the message port closed')),
  };
}

interface FakeWorker {
  /** The webContents id main would give: real, positive, and the worker's alone. */
  readonly senderId: number;
  /** Turns it was asked to run, as the requestId the host minted and the turn's text. */
  readonly starts: { readonly requestId: string; readonly turn: string }[];
  readonly cancels: string[];
  /** End a cancelled turn with this frame. Null: ignore every cancel. */
  onCancel: string | null;
  killed: boolean;
  /** The broker's slot count at the moment it was killed. */
  slotAtKill: number | undefined;
  /** Main's end of its port saw the close. */
  closed: boolean;
  pingsPosted: number;
  pongsSeen: number;
  frame(requestId: string, value: string): void;
  end(requestId: string, value: string): void;
  /** Its end of the port goes away: a renderer that crashed. */
  crash(): void;
}

function fakeWorker(senderId: number, slotCount: () => number): { worker: FakeWorker; spawn: WorkerSpawn } {
  const { port1, port2 } = new MessageChannel();
  const near = port1 as unknown as NodePort;
  const far = port2 as unknown as NodePort;
  openPorts.push(near, far);

  const listeners = new Map<string, Set<(data: unknown) => void>>();
  const answers = new Map<string, (value: unknown) => void>();
  const emit = (name: string, data: unknown): void => {
    for (const listener of listeners.get(name) ?? []) listener(data);
  };

  const worker: FakeWorker = {
    senderId,
    starts: [],
    cancels: [],
    onCancel: null,
    killed: false,
    slotAtKill: undefined,
    closed: false,
    pingsPosted: 0,
    pongsSeen: 0,
    frame: (requestId, value) => emit('peerTurnFrame', { requestId, frame: bytes(value) }),
    end: (requestId, value) => {
      const payload = { requestId, frame: bytes(value) };
      emit('peerTurnEnd', payload);
      answers.get(requestId)?.(payload);
      answers.delete(requestId);
    },
    crash: () => far.close(),
  };

  // The worker's turn runner, as the host runtime serves it.
  const runner = {
    addListener: async (name: string, listener: (data: unknown) => void) => {
      const set = listeners.get(name) ?? new Set();
      set.add(listener);
      listeners.set(name, set);
      return { remove: async () => void set.delete(listener) };
    },
    peerTurnStart: (payload: { requestId: string; frame: Uint8Array }) =>
      new Promise<unknown>((answer) => {
        worker.starts.push({ requestId: payload.requestId, turn: text(payload.frame) });
        answers.set(payload.requestId, answer);
      }),
    peerTurnCancel: async (payload: { requestId: string }) => {
      worker.cancels.push(payload.requestId);
      if (worker.onCancel !== null && answers.has(payload.requestId)) worker.end(payload.requestId, worker.onCancel);
    },
  };
  createHostRuntime({ link: portLink(far) }).serve(PEER_TURN_PLUGIN, runner);

  near.on('close', () => {
    worker.closed = true;
  });
  const link: MessageLink = {
    postMessage: (message) => {
      if ((message as HostMessage).k === 'ping') worker.pingsPosted += 1;
      near.postMessage(message);
    },
    onMessage: (listener) =>
      near.on('message', (message) => {
        if ((message as HostMessage).k === 'pong') worker.pongsSeen += 1;
        listener(message);
      }),
    onClose: (listener) => near.on('close', () => listener('the message port closed')),
  };
  return {
    worker,
    spawn: {
      senderId,
      handle: {
        link,
        kill: () => {
          worker.slotAtKill ??= slotCount();
          worker.killed = true;
          far.close();
        },
      },
    },
  };
}

/* ── The rig ──────────────────────────────────────────────────────────── */

const PHONE = { kind: 'device', id: 'phone-1' } as const;
/** A visible window's webContents id. Never a worker's. */
const VISIBLE_WINDOW = 1;
const DAY_MS = 24 * 60 * 60 * 1000;

interface RigOptions {
  readonly policy?: Partial<SupervisorPolicy>;
  /** Wrap the spawn, to fail it or change what it returns. */
  readonly spawnWorker?: (next: () => WorkerSpawn) => WorkerSpawn;
}

interface RunningUnit {
  readonly controller: AbortController;
  readonly frames: string[];
  readonly ends: WorkerTurnEnd[];
  readonly done: Promise<WorkerTurnEnd>;
}

interface AdmittedUnit {
  readonly owner: typeof PHONE;
  readonly frames: string[];
  readonly ends: WorkerTurnEnd[];
  readonly settled: Promise<UnitTerminal>;
}

function rig(options: RigOptions = {}) {
  const clock = manualClock();
  const warnings: string[] = [];
  const workers: FakeWorker[] = [];
  const phoneNotices: BrokerNotice[] = [];
  let spawnCalls = 0;
  let condemn: (executor: string) => boolean = () => false;

  const broker = new WorkBroker({
    notifyWindow: () => true,
    condemnExecutor: (executor) => condemn(executor),
    timers: clock,
    warn: (message) => warnings.push(`broker: ${message}`),
  });
  broker.attachDevice(PHONE.id, {
    send: (notice) => {
      phoneNotices.push(notice);
      return true;
    },
    close: () => undefined,
  });

  const spawnOne = (): WorkerSpawn => {
    const made = fakeWorker(101 + workers.length, () => broker.slotCount);
    workers.push(made.worker);
    return made.spawn;
  };
  const host = createWorkerHost({
    spawnWorker: () => {
      spawnCalls += 1;
      return options.spawnWorker === undefined ? spawnOne() : options.spawnWorker(spawnOne);
    },
    broker,
    timers: clock,
    warn: (message) => warnings.push(message),
    ...(options.policy === undefined ? {} : { policy: options.policy }),
  });
  condemn = (executor) => host.condemn(executor);

  /** Every ping posted to a live worker has had its pong, so a big clock step is not a missed pong. */
  const quiet = (): Promise<void> =>
    until(
      () => workers.every((worker) => worker.closed || worker.killed || worker.pingsPosted === worker.pongsSeen),
      'every liveness ping answered',
    );

  return {
    host,
    broker,
    clock,
    warnings,
    workers,
    get spawnCalls(): number {
      return spawnCalls;
    },
    async advance(ms: number): Promise<void> {
      await clock.advance(ms);
      await quiet();
    },
    phoneTerminals(unitId: string): BrokerNotice[] {
      return phoneNotices.filter((notice) => notice.kind === 'terminal' && notice.terminal.unitId === unitId);
    },
    /** Wait until worker `index` has been asked to run `count` turns; the last one's requestId. */
    async started(index: number, count = 1): Promise<string> {
      await until(() => (workers[index]?.starts.length ?? 0) >= count, `worker ${String(index)} to start turn ${String(count)}`);
      return workers[index]?.starts[count - 1]?.requestId ?? '';
    },
    /** Run one unit on the host directly, outside the broker. */
    run(unitId: string, turn = `turn ${unitId}`): RunningUnit {
      const controller = new AbortController();
      const frames: string[] = [];
      const ends: WorkerTurnEnd[] = [];
      const done = host.run({ owner: PHONE, unitId }, bytes(turn), controller.signal, (frame) => frames.push(text(frame)));
      void done.then((end) => ends.push(end));
      return { controller, frames, ends, done };
    },
    /** Admit a phone's unit to the broker, whose work is a run on the host. */
    admitPhone(unitId: string, turn = `turn ${unitId}`): AdmittedUnit {
      const frames: string[] = [];
      const ends: WorkerTurnEnd[] = [];
      const admission = broker.admit({
        owner: PHONE,
        unitId,
        executor: WORKER_EXECUTOR,
        start: (signal) => {
          const run = host.run({ owner: PHONE, unitId }, bytes(turn), signal, (frame) => frames.push(text(frame)));
          void run.then((end) => ends.push(end));
          return run;
        },
      });
      if (!admission.admitted) throw new Error(`the unit was not admitted: ${admission.refusal}`);
      return { owner: PHONE, frames, ends, settled: admission.settled };
    },
  };
}

/* ══ The acceptance ═════════════════════════════════════════════════════ */

describe('BN4 WorkerHost: the hidden worker is built on demand (#7 ruling 1)', { timeout: 30_000 }, () => {
  it('1. spawnWorker is not called before the first run, however long the host sits idle', async () => {
    // FAULT INJECTED: building the first life in `createWorkerHost` called
    // spawnWorker at creation and failed the first assertion.
    const r = rig();
    expect(r.spawnCalls).toBe(0);
    await r.advance(10 * WORKER_IDLE_MS);
    expect(r.spawnCalls).toBe(0);

    const unit = r.run('first');
    expect(r.spawnCalls).toBe(1);
    const requestId = await r.started(0);
    expect(r.workers[0]?.starts[0]?.turn).toBe('turn first');
    r.workers[0]?.end(requestId, 'end first');
    expect(endOf(await unit.done)).toBe('end first');
  });
});

describe('BN4 WorkerHost: exactly one terminal per unit', { timeout: 30_000 }, () => {
  it('2a. completion: frames reach onFrame in order, the worker’s own end is the one terminal, and what it sends after that reaches nothing', async () => {
    // FAULT INJECTED: logging a frame's text where frames are routed failed on
    // the last assertion; answering `hostedUnitOf` after the terminal failed on
    // `hostedUnitOf`.
    const r = rig();
    const unit = r.admitPhone('t1', 'SECRET-TURN');
    const requestId = await r.started(0);
    const worker = r.workers[0]!;
    expect(worker.starts[0]?.turn).toBe('SECRET-TURN');

    worker.frame(requestId, 'SECRET-frame-1');
    worker.frame(requestId, 'SECRET-frame-2');
    await until(() => unit.frames.length === 2, 'two frames');
    worker.end(requestId, 'SECRET-end');

    const terminal = await unit.settled;
    expect(terminal.end).toBe('COMPLETED');
    expect(endOf(terminal.value as WorkerTurnEnd)).toBe('SECRET-end');

    // A late frame and a second end, from a worker that misbehaves.
    worker.frame(requestId, 'late');
    worker.end(requestId, 'a second end');
    await flush();
    expect(unit.frames).toEqual(['SECRET-frame-1', 'SECRET-frame-2']);
    expect(unit.ends.map(endOf)).toEqual(['SECRET-end']);
    expect(r.phoneTerminals('t1')).toHaveLength(1);
    expect(r.broker.slotCount).toBe(0);
    expect(r.host.hostedUnitOf(worker.senderId)).toBeUndefined();
    // Never a payload in a log line.
    expect(r.warnings.join('\n')).not.toContain('SECRET');
  });

  it('2b. port close mid-unit is loss: one HANDLE_LOST terminal, the broker ends the unit WORKER_LOST at once, and the next unit gets a new worker', async () => {
    // FAULT INJECTED: not calling `broker.workerLost` on a loss let the unit
    // end COMPLETED from its run's HANDLE_LOST terminal, and failed on
    // `WORKER_LOST`; retiring a life without dropping it built no worker for
    // `t2` and failed on `spawnCalls`.
    const r = rig();
    const unit = r.admitPhone('t1');
    const requestId = await r.started(0);
    const worker = r.workers[0]!;
    worker.frame(requestId, 'partial');
    await until(() => unit.frames.length === 1, 'one frame');

    worker.crash();
    const terminal = await unit.settled;
    expect(terminal.end).toBe('WORKER_LOST');
    await until(() => unit.ends.length === 1, 'the run to end');
    expect(unit.ends[0]).toMatchObject({ kind: 'failed', code: HANDLE_LOST });
    expect(r.broker.slotCount).toBe(0);
    expect(r.host.hostedUnitOf(worker.senderId)).toBeUndefined();

    worker.frame(requestId, 'from a closed port');
    await flush();
    expect(unit.frames).toEqual(['partial']);
    expect(unit.ends).toHaveLength(1);
    expect(r.phoneTerminals('t1')).toHaveLength(1);

    const next = r.admitPhone('t2');
    expect(r.spawnCalls).toBe(2);
    const nextId = await r.started(1);
    r.workers[1]?.end(nextId, 'end t2');
    expect((await next.settled).end).toBe('COMPLETED');
  });

  it('2c. abort: the worker is asked to cancel exactly once, and its own cancelled end is the one terminal', async () => {
    const r = rig();
    const unit = r.run('t1');
    const requestId = await r.started(0);
    const worker = r.workers[0]!;
    worker.onCancel = 'cancelled end';

    unit.controller.abort();
    unit.controller.abort();
    expect(endOf(await unit.done)).toBe('cancelled end');
    await flush();
    expect(worker.cancels).toEqual([requestId]);
    expect(unit.ends).toHaveLength(1);
    expect(r.host.hostedUnitOf(worker.senderId)).toBeUndefined();
  });

  it('2d. an idle retire racing a new run: a run just before it keeps the worker and restarts the idle clock; a run just after it gets a new worker the old one’s late close cannot touch', async () => {
    // FAULT INJECTED: not cancelling the idle deadline when a unit starts (and
    // not replacing it when the next one is armed) retired the worker 1 ms
    // after `t2` ended and failed on `killed`; retiring without dropping the
    // life built no new worker for `t3` and failed on `spawnCalls`.
    const r = rig();
    const first = r.run('t1');
    r.workers[0]?.end(await r.started(0), 'end t1');
    expect(endOf(await first.done)).toBe('end t1');

    // Just before the retire: the same worker takes the next unit.
    await r.advance(WORKER_IDLE_MS - 1);
    expect(r.workers[0]?.killed).toBe(false);
    const second = r.run('t2');
    expect(r.spawnCalls).toBe(1);
    r.workers[0]?.end(await r.started(0, 2), 'end t2');
    expect(endOf(await second.done)).toBe('end t2');

    // The first unit's idle deadline passes 1 ms after the second unit ended.
    await r.advance(1);
    expect(r.workers[0]?.killed).toBe(false);
    await r.advance(WORKER_IDLE_MS - 2);
    expect(r.workers[0]?.killed).toBe(false);

    // WORKER_IDLE_MS after the second unit's end, the retire fires, and a run
    // arrives in the same turn of the event loop, before the old port's close.
    const retiring = r.clock.advance(1);
    const third = r.run('t3');
    await retiring;
    expect(r.workers[0]?.killed).toBe(true);
    expect(r.spawnCalls).toBe(2);
    const thirdId = await r.started(1);
    await until(() => r.workers[0]?.closed === true, 'the retired worker’s port to close');
    await flush();
    expect(third.ends).toEqual([]);
    expect(r.host.hostedUnitOf(r.workers[1]!.senderId)).toEqual({ owner: PHONE, unitId: 't3' });
    expect(r.host.hostedUnitOf(r.workers[0]!.senderId)).toBeUndefined();

    r.workers[1]?.end(thirdId, 'end t3');
    expect(endOf(await third.done)).toBe('end t3');
    await flush();
    expect(third.ends).toHaveLength(1);
  });
});

describe('BN4 WorkerHost: a restart budget across lives', { timeout: 30_000 }, () => {
  it('3. an idle retire does not count against the restart budget; a loss does', async () => {
    // FAULT INJECTED: counting a retire as a loss refused the third unit and
    // failed on `spawnCalls`; resetting the budget per life spawned a seventh
    // worker for `refused`.
    const r = rig({ policy: { maxRestarts: 1, restartWindowMs: DAY_MS } });
    for (let index = 0; index < 4; index += 1) {
      const unit = r.run(`idle-${String(index)}`);
      expect(r.spawnCalls).toBe(index + 1);
      r.workers[index]?.end(await r.started(index), `end ${String(index)}`);
      expect(endOf(await unit.done)).toBe(`end ${String(index)}`);
      await r.advance(WORKER_IDLE_MS);
      expect(r.workers[index]?.killed).toBe(true);
    }

    // maxRestarts 1: the first loss is restarted from, the second is not.
    const lostOnce = r.run('lost-1');
    await r.started(4);
    r.workers[4]?.crash();
    expect(await lostOnce.done).toMatchObject({ kind: 'failed', code: HANDLE_LOST });
    const lostTwice = r.run('lost-2');
    expect(r.spawnCalls).toBe(6);
    await r.started(5);
    r.workers[5]?.crash();
    expect(await lostTwice.done).toMatchObject({ kind: 'failed', code: HANDLE_LOST });

    const refused = r.run('refused');
    expect(r.spawnCalls).toBe(6);
    expect(await refused.done).toMatchObject({ kind: 'failed', code: 'WORKER_CRASH_LOOP' });
  });

  it('4. a crash loop across lives stops at the cap, and a later run is refused WORKER_CRASH_LOOP without spawning, however much later', async () => {
    // FAULT INJECTED: resetting the budget when a life is built spawned a
    // fifth worker for `after-the-cap` and failed on `spawnCalls`.
    const maxRestarts = 3;
    const r = rig({ policy: { maxRestarts } });
    for (let life = 0; life <= maxRestarts; life += 1) {
      const unit = r.run(`crash-${String(life)}`, 'SECRET-TURN');
      expect(r.spawnCalls).toBe(life + 1);
      await r.started(life);
      r.workers[life]?.crash();
      expect(await unit.done).toMatchObject({ kind: 'failed', code: HANDLE_LOST });
      // Past the Supervisor's own restart delay: no Supervisor respawns a worker itself.
      await r.advance(DEFAULT_POLICY.restartDelayMs + 1);
      expect(r.spawnCalls).toBe(life + 1);
    }

    const refused = r.run('after-the-cap');
    expect(r.spawnCalls).toBe(maxRestarts + 1);
    expect(await refused.done).toMatchObject({ kind: 'failed', code: 'WORKER_CRASH_LOOP' });

    await r.advance(2 * DEFAULT_POLICY.restartWindowMs);
    const later = r.run('much-later');
    expect(r.spawnCalls).toBe(maxRestarts + 1);
    expect(await later.done).toMatchObject({ kind: 'failed', code: 'WORKER_CRASH_LOOP' });
    expect(r.warnings.filter((warning) => /crash-looping/.test(warning))).toHaveLength(1);
    expect(r.warnings.join('\n')).not.toContain('SECRET');
  });

  it('a worker that cannot be spawned, or that names no real webContents id, fails its unit WORKER_SPAWN_FAILED, is not leaked, and counts as a loss', async () => {
    let mode: 'throw' | 'bad-id' | 'ok' = 'throw';
    const r = rig({
      policy: { maxRestarts: 2, restartWindowMs: DAY_MS },
      spawnWorker: (next) => {
        if (mode === 'throw') throw new Error('SECRET-SPAWN-DETAIL');
        const made = next();
        return mode === 'bad-id' ? { ...made, senderId: 0 } : made;
      },
    });
    expect(await r.run('a').done).toMatchObject({ kind: 'failed', code: 'WORKER_SPAWN_FAILED' });
    mode = 'bad-id';
    expect(await r.run('b').done).toMatchObject({ kind: 'failed', code: 'WORKER_SPAWN_FAILED' });
    expect(r.workers[0]?.killed).toBe(true);

    // Two losses against maxRestarts 2: one more life, and its loss is the cap.
    mode = 'ok';
    const c = r.run('c');
    await r.started(1);
    r.workers[1]?.crash();
    expect(await c.done).toMatchObject({ kind: 'failed', code: HANDLE_LOST });
    const d = r.run('d');
    expect(r.spawnCalls).toBe(3);
    expect(await d.done).toMatchObject({ kind: 'failed', code: 'WORKER_CRASH_LOOP' });
    expect(r.warnings.join('\n')).not.toContain('SECRET');
  });
});

describe('BN4 WorkerHost: condemned by a real WorkBroker', { timeout: 30_000 }, () => {
  it('5. work that ignores its abort is condemned at the drain deadline: killed while the slot is held, the slot frees only then, the phone unit behind runs on a new worker, and workerLost("worker") leaves a running llama unit untouched', async () => {
    // FAULT INJECTED: `condemn` returning true before killing failed on
    // `killed`; `condemn` also calling `broker.workerLost` itself (re-entering
    // the broker, which then calls it again) ended `behind` WORKER_LOST on its
    // new worker and failed on `isRunning`.
    const r = rig();
    const stuck = r.admitPhone('stuck');
    const stuckId = await r.started(0);
    const worker = r.workers[0]!;
    worker.frame(stuckId, 'one frame, then silence');
    await until(() => stuck.frames.length === 1, 'the frame');

    const behind = r.admitPhone('behind');
    let localStarts = 0;
    let finishLocal: (value: unknown) => void = () => undefined;
    const LOCAL = { kind: 'window', id: VISIBLE_WINDOW } as const;
    const local = r.broker.admit({
      owner: LOCAL,
      unitId: 'local',
      executor: LOCAL_EXECUTOR,
      start: () => {
        localStarts += 1;
        return new Promise((done) => {
          finishLocal = done;
        });
      },
    });
    expect(local).toMatchObject({ admitted: true, position: 2 });

    await r.advance(UNIT_IDLE_TIMEOUT_MS);
    expect((await stuck.settled).end).toBe('DEADLINE');
    await until(() => worker.cancels.length === 1, 'the cancel to reach the worker');
    expect(worker.cancels).toEqual([stuckId]);
    expect(worker.killed).toBe(false);

    await r.advance(UNIT_DRAIN_TIMEOUT_MS - 1);
    expect(worker.killed).toBe(false);
    expect(r.broker.slotCount).toBe(1);
    expect(r.spawnCalls).toBe(1);

    await r.advance(1);
    expect(worker.killed).toBe(true);
    expect(worker.slotAtKill).toBe(1);
    await until(() => stuck.ends.length === 1, 'the stuck run to end');
    expect(stuck.ends[0]).toMatchObject({ kind: 'failed', code: 'WORKER_CONDEMNED' });

    // The unit behind took the slot, on a new worker.
    expect(r.spawnCalls).toBe(2);
    const behindId = await r.started(1);
    expect(r.workers[1]?.starts[0]?.turn).toBe('turn behind');
    expect(r.broker.isRunning(PHONE, 'behind')).toBe(true);
    expect(r.host.hostedUnitOf(r.workers[1]!.senderId)).toEqual({ owner: PHONE, unitId: 'behind' });
    expect(r.host.hostedUnitOf(worker.senderId)).toBeUndefined();
    await flush();
    expect(r.broker.isRunning(PHONE, 'behind')).toBe(true);

    r.workers[1]?.end(behindId, 'end behind');
    expect((await behind.settled).end).toBe('COMPLETED');

    // The llama unit runs now. A worker loss ends only worker units.
    await until(() => localStarts === 1, 'the local unit to start');
    r.broker.workerLost(WORKER_EXECUTOR);
    expect(r.broker.isRunning(LOCAL, 'local')).toBe(true);
    finishLocal('local done');
    if (local.admitted) expect((await local.settled).end).toBe('COMPLETED');
    expect(stuck.ends).toHaveLength(1);
    expect(r.phoneTerminals('stuck')).toHaveLength(1);
  });

  it('5b. condemn names only the worker: a stuck llama unit draining is no reason to kill it, and that slot stays held', async () => {
    // FAULT INJECTED: dropping the executor check in `condemn` killed the
    // worker for the llama unit and freed the slot.
    const r = rig();
    const outside = r.run('outside');
    const outsideId = await r.started(0);
    const LOCAL = { kind: 'window', id: VISIBLE_WINDOW } as const;
    const stuck = r.broker.admit({
      owner: LOCAL,
      unitId: 'stuck-llama',
      executor: LOCAL_EXECUTOR,
      start: () => new Promise(() => undefined),
    });
    expect(stuck.admitted).toBe(true);

    await r.advance(UNIT_IDLE_TIMEOUT_MS);
    await r.advance(UNIT_DRAIN_TIMEOUT_MS);
    await r.advance(UNIT_DRAIN_TIMEOUT_MS);
    expect(r.host.condemn(LOCAL_EXECUTOR)).toBe(false);
    expect(r.workers[0]?.killed).toBe(false);
    expect(r.broker.slotCount).toBe(1);
    expect(r.host.hostedUnitOf(r.workers[0]!.senderId)).toEqual({ owner: PHONE, unitId: 'outside' });

    r.workers[0]?.end(outsideId, 'end outside');
    expect(endOf(await outside.done)).toBe('end outside');
  });

  it('5c. a worker whose kill throws is not confirmed dead: condemn answers false and the slot stays held until the work returns', async () => {
    // FAULT INJECTED: answering true when the kill threw freed the slot.
    const r = rig({
      spawnWorker: (next) => {
        const made = next();
        return {
          senderId: made.senderId,
          handle: {
            link: made.handle.link,
            kill: () => {
              throw new Error('SECRET-KILL-DETAIL');
            },
          },
        };
      },
    });
    const stuck = r.admitPhone('stuck');
    const stuckId = await r.started(0);
    const behind = r.admitPhone('behind');

    await r.advance(UNIT_IDLE_TIMEOUT_MS);
    await r.advance(UNIT_DRAIN_TIMEOUT_MS);
    expect(r.broker.slotCount).toBe(1);
    expect(r.spawnCalls).toBe(1);
    expect(r.host.condemn(WORKER_EXECUTOR)).toBe(false);
    expect(r.warnings.join('\n')).not.toContain('SECRET');

    // The work returns at last: now the slot frees, and the unit behind runs.
    r.workers[0]?.end(stuckId, 'far too late');
    await until(() => stuck.ends.length === 1, 'the stuck run to end');
    await until(() => r.broker.isRunning(PHONE, 'behind'), 'the unit behind to run');
    expect((await stuck.settled).end).toBe('DEADLINE');
    r.workers[0]?.end(await r.started(0, 2), 'end behind');
    expect((await behind.settled).end).toBe('COMPLETED');
  });
});

describe('BN4 WorkerHost: hostedUnitOf, for admitLocalTurns', { timeout: 30_000 }, () => {
  it('6. answers { owner, unitId } only for the worker’s own sender id and only while its unit runs: undefined before start, for a visible window, and after the terminal', async () => {
    // FAULT INJECTED: answering after the terminal failed the last assertion;
    // answering for any sender failed on VISIBLE_WINDOW.
    const r = rig();
    const typed: HostedUnitOf = r.host.hostedUnitOf;
    expect(typed(101)).toBeUndefined();
    expect(typed(VISIBLE_WINDOW)).toBeUndefined();

    const unit = r.admitPhone('t1');
    const worker = r.workers[0]!;
    expect(typed(worker.senderId)).toEqual({ owner: PHONE, unitId: 't1' });
    expect(typed(VISIBLE_WINDOW)).toBeUndefined();
    expect(typed(worker.senderId + 1)).toBeUndefined();

    worker.end(await r.started(0), 'done');
    expect((await unit.settled).end).toBe('COMPLETED');
    expect(worker.killed).toBe(false);
    expect(typed(worker.senderId)).toBeUndefined();
  });
});

describe('BN4 WorkerHost: the rest of what it promises', { timeout: 30_000 }, () => {
  it('a worker’s frames are progress for its broker unit: a unit that keeps streaming is not ended DEADLINE', async () => {
    // FAULT INJECTED: not reporting frames to `broker.progress` ended `long`
    // DEADLINE at UNIT_IDLE_TIMEOUT_MS and failed on `isRunning`.
    const r = rig();
    const unit = r.admitPhone('long');
    const requestId = await r.started(0);
    const worker = r.workers[0]!;
    let sent = 0;
    for (let elapsed = 0; elapsed <= 2 * UNIT_IDLE_TIMEOUT_MS; elapsed += 100_000) {
      await r.advance(100_000);
      expect(r.broker.isRunning(PHONE, 'long')).toBe(true);
      worker.frame(requestId, `frame ${String(sent)}`);
      sent += 1;
      await until(() => unit.frames.length === sent, 'the frame');
    }
    expect(r.broker.isRunning(PHONE, 'long')).toBe(true);
    worker.end(requestId, 'end');
    expect((await unit.settled).end).toBe('COMPLETED');
  });

  it('a worker silent past PEER_TURN_IDLE_TIMEOUT_MS is stopped before its unit ends HOST_TIMEOUT, so a run never ends while its worker may still be working', async () => {
    // FAULT INJECTED: settling HOST_TIMEOUT without ending the life left the
    // worker running and failed on `killed`.
    const r = rig();
    const unit = r.run('silent');
    await r.started(0);
    await r.advance(PEER_TURN_IDLE_TIMEOUT_MS - 1);
    expect(unit.ends).toEqual([]);
    await r.advance(DEFAULT_POLICY.tickMs);
    await until(() => unit.ends.length === 1, 'the run to end');
    expect(unit.ends[0]).toMatchObject({ kind: 'failed', code: HOST_TIMEOUT });
    expect(r.workers[0]?.killed).toBe(true);
  });

  it('runs one unit at a time; a pre-aborted run, a run beside another, and a run after dispose build no worker', async () => {
    const r = rig();
    const aborted = new AbortController();
    aborted.abort();
    expect(await r.host.run({ owner: PHONE, unitId: 'pre' }, bytes('x'), aborted.signal, () => undefined)).toMatchObject({
      kind: 'failed',
      code: 'ABORTED',
    });
    expect(r.spawnCalls).toBe(0);

    const first = r.run('first');
    expect(await r.run('second').done).toMatchObject({ kind: 'failed', code: 'WORKER_BUSY' });
    expect(r.spawnCalls).toBe(1);
    const requestId = await r.started(0);
    await flush();
    expect(r.workers[0]?.starts).toHaveLength(1);
    expect(r.host.hostedUnitOf(r.workers[0]!.senderId)).toEqual({ owner: PHONE, unitId: 'first' });
    r.workers[0]?.end(requestId, 'end first');
    expect(endOf(await first.done)).toBe('end first');

    r.host.dispose();
    expect(r.workers[0]?.killed).toBe(true);
    expect(await r.run('after').done).toMatchObject({ kind: 'failed', code: 'WORKER_DISPOSED' });
    expect(r.spawnCalls).toBe(1);
  });

  it('PeerTurn passes the Supervisor’s name check, and its deadline is longer than every broker deadline that can end its unit', () => {
    // FAULT INJECTED: dropping `idleTimeoutMs` from PEER_TURN_ENGINE failed here
    // (and 5b, 5c and the HOST_TIMEOUT test); naming an undeclared terminal in
    // PEER_TURN_STREAM made the Supervisor refuse the engine and failed every
    // test here except the main.ts control.
    expect(PEER_TURN_PLUGIN).toEqual({
      name: 'PeerTurn',
      methods: ['peerTurnStart', 'peerTurnCancel'],
      events: ['peerTurnFrame', 'peerTurnEnd'],
    });
    expect(PEER_TURN_METHODS).toEqual(PEER_TURN_PLUGIN.methods);
    expect(PEER_TURN_EVENTS).toEqual(PEER_TURN_PLUGIN.events);
    expect(PEER_TURN_ENGINE.definition).toBe(PEER_TURN_PLUGIN);
    expect(PEER_TURN_ENGINE.stream).toMatchObject({
      start: 'peerTurnStart',
      cancel: 'peerTurnCancel',
      terminal: 'peerTurnEnd',
      progress: ['peerTurnFrame'],
      idleTimeoutMs: PEER_TURN_IDLE_TIMEOUT_MS,
    });
    const supervisor = new Supervisor({
      spawn: () => ({
        link: { postMessage: () => undefined, onMessage: () => undefined, onClose: () => undefined },
        kill: () => undefined,
      }),
      notify: () => undefined,
      engines: [PEER_TURN_ENGINE],
      timers: manualClock(),
    });
    expect(supervisor.engines).toEqual(['PeerTurn']);
    supervisor.dispose();

    // The broker decides a phone unit's end: its idle deadline, a relayed
    // prompt's wait and the drain all fit inside the peer turn's own deadline.
    expect(PEER_TURN_IDLE_TIMEOUT_MS).toBeGreaterThan(
      UNIT_IDLE_TIMEOUT_MS + PROMPT_ANSWER_TIMEOUT_MS + UNIT_DRAIN_TIMEOUT_MS,
    );
    expect(WORKER_EXECUTOR).toBe('worker');
    expect(WORKER_EXECUTOR).not.toBe(LOCAL_EXECUTOR);
    expect(WORKER_IDLE_MS).toBeGreaterThan(0);
  });

  it('control: main.ts builds no Supervisor and offers PeerTurn to no renderer (this unit does not touch main.ts)', () => {
    const source = readFileSync(resolve(process.cwd(), 'apps/desktop/src/main.ts'), 'utf8');
    expect(source).not.toMatch(/new Supervisor\(/);
    expect(source).not.toMatch(/register\(PEER_TURN_PLUGIN/);
  });
});
