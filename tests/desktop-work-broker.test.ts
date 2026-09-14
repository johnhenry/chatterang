import { describe, expect, it } from 'vitest';

import {
  BROKER_TICK_MS,
  DEFAULT_POLICY,
  MAX_CONCURRENT_TURNS,
  MAX_WAITING_PER_DEVICE,
  MAX_WAITING_PER_WINDOW,
  MAX_WAITING_TOTAL,
  PROMPT_ANSWER_TIMEOUT_MS,
  RETAIN_RESULT_COUNT,
  RETAIN_RESULT_MS,
  UNIT_IDLE_TIMEOUT_MS,
  WorkBroker,
} from '@chatterang/desktop/bridge';
import type {
  AdmitResult,
  BrokerNotice,
  ChannelCloseReason,
  Owner,
  OwnerChannel,
  SupervisorTimers,
  UnitEnd,
  UnitTerminal,
} from '@chatterang/desktop/bridge';

/**
 * THE WORK BROKER, DRIVEN WITH A CLOCK THE TEST OWNS.
 *
 * `apps/desktop/src/bridge/work-broker.ts` is #7's S2: one generation slot
 * shared by the desktop's own turns and a paired phone's, one wait list, held
 * results for a phone whose socket dropped, relayed prompts that expire, and
 * one idempotent settle over four paths. It is platform-free and every timer
 * is injected, so everything here is exact: nothing fires unless a test moves
 * the clock, and when it does, it moves it by a named constant.
 *
 * EVERY GUARANTEE BELOW WAS RUN AGAINST A DELIBERATELY BROKEN BUILD. Where a
 * test guards a line, the comment says what was changed and what failed.
 */

/* ── Doubles ──────────────────────────────────────────────────────────── */

interface ManualClock extends SupervisorTimers {
  /** Move the clock forward in one step, then run one tick. */
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
      // The broker's tick is deadline-driven, so one run after a jump is the
      // same as one every BROKER_TICK_MS across it.
      for (const fn of [...ticks]) fn();
      await flush();
    },
  };
}

const flush = async (): Promise<void> => {
  await new Promise((done) => setTimeout(done, 0));
};

/** Work the test finishes by hand. */
interface Work {
  readonly start: (signal: AbortSignal) => Promise<unknown>;
  resolve(value: unknown): void;
  reject(error: unknown): void;
  /** How many times the broker started it. Never more than once. */
  readonly starts: number;
  readonly signal: AbortSignal | null;
}

function work(): Work {
  let resolve: (value: unknown) => void = () => undefined;
  let reject: (error: unknown) => void = () => undefined;
  let starts = 0;
  let signal: AbortSignal | null = null;
  return {
    start: (given) => {
      starts += 1;
      signal = given;
      return new Promise((done, fail) => {
        resolve = done;
        reject = fail;
      });
    },
    resolve: (value) => resolve(value),
    reject: (error) => reject(error),
    get starts() {
      return starts;
    },
    get signal() {
      return signal;
    },
  };
}

interface Channel extends OwnerChannel {
  readonly sent: BrokerNotice[];
  readonly closed: ChannelCloseReason[];
}

function channel(): Channel {
  const sent: BrokerNotice[] = [];
  const closed: ChannelCloseReason[] = [];
  return {
    sent,
    closed,
    send: (notice) => {
      if (closed.length > 0) return false;
      sent.push(notice);
      return true;
    },
    close: (reason) => {
      closed.push(reason);
    },
  };
}

interface Rig {
  readonly broker: WorkBroker;
  readonly clock: ManualClock;
  readonly warnings: string[];
  /** Everything each window was told, in order. */
  inbox(windowId: number): BrokerNotice[];
  /** Admit, and fail the test on a refusal. */
  run(owner: Owner, unitId: string, job: Work, executor?: string): Promise<UnitTerminal> & { position: number };
}

function rig(): Rig {
  const clock = manualClock();
  const warnings: string[] = [];
  const windows = new Map<number, BrokerNotice[]>();
  const broker = new WorkBroker({
    notifyWindow: (windowId, notice) => {
      const list = windows.get(windowId) ?? [];
      list.push(notice);
      windows.set(windowId, list);
      return true;
    },
    timers: clock,
    warn: (message) => warnings.push(message),
  });
  return {
    broker,
    clock,
    warnings,
    inbox: (windowId) => windows.get(windowId) ?? [],
    run: (owner, unitId, job, executor = 'llama') => {
      const result = broker.admit({ owner, unitId, executor, start: job.start });
      const ok = admitted(result);
      return Object.assign(ok.settled, { position: ok.position });
    },
  };
}

function admitted(result: AdmitResult): Extract<AdmitResult, { admitted: true }> {
  if (!result.admitted) throw new Error(`expected admission, got ${result.refusal}`);
  return result;
}

