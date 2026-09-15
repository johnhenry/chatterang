import { describe, expect, it } from 'vitest';

import type { GenerateOptions, GenerationEndEvent } from '@chatterang/contracts';
import {
  HostFleet,
  LISTENER_ADD_CHANNEL,
  LLAMA_ENGINE,
  LLAMA_PLUGIN,
  LOCAL_TURNS_PLUGIN,
  PluginHost,
  TURN_END_METHOD,
  WorkBroker,
  admitLocalTurns,
  createMainRouter,
  localTurnNotices,
  methodChannel,
  withTurnProgress,
} from '@chatterang/desktop/bridge';
import type {
  EventPayload,
  HostCall,
  HostMessage,
  InvokeResult,
  NotifyListeners,
  Owner,
  SupervisorTimers,
  UnitRequest,
} from '@chatterang/desktop/bridge';
import { wirePowerEvents } from '@chatterang/desktop/bridge/power-events';
import type { PowerEvent, PowerEventSource } from '@chatterang/desktop/bridge/power-events';

/**
 * #7 RULING 7: NO KEEP-AWAKE. ON SLEEP, STOP ADMITTING AND SETTLE RUNNING WORK
 * WITH A DEFINED REASON.
 *
 * `WorkBroker.suspend()` and `resume()` implement the ruling, but until this
 * unit nothing called them: `main.ts` never listened to Electron's
 * `powerMonitor`. `apps/desktop/src/bridge/power-events.ts` is the join, kept
 * platform-free so it can be driven here; `main.ts` passing it the real
 * `powerMonitor` and the one broker is pinned as text in
 * `tests/desktop-security.test.ts`.
 *
 * The power source is a double with EventEmitter's listener semantics (a
 * listener added twice is there twice; `removeListener` removes one instance,
 * by identity). The broker is real, and so is everything between the window
 * and the llama host in the second half: the main router, `PluginHost`,
 * `admitLocalTurns`, `HostFleet` and its `Supervisor`. Only the llama host is a
 * double, and the clock never moves. Nothing here keeps a computer awake, and no
 * listener or socket is started.
 */

/* ── Doubles ──────────────────────────────────────────────────────────── */

interface FakePowerSource extends PowerEventSource {
  emit(event: PowerEvent): void;
  count(event: PowerEvent): number;
}

function powerSource(): FakePowerSource {
  const listeners: Record<PowerEvent, (() => void)[]> = { suspend: [], resume: [] };
  const on = (event: PowerEvent, listener: () => void): void => {
    listeners[event].push(listener);
  };
  const removeListener = (event: PowerEvent, listener: () => void): void => {
    const at = listeners[event].lastIndexOf(listener);
    if (at >= 0) listeners[event].splice(at, 1);
  };
  return {
    on,
    removeListener,
    emit: (event) => {
      for (const listener of [...listeners[event]]) listener();
    },
    count: (event) => listeners[event].length,
  };
}

/** A clock that never moves: no deadline, ping or tick fires in these tests. */
const stillClock: SupervisorTimers = {
  now: () => 0,
  every: () => () => undefined,
  after: () => () => undefined,
};

const settle = async (): Promise<void> => {
  await new Promise((done) => setTimeout(done, 5));
};

const WINDOW: Owner = { kind: 'window', id: 1 };

/** Work that runs until it is told to stop, and then stops, as a decode does. */
function executor(): { readonly signals: AbortSignal[]; request(unitId: string): UnitRequest } {
  const signals: AbortSignal[] = [];
  return {
    signals,
    request: (unitId) => ({
      owner: WINDOW,
      unitId,
      executor: 'llama',
      start: (signal) => {
        signals.push(signal);
        return new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('stopped')), { once: true });
        });
      },
    }),
  };
}

function brokerRig() {
  const source = powerSource();
  const broker = new WorkBroker({ notifyWindow: () => true, timers: stillClock });
  const work = executor();
  const dispose = wirePowerEvents(source, broker);
  return { source, broker, work, dispose };
}

/* ══ The join: the power source reaches the broker ══════════════════════ */

