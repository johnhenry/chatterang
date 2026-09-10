/**
 * What the app SAYS about a model it will not benchmark, and where it sends
 * the person who hears it.
 *
 * `nonChatRole` states the rule this file exists to enforce, in capitals, in
 * its own doc comment: NAME THE KIND, DO NOT PROMISE THE FEATURE. There is no
 * native ONNX runtime in this build on Android or iOS, so a sentence claiming
 * a speech model *does* something — or *runs* somewhere — is false on the
 * platform the original report came from. The rule was written down and then
 * enforced by nothing but a `not.toContain('onnx-runtime')` string check, and
 * the benchmark work walked straight through it with three sentences:
 *
 *   - the toast:            "it runs on a different engine"
 *   - the BenchScreen hint: "…models run on a different engine"
 *   - `nonBenchmarkableReason`: "runs on onnx-runtime, which has no benchmark
 *                               harness"
 *
 * All three say the model runs, on an engine this app has, and that only the
 * stopwatch is missing. On an Android phone none of that is true.
 *
 * So the rule is a test now, not a comment. Every sentence below is collected
 * from the surface that ships it — the real store's toast, the rendered DOM,
 * the real shell's stderr — pinned verbatim, and then checked against the
 * measurement that says what it may not claim.
 */

import { createElement } from 'react';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { InstalledModel } from '@/db';
import type { ShellStores } from '@/shell/commands';

/* ── The database, stubbed at the table boundary ────────────────────── */