const device = (id: string): Owner => ({ kind: 'device', id });
const win = (id: number): Owner => ({ kind: 'window', id });

const terminalsIn = (notices: readonly BrokerNotice[], unitId: string): UnitTerminal[] =>
  notices.flatMap((notice) =>
    notice.kind === 'terminal' && notice.terminal.unitId === unitId ? [notice.terminal] : [],
  );

/** A settled flag that does not wait. */
function watch(settled: Promise<UnitTerminal>): { readonly done: boolean; readonly end: UnitEnd | undefined } {
  const state: { done: boolean; end: UnitEnd | undefined } = { done: false, end: undefined };
  void settled.then((terminal) => {
    state.done = true;
    state.end = terminal.end;
  });
  return state;
}

/**
 * Drive every OTHER way a unit can end, after it already has.
 *
 * The exactly-once assertion is only worth something if the later paths
 * actually run: a report arriving late, a rejection, the executor dying, the
 * owner leaving, the deadline passing, a suspend and a quit.
 */
async function everyOtherPath(r: Rig, owner: Owner, job: Work): Promise<void> {
  job.resolve('late result');
  job.reject(new Error('late failure'));
  await flush();
  r.broker.workerLost('llama');
  r.broker.workerLost('worker');
  if (owner.kind === 'window') r.broker.releaseWindow(owner.id);
  await r.clock.advance(UNIT_IDLE_TIMEOUT_MS + 1);
  r.broker.suspend();
  r.broker.resume();
  r.broker.quit();
  r.broker.quit();
  await flush();
}

/* ══ The limits ═════════════════════════════════════════════════════════ */

describe('the limits are named constants, and these are their values', () => {
  it('pins every value, so a change to one is a change someone has to make on purpose', () => {
    expect({
      MAX_CONCURRENT_TURNS,
      MAX_WAITING_PER_DEVICE,
      MAX_WAITING_PER_WINDOW,
      MAX_WAITING_TOTAL,
      PROMPT_ANSWER_TIMEOUT_MS,
      RETAIN_RESULT_MS,
      RETAIN_RESULT_COUNT,
      UNIT_IDLE_TIMEOUT_MS,
      BROKER_TICK_MS,
    }).toEqual({
      MAX_CONCURRENT_TURNS: 1,
      MAX_WAITING_PER_DEVICE: 3,
      MAX_WAITING_PER_WINDOW: 2,
      MAX_WAITING_TOTAL: 8,
      PROMPT_ANSWER_TIMEOUT_MS: 60_000,
      RETAIN_RESULT_MS: 300_000,
      RETAIN_RESULT_COUNT: 8,
      UNIT_IDLE_TIMEOUT_MS: 150_000,
      BROKER_TICK_MS: 1_000,
    });
  });

  it('the broker’s idle deadline is a backstop BEHIND the Supervisor’s, not a race with it', () => {
    // For a desktop generation the Supervisor's deadline is the one that can
    // cancel inside the host and synthesise the terminal the page expects. If
    // the broker's fired first, the page would see the broker's end instead.
    expect(UNIT_IDLE_TIMEOUT_MS).toBeGreaterThan(
      DEFAULT_POLICY.generateIdleTimeoutMs + DEFAULT_POLICY.tickMs + BROKER_TICK_MS,
    );
  });
});

