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
const { writeSetting } = await import('@/db');
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

/* ── Writes that overlap ─────────────────────────────────────────────── */

type Chat = import('@/domain/chat').Chat;
type ApprovalPrompt = import('@/state/app').ApprovalPrompt;

const OPENAI = {
  id: 'conn_openai',
  providerId: 'openai',
  label: 'OpenAI',
  apiKey: '',
  baseUrl: '',
  defaultModel: 'gpt-4o-mini',
  enabled: true,
  models: [],
  createdAt: 0,
};

/**
 * The chats table, held open.
 *
 * Every put is recorded in the order it was MADE, which is the order IndexedDB
 * applies overlapping readwrite transactions in, so `stored` is what the table
 * holds once they have all committed. Each put then waits until it is released,
 * which is how a test starts one write while another is still in flight.
 */
function holdingChatWrites() {
  const stored = new Map<string, Chat>();
  const waiting: (() => void)[] = [];
  let holding = true;
  const releaseAll = (): void => {
    holding = false;
    for (const resolve of waiting.splice(0)) resolve();
  };
  chatsTable.put.mockImplementation((async (chat: Chat) => {
    stored.set(chat.id, structuredClone(chat));
    if (holding) await new Promise<void>((resolve) => waiting.push(resolve));
  }) as never);
  return {
    stored,
    /** Puts started and not yet released. */
    pending: () => waiting.length,
    /** Let the oldest put still waiting finish. */
    releaseFirst: () => waiting.shift()?.(),
    /** Let the newest put still waiting finish. */
    releaseLast: () => waiting.pop()?.(),
    /** Let every put finish, and every later one go straight through. */
    releaseAll,
    restore: () => {
      releaseAll();
      chatsTable.put.mockImplementation(async () => {});
    },
  };
}

/** The connections a chat's provider grants name, as the table holds the chat. */
const storedConnections = (stored: Map<string, Chat>, id: string): string[] =>
  (stored.get(id)?.egressGrants ?? []).flatMap((grant) => (grant.kind === 'mcp' ? [] : [grant.connectionId]));

