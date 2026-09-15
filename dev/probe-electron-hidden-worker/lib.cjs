// Shared by the BN3 Electron probes (this directory and ../probe-electron-reload-order).
//
// Nothing here is shipped. It holds the conventions the earlier Electron probes
// found the hard way (dev/probe-electron-utility-process/README.md, "Gotchas"):
// synchronous output, one temporary root per launch, a userData of its own, and
// macOS's reopen-windows prompt skipped. It adds two things BN3 needs:
//
// - `assertLoopbackOnly`: the probe asserts, itself, that no Electron process it
//   started holds a socket bound to anything but 127.0.0.1. The probes open no
//   socket on purpose; this is the check that says so.
// - `loadBridge`: the REAL bridge code (WorkerHost, Supervisor, HostRuntime), as
//   JavaScript, from the working tree or from a named git commit, with its types
//   stripped by the Node inside Electron. No copy of the code is measured.
'use strict';

const { spawnSync } = require('node:child_process');
const { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, writeSync } = require('node:fs');
const { tmpdir, loadavg } = require('node:os');
const { join, resolve, dirname } = require('node:path');

const REPO = resolve(__dirname, '..', '..');

/** Written synchronously: Node writes console.log to a pipe asynchronously on macOS. */
function out(text) {
  try {
    writeSync(1, `${text}\n`);
  } catch {
    /* a full or closed pipe loses a line, not the run */
  }
}

function arg(name, fallback = '') {
  const found = process.argv.find((a) => a.startsWith(`--${name}=`));
  return found === undefined ? fallback : found.slice(name.length + 3);
}

function flag(name) {
  return process.argv.includes(`--${name}`);
}

/** The temporary root the runner passed, or one of our own. */
function tempRoot(prefix) {
  const given = arg('temp-root');
  if (given) return given;
  return mkdtempSync(join(tmpdir(), prefix));
}

/** Before `app` is ready: a userData of our own. */
function quietApp(app, root) {
  const userData = join(root, 'userdata');
  mkdirSync(userData, { recursive: true });
  app.setPath('userData', userData);
}

/**
 * Once `app` is ready, on macOS: no Dock icon and the 'accessory' activation
 * policy, so a probe window never takes focus from the person at the machine.
 */
function accessory(app) {
  if (process.platform !== 'darwin') return;
  app.setActivationPolicy('accessory');
  app.dock?.hide();
}

function loads() {
  return loadavg().map((n) => Math.round(n * 100) / 100);
}

function versions() {
  return {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch,
  };
}

