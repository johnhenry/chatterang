import { describe, expect, it, vi } from 'vitest';
import type { BackendAdapter, IRChatRequest, IRChatResponse, IRStreamChunk } from '@johnhenry/aimatey-types';
import { FunctionBackendAdapter } from '@johnhenry/aimatey-backend-browser';
import { ChatterangEngine, targetFor } from '@/ai/engine';
import { DEFAULT_SAMPLER } from '@/domain/manifest';
import { catalogEntry } from '@/data/catalog';
import { toolRegistry } from '@/ai/tools/registry';

const manifest = catalogEntry('qwen3-4b-instruct-q4km')!;
const resolver = {
  getManifest: (id: string) => (id === manifest.id ? manifest : null),
  getPath: () => '/dev/m.gguf',
  getSampler: () => ({ ...DEFAULT_SAMPLER, maxTokens: 64 }),
};

function scripted(turns: string[]): BackendAdapter {
  let turn = 0;
  return new FunctionBackendAdapter({
    execute: async (req: IRChatRequest): Promise<IRChatResponse> => ({
      message: { role: 'assistant', content: turns[Math.min(turn++, turns.length - 1)] ?? '' },
      finishReason: 'stop', metadata: req.metadata,
    }),
    executeStream: async function* (req): AsyncGenerator<IRStreamChunk> {
      const t = turns[Math.min(turn++, turns.length - 1)] ?? '';
      yield { type: 'start', sequence: 0, metadata: req.metadata };
      yield { type: 'content', sequence: 1, delta: t };
      yield { type: 'done', sequence: 2, finishReason: 'stop' };
    },
  });
}

/**
 * Counts real side effects, not emitted events.
 *
 * The upgrade to aimatey 0.2.0 made `Bridge.use()` middleware run on streamed
 * requests (ai.matey#46). Chatterang drives its own tool loop for streams, so the
 * registered tool middleware silently began executing every tool a *second*
 * time — invisible in the UI, because only the engine's own results are
 * reported, and invisible to the existing tests, which counted `tool` events.
 * Harmless for a calculator; not harmless for a `bash` tool running
 * `model remove`.
 */
describe('side-effect counting', () => {
  it('executes a tool exactly once per streamed turn', async () => {
    const executions = vi.fn(async () => ({ output: '42' }));
    toolRegistry.register({
      id: 'counter', name: 'counter', summary: 's', description: 'd',
      parameters: { type: 'object' }, execute: executions,
    });

    const engine = new ChatterangEngine({ resolver, fallbackBackendId: null });
    engine.router.register('scripted', scripted([
      '<tool_call>{"name":"counter","arguments":{}}</tool_call>',
      'done.',
    ]));

    for await (const _ of engine.stream({
      messages: [{ role: 'user', content: 'go' }],
      target: targetFor('llama-cpp', manifest.id, manifest.name, 'scripted'),
      toolIds: ['counter'],
    })) { /* drain */ }

    expect(executions).toHaveBeenCalledTimes(1);
  });

  it('executes a tool exactly once on the non-streaming path too', async () => {
    const executions = vi.fn(async () => ({ output: '42' }));
    toolRegistry.register({
      id: 'counter2', name: 'counter2', summary: 's', description: 'd',
      parameters: { type: 'object' }, execute: executions,
    });

    const engine = new ChatterangEngine({ resolver, fallbackBackendId: null });
    engine.router.register('scripted', scripted([
      '<tool_call>{"name":"counter2","arguments":{}}</tool_call>',
      'done.',
    ]));

    await engine.complete({
      messages: [{ role: 'user', content: 'go' }],
      target: targetFor('llama-cpp', manifest.id, manifest.name, 'scripted'),
      toolIds: ['counter2'],
    });

    // `complete()` goes through the Bridge, where the tool middleware is the
    // thing that runs — so it must run exactly once there.
    expect(executions).toHaveBeenCalledTimes(1);
  });

  it('feeds the tool result back to the model on the non-streaming path', async () => {
    // Regression: the middleware used to re-execute via `context.backend`,
    // which the Bridge never populates (ai.matey#64). The tool ran, the
    // follow-up turn never happened, and stripping the tool syntax left the
    // user with an empty reply.
    toolRegistry.register({
      id: 'c3', name: 'c3', summary: 's', description: 'd',
      parameters: { type: 'object' }, execute: async () => ({ output: '42' }),
    });

    const engine = new ChatterangEngine({ resolver, fallbackBackendId: null });
    engine.router.register('scripted', scripted([
      '<tool_call>{"name":"c3","arguments":{}}</tool_call>',
      'The answer is 42.',
    ]));

    const res = await engine.complete({
      messages: [{ role: 'user', content: 'go' }],
      target: targetFor('llama-cpp', manifest.id, manifest.name, 'scripted'),
      toolIds: ['c3'],
    });

    expect(res.message.content).toBe('The answer is 42.');
  });

  it('never returns an empty answer when the reply was only a tool call', async () => {
    toolRegistry.register({
      id: 'c4', name: 'c4', summary: 's', description: 'd',
      parameters: { type: 'object' }, execute: async () => ({ output: 'ok' }),
    });

    const engine = new ChatterangEngine({ resolver, fallbackBackendId: null });
    // Every turn is a tool call, so the loop exhausts its iterations.
    engine.router.register('scripted', scripted([
      '<tool_call>{"name":"c4","arguments":{}}</tool_call>',
    ]));

    const res = await engine.complete({
      messages: [{ role: 'user', content: 'go' }],
      target: targetFor('llama-cpp', manifest.id, manifest.name, 'scripted'),
      toolIds: ['c4'],
    });

    expect(res.message.content).not.toBe('');
  });

  it('does not divert twice when a streamed local turn fails over', async () => {
    const fallbackCalls = vi.fn();
    const engine = new ChatterangEngine({ resolver, fallbackBackendId: 'remote' });

    engine.router.register('scripted', new FunctionBackendAdapter({
      execute: async () => { throw new Error('not enough memory'); },
      // eslint-disable-next-line require-yield
      executeStream: async function* (): AsyncGenerator<IRStreamChunk> {
        throw new Error('not enough memory');
      },
    }));

    engine.router.register('remote', new FunctionBackendAdapter({
      execute: async (req: IRChatRequest): Promise<IRChatResponse> => {
        fallbackCalls();
        return { message: { role: 'assistant', content: 'remote' }, finishReason: 'stop', metadata: req.metadata };
      },
      executeStream: async function* (req): AsyncGenerator<IRStreamChunk> {
        fallbackCalls();
        yield { type: 'start', sequence: 0, metadata: req.metadata };
        yield { type: 'content', sequence: 1, delta: 'remote' };
        yield { type: 'done', sequence: 2, finishReason: 'stop' };
      },
    }));

    for await (const _ of engine.stream({
      messages: [{ role: 'user', content: 'go' }],
      target: targetFor('llama-cpp', manifest.id, manifest.name, 'scripted'),
    })) { /* drain */ }

    expect(fallbackCalls).toHaveBeenCalledTimes(1);
  });
});
