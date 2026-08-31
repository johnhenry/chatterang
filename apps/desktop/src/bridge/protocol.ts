/**
 * The two wire protocols the desktop shell speaks, as data.
 *
 * There are two boundaries, and they are deliberately different shapes:
 *
 *   renderer ──(1) plugin bridge──> main ──(2) host link──> inference host
 *
 * Boundary 1 reproduces Capacitor's `registerPlugin` surface, because `src/`
 * already calls `registerPlugin('LlamaCpp', …)` and must not change. Boundary 2
 * is a plain request/response link over a message port, because the inference
 * host is a separate process whose only job is to run a native addon that can
 * abort the process it lives in.
 *
 * Everything here is a type or a frozen array. No Electron, no Node, no DOM —
 * that is what lets `tests/desktop-bridge.test.ts` drive the real code through
 * fake ports instead of launching a window.
 */

import type { GenerationEndEvent, ThermalState, TokenEvent } from '@chatterang/contracts';

/* ── Boundary 1: what a plugin declares ───────────────────────────────── */

/**
 * The invocable surface of one plugin, and the events it may emit.
 *
 * The method list is an ALLOWLIST, not documentation: `PluginHost` refuses a
 * method that is not in it before it ever touches the implementation, and the
 * preload builds its channel allowlist from the same array. Shrinking this
 * array shrinks the renderer's reachable surface.
 */
export interface PluginDefinition {
  readonly name: string;
  readonly methods: readonly string[];
  readonly events: readonly string[];
}

/** What the renderer learns at boot: every plugin, and nothing else. */
export interface BootManifest {
  readonly platform: 'electron';
  readonly plugins: readonly PluginDefinition[];
}

/**
 * The ten invocable methods of `LlamaCppPlugin`.
 *
 * `addListener` and `removeAllListeners` are NOT here, and their absence is
 * load-bearing rather than an oversight. They are part of the contract, but
 * they are served by the bridge itself — the host owns the subscription table
 * — so a plugin must never declare them as invocable methods. See
 * `channels.ts` for the collision this would cause in a naming scheme that put
 * both in one namespace, and `tests/desktop-bridge.test.ts` for the assertion
 * that ours cannot.
 */
export const LLAMA_METHODS = Object.freeze([
  'getCapabilities',
  'getThermalState',
  'load',
  'unload',
  'listLoaded',
  'generate',
  'cancel',
  'tokenize',
  'countTokens',
  'benchmark',
] as const);

/** The three event names `LlamaCppPlugin` emits. */
export const LLAMA_EVENTS = Object.freeze(['llamaToken', 'llamaEnd', 'llamaThermal'] as const);

export type LlamaEventName = (typeof LLAMA_EVENTS)[number];

/** Payload type per event name, so the forwarding code cannot swap two. */
export interface LlamaEventMap {
  llamaToken: TokenEvent;
  llamaEnd: GenerationEndEvent;
  llamaThermal: ThermalState;
}

export const LLAMA_PLUGIN: PluginDefinition = Object.freeze({
  name: 'LlamaCpp',
  methods: LLAMA_METHODS,
  events: LLAMA_EVENTS,
});

/**
 * The DSH status plugin — the thing that gives milestone A4 a caller.
 *
 * A mount nobody can observe is indistinguishable from no mount, which is the
 * exact failure mode `assertBoot` exists for. These two methods are how the
 * renderer sees whether the Cordis tree came up, and with which routes.
 */
export const DSH_METHODS = Object.freeze(['getStatus', 'listProviders'] as const);

export const DSH_PLUGIN: PluginDefinition = Object.freeze({
  name: 'DshHost',
  methods: DSH_METHODS,
  events: Object.freeze([] as string[]),
});

/** What `DshHost.getStatus()` answers. */
export interface DshStatus {
  /** True only when `assertBoot` returned without throwing. */
  readonly mounted: boolean;
  /** Services confirmed present and ACTIVE. */
  readonly services: readonly string[];
  /** Provider routes confirmed registered on the `llm` service. */
  readonly routes: readonly string[];
  /** `BootReport.treeAssertion` — what was NOT checked, verbatim. */
  readonly treeAssertion: string;
  /** The assertion failure, when there was one. */
  readonly error?: string;
}

/* ── Boundary 1: the error shape that crosses it ──────────────────────── */

/**
 * An error flattened for transport.
 *
 * Structured clone strips prototypes, so an `Error` subclass arrives as a
 * plain object with no identity. Rather than let that happen silently, both
 * boundaries flatten deliberately and the renderer reassembles an `Error` with
 * `code` reattached — which is what lets the adapter in `src/` distinguish
 * "the inference host died, drop your cached handle" from "that prompt was
 * too long".
 */