const macrotask = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('a provider grant, written while something else writes the same chat', () => {
  beforeEach(() => {
    seed();
    useApp.setState({ connections: [{ ...OPENAI }] });
    chatsTable.put.mockClear();
  });

  it('does not survive a revocation that ran while it was being written', async () => {
    // A conversation answer is written with `void` (`egressPolicy`), and a
    // revocation reads the chats before it writes. One that starts while the
    // grant's write is in flight finds nothing in c1 to drop, and the grant
    // lands after it. c2 already holds one, so the revocation is itself still
    // being written when c1's write lands.
    await useChats.getState().grantEgress('c2', 'conn_openai');
    const db = holdingChatWrites();
    try {
      const granting = useChats.getState().grantEgress('c1', 'conn_openai');
      const revoking = useChats.getState().revokeEgress('conn_openai');
      await vi.waitFor(() => expect(db.pending()).toBe(2));
      // c1's grant lands while the revocation's write to c2 is still held, so
      // whatever the grant checks after its write, it checks before the
      // revocation has awaited anything of its own.
      db.releaseFirst();
      await macrotask();
      db.releaseAll();
      await Promise.all([granting, revoking]);

      expect(connectionsOf('c1')).toEqual([]);
      expect(connectionsOf('c2')).toEqual([]);
      expect(storedConnections(db.stored, 'c1'), 'the table').toEqual([]);
      expect(storedConnections(db.stored, 'c2'), 'the table').toEqual([]);

      // The control: a grant asked for after the revocation is kept.
      await useChats.getState().grantEgress('c1', 'conn_openai');
      expect(connectionsOf('c1')).toEqual(['conn_openai']);
      expect(storedConnections(db.stored, 'c1')).toEqual(['conn_openai']);
    } finally {
      db.restore();
    }
  });

  it('survives a revocation of another connection that ran while it was being written', async () => {
    // The check above is per connection. One that counted every connection's
    // revocations together would quietly undo this answer too.
    const db = holdingChatWrites();
    try {
      const granting = useChats.getState().grantEgress('c1', 'conn_openai');
      await vi.waitFor(() => expect(db.pending()).toBe(1));
      await useChats.getState().revokeEgress('conn_ollama');
      db.releaseAll();
      await granting;

      expect(connectionsOf('c1')).toEqual(['conn_openai']);
      expect(storedConnections(db.stored, 'c1')).toEqual(['conn_openai']);
    } finally {
      db.restore();
    }
  });

  it('is not written back by a rename that ran while its revocation was being written', async () => {
    // Worse than a lost write. The rename reads c1 while the store still holds
    // the grant, and its put — every field of the chat it read, not only the
    // title — lands after the revocation's, in the table and in the store.
    await useChats.getState().grantEgress('c1', 'conn_openai');
    const db = holdingChatWrites();
    try {
      const switchingOff = useApp.getState().toggleConnection('conn_openai', false);
      await vi.waitFor(() => expect(db.pending()).toBe(1));
      const renaming = useChats.getState().renameChat('c1', 'Renamed');
      await macrotask();
      db.releaseFirst();
      await switchingOff;
      db.releaseAll();
      await renaming;

      const chat = useChats.getState().chats.find((entry) => entry.id === 'c1');
      expect(connectionsOf('c1')).toEqual([]);
      expect(chat?.title, 'and the rename is not lost either').toBe('Renamed');
      expect(storedConnections(db.stored, 'c1'), 'the table').toEqual([]);
      expect(db.stored.get('c1')?.title).toBe('Renamed');
    } finally {
      db.restore();
    }
  });

  it('does not bring back another connection’s grant whose revocation was being written', async () => {
    // The same resurrection from the grant's side: a grant that appends to the
    // list it read, rather than to the list as it stands when it is written,
    // carries a revoked grant back in with it.
    await useChats.getState().grantEgress('c1', 'conn_ollama');
    const db = holdingChatWrites();
    try {
      const revoking = useChats.getState().revokeEgress('conn_ollama');
      await vi.waitFor(() => expect(db.pending()).toBe(1));
      const granting = useChats.getState().grantEgress('c1', 'conn_openai');
      await macrotask();
      db.releaseFirst();
      await revoking;
      db.releaseAll();
      await granting;

      expect(connectionsOf('c1')).toEqual(['conn_openai']);
      expect(storedConnections(db.stored, 'c1'), 'the table').toEqual(['conn_openai']);
    } finally {
      db.restore();
    }
  });

  it('does not take away another connection’s grant that was written while it waited its turn', async () => {
    // The other way round. A revocation that wrote the list it read when it
    // started would not have the grant queued ahead of it, and would drop an
    // answer the person gave — a lost write rather than a leak, but the same
    // defect. So a revocation filters the list as it stands when it is written.
    await useChats.getState().grantEgress('c1', 'conn_ollama');
    const db = holdingChatWrites();
    try {
      const renaming = useChats.getState().renameChat('c1', 'Renamed');
      await vi.waitFor(() => expect(db.pending()).toBe(1));
      const granting = useChats.getState().grantEgress('c1', 'conn_openai');
      const revoking = useChats.getState().revokeEgress('conn_ollama');
      await macrotask();
      db.releaseAll();
      await Promise.all([renaming, granting, revoking]);

      expect(connectionsOf('c1')).toEqual(['conn_openai']);
      expect(storedConnections(db.stored, 'c1'), 'the table').toEqual(['conn_openai']);
    } finally {
      db.restore();
    }
  });
});

