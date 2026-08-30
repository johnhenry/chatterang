import { beforeEach, describe, expect, it } from 'vitest';

import type { IRChatRequest, IRStreamChunk } from '@johnhenry/aimatey-types';
import { Router } from '@johnhenry/aimatey-core';

import { LlamaCppBackendAdapter } from '@/ai/backends/llama-cpp';
import { DEFAULT_SAMPLER, type ModelManifest } from '@/domain/manifest';
import { catalogEntry } from '@/data/catalog';

/**
 * Integration test over the seam the architecture depends on: the Capacitor
 * plugin wrapped as an aimatey `BackendAdapter`. It runs against the web
 * implementation of the plugin, which is real code — the same path a browser
 * build takes.
 */

const manifest = catalogEntry('qwen3-4b-instruct-q4km') as ModelManifest;

function resolver(overrides: Partial<Record<'path', string | null>> = {}) {
  return {
    getManifest: (id: string) => (id === manifest.id ? manifest : null),
    getPath: () => (overrides.path === undefined ? '/dev/model.gguf' : overrides.path),
    getSampler: () => ({ ...DEFAULT_SAMPLER, maxTokens: 128 }),
  };
}

function request(overrides: Partial<IRChatRequest> = {}): IRChatRequest {
  return {
    messages: [{ role: 'user', content: 'Say something.' }],
    parameters: { model: manifest.id },
    metadata: { requestId: `req_${Math.random().toString(16).slice(2)}`, timestamp: Date.now() },
    stream: true,
    ...overrides,
  };
}

async function collect(stream: AsyncGenerator<IRStreamChunk>): Promise<IRStreamChunk[]> {
  const chunks: IRStreamChunk[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

describe('LlamaCppBackendAdapter', () => {
  let adapter: LlamaCppBackendAdapter;

  beforeEach(() => {
    adapter = new LlamaCppBackendAdapter({ resolver: resolver() });
  });

  it('advertises capabilities the router can route on', () => {
    expect(adapter.metadata.name).toBe('llama-cpp');
    expect(adapter.metadata.capabilities.streaming).toBe(true);
    expect(adapter.metadata.capabilities.multiModal).toBe(true);
    expect(adapter.metadata.capabilities.tools).toBe(true);
  });

  it('renders the prompt with the manifest’s own template', () => {
    const { prompt } = adapter.fromIR(request());
    // Qwen ships ChatML.
    expect(prompt).toContain('<|im_start|>user');
    expect(prompt).toContain('Say something.');
  });

  it('extracts base64 images and leaves URL images to the text path', () => {
    const { images } = adapter.fromIR(
      request({
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'what is this' },
              { type: 'image', source: { type: 'base64', mediaType: 'image/png', data: 'QUJD' } },
              { type: 'image', source: { type: 'url', url: 'https://example.com/a.png' } },
            ],
          },
        ],
      }),
    );
    expect(images).toHaveLength(1);
    expect(images[0]).toEqual({ data: 'QUJD', mediaType: 'image/png' });
  });

  it('completes a non-streaming request with usage and provenance', async () => {
    const response = await adapter.execute(request({ stream: false }));

    expect(response.message.role).toBe('assistant');
    expect(response.message.content.length).toBeGreaterThan(0);
    expect(response.finishReason).toBe('stop');
    expect(response.usage?.completionTokens).toBeGreaterThan(0);
    expect(response.metadata.provenance?.backend).toBe('llama-cpp');
    expect(response.metadata.custom?.local).toBe(true);
  });

  it('streams start → content → metadata → done, in order', async () => {
    const chunks = await collect(adapter.executeStream(request()));
    const types = chunks.map((chunk) => chunk.type);

    expect(types[0]).toBe('start');
    expect(types).toContain('content');
    expect(types.at(-1)).toBe('done');

    const text = chunks
      .filter((chunk): chunk is Extract<IRStreamChunk, { type: 'content' }> => chunk.type === 'content')
      .map((chunk) => chunk.delta)
      .join('');
    expect(text.length).toBeGreaterThan(0);

    const done = chunks.at(-1);
    if (done?.type !== 'done') throw new Error('expected a done chunk');
    expect(done.finishReason).toBe('stop');
    expect(done.message?.content).toBe(text);
  });

  it('numbers chunks monotonically so consumers can order them', async () => {
    const chunks = await collect(adapter.executeStream(request()));
    const sequences = chunks.map((chunk) => chunk.sequence);
    expect(sequences).toEqual([...sequences].sort((a, b) => a - b));
    expect(new Set(sequences).size).toBe(sequences.length);
  });

  it('emits an error chunk rather than throwing when the model is missing', async () => {
    const missing = new LlamaCppBackendAdapter({
      resolver: {
        getManifest: () => null,
        getPath: () => null,
        getSampler: () => DEFAULT_SAMPLER,
      },
    });

    const chunks = await collect(missing.executeStream(request()));
    const error = chunks.find((chunk) => chunk.type === 'error');
    expect(error).toBeDefined();
    if (error?.type !== 'error') throw new Error('expected an error chunk');
    expect(error.error.code).toBe('model_load_failed');
    expect(error.error.message).toContain('not installed');
  });

  it('reports a missing file distinctly from a missing manifest', async () => {
    const broken = new LlamaCppBackendAdapter({ resolver: resolver({ path: null }) });
    const chunks = await collect(broken.executeStream(request()));
    const error = chunks.find((chunk) => chunk.type === 'error');
    if (error?.type !== 'error') throw new Error('expected an error chunk');
    expect(error.error.message).toContain('missing');
  });

  it('surfaces load warnings so the UI can say the shim is in use', async () => {
    const warnings: string[] = [];
    const warned = new LlamaCppBackendAdapter({
      resolver: resolver(),
      onWarning: (message) => warnings.push(message),
    });

    await warned.execute(request({ stream: false }));
    expect(warnings.join(' ')).toMatch(/shim|download/i);
  });

  it('reports zero marginal cost, because on-device inference has none', async () => {
    await expect(adapter.estimateCost()).resolves.toBe(0);
  });

  it('passes a health check when the plugin responds', async () => {
    await expect(adapter.healthCheck()).resolves.toBe(true);
  });

  it('reuses a loaded model across requests instead of reloading', async () => {
    let loads = 0;
    const counting = new LlamaCppBackendAdapter({
      resolver: {
        ...resolver(),
        getPath: () => {
          loads += 1;
          return '/dev/model.gguf';
        },
      },
    });

    await counting.execute(request({ stream: false }));
    const afterFirst = loads;
    await counting.execute(request({ stream: false }));

    expect(counting.residentModelId).toBe(manifest.id);
    expect(loads).toBe(afterFirst);
  });
});

