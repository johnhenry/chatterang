import { type ReactNode } from 'react';
import { useShallow } from 'zustand/react/shallow';

import { Slider } from '@/ui/primitives';
import { Icon } from '@/ui/Icon';
import type { Chat } from '@/domain/chat';
import { DEFAULT_SAMPLER, SAMPLER_RANGES, type SamplerSettings } from '@/domain/manifest';
import { useChats } from '@/state/chat';
import { useModels, modelsWith } from '@/state/models';

/**
 * Sampler controls (PRD §3.1).
 *
 * Two scopes, and the distinction is made visible rather than implied: values
 * saved against the model apply everywhere that model is used, while values
 * set here override them for this chat only.
 */
export function SamplerPanel({ chat }: { chat: Chat }): ReactNode {
  const installed = useModels((state) => state.installed);
  const draftModels = useModels(useShallow((state) => modelsWith(state, 'draft')));
  const update = useChats((state) => state.updateChat);

  const model = chat.modelId ? installed[chat.modelId] : undefined;
  const base: SamplerSettings = model?.sampler ?? DEFAULT_SAMPLER;
  const effective: SamplerSettings = { ...base, ...chat.sampler };
  const overrides = chat.sampler ?? {};

  // Merged into the overrides AS THEY STAND WHEN THIS IS WRITTEN, not the ones
  // this panel rendered: two changes made before the first had landed kept only
  // the second. See `ChatPatch`.
  const set = (patch: Partial<SamplerSettings>): void => {
    void update(chat.id, (current) => ({ sampler: { ...current.sampler, ...patch } }));
  };

  // Saved from the overrides AS THEY STAND once every change already asked for
  // has landed, not the ones this panel rendered: a slider change still being
  // written was in neither what was saved nor what was left once the clear
  // landed. And only what was saved is cleared, so a change made while the
  // defaults were being written stays this chat's. See `ChatPatch`.
  const saveAsDefaults = async (modelId: string): Promise<void> => {
    const read: { values?: SamplerSettings } = {};
    // A patch that writes nothing: it reads the chat in its turn.
    await update(chat.id, (current) => {
      read.values = {
        ...(useModels.getState().installed[modelId]?.sampler ?? DEFAULT_SAMPLER),
        ...current.sampler,
      };
      return null;
    });
    const saved = read.values;
    if (!saved) return;
    await useModels.getState().saveSampler(modelId, saved);
    await update(chat.id, (current) => {
      const held = Object.entries(current.sampler ?? {});
      const left = held.filter(
        ([key, value]) => JSON.stringify(value) !== JSON.stringify(saved[key as keyof SamplerSettings]),
      );
      if (left.length === held.length) return null;
      return { sampler: left.length > 0 ? (Object.fromEntries(left) as Partial<SamplerSettings>) : null };
    });
  };

  const overridden = (key: keyof SamplerSettings): boolean => key in overrides;

  return (
    <div className="section">
      <div className="section__head">
        <h2 className="grow">Sampling</h2>
        {Object.keys(overrides).length > 0 ? (
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={() => void update(chat.id, { sampler: null })}
          >
            <Icon name="refresh" size={13} />
            Reset to model
          </button>
        ) : null}
      </div>

      <p className="section__hint">
        {model
          ? `Starting from ${model.manifest.name}’s saved settings. Anything you change here applies to this chat only.`
          : 'These apply to this chat.'}
      </p>

      {(
        [
          'temperature',
          'topP',
          'topK',
          'minP',
          'repeatPenalty',
          'maxTokens',
        ] as const
      ).map((key) => {
        const range = SAMPLER_RANGES[key];
        return (
          <Slider
            key={key}
            label={`${range.label}${overridden(key) ? ' ·' : ''}`}
            hint={range.hint}
            value={effective[key]}
            min={range.min}
            max={range.max}
            step={range.step}
            onChange={(value) => set({ [key]: value } as Partial<SamplerSettings>)}
            format={(value) => (range.step < 1 ? value.toFixed(2) : String(value))}
          />
        );
      })}

      <div className="field">
        <label className="field__label" htmlFor="stop-sequences">
          Stop sequences
        </label>
        <input
          id="stop-sequences"
          className="input"
          placeholder="Comma-separated"
          value={effective.stopSequences.join(', ')}
          onChange={(event) =>
            set({
              stopSequences: event.target.value
                .split(',')
                .map((entry) => entry.trim())
                .filter(Boolean),
            })
          }
        />
        <span className="field__hint">Generation stops as soon as any of these appears.</span>
      </div>

      <div className="field">
        <label className="field__label" htmlFor="seed">
          Seed
        </label>
        <input
          id="seed"
          className="input num"
          type="number"
          placeholder="Random"
          value={effective.seed ?? ''}
          onChange={(event) =>
            set({ seed: event.target.value === '' ? null : Number(event.target.value) })
          }
        />
        <span className="field__hint">
          Fix the seed to get the same reply from the same prompt.
        </span>
      </div>

      {/* Speculative decoding (PRD §3.1) */}
      <div className="card card--quiet">
        <div className="row" style={{ gap: 'var(--s-2)' }}>
          <Icon name="chip" size={16} />
          <span className="card__title grow">Speculative decoding</span>
        </div>
        <p className="section__hint">
          A small draft model guesses the next few words and the main model checks them. The output
          is identical — it just arrives faster.
        </p>

        {draftModels.length === 0 ? (
          <p className="section__hint">
            Install a small model tagged for drafting — Qwen2.5 0.5B is under 400 MB.
          </p>
        ) : (
          <>
            <select
              className="select"
              aria-label="Draft model"
              value={effective.draftModelId ?? ''}
              onChange={(event) => set({ draftModelId: event.target.value || null })}
            >
              <option value="">Off</option>
              {draftModels.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.manifest.name}
                </option>
              ))}
            </select>

            {effective.draftModelId ? (
              <Slider
                label={SAMPLER_RANGES.draftTokens.label}
                hint={SAMPLER_RANGES.draftTokens.hint}
                value={effective.draftTokens}
                min={SAMPLER_RANGES.draftTokens.min}
                max={SAMPLER_RANGES.draftTokens.max}
                step={SAMPLER_RANGES.draftTokens.step}
                onChange={(value) => set({ draftTokens: value })}
              />
            ) : null}
          </>
        )}
      </div>

      {model ? (
        <button
          type="button"
          className="btn btn--secondary btn--block"
          onClick={() => void saveAsDefaults(model.id)}
        >
          Save these as {model.manifest.name}’s defaults
        </button>
      ) : null}
    </div>
  );
}
