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
 */

import type { DesktopBridge } from './renderer.js';

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
  bridge: DesktopBridge,
  platform = 'electron',
): void {
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

  capacitor['nativePromise'] = (
    pluginName: string,
    methodName: string,
    options?: unknown,
  ): Promise<unknown> => {
    if (methodName === 'removeAllListeners') return bridge.removeAllListeners(pluginName);
    return bridge.invoke(pluginName, methodName, options === undefined ? [] : [options]);
  };

  capacitor['nativeCallback'] = (
    pluginName: string,
    methodName: string,
    options: Record<string, unknown> | undefined,
    callback: (data: unknown) => void,
  ): Promise<unknown> => {
    if (methodName === 'addListener') {
      // `addListenerNative` awaits this and uses the value as the callback id
      // it later hands back to `removeListener`. Our subscription id IS that
      // value, so the two stay in step with no extra bookkeeping.
      return bridge.addListener(pluginName, String(options?.['eventName']), callback);
    }
    if (methodName === 'removeListener') {
      return bridge.removeListener(Number(options?.['callbackId']));
    }
    return Promise.reject(
      new Error(`desktop bridge: no callback-style method "${pluginName}.${methodName}".`),
    );
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