describe('every limit is enforced, not merely documented', () => {
  it(`MAX_CONCURRENT_TURNS: never more than ${String(MAX_CONCURRENT_TURNS)} unit's work running, whoever asks`, async () => {
    // FAULT INJECTED: `this.#slot.size < MAX_CONCURRENT_TURNS` changed to
    // `<=` in both `admit` and `#pump` started the second job at once, and
    // this test failed on `starts` for `b`.
    const r = rig();
    const a = work();
    const b = work();
    const c = work();
    expect(r.run(win(1), 'a', a).position).toBe(0);
    expect(r.run(device('phone'), 'b', b).position).toBe(1);
    expect(r.run(win(2), 'c', c).position).toBe(2);
    expect([a.starts, b.starts, c.starts]).toEqual([1, 0, 0]);
    expect(r.broker.slotCount).toBe(MAX_CONCURRENT_TURNS);

    a.resolve('done');
    await flush();
    expect([a.starts, b.starts, c.starts]).toEqual([1, 1, 0]);
    expect(r.broker.slotCount).toBe(MAX_CONCURRENT_TURNS);

    b.resolve('done');
    await flush();
    expect([a.starts, b.starts, c.starts]).toEqual([1, 1, 1]);
  });

  it('the slot is released when the work STOPS, not when its end is decided', async () => {
    // A deadline decides the end at once. If the slot were freed then, the
    // next turn would start decoding on the same sequence as a turn that has
    // been told to stop and has not yet stopped (measured: nothing below the
    // bridge serialises two turns on one handle).
    // FAULT INJECTED: calling `#returned(unit)` from `#settle` for a running
    // unit started `next` in the same tick as the deadline.
    const r = rig();
    const slow = work();
    const next = work();
    const slowEnd = r.run(win(1), 'slow', slow);
    r.run(win(2), 'next', next);

    await r.clock.advance(UNIT_IDLE_TIMEOUT_MS);
    expect((await slowEnd).end).toBe('DEADLINE');
    expect(slow.signal?.aborted).toBe(true);
    expect(next.starts).toBe(0);
    expect(r.broker.slotCount).toBe(1);

    slow.resolve('stopped at last');
    await flush();
    expect(next.starts).toBe(1);
  });

  it(`MAX_WAITING_PER_DEVICE: a phone may have ${String(MAX_WAITING_PER_DEVICE)} units waiting, and no more`, async () => {
    // FAULT INJECTED: removing the `OWNER_WAIT_LIST_FULL` return admitted the
    // fourth unit at position 4.
    const r = rig();
    r.run(win(1), 'blocker', work());
    for (let i = 0; i < MAX_WAITING_PER_DEVICE; i += 1) r.run(device('p'), `p${String(i)}`, work());
    expect(r.broker.admit({ owner: device('p'), unitId: 'one-too-many', executor: 'llama', start: work().start })).toEqual({
      admitted: false,
      refusal: 'OWNER_WAIT_LIST_FULL',
    });
    // Per device: another phone still gets a place.
    expect(r.run(device('q'), 'q0', work()).position).toBe(MAX_WAITING_PER_DEVICE + 1);
  });

  it(`MAX_WAITING_PER_WINDOW: a window may have ${String(MAX_WAITING_PER_WINDOW)} units waiting, and no more`, () => {
    const r = rig();
    r.run(device('p'), 'blocker', work());
    for (let i = 0; i < MAX_WAITING_PER_WINDOW; i += 1) r.run(win(7), `w${String(i)}`, work());
    expect(r.broker.admit({ owner: win(7), unitId: 'one-too-many', executor: 'llama', start: work().start })).toEqual({
      admitted: false,
      refusal: 'OWNER_WAIT_LIST_FULL',
    });
    expect(r.run(win(8), 'w-other', work()).position).toBe(MAX_WAITING_PER_WINDOW + 1);
  });

  it(`MAX_WAITING_TOTAL: ${String(MAX_WAITING_TOTAL)} units waiting in all, across every owner`, () => {
    // FAULT INJECTED: removing the `WAIT_LIST_FULL` return admitted the ninth.
    const r = rig();
    r.run(win(1), 'blocker', work());
    let admittedCount = 0;
    for (let d = 0; admittedCount < MAX_WAITING_TOTAL; d += 1) {
      for (let i = 0; i < MAX_WAITING_PER_DEVICE && admittedCount < MAX_WAITING_TOTAL; i += 1) {
        r.run(device(`d${String(d)}`), `u${String(i)}`, work());
        admittedCount += 1;
      }
    }
    expect(r.broker.waitingCount).toBe(MAX_WAITING_TOTAL);
    expect(r.broker.admit({ owner: device('fresh'), unitId: 'u', executor: 'llama', start: work().start })).toEqual({
      admitted: false,
      refusal: 'WAIT_LIST_FULL',
    });
    expect(r.broker.admit({ owner: win(99), unitId: 'u', executor: 'llama', start: work().start })).toEqual({
      admitted: false,
      refusal: 'WAIT_LIST_FULL',
    });
  });

  it('PROMPT_ANSWER_TIMEOUT_MS: an unanswered prompt is refused at its deadline, as not sent, and a late answer is refused too', async () => {
    // FAULT INJECTED: removing the prompt check from `#tick` left `outcome`
    // null at the deadline, and the idle-deadline test below, which awaits the
    // refusal, timed out.
    const r = rig();
    const phone = channel();
    r.broker.attachDevice('p', phone);
    const job = work();
    const settled = watch(r.run(device('p'), 'turn', job));

    let outcome: unknown = null;
    void r.broker.requestPrompt(device('p'), 'turn', { tool: 'bash' }).then((result) => {
      outcome = result;
    });
    const prompt = phone.sent.find((notice) => notice.kind === 'prompt');
    expect(prompt).toMatchObject({ kind: 'prompt', unitId: 'turn', prompt: { tool: 'bash' } });

    await r.clock.advance(PROMPT_ANSWER_TIMEOUT_MS - 1);
    expect(outcome).toBeNull();
    await r.clock.advance(1);
    expect(outcome).toEqual({ answered: false, refusal: 'PROMPT_TIMEOUT', notSent: true });

    const promptId = (prompt as { promptId: string }).promptId;
    expect(r.broker.answerPrompt(device('p'), 'turn', promptId, true)).toBe(false);
    // A refused prompt refuses the CALL, not the turn.
    expect(settled.done).toBe(false);
    expect(r.broker.positionOf(device('p'), 'turn')).toBe(0);
  });

  it('UNIT_IDLE_TIMEOUT_MS: progress resets it, a pending prompt pauses it, an answer restarts it', async () => {
    // FAULT INJECTED: making `progress` a no-op ended the unit at the second
    // advance with DEADLINE.
    const r = rig();
    r.broker.attachDevice('p', channel());
    const job = work();
    const settled = watch(r.run(device('p'), 'turn', job));

    await r.clock.advance(UNIT_IDLE_TIMEOUT_MS - 1);
    r.broker.progress(device('p'), 'turn');
    await r.clock.advance(UNIT_IDLE_TIMEOUT_MS - 1);
    expect(settled.done).toBe(false);

    // Prompt pending: the person reading is not a wedge.
    const outcome = r.broker.requestPrompt(device('p'), 'turn', 'confirm?');
    await r.clock.advance(PROMPT_ANSWER_TIMEOUT_MS - 1);
    expect(settled.done).toBe(false);
    await r.clock.advance(1);
    expect((await outcome).answered).toBe(false);

    // The refusal restarts the idle deadline from now.
    await r.clock.advance(UNIT_IDLE_TIMEOUT_MS - 1);
    expect(settled.done).toBe(false);
    await r.clock.advance(1);
    await flush();
    expect(settled.end).toBe('DEADLINE');
  });

  it('RETAIN_RESULT_MS: a held result is gone at its limit, and an attach after that replays nothing', async () => {
    // FAULT INJECTED: removing the expiry filter from `#tick` kept the result
    // and the late attach replayed it.
    const r = rig();
    const job = work();
    r.run(device('p'), 'turn', job);
    job.resolve('the reply');
    await flush();
    expect(r.broker.heldFor('p')).toEqual(['turn']);

    await r.clock.advance(RETAIN_RESULT_MS - 1);
    expect(r.broker.heldFor('p')).toEqual(['turn']);
    await r.clock.advance(1);
    expect(r.broker.heldFor('p')).toEqual([]);

    const late = channel();
    r.broker.attachDevice('p', late);
    expect(terminalsIn(late.sent, 'turn')).toEqual([]);
  });

  it(`RETAIN_RESULT_COUNT: at most ${String(RETAIN_RESULT_COUNT)} results are held, and the oldest goes first`, async () => {
    // FAULT INJECTED: removing the eviction loop from `#hold` held nine.
    const r = rig();
    for (let i = 0; i <= RETAIN_RESULT_COUNT; i += 1) {
      const job = work();
      r.run(device(`d${String(i)}`), 'turn', job);
      job.resolve(`reply ${String(i)}`);
      await flush();
    }
    expect(r.broker.heldCount).toBe(RETAIN_RESULT_COUNT);
    expect(r.broker.heldFor('d0')).toEqual([]);
    expect(r.broker.heldFor(`d${String(RETAIN_RESULT_COUNT)}`)).toEqual(['turn']);
    expect(r.warnings.some((warning) => warning.includes('RETAIN_RESULT_COUNT'))).toBe(true);
  });
});