describe('sleep and wake reach the work broker (#7 ruling 7)', () => {
  it('on suspend, a running local unit ends HOST_SUSPENDED and its work is told to stop', async () => {
    // MUTATION: the 'suspend' listener calling `broker.resume()` fails this
    // test: the unit is still running after the sleep.
    const { source, broker, work } = brokerRig();
    const admission = broker.admit(work.request('local-1'));
    expect(admission).toMatchObject({ admitted: true, position: 0 });
    if (!admission.admitted) return;
    expect(broker.isRunning(WINDOW, 'local-1')).toBe(true);

    source.emit('suspend');

    expect(broker.isRunning(WINDOW, 'local-1'), 'a running unit survived the sleep').toBe(false);
    expect(broker.admitting).toBe(false);
    expect(work.signals[0]?.aborted, 'the unit’s work was not told to stop').toBe(true);
    expect(await admission.settled).toMatchObject({ unitId: 'local-1', end: 'HOST_SUSPENDED', started: true });
    // The slot is given back once the work has stopped.
    await settle();
    expect(broker.slotCount).toBe(0);
  });

  it('while suspended, an admit is refused HOST_SUSPENDED and its work never starts', () => {
    const { source, broker, work } = brokerRig();
    source.emit('suspend');

    expect(broker.admit(work.request('local-2'))).toEqual({ admitted: false, refusal: 'HOST_SUSPENDED' });
    expect(work.signals).toHaveLength(0);
    expect(broker.waitingCount).toBe(0);
  });

  it('after resume, a new admit starts at once', async () => {
    // MUTATION: registering only 'suspend' fails this test: the admit after the
    // wake is refused HOST_SUSPENDED.
    const { source, broker, work } = brokerRig();
    const before = broker.admit(work.request('local-1'));
    source.emit('suspend');
    await settle();
    expect(broker.slotCount).toBe(0);

    source.emit('resume');

    expect(broker.admitting, 'the wake did not reach the broker').toBe(true);
    const after = broker.admit(work.request('local-3'));
    expect(after).toMatchObject({ admitted: true, position: 0 });
    expect(broker.isRunning(WINDOW, 'local-3')).toBe(true);
    expect(work.signals).toHaveLength(2);
    void before;
  });

  it('the disposer removes both listeners, so a later sleep or wake reaches nothing', () => {
    // MUTATION: a disposer that removes new functions rather than the ones it
    // added (or removes nothing) fails this test on the listener counts.
    const { source, broker, work, dispose } = brokerRig();
    expect(source.count('suspend')).toBe(1);
    expect(source.count('resume')).toBe(1);

    dispose();
    expect(source.count('suspend'), 'the suspend listener leaked').toBe(0);
    expect(source.count('resume'), 'the resume listener leaked').toBe(0);

    // A sleep after disposal ends nothing.
    broker.admit(work.request('local-1'));
    source.emit('suspend');
    expect(broker.isRunning(WINDOW, 'local-1')).toBe(true);
    expect(broker.admitting).toBe(true);

    // And a wake after disposal admits nothing: suspended directly, it stays so.
    broker.suspend();
    source.emit('resume');
    expect(broker.admitting).toBe(false);
  });
});

/* ══ What the person at the desktop sees ════════════════════════════════ */

/**
 * The first shipped consequence of this unit: a desktop window can now be told
 * `local-turns.ts`'s HOST_SUSPENDED sentences, because a real sleep now
 * reaches the broker. Driven from the window's side of the IPC boundary: the
 * main router's `InvokeResult` is exactly what `ipcMain.handle` returns to the
 * renderer, and events are what `PluginHost` delivers to that window.
 */
const SLEPT = 'The generation stopped because the computer went to sleep.';
const ASLEEP = 'The computer is going to sleep, so no generation can start.';

