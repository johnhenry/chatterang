import { describe, expect, it } from 'vitest';

import type { GenerateOptions, GenerationEndEvent, TurnWaitingEvent } from '@chatterang/contracts';
import {
  HostFleet,
  LLAMA_ENGINE,
  LLAMA_EVENTS,
  LLAMA_METHODS,
  LLAMA_PLUGIN,
  LOCAL_TURNS_PLUGIN,
  PluginHost,
  SENDER_SCOPED,
  TURN_END_METHOD,
  TURN_WAITING_EVENT,
  UNIT_IDLE_TIMEOUT_MS,
  WorkBroker,
  admitLocalTurns,
  localTurnNotices,
  withTurnProgress,
} from '@chatterang/desktop/bridge';
import type {
  BrokerNotice,
  EventPayload,
  HostCall,
  HostMessage,
  HostedUnitOf,
  NotifyListeners,
  OwnerChannel,
  PluginImplementation,
  SupervisorTimers,
} from '@chatterang/desktop/bridge';

/**
 * #7 S6: THE DESKTOP'S OWN GENERATIONS TAKE THE WORK BROKER'S ONE SLOT.
 *
 * Ruling 3 on #7: local and phone turns share one slot and one first-come-
 * first-served wait list, and whoever waits is told, including the person at
 * the desktop. `apps/desktop/src/bridge/local-turns.ts` is the wiring, and
 * `main.ts` uses it (pinned as text in `tests/desktop-security.test.ts`).
 *
 * Everything between the window and the llama host here is production code:
 * the real `PluginHost` (so `LOCAL_TURNS_PLUGIN` and its sender scoping are
 * what the calls go through), the real `HostFleet` and `Supervisor`, and the
 * real `WorkBroker`. Only the llama host is a double, answering on command,
 * and the clock is the test's. A phone's unit is admitted to the broker
 * directly: no listener exists yet (#169), and none is started.
 */

/* ── Doubles ──────────────────────────────────────────────────────────── */

interface ManualClock extends SupervisorTimers {
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
      for (const fn of [...ticks]) fn();
      await settle();
    },
  };
}

const settle = async (): Promise<void> => {
  await new Promise((done) => setTimeout(done, 5));
};

interface Work {
  readonly start: (signal: AbortSignal) => Promise<unknown>;
  resolve(value: unknown): void;
  readonly starts: number;
}

function work(): Work {
  let resolve: (value: unknown) => void = () => undefined;
  let starts = 0;
  return {
    start: () => {
      starts += 1;
      return new Promise((done) => {
        resolve = done;
      });
    },
    resolve: (value) => resolve(value),
    get starts() {
      return starts;
    },
  };
}

function endOf(requestId: string, stopReason: GenerationEndEvent['stopReason']): GenerationEndEvent {
  return {
    requestId,
    text: stopReason === 'stop' ? 'the answer' : '',
    promptTokens: 1,
    cachedTokens: 0,
    completionTokens: 1,
    ttftMs: 1,
    totalMs: 1,
    tokensPerSecond: 1,
    stopReason,
  };
}

interface FakeHost {
  readonly posted: HostMessage[];
  send(message: HostMessage): void;
}

