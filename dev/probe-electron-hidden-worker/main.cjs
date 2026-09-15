// BN3: what a real Electron 44 does to a hidden worker window.
//
//   node dev/probe-electron-hidden-worker/run.cjs                    (every scenario, one Electron each)
//   node_modules/.bin/electron dev/probe-electron-hidden-worker/main.cjs --only='<scenario>' -ApplePersistenceIgnoreState YES
//
// Four questions (docs/BACKGROUND-WORK-MEASUREMENTS.md, section 5):
//
//   wac:    does app 'window-all-closed' fire while a show:false window exists,
//           and when that window goes after the last visible one?
//   port:   does a MessagePortMain emit 'close' when its renderer crashes, is
//           destroyed, is killed, or reloads, and in what order against
//           'render-process-gone' and 'destroyed'?
//   worker: for a hidden window with backgroundThrottling:false, running the
//           REAL WorkerHost -> Supervisor -> (port) -> HostRuntime, what are
//           stream pacing, resident memory and ping round trips, and which
//           blocks of the page's thread (5, 15, 30 s) does the shipped ping
//           budget condemn?
//   tray:   does a macOS status item get on-screen bounds?
//
// It opens no socket. Each scenario checks, with lsof, that no process it
// started holds one bound to anything but 127.0.0.1, and fails otherwise.
// Output is one `PROBE_RESULT <json>` line per scenario (and `PROBE_EVENT`
// lines for scenarios that may quit the app); the exit code is non-zero when a
// step failed.
'use strict';

const { app, BrowserWindow, MessageChannelMain, protocol, Tray, nativeImage, screen } = require('electron');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');
const lib = require('./lib.cjs');

const { out, arg, flag, sleep, until, stats } = lib;

const SCHEME = 'probe-worker';
const PAGE_URL = `${SCHEME}://app/worker.html`;
const PRELOAD = join(__dirname, 'preload.cjs');
const ROOT = lib.tempRoot('probe-bn3-worker-');
const ONLY = arg('only');
const LIST = flag('list');
const BRIDGE_REF = arg('bridge-ref');
/** Probe pings carry ids at or above this, so the Supervisor never mistakes their pongs for its own. */
const PROBE_PING_BASE = 1_000_000_000;

const t0 = process.hrtime.bigint();
/** Milliseconds since this process started, monotonic. */
const now = () => Number(process.hrtime.bigint() - t0) / 1e6;
/** `Date.now() - now()`: turns a wall reading from the page into this process's `now()`. */
const wallOffset = Date.now() - now();
const fromWall = (wall) => wall - wallOffset;
const round = (n) => (n === null || n === undefined ? n : Math.round(n * 10) / 10);

const encoder = new TextEncoder();
const decoder = new TextDecoder();

