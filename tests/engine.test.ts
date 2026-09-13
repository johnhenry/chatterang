import { createElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  BackendAdapter,
  IRChatRequest,
  IRChatResponse,
  IRStreamChunk,
} from '@johnhenry/aimatey-types';
import { FunctionBackendAdapter } from '@johnhenry/aimatey-backend-browser';
import { AdapterError } from '@johnhenry/aimatey-errors';

import { ChatterangEngine, targetFor, type GenerationEvent } from '@/ai/engine';
import { DEFAULT_SAMPLER } from '@/domain/manifest';
import { catalogEntry } from '@/data/catalog';
import { toolRegistry } from '@/ai/tools/registry';
import type { FallbackReason } from '@/ai/middleware/resilience';
import { REACH_REMOTE } from '@/domain/chat';

/**
 * Dexie, stubbed at the table boundary.
 *
 * Only the last block in this file needs it: the refusal aimed at the
 * providers screen is checked by MOUNTING that screen, and `useApp` opens a
 * real IndexedDB otherwise. Nothing else here touches `@/db` — `@/ai/engine`
 * and the tool registry do not import it — so the stub cannot change the
 * behaviour of any test above.
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

/**
 * The device the engine's pre-flight asks about.
 *
 * `null` is a healthy device, which is what every test that does not set it
 * gets — the real `checkDevicePressure` reads a Capacitor plugin that is not
 * present under jsdom and returns null anyway, so this changes nothing for the
 * existing tests and gives the ones below a hot phone to reason about.
 */
const devicePressure = vi.hoisted(() => ({
  value: null as { reason: string; detail: string } | null,
}));

vi.mock('@/ai/middleware/resilience', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/ai/middleware/resilience')>();
  return { ...actual, checkDevicePressure: async () => devicePressure.value };
});

/** A device too hot to start a local generation on. */
const HOT: { reason: FallbackReason; detail: string } = {
  reason: 'thermal',
  detail: 'Thermal state critical (0.95).',
};

/**
 * Integration tests over `ChatterangEngine.stream`.
 *
 * These exist because the unit tests did not catch a real defect: aimatey's
 * `Bridge.use()` middleware is silently skipped for streamed requests
 * (johnhenry/ai.matey#46), so the tool and fallback middleware never ran in
 * the app even though both were covered in isolation. Anything that must
 * happen on a *streamed* turn is asserted here, through the real engine.
 */

const manifest = catalogEntry('qwen3-4b-instruct-q4km')!;

const resolver = {
  getManifest: (id: string) => (id === manifest.id ? manifest : null),
  getPath: () => '/dev/model.gguf',
  getSampler: () => ({ ...DEFAULT_SAMPLER, maxTokens: 64 }),
};

/** A backend that replies with a scripted script of turns, in order. */
function scriptedBackend(turns: string[]): BackendAdapter {
  let turn = 0;

  const respond = (request: IRChatRequest): IRChatResponse => ({
    message: { role: 'assistant', content: turns[Math.min(turn++, turns.length - 1)] ?? '' },
    finishReason: 'stop',
    metadata: { requestId: request.metadata.requestId, timestamp: Date.now() },
  });

  return new FunctionBackendAdapter({
    execute: async (request) => respond(request),
    executeStream: async function* (request): AsyncGenerator<IRStreamChunk> {
      const text = turns[Math.min(turn++, turns.length - 1)] ?? '';
      yield { type: 'start', sequence: 0, metadata: request.metadata };
      // Two chunks, so the test also covers delta accumulation.
      yield { type: 'content', sequence: 1, delta: text.slice(0, 3) };
      yield { type: 'content', sequence: 2, delta: text.slice(3) };
      yield { type: 'done', sequence: 3, finishReason: 'stop' };
    },
  });
}

/**
 * A backend that drops a content frame but still reports the full text in its
 * `done.message` — what a lossy tunnel looks like from this side (#148).
 *
 * The far side assembled the whole reply; some of it did not arrive. Before
 * the checksum, this produced a short reply with nothing to say so, and the
 * user read it as the model stopping early.
 */
function lossyBackend(text: string, dropFrom: number): BackendAdapter {
  return new FunctionBackendAdapter({
    execute: async (request) => ({
      message: { role: 'assistant', content: text },
      finishReason: 'stop',
      metadata: { requestId: request.metadata.requestId, timestamp: Date.now() },
    }),
    executeStream: async function* (request): AsyncGenerator<IRStreamChunk> {
      yield { type: 'start', sequence: 0, metadata: request.metadata };
      yield { type: 'content', sequence: 1, delta: text.slice(0, dropFrom) };
      // sequence 2 is dropped in flight — that is the whole point.
      yield {
        type: 'done',
        sequence: 3,
        finishReason: 'stop',
        message: { role: 'assistant', content: text },
      };
    },
  });
}

/** A backend whose stream always fails, to exercise the fallback path. */
function failingBackend(message: string): BackendAdapter {
  return new FunctionBackendAdapter({
    execute: async () => {
      throw new Error(message);
    },
    // eslint-disable-next-line require-yield
    executeStream: async function* (): AsyncGenerator<IRStreamChunk> {
      throw new Error(message);
    },
  });
}