function rig(options: { hostedUnitOf?: HostedUnitOf; policy?: { readonly generateIdleTimeoutMs?: number } } = {}) {
  const clock = manualClock();
  /** Host calls already answered, so a turn's later decode is answered by its own call. */
  const answered = new Set<number>();
  const hosts: FakeHost[] = [];
  const warnings: string[] = [];
  const delivered: { senderId: number; payload: EventPayload }[] = [];

  const pluginHost = new PluginHost((senderId, payload) => {
    delivered.push({ senderId, payload: structuredClone(payload) as EventPayload });
    return true;
  });
  const notify: NotifyListeners = (pluginName, eventName, data, ownerId) =>
    pluginHost.notifyListeners(pluginName, eventName, data, ownerId);

  // The same construction order as `main.ts`: broker, then fleet, then the
  // wrapper over the fleet's facade.
  const notices = localTurnNotices(notify);
  const broker = new WorkBroker({ notifyWindow: notices, timers: clock });
  const fleet = new HostFleet({
    spawn: () => {
      const listeners: ((message: unknown) => void)[] = [];
      const host: FakeHost = {
        posted: [],
        send: (message) => {
          for (const listener of listeners) listener(message);
        },
      };
      hosts.push(host);
      return {
        link: {
          postMessage: (raw) => {
            const message = raw as HostMessage;
            host.posted.push(message);
            if (message.k === 'ping') host.send({ k: 'pong', id: message.id });
            if (message.k === 'call' && message.method !== 'generate' && message.method !== 'benchmark') {
              const data = message.method === 'getCapabilities' ? { simulated: true } : null;
              host.send({ k: 'ret', id: message.id, ok: true, data });
            }
          },
          onMessage: (listener) => listeners.push(listener),
          onClose: () => undefined,
        },
        kill: () => undefined,
      };
    },
    notify: withTurnProgress(broker, notify, options.hostedUnitOf),
    entries: [{ engine: LLAMA_ENGINE, host: 'llama', ...(options.policy === undefined ? {} : { policy: options.policy }) }],
    warn: (_host, message) => warnings.push(message),
    timers: clock,
  });
  const localTurns = admitLocalTurns({
    broker,
    facade: fleet.plugin(LLAMA_PLUGIN.name),
    fleet,
    notices,
    notify,
    hostedUnitOf: options.hostedUnitOf,
  });
  pluginHost.register(LOCAL_TURNS_PLUGIN, localTurns.plugin);

  let subscriptionId = 1;
  const host = (): FakeHost => hosts[hosts.length - 1]!;
  const calls = (method: string): HostCall[] =>
    hosts.flatMap((entry) => entry.posted).filter((m): m is HostCall => m.k === 'call' && m.method === method);

  return {
    clock,
    broker,
    fleet,
    localTurns,
    notices,
    pluginHost,
    warnings,
    subscribe(senderId: number): void {
      for (const eventName of LOCAL_TURNS_PLUGIN.events) {
        pluginHost.addListener(senderId, LLAMA_PLUGIN.name, eventName, subscriptionId++);
      }
    },
    events<T>(senderId: number, eventName: string): T[] {
      return delivered
        .filter((entry) => entry.senderId === senderId && entry.payload.eventName === eventName)
        .map((entry) => entry.payload.data as T);
    },
    /**
     * A page's `generate`. `wholeTurn` is what the renderer's streamed turn sends:
     * one decode of a turn that keeps the slot until the page ends it.
     */
    generate(senderId: number, requestId: string, options: { wholeTurn?: boolean } = {}): Promise<unknown> {
      const request: GenerateOptions & { wholeTurn?: true } = {
        handle: 'h',
        prompt: 'p',
        requestId,
        ...(options.wholeTurn === true ? { wholeTurn: true as const } : {}),
      };
      const turn = pluginHost.invoke(senderId, LLAMA_PLUGIN.name, 'generate', [request]);
      void turn.catch(() => undefined);
      return turn;
    },
    cancel(senderId: number, requestId: string): Promise<unknown> {
      return pluginHost.invoke(senderId, LLAMA_PLUGIN.name, 'cancel', [{ requestId }]);
    },
    /** A page's turn is over, however it ended. */
    endTurn(senderId: number, requestId: string): Promise<unknown> {
      return pluginHost.invoke(senderId, LLAMA_PLUGIN.name, 'endTurn', [{ requestId }]);
    },
    /** requestIds the llama host was asked to generate, in order, once per decode. */
    generated(): string[] {
      return calls('generate').map((call) => (call.args[0] as GenerateOptions).requestId);
    },
    /** What the llama host was sent for each `generate`, in order. */
    generateArgs(): unknown[] {
      return calls('generate').map((call) => call.args[0]);
    },
    /** The host refuses a turn's oldest unanswered decode. */
    failDecode(requestId: string, message: string): void {
      const call = calls('generate').find(
        (entry) => (entry.args[0] as GenerateOptions).requestId === requestId && !answered.has(entry.id),
      );
      if (call === undefined) throw new Error(`no unanswered generate for ${requestId}`);
      answered.add(call.id);
      host().send({ k: 'ret', id: call.id, ok: false, error: { message } });
    },
    cancelled(): string[] {
      return calls('cancel').map((call) => (call.args[0] as { requestId: string }).requestId);
    },
    benchmark(senderId: number): Promise<unknown> {
      const run = pluginHost.invoke(senderId, LLAMA_PLUGIN.name, 'benchmark', [{ handle: 'h' }]);
      void run.catch(() => undefined);
      return run;
    },
    /** The argument lists the llama host was sent for `benchmark`, in order. */
    benchmarkArgs(): unknown[][] {
      return calls('benchmark').map((call) => [...call.args]);
    },
    /** The host returns the last benchmark it was sent. */
    finishBenchmark(data: unknown): void {
      const call = calls('benchmark').at(-1);
      if (call === undefined) throw new Error('the host was never asked to benchmark');
      host().send({ k: 'ret', id: call.id, ok: true, data });
    },
    /** Deliver any envelope from the current llama host. */
    hostSend(message: HostMessage): void {
      host().send(message);
    },
    token(requestId: string, index: number): void {
      host().send({ k: 'ev', plugin: LLAMA_PLUGIN.name, name: 'llamaToken', data: { requestId, token: 't', index } });
    },
    /** The host ends a generation the way LlamaCppNode does: its event, then its return. */
    finish(requestId: string, stopReason: GenerationEndEvent['stopReason'] = 'stop'): void {
      const call = calls('generate').find(
        (entry) => (entry.args[0] as GenerateOptions).requestId === requestId && !answered.has(entry.id),
      );
      if (call === undefined) throw new Error(`the host was never asked to generate ${requestId}`);
      answered.add(call.id);
      const end = endOf(requestId, stopReason);
      host().send({ k: 'ev', plugin: LLAMA_PLUGIN.name, name: 'llamaEnd', data: end });
      host().send({ k: 'ret', id: call.id, ok: true, data: end });
    },
    /** A paired phone's unit, admitted straight to the broker. */
    phoneTurn(unitId: string): Work {
      const job = work();
      const result = broker.admit({ owner: { kind: 'device', id: 'phone' }, unitId, executor: 'worker', start: job.start });
      if (!result.admitted) throw new Error(`phone unit refused: ${result.refusal}`);
      return job;
    },
  };
}

/* ══ Ruling 3: one slot, contended ══════════════════════════════════════ */

