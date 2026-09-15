import { useEffect, useState, type ReactNode } from 'react';
import { useShallow } from 'zustand/react/shallow';

import { Icon } from '@/ui/Icon';
import { Rail } from '@/ui/Rail';
import { Confirm, Segmented, SettingRow, Sheet, Slider, Switch } from '@/ui/primitives';
import { clearAllConversations, eraseEverything } from '@/db';
import { tellOtherWindows } from '@/lib/other-windows';
import { formatBytes } from '@/domain/manifest';
import { osVoicesReady, speak, type VoiceOption } from '@/lib/voice';
import { useApp, type ThemeChoice, type VoiceMode } from '@/state/app';
import { useChats } from '@/state/chat';
import { useModels, modelsWith } from '@/state/models';
import { ProvidersPanel } from '@/features/settings/ProvidersPanel';
import { McpPanel } from '@/features/settings/McpPanel';
import { PairingEntry } from '@/features/pairing/PairingEntry';
import { useMcp } from '@/state/mcp';
import { ShellSheet } from '@/features/shell/ShellSheet';

export function SettingsScreen(): ReactNode {
  const settings = useApp((state) => state.settings);
  const update = useApp((state) => state.updateSettings);
  const device = useApp((state) => state.device);
  const connections = useApp((state) => state.connections);
  const storage = useModels((state) => state.storage);
  const neuralVoices = useModels(useShallow((state) => modelsWith(state, 'audio-out')));

  const [providers, setProviders] = useState(false);
  const [mcp, setMcp] = useState(false);
  // Tools currently offered by connected MCP servers, for the section chip.
  const mcpToolCount = Object.values(useMcp((state) => state.states)).reduce(
    (n, entry) => n + entry.toolCount,
    0,
  );
  const [shell, setShell] = useState(false);
  const [voices, setVoices] = useState<VoiceOption[]>([]);
  const [confirmClearChats, setConfirmClearChats] = useState(false);
  const [confirmErase, setConfirmErase] = useState(false);
  const [about, setAbout] = useState(false);

  useEffect(() => {
    void osVoicesReady().then(setVoices);
  }, []);

  const enabledConnections = connections.filter((connection) => connection.enabled);

  return (
    <>
      <Rail title="Settings" />
      <main className="app__body">
        <div className="screen__scroll">
          <div className="screen__pad">
            {/* ── Privacy first, because it is the product ────────────── */}
            <div className="card card--local">
              <div className="row" style={{ gap: 'var(--s-2)' }}>
                <Icon name="shield" size={17} />
                <span className="card__title grow">What leaves this device</span>
              </div>
              <ul
                style={{
                  fontSize: 'var(--t-sm)',
                  color: 'var(--ink-2)',
                  paddingLeft: 'var(--s-5)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 4,
                }}
              >
                <li>What you search for and download from Hugging Face.</li>
                <li>
                  {enabledConnections.length === 0
                    ? 'No provider is enabled, so nothing you type is sent to one.'
                    : `Messages you send to ${enabledConnections.map((connection) => connection.label).join(', ')}.`}
                </li>
                {mcpToolCount > 0 ? (
                  <li>
                    The arguments of any MCP tool the model calls, to the server that tool comes
                    from. The app asks before they go, per server.
                  </li>
                ) : null}
                <li>
                  {settings.leaderboardOptIn
                    ? 'Benchmark runs you explicitly publish.'
                    : 'No benchmark data — leaderboard publishing is off.'}
                </li>
              </ul>
              {/* This card was a second copy of the shell's `privacy` list that
                  nobody updated when that list grew, so it was stale as well as
                  wrong: it said "Nothing else — no remote providers are
                  connected" a few hundred pixels above the MCP section, and it
                  ended on a storage sentence positioned as an egress promise.
                  It is no longer a second source of truth. It states what it
                  can state exactly and sends the reader to the one list that is
                  kept current. */}
              <p className="section__hint">
                Conversations, personas, and generated images are stored only on this device —
                there is no account and nothing syncs. What can leave a conversation is longer
                than this card: run <code>privacy</code> in the shell.
              </p>
            </div>

            {/* ── Appearance ─────────────────────────────────────────── */}
            <div className="section">
              <div className="section__head">
                <h2>Appearance</h2>
              </div>
              <div className="card card--flush">
                <div className="list">
                  <SettingRow title="Theme">
                    <Segmented
                      label="Theme"
                      value={settings.theme}
                      onChange={(theme: ThemeChoice) => void update({ theme })}
                      options={[
                        { value: 'system', label: 'Auto' },
                        { value: 'light', label: 'Light' },
                        { value: 'dark', label: 'Dark' },
                      ]}
                    />
                  </SettingRow>
                  <SettingRow
                    title="Format replies"
                    hint="Render markdown, tables, and highlighted code."
                  >
                    <Switch
                      checked={settings.renderMarkdown}
                      onChange={(renderMarkdown) => void update({ renderMarkdown })}
                      label="Format replies"
                    />
                  </SettingRow>
                  <SettingRow
                    title="Show reasoning"
                    hint="Display a model’s working when it produces one."
                  >
                    <Switch
                      checked={settings.showThinking}
                      onChange={(showThinking) => void update({ showThinking })}
                      label="Show reasoning"
                    />
                  </SettingRow>
                </div>
              </div>
            </div>

            {/* ── Voice ──────────────────────────────────────────────── */}
            <div className="section">
              <div className="section__head">
                <h2>Voice</h2>
              </div>
              <p className="section__hint">
                The built-in OS voice needs no download and starts instantly. A neural voice sounds
                the same on every device but has to be installed first.
              </p>
              <div className="card card--flush">
                <div className="list">
                  <SettingRow title="Read replies aloud">
                    <Segmented
                      label="Voice mode"
                      value={settings.voiceMode}
                      onChange={(voiceMode: VoiceMode) => void update({ voiceMode, voiceId: '' })}
                      options={[
                        { value: 'off', label: 'Off' },
                        { value: 'os', label: 'OS' },
                        { value: 'neural', label: 'Neural' },
                      ]}
                    />
                  </SettingRow>

                  {settings.voiceMode === 'os' ? (
                    <SettingRow title="Voice" hint={`${voices.length} available on this device`}>
                      <select
                        className="select"
                        style={{ maxWidth: 190 }}
                        aria-label="OS voice"
                        value={settings.voiceId}
                        onChange={(event) => void update({ voiceId: event.target.value })}
                      >
                        <option value="">System default</option>
                        {voices.map((voice) => (
                          <option key={voice.id} value={voice.id}>
                            {voice.label} ({voice.language})
                          </option>
                        ))}
                      </select>
                    </SettingRow>
                  ) : null}

                  {settings.voiceMode === 'neural' ? (
                    <SettingRow
                      title="Neural voice"
                      hint={
                        neuralVoices.length === 0
                          ? 'Install a voice model in Models first.'
                          : 'Consistent across every device.'
                      }
                    >
                      <select
                        className="select"
                        style={{ maxWidth: 190 }}
                        aria-label="Neural voice"
                        value={settings.voiceId}
                        onChange={(event) => void update({ voiceId: event.target.value })}
                      >
                        <option value="">Choose…</option>
                        {neuralVoices.map((model) => (
                          <option key={model.id} value={model.id}>
                            {model.manifest.name}
                          </option>
                        ))}
                      </select>
                    </SettingRow>
                  ) : null}

                  {settings.voiceMode !== 'off' ? (
                    <div className="list__item" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
                      <Slider
                        label="Speed"
                        value={settings.speechRate}
                        min={0.5}
                        max={2}
                        step={0.05}
                        onChange={(speechRate) => void update({ speechRate })}
                        format={(value) => `${value.toFixed(2)}×`}
                      />
                      <button
                        type="button"
                        className="btn btn--secondary btn--sm"
                        style={{ alignSelf: 'flex-start' }}
                        onClick={() =>
                          void speak({
                            text: 'This is how replies will sound.',
                            strategy: settings.voiceMode === 'neural' ? 'neural' : 'os',
                            voiceId: settings.voiceId || undefined,
                            rate: settings.speechRate,
                          })
                        }
                      >
                        <Icon name="speaker" size={14} />
                        Preview
                      </button>
                    </div>
                  ) : null}
                </div>
              </div>
            </div>

            {/* ── Providers ──────────────────────────────────────────── */}
            <div className="section">
              <div className="section__head">
                <h2 className="grow">Remote providers</h2>
                <span className="chip chip--remote">
                  <Icon name="cloud" size={11} />
                  {enabledConnections.length} on
                </span>
              </div>
              <p className="section__hint">
                Optional. Anything you send to a remote provider leaves this device, and every
                reply that came from one is marked in the thread.
              </p>
              <button
                type="button"
                className="btn btn--secondary btn--block"
                onClick={() => setProviders(true)}
              >
                Manage providers
              </button>
            </div>

            {/* ── MCP servers ────────────────────────────────────────── */}
            <div className="section">
              <div className="section__head">
                <h2 className="grow">MCP servers</h2>
                {mcpToolCount > 0 ? (
                  <span className="chip chip--remote">
                    <Icon name="cloud" size={11} />
                    {mcpToolCount} tools
                  </span>
                ) : null}
              </div>
              <p className="section__hint">
                Optional. Adds tools the model can call on servers you choose — their arguments
                leave this device once you allow that server, and every one has to be enabled per
                chat.
              </p>
              <button
                type="button"
                className="btn btn--secondary btn--block"
                onClick={() => setMcp(true)}
              >
                Manage servers
              </button>
            </div>

            {/* ── Pairing: renders nothing unless the build can pair ─── */}
            <PairingEntry />

            {/* ── Downloads ──────────────────────────────────────────── */}
            <div className="section">
              <div className="section__head">
                <h2>Downloads</h2>
              </div>
              <div className="field">
                <label className="field__label" htmlFor="hf-token">
                  Hugging Face access token
                </label>
                <input
                  id="hf-token"
                  className="input"
                  type="password"
                  autoComplete="off"
                  placeholder="hf_…"
                  value={settings.hfToken}
                  onChange={(event) => void update({ hfToken: event.target.value })}
                />
                <span className="field__hint">
                  Needed only for gated repositories such as Llama and Gemma. Stored on this device
                  and sent only to huggingface.co.
                </span>
              </div>
              {storage.quota > 0 ? (
                <p className="section__hint">
                  Using {formatBytes(storage.used)} of {formatBytes(storage.quota)} available.
                </p>
              ) : null}
            </div>

            {/* ── Telemetry ──────────────────────────────────────────── */}
            <div className="section">
              <div className="section__head">
                <h2>Telemetry</h2>
              </div>
              <div className="card card--flush">
                <div className="list">
                  <SettingRow
                    title="Benchmark leaderboard"
                    hint="Off by default. You still confirm each run individually, and see the exact payload first."
                  >
                    <Switch
                      checked={settings.leaderboardOptIn}
                      onChange={(leaderboardOptIn) =>
                        void update({ leaderboardOptIn, telemetryConsentSeen: true })
                      }
                      label="Benchmark leaderboard"
                    />
                  </SettingRow>
                  <SettingRow
                    title="Crash reports"
                    hint="Anonymous stack traces only. No prompts or replies."
                  >
                    <Switch
                      checked={settings.crashReports}
                      onChange={(crashReports) => void update({ crashReports })}
                      label="Crash reports"
                    />
                  </SettingRow>
                </div>
              </div>
            </div>

            {/* ── Data ───────────────────────────────────────────────── */}
            <div className="section">
              <div className="section__head">
                <h2>Your data</h2>
              </div>
              <div className="card card--flush">
                <div className="list">
                  <SettingRow
                    title="Delete all conversations"
                    hint="Models and personas are kept."
                    onClick={() => setConfirmClearChats(true)}
                  >
                    <Icon name="chevron-right" size={16} />
                  </SettingRow>
                  <SettingRow
                    title="Erase everything"
                    hint="Chats, personas, models, images, benchmarks, and settings."
                    onClick={() => setConfirmErase(true)}
                  >
                    <Icon name="chevron-right" size={16} />
                  </SettingRow>
                </div>
              </div>
            </div>

            {/* ── About ──────────────────────────────────────────────── */}
            <div className="section">
              <div className="section__head">
                <h2>Shell</h2>
              </div>
              <p className="section__hint">
                A sandbox over this app’s own data — conversations, models, personas — with
                the usual Unix tools. No network, and nothing outside Chatterang is reachable.
                Enable the <code>bash</code> tool in a chat to let a model use the same
                commands you can.
              </p>
              <button
                type="button"
                className="btn btn--secondary btn--block"
                onClick={() => setShell(true)}
              >
                <Icon name="tool" size={15} />
                Open shell
              </button>
            </div>

            <div className="card card--flush">
              <div className="list">
                <SettingRow
                  title="About Chatterang"
                  hint={device ? `${device.chipset} · ${device.engineVersion}` : undefined}
                  onClick={() => setAbout(true)}
                >
                  <Icon name="chevron-right" size={16} />
                </SettingRow>
              </div>
            </div>
          </div>
        </div>
      </main>

      <ShellSheet open={shell} onClose={() => setShell(false)} />

      <Sheet open={providers} title="Remote providers" onClose={() => setProviders(false)}>
        <ProvidersPanel />
      </Sheet>

      <Sheet open={mcp} title="MCP servers" onClose={() => setMcp(false)}>
        <McpPanel />
      </Sheet>

      <AboutSheet open={about} onClose={() => setAbout(false)} />

      <Confirm
        open={confirmClearChats}
        title="Delete all conversations?"
        body="Every chat and message is removed from this device. Models, personas, and settings are kept."
        confirmLabel="Delete all"
        destructive
        onCancel={() => setConfirmClearChats(false)}
        onConfirm={() => {
          // The composer's draft goes first — text, chips and payloads — so no
          // chip is left naming a payload the clear takes (owner ruling,
          // 2026-09-14). `App.tsx` unmounts the composer while Settings is open,
          // which lets the draft go already, but that is a matter of layout and
          // this is the guarantee. It stays discarded if the clear fails.
          useChats.getState().discardDraft();
          void clearAllConversations().then(() => {
            // And every other tab's, once the clear has landed: the server
            // profile's tabs share the database, and the clear took the images
            // their drafts still show. Not before it lands: a clear that fails
            // takes nothing. See lib/other-windows.ts.
            tellOtherWindows('conversations-cleared');
            window.location.reload();
          });
          setConfirmClearChats(false);
        }}
      />

      <Confirm
        open={confirmErase}
        title="Erase everything?"
        body="Every chat, persona, downloaded model, generated image, benchmark run, and setting is removed. The app restarts as if newly installed. This cannot be undone."
        confirmLabel="Erase"
        destructive
        onCancel={() => setConfirmErase(false)}
        onConfirm={() => {
          void eraseEverything().then(() => window.location.reload());
          setConfirmErase(false);
        }}
      />
    </>
  );
}

