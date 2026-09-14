/**
 * A DELETED CONVERSATION TAKES THE DRAFT BEING WRITTEN IN IT.
 *
 * Owner rulings, 2026-09-14:
 *
 * R1. Deleting a chat discards the composer's draft for that chat — its text and
 *     every attached image chip — and deletes those images' payloads at once, so
 *     "removed from this device" holds immediately and a draft never carries over
 *     into another conversation. Deleting a different chat leaves the draft alone.
 * R2. Settings › delete all conversations also empties the composer.
 *
 * The composer is not keyed by chat: its text and chips stayed on screen when
 * the open chat was deleted, and were there in whichever chat opened next, while
 * the images' payloads stayed on disk until they were sent, removed, or swept at
 * the next launch.
 *
 * The REAL `ChatScreen`, `SettingsScreen` and `Composer`, in a real DOM, over the
 * real store and `lib/blobs.ts`. The database is held in memory at the table
 * boundary: a row is applied when its write is MADE, except a payload, which
 * lands only when its put is let go, so a test can hold one in flight.
 */

import { createElement, Fragment } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
  /** Attachment payloads, by attachment id. */
  const blobs = new Map<string, Row>();
  /** Every payload id whose put has landed. */
  const landed = new Set<string>();
  const holding = new Set<string>();
  const waiting = new Map<string, (() => void)[]>();
  const clone = <T,>(value: T): T => structuredClone(value);

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
      toArray: async () => [...chats.values()].map(clone),
      orderBy: () => ({
        reverse: () => ({
          toArray: async () => [...chats.values()].map(clone).sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0)),
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
      each: async (callback: (row: Row) => void) => {
        for (const row of [...messages.values()].map(clone)) callback(row);
      },
    },
    blobs: {
      // Lands once it is let go: a held put is in flight.
      put: vi.fn(async (row: Row) => {
        await gate('blobs.put');
        blobs.set(row.id, { id: row.id });
        landed.add(row.id);
      }),
      get: vi.fn(async (id: string) => blobs.get(id)),
      bulkDelete: vi.fn(async (ids: string[]) => {
        for (const id of ids) blobs.delete(id);
      }),
      toCollection: () => ({ primaryKeys: async () => [...blobs.keys()] }),
      each: async () => {},
    },
    models: { put: vi.fn(async () => {}), delete: vi.fn(async () => {}), toArray: async () => [] },
    settings: { get: vi.fn(async () => undefined), put: vi.fn(async () => {}) },
    connections: { put: vi.fn(async () => {}), delete: vi.fn(async () => {}), toArray: async () => [] },
    mcpServers: { put: vi.fn(async () => {}), delete: vi.fn(async () => {}), toArray: async () => [] },
    benchmarks: {
      put: vi.fn(async () => {}),
      delete: vi.fn(async () => {}),
      clear: vi.fn(async () => {}),
      orderBy: () => ({ reverse: () => ({ toArray: async () => [] }) }),
    },
  };

  /** The cascade `db/index.ts` runs, applied when it is made. */
  const deleteChat = vi.fn(async (chatId: string) => {
    for (const row of [...messages.values()]) {
      if (row.chatId !== chatId) continue;
      for (const attachment of row.attachments ?? []) blobs.delete(attachment.id);
      messages.delete(row.id);
    }
    chats.delete(chatId);
    await gate('deleteChat');
  });

  /**
   * What `db/index.ts` clears, applied when it is made. It settles only once
   * `clearAll` is let go: Settings reloads the page when it does, and jsdom
   * cannot navigate.
   */
  const clearAllConversations = vi.fn(async () => {
    messages.clear();
    chats.clear();
    blobs.clear();
    await gate('clearAll');
  });

  return {
    db,
    deleteChat,
    clearAllConversations,
    chats,
    messages,
    blobs,
    landed,
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
      landed.clear();
      holding.clear();
      // Dropped, not let go: a clear that settled would reload the page.
      waiting.delete('clearAll');
      for (const resolvers of waiting.values()) for (const resolve of resolvers.splice(0)) resolve();
    },
  };
});

