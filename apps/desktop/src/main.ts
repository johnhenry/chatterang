/**
 * The Electron main process.
 *
 * Deliberately thin. Everything with logic in it lives in `src/bridge`, which
 * imports no Electron and is therefore driven end-to-end by
 * `tests/desktop-bridge.test.ts` through fake ports. This file's whole job is
 * to turn Electron's objects into the three narrow interfaces that code works
 * against, and to hold the security posture in one readable place.
 *
 * THREE PROCESSES, TWO BOUNDARIES:
 *
 *   renderer (sandboxed, the existing `src/` bundle, unchanged)
 *      | boundary 1 — the plugin bridge, allowlisted channels
 *   main (this file: PluginHost, Supervisor, window, protocol)
 *      | boundary 2 — a utilityProcess message port
 *   inference host (LlamaCppNode + node-llama-cpp + the Cordis/DSH tree)
 *
 * LOGGING RULE, and it is a rule rather than a preference: never log a
 * `GenerateOptions.prompt`, never log a `GenerateResult.text`, and never build
 * an error message that embeds either. `toWireError` forwards `error.message`
 * verbatim to the renderer, so a message built from a prompt crosses the
 * boundary and lands wherever the renderer logs errors.
 */

import { join } from 'node:path';
import { readFile } from 'node:fs/promises';

import { BrowserWindow, app, ipcMain, protocol, shell, utilityProcess } from 'electron';
import type { UtilityProcess, WebContents } from 'electron';

import {
  BOOTSTRAP_CHANNEL,
  DSH_PLUGIN,
  EVENT_CHANNEL,
  LLAMA_PLUGIN,
  PluginHost,
  Supervisor,
  createMainRouter,
  toWireError,
} from './bridge/index.js';
import type {
  BootManifest,
  DshStatus,
  InvokeResult,
  MessageLink,
  PluginImplementation,
} from './bridge/index.js';

/** The privileged scheme the production bundle is served from. */
const APP_SCHEME = 'chatterang-desktop';
const APP_ORIGIN = `${APP_SCHEME}://app`;

/** Set only in development; a packaged build must never carry one. */
const DEV_SERVER_URL = process.env['CHATTERANG_DEV_SERVER_URL'] ?? '';

const CSP_PRODUCTION = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self' https: wss:",
  "object-src 'none'",
  "frame-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

const MIME: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
  '.map': 'application/json; charset=utf-8',
};

protocol.registerSchemesAsPrivileged([
  {
    scheme: APP_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
  },
]);

/* ── The web bundle, served from disk ─────────────────────────────────── */

/** `apps/desktop/app` — a verbatim copy of `dist/`, written by `scripts/sync.mjs`. */
function appRoot(): string {
  return join(app.getAppPath(), 'app');
}

/**
 * Resolve a request path inside the app root, or reject it.
 *
 * Returns null for anything that escapes, so `../../../etc/passwd` is a 404
 * rather than a file read.
 */
function resolveWithinRoot(root: string, pathname: string): string | null {
  const decoded = decodeURIComponent(pathname).replace(/^\/+/, '');
  const resolved = join(root, decoded);
  const prefix = root.endsWith('/') ? root : `${root}/`;
  return resolved === root || resolved.startsWith(prefix) ? resolved : null;
}

async function serveBundle(request: Request): Promise<Response> {
  const root = appRoot();
  const url = new URL(request.url);
  const target = resolveWithinRoot(root, url.pathname === '/' ? '/index.html' : url.pathname);
  if (target === null) return new Response('Not found', { status: 404 });

  const extension = /\.[a-z0-9]+$/i.exec(target)?.[0]?.toLowerCase() ?? '';
  // SPA fallback: an extensionless path is a client route, not a file.
  const file = extension === '' ? join(root, 'index.html') : target;

  try {
    const body = await readFile(file);
    const type = extension === '' ? MIME['.html'] : (MIME[extension] ?? 'application/octet-stream');
    const headers: Record<string, string> = { 'content-type': type ?? 'text/plain' };
    if (type === MIME['.html']) headers['content-security-policy'] = CSP_PRODUCTION;
    return new Response(new Uint8Array(body), { headers });
  } catch {
    return new Response('Not found', { status: 404 });
  }
}

/* ── The inference host ───────────────────────────────────────────────── */

function utilityProcessLink(child: UtilityProcess): MessageLink {
  return {
    postMessage: (message) => child.postMessage(message),
    onMessage: (listener) => {
      child.on('message', (message: unknown) => listener(message));
    },
    onClose: (listener) => {
      child.once('exit', (code: number) => listener(`exit code ${code}`));
    },
  };
}

function forkInferenceHost(): UtilityProcess {
  return utilityProcess.fork(join(app.getAppPath(), 'build', 'host.mjs'), [], {
    serviceName: 'chatterang-inference',
    // Piped, not inherited: the host's stdout must not reach a terminal or a
    // log the user did not ask for.
    stdio: 'pipe',
  });
}

/* ── Sender trust ─────────────────────────────────────────────────────── */

function isTrusted(event: { senderFrame: unknown; sender: WebContents }): boolean {
  // Every iframe is refused outright: only the top frame of a window we
  // created may reach a plugin.
  if (event.senderFrame !== event.sender.mainFrame) return false;
  const url = event.sender.getURL();
  if (url.startsWith(APP_ORIGIN)) return true;
  // A dev-server prefix is a string prefix, so `http://localhost:5273` also
  // prefixes `http://localhost:52739`. That only matters when a dev URL is
  // set, and `scripts/sync.mjs` refuses to package a build that has one.
  return DEV_SERVER_URL !== '' && url.startsWith(DEV_SERVER_URL);
}

