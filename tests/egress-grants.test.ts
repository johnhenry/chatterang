import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The persisted half of the tool-output rule.
 *
 * `tests/privacy.test.ts` proves the engine withholds without a grant and
 * sends with one. This proves the grant is the thing the user actually
 * decided about: scoped to one conversation and one connection, not
 * duplicated, and — the part that is easy to leave out — dropped when the
 * connection it named goes away. A permission that outlives its connection
 * silently applies to whatever next claims that id.
 */

const chatsTable = vi.hoisted(() => ({ put: vi.fn(async () => {}) }));

vi.mock('@/db', () => ({
  db: {
    chats: chatsTable,
    messages: { put: vi.fn(async () => {}), where: () => ({ equals: () => ({ sortBy: async () => [] }) }) },
    connections: { delete: vi.fn(async () => {}), put: vi.fn(async () => {}), toArray: async () => [] },
    mcpServers: {
      put: vi.fn(async () => {}),
      delete: vi.fn(async () => {}),
      update: vi.fn(async () => {}),
      orderBy: () => ({ toArray: async () => [] }),
    },
  },
  deleteChat: vi.fn(async () => {}),
  readSetting: async (_key: string, fallback: unknown) => fallback,
  writeSetting: vi.fn(async () => {}),
}));

// The network boundary. Removing or switching off a server reconnects the rest.
vi.mock('@/ai/mcp/client', () => ({
  mcpManager: {
    configure: vi.fn(async () => {}),
    listTools: vi.fn(async () => []),
    callTool: vi.fn(async () => ({ content: [] })),
  },
}));

const { useChats } = await import('@/state/chat');
const { useApp } = await import('@/state/app');
const { useMcp } = await import('@/state/mcp');
const { holdsGrant } = await import('@/domain/chat');
type EgressGrant = import('@/domain/chat').EgressGrant;

function seed(): void {
  useChats.setState({
    chats: [
      {
        id: 'c1',
        title: 'One',
        mode: 'chat',
        personaId: null,
        modelId: null,
        sampler: null,
        tools: ['shell'],
        showThinking: false,
        createdAt: 1,
        updatedAt: 1,
        messageCount: 0,
        preview: '',
      },
      {
        id: 'c2',
        title: 'Two',
        mode: 'chat',
        personaId: null,
        modelId: null,
        sampler: null,
        tools: [],
        showThinking: false,
        createdAt: 2,
        updatedAt: 2,
        messageCount: 0,
        preview: '',
      },
    ],
  });
}

const grantsOf = (id: string): readonly EgressGrant[] =>
  useChats.getState().chats.find((chat) => chat.id === id)?.egressGrants ?? [];

/** The connections a chat's provider grants name. */
const connectionsOf = (id: string): string[] =>
  grantsOf(id).flatMap((grant) => (grant.kind === 'mcp' ? [] : [grant.connectionId]));

describe('a tool-output grant', () => {
  beforeEach(() => {
    seed();
    chatsTable.put.mockClear();
  });

  it('names one conversation and one connection, and is persisted', async () => {
    await useChats.getState().grantEgress('c1', 'conn_openai');

    expect(connectionsOf('c1')).toEqual(['conn_openai']);
    // The other conversation gains nothing. This is the whole reason the grant
    // is per-chat rather than a setting.
    expect(grantsOf('c2')).toEqual([]);
    expect(chatsTable.put).toHaveBeenCalledTimes(1);
  });

  it('is not duplicated when the same destination is granted twice', async () => {
    await useChats.getState().grantEgress('c1', 'conn_openai');
    chatsTable.put.mockClear();
    await useChats.getState().grantEgress('c1', 'conn_openai');

    expect(grantsOf('c1')).toHaveLength(1);
    expect(chatsTable.put).not.toHaveBeenCalled();
  });

  it('is dropped everywhere when its connection is removed', async () => {
    await useChats.getState().grantEgress('c1', 'conn_openai');
    await useChats.getState().grantEgress('c2', 'conn_openai');
    await useChats.getState().grantEgress('c2', 'conn_ollama');

    await useApp.getState().removeConnection('conn_openai');

    expect(grantsOf('c1')).toEqual([]);
    // A grant for a different connection is untouched — otherwise this would
    // pass by clearing everything, which is not the same rule.
    expect(connectionsOf('c2')).toEqual(['conn_ollama']);
  });

  it('is dropped when its connection is merely switched off', async () => {
    // Disabling is the reversible half of removing, and it takes the same
    // route through `disconnectProvider`. A grant that survived it would apply
    // again the moment the switch went back on, without being asked for.
    useApp.setState({
      connections: [
        {
          id: 'conn_openai',
          providerId: 'openai',
          label: 'OpenAI',
          apiKey: '',
          baseUrl: '',
          defaultModel: 'gpt-4o-mini',
          enabled: true,
          models: [],
          createdAt: 0,
        },
      ],
    });
    await useChats.getState().grantEgress('c1', 'conn_openai');

    await useApp.getState().toggleConnection('conn_openai', false);

    expect(grantsOf('c1')).toEqual([]);
  });
});