export interface WireError {
  readonly message: string;
  readonly code?: string;
}

/**
 * The code carried by every rejection caused by the inference host going away.
 *
 * `src/ai/backends/llama-cpp.ts` caches its loaded handle indefinitely. Without
 * a code to key on, a host restart wedges the adapter permanently: every retry
 * sends a handle that no longer exists and fails identically until the app is
 * relaunched. That is worse than a hang, because it looks like a broken model.
 */
export const HANDLE_LOST = 'HANDLE_LOST';

/**
 * The code carried by a call that outlived its deadline.
 *
 * Distinct from {@link HANDLE_LOST} on purpose. `HANDLE_LOST` says "the
 * process that held your handle is gone, load again"; `HOST_TIMEOUT` says "the
 * process is still there and stopped answering THIS call". The adapter treats
 * neither as a reason to keep waiting, which is the only property that
 * matters, but a log that cannot tell a crash from a wedge is a log that
 * cannot tell you which one you have.
 */
export const HOST_TIMEOUT = 'HOST_TIMEOUT';

/** Flatten anything throwable into the wire shape. */
export function toWireError(error: unknown): WireError {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' ? { message: error.message, code } : { message: error.message };
  }
  return { message: String(error) };
}

/** Rebuild a thrown `Error` from the wire shape, `code` and all. */
export function fromWireError(wire: WireError): Error {
  const error = new Error(wire.message);
  if (wire.code !== undefined) Object.assign(error, { code: wire.code });
  return error;
}

/* ── Boundary 2: main <-> inference host ──────────────────────────────── */

/** A method call travelling towards the inference host. */
export interface HostCall {
  readonly k: 'call';
  readonly id: number;
  readonly method: string;
  readonly args: readonly unknown[];
}

/** The single settlement of one {@link HostCall}. */
export type HostReturn =
  | { readonly k: 'ret'; readonly id: number; readonly ok: true; readonly data: unknown }
  | { readonly k: 'ret'; readonly id: number; readonly ok: false; readonly error: WireError };

/** A plugin event travelling towards main. Fire-and-forget; never correlated. */
export interface HostEvent {
  readonly k: 'ev';
  readonly name: LlamaEventName;
  readonly data: unknown;
}

/** The inference host's one-shot report that its Cordis tree came up, or did not. */
export interface HostBoot {
  readonly k: 'boot';
  readonly status: DshStatus;
}

/**
 * A liveness probe, and its answer.
 *
 * Deliberately NOT a plugin method call. A host that is alive but wedged emits
 * no `exit`, so the link's own close path never fires and every settlement
 * path in the supervisor misses it. The ping is the only thing that can tell
 * "still working" from "stopped existing as far as we are concerned", and it
 * has to be answerable without touching the plugin — a probe routed through
 * `LlamaCppNode` would be blocked by exactly the state it exists to detect.
 */
export interface HostPing {
  readonly k: 'ping';
  readonly id: number;
}

/** The answer to one {@link HostPing}, echoing its id. */
export interface HostPong {
  readonly k: 'pong';
  readonly id: number;
}

export type HostMessage = HostCall | HostReturn | HostEvent | HostBoot | HostPing | HostPong;

/**
 * The narrowest port this code can work against.
 *
 * Electron's `utilityProcess` child, a Node `MessagePort` and a test double all
 * satisfy it. Keeping it this small is what stops `electron` leaking into the
 * unit-testable half of the shell.
 */
export interface MessageLink {
  postMessage(message: unknown): void;
  onMessage(listener: (message: unknown) => void): void;
  /** Called once when the far side goes away for good. */
  onClose(listener: (reason: string) => void): void;
}

/**
 * One inference host process, as the supervisor sees it.
 *
 * A bare {@link MessageLink} was enough while the host was forked once and
 * never replaced. It is not enough now, for one reason: the supervisor can
 * decide a host is gone while its PROCESS is still running — a wedged decode
 * answers no ping and emits no `exit`. Forking a replacement without a way to
 * terminate the original would leave two hosts holding the same GPU, the old
 * one invisible and unreachable. `kill` is that way.
 *
 * `kill` MUST be safe to call on a host that has already exited, and safe to
 * call twice; the supervisor calls it on every retirement, orderly or not.
 */
export interface HostHandle {
  readonly link: MessageLink;
  kill(): void;
}
