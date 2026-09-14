import { describe, expect, it, vi } from 'vitest';

import {
  McpNotSent,
  destinationHost,
  mayHaveLeft,
  qualifiedToolName,
  unhandledOutcome,
  unhandledWhy,
  validateServerUrl,
  type McpCallReceipt,
} from '@/domain/mcp';
import { createMcpTool, renderResult } from '@/ai/mcp/tools';
import { McpManager, type McpToolDescriptor } from '@/ai/mcp/client';
import { runToolCalls, unlessStopped, type DestinationDecision } from '@/ai/middleware/tools';
import { BUILT_IN_TOOLS, ToolRegistry } from '@/ai/tools/registry';

/**
 * `createMcpTool` returns `null` for a schema it will not vouch for. Every
 * fixture here has a valid one, so a `null` is a bug in the fixture rather
 * than a branch under test -- throw instead of asserting it away with `!`,
 * which would turn a broken fixture into a confusing downstream failure.
 * Rejection itself is covered in `tests/mcp-schema.test.ts`.
 */
function mustCreateMcpTool(...args: Parameters<typeof createMcpTool>) {
  const tool = createMcpTool(...args);
  if (!tool) throw new Error('createMcpTool refused a fixture schema it should have accepted');
  return tool;
}


const context = { now: () => new Date('2026-08-30T12:00:00Z') };

function descriptor(patch: Partial<McpToolDescriptor> = {}): McpToolDescriptor {
  return {
    server: 'acme',
    name: 'search',
    description: 'Search the corpus',
    inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
    readOnly: false,
    destructive: true,
    ...patch,
  };
}

describe('server URL validation', () => {
  it('refuses plaintext http, which would put the token on the wire', () => {
    expect(validateServerUrl('http://api.example.com/mcp').ok).toBe(false);
  });

  it('allows localhost over http for development', () => {
    expect(validateServerUrl('http://localhost:3000/mcp').ok).toBe(true);
    expect(validateServerUrl('http://127.0.0.1:3000/mcp').ok).toBe(true);
  });

  it('refuses credentials in the URL — they belong in the token field', () => {
    const result = validateServerUrl('https://user:pw@api.example.com/mcp');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/token field/i);
  });

  it('rejects nonsense rather than throwing', () => {
    expect(validateServerUrl('not a url').ok).toBe(false);
  });
});

/**
 * The privacy invariants. These are the reason this module exists, and they are
 * stricter than what the MCP spec or the server's own annotations imply.
 */
describe('an MCP tool always declares that it leaves the device', () => {
  const options = {
    serverId: 'mcp_1',
    serverUrl: 'https://api.acme.com/mcp',
    confirm: async () => true,
    call: async () => ({}),
  };

  it('is sensitive even when the server calls it read-only', () => {
    // read-only describes the SERVER's state, not your data. The arguments
    // still travel. If this ever becomes conditional, an off-device call can be
    // made without the per-chat opt-in.
    const tool = mustCreateMcpTool(descriptor({ readOnly: true }), options);
    expect(tool.sensitive).toBe(true);
  });

  it('names the destination host in what the user sees', () => {
    const tool = mustCreateMcpTool(descriptor(), options);
    expect(tool.summary).toContain('api.acme.com');
  });

  it('tells the model the call is remote, so it can say so', () => {
    const tool = mustCreateMcpTool(descriptor(), options);
    expect(tool.description).toContain('api.acme.com');
    expect(tool.description).toMatch(/not on this device/i);
  });

  it('namespaces the tool by server so two servers can both expose "search"', () => {
    expect(mustCreateMcpTool(descriptor(), options).name).toBe('acme.search');
    expect(qualifiedToolName('other', 'search')).toBe('other.search');
  });
});

