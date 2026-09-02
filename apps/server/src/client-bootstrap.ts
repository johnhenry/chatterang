/**
 * The script the browser runs BEFORE the app bundle, and the reason a served
 * deployment is not a demo of the development shims.
 *
 * ── WHAT GOES WRONG WITHOUT IT, MEASURED ────────────────────────────────
 *
 * `src/plugins/llama-cpp/index.ts` calls `registerPlugin('LlamaCpp', {web: …})`
 * while the bundle is evaluating. Driving the real `@capacitor/core` in Node:
 *
 *   CapacitorCustomPlatform = {name:'server'}, no plugin header seeded
 *     -> getPlatform() answers 'server'                        (as intended)
 *     -> registerPlugin(...) resolves to the WEB implementation (NOT intended)
 *
 * `src/plugins/llama-cpp/web.ts` is the development shim: it synthesises prose
 * and reports `simulated: true`. So a server that named the platform and
 * stopped there would stream convincing text while the machine's real
 * llama.cpp host sat idle — the failure that looks like success, which is the
 * most dangerous kind this milestone can ship.
 *
 * With the header seeded the same probe answers from the bridge instead. That
 * is what this file does, and it is why the capability row in
 * `src/lib/platform.ts` is the cheap half of adding a platform rather than the
 * whole of it.
 *
 * ── WHY IT IS TWO FUNCTIONS TURNED INTO SOURCE, NOT A BUNDLE ────────────
 *
 * `installCapacitorShim` in `apps/desktop/src/bridge/capacitor-shim.ts` already
 * knows how to seed `window.Capacitor` from a {@link PreloadBridge} — headers,
 * `nativePromise`, `nativeCallback`, the `addListener` callback-id round trip —
 * and `tests/desktop-bridge.test.ts` drives that code against the real
 * `@capacitor/core`. Reproducing it here would mean reproducing a reading of
 * Capacitor rather than reusing the thing that is tested against Capacitor.
 *
 * So this file supplies the OTHER half: a `PreloadBridge` whose transport is
 * `fetch` and `EventSource` instead of `ipcRenderer`. The two are concatenated
 * with `Function.prototype.toString()` — the same trick, for the same reason —
 * and served as one file.
 *
 * SELF-CONTAINED BY REQUIREMENT. {@link installServerBridge} references nothing
 * outside its own parameters. A call to a module-scope helper would typecheck,
 * bundle, and throw `ReferenceError` in the browser at startup, with the app
 * already committed to a platform that has no plugins.
 * `tests/server-bootstrap.test.ts` evaluates the generated STRING — not the
 * imported function — for exactly that reason, and injects the fault (a helper
 * hoisted out of the function) to confirm the test can see it.
 *
 * ── AND WHY IT IS SERVED, NOT SHIPPED IN `dist/` ────────────────────────
 *
 * `index.html` is the same file on web, iOS, Android and desktop. A script tag
 * added to it would load on all four, and the seeding it does is wrong on
 * every one of them. `apps/server` injects the tag into the HTML it serves and
 * nowhere else, so the other four targets are byte-identical to what they were.
 */

import { capacitorShimSource } from '@chatterang/desktop/bridge';
import type { BootManifest, InvokeResult, PreloadBridge } from '@chatterang/desktop/bridge';

import { EVENTS_PATH, RPC_PATH, SESSION_HEADER } from './wire.js';

/** The global the bootstrap publishes its bridge on, for the shim to find. */
export const SERVER_BRIDGE_GLOBAL = '__chatterangServer';

/** Everything the page needs to know, embedded in the served script. */
export interface ServerBridgeConfig {
  readonly manifest: BootManifest;
  readonly rpcPath: string;
  readonly eventsPath: string;
  readonly sessionHeader: string;
  readonly global: string;
}

