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
  it('stores and sends back none of its markup or arguments', async () => {
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
    expect(last.toolCalls, 'no tool ran').toBeUndefined();
    expect({ content: last.content, stopped: last.stopped }, 'the stored reply').toEqual({ content: '', stopped: false });
    expect(refusals()).toEqual([]);
    expect(JSON.stringify(local.seen[1]?.messages), 'the next request').not.toContain('tool_call');
    expect(JSON.stringify(local.seen[1]?.messages), 'the next request').not.toContain('canary-7f3a');
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

  it('a tool definition naming an offered tool is not run, and stays in a finished reply', async () => {
    const id = 'r2_offered_definition';
    given(chat(id, { tools: ['calculator'] }), [user(id, 1, 'hello'), reply(id, 2, 'Hi.')]);
    const text =
      'My calculator is declared like this:\n\n```json\n{"name": "calculate", "description": "Evaluate arithmetic", ' +
      '"parameters": {"type": "object", "properties": {"expression": {"type": "string"}}}}\n```';
    const local = recordingBackend([text, 'Anything else?']);
    engineWith(local);

    await useChats.getState().send('what tools do you have?');

    const last = assistantRows(id).at(-1)!;
    expect(last.toolCalls, 'no tool ran').toBeUndefined();
    expect(last.content, 'the words the person watched arrive').toBe(text);
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

  for (const [form, text] of CASES) {
    it(`in ${form} after words: a finished reply stores and sends back none of it`, async () => {
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
      expect(stored.toolCalls, 'no tool ran').toBeUndefined();
      expect(stored.content, 'the stored reply').toBe('Let me look.');
      expect(JSON.stringify(local.seen[1]?.messages), 'the next request').not.toContain('canary-7f3a');
    });
  }

  it('that was all a finished reply wrote: stores and sends back none of it', async () => {
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
    expect({ content: stored.content, stopped: stored.stopped }, 'the stored reply').toEqual({ content: '', stopped: false });
    expect(JSON.stringify(local.seen[1]?.messages), 'the next request').not.toContain('tool_call');
    expect(JSON.stringify(local.seen[1]?.messages), 'the next request').not.toContain('canary-7f3a');
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

  it('after words: a finished reply stores and sends back none of it', async () => {
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
    expect(stored.content, 'the stored reply').toBe('Let me check.');
    expect(JSON.stringify(local.seen[1]?.messages), 'the next request').not.toContain('tool_call');
    expect(JSON.stringify(local.seen[1]?.messages), 'the next request').not.toContain('canary-7f3a');
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
