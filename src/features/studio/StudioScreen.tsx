import { useState, type ReactNode } from 'react';
import { useShallow } from 'zustand/react/shallow';

import { Icon } from '@/ui/Icon';
import { Rail } from '@/ui/Rail';
import { Confirm, Empty, Meter, Segmented, Sheet, Slider } from '@/ui/primitives';
import { IMAGE_GEN_RAM_FLOOR } from '@/data/catalog';
import { formatBytes } from '@/domain/manifest';
import { useApp } from '@/state/app';
import { useImages } from '@/state/images';
import { useModels, modelsWith } from '@/state/models';
import type { GeneratedImage } from '@/db';

/**
 * Studio — on-device image generation and its gallery (PRD §3.4).
 *
 * Gated behind a device memory floor, because a diffusion pipeline that gets
 * killed mid-generation on a 4 GB phone is worse than a feature that honestly
 * says it will not run here.
 */
export function StudioScreen(): ReactNode {
  const [view, setView] = useState<'create' | 'gallery'>('create');

  return (
    <>
      <Rail title="Studio" />
      <main className="app__body">
        <div className="screen__scroll">
          <div className="screen__pad">
            <Segmented
              label="Studio view"
              value={view}
              onChange={setView}
              options={[
                { value: 'create', label: 'Create' },
                { value: 'gallery', label: 'Gallery' },
              ]}
            />
            {view === 'create' ? <Create /> : <Gallery />}
          </div>
        </div>
      </main>
    </>
  );
}

function Create(): ReactNode {
  const device = useApp((state) => state.device);
  const imageModels = useModels(useShallow((state) => modelsWith(state, 'image-out')));
  const generating = useImages((state) => state.generating);
  const progress = useImages((state) => state.progress);
  const latest = useImages((state) => state.images[0]);

  const [prompt, setPrompt] = useState('');
  const [negative, setNegative] = useState('');
  const [steps, setSteps] = useState(4);
  const [size, setSize] = useState(512);
  const [seed, setSeed] = useState<number | null>(null);

  const memory = device?.totalMemory ?? 0;
  const belowFloor = memory > 0 && memory < IMAGE_GEN_RAM_FLOOR;
  const model = imageModels[0];

  if (belowFloor) {
    return (
      <div className="card" style={{ borderLeft: '3px solid var(--warn)' }}>
        <span className="label" style={{ color: 'var(--warn)' }}>
          Not available on this device
        </span>
        <p style={{ fontSize: 'var(--t-sm)', color: 'var(--ink-2)' }}>
          Image generation needs at least {formatBytes(IMAGE_GEN_RAM_FLOOR, 0)} of memory and this
          device has {formatBytes(memory, 0)}. Running it here would be terminated by the operating
          system partway through.
        </p>
      </div>
    );
  }

  if (!model) {
    return (
      <Empty
        icon="image"
        title="No image model installed"
        body="Install an image model in Models. It runs in its own isolated process so it cannot disturb a loaded language model."
      />
    );
  }

  return (
    <>
      <div className="field">
        <label className="field__label" htmlFor="img-prompt">
          Prompt
        </label>
        <textarea
          id="img-prompt"
          className="textarea"
          rows={3}
          placeholder="A lighthouse in fog, painted in thin oils"
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
        />
      </div>

      <div className="field">
        <label className="field__label" htmlFor="img-negative">
          Avoid
        </label>
        <input
          id="img-negative"
          className="input"
          placeholder="blurry, text, watermark"
          value={negative}
          onChange={(event) => setNegative(event.target.value)}
        />
      </div>

      <Slider
        label="Steps"
        hint="Turbo models need very few. More steps means slower, not always better."
        value={steps}
        min={1}
        max={20}
        step={1}
        onChange={setSteps}
      />

      <div className="field">
        <span className="field__label">Size</span>
        <Segmented
          label="Image size"
          value={String(size)}
          onChange={(value) => setSize(Number(value))}
          options={[
            { value: '384', label: '384' },
            { value: '512', label: '512' },
            { value: '768', label: '768' },
          ]}
        />
        <span className="field__hint">
          Memory use grows with the square of the size. 768 needs roughly twice what 512 does.
        </span>
      </div>

      <div className="field">
        <label className="field__label" htmlFor="img-seed">
          Seed
        </label>
        <input
          id="img-seed"
          className="input num"
          type="number"
          placeholder="Random"
          value={seed ?? ''}
          onChange={(event) => setSeed(event.target.value === '' ? null : Number(event.target.value))}
        />
      </div>

      {generating && progress ? (
        <div className="card card--local">
          <Meter
            label={`Step ${progress.step} of ${progress.totalSteps}`}
            value={progress.step}
            max={progress.totalSteps}
          />
          {progress.preview ? (
            <img
              src={`data:image/png;base64,${progress.preview}`}
              alt="Generation in progress"
              style={{ borderRadius: 'var(--r-sm)', width: '100%' }}
            />
          ) : null}
          <button
            type="button"
            className="btn btn--secondary btn--block"
            onClick={() => useImages.getState().cancel()}
          >
            Stop
          </button>
        </div>
      ) : (
        <button
          type="button"
          className="btn btn--primary btn--block"
          disabled={!prompt.trim()}
          onClick={() =>
            void useImages.getState().generate({
              prompt: prompt.trim(),
              negativePrompt: negative.trim() || undefined,
              steps,
              size,
              seed,
              modelId: model.id,
            })
          }
        >
          <Icon name="image" size={15} />
          Generate
        </button>
      )}

      {latest && !generating ? (
        <div className="card card--flush">
          <img
            src={`data:${latest.mediaType};base64,${latest.data}`}
            alt={latest.prompt}
            style={{ width: '100%', display: 'block' }}
          />
          <div style={{ padding: 'var(--s-3)' }}>
            <span className="readout">
              {latest.width}×{latest.height} · {latest.steps} steps · seed {latest.seed} ·{' '}
              {(latest.durationMs / 1000).toFixed(1)}s
            </span>
          </div>
        </div>
      ) : null}
    </>
  );
}

