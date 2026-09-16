/**
 * The hidden window a paired device's turn runs in, as a `WorkerSpawn` (#7 S5).
 *
 * `worker-host.ts` owns WHEN a worker exists, what its loss costs and how a
 * unit ends. This file owns the one thing that file refuses to know: what a
 * worker actually IS on this platform — a `show: false` `BrowserWindow` loading
 * the same app bundle a normal window loads, with a `MessageChannelMain`
 * between main and its page.
 *
 * IT IMPORTS NO ELECTRON, AND THAT IS WHY IT IS IN `bridge/`. The obvious
 * version of this file reaches for `BrowserWindow` and `MessageChannelMain`
 * directly, which would make it the one file here that no test can import —
 * `tests/layering.test.ts` (`the desktop bridge stays platform-free`) fails on
 * any `electron` specifier in this directory, and vitest has no Electron to
 * give it. So the two constructors are INJECTED and typed against only the
 * members used, exactly as `utility-host.ts` is typed against `UtilityProcess`
 * and `permissions.ts` against a session. `main.ts` passes the real classes;
 * `tests/desktop-peer-turn-window.test.ts` passes fakes and drives every path
 * below, the spawn options included.
 *
 * THE PORT NEVER LEAVES THE PRELOAD. Main transfers `port2` to it on
 * `did-finish-load` (`webContents.postMessage`), and `peer-turn-preload.ts`
 * builds the real `HostRuntime` over it directly — a preload is Node-ish
 * even under `contextIsolation`, so it needs no further hand-off into the
 * page the way a `MessagePort` proper would. (An earlier revision of this
 * pair of files handed the port on into the page with a second handshake;
 * `tests/layering.test.ts`'s shell-app guard is why that revision could not
 * stand — `src/` may not import `@chatterang/desktop`'s `createHostRuntime`
 * to receive it, by any specifier, static or dynamic. `PEER_TURN_PORT_CHANNEL`
 * below is now a contract with the preload alone.) What crosses into the page
 * is one flat `contextBridge` global instead — see that preload's header.
 * The BrowserWindow-level measurements this file is still built from —
 * `MessagePortMain` `close` firing for every way a worker's renderer can go,
 * `backgroundThrottling`, navigation — are unaffected by which side of the
 * preload boundary holds the port, and are recorded below where they were.
 * Measured in `dev/probe-electron-hidden-worker/` and written up in
 * `docs/BACKGROUND-WORK-MEASUREMENTS.md` section 5.
 *
 * LOSS IS THE PORT'S `close`, AND THE WINDOW EVENTS ARE A BACKSTOP.
 * Section 5.2 measured `MessagePortMain` `close` firing for every way a
 * worker's renderer went — crash, SIGKILL, `destroy()`, `close()`, `reload()`,
 * a same-origin navigation, and a renderer blocked in a busy loop — and on a
 * crash it arrived about 4.5 ms BEFORE `render-process-gone`. So `close` alone
 * would do; `render-process-gone` and `destroyed` are registered anyway because
 * a window destroyed with no port ever handed over (a load that failed) emits
 * no port `close` at all. Whichever comes first wins, and the rest are dropped:
 * the `Supervisor` is told a host is lost exactly once.
 *
 * A WORKER THAT NAVIGATES IS A WORKER THAT IS OVER (section 5.2): the old
 * document's port closes between `did-start-navigation` and `did-navigate`, and
 * the new document is handed nothing. That ends the life through `onClose`
 * like any other loss, and the next unit builds another window. `will-navigate`
 * is refused here as well — not as protection against that, which it cannot be
 * (`reload()` and `location.reload()` emit no `will-navigate`), but for the
 * same reason `main.ts` refuses it: nothing of ours leaves our origin.
 *
 * `backgroundThrottling: false`, per section 5.3. A never-shown window reports
 * itself `visible` and was not throttled either way in the measurements, so
 * this buys nothing today and costs nothing; it is set so that a later change
 * which does show and hide this window cannot silently start throttling the
 * thread a turn runs on.
 *
 * LOGGING RULE, as in `main.ts` and `worker-host.ts`: nothing here logs a turn,
 * a frame, or anything a page supplied. The close reasons below are fixed
 * strings.
 */

import type { HostHandle, MessageLink } from './protocol.js';
import type { WorkerSpawn } from './worker-host.js';

/**
 * The query parameter that tells the app bundle it is a worker, not a window.
 *
 * A CONTRACT WITH THE RENDERER HALF (`src/peer-turn-worker.ts`): the same
 * bundle, at the same origin, loaded by the same `loadURL`, has to decide
 * whether to mount the app or to run one turn. It is a query parameter rather
 * than a path so that `resolveBundleUrl` serves it with no new route and
 * `isTrustedOrigin` trusts it with no new origin — the worker IS the app, and
 * its `webContents.id` reaching `PluginHost` is the point (`worker-host.ts`,
 * THE SENDER ID IS REAL).
 */
