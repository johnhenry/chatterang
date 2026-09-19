import { createElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { IRChatRequest, IRStreamChunk } from '@johnhenry/aimatey-types';

/**
 * A REPLY STOPPED BEFORE ITS FIRST WORD STAYS, MARKED STOPPED, AND IS NEVER SENT.
 *
 * The `done` handler wrote a turn stopped before any token as an assistant row
 * with `content: ''`. The next request in that chat was then refused by the
 * bridge's validation before any backend saw it — "Invalid message at index 3:
 * Message content cannot be empty string" — and every later one too, so the
 * conversation could not be continued. The #7 work broker makes that routine: a
 * turn stopped while it waits for the shared model slot has no tokens at all.
 *
 * Owner ruling: keep the reply, marked stopped. It stays in the thread as a
 * visible "Stopped" reply with no text — which keeps any MCP receipts from that
 * turn on screen — and it is left out of what is sent to the model.
 *
 * Everything below runs the real engine and the real bridge, so the refusal is
 * the one aimatey's validation raises, and every assertion about a request is
 * about the bytes a backend adapter was handed. The database is held in memory
 * at the table boundary, as in stop-every-turn.test.ts.
 */

type Row = { id: string; chatId?: string; createdAt?: number };

const fake = vi.hoisted(() => {
  const chats = new Map<string, Row>();
  const messages = new Map<string, Row>();
  const clone = <T>(value: T): T => structuredClone(value);
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
      orderBy: () => ({ reverse: () => ({ toArray: async () => [...chats.values()].map(clone) }) }),
    },
    messages: {
      put: vi.fn(async (message: Row) => {
        messages.set(message.id, clone(message));
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
    blobs: { get: async () => undefined, bulkDelete: vi.fn(async () => {}) },
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
    reset: (): void => {
      chats.clear();
      messages.clear();
    },
  };
});

vi.mock('@/db', () => ({
  db: fake.db,
  deleteChat: fake.deleteChat,
  readSetting: async (_key: string, fallback: unknown) => fallback,
  writeSetting: vi.fn(async () => {}),
}));

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { FunctionBackendAdapter } = await import('@johnhenry/aimatey-backend-browser');

const { useChats } = await import('@/state/chat');
const { useModels } = await import('@/state/models');
const { useApp } = await import('@/state/app');
const { catalogEntry } = await import('@/data/catalog');
const { DEFAULT_SAMPLER } = await import('@/domain/manifest');
const { REACH_DEVICE } = await import('@/domain/chat');
const { ChatterangEngine } = await import('@/ai/engine');
const { toolRegistry } = await import('@/ai/tools/registry');
const { MessageView } = await import('@/features/chat/MessageView');
const { renderTranscript } = await import('@/shell/commands');
const { MCP_CALL, MCP_CALL_CLEAN, PROBE_SERVER, mcpProbe, probeResolver, recordingBackend } = await import(
  './support/egress-probe'
);

type Chat = import('@/domain/chat').Chat;
type Message = import('@/domain/chat').Message;
type ToolInvocation = import('@/domain/chat').ToolInvocation;

const QWEN = catalogEntry('qwen3-4b-instruct-q4km')!;

const ON_DEVICE = {
  backendId: 'llama-cpp',
  engine: 'llama-cpp' as const,
  modelId: QWEN.id,
  modelName: 'Qwen3 4B Instruct',
  reach: REACH_DEVICE,
};

/** What the thread and the export say beside a reply stopped before its first word. */
const STOPPED_NOTE = 'Stopped before its first word';

/* ── The rig ────────────────────────────────────────────────────────── */

function chat(id: string, extra: Partial<Chat> = {}): Chat {
  return {
    id,
    title: id,
    mode: 'chat',
    personaId: null,
    modelId: QWEN.id,
    sampler: null,
    tools: [],
    showThinking: false,
    createdAt: 1,
    updatedAt: 1,
    messageCount: 0,
    preview: '',
    ...extra,
  };
}

function user(chatId: string, n: number, content: string): Message {
  return { id: `${chatId}_u${n}`, chatId, role: 'user', content, createdAt: n };
}

function reply(chatId: string, n: number, content: string, extra: Partial<Message> = {}): Message {
  return {
    id: `${chatId}_a${n}`,
    chatId,
    role: 'assistant',
    content,
    provenance: ON_DEVICE,
    createdAt: n,
    ...extra,
  };
}

/** A chat in the store and the table, with its thread on disk and on screen. */
function given(entry: Chat, thread: Message[]): void {
  fake.chats.set(entry.id, structuredClone(entry));
  for (const row of thread) fake.messages.set(row.id, structuredClone(row));
  useChats.setState({
    loaded: true,
    chats: [entry],
    activeChatId: entry.id,
    messages: thread,
    generating: false,
    controller: null,
    context: null,
  });
}

type Step =
  | { readonly reply: string }
  | { readonly stall: Promise<void> }
  | { readonly partial: string; readonly stall: Promise<void> }
  | { readonly fail: string };

/**
 * A backend that records every request it is handed, then follows its script:
 * reply, fail, or hold the stream open without a token until the test lets it
 * go — which the test does only after Stop, so the turn ends stopped.
 */
function scriptedBackend(steps: Step[]) {
  const seen: IRChatRequest[] = [];
  let at = 0;
  const adapter = new FunctionBackendAdapter({
    execute: async () => {
      throw new Error('this rig only streams');
    },
    executeStream: async function* (request: IRChatRequest): AsyncGenerator<IRStreamChunk> {
      seen.push(structuredClone(request));
      const step = steps[at++];
      if (!step) throw new Error('the script ran out of turns');
      if ('fail' in step) throw new Error(step.fail);
      yield { type: 'start', sequence: 0, metadata: request.metadata };
      if ('partial' in step) {
        yield { type: 'content', sequence: 1, delta: step.partial };
        await step.stall;
        throw new Error('the stream was cut when the turn stopped');
      }
      if ('stall' in step) {
        await step.stall;
        throw new Error('the stream was cut when the turn stopped');
      }
      yield { type: 'content', sequence: 1, delta: step.reply };
      yield { type: 'done', sequence: 2, finishReason: 'stop' };
    },
  });
  return { adapter, seen };
}

/** The real engine, with the local model served by `local` and an optional cloud fallback. */
function engineWith(local: { adapter: unknown }, cloud?: { id: string; adapter: unknown }) {
  const engine = new ChatterangEngine({ resolver: probeResolver, fallbackBackendId: cloud?.id ?? null });
  engine.router.replace(QWEN.engine, local.adapter as never);
  if (cloud) engine.router.register(cloud.id, cloud.adapter as never);
  useApp.setState({ engine: engine as never });
  return engine;
}

/** Indices of messages in a request whose content is empty. */
function emptyAt(request: IRChatRequest | undefined): number[] {
  expect(request, 'a request reached the backend').toBeDefined();
  return request!.messages.flatMap((message, index) =>
    (typeof message.content === 'string' ? message.content.trim() === '' : message.content.length === 0)
      ? [index]
      : [],
  );
}

/** A request's messages as role and text, for reading. */
function spoken(request: IRChatRequest | undefined): [string, string][] {
  return (request?.messages ?? []).map((message) => [
    message.role,
    typeof message.content === 'string' ? message.content : '[blocks]',
  ]);
}

/** What the person was told went wrong. */
const refusals = (): string[] =>
  useApp
    .getState()
    .toasts.filter((toast) => toast.tone === 'crit')
    .map((toast) => toast.message);

const rowsFor = (chatId: string): Message[] =>
  ([...fake.messages.values()] as Message[])
    .filter((row) => row.chatId === chatId)
    .sort((a, b) => a.createdAt - b.createdAt);

const assistantRows = (chatId: string): Message[] => rowsFor(chatId).filter((row) => row.role === 'assistant');

const macrotask = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

async function until(condition: () => boolean): Promise<void> {
  for (let tries = 0; tries < 400; tries += 1) {
    if (condition()) return;
    await macrotask();
  }
  throw new Error('the condition never held');
}

function held(): { promise: Promise<void>; release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

/** Send, and press Stop while the backend holds the stream open with no token. */
async function stopBeforeTheFirstToken(
  text: string,
  seen: () => number,
  release: () => void,
): Promise<void> {
  const before = seen();
  const sending = useChats.getState().send(text);
  await until(() => seen() === before + 1);
  useChats.getState().stop();
  // Only once Stop has landed does the backend let the stream go. Released any
  // earlier, the stream ends as an ordinary failure of a turn nobody stopped:
  // an error row, and for a local turn a divert to the fallback.
  release();
  await sending;
}

/** Answer whatever sheets are still up with no, until `promise` settles. */
async function drainSheets(promise: Promise<unknown>): Promise<void> {
  let settled = false;
  void promise.then(
    () => (settled = true),
    () => (settled = true),
  );
  for (let rounds = 0; rounds < 50 && !settled; rounds += 1) {
    for (const approval of useApp.getState().approvals) useApp.getState().answerApproval(approval.id, false);
    await macrotask();
  }
  await promise;
}

/* ── Rendering ──────────────────────────────────────────────────────── */

async function mounted(message: Message, body: () => Promise<void> | void): Promise<void> {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => {
      root.render(
        createElement(MessageView, { message, showThinking: true, onRegenerate: () => {}, onEdit: () => {} }),
      );
    });
    await body();
  } finally {
    await act(async () => {
      root.unmount();
    });
    host.remove();
  }
}

const stoppedNote = (): string | null => document.querySelector('.msg__stopped')?.textContent ?? null;
const stoppedLabel = (): string | null =>
  document.querySelector('.msg__stopped .label')?.textContent ?? null;
const receipts = (): string[] =>
  [...document.querySelectorAll('.tool__receipt')].map((node) => node.textContent ?? '');
const control = (label: string): Element | null => document.querySelector(`[aria-label="${label}"]`);
const bodyText = (): string => document.querySelector('.msg__body')?.textContent?.trim() ?? '';

/* ── Setup ──────────────────────────────────────────────────────────── */

beforeEach(() => {
  fake.reset();
  vi.clearAllMocks();
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
  useApp.setState({
    toasts: [],
    approvals: [],
    connections: [],
    settings: { ...useApp.getState().settings, renderMarkdown: false },
  });
});

/* ── The reproduced sequence ────────────────────────────────────────── */

describe('a reply stopped before its first token', () => {
  it('stays in the thread marked stopped, and the next send succeeds carrying no empty message', async () => {
    const id = 'repro';
    given(chat(id), [user(id, 1, 'hello'), reply(id, 2, 'Hi.')]);
    const gate = held();
    const local = scriptedBackend([{ stall: gate.promise }, { reply: 'Fine.' }]);
    engineWith(local);

    await stopBeforeTheFirstToken('second', () => local.seen.length, gate.release);

    await useChats.getState().send('third');

    expect(refusals(), 'what the person was told').toEqual([]);
    expect(local.seen, 'requests that reached the backend').toHaveLength(2);
    expect(emptyAt(local.seen[1]), 'empty messages in the next request').toEqual([]);
    expect(spoken(local.seen[1])).toEqual([
      ['user', 'hello'],
      ['assistant', 'Hi.'],
      ['user', 'second'],
      ['user', 'third'],
    ]);

    const [, stopped, answered] = assistantRows(id);
    expect(stopped, 'the stopped reply, on disk').toMatchObject({ content: '', stopped: true });
    expect(stopped?.error, 'a stopped reply is not a failed one').toBeUndefined();
    expect(
      useChats.getState().messages.map((message) => message.id),
      'and on screen, where it was',
    ).toContain(stopped?.id);
    expect(answered?.content).toBe('Fine.');
  });

  it('shows its MCP receipts beside "Stopped", and the next send still carries nothing empty', async () => {
    const id = 'receipts';
    const probe = mcpProbe();
    given(chat(id, { tools: [probe.tool.id] }), [user(id, 1, 'hello'), reply(id, 2, 'Hi.')]);
    const local = recordingBackend([MCP_CALL, 'Fine.']);
    engineWith(local);

    let sending: Promise<void> = Promise.resolve();
    try {
      toolRegistry.register(probe.tool);
      sending = useChats.getState().send('file a note');
      await until(() => useApp.getState().approvals.length === 1);
      useChats.getState().stop();
      await drainSheets(sending);

      const stopped = assistantRows(id).at(-1)!;
      expect(stopped).toMatchObject({ content: '', stopped: true });
      expect(stopped.toolCalls?.[0]?.receipt).toMatchObject({ outcome: 'withheld', why: 'stopped' });

      await mounted(stopped, () => {
        expect(receipts()).toEqual(['Not sent to notes.example (notes) — the reply was stopped before it went.']);
        expect(stoppedLabel(), 'the visible label').toBe('Stopped');
        expect(stoppedNote(), 'what a screen reader reads').toBe(STOPPED_NOTE);
        expect(control('Read aloud'), 'nothing to read aloud').toBeNull();
        expect(control('Regenerate')).not.toBeNull();
      });

      await useChats.getState().send('try again');
    } finally {
      await drainSheets(sending);
      toolRegistry.unregister(probe.tool.id);
    }

    expect(refusals()).toEqual([]);
    expect(local.seen, 'requests that reached the backend').toHaveLength(2);
    expect(emptyAt(local.seen[1])).toEqual([]);
    expect(JSON.stringify(local.seen[1]?.messages), 'the receipt’s record, sent to the model').not.toContain(
      'not sent',
    );
    expect(probe.call, 'MCP calls').not.toHaveBeenCalled();
  });

  it('keeps its text and today’s display when it was stopped after some text', async () => {
    const id = 'partial';
    given(chat(id), [user(id, 1, 'hello'), reply(id, 2, 'Hi.')]);
    const gate = held();
    const local = scriptedBackend([{ partial: 'Half an answer', stall: gate.promise }, { reply: 'Fine.' }]);
    engineWith(local);

    const sending = useChats.getState().send('second');
    await until(() => useChats.getState().messages.some((message) => message.content === 'Half an answer'));
    useChats.getState().stop();
    gate.release();
    await sending;

    const partial = assistantRows(id).at(-1)!;
    expect(partial.content).toBe('Half an answer');
    expect(partial.stopped, 'no stopped marker on a reply that has text').toBeUndefined();
    expect(partial.error).toBeUndefined();

    await mounted(partial, () => {
      expect(bodyText()).toBe('Half an answer');
      expect(stoppedNote()).toBeNull();
      expect(control('Read aloud')).not.toBeNull();
    });

    await useChats.getState().send('third');
    expect(spoken(local.seen[1])).toEqual([
      ['user', 'hello'],
      ['assistant', 'Hi.'],
      ['user', 'second'],
      ['assistant', 'Half an answer'],
      ['user', 'third'],
    ]);
  });

  it('is not written back into a chat deleted while it was stopped', async () => {
    const id = 'removed';
    given(chat(id), [user(id, 1, 'hello'), reply(id, 2, 'Hi.')]);
    const gate = held();
    const local = scriptedBackend([{ stall: gate.promise }]);
    engineWith(local);

    const sending = useChats.getState().send('second');
    await until(() => local.seen.length === 1);
    const removing = useChats.getState().removeChat(id);
    gate.release();
    await Promise.all([sending, removing]);

    expect(fake.chats.has(id), 'the chat, on disk').toBe(false);
    expect(rowsFor(id), 'its rows, on disk').toEqual([]);
    expect(useChats.getState().chats.some((entry) => entry.id === id)).toBe(false);
  });
});

/* ── Every path that builds a request ───────────────────────────────── */

describe('a stopped empty reply is left out of', () => {
  it('a regeneration that replaces it, as today', async () => {
    const id = 'regen_it';
    given(chat(id), [
      user(id, 1, 'hello'),
      reply(id, 2, 'Hi.'),
      user(id, 3, 'second'),
      reply(id, 4, '', { stopped: true }),
    ]);
    const local = scriptedBackend([{ reply: 'Again.' }]);
    engineWith(local);

    await useChats.getState().regenerate(`${id}_a4`);

    expect(refusals()).toEqual([]);
    expect(emptyAt(local.seen[0])).toEqual([]);
    const replies = assistantRows(id);
    expect(replies.map((row) => row.content)).toEqual(['Hi.', 'Again.']);
    // As today: `generationsSoFar` drops an empty generation with no receipt,
    // so the list the new generation is appended to is empty.
    expect(
      replies[1]?.variants?.map((variant) => variant.content),
      'an empty generation with no receipt is not kept',
    ).toEqual(['Again.']);
    expect(replies[1]?.stopped).toBeUndefined();
    expect(replies[1]?.variants?.[0]?.stopped).toBeUndefined();
  });

  it('a regeneration over it that kept its receipts, flipped back to and sent after', async () => {
    const id = 'regen_receipts';
    const probe = mcpProbe();
    given(chat(id, { tools: [probe.tool.id] }), [user(id, 1, 'hello'), reply(id, 2, 'Hi.')]);
    const local = recordingBackend([MCP_CALL, 'Again.', 'Fine.']);
    engineWith(local);

    let sending: Promise<void> = Promise.resolve();
    try {
      toolRegistry.register(probe.tool);
      sending = useChats.getState().send('file a note');
      await until(() => useApp.getState().approvals.length === 1);
      useChats.getState().stop();
      await drainSheets(sending);

      const stopped = assistantRows(id).at(-1)!;
      await useChats.getState().regenerate(stopped.id);

      const regenerated = useChats.getState().messages.at(-1)!;
      expect(regenerated.content).toBe('Again.');
      expect(regenerated.variants?.map((variant) => [variant.content, variant.stopped])).toEqual([
        ['', true],
        ['Again.', undefined],
      ]);

      await useChats.getState().cycleVariant(regenerated.id, -1);
      const flipped = useChats.getState().messages.at(-1)!;
      expect(flipped.stopped, 'the row projects the generation on display').toBe(true);
      await mounted(flipped, () => {
        expect(stoppedNote()).toBe(STOPPED_NOTE);
        expect(receipts()).toEqual(['Not sent to notes.example (notes) — the reply was stopped before it went.']);
      });

      await useChats.getState().send('next');

      // Flipped forward again, the row carries no marker left over from the
      // stopped generation it was showing.
      await useChats.getState().cycleVariant(regenerated.id, 1);
      const forward = useChats.getState().messages.find((message) => message.id === regenerated.id)!;
      expect(forward.content).toBe('Again.');
      expect(forward.stopped, 'no stale marker on the row').toBeUndefined();
    } finally {
      await drainSheets(sending);
      toolRegistry.unregister(probe.tool.id);
    }

    expect(refusals()).toEqual([]);
    expect(local.seen, 'requests that reached the backend').toHaveLength(3);
    expect(emptyAt(local.seen[2])).toEqual([]);
    expect(spoken(local.seen[2]).map(([role]) => role)).toEqual(['user', 'assistant', 'user', 'user']);
  });

  it('a regeneration of a later reply', async () => {
    const id = 'regen_later';
    given(chat(id), [
      user(id, 1, 'hello'),
      reply(id, 2, '', { stopped: true }),
      user(id, 3, 'second'),
      reply(id, 4, 'Later.'),
    ]);
    const local = scriptedBackend([{ reply: 'Again.' }]);
    engineWith(local);

    await useChats.getState().regenerate(`${id}_a4`);

    expect(refusals()).toEqual([]);
    expect(local.seen).toHaveLength(1);
    expect(emptyAt(local.seen[0])).toEqual([]);
    expect(spoken(local.seen[0])).toEqual([
      ['user', 'hello'],
      ['user', 'second'],
    ]);
  });

  it('an edit that resends', async () => {
    const id = 'edit';
    given(chat(id), [
      user(id, 1, 'hello'),
      reply(id, 2, 'Hi.'),
      user(id, 3, 'second'),
      reply(id, 4, '', { stopped: true }),
      user(id, 5, 'third'),
      reply(id, 6, 'Y.'),
    ]);
    const local = scriptedBackend([{ reply: 'Edited.' }]);
    engineWith(local);

    await useChats.getState().editMessage(`${id}_u5`, 'third, edited');

    expect(refusals()).toEqual([]);
    expect(local.seen).toHaveLength(1);
    expect(emptyAt(local.seen[0])).toEqual([]);
    expect(spoken(local.seen[0]).at(-1)).toEqual(['user', 'third, edited']);
  });

  it('the tool loop’s follow-up request', async () => {
    const id = 'tool_loop';
    const probe = mcpProbe();
    given(
      chat(id, {
        tools: [probe.tool.id],
        egressGrants: [{ kind: 'mcp', serverId: PROBE_SERVER.serverId, url: PROBE_SERVER.url, grantedAt: 1 }],
      }),
      [user(id, 1, 'hello'), reply(id, 2, 'Hi.')],
    );
    const gate = held();
    const local = scriptedBackend([{ stall: gate.promise }, { reply: MCP_CALL_CLEAN }, { reply: 'Filed.' }]);
    engineWith(local);

    try {
      toolRegistry.register(probe.tool);
      await stopBeforeTheFirstToken('second', () => local.seen.length, gate.release);

      await useChats.getState().send('file a shopping list');
    } finally {
      toolRegistry.unregister(probe.tool.id);
    }

    expect(refusals()).toEqual([]);
    expect(probe.call, 'the granted call ran').toHaveBeenCalledTimes(1);
    expect(local.seen, 'the stopped request, the call, the follow-up').toHaveLength(3);
    expect(emptyAt(local.seen[1]), 'the request the model called the tool from').toEqual([]);
    expect(emptyAt(local.seen[2]), 'the follow-up after the tool ran').toEqual([]);
    expect(assistantRows(id).at(-1)?.content).toBe('Filed.');
  });

  it('the request a failed local turn diverts to the cloud fallback', async () => {
    const id = 'fallback';
    given(chat(id), [user(id, 1, 'hello'), reply(id, 2, 'Hi.')]);
    const gate = held();
    const local = scriptedBackend([{ stall: gate.promise }, { fail: 'not enough memory' }]);
    const cloud = recordingBackend(['From the cloud.']);
    engineWith(local, { id: 'conn_cloud', adapter: cloud.adapter });

    await stopBeforeTheFirstToken('second', () => local.seen.length, gate.release);
    expect(cloud.seen, 'a stopped turn does not divert').toHaveLength(0);

    await useChats.getState().send('third');

    expect(refusals()).toEqual([]);
    expect(local.seen, 'the local backend was asked, and failed').toHaveLength(2);
    expect(emptyAt(local.seen[1])).toEqual([]);
    expect(cloud.seen, 'the diverted request').toHaveLength(1);
    expect(emptyAt(cloud.seen[0])).toEqual([]);
    expect(spoken(cloud.seen[0])).toEqual([
      ['user', 'hello'],
      ['assistant', 'Hi.'],
      ['user', 'second'],
      ['user', 'third'],
    ]);
    expect(assistantRows(id).at(-1)).toMatchObject({
      content: 'From the cloud.',
      provenance: { fallbackFrom: QWEN.engine },
    });
  });
});

/* ── Rows already on disk ───────────────────────────────────────────── */

describe('an empty reply written before the marker existed', () => {
  it('shows as stopped and is left out of the next request, and the row is not rewritten', async () => {
    const id = 'old_row';
    const old = reply(id, 4, '');
    fake.chats.set(id, chat(id));
    for (const row of [user(id, 1, 'hello'), reply(id, 2, 'Hi.'), user(id, 3, 'second'), old]) {
      fake.messages.set(row.id, structuredClone(row));
    }
    useChats.setState({ loaded: true, chats: [chat(id)], activeChatId: null, messages: [] });
    const local = scriptedBackend([{ reply: 'Fine.' }]);
    engineWith(local);

    await useChats.getState().openChat(id);
    const opened = useChats.getState().messages.find((message) => message.id === old.id)!;
    await mounted(opened, () => {
      expect(stoppedNote()).toBe(STOPPED_NOTE);
    });

    await useChats.getState().send('third');

    expect(refusals()).toEqual([]);
    expect(emptyAt(local.seen[0])).toEqual([]);
    expect(spoken(local.seen[0]).map(([role]) => role)).toEqual(['user', 'assistant', 'user', 'user']);
    expect(fake.messages.get(old.id), 'the old row, on disk').toEqual(old);
  });

  it('keeps today’s display when it carries receipts, and is still left out of the next request', async () => {
    const id = 'old_receipts';
    const call: ToolInvocation = {
      id: 'call_old',
      name: 'notes.note',
      input: { text: 'a note' },
      output: 'filed',
      receipt: {
        outcome: 'sent',
        serverId: PROBE_SERVER.serverId,
        serverName: 'notes',
        host: 'notes.example',
        toolName: 'notes.note',
        bytes: 17,
        at: Date.UTC(2026, 8, 1),
      },
    };
    const old = reply(id, 4, '', { toolCalls: [call] });
    given(chat(id), [user(id, 1, 'hello'), reply(id, 2, 'Hi.'), user(id, 3, 'second'), old]);
    const local = scriptedBackend([{ reply: 'Fine.' }]);
    engineWith(local);

    await mounted(old, () => {
      expect(receipts()).toHaveLength(1);
      expect(stoppedNote(), 'not called stopped: nothing says it was').toBeNull();
    });

    await useChats.getState().send('third');

    expect(refusals()).toEqual([]);
    expect(emptyAt(local.seen[0])).toEqual([]);
    expect(spoken(local.seen[0]).map(([role]) => role)).toEqual(['user', 'assistant', 'user', 'user']);
  });
});

/* ── The export ─────────────────────────────────────────────────────── */

describe('the transcript', () => {
  it('says a reply was stopped before its first word, and nothing about one that has text', () => {
    const id = 'transcript';
    const markdown = renderTranscript({ title: 'Stops', updatedAt: Date.UTC(2026, 8, 14) }, [
      user(id, 1, 'hello'),
      reply(id, 2, '', { stopped: true }),
      user(id, 3, 'again'),
      reply(id, 4, ''),
      user(id, 5, 'once more'),
      reply(id, 6, 'Half an answer'),
      user(id, 7, 'and again'),
      // A failed reply with no text is a failure, never "stopped".
      reply(id, 8, '', { error: 'The model could not be loaded.' }),
    ]);

    expect(markdown.split(`_${STOPPED_NOTE}._`)).toHaveLength(3);
    expect(markdown).toContain('Half an answer');
    expect(markdown.slice(markdown.indexOf('Half an answer'))).not.toContain(STOPPED_NOTE);
  });
});

/* ── The words a stopped turn streamed ──────────────────────────────── */

const { CALL, leakyTool } = await import('./support/egress-probe');

/** Send, let the backend stream some text, press Stop once `marker` is on screen, then let the stream go. */
async function stopAfterSome(text: string, marker: string, release: () => void): Promise<void> {
  const sending = useChats.getState().send(text);
  await until(() => useChats.getState().messages.some((message) => message.content.includes(marker)));
  useChats.getState().stop();
  release();
  await sending;
}

describe('a reply stopped after some text, in a chat with no tools', () => {
  // Names a "function" inside a fenced JSON block: the shape the engine's
  // tool-syntax stripping removes, and not a tool call in a chat with no tools.
  const EXAMPLE = '```json\n{\n  "type": "function",\n  "function": {\n    "name": "get_weather"\n  }\n}\n```';

  it('keeps a JSON example it was writing, word for word', async () => {
    const id = 'partial_json';
    given(chat(id), [user(id, 1, 'hello'), reply(id, 2, 'Hi.')]);
    const partial = `Here is the shape:\n\n${EXAMPLE}\n\nEach entry`;
    const gate = held();
    const local = scriptedBackend([{ partial, stall: gate.promise }, { reply: 'Fine.' }]);
    engineWith(local);

    await stopAfterSome('second', 'Each entry', gate.release);

    const stopped = assistantRows(id).at(-1)!;
    expect(stopped.content, 'the words the person watched arrive').toBe(partial);
    expect(stopped.stopped, 'a reply with text carries no marker').toBeUndefined();
  });

  it('is not called stopped, nor left out, when such an example was all it wrote', async () => {
    const id = 'partial_json_only';
    given(chat(id), [user(id, 1, 'hello'), reply(id, 2, 'Hi.')]);
    const gate = held();
    const local = scriptedBackend([{ partial: EXAMPLE, stall: gate.promise }, { reply: 'Fine.' }]);
    engineWith(local);

    await stopAfterSome('second', 'get_weather', gate.release);

    const stopped = assistantRows(id).at(-1)!;
    expect({ content: stopped.content, stopped: stopped.stopped }, 'the stored reply').toEqual({
      content: EXAMPLE,
      stopped: undefined,
    });
    await mounted(stopped, () => {
      expect(stoppedNote(), 'called stopped before its first word').toBeNull();
      expect(control('Read aloud')).not.toBeNull();
    });

    await useChats.getState().send('third');
    expect(refusals()).toEqual([]);
    expect(spoken(local.seen[1]), 'the next request').toEqual([
      ['user', 'hello'],
      ['assistant', 'Hi.'],
      ['user', 'second'],
      ['assistant', EXAMPLE],
      ['user', 'third'],
    ]);
  });
});

describe('a turn stopped while the model was still writing its tool call', () => {
  it('keeps the words before the call, and sends none of the call back to the model', async () => {
    const id = 'partial_call';
    const probe = mcpProbe();
    given(chat(id, { tools: [probe.tool.id] }), [user(id, 1, 'hello'), reply(id, 2, 'Hi.')]);
    const partial = 'Filing it now.\n<tool_call>{"name":"notes.note","arguments":{"text":"canary-7f3a';
    const gate = held();
    const local = scriptedBackend([{ partial, stall: gate.promise }, { reply: 'Fine.' }]);
    engineWith(local);

    try {
      toolRegistry.register(probe.tool);
      await stopAfterSome('second', 'canary-7f3a', gate.release);
      await useChats.getState().send('third');
    } finally {
      toolRegistry.unregister(probe.tool.id);
    }

    const stopped = assistantRows(id)[1]!;
    expect(stopped.content, 'the stopped reply, on disk').toBe('Filing it now.');
    expect(stopped.stopped).toBeUndefined();
    expect(probe.call, 'MCP calls').not.toHaveBeenCalled();
    expect(refusals()).toEqual([]);
    expect(spoken(local.seen[1]), 'the next request').toEqual([
      ['user', 'hello'],
      ['assistant', 'Hi.'],
      ['user', 'second'],
      ['assistant', 'Filing it now.'],
      ['user', 'third'],
    ]);
    expect(JSON.stringify(local.seen[1]?.messages), 'the call’s arguments, sent back').not.toContain('canary-7f3a');
  });

  it('is a reply stopped before its first word when the unfinished call was all it wrote', async () => {
    const id = 'partial_call_only';
    const probe = mcpProbe();
    given(chat(id, { tools: [probe.tool.id] }), [user(id, 1, 'hello'), reply(id, 2, 'Hi.')]);
    const partial = '<tool_call>{"name":"notes.note","arguments":{"text":"canary-7f3a';
    const gate = held();
    const local = scriptedBackend([{ partial, stall: gate.promise }, { reply: 'Fine.' }]);
    engineWith(local);

    try {
      toolRegistry.register(probe.tool);
      await stopAfterSome('second', 'canary-7f3a', gate.release);

      const stopped = assistantRows(id).at(-1)!;
      expect(stopped, 'the stopped reply, on disk').toMatchObject({ content: '', stopped: true });
      await mounted(stopped, () => {
        expect(stoppedNote()).toBe(STOPPED_NOTE);
      });

      await useChats.getState().send('third');
    } finally {
      toolRegistry.unregister(probe.tool.id);
    }

    expect(probe.call, 'MCP calls').not.toHaveBeenCalled();
    expect(refusals()).toEqual([]);
    expect(emptyAt(local.seen[1])).toEqual([]);
    expect(spoken(local.seen[1]).map(([role]) => role)).toEqual(['user', 'assistant', 'user', 'user']);
    expect(JSON.stringify(local.seen[1]?.messages), 'the call’s arguments, sent back').not.toContain('canary-7f3a');
  });
});

/* ── A reply nobody stopped ─────────────────────────────────────────── */

describe('an empty reply nobody stopped', () => {
  it('that spent itself reasoning is recorded as not stopped, and neither shown nor exported as stopped', async () => {
    const id = 'thinking_only';
    given(chat(id), [user(id, 1, 'hello'), reply(id, 2, 'Hi.')]);
    const local = recordingBackend(['<think>Let me weigh the options carefully</think>', 'Fine.']);
    engineWith(local);

    await useChats.getState().send('which one?');

    const last = assistantRows(id).at(-1)!;
    expect(last.error, 'not a failure').toBeUndefined();
    expect(last.thinking).toContain('weigh the options');
    expect(last, 'finished with no words, and recorded as not stopped').toMatchObject({
      content: '',
      stopped: false,
    });
    await mounted(last, () => {
      expect(stoppedNote(), 'the thread').toBeNull();
    });
    expect(renderTranscript({ title: 't', updatedAt: 1 }, rowsFor(id)), 'the export').not.toContain(STOPPED_NOTE);

    await useChats.getState().send('and?');
    expect(refusals()).toEqual([]);
    expect(emptyAt(local.seen[1]), 'still left out of the next request').toEqual([]);
  });

  it('whose local tool ran and whose follow-up wrote nothing stores no words, and regenerates like any empty reply with no receipt', async () => {
    const id = 'local_tool_empty';
    given(chat(id, { tools: [leakyTool.id] }), [user(id, 1, 'hello'), reply(id, 2, 'Hi.')]);
    const local = recordingBackend([CALL, '', 'Again.']);
    engineWith(local);

    try {
      toolRegistry.register(leakyTool);
      await useChats.getState().send('read my notes');

      const last = assistantRows(id).at(-1)!;
      expect(last.error, 'not a failure').toBeUndefined();
      expect(last.toolCalls?.map((call) => call.name), 'the tool ran').toEqual(['leaky']);
      expect(last.content, 'the call it made is not stored as its words').toBe('');
      expect(last.stopped, 'nothing stopped it').toBe(false);
      expect(renderTranscript({ title: 't', updatedAt: 1 }, rowsFor(id)), 'the export').not.toContain(
        STOPPED_NOTE,
      );
      await mounted(last, () => {
        expect(stoppedNote(), 'the thread').toBeNull();
      });

      await useChats.getState().regenerate(last.id);
    } finally {
      toolRegistry.unregister(leakyTool.id);
    }

    const regenerated = assistantRows(id).at(-1)!;
    expect(regenerated.content).toBe('Again.');
    // A local tool's call carries no receipt, and an empty generation with no
    // receipt is not a version anyone can flip back to (#92's rule, pinned in
    // variant-provenance.test.ts). It was kept only while the call's markup was
    // stored as its words.
    expect(
      regenerated.variants?.map((variant) => variant.content),
      'the empty generation is dropped, as any empty one with no receipt',
    ).toEqual(['Again.']);
  });
});

/* ── The chat list ──────────────────────────────────────────────────── */

describe('the chat list, after a reply stopped before its first word', () => {
  it('keeps the preview it had rather than blanking it', async () => {
    const id = 'preview';
    given(chat(id), [user(id, 1, 'hello'), reply(id, 2, 'Hi.')]);
    const gate = held();
    const local = scriptedBackend([{ stall: gate.promise }]);
    engineWith(local);

    await stopBeforeTheFirstToken('second', () => local.seen.length, gate.release);

    expect(assistantRows(id).at(-1)).toMatchObject({ content: '', stopped: true });
    expect(useChats.getState().chats.find((entry) => entry.id === id)?.preview, 'the sidebar').toBe('second');
    expect((fake.chats.get(id) as Chat | undefined)?.preview, 'on disk').toBe('second');
  });
});

/* ── Tool-call syntax in a chat with tools ──────────────────────────── */

/** Run `body` with the MCP probe registered, in a chat that enables it. */
async function inToolsChat(id: string, body: () => Promise<void>): Promise<ReturnType<typeof mcpProbe>> {
  const probe = mcpProbe();
  given(chat(id, { tools: [probe.tool.id] }), [user(id, 1, 'hello'), reply(id, 2, 'Hi.')]);
  try {
    toolRegistry.register(probe.tool);
    await body();
  } finally {
    toolRegistry.unregister(probe.tool.id);
  }
  return probe;
}

describe('a reply stopped after some text, in a chat with tools', () => {
  it('keeps its answer when its reasoning mentioned <tool_call>, and is not called stopped', async () => {
    const id = 'think_mentions_call';
    // Named twice in the reasoning: as a word, and in the shape a call opens with.
    const reasoning = 'A plain fact. No need to emit a <tool_call> for this, nor <tool_call>{"name": "notes.note"} at all.';
    const partial = `<think>${reasoning}</think>The capital of Australia is Canberra, which`;
    const gate = held();
    const local = scriptedBackend([{ partial, stall: gate.promise }, { reply: 'Fine.' }]);
    engineWith(local);

    await inToolsChat(id, async () => {
      await stopAfterSome('second', 'Canberra, which', gate.release);
      const stopped = assistantRows(id).at(-1)!;
      expect({ content: stopped.content, stopped: stopped.stopped }, 'the stored reply').toEqual({
        content: 'The capital of Australia is Canberra, which',
        stopped: undefined,
      });
      expect(stopped.thinking, 'its reasoning, as the model wrote it').toBe(reasoning);
      await mounted(stopped, () => {
        expect(stoppedNote(), 'called stopped before its first word').toBeNull();
      });
      await useChats.getState().send('third');
    });

    expect(refusals()).toEqual([]);
    expect(spoken(local.seen[1]), 'the next request').toEqual([
      ['user', 'hello'],
      ['assistant', 'Hi.'],
      ['user', 'second'],
      ['assistant', 'The capital of Australia is Canberra, which'],
      ['user', 'third'],
    ]);
  });

  it('still cuts an unfinished call written after its reasoning', async () => {
    const id = 'think_then_call';
    const partial =
      '<think>File it.</think>Filing it now.\n<tool_call>{"name":"notes.note","arguments":{"text":"canary-7f3a';
    const gate = held();
    const local = scriptedBackend([{ partial, stall: gate.promise }, { reply: 'Fine.' }]);
    engineWith(local);

    const probe = await inToolsChat(id, async () => {
      await stopAfterSome('second', 'canary-7f3a', gate.release);
      await useChats.getState().send('third');
    });

    const stopped = assistantRows(id)[1]!;
    expect({ content: stopped.content, thinking: stopped.thinking }).toEqual({
      content: 'Filing it now.',
      thinking: 'File it.',
    });
    expect(probe.call, 'MCP calls').not.toHaveBeenCalled();
    expect(JSON.stringify(local.seen[1]?.messages), 'the call’s arguments, sent back').not.toContain('canary-7f3a');
  });

  it('keeps the words after a literal `<tool_call>` in prose', async () => {
    const id = 'prose_call_tag';
    const partial = 'Qwen wraps each call in a `<tool_call>` tag. Inside it is JSON naming the tool, and the app reads';
    const gate = held();
    const local = scriptedBackend([{ partial, stall: gate.promise }, { reply: 'Fine.' }]);
    engineWith(local);

    await inToolsChat(id, async () => {
      await stopAfterSome('second', 'the app reads', gate.release);
    });

    expect(assistantRows(id).at(-1)?.content, 'the words the person watched arrive').toBe(partial);
  });

  it('keeps a TOML example with a [tool_calls] table', async () => {
    const id = 'toml_tool_calls';
    const partial =
      'Add this to your config:\n\n```toml\n[tool_calls]\nenabled = true\nmax_rounds = 4\n```\n\nThen restart the';
    const gate = held();
    const local = scriptedBackend([{ partial, stall: gate.promise }, { reply: 'Fine.' }]);
    engineWith(local);

    await inToolsChat(id, async () => {
      await stopAfterSome('second', 'restart the', gate.release);
    });

    expect(assistantRows(id).at(-1)?.content, 'the words the person watched arrive').toBe(partial);
  });

  it('cuts an unfinished [TOOL_CALLS] call and sends none of it back', async () => {
    const id = 'mistral_call';
    const partial = 'Reading it.\n[TOOL_CALLS] leaky({"path": "canary-7f3a';
    const gate = held();
    const local = scriptedBackend([{ partial, stall: gate.promise }, { reply: 'Fine.' }]);
    engineWith(local);

    await inToolsChat(id, async () => {
      await stopAfterSome('second', 'canary-7f3a', gate.release);
      await useChats.getState().send('third');
    });

    expect(assistantRows(id)[1]?.content).toBe('Reading it.');
    expect(JSON.stringify(local.seen[1]?.messages), 'the call’s arguments, sent back').not.toContain('canary-7f3a');
  });
});

describe('a finished reply in a chat with tools', () => {
  it('whose tool ran and whose follow-up wrote nothing sends no tool-call markup back to the model', async () => {
    const id = 'tool_ran_follow_up_empty';
    given(chat(id, { tools: [leakyTool.id] }), [user(id, 1, 'hello'), reply(id, 2, 'Hi.')]);
    const local = recordingBackend([CALL, '', 'Next.']);
    engineWith(local);

    try {
      toolRegistry.register(leakyTool);
      await useChats.getState().send('read my notes');
      await useChats.getState().send('and then?');
    } finally {
      toolRegistry.unregister(leakyTool.id);
    }

    const ran = assistantRows(id)[1]!;
    expect({ content: ran.content, stopped: ran.stopped }, 'the stored reply').toEqual({ content: '', stopped: false });
    expect(refusals()).toEqual([]);
    expect(local.seen, 'the call, the follow-up, the next send').toHaveLength(3);
    expect(emptyAt(local.seen[2])).toEqual([]);
    expect(spoken(local.seen[2]), 'the next request').toEqual([
      ['user', 'hello'],
      ['assistant', 'Hi.'],
      ['user', 'read my notes'],
      ['user', 'and then?'],
    ]);
  });

  it('cut off in the middle of a call stores and sends none of the call', async () => {
    const id = 'cut_off_call';
    given(chat(id, { tools: [leakyTool.id] }), [user(id, 1, 'hello'), reply(id, 2, 'Hi.')]);
    const local = recordingBackend([
      'Checking.\n<tool_call>{"name":"leaky","arguments":{"path":"canary-7f3a',
      'Next.',
    ]);
    engineWith(local);

    try {
      toolRegistry.register(leakyTool);
      await useChats.getState().send('read my notes');
      await useChats.getState().send('and then?');
    } finally {
      toolRegistry.unregister(leakyTool.id);
    }

    expect(assistantRows(id)[1]?.content).toBe('Checking.');
    expect(refusals()).toEqual([]);
    expect(JSON.stringify(local.seen[1]?.messages), 'the call’s arguments, sent back').not.toContain('canary-7f3a');
  });

  it('that was only a JSON example naming a "function" keeps it, as it did', async () => {
    const id = 'tools_json_only';
    const example = '```json\n{\n  "type": "function",\n  "function": {\n    "name": "get_weather"\n  }\n}\n```';
    given(chat(id, { tools: [leakyTool.id] }), [user(id, 1, 'hello'), reply(id, 2, 'Hi.')]);
    const local = recordingBackend([example, 'Next.']);
    engineWith(local);

    try {
      toolRegistry.register(leakyTool);
      await useChats.getState().send('show me the shape');
    } finally {
      toolRegistry.unregister(leakyTool.id);
    }

    expect(assistantRows(id).at(-1)?.content).toBe(example);
  });
});

/* ── A call's opening shape the reply goes on past ──────────────────── */

/** A reply that documents Qwen's call format: a call's opening shape, with no closing tag, and prose after it. */
const DOC =
  'Every Qwen call opens like this:\n\n```\n<tool_call>\n{"name": "get_weather", "arguments": {"city": "Paris"}}\n```\n\n' +
  'and the model then writes the closing tag. The app reads the JSON, runs the tool, and hands its result back as the next turn.';

describe('a reply that writes a call’s opening shape and goes on past it, in a chat with tools', () => {
  it('keeps every word when it finished, and sends them back', async () => {
    const id = 'doc_finished';
    given(chat(id, { tools: [leakyTool.id] }), [user(id, 1, 'hello'), reply(id, 2, 'Hi.')]);
    const local = recordingBackend([DOC, 'Next.']);
    engineWith(local);

    try {
      toolRegistry.register(leakyTool);
      await useChats.getState().send('how does qwen format a call?');
      await useChats.getState().send('thanks');
    } finally {
      toolRegistry.unregister(leakyTool.id);
    }

    expect(assistantRows(id)[1]?.content, 'the words the person watched arrive').toBe(DOC);
    expect(refusals()).toEqual([]);
    expect(spoken(local.seen[1]), 'the next request').toEqual([
      ['user', 'hello'],
      ['assistant', 'Hi.'],
      ['user', 'how does qwen format a call?'],
      ['assistant', DOC],
      ['user', 'thanks'],
    ]);
  });

  it('keeps every word when it was stopped after the example', async () => {
    const id = 'doc_stopped';
    const partial = DOC.slice(0, DOC.indexOf('runs the tool, and ') + 'runs the tool, and'.length);
    const gate = held();
    const local = scriptedBackend([{ partial, stall: gate.promise }]);
    engineWith(local);

    await inToolsChat(id, async () => {
      await stopAfterSome('second', 'runs the tool, and', gate.release);
    });

    expect(assistantRows(id).at(-1)?.content, 'the words the person watched arrive').toBe(partial);
  });

  it('is not called stopped before its first word when its words began with the example', async () => {
    const id = 'doc_first';
    const partial = '<tool_call>{"name": "get_weather"} is how every Qwen call opens, and the app then reads';
    const gate = held();
    const local = scriptedBackend([{ partial, stall: gate.promise }]);
    engineWith(local);

    await inToolsChat(id, async () => {
      await stopAfterSome('second', 'the app then reads', gate.release);
    });

    const stopped = assistantRows(id).at(-1)!;
    expect({ content: stopped.content, stopped: stopped.stopped }, 'the stored reply').toEqual({
      content: partial,
      stopped: undefined,
    });
    await mounted(stopped, () => {
      expect(stoppedNote(), 'called stopped before its first word').toBeNull();
    });
  });

  it('still cuts a call whose arguments closed when Stop landed before its closing tag', async () => {
    const id = 'call_before_close';
    const partial = 'Filing it.\n<tool_call>{"name":"notes.note","arguments":{"text":"canary-7f3a"}}\n</tool_';
    const gate = held();
    const local = scriptedBackend([{ partial, stall: gate.promise }, { reply: 'Fine.' }]);
    engineWith(local);

    const probe = await inToolsChat(id, async () => {
      await stopAfterSome('second', '</tool_', gate.release);
      await useChats.getState().send('third');
    });

    expect(assistantRows(id)[1]?.content).toBe('Filing it.');
    expect(probe.call, 'MCP calls').not.toHaveBeenCalled();
    expect(JSON.stringify(local.seen[1]?.messages), 'the call’s arguments, sent back').not.toContain('canary-7f3a');
  });

  it('still cuts a call whose opening marker and name were all Stop let it write', async () => {
    const id = 'call_marker_at_end';
    const partial = 'Reading it.\n[TOOL_CALLS] leaky(';
    const gate = held();
    const local = scriptedBackend([{ partial, stall: gate.promise }]);
    engineWith(local);

    await inToolsChat(id, async () => {
      await stopAfterSome('second', 'leaky(', gate.release);
    });

    expect(assistantRows(id).at(-1)?.content).toBe('Reading it.');
  });

  it('still cuts an unfinished call whose arguments hold a closing brace in a string', async () => {
    const id = 'call_brace_in_string';
    const partial = 'Filing it.\n<tool_call>{"name":"notes.note","arguments":{"text":"a } b } canary-7f3a';
    const gate = held();
    const local = scriptedBackend([{ partial, stall: gate.promise }, { reply: 'Fine.' }]);
    engineWith(local);

    await inToolsChat(id, async () => {
      await stopAfterSome('second', 'canary-7f3a', gate.release);
      await useChats.getState().send('third');
    });

    expect(assistantRows(id)[1]?.content).toBe('Filing it.');
    expect(JSON.stringify(local.seen[1]?.messages), 'the call’s arguments, sent back').not.toContain('canary-7f3a');
  });

  it('keeps the words after a [TOOL_CALLS] name({…} whose arguments closed and prose followed', async () => {
    const id = 'mistral_doc';
    const partial = 'Mistral writes [TOOL_CALLS] get_weather({"city": "Paris"} and then the paren, which the app reads';
    const gate = held();
    const local = scriptedBackend([{ partial, stall: gate.promise }]);
    engineWith(local);

    await inToolsChat(id, async () => {
      await stopAfterSome('second', 'which the app reads', gate.release);
    });

    expect(assistantRows(id).at(-1)?.content, 'the words the person watched arrive').toBe(partial);
  });
});

/* ── A chat whose tools were not offered ────────────────────────────── */

describe('a reply in a chat whose tool ids name nothing connected', () => {
  // An MCP tool id kept after its server was removed: the request offers no tools.
  const GONE = 'mcp:gone-server:note';
  const EXAMPLE = '```json\n{\n  "type": "function",\n  "function": {\n    "name": "get_weather"\n  }\n}\n```';

  it('keeps a JSON example it was writing when it was stopped', async () => {
    const id = 'gone_stopped_json';
    given(chat(id, { tools: [GONE] }), [user(id, 1, 'hello'), reply(id, 2, 'Hi.')]);
    const partial = `Here is the shape:\n\n${EXAMPLE}\n\nEach entry`;
    const gate = held();
    const local = scriptedBackend([{ partial, stall: gate.promise }]);
    engineWith(local);

    await stopAfterSome('second', 'Each entry', gate.release);

    expect(local.seen[0]?.tools ?? [], 'the tools the request offered').toEqual([]);
    expect(assistantRows(id).at(-1)?.content, 'the words the person watched arrive').toBe(partial);
  });

  it('keeps a finished reply’s last word when it names a call marker', async () => {
    const id = 'gone_finished_marker';
    given(chat(id, { tools: [GONE] }), [user(id, 1, 'hello'), reply(id, 2, 'Hi.')]);
    const text = 'Mistral models put every call after the special token [TOOL_CALLS]';
    const local = recordingBackend([text]);
    engineWith(local);

    await useChats.getState().send('how does mistral mark a call?');

    expect(local.seen[0]?.tools ?? [], 'the tools the request offered').toEqual([]);
    expect(assistantRows(id).at(-1)?.content, 'the words the person watched arrive').toBe(text);
  });

  it('does not run a complete <tool_call> example, and keeps it in a finished reply and the next request', async () => {
    // The request offered no tool, so nothing the turn wrote is a call. The
    // engine read it for calls anyway, because the chat still named a tool id:
    // the example was dispatched, answered "No tool named", followed by a
    // second request, and stripped from the reply the person watched arrive.
    const id = 'gone_finished_tag_example';
    given(chat(id, { tools: [GONE] }), [user(id, 1, 'hello'), reply(id, 2, 'Hi.')]);
    const text =
      'Qwen writes a call as <tool_call>{"name": "get_weather", "arguments": {"city": "Paris"}}</tool_call> and then waits.';
    const local = recordingBackend([text, 'Follow-up.']);
    engineWith(local);

    await useChats.getState().send('how does qwen call a tool?');
    const requests = local.seen.length;
    await useChats.getState().send('thanks');

    const stored = assistantRows(id)[1]!;
    expect(local.seen[0]?.tools ?? [], 'the tools the request offered').toEqual([]);
    expect(
      { requests, content: stored.content, tools: stored.toolCalls?.map((call) => call.output) },
      'the finished reply',
    ).toEqual({ requests: 1, content: text, tools: undefined });
    expect(spoken(local.seen[1]).at(-2), 'the next request').toEqual(['assistant', text]);
  });
});

/* ── Words that name, show or explain a call, in a chat with tools ──── */

/**
 * The engine's call patterns were lazy and did not know about strings, and the
 * reply's words were read with them: a JSON example, prose naming a call's
 * tags, or a call whose arguments held a ")" lost words, or kept a fragment of
 * the call. What is taken out of a reply now is what the engine reads as a call.
 */

/** A tool DEFINITION, as OpenAI's function-calling docs show one. Not a call. */
const SCHEMA_EXAMPLE = '```json\n{\n  "type": "function",\n  "function": {\n    "name": "get_weather"\n  }\n}\n```';

describe('a reply stopped after some text, in a chat offering tools, keeps words that are not a call', () => {
  it('keeps a whole JSON function-schema example that was all it wrote, and is not called stopped', async () => {
    const id = 'r1_schema_only';
    const gate = held();
    const local = scriptedBackend([{ partial: SCHEMA_EXAMPLE, stall: gate.promise }, { reply: 'Fine.' }]);
    engineWith(local);

    await inToolsChat(id, async () => {
      await stopAfterSome('second', 'get_weather', gate.release);
      const stopped = assistantRows(id).at(-1)!;
      expect({ content: stopped.content, stopped: stopped.stopped }, 'the stored reply').toEqual({
        content: SCHEMA_EXAMPLE,
        stopped: undefined,
      });
      await mounted(stopped, () => {
        expect(stoppedNote(), 'called stopped before its first word').toBeNull();
      });
      await useChats.getState().send('third');
    });

    expect(spoken(local.seen[1]), 'the next request').toEqual([
      ['user', 'hello'],
      ['assistant', 'Hi.'],
      ['user', 'second'],
      ['assistant', SCHEMA_EXAMPLE],
      ['user', 'third'],
    ]);
  });

  it('keeps a JSON example with prose around it', async () => {
    const id = 'r1_schema_prose';
    const partial = `Here is the shape:\n\n${SCHEMA_EXAMPLE}\n\nEach entry`;
    const gate = held();
    const local = scriptedBackend([{ partial, stall: gate.promise }]);
    engineWith(local);

    await inToolsChat(id, async () => {
      await stopAfterSome('second', 'Each entry', gate.release);
    });

    expect(assistantRows(id).at(-1)?.content, 'the words the person watched arrive').toBe(partial);
  });

  it('keeps two code blocks and the prose between them when a quoted "tool" sits there', async () => {
    const id = 'r1_two_blocks';
    const partial =
      'Start from this:\n\n```json\n{"model": "qwen3"}\n```\n\nThen set the "tool" key in the second file:\n\n' +
      '```json\n{"enabled": true}\n```\n\nAfter that, restart';
    const gate = held();
    const local = scriptedBackend([{ partial, stall: gate.promise }]);
    engineWith(local);

    await inToolsChat(id, async () => {
      await stopAfterSome('second', 'After that, restart', gate.release);
    });

    expect(assistantRows(id).at(-1)?.content, 'the words the person watched arrive').toBe(partial);
  });

  it('keeps the words between a `<tool_call>` and a `</tool_call>` named in prose', async () => {
    const id = 'r1_prose_tags';
    const partial = 'Qwen wraps each call in a `<tool_call>` tag and ends it with `</tool_call>`, and between them the app reads';
    const gate = held();
    const local = scriptedBackend([{ partial, stall: gate.promise }]);
    engineWith(local);

    await inToolsChat(id, async () => {
      await stopAfterSome('second', 'the app reads', gate.release);
    });

    expect(assistantRows(id).at(-1)?.content, 'the words the person watched arrive').toBe(partial);
  });

  it('keeps the words after a [TOOL_CALLS] named in prose before a parenthetical aside', async () => {
    const id = 'r1_prose_mistral';
    const partial = 'Mistral emits [TOOL_CALLS] before (not after) the function name, and the parser then reads';
    const gate = held();
    const local = scriptedBackend([{ partial, stall: gate.promise }]);
    engineWith(local);

    await inToolsChat(id, async () => {
      await stopAfterSome('second', 'the parser then reads', gate.release);
    });

    expect(assistantRows(id).at(-1)?.content, 'the words the person watched arrive').toBe(partial);
  });
});

describe('a finished reply keeps words that are not a call', () => {
  it('keeps the words between a `<tool_call>` and a `</tool_call>` named in prose, in any chat', async () => {
    const id = 'r1_finished_prose_tags';
    given(chat(id), [user(id, 1, 'hello'), reply(id, 2, 'Hi.')]);
    const text =
      'Qwen wraps each call in a `<tool_call>` tag and ends it with `</tool_call>`, and between them the app reads JSON.';
    const local = recordingBackend([text]);
    engineWith(local);

    await useChats.getState().send('how does qwen mark a call?');

    expect(assistantRows(id).at(-1)?.content, 'the words the person watched arrive').toBe(text);
  });

  it('keeps a fenced block naming a tool in a chat that enables none', async () => {
    const id = 'r1_no_tools_fenced';
    given(chat(id), [user(id, 1, 'hello'), reply(id, 2, 'Hi.')]);
    const text =
      'Configure the agent like this:\n\n```json\n{"tool": "search", "arguments": {"query": "weather"}}\n```\n\nThen restart it.';
    const local = recordingBackend([text]);
    engineWith(local);

    await useChats.getState().send('what goes in the config?');

    expect(local.seen[0]?.tools ?? [], 'the tools the request offered').toEqual([]);
    expect(assistantRows(id).at(-1)?.content, 'the words the person watched arrive').toBe(text);
  });

  it('keeps its answer when its reasoning names <tool_call> and its answer names </tool_call>', async () => {
    const id = 'r1_finished_think_tags';
    given(chat(id), [user(id, 1, 'hello'), reply(id, 2, 'Hi.')]);
    const answer = 'Qwen closes every call with </tool_call>, and the app reads the JSON inside.';
    const local = recordingBackend([`<think>They ask about the <tool_call> tag.</think>${answer}`]);
    engineWith(local);

    await useChats.getState().send('how does qwen close a call?');

    const last = assistantRows(id).at(-1)!;
    expect({ content: last.content, thinking: last.thinking, stopped: last.stopped }).toEqual({
      content: answer,
      thinking: 'They ask about the <tool_call> tag.',
      stopped: undefined,
    });
  });

  it('whose tool ran and whose follow-up was only a JSON function-schema example keeps the example', async () => {
    const id = 'r1_tool_ran_schema';
    given(chat(id, { tools: [leakyTool.id] }), [user(id, 1, 'hello'), reply(id, 2, 'Hi.')]);
    const local = recordingBackend([CALL, SCHEMA_EXAMPLE, 'Next.']);
    engineWith(local);

    try {
      toolRegistry.register(leakyTool);
      await useChats.getState().send('show me a tool definition');
      await useChats.getState().send('thanks');
    } finally {
      toolRegistry.unregister(leakyTool.id);
    }

    const ran = assistantRows(id)[1]!;
    expect(ran.toolCalls?.map((call) => call.name), 'the tool ran').toEqual(['leaky']);
    expect({ content: ran.content, stopped: ran.stopped }, 'the stored reply').toEqual({
      content: SCHEMA_EXAMPLE,
      stopped: undefined,
    });
    expect(spoken(local.seen[2]), 'the next request').toEqual([
      ['user', 'hello'],
      ['assistant', 'Hi.'],
      ['user', 'show me a tool definition'],
      ['assistant', SCHEMA_EXAMPLE],
      ['user', 'thanks'],
    ]);
  });
});

describe('a call whose string arguments hold a ")"', () => {
  const MEGAPIXELS = '[TOOL_CALLS] calculate({"expression": "(1920 * 1080) / 1000000"})';

  it('leaves none of the call in a finished reply whose follow-up wrote nothing, nor in the next request', async () => {
    const id = 'r1_paren_finished';
    given(chat(id, { tools: ['calculator'] }), [user(id, 1, 'hello'), reply(id, 2, 'Hi.')]);
    const local = recordingBackend([MEGAPIXELS, '', 'Next.']);
    engineWith(local);

    await useChats.getState().send('how many megapixels is 1080p?');
    await useChats.getState().send('and 4k?');

    const ran = assistantRows(id)[1]!;
    expect(ran.toolCalls?.map((call) => call.output), 'the calculator ran').toEqual(['(1920 * 1080) / 1000000 = 2.0736']);
    expect({ content: ran.content, stopped: ran.stopped }, 'the stored reply').toEqual({ content: '', stopped: false });
    expect(spoken(local.seen[2]), 'the next request').toEqual([
      ['user', 'hello'],
      ['assistant', 'Hi.'],
      ['user', 'how many megapixels is 1080p?'],
      ['user', 'and 4k?'],
    ]);
  });

  it('keeps only the words before it when the turn was stopped mid-arguments', async () => {
    const id = 'r1_paren_stopped';
    given(chat(id, { tools: ['calculator'] }), [user(id, 1, 'hello'), reply(id, 2, 'Hi.')]);
    const partial = 'Working it out.\n[TOOL_CALLS] calculate({"expression": "(1920 * 1080) / canary-7f3a';
    const gate = held();
    const local = scriptedBackend([{ partial, stall: gate.promise }, { reply: 'Fine.' }]);
    engineWith(local);

    await stopAfterSome('second', 'canary-7f3a', gate.release);
    await useChats.getState().send('third');

    expect(assistantRows(id)[1]?.content, 'the stopped reply, on disk').toBe('Working it out.');
    expect(JSON.stringify(local.seen[1]?.messages), 'the call’s arguments, sent back').not.toContain('canary-7f3a');
  });
});

describe('a finished reply in a chat offering tools, ending on a call marker', () => {
  for (const text of [
    'Mistral models put every call after the special token [TOOL_CALLS]',
    'Qwen and Hermes open every call with <tool_call>',
    'Before the name, Mistral writes its special [TOOL_CALLS] token',
  ]) {
    it(`keeps its last word: ${JSON.stringify(text.slice(-24))}`, async () => {
      const id = `r1_marker_${text.length}`;
      given(chat(id, { tools: [leakyTool.id] }), [user(id, 1, 'hello'), reply(id, 2, 'Hi.')]);
      const local = recordingBackend([text]);
      engineWith(local);

      try {
        toolRegistry.register(leakyTool);
        await useChats.getState().send('how is a call marked?');
      } finally {
        toolRegistry.unregister(leakyTool.id);
      }

      expect(local.seen[0]?.tools?.map((tool) => tool.name), 'the tools the request offered').toEqual(['leaky']);
      expect(assistantRows(id).at(-1)?.content, 'the words the person watched arrive').toBe(text);
    });
  }

  for (const text of ['Checking.\n<tool_call>{', 'Checking.\n[TOOL_CALLS] leaky(']) {
    it(`still stores none of a call cut off as it opened: ${JSON.stringify(text.slice(10))}`, async () => {
      const id = `r1_opened_${text.length}`;
      given(chat(id, { tools: [leakyTool.id] }), [user(id, 1, 'hello'), reply(id, 2, 'Hi.')]);
      const local = recordingBackend([text]);
      engineWith(local);

      try {
        toolRegistry.register(leakyTool);
        await useChats.getState().send('read my notes');
      } finally {
        toolRegistry.unregister(leakyTool.id);
      }

      expect(assistantRows(id).at(-1)?.content).toBe('Checking.');
    });
  }
});

describe('a turn stopped mid-arguments of a [TOOL_CALLS] call whose name is on the next line', () => {
  it('keeps the words before it and sends none of it back', async () => {
    const id = 'r1_mistral_newline';
    const partial = 'Reading it.\n[TOOL_CALLS]\nleaky({"path": "canary-7f3a';
    const gate = held();
    const local = scriptedBackend([{ partial, stall: gate.promise }, { reply: 'Fine.' }]);
    engineWith(local);

    await inToolsChat(id, async () => {
      await stopAfterSome('second', 'canary-7f3a', gate.release);
      await useChats.getState().send('third');
    });

    expect(assistantRows(id)[1]?.content).toBe('Reading it.');
    expect(JSON.stringify(local.seen[1]?.messages), 'the call’s arguments, sent back').not.toContain('canary-7f3a');
  });

  it('keeps the words before it when Stop landed on the name and its paren', async () => {
    const id = 'r1_mistral_newline_paren';
    const partial = 'Reading it.\n[TOOL_CALLS]\nleaky(';
    const gate = held();
    const local = scriptedBackend([{ partial, stall: gate.promise }]);
    engineWith(local);

    await inToolsChat(id, async () => {
      await stopAfterSome('second', 'leaky(', gate.release);
    });

    expect(assistantRows(id).at(-1)?.content).toBe('Reading it.');
  });
});

describe('a finished reply cut off as a [TOOL_CALLS] call opened with its name on the next line', () => {
  it('stores none of the call', async () => {
    const id = 'r1_mistral_newline_finished';
    given(chat(id, { tools: [leakyTool.id] }), [user(id, 1, 'hello'), reply(id, 2, 'Hi.')]);
    const local = recordingBackend(['Checking.\n[TOOL_CALLS]\nleaky(']);
    engineWith(local);

    try {
      toolRegistry.register(leakyTool);
      await useChats.getState().send('read my notes');
    } finally {
      toolRegistry.unregister(leakyTool.id);
    }

    expect(assistantRows(id).at(-1)?.content).toBe('Checking.');
  });
});

describe('words a model writes before a tool call that runs', () => {
  it('stay in the stored reply once the follow-up answers', async () => {
    const id = 'r1_words_before_call';
    given(chat(id, { tools: [leakyTool.id] }), [user(id, 1, 'hello'), reply(id, 2, 'Hi.')]);
    const local = recordingBackend([`Let me check your notes first.\n${CALL}`, 'They mention a passphrase.', 'Next.']);
    engineWith(local);

    try {
      toolRegistry.register(leakyTool);
      await useChats.getState().send('read my notes');
    } finally {
      toolRegistry.unregister(leakyTool.id);
    }

    const ran = assistantRows(id).at(-1)!;
    expect(ran.toolCalls?.map((call) => call.name), 'the tool ran').toEqual(['leaky']);
    expect(ran.content).toBe('Let me check your notes first.\n\nThey mention a passphrase.');
  });
});

describe('words a model writes before a tool call that runs, when the follow-up is stopped', () => {
  it('stay in the stored reply beside the follow-up’s words', async () => {
    const id = 'r1_words_before_call_stopped';
    given(chat(id, { tools: [leakyTool.id] }), [user(id, 1, 'hello'), reply(id, 2, 'Hi.')]);
    const gate = held();
    const local = scriptedBackend([
      { reply: `Let me check your notes first.\n${CALL}` },
      { partial: 'They mention a pass', stall: gate.promise },
    ]);
    engineWith(local);

    try {
      toolRegistry.register(leakyTool);
      await stopAfterSome('read my notes', 'They mention a pass', gate.release);
    } finally {
      toolRegistry.unregister(leakyTool.id);
    }

    const stopped = assistantRows(id).at(-1)!;
    expect(stopped.toolCalls?.map((call) => call.name), 'the tool ran').toEqual(['leaky']);
    expect({ content: stopped.content, stopped: stopped.stopped }, 'the stored reply').toEqual({
      content: 'Let me check your notes first.\nThey mention a pass',
      stopped: undefined,
    });
  });
});

describe('a finished reply that is only a malformed <tool_call>', () => {
  // Read past its trailing comma, it is the call it names, and it runs: the
  // stripper took it out of the words, and a call the words lose is a call.
  it('runs it, and stores and sends back none of its markup or arguments', async () => {
    const id = 'r1_malformed_call';
    given(chat(id, { tools: [leakyTool.id] }), [user(id, 1, 'hello'), reply(id, 2, 'Hi.')]);
    const malformed = '<tool_call>{"name": "leaky", "arguments": {"path": "canary-7f3a",}}</tool_call>';
    const local = recordingBackend([malformed, 'Next.']);
    engineWith(local);

    try {
      toolRegistry.register(leakyTool);
      await useChats.getState().send('read my notes');
      await useChats.getState().send('and then?');
    } finally {
      toolRegistry.unregister(leakyTool.id);
    }

    const last = assistantRows(id)[1]!;
    expect(last.toolCalls?.map((call) => call.input), 'the call that ran').toEqual([{ path: 'canary-7f3a' }]);
    expect({ content: last.content, stopped: last.stopped }, 'the stored reply').toEqual({
      content: 'Next.',
      stopped: undefined,
    });
    expect(refusals()).toEqual([]);
    expect(JSON.stringify(local.seen.at(-1)?.messages), 'the next request').not.toContain('tool_call');
    expect(JSON.stringify(local.seen.at(-1)?.messages), 'the next request').not.toContain('canary-7f3a');
  });
});

describe('a failed tool turn, tried again and flipped back to', () => {
  it('stores none of the call as its words and sends none of it', async () => {
    const id = 'r1_failed_tool_turn';
    given(chat(id, { tools: [leakyTool.id] }), [user(id, 1, 'hello'), reply(id, 2, 'Hi.')]);
    const local = scriptedBackend([
      { reply: 'Checking.\n<tool_call>{"name":"leaky","arguments":{"path":"canary-7f3a"}}</tool_call>' },
      { fail: 'the model crashed' },
      { reply: 'Again.' },
      { reply: 'Fine.' },
    ]);
    engineWith(local);

    try {
      toolRegistry.register(leakyTool);
      await useChats.getState().send('read my notes');

      const failed = assistantRows(id).at(-1)!;
      expect(failed.error, 'the turn failed').toBe('the model crashed');
      expect(failed.content, 'the failed row’s words').toBe('Checking.');

      await useChats.getState().regenerate(failed.id);
      const regenerated = useChats.getState().messages.at(-1)!;
      expect(regenerated.variants?.map((variant) => variant.content)).toEqual(['Checking.', 'Again.']);
      await useChats.getState().cycleVariant(regenerated.id, -1);
      await useChats.getState().send('next');
    } finally {
      toolRegistry.unregister(leakyTool.id);
    }

    const last = JSON.stringify(local.seen.at(-1)?.messages);
    expect(last, 'the request after flipping back').toContain('Checking.');
    expect(last, 'the request after flipping back').not.toContain('tool_call');
    expect(last, 'the request after flipping back').not.toContain('canary-7f3a');
  });
});


const { SECRET } = await import('./support/egress-probe');

describe('a turn killed after an MCP call left', () => {
  it('recovers with none of the call as its words, and regenerating and flipping back sends none of it', async () => {
    const id = 'r1_killed_after_call';
    const probe = mcpProbe();
    given(
      chat(id, {
        tools: [probe.tool.id],
        egressGrants: [{ kind: 'mcp', serverId: PROBE_SERVER.serverId, url: PROBE_SERVER.url, grantedAt: 1 }],
      }),
      [user(id, 1, 'hello'), reply(id, 2, 'Hi.')],
    );
    const gate = held();
    const local = scriptedBackend([
      { reply: `Filing it.\n${MCP_CALL}` },
      { stall: gate.promise },
      { reply: 'Again.' },
      { reply: 'Fine.' },
    ]);
    engineWith(local);

    try {
      toolRegistry.register(probe.tool);
      const sending = useChats.getState().send('file a note');
      await until(() => assistantRows(id).some((row) => row.streaming === true && (row.toolCalls?.length ?? 0) > 0));
      const midTurn = structuredClone(assistantRows(id).find((row) => row.streaming === true)!);
      expect(midTurn.content, 'the row written mid-turn').toBe('Filing it.');

      // The app is killed during the follow-up: what is on disk is the row
      // written mid-turn. The turn is ended here only so the test can go on.
      useChats.getState().stop();
      gate.release();
      await sending;
      fake.messages.set(midTurn.id, structuredClone(midTurn));
      useChats.setState({ activeChatId: null, messages: [] });

      await useChats.getState().openChat(id);
      const recovered = useChats.getState().messages.find((message) => message.id === midTurn.id)!;
      expect(recovered.error).toBe('This reply was interrupted before it finished.');
      expect(recovered.content, 'the recovered row’s words').toBe('Filing it.');

      await useChats.getState().regenerate(recovered.id);
      const regenerated = useChats.getState().messages.at(-1)!;
      expect(regenerated.variants?.map((variant) => variant.content)).toEqual(['Filing it.', 'Again.']);
      await useChats.getState().cycleVariant(regenerated.id, -1);
      await useChats.getState().send('next');
    } finally {
      toolRegistry.unregister(probe.tool.id);
    }

    expect(probe.call, 'the call went once').toHaveBeenCalledTimes(1);
    const last = JSON.stringify(local.seen.at(-1)?.messages);
    expect(last, 'the request after flipping back').toContain('Filing it.');
    expect(last, 'the request after flipping back').not.toContain('tool_call');
    expect(last, 'the request after flipping back').not.toContain(SECRET);
  });
});

/* ── Round 2: a JSON record is not a call ───────────────────────────── */

/** A data record whose most common key happens to be one a fenced call names its tool with. */
const RECORD = '```json\n{"name": "Alice Chen", "email": "alice@example.com", "age": 34}\n```';

describe('a JSON record with a "name" key, in a chat with a tool on', () => {
  it('stays whole in a reply stopped after it, with the prose around it, and is sent back', async () => {
    const id = 'r2_record_stopped';
    given(chat(id, { tools: ['calculator'] }), [user(id, 1, 'hello'), reply(id, 2, 'Hi.')]);
    const partial = `Here is a sample user record:\n\n${RECORD}\n\nYou can add more fields such as`;
    const gate = held();
    const local = scriptedBackend([{ partial, stall: gate.promise }, { reply: 'Fine.' }]);
    engineWith(local);

    await stopAfterSome('a sample user record as JSON, please', 'more fields such as', gate.release);
    await useChats.getState().send('thanks');

    expect(assistantRows(id)[1]?.content, 'the words the person watched arrive').toBe(partial);
    expect(spoken(local.seen[1]).at(-2), 'the next request').toEqual(['assistant', partial]);
  });

  it('is kept, and the reply not called stopped, when the record was all a stopped reply wrote', async () => {
    const id = 'r2_record_only_stopped';
    given(chat(id, { tools: ['calculator'] }), [user(id, 1, 'hello'), reply(id, 2, 'Hi.')]);
    const gate = held();
    const local = scriptedBackend([{ partial: RECORD, stall: gate.promise }]);
    engineWith(local);

    await stopAfterSome('a sample user record as JSON, please', '"age": 34', gate.release);

    const stopped = assistantRows(id).at(-1)!;
    expect({ content: stopped.content, stopped: stopped.stopped }, 'the stored reply').toEqual({
      content: RECORD,
      stopped: undefined,
    });
    await mounted(stopped, () => {
      expect(stoppedNote(), 'called stopped before its first word').toBeNull();
    });
  });

  it('is not run as a call to a tool named after its value, and stays in a finished reply', async () => {
    const id = 'r2_record_finished';
    given(chat(id, { tools: ['calculator'] }), [user(id, 1, 'hello'), reply(id, 2, 'Hi.')]);
    const text = `Here is a sample user record:\n\n${RECORD}\n\nYou can add more fields.`;
    const local = recordingBackend([text, 'Anything else?']);
    engineWith(local);

    await useChats.getState().send('a sample user record as JSON, please');

    const last = assistantRows(id).at(-1)!;
    expect(last.toolCalls, 'no tool ran').toBeUndefined();
    expect(local.seen, 'no follow-up request').toHaveLength(1);
    expect(last.content, 'the words the person watched arrive').toBe(text);
  });

  it('a flat tool definition naming an offered tool is read as a call to it, run, and stripped from a finished reply', async () => {
    // A CALL, by the owner's ruling: a fenced block runs when its name is a tool
    // the request offered, whatever keys beside it. Its `parameters` are read as
    // the arguments, as the extractor reads them. A nested definition, whose
    // `function` is an object, names no tool and is words: see tools.test.ts.
    const id = 'r2_offered_definition';
    given(chat(id, { tools: ['calculator'] }), [user(id, 1, 'hello'), reply(id, 2, 'Hi.')]);
    const text =
      'My calculator is declared like this:\n\n```json\n{"name": "calculate", "description": "Evaluate arithmetic", ' +
      '"parameters": {"type": "object", "properties": {"expression": {"type": "string"}}}}\n```';
    const local = recordingBackend([text, 'Anything else?']);
    engineWith(local);

    await useChats.getState().send('what tools do you have?');

    const last = assistantRows(id).at(-1)!;
    expect(last.toolCalls?.map((call) => call.name), 'the call ran').toEqual(['calculate']);
    expect(last.content, 'the stored reply').toBe('My calculator is declared like this:\n\nAnything else?');
  });
});

/* ── Round 5: a fenced call to an offered tool may carry more keys ─────── */

describe('a fenced call to an offered tool that carries an "id" key', () => {
  const ID_CANARY = 'call_canary_5e1d';
  const FENCED_WITH_ID = `\`\`\`json\n{"id": "${ID_CANARY}", "name": "calculate", "arguments": {"expression": "6*7"}}\n\`\`\``;

  it('runs, and none of it is stored in a finished reply or sent in the next request', async () => {
    const id = 'r5_fenced_id_finished';
    given(chat(id, { tools: ['calculator'] }), [user(id, 1, 'hello'), reply(id, 2, 'Hi.')]);
    const local = recordingBackend([`Let me work it out.\n\n${FENCED_WITH_ID}`, 'It is 42.', 'Fine.']);
    engineWith(local);

    await useChats.getState().send('what is six times seven?');
    await useChats.getState().send('thanks');

    const ran = assistantRows(id)[1]!;
    expect(ran.toolCalls?.map((call) => call.output), 'the calculator ran').toEqual(['6*7 = 42']);
    expect({ content: ran.content, stopped: ran.stopped }, 'the stored reply').toEqual({
      content: 'Let me work it out.\n\nIt is 42.',
      stopped: undefined,
    });
    expect(local.seen, 'the follow-up and the next turn').toHaveLength(3);
    expect(JSON.stringify(local.seen[2]?.messages), 'the next request').not.toContain(ID_CANARY);
    expect(JSON.stringify(local.seen[2]?.messages), 'the next request').not.toContain('```');
  });

  it('runs, and none of it is stored when the follow-up is stopped', async () => {
    const id = 'r5_fenced_id_stopped';
    given(chat(id, { tools: ['calculator'] }), [user(id, 1, 'hello'), reply(id, 2, 'Hi.')]);
    const gate = held();
    const local = scriptedBackend([
      { reply: `Let me work it out.\n\n${FENCED_WITH_ID}` },
      { partial: 'It is fort', stall: gate.promise },
    ]);
    engineWith(local);

    await stopAfterSome('what is six times seven?', 'It is fort', gate.release);

    const stopped = assistantRows(id).at(-1)!;
    expect(stopped.toolCalls?.map((call) => call.output), 'the calculator ran').toEqual(['6*7 = 42']);
    expect(stopped.stopped, 'called stopped before its first word').not.toBe(true);
    expect(stopped.content, 'the stored reply').not.toContain(ID_CANARY);
    expect(stopped.content, 'the stored reply').not.toContain('```');
    expect(stopped.content, 'the words the person watched arrive').toMatch(/^Let me work it out\.\s+It is fort$/);
  });
});

/* ── Round 2: a fenced block names a tool the turn offered, or is words ─ */

describe('a fenced call example in a chat whose tool ids name nothing connected', () => {
  const GONE = 'mcp:gone-server:note';
  const EXAMPLE_CALL = '```json\n{"tool": "search", "arguments": {"query": "weather"}}\n```';

  it('stays in a reply stopped after it', async () => {
    const id = 'r2_gone_fenced_stopped';
    given(chat(id, { tools: [GONE] }), [user(id, 1, 'hello'), reply(id, 2, 'Hi.')]);
    const partial = `Configure the agent like this:\n\n${EXAMPLE_CALL}\n\nThen restart`;
    const gate = held();
    const local = scriptedBackend([{ partial, stall: gate.promise }]);
    engineWith(local);

    await stopAfterSome('what goes in the config?', 'Then restart', gate.release);

    expect(local.seen[0]?.tools ?? [], 'the tools the request offered').toEqual([]);
    expect(assistantRows(id).at(-1)?.content, 'the words the person watched arrive').toBe(partial);
  });

  it('stays in a reply whose stream failed after it', async () => {
    const id = 'r2_gone_fenced_failed';
    given(chat(id, { tools: [GONE] }), [user(id, 1, 'hello'), reply(id, 2, 'Hi.')]);
    const partial = `Configure the agent like this:\n\n${EXAMPLE_CALL}\n\nThen restart`;
    const gate = held();
    const local = scriptedBackend([{ partial, stall: gate.promise }]);
    engineWith(local);

    const sending = useChats.getState().send('what goes in the config?');
    await until(() => useChats.getState().messages.some((message) => message.content.includes('Then restart')));
    // Released with nobody pressing Stop: the stream fails.
    gate.release();
    await sending;

    const failed = assistantRows(id).at(-1)!;
    expect(failed.error, 'the turn failed').toBeDefined();
    expect(failed.content, 'the words the person watched arrive').toBe(partial);
  });

  it('is not run, and stays in a finished reply', async () => {
    const id = 'r2_gone_fenced_finished';
    given(chat(id, { tools: [GONE] }), [user(id, 1, 'hello'), reply(id, 2, 'Hi.')]);
    const text = `Configure the agent like this:\n\n${EXAMPLE_CALL}\n\nThen restart it.`;
    const local = recordingBackend([text, 'Anything else?']);
    engineWith(local);

    await useChats.getState().send('what goes in the config?');

    const last = assistantRows(id).at(-1)!;
    expect(last.toolCalls, 'no tool ran').toBeUndefined();
    expect(last.content, 'the words the person watched arrive').toBe(text);
  });
});

describe('a fenced block naming a tool the chat does not offer, in a chat with a tool on', () => {
  it('is not run, and stays in a finished reply', async () => {
    const id = 'r2_unoffered_fenced';
    given(chat(id, { tools: ['calculator'] }), [user(id, 1, 'hello'), reply(id, 2, 'Hi.')]);
    const text = 'Here is a person:\n\n```json\n{"name": "Alice Chen"}\n```\n\nAdd more fields as you need them.';
    const local = recordingBackend([text, 'Anything else?']);
    engineWith(local);

    await useChats.getState().send('a minimal person record, please');

    const last = assistantRows(id).at(-1)!;
    expect(last.toolCalls, 'no tool ran').toBeUndefined();
    expect(last.content, 'the words the person watched arrive').toBe(text);
  });
});

/* ── Round 2: in a turn that offered no tool, a call's format is words ─ */

describe('a reply that shows a model’s tool-call format, in a chat with no tools', () => {
  const EXAMPLES = [
    'Qwen formats a call like this:\n\n```\n<tool_call>\n{"name": "get_weather", "arguments": {"city": "Paris"}}\n</tool_call>\n```\n\nThe app reads the JSON between the tags.',
    'The chat template says:\n\n```\n<tool_call>\n{"name": <function-name>, "arguments": <args-json-object>}\n</tool_call>\n```\n\nand fills in both.',
    'Mistral writes a call as `[TOOL_CALLS] get_weather({"city": "Paris"})`, and the app reads the JSON inside the parentheses.',
  ];

  for (const [index, text] of EXAMPLES.entries()) {
    it(`keeps the example in a finished reply, and sends it back: ${JSON.stringify(text.slice(0, 24))}`, async () => {
      const id = `r2_no_tools_format_${index}`;
      given(chat(id), [user(id, 1, 'hello'), reply(id, 2, 'Hi.')]);
      const local = recordingBackend([text, 'Fine.']);
      engineWith(local);

      await useChats.getState().send('how does a model format a tool call?');
      await useChats.getState().send('thanks');

      expect(local.seen[0]?.tools ?? [], 'the tools the request offered').toEqual([]);
      expect(assistantRows(id)[1]?.content, 'the words the person watched arrive').toBe(text);
      expect(spoken(local.seen[1]).at(-2), 'the next request').toEqual(['assistant', text]);
    });
  }

  it('keeps the example in a reply stopped after it', async () => {
    const id = 'r2_no_tools_format_stopped';
    given(chat(id), [user(id, 1, 'hello'), reply(id, 2, 'Hi.')]);
    const partial = `${EXAMPLES[0]!} Each call`;
    const gate = held();
    const local = scriptedBackend([{ partial, stall: gate.promise }]);
    engineWith(local);

    await stopAfterSome('how does a model format a tool call?', 'Each call', gate.release);

    expect(assistantRows(id).at(-1)?.content, 'the words the person watched arrive').toBe(partial);
  });
});

/* ── Round 2: a tool round's reasoning ends with the round ──────────── */

describe('a tool round whose reasoning was left open', () => {
  it('keeps the follow-up’s answer as the finished reply’s words, and sends it back', async () => {
    const id = 'r2_open_think_finished';
    given(chat(id, { tools: [leakyTool.id] }), [user(id, 1, 'hello'), reply(id, 2, 'Hi.')]);
    const local = recordingBackend([`<think>I should read the notes first.\n${CALL}`, 'They mention a passphrase.', 'Next.']);
    engineWith(local);

    try {
      toolRegistry.register(leakyTool);
      await useChats.getState().send('read my notes');
      await useChats.getState().send('and then?');
    } finally {
      toolRegistry.unregister(leakyTool.id);
    }

    const ran = assistantRows(id)[1]!;
    expect(ran.toolCalls?.map((call) => call.name), 'the tool ran').toEqual(['leaky']);
    expect({ content: ran.content, thinking: ran.thinking, stopped: ran.stopped }, 'the stored reply').toEqual({
      content: 'They mention a passphrase.',
      thinking: 'I should read the notes first.',
      stopped: undefined,
    });
    expect(spoken(local.seen[2]).at(-2), 'the next request').toEqual(['assistant', 'They mention a passphrase.']);
  });

  it('keeps the follow-up’s answer when the calling round named <think> in its words', async () => {
    const id = 'r2_named_think_finished';
    given(chat(id, { tools: [leakyTool.id] }), [user(id, 1, 'hello'), reply(id, 2, 'Hi.')]);
    const local = recordingBackend([`Qwen reasons inside a <think> block. Let me check.\n${CALL}`, 'They mention a passphrase.']);
    engineWith(local);

    try {
      toolRegistry.register(leakyTool);
      await useChats.getState().send('read my notes');
    } finally {
      toolRegistry.unregister(leakyTool.id);
    }

    expect(assistantRows(id).at(-1)?.content, 'the stored reply').toContain('They mention a passphrase.');
  });

  it('keeps the words a stopped follow-up wrote, and is not called stopped', async () => {
    const id = 'r2_open_think_stopped';
    given(chat(id, { tools: [leakyTool.id] }), [user(id, 1, 'hello'), reply(id, 2, 'Hi.')]);
    const gate = held();
    const local = scriptedBackend([
      { reply: `<think>I should read the notes first.\n${CALL}` },
      { partial: 'They mention a pass', stall: gate.promise },
    ]);
    engineWith(local);

    try {
      toolRegistry.register(leakyTool);
      const sending = useChats.getState().send('read my notes');
      await until(() => {
        const live = useChats.getState().messages.at(-1);
        return `${live?.content ?? ''}${live?.thinking ?? ''}`.includes('They mention a pass');
      });
      useChats.getState().stop();
      gate.release();
      await sending;
    } finally {
      toolRegistry.unregister(leakyTool.id);
    }

    const stopped = assistantRows(id).at(-1)!;
    expect(stopped.toolCalls?.map((call) => call.name), 'the tool ran').toEqual(['leaky']);
    expect({ content: stopped.content, stopped: stopped.stopped }, 'the stored reply').toEqual({
      content: 'They mention a pass',
      stopped: undefined,
    });
    expect(stopped.thinking, 'the reasoning').toContain('I should read the notes first.');
  });
});

/* ── Round 2: a call with one closing bracket too many ──────────────── */

describe('a call written with one closing brace too many', () => {
  const CASES = [
    ['a <tool_call>', 'Let me look.\n<tool_call>{"name": "leaky", "arguments": {"path": "canary-7f3a"}}}</tool_call>'],
    ['a [TOOL_CALLS] call', 'Let me look. [TOOL_CALLS] leaky({"path": "canary-7f3a"}})'],
  ] as const;

  // Each is the call it names, and runs: see "a call in a shape the stripper
  // took out and the reader did not read".
  for (const [form, text] of CASES) {
    it(`in ${form} after words: a finished reply runs it, and stores and sends back none of it`, async () => {
      const id = `r2_extra_brace_${form.length}`;
      given(chat(id, { tools: [leakyTool.id] }), [user(id, 1, 'hello'), reply(id, 2, 'Hi.')]);
      const local = recordingBackend([text, 'Next.']);
      engineWith(local);

      try {
        toolRegistry.register(leakyTool);
        await useChats.getState().send('read my notes');
        await useChats.getState().send('and then?');
      } finally {
        toolRegistry.unregister(leakyTool.id);
      }

      const stored = assistantRows(id)[1]!;
      expect(stored.toolCalls?.map((call) => call.input), 'the call that ran').toEqual([{ path: 'canary-7f3a' }]);
      expect(stored.content, 'the stored reply').toBe('Let me look.\n\nNext.');
      expect(JSON.stringify(local.seen.at(-1)?.messages), 'the next request').not.toContain('canary-7f3a');
    });
  }

  it('that was all a finished reply wrote: runs it, and stores and sends back none of it', async () => {
    const id = 'r2_extra_brace_only';
    given(chat(id, { tools: [leakyTool.id] }), [user(id, 1, 'hello'), reply(id, 2, 'Hi.')]);
    const local = recordingBackend(['<tool_call>{"name": "leaky", "arguments": {"path": "canary-7f3a"}}}</tool_call>', 'Next.']);
    engineWith(local);

    try {
      toolRegistry.register(leakyTool);
      await useChats.getState().send('read my notes');
      await useChats.getState().send('and then?');
    } finally {
      toolRegistry.unregister(leakyTool.id);
    }

    const stored = assistantRows(id)[1]!;
    expect(stored.toolCalls?.map((call) => call.name), 'the call that ran').toEqual(['leaky']);
    expect({ content: stored.content, stopped: stored.stopped }, 'the stored reply').toEqual({
      content: 'Next.',
      stopped: undefined,
    });
    expect(JSON.stringify(local.seen.at(-1)?.messages), 'the next request').not.toContain('tool_call');
    expect(JSON.stringify(local.seen.at(-1)?.messages), 'the next request').not.toContain('canary-7f3a');
  });

  it('stopped before its closing tag: keeps only the words before it', async () => {
    const id = 'r2_extra_brace_stopped';
    const partial = 'Let me look.\n<tool_call>{"name": "notes.note", "arguments": {"text": "canary-7f3a"}}}</tool_';
    const gate = held();
    const local = scriptedBackend([{ partial, stall: gate.promise }, { reply: 'Fine.' }]);
    engineWith(local);

    await inToolsChat(id, async () => {
      await stopAfterSome('file a note', '</tool_', gate.release);
      await useChats.getState().send('third');
    });

    expect(assistantRows(id)[1]?.content, 'the stored reply').toBe('Let me look.');
    expect(JSON.stringify(local.seen[1]?.messages), 'the next request').not.toContain('canary-7f3a');
  });
});

/* ── Round 2: a <tool_call> whose body is Qwen3-Coder's XML ─────────── */

describe('a Qwen3-Coder <tool_call> with an XML body', () => {
  const XML_CALL = '<tool_call>\n<function=leaky>\n<parameter=path>\ncanary-7f3a\n</parameter>\n</function>\n</tool_call>';

  it('after words: a finished reply runs it, and stores and sends back none of it', async () => {
    const id = 'r2_xml_finished';
    given(chat(id, { tools: [leakyTool.id] }), [user(id, 1, 'hello'), reply(id, 2, 'Hi.')]);
    const local = recordingBackend([`Let me check.\n${XML_CALL}`, 'Next.']);
    engineWith(local);

    try {
      toolRegistry.register(leakyTool);
      await useChats.getState().send('read my notes');
      await useChats.getState().send('and then?');
    } finally {
      toolRegistry.unregister(leakyTool.id);
    }

    const stored = assistantRows(id)[1]!;
    expect(stored.toolCalls?.map((call) => call.input), 'the call that ran').toEqual([{ path: 'canary-7f3a' }]);
    expect(stored.content, 'the stored reply').toBe('Let me check.\n\nNext.');
    expect(JSON.stringify(local.seen.at(-1)?.messages), 'the next request').not.toContain('tool_call');
    expect(JSON.stringify(local.seen.at(-1)?.messages), 'the next request').not.toContain('canary-7f3a');
  });

  it('stopped inside a parameter: keeps only the words before it', async () => {
    const id = 'r2_xml_stopped';
    const partial = 'Let me check.\n<tool_call>\n<function=notes.note>\n<parameter=text>\ncanary-7f3a';
    const gate = held();
    const local = scriptedBackend([{ partial, stall: gate.promise }, { reply: 'Fine.' }]);
    engineWith(local);

    await inToolsChat(id, async () => {
      await stopAfterSome('file a note', 'canary-7f3a', gate.release);
      await useChats.getState().send('third');
    });

    expect(assistantRows(id)[1]?.content, 'the stored reply').toBe('Let me check.');
    expect(JSON.stringify(local.seen[1]?.messages), 'the next request').not.toContain('canary-7f3a');
  });

  it('keeps prose that names the XML form’s tags, stopped or finished', async () => {
    const id = 'r2_xml_prose';
    const partial =
      'Qwen3-Coder opens a call with `<tool_call><function=name>` and closes it with `</function></tool_call>`, and the app reads';
    const gate = held();
    const local = scriptedBackend([{ partial, stall: gate.promise }]);
    engineWith(local);

    await inToolsChat(id, async () => {
      await stopAfterSome('how does qwen3-coder mark a call?', 'the app reads', gate.release);
    });

    expect(assistantRows(id).at(-1)?.content, 'the words the person watched arrive').toBe(partial);
  });
});

/* ── Round 2: a fenced call wrapped in <tool_call> tags ─────────────── */

describe('a tool call written as a fenced block inside <tool_call> tags', () => {
  const WRAPPED =
    'Checking.\n<tool_call>\n```json\n{"name":"leaky","arguments":{"path":"canary-7f3a"}}\n```\n</tool_call>';

  it('leaves none of its tags in a failed follow-up’s words, tried again and flipped back to', async () => {
    const id = 'r2_wrapped_failed';
    given(chat(id, { tools: [leakyTool.id] }), [user(id, 1, 'hello'), reply(id, 2, 'Hi.')]);
    const local = scriptedBackend([
      { reply: WRAPPED },
      { fail: 'the model crashed' },
      { reply: 'Again.' },
      { reply: 'Fine.' },
    ]);
    engineWith(local);

    try {
      toolRegistry.register(leakyTool);
      await useChats.getState().send('read my notes');
      const failed = assistantRows(id).at(-1)!;
      expect(failed.toolCalls?.map((call) => call.name), 'the tool ran').toEqual(['leaky']);
      expect(failed.error, 'the turn failed').toBe('the model crashed');
      expect(failed.content, 'the failed row’s words').toBe('Checking.');
      await useChats.getState().regenerate(failed.id);
      const regenerated = useChats.getState().messages.at(-1)!;
      await useChats.getState().cycleVariant(regenerated.id, -1);
      await useChats.getState().send('next');
    } finally {
      toolRegistry.unregister(leakyTool.id);
    }

    const last = JSON.stringify(local.seen.at(-1)?.messages);
    expect(last, 'the request after flipping back').toContain('Checking.');
    expect(last, 'the request after flipping back').not.toContain('tool_call');
    expect(last, 'the request after flipping back').not.toContain('canary-7f3a');
  });

  it('leaves none of its tags in a stopped follow-up’s words, nor in the next request', async () => {
    const id = 'r2_wrapped_stopped';
    given(chat(id, { tools: [leakyTool.id] }), [user(id, 1, 'hello'), reply(id, 2, 'Hi.')]);
    const gate = held();
    const local = scriptedBackend([{ reply: WRAPPED }, { partial: 'Found your', stall: gate.promise }, { reply: 'Fine.' }]);
    engineWith(local);

    try {
      toolRegistry.register(leakyTool);
      await stopAfterSome('read my notes', 'Found your', gate.release);
      const stopped = assistantRows(id).at(-1)!;
      expect(stopped.toolCalls?.map((call) => call.name), 'the tool ran').toEqual(['leaky']);
      expect(stopped.content, 'the stored reply').toBe('Checking.\nFound your');
      await useChats.getState().send('next');
    } finally {
      toolRegistry.unregister(leakyTool.id);
    }

    expect(JSON.stringify(local.seen.at(-1)?.messages), 'the next request').not.toContain('tool_call');
  });

  it('is cut from a finished reply cut off as its JSON opened', async () => {
    const id = 'r2_wrapped_finished_opened';
    given(chat(id, { tools: [leakyTool.id] }), [user(id, 1, 'hello'), reply(id, 2, 'Hi.')]);
    const local = recordingBackend(['Checking.\n<tool_call>\n```json\n{']);
    engineWith(local);

    try {
      toolRegistry.register(leakyTool);
      await useChats.getState().send('read my notes');
    } finally {
      toolRegistry.unregister(leakyTool.id);
    }

    expect(assistantRows(id).at(-1)?.content, 'the stored reply').toBe('Checking.');
  });

  it('is cut from a turn stopped as its fence opened', async () => {
    const id = 'r2_wrapped_fence_opened';
    const partial = 'Checking.\n<tool_call>\n```json\n';
    const gate = held();
    const local = scriptedBackend([{ partial, stall: gate.promise }]);
    engineWith(local);

    await inToolsChat(id, async () => {
      await stopAfterSome('file a note', '```json', gate.release);
    });

    expect(assistantRows(id).at(-1)?.content, 'the stored reply').toBe('Checking.');
  });

  it('is cut from a turn stopped inside it', async () => {
    const id = 'r2_wrapped_unfinished';
    const partial = 'Checking.\n<tool_call>\n```json\n{"name":"notes.note","arguments":{"text":"canary-7f3a';
    const gate = held();
    const local = scriptedBackend([{ partial, stall: gate.promise }, { reply: 'Fine.' }]);
    engineWith(local);

    await inToolsChat(id, async () => {
      await stopAfterSome('file a note', 'canary-7f3a', gate.release);
      await useChats.getState().send('third');
    });

    expect(assistantRows(id)[1]?.content, 'the stored reply').toBe('Checking.');
    expect(JSON.stringify(local.seen[1]?.messages), 'the next request').not.toContain('canary-7f3a');
  });
});

describe('a fenced call wrapped in <tool_call> tags, stopped before its closing tag', () => {
  it('keeps only the words before it, and sends none of it back', async () => {
    const id = 'r2_wrapped_closing_tag';
    const partial =
      'Checking.\n<tool_call>\n```json\n{"name":"notes.note","arguments":{"text":"canary-7f3a"}}\n```\n</tool_';
    const gate = held();
    const local = scriptedBackend([{ partial, stall: gate.promise }, { reply: 'Fine.' }]);
    engineWith(local);

    await inToolsChat(id, async () => {
      await stopAfterSome('file a note', '</tool_', gate.release);
      await useChats.getState().send('third');
    });

    expect(assistantRows(id)[1]?.content, 'the stored reply').toBe('Checking.');
    expect(JSON.stringify(local.seen[1]?.messages), 'the next request').not.toContain('canary-7f3a');
  });
});

describe('a fenced call wrapped in <tool_call> tags, stopped on its closing fence', () => {
  it('keeps only the words before it, and sends none of it back', async () => {
    const id = 'r2_wrapped_closing_fence';
    const partial = 'Checking.\n<tool_call>\n```json\n{"name":"notes.note","arguments":{"text":"canary-7f3a"}}\n``';
    const gate = held();
    const local = scriptedBackend([{ partial, stall: gate.promise }, { reply: 'Fine.' }]);
    engineWith(local);

    await inToolsChat(id, async () => {
      await stopAfterSome('file a note', '}}\n``', gate.release);
      await useChats.getState().send('third');
    });

    expect(assistantRows(id)[1]?.content, 'the stored reply').toBe('Checking.');
    expect(JSON.stringify(local.seen[1]?.messages), 'the next request').not.toContain('canary-7f3a');
  });
});

/* ── Round 3: a call with a closing brace too few ───────────────────── */

/**
 * A call with one closing brace too few, ended by its closing tag. Its JSON never
 * closes, so it was read as a call still being written, and everything after it
 * was cut. Read with the missing brace, it is the call it names, and runs.
 */
const SHORT_BRACE = '<tool_call>{"name": "leaky", "arguments": {"path": "canary-7f3a"}</tool_call>';

describe('a call written with a closing brace too few', () => {
  it('between words: a finished reply runs it, keeps the words after it, and stores and sends none of the call', async () => {
    const id = 'r3_short_brace_finished';
    given(chat(id, { tools: [leakyTool.id] }), [user(id, 1, 'hello'), reply(id, 2, 'Hi.')]);
    const local = recordingBackend([`Let me look.\n${SHORT_BRACE}\nI have asked for your notes; one moment.`, 'Next.']);
    engineWith(local);

    try {
      toolRegistry.register(leakyTool);
      await useChats.getState().send('read my notes');
      await useChats.getState().send('and then?');
    } finally {
      toolRegistry.unregister(leakyTool.id);
    }

    const stored = assistantRows(id)[1]!;
    expect(stored.toolCalls?.map((call) => call.input), 'the call that ran').toEqual([{ path: 'canary-7f3a' }]);
    expect(stored.content, 'the stored reply').toBe('Let me look.\n\nI have asked for your notes; one moment.\n\nNext.');
    expect(JSON.stringify(local.seen.at(-1)?.messages), 'the next request').not.toContain('tool_call');
    expect(JSON.stringify(local.seen.at(-1)?.messages), 'the next request').not.toContain('canary-7f3a');
  });

  for (const [before, expected] of [
    ['Let me look.\n', 'Let me look.\n\nThey mention a passphrase.'],
    ['', 'They mention a passphrase.'],
  ] as const) {
    it(`beside a call that ran${before ? ', after words' : ''}: a finished turn keeps the follow-up’s answer, and sends it back`, async () => {
      const id = `r3_short_brace_ran_${before.length}`;
      given(chat(id, { tools: [leakyTool.id] }), [user(id, 1, 'hello'), reply(id, 2, 'Hi.')]);
      const local = recordingBackend([`${before}${SHORT_BRACE}\n${CALL}`, 'They mention a passphrase.', 'Next.']);
      engineWith(local);

      try {
        toolRegistry.register(leakyTool);
        await useChats.getState().send('read my notes');
        await useChats.getState().send('and then?');
      } finally {
        toolRegistry.unregister(leakyTool.id);
      }

      const ran = assistantRows(id)[1]!;
      expect(ran.toolCalls?.map((call) => call.name), 'both calls ran').toEqual(['leaky', 'leaky']);
      expect({ content: ran.content, stopped: ran.stopped }, 'the stored reply').toEqual({
        content: expected,
        stopped: undefined,
      });
      expect(spoken(local.seen[2]).at(-2), 'the next request').toEqual(['assistant', expected]);
      expect(JSON.stringify(local.seen[2]?.messages), 'the next request').not.toContain('canary-7f3a');
    });
  }

  it('beside a call that ran: a stopped follow-up keeps its words, is not called stopped, and sends none of the call', async () => {
    const id = 'r3_short_brace_stopped';
    given(chat(id, { tools: [leakyTool.id] }), [user(id, 1, 'hello'), reply(id, 2, 'Hi.')]);
    const gate = held();
    const local = scriptedBackend([
      { reply: `${SHORT_BRACE}\n${CALL}` },
      { partial: 'They mention a pass', stall: gate.promise },
      { reply: 'Fine.' },
    ]);
    engineWith(local);

    let stopped: Message | undefined;
    try {
      toolRegistry.register(leakyTool);
      await stopAfterSome('read my notes', 'They mention a pass', gate.release);
      stopped = assistantRows(id).at(-1);
      await useChats.getState().send('next');
    } finally {
      toolRegistry.unregister(leakyTool.id);
    }

    expect(stopped?.toolCalls?.map((call) => call.name), 'both calls ran').toEqual(['leaky', 'leaky']);
    expect({ content: stopped?.content, stopped: stopped?.stopped }, 'the stored reply').toEqual({
      content: 'They mention a pass',
      stopped: undefined,
    });
    await mounted(stopped!, () => {
      expect(stoppedNote(), 'called stopped before its first word').toBeNull();
    });
    expect(JSON.stringify(local.seen.at(-1)?.messages), 'the next request').not.toContain('tool_call');
    expect(JSON.stringify(local.seen.at(-1)?.messages), 'the next request').not.toContain('canary-7f3a');
  });
});

/* ── Round 3: a tool round that ends inside a call ──────────────────── */

/** A second call cut off in its arguments, as a round that hit its token limit leaves one. */
const HALF_CALL = '<tool_call>{"name": "leaky", "arguments": {"path": "canary-7f3a';

/** A second call whose JSON closed with no closing tag after it. */
const UNTAGGED_CALL = '<tool_call>{"name":"leaky","arguments":{"path":"canary-7f3a"}}';

/** A tool turn's calling round: words, a call that runs, then `tail`, where the round ends. */
const roundEndingIn = (tail: string): string => `Reading both.\n${CALL}\n${tail}`;

describe('a finished tool turn whose calling round ended inside a second call', () => {
  for (const [form, tail] of [
    ['half-written', HALF_CALL],
    ['with no closing tag', UNTAGGED_CALL],
  ] as const) {
    it(`${form}: keeps the follow-up’s answer, and stores and sends none of the call`, async () => {
      const id = `r3_round_${form.length}`;
      given(chat(id, { tools: [leakyTool.id] }), [user(id, 1, 'hello'), reply(id, 2, 'Hi.')]);
      const local = recordingBackend([roundEndingIn(tail), 'They mention a passphrase.', 'Next.']);
      engineWith(local);

      try {
        toolRegistry.register(leakyTool);
        await useChats.getState().send('read my notes');
        await useChats.getState().send('and then?');
      } finally {
        toolRegistry.unregister(leakyTool.id);
      }

      const ran = assistantRows(id)[1]!;
      expect(ran.toolCalls?.map((call) => call.name), 'the tool ran').toEqual(['leaky']);
      expect(ran.content, 'the stored reply').toBe('Reading both.\n\nThey mention a passphrase.');
      expect(spoken(local.seen[2]).at(-2), 'the next request').toEqual([
        'assistant',
        'Reading both.\n\nThey mention a passphrase.',
      ]);
      expect(JSON.stringify(local.seen[2]?.messages), 'the next request').not.toContain('tool_call');
      expect(JSON.stringify(local.seen[2]?.messages), 'the next request').not.toContain('canary-7f3a');
    });
  }

  it('keeps the calling round’s words written after a call with a closing brace too few', async () => {
    const id = 'r3_round_short_brace_words';
    given(chat(id, { tools: [leakyTool.id] }), [user(id, 1, 'hello'), reply(id, 2, 'Hi.')]);
    const local = recordingBackend([
      `Let me look.\n${SHORT_BRACE}\nI have asked for your notes.\n${CALL}`,
      'They mention a passphrase.',
    ]);
    engineWith(local);

    try {
      toolRegistry.register(leakyTool);
      await useChats.getState().send('read my notes');
    } finally {
      toolRegistry.unregister(leakyTool.id);
    }

    const ran = assistantRows(id).at(-1)!;
    expect(ran.toolCalls?.map((call) => call.name), 'both calls ran').toEqual(['leaky', 'leaky']);
    expect(ran.content, 'the stored reply').toBe(
      'Let me look.\n\nI have asked for your notes.\n\nThey mention a passphrase.',
    );
  });

  it('keeps the calling round’s words when its reasoning named a call it did not finish', async () => {
    const id = 'r3_round_reasoning_names_call';
    given(chat(id, { tools: [leakyTool.id] }), [user(id, 1, 'hello'), reply(id, 2, 'Hi.')]);
    const local = recordingBackend([
      `<think>A call opens [TOOL_CALLS] leaky({"path": "</think>Let me look.\n${CALL}`,
      'They mention a passphrase.',
    ]);
    engineWith(local);

    try {
      toolRegistry.register(leakyTool);
      await useChats.getState().send('read my notes');
    } finally {
      toolRegistry.unregister(leakyTool.id);
    }

    const ran = assistantRows(id).at(-1)!;
    expect(ran.toolCalls?.map((call) => call.name), 'the tool ran').toEqual(['leaky']);
    expect(ran.content, 'the stored reply').toBe('Let me look.\n\nThey mention a passphrase.');
    expect(ran.thinking, 'the reasoning').toContain('A call opens');
  });
});

/* ── Round 3: a stopped or failed turn read round by round ──────────── */

describe('a stopped follow-up after a calling round that ended inside a second call', () => {
  for (const [form, tail] of [
    ['half-written', HALF_CALL],
    ['with no closing tag', UNTAGGED_CALL],
  ] as const) {
    it(`${form}: keeps both rounds’ words, and stores and sends none of the call`, async () => {
      const id = `r3_round_stopped_${form.length}`;
      given(chat(id, { tools: [leakyTool.id] }), [user(id, 1, 'hello'), reply(id, 2, 'Hi.')]);
      const gate = held();
      const local = scriptedBackend([
        { reply: roundEndingIn(tail) },
        { partial: 'They mention a pass', stall: gate.promise },
        { reply: 'Fine.' },
      ]);
      engineWith(local);

      let stopped: Message | undefined;
      try {
        toolRegistry.register(leakyTool);
        await stopAfterSome('read my notes', 'They mention a pass', gate.release);
        stopped = assistantRows(id).at(-1);
        await useChats.getState().send('thanks');
      } finally {
        toolRegistry.unregister(leakyTool.id);
      }

      expect(stopped?.toolCalls?.map((call) => call.name), 'the tool ran').toEqual(['leaky']);
      expect({ content: stopped?.content, stopped: stopped?.stopped }, 'the stored reply').toEqual({
        content: 'Reading both.\n\nThey mention a pass',
        stopped: undefined,
      });
      expect(JSON.stringify(local.seen.at(-1)?.messages), 'the next request').not.toContain('tool_call');
      expect(JSON.stringify(local.seen.at(-1)?.messages), 'the next request').not.toContain('canary-7f3a');
    });
  }

  it('keeps the calling round’s words written after a call with a closing brace too few', async () => {
    const id = 'r3_round_stopped_short_brace_words';
    given(chat(id, { tools: [leakyTool.id] }), [user(id, 1, 'hello'), reply(id, 2, 'Hi.')]);
    const gate = held();
    const local = scriptedBackend([
      { reply: `Let me look.\n${SHORT_BRACE}\nI have asked for your notes.\n${CALL}` },
      { partial: 'They mention a pass', stall: gate.promise },
    ]);
    engineWith(local);

    try {
      toolRegistry.register(leakyTool);
      await stopAfterSome('read my notes', 'They mention a pass', gate.release);
    } finally {
      toolRegistry.unregister(leakyTool.id);
    }

    expect(assistantRows(id).at(-1)?.content, 'the stored reply').toBe(
      'Let me look.\n\nI have asked for your notes.\nThey mention a pass',
    );
  });

  it('keeps the calling round’s words when its reasoning named a call it did not finish', async () => {
    const id = 'r3_round_stopped_reasoning_names_call';
    given(chat(id, { tools: [leakyTool.id] }), [user(id, 1, 'hello'), reply(id, 2, 'Hi.')]);
    const gate = held();
    const local = scriptedBackend([
      { reply: `<think>A call opens [TOOL_CALLS] leaky({"path": "</think>Let me look.\n${CALL}` },
      { partial: 'They mention a pass', stall: gate.promise },
    ]);
    engineWith(local);

    try {
      toolRegistry.register(leakyTool);
      await stopAfterSome('read my notes', 'They mention a pass', gate.release);
    } finally {
      toolRegistry.unregister(leakyTool.id);
    }

    const stopped = assistantRows(id).at(-1)!;
    expect({ content: stopped.content, stopped: stopped.stopped }, 'the stored reply').toEqual({
      content: 'Let me look.\nThey mention a pass',
      stopped: undefined,
    });
    expect(stopped.thinking, 'the reasoning').toContain('A call opens');
  });
});

describe('a local turn whose stream died inside a call, diverted to the cloud fallback', () => {
  const LOCAL_PARTIAL = 'Checking.\n<tool_call>{"name":"leaky","arguments":{"path":"canary-7f3a';

  /**
   * Send; once the local model has written its partial call, let its stream die;
   * wait for the cloud's words. The send is handed back in an object: returned
   * bare from an async function, it would be awaited here, before Stop.
   */
  async function divertedUntil(cloudWords: string, dies: () => void): Promise<{ sending: Promise<void> }> {
    const sending = useChats.getState().send('read my notes');
    await until(() => useChats.getState().messages.some((message) => message.content.includes('canary-7f3a')));
    dies();
    await until(() => useChats.getState().messages.some((message) => message.content.includes(cloudWords)));
    return { sending };
  }

  it('stopped: keeps the cloud’s words, and stores and sends none of the call', async () => {
    const id = 'r3_fallback_stopped';
    given(chat(id, { tools: [leakyTool.id] }), [user(id, 1, 'hello'), reply(id, 2, 'Hi.')]);
    const dies = held();
    const gate = held();
    const local = scriptedBackend([{ partial: LOCAL_PARTIAL, stall: dies.promise }]);
    const cloud = scriptedBackend([{ partial: 'From the cloud: your notes mention', stall: gate.promise }, { reply: 'Fine.' }]);
    engineWith(local, { id: 'conn_cloud', adapter: cloud.adapter });

    let stopped: Message | undefined;
    try {
      toolRegistry.register(leakyTool);
      const { sending } = await divertedUntil('your notes mention', dies.release);
      useChats.getState().stop();
      gate.release();
      await sending;
      stopped = assistantRows(id).at(-1);
      await useChats.getState().send('thanks');
    } finally {
      toolRegistry.unregister(leakyTool.id);
    }

    expect(cloud.seen, 'the diverted request, then the next send').toHaveLength(2);
    expect({ content: stopped?.content, stopped: stopped?.stopped }, 'the stored reply').toEqual({
      content: 'Checking.\nFrom the cloud: your notes mention',
      stopped: undefined,
    });
    expect(JSON.stringify(cloud.seen.at(-1)?.messages), 'the next request').not.toContain('tool_call');
    expect(JSON.stringify(cloud.seen.at(-1)?.messages), 'the next request').not.toContain('canary-7f3a');
  });

  it('failed in the cloud too: the failed row keeps the cloud’s words and none of the call', async () => {
    const id = 'r3_fallback_failed';
    given(chat(id, { tools: [leakyTool.id] }), [user(id, 1, 'hello'), reply(id, 2, 'Hi.')]);
    const dies = held();
    const cloudDies = held();
    const local = scriptedBackend([{ partial: LOCAL_PARTIAL, stall: dies.promise }]);
    const cloud = scriptedBackend([{ partial: 'From the cloud: your notes mention', stall: cloudDies.promise }]);
    engineWith(local, { id: 'conn_cloud', adapter: cloud.adapter });

    try {
      toolRegistry.register(leakyTool);
      const { sending } = await divertedUntil('your notes mention', dies.release);
      cloudDies.release();
      await sending;
    } finally {
      toolRegistry.unregister(leakyTool.id);
    }

    const failed = assistantRows(id).at(-1)!;
    expect(failed.error, 'the turn failed').toBeDefined();
    expect(failed.content, 'the failed row’s words').toBe('Checking.\nFrom the cloud: your notes mention');
  });
});

/* ── Round 4: a call's opening named in words that go on past it ───── */

describe('a finished reply in a chat offering a tool, naming a call’s opening it does not finish', () => {
  for (const [form, words] of [
    [
      'the Mistral opening',
      'To parse it, look for the prefix `[TOOL_CALLS] get_weather({` in the output and read the JSON until its brackets balance. Everything after that is the arguments object.',
    ],
    [
      'the Qwen opening',
      'Qwen starts each call with `<tool_call>{"name": "` and the tool name follows, then the arguments object and the closing tag.',
    ],
  ] as const) {
    it(`${form}: keeps every word, and sends them back`, async () => {
      const id = `r4_named_opening_${form.length}`;
      given(chat(id, { tools: [leakyTool.id] }), [user(id, 1, 'hello'), reply(id, 2, 'Hi.')]);
      const local = recordingBackend([words, 'Next.']);
      engineWith(local);

      try {
        toolRegistry.register(leakyTool);
        await useChats.getState().send('how do I parse a tool call?');
        await useChats.getState().send('thanks');
      } finally {
        toolRegistry.unregister(leakyTool.id);
      }

      const stored = assistantRows(id)[1]!;
      expect(stored.toolCalls, 'no tool ran').toBeUndefined();
      expect(stored.content, 'the stored reply').toBe(words);
      expect(spoken(local.seen[1]).at(-2), 'the next request').toEqual(['assistant', words]);
    });
  }

  it('stopped after the words that follow it: keeps every word', async () => {
    const id = 'r4_named_opening_stopped';
    const partial = 'Look for the prefix `[TOOL_CALLS] get_weather({` in the output, then read the JSON until';
    const gate = held();
    const local = scriptedBackend([{ partial, stall: gate.promise }]);
    engineWith(local);

    await inToolsChat(id, async () => {
      await stopAfterSome('how do I parse a tool call?', 'read the JSON until', gate.release);
    });

    expect(assistantRows(id).at(-1)?.content, 'the stored reply').toBe(partial);
  });

  for (const [form, tail] of [
    ['a tag call', '<tool_call>{"name": "leaky", "arguments": {"path": "my notes canary-7f3a'],
    ['a Mistral call', '[TOOL_CALLS] leaky({"path": "my notes canary-7f3a'],
    ['a tag call cut off in its name', '<tool_call>{"name": "lea'],
  ] as const) {
    it(`still stores none of ${form} it ended inside`, async () => {
      const id = `r4_ended_inside_${form.length}`;
      given(chat(id, { tools: [leakyTool.id] }), [user(id, 1, 'hello'), reply(id, 2, 'Hi.')]);
      const local = recordingBackend([`Checking.\n${tail}`]);
      engineWith(local);

      try {
        toolRegistry.register(leakyTool);
        await useChats.getState().send('read my notes');
      } finally {
        toolRegistry.unregister(leakyTool.id);
      }

      expect(assistantRows(id).at(-1)?.content, 'the stored reply').toBe('Checking.');
    });
  }
});

describe('a local turn whose stream died mid-reasoning, diverted to the cloud fallback', () => {
  const REASONING = 'The user wants a summary of';
  const CLOUD_WORDS = 'Your notes mention a passphrase and';

  /**
   * Send; once the local model's reasoning is on screen, let its stream die; wait
   * for the cloud's words, as answer or as reasoning. The send is handed back in
   * an object, so it is not awaited here.
   */
  async function divertedUntilCloudWrites(dies: () => void): Promise<{ sending: Promise<void> }> {
    const sending = useChats.getState().send('summarise my notes');
    await until(() => useChats.getState().messages.some((message) => (message.thinking ?? '').includes(REASONING)));
    dies();
    await until(() =>
      useChats
        .getState()
        .messages.some((message) => `${message.content}${message.thinking ?? ''}`.includes(CLOUD_WORDS)),
    );
    return { sending };
  }

  it('stopped while the cloud wrote: shows and keeps the cloud’s words as the answer, and is not called stopped', async () => {
    const id = 'r4_fallback_reasoning_stopped';
    given(chat(id), [user(id, 1, 'hello'), reply(id, 2, 'Hi.')]);
    const dies = held();
    const gate = held();
    const local = scriptedBackend([{ partial: `<think>${REASONING}`, stall: dies.promise }]);
    const cloud = scriptedBackend([{ partial: CLOUD_WORDS, stall: gate.promise }]);
    engineWith(local, { id: 'conn_cloud', adapter: cloud.adapter });

    const { sending } = await divertedUntilCloudWrites(dies.release);
    const onScreen = useChats.getState().messages.at(-1)?.content;
    useChats.getState().stop();
    gate.release();
    await sending;

    expect(onScreen, 'the answer on screen while the cloud wrote').toBe(CLOUD_WORDS);
    const stopped = assistantRows(id).at(-1)!;
    expect(
      { content: stopped.content, thinking: stopped.thinking, stopped: stopped.stopped },
      'the stored reply',
    ).toEqual({ content: CLOUD_WORDS, thinking: REASONING, stopped: undefined });
    await mounted(stopped, () => {
      expect(stoppedNote(), 'called stopped before its first word').toBeNull();
      expect(bodyText(), 'the body').toContain(CLOUD_WORDS);
    });
  });

  it('failed in the cloud too: the failed row keeps the cloud’s words as its answer', async () => {
    const id = 'r4_fallback_reasoning_failed';
    given(chat(id), [user(id, 1, 'hello'), reply(id, 2, 'Hi.')]);
    const dies = held();
    const cloudDies = held();
    const local = scriptedBackend([{ partial: `<think>${REASONING}`, stall: dies.promise }]);
    const cloud = scriptedBackend([{ partial: CLOUD_WORDS, stall: cloudDies.promise }]);
    engineWith(local, { id: 'conn_cloud', adapter: cloud.adapter });

    const { sending } = await divertedUntilCloudWrites(dies.release);
    cloudDies.release();
    await sending;

    const failed = assistantRows(id).at(-1)!;
    expect(failed.error, 'the turn failed').toBeDefined();
    expect({ content: failed.content, thinking: failed.thinking }, 'the failed row').toEqual({
      content: CLOUD_WORDS,
      thinking: REASONING,
    });
  });
});

describe('a <tool_call> whose body is calls, but not one JSON object', () => {
  for (const [form, call, inputs] of [
    [
      'two call objects',
      '<tool_call>\n{"name":"leaky","arguments":{"path":"a.md"}}\n{"name":"leaky","arguments":{"path":"canary-7f3a"}}\n</tool_call>',
      [{ path: 'a.md' }, { path: 'canary-7f3a' }],
    ],
    ['a name and its arguments in parens', '<tool_call>leaky({"path":"canary-7f3a"})</tool_call>', [{ path: 'canary-7f3a' }]],
    ['a name on its own line and its JSON', '<tool_call>\nleaky\n{"path": "canary-7f3a"}\n</tool_call>', [{ path: 'canary-7f3a' }]],
  ] as const) {
    it(`${form}: a finished reply runs each call, and stores and sends back none of it`, async () => {
      const id = `r4_tag_body_${form.length}`;
      given(chat(id, { tools: [leakyTool.id] }), [user(id, 1, 'hello'), reply(id, 2, 'Hi.')]);
      const local = recordingBackend([`Reading it.\n${call}`, 'Next.']);
      engineWith(local);

      try {
        toolRegistry.register(leakyTool);
        await useChats.getState().send('read my notes');
        await useChats.getState().send('and then?');
      } finally {
        toolRegistry.unregister(leakyTool.id);
      }

      const stored = assistantRows(id)[1]!;
      expect(stored.toolCalls?.map((ran) => ran.input), 'the calls that ran').toEqual(inputs);
      expect(stored.content, 'the stored reply').toBe('Reading it.\n\nNext.');
      expect(JSON.stringify(local.seen.at(-1)?.messages), 'the next request').not.toContain('tool_call');
      expect(JSON.stringify(local.seen.at(-1)?.messages), 'the next request').not.toContain('canary-7f3a');
    });
  }

  for (const [form, partial] of [
    [
      'inside its second call object',
      'Reading both.\n<tool_call>\n{"name":"leaky","arguments":{"path":"a.md"}}\n{"name":"leaky","arguments":{"path":"canary-7f3a',
    ],
    ['inside a name’s parens', 'Reading both.\n<tool_call>leaky({"path":"canary-7f3a'],
  ] as const) {
    it(`stopped ${form}: keeps only the words before it, and sends none of it back`, async () => {
      const id = `r4_tag_body_stopped_${form.length}`;
      given(chat(id, { tools: [leakyTool.id] }), [user(id, 1, 'hello'), reply(id, 2, 'Hi.')]);
      const gate = held();
      const local = scriptedBackend([{ partial, stall: gate.promise }, { reply: 'Fine.' }]);
      engineWith(local);

      try {
        toolRegistry.register(leakyTool);
        await stopAfterSome('read my notes', 'canary-7f3a', gate.release);
        await useChats.getState().send('thanks');
      } finally {
        toolRegistry.unregister(leakyTool.id);
      }

      expect(assistantRows(id)[1]?.content, 'the stored reply').toBe('Reading both.');
      expect(JSON.stringify(local.seen[1]?.messages), 'the next request').not.toContain('canary-7f3a');
    });
  }

  it('keeps prose that names both tags with words between them, finished', async () => {
    const id = 'r4_tag_body_prose';
    const words = 'Qwen puts <tool_call> first, then a name such as leaky, then {"path": "notes.md"}, and </tool_call> last.';
    given(chat(id, { tools: [leakyTool.id] }), [user(id, 1, 'hello'), reply(id, 2, 'Hi.')]);
    const local = recordingBackend([words]);
    engineWith(local);

    try {
      toolRegistry.register(leakyTool);
      await useChats.getState().send('how does qwen format a call?');
    } finally {
      toolRegistry.unregister(leakyTool.id);
    }

    expect(assistantRows(id).at(-1)?.content, 'the stored reply').toBe(words);
  });
});

const { messageText } = await import('@/ai/prompt');

describe('a follow-up that writes a call as the app writes the call that ran in its history, [tool name({…})]', () => {
  it('finished: the call runs, and the stored reply keeps none of it and sends none of it back', async () => {
    const id = 'r4_app_call_finished';
    given(chat(id, { tools: [leakyTool.id] }), [user(id, 1, 'hello'), reply(id, 2, 'Hi.')]);
    const local = recordingBackend([
      `Reading your notes.\n${CALL}`,
      'One more file.\n[tool leaky({"path":"canary-7f3a"})]\nReading it now.',
      'Both read.',
      'Next.',
    ]);
    engineWith(local);

    try {
      toolRegistry.register(leakyTool);
      await useChats.getState().send('read my notes');
      await useChats.getState().send('thanks');
    } finally {
      toolRegistry.unregister(leakyTool.id);
    }

    expect(local.seen[1]!.messages.map(messageText).join('\n'), 'how the follow-up’s history shows the call').toContain(
      '[tool leaky({})]',
    );
    const ran = assistantRows(id)[1]!;
    expect(ran.toolCalls?.map((call) => call.input), 'the calls that ran').toEqual([{}, { path: 'canary-7f3a' }]);
    expect(ran.content, 'the stored reply').toBe('Reading your notes.\n\nOne more file.\n\nReading it now.\n\nBoth read.');
    expect(JSON.stringify(local.seen.at(-1)?.messages), 'the next request').not.toContain('canary-7f3a');
  });

  it('stopped mid-arguments: keeps the words before it, and sends none of it back', async () => {
    const id = 'r4_app_call_stopped';
    given(chat(id, { tools: [leakyTool.id] }), [user(id, 1, 'hello'), reply(id, 2, 'Hi.')]);
    const gate = held();
    const local = scriptedBackend([
      { reply: `Reading your notes.\n${CALL}` },
      { partial: 'One more file.\n[tool leaky({"path":"canary-7f3a', stall: gate.promise },
      { reply: 'Fine.' },
    ]);
    engineWith(local);

    let stopped: Message | undefined;
    try {
      toolRegistry.register(leakyTool);
      await stopAfterSome('read my notes', 'canary-7f3a', gate.release);
      stopped = assistantRows(id).at(-1);
      await useChats.getState().send('thanks');
    } finally {
      toolRegistry.unregister(leakyTool.id);
    }

    expect({ content: stopped?.content, stopped: stopped?.stopped }, 'the stored reply').toEqual({
      content: 'Reading your notes.\nOne more file.',
      stopped: undefined,
    });
    expect(JSON.stringify(local.seen.at(-1)?.messages), 'the next request').not.toContain('canary-7f3a');
  });
});

/* ── Round 6: a stopped turn's fenced call, #331's record and the words ─ */

describe('a fenced call Stop caught complete, in a turn offering its tool (refs #293)', () => {
  // #331 reads the text a stopped stream left for calls it can record as not
  // sent. A fenced block is a call only when it names an offered tool, and the
  // stripper reads it with the names the request offered, so the stranded-call
  // reading must too: read with none, the call below was stripped from the
  // words as a call and never recorded as one. A block naming no offered tool
  // is neither.
  const FENCED_CALL = '```json\n{"name": "notes.note", "arguments": {"text": "canary-7f3a"}}\n```';
  const FENCED_EXAMPLE = '```json\n{"name": "search", "arguments": {"query": "canary-7f3a"}}\n```';

  it('is recorded as not sent, stopped, and none of it is stored or sent back', async () => {
    const id = 'r6_stranded_fenced';
    const gate = held();
    const local = scriptedBackend([
      { partial: `Filing it.\n\n${FENCED_CALL}\n\nThen I will`, stall: gate.promise },
      { reply: 'Fine.' },
    ]);
    let stopped: Message | undefined;
    const probe = await inToolsChat(id, async () => {
      engineWith(local);
      await stopAfterSome('file a note', 'Then I will', gate.release);
      stopped = assistantRows(id).at(-1);
      await useChats.getState().send('thanks');
    });

    expect(probe.call, 'MCP calls').not.toHaveBeenCalled();
    expect(
      stopped?.toolCalls?.map((call) => ({ name: call.name, receipt: call.receipt })),
      'the call Stop caught, as #331 records it',
    ).toEqual([
      {
        name: 'notes.note',
        receipt: expect.objectContaining({ outcome: 'withheld', why: 'stopped', host: 'notes.example' }),
      },
    ]);
    expect(stopped?.stopped, 'a reply with words carries no marker').toBeUndefined();
    expect(stopped?.content, 'the stored reply').toMatch(/^Filing it\.\s+Then I will$/);
    expect(JSON.stringify(local.seen[1]?.messages), 'the next request').not.toContain('canary-7f3a');
  });

  it('naming no offered tool, is neither recorded nor stripped', async () => {
    const id = 'r6_stranded_example';
    const partial = `Configure it like this:\n\n${FENCED_EXAMPLE}\n\nThen restart`;
    const gate = held();
    const local = scriptedBackend([{ partial, stall: gate.promise }]);
    let stopped: Message | undefined;
    const probe = await inToolsChat(id, async () => {
      engineWith(local);
      await stopAfterSome('what goes in the config?', 'Then restart', gate.release);
      stopped = assistantRows(id).at(-1);
    });

    expect(probe.call, 'MCP calls').not.toHaveBeenCalled();
    expect(stopped?.toolCalls, 'nothing recorded').toBeUndefined();
    expect(stopped?.content, 'the words the person watched arrive').toBe(partial);
  });
});

/* ── Round 6: a record named after an offered tool is not a call ────── */

describe('a JSON record whose "name" is an offered tool’s id, carrying no arguments, in a chat with that tool on', () => {
  // The calculator's id is "calculator": a package.json for a project of that
  // name was run as a call to it and stripped from the reply. A call carries
  // its arguments, or is nothing but its name; a record is neither.
  const PACKAGE = '```json\n{"name": "calculator", "version": "1.0.0", "private": true}\n```';

  it('is not run, and stays in a finished reply and the next request', async () => {
    const id = 'r6_record_named_by_id';
    given(chat(id, { tools: ['calculator'] }), [user(id, 1, 'hello'), reply(id, 2, 'Hi.')]);
    const text = `Here is a package.json:\n\n${PACKAGE}\n\nThen run npm install.`;
    const local = recordingBackend([text, 'Anything else?', 'Fine.']);
    engineWith(local);

    await useChats.getState().send('a package.json for my calculator app, please');
    await useChats.getState().send('thanks');

    const last = assistantRows(id)[1]!;
    expect(last.toolCalls, 'no tool ran').toBeUndefined();
    expect(last.content, 'the words the person watched arrive').toBe(text);
    expect(spoken(local.seen[1]).at(-2), 'the next request').toEqual(['assistant', text]);
  });

  it('stays whole in a reply stopped after it', async () => {
    const id = 'r6_record_named_by_id_stopped';
    given(chat(id, { tools: ['calculator'] }), [user(id, 1, 'hello'), reply(id, 2, 'Hi.')]);
    const partial = `Here is a package.json:\n\n${PACKAGE}\n\nThen run`;
    const gate = held();
    const local = scriptedBackend([{ partial, stall: gate.promise }]);
    engineWith(local);

    await stopAfterSome('a package.json for my calculator app, please', 'Then run', gate.release);

    const stopped = assistantRows(id).at(-1)!;
    expect(stopped.toolCalls, 'no tool ran').toBeUndefined();
    expect(stopped.content, 'the words the person watched arrive').toBe(partial);
  });
});

/* ── Round 6: a real call after words naming its tag ────────────────── */

describe('a real <tool_call> after words that name the tag, in a chat with its tool on', () => {
  // The extractor read a tag call as everything from the FIRST `<tool_call>` to
  // the first `</tool_call>`: reasoning or prose naming the tag began a body
  // that never parsed, and swallowed the real call after it. The stripper,
  // which reads a call by its JSON, took it out of the reply: the call the
  // model made neither ran nor showed.
  const CALC = '<tool_call>{"name": "calculate", "arguments": {"expression": "6*7"}}</tool_call>';

  for (const [where, before] of [
    ['reasoning', '<think>I will answer with a <tool_call> for this.</think>\n'],
    ['prose', 'Qwen wraps each call in a <tool_call> tag, so here is mine.\n'],
  ] as const) {
    it(`runs when ${where} named the tag first`, async () => {
      const id = `r6_tag_after_${where}`;
      given(chat(id, { tools: ['calculator'] }), [user(id, 1, 'hello'), reply(id, 2, 'Hi.')]);
      const local = recordingBackend([`${before}${CALC}`, 'It is 42.']);
      engineWith(local);

      await useChats.getState().send('what is six times seven?');

      const ran = assistantRows(id).at(-1)!;
      expect(ran.toolCalls?.map((call) => call.output), 'the calculator ran').toEqual(['6*7 = 42']);
      expect(local.seen, 'the follow-up').toHaveLength(2);
      expect(ran.content, 'the stored reply').toMatch(/It is 42\.$/);
      expect(ran.content, 'the stored reply').not.toContain('6*7');
    });
  }
});

/* ── Round 6: a stopped tag call whose body is not strict JSON ──────── */

describe('a turn stopped inside a tag call whose body is not strict JSON', () => {
  // A small model's call is often single-quoted, leaves its keys unquoted, or
  // wraps its calls in an array. The cut read a tag call's body only when it
  // opened `{"`, so a stopped turn kept every such call, its arguments stored
  // and sent back to the model.
  for (const [form, body] of [
    ['single-quoted', "{'name': 'notes.note', 'arguments': {'text': 'canary-7f3a"],
    ['unquoted keys', '{name: "notes.note", arguments: {text: "canary-7f3a'],
    ['an array', '[{"name": "notes.note", "arguments": {"text": "canary-7f3a'],
  ] as const) {
    it(`${form}: keeps the words before it, and sends none of it back`, async () => {
      const id = `r6_loose_${form.replace(/\W+/g, '_')}`;
      const gate = held();
      const local = scriptedBackend([
        { partial: `Filing it now.\n<tool_call>${body}`, stall: gate.promise },
        { reply: 'Fine.' },
      ]);
      let stopped: Message | undefined;
      const probe = await inToolsChat(id, async () => {
        engineWith(local);
        await stopAfterSome('file a note', 'canary-7f3a', gate.release);
        stopped = assistantRows(id).at(-1);
        await useChats.getState().send('thanks');
      });

      expect(probe.call, 'MCP calls').not.toHaveBeenCalled();
      expect({ content: stopped?.content, stopped: stopped?.stopped }, 'the stored reply').toEqual({
        content: 'Filing it now.',
        stopped: undefined,
      });
      expect(JSON.stringify(local.seen[1]?.messages), 'the next request').not.toContain('canary-7f3a');
    });
  }
});

/* ── Round 6: a follow-up recounting the call its history shows ─────── */

const { sanitiseMessages } = await import('@/ai/prompt');
const { GRANTED_PROBE, drainEvents } = await import('./support/egress-probe');

type GenerationEvent = import('@/ai/engine').GenerationEvent;

/** A call as a text template's history shows it: `messageText` over `sanitiseMessages`. */
function asHistoryShows(name: string, input: Record<string, unknown>): string {
  const [message] = sanitiseMessages([{ role: 'assistant', content: [{ type: 'tool_use', id: 'call_0', name, input }] }]);
  return messageText(message!);
}

describe('a follow-up that recounts the call its history shows, as the history shows it', () => {
  it('does not run the tool a second time, and stores and sends none of the recount', async () => {
    const id = 'r6_recount_local';
    given(chat(id, { tools: [leakyTool.id] }), [user(id, 1, 'hello'), reply(id, 2, 'Hi.')]);
    const recount = asHistoryShows('leaky', {});
    const local = recordingBackend([
      `Reading your notes.\n${CALL}`,
      `I read them with ${recount} and they mention a passphrase.`,
      'Should not be asked for.',
    ]);
    engineWith(local);

    try {
      toolRegistry.register(leakyTool);
      await useChats.getState().send('read my notes');
    } finally {
      toolRegistry.unregister(leakyTool.id);
    }

    expect(local.seen[1]!.messages.map(messageText).join('\n'), 'the follow-up’s history').toContain(recount);
    const ran = assistantRows(id).at(-1)!;
    expect(ran.toolCalls?.map((call) => call.name), 'the calls that ran').toEqual(['leaky']);
    expect(local.seen, 'no follow-up after the recount').toHaveLength(2);
    expect(ran.content, 'the stored reply').not.toContain('[tool');
  });

  it('does not send an MCP call a second time, recounted as its encoded history shows it or as the model first wrote it', async () => {
    const input = { text: 'call Ana at 10:30' };
    const shown = asHistoryShows('notes.note', input);
    // The history encodes a tool block's strings: the colon is not the one the model wrote.
    expect(shown).not.toContain('10:30');
    for (const recount of [shown, `[tool notes.note(${JSON.stringify(input)})]`]) {
      const probe = mcpProbe();
      toolRegistry.register(probe.tool);
      try {
        const local = recordingBackend([
          `<tool_call>${JSON.stringify({ name: 'notes.note', arguments: input })}</tool_call>`,
          `Filed: ${recount}. Anything else?`,
          'Should not be asked for.',
        ]);
        const engine = new ChatterangEngine({ resolver: probeResolver, fallbackBackendId: null });
        engine.router.replace(QWEN.engine, local.adapter as never);
        const events = await drainEvents(
          engine.stream({
            messages: [{ role: 'user', content: 'note that I should call Ana at 10:30' }],
            target: ON_DEVICE,
            toolIds: [probe.tool.id],
            mcpEgress: GRANTED_PROBE,
          }),
        );

        expect(sanitiseMessages(local.seen[1]!.messages).map(messageText).join('\n'), recount).toContain(shown);
        expect(probe.call, `sent to the server, recounted as ${recount}`).toHaveBeenCalledTimes(1);
        expect(local.seen, recount).toHaveLength(2);
        const done = events.find((event) => event.type === 'done');
        expect(done?.type === 'done' && done.text, recount).toBe('Filed: . Anything else?');
      } finally {
        toolRegistry.unregister(probe.tool.id);
      }
    }
  });

  it('stopped after the recount: records no second call as not sent (refs #293)', async () => {
    // #331 records a complete call in the text Stop caught. A recount is not a
    // call, so it is not recorded as one that did not go: the one call went.
    const input = { text: 'call Ana at 10:30' };
    const probe = mcpProbe();
    toolRegistry.register(probe.tool);
    try {
      const controller = new AbortController();
      const gate = held();
      const engine = new ChatterangEngine({ resolver: probeResolver, fallbackBackendId: null });
      let turn = 0;
      engine.router.replace(
        QWEN.engine,
        new FunctionBackendAdapter({
          execute: async () => {
            throw new Error('this rig only streams');
          },
          executeStream: async function* (request: IRChatRequest): AsyncGenerator<IRStreamChunk> {
            yield { type: 'start', sequence: 0, metadata: request.metadata };
            if (turn++ === 0) {
              yield {
                type: 'content',
                sequence: 1,
                delta: `<tool_call>${JSON.stringify({ name: 'notes.note', arguments: input })}</tool_call>`,
              };
            } else {
              yield { type: 'content', sequence: 1, delta: `Filed: ${asHistoryShows('notes.note', input)}. And` };
              await gate.promise;
            }
            yield { type: 'done', sequence: 2, finishReason: 'stop' };
          },
        }) as never,
      );

      const events: GenerationEvent[] = [];
      for await (const event of engine.stream({
        messages: [{ role: 'user', content: 'note that I should call Ana at 10:30' }],
        target: ON_DEVICE,
        toolIds: [probe.tool.id],
        mcpEgress: GRANTED_PROBE,
        signal: controller.signal,
      })) {
        events.push(event);
        if (event.type === 'delta' && event.text.includes('. And')) {
          controller.abort();
          gate.release();
        }
      }

      expect(probe.call, 'sent to the server').toHaveBeenCalledTimes(1);
      expect(
        events.flatMap((event) => (event.type === 'tool' ? [event.tool.receipt?.outcome] : [])),
        'the calls recorded',
      ).toEqual(['sent']);
    } finally {
      toolRegistry.unregister(probe.tool.id);
    }
  });
});

/* ── A local round that died, the turn finished by the cloud fallback ── */

describe('a local turn whose stream died after some words, finished by the cloud fallback', () => {
  // The engine dropped the dead round's text when it diverted, so the finished
  // reply was the cloud's round alone: the words the person had watched the
  // local model write were gone from it, while a turn stopped or failed on the
  // same path kept them.
  async function divertedAndFinished(onScreen: () => boolean, dies: () => void): Promise<void> {
    const sending = useChats.getState().send('what do my notes say?');
    await until(onScreen);
    dies();
    await sending;
  }

  it('keeps the local words beside the cloud’s, and sends both back', async () => {
    const id = 'rv6_fallback_finished_words';
    given(chat(id), [user(id, 1, 'hello'), reply(id, 2, 'Hi.')]);
    const dies = held();
    const local = scriptedBackend([{ partial: 'Checking your notes first.', stall: dies.promise }]);
    const cloud = recordingBackend(['From the cloud: they mention a passphrase.', 'Fine.']);
    engineWith(local, { id: 'conn_cloud', adapter: cloud.adapter });

    await divertedAndFinished(
      () => useChats.getState().messages.some((message) => message.content.includes('first.')),
      dies.release,
    );
    const finished = assistantRows(id).at(-1)!;
    await useChats.getState().send('thanks');

    const words = 'Checking your notes first.\n\nFrom the cloud: they mention a passphrase.';
    expect(
      { error: finished.error, content: finished.content, stopped: finished.stopped },
      'the finished reply',
    ).toEqual({ error: undefined, content: words, stopped: undefined });
    expect(spoken(cloud.seen[1]).at(-2), 'the next request').toEqual(['assistant', words]);
  });

  it('keeps the reasoning the local model wrote before it died', async () => {
    const id = 'rv6_fallback_finished_reasoning';
    given(chat(id), [user(id, 1, 'hello'), reply(id, 2, 'Hi.')]);
    const dies = held();
    const local = scriptedBackend([{ partial: '<think>The user wants a summary of', stall: dies.promise }]);
    const cloud = recordingBackend(['Your notes mention a passphrase.']);
    engineWith(local, { id: 'conn_cloud', adapter: cloud.adapter });

    await divertedAndFinished(
      () => useChats.getState().messages.some((message) => (message.thinking ?? '').includes('summary of')),
      dies.release,
    );

    const finished = assistantRows(id).at(-1)!;
    expect({ content: finished.content, thinking: finished.thinking }, 'the finished reply').toEqual({
      content: 'Your notes mention a passphrase.',
      thinking: 'The user wants a summary of',
    });
  });

  it('in a chat with a tool on, keeps the words and none of a call the local round died inside', async () => {
    const id = 'rv6_fallback_finished_call';
    given(chat(id, { tools: [leakyTool.id] }), [user(id, 1, 'hello'), reply(id, 2, 'Hi.')]);
    const dies = held();
    const local = scriptedBackend([
      { partial: 'Checking.\n<tool_call>{"name":"leaky","arguments":{"path":"canary-7f3a', stall: dies.promise },
    ]);
    const cloud = recordingBackend(['From the cloud: your notes mention a passphrase.', 'Fine.']);
    engineWith(local, { id: 'conn_cloud', adapter: cloud.adapter });

    try {
      toolRegistry.register(leakyTool);
      await divertedAndFinished(
        () => useChats.getState().messages.some((message) => message.content.includes('canary-7f3a')),
        dies.release,
      );
      await useChats.getState().send('thanks');
    } finally {
      toolRegistry.unregister(leakyTool.id);
    }

    const finished = assistantRows(id)[1]!;
    expect(finished.content, 'the finished reply').toBe('Checking.\n\nFrom the cloud: your notes mention a passphrase.');
    expect(JSON.stringify(cloud.seen.at(-1)?.messages), 'the next request').not.toContain('canary-7f3a');
  });
});

/* ── A call named in reasoning is not a call ────────────────────────── */

describe('a call named in reasoning', () => {
  // Reasoning is the model thinking, not calling: its words are never the
  // reply's, and a call it names is not one the round made. The extractor read
  // the round with its reasoning in it, so a call only mentioned there ran and
  // sent a follow-up, a call drafted there and then made ran twice, and Stop
  // landing mid-reasoning recorded a call the model never made as not sent.
  const calc = (expression: string): string =>
    `<tool_call>{"name": "calculate", "arguments": {"expression": "${expression}"}}</tool_call>`;

  it('is not run when the answer makes no call', async () => {
    const id = 'rv6_reasoning_names_call';
    given(chat(id, { tools: ['calculator'] }), [user(id, 1, 'hello'), reply(id, 2, 'Hi.')]);
    const local = recordingBackend([`<think>I could call ${calc('6*7')} but I know it.</think>\nIt is 42.`, 'Second answer.']);
    engineWith(local);

    await useChats.getState().send('what is six times seven?');

    const stored = assistantRows(id).at(-1)!;
    expect(
      { tools: stored.toolCalls?.length ?? 0, requests: local.seen.length, content: stored.content },
      'the finished reply',
    ).toEqual({ tools: 0, requests: 1, content: 'It is 42.' });
  });

  for (const [form, call] of [
    ['a <tool_call>', calc('6*7')],
    ['a fenced block', '```json\n{"name": "calculate", "arguments": {"expression": "6*7"}}\n```'],
    ['this app’s history form', '[tool calculate({"expression": "6*7"})]'],
  ] as const) {
    it(`runs once when the reasoning drafts it as ${form} and the answer makes it`, async () => {
      const id = `rv6_reasoning_drafts_${form.replace(/\W+/g, '_')}`;
      given(chat(id, { tools: ['calculator'] }), [user(id, 1, 'hello'), reply(id, 2, 'Hi.')]);
      const local = recordingBackend([`<think>First ${call}, then the answer.</think>\n${call}`, 'It is 42.']);
      engineWith(local);

      await useChats.getState().send('what is six times seven?');

      const stored = assistantRows(id).at(-1)!;
      expect(stored.toolCalls?.map((ran) => ran.output), 'the calls that ran').toEqual(['6*7 = 42']);
      expect(local.seen, 'one follow-up').toHaveLength(2);
      expect(stored.content, 'the stored reply').toBe('It is 42.');
    });
  }

  it('stopped mid-reasoning after drafting a call to an MCP tool: records nothing as not sent', async () => {
    const id = 'rv6_reasoning_stopped';
    const gate = held();
    const local = scriptedBackend([{ partial: `<think>I will file it with ${MCP_CALL_CLEAN}, and then`, stall: gate.promise }]);
    let stopped: Message | undefined;
    const probe = await inToolsChat(id, async () => {
      engineWith(local);
      const sending = useChats.getState().send('file a note');
      await until(() => (useChats.getState().messages.at(-1)?.thinking ?? '').includes('and then'));
      useChats.getState().stop();
      gate.release();
      await sending;
      stopped = assistantRows(id).at(-1);
    });

    expect(probe.call, 'MCP calls').not.toHaveBeenCalled();
    expect(stopped?.toolCalls, 'no call recorded').toBeUndefined();
    expect(stopped?.thinking, 'the reasoning').toContain('I will file it with');
  });
});

/* ── A call written twice in one reply, once in this app's history form ─ */

describe('a call a reply writes twice, once as this app’s history writes a call', () => {
  // A copy of a call in the `[tool NAME({…})]` form that the history shows the
  // model is a recount, but it was compared with the history alone: announced
  // in that form and then made in the model's own markup, or made and then
  // recounted in the same reply, one call ran twice — a second note filed on
  // the server — and Stop after it recorded two calls not sent for the one.
  const CALC = '<tool_call>{"name": "calculate", "arguments": {"expression": "6*7"}}</tool_call>';
  const APP_CALC = '[tool calculate({"expression": "6*7"})]';

  it('sends an MCP call once when a follow-up announces it in that form and then makes it', async () => {
    const probe = mcpProbe();
    toolRegistry.register(probe.tool);
    try {
      const local = recordingBackend([
        '<tool_call>{"name": "notes.note", "arguments": {"text": "first"}}</tool_call>',
        'Filed the first. Next, [tool notes.note({"text": "second"})]:\n<tool_call>{"name": "notes.note", "arguments": {"text": "second"}}</tool_call>',
        'Both filed.',
      ]);
      const engine = new ChatterangEngine({ resolver: probeResolver, fallbackBackendId: null });
      engine.router.replace(QWEN.engine, local.adapter as never);
      const events = await drainEvents(
        engine.stream({
          messages: [{ role: 'user', content: 'file two notes' }],
          target: ON_DEVICE,
          toolIds: [probe.tool.id],
          mcpEgress: GRANTED_PROBE,
        }),
      );

      expect(probe.call.mock.calls.map((call) => call[2]), 'notes sent to the server').toEqual([
        { text: 'first' },
        { text: 'second' },
      ]);
      const done = events.find((event) => event.type === 'done');
      expect(done?.type === 'done' && done.text, 'the finished words').toBe('Filed the first. Next, :\n\nBoth filed.');
    } finally {
      toolRegistry.unregister(probe.tool.id);
    }
  });

  for (const [how, text] of [
    ['announced in that form, then made', `I will work it out with ${APP_CALC}:\n${CALC}`],
    ['made, then recounted in that form', `${CALC}\nThat was ${APP_CALC}.`],
    ['written in that form twice', `Working it out: ${APP_CALC}\n${APP_CALC}`],
  ] as const) {
    it(`runs once when ${how}`, async () => {
      const id = `rv6_twice_${how.replace(/\W+/g, '_')}`;
      given(chat(id, { tools: ['calculator'] }), [user(id, 1, 'hello'), reply(id, 2, 'Hi.')]);
      const local = recordingBackend([text, 'It is 42.']);
      engineWith(local);

      await useChats.getState().send('what is six times seven?');

      const stored = assistantRows(id).at(-1)!;
      expect(stored.toolCalls?.map((ran) => ran.output), 'the calls that ran').toEqual(['6*7 = 42']);
      expect(stored.content, 'the stored reply').not.toMatch(/\[tool|tool_call/);
    });
  }

  it('stopped after it: records the one call as not sent, once (refs #293)', async () => {
    const id = 'rv6_twice_stopped';
    const gate = held();
    const local = scriptedBackend([
      {
        partial: `Next, [tool notes.note({"text": "canary-7f3a"})]:\n<tool_call>{"name": "notes.note", "arguments": {"text": "canary-7f3a"}}</tool_call>\nAnd`,
        stall: gate.promise,
      },
    ]);
    let stopped: Message | undefined;
    const probe = await inToolsChat(id, async () => {
      engineWith(local);
      await stopAfterSome('file a note', '\nAnd', gate.release);
      stopped = assistantRows(id).at(-1);
    });

    expect(probe.call, 'MCP calls').not.toHaveBeenCalled();
    expect(stopped?.toolCalls?.map((call) => call.receipt), 'the calls recorded').toEqual([
      expect.objectContaining({ outcome: 'withheld', why: 'stopped' }),
    ]);
  });
});

/* ── A stopped single-quoted tag call holding Python's literals ──────── */

describe('a turn stopped inside a single-quoted tag call that holds Python’s True, False or None', () => {
  // A small model that writes its call as Python writes a dict writes Python's
  // literals too. The cut read a bare word in a call's JSON only as JSON's own
  // `true`, `false` or `null`, or as an unquoted key, so a call holding `True`
  // was read as prose and kept, its arguments stored and sent back.
  for (const literal of ['True', 'False', 'None'] as const) {
    it(`${literal}: keeps the words before it, and sends none of it back`, async () => {
      const id = `rv6_python_literal_${literal}`;
      const gate = held();
      const local = scriptedBackend([
        {
          partial: `Filing it now.\n<tool_call>{'name': 'notes.note', 'arguments': {'pinned': ${literal}, 'text': 'canary-7f3a`,
          stall: gate.promise,
        },
        { reply: 'Fine.' },
      ]);
      let stopped: Message | undefined;
      const probe = await inToolsChat(id, async () => {
        engineWith(local);
        await stopAfterSome('file a note', 'canary-7f3a', gate.release);
        stopped = assistantRows(id).at(-1);
        await useChats.getState().send('thanks');
      });

      expect(probe.call, 'MCP calls').not.toHaveBeenCalled();
      expect({ content: stopped?.content, stopped: stopped?.stopped }, 'the stored reply').toEqual({
        content: 'Filing it now.',
        stopped: undefined,
      });
      expect(JSON.stringify(local.seen[1]?.messages), 'the next request').not.toContain('canary-7f3a');
    });
  }
});

/* ── What the stripper takes out as a call is read as one ───────────── */

describe('a call in a shape the stripper took out and the reader did not read', () => {
  // The stripper takes a call out of the words in more shapes than the reader
  // read: a <tool_call> holding several calls, an array of them, Qwen3-Coder's
  // XML, a name before its JSON, and a body with a trailing comma or a closing
  // brace too many or too few. The reader read a tag's body only as one strict
  // JSON object followed by its closing tag. So such a call, stopped, vanished
  // from the words with no record that it had not gone — #331 writes that
  // record for the calls the reader reads — and finished, it was stripped and
  // never ran: the call the model made neither ran, nor showed, nor was
  // recorded.
  const note = (text: string): string => `{"name": "notes.note", "arguments": {"text": "${text}"}}`;
  const STRANDED = [
    ['two calls in one tag', `<tool_call>\n${note('canary-1')}\n${note('canary-2')}\n</tool_call>`, 2],
    ['an array body', `<tool_call>[${note('canary-7f3a')}]</tool_call>`, 1],
    [
      'an XML body',
      '<tool_call>\n<function=notes.note>\n<parameter=text>\ncanary-7f3a\n</parameter>\n</function>\n</tool_call>',
      1,
    ],
    ['a name before its JSON', '<tool_call>notes.note({"text": "canary-7f3a"})</tool_call>', 1],
    ['a trailing comma', '<tool_call>{"name": "notes.note", "arguments": {"text": "canary-7f3a"},}</tool_call>', 1],
    ['a closing brace too many', `<tool_call>${note('canary-7f3a')}}</tool_call>`, 1],
    ['a closing brace too few', '<tool_call>{"name": "notes.note", "arguments": {"text": "canary-7f3a"}</tool_call>', 1],
  ] as const;

  for (const [shape, call, count] of STRANDED) {
    it(`${shape}, Stop caught complete: is recorded as not sent, and none of it is stored or sent back (refs #293)`, async () => {
      const id = `rv6_stranded_${shape.replace(/\W+/g, '_')}`;
      const gate = held();
      const local = scriptedBackend([
        { partial: `Filing it now.\n${call}\nWaiting`, stall: gate.promise },
        { reply: 'Fine.' },
      ]);
      let stopped: Message | undefined;
      const probe = await inToolsChat(id, async () => {
        engineWith(local);
        await stopAfterSome('file a note', 'Waiting', gate.release);
        stopped = assistantRows(id).at(-1);
        await useChats.getState().send('thanks');
      });

      expect(probe.call, 'MCP calls').not.toHaveBeenCalled();
      expect(stopped?.toolCalls?.map((recorded) => recorded.receipt), 'recorded as not sent').toEqual(
        Array.from({ length: count }, () =>
          expect.objectContaining({ outcome: 'withheld', why: 'stopped', toolName: 'notes.note' }),
        ),
      );
      expect(stopped?.content, 'the stored reply').toMatch(/^Filing it now\.\s+Waiting$/);
      expect(JSON.stringify(local.seen[1]?.messages), 'the next request').not.toContain('canary');
    });
  }

  const calc = (expression: string): string => `{"name": "calculate", "arguments": {"expression": "${expression}"}}`;
  for (const [shape, call, outputs] of [
    ['two calls in one tag', `<tool_call>\n${calc('6*7')}\n${calc('6*8')}\n</tool_call>`, ['6*7 = 42', '6*8 = 48']],
    ['an array body', `<tool_call>[${calc('6*7')}, ${calc('6*8')}]</tool_call>`, ['6*7 = 42', '6*8 = 48']],
    [
      'an XML body',
      '<tool_call>\n<function=calculate>\n<parameter=expression>\n6*7\n</parameter>\n</function>\n</tool_call>',
      ['6*7 = 42'],
    ],
    ['a name before its JSON', '<tool_call>calculate({"expression": "6*7"})</tool_call>', ['6*7 = 42']],
    ['a trailing comma', '<tool_call>{"name": "calculate", "arguments": {"expression": "6*7"},}</tool_call>', ['6*7 = 42']],
    ['single quotes', "<tool_call>{'name': 'calculate', 'arguments': {'expression': '6*7'}}</tool_call>", ['6*7 = 42']],
    ['a closing brace too many', `<tool_call>${calc('6*7')}}</tool_call>`, ['6*7 = 42']],
    ['a closing brace too few', '<tool_call>{"name": "calculate", "arguments": {"expression": "6*7"}</tool_call>', ['6*7 = 42']],
    ['a [TOOL_CALLS] call with a closing brace too many', '[TOOL_CALLS] calculate({"expression": "6*7"}})', ['6*7 = 42']],
  ] as const) {
    it(`${shape}, finished: runs, and the reply keeps none of it`, async () => {
      const id = `rv6_finished_${shape.replace(/\W+/g, '_')}`;
      given(chat(id, { tools: ['calculator'] }), [user(id, 1, 'hello'), reply(id, 2, 'Hi.')]);
      const local = recordingBackend([`Working it out.\n${call}`, 'It is 42.']);
      engineWith(local);

      await useChats.getState().send('what is six times seven?');

      const stored = assistantRows(id).at(-1)!;
      expect(stored.toolCalls?.map((ran) => ran.output), 'the calls that ran').toEqual(outputs);
      expect(stored.content, 'the stored reply').toBe('Working it out.\n\nIt is 42.');
    });
  }

  it('two calls in one tag, past the round limit: each is recorded as not sent (refs #293)', async () => {
    const probe = mcpProbe();
    toolRegistry.register(probe.tool);
    try {
      const local = recordingBackend([`<tool_call>\n${note('a')}\n${note('b')}\n</tool_call>`]);
      const engine = new ChatterangEngine({ resolver: probeResolver, fallbackBackendId: null });
      engine.router.replace(QWEN.engine, local.adapter as never);
      const events = await drainEvents(
        engine.stream({
          messages: [{ role: 'user', content: 'file notes until I say stop' }],
          target: ON_DEVICE,
          toolIds: [probe.tool.id],
          mcpEgress: GRANTED_PROBE,
        }),
      );

      const receipts = events.flatMap((event) => (event.type === 'tool' ? [event.tool.receipt] : []));
      expect(probe.call, 'sent to the server').toHaveBeenCalledTimes(8);
      expect(receipts.slice(8), 'the last round’s calls').toEqual([
        expect.objectContaining({ outcome: 'withheld', why: 'round-limit' }),
        expect.objectContaining({ outcome: 'withheld', why: 'round-limit' }),
      ]);
    } finally {
      toolRegistry.unregister(probe.tool.id);
    }
  });
});

/* ── A call whose body is not JSON: Python's keyword arguments ────────── */

describe('a call written as Python writes one, name(key=value, …), in a tag or after [TOOL_CALLS]', () => {
  // The stripper read only a JSON body, so a finished reply kept such a call,
  // arguments and all, and sent it back in every later request. Main's lazy
  // strips had removed it. A tag body holding Python's None, or two calls one
  // of which holds True, was kept the same way until a8e19ea.
  const FINISHED = [
    ['a tag call', '<tool_call>calculate(expression="6*7", note="canary-7f3a")</tool_call>'],
    ['a [TOOL_CALLS] call', '[TOOL_CALLS] calculate(expression="6*7", note="canary-7f3a")'],
    ['single quotes and Python’s literals', "<tool_call>calculate(expression='6*7', exact=True, note='canary-7f3a', unit=None)</tool_call>"],
    ['a name before a dict holding None', "<tool_call>calculate({'expression': '6*7', 'note': 'canary-7f3a', 'unit': None})</tool_call>"],
  ] as const;

  for (const [form, call] of FINISHED) {
    it(`${form}, finished: runs, and none of it is stored or sent back`, async () => {
      const id = `rv6_python_${form.replace(/\W+/g, '_')}`;
      given(chat(id, { tools: ['calculator'] }), [user(id, 1, 'hello'), reply(id, 2, 'Hi.')]);
      const local = recordingBackend([`Working it out.\n${call}\nOne moment.`, 'It is 42.']);
      engineWith(local);

      await useChats.getState().send('what is six times seven?');
      await useChats.getState().send('thanks');

      const stored = assistantRows(id)[1]!;
      expect(stored.toolCalls?.map((ran) => ran.output), 'the call that ran').toEqual(['6*7 = 42']);
      expect(stored.content, 'the stored reply').toBe('Working it out.\n\nOne moment.\n\nIt is 42.');
      expect(JSON.stringify(local.seen.at(-1)?.messages), 'the next request').not.toContain('canary-7f3a');
    });
  }

  it('two calls in a tag, one holding True, finished: both run, and none of them is stored or sent back', async () => {
    const id = 'rv6_python_two_calls';
    given(chat(id, { tools: ['calculator'] }), [user(id, 1, 'hello'), reply(id, 2, 'Hi.')]);
    const call =
      '<tool_call>\n{"name": "calculate", "arguments": {"expression": "6*7", "exact": True, "note": "canary-7f3a"}}\n{"name": "calculate", "arguments": {"expression": "6*8"}}\n</tool_call>';
    const local = recordingBackend([`Working it out.\n${call}`, 'Done.']);
    engineWith(local);

    await useChats.getState().send('six times seven, and six times eight?');
    await useChats.getState().send('thanks');

    const stored = assistantRows(id)[1]!;
    expect(stored.toolCalls?.map((ran) => ran.output), 'the calls that ran').toEqual(['6*7 = 42', '6*8 = 48']);
    expect(JSON.stringify(local.seen.at(-1)?.messages), 'the next request').not.toContain('canary-7f3a');
  });

  for (const [form, partial] of [
    ['a tag call', 'Filing it now.\n<tool_call>notes.note(text="canary-7f3a'],
    ['a [TOOL_CALLS] call', 'Filing it now.\n[TOOL_CALLS] note(pinned=True, text="canary-7f3a'],
  ] as const) {
    it(`${form}, stopped inside its arguments: keeps the words before it, and sends none of it back`, async () => {
      const id = `rv6_python_stopped_${form.replace(/\W+/g, '_')}`;
      const gate = held();
      const local = scriptedBackend([{ partial, stall: gate.promise }, { reply: 'Fine.' }]);
      let stopped: Message | undefined;
      const probe = await inToolsChat(id, async () => {
        engineWith(local);
        await stopAfterSome('file a note', 'canary-7f3a', gate.release);
        stopped = assistantRows(id).at(-1);
        await useChats.getState().send('thanks');
      });

      expect(probe.call, 'MCP calls').not.toHaveBeenCalled();
      expect({ content: stopped?.content, stopped: stopped?.stopped }, 'the stored reply').toEqual({
        content: 'Filing it now.',
        stopped: undefined,
      });
      expect(JSON.stringify(local.seen[1]?.messages), 'the next request').not.toContain('canary-7f3a');
    });
  }

  it('a tag call Stop caught complete: is recorded as not sent, and none of it is stored (refs #293)', async () => {
    const id = 'rv6_python_stranded';
    const gate = held();
    const local = scriptedBackend([
      { partial: 'Filing it now.\n<tool_call>notes.note(text="canary-7f3a")</tool_call>\nWaiting', stall: gate.promise },
    ]);
    let stopped: Message | undefined;
    const probe = await inToolsChat(id, async () => {
      engineWith(local);
      await stopAfterSome('file a note', 'Waiting', gate.release);
      stopped = assistantRows(id).at(-1);
    });

    expect(probe.call, 'MCP calls').not.toHaveBeenCalled();
    expect(stopped?.toolCalls?.map((recorded) => recorded.receipt), 'recorded as not sent').toEqual([
      expect.objectContaining({ outcome: 'withheld', why: 'stopped', toolName: 'notes.note' }),
    ]);
    expect(stopped?.content, 'the stored reply').toMatch(/^Filing it now\.\s+Waiting$/);
  });
});

/* ── Review round 7: an MCP tool's name in the [TOOL_CALLS] forms ───── */

describe('a [TOOL_CALLS] call to an MCP tool, whose name and id hold a dot and a colon', () => {
  // Every MCP tool is named `server.tool`, with the id `mcp:server.tool`, and
  // each `[TOOL_CALLS]` form read a call's name as a word alone. So a call to
  // one was never read: finished, the server was never called, and the call,
  // arguments and all, was stored and sent back in every later request;
  // stopped inside it, nothing was cut; and Stop catching it complete wrote no
  // record that it had not gone.
  const GRANT = { kind: 'mcp', serverId: PROBE_SERVER.serverId, url: PROBE_SERVER.url, grantedAt: 1 } as const;

  for (const [form, call] of [
    ['by its name, with JSON', '[TOOL_CALLS] notes.note({"text": "canary-7f3a"})'],
    ['by its id, with JSON', '[TOOL_CALLS] mcp:notes.note({"text": "canary-7f3a"})'],
    ['by its name, with Python’s keyword arguments', '[TOOL_CALLS] notes.note(text="canary-7f3a")'],
  ] as const) {
    it(`${form}, finished: is sent once, and none of it is stored or sent back`, async () => {
      const id = `rv7_mcp_name_${form.replace(/\W+/g, '_')}`;
      const probe = mcpProbe();
      given(chat(id, { tools: [probe.tool.id], egressGrants: [GRANT] }), [user(id, 1, 'hello'), reply(id, 2, 'Hi.')]);
      const local = recordingBackend([`Filing it.\n${call}`, 'Filed.', 'Fine.']);
      engineWith(local);

      try {
        toolRegistry.register(probe.tool);
        await useChats.getState().send('file a note');
        await useChats.getState().send('thanks');
      } finally {
        toolRegistry.unregister(probe.tool.id);
      }

      expect(probe.call, 'sent to the server').toHaveBeenCalledTimes(1);
      expect(probe.call.mock.calls[0]?.[2], 'its arguments').toEqual({ text: 'canary-7f3a' });
      expect(assistantRows(id)[1]?.content, 'the stored reply').toBe('Filing it.\n\nFiled.');
      expect(JSON.stringify(local.seen.at(-1)?.messages), 'the next request').not.toContain('canary-7f3a');
    });
  }

  for (const [form, partial, marker] of [
    ['inside its JSON', 'Filing it.\n[TOOL_CALLS] notes.note({"text": "canary-7f3a', 'canary-7f3a'],
    ['inside its keyword arguments', 'Filing it.\n[TOOL_CALLS] mcp:notes.note(text="canary-7f3a', 'canary-7f3a'],
    ['on its name', 'Filing it.\n[TOOL_CALLS] notes.no', 'notes.no'],
  ] as const) {
    it(`stopped ${form}: keeps the words before it, and sends none of it back`, async () => {
      const id = `rv7_mcp_name_stopped_${form.replace(/\W+/g, '_')}`;
      const gate = held();
      const local = scriptedBackend([{ partial, stall: gate.promise }, { reply: 'Fine.' }]);
      let stopped: Message | undefined;
      const probe = await inToolsChat(id, async () => {
        engineWith(local);
        await stopAfterSome('file a note', marker, gate.release);
        stopped = assistantRows(id).at(-1);
        await useChats.getState().send('thanks');
      });

      expect(probe.call, 'MCP calls').not.toHaveBeenCalled();
      expect({ content: stopped?.content, stopped: stopped?.stopped }, 'the stored reply').toEqual({
        content: 'Filing it.',
        stopped: undefined,
      });
      expect(JSON.stringify(local.seen[1]?.messages), 'the next request').not.toContain('notes.no');
    });
  }

  it('Stop caught complete: is recorded as not sent, and none of it is stored (refs #293)', async () => {
    const id = 'rv7_mcp_name_stranded';
    const gate = held();
    const local = scriptedBackend([
      { partial: 'Filing it.\n[TOOL_CALLS] notes.note({"text": "canary-7f3a"})\nWaiting', stall: gate.promise },
    ]);
    let stopped: Message | undefined;
    const probe = await inToolsChat(id, async () => {
      engineWith(local);
      await stopAfterSome('file a note', 'Waiting', gate.release);
      stopped = assistantRows(id).at(-1);
    });

    expect(probe.call, 'MCP calls').not.toHaveBeenCalled();
    expect(stopped?.toolCalls?.map((recorded) => recorded.receipt), 'recorded as not sent').toEqual([
      expect.objectContaining({ outcome: 'withheld', why: 'stopped', toolName: 'notes.note' }),
    ]);
    expect(stopped?.content, 'the stored reply').toMatch(/^Filing it\.\s+Waiting$/);
  });
});
