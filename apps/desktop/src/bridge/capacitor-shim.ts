/**
 * The main-world shim that makes `registerPlugin('LlamaCpp', …)` in `src/`
 * resolve to the desktop bridge — with no change to `src/`.
 *
 * WHY A SHIM AND NOT A PROXY OF OUR OWN. `@capacitor/core` builds its plugin
 * proxy at `registerPlugin` time from two globals it reads once, at module
 * load: `window.CapacitorCustomPlatform` and `window.Capacitor`. Read the real
 * source (`node_modules/@capacitor/core/dist/index.js`) and the routing is
 * unambiguous:
 *
 *   - `createCapacitor` starts from `cap = win.Capacitor || {}`, so a
 *     pre-seeded object is ADOPTED and extended rather than replaced;
 *   - `createPluginMethod` checks `getPluginHeader(pluginName)` FIRST, and a
 *     header entry with `rtype: 'promise'` routes the call to
 *     `cap.nativePromise`;
 *   - the proxy's `addListener` becomes `addListenerNative` when a header
 *     exists, which wraps the event name as `addListener({eventName}, cb)`
 *     before it reaches `cap.nativeCallback`.
 *
 * That last point is worth checking rather than assuming: WITHOUT a header the
 * raw `createPluginMethodWrapper` path passes the bare event-name STRING
 * through, and a shim reading `options.eventName` would then register a
 * subscription with `eventName === undefined` that silently never fires.
 * `tests/desktop-bridge.test.ts` asserts the behaviour against the real
 * `@capacitor/core`, not against this description of it.
 *
 * WHY IT MUST RUN IN THE MAIN WORLD, AND WHY IT IS SELF-CONTAINED.
 * `contextBridge.exposeInMainWorld` publishes a FROZEN object, and
 * `createCapacitor` WRITES to `cap` (`cap.Plugins`, `cap.getPlatform`, …), so
 * seeding `Capacitor` through `contextBridge` would throw the moment the app
 * bundle loads. The preload therefore evaluates this function's own source in
 * the main world with `webFrame.executeJavaScript`. That is why the function
 * below references NOTHING outside its own parameters: a call to a
 * module-scope helper would survive typecheck, survive bundling, and throw
 * `ReferenceError` in the main world at startup. `CAPACITOR_SHIM_SOURCE` is
 * built from `.toString()` so the source that is evaluated is the source that
 * is tested, and the test evaluates the STRING for exactly this reason.
 *
 * WHY THE ERROR IS REBUILT HERE, AND NOWHERE EARLIER. This is the first code
 * that runs on the PAGE side of `contextBridge`, and `contextBridge` reduces
 * an `Error` to its message and stack — custom own properties do not survive.
 * An `Error` carrying `code: 'HANDLE_LOST'` built in the preload therefore
 * arrives in the page with no code at all, and the recovery in
 * `src/ai/backends/llama-cpp.ts` never fires: the adapter keeps a handle whose
 * host no longer exists and every retry fails the same way. So the preload
 * resolves plain `{ok,error}` data and the throw is reconstructed below, in
 * the world that has to see it.
 *
 * `unwrap` is a verbatim inline of `fromWireError` plus a shape check, and it
 * is inline for the self-containment reason above — a call to the imported one
 * would be a `ReferenceError` in the main world. `tests/desktop-bridge.test.ts`
 * asserts the two agree, so the copy cannot drift unnoticed.
 */

import type { PreloadBridge } from './renderer.js';

/** The window properties this shim reads and writes. */
export interface ShimTarget {
  Capacitor?: Record<string, unknown>;
  CapacitorCustomPlatform?: { name: string };
}

/**
 * Seed the globals `@capacitor/core` reads at load.
 *
 * MUST run before the app bundle is evaluated; after that `createCapacitor`
 * has already run and the headers would be ignored.
 *
 * SELF-CONTAINED BY REQUIREMENT — see the note above. Do not extract a helper
 * out of this function.
 *
 * @param target - the main-world global object (`window`).
 * @param bridge - the five functions the preload exposed.
 * @param platform - the platform id `Capacitor.getPlatform()` will report.
 */
