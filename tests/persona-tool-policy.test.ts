/**
 * Narrow-only tool policy (#7, owner ruling 2026-09-27).
 *
 * `unsensitive()` already refused to let a persona's `tools` list widen past
 * what the app allows — a sensitive tool is dropped, not the whole list
 * refused. `narrowToolPolicy` extends the same refusal to `agentConfig`:
 * `toolIds` is intersected with the persona's own legacy list (when both are
 * given) and then with what the registry allows; `confirmPolicy` can only
 * tighten, never loosen; `maxToolRounds` is clamped to the engine's own
 * per-turn cap. Every test here is a "can it widen" question, and the
 * answer, proven rather than asserted, is no.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ProviderConnection } from '@/ai/providers';
import type { Persona } from '@/domain/persona';

/* ── The database, stubbed at the table boundary ────────────────────── */

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

const { useChats, narrowToolPolicy, unsensitive } = await import('@/state/chat');
const { useApp } = await import('@/state/app');
const { usePersonas } = await import('@/state/personas');
const { toolRegistry } = await import('@/ai/tools/registry');
const { TOOL_ITERATIONS } = await import('@/ai/engine');

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

beforeEach(() => {
  toolRegistry.register(SAFE_TOOL);
  toolRegistry.register(DANGEROUS_TOOL);
});

afterEach(() => {
  toolRegistry.unregister('safe_calc');
  toolRegistry.unregister('danger_bash');
});

describe('narrowToolPolicy — toolIds', () => {
  it('with no agentConfig, behaves exactly like unsensitive(persona.tools)', () => {
    const legacy = ['safe_calc', 'danger_bash'];
    expect(narrowToolPolicy(legacy, undefined).toolIds).toEqual(unsensitive(legacy));
  });

  it('intersects toolPolicy.toolIds with the legacy tools list when both are given', () => {
    const result = narrowToolPolicy(['safe_calc'], {
      toolPolicy: { toolIds: ['safe_calc', 'danger_bash', 'nonexistent'] },
    });
    // 'danger_bash' and 'nonexistent' are not in the legacy list, so they are
    // never candidates, regardless of what toolPolicy asks for.
    expect(result.toolIds).toEqual(['safe_calc']);
  });

  it('never lets toolPolicy.toolIds add a tool absent from a non-empty legacy list', () => {
    const result = narrowToolPolicy(['danger_bash'], { toolPolicy: { toolIds: ['safe_calc'] } });
    // Neither list alone decides it: 'safe_calc' is not in the legacy list, so
    // it is not a candidate, and 'danger_bash' is sensitive regardless.
    expect(result.toolIds).toEqual([]);
  });

  it('drops a sensitive tool even when both lists name it', () => {
    const result = narrowToolPolicy(['danger_bash'], { toolPolicy: { toolIds: ['danger_bash'] } });
    expect(result.toolIds).toEqual([]);
  });

  it('uses toolPolicy.toolIds alone when there is no legacy tools list', () => {
    const result = narrowToolPolicy(undefined, { toolPolicy: { toolIds: ['safe_calc'] } });
    expect(result.toolIds).toEqual(['safe_calc']);
  });
});

describe('narrowToolPolicy — confirmPolicy', () => {
  it('keeps always-ask', () => {
    expect(narrowToolPolicy([], { toolPolicy: { confirmPolicy: 'always-ask' } }).confirmPolicy).toBe(
      'always-ask',
    );
  });

  it('resolves app-default (or absent) to undefined — nothing here can loosen a confirmation', () => {
    expect(narrowToolPolicy([], { toolPolicy: { confirmPolicy: 'app-default' } }).confirmPolicy).toBeUndefined();
    expect(narrowToolPolicy([], undefined).confirmPolicy).toBeUndefined();
  });
});

describe('narrowToolPolicy — maxToolRounds', () => {
  it('passes a value at or under the engine limit through unchanged', () => {
    expect(narrowToolPolicy([], { toolPolicy: { maxToolRounds: 1 } }).maxToolRounds).toBe(1);
  });

  it('clamps a value over the engine limit down to it — never up', () => {
    expect(narrowToolPolicy([], { toolPolicy: { maxToolRounds: TOOL_ITERATIONS + 50 } }).maxToolRounds).toBe(
      TOOL_ITERATIONS,
    );
  });

  it('leaves maxToolRounds undefined when the persona asks for nothing', () => {
    expect(narrowToolPolicy([], undefined).maxToolRounds).toBeUndefined();
  });
});

describe('newChat wires narrowToolPolicy into chat.tools', () => {
  beforeEach(() => {
    useApp.setState({ connections: [] as ProviderConnection[] });
    usePersonas.setState({
      byId: {
        p1: persona({
          tools: ['safe_calc'],
          agentConfig: { toolPolicy: { toolIds: ['safe_calc', 'danger_bash'] } },
        }),
      },
      order: ['p1'],
    } as never);
  });

  it('a chat started from that persona gets the narrowed list, not the wider one', async () => {
    await useChats.getState().newChat({ personaId: 'p1' });
    const chat = useChats.getState().chats[0];
    expect(chat?.tools).toEqual(['safe_calc']);
  });
});
