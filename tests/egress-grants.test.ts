import { beforeEach, describe, expect, it, vi } from 'vitest';
import { stage } from './support/stage';

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

const chatsTable = vi.hoisted(() => {
  // What the chat list reads at launch. Only the tests of loading it set this.
  const listed = vi.fn(async (): Promise<unknown[]> => []);
  return {
    put: vi.fn(async () => {}),
    listed,
    orderBy: () => ({ reverse: () => ({ toArray: () => listed() }) }),
  };
});

// The connections and MCP servers on disk, as the chat list reads them at launch.
const disk = vi.hoisted(() => ({
  connections: vi.fn(async (): Promise<unknown[]> => []),
  servers: vi.fn(async (): Promise<unknown[]> => []),
}));

vi.mock('@/db', () => ({
  db: {
    chats: chatsTable,
    messages: {
      put: vi.fn(async () => {}),
      where: () => ({ equals: () => ({ sortBy: async () => [] }) }),
      each: async () => {},
    },
    connections: { delete: vi.fn(async () => {}), put: vi.fn(async () => {}), toArray: () => disk.connections() },
    mcpServers: {
      put: vi.fn(async () => {}),
      delete: vi.fn(async () => {}),
      update: vi.fn(async () => {}),
      orderBy: () => ({ toArray: async () => [] }),
      toArray: () => disk.servers(),
    },
    blobs: { toCollection: () => ({ primaryKeys: async () => [] }), bulkDelete: vi.fn(async () => {}) },
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
const { writeSetting, db: tables } = await import('@/db');
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
 *
 * A test names the chat whose put it means. `held` resolves when that put has
 * started, rather than polling a count of puts: a count can be met by another
 * chat's put, and a poll has a budget a loaded runner can spend. A put that
 * never starts fails as `stage` reports it, naming the chat.
 */
function holdingChatWrites() {
  const stored = new Map<string, Chat>();
  const holds: { chatId: string; finish: () => void }[] = [];
  const arrivals: { chatId: string; arrived: () => void }[] = [];
  let holding = true;
  const releaseAll = (): void => {
    holding = false;
    for (const put of holds.splice(0)) put.finish();
  };
  chatsTable.put.mockImplementation((async (chat: Chat) => {
    stored.set(chat.id, structuredClone(chat));
    if (!holding) return;
    await new Promise<void>((finish) => {
      holds.push({ chatId: chat.id, finish });
      for (let at = arrivals.length - 1; at >= 0; at -= 1) {
        if (arrivals[at]!.chatId === chat.id) arrivals.splice(at, 1)[0]!.arrived();
      }
    });
  }) as never);
  return {
    stored,
    /** Resolves once a put of `chatId` is held: at once if one already is, otherwise when it starts. */
    held: (chatId: string): Promise<void> =>
      holds.some((put) => put.chatId === chatId)
        ? Promise.resolve()
        : stage(`a put of ${chatId} to be held`, new Promise<void>((arrived) => arrivals.push({ chatId, arrived }))),
    /** Let the oldest held put of `chatId` finish. Throws if none is held. */
    release: (chatId: string): void => {
      const at = holds.findIndex((put) => put.chatId === chatId);
      if (at === -1) throw new Error(`no put of ${chatId} is being held`);
      holds.splice(at, 1)[0]!.finish();
    },
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

/**
 * Every microtask already queued has run, and every one those queued. Writes
 * here are promises and nothing on their path sets a timer, so this orders two
 * steps exactly. It is never a wait for something that may take longer.
 */
const macrotask = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** Resolves once `holds()` is true: at once if it already is, otherwise on the store change that makes it so. */
function whenChats(what: string, holds: () => boolean): Promise<void> {
  if (holds()) return Promise.resolve();
  return stage(
    what,
    new Promise<void>((resolve) => {
      const unsubscribe = useChats.subscribe(() => {
        if (!holds()) return;
        unsubscribe();
        resolve();
      });
    }),
  );
}

/**
 * Every provider grant the store starts from here on, so a test can wait for
 * each to settle — its post-write re-check included — before it says what was
 * kept. The policy writes a grant with `void`, so nothing else holds that
 * promise, and a macrotask only covers a grant that happens to land within one.
 */
function recordingGrantWrites() {
  const original = useChats.getState().grantEgress;
  const started: Promise<void>[] = [];
  useChats.setState({
    grantEgress: (chatId, connectionId) => {
      const granting = original(chatId, connectionId);
      started.push(granting);
      return granting;
    },
  });
  return {
    /** Every grant started so far has settled, and any started while waiting. */
    settled: (): Promise<void> =>
      stage(
        'every provider grant started here to settle',
        (async () => {
          for (let seen = -1; seen !== started.length; ) {
            seen = started.length;
            await Promise.all(started);
          }
        })(),
      ),
    restore: () => useChats.setState({ grantEgress: original }),
  };
}

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
      await db.held('c1');
      await db.held('c2');
      // c1's grant lands while the revocation's write to c2 is still held, so
      // whatever the grant checks after its write, it checks before the
      // revocation has awaited anything of its own.
      db.release('c1');
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
      await db.held('c1');
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
      await db.held('c1');
      const renaming = useChats.getState().renameChat('c1', 'Renamed');
      await macrotask();
      db.release('c1');
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
      await db.held('c1');
      const granting = useChats.getState().grantEgress('c1', 'conn_openai');
      await macrotask();
      db.release('c1');
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
      await db.held('c1');
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
      await db.held('c1');
      const renaming = useChats.getState().renameChat('c1', 'Renamed');
      await macrotask();
      db.release('c1');
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
      await db.held('c1');
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
          await holding!.held('c1');
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

    const grants = recordingGrantWrites();
    try {
      await useChats.getState().send('what is in my chats?');
      // A conversation answer is written with `void`. Nothing is held open from
      // here, and every grant the turn gave has settled — withdrawn again, if
      // it had to be — before anything is said about what was kept.
      (holding as ReturnType<typeof holdingChatWrites> | null)?.releaseAll();
      await grants.settled();
    } finally {
      grants.restore();
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

    const grants = recordingGrantWrites();
    try {
      await useChats.getState().send('what is in my chats?');
      // Any grant the turn gave has settled, as in `switchedOffWhileWritten`.
      await grants.settled();
    } finally {
      grants.restore();
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
      await db.held('c1');
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
      await db.held('c1');
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
    //
    // Both chats hold the grant as the store would once c1's was written last.
    // A revocation writes chats in the store's order, newest first, and two
    // grants written one after the other put that order on the clock: a
    // millisecond between them put c2 first, and c1's revocation could not
    // start until c2's was released — which this test does only after it.
    const grant = { connectionId: 'conn_openai', grantedAt: 1 };
    useChats.setState({
      chats: useChats
        .getState()
        .chats.map((chat) => ({ ...chat, updatedAt: chat.id === 'c1' ? 3 : 2, egressGrants: [grant] })),
    });
    expect(useChats.getState().chats.map((chat) => chat.id), 'the order a revocation writes them in').toEqual([
      'c1',
      'c2',
    ]);
    const db = holdingChatWrites();
    try {
      const revoking = useChats.getState().revokeEgress('conn_openai');
      await db.held('c1');
      db.release('c1');
      // The revocation starts c2's write only once c1's has landed, in the table
      // and the store.
      await db.held('c2');
      expect(connectionsOf('c1')).toEqual([]);

      const granting = useChats.getState().grantEgress('c1', 'conn_openai');
      await db.held('c1');
      db.release('c1');
      await whenChats('the store to hold the new grant for c1', () => connectionsOf('c1').length > 0);
      expect(connectionsOf('c1')).toEqual(['conn_openai']);
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

describe('a grant on disk, withdrawn before the chat list has loaded', () => {
  /*
   * The app is up — Settings included — once the engine is, and the chat list
   * is read after that (App.tsx). A withdrawal drops grants from the chats in
   * the store, and until the list has landed there are none. So it dropped
   * nothing, the list then brought the grant in from disk, and switching the
   * connection or server back on honoured it without asking. The same held for
   * a removed server's tools, whose prune is what keeps them from coming back
   * on under the next server to take the name (#6).
   */
  const EARLY = { serverId: 'mcp_early', url: 'https://early.example/mcp' };
  const onDisk = (): Chat => ({
    id: 'early',
    title: 'Early',
    mode: 'chat',
    personaId: null,
    modelId: null,
    sampler: null,
    tools: ['mcp:early.search', 'calculate'],
    showThinking: false,
    createdAt: 1,
    updatedAt: 1,
    messageCount: 0,
    preview: '',
    egressGrants: [
      { connectionId: 'conn_early', grantedAt: 1 },
      { kind: 'mcp', ...EARLY, grantedAt: 1 },
      { connectionId: 'conn_kept', grantedAt: 1 },
      { kind: 'mcp', serverId: 'mcp_kept', url: 'https://kept.example/mcp', grantedAt: 1 },
    ],
  });
  const connectionsIn = (chat: Chat | undefined): string[] =>
    (chat?.egressGrants ?? []).flatMap((grant) => (grant.kind === 'mcp' ? [] : [grant.connectionId]));
  const serversIn = (chat: Chat | undefined): string[] =>
    (chat?.egressGrants ?? []).flatMap((grant) => (grant.kind === 'mcp' ? [grant.serverId] : []));

  beforeEach(() => {
    seed();
    useApp.setState({ connections: [{ ...OPENAI, id: 'conn_early', label: 'Early' }] });
    useMcp.setState({
      servers: [{ id: 'mcp_early', name: 'early', url: EARLY.url, enabled: true, createdAt: 1 }],
      states: {},
    });
    // Every grant on disk names somewhere that was there, on, at that address,
    // when the app started: what these measure is the withdrawal made meanwhile.
    disk.connections.mockImplementation(async () => [
      { ...OPENAI, id: 'conn_early', label: 'Early' },
      { ...OPENAI, id: 'conn_kept', label: 'Kept' },
    ]);
    disk.servers.mockImplementation(async () => [
      { id: 'mcp_early', name: 'early', url: EARLY.url, enabled: true, createdAt: 1 },
      { id: 'mcp_kept', name: 'kept', url: 'https://kept.example/mcp', enabled: true, createdAt: 1 },
    ]);
  });

  /** Load the list from disk, with `withdraw` run while it is being read. */
  async function loadedWhile(withdraw: () => Promise<void>): Promise<{ store?: Chat; table?: Chat }> {
    const db = holdingChatWrites();
    // Recorded, not held.
    db.releaseAll();
    let release = (): void => {};
    const reading = new Promise<void>((resolve) => (release = resolve));
    chatsTable.listed.mockClear();
    chatsTable.listed.mockImplementationOnce(async () => {
      const rows = [structuredClone(onDisk())];
      await reading;
      return rows;
    });
    useChats.setState({ loaded: false, chats: [], activeChatId: null, messages: [] });
    try {
      const loading = useChats.getState().load();
      await vi.waitFor(() => expect(chatsTable.listed).toHaveBeenCalled());
      await withdraw();
      release();
      await loading;
      await macrotask();
      return {
        store: useChats.getState().chats.find((chat) => chat.id === 'early'),
        table: db.stored.get('early'),
      };
    } finally {
      release();
      db.restore();
    }
  }

  it('stays withdrawn when its connection was switched off', async () => {
    const { store, table } = await loadedWhile(() => useApp.getState().toggleConnection('conn_early', false));

    expect(connectionsIn(store), 'the store').toEqual(['conn_kept']);
    expect(connectionsIn(table), 'the table').toEqual(['conn_kept']);
    expect(serversIn(store), 'the other grants').toEqual(['mcp_early', 'mcp_kept']);
  });

  it('stays withdrawn when its MCP server was switched off', async () => {
    const { store, table } = await loadedWhile(() => useMcp.getState().toggle('mcp_early', false));

    expect(serversIn(store), 'the store').toEqual(['mcp_kept']);
    expect(serversIn(table), 'the table').toEqual(['mcp_kept']);
    expect(connectionsIn(store), 'the other grants').toEqual(['conn_early', 'conn_kept']);
    // Switching a server off does not prune its tools; removing it does.
    expect(store?.tools).toEqual(['mcp:early.search', 'calculate']);
  });

  it('stays withdrawn, and its tools stay off, when its MCP server was removed', async () => {
    const { store, table } = await loadedWhile(() => useMcp.getState().remove('mcp_early'));

    expect(serversIn(store), 'the store').toEqual(['mcp_kept']);
    expect(store?.tools, 'the store').toEqual(['calculate']);
    expect(serversIn(table), 'the table').toEqual(['mcp_kept']);
    expect(table?.tools, 'the table').toEqual(['calculate']);
  });

  it('is loaded as it was on disk when nothing withdrew it', async () => {
    // The control.
    const { store, table } = await loadedWhile(async () => {});

    expect(store).toEqual(onDisk());
    expect(table, 'nothing to write').toBeUndefined();
  });
});

describe('a grant on disk whose connection or server is not there as it was granted', () => {
  /*
   * A withdrawal — removing or switching off a connection or an MCP server —
   * writes each chat that held a grant for it, one after another. An app killed
   * while that was still writing left the rest on disk, and the next launch
   * loaded them back: switching the connection or server on again honoured a
   * grant the person had withdrawn, and "Every grant … is dropped when … removed
   * or switched off" was false for it. So the launch drops every grant on disk
   * whose connection is missing or off, and every MCP grant whose server is
   * missing, off, or at another address — through each chat's write queue.
   */
  const LIVE = { serverId: 'mcp_live', url: 'https://live.example/mcp' };
  const MOVED = { serverId: 'mcp_moved', url: 'https://moved.example/mcp' };
  const onDisk = (): Chat => ({
    id: 'swept',
    title: 'Swept',
    mode: 'chat',
    personaId: null,
    modelId: null,
    sampler: null,
    tools: [],
    showThinking: false,
    createdAt: 1,
    updatedAt: 1,
    messageCount: 0,
    preview: '',
    egressGrants: [
      { connectionId: 'conn_gone', grantedAt: 1 },
      { connectionId: 'conn_off', grantedAt: 1 },
      { connectionId: 'conn_live', grantedAt: 1 },
      { kind: 'mcp', serverId: 'mcp_gone', url: 'https://gone.example/mcp', grantedAt: 1 },
      { kind: 'mcp', serverId: 'mcp_off', url: 'https://off.example/mcp', grantedAt: 1 },
      { kind: 'mcp', serverId: MOVED.serverId, url: 'https://before.example/mcp', grantedAt: 1 },
      { kind: 'mcp', ...LIVE, grantedAt: 1 },
    ],
  });
  const stillThere: EgressGrant[] = [
    { connectionId: 'conn_live', grantedAt: 1 },
    { kind: 'mcp', ...LIVE, grantedAt: 1 },
  ];

  beforeEach(() => {
    seed();
    disk.connections.mockImplementation(async () => [
      { ...OPENAI, id: 'conn_off', label: 'Off', enabled: false },
      { ...OPENAI, id: 'conn_live', label: 'Live' },
      { ...OPENAI, id: 'conn_new', label: 'New' },
    ]);
    disk.servers.mockImplementation(async () => [
      { id: 'mcp_off', name: 'off', url: 'https://off.example/mcp', enabled: false, createdAt: 1 },
      { id: MOVED.serverId, name: 'moved', url: MOVED.url, enabled: true, createdAt: 1 },
      { id: LIVE.serverId, name: 'live', url: LIVE.url, enabled: true, createdAt: 1 },
    ]);
  });

  /** Start a launch that reads `rows` from the chats table. */
  function launching(rows: Chat[]): Promise<void> {
    chatsTable.listed.mockImplementationOnce(async () => rows.map((row) => structuredClone(row)));
    useChats.setState({ loaded: false, chats: [], activeChatId: null, messages: [] });
    return useChats.getState().load();
  }

  it('is dropped at launch, from the store and the table, and every grant that still names somewhere is kept', async () => {
    const db = holdingChatWrites();
    db.releaseAll();
    try {
      await launching([onDisk()]);

      expect(grantsOf('swept'), 'the store').toEqual(stillThere);
      expect(db.stored.get('swept')?.egressGrants, 'the table').toEqual(stillThere);
      // Not something the person did in the conversation, so it stays where the list had it.
      expect(useChats.getState().chats.find((chat) => chat.id === 'swept')?.updatedAt).toBe(1);
      expect(db.stored.get('swept')?.updatedAt).toBe(1);
    } finally {
      db.restore();
    }
  });

  it('is not written again at the launch after', async () => {
    const db = holdingChatWrites();
    db.releaseAll();
    try {
      await launching([onDisk()]);
      const swept = db.stored.get('swept') ?? onDisk();
      chatsTable.put.mockClear();

      await launching([swept]);

      expect(grantsOf('swept')).toEqual(stillThere);
      expect(chatsTable.put, 'nothing more to write').not.toHaveBeenCalled();
    } finally {
      db.restore();
    }
  });

  it('does not bring back a grant withdrawn while the list was being read', async () => {
    // Judged on each chat as it stands when written, not on the row read from
    // disk: that row still holds what was switched off before the list loaded.
    const db = holdingChatWrites();
    db.releaseAll();
    let release = (): void => {};
    const reading = new Promise<void>((resolve) => (release = resolve));
    chatsTable.listed.mockClear();
    chatsTable.listed.mockImplementationOnce(async () => {
      const rows = [structuredClone(onDisk())];
      await reading;
      return rows;
    });
    useApp.setState({ connections: [{ ...OPENAI, id: 'conn_live', label: 'Live' }] });
    useChats.setState({ loaded: false, chats: [], activeChatId: null, messages: [] });
    try {
      const loading = useChats.getState().load();
      await vi.waitFor(() => expect(chatsTable.listed).toHaveBeenCalled());
      await useApp.getState().toggleConnection('conn_live', false);
      release();
      await loading;
    } finally {
      release();
      db.restore();
    }

    const onlyTheServer = [{ kind: 'mcp', ...LIVE, grantedAt: 1 }];
    expect(grantsOf('swept'), 'the store').toEqual(onlyTheServer);
    expect(db.stored.get('swept')?.egressGrants, 'the table').toEqual(onlyTheServer);
  });

  it('keeps a grant given while its write is waiting, and withdraws one given to a connection it is withdrawing', async () => {
    const db = holdingChatWrites();
    let loading: Promise<void> = Promise.resolve();
    const granting: Promise<void>[] = [];
    try {
      loading = launching([onDisk()]);
      await db.held('swept');

      granting.push(
        useChats.getState().grantEgress('swept', 'conn_new'),
        // At the address the server has now, not the one its old grant names.
        useChats.getState().grantMcpEgress('swept', MOVED),
        // Off on disk. A yes to it now is withdrawn with the grants on disk,
        // as one given while a switch-off is still being written is.
        useChats.getState().grantEgress('swept', 'conn_off'),
      );
      db.releaseAll();
      await Promise.all([loading, ...granting]);
    } finally {
      db.restore();
      await Promise.allSettled([loading, ...granting]);
    }

    const expected = [
      ...stillThere,
      { connectionId: 'conn_new', grantedAt: expect.any(Number) },
      { kind: 'mcp', ...MOVED, grantedAt: expect.any(Number) },
    ];
    expect(grantsOf('swept'), 'the store').toEqual(expected);
    expect(db.stored.get('swept')?.egressGrants, 'the table').toEqual(expected);
  });

  it('withdraws a yes given while its write waits to a server that is off or gone, or a connection that is gone', async () => {
    // Every id the launch withdraws is marked, not only a connection that is off.
    const db = holdingChatWrites();
    let loading: Promise<void> = Promise.resolve();
    const granting: Promise<void>[] = [];
    try {
      loading = launching([onDisk()]);
      await db.held('swept');

      granting.push(
        useChats.getState().grantMcpEgress('swept', { serverId: 'mcp_off', url: 'https://off.example/mcp' }),
        useChats.getState().grantMcpEgress('swept', { serverId: 'mcp_gone', url: 'https://gone.example/mcp' }),
        useChats.getState().grantEgress('swept', 'conn_gone'),
      );
      db.releaseAll();
      await Promise.all([loading, ...granting]);
    } finally {
      db.restore();
      await Promise.allSettled([loading, ...granting]);
    }

    expect(grantsOf('swept'), 'the store').toEqual(stillThere);
    expect(db.stored.get('swept')?.egressGrants, 'the table').toEqual(stillThere);
  });

  it('withdraws a yes given to a connection still off while another chat’s write has failed and this one’s waits', async () => {
    // The withdrawal ends once every write has settled, not at the first failure.
    const db = holdingChatWrites();
    const holding = chatsTable.put.getMockImplementation() as unknown as (chat: Chat) => Promise<void>;
    chatsTable.put.mockImplementation((async (chat: Chat) => {
      if (chat.id === 'refused') throw new Error('The disk is full.');
      return holding(chat);
    }) as never);
    let loading: Promise<void> = Promise.resolve();
    let granting: Promise<void> = Promise.resolve();
    try {
      loading = launching([{ ...onDisk(), id: 'refused', updatedAt: 2 }, onDisk()]);
      void loading.catch(() => {});
      await db.held('swept');
      await vi.waitFor(() => expect(chatsTable.put).toHaveBeenCalledWith(expect.objectContaining({ id: 'refused' })));
      await macrotask();

      granting = useChats.getState().grantEgress('swept', 'conn_off');
      db.releaseAll();
      await expect(loading).rejects.toThrow('The disk is full.');
      await granting;
    } finally {
      db.restore();
      await Promise.allSettled([loading, granting]);
    }

    expect(grantsOf('swept'), 'the store').toEqual(stillThere);
    expect(db.stored.get('swept')?.egressGrants, 'the table').toEqual(stillThere);
  });
});

describe('a connection or server switched back on while the launch withdraws the grants on disk that named it off', () => {
  /*
   * The launch counts those grants' withdrawal as under way until its writes
   * land, and a yes given meanwhile to that connection or server goes with them.
   * But a person can switch it back on in that time and then be asked: that yes
   * was given to something that is there, and was withdrawn all the same. The
   * grant on disk it named must still not come back.
   *
   * A switch-on is written only once no grant the launch read from disk naming it
   * off is left there: switched on with one still there, the next launch finds
   * the connection on and honours it. So it waits for the list to have been read
   * and for those grants' writes, and one that failed is made again first.
   */
  const OFF_URL = 'https://off.example/mcp';
  const chatOnDisk = (id: string, egressGrants: EgressGrant[]): Chat => ({
    id,
    title: id,
    mode: 'chat',
    personaId: null,
    modelId: null,
    sampler: null,
    tools: ['leaky'],
    showThinking: false,
    createdAt: 1,
    updatedAt: 1,
    messageCount: 0,
    preview: '',
    egressGrants,
  });
  const PROVIDER_ON_DISK: EgressGrant = { connectionId: 'conn_off', grantedAt: 1 };
  const SERVER_ON_DISK: EgressGrant = { kind: 'mcp', serverId: 'mcp_off', url: OFF_URL, grantedAt: 1 };
  const onDisk = (): Chat => chatOnDisk('swept', [PROVIDER_ON_DISK, SERVER_ON_DISK]);

  beforeEach(() => {
    seed();
    disk.connections.mockImplementation(async () => [{ ...OPENAI, id: 'conn_off', label: 'Off', enabled: false }]);
    disk.servers.mockImplementation(async () => [
      { id: 'mcp_off', name: 'off', url: OFF_URL, enabled: false, createdAt: 1 },
    ]);
    useApp.setState({ connections: [{ ...OPENAI, id: 'conn_off', label: 'Off', enabled: false }] });
    useMcp.setState({ servers: [{ id: 'mcp_off', name: 'off', url: OFF_URL, enabled: false, createdAt: 1 }], states: {} });
    vi.mocked(tables.connections.put).mockClear();
    vi.mocked(tables.mcpServers.update).mockClear();
  });
  function launching(rows: Chat[]): Promise<void> {
    chatsTable.listed.mockImplementationOnce(async () => rows.map((row) => structuredClone(row)));
    useChats.setState({ loaded: false, chats: [], activeChatId: null, messages: [] });
    return useChats.getState().load();
  }

  /** Every put recorded as it is made; the puts of one chat held until `release`. */
  function holdingWritesOf(held: string) {
    const stored = new Map<string, Chat>();
    let release = (): void => {};
    const released = new Promise<void>((resolve) => (release = resolve));
    chatsTable.put.mockImplementation((async (chat: Chat) => {
      stored.set(chat.id, structuredClone(chat));
      if (chat.id === held) await released;
    }) as never);
    return {
      stored,
      /** Resolves once a put of the held chat has been made. */
      made: () =>
        vi.waitFor(() => expect(chatsTable.put).toHaveBeenCalledWith(expect.objectContaining({ id: held }))),
      release,
      restore: () => {
        release();
        chatsTable.put.mockImplementation(async () => {});
      },
    };
  }

  it('keeps a provider grant given after the connection was switched back on, and not the one on disk', async () => {
    // Another chat's launch write is still held, so the launch's withdrawal of
    // everything it read is still under way when the yes is given.
    const db = holdingWritesOf('held');
    let loading: Promise<void> = Promise.resolve();
    let granting: Promise<void> = Promise.resolve();
    try {
      loading = launching([chatOnDisk('swept', [PROVIDER_ON_DISK]), chatOnDisk('held', [SERVER_ON_DISK])]);
      await db.made();
      await stage('the connection to be switched on', useApp.getState().toggleConnection('conn_off', true));
      expect(connectionsOf('swept'), 'switched on, before anything is asked: the grant on disk').toEqual([]);

      granting = useChats.getState().grantEgress('swept', 'conn_off');
      await granting;
      db.release();
      await loading;
    } finally {
      db.restore();
      await Promise.allSettled([loading, granting]);
    }
    const given = [{ connectionId: 'conn_off', grantedAt: expect.any(Number) }];
    expect(grantsOf('swept'), 'the store').toEqual(given);
    expect(db.stored.get('swept')?.egressGrants, 'the table').toEqual(given);
    expect(grantsOf('swept')[0]?.grantedAt, 'given now, not the one on disk').toBeGreaterThan(1);
  });

  it('keeps an MCP grant given after the server was switched back on, and not the one on disk', async () => {
    const db = holdingWritesOf('held');
    let loading: Promise<void> = Promise.resolve();
    let granting: Promise<void> = Promise.resolve();
    try {
      loading = launching([chatOnDisk('swept', [SERVER_ON_DISK]), chatOnDisk('held', [PROVIDER_ON_DISK])]);
      await db.made();
      await stage('the server to be switched on', useMcp.getState().toggle('mcp_off', true));
      expect(grantsOf('swept'), 'switched on, before anything is asked: the grant on disk').toEqual([]);

      granting = useChats.getState().grantMcpEgress('swept', { serverId: 'mcp_off', url: OFF_URL });
      await granting;
      db.release();
      await loading;
    } finally {
      db.restore();
      await Promise.allSettled([loading, granting]);
    }
    const given = [{ kind: 'mcp', serverId: 'mcp_off', url: OFF_URL, grantedAt: expect.any(Number) }];
    expect(grantsOf('swept'), 'the store').toEqual(given);
    expect(db.stored.get('swept')?.egressGrants, 'the table').toEqual(given);
    expect(grantsOf('swept')[0]?.grantedAt, 'given now, not the one on disk').toBeGreaterThan(1);
  });

  it('still withdraws a yes given to a connection that stays off', async () => {
    // The control: the switch is what ends it, not the asking.
    const db = holdingChatWrites();
    let loading: Promise<void> = Promise.resolve();
    let granting: Promise<void> = Promise.resolve();
    try {
      loading = launching([onDisk()]);
      await db.held('swept');
      granting = useChats.getState().grantEgress('swept', 'conn_off');
      db.releaseAll();
      await Promise.all([loading, granting]);
    } finally {
      db.restore();
      await Promise.allSettled([loading, granting]);
    }
    expect(grantsOf('swept'), 'the store').toEqual([]);
    expect(db.stored.get('swept')?.egressGrants, 'the table').toEqual([]);
  });

  it('keeps a yes given after a switch-on made while the chat list was still being read', async () => {
    // Switched on before the launch had judged what it read, the switch ended no
    // withdrawal: the withdrawal began after it, judged against the read, and the
    // yes was withdrawn while another chat's launch write was still held.
    const db = holdingWritesOf('held');
    let releaseList = (): void => {};
    const listing = new Promise<void>((resolve) => (releaseList = resolve));
    chatsTable.listed.mockClear();
    chatsTable.listed.mockImplementationOnce(async () => {
      const rows = [chatOnDisk('swept', [PROVIDER_ON_DISK]), chatOnDisk('held', [SERVER_ON_DISK])];
      await listing;
      return rows;
    });
    useChats.setState({ loaded: false, chats: [], activeChatId: null, messages: [] });
    let loading: Promise<void> = Promise.resolve();
    let switching: Promise<void> = Promise.resolve();
    let granting: Promise<void> = Promise.resolve();
    try {
      loading = useChats.getState().load();
      await vi.waitFor(() => expect(chatsTable.listed).toHaveBeenCalled());
      switching = useApp.getState().toggleConnection('conn_off', true);
      await macrotask();
      releaseList();
      await stage('the connection to be switched on', switching);
      await db.made();

      granting = useChats.getState().grantEgress('swept', 'conn_off');
      await granting;
      db.release();
      await loading;
    } finally {
      releaseList();
      db.restore();
      await Promise.allSettled([loading, switching, granting]);
    }
    const given = [{ connectionId: 'conn_off', grantedAt: expect.any(Number) }];
    expect(grantsOf('swept'), 'the store').toEqual(given);
    expect(db.stored.get('swept')?.egressGrants, 'the table').toEqual(given);
  });

  it('is not written on until the chat list read beside it has been judged', async () => {
    // The connection was read off beside the list. Written on before the launch
    // had queued the writes that drop the grants naming it, it was on on disk
    // while those grants were too.
    const order: string[] = [];
    chatsTable.put.mockImplementation((async (chat: Chat) => {
      order.push(`chat ${chat.id}`);
    }) as never);
    vi.mocked(tables.connections.put).mockImplementation((async (connection: { id: string }) => {
      order.push(`connection ${connection.id}`);
    }) as never);
    let releaseList = (): void => {};
    const listing = new Promise<void>((resolve) => (releaseList = resolve));
    chatsTable.listed.mockImplementationOnce(async () => {
      const rows = [chatOnDisk('swept', [PROVIDER_ON_DISK])];
      await listing;
      return rows;
    });
    useChats.setState({ loaded: false, chats: [], activeChatId: null, messages: [] });
    let loading: Promise<void> = Promise.resolve();
    let switching: Promise<void> = Promise.resolve();
    try {
      loading = useChats.getState().load();
      switching = useApp.getState().toggleConnection('conn_off', true);
      await macrotask();
      expect(order, 'nothing written while the list is being read').toEqual([]);
      releaseList();
      await Promise.all([loading, switching]);
    } finally {
      releaseList();
      chatsTable.put.mockImplementation(async () => {});
      vi.mocked(tables.connections.put).mockImplementation((async () => {}) as never);
      await Promise.allSettled([loading, switching]);
    }
    expect(order).toEqual(['chat swept', 'connection conn_off']);
  });

  /** A turn in `swept` through the real engine, answering no to everything. What reached the provider, and what was asked. */
  async function aTurn(): Promise<{ secretSent: boolean; asked: string[] }> {
    const engine = new ChatterangEngine({ resolver: probeResolver, fallbackBackendId: null });
    const cloud = recordingBackend([CALL, 'Done.']);
    engine.router.register('conn_off', cloud.adapter);
    toolRegistry.register(leakyTool);
    const asked: string[] = [];
    const original = useApp.getState().requestApproval;
    useApp.setState({
      engine: engine as never,
      connections: [{ ...OPENAI, id: 'conn_off', label: 'Off', enabled: true }],
      requestApproval: async (action: string) => {
        asked.push(action);
        return false;
      },
    });
    useChats.setState({ generating: false, controller: null, messages: [], activeChatId: 'swept' });
    try {
      await useChats.getState().send('what is in my chats?');
    } finally {
      toolRegistry.unregister('leaky');
      useApp.setState({ engine: null, requestApproval: original });
    }
    const requests = sent(cloud.seen);
    expect(requests.length, 'the control: the turn reached the provider').toBeGreaterThanOrEqual(1);
    return { secretSent: requests.some((request) => request.includes(SECRET)), asked };
  }

  it('writes away a grant whose launch write failed before the connection is switched on, so the next launch asks', async () => {
    // The launch's write failed — a full disk — and the store had already
    // dropped the grant, but the table had not. Switched on in that session, the
    // connection was on at the next launch, which honoured the grant: tool
    // output went to it unasked, measured through the real engine.
    const table = new Map<string, Chat>([['swept', chatOnDisk('swept', [PROVIDER_ON_DISK])]]);
    const order: string[] = [];
    let full = true;
    chatsTable.put.mockImplementation((async (chat: Chat) => {
      if (full) throw new Error('The disk is full.');
      table.set(chat.id, structuredClone(chat));
      order.push(`chat ${chat.id}`);
    }) as never);
    vi.mocked(tables.connections.put).mockImplementation((async (connection: { id: string }) => {
      order.push(`connection ${connection.id}`);
    }) as never);
    try {
      await expect(launching([...table.values()])).rejects.toThrow('The disk is full.');
      expect(table.get('swept')?.egressGrants, 'the control: the grant is still on disk').toEqual([PROVIDER_ON_DISK]);
      expect(grantsOf('swept'), 'the control: the store does not hold it').toEqual([]);

      full = false;
      await useApp.getState().toggleConnection('conn_off', true);
      expect(order, 'the grant written away, then the connection switched on').toEqual([
        'chat swept',
        'connection conn_off',
      ]);
      expect(table.get('swept')?.egressGrants, 'the table').toEqual([]);

      disk.connections.mockImplementation(async () => [{ ...OPENAI, id: 'conn_off', label: 'Off', enabled: true }]);
      await launching([...table.values()]);
      expect(grantsOf('swept'), 'the next launch').toEqual([]);

      const { secretSent, asked } = await aTurn();
      expect(asked, 'asked at the next launch').toHaveLength(1);
      expect(secretSent, 'tool output sent unasked').toBe(false);
    } finally {
      chatsTable.put.mockImplementation(async () => {});
      vi.mocked(tables.connections.put).mockImplementation((async () => {}) as never);
    }
  });

  it('is not switched on while a grant its launch write could not write away is still on disk', async () => {
    const table = new Map<string, Chat>([['swept', chatOnDisk('swept', [PROVIDER_ON_DISK])]]);
    chatsTable.put.mockImplementation((async () => {
      throw new Error('The disk is full.');
    }) as never);
    try {
      await expect(launching([...table.values()])).rejects.toThrow('The disk is full.');

      await expect(useApp.getState().toggleConnection('conn_off', true)).rejects.toThrow('The disk is full.');

      expect(tables.connections.put, 'nothing switched on on disk').not.toHaveBeenCalled();
      expect(useApp.getState().connections.find((connection) => connection.id === 'conn_off')?.enabled).toBe(false);
      // And so the next launch finds it off, and withdraws the grant again.
      await launching([...table.values()]).catch(() => {});
      expect(grantsOf('swept'), 'the next launch').toEqual([]);
    } finally {
      chatsTable.put.mockImplementation(async () => {});
    }
  });

  it('waits for a launch write still under way, and makes it again when it fails', async () => {
    const table = new Map<string, Chat>([['swept', chatOnDisk('swept', [PROVIDER_ON_DISK])]]);
    let failing: { release: () => void } | null = null;
    const failed = new Promise<void>((resolve) => (failing = { release: resolve }));
    let first = true;
    chatsTable.put.mockImplementation((async (chat: Chat) => {
      if (first) {
        first = false;
        await failed;
        throw new Error('The disk is full.');
      }
      table.set(chat.id, structuredClone(chat));
    }) as never);
    let loading: Promise<void> = Promise.resolve();
    let switching: Promise<void> = Promise.resolve();
    try {
      loading = launching([...table.values()]);
      void loading.catch(() => {});
      await vi.waitFor(() => expect(chatsTable.put).toHaveBeenCalled());
      switching = useApp.getState().toggleConnection('conn_off', true);
      await macrotask();
      expect(tables.connections.put, 'not while the launch write is under way').not.toHaveBeenCalled();

      failing!.release();
      await expect(loading).rejects.toThrow('The disk is full.');
      await stage('the connection to be switched on', switching);
    } finally {
      failing!.release();
      chatsTable.put.mockImplementation(async () => {});
      await Promise.allSettled([loading, switching]);
    }
    expect(table.get('swept')?.egressGrants, 'the table').toEqual([]);
    expect(tables.connections.put).toHaveBeenCalledWith(expect.objectContaining({ id: 'conn_off', enabled: true }));
  });

  it('writes away an MCP grant whose launch write failed before the server is switched on', async () => {
    const table = new Map<string, Chat>([['swept', chatOnDisk('swept', [SERVER_ON_DISK])]]);
    const order: string[] = [];
    let full = true;
    chatsTable.put.mockImplementation((async (chat: Chat) => {
      if (full) throw new Error('The disk is full.');
      table.set(chat.id, structuredClone(chat));
      order.push(`chat ${chat.id}`);
    }) as never);
    vi.mocked(tables.mcpServers.update).mockImplementation((async (id: string) => {
      order.push(`server ${id}`);
      return 1;
    }) as never);
    try {
      await expect(launching([...table.values()])).rejects.toThrow('The disk is full.');

      full = false;
      await useMcp.getState().toggle('mcp_off', true);

      expect(order, 'the grant written away, then the server switched on').toEqual(['chat swept', 'server mcp_off']);
      expect(table.get('swept')?.egressGrants, 'the table').toEqual([]);
    } finally {
      chatsTable.put.mockImplementation(async () => {});
      vi.mocked(tables.mcpServers.update).mockImplementation((async () => 1) as never);
    }
  });

  describe('after it was switched off while the chat list was being read', () => {
    /*
     * Read on beside the list, then switched off before the list landed. The
     * launch takes the grants naming it out of what it read (`beforeTheList`),
     * and does not judge them stale: as read, the connection was on. Only the
     * write that drops them took them off disk, and a switch-on did not wait for
     * it. When it failed — a full disk — or was still under way, the connection
     * was on on disk beside the grant, and the next launch honoured it.
     */
    const SERVER_ON = { id: 'mcp_off', name: 'off', url: OFF_URL, enabled: true, createdAt: 1 };
    const CONNECTION_ON = { ...OPENAI, id: 'conn_off', label: 'Off', enabled: true };

    beforeEach(() => {
      disk.connections.mockImplementation(async () => [CONNECTION_ON]);
      disk.servers.mockImplementation(async () => [SERVER_ON]);
      useApp.setState({ connections: [CONNECTION_ON] });
      useMcp.setState({ servers: [SERVER_ON], states: {} });
    });

    /** Start a launch whose chat list read lands only once `release` is called. */
    function launchingHeld(rows: Chat[]) {
      let release = (): void => {};
      const listing = new Promise<void>((resolve) => (release = resolve));
      chatsTable.listed.mockClear();
      chatsTable.listed.mockImplementationOnce(async () => {
        const read = rows.map((row) => structuredClone(row));
        await listing;
        return read;
      });
      useChats.setState({ loaded: false, chats: [], activeChatId: null, messages: [] });
      const loading = useChats.getState().load();
      void loading.catch(() => {});
      return {
        loading,
        release,
        read: () => vi.waitFor(() => expect(chatsTable.listed).toHaveBeenCalled()),
      };
    }

    it('writes away a grant whose write failed before the connection is switched on again, so the next launch asks', async () => {
      const table = new Map<string, Chat>([['swept', chatOnDisk('swept', [PROVIDER_ON_DISK])]]);
      const order: string[] = [];
      let full = true;
      chatsTable.put.mockImplementation((async (chat: Chat) => {
        if (full) throw new Error('The disk is full.');
        table.set(chat.id, structuredClone(chat));
        order.push(`chat ${chat.id}`);
      }) as never);
      vi.mocked(tables.connections.put).mockImplementation((async (connection: { id: string; enabled: boolean }) => {
        order.push(`connection ${connection.id} ${connection.enabled ? 'on' : 'off'}`);
      }) as never);
      const launch = launchingHeld([...table.values()]);
      try {
        await launch.read();
        await useApp.getState().toggleConnection('conn_off', false);
        launch.release();
        await expect(launch.loading).rejects.toThrow('The disk is full.');
        expect(table.get('swept')?.egressGrants, 'the control: the grant is still on disk').toEqual([PROVIDER_ON_DISK]);
        expect(grantsOf('swept'), 'the control: the store does not hold it').toEqual([]);

        full = false;
        await useApp.getState().toggleConnection('conn_off', true);
        expect(order, 'the grant written away, then the connection switched on').toEqual([
          'connection conn_off off',
          'chat swept',
          'connection conn_off on',
        ]);
        expect(table.get('swept')?.egressGrants, 'the table').toEqual([]);

        // The next launch reads the connection on.
        await launching([...table.values()]);
        expect(grantsOf('swept'), 'the next launch').toEqual([]);
        const { secretSent, asked } = await aTurn();
        expect(asked, 'asked at the next launch').toHaveLength(1);
        expect(secretSent, 'tool output sent unasked').toBe(false);
      } finally {
        launch.release();
        chatsTable.put.mockImplementation(async () => {});
        vi.mocked(tables.connections.put).mockImplementation((async () => {}) as never);
      }
    });

    it('is not written on again while the write dropping that grant is still under way', async () => {
      const order: string[] = [];
      let releasePut = (): void => {};
      const putReleased = new Promise<void>((resolve) => (releasePut = resolve));
      chatsTable.put.mockImplementation((async (chat: Chat) => {
        order.push(`chat ${chat.id} made`);
        await putReleased;
        order.push(`chat ${chat.id} landed`);
      }) as never);
      vi.mocked(tables.connections.put).mockImplementation((async (connection: { id: string; enabled: boolean }) => {
        order.push(`connection ${connection.id} ${connection.enabled ? 'on' : 'off'}`);
      }) as never);
      const launch = launchingHeld([chatOnDisk('swept', [PROVIDER_ON_DISK])]);
      let switching: Promise<void> = Promise.resolve();
      try {
        await launch.read();
        await useApp.getState().toggleConnection('conn_off', false);
        launch.release();
        await stage('the write dropping the grant to be made', vi.waitFor(() => expect(order).toContain('chat swept made')));

        switching = useApp.getState().toggleConnection('conn_off', true);
        await macrotask();
        expect(order, 'nothing switched on while that write is under way').toEqual([
          'connection conn_off off',
          'chat swept made',
        ]);

        releasePut();
        await launch.loading;
        await stage('the connection to be switched on', switching);
      } finally {
        launch.release();
        releasePut();
        chatsTable.put.mockImplementation(async () => {});
        vi.mocked(tables.connections.put).mockImplementation((async () => {}) as never);
        await Promise.allSettled([launch.loading, switching]);
      }
      expect(order).toEqual(['connection conn_off off', 'chat swept made', 'chat swept landed', 'connection conn_off on']);
    });

    it('writes away an MCP grant whose write failed before the server is switched on again', async () => {
      const table = new Map<string, Chat>([['swept', chatOnDisk('swept', [SERVER_ON_DISK])]]);
      const order: string[] = [];
      let full = true;
      chatsTable.put.mockImplementation((async (chat: Chat) => {
        if (full) throw new Error('The disk is full.');
        table.set(chat.id, structuredClone(chat));
        order.push(`chat ${chat.id}`);
      }) as never);
      vi.mocked(tables.mcpServers.update).mockImplementation((async (id: string, changes: { enabled: boolean }) => {
        order.push(`server ${id} ${changes.enabled ? 'on' : 'off'}`);
        return 1;
      }) as never);
      const launch = launchingHeld([...table.values()]);
      try {
        await launch.read();
        await useMcp.getState().toggle('mcp_off', false);
        launch.release();
        await expect(launch.loading).rejects.toThrow('The disk is full.');
        expect(table.get('swept')?.egressGrants, 'the control: the grant is still on disk').toEqual([SERVER_ON_DISK]);

        full = false;
        await useMcp.getState().toggle('mcp_off', true);
        expect(order, 'the grant written away, then the server switched on').toEqual([
          'server mcp_off off',
          'chat swept',
          'server mcp_off on',
        ]);
        expect(table.get('swept')?.egressGrants, 'the table').toEqual([]);
      } finally {
        launch.release();
        chatsTable.put.mockImplementation(async () => {});
        vi.mocked(tables.mcpServers.update).mockImplementation((async () => 1) as never);
      }
    });
  });

});