describe('an MCP grant, written while something else writes the same chat', () => {
  const NOTES = { serverId: 'mcp_notes', url: 'https://notes.example/mcp' };
  const mcpGrantsIn = (grants: readonly EgressGrant[] | undefined): string[] =>
    (grants ?? []).flatMap((grant) => (grant.kind === 'mcp' ? [grant.serverId] : []));

  beforeEach(() => {
    seed();
    useMcp.setState({
      servers: [{ id: 'mcp_notes', name: 'notes', url: NOTES.url, enabled: true, createdAt: 1 }],
      states: {},
    });
    chatsTable.put.mockClear();
  });

  it('is not written back by a rename that ran while its revocation was being written', async () => {
    await useChats.getState().grantMcpEgress('c1', NOTES);
    const db = holdingChatWrites();
    try {
      // What Settings does when the server is switched off.
      const switchingOff = useMcp.getState().toggle('mcp_notes', false);
      await vi.waitFor(() => expect(db.pending()).toBe(1));
      const renaming = useChats.getState().renameChat('c1', 'Renamed');
      await macrotask();
      db.releaseFirst();
      await switchingOff;
      db.releaseAll();
      await renaming;

      const chat = useChats.getState().chats.find((entry) => entry.id === 'c1');
      expect(mcpGrantsIn(chat?.egressGrants)).toEqual([]);
      expect(chat?.title).toBe('Renamed');
      expect(mcpGrantsIn(db.stored.get('c1')?.egressGrants), 'the table').toEqual([]);
      expect(db.stored.get('c1')?.title).toBe('Renamed');
    } finally {
      db.restore();
    }
  });
});

describe('two writes to one chat', () => {
  beforeEach(() => {
    seed();
    chatsTable.put.mockClear();
  });

  it('both land, when the second starts before the first is written', async () => {
    const db = holdingChatWrites();
    try {
      const titling = useChats.getState().updateChat('c1', { title: 'Titled' });
      const pinning = useChats.getState().updateChat('c1', { pinned: true });
      await vi.waitFor(() => expect(db.pending()).toBeGreaterThan(0));
      db.releaseAll();
      await Promise.all([titling, pinning]);

      expect(useChats.getState().chats.find((entry) => entry.id === 'c1')).toMatchObject({
        title: 'Titled',
        pinned: true,
      });
      expect(db.stored.get('c1'), 'the table').toMatchObject({ title: 'Titled', pinned: true });
    } finally {
      db.restore();
    }
  });
});

/* ── The answer a running turn holds ─────────────────────────────────── */

const { ChatterangEngine } = await import('@/ai/engine');
const { toolRegistry } = await import('@/ai/tools/registry');
const { CALL, SECRET, leakyTool, probeResolver, recordingBackend, sent } = await import('./support/egress-probe');

