import { useState, type ReactNode } from 'react';

import { Icon } from '@/ui/Icon';
import { Confirm, Sheet, Switch } from '@/ui/primitives';
import { PROVIDERS, getProvider, type ProviderConnection, type ProviderDescriptor } from '@/ai/providers';
import { newId } from '@/domain/chat';
import { useApp } from '@/state/app';
import { capabilities } from '@/lib/platform';
import { Cli, type CliDiscoverResult } from '@/plugins/cli';

/**
 * Remote provider management (PRD §3.5).
 *
 * The consent framing is deliberate. Every provider states plainly what
 * connecting it means for the conversation, and self-hosted endpoints are
 * grouped separately from cloud ones because sending a message to a server in
 * your own house is a materially different decision from sending it to a
 * company.
 */
export function ProvidersPanel(): ReactNode {
  const connections = useApp((state) => state.connections);
  const settings = useApp((state) => state.settings);
  const update = useApp((state) => state.updateSettings);
  const pending = useApp((state) => state.pendingConnections);
  const toast = useApp((state) => state.toast);

  const [adding, setAdding] = useState<ProviderDescriptor | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<ProviderConnection | null>(null);

  const grouped = {
    'self-hosted': PROVIDERS.filter((provider) => provider.kind === 'self-hosted'),
    cloud: PROVIDERS.filter((provider) => provider.kind === 'cloud'),
    aggregator: PROVIDERS.filter((provider) => provider.kind === 'aggregator'),
    'local-cli': PROVIDERS.filter((provider) => provider.kind === 'local-cli'),
  };

  return (
    <>
      {connections.length > 0 ? (
        <div className="section">
          <div className="section__head">
            <h2>Connected</h2>
          </div>
          <div className="card card--flush">
            <div className="list">
              {connections.map((connection) => (
                <div key={connection.id} className="list__item">
                  <div className="list__main">
                    <span className="list__title">{connection.label}</span>
                    <span className="list__sub truncate">
                      {connection.defaultModel || 'No default model'}
                      {connection.baseUrl ? ` · ${connection.baseUrl}` : ''}
                    </span>
                  </div>
                  <Switch
                    checked={connection.enabled}
                    disabled={pending.includes(connection.id)}
                    onChange={(enabled) => {
                      // A refused switch-on used to be silent: the switch just
                      // stayed off, with no toast and no pending state while it
                      // waited (#315). `disabled` above covers the wait; this
                      // covers the refusal, whichever way it fails.
                      void useApp
                        .getState()
                        .toggleConnection(connection.id, enabled)
                        .catch((error: unknown) => {
                          toast(
                            error instanceof Error
                              ? error.message
                              : `Could not ${enabled ? 'enable' : 'disable'} ${connection.label}.`,
                            'crit',
                          );
                        });
                    }}
                    label={`Enable ${connection.label}`}
                  />
                  <button
                    type="button"
                    className="icon-btn"
                    aria-label={`Remove ${connection.label}`}
                    onClick={() => setConfirmRemove(connection)}
                  >
                    <Icon name="trash" size={15} />
                  </button>
                </div>
              ))}
            </div>
          </div>

          <div className="card card--quiet">
            <span className="card__title">Fallback when the device cannot cope</span>
            <p className="section__hint">
              If the phone is too hot or too low on memory to run a local model, the reply can be
              generated remotely instead of failing. Off unless you choose a provider here — and
              every fallback reply is labelled in the thread.
            </p>
            <select
              className="select"
              aria-label="Fallback provider"
              value={settings.fallbackBackendId ?? ''}
              onChange={(event) =>
                void update({ fallbackBackendId: event.target.value || null })
              }
            >
              <option value="">Never fall back — fail instead</option>
              {connections
                .filter((connection) => connection.enabled)
                // #42/#115: a local agent CLI is never fallback-eligible --
                // it is not "the cloud", and the engine's own
                // `setFallbackBackend` refuses one regardless, but the
                // option should never be offered here either.
                .filter((connection) => getProvider(connection.providerId)?.kind !== 'local-cli')
                .map((connection) => (
                  <option key={connection.id} value={connection.id}>
                    {connection.label}
                  </option>
                ))}
            </select>
          </div>
        </div>
      ) : null}

      {/* "Requests stay inside your network" was a promise about an address
          the user types and nothing validates. */}
      <ProviderGroup
        title="On your own network"
        hint="Requests go to the address you give. Nothing here checks that it is on your network."
        providers={grouped['self-hosted']}
        onPick={setAdding}
      />
      {/* "…and, if you allow it, what a tool read" made allowing it the
          precondition. Measured, it is not one: flipping between regenerated
          answers moves tool-derived text into an ordinary message, and it goes
          out with no grant and no sheet. The hint now states the grant as the
          usual path and names the exception rather than implying none. */}
      <ProviderGroup
        title="Cloud providers"
        hint="Messages you send leave your device. What a tool read goes too, once you allow it for a conversation — and, after you flip between regenerated answers, whether you allowed it or not."
        providers={grouped.cloud}
        onPick={setAdding}
      />
      <ProviderGroup
        title="Aggregators"
        hint="Forwards your request to whichever provider serves the model."
        providers={grouped.aggregator}
        onPick={setAdding}
      />
      {/*
       * #42/#115: a local agent CLI is a subprocess on THIS device, not an
       * HTTP endpoint -- but reaches its own vendor under a login this app
       * never sees, so it is grouped on its own rather than folded into
       * "self-hosted" (nothing here is a server) or "cloud" (nothing here
       * is a key this app holds). Shown on every platform -- never hidden --
       * so `tests/ollama-origins.test.tsx` and `tests/privacy-copy.test.ts`'s
       * generic "every provider gets a list item with a note" loops need no
       * platform mock to find it; what changes on a non-desktop platform is
       * the hint text and the sheet's own controls, not whether the row
       * exists.
       */}
      <ProviderGroup
        title="Local CLIs"
        hint={
          capabilities().cliAgents
            ? 'Runs a CLI you already have installed and signed in to, as a subprocess on this device. Messages go to that CLI’s own vendor under your own login there — Chatterang never sees or stores a key for it.'
            : 'Local agent CLIs run as a subprocess on this device, so they are available in the desktop app only.'
        }
        providers={grouped['local-cli']}
        onPick={setAdding}
      />

      {adding
        ? adding.kind === 'local-cli'
          ? <CliConnectSheet provider={adding} onClose={() => setAdding(null)} />
          : <ConnectSheet provider={adding} onClose={() => setAdding(null)} />
        : null}

      <Confirm
        open={confirmRemove !== null}
        title={`Remove ${confirmRemove?.label ?? 'this provider'}?`}
        body="The stored key is deleted from this device. Existing messages keep their record of which provider generated them."
        confirmLabel="Remove"
        destructive
        onCancel={() => setConfirmRemove(null)}
        onConfirm={() => {
          if (confirmRemove) void useApp.getState().removeConnection(confirmRemove.id);
          setConfirmRemove(null);
        }}
      />
    </>
  );
}

