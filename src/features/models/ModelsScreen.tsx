import { useMemo, useState, type ReactNode } from 'react';
import { useShallow } from 'zustand/react/shallow';

import { Icon } from '@/ui/Icon';
import { Rail } from '@/ui/Rail';
import { Confirm, Empty, Meter, Segmented, Sheet } from '@/ui/primitives';
import { CATALOG } from '@/data/catalog';
import { formatBytes, type Capability, type ModelManifest } from '@/domain/manifest';
import { useApp } from '@/state/app';
import { useModels, installedModels } from '@/state/models';
import type { InstalledModel } from '@/db';

import { BenchScreen } from '@/features/models/BenchScreen';
import { HuggingFaceBrowser } from '@/features/models/HuggingFaceBrowser';
import { ModelDetail } from '@/features/models/ModelDetail';

type View = 'installed' | 'browse' | 'bench';

export function ModelsScreen(): ReactNode {
  const [view, setView] = useState<View>('installed');
  const [detail, setDetail] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<InstalledModel | null>(null);

  return (
    <>
      <Rail title="Models" />
      <main className="app__body">
        <div className="screen__scroll">
          <div className="screen__pad">
            <Segmented
              label="Model view"
              value={view}
              onChange={setView}
              options={[
                { value: 'installed', label: 'Installed' },
                { value: 'browse', label: 'Browse' },
                { value: 'bench', label: 'Benchmarks' },
              ]}
            />

            {view === 'installed' ? (
              <InstalledView onOpen={setDetail} onRemove={setConfirmRemove} />
            ) : null}
            {view === 'browse' ? <BrowseView onOpen={setDetail} /> : null}
            {view === 'bench' ? <BenchScreen /> : null}
          </div>
        </div>
      </main>

      <ModelDetail modelId={detail} onClose={() => setDetail(null)} />

      <Confirm
        open={confirmRemove !== null}
        title={`Remove ${confirmRemove?.manifest.name ?? 'this model'}?`}
        body={`This frees ${formatBytes(confirmRemove?.downloadedBytes ?? 0)} of storage. You can download it again at any time.`}
        confirmLabel="Remove"
        destructive
        onCancel={() => setConfirmRemove(null)}
        onConfirm={() => {
          if (confirmRemove) void useModels.getState().remove(confirmRemove.id);
          setConfirmRemove(null);
        }}
      />
    </>
  );
}

/* ── Installed ──────────────────────────────────────────────────────── */