describe('a desktop generation and a phone’s turn contend for the one slot', () => {
  it('a phone turn holds the slot: the desktop generate waits, its window is told, and it reaches the host only when the slot frees', async () => {
    // FAULT INJECTED: registering the fleet's facade for `generate` instead of
    // the wrapper (the `stream.start` case removed from `admitLocalTurns`) sent
    // `local-1` to the host at once, and this test failed on `generated()`.
    const r = rig();
    r.subscribe(1);
    const phone = r.phoneTurn('phone-1');

    const turn = r.generate(1, 'local-1');
    await settle();
    expect(r.generated()).toEqual([]);
    expect(r.events<TurnWaitingEvent>(1, TURN_WAITING_EVENT)).toEqual([{ requestId: 'local-1', position: 1 }]);

    phone.resolve('the phone’s answer');
    await settle();
    expect(r.generated()).toEqual(['local-1']);
    expect(r.events<TurnWaitingEvent>(1, TURN_WAITING_EVENT)).toEqual([
      { requestId: 'local-1', position: 1 },
      { requestId: 'local-1', position: 0 },
    ]);

    r.token('local-1', 0);
    r.finish('local-1');
    expect(await turn).toMatchObject({ requestId: 'local-1', stopReason: 'stop' });
    await settle();
    expect(r.events<GenerationEndEvent>(1, 'llamaEnd')).toHaveLength(1);
    expect(r.broker.slotCount).toBe(0);
  });

  it('a desktop turn holds the slot: a phone unit queued behind it is told its place, and starts when the turn ends', async () => {
    const r = rig();
    r.subscribe(1);
    const turn = r.generate(1, 'local-1');
    await settle();
    expect(r.generated()).toEqual(['local-1']);
    // Started at once: nothing to say about waiting.
    expect(r.events(1, TURN_WAITING_EVENT)).toEqual([]);

    const sent: BrokerNotice[] = [];
    const channel: OwnerChannel = { send: (notice) => sent.push(notice) > 0, close: () => undefined };
    r.broker.attachDevice('phone', channel);
    const phone = work();
    expect(
      r.broker.admit({ owner: { kind: 'device', id: 'phone' }, unitId: 'p1', executor: 'worker', start: phone.start }),
    ).toMatchObject({ admitted: true, position: 1 });
    expect(sent).toEqual([{ kind: 'waiting', unitId: 'p1', position: 1 }]);
    expect(phone.starts).toBe(0);

    r.finish('local-1');
    await turn;
    await settle();
    expect(phone.starts).toBe(1);
  });

  it('two windows share the one slot too, first come first served', async () => {
    const r = rig();
    r.subscribe(1);
    r.subscribe(2);
    const first = r.generate(1, 'a');
    await settle();
    const second = r.generate(2, 'b');
    await settle();
    expect(r.generated()).toEqual(['a']);
    expect(r.events<TurnWaitingEvent>(2, TURN_WAITING_EVENT)).toEqual([{ requestId: 'b', position: 1 }]);
    // Only the owner hears about its place.
    expect(r.events(1, TURN_WAITING_EVENT)).toEqual([]);

    r.finish('a');
    await first;
    await settle();
    expect(r.generated()).toEqual(['a', 'b']);
    r.finish('b');
    await second;
  });
});

/* ══ Exactly once, still ════════════════════════════════════════════════ */

describe('every desktop generation still ends exactly once', () => {
  it('cancelled while waiting: one cancelled llamaEnd, a cancelled result, and the host never hears of it', async () => {
    const r = rig();
    r.subscribe(1);
    r.phoneTurn('p');
    const turn = r.generate(1, 'local-1');
    await settle();

    await r.cancel(1, 'local-1');
    expect(await turn).toMatchObject({ requestId: 'local-1', stopReason: 'cancelled' });
    await settle();
    expect(r.events<GenerationEndEvent>(1, 'llamaEnd')).toEqual([
      expect.objectContaining({ requestId: 'local-1', stopReason: 'cancelled' }),
    ]);
    expect(r.generated()).toEqual([]);
    expect(r.cancelled()).toEqual([]);
  });

  it('another window cannot cancel a waiting turn it does not own', async () => {
    const r = rig();
    r.subscribe(1);
    r.phoneTurn('p');
    const turn = r.generate(1, 'local-1');
    await settle();

    await r.cancel(2, 'local-1');
    await settle();
    expect(r.broker.positionOf({ kind: 'window', id: 1 }, 'local-1')).toBe(1);
    expect(r.events(1, 'llamaEnd')).toEqual([]);
    void turn;
  });

  it('suspended while waiting: one llamaEnd, HOST_SUSPENDED, and the host never hears of it', async () => {
    const r = rig();
    r.subscribe(1);
    r.phoneTurn('p');
    const turn = r.generate(1, 'local-1');
    await settle();

    r.broker.suspend();
    await expect(turn).rejects.toMatchObject({ code: 'HOST_SUSPENDED' });
    await settle();
    expect(r.events<GenerationEndEvent>(1, 'llamaEnd')).toEqual([
      expect.objectContaining({ requestId: 'local-1', stopReason: 'error' }),
    ]);
    expect(r.generated()).toEqual([]);
  });

  it('refused (a requestId already waiting): no llamaEnd for the refusal, and the first turn keeps its place', async () => {
    const r = rig();
    r.subscribe(1);
    r.phoneTurn('p');
    r.generate(1, 'local-1');
    await settle();

    await expect(r.generate(1, 'local-1')).rejects.toMatchObject({ code: 'DUPLICATE_UNIT' });
    await settle();
    expect(r.events(1, 'llamaEnd')).toEqual([]);
    expect(r.broker.positionOf({ kind: 'window', id: 1 }, 'local-1')).toBe(1);
  });

  it('RUNNING and ended by the broker: cancelled in the host, the promise rejects with the reason, and the host’s end is the only llamaEnd', async () => {
    // FAULT INJECTED: dropping `!terminal.started &&` from the synthesised-end
    // branch of `generate` delivered a second llamaEnd, from the wrapper, before
    // the host had even stopped.
    const r = rig();
    r.subscribe(1);
    const turn = r.generate(1, 'local-1');
    await settle();
    expect(r.generated()).toEqual(['local-1']);

    r.broker.suspend();
    await expect(turn).rejects.toMatchObject({ code: 'HOST_SUSPENDED' });
    await settle();
    expect(r.cancelled()).toEqual(['local-1']);
    expect(r.events(1, 'llamaEnd')).toEqual([]);
    // The slot is held until the host has actually stopped.
    expect(r.broker.slotCount).toBe(1);

    r.finish('local-1', 'cancelled');
    await settle();
    expect(r.events<GenerationEndEvent>(1, 'llamaEnd')).toEqual([
      expect.objectContaining({ requestId: 'local-1', stopReason: 'cancelled' }),
    ]);
    expect(r.broker.slotCount).toBe(0);
  });

  it('a long generation that keeps producing tokens is never ended by the broker’s deadline', async () => {
    // FAULT INJECTED: making `withTurnProgress` skip `broker.progress` ended the
    // turn DEADLINE at 150 s, cancelling it in the host mid-answer.
    const r = rig();
    r.subscribe(1);
    const turn = r.generate(1, 'long');
    await settle();

    for (let i = 0; i < 5; i += 1) {
      await r.clock.advance(100_000);
      r.token('long', i);
    }
    // Five hundred seconds of answer, never idle long enough for either deadline.
    expect(r.broker.positionOf({ kind: 'window', id: 1 }, 'long')).toBe(0);
    expect(r.cancelled()).toEqual([]);

    r.finish('long');
    expect(await turn).toMatchObject({ stopReason: 'stop' });
  });
});

