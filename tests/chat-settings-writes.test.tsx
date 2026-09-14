/**
 * WHAT A PICKER WRITES IS ONE CHANGE, NOT THE CHAT IT WAS RENDERED FROM.
 *
 * The chat settings sheet built its writes out of the chat as it was on screen:
 * a tool toggle wrote the whole list with one id flipped, a sampler slider
 * wrote every override with one key changed. Writes to one chat run one at a
 * time and each is applied to the chat as it then stands, so a whole list
 * computed from an older render put back whatever had been taken out of it
 * since. The one that matters: removing an MCP server prunes its tools from
 * every chat, so a person does not find them on again under a different server
 * that later takes the name (#6) — and a toggle rendered before the prune wrote
 * the pruned tool back on.
 *
 * Driven through the real `ChatScreen`, its settings sheet and `SamplerPanel`,
 * in a real DOM, against the real store. The chats table is held open, which is
 * how a render stays stale long enough to click on.
 */

import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { InstalledModel } from '@/db';
import type { Chat } from '@/domain/chat';

/* ── The database, stubbed at the table boundary ────────────────────── */

const tables = vi.hoisted(() => {
  const stored = new Map<string, unknown>();
  const waiting: (() => void)[] = [];
  const state = { holding: false };
  return {
    stored,
    waiting,
    state,
    models: { put: vi.fn(async () => {}), delete: vi.fn(async () => {}), toArray: async () => [] },
    settings: { get: vi.fn(async () => undefined), put: vi.fn(async () => {}) },
    chats: {
      // Recorded in the order made, which is the order the table applies them in.
      put: vi.fn(async (chat: { id: string }) => {
        stored.set(chat.id, structuredClone(chat));
        if (state.holding) await new Promise<void>((resolve) => waiting.push(resolve));
      }),
      delete: vi.fn(async () => {}),
      toArray: async () => [],
    },
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
  };
});

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
const { useApp, pruneMcpToolsFor } = await import('@/state/app');
const { toolRegistry } = await import('@/ai/tools/registry');
const { catalogEntry } = await import('@/data/catalog');
const { DEFAULT_SAMPLER } = await import('@/domain/manifest');
const { ChatScreen } = await import('@/features/chat/ChatScreen');

const QWEN = catalogEntry('qwen3-4b-instruct-q4km')!;
const LLAMA = catalogEntry('llama-3.2-3b-instruct-q4km');

function installedRecord(manifest: typeof QWEN): InstalledModel {
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

/** A tool as `ai/mcp/tools.ts` names one: `mcp:<server name>.<tool>`, and sensitive. */
const NOTES_SEARCH = {
  id: 'mcp:notes.search',
  name: 'notes.search',
  description: 'Search notes on the notes server.',
  summary: 'notes.search on notes',
  sensitive: true,
  parameters: { type: 'object' as const, properties: {} },
  execute: async () => ({ output: '' }),
};

function given(overrides: Partial<Chat> = {}): void {
  const chat: Chat = {
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
    messageCount: 0,
    preview: '',
    ...overrides,
  };
  tables.stored.set(chat.id, structuredClone(chat));
  useModels.setState({
    loaded: true,
    activeModelId: QWEN.id,
    progress: {},
    storage: { used: 0, quota: 0 },
    installed: Object.fromEntries(
      [QWEN, ...(LLAMA ? [LLAMA] : [])].map((manifest) => [manifest.id, installedRecord(manifest)]),
    ),
  });
  useChats.setState({
    loaded: true,
    chats: [chat],
    activeChatId: 'c1',
    messages: [],
    generating: false,
    context: null,
  });
  useApp.setState({ connections: [], toasts: [] });
}

const current = (): Chat => useChats.getState().chats.find((entry) => entry.id === 'c1')!;
const storedChat = (): Chat => tables.stored.get('c1') as Chat;
const macrotask = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** Hold every chat put until `releaseAll`. */
function hold(): void {
  tables.state.holding = true;
}

async function releaseAll(): Promise<void> {
  tables.state.holding = false;
  await act(async () => {
    for (const resolve of tables.waiting.splice(0)) resolve();
    await macrotask();
  });
}

async function mounted(body: () => Promise<void>): Promise<void> {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => {
      root.render(createElement(ChatScreen));
    });
    await act(async () => {
      (document.querySelector('[aria-label="Chat settings"]') as HTMLElement).click();
    });
    await body();
  } finally {
    await releaseAll();
    await act(async () => {
      root.unmount();
    });
    host.remove();
  }
}

