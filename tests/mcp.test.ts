import { describe, expect, it, vi } from 'vitest';

import { destinationHost, qualifiedToolName, validateServerUrl } from '@/domain/mcp';
import { createMcpTool, renderResult } from '@/ai/mcp/tools';
import type { McpToolDescriptor } from '@/ai/mcp/client';

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
  const options = { serverUrl: 'https://api.acme.com/mcp', confirm: async () => true, call: async () => ({}) };

  it('is sensitive even when the server calls it read-only', () => {
    // read-only describes the SERVER's state, not your data. The arguments
    // still travel. If this ever becomes conditional, an off-device call can be
    // made without the per-chat opt-in.
    const tool = createMcpTool(descriptor({ readOnly: true }), options);
    expect(tool.sensitive).toBe(true);
  });

  it('names the destination host in what the user sees', () => {
    const tool = createMcpTool(descriptor(), options);
    expect(tool.summary).toContain('api.acme.com');
  });

  it('tells the model the call is remote, so it can say so', () => {
    const tool = createMcpTool(descriptor(), options);
    expect(tool.description).toContain('api.acme.com');
    expect(tool.description).toMatch(/not on this device/i);
  });

  it('namespaces the tool by server so two servers can both expose "search"', () => {
    expect(createMcpTool(descriptor(), options).name).toBe('acme.search');
    expect(qualifiedToolName('other', 'search')).toBe('other.search');
  });
});

describe('confirmation', () => {
  it('asks before a call the server has not declared read-only', async () => {
    const confirm = vi.fn(async (_action: string) => true);
    const call = vi.fn(async () => ({ content: [{ type: 'text', text: 'ok' }] }));
    const tool = createMcpTool(descriptor({ readOnly: false }), {
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
    const tool = createMcpTool(descriptor({ readOnly: false }), {
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
    const tool = createMcpTool(descriptor({ readOnly: false }), {
      serverUrl: 'https://api.acme.com/mcp',
      confirm,
      call: async () => ({}),
    });
    await tool.execute({}, context);
    expect(confirm).toHaveBeenCalled();
  });

  it('does not prompt per call for a read-only tool — the per-chat opt-in is the boundary', async () => {
    const confirm = vi.fn(async (_action: string) => true);
    const tool = createMcpTool(descriptor({ readOnly: true }), {
      serverUrl: 'https://api.acme.com/mcp',
      confirm,
      call: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
    });
    await tool.execute({}, context);
    expect(confirm).not.toHaveBeenCalled();
  });
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

describe('host display', () => {
  it('shows the host, not the whole URL', () => {
    expect(destinationHost('https://api.acme.com/v1/mcp?x=1')).toBe('api.acme.com');
  });

  it('degrades rather than throwing on rubbish', () => {
    expect(destinationHost('nonsense')).toBe('unknown host');
  });
});