/* ══ Exactly once ═══════════════════════════════════════════════════════ */

describe('one settle: exactly one terminal per unit, on every path', () => {
  // FAULT INJECTED for the whole block: deleting `if (unit.terminal !== null)
  // return;` from `#settle` failed the four tests whose end is decided BEFORE
  // the work returns (worker loss, both owner losses, the deadline), each on a
  // second terminal or a held result produced by the late report in
  // `everyOtherPath`. The two path-1 tests did not fail, and are not meant to:
  // a report removes the unit from every table, so nothing that runs later can
  // reach it. They drive every other path anyway, to show that.

  it('path 1, the terminal report: a result', async () => {
    const r = rig();
    const job = work();
    const settled = r.run(win(1), 'u', job);
    job.resolve({ text: 'hello' });
    const terminal = await settled;
    expect(terminal).toMatchObject({ end: 'COMPLETED', started: true, value: { text: 'hello' } });

    await everyOtherPath(r, win(1), job);
    expect(terminalsIn(r.inbox(1), 'u')).toHaveLength(1);
  });

  it('path 1, the terminal report: a failure, kept as thrown so its code survives', async () => {
    const r = rig();
    const phone = channel();
    r.broker.attachDevice('p', phone);
    const job = work();
    const settled = r.run(device('p'), 'u', job);
    const error = Object.assign(new Error('the host went away'), { code: 'HANDLE_LOST' });
    job.reject(error);
    const terminal = await settled;
    expect(terminal.end).toBe('FAILED');
    expect(terminal.error).toBe(error);

    await everyOtherPath(r, device('p'), job);
    expect(terminalsIn(phone.sent, 'u')).toHaveLength(1);
  });

  it('path 2, worker loss: ends the unit and frees the slot at once, for that executor only', async () => {
    const r = rig();
    const job = work();
    const next = work();
    const settled = r.run(win(1), 'u', job, 'worker');
    r.run(win(2), 'next', next, 'llama');

    const state = watch(settled);
    r.broker.workerLost('some-other-executor');
    await flush();
    expect(state.done).toBe(false);

    r.broker.workerLost('worker');
    expect((await settled).end).toBe('WORKER_LOST');
    // Released now: the work is gone, not merely slow.
    expect(next.starts).toBe(1);

    await everyOtherPath(r, win(1), job);
    expect(terminalsIn(r.inbox(1), 'u')).toHaveLength(1);
  });

  it('path 3, owner loss (a window): running and waiting units end OWNER_LOST, and the page is told nothing', async () => {
    const r = rig();
    const job = work();
    const waiting = work();
    const running = r.run(win(1), 'u', job);
    const queued = r.run(win(1), 'v', waiting);

    r.broker.releaseWindow(1);
    expect((await running).end).toBe('OWNER_LOST');
    expect((await queued).end).toBe('OWNER_LOST');
    expect(waiting.starts).toBe(0);
    expect(job.signal?.aborted).toBe(true);

    await everyOtherPath(r, win(1), job);
    expect(terminalsIn(r.inbox(1), 'u')).toEqual([]);
    expect(terminalsIn(r.inbox(1), 'v')).toEqual([]);
  });

  it('path 3, owner loss (a revoked device): everything ends, everything held is purged, the socket is closed, and it stays refused', async () => {
    // FAULT INJECTED: removing the `#held` filter from `revokeDevice` left the
    // earlier result held for a revoked device.
    const r = rig();
    const earlier = work();
    r.run(device('p'), 'earlier', earlier);
    earlier.resolve('an answer the phone never collected');
    await flush();
    expect(r.broker.heldFor('p')).toEqual(['earlier']);

    const phone = channel();
    r.broker.attachDevice('p', phone);
    const job = work();
    const waiting = work();
    const running = r.run(device('p'), 'u', job);
    const queued = r.run(device('p'), 'v', waiting);
    const sentBefore = phone.sent.length;

    r.broker.revokeDevice('p');
    expect((await running).end).toBe('OWNER_REVOKED');
    expect((await queued).end).toBe('OWNER_REVOKED');
    expect(r.broker.heldFor('p')).toEqual([]);
    expect(phone.closed).toEqual(['OWNER_REVOKED']);
    expect(phone.sent.slice(sentBefore).filter((notice) => notice.kind === 'terminal')).toEqual([]);

    expect(r.broker.admit({ owner: device('p'), unitId: 'again', executor: 'llama', start: work().start })).toEqual({
      admitted: false,
      refusal: 'OWNER_REVOKED',
    });
    expect(r.broker.attachDevice('p', channel())).toBe(false);

    // The work finishing after revocation holds nothing and sends nothing.
    job.resolve('too late');
    await flush();
    expect(r.broker.heldFor('p')).toEqual([]);
    await everyOtherPath(r, device('p'), job);
    expect(terminalsIn(phone.sent, 'u')).toEqual([]);
  });

  it('path 4, the deadline: ends once, and the report that arrives afterwards changes nothing', async () => {
    const r = rig();
    const job = work();
    const settled = r.run(win(1), 'u', job);
    await r.clock.advance(UNIT_IDLE_TIMEOUT_MS);
    const terminal = await settled;
    expect(terminal.end).toBe('DEADLINE');
    expect(job.signal?.aborted).toBe(true);

    await everyOtherPath(r, win(1), job);
    expect(terminalsIn(r.inbox(1), 'u')).toEqual([terminal]);
  });

  it('a cancel from the owner ends a waiting unit; a cancel naming someone else’s unit does nothing', async () => {
    const r = rig();
    r.run(win(1), 'blocker', work());
    const job = work();
    const settled = watch(r.run(win(2), 'u', job));

    r.broker.cancel(win(3), 'u');
    r.broker.cancel(device('2'), 'u');
    await flush();
    expect(settled.done).toBe(false);

    r.broker.cancel(win(2), 'u');
    await flush();
    expect(settled.end).toBe('CANCELLED');
    expect(job.starts).toBe(0);
    expect(terminalsIn(r.inbox(2), 'u')).toHaveLength(1);
  });

  it('a cancel of a RUNNING unit aborts its work and lets the work report', async () => {
    const r = rig();
    const job = work();
    const settled = r.run(win(1), 'u', job);
    r.broker.cancel(win(1), 'u');
    expect(job.signal?.aborted).toBe(true);
    job.resolve({ stopReason: 'cancelled' });
    expect(await settled).toMatchObject({ end: 'COMPLETED', value: { stopReason: 'cancelled' } });
  });

  it('work whose start throws synchronously is a FAILED report, not a stuck slot', async () => {
    const r = rig();
    const next = work();
    const settled = r.broker.admit({
      owner: win(1),
      unitId: 'u',
      executor: 'llama',
      start: () => {
        throw new Error('could not start');
      },
    });
    r.run(win(2), 'next', next);
    expect((await admitted(settled).settled).end).toBe('FAILED');
    await flush();
    expect(next.starts).toBe(1);
  });
});