describe('an answer the running turn holds about a connection', () => {
  /*
   * `decided` in the engine's `stream` keeps an answer for the rest of the turn.
   * Switching a connection off drops its grants, and switching it back on
   * registers the same id again — so without something that says the grants
   * were withdrawn, the answer the turn is holding sends the next request's
   * tool output to that connection unasked.
   *
   * Driven through the real store, the real `toggleConnection` and the real
   * engine; recorded at the adapter. Switching the connection back on is
   * stood in for by registering the same adapter under the same id, which is
   * what `connectProvider` does, without loading a provider SDK.
   */
  beforeEach(() => {
    seed();
    chatsTable.put.mockClear();
  });

  it.each(['turn', 'conversation'] as const)(
    'ends when the connection is switched off, though it is back before the next request (“%s”)',
    async (first) => {
      const engine = new ChatterangEngine({ resolver: probeResolver, fallbackBackendId: null });
      const cloud = recordingBackend([CALL, CALL, CALL, 'Done.']);
      engine.router.register('conn_openai', cloud.adapter);

      let runs = 0;
      toolRegistry.register({
        ...leakyTool,
        execute: async () => {
          runs += 1;
          if (runs === 2) {
            await useApp.getState().toggleConnection('conn_openai', false);
            engine.router.register('conn_openai', cloud.adapter);
          }
          return leakyTool.execute();
        },
      });

      const asked: string[] = [];
      const answers: ('turn' | 'conversation' | 'no')[] = [first, 'no'];
      const original = useApp.getState().requestApproval;
      useApp.setState({
        engine: engine as never,
        connections: [{ ...OPENAI }],
        requestApproval: async (action: string, prompt?: ApprovalPrompt) => {
          asked.push(action);
          const answer = answers.shift() ?? 'no';
          if (answer === 'conversation') prompt?.onExtended?.();
          return answer !== 'no';
        },
      });
      useChats.setState({
        loaded: true,
        generating: false,
        controller: null,
        messages: [],
        activeChatId: 'c1',
        chats: useChats.getState().chats.map((chat) => (chat.id === 'c1' ? { ...chat, tools: ['leaky'] } : chat)),
      });

      try {
        await useChats.getState().send('what is in my chats?');
      } finally {
        toolRegistry.unregister('leaky');
        useApp.setState({ engine: null, connections: [], requestApproval: original });
      }

      const requests = sent(cloud.seen);
      expect(requests.length).toBeGreaterThanOrEqual(3);
      // The answer was honoured while it stood — otherwise this passes for a
      // gate that never let anything through.
      expect(requests[1]).toContain(SECRET);
      // And asked again once the connection had been switched off.
      expect(asked).toHaveLength(2);
      for (const later of requests.slice(2)) expect(later).not.toContain(SECRET);
      expect(connectionsOf('c1')).toEqual([]);
    },
  );

  /**
   * One turn through the real store, `toggleConnection` and engine, in which
   * the second tool run switches the connection off WITHOUT waiting for it —
   * as a click in Settings during a tool run would — and switches it back on
   * while the revocation's write is still held open. The third tool run lets
   * the write land and waits for the switch-off to finish, so every request
   * from the fourth on is built after the grant is gone from the store and
   * the table.
   */
  async function switchedOffWhileWritten(answers: ('turn' | 'conversation' | 'no')[]) {
    const db = holdingChatWrites();
    db.releaseAll();
    const engine = new ChatterangEngine({ resolver: probeResolver, fallbackBackendId: null });
    const cloud = recordingBackend([CALL, CALL, CALL, CALL, 'Done.']);
    engine.router.register('conn_openai', cloud.adapter);

    let runs = 0;
    let holding: ReturnType<typeof holdingChatWrites> | null = null;
    let switchingOff: Promise<void> | null = null;
    toolRegistry.register({
      ...leakyTool,
      execute: async () => {
        runs += 1;
        if (runs === 2) {
          holding = holdingChatWrites();
          switchingOff = useApp.getState().toggleConnection('conn_openai', false);
          await vi.waitFor(() => expect(holding!.pending()).toBeGreaterThan(0));
          engine.router.register('conn_openai', cloud.adapter);
        }
        if (runs === 3) {
          holding!.releaseAll();
          await switchingOff;
        }
        return leakyTool.execute();
      },
    });

    const asked: string[] = [];
    const queue = [...answers];
    const original = useApp.getState().requestApproval;
    useApp.setState({
      engine: engine as never,
      connections: [{ ...OPENAI }],
      requestApproval: async (action: string, prompt?: ApprovalPrompt) => {
        asked.push(action);
        const answer = queue.shift() ?? 'no';
        if (answer === 'conversation') prompt?.onExtended?.();
        return answer !== 'no';
      },
    });
    useChats.setState({
      loaded: true,
      generating: false,
      controller: null,
      messages: [],
      activeChatId: 'c1',
      chats: useChats.getState().chats.map((chat) => (chat.id === 'c1' ? { ...chat, tools: ['leaky'] } : chat)),
    });

    try {
      await useChats.getState().send('what is in my chats?');
      await macrotask();
    } finally {
      toolRegistry.unregister('leaky');
      (holding as ReturnType<typeof holdingChatWrites> | null)?.restore();
      useApp.setState({ engine: null, connections: [], requestApproval: original });
      db.restore();
    }
    // Every put went through one of the two recorders; the later one has the
    // puts made from the second tool run on, which is where c1 was last written.
    const stored = (holding as ReturnType<typeof holdingChatWrites> | null)?.stored ?? db.stored;
    return { asked, requests: sent(cloud.seen), stored };
  }

  it('is not taken from a grant whose revocation is still being written, nor held once it has landed', async () => {
    // The store keeps the grant until the revocation's write lands. A request
    // decided in that window must not go on it, and — worse — must not hold
    // that yes for the rest of the turn, after the grant is gone.
    const { asked, requests, stored } = await switchedOffWhileWritten(['conversation', 'no']);

    expect(requests.length).toBeGreaterThanOrEqual(4);
    expect(requests[1], 'the answer, while it stood').toContain(SECRET);
    expect(requests[2], 'decided while the revocation was being written').not.toContain(SECRET);
    expect(requests[3], 'built after the revocation had landed').not.toContain(SECRET);
    expect(asked).toHaveLength(2);
    expect(connectionsOf('c1')).toEqual([]);
    expect(storedConnections(stored, 'c1'), 'the table').toEqual([]);
  });

  it.each(['turn', 'conversation'] as const)(
    'is asked again once a revocation that was being written while it was given has landed (“%s”)',
    async (during) => {
      // A yes given while the connection's grants were being withdrawn is
      // honoured for the request it was asked about. It does not outlive the
      // withdrawal: not in the turn, and not as a grant.
      const { asked, requests, stored } = await switchedOffWhileWritten(['conversation', during, 'no']);

      expect(requests.length).toBeGreaterThanOrEqual(4);
      expect(requests[3], 'built after the revocation had landed').not.toContain(SECRET);
      expect(asked).toHaveLength(3);
      expect(connectionsOf('c1')).toEqual([]);
      expect(storedConnections(stored, 'c1'), 'the table').toEqual([]);
    },
  );

  it('is not kept, nor written down, when the connection was switched off while its sheet was up', async () => {
    const db = holdingChatWrites();
    db.releaseAll();
    const engine = new ChatterangEngine({ resolver: probeResolver, fallbackBackendId: null });
    const cloud = recordingBackend([CALL, CALL, 'Done.']);
    engine.router.register('conn_openai', cloud.adapter);
    toolRegistry.register({ ...leakyTool });

    const asked: string[] = [];
    const original = useApp.getState().requestApproval;
    useApp.setState({
      engine: engine as never,
      connections: [{ ...OPENAI }],
      requestApproval: async (action: string, prompt?: ApprovalPrompt) => {
        asked.push(action);
        if (asked.length > 1) return false;
        // While the sheet is up, the connection is switched off, all the way,
        // and back on under the same id.
        await useApp.getState().toggleConnection('conn_openai', false);
        engine.router.register('conn_openai', cloud.adapter);
        prompt?.onExtended?.();
        return true;
      },
    });
    useChats.setState({
      loaded: true,
      generating: false,
      controller: null,
      messages: [],
      activeChatId: 'c1',
      chats: useChats.getState().chats.map((chat) => (chat.id === 'c1' ? { ...chat, tools: ['leaky'] } : chat)),
    });

    try {
      await useChats.getState().send('what is in my chats?');
      await macrotask();
    } finally {
      toolRegistry.unregister('leaky');
      useApp.setState({ engine: null, connections: [], requestApproval: original });
      db.restore();
    }

    const requests = sent(cloud.seen);
    expect(requests.length).toBeGreaterThanOrEqual(3);
    expect(asked, 'the answer was not held for the next request').toHaveLength(2);
    expect(requests[2]).not.toContain(SECRET);
    expect(connectionsOf('c1')).toEqual([]);
    expect(storedConnections(db.stored, 'c1'), 'the table').toEqual([]);
  });
});

