import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BackendAdapter, IRStreamChunk } from '@johnhenry/aimatey-types';
import { FunctionBackendAdapter } from '@johnhenry/aimatey-backend-browser';

import {
  ChatterangEngine,
  leavesThisDevice,
  runsOnThisDevice,
  targetFor,
  type EngineTarget,
  type ToolEgressPolicy,
  type ToolEgressRequest,
} from '@/ai/engine';
import type {
  DestinationDecision,
  DestinationRequest,
  ToolDestinationPolicy,
} from '@/ai/middleware/tools';
import { holdsGrant, reachPaired, type EgressGrant } from '@/domain/chat';
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
  GRANTED_PROBE,
  MCP_CALL,
  MCP_CALL_CLEAN,
  PROBE_SERVER,
  SECRET,
  callsThenFails,
  cloudTarget,
  drainEvents,
  leakyTool,
  mcpProbe,
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
    // A stand-in for the tunnel adapter Track B will register. Present so a
    // paired target reaches the egress gate rather than the unregistered-
    // backend backstop that sits above it -- which would "pass" the assertion
    // for entirely the wrong reason.
    const paired = recordingBackend(turns);
    engine.router.register('tunnel:pair_0091', paired.adapter);
    return { engine, cloud, paired };
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

  /**
   * #208. `EngineTarget.local` was one boolean answering three questions, and a
   * paired desktop is the destination that separates them: it is the user's own
   * hardware, but the bytes still leave this phone.
   *
   * The tempting registration for a tunnel adapter is `local: true` — it is my
   * machine, after all — and that would have silently deleted the sheet, sending
   * tool output to a second computer with no prompt, no grant and no receipt, in
   * an app whose `privacy` command promises otherwise. `leavesThisDevice()`
   * exists so that reading is not available.
   *
   * Nothing writes a `paired` reach yet; the tunnel is Track B. Constructing one
   * here is the point — the gate has to be right *before* the producer lands,
   * because the producer's author is exactly who would reach for `local: true`.
   */
  describe('a turn tunnelled to a paired desktop', () => {
    const STUDIO = { id: 'pair_0091', name: "John's Studio" };

    const pairedTarget: EngineTarget = {
      backendId: 'tunnel:pair_0091',
      engine: 'remote',
      modelId: 'qwen3-4b-instruct-q4km',
      modelName: "Qwen3 4B · John's Studio",
      reach: reachPaired(STUDIO),
    };

    it('counts as leaving the device, and as not running here', () => {
      expect(leavesThisDevice(pairedTarget)).toBe(true);
      expect(runsOnThisDevice(pairedTarget)).toBe(false);
      // The control: an on-device target answers the opposite way, so these are
      // not two functions that always agree.
        const here = targetFor('llama-cpp', probeManifest.id, probeManifest.name, 'scripted');
      expect(leavesThisDevice(here)).toBe(false);
      expect(runsOnThisDevice(here)).toBe(true);
    });

    it('raises the same tool-egress sheet a provider raises', async () => {
      const { engine } = setUp();
      const request = vi.fn(async (_: ToolEgressRequest) => 'conversation' as const);

      await drainEvents(
        engine.stream({
          messages: [{ role: 'user', content: 'go' }],
          target: pairedTarget,
          toolIds: ['leaky'],
          egress: { isGranted: () => false, request },
        }),
      );

      expect(request).toHaveBeenCalledTimes(1);
      expect(request.mock.calls[0]?.[0]).toMatchObject({
        backendId: 'tunnel:pair_0091',
        modelName: "Qwen3 4B · John's Studio",
      });
      toolRegistry.unregister('leaky');
    });

    it('raises no sheet for the same turn run on this device', async () => {
      // The control for the test above: same messages, same tool, same rig —
      // only the destination differs. Without this, a sheet raised for every
      // turn would pass the assertion above just as well.
      const { engine } = setUp();
      const request = vi.fn(async (_: ToolEgressRequest) => 'conversation' as const);

      await drainEvents(
        engine.stream({
          messages: [{ role: 'user', content: 'go' }],
          target: targetFor('llama-cpp', probeManifest.id, probeManifest.name, 'scripted'),
          toolIds: ['leaky'],
          egress: { isGranted: () => false, request },
        }),
      );

      expect(request).not.toHaveBeenCalled();
      toolRegistry.unregister('leaky');
    });
  });

});

