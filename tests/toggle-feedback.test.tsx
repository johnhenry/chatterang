/**
 * A REFUSED SWITCH-ON IS NOT SILENT (#315).
 *
 * `toggleConnection` (state/app.ts) and `useMcp.toggle` (state/mcp.ts) can
 * reject — a launch write that drops a stale grant, or the switch's own
 * write, can fail — and the only UI callers used to do `void toggle(...)`:
 * no catch, no toast, and no pending state while the write was in flight. A
 * person clicking the switch saw it stay off (or on) with nothing said, and a
 * second click while the first was still running queued a second write.
 *
 * This drives the REAL `ProvidersPanel` and `McpPanel` over the real stores,
 * with `db.connections.put` / `db.mcpServers.update` held open by hand so the
 * pending state and the eventual toast are measured against the actual
 * write's timing, not assumed.
 */

import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const tables = vi.hoisted(() => ({
  models: { put: vi.fn(async () => {}), delete: vi.fn(async () => {}), toArray: async () => [] },
  settings: { get: vi.fn(async () => undefined), put: vi.fn(async () => {}) },
  chats: { put: vi.fn(async () => {}), delete: vi.fn(async () => {}), toArray: async () => [] },
  messages: {
    put: vi.fn(async () => {}),
    delete: vi.fn(async () => {}),
    where: () => ({ equals: () => ({ sortBy: async () => [], toArray: async () => [] }) }),
  },
  benchmarks: {
    put: vi.fn(async () => {}),
    delete: vi.fn(async () => {}),
    clear: vi.fn(async () => {}),
    orderBy: () => ({ reverse: () => ({ toArray: async () => [] }) }),
  },
  connections: { put: vi.fn(async () => {}), delete: vi.fn(async () => {}), toArray: async () => [] },
  mcpServers: {
    put: vi.fn(async () => {}),
    delete: vi.fn(async () => {}),
    update: vi.fn(async () => 1),
    orderBy: () => ({ toArray: async () => [] }),
    toArray: async () => [],
  },
}));

vi.mock('@/db', () => ({
  db: tables,
  deleteChat: vi.fn(async () => {}),
  readSetting: async (_key: string, fallback: unknown) => fallback,
  writeSetting: vi.fn(async () => {}),
}));

// The network boundary for MCP: nothing here calls a real server.
vi.mock('@/ai/mcp/client', () => ({
  mcpManager: {
    configure: vi.fn(async () => {}),
    listTools: vi.fn(async () => []),
    callTool: vi.fn(async () => ({ content: [] })),
  },
}));

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { useApp } = await import('@/state/app');
const { useMcp } = await import('@/state/mcp');
const { ProvidersPanel } = await import('@/features/settings/ProvidersPanel');
const { McpPanel } = await import('@/features/settings/McpPanel');
type ProviderConnection = import('@/ai/providers').ProviderConnection;
type McpServerConfig = import('@/domain/mcp').McpServerConfig;

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** A promise this test controls the settlement of, plus a way to resolve or reject it. */
function gate(): { promise: Promise<void>; resolve: () => void; reject: (error: Error) => void } {
  let resolve = (): void => {};
  let reject = (_error: Error): void => {};
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = (error: Error) => rej(error);
  });
  return { promise, resolve, reject };
}

const OPENAI: ProviderConnection = {
  id: 'conn_openai',
  providerId: 'openai',
  label: 'OpenAI',
  apiKey: '',
  baseUrl: '',
  defaultModel: 'gpt-4o-mini',
  enabled: false,
  models: [],
  createdAt: 0,
};

const NOTES: McpServerConfig = {
  id: 'mcp_notes',
  name: 'notes',
  url: 'https://notes.example/mcp',
  enabled: false,
  createdAt: 0,
};

let host: HTMLDivElement | null = null;
let root: import('react-dom/client').Root | null = null;

async function render(tree: ReturnType<typeof createElement>): Promise<void> {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(tree);
  });
}

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  vi.restoreAllMocks();
});

