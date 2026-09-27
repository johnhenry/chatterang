/**
 * `Persona.agentConfig` (#23, #122: configurable personas — owner ruling
 * 2026-09-27) — the domain-layer half: the type, its Character Card v2
 * round trip, and import sanitization.
 *
 * Everything here narrows only. A persona is data that arrives from a file
 * on disk or a marketplace listing, so `fromCharacterCard` must not trust a
 * `provider.kind` it does not recognise, a `confirmPolicy` outside the two
 * values the app knows how to enforce, or a `maxToolRounds` that is not a
 * plain non-negative number. Anything else is dropped rather than carried
 * forward, silently — an unreadable field is not the same as an absent one,
 * but for what this app can safely act on, it might as well be.
 */

import { describe, expect, it } from 'vitest';

import {
  fromCharacterCard,
  sanitizeAgentConfig,
  toCharacterCard,
  type CharacterCardV2,
  type Persona,
  type PersonaAgentConfig,
} from '@/domain/persona';

function persona(overrides: Partial<Persona> = {}): Persona {
  return {
    id: 'p1',
    kind: 'character',
    name: 'Vess',
    tagline: 'A cartographer',
    avatarSeed: 'vess',
    description: '{{char}} draws coastlines for {{user}}.',
    version: 1,
    tags: [],
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

const FULL_CONFIG: PersonaAgentConfig = {
  provider: { kind: 'remote-connection', connectionId: 'conn_1', modelId: 'gpt-4o-mini' },
  toolPolicy: {
    toolIds: ['calculator', 'web_search'],
    mcpServerIds: ['mcp_1'],
    confirmPolicy: 'always-ask',
    maxToolRounds: 2,
  },
  source: { author: 'Marren', url: 'https://example.com/vess', publishedAt: 1000, forSurface: 'marketplace' },
};

describe('sanitizeAgentConfig', () => {
  it('passes a well-formed config through unchanged', () => {
    expect(sanitizeAgentConfig(FULL_CONFIG)).toEqual(FULL_CONFIG);
  });

  it('returns undefined for non-object input', () => {
    expect(sanitizeAgentConfig(undefined)).toBeUndefined();
    expect(sanitizeAgentConfig(null)).toBeUndefined();
    expect(sanitizeAgentConfig('nonsense')).toBeUndefined();
    expect(sanitizeAgentConfig(42)).toBeUndefined();
  });

  it('drops a provider whose kind it does not recognise', () => {
    const result = sanitizeAgentConfig({
      provider: { kind: 'quantum-cloud', connectionId: 'x' },
    });
    expect(result?.provider).toBeUndefined();
  });

  it('keeps the placeholder cli-agent kind without wiring it to anything', () => {
    const result = sanitizeAgentConfig({ provider: { kind: 'cli-agent' } });
    expect(result?.provider).toEqual({ kind: 'cli-agent', connectionId: undefined, modelId: undefined });
  });

  it('drops a confirmPolicy outside the allowed set — never one that skips confirmation', () => {
    const result = sanitizeAgentConfig({
      toolPolicy: { confirmPolicy: 'never-ask' },
    });
    expect(result?.toolPolicy?.confirmPolicy).toBeUndefined();
  });

  it('keeps each allowed confirmPolicy value', () => {
    for (const value of ['always-ask', 'app-default'] as const) {
      expect(sanitizeAgentConfig({ toolPolicy: { confirmPolicy: value } })?.toolPolicy?.confirmPolicy).toBe(
        value,
      );
    }
  });

  it('drops a non-numeric or negative maxToolRounds', () => {
    expect(sanitizeAgentConfig({ toolPolicy: { maxToolRounds: 'lots' } })?.toolPolicy?.maxToolRounds).toBeUndefined();
    expect(sanitizeAgentConfig({ toolPolicy: { maxToolRounds: -3 } })?.toolPolicy?.maxToolRounds).toBeUndefined();
    expect(sanitizeAgentConfig({ toolPolicy: { maxToolRounds: 3.5 } })?.toolPolicy?.maxToolRounds).toBeUndefined();
  });

  it('keeps a valid maxToolRounds', () => {
    expect(sanitizeAgentConfig({ toolPolicy: { maxToolRounds: 2 } })?.toolPolicy?.maxToolRounds).toBe(2);
  });

  it('filters non-string entries out of toolIds and mcpServerIds', () => {
    const result = sanitizeAgentConfig({
      toolPolicy: { toolIds: ['ok', 42, null], mcpServerIds: ['mcp_1', {}] },
    });
    expect(result?.toolPolicy?.toolIds).toEqual(['ok']);
    expect(result?.toolPolicy?.mcpServerIds).toEqual(['mcp_1']);
  });

  it('returns undefined rather than an empty object when nothing survives', () => {
    expect(sanitizeAgentConfig({ provider: { kind: 'nope' }, toolPolicy: { confirmPolicy: 'nope' } })).toBeUndefined();
  });
});

describe('Character Card v2 round trip with agentConfig', () => {
  it('writes agentConfig into data.extensions.chatterang, namespaced and schema-tagged', () => {
    const card = toCharacterCard({ ...persona(), agentConfig: FULL_CONFIG });
    expect(card.data.extensions?.chatterang?.schemaVersion).toBe(1);
    expect(card.data.extensions?.chatterang?.agentConfig).toEqual(FULL_CONFIG);
  });

  it('round-trips losslessly through fromCharacterCard(toCharacterCard(...))', () => {
    const card = toCharacterCard({ ...persona(), agentConfig: FULL_CONFIG });
    const draft = fromCharacterCard(card);
    expect(draft.agentConfig).toEqual(FULL_CONFIG);
  });

  it('writes no extensions block at all for a persona with no agentConfig', () => {
    const card = toCharacterCard(persona());
    expect(card.data.extensions).toBeUndefined();
  });

  it('imports a card from another app with unknown extensions without inventing an agentConfig', () => {
    const foreignCard: CharacterCardV2 = {
      spec: 'chara_card_v2',
      spec_version: '2.0',
      data: {
        name: 'Foreign',
        extensions: { someOtherApp: { anything: true } },
      },
    };
    const draft = fromCharacterCard(foreignCard);
    expect(draft.agentConfig).toBeUndefined();
  });

  /*
   * ADVERSARIAL REVIEW FINDING (LOW): `toCharacterCard` dropped every OTHER
   * app's `extensions.*` entry on re-export, keeping only our own
   * `chatterang` key. A card round-tripped through this app for its
   * provider/tool-policy settings came back with a third-party app's data
   * silently gone. Preserved opaquely instead: read once on import, carried
   * on the persona, never interpreted, written back untouched on export.
   */
  it('carries another app’s extensions opaquely through import', () => {
    const foreignCard: CharacterCardV2 = {
      spec: 'chara_card_v2',
      spec_version: '2.0',
      data: { name: 'Foreign', extensions: { someOtherApp: { anything: true }, another: 'x' } },
    };
    const draft = fromCharacterCard(foreignCard);
    expect(draft.foreignCardExtensions).toEqual({ someOtherApp: { anything: true }, another: 'x' });
  });

  it('writes those foreign extensions back on export, byte for byte', () => {
    const draft = fromCharacterCard({
      spec: 'chara_card_v2',
      spec_version: '2.0',
      data: { name: 'Foreign', extensions: { someOtherApp: { anything: true } } },
    });
    const card = toCharacterCard({ ...draft, id: 'x', version: 1, createdAt: 0, updatedAt: 0 } as Persona);
    expect(card.data.extensions?.someOtherApp).toEqual({ anything: true });
  });

  it('writes both a foreign extension AND our own chatterang key together', () => {
    const draft = fromCharacterCard({
      spec: 'chara_card_v2',
      spec_version: '2.0',
      data: { name: 'Both', extensions: { someOtherApp: { anything: true } } },
    });
    const card = toCharacterCard({
      ...draft,
      id: 'x',
      version: 1,
      createdAt: 0,
      updatedAt: 0,
      agentConfig: FULL_CONFIG,
    } as Persona);
    expect(card.data.extensions?.someOtherApp).toEqual({ anything: true });
    expect(card.data.extensions?.chatterang?.agentConfig).toEqual(FULL_CONFIG);
  });

  it('never reads a foreign extension’s content as if it were our own — it is carried, not interpreted', () => {
    // A foreign extension named exactly like an attempt to sneak agentConfig
    // in under a different key must not be picked up by anything.
    const draft = fromCharacterCard({
      spec: 'chara_card_v2',
      spec_version: '2.0',
      data: {
        name: 'Sneaky',
        extensions: { notChatterang: { agentConfig: { provider: { kind: 'remote-connection' } } } },
      },
    });
    expect(draft.agentConfig).toBeUndefined();
    expect(draft.foreignCardExtensions).toEqual({
      notChatterang: { agentConfig: { provider: { kind: 'remote-connection' } } },
    });
  });

  it('sanitizes an imported agentConfig, dropping the unrecognised parts', () => {
    const card: CharacterCardV2 = {
      spec: 'chara_card_v2',
      spec_version: '2.0',
      data: {
        name: 'Suspect',
        extensions: {
          chatterang: {
            schemaVersion: 1,
            agentConfig: {
              provider: { kind: 'quantum-cloud' },
              toolPolicy: { toolIds: ['bash'], confirmPolicy: 'never-ask', maxToolRounds: -1 },
            },
          },
        },
      },
    };
    const draft = fromCharacterCard(card);
    expect(draft.agentConfig?.provider).toBeUndefined();
    expect(draft.agentConfig?.toolPolicy?.toolIds).toEqual(['bash']);
    expect(draft.agentConfig?.toolPolicy?.confirmPolicy).toBeUndefined();
    expect(draft.agentConfig?.toolPolicy?.maxToolRounds).toBeUndefined();
  });
});

describe('Persona.agentConfig back-compat', () => {
  it('is optional — a persona with the old thin fields still typechecks and works', () => {
    const legacy = persona({ preferredModelId: 'm1', tools: ['calculator'], showThinking: true });
    expect(legacy.agentConfig).toBeUndefined();
    expect(legacy.preferredModelId).toBe('m1');
  });
});
