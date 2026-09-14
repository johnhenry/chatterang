// Measure what Electron's UtilityProcess.postMessage does to a process that has
// exited, is exiting, or is dead but not yet reaped.
//
//   node dev/probe-electron-utility-process/run.cjs      (every scenario, one Electron each)
//   node_modules/.bin/electron dev/probe-electron-utility-process/main.cjs --only='<scenario>' -ApplePersistenceIgnoreState YES
//
// Some scenarios crash Electron's main process on purpose. On macOS, add
// `-ApplePersistenceIgnoreState YES` to a direct run: after a crash, the next
// launch otherwise blocks in an invisible "reopen windows?" alert. run.cjs adds
// it for you.
//
// It forks the child the way apps/desktop/src/main.ts forks the inference host
// (utilityProcess.fork, two argv entries, a serviceName, stdio 'pipe'), posts
// the supervisor's own message shapes (`{ k: 'call', ... }`, `{ k: 'ping' }`)
// at each point around the child's death, and records, per post: did it throw
// synchronously, and had 'exit' been emitted yet. Across the whole run it
// records every event the UtilityProcess emitted, every 'child-process-gone',
// and every uncaughtException / unhandledRejection in main.
//
// --bare installs NO uncaughtException listener, so an exception that escapes
// is handled by Electron's own default. The default run installs one to RECORD
// what escapes. main.ts installs none.
//
// The FatalError scenarios load fatal-api.c into the child, built with the
// system C compiler into a temporary directory, to reach Electron's
// experimental UtilityProcess 'error' event. See that file for why a heap-limit
// out-of-memory does not.
const { app, utilityProcess } = require('electron');
const { execFileSync } = require('node:child_process');
const { mkdtempSync, rmSync, writeSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

// A userData directory of its own. Every Electron started without one shares
// ~/Library/Application Support/Electron, and other Electron runs on the same
// machine were using it while this probe ran.
const USER_DATA = mkdtempSync(join(tmpdir(), 'probe-utilproc-userdata-'));
app.setPath('userData', USER_DATA);

// Written SYNCHRONOUSLY. Node writes console.log to a pipe asynchronously on
// macOS, so a process the runner has to SIGKILL loses its last lines, which
// are the ones that say where it stopped.
const out = (text) => {
  try {
    writeSync(1, `${text}\n`);
  } catch {
    /* a full or closed pipe loses a line, not the run */
  }
};

const BARE = process.argv.includes('--bare');
const LIST = process.argv.includes('--list');
// Recording emitted event names wraps `child.emit`; --no-wrap proves a result
// does not depend on that wrapper.
const NO_WRAP = process.argv.includes('--no-wrap');
// Exact scenario name. run.cjs runs every scenario in its own Electron main,
// because one of them kills main outright and takes the rest of a run with it.
const ONLY = (process.argv.find((a) => a.startsWith('--only=')) ?? '').slice('--only='.length);
const CHILD = join(__dirname, 'child.cjs');
const t0 = Date.now();
const ms = () => Date.now() - t0;

const escaped = [];
if (!BARE) {
  process.on('uncaughtException', (error) => {
    escaped.push({ at: ms(), kind: 'uncaughtException', name: error?.name, code: error?.code, message: String(error?.message ?? error) });
    out(`PROBE_ESCAPED uncaughtException ${error?.code ?? ''} ${error?.message ?? error}`);
  });
}
process.on('unhandledRejection', (reason) => {
  escaped.push({ at: ms(), kind: 'unhandledRejection', message: String(reason?.message ?? reason) });
});
const gone = [];
app.on('child-process-gone', (_event, details) => {
  gone.push({ at: ms(), type: details.type, reason: details.reason, exitCode: details.exitCode, serviceName: details.serviceName });
});
app.on('window-all-closed', () => {});

const tick = () => new Promise((r) => setImmediate(r));
// Progress lines, printed as they happen, so a scenario that stops making
// progress shows where it stopped.
const step = (what) => out(`PROBE_STEP ${ms()}ms ${what}`);
const sleep = (n) => new Promise((r) => setTimeout(r, n));

let nextId = 1;
const call = (method, extra) => ({ k: 'call', id: nextId++, plugin: 'LlamaCpp', method, args: [{ requestId: `probe-${nextId}`, handle: 'h', prompt: 'p', ...extra }] });
const ping = () => ({ k: 'ping', id: nextId++ });

// Temporary directories to remove when the run ends.
const TEMP_DIRS = [];
let addonPath;
/** fatal-api.c, built once per run, only by a scenario that needs it. */
function fatalApiAddon() {
  if (addonPath) return addonPath;
  if (process.platform === 'win32') throw new Error('fatal-api.c is built with a POSIX cc; not on win32');
  const dir = mkdtempSync(join(tmpdir(), 'probe-utilproc-addon-'));
  TEMP_DIRS.push(dir);
  const outFile = join(dir, 'fatal-api.node');
  const flags = process.platform === 'darwin' ? ['-bundle', '-undefined', 'dynamic_lookup'] : ['-shared', '-fPIC'];
  execFileSync('cc', [...flags, '-o', outFile, join(__dirname, 'fatal-api.c')], { stdio: ['ignore', 'ignore', 'pipe'] });
  addonPath = outFile;
  return outFile;
}

/** The top-level keys of a FatalError's diagnostic report. Never its values. */
function reportKeys(report) {
  try {
    return Object.keys(JSON.parse(String(report)));
  } catch {
    return 'not JSON';
  }
}

/**
 * One forked child plus everything observed about it. `errorListener` decides
 * whether an 'error' listener is attached, and what it does: false (none, as
 * main.ts on main), 'record', 'post' (posts from inside the dispatch) or
 * 'kill' (calls child.kill() from inside it).
 */
async function fork(name, { errorListener = false, execArgv } = {}) {
  const modelRoot = mkdtempSync(join(tmpdir(), 'probe-utilproc-'));
  step(`${name}: forking`);
  const child = utilityProcess.fork(CHILD, [modelRoot, 'llama'], {
    serviceName: `chatterang-inference-probe-${name}`,
    stdio: 'pipe',
    ...(execArgv ? { execArgv } : {}),
  });
  const state = { name, child, modelRoot, exited: false, exitCode: null, exitAt: null, events: [], posts: [], errorEvents: [], messages: [], stderrBytes: 0 };
  // Record every event name the UtilityProcess emits, without changing what a
  // listener sees: the original emit still runs, and still throws if it would.
  if (NO_WRAP) {
    for (const event of ['spawn', 'exit', 'message']) child.on(event, () => state.events.push({ at: ms(), event }));
  } else {
    const emit = child.emit;
    child.emit = function (event, ...args) {
      state.events.push({ at: ms(), event: String(event) });
      // Recorded before the emit, which throws if nobody listens for 'error'.
      if (event === 'error') {
        state.errorSeen = true;
        state.errorAt ??= ms();
      }
      return emit.call(this, event, ...args);
    };
  }
  child.stdout?.on('data', () => undefined);
  child.stderr?.on('data', (chunk) => {
    state.stderrBytes += chunk.length;
    const firstLine = String(chunk).split('\n').find((l) => l.trim().length > 0);
    if (firstLine && state.stderrFirst === undefined) state.stderrFirst = firstLine.slice(0, 160);
  });
  // Mirrors main.ts: an `exited` latch first, then the supervisor's onClose.
  child.once('exit', (code) => {
    state.exited = true;
    state.exitCode = code;
    state.exitAt = ms();
  });
  child.on('message', (message) => state.messages.push(message?.k));
  if (errorListener) {
    child.on('error', (type, location, report) => {
      state.errorSeen = true;
      state.errorAt ??= ms();
      state.errorEvents.push({ at: ms(), type, location, exitedYet: state.exited, reportBytes: String(report ?? '').length, reportKeys: reportKeys(report) });
      if (errorListener === 'post') post(state, 'in error handler', ping());
      if (errorListener === 'kill') state.killInErrorReturned = child.kill();
    });
  }
  const booted = new Promise((resolve) => child.on('message', (m) => m?.k === 'boot' && resolve(true)));
  const ok = await Promise.race([booted, sleep(10_000).then(() => false)]);
  if (!ok) throw new Error(`${name}: child never booted`);
  step(`${name}: booted`);
  // Prove the link carries a round trip before anything dies.
  const pong = new Promise((resolve) => child.on('message', (m) => m?.k === 'pong' && resolve(true)));
  child.postMessage(ping());
  if (!(await Promise.race([pong, sleep(5_000).then(() => false)]))) throw new Error(`${name}: no pong before the test`);
  child.once('exit', (code) => step(`exit event, code ${code}`));
  step(`${name}: booted and answered a ping`);
  return state;
}

function post(state, label, message) {
  const record = { label, beforeExit: !state.exited, afterError: Boolean(state.errorSeen), at: ms() };
  try {
    const returned = state.child.postMessage(message);
    record.threw = false;
    record.returned = returned === undefined ? 'undefined' : String(returned);
  } catch (error) {
    record.threw = true;
    record.error = `${error?.name}: ${error?.message}`;
  }
  state.posts.push(record);
  return record;
}

async function waitExit(state, limit = 15_000) {
  const until = Date.now() + limit;
  while (!state.exited && Date.now() < until) await sleep(5);
  return state.exited;
}

/**
 * Post one message per 1 ms timer from now until `afterMs` past 'exit'.
 *
 * A timer rather than setImmediate, so Electron's loop gets a turn between
 * posts and the exit can be delivered in the middle of the burst.
 */
async function burstAcrossExit(state, label, afterMs = 200) {
  const started = ms();
  const until = { at: Infinity };
  while (ms() < until.at) {
    if (state.posts.length % 250 === 0) step(`burst: ${state.posts.length} posts, exited=${state.exited}`);
    post(state, label, state.posts.length % 2 === 0 ? ping() : call('generate'));
    if (state.exited && until.at === Infinity) until.at = state.exitAt + afterMs;
    if (!state.exited && ms() - started > 20_000) break;
    await sleep(1);
  }
}

const scenarios = {
  async 'kill, post same tick'(s) {
    s.killReturned = s.child.kill();
    post(s, 'same tick', call('generate'));
    post(s, 'same tick', ping());
    await waitExit(s);
    await sleep(100);
    post(s, 'after exit +100ms', ping());
  },
  async 'kill, post after microtask'(s) {
    s.killReturned = s.child.kill();
    await Promise.resolve();
    post(s, 'microtask', call('generate'));
    await waitExit(s);
  },
  async 'kill, post after macrotasks'(s) {
    s.killReturned = s.child.kill();
    await tick();
    post(s, 'setImmediate', call('generate'));
    await sleep(0);
    post(s, 'setTimeout 0', ping());
    await sleep(1);
    post(s, 'setTimeout 1', ping());
    await waitExit(s);
  },
  // Every handler below is registered AFTER fork()'s `exited` latch, which is
  // exactly where main.ts puts the supervisor's onClose listener.
  async 'kill, exit handler that posts nothing (control)'(s) {
    const done = new Promise((resolve) => s.child.once('exit', () => { s.pidInHandler = String(s.child.pid); resolve(); }));
    s.killReturned = s.child.kill();
    await Promise.race([done, sleep(15_000)]);
  },
  async 'kill, post inside exit handler'(s) {
    const done = new Promise((resolve) => s.child.once('exit', () => { post(s, 'in exit handler', call('generate')); resolve(); }));
    s.killReturned = s.child.kill();
    await Promise.race([done, sleep(15_000)]);
  },
  async 'kill, post in a microtask queued by the exit handler'(s) {
    // Where a promise the supervisor rejects in onClose runs its continuation.
    const done = new Promise((resolve) => s.child.once('exit', () => queueMicrotask(() => { post(s, 'microtask from exit handler', ping()); resolve(); })));
    s.killReturned = s.child.kill();
    await Promise.race([done, sleep(15_000)]);
  },
  async 'kill, post in setImmediate queued by the exit handler'(s) {
    const done = new Promise((resolve) => s.child.once('exit', () => setImmediate(() => { post(s, 'setImmediate from exit handler', ping()); resolve(); })));
    s.killReturned = s.child.kill();
    await Promise.race([done, sleep(15_000)]);
  },
  async 'kill, post in setTimeout 0 queued by the exit handler'(s) {
    const done = new Promise((resolve) => s.child.once('exit', () => setTimeout(() => { post(s, 'setTimeout 0 from exit handler', ping()); resolve(); }, 0)));
    s.killReturned = s.child.kill();
    await Promise.race([done, sleep(15_000)]);
  },
  async 'kill, kill() again inside exit handler'(s) {
    // main.ts's HostHandle.kill is guarded by the latch; this is the unguarded call.
    const done = new Promise((resolve) => s.child.once('exit', () => { s.killAgainReturned = s.child.kill(); resolve(); }));
    s.killReturned = s.child.kill();
    await Promise.race([done, sleep(15_000)]);
  },
  async 'child exits on its own, post inside exit handler'(s) {
    const done = new Promise((resolve) => s.child.once('exit', () => { post(s, 'in exit handler', ping()); resolve(); }));
    post(s, 'the call that exits', call('exitSelf'));
    await Promise.race([done, sleep(15_000)]);
  },
  async 'child crashes (abort), post inside exit handler'(s) {
    const done = new Promise((resolve) => s.child.once('exit', () => { post(s, 'in exit handler', ping()); resolve(); }));
    post(s, 'the call that aborts', call('abort'));
    await Promise.race([done, sleep(15_000)]);
  },
  async 'SIGKILL from outside, post inside exit handler'(s) {
    const done = new Promise((resolve) => s.child.once('exit', () => { post(s, 'in exit handler', ping()); resolve(); }));
    process.kill(s.child.pid, 'SIGKILL');
    await Promise.race([done, sleep(15_000)]);
  },
  async 'SIGKILL from outside, exit handler that posts nothing (control)'(s) {
    const done = new Promise((resolve) => s.child.once('exit', () => { s.pidInHandler = String(s.child.pid); resolve(); }));
    process.kill(s.child.pid, 'SIGKILL');
    await Promise.race([done, sleep(15_000)]);
  },
  async 'SIGKILL from outside, post in a microtask queued by the exit handler'(s) {
    const done = new Promise((resolve) => s.child.once('exit', () => queueMicrotask(() => { post(s, 'microtask from exit handler', ping()); resolve(); })));
    process.kill(s.child.pid, 'SIGKILL');
    await Promise.race([done, sleep(15_000)]);
  },
  async 'SIGKILL from outside, post in setImmediate queued by the exit handler'(s) {
    const done = new Promise((resolve) => s.child.once('exit', () => setImmediate(() => { post(s, 'setImmediate from exit handler', ping()); resolve(); })));
    process.kill(s.child.pid, 'SIGKILL');
    await Promise.race([done, sleep(15_000)]);
  },
  async 'kill, post long after exit'(s) {
    s.killReturned = s.child.kill();
    await waitExit(s);
    post(s, 'exit +0 (same macrotask as the wait)', ping());
    await sleep(100);
    post(s, 'exit +100ms', call('generate'));
    await sleep(1000);
    post(s, 'exit +1100ms', ping());
    s.killAgainReturned = s.child.kill();
    post(s, 'after a second kill()', ping());
  },
  async 'child exits on its own (process.exit)'(s) {
    post(s, 'the call that exits', call('exitSelf'));
    await burstAcrossExit(s, 'burst');
  },
  async 'child aborts (process.abort)'(s) {
    post(s, 'the call that aborts', call('abort'));
    await burstAcrossExit(s, 'burst');
  },
  async 'child throws unhandled'(s) {
    post(s, 'the call that throws', call('throw'));
    await burstAcrossExit(s, 'burst');
  },
  async 'SIGKILL from outside, dead before reaped'(s) {
    process.kill(s.child.pid, 'SIGKILL');
    post(s, 'same tick as SIGKILL', call('generate'));
    await burstAcrossExit(s, 'burst');
  },
  async 'kill, 1000 posts same tick, then burst'(s) {
    s.killReturned = s.child.kill();
    for (let i = 0; i < 1000; i += 1) post(s, 'sync x1000', i % 2 ? ping() : call('generate'));
    await burstAcrossExit(s, 'burst');
  },
  async 'kill, 20 x 5 MB posts across exit'(s) {
    const big = 'x'.repeat(5 * 1024 * 1024);
    s.killReturned = s.child.kill();
    for (let i = 0; i < 20; i += 1) {
      post(s, '5MB', call('appendFile', { data: big }));
      await tick();
    }
    await waitExit(s);
    for (let i = 0; i < 5; i += 1) post(s, '5MB after exit', call('appendFile', { data: big }));
  },
  async 'wedged child, kill() (the condemn path)'(s) {
    post(s, 'the call that wedges', call('wedge'));
    await sleep(200);
    post(s, 'into the wedged loop', ping());
    s.killReturned = s.child.kill();
    post(s, 'same tick as kill', call('generate'));
    await burstAcrossExit(s, 'burst');
  },
  async 'V8 heap-limit out of memory, WITH an error listener'(s) {
    post(s, 'the call that is fatal', call('fatal'));
    await burstAcrossExit(s, 'burst', 500);
  },
  async 'V8 heap-limit out of memory, NO error listener'(s) {
    post(s, 'the call that is fatal', call('fatal'));
    await burstAcrossExit(s, 'burst', 500);
  },
  // A failed V8 API check in the child (fatal-api.c): the error V8 reports
  // through the embedder's fatal error handler, which is what Electron turns
  // into UtilityProcess 'error' ('FatalError', location, report).
  async 'V8 API fatal error (FatalError), WITH an error listener'(s) {
    post(s, 'the call that is fatal', call('v8ApiFatal', { addon: fatalApiAddon() }));
    await burstAcrossExit(s, 'burst', 500);
  },
  async 'V8 API fatal error (FatalError), NO error listener (as main.ts on main)'(s) {
    post(s, 'the call that is fatal', call('v8ApiFatal', { addon: fatalApiAddon() }));
    await burstAcrossExit(s, 'burst', 500);
  },
  // No burst in these two, so the only post or kill near the death is the one
  // made from inside the 'error' dispatch.
  async 'V8 API fatal error (FatalError), post inside the error listener'(s) {
    post(s, 'the call that is fatal', call('v8ApiFatal', { addon: fatalApiAddon() }));
    await waitExit(s);
  },
  async 'V8 API fatal error (FatalError), kill() inside the error listener'(s) {
    post(s, 'the call that is fatal', call('v8ApiFatal', { addon: fatalApiAddon() }));
    await waitExit(s);
  },
};

const OPTIONS = {
  'V8 heap-limit out of memory, WITH an error listener': { errorListener: 'record', execArgv: ['--max-old-space-size=16'] },
  'V8 heap-limit out of memory, NO error listener': { execArgv: ['--max-old-space-size=16'] },
  'V8 API fatal error (FatalError), WITH an error listener': { errorListener: 'record' },
  'V8 API fatal error (FatalError), post inside the error listener': { errorListener: 'post' },
  'V8 API fatal error (FatalError), kill() inside the error listener': { errorListener: 'kill' },
};

function summarise(state) {
  const posts = state.posts;
  const before = posts.filter((p) => p.beforeExit);
  const after = posts.filter((p) => !p.beforeExit);
  const threw = posts.filter((p) => p.threw);
  const counts = {};
  for (const e of state.events) counts[e.event] = (counts[e.event] ?? 0) + 1;
  return {
    scenario: state.name,
    exitCode: state.exitCode,
    posts: posts.length,
    postsBeforeExit: before.length,
    postsAfterExit: after.length,
    threw: threw.length,
    firstThrow: threw[0]?.error,
    returned: [...new Set(posts.map((p) => p.returned).filter(Boolean))],
    events: counts,
    errorEvents: state.errorEvents,
    errorEmitted: Boolean(state.errorSeen),
    errorToExitMs: state.errorAt != null && state.exitAt != null ? state.exitAt - state.errorAt : null,
    postsAfterErrorBeforeExit: posts.filter((p) => p.afterError && p.beforeExit).length,
    killReturned: state.killReturned,
    killAgainReturned: state.killAgainReturned,
    killInErrorReturned: state.killInErrorReturned,
    pidInHandler: state.pidInHandler,
    labels: [...new Set(posts.map((p) => `${p.label}${p.beforeExit ? ' [before exit]' : ' [after exit]'}`))],
    stderrFirst: state.stderrFirst,
    stderrBytes: state.stderrBytes,
  };
}

async function main() {
  const results = [];
  for (const [name, run] of Object.entries(scenarios)) {
    if (ONLY && name !== ONLY) continue;
    const escapedBefore = escaped.length;
    let state;
    try {
      state = await fork(name, OPTIONS[name]);
      await run(state);
      step(`${name}: scenario body returned, exited=${state.exited}`);
      await waitExit(state);
      await sleep(300);
      const summary = summarise(state);
      summary.escapedInMain = escaped.slice(escapedBefore);
      results.push(summary);
      out('PROBE_SCENARIO ' + JSON.stringify(summary));
    } catch (error) {
      results.push({ scenario: name, probeError: String(error?.stack ?? error) });
      out('PROBE_SCENARIO_ERROR ' + name + ' ' + String(error?.stack ?? error).replace(/\n/g, ' | '));
    } finally {
      if (state) {
        if (!state.exited) state.child.kill();
        rmSync(state.modelRoot, { recursive: true, force: true });
      }
    }
  }
  // Main must still be alive, and still running JS, well after the last death.
  await sleep(2000);
  out(
    'PROBE_RESULTS ' +
      JSON.stringify(
        {
          bare: BARE,
          versions: { electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node, platform: `${process.platform}-${process.arch}` },
          results,
          escaped,
          childProcessGone: gone,
        },
        null,
        1,
      ),
  );
  out(`PROBE_MAIN_SURVIVED at ${ms()}ms`);
}

app.whenReady().then(async () => {
  if (process.platform === 'darwin') app.dock?.hide();
  const cleanUp = () => {
    for (const dir of [USER_DATA, ...TEMP_DIRS]) rmSync(dir, { recursive: true, force: true });
  };
  if (LIST) {
    out('PROBE_LIST ' + JSON.stringify(Object.keys(scenarios)));
    cleanUp();
    app.exit(0);
    return;
  }
  const guard = setTimeout(() => {
    out('PROBE_TIMEOUT');
    cleanUp();
    app.exit(2);
  }, 180_000);
  try {
    await main();
  } catch (error) {
    out('PROBE_ERROR ' + (error?.stack ?? error));
  }
  clearTimeout(guard);
  cleanUp();
  app.exit(0);
});