function gitHead() {
  const r = spawnSync('git', ['-C', REPO, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : 'unknown';
}

/**
 * Every socket any of `pids` holds, from `lsof`, and whether each is bound to
 * 127.0.0.1. A TCP socket in LISTEN and every UDP socket count as bound; an
 * outgoing TCP connection does not listen and is not counted.
 *
 * @returns {{ ok: boolean, checked: number[], bound: string[], offending: string[], error?: string }}
 */
function assertLoopbackOnly(pids) {
  const unique = [...new Set(pids.filter((p) => Number.isInteger(p) && p > 0))];
  const result = { ok: true, checked: unique, bound: [], offending: [] };
  if (unique.length === 0) {
    result.ok = false;
    result.error = 'no pids to check';
    return result;
  }
  for (const selector of [['-iTCP', '-sTCP:LISTEN'], ['-iUDP']]) {
    const r = spawnSync('lsof', ['-nP', '-a', '-p', unique.join(','), ...selector, '-F', 'pn'], {
      encoding: 'utf8',
      timeout: 30_000,
    });
    // lsof exits 1 when it finds nothing, which is the expected answer.
    if (r.error || (r.status !== 0 && r.status !== 1)) {
      result.ok = false;
      result.error = `lsof ${selector.join(' ')} failed: ${r.error ? r.error.message : `exit ${r.status}`}`;
      return result;
    }
    for (const line of r.stdout.split('\n')) {
      if (!line.startsWith('n')) continue;
      const name = line.slice(1);
      result.bound.push(`${selector[0]} ${name}`);
      // Accept only an address that is literally 127.0.0.1 on the local side.
      const local = name.split('->')[0];
      if (!local.startsWith('127.0.0.1:')) {
        result.ok = false;
        result.offending.push(`${selector[0]} ${name}`);
      }
    }
  }
  return result;
}

/**
 * Refuse, inside main, any listen on an address other than 127.0.0.1. The probes
 * call none; this makes a future edit that does fail loudly instead of quietly
 * widening what the machine exposes.
 */
function guardListen() {
  const net = require('node:net');
  const dgram = require('node:dgram');
  const original = net.Server.prototype.listen;
  net.Server.prototype.listen = function guardedListen(...args) {
    const opts = typeof args[0] === 'object' && args[0] !== null ? args[0] : { port: args[0], host: args[1] };
    if (opts.host !== '127.0.0.1') throw new Error(`probe: refused to listen on ${String(opts.host)}; 127.0.0.1 only`);
    return original.apply(this, args);
  };
  const originalBind = dgram.Socket.prototype.bind;
  dgram.Socket.prototype.bind = function guardedBind(...args) {
    const opts = typeof args[0] === 'object' && args[0] !== null ? args[0] : { port: args[0], address: args[1] };
    if (opts.address !== '127.0.0.1') throw new Error(`probe: refused to bind UDP on ${String(opts.address)}; 127.0.0.1 only`);
    return originalBind.apply(this, args);
  };
}

/* ── The real bridge code, as JavaScript ─────────────────────────────── */

/** The bridge files whose runtime imports form a closed set (every other import is `import type`). */
const BRIDGE_FILES = ['worker-host', 'supervisor', 'protocol', 'clone', 'host-runtime'];

/**
 * Write the bridge's modules, types stripped, as `.mjs` files under `root/bridge`.
 *
 * `ref` empty: the working tree, which must contain `worker-host.ts`.
 * `ref` set: each file as it is at that git commit (`git show <ref>:<path>`).
 *
 * @returns {{ dir: string, source: string, commit: string }}
 */
function loadBridge(root, ref, files = BRIDGE_FILES) {
  const { stripTypeScriptTypes } = require('node:module');
  const dir = join(root, 'bridge');
  mkdirSync(dir, { recursive: true });
  let commit = 'working tree';
  if (ref) {
    const r = spawnSync('git', ['-C', REPO, 'rev-parse', '--verify', `${ref}^{commit}`], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`probe: git could not resolve --bridge-ref=${ref}`);
    commit = r.stdout.trim();
  }
  for (const name of files) {
    const path = `apps/desktop/src/bridge/${name}.ts`;
    let source;
    if (ref) {
      const r = spawnSync('git', ['-C', REPO, 'show', `${commit}:${path}`], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
      if (r.status !== 0) throw new Error(`probe: ${path} is not in ${ref}`);
      source = r.stdout;
    } else {
      const file = join(REPO, path);
      if (!existsSync(file)) {
        throw new Error(`probe: ${path} is not in the working tree; pass --bridge-ref=<commit that has it>`);
      }
      source = readFileSync(file, 'utf8');
    }
    const js = stripTypeScriptTypes(source, { mode: 'strip' })
      // Relative imports are written `./x.js`; the stripped files are `./x.mjs`.
      .replace(/from '\.\/([a-z-]+)\.js'/g, "from './$1.mjs'");
    const target = join(dir, `${name}.mjs`);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, js);
  }
  return { dir, source: ref ? `git ${ref}` : 'working tree', commit };
}

/* ── Numbers ─────────────────────────────────────────────────────────── */

function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return Math.round(sorted[index] * 100) / 100;
}

function stats(values) {
  if (values.length === 0) return { n: 0 };
  return {
    n: values.length,
    min: percentile(values, 0),
    p50: percentile(values, 50),
    p95: percentile(values, 95),
    p99: percentile(values, 99),
    max: percentile(values, 100),
  };
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

async function until(check, ms, what) {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`probe: timed out after ${ms} ms waiting for ${what}`);
    await sleep(5);
  }
}

module.exports = {
  REPO,
  out,
  arg,
  flag,
  tempRoot,
  quietApp,
  accessory,
  loads,
  versions,
  gitHead,
  assertLoopbackOnly,
  guardListen,
  loadBridge,
  stats,
  percentile,
  sleep,
  until,
};
