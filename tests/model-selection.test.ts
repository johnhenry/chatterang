/**
 * A model that cannot answer a chat turn must not become the chat model.
 *
 * THE REPORT this file reproduces. On a real Android emulator a user installed
 * "Whisper Tiny (English)" — `whisper-tiny-en-onnx`, `capabilities: ['audio-in']`
 * — made it the model for new chats, and sent a message. What came back was:
 *
 *     Could not finish
 *     Requested backend 'onnx-runtime' is not registered.
 *     Registered backends: llama-cpp
 *
 * Nothing invented an answer, which is the one good thing here and the property
 * these tests keep: the chain failed CLOSED. But it failed closed four layers
 * away from the decision, in aimatey's router, in a sentence about backend
 * registration. The person who picked a speech model cannot act on that.
 *
 * `onnx-runtime` is deliberately not registered on the chat Router: all three
 * ONNX catalog entries are speech and diffusion pipelines (`audio-in`,
 * `audio-out`, `image-out`), consumed by `lib/voice.ts` and `state/images.ts`
 * through the `OnnxRuntime` plugin. There is no ONNX chat model to serve, so
 * the fix is not a registration — it is refusing at the moment of selection,
 * where the app already knows the model has no `text` capability.
 *
 * These tests drive the real stores and the real engine. The refusal is
 * measured where a user would meet it, not asserted from a comment.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import type { ProviderConnection } from '@/ai/providers';
import type { InstalledModel } from '@/db';
import type { Persona } from '@/domain/persona';
import { REACH_REMOTE } from '@/domain/chat';
import { runsOnThisDevice, type EngineTarget } from '@/ai/engine';

/* ── The database, stubbed at the table boundary ────────────────────── */

