/**
 * A model the benchmark cannot drive must not be handed to the benchmark.
 *
 * The same missing guard as the reported chat bug, one screen over. On the
 * chat path a speech model reached aimatey's router and came back as
 * "Requested backend 'onnx-runtime' is not registered". On the benchmark path
 * there is no router at all: `useBench.run` calls `LlamaCpp.load({ modelPath })`
 * unconditionally, so choosing Whisper handed a `.onnx` file straight to the
 * GGUF loader inside a native plugin — a worse failure, because there is not
 * even a registration table to name.
 *
 * THE PREDICATE IS DELIBERATELY NOT `canChat`. Benchmarking asks which ENGINE
 * will run the file, not what the model emits: `benchmark()` is a method on
 * the llama.cpp plugin contract and on no other (`OnnxRuntimePlugin` has no
 * such call). A vision-only model llama.cpp can load is a legitimate benchmark
 * subject; a text model on `litert-lm` is not. The two predicates are checked
 * against each other below, so reaching for the convenient one goes red.
 */

import { createElement } from 'react';
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

/**
 * The native plugin, stubbed so a call to it is *visible* rather than fatal.
 *
 * This is the whole point of the file: the assertion that matters is that
 * `load` is never reached for a model the harness cannot run. A throwing stub
 * would prove only that something failed; a recording stub proves the path
 * was not taken.
 */
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
const { useModels, installedModels, benchmarkModels } = await import('@/state/models');
const { useApp } = await import('@/state/app');
const { catalogEntry, CATALOG } = await import('@/data/catalog');
const {
  BENCHMARKABLE_ENGINES,
  DEFAULT_SAMPLER,
  canBenchmark,
  canChat,
  nonBenchmarkableReason,
} = await import('@/domain/manifest');
const { chatterangCommands } = await import('@/shell/commands');

/*
 * The two surfaces, rendered for real.
 *
 * A selector test proves `benchmarkModels` narrows; it does not prove the
 * screens call it. These mount the components, open the picker with a click,
 * and read what a user would actually see — which is the only way reverting
 * `BenchScreen` to `installedModels` goes red.
 */
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { BenchScreen } = await import('@/features/models/BenchScreen');
const { ModelDetail } = await import('@/features/models/ModelDetail');

/* ── The models, straight from the shipped catalogue ────────────────── */

/** Speech in, nothing out, and an ONNX file the GGUF loader cannot open. */
const WHISPER = catalogEntry('whisper-tiny-en-onnx')!;
/** A model llama.cpp really does run. */
const QWEN = catalogEntry('qwen3-4b-instruct-q4km')!;

/*
 * The two models that separate `canBenchmark` from `canChat`.
 *
 * The shipped catalogue cannot tell them apart — every `llama-cpp` entry also
 * has `text` and every `onnx-runtime` entry lacks it — so a check written
 * against the wrong predicate passes every test drawn from it. These two are
 * synthetic on purpose, and they are the reason this file catches the swap:
 * neither is exotic, they are just combinations the catalogue has not shipped
 * yet.
 */

/** A vision-only GGUF: llama.cpp loads it, and it cannot hold a conversation. */
const VISION_ONLY = {
  ...QWEN,
  id: 'vision-only-gguf',
  name: 'Vision Only',
  capabilities: ['vision'] as const,
  engine: 'llama-cpp' as const,
};

/** A text model on a runtime the benchmark has no harness for. */
const OTHER_RUNTIME = {
  ...QWEN,
  id: 'text-on-litert',
  name: 'Text On LiteRT',
  capabilities: ['text'] as const,
  engine: 'litert-lm' as const,
  format: 'litertlm' as const,
};

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

  useModels.setState({
    loaded: true,
    activeModelId: QWEN.id,
    progress: {},
    storage: { used: 0, quota: 0 },
    installed: {
      [WHISPER.id]: installedRecord(WHISPER),
      [QWEN.id]: installedRecord(QWEN),
      [VISION_ONLY.id]: installedRecord(VISION_ONLY),
      [OTHER_RUNTIME.id]: installedRecord(OTHER_RUNTIME),
    },
  });

  useApp.setState({ toasts: [], activity: 'idle' });
  useBench.setState({ runs: [], running: null, publishing: null });
});

/* ══ 1. The predicate: engine, not capability ═════════════════════════ */

describe('what makes a model benchmarkable', () => {
  it('is the engine — a vision-only llama.cpp model is measurable though it cannot chat', () => {
    const visionOnly = { ...QWEN, capabilities: ['vision'] as const, engine: 'llama-cpp' as const };
    expect({ chat: canChat(visionOnly), bench: canBenchmark(visionOnly) }).toEqual({
      chat: false,
      bench: true,
    });
  });

  it('is the engine — a text model on another runtime is NOT measurable though it can chat', () => {
    // The case `canChat` would wave straight through into `LlamaCpp.load`.
    const otherRuntime = { ...QWEN, capabilities: ['text'] as const, engine: 'litert-lm' as const };
    expect({ chat: canChat(otherRuntime), bench: canBenchmark(otherRuntime) }).toEqual({
      chat: true,
      bench: false,
    });
  });

  it('admits only engines the benchmark harness actually exists for', () => {
    // `benchmark()` is declared on `LlamaCppPlugin` and on no other contract.
    expect([...BENCHMARKABLE_ENGINES]).toEqual(['llama-cpp']);
  });

  it('rejects every ONNX entry in the shipped catalogue', () => {
    const onnx = CATALOG.filter((manifest) => manifest.engine === 'onnx-runtime');
    expect(onnx.length).toBeGreaterThan(0);
    for (const manifest of onnx) {
      expect({ id: manifest.id, bench: canBenchmark(manifest) }).toEqual({
        id: manifest.id,
        bench: false,
      });
    }
  });
});

