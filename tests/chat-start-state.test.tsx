/**
 * WHAT A PINNED CHAT SAYS BEFORE ANYTHING IS SENT.
 *
 * The selection fix stopped the pickers offering a model that cannot chat, and
 * `resolveTarget` refuses one that is already pinned. Neither reaches the user
 * until they have typed a message and pressed send: everything ABOVE the
 * composer was computed from `model?.state === 'installed' || anyConnection`,
 * a boolean that answers "is something plugged in" and was asked "will this
 * chat answer". For the user in the report — a chat persisted against
 * `whisper-tiny-en-onnx` — that boolean is true, so the composer was live and
 * the screen promised a model was running on the device.
 *
 * Every assertion here is read out of a real DOM. A source-text check would
 * pass with the component rendering a different branch, and the defect this
 * file is about was found precisely because someone read the source instead of
 * rendering it.
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
const { ChatScreen, chatTarget, orphanOption, startProse, startStateCopy, refusalCopy } =
  await import('@/features/chat/ChatScreen');

/* ── The two models, straight from the shipped catalogue ────────────── */

/** Speech in, nothing out — and the model the reported chat is pinned to. */
const WHISPER = catalogEntry('whisper-tiny-en-onnx')!;
/** A model that really can answer. */
const QWEN = catalogEntry('qwen3-4b-instruct-q4km')!;

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

/** A real `ProviderConnection`, so the screen is driven by the shipped shape. */
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

/** A chat, pinned to whatever the case under test needs. */
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
 * Put the app in the reported state: one chat, already open, nothing in flight.
 *
 * `loaded` on both stores matters — `ChatScreen` creates a chat when either is
 * still loading, which would replace the pinned one under the test.
 */
function given({
  pinned,
  installed,
  connections = [],
}: {
  pinned: string | null;
  installed: InstalledModel[];
  connections?: ProviderConnection[];
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
    context: null,
  });
  useApp.setState({ connections, toasts: [] });
}

/* ── The renderer ───────────────────────────────────────────────────── */

/** Mount into a throwaway host, run `body`, then tear it down. */
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

/** Everything on screen, whitespace-normalised the way a reader sees it. */
function shown(): string {
  return (document.body.textContent ?? '').replace(/\s+/g, ' ').trim();
}

function composer(): HTMLTextAreaElement {
  const field = document.querySelector('.composer__input');
  expect(field, 'the composer field is on screen').not.toBeNull();
  return field as HTMLTextAreaElement;
}

beforeEach(() => {
  vi.clearAllMocks();
  useApp.setState({ toasts: [], activity: 'idle' });
});

/* ══ 1. The rule, as a value ══════════════════════════════════════════ */

describe('where this chat would send its next turn', () => {
  const installed = {
    [WHISPER.id]: installedRecord(WHISPER),
    [QWEN.id]: installedRecord(QWEN),
  };

  it('refuses a pinned model that cannot chat, rather than calling it a target', () => {
    expect(chatTarget(WHISPER.id, installed, [])).toEqual({
      kind: 'refused',
      model: installed[WHISPER.id],
    });
  });

  it('still refuses it when a provider is enabled — it must not divert the turn', () => {
    // `resolveTarget` returns `refused` BEFORE it looks at connections. A
    // screen that fell through to the provider here would arm a composer whose
    // turn leaves the device, on a chat pinned to a local model.
    expect(chatTarget(WHISPER.id, installed, [PROVIDER]).kind).toBe('refused');
  });

  it('is local when the pinned model can answer, even with a provider enabled', () => {
    expect(chatTarget(QWEN.id, installed, [PROVIDER])).toEqual({
      kind: 'local',
      model: installed[QWEN.id],
    });
  });

  it('is remote only when nothing local is selected', () => {
    expect(chatTarget(null, installed, [PROVIDER])).toEqual({ kind: 'remote', provider: PROVIDER });
    expect(chatTarget(null, installed, [{ ...PROVIDER, enabled: false }])).toEqual({ kind: 'none' });
    expect(chatTarget(null, {}, [])).toEqual({ kind: 'none' });
  });

  it('is not fooled by a model that has not finished downloading', () => {
    const half = { ...installedRecord(QWEN), state: 'downloading' as const };
    expect(chatTarget(QWEN.id, { [QWEN.id]: half }, []).kind).toBe('none');
  });
});