describe('router integration', () => {
  it('serves the adapter through an aimatey Router by explicit backend', async () => {
    const router = new Router({ routingStrategy: 'explicit', fallbackStrategy: 'none' });
    router.register('llama-cpp', new LlamaCppBackendAdapter({ resolver: resolver() }));

    expect(router.listBackends()).toContain('llama-cpp');

    const response = await router.execute({
      ...request({ stream: false }),
      metadata: {
        requestId: 'req_router',
        timestamp: Date.now(),
        custom: { backend: 'llama-cpp' },
      },
    });

    expect(response.message.content.length).toBeGreaterThan(0);
  });

  it('lets a backend be removed without touching any call site', () => {
    const router = new Router();
    router.register('llama-cpp', new LlamaCppBackendAdapter({ resolver: resolver() }));
    router.register('spare', new LlamaCppBackendAdapter({ resolver: resolver() }));

    expect(router.has('spare')).toBe(true);
    router.unregister('spare');
    expect(router.has('spare')).toBe(false);
    expect(router.has('llama-cpp')).toBe(true);
  });

  it('allows removing the last backend, as of aimatey 0.2.0', () => {
    // The Router used to throw rather than leave itself with nothing to route
    // to, which made disconnecting your only provider impossible
    // (johnhenry/ai.matey#49, fixed in #53). Zero backends is a legitimate
    // transient state; the next request reports it clearly.
    const router = new Router();
    router.register('only', new LlamaCppBackendAdapter({ resolver: resolver() }));
    router.unregister('only');
    expect(router.listBackends()).toEqual([]);
  });

  it('can swap a backend’s configuration in place', () => {
    // `replace()` is what makes rotating a provider's API key possible at all.
    const router = new Router();
    router.register('llama-cpp', new LlamaCppBackendAdapter({ resolver: resolver() }));

    const replacement = new LlamaCppBackendAdapter({ resolver: resolver() });
    router.replace('llama-cpp', replacement);

    expect(router.get('llama-cpp')).toBe(replacement);
    expect(router.listBackends()).toEqual(['llama-cpp']);
  });
});