/* ══ Ruling 4: a dropped socket holds the result ════════════════════════ */

describe('a dropped phone socket does not end the turn: the result is held until attach and ack', () => {
  it('a drop mid-turn settles nothing; the result is held, replayed on attach, and purged on ack', async () => {
    // FAULT INJECTED: settling the device's units `OWNER_LOST` in
    // `detachDevice` ended the turn at the drop, and `settled.done` was true.
    const r = rig();
    const first = channel();
    r.broker.attachDevice('p', first);
    const job = work();
    const settledPromise = r.run(device('p'), 'turn', job);
    const settled = watch(settledPromise);

    r.broker.detachDevice('p', first);
    await flush();
    expect(settled.done).toBe(false);
    expect(r.broker.positionOf(device('p'), 'turn')).toBe(0);
    expect(job.signal?.aborted).toBe(false);

    // The desktop finishes the turn.
    job.resolve({ text: 'the whole reply' });
    expect((await settledPromise).end).toBe('COMPLETED');
    expect(r.broker.heldFor('p')).toEqual(['turn']);
    expect(terminalsIn(first.sent, 'turn')).toEqual([]);

    // The phone comes back and collects it.
    const second = channel();
    expect(r.broker.attachDevice('p', second)).toBe(true);
    expect(terminalsIn(second.sent, 'turn')).toEqual([
      expect.objectContaining({ end: 'COMPLETED', value: { text: 'the whole reply' } }),
    ]);
    expect(r.broker.ack('p', 'turn')).toBe(true);
    expect(r.broker.heldFor('p')).toEqual([]);
    expect(r.broker.ack('p', 'turn')).toBe(false);

    const third = channel();
    r.broker.attachDevice('p', third);
    expect(terminalsIn(third.sent, 'turn')).toEqual([]);
  });

  it('a result delivered live is still held until acknowledged, because the frame may never have arrived', async () => {
    const r = rig();
    const live = channel();
    r.broker.attachDevice('p', live);
    const job = work();
    const settled = r.run(device('p'), 'turn', job);
    job.resolve('reply');
    await settled;
    expect(terminalsIn(live.sent, 'turn')).toHaveLength(1);
    expect(r.broker.heldFor('p')).toEqual(['turn']);

    r.broker.detachDevice('p', live);
    const again = channel();
    r.broker.attachDevice('p', again);
    expect(terminalsIn(again.sent, 'turn')).toHaveLength(1);
  });

  it('a waiting unit keeps its place through a drop, runs while detached, and a new socket is told where things stand', async () => {
    const r = rig();
    const blocker = work();
    r.run(win(1), 'blocker', blocker);
    const first = channel();
    r.broker.attachDevice('p', first);
    const job = work();
    r.run(device('p'), 'turn', job);
    expect(first.sent).toEqual([{ kind: 'waiting', unitId: 'turn', position: 1 }]);

    r.broker.detachDevice('p', first);
    blocker.resolve('done');
    await flush();
    expect(job.starts).toBe(1);

    const second = channel();
    r.broker.attachDevice('p', second);
    expect(second.sent).toEqual([{ kind: 'started', unitId: 'turn' }]);
  });

  it('a device’s new socket REPLACES its stale one, and the stale one’s late close cannot detach the new one', async () => {
    // FAULT INJECTED, two ways, each failing this test. Keeping the first
    // channel when one is already attached (`if (stale === undefined)
    // this.#channels.set(...)`) kept routing to the closed socket, so the
    // prompt was refused; dropping the identity check from `detachDevice` let
    // the corpse's close detach its replacement, with the same result.
    const r = rig();
    const stale = channel();
    const fresh = channel();
    r.broker.attachDevice('p', stale);
    r.run(device('p'), 'turn', work());

    r.broker.attachDevice('p', fresh);
    expect(stale.closed).toEqual(['SOCKET_REPLACED']);

    // The corpse's close arrives after its replacement connected.
    r.broker.detachDevice('p', stale);

    let outcome: unknown = null;
    void r.broker.requestPrompt(device('p'), 'turn', 'send this?').then((result) => {
      outcome = result;
    });
    await flush();
    expect(outcome).toBeNull();
    expect(fresh.sent.some((notice) => notice.kind === 'prompt')).toBe(true);
    expect(stale.sent.some((notice) => notice.kind === 'prompt')).toBe(false);
  });

  it('a prompt is refused, as not sent, when the socket drops, when no socket is attached, and when the unit ends', async () => {
    const r = rig();
    const phone = channel();
    r.broker.attachDevice('p', phone);
    const job = work();
    r.run(device('p'), 'turn', job);

    const dropped = r.broker.requestPrompt(device('p'), 'turn', 'one');
    r.broker.detachDevice('p', phone);
    expect(await dropped).toEqual({ answered: false, refusal: 'OWNER_DETACHED', notSent: true });

    expect(await r.broker.requestPrompt(device('p'), 'turn', 'two')).toEqual({
      answered: false,
      refusal: 'OWNER_DETACHED',
      notSent: true,
    });

    const again = channel();
    r.broker.attachDevice('p', again);
    const pending = r.broker.requestPrompt(device('p'), 'turn', 'three');
    expect(await r.broker.requestPrompt(device('p'), 'turn', 'four')).toMatchObject({ refusal: 'PROMPT_PENDING' });
    r.broker.suspend();
    expect(await pending).toEqual({ answered: false, refusal: 'UNIT_SETTLED', notSent: true });
  });

  it('only the owner can answer, and only the prompt that is waiting', async () => {
    const r = rig();
    const phone = channel();
    r.broker.attachDevice('p', phone);
    r.run(device('p'), 'turn', work());
    const outcome = r.broker.requestPrompt(device('p'), 'turn', 'allow?');
    const { promptId } = phone.sent.find((notice) => notice.kind === 'prompt') as { promptId: string };

    expect(r.broker.answerPrompt(device('someone-else'), 'turn', promptId, true)).toBe(false);
    expect(r.broker.answerPrompt(device('p'), 'turn', 'a-guessed-id', true)).toBe(false);
    expect(r.broker.answerPrompt(device('p'), 'turn', promptId, { allow: true })).toBe(true);
    expect(await outcome).toEqual({ answered: true, answer: { allow: true } });
  });
});

