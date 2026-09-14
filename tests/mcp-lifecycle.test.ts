import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Chat } from '@/domain/chat';
import type { McpServerConfig } from '@/domain/mcp';

/**
 * AN MCP TOOL ENABLE IS GIVEN TO A NAME, AND A NAME CAN CHANGE HANDS.
 *
 * Tool ids are `mcp:<server name>.<tool>` (src/ai/mcp/tools.ts), and a chat's
 * `tools` list holds those ids. Before this file, nothing touched that list
 * when a server went away, and the duplicate-name check only sees servers that
 * still exist. So: remove `notes` at https://a, add `notes` at https://b, and
 * every chat that had turned `notes.search` on sent to b without being asked.
 * "Every MCP tool has to be turned on per chat" was false for the new server.
 *
 * Everything here drives the real `useMcp` and the real chat store, and ends at
 * the real dispatcher. The network is the only thing replaced: `mcpManager` is
 * a recorder, so "the call reached the server" is `callTool` having been called.
 */

const tables = vi.hoisted(() => ({
  chats: { put: vi.fn(async () => {}) },
  messages: {
    put: vi.fn(async () => {}),
    where: () => ({ equals: () => ({ sortBy: async () => [] }) }),
  },
  connections: { delete: vi.fn(async () => {}), put: vi.fn(async () => {}), toArray: async () => [] },
  mcpServers: {
    put: vi.fn(async () => {}),
    delete: vi.fn(async () => {}),
    update: vi.fn(async () => {}),
    orderBy: () => ({ toArray: async () => [] }),
  },
}));

vi.mock('@/db', () => ({
  db: tables,
  deleteChat: vi.fn(async () => {}),
  readSetting: async (_key: string, fallback: unknown) => fallback,
  writeSetting: vi.fn(async () => {}),
}));

/** The MCP client, replaced at the network boundary. Every server offers `search`. */
const manager = vi.hoisted(() => {
  const state = {
    configured: [] as { name: string; enabled: boolean }[],
    /** Run as the tools are listed — the moment a server's tools become callable. */
    onList: undefined as (() => void) | undefined,
  };
  return {
    state,
    configure: vi.fn(async (configs: { name: string; enabled: boolean }[]) => {
      state.configured = configs.filter((config) => config.enabled);
    }),
    listTools: vi.fn(async () => {
      state.onList?.();
      return state.configured.map((config) => ({
        server: config.name,
        name: 'search',
        description: 'Search notes',
        inputSchema: { type: 'object', properties: {} },
        // Read-only, so no confirm sheet stands between the call and the server:
        // the per-chat enable is the only thing under test.
        readOnly: true,
        destructive: false,
      }));
    }),
    callTool: vi.fn(async () => ({ content: [{ type: 'text', text: 'found' }] })),
  };
});

vi.mock('@/ai/mcp/client', () => ({ mcpManager: manager }));

const { useChats } = await import('@/state/chat');
const { useMcp } = await import('@/state/mcp');
const { toolRegistry } = await import('@/ai/tools/registry');
const { runToolCalls } = await import('@/ai/middleware/tools');

function chat(id: string, tools: string[]): Chat {
  return {
    id,
    title: id,
    mode: 'chat',
    personaId: null,
    modelId: null,
    sampler: null,
    tools,
    showThinking: false,
    createdAt: 1,
    updatedAt: 1,
    messageCount: 0,
    preview: '',
  };
}

function server(id: string, name: string, url: string): McpServerConfig {
  return { id, name, url, enabled: true, createdAt: 1 };
}

const toolsOf = (id: string): readonly string[] =>
  useChats.getState().chats.find((entry) => entry.id === id)?.tools ?? [];

/** What the model would do: call `notes.search`, under the chat's CURRENT enables. */
async function callNotesSearchIn(chatId: string): Promise<void> {
  await runToolCalls(
    toolRegistry,
    [{ type: 'tool_use', id: 'call_1', name: 'notes.search', input: { q: 'bank details' } }],
    // Every destination allowed: what this file measures is the enable, and
    // the grant is measured in `privacy.test.ts` and `egress-grants.test.ts`.
    { enabledIds: toolsOf(chatId), destinations: { isGranted: () => true } },
  );
}