const switchFor = (label: string): HTMLButtonElement => {
  const element = document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  if (!element) throw new Error(`no switch for ${label}`);
  return element;
};

describe('a connection switch-on that the store refuses (#315)', () => {
  it('disables the switch while the write is in flight, and toasts the refusal rather than staying silent', async () => {
    useApp.setState({ connections: [{ ...OPENAI }], toasts: [], pendingConnections: [] });
    const write = gate();
    vi.mocked(tables.connections.put).mockImplementationOnce(() => write.promise as never);

    await render(createElement(ProvidersPanel));
    const control = switchFor('Enable OpenAI');
    expect(control.disabled, 'the control: not pending yet').toBe(false);
    expect(control.getAttribute('aria-checked')).toBe('false');

    await act(async () => {
      control.click();
    });

    // PENDING WHILE THE WRITE WAITS. Before this, nothing disabled the switch
    // and a second click here queued a second switch-on.
    expect(control.disabled, 'the switch, while its write is in flight').toBe(true);
    expect(useApp.getState().pendingConnections).toEqual(['conn_openai']);
    expect(useApp.getState().toasts, 'nothing said yet').toEqual([]);

    await act(async () => {
      write.reject(new Error('The disk is full.'));
      // Let the rejection propagate through toggleConnection and the panel's catch.
      await Promise.resolve().then(() => Promise.resolve());
    });

    // REFUSED, AND SAID SO. The switch goes back to reflecting the store — off,
    // since the write never landed — is no longer disabled, and a toast names
    // the failure instead of the switch just silently staying off.
    expect(control.disabled, 'pending clears once the write has settled').toBe(false);
    expect(control.getAttribute('aria-checked'), 'the store: switch-on never landed').toBe('false');
    expect(useApp.getState().connections[0]?.enabled).toBe(false);
    const toasts = useApp.getState().toasts;
    expect(toasts, 'the refusal is surfaced').toHaveLength(1);
    expect(toasts[0]?.tone).toBe('crit');
    expect(toasts[0]?.message).toContain('disk is full');
  });

  it('leaves the switch enabled and untouched when the write succeeds', async () => {
    useApp.setState({ connections: [{ ...OPENAI }], toasts: [], pendingConnections: [] });

    await render(createElement(ProvidersPanel));
    const control = switchFor('Enable OpenAI');

    await act(async () => {
      control.click();
    });

    expect(control.disabled).toBe(false);
    expect(control.getAttribute('aria-checked')).toBe('true');
    expect(useApp.getState().pendingConnections).toEqual([]);
    expect(useApp.getState().toasts).toEqual([]);
  });
});

describe('an MCP server switch-on that the store refuses (#315)', () => {
  it('disables the switch while the write is in flight, and toasts the refusal rather than staying silent', async () => {
    useMcp.setState({ servers: [{ ...NOTES }], states: {}, pendingServers: [] });
    useApp.setState({ toasts: [] });
    const write = gate();
    vi.mocked(tables.mcpServers.update).mockImplementationOnce(() => write.promise as never);

    await render(createElement(McpPanel));
    const control = switchFor('Enable notes');
    expect(control.disabled).toBe(false);

    await act(async () => {
      control.click();
    });

    expect(control.disabled, 'the switch, while its write is in flight').toBe(true);
    expect(useMcp.getState().pendingServers).toEqual(['mcp_notes']);
    expect(useApp.getState().toasts).toEqual([]);

    await act(async () => {
      write.reject(new Error('The disk is full.'));
      await Promise.resolve().then(() => Promise.resolve());
    });

    expect(control.disabled, 'pending clears once the write has settled').toBe(false);
    expect(control.getAttribute('aria-checked'), 'the store: switch-on never landed').toBe('false');
    expect(useMcp.getState().servers[0]?.enabled).toBe(false);
    const toasts = useApp.getState().toasts;
    expect(toasts, 'the refusal is surfaced').toHaveLength(1);
    expect(toasts[0]?.tone).toBe('crit');
    expect(toasts[0]?.message).toContain('disk is full');
  });
});
