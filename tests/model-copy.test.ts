/**
 * The sentences the app says about a model that cannot chat.
 *
 * Written under the discipline of `tests/privacy-copy.test.ts`: every sentence
 * is asserted VERBATIM from the file that ships it, in the same breath as the
 * measurement that makes it true. Apart, the string half is a spelling test and
 * the behaviour half tests something nobody claims. Together they fail as a
 * pair — change the code and the sentence is stranded; change the sentence and
 * you are handed the measurement that says what the new one has to be.
 *
 * Two sentences are pinned here because they were both FALSE, and both were
 * introduced by the fix for `Requested backend 'onnx-runtime' is not
 * registered` rather than surviving it:
 *
 *   1. The model picker moved from `installedModels` to `chatModels` and kept
 *      an empty-state sentence written when empty meant empty. The user in the
 *      report — one Whisper model installed, nothing else — was told "Nothing
 *      is installed yet", which is the one thing they knew to be untrue.
 *
 *   2. `nonChatRole` began asserting "turns speech into text" about a model
 *      that, on the reported platform, turns speech into nothing: there is no
 *      native ONNX plugin in this app on Android or iOS. Trading a useless
 *      error for a confident false claim is not a fix.
 *
 * Three more were found the same way — each in a surface that had already been
 * corrected, each one paragraph away from the correction — and none of them was
 * visible to a source-text check. §§5-7 RENDER the screen and read the DOM,
 * because in all three cases the corrected sentence really did ship and really
 * was correct; the defect was what stood next to it:
 *
 *   3. `ModelDetail` opened with `manifest.description`, in body type, above
 *      the corrected hint. For Whisper that is "Turns speech into text on the
 *      device … the audio never leaves your phone" — the deleted claim, in
 *      larger type, one line earlier.
 *
 *   4. `Onboarding` still said "This is the smallest model available" after
 *      `recommendModel` began filtering to `canChat`, on the branch its own
 *      comment calls THE EMULATOR CASE. The fix for one false first screen left
 *      another one standing behind it.
 *
 *   5. `Onboarding`'s opening paragraph claimed "nothing is sent anywhere
 *      unless you connect a remote provider". The app's own `privacy` command
 *      — which is forbidden from making completeness claims, by
 *      `tests/privacy-copy.test.ts` — contradicts it from that exact
 *      configuration, and the request it names is the download button on the
 *      same screen. Claims about WHERE A TURN GOES are the ones this rule kept
 *      missing, and this is the first screen that makes one.
 */

import { createElement } from 'react';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { InstalledModel } from '@/db';
import type { ShellStores } from '@/shell/commands';

/* ── The database, stubbed at the table boundary ─────────────────────── */