protocol.registerSchemesAsPrivileged([
  { scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
]);
lib.quietApp(app, ROOT);
lib.guardListen();

let bridge = null;

/* ── Scenarios ─────────────────────────────────────────────────────────── */

const scenarios = new Map();
/**
 * @param {string} name
 * @param {(ctx: object) => Promise<object>} fn
 * @param {{ files?: string[], limitMs?: number, noWacListener?: boolean }} [options]
 */
function scenario(name, fn, options = {}) {
  scenarios.set(name, { fn, files: options.files ?? ['host-runtime', 'protocol', 'clone'], limitMs: options.limitMs ?? 60_000, noWacListener: options.noWacListener === true });
}

function servePages() {
  const file = (path, type) => new Response(readFileSync(path), { headers: { 'content-type': type } });
  protocol.handle(SCHEME, (request) => {
    const { pathname } = new URL(request.url);
    if (pathname === '/worker.html') return file(join(__dirname, 'worker.html'), 'text/html');
    if (pathname === '/worker.mjs') return file(join(__dirname, 'worker.mjs'), 'text/javascript');
    if (pathname === '/other.html') return new Response('<!doctype html><title>other</title>', { headers: { 'content-type': 'text/html' } });
    const module = /^\/bridge\/([a-z-]+)\.mjs$/.exec(pathname);
    if (module !== null && bridge !== null) return file(join(bridge.dir, `${module[1]}.mjs`), 'text/javascript');
    return new Response('not found', { status: 404 });
  });
}

/** A worker page's own errors, so a page that fails to start says why. Probe pages carry no user text. */
function watchConsole(wc) {
  wc.on('console-message', (details) => {
    if (details.level !== 'error') return;
    out(`PROBE_CONSOLE ${JSON.stringify({ message: String(details.message).slice(0, 300), source: details.sourceId, line: details.lineNumber })}`);
  });
  wc.on('preload-error', (_event, path, error) => out(`PROBE_CONSOLE ${JSON.stringify({ preloadError: String(error?.message), path })}`));
}

const hiddenPrefs = (throttle) => ({
  preload: PRELOAD,
  sandbox: true,
  contextIsolation: true,
  nodeIntegration: false,
  backgroundThrottling: throttle,
});

/** A hidden worker window with its port handed over, ready once the page says hello. */
async function openWorkerWindow(ctx, { throttle = false } = {}) {
  const win = new BrowserWindow({ show: false, webPreferences: hiddenPrefs(throttle) });
  const wc = win.webContents;
  watchConsole(wc);
  const { port1, port2 } = new MessageChannelMain();
  const probe = [];
  port1.on('message', (event) => {
    if (event.data?.k === 'probe') probe.push({ at: now(), ...event.data });
  });
  port1.start();
  wc.once('did-finish-load', () => wc.postMessage('probe-port', null, [port2]));
  await win.loadURL(PAGE_URL);
  await until(() => probe.some((m) => m.op === 'hello'), 10_000, 'the worker page to say hello over its port');
  ctx.checkLoopback('worker window loaded');
  return { win, wc, port1, probe, pid: wc.getOSProcessId() };
}

/* ── wac: window-all-closed ────────────────────────────────────────────── */

async function visibleWindow() {
  // Shown without activation or focus, small and faint: a real visible window,
  // as `isVisible()` reports, that takes nothing from the person at the machine.
  const win = new BrowserWindow({
    show: false,
    focusable: false,
    skipTaskbar: true,
    width: 160,
    height: 90,
    opacity: 0.3,
    webPreferences: { sandbox: true, contextIsolation: true },
  });
  await win.loadURL('about:blank');
  win.showInactive();
  await sleep(300);
  return win;
}

async function hiddenWindow() {
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true } });
  await win.loadURL('about:blank');
  return win;
}

function wacScenario(name, steps, options = {}) {
  scenario(
    `wac: ${name}`,
    async (ctx) => {
      const events = [];
      const mark = (event, extra = {}) => {
        const entry = { event, at: round(now()), windows: BrowserWindow.getAllWindows().length, ...extra };
        events.push(entry);
        out(`PROBE_EVENT ${JSON.stringify(entry)}`);
      };
      if (!options.noWacListener) app.on('window-all-closed', () => mark('window-all-closed'));
      for (const event of ['before-quit', 'will-quit', 'quit']) app.on(event, () => mark(event));
      await steps({ mark, ctx, partial: () => ctx.partial({ events }) });
      return { listener: !options.noWacListener, events };
    },
    { noWacListener: options.noWacListener },
  );
}

wacScenario('visible closed, then hidden destroyed', async ({ mark, ctx }) => {
  const visible = await visibleWindow();
  const hidden = await hiddenWindow();
  ctx.checkLoopback('windows open');
  mark('opened', { visibleIsVisible: visible.isVisible(), hiddenIsVisible: hidden.isVisible() });
  visible.close();
  await sleep(1000);
  mark('1 s after visible.close()');
  hidden.destroy();
  await sleep(1000);
  mark('1 s after hidden.destroy()');
});

wacScenario('visible closed, then hidden closed', async ({ mark, ctx }) => {
  const visible = await visibleWindow();
  const hidden = await hiddenWindow();
  ctx.checkLoopback('windows open');
  mark('opened', { visibleIsVisible: visible.isVisible(), hiddenIsVisible: hidden.isVisible() });
  visible.close();
  await sleep(1000);
  mark('1 s after visible.close()');
  hidden.close();
  await sleep(1000);
  mark('1 s after hidden.close()');
});

wacScenario('visible destroyed, then hidden destroyed', async ({ mark, ctx }) => {
  const visible = await visibleWindow();
  const hidden = await hiddenWindow();
  ctx.checkLoopback('windows open');
  mark('opened', { visibleIsVisible: visible.isVisible(), hiddenIsVisible: hidden.isVisible() });
  visible.destroy();
  await sleep(1000);
  mark('1 s after visible.destroy()');
  hidden.destroy();
  await sleep(1000);
  mark('1 s after hidden.destroy()');
});

