import { describe, expect, it } from 'vitest';

import { MessageId } from '@deepseek-ai/dsh-llm';
import type { GenerateOptions, Message, StreamChunk } from '@deepseek-ai/dsh-llm';
import { Router } from '@johnhenry/aimatey-core';
import { FunctionBackendAdapter } from '@johnhenry/aimatey-backend-browser';
import type { IRChatRequest, IRStreamChunk } from '@johnhenry/aimatey-types';
import type { GenerateOptions as EngineGenerateOptions, GenerateSampler } from '@chatterang/contracts';

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
    // LAYER 3, which the shipped boot now runs. The field was `treeAssertion`
    // until [15] — a name that read as an assertion result while every value it
    // ever held described an assertion that did not run — and the walk it named
    // is now real: `applyProfile` hands back the fiber of every row it mounted,
    // and `assertEntries` reads each one's state.
    expect(mount.status.entries).toEqual(PROFILE_ROWS.map((row) => row.id));
    // Still honest about the edge it does NOT cover: rows nobody handed in.
    expect(mount.status.notChecked).toContain('plugins mounted outside');
    // Layer 2: the routes are actually registered, not merely expected.
    expect(mount.listProviders()).toEqual(expect.arrayContaining([ROUTER_SENTINEL, 'echo']));
  });

  it('reports NOT mounted when a row dies late — the failure only layer 3 can see', async () => {
    // THE INJECTED ABSENCE FOR LAYER 3, and it has to be a failure the other
    // two layers are structurally blind to, or it proves nothing about layer 3.
    // So: every service present, every route registered, and one row dead.
    //
    // Both `llm-invariant` rows are mounted BEFORE the `invariants` registry
    // they inject, so both park — `await` on a parked fiber resolves, which is
    // why nothing throws at mount. When the registry appears, the first
    // registers `@deepseek-ai/dsh-llm` and the second is refused and goes
    // FAILED, with no caller left to reject. `llm-invariant` provides no
    // service and claims no provider route, so layers 1 and 2 cannot see it.
    const mount = await mountDsh({
      router: routerWithEcho(),
      rows: [
        { id: 'llm-invariant', name: '@deepseek-ai/dsh-llm/invariant' },
        { id: 'llm-invariant-again', name: '@deepseek-ai/dsh-llm/invariant' },
        { id: 'llm', name: '@deepseek-ai/dsh-llm' },
        { id: 'invariants', name: '@deepseek-ai/dsh-invariants' },
        { id: 'aimatey-router', name: '@chatterang/cordis-aimatey' },
      ],
    });

    // Layers 1 and 2 would have passed: the services are there and the routes
    // are registered. Asserted, not assumed — otherwise this test could be
    // passing on the wrong failure.
    expect(mount.listProviders()).toEqual([ROUTER_SENTINEL, 'echo']);
    expect(mount.status.mounted).toBe(false);
    expect(mount.status.error).toMatch(/profile row\(s\) did not activate: llm-invariant-again/);
    expect(mount.status.error).toMatch(/is FAILED/);
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
      entries: [],
      notChecked: 'n/a',
    }));
    expect(DSH_PLUGIN.events).toEqual([]);
    expect(() => host.addListener(1, 'DshHost', 'anything', 1)).toThrow(/emits no event/);
  });
});

/* ── The sampler the engine is actually handed ────────────────────────── */