export const PEER_TURN_WORKER_PARAM = 'peerTurnWorker';

/** Its only value. Present-and-`1`, so a bare `?peerTurnWorker` is not a worker. */
export const PEER_TURN_WORKER_VALUE = '1';

/**
 * The IPC channel `port2` is transferred on, main to preload.
 *
 * A CONTRACT WITH `peer-turn-preload.ts`, which is the only listener, and
 * which keeps the port for itself — see the header above.
 */
export const PEER_TURN_PORT_CHANNEL = 'peer-turn-port';

/** Why a worker life ended, as `MessageLink.onClose` reports it. Fixed strings. */
export const WORKER_PORT_CLOSED = 'the worker window closed its message port';
export const WORKER_RENDERER_GONE = 'the worker window’s renderer went away';
export const WORKER_DESTROYED = 'the worker window was destroyed';
export const WORKER_LOAD_FAILED = 'the worker window could not load the app';

/* ── The slices of Electron this needs, and nothing else ──────────────── */

/** The `webPreferences` a worker window is built with. Every value is fixed. */
export interface PeerTurnWebPreferences {
  readonly preload: string;
  readonly sandbox: true;
  readonly contextIsolation: true;
  readonly nodeIntegration: false;
  readonly webviewTag: false;
  /** Section 5.3: unmeasurable today, and the setting a hidden worker wants. */
  readonly backgroundThrottling: false;
}

/** The `BrowserWindow` options a worker window is built with. Never shown. */
export interface PeerTurnWindowConstructorOptions {
  readonly show: false;
  readonly webPreferences: PeerTurnWebPreferences;
}

/** The slice of Electron's `WebContents` a worker window needs. */
export interface WorkerWebContentsLike {
  readonly id: number;
  postMessage(channel: string, message: unknown, transfer?: unknown[]): void;
  on(event: 'render-process-gone', listener: (...args: unknown[]) => void): unknown;
  on(event: 'will-navigate', listener: (navigation: { preventDefault(): void }) => void): unknown;
  once(event: 'did-finish-load', listener: () => void): unknown;
  once(event: 'destroyed', listener: () => void): unknown;
  setWindowOpenHandler(handler: () => { action: 'deny' }): void;
}

/** The slice of Electron's `BrowserWindow` a worker window needs. */
export interface WorkerWindowLike {
  readonly webContents: WorkerWebContentsLike;
  loadURL(url: string): Promise<void>;
  isDestroyed(): boolean;
  destroy(): void;
}

/** The slice of Electron's `MessagePortMain` main's end of the channel needs. */
export interface WorkerPortLike {
  postMessage(message: unknown): void;
  on(event: 'message', listener: (messageEvent: { data: unknown }) => void): unknown;
  on(event: 'close', listener: () => void): unknown;
  /**
   * REQUIRED, and Electron's API says so: a `MessagePortMain` queues its
   * messages and emits nothing until `start()` is called. Without it a worker
   * is spawned, loads, hands its port back — and every reply it sends,
   * `HostBoot` first, sits in a queue nobody drains.
   */
  start(): void;
}

/** The slice of Electron's `MessageChannelMain` a spawn needs. */
export interface WorkerChannelLike {
  /** Main's end. */
  readonly port1: WorkerPortLike;
  /** The page's end, transferred and never touched here. */
  readonly port2: unknown;
}

/** Electron's two constructors, injected. `main.ts` passes the real classes. */
export interface PeerTurnElectron {
  readonly BrowserWindow: new (options: PeerTurnWindowConstructorOptions) => WorkerWindowLike;
  readonly MessageChannelMain: new () => WorkerChannelLike;
}

export interface PeerTurnWindowOptions {
  /** The base URL the app's normal windows load (dev server URL, or the built app's URL). */
  readonly appUrl: string;
  /** Absolute path to the built `peer-turn-preload.cjs`. */
  readonly preloadPath: string;
  /** Electron's `BrowserWindow` and `MessageChannelMain`, so this file imports neither. */
  readonly electron: PeerTurnElectron;
}

/* ── The URL ──────────────────────────────────────────────────────────── */

/**
 * The app's own URL, marked as a worker's.
 *
 * Built through `URL` rather than by concatenation so an `appUrl` that already
 * carries a query or a fragment stays intact and the parameter lands in the
 * right component — the dev server URL is bare today, and the built one is
 * `chatterang-desktop://app/index.html`, but neither is this function's to
 * assume. An existing `peerTurnWorker` is REPLACED rather than appended to, so
 * the renderer half never has to decide which of two values it meant.
 *
 * A URL that does not parse is returned unchanged with the parameter appended
 * lexically: an unparseable URL is a load failure either way, and the failure
 * to report is "the app would not load", not one from this function.
 */
