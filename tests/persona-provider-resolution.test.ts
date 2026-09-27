/**
 * Provider/model resolution from a persona's `agentConfig.provider` (#7).
 *
 * `newChat` already copies `persona.preferredModelId` into `chat.modelId`,
 * and `resolveTarget` falls back to the first enabled connection when that
 * id is not installed locally (`tests/model-selection.test.ts`, section 8).
 * `agentConfig.provider` sits on top of that same path rather than beside
 * it: `kind: 'local'` is just another way to name a model id,
 * `kind: 'remote-connection'` additionally says WHICH connection to prefer
 * once the fallback happens (so with two enabled connections it is not a
 * coin toss), and a missing or disabled connection falls back exactly like a
 * missing `preferredModelId` always has — the first enabled connection,
 * unchanged. `kind: 'cli-agent'` resolves to nothing here (another track
 * owns that target) and so behaves like no provider at all.
 *
 * Driven through the real `newChat`, `send` and `resolveTarget`, with a
 * recording engine standing in for the real one — the same shape
 * `tests/model-selection.test.ts` uses and for the same reason: the TARGET
 * chosen is an argument to `stream`, not a fact this file should assert from
 * source text.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ProviderConnection } from '@/ai/providers';
import type { Persona } from '@/domain/persona';
import { REACH_REMOTE } from '@/domain/chat';

const tables = vi.hoisted(() => ({
  chats: { put: vi.fn(async () => {}), delete: vi.fn(async () => {}), toArray: async () => [] },
  messages: {
    put: vi.fn(async () => {}),
    delete: vi.fn(async () => {}),
    where: () => ({ equals: () => ({ sortBy: async () => [], toArray: async () => [] }) }),
  },
  models: { put: vi.fn(async () => {}), delete: vi.fn(async () => {}), toArray: async () => [] },
  settings: { get: vi.fn(async () => undefined), put: vi.fn(async () => {}) },
  connections: { put: vi.fn(async () => {}), delete: vi.fn(async () => {}), toArray: async () => [] },
  personas: { put: vi.fn(async () => {}), delete: vi.fn(async () => {}), toArray: async () => [] },
}));

vi.mock('@/db', () => ({
  db: tables,
  deleteChat: vi.fn(async () => {}),
  readSetting: async (_key: string, fallback: unknown) => fallback,
  writeSetting: vi.fn(async () => {}),
}));

const { useChats } = await import('@/state/chat');
const { useApp } = await import('@/state/app');
const { useModels } = await import('@/state/models');
const { usePersonas } = await import('@/state/personas');

const OPENAI: ProviderConnection = {
  id: 'conn_openai',
  providerId: 'openai',
  label: 'OpenAI',
  apiKey: 'sk-test',
  baseUrl: 'https://api.openai.com/v1',
  defaultModel: 'gpt-4o-mini',
  enabled: true,
  models: [],
  createdAt: 1,
};

const ANTHROPIC: ProviderConnection = {
  id: 'conn_anthropic',
  providerId: 'anthropic',
  label: 'Anthropic',
  apiKey: 'sk-test-2',
  baseUrl: 'https://api.anthropic.com',
  defaultModel: 'claude-haiku',
  enabled: true,
  models: [],
  createdAt: 2,
};

function persona(overrides: Partial<Persona> = {}): Persona {
  return {
    id: 'p1',
    kind: 'assistant',
    name: 'Aide',
    tagline: '',
    avatarSeed: 'aide',
    description: 'Helps.',
    version: 1,
    tags: [],
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

interface Dispatch {
  readonly target: Record<string, unknown> | null;
  readonly chatModelId: string | null;
}

/** Start a chat from `p1` and send one message, recording the engine target. */
async function dispatchFrom(connections: readonly ProviderConnection[]): Promise<Dispatch> {
  let seen: Record<string, unknown> | null = null;

  useApp.setState({
    toasts: [],
    connections: [...connections],
    engine: {
      async *stream({ target }: { target: Record<string, unknown> }) {
        seen = { ...target };
        yield {
          type: 'done',
          text: 'ok',
          provenance: target,
          stats: { promptTokens: 0, completionTokens: 0 },
        };
      },
    } as never,
  });

  await useChats.getState().newChat({ personaId: 'p1' });
  await useChats.getState().send('hello');

  return {
    target: seen,
    chatModelId: useChats.getState().chats[0]?.modelId ?? null,
  };
}

describe('agentConfig.provider — local', () => {
  beforeEach(() => {
    useModels.setState({ activeModelId: null, installed: {} });
    usePersonas.setState({
      byId: {
        p1: persona({
          preferredModelId: 'old-preference',
          agentConfig: { provider: { kind: 'local', modelId: 'new-local-model' } },
        }),
      },
      order: ['p1'],
    } as never);
  });

  it('overrides preferredModelId with the provider’s own modelId', async () => {
    const sent = await dispatchFrom([OPENAI]);
    expect(sent.chatModelId).toBe('new-local-model');
  });
});

