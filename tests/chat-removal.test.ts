import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A DELETED CONVERSATION STAYS DELETED.
 *
 * The delete sheet says "The conversation and every message in it will be
 * removed from this device. This cannot be undone." Writes to one chat run one
 * at a time (`chatWrites` in state/chat.ts), and each reads the chat when it
 * runs. Deleting a chat did not take part: a write queued behind another one ran
 * while the delete was still being carried out, found the chat still in the
 * store, and put it back into the table after the delete had removed it — so it
 * came back the next time the app loaded. A conversation's messages had the same
 * hole, from the turn still running in it and from the recovery of an
 * interrupted row.
 *
 * The database is held in memory, at the table boundary. Every write is applied
 * in the order it was MADE, which is the order IndexedDB applies overlapping
 * readwrite transactions in; a read takes its snapshot when it is made. Each can
 * then be held open, which is how a test starts one thing while another is still
 * in flight.
 *
 * Every test uses chat ids of its own. A chat id is never reused in the app, and
 * the store remembers which chats it has deleted for as long as it runs.
 */

type Row = {
  id: string;
  chatId?: string;
  updatedAt?: number;
  createdAt?: number;
  attachments?: readonly { id: string }[];
};

const fake = vi.hoisted(() => {
  const chats = new Map<string, Row>();
  const messages = new Map<string, Row>();
  /** Attachment payloads, by attachment id, as `lib/blobs.ts` keeps them. */
  const blobs = new Map<string, Row>();
  const holding = new Set<string>();
  const waiting = new Map<string, (() => void)[]>();
  const clone = <T>(value: T): T => structuredClone(value);

  /** Wait here while `name` is held. */
  const gate = async (name: string): Promise<void> => {
    if (!holding.has(name)) return;
    await new Promise<void>((resolve) => waiting.set(name, [...(waiting.get(name) ?? []), resolve]));
  };

  const threadOf = (chatId: string): Row[] =>
    [...messages.values()]
      .filter((row) => row.chatId === chatId)
      .map(clone)
      .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));

  const db = {
    chats: {
      put: vi.fn(async (chat: Row) => {
        chats.set(chat.id, clone(chat));
        await gate('chats.put');
      }),
      delete: vi.fn(async (id: string) => {
        chats.delete(id);
      }),
      orderBy: () => ({
        reverse: () => ({
          toArray: async () => {
            const snapshot = [...chats.values()].map(clone).sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
            await gate('chats.read');
            return snapshot;
          },
        }),
      }),
    },
    messages: {
      put: vi.fn(async (message: Row) => {
        messages.set(message.id, clone(message));
        await gate('messages.put');
      }),
      delete: vi.fn(async (id: string) => {
        messages.delete(id);
      }),
      where: () => ({
        equals: (chatId: string) => ({
          sortBy: async () => {
            const snapshot = threadOf(chatId);
            await gate('messages.read');
            return snapshot;
          },
          toArray: async () => threadOf(chatId),
        }),
      }),
    },
    blobs: {
      get: async (id: string) => {
        const row = blobs.get(id);
        await gate('blobs.get');
        return row;
      },
      bulkDelete: vi.fn(async (ids: string[]) => {
        for (const id of ids) blobs.delete(id);
      }),
    },
    models: { put: vi.fn(async () => {}), delete: vi.fn(async () => {}), toArray: async () => [] },
    settings: { get: vi.fn(async () => undefined), put: vi.fn(async () => {}) },
    connections: { put: vi.fn(async () => {}), delete: vi.fn(async () => {}), toArray: async () => [] },
  };

  /** The cascade `db/index.ts` runs, attachment payloads included, applied when it is made. */
  const deleteChat = vi.fn(async (chatId: string) => {
    for (const row of [...messages.values()]) {
      if (row.chatId !== chatId) continue;
      for (const attachment of row.attachments ?? []) blobs.delete(attachment.id);
      messages.delete(row.id);
    }
    chats.delete(chatId);
    await gate('deleteChat');
  });

  return {
    db,
    deleteChat,
    chats,
    messages,
    blobs,
    hold: (name: string): void => {
      holding.add(name);
    },
    pending: (name: string): number => waiting.get(name)?.length ?? 0,
    /** Let everything held at `name` go, and every later call straight through. */
    release: (name: string): void => {
      holding.delete(name);
      for (const resolve of waiting.get(name)?.splice(0) ?? []) resolve();
    },
    reset: (): void => {
      chats.clear();
      messages.clear();
      blobs.clear();
      holding.clear();
      for (const resolvers of waiting.values()) for (const resolve of resolvers.splice(0)) resolve();
    },
  };
});

vi.mock('@/db', () => ({
  db: fake.db,
  deleteChat: fake.deleteChat,
  readSetting: async (_key: string, fallback: unknown) => fallback,
  writeSetting: vi.fn(async () => {}),
}));

const { useChats } = await import('@/state/chat');
const { useModels } = await import('@/state/models');
const { useApp } = await import('@/state/app');
const { catalogEntry } = await import('@/data/catalog');
const { DEFAULT_SAMPLER } = await import('@/domain/manifest');
const { ChatterangEngine } = await import('@/ai/engine');
const { toolRegistry } = await import('@/ai/tools/registry');
const { MCP_CALL, mcpProbe, probeResolver, recordingBackend } = await import('./support/egress-probe');

