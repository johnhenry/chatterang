import { describe, expect, it } from 'vitest';

import { Router } from '@johnhenry/aimatey-core';
import { FunctionBackendAdapter } from '@johnhenry/aimatey-backend-browser';
import type { IRChatRequest, IRStreamChunk } from '@johnhenry/aimatey-types';

import { PROFILE_ROWS, ROUTER_SENTINEL } from '@chatterang/cordis-aimatey';
import type { LlamaCppPlugin } from '@chatterang/contracts';

import { DSH_PLUGIN, LLAMA_PLUGIN, PluginHost, createMainRouter } from '@chatterang/desktop/bridge';
import type { DshStatus, PluginImplementation } from '@chatterang/desktop/bridge';
import { mountDsh } from '@chatterang/desktop/host/dsh';
import { DesktopLlamaBackend } from '@chatterang/desktop/host/llama-backend';

/**
 * THE CALLER MILESTONE A4 LACKED.
 *
 * `packages/cordis-aimatey` has been tested since A4, but nothing mounted it,
 * and a mount nobody performs is indistinguishable from no mount. This file is
 * the first thing that boots the tree the desktop shell boots.
 *
 * WHERE IT RUNS. The task asked for DSH in the Electron main process; the
 * gates point at the inference utility process instead, and `apps/desktop/src/
 * host/dsh.ts` says why at length. The short version: DSH itself would be
 * perfectly happy in main — the eight installed `@deepseek-ai/*` packages are
 * pure JS, no koffi, no node-pty — but the `llm` adapter it registers routes
 * into `LlamaCppNode`, and a native addon that aborts takes its process with
 * it. In main that is the whole app and no terminal event is even conceivable.
 *
 * THE ASSERTION IS THE POINT. An unsatisfied Cordis `inject` parks its fiber
 * PENDING and `await fiber` RESOLVES, so a tree missing a row boots GREEN with
 * the service simply absent. Every "it mounted" test below is therefore paired
 * with an injected absence, because only the failing case proves the assertion
 * is doing anything.
 */

/** A backend that streams a fixed reply. Real adapter, no network. */
function echoBackend(): FunctionBackendAdapter {
  return new FunctionBackendAdapter({
    name: 'echo',
    async *stream(request: IRChatRequest): AsyncIterable<IRStreamChunk> {
      yield { type: 'start', sequence: 0, metadata: request.metadata };
      yield { type: 'content', sequence: 1, delta: 'ok', role: 'assistant' };
      yield {
        type: 'done',
        sequence: 2,
        finishReason: 'stop',
        message: { role: 'assistant', content: 'ok' },
      };
    },
  } as never);
}

function routerWithEcho(): Router {
  const router = new Router({ routingStrategy: 'explicit', fallbackStrategy: 'none' });
  router.register('echo', echoBackend());
  return router;
}

