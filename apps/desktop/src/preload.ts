/**
 * The preload.
 *
 * Runs before any page script, in an isolated world with `ipcRenderer` in
 * scope. It does exactly two things:
 *
 *   1. publishes five functions through `contextBridge` — no `ipcRenderer`, no
 *      `require`, no `process`, and no way for the page to name a channel the
 *      boot manifest does not contain;
 *   2. evaluates `capacitor-shim.ts`'s own source in the MAIN world, which is
 *      what makes the app bundle's `registerPlugin('LlamaCpp', …)` resolve to
 *      those five functions with no change to `src/`.
 *
 * Step 2 cannot be done through `contextBridge`: it publishes frozen objects,
 * and `@capacitor/core`'s `createCapacitor` writes to `window.Capacitor`
 * (`cap.Plugins`, `cap.getPlatform`, …) the moment the bundle loads.
 *
 * The logic is all in `bridge/`; this file is the Electron adapter for it and
 * is short on purpose. `BRIDGE_KEYS` is asserted against the exposed object in
 * `tests/desktop-bridge.test.ts`, so the allowlist is one list rather than two
 * that can drift.
 */

import { contextBridge, ipcRenderer, webFrame } from 'electron';

import { capacitorShimSource } from './bridge/capacitor-shim.js';
import { BRIDGE_GLOBAL, BRIDGE_KEYS, createRendererBridge } from './bridge/renderer.js';
import type { DesktopBridge, RendererIpc } from './bridge/renderer.js';

const ipc: RendererIpc = {
  invoke: (channel, payload) => ipcRenderer.invoke(channel, payload),
  sendSync: (channel) => ipcRenderer.sendSync(channel),
  on: (channel, listener) => {
    // The event object itself is never forwarded: it carries a `sender` the
    // page has no business holding.
    ipcRenderer.on(channel, (_event, payload: unknown) => listener(payload));
  },
};

const bridge = createRendererBridge(ipc);

// Exposed key by key from the shared allowlist rather than as one object, so
// the five names in `BRIDGE_KEYS` are the five names the page can see, and a
// sixth property added to the bridge object later does not silently ship.
const exposed = Object.fromEntries(
  BRIDGE_KEYS.map((key) => [key, (bridge as unknown as Record<string, unknown>)[key]]),
) as unknown as DesktopBridge;

contextBridge.exposeInMainWorld(BRIDGE_GLOBAL, exposed);

void webFrame.executeJavaScript(capacitorShimSource(BRIDGE_GLOBAL));
