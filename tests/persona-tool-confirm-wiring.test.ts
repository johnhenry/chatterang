/**
 * `narrowToolPolicy`'s `confirmPolicy` and `maxToolRounds`, actually wired
 * from the store to the engine (adversarial review, MEDIUM, refs #23,
 * #122).
 *
 * Both were computed at `newChat` for the persona editor's own preview hint
 * and then dropped: never stored on `Chat`, never read by `egressPolicy`/
 * `mcpEgressPolicy`, never passed to the engine at all. This file drives
 * the real `useChats.getState().send(...)` against a fake engine that
 * records exactly what it was handed — `confirmEachCall`, `maxToolRounds`,
 * and whether an "always-ask" persona's standing egress grant is still
 * honoured — so the guarantee is measured at the boundary a real turn
 * crosses, not asserted from source text.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ProviderConnection } from '@/ai/providers';

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
const { TOOL_ITERATIONS } = await import('@/ai/engine');

type Persona = import('@/domain/persona').Persona;

const OPENAI: ProviderConnection = {
  id: 'conn_openai',
  providerId: 'openai',
  label: 'OpenAI',
  apiKey: '',
  baseUrl: '',
  defaultModel: 'gpt-4o-mini',
  enabled: true,
  models: [],
  createdAt: 0,
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
    tools: ['calculator'],
    version: 1,
    createdAt: 0,
    updatedAt: 0,
    origin: 'authored',
    ...overrides,
  };
}

interface SeenRequest {
  readonly maxToolRounds?: number;
  readonly confirmEachCall?: (call: unknown, signal?: AbortSignal) => Promise<boolean>;
  readonly egress?: { isGranted: (backendId: string) => boolean };
}

async function dispatchAndCapture(
  personaId: string,
  requestApproval: (...args: unknown[]) => Promise<boolean> = async () => true,
): Promise<SeenRequest> {
  let seen: SeenRequest | null = null;
  useApp.setState({
    toasts: [],
    connections: [OPENAI],
    requestApproval: requestApproval as never,
    engine: {
      async *stream(request: SeenRequest) {
        seen = request;
        yield { type: 'done', text: 'ok', provenance: {}, stats: { promptTokens: 0, completionTokens: 0 } };
      },
    } as never,
  });
  await useChats.getState().newChat({ personaId });
  await useChats.getState().send('hello');
  if (!seen) throw new Error('engine.stream was never called');
  return seen;
}

beforeEach(() => {
  useModels.setState({ activeModelId: 'local-model', installed: {} });
  usePersonas.setState({ byId: {}, order: [] } as never);
});

describe('maxToolRounds reaches the engine', () => {
  it('a persona asking for 1 round has it passed through, unclamped (already under the cap)', async () => {
    await usePersonas.getState().save(
      persona({ agentConfig: { toolPolicy: { maxToolRounds: 1 } } }),
    );
    const personaId = Object.keys(usePersonas.getState().byId)[0]!;

    const seen = await dispatchAndCapture(personaId);
    expect(seen.maxToolRounds).toBe(1);
  });

  it('a value above the engine cap is clamped before it ever reaches the engine', async () => {
    await usePersonas.getState().save(
      persona({ agentConfig: { toolPolicy: { maxToolRounds: TOOL_ITERATIONS + 50 } } }),
    );
    const personaId = Object.keys(usePersonas.getState().byId)[0]!;

    const seen = await dispatchAndCapture(personaId);
    expect(seen.maxToolRounds).toBe(TOOL_ITERATIONS);
  });

  it('(paired) a persona with no preference passes maxToolRounds undefined — the engine default applies', async () => {
    await usePersonas.getState().save(persona());
    const personaId = Object.keys(usePersonas.getState().byId)[0]!;

    const seen = await dispatchAndCapture(personaId);
    expect(seen.maxToolRounds).toBeUndefined();
  });
});

describe('confirmPolicy: always-ask reaches the engine as confirmEachCall', () => {
  it('is present, and actually asks (through requestApproval) when invoked', async () => {
    let asked = 0;

    await usePersonas.getState().save(
      persona({ agentConfig: { toolPolicy: { confirmPolicy: 'always-ask' } } }),
    );
    const personaId = Object.keys(usePersonas.getState().byId)[0]!;

    const seen = await dispatchAndCapture(personaId, async () => {
      asked += 1;
      return true;
    });
    expect(seen.confirmEachCall).toBeInstanceOf(Function);

    // Simulate the engine consulting it for a non-destination call — this is
    // the exact gap the review found: computed and then never called.
    const allowed = await seen.confirmEachCall!({ type: 'tool_use', id: 'c0', name: 'calculator', input: {} });
    expect(allowed).toBe(true);
    expect(asked).toBeGreaterThan(0);
  });

  it('(paired) app-default (or absent) never passes a confirmEachCall — a non-destination tool still runs silently', async () => {
    await usePersonas.getState().save(
      persona({ agentConfig: { toolPolicy: { confirmPolicy: 'app-default' } } }),
    );
    const personaId = Object.keys(usePersonas.getState().byId)[0]!;

    const seen = await dispatchAndCapture(personaId);
    expect(seen.confirmEachCall).toBeUndefined();
  });
});

describe('confirmPolicy: always-ask overrides a standing conversation-scoped egress grant', () => {
  /** Gives the freshly-created chat a real, standing "for this conversation" grant. */
  function grantChatEgress(): void {
    const chat = useChats.getState().chats[0]!;
    useChats.setState({
      chats: useChats.getState().chats.map((entry) =>
        entry.id === chat.id
          ? { ...entry, egressGrants: [{ connectionId: 'conn_openai', grantedAt: Date.now() }] }
          : entry,
      ),
    });
  }

  it('isGranted refuses even a connection the chat already holds a grant for', async () => {
    await usePersonas.getState().save(
      persona({ agentConfig: { toolPolicy: { confirmPolicy: 'always-ask' } } }),
    );
    const personaId = Object.keys(usePersonas.getState().byId)[0]!;
    await useChats.getState().newChat({ personaId });
    grantChatEgress();
    // Positive control: the grant just injected is real and `holdsGrant`
    // would honour it on its own — proven against a plain, non-always-ask
    // persona in the paired test below.

    let seen: SeenRequest | null = null;
    useApp.setState({
      toasts: [],
      connections: [OPENAI],
      requestApproval: async () => true,
      engine: {
        async *stream(request: SeenRequest) {
          seen = request;
          yield { type: 'done', text: 'ok', provenance: {}, stats: { promptTokens: 0, completionTokens: 0 } };
        },
      } as never,
    });
    await useChats.getState().send('hello');
    if (!seen) throw new Error('engine.stream was never called');

    expect((seen as SeenRequest).egress?.isGranted('conn_openai')).toBe(false);
  });

  it('(paired) app-default HONOURS the same standing grant — proves the override above is real, not coincidental', async () => {
    await usePersonas.getState().save(persona());
    const personaId = Object.keys(usePersonas.getState().byId)[0]!;
    await useChats.getState().newChat({ personaId });
    grantChatEgress();

    let seen: SeenRequest | null = null;
    useApp.setState({
      toasts: [],
      connections: [OPENAI],
      requestApproval: async () => true,
      engine: {
        async *stream(request: SeenRequest) {
          seen = request;
          yield { type: 'done', text: 'ok', provenance: {}, stats: { promptTokens: 0, completionTokens: 0 } };
        },
      } as never,
    });
    await useChats.getState().send('hello');
    if (!seen) throw new Error('engine.stream was never called');

    expect((seen as SeenRequest).egress?.isGranted('conn_openai')).toBe(true);
  });
});
