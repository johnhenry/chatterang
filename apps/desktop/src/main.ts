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
 * FOUR PROCESSES, TWO BOUNDARIES — and the fourth is the point of this
 * milestone:
 *
 *   renderer (sandboxed, the existing `src/` bundle, unchanged)
 *      | boundary 1 — the plugin bridge, allowlisted channels
 *   main (this file: PluginHost, HostFleet, window, protocol)
 *      | boundary 2 — one utilityProcess message port PER ENGINE
 *   inference host `llama` (LlamaCppNode + node-llama-cpp + the Cordis/DSH tree)
 *   inference host `onnx`  (OnnxRuntimeNode + onnxruntime-node, and nothing else)
 *
 * THE TWO HOSTS ARE NOT A TIDINESS. `InferenceSession.run` is a synchronous
 * native call: it holds its process's event loop for its whole duration, and
 * the supervisor's liveness ping is answered on that loop. Measured in this
 * repo with the real models in one host: a whisper-base encoder run at batch
 * 32 blocked 5506 ms and llama.cpp emitted zero tokens inside it; and at the
 * supervisor level, with the shipped policy, an unbroken block of 11-25 s is
 * CONDEMNED — which kills the process and destroys llama.cpp's in-flight
 * generation with a synthesised terminal and `HANDLE_LOST`. The plugin
 * dimension gave the engines logical isolation; only separate processes give
 * them physical isolation. `bridge/host-fleet.ts` owns the multiplicity, and
 * `Supervisor` itself needed no change at all — it was already generic over
 * hosts, so two engines in two processes is two instances of it.
 *
 * LOGGING RULE, and it is a rule rather than a preference: never log a
 * `GenerateOptions.prompt`, never log a `GenerateResult.text`, and never build
 * an error message that embeds either. `toWireError` forwards `error.message`
 * verbatim to the renderer, so a message built from a prompt crosses the
 * boundary and lands wherever the renderer logs errors.
 */

