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
  generateCalled(): boolean;
  emit(eventName: string, data: unknown): void;
  finish(): void;
}

function fakeLlama(options: { refuseWaiting?: boolean } = {}): Fake {
  const listeners = new Map<string, (event: unknown) => void>();
  const subscribed: string[] = [];
  const removed: string[] = [];
  let called = false;
  let finish: () => void = () => undefined;
  const plugin = {
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
    generateCalled: () => called,
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
