/**
 * Benchmark state (PRD §3.6).
 *
 * Runs are local by default and stay local. Publishing to the public
 * leaderboard is a separate, per-run action that requires the opt-in setting
 * to be on — a privacy-first app cannot have default-on telemetry and still
 * mean it.
 */

import { create } from 'zustand';

import { db, type BenchmarkRun } from '@/db';
import { LlamaCpp } from '@/plugins/llama-cpp';
import { newId } from '@/domain/chat';
import { useApp } from '@/state/app';
import { useModels } from '@/state/models';
import { publishRun } from '@/lib/leaderboard';

export interface BenchProgress {
  modelId: string;
  phase: 'loading' | 'warming' | 'prefill' | 'decode' | 'cooling';
  repetition: number;
  repetitions: number;
}

interface BenchState {
  runs: BenchmarkRun[];
  running: BenchProgress | null;
  publishing: string | null;

  load: () => Promise<void>;
  run: (modelId: string, repetitions?: number) => Promise<void>;
  remove: (id: string) => Promise<void>;
  publish: (id: string) => Promise<void>;
  clear: () => Promise<void>;
}

export const useBench = create<BenchState>((set, get) => ({
  runs: [],
  running: null,
  publishing: null,

  async load() {
    set({ runs: await db.benchmarks.orderBy('createdAt').reverse().toArray() });
  },

  async run(modelId, repetitions = 3) {
    if (get().running) return;

    const app = useApp.getState();
    const models = useModels.getState();
    const record = models.installed[modelId];

    if (!record || record.state !== 'installed') {
      app.toast('Install that model before benchmarking it.', 'warn');
      return;
    }

    const modelPath = record.paths.model;
    if (!modelPath) {
      app.toast('That model’s file is missing.', 'crit');
      return;
    }

    set({ running: { modelId, phase: 'loading', repetition: 0, repetitions } });
    app.setActivity('loading');

    try {
      const load = await LlamaCpp.load({
        modelPath,
        contextLength: Math.min(record.manifest.contextLength, 4096),
        backend: record.manifest.recommendedBackend,
        gpuLayers: -1,
        useMmap: true,
      });

      set({ running: { modelId, phase: 'prefill', repetition: 1, repetitions } });
      app.setActivity('running');

      const result = await LlamaCpp.benchmark({
        handle: load.handle,
        promptTokens: 512,
        generateTokens: 128,
        repetitions,
      });

      set({ running: { modelId, phase: 'cooling', repetition: repetitions, repetitions } });
      await LlamaCpp.unload({ handle: load.handle }).catch(() => undefined);

      const device = app.device;
      const run: BenchmarkRun = {
        id: newId('bench'),
        modelId,
        modelName: record.manifest.name,
        engine: record.manifest.engine,
        backend: result.backend,
        device: device?.chipset ?? 'Unknown device',
        chipset: device?.chipset ?? 'Unknown',
        promptTokensPerSecond: result.promptTokensPerSecond,
        generateTokensPerSecond: result.generateTokensPerSecond,
        peakMemoryBytes: result.peakMemoryBytes,
        thermalStart: result.thermalBefore.level,
        thermalEnd: result.thermalAfter.level,
        samples: result.samples,
        repetitions: result.repetitions,
        createdAt: Date.now(),
        uploadedAt: null,
      };

      await db.benchmarks.put(run);
      set({ runs: [run, ...get().runs] });
      app.toast(
        `${record.manifest.name}: ${result.generateTokensPerSecond.toFixed(1)} tokens/sec.`,
        'good',
      );
    } catch (error) {
      app.toast(error instanceof Error ? error.message : 'The benchmark failed.', 'crit');
    } finally {
      set({ running: null });
      app.setActivity('idle');
    }
  },

  async remove(id) {
    await db.benchmarks.delete(id);
    set({ runs: get().runs.filter((run) => run.id !== id) });
  },

  async publish(id) {
    const app = useApp.getState();
    const run = get().runs.find((entry) => entry.id === id);
    if (!run) return;

    if (!app.settings.leaderboardOptIn) {
      app.toast('Turn on leaderboard publishing in Settings first.', 'warn');
      return;
    }
    if (run.uploadedAt) {
      app.toast('That run has already been published.', 'info');
      return;
    }

    set({ publishing: id });
    try {
      await publishRun(run);
      const updated = { ...run, uploadedAt: Date.now() };
      await db.benchmarks.put(updated);
      set({ runs: get().runs.map((entry) => (entry.id === id ? updated : entry)) });
      app.toast('Published to the leaderboard.', 'good');
    } catch (error) {
      app.toast(error instanceof Error ? error.message : 'Publishing failed.', 'crit');
    } finally {
      set({ publishing: null });
    }
  },

  async clear() {
    await db.benchmarks.clear();
    set({ runs: [] });
  },
}));

/** Best decode throughput recorded per model, for the comparison chart. */
export function bestPerModel(runs: readonly BenchmarkRun[]): BenchmarkRun[] {
  const best = new Map<string, BenchmarkRun>();
  for (const run of runs) {
    const current = best.get(run.modelId);
    if (!current || run.generateTokensPerSecond > current.generateTokensPerSecond) {
      best.set(run.modelId, run);
    }
  }
  return [...best.values()].sort(
    (a, b) => b.generateTokensPerSecond - a.generateTokensPerSecond,
  );
}