describe('confirmation', () => {
  it('asks before a call the server has not declared read-only', async () => {
    const confirm = vi.fn(async (_action: string) => true);
    const call = vi.fn(async () => ({ content: [{ type: 'text', text: 'ok' }] }));
    const tool = mustCreateMcpTool(descriptor({ readOnly: false }), {
      serverId: 'mcp_1',
      serverUrl: 'https://api.acme.com/mcp',
      confirm,
      call,
    });

    await tool.execute({ q: 'x' }, context);
    expect(confirm).toHaveBeenCalledOnce();
    expect(confirm.mock.calls[0]?.[0]).toContain('api.acme.com');
  });

  it('does not call the server when the user declines', async () => {
    const call = vi.fn();
    const tool = mustCreateMcpTool(descriptor({ readOnly: false }), {
      serverId: 'mcp_1',
      serverUrl: 'https://api.acme.com/mcp',
      confirm: async () => false,
      call,
    });

    const result = await tool.execute({ q: 'x' }, context);
    expect(call).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
  });

  it('treats a missing annotation as destructive, not as safe', async () => {
    // The server is the party we can verify least. Absent must mean "ask".
    const confirm = vi.fn(async (_action: string) => true);
    const tool = mustCreateMcpTool(descriptor({ readOnly: false }), {
      serverId: 'mcp_1',
      serverUrl: 'https://api.acme.com/mcp',
      confirm,
      call: async () => ({}),
    });
    await tool.execute({}, context);
    expect(confirm).toHaveBeenCalled();
  });

  it('a read-only tool adds no data-change question of its own — whether its arguments may leave is asked at dispatch', async () => {
    const confirm = vi.fn(async (_action: string) => true);
    const tool = mustCreateMcpTool(descriptor({ readOnly: true }), {
      serverId: 'mcp_1',
      serverUrl: 'https://api.acme.com/mcp',
      confirm,
      call: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
    });
    await tool.execute({}, context);
    expect(confirm).not.toHaveBeenCalled();
  });
});

/**
 * Two questions, in order (#6, owner ruling OD1). Whether the arguments may
 * leave is asked at dispatch; whether a call the server does not call read-only
 * may change data there is asked by the tool. A grant never answers the second.
 */
describe('a call that could change data on its server', () => {
  const acme = { serverId: 'mcp_1', serverUrl: 'https://api.acme.com/mcp' };
  const use = (name: string) => [{ type: 'tool_use' as const, id: 'c1', name, input: { q: 'x' } }];

  it('asks what leaves before what changes, and a refusal reaches neither', async () => {
    const order: string[] = [];
    const confirm = vi.fn(async (_action: string) => {
      order.push('changes');
      return true;
    });
    const call = vi.fn(async () => {
      order.push('sent');
      return { content: [{ type: 'text', text: 'ok' }] };
    });
    const tool = mustCreateMcpTool(descriptor({ readOnly: false }), { ...acme, confirm, call });
    const registry = new ToolRegistry([tool]);
    const asking = (answer: 'deny' | 'calls') => ({
      isGranted: () => false,
      request: async () => {
        order.push('leaves');
        return answer;
      },
    });

    await runToolCalls(registry, use(tool.name), { enabledIds: [tool.id], destinations: asking('deny') });
    expect(order, 'a call not allowed to leave asks nothing more and sends nothing').toEqual(['leaves']);

    order.length = 0;
    await runToolCalls(registry, use(tool.name), { enabledIds: [tool.id], destinations: asking('calls') });
    expect(order).toEqual(['leaves', 'changes', 'sent']);
  });

  it('still asks about changing data when the conversation holds a grant', async () => {
    const confirm = vi.fn(async (_action: string) => false);
    const call = vi.fn();
    const tool = mustCreateMcpTool(descriptor({ readOnly: false }), { ...acme, confirm, call });

    const { executed } = await runToolCalls(new ToolRegistry([tool]), use(tool.name), {
      enabledIds: [tool.id],
      destinations: { isGranted: () => true },
    });

    expect(confirm).toHaveBeenCalledOnce();
    expect(confirm.mock.calls[0]?.[0]).toContain('may change data there');
    expect(call).not.toHaveBeenCalled();
    expect(executed[0]?.output).toBe('The user declined that tool call.');
  });

  it('treats an answer it does not recognise as a refusal', async () => {
    // Fails closed: only the two affirmative answers send anything.
    const call = vi.fn(async () => ({ content: [] }));
    const tool = mustCreateMcpTool(descriptor({ readOnly: true }), { ...acme, confirm: async () => true, call });

    const { executed } = await runToolCalls(new ToolRegistry([tool]), use(tool.name), {
      enabledIds: [tool.id],
      destinations: { isGranted: () => false, request: async () => 'always' as unknown as DestinationDecision },
    });

    expect(call).not.toHaveBeenCalled();
    expect(executed[0]?.isError).toBe(true);
    expect(executed[0]?.output).toContain('did not allow');
  });
});