beforeEach(async () => {
  useMcp.setState({ servers: [], states: {}, connecting: false });
  // Clears whatever an earlier test registered, through the store's own path.
  await useMcp.getState().reconnect();
  manager.state.onList = undefined;
  vi.clearAllMocks();
});

describe('removing an MCP server', () => {
  it('takes its tools out of every chat, and only its tools', async () => {
    useChats.setState({
      chats: [
        chat('c1', ['mcp:notes.search', 'calculator', 'mcp:notesbook.search']),
        chat('c2', ['mcp:notes.write']),
      ],
    });
    useMcp.setState({ servers: [server('mcp_a', 'notes', 'https://a.example/mcp')] });

    await useMcp.getState().remove('mcp_a');

    // `notesbook` shares a prefix with `notes` and is a different server. A
    // prune keyed on `mcp:notes` without the dot would take it too.
    expect(toolsOf('c1')).toEqual(['calculator', 'mcp:notesbook.search']);
    expect(toolsOf('c2')).toEqual([]);
    expect(tables.chats.put).toHaveBeenCalled();
  });

  it('then adding a server under the same name does not inherit the old enable', async () => {
    useChats.setState({ chats: [chat('c1', ['mcp:notes.search'])] });
    useMcp.setState({ servers: [server('mcp_a', 'notes', 'https://a.example/mcp')] });
    await useMcp.getState().reconnect();

    // The paired control: while the server the user enabled is still there,
    // the call does reach it. Without this the assertion below holds for a
    // dispatcher that runs nothing.
    await callNotesSearchIn('c1');
    expect(manager.callTool).toHaveBeenCalledOnce();

    await useMcp.getState().remove('mcp_a');
    expect(await useMcp.getState().add({ name: 'notes', url: 'https://b.example/mcp' })).toBeNull();
    manager.callTool.mockClear();

    // The tool is registered again under the very same id, so a refusal below
    // is the enable being gone and not the tool being missing.
    expect(toolRegistry.get('mcp:notes.search')).toBeDefined();
    await callNotesSearchIn('c1');
    expect(manager.callTool, 'a call reached a server the chat never enabled').not.toHaveBeenCalled();
  });

  it('still unregisters its tools when a chat cannot be written', async () => {
    useChats.setState({ chats: [chat('c1', ['mcp:notes.search'])] });
    useMcp.setState({ servers: [server('mcp_a', 'notes', 'https://a.example/mcp')] });
    await useMcp.getState().reconnect();
    await callNotesSearchIn('c1');
    expect(manager.callTool, 'the paired control: the enable reaches the server').toHaveBeenCalledOnce();
    manager.callTool.mockClear();

    // The prune writes each chat. A refused write leaves this chat's enable in
    // place, and the removal must not also leave the tool it points at.
    tables.chats.put.mockRejectedValueOnce(new Error('QuotaExceededError'));
    await expect(useMcp.getState().remove('mcp_a')).rejects.toThrow('QuotaExceededError');

    expect(toolsOf('c1'), 'the write really failed').toEqual(['mcp:notes.search']);
    expect(toolRegistry.get('mcp:notes.search')).toBeUndefined();
    await callNotesSearchIn('c1');
    expect(manager.callTool, 'a removed server was still called').not.toHaveBeenCalled();
  });
});