/* ══ 2. The privacy sentence, in a real DOM ═══════════════════════════ */

describe('the start state of a chat with a local model', () => {
  it('says the turn stays here, and names the model that will answer it', async () => {
    given({ pinned: QWEN.id, installed: [installedRecord(QWEN)] });

    await mounted(createElement(ChatScreen), () => {
      expect(shown()).toContain('Everything here stays here.');
      expect(shown()).toContain(`${QWEN.name} answers on this device.`);
      expect(composer().disabled).toBe(false);
    });
  });
});

describe('the start state of a chat that has only a provider', () => {
  it('does NOT claim everything stays here — it says the chat leaves', async () => {
    given({ pinned: null, installed: [], connections: [PROVIDER] });

    await mounted(createElement(ChatScreen), () => {
      const text = shown();
      // The defect: `hasTarget` was true purely because a connection existed,
      // and this screen then promised a model was running on the device.
      expect(text).not.toContain('Everything here stays here');
      expect(text).not.toContain('running on this device');
      expect(text).toContain('This chat leaves the device.');
      expect(text).toContain(PROVIDER.label);
      // Still usable — it is a real target, just not a local one.
      expect(composer().disabled).toBe(false);
    });
  });
});

/* ══ 3. The reported chat: pinned to Whisper ══════════════════════════ */

describe('a chat pinned to a model that cannot answer', () => {
  it('refuses before the message is typed, and names the model', async () => {
    given({ pinned: WHISPER.id, installed: [installedRecord(WHISPER)] });

    await mounted(createElement(ChatScreen), () => {
      const text = shown();
      expect(text).toContain('This chat cannot answer');
      expect(text).toContain(WHISPER.name);
      expect(text).toContain('is a speech-to-text model');
      // The two claims that were on this screen for this exact user.
      expect(text).not.toContain('Everything here stays here');
      expect(text).not.toContain('running on this device');
      // And the composer does not take a turn that will only be refused.
      expect(composer().disabled).toBe(true);
      expect(composer().placeholder).toBe('Pick a model that writes text');
    });
  });

  it('still refuses when a provider is enabled, instead of quietly going remote', async () => {
    given({
      pinned: WHISPER.id,
      installed: [installedRecord(WHISPER)],
      connections: [PROVIDER],
    });

    await mounted(createElement(ChatScreen), () => {
      expect(shown()).toContain('This chat cannot answer');
      expect(shown()).not.toContain('This chat leaves the device');
      expect(composer().disabled).toBe(true);
    });
  });
});

/* ══ 4. The settings sheet's Model select ═════════════════════════════ */

/** Open "This chat" from the rail. */
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

/** What the closed select actually displays: the text of its selected option. */
function displayed(select: HTMLSelectElement): string {
  return select.selectedOptions[0]?.textContent ?? '';
}

describe('the Model select in chat settings', () => {
  it('does not read "Choose…" for a chat that is pinned', async () => {
    given({ pinned: WHISPER.id, installed: [installedRecord(WHISPER), installedRecord(QWEN)] });

    await mounted(createElement(ChatScreen), async () => {
      const select = await openChatSettings();

      // The defect: `value` matched no option, so the browser fell to the
      // first one and the control said the chat was unpinned.
      expect(select.value).toBe(WHISPER.id);
      expect(displayed(select)).not.toBe('Choose…');
      expect(displayed(select)).toContain(WHISPER.name);
      expect(displayed(select)).toContain('is a speech-to-text model');
      // Stated, not offered: it cannot be chosen again from here.
      expect(select.selectedOptions[0]?.disabled).toBe(true);
      // And the list itself is still the narrowed one.
      const options = [...select.options].map((option) => option.textContent);
      expect(options).toContain(QWEN.name);
    });
  });

  it('leaves the record alone — opening the sheet does not rewrite the pin', async () => {
    given({ pinned: WHISPER.id, installed: [installedRecord(WHISPER)] });

    await mounted(createElement(ChatScreen), async () => {
      await openChatSettings();
      expect(useChats.getState().chats[0]?.modelId).toBe(WHISPER.id);
      expect(tables.chats.put).not.toHaveBeenCalled();
    });
  });

  it('shows "Choose…" when the chat really is unpinned', async () => {
    given({ pinned: null, installed: [installedRecord(QWEN)] });

    await mounted(createElement(ChatScreen), async () => {
      const select = await openChatSettings();
      expect(select.value).toBe('');
      expect(displayed(select)).toBe('Choose…');
    });
  });

  it('names a chat model that can be offered, with no orphan row at all', async () => {
    given({ pinned: QWEN.id, installed: [installedRecord(QWEN)] });

    await mounted(createElement(ChatScreen), async () => {
      const select = await openChatSettings();
      expect(select.value).toBe(QWEN.id);
      expect(displayed(select)).toBe(QWEN.name);
      expect(select.selectedOptions[0]?.disabled).toBe(false);
    });
  });
});