/**
 * Stop, while a call waits on a person (#92, owner ruling OD7). The end-to-end
 * measurements are in `privacy.test.ts`; these are the two halves under them.
 */
describe('a call waiting on a person when the turn is stopped', () => {
  const acme = { serverId: 'mcp_1', serverUrl: 'https://api.acme.com/mcp' };
  const stoppedSignal = () => {
    const controller = new AbortController();
    controller.abort();
    return controller.signal;
  };
  const never = <T>() => new Promise<T>(() => {});

  it('asks nothing once the turn is already stopped, at dispatch or at the confirm', async () => {
    const call = vi.fn(async () => ({ content: [] }));
    const confirm = vi.fn(async (_action: string, _signal?: AbortSignal) => true);
    const tool = mustCreateMcpTool(descriptor({ readOnly: false }), { ...acme, confirm, call });
    const request = vi.fn(async () => 'calls' as const);

    const { executed } = await runToolCalls(
      new ToolRegistry([tool]),
      [{ type: 'tool_use', id: 'c1', name: tool.name, input: { q: 'x' } }],
      { enabledIds: [tool.id], destinations: { isGranted: () => false, request }, signal: stoppedSignal() },
    );
    expect(request, 'no sheet is raised for a stopped turn').not.toHaveBeenCalled();
    expect(executed[0]?.receipt).toMatchObject({ outcome: 'withheld', why: 'stopped' });

    const direct = await tool.execute({ q: 'x' }, { signal: stoppedSignal(), now: () => new Date(0) });
    expect(confirm, 'no confirm is raised for a stopped turn').not.toHaveBeenCalled();
    expect(direct.receipt).toMatchObject({ outcome: 'withheld', why: 'stopped', at: 0 });
    expect(call).not.toHaveBeenCalled();
  });

  it('hands back the answer, or nothing once stopped, and never waits past Stop', async () => {
    expect(await unlessStopped(Promise.resolve('yes'), undefined)).toBe('yes');
    const live = new AbortController();
    expect(await unlessStopped(Promise.resolve('yes'), live.signal)).toBe('yes');
    await expect(unlessStopped(Promise.reject(new Error('boom')), live.signal)).rejects.toThrow('boom');

    const stopping = new AbortController();
    const waiting = unlessStopped(never<string>(), stopping.signal);
    stopping.abort();
    expect(await waiting).toBeUndefined();

    // Stopped before it was asked: an abort that already happened fires no event.
    expect(await unlessStopped(never<string>(), stoppedSignal())).toBeUndefined();
  }, 2000);
});

describe('result rendering', () => {
  it('flattens text blocks for the model', () => {
    expect(renderResult({ content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }).output)
      .toBe('a\nb');
  });

  it('describes binary blocks rather than inlining them', () => {
    // A base64 image in the transcript bloats IndexedDB and reads as noise.
    expect(renderResult({ content: [{ type: 'image', data: 'AAAA' }] }).output).toBe('[image content]');
  });

  it('surfaces the tool-error channel', () => {
    expect(renderResult({ content: [{ type: 'text', text: 'nope' }], isError: true }).isError).toBe(true);
  });

  it('keeps structured content for the UI', () => {
    const result = renderResult({ structuredContent: { hits: 2 } });
    expect(result.display?.kind).toBe('json');
    expect(result.display?.value).toContain('hits');
  });

  it('does not claim success when a server returns nothing', () => {
    expect(renderResult({}).output).toMatch(/no content/i);
  });
});

/**
 * The receipt (#92): the record that a call's arguments were handed to a
 * server. What these pin is WHEN one exists — once the arguments are on their
 * way, and never for a call that did not leave — and that what it says is
 * measured, not assumed.
 */