/** The page-side globals this touches. Typed loosely; it runs in a browser. */
export interface BrowserTarget {
  fetch: (input: string, init?: unknown) => Promise<{
    ok: boolean;
    status: number;
    json: () => Promise<unknown>;
  }>;
  EventSource: new (url: string) => {
    onmessage: ((event: { data: string }) => void) | null;
    onerror: ((event: unknown) => void) | null;
    close: () => void;
  };
  [key: string]: unknown;
}

/**
 * Build the page's {@link PreloadBridge} over http, and publish it.
 *
 * SELF-CONTAINED — see the file header. Do not extract a helper out of this
 * function, and do not reference an import from inside it.
 *
 * @param target the page's global object (`window`).
 * @param config the manifest and the three endpoint facts, embedded by the
 *   server into the script it serves.
 */
export function installServerBridge(target: BrowserTarget, config: ServerBridgeConfig): void {
  const manifest = config.manifest;

  /*
   * THE SESSION ID IS NOT KNOWN YET, AND EVERY CALL WAITS FOR IT.
   *
   * The event stream is what creates the session, so until its first frame
   * arrives there is no id to authenticate a call with. Calls made in that
   * window are QUEUED rather than failed: the app's own boot sequence asks for
   * capabilities immediately, and a bridge whose first call races the stream
   * would fail differently depending on the machine it ran on.
   */
  let sessionId: string | null = null;
  let waiting: (() => void)[] = [];
  const callbacks = new Map<
    number,
    { pluginName: string; eventName: string; callback: (data: unknown) => void }
  >();
  let nextSubscriptionId = 1;

  const stream = new target.EventSource(config.eventsPath);
  stream.onmessage = (event: { data: string }): void => {
    let frame: {
      k?: string;
      id?: string;
      pluginName?: string;
      subscriptionId?: number;
      eventName?: string;
      data?: unknown;
    };
    try {
      frame = JSON.parse(event.data) as typeof frame;
    } catch {
      return;
    }
    if (frame.k === 'session' && typeof frame.id === 'string') {
      sessionId = frame.id;
      const queued = waiting;
      waiting = [];
      for (const resume of queued) resume();
      return;
    }
    if (frame.k !== 'event') return;
    const record = callbacks.get(Number(frame.subscriptionId));
    // Both names are re-checked rather than trusted, exactly as the preload
    // bridge does it: a reloaded page restarts its id counter at 1, so an id
    // alone is not proof that an event belongs to the callback at that slot.
    if (record === undefined) return;
    if (record.pluginName !== frame.pluginName || record.eventName !== frame.eventName) return;
    record.callback(frame.data);
  };

  const ready = async (): Promise<void> => {
    if (sessionId !== null) return;
    await new Promise<void>((resolve) => {
      waiting.push(resolve);
    });
  };

  const send = async (body: unknown): Promise<InvokeResult> => {
    await ready();
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    headers[config.sessionHeader] = String(sessionId);
    try {
      const response = await target.fetch(config.rpcPath, {
        method: 'POST',
        credentials: 'same-origin',
        headers,
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        return {
          ok: false,
          error: { message: `chatterang server: the server refused this call (${response.status}).` },
        };
      }
      return (await response.json()) as InvokeResult;
    } catch (error) {
      // A transport failure is a refusal like any other. It must not reject:
      // the shim in the main world turns `{ok:false}` into a throw carrying
      // `code`, and a rejection here would arrive there as something it cannot
      // unwrap.
      return {
        ok: false,
        error: { message: error instanceof Error ? error.message : 'chatterang server: unreachable.' },
      };
    }
  };

  const definitionOf = (
    pluginName: string,
  ): { name: string; methods: readonly string[]; events: readonly string[] } => {
    const found = manifest.plugins.find((it) => it.name === pluginName);
    if (found === undefined) {
      throw new Error(
        `chatterang server: no plugin named "${pluginName}" on this platform. ` +
          `Available: ${manifest.plugins.map((it) => it.name).join(', ') || '(none)'}.`,
      );
    }
    return found;
  };

  const bridge: PreloadBridge = {
    getBootstrap: () => manifest,

    async invoke(
      pluginName: string,
      method: string,
      args: readonly unknown[],
    ): Promise<InvokeResult> {
      try {
        const definition = definitionOf(pluginName);
        // Refused HERE, before anything is sent. The server checks again — it
        // must, since it cannot trust a client — but a name the manifest does
        // not contain never becomes a request.
        if (!definition.methods.includes(method)) {
          throw new Error(
            `chatterang server: "${pluginName}" has no method "${method}". ` +
              `It has: ${definition.methods.join(', ')}.`,
          );
        }
      } catch (error) {
        return { ok: false, error: { message: (error as Error).message } };
      }
      return send({ k: 'invoke', plugin: pluginName, method, args });
    },

    async addListener(
      pluginName: string,
      eventName: string,
      callback: (data: unknown) => void,
    ): Promise<InvokeResult> {
      let subscriptionId: number;
      try {
        const definition = definitionOf(pluginName);
        if (!definition.events.includes(eventName)) {
          throw new Error(
            `chatterang server: "${pluginName}" emits no event "${eventName}". ` +
              `It emits: ${definition.events.join(', ') || '(none)'}.`,
          );
        }
        subscriptionId = nextSubscriptionId;
        nextSubscriptionId += 1;
        callbacks.set(subscriptionId, { pluginName, eventName, callback });
      } catch (error) {
        return { ok: false, error: { message: (error as Error).message } };
      }
      const answer = await send({ k: 'addListener', plugin: pluginName, event: eventName, subscriptionId });
      if (!answer.ok) {
        callbacks.delete(subscriptionId);
        return answer;
      }
      // The subscription id, not whatever the server answered with: Capacitor
      // uses this value as the callback id it later hands to `removeListener`.
      return { ok: true, data: subscriptionId };
    },

    async removeListener(subscriptionId: number): Promise<InvokeResult> {
      // Dropped locally FIRST. If the round trip fails the page must still
      // stop hearing the event; a listener that survives its own `remove()` is
      // how a torn-down component keeps writing into dead state.
      callbacks.delete(subscriptionId);
      return send({ k: 'removeListener', subscriptionId });
    },

    async removeAllListeners(pluginName: string): Promise<InvokeResult> {
      for (const [id, record] of callbacks) {
        if (record.pluginName === pluginName) callbacks.delete(id);
      }
      return send({ k: 'removeAllListeners', plugin: pluginName });
    },

    /*
     * NOTHING SENDS COMMANDS HERE, AND THAT IS A DECISION.
     *
     * On desktop this is how a menu accelerator reaches `src/lib/keys.ts`. A
     * headless server has no menu, and a route by which the SERVER could push a
     * command into a connected page would be a way for whoever holds the
     * server to drive somebody else's app. So the subscription is accepted (the
     * contract requires the function to exist) and the server never sends on
     * it; `tests/server.test.ts` asserts the stream carries no command frame.
     */
    onCommand(): () => void {
      return () => undefined;
    },
  };

  target[config.global] = bridge;
}

/**
 * The whole served script: the transport bridge, then Capacitor's globals.
 *
 * ORDER MATTERS TWICE. Within this string, the bridge must be published before
 * `installCapacitorShim` runs, because the shim reads `window[global]`
 * immediately and calls `getBootstrap()` on it. And the string as a whole must
 * be evaluated before the app bundle — `policy.ts:injectBootstrap` is what
 * arranges that, and it refuses to serve a document it cannot arrange it in.
 */
export function serverBootstrapSource(manifest: BootManifest): string {
  const config: ServerBridgeConfig = {
    manifest,
    rpcPath: RPC_PATH,
    eventsPath: EVENTS_PATH,
    sessionHeader: SESSION_HEADER,
    global: SERVER_BRIDGE_GLOBAL,
  };
  return [
    '/* chatterang server bootstrap — generated; seeds the platform before the app loads. */',
    `(${installServerBridge.toString()})(window, ${JSON.stringify(config)});`,
    capacitorShimSource(SERVER_BRIDGE_GLOBAL, 'server'),
    '',
  ].join('\n');
}