/* ── Wiring ───────────────────────────────────────────────────────────── */

function start(): void {
  const senders = new Map<number, WebContents>();

  const pluginHost = new PluginHost((senderId, payload) => {
    const sender = senders.get(senderId);
    if (sender === undefined || sender.isDestroyed()) return false;
    sender.send(EVENT_CHANNEL, payload);
    return true;
  });

  const child = forkInferenceHost();
  child.stdout?.on('data', (chunk: Buffer) => process.stdout.write(`[inference] ${chunk}`));
  child.stderr?.on('data', (chunk: Buffer) => process.stderr.write(`[inference] ${chunk}`));

  let dshStatus: DshStatus = {
    mounted: false,
    services: [],
    routes: [],
    treeAssertion: 'not reported: the inference host has not finished booting',
  };

  const supervisor = new Supervisor({
    link: utilityProcessLink(child),
    notify: (eventName, data) => {
      try {
        pluginHost.notifyListeners(LLAMA_PLUGIN.name, eventName, data);
      } catch (error) {
        // A non-cloneable event payload. Loud in the log, and dropped rather
        // than delivered half-formed; it must not take main down.
        console.error(`[main] refused to deliver ${eventName}: ${toWireError(error).message}`);
      }
    },
    onBoot: (status) => {
      dshStatus = status;
      console.log(
        status.mounted
          ? `[main] DSH tree mounted: services ${status.services.join(', ')}; routes ${status.routes.join(', ')}`
          : `[main] DSH tree did NOT mount: ${status.error ?? 'unknown reason'}`,
      );
    },
    warn: (message) => console.warn(`[main] ${message}`),
  });

  pluginHost.register(LLAMA_PLUGIN, supervisor as unknown as PluginImplementation);
  pluginHost.register(DSH_PLUGIN, {
    getStatus: async (): Promise<DshStatus> => dshStatus,
    // The route set is a boot snapshot on purpose: cordis-aimatey captures it
    // once at mount, because aimatey emits no event when a backend appears.
    listProviders: async (): Promise<{ providers: readonly string[] }> => ({
      providers: dshStatus.routes,
    }),
  });

  const router = createMainRouter(pluginHost);
  const manifest = router.bootstrap();
  const emptyManifest: BootManifest = { platform: 'electron', plugins: [] };

  ipcMain.on(BOOTSTRAP_CHANNEL, (event) => {
    // An untrusted frame is told about a platform with no plugins, rather than
    // given an error it could probe.
    event.returnValue = isTrusted(event) ? manifest : emptyManifest;
  });

  // Every channel comes from the manifest, and nothing else is registered. The
  // routing itself lives in `createMainRouter` because that is the code the
  // bridge tests drive; duplicating it here would leave the real one unchecked.
  for (const channel of router.channels()) {
    ipcMain.handle(channel, async (event, payload: unknown): Promise<InvokeResult> => {
      if (!isTrusted(event)) {
        return { ok: false, error: { message: 'desktop bridge: untrusted sender.' } };
      }
      senders.set(event.sender.id, event.sender);
      return router.handle(event.sender.id, channel, payload);
    });
  }

  createWindow(pluginHost, supervisor, senders);
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow(pluginHost, supervisor, senders);
  });
}

function createWindow(
  pluginHost: PluginHost,
  supervisor: Supervisor,
  senders: Map<number, WebContents>,
): BrowserWindow {
  const window = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 480,
    minHeight: 480,
    backgroundColor: '#101014',
    show: false,
    webPreferences: {
      // Security defaults. Non-negotiable; not configurable.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
      preload: join(app.getAppPath(), 'build', 'preload.cjs'),
    },
  });

  const contents = window.webContents;
  senders.set(contents.id, contents);

  // A reload does NOT destroy a webContents, so cleaning up only on destroy
  // leaks one page's worth of subscriptions per Cmd+R and leaves the previous
  // page's generation running in the host, burning GPU for nobody.
  contents.on('did-start-navigation', (event) => {
    if (!event.isMainFrame || event.isSameDocument) return;
    pluginHost.releaseSender(contents.id);
    supervisor.releaseRenderer('The page that started this generation navigated away.');
  });

  contents.once('destroyed', () => {
    senders.delete(contents.id);
    pluginHost.releaseSender(contents.id);
    supervisor.releaseRenderer('The window that started this generation was closed.');
  });

  // Navigation lock: nothing may leave our origin in-window, and window.open
  // is refused outright.
  contents.on('will-navigate', (event, url) => {
    if (url.startsWith(APP_ORIGIN) || (DEV_SERVER_URL !== '' && url.startsWith(DEV_SERVER_URL))) return;
    event.preventDefault();
    void shell.openExternal(url);
  });
  contents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  window.once('ready-to-show', () => window.show());
  void window.loadURL(DEV_SERVER_URL !== '' ? DEV_SERVER_URL : `${APP_ORIGIN}/index.html`);
  return window;
}

void app.whenReady().then(() => {
  protocol.handle(APP_SCHEME, serveBundle);
  start();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
