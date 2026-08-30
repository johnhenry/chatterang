import { describe, expect, it, vi } from 'vitest';

import type {
  BackendAdapter,
  IRChatRequest,
  IRChatResponse,
  MiddlewareContext,
} from '@johnhenry/aimatey-types';

import { createToolMiddleware, type ExecutedTool } from '@/ai/middleware/tools';
import {
  classifyFailure,
  createResilienceMiddleware,
  describeFallback,
} from '@/ai/middleware/resilience';
import { ToolRegistry, type ChatterangTool } from '@/ai/tools/registry';

/* ── Fixtures ───────────────────────────────────────────────────────── */

function request(overrides: Partial<IRChatRequest> = {}): IRChatRequest {
  return {
    messages: [{ role: 'user', content: 'What is 6 * 7?' }],
    parameters: { model: 'local-model' },
    metadata: { requestId: 'req_1', timestamp: 0, custom: { local: true } },
    ...overrides,
  };
}

function response(content: string): IRChatResponse {
  return {
    message: { role: 'assistant', content },
    finishReason: 'stop',
    metadata: { requestId: 'req_1', timestamp: 0 },
  };
}

function context(overrides: Partial<MiddlewareContext> = {}): MiddlewareContext {
  return {
    request: request(),
    isStreaming: false,
    state: {},
    config: {},
    ...overrides,
  };
}

const multiply: ChatterangTool = {
  id: 'multiply',
  name: 'multiply',
  summary: 'Multiply',
  description: 'Multiply two numbers',
  parameters: {
    type: 'object',
    properties: { a: { type: 'number' }, b: { type: 'number' } },
    required: ['a', 'b'],
  },
  async execute(input) {
    return { output: String(Number(input.a) * Number(input.b)) };
  },
};

const explodes: ChatterangTool = {
  id: 'explodes',
  name: 'explodes',
  summary: 'Throws',
  description: 'Always throws',
  parameters: { type: 'object' },
  async execute() {
    throw new Error('tool blew up');
  },
};

/* ── Tool middleware ────────────────────────────────────────────────── */