vi.mock('@/db', () => ({
  db: fake.db,
  deleteChat: fake.deleteChat,
  clearAllConversations: fake.clearAllConversations,
  eraseEverything: vi.fn(async () => {}),
  readSetting: async (_key: string, fallback: unknown) => fallback,
  writeSetting: vi.fn(async () => {}),
}));

/** The speech plugin, answering when a test says so. */
const speech = vi.hoisted(() => ({
  partial: null as ((event: { requestId: string; text: string }) => void) | null,
  requestId: '',
  finish: null as ((result: { text: string }) => void) | null,
  cancel: vi.fn(async (_options: unknown) => undefined),
  /** While set, opening the speech model waits for it. */
  opening: null as Promise<void> | null,
  /** While set, starting to listen for partial transcripts waits for it. */
  listening: null as Promise<void> | null,
  sessions: 0,
  listeners: 0,
  transcriptions: 0,
}));

vi.mock('@/plugins/onnx-runtime', async (importOriginal) => {
  return {
    ...(await importOriginal<typeof import('@/plugins/onnx-runtime')>()),
    OnnxRuntime: {
      createSession: async (options: { task: string }) => {
        speech.sessions += 1;
        if (speech.opening) await speech.opening;
        return { handle: 'sess-stt', task: options.task, provider: 'cpu', warnings: [] };
      },
      releaseSession: async () => undefined,
      releaseTask: async () => undefined,
      cancel: (options: unknown) => speech.cancel(options),
      addListener: async (_event: string, listener: (event: { requestId: string; text: string }) => void) => {
        speech.listeners += 1;
        if (speech.listening) await speech.listening;
        speech.partial = listener;
        return { remove: async () => undefined };
      },
      transcribe: (options: { requestId: string }) =>
        new Promise<{ text: string }>((resolve) => {
          speech.transcriptions += 1;
          speech.requestId = options.requestId;
          speech.finish = resolve;
        }),
    },
  };
});

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');

const { useChats } = await import('@/state/chat');
const { useModels } = await import('@/state/models');
const { useApp } = await import('@/state/app');
const { catalogEntry } = await import('@/data/catalog');
const { DEFAULT_SAMPLER } = await import('@/domain/manifest');
const { ChatScreen } = await import('@/features/chat/ChatScreen');
const { SettingsScreen } = await import('@/features/settings/SettingsScreen');
const { anotherWindow, installedLocks } = await import('./support/web-locks');

type Chat = import('@/domain/chat').Chat;
type Message = import('@/domain/chat').Message;
type InstalledModel = import('@/db').InstalledModel;
type Root = import('react-dom/client').Root;

/** A model that takes images, so the composer offers to attach one. */
const GEMMA = catalogEntry('gemma-3-4b-it-q4km')!;
const WHISPER = catalogEntry('whisper-tiny-en-onnx')!;

function installed(manifest: typeof GEMMA): InstalledModel {
  return {
    id: manifest.id,
    manifest,
    state: 'installed',
    downloadedBytes: manifest.sizeBytes,
    paths: { model: `/dev/${manifest.id}` },
    sampler: { ...DEFAULT_SAMPLER },
    systemPrompt: '',
    installedAt: 1,
    lastUsedAt: null,
    useCount: 0,
  };
}

function chat(id: string, updatedAt: number): Chat {
  return {
    id,
    title: id,
    mode: 'chat',
    personaId: null,
    modelId: GEMMA.id,
    sampler: null,
    tools: [],
    showThinking: false,
    createdAt: updatedAt,
    updatedAt,
    messageCount: 0,
    preview: '',
  };
}

/**
 * Chat `id` is open, and `${id}_next` is the one the list opens after it. Every
 * test uses ids of its own: a chat id is never reused in the app, and the store
 * remembers every chat it has deleted for as long as it runs.
 */
function given(id: string): { next: string } {
  const next = `${id}_next`;
  const chats = [chat(id, 2), chat(next, 1)];
  for (const entry of chats) fake.chats.set(entry.id, structuredClone(entry));
  useChats.setState({
    loaded: true,
    chats,
    activeChatId: id,
    messages: [],
    generating: false,
    controller: null,
    context: null,
  });
  return { next };
}