/* ══ 2. The picker does not offer it ══════════════════════════════════ */

describe('the benchmark picker', () => {
  it('offers only models the harness can run', () => {
    const state = useModels.getState();
    expect(installedModels(state).map((m) => m.id).sort()).toEqual(
      [QWEN.id, WHISPER.id, VISION_ONLY.id, OTHER_RUNTIME.id].sort(),
    );
    // Sorted because `installedModels` orders by recency, and this assertion
    // is about membership, not order.
    expect(benchmarkModels(state).map((m) => m.id).sort()).toEqual(
      [QWEN.id, VISION_ONLY.id].sort(),
    );
  });
});

/* ══ 2b. The screens really call it ═══════════════════════════════════ */

/** Mount a component into a throwaway host, run `body`, then tear it down. */
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

function buttonSaying(text: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll('button')].find((button) =>
    button.textContent?.includes(text),
  );
}

describe('the Benchmarks screen', () => {
  it('does not list a model the harness cannot load, and still lists one it can', async () => {
    await mounted(createElement(BenchScreen), async () => {
      const open = buttonSaying('Run a benchmark');
      expect(open?.disabled).toBe(false);
      await act(async () => {
        open!.click();
      });

      const shown = document.body.textContent ?? '';
      expect(shown).toContain(QWEN.name);
      expect(shown).not.toContain(WHISPER.name);
      // And by engine rather than by capability, in both directions.
      expect(shown).toContain(VISION_ONLY.name);
      expect(shown).not.toContain(OTHER_RUNTIME.name);
    });
  });

  it('explains itself rather than sitting dead when nothing installed can be measured', async () => {
    useModels.setState({ installed: { [WHISPER.id]: installedRecord(WHISPER) } });

    await mounted(createElement(BenchScreen), () => {
      expect(buttonSaying('Run a benchmark')?.disabled).toBe(true);
      // A disabled control with no sentence beside it is a dead end.
      expect(document.body.textContent).toContain('can be benchmarked');
    });
  });
});

describe("a model's detail sheet", () => {
  it('offers Benchmark for a model the harness can load', async () => {
    await mounted(createElement(ModelDetail, { modelId: QWEN.id, onClose: () => {} }), () => {
      expect(buttonSaying('Benchmark')).toBeDefined();
    });
  });

  it('does not offer Benchmark for one it cannot', async () => {
    await mounted(createElement(ModelDetail, { modelId: WHISPER.id, onClose: () => {} }), () => {
      expect(buttonSaying('Benchmark')).toBeUndefined();
      // It is still a legible sheet: the engine is stated as a plain fact.
      expect(document.body.textContent).toContain(WHISPER.engine);
    });
  });
});

/* ══ 3. The backstop, for the doors a list cannot close ═══════════════ */