describe('agentConfig.provider — remote-connection', () => {
  beforeEach(() => {
    useModels.setState({ activeModelId: null, installed: {} });
  });

  it('sends to the NAMED connection, not just the first enabled one', async () => {
    usePersonas.setState({
      byId: {
        p1: persona({
          agentConfig: {
            provider: { kind: 'remote-connection', connectionId: 'conn_anthropic', modelId: 'claude-opus' },
          },
        }),
      },
      order: ['p1'],
    } as never);

    // Two enabled connections; OPENAI is listed first, so "first enabled"
    // alone would pick it — the assertion below is what tells the two apart.
    const sent = await dispatchFrom([OPENAI, ANTHROPIC]);

    expect(sent.chatModelId).toBe('claude-opus');
    expect(sent.target).toEqual({
      backendId: ANTHROPIC.id,
      engine: 'remote',
      modelId: 'claude-opus',
      modelName: `${ANTHROPIC.label} · claude-opus`,
      reach: REACH_REMOTE,
    });
  });

  it('falls back to defaultModel when the provider names no modelId', async () => {
    usePersonas.setState({
      byId: {
        p1: persona({ agentConfig: { provider: { kind: 'remote-connection', connectionId: 'conn_anthropic' } } }),
      },
      order: ['p1'],
    } as never);

    const sent = await dispatchFrom([OPENAI, ANTHROPIC]);
    expect(sent.chatModelId).toBe(ANTHROPIC.defaultModel);
    expect((sent.target as { backendId?: string } | null)?.backendId).toBe(ANTHROPIC.id);
  });

  it('falls back exactly like a missing preferredModelId when the named connection is disabled', async () => {
    usePersonas.setState({
      byId: {
        p1: persona({
          agentConfig: {
            provider: { kind: 'remote-connection', connectionId: 'conn_anthropic', modelId: 'claude-opus' },
          },
        }),
      },
      order: ['p1'],
    } as never);

    const sent = await dispatchFrom([OPENAI, { ...ANTHROPIC, enabled: false }]);

    // The disabled connection's model id is not carried over either — this
    // is the SAME fallback a missing preference gets, not a partial one.
    expect(sent.chatModelId).not.toBe('claude-opus');
    expect((sent.target as { backendId?: string } | null)?.backendId).toBe(OPENAI.id);
  });

  it('re-checks that the preferred connection is still enabled at send time, not just at newChat', async () => {
    usePersonas.setState({
      byId: {
        p1: persona({
          agentConfig: {
            provider: { kind: 'remote-connection', connectionId: 'conn_anthropic', modelId: 'claude-opus' },
          },
        }),
      },
      order: ['p1'],
    } as never);

    // Enabled when the chat is created, so `preferredConnectionId` is set —
    // then switched off before anything is sent, the way a real disconnect
    // would happen mid-conversation.
    useModels.setState({ activeModelId: null, installed: {} });
    useApp.setState({ toasts: [], connections: [OPENAI, ANTHROPIC] });
    await useChats.getState().newChat({ personaId: 'p1' });
    expect(useChats.getState().chats[0]?.preferredConnectionId).toBe('conn_anthropic');

    let seen: Record<string, unknown> | null = null;
    useApp.setState({
      connections: [OPENAI, { ...ANTHROPIC, enabled: false }],
      engine: {
        async *stream({ target }: { target: Record<string, unknown> }) {
          seen = { ...target };
          yield { type: 'done', text: 'ok', provenance: target, stats: { promptTokens: 0, completionTokens: 0 } };
        },
      } as never,
    });
    await useChats.getState().send('hello');

    expect((seen as { backendId?: string } | null)?.backendId, 'must not stay on the now-disabled connection').toBe(
      OPENAI.id,
    );
  });

  it('falls back the same way when the named connection was never added', async () => {
    usePersonas.setState({
      byId: {
        p1: persona({
          agentConfig: { provider: { kind: 'remote-connection', connectionId: 'conn_never_added' } },
        }),
      },
      order: ['p1'],
    } as never);

    const sent = await dispatchFrom([OPENAI]);
    expect((sent.target as { backendId?: string } | null)?.backendId).toBe(OPENAI.id);
  });
});

describe('agentConfig.provider — cli-agent (placeholder, resolved by nothing yet)', () => {
  it('falls back to ordinary resolution, exactly as if no provider were set', async () => {
    useModels.setState({ activeModelId: null, installed: {} });
    usePersonas.setState({
      byId: { p1: persona({ agentConfig: { provider: { kind: 'cli-agent', connectionId: 'conn_openai' } } }) },
      order: ['p1'],
    } as never);

    const sent = await dispatchFrom([OPENAI]);
    // Not sent to a "cli-agent" backend — there is no such target kind yet —
    // but to the ordinary first-enabled-connection fallback. `chat.modelId`
    // itself is untouched (no local model, no preference) — it is
    // `resolveTarget`'s OWN pre-existing fallback that picks a connection at
    // send time, exactly as it would with no `agentConfig` at all.
    expect(sent.chatModelId).toBeNull();
    expect(sent.target).toEqual({
      backendId: OPENAI.id,
      engine: 'remote',
      modelId: OPENAI.defaultModel,
      modelName: `${OPENAI.label} · ${OPENAI.defaultModel}`,
      reach: REACH_REMOTE,
    });
  });
});