type Chat = import('@/domain/chat').Chat;
type Message = import('@/domain/chat').Message;
type ToolInvocation = import('@/domain/chat').ToolInvocation;
type ApprovalPrompt = import('@/state/app').ApprovalPrompt;

const QWEN = catalogEntry('qwen3-4b-instruct-q4km')!;

function chat(id: string, updatedAt: number): Chat {
  return {
    id,
    title: id,
    mode: 'chat',
    personaId: null,
    modelId: QWEN.id,
    sampler: null,
    tools: [],
    showThinking: false,
    createdAt: updatedAt,
    updatedAt,
    messageCount: 0,
    preview: '',
  };
}

/** Chats that are in the store and in the table, as ones loaded from disk are. */
function given(...chats: Chat[]): void {
  for (const entry of chats) fake.chats.set(entry.id, structuredClone(entry));
  useChats.setState({
    loaded: true,
    chats,
    activeChatId: null,
    messages: [],
    generating: false,
    controller: null,
    context: null,
  });
}

const inStore = (id: string): boolean => useChats.getState().chats.some((entry) => entry.id === id);
const rowsFor = (chatId: string): Row[] => [...fake.messages.values()].filter((row) => row.chatId === chatId);
const macrotask = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

async function until(condition: () => boolean): Promise<void> {
  for (let tries = 0; tries < 200; tries += 1) {
    if (condition()) return;
    await macrotask();
  }
  throw new Error('the condition never held');
}

/** What the next launch shows: the store rebuilt from the table. */
async function relaunch(): Promise<string[]> {
  useChats.setState({ loaded: false, chats: [] });
  await useChats.getState().load();
  return useChats.getState().chats.map((entry) => entry.id);
}

/* ── A scripted turn ─────────────────────────────────────────────────── */

interface Turn {
  readonly text: string;
  readonly beforeTool?: Promise<void>;
  readonly tool?: ToolInvocation;
  readonly onToolHandled?: () => void;
  readonly hang?: Promise<void>;
}

let script: Turn[] = [];
/** The signal each turn handed to the engine was given, in order. */
let signals: (AbortSignal | undefined)[] = [];

/**
 * The engine, replaced by a recorder. What is under test is what the STORE
 * writes while a turn runs and after it ends, so the generation is scripted.
 * It ignores its signal, as a backend already past the point of checking it
 * does: whether the turn was stopped is read from `signals`.
 */
function scriptedEngine(): unknown {
  return {
    async *stream(request: { signal?: AbortSignal }) {
      signals.push(request.signal);
      const turn = script.shift();
      if (!turn) throw new Error('the script ran out of turns');
      if (turn.beforeTool) await turn.beforeTool;
      if (turn.tool) {
        yield { type: 'tool', tool: turn.tool };
        turn.onToolHandled?.();
      }
      if (turn.hang) await turn.hang;
      yield {
        type: 'done',
        text: turn.text,
        provenance: {
          backendId: 'llama-cpp',
          engine: 'llama-cpp',
          modelId: QWEN.id,
          modelName: 'Qwen3 4B Instruct',
          local: true,
        },
        stats: { promptTokens: 8, completionTokens: 4 },
      };
    },
  };
}