function toolChip(name: string): HTMLButtonElement {
  const chip = [...document.querySelectorAll<HTMLButtonElement>('button.chip--button')].find(
    (button) => button.textContent?.trim() === name,
  );
  expect(chip, `the ${name} chip is on screen`).toBeDefined();
  return chip!;
}

function sliderLabelled(label: string): HTMLInputElement {
  const labelElement = [...document.querySelectorAll('label.field__label')].find((element) =>
    element.textContent?.trim().startsWith(label),
  ) as HTMLLabelElement | undefined;
  expect(labelElement, `the ${label} slider is on screen`).toBeDefined();
  return document.getElementById(labelElement!.htmlFor) as HTMLInputElement;
}

function saveButton(): HTMLButtonElement {
  const button = [...document.querySelectorAll<HTMLButtonElement>('button')].find((element) =>
    element.textContent?.trim().startsWith('Save these as'),
  );
  expect(button, 'the Save as defaults button is on screen').toBeDefined();
  return button!;
}

/** The sampler values saved against the chat's model. */
const savedSampler = () => useModels.getState().installed[QWEN.id]?.sampler;

/** Set a form control the way a person does, so React's own handler runs. */
async function choose(element: HTMLInputElement | HTMLSelectElement, value: string): Promise<void> {
  const prototype = element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value);
    element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
  });
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.click();
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  tables.stored.clear();
  tables.state.holding = false;
  toolRegistry.register(NOTES_SEARCH);
});

afterEach(() => {
  toolRegistry.unregister(NOTES_SEARCH.id);
});

describe('a tool toggle rendered before an MCP server was removed', () => {
  it('does not switch the pruned tool back on', async () => {
    given({ tools: [NOTES_SEARCH.id] });

    await mounted(async () => {
      expect(toolChip('notes.search').getAttribute('aria-pressed')).toBe('true');
      hold();

      // Removing the server prunes its tools from every chat. Its write is held,
      // so the sheet still shows the tool on when the next click lands.
      const pruning = pruneMcpToolsFor('notes');
      await vi.waitFor(() => expect(tables.waiting.length).toBe(1));
      expect(toolChip('notes.search').getAttribute('aria-pressed'), 'the render is stale').toBe('true');

      await click(toolChip('calculate'));
      await releaseAll();
      await pruning;
      await vi.waitFor(() => expect(current().tools).toContain('calculator'));
      await macrotask();

      expect(current().tools, 'the store').toEqual(['calculator']);
      expect(storedChat().tools, 'the table').toEqual(['calculator']);
      expect(toolChip('notes.search').getAttribute('aria-pressed'), 'the sheet').toBe('false');
    });
  });

  it('does not switch it back on when that very chip is pressed to turn it off', async () => {
    given({ tools: [NOTES_SEARCH.id, 'calculator'] });

    await mounted(async () => {
      hold();
      const pruning = pruneMcpToolsFor('notes');
      await vi.waitFor(() => expect(tables.waiting.length).toBe(1));

      await click(toolChip('notes.search'));
      await releaseAll();
      await pruning;
      await macrotask();
      await macrotask();

      expect(current().tools).toEqual(['calculator']);
      expect(storedChat().tools).toEqual(['calculator']);
    });
  });
});