wacScenario('hidden only, destroyed', async ({ mark, ctx }) => {
  const hidden = await hiddenWindow();
  ctx.checkLoopback('window open');
  mark('opened', { hiddenIsVisible: hidden.isVisible() });
  hidden.destroy();
  await sleep(1000);
  mark('1 s after hidden.destroy()');
});

wacScenario('hidden built after the last visible window closed, then destroyed', async ({ mark, ctx }) => {
  const visible = await visibleWindow();
  ctx.checkLoopback('window open');
  mark('opened', { visibleIsVisible: visible.isVisible() });
  visible.close();
  await sleep(1000);
  mark('1 s after visible.close()');
  const hidden = await hiddenWindow();
  mark('hidden built', { hiddenIsVisible: hidden.isVisible() });
  hidden.destroy();
  await sleep(1000);
  mark('1 s after hidden.destroy()');
});

wacScenario(
  'NO listener: visible closed while hidden exists, then hidden destroyed',
  async ({ mark, ctx, partial }) => {
    const visible = await visibleWindow();
    const hidden = await hiddenWindow();
    ctx.checkLoopback('windows open');
    mark('opened', { visibleIsVisible: visible.isVisible(), hiddenIsVisible: hidden.isVisible() });
    // The app may quit from here on; what is known so far is written first.
    partial();
    visible.close();
    await sleep(1500);
    mark('1.5 s after visible.close(): still running');
    partial();
    hidden.destroy();
    await sleep(1500);
    mark('1.5 s after hidden.destroy(): still running');
  },
  { noWacListener: true },
);

/* ── port: MessagePortMain 'close' ─────────────────────────────────────── */

function portScenario(name, trigger) {
  scenario(`port: ${name}`, async (ctx) => {
    const w = await openWorkerWindow(ctx);
    const { win, wc, port1, pid } = w;
    const events = [];
    const mark = (event, extra = {}) => events.push({ event, at: now(), ...extra });
    port1.on('close', () => mark('port close'));
    wc.on('render-process-gone', (_event, details) => mark('render-process-gone', { reason: details.reason, exitCode: details.exitCode }));
    wc.once('destroyed', () => mark('webContents destroyed'));
    win.once('closed', () => mark('window closed'));
    wc.on('did-start-navigation', (details) => {
      if (details.isMainFrame && !details.isSameDocument) mark('did-start-navigation');
    });
    wc.on('did-navigate', () => mark('did-navigate'));
    wc.on('dom-ready', () => mark('dom-ready'));
    wc.on('did-finish-load', () => mark('did-finish-load'));
    const tabs = app.getAppMetrics().filter((m) => m.type === 'Tab').length;
    const triggerAt = now();
    await trigger(w);
    mark('trigger returned');
    await sleep(3000);
    let postAfter = 'returned';
    try {
      port1.postMessage({ k: 'probe', op: 'hello' });
    } catch (error) {
      postAfter = `threw ${error.name}`;
    }
    const rel = events.map((e) => ({ ...e, at: round(e.at - triggerAt) }));
    return {
      rendererPid: pid,
      tabProcesses: tabs,
      order: rel.map((e) => e.event),
      events: rel,
      portClosed: rel.some((e) => e.event === 'port close'),
      postToPortAfter: postAfter,
    };
  });
}

portScenario('crash (forcefullyCrashRenderer)', async (w) => w.wc.forcefullyCrashRenderer());
portScenario('destroy (win.destroy)', async (w) => w.win.destroy());
portScenario('close (win.close)', async (w) => w.win.close());
portScenario('reload (webContents.reload)', async (w) => w.wc.reload());
portScenario('navigate (loadURL to another page, same origin)', async (w) => {
  void w.wc.loadURL(`${SCHEME}://app/other.html`).catch(() => undefined);
});
portScenario('SIGKILL the renderer process', async (w) => process.kill(w.pid, 'SIGKILL'));
portScenario('page closes its own port (control)', async (w) => w.port1.postMessage({ k: 'probe', op: 'close-port' }));
portScenario('destroy while the page blocks its thread', async (w) => {
  w.port1.postMessage({ k: 'probe', op: 'block', ms: 4000 });
  await sleep(300);
  w.win.destroy();
});
portScenario('crash while the page blocks its thread', async (w) => {
  w.port1.postMessage({ k: 'probe', op: 'block', ms: 4000 });
  await sleep(300);
  w.wc.forcefullyCrashRenderer();
});

