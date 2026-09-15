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