/* ══ Teardown ═══════════════════════════════════════════════════════════ */

describe('a window that goes away takes its turns out of the broker AND the fleet', () => {
  it('its waiting turn never starts, its running turn is released by the fleet, and the next owner’s turn starts', async () => {
    // FAULT INJECTED, both halves. Removing `broker.releaseWindow` from
    // `releaseRenderer` started `waiting` on the host for a window that was
    // gone; removing `fleet.releaseRenderer` left the Supervisor tracking
    // `running`.
    const r = rig();
    r.subscribe(1);
    r.subscribe(2);
    const running = r.generate(1, 'running');
    await settle();
    const waiting = r.generate(1, 'waiting');
    const other = r.generate(2, 'other');
    await settle();
    expect(r.generated()).toEqual(['running']);

    r.localTurns.releaseRenderer(1, 'The window that started this generation was closed.');
    await expect(waiting).rejects.toMatchObject({ code: 'OWNER_LOST' });
    await expect(running).rejects.toMatchObject({ code: 'OWNER_LOST' });
    await settle();

    // The one turn the Supervisor still tracks is window 2's, which started
    // once the released turn's work had actually returned.
    expect(r.fleet.supervisorFor(LLAMA_PLUGIN.name).inflightCount).toBe(1);
    expect(r.generated()).toEqual(['running', 'other']);
    expect(r.events(1, 'llamaEnd')).toEqual([]);
    r.finish('other');
    await other;
  });
});

/* ══ The shape of the wiring ════════════════════════════════════════════ */

describe('the wrapper changes generate, cancel and benchmark, and nothing else', () => {
  it('every other method is the facade’s own and takes no slot', async () => {
    const r = rig();
    r.phoneTurn('p');
    await expect(r.pluginHost.invoke(1, LLAMA_PLUGIN.name, 'getCapabilities', [])).resolves.toEqual({
      simulated: true,
    });
    expect(r.broker.waitingCount).toBe(0);
  });

  it('LOCAL_TURNS_PLUGIN is llama.cpp plus the waiting event and the turn’s end, and the host cannot emit that event', async () => {
    expect(LOCAL_TURNS_PLUGIN.name).toBe(LLAMA_PLUGIN.name);
    // The renderer's reach grows by the one method main answers itself, and
    // the host protocol by nothing.
    expect(LOCAL_TURNS_PLUGIN.methods).toEqual([...LLAMA_METHODS, TURN_END_METHOD]);
    expect(LLAMA_PLUGIN.methods).not.toContain(TURN_END_METHOD);
    expect(LOCAL_TURNS_PLUGIN.events).toEqual([...LLAMA_EVENTS, TURN_WAITING_EVENT]);
    expect(LLAMA_PLUGIN.events).not.toContain(TURN_WAITING_EVENT);

    // A host that emits it anyway is dropped by the Supervisor, which serves
    // the plain definition: a waiting state is main's to say, not the host's.
    const r = rig();
    r.subscribe(1);
    const turn = r.generate(1, 'local-1');
    await settle();
    expect(r.fleet.supervisorFor(LLAMA_PLUGIN.name).inflightCount).toBe(1);

    r.hostSend({
      k: 'ev',
      plugin: LLAMA_PLUGIN.name,
      name: TURN_WAITING_EVENT,
      data: { requestId: 'local-1', position: 5 },
    });
    await settle();
    expect(r.events(1, TURN_WAITING_EVENT)).toEqual([]);
    expect(r.warnings).toContain(`inference host sent "${TURN_WAITING_EVENT}", which "${LLAMA_PLUGIN.name}" does not declare.`);

    r.finish('local-1');
    await turn;
  });

  it('refuses, at boot, a facade that is not the one the fleet builds', () => {
    const r = rig();
    const facade = r.fleet.plugin(LLAMA_PLUGIN.name) as unknown as Record<string | symbol, unknown>;
    const notify: NotifyListeners = () => undefined;

    const missing = { ...facade };
    delete missing['benchmark'];
    expect(() =>
      admitLocalTurns({ broker: r.broker, facade: missing as unknown as PluginImplementation, fleet: r.fleet, notices: r.notices, notify }),
    ).toThrow(/has no "benchmark"/);

    const unscoped = { ...facade, [SENDER_SCOPED]: ['generate'] };
    expect(() =>
      admitLocalTurns({ broker: r.broker, facade: unscoped as unknown as PluginImplementation, fleet: r.fleet, notices: r.notices, notify }),
    ).toThrow(/must scope exactly/);
  });

  it('withTurnProgress forwards every event unchanged, and a throwing notify still throws', () => {
    const r = rig();
    const seen: unknown[] = [];
    withTurnProgress(r.broker, (...args) => seen.push(args))('LlamaCpp', 'llamaThermal', { state: 'nominal' });
    expect(seen).toEqual([['LlamaCpp', 'llamaThermal', { state: 'nominal' }, undefined]]);
    // Defect [13]: the Supervisor must see a delivery that threw.
    expect(() =>
      withTurnProgress(r.broker, () => {
        throw new Error('not cloneable');
      })('LlamaCpp', 'llamaToken', { requestId: 'x' }, 1),
    ).toThrow('not cloneable');
  });
});

