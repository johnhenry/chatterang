import { describe, expect, it, vi } from 'vitest';
import type { BackendAdapter, IRChatRequest, IRChatResponse, IRStreamChunk } from '@johnhenry/aimatey-types';
import { FunctionBackendAdapter } from '@johnhenry/aimatey-backend-browser';
import { ChatterangEngine, targetFor } from '@/ai/engine';
import { DEFAULT_SAMPLER } from '@/domain/manifest';
import { catalogEntry } from '@/data/catalog';
import { toolRegistry } from '@/ai/tools/registry';

import { MCP_CALL, mcpProbe, recordingBackend, sent } from './support/egress-probe';

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
    // Regression: the follow-up turn used to not happen at all. The middleware
    // re-executes via `context.backend`, which the Bridge did not populate
    // before ai.matey#64 — so the tool ran, the follow-up never did, and
    // stripping the tool syntax left the user with an empty reply. Core 0.3.0
    // populates it; this asserts the follow-up actually lands.
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

  it('serves both turns of a tool conversation from the same backend', async () => {
    /*
     * The tool middleware used to pass `resolveBackend: () => this.router`,
     * routing the follow-up afresh. That override is gone, so the follow-up now
     * goes to `context.backend` — the concrete adapter ai.matey#64 narrows to
     * once a response exists.
     *
     * Note what this does and does not prove. I revert-checked it: restoring
     * the router override leaves this test green. Under
     * `routingStrategy: 'explicit'` the follow-up carries the same backend
     * selection, so the router resolves to the same adapter — the two
     * implementations are genuinely indistinguishable here, which is why
     * dropping the override was safe rather than a trade.
     *
     * So this pins the *behaviour* — one backend serves both turns of a tool
     * conversation — and not the mechanism. It would catch a real regression
     * (a follow-up landing on a different model than the one that asked for
     * the tool) under a routing strategy where that could happen, such as
     * round-robin. It would not catch a silent switch back to router-routing
     * today, and nothing can, because there is nothing to catch.
     */
    toolRegistry.register({
      id: 'c5', name: 'c5', summary: 's', description: 'd',
      parameters: { type: 'object' }, execute: async () => ({ output: '7' }),
    });

    const served: string[] = [];
    const tagged = (name: string, turns: string[]): BackendAdapter => {
      let turn = 0;
      return new FunctionBackendAdapter({
        execute: async (req: IRChatRequest): Promise<IRChatResponse> => {
          served.push(name);
          return {
            message: { role: 'assistant', content: turns[Math.min(turn++, turns.length - 1)] ?? '' },
            finishReason: 'stop',
            metadata: req.metadata,
          };
        },
      });
    };

    const engine = new ChatterangEngine({ resolver, fallbackBackendId: null });
    engine.router.register('chosen', tagged('chosen', [
      '<tool_call>{"name":"c5","arguments":{}}</tool_call>',
      'It is 7.',
    ]));
    // Registered but never selected. If the follow-up went through the router
    // rather than the serving adapter, this could take the second turn.
    engine.router.register('other', tagged('other', ['wrong backend']));

    const res = await engine.complete({
      messages: [{ role: 'user', content: 'go' }],
      target: targetFor('llama-cpp', manifest.id, manifest.name, 'chosen'),
      toolIds: ['c5'],
    });

    expect(res.message.content).toBe('It is 7.');
    // Both turns served by the same backend.
    expect(served).toEqual(['chosen', 'chosen']);
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

  it('never sends an MCP call’s arguments from complete(), granted or not', async () => {
    // #45's named surface. complete() has no conversation to hold a grant and
    // nobody to ask (#6), so its tool middleware refuses every call that leaves
    // — even when the caller hands it a policy that would allow one.
    const probe = mcpProbe();
    toolRegistry.register(probe.tool);
    const engine = new ChatterangEngine({ resolver, fallbackBackendId: null });
    const backend = recordingBackend([MCP_CALL, 'Filed.']);
    engine.router.register('scripted', backend.adapter);

    await engine.complete({
      messages: [{ role: 'user', content: 'file a note' }],
      target: targetFor('llama-cpp', manifest.id, manifest.name, 'scripted'),
      toolIds: [probe.tool.id],
      mcpEgress: { isGranted: () => true, request: async () => 'conversation' },
    });

    expect(probe.call).not.toHaveBeenCalled();
    // Not vacuous: the call reached the dispatcher, and the model was told it
    // did not go.
    expect(sent(backend.seen).at(-1)).toContain('were not sent to notes.example');
    toolRegistry.unregister(probe.tool.id);
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
