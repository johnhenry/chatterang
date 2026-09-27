/**
 * One-time consent for an imported/marketplace persona's remote or
 * cli-agent provider (#23, #122; adversarial review, HIGH).
 *
 * THE REVIEWER'S CASE, reproduced first: a card imported through this app's
 * own `importCard` — not a hand-built `Persona` object — whose
 * `agentConfig.provider` names a `remote-connection` the user already has,
 * and whose (attacker-controlled) `agentConfig.source.forSurface` claims
 * `'marketplace'`. Before this fix, `newChat` -> `send` routed a real turn
 * to that connection with nothing having asked. After it, the same
 * sequence must not reach that connection until `useProviderConsent.grant`
 * has been called for it — and once granted, must route there; and once
 * revoked, or once the persona names a different connection, must not
 * again without a fresh grant.
 *
 * `source.forSurface` is deliberately never read for this — `origin` comes
 * only from `importCard`'s own code path (`state/personas.ts`) — so the
 * card claiming `'marketplace'` is exercised here as exactly the attacker
 * input it is: ignored, with `importCard`'s own 'imported' origin doing the
 * actual gating.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

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

const writeSettingMock = vi.hoisted(() => vi.fn(async (_key: string, _value: unknown) => {}));

vi.mock('@/db', () => ({
  db: tables,
  deleteChat: vi.fn(async () => {}),
  readSetting: async (_key: string, fallback: unknown) => fallback,
  writeSetting: writeSettingMock,
}));

const { useChats, providerConsentPending } = await import('@/state/chat');
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

/** Exactly the reviewer's card: a remote-connection provider, claiming (falsely, for this test) to be a marketplace listing. */
function marketplaceClaimingCard(connectionId: string): CharacterCardV2 {
  return {
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: {
      name: 'Untrusted Import',
      extensions: {
        chatterang: {
          schemaVersion: 1,
          agentConfig: {
            provider: { kind: 'remote-connection', connectionId },
            source: { forSurface: 'marketplace', author: 'someone-else' },
          },
        },
      },
    },
  };
}

interface Dispatch {
  readonly target: Record<string, unknown> | null;
}

/**
 * `send` now asks for consent interactively (feat/persona-editor track)
 * before it ever reaches `resolveTarget`, through the SAME
 * `requestApproval` queue the shell tool uses. Every test in this file is
 * about the STORED grant, arranged directly through `useProviderConsent`
 * before `dispatch` is called — not about the interactive sheet, which
 * `tests/persona-provider-consent-sheet.test.ts` covers — so this default
 * stub answers "no" immediately. Left unstubbed, an ungranted persona's
 * `send` would await a `requestApproval` nobody ever answers, and because
 * `runGeneration`'s `finally` only runs once that await settles, the turn
 * it claimed would never release, wedging every dispatch after it in the
 * same test file (this is exactly what happened before this stub existed:
 * one test timed out and every test after it failed on an empty target).
 */
async function dispatch(personaId: string): Promise<Dispatch> {
  let seen: Record<string, unknown> | null = null;
  useApp.setState({
    toasts: [],
    requestApproval: async () => false,
    engine: {
      async *stream({ target }: { target: Record<string, unknown> }) {
        seen = { ...target };
        yield { type: 'done', text: 'ok', provenance: target, stats: { promptTokens: 0, completionTokens: 0 } };
      },
    } as never,
  });
  await useChats.getState().newChat({ personaId });
  await useChats.getState().send('hello');
  return { target: seen };
}

beforeEach(() => {
  useModels.setState({ activeModelId: null, installed: {} });
  useApp.setState({ connections: [OPENAI, ANTHROPIC] });
  usePersonas.setState({ byId: {}, order: [] } as never);
  useProviderConsent.setState({ granted: {} });
});