export function peerTurnWorkerUrl(appUrl: string): string {
  try {
    const url = new URL(appUrl);
    url.searchParams.set(PEER_TURN_WORKER_PARAM, PEER_TURN_WORKER_VALUE);
    return url.href;
  } catch {
    const pair = `${PEER_TURN_WORKER_PARAM}=${PEER_TURN_WORKER_VALUE}`;
    const [base = appUrl, ...fragment] = appUrl.split('#');
    const query = `${base}${base.includes('?') ? '&' : '?'}${pair}`;
    return fragment.length === 0 ? query : `${query}#${fragment.join('#')}`;
  }
}

/* ── The spawn ────────────────────────────────────────────────────────── */

/**
 * Build `worker-host.ts`'s `spawnWorker`: one hidden window per call.
 *
 * The URL and the options are decided once, here, and the returned function
 * does nothing but build. It is called only when a phone's turn needs a worker
 * and none is live (`worker-host.ts`), so every call is a whole worker life.
 *
 * It THROWS whatever Electron throws — a window that cannot be constructed is
 * `WORKER_SPAWN_FAILED`, counted against the restart budget, and the turn is
 * refused with a message that names no window.
 */
export function createPeerTurnWorkerSpawner(options: PeerTurnWindowOptions): () => WorkerSpawn {
  const url = peerTurnWorkerUrl(options.appUrl);
  const { BrowserWindow, MessageChannelMain } = options.electron;
  const windowOptions: PeerTurnWindowConstructorOptions = {
    // NEVER SHOWN. Not `hide()`d after the fact: section 5.3 measured a window
    // that was never shown, and a shown-then-hidden one is unmeasured.
    show: false,
    webPreferences: {
      preload: options.preloadPath,
      // The same four the app's own window is built with (`main.ts`,
      // `createWindow`). A worker runs the same bundle and gets no more.
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: false,
      backgroundThrottling: false,
    },
  };

  return (): WorkerSpawn => {
    const window = new BrowserWindow(windowOptions);
    const contents = window.webContents;
    const channel = new MessageChannelMain();
    const port = channel.port1;

    const messageListeners: Array<(message: unknown) => void> = [];
    const closeListeners: Array<(reason: string) => void> = [];
    let closedWith: string | null = null;

    /** The first loss wins; the rest are the same loss arriving again. */
    const lost = (reason: string): void => {
      if (closedWith !== null) return;
      closedWith = reason;
      for (const tell of [...closeListeners]) tell(reason);
    };

    port.on('message', (messageEvent) => {
      for (const listener of [...messageListeners]) listener(messageEvent.data);
    });
    port.on('close', () => lost(WORKER_PORT_CLOSED));
    // `on`, not `once`: `render-process-gone` can fire for a crash and then
    // again for the kill that follows it, and `lost` is what makes that one
    // loss rather than two.
    contents.on('render-process-gone', () => lost(WORKER_RENDERER_GONE));
    contents.once('destroyed', () => lost(WORKER_DESTROYED));
    port.start();

    // Nothing of ours leaves our origin, and a worker opens no window at all —
    // it has no one to show it to. Same posture as `main.ts`'s `createWindow`,
    // minus the `shell.openExternal` arm: a hidden page is not a person
    // clicking a link.
    contents.on('will-navigate', (navigation) => navigation.preventDefault());
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));

    // AFTER the page has loaded, because the preload is what receives this and
    // it must be running to receive it. The preload then holds the port until
    // the page asks for it, so this transfer cannot be too early either.
    contents.once('did-finish-load', () => {
      contents.postMessage(PEER_TURN_PORT_CHANNEL, null, [channel.port2]);
    });
    void window.loadURL(url).then(
      () => undefined,
      // A load that failed hands over no port, so no port `close` is coming:
      // without this the life would sit live until the Supervisor's ping
      // budget expired. `destroy()` is left to `kill`, which the loss runs.
      () => lost(WORKER_LOAD_FAILED),
    );

    const link: MessageLink = {
      // Not guarded by `closedWith`: section 5.2 measured a post to a closed
      // `MessagePortMain` returning without throwing 3 s after its `close`, so
      // a throw here would be this file inventing a signal Electron does not
      // give. The `Supervisor` has already been told through `onClose`.
      postMessage: (message) => port.postMessage(message),
      onMessage: (listener) => {
        messageListeners.push(listener);
      },
      onClose: (listener) => {
        closeListeners.push(listener);
        // A listener registered after the loss is still owed it. The
        // Supervisor registers in the same turn as the spawn, but a load that
        // failed synchronously would otherwise be a life nobody ends.
        if (closedWith !== null) listener(closedWith);
      },
    };

    const handle: HostHandle = {
      link,
      // Idempotent, as `HostHandle` requires: the Supervisor kills on every
      // retirement, and `worker-host.ts` kills again on a condemn.
      kill: () => {
        if (!window.isDestroyed()) window.destroy();
      },
    };

    return { handle, senderId: contents.id };
  };
}