/* ══ Rulings 5 and 7: sleep and quit ════════════════════════════════════ */

describe('suspend and quit end everything, with a reason, and hold nothing', () => {
  it('suspend: stops admitting, ends running and waiting work HOST_SUSPENDED, tells the phone, drops held results; resume admits again', async () => {
    // FAULT INJECTED: skipping the queue in `#endEverything` left the waiting
    // window unit unsettled.
    const r = rig();
    const collected = work();
    r.run(device('other'), 'held', collected);
    collected.resolve('waiting to be collected');
    await flush();
    expect(r.broker.heldCount).toBe(1);

    const phone = channel();
    r.broker.attachDevice('p', phone);
    const job = work();
    const running = r.run(device('p'), 'turn', job);
    const queued = r.run(win(1), 'local', work());

    r.broker.suspend();
    expect((await running).end).toBe('HOST_SUSPENDED');
    expect((await queued).end).toBe('HOST_SUSPENDED');
    expect(job.signal?.aborted).toBe(true);
    expect(terminalsIn(phone.sent, 'turn')).toEqual([expect.objectContaining({ end: 'HOST_SUSPENDED' })]);
    expect(terminalsIn(r.inbox(1), 'local')).toEqual([expect.objectContaining({ end: 'HOST_SUSPENDED' })]);
    // Ruling 5: held results end on sleep, and nothing ended by the sleep is held.
    expect(r.broker.heldCount).toBe(0);
    expect(r.broker.admitting).toBe(false);
    expect(r.broker.admit({ owner: win(1), unitId: 'during-sleep', executor: 'llama', start: work().start })).toEqual({
      admitted: false,
      refusal: 'HOST_SUSPENDED',
    });

    r.broker.resume();
    expect(r.broker.admitting).toBe(true);
    // The aborted work still holds the slot until it stops.
    const after = work();
    expect(r.run(win(1), 'after-wake', after).position).toBe(1);
    job.resolve('stopped');
    await flush();
    expect(after.starts).toBe(1);
  });

  it('quit: everything ends DESKTOP_QUITTING, nothing is admitted or attached again, and resume does not reopen it', async () => {
    const r = rig();
    const phone = channel();
    r.broker.attachDevice('p', phone);
    const running = r.run(device('p'), 'turn', work());
    const queued = r.run(win(1), 'local', work());

    r.broker.quit();
    expect((await running).end).toBe('DESKTOP_QUITTING');
    expect((await queued).end).toBe('DESKTOP_QUITTING');
    expect(terminalsIn(phone.sent, 'turn')).toHaveLength(1);
    expect(r.broker.heldCount).toBe(0);

    r.broker.resume();
    r.broker.quit();
    expect(r.broker.admit({ owner: win(1), unitId: 'x', executor: 'llama', start: work().start })).toEqual({
      admitted: false,
      refusal: 'DESKTOP_QUITTING',
    });
    expect(r.broker.attachDevice('q', channel())).toBe(false);
    expect(terminalsIn(phone.sent, 'turn')).toHaveLength(1);
  });
});