/* ── worker: the real WorkerHost over a hidden window ──────────────────── */

const WORKER_FILES = ['worker-host', 'supervisor', 'protocol', 'clone', 'host-runtime'];

async function makeHost(ctx, { throttle }) {
  const workerHost = await import(pathToFileURL(join(bridge.dir, 'worker-host.mjs')).href);
  const supervisor = await import(pathToFileURL(join(bridge.dir, 'supervisor.mjs')).href);
  const lives = [];
  const lost = [];
  const warnings = [];
  let progress = 0;
  // The broker, as far as WorkerHost uses it: progress and workerLost.
  const broker = {
    progress: () => {
      progress += 1;
    },
    workerLost: (executor) => lost.push({ executor, at: now() }),
  };

  const spawnWorker = () => {
    const win = new BrowserWindow({ show: false, webPreferences: hiddenPrefs(throttle) });
    const wc = win.webContents;
    watchConsole(wc);
    const { port1, port2 } = new MessageChannelMain();
    const life = { win, wc, port1, pings: [], pongs: [], rawPongs: new Map(), probe: [], events: [] };
    lives.push(life);
    const messageListeners = [];
    const closeListeners = [];
    port1.on('message', (event) => {
      const message = event.data;
      if (message?.k === 'probe') {
        life.probe.push({ at: now(), ...message });
        return;
      }
      if (message?.k === 'pong') {
        if (message.id >= PROBE_PING_BASE) {
          life.rawPongs.set(message.id, now());
          return;
        }
        life.pongs.push({ id: message.id, at: now() });
      }
      for (const listener of messageListeners) listener(message);
    });
    port1.on('close', () => {
      life.events.push({ event: 'port close', at: now() });
      for (const listener of closeListeners) listener('the message port closed');
    });
    wc.once('destroyed', () => life.events.push({ event: 'webContents destroyed', at: now() }));
    wc.on('render-process-gone', (_event, details) => life.events.push({ event: 'render-process-gone', reason: details.reason, at: now() }));
    port1.start();
    wc.once('did-finish-load', () => {
      life.events.push({ event: 'did-finish-load', at: now() });
      wc.postMessage('probe-port', null, [port2]);
    });
    void win.loadURL(PAGE_URL).catch((error) => life.events.push({ event: 'load failed', message: String(error.message), at: now() }));
    life.events.push({ event: 'spawned', at: now() });
    return {
      senderId: wc.id,
      handle: {
        link: {
          postMessage: (message) => {
            if (message?.k === 'ping') life.pings.push({ id: message.id, at: now() });
            port1.postMessage(message);
          },
          onMessage: (listener) => messageListeners.push(listener),
          onClose: (listener) => closeListeners.push(listener),
        },
        kill: () => {
          life.events.push({ event: 'kill', at: now() });
          if (!win.isDestroyed()) win.destroy();
        },
      },
    };
  };

  const host = workerHost.createWorkerHost({ spawnWorker, broker, warn: (message) => warnings.push({ at: now(), message }) });
  let units = 0;
  const run = (config, onFrame) => {
    units += 1;
    const controller = new AbortController();
    const unit = { owner: { kind: 'device', id: 'probe-phone' }, unitId: `probe-unit-${units}` };
    let terminal = null;
    const done = host
      .run(unit, encoder.encode(JSON.stringify(config)), controller.signal, (frame) => onFrame(JSON.parse(decoder.decode(frame)), now()))
      .then((end) => {
        terminal = { at: now(), kind: end.kind, code: end.code, message: end.kind === 'failed' ? end.message : undefined };
        return terminal;
      });
    return { controller, done, terminal: () => terminal };
  };
  return {
    host,
    lives,
    lost,
    warnings,
    run,
    progress: () => progress,
    policy: supervisor.DEFAULT_POLICY,
    idleTimeout: workerHost.PEER_TURN_IDLE_TIMEOUT_MS,
  };
}

