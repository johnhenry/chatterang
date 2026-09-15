// BN3 item 4, RUN BY THE OWNER, BY HAND: across a real sleep, does a timer
// tick run in Electron's main process before powerMonitor's 'resume' is
// delivered?
//
// Record (from the repo root; leave it running in a terminal):
//
//   node_modules/.bin/electron dev/probe-electron-hidden-worker/sleep-order.cjs --out=/tmp/sleep-order.jsonl
//
// then put the machine to sleep yourself (Apple menu > Sleep, or close the lid),
// leave it asleep for at least 60 seconds, wake it, wait at least 20 seconds,
// and repeat until three cycles are done. The script stops on its own 20 s after
// the third 'resume' (or on Ctrl+C) and prints the report.
//
// Report again from a recording, with plain Node:
//
//   node dev/probe-electron-hidden-worker/sleep-order.cjs --report=/tmp/sleep-order.jsonl
//
// THIS SCRIPT NEVER PUTS THE MACHINE TO SLEEP AND NEVER KEEPS IT AWAKE: it calls
// no pmset, no powerSaveBlocker, nothing that suspends, locks or logs out. It
// opens no window and no socket.
//
// What it writes, one JSON object per line, each with three clocks read back to
// back: `wall` (Date.now), `hr` (process.hrtime, ms) and `perf`
// (performance.now):
//
//   start   versions, pid, OS release, load average
//   tick    the 1000 ms interval (the Supervisor's `tickMs`), every tick, with
//           the gap since the previous tick on each clock
//   fine    a 50 ms interval, written only when late (wall gap over 500 ms) and
//           for the first tick after each power event
//   power   suspend, resume, lock-screen, unlock-screen, shutdown, with the last
//           tick of each timer seen before it
//   stop    why it stopped
//
// The ORDER OF LINES is the order in which main ran the callbacks, which is the
// question: a late tick written before 'resume' is a tick that ran after the
// wake and before the resume event.
'use strict';

const { appendFileSync, readFileSync, writeSync } = require('node:fs');
const { release, loadavg, tmpdir } = require('node:os');
const { join } = require('node:path');

const arg = (name, fallback = '') => {
  const found = process.argv.find((a) => a.startsWith(`--${name}=`));
  return found === undefined ? fallback : found.slice(name.length + 3);
};

const TICK_MS = 1000;
const FINE_MS = 50;
const say = (text) => {
  try {
    writeSync(1, `${text}\n`);
  } catch {
    /* a closed terminal loses a line */
  }
};

/* ── Report ────────────────────────────────────────────────────────────── */

function report(path, wantedCycles) {
  const records = readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l));
  const start = records.find((r) => r.kind === 'start');
  const cycles = [];
  let open = null;
  records.forEach((r, index) => {
    if (r.kind === 'power' && r.event === 'suspend') {
      open = { suspend: { ...r, index } };
      return;
    }
    if (r.kind === 'power' && r.event === 'resume') {
      const cycle = open ?? { suspend: null };
      cycle.resume = { ...r, index };
      cycles.push(cycle);
      open = null;
    }
  });

  const lateThreshold = { tick: TICK_MS * 2 + 1000, fine: 500 };
  const rows = cycles.map((cycle, n) => {
    const from = cycle.suspend ? cycle.suspend.index : 0;
    const to = cycle.resume.index;
    const between = records.slice(from + 1, to);
    const firstLate = (timer) => {
      // The first late tick after the suspend, wherever it falls relative to resume.
      const index = records.findIndex((r, i) => i > from && r.kind === timer && r.wallGap !== null && r.wallGap > lateThreshold[timer]);
      return index === -1 ? null : { ...records[index], index };
    };
    const late = { tick: firstLate('tick'), fine: firstLate('fine') };
    const describe = (l) =>
      l === null
        ? 'no late tick found'
        : `${l.index < to ? 'BEFORE' : 'after'} resume (wall gap ${Math.round(l.wallGap)} ms, hr gap ${Math.round(l.hrGap)} ms, perf gap ${Math.round(l.perfGap)} ms)`;
    return {
      cycle: n + 1,
      suspendSeen: cycle.suspend !== null,
      asleepWallMs: cycle.suspend ? cycle.resume.wall - cycle.suspend.wall : null,
      asleepHrMs: cycle.suspend ? Math.round(cycle.resume.hr - cycle.suspend.hr) : null,
      asleepPerfMs: cycle.suspend ? Math.round(cycle.resume.perf - cycle.suspend.perf) : null,
      ticksBetweenSuspendAndResume: between.filter((r) => r.kind === 'tick').length,
      firstLateTick: describe(late.tick),
      firstLateFine: describe(late.fine),
      tickBeforeResume: late.tick !== null && late.tick.index < to,
      fineBeforeResume: late.fine !== null && late.fine.index < to,
      lateTickFound: late.tick !== null,
    };
  });

  say(`sleep-order report: ${path}`);
  if (start) say(`recorded with Electron ${start.versions.electron} (Chrome ${start.versions.chrome}, Node ${start.versions.node}) on ${start.platform} ${start.osRelease}, load ${start.load.join(' ')}`);
  say('| cycle | suspend seen | asleep (wall / hr / perf, s) | ticks between suspend and resume | first late 1 s tick | first late 50 ms tick |');
  say('|---|---|---|---|---|---|');
  for (const r of rows) {
    const asleep = r.suspendSeen ? `${(r.asleepWallMs / 1000).toFixed(1)} / ${(r.asleepHrMs / 1000).toFixed(1)} / ${(r.asleepPerfMs / 1000).toFixed(1)}` : '-';
    say(`| ${r.cycle} | ${r.suspendSeen} | ${asleep} | ${r.ticksBetweenSuspendAndResume} | ${r.firstLateTick} | ${r.firstLateFine} |`);
  }
  const complete = rows.filter((r) => r.suspendSeen && r.lateTickFound);
  say(`complete cycles: ${complete.length} of ${wantedCycles} wanted`);
  say(`a 1 s tick ran before 'resume' in ${complete.filter((r) => r.tickBeforeResume).length} of ${complete.length}; a 50 ms tick in ${complete.filter((r) => r.fineBeforeResume).length} of ${complete.length}`);
  say(`SLEEP_ORDER_REPORT ${JSON.stringify({ wantedCycles, rows })}`);
  return complete.length >= wantedCycles ? 0 : 2;
}

