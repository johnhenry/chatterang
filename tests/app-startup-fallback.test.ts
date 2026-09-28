/**
 * `useApp.getState().initialize()`'s startup ordering bug (#42, #115, round
 * 6, HIGH): the persisted `settings.fallbackBackendId` is handed to
 * `ChatterangEngine`'s constructor BEFORE the `connectProvider` loop runs
 * for any connection at all, so at construction time nothing yet knows a
 * stored id names a local-cli connection. `ChatterangEngine`'s own defences
 * (`tests/engine.test.ts`'s "a local-cli connection is never
 * fallback-eligible" block) stop that value from ever being ACTED on, but
 * this file measures the separate, visible half the coordinator's fix
 * asked for: the PERSISTED setting itself gets corrected, with a note the
 * user can see, rather than silently living on to confuse the next launch.
 */

import { describe, expect, it, vi } from 'vitest';

import type { ProviderConnection } from '@/ai/providers';

const tables = vi.hoisted(() => ({
  connections: {
    put: vi.fn(async () => {}),
    delete: vi.fn(async () => {}),
    toArray: vi.fn(async (): Promise<ProviderConnection[]> => []),
  },
  settings: {
    get: vi.fn(async (): Promise<unknown> => undefined),
    put: vi.fn(async () => {}),
  },
}));

const writeSettingMock = vi.fn(async () => {});

vi.mock('@/db', () => ({
  db: tables,
  deleteChat: vi.fn(async () => {}),
  readSetting: async (_key: string, fallback: unknown) => tables.settings.get() ?? fallback,
  writeSetting: writeSettingMock,
}));

const { useApp } = await import('@/state/app');

const CLAUDE_CLI: ProviderConnection = {
  id: 'conn_cli_claude',
  providerId: 'cli-claude',
  label: 'Claude Code',
  apiKey: '',
  baseUrl: '',
  defaultModel: '',
  enabled: true,
  models: [],
  createdAt: 0,
};

const OPENAI: ProviderConnection = {
  id: 'conn_openai',
  providerId: 'openai',
  label: 'OpenAI',
  apiKey: 'sk-test',
  baseUrl: '',
  defaultModel: 'gpt-4o-mini',
  enabled: false, // disabled, so `initialize`'s connectProvider loop skips it
  models: [],
  createdAt: 0,
};

describe('startup order: a persisted fallback naming a local-cli connection', () => {
  it('clears the persisted setting and warns, rather than leaving a stale CLI id in place', async () => {
    tables.settings.get.mockResolvedValue({ fallbackBackendId: 'conn_cli_claude' });
    tables.connections.toArray.mockResolvedValue([CLAUDE_CLI]);
    writeSettingMock.mockClear();

    useApp.setState({ ready: false, toasts: [], connections: [], engine: null });
    await useApp.getState().initialize();

    // The persisted setting itself is corrected, not merely refused at the
    // engine -- this is the "app.ts clears the persisted setting" half of
    // the fix, checked independently of the engine's own defences.
    expect(useApp.getState().settings.fallbackBackendId).toBeNull();
    expect(useApp.getState().engine?.fallbackBackendId).toBeNull();
    expect(writeSettingMock).toHaveBeenCalledWith(
      'settings',
      expect.objectContaining({ fallbackBackendId: null }),
    );

    // And the correction is VISIBLE, not silent -- the coordinator's own
    // requirement.
    const toasts = useApp.getState().toasts;
    expect(toasts.some((toast) => toast.message.includes('Claude Code'))).toBe(true);
    expect(toasts.some((toast) => toast.message.includes('local agent CLI'))).toBe(true);
  });

  it('leaves an ordinary remote provider fallback untouched, the paired control', async () => {
    tables.settings.get.mockResolvedValue({ fallbackBackendId: 'conn_openai' });
    tables.connections.toArray.mockResolvedValue([{ ...OPENAI, enabled: true }]);
    writeSettingMock.mockClear();

    useApp.setState({ ready: false, toasts: [], connections: [], engine: null });
    await useApp.getState().initialize();

    expect(useApp.getState().settings.fallbackBackendId).toBe('conn_openai');
    expect(writeSettingMock).not.toHaveBeenCalledWith(
      'settings',
      expect.objectContaining({ fallbackBackendId: null }),
    );
  });

  it('leaves a null fallback untouched -- nothing to correct, nothing to warn about', async () => {
    tables.settings.get.mockResolvedValue({ fallbackBackendId: null });
    tables.connections.toArray.mockResolvedValue([CLAUDE_CLI]);
    writeSettingMock.mockClear();

    useApp.setState({ ready: false, toasts: [], connections: [], engine: null });
    await useApp.getState().initialize();

    expect(useApp.getState().settings.fallbackBackendId).toBeNull();
    expect(writeSettingMock).not.toHaveBeenCalled();
    expect(useApp.getState().toasts).toHaveLength(0);
  });

  it('leaves a fallback naming a connection that no longer exists untouched -- the ordinary missing-connection case, not this one', async () => {
    tables.settings.get.mockResolvedValue({ fallbackBackendId: 'conn_gone' });
    tables.connections.toArray.mockResolvedValue([]);
    writeSettingMock.mockClear();

    useApp.setState({ ready: false, toasts: [], connections: [], engine: null });
    await useApp.getState().initialize();

    // Not this fix's business: a missing connection is a different failure
    // mode `#resolveFallback`'s ordinary `router.get(id)` miss already
    // handles, not something to warn about at startup.
    expect(useApp.getState().settings.fallbackBackendId).toBe('conn_gone');
    expect(writeSettingMock).not.toHaveBeenCalled();
  });
});
