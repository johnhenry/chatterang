/**
 * THE SCRIPT THE BROWSER ACTUALLY RUNS.
 *
 * `apps/server/src/client-bootstrap.ts` is served as SOURCE, built with
 * `Function.prototype.toString()`. The imported function is therefore not what
 * ships, and testing the import would leave the shipped artefact unchecked in
 * the one way it can fail: a reference to anything outside the function's own
 * parameters survives typecheck, survives bundling, and throws `ReferenceError`
 * in the page at startup — with the app already committed to a platform that
 * has no plugins.
 *
 * So everything here evaluates the STRING, with `window` as its only free
 * variable, exactly as the served `<script>` does. The self-containment claim
 * is fault-injected below rather than asserted.
 *
 * THE MEASUREMENT THIS FILE EXISTS FOR is the last block: the REAL
 * `@capacitor/core`, the REAL `registerPlugin` call from `src/plugins`, and the
 * question the whole milestone turns on — does a served bundle reach the
 * bridge, or does it reach `src/plugins/llama-cpp/web.ts`, the development shim
 * that synthesises prose and reports `simulated: true`?
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { LLAMA_PLUGIN } from '@chatterang/desktop/bridge';
import type { BootManifest } from '@chatterang/desktop/bridge';
import { SERVER_BRIDGE_GLOBAL, serverBootstrapSource } from '@chatterang/server';
import type { LlamaCppPlugin } from '@chatterang/contracts';

const MANIFEST: BootManifest = { platform: 'server', plugins: [LLAMA_PLUGIN] };

/* ── A browser, as much of one as this needs ──────────────────────────── */

interface FakeFetchCall {
  url: string;
  init: { method?: string; headers?: Record<string, string>; body?: string; credentials?: string };
}

interface FakeWindow extends Record<string, unknown> {
  fetch: (url: string, init: FakeFetchCall['init']) => Promise<unknown>;
  EventSource: new (url: string) => unknown;
}

interface Page {
  window: FakeWindow;
  calls: FakeFetchCall[];
  /** Push one frame down the event stream the page opened. */
  emit(frame: unknown): void;
  streamUrl: string;
  capacitor(): {
    PluginHeaders: { name: string; methods: { name: string; rtype: string }[] }[];
    nativePromise(plugin: string, method: string, options?: unknown): Promise<unknown>;
    nativeCallback(
      plugin: string,
      method: string,
      options: Record<string, unknown> | undefined,
      callback: (data: unknown) => void,
    ): Promise<unknown>;
  };
}

/**
 * Evaluate the served source against a fake window.
 *
 * @param answer what the server replies to every RPC.
 * @param openStream whether to deliver the session frame immediately. The
 *   `false` case is how the queueing behaviour is observed.
 */
function load(
  answer: () => unknown = () => ({ ok: true, data: 'answered' }),
  options: { source?: string } = {},
): Page {
  const calls: FakeFetchCall[] = [];
  let onmessage: ((event: { data: string }) => void) | null = null;
  let streamUrl = '';

  const window = {
    fetch: async (url: string, init: FakeFetchCall['init']) => {
      calls.push({ url, init });
      return { ok: true, status: 200, json: async () => answer() };
    },
    EventSource: class {
      onmessage: ((event: { data: string }) => void) | null = null;
      onerror: ((event: unknown) => void) | null = null;
      constructor(url: string) {
        streamUrl = url;
        // The bootstrap assigns `onmessage` immediately after construction.
        queueMicrotask(() => {
          onmessage = this.onmessage;
        });
      }
      close(): void {
        /* nothing to close */
      }
    },
  } as unknown as FakeWindow;

  new Function('window', options.source ?? serverBootstrapSource(MANIFEST))(window);

  return {
    window,
    calls,
    emit: (frame) => {
      const deliver = onmessage ?? (window['__streamListener'] as typeof onmessage);
      deliver?.({ data: JSON.stringify(frame) });
    },
    get streamUrl() {
      return streamUrl;
    },
    capacitor: () => window['Capacitor'] as ReturnType<Page['capacitor']>,
  };
}

/** Let the microtask that captures `onmessage` run. */
const settle = async (): Promise<void> => {
  await new Promise((done) => setTimeout(done, 0));
};

