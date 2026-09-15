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
  RETAIN_RESULT_PER_DEVICE,
  UNIT_DRAIN_TIMEOUT_MS,
  UNIT_IDLE_TIMEOUT_MS,
  WorkBroker,
} from '@chatterang/desktop/bridge';
import { MAX_OPEN_TURNS } from '@chatterang/tunnel/stream';
import type {
  AdmitResult,
  BrokerNotice,
  ChannelCloseReason,
  Owner,
  OwnerChannel,
  SupervisorTimers,
  UnitEnd,
  UnitTerminal,
  WorkBrokerOptions,
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
  /**
   * Move the clock WITHOUT running the tick: an interval lagging behind a
   * stalled event loop, or a wake before any tick has fired.
   */
  jump(ms: number): void;
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
    jump(ms: number): void {
      now += ms;
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

function rig(options: Pick<WorkBrokerOptions, 'condemnExecutor'> = {}): Rig {
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
    ...options,
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
      RETAIN_RESULT_PER_DEVICE,
      RETAIN_RESULT_COUNT,
      UNIT_IDLE_TIMEOUT_MS,
      UNIT_DRAIN_TIMEOUT_MS,
      BROKER_TICK_MS,
    }).toEqual({
      MAX_CONCURRENT_TURNS: 1,
      MAX_WAITING_PER_DEVICE: 3,
      MAX_WAITING_PER_WINDOW: 2,
      MAX_WAITING_TOTAL: 8,
      PROMPT_ANSWER_TIMEOUT_MS: 60_000,
      RETAIN_RESULT_MS: 300_000,
      RETAIN_RESULT_PER_DEVICE: 4,
      RETAIN_RESULT_COUNT: 8,
      UNIT_IDLE_TIMEOUT_MS: 150_000,
      UNIT_DRAIN_TIMEOUT_MS: 30_000,
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
    // And behind its call timeout, which bounds a non-streamed call such as a
    // benchmark that reports no progress while it runs.
    expect(UNIT_IDLE_TIMEOUT_MS).toBeGreaterThan(DEFAULT_POLICY.callTimeoutMs + DEFAULT_POLICY.tickMs + BROKER_TICK_MS);
  });

  it('a device can hold a result for every unit it can have live at once, and fewer than the total', () => {
    expect(RETAIN_RESULT_PER_DEVICE).toBe(MAX_CONCURRENT_TURNS + MAX_WAITING_PER_DEVICE);
    expect(RETAIN_RESULT_PER_DEVICE).toBeLessThan(RETAIN_RESULT_COUNT);
  });

  it('one device can never have as many turns open on its tunnel as the tunnel allows, so the broker refuses first', () => {
    // #308's turn ledger refuses a peer's `turn` or `attach` past
    // MAX_OPEN_TURNS open turns on one tunnel, with FRAME_UNEXPECTED, and a
    // tunnel is one device. The most one device can have open there at once is
    // its unit in the slot, its units waiting, and the held results it attaches
    // to collect. Kept below the tunnel's bound, a phone meets the broker's own
    // refusal, which says nothing ran, before the tunnel's, which says nothing.
    const mostOpenForOneDevice = MAX_CONCURRENT_TURNS + MAX_WAITING_PER_DEVICE + RETAIN_RESULT_PER_DEVICE;
    expect(mostOpenForOneDevice).toBeLessThan(MAX_OPEN_TURNS);
    // And the totals, which bound every device together, are no looser.
    expect(MAX_CONCURRENT_TURNS + MAX_WAITING_TOTAL + RETAIN_RESULT_COUNT).toBeLessThan(MAX_OPEN_TURNS);
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

  it(`RETAIN_RESULT_PER_DEVICE: one device holds at most ${String(RETAIN_RESULT_PER_DEVICE)}, and its backlog costs it its own oldest, never another device's result`, async () => {
    // Review repro: device A, attached, finishes RETAIN_RESULT_COUNT turns and
    // acknowledges none; device B's one result, well inside RETAIN_RESULT_MS,
    // used to be evicted as the oldest overall.
    // FAULT INJECTED: removing the per-device loop from `#hold` left A holding
    // seven and failed the second assertion.
    const r = rig();
    const b = work();
    r.run(device('B'), 'b1', b);
    b.resolve('B’s only reply');
    await flush();

    r.broker.attachDevice('A', channel());
    for (let i = 0; i < RETAIN_RESULT_COUNT; i += 1) {
      const job = work();
      r.run(device('A'), `a${String(i)}`, job);
      job.resolve(`A reply ${String(i)}`);
      await flush();
    }
    expect(r.broker.heldFor('B')).toEqual(['b1']);
    expect(r.broker.heldFor('A')).toEqual(
      Array.from({ length: RETAIN_RESULT_PER_DEVICE }, (_, i) => `a${String(RETAIN_RESULT_COUNT - RETAIN_RESULT_PER_DEVICE + i)}`),
    );
    expect(r.warnings.some((warning) => warning.includes('RETAIN_RESULT_PER_DEVICE'))).toBe(true);
  });

  it('RETAIN_RESULT_COUNT across devices: the device holding the most gives up its oldest, not a device holding one', async () => {
    // FAULT INJECTED: evicting the oldest result overall (`this.#held.shift()`)
    // dropped `lone`'s, the first held, while A and B held four each.
    const r = rig();
    const hold = async (deviceId: string, unitId: string): Promise<void> => {
      const job = work();
      r.run(device(deviceId), unitId, job);
      job.resolve('reply');
      await flush();
    };
    await hold('lone', 'l1');
    for (let i = 0; i < RETAIN_RESULT_PER_DEVICE; i += 1) await hold('A', `a${String(i)}`);
    for (let i = 0; i < RETAIN_RESULT_PER_DEVICE - 1; i += 1) await hold('B', `b${String(i)}`);
    expect(r.broker.heldCount).toBe(RETAIN_RESULT_COUNT);

    // One more for B: A and B now hold four each, and A's oldest is the older.
    await hold('B', 'b-last');
    expect(r.broker.heldCount).toBe(RETAIN_RESULT_COUNT);
    expect(r.broker.heldFor('lone')).toEqual(['l1']);
    expect(r.broker.heldFor('A')).toEqual(['a1', 'a2', 'a3']);
    expect(r.broker.heldFor('B')).toHaveLength(RETAIN_RESULT_PER_DEVICE);
  });

  it('UNIT_DRAIN_TIMEOUT_MS: work that ignores its abort keeps the slot until then, and an executor confirmed dead frees it', async () => {
    // Review repro: a unit whose work never settles ended DEADLINE, and the
    // unit behind it had still not started a simulated day later.
    // FAULT INJECTED: removing the drain check from `#tick` left `next` unstarted.
    const condemned: string[] = [];
    const r = rig({
      condemnExecutor: (executor) => {
        condemned.push(executor);
        return true;
      },
    });
    const stuck = work();
    const next = work();
    const stuckEnd = r.run(win(1), 'stuck', stuck, 'worker');
    r.run(win(2), 'next', next);

    await r.clock.advance(UNIT_IDLE_TIMEOUT_MS);
    expect((await stuckEnd).end).toBe('DEADLINE');
    expect(stuck.signal?.aborted).toBe(true);

    await r.clock.advance(UNIT_DRAIN_TIMEOUT_MS - 1);
    expect(condemned).toEqual([]);
    expect(next.starts).toBe(0);

    await r.clock.advance(1);
    expect(condemned).toEqual(['worker']);
    expect(next.starts).toBe(1);
    expect(r.broker.slotCount).toBe(1);

    // Still one terminal, whatever the condemned work does afterwards, and it
    // is condemned once.
    stuck.resolve('far too late');
    await flush();
    await r.clock.advance(UNIT_DRAIN_TIMEOUT_MS);
    expect(condemned).toEqual(['worker']);
    expect(terminalsIn(r.inbox(1), 'stuck')).toHaveLength(1);
  });

  it('UNIT_DRAIN_TIMEOUT_MS: an executor that is not condemned keeps the slot until its work returns, however long, and it is said once', async () => {
    // Fail closed. The work may still be decoding; freeing the slot would put
    // the next owner's turn on the same sequence.
    // FAULT INJECTED: freeing the slot (`this.workerLost(unit.executor)`) when
    // the executor was not confirmed dead started `next` at the drain deadline.
    const hooks: (Pick<WorkBrokerOptions, 'condemnExecutor'> & { name: string })[] = [
      { name: 'no hook' },
      { name: 'false', condemnExecutor: () => false },
      {
        name: 'throws',
        condemnExecutor: () => {
          throw new Error('SECRET-EXECUTOR-DETAIL');
        },
      },
    ];
    for (const { name, ...options } of hooks) {
      const r = rig(options);
      const stuck = work();
      const next = work();
      r.run(win(1), 'stuck', stuck);
      r.run(win(2), 'next', next);
      await r.clock.advance(UNIT_IDLE_TIMEOUT_MS);
      for (let hour = 1; hour <= 24; hour += 1) await r.clock.advance(3_600_000);
      expect(next.starts, name).toBe(0);
      expect(r.broker.slotCount, name).toBe(1);
      expect(r.warnings.filter((warning) => warning.includes('UNIT_DRAIN_TIMEOUT_MS')), name).toHaveLength(1);
      expect(r.warnings.join('\n'), name).not.toContain('SECRET');

      stuck.resolve('stopped at last');
      await flush();
      expect(next.starts, name).toBe(1);
    }
  });
});

/* ══ Deadlines where they are used ══════════════════════════════════════ */

describe('a deadline that has passed is past, whether or not the tick has run', () => {
  // Every test here moves the clock with `jump`, which runs no tick. The tick
  // is at best BROKER_TICK_MS away; behind a stalled event loop, or across a
  // sleep with no suspend event, it is as far away as it likes.

  it('a prompt answer after PROMPT_ANSWER_TIMEOUT_MS is refused on arrival, and the prompt is refused as not sent (#170)', async () => {
    // Review repro: the answer was accepted and the outcome `answered: true`.
    // FAULT INJECTED: removing the deadline check from `answerPrompt` failed
    // the first assertion.
    const r = rig();
    const late = channel();
    const onTime = channel();
    r.broker.attachDevice('late', late);
    r.broker.attachDevice('on-time', onTime);
    const blocker = work();
    r.run(device('late'), 'turn', blocker);
    const lateOutcome = r.broker.requestPrompt(device('late'), 'turn', 'send?');
    const lateId = (late.sent.find((notice) => notice.kind === 'prompt') as { promptId: string }).promptId;

    r.clock.jump(PROMPT_ANSWER_TIMEOUT_MS);
    expect(r.broker.answerPrompt(device('late'), 'turn', lateId, true)).toBe(false);
    expect(await lateOutcome).toEqual({ answered: false, refusal: 'PROMPT_TIMEOUT', notSent: true });

    // One millisecond inside the deadline is on time.
    blocker.resolve('done');
    await flush();
    r.run(device('on-time'), 'turn', work());
    const onTimeOutcome = r.broker.requestPrompt(device('on-time'), 'turn', 'send?');
    const onTimeId = (onTime.sent.find((notice) => notice.kind === 'prompt') as { promptId: string }).promptId;
    r.clock.jump(PROMPT_ANSWER_TIMEOUT_MS - 1);
    expect(r.broker.answerPrompt(device('on-time'), 'turn', onTimeId, true)).toBe(true);
    expect(await onTimeOutcome).toEqual({ answered: true, answer: true });
  });

  it('progress that arrives after UNIT_IDLE_TIMEOUT_MS ends the unit instead of rescuing it', async () => {
    // Review repro: the late progress reset the deadline and the unit ran on.
    // FAULT INJECTED: removing `#enforceDeadlines` from `progress` failed this test.
    const r = rig();
    const job = work();
    const settled = r.run(win(1), 'u', job);
    r.clock.jump(UNIT_IDLE_TIMEOUT_MS);
    r.broker.progress(win(1), 'u');
    expect((await settled).end).toBe('DEADLINE');
    expect(job.signal?.aborted).toBe(true);
  });

  it('a prompt asked for after a missed deadline is refused NOT_RUNNING and never sent, and isRunning agrees', async () => {
    const r = rig();
    const phone = channel();
    r.broker.attachDevice('p', phone);
    const settled = r.run(device('p'), 'turn', work());
    r.run(win(2), 'waiting', work());
    expect(r.broker.isRunning(device('p'), 'turn')).toBe(true);
    // Not running: waiting, unknown, or someone else's.
    expect(r.broker.isRunning(win(2), 'waiting')).toBe(false);
    expect(r.broker.isRunning(win(2), 'turn')).toBe(false);
    expect(r.broker.isRunning(device('q'), 'turn')).toBe(false);

    r.clock.jump(UNIT_IDLE_TIMEOUT_MS);
    expect(await r.broker.requestPrompt(device('p'), 'turn', 'late?')).toEqual({
      answered: false,
      refusal: 'NOT_RUNNING',
      notSent: true,
    });
    expect(phone.sent.some((notice) => notice.kind === 'prompt')).toBe(false);
    expect((await settled).end).toBe('DEADLINE');
    expect(r.broker.isRunning(device('p'), 'turn')).toBe(false);
  });

  it('isRunning enforces the deadline itself: a unit past it is not running, and asking ends it', async () => {
    // FAULT INJECTED: `isRunning` returning `unit.state === 'running'` without
    // `#enforceDeadlines` answered true for a unit a minute past its deadline.
    const r = rig();
    const job = work();
    const settled = watch(r.run(win(1), 'u', job));
    r.clock.jump(UNIT_IDLE_TIMEOUT_MS + 60_000);
    expect(r.broker.isRunning(win(1), 'u')).toBe(false);
    await flush();
    expect(settled.end).toBe('DEADLINE');
    // Ended, and still holding the slot until its work returns.
    expect(r.broker.positionOf(win(1), 'u')).toBe(0);
  });

  it('a held result past RETAIN_RESULT_MS is not replayed on attach, not acknowledged, and not listed', async () => {
    // Review repro: an attach before the tick replayed the expired result, and
    // ack still found it.
    // FAULT INJECTED: removing `#purgeExpired` from `attachDevice` replayed
    // `p`'s terminal; removing it from `ack` returned true for `q`.
    const r = rig();
    const first = work();
    r.run(device('p'), 'turn', first);
    first.resolve('p’s reply');
    await flush();
    r.clock.jump(100_000);
    const second = work();
    r.run(device('q'), 'turn', second);
    second.resolve('q’s reply');
    await flush();

    r.clock.jump(RETAIN_RESULT_MS - 100_000);
    const back = channel();
    r.broker.attachDevice('p', back);
    expect(terminalsIn(back.sent, 'turn')).toEqual([]);

    r.clock.jump(100_000);
    expect(r.broker.ack('q', 'turn')).toBe(false);
    expect(r.broker.heldFor('p')).toEqual([]);
    expect(r.broker.heldFor('q')).toEqual([]);
    expect(r.broker.heldCount).toBe(0);
  });
});

/* ══ Exactly once ═══════════════════════════════════════════════════════ */

describe('one settle: exactly one terminal per unit, on every path', () => {
  // FAULT INJECTED for the whole block: deleting `if (unit.terminal !== null)
  // return;` from `#settle` failed the four tests here whose end is decided
  // BEFORE the work returns (worker loss, both owner losses, the deadline),
  // each on a second terminal or a held result produced by the late report in
  // `everyOtherPath`; outside this block it also failed the drain test and the
  // suspended-phone test, six in all. The two path-1 tests did not fail, and are not meant to:
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

  it('a prompt sent on a socket that is then replaced is refused as not sent, is never re-sent, and its answer is refused (#170)', async () => {
    // Review repro: after a new socket replaced the stale one, the prompt stayed
    // pending, was never sent on the new socket, was still answerable with the
    // old id, and held the slot for PROMPT_ANSWER_TIMEOUT_MS.
    // FAULT INJECTED: removing the prompt refusal from `attachDevice` failed
    // the first assertion (the outcome did not settle).
    const r = rig();
    const stale = channel();
    r.broker.attachDevice('p', stale);
    const settled = watch(r.run(device('p'), 'turn', work()));
    let outcome: unknown = null;
    void r.broker.requestPrompt(device('p'), 'turn', 'send this?').then((result) => {
      outcome = result;
    });
    const { promptId } = stale.sent.find((notice) => notice.kind === 'prompt') as { promptId: string };

    const fresh = channel();
    r.broker.attachDevice('p', fresh);
    r.broker.detachDevice('p', stale);
    await flush();
    expect(outcome).toEqual({ answered: false, refusal: 'OWNER_DETACHED', notSent: true });
    expect(fresh.sent).toEqual([{ kind: 'started', unitId: 'turn' }]);
    expect(r.broker.answerPrompt(device('p'), 'turn', promptId, true)).toBe(false);

    // The call is refused, not the turn; asked again, the prompt goes to the new socket.
    expect(settled.done).toBe(false);
    void r.broker.requestPrompt(device('p'), 'turn', 'ask again');
    expect(fresh.sent.at(-1)).toMatchObject({ kind: 'prompt', unitId: 'turn', prompt: 'ask again' });
  });

  it('the same socket attaching again is not a replacement: nothing is closed and its prompt stays pending', async () => {
    const r = rig();
    const phone = channel();
    r.broker.attachDevice('p', phone);
    r.run(device('p'), 'turn', work());
    let outcome: unknown = null;
    void r.broker.requestPrompt(device('p'), 'turn', 'x').then((result) => {
      outcome = result;
    });
    r.broker.attachDevice('p', phone);
    await flush();
    expect(outcome).toBeNull();
    expect(phone.closed).toEqual([]);
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

  it('a phone that was not connected when the desktop slept hears nothing about the unit on attach: absent from the replay means ended', async () => {
    // Ruling 5 ends held results on sleep, so there is nothing to replay; the
    // contract S3/S8 build on is that an attach mentions every unit that is
    // live or held, and a turn it does not mention has ended.
    const r = rig();
    const phone = channel();
    r.broker.attachDevice('p', phone);
    const job = work();
    const running = r.run(device('p'), 'turn', job);
    r.broker.detachDevice('p', phone);

    r.broker.suspend();
    expect((await running).end).toBe('HOST_SUSPENDED');
    expect(terminalsIn(phone.sent, 'turn')).toEqual([]);
    r.broker.resume();
    job.resolve('stopped');
    await flush();

    const back = channel();
    expect(r.broker.attachDevice('p', back)).toBe(true);
    expect(back.sent).toEqual([]);
    expect(r.broker.heldFor('p')).toEqual([]);
    expect(r.broker.positionOf(device('p'), 'turn')).toBeUndefined();
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

  it('a device may not reuse a unit id while a result is held under it, so one ack can never purge two results', async () => {
    // Review repro: `same` was held twice for one device and one ack purged both.
    // FAULT INJECTED: removing the held check from `admit` admitted `same` again.
    const r = rig();
    const first = work();
    r.run(device('p'), 'same', first);
    first.resolve('first');
    await flush();
    expect(r.broker.admit({ owner: device('p'), unitId: 'same', executor: 'llama', start: work().start })).toEqual({
      admitted: false,
      refusal: 'DUPLICATE_UNIT',
    });
    // Another owner's id is its own.
    expect(r.run(device('q'), 'same', work()).position).toBe(0);
    // Acknowledged, the id is free again.
    expect(r.broker.ack('p', 'same')).toBe(true);
    expect(r.run(device('p'), 'same', work()).position).toBe(1);
  });

  it('a unit that may not wait is refused SLOT_BUSY while anything holds the slot, takes no place in line, and starts at once when it is free', async () => {
    // FAULT INJECTED: ignoring `wait: false` in `admit` queued the unit at position 1.
    const r = rig();
    const holder = work();
    r.run(win(1), 'turn', holder);
    const eager = work();
    expect(r.broker.admit({ owner: win(2), unitId: 'bench', executor: 'llama', start: eager.start, wait: false })).toEqual({
      admitted: false,
      refusal: 'SLOT_BUSY',
    });
    expect(r.broker.waitingCount).toBe(0);
    expect(r.inbox(2)).toEqual([]);

    holder.resolve('done');
    await flush();
    expect(r.broker.admit({ owner: win(2), unitId: 'bench', executor: 'llama', start: eager.start, wait: false })).toMatchObject({
      admitted: true,
      position: 0,
    });
    expect(eager.starts).toBe(1);
    // While it runs, everyone else waits behind it.
    expect(r.run(device('p'), 'turn', work()).position).toBe(1);
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

describe('a window’s unit between two steps of its work keeps the slot, and its idle deadline stops meanwhile', () => {
  /*
   * OWNER RULING ON #7: a desktop turn holds the one slot from its first decode
   * until the turn settles, its tool calls included. Rejected: a hold that
   * yields after a long tool call. A tool call reports no progress, so without
   * this the idle deadline would end a desktop turn 150 s into one.
   */

  it('between steps it outlives UNIT_IDLE_TIMEOUT_MS as often as it takes, and the next step’s progress restarts the deadline', async () => {
    const r = rig();
    const job = work();
    const settled = watch(r.run(win(1), 'turn', job));
    const behind = work();
    r.run(device('p'), 'phone', behind);

    r.broker.progress(win(1), 'turn');
    r.broker.betweenSteps(win(1), 'turn');
    for (let round = 0; round < 3; round += 1) await r.clock.advance(UNIT_IDLE_TIMEOUT_MS);
    expect(settled.done, 'a unit between two steps was ended by its idle deadline').toBe(false);
    expect(r.broker.isRunning(win(1), 'turn')).toBe(true);
    expect(behind.starts).toBe(0);

    // The next step starts: its progress restarts the deadline from now.
    r.broker.progress(win(1), 'turn');
    await r.clock.advance(UNIT_IDLE_TIMEOUT_MS - 1);
    expect(settled.done).toBe(false);
    await r.clock.advance(1);
    await flush();
    expect(settled.end).toBe('DEADLINE');
  });

  it('not after its deadline has passed: a unit that says it is between steps too late ends, as late progress does', async () => {
    const r = rig();
    const settled = watch(r.run(win(1), 'turn', work()));
    r.clock.jump(UNIT_IDLE_TIMEOUT_MS);
    r.broker.betweenSteps(win(1), 'turn');
    await flush();
    expect(settled.end).toBe('DEADLINE');
  });

  it('a device’s unit cannot stop its deadline: a dropped socket does not end it, so nothing else would', async () => {
    const r = rig();
    const settled = watch(r.run(device('p'), 'turn', work()));
    r.broker.betweenSteps(device('p'), 'turn');
    await r.clock.advance(UNIT_IDLE_TIMEOUT_MS);
    await flush();
    expect(settled.end).toBe('DEADLINE');
  });

  it('what bounds a window’s unit between steps still ends it: the window going away, a cancel, a suspend, a quit', async () => {
    const paths: readonly (readonly [UnitEnd, (r: Rig) => void])[] = [
      ['OWNER_LOST', (r) => r.broker.releaseWindow(1)],
      // A running unit's cancel aborts its work, and the work's report ends it.
      ['COMPLETED', (r) => r.broker.cancel(win(1), 'turn')],
      ['HOST_SUSPENDED', (r) => r.broker.suspend()],
      ['DESKTOP_QUITTING', (r) => r.broker.quit()],
    ];
    for (const [end, act] of paths) {
      const r = rig();
      const job = work();
      const settled = r.run(win(1), 'turn', job);
      r.broker.betweenSteps(win(1), 'turn');
      act(r);
      expect(job.signal?.aborted, end).toBe(true);
      job.resolve('stopped');
      expect((await settled).end).toBe(end);
      await flush();
      expect(r.broker.slotCount, end).toBe(0);
    }
  });
});
