/**
 * The hidden peer-turn worker's preload (#7 S5).
 *
 * A SECOND preload, and NOT `preload.ts` with a branch in it, for the reason
 * this file's earlier revision gave: one preload per window, and this one's
 * job — running a turn — is not that one's.
 *
 * THIS FILE HOLDS THE HOST LINK. `tests/layering.test.ts`'s shell-app guard
 * bans `@chatterang/desktop` from `src/` outright, by specifier, static or
 * dynamic — a turn runner written in `src/` (`src/peer-turn-worker.ts`)
 * cannot import `createHostRuntime` or `PEER_TURN_PLUGIN` itself, on any
 * platform, ever. So the host link lives HERE instead: this preload receives
 * `main`'s `MessagePort` directly (a preload is Node-ish even under
 * `contextIsolation`, and a `MessagePort` handed to it over `ipcRenderer`
 * needs no further transfer), builds the real `createHostRuntime` over it,
 * and serves the real `PEER_TURN_PLUGIN` — the same host-link protocol the
 * inference utility hosts speak (`bridge/host-runtime.ts`).
 *
 * WHAT CROSSES `contextBridge`, AND WHY ONLY THIS. A `MessagePort` cannot
 * cross it (Electron's own restriction) — moot here, since the port never
 * needs to leave this file. What DOES need to cross is the one thing only the
 * page can do: run the model. `window.__peerTurn` is `{ registerRunner,
 * emitFrame }`, two flat functions with plain, structured-clonable arguments
 * (strings, a `Uint8Array`, and, for `registerRunner`, an object of two more
 * such functions) — the ordinary shape `contextBridge.exposeInMainWorld`
 * documents, and nothing nested deeper than that one level in either
 * direction. `src/peer-turn-worker.ts` calls `registerRunner` once its engine
 * is ready, and calls `emitFrame` for each chunk of a turn it is running;
 * this file calls the runner's own two methods, which is the SAME one-level
 * shape read backwards — `contextBridge` proxies a function passed as an
 * argument into an exposed call exactly as it proxies the call itself.
 *
 * A TURN THAT ARRIVES BEFORE THE PAGE HAS REGISTERED WAITS FOR IT, rather
 * than refusing: `runnerReady` is one promise, resolved once, that
 * `peerTurnStart`/`peerTurnCancel` both await before doing anything. The
 * page registering is ordinary — engine start is async — and a turn that
 * outraced it is not a fault.
 *
 * Built by `scripts/build.mjs` into `build/peer-turn-preload.cjs`, the same
 * way `preload.ts` becomes `build/preload.cjs`.
 */

import { contextBridge, ipcRenderer } from 'electron';

import { createHostRuntime } from './bridge/host-runtime.js';
import { PEER_TURN_PLUGIN } from './bridge/protocol.js';
import { PEER_TURN_PORT_CHANNEL } from './bridge/peer-turn-window.js';

/** What the page hands over, once, after `useApp`'s real engine is ready. */
interface PageRunner {
  runPeerTurn(payload: { requestId: string; frame: Uint8Array }): Promise<{ requestId: string; frame: Uint8Array }>;
  cancelPeerTurn(payload: { requestId: string }): Promise<void>;
}

let resolveRunner!: (runner: PageRunner) => void;
const runnerReady = new Promise<PageRunner>((resolve) => {
  resolveRunner = resolve;
});

const eventListeners = new Map<string, Set<(data: unknown) => void>>();
const emit = (name: string, data: unknown): void => {
  for (const listener of eventListeners.get(name) ?? []) listener(data);
};

const implementation = {
  addListener: async (name: string, listener: (data: unknown) => void) => {
    const set = eventListeners.get(name) ?? new Set();
    set.add(listener);
    eventListeners.set(name, set);
    return {
      remove: async (): Promise<void> => {
        set.delete(listener);
      },
    };
  },
  peerTurnStart: async (payload: { requestId: string; frame: Uint8Array }) => {
    const runner = await runnerReady;
    return runner.runPeerTurn(payload);
  },
  peerTurnCancel: async (payload: { requestId: string }): Promise<void> => {
    const runner = await runnerReady;
    return runner.cancelPeerTurn(payload);
  },
};

ipcRenderer.on(PEER_TURN_PORT_CHANNEL, (event) => {
  const port = event.ports[0];
  if (port === undefined) return;
  createHostRuntime({
    link: {
      postMessage: (message) => port.postMessage(message),
      onMessage: (listener) => {
        port.onmessage = (portEvent) => listener(portEvent.data);
      },
      // The port closing is main's own signal for this life ending
      // (`bridge/peer-turn-window.ts`); nothing here needs a second one.
      onClose: () => undefined,
    },
  }).serve(PEER_TURN_PLUGIN, implementation);
  port.start();
});

contextBridge.exposeInMainWorld('__peerTurn', {
  registerRunner: (runner: PageRunner): void => resolveRunner(runner),
  emitFrame: (requestId: string, frame: Uint8Array): void => emit('peerTurnFrame', { requestId, frame }),
});