describe('two changes from the settings sheet, made before the first has landed', () => {
  it('keeps both sampler overrides', async () => {
    given();

    await mounted(async () => {
      hold();
      await choose(sliderLabelled('Temperature'), '1.3');
      await vi.waitFor(() => expect(tables.waiting.length).toBe(1));
      // The sheet still shows no override: the first change is being written.
      await choose(sliderLabelled('Top-P'), '0.5');
      await releaseAll();
      await vi.waitFor(() => expect(current().sampler).toHaveProperty('topP'));
      await macrotask();

      expect(current().sampler, 'the store').toEqual({ temperature: 1.3, topP: 0.5 });
      expect(storedChat().sampler, 'the table').toEqual({ temperature: 1.3, topP: 0.5 });
    });
  });

  it('lands a tool toggle and a model change made together', async () => {
    // Each owns a different field, so both must survive whichever lands last.
    expect(LLAMA, 'a second model to switch to').toBeDefined();
    given();

    await mounted(async () => {
      hold();
      await click(toolChip('calculate'));
      await vi.waitFor(() => expect(tables.waiting.length).toBe(1));
      await choose(document.getElementById('chat-model') as HTMLSelectElement, LLAMA!.id);
      await releaseAll();
      await vi.waitFor(() => expect(current().modelId).toBe(LLAMA!.id));
      await macrotask();

      expect(current()).toMatchObject({ tools: ['calculator'], modelId: LLAMA!.id });
      expect(storedChat()).toMatchObject({ tools: ['calculator'], modelId: LLAMA!.id });
    });
  });

  it('saves a change still being written as the model’s default, and does not lose it', async () => {
    // "Save these as defaults" saved the values this panel rendered, then
    // cleared the chat's overrides. A slider change still being written was in
    // neither: not in what was saved, and cleared once it landed.
    given();

    await mounted(async () => {
      hold();
      await choose(sliderLabelled('Temperature'), '1.3');
      await vi.waitFor(() => expect(tables.waiting.length).toBe(1));
      // The panel still shows the model's own temperature.
      await click(saveButton());
      await releaseAll();
      await vi.waitFor(() => expect(savedSampler()?.temperature, 'the model’s defaults').toBe(1.3));
      await vi.waitFor(() => expect(current().sampler).toBeNull());
      await macrotask();

      expect(current().sampler, 'the store').toBeNull();
      expect(storedChat().sampler, 'the table').toBeNull();
    });
  });

  it('keeps a change made while the defaults were being saved as this chat’s', async () => {
    // The paired control: what is cleared is what was saved, not whatever
    // overrides the chat holds by the time the defaults have been written.
    given();

    await mounted(async () => {
      let releaseModel = (): void => {};
      tables.models.put.mockImplementationOnce(
        () => new Promise<void>((resolve) => (releaseModel = resolve)),
      );
      await click(saveButton());
      await vi.waitFor(() => expect(tables.models.put).toHaveBeenCalled());

      await choose(sliderLabelled('Top-P'), '0.5');
      await vi.waitFor(() => expect(current().sampler).toEqual({ topP: 0.5 }));
      await act(async () => {
        releaseModel();
        await macrotask();
      });
      await macrotask();

      expect(current().sampler, 'the store').toEqual({ topP: 0.5 });
      expect(storedChat().sampler, 'the table').toEqual({ topP: 0.5 });
      expect(savedSampler()?.topP, 'not saved: it came after').toBe(DEFAULT_SAMPLER.topP);
    });
  });

  it('counts two flips of “Show reasoning” as two', async () => {
    given({ showThinking: false });

    await mounted(async () => {
      const toggle = document.querySelector('[aria-label="Show reasoning"]') as HTMLElement;
      hold();
      await click(toggle);
      await vi.waitFor(() => expect(tables.waiting.length).toBe(1));
      await click(toggle);
      await releaseAll();
      await macrotask();
      await macrotask();

      expect(tables.chats.put, 'both flips were written').toHaveBeenCalledTimes(2);
      expect(current().showThinking).toBe(false);
      expect(storedChat().showThinking).toBe(false);
    });
  });
});