/* ══ 5. `orphanOption`, on the cases a render cannot easily stage ═════ */

describe('the option that names a pin the list has dropped', () => {
  const offered = [installedRecord(QWEN)];

  it('is absent when the value is one of the rendered options', () => {
    expect(orphanOption(QWEN.id, offered, installedRecord(QWEN), [])).toBeNull();
    expect(orphanOption(PROVIDER.id, offered, undefined, [PROVIDER])).toBeNull();
    expect(orphanOption(null, offered, undefined, [])).toBeNull();
  });

  it('says a provider is switched off rather than showing nothing', () => {
    expect(orphanOption(PROVIDER.id, offered, undefined, [{ ...PROVIDER, enabled: false }])).toEqual(
      { value: PROVIDER.id, label: 'OpenAI — switched off' },
    );
  });

  it('says a half-downloaded model has no file yet', () => {
    const half = { ...installedRecord(QWEN), state: 'downloading' as const };
    expect(orphanOption(QWEN.id, [], half, [])?.label).toBe(
      `${QWEN.name} — not finished downloading`,
    );
  });

  it('falls back to the recorded id, which is the only fact left', () => {
    expect(orphanOption('gone-9000', offered, undefined, [])).toEqual({
      value: 'gone-9000',
      label: 'gone-9000 — not on this device',
    });
  });
});

/* ══ 6. The copy, on the platform the report came from ════════════════ */

describe('what the start-state copy promises', () => {
  it('makes no claim about a model the user is holding that cannot run here', () => {
    // `@chatterang/plugin-onnx-runtime` is in none of package.json, the
    // Capacitor plugin manifest, the Gradle settings or Package.swift — so on
    // Android the Whisper this sentence sits under runs nowhere. The generic
    // "Downloaded models run entirely on this device" told that user their
    // download was running here.
    const { body } = startStateCopy([installedRecord(WHISPER)]);
    expect(body).toContain(WHISPER.name);
    expect(body).toContain('Download a chat model in Models');
    expect(body).not.toContain('Downloaded models run entirely on this device.');
    // The promise is kept where it is true: every chat-capable catalogue entry
    // is `llama-cpp`, whose plugin IS registered on all four platforms.
    expect(body).toContain('A chat model downloaded there runs entirely on this device');
  });

  it('keeps the on-device promise for someone who has downloaded nothing', () => {
    expect(startStateCopy([]).body).toContain('Downloaded models run entirely on this device.');
  });

  it('gives the two armed states two different sentences', () => {
    const local = startProse({ kind: 'local', model: installedRecord(QWEN) })!;
    const remote = startProse({ kind: 'remote', provider: PROVIDER })!;
    expect(local.heading).not.toBe(remote.heading);
    expect(remote.body).not.toContain('stays');
    expect(remote.body).toContain(PROVIDER.label);
    // And a dead end gets no prose at all — it gets the refusal.
    expect(startProse({ kind: 'none' })).toBeNull();
    expect(startProse({ kind: 'refused', model: installedRecord(WHISPER) })).toBeNull();
    expect(refusalCopy(installedRecord(WHISPER)).body).toContain(WHISPER.name);
  });
});