const tables = vi.hoisted(() => ({
  chats: { put: vi.fn(async () => {}), orderBy: () => ({ reverse: () => ({ toArray: async () => [] }) }) },
  messages: {
    put: vi.fn(async () => {}),
    delete: vi.fn(async () => {}),
    where: () => ({ equals: () => ({ sortBy: async () => [] }) }),
  },
  models: { put: vi.fn(async () => {}), delete: vi.fn(async () => {}), toArray: async () => [] },
  settings: { get: vi.fn(async () => undefined), put: vi.fn(async () => {}) },
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

const { useModels, installedModels, chatModels } = await import('@/state/models');
const { useApp } = await import('@/state/app');
const { catalogEntry, CATALOG } = await import('@/data/catalog');
const { DEFAULT_SAMPLER, nonChatRole, canChat, formatBytes, isLocalEngine, resolveSourceUrl } =
  await import('@/domain/manifest');
const { nonChatInstalled, pickerEmptyCopy, startStateCopy } = await import(
  '@/features/chat/ChatScreen'
);
const { recommendModel } = await import('@/domain/onboarding');
const { chatterangCommands } = await import('@/shell/commands');

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { ModelDetail } = await import('@/features/models/ModelDetail');
const { Onboarding, fitNote } = await import('@/features/onboarding/Onboarding');

/* ── The models, straight from the shipped catalogue ─────────────────── */

/** The model in the report. */
const WHISPER = catalogEntry('whisper-tiny-en-onnx')!;
/** The other two non-chat entries, so the plural path is not hypothetical. */
const PIPER = CATALOG.find((m) => m.capabilities.includes('audio-out'))!;
const DIFFUSION = CATALOG.find((m) => m.capabilities.includes('image-out'))!;
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

/** Put exactly these models in the store, as the user's installed set. */
function installOnly(...manifests: (typeof WHISPER)[]): void {
  useModels.setState({
    loaded: true,
    activeModelId: null,
    progress: {},
    storage: { used: 0, quota: 0 },
    installed: Object.fromEntries(manifests.map((m) => [m.id, installedRecord(m)])),
  });
}

/* ── Reading the shipped words ───────────────────────────────────────── */

/** A source file, wrapping collapsed, so a sentence matches whole. */
function shipped(path: string): string {
  return readFileSync(resolve(process.cwd(), 'src', path), 'utf8')
    .replace(/^[ \t]*\*[ \t]?/gm, '')
    .replace(/\s+/g, ' ');
}

const CHAT_SCREEN = shipped('features/chat/ChatScreen.tsx');
const MODEL_DETAIL = shipped('features/models/ModelDetail.tsx');
const MANIFEST = shipped('domain/manifest.ts');

/* ── The renderer ────────────────────────────────────────────────────── */

/**
 * Mount into a throwaway host, run `body`, tear it down.
 *
 * Sections 5 and 6 read a real DOM rather than the source text, because every
 * false sentence this round has found was one a source-text check would have
 * passed: the words were present, correct, and sitting under a paragraph that
 * contradicted them.
 */
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

/** The sheet's body as a reader sees it — one line, single-spaced. */
function sheetBody(): string {
  return (document.querySelector('.sheet__body')?.textContent ?? '').replace(/\s+/g, ' ').trim();
}

beforeEach(() => {
  vi.clearAllMocks();
  useApp.setState({ toasts: [], device: null });
  installOnly(WHISPER);
});

/* ══ 1. "Nothing is installed yet", said to someone with a model ══════ */

describe('the model picker with a speech model installed', () => {
  /**
   * The measurement the headline finding is made of. Both selectors are the
   * shipped ones, driven by the shipped store.
   */
  it('has an empty chat list and a non-empty installed list — the two are not the same thing', () => {
    const state = useModels.getState();
    expect(installedModels(state).map((entry) => entry.manifest.name)).toEqual([WHISPER.name]);
    expect(chatModels(state)).toEqual([]);
    expect(nonChatInstalled(state).map((entry) => entry.manifest.name)).toEqual([WHISPER.name]);
  });

  it('does not tell them nothing is installed', () => {
    const said = pickerEmptyCopy(nonChatInstalled(useModels.getState()));

    expect(said).not.toContain('Nothing is installed yet');
    // The sentence has to say what they DO have, or it is the same
    // unactionable refusal one layer up.
    expect(said).toContain(WHISPER.name);
    expect(said).toContain('Nothing installed can answer a chat');
  });

  it('still says nothing is installed when nothing is', () => {
    installOnly();
    expect(pickerEmptyCopy(nonChatInstalled(useModels.getState()))).toBe(
      'Nothing is installed yet. Open Models to download one — the smallest is under a gigabyte.',
    );
    // And that sentence still ships, verbatim, from the screen that says it.
    expect(CHAT_SCREEN).toContain(
      'Nothing is installed yet. Open Models to download one — the smallest is under a gigabyte.',
    );
  });

  it('is the sentence the sheet actually renders — the copy is not dead code', () => {
    expect(CHAT_SCREEN).toContain('<p className="section__hint">{pickerEmptyCopy(nonChat)}</p>');
    // The old inline sentence is gone from the branch that can now be reached
    // with a model installed.
    expect(CHAT_SCREEN).not.toContain(
      'Nothing is installed yet. Open Models to download one — the smallest is under a gigabyte. </p>',
    );
  });

  it('names two models, then stops naming and counts', () => {
    installOnly(WHISPER, PIPER, DIFFUSION);
    const said = pickerEmptyCopy(nonChatInstalled(useModels.getState()));

    expect(said).toContain('and 1 more like them');
    // Two named, one counted — never a sentence that runs to the length of the
    // user's model library.
    expect([WHISPER, PIPER, DIFFUSION].filter((m) => said.includes(m.name))).toHaveLength(2);
  });

  it('offers the picker again the moment a chat model is installed', () => {
    installOnly(WHISPER, QWEN);
    expect(chatModels(useModels.getState()).map((entry) => entry.id)).toEqual([QWEN.id]);
    expect(nonChatInstalled(useModels.getState()).map((entry) => entry.id)).toEqual([WHISPER.id]);
  });
});

/* ══ 2. The start state the migration newly routes them into ══════════ */

describe('the chat start state', () => {
  /**
   * `load()` drops a persisted `activeModelId` that cannot chat, so the
   * whisper-only user lands here on the very upgrade that fixes their bug.
   */
  it('does not tell someone holding a model to download a model', () => {
    const { title, body } = startStateCopy(nonChatInstalled(useModels.getState()));

    expect(title).not.toBe('Nothing to talk to yet');
    expect(body).toContain(WHISPER.name);
    expect(body).toContain('Download a chat model in Models');
  });

  it('keeps the original words for someone who really has nothing', () => {
    installOnly();
    expect(startStateCopy(nonChatInstalled(useModels.getState()))).toEqual({
      title: 'Nothing to talk to yet',
      body: 'Download a model in Models, or connect a provider in Settings. Downloaded models run entirely on this device.',
    });
    expect(CHAT_SCREEN).toContain("title: 'Nothing to talk to yet',");
  });

  /**
   * THE PROMISE IS KEPT IN BOTH BRANCHES, IN DIFFERENT WORDS, AND THAT IS THE
   * POINT.
   *
   * This assertion used to demand the identical sentence from both, and it was
   * wrong about the second one — red for three rounds while two agents each
   * filed it as the other's. "Downloaded models run entirely on this device."
   * is a promise about a download the user has not made yet, which is exactly
   * what the empty branch is talking about. The other branch lands one
   * sentence after naming a model the user ALREADY HOLDS, and on the platform
   * the report came from that model runs nowhere — the ONNX plugin is in none
   * of the four native configs measured in §3 below. Told there, the sentence
   * says the thing they downloaded is running on their phone, in the same
   * paragraph that says it cannot chat.
   *
   * So the promise is narrowed to what it is true of rather than dropped: the
   * chat model being recommended is `llama-cpp`, whose plugin IS in all four,
   * and the sentence says so about that model and about no other.
   */
  it('promises the empty branch a download that runs here', () => {
    expect(startStateCopy([]).body).toContain('Downloaded models run entirely on this device.');
    expect(CHAT_SCREEN).toContain('Downloaded models run entirely on this device.');
  });

  it('makes no such promise about the model the other branch names', () => {
    const said = startStateCopy(nonChatInstalled(useModels.getState())).body;

    expect(said).toContain(WHISPER.name);
    // The blanket sentence, about a set that includes what they are holding.
    expect(said).not.toContain('Downloaded models run entirely on this device.');
    // Narrowed to the model it recommends, and shipped in these words.
    expect(said).toContain(
      'A chat model downloaded there runs entirely on this device; a provider does not.',
    );
    expect(CHAT_SCREEN).toContain(
      'A chat model downloaded there runs entirely on this device; a provider does not.',
    );
  });

  /**
   * What makes the narrowed half true: everything the sentence is about runs
   * on the engine this build actually registers. §3's `NATIVE_CONFIG` block
   * measures that registration; this is the other half of the claim — that the
   * set the sentence covers is exactly the set that engine runs.
   */
  it('is true of every model that sentence covers', () => {
    const chatEngines = [...new Set(CATALOG.filter(canChat).map((m) => m.engine))];
    expect(chatEngines).toEqual(['llama-cpp']);
  });
});

/* ══ 3. `nonChatRole` promises nothing this build cannot do ═══════════ */

/**
 * The build's own record of which native plugins exist.
 *
 * This is the measurement, and it is deliberately made from the files a
 * `cap sync` writes rather than from a mock: if `@chatterang/plugin-onnx-runtime`
 * ever ships, these assertions fail, and whoever made it ship is told, here,
 * that the copy below may go back to promising what the model does.
 */
const NATIVE_CONFIG = {
  'package.json': 'package.json',
  'android plugins': 'android/app/src/main/assets/capacitor.plugins.json',
  'android gradle': 'android/capacitor.settings.gradle',
  'ios package': 'ios/App/CapApp-SPM/Package.swift',
} as const;

describe('what the app says a speech model is', () => {
  it('has no native ONNX runtime on either mobile platform', () => {
    /*
     * `/android/` and `/ios/` are gitignored and generated, so on a clean
     * checkout -- CI, or a fresh clone -- three of these four files do not
     * exist and `readFileSync` threw. The assertions were sound; the file
     * list assumed a machine that had run `cap sync`.
     *
     * The native files are corroboration, not the signal. A Capacitor plugin
     * reaches `capacitor.plugins.json` by first being a dependency, so
     * `package.json` is where an ONNX runtime shows up earliest and is
     * checked unconditionally. Skipping it is not an option, and the
     * assertion below makes that structural rather than a matter of care.
     */
    const checked: string[] = [];
    for (const [label, path] of Object.entries(NATIVE_CONFIG)) {
      const full = resolve(process.cwd(), path);
      if (!existsSync(full)) {
        // Only the generated projects may be absent. package.json is tracked.
        expect(path.startsWith('android/') || path.startsWith('ios/')).toBe(true);
        continue;
      }
      const text = readFileSync(full, 'utf8');
      expect({ label, onnx: /onnx/i.test(text) }).toEqual({ label, onnx: false });
      // The control: llama-cpp IS registered in every one of these, so a
      // vacuous read of an empty or moved file cannot pass this test.
      expect({ label, llama: /llama/i.test(text) }).toEqual({ label, llama: true });
      checked.push(label);
    }
    // The control for the skip itself: a checkout with no native projects
    // still has to have read package.json, or this whole test is a no-op
    // wherever it matters most.
    expect(checked).toContain('package.json');
  });

  /**
   * What the absence above costs at runtime, measured on the real
   * `@capacitor/core` rather than described.
   *
   * Two halves, because the plugin module can only be evaluated once per
   * worker and it was evaluated as `web`:
   *
   *   1. our ONNX plugin declares a `web` implementation and nothing else
   *   2. Capacitor, driven for real with `androidBridge` set the way the
   *      Android WebView sets it, refuses exactly that shape of registration
   *
   * Together they are the sentence the emulator printed.
   */
  it('registers an ONNX implementation for web and for no other platform', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/plugins/onnx-runtime/index.ts'), 'utf8');
    expect(source).toContain("registerPlugin<OnnxRuntimePlugin>('OnnxRuntime', {");
    expect(source).toMatch(/web:\s*async\s*\(\)/);
    for (const platform of ['android:', 'ios:', 'electron:']) {
      expect({ platform, declared: source.includes(platform) }).toEqual({ platform, declared: false });
    }
  });

  it('driving the real @capacitor/core on android refuses a web-only plugin', async () => {
    const { registerPlugin } = await import('@capacitor/core');
    const previous = (globalThis as Record<string, unknown>).androidBridge;
    // Capacitor reads the platform off this; the Android WebView injects it.
    (globalThis as Record<string, unknown>).androidBridge = { postMessage: () => {} };
    try {
      // Registered under a fresh name because Capacitor refuses to register a
      // name twice, and `OnnxRuntime` was claimed when this worker started on
      // `web`. The registration SHAPE is the one asserted above.
      const probe = registerPlugin<{ transcribe: () => Promise<unknown> }>('OnnxRuntimeProbe', {
        web: async () => ({ transcribe: async () => ({ text: '' }) }),
      });
      await expect(probe.transcribe()).rejects.toThrow(
        '"OnnxRuntimeProbe" plugin is not implemented on android',
      );
    } finally {
      if (previous === undefined) delete (globalThis as Record<string, unknown>).androidBridge;
      else (globalThis as Record<string, unknown>).androidBridge = previous;
    }
  });

  it('names the kind of model rather than promising the feature', () => {
    expect(nonChatRole(WHISPER)).toBe('is a speech-to-text model');
    expect(nonChatRole(PIPER)).toBe('is a text-to-speech voice');
    expect(nonChatRole(DIFFUSION)).toBe('is an image generator');

    // The claims that the paragraph above measured to be false on Android and
    // iOS. None of them may come back while that measurement holds.
    for (const manifest of [WHISPER, PIPER, DIFFUSION]) {
      const said = nonChatRole(manifest);
      expect(said).not.toContain('turns speech into text');
      expect(said).not.toContain('reads text aloud');
      expect(said).not.toContain('makes images');
    }
  });

  it('describes no feature this app does not have', () => {
    // `embedding` is declared in the `Capability` union and nowhere else: no
    // catalogue entry has it, and there is no search to index for. The branch
    // that said "indexes text for search" described a feature that does not
    // exist, which is the same defect as the one above, one step further on.
    expect(CATALOG.filter((manifest) => manifest.capabilities.includes('embedding'))).toEqual([]);
    // The phrase survives in the comment that explains why it was deleted;
    // what must not come back is a branch that returns it.
    expect(MANIFEST).not.toContain("return 'indexes text for search'");
    expect(nonChatRole({ capabilities: ['embedding'] as const })).toBe('cannot hold a conversation');
  });

  it('reads as a sentence at every place that composes it with a name', () => {
    // The three refusals outside this surface all build `${name} ${role} — it
    // cannot answer a chat.`, so the role has to be a verb phrase. This is what
    // the user is actually shown.
    expect(`${WHISPER.name} ${nonChatRole(WHISPER)} — it cannot answer a chat.`).toBe(
      'Whisper Tiny (English) is a speech-to-text model — it cannot answer a chat.',
    );
  });

  it('is refused in those words by the store the pickers call', async () => {
    await useModels
      .getState()
      .setActive(WHISPER.id)
      .catch(() => {
        /* rejecting is a fine way to refuse; the sentence is the assertion */
      });

    const said = useApp.getState().toasts.map((toast) => toast.message).join('\n');
    expect(said).toContain(`${WHISPER.name} ${nonChatRole(WHISPER)}`);
    expect(said).not.toContain('turns speech into text');
  });
});

/* ══ 4. The model sheet's own label ═══════════════════════════════════ */

describe('the model detail sheet', () => {
  it('states only the negative where "Use in new chats" would be', () => {
    expect(MODEL_DETAIL).toContain(
      '<span className="list__sub grow" style={{ alignSelf: \'center\' }}> Not a chat model </span>',
    );
    // The affirmative half that used to sit in front of it.
    expect(MODEL_DETAIL).not.toContain('{nonChatRole(manifest)} — not a chat model');
    // And it is no longer painted as a control it is not: a `span` cannot take
    // focus and `aria-disabled` on one is inert, so a button-styled span is a
    // control to the eye and nothing at all to assistive tech. The rendered
    // footer is measured in `tests/bench-copy.test.ts`.
    expect(MODEL_DETAIL).not.toContain(
      '<span className="btn btn--secondary grow" aria-disabled="true">',
    );
  });

  it('says what the model is, and how to get to the ones that can chat', () => {
    expect(MODEL_DETAIL).toContain(
      '{manifest.name} {nonChatRole(manifest)}. It cannot answer a chat — open Models › Browse and use the Text filter to list the ones that can.',
    );

    const MODELS_SCREEN = shipped('features/models/ModelsScreen.tsx');
    // "Text" is a filter that exists, not a word invented for this sentence.
    expect(MODELS_SCREEN).toContain("{ value: 'text', label: 'Text' },");
    // And "Browse" is the step the sentence used to skip. The filter row is
    // rendered by `BrowseView` alone, while the screen opens on Installed —
    // so a sentence naming only the filter sends the reader to a screen that
    // does not have one.
    expect(MODELS_SCREEN).toContain("{ value: 'browse', label: 'Browse' },");
    expect(MODELS_SCREEN).toContain("const [view, setView] = useState<View>('installed');");
    expect(MODELS_SCREEN).toContain('function BrowseView({ onOpen }');
    // The filter row lives after `BrowseView` begins and nowhere before it.
    expect(MODELS_SCREEN.indexOf('const FILTERS')).toBeGreaterThan(
      MODELS_SCREEN.indexOf("{ value: 'installed', label: 'Installed' },"),
    );
    expect(MODELS_SCREEN.slice(0, MODELS_SCREEN.indexOf('/* ── Browse'))).not.toContain('FILTERS.map');
  });

  it('says none of it about a model that can chat', async () => {
    expect(canChat(QWEN)).toBe(true);
    installOnly(QWEN);
    await mounted(createElement(ModelDetail, { modelId: QWEN.id, onClose: () => {} }), () => {
      expect(sheetBody()).not.toContain('It cannot answer a chat');
    });
  });
});

/* ══ 5. What the sheet says FIRST ═════════════════════════════════════ */

/**
 * THE PARAGRAPH ABOVE THE CORRECTED SENTENCE.
 *
 * §4 pins the sentence the sheet says about a model that cannot chat, and it
 * was right about that sentence and blind to its position. `ModelDetail` opened
 * with `manifest.description` in body type — vendor copy — and for Whisper that
 * is "Turns speech into text on the device. Fast enough to keep up with normal
 * dictation, and the audio never leaves your phone."
 *
 * One line above "is a speech-to-text model", in larger type, is the promise
 * this whole round exists to delete: on the platform the bug was filed from
 * there is no ONNX runtime at all (measured in §3), so nothing turns speech
 * into anything and no audio goes anywhere, because none is ever read. It is
 * the same defect as `nonChatRole`'s first draft, one paragraph earlier, and a
 * source-text check for the corrected sentence passed the whole time it shipped.
 *
 * So this is read out of the rendered DOM, and the claim it forbids is taken
 * from the catalogue rather than typed out — the sentence cannot be fixed by
 * rewording the catalogue entry while leaving the sheet quoting it.
 */
describe('the paragraph the model sheet opens with', () => {
  it('is the catalogue description for a model that can chat', async () => {
    installOnly(QWEN);
    await mounted(createElement(ModelDetail, { modelId: QWEN.id, onClose: () => {} }), () => {
      expect(sheetBody()).toContain(QWEN.description);
    });
  });

  it('does not repeat the catalogue promise about a model this build cannot run', async () => {
    // The claim, as the catalogue makes it. Asserted here so a reworded
    // catalogue cannot quietly turn the assertion below into a tautology.
    expect(WHISPER.description).toContain('the audio never leaves your phone');
    expect(WHISPER.description).toContain('on the device');

    await mounted(createElement(ModelDetail, { modelId: WHISPER.id, onClose: () => {} }), () => {
      const said = sheetBody();
      expect(said).not.toContain(WHISPER.description);
      expect(said).not.toContain('the audio never leaves your phone');
      // What takes the slot instead: the derived sentence, and it is FIRST —
      // nothing gets to make the promise before it.
      expect(said.indexOf(`${WHISPER.name} ${nonChatRole(WHISPER)}`)).toBe(0);
      expect(said).toContain('open Models › Browse and use the Text filter');
    });
  });

  it('says it about all three, not only the one in the report', async () => {
    for (const manifest of [WHISPER, PIPER, DIFFUSION]) {
      installOnly(manifest);
      await mounted(createElement(ModelDetail, { modelId: manifest.id, onClose: () => {} }), () => {
        const said = sheetBody();
        expect({ id: manifest.id, quoted: said.includes(manifest.description) }).toEqual({
          id: manifest.id,
          quoted: false,
        });
        expect(said).toContain(`${manifest.name} ${nonChatRole(manifest)}`);
      });
    }
  });

  /**
   * Why the branch is `canChat` and not a platform check: `tests/layering.test.ts`
   * bans `capabilities().id` in `src/`, and the sentence has to be true on
   * every platform this ships to, not repaired on one of them.
   */
  it('does not decide what to say by asking which platform this is', () => {
    // Comments stripped, off the RAW file: this one explains the ban in prose,
    // and a bare `toContain` over the whole text fails on its own explanation.
    // `shipped()` cannot be used here — collapsing a JSDoc eats the `*` of its
    // own terminator, so there is nothing left for a comment regex to match.
    const code = readFileSync(resolve(process.cwd(), 'src/features/models/ModelDetail.tsx'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/\/\/.*$/gm, ' ');
    expect(code).toContain('canChat(manifest) ? (');
    for (const call of ['capabilities()', 'getPlatform', 'isNativePlatform']) {
      expect({ call, asked: code.includes(call) }).toEqual({ call, asked: false });
    }
  });
});

/* ══ 6. The first screen of the reported journey ══════════════════════ */

/** A device profile shaped the way `LlamaCpp.getCapabilities()` answers. */
function deviceWith(totalMemory: number, chipset = 'SM8650'): {
  totalMemory: number;
  availableMemory: number;
  backends: ['cpu'];
  preferredBackend: 'cpu';
  cpuCores: number;
  chipset: string;
  simulated: boolean;
  engineVersion: string;
} {
  return {
    totalMemory,
    availableMemory: totalMemory,
    backends: ['cpu'],
    preferredBackend: 'cpu',
    cpuCores: 8,
    chipset,
    simulated: false,
    engineVersion: 'llama.cpp b4321',
  };
}

const GB = 1024 ** 3;
const MB = 1024 ** 2;

/**
 * "This is the smallest model available", said about a model that is not.
 *
 * `recommendModel` began filtering its candidates to `canChat` — correctly:
 * the unfiltered ranking offered a 63 MB text-to-speech VOICE as the app's
 * language model on any device that had not reported its memory. Onboarding's
 * sentence was written against the unfiltered ranking and was not updated, so
 * the fix for one false first screen left another one behind it, on the same
 * branch, for the same device: `recommendModel`'s own comment calls it THE
 * EMULATOR CASE, and the report came from an emulator.
 *
 * Everything here is measured against the SHIPPED catalogue. The onboarding
 * unit tests run on a three-model fixture, which is the right shape for the
 * ranking and cannot see a sentence that is false only about the real one.
 */
describe('what onboarding says about the model it picks', () => {
  it('is not the smallest model available, on the branch an emulator takes', () => {
    const pick = recommendModel(CATALOG, undefined);
    const smallest = [...CATALOG].sort((a, b) => a.sizeBytes - b.sizeBytes)[0]!;

    expect(pick?.fit).toBe('tight');
    // The pick, and the thing the old sentence claimed it was. 379.4 MB
    // against 63.2 MB, and the smaller one is still in the catalogue.
    expect(pick?.manifest.id).toBe('qwen2.5-0.5b-instruct-q4km');
    expect(smallest.id).toBe('piper-en-us-amy-medium');
    expect(smallest.sizeBytes).toBeLessThan(pick!.manifest.sizeBytes);
    expect(canChat(smallest)).toBe(false);
  });

  it('does not say it, on the screen the user actually sees', async () => {
    // The emulator: `getCapabilities()` failed, so `device` is null.
    useApp.setState({ device: null });
    const pick = recommendModel(CATALOG, undefined)!;

    await mounted(createElement(Onboarding, { open: true, onClose: () => {} }), () => {
      const said = sheetBody();
      expect(said).toContain(`Start with ${pick.manifest.name}`);
      expect(said).not.toContain('This is the smallest model available');
      // And no promise about a device that has told us nothing.
      expect(said).not.toContain('it will run');
      expect(said).not.toContain('slow on this device');
      expect(said).toContain('This device has not reported how much memory it has');
    });
  });

  it('and the clause it says instead is true of this catalogue', async () => {
    useApp.setState({ device: null });
    const pick = recommendModel(CATALOG, undefined)!;
    const smallerThatCanChat = CATALOG.filter(
      (m) => canChat(m) && m.sizeBytes < pick.manifest.sizeBytes,
    );
    expect(smallerThatCanChat).toEqual([]);

    await mounted(createElement(Onboarding, { open: true, onClose: () => {} }), () => {
      expect(sheetBody()).toContain(
        'Nothing in the catalogue that can hold a conversation is smaller.',
      );
    });
  });

  /**
   * The second way the old sentence was false, which the emulator case hides:
   * `fit: 'tight'` is also returned for the LARGEST model whose minimum fits,
   * and on this catalogue a 1 GB device gets one with a smaller sibling below it.
   */
  it('does not call the pick the floor when something smaller can chat', () => {
    const pick = recommendModel(CATALOG, 1 * GB)!;
    expect(pick.manifest.id).toBe('smolvlm-500m-q8');
    expect(pick.fit).toBe('tight');
    expect(CATALOG.filter((m) => canChat(m) && m.sizeBytes < pick.manifest.sizeBytes)).not.toEqual(
      [],
    );

    const said = fitNote(pick, CATALOG, deviceWith(1 * GB));
    expect(said).not.toContain('is smaller');
    expect(said).toBe('It needs 1 GB and this device has 1 GB, so it will run, slowly.');
  });

  /**
   * The third way, and the one that had two screens contradicting each other:
   * nothing fits at all, `fit` is still `'tight'`, and the old sentence
   * promised "it will run" about a model `ModelDetail` says the OS will kill.
   */
  it('agrees with the model sheet about a device the model does not fit on', async () => {
    const memory = 512 * MB;
    const pick = recommendModel(CATALOG, memory)!;
    expect(pick.fit).toBe('tight');
    expect(pick.manifest.minRAM).toBeGreaterThan(memory);

    const said = fitNote(pick, CATALOG, deviceWith(memory));
    expect(said).not.toContain('it will run');
    expect(said).toContain('the operating system may kill it while it loads');

    // The other screen, rendered, about the same model on the same device.
    useApp.setState({ device: deviceWith(memory) });
    await mounted(
      createElement(ModelDetail, { modelId: pick.manifest.id, onClose: () => {} }),
      () => {
        const shown = sheetBody();
        expect(shown).toContain('Too large for this device');
        expect(shown).toContain('Loading it would be killed by the operating system');
      },
    );
  });

  it('names the chipset when the device has reported one', async () => {
    useApp.setState({ device: deviceWith(16 * GB, 'Apple A18 Pro') });
    const pick = recommendModel(CATALOG, 16 * GB)!;
    expect(pick.fit).toBe('comfortable');

    await mounted(createElement(Onboarding, { open: true, onClose: () => {} }), () => {
      const said = sheetBody();
      expect(said).toContain('Comfortable on Apple A18 Pro.');
      expect(said).not.toContain('has not reported how much memory');
    });
  });

  /**
   * The sentence that survives every branch, and what makes it true: the pick
   * is always chat-capable, every chat-capable entry runs on `llama-cpp`, and
   * that engine is local — so "works offline" is a claim about a download this
   * build really does run here. `NATIVE_CONFIG` in §3 is the other half: the
   * llama.cpp plugin is registered on all four platforms.
   */
  it('only promises offline about an engine that runs on this device', async () => {
    for (const memory of [undefined, 0, 512 * MB, 1 * GB, 4 * GB, 16 * GB]) {
      const pick = recommendModel(CATALOG, memory)!;
      expect({ memory, engine: pick.manifest.engine }).toEqual({ memory, engine: 'llama-cpp' });
      expect(isLocalEngine(pick.manifest.engine)).toBe(true);
    }

    useApp.setState({ device: null });
    await mounted(createElement(Onboarding, { open: true, onClose: () => {} }), () => {
      expect(sheetBody()).toContain('It downloads once and then works offline.');
    });
  });

  it('states the download size the button charges for', async () => {
    useApp.setState({ device: deviceWith(16 * GB) });
    const pick = recommendModel(CATALOG, 16 * GB)!;
    await mounted(createElement(Onboarding, { open: true, onClose: () => {} }), () => {
      expect(sheetBody()).toContain(`Download ${formatBytes(pick.manifest.sizeBytes, 1)}`);
    });
  });
});

/* ══ 7. Where a turn goes, said on the screen before there are any ═════ */

/**
 * THE PROMISE THE WHOLE PRIVACY STORY RESTS ON, MADE FIRST AND MEASURED LAST.
 *
 * `privacy` — the command a careful person runs — was rewritten so that it
 * makes NO completeness claim, and `tests/privacy-copy.test.ts` enforces that
 * with `not.toMatch(/nothing else/i)`, because a list of what leaves can be
 * honest and a claim that the list is complete cannot. Onboarding's opening
 * paragraph was making exactly that claim, one screen earlier, to everyone:
 *
 *   "nothing is sent anywhere unless you connect a remote provider — in which
 *    case every message that leaves is marked in the thread."
 *
 * Run the shipped command in the configuration this screen describes — first
 * run, no provider enabled, no MCP server — and it prints huggingface.co
 * anyway. The download button under that paragraph is the request.
 *
 * The measurement is the app's own command, not a fixture, for the same reason
 * §3 reads the four native config files: two surfaces that disagree about
 * where bytes go is the defect, so the assertion has to be able to see both.
 */
describe('what the welcome screen says leaves this device', () => {
  /** The smallest `ShellStores` `privacy` can run against. */
  function stores(): ShellStores {
    return {
      models: () => ({
        installed: {},
        activeModelId: null,
        install: async () => undefined,
        remove: async () => undefined,
        setActive: async () => undefined,
      }),
      catalog: () => [],
      chats: () => ({
        list: [],
        activeChatId: null,
        messagesFor: async () => [],
        open: async () => undefined,
        create: async () => 'chat_new',
      }),
      personas: () => [],
      // First run: nothing connected, nothing enabled. The exact state the
      // deleted sentence was describing.
      providers: () => ({ list: [], toggle: async () => undefined }),
      device: () => null,
      benchmarks: () => [],
      runBenchmark: async () => undefined,
    };
  }

  async function privacyOutput(): Promise<string> {
    const command = chatterangCommands(stores()).find((entry) => entry.name === 'privacy');
    const result = await command!.run([], { confirm: async () => true, actor: 'user' });
    return result.stdout.replace(/\s+/g, ' ').trim();
  }

  it('does not claim nothing leaves without a provider — the shell says otherwise', async () => {
    const said = await privacyOutput();
    // The app's own answer, with no provider and no MCP server: something
    // leaves anyway, and it is the thing this screen's button does.
    expect(said).toContain('no provider is enabled, so nothing you type is sent to one');
    expect(said).toContain('the model files you download, to huggingface.co');

    useApp.setState({ device: null });
    await mounted(createElement(Onboarding, { open: true, onClose: () => {} }), () => {
      const shown = sheetBody();
      expect(shown).not.toContain('nothing is sent anywhere unless you connect a remote provider');
      expect(shown).not.toContain('every message that leaves is marked in the thread');
      // What it says instead names the host the button below it fetches from.
      expect(shown).toContain('a model download comes from huggingface.co');
    });
  });

  it('is a claim about the button on its own screen', () => {
    // Not a general worry about the catalogue: the URL the recommended
    // download resolves to, built by the shipped resolver.
    const pick = recommendModel(CATALOG, undefined)!;
    expect(resolveSourceUrl(pick.manifest.source)).toMatch(/^https:\/\/huggingface\.co\//);
  });

  it('makes no completeness claim of its own, and points at the list', async () => {
    useApp.setState({ device: null });
    await mounted(createElement(Onboarding, { open: true, onClose: () => {} }), () => {
      const shown = sheetBody();
      // The same two shapes `tests/privacy-copy.test.ts` forbids in `privacy`.
      expect(shown).not.toMatch(/nothing else/i);
      expect(shown).not.toMatch(/nothing but/i);
      // Said outright, rather than left to be inferred from a list.
      expect(shown).toContain('Some things do leave');
      expect(shown).toContain('For the rest');
      expect(shown).toContain('privacy');
    });
  });

  it('points somewhere that exists', () => {
    const settings = shipped('features/settings/SettingsScreen.tsx');
    // `privacy` is a real command…
    expect(chatterangCommands(stores()).map((entry) => entry.name)).toContain('privacy');
    // …and Settings › Shell is where a user without a keyboard reaches it.
    expect(settings).toContain('<h2>Shell</h2>');
    expect(settings).toContain('<ShellSheet open={shell}');
  });

  /**
   * The half that was narrowed rather than deleted. "Every message that
   * leaves is marked" is a claim about everything; "every reply from one is
   * marked" is a claim about the thing `MessageView` renders a chip for, and
   * it is the scope the two other surfaces already say it in.
   *
   * NARROWED ONCE MORE, IN TIME, AND THAT IS WHAT THIS NOW PINS. The reply
   * scope was still a universal over every reply a thread can show, and a
   * generation the v4 upgrade recovers from a chat an older build saved
   * falsifies it: that build stored variants as bare strings, so the origin of
   * the text was never written down and it renders with no chip rather than
   * with a borrowed one. So the sentence says "from now on", and the clause is
   * word-for-word the one both branches of `startProse` use.
   *
   * The rendered measurement behind the clause — send, regenerate, `‹`, read
   * the chip out of the DOM — lives in `tests/selection-copy.test.ts` under
   * "the mark on a reply, measured by driving a real thread", which is also
   * where a marking sentence in any other wording is refused. This test keeps
   * doing what it always did: hold the welcome screen to it.
   */
  it('narrows the marking claim to what the thread actually marks', async () => {
    const messageView = shipped('features/chat/MessageView.tsx');
    // `provenance`, not `message.provenance`: the chip is rendered from the
    // generation on display rather than from the row, so that flipping between
    // regenerated answers cannot leave this label over someone else's words.
    expect(messageView).toContain("{ranOnDevice(provenance) ? 'On device' : 'Remote'}");
    expect(shipped('features/settings/SettingsScreen.tsx')).toContain(
      'every reply that came from one is marked in the thread',
    );

    useApp.setState({ device: null });
    await mounted(createElement(Onboarding, { open: true, onClose: () => {} }), () => {
      const shown = sheetBody();
      // Scoped to the replies this build records, and no wider.
      expect(shown).toContain(
        'From now on, every reply that comes back from a provider is marked Remote in the thread',
      );
      // The universal it replaced is gone, not merely reworded around.
      expect(shown).not.toContain('with every reply from one marked in the thread');
    });
  });

  /**
   * The same overclaim, four lines further down the same screen: "Those
   * messages leave the device, and the app says so on every one of them."
   * "Them" is what the user SENDS, and the user's own row carries no chip —
   * `provenance` is written when a reply arrives.
   */
  it('does not claim the messages you send are each marked', async () => {
    const messageView = shipped('features/chat/MessageView.tsx');
    // The chip is on the assistant article, and its label is the word the
    // sentence now uses.
    expect(messageView).toContain('<article className="msg msg--assistant">');
    expect(messageView).toContain("{ranOnDevice(provenance) ? 'On device' : 'Remote'}");
    // The user's row ends before the assistant branch begins, and the chip is
    // in the assistant branch.
    expect(messageView.indexOf('msg--assistant')).toBeLessThan(
      messageView.indexOf("'On device' : 'Remote'"),
    );

    useApp.setState({ device: null });
    await mounted(createElement(Onboarding, { open: true, onClose: () => {} }), () => {
      const shown = sheetBody();
      expect(shown).not.toContain('the app says so on every one of them');
      // Both paragraphs on this screen now say it in the SAME words as each
      // other and as both branches of `startProse`. This one used to say
      // "labelled" where the others said "marked", which is the drift that
      // produced three false sentences from two surfaces in three rounds.
      expect(shown).toContain(
        'from now on every reply that comes back from a provider is marked Remote in the thread',
      );
      expect(shown).not.toContain('labelled Remote');
    });
  });
});
