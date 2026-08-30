import { useState, type ReactNode } from 'react';

import { Icon } from '@/ui/Icon';
import { Confirm, Sheet, Switch } from '@/ui/primitives';
import { destinationHost, type McpServerConfig } from '@/domain/mcp';
import { useMcp } from '@/state/mcp';

/**
 * Remote MCP servers.
 *
 * The framing matters as much as the fields. Everything else in this app runs
 * on the device; an MCP server is the deliberate exception, and the panel says
 * so before it asks for a URL rather than after.
 */
export function McpPanel(): ReactNode {
  const servers = useMcp((state) => state.servers);
  const states = useMcp((state) => state.states);
  const connecting = useMcp((state) => state.connecting);
  const add = useMcp((state) => state.add);
  const remove = useMcp((state) => state.remove);
  const toggle = useMcp((state) => state.toggle);

  const [adding, setAdding] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState<McpServerConfig | null>(null);
  const [form, setForm] = useState({ name: '', url: '', token: '' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(): Promise<void> {
    setBusy(true);
    const reason = await add(form);
    setBusy(false);
    if (reason) {
      setError(reason);
      return;
    }
    setForm({ name: '', url: '', token: '' });
    setError(null);
    setAdding(false);
  }

  return (
    <>
      <div className="section">
        <div className="section__head">
          <h2>MCP servers</h2>
          {connecting ? <span className="spinner" /> : null}
        </div>
        <p className="section__hint">
          An MCP server adds tools the model can call — issue trackers, databases, your own
          services. They run on someone else’s machine, so calling one{' '}
          <strong>sends the arguments off this device</strong>. Every MCP tool has to be turned
          on per chat, and anything that can change data asks first.
        </p>

        {servers.length > 0 ? (
          <div className="card card--flush">
            <div className="list">
              {servers.map((server) => {
                const state = states[server.id];
                return (
                  <div className="list__row" key={server.id}>
                    <div className="list__main">
                      <span className="list__title">{server.name}</span>
                      <span className="list__sub">
                        {destinationHost(server.url)}
                        {state?.status === 'ready' ? ` · ${state.toolCount} tools` : null}
                        {state?.status === 'connecting' ? ' · connecting…' : null}
                        {state?.status === 'error' ? ` · ${state.error ?? 'unreachable'}` : null}
                      </span>
                    </div>
                    <Switch
                      checked={server.enabled}
                      onChange={(next) => void toggle(server.id, next)}
                      label={`Enable ${server.name}`}
                    />
                    <button
                      type="button"
                      className="icon-btn"
                      aria-label={`Remove ${server.name}`}
                      onClick={() => setConfirmRemove(server)}
                    >
                      <Icon name="trash" size={16} />
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        ) : null}

        <button type="button" className="btn btn--ghost" onClick={() => setAdding(true)}>
          <Icon name="plus" size={16} />
          Add a server
        </button>
      </div>

      <Sheet open={adding} title="Add an MCP server" onClose={() => setAdding(false)}>
        <p className="section__hint">
          Tools from this server will be able to receive parts of your conversation. Only add
          servers you trust with that.
        </p>

        <label className="field">
          <span className="field__label">Name</span>
          <input
            className="input"
            value={form.name}
            placeholder="acme"
            autoCapitalize="none"
            autoCorrect="off"
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
          <span className="field__hint">
            Short handle. Its tools appear as <code>{form.name.trim() || 'name'}.tool</code>.
          </span>
        </label>

        <label className="field">
          <span className="field__label">URL</span>
          <input
            className="input"
            value={form.url}
            placeholder="https://api.example.com/mcp"
            inputMode="url"
            autoCapitalize="none"
            autoCorrect="off"
            onChange={(e) => setForm({ ...form, url: e.target.value })}
          />
          <span className="field__hint">Streamable HTTP endpoint. https only.</span>
        </label>

        <label className="field">
          <span className="field__label">Token (optional)</span>
          <input
            className="input"
            type="password"
            value={form.token}
            autoCapitalize="none"
            autoCorrect="off"
            onChange={(e) => setForm({ ...form, token: e.target.value })}
          />
          <span className="field__hint">
            Sent as a bearer token. Stored on this device and never shown again.
          </span>
        </label>

        {error ? <p className="field__error">{error}</p> : null}

        <button type="button" className="btn" disabled={busy} onClick={() => void submit()}>
          {busy ? 'Connecting…' : 'Add server'}
        </button>
      </Sheet>

      <Confirm
        open={confirmRemove !== null}
        title="Remove this server?"
        body={
          confirmRemove
            ? `“${confirmRemove.name}” and its tools will be removed from this device. Nothing on ${destinationHost(confirmRemove.url)} changes.`
            : ''
        }
        confirmLabel="Remove"
        onCancel={() => setConfirmRemove(null)}
        onConfirm={() => {
          if (confirmRemove) void remove(confirmRemove.id);
          setConfirmRemove(null);
        }}
      />
    </>
  );
}