function memory(pid) {
  const all = app.getAppMetrics();
  const kb = (m) => (m === undefined ? null : m.memory.workingSetSize);
  const renderer = all.find((m) => m.pid === pid);
  return {
    rendererKB: kb(renderer),
    rendererPeakKB: renderer === undefined ? null : renderer.memory.peakWorkingSetSize,
    browserKB: kb(all.find((m) => m.type === 'Browser')),
    gpuKB: kb(all.find((m) => m.type === 'GPU')),
    allProcessesKB: all.reduce((sum, m) => sum + m.memory.workingSetSize, 0),
    processes: all.map((m) => m.type),
  };
}

let nextProbePing = PROBE_PING_BASE;
async function rawPings(life, count, gapMs) {
  const sent = new Map();
  for (let i = 0; i < count; i += 1) {
    const id = nextProbePing++;
    sent.set(id, now());
    life.port1.postMessage({ k: 'ping', id });
    await sleep(gapMs);
  }
  await sleep(500);
  const rtts = [];
  let unanswered = 0;
  for (const [id, at] of sent) {
    const back = life.rawPongs.get(id);
    if (back === undefined) unanswered += 1;
    else rtts.push(back - at);
  }
  return { ...stats(rtts), unanswered };
}

function intervals(times) {
  const gaps = [];
  for (let i = 1; i < times.length; i += 1) gaps.push(times[i] - times[i - 1]);
  return gaps;
}

function pacingScenario(throttle) {
  scenario(
    `worker: pacing, memory and ping round trips, backgroundThrottling ${throttle}`,
    async (ctx) => {
      const baseline = memory(-1);
      const w = await makeHost(ctx, { throttle });

      // 1. Frames paced by the page's own 20 ms timer, for up to 500 frames or 10 s.
      const timerFrames = [];
      const timer = w.run({ mode: 'timer', count: 500, intervalMs: 20, durationMs: 10_000 }, (body, at) => timerFrames.push({ body, at }));
      const life = await (async () => {
        await until(() => w.lives.length > 0, 5_000, 'a worker to be spawned');
        return w.lives[0];
      })();
      const timerEnd = await Promise.race([timer.done, sleep(40_000).then(() => null)]);
      if (timerEnd === null) throw new Error('probe: the timer-paced unit did not end in 40 s');
      const hello = life.probe.find((m) => m.op === 'hello');
      const pid = life.wc.getOSProcessId();
      ctx.checkLoopback('worker live');
      const afterTimer = memory(pid);
      const frames = timerFrames.filter((f) => f.body.seq >= 0);

      // 2. Probe pings straight to the page's host runtime while idle: 100 at 50 ms.
      const idlePings = await rawPings(life, 100, 50);

      // 3. Frames paced by main, one per token message at 20 ms, 500 tokens, with
      //    probe pings at 100 ms running through the same port.
      const relayFrames = [];
      const relay = w.run({ mode: 'relay' }, (body, at) => relayFrames.push({ body, at }));
      await until(() => relayFrames.length > 0, 10_000, 'the relay unit to start');
      const sentAt = new Map();
      const pingsDuring = rawPings(life, 50, 100);
      for (let seq = 0; seq < 500; seq += 1) {
        sentAt.set(seq, now());
        life.port1.postMessage({ k: 'probe', op: 'token', seq });
        await sleep(20);
      }
      const streamingPings = await pingsDuring;
      life.port1.postMessage({ k: 'probe', op: 'token-end' });
      const relayEnd = await Promise.race([relay.done, sleep(10_000).then(() => null)]);
      if (relayEnd === null) throw new Error('probe: the relay unit did not end in 10 s');
      const afterRelay = memory(pid);
      const relayed = relayFrames.filter((f) => f.body.seq >= 0);
      const latencies = relayed.map((f) => f.at - sentAt.get(f.body.seq));
      const sendGaps = intervals([...sentAt.values()]);

      w.host.dispose();
      await sleep(500);
      return {
        backgroundThrottling: throttle,
        page: { visibilityState: hello?.visibility, hidden: hello?.hidden },
        memoryKB: { beforeWorker: baseline, afterTimerRun: afterTimer, afterRelayRun: afterRelay },
        timer: {
          terminal: timerEnd,
          frames: frames.length,
          arrivalIntervalMs: stats(intervals(frames.map((f) => f.at))),
          pageIntervalMs: stats(intervals(frames.map((f) => f.body.pagePerf))),
          // Arrival in main minus the page's wall reading when it emitted the frame (1 ms wall resolution).
          pageToMainLagMs: stats(frames.map((f) => f.at - fromWall(f.body.pageWall))),
        },
        relay: {
          terminal: relayEnd,
          tokens: sentAt.size,
          frames: relayed.length,
          mainSendIntervalMs: stats(sendGaps),
          arrivalIntervalMs: stats(intervals(relayed.map((f) => f.at))),
          tokenToFrameLatencyMs: stats(latencies),
        },
        pingRoundTripMs: { idle: idlePings, whileRelaying: streamingPings },
        brokerProgressCalls: w.progress(),
        workerLost: w.lost.length,
        warnings: w.warnings.map((x) => x.message),
      };
    },
    { files: WORKER_FILES, limitMs: 120_000 },
  );
}