/* ══ Owners and positions ═══════════════════════════════════════════════ */

describe('owners are keyed by kind and id, and only the owner hears about a unit', () => {
  it('window 1 and device "1" are different owners, even with the same unit id', async () => {
    const r = rig();
    const windowJob = work();
    const deviceJob = work();
    r.run(win(1), 'u', windowJob);
    const deviceEnd = watch(r.run(device('1'), 'u', deviceJob));
    expect(r.broker.ownerCount).toBe(2);

    // Window 1's cancel reaches window 1's unit, and not device "1"'s, which
    // shares both the id's digits and the unit id.
    r.broker.cancel(win(1), 'u');
    await flush();
    expect(windowJob.signal?.aborted).toBe(true);
    expect(deviceEnd.done).toBe(false);
    expect(r.broker.positionOf(device('1'), 'u')).toBe(1);
    expect(r.inbox(1).some((notice) => notice.kind === 'waiting' && notice.unitId === 'u')).toBe(false);
  });

  it('a live unit id is refused for the same owner, including while its work is still stopping', async () => {
    const r = rig();
    const job = work();
    r.run(win(1), 'u', job);
    expect(r.broker.admit({ owner: win(1), unitId: 'u', executor: 'llama', start: work().start })).toEqual({
      admitted: false,
      refusal: 'DUPLICATE_UNIT',
    });
    await r.clock.advance(UNIT_IDLE_TIMEOUT_MS);
    // Ended, but its work has not returned: the id is still in use below.
    expect(r.broker.admit({ owner: win(1), unitId: 'u', executor: 'llama', start: work().start })).toEqual({
      admitted: false,
      refusal: 'DUPLICATE_UNIT',
    });
    job.resolve('stopped');
    await flush();
    expect(r.run(win(1), 'u', work()).position).toBe(0);
  });

  it('refuses an owner that is not a real identity', () => {
    const r = rig();
    const start = work().start;
    for (const owner of [
      { kind: 'window', id: 0 },
      { kind: 'window', id: 1.5 },
      { kind: 'window', id: Number.NaN },
      { kind: 'device', id: '' },
      { kind: 'sender', id: 1 },
    ]) {
      expect(() => r.broker.admit({ owner: owner as Owner, unitId: 'u', executor: 'llama', start })).toThrow(TypeError);
    }
  });

  it('never writes a unit’s content into a warning', () => {
    const r = rig();
    const loud: OwnerChannel = {
      send: () => {
        throw new Error('SECRET-PROMPT-TEXT');
      },
      close: () => undefined,
    };
    r.broker.attachDevice('p', loud);
    r.run(device('p'), 'u', work());
    expect(r.warnings.length).toBeGreaterThan(0);
    expect(r.warnings.join('\n')).not.toContain('SECRET');
  });
});

