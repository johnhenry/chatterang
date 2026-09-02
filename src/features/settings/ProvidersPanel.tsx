import { useState, type ReactNode } from 'react';

import { Icon } from '@/ui/Icon';
import { Confirm, Sheet, Switch } from '@/ui/primitives';
import { PROVIDERS, type ProviderConnection, type ProviderDescriptor } from '@/ai/providers';
import { newId } from '@/domain/chat';
import { useApp } from '@/state/app';

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

  const [adding, setAdding] = useState<ProviderDescriptor | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<ProviderConnection | null>(null);

  const grouped = {
    'self-hosted': PROVIDERS.filter((provider) => provider.kind === 'self-hosted'),
    cloud: PROVIDERS.filter((provider) => provider.kind === 'cloud'),
    aggregator: PROVIDERS.filter((provider) => provider.kind === 'aggregator'),
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
                    onChange={(enabled) =>
                      void useApp.getState().toggleConnection(connection.id, enabled)
                    }
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
                .map((connection) => (
                  <option key={connection.id} value={connection.id}>
                    {connection.label}
                  </option>
                ))}
            </select>
          </div>
        </div>
      ) : null}

      <ProviderGroup
        title="On your own network"
        hint="Requests stay inside your network."
        providers={grouped['self-hosted']}
        onPick={setAdding}
      />
      {/* "Messages you send leave your device" was too narrow: tool output is
          not a message the user sent, and it travels in the same request. */}
      <ProviderGroup
        title="Cloud providers"
        hint="Messages you send leave your device — and, if you allow it, what a tool read."
        providers={grouped.cloud}
        onPick={setAdding}
      />
      <ProviderGroup
        title="Aggregators"
        hint="Forwards your request to whichever provider serves the model."
        providers={grouped.aggregator}
        onPick={setAdding}
      />

      {adding ? <ConnectSheet provider={adding} onClose={() => setAdding(null)} /> : null}

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
                <span className="list__sub">{provider.note}</span>
              </div>
              <Icon name="plus" size={16} />
            </button>
          ))}
        </div>
      </div>
    </div>
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
        <p style={{ fontSize: 'var(--t-sm)', color: 'var(--ink-2)' }}>{provider.note}</p>
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
