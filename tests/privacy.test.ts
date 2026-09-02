import { describe, expect, it, vi } from 'vitest';

import {
  ChatterangEngine,
  targetFor,
  type ToolEgressPolicy,
  type ToolEgressRequest,
} from '@/ai/engine';
import { toolRegistry } from '@/ai/tools/registry';
import { buildPayload } from '@/lib/leaderboard';
import { stripForSpeech } from '@/lib/voice';
import { ENGINE_PHASE, isLocalEngine, type EngineId } from '@/domain/manifest';
import { CATALOG, IMAGE_GEN_RAM_FLOOR } from '@/data/catalog';
import { PROVIDERS, connectionConfig, getProvider } from '@/ai/providers';
import { BUILT_IN_PERSONAS, MARKETPLACE } from '@/data/personas';
import type { BenchmarkRun } from '@/db';
import {
  CALL,
  SECRET,
  callsThenFails,
  cloudTarget,
  drainEvents,
  leakyTool,
  probeManifest,
  probeResolver,
  recordingBackend,
  sent,
} from './support/egress-probe';

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

/* ── Tool output and the network ─────────────────────────────────────── */

/**
 * The promise: a tool's output does not leave this device unless this
 * conversation holds a grant for the destination it would leave to.
 *
 * These drive the real `ChatterangEngine.stream` and record at the
 * `BackendAdapter` boundary — the last app-owned code before a provider SDK.
 * Everything is asserted on the bytes the backend was handed, not on a flag
 * the engine set about itself.
 *
 * The pair matters as much as either half. A test that only asserted the
 * canary is ABSENT would pass if someone "fixed" this by deleting the tool
 * loop; a test that only asserted it is PRESENT under a grant would pass if the
 * gate never ran. Both are here, against the same probe.
 */
/**
 * The rig lives in `./support/egress-probe`, shared with `privacy-copy.test.ts`
 * so both suites measure the same thing rather than two copies of it.
 */