function AboutSheet({ open, onClose }: { open: boolean; onClose: () => void }): ReactNode {
  const device = useApp((state) => state.device);

  return (
    <Sheet open={open} title="About Chatterang" onClose={onClose}>
      <div className="row" style={{ gap: 'var(--s-3)' }}>
        <span style={{ color: 'var(--ember)' }}>
          <Icon name="flame" size={30} />
        </span>
        <div className="list__main">
          <span className="list__title">Chatterang {__APP_VERSION__}</span>
          <span className="list__sub">Language, vision, speech, and image models, run locally.</span>
        </div>
      </div>

      <p style={{ color: 'var(--ink-2)', fontSize: 'var(--t-sm)', lineHeight: 'var(--lh-body)' }}>
        Inference runs through <code>@johnhenry/aimatey</code>, which gives on-device engines and
        remote providers one shared request contract. Adding a new runtime means writing one
        adapter, not touching the app.
      </p>

      <div className="card card--flush">
        <div className="list">
          {device ? (
            <>
              <SettingRow title="Chipset" hint={device.chipset} />
              <SettingRow title="Engine" hint={device.engineVersion} />
              <SettingRow title="Compute" hint={device.backends.join(', ')} />
              <SettingRow title="Memory" hint={formatBytes(device.totalMemory, 0)} />
            </>
          ) : null}
        </div>
      </div>

      <p className="section__hint">
        Licensed under Apache-2.0. Model weights carry their own licences, shown on each model’s
        page before download.
      </p>
    </Sheet>
  );
}
