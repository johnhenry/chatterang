import { type ReactNode } from 'react';
import { useShallow } from 'zustand/react/shallow';

import { Icon } from '@/ui/Icon';
import { Sheet, Slider } from '@/ui/primitives';
import { catalogEntry } from '@/data/catalog';
import {
  SAMPLER_RANGES,
  canBenchmark,
  canChat,
  formatBytes,
  nonChatRole,
  resolveSourceUrl,
} from '@/domain/manifest';
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
            {/*
              The benchmark is a llama.cpp harness — `LlamaCpp.load` then
              `LlamaCpp.benchmark`, a method no other plugin contract has — so
              offering it for a Whisper or Piper model was offering a tap that
              could only end in a native loader failure. The engine is stated
              plainly a few rows down under "Engine"; a second dead control
              beside the "not a chat model" one would be noise, so the button
              is simply not offered. `useBench.run` refuses regardless.
            */}
            {canBenchmark(manifest) ? (
              <button
                type="button"
                className="btn btn--secondary grow"
                disabled={Boolean(running)}
                onClick={() => void useBench.getState().run(modelId)}
              >
                {running?.modelId === modelId ? <span className="spinner" /> : <Icon name="gauge" size={15} />}
                Benchmark
              </button>
            ) : null}
            {/*
              A speech, voice or diffusion model has no "use in new chats" —
              offering the button and then refusing the tap is a worse answer
              than saying, here, what the model is actually for. This is the
              door the reported bug came through.

              The label states only the negative. It used to read "turns speech
              into text — not a chat model", and the affirmative half is a claim
              this build cannot honour on the platform the bug was filed from:
              there is no native ONNX plugin on Android or iOS, so Whisper turns
              speech into nothing there. What the model IS goes in the body
              below, where `nonChatRole` names a kind rather than promising a
              feature.
            */}
            {canChat(manifest) ? (
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
            ) : (
              /*
                Not a button. It was `<span className="btn" aria-disabled>`,
                which is a text run painted to look like a control: a `span` is
                not focusable, and `aria-disabled` on a non-interactive element
                does nothing, so assistive tech announced no control at all —
                and for the user in the report, whose only model is Whisper,
                that fake control was the ENTIRE footer of the sheet.

                There is no action to offer here, so none is mimed. The note
                keeps the reason visible next to the sticky footer for anyone
                who scrolled past the paragraph below, in list-sub type rather
                than button type, and the footer gets one control that really
                does something.
              */
              <>
                <span className="list__sub grow" style={{ alignSelf: 'center' }}>
                  Not a chat model
                </span>
                <button type="button" className="btn btn--secondary" onClick={onClose}>
                  Done
                </button>
              </>
            )}
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
      {/*
        THE SHEET'S OPENING PARAGRAPH, AND WHY A NON-CHAT MODEL DOES NOT GET
        THE CATALOGUE'S.

        `manifest.description` is vendor copy, and for the three models this
        branch covers it is exactly the promise the rest of this round was
        spent deleting. Whisper's reads "Turns speech into text on the device.
        Fast enough to keep up with normal dictation, and the audio never
        leaves your phone." — rendered here in body type, one line above the
        sentence that carefully says only "is a speech-to-text model". The
        larger, earlier, more confident half won.

        It is not a small overclaim. Every non-chat entry in the catalogue is
        `engine: 'onnx-runtime'`, and `@chatterang/plugin-onnx-runtime` appears
        in none of package.json,
        android/app/src/main/assets/capacitor.plugins.json,
        android/capacitor.settings.gradle or ios/App/CapApp-SPM/Package.swift,
        while `plugin-llama-cpp` is in all four. On the phone the bug was filed
        from, "on the device" and "never leaves your phone" describe work that
        does not happen: there is nothing there to do it. That is a claim about
        WHERE A TURN GOES, made about a turn this build cannot take.

        The platform is not branched on — `tests/layering.test.ts` bans
        `capabilities().id` in `src/`, and rightly: the honest sentence is one
        that is true on every platform this ships to. So the catalogue's
        paragraph is not shown for a model that cannot chat, and the derived
        sentence takes the slot it had, in the type it had.

        The sentence itself is the shape the shell, the store and the chat
        refusal all use, so a user who meets this rule twice meets the same
        words both times. It names the KIND of model and points at the filter
        that lists the ones that can chat — "Text", in `ModelsScreen`'s FILTERS.

        It said "the Text filter in Models", and skipped a step: `FILTERS` is
        rendered by `BrowseView` alone, and `ModelsScreen` opens on
        `view='installed'`. Someone following that sentence landed on Installed,
        found no filter row anywhere, and was back where they started. Both
        steps are named now — the segmented control's own label, then the
        filter's.

        `ModelsScreen`'s browse row renders `manifest.description` too, and is
        not this file's to change; the catalogue copy itself is the real fix.
      */}
      {canChat(manifest) ? (
        <p style={{ color: 'var(--ink-2)', lineHeight: 'var(--lh-body)' }}>{manifest.description}</p>
      ) : (
        <p style={{ color: 'var(--ink-2)', lineHeight: 'var(--lh-body)' }}>
          {manifest.name} {nonChatRole(manifest)}. It cannot answer a chat — open Models › Browse
          and use the Text filter to list the ones that can.
        </p>
      )}

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