describe('tool output does not leave the device without a grant', () => {
  function setUp(turns: string[] = [CALL, 'Done.']) {
    toolRegistry.register(leakyTool);
    const engine = new ChatterangEngine({ resolver: probeResolver, fallbackBackendId: null });
    const cloud = recordingBackend(turns);
    engine.router.register('cloud', cloud.adapter);
    return { engine, cloud };
  }

  it('is a real probe: the tool really does return the user’s data', async () => {
    // Without this, every "absent" assertion below could pass because the
    // canary was never produced in the first place.
    const result = await leakyTool.execute();
    expect(result.output).toContain(SECRET);
  });

  it('withholds it from a remote backend the conversation has not granted', async () => {
    const { engine, cloud } = setUp();

    const events = await drainEvents(
      engine.stream({
        messages: [{ role: 'user', content: 'what is in my chats?' }],
        target: cloudTarget,
        toolIds: ['leaky'],
      }),
    );

    expect(cloud.seen).toHaveLength(2);
    const requests = sent(cloud.seen);
    // Request 1 could not have carried it — the tool had not run.
    expect(requests[0]).not.toContain(SECRET);
    // Request 2 is the one that leaked before this change.
    expect(requests[1]).not.toContain(SECRET);
    // Withheld, not dropped: the tool turn is still there and the model is
    // told what happened, so it does not simply re-run the command.
    expect(requests[1]).toContain('declined to send');
    expect(requests[1]).toContain('tool_result');

    // And the user is not the one kept in the dark — the real output is in the
    // event stream that paints the thread.
    const tool = events.find((event) => event.type === 'tool');
    expect(tool?.type === 'tool' && tool.tool.output).toContain(SECRET);

    const done = events.at(-1);
    expect(done?.type === 'done' && done.provenance.toolEgress).toBe('withheld');
    toolRegistry.unregister('leaky');
  });

  it('sends it when the conversation holds a grant for that destination', async () => {
    const { engine, cloud } = setUp();
    const policy: ToolEgressPolicy = { isGranted: (id) => id === 'cloud' };

    const events = await drainEvents(
      engine.stream({
        messages: [{ role: 'user', content: 'what is in my chats?' }],
        target: cloudTarget,
        toolIds: ['leaky'],
        egress: policy,
      }),
    );

    expect(sent(cloud.seen)[1]).toContain(SECRET);
    const done = events.at(-1);
    expect(done?.type === 'done' && done.provenance.toolEgress).toBe('granted');
    toolRegistry.unregister('leaky');
  });

  it('asks once, and a "conversation" answer is handed back to be persisted', async () => {
    const { engine, cloud } = setUp();
    const onGranted = vi.fn();
    const request = vi.fn(async (_: ToolEgressRequest) => 'conversation' as const);

    await drainEvents(
      engine.stream({
        messages: [{ role: 'user', content: 'go' }],
        target: cloudTarget,
        toolIds: ['leaky'],
        egress: { isGranted: () => false, request, onGranted },
      }),
    );

    expect(request).toHaveBeenCalledTimes(1);
    // The sheet is told what it is asking about, in the terms the user reads.
    expect(request.mock.calls[0]?.[0]).toMatchObject({
      backendId: 'cloud',
      modelName: 'GPT-4o mini',
    });
    expect(onGranted).toHaveBeenCalledWith('cloud');
    expect(sent(cloud.seen)[1]).toContain(SECRET);
    toolRegistry.unregister('leaky');
  });

  it('does not raise a second sheet when the model re-runs the same command', async () => {
    // Four tool-calling turns in a row. Without the per-turn cache this is four
    // sheets, and a sheet that can be raised four times is one people learn to
    // tap through without reading.
    const { engine } = setUp([CALL]);
    const request = vi.fn(async () => 'deny' as const);

    const events = await drainEvents(
      engine.stream({
        messages: [{ role: 'user', content: 'go' }],
        target: cloudTarget,
        toolIds: ['leaky'],
        egress: { isGranted: () => false, request },
      }),
    );

    expect(events.filter((event) => event.type === 'tool').length).toBeGreaterThan(1);
    expect(request).toHaveBeenCalledTimes(1);
    toolRegistry.unregister('leaky');
  });

  it('withholds on a fallback without asking — the user is already waiting', async () => {
    // The case no dialog covers well, and the one that does not require the
    // user to have chosen a remote model at all: they picked a local one, the
    // device could not cope mid-turn, and the loop retargeted.
    toolRegistry.register(leakyTool);
    const engine = new ChatterangEngine({ resolver: probeResolver, fallbackBackendId: null });
    engine.router.register('scripted', callsThenFails());
    const cloud = recordingBackend(['Answered remotely.']);
    engine.router.register('cloud', cloud.adapter);
    engine.setFallbackBackend('cloud');

    const request = vi.fn(async () => 'conversation' as const);
    const events = await drainEvents(
      engine.stream({
        messages: [{ role: 'user', content: 'summarise my chats' }],
        target: targetFor('llama-cpp', probeManifest.id, probeManifest.name, 'scripted'),
        toolIds: ['leaky'],
        egress: { isGranted: () => false, request },
      }),
    );

    // The fallback fired, so the turn did divert — otherwise the assertions
    // below would be about a code path that never ran.
    expect(events.some((event) => event.type === 'fallback')).toBe(true);
    // The remote provider's first and only request must not carry it.
    expect(cloud.seen.length).toBeGreaterThan(0);
    for (const payload of sent(cloud.seen)) expect(payload).not.toContain(SECRET);
    // And it is resolved structurally rather than by interrupting.
    expect(request).not.toHaveBeenCalled();
    // The fallback's own promise is kept: a reply was still generated.
    const done = events.at(-1);
    expect(done?.type === 'done' && done.text).toBe('Answered remotely.');
    toolRegistry.unregister('leaky');
  });

  it('leaves a local turn completely alone — nothing is withheld on device', async () => {
    // The control. If this failed, the rule would be costing the app the
    // feature rather than protecting it.
    toolRegistry.register(leakyTool);
    const engine = new ChatterangEngine({ resolver: probeResolver, fallbackBackendId: null });
    const local = recordingBackend([CALL, 'Three files.']);
    engine.router.register('scripted', local.adapter);

    const events = await drainEvents(
      engine.stream({
        messages: [{ role: 'user', content: 'what is in my chats?' }],
        target: targetFor('llama-cpp', probeManifest.id, probeManifest.name, 'scripted'),
        toolIds: ['leaky'],
      }),
    );

    expect(sent(local.seen)[1]).toContain(SECRET);
    expect(events.some((event) => event.type === 'egress')).toBe(false);
    const done = events.at(-1);
    expect(done?.type === 'done' && done.provenance.toolEgress).toBeUndefined();
    toolRegistry.unregister('leaky');
  });
});
