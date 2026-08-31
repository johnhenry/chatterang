/**
 * The Electron main process.
 *
 * Deliberately thin. Everything with logic in it lives in `src/bridge`, which
 * imports no Electron and is therefore driven end-to-end by
 * `tests/desktop-bridge.test.ts` through fake ports. This file's whole job is
 * to turn Electron's objects into the three narrow interfaces that code works
 * against.
 *
 * It holds no security DECISIONS. Every predicate the posture rests on — the
 * trusted-origin test, the external-scheme test, the bundle path resolver and
 * the CSP — lives in `./security.ts`, which imports no Electron and is driven
 * directly by `tests/desktop-security.test.ts`. Importing this file needs a
 * live Electron runtime (`protocol.registerSchemesAsPrivileged` and
 * `app.whenReady()` run at module scope), so anything decided here would be
 * decided where no test can reach it.
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
import {
  APP_ORIGIN,
  APP_SCHEME,
  isAllowedExternalUrl,
  isTrustedOrigin,
  resolveBundleRequest,
} from './security.js';

/** Set only in development; a packaged build must never carry one. */
const DEV_SERVER_URL = process.env['CHATTERANG_DEV_SERVER_URL'] ?? '';

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

async function serveBundle(request: Request): Promise<Response> {
  const root = appRoot();
  const target = resolveBundleRequest(root, new URL(request.url).pathname);
  if (target === null) return new Response('Not found', { status: 404 });

  try {
    const body = await readFile(target.file);
    const headers: Record<string, string> = { 'content-type': target.contentType };
    if (target.csp !== undefined) headers['content-security-policy'] = target.csp;
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
  return isTrustedOrigin(event.sender.getURL(), DEV_SERVER_URL);
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
    if (isTrustedOrigin(url, DEV_SERVER_URL)) return;
    event.preventDefault();
    if (isAllowedExternalUrl(url)) void shell.openExternal(url);
  });
  contents.setWindowOpenHandler(({ url }) => {
    if (isAllowedExternalUrl(url)) void shell.openExternal(url);
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
