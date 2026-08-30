import { beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  BackendAdapter,
  IRChatRequest,
  IRChatResponse,
  IRStreamChunk,
} from '@johnhenry/aimatey-types';
import { FunctionBackendAdapter } from '@johnhenry/aimatey-backend-browser';

import { ChatterangEngine, targetFor, type GenerationEvent } from '@/ai/engine';
import { DEFAULT_SAMPLER } from '@/domain/manifest';
import { catalogEntry } from '@/data/catalog';
import { toolRegistry } from '@/ai/tools/registry';

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

function doneEvent(events: GenerationEvent[]) {
  const done = events.at(-1);
  if (done?.type !== 'done') throw new Error(`expected a done event, got ${done?.type}`);
  return done;
}

describe('ChatterangEngine.stream', () => {
  let engine: ChatterangEngine;

  beforeEach(() => {
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
        target: { backendId: 'cloud', engine: 'remote', modelId: 'm', modelName: 'Cloud', local: false },
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
});
