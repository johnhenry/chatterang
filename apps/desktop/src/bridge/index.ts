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
  COMMAND_CHANNEL,
  EVENT_CHANNEL,
  LISTENER_ADD_CHANNEL,
  LISTENER_REMOVE_ALL_CHANNEL,
  LISTENER_REMOVE_CHANNEL,
  allowedChannels,
  channelCollisions,
  methodChannel,
} from './channels.js';
export { HostFleet } from './host-fleet.js';
export type { FleetEntry, HostFleetOptions } from './host-fleet.js';
export { PluginHost } from './plugin-host.js';
export { RENDERER_TEARDOWN_EVENTS, releaseRendererOn, teardownReason } from './renderer-lifecycle.js';
export type { RendererTeardownEvent, RendererTeardownTargets } from './renderer-lifecycle.js';
export { createMainRouter } from './main-router.js';
export type { MainRouter } from './main-router.js';
export type { EventDelivery, EventPayload, PluginImplementation, PluginMethod } from './plugin-host.js';
export { BRIDGE_GLOBAL, BRIDGE_KEYS, createRendererBridge } from './renderer.js';
export type { InvokeResult, PreloadBridge, RendererIpc } from './renderer.js';
export { capacitorShimSource, installCapacitorShim } from './capacitor-shim.js';
export type { ShimTarget } from './capacitor-shim.js';
export { DEFAULT_POLICY, LLAMA_ENGINE, ONNX_ENGINE, Supervisor, systemTimers } from './supervisor.js';
export type {
  EngineSpec,
  NotifyListeners,
  SessionSpec,
  StreamSpec,
  SupervisorOptions,
  SupervisorPolicy,
  SupervisorTimers,
} from './supervisor.js';
export {
  BROKER_TICK_MS,
  MAX_CONCURRENT_TURNS,
  MAX_WAITING_PER_DEVICE,
  MAX_WAITING_PER_WINDOW,
  MAX_WAITING_TOTAL,
  PROMPT_ANSWER_TIMEOUT_MS,
  RETAIN_RESULT_COUNT,
  RETAIN_RESULT_MS,
  RETAIN_RESULT_PER_DEVICE,
  UNIT_DRAIN_TIMEOUT_MS,
  UNIT_IDLE_TIMEOUT_MS,
  WorkBroker,
} from './work-broker.js';
export type {
  AdmitRefusal,
  AdmitResult,
  BrokerNotice,
  ChannelCloseReason,
  Owner,
  OwnerChannel,
  PromptOutcome,
  PromptRefusal,
  UnitEnd,
  UnitRequest,
  UnitTerminal,
  WorkBrokerOptions,
} from './work-broker.js';
export {
  LOCAL_EXECUTOR,
  LOCAL_TURNS_PLUGIN,
  TURN_WAITING_EVENT,
  admitLocalTurns,
  localTurnNotices,
  TURN_END_METHOD,
  WHOLE_TURN_OPTION,
  withTurnProgress,
} from './local-turns.js';
export type { HostedUnit, HostedUnitOf, LocalTurnNotices, LocalTurns, LocalTurnsOptions } from './local-turns.js';
export {
  PEER_TURN_ENGINE,
  PEER_TURN_IDLE_TIMEOUT_MS,
  WORKER_EXECUTOR,
  WORKER_IDLE_MS,
  createWorkerHost,
} from './worker-host.js';
export type { WorkerFailure, WorkerHost, WorkerHostOptions, WorkerSpawn, WorkerTurnEnd } from './worker-host.js';
export {
  PEER_TURN_PORT_CHANNEL,
  PEER_TURN_WORKER_PARAM,
  PEER_TURN_WORKER_VALUE,
  WORKER_DESTROYED,
  WORKER_LOAD_FAILED,
  WORKER_PORT_CLOSED,
  WORKER_RENDERER_GONE,
  createPeerTurnWorkerSpawner,
  peerTurnWorkerUrl,
} from './peer-turn-window.js';
export type {
  PeerTurnElectron,
  PeerTurnWebPreferences,
  PeerTurnWindowConstructorOptions,
  PeerTurnWindowOptions,
  WorkerChannelLike,
  WorkerPortLike,
  WorkerWebContentsLike,
  WorkerWindowLike,
} from './peer-turn-window.js';
export { wireDeviceTunnel, wirePeerTunnels } from './peer-turns.js';
export type { PeerTurnsOptions } from './peer-turns.js';
export { HostRuntime, createHostRuntime } from './host-runtime.js';
export type {
  CallGuard,
  CallShape,
  HostPluginImplementation,
  HostRuntimeOptions,
  ServeOptions,
} from './host-runtime.js';
export {
  LLAMA_HOST_POLICY,
  LLAMA_OPAQUE_FAILURES,
  REQUIRED_ARGUMENTS,
  assertCallShape,
} from './call-shape.js';
export {
  ONNX_HOST_POLICY,
  ONNX_OPAQUE_FAILURES,
  ONNX_REQUIRED_ARGUMENTS,
  assertOnnxCallShape,
} from './onnx-call-shape.js';
export {
  DSH_METHODS,
  DSH_PLUGIN,
  FILESYSTEM_METHODS,
  FILESYSTEM_PLUGIN,
  HANDLE_LOST,
  HOST_TIMEOUT,
  LLAMA_EVENTS,
  LLAMA_METHODS,
  LLAMA_PLUGIN,
  MOUNT_METHODS,
  MOUNT_PLUGIN,
  ONNX_EVENTS,
  ONNX_METHODS,
  ONNX_PLUGIN,
  PEER_TURN_EVENTS,
  PEER_TURN_METHODS,
  PEER_TURN_PLUGIN,
  PEER_TURN_STREAM,
  SENDER_SCOPED,
  TUNNEL_SOCKET_EVENTS,
  TUNNEL_SOCKET_METHODS,
  TUNNEL_SOCKET_PLUGIN,
  fromWireError,
  toWireError,
} from './protocol.js';
export type {
  BootManifest,
  BridgePlatform,
  DshStatus,
  HostBoot,
  HostCall,
  HostEvent,
  HostHandle,
  HostPing,
  HostPong,
  HostMessage,
  HostReturn,
  LlamaEventMap,
  LlamaEventName,
  MessageLink,
  OnnxEventMap,
  PeerTurnCancel,
  PeerTurnEndEvent,
  PeerTurnFrameEvent,
  PeerTurnStart,
  PluginDefinition,
  WireError,
} from './protocol.js';
export { discoverCli } from './cli-discovery.js';
export type { CliBinarySpec, CliDiscovery, CliDiscoveryDeps, CliExecResult } from './cli-discovery.js';
