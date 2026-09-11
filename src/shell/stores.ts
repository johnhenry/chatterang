/**
 * Adapter from the zustand stores to the shell's `ShellStores` interface.
 *
 * The indirection exists so `commands.ts` can be tested without the app: the
 * shell's tests build a plain object of the same shape and never touch
 * IndexedDB, React, or a store.
 */

import { db } from '@/db';
import { CATALOG } from '@/data/catalog';
import { destinationHost } from '@/domain/mcp';
import type { ShellStores } from '@/shell/commands';
import { useApp } from '@/state/app';
import { useMcp } from '@/state/mcp';
import { useBench } from '@/state/bench';
import { useChats } from '@/state/chat';
import { useModels } from '@/state/models';
import { useMounts } from '@/shell/real-fs';
import { usePersonas, personaList } from '@/state/personas';

export function liveStores(): ShellStores {
  return {
    models: () => {
      const store = useModels.getState();
      return {
        installed: store.installed,
        activeModelId: store.activeModelId,
        install: async (id) => {
          const manifest = CATALOG.find((entry) => entry.id === id);
          if (manifest) await store.install(manifest);
        },
        remove: (id) => store.remove(id),
        setActive: (id) => store.setActive(id),
      };
    },

    catalog: () =>
      CATALOG.map((manifest) => ({
        id: manifest.id,
        name: manifest.name,
        sizeBytes: manifest.sizeBytes,
        capabilities: manifest.capabilities,
        bestFor: manifest.bestFor,
      })),

    chats: () => {
      const store = useChats.getState();
      return {
        list: store.chats,
        activeChatId: store.activeChatId,
        // Read straight from the database rather than the open thread, so
        // `/chats` covers every conversation and not just the current one.
        messagesFor: (chatId) => db.messages.where('chatId').equals(chatId).sortBy('createdAt'),
        open: (chatId) => store.openChat(chatId),
        create: () => store.newChat(),
      };
    },

    personas: () =>
      personaList(usePersonas.getState()).map((persona) => ({
        id: persona.id,
        name: persona.name,
        kind: persona.kind,
        tagline: persona.tagline,
        builtin: persona.builtin,
      })),

    providers: () => {
      const store = useApp.getState();
      return {
        // Deliberately projects label, model and state — never `apiKey`.
        list: store.connections.map((connection) => ({
          id: connection.id,
          label: connection.label,
          enabled: connection.enabled,
          defaultModel: connection.defaultModel,
        })),
        toggle: (id, enabled) => store.toggleConnection(id, enabled),
      };
    },

    device: () => {
      const device = useApp.getState().device;
      if (!device) return null;
      return {
        chipset: device.chipset,
        totalMemory: device.totalMemory,
        cpuCores: device.cpuCores,
        backends: device.backends,
        simulated: device.simulated,
        engineVersion: device.engineVersion,
      };
    },

    benchmarks: () =>
      useBench.getState().runs.map((run) => ({
        modelName: run.modelName,
        generateTokensPerSecond: run.generateTokensPerSecond,
        backend: run.backend,
        createdAt: run.createdAt,
      })),

    runBenchmark: (modelId) => useBench.getState().run(modelId),

    // `privacy` names these, because an MCP tool's arguments leave the device
    // whether or not a provider is enabled — which is the case the old copy
    // called "nothing else". Projects the host rather than the URL: the token
    // and the path are not the user's question, and the host is.
    mcpServers: () =>
      useMcp.getState().servers.map((server) => ({
        name: server.name,
        host: destinationHost(server.url),
        enabled: server.enabled,
      })),

    // `mount` lists and withdraws these; `privacy` names them, because a file
    // read out of a granted folder reaches the model exactly as a projected
    // chat does. Read from the store rather than the host on every call: the
    // store is a mirror the host refreshes, and `list` has to be synchronous
    // for `ShellStores`.
    mounts: () => {
      const store = useMounts.getState();
      return {
        list: store.grants,
        canGrant: store.canGrant,
        grant: (writable) => store.grant(writable),
        revoke: (id) => store.revoke(id),
      };
    },
  };
}
