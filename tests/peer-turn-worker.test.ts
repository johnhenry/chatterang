import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { decodeFrame, encodeFrame } from '@chatterang/tunnel/wire';

/**
 * S4 (#296): the hidden worker's turn runner, tested as a plain unit — no
 * Electron, no BrowserWindow, no MessagePort. `src/peer-turn-worker.ts`'s
 * `runPeerTurn` is exercised directly with a REAL encoded `turn` frame
 * (`encodeFrame` from `@chatterang/tunnel/wire`) and drives the REAL
 * `ChatterangEngine`/`LlamaCppBackendAdapter` (`@/ai/engine`) through
 * `useApp`'s real `initialize()` — the same engine a local turn runs on. Only
 * the native boundary is faked: `@/plugins/llama-cpp`, the Capacitor plugin
 * proxy, exactly as `tests/llama-waiting.test.ts` and `tests/engine.test.ts`
 * fake it for every other real-engine test in this repo. `@/db` is stubbed at
 * the table boundary the same way `tests/engine.test.ts` does, so
 * `useApp.initialize()` runs for real without opening IndexedDB.
 *
 * The whole point: the frames this produces are the frames
 * `apps/desktop/src/bridge/peer-turns.ts` decodes and forwards to a phone —
 * so this test proves the worker's OWN half of the wire contract, with real
 * bytes crossing `encodeFrame`/`decodeFrame` both ways.
 */

vi.mock('@/db', () => ({
  db: {
    connections: { put: vi.fn(async () => {}), delete: vi.fn(async () => {}), toArray: async () => [] },
    models: { put: vi.fn(async () => {}), delete: vi.fn(async () => {}), toArray: async () => [] },
    settings: { get: vi.fn(async () => undefined), put: vi.fn(async () => {}) },
    benchmarks: {
      put: vi.fn(async () => {}),
      delete: vi.fn(async () => {}),
      clear: vi.fn(async () => {}),
      orderBy: () => ({ reverse: () => ({ toArray: async () => [] }) }),
    },
  },
  deleteChat: vi.fn(async () => {}),
  readSetting: async (_key: string, fallback: unknown) => fallback,
  writeSetting: vi.fn(async () => {}),
}));

interface FakeLlama {
  readonly plugin: Record<string, unknown>;
  readonly cancelCalls: readonly string[];
  called(): boolean;
  finish(result?: { text?: string; stopReason?: string }): void;
  fail(error: Error): void;
}

/** The Capacitor `LlamaCpp` plugin, faked at the boundary — see the header. */
function fakeLlama(): FakeLlama {
  let settle: ((value: unknown) => void) | null = null;
  let reject: ((error: unknown) => void) | null = null;
  let generateCalled = false;
  const cancelCalls: string[] = [];
  const plugin = {
    getCapabilities: async () => null,
    getThermalState: async () => ({ level: 'nominal' }),
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
    cancel: async (request: { requestId: string }) => {
      cancelCalls.push(request.requestId);
    },
    addListener: async () => ({ remove: async () => undefined }),
    generate: (request: { requestId: string }) =>
      new Promise((resolve, rejectFn) => {
        generateCalled = true;
        settle = (result: unknown) =>
          resolve({
            requestId: request.requestId,
            text: 'hello from the desktop',
            promptTokens: 3,
            cachedTokens: 0,
            completionTokens: 4,
            ttftMs: 5,
            totalMs: 10,
            tokensPerSecond: 40,
            stopReason: 'stop',
            ...(result as object),
          });
        reject = rejectFn;
      }),
  };
  return {
    plugin,
    cancelCalls,
    called: () => generateCalled,
    finish: (result) => settle?.(result ?? {}),
    fail: (error) => reject?.(error),
  };
}

const resolver = {
  getManifest: () => ({ name: 'M', contextLength: 4096, promptTemplate: 'chatml' }) as never,
  getPath: () => '/models/m.gguf',
  getSampler: () => ({ stopSequences: [], seed: null, draftModelId: null }) as never,
};

function turnRequest() {
  return {
    messages: [{ role: 'user', content: 'hi there' }],
    parameters: { model: 'm' },
    metadata: { requestId: 'turn-1', timestamp: Date.now(), custom: { routeTo: 'somewhere-else' } },
  } as never;
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.doUnmock('@/plugins/llama-cpp');
});