/**
 * A backend that reports PROVIDER_UNAVAILABLE, as `chrome-ai` does when the
 * Prompt API is missing. `isRetryable` is the flag the engine reads to tell a
 * temporary pause from a permanent capability gap.
 */
function unavailableBackend(isRetryable: boolean): BackendAdapter {
  const fail = (): never => {
    // The real class, and the real message, copied from
    // aimatey-backend-browser/dist/esm/chrome-ai.js:240-244. A plain object
    // with a `code` property is not the same test: the bridge only re-throws
    // genuine AdapterErrors and wraps everything else.
    throw new AdapterError({
      code: 'PROVIDER_UNAVAILABLE',
      message:
        'Chrome AI (Prompt API) is not available - requires Chrome 138+ with the ' +
        '`LanguageModel` global (chrome://flags/#prompt-api-for-gemini-nano may be required)',
      isRetryable,
      provenance: { backend: 'chrome-ai' },
    });
  };
  return new FunctionBackendAdapter({
    execute: async () => fail(),
    // eslint-disable-next-line require-yield
    executeStream: async function* (): AsyncGenerator<IRStreamChunk> {
      fail();
    },
  });
}

async function drain(stream: AsyncGenerator<GenerationEvent>): Promise<GenerationEvent[]> {
  const events: GenerationEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

function textOf(events: GenerationEvent[]): string {
  return events
    .filter((event): event is Extract<GenerationEvent, { type: 'delta' }> => event.type === 'delta')
    .map((event) => event.text)
    .join('');
}

/**
 * Mount a component into a throwaway host, run `body`, then tear it down.
 *
 * The refusal below is a sentence about a screen, so it is checked against
 * that screen rather than against a description of it.
 */
async function mounted(
  element: ReturnType<typeof createElement>,
  body: (host: HTMLElement) => Promise<void> | void,
): Promise<void> {
  const { act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => {
      root.render(element);
    });
    await body(host);
  } finally {
    await act(async () => {
      root.unmount();
    });
    host.remove();
  }
}

function doneEvent(events: GenerationEvent[]) {
  const done = events.at(-1);
  if (done?.type !== 'done') throw new Error(`expected a done event, got ${done?.type}`);
  return done;
}