const inStore = (id: string): boolean => useChats.getState().chats.some((entry) => entry.id === id);
const rowsFor = (chatId: string): Row[] => [...fake.messages.values()].filter((row) => row.chatId === chatId);
const macrotask = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** Wait for a step the code must reach, failing with its name if it never does. */
async function until(what: string, condition: () => boolean | Promise<boolean>): Promise<void> {
  for (let tries = 0; tries < 400; tries += 1) {
    if (await condition()) return;
    await act(async () => {
      await macrotask();
    });
  }
  throw new Error(`waited for ${what}`);
}

/** A turn that writes one reply, for the sends below. */
function scriptedEngine(): unknown {
  return {
    async *stream() {
      yield {
        type: 'done',
        text: 'A cat.',
        provenance: {
          backendId: 'llama-cpp',
          engine: 'llama-cpp',
          modelId: GEMMA.id,
          modelName: 'Gemma 3 4B',
          local: true,
        },
        stats: { promptTokens: 8, completionTokens: 4 },
      };
    },
  };
}

let host: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  fake.reset();
  vi.clearAllMocks();
  speech.partial = null;
  speech.finish = null;
  speech.requestId = '';
  speech.opening = null;
  speech.listening = null;
  speech.sessions = 0;
  speech.listeners = 0;
  speech.transcriptions = 0;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  // The chip previews its payload through an object URL, which jsdom lacks.
  Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:preview'), revokeObjectURL: vi.fn() });
  useModels.setState({
    loaded: true,
    activeModelId: GEMMA.id,
    progress: {},
    storage: { used: 0, quota: 0 },
    installed: { [GEMMA.id]: installed(GEMMA), [WHISPER.id]: installed(WHISPER) },
  });
  useApp.setState({ toasts: [], connections: [], engine: scriptedEngine() as never });
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  for (const name of ['blobs.put', 'messages.put', 'deleteChat']) fake.release(name);
});

async function render(tree: ReturnType<typeof createElement>): Promise<void> {
  if (!host) {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  }
  await act(async () => {
    root?.render(tree);
  });
}

const field = (): HTMLTextAreaElement => {
  const element = document.querySelector<HTMLTextAreaElement>('textarea.composer__input');
  if (!element) throw new Error('no composer on screen');
  return element;
};
const chips = (): HTMLButtonElement[] => [
  ...document.querySelectorAll<HTMLButtonElement>('button[aria-label="Remove attachment"]'),
];
const buttonNamed = (text: string): HTMLButtonElement | undefined =>
  [...document.querySelectorAll<HTMLButtonElement>('button')].find((element) => element.textContent?.trim() === text);

async function type(text: string): Promise<void> {
  const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  await act(async () => {
    setValue.call(field(), text);
    field().dispatchEvent(new Event('input', { bubbles: true }));
  });
  expect(field().value, 'the control: what was typed').toBe(text);
}