describe('adding an MCP server', () => {
  /**
   * THE ROUTE REMOVAL ALONE CANNOT CLOSE. A server removed by a build that did
   * not prune left `mcp:notes.*` behind in every chat that had it on, and
   * nothing prunes on load. The add is where that orphan would become live.
   */
  it('under a name a chat still has enabled is not enabled there', async () => {
    useChats.setState({ chats: [chat('c1', ['mcp:notes.search', 'calculator'])] });

    expect(await useMcp.getState().add({ name: 'notes', url: 'https://b.example/mcp' })).toBeNull();

    expect(toolsOf('c1')).toEqual(['calculator']);
    expect(toolRegistry.get('mcp:notes.search')).toBeDefined();
    await callNotesSearchIn('c1');
    expect(manager.callTool, 'an orphaned enable reached the new server').not.toHaveBeenCalled();

    // The paired control: turned on again for this chat, the same call runs.
    await useChats.getState().updateChat('c1', { tools: [...toolsOf('c1'), 'mcp:notes.search'] });
    await callNotesSearchIn('c1');
    expect(manager.callTool).toHaveBeenCalledOnce();
    expect(manager.callTool).toHaveBeenCalledWith('notes', 'search', { q: 'bank details' }, undefined);
  });

  it('prunes the name the server is stored under, not the name as typed', async () => {
    // The panel hands `add` its form field untrimmed, and the tool ids are
    // built from the trimmed name. A prune of `mcp:  notes .` matches nothing.
    useChats.setState({ chats: [chat('c1', ['mcp:notes.search', 'calculator'])] });

    expect(await useMcp.getState().add({ name: '  notes ', url: 'https://b.example/mcp' })).toBeNull();

    expect(useMcp.getState().servers.map((entry) => entry.name)).toEqual(['notes']);
    expect(toolsOf('c1')).toEqual(['calculator']);
    await callNotesSearchIn('c1');
    expect(manager.callTool, 'an orphaned enable reached the new server').not.toHaveBeenCalled();
  });

  it('that is refused as a duplicate leaves every chat as it was', async () => {
    // The live server keeps its name and its enables. Only an add that goes
    // ahead is a new server that no chat can have turned on.
    useChats.setState({ chats: [chat('c1', ['mcp:notes.search'])] });
    useMcp.setState({ servers: [server('mcp_a', 'notes', 'https://a.example/mcp')] });

    expect(await useMcp.getState().add({ name: 'notes', url: 'https://b.example/mcp' })).toBe(
      'There is already a server called “notes”.',
    );

    expect(toolsOf('c1')).toEqual(['mcp:notes.search']);
    expect(tables.chats.put).not.toHaveBeenCalled();
    expect(tables.mcpServers.put).not.toHaveBeenCalled();
  });

  it('prunes before its tools are listed, so no stale enable ever points at them', async () => {
    // The ordering, measured at the moment it matters: when the new server's
    // tools are being listed they are about to be registered, and from then on
    // a chat that still held the old id could call them.
    useChats.setState({ chats: [chat('c1', ['mcp:notes.search'])] });
    let enabledWhenListed: readonly string[] | undefined;
    manager.state.onList = () => {
      enabledWhenListed = toolsOf('c1');
    };

    await useMcp.getState().add({ name: 'notes', url: 'https://b.example/mcp' });

    expect(manager.listTools).toHaveBeenCalled();
    expect(enabledWhenListed).toEqual([]);
  });

  it('does not touch a chat whose tools belong to other servers', async () => {
    useChats.setState({ chats: [chat('c1', ['mcp:notesbook.search', 'calculator'])] });

    await useMcp.getState().add({ name: 'notes', url: 'https://b.example/mcp' });

    expect(toolsOf('c1')).toEqual(['mcp:notesbook.search', 'calculator']);
    expect(tables.chats.put).not.toHaveBeenCalled();
  });
});

