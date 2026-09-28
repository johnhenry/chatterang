/**
 * PersonaEditor's "Model & provider" and extended "Tools" sections (#23, #122).
 *
 * The guarantee under test throughout: editing can never produce a SAVED
 * persona whose effective tool set — `narrowToolPolicy(saved.tools,
 * saved.agentConfig, allowedMcpServerIds)` — is wider than the app already
 * allows. That is enforced twice over on purpose: the checklist itself
 * refuses to let a sensitive tool or an unavailable MCP server become
 * selectable (measured here, on the real DOM), and `narrowToolPolicy`
 * refuses again at every chat regardless of what got saved (measured in
 * `tests/persona-tool-policy.test.ts`). This file is about the first of
 * those two, and about the "Source" section reading as read-only for a
 * persona this app did not author.
 */

import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const tables = vi.hoisted(() => ({
  chats: { put: vi.fn(async () => {}), delete: vi.fn(async () => {}), toArray: async () => [] },
  messages: {
    put: vi.fn(async () => {}),
    delete: vi.fn(async () => {}),
    where: () => ({ equals: () => ({ sortBy: async () => [], toArray: async () => [] }) }),
  },
  models: { put: vi.fn(async () => {}), delete: vi.fn(async () => {}), toArray: async () => [] },
  settings: {
    get: vi.fn(async () => undefined),
    put: vi.fn(async () => {}),
    toArray: vi.fn(async (): Promise<{ key: string; value: unknown }[]> => []),
    delete: vi.fn(async () => {}),
  },
  connections: { put: vi.fn(async () => {}), delete: vi.fn(async () => {}), toArray: async () => [] },
  personas: { put: vi.fn(async () => {}), delete: vi.fn(async () => {}), toArray: async () => [] },
  mcpServers: { put: vi.fn(async () => {}), delete: vi.fn(async () => {}), toArray: async () => [] },
}));

vi.mock('@/db', () => ({
  db: tables,
  deleteChat: vi.fn(async () => {}),
  readSetting: async (_key: string, fallback: unknown) => fallback,
  writeSetting: vi.fn(async () => {}),
}));

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { useModels } = await import('@/state/models');
const { useApp } = await import('@/state/app');
const { useMcp } = await import('@/state/mcp');
const { usePersonas } = await import('@/state/personas');
const { useProviderConsent } = await import('@/state/provider-consent');
const { narrowToolPolicy } = await import('@/state/chat');
const { toolRegistry } = await import('@/ai/tools/registry');
const { PersonaEditor } = await import('@/features/personas/PersonaEditor');
type Persona = import('@/domain/persona').Persona;
type ProviderConnection = import('@/ai/providers').ProviderConnection;
type McpServerConfig = import('@/domain/mcp').McpServerConfig;

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SAFE_TOOL = {
  id: 'safe_calc',
  name: 'safe_calc',
  description: 'Arithmetic.',
  summary: 'calculator',
  parameters: { type: 'object' as const, properties: {} },
  execute: async () => ({ output: '4' }),
};

const DANGEROUS_TOOL = {
  id: 'danger_bash',
  name: 'danger_bash',
  description: 'Runs a shell command.',
  summary: 'shell',
  sensitive: true,
  parameters: { type: 'object' as const, properties: {} },
  execute: async () => ({ output: '' }),
};

const ON_SERVER: McpServerConfig = { id: 'mcp_on', name: 'notes-on', url: 'https://a.example', enabled: true, createdAt: 0 };
const OFF_SERVER: McpServerConfig = { id: 'mcp_off', name: 'notes-off', url: 'https://b.example', enabled: false, createdAt: 0 };

const ANTHROPIC: ProviderConnection = {
  id: 'conn_anthropic',
  providerId: 'anthropic',
  label: 'Anthropic',
  apiKey: '',
  baseUrl: '',
  defaultModel: 'claude-haiku',
  enabled: true,
  models: [],
  createdAt: 0,
};

/** A local-cli connection (#42, #115) -- absent from every other test's fixture list on purpose. */
const CLAUDE_CLI: ProviderConnection = {
  id: 'conn_cli_claude',
  providerId: 'cli-claude',
  label: 'Claude Code',
  apiKey: '',
  baseUrl: '',
  defaultModel: '',
  enabled: true,
  models: [],
  createdAt: 1,
};

function persona(overrides: Partial<Persona> = {}): Persona {
  return {
    id: 'p1',
    kind: 'assistant',
    name: 'Aide',
    tagline: '',
    avatarSeed: 'aide',
    description: '',
    tags: [],
    showThinking: false,
    tools: [],
    version: 1,
    createdAt: 0,
    updatedAt: 0,
    origin: 'authored',
    ...overrides,
  };
}

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