/* ══ A benchmark decodes, so it takes the slot ══════════════════════════ */

describe('a benchmark takes the one slot too, and does not wait for it', () => {
  it('is refused SLOT_BUSY while a turn holds the slot, and a phone unit and a desktop turn wait behind a running one', async () => {
    // Review: `benchmark` was forwarded straight to the facade, so it decoded
    // beside whatever held the slot (#7 ruling 3: one model on one GPU).
    // FAULT INJECTED: forwarding `benchmark` to the facade (the BENCHMARK case
    // removed from `admitLocalTurns`) sent it to the host while `local-1` was
    // generating, and this test failed on `benchmarkArgs()`.
    const r = rig();
    r.subscribe(1);
    const turn = r.generate(1, 'local-1');
    await settle();
    await expect(r.benchmark(2)).rejects.toMatchObject({ code: 'SLOT_BUSY' });
    expect(r.benchmarkArgs()).toEqual([]);
    expect(r.broker.waitingCount).toBe(0);
    r.finish('local-1');
    await turn;
    await settle();

    const bench = r.benchmark(2);
    await settle();
    // Sent once, with the page's options alone: the window id stays in main.
    expect(r.benchmarkArgs()).toEqual([[{ handle: 'h' }]]);
    expect(r.broker.slotCount).toBe(1);

    const phone = r.phoneTurn('p1');
    const local = r.generate(1, 'local-2');
    await settle();
    expect(phone.starts).toBe(0);
    expect(r.generated()).toEqual(['local-1']);
    expect(r.events<TurnWaitingEvent>(1, TURN_WAITING_EVENT)).toEqual([{ requestId: 'local-2', position: 2 }]);

    r.finishBenchmark({ generateTokensPerSecond: 1 });
    await expect(bench).resolves.toEqual({ generateTokensPerSecond: 1 });
    await settle();
    expect(phone.starts).toBe(1);
    phone.resolve('done');
    await settle();
    expect(r.generated()).toEqual(['local-1', 'local-2']);
    r.finish('local-2');
    await local;
  });
});

/* ══ S5's worker window ═════════════════════════════════════════════════ */

describe('a worker window’s generations run under the unit it runs, not behind it', () => {
  const WORKER = 7;
  const hosted = { owner: { kind: 'device', id: 'phone' } as const, unitId: 'phone-turn' };
  const workerRig = () => rig({ hostedUnitOf: (senderId) => (senderId === WORKER ? hosted : undefined) });

  it('a phone unit whose work generates through the plugin reaches the host at once, keeps the one slot, and its tokens are its progress', async () => {
    // Review repro: with the worker's generate admitted as a window unit of its
    // own, it waited at position 1 behind the phone unit that was waiting on
    // it; the phone unit ended DEADLINE and nothing ran again until quit.
    // FAULT INJECTED: ignoring `hostedUnitOf` in `generate` left `worker-gen`
    // waiting and failed on `generated()`; ignoring it in `withTurnProgress`
    // ended the phone unit DEADLINE mid-answer and failed on `isRunning`.
    const r = workerRig();
    r.subscribe(WORKER);
    r.subscribe(1);
    let inner: Promise<unknown> = Promise.resolve();
    const admission = r.broker.admit({
      owner: hosted.owner,
      unitId: hosted.unitId,
      executor: 'worker',
      start: () => {
        inner = r.generate(WORKER, 'worker-gen');
        return inner;
      },
    });
    expect(admission.admitted).toBe(true);
    await settle();
    expect(r.generated()).toEqual(['worker-gen']);
    expect(r.broker.slotCount).toBe(1);
    expect(r.broker.positionOf({ kind: 'window', id: WORKER }, 'worker-gen')).toBeUndefined();

    // A user's window still waits behind the phone's turn.
    const local = r.generate(1, 'local-1');
    await settle();
    expect(r.events<TurnWaitingEvent>(1, TURN_WAITING_EVENT)).toEqual([{ requestId: 'local-1', position: 1 }]);

    let elapsed = 0;
    for (let index = 0; elapsed <= 2 * UNIT_IDLE_TIMEOUT_MS; index += 1) {
      await r.clock.advance(100_000);
      elapsed += 100_000;
      r.token('worker-gen', index);
    }
    expect(r.broker.isRunning(hosted.owner, hosted.unitId)).toBe(true);

    r.finish('worker-gen');
    await inner;
    await settle();
    expect(r.events<GenerationEndEvent>(WORKER, 'llamaEnd')).toHaveLength(1);
    expect(r.generated()).toEqual(['worker-gen', 'local-1']);
    r.finish('local-1');
    await local;
  });

  it('a worker whose unit is not running may not generate, and one generate at a time runs under a unit that is', async () => {
    // FAULT INJECTED: removing the `isRunning` check from `generateHosted`
    // sent `too-early` to the host; removing `hostedBusy` sent `second`.
    const r = workerRig();
    r.subscribe(WORKER);
    r.subscribe(1);
    await expect(r.generate(WORKER, 'too-early')).rejects.toMatchObject({ code: 'NOT_RUNNING' });

    const blocker = r.generate(1, 'blocker');
    await settle();
    const job = work();
    expect(
      r.broker.admit({ owner: hosted.owner, unitId: hosted.unitId, executor: 'worker', start: job.start }),
    ).toMatchObject({ admitted: true, position: 1 });
    await expect(r.generate(WORKER, 'still-waiting')).rejects.toMatchObject({ code: 'NOT_RUNNING' });
    expect(r.generated()).toEqual(['blocker']);
    // Refused before it started: no llamaEnd, as for any refused generate.
    expect(r.events(WORKER, 'llamaEnd')).toEqual([]);

    r.finish('blocker');
    await blocker;
    await settle();
    expect(job.starts).toBe(1);
    const first = r.generate(WORKER, 'first');
    await settle();
    await expect(r.generate(WORKER, 'second')).rejects.toMatchObject({ code: 'SLOT_BUSY' });
    expect(r.generated()).toEqual(['blocker', 'first']);
    r.finish('first');
    await first;
    const third = r.generate(WORKER, 'third');
    await settle();
    expect(r.generated()).toEqual(['blocker', 'first', 'third']);
    r.finish('third');
    await third;
    job.resolve('done');
  });
});