pacingScenario(false);
pacingScenario(true);

function blockScenario(ms, phase) {
  scenario(
    `worker: block ${ms / 1000} s ${phase}`,
    async (ctx) => {
      const w = await makeHost(ctx, { throttle: false });
      const frames = [];
      const unit = w.run({ mode: 'hold' }, (body, at) => frames.push({ body, at }));
      await until(() => frames.length > 0, 15_000, 'the worker to start the unit');
      const life = w.lives[0];
      ctx.checkLoopback('worker live');
      const spawnedAt = life.events.find((e) => e.event === 'spawned').at;

      life.port1.postMessage({ k: 'probe', op: 'arm', phase, ms });
      const armedAt = now();
      await until(() => life.pings.some((p) => p.at > armedAt), 25_000, "the Supervisor's next ping");
      const ping = life.pings.find((p) => p.at > armedAt);

      // The block, and whatever the Supervisor decides, or 12 s past the block's end.
      await until(
        () => unit.terminal() !== null || life.probe.some((m) => m.op === 'block-done'),
        ms + 20_000,
        'the block to end or the unit to end',
      );
      if (unit.terminal() === null) await sleep(3_000);

      let keptAnswering = null;
      if (unit.terminal() === null) {
        // Survived the block: the next Supervisor ping must still be answered.
        const doneAt = now();
        try {
          await until(() => life.pongs.some((p) => p.at > doneAt), 18_000, 'a pong after the block');
          keptAnswering = true;
        } catch {
          keptAnswering = unit.terminal() === null ? false : 'unit ended while waiting';
        }
        life.port1.postMessage({ k: 'probe', op: 'finish' });
      }
      const terminal = await Promise.race([unit.done, sleep(10_000).then(() => null)]);
      const block = life.probe.find((m) => m.op === 'block-done');
      const blockBegin = life.probe.find((m) => m.op === 'block-begin');
      // Block start in this process's clock: the page's own wall reading when it has one.
      const blockStart = block !== undefined ? fromWall(block.startWall) : ping.at;
      const rel = (at) => round(at - blockStart);
      const pongForArmed = life.pongs.find((p) => p.id === ping.id);
      w.host.dispose();
      await sleep(300);
      return {
        blockMs: ms,
        phase,
        policy: {
          tickMs: w.policy.tickMs,
          pingIntervalMs: w.policy.pingIntervalMs,
          pingTimeoutMs: w.policy.pingTimeoutMs,
          peerTurnIdleTimeoutMs: String(w.idleTimeout),
        },
        spawnToArmedPingMs: round(ping.at - spawnedAt),
        armedPingSentAtMs: rel(ping.at),
        blockEndMs: block !== undefined ? rel(fromWall(block.endWall)) : null,
        blockBeginMessageArrivedMs: blockBegin !== undefined ? rel(blockBegin.at) : null,
        blockCompleted: block !== undefined,
        pongForArmedPingMs: pongForArmed !== undefined ? rel(pongForArmed.at) : null,
        terminal: terminal === null ? null : { ...terminal, at: rel(terminal.at) },
        // The WorkerHost does not pass the Supervisor's loss reason to `warn`, so a
        // loss is read from what happened: the worker was killed and the unit
        // ended HANDLE_LOST before the block finished.
        lostWhileBlocked:
          terminal !== null && terminal.code === 'HANDLE_LOST' && block === undefined && life.events.some((e) => e.event === 'kill'),
        warnings: w.warnings.map((x) => ({ at: rel(x.at), message: x.message })),
        workerLost: w.lost.map((x) => ({ executor: x.executor, at: rel(x.at) })),
        lifeEvents: life.events.map((e) => ({ ...e, at: rel(e.at) })),
        pings: life.pings.map((p) => ({ id: p.id, at: rel(p.at) })),
        pongs: life.pongs.map((p) => ({ id: p.id, at: rel(p.at) })),
        keptAnsweringAfterBlock: keptAnswering,
        windowDestroyed: life.win.isDestroyed(),
      };
    },
    { files: WORKER_FILES, limitMs: 150_000 },
  );
}

