/**
 * The desktop plugin bridge — everything that is neither Electron nor
 * inference, and therefore everything that can be tested without launching a
 * window.
 *
 * `apps/desktop/src/main.ts` and `preload.ts` are thin adapters over this:
 * they turn Electron's `ipcMain`/`ipcRenderer`/`utilityProcess` into the three
 * narrow interfaces below (`EventDelivery`, `RendererIpc`, `MessageLink`) and
 * add nothing else. That split is deliberate — `tests/desktop-bridge.test.ts`
 * drives the code in this directory through a pair of fake ports with real
 * structured-clone semantics, which exercises more of the actual failure
 * surface than a smoke test that opens a window ever could.
 */

export { assertCloneable, NotCloneableError } from './clone.js';
export {
  BOOTSTRAP_CHANNEL,
  EVENT_CHANNEL,
  LISTENER_ADD_CHANNEL,
  LISTENER_REMOVE_ALL_CHANNEL,
  LISTENER_REMOVE_CHANNEL,
  allowedChannels,
  channelCollisions,
  methodChannel,
} from './channels.js';
export { PluginHost } from './plugin-host.js';
export { createMainRouter } from './main-router.js';
export type { MainRouter } from './main-router.js';
export type { EventDelivery, EventPayload, PluginImplementation, PluginMethod } from './plugin-host.js';
export { BRIDGE_GLOBAL, BRIDGE_KEYS, createRendererBridge } from './renderer.js';
export type { DesktopBridge, InvokeResult, RendererIpc } from './renderer.js';
export { capacitorShimSource, installCapacitorShim } from './capacitor-shim.js';
export type { ShimTarget } from './capacitor-shim.js';
export { Supervisor } from './supervisor.js';
export type { NotifyListeners, SupervisorOptions } from './supervisor.js';
export { serveLlamaCpp } from './host-runtime.js';
export type { HostRuntimeOptions } from './host-runtime.js';
export {
  DSH_METHODS,
  DSH_PLUGIN,
  HANDLE_LOST,
  LLAMA_EVENTS,
  LLAMA_METHODS,
  LLAMA_PLUGIN,
  fromWireError,
  toWireError,
} from './protocol.js';
export type {
  BootManifest,
  DshStatus,
  HostBoot,
  HostCall,
  HostEvent,
  HostMessage,
  HostReturn,
  LlamaEventMap,
  LlamaEventName,
  MessageLink,
  PluginDefinition,
  WireError,
} from './protocol.js';