/* ── MCP arguments and the network (#6) ──────────────────────────────── */

/**
 * The promise: an MCP tool call's arguments do not reach its server unless this
 * conversation allows that server, at that address — whatever model wrote them.
 *
 * Driven against a LOCAL model on purpose. The tool-output gate never runs for
 * one, so nothing here can pass because another rule held the bytes back. The
 * server is a spy, and whether it was called is the whole measurement.
 */
describe('MCP arguments do not leave the device without a grant', () => {
  const local = (): EngineTarget =>
    targetFor('llama-cpp', probeManifest.id, probeManifest.name, 'scripted');
  const ask = (answer: DestinationDecision) =>
    vi.fn(async (_asked: DestinationRequest): Promise<DestinationDecision> => answer);

  afterEach(() => {
    for (const id of ['mcp:notes.note', 'mcp:archive.note', 'mcp:mirror.note', 'mcp:x.y', 'x.y']) {
      toolRegistry.unregister(id);
    }
  });

  function setUp(turns: string[] = [MCP_CALL, 'Done.']) {
    const probe = mcpProbe();
    toolRegistry.register(probe.tool);
    const engine = new ChatterangEngine({ resolver: probeResolver, fallbackBackendId: null });
    engine.router.register('scripted', recordingBackend(turns).adapter);
    engine.router.register('cloud', recordingBackend(turns).adapter);
    const run = (
      mcpEgress?: ToolDestinationPolicy,
      options: { target?: EngineTarget; toolIds?: string[] } = {},
    ) =>
      drainEvents(
        engine.stream({
          messages: [{ role: 'user', content: 'file my note' }],
          target: options.target ?? local(),
          toolIds: options.toolIds ?? [probe.tool.id],
          mcpEgress,
        }),
      );
    return { engine, probe, run };
  }

  /** A local backend that cannot take the turn at all, so it diverts. */
  function failsAtOnce(): BackendAdapter {
    return new FunctionBackendAdapter({
      execute: async () => {
        throw new Error('not enough memory');
      },
      // eslint-disable-next-line require-yield
      executeStream: async function* (): AsyncGenerator<IRStreamChunk> {
        throw new Error('not enough memory');
      },
    });
  }

  it('sends nothing with no policy, from a local model or a remote one', async () => {
    for (const target of [local(), cloudTarget]) {
      const { probe, run } = setUp();
      const events = await run(undefined, { target });

      expect(probe.call, target.backendId).not.toHaveBeenCalled();
      const tool = events.find((event) => event.type === 'tool');
      expect(tool?.type === 'tool' && tool.tool.output).toContain('were not sent to notes.example');
      expect(tool?.type === 'tool' && tool.tool.receipt).toBeUndefined();
      toolRegistry.unregister(probe.tool.id);
    }
  });

  it('sends the call, unasked, when the conversation holds a grant for that server', async () => {
    // The paired control for every refusal in this block.
    const { probe, run } = setUp();
    const request = ask('deny');

    await run({ ...GRANTED_PROBE, request });

    expect(probe.call).toHaveBeenCalledOnce();
    expect(probe.call).toHaveBeenCalledWith('notes', 'note', { text: SECRET }, undefined);
    expect(request).not.toHaveBeenCalled();
  });

  it('is not answered by a grant for another server, or for the same server at another address', async () => {
    const others: EgressGrant[][] = [
      [{ kind: 'mcp', serverId: 'mcp_other', url: PROBE_SERVER.url, grantedAt: 1 }],
      [{ kind: 'mcp', serverId: PROBE_SERVER.serverId, url: 'https://other.example/mcp', grantedAt: 1 }],
      [{ connectionId: PROBE_SERVER.serverId, grantedAt: 1 }],
    ];
    for (const grants of others) {
      const { probe, run } = setUp();
      await run({
        isGranted: (destination) =>
          holdsGrant(grants, { kind: 'mcp', serverId: destination.serverId, url: destination.url }),
      });
      expect(probe.call, JSON.stringify(grants)).not.toHaveBeenCalled();
      toolRegistry.unregister(probe.tool.id);
    }

    // The control: the grant the tool's own destination names does answer it.
    const { probe, run } = setUp();
    const own: EgressGrant[] = [{ kind: 'mcp', ...PROBE_SERVER, grantedAt: 1 }];
    await run({
      isGranted: (destination) =>
        holdsGrant(own, { kind: 'mcp', serverId: destination.serverId, url: destination.url }),
    });
    expect(probe.call).toHaveBeenCalledOnce();
  });

  it('sends nothing when the person says no', async () => {
    const { probe, run } = setUp();
    const request = ask('deny');

    const events = await run({ isGranted: () => false, request });

    expect(request).toHaveBeenCalledOnce();
    expect(probe.call).not.toHaveBeenCalled();
    const tool = events.find((event) => event.type === 'tool');
    expect(tool?.type === 'tool' && tool.tool.output).toBe(
      'The user did not allow sending this call’s arguments to notes.example.',
    );
  });

  it('asks once for every call to one server in a batch, and "these calls" sends exactly those', async () => {
    const { probe, run } = setUp([MCP_CALL + MCP_CALL_CLEAN, 'Done.']);
    const request = ask('calls');

    await run({ isGranted: () => false, request });

    expect(request).toHaveBeenCalledOnce();
    const asked = request.mock.calls[0]![0];
    expect(asked.destination).toEqual(probe.tool.destination);
    expect(asked.calls.map((call) => call.preview)).toEqual([
      `{"text":"${SECRET}"}`,
      '{"text":"a shopping list"}',
    ]);
    expect(probe.call).toHaveBeenCalledTimes(2);
  });

  it('asks separately for one server id at two addresses', async () => {
    const archiveCall = '<tool_call>{"name":"archive.note","arguments":{"text":"old"}}</tool_call>';
    const { probe, run } = setUp([MCP_CALL + archiveCall, 'Done.']);
    // The same server record id, at a different URL: somewhere else.
    const archive = mcpProbe({ serverName: 'archive', serverUrl: 'https://other.example/mcp' });
    toolRegistry.register(archive.tool);
    const request = ask('calls');

    await run({ isGranted: () => false, request }, { toolIds: [probe.tool.id, archive.tool.id] });

    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls.map(([asked]) => asked.destination.url)).toEqual([
      PROBE_SERVER.url,
      'https://other.example/mcp',
    ]);
    expect(probe.call).toHaveBeenCalledOnce();
    expect(archive.call).toHaveBeenCalledOnce();
  });

  it('does not let a grant for one server answer another server on the same host, or at the same address', async () => {
    // The test above cannot tell a key on the address from a key on the host
    // the sheet shows: its two addresses are on different hosts. These two
    // share one. A gateway serving several servers under one host is ordinary,
    // and a group keyed on anything coarser than the record's id and address
    // is checked against its FIRST call's destination — so the grant held for
    // the probe would carry the others' arguments unasked.
    const archiveCall = '<tool_call>{"name":"archive.note","arguments":{"text":"old"}}</tool_call>';
    const mirrorCall = '<tool_call>{"name":"mirror.note","arguments":{"text":"copy"}}</tool_call>';
    const { probe, run } = setUp([MCP_CALL + archiveCall + mirrorCall, 'Done.']);
    const archive = mcpProbe({
      serverName: 'archive',
      serverId: 'mcp_archive',
      serverUrl: 'https://notes.example/archive/mcp',
    });
    const mirror = mcpProbe({ serverName: 'mirror', serverId: 'mcp_mirror' });
    toolRegistry.register(archive.tool);
    toolRegistry.register(mirror.tool);
    expect(archive.tool.destination?.host).toBe(probe.tool.destination?.host);
    expect(mirror.tool.destination?.url).toBe(probe.tool.destination?.url);
    const request = ask('deny');

    await run(
      { ...GRANTED_PROBE, request },
      { toolIds: [probe.tool.id, archive.tool.id, mirror.tool.id] },
    );

    // The control: the server the grant names is sent to, unasked.
    expect(probe.call).toHaveBeenCalledOnce();
    expect(request.mock.calls.map(([asked]) => asked.destination.serverId)).toEqual([
      'mcp_archive',
      'mcp_mirror',
    ]);
    expect(archive.call).not.toHaveBeenCalled();
    expect(mirror.call).not.toHaveBeenCalled();
  });

  it('hands a conversation answer back to be kept, naming the server and its address', async () => {
    const { probe, run } = setUp();
    const onGranted = vi.fn();

    await run({ isGranted: () => false, request: ask('conversation'), onGranted });

    expect(onGranted).toHaveBeenCalledOnce();
    expect(onGranted).toHaveBeenCalledWith(probe.tool.destination);
    expect(probe.call).toHaveBeenCalledOnce();
  });

  it('refuses unasked after a fallback, unless the conversation already holds a grant', async () => {
    const diverted = async (policy: ToolDestinationPolicy) => {
      const probe = mcpProbe();
      toolRegistry.register(probe.tool);
      const engine = new ChatterangEngine({ resolver: probeResolver, fallbackBackendId: null });
      engine.router.register('scripted', failsAtOnce());
      engine.router.register('cloud', recordingBackend([MCP_CALL, 'Done.']).adapter);
      engine.setFallbackBackend('cloud');
      const events = await drainEvents(
        engine.stream({
          messages: [{ role: 'user', content: 'file my note' }],
          target: local(),
          toolIds: [probe.tool.id],
          mcpEgress: policy,
        }),
      );
      toolRegistry.unregister(probe.tool.id);
      return { probe, events };
    };

    const request = ask('conversation');
    const refused = await diverted({ isGranted: () => false, request });
    // The divert really happened, so the rule under test really ran.
    expect(refused.events.some((event) => event.type === 'fallback')).toBe(true);
    expect(request).not.toHaveBeenCalled();
    expect(refused.probe.call).not.toHaveBeenCalled();

    const granted = await diverted({ ...GRANTED_PROBE, request });
    expect(granted.events.some((event) => event.type === 'fallback')).toBe(true);
    expect(request).not.toHaveBeenCalled();
    expect(granted.probe.call).toHaveBeenCalledOnce();
  });

  it('refuses a tool with an mcp: id that does not say where it sends, whatever is allowed', async () => {
    const execute = vi.fn(async () => ({ output: 'sent' }));
    const unlabelled = {
      name: 'x.y',
      description: 'd',
      summary: 's',
      parameters: { type: 'object' as const },
      sensitive: true,
      execute,
    };
    const everything: ToolDestinationPolicy = { isGranted: () => true, request: ask('conversation') };
    const call = ['<tool_call>{"name":"x.y","arguments":{}}</tool_call>', 'Done.'];

    toolRegistry.register({ ...unlabelled, id: 'mcp:x.y' });
    const { run } = setUp(call);
    const events = await run(everything, { toolIds: ['mcp:x.y'] });
    expect(execute).not.toHaveBeenCalled();
    const tool = events.find((event) => event.type === 'tool');
    expect(tool?.type === 'tool' && tool.tool.output).toContain('does not say where its arguments would go');

    // The control: the same tool under an id that does not claim to be MCP runs.
    toolRegistry.unregister('mcp:x.y');
    toolRegistry.register({ ...unlabelled, id: 'x.y' });
    await setUp(call).run(everything, { toolIds: ['x.y'] });
    expect(execute).toHaveBeenCalledOnce();
  });
});