// Run every scenario of main.cjs in its OWN Electron main process.
//
//   node dev/probe-electron-utility-process/run.cjs            (from the repo root)
//   node dev/probe-electron-utility-process/run.cjs --no-wrap
//   node dev/probe-electron-utility-process/run.cjs --match=inside
//
// One process per scenario because some of them kill Electron's main process
// with SIGSEGV, which would end a single-process run at that scenario. This
// spawns the Electron binary directly (the path `require('electron')` answers,
// which is what node_modules/.bin/electron launches), so a signal is seen as a
// signal rather than as the wrapper's exit code 1.
const { spawn } = require('node:child_process');
const { join, resolve } = require('node:path');

const REPO = resolve(__dirname, '..', '..');
const ELECTRON = require(join(REPO, 'node_modules', 'electron'));
const MAIN = join(__dirname, 'main.cjs');
const extra = process.argv.slice(2);
const only = (extra.find((a) => a.startsWith('--match=')) ?? '').slice('--match='.length);
// --repeat=N runs each matched scenario N times, each in a fresh Electron, and
// adds a table of how often main survived. A crash that depends on a race is
// only honestly described as a rate.
const repeat = Math.max(1, Number((extra.find((a) => a.startsWith('--repeat=')) ?? '--repeat=1').slice('--repeat='.length)) || 1);
const passThrough = extra.filter((a) => !a.startsWith('--match=') && !a.startsWith('--repeat='));
const SCENARIO_LIMIT_MS = 60_000;
// Scenarios in this probe crash Electron on purpose. After a crash, macOS shows
// the next launch of the same app a modal alert offering to reopen its windows
// (`NSPersistentUIRestorer promptToIgnorePersistentStateWithCrashHistory`,
// sampled on a stalled launch). With the dock icon hidden nobody can see it,
// and main blocks in it forever. This argument-domain default applies to this
// one launch only and skips that prompt; it changes no stored setting.
const MACOS_NO_RESTORE = process.platform === 'darwin' ? ['-ApplePersistenceIgnoreState', 'YES'] : [];

const line = (out, tag) => out.split('\n').find((l) => l.startsWith(tag));

/**
 * One Electron main, its pipes drained as it runs, SIGKILLed at the limit.
 *
 * The limit exists because launches stalled. Every stall sampled was the macOS
 * reopen-windows alert described above, not the API under test. A scenario
 * that still stalls is recorded as timed out instead of stalling the run.
 */
function electron(args) {
  return new Promise((done) => {
    const child = spawn(ELECTRON, [...args, ...MACOS_NO_RESTORE], { stdio: ['ignore', 'pipe', 'pipe'] });
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
    }, SCENARIO_LIMIT_MS);
    child.on('close', (status, signal) => {
      clearTimeout(limit);
      done({ status, signal, stdout, stderr, timedOut });
    });
  });
}

async function main() {
  const listed = await electron([MAIN, '--list']);
  const listLine = line(listed.stdout, 'PROBE_LIST ');
  if (listLine === undefined) {
    console.log(
      `PROBE_RUN_ABORTED Electron did not list its scenarios (${listed.timedOut ? 'stalled' : `exit ${listed.status} ${listed.signal ?? ''}`}). ` +
        `stderr: ${listed.stderr.trim().slice(-300)}`,
    );
    process.exitCode = 1;
    return;
  }
  const names = JSON.parse(listLine.slice('PROBE_LIST '.length));

  const rows = [];
  let versions;
  const attempts = names
    .filter((name) => !only || name.includes(only))
    .flatMap((name) => Array.from({ length: repeat }, () => name));
  for (const name of attempts) {
    const started = Date.now();
    const result = await electron([MAIN, `--only=${name}`, ...passThrough]);
    const out = result.stdout;
    const scenario = line(out, 'PROBE_SCENARIO ');
    const results = out.indexOf('PROBE_RESULTS ');
    if (results !== -1 && versions === undefined) {
      const tail = out.slice(results + 'PROBE_RESULTS '.length, out.indexOf('\nPROBE_MAIN_SURVIVED'));
      try {
        versions = JSON.parse(tail).versions;
      } catch {
        /* versions come from another run */
      }
    }
    const summary = scenario ? JSON.parse(scenario.slice('PROBE_SCENARIO '.length)) : undefined;
    let mainExit = result.signal ? `killed by ${result.signal}` : `exit ${result.status}`;
    if (result.timedOut) mainExit = `stalled; SIGKILLed by the runner at ${SCENARIO_LIMIT_MS} ms`;
    const row = {
      name,
      mainExit,
      mainSurvived: out.includes('PROBE_MAIN_SURVIVED'),
      wallMs: Date.now() - started,
      summary,
      probeError: line(out, 'PROBE_SCENARIO_ERROR '),
      escaped: out.split('\n').filter((l) => l.startsWith('PROBE_ESCAPED ')),
      lastStep: out.split('\n').filter((l) => l.startsWith('PROBE_STEP ')).at(-1),
      stderrTail: result.stderr.trim().split('\n').slice(-3).join(' | ').slice(0, 300),
    };
    rows.push(row);
    console.log('PROBE_RUN_ROW ' + JSON.stringify(row));
  }

  console.log('\nPROBE_VERSIONS ' + JSON.stringify(versions));
  console.log('\n| scenario | main process | postMessage threw | posts before / after exit | error events | escaped into main |');
  console.log('|---|---|---|---|---|---|');
  for (const r of rows) {
    const s = r.summary;
    const mainCell = r.mainSurvived ? 'survived' : `**${r.mainExit}**`;
    const threw = s ? (s.threw ? `${s.threw} (${s.firstThrow})` : 'never') : '(no report)';
    const counts = s ? `${s.postsBeforeExit} / ${s.postsAfterExit}` : '-';
    let errors = '-';
    if (s) {
      if (s.errorEvents.length) errors = JSON.stringify(s.errorEvents.map((e) => e.type));
      else if (s.events.error) errors = `${s.events.error} (no listener)`;
      else errors = 'none';
    }
    const esc = r.escaped.length ? r.escaped.join('; ').slice(0, 160) : 'nothing';
    console.log(`| ${r.name} | ${mainCell} | ${threw} | ${counts} | ${errors} | ${esc} |`);
  }

  if (repeat > 1) {
    console.log(`\n| scenario (x${repeat}) | main survived | main died | how it died |`);
    console.log('|---|---|---|---|');
    for (const name of [...new Set(rows.map((r) => r.name))]) {
      const mine = rows.filter((r) => r.name === name);
      const died = mine.filter((r) => !r.mainSurvived);
      const how = [...new Set(died.map((r) => r.mainExit))].join(', ') || '-';
      console.log(`| ${name} | ${mine.length - died.length} | ${died.length} | ${how} |`);
    }
  }
}

main();
