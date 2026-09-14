import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * #7 S6, THE RENDERER HALF: a desktop generation that waits for the shared slot
 * reaches the page as `llamaWaiting`, and the page hears it.
 *
 * The main-process half is `tests/desktop-local-turns.test.ts`. This file
 * drives the real `LlamaCppBackendAdapter` and the real `ChatterangEngine` over
 * a `LlamaCpp` double, the same way `tests/desktop-bridge.test.ts` does, and
 * reads nothing but what they call.
 */

interface Fake {
  readonly plugin: Record<string, unknown>;
  readonly subscribed: string[];
  readonly removed: string[];
  /** What each `generate` was sent, in order. */
  readonly requests: unknown[];
  /** The requestIds `endTurn` was called with, in order. */
  readonly ended: string[];
  generateCalled(): boolean;
  /** Whether the adapter has asked for its `llamaWaiting` subscription. */
  subscribingToWaiting(): boolean;
  emit(eventName: string, data: unknown): void;
  finish(): void;
}

function fakeLlama(
  options: {
    refuseWaiting?: boolean;
    holdWaiting?: Promise<void>;
    /** How the platform answers `endTurn`. Default: it takes it. */
    endTurn?: 'refuses' | 'throws' | 'absent';
  } = {},
): Fake {
  const listeners = new Map<string, (event: unknown) => void>();
  const subscribed: string[] = [];
  const removed: string[] = [];
  const requests: unknown[] = [];
  const ended: string[] = [];
  let called = false;
  let subscribing = false;
  let finish: () => void = () => undefined;
  const endTurn = (end: { requestId: string }): Promise<void> => {
    if (options.endTurn === 'throws') throw new Error('"LlamaCpp.endTurn()" is not implemented on android');
    if (options.endTurn === 'refuses') {
      // What PluginHost answers on a platform that registered the plain llama
      // definition, such as the headless server.
      return Promise.reject(
        Object.assign(new Error('desktop bridge: "LlamaCpp" has no method "endTurn".'), { code: 'UNKNOWN_METHOD' }),
      );
    }
    ended.push(end.requestId);
    return Promise.resolve();
  };
  const plugin = {
    ...(options.endTurn === 'absent' ? {} : { endTurn }),
    load: async () => ({
      handle: 'h1',
      backend: 'cpu',
      contextLength: 4096,
      loadMs: 1,
      warnings: [],
      supportsVision: false,
      chatTemplate: 'chatml',
    }),
    unload: async () => undefined,
    cancel: async () => undefined,
    addListener: async (eventName: string, listener: (event: unknown) => void) => {
      if (eventName === 'llamaWaiting') {
        subscribing = true;
        // A subscription is an IPC round trip on the desktop: Stop can land
        // while it is still being made.
        await options.holdWaiting;
      }
      if (eventName === 'llamaWaiting' && options.refuseWaiting === true) {
        // What PluginHost answers on a platform that registered the plain
        // llama definition, such as the headless server.
        throw Object.assign(new Error('desktop bridge: "LlamaCpp" emits no event "llamaWaiting".'), {
          code: 'UNKNOWN_EVENT',
        });
      }
      subscribed.push(eventName);
      listeners.set(eventName, listener);
      return { remove: async () => void removed.push(eventName) };
    },
    generate: (request: { requestId: string }) => {
      called = true;
      requests.push(request);
      return new Promise((done) => {
        finish = () =>
          done({
            requestId: request.requestId,
            text: 'answered',
            promptTokens: 1,
            cachedTokens: 0,
            completionTokens: 1,
            ttftMs: 1,
            totalMs: 1,
            tokensPerSecond: 1,
            stopReason: 'stop',
          });
      });
    },
  };
  return {
    plugin,
    subscribed,
    removed,
    requests,
    ended,
    generateCalled: () => called,
    subscribingToWaiting: () => subscribing,
    emit: (eventName, data) => listeners.get(eventName)?.(data),
    finish: () => finish(),
  };
}

const resolver = {
  getManifest: () => ({ name: 'M', contextLength: 4096, promptTemplate: 'chatml' }) as never,
  getPath: () => '/models/m.gguf',
  getSampler: () => ({ stopSequences: [], seed: null, draftModelId: null }) as never,
};

const request = {
  messages: [{ role: 'user', content: 'hi' }],
  parameters: { model: 'm' },
  metadata: { requestId: 'turn-1', custom: {}, provenance: {} },
} as never;

async function drain(stream: AsyncIterable<{ type: string }>): Promise<string[]> {
  const types: string[] = [];
  for await (const chunk of stream) types.push(chunk.type);
  return types;
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.doUnmock('@/plugins/llama-cpp');
});

