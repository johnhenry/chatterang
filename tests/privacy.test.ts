import { describe, expect, it } from 'vitest';

import { buildPayload } from '@/lib/leaderboard';
import { stripForSpeech } from '@/lib/voice';
import { ENGINE_PHASE, isLocalEngine, type EngineId } from '@/domain/manifest';
import { CATALOG, IMAGE_GEN_RAM_FLOOR } from '@/data/catalog';
import { PROVIDERS, connectionConfig, getProvider } from '@/ai/providers';
import { BUILT_IN_PERSONAS, MARKETPLACE } from '@/data/personas';
import type { BenchmarkRun } from '@/db';

/**
 * These assert the promises the product makes, not just that the code runs.
 * A privacy-first app whose telemetry quietly gains a device identifier has
 * failed even if every other test passes.
 */

const run: BenchmarkRun = {
  id: 'bench_secret_id',
  modelId: 'qwen3-4b-instruct-q4km',
  modelName: 'Qwen3 4B Instruct',
  engine: 'llama-cpp',
  backend: 'gpu-metal',
  device: 'Apple A18 Pro',
  chipset: 'Apple A18 Pro',
  promptTokensPerSecond: 412.633,
  generateTokensPerSecond: 28.4127,
  peakMemoryBytes: 3.1 * 1024 ** 3,
  thermalStart: 0.14,
  thermalEnd: 0.41,
  samples: [29.1, 28.6, 27.5],
  repetitions: 3,
  createdAt: Date.UTC(2026, 2, 4, 15, 30, 0),
  uploadedAt: null,
};

describe('leaderboard payload', () => {
  const payload = buildPayload(run);

  it('carries only aggregate performance facts', () => {
    expect(Object.keys(payload).sort()).toEqual(
      [
        'appVersion',
        'chipset',
        'computeBackend',
        'day',
        'engine',
        'generateTokensPerSecond',
        'model',
        'peakMemoryMB',
        'promptTokensPerSecond',
        'quantization',
        'repetitions',
      ].sort(),
    );
  });

  it('contains no local run identifier', () => {
    expect(JSON.stringify(payload)).not.toContain(run.id);
  });

  it('truncates the timestamp to the day, so runs cannot be correlated', () => {
    expect(payload.day).toBe('2026-03-04');
    expect(JSON.stringify(payload)).not.toContain('15:30');
  });

  it('rounds throughput rather than shipping full precision', () => {
    expect(payload.generateTokensPerSecond).toBe(28.41);
    expect(payload.peakMemoryMB).toBe(Math.round(run.peakMemoryBytes / 1024 / 1024));
  });
});

describe('stripForSpeech', () => {
  it('removes markdown that would otherwise be read aloud', () => {
    expect(stripForSpeech('**bold** and _italic_ and `code`')).toBe('bold and italic and code');
    expect(stripForSpeech('# Heading\n- item')).toBe('Heading item');
  });

  it('replaces code blocks with a spoken placeholder', () => {
    expect(stripForSpeech('Try:\n```js\nconst a = 1;\n```')).toBe('Try: (code block)');
  });

  it('drops reasoning traces — they are working, not an answer', () => {
    expect(stripForSpeech('<think>hmm</think>The answer.')).toBe('The answer.');
  });

  it('keeps link text and discards the URL', () => {
    expect(stripForSpeech('See [the docs](https://example.com).')).toBe('See the docs.');
  });

  it('drops images entirely', () => {
    expect(stripForSpeech('![alt](a.png) after')).toBe('after');
  });
});

describe('engine registry', () => {
  it('classifies every engine as local except remote providers', () => {
    const engines: EngineId[] = [
      'llama-cpp',
      'onnx-runtime',
      'litert-lm',
      'chrome-ai',
      'mlc-llm',
      'cactus',
      'executorch',
    ];
    for (const engine of engines) expect(isLocalEngine(engine)).toBe(true);
    expect(isLocalEngine('remote')).toBe(false);
  });

  it('records the rollout phase each engine belongs to', () => {
    expect(ENGINE_PHASE['llama-cpp']).toBe(1);
    expect(ENGINE_PHASE['onnx-runtime']).toBe(1);
    expect(ENGINE_PHASE['mlc-llm']).toBe(2);
    expect(ENGINE_PHASE.cactus).toBe(3);
    expect(ENGINE_PHASE.executorch).toBe(4);
  });
});