describe('an MCP call receipt', () => {
  const at = new Date('2026-08-30T12:00:00Z');
  const acme = {
    serverId: 'mcp_1',
    serverUrl: 'https://api.acme.com/mcp',
    confirm: async () => true,
  };
  const ok = async () => ({ content: [{ type: 'text', text: 'ok' }] });

  it('is preceded by a destination every MCP tool declares, by server id', () => {
    const tool = mustCreateMcpTool(descriptor(), { ...acme, call: ok });
    expect(tool.destination).toEqual({
      kind: 'mcp',
      serverId: 'mcp_1',
      serverName: 'acme',
      host: 'api.acme.com',
      url: 'https://api.acme.com/mcp',
    });
  });

  it('records server, host, bytes and time for a call handed to the server', async () => {
    const call = vi.fn(ok);
    const tool = mustCreateMcpTool(descriptor({ readOnly: true }), { ...acme, call });

    const result = await tool.execute({ q: 'héllo' }, { now: () => at });

    expect(call).toHaveBeenCalledOnce();
    expect(result.receipt).toEqual({
      outcome: 'sent',
      serverId: 'mcp_1',
      serverName: 'acme',
      host: 'api.acme.com',
      toolName: 'acme.search',
      // `{"q":"héllo"}` is 13 characters and 14 bytes: `é` is two in UTF-8. A
      // receipt that counted characters would say 13.
      bytes: 14,
      at: at.getTime(),
    });
  });

  it('records a destructive call the user declined as not sent, and one they allowed as sent', async () => {
    const call = vi.fn(ok);
    const declined = mustCreateMcpTool(descriptor({ readOnly: false }), {
      ...acme,
      confirm: async () => false,
      call,
    });
    const refused = await declined.execute({ q: 'héllo' }, { now: () => at });
    expect(call).not.toHaveBeenCalled();
    expect(refused.output).toBe('The user declined that tool call.');
    // Declining the data-change question declines the call (#92, owner ruling
    // OD7), and the record says it was that question and not the send sheet.
    expect(refused.receipt).toEqual({
      outcome: 'withheld',
      why: 'declined',
      serverId: 'mcp_1',
      serverName: 'acme',
      host: 'api.acme.com',
      toolName: 'acme.search',
      bytes: 14,
      at: at.getTime(),
    });

    // The paired control, and the timing: the sheet takes a while to answer,
    // and the receipt says when the arguments LEFT — after the answer, not when
    // the call was first asked for.
    let clock = 1_000;
    const allowed = mustCreateMcpTool(descriptor({ readOnly: false }), {
      ...acme,
      confirm: async () => {
        clock = 2_000;
        return true;
      },
      call,
    });
    const sent = await allowed.execute({ q: 'x' }, { now: () => new Date(clock) });
    expect(call).toHaveBeenCalledOnce();
    expect(sent.receipt?.outcome).toBe('sent');
    expect(sent.receipt?.at).toBe(2_000);
  });

  it('records a call that threw as a failed attempt, timed when it was handed over', async () => {
    const now = vi.fn(() => at);
    const tool = mustCreateMcpTool(descriptor({ readOnly: true }), {
      ...acme,
      call: async () => {
        throw new Error('socket hang up');
      },
    });

    const result = await tool.execute({ q: 'x' }, { now });

    expect(result.isError).toBe(true);
    expect(result.output).toContain('acme.search failed: socket hang up');
    expect(result.receipt?.outcome).toBe('failed');
    expect(result.receipt?.at).toBe(at.getTime());
    // Read once, before the hand-off. A second read in the catch would time
    // the failure, not the moment the arguments left.
    expect(now).toHaveBeenCalledOnce();
  });

  it('is timed when the arguments left, not when a slow server answered', async () => {
    // Reading the clock once is not enough: once AFTER the call is also once.
    // So the clock moves while the call is out, on a call that answers and on
    // one that throws, and the receipt keeps the earlier time on both.
    let clock = 1_000;
    const now = () => new Date(clock);
    const answers = mustCreateMcpTool(descriptor({ readOnly: true }), {
      ...acme,
      call: async () => {
        clock = 31_000;
        return { content: [{ type: 'text', text: 'ok' }] };
      },
    });
    const sent = await answers.execute({ q: 'x' }, { now });
    expect(sent.receipt?.outcome).toBe('sent');
    expect(sent.receipt?.at).toBe(1_000);

    clock = 1_000;
    const drops = mustCreateMcpTool(descriptor({ readOnly: true }), {
      ...acme,
      call: async () => {
        clock = 31_000;
        throw new Error('socket hang up');
      },
    });
    const failed = await drops.execute({ q: 'x' }, { now });
    expect(failed.receipt?.outcome).toBe('failed');
    expect(failed.receipt?.at).toBe(1_000);
  });

  it('records a call refused before anything was sent as not sent, because its server changed', async () => {
    const tool = mustCreateMcpTool(descriptor({ readOnly: true }), {
      ...acme,
      call: async () => {
        throw new McpNotSent('the server changed since this call was prepared');
      },
    });

    const result = await tool.execute({ q: 'x' }, { now: () => at });

    expect(result.isError).toBe(true);
    expect(result.output).toContain('acme.search was not sent: the server changed');
    // Not an attempt, and nobody's refusal (#92, owner ruling OD7).
    expect(result.receipt).toEqual({
      outcome: 'withheld',
      why: 'server-changed',
      serverId: 'mcp_1',
      serverName: 'acme',
      host: 'api.acme.com',
      toolName: 'acme.search',
      bytes: 9,
      at: at.getTime(),
    });
  });

  it('is refused as not sent by a client that has no connection, and recorded so', async () => {
    // Nothing is configured, so nothing can have left. Thrown as an ordinary
    // error this would be recorded as a failed attempt at a host never reached.
    const client = new McpManager();
    await expect(client.callTool('acme', 'search', {})).rejects.toBeInstanceOf(McpNotSent);

    const tool = mustCreateMcpTool(descriptor({ readOnly: true }), {
      ...acme,
      call: (server, name, args, signal) => client.callTool(server, name, args, signal),
    });
    const result = await tool.execute({ q: 'x' }, { now: () => at });
    expect(result.receipt).toMatchObject({ outcome: 'withheld', why: 'server-changed' });
  });

  it('reaches the dispatcher’s record, and a tool that runs here has none', async () => {
    const mcp = mustCreateMcpTool(descriptor({ readOnly: true }), { ...acme, call: ok });
    const registry = new ToolRegistry([...BUILT_IN_TOOLS, mcp]);

    const { executed } = await runToolCalls(
      registry,
      [
        // Called by its id, which the dispatcher allows. The receipt still
        // carries the qualified name, so both spellings are recorded alike.
        { type: 'tool_use', id: 'c1', name: mcp.id, input: { q: 'x' } },
        { type: 'tool_use', id: 'c2', name: 'calculate', input: { expression: '1 + 1' } },
      ],
      { enabledIds: [mcp.id, 'calculator'], destinations: { isGranted: () => true } },
    );

    expect(executed[0]?.receipt?.host).toBe('api.acme.com');
    expect(executed[0]?.receipt?.toolName).toBe('acme.search');
    expect(executed[1]?.isError).toBe(false);
    expect(executed[1]?.receipt).toBeUndefined();
  });

  it('keeps a record from a later build as if something left, and hands its outcome back to be shown', () => {
    // An outcome this build has no branch for: a row a later build wrote. Every
    // reader's `default` goes through `unhandledOutcome`, whose `never`
    // parameter is the compile-time half; this is the runtime half.
    const later = {
      outcome: 'queued',
      serverId: 'mcp_1',
      serverName: 'acme',
      host: 'api.acme.com',
      toolName: 'acme.search',
      bytes: 1,
      at: 0,
    } as unknown as McpCallReceipt;
    expect(mayHaveLeft(later)).toBe(true);
    expect(unhandledOutcome(later as never)).toBe('queued');
    expect(unhandledWhy('held-by-policy' as never)).toBe('held-by-policy');

    // The paired controls: the outcomes this build knows.
    expect(mayHaveLeft({ ...later, outcome: 'failed' } as McpCallReceipt)).toBe(true);
    expect(mayHaveLeft({ ...later, outcome: 'withheld', why: 'declined' } as McpCallReceipt)).toBe(false);
  });
});

describe('host display', () => {
  it('shows the host, not the whole URL', () => {
    expect(destinationHost('https://api.acme.com/v1/mcp?x=1')).toBe('api.acme.com');
  });

  it('degrades rather than throwing on rubbish', () => {
    expect(destinationHost('nonsense')).toBe('unknown host');
  });
});