function InstalledView({
  onOpen,
  onRemove,
}: {
  onOpen: (modelId: string) => void;
  onRemove: (model: InstalledModel) => void;
}): ReactNode {
  const models = useModels(useShallow(installedModels));
  const progress = useModels((state) => state.progress);
  const allRecords = useModels((state) => state.installed);
  const activeModelId = useModels((state) => state.activeModelId);
  const storage = useModels((state) => state.storage);
  const device = useApp((state) => state.device);

  const downloading = Object.values(allRecords).filter(
    (record) => record.state === 'downloading' || record.state === 'failed',
  );

  const usedByModels = models.reduce((sum, model) => sum + model.downloadedBytes, 0);

  return (
    <>
      {downloading.length > 0 ? (
        <div className="section">
          <div className="section__head">
            <h2>Downloading</h2>
          </div>
          {downloading.map((record) => {
            const current = progress[record.id];
            return (
              <div key={record.id} className="card card--local">
                <div className="row" style={{ gap: 'var(--s-3)' }}>
                  <div className="list__main">
                    <span className="list__title">{record.manifest.name}</span>
                    <span className="list__sub">
                      {record.state === 'failed'
                        ? (record.error ?? 'Download failed.')
                        : current
                          ? `${formatBytes(current.receivedBytes)} of ${formatBytes(current.totalBytes)}${
                              current.etaSeconds !== null
                                ? ` · ${formatDuration(current.etaSeconds)} left`
                                : ''
                            }`
                          : 'Starting…'}
                    </span>
                  </div>
                  {record.state === 'failed' ? (
                    <button
                      type="button"
                      className="btn btn--secondary btn--sm"
                      onClick={() => void useModels.getState().install(record.manifest)}
                    >
                      Retry
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="btn btn--ghost btn--sm"
                      onClick={() => useModels.getState().cancelInstall(record.id)}
                    >
                      Cancel
                    </button>
                  )}
                </div>
                {record.state === 'downloading' ? (
                  <Meter
                    label={current ? `${(current.bytesPerSecond / 1024 / 1024).toFixed(1)} MB/s` : 'Connecting'}
                    value={current?.receivedBytes ?? 0}
                    max={current?.totalBytes || record.manifest.sizeBytes}
                  />
                ) : null}
              </div>
            );
          })}
        </div>
      ) : null}

      {models.length === 0 ? (
        <Empty
          icon="download"
          title="No models yet"
          body="Everything in Browse downloads once and then runs offline. The smallest useful model is under a gigabyte."
        />
      ) : (
        <div className="section">
          <div className="section__head">
            <h2 className="grow">On this device</h2>
            <span className="readout">{formatBytes(usedByModels)}</span>
          </div>

          <div className="card card--flush">
            <div className="list">
              {models.map((record) => (
                /* Two separate controls rather than a button inside a button:
                   nesting them is invalid HTML and leaves the inner one
                   unreachable by keyboard. */
                <div
                  key={record.id}
                  className="list__item"
                  data-interactive="true"
                  aria-selected={record.id === activeModelId}
                >
                  <button
                    type="button"
                    className="list__main"
                    style={{ background: 'none', textAlign: 'left' }}
                    onClick={() => onOpen(record.id)}
                  >
                    <span className="list__title">{record.manifest.name}</span>
                    <span className="list__sub">
                      {formatBytes(record.downloadedBytes)} · {record.manifest.quantization} ·{' '}
                      {record.useCount} use{record.useCount === 1 ? '' : 's'}
                    </span>
                  </button>
                  <CapabilityChips capabilities={record.manifest.capabilities} />
                  <button
                    type="button"
                    className="icon-btn"
                    aria-label={`Remove ${record.manifest.name}`}
                    onClick={() => onRemove(record)}
                  >
                    <Icon name="trash" size={15} />
                  </button>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      <div className="card">
        <div className="row" style={{ gap: 'var(--s-2)' }}>
          <Icon name="chip" size={16} />
          <span className="card__title grow">This device</span>
        </div>
        {device ? (
          <>
            <div className="row" style={{ gap: 'var(--s-2)', flexWrap: 'wrap' }}>
              <span className="chip">{device.chipset}</span>
              <span className="chip">{device.cpuCores} cores</span>
              <span className="chip">{formatBytes(device.totalMemory, 0)} RAM</span>
              {device.backends.map((backend) => (
                <span key={backend} className="chip chip--local">
                  {backend}
                </span>
              ))}
            </div>
            {/*
              A meter needs a real maximum. The browser's quota is one only
              where the models are IN the browser's storage — on the web, where
              they go to OPFS. On iOS, Android and the desktop shell they are
              in a real directory outside it, `@capacitor/filesystem` offers no
              free-space call, and the shell refuses `stat`, so there is no
              denominator to draw against. The figure is shown without one
              rather than against a fabricated maximum.
            */}
            {storage.quota > 0 ? (
              <Meter
                label="Storage"
                value={storage.used}
                max={storage.quota}
                detail={`${formatBytes(storage.used)} of ${formatBytes(storage.quota)}`}
                tone={storage.used / storage.quota > 0.85 ? 'warn' : 'ember'}
              />
            ) : storage.used > 0 ? (
              <div className="row" style={{ gap: 'var(--s-2)' }}>
                <span className="label">Storage</span>
                <span className="readout">{formatBytes(storage.used)} of models on disk</span>
              </div>
            ) : null}
          </>
        ) : (
          <p className="section__hint">Device capabilities are still being read.</p>
        )}
      </div>
    </>
  );
}

/* ── Browse ─────────────────────────────────────────────────────────── */

const FILTERS: readonly { value: Capability | 'all'; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'text', label: 'Text' },
  { value: 'vision', label: 'Vision' },
  { value: 'audio-in', label: 'Speech' },
  { value: 'audio-out', label: 'Voice' },
  { value: 'image-out', label: 'Images' },
];

function BrowseView({ onOpen }: { onOpen: (modelId: string) => void }): ReactNode {
  const [filter, setFilter] = useState<Capability | 'all'>('all');
  const [hf, setHf] = useState(false);
  const installed = useModels((state) => state.installed);
  const device = useApp((state) => state.device);

  const entries = useMemo(
    () =>
      CATALOG.filter(
        (manifest) => filter === 'all' || manifest.capabilities.includes(filter),
      ),
    [filter],
  );

  return (
    <>
      <div className="scroll-x">
        <div className="row" style={{ gap: 'var(--s-2)', paddingBottom: 2 }}>
          {FILTERS.map((entry) => (
            <button
              key={entry.value}
              type="button"
              className="chip chip--button"
              aria-pressed={filter === entry.value}
              onClick={() => setFilter(entry.value)}
            >
              {entry.label}
            </button>
          ))}
        </div>
      </div>

      <div className="section">
        {entries.map((manifest) => (
          <CatalogCard
            key={manifest.id}
            manifest={manifest}
            state={installed[manifest.id]?.state ?? 'available'}
            totalMemory={device?.totalMemory ?? 0}
            onOpen={() => onOpen(manifest.id)}
          />
        ))}
      </div>

      <button type="button" className="btn btn--secondary btn--block" onClick={() => setHf(true)}>
        <Icon name="search" size={15} />
        Search Hugging Face
      </button>

      <Sheet open={hf} title="Hugging Face" onClose={() => setHf(false)}>
        <HuggingFaceBrowser onClose={() => setHf(false)} />
      </Sheet>
    </>
  );
}

function CatalogCard({
  manifest,
  state,
  totalMemory,
  onOpen,
}: {
  manifest: ModelManifest;
  state: string;
  totalMemory: number;
  onOpen: () => void;
}): ReactNode {
  const tooBig = totalMemory > 0 && manifest.minRAM > totalMemory;
  const tight = !tooBig && totalMemory > 0 && manifest.recommendedRAM > totalMemory;

  return (
    <div className="card card--local">
      <div className="row" style={{ gap: 'var(--s-3)', alignItems: 'flex-start' }}>
        <div className="list__main">
          <span className="card__title">{manifest.name}</span>
          <span className="list__sub">
            {manifest.author} · {formatBytes(manifest.sizeBytes)} · {manifest.quantization}
          </span>
        </div>
        <CapabilityChips capabilities={manifest.capabilities} />
      </div>

      <p style={{ fontSize: 'var(--t-sm)', color: 'var(--ink-2)', lineHeight: 'var(--lh-snug)' }}>
        {manifest.description}
      </p>

      {tooBig ? (
        <span className="chip chip--crit" style={{ alignSelf: 'flex-start', whiteSpace: 'normal' }}>
          <Icon name="alert" size={11} />
          Needs {formatBytes(manifest.minRAM, 0)} of memory — more than this device has
        </span>
      ) : tight ? (
        <span className="chip chip--warn" style={{ alignSelf: 'flex-start', whiteSpace: 'normal' }}>
          <Icon name="alert" size={11} />
          Will run, but slowly — {formatBytes(manifest.recommendedRAM, 0)} is recommended
        </span>
      ) : null}

      <div className="row" style={{ gap: 'var(--s-2)' }}>
        <button type="button" className="btn btn--secondary btn--sm grow" onClick={onOpen}>
          Details
        </button>
        <button
          type="button"
          className="btn btn--primary btn--sm grow"
          disabled={state !== 'available' || tooBig}
          onClick={() => void useModels.getState().install(manifest)}
        >
          {state === 'installed' ? (
            <>
              <Icon name="check" size={14} />
              Installed
            </>
          ) : state === 'downloading' ? (
            <>
              <span className="spinner" />
              Downloading
            </>
          ) : (
            <>
              <Icon name="download" size={14} />
              {formatBytes(manifest.sizeBytes)}
            </>
          )}
        </button>
      </div>
    </div>
  );
}

export function CapabilityChips({
  capabilities,
}: {
  capabilities: readonly Capability[];
}): ReactNode {
  const LABELS: Partial<Record<Capability, string>> = {
    vision: 'Vision',
    'audio-in': 'Speech',
    'audio-out': 'Voice',
    'image-out': 'Images',
    thinking: 'Reasons',
    tools: 'Tools',
    draft: 'Draft',
  };

  const shown = capabilities.filter((capability) => LABELS[capability]);
  if (shown.length === 0) return null;

  return (
    <span className="row" style={{ gap: 4, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
      {shown.map((capability) => (
        <span key={capability} className="chip">
          {LABELS[capability]}
        </span>
      ))}
    </span>
  );
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
