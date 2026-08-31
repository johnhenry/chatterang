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
 *
 * WHY NOTHING HERE THROWS, AND WHY NOTHING HERE UNWRAPS.
 *
 * There is a THIRD boundary, and it is the one that is easy to forget because
 * it has no port and no channel: `contextBridge`. Everything these functions
 * return is copied into the main world by Electron's own serializer, and that
 * serializer reduces an `Error` to its message and stack. Custom own
 * properties — `code` — are DROPPED.
 *
 * So this layer never rebuilds an `Error`. It resolves the `{ok,error}` result
 * as PLAIN DATA and lets `capacitor-shim.ts`, which runs in the main world on
 * the far side of that copy, rebuild the `Error` there. `HANDLE_LOST` is the
 * whole reason: `src/ai/backends/llama-cpp.ts` drops its cached model handle
 * when it sees that code and reloads. Rebuild the error here and the page gets
 * a bare `Error` with the right message and no code, the adapter keeps sending
 * a handle no host has any more, and every retry fails identically until the
 * app is relaunched. That recovery path was unreachable in the shipped build.
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
import { toWireError } from './protocol.js';

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
 *
 * Four of the five resolve an {@link InvokeResult} and NEVER reject — see the
 * note at the top of this file. The page-facing ergonomics (a value, or a
 * throw carrying `code`) are restored in the main world by
 * `installCapacitorShim`, on the near side of nothing.
 */
export interface PreloadBridge {
  getBootstrap(): BootManifest;
  invoke(pluginName: string, method: string, args: readonly unknown[]): Promise<InvokeResult>;
  /** On success, `data` is the subscription id. */
  addListener(
    pluginName: string,
    eventName: string,
    callback: (data: unknown) => void,
  ): Promise<InvokeResult>;
  removeListener(subscriptionId: number): Promise<InvokeResult>;
  removeAllListeners(pluginName: string): Promise<InvokeResult>;
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
export function createRendererBridge(ipc: RendererIpc): PreloadBridge {
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

  /** A local refusal, in the same shape as a refusal from main. */
  const refuse = (error: unknown): InvokeResult => ({ ok: false, error: toWireError(error) });

  const bridge: PreloadBridge = {
    getBootstrap: () => manifest,

    async invoke(
      pluginName: string,
      method: string,
      args: readonly unknown[],
    ): Promise<InvokeResult> {
      try {
        const definition = plugin(pluginName);
        // Refused HERE, before a channel string exists. This is the property
        // the whole design rests on: a page-supplied name cannot become a
        // channel.
        if (!definition.methods.includes(method)) {
          throw new Error(
            `desktop bridge: "${pluginName}" has no method "${method}". ` +
              `It has: ${definition.methods.join(', ')}.`,
          );
        }
        assertCloneable(args, `${pluginName}.${method}(arguments)`);
      } catch (error) {
        return refuse(error);
      }
      return (await ipc.invoke(methodChannel(pluginName, method), args)) as InvokeResult;
    },

    async addListener(
      pluginName: string,
      eventName: string,
      callback: (data: unknown) => void,
    ): Promise<InvokeResult> {
      let subscriptionId: number;
      try {
        const definition = plugin(pluginName);
        if (!definition.events.includes(eventName)) {
          throw new Error(
            `desktop bridge: "${pluginName}" emits no event "${eventName}". ` +
              `It emits: ${definition.events.join(', ') || '(none)'}.`,
          );
        }
        subscriptionId = nextSubscriptionId++;
        callbacks.set(subscriptionId, { pluginName, eventName, callback });
      } catch (error) {
        return refuse(error);
      }
      const answer = (await ipc.invoke(LISTENER_ADD_CHANNEL, {
        pluginName,
        eventName,
        subscriptionId,
      })) as InvokeResult;
      if (!answer.ok) {
        callbacks.delete(subscriptionId);
        return answer;
      }
      // The subscription id, not whatever main answered with — Capacitor uses
      // this value as the callback id it later hands to `removeListener`.
      return { ok: true, data: subscriptionId };
    },

    async removeListener(subscriptionId: number): Promise<InvokeResult> {
      // Dropped locally FIRST. If the round trip fails the page must still
      // stop hearing the event; a listener that survives its own `remove()` is
      // how a torn-down component keeps writing into dead state.
      callbacks.delete(subscriptionId);
      return (await ipc.invoke(LISTENER_REMOVE_CHANNEL, { subscriptionId })) as InvokeResult;
    },

    async removeAllListeners(pluginName: string): Promise<InvokeResult> {
      for (const [id, record] of callbacks) {
        if (record.pluginName === pluginName) callbacks.delete(id);
      }
      return (await ipc.invoke(LISTENER_REMOVE_ALL_CHANNEL, { pluginName })) as InvokeResult;
    },
  };

  return bridge;
}
