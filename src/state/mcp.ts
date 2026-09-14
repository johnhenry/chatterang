/**
 * Remote MCP server state.
 *
 * Servers are configured here, connected here, and their tools registered into
 * the shared tool registry here. The privacy rules live in `ai/mcp/tools.ts`;
 * this module's job is lifecycle.
 *
 * One thing worth stating plainly: connecting to a server does NOT make its
 * tools usable in a chat. Every MCP tool is `sensitive`, so it still has to be
 * enabled per chat like the `bash` tool. Connecting only makes them offerable.
 *
 * And the converse: adding or removing a server switches that NAME's tools off
 * in every chat. Tool ids are keyed on the server name, so without this an
 * enable given to one server would carry over to a different server that later
 * took the same name, at a different URL.
 */

import { create } from 'zustand';

import { db } from '@/db';
import { newId } from '@/domain/chat';
import { validateServerUrl, type McpServerConfig, type McpServerState } from '@/domain/mcp';
import { mcpManager, type McpToolDescriptor } from '@/ai/mcp/client';
import { createMcpTool } from '@/ai/mcp/tools';
import { toolRegistry } from '@/ai/tools/registry';

/*
 * Imported lazily to avoid a cycle, as `confirm` below is: state/app builds the
 * engine, which reads the tool registry this writes into.
 */
async function pruneMcpToolsFor(serverName: string): Promise<void> {
  await (await import('@/state/app')).pruneMcpToolsFor(serverName);
}

interface McpState {
  servers: McpServerConfig[];
  states: Record<string, McpServerState>;
  connecting: boolean;

  load: () => Promise<void>;
  add: (input: { name: string; url: string; token?: string }) => Promise<string | null>;
  remove: (id: string) => Promise<void>;
  toggle: (id: string, enabled: boolean) => Promise<void>;
  /** Rebuild the client from the enabled servers and re-register their tools. */
  reconnect: () => Promise<void>;
}

/** Tool ids this module owns, so a reconnect removes exactly what it added. */
let registeredIds: string[] = [];

export const useMcp = create<McpState>((set, get) => ({
  servers: [],
  states: {},
  connecting: false,

  async load() {
    const servers = await db.mcpServers.orderBy('createdAt').toArray();
    set({ servers });
    if (servers.some((s) => s.enabled)) await get().reconnect();
  },

  async add({ name, url, token }) {
    const validated = validateServerUrl(url);
    if (!validated.ok) return validated.reason;

    const trimmed = name.trim();
    if (!trimmed) return 'Give the server a short name.';
    // The name namespaces every tool it exposes, so a collision would make two
    // servers' tools indistinguishable to the model.
    if (get().servers.some((s) => s.name === trimmed)) return `There is already a server called “${trimmed}”.`;

    // A new server has a new id, so no chat can legitimately have its tools on
    // yet. Any `mcp:<name>.*` a chat still holds was given to an EARLIER server
    // under this name — including one removed before removal pruned anything —
    // and would otherwise apply to this one unasked. Pruned before the server is
    // stored or connected, so there is no moment its tools are registered while
    // a stale enable still points at them.
    await pruneMcpToolsFor(trimmed);

    const server: McpServerConfig = {
      id: newId('mcp'),
      name: trimmed,
      url: validated.url,
      token: token?.trim() || undefined,
      enabled: true,
      createdAt: Date.now(),
    };
    await db.mcpServers.put(server);
    set({ servers: [...get().servers, server] });
    await get().reconnect();
    return null;
  },

  async remove(id) {
    const removed = get().servers.find((s) => s.id === id);
    await db.mcpServers.delete(id);
    set({
      servers: get().servers.filter((s) => s.id !== id),
      states: Object.fromEntries(Object.entries(get().states).filter(([k]) => k !== id)),
    });
    if (removed) await pruneMcpToolsFor(removed.name);
    await get().reconnect();
  },

  // Deliberately does NOT prune. Switching a server off and on again brings
  // back the same row at the same URL, so an enable given to it is still an
  // enable given to that server. Removal is what ends that.
  async toggle(id, enabled) {
    await db.mcpServers.update(id, { enabled });
    set({ servers: get().servers.map((s) => (s.id === id ? { ...s, enabled } : s)) });
    await get().reconnect();
  },

  async reconnect() {
    // Always clear first. A server that has been disabled or removed must lose
    // its tools even if the reconnect below fails — otherwise a failed connect
    // leaves callable tools pointing at a server we are no longer talking to.
    for (const id of registeredIds) toolRegistry.unregister(id);
    registeredIds = [];

    const enabled = get().servers.filter((s) => s.enabled);
    set({
      connecting: true,
      states: Object.fromEntries(
        enabled.map((s) => [s.id, { id: s.id, status: 'connecting' as const, toolCount: 0 }]),
      ),
    });

    try {
      await mcpManager.configure(enabled);
      const descriptors = enabled.length ? await mcpManager.listTools() : [];
      const byServer = new Map<string, McpToolDescriptor[]>();
      for (const d of descriptors) {
        byServer.set(d.server, [...(byServer.get(d.server) ?? []), d]);
      }

      const states: Record<string, McpServerState> = {};
      for (const server of enabled) {
        const tools = byServer.get(server.name) ?? [];
        let registered = 0;
        for (const descriptor of tools) {
          const tool = createMcpTool(descriptor, {
            serverUrl: server.url,
            // Imported lazily to avoid a cycle: state/app builds the engine,
            // which reads the tool registry this writes into.
            confirm: async (action) => (await import('@/state/app')).useApp.getState().requestApproval(action),
            call: (s, n, args, signal) => mcpManager.callTool(s, n, args, signal),
          });
          // `null` when the server's schema failed validation. Skipped rather
          // than registered with a trimmed one -- see src/ai/mcp/schema.ts --
          // and not counted, so the server's tool count reflects what the
          // model can actually call.
          if (!tool) continue;
          toolRegistry.register(tool);
          registeredIds.push(tool.id);
          registered += 1;
        }
        states[server.id] = { id: server.id, status: 'ready', toolCount: registered };
      }
      set({ states, connecting: false });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      set({
        connecting: false,
        states: Object.fromEntries(
          enabled.map((s) => [s.id, { id: s.id, status: 'error' as const, toolCount: 0, error: message }]),
        ),
      });
    }
  },
}));
