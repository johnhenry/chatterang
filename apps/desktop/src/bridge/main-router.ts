/**
 * Channel -> operation, as a lookup table built from the manifest.
 *
 * The routing lives here rather than in `main.ts` for two reasons. The first
 * is that a test driving the bridge end to end must exercise the SAME routing
 * the app uses; re-implementing it in the test would leave the real one
 * unchecked and prove only that the test agrees with itself. The second is
 * structural: because the table is built once from the manifest, an incoming
 * channel string is either a key in it or it is refused — there is no parsing
 * step in which a crafted name could be pulled apart into a plugin and a
 * method the manifest never declared.
 *
 * `answer()` is the other half of the contract: every handler resolves with an
 * `InvokeResult`, never rejects. Electron flattens a rejected `ipcMain.handle`
 * into a string and drops any `code`, and `HANDLE_LOST` has to survive.
 */

import {
  LISTENER_ADD_CHANNEL,
  LISTENER_REMOVE_ALL_CHANNEL,
  LISTENER_REMOVE_CHANNEL,
  methodChannel,
} from './channels.js';
import type { PluginHost } from './plugin-host.js';
import type { InvokeResult } from './renderer.js';
import type { BootManifest } from './protocol.js';
import { toWireError } from './protocol.js';

export interface MainRouter {
  /** What a trusted renderer is told at boot. */
  bootstrap(): BootManifest;
  /** Every channel `ipcMain.handle` must be registered for. */
  channels(): readonly string[];
  /** Route one invoke. Always resolves; never rejects. */
  handle(senderId: number, channel: string, payload: unknown): Promise<InvokeResult>;
}

interface AddPayload {
  pluginName: string;
  eventName: string;
  subscriptionId: number;
}

export function createMainRouter(host: PluginHost): MainRouter {
  const manifest = host.manifest();
  const methods = new Map<string, { plugin: string; method: string }>();
  for (const plugin of manifest.plugins) {
    for (const method of plugin.methods) {
      methods.set(methodChannel(plugin.name, method), { plugin: plugin.name, method });
    }
  }

  const channels = [
    LISTENER_ADD_CHANNEL,
    LISTENER_REMOVE_CHANNEL,
    LISTENER_REMOVE_ALL_CHANNEL,
    ...methods.keys(),
  ];

  const answer = async (work: () => Promise<unknown>): Promise<InvokeResult> => {
    try {
      return { ok: true, data: await work() };
    } catch (error) {
      return { ok: false, error: toWireError(error) };
    }
  };

  return {
    bootstrap: () => manifest,
    channels: () => channels,
    handle: (senderId, channel, payload) =>
      answer(async () => {
        const target = methods.get(channel);
        if (target !== undefined) {
          return host.invoke(senderId, target.plugin, target.method, (payload ?? []) as unknown[]);
        }
        switch (channel) {
          case LISTENER_ADD_CHANNEL: {
            const add = payload as AddPayload;
            host.addListener(senderId, add.pluginName, add.eventName, add.subscriptionId);
            return undefined;
          }
          case LISTENER_REMOVE_CHANNEL: {
            host.removeListener(senderId, (payload as { subscriptionId: number }).subscriptionId);
            return undefined;
          }
          case LISTENER_REMOVE_ALL_CHANNEL: {
            host.removeAllListeners(senderId, (payload as { pluginName: string }).pluginName);
            return undefined;
          }
          default:
            throw new Error(`desktop bridge: no handler for channel "${channel}".`);
        }
      }),
  };
}
