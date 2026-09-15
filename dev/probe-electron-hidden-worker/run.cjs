// Run scenarios of an Electron probe, each in its OWN Electron main process.
//
//   node dev/probe-electron-hidden-worker/run.cjs [--match=<substring>] [--repeat=N] [--limit=MS]
//        [--bridge-ref=<git commit>] [--out=<file.json>] [--probe=<main.cjs path>]
//
// One process per scenario: window-all-closed depends on the process's whole
// window list, a crash scenario must not share a renderer with the next, and
// one scenario deliberately lets Electron quit.
//
// Exit code: 0 only if every scenario reported ok (its steps ran and its
// loopback check passed); 1 otherwise. A scenario that quits the app on
// purpose counts as ok when its last partial report was ok and it exited 0.
'use strict';

const { spawn } = require('node:child_process');
const { mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir, loadavg, release } = require('node:os');
const { join, resolve } = require('node:path');
const lib = require('./lib.cjs');

const REPO = lib.REPO;
const ELECTRON = require(join(REPO, 'node_modules', 'electron'));
const MAIN = resolve(lib.arg('probe', join(__dirname, 'main.cjs')));
const MATCH = lib.arg('match');
const REPEAT = Math.max(1, Number(lib.arg('repeat', '1')) || 1);
const LIMIT_MS = Number(lib.arg('limit', '180000')) || 180_000;
const OUT = lib.arg('out');
const pass = process.argv.slice(2).filter((a) => a.startsWith('--bridge-ref='));
// After a crash, macOS shows the next launch of the same app an invisible
// reopen-windows alert; this argument-domain default skips it for one launch.
const MACOS_NO_RESTORE = process.platform === 'darwin' ? ['-ApplePersistenceIgnoreState', 'YES'] : [];

const live = new Map();
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    for (const [child, root] of live) {
      child.kill('SIGKILL');
      rmSync(root, { recursive: true, force: true });
    }
    process.exit(signal === 'SIGINT' ? 130 : 143);
  });
}

function electron(args) {
  return new Promise((done) => {
    const root = mkdtempSync(join(tmpdir(), 'probe-bn3-'));
    const child = spawn(ELECTRON, [...args, `--temp-root=${root}`, ...MACOS_NO_RESTORE], { stdio: ['ignore', 'pipe', 'pipe'] });
    live.set(child, root);
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    const limit = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, LIMIT_MS);
    child.on('close', (status, signal) => {
      clearTimeout(limit);
      live.delete(child);
      rmSync(root, { recursive: true, force: true });
      done({ status, signal, stdout, stderr, timedOut });
    });
  });
}

const lines = (text, tag) => text.split('\n').filter((l) => l.startsWith(tag)).map((l) => l.slice(tag.length));

async function main() {
  const started = new Date().toISOString();
  const listed = await electron([MAIN, '--list']);
  const list = lines(listed.stdout, 'PROBE_LIST ')[0];
  if (list === undefined) {
    console.log(`PROBE_RUN_ABORTED the probe did not list its scenarios (exit ${listed.status} ${listed.signal ?? ''}): ${listed.stderr.trim().slice(-400)}`);
    process.exitCode = 1;
    return;
  }
  const names = JSON.parse(list).filter((name) => !MATCH || name.includes(MATCH));
  const rows = [];
  for (const name of names) {
    for (let attempt = 1; attempt <= REPEAT; attempt += 1) {
      const loadBefore = loadavg();
      const t = Date.now();
      const result = await electron([MAIN, `--only=${name}`, ...pass]);
      const reports = lines(result.stdout, 'PROBE_RESULT ').map((l) => JSON.parse(l));
      const report = reports.at(-1);
      const exit = result.timedOut ? `SIGKILLed at ${LIMIT_MS} ms` : result.signal ? `killed by ${result.signal}` : `exit ${result.status}`;
      const ok = report !== undefined && report.ok === true && result.status === 0 && !result.timedOut && (report.partial !== true || name.includes('NO listener'));
      const row = {
        name,
        attempt,
        ok,
        exit,
        wallMs: Date.now() - t,
        runnerLoadBefore: loadBefore.map((n) => Math.round(n * 100) / 100),
        events: lines(result.stdout, 'PROBE_EVENT ').map((l) => JSON.parse(l)),
        fails: lines(result.stdout, 'PROBE_FAIL '),
        report,
        stderrTail: ok ? undefined : result.stderr.trim().split('\n').slice(-6).join(' | ').slice(0, 800),
      };
      rows.push(row);
      console.log(`PROBE_RUN_ROW ${JSON.stringify({ name, attempt, ok, exit, wallMs: row.wallMs, error: report?.error?.split('\n')[0], fails: row.fails })}`);
    }
  }
  const summary = {
    started,
    finished: new Date().toISOString(),
    commit: lib.gitHead(),
    osRelease: release(),
    platform: process.platform,
    arch: process.arch,
    versions: rows.find((r) => r.report?.versions)?.report.versions,
    probe: MAIN.slice(REPO.length + 1),
    args: process.argv.slice(2),
    ok: rows.length > 0 && rows.every((r) => r.ok),
    rows,
  };
  if (OUT) writeFileSync(OUT, JSON.stringify(summary, null, 1));
  console.log(`PROBE_RUN_DONE ok=${summary.ok} scenarios=${rows.length} failed=${rows.filter((r) => !r.ok).length}${OUT ? ` out=${OUT}` : ''}`);
  process.exitCode = summary.ok ? 0 : 1;
}

main();