describe('the served bootstrap, evaluated as the page evaluates it', () => {
  it('seeds the platform and the plugin headers, in that order', async () => {
    const page = load();
    await settle();

    // The custom platform is what `Capacitor.getPlatform()` answers, and what
    // `src/lib/platform.ts` looks its capability row up by.
    expect(page.window['CapacitorCustomPlatform']).toEqual({ name: 'server' });

    const headers = page.capacitor().PluginHeaders;
    expect(headers.map((header) => header.name)).toEqual(['LlamaCpp']);
    const generate = headers[0]?.methods.find((method) => method.name === 'generate');
    // `rtype: 'promise'` is what routes the call to `nativePromise` — ours —
    // instead of to the web implementation.
    expect(generate).toEqual({ name: 'generate', rtype: 'promise' });
    // And `addListener` is `callback`, which is the path that wraps the event
    // name in an options object.
    expect(headers[0]?.methods.find((method) => method.name === 'addListener')).toEqual({
      name: 'addListener',
      rtype: 'callback',
    });
  });

  it('opens the event stream and waits for a session before sending anything', async () => {
    const page = load();
    await settle();
    expect(page.streamUrl).toBe('/__chatterang/events');

    // A call made before the session frame arrives must not be sent: it has no
    // session id to authenticate with, and the server would refuse it.
    const pending = page.capacitor().nativePromise('LlamaCpp', 'getCapabilities', {});
    await settle();
    expect(page.calls).toEqual([]);

    page.emit({ k: 'session', id: 'session-abc' });
    await expect(pending).resolves.toBe('answered');

    const call = page.calls[0];
    expect(call?.url).toBe('/__chatterang/rpc');
    expect(call?.init.method).toBe('POST');
    expect(call?.init.credentials).toBe('same-origin');
    expect(call?.init.headers?.['x-chatterang-session']).toBe('session-abc');
    expect(JSON.parse(String(call?.init.body))).toEqual({
      k: 'invoke',
      plugin: 'LlamaCpp',
      method: 'getCapabilities',
      args: [{}],
    });
  });

  it('turns a refusal back into a throw that still carries its code', async () => {
    // `HANDLE_LOST` is what `src/ai/backends/llama-cpp.ts` drops its cached
    // model handle on. Lose the code and a host restart wedges the client
    // until the page is reloaded.
    const page = load(() => ({
      ok: false,
      error: { message: 'The inference process stopped unexpectedly.', code: 'HANDLE_LOST' },
    }));
    await settle();
    page.emit({ k: 'session', id: 's' });

    const caught = await page
      .capacitor()
      .nativePromise('LlamaCpp', 'generate', { requestId: 'x' })
      .catch((error: unknown) => error);
    expect(caught).toBeInstanceOf(Error);
    expect((caught as { code?: string }).code).toBe('HANDLE_LOST');
  });

  it('delivers an event to the subscription that asked for it, and to no other', async () => {
    const page = load(() => ({ ok: true, data: null }));
    await settle();
    page.emit({ k: 'session', id: 's' });

    const seen: unknown[] = [];
    const id = await page
      .capacitor()
      .nativeCallback('LlamaCpp', 'addListener', { eventName: 'llamaToken' }, (data) => {
        seen.push(data);
      });
    expect(id).toBe(1);

    page.emit({ k: 'event', pluginName: 'LlamaCpp', subscriptionId: 1, eventName: 'llamaToken', data: { text: 'hi' } });
    expect(seen).toEqual([{ text: 'hi' }]);

    // A frame whose id matches but whose names do not is dropped. A reloaded
    // page restarts its counter at 1, so an id alone is not proof an event
    // belongs to the callback now sitting at that slot.
    page.emit({ k: 'event', pluginName: 'OnnxRuntime', subscriptionId: 1, eventName: 'llamaToken', data: 'wrong' });
    page.emit({ k: 'event', pluginName: 'LlamaCpp', subscriptionId: 1, eventName: 'llamaEnd', data: 'wrong' });
    page.emit({ k: 'event', pluginName: 'LlamaCpp', subscriptionId: 9, eventName: 'llamaToken', data: 'wrong' });
    expect(seen).toEqual([{ text: 'hi' }]);
  });

  it('refuses a method the manifest does not declare, before sending anything', async () => {
    const page = load();
    await settle();
    page.emit({ k: 'session', id: 's' });

    const caught = await page
      .capacitor()
      .nativePromise('LlamaCpp', 'readFile', {})
      .catch((error: unknown) => error);
    expect((caught as Error).message).toContain('has no method "readFile"');
    expect(page.calls).toEqual([]);
  });

  it('answers a transport failure as a refusal rather than a rejection nothing unwraps', async () => {
    const page = load();
    await settle();
    page.emit({ k: 'session', id: 's' });
    // The server went away mid-call.
    page.window.fetch = () => Promise.reject(new Error('network down'));

    const caught = await page
      .capacitor()
      .nativePromise('LlamaCpp', 'getCapabilities', {})
      .catch((error: unknown) => error);
    // It arrives as a throw in the page — which is what the shim's `unwrap`
    // does with `{ok:false}` — rather than as an unhandled shape.
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain('network down');
  });
});

