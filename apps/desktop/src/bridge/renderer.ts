/**
 * The renderer-process half of the plugin bridge.
 *
 * Two layers, and the split is the security boundary:
 *
 *   `createRendererBridge` runs in the PRELOAD. It is the only thing with an
 *   `ipcRenderer` in scope, it owns the callback table, and it derives every
 *   channel name from the boot manifest. Five functions are exposed through
 *   `contextBridge`; the page gets no `ipcRenderer`, no `require`, no
 *   `process`, and no way to name a channel the manifest does not contain.
 *
 *   `capacitor-shim.ts` runs in the PAGE. It seeds the two globals the real
 *   `@capacitor/core` reads at load, so `registerPlugin('LlamaCpp', …)` in
 *   `src/` resolves to these five functions and `src/` needs no change at all.
 *   Reproducing Capacitor's proxy ourselves would have been the obvious move
 *   and the wrong one: the semantics that matter — `addListener` resolving to
 *   a `ListenerHandle`, the callback-id round trip, `removeAllListeners` — are
 *   then reproduced from a reading of Capacitor rather than BEING Capacitor.
 *
 * Neither layer imports Electron. `RendererIpc` is the three-method slice of
 * `ipcRenderer` this needs, which is what makes the whole thing testable
 * against a fake port instead of a launched window.
 */

import {
  BOOTSTRAP_CHANNEL,
  EVENT_CHANNEL,
  LISTENER_ADD_CHANNEL,
  LISTENER_REMOVE_ALL_CHANNEL,
  LISTENER_REMOVE_CHANNEL,
  methodChannel,
} from './channels.js';
import { assertCloneable } from './clone.js';
import type { EventPayload } from './plugin-host.js';
import type { BootManifest, WireError } from './protocol.js';
import { fromWireError } from './protocol.js';

/** The slice of `ipcRenderer` the preload actually uses. */
export interface RendererIpc {
  invoke(channel: string, payload: unknown): Promise<unknown>;
  sendSync(channel: string): unknown;
  on(channel: string, listener: (payload: unknown) => void): void;
}

/**
 * What main answers with. Never a raw rejection.
 *
 * Electron flattens a rejected `ipcMain.handle` into a string with the stack
 * glued on, losing any `code`. Answering with a discriminated result instead
 * is what lets `HANDLE_LOST` survive the trip — and `HANDLE_LOST` is the
 * difference between an adapter that recovers from a host restart and one that
 * is wedged until the app is relaunched.
 */
export type InvokeResult =
  | { readonly ok: true; readonly data: unknown }
  | { readonly ok: false; readonly error: WireError };

/**
 * The object `contextBridge.exposeInMainWorld` publishes.
 *
 * Five functions. The page's entire reachable surface. `BRIDGE_KEYS` below is
 * the same list as data so the preload and the test assert one thing.
 */
export interface DesktopBridge {
  getBootstrap(): BootManifest;
  invoke(pluginName: string, method: string, args: readonly unknown[]): Promise<unknown>;
  addListener(
    pluginName: string,
    eventName: string,
    callback: (data: unknown) => void,
  ): Promise<number>;
  removeListener(subscriptionId: number): Promise<void>;
  removeAllListeners(pluginName: string): Promise<void>;
}

/** The exact allowlist, as data. Nothing else is exposed to the page. */
export const BRIDGE_KEYS: readonly string[] = Object.freeze([
  'getBootstrap',
  'invoke',
  'addListener',
  'removeListener',
  'removeAllListeners',
]);

/** The global the preload publishes the bridge on. */
export const BRIDGE_GLOBAL = '__chatterangDesktop';

interface CallbackRecord {
  readonly pluginName: string;
  readonly eventName: string;
  readonly callback: (data: unknown) => void;
}