for (const ms of [5_000, 15_000, 30_000]) {
  blockScenario(ms, 'before-pong');
  blockScenario(ms, 'after-pong');
}

/* ── tray ──────────────────────────────────────────────────────────────── */

scenario('tray: macOS status item bounds', async (ctx) => {
  if (process.platform !== 'darwin') return { skipped: `platform ${process.platform}: this scenario reads macOS bounds only` };
  const size = 16;
  const pixels = Buffer.alloc(size * size * 4);
  for (let i = 0; i < pixels.length; i += 4) {
    pixels[i] = 0x80;
    pixels[i + 1] = 0x80;
    pixels[i + 2] = 0x80;
    pixels[i + 3] = 0xff;
  }
  const tray = new Tray(nativeImage.createFromBitmap(pixels, { width: size, height: size }));
  await sleep(1000);
  const bounds = tray.getBounds();
  ctx.checkLoopback('tray shown');
  const displays = screen.getAllDisplays().map((d) => ({ bounds: d.bounds, workArea: d.workArea, internal: d.internal }));
  const onADisplay = displays.some(
    (d) =>
      bounds.width > 0 &&
      bounds.height > 0 &&
      bounds.x >= d.bounds.x &&
      bounds.x + bounds.width <= d.bounds.x + d.bounds.width &&
      bounds.y >= d.bounds.y &&
      bounds.y + bounds.height <= d.bounds.y + d.bounds.height,
  );
  tray.destroy();
  return { bounds, displays, onADisplay };
});

/* ── Run one ───────────────────────────────────────────────────────────── */

app.whenReady().then(async () => {
  lib.accessory(app);
  servePages();
  if (LIST) {
    out(`PROBE_LIST ${JSON.stringify([...scenarios.keys()])}`);
    app.exit(0);
    return;
  }
  const entry = scenarios.get(ONLY);
  if (entry === undefined) {
    out(`PROBE_FAIL no scenario named ${JSON.stringify(ONLY)}`);
    app.exit(1);
    return;
  }
  // Electron quits when its last window closes unless something listens. Every
  // scenario but the one that measures exactly that keeps the process alive.
  if (!entry.noWacListener) app.on('window-all-closed', () => undefined);

  const loadBefore = lib.loads();
  const ctx = {
    loopback: [],
    checkLoopback(label) {
      const result = lib.assertLoopbackOnly(app.getAppMetrics().map((m) => m.pid));
      this.loopback.push({ label, ...result });
      return result;
    },
  };
  const report = (data, error, partial) => {
    const ok = error === undefined && ctx.loopback.length > 0 && ctx.loopback.every((l) => l.ok);
    out(
      `PROBE_RESULT ${JSON.stringify({
        name: ONLY,
        ok,
        partial,
        error,
        loadBefore,
        loadAfter: lib.loads(),
        versions: lib.versions(),
        bridge: bridge === null ? null : { source: bridge.source, commit: bridge.commit },
        loopback: ctx.loopback.map((l) => ({ label: l.label, ok: l.ok, checked: l.checked.length, bound: l.bound, offending: l.offending, error: l.error })),
        data,
      })}`,
    );
    return ok;
  };
  ctx.partial = (data) => report(data, undefined, true);

  const guard = setTimeout(() => {
    out(`PROBE_FAIL ${ONLY}: still running at its ${entry.limitMs} ms limit`);
    app.exit(3);
  }, entry.limitMs);
  let data;
  let error;
  try {
    bridge = lib.loadBridge(ROOT, BRIDGE_REF, entry.files);
    data = await entry.fn(ctx);
    ctx.checkLoopback('end');
  } catch (caught) {
    error = String(caught?.stack ?? caught);
  }
  clearTimeout(guard);
  const ok = report(data, error, false);
  app.exit(ok ? 0 : 1);
});