export function installCapacitorShim(
  target: ShimTarget,
  bridge: PreloadBridge,
  platform = 'electron',
): void {
  /** `{ok,error}` back into a value or a throw — `code` and all. */
  const unwrap = (answer: unknown): unknown => {
    const result = answer as
      | { ok?: unknown; data?: unknown; error?: { message?: unknown; code?: unknown } }
      | null
      | undefined;
    if (result === null || typeof result !== 'object' || typeof result.ok !== 'boolean') {
      throw new Error('desktop bridge: the preload answered with a value that is not a result.');
    }
    if (result.ok) return result.data;
    const wire = result.error;
    const error = new Error(
      typeof wire?.message === 'string' ? wire.message : 'desktop bridge: an unnamed failure.',
    );
    if (typeof wire?.code === 'string') Object.assign(error, { code: wire.code });
    throw error;
  };

  const manifest = bridge.getBootstrap();
  const capacitor: Record<string, unknown> = target.Capacitor ?? {};

  capacitor['PluginHeaders'] = manifest.plugins.map((plugin) => ({
    name: plugin.name,
    methods: [
      ...plugin.methods.map((name) => ({ name, rtype: 'promise' })),
      // `callback` is what makes the proxy take the `addListenerNative` path,
      // which is the path that wraps the event name in an options object.
      { name: 'addListener', rtype: 'callback' },
      { name: 'removeListener', rtype: 'callback' },
      // Served by `nativePromise` like any other method, which is why
      // `PluginHost` treats it as a first-class operation of the bridge
      // rather than as a declared plugin method.
      { name: 'removeAllListeners', rtype: 'promise' },
    ],
  }));

  capacitor['nativePromise'] = async (
    pluginName: string,
    methodName: string,
    options?: unknown,
  ): Promise<unknown> => {
    if (methodName === 'removeAllListeners') {
      return unwrap(await bridge.removeAllListeners(pluginName));
    }
    return unwrap(
      await bridge.invoke(pluginName, methodName, options === undefined ? [] : [options]),
    );
  };

  capacitor['nativeCallback'] = async (
    pluginName: string,
    methodName: string,
    options: Record<string, unknown> | undefined,
    callback: (data: unknown) => void,
  ): Promise<unknown> => {
    if (methodName === 'addListener') {
      // `addListenerNative` awaits this and uses the value as the callback id
      // it later hands back to `removeListener`. Our subscription id IS that
      // value, so the two stay in step with no extra bookkeeping.
      //
      // A REFUSAL MUST NOT REJECT THIS PROMISE. Read the real
      // `addListenerNative` (`node_modules/@capacitor/core/dist/index.js`):
      // it does `call.then(() => resolve({remove}))` on the promise this
      // function returns — an `onFulfilled` with no `onRejected`. If this
      // promise rejects, that `.then()` never runs `resolve`, so the promise
      // the PAGE is awaiting (e.g. `LlamaCpp.addListener('llamaWaiting', …)`
      // in `src/ai/backends/llama-cpp.ts`, deliberately tolerating exactly
      // this refusal with `.catch(() => null)`) never settles — it hangs
      // forever, with nothing left for that `.catch()` to catch. Separately,
      // the `.then()` call itself returns its OWN derived promise, discarded
      // and unhandled, which is the "Uncaught (in promise)" this produced.
      // There is no patch point in vendor code, so the fix lives here: an
      // undeclared event resolves to an inert subscription — no different,
      // to the caller, from one that is declared but simply never fires.
      // `bridge.removeListener` on an id nothing subscribed under is a
      // documented no-op (`PluginHost.removeListener`), so the `remove()`
      // Capacitor builds from this id is safe to call and does nothing.
      const NO_SUBSCRIPTION_CALLBACK_ID = -1;
      const answer = await bridge.addListener(pluginName, String(options?.['eventName']), callback);
      if (!answer.ok) return NO_SUBSCRIPTION_CALLBACK_ID;
      return unwrap(answer);
    }
    if (methodName === 'removeListener') {
      return unwrap(await bridge.removeListener(Number(options?.['callbackId'])));
    }
    throw new Error(`desktop bridge: no callback-style method "${pluginName}.${methodName}".`);
  };

  target.Capacitor = capacitor;
  // Set LAST. `createCapacitor` reads it to decide the platform id, and a
  // half-seeded `Capacitor` next to a set custom platform is the one state
  // that routes a call to a web shim we did not intend to use.
  target.CapacitorCustomPlatform = { name: platform };
}

/**
 * The shim, as source the preload can evaluate in the main world.
 *
 * @param bridgeGlobal - the name the bridge was exposed under.
 * @param platform - the platform id to report.
 */
export function capacitorShimSource(bridgeGlobal: string, platform = 'electron'): string {
  return `(${installCapacitorShim.toString()})(window, window[${JSON.stringify(bridgeGlobal)}], ${JSON.stringify(platform)});`;
}
