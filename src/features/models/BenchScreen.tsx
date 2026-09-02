import { useState, type ReactNode } from 'react';
import { useShallow } from 'zustand/react/shallow';

import { Icon } from '@/ui/Icon';
import { BarChart, Sparkline, ThermalArc } from '@/ui/Chart';
import { Confirm, Empty, Sheet, Switch } from '@/ui/primitives';
import { benchmarkableEngineList, formatBytes } from '@/domain/manifest';
import { buildPayload } from '@/lib/leaderboard';
import { useApp } from '@/state/app';
import { useBench, bestPerModel } from '@/state/bench';
import { useModels, benchmarkModels, installedModels } from '@/state/models';
import type { BenchmarkRun } from '@/db';

import { Stat } from '@/features/models/ModelDetail';

/**
 * Benchmarks (PRD §3.6).
 *
 * Runs are local. Publishing one is a separate act with its own consent
 * sheet that shows the exact payload — which is the only honest way to ask
 * for telemetry in an app that sells itself on privacy.
 */
export function BenchScreen(): ReactNode {
  const runs = useBench((state) => state.runs);
  const running = useBench((state) => state.running);
  const publishing = useBench((state) => state.publishing);
  /*
   * `benchmarkModels`, not `installedModels`: this picker offered every
   * installed model, so tapping Whisper handed a `.onnx` path to the llama.cpp
   * loader. A model the benchmark cannot drive is not refused here — it is
   * never offered, and `useBench.run` keeps the refusal as a backstop.
   */
  const models = useModels(useShallow(benchmarkModels));
  const anyInstalled = useModels((state) => installedModels(state).length > 0);
  const thermal = useApp((state) => state.thermal);

  const [picker, setPicker] = useState(false);
  const [consentFor, setConsentFor] = useState<BenchmarkRun | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);

  const best = bestPerModel(runs);

  return (
    <>
      <div className="card">
        <div className="row" style={{ gap: 'var(--s-4)' }}>
          <div className="list__main">
            <span className="card__title">Measure this device</span>
            <span className="list__sub">
              Prompt processing and generation throughput, peak memory, and thermal drift. Runs
              locally and stays on the device.
            </span>
          </div>
          {thermal ? <ThermalArc level={thermal.level} label="Thermal" /> : null}
        </div>

        <button
          type="button"
          className="btn btn--primary btn--block"
          disabled={Boolean(running) || models.length === 0}
          onClick={() => setPicker(true)}
        >
          {running ? (
            <>
              <span className="spinner" />
              {running.phase === 'loading'
                ? 'Loading model'
                : running.phase === 'cooling'
                  ? 'Finishing'
                  : `Measuring · ${running.repetition}/${running.repetitions}`}
            </>
          ) : (
            <>
              <Icon name="gauge" size={15} />
              Run a benchmark
            </>
          )}
        </button>

        {/*
          A disabled button with no sentence beside it is a dead end. Filtering
          the picker means it can now be empty while models ARE installed — a
          device holding only Whisper and Piper — and that is worth saying
          rather than leaving the user tapping.

          The second half used to read "speech, voice and image models run on a
          different engine", which promises those models run somewhere in this
          app. On Android and iOS they do not: there is no native ONNX plugin in
          this build. What is said instead is a fact about the benchmark —
          which engine it measures, read from `BENCHMARKABLE_ENGINES` — and
          where to check any one model, which is the Engine row of its own
          sheet, printing the same ids this sentence does.
        */}
        {models.length === 0 && anyInstalled ? (
          <span className="list__sub">
            None of the installed models can be benchmarked. The benchmark only measures{' '}
            {benchmarkableEngineList()} models — the Engine row in a model’s own sheet says which
            engine it is built for.
          </span>
        ) : null}
      </div>

      {runs.length === 0 ? (
        <Empty
          icon="gauge"
          title="Nothing measured yet"
          body="Benchmarking tells you which models are actually usable on this phone, rather than which ones fit."
        />
      ) : (
        <>
          <div className="section">
            <div className="section__head">
              <h2>Best per model</h2>
            </div>
            <div className="card">
              <BarChart
                unit="tokens per second, generation"
                caption="Fastest recorded run per model on this device"
                data={best.map((run) => ({
                  label: run.modelName,
                  value: run.generateTokensPerSecond,
                  detail: `${run.backend} · ${run.engine}`,
                  tone: 'ember',
                }))}
              />
            </div>
          </div>

          <div className="section">
            <div className="section__head">
              <h2 className="grow">All runs</h2>
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                onClick={() => setConfirmClear(true)}
              >
                Clear
              </button>
            </div>

            {runs.map((run) => (
              <div key={run.id} className="card">
                <div className="row" style={{ gap: 'var(--s-3)' }}>
                  <div className="list__main">
                    <span className="card__title">{run.modelName}</span>
                    <span className="list__sub">
                      {new Date(run.createdAt).toLocaleString()} · {run.backend} · {run.chipset}
                    </span>
                  </div>
                  {run.uploadedAt ? (
                    <span className="chip chip--good">
                      <Icon name="check" size={11} />
                      Published
                    </span>
                  ) : null}
                </div>

                <div className="stat-grid">
                  <Stat
                    value={run.generateTokensPerSecond.toFixed(1)}
                    unit="tok/s"
                    label="Generation"
                  />
                  <Stat
                    value={run.promptTokensPerSecond.toFixed(0)}
                    unit="tok/s"
                    label="Prompt"
                  />
                  <Stat value={formatBytes(run.peakMemoryBytes, 1)} label="Peak memory" />
                  <Stat
                    value={`${Math.round((run.thermalEnd - run.thermalStart) * 100)}`}
                    unit="pts"
                    label="Thermal rise"
                  />
                </div>

                {run.samples.length > 1 ? (
                  <Sparkline values={run.samples} label="Across repetitions" unit="tok/s" />
                ) : null}

                <div className="row" style={{ gap: 'var(--s-2)' }}>
                  <button
                    type="button"
                    className="btn btn--secondary btn--sm grow"
                    disabled={Boolean(run.uploadedAt) || publishing === run.id}
                    onClick={() => setConsentFor(run)}
                  >
                    {publishing === run.id ? <span className="spinner" /> : null}
                    {run.uploadedAt ? 'Published' : 'Publish to leaderboard'}
                  </button>
                  <button
                    type="button"
                    className="icon-btn"
                    aria-label="Delete run"
                    onClick={() => void useBench.getState().remove(run.id)}
                  >
                    <Icon name="trash" size={15} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      <Sheet open={picker} title="Benchmark which model?" onClose={() => setPicker(false)}>
        <div className="card card--flush">
          <div className="list">
            {models.map((model) => (
              <button
                key={model.id}
                type="button"
                className="list__item"
                data-interactive="true"
                onClick={() => {
                  setPicker(false);
                  void useBench.getState().run(model.id);
                }}
              >
                <div className="list__main">
                  <span className="list__title">{model.manifest.name}</span>
                  <span className="list__sub">
                    {model.manifest.quantization} · {formatBytes(model.downloadedBytes)}
                  </span>
                </div>
                <Icon name="chevron-right" size={16} />
              </button>
            ))}
          </div>
        </div>
        <p className="section__hint">
          The benchmark loads the model on its own, measures prompt processing and generation
          across three repetitions, then unloads it. Expect it to take a minute or two and to warm
          the device.
        </p>
      </Sheet>

      <ConsentSheet run={consentFor} onClose={() => setConsentFor(null)} />

      <Confirm
        open={confirmClear}
        title="Clear all benchmark runs?"
        body="Every recorded run is removed from this device. Anything already published to the leaderboard stays published."
        confirmLabel="Clear"
        destructive
        onCancel={() => setConfirmClear(false)}
        onConfirm={() => {
          void useBench.getState().clear();
          setConfirmClear(false);
        }}
      />
    </>
  );
}

/**
 * The consent sheet. Shows the literal JSON that would leave the device —
 * no summary, no paraphrase.
 */
function ConsentSheet({
  run,
  onClose,
}: {
  run: BenchmarkRun | null;
  onClose: () => void;
}): ReactNode {
  const settings = useApp((state) => state.settings);
  const update = useApp((state) => state.updateSettings);

  if (!run) return null;

  const payload = buildPayload(run);

  return (
    <Sheet
      open
      title="Publish this run?"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn--secondary grow" onClick={onClose}>
            Not now
          </button>
          <button
            type="button"
            className="btn btn--primary grow"
            disabled={!settings.leaderboardOptIn}
            onClick={() => {
              void useBench.getState().publish(run.id);
              onClose();
            }}
          >
            Publish
          </button>
        </>
      }
    >
      <p style={{ color: 'var(--ink-2)', fontSize: 'var(--t-sm)' }}>
        Publishing sends this run to the public leaderboard so other people can see how this
        hardware performs. It is the only thing this app uploads. Here is exactly what would be
        sent:
      </p>

      <pre
        style={{
          background: 'var(--surface-2)',
          border: '1px solid var(--line)',
          borderRadius: 'var(--r-sm)',
          padding: 'var(--s-3)',
          overflowX: 'auto',
          fontSize: 'var(--t-xs)',
          lineHeight: 1.6,
        }}
      >
        {JSON.stringify(payload, null, 2)}
      </pre>

      <p className="section__hint">
        No account, install identifier, device serial, or conversation content is included, and the
        date is truncated to the day.
      </p>

      <div className="card card--quiet">
        <div className="row" style={{ gap: 'var(--s-3)' }}>
          <div className="list__main">
            <span className="list__title">Allow leaderboard publishing</span>
            <span className="list__sub">
              Off by default. You still confirm each run individually.
            </span>
          </div>
          <Switch
            checked={settings.leaderboardOptIn}
            onChange={(checked) =>
              void update({ leaderboardOptIn: checked, telemetryConsentSeen: true })
            }
            label="Allow leaderboard publishing"
          />
        </div>
      </div>
    </Sheet>
  );
}