function ProviderGroup({
  title,
  hint,
  providers,
  onPick,
}: {
  title: string;
  hint: string;
  providers: readonly ProviderDescriptor[];
  onPick: (provider: ProviderDescriptor) => void;
}): ReactNode {
  return (
    <div className="section">
      <div className="section__head">
        <h2>{title}</h2>
      </div>
      <p className="section__hint">{hint}</p>
      <div className="card card--flush">
        <div className="list">
          {providers.map((provider) => (
            <button
              key={provider.id}
              type="button"
              className="list__item"
              data-interactive="true"
              onClick={() => onPick(provider)}
            >
              <div className="list__main">
                <span className="list__title">{provider.label}</span>
                <span className="list__sub">
                  <ProviderNote provider={provider} />
                </span>
              </div>
              <Icon name="plus" size={16} />
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * A provider's note, plus any of it that depends on this page's own origin.
 *
 * The origin is read here, at render, not at import. It is the `Origin` this
 * app sends, and it differs by platform: `chatterang-desktop://app` on desktop,
 * `capacitor://localhost` on iOS, `https://localhost` on Android, and wherever
 * the web build is served.
 */
function ProviderNote({ provider }: { provider: ProviderDescriptor }): ReactNode {
  const more = provider.originNote?.(window.location.origin) ?? null;
  return (
    <>
      {provider.note}
      {more ? ' ' : null}
      {more?.map((part, index) =>
        typeof part === 'string' ? part : <code key={index}>{part.code}</code>,
      )}
    </>
  );
}

function ConnectSheet({
  provider,
  onClose,
}: {
  provider: ProviderDescriptor;
  onClose: () => void;
}): ReactNode {
  const [label, setLabel] = useState(provider.label);
  const [apiKey, setApiKey] = useState('');
  const [baseUrl, setBaseUrl] = useState(provider.defaultBaseUrl ?? '');
  const [defaultModel, setDefaultModel] = useState(provider.defaultModel ?? '');

  const ready = (!provider.needsKey || apiKey.trim().length > 0) && label.trim().length > 0;

  return (
    <Sheet
      open
      title={`Connect ${provider.label}`}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn--secondary grow" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn--remote grow"
            disabled={!ready}
            onClick={() => {
              const connection: ProviderConnection = {
                id: newId('conn'),
                providerId: provider.id,
                label: label.trim(),
                apiKey: apiKey.trim(),
                baseUrl: baseUrl.trim(),
                defaultModel: defaultModel.trim(),
                enabled: true,
                models: [],
                createdAt: Date.now(),
              };
              void useApp.getState().addConnection(connection);
              onClose();
            }}
          >
            Connect
          </button>
        </>
      }
    >
      <div className="card card--remote">
        <div className="row" style={{ gap: 'var(--s-2)' }}>
          <Icon name="cloud" size={16} />
          <span className="card__title grow">What this means</span>
        </div>
        <p style={{ fontSize: 'var(--t-sm)', color: 'var(--ink-2)' }}>
          <ProviderNote provider={provider} />
        </p>
      </div>

      <div className="field">
        <label className="field__label" htmlFor="conn-label">
          Name
        </label>
        <input
          id="conn-label"
          className="input"
          value={label}
          onChange={(event) => setLabel(event.target.value)}
        />
        <span className="field__hint">How it appears in the model picker.</span>
      </div>

      {provider.needsKey ? (
        <div className="field">
          <label className="field__label" htmlFor="conn-key">
            API key
          </label>
          <input
            id="conn-key"
            className="input"
            type="password"
            autoComplete="off"
            placeholder="sk-…"
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
          />
          <span className="field__hint">
            Stored on this device only, and sent only to {provider.label}.
          </span>
        </div>
      ) : null}

      {provider.needsBaseUrl ? (
        <div className="field">
          <label className="field__label" htmlFor="conn-url">
            Server address
          </label>
          <input
            id="conn-url"
            className="input"
            inputMode="url"
            placeholder={provider.defaultBaseUrl}
            value={baseUrl}
            onChange={(event) => setBaseUrl(event.target.value)}
          />
          <span className="field__hint">
            A phone cannot reach <code>localhost</code> on your computer — use that machine’s
            address on the network.
          </span>
        </div>
      ) : null}

      <div className="field">
        <label className="field__label" htmlFor="conn-model">
          Default model
        </label>
        <input
          id="conn-model"
          className="input"
          placeholder={provider.defaultModel ?? 'Model id'}
          value={defaultModel}
          onChange={(event) => setDefaultModel(event.target.value)}
        />
      </div>
    </Sheet>
  );
}

/** `provider.id`'s `cli-` prefix stripped, the `cliId` the `Cli` plugin and `cli.ts`'s `SupportedCliId` both use. */
function cliIdFor(provider: ProviderDescriptor): string {
  return provider.id.replace(/^cli-/, '');
}

/**
 * The four failure states `CliDiscoverResult` can report, in plain words —
 * no jargon, no "sandboxed" (cli-specs.ts's own ruling on Codex's residual;
 * see `note` in `providers.ts`, rendered above this sheet's Find button).
 */
function discoveryMessage(result: CliDiscoverResult, label: string): string {
  switch (result.status) {
    case 'not-found':
      return `No ${label} binary was found on your PATH.`;
    case 'not-executable':
      return `Found a file at ${result.path}, but it is not executable.`;
    case 'version-unreadable':
      return `Found ${result.path}, but its version could not be read.`;
    case 'not-signed-in':
      return `Found ${result.path} (version ${result.version}), but it is not signed in. Sign in with ${label} itself, then Find again.`;
    case 'found':
      return `Found ${result.path} (version ${result.version}).`;
  }
}

/**
 * The Add sheet for a `local-cli` provider (#42, #115, #116).
 *
 * NOT `ConnectSheet`, on purpose: there is no key field, no base-URL field,
 * and no default-model field to type — the CLI is signed in on the user's
 * own behalf, outside this app, and `providers.ts`'s local-cli `load()`
 * ignores every field of the config those other fields would fill in. What
 * this sheet needs instead is an explicit "Find" (#116: never ambient —
 * nothing here probes for a binary until this button is pressed), which
 * calls the SAME `Cli.discover` the real backend never calls itself, and a
 * plain-words report of whichever of the four failure states (or the one
 * success state) it came back with. Add is disabled until that report says
 * `found`.
 *
 * NO "CHOOSE FILE…" OVERRIDE. The task that added this sheet asked for one,
 * "if the codebase already has a file picker on desktop" — there is a
 * FOLDER picker (`MountHost.pick()`, `apps/desktop/src/main.ts`'s
 * `dialog.showOpenDialog` with `properties: ['openDirectory']`, behind
 * #246's shell-mount grant flow), but no picker for a single FILE anywhere
 * in this codebase, and CLI discovery is deliberately PATH-based rather than
 * a path a user types or browses to (`apps/desktop/src/bridge/cli-discovery.ts`).
 * Building a new file-picker plugin, wiring it through a `contextBridge`
 * boundary, and deciding what confinement rule applies to an arbitrary
 * chosen binary is real, undone work outside this unit's scope — so this is
 * skipped, noted here rather than silently, and Find-by-PATH is the only way
 * in for now.
 */
function CliConnectSheet({
  provider,
  onClose,
}: {
  provider: ProviderDescriptor;
  onClose: () => void;
}): ReactNode {
  const desktop = capabilities().cliAgents;
  const cliId = cliIdFor(provider);
  const [label, setLabel] = useState(provider.label);
  const [finding, setFinding] = useState(false);
  const [result, setResult] = useState<CliDiscoverResult | null>(null);

  const ready = desktop && result?.status === 'found' && label.trim().length > 0;

  const find = (): void => {
    setFinding(true);
    void Cli.discover({ cliId })
      .then((discovered) => setResult(discovered))
      .finally(() => setFinding(false));
  };

  return (
    <Sheet
      open
      title={`Add ${provider.label}`}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn--secondary grow" onClick={onClose}>
            Cancel
          </button>
          {desktop ? (
            <button
              type="button"
              className="btn btn--remote grow"
              disabled={!ready}
              onClick={() => {
                const connection: ProviderConnection = {
                  id: newId('conn'),
                  providerId: provider.id,
                  label: label.trim(),
                  apiKey: '',
                  baseUrl: '',
                  defaultModel: '',
                  enabled: true,
                  models: [],
                  createdAt: Date.now(),
                };
                void useApp.getState().addConnection(connection);
                onClose();
              }}
            >
              Add
            </button>
          ) : null}
        </>
      }
    >
      <div className="card card--remote">
        <div className="row" style={{ gap: 'var(--s-2)' }}>
          <Icon name="cloud" size={16} />
          <span className="card__title grow">What this means</span>
        </div>
        <p style={{ fontSize: 'var(--t-sm)', color: 'var(--ink-2)' }}>{provider.note}</p>
      </div>

      {desktop ? (
        <>
          <div className="field">
            <label className="field__label" htmlFor="cli-conn-label">
              Name
            </label>
            <input
              id="cli-conn-label"
              className="input"
              value={label}
              onChange={(event) => setLabel(event.target.value)}
            />
            <span className="field__hint">How it appears in the model picker.</span>
          </div>

          <div className="field">
            <button
              type="button"
              className="btn btn--secondary"
              disabled={finding}
              onClick={find}
            >
              {finding ? 'Finding…' : 'Find'}
            </button>
            <span className="field__hint">
              Looks for a {cliId} binary on your PATH — nothing is checked until you press this.
            </span>
            {result ? (
              <p role="status" style={{ fontSize: 'var(--t-sm)', color: 'var(--ink-2)' }}>
                {discoveryMessage(result, provider.label)}
              </p>
            ) : null}
          </div>
        </>
      ) : (
        <p className="section__hint">
          {provider.label} runs as a subprocess on this device, so adding it needs the desktop
          app — this platform cannot spawn one.
        </p>
      )}
    </Sheet>
  );
}
