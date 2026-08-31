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
import type { WebContents } from 'electron';

import {
  BOOTSTRAP_CHANNEL,
  DSH_PLUGIN,
  EVENT_CHANNEL,
  LLAMA_ENGINE,
  LLAMA_PLUGIN,
  ONNX_ENGINE,
  ONNX_PLUGIN,
  PluginHost,
  Supervisor,
  createMainRouter,
  releaseRendererOn,
} from './bridge/index.js';
import type {
  BootManifest,
  DshStatus,
  HostHandle,
  InvokeResult,
  RendererTeardownEvent,
} from './bridge/index.js';
import {
  APP_ORIGIN,
  APP_SCHEME,
  isAllowedExternalUrl,
  isTrustedOrigin,
  resolveBundleUrl,
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

/**
 * The only directory a model may be loaded from.
 *
 * Under `userData`, which is per-user, app-private and outside the bundle. This
 * is the directory the desktop download manager will have to write into: today
 * `src/lib/download.ts` takes its native branch through `@capacitor/filesystem`,
 * which has no desktop implementation, so no model reaches disk through the app
 * on this platform at all. Naming the directory here is what a working
 * downloader will target, and confining `load` to it is what stops the page
 * naming anything else in the meantime.
 */
function modelRoot(): string {
  return join(app.getPath('userData'), 'models');
}

async function serveBundle(request: Request): Promise<Response> {
  const root = appRoot();
  // The whole URL, not just its pathname: `protocol.handle` is registered for
  // the SCHEME, so it is also asked for `chatterang-desktop://app-evil/…`, and
  // answering those served a second working copy of the app at an origin the
  // trust check then had to keep refusing.
  const target = resolveBundleUrl(root, request.url);
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

/**
 * Start one inference host, as a handle the supervisor can replace.
 *
 * Called once at boot and again on every loss — this is the whole of the
 * respawn story on Electron's side, and it is deliberately the only thing in
 * this file that knows what a utility process is. The POLICY (when to give up,
 * how long to wait, how to notice a host that is alive but wedged) lives in
 * `Supervisor`, where tests can reach it.
 */
function spawnInferenceHost(): HostHandle {
  // The model directory is passed as an ARGUMENT because only main can ask
  // Electron where `userData` is, and the host needs it to confine the paths
  // `LlamaCpp.load` is asked to open (defect [8]). The host refuses to start
  // without it rather than guessing a directory, so a wiring mistake here is a
  // boot failure and not a confinement to the wrong place.
  const child = utilityProcess.fork(join(app.getAppPath(), 'build', 'host.mjs'), [modelRoot()], {
    serviceName: 'chatterang-inference',
    // Piped, not inherited: the host's stdout must not reach a terminal or a
    // log the user did not ask for.
    stdio: 'pipe',
  });
  child.stdout?.on('data', (chunk: Buffer) => process.stdout.write(`[inference] ${chunk}`));
  child.stderr?.on('data', (chunk: Buffer) => process.stderr.write(`[inference] ${chunk}`));

  let exited = false;
  child.once('exit', () => {
    exited = true;
  });

  return {
    link: {
      postMessage: (message) => child.postMessage(message),
      onMessage: (listener) => {
        child.on('message', (message: unknown) => listener(message));
      },
      onClose: (listener) => {
        child.once('exit', (code: number) => listener(`exit code ${code}`));
      },
    },
    // Idempotent and safe after exit, as `HostHandle` requires. The call that
    // matters is the one for a host declared lost while its process is still
    // running: an unanswered ping means wedged, not dead, and a wedged host
    // still holds the GPU its replacement is about to ask for.
    kill: () => {
      if (exited) return;
      child.kill();
    },
  };
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

  const supervisor = new Supervisor({
    spawn: spawnInferenceHost,
    // BOTH engines, named explicitly. The option defaults to `[LLAMA_ENGINE]`,
    // so passing it at all means passing the whole list: an engine served by
    // the host but missing from here is refused on arrival by `#receive`
    // rather than dispatched to the wrong place.
    engines: [LLAMA_ENGINE, ONNX_ENGINE],
    // No try/catch here on purpose. The swallow used to live at this call site,
    // which meant a delivery that threw never reached the supervisor and it
    // marked the turn ended anyway — the page got no `llamaEnd` at all while
    // its `generate` promise resolved successfully (defect [13]). `Supervisor`
    // now catches it, logs through `warn`, and leaves the turn open for the
    // next terminal path.
    //
    // The plugin name comes from the SUPERVISOR, not from this call site. It
    // used to be `LLAMA_PLUGIN.name` hard-coded here, which is the same thing
    // as asserting that only one engine will ever emit an event — and which
    // would have delivered a second engine's events on llama.cpp's channels.
    notify: (pluginName, eventName, data, ownerId) =>
      pluginHost.notifyListeners(pluginName, eventName, data, ownerId),
    onBoot: (status) => {
      console.log(
        status.mounted
          ? `[main] DSH tree mounted: services ${status.services.join(', ')}; routes ${status.routes.join(', ')}`
          : `[main] DSH tree did NOT mount: ${status.error ?? 'unknown reason'}`,
      );
    },
    warn: (message) => console.warn(`[main] ${message}`),
  });

  // The facade the supervisor builds from the engine's own definition, rather
  // than the supervisor object itself. With one engine the two were the same
  // thing; with two, an object carrying every engine's methods at once has no
  // way to say which `generate` a call meant.
  pluginHost.register(LLAMA_PLUGIN, supervisor.plugin(LLAMA_PLUGIN.name));
  pluginHost.register(ONNX_PLUGIN, supervisor.plugin(ONNX_PLUGIN.name));
  pluginHost.register(DSH_PLUGIN, {
    // Asked of the supervisor on every call rather than served from a variable
    // captured at boot. The route set within one host's life is still a
    // snapshot — cordis-aimatey captures it once at mount, because aimatey
    // emits no event when a backend appears — but which HOST it describes is
    // now the one that is running, not the one that was running at startup.
    getStatus: async (): Promise<DshStatus> => supervisor.hostStatus(),
    listProviders: async (): Promise<{ providers: readonly string[] }> => ({
      providers: supervisor.hostStatus().routes,
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

  // A quitting app must not fork a replacement host on its way out.
  app.once('will-quit', () => supervisor.dispose());

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

  // A renderer stops being a renderer in three different ways, and only one of
  // them is closing. The cleanup itself, and the list of which events need it,
  // live in `bridge/renderer-lifecycle.ts` where a test can reach them; this is
  // only the registration. A handler missing here is a test failure, because
  // that file's list is checked against the text of this one.
  //
  // `render-process-gone` is the one that was absent: a crash fires neither of
  // the other two (an instrumented build logged `reason=crashed
  // destroyed=false`), so a crashed window's subscriptions stayed in the table
  // and its generation kept decoding with no page left to receive it.
  const teardown = (event: RendererTeardownEvent): void =>
    releaseRendererOn(event, contents.id, {
      releaseSender: (id) => pluginHost.releaseSender(id),
      releaseRenderer: (id, reason) => supervisor.releaseRenderer(id, reason),
      forget: (id) => senders.delete(id),
    });

  contents.on('did-start-navigation', (event) => {
    // A same-document route change is the SPA doing its job, not a page going
    // away; the filter is Electron-shaped and therefore stays here.
    if (!event.isMainFrame || event.isSameDocument) return;
    teardown('did-start-navigation');
  });
  contents.on('render-process-gone', () => teardown('render-process-gone'));
  contents.once('destroyed', () => teardown('destroyed'));

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