describe('ChatterangEngine.stream', () => {
  let engine: ChatterangEngine;

  beforeEach(() => {
    devicePressure.value = null;
    engine = new ChatterangEngine({ resolver, fallbackBackendId: null });
  });

  const localTarget = targetFor('llama-cpp', manifest.id, manifest.name, 'scripted');

  it('streams deltas and finishes with provenance', async () => {
    engine.router.register('scripted', scriptedBackend(['Hello there.']));

    const events = await drain(
      engine.stream({ messages: [{ role: 'user', content: 'hi' }], target: localTarget }),
    );

    expect(events[0]).toEqual({ type: 'start', requestId: expect.any(String) });
    expect(textOf(events)).toBe('Hello there.');

    const done = doneEvent(events);
    expect(done.text).toBe('Hello there.');
    expect(done.provenance.local).toBe(true);
    expect(done.provenance.modelName).toBe(manifest.name);
  });

  /* ── The regression this file exists for ─────────────────────────── */

  it('runs the tool loop on a STREAMED turn', async () => {
    // Turn 1 asks for a tool; turn 2 is the answer that uses its result.
    engine.router.register(
      'scripted',
      scriptedBackend([
        '<tool_call>{"name":"calculate","arguments":{"expression":"4096*12"}}</tool_call>',
        'It is 49152.',
      ]),
    );

    const events = await drain(
      engine.stream({
        messages: [{ role: 'user', content: 'what is 4096 * 12?' }],
        target: localTarget,
        toolIds: ['calculator'],
      }),
    );

    const toolEvents = events.filter(
      (event): event is Extract<GenerationEvent, { type: 'tool' }> => event.type === 'tool',
    );
    expect(toolEvents).toHaveLength(1);
    expect(toolEvents[0]?.tool.name).toBe('calculate');
    expect(toolEvents[0]?.tool.output).toContain('49152');
    expect(toolEvents[0]?.tool.isError).toBe(false);

    const done = doneEvent(events);
    expect(done.text).toBe('It is 49152.');
    expect(done.tools).toHaveLength(1);
  });

  it('keeps tool syntax out of the answer the user sees', async () => {
    engine.router.register(
      'scripted',
      scriptedBackend([
        '<tool_call>{"name":"calculate","arguments":{"expression":"2+2"}}</tool_call>',
        'Four.<tool_call>{"name":"calculate","arguments":{}}</tool_call>',
      ]),
    );

    const done = doneEvent(
      await drain(
        engine.stream({
          messages: [{ role: 'user', content: 'x' }],
          target: localTarget,
          toolIds: ['calculator'],
        }),
      ),
    );

    expect(done.text).toBe('Four.');
    expect(done.text).not.toContain('tool_call');
  });

  it('does not run tools when the chat has none enabled', async () => {
    engine.router.register(
      'scripted',
      scriptedBackend(['<tool_call>{"name":"calculate","arguments":{"expression":"1+1"}}</tool_call>']),
    );

    const events = await drain(
      engine.stream({ messages: [{ role: 'user', content: 'x' }], target: localTarget }),
    );

    expect(events.filter((event) => event.type === 'tool')).toHaveLength(0);
  });

  it('bounds the tool loop rather than looping forever', async () => {
    const alwaysCallsTool =
      '<tool_call>{"name":"calculate","arguments":{"expression":"1+1"}}</tool_call>';
    engine.router.register('scripted', scriptedBackend([alwaysCallsTool]));

    const events = await drain(
      engine.stream({
        messages: [{ role: 'user', content: 'x' }],
        target: localTarget,
        toolIds: ['calculator'],
      }),
    );

    const toolCount = events.filter((event) => event.type === 'tool').length;
    expect(toolCount).toBeGreaterThan(0);
    expect(toolCount).toBeLessThanOrEqual(4);
    expect(doneEvent(events)).toBeTruthy();
  });

  it('diverts a failed local turn to the nominated fallback, on the STREAMED path', async () => {
    engine.router.register('scripted', failingBackend('not enough memory'));
    engine.router.register('remote', scriptedBackend(['Answered remotely.']));
    engine.setFallbackBackend('remote');

    const events = await drain(
      engine.stream({ messages: [{ role: 'user', content: 'hi' }], target: localTarget }),
    );

    const fallback = events.find(
      (event): event is Extract<GenerationEvent, { type: 'fallback' }> => event.type === 'fallback',
    );
    expect(fallback?.event.reason).toBe('memory');
    expect(fallback?.event.from).toBe('scripted');
    expect(fallback?.event.to).toBe('remote');

    const done = doneEvent(events);
    expect(done.text).toBe('Answered remotely.');
    expect(done.provenance.local).toBe(false);
    expect(done.provenance.fallbackFrom).toBe('scripted');

    /*
     * #149. Before this, the only thing that ever said "this turn was
     * degraded" was `metadata.warnings`, written by middleware that
     * early-returns on every streamed request -- so on THIS path, the one
     * every chat turn takes, nothing said it at all. The fallback event above
     * carried the fact and nothing converted it.
     */
    const warnings = done.provenance.warnings ?? [];
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      // Not `capability-unsupported`: the backend was capable, it was
      // replaced. The upstream doc names that misuse directly.
      category: 'model-substituted',
      severity: 'warning',
      source: 'scripted',
    });
    // The sentence is the one a person reads, not a code.
    expect(warnings[0]?.message).toMatch(/memory/i);
  });

  it('catches a dropped content frame against done.message, and blames the transport', async () => {
    engine.router.register('scripted', lossyBackend('The full answer is here.', 9));

    const events = await drain(
      engine.stream({ messages: [{ role: 'user', content: 'hi' }], target: localTarget }),
    );

    const done = doneEvent(events);
    // What the user sees is short — that part is unavoidable, the bytes are
    // gone. Trailing space trimmed by `stripToolSyntax` on the way out; the
    // checksum ran against the raw 9 accumulated characters, which is why the
    // shortfall below is 15 and not 14.
    expect(done.text).toBe('The full');

    // What is new is that something says so, and says it is the link.
    const warnings = done.provenance.warnings ?? [];
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.category).toBe('transport-degraded');
    expect(warnings[0]?.message).toContain('15 characters');
    // The defect this fixes: a short or scrambled reply read as the model
    // failing. The sentence must not point at the model.
    expect(warnings[0]?.message).not.toMatch(/model/i);
  });

  it('reports no warning on a clean turn, so the field means something', async () => {
    // The control. A `warnings` array present on every turn would make the
    // assertion above pass for a reason that has nothing to do with fallback.
    engine.router.register('scripted', scriptedBackend(['All fine.']));

    const events = await drain(
      engine.stream({ messages: [{ role: 'user', content: 'hi' }], target: localTarget }),
    );

    const done = doneEvent(events);
    expect(done.text).toBe('All fine.');
    expect(done.provenance.warnings).toBeUndefined();
  });

  /*
   * #228. The Router did not honour `fallbackStrategy: 'none'`: when a
   * backend's circuit opened, selectBackend fell through to "final fallback:
   * first available backend", so a turn aimed at a local model was ANSWERED by
   * whatever else happened to be registered -- no fallback event, no egress
   * prompt.
   *
   * THESE NO LONGER DISCRIMINATE, and that is worth saying plainly rather than
   * leaving them to look like proof. aimatey-core 0.4.0 (ai.matey#134/#135)
   * fixed the router half, so with the engine's pre-flight guard removed these
   * still pass: the router now refuses at selection, the engine's own failure
   * handler catches that error, resolves the nominated fallback and emits the
   * same FallbackEvent. Same outcome, reached reactively instead of ahead of
   * time. Measured -- with the guard stubbed to `false`, 24 of 24 pass here,
   * where before the upgrade three failed.
   *
   * The guard is kept for two reasons, neither of which these tests prove:
   * it refuses before the egress gate reads its destination, and it is the
   * only thing standing between a config change (an app setting a substituting
   * `fallbackStrategy`) and the original defect. Whoever next needs to prove
   * the guard itself will have to construct a Router that substitutes, which
   * the engine's own configuration no longer does.
   *
   * All three drive the real breaker: threshold is 3, so three failures open
   * the target's circuit and the fourth attempt is the one that used to be
   * served by the wrong backend.
   */
  describe('a divert the user did not consent to', () => {
    /**
     * Every local backend failing, one remote one healthy -- so the only
     * substitution the router can make is off-device. Without that, the
     * healthy llama-cpp shim answers instead and the assertion about cloud
     * text is not load-bearing.
     */
    function armBreaker(): void {
      engine.router.register('scripted', failingBackend('local engine died'));
      engine.router.replace('llama-cpp', failingBackend('local engine died'));
      engine.router.register('conn_openai', scriptedBackend(Array(16).fill('ANSWERED BY THE CLOUD.')));
    }

    async function attempt(): Promise<GenerationEvent[]> {
      return drain(engine.stream({ messages: [{ role: 'user', content: 'hi' }], target: localTarget }));
    }

    it('refuses rather than letting the router pick a backend nobody nominated', async () => {
      armBreaker();
      // Nothing nominated: engine is constructed with fallbackBackendId null.

      // Seven attempts, because that is how long the broken path needed to
      // reach the cloud: three failures open `scripted`, three more open
      // llama-cpp, and the seventh had nowhere left on-device to go. With the
      // check in place every attempt after the third simply refuses.
      let events: GenerationEvent[] = [];
      const everything: string[] = [];
      for (let i = 0; i < 7; i += 1) {
        events = await attempt();
        everything.push(
          events
            .filter((event) => event.type === 'delta')
            .map((event) => (event as Extract<GenerationEvent, { type: 'delta' }>).text)
            .join(''),
        );
      }

      // The measured defect: attempts 6 and 7 answered 'ANSWERED BY THE CLOUD.'
      expect(everything.join('')).not.toContain('CLOUD');
      expect(events.some((event) => event.type === 'done')).toBe(false);

      const last = events.at(-1);
      expect(last?.type).toBe('error');
      // And it says something about the model the user chose, not a router id.
      if (last?.type === 'error') {
        expect(last.message).toContain(manifest.name);
        expect(last.message).not.toContain('conn_openai');
      }
    });

    it('diverts through the consent path when a fallback IS nominated', async () => {
      armBreaker();
      engine.setFallbackBackend('conn_openai');

      let events: GenerationEvent[] = [];
      for (let i = 0; i < 4; i += 1) events = await attempt();

      // The same destination as before -- but announced, and only because it
      // was nominated. The chip and the toast hang off this event.
      const fallback = events.find(
        (event): event is Extract<GenerationEvent, { type: 'fallback' }> => event.type === 'fallback',
      );
      expect(fallback, 'a fallback event is emitted').toBeTruthy();
      expect(fallback?.event.from).toBe('scripted');
      expect(fallback?.event.to).toBe('conn_openai');

      const done = doneEvent(events);
      expect(done.text).toBe('ANSWERED BY THE CLOUD.');
      expect(done.provenance.local).toBe(false);
      expect(done.provenance.fallbackFrom).toBe('scripted');
    });

    it('announces the divert BEFORE the egress gate reads its destination', async () => {
      // The egress gate keys on target.backendId. A substitution made after it
      // would have taken consent for one destination and used another, so the
      // fallback must be the earlier event.
      armBreaker();
      engine.setFallbackBackend('conn_openai');

      let events: GenerationEvent[] = [];
      for (let i = 0; i < 4; i += 1) events = await attempt();

      const fallbackAt = events.findIndex((event) => event.type === 'fallback');
      const firstDeltaAt = events.findIndex((event) => event.type === 'delta');
      expect(fallbackAt).toBeGreaterThanOrEqual(0);
      expect(fallbackAt).toBeLessThan(firstDeltaAt);
    });
  });

  it('surfaces the failure when no fallback has been nominated — consent is required', async () => {
    engine.router.register('scripted', failingBackend('engine died'));
    engine.router.register('spare', scriptedBackend(['unused']));

    const events = await drain(
      engine.stream({ messages: [{ role: 'user', content: 'hi' }], target: localTarget }),
    );

    const error = events.find(
      (event): event is Extract<GenerationEvent, { type: 'error' }> => event.type === 'error',
    );
    expect(error?.message).toContain('engine died');
    expect(events.some((event) => event.type === 'fallback')).toBe(false);
  });

  it('does not divert a remote failure — only local turns are eligible', async () => {
    engine.router.register('cloud', failingBackend('provider 500'));
    engine.router.register('remote', scriptedBackend(['should not be used']));
    engine.setFallbackBackend('remote');

    const events = await drain(
      engine.stream({
        messages: [{ role: 'user', content: 'hi' }],
        target: { backendId: 'cloud', engine: 'remote', modelId: 'm', modelName: 'Cloud', reach: REACH_REMOTE },
      }),
    );

    expect(events.some((event) => event.type === 'fallback')).toBe(false);
    expect(events.at(-1)?.type).toBe('error');
  });

  it('stops cleanly when the caller aborts', async () => {
    engine.router.register('scripted', failingBackend('aborted'));
    const controller = new AbortController();
    controller.abort();

    const events = await drain(
      engine.stream({
        messages: [{ role: 'user', content: 'hi' }],
        target: localTarget,
        signal: controller.signal,
      }),
    );

    expect(events.some((event) => event.type === 'error')).toBe(false);
    expect(events.at(-1)?.type).toBe('done');
  });

  it('reports a tool the registry does not have, without failing the turn', async () => {
    const spy = vi.spyOn(toolRegistry, 'getByName');
    engine.router.register(
      'scripted',
      scriptedBackend([
        '<tool_call>{"name":"teleport","arguments":{}}</tool_call>',
        'I cannot do that.',
      ]),
    );

    const events = await drain(
      engine.stream({
        messages: [{ role: 'user', content: 'x' }],
        target: localTarget,
        toolIds: ['calculator'],
      }),
    );

    const tool = events.find(
      (event): event is Extract<GenerationEvent, { type: 'tool' }> => event.type === 'tool',
    );
    expect(tool?.tool.isError).toBe(true);
    expect(tool?.tool.output).toContain('teleport');
    expect(doneEvent(events).text).toBe('I cannot do that.');
    spy.mockRestore();
  });

  /* ── A missing runtime is not a reason to answer from the cloud ────── */

  /**
   * A target naming an unregistered backend used to reach the tool loop, throw
   * `Requested backend 'onnx-runtime' is not registered`, and — because
   * `target.local` is true for every on-device engine — get classified
   * `engine-error` and RE-RUN against the configured fallback.
   *
   * Measured before the guard existed, with a speech model as the chat model
   * and a cloud provider configured: events were
   * ["start","fallback","delta","done"] and the cloud answered. The user's
   * message left the device, over a model chosen precisely because it was
   * local. The chain only "failed closed" for people who had no fallback set.
   */
  describe('a target whose backend this build never registered', () => {
    it('refuses instead of diverting the turn to the cloud fallback', async () => {
      engine.router.register('conn_cloud', scriptedBackend(['Sure! Here is an answer.']));
      engine.setFallbackBackend('conn_cloud');

      const events = await drain(
        engine.stream({
          messages: [{ role: 'user', content: 'my private note' }],
          // Exactly what `targetFor(manifest.engine, ...)` builds for the
          // speech model in the report.
          target: targetFor('onnx-runtime', 'whisper-tiny-en-onnx', 'Whisper Tiny (English)'),
        }),
      );

      expect(events.map((event) => event.type)).toEqual(['start', 'error']);
      expect(textOf(events)).toBe('');

      // Refused in terms of the model and the missing runtime — not in
      // aimatey's vocabulary about a router registration table.
      const error = events.at(-1);
      expect(error?.type).toBe('error');
      expect(error && 'message' in error ? error.message : '').toContain(
        'Whisper Tiny (English)',
      );
      expect(error && 'message' in error ? error.message : '').not.toContain('is not registered');
    });

    /**
     * The check has to run before the device-pressure pre-flight, not merely
     * before the tool loop.
     *
     * Measured with the check sitting one block lower — after the pre-flight —
     * on a hot device with a fallback configured: ["start","fallback","delta",
     * "delta","done"], text "Sure! Here is an answer.", answered by the cloud.
     * The identical escape the check exists to close, reached by the other of
     * the two paths that retarget a local turn.
     *
     * The target is the residual class this backstop is the only cover for: a
     * `text`-capable model on an engine declared in ENGINE_IDS that nothing
     * registers. `resolveTarget` refuses the reported speech models earlier.
     */
    it('refuses before the device-pressure pre-flight can divert it', async () => {
      devicePressure.value = HOT;
      engine.router.register('conn_cloud', scriptedBackend(['Sure! Here is an answer.']));
      engine.setFallbackBackend('conn_cloud');

      const events = await drain(
        engine.stream({
          messages: [{ role: 'user', content: 'my private note' }],
          target: targetFor('mlc-llm', 'some-future-model', 'Some Future Model'),
        }),
      );

      expect(events.map((event) => event.type)).toEqual(['start', 'error']);
      expect(events.some((event) => event.type === 'fallback')).toBe(false);
      expect(textOf(events)).toBe('');
    });

    /**
     * Hoisting the check above the pre-flight must not have disabled the
     * pre-flight. A REGISTERED local backend on a hot device is exactly what
     * device-pressure fallback is for, and it still diverts.
     */
    it('still diverts a registered local backend on a hot device', async () => {
      devicePressure.value = HOT;
      engine.router.register('scripted', scriptedBackend(['should not be used']));
      engine.router.register('conn_cloud', scriptedBackend(['Answered remotely.']));
      engine.setFallbackBackend('conn_cloud');

      const events = await drain(
        engine.stream({ messages: [{ role: 'user', content: 'hi' }], target: localTarget }),
      );

      const fallback = events.find(
        (event): event is Extract<GenerationEvent, { type: 'fallback' }> =>
          event.type === 'fallback',
      );
      expect(fallback?.event.reason).toBe('thermal');
      expect(fallback?.event.from).toBe('scripted');
      expect(textOf(events)).toBe('Answered remotely.');
    });

    it('still diverts a genuine runtime failure, which fallback is for', async () => {
      engine.router.register('scripted', failingBackend('CUDA out of memory'));
      engine.router.register('conn_cloud', scriptedBackend(['Answered remotely.']));
      engine.setFallbackBackend('conn_cloud');

      const events = await drain(
        engine.stream({ messages: [{ role: 'user', content: 'hi' }], target: localTarget }),
      );

      // The guard above must not have broken this: a registered backend that
      // fails at run time is precisely the case fallback exists to rescue.
      expect(events.map((event) => event.type)).toContain('fallback');
      expect(textOf(events)).toBe('Answered remotely.');
    });
  });

  /* ── What the refusal is allowed to claim ──────────────────────────── */

  /**
   * The refusal reaches the user verbatim, so it has to be true.
   *
   * An unregistered backend has two unrelated causes and the message used to
   * assert the wrong one for both. Measured, with the single-sentence version:
   * a connection whose `connectProvider` failed produced "OpenAI · gpt-4o-mini
   * needs the remote runtime, which this build does not include. Choose
   * another model." — the build DOES include the remote runtime, the cause is
   * a key or a network, and picking a different model does not fix either.
   */
  describe('what it tells the user', () => {
    function messageFor(events: GenerationEvent[]): string {
      const last = events.at(-1);
      if (last?.type !== 'error') throw new Error(`expected an error event, got ${last?.type}`);
      return last.message;
    }

    it('says a remote connection is not connected, and points at Settings', async () => {
      // A connection left `enabled` in state after `connectProvider` threw —
      // src/state/app.ts catches that, toasts, and moves on, so the router
      // never got it.
      const events = await drain(
        engine.stream({
          messages: [{ role: 'user', content: 'hi' }],
          target: {
            backendId: 'conn_openai',
            engine: 'remote',
            modelId: 'gpt-4o-mini',
            modelName: 'OpenAI · gpt-4o-mini',
            reach: REACH_REMOTE,
          },
        }),
      );

      const message = messageFor(events);
      expect(message).toContain('OpenAI · gpt-4o-mini');
      expect(message).toContain('Settings');
      // The two false claims. The build ships every remote adapter it ever
      // shipped, and nothing here is a missing runtime.
      expect(message).not.toContain('does not include');
      expect(message).not.toContain('runtime');
      // Nor aimatey's vocabulary about a registration table.
      expect(message).not.toContain('is not registered');
    });

    it('says a paused model is paused, in place of aimatey routing vocabulary', async () => {
      /*
       * Driven through the REAL breaker, not a hand-thrown error, because the
       * string that reaches the user is not the one #187 predicted.
       *
       * The ticket expected `Circuit breaker is open for backend 'x'` from
       * checkCircuitBreaker. That is unreachable here: selectBackend only
       * prefers the explicit backend if isBackendAvailable(), and an open
       * circuit makes it unavailable -- so selection SKIPS it and the breaker
       * check never runs. Once every circuit is open, selection has nothing
       * left and throws NO_BACKEND_AVAILABLE: `No available backend for
       * routing`, which is what users were actually reading.
       *
       * Threshold is 3, so three failures open the target's circuit, three
       * more open llama-cpp's, and from the seventh attempt nothing is left.
       */
      engine.router.register('scripted', failingBackend('local engine died'));
      engine.router.replace('llama-cpp', failingBackend('local engine died'));

      let message = '';
      for (let attempt = 0; attempt < 7; attempt += 1) {
        message = messageFor(
          await drain(engine.stream({ messages: [{ role: 'user', content: 'hi' }], target: localTarget })),
        );
      }

      // The vocabulary that was reaching the message row and a `crit` toast.
      expect(message).not.toContain('No available backend');
      expect(message).not.toContain('routing');
      expect(message).not.toContain('Circuit breaker');
      expect(message).not.toContain('scripted');
      // What it says instead: the model the user chose, and the wait.
      expect(message).toContain(manifest.name);
      expect(message).toContain('30 seconds');
      expect(message).toContain('choose another model');
    });

    it('does not tell a user to wait when the backend will never be available', async () => {
      /*
       * The other route to "nothing can take this turn", and it must not get
       * the same sentence. `chrome-ai` throws PROVIDER_UNAVAILABLE when the
       * Prompt API is absent -- a permanent capability gap carrying "requires
       * Chrome 138+ ... chrome://flags/#prompt-api-for-gemini-nano". Mapping
       * the code alone would tell that user to try again in thirty seconds,
       * forever. `isRetryable` separates them: the breaker sets it, a
       * capability failure leaves it at the AdapterError default of false.
       */
      engine.router.register('chrome-ai', unavailableBackend(false));
      const message = messageFor(
        await drain(
          engine.stream({
            messages: [{ role: 'user', content: 'hi' }],
            target: {
              backendId: 'chrome-ai',
              engine: 'remote' as const,
              modelId: 'gemini-nano',
              modelName: 'Chrome · Gemini Nano',
              reach: REACH_REMOTE,
            },
          }),
        ),
      );

      expect(message).toContain('Chrome · Gemini Nano');
      expect(message).toContain('Choose another model');
      // No false wait, and none of the vendor detail the adapter carries.
      expect(message).not.toContain('seconds');
      expect(message).not.toContain('chrome://');
      expect(message).not.toContain('Chrome 138');
    });

    /**
     * The step it names has to work on the screen as that screen actually is.
     *
     * "Reconnect it in Settings" did not. Measured by mounting the real
     * `ProvidersPanel` with a connection whose `connectProvider` threw — which
     * `initialize` catches and toasts, leaving `enabled` true in state:
     *
     *   <button role="switch" aria-checked="true" aria-label="Enable OpenAI">
     *   <button class="icon-btn" aria-label="Remove OpenAI">   (a trash glyph)
     *   list__title "OpenAI" · list__sub "gpt-4o-mini"
     *
     * Three controls on the whole panel — enable, remove, add — no "Reconnect"
     * anywhere, no edit control, and a toggle rendering CHECKED, so the screen
     * the sentence sends the user to reports the provider as on and shows no
     * problem at all. A user who follows the old sentence arrives, sees a
     * healthy row, and has nothing to press.
     *
     * So the sentence now names the two remedies that do exist, and this test
     * holds it to them by rendering the panel: toggling off and on re-runs
     * `connectProvider` (state/app.ts `toggleConnection`), and remove-then-add
     * is the only way to change a wrong key, because there is nothing to edit.
     * Delete either control from the panel and this goes red.
     */
    it('names remedies that exist on the providers screen, and warns it looks healthy', async () => {
      const message = messageFor(
        await drain(
          engine.stream({
            messages: [{ role: 'user', content: 'hi' }],
            target: {
              backendId: 'conn_openai',
              engine: 'remote',
              modelId: 'gpt-4o-mini',
              modelName: 'OpenAI · gpt-4o-mini',
              reach: REACH_REMOTE,
            },
          }),
        ),
      );

      // The same connection, in the state the panel reads: enabled, and never
      // registered on the router.
      const { useApp } = await import('@/state/app');
      const { ProvidersPanel } = await import('@/features/settings/ProvidersPanel');
      useApp.setState({
        connections: [
          {
            id: 'conn_openai',
            providerId: 'openai',
            label: 'OpenAI',
            apiKey: 'sk-wrong',
            baseUrl: '',
            defaultModel: 'gpt-4o-mini',
            enabled: true,
            models: [],
            createdAt: 0,
          },
        ],
      });
      expect(engine.hasBackend('conn_openai')).toBe(false);

      await mounted(createElement(ProvidersPanel), (host) => {
        const toggle = host.querySelector('[role="switch"][aria-label="Enable OpenAI"]');
        // The screen says the provider is on. The sentence must not pretend
        // the user will arrive to find something visibly broken.
        expect(toggle?.getAttribute('aria-checked')).toBe('true');
        expect(message).toContain('still shows as switched on');

        // Remedy one: the toggle. Off and on re-runs `connectProvider`.
        expect(toggle).not.toBeNull();
        expect(message).toContain('switch it off and on again');

        // Remedy two: remove and add. It is named because there is no edit
        // control — a wrong key cannot be corrected in place.
        expect(host.querySelector('[aria-label="Remove OpenAI"]')).not.toBeNull();
        expect(message).toContain('remove it and add it again');
        expect(host.querySelector('[aria-label^="Edit"]')).toBeNull();

        // And no control called "Reconnect" was ever there to point at.
        expect(host.textContent).not.toContain('Reconnect');
        expect(message).not.toContain('Reconnect');
      });
    });

    it('reserves the missing-build sentence for an absent local engine', async () => {
      const events = await drain(
        engine.stream({
          messages: [{ role: 'user', content: 'hi' }],
          target: targetFor('onnx-runtime', 'whisper-tiny-en-onnx', 'Whisper Tiny (English)'),
        }),
      );

      const message = messageFor(events);
      expect(message).toContain('Whisper Tiny (English)');
      expect(message).toContain('this build does not include');
      // The raw aimatey registration id, which also read back as "the
      // onnx-runtime runtime".
      expect(message).not.toContain('onnx-runtime');
      expect(message).not.toContain('runtime runtime');
    });
  });

  /* ── The non-streaming path had no backstop at all ─────────────────── */

  /**
   * `complete()` is the other public way into a backend, and the sentence this
   * whole change exists to delete was still live inside it.
   *
   * Measured before the guard, by calling it with the two targets below:
   *
   *   "Requested backend 'onnx-runtime' is not registered. Registered
   *    backends: llama-cpp"
   *   "Requested backend 'conn_openai' is not registered. Registered
   *    backends: llama-cpp"
   *
   * It has no callers under `src/` today and it does not divert to the cloud,
   * so this is not the reported bug — it is the same string reaching the user
   * through the other door. Titling, tools, and benchmarks all go through
   * here, and a caller added later inherits whichever sentence is in place.
   */
  describe('complete() on a backend the router does not have', () => {
    async function rejection(target: Parameters<typeof engine.complete>[0]['target']) {
      try {
        await engine.complete({ messages: [{ role: 'user', content: 'hi' }], target });
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
      throw new Error('expected complete() to reject');
    }

    it('refuses with the same sentence the streamed path uses', async () => {
      const local = await rejection(
        targetFor('onnx-runtime', 'whisper-tiny-en-onnx', 'Whisper Tiny (English)'),
      );
      expect(local).toContain('Whisper Tiny (English)');
      expect(local).toContain('this build does not include');
      expect(local).not.toContain('is not registered');
      expect(local).not.toContain('Registered backends');
      expect(local).not.toContain('onnx-runtime');

      const remote = await rejection({
        backendId: 'conn_openai',
        engine: 'remote',
        modelId: 'gpt-4o-mini',
        modelName: 'OpenAI · gpt-4o-mini',
        reach: REACH_REMOTE,
      });
      expect(remote).toContain('OpenAI · gpt-4o-mini');
      expect(remote).toContain('Settings');
      expect(remote).not.toContain('is not registered');
      expect(remote).not.toContain('Registered backends');
      expect(remote).not.toContain('runtime');
    });

    it('still completes on a backend that IS registered', async () => {
      engine.router.register('scripted', scriptedBackend(['Answered.']));

      const response = await engine.complete({
        messages: [{ role: 'user', content: 'hi' }],
        target: localTarget,
      });

      expect(response.message.content).toBe('Answered.');
    });
  });
});