describe('running a benchmark on a model the harness cannot load', () => {
  it('never hands the ONNX path to the llama.cpp loader', async () => {
    await useBench.getState().run(WHISPER.id);

    expect(plugin.load).not.toHaveBeenCalled();
    expect(plugin.benchmark).not.toHaveBeenCalled();
  });

  it('says something the user can act on, in terms of the model they picked', async () => {
    await useBench.getState().run(WHISPER.id);

    const said = messagesTheUserSaw().join('\n');
    expect(said).toContain(WHISPER.name);
    // Not a stack trace out of a native plugin, and not a registration table.
    expect(said).not.toContain('is not registered');
    expect(said).not.toContain('.onnx');
    expect(said).not.toMatch(/undefined|\[object/);
    // The same rule the chat refusal keeps: `onnx-runtime` is the name of an
    // adapter registration, and the person holding the phone chose a model.
    expect(said).not.toContain('onnx-runtime');
    // And it says where to look instead, so the refusal is a next step.
    expect(said).toContain('Benchmarks');
  });

  it('leaves no spinner and no activity behind — the run never began', async () => {
    await useBench.getState().run(WHISPER.id);

    expect(useBench.getState().running).toBeNull();
    expect(useApp.getState().activity).toBe('idle');
  });

  it('records nothing', async () => {
    await useBench.getState().run(WHISPER.id);

    expect(useBench.getState().runs).toEqual([]);
    expect(tables.benchmarks.put).not.toHaveBeenCalled();
  });

  it('measures a vision-only model, which the chat predicate would have refused', async () => {
    // The test that fails if someone reaches for `canChat` here. llama.cpp can
    // load this file; that it cannot hold a conversation is not the
    // benchmark's business.
    await useBench.getState().run(VISION_ONLY.id);

    expect(plugin.load).toHaveBeenCalledTimes(1);
    expect(useBench.getState().runs.map((run) => run.modelId)).toEqual([VISION_ONLY.id]);
    expect(messagesTheUserSaw().join('\n')).not.toContain('cannot');
  });

  it('refuses a text model on a runtime with no harness, which the chat predicate would have allowed', async () => {
    // The mirror. `canChat` is true here and the file is still `.litertlm`.
    await useBench.getState().run(OTHER_RUNTIME.id);

    expect(plugin.load).not.toHaveBeenCalled();
    expect(messagesTheUserSaw().join('\n')).toContain(OTHER_RUNTIME.name);
  });

  it('still measures a model the harness can run', async () => {
    await useBench.getState().run(QWEN.id);

    expect(plugin.load).toHaveBeenCalledTimes(1);
    expect(plugin.load).toHaveBeenCalledWith(
      expect.objectContaining({ modelPath: `/dev/${QWEN.id}` }),
    );
    expect(useBench.getState().runs).toHaveLength(1);
    expect(useBench.getState().runs[0]!.modelId).toBe(QWEN.id);
    expect(useBench.getState().running).toBeNull();
  });

  it('unloads the model it loaded when the benchmark is refused, says why, and unloads once when it is not', async () => {
    // #7: on the desktop a benchmark takes the one generation slot and does not
    // wait for it, so it is refused while a turn is using the model.
    // FAULT INJECTED: removing the unload from `run`'s `finally` left the
    // refused run's handle loaded.
    const refusal = 'Another turn is using the model on this computer. Run the benchmark again when it has finished.';
    plugin.benchmark.mockRejectedValueOnce(Object.assign(new Error(refusal), { code: 'SLOT_BUSY' }));
    await useBench.getState().run(QWEN.id);
    expect(plugin.unload).toHaveBeenCalledTimes(1);
    expect(plugin.unload).toHaveBeenCalledWith({ handle: 'h1' });
    expect(messagesTheUserSaw()).toContain(refusal);
    expect(useBench.getState().runs).toEqual([]);
    expect(useBench.getState().running).toBeNull();

    vi.clearAllMocks();
    await useBench.getState().run(QWEN.id);
    expect(useBench.getState().runs).toHaveLength(1);
    expect(plugin.unload).toHaveBeenCalledTimes(1);
  });
});

/* ══ 4. The shell, which types an id instead of picking from a list ═══ */

function shellStores(): ShellStores {
  return {
    models: () => ({
      activeModelId: QWEN.id,
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

describe('`bench run` in the shell', () => {
  it('refuses a model the harness cannot load, without warming the device', async () => {
    const stores = shellStores();
    const confirm = vi.fn(async () => true);
    const bench = chatterangCommands(stores).find((command) => command.name === 'bench')!;

    const result = await bench.run(['run', WHISPER.id], { confirm, actor: 'user' });

    // Non-zero, so a script that benchmarks and carries on stops here.
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain(WHISPER.id);
    expect(stores.runBenchmark).not.toHaveBeenCalled();
    // Refused before the prompt: there is nothing worth asking about.
    expect(confirm).not.toHaveBeenCalled();
  });

  it('still runs one the harness can load', async () => {
    const stores = shellStores();
    const bench = chatterangCommands(stores).find((command) => command.name === 'bench')!;

    const result = await bench.run(['run', QWEN.id], {
      confirm: vi.fn(async () => true),
      actor: 'user',
    });

    expect(result.exitCode).toBe(0);
    expect(stores.runBenchmark).toHaveBeenCalledWith(QWEN.id);
  });

  it('judges by engine, not by whether the model can chat', async () => {
    const stores = shellStores();
    const bench = chatterangCommands(stores).find((command) => command.name === 'bench')!;
    const call = (id: string): Promise<{ exitCode: number }> =>
      bench.run(['run', id], { confirm: vi.fn(async () => true), actor: 'user' });

    // Vision-only on llama.cpp: measurable. Text on another runtime: not.
    expect((await call(VISION_ONLY.id)).exitCode).toBe(0);
    expect((await call(OTHER_RUNTIME.id)).exitCode).not.toBe(0);
    expect(stores.runBenchmark).toHaveBeenCalledTimes(1);
    expect(stores.runBenchmark).toHaveBeenCalledWith(VISION_ONLY.id);
  });

  it('keeps saying "is not installed" for an id that is not installed', async () => {
    // The new guard reads the record where the old code read only its state;
    // an unknown id must not fall through it into a wrong sentence.
    const stores = shellStores();
    const bench = chatterangCommands(stores).find((command) => command.name === 'bench')!;

    const result = await bench.run(['run', 'no-such-model'], {
      confirm: vi.fn(async () => true),
      actor: 'user',
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('is not installed');
  });
});

/* ══ 5. The sentence itself ═══════════════════════════════════════════ */

describe('the refusal wording', () => {
  it('names the engine, which is the honest reason and is printed in the model sheet', () => {
    expect(nonBenchmarkableReason(WHISPER)).toContain('onnx-runtime');
  });
});
