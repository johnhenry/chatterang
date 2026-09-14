/**
 * THE EDIT SHEET DOES NOT OFFER TO START A TURN WHILE ONE IS RUNNING.
 *
 * "Save and regenerate" starts a turn, and the store refuses a turn while one
 * is running (tests/stop-every-turn.test.ts). The sheet closed on the press
 * either way, so a refused edit threw away what the person had typed without a
 * word. The composer does not offer Send while a turn runs; the sheet now does
 * the same, and stays open with the text in it.
 *
 * Driven through the real `ChatScreen` in a real DOM, against the real store.
 */

import { createElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { InstalledModel } from '@/db';
import type { Chat, Message } from '@/domain/chat';

const tables = vi.hoisted(() => ({
  models: { put: vi.fn(async () => {}), delete: vi.fn(async () => {}), toArray: async () => [] },
  settings: { get: vi.fn(async () => undefined), put: vi.fn(async () => {}) },
  chats: { put: vi.fn(async () => {}), delete: vi.fn(async () => {}), toArray: async () => [] },
  messages: {
    put: vi.fn(async () => {}),
    delete: vi.fn(async () => {}),
    where: () => ({ equals: () => ({ sortBy: async () => [], toArray: async () => [] }) }),
  },
  benchmarks: {
    put: vi.fn(async () => {}),
    delete: vi.fn(async () => {}),
    clear: vi.fn(async () => {}),
    orderBy: () => ({ reverse: () => ({ toArray: async () => [] }) }),
  },
  connections: { put: vi.fn(async () => {}), delete: vi.fn(async () => {}), toArray: async () => [] },
}));

vi.mock('@/db', () => ({
  db: tables,
  deleteChat: vi.fn(async () => {}),
  readSetting: async (_key: string, fallback: unknown) => fallback,
  writeSetting: vi.fn(async () => {}),
}));

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');

const { useChats } = await import('@/state/chat');
const { useModels } = await import('@/state/models');
const { useApp } = await import('@/state/app');
const { catalogEntry } = await import('@/data/catalog');
const { DEFAULT_SAMPLER } = await import('@/domain/manifest');
const { ChatScreen } = await import('@/features/chat/ChatScreen');

const QWEN = catalogEntry('qwen3-4b-instruct-q4km')!;

const CHAT: Chat = {
  id: 'c1',
  title: 'One',
  mode: 'chat',
  personaId: null,
  modelId: QWEN.id,
  sampler: null,
  tools: [],
  showThinking: false,
  createdAt: 1,
  updatedAt: 1,
  messageCount: 2,
  preview: '',
};

const THREAD: Message[] = [
  { id: 'u1', chatId: 'c1', role: 'user', content: 'hello', createdAt: 1 },
  { id: 'r1', chatId: 'c1', role: 'assistant', content: 'Hi.', createdAt: 2 },
];

beforeEach(() => {
  const installed: InstalledModel = {
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
  };
  useModels.setState({
    loaded: true,
    activeModelId: QWEN.id,
    progress: {},
    storage: { used: 0, quota: 0 },
    installed: { [QWEN.id]: installed },
  });
  useChats.setState({
    loaded: true,
    chats: [CHAT],
    activeChatId: 'c1',
    messages: THREAD,
    generating: false,
    context: null,
  });
  useApp.setState({ connections: [], toasts: [] });
});

async function mounted(body: () => Promise<void>): Promise<void> {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => {
      root.render(createElement(ChatScreen));
    });
    await body();
  } finally {
    await act(async () => {
      root.unmount();
    });
    host.remove();
  }
}

const saveButton = (): HTMLButtonElement | undefined =>
  [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (element) => element.textContent?.trim() === 'Save and regenerate',
  );

async function openEditSheet(): Promise<void> {
  await act(async () => {
    (document.querySelector('[aria-label="Edit and resend"]') as HTMLElement).click();
  });
  expect(saveButton(), 'the edit sheet is open').toBeDefined();
}

describe('the edit sheet', () => {
  it('does not offer "Save and regenerate" while a turn is running, and keeps the sheet open', async () => {
    await mounted(async () => {
      await openEditSheet();
      await act(async () => {
        useChats.setState({ generating: true });
      });

      expect(saveButton()?.disabled, 'while a turn is running').toBe(true);
      await act(async () => {
        saveButton()?.click();
      });
      expect(saveButton(), 'the sheet, and what was typed in it, stay').toBeDefined();

      await act(async () => {
        useChats.setState({ generating: false });
      });
      expect(saveButton()?.disabled, 'once it has settled').toBe(false);
    });
  });

  it('offers it when no turn is running (the control)', async () => {
    await mounted(async () => {
      await openEditSheet();
      expect(saveButton()?.disabled).toBe(false);
    });
  });
});

/*
 * THE COMPOSER KEEPS WHAT WAS TYPED WHILE A TURN IS RUNNING.
 *
 * Send is not on screen during a turn — Stop is — but Enter in the field and
 * the Send command still reached the composer's send, which handed the text to
 * the store and cleared the field. The store refuses a turn while one runs, so
 * what was typed was gone. The same loss the edit sheet above had.
 */
describe('the composer', () => {
  const field = (): HTMLTextAreaElement =>
    document.querySelector<HTMLTextAreaElement>('textarea.composer__input')!;

  async function type(text: string): Promise<void> {
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
    await act(async () => {
      setValue.call(field(), text);
      field().dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(field().value, 'what was typed').toBe(text);
  }

  /** Each way of sending; the command also says whether anything claimed it. */
  const WAYS: Record<string, () => Promise<boolean | undefined>> = {
    'Mod+Enter in the field': async () => {
      await act(async () => {
        field().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));
      });
      return undefined;
    },
    'the Send command': async () => {
      const { runCommand } = await import('@/lib/keys');
      let handled = false;
      await act(async () => {
        handled = runCommand('chat.send');
      });
      return handled;
    },
  };

  it.each(Object.keys(WAYS))(
    'sends nothing and keeps the text while a turn is running, through %s',
    async (way) => {
      const original = useChats.getState().send;
      const send = vi.fn(async () => {});
      useChats.setState({ send });
      try {
        await mounted(async () => {
          await act(async () => {
            useChats.setState({ generating: true });
          });
          await type('my next question');
          const handled = await WAYS[way]!();

          expect(send, 'sends handed to the store').not.toHaveBeenCalled();
          expect(field().value, 'the text, still in the field').toBe('my next question');
          if (handled !== undefined) {
            // Handed back, as a disabled composer hands it back: nothing sent.
            expect(handled, 'the command, claimed while a turn runs').toBe(false);
          }

          // Once the turn has settled, the same press sends it.
          await act(async () => {
            useChats.setState({ generating: false });
          });
          const handledAfter = await WAYS[way]!();
          expect(send).toHaveBeenCalledWith('my next question', []);
          expect(field().value).toBe('');
          if (handledAfter !== undefined) expect(handledAfter).toBe(true);
        });
      } finally {
        useChats.setState({ send: original });
      }
    },
  );
});