function Gallery(): ReactNode {
  const images = useImages((state) => state.images);
  const [open, setOpen] = useState<GeneratedImage | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<GeneratedImage | null>(null);

  if (images.length === 0) {
    return (
      <Empty
        icon="image"
        title="Nothing generated yet"
        body="Images you make are stored on this device and are never uploaded anywhere."
      />
    );
  }

  return (
    <>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))',
          gap: 'var(--s-2)',
        }}
      >
        {images.map((image) => (
          <button
            key={image.id}
            type="button"
            onClick={() => setOpen(image)}
            style={{
              borderRadius: 'var(--r-sm)',
              overflow: 'hidden',
              border: '1px solid var(--line)',
              aspectRatio: '1',
              padding: 0,
            }}
          >
            <img
              src={`data:${image.mediaType};base64,${image.data}`}
              alt={image.prompt}
              style={{ width: '100%', height: '100%', objectFit: 'cover' }}
            />
          </button>
        ))}
      </div>

      {open ? (
        <Sheet
          open
          title="Image"
          onClose={() => setOpen(null)}
          footer={
            <>
              <button
                type="button"
                className="btn btn--danger grow"
                onClick={() => {
                  setConfirmDelete(open);
                  setOpen(null);
                }}
              >
                Delete
              </button>
              <button
                type="button"
                className="btn btn--secondary grow"
                onClick={() => void navigator.clipboard.writeText(open.prompt)}
              >
                Copy prompt
              </button>
            </>
          }
        >
          <img
            src={`data:${open.mediaType};base64,${open.data}`}
            alt={open.prompt}
            style={{ width: '100%', borderRadius: 'var(--r-sm)' }}
          />
          <p style={{ color: 'var(--ink-2)', fontSize: 'var(--t-sm)' }}>{open.prompt}</p>
          {open.negativePrompt ? (
            <p className="section__hint">Avoided: {open.negativePrompt}</p>
          ) : null}
          <span className="readout">
            {open.width}×{open.height} · {open.steps} steps · seed {open.seed} ·{' '}
            {(open.durationMs / 1000).toFixed(1)}s
          </span>
        </Sheet>
      ) : null}

      <Confirm
        open={confirmDelete !== null}
        title="Delete this image?"
        body="It is removed from this device permanently."
        confirmLabel="Delete"
        destructive
        onCancel={() => setConfirmDelete(null)}
        onConfirm={() => {
          if (confirmDelete) void useImages.getState().remove(confirmDelete.id);
          setConfirmDelete(null);
        }}
      />
    </>
  );
}