/* ══ Nothing remembered for a window that went away ═════════════════════ */

describe('the waiting notifier forgets a window that went away', () => {
  it('a window closed while its turn waited leaves nothing remembered for it', async () => {
    // Review: `localTurnNotices` remembered a waiting turn until it started or
    // ended, and the broker tells a closed window neither, so one entry per
    // such window stayed for the life of the app.
    // FAULT INJECTED: dropping `notices.release` from `releaseRenderer` let the
    // `started` below emit position 0, and this test failed.
    const r = rig();
    r.subscribe(1);
    r.phoneTurn('p');
    const waiting = r.generate(1, 'local-1');
    await settle();
    expect(r.events<TurnWaitingEvent>(1, TURN_WAITING_EVENT)).toEqual([{ requestId: 'local-1', position: 1 }]);

    r.localTurns.releaseRenderer(1, 'The window was closed.');
    await expect(waiting).rejects.toMatchObject({ code: 'OWNER_LOST' });
    r.notices(1, { kind: 'started', unitId: 'local-1' });
    expect(r.events<TurnWaitingEvent>(1, TURN_WAITING_EVENT)).toEqual([{ requestId: 'local-1', position: 1 }]);
  });
});

/* ══ A desktop turn holds the slot for the whole turn ═══════════════════ */

/**
 * OWNER RULING ON #7: a desktop turn keeps the one slot from its first decode
 * until the turn settles, its tool calls included, and a phone turn waits for
 * the whole desktop turn. #169's "one turn at a time" is one turn, not one
 * decode.
 *
 * The page's streamed turn sends every decode with `wholeTurn: true` and says
 * when the turn is over with `endTurn`. A turn's later decodes run under the
 * unit its first decode was admitted as. Rejected by the ruling, and so pinned
 * against here: a phone unit starting between two decodes, and a hold that
 * gives the slot up after a long tool call.
 */