describe('the peer-turn worker runs a real turn frame on the real engine (#296, S4)', () => {
  it('decodes a turn frame, streams real chunks, and ends with a done chunk carrying a message (#260)', async () => {
    const fake = fakeLlama();
    vi.doMock('@/plugins/llama-cpp', () => ({ LlamaCpp: fake.plugin }));
    const appModule = await import('@/state/app');
    appModule.installResolver(resolver);

    const { runPeerTurn } = await import('@/peer-turn-worker');

    const encodedTurn = encodeFrame({
      v: 1,
      kind: 'turn',
      turn: 'turn-1',
      toolLoop: 'requester',
      body: turnRequest(),
    });

    const seen: Uint8Array[] = [];
    const controller = new AbortController();
    const donePromise = runPeerTurn(encodedTurn, controller.signal, (bytes) => seen.push(bytes));

    await vi.waitFor(() => expect(seen.length).toBeGreaterThan(0));
    fake.finish();
    const terminalBytes = await donePromise;

    // Every emitted frame decodes as a `chunk` naming this turn.
    expect(seen.length).toBeGreaterThan(0);
    for (const bytes of seen) {
      const frame = decodeFrame(bytes);
      expect(frame.kind).toBe('chunk');
      if (frame.kind === 'chunk') expect(frame.turn).toBe('turn-1');
    }

    const terminal = decodeFrame(terminalBytes);
    expect(terminal.kind).toBe('chunk');
    if (terminal.kind !== 'chunk') throw new Error('unreachable');
    const body = terminal.body as { type: string; message?: { content: unknown } };
    expect(body.type).toBe('done');
    // #260's obligation: a `done` chunk crossing a tunnel must carry `message`.
    expect(body.message).toBeDefined();

    // The last emitted frame IS the terminal (same bytes), matching what
    // `apps/desktop/src/bridge/peer-turns.ts` relies on to avoid re-decoding.
    expect(seen.at(-1)).toEqual(terminalBytes);
  });

  it('ends with an error chunk — not a rejection — when the engine throws', async () => {
    const fake = fakeLlama();
    vi.doMock('@/plugins/llama-cpp', () => ({ LlamaCpp: fake.plugin }));
    const appModule = await import('@/state/app');
    appModule.installResolver(resolver);

    const { runPeerTurn } = await import('@/peer-turn-worker');
    const encodedTurn = encodeFrame({
      v: 1,
      kind: 'turn',
      turn: 'turn-2',
      toolLoop: 'requester',
      body: turnRequest(),
    });

    const seen: Uint8Array[] = [];
    const controller = new AbortController();
    const donePromise = runPeerTurn(encodedTurn, controller.signal, (bytes) => seen.push(bytes));
    await vi.waitFor(() => expect(fake.called()).toBe(true));
    fake.fail(new Error('the model exploded'));

    const terminalBytes = await donePromise;
    const terminal = decodeFrame(terminalBytes);
    expect(terminal.kind).toBe('chunk');
    if (terminal.kind !== 'chunk') throw new Error('unreachable');
    const body = terminal.body as { type: string; error?: { code: string; message: string } };
    expect(body.type).toBe('error');
    expect(body.error?.message).toBe('the model exploded');
  });

  it('ends with a CANCELLED error chunk when its signal aborts, not a hang', async () => {
    const fake = fakeLlama();
    vi.doMock('@/plugins/llama-cpp', () => ({ LlamaCpp: fake.plugin }));
    const appModule = await import('@/state/app');
    appModule.installResolver(resolver);

    const { runPeerTurn } = await import('@/peer-turn-worker');
    const encodedTurn = encodeFrame({
      v: 1,
      kind: 'turn',
      turn: 'turn-3',
      toolLoop: 'requester',
      body: turnRequest(),
    });

    const controller = new AbortController();
    const donePromise = runPeerTurn(encodedTurn, controller.signal, () => undefined);
    controller.abort();
    fake.fail(Object.assign(new Error('aborted'), { name: 'AbortError' }));

    const terminalBytes = await donePromise;
    const terminal = decodeFrame(terminalBytes);
    expect(terminal.kind).toBe('chunk');
    if (terminal.kind !== 'chunk') throw new Error('unreachable');
    const body = terminal.body as { type: string; error?: { code: string } };
    expect(body.type).toBe('error');
    expect(body.error?.code).toBe('CANCELLED');
  });
});

describe('isPeerTurnWorker', () => {
  it('reads the flag main.ts loads a hidden worker window with', async () => {
    const { isPeerTurnWorker } = await import('@/peer-turn-worker');
    expect(isPeerTurnWorker('?peerTurnWorker=1')).toBe(true);
    expect(isPeerTurnWorker('')).toBe(false);
    // Present but not exactly '1': a normal window, not a bare flag either
    // (`apps/desktop/src/bridge/peer-turn-window.ts`'s own contract).
    expect(isPeerTurnWorker('?peerTurnWorker')).toBe(false);
    expect(isPeerTurnWorker('?peerTurnWorker=0')).toBe(false);
  });
});

