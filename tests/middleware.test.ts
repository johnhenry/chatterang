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
  /*
   * ENABLED IDS FOLLOW THE DECLARED TOOLS, as they do in the engine: `#toIR`
   * declares `toolRegistry.toIRTools(toolIds)` and carries the same `toolIds`
   * in metadata. For these fixtures an id and a name are the same string.
   *
   * Without this, every test below that declares a tool would pass with the
   * tool NEVER RUNNING — the dispatcher now fails closed when no ids are
   * carried, and an error result still counts as an iteration. A test can only
   * pin a real run if the request says the tool may run.
   */
  const toolIds = (overrides.tools ?? []).map((tool) => tool.name);
  return {
    messages: [{ role: 'user', content: 'What is 6 * 7?' }],
    parameters: { model: 'local-model' },
    metadata: { requestId: 'req_1', timestamp: 0, custom: { local: true, toolIds } },
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
    const calls = result.metadata.custom?.toolCalls as ExecutedTool[];
    expect(calls.length).toBe(2);
    // And the tool really RAN on both. An error result also counts as an
    // iteration, so without this the count above holds for a dispatcher that
    // refuses every call — which is exactly what failing closed looks like.
    for (const call of calls) {
      expect(call.isError).toBe(false);
      expect(call.output).toBe('4');
    }
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
    // The stripping must be of a turn whose tool actually ran, or this pins
    // the text of an error path rather than of the answer.
    expect((result.metadata.custom?.toolCalls as ExecutedTool[])[0]?.output).toBe('42');
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


/* ── Enablement is enforced, not merely advertised ───────────────────── */

/**
 * `Chat.tools` is documented as "Tool ids enabled for this chat". Until these
 * tests existed it was only the list the model was TOLD about: the dispatcher
 * resolved any call by name against the global registry, and a probe tool the
 * chat never enabled executed. These pin the enforcement on the non-streaming
 * path; `tests/engine.test.ts` pins the streaming one.
 */
describe('tool enablement is enforced', () => {
  const answer = () => ({ execute: vi.fn(async () => response('ok.')) }) as unknown as BackendAdapter;

  /** A request declaring `declared` to the model, with `ids` enabled to run. */
  function enabled(declared: string[], ids: unknown) {
    return request({
      tools: declared.map((name) => ({ name, description: 'x', parameters: { type: 'object' } })),
      metadata: { requestId: 'req_1', timestamp: 0, custom: { local: true, toolIds: ids } },
    });
  }

  function spyTool(id: string, name = id) {
    const execute = vi.fn(async () => ({ output: `${id} ran` }));
    const tool: ChatterangTool = {
      id, name, summary: id, description: id, parameters: { type: 'object' }, execute,
    };
    return { tool, execute };
  }

  async function run(registry: ToolRegistry, req: IRChatRequest, callName: string) {
    const middleware = createToolMiddleware({ registry });
    const next = vi.fn(async () => response(`<tool_call>{"name":"${callName}","arguments":{}}</tool_call>`));
    const result = await middleware(context({ request: req, backend: answer() }), next);
    return (result.metadata.custom?.toolCalls as ExecutedTool[] | undefined) ?? [];
  }

  it('does not run a registered tool the chat did not enable', async () => {
    const allowed = spyTool('allowed');
    const other = spyTool('other');
    const calls = await run(new ToolRegistry([allowed.tool, other.tool]), enabled(['allowed'], ['allowed']), 'other');
    expect(other.execute).not.toHaveBeenCalled();
    expect(calls[0]?.isError).toBe(true);
  });

  it('still runs the tool that IS enabled — the paired control', async () => {
    // Without this, every test in this block passes on a dispatcher that runs
    // nothing at all.
    const allowed = spyTool('allowed');
    await run(new ToolRegistry([allowed.tool]), enabled(['allowed'], ['allowed']), 'allowed');
    expect(allowed.execute).toHaveBeenCalledOnce();
  });

  it('records a call whose server left while the model wrote it as not sent, and runs nothing', async () => {
    // Removing a server, switching one off or adding one takes every MCP tool
    // out of the registry while `reconnect` runs. This request declared the tool
    // when it began, so the call is recorded as not sent to that server: named
    // from what was declared, never run from it (#92).
    const destination = {
      kind: 'mcp' as const,
      serverId: 'mcp_notes',
      serverName: 'notes',
      host: 'notes.example',
      url: 'https://notes.example/mcp',
    };
    const dispatch = async (leave: boolean) => {
      const spy = spyTool('mcp:notes.note', 'notes.note');
      const tool: ChatterangTool = { ...spy.tool, destination };
      const registry = new ToolRegistry([tool]);
      const next = vi.fn(async () => {
        // What `reconnect` does first, while the call is still being written.
        if (leave) registry.unregister(tool.id);
        return response('<tool_call>{"name":"notes.note","arguments":{"text":"x"}}</tool_call>');
      });
      const result = await createToolMiddleware({ registry })(
        context({ request: enabled(['notes.note'], [tool.id]), backend: answer() }),
        next,
      );
      const calls = (result.metadata.custom?.toolCalls as ExecutedTool[] | undefined) ?? [];
      return { spy, calls };
    };
    const notSent = { outcome: 'withheld', serverId: 'mcp_notes', host: 'notes.example', toolName: 'notes.note' };

    // The control: this path sends to no server, so a tool still registered is
    // refused as not allowed. Only the reason differs once it has left.
    const stayed = await dispatch(false);
    expect(stayed.spy.execute).not.toHaveBeenCalled();
    expect(stayed.calls.map((call) => call.receipt)).toMatchObject([{ ...notSent, why: 'not-allowed' }]);

    const left = await dispatch(true);
    expect(left.spy.execute).not.toHaveBeenCalled();
    expect(left.calls.map((call) => call.receipt)).toMatchObject([{ ...notSent, why: 'server-changed' }]);
    expect(left.calls[0]?.output).toBe(
      'This call’s arguments were not sent to notes.example: the server changed before it went.',
    );
  });

  it('hands the backend no follow-up once the turn is stopped, and keeps the not-sent record', async () => {
    // Every refused call is recorded whatever the signal says (#92, owner ruling
    // OD7), so a stopped batch still has results. The loop must end on the
    // signal, not on an empty batch: nothing is asked of a model after Stop.
    const destination = {
      kind: 'mcp' as const,
      serverId: 'mcp_notes',
      serverName: 'notes',
      host: 'notes.example',
      url: 'https://notes.example/mcp',
    };
    const dispatch = async (stop: boolean) => {
      const spy = spyTool('mcp:notes.note', 'notes.note');
      const tool: ChatterangTool = { ...spy.tool, destination };
      const registry = new ToolRegistry([tool]);
      const controller = new AbortController();
      const backend = answer();
      const next = vi.fn(async () => {
        // Stop lands while the model's reply comes back.
        if (stop) controller.abort();
        return response('<tool_call>{"name":"notes.note","arguments":{"text":"x"}}</tool_call>');
      });
      const result = await createToolMiddleware({ registry })(
        context({ request: enabled(['notes.note'], [tool.id]), backend, signal: controller.signal }),
        next,
      );
      const calls = (result.metadata.custom?.toolCalls as ExecutedTool[] | undefined) ?? [];
      return { spy, calls, execute: backend.execute as ReturnType<typeof vi.fn> };
    };
    const notSent = { outcome: 'withheld', why: 'not-allowed', serverId: 'mcp_notes', host: 'notes.example' };

    // The control: not stopped, the model reads the refusal once.
    const running = await dispatch(false);
    expect(running.spy.execute).not.toHaveBeenCalled();
    expect(running.execute).toHaveBeenCalledOnce();
    expect(running.calls.map((call) => call.receipt)).toMatchObject([notSent]);

    const stopped = await dispatch(true);
    expect(stopped.spy.execute).not.toHaveBeenCalled();
    expect(stopped.execute, 'no request is handed to the backend after Stop').not.toHaveBeenCalled();
    expect(stopped.calls.map((call) => call.receipt)).toMatchObject([notSent]);
  });

  it('runs nothing when the request does not say which tools are enabled', async () => {
    // Fail closed. A request that declares a tool to the model but carries no
    // enabled ids is a caller that forgot, and forgetting must not re-open it.
    const allowed = spyTool('allowed');
    await run(new ToolRegistry([allowed.tool]), enabled(['allowed'], undefined), 'allowed');
    expect(allowed.execute).not.toHaveBeenCalled();
  });

  it('does not trust a malformed enabled-ids value', async () => {
    for (const malformed of ['allowed', ['allowed', 42], { allowed: true }, null]) {
      const allowed = spyTool('allowed');
      await run(new ToolRegistry([allowed.tool]), enabled(['allowed'], malformed), 'allowed');
      expect(allowed.execute, `ran with toolIds=${JSON.stringify(malformed)}`).not.toHaveBeenCalled();
    }
  });

  it('answers a not-enabled tool exactly as it answers a tool that does not exist', async () => {
    /*
     * A distinct "not enabled" message would tell the model which tools are
     * installed that the user chose not to give it — for MCP, which servers
     * are connected. Modulo the name itself, the two answers are identical.
     */
    const allowed = spyTool('allowed');
    const other = spyTool('other');
    const registry = new ToolRegistry([allowed.tool, other.tool]);
    const [installed] = await run(registry, enabled(['allowed'], ['allowed']), 'other');
    const [absent] = await run(registry, enabled(['allowed'], ['allowed']), 'nonexistent');
    expect(installed?.output.replace('other', 'NAME')).toBe(absent?.output.replace('nonexistent', 'NAME'));
  });

  it('accepts a call naming an enabled tool by its ID, as the registry always has', async () => {
    // `getByName` falls back to the id (`tests/tools.test.ts` pins
    // `getByName('calculator')`), so a model that called a tool by its id used
    // to succeed. Enforcement must not quietly remove that — it survived a
    // mutation until this test existed.
    const byId = spyTool('the-id', 'the_name');
    await run(new ToolRegistry([byId.tool]), enabled(['the_name'], ['the-id']), 'the-id');
    expect(byId.execute).toHaveBeenCalledOnce();
  });

  it('refuses a call naming a NON-enabled tool by its id — the id is not a side door', async () => {
    const allowed = spyTool('allowed');
    const other = spyTool('other-id', 'other_name');
    await run(new ToolRegistry([allowed.tool, other.tool]), enabled(['allowed'], ['allowed']), 'other-id');
    expect(other.execute).not.toHaveBeenCalled();
  });

  it('resolves a shared name to the ENABLED tool, not whichever registered first', async () => {
    // Why enforcement goes through ids and not a name allowlist: `getByName`
    // returns the first registration, so a name allowlist would run the
    // non-enabled twin whenever it happened to register earlier.
    const first = spyTool('first', 'lookup');
    const second = spyTool('second', 'lookup');
    await run(new ToolRegistry([first.tool, second.tool]), enabled(['lookup'], ['second']), 'lookup');
    expect(second.execute).toHaveBeenCalledOnce();
    expect(first.execute).not.toHaveBeenCalled();
  });
});
