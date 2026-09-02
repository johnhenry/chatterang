import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The persisted half of the tool-output rule.
 *
 * `tests/privacy.test.ts` proves the engine withholds without a grant and
 * sends with one. This proves the grant is the thing the user actually
 * decided about: scoped to one conversation and one connection, not
 * duplicated, and — the part that is easy to leave out — dropped when the
 * connection it named goes away. A permission that outlives its connection
 * silently applies to whatever next claims that id.
 */

const chatsTable = vi.hoisted(() => ({ put: vi.fn(async () => {}) }));

vi.mock('@/db', () => ({
  db: {
    chats: chatsTable,
    messages: { put: vi.fn(async () => {}), where: () => ({ equals: () => ({ sortBy: async () => [] }) }) },
    connections: { delete: vi.fn(async () => {}), put: vi.fn(async () => {}), toArray: async () => [] },
  },
  deleteChat: vi.fn(async () => {}),
  readSetting: async (_key: string, fallback: unknown) => fallback,
  writeSetting: vi.fn(async () => {}),
}));

const { useChats } = await import('@/state/chat');
const { useApp } = await import('@/state/app');

function seed(): void {
  useChats.setState({
    chats: [
      {
        id: 'c1',
        title: 'One',
        mode: 'chat',
        personaId: null,
        modelId: null,
        sampler: null,
        tools: ['shell'],
        showThinking: false,
        createdAt: 1,
        updatedAt: 1,
        messageCount: 0,
        preview: '',
      },
      {
        id: 'c2',
        title: 'Two',
        mode: 'chat',
        personaId: null,
        modelId: null,
        sampler: null,
        tools: [],
        showThinking: false,
        createdAt: 2,
        updatedAt: 2,
        messageCount: 0,
        preview: '',
      },
    ],
  });
}

const grantsOf = (id: string): readonly { connectionId: string }[] =>
  useChats.getState().chats.find((chat) => chat.id === id)?.egressGrants ?? [];

describe('a tool-output grant', () => {
  beforeEach(() => {
    seed();
    chatsTable.put.mockClear();
  });

  it('names one conversation and one connection, and is persisted', async () => {
    await useChats.getState().grantEgress('c1', 'conn_openai');

    expect(grantsOf('c1').map((grant) => grant.connectionId)).toEqual(['conn_openai']);
    // The other conversation gains nothing. This is the whole reason the grant
    // is per-chat rather than a setting.
    expect(grantsOf('c2')).toEqual([]);
    expect(chatsTable.put).toHaveBeenCalledTimes(1);
  });

  it('is not duplicated when the same destination is granted twice', async () => {
    await useChats.getState().grantEgress('c1', 'conn_openai');
    chatsTable.put.mockClear();
    await useChats.getState().grantEgress('c1', 'conn_openai');

    expect(grantsOf('c1')).toHaveLength(1);
    expect(chatsTable.put).not.toHaveBeenCalled();
  });

  it('is dropped everywhere when its connection is removed', async () => {
    await useChats.getState().grantEgress('c1', 'conn_openai');
    await useChats.getState().grantEgress('c2', 'conn_openai');
    await useChats.getState().grantEgress('c2', 'conn_ollama');

    await useApp.getState().removeConnection('conn_openai');

    expect(grantsOf('c1')).toEqual([]);
    // A grant for a different connection is untouched — otherwise this would
    // pass by clearing everything, which is not the same rule.
    expect(grantsOf('c2').map((grant) => grant.connectionId)).toEqual(['conn_ollama']);
  });

  it('is dropped when its connection is merely switched off', async () => {
    // Disabling is the reversible half of removing, and it takes the same
    // route through `disconnectProvider`. A grant that survived it would apply
    // again the moment the switch went back on, without being asked for.
    useApp.setState({
      connections: [
        {
          id: 'conn_openai',
          providerId: 'openai',
          label: 'OpenAI',
          apiKey: '',
          baseUrl: '',
          defaultModel: 'gpt-4o-mini',
          enabled: true,
          models: [],
          createdAt: 0,
        },
      ],
    });
    await useChats.getState().grantEgress('c1', 'conn_openai');

    await useApp.getState().toggleConnection('conn_openai', false);

    expect(grantsOf('c1')).toEqual([]);
  });
});