function windowRig() {
  const hostPosts: HostMessage[] = [];
  const hostListeners: ((message: unknown) => void)[] = [];
  const answered = new Set<number>();
  const hostSend = (message: HostMessage): void => {
    for (const listener of hostListeners) listener(message);
  };

  const delivered: { senderId: number; payload: EventPayload }[] = [];
  const pluginHost = new PluginHost((senderId, payload) => {
    delivered.push({ senderId, payload: structuredClone(payload) as EventPayload });
    return true;
  });
  const notify: NotifyListeners = (pluginName, eventName, data, ownerId) =>
    pluginHost.notifyListeners(pluginName, eventName, data, ownerId);

  // `main.ts`'s order: the broker, the power events on it, the fleet, the slot.
  const notices = localTurnNotices(notify);
  const broker = new WorkBroker({ notifyWindow: notices, timers: stillClock });
  const source = powerSource();
  wirePowerEvents(source, broker);
  const fleet = new HostFleet({
    spawn: () => ({
      link: {
        postMessage: (raw) => {
          const message = raw as HostMessage;
          hostPosts.push(message);
          if (message.k === 'ping') hostSend({ k: 'pong', id: message.id });
          if (message.k === 'call' && message.method !== 'generate') {
            hostSend({ k: 'ret', id: message.id, ok: true, data: null });
          }
        },
        onMessage: (listener) => hostListeners.push(listener),
        onClose: () => undefined,
      },
      kill: () => undefined,
    }),
    notify: withTurnProgress(broker, notify),
    entries: [{ engine: LLAMA_ENGINE, host: 'llama' }],
    warn: () => undefined,
    timers: stillClock,
  });
  const localTurns = admitLocalTurns({ broker, facade: fleet.plugin(LLAMA_PLUGIN.name), fleet, notices, notify });
  pluginHost.register(LOCAL_TURNS_PLUGIN, localTurns.plugin);
  const router = createMainRouter(pluginHost);

  const calls = (method: string): HostCall[] =>
    hostPosts.filter((m): m is HostCall => m.k === 'call' && m.method === method);

  return {
    broker,
    source,
    /** What a chat turn sends: one decode of a turn that holds the slot until the page ends it. */
    generate(senderId: number, requestId: string): Promise<InvokeResult> {
      const request: GenerateOptions & { wholeTurn: true } = { handle: 'h', prompt: 'p', requestId, wholeTurn: true };
      return router.handle(senderId, methodChannel(LLAMA_PLUGIN.name, 'generate'), [request]);
    },
    endTurn(senderId: number, requestId: string): Promise<InvokeResult> {
      return router.handle(senderId, methodChannel(LLAMA_PLUGIN.name, TURN_END_METHOD), [{ requestId }]);
    },
    async subscribe(senderId: number, eventName: string): Promise<void> {
      const result = await router.handle(senderId, LISTENER_ADD_CHANNEL, {
        pluginName: LLAMA_PLUGIN.name,
        eventName,
        subscriptionId: delivered.length + 100,
      });
      expect(result).toEqual({ ok: true, data: undefined });
    },
    ends(senderId: number): GenerationEndEvent[] {
      return delivered
        .filter((entry) => entry.senderId === senderId && entry.payload.eventName === 'llamaEnd')
        .map((entry) => entry.payload.data as GenerationEndEvent);
    },
    generated: (): string[] => calls('generate').map((call) => (call.args[0] as GenerateOptions).requestId),
    cancelled: (): string[] => calls('cancel').map((call) => (call.args[0] as { requestId: string }).requestId),
    /** The host ends its oldest unanswered decode of `requestId` the way LlamaCppNode does. */
    finish(requestId: string, stopReason: GenerationEndEvent['stopReason']): void {
      const call = calls('generate').find(
        (entry) => (entry.args[0] as GenerateOptions).requestId === requestId && !answered.has(entry.id),
      );
      if (call === undefined) throw new Error(`the host was never asked to generate ${requestId}`);
      answered.add(call.id);
      const end: GenerationEndEvent = {
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
      hostSend({ k: 'ev', plugin: LLAMA_PLUGIN.name, name: 'llamaEnd', data: end });
      hostSend({ k: 'ret', id: call.id, ok: true, data: end });
    },
  };
}

describe('what the person at the desktop is told when the computer sleeps', () => {
  it('a turn decoding when the computer sleeps: stopped in the host, and the window is told it stopped because the computer went to sleep', async () => {
    const r = windowRig();
    await r.subscribe(1, 'llamaEnd');
    const turn = r.generate(1, 'local-1');
    await settle();
    expect(r.generated()).toEqual(['local-1']);

    r.source.emit('suspend');
    await settle();
    expect(r.cancelled(), 'the sleep did not stop the decode in the host').toEqual(['local-1']);

    r.finish('local-1', 'cancelled');
    expect(await turn).toEqual({ ok: false, error: { message: SLEPT, code: 'HOST_SUSPENDED' } });
    // Exactly one llamaEnd for the decode: the host's own.
    expect(r.ends(1)).toEqual([expect.objectContaining({ requestId: 'local-1', stopReason: 'cancelled' })]);
    expect(await r.endTurn(1, 'local-1')).toEqual({ ok: true, data: undefined });

    // Asked while the computer is asleep: refused, with its own sentence, and
    // the host never hears of it.
    expect(await r.generate(1, 'local-2')).toEqual({ ok: false, error: { message: ASLEEP, code: 'HOST_SUSPENDED' } });
    expect(r.generated()).toEqual(['local-1']);

    // Awake again: the window's next turn reaches the host and answers.
    r.source.emit('resume');
    const next = r.generate(1, 'local-3');
    await settle();
    expect(r.generated()).toEqual(['local-1', 'local-3']);
    r.finish('local-3', 'stop');
    expect(await next).toMatchObject({ ok: true, data: { requestId: 'local-3', stopReason: 'stop' } });
    await r.endTurn(1, 'local-3');
  });

  it('a turn waiting for the slot when the computer sleeps: its one llamaEnd carries the sentence, and the host never hears of it', async () => {
    const r = windowRig();
    await r.subscribe(1, 'llamaEnd');
    // A paired phone's unit holds the slot, admitted to the broker directly: no
    // listener exists, and none is started.
    const phone = r.broker.admit({
      owner: { kind: 'device', id: 'phone' },
      unitId: 'phone-1',
      executor: 'worker',
      start: (signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('stopped')), { once: true });
        }),
    });
    expect(phone).toMatchObject({ admitted: true, position: 0 });
    const turn = r.generate(1, 'local-1');
    await settle();
    expect(r.broker.positionOf(WINDOW, 'local-1')).toBe(1);

    r.source.emit('suspend');

    expect(await turn).toEqual({ ok: false, error: { message: SLEPT, code: 'HOST_SUSPENDED' } });
    await settle();
    expect(r.ends(1)).toEqual([
      expect.objectContaining({ requestId: 'local-1', stopReason: 'error', error: SLEPT }),
    ]);
    expect(r.generated()).toEqual([]);
    if (phone.admitted) expect(await phone.settled).toMatchObject({ end: 'HOST_SUSPENDED' });
  });
});
