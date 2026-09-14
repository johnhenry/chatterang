/**
 * WHAT THE RAIL SAYS THE DEVICE IS DOING.
 *
 * The rail is the app's signature instrument and its honesty claim: "in an app
 * whose whole claim is 'this runs on your device', the user is entitled to see
 * that claim being kept." It was the last surface of the reported defect still
 * unrepaired. It resolved `chat?.modelId ?? activeModelId` and then
 * `installed[modelId]` — the exact resolution `chatTarget` was written to
 * replace — and treated the mere PRESENCE of a record as "a local model is
 * loaded here". So for the reported user, a chat pinned to Whisper, the rail
 * drew the flame chip (`chip--local`, the app's own mark for a resident local
 * model) and Whisper's 448-token window as a filling context readout, one line
 * above a screen reading "nothing is loaded and nothing will be sent".
 *
 * Every assertion here is read out of a real DOM, rendered with `react-dom` and
 * `act`. A source-text check would pass with the component rendering a
 * different branch, and every false sentence found in this repo so far was
 * found by rendering rather than by reading.
 */

import { createElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { InstalledModel } from '@/db';
import type { ProviderConnection } from '@/ai/providers';

/* ── The database, stubbed at the table boundary ────────────────────── */

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
const { Rail } = await import('@/ui/Rail');
const { ChatScreen, startProse } = await import('@/features/chat/ChatScreen');

/* ── The models, straight from the shipped catalogue ────────────────── */

/** Speech in, nothing out — the model the reported chat is pinned to. */
const WHISPER = catalogEntry('whisper-tiny-en-onnx')!;
/** A model that really can answer. */
const QWEN = catalogEntry('qwen3-4b-instruct-q4km')!;
/** The one in the second finding: pinned, and still coming down the wire. */
const LLAMA = catalogEntry('llama-3.2-3b-instruct-q4km')!;

function installedRecord(manifest: typeof WHISPER): InstalledModel {
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

/** The same record, mid-download: a full manifest with no file behind it. */
function downloadingRecord(manifest: typeof WHISPER): InstalledModel {
  return { ...installedRecord(manifest), state: 'downloading', downloadedBytes: 10, paths: {} };
}

const PROVIDER: ProviderConnection = {
  id: 'conn_openai',
  providerId: 'openai',
  label: 'OpenAI',
  apiKey: 'sk-test',
  baseUrl: 'https://api.openai.com/v1',
  defaultModel: 'gpt-4o-mini',
  enabled: true,
  models: [],
  createdAt: 1,
};

function chatPinnedTo(modelId: string | null) {
  return {
    id: 'chat_1',
    title: 'Yesterday',
    mode: 'chat' as const,
    personaId: null,
    modelId,
    sampler: null,
    tools: [] as string[],
    showThinking: false,
    createdAt: 1,
    updatedAt: 1,
    messageCount: 0,
    preview: '',
  };
}

/**
 * Put the app in one state, including the context accounting.
 *
 * `context` is set explicitly rather than left to `refreshContext`, because the
 * whole finding is about what the rail PRINTS when that accounting exists: the
 * store derives it from `installed[modelId]?.manifest`, which is any record
 * carrying a manifest, whether or not it will ever answer a turn.
 */
function given({
  pinned,
  installed,
  connections = [],
  context = null,
}: {
  pinned: string | null;
  installed: InstalledModel[];
  connections?: ProviderConnection[];
  context?: { used: number; contextLength: number; dropped: number } | null;
}): void {
  useModels.setState({
    loaded: true,
    activeModelId: null,
    progress: {},
    storage: { used: 0, quota: 0 },
    installed: Object.fromEntries(installed.map((entry) => [entry.id, entry])),
  });
  useChats.setState({
    loaded: true,
    chats: [chatPinnedTo(pinned)],
    activeChatId: 'chat_1',
    messages: [],
    generating: false,
    context: context ? { ...context, overflowed: false, measured: false } : null,
  });
  useApp.setState({ connections, toasts: [], activity: 'idle', liveRate: null, device: null });
}

/* ── The renderer ───────────────────────────────────────────────────── */

async function mounted(
  element: ReturnType<typeof createElement>,
  body: () => Promise<void> | void,
): Promise<void> {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => {
      root.render(element);
    });
    await body();
  } finally {
    await act(async () => {
      root.unmount();
    });
    host.remove();
  }
}

/** The rail element itself — assertions must not accidentally read the screen. */
function rail(): HTMLElement {
  const header = document.querySelector('header.rail');
  expect(header, 'the rail is on screen').not.toBeNull();
  return header as HTMLElement;
}