import { join } from 'node:path';
import { mkdirSync, realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';

import { BrowserWindow, Menu, app, ipcMain, protocol, shell, utilityProcess } from 'electron';
import type { MenuItemConstructorOptions, WebContents } from 'electron';

import {
  BOOTSTRAP_CHANNEL,
  COMMAND_CHANNEL,
  DSH_PLUGIN,
  EVENT_CHANNEL,
  FILESYSTEM_PLUGIN,
  HostFleet,
  LLAMA_ENGINE,
  LLAMA_PLUGIN,
  ONNX_ENGINE,
  ONNX_PLUGIN,
  PluginHost,
  createMainRouter,
  releaseRendererOn,
} from './bridge/index.js';
import type {
  BootManifest,
  DshStatus,
  FleetEntry,
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
import { createFilesystemPlugin } from './fs/filesystem.js';
import { buildMenuTemplate } from './menu.js';
import type { MenuTemplateItem } from './menu.js';

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

/* ── The filesystem the renderer is allowed to see ────────────────────── */

/** The subdirectory of the DATA root that `src/lib/download.ts` writes into. */
const MODEL_DIR = 'models';

/**
 * The app's own files, under `userData` and NOWHERE ELSE IN IT.
 *
 * `userData` ITSELF MUST NOT BE A MAPPED ROOT. Verified on this machine, the
 * real `userData` is `~/Library/Application Support/@chatterang/desktop` —
 * Electron derives it from the scoped package name — and it holds Chromium's
 * profile: `Cookies`, `Local Storage`, `Session Storage`, `IndexedDB`,
 * `Preferences`, `Local State`, `Network Persistent State`, `Trust Tokens`,
 * `blob_storage`. Mapping `Directory.Data` there would make every one of those
 * writable through `writeFile` and removable through a recursive `rmdir`. So
 * the two roots live in a subtree of our own, and Chromium's names are outside
 * it.
 *
 * `files/data` and `files/cache` rather than `data` and `cache`: macOS is
 * case-insensitive by default and `userData/Cache` is Chromium's HTTP cache.
 */
function filesRoot(): string {
  return join(app.getPath('userData'), 'files');
}

/** `Directory.Data` — persistent app storage. CONTAINS the model directory. */
function dataRoot(): string {
  return join(filesRoot(), 'data');
}

/**
 * `Directory.Cache` — reclaimable app storage.
 *
 * Deliberately NOT `app.getPath('cache')`, which resolves to
 * `~/Library/Caches` on this machine — the whole shared user cache root, not an
 * app directory — and deliberately not Chromium's `userData/Cache`, which is
 * the HTTP cache and would collide with it.
 */
function cacheRoot(): string {
  return join(filesRoot(), 'cache');
}

/**
 * Every root, as the FILESYSTEM spells it — symlinks already resolved.
 *
 * NOT COSMETIC, and the reason is the join this milestone exists to make.
 * `getUri` answers with a `realpath`ed path (it must: `confineRealPath`
 * resolves), the app stores that as the model's path, and `LlamaCpp.load` then
 * puts it through `confineModelPath`, which is purely LEXICAL and compares
 * against whatever root string it was handed. Hand it an unresolved root and
 * the two spellings disagree: measured directly, a root under
 * `/var/folders/…` (macOS's tmpdir, a symlink to `/private/var`) makes
 * `realpath(root).startsWith(root + sep)` FALSE, so every path `getUri`
 * returned would be refused at load. Today `~/Library/Application
 * Support/@chatterang/desktop` happens to contain no symlink and the bug is
 * invisible; resolving once here means it cannot appear.
 *
 * Falls back to the unresolved path rather than throwing: the roots are created
 * immediately before this runs, and a boot that dies over a `realpath` is worse
 * than one that carries on with the string it already had.
 */
function realDirectory(directory: string): string {
  try {
    return realpathSync(directory);
  } catch {
    return directory;
  }
}

/**
 * Create every root, before anything can ask for one.
 *
 * `confineRealPath` begins with `realpathSync(root)` and returns null when that
 * throws, so a root that does not exist refuses EVERY path under it —
 * including the `mkdir` that would have created it. Nothing else creates them:
 * `src/lib/export.ts` writes into the cache root with no `mkdir` at all, and
 * the model root was previously created lazily by a downloader that was writing
 * somewhere else entirely, so it never appeared on disk at all.
 *
 * Creating them here is not guessing them. This is the one place that knows
 * where `userData` is, which is exactly why the roots are decided here and
 * injected everywhere else.
 */
function createRoots(): void {
  for (const directory of [dataRoot(), cacheRoot(), join(dataRoot(), MODEL_DIR)]) {
    mkdirSync(directory, { recursive: true });
  }
}

/**
 * The only directory a model may be loaded from, INSIDE the DATA root.
 *
 * That containment is the whole join. `src/lib/download.ts` writes to
 * `models/<engine>/<id>` under `Directory.Data` and stores what `getUri`
 * answers as the model's path; the inference host is handed this directory and
 * confines `LlamaCpp.load` to it. The two only meet if the app's DATA root is
 * the parent of the host's model root — before this, `Directory.Data` had no
 * desktop implementation at all and the downloader's bytes went to IndexedDB
 * while the host looked at a directory that had never been created.
 *
 * Nothing is migrated because there is nothing to migrate: `userData/models`
 * has never existed on this machine, and no download has ever completed on
 * desktop.
 */
function modelRoot(): string {
  return realDirectory(join(dataRoot(), MODEL_DIR));
}

/**
 * The `Directory` values this platform maps, and what they map to.
 *
 * The seven others — `DOCUMENTS`, `LIBRARY`, `EXTERNAL`, `EXTERNAL_STORAGE`,
 * `EXTERNAL_CACHE`, `LIBRARY_NO_CLOUD`, `TEMPORARY` — are absent on purpose and
 * are refused by name. `app.getPath('documents')` is the user's own Documents
 * folder; the rest name iOS/Android storage classes with no desktop analogue,
 * and inventing one is the same class of mistake as guessing a model root.
 *
 * Built HERE and passed in, because `fs/filesystem.ts` must call no
 * `app.getPath()` of its own — same reason the inference host is handed its
 * model root as `argv[2]`, and what lets a headless server (A9) supply its own
 * roots without touching that file.
 */
function filesystemRoots(): ReadonlyMap<string, string> {
  return new Map([
    ['DATA', realDirectory(dataRoot())],
    ['CACHE', realDirectory(cacheRoot())],
  ]);
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
function spawnInferenceHost(engineName: string): HostHandle {
  // The model directory is passed as an ARGUMENT because only main can ask
  // Electron where `userData` is, and the host needs it to confine the paths
  // `LlamaCpp.load` is asked to open (defect [8]). The host refuses to start
  // without it rather than guessing a directory, so a wiring mistake here is a
  // boot failure and not a confinement to the wrong place.
  //
  // The ENGINE NAME is the second argument, and it is the whole of the split
  // on this side: one bundled entry point, forked twice, each fork loading its
  // own engine through a dynamic import. `host/host-engine.ts` refuses to
  // guess if it is missing, for the same reason the model root is refused —
  // a host that guessed would load the wrong native addon and look like it
  // worked.
  const child = utilityProcess.fork(
    join(app.getAppPath(), 'build', 'host.mjs'),
    [modelRoot(), engineName],
    {
      serviceName: `chatterang-inference-${engineName}`,
      // Piped, not inherited: the host's stdout must not reach a terminal or a
      // log the user did not ask for.
      stdio: 'pipe',
    },
  );
  const tag = `[inference:${engineName}]`;
  child.stdout?.on('data', (chunk: Buffer) => process.stdout.write(`${tag} ${chunk}`));
  child.stderr?.on('data', (chunk: Buffer) => process.stderr.write(`${tag} ${chunk}`));

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

/* ── The menu, and the second door into the dispatch layer ────────────── */

/**
 * Turn the template's `command` markers into Electron `click` handlers.
 *
 * THIS IS THE WHOLE OF DOOR 2, and until now nothing stood at it: `src/lib/
 * keys.ts` published a command dispatcher with a documented external entrance
 * and `apps/desktop` registered no menu item, no accelerator and no global
 * shortcut, so the seam connected the app to nobody.
 *
 * It sends DOWN THE PRELOAD BRIDGE — one inbound-only channel, picked up by
 * `createRendererBridge` and handed to whoever called `onCommand` — and NOT by
 * executing script in the main world. `webContents.executeJavaScript` would
 * have been one line and would have reached for exactly the main-world global
 * this milestone removed.
 *
 * FIRE AND FORGET, deliberately. A `send` has no return value, so main cannot
 * learn whether a handler claimed the command and cannot grey the item out on
 * that basis. That is affordable now and was not before: `App.tsx` registers
 * an app-level fallback for every chat command, so a menu item is claimable on
 * all five tabs rather than only while the chat screen is mounted.
 *
 * The FOCUSED window, not a captured one. On macOS the app outlives its
 * windows and `activate` makes another; a menu item bound to the window that
 * happened to exist at boot would fire into a destroyed renderer.
 */
function toElectronMenu(
  template: readonly MenuTemplateItem[],
): MenuItemConstructorOptions[] {
  return template.map((entry) => {
    const { command, submenu, ...rest } = entry;
    const built = { ...rest } as MenuItemConstructorOptions;
    if (submenu) built.submenu = toElectronMenu(submenu);
    if (command) {
      built.click = () => {
        const target = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
        if (target === undefined || target.isDestroyed()) return;
        target.webContents.send(COMMAND_CHANNEL, command);
      };
    }
    return built;
  });
}

function installMenu(): void {
  const template = buildMenuTemplate({
    appName: app.getName(),
    isMac: process.platform === 'darwin',
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate(toElectronMenu(template)));
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

  // Created BEFORE they are resolved, and resolved before anything is handed
  // one: `realDirectory` of a directory that does not exist yet would silently
  // answer with the unresolved string, which is the disagreement it exists to
  // prevent.
  createRoots();
  const roots = filesystemRoots();

  const pluginHost = new PluginHost((senderId, payload) => {
    const sender = senders.get(senderId);
    if (sender === undefined || sender.isDestroyed()) return false;
    sender.send(EVENT_CHANNEL, payload);
    return true;
  });

  /*
   * ONE HOST PER ENGINE, and the per-host liveness budget the split makes safe.
   *
   * The `onnx` entry's `pingTimeoutMs` is the second half of the fix. A ping
   * budget sized to the worst legitimate blocking call is dangerous while one
   * process holds both engines: it means a genuinely wedged host takes that
   * much longer to be replaced, and text generation is stuck behind it the
   * whole time. Once the ONNX host holds ONLY ONNX, relaxing its liveness
   * costs nothing llama.cpp depends on — and the llama host keeps the shipped
   * 10 s, because nothing it runs blocks the loop synchronously.
   *
   * 60 s is chosen against what was MEASURED, not against diffusion. The worst
   * single ONNX run observed on this machine is 5506 ms (whisper-base encoder,
   * batch 32); shipped whisper is 132 ms per batch-1 window with a return to
   * the loop between every run. 60 s is an order of magnitude over the
   * measured worst and still terminates a truly wedged host inside 75 s. What
   * it is NOT is a measured bound for a diffusion UNet step, which is one
   * uninterruptible `run()` and which nothing in this repo can time yet. If
   * that step turns out to exceed this, the failure is now confined to the
   * ONNX host: it is condemned and respawned alone, and llama.cpp does not
   * notice.
   */
  const FLEET: readonly FleetEntry[] = [
    { engine: LLAMA_ENGINE, host: 'llama' },
    { engine: ONNX_ENGINE, host: 'onnx', policy: { pingTimeoutMs: 60_000 } },
  ];

  const fleet = new HostFleet({
    spawn: spawnInferenceHost,
    entries: FLEET,
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
    onBoot: (hostName, status) => {
      console.log(
        status.mounted
          ? `[main] ${hostName}: DSH tree mounted: services ${status.services.join(', ')}; routes ${status.routes.join(', ')}`
          : `[main] ${hostName}: DSH tree did NOT mount: ${status.error ?? 'unknown reason'}`,
      );
    },
    warn: (hostName, message) => console.warn(`[main:${hostName}] ${message}`),
  });

  // The facade each supervisor builds from its own engine's definition. The
  // fleet routes by plugin name, so registering a plugin no host serves throws
  // here at boot rather than failing every call at runtime.
  pluginHost.register(LLAMA_PLUGIN, fleet.plugin(LLAMA_PLUGIN.name));
  pluginHost.register(ONNX_PLUGIN, fleet.plugin(ONNX_PLUGIN.name));
  /*
   * The filesystem, served from MAIN rather than through the supervisor.
   *
   * `DSH_PLUGIN` below is already registered with an inline implementation, so
   * a main-resident plugin is the established pattern here — but for this one
   * it is also a size decision. A 4 MiB slice of a model becomes a ~5.33 MB
   * base64 string per `appendFile`, and routing it through a utility process
   * would make that string cross a SECOND process boundary for no benefit; the
   * inference host's job is inference. (That figure is arithmetic from
   * `download.ts`'s chunk size, not a measurement.)
   *
   * Ten of the fifteen declared methods exist only to REFUSE — see
   * `FILESYSTEM_METHODS` for why declaring fewer would reopen the bug rather
   * than shrink the surface. They are not dead code to be tidied away.
   */
  pluginHost.register(FILESYSTEM_PLUGIN, createFilesystemPlugin({ roots }));
  pluginHost.register(DSH_PLUGIN, {
    // THE LLAMA HOST, deliberately and by name. The Cordis tree mounts only
    // where the Router and the llama backend are (`host/llama-engine.ts`);
    // the ONNX host has no route into it and reports no boot status, so
    // asking any other host would answer "not mounted" for a tree that was
    // never supposed to be there. An ONNX host loss is therefore invisible in
    // `DshStatus` — correctly: `DshStatus` describes the tree, not the fleet.
    //
    // Asked of the supervisor on every call rather than served from a variable
    // captured at boot. The route set within one host's life is still a
    // snapshot — cordis-aimatey captures it once at mount, because aimatey
    // emits no event when a backend appears — but which HOST it describes is
    // now the one that is running, not the one that was running at startup.
    getStatus: async (): Promise<DshStatus> => fleet.statusOf(LLAMA_PLUGIN.name),
    listProviders: async (): Promise<{ providers: readonly string[] }> => ({
      providers: fleet.statusOf(LLAMA_PLUGIN.name).routes,
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

  // A quitting app must not fork a replacement host on its way out — for
  // EITHER host. `dispose` over the whole fleet, from the fleet, so a host
  // added later cannot be forgotten here.
  app.once('will-quit', () => fleet.dispose());

  // Before the first window, so the menu is up by the time it can be used.
  // `setApplicationMenu` REPLACES Electron's default, which on macOS is what
  // gives a sandboxed renderer Cmd+C, Cmd+V and Cmd+Q at all — so the template
  // carries the standard roles as well as ours. See `./menu.ts`.
  installMenu();

  createWindow(pluginHost, fleet, senders);
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow(pluginHost, fleet, senders);
  });
}

function createWindow(
  pluginHost: PluginHost,
  fleet: HostFleet,
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
      // OVER THE WHOLE FLEET. This is the one wiring mistake the split makes
      // possible that fails SILENTLY: a teardown reaching only one supervisor
      // leaks exactly the other engine's turns and sessions, for every window
      // that ever closes, with no error and nothing a boot check can see. So
      // the fan-out lives in `HostFleet`, where `tests/desktop-bridge.test.ts`
      // drives it, and this call site cannot name one host.
      releaseRenderer: (id, reason) => fleet.releaseRenderer(id, reason),
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