/**
 * The same rule for the other kind of grant (#6): permission for one
 * conversation to send MCP tool calls' arguments to one server, at one address.
 */
describe('an MCP grant', () => {
  const NOTES = { serverId: 'mcp_notes', url: 'https://notes.example/mcp' };
  const grantOf = (server: { serverId: string; url: string }) => ({
    kind: 'mcp',
    ...server,
    grantedAt: expect.any(Number),
  });

  beforeEach(async () => {
    seed();
    useMcp.setState({
      servers: [{ id: 'mcp_notes', name: 'notes', url: NOTES.url, enabled: true, createdAt: 1 }],
      states: {},
    });
    chatsTable.put.mockClear();
  });

  it('names one conversation and one server, and is persisted once', async () => {
    await useChats.getState().grantMcpEgress('c1', NOTES);

    expect(grantsOf('c1')).toEqual([grantOf(NOTES)]);
    expect(grantsOf('c2')).toEqual([]);
    expect(chatsTable.put).toHaveBeenCalledTimes(1);

    chatsTable.put.mockClear();
    await useChats.getState().grantMcpEgress('c1', NOTES);
    expect(grantsOf('c1')).toHaveLength(1);
    expect(chatsTable.put).not.toHaveBeenCalled();
  });

  it('is dropped everywhere when the server is removed, and no other grant is', async () => {
    const OTHER = { serverId: 'mcp_other', url: 'https://other.example/mcp' };
    await useChats.getState().grantMcpEgress('c1', NOTES);
    await useChats.getState().grantEgress('c1', 'conn_openai');
    await useChats.getState().grantMcpEgress('c2', NOTES);
    await useChats.getState().grantMcpEgress('c2', OTHER);

    await useMcp.getState().remove('mcp_notes');

    expect(grantsOf('c1')).toEqual([{ connectionId: 'conn_openai', grantedAt: expect.any(Number) }]);
    expect(grantsOf('c2')).toEqual([grantOf(OTHER)]);
  });

  it('is dropped when the server is merely switched off, and does not come back with it', async () => {
    await useChats.getState().grantMcpEgress('c1', NOTES);

    await useMcp.getState().toggle('mcp_notes', false);
    expect(grantsOf('c1')).toEqual([]);

    await useMcp.getState().toggle('mcp_notes', true);
    expect(grantsOf('c1'), 'switching it back on grants nothing').toEqual([]);
  });

  it('never answers the provider gate, and a provider grant never answers an MCP call', () => {
    // The same id string under both kinds: only the kind can tell them apart.
    const mcp: EgressGrant[] = [{ kind: 'mcp', serverId: 'shared', url: NOTES.url, grantedAt: 1 }];
    const provider: EgressGrant[] = [{ connectionId: 'shared', grantedAt: 1 }];
    expect(holdsGrant(mcp, { kind: 'provider', connectionId: 'shared' })).toBe(false);
    expect(holdsGrant(provider, { kind: 'mcp', serverId: 'shared', url: NOTES.url })).toBe(false);
    expect(holdsGrant(mcp, { kind: 'mcp', serverId: 'shared', url: NOTES.url })).toBe(true);
    expect(holdsGrant(provider, { kind: 'provider', connectionId: 'shared' })).toBe(true);

    // A row carrying both kinds' fields — a future writer's mistake, or a
    // damaged store — still answers for its own kind only.
    const both = { serverId: 'shared', url: NOTES.url, connectionId: 'shared', grantedAt: 1 };
    const asMcp = [{ kind: 'mcp', ...both }] as unknown as EgressGrant[];
    const asProvider = [both] as unknown as EgressGrant[];
    expect(holdsGrant(asMcp, { kind: 'provider', connectionId: 'shared' })).toBe(false);
    expect(holdsGrant(asProvider, { kind: 'mcp', serverId: 'shared', url: NOTES.url })).toBe(false);
  });

  it('for a server’s old address does not cover its new one', () => {
    const grants: EgressGrant[] = [{ kind: 'mcp', ...NOTES, grantedAt: 1 }];
    expect(holdsGrant(grants, { kind: 'mcp', serverId: 'mcp_notes', url: 'https://moved.example/mcp' })).toBe(false);
    expect(holdsGrant(grants, { kind: 'mcp', serverId: 'mcp_other', url: NOTES.url })).toBe(false);
    expect(holdsGrant(grants, { kind: 'mcp', ...NOTES })).toBe(true);
  });

  it('for a new address replaces the stale one rather than being deduped away', async () => {
    const MOVED = { serverId: 'mcp_notes', url: 'https://moved.example/mcp' };
    await useChats.getState().grantMcpEgress('c1', NOTES);
    await useChats.getState().grantMcpEgress('c1', MOVED);

    expect(grantsOf('c1')).toEqual([grantOf(MOVED)]);
  });

  it('leaves the conversation’s other grants where they are, whether it is new or replaces a stale address', async () => {
    // Seeded FIRST. The tests above grant a server into a conversation holding
    // nothing else, so a filter that dropped every other grant along with the
    // stale one would pass them — and would quietly undo a provider answer the
    // person gave, bringing its sheet back every turn.
    const OTHER = { serverId: 'mcp_other', url: 'https://other.example/mcp' };
    const MOVED = { serverId: 'mcp_notes', url: 'https://moved.example/mcp' };
    const provider = { connectionId: 'conn_openai', grantedAt: expect.any(Number) };
    await useChats.getState().grantEgress('c1', 'conn_openai');
    await useChats.getState().grantMcpEgress('c1', OTHER);

    await useChats.getState().grantMcpEgress('c1', NOTES);
    expect(grantsOf('c1')).toEqual([provider, grantOf(OTHER), grantOf(NOTES)]);

    await useChats.getState().grantMcpEgress('c1', MOVED);
    expect(grantsOf('c1')).toEqual([provider, grantOf(OTHER), grantOf(MOVED)]);
  });

  it('does not survive a revocation that ran while it was being written', async () => {
    // A conversation answer is written with `void` (`mcpEgressPolicy`), and a
    // revocation reads the chats before it writes. One that starts while the
    // grant's write is in flight finds no grant to drop, and — without the
    // check this measures — the grant lands after it and outlives the server
    // being switched off. c2 holds a grant already, so the revocation is still
    // under way (its write held open) when c1's lands.
    await useChats.getState().grantMcpEgress('c2', NOTES);
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    chatsTable.put.mockImplementationOnce(async () => {}).mockImplementationOnce(() => held);

    const granting = useChats.getState().grantMcpEgress('c1', NOTES);
    const revoking = useChats.getState().revokeMcpEgress('mcp_notes');
    await granting;
    release();
    await revoking;

    expect(grantsOf('c1')).toEqual([]);
    expect(grantsOf('c2')).toEqual([]);

    // The control: a grant asked for after the revocation is kept.
    await useChats.getState().grantMcpEgress('c1', NOTES);
    expect(grantsOf('c1')).toEqual([grantOf(NOTES)]);
  });

  it('survives a revocation of another server that ran while it was being written', async () => {
    // The check above is per server. One that counted every server's
    // revocations together would quietly undo this answer too.
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    chatsTable.put.mockImplementationOnce(() => held);

    const granting = useChats.getState().grantMcpEgress('c1', NOTES);
    await useChats.getState().revokeMcpEgress('mcp_other');
    release();
    await granting;

    expect(grantsOf('c1')).toEqual([grantOf(NOTES)]);
  });

  it('is left alone when a connection with the same id goes, and leaves that connection’s grant alone', async () => {
    await useChats.getState().grantMcpEgress('c1', { serverId: 'shared', url: NOTES.url });
    await useChats.getState().grantEgress('c1', 'shared');

    await useChats.getState().revokeEgress('shared');
    expect(grantsOf('c1')).toEqual([grantOf({ serverId: 'shared', url: NOTES.url })]);

    await useChats.getState().grantEgress('c1', 'shared');
    await useChats.getState().revokeMcpEgress('shared');
    expect(grantsOf('c1')).toEqual([{ connectionId: 'shared', grantedAt: expect.any(Number) }]);
  });
});
