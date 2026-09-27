import { describe, expect, it, vi } from 'vitest';
import type { CliDataEvent, CliExitEvent, CliPlugin } from '@/plugins/cli';

import { createCliTurnBridge } from '@/ai/backends/cli-bridge';

/**
 * createCliTurnBridge (#42, #115, #118), over a FAKE `CliPlugin` -- never
 * the real Capacitor registration and never a real process. What this file
 * measures: dispatch by `requestId` (so two turns in flight do not cross
 * wires), subscribe-before-start ordering, and `cancel()` reaching both
 * `cancelTurn` and the event subscriptions' `remove()`.
 */

function fakePlugin() {
  const dataListeners: ((event: CliDataEvent) => void)[] = [];
  const exitListeners: ((event: CliExitEvent) => void)[] = [];
  const removed: string[] = [];
  const startCalls: unknown[] = [];
  const cancelCalls: unknown[] = [];

  const plugin: CliPlugin = {
    discover: vi.fn(),
    startTurn: vi.fn(async (request) => {
      startCalls.push(request);
      return { requestId: request.requestId };
    }),
    cancelTurn: vi.fn(async (request) => {
      cancelCalls.push(request);
    }),
    addListener: vi.fn(async (eventName: 'cliData' | 'cliExit', listener: (event: never) => void) => {
      if (eventName === 'cliData') dataListeners.push(listener as (event: CliDataEvent) => void);
      else exitListeners.push(listener as (event: CliExitEvent) => void);
      return { remove: async () => void removed.push(eventName) };
    }) as CliPlugin['addListener'],
  };

  return {
    plugin,
    emitData: (event: CliDataEvent) => dataListeners.forEach((l) => l(event)),
    emitExit: (event: CliExitEvent) => exitListeners.forEach((l) => l(event)),
    startCalls,
    cancelCalls,
    removed,
  };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('createCliTurnBridge', () => {
  it('subscribes before calling startTurn, then dispatches events for its own requestId only', async () => {
    const fake = fakePlugin();
    const bridge = createCliTurnBridge(fake.plugin);

    const received: { chunk: Uint8Array; stream: string }[] = [];
    const handle = bridge.start({ cliId: 'claude', stdin: 'hi' });
    handle.onData((chunk, stream) => received.push({ chunk, stream }));

    await flushMicrotasks();
    expect(fake.startCalls).toHaveLength(1);
    const requestId = (fake.startCalls[0] as { requestId: string }).requestId;
    expect((fake.startCalls[0] as { cliId: string; stdin: string })).toMatchObject({ cliId: 'claude', stdin: 'hi' });

    // An event for a DIFFERENT requestId (a second, unrelated turn's) must
    // not be delivered to this handle.
    fake.emitData({ requestId: 'someone-elses-turn', chunk: new Uint8Array([1]), stream: 'stdout' });
    fake.emitData({ requestId, chunk: new Uint8Array([2]), stream: 'stdout' });

    expect(received).toHaveLength(1);
    expect(received[0]?.chunk).toEqual(new Uint8Array([2]));
  });

  it('dispatches cliExit the same way, by requestId', async () => {
    const fake = fakePlugin();
    const bridge = createCliTurnBridge(fake.plugin);
    const exits: unknown[] = [];
    const handle = bridge.start({ cliId: 'codex', stdin: 'hi' });
    handle.onExit((exit) => exits.push(exit));

    await flushMicrotasks();
    const requestId = (fake.startCalls[0] as { requestId: string }).requestId;
    fake.emitExit({ requestId: 'other', code: 1, signal: null });
    fake.emitExit({ requestId, code: 0, signal: null });

    expect(exits).toEqual([{ code: 0, signal: null }]);
  });

  it('cancel() calls cancelTurn with the same requestId and removes both subscriptions', async () => {
    const fake = fakePlugin();
    const bridge = createCliTurnBridge(fake.plugin);
    const handle = bridge.start({ cliId: 'claude', stdin: 'hi' });
    await flushMicrotasks();

    const startedRequestId = (fake.startCalls[0] as { requestId: string }).requestId;
    handle.cancel();
    await flushMicrotasks();

    expect(fake.cancelCalls).toEqual([{ requestId: startedRequestId }]);
    expect(fake.removed.sort()).toEqual(['cliData', 'cliExit']);
  });

  it('never calls startTurn when cancelled before subscriptions resolve', async () => {
    const fake = fakePlugin();
    const bridge = createCliTurnBridge(fake.plugin);
    const handle = bridge.start({ cliId: 'claude', stdin: 'hi' });
    handle.cancel(); // synchronously, before the addListener promises settle
    await flushMicrotasks();

    expect(fake.startCalls).toEqual([]);
  });

  it('two turns in flight at once never cross-deliver events', async () => {
    const fake = fakePlugin();
    const bridge = createCliTurnBridge(fake.plugin);
    const receivedA: unknown[] = [];
    const receivedB: unknown[] = [];
    const handleA = bridge.start({ cliId: 'claude', stdin: 'hi' });
    handleA.onData((chunk) => receivedA.push(chunk));
    const handleB = bridge.start({ cliId: 'codex', stdin: 'hi' });
    handleB.onData((chunk) => receivedB.push(chunk));

    await flushMicrotasks();
    const [idA, idB] = fake.startCalls.map((c) => (c as { requestId: string }).requestId);
    expect(idA).not.toBe(idB);

    fake.emitData({ requestId: idA!, chunk: new Uint8Array([1]), stream: 'stdout' });
    fake.emitData({ requestId: idB!, chunk: new Uint8Array([2]), stream: 'stdout' });

    expect(receivedA).toEqual([new Uint8Array([1])]);
    expect(receivedB).toEqual([new Uint8Array([2])]);
  });
});