describe('what reaches the engine when DSH asks for a bounded turn', () => {
  /**
   * A plugin that records the `generate` call and answers immediately.
   *
   * Deliberately NOT `as unknown as LlamaCppPlugin` over an empty object: the
   * defect this pins survived because every existing fake ignored the sampler,
   * so the fake here has to be the observation channel. It emits one token
   * event and resolves, which is the smallest thing `#stream` can consume.
   */
  function recordingPlugin(): { plugin: LlamaCppPlugin; calls: EngineGenerateOptions[] } {
    const calls: EngineGenerateOptions[] = [];
    const listeners = new Set<(event: { requestId: string; token: string; index: number }) => void>();
    const plugin = {
      getCapabilities: async () => ({ simulated: false }),
      load: async () => ({ handle: 'h1' }),
      unload: async () => undefined,
      cancel: async () => undefined,
      addListener: async (
        _name: string,
        listener: (event: { requestId: string; token: string; index: number }) => void,
      ) => {
        listeners.add(listener);
        return { remove: async (): Promise<void> => void listeners.delete(listener) };
      },
      generate: async (options: EngineGenerateOptions) => {
        calls.push(options);
        for (const listener of listeners) listener({ requestId: options.requestId, token: 'hi', index: 0 });
        return {
          requestId: options.requestId,
          text: 'hi',
          promptTokens: 3,
          cachedTokens: 0,
          completionTokens: 1,
          ttftMs: 1,
          totalMs: 1,
          tokensPerSecond: 1,
          stopReason: 'stop' as const,
        };
      },
    } as unknown as LlamaCppPlugin;
    return { plugin, calls };
  }

  async function streamThrough(
    calls: EngineGenerateOptions[],
    plugin: LlamaCppPlugin,
    overrides: Partial<GenerateOptions>,
  ): Promise<{ sampler: GenerateSampler | undefined; chunks: StreamChunk[] }> {
    const router = new Router({ routingStrategy: 'explicit', fallbackStrategy: 'none' });
    router.register('llama-cpp-desktop', new DesktopLlamaBackend({ plugin }));
    const mount = await mountDsh({ router });
    const message: Message = {
      id: MessageId('m1'),
      role: 'user',
      content: [{ type: 'text', text: 'hello' }],
      source: { kind: 'user' },
    };
    const chunks: StreamChunk[] = [];
    for await (const chunk of mount.ctx.llm.stream({
      provider: 'llama-cpp-desktop',
      model: 'gemma-test.gguf',
      messages: [message],
      ...overrides,
    })) {
      chunks.push(chunk);
    }
    return { sampler: calls.at(-1)?.sampler, chunks };
  }

  it('forwards maxTokens, temperature and stop from the DSH request', async () => {
    // THE DEFECT, as the first real turn showed it: these three were accepted
    // by `GenerateOptions`, translated into `IRChatRequest.parameters`, and
    // then dropped — the backend passed the engine template stop sequences and
    // nothing else, so a caller asking for 16 tokens got the engine's 1024.
    const { plugin, calls } = recordingPlugin();
    const { sampler, chunks } = await streamThrough(calls, plugin, {
      maxTokens: 16,
      temperature: 0.1,
      stop: ['STOP-HERE'],
    });

    expect(chunks.at(-1)?.type).toBe('finish');
    expect(sampler?.maxTokens).toBe(16);
    expect(sampler?.temperature).toBe(0.1);
    // The caller's stop sequence AND the template's: dropping the template's
    // would let the model talk past its own end-of-turn marker, and dropping
    // the caller's would ignore what they asked for.
    expect(sampler?.stopSequences).toEqual(['STOP-HERE', '<end_of_turn>']);
  });

  it('leaves an unset parameter unset rather than inventing a default', async () => {
    // The inference host has no saved per-model settings to fall back on, so
    // "unspecified" must reach the engine as absent — a plausible number here
    // would silently change how every DSH turn samples.
    const { plugin, calls } = recordingPlugin();
    const { sampler } = await streamThrough(calls, plugin, {});

    expect(sampler?.maxTokens).toBeUndefined();
    expect(sampler?.temperature).toBeUndefined();
    expect(sampler?.seed).toBeUndefined();
    expect(sampler?.stopSequences).toEqual(['<end_of_turn>']);
  });

  it('forwards a zero temperature, which is greedy decoding and not "unset"', async () => {
    const { plugin, calls } = recordingPlugin();
    const { sampler } = await streamThrough(calls, plugin, { temperature: 0 });
    expect(sampler?.temperature).toBe(0);
  });
});