describe('startPeerTurnWorker registers a runner on window.__peerTurn (#296, S4/S5 contract)', () => {
  it('registers runPeerTurn/cancelPeerTurn, and runPeerTurn forwards chunks through emitFrame', async () => {
    const fake = fakeLlama();
    vi.doMock('@/plugins/llama-cpp', () => ({ LlamaCpp: fake.plugin }));
    const appModule = await import('@/state/app');
    appModule.installResolver(resolver);
    const { startPeerTurnWorker } = await import('@/peer-turn-worker');

    const registered: {
      runPeerTurn(payload: { requestId: string; frame: Uint8Array }): Promise<{ requestId: string; frame: Uint8Array }>;
      cancelPeerTurn(payload: { requestId: string }): Promise<void>;
    }[] = [];
    const emitted: { requestId: string; frame: Uint8Array }[] = [];
    (window as unknown as { __peerTurn?: unknown }).__peerTurn = {
      registerRunner: (runner: (typeof registered)[number]) => registered.push(runner),
      emitFrame: (requestId: string, frame: Uint8Array) => emitted.push({ requestId, frame }),
    };

    startPeerTurnWorker();
    expect(registered).toHaveLength(1);

    const encodedTurn = encodeFrame({
      v: 1,
      kind: 'turn',
      turn: 'turn-4',
      toolLoop: 'requester',
      body: turnRequest(),
    });
    const resultPromise = registered[0]!.runPeerTurn({ requestId: 'req-1', frame: encodedTurn });
    await vi.waitFor(() => expect(fake.called()).toBe(true));
    fake.finish();
    const result = await resultPromise;

    expect(result.requestId).toBe('req-1');
    expect(emitted.length).toBeGreaterThan(0);
    expect(emitted.every((event) => event.requestId === 'req-1')).toBe(true);
    // The last emitted frame is the same terminal `runPeerTurn` resolved with.
    expect(emitted.at(-1)!.frame).toEqual(result.frame);

    delete (window as unknown as { __peerTurn?: unknown }).__peerTurn;
  });

  it('cancelPeerTurn aborts the matching in-flight run, by requestId', async () => {
    const fake = fakeLlama();
    vi.doMock('@/plugins/llama-cpp', () => ({ LlamaCpp: fake.plugin }));
    const appModule = await import('@/state/app');
    appModule.installResolver(resolver);
    const { startPeerTurnWorker } = await import('@/peer-turn-worker');

    const registered: {
      runPeerTurn(payload: { requestId: string; frame: Uint8Array }): Promise<{ requestId: string; frame: Uint8Array }>;
      cancelPeerTurn(payload: { requestId: string }): Promise<void>;
    }[] = [];
    (window as unknown as { __peerTurn?: unknown }).__peerTurn = {
      registerRunner: (runner: (typeof registered)[number]) => registered.push(runner),
      emitFrame: () => undefined,
    };
    startPeerTurnWorker();

    const encodedTurn = encodeFrame({
      v: 1,
      kind: 'turn',
      turn: 'turn-5',
      toolLoop: 'requester',
      body: turnRequest(),
    });
    const resultPromise = registered[0]!.runPeerTurn({ requestId: 'req-2', frame: encodedTurn });
    await vi.waitFor(() => expect(fake.called()).toBe(true));

    await registered[0]!.cancelPeerTurn({ requestId: 'req-2' });
    // The abort really reached the real adapter: it calls `LlamaCpp.cancel`
    // on its signal's `abort` event (`src/ai/backends/llama-cpp.ts:402-403`).
    await vi.waitFor(() => expect(fake.cancelCalls.length).toBeGreaterThan(0));
    // The real adapter reports a rejected `generate()` — abort included — as
    // an in-band `error` chunk of its own (`generation_failed`,
    // `src/ai/backends/llama-cpp.ts:474`) rather than throwing; this call is
    // still what asks the fake to settle its `generate()` promise.
    fake.fail(Object.assign(new Error('aborted'), { name: 'AbortError' }));

    const result = await resultPromise;
    const terminal = decodeFrame(result.frame);
    expect(terminal.kind).toBe('chunk');
    if (terminal.kind !== 'chunk') throw new Error('unreachable');
    expect((terminal.body as { type: string }).type).toBe('error');

    delete (window as unknown as { __peerTurn?: unknown }).__peerTurn;
  });
});
