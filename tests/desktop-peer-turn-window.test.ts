import { describe, expect, it } from 'vitest';

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  PEER_TURN_PORT_CHANNEL,
  PEER_TURN_WORKER_PARAM,
  PEER_TURN_WORKER_VALUE,
  WORKER_DESTROYED,
  WORKER_LOAD_FAILED,
  WORKER_PORT_CLOSED,
  WORKER_RENDERER_GONE,
  createPeerTurnWorkerSpawner,
  peerTurnWorkerUrl,
} from '@chatterang/desktop/bridge';
import type {
  PeerTurnElectron,
  PeerTurnWindowConstructorOptions,
  WorkerChannelLike,
  WorkerWebContentsLike,
  WorkerWindowLike,
} from '@chatterang/desktop/bridge';

/**
 * The hidden worker window (#7 S5), driven without an Electron runtime.
 *
 * `bridge/peer-turn-window.ts` is the file that knows what a worker IS on this
 * platform, and the reason it is testable at all is that it does not import
 * `electron`: the two constructors are injected, typed against the members it
 * uses, exactly as `utility-host.ts` is typed against `UtilityProcess`. So the
 * fakes below are not a re-description of the file's behaviour — they are the
 * shapes Electron supplies, and `main.ts` passes the real classes into the same
 * parameter. `npm run typecheck` is what says the real `BrowserWindow` and
 * `MessageChannelMain` satisfy these interfaces.
 *
 * What is NOT checked here, and cannot be: that Electron really transfers a
 * `MessagePortMain` over `webContents.postMessage`, that a `show: false` window
 * really runs its page, and that a lost renderer really closes the port. Those
 * were MEASURED against Electron 44 in `dev/probe-electron-hidden-worker/` and
 * written up in `docs/BACKGROUND-WORK-MEASUREMENTS.md` section 5; this file
 * checks that what was measured is what got wired.
 */

/* ── The Electron doubles ─────────────────────────────────────────────── */

/**
 * A listener as a fake stores it.
 *
 * `never[]` rather than `unknown[]`: the code under test declares what each
 * event's listener is handed (`peer-turn-window.ts`), and a store that claimed
 * to hand out `unknown` could not hold a listener that expects
 * `{ preventDefault() }`. `fire` is the one place the arguments are put back.
 */
type StoredListener = (...args: never[]) => void;

/** Call listeners with the arguments Electron would supply for their event. */
function fire(listeners: readonly StoredListener[], ...args: unknown[]): void {
  for (const listener of [...listeners]) (listener as (...supplied: unknown[]) => void)(...args);
}

class FakePort {
  readonly posted: unknown[] = [];
  started = 0;
  readonly #listeners = new Map<string, StoredListener[]>();

  postMessage(message: unknown): void {
    this.posted.push(message);
  }

  on(event: 'message', listener: (messageEvent: { data: unknown }) => void): unknown;
  on(event: 'close', listener: () => void): unknown;
  on(event: string, listener: StoredListener): unknown {
    const list = this.#listeners.get(event) ?? [];
    list.push(listener);
    this.#listeners.set(event, list);
    return this;
  }

  start(): void {
    this.started += 1;
  }