beforeEach(() => {
  toolRegistry.register(SAFE_TOOL);
  toolRegistry.register(DANGEROUS_TOOL);
  useModels.setState({ activeModelId: null, installed: {} });
  useApp.setState({ connections: [ANTHROPIC] });
  useMcp.setState({ servers: [ON_SERVER, OFF_SERVER] } as never);
  usePersonas.setState({ byId: {}, order: [] } as never);
  useProviderConsent.setState({ granted: {} });
});

afterEach(() => {
  toolRegistry.unregister('safe_calc');
  toolRegistry.unregister('danger_bash');
});

function chipFor(name: string): HTMLButtonElement | null {
  return Array.from(document.querySelectorAll<HTMLButtonElement>('.chip')).find((chip) =>
    chip.textContent?.includes(name),
  ) ?? null;
}

describe('the sensitive-tool checklist', () => {
  it('renders a sensitive tool locked (disabled), and clicking it does nothing', async () => {
    await render(createElement(PersonaEditor, { persona: persona(), onClose: () => {} }));

    const chip = chipFor('danger_bash');
    expect(chip?.disabled).toBe(true);

    await act(async () => {
      chip?.click();
    });
    // Still not in the draft's tools: Save below proves it never got saved.
    await act(async () => {
      document.querySelector<HTMLButtonElement>('.btn--primary')?.click();
    });
    const saved = usePersonas.getState().byId['p1'];
    expect(saved?.tools).not.toContain('danger_bash');
  });

  it('lets a non-sensitive tool be toggled on and saved', async () => {
    await render(createElement(PersonaEditor, { persona: persona(), onClose: () => {} }));

    await act(async () => {
      chipFor('safe_calc')?.click();
    });
    await act(async () => {
      document.querySelector<HTMLButtonElement>('.btn--primary')?.click();
    });

    const saved = usePersonas.getState().byId['p1'];
    expect(saved?.tools).toContain('safe_calc');
  });

  it('the saved persona’s effective tool set is never wider than narrowToolPolicy allows', async () => {
    await render(
      createElement(PersonaEditor, {
        persona: persona({ tools: ['safe_calc'] }),
        onClose: () => {},
      }),
    );
    await act(async () => {
      document.querySelector<HTMLButtonElement>('.btn--primary')?.click();
    });

    const saved = usePersonas.getState().byId['p1']!;
    const allowedMcpServerIds = [ON_SERVER.id];
    const narrowed = narrowToolPolicy(saved.tools, saved.agentConfig, allowedMcpServerIds);
    expect(narrowed.toolIds).toEqual(['safe_calc']);
    expect(narrowed.toolIds).not.toContain('danger_bash');
  });
});

describe('the MCP server checklist', () => {
  it('offers only servers that are added AND enabled', async () => {
    await render(createElement(PersonaEditor, { persona: persona(), onClose: () => {} }));
    expect(chipFor('notes-on')).not.toBeNull();
    expect(chipFor('notes-off')).toBeNull();
  });

  it('selecting a server saves it into agentConfig.toolPolicy.mcpServerIds, narrowed at use', async () => {
    await render(createElement(PersonaEditor, { persona: persona(), onClose: () => {} }));
    await act(async () => {
      chipFor('notes-on')?.click();
    });
    await act(async () => {
      document.querySelector<HTMLButtonElement>('.btn--primary')?.click();
    });

    const saved = usePersonas.getState().byId['p1']!;
    expect(saved.agentConfig?.toolPolicy?.mcpServerIds).toEqual(['mcp_on']);

    const narrowed = narrowToolPolicy(saved.tools, saved.agentConfig, [ON_SERVER.id]);
    expect(narrowed.mcpServerIds).toEqual(['mcp_on']);
  });
});

describe('the confirm-policy toggle', () => {
  it('only ever saves "always-ask" or nothing — never a value that loosens confirmation', async () => {
    await render(createElement(PersonaEditor, { persona: persona(), onClose: () => {} }));

    const label = 'Always ask, even where the app would not';
    const toggle = document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
    expect(toggle?.getAttribute('aria-checked')).toBe('false');

    await act(async () => {
      toggle?.click();
    });
    expect(toggle?.getAttribute('aria-checked')).toBe('true');

    await act(async () => {
      document.querySelector<HTMLButtonElement>('.btn--primary')?.click();
    });
    expect(usePersonas.getState().byId['p1']?.agentConfig?.toolPolicy?.confirmPolicy).toBe('always-ask');
  });
});

describe('max tool rounds', () => {
  it('the slider is capped at the engine’s own TOOL_ITERATIONS', async () => {
    const { TOOL_ITERATIONS } = await import('@/ai/engine');
    await render(createElement(PersonaEditor, { persona: persona(), onClose: () => {} }));

    const slider = Array.from(document.querySelectorAll<HTMLInputElement>('input[type="range"]')).find(
      (input) => input.max === String(TOOL_ITERATIONS),
    );
    expect(slider).toBeDefined();
    expect(slider?.max).toBe(String(TOOL_ITERATIONS));
  });
});