describe('an imported persona naming a connection the user has', () => {
  it('does NOT route there before consent — falls back to the ordinary first-enabled connection', async () => {
    const personaId = await usePersonas.getState().importCard(marketplaceClaimingCard('conn_anthropic'));

    // The attacker-controlled claim did not make it into origin.
    expect(usePersonas.getState().byId[personaId]?.origin).toBe('imported');

    const sent = await dispatch(personaId);
    expect((sent.target as { backendId?: string } | null)?.backendId).toBe(OPENAI.id);
    expect((sent.target as { backendId?: string } | null)?.backendId).not.toBe(ANTHROPIC.id);
  });

  it('routes there once consent is granted for exactly that (persona, destination)', async () => {
    const personaId = await usePersonas.getState().importCard(marketplaceClaimingCard('conn_anthropic'));
    await useProviderConsent.getState().grant(personaId, 'conn_anthropic');

    const sent = await dispatch(personaId);
    expect((sent.target as { backendId?: string } | null)?.backendId).toBe(ANTHROPIC.id);
  });

  it('persists the grant through writeSetting, under a namespaced key', async () => {
    const personaId = await usePersonas.getState().importCard(marketplaceClaimingCard('conn_anthropic'));
    await useProviderConsent.getState().grant(personaId, 'conn_anthropic');

    expect(writeSettingMock).toHaveBeenCalledWith(
      providerConsentKey(personaId, 'conn_anthropic'),
      expect.any(Number),
    );
  });

  it('revoking the grant blocks the route again, without a fresh import', async () => {
    const personaId = await usePersonas.getState().importCard(marketplaceClaimingCard('conn_anthropic'));
    await useProviderConsent.getState().grant(personaId, 'conn_anthropic');
    expect((await dispatch(personaId)).target).toEqual(
      expect.objectContaining({ backendId: ANTHROPIC.id }),
    );

    await useProviderConsent.getState().revoke(personaId, 'conn_anthropic');
    const sent = await dispatch(personaId);
    expect((sent.target as { backendId?: string } | null)?.backendId).toBe(OPENAI.id);
  });

  it('changing the persona’s provider to a different connection invalidates the old grant', async () => {
    const personaId = await usePersonas.getState().importCard(marketplaceClaimingCard('conn_anthropic'));
    await useProviderConsent.getState().grant(personaId, 'conn_anthropic');

    // Re-edited (e.g. through the persona editor) to point at a different
    // connection — the OLD grant, keyed to the old destination, says
    // nothing about this new one.
    const edited = usePersonas.getState().byId[personaId]!;
    usePersonas.setState({
      byId: {
        ...usePersonas.getState().byId,
        [personaId]: {
          ...edited,
          agentConfig: { ...edited.agentConfig, provider: { kind: 'remote-connection', connectionId: OPENAI.id } },
        },
      },
    } as never);

    const sent = await dispatch(personaId);
    // Still gated: OPENAI is also the ordinary fallback here, so the
    // meaningful assertion is that granting consent for `conn_anthropic`
    // did not carry over — checked directly against the consent store.
    expect(useProviderConsent.getState().isGranted(personaId, OPENAI.id)).toBe(false);
    expect((sent.target as { backendId?: string } | null)?.backendId).toBe(OPENAI.id);
  });

  it('a connection deleted and re-added under a new id is not covered by the old grant', async () => {
    const personaId = await usePersonas.getState().importCard(marketplaceClaimingCard('conn_anthropic'));
    await useProviderConsent.getState().grant(personaId, 'conn_anthropic');

    // The connection is gone; a same-named replacement got a fresh id, the
    // way `state/app.ts` mints one for every new connection.
    const replacement: ProviderConnection = { ...ANTHROPIC, id: 'conn_anthropic_2' };
    useApp.setState({ connections: [OPENAI, replacement] });

    const sent = await dispatch(personaId);
    expect((sent.target as { backendId?: string } | null)?.backendId).toBe(OPENAI.id);
  });
});

describe('a self-authored persona', () => {
  it('routes silently, with no grant needed', async () => {
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
    expect(usePersonas.getState().byId[personaId]?.origin).toBe('authored');

    const sent = await dispatch(personaId);
    expect((sent.target as { backendId?: string } | null)?.backendId).toBe(ANTHROPIC.id);
  });
});

describe('a persona row from before `origin` existed', () => {
  it('is gated the same as an imported one, not treated as authored', async () => {
    usePersonas.setState({
      byId: {
        p_legacy: {
          id: 'p_legacy',
          kind: 'assistant',
          name: 'Legacy',
          tagline: '',
          avatarSeed: 'legacy',
          description: '',
          tags: [],
          showThinking: false,
          version: 1,
          createdAt: 0,
          updatedAt: 0,
          // No `origin` key at all — exactly a v10/v11 row, before this field.
          agentConfig: { provider: { kind: 'remote-connection', connectionId: 'conn_anthropic' } },
        },
      },
      order: ['p_legacy'],
    } as never);

    const sent = await dispatch('p_legacy');
    expect((sent.target as { backendId?: string } | null)?.backendId).toBe(OPENAI.id);
  });
});

/*
 * ROUND 2 FOLLOW-UP (feat/persona-editor track): `providerConsentPending`
 * must agree with `resolvePersonaProvider` about what "nothing concrete to
 * ask about yet" means — that function only ever routes to an ENABLED
 * connection, so the pending query must not tell a UI to ask about a
 * connection that is disabled, since allowing it would grant a consent that
 * still resolves to the ordinary fallback and never actually visits that
 * destination.
 */
describe('providerConsentPending — must match resolvePersonaProvider’s own enabled check', () => {
  it('is NOT pending for a remote-connection that exists but is disabled', async () => {
    const personaId = await usePersonas.getState().importCard(marketplaceClaimingCard('conn_anthropic'));
    const persona = usePersonas.getState().byId[personaId]!;

    expect(providerConsentPending(persona, [OPENAI, { ...ANTHROPIC, enabled: false }])).toBe(false);
  });

  it('(paired) IS pending for the same connection once it is enabled', async () => {
    const personaId = await usePersonas.getState().importCard(marketplaceClaimingCard('conn_anthropic'));
    const persona = usePersonas.getState().byId[personaId]!;

    expect(providerConsentPending(persona, [OPENAI, ANTHROPIC])).toBe(true);
  });
});

describe('useProviderConsent.grantsFor — the persona editor’s revoke list', () => {
  it('lists every destination this persona has a live grant for, and no other persona’s', async () => {
    await useProviderConsent.getState().grant('p1', 'conn_anthropic');
    await useProviderConsent.getState().grant('p1', 'cli-agent');
    await useProviderConsent.getState().grant('p2', 'conn_anthropic');

    const grants = useProviderConsent.getState().grantsFor('p1');
    expect(grants.map((g) => g.destination).sort()).toEqual(['cli-agent', 'conn_anthropic']);
    expect(grants.every((g) => typeof g.grantedAt === 'number')).toBe(true);
  });

  it('is empty for a persona with no grants', () => {
    expect(useProviderConsent.getState().grantsFor('nobody')).toEqual([]);
  });

  it('drops a revoked destination', async () => {
    await useProviderConsent.getState().grant('p1', 'conn_anthropic');
    await useProviderConsent.getState().revoke('p1', 'conn_anthropic');
    expect(useProviderConsent.getState().grantsFor('p1')).toEqual([]);
  });
});