describe('an answer the running turn holds, while switching its connection off clears the fallback', () => {
  /*
   * `toggleConnection` and `removeConnection` disconnect, then — when the
   * connection is the fallback — await the settings write, and only then
   * withdraw the connection's grants. Until the withdrawal STARTS nothing says
   * the answer the turn holds is stale. So the question is whether anything can
   * reach the connection in that window.
   *
   * For a switch-off it can: switching it back on registers the same id, and
   * the next request is built under the held answer. For a removal the id does
   * not come back through the app (a new connection gets a new id), so the
   * re-registration below stands in for nothing a person can do; it is measured
   * anyway, because the two share the ordering.
   */
  beforeEach(() => {
    seed();
    chatsTable.put.mockClear();
  });

  it.each([
    ['switched off', 'turn'],
    ['switched off', 'conversation'],
    ['removed', 'turn'],
    ['removed', 'conversation'],
  ] as const)('ends when the connection is %s, though it is back before the settings are written (“%s”)', async (how, first) => {
    const engine = new ChatterangEngine({ resolver: probeResolver, fallbackBackendId: null });
    const cloud = recordingBackend([CALL, CALL, CALL, 'Done.']);
    engine.router.register('conn_openai', cloud.adapter);

    let releaseSettings = () => {};
    const settingsHeld = new Promise<void>((resolve) => {
      releaseSettings = resolve;
    });
    vi.mocked(writeSetting).mockImplementationOnce(() => settingsHeld);

    let runs = 0;
    let leaving: Promise<void> | null = null;
    toolRegistry.register({
      ...leakyTool,
      execute: async () => {
        runs += 1;
        if (runs === 2) {
          // Not awaited, as a click in Settings during a tool run is not.
          leaving =
            how === 'removed'
              ? useApp.getState().removeConnection('conn_openai')
              : useApp.getState().toggleConnection('conn_openai', false);
          await vi.waitFor(() => expect(writeSetting).toHaveBeenCalled());
          // Back on, under the same id, while the fallback setting is still
          // being written.
          engine.router.register('conn_openai', cloud.adapter);
        }
        if (runs === 3) {
          releaseSettings();
          await leaving;
        }
        return leakyTool.execute();
      },
    });

    const asked: string[] = [];
    const answers: ('turn' | 'conversation' | 'no')[] = [first, 'no'];
    const original = useApp.getState().requestApproval;
    const settings = useApp.getState().settings;
    useApp.setState({
      engine: engine as never,
      connections: [{ ...OPENAI }],
      settings: { ...settings, fallbackBackendId: 'conn_openai' },
      requestApproval: async (action: string, prompt?: ApprovalPrompt) => {
        asked.push(action);
        const answer = answers.shift() ?? 'no';
        if (answer === 'conversation') prompt?.onExtended?.();
        return answer !== 'no';
      },
    });
    useChats.setState({
      loaded: true,
      generating: false,
      controller: null,
      messages: [],
      activeChatId: 'c1',
      chats: useChats.getState().chats.map((chat) => (chat.id === 'c1' ? { ...chat, tools: ['leaky'] } : chat)),
    });

    try {
      await useChats.getState().send('what is in my chats?');
      await macrotask();
    } finally {
      releaseSettings();
      toolRegistry.unregister('leaky');
      useApp.setState({ engine: null, connections: [], requestApproval: original, settings });
    }

    const requests = sent(cloud.seen);
    expect(requests.length).toBeGreaterThanOrEqual(3);
    expect(requests[1], 'the answer, while it stood').toContain(SECRET);
    expect(requests[2], 'built while the fallback setting was being written').not.toContain(SECRET);
    expect(asked).toHaveLength(2);
    expect(connectionsOf('c1')).toEqual([]);
  });
});