describe('a streamed desktop generation hears that it is waiting (#7)', () => {
  it('reports its own place in line, ignores another turn’s, reports the start, and unsubscribes', async () => {
    // FAULT INJECTED: removing the `onWaiting` call from the adapter's
    // `llamaWaiting` listener left `seen` empty.
    const fake = fakeLlama();
    vi.doMock('@/plugins/llama-cpp', () => ({ LlamaCpp: fake.plugin }));
    const { LlamaCppBackendAdapter } = await import('@/ai/backends/llama-cpp');
    const seen: unknown[] = [];
    const adapter = new LlamaCppBackendAdapter({ resolver, onWaiting: (event) => seen.push(event) });

    const done = drain(adapter.executeStream(request));
    await vi.waitFor(() => expect(fake.generateCalled()).toBe(true));
    // Subscribed BEFORE the generate call, so a position sent while main
    // admits the turn is not missed.
    expect(fake.subscribed).toEqual(['llamaToken', 'llamaWaiting']);

    fake.emit('llamaWaiting', { requestId: 'someone-else', position: 1 });
    fake.emit('llamaWaiting', { requestId: 'turn-1', position: 2 });
    fake.emit('llamaWaiting', { requestId: 'turn-1', position: 0 });
    fake.finish();

    expect(await done).toContain('done');
    expect(seen).toEqual([
      { requestId: 'turn-1', position: 2 },
      { requestId: 'turn-1', position: 0 },
    ]);
    expect(fake.removed).toContain('llamaWaiting');
  });

  it('a platform that refuses the subscription still runs the turn', async () => {
    const fake = fakeLlama({ refuseWaiting: true });
    vi.doMock('@/plugins/llama-cpp', () => ({ LlamaCpp: fake.plugin }));
    const { LlamaCppBackendAdapter } = await import('@/ai/backends/llama-cpp');
    const seen: unknown[] = [];
    const adapter = new LlamaCppBackendAdapter({ resolver, onWaiting: (event) => seen.push(event) });

    const done = drain(adapter.executeStream(request));
    await vi.waitFor(() => expect(fake.generateCalled()).toBe(true));
    fake.finish();
    const types = await done;
    expect(types).toContain('done');
    expect(types).not.toContain('error');
    expect(seen).toEqual([]);
  });

  it('the engine hands the adapter the app’s onWaiting', async () => {
    // FAULT INJECTED: dropping `onWaiting: options.onWaiting` from the engine's
    // adapter construction left `seen` empty.
    const fake = fakeLlama();
    vi.doMock('@/plugins/llama-cpp', () => ({ LlamaCpp: fake.plugin }));
    const { ChatterangEngine } = await import('@/ai/engine');
    const seen: unknown[] = [];
    const engine = new ChatterangEngine({ resolver, onWaiting: (event) => seen.push(event) });

    const done = drain(engine.llama.executeStream(request));
    await vi.waitFor(() => expect(fake.generateCalled()).toBe(true));
    fake.emit('llamaWaiting', { requestId: 'turn-1', position: 1 });
    fake.finish();
    await done;
    expect(seen).toEqual([{ requestId: 'turn-1', position: 1 }]);
  });

  it('a turn stopped while it is still subscribing never asks for a generation, and lets go of both subscriptions', async () => {
    // #305: nothing is sent after Stop. Here, the generate a turn stopped
    // mid-subscription still made would wait for the shared slot, and start on
    // the host once the slot freed, long after Stop.
    // FAULT INJECTED: removing the adapter's aborted check before `generate`
    // sent the generation, and this test failed on `generateCalled()`.
    let release: () => void = () => undefined;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fake = fakeLlama({ holdWaiting: hold });
    vi.doMock('@/plugins/llama-cpp', () => ({ LlamaCpp: fake.plugin }));
    const { LlamaCppBackendAdapter } = await import('@/ai/backends/llama-cpp');
    const controller = new AbortController();
    const adapter = new LlamaCppBackendAdapter({ resolver });

    let settled = false;
    const done = drain(adapter.executeStream(request, controller.signal)).finally(() => {
      settled = true;
    });
    try {
      await vi.waitFor(() => expect(fake.subscribingToWaiting()).toBe(true));
      controller.abort();
      release();
      await vi.waitFor(() => expect(settled || fake.generateCalled()).toBe(true));

      expect(fake.generateCalled(), 'a generation asked for after Stop').toBe(false);
      const types = await done;
      expect(types).not.toContain('content');
      expect(types).not.toContain('done');
      expect(fake.removed).toEqual(expect.arrayContaining(['llamaToken', 'llamaWaiting']));
    } finally {
      release();
      fake.finish();
      await done;
    }
  });

  it('a place in line that arrives after Stop is not reported', async () => {
    // The rail would say "Waiting" about a turn the person has already stopped.
    // FAULT INJECTED: removing the aborted check from the `llamaWaiting`
    // listener reported the second position.
    const fake = fakeLlama();
    vi.doMock('@/plugins/llama-cpp', () => ({ LlamaCpp: fake.plugin }));
    const { LlamaCppBackendAdapter } = await import('@/ai/backends/llama-cpp');
    const seen: unknown[] = [];
    const controller = new AbortController();
    const adapter = new LlamaCppBackendAdapter({ resolver, onWaiting: (event) => seen.push(event) });

    const done = drain(adapter.executeStream(request, controller.signal));
    await vi.waitFor(() => expect(fake.generateCalled()).toBe(true));
    fake.emit('llamaWaiting', { requestId: 'turn-1', position: 2 });
    controller.abort();
    fake.emit('llamaWaiting', { requestId: 'turn-1', position: 1 });
    fake.emit('llamaWaiting', { requestId: 'turn-1', position: 0 });
    fake.finish();
    await done;

    expect(seen).toEqual([{ requestId: 'turn-1', position: 2 }]);
  });

  it('a streamed decode asks to keep the slot for its whole turn, and ending that turn tells the platform once', async () => {
    // Owner ruling on #7: a desktop turn holds the shared slot from its first
    // decode until the turn settles, tool calls included. The engine ends the
    // turn; this is what that end reaches.
    const fake = fakeLlama();
    vi.doMock('@/plugins/llama-cpp', () => ({ LlamaCpp: fake.plugin }));
    const { LlamaCppBackendAdapter } = await import('@/ai/backends/llama-cpp');
    const adapter = new LlamaCppBackendAdapter({ resolver });

    const done = drain(adapter.executeStream(request));
    await vi.waitFor(() => expect(fake.generateCalled()).toBe(true));
    fake.finish();
    await done;
    expect(fake.requests).toEqual([expect.objectContaining({ requestId: 'turn-1', wholeTurn: true })]);
    // A decode ending is not the turn ending: a tool call may follow it.
    expect(fake.ended).toEqual([]);

    await adapter.endTurn('turn-1');
    await adapter.endTurn('turn-1');
    expect(fake.ended).toEqual(['turn-1']);
    // A turn this adapter never decoded for holds nothing to end.
    await adapter.endTurn('someone-else');
    expect(fake.ended).toEqual(['turn-1']);
  });

  it.each([
    ['refuses', 'refuses'],
    ['throws on', 'throws'],
    ['has no method for', 'absent'],
  ] as const)(
    'a platform that %s the turn’s end still ends the turn',
    async (_label, how) => {
      // The headless server registers the plain llama definition and refuses
      // the method; a native plugin that does not implement it may throw, or
      // not have it at all. None of them has a slot to give back.
      const fake = fakeLlama({ endTurn: how });
      vi.doMock('@/plugins/llama-cpp', () => ({ LlamaCpp: fake.plugin }));
      const { LlamaCppBackendAdapter } = await import('@/ai/backends/llama-cpp');
      const adapter = new LlamaCppBackendAdapter({ resolver });

      const done = drain(adapter.executeStream(request));
      await vi.waitFor(() => expect(fake.generateCalled()).toBe(true));
      fake.finish();
      expect(await done).toContain('done');
      await expect(adapter.endTurn('turn-1')).resolves.toBeUndefined();
    },
  );

  it('the non-streamed path is one decode and not a turn: it asks for no hold, and has nothing to end', async () => {
    const fake = fakeLlama();
    vi.doMock('@/plugins/llama-cpp', () => ({ LlamaCpp: fake.plugin }));
    const { LlamaCppBackendAdapter } = await import('@/ai/backends/llama-cpp');
    const adapter = new LlamaCppBackendAdapter({ resolver });

    const result = adapter.execute(request);
    await vi.waitFor(() => expect(fake.generateCalled()).toBe(true));
    fake.finish();
    await result;
    expect(fake.requests[0]).not.toHaveProperty('wholeTurn');
    await adapter.endTurn('turn-1');
    expect(fake.ended).toEqual([]);
  });

  it('the app store turns a position into the rail’s state, and 0 into not waiting', () => {
    // A text pin: `initialize()` needs the whole app booted to construct the
    // engine, so this checks the one line that joins the engine to the store.
    // The store action and the rail chip are rendered in
    // tests/rail-readout.test.tsx.
    const source = readFileSync(resolve(process.cwd(), 'src/state/app.ts'), 'utf8');
    expect(source).toMatch(
      /onWaiting:\s*\(event\)\s*=>\s*get\(\)\.setTurnWaiting\(event\.position > 0 \? event\.position : null\)/,
    );
    const chat = readFileSync(resolve(process.cwd(), 'src/state/chat.ts'), 'utf8');
    // And a turn that ends, however it ends, is no longer waiting.
    expect(chat).toMatch(/app\.setActivity\('idle'\);\s*app\.setLiveRate\(null\);\s*app\.setTurnWaiting\(null\);/);
  });
});