describe('the DSH tree the desktop shell boots', () => {
  it('mounts, and reports the services and routes it confirmed', async () => {
    const mount = await mountDsh({ router: routerWithEcho() });

    expect(mount.status.mounted).toBe(true);
    expect(mount.status.services).toEqual(['llm', 'invariants']);
    // The sentinel means "let the Router choose"; `echo` pins that backend.
    expect(mount.status.routes).toEqual([ROUTER_SENTINEL, 'echo']);
    expect(mount.status.error).toBeUndefined();
    // Honest about what was NOT checked, verbatim from assertBoot.
    expect(mount.status.treeAssertion).toContain('no loader is mounted');
    // Layer 2: the routes are actually registered, not merely expected.
    expect(mount.listProviders()).toEqual(expect.arrayContaining([ROUTER_SENTINEL, 'echo']));
  });

  it('reports NOT mounted when the llm row is missing — the silent-absence trap', async () => {
    // THE INJECTED ABSENCE. Drop the row that provides the `llm` service and
    // Cordis still resolves every fiber; without `assertBoot` this boot is
    // indistinguishable from the one above. Observed with the assertion
    // bypassed: `mounted` stayed true and `listProviders()` returned [].
    const mount = await mountDsh({
      router: routerWithEcho(),
      rows: PROFILE_ROWS.filter((row) => row.id !== 'llm'),
    });

    expect(mount.status.mounted).toBe(false);
    expect(mount.status.error).toMatch(/service\(s\) absent after boot: llm/);
    expect(mount.listProviders()).toEqual([]);
  });

  it('reports NOT mounted when the invariants row is missing', async () => {
    // The second half of the same trap: `llm-invariant` declares
    // `inject: ['invariants']`, so without the registry the stream grammar is
    // unenforced and the boot is otherwise green.
    const mount = await mountDsh({
      router: routerWithEcho(),
      rows: PROFILE_ROWS.filter((row) => row.id !== 'invariants'),
    });

    expect(mount.status.mounted).toBe(false);
    expect(mount.status.error).toMatch(/absent after boot: invariants/);
  });

  it('refuses a profile row it has no module for, rather than skipping it', async () => {
    await expect(
      mountDsh({
        router: routerWithEcho(),
        rows: [...PROFILE_ROWS, { id: 'ghost', name: '@deepseek-ai/dsh-not-installed' }],
      }),
    ).rejects.toThrow(/no module supplied for profile row\(s\): @deepseek-ai\/dsh-not-installed/);
  });

  it('mounts a Router whose only backend is local llama.cpp', async () => {
    // The shape the inference host actually builds: one backend, no remote
    // providers, and therefore no API key anywhere on this side of the
    // boundary. That is the security posture as an assertion rather than a
    // comment — a remote provider added here would change `routes`.
    const plugin = {
      getCapabilities: async () => ({ simulated: false }),
    } as unknown as LlamaCppPlugin;
    const router = new Router({ routingStrategy: 'explicit', fallbackStrategy: 'none' });
    router.register('llama-cpp-desktop', new DesktopLlamaBackend({ plugin }));

    const mount = await mountDsh({ router });
    expect(mount.status.mounted).toBe(true);
    expect(mount.status.routes).toEqual([ROUTER_SENTINEL, 'llama-cpp-desktop']);
  });
});

describe('the renderer can see whether the tree came up', () => {
  /** The `DshHost` plugin exactly as `main.ts` builds it, over a real mount. */
  function dshPlugin(status: DshStatus): PluginImplementation {
    return {
      getStatus: async () => status,
      listProviders: async () => ({ providers: status.routes }),
    };
  }

  it('answers getStatus and listProviders over the bridge', async () => {
    const mount = await mountDsh({ router: routerWithEcho() });
    const host = new PluginHost(() => true);
    host.register(LLAMA_PLUGIN, Object.fromEntries(
      LLAMA_PLUGIN.methods.map((m) => [m, async () => undefined]),
    ) as PluginImplementation);
    host.register(DSH_PLUGIN, dshPlugin(mount.status));

    const router = createMainRouter(host);
    const status = await router.handle(1, 'chatterang:call:DshHost:getStatus', []);
    expect(status).toMatchObject({ ok: true, data: { mounted: true } });

    const providers = await router.handle(1, 'chatterang:call:DshHost:listProviders', []);
    expect(providers).toEqual({ ok: true, data: { providers: [ROUTER_SENTINEL, 'echo'] } });
  });

  it('reports the failure rather than swallowing it', async () => {
    // A5's whole reason for the DshHost plugin: a tree that did not come up
    // must be VISIBLE. The desktop shell keeps running llama.cpp either way,
    // so without this the failure has nowhere to surface.
    const mount = await mountDsh({
      router: routerWithEcho(),
      rows: PROFILE_ROWS.filter((row) => row.id !== 'llm'),
    });
    const host = new PluginHost(() => true);
    host.register(DSH_PLUGIN, dshPlugin(mount.status));

    const answer = await createMainRouter(host).handle(1, 'chatterang:call:DshHost:getStatus', []);
    expect(answer).toMatchObject({
      ok: true,
      data: { mounted: false, error: expect.stringMatching(/absent after boot: llm/) },
    });
  });

  it('declares no events, and refuses a subscription to one', async () => {
    const host = new PluginHost(() => true);
    host.register(DSH_PLUGIN, dshPlugin({
      mounted: false,
      services: [],
      routes: [],
      treeAssertion: 'n/a',
    }));
    expect(DSH_PLUGIN.events).toEqual([]);
    expect(() => host.addListener(1, 'DshHost', 'anything', 1)).toThrow(/emits no event/);
  });
});