describe('the store’s provider policy, while a grant is being withdrawn', () => {
  type ToolEgressPolicy = import('@/ai/engine').ToolEgressPolicy;

  /** The policy the store hands the engine for c1, taken from a real turn. */
  async function storePolicy(): Promise<ToolEgressPolicy> {
    const engine = new ChatterangEngine({ resolver: probeResolver, fallbackBackendId: null });
    engine.router.register('conn_openai', recordingBackend(['Done.']).adapter);
    let policy: ToolEgressPolicy | undefined;
    const stream = engine.stream.bind(engine);
    engine.stream = ((request: Parameters<typeof stream>[0]) => {
      policy = request.egress;
      return stream(request);
    }) as typeof engine.stream;
    useApp.setState({ engine: engine as never, connections: [{ ...OPENAI }] });
    useChats.setState({ loaded: true, generating: false, controller: null, messages: [], activeChatId: 'c1' });
    try {
      await useChats.getState().send('hello');
    } finally {
      useApp.setState({ engine: null });
    }
    expect(policy).toBeDefined();
    return policy!;
  }

  beforeEach(() => {
    seed();
    chatsTable.put.mockClear();
  });

  it('does not answer for a held grant while its revocation is still being written', async () => {
    const policy = await storePolicy();
    await useChats.getState().grantEgress('c1', 'conn_openai');
    await useChats.getState().grantEgress('c1', 'conn_ollama');
    const db = holdingChatWrites();
    try {
      const switchingOff = useApp.getState().toggleConnection('conn_openai', false);
      await vi.waitFor(() => expect(db.pending()).toBe(1));
      expect(connectionsOf('c1'), 'the store still holds it').toContain('conn_openai');
      expect(policy.isGranted('conn_openai')).toBe(false);
      expect(policy.isGranted('conn_ollama'), 'another connection’s grant').toBe(true);

      db.releaseAll();
      await switchingOff;
      expect(policy.isGranted('conn_openai')).toBe(false);
      expect(policy.isGranted('conn_ollama')).toBe(true);

      // The control: once it has settled, a grant given again answers again.
      await useChats.getState().grantEgress('c1', 'conn_openai');
      expect(policy.isGranted('conn_openai')).toBe(true);
      expect(storedConnections(db.stored, 'c1')).toEqual(['conn_ollama', 'conn_openai']);
    } finally {
      db.restore();
    }
  });

  it('does not answer for a grant whose write outlasted a revocation, before it withdraws itself', async () => {
    // A revocation that starts and ends while the grant is being written reads
    // c1 before the grant is in it, and has nothing to write. The grant lands
    // in the store, and withdraws itself only once its write has settled.
    const policy = await storePolicy();
    const db = holdingChatWrites();
    const seen: boolean[] = [];
    const unsubscribe = useChats.subscribe(() => {
      if (connectionsOf('c1').includes('conn_openai')) seen.push(policy.isGranted('conn_openai'));
    });
    try {
      const granting = useChats.getState().grantEgress('c1', 'conn_openai');
      await vi.waitFor(() => expect(db.pending()).toBe(1));
      await useChats.getState().revokeEgress('conn_openai');
      db.releaseAll();
      await granting;

      expect(seen.length, 'the store held the grant for a moment').toBeGreaterThan(0);
      expect(seen).not.toContain(true);
      expect(connectionsOf('c1')).toEqual([]);
      expect(storedConnections(db.stored, 'c1'), 'the table').toEqual([]);
    } finally {
      unsubscribe();
      db.restore();
    }
  });

  it('does not keep a grant given while its connection’s revocation is still being written', async () => {
    // c1's revocation has landed and c2's is still held, so the revocation is
    // under way when the grant for c1 is given, written, and checked.
    await useChats.getState().grantEgress('c1', 'conn_openai');
    await useChats.getState().grantEgress('c2', 'conn_openai');
    const db = holdingChatWrites();
    try {
      const revoking = useChats.getState().revokeEgress('conn_openai');
      await vi.waitFor(() => expect(db.pending()).toBe(1));
      db.releaseFirst();
      await vi.waitFor(() => expect(connectionsOf('c1')).toEqual([]));
      await vi.waitFor(() => expect(db.pending()).toBe(1));

      const granting = useChats.getState().grantEgress('c1', 'conn_openai');
      await vi.waitFor(() => expect(db.pending()).toBe(2));
      db.releaseLast();
      await vi.waitFor(() => expect(connectionsOf('c1')).toEqual(['conn_openai']));
      // Its own check runs while c2's revocation is still held.
      await macrotask();
      db.releaseAll();
      await Promise.all([revoking, granting]);

      expect(connectionsOf('c1')).toEqual([]);
      expect(connectionsOf('c2')).toEqual([]);
      expect(storedConnections(db.stored, 'c1'), 'the table').toEqual([]);

      // The control: a grant given after the revocation has finished is kept.
      await useChats.getState().grantEgress('c1', 'conn_openai');
      expect(connectionsOf('c1')).toEqual(['conn_openai']);
      expect(storedConnections(db.stored, 'c1')).toEqual(['conn_openai']);
    } finally {
      db.restore();
    }
  });
});
