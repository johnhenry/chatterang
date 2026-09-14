import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * STOP STOPS EVERY TURN, AND A SECOND TURN DOES NOT START.
 *
 * `send` and `regenerate` refuse while `generating` is true. `editMessage`
 * started a turn without asking, and the edit button is on screen while a turn
 * runs, so two turns could run at once. `stop()` aborted the controller of the
 * turn started LAST, and that turn's `finally` set `generating` false while the
 * first still ran: the composer offered Send instead of Stop, and nothing on
 * screen could stop a turn that kept streaming, running tools and handing MCP
 * arguments to servers.
 *
 * `generating` is one flag for the whole app, not one per chat, and the
 * composer shows Stop in whatever chat is open while it is set, so the rule
 * here is app-wide: one turn at a time, and Stop stops every turn there is.
 *
 * The database is held in memory at the table boundary, as in
 * chat-removal.test.ts. Every test uses chat ids of its own.
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
  const blobs = new Map<string, Row>();
  const holding = new Set<string>();
  const waiting = new Map<string, (() => void)[]>();
  const clone = <T>(value: T): T => structuredClone(value);

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
      }),
      delete: vi.fn(async (id: string) => {
        chats.delete(id);
      }),
      orderBy: () => ({
        reverse: () => ({
          toArray: async () => [...chats.values()].map(clone),
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
          sortBy: async () => threadOf(chatId),
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

  const deleteChat = vi.fn(async (chatId: string) => {
    for (const row of [...messages.values()]) if (row.chatId === chatId) messages.delete(row.id);
    chats.delete(chatId);
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

const QWEN = catalogEntry('qwen3-4b-instruct-q4km')!;

function chat(id: string, updatedAt: number, tools: string[] = []): Chat {
  return {
    id,
    title: id,
    mode: 'chat',
    personaId: null,
    modelId: QWEN.id,
    sampler: null,
    tools,
    showThinking: false,
    createdAt: updatedAt,
    updatedAt,
    messageCount: 2,
    preview: '',
  };
}

/** A thread with one exchange in it: the user message is the one a person edits. */
function exchange(chatId: string): Message[] {
  return [
    { id: `${chatId}_user`, chatId, role: 'user', content: 'hello', createdAt: 1 },
    { id: `${chatId}_reply`, chatId, role: 'assistant', content: 'Hi.', createdAt: 2 },
  ];
}

/** Chats in the store and the table, each with its exchange on disk; the first is open. */
function given(...chats: Chat[]): void {
  for (const entry of chats) {
    fake.chats.set(entry.id, structuredClone(entry));
    for (const row of exchange(entry.id)) fake.messages.set(row.id, structuredClone(row));
  }
  useChats.setState({
    loaded: true,
    chats,
    activeChatId: chats[0]?.id ?? null,
    messages: chats[0] ? exchange(chats[0].id) : [],
    generating: false,
    context: null,
  });
}

const rowsFor = (chatId: string): Message[] =>
  ([...fake.messages.values()] as Message[]).filter((row) => row.chatId === chatId);
const macrotask = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

async function until(condition: () => boolean): Promise<void> {
  for (let tries = 0; tries < 200; tries += 1) {
    if (condition()) return;
    await macrotask();
  }
  throw new Error('the condition never held');
}

/** Wait until `promise` has settled or `condition` holds, whichever is first. */
async function settledOr(promise: Promise<unknown>, condition: () => boolean): Promise<void> {
  let settled = false;
  void promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await until(() => settled || condition());
}

function held(): { promise: Promise<void>; release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

/* ── A scripted turn ─────────────────────────────────────────────────── */

interface Turn {
  readonly text: string;
  readonly hang?: Promise<void>;
}

let script: Turn[] = [];
/** The signal each turn handed to the engine was given, in order. */
let signals: (AbortSignal | undefined)[] = [];

/** The engine, replaced by a recorder that ignores its signal. */
function scriptedEngine(): unknown {
  return {
    async *stream(request: { signal?: AbortSignal }) {
      signals.push(request.signal);
      const turn = script.shift();
      if (!turn) throw new Error('the script ran out of turns');
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

const WHERE = ['the same chat', 'another chat opened meanwhile'] as const;
type Where = (typeof WHERE)[number];

/** The chat whose message is edited while the first chat's turn runs, opened if it is another. */
async function editTarget(where: Where, id: string): Promise<string> {
  if (where === 'the same chat') return id;
  await useChats.getState().openChat(`${id}_other`);
  return `${id}_other`;
}

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
  useApp.setState({ toasts: [], approvals: [], connections: [], engine: scriptedEngine() as never });
});

/* ── One turn at a time ─────────────────────────────────────────────── */

describe('a turn asked for while one is running', () => {
  it.each(WHERE)('is not started by editing a message in %s', async (where) => {
    const id = where === 'the same chat' ? 'edit_same' : 'edit_other';
    given(chat(id, 1), chat(`${id}_other`, 2));
    const first = held();
    const second = held();
    script = [
      { text: 'Filed.', hang: first.promise },
      { text: 'Edited reply.', hang: second.promise },
    ];

    const sending = useChats.getState().send('file my bank details');
    let editing: Promise<void> = Promise.resolve();
    try {
      await until(() => signals.length === 1);
      const target = await editTarget(where, id);
      editing = useChats.getState().editMessage(`${target}_user`, 'hello again');
      await settledOr(editing, () => signals.length === 2);

      expect(signals, 'turns handed to the engine').toHaveLength(1);
      // Refused whole, as `send` is: not half-applied with its reply discarded.
      expect(fake.messages.get(`${target}_user`)).toMatchObject({ content: 'hello' });
      expect(rowsFor(target).map((row) => row.id)).toEqual(expect.arrayContaining([`${target}_reply`]));
    } finally {
      useChats.getState().stop();
      first.release();
      second.release();
      await Promise.all([sending, editing]);
    }
  });

  it('is not started by a second send made before the first has started its turn', async () => {
    // `send` asked `generating`, then wrote the message and the chat before the
    // turn set it, so a second send made meanwhile passed the same check.
    given(chat('double_send', 1));
    script = [{ text: 'One.' }, { text: 'Two.' }];

    const first = useChats.getState().send('one');
    const second = useChats.getState().send('two');
    await Promise.all([first, second]);

    expect(signals, 'turns handed to the engine').toHaveLength(1);
    expect(
      rowsFor('double_send')
        .filter((row) => row.role === 'user')
        .map((row) => row.content),
    ).toEqual(['hello', 'one']);
    expect(useChats.getState().generating).toBe(false);
  });

  it('is not started from the thread of another chat opened while the edit is being written', async () => {
    // A turn is built from the thread on screen, and ran in whichever chat was
    // open once the edit had been written. Opened meanwhile, that was another
    // conversation, given a reply built from the edited one's thread.
    given(chat('edit_moved', 1), chat('edit_moved_other', 2));
    script = [{ text: 'Edited reply.' }];
    fake.hold('messages.put');

    const editing = useChats.getState().editMessage('edit_moved_user', 'hello again');
    try {
      await until(() => fake.pending('messages.put') === 1);
      await useChats.getState().openChat('edit_moved_other');
    } finally {
      fake.release('messages.put');
    }
    await editing;

    expect(signals, 'turns handed to the engine').toHaveLength(0);
    expect(useChats.getState().activeChatId).toBe('edit_moved_other');
    expect(
      useChats.getState().messages.map((message) => message.id),
      'the thread on screen is the chat that was opened',
    ).toEqual(['edit_moved_other_user', 'edit_moved_other_reply']);
    expect(rowsFor('edit_moved_other').map((row) => row.id)).toEqual(['edit_moved_other_user', 'edit_moved_other_reply']);
    expect(useChats.getState().generating).toBe(false);
    expect(fake.messages.get('edit_moved_user'), 'the edit itself is written').toMatchObject({ content: 'hello again' });
  });

  it('is not started by regenerating a reply (the control)', async () => {
    given(chat('regen_control', 1));
    const first = held();
    script = [{ text: 'Filed.', hang: first.promise }, { text: 'Again.' }];

    const sending = useChats.getState().send('file my bank details');
    try {
      await until(() => signals.length === 1);
      await useChats.getState().regenerate('regen_control_reply');
      expect(signals).toHaveLength(1);
    } finally {
      useChats.getState().stop();
      first.release();
      await sending;
    }
  });
});

/* ── Stop ───────────────────────────────────────────────────────────── */

describe('Stop', () => {
  it.each(WHERE)('aborts every turn handed to the engine, after an edit in %s', async (where) => {
    const id = where === 'the same chat' ? 'stop_same' : 'stop_other';
    given(chat(id, 1), chat(`${id}_other`, 2));
    const first = held();
    const second = held();
    script = [
      { text: 'Filed.', hang: first.promise },
      { text: 'Edited reply.', hang: second.promise },
    ];

    const sending = useChats.getState().send('file my bank details');
    let editing: Promise<void> = Promise.resolve();
    try {
      await until(() => signals.length === 1);
      const target = await editTarget(where, id);
      editing = useChats.getState().editMessage(`${target}_user`, 'hello again');
      await settledOr(editing, () => signals.length === 2);

      useChats.getState().stop();

      expect(
        signals.map((signal) => signal?.aborted),
        'each turn’s signal, as Stop is pressed',
      ).toEqual(signals.map(() => true));
    } finally {
      useChats.getState().stop();
      first.release();
      second.release();
      await Promise.all([sending, editing]);
    }
    expect(useChats.getState().generating).toBe(false);
  });

  it('leaves `generating` set while a turn is still running', async () => {
    // A second turn that ended cleared `generating` while the first still ran:
    // the composer offered Send, and Stop was gone from the screen.
    given(chat('still_running', 1));
    const first = held();
    script = [{ text: 'Filed.', hang: first.promise }, { text: 'Edited reply.' }];

    const sending = useChats.getState().send('file my bank details');
    try {
      await until(() => signals.length === 1);
      await useChats.getState().editMessage('still_running_user', 'hello again');

      expect(useChats.getState().generating, 'the first turn is still running').toBe(true);
      useChats.getState().stop();
      expect(signals[0]?.aborted, 'and Stop still reaches it').toBe(true);
    } finally {
      useChats.getState().stop();
      first.release();
      await sending;
    }
    expect(useChats.getState().generating, 'once the last turn has settled').toBe(false);
  });

  it.each(WHERE)(
    'lets no provider request or MCP call out of any turn afterwards, after an edit in %s',
    async (where) => {
      // The real engine and a real MCP tool whose server is a spy. The model
      // calls the tool on every request, and each call is held out until the
      // test lets it return. A turn nothing stops keeps asking the model and
      // calling the server.
      const id = where === 'the same chat' ? 'leak_same' : 'leak_other';
      const probe = mcpProbe();
      given(chat(id, 1, [probe.tool.id]), chat(`${id}_other`, 2, [probe.tool.id]));
      const engine = new ChatterangEngine({ resolver: probeResolver, fallbackBackendId: null });
      const backend = recordingBackend([MCP_CALL]);
      const out = held();
      const callSignals: (AbortSignal | undefined)[] = [];
      probe.call.mockImplementation(async (_server, _name, _args, signal) => {
        callSignals.push(signal);
        await out.promise;
        return { content: [{ type: 'text', text: 'filed' }] };
      });
      const original = useApp.getState().requestApproval;

      let sending: Promise<void> = Promise.resolve();
      let editing: Promise<void> = Promise.resolve();
      let requestsAtStop = -1;
      let callsAtStop = -1;
      try {
        toolRegistry.register(probe.tool);
        engine.router.replace(QWEN.engine, backend.adapter);
        useApp.setState({ engine: engine as never, requestApproval: async () => true });

        sending = useChats.getState().send('file my bank details');
        await until(() => probe.call.mock.calls.length === 1);
        const target = await editTarget(where, id);
        editing = useChats.getState().editMessage(`${target}_user`, 'hello again');
        await settledOr(editing, () => probe.call.mock.calls.length === 2);

        requestsAtStop = backend.seen.length;
        callsAtStop = probe.call.mock.calls.length;
        useChats.getState().stop();
        out.release();
        await Promise.all([sending, editing]);
      } finally {
        useChats.getState().stop();
        out.release();
        await Promise.all([sending, editing]);
        toolRegistry.unregister(probe.tool.id);
        useApp.setState({ requestApproval: original });
      }

      expect(backend.seen, 'provider requests after Stop').toHaveLength(requestsAtStop);
      expect(probe.call, 'MCP calls after Stop').toHaveBeenCalledTimes(callsAtStop);
      expect(
        callSignals.map((signal) => signal?.aborted),
        'every call out when Stop was pressed was told',
      ).toEqual(callSignals.map(() => true));
      expect(useChats.getState().generating).toBe(false);
    },
  );

  it('takes down every MCP send sheet a turn waits on, and records each call as not sent (#292)', async () => {
    // The real engine, the real store policy and the real approval queue.
    const probe = mcpProbe();
    given(chat('sheets', 1, [probe.tool.id]));
    const engine = new ChatterangEngine({ resolver: probeResolver, fallbackBackendId: null });
    const backend = recordingBackend([MCP_CALL]);

    let sending: Promise<void> = Promise.resolve();
    let editing: Promise<void> = Promise.resolve();
    let sheetsAfterStop: number | undefined;
    try {
      toolRegistry.register(probe.tool);
      engine.router.replace(QWEN.engine, backend.adapter);
      useApp.setState({ engine: engine as never, approvals: [] });

      sending = useChats.getState().send('file my bank details');
      await until(() => useApp.getState().approvals.length === 1);
      editing = useChats.getState().editMessage('sheets_user', 'hello again');
      await settledOr(editing, () => useApp.getState().approvals.length === 2);

      useChats.getState().stop();
      await settledOr(Promise.all([sending, editing]), () => false).catch(() => {});
      sheetsAfterStop = useApp.getState().approvals.length;
    } finally {
      // Read above, before this answers whatever is still up. A turn nothing
      // stopped asks again after each no, until it runs out of tool rounds.
      let settled = false;
      void Promise.all([sending, editing]).then(() => {
        settled = true;
      });
      for (let rounds = 0; rounds < 50 && !settled; rounds += 1) {
        for (const approval of useApp.getState().approvals) useApp.getState().answerApproval(approval.id, false);
        await macrotask();
      }
      await Promise.all([sending, editing]);
      toolRegistry.unregister(probe.tool.id);
    }

    expect(sheetsAfterStop, 'sheets still up after Stop').toBe(0);
    expect(probe.call, 'nothing left for any call').not.toHaveBeenCalled();
    const replies = rowsFor('sheets').filter((row) => row.role === 'assistant' && !row.streaming && row.toolCalls);
    expect(replies.length, 'a stopped turn’s row').toBeGreaterThan(0);
    for (const reply of replies) {
      expect(reply.toolCalls?.[0]?.receipt).toMatchObject({ outcome: 'withheld', why: 'stopped', host: 'notes.example' });
    }
  });

  it('sends no provider request for a turn stopped while its prompt is being built', async () => {
    // An image in the thread is read back from its payload while the prompt is
    // built, and `generating` is already set: Stop is on screen.
    given(chat('building', 1));
    const image: Message = {
      id: 'building_image',
      chatId: 'building',
      role: 'user',
      content: 'look at this',
      attachments: [{ kind: 'image', id: 'att_building', mediaType: 'image/png', bytes: 3 }],
      createdAt: 3,
    };
    fake.messages.set(image.id, structuredClone(image));
    fake.blobs.set('att_building', { id: 'att_building' });
    useChats.setState({ messages: [...exchange('building'), image] });
    const engine = new ChatterangEngine({ resolver: probeResolver, fallbackBackendId: null });
    const backend = recordingBackend(['Here you go.']);
    engine.router.replace(QWEN.engine, backend.adapter);
    useApp.setState({ engine: engine as never });
    fake.hold('blobs.get');

    const sending = useChats.getState().send('and this one?');
    try {
      await until(() => fake.pending('blobs.get') === 1);
      expect(useChats.getState().generating, 'Stop is on screen').toBe(true);
      useChats.getState().stop();
    } finally {
      fake.release('blobs.get');
      await sending;
    }

    expect(backend.seen, 'provider requests').toHaveLength(0);
    expect(useChats.getState().generating).toBe(false);
    expect(
      useChats.getState().messages.some((message) => message.role === 'assistant' && message.streaming),
      'no reply is left being written on screen',
    ).toBe(false);
  });
});