describe('tool middleware', () => {
  const registry = new ToolRegistry([multiply, explodes]);

  it('does nothing when the request declares no tools', async () => {
    const middleware = createToolMiddleware({ registry });
    const next = vi.fn(async () => response('plain answer'));
    const result = await middleware(context(), next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(result.message.content).toBe('plain answer');
    expect(result.metadata.custom?.toolCalls).toBeUndefined();
  });

  it('executes a textual tool call and feeds the result back to the backend', async () => {
    const executed: ExecutedTool[] = [];
    const middleware = createToolMiddleware({
      registry,
      onToolExecuted: (tool) => executed.push(tool),
    });

    const backend = {
      execute: vi.fn(async () => response('It is 42.')),
    } as unknown as BackendAdapter;

    const next = vi.fn(async () =>
      response('<tool_call>{"name":"multiply","arguments":{"a":6,"b":7}}</tool_call>'),
    );

    const result = await middleware(
      context({
        request: request({
          tools: [{ name: 'multiply', description: 'x', parameters: { type: 'object' } }],
        }),
        backend,
      }),
      next,
    );

    expect(executed).toHaveLength(1);
    expect(executed[0]?.output).toBe('42');
    expect(backend.execute).toHaveBeenCalledTimes(1);
    expect(result.message.content).toBe('It is 42.');
    expect(result.metadata.custom?.toolCalls).toHaveLength(1);
  });

  it('reports a missing tool back to the model instead of failing the turn', async () => {
    const middleware = createToolMiddleware({ registry });
    const backend = { execute: vi.fn(async () => response('Understood.')) } as unknown as BackendAdapter;
    const next = vi.fn(async () =>
      response('<tool_call>{"name":"teleport","arguments":{}}</tool_call>'),
    );

    const result = await middleware(
      context({
        request: request({
          tools: [{ name: 'multiply', description: 'x', parameters: { type: 'object' } }],
        }),
        backend,
      }),
      next,
    );

    const calls = result.metadata.custom?.toolCalls as ExecutedTool[];
    expect(calls[0]?.isError).toBe(true);
    expect(calls[0]?.output).toContain('teleport');
  });

  it('captures a throwing tool as an error result rather than propagating', async () => {
    const middleware = createToolMiddleware({ registry });
    const backend = { execute: vi.fn(async () => response('Noted.')) } as unknown as BackendAdapter;
    const next = vi.fn(async () =>
      response('<tool_call>{"name":"explodes","arguments":{}}</tool_call>'),
    );

    const result = await middleware(
      context({
        request: request({
          tools: [{ name: 'explodes', description: 'x', parameters: { type: 'object' } }],
        }),
        backend,
      }),
      next,
    );

    const calls = result.metadata.custom?.toolCalls as ExecutedTool[];
    expect(calls[0]?.isError).toBe(true);
    expect(calls[0]?.output).toBe('tool blew up');
  });

  it('stops after maxIterations even if the model keeps calling tools', async () => {
    const middleware = createToolMiddleware({ registry, maxIterations: 2 });
    const backend = {
      execute: vi.fn(async () =>
        response('<tool_call>{"name":"multiply","arguments":{"a":2,"b":2}}</tool_call>'),
      ),
    } as unknown as BackendAdapter;

    const next = vi.fn(async () =>
      response('<tool_call>{"name":"multiply","arguments":{"a":2,"b":2}}</tool_call>'),
    );

    const result = await middleware(
      context({
        request: request({
          tools: [{ name: 'multiply', description: 'x', parameters: { type: 'object' } }],
        }),
        backend,
      }),
      next,
    );

    // One call from `next`, one from the single permitted follow-up.
    expect(backend.execute).toHaveBeenCalledTimes(2);
    expect((result.metadata.custom?.toolCalls as ExecutedTool[]).length).toBe(2);
  });

  it('strips tool syntax out of the answer the user sees', async () => {
    const middleware = createToolMiddleware({ registry });
    const backend = {
      execute: vi.fn(async () =>
        response('The answer is 42.\n<tool_call>{"name":"multiply","arguments":{}}</tool_call>'),
      ),
    } as unknown as BackendAdapter;
    const next = vi.fn(async () =>
      response('<tool_call>{"name":"multiply","arguments":{"a":6,"b":7}}</tool_call>'),
    );

    const result = await middleware(
      context({
        request: request({
          tools: [{ name: 'multiply', description: 'x', parameters: { type: 'object' } }],
        }),
        backend,
      }),
      next,
    );

    expect(result.message.content).not.toContain('tool_call');
    expect(result.message.content).toContain('The answer is 42.');
  });
});

/* ── Resilience middleware ──────────────────────────────────────────── */

describe('classifyFailure', () => {
  it('maps engine errors onto reasons a person can act on', () => {
    expect(classifyFailure(new Error('Model is not installed')).reason).toBe('model-missing');
    expect(classifyFailure(new Error('failed to alloc buffer')).reason).toBe('memory');
    expect(classifyFailure(new Error('device is throttled')).reason).toBe('thermal');
    expect(classifyFailure(new Error('request timed out')).reason).toBe('timeout');
    expect(classifyFailure('something odd').reason).toBe('engine-error');
  });
});

describe('describeFallback', () => {
  it('explains every reason in plain language', () => {
    for (const reason of ['thermal', 'memory', 'model-missing', 'timeout', 'engine-error'] as const) {
      expect(describeFallback(reason).length).toBeGreaterThan(20);
    }
    expect(describeFallback('none')).toBe('');
  });
});

describe('resilience middleware', () => {
  it('passes a healthy local request straight through', async () => {
    const middleware = createResilienceMiddleware({ resolveFallback: () => null });
    const next = vi.fn(async () => response('local answer'));
    const result = await middleware(context({ backendName: 'llama-cpp' }), next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(result.message.content).toBe('local answer');
  });

  it('rethrows when no fallback has been nominated — consent is required', async () => {
    const middleware = createResilienceMiddleware({ resolveFallback: () => null });
    const next = vi.fn(async () => {
      throw new Error('engine died');
    });

    await expect(middleware(context({ backendName: 'llama-cpp' }), next)).rejects.toThrow(
      'engine died',
    );
  });

  it('diverts to the nominated backend and records why', async () => {
    const adapter = {
      execute: vi.fn(async () => response('remote answer')),
    } as unknown as BackendAdapter;

    const onFallback = vi.fn();
    const middleware = createResilienceMiddleware({
      resolveFallback: () => ({ name: 'openai-1', adapter, modelId: 'gpt-4o-mini' }),
      onFallback,
    });

    const next = vi.fn(async () => {
      throw new Error('not enough memory');
    });

    const result = await middleware(context({ backendName: 'llama-cpp' }), next);

    expect(result.message.content).toBe('remote answer');
    expect(result.metadata.custom?.fallbackFrom).toBe('llama-cpp');
    expect(result.metadata.custom?.fallbackReason).toBe('memory');
    expect(result.metadata.warnings?.[0]?.message).toContain('remotely');
    expect(onFallback).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'memory', to: 'openai-1' }),
    );
  });

  it('retargets the request so the remote backend gets its own model id', async () => {
    const adapter = {
      execute: vi.fn(async () => response('remote answer')),
    } as unknown as BackendAdapter;

    const middleware = createResilienceMiddleware({
      resolveFallback: () => ({ name: 'openai-1', adapter, modelId: 'gpt-4o-mini' }),
    });

    await middleware(
      context({ backendName: 'llama-cpp' }),
      vi.fn(async () => {
        throw new Error('boom');
      }),
    );

    const sent = (adapter.execute as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as IRChatRequest;
    expect(sent.parameters?.model).toBe('gpt-4o-mini');
    expect(sent.metadata.custom?.backend).toBe('openai-1');
    expect(sent.metadata.custom?.local).toBe(false);
  });

  it('does not divert a cancelled request', async () => {
    const adapter = { execute: vi.fn() } as unknown as BackendAdapter;
    const middleware = createResilienceMiddleware({
      resolveFallback: () => ({ name: 'openai-1', adapter }),
    });

    const controller = new AbortController();
    controller.abort();

    await expect(
      middleware(
        context({ backendName: 'llama-cpp', signal: controller.signal }),
        vi.fn(async () => {
          throw new Error('aborted');
        }),
      ),
    ).rejects.toThrow();

    expect(adapter.execute).not.toHaveBeenCalled();
  });
});
