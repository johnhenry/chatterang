import { type ReactNode } from 'react';
import { useShallow } from 'zustand/react/shallow';

import { Icon } from '@/ui/Icon';
import { Sheet, Slider } from '@/ui/primitives';
import { catalogEntry } from '@/data/catalog';
import { SAMPLER_RANGES, formatBytes, resolveSourceUrl } from '@/domain/manifest';
import { templateLabel } from '@/ai/prompt';
import { useApp } from '@/state/app';
import { useModels } from '@/state/models';
import { useBench } from '@/state/bench';
import { Sparkline } from '@/ui/Chart';

/**
 * Everything known about one model: what it is, what it needs, what it does
 * on this device, and the settings saved against it (PRD §3.1).
 */
export function ModelDetail({
  modelId,
  onClose,
}: {
  modelId: string | null;
  onClose: () => void;
}): ReactNode {
  const installed = useModels((state) => (modelId ? state.installed[modelId] : undefined));
  const runs = useBench(useShallow((state) => state.runs.filter((run) => run.modelId === modelId)));
  const running = useBench((state) => state.running);
  const device = useApp((state) => state.device);

  const manifest = installed?.manifest ?? (modelId ? catalogEntry(modelId) : undefined);
  if (!modelId || !manifest) return null;

  const isInstalled = installed?.state === 'installed';
  const sampler = installed?.sampler;
  const latest = runs[0];

  return (
    <Sheet
      open
      title={manifest.name}
      onClose={onClose}
      footer={
        isInstalled ? (
          <>
            <button
              type="button"
              className="btn btn--secondary grow"
              disabled={Boolean(running)}
              onClick={() => void useBench.getState().run(modelId)}
            >
              {running?.modelId === modelId ? <span className="spinner" /> : <Icon name="gauge" size={15} />}
              Benchmark
            </button>
            <button
              type="button"
              className="btn btn--primary grow"
              onClick={() => {
                void useModels.getState().setActive(modelId);
                onClose();
              }}
            >
              Use in new chats
            </button>
          </>
        ) : (
          <button
            type="button"
            className="btn btn--primary btn--block"
            onClick={() => void useModels.getState().install(manifest)}
          >
            <Icon name="download" size={15} />
            Download {formatBytes(manifest.sizeBytes)}
          </button>
        )
      }
    >
      <p style={{ color: 'var(--ink-2)', lineHeight: 'var(--lh-body)' }}>{manifest.description}</p>

      <div className="card card--flush">
        <div className="list">
          <Fact label="Engine" value={manifest.engine} />
          <Fact label="Format" value={`${manifest.format.toUpperCase()} · ${manifest.quantization}`} />
          <Fact label="Parameters" value={manifest.parameterCount ?? '—'} />
          <Fact label="Context" value={`${manifest.contextLength.toLocaleString()} tokens`} />
          <Fact
            label="Memory"
            value={`${formatBytes(manifest.minRAM, 0)} minimum · ${formatBytes(manifest.recommendedRAM, 0)} recommended`}
          />
          <Fact label="Prompt template" value={templateLabel(manifest.promptTemplate ?? 'chatml')} />
          <Fact label="Licence" value={manifest.license} />
          <Fact
            label="Source"
            value={manifest.source.repo}
            href={resolveSourceUrl(manifest.source)}
          />
          {installed?.lastBackend ? <Fact label="Ran on" value={installed.lastBackend} /> : null}
        </div>
      </div>

      {device && manifest.minRAM > device.totalMemory ? (
        <div className="card" style={{ borderLeft: '3px solid var(--crit)' }}>
          <span className="label" style={{ color: 'var(--crit)' }}>
            Too large for this device
          </span>
          <p className="section__hint">
            This model needs {formatBytes(manifest.minRAM, 0)} and the device has{' '}
            {formatBytes(device.totalMemory, 0)}. Loading it would be killed by the operating
            system.
          </p>
        </div>
      ) : null}

      {latest ? (
        <div className="section">
          <div className="section__head">
            <h2 className="grow">Measured here</h2>
            <span className="readout">{new Date(latest.createdAt).toLocaleDateString()}</span>
          </div>
          <div className="stat-grid">
            <Stat value={latest.generateTokensPerSecond.toFixed(1)} unit="tok/s" label="Generation" />
            <Stat value={latest.promptTokensPerSecond.toFixed(0)} unit="tok/s" label="Prompt" />
            <Stat
              value={(latest.peakMemoryBytes / 1024 ** 3).toFixed(1)}
              unit="GB"
              label="Peak memory"
            />
          </div>
          {latest.samples.length > 1 ? (
            <Sparkline values={latest.samples} label="Per-run throughput" unit="tok/s" />
          ) : null}
        </div>
      ) : null}

      {isInstalled && sampler ? (
        <div className="section">
          <div className="section__head">
            <h2>Saved settings</h2>
          </div>
          <p className="section__hint">
            These apply every time this model is used, unless a chat overrides them.
          </p>

          <div className="field">
            <label className="field__label" htmlFor="model-system">
              System prompt
            </label>
            <textarea
              id="model-system"
              className="textarea"
              rows={3}
              placeholder="Applied before any persona’s own prompt"
              value={installed.systemPrompt}
              onChange={(event) =>
                void useModels.getState().saveSystemPrompt(modelId, event.target.value)
              }
            />
          </div>

          {(['temperature', 'topP', 'minP', 'repeatPenalty'] as const).map((key) => {
            const range = SAMPLER_RANGES[key];
            return (
              <Slider
                key={key}
                label={range.label}
                hint={range.hint}
                value={sampler[key]}
                min={range.min}
                max={range.max}
                step={range.step}
                onChange={(value) => void useModels.getState().saveSampler(modelId, { [key]: value })}
                format={(value) => value.toFixed(2)}
              />
            );
          })}
        </div>
      ) : null}
    </Sheet>
  );
}

function Fact({
  label,
  value,
  href,
}: {
  label: string;
  value: string;
  href?: string;
}): ReactNode {
  return (
    <div className="list__item">
      <span className="label" style={{ minWidth: 108 }}>
        {label}
      </span>
      {href ? (
        <a className="grow truncate" href={href} target="_blank" rel="noreferrer noopener">
          {value}
        </a>
      ) : (
        <span className="grow truncate" style={{ fontSize: 'var(--t-sm)' }}>
          {value}
        </span>
      )}
    </div>
  );
}

export function Stat({
  value,
  unit,
  label,
}: {
  value: string;
  unit?: string;
  label: string;
}): ReactNode {
  return (
    <div className="stat">
      <span className="stat__value">
        {value}
        {unit ? <span className="stat__unit">{unit}</span> : null}
      </span>
      <span className="label">{label}</span>
    </div>
  );
}