describe('model catalog', () => {
  it('has unique ids', () => {
    const ids = CATALOG.map((manifest) => manifest.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('states a real size and memory requirement for every entry', () => {
    for (const manifest of CATALOG) {
      expect(manifest.sizeBytes).toBeGreaterThan(0);
      expect(manifest.minRAM).toBeGreaterThan(0);
      expect(manifest.recommendedRAM).toBeGreaterThanOrEqual(manifest.minRAM);
      expect(manifest.license.length).toBeGreaterThan(0);
      expect(manifest.source.repo).toContain('/');
    }
  });

  it('routes each entry to an engine that can serve its capabilities', () => {
    for (const manifest of CATALOG) {
      if (manifest.capabilities.includes('image-out')) expect(manifest.engine).toBe('onnx-runtime');
      if (manifest.capabilities.includes('vision')) expect(manifest.engine).toBe('llama-cpp');
    }
  });

  it('gives vision models the projector they need', () => {
    for (const manifest of CATALOG.filter((entry) => entry.capabilities.includes('vision'))) {
      const roles = manifest.source.companions?.map((companion) => companion.role) ?? [];
      expect(roles).toContain('mmproj');
    }
  });

  it('sets an image-generation memory floor above any phone that cannot cope', () => {
    expect(IMAGE_GEN_RAM_FLOOR).toBeGreaterThanOrEqual(4 * 1024 ** 3);
  });
});

describe('provider catalog', () => {
  it('gives every provider an honest note about where data goes', () => {
    for (const provider of PROVIDERS) {
      expect(provider.note.length).toBeGreaterThan(20);
      if (provider.kind === 'cloud') {
        expect(provider.note.toLowerCase()).toMatch(/leave|servers/);
      }
    }
  });

  it('has unique ids and a loader for each', () => {
    const ids = PROVIDERS.map((provider) => provider.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const provider of PROVIDERS) expect(typeof provider.load).toBe('function');
  });

  it('builds an adapter config that falls back to the descriptor defaults', () => {
    const config = connectionConfig({
      id: 'c1',
      providerId: 'ollama',
      label: 'Ollama',
      apiKey: '',
      baseUrl: '',
      defaultModel: '',
      enabled: true,
      models: [],
      createdAt: 0,
    });

    expect(config.baseURL).toBe(getProvider('ollama')?.defaultBaseUrl);
    expect(config.defaultModel).toBe(getProvider('ollama')?.defaultModel);
  });

  it('does not enable browser mode for self-hosted endpoints that do not need it', () => {
    expect(getProvider('ollama')?.browserMode).toBeFalsy();
  });
});

describe('persona catalog', () => {
  it('marks the built-ins as undeletable', () => {
    for (const persona of BUILT_IN_PERSONAS) expect(persona.builtin).toBe(true);
  });

  it('gives every built-in a name, tagline, and description', () => {
    for (const persona of BUILT_IN_PERSONAS) {
      expect(persona.name.length).toBeGreaterThan(0);
      expect(persona.tagline.length).toBeGreaterThan(0);
      expect(persona.description.length).toBeGreaterThan(10);
    }
  });

  it('gives paid marketplace listings a store product id, and free ones none', () => {
    for (const listing of MARKETPLACE) {
      if (listing.price > 0) expect(listing.productId).toBeTruthy();
      else expect(listing.productId).toBeNull();
    }
  });

  it('never ships a marketplace persona flagged as built-in', () => {
    for (const listing of MARKETPLACE) expect(listing.persona.builtin).toBe(false);
  });

  it('uses unique persona ids across built-ins and the marketplace', () => {
    const ids = [
      ...BUILT_IN_PERSONAS.map((persona) => persona.id),
      ...MARKETPLACE.map((listing) => listing.persona.id),
    ];
    expect(new Set(ids).size).toBe(ids.length);
  });
});