function unwrap(answer: unknown): unknown {
  const result = answer as InvokeResult | undefined;
  if (result === undefined || typeof result !== 'object') {
    throw new Error('desktop bridge: main answered with a value that is not an invoke result.');
  }
  if (result.ok) return result.data;
  throw fromWireError(result.error);
}

/**
 * Build the preload bridge.
 *
 * The manifest is fetched SYNCHRONOUSLY at construction, before any page
 * script runs, because `registerPlugin` in the page is synchronous and must
 * find a platform already present.
 *
 * @param ipc - the `ipcRenderer` slice.
 * @returns the five functions, and nothing else.
 */
export function createRendererBridge(ipc: RendererIpc): DesktopBridge {
  const manifest = ipc.sendSync(BOOTSTRAP_CHANNEL) as BootManifest;
  const callbacks = new Map<number, CallbackRecord>();
  let nextSubscriptionId = 1;

  const plugin = (pluginName: string): BootManifest['plugins'][number] => {
    const found = manifest.plugins.find((it) => it.name === pluginName);
    if (found === undefined) {
      throw new Error(
        `desktop bridge: no plugin named "${pluginName}" on this platform. ` +
          `Available: ${manifest.plugins.map((it) => it.name).join(', ') || '(none)'}.`,
      );
    }
    return found;
  };

  ipc.on(EVENT_CHANNEL, (raw: unknown) => {
    const payload = raw as EventPayload;
    const record = callbacks.get(payload.subscriptionId);
    // Both names are re-checked rather than trusted. A reloaded page restarts
    // its id counter at 1, so an id alone is not enough to prove an event
    // belongs to the callback now sitting at that slot.
    if (record === undefined) return;
    if (record.pluginName !== payload.pluginName || record.eventName !== payload.eventName) return;
    record.callback(payload.data);
  });

  const bridge: DesktopBridge = {
    getBootstrap: () => manifest,

    async invoke(pluginName: string, method: string, args: readonly unknown[]): Promise<unknown> {
      const definition = plugin(pluginName);
      // Refused HERE, before a channel string exists. This is the property the
      // whole design rests on: a page-supplied name cannot become a channel.
      if (!definition.methods.includes(method)) {
        throw new Error(
          `desktop bridge: "${pluginName}" has no method "${method}". ` +
            `It has: ${definition.methods.join(', ')}.`,
        );
      }
      assertCloneable(args, `${pluginName}.${method}(arguments)`);
      return unwrap(await ipc.invoke(methodChannel(pluginName, method), args));
    },

    async addListener(
      pluginName: string,
      eventName: string,
      callback: (data: unknown) => void,
    ): Promise<number> {
      const definition = plugin(pluginName);
      if (!definition.events.includes(eventName)) {
        throw new Error(
          `desktop bridge: "${pluginName}" emits no event "${eventName}". ` +
            `It emits: ${definition.events.join(', ') || '(none)'}.`,
        );
      }
      const subscriptionId = nextSubscriptionId++;
      callbacks.set(subscriptionId, { pluginName, eventName, callback });
      try {
        unwrap(await ipc.invoke(LISTENER_ADD_CHANNEL, { pluginName, eventName, subscriptionId }));
      } catch (error) {
        callbacks.delete(subscriptionId);
        throw error;
      }
      return subscriptionId;
    },

    async removeListener(subscriptionId: number): Promise<void> {
      // Dropped locally FIRST. If the round trip fails the page must still
      // stop hearing the event; a listener that survives its own `remove()` is
      // how a torn-down component keeps writing into dead state.
      callbacks.delete(subscriptionId);
      unwrap(await ipc.invoke(LISTENER_REMOVE_CHANNEL, { subscriptionId }));
    },

    async removeAllListeners(pluginName: string): Promise<void> {
      for (const [id, record] of callbacks) {
        if (record.pluginName === pluginName) callbacks.delete(id);
      }
      unwrap(await ipc.invoke(LISTENER_REMOVE_ALL_CHANNEL, { pluginName }));
    },
  };

  return bridge;
}