/** Text as a reader sees it, whitespace collapsed. */
function reads(node: Element): string {
  return (node.textContent ?? '').replace(/\s+/g, ' ').trim();
}

/** Every `.readout` in the rail, in order — the instrument numbers. */
function readouts(): string[] {
  return [...rail().querySelectorAll('.readout')].map((node) => reads(node));
}

/** The class list of the rail's model chip, which is what carries the claim. */
function modelChipClass(): string {
  const chip = rail().querySelector('.chip');
  expect(chip, 'the rail names a model state').not.toBeNull();
  return (chip as HTMLElement).className;
}

beforeEach(() => {
  vi.clearAllMocks();
  useApp.setState({ toasts: [], activity: 'idle', liveRate: null, device: null });
});

/* ══ 1. The reported state: a chat pinned to Whisper ══════════════════ */

describe('the rail on a chat pinned to a model that cannot answer', () => {
  const state = {
    pinned: WHISPER.id,
    installed: [installedRecord(WHISPER)],
    context: { used: 0, contextLength: WHISPER.contextLength, dropped: 0 },
  };

  it('does not draw the flame — the mark for a local model being loaded', async () => {
    given(state);

    await mounted(createElement(Rail, { title: 'Yesterday' }), () => {
      // The measured defect: `chip chip--local`, on a chat that will never load
      // anything. `chip--local` is the ember flame used by MessageView for a
      // turn that ran on the device; it must not appear for one that cannot.
      expect(rail().querySelector('.chip--local')).toBeNull();
      expect(modelChipClass()).toContain('chip--warn');
    });
  });

  it('names the pin rather than hiding it, and claims nothing it does not do', async () => {
    given(state);

    await mounted(createElement(Rail, { title: 'Yesterday' }), () => {
      const text = reads(rail());
      // Falling back to "No local model" would hide the one fact that explains
      // the dead composer, so the model is still named.
      expect(text).toContain(WHISPER.name);
      // The engine's own words for this refusal, so the rail and the toast
      // `resolveTarget` raises do not describe the same state two ways.
      expect(text).toContain(`${WHISPER.name} cannot answer a chat`);
      expect(text).not.toContain('No local model');
      // And it makes no promise about what Whisper DOES do — the rule
      // `nonChatRole` states, which this chip is small enough to be tempted by.
      expect(text).not.toContain('speech');
      expect(text).not.toContain('Turns speech into text');
    });
  });

  it('does not print a context window for a prompt that cannot be built', async () => {
    given(state);

    await mounted(createElement(Rail, { title: 'Yesterday' }), () => {
      // The measured defect: `~0/448 ctx`, Whisper's own 448-token window,
      // reading as a live budget filling up.
      expect(readouts()).not.toContain('~0/448 ctx');
      expect(reads(rail())).not.toContain('ctx');
    });
  });

  it('contradicts nothing on the screen it sits above', async () => {
    given(state);

    // Both surfaces in ONE DOM, which is the shape of the defect: the two
    // sentences were one line apart and said opposite things.
    await mounted(createElement(ChatScreen), () => {
      const railText = reads(rail());
      const screenText = reads(document.body);

      expect(screenText).toContain('This chat cannot answer');
      expect(screenText).toContain('nothing is loaded and nothing will be sent');
      expect(railText).not.toContain('No local model');
      expect(rail().querySelector('.chip--local')).toBeNull();
      expect(reads(rail())).not.toContain('ctx');
    });
  });
});

/* ══ 2. The rail still works when there IS a target ═══════════════════ */

describe('the rail on a chat that really can answer here', () => {
  it('draws the flame, names the model, and prints the context window', async () => {
    given({
      pinned: QWEN.id,
      installed: [installedRecord(QWEN)],
      context: { used: 1200, contextLength: 8192, dropped: 0 },
    });

    await mounted(createElement(Rail, { title: 'Yesterday' }), () => {
      expect(modelChipClass()).toContain('chip--local');
      expect(reads(rail())).toContain(QWEN.name);
      // The instrument is not weakened: a real local target still reports.
      expect(readouts()).toContain('~1.2k/8.2k ctx');
    });
  });
});

/* ══ 3. A pinned model that is still downloading ══════════════════════ */