/** Pick an image in the file chooser, without waiting for anything to be written. */
async function choose(): Promise<void> {
  const input = document.querySelector<HTMLInputElement>('.composer input[type="file"]');
  if (!input) throw new Error('the composer offers no file input');
  const file = new File([new Uint8Array([137, 80, 78, 71])], 'cat.png', { type: 'image/png' });
  Object.defineProperty(input, 'files', { configurable: true, value: { 0: file, length: 1 } });
  await act(async () => {
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

/** Pick an image. Resolves with its id once its put has been MADE, landed or not. */
async function pick(): Promise<string> {
  const before = fake.db.blobs.put.mock.calls.length;
  await choose();
  await until('the image’s put to be made', () => fake.db.blobs.put.mock.calls.length === before + 1);
  return (fake.db.blobs.put.mock.calls[before]![0] as Row).id;
}

/** Pick an image and let its write land and its chip render. */
async function attach(): Promise<string> {
  const shown = chips().length;
  const id = await pick();
  await until('the image’s chip', () => fake.landed.has(id) && chips().length === shown + 1);
  return id;
}

/** Delete a chat from the chat list, through the sheet that asks. */
async function deleteFromList(title: string): Promise<void> {
  const trash = document.querySelector<HTMLButtonElement>(`button[aria-label="Delete ${title}"]`);
  if (!trash) throw new Error(`no delete button for ${title}`);
  await act(async () => trash.click());
  const confirm = buttonNamed('Delete');
  if (!confirm) throw new Error('the delete sheet did not open');
  await act(async () => confirm.click());
}

/* ── R1 ──────────────────────────────────────────────────────────────── */

describe('deleting the chat the draft is being written in', () => {
  it('empties the composer and deletes every attached image’s payload at once, and nothing reaches the next chat', async () => {
    const { next } = given('at_once');
    await render(createElement(ChatScreen));
    await type('half a thought');
    const first = await attach();
    const second = await attach();
    fake.hold('blobs.put');
    const writing = await pick();
    expect(fake.landed.has(writing), 'the control: one image is still being written').toBe(false);
    fake.hold('deleteChat');

    await deleteFromList('at_once');

    // AT ONCE: the chat's own delete is still being carried out.
    expect(inStore('at_once'), 'the control: the chat’s delete has not landed').toBe(true);
    expect.soft(field().value, 'the text').toBe('');
    expect.soft(chips(), 'the chips').toHaveLength(0);
    expect.soft(fake.blobs.has(first), 'the first image').toBe(false);
    expect.soft(fake.blobs.has(second), 'the second image').toBe(false);

    // The image being written is deleted once its write lands, and never shown.
    fake.release('blobs.put');
    await until('the image written after the delete to be deleted', () => fake.landed.has(writing) && !fake.blobs.has(writing));

    fake.release('deleteChat');
    await until('the next chat to open', () => useChats.getState().activeChatId === next);
    await act(async () => {
      await macrotask();
    });
    expect(field().value, 'in the chat opened next').toBe('');
    expect(chips(), 'in the chat opened next').toHaveLength(0);
    expect([...fake.blobs.keys()], 'the table').toEqual([]);
  });

  it('leaves the draft and its images alone when another chat is deleted', async () => {
    const { next } = given('kept');
    await render(createElement(ChatScreen));
    await type('still mine');
    const id = await attach();

    await deleteFromList(next);
    await until('the other chat’s delete to land', () => !inStore(next));

    expect(field().value).toBe('still mine');
    expect(chips()).toHaveLength(1);
    expect(fake.blobs.has(id)).toBe(true);
  });

  it('stops dictation into the draft, and writes nothing it transcribes afterwards', async () => {
    // A transcription still running would put its words into the composer —
    // in whichever chat is open by then.
    given('dictated');
    await render(createElement(ChatScreen));
    const dictate = document.querySelector<HTMLButtonElement>('button[aria-label="Dictate"]');
    await act(async () => dictate?.click());
    await until('the transcription to start', () => speech.partial !== null && speech.finish !== null);
    await act(async () => speech.partial?.({ requestId: speech.requestId, text: 'half a' }));
    expect(field().value, 'the control: dictation types into the draft').toBe('half a');

    await deleteFromList('dictated');

    expect(field().value).toBe('');
    expect(speech.cancel, 'the transcription is cancelled').toHaveBeenCalled();
    await act(async () => {
      speech.partial?.({ requestId: speech.requestId, text: 'half a thought' });
      speech.finish?.({ text: 'half a thought' });
      await macrotask();
    });
    expect(field().value, 'what it transcribed after the delete').toBe('');
  });

  /** A promise and what settles it. */
  function gate(): { promise: Promise<void>; open: () => void } {
    let open = (): void => {};
    const promise = new Promise<void>((resolve) => (open = resolve));
    return { promise, open };
  }

  const microphoneOff = (): boolean => document.querySelector('button[aria-label="Dictate"]') !== null;

  it('starts no transcription when the chat is deleted while the speech model is still opening', async () => {
    given('dictation_opening');
    await render(createElement(ChatScreen));
    const opening = gate();
    speech.opening = opening.promise;
    await act(async () => document.querySelector<HTMLButtonElement>('button[aria-label="Dictate"]')?.click());
    await until('the speech model to be opened', () => speech.sessions === 1);
    expect(microphoneOff(), 'the control: dictation is starting').toBe(false);

    await deleteFromList('dictation_opening');
    opening.open();
    await act(async () => {
      for (let turn = 0; turn < 5; turn += 1) await macrotask();
    });

    expect(speech.transcriptions, 'a transcription for the draft thrown away').toBe(0);
    expect(microphoneOff(), 'the microphone').toBe(true);
    expect(field().value).toBe('');
  });

  it('cancels a transcription that finished starting after the chat was deleted', async () => {
    given('dictation_starting');
    await render(createElement(ChatScreen));
    const listening = gate();
    speech.listening = listening.promise;
    await act(async () => document.querySelector<HTMLButtonElement>('button[aria-label="Dictate"]')?.click());
    await until('dictation to start listening', () => speech.listeners === 1);

    await deleteFromList('dictation_starting');
    listening.open();
    await until('the transcription to be cancelled', () => speech.cancel.mock.calls.length === 1);
    await act(async () => {
      speech.partial?.({ requestId: speech.requestId, text: 'too late' });
      speech.finish?.({ text: 'too late' });
      await macrotask();
    });

    expect(field().value).toBe('');
    expect(microphoneOff(), 'the microphone').toBe(true);
  });

  /*
   * THE DELETE FAILS — a full disk — and the chat is written back.
   *
   * The draft stays discarded, and its images stay deleted. That is NOT how
   * `removeChat` treats the chat's rows: rows refused while the delete ran are
   * written back when it fails, because they are the conversation, which is
   * still there, and some are records that cannot be made again (a receipt that
   * arguments went to an MCP server). A draft is what the person was about to
   * send in a conversation they asked to delete; its payloads went at once
   * (R1), which bringing them back would need them kept until the delete
   * settled. So it fails closed: what was asked to be removed stays removed.
   */
  it('stays discarded when the chat’s delete fails and the chat stays', async () => {
    given('refused');
    const row: Message = { id: 'refused_user', chatId: 'refused', role: 'user', content: 'hello', createdAt: 1 };
    fake.messages.set(row.id, structuredClone(row));
    useChats.setState({ messages: [row] });
    await render(createElement(ChatScreen));
    await type('never sent');
    const id = await attach();
    fake.deleteChat.mockImplementationOnce(async () => {
      throw new Error('The disk is full.');
    });

    await act(async () => {
      await expect(useChats.getState().removeChat('refused')).rejects.toThrow('The disk is full.');
    });

    expect(inStore('refused'), 'the control: the chat stays').toBe(true);
    expect(useChats.getState().activeChatId).toBe('refused');
    expect(rowsFor('refused').map((entry) => entry.id), 'and its thread').toEqual(['refused_user']);
    expect(field().value, 'the draft’s text').toBe('');
    expect(chips(), 'its chips').toHaveLength(0);
    expect(fake.blobs.has(id), 'its image').toBe(false);
  });

  it('keeps the draft discarded when the image being written lands after the delete failed', async () => {
    given('refused_writing');
    await render(createElement(ChatScreen));
    fake.hold('blobs.put');
    const id = await pick();
    fake.deleteChat.mockImplementationOnce(async () => {
      throw new Error('The disk is full.');
    });

    await act(async () => {
      await expect(useChats.getState().removeChat('refused_writing')).rejects.toThrow('The disk is full.');
    });
    fake.release('blobs.put');
    await until('the image to land and be deleted', () => fake.landed.has(id) && !fake.blobs.has(id));
    await act(async () => {
      await macrotask();
    });

    expect(chips(), 'no chip for it in the chat that stayed').toHaveLength(0);
  });
});

/*
 * A SEND IN FLIGHT WHEN THE DELETE RUNS.
 *
 * Sending hands the draft's images to the message and the composer lets go of
 * them (see `send` in Composer.tsx), so discarding the draft afterwards has
 * nothing of them to delete. What becomes of them is the message's: the store
 * refuses its row once the delete is asked for (`removedChats`), or the delete
 * takes the row with the payloads it names. Either way a row and its image go
 * together, or stay together — never a row naming an image already deleted.
 */
describe('a send in flight when its chat is deleted', () => {
  const image = (row: Row | undefined): string[] => (row?.attachments ?? []).map((entry) => entry.id);

  async function sendWithImage(chatId: string): Promise<{ id: string }> {
    given(chatId);
    await render(createElement(ChatScreen));
    await type('look');
    const id = await attach();
    fake.hold('messages.put');
    const send = document.querySelector<HTMLButtonElement>('button[aria-label="Send"]');
    await act(async () => send?.click());
    await until('the message’s row to be written', () => fake.pending('messages.put') === 1);
    expect(field().value, 'the control: sending emptied the composer').toBe('');
    return { id };
  }

  it('takes the message and its image together when the delete lands', async () => {
    const { id } = await sendWithImage('sent_gone');

    await act(async () => {
      const removing = useChats.getState().removeChat('sent_gone');
      fake.release('messages.put');
      await removing;
    });
    await until('the turn to settle', () => !useChats.getState().generating);

    expect(rowsFor('sent_gone'), 'the rows').toEqual([]);
    expect(fake.blobs.has(id), 'the image').toBe(false);
  });

  it('keeps the message and its image together when the delete fails', async () => {
    const { id } = await sendWithImage('sent_kept');
    fake.deleteChat.mockImplementationOnce(async () => {
      throw new Error('The disk is full.');
    });

    await act(async () => {
      await expect(useChats.getState().removeChat('sent_kept')).rejects.toThrow('The disk is full.');
      fake.release('messages.put');
    });
    await until('the turn to settle', () => !useChats.getState().generating);

    const user = rowsFor('sent_kept').find((row) => image(row).length > 0);
    expect(image(user), 'the message still names its image').toEqual([id]);
    expect(fake.blobs.has(id), 'and the image is there').toBe(true);
    expect(field().value).toBe('');
  });
});

/* ── Another window ──────────────────────────────────────────────────── */

describe('the same chat open in another window', () => {
  /*
   * The server profile serves this bundle to ordinary browser tabs over one
   * database, and each tab has its own store and composer. Nothing tells one tab
   * that another deleted a chat, so the draft in this one is its own: its text
   * and chips stay, and so do its payloads — no row names them, so the other
   * tab's delete does not take them, and this window's lock keeps them from any
   * sweep. It goes when this draft lets it go.
   */
  it('keeps this window’s draft when the other window deletes the chat', async () => {
    const { next } = given('elsewhere');
    await render(createElement(ChatScreen));
    await type('mine');
    const id = await attach();
    const other = await anotherWindow(async () => (await import('@/state/chat')).useChats);
    try {
      other.loaded.setState({
        loaded: true,
        chats: [chat('elsewhere', 2), chat(next, 1)],
        activeChatId: 'elsewhere',
        messages: [],
      });
      await other.loaded.getState().removeChat('elsewhere');
    } finally {
      other.close();
    }

    expect(fake.chats.has('elsewhere'), 'the control: the other window deleted it').toBe(false);
    expect(field().value).toBe('mine');
    expect(chips()).toHaveLength(1);
    expect(fake.blobs.has(id)).toBe(true);
  });
});

/* ── R2 ──────────────────────────────────────────────────────────────── */

describe('Settings › delete all conversations', () => {
  async function deleteAll(): Promise<void> {
    fake.hold('clearAll');
    const row = buttonNamed('Delete all conversationsModels and personas are kept.');
    if (!row) throw new Error('no “Delete all conversations” row');
    await act(async () => row.click());
    const confirm = buttonNamed('Delete all');
    if (!confirm) throw new Error('the delete-all sheet did not open');
    await act(async () => confirm.click());
    await until('the tables to be cleared', () => fake.clearAllConversations.mock.calls.length === 1);
  }

  it('leaves no draft behind, the way the app reaches it: the chat screen is left for Settings', async () => {
    // `App.tsx` renders one tab at a time, so opening Settings unmounts the
    // composer, which lets its draft go. The control for the test below.
    given('all_left');
    await render(createElement(ChatScreen));
    await type('half a thought');
    const id = await attach();

    await render(createElement(SettingsScreen));
    await deleteAll();
    await render(createElement(ChatScreen));

    expect(field().value).toBe('');
    expect(chips()).toHaveLength(0);
    expect(fake.blobs.has(id)).toBe(false);
  });

  it('empties a composer that is on screen, before the payloads are cleared', async () => {
    // Both at once, which `App.tsx` does not render today: the guarantee is the
    // delete-all path's, not an accident of which screen is mounted.
    given('all_shown');
    await render(createElement(Fragment, null, createElement(ChatScreen), createElement(SettingsScreen)));
    await type('half a thought');
    await attach();

    await deleteAll();

    expect.soft(field().value, 'the text').toBe('');
    expect.soft(chips(), 'no chip left pointing at a payload the delete cleared').toHaveLength(0);
    expect.soft(fake.blobs.size, 'the payloads').toBe(0);
  });
});

/* ── A write still waiting to join ───────────────────────────────────── */

describe('an image whose write is still waiting for this window to join the other windows', () => {
  /*
   * `putBlob` writes nothing until this window holds its Web Lock (see "Other
   * windows" in lib/blobs.ts), and that waits while another window sweeps. A
   * draft discarded meanwhile writes nothing at all: its bytes never reach the
   * table, rather than being written and deleted again.
   *
   * A window of its own, so that its lock is still to be taken: its module
   * graph, React included, is loaded while another window holds the sweep lock.
   */
  it('is never written when its chat is deleted meanwhile', async () => {
    const SWEEP = 'chatterang:attachment-sweep';
    const locks = installedLocks();
    const sweeper = locks.window();
    let letGo = (): void => {};
    const sweeping = sweeper.request(SWEEP, () => new Promise<void>((resolve) => (letGo = resolve)));
    await until('another window to hold the sweep lock', async () =>
      (await sweeper.query()).held!.some((lock) => lock.name === SWEEP),
    );

    const win = await anotherWindow(async () => ({
      Composer: (await import('@/features/chat/Composer')).Composer,
      useChats: (await import('@/state/chat')).useChats,
      react: await import('react'),
      client: await import('react-dom/client'),
    }));
    const container = document.createElement('div');
    document.body.append(container);
    const windowRoot = win.loaded.client.createRoot(container);
    try {
      expect(
        (await sweeper.query()).pending!.some((lock) => lock.name === SWEEP && lock.mode === 'shared'),
        'the control: the window is waiting to join',
      ).toBe(true);
      win.loaded.useChats.setState({ loaded: true, chats: [chat('locked', 1)], activeChatId: 'locked', messages: [] });
      await win.loaded.react.act(async () => {
        windowRoot.render(
          win.loaded.react.createElement(win.loaded.Composer, {
            disabled: false,
            generating: false,
            acceptsImages: true,
            placeholder: 'Message',
            onSend: () => undefined,
            onStop: () => undefined,
          }),
        );
      });
      const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
      const file = new File([new Uint8Array([1])], 'cat.png', { type: 'image/png' });
      Object.defineProperty(input, 'files', { configurable: true, value: { 0: file, length: 1 } });
      await win.loaded.react.act(async () => {
        input.dispatchEvent(new Event('change', { bubbles: true }));
        await macrotask();
      });
      expect(fake.db.blobs.put, 'the control: the write waits for the lock').not.toHaveBeenCalled();

      await win.loaded.react.act(async () => {
        await win.loaded.useChats.getState().removeChat('locked');
      });
      letGo();
      await sweeping;
      // This file's own window and the one opened here.
      await until('the window to join', async () =>
        (await sweeper.query()).held!.filter((lock) => lock.name?.startsWith('chatterang:attachment-window:')).length === 2,
      );
      await win.loaded.react.act(async () => {
        for (let turn = 0; turn < 5; turn += 1) await macrotask();
      });

      expect(fake.db.blobs.put, 'nothing written for a draft discarded while it waited').not.toHaveBeenCalled();
      expect(fake.blobs.size).toBe(0);
      expect(container.querySelector('button[aria-label="Remove attachment"]')).toBeNull();
    } finally {
      letGo();
      await win.loaded.react.act(async () => windowRoot.unmount());
      container.remove();
      win.close();
      locks.close(sweeper);
    }
  });
});