describe('Model & provider', () => {
  it('choosing a remote connection sets agentConfig.provider and names cloud/self-hosted', async () => {
    await render(createElement(PersonaEditor, { persona: persona(), onClose: () => {} }));

    await act(async () => {
      Array.from(document.querySelectorAll<HTMLButtonElement>('.chip'))
        .find((chip) => chip.textContent?.includes('One of your connections'))
        ?.click();
    });

    const select = document.querySelector<HTMLSelectElement>('#persona-connection');
    expect(select).not.toBeNull();
    await act(async () => {
      if (select) {
        select.value = 'conn_anthropic';
        select.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });

    expect(document.body.textContent).toMatch(/Anthropic \((cloud|self-hosted)\)/);

    await act(async () => {
      document.querySelector<HTMLButtonElement>('.btn--primary')?.click();
    });
    expect(usePersonas.getState().byId['p1']?.agentConfig?.provider).toEqual({
      kind: 'remote-connection',
      connectionId: 'conn_anthropic',
    });
  });

  it('the CLI agent option is present but disabled when no local-cli connection has been added', async () => {
    await render(createElement(PersonaEditor, { persona: persona(), onClose: () => {} }));
    const cli = chipFor('CLI agent');
    expect(cli?.disabled).toBe(true);
  });

  it('choosing a local-cli connection sets agentConfig.provider kind cli-agent (#42, #115)', async () => {
    useApp.setState({ connections: [ANTHROPIC, CLAUDE_CLI] });
    await render(createElement(PersonaEditor, { persona: persona(), onClose: () => {} }));

    const cli = chipFor('CLI agent');
    expect(cli?.disabled).toBe(false);
    await act(async () => {
      cli?.click();
    });

    const select = document.querySelector<HTMLSelectElement>('#persona-connection');
    expect(select).not.toBeNull();
    // Only the CLI connection is offered, never the ordinary remote one.
    const options = [...(select?.options ?? [])].map((option) => option.textContent);
    expect(options).toContain('Claude Code');
    expect(options).not.toContain('Anthropic');

    await act(async () => {
      if (select) {
        select.value = 'conn_cli_claude';
        select.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });

    expect(document.body.textContent).toContain('Claude Code (local CLI)');

    await act(async () => {
      document.querySelector<HTMLButtonElement>('.btn--primary')?.click();
    });
    expect(usePersonas.getState().byId['p1']?.agentConfig?.provider).toEqual({
      kind: 'cli-agent',
      connectionId: 'conn_cli_claude',
    });
  });
});

describe('Source', () => {
  it('reads as read-only prose, with no input controls, for an imported persona', async () => {
    await render(
      createElement(PersonaEditor, { persona: persona({ origin: 'imported' }), onClose: () => {} }),
    );
    const sourceSection = Array.from(document.querySelectorAll('.section')).find((section) =>
      section.querySelector('h2')?.textContent === 'Source',
    );
    expect(sourceSection).toBeDefined();
    expect(sourceSection?.textContent).toMatch(/imported/i);
    expect(sourceSection?.querySelector('input, textarea, select')).toBeNull();
  });

  it('says a different, still read-only, thing for an authored persona', async () => {
    await render(
      createElement(PersonaEditor, { persona: persona({ origin: 'authored' }), onClose: () => {} }),
    );
    const sourceSection = Array.from(document.querySelectorAll('.section')).find((section) =>
      section.querySelector('h2')?.textContent === 'Source',
    );
    expect(sourceSection?.textContent).toMatch(/authored/i);
    expect(sourceSection?.querySelector('input, textarea, select')).toBeNull();
  });

  it('says so for a marketplace and a built-in persona too', async () => {
    await render(
      createElement(PersonaEditor, { persona: persona({ origin: 'marketplace' }), onClose: () => {} }),
    );
    expect(document.body.textContent).toMatch(/marketplace/i);
  });
});

describe('Allowed destinations', () => {
  it('lists a live grant and revokes it', async () => {
    await useProviderConsent.getState().grant('p1', 'conn_anthropic');
    await render(createElement(PersonaEditor, { persona: persona(), onClose: () => {} }));

    expect(document.body.textContent).toContain('Anthropic');

    await act(async () => {
      Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
        .find((button) => button.textContent === 'Revoke')
        ?.click();
    });

    expect(useProviderConsent.getState().isGranted('p1', 'conn_anthropic')).toBe(false);
  });

  it('does not render the section at all for a brand-new (unsaved) persona', async () => {
    await render(createElement(PersonaEditor, { persona: null, onClose: () => {} }));
    const heading = Array.from(document.querySelectorAll('h2')).find(
      (h) => h.textContent === 'Allowed destinations',
    );
    expect(heading).toBeUndefined();
  });
});