/**
 * A backend whose stream simply stops — no `done`, no `error` (#260).
 *
 * What a socket cut between the last content chunk and the terminal chunk
 * looks like from this side. Before #260's ruling this was accepted silently:
 * the loop ended, `#runTurn` returned normally, and the engine emitted an
 * ordinary `done` event — so a truncated reply was indistinguishable from a
 * finished one, which is #185.
 */
function truncatedBackend(text: string): BackendAdapter {
  return new FunctionBackendAdapter({
    execute: async (request) => ({
      message: { role: 'assistant', content: text },
      finishReason: 'stop',
      metadata: { requestId: request.metadata.requestId, timestamp: Date.now() },
    }),
    executeStream: async function* (request): AsyncGenerator<IRStreamChunk> {
      yield { type: 'start', sequence: 0, metadata: request.metadata };
      yield { type: 'content', sequence: 1, delta: text };
      // and then nothing. No done. No error. The generator just ends.
    },
  });
}

describe('a stream that ends without a terminal chunk fails the turn (#260)', () => {
  const target = targetFor('llama-cpp', manifest.id, manifest.name, 'truncating');

  /** An engine whose only backend stops mid-stream. */
  function truncating(text: string): ChatterangEngine {
    const built = new ChatterangEngine({ resolver, fallbackBackendId: null });
    built.router.register('truncating', truncatedBackend(text));
    return built;
  }

  it('reports an error rather than a finished reply', async () => {
    /*
     * The ruling, and the contradiction it closes:
     * `packages/cordis-aimatey/src/chunks.ts:298` already threw
     * `EMPTY_RESPONSE` for exactly this, while this loop returned normally.
     * One repo, one fault, two answers.
     */
    const events = await drain(
      truncating('half a rep').stream({ messages: [{ role: 'user', content: 'hi' }], target }),
    );

    const error = events.find((event) => event.type === 'error');
    expect(error, 'a truncated stream produced no error event').toBeDefined();
    expect((error as { message: string }).message).toContain('ended before it was complete');

    // And NOT a done event, which is what it used to emit.
    expect(events.some((event) => event.type === 'done')).toBe(false);
  });

  it('still delivers the text that did arrive', async () => {
    // #185's Done: whatever the user already saw stays visible with the
    // failure attached. The deltas are yielded as they arrive, so the failure
    // must not retract them.
    const events = await drain(
      truncating('half a rep').stream({ messages: [{ role: 'user', content: 'hi' }], target }),
    );
    const streamed = events
      .filter((event) => event.type === 'delta')
      .map((event) => (event as { text: string }).text)
      .join('');
    expect(streamed).toBe('half a rep');
  });

  it('a stream WITH a terminal chunk still succeeds — the paired control', async () => {
    // Without this, the two above pass on an engine that fails every turn.
    const control = new ChatterangEngine({ resolver, fallbackBackendId: null });
    control.router.register('scripted', scriptedBackend(['a complete reply']));
    const events = await drain(
      control.stream({
        messages: [{ role: 'user', content: 'hi' }],
        target: targetFor('llama-cpp', manifest.id, manifest.name, 'scripted'),
      }),
    );
    expect(events.some((event) => event.type === 'done')).toBe(true);
    expect(events.some((event) => event.type === 'error')).toBe(false);
  });
});