const tables = vi.hoisted(() => ({
  chats: {
    put: vi.fn(async () => {}),
    orderBy: () => ({ reverse: () => ({ toArray: async () => [] }) }),
  },
  messages: {
    put: vi.fn(async () => {}),
    delete: vi.fn(async () => {}),
    where: () => ({ equals: () => ({ sortBy: async () => [] }) }),
  },
  models: {
    put: vi.fn(async () => {}),
    delete: vi.fn(async () => {}),
    // `vi.fn` rather than a bare arrow so `load()` can be given rows to read
    // back; the default below is the empty table every other test here wants.
    toArray: vi.fn(async (): Promise<unknown[]> => []),
  },
  settings: { get: vi.fn(async (): Promise<unknown> => undefined), put: vi.fn(async () => {}) },
  personas: {
    put: vi.fn(async () => {}),
    delete: vi.fn(async () => {}),
    toArray: async () => [],
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

/*
 * The transfer itself, stubbed — there is no network here, and none of these
 * tests are about one. `install()` is exercised for what it decides AFTER a
 * download succeeds; the real `downloadModel` rejects under jsdom and would
 * send every one of those cases down the failure path instead.
 */
vi.mock('@/lib/download', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/download')>()),
  downloadModel: vi.fn(async ({ manifest }: { manifest: { id: string; sizeBytes: number } }) => ({
    paths: { model: `/dev/${manifest.id}` },
    totalBytes: manifest.sizeBytes,
  })),
  deleteModelFiles: vi.fn(async () => {}),
  storageEstimate: vi.fn(async (used: number) => ({ used, quota: 0 })),
}));

const { useChats } = await import('@/state/chat');
const { useModels } = await import('@/state/models');
const { useApp } = await import('@/state/app');
const { ChatterangEngine } = await import('@/ai/engine');
const { catalogEntry } = await import('@/data/catalog');
const { DEFAULT_SAMPLER, nonChatRole } = await import('@/domain/manifest');
const { chatModels, installedModels } = await import('@/state/models');
const { usePersonas } = await import('@/state/personas');

/*
 * The persona editor, rendered.
 *
 * Section 4 pins the WIRING from the source text, which is what catches a
 * revert to `installedModels`. It cannot catch the bug in section 7: the
 * wiring was correct and the control still displayed the wrong thing, because
 * a `<select>` reconciles its value against the options it was given. Only a
 * renderer sees that, so this file has one.
 */
const { createElement } = await import('react');
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { PersonaEditor } = await import('@/features/personas/PersonaEditor');

/* ── The two models, straight from the shipped catalogue ────────────── */

/** The model in the report. Speech in, nothing out. */
const WHISPER = catalogEntry('whisper-tiny-en-onnx')!;
/** A model that can actually hold a conversation. */
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

/** Everything the user can read after an action, in the order it appeared. */
function messagesTheUserSaw(): string[] {
  return useApp.getState().toasts.map((toast) => toast.message);
}

beforeEach(() => {
  vi.clearAllMocks();

  // `clearAllMocks` clears calls, not implementations, so the defaults are
  // restored by hand: an empty `models` table and no persisted setting.
  tables.models.toArray.mockResolvedValue([]);
  tables.settings.get.mockResolvedValue(undefined);

  useModels.setState({
    loaded: true,
    activeModelId: null,
    progress: {},
    storage: { used: 0, quota: 0 },
    installed: {
      [WHISPER.id]: installedRecord(WHISPER),
      [QWEN.id]: installedRecord(QWEN),
    },
  });

  useApp.setState({
    toasts: [],
    connections: [],
    // The engine the app really builds: `llama-cpp` registered in the
    // constructor, `chrome-ai` absent under jsdom, and no `onnx-runtime`.
    engine: new ChatterangEngine({
      resolver: {
        getManifest: (id: string) => useModels.getState().installed[id]?.manifest ?? null,
        getPath: () => '/dev/model.gguf',
        getSampler: () => ({ ...DEFAULT_SAMPLER, maxTokens: 64 }),
      },
      fallbackBackendId: null,
    }),
  });

  useChats.setState({
    loaded: true,
    generating: false,
    controller: null,
    context: null,
    messages: [],
    activeChatId: 'c1',
    chats: [
      {
        id: 'c1',
        title: 'New chat',
        mode: 'chat',
        personaId: null,
        modelId: null,
        sampler: null,
        tools: [],
        showThinking: false,
        createdAt: 1,
        updatedAt: 1,
        messageCount: 0,
        preview: '',
      },
    ],
  });
});

/* ══ 1. The engine really is the shape the report describes ═══════════ */

describe('the engine the app builds', () => {
  it('does not register onnx-runtime, and should not — there is no ONNX chat model', () => {
    const engine = useApp.getState().engine!;
    expect(engine.listBackends()).toEqual(['llama-cpp']);
    expect(engine.hasBackend('onnx-runtime')).toBe(false);
  });

  it('has no catalog model that is both onnx-runtime and able to produce text', async () => {
    const { CATALOG } = await import('@/data/catalog');
    const onnx = CATALOG.filter((manifest) => manifest.engine === 'onnx-runtime');
    expect(onnx.length).toBeGreaterThan(0);
    for (const manifest of onnx) {
      expect({ id: manifest.id, text: manifest.capabilities.includes('text') }).toEqual({
        id: manifest.id,
        text: false,
      });
    }
  });
});

/* ══ 2. Selection: the refusal belongs HERE ═══════════════════════════ */

describe('choosing a model for chats', () => {
  it('refuses a speech model, and says something the user can act on', async () => {
    // The one call every selection door funnels into: the Models sheet's
    // "Use in new chats", the chat model picker, and `model use` in the shell.
    await useModels
      .getState()
      .setActive(WHISPER.id)
      .catch(() => {
        /* Rejecting is a fine way to refuse; the assertions below are the rule. */
      });

    expect(useModels.getState().activeModelId).not.toBe(WHISPER.id);

    // A refusal the user cannot read is not a refusal. It has to name the
    // model they picked and what it does instead of chat.
    const said = messagesTheUserSaw().join('\n');
    expect(said).toContain(WHISPER.name);
    expect(said).not.toContain('onnx-runtime');
  });

  it('still accepts a model that can hold a conversation', async () => {
    await useModels.getState().setActive(QWEN.id);
    expect(useModels.getState().activeModelId).toBe(QWEN.id);
    expect(messagesTheUserSaw()).toEqual([]);
  });
});

/* ══ 3. The user's turn, end to end ═══════════════════════════════════ */

describe('sending a turn while a speech model is the chat model', () => {
  /**
   * The state a user can arrive in whatever `setActive` learns to refuse:
   * `activeModelId` is persisted, so a value written by an older build is read
   * straight back by `useModels.load()`. A per-chat `modelId` and a persona's
   * `preferredModelId` reach `resolveTarget` the same way.
   */
  beforeEach(() => {
    useModels.setState({ activeModelId: WHISPER.id });
  });

  it('does not hand the turn to a backend that cannot generate text', async () => {
    await useChats.getState().send('hello');

    const assistant = useChats.getState().messages.find((message) => message.role === 'assistant');
    const shown = `${assistant?.error ?? ''}\n${messagesTheUserSaw().join('\n')}`;

    // This is the exact sentence the user was shown. It is aimatey's, about
    // the router's registration table, and it is unusable.
    expect(shown).not.toContain('is not registered');
    expect(shown).not.toContain('onnx-runtime');
    expect(shown).not.toContain('Registered backends');
  });

  it('refuses in terms of the model the user picked', async () => {
    await useChats.getState().send('hello');

    const assistant = useChats.getState().messages.find((message) => message.role === 'assistant');
    const shown = `${assistant?.error ?? ''}\n${messagesTheUserSaw().join('\n')}`;

    expect(shown).toContain(WHISPER.name);
  });

  it('does not count the refused turn as a use of the speech model', async () => {
    await useChats.getState().send('hello');
    expect(useModels.getState().installed[WHISPER.id]?.useCount).toBe(0);
  });
});

/* ══ 4. Construction: the half the runtime checks are a backstop FOR ═══ */

/**
 * WHY THESE ARE SOURCE ASSERTIONS.
 *
 * The refusals above are all runtime checks, and a mutation test found the
 * asymmetry they hide: revert `chatModels` and its call sites — five files,
 * the whole "real fix" — and the suite stayed green, because the runtime
 * checks still refuse. The app would go straight back to listing "Whisper Tiny
 * (English)" in the chat model picker, the per-chat Model dropdown and a
 * persona's Preferred model; the reported error would not come back, but the
 * property the fix is named for would be protected by nothing, and the next
 * chat surface written against `installedModels` out of habit reintroduces it
 * silently.
 *
 * There is no React renderer in this repo and none is being added for this.
 * The precedent for pinning a wiring decision from the source text is already
 * here — tests/keys.test.ts:491 ("registers each command from the component
 * that can perform it"), tests/layout.test.ts:551, tests/privacy-copy.test.ts.
 * Each assertion below was fault-injected: the mutation it exists to catch was
 * applied to an isolated copy of the tree and watched go red.
 */

const src = (relative: string): string =>
  readFileSync(resolve(process.cwd(), 'src', relative), 'utf8');

/**
 * One component's source, from its declaration to the next one.
 *
 * Both chat pickers live in `ChatScreen.tsx`, so a file-wide `toContain`
 * would pass with one of them still reading the unfiltered list.
 */
function componentBody(source: string, name: string): string {
  const start = source.indexOf(`\nfunction ${name}(`);
  expect(start, `${name} is declared in this file`).toBeGreaterThan(-1);
  const next = source.indexOf('\nfunction ', start + 1);
  return source.slice(start, next === -1 ? undefined : next);
}

describe('the list the pickers are built from', () => {
  it('narrows what is installed to what can answer', () => {
    const state = useModels.getState();
    // Both models are installed; only one belongs in a chat picker.
    expect(installedModels(state).map((entry) => entry.id)).toEqual([WHISPER.id, QWEN.id]);
    expect(chatModels(state).map((entry) => entry.id)).toEqual([QWEN.id]);
  });

  it('offers nothing at all to the user in the report', () => {
    useModels.setState({ installed: { [WHISPER.id]: installedRecord(WHISPER) } });
    const state = useModels.getState();
    // Holding a model and being offered none is the whole shape of that bug.
    expect(installedModels(state)).toHaveLength(1);
    expect(chatModels(state)).toEqual([]);
  });

  it('does not offer a chat model that has not finished downloading', () => {
    useModels.setState({
      installed: {
        [QWEN.id]: { ...installedRecord(QWEN), state: 'downloading', downloadedBytes: 10 },
      },
    });
    // `chatModels` must keep the install-state filter it inherits, not just
    // the capability one; a half-downloaded GGUF has no file behind it.
    expect(chatModels(useModels.getState())).toEqual([]);
  });

  it('is a subset of what is installed, never something else', () => {
    const state = useModels.getState();
    const installed = new Set(installedModels(state).map((entry) => entry.id));
    for (const entry of chatModels(state)) expect(installed.has(entry.id)).toBe(true);
  });
});

describe('the surfaces that offer a model for a chat', () => {
  it('maps chatModels in both of the chat screen’s pickers, and installedModels in neither', () => {
    const chatScreen = src('features/chat/ChatScreen.tsx');

    // `ChatSettingsSheet` is the per-chat Model dropdown; `ModelPickerSheet`
    // is "Choose a model". Both offered every installed model before the fix.
    for (const component of ['ChatSettingsSheet', 'ModelPickerSheet']) {
      const body = componentBody(chatScreen, component);
      expect(body, `${component} reads the filtered list`).toContain('useShallow(chatModels)');
      expect(body, `${component} does not read every installed model`).not.toContain(
        'useShallow(installedModels)',
      );
      expect(body, `${component} renders the list it read`).toContain('models.map(');
    }
  });

  /**
   * The assertions above name three components, and the escape the mutation
   * test described is a FOURTH: "a new chat surface written against
   * `installedModels` out of habit". A per-file allowlist cannot see a file
   * that does not exist yet, so this one is a rule over the directories where
   * a chat surface would be born.
   *
   * It is deliberately about the SUBSCRIPTION, not the import. `ChatScreen`
   * legitimately imports `installedModels` — `nonChatInstalled` delegates to
   * it to work out what the user has that cannot chat — so banning the import
   * would ban the copy fix. What must not happen under these directories is
   * `useShallow(installedModels)`: reading every installed model as the list a
   * user picks from.
   */
  it('has no chat or persona surface subscribed to every installed model', () => {
    const roots = ['features/chat', 'features/personas'];
    const offenders: string[] = [];

    for (const root of roots) {
      const dir = resolve(process.cwd(), 'src', root);
      for (const file of readdirSync(dir)) {
        if (!file.endsWith('.tsx') && !file.endsWith('.ts')) continue;
        const text = readFileSync(resolve(dir, file), 'utf8');
        if (text.includes('useShallow(installedModels)')) offenders.push(`${root}/${file}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it('builds a persona’s preferred model from chatModels', () => {
    const editor = src('features/personas/PersonaEditor.tsx');
    expect(editor).toContain('useShallow(chatModels)');
    // The select maps `modelsForRequires` (#23, #122: further narrowed by
    // `persona.requires`), itself derived from `models` — the `chatModels`
    // subscription above — never the unfiltered table.
    expect(editor).toContain('modelsForRequires.map(');
    expect(editor).toMatch(/modelsForRequires\s*=[\s\S]{0,200}\bmodels\b/);
    // A persona's model is a chat model by definition — nothing else runs a turn.
    expect(editor).not.toContain('installedModels');
  });

  it('keeps “Use in new chats” inside the canChat branch of the model sheet', () => {
    const detail = src('features/models/ModelDetail.tsx');

    // The opening of the ternary itself, not merely a mention of `canChat`:
    // an inverted guard (`{!canChat(manifest) ? (`) contains the substring and
    // would have slipped through — measured, fault G. Whitespace-tolerant, and
    // `? (` excludes the unrelated `{canChat(manifest) ? null : (` further down
    // that guards the explanatory sentence in the sheet body.
    const guard = detail.search(/\{\s*canChat\(manifest\)\s*\?\s*\(/);
    const affirmative = detail.indexOf('Use in new chats');
    const setActive = detail.indexOf('setActive(modelId)');
    const refused = detail.indexOf('Not a chat model');

    // -1 is a passing comparison against every later index, so the guard's
    // presence is asserted before anything is ordered against it.
    expect(guard, 'the affirmative arm is the canChat arm, not its negation').toBeGreaterThan(-1);
    expect(affirmative, 'the affirmative label exists').toBeGreaterThan(-1);
    expect(refused, 'the disabled label exists').toBeGreaterThan(-1);

    // Guard, then the arm that selects, then the arm that refuses — the
    // affirmative control and its `setActive` call are what the guard covers.
    expect(affirmative).toBeGreaterThan(guard);
    expect(setActive).toBeGreaterThan(guard);
    expect(setActive).toBeLessThan(refused);
    expect(refused).toBeGreaterThan(affirmative);
  });
});

/* ══ 5. The value an older build already wrote to IndexedDB ═══════════ */

/**
 * The only guard covering the user who is already broken.
 *
 * `activeModelId` is persisted. Every construction and refusal above is in
 * front of a NEW selection; a phone that made Whisper the chat model before
 * this rule existed has the id sitting in the settings table, and `load()`
 * reads it straight back into service without passing `setActive`.
 */
describe('an active model persisted by an older build', () => {
  it('drops a speech model rather than carrying a broken chat across the upgrade', async () => {
    tables.models.toArray.mockResolvedValue([installedRecord(WHISPER), installedRecord(QWEN)]);
    tables.settings.get.mockResolvedValue({ key: 'activeModelId', value: WHISPER.id });

    await useModels.getState().load();

    expect(useModels.getState().activeModelId).toBeNull();
  });

  it('restores a model that can chat, which is what this read is for', async () => {
    tables.models.toArray.mockResolvedValue([installedRecord(WHISPER), installedRecord(QWEN)]);
    tables.settings.get.mockResolvedValue({ key: 'activeModelId', value: QWEN.id });

    await useModels.getState().load();

    expect(useModels.getState().activeModelId).toBe(QWEN.id);
  });

  it('leaves an id it cannot recognise alone — that is an uninstalled model, not a bad one', async () => {
    tables.models.toArray.mockResolvedValue([installedRecord(QWEN)]);
    tables.settings.get.mockResolvedValue({ key: 'activeModelId', value: 'not-installed-yet' });

    await useModels.getState().load();

    expect(useModels.getState().activeModelId).toBe('not-installed-yet');
  });

  /**
   * The decision has to reach the DATABASE, not just the store.
   *
   * Dropping the id in memory alone leaves IndexedDB holding a value the app
   * has already ruled invalid: the read is re-done and re-nulled on every
   * boot, and the row outlives the reasoning that rejected it.
   */
  it('writes the rejection back, rather than re-deriving it on every boot', async () => {
    tables.models.toArray.mockResolvedValue([installedRecord(WHISPER), installedRecord(QWEN)]);
    tables.settings.get.mockResolvedValue({ key: 'activeModelId', value: WHISPER.id });

    await useModels.getState().load();

    expect(tables.settings.put).toHaveBeenCalledWith({ key: 'activeModelId', value: null });
  });

  it('does not write on an ordinary boot that changed nothing', async () => {
    tables.models.toArray.mockResolvedValue([installedRecord(QWEN)]);
    tables.settings.get.mockResolvedValue({ key: 'activeModelId', value: QWEN.id });

    await useModels.getState().load();

    expect(tables.settings.put).not.toHaveBeenCalled();
  });

  /**
   * THE GAP THE "leave an unknown id alone" RULE OPENS.
   *
   * That rule is right — an unrecognised id is a model awaiting re-install,
   * not a bad one. But the id is unrecognised precisely BECAUSE the model was
   * absent, so the capability check never ran on it. Re-install the model and
   * the manifest finally exists, with the stale id still active; `install()`'s
   * "first model becomes active" branch does not fire, because there already
   * is one.
   */
  it('re-checks the id it deferred on, once the model is installed again', async () => {
    // The state `load()` legitimately leaves behind: Whisper active, absent.
    tables.models.toArray.mockResolvedValue([]);
    tables.settings.get.mockResolvedValue({ key: 'activeModelId', value: WHISPER.id });
    await useModels.getState().load();
    expect(useModels.getState().activeModelId).toBe(WHISPER.id);

    await useModels.getState().install(WHISPER);

    expect(useModels.getState().activeModelId).toBeNull();
    expect(tables.settings.put).toHaveBeenCalledWith({ key: 'activeModelId', value: null });
  });

  it('leaves the active model alone when the re-installed one can chat', async () => {
    tables.models.toArray.mockResolvedValue([]);
    tables.settings.get.mockResolvedValue({ key: 'activeModelId', value: QWEN.id });
    await useModels.getState().load();

    await useModels.getState().install(QWEN);

    expect(useModels.getState().activeModelId).toBe(QWEN.id);
  });
});

/* ══ 7. The persona editor tells the truth about its own record ═══════ */

/**
 * THE SECOND WAY THIS BUG REACHES A USER, AND THE ONE A SELECTOR TEST MISSES.
 *
 * `chatModels` is the right list to choose from, and wiring the editor to it
 * is what section 4 pins. But `preferredModelId` is a value that ALREADY
 * EXISTS on the record, and an HTML `<select>` whose value matches none of its
 * options silently selects the first one. Measured on a persona holding
 * `whisper-tiny-en-onnx`, after the picker was narrowed and before this was
 * fixed:
 *
 *     select.value "" · selectedIndex 0 · displayed "Whatever is active"
 *     while the persisted record still said "whisper-tiny-en-onnx"
 *
 * The editor stated the opposite of the record, on the screen someone opens to
 * find out why their chats refuse — and `save(draft)` writes the draft
 * wholesale, so editing any other field re-persisted the hidden id. Every
 * assertion below reads the real DOM; none of them can be satisfied by the
 * source text.
 */

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

function personaPreferring(preferredModelId: string | undefined): Persona {
  return {
    id: 'p1',
    kind: 'assistant',
    name: 'Helper',
    tagline: '',
    avatarSeed: 'seed',
    description: '',
    tags: [],
    showThinking: false,
    tools: [],
    preferredModelId,
    createdAt: 1,
    updatedAt: 1,
    version: 1,
  };
}

/** The Sheet portals out of the mount host, so this queries the document. */
function modelSelect(): HTMLSelectElement {
  const select = document.querySelector('#persona-model');
  expect(select, 'the preferred-model control is on screen').not.toBeNull();
  return select as HTMLSelectElement;
}

/** What the control actually shows the user, not what it was handed. */
function displayedLabel(select: HTMLSelectElement): string {
  return select.options[select.selectedIndex]?.textContent ?? '';
}

describe('a persona’s preferred model, as rendered', () => {
  it('shows what the record says, not the first option, for a model that cannot chat', async () => {
    const persona = personaPreferring(WHISPER.id);

    await mounted(createElement(PersonaEditor, { persona, onClose: () => {} }), () => {
      const select = modelSelect();

      // The control agrees with the record. This is the whole bug: it did not.
      expect(select.value).toBe(WHISPER.id);
      expect(displayedLabel(select)).toContain(WHISPER.name);
      expect(
        displayedLabel(select),
        'and never claims the persona has no preference',
      ).not.toContain('Whatever is active');
    });
  });

  it('says WHY that model is not in the list, in the option itself', async () => {
    const persona = personaPreferring(WHISPER.id);

    await mounted(createElement(PersonaEditor, { persona, onClose: () => {} }), () => {
      // Naming the model is the easy half; the user needs to know what kind of
      // thing they picked, which is the sentence every other refusal uses.
      expect(displayedLabel(modelSelect())).toContain(nonChatRole(WHISPER));
    });
  });

  it('still does not OFFER the speech model as a choosable option', async () => {
    const persona = personaPreferring(WHISPER.id);

    await mounted(createElement(PersonaEditor, { persona, onClose: () => {} }), () => {
      const select = modelSelect();
      // Exactly one entry for it — the one describing the stranded record —
      // and it is the selected one, not a second way to pick it fresh.
      const whisperOptions = [...select.options].filter((option) => option.value === WHISPER.id);
      expect(whisperOptions).toHaveLength(1);
      expect(whisperOptions[0]!.textContent).not.toBe(WHISPER.name);
      expect(select.selectedIndex).toBe(select.options.length - 1);
    });
  });

  it('distinguishes “cannot chat” from “not installed” — they are different facts', async () => {
    // A perfectly good chat model that simply is not on the device. `load()`
    // makes exactly this distinction for `activeModelId`; the editor must not
    // collapse it into the speech-model sentence.
    const notInstalled = catalogEntry('llama-3.2-3b-instruct-q4km')!;
    const persona = personaPreferring(notInstalled.id);

    await mounted(createElement(PersonaEditor, { persona, onClose: () => {} }), () => {
      const select = modelSelect();
      expect(select.value).toBe(notInstalled.id);
      const label = displayedLabel(select);
      expect(label).toContain(notInstalled.name);
      expect(label).toContain('not installed');
      expect(label, 'it is not a speech model and must not be called one').not.toContain(
        'speech-to-text',
      );
    });
  });

  it('falls back to the bare id for a model outside the catalogue', async () => {
    const persona = personaPreferring('some-hf-model-not-in-catalogue');

    await mounted(createElement(PersonaEditor, { persona, onClose: () => {} }), () => {
      const select = modelSelect();
      expect(select.value).toBe('some-hf-model-not-in-catalogue');
      expect(displayedLabel(select)).toContain('some-hf-model-not-in-catalogue');
    });
  });

  it('leaves the ordinary cases exactly as they were', async () => {
    await mounted(
      createElement(PersonaEditor, { persona: personaPreferring(QWEN.id), onClose: () => {} }),
      () => {
        const select = modelSelect();
        expect(select.value).toBe(QWEN.id);
        // A model that can chat gets its plain name, with nothing appended.
        expect(displayedLabel(select)).toBe(QWEN.name);
        // And exactly one entry: a model already in the list must not also be
        // described as stranded. The duplicate would sit BELOW the real
        // option, so `value` and the displayed label both still look right —
        // measured, which is why the count is asserted rather than the label.
        const values = [...select.options].map((option) => option.value);
        expect(values).toEqual(['', QWEN.id]);
      },
    );

    await mounted(
      createElement(PersonaEditor, { persona: personaPreferring(undefined), onClose: () => {} }),
      () => {
        const select = modelSelect();
        expect(select.value).toBe('');
        // And "no preference" still reads as no preference — the fix must not
        // manufacture a stranded option out of an absent one.
        expect(displayedLabel(select)).toBe('Whatever is active');
        expect(select.options).toHaveLength(2);
      },
    );
  });

  it('does not hand back the model it just refused', async () => {
    // The sheet someone opens to find out why their chats refuse must not be
    // the place they can re-pick the cause. The chat sheet's orphan option is
    // `disabled` for exactly this; measured before this assertion existed,
    // this one was not, so one click re-created the reported bug from the
    // control that had just explained it.
    for (const stranded of [WHISPER.id, 'llama-3.2-3b-instruct-q4km']) {
      await mounted(
        createElement(PersonaEditor, { persona: personaPreferring(stranded), onClose: () => {} }),
        () => {
          const select = modelSelect();
          const option = [...select.options].find((entry) => entry.value === stranded)!;
          // Displayed but not choosable — the two are different properties of
          // an option, and this control needs the first without the second.
          expect(option.disabled, `${stranded} is not offered back`).toBe(true);
          expect(select.value, `${stranded} is still what the record says`).toBe(stranded);
          expect(displayedLabel(select)).toBe(option.textContent);
          // Every option a user CAN pick is one the chat path will accept.
          const choosable = [...select.options].filter((entry) => !entry.disabled);
          expect(choosable.map((entry) => entry.value)).toEqual(['', QWEN.id]);
        },
      );
    }
  });

  it('composes the role as a clause, the way every other refusal does', async () => {
    // `nonChatRole` returns a predicate — "is a speech-to-text model" — so an
    // em dash in front of it produces "Whisper Tiny (English) — is a
    // speech-to-text model" against the "X is a speech-to-text model" that
    // `orphanOption` and the chat refusal both compose. Pinned because the
    // drift is invisible to every assertion that only checks `toContain`.
    await mounted(
      createElement(PersonaEditor, { persona: personaPreferring(WHISPER.id), onClose: () => {} }),
      () => {
        expect(displayedLabel(modelSelect())).toBe(`${WHISPER.name} ${nonChatRole(WHISPER)}`);
      },
    );

    // The dash stays where the tail is a noun phrase rather than a verb.
    const notInstalled = catalogEntry('llama-3.2-3b-instruct-q4km')!;
    await mounted(
      createElement(PersonaEditor, {
        persona: personaPreferring(notInstalled.id),
        onClose: () => {},
      }),
      () => {
        expect(displayedLabel(modelSelect())).toBe(`${notInstalled.name} — not installed`);
      },
    );
  });
});

/* ══ 8. The hint under that picker, judged against a dispatched turn ══ */

/**
 * THE ASSERTION THAT KEEPS BEING WRITTEN THE WRONG WAY ROUND.
 *
 * Two sentences have stood under this control, and both were false:
 *
 *   "If the model is not installed, the active one is used instead."
 *       — `newChat` copies `preferredModelId` into `chat.modelId`, and
 *         `resolveTarget` reads `chat.modelId ?? activeModelId`, so the
 *         active model is never consulted.
 *   "it leaves the new chat with nothing to send to"
 *       — `resolveTarget` misses the id in `models.installed`, falls out of
 *         the whole `if (modelId)` block, and lands on
 *         `app.connections.find(entry => entry.enabled)`. The turn is sent.
 *
 * The test written to prevent the second one PASSED it: it asserted
 * `hint.length > 0` and `not.toContain('the active one is used instead')` —
 * the absence of the previous sentence, which any replacement satisfies. So
 * this section does not read the hint first. It sends a turn through the real
 * stores, the real `newChat` and the real `resolveTarget` with a recording
 * engine, records the target that engine was handed, and only then asks
 * whether the sentence on screen describes it.
 */

/** A real `ProviderConnection`, so the fall-through is driven by the shipped shape. */
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

interface Dispatch {
  /** The target the engine was handed, or null when nothing was sent. */
  readonly target: Record<string, unknown> | null;
  readonly assistantTurns: number;
  readonly toasts: readonly string[];
  readonly chatModelId: string | null;
}

/**
 * Start a chat from a persona with this preference and send one message.
 *
 * The engine is a recorder rather than the shipped one: what is under test is
 * the TARGET the chat path chose, which is an argument to `stream`, and the
 * real engine would try to open a GGUF that is not there.
 */
async function dispatchPreferring(
  preferredModelId: string,
  connections: readonly ProviderConnection[],
): Promise<Dispatch> {
  let seen: Record<string, unknown> | null = null;

  useApp.setState({
    toasts: [],
    connections: [...connections],
    engine: {
      async *stream({ target }: { target: Record<string, unknown> }) {
        seen = { ...target };
        yield {
          type: 'done',
          text: 'ok',
          provenance: target,
          stats: { promptTokens: 0, completionTokens: 0 },
        };
      },
    } as never,
  });

  useModels.setState({ activeModelId: QWEN.id });
  usePersonas.setState({
    byId: { p1: personaPreferring(preferredModelId) },
    order: ['p1'],
  } as never);

  await useChats.getState().newChat({ personaId: 'p1' });
  await useChats.getState().send('hello');

  return {
    target: seen,
    assistantTurns: useChats.getState().messages.filter((entry) => entry.role === 'assistant')
      .length,
    toasts: messagesTheUserSaw(),
    chatModelId: useChats.getState().chats[0]?.modelId ?? null,
  };
}

/** The sentence under the picker, as rendered for this preference. */
async function hintFor(preference: string | undefined): Promise<string> {
  let text = '';
  await mounted(
    createElement(PersonaEditor, { persona: personaPreferring(preference), onClose: () => {} }),
    () => {
      text = modelSelect().parentElement?.querySelector('.field__hint')?.textContent ?? '';
    },
  );
  expect(text.length, `there is a hint for ${String(preference)}`).toBeGreaterThan(0);
  return text;
}

describe('what the hint promises about an uninstalled preference', () => {
  /** A real chat model, simply not on this device. */
  const NOT_INSTALLED = catalogEntry('llama-3.2-3b-instruct-q4km')!;

  it('the turn goes to the first enabled provider, and the hint says so', async () => {
    const sent = await dispatchPreferring(NOT_INSTALLED.id, [PROVIDER]);

    // ── Measured first; the sentence is judged against this. ──────────
    expect(sent.chatModelId, 'the preference is what the new chat carries').toBe(NOT_INSTALLED.id);
    expect(sent.chatModelId).not.toBe(useModels.getState().activeModelId);
    // It was SENT. Both guards — "none" and "refused" — were passed.
    expect(sent.assistantTurns, 'a turn was dispatched').toBe(1);
    expect(sent.target).toEqual({
      backendId: PROVIDER.id,
      engine: 'remote',
      modelId: PROVIDER.defaultModel,
      modelName: `${PROVIDER.label} · ${PROVIDER.defaultModel}`,
      reach: REACH_REMOTE,
    });
    // And the destination is a connection the user configured, not a model.
    const backendId = sent.target!.backendId as string;
    expect(useApp.getState().connections.some((entry) => entry.id === backendId)).toBe(true);
    expect(
      runsOnThisDevice(sent.target! as unknown as EngineTarget),
      'nothing about this ran on the device',
    ).toBe(false);

    // ── Now the sentence. ─────────────────────────────────────────────
    for (const preference of [undefined, QWEN.id]) {
      const hint = await hintFor(preference);
      const why = `the ordinary hint (preference ${String(preference)})`;

      // Round 3's sentence, and the one that matters: a turn measurably left
      // for a provider, so the hint may not tell the user nothing is sent.
      // Checked FIRST, because it is the privacy-critical direction.
      expect(hint, `${why} must not deny the dispatch above`).not.toMatch(
        /nothing to send to|nowhere to send|does not send/i,
      );

      // It has to name the route the measurement actually took.
      expect(hint, `${why} names where the turn goes`).toMatch(/provider/i);

      // Round 2's sentence: the active model is never consulted. Only the
      // AFFIRMATIVE claim is forbidden — the true sentence denies it, and
      // English does the discriminating: an affirmative takes "falls back",
      // a negation takes "does not fall back".
      expect(hint, why).not.toContain('the active one is used instead');
      expect(hint, why).not.toMatch(/falls back to the active|uses the active/i);
    }
  });

  it('and nothing is sent when no provider is enabled — which the hint also says', async () => {
    const sent = await dispatchPreferring(NOT_INSTALLED.id, [{ ...PROVIDER, enabled: false }]);

    expect(sent.target, 'the engine was never called').toBeNull();
    expect(sent.assistantTurns).toBe(0);
    expect(sent.toasts.join('\n')).toContain('Choose a model first');

    // The hint's second clause is this case and only this case.
    for (const preference of [undefined, QWEN.id]) {
      expect(await hintFor(preference), 'the refusal half of the sentence').toMatch(
        /refused|nowhere|no provider/i,
      );
    }
  });

  it('the stranded hint claims only what the chat record backs', async () => {
    const sent = await dispatchPreferring(NOT_INSTALLED.id, [PROVIDER]);
    const hint = await hintFor(NOT_INSTALLED.id);

    // "every new chat it starts inherits it" — measured, not assumed.
    expect(sent.chatModelId).toBe(NOT_INSTALLED.id);
    expect(hint).toContain('every new chat it starts');
    // And it makes no destination claim the dispatch above contradicts.
    expect(hint).not.toContain('the active one is used instead');
    expect(hint).not.toMatch(/nothing to send to|nowhere to send/i);
  });
});

/* ══ 6. The half of the refusal that is worth reading ═════════════════ */

/**
 * Every assertion above this one checks the model's NAME. That is the easy
 * half: naming the model was never in doubt. The fix's own argument is that
 * "Requested backend 'onnx-runtime' is not registered" fails because it is
 * UNACTIONABLE — so the sentence has to say what kind of thing the user picked
 * and what to do instead, and until now that half could be deleted with a
 * green suite.
 */
describe('what the refusal tells the user to do', () => {
  beforeEach(() => {
    useModels.setState({ activeModelId: WHISPER.id });
  });

  it('names the kind of model, and a next step, not just the model', async () => {
    await useChats.getState().send('hello');

    const assistant = useChats.getState().messages.find((message) => message.role === 'assistant');
    const shown = `${assistant?.error ?? ''}\n${messagesTheUserSaw().join('\n')}`;

    const role = nonChatRole(WHISPER);
    expect(role.length, 'nonChatRole says something').toBeGreaterThan(0);

    expect(shown).toContain(WHISPER.name);
    expect(shown, 'the composed sentence carries the role, not only the name').toContain(role);
    expect(shown, 'and tells them what to pick instead').toMatch(
      /(choose|pick) a model that writes text/i,
    );
  });
});