describe('the rail on a chat pinned to a model that has not finished downloading', () => {
  const state = {
    pinned: LLAMA.id,
    installed: [downloadingRecord(LLAMA)],
    // `refreshContext` reads `installed[modelId]?.manifest` — a downloading
    // record has one, so the accounting exists for a load that cannot happen.
    context: { used: 0, contextLength: LLAMA.contextLength, dropped: 0 },
  };

  it('does not call a half-downloaded record a resident model', async () => {
    given(state);

    await mounted(createElement(Rail, { title: 'Yesterday' }), () => {
      // The old resolution was `installed[modelId]`, which is truthy here.
      expect(rail().querySelector('.chip--local')).toBeNull();
      expect(reads(rail())).toContain('No local model');
      expect(reads(rail())).not.toContain('ctx');
    });
  });
});

/* ══ 4. The remote start state and the settings sheet, on one record ══ */

/** Open "This chat" from the rail and read the Model select. */
async function openChatSettings(): Promise<HTMLSelectElement> {
  const button = document.querySelector('[aria-label="Chat settings"]') as HTMLButtonElement;
  expect(button, 'the chat settings button is on screen').not.toBeNull();
  await act(async () => {
    button.click();
  });
  const select = document.querySelector('#chat-model') as HTMLSelectElement;
  expect(select, 'the Model select is on screen').not.toBeNull();
  return select;
}

describe('a chat pinned to a downloading model, with a provider enabled', () => {
  const state = {
    pinned: LLAMA.id,
    installed: [downloadingRecord(LLAMA)],
    connections: [PROVIDER],
  };

  it('does not tell the user nothing is selected while the sheet names the pin', async () => {
    given(state);

    await mounted(createElement(ChatScreen), async () => {
      const screenText = reads(document.body);

      // The privacy half is the point of the sentence and is kept whole.
      expect(screenText).toContain('This chat leaves the device.');
      expect(screenText).toContain(`turns in this chat go to ${PROVIDER.label}`);
      // The false half: `remote` does not mean "nothing is selected". It means
      // no INSTALLED record answers — which includes this pinned download.
      expect(screenText).not.toContain('No model on this device is selected');

      // The same component, two taps away, on the same record.
      const select = await openChatSettings();
      expect(select.value).toBe(LLAMA.id);
      expect(select.selectedOptions[0]?.textContent).toContain(LLAMA.name);
      expect(select.selectedOptions[0]?.textContent).toContain('not finished downloading');
      expect(useChats.getState().chats[0]?.modelId).toBe(LLAMA.id);
    });
  });

  it('says what is true of every remote case, including a chat with no pin at all', () => {
    // The replacement clause has to hold for the case the old one was written
    // for as well, or the repair just moves the false sentence.
    const body = startProse({ kind: 'remote', provider: PROVIDER })!.body;
    expect(body).toContain('No model on this device will answer it');
    expect(body).toContain(`turns in this chat go to ${PROVIDER.label}`);
    expect(body).not.toContain('is selected');
  });

  it('still leaves the device when nothing at all is pinned', async () => {
    given({ pinned: null, installed: [], connections: [PROVIDER] });

    await mounted(createElement(ChatScreen), () => {
      const screenText = reads(document.body);
      expect(screenText).toContain('This chat leaves the device.');
      expect(screenText).not.toContain('Everything here stays here');
      // And the rail agrees: there is no local model, and no flame.
      expect(rail().querySelector('.chip--local')).toBeNull();
      expect(reads(rail())).toContain('No local model');
    });
  });
});

/* ══ #7: a desktop turn waiting for the model it shares ══════════════ */

describe('the rail says when this window’s turn is waiting for the model (#7)', () => {
  it('shows the place in line while waiting, and nothing once it is not', async () => {
    // The desktop's own turns and a paired phone's share one slot, and whoever
    // waits is told, including the person here (#7, ruling 3). A silent wait
    // is indistinguishable from a hung app (#169).
    // FAULT INJECTED: deleting the `turnWaiting` chip from Rail.tsx failed the
    // first assertion.
    given({ pinned: QWEN.id, installed: [installedRecord(QWEN)] });
    useApp.setState({ turnWaiting: 2 });

    try {
      await mounted(createElement(Rail, { title: 'Yesterday' }), async () => {
        expect(reads(rail())).toContain('Waiting · #2 in line');

        await act(async () => {
          useApp.getState().setTurnWaiting(1);
        });
        expect(reads(rail())).toContain('Waiting · next in line');

        await act(async () => {
          useApp.getState().setTurnWaiting(null);
        });
        expect(reads(rail())).not.toContain('Waiting');
      });
    } finally {
      useApp.setState({ turnWaiting: null });
    }
  });
});
