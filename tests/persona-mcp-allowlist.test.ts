/**
 * MCP server allowlist narrowing (#23, owner ruling 2026-09-27).
 *
 * "mcpServerIds only select among servers the user already added and
 * enabled (a persona can never carry an MCP server definition/URL/token)."
 * `narrowToolPolicy`'s `allowedMcpServerIds` parameter is the enforcement;
 * this file drives it with the shapes that matter — a server never added, a
 * server added but switched off, and one both added and on — and then
 * exercises the real `newChat` to prove the narrowed list is what actually
 * lands on the chat, not just what a unit test of the pure function would
 * show.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ProviderConnection } from '@/ai/providers';
import type { McpServerConfig } from '@/domain/mcp';
import type { Persona } from '@/domain/persona';

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
  mcpServers: { put: vi.fn(async () => {}), delete: vi.fn(async () => {}), toArray: async () => [] },
}));

vi.mock('@/db', () => ({
  db: tables,
  deleteChat: vi.fn(async () => {}),
  readSetting: async (_key: string, fallback: unknown) => fallback,
  writeSetting: vi.fn(async () => {}),
}));

const { useChats, narrowToolPolicy } = await import('@/state/chat');
const { useApp } = await import('@/state/app');
const { usePersonas } = await import('@/state/personas');
const { useMcp } = await import('@/state/mcp');

function server(overrides: Partial<McpServerConfig>): McpServerConfig {
  return { id: 'mcp_added', name: 'notes', url: 'https://notes.example/mcp', enabled: true, createdAt: 0, ...overrides };
}

describe('narrowToolPolicy — mcpServerIds', () => {
  it('drops a server the persona names that was never added', () => {
    const result = narrowToolPolicy([], { toolPolicy: { mcpServerIds: ['mcp_unknown'] } }, ['mcp_added']);
    expect(result.mcpServerIds).toEqual([]);
  });

  it('drops a server that was added but is switched off', () => {
    // Only enabled servers are passed in as `allowedMcpServerIds` by the
    // caller (mirroring newChat below), so an added-but-disabled server never
    // reaches this function's allow-list in the first place.
    const result = narrowToolPolicy([], { toolPolicy: { mcpServerIds: ['mcp_added'] } }, []);
    expect(result.mcpServerIds).toEqual([]);
  });

  it('keeps a server that is both added and enabled', () => {
    const result = narrowToolPolicy([], { toolPolicy: { mcpServerIds: ['mcp_added'] } }, ['mcp_added']);
    expect(result.mcpServerIds).toEqual(['mcp_added']);
  });

  it('never invents a server id the persona did not ask for, even if it is allowed', () => {
    const result = narrowToolPolicy([], { toolPolicy: {} }, ['mcp_added']);
    expect(result.mcpServerIds).toEqual([]);
  });
});

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

describe('newChat wires the MCP allowlist narrowing into chat.mcpServerIds', () => {
  beforeEach(() => {
    useApp.setState({ connections: [] as ProviderConnection[] });
    useMcp.setState({
      servers: [
        server({ id: 'mcp_on', enabled: true }),
        server({ id: 'mcp_off', enabled: false }),
      ],
    } as never);
    usePersonas.setState({
      byId: {
        p1: persona({
          agentConfig: { toolPolicy: { mcpServerIds: ['mcp_on', 'mcp_off', 'mcp_never_added'] } },
        }),
      },
      order: ['p1'],
    } as never);
  });

  it('keeps only the server that is both added and enabled', async () => {
    await useChats.getState().newChat({ personaId: 'p1' });
    const chat = useChats.getState().chats[0];
    expect(chat?.mcpServerIds).toEqual(['mcp_on']);
  });
});