const tables = vi.hoisted(() => ({
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

/** Recording, not throwing: reaching the loader must be visible, not fatal. */
const plugin = vi.hoisted(() => ({
  load: vi.fn(async (_options: { modelPath: string }) => ({ handle: 'h1', backend: 'cpu' })),
  benchmark: vi.fn(async () => ({
    backend: 'cpu' as const,
    promptTokensPerSecond: 210.5,
    generateTokensPerSecond: 24.25,
    peakMemoryBytes: 3_000_000_000,
    thermalBefore: { level: 0.2 },
    thermalAfter: { level: 0.4 },
    samples: [24.1, 24.3, 24.35],
    repetitions: 3,
  })),
  unload: vi.fn(async () => {}),
}));

vi.mock('@/plugins/llama-cpp', () => ({ LlamaCpp: plugin }));

const { useBench } = await import('@/state/bench');
const { useModels } = await import('@/state/models');
const { useApp } = await import('@/state/app');
const { catalogEntry } = await import('@/data/catalog');
const { BENCHMARKABLE_ENGINES, DEFAULT_SAMPLER, benchmarkableEngineList, nonBenchmarkableReason } =
  await import('@/domain/manifest');
const { chatterangCommands } = await import('@/shell/commands');
const { focusableWithin } = await import('@/ui/primitives');

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { BenchScreen } = await import('@/features/models/BenchScreen');
const { ModelDetail } = await import('@/features/models/ModelDetail');

/* ── The models, straight from the shipped catalogue ────────────────── */

/** The model in the report: ONNX, speech in, and no chat. */
const WHISPER = catalogEntry('whisper-tiny-en-onnx')!;
/** A model llama.cpp really does run. */
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

function installOnly(...manifests: (typeof WHISPER)[]): void {
  useModels.setState({
    loaded: true,
    activeModelId: null,
    progress: {},
    storage: { used: 0, quota: 0 },
    installed: Object.fromEntries(manifests.map((m) => [m.id, installedRecord(m)])),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  useApp.setState({ toasts: [], activity: 'idle' });
  useBench.setState({ runs: [], running: null, publishing: null });
  // The device in the report: one speech model, nothing else.
  installOnly(WHISPER);
});

/* ── Mounting, for the sentences that only exist once rendered ──────── */

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

/** The one element that carries a sentence, rather than the whole screen. */
function elementSaying(selector: string, fragment: string): Element | undefined {
  return [...document.querySelectorAll(selector)].find((node) =>
    node.textContent?.includes(fragment),
  );
}

/* ══ 1. The measurement: there is no ONNX runtime to run on ═══════════ */

/**
 * The build's own record of which native plugins exist, read from the files a
 * `cap sync` writes. If `@chatterang/plugin-onnx-runtime` ever ships, this
 * fails first, and whoever shipped it is told here that the copy below is free
 * to start promising again.
 */
const NATIVE_CONFIG = {
  'package.json': 'package.json',
  'android plugins': 'android/app/src/main/assets/capacitor.plugins.json',
  'android gradle': 'android/capacitor.settings.gradle',
  'ios package': 'ios/App/CapApp-SPM/Package.swift',
} as const;

describe('the platform fact the benchmark copy has to respect', () => {
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
});

/* ══ 2. The rule, applied to every sentence that ships ════════════════ */

/**
 * What a sentence about a model this build cannot benchmark may NOT claim.
 *
 * Each entry is a phrase that asserts the model RUNS. The first two are the
 * exact words that shipped. They are checked against the sentences themselves
 * — not against a source file — so a sentence assembled at runtime out of
 * three template literals is covered the same as one typed in JSX.
 */
const CLAIMS_THE_MODEL_RUNS: readonly RegExp[] = [
  /\bruns? on\b/i,
  /\bdifferent engine\b/i,
  /\bwill run\b/i,
  /\bruns (locally|on this device|on your phone)\b/i,
];

/** Every sentence the app says to someone who picked Whisper to benchmark. */
async function sentencesAboutRefusingWhisper(): Promise<Record<string, string>> {
  const said: Record<string, string> = {
    reason: nonBenchmarkableReason(WHISPER),
  };

  await useBench.getState().run(WHISPER.id);
  said.toast = useApp.getState().toasts.map((toast) => toast.message).join(' ');

  await mounted(createElement(BenchScreen), () => {
    said.hint = elementSaying('span.list__sub', 'can be benchmarked')?.textContent ?? '';
  });

  const bench = chatterangCommands(shellStores()).find((command) => command.name === 'bench')!;
  const result = await bench.run(['run', WHISPER.id], {
    confirm: vi.fn(async () => true),
    actor: 'user',
  });
  said.stderr = result.stderr ?? '';

  return said;
}

describe('what the app says about a model it will not benchmark', () => {
  it('says all four of these sentences, and no other surface is silent', async () => {
    const said = await sentencesAboutRefusingWhisper();

    // Verbatim, from the surfaces that ship them. Change one and this test
    // hands you the measurement below that says what the new one may claim.
    expect(said).toEqual({
      reason:
        'is built for onnx-runtime, and the benchmark only measures llama-cpp models',
      toast:
        'Whisper Tiny (English) cannot be benchmarked — the benchmark only measures llama-cpp models. The Benchmarks screen lists the ones this device can measure.',
      hint: 'None of the installed models can be benchmarked. The benchmark only measures llama-cpp models — the Engine row in a model’s own sheet says which engine it is built for.',
      stderr:
        '"whisper-tiny-en-onnx" is built for onnx-runtime, and the benchmark only measures llama-cpp models — it cannot be benchmarked. Try: model list — the ENGINE column.',
    });
  });

  it('claims in none of them that the model runs anywhere', async () => {
    const said = await sentencesAboutRefusingWhisper();

    for (const [surface, sentence] of Object.entries(said)) {
      for (const banned of CLAIMS_THE_MODEL_RUNS) {
        expect({ surface, claims: banned.test(sentence) }).toEqual({ surface, claims: false });
      }
    }
  });

  it('states instead a fact about the benchmark, which holds on every platform', async () => {
    const said = await sentencesAboutRefusingWhisper();
    const list = benchmarkableEngineList();

    expect(list).toBe('llama-cpp');
    expect([...BENCHMARKABLE_ENGINES]).toEqual(['llama-cpp']);
    // Every sentence names what the benchmark measures rather than what the
    // model does, and derives it from the list rather than spelling it out.
    for (const [surface, sentence] of Object.entries(said)) {
      expect({ surface, names: sentence.includes(`only measures ${list} models`) }).toEqual({
        surface,
        names: true,
      });
    }
  });

  it('keeps the picked model’s own engine out of the two the user did not ask for', async () => {
    const said = await sentencesAboutRefusingWhisper();

    // `onnx-runtime` is the name of an adapter registration. The shell names it
    // — there the reader greps engine ids — and the touch surfaces do not.
    expect(said.toast).not.toContain(WHISPER.engine);
    expect(said.hint).not.toContain(WHISPER.engine);
    expect(said.reason).toContain(WHISPER.engine);
    expect(said.stderr).toContain(WHISPER.engine);
  });

  it('says none of it about a model the harness really can run', async () => {
    installOnly(QWEN);
    await useBench.getState().run(QWEN.id);

    const toasts = useApp.getState().toasts.map((toast) => toast.message).join(' ');
    expect(plugin.load).toHaveBeenCalledTimes(1);
    expect(toasts).not.toContain('cannot be benchmarked');
    expect(toasts).not.toContain('only measures');
  });
});

/* ══ 3. The next step the refusals point at ═══════════════════════════ */

function shellStores(): ShellStores {
  return {
    models: () => ({
      activeModelId: useModels.getState().activeModelId,
      install: vi.fn(async () => undefined),
      remove: vi.fn(async () => undefined),
      setActive: vi.fn(async () => undefined),
      installed: Object.fromEntries(
        Object.values(useModels.getState().installed).map((record) => [
          record.id,
          {
            id: record.id,
            state: record.state,
            downloadedBytes: record.downloadedBytes,
            useCount: record.useCount,
            manifest: {
              name: record.manifest.name,
              quantization: record.manifest.quantization,
              capabilities: record.manifest.capabilities,
              contextLength: record.manifest.contextLength,
              sizeBytes: record.manifest.sizeBytes,
              engine: record.manifest.engine,
              license: record.manifest.license,
            },
          },
        ]),
      ),
    }),
    catalog: () => [],
    chats: () => ({
      activeChatId: null,
      list: [],
      messagesFor: async () => [],
      open: async () => undefined,
      create: async () => 'c1',
    }),
    personas: () => [],
    providers: () => ({ list: [], toggle: async () => undefined }),
    device: () => null,
    benchmarks: () => [],
    runBenchmark: vi.fn(async () => undefined),
  };
}

/** Run one shell command against the models currently installed. */
async function shell(name: string, args: readonly string[]): Promise<string> {
  const command = chatterangCommands(shellStores()).find((entry) => entry.name === name)!;
  const result = await command.run(args, { confirm: vi.fn(async () => true), actor: 'user' });
  return result.exitCode === 0 ? result.stdout : (result.stderr ?? '');
}

describe('`model list`, which both refusals send the user to', () => {
  /**
   * The defect this closes: the refusals said "Try: model list", and that
   * command printed ID, NAME, SIZE, CTX and USES. A whisper-only user ran it,
   * saw their one row, and learned neither why it was refused nor what would
   * have qualified — a true sentence with an unactionable next step, which is
   * the original bug in politer words.
   */
  it('answers the question `model use` refuses on: which of these can chat', async () => {
    installOnly(WHISPER, QWEN);

    const refusal = await shell('model', ['use', WHISPER.id]);
    expect(refusal).toContain('model list');

    const listing = await shell('model', ['list']);
    const header = listing.split('\n')[0]!;
    const whisperRow = listing.split('\n').find((row) => row.startsWith(WHISPER.id))!;
    const qwenRow = listing.split('\n').find((row) => row.startsWith(QWEN.id))!;

    expect(header).toContain('CHAT');
    // The column the refusal names, answering it in both directions.
    expect(whisperRow.trimEnd().endsWith('no')).toBe(true);
    expect(qwenRow).toMatch(/\byes\b/);
  });

  it('answers the question `bench run` refuses on: which engine each is built for', async () => {
    installOnly(WHISPER, QWEN);

    const refusal = await shell('bench', ['run', WHISPER.id]);
    expect(refusal).toContain('model list — the ENGINE column.');

    const listing = await shell('model', ['list']);
    expect(listing.split('\n')[0]).toContain('ENGINE');
    // The same ids the refusal and the model sheet print, so the sentence and
    // the table are made of one fact.
    expect(listing.split('\n').find((row) => row.startsWith(WHISPER.id))).toContain('onnx-runtime');
    expect(listing.split('\n').find((row) => row.startsWith(QWEN.id))).toContain(
      benchmarkableEngineList(),
    );
  });

  it('still prints what it always printed, and still marks the active model', async () => {
    installOnly(WHISPER, QWEN);
    useModels.setState({ activeModelId: QWEN.id });

    const listing = await shell('model', ['list']);
    expect(listing).toContain(QWEN.name);
    expect(listing).toContain('← active');
    expect(listing.split('\n')[0]).toContain('USES');
    expect(listing.split('\n')[0]).toContain('CTX');
  });
});

/* ══ 4. The footer of the sheet for the reported user's only model ════ */

describe('the model sheet for an installed model that cannot chat', () => {
  /**
   * It was a single `<span className="btn btn--secondary grow"
   * aria-disabled="true">Not a chat model</span>` — the whole footer. A span
   * cannot take focus and `aria-disabled` on a non-interactive element does
   * nothing, so what looked like a disabled control was, to assistive tech, a
   * run of text. For the user in the report, whose only model is Whisper, that
   * was every control the footer had.
   */
  it('has a real control in its footer, not a button-shaped span', async () => {
    await mounted(createElement(ModelDetail, { modelId: WHISPER.id, onClose: () => {} }), () => {
      const foot = document.querySelector('.sheet__foot')!;
      expect(foot).toBeTruthy();

      // `focusableWithin` is the shipped definition of "Tab can land here" —
      // the same one the sheet uses to place initial focus.
      const reachable = focusableWithin(foot);
      expect(reachable.map((node) => node.tagName)).toEqual(['BUTTON']);
      expect(reachable[0]!.textContent).toBe('Done');

      // Nothing in the footer is painted as a control it is not.
      expect(foot.querySelector('.btn[aria-disabled="true"]')).toBeNull();
      expect(foot.querySelector('span.btn')).toBeNull();
      // The reason still reads, in text type rather than button type.
      expect(foot.textContent).toContain('Not a chat model');
    });
  });

  it('the control does what it says', async () => {
    const onClose = vi.fn();
    await mounted(createElement(ModelDetail, { modelId: WHISPER.id, onClose }), async () => {
      const done = focusableWithin(document.querySelector('.sheet__foot')!)[0]!;
      await act(async () => {
        done.click();
      });
      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });

  it('names both steps to the models that can chat, not just the filter', async () => {
    await mounted(createElement(ModelDetail, { modelId: WHISPER.id, onClose: () => {} }), () => {
      const said = document.querySelector('.sheet__body')?.textContent ?? '';
      // `FILTERS` is rendered by `BrowseView`; the screen opens on Installed.
      // A sentence naming only the filter sends the reader somewhere it is not.
      expect(said).toContain('open Models › Browse and use the Text filter');
    });
  });

  it('still offers the real action for a model that can chat', async () => {
    installOnly(QWEN);
    await mounted(createElement(ModelDetail, { modelId: QWEN.id, onClose: () => {} }), () => {
      const foot = document.querySelector('.sheet__foot')!;
      expect(foot.textContent).toContain('Use in new chats');
      expect(foot.textContent).not.toContain('Not a chat model');
      expect(focusableWithin(foot).length).toBeGreaterThan(0);
    });
  });
});
