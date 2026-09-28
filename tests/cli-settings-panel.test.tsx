/**
 * The "Local CLIs" section of `ProvidersPanel` (#42, #115, #116).
 *
 * Measures the four things the task asked for: the section is explained
 * (never silently missing) on a non-desktop platform; "Find" calls the
 * `Cli` plugin's `discover` and nothing else, and only when pressed (#116:
 * explicit add, never ambient); the four failure states plus the one
 * success state are reported in plain words, never "sandboxed"; and Add
 * creates a `local-cli` connection, gated on a successful Find, persisted
 * and removable the same way every other connection is.
 */

import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CliDiscoverResult } from '@/plugins/cli';

vi.mock('@/db', () => ({
  db: {
    connections: { put: vi.fn(async () => {}), delete: vi.fn(async () => {}), toArray: async () => [] },
    models: { put: vi.fn(async () => {}), delete: vi.fn(async () => {}), toArray: async () => [] },
    settings: { get: vi.fn(async () => undefined), put: vi.fn(async () => {}) },
    benchmarks: {
      put: vi.fn(async () => {}),
      delete: vi.fn(async () => {}),
      clear: vi.fn(async () => {}),
      orderBy: () => ({ reverse: () => ({ toArray: async () => [] }) }),
    },
  },
  deleteChat: vi.fn(async () => {}),
  readSetting: async (_key: string, fallback: unknown) => fallback,
  writeSetting: vi.fn(async () => {}),
}));

const cli = vi.hoisted(() => ({
  discover: vi.fn<(request: { cliId: string }) => Promise<CliDiscoverResult>>(),
}));

vi.mock('@/plugins/cli', () => ({
  Cli: {
    discover: cli.discover,
    startTurn: vi.fn(),
    cancelTurn: vi.fn(),
    addListener: vi.fn(async () => ({ remove: async () => {} })),
  },
}));

const platform = vi.hoisted(() => ({ cliAgents: false }));

vi.mock('@/lib/platform', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/platform')>();
  return {
    ...actual,
    capabilities: () => ({ ...actual.capabilities(), cliAgents: platform.cliAgents }),
  };
});

const { ProvidersPanel } = await import('@/features/settings/ProvidersPanel');
const { useApp } = await import('@/state/app');

async function mounted(body: (host: HTMLElement) => Promise<void> | void): Promise<void> {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => {
      root.render(createElement(ProvidersPanel));
    });
    await body(host);
  } finally {
    await act(async () => {
      root.unmount();
    });
    host.remove();
  }
}

function findItem(host: HTMLElement, label: string): HTMLElement {
  const item = [...host.querySelectorAll<HTMLElement>('button.list__item')].find(
    (button) => button.querySelector('.list__title')?.textContent === label,
  );
  if (!item) throw new Error(`no list item for "${label}"`);
  return item;
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  platform.cliAgents = false;
  cli.discover.mockReset();
  useApp.setState({ connections: [], pendingConnections: [], engine: null });
});

afterEach(() => {
  useApp.setState({ connections: [], pendingConnections: [], engine: null });
});

describe('the Local CLIs section, on a non-desktop platform', () => {
  it('is explained, never missing, and offers no Find or Add', async () => {
    await mounted(async (host) => {
      const item = findItem(host, 'Claude Code');
      expect(item.textContent).toContain('Chatterang never sees or stores a key');

      await act(async () => {
        item.click();
      });

      expect(document.body.textContent).toContain('available in the desktop app only');
      expect(document.body.textContent).not.toContain('>Find<');
      // No "Add" button rendered for this sheet at all.
      const addButtons = [...document.body.querySelectorAll('button')].filter(
        (button) => button.textContent === 'Add',
      );
      expect(addButtons).toHaveLength(0);
    });
  });
});

