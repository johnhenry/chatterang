/**
 * THE INTERACTIVE CONSENT SHEET, AT THE SEND PATH (#23, #122).
 *
 * `providerConsentPending` and `useProviderConsent` (feat/persona-agent-config)
 * decide WHETHER a route is allowed; this file is about the moment a send
 * actually asks, through `useApp`'s existing `requestApproval` queue — the
 * same mechanism the shell tool's egress sheet uses (`ApprovalGate` renders
 * whatever is asked here). No new plumbing: `runGeneration` calls
 * `app.requestApproval(...)` before `resolveTarget`, and a UI mounted at the
 * app root drains `useApp().approvals` the same way it already does for
 * tool calls.
 *
 * The guarantee under test: NOTHING reaches the named connection until the
 * user answers "Allow" — not a request sent then discarded, not a dry run —
 * because the ask happens strictly before `resolveTarget` is ever called for
 * that turn. "Not now" must not merely fail to grant; the turn must still
 * complete, honestly, against whatever the ordinary fallback is.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ApprovalPrompt } from '@/state/app';
import type { ProviderConnection } from '@/ai/providers';
import type { CharacterCardV2 } from '@/domain/persona';

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
const { useProviderConsent, providerConsentKey } = await import('@/state/provider-consent');

const ANTHROPIC: ProviderConnection = {
  id: 'conn_anthropic',
  providerId: 'anthropic',
  label: 'Anthropic',
  apiKey: 'sk-test',
  baseUrl: 'https://api.anthropic.com',
  defaultModel: 'claude-haiku',
  enabled: true,
  models: [],
  createdAt: 1,
};

const OPENAI: ProviderConnection = {
  id: 'conn_openai',
  providerId: 'openai',
  label: 'OpenAI',
  apiKey: 'sk-test-2',
  baseUrl: 'https://api.openai.com/v1',
  defaultModel: 'gpt-4o-mini',
  enabled: true,
  models: [],
  createdAt: 2,
};

function importedCard(connectionId: string): CharacterCardV2 {
  return {
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: {
      name: 'Ellery',
      extensions: {
        chatterang: {
          schemaVersion: 1,
          agentConfig: { provider: { kind: 'remote-connection', connectionId } },
        },
      },
    },
  };
}

/** Records every `requestApproval` call and answers with a fixed boolean. */
function recordingApproval(answer: boolean) {
  const calls: { action: string; prompt?: ApprovalPrompt }[] = [];
  return {
    calls,
    requestApproval: async (action: string, prompt?: ApprovalPrompt) => {
      calls.push({ action, prompt });
      return answer;
    },
  };
}

interface Dispatch {
  readonly target: Record<string, unknown> | null;
  readonly requests: number;
}

async function dispatch(personaId: string, answer: boolean) {
  let seen: Record<string, unknown> | null = null;
  let requests = 0;
  const approval = recordingApproval(answer);
  useApp.setState({
    toasts: [],
    requestApproval: approval.requestApproval,
    engine: {
      async *stream({ target }: { target: Record<string, unknown> }) {
        requests += 1;
        seen = { ...target };
        yield { type: 'done', text: 'ok', provenance: target, stats: { promptTokens: 0, completionTokens: 0 } };
      },
    } as never,
  });
  await useChats.getState().newChat({ personaId });
  await useChats.getState().send('hello');
  return { target: seen, requests, calls: approval.calls } satisfies Dispatch & { calls: typeof approval.calls };
}

beforeEach(() => {
  useModels.setState({ activeModelId: null, installed: {} });
  useApp.setState({ connections: [OPENAI, ANTHROPIC] });
  usePersonas.setState({ byId: {}, order: [] } as never);
  useProviderConsent.setState({ granted: {} });
});

describe('the send-time consent sheet', () => {
  it('asks before anything reaches the named connection, and "Not now" sends nothing there', async () => {
    const personaId = await usePersonas.getState().importCard(importedCard('conn_anthropic'));

    const result = await dispatch(personaId, false);

    // Asked exactly once, naming the persona and the destination.
    expect(result.calls).toHaveLength(1);
    expect(result.calls[0]?.prompt?.title).toContain('Ellery');
    expect(result.calls[0]?.prompt?.title).toContain('Anthropic');
    expect(result.calls[0]?.prompt?.confirmLabel).toBe('Allow');
    expect(result.calls[0]?.prompt?.cancelLabel).toBe('Not now');

    // Declined: the turn still completes, but against the ordinary
    // fallback — never against the connection that was asked about.
    expect(result.requests).toBe(1);
    expect((result.target as { backendId?: string } | null)?.backendId).toBe(OPENAI.id);
    expect((result.target as { backendId?: string } | null)?.backendId).not.toBe(ANTHROPIC.id);
    expect(useProviderConsent.getState().isGranted(personaId, 'conn_anthropic')).toBe(false);
  });

  it('"Allow" persists the grant and routes to the named connection in the SAME turn', async () => {
    const personaId = await usePersonas.getState().importCard(importedCard('conn_anthropic'));

    const result = await dispatch(personaId, true);

    expect(result.calls).toHaveLength(1);
    expect(useProviderConsent.getState().isGranted(personaId, 'conn_anthropic')).toBe(true);
    expect((result.target as { backendId?: string } | null)?.backendId).toBe(ANTHROPIC.id);
  });

  it('persists the grant to disk (writeSetting), not only in memory', async () => {
    const { writeSetting } = await import('@/db');
    const personaId = await usePersonas.getState().importCard(importedCard('conn_anthropic'));

    await dispatch(personaId, true);

    expect(writeSetting).toHaveBeenCalledWith(providerConsentKey(personaId, 'conn_anthropic'), expect.any(Number));
  });

  it('does not ask again once consent is already granted', async () => {
    const personaId = await usePersonas.getState().importCard(importedCard('conn_anthropic'));
    await useProviderConsent.getState().grant(personaId, 'conn_anthropic');

    const result = await dispatch(personaId, false); // would deny if asked

    expect(result.calls).toHaveLength(0);
    expect((result.target as { backendId?: string } | null)?.backendId).toBe(ANTHROPIC.id);
  });

  it('does not ask for a self-authored persona at all', async () => {
    await usePersonas.getState().save({
      kind: 'assistant',
      name: 'Mine',
      tagline: '',
      avatarSeed: 'mine',
      description: '',
      tags: [],
      showThinking: false,
      agentConfig: { provider: { kind: 'remote-connection', connectionId: 'conn_anthropic' } },
    });
    const personaId = Object.keys(usePersonas.getState().byId)[0]!;

    const result = await dispatch(personaId, false); // would deny if asked

    expect(result.calls).toHaveLength(0);
    expect((result.target as { backendId?: string } | null)?.backendId).toBe(ANTHROPIC.id);
  });
});