describe('a desktop turn holds the one slot from its first decode until the page ends the turn', () => {
  const PHONE = { kind: 'device', id: 'phone' } as const;
  const WINDOW_1 = { kind: 'window', id: 1 } as const;

  /** One decode of a whole turn, answered by the host. */
  async function decoded(r: ReturnType<typeof rig>, senderId: number, requestId: string): Promise<void> {
    const decode = r.generate(senderId, requestId, { wholeTurn: true });
    await settle();
    r.token(requestId, 0);
    r.finish(requestId);
    await decode;
    await settle();
  }

  it('a phone unit queued between two decodes waits, however long the tool runs, and the next decode neither waits nor is told it waits', async () => {
    const r = rig();
    r.subscribe(1);
    await decoded(r, 1, 'turn');

    // Between two decodes: the page is running a tool call.
    const phone = r.phoneTurn('phone-1');
    expect(r.broker.positionOf(PHONE, 'phone-1'), 'the phone waits behind the desktop turn').toBe(1);
    // Three times the broker's idle deadline of tool call, with no progress:
    // the ruling rejected a hold that yields after a long tool call.
    for (let round = 0; round < 3; round += 1) await r.clock.advance(UNIT_IDLE_TIMEOUT_MS);
    expect(phone.starts, 'a phone unit ran between two decodes of one desktop turn').toBe(0);
    expect(r.broker.isRunning(WINDOW_1, 'turn')).toBe(true);

    const second = r.generate(1, 'turn', { wholeTurn: true });
    await settle();
    expect(r.generated(), 'the second decode reaches the host at once').toEqual(['turn', 'turn']);
    expect(r.events(1, TURN_WAITING_EVENT), 'waiting told for the desktop turn').toEqual([]);
    expect(r.broker.waitingCount, 'only the phone waits').toBe(1);
    r.token('turn', 0);
    r.finish('turn');
    await second;
    await settle();
    expect(phone.starts, 'the phone started when a decode ended, not when the turn did').toBe(0);

    await r.endTurn(1, 'turn');
    await settle();
    expect(phone.starts).toBe(1);
    expect(r.events<GenerationEndEvent>(1, 'llamaEnd'), 'one llamaEnd per decode').toHaveLength(2);

    // Given back once: a second end changes nothing for the phone now holding
    // the slot, and the window's next turn waits for it.
    await r.endTurn(1, 'turn');
    expect(r.broker.isRunning(PHONE, 'phone-1')).toBe(true);
    const next = r.generate(1, 'next', { wholeTurn: true });
    await settle();
    expect(r.events<TurnWaitingEvent>(1, TURN_WAITING_EVENT)).toEqual([{ requestId: 'next', position: 1 }]);
    phone.resolve('done');
    await settle();
    expect(r.generated()).toEqual(['turn', 'turn', 'next']);
    r.finish('next');
    await next;
    await r.endTurn(1, 'next');
    await settle();
    expect(r.broker.slotCount).toBe(0);
    // The host is sent the page's options without the flag: holding the slot
    // is main's business, not the inference host's.
    expect(r.generateArgs()[0]).toEqual({ handle: 'h', prompt: 'p', requestId: 'turn' });
  });

  it('a benchmark asked for between two decodes of a desktop turn is refused SLOT_BUSY, from any window', async () => {
    const r = rig();
    r.subscribe(1);
    await decoded(r, 1, 'turn');
    const fromItsWindow = r.benchmark(1);
    const fromAnother = r.benchmark(2);
    await settle();
    expect(r.benchmarkArgs(), 'a benchmark reached the host between two decodes of a desktop turn').toEqual([]);
    await expect(fromItsWindow).rejects.toMatchObject({ code: 'SLOT_BUSY' });
    await expect(fromAnother).rejects.toMatchObject({ code: 'SLOT_BUSY' });

    await r.endTurn(1, 'turn');
    await settle();
    const bench = r.benchmark(2);
    await settle();
    expect(r.benchmarkArgs()).toHaveLength(1);
    r.finishBenchmark({ generateTokensPerSecond: 1 });
    await expect(bench).resolves.toEqual({ generateTokensPerSecond: 1 });
  });

  it('ended while a decode runs: the decode is cancelled in the host, and the slot is given back once the host has stopped', async () => {
    const r = rig();
    r.subscribe(1);
    const decode = r.generate(1, 'turn', { wholeTurn: true });
    await settle();
    const phone = r.phoneTurn('phone-1');

    await r.endTurn(1, 'turn');
    await settle();
    expect(r.cancelled()).toEqual(['turn']);
    expect(phone.starts, 'the slot was given back while the host still decoded').toBe(0);
    expect(r.broker.slotCount).toBe(1);

    r.finish('turn', 'cancelled');
    expect(await decode).toMatchObject({ requestId: 'turn', stopReason: 'cancelled' });
    await settle();
    expect(phone.starts).toBe(1);
    expect(r.events(1, 'llamaEnd')).toHaveLength(1);
  });

  it('a decode that fails keeps the turn’s slot: the page decides whether the turn goes on, and its next decode runs under it', async () => {
    const r = rig();
    r.subscribe(1);
    const first = r.generate(1, 'turn', { wholeTurn: true });
    await settle();
    const phone = r.phoneTurn('phone-1');
    r.failDecode('turn', 'the model could not answer');
    await expect(first).rejects.toThrow('the model could not answer');
    await settle();
    expect(phone.starts).toBe(0);

    const second = r.generate(1, 'turn', { wholeTurn: true });
    await settle();
    expect(r.generated()).toEqual(['turn', 'turn']);
    r.finish('turn');
    await second;
    await r.endTurn(1, 'turn');
    await settle();
    expect(phone.starts).toBe(1);
  });

  it('ended by the broker between decodes (a suspend): the slot is free at once, and a later decode of that turn is refused and never reaches the host', async () => {
    const r = rig();
    r.subscribe(1);
    await decoded(r, 1, 'turn');

    r.broker.suspend();
    await settle();
    expect(r.broker.slotCount, 'a turn with nothing decoding kept the slot after its end').toBe(0);
    r.broker.resume();

    const later = r.generate(1, 'turn', { wholeTurn: true });
    await settle();
    expect(r.generated(), 'a decode of a turn the broker had ended reached the host').toEqual(['turn']);
    await expect(later).rejects.toMatchObject({ code: 'HOST_SUSPENDED' });
    // The refused decode never started: no llamaEnd for it.
    expect(r.events(1, 'llamaEnd')).toHaveLength(1);
    expect(r.broker.waitingCount).toBe(0);
    await r.endTurn(1, 'turn');

    // And the window's next turn starts at once.
    const next = r.generate(1, 'next', { wholeTurn: true });
    await settle();
    expect(r.generated()).toEqual(['turn', 'next']);
    r.finish('next');
    await next;
    await r.endTurn(1, 'next');
  });

  it('its window goes away: between decodes the slot is free at once, and during one it is free once the fleet has stopped the decode', async () => {
    const r = rig();
    r.subscribe(1);
    await decoded(r, 1, 'between');
    const phone = r.phoneTurn('phone-1');
    r.localTurns.releaseRenderer(1, 'The window was closed.');
    await settle();
    expect(phone.starts).toBe(1);
    phone.resolve('done');
    await settle();
    expect(r.broker.slotCount).toBe(0);

    r.subscribe(2);
    const during = r.generate(2, 'during', { wholeTurn: true });
    await settle();
    const phone2 = r.phoneTurn('phone-2');
    r.localTurns.releaseRenderer(2, 'The window was closed.');
    await expect(during).rejects.toMatchObject({ code: 'OWNER_LOST' });
    await settle();
    expect(phone2.starts).toBe(1);
    expect(r.fleet.supervisorFor(LLAMA_PLUGIN.name).inflightCount).toBe(0);
    expect(r.events(2, 'llamaEnd')).toEqual([]);
  });

  it('cancelled while its first decode still waits: it never holds the slot, gets one cancelled llamaEnd, and its end afterwards is nothing', async () => {
    const r = rig();
    r.subscribe(1);
    const phone = r.phoneTurn('phone-1');
    const waiting = r.generate(1, 'turn', { wholeTurn: true });
    await settle();

    await r.cancel(1, 'turn');
    expect(await waiting).toMatchObject({ requestId: 'turn', stopReason: 'cancelled' });
    await r.endTurn(1, 'turn');
    expect(r.broker.isRunning(PHONE, 'phone-1')).toBe(true);
    phone.resolve('done');
    await settle();
    expect(r.generated()).toEqual([]);
    expect(r.broker.slotCount).toBe(0);
    expect(r.events<GenerationEndEvent>(1, 'llamaEnd')).toEqual([
      expect.objectContaining({ requestId: 'turn', stopReason: 'cancelled' }),
    ]);
  });

  it('ended while its first decode still waits: that decode never starts, and gets one cancelled llamaEnd', async () => {
    const r = rig();
    r.subscribe(1);
    const phone = r.phoneTurn('phone-1');
    const waiting = r.generate(1, 'turn', { wholeTurn: true });
    await settle();
    expect(r.broker.positionOf(WINDOW_1, 'turn')).toBe(1);

    await r.endTurn(1, 'turn');
    expect(await waiting).toMatchObject({ requestId: 'turn', stopReason: 'cancelled' });
    expect(r.broker.positionOf(WINDOW_1, 'turn'), 'a turn its page had ended still waits for the slot').toBeUndefined();
    phone.resolve('done');
    await settle();
    expect(r.generated()).toEqual([]);
    expect(r.broker.slotCount).toBe(0);
    expect(r.events<GenerationEndEvent>(1, 'llamaEnd')).toEqual([
      expect.objectContaining({ requestId: 'turn', stopReason: 'cancelled' }),
    ]);
  });

  it('only its own window ends the turn, and one decode at a time runs under it', async () => {
    const r = rig();
    r.subscribe(1);
    r.subscribe(2);
    const first = r.generate(1, 'turn', { wholeTurn: true });
    await settle();
    await expect(r.generate(1, 'turn', { wholeTurn: true })).rejects.toMatchObject({ code: 'DUPLICATE_UNIT' });
    expect(r.generated()).toEqual(['turn']);
    r.finish('turn');
    await first;
    await settle();

    const phone = r.phoneTurn('phone-1');
    await r.endTurn(2, 'turn');
    await settle();
    expect(phone.starts, 'another window ended this window’s turn').toBe(0);
    expect(r.broker.isRunning(WINDOW_1, 'turn')).toBe(true);
    await r.endTurn(1, 'turn');
    await settle();
    expect(phone.starts).toBe(1);
  });

  it('the broker’s backstop still covers a later decode: one that makes no progress for UNIT_IDLE_TIMEOUT_MS is ended DEADLINE', async () => {
    // The Supervisor's own idle deadline is moved out of the way, so this is
    // the broker's alone.
    const r = rig({ policy: { generateIdleTimeoutMs: 10 * UNIT_IDLE_TIMEOUT_MS } });
    r.subscribe(1);
    await decoded(r, 1, 'turn');
    await r.clock.advance(2 * UNIT_IDLE_TIMEOUT_MS);

    const second = r.generate(1, 'turn', { wholeTurn: true });
    await settle();
    expect(r.generated()).toEqual(['turn', 'turn']);
    await r.clock.advance(UNIT_IDLE_TIMEOUT_MS);
    expect(r.cancelled(), 'the broker never ended a later decode that made no progress').toEqual(['turn']);
    r.finish('turn', 'cancelled');
    await expect(second).rejects.toMatchObject({ code: 'DEADLINE' });
    await settle();
    expect(r.broker.slotCount).toBe(0);
  });

  it('a worker window’s tool loop runs under its phone unit as before: its flag and its end change nothing about that unit', async () => {
    const WORKER = 7;
    const hosted = { owner: PHONE, unitId: 'phone-turn' };
    const r = rig({ hostedUnitOf: (senderId) => (senderId === WORKER ? hosted : undefined) });
    r.subscribe(WORKER);
    r.subscribe(1);
    const job = work();
    expect(r.broker.admit({ owner: hosted.owner, unitId: hosted.unitId, executor: 'worker', start: job.start })).toMatchObject({
      admitted: true,
      position: 0,
    });

    await decoded(r, WORKER, 'worker-turn');
    // Between the worker's decodes, a user's turn waits behind the phone's.
    const local = r.generate(1, 'local', { wholeTurn: true });
    await settle();
    expect(r.events<TurnWaitingEvent>(1, TURN_WAITING_EVENT)).toEqual([{ requestId: 'local', position: 1 }]);

    await decoded(r, WORKER, 'worker-turn');
    expect(r.generated()).toEqual(['worker-turn', 'worker-turn']);
    // The worker's engine ends its turn. The phone's unit is its work's to end.
    await r.endTurn(WORKER, 'worker-turn');
    await settle();
    expect(r.broker.isRunning(hosted.owner, hosted.unitId)).toBe(true);
    expect(r.generated()).toEqual(['worker-turn', 'worker-turn']);
    expect(r.generateArgs()[0]).toEqual({ handle: 'h', prompt: 'p', requestId: 'worker-turn' });

    job.resolve('the phone’s answer');
    await settle();
    expect(r.generated()).toEqual(['worker-turn', 'worker-turn', 'local']);
    r.finish('local');
    await local;
    await r.endTurn(1, 'local');
    await settle();
    expect(r.broker.slotCount).toBe(0);
  });
});