describe('the Local CLIs section, on the desktop platform', () => {
  beforeEach(() => {
    platform.cliAgents = true;
  });

  it('states plainly that adding it is the one-time consent (#42)', async () => {
    await mounted(async (host) => {
      const item = findItem(host, 'Claude Code');
      await act(async () => {
        item.click();
      });
      expect(document.body.textContent).toContain(
        'Adding it below is what allows this — there is no separate confirmation before your first message reaches Claude Code.',
      );
    });
  });

  it('calls discover only after Find is pressed, never ambiently', async () => {
    cli.discover.mockResolvedValue({ status: 'not-found', id: 'claude' });
    await mounted(async (host) => {
      const item = findItem(host, 'Claude Code');
      await act(async () => {
        item.click();
      });
      expect(cli.discover).not.toHaveBeenCalled();

      const findButton = [...document.body.querySelectorAll('button')].find((b) => b.textContent === 'Find');
      if (!findButton) throw new Error('no Find button');
      await act(async () => {
        findButton.click();
      });
      await flush();
      expect(cli.discover).toHaveBeenCalledTimes(1);
      expect(cli.discover).toHaveBeenCalledWith({ cliId: 'claude' });
    });
  });

  const cases: Array<{ result: CliDiscoverResult; expect: string }> = [
    { result: { status: 'not-found', id: 'claude' }, expect: 'No Claude Code binary was found on your PATH.' },
    {
      result: { status: 'not-executable', id: 'claude', path: '/usr/local/bin/claude' },
      expect: 'Found a file at /usr/local/bin/claude, but it is not executable.',
    },
    {
      result: { status: 'version-unreadable', id: 'claude', path: '/usr/local/bin/claude' },
      expect: 'Found /usr/local/bin/claude, but its version could not be read.',
    },
    {
      result: { status: 'not-signed-in', id: 'claude', path: '/usr/local/bin/claude', version: '2.1.0' },
      expect: 'Found /usr/local/bin/claude (version 2.1.0), but it is not signed in. Sign in with Claude Code itself, then Find again.',
    },
    {
      result: { status: 'found', id: 'claude', path: '/usr/local/bin/claude', version: '2.1.0' },
      expect: 'Found /usr/local/bin/claude (version 2.1.0).',
    },
  ];

  for (const { result, expect: message } of cases) {
    it(`reports "${result.status}" in plain words, and never as "sandboxed"`, async () => {
      cli.discover.mockResolvedValue(result);
      await mounted(async (host) => {
        const item = findItem(host, 'Claude Code');
        await act(async () => {
          item.click();
        });
        const findButton = [...document.body.querySelectorAll('button')].find((b) => b.textContent === 'Find');
        if (!findButton) throw new Error('no Find button');
        await act(async () => {
          findButton.click();
        });
        await flush();

        expect(document.body.textContent).toContain(message);
        expect(document.body.textContent?.toLowerCase()).not.toContain('sandbox');
      });
    });
  }

  it('disables Add until Find reports "found", then creates a local-cli connection', async () => {
    cli.discover.mockResolvedValue({ status: 'not-signed-in', id: 'codex', path: '/usr/bin/codex', version: '0.144.1' });
    await mounted(async (host) => {
      const item = findItem(host, 'Codex');
      await act(async () => {
        item.click();
      });
      const findButton = [...document.body.querySelectorAll('button')].find((b) => b.textContent === 'Find');
      if (!findButton) throw new Error('no Find button');
      await act(async () => {
        findButton.click();
      });
      await flush();

      const addButton = [...document.body.querySelectorAll('button')].find((b) => b.textContent === 'Add') as
        | HTMLButtonElement
        | undefined;
      if (!addButton) throw new Error('no Add button');
      expect(addButton.disabled).toBe(true);

      cli.discover.mockResolvedValue({ status: 'found', id: 'codex', path: '/usr/bin/codex', version: '0.144.1' });
      await act(async () => {
        findButton.click();
      });
      await flush();
      expect(addButton.disabled).toBe(false);

      await act(async () => {
        addButton.click();
      });
      await flush();

      const connections = useApp.getState().connections;
      expect(connections).toHaveLength(1);
      expect(connections[0]?.providerId).toBe('cli-codex');
      expect(connections[0]?.apiKey).toBe('');
      expect(connections[0]?.baseUrl).toBe('');
      expect(connections[0]?.enabled).toBe(true);
    });
  });

  it('removes a local-cli connection the same way every other connection is removed', async () => {
    useApp.setState({
      connections: [
        {
          id: 'conn_cli_claude',
          providerId: 'cli-claude',
          label: 'Claude Code',
          apiKey: '',
          baseUrl: '',
          defaultModel: '',
          enabled: true,
          models: [],
          createdAt: 0,
        },
      ],
    });
    await mounted(async (host) => {
      const removeButton = host.querySelector<HTMLButtonElement>('[aria-label="Remove Claude Code"]');
      expect(removeButton).not.toBeNull();
      await act(async () => {
        removeButton?.click();
      });
      const confirmButton = [...document.body.querySelectorAll('button')].find((b) => b.textContent === 'Remove');
      if (!confirmButton) throw new Error('no confirm button');
      await act(async () => {
        confirmButton.click();
      });
      await flush();
      expect(useApp.getState().connections).toHaveLength(0);
    });
  });

  it('never offers a local-cli connection in the cloud-pressure fallback dropdown', async () => {
    useApp.setState({
      connections: [
        {
          id: 'conn_cli_claude',
          providerId: 'cli-claude',
          label: 'Claude Code',
          apiKey: '',
          baseUrl: '',
          defaultModel: '',
          enabled: true,
          models: [],
          createdAt: 0,
        },
        {
          id: 'conn_openai',
          providerId: 'openai',
          label: 'OpenAI',
          apiKey: 'sk-x',
          baseUrl: '',
          defaultModel: 'gpt-4o-mini',
          enabled: true,
          models: [],
          createdAt: 0,
        },
      ],
    });
    await mounted(async (host) => {
      const select = host.querySelector<HTMLSelectElement>('[aria-label="Fallback provider"]');
      if (!select) throw new Error('no fallback select');
      const optionLabels = [...select.options].map((option) => option.textContent);
      expect(optionLabels).toContain('OpenAI');
      expect(optionLabels).not.toContain('Claude Code');
    });
  });
});