describe('whoever waits is told, whenever their place changes', () => {
  it('positions are sent on admission, on a cancel ahead, and on the slot freeing', async () => {
    // FAULT INJECTED: removing `#tellPositions()` from `#settle` left `c` and
    // `d` believing they were still 2 and 3 after `b` was cancelled.
    const r = rig();
    const a = work();
    r.run(win(1), 'a', a);
    r.run(win(2), 'b', work());
    r.run(win(3), 'c', work());
    r.run(device('d'), 'd', work());
    const phone = channel();
    r.broker.attachDevice('d', phone);

    expect(r.inbox(2)).toEqual([{ kind: 'waiting', unitId: 'b', position: 1 }]);
    expect(r.inbox(3)).toEqual([{ kind: 'waiting', unitId: 'c', position: 2 }]);
    // `d` was detached when admitted, so its first word is on attach.
    expect(phone.sent).toEqual([{ kind: 'waiting', unitId: 'd', position: 3 }]);

    r.broker.cancel(win(2), 'b');
    expect(r.inbox(3).at(-1)).toEqual({ kind: 'waiting', unitId: 'c', position: 1 });
    expect(phone.sent.at(-1)).toEqual({ kind: 'waiting', unitId: 'd', position: 2 });

    a.resolve('done');
    await flush();
    expect(r.inbox(3).at(-1)).toEqual({ kind: 'started', unitId: 'c' });
    expect(phone.sent.at(-1)).toEqual({ kind: 'waiting', unitId: 'd', position: 1 });
    // Nobody is told the same place twice.
    const dPositions = phone.sent.filter((notice) => notice.kind === 'waiting').map((notice) => (notice as { position: number }).position);
    expect(dPositions).toEqual([3, 2, 1]);
  });
});