function held(): { promise: Promise<void>; release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

const SENT: ToolInvocation = {
  id: 'call_mcp',
  name: 'notes.search',
  input: { q: 'bank details' },
  output: 'found',
  receipt: {
    outcome: 'sent',
    serverId: 'mcp_notes',
    serverName: 'notes',
    host: 'notes.example',
    toolName: 'notes.search',
    bytes: 22,
    at: 1_700_000_000_000,
  },
};

beforeEach(() => {
  fake.reset();
  vi.clearAllMocks();
  script = [];
  signals = [];
  useModels.setState({
    loaded: true,
    activeModelId: QWEN.id,
    progress: {},
    storage: { used: 0, quota: 0 },
    installed: {
      [QWEN.id]: {
        id: QWEN.id,
        manifest: QWEN,
        state: 'installed',
        downloadedBytes: QWEN.sizeBytes,
        paths: { model: `/dev/${QWEN.id}` },
        sampler: { ...DEFAULT_SAMPLER },
        systemPrompt: '',
        installedAt: 1,
        lastUsedAt: null,
        useCount: 0,
      },
    },
  });
  useApp.setState({ toasts: [], connections: [], engine: scriptedEngine() as never });
});

/* ── The chat record ─────────────────────────────────────────────────── */

describe('a chat deleted while a write to it is waiting its turn', () => {
  it('does not come back into the table, the store, or the next launch', async () => {
    // Two writes to the chat: the first is being written, the second waits
    // behind it. The chat is deleted in between. The second write must not run
    // while the delete is still being carried out, find the chat still in the
    // store, and put it back after the delete.
    given(chat('queued', 1), chat('queued_other', 2));
    fake.hold('chats.put');
    fake.hold('deleteChat');
    const titling = useChats.getState().updateChat('queued', { title: 'Before' });
    await until(() => fake.pending('chats.put') === 1);

    const removing = useChats.getState().removeChat('queued');
    const pinning = useChats.getState().updateChat('queued', (current) => ({ pinned: !current.pinned }));
    const other = useChats.getState().updateChat('queued_other', { title: 'Kept' });
    await macrotask();

    fake.release('chats.put');
    await macrotask();
    await macrotask();
    fake.release('deleteChat');
    await Promise.all([titling, removing, pinning, other]);

    expect(fake.chats.has('queued'), 'the table').toBe(false);
    expect(inStore('queued'), 'the store').toBe(false);
    expect(await relaunch(), 'the next launch').toEqual(['queued_other']);
    // The control: a write to another chat, made meanwhile, lands.
    expect(fake.chats.get('queued_other')).toMatchObject({ title: 'Kept' });
  });

  it('does not come back when the write was already being written as it was deleted', async () => {
    // The paired control, and the order the report first described: this one
    // was never at risk, because its put was made before the delete was, and
    // the table applies them in that order.
    given(chat('in_flight', 1));
    fake.hold('chats.put');
    const titling = useChats.getState().updateChat('in_flight', { title: 'Before' });
    await until(() => fake.pending('chats.put') === 1);

    const removing = useChats.getState().removeChat('in_flight');
    await macrotask();
    fake.release('chats.put');
    await Promise.all([titling, removing]);

    expect(fake.chats.has('in_flight'), 'the table').toBe(false);
    expect(inStore('in_flight'), 'the store').toBe(false);
    expect(await relaunch()).toEqual([]);
  });

  it('is still deleted when a grant for it is being written', async () => {
    // A conversation answer is written with `void` from the policy, so the
    // person can delete the chat while it is queued.
    given(chat('granted', 1));
    fake.hold('chats.put');
    fake.hold('deleteChat');
    const renaming = useChats.getState().renameChat('granted', 'Renamed');
    await until(() => fake.pending('chats.put') === 1);

    const removing = useChats.getState().removeChat('granted');
    const granting = useChats.getState().grantEgress('granted', 'conn_openai');
    await macrotask();
    fake.release('chats.put');
    await macrotask();
    await macrotask();
    fake.release('deleteChat');
    await Promise.all([renaming, removing, granting]);

    expect(fake.chats.has('granted'), 'the table').toBe(false);
    expect(await relaunch()).toEqual([]);
  });

  it('is still written to when its delete fails', async () => {
    // The control for the other way round: a delete refused half-way — a full
    // disk — leaves the chat where it was, and what is written to it afterwards
    // lands, its message rows included.
    given(chat('refused', 1));
    const row: Message = { id: 'refused_user', chatId: 'refused', role: 'user', content: 'hello', createdAt: 1 };
    fake.messages.set(row.id, structuredClone(row));
    useChats.setState({ activeChatId: 'refused', messages: [row] });
    fake.deleteChat.mockImplementationOnce(async () => {
      throw new Error('The disk is full.');
    });

    await expect(useChats.getState().removeChat('refused')).rejects.toThrow('The disk is full.');
    expect(inStore('refused')).toBe(true);

    await useChats.getState().updateChat('refused', { title: 'Still here' });
    await useChats.getState().editMessage('refused_user', 'hello again');

    expect(fake.chats.get('refused')).toMatchObject({ title: 'Still here' });
    expect(fake.messages.get('refused_user')).toMatchObject({ content: 'hello again' });
  });
});

/* ── The chat's messages ─────────────────────────────────────────────── */

describe('a chat deleted while a turn is running in it', () => {
  it('gets no row back from the turn when it finishes', async () => {
    given(chat('turn', 1));
    useChats.setState({ activeChatId: 'turn' });
    const turn = held();
    script = [{ text: 'Here you go.', hang: turn.promise }];

    const sending = useChats.getState().send('my bank details are 1234');
    await until(() => useChats.getState().generating);
    await useChats.getState().removeChat('turn');
    expect(rowsFor('turn'), 'the delete took what was there').toEqual([]);

    turn.release();
    await sending;

    expect(rowsFor('turn'), 'the finished row').toEqual([]);
    expect(fake.chats.has('turn')).toBe(false);
    expect(await relaunch()).toEqual([]);
  });

  it('gets no row back from the receipt written mid-turn', async () => {
    // A receipt is written the moment its call returns (`runGeneration`'s
    // `tool` case), before the turn ends.
    given(chat('receipt', 1));
    useChats.setState({ activeChatId: 'receipt' });
    const beforeTool = held();
    const turn = held();
    let handled = false;
    script = [
      {
        text: 'Found it.',
        beforeTool: beforeTool.promise,
        tool: SENT,
        onToolHandled: () => {
          handled = true;
        },
        hang: turn.promise,
      },
    ];

    const sending = useChats.getState().send('look up my bank details');
    try {
      await until(() => useChats.getState().generating);
      await useChats.getState().removeChat('receipt');
      beforeTool.release();
      await until(() => handled);

      expect(rowsFor('receipt'), 'while the turn is still running').toEqual([]);
    } finally {
      beforeTool.release();
      turn.release();
      await sending;
    }
    expect(rowsFor('receipt'), 'once it has finished').toEqual([]);
  });

  it('still gets its rows when it is not the chat deleted', async () => {
    // The control: the turn writes as before when another chat goes.
    given(chat('running', 1), chat('gone', 2));
    useChats.setState({ activeChatId: 'running' });
    const turn = held();
    script = [{ text: 'Found it.', tool: SENT, hang: turn.promise }];

    const sending = useChats.getState().send('look up my bank details');
    await until(() => rowsFor('running').some((row) => (row as Message).streaming === true));
    await useChats.getState().removeChat('gone');
    turn.release();
    await sending;

    const rows = rowsFor('running') as Message[];
    expect(rows.map((row) => row.role)).toEqual(['user', 'assistant']);
    expect(rows[1]?.streaming).toBe(false);
    expect(rows[1]?.toolCalls?.[0]?.receipt).toEqual(SENT.receipt);
    expect(signals[0]?.aborted, 'nor is it stopped').toBe(false);
  });

  it('is stopped the moment the delete is asked for', async () => {
    // The row was the only thing the delete stopped. The turn went on, and
    // whatever it did next — a tool call to a server, a request to a provider —
    // was done for a conversation the person had deleted.
    given(chat('stopped', 1));
    useChats.setState({ activeChatId: 'stopped' });
    const turn = held();
    script = [{ text: 'Here you go.', hang: turn.promise }];

    const sending = useChats.getState().send('my bank details are 1234');
    let removing: Promise<void> = Promise.resolve();
    try {
      await until(() => signals.length === 1);
      removing = useChats.getState().removeChat('stopped');
      expect(signals[0]?.aborted, 'as the delete is asked for').toBe(true);
    } finally {
      turn.release();
      await Promise.all([removing, sending]);
    }
    expect(rowsFor('stopped')).toEqual([]);
  });

  it('sends no further MCP call, though the conversation had said yes to that server', async () => {
    // The real engine and a real MCP tool, whose server is a spy. The first call
    // is answered "for this conversation", and the person deletes the chat
    // while it is out. The model calls the server again.
    const probe = mcpProbe();
    given({ ...chat('mcp_turn', 1), tools: [probe.tool.id] });
    useChats.setState({ activeChatId: 'mcp_turn' });
    const engine = new ChatterangEngine({ resolver: probeResolver, fallbackBackendId: null });

    let removing: Promise<void> = Promise.resolve();
    probe.call.mockImplementationOnce(async () => {
      removing = useChats.getState().removeChat('mcp_turn');
      return { content: [{ type: 'text', text: 'filed' }] };
    });
    const asked: string[] = [];
    const original = useApp.getState().requestApproval;

    try {
      toolRegistry.register(probe.tool);
      engine.router.replace(QWEN.engine, recordingBackend([MCP_CALL, MCP_CALL, 'Done.']).adapter);
      useApp.setState({
        engine: engine as never,
        requestApproval: async (action: string, prompt?: ApprovalPrompt) => {
          asked.push(action);
          if (asked.length > 1) return false;
          prompt?.onExtended?.();
          return true;
        },
      });
      await useChats.getState().send('file my bank details');
      await removing;
    } finally {
      toolRegistry.unregister(probe.tool.id);
      useApp.setState({ requestApproval: original });
    }

    expect(probe.call, 'the arguments reached the server once, before the delete').toHaveBeenCalledOnce();
    expect(asked).toHaveLength(1);
    expect(fake.chats.has('mcp_turn')).toBe(false);
    expect(rowsFor('mcp_turn')).toEqual([]);
  });

  it.each(['opens another chat and edits a message there', 'only opens another chat'] as const)(
    'sends no further MCP call when, while the call is out, the person %s and then deletes it',
    async (how) => {
      // Editing a user message starts a turn without asking whether one is
      // running, and the edit button is on screen while one is. So the edit
      // starts a second turn, in the other chat, while the first is still
      // running. The store remembered only the turn started last, and deleting
      // the first chat stopped nothing: its model called the server again under
      // the conversation's yes. The control only opens the other chat.
      const edits = how === 'opens another chat and edits a message there';
      const id = edits ? 'two_turns' : 'one_turn';
      const other = `${id}_other`;
      const probe = mcpProbe();
      given({ ...chat(id, 1), tools: [probe.tool.id] }, chat(other, 2));
      for (const row of [
        { id: `${other}_user`, chatId: other, role: 'user', content: 'hello', createdAt: 1 },
        { id: `${other}_reply`, chatId: other, role: 'assistant', content: 'Hi.', createdAt: 2 },
      ] as Message[]) fake.messages.set(row.id, structuredClone(row));
      useChats.setState({ activeChatId: id });
      const engine = new ChatterangEngine({ resolver: probeResolver, fallbackBackendId: null });

      const stoppedAtDelete: boolean[] = [];
      let removing: Promise<void> = Promise.resolve();
      probe.call.mockImplementationOnce(async (_server, _name, _args, signal) => {
        await useChats.getState().openChat(other);
        if (edits) await useChats.getState().editMessage(`${other}_user`, 'hello again');
        removing = useChats.getState().removeChat(id);
        stoppedAtDelete.push(signal?.aborted ?? false);
        return { content: [{ type: 'text', text: 'filed' }] };
      });
      const asked: string[] = [];
      const original = useApp.getState().requestApproval;
      // Requests in order: the first chat's, the edited chat's whole turn, then
      // the first chat's next call and its last reply.
      const backend = recordingBackend(edits ? [MCP_CALL, 'Edited reply.', MCP_CALL, 'Done.'] : [MCP_CALL, MCP_CALL, 'Done.']);

      try {
        toolRegistry.register(probe.tool);
        engine.router.replace(QWEN.engine, backend.adapter);
        useApp.setState({
          engine: engine as never,
          requestApproval: async (action: string, prompt?: ApprovalPrompt) => {
            asked.push(action);
            if (asked.length > 1) return false;
            prompt?.onExtended?.();
            return true;
          },
        });
        await useChats.getState().send('file my bank details');
        await removing;
      } finally {
        toolRegistry.unregister(probe.tool.id);
        useApp.setState({ requestApproval: original });
      }

      expect(stoppedAtDelete, 'the first chat’s turn, as the delete is asked for').toEqual([true]);
      expect(probe.call, 'the arguments reached the server once, before the delete').toHaveBeenCalledOnce();
      expect(fake.chats.has(id)).toBe(false);
      expect(rowsFor(id)).toEqual([]);
      if (edits) {
        // The other chat's turn is not the one deleted, and ran to its end.
        expect((rowsFor(other) as Message[]).map((row) => row.content)).toEqual(['hello again', 'Edited reply.']);
      }
    },
  );

  it.each(['deleted', 'only stopped'] as const)(
    'takes down the MCP send sheet its turn waits on when the chat is %s, and writes the not-sent record only for a chat still there',
    async (how) => {
      // The real engine, the real store policy and the real approval queue. A
      // call waits on its send sheet. Deleting the chat stops the turn, and a
      // stopped turn takes that sheet down and records the call as not sent
      // (#92). That record is a message row like any other: for a deleted chat
      // it must not be written back. The control is Stop on a chat nothing
      // deletes, which shows the record does reach the table otherwise.
      const id = how === 'deleted' ? 'sheet_deleted' : 'sheet_stopped';
      const probe = mcpProbe();
      given({ ...chat(id, 1), tools: [probe.tool.id] });
      useChats.setState({ activeChatId: id });
      const engine = new ChatterangEngine({ resolver: probeResolver, fallbackBackendId: null });

      let removing: Promise<void> = Promise.resolve();
      let sending: Promise<void> = Promise.resolve();
      // Read before the cleanup below answers whatever is still up, which would
      // empty the list whether or not the delete or Stop took the sheet down.
      let sheetsOnceSettled: number | undefined;
      try {
        toolRegistry.register(probe.tool);
        engine.router.replace(QWEN.engine, recordingBackend([MCP_CALL, 'Done.']).adapter);
        useApp.setState({ engine: engine as never, approvals: [] });
        sending = useChats.getState().send('file my bank details');
        await until(() => useApp.getState().approvals.length === 1);

        if (how === 'deleted') removing = useChats.getState().removeChat(id);
        else useChats.getState().stop();
        await Promise.all([removing, sending]);
        sheetsOnceSettled = useApp.getState().approvals.length;
      } finally {
        for (const approval of useApp.getState().approvals) useApp.getState().answerApproval(approval.id, false);
        await Promise.all([removing, sending]);
        toolRegistry.unregister(probe.tool.id);
      }

      expect(sheetsOnceSettled, 'the sheet is taken down').toBe(0);
      expect(probe.call, 'nothing left for the call').not.toHaveBeenCalled();
      if (how === 'deleted') {
        expect(rowsFor(id), 'no row carries the not-sent record back').toEqual([]);
        expect(fake.chats.has(id)).toBe(false);
        expect(await relaunch()).toEqual([]);
      } else {
        const rows = rowsFor(id) as Message[];
        expect(rows.map((row) => row.role)).toEqual(['user', 'assistant']);
        expect(rows[1]?.streaming).toBe(false);
        expect(rows[1]?.toolCalls?.[0]?.receipt).toMatchObject({
          outcome: 'withheld',
          why: 'stopped',
          host: 'notes.example',
        });
      }
    },
  );

  it.each(['fails', 'lands'] as const)(
    'keeps the record that a call went when the delete asked for while it was out %s',
    async (how) => {
      // The real engine and a real MCP tool whose server is a spy. The chat is
      // deleted while the call is out, and the delete is held until the turn
      // has ended. A delete that fails — a full disk — leaves the chat, and the
      // thread on screen shows the call went. The rows refused while the delete
      // ran were dropped for good, so the table had no record of it: reopening
      // or exporting the chat said nothing had been sent. The control is the
      // same delete landing, which leaves no row.
      const id = how === 'fails' ? 'record_refused' : 'record_deleted';
      const probe = mcpProbe();
      given({ ...chat(id, 1), tools: [probe.tool.id] });
      useChats.setState({ activeChatId: id });
      const engine = new ChatterangEngine({ resolver: probeResolver, fallbackBackendId: null });
      const deleting = held();
      fake.deleteChat.mockImplementationOnce(async (chatId: string) => {
        await deleting.promise;
        if (how === 'fails') throw new Error('The disk is full.');
        for (const row of [...fake.messages.values()]) if (row.chatId === chatId) fake.messages.delete(row.id);
        fake.chats.delete(chatId);
      });
      let removing: Promise<void> = Promise.resolve();
      probe.call.mockImplementationOnce(async () => {
        removing = useChats.getState().removeChat(id);
        return { content: [{ type: 'text', text: 'filed' }] };
      });
      const original = useApp.getState().requestApproval;
      let sending: Promise<void> = Promise.resolve();
      try {
        toolRegistry.register(probe.tool);
        engine.router.replace(QWEN.engine, recordingBackend([MCP_CALL, 'Done.']).adapter);
        useApp.setState({ engine: engine as never, requestApproval: async () => true });
        sending = useChats.getState().send('file my bank details');
        await until(() =>
          useChats.getState().messages.some((message) => message.role === 'assistant' && message.streaming === false),
        );
        deleting.release();
        if (how === 'fails') await expect(removing).rejects.toThrow('The disk is full.');
        else await removing;
        await sending;
      } finally {
        deleting.release();
        toolRegistry.unregister(probe.tool.id);
        useApp.setState({ requestApproval: original });
      }

      expect(probe.call, 'the arguments went').toHaveBeenCalledOnce();
      if (how === 'lands') {
        expect(rowsFor(id)).toEqual([]);
        expect(await relaunch()).toEqual([]);
        return;
      }
      expect(inStore(id), 'the chat is still there').toBe(true);
      const outcomes = (thread: readonly Message[]): (string | undefined)[] =>
        thread.flatMap((message) => message.toolCalls ?? []).map((call) => call.receipt?.outcome);
      expect(outcomes(useChats.getState().messages), 'the thread on screen shows the call').toContain('sent');
      const onDisk = (rowsFor(id) as Message[]).sort((a, b) => a.createdAt - b.createdAt);
      expect(outcomes(onDisk), 'and the table keeps its record').toContain('sent');
      expect(
        onDisk.map((row) => ({ id: row.id, streaming: row.streaming ?? false, error: row.error })),
        'the rows on disk are the thread on screen',
      ).toEqual(
        useChats
          .getState()
          .messages.map((row) => ({ id: row.id, streaming: row.streaming ?? false, error: row.error })),
      );
    },
  );

  it('does not hand the turn to the engine when the delete is asked for while its prompt is being built', async () => {
    // An image in the thread is read back from its payload while the prompt is
    // built. A stopped signal handed to the engine still lets it raise a sheet
    // for a remote model before any request is made.
    given(chat('building', 1));
    const earlier: Message = {
      id: 'building_image',
      chatId: 'building',
      role: 'user',
      content: 'look at this',
      attachments: [{ kind: 'image', id: 'att_building', mediaType: 'image/png', bytes: 3 }],
      createdAt: 1,
    };
    const reply: Message = { id: 'building_reply', chatId: 'building', role: 'assistant', content: 'A cat.', createdAt: 2 };
    for (const row of [earlier, reply]) fake.messages.set(row.id, structuredClone(row));
    fake.blobs.set('att_building', { id: 'att_building' });
    useChats.setState({ activeChatId: 'building', messages: [earlier, reply] });
    script = [{ text: 'Here you go.' }];
    fake.hold('blobs.get');

    const sending = useChats.getState().send('and this one?');
    await until(() => fake.pending('blobs.get') === 1);
    const removing = useChats.getState().removeChat('building');
    fake.release('blobs.get');
    await Promise.all([removing, sending]);

    expect(signals, 'no turn reached the engine').toEqual([]);
    expect(rowsFor('building')).toEqual([]);
  });

  it('gets no row back from a turn that finishes while the delete is still being carried out', async () => {
    given(chat('finishing', 1));
    useChats.setState({ activeChatId: 'finishing' });
    const turn = held();
    script = [{ text: 'Here you go.', hang: turn.promise }];

    const sending = useChats.getState().send('my bank details are 1234');
    await until(() => useChats.getState().generating);
    fake.hold('deleteChat');
    const removing = useChats.getState().removeChat('finishing');
    await until(() => fake.pending('deleteChat') === 1);

    turn.release();
    // The finished row has been written, or refused, while the delete is held.
    await until(() =>
      useChats.getState().messages.some((message) => message.role === 'assistant' && message.streaming === false),
    );
    fake.release('deleteChat');
    // Not `sending` first: the turn's closing count waits behind the delete.
    await Promise.all([removing, sending]);

    expect(rowsFor('finishing'), 'the finished row').toEqual([]);
  });

  it.each(['an error from the model', 'a stream that throws'] as const)(
    'gets no row back from a turn that ends in %s',
    async (how) => {
      const id = how === 'an error from the model' ? 'errored' : 'thrown';
      given(chat(id, 1));
      useChats.setState({ activeChatId: id });
      const turn = held();
      useApp.setState({
        engine: {
          async *stream() {
            await turn.promise;
            if (how === 'a stream that throws') throw new Error('The socket closed.');
            yield { type: 'error', message: 'The model stopped.' };
          },
        } as never,
      });

      const sending = useChats.getState().send('my bank details are 1234');
      await until(() => useChats.getState().generating);
      await useChats.getState().removeChat(id);
      turn.release();
      await sending;

      expect(rowsFor(id), 'the failed row').toEqual([]);
    },
  );
});

describe('a chat deleted while something is written to its thread', () => {
  /**
   * A chat that is open, with its delete asked for and held part-way. Wrapped,
   * because a promise returned from an async function is waited on.
   */
  async function deleting(id: string, thread: Message[] = []): Promise<{ removing: Promise<void> }> {
    given(chat(id, 1));
    for (const row of thread) fake.messages.set(row.id, structuredClone(row));
    useChats.setState({ activeChatId: id, messages: thread });
    fake.hold('deleteChat');
    const removing = useChats.getState().removeChat(id);
    await until(() => fake.pending('deleteChat') === 1);
    // Still listed, and still the open chat, until the delete has landed.
    expect(inStore(id)).toBe(true);
    return { removing };
  }

  it('gets no row from a message sent meanwhile, and starts no turn', async () => {
    const { removing } = await deleting('sent_during');

    const sending = useChats.getState().send('hello');
    await macrotask();
    fake.release('deleteChat');
    await Promise.all([removing, sending]);

    expect(rowsFor('sent_during')).toEqual([]);
    expect(signals).toEqual([]);
  });

  it('keeps none of that message’s attachments on the device', async () => {
    // The composer writes an image's payload when it is attached, before any
    // message names it. The delete takes the payloads its rows name, and the
    // row that would have named this one was never written.
    const { removing } = await deleting('attached_during');
    fake.blobs.set('att_during', { id: 'att_during' });

    const sending = useChats
      .getState()
      .send('look at this', [{ kind: 'image', id: 'att_during', mediaType: 'image/png', bytes: 3 }]);
    await macrotask();
    fake.release('deleteChat');
    await Promise.all([removing, sending]);

    expect(rowsFor('attached_during')).toEqual([]);
    expect(fake.blobs.has('att_during'), 'the image').toBe(false);
  });

  it.each(['an edit', 'a flip to the other reply'] as const)(
    'gets no row back from %s made meanwhile',
    async (what) => {
      const id = what === 'an edit' ? 'edited_during' : 'flipped_during';
      const { removing } = await deleting(id, [
        { id: `${id}_user`, chatId: id, role: 'user', content: 'hello', createdAt: 1 },
        {
          id: `${id}_reply`,
          chatId: id,
          role: 'assistant',
          content: 'Second.',
          createdAt: 2,
          variants: [{ content: 'First.' }, { content: 'Second.' }],
          variantIndex: 1,
        },
      ]);

      const writing =
        what === 'an edit'
          ? useChats.getState().editMessage(`${id}_reply`, 'Changed.')
          : useChats.getState().cycleVariant(`${id}_reply`, -1);
      await macrotask();
      fake.release('deleteChat');
      await Promise.all([removing, writing]);

      expect(rowsFor(id)).toEqual([]);
    },
  );

  it('keeps the attachment of a row its chat still has when the delete fails', async () => {
    // The control for the payload: only once the delete has landed is a payload
    // left over from a refused row taken. A chat whose delete was refused still
    // shows this image.
    given(chat('kept_image', 1));
    const row: Message = {
      id: 'kept_image_user',
      chatId: 'kept_image',
      role: 'user',
      content: 'look',
      attachments: [{ kind: 'image', id: 'att_kept', mediaType: 'image/png', bytes: 3 }],
      createdAt: 1,
    };
    fake.messages.set(row.id, structuredClone(row));
    fake.blobs.set('att_kept', { id: 'att_kept' });
    useChats.setState({ activeChatId: 'kept_image', messages: [row] });
    const refusing = held();
    fake.deleteChat.mockImplementationOnce(async () => {
      await refusing.promise;
      throw new Error('The disk is full.');
    });

    const removing = useChats.getState().removeChat('kept_image');
    await until(() => fake.deleteChat.mock.calls.length === 1);
    const editing = useChats.getState().editMessage('kept_image_user', 'look again');
    await macrotask();
    refusing.release();
    await expect(removing).rejects.toThrow('The disk is full.');
    await editing;

    expect(inStore('kept_image')).toBe(true);
    expect(fake.messages.has('kept_image_user')).toBe(true);
    expect(fake.blobs.has('att_kept'), 'its image').toBe(true);
  });

  it('does not write back, when the delete fails, a refused row the person deleted meanwhile', async () => {
    // A delete that fails writes the rows it refused while it ran. A row the
    // person then deleted is not one of them: here a flip is refused, and the
    // reply it flipped is deleted before the delete fails.
    given(chat('dropped_row', 1));
    const thread: Message[] = [
      { id: 'dropped_row_user', chatId: 'dropped_row', role: 'user', content: 'hello', createdAt: 1 },
      {
        id: 'dropped_row_reply',
        chatId: 'dropped_row',
        role: 'assistant',
        content: 'Second.',
        createdAt: 2,
        variants: [{ content: 'First.' }, { content: 'Second.' }],
        variantIndex: 1,
      },
    ];
    for (const row of thread) fake.messages.set(row.id, structuredClone(row));
    useChats.setState({ activeChatId: 'dropped_row', messages: thread });
    const refusing = held();
    fake.deleteChat.mockImplementationOnce(async () => {
      await refusing.promise;
      throw new Error('The disk is full.');
    });

    const removing = useChats.getState().removeChat('dropped_row');
    try {
      await until(() => fake.deleteChat.mock.calls.length === 1);
      await useChats.getState().cycleVariant('dropped_row_reply', -1);
      await useChats.getState().deleteMessage('dropped_row_reply');
    } finally {
      refusing.release();
    }
    await expect(removing).rejects.toThrow('The disk is full.');

    expect(inStore('dropped_row')).toBe(true);
    expect(fake.messages.has('dropped_row_reply'), 'the reply deleted meanwhile').toBe(false);
    expect(rowsFor('dropped_row').map((row) => row.id)).toEqual(['dropped_row_user']);
  });

  it('does not start a turn asked for after the delete, while an earlier write still holds its turn', async () => {
    given(chat('queued_turn', 1));
    const thread: Message[] = [
      { id: 'queued_turn_user', chatId: 'queued_turn', role: 'user', content: 'hello', createdAt: 1 },
      { id: 'queued_turn_reply', chatId: 'queued_turn', role: 'assistant', content: 'Hi.', createdAt: 2 },
    ];
    for (const row of thread) fake.messages.set(row.id, structuredClone(row));
    useChats.setState({ activeChatId: 'queued_turn', messages: thread });
    script = [{ text: 'Hi again.' }];
    fake.hold('chats.put');

    const renaming = useChats.getState().renameChat('queued_turn', 'Renamed');
    await until(() => fake.pending('chats.put') === 1);
    const removing = useChats.getState().removeChat('queued_turn');
    const regenerating = useChats.getState().regenerate('queued_turn_reply');
    await macrotask();
    expect(signals, 'while the rename is still being written').toEqual([]);
    // Nor put on screen: no reply being written appears in a chat going away.
    expect(useChats.getState().messages.map((message) => message.id)).toEqual(['queued_turn_user']);
    expect(useChats.getState().generating).toBe(false);

    fake.release('chats.put');
    await Promise.all([renaming, removing, regenerating]);

    expect(signals).toEqual([]);
    expect(fake.chats.has('queued_turn')).toBe(false);
    expect(rowsFor('queued_turn')).toEqual([]);
  });
});

describe('a chat deleted while it is being opened', () => {
  /** A thread whose last turn was interrupted while it ran. */
  function interruptedThread(chatId: string): Message[] {
    return [
      { id: `${chatId}_user`, chatId, role: 'user', content: 'hello', createdAt: 1 },
      {
        id: `${chatId}_stale`,
        chatId,
        role: 'assistant',
        content: 'Looking that up',
        createdAt: 2,
        streaming: true,
        toolCalls: [SENT],
      },
    ];
  }

  it('does not get its interrupted row written back, nor become the open thread', async () => {
    // `openChat` reads the thread, then writes an interrupted row back as the
    // failed turn it is. A delete that lands between the two must win.
    given(chat('opened', 1), chat('opened_other', 2));
    for (const row of interruptedThread('opened')) fake.messages.set(row.id, structuredClone(row));
    fake.hold('messages.read');

    const opening = useChats.getState().openChat('opened');
    await until(() => fake.pending('messages.read') === 1);
    await useChats.getState().removeChat('opened');
    fake.release('messages.read');
    await opening;

    expect(rowsFor('opened'), 'the table').toEqual([]);
    expect(useChats.getState().activeChatId).not.toBe('opened');
    expect(useChats.getState().messages).toEqual([]);
  });

  it('recovers the interrupted row when nothing deletes it', async () => {
    // The control.
    given(chat('recovered', 1));
    for (const row of interruptedThread('recovered')) fake.messages.set(row.id, structuredClone(row));

    await useChats.getState().openChat('recovered');

    expect(useChats.getState().activeChatId).toBe('recovered');
    expect(fake.messages.get('recovered_stale')).toMatchObject({ streaming: false });
  });
});

/* ── Loading the list ────────────────────────────────────────────────── */

describe('loading the chat list', () => {
  it('keeps a chat started while it was being read', async () => {
    // The app renders the chat screen once the engine is ready and loads the
    // chats after, so ⌘N — registered by the screen — can start a chat while
    // the list is still being read. The read was taken before the chat was
    // written, and replacing the store with it dropped the chat the screen had
    // just opened: a thread nothing could be sent to.
    fake.chats.set('on_disk', structuredClone(chat('on_disk', 1)));
    useChats.setState({ loaded: false, chats: [], activeChatId: null, messages: [] });
    fake.hold('chats.read');

    const loading = useChats.getState().load();
    await until(() => fake.pending('chats.read') === 1);
    const id = await useChats.getState().newChat();
    fake.release('chats.read');
    await loading;

    const ids = useChats.getState().chats.map((entry) => entry.id);
    expect(ids).toContain(id);
    expect(ids, 'and the chats that were on disk').toContain('on_disk');
    expect(useChats.getState().activeChatId).toBe(id);
  });

  it('does not bring back a chat deleted while it was being read', async () => {
    // Not reachable at launch today — the list is read once, before any chat
    // it holds is on screen to delete — but a load that keeps what the store
    // already has must not read a missing chat as one it has not seen yet.
    given(chat('listed_gone', 1), chat('listed_kept', 2));
    fake.hold('chats.read');

    const loading = useChats.getState().load();
    await until(() => fake.pending('chats.read') === 1);
    await useChats.getState().removeChat('listed_gone');
    fake.release('chats.read');
    await loading;

    expect(inStore('listed_gone')).toBe(false);
    expect(inStore('listed_kept')).toBe(true);
  });
});