describe('the source is self-contained', () => {
  it('evaluates with `window` as its only free variable', () => {
    // The real assertion is that `load()` above does not throw — every test in
    // this file evaluates the string. This one states it directly and checks
    // the shape of what the source is allowed to mention.
    expect(() => load()).not.toThrow();
    const source = serverBootstrapSource(MANIFEST);
    expect(source).toContain(SERVER_BRIDGE_GLOBAL);
    expect(source).not.toContain('import ');
    expect(source).not.toContain('require(');
  });

  it('would notice a helper hoisted out of the function — the fault, injected', () => {
    /*
     * THE FAULT THIS FILE EXISTS TO CATCH.
     *
     * A module-scope helper called from inside `installServerBridge` is
     * invisible to the compiler and to the bundler; it only fails when the
     * STRING is evaluated in a scope that does not contain it. This rewrites
     * the source to make exactly that mistake, and the evaluation must fail —
     * otherwise "it evaluated fine" above would be worth nothing.
     */
    const broken = serverBootstrapSource(MANIFEST).replace(
      'const manifest = config.manifest;',
      'const manifest = hoistedHelperFromModuleScope(config);',
    );
    expect(broken).toContain('hoistedHelperFromModuleScope');
    expect(() => load(undefined, { source: broken })).toThrow(ReferenceError);
  });
});

/* ══ The real @capacitor/core, and the unchanged src/ plugin ════════════ */

describe('registerPlugin in src/ resolves to the server bridge', () => {
  let LlamaCpp: LlamaCppPlugin;
  let platform = '';
  let capabilities: { modelStore: string; id: string };
  const answers: FakeFetchCall[] = [];

  beforeAll(async () => {
    /*
     * ONE registration for the whole block. `@capacitor/core` installs
     * `window.Capacitor` at module load and refuses to register a plugin name
     * twice; vitest externalizes node_modules, so the module survives a
     * registry reset.
     *
     * The globals are seeded by EVALUATING THE SERVED SOURCE against
     * `globalThis`, so what routes these calls is the script a browser would
     * have downloaded — not a hand-built approximation of it.
     */
    const page = load(() => ({ ok: true, data: { simulated: false, engineVersion: 'server-real' } }), {
      source: serverBootstrapSource(MANIFEST),
    });
    // Copy the seeded globals onto the real global object, which is where
    // `@capacitor/core` reads them from when it loads.
    (globalThis as Record<string, unknown>)['Capacitor'] = page.window['Capacitor'];
    (globalThis as Record<string, unknown>)['CapacitorCustomPlatform'] =
      page.window['CapacitorCustomPlatform'];
    await settle();
    page.emit({ k: 'session', id: 'real-session' });
    answers.push(...page.calls);

    const core = await import('@capacitor/core');
    LlamaCpp = core.registerPlugin<LlamaCppPlugin>('LlamaCpp', {
      // The development shim, exactly as `src/plugins/llama-cpp/index.ts`
      // registers it. If the header seeding did not work, THIS is what answers.
      web: async () => new (await import('@/plugins/llama-cpp/web')).LlamaCppWeb(),
    });
    platform = core.Capacitor.getPlatform();
    capabilities = (await import('@/lib/platform')).capabilities();
    // Keep the page alive for the assertions below.
    Object.assign(globalThis, { __page: page });
  });

  afterAll(() => {
    delete (globalThis as { Capacitor?: unknown }).Capacitor;
    delete (globalThis as { CapacitorCustomPlatform?: unknown }).CapacitorCustomPlatform;
  });

  it('answers from the bridge and not from the development shim', async () => {
    expect(platform).toBe('server');

    const answer = await LlamaCpp.getCapabilities();
    /*
     * THE ASSERTION THE WHOLE MILESTONE TURNS ON.
     *
     * `src/plugins/llama-cpp/web.ts` reports `simulated: true` and synthesises
     * prose. Measured against the real `@capacitor/core`: with the platform
     * named `'server'` and NO plugin header seeded, `registerPlugin` resolves
     * to that shim — so a served deployment would stream convincing text while
     * the machine's llama.cpp host sat idle. With the header seeded, this
     * reads `false` and names the bridge's own answer.
     */
    expect(answer.simulated).toBe(false);
    expect(answer.engineVersion).toBe('server-real');
  });

  it('makes the capability row the server row, all the way from the served script', () => {
    // The seam closes here: a string in a generated script -> the custom
    // platform global -> `Capacitor.getPlatform()` -> the row in
    // `src/lib/platform.ts`. Nothing in `src/` had to learn about a server.
    expect(capabilities.id).toBe('server');
    // `'opfs'` would put multi-gigabyte weights in the connecting browser's
    // private filesystem, where the process holding the GPU cannot read them.
    expect(capabilities.modelStore).toBe('filesystem');
  });
});