const REPORT = arg('report');
const CYCLES = Number(arg('cycles', '3')) || 3;

if (REPORT) {
  process.exitCode = report(REPORT, CYCLES);
} else if (process.versions.electron === undefined) {
  say('sleep-order: run this under Electron (node_modules/.bin/electron ...), or pass --report=<file> to read a recording.');
  process.exitCode = 1;
} else {
  record();
}

/* ── Record ────────────────────────────────────────────────────────────── */

function record() {
  const { app, powerMonitor } = require('electron');
  const OUT = arg('out', join(tmpdir(), `sleep-order-${Date.now()}.jsonl`));
  const clocks = () => ({ wall: Date.now(), hr: Number(process.hrtime.bigint()) / 1e6, perf: performance.now() });
  const write = (record) => appendFileSync(OUT, `${JSON.stringify(record)}\n`);

  app.setPath('userData', join(tmpdir(), `sleep-order-userdata-${process.pid}`));
  app.on('window-all-closed', () => undefined);

  app.whenReady().then(() => {
    if (process.platform === 'darwin') {
      app.setActivationPolicy('accessory');
      app.dock?.hide();
    }
    write({
      kind: 'start',
      ...clocks(),
      pid: process.pid,
      platform: process.platform,
      osRelease: release(),
      load: loadavg().map((n) => Math.round(n * 100) / 100),
      versions: { electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node },
      cycles: CYCLES,
    });
    say(`sleep-order: recording to ${OUT}`);
    say(`sleep-order: now sleep the machine yourself, >= 60 s asleep, wake, wait >= 20 s; ${CYCLES} times.`);

    const last = { tick: null, fine: null };
    const seq = { tick: 0, fine: 0 };
    let firstFineAfterPower = false;

    const timer = (name, ms) =>
      setInterval(() => {
        const c = clocks();
        const prev = last[name];
        const gaps = prev === null ? { wallGap: null, hrGap: null, perfGap: null } : { wallGap: c.wall - prev.wall, hrGap: c.hr - prev.hr, perfGap: c.perf - prev.perf };
        last[name] = c;
        seq[name] += 1;
        if (name === 'tick' || (gaps.wallGap !== null && gaps.wallGap > 500) || firstFineAfterPower) {
          if (name === 'fine') firstFineAfterPower = false;
          write({ kind: name, seq: seq[name], ...c, ...gaps });
        }
      }, ms);
    timer('tick', TICK_MS);
    timer('fine', FINE_MS);

    let resumes = 0;
    let stopping = false;
    const stop = (why) => {
      if (stopping) return;
      stopping = true;
      write({ kind: 'stop', ...clocks(), why });
      say(`sleep-order: stopped (${why}).`);
      const code = report(OUT, CYCLES);
      app.exit(code);
    };

    for (const event of ['suspend', 'resume', 'lock-screen', 'unlock-screen', 'shutdown']) {
      powerMonitor.on(event, () => {
        write({ kind: 'power', event, ...clocks(), lastTickSeq: seq.tick, lastFineSeq: seq.fine });
        firstFineAfterPower = true;
        say(`sleep-order: ${event} at ${new Date().toISOString()}`);
        if (event === 'resume') {
          resumes += 1;
          if (resumes >= CYCLES) setTimeout(() => stop(`${CYCLES} resumes seen`), 20_000);
        }
      });
    }
    process.on('SIGINT', () => stop('SIGINT'));
    process.on('SIGTERM', () => stop('SIGTERM'));
  });
}