describe('a call prepared for one server', () => {
  /**
   * THE WINDOW THE PRUNE CANNOT SEE. The dispatcher resolves a tool when the
   * model calls it and then holds the object, and a destructive call waits on a
   * confirm sheet that never times out. The client routes by NAME. Remove the
   * server and add another under that name while the sheet is open, and the
   * held tool would hand its arguments to the newcomer under a receipt naming
   * the host it was built for. Measured by holding the tool object across the
   * change, exactly as the dispatcher does.
   */
  const at = { now: () => new Date(0) };
  const A = server('mcp_a', 'notes', 'https://a.example/mcp');

  async function heldTool() {
    useMcp.setState({ servers: [A] });
    await useMcp.getState().reconnect();
    const held = toolRegistry.get('mcp:notes.search');
    expect(held?.destination?.host).toBe('a.example');
    // The server RECORD's id, not its name: the name is exactly what a
    // successor shares, so a destination keyed on it could not tell them apart.
    expect(held?.destination?.serverId).toBe('mcp_a');
    return held!;
  }

  it('does not go to its same-name successor', async () => {
    const held = await heldTool();

    // The paired control: before anything changes, the held tool does reach it.
    const before = await held.execute({ q: 'x' }, at);
    expect(manager.callTool).toHaveBeenCalledOnce();
    expect(before.receipt?.host).toBe('a.example');
    expect(before.receipt?.serverId).toBe('mcp_a');
    manager.callTool.mockClear();

    await useMcp.getState().remove('mcp_a');
    await useMcp.getState().add({ name: 'notes', url: 'https://b.example/mcp' });

    const after = await held.execute({ q: 'x' }, at);
    expect(manager.callTool, 'a call built for a.example went to its successor').not.toHaveBeenCalled();
    expect(after.receipt).toBeUndefined();
    expect(after.output).toContain('was not sent');
  });

  it('is not sent to that server once it is switched off', async () => {
    const held = await heldTool();
    await useMcp.getState().toggle('mcp_a', false);
    manager.callTool.mockClear();

    const result = await held.execute({ q: 'x' }, at);
    expect(manager.callTool).not.toHaveBeenCalled();
    expect(result.receipt).toBeUndefined();
  });

  it('is not sent once the record it was built for names another address or name', async () => {
    // No edit flow exists (state/mcp.ts offers add, remove and toggle), so the
    // record is changed in place here. This is the check such a flow would lean
    // on: same id, different destination.
    const held = await heldTool();
    manager.callTool.mockClear();

    useMcp.setState({ servers: [{ ...A, url: 'https://elsewhere.example/mcp' }] });
    expect((await held.execute({ q: 'x' }, at)).receipt).toBeUndefined();
    useMcp.setState({ servers: [{ ...A, name: 'renamed' }] });
    expect((await held.execute({ q: 'x' }, at)).receipt).toBeUndefined();
    expect(manager.callTool).not.toHaveBeenCalled();

    // The control: the record as the tool was built for it, and the call goes.
    useMcp.setState({ servers: [A] });
    expect((await held.execute({ q: 'x' }, at)).receipt?.outcome).toBe('sent');
    expect(manager.callTool).toHaveBeenCalledOnce();
  });
});

describe('switching a server off', () => {
  it('keeps its tools enabled in chats — the same server comes back', async () => {
    // The deliberate asymmetry with removal: a toggle brings back the same row
    // at the same URL, so an enable given to it is still an enable given to it.
    useChats.setState({ chats: [chat('c1', ['mcp:notes.search'])] });
    useMcp.setState({ servers: [server('mcp_a', 'notes', 'https://a.example/mcp')] });

    await useMcp.getState().toggle('mcp_a', false);

    expect(toolsOf('c1')).toEqual(['mcp:notes.search']);
    expect(tables.chats.put).not.toHaveBeenCalled();
  });
});

describe('a surface that never loaded the chat store', () => {
  /**
   * The prune is installed by `state/chat` when it loads, and `state/mcp` does
   * not import it. Every shipped entry point loads both today, but nothing
   * makes a new one do so — and a prune that silently did nothing would reopen
   * the bypass while the remove sheet said the tools had left every chat.
   *
   * Measured in a fresh module graph, so the chat store this file imported
   * above is not the one that installed anything.
   */
  it('refuses to add, remove or switch off a server rather than skipping the prune or the revoke', async () => {
    vi.resetModules();
    const alone = (await import('@/state/mcp')).useMcp;

    await expect(alone.getState().add({ name: 'notes', url: 'https://b.example/mcp' })).rejects.toThrow(
      'the chat store is not loaded',
    );
    expect(tables.mcpServers.put, 'the server was never stored').not.toHaveBeenCalled();
    expect(alone.getState().servers).toEqual([]);

    alone.setState({ servers: [server('mcp_a', 'notes', 'https://a.example/mcp')] });
    await expect(alone.getState().remove('mcp_a')).rejects.toThrow('the chat store is not loaded');

    // Switching a server off withdraws every chat's grant to send to it (#6),
    // and with nothing installed to do that it refuses rather than pretending.
    alone.setState({ servers: [server('mcp_a', 'notes', 'https://a.example/mcp')] });
    await expect(alone.getState().toggle('mcp_a', false)).rejects.toThrow('the chat store is not loaded');

    // The paired control: the same fresh graph, once the chat store has loaded.
    alone.setState({ servers: [] });
    await import('@/state/chat');
    expect(await alone.getState().add({ name: 'notes', url: 'https://b.example/mcp' })).toBeNull();
    expect(tables.mcpServers.put).toHaveBeenCalledOnce();
    await expect(alone.getState().toggle(alone.getState().servers[0]!.id, false)).resolves.toBeUndefined();
  });
});