  /** What Electron does when the page posts: one `{ data }` message event. */
  deliver(data: unknown): void {
    fire(this.#listeners.get('message') ?? [], { data });
  }

  close(): void {
    fire(this.#listeners.get('close') ?? []);
  }
}

class FakeChannel implements WorkerChannelLike {
  readonly port1 = new FakePort();
  readonly port2 = { id: 'port2' };

  constructor() {
    channels.push(this);
  }
}

class FakeWebContents implements WorkerWebContentsLike {
  readonly id: number;
  /** `[channel, message, transfer]` per `webContents.postMessage`. */
  readonly transfers: Array<[string, unknown, unknown[] | undefined]> = [];
  windowOpenHandler: (() => { action: 'deny' }) | null = null;
  readonly #listeners = new Map<string, StoredListener[]>();

  constructor(id: number) {
    this.id = id;
  }

  postMessage(channel: string, message: unknown, transfer?: unknown[]): void {
    this.transfers.push([channel, message, transfer]);
  }

  on(event: 'render-process-gone', listener: (...args: unknown[]) => void): unknown;
  on(event: 'will-navigate', listener: (navigation: { preventDefault(): void }) => void): unknown;
  on(event: string, listener: StoredListener): unknown {
    return this.#add(event, listener);
  }

  once(event: 'did-finish-load', listener: () => void): unknown;
  once(event: 'destroyed', listener: () => void): unknown;
  once(event: string, listener: StoredListener): unknown {
    return this.#add(event, listener);
  }

  setWindowOpenHandler(handler: () => { action: 'deny' }): void {
    this.windowOpenHandler = handler;
  }

  emit(event: string, ...args: unknown[]): void {
    fire(this.#listeners.get(event) ?? [], ...args);
  }

  #add(event: string, listener: StoredListener): this {
    const list = this.#listeners.get(event) ?? [];
    list.push(listener);
    this.#listeners.set(event, list);
    return this;
  }
}

let nextWebContentsId = 100;

class FakeWindow implements WorkerWindowLike {
  readonly webContents: FakeWebContents;
  readonly options: PeerTurnWindowConstructorOptions;
  readonly loaded: string[] = [];
  destroyed = 0;
  /** Settles the pending `loadURL`, so a load failure can be driven. */
  settleLoad: ((failure?: Error) => void) | null = null;
  #destroyed = false;

  constructor(options: PeerTurnWindowConstructorOptions) {
    this.options = options;
    this.webContents = new FakeWebContents(nextWebContentsId++);
    built.push(this);
  }

  loadURL(url: string): Promise<void> {
    this.loaded.push(url);
    return new Promise<void>((settle, fail) => {
      this.settleLoad = (failure?: Error) => (failure === undefined ? settle() : fail(failure));
    });
  }

  isDestroyed(): boolean {
    return this.#destroyed;
  }

  destroy(): void {
    this.destroyed += 1;
    this.#destroyed = true;
  }
}

/** Every window built since the last spawner was made, newest last. */
let built: FakeWindow[] = [];
/**
 * Every channel built, in the same order.
 *
 * The code under test constructs the window first and its channel second, once
 * each per spawn, so the two lists are paired by index — which is the only way
 * a test can reach MAIN's end of a port that is otherwise handed straight to
 * the `MessageLink`.
 */
let channels: FakeChannel[] = [];

function electron(): PeerTurnElectron {
  built = [];
  channels = [];
  return { BrowserWindow: FakeWindow, MessageChannelMain: FakeChannel };
}

/** Main's end of the channel the spawn built for this window. */
function channelOf(window: FakeWindow): FakePort {
  return channels[built.indexOf(window)]!.port1;
}

function spawnOne(appUrl = 'chatterang-desktop://app/index.html'): {
  readonly spawn: ReturnType<typeof createPeerTurnWorkerSpawner>;
  readonly first: () => FakeWindow;
} {
  const spawn = createPeerTurnWorkerSpawner({
    appUrl,
    preloadPath: '/Applications/Chatterang.app/build/peer-turn-preload.cjs',
    electron: electron(),
  });
  return { spawn, first: () => built[0]! };
}

/* ── The URL ──────────────────────────────────────────────────────────── */

describe('the worker’s URL is the app’s URL, marked', () => {
  it('adds the flag to the built bundle’s URL, on the app’s own scheme', () => {
    const url = peerTurnWorkerUrl('chatterang-desktop://app/index.html');
    // The literal contract with `src/peer-turn-worker.ts`, which reads the same
    // parameter out of `window.location.search`. Spelled out rather than built
    // from the constants, so renaming either end fails here.
    expect(url).toBe('chatterang-desktop://app/index.html?peerTurnWorker=1');
    expect(new URL(url).searchParams.get('peerTurnWorker')).toBe('1');
    // Same origin, same path: it IS the app, so `isTrustedOrigin` and
    // `resolveBundleUrl` need no new case for it (`security.ts`).
    expect(new URL(url).host).toBe('app');
    expect(new URL(url).pathname).toBe('/index.html');
  });

  it('adds it to the dev server’s URL too', () => {
    expect(peerTurnWorkerUrl('http://localhost:5273')).toBe('http://localhost:5273/?peerTurnWorker=1');
  });

  it('keeps an existing query and fragment, and replaces its own parameter', () => {
    expect(peerTurnWorkerUrl('http://localhost:5273/?a=1#/chat')).toBe(
      'http://localhost:5273/?a=1&peerTurnWorker=1#/chat',
    );
    // Never two of them: the renderer half would have to pick one.
    expect(peerTurnWorkerUrl('http://localhost:5273/?peerTurnWorker=0')).toBe(
      'http://localhost:5273/?peerTurnWorker=1',
    );
  });

  it('appends lexically when the URL does not parse, rather than throwing', () => {
    // A URL this bad is a load failure either way; the failure to report is the
    // load's, not this function's.
    expect(peerTurnWorkerUrl('not a url')).toBe('not a url?peerTurnWorker=1');
    expect(peerTurnWorkerUrl('not a url#frag')).toBe('not a url?peerTurnWorker=1#frag');
  });

  it('the contract strings are the ones both halves were written against', () => {
    expect(PEER_TURN_WORKER_PARAM).toBe('peerTurnWorker');
    expect(PEER_TURN_WORKER_VALUE).toBe('1');
    expect(PEER_TURN_PORT_CHANNEL).toBe('peer-turn-port');

    // The preload is the other end of the channel name, and it imports it
    // rather than spelling it — asserted here so a preload rewritten to
    // hard-code its own string is caught. The port never leaves the preload
    // now (see this file's header), so there is no second contract string for
    // a page to announce readiness with, and `window.__peerTurn` — the flat
    // `contextBridge` global that replaced it — is `peer-turn-preload.ts`'s
    // own test surface, not this file's.
    const preload = readFileSync(resolve(process.cwd(), 'apps/desktop/src/peer-turn-preload.ts'), 'utf8');
    expect(preload).toMatch(/import \{ PEER_TURN_PORT_CHANNEL \} from '\.\/bridge\/peer-turn-window\.js'/);
    expect(preload).not.toMatch(/'peer-turn-port'/);
  });
});

/* ── The window ───────────────────────────────────────────────────────── */

describe('the worker window a spawn builds', () => {
  it('is hidden, sandboxed, context-isolated and unthrottled, with the worker preload', () => {
    const { spawn, first } = spawnOne();
    spawn();

    expect(built).toHaveLength(1);
    expect(first().options.show).toBe(false);
    expect(first().options.webPreferences).toEqual({
      preload: '/Applications/Chatterang.app/build/peer-turn-preload.cjs',
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: false,
      // Section 5.3: measurable difference none, and the setting a page that
      // runs a turn wants if this window is ever shown and hidden.
      backgroundThrottling: false,
    });
    expect(first().loaded).toEqual(['chatterang-desktop://app/index.html?peerTurnWorker=1']);
  });

  it('builds a whole window per call: one life each, never a shared one', () => {
    const { spawn } = spawnOne();
    const a = spawn();
    const b = spawn();
    expect(built).toHaveLength(2);
    expect(a.senderId).not.toBe(b.senderId);
  });

  it('names the window’s real webContents id, which is what PluginHost will see', () => {
    const { spawn, first } = spawnOne();
    const spawned = spawn();
    // Never invented: `hostedUnitOf` matches this against the sender id of the
    // window calling `LlamaCpp.generate` (`worker-host.ts`, THE SENDER ID IS REAL).
    expect(spawned.senderId).toBe(first().webContents.id);
    expect(Number.isInteger(spawned.senderId)).toBe(true);
    expect(spawned.senderId).toBeGreaterThan(0);
  });

  it('refuses navigation and window.open, like the app’s own window', () => {
    const { spawn, first } = spawnOne();
    spawn();
    const navigation = { preventDefault: (): void => void (prevented += 1) };
    let prevented = 0;
    first().webContents.emit('will-navigate', navigation);
    expect(prevented).toBe(1);
    expect(first().webContents.windowOpenHandler?.()).toEqual({ action: 'deny' });
  });
});

/* ── The port ─────────────────────────────────────────────────────────── */

describe('the port the worker speaks over', () => {
  it('is started, or nothing the worker ever sends is delivered', () => {
    const { spawn, first } = spawnOne();
    spawn();
    // Electron's MessagePortMain queues until `start()`. Without this call the
    // worker's HostBoot, and every reply after it, sits unread.
    expect(first().webContents.transfers).toHaveLength(0);
    expect(channelOf(first()).started).toBe(1);
  });

  it('is transferred to the preload only once the page has loaded', () => {
    const { spawn, first } = spawnOne();
    spawn();
    const contents = first().webContents;
    expect(contents.transfers).toHaveLength(0);

    contents.emit('did-finish-load');
    expect(contents.transfers).toHaveLength(1);
    const [channel, message, transfer] = contents.transfers[0]!;
    expect(channel).toBe('peer-turn-port');
    expect(message).toBeNull();
    // The page's end, never main's.
    expect(transfer).toEqual([{ id: 'port2' }]);
  });

  it('routes postMessage out and message events in, as a MessageLink', () => {
    const { spawn, first } = spawnOne();
    const { handle } = spawn();
    const port = channelOf(first());

    handle.link.postMessage({ kind: 'ping', id: 1 });
    expect(port.posted).toEqual([{ kind: 'ping', id: 1 }]);

    const seen: unknown[] = [];
    handle.link.onMessage((message) => seen.push(message));
    // Electron delivers `{ data }`; the listener is handed the data alone.
    port.deliver({ kind: 'pong', id: 1 });
    expect(seen).toEqual([{ kind: 'pong', id: 1 }]);
  });

  it('delivers to every listener, and a second listener misses nothing sent after it', () => {
    const { spawn, first } = spawnOne();
    const { handle } = spawn();
    const a: unknown[] = [];
    const b: unknown[] = [];
    handle.link.onMessage((message) => a.push(message));
    handle.link.onMessage((message) => b.push(message));
    channelOf(first()).deliver('x');
    expect(a).toEqual(['x']);
    expect(b).toEqual(['x']);
  });

  it('does not throw on a post after the loss: Electron does not, and a throw would be invented', () => {
    const { spawn, first } = spawnOne();
    const { handle } = spawn();
    channelOf(first()).close();
    // Measured (section 5.2): a post to a closed MessagePortMain returned
    // without throwing 3 s after its close. The Supervisor has already been
    // told through onClose.
    expect(() => handle.link.postMessage({ kind: 'ping', id: 2 })).not.toThrow();
  });
});

/* ── The loss ─────────────────────────────────────────────────────────── */

describe('a worker life ends once, whichever way it goes', () => {
  it('the port closing is a loss', () => {
    const { spawn, first } = spawnOne();
    const { handle } = spawn();
    const reasons: string[] = [];
    handle.link.onClose((reason) => reasons.push(reason));
    channelOf(first()).close();
    expect(reasons).toEqual([WORKER_PORT_CLOSED]);
  });

  it('a renderer that went is a loss', () => {
    const { spawn, first } = spawnOne();
    const { handle } = spawn();
    const reasons: string[] = [];
    handle.link.onClose((reason) => reasons.push(reason));
    first().webContents.emit('render-process-gone', {}, { reason: 'crashed' });
    expect(reasons).toEqual([WORKER_RENDERER_GONE]);
  });

  it('a destroyed webContents is a loss — the one case with no port to close', () => {
    const { spawn, first } = spawnOne();
    const { handle } = spawn();
    const reasons: string[] = [];
    handle.link.onClose((reason) => reasons.push(reason));
    first().webContents.emit('destroyed');
    expect(reasons).toEqual([WORKER_DESTROYED]);
  });

  it('a load that failed is a loss, rather than a life that waits out the ping budget', () => {
    const { spawn, first } = spawnOne();
    const { handle } = spawn();
    const reasons: string[] = [];
    handle.link.onClose((reason) => reasons.push(reason));

    first().settleLoad?.(new Error('ERR_FAILED'));
    return Promise.resolve().then(() => {
      expect(reasons).toEqual([WORKER_LOAD_FAILED]);
    });
  });

  it('the first loss wins: a crash, then the kill’s destroy, is one loss', () => {
    const { spawn, first } = spawnOne();
    const { handle } = spawn();
    const reasons: string[] = [];
    handle.link.onClose((reason) => reasons.push(reason));

    // The measured order on a crash (section 5.2): port close 0.3 ms, then
    // render-process-gone 4.9 ms, then whatever the kill destroys.
    channelOf(first()).close();
    first().webContents.emit('render-process-gone', {}, { reason: 'crashed' });
    first().webContents.emit('destroyed');
    expect(reasons).toEqual([WORKER_PORT_CLOSED]);
  });

  it('tells a listener that arrives after the loss, rather than owing it forever', () => {
    const { spawn, first } = spawnOne();
    const { handle } = spawn();
    channelOf(first()).close();
    const reasons: string[] = [];
    handle.link.onClose((reason) => reasons.push(reason));
    expect(reasons).toEqual([WORKER_PORT_CLOSED]);
  });
});

/* ── The kill ─────────────────────────────────────────────────────────── */

describe('kill', () => {
  it('destroys the window', () => {
    const { spawn, first } = spawnOne();
    const { handle } = spawn();
    handle.kill();
    expect(first().destroyed).toBe(1);
    expect(first().isDestroyed()).toBe(true);
  });

  it('is safe to call twice: the Supervisor kills on every retirement, and condemn kills again', () => {
    const { spawn, first } = spawnOne();
    const { handle } = spawn();
    handle.kill();
    handle.kill();
    handle.kill();
    // `HostHandle.kill` MUST be idempotent (`protocol.ts`); destroying an
    // already-destroyed BrowserWindow throws in Electron.
    expect(first().destroyed).toBe(1);
  });

  it('is safe on a window that went away by itself', () => {
    const { spawn, first } = spawnOne();
    const { handle } = spawn();
    first().destroy();
    expect(() => handle.kill()).not.toThrow();
    expect(first().destroyed).toBe(1);
  });
});

