import { execFileSync, fork } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { LLAMA_ENGINE, LLAMA_PLUGIN, Supervisor, systemTimers } from '@chatterang/desktop/bridge';
import type { EngineSpec, HostHandle, SupervisorPolicy } from '@chatterang/desktop/bridge';

/**
 * THE SUPERVISOR AGAINST REAL PROCESSES.
 *
 * `tests/desktop-bridge.test.ts` drives the same code through fake ports with
 * a clock the test owns, which is the right tool for asserting exact
 * behaviour at exact times. It cannot make one claim, and it is the claim the
 * defect was reported as: **SIGKILL the child and every later call fails
 * forever.** "The fake emitted `exit`" and "the OS killed the process" are
 * different statements, and only one of them is about the thing that broke.
 *
 * So everything below forks a real child with `child_process.fork`, kills it
 * with a real signal, and asks the OS whether it is gone. The wall clock is
 * real too — `systemTimers()`, the shipped implementation — with the policy
 * durations shortened so the suite does not take four minutes. The DURATIONS
 * are the only thing faked here.
 *
 * Electron's `utilityProcess` is not available outside an Electron runtime and
 * launching one is forbidden in this repo, so the child is a Node fork over
 * Node's own IPC. Both satisfy `MessageLink` identically: a `postMessage`, a
 * `message` event, and an `exit` event. What is NOT covered is
 * `utilityProcess.fork` itself and `UtilityProcess.kill` — those live in
 * `main.ts`, which no test in this repo can import.
 */

// Resolved from the vitest root rather than `import.meta.url`, which under
// the jsdom environment is an http: URL and not a path at all. Checked, so a
// moved fixture fails here rather than as four forks of nothing.
const HOST_SCRIPT = resolve(process.cwd(), 'tests/fixtures/inference-host-double.mjs');
if (!existsSync(HOST_SCRIPT)) throw new Error(`missing inference host double: ${HOST_SCRIPT}`);

/**
 * THE PING WINDOW, AND WHY IT IS NOT SHORT.
 *
 * The supervisor's ping clock starts at SPAWN, not at boot: `#attach` stamps
 * the last ping as "now", the first ping goes out `pingIntervalMs` later, and
 * the host is condemned if it has not answered `pingTimeoutMs` after that. So
 * every real fork below has `pingIntervalMs + pingTimeoutMs` to be scheduled,
 * start Node, run the double and read its IPC channel — before and during
 * whatever the test itself is waiting for.
 *
 * That window used to be 60 + 120 = 180 ms. A fork boots in ~25 ms on an idle
 * machine, and on one running several suites at once it did not: the first
 * `getCapabilities` in the `dispose()` test rejected with "no answer to a
 * liveness ping in 123ms" — before `dispose()` was ever called, and not
 * because anything was wedged. The supervisor was right to condemn a host
 * that did not answer inside its policy; the policy was too tight for a real
 * process on a shared machine. The slow-start test below holds the double's
 * event loop for `SLOW_START_MS` and fails with exactly that error under the
 * old window.
 *
 * The cost is paid only where the ping is the thing under test: detecting the
 * wedged host takes about two seconds instead of about two hundred ms.
 */
const PING_INTERVAL_MS = 60;
const PING_TIMEOUT_MS = 2_000;
/** How long the slow-start double stays deaf: well past the old 180 ms window, well inside this one. */
const SLOW_START_MS = 500;

/** Short enough for a test, structured exactly like the shipped defaults. */
const FAST: Partial<SupervisorPolicy> = {
  tickMs: 10,
  callTimeoutMs: 4_000,
  generateIdleTimeoutMs: 4_000,
  pingIntervalMs: PING_INTERVAL_MS,
  pingTimeoutMs: PING_TIMEOUT_MS,
  restartDelayMs: 30,
};

/**
 * A SECOND engine on the same host process, so the respawn story is asserted
 * with the plugin dimension in it.
 *
 * Not ONNX — that is milestone A3 — but the same shape a real second engine
 * has: its own plugin name, its own method names, its own event names, its own
 * terminal event. The fixture at `tests/fixtures/inference-host-double.mjs`
 * answers both, keyed by `plugin`.
 */
const SIDECAR: EngineSpec = {
  definition: { name: 'Sidecar', methods: ['describe', 'run', 'halt'], events: ['sideChunk', 'sideDone'] },
  stream: {
    start: 'run',
    cancel: 'halt',
    terminal: 'sideDone',
    progress: ['sideChunk'],
    synthesise: (requestId, error) => ({ requestId, error }),
  },
};

interface Facade {
  getCapabilities(): Promise<unknown>;
  unload(options: unknown): Promise<unknown>;
  listLoaded(): Promise<unknown>;
  describe(): Promise<unknown>;
}

function llama(supervisor: Supervisor): Facade {
  return supervisor.plugin(LLAMA_PLUGIN.name) as unknown as Facade;
}

function sidecar(supervisor: Supervisor): Facade {
  return supervisor.plugin(SIDECAR.definition.name) as unknown as Facade;
}

interface Spawned {
  readonly supervisor: Supervisor;
  readonly children: ChildProcess[];
  /** Posts the OS refused because the child was already gone, by error code. */
  readonly refusedPosts: string[];
}

/** What a write to a child that has already died fails with. Nothing else is expected. */
const FAR_SIDE_GONE = new Set(['EPIPE', 'ECONNRESET', 'ERR_IPC_CHANNEL_CLOSED']);

const running: Supervisor[] = [];
const forked: ChildProcess[] = [];

afterEach(() => {
  for (const supervisor of running.splice(0)) supervisor.dispose();
  for (const child of forked.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
});

function spawnSupervised(
  policy: Partial<SupervisorPolicy> = FAST,
  host: { readonly startupBlockMs?: number } = {},
): Spawned {
  const children: ChildProcess[] = [];
  const refusedPosts: string[] = [];
  const supervisor = new Supervisor({
    spawn: (): HostHandle => {
      const child = fork(HOST_SCRIPT, [], {
        stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
        env: { ...process.env, INFERENCE_HOST_DOUBLE_STARTUP_BLOCK_MS: String(host.startupBlockMs ?? 0) },
      });
      children.push(child);
      forked.push(child);
      return {
        link: {
          postMessage: (message) => {
            if (!child.connected) return;
            // A child killed a moment ago still reads as `connected` until Node
            // has read its exit, so this write can fail with EPIPE. Without a
            // callback Node emits that as `error` on the ChildProcess, which
            // nothing listens for: it escaped as an uncaught exception and
            // failed a run under load with every test green. The loss itself is
            // reported by `exit`, which is all `MessageLink` promises; a failure
            // that is not a dead child is thrown.
            child.send(message as object, (error: Error | null) => {
              if (error === null) return;
              const code = (error as NodeJS.ErrnoException).code ?? '';
              if (!FAR_SIDE_GONE.has(code)) throw error;
              refusedPosts.push(code);
            });
          },
          onMessage: (listener) => {
            child.on('message', (message: unknown) => listener(message));
          },
          onClose: (listener) => {
            child.once('exit', (code, signal) =>
              listener(signal === null ? `exit code ${String(code)}` : String(signal)),
            );
          },
        },
        kill: () => {
          if (child.exitCode !== null || child.signalCode !== null) return;
          child.kill();
        },
      };
    },
    notify: () => undefined,
    engines: [LLAMA_ENGINE, SIDECAR],
    timers: systemTimers(),
    policy,
  });
  running.push(supervisor);
  return { supervisor, children, refusedPosts };
}

/** True while the OS still has this pid. Signal 0 checks without delivering. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Hold THIS thread until the OS has torn `pid` down — a zombie, every
 * descriptor closed — without letting the event loop turn, so Node has not yet
 * read the exit or the socket closing. Polls `ps` rather than sleeping a
 * guessed interval, so a loaded machine only makes it wait longer.
 */
function blockUntilTornDown(pid: number, ms = 5_000): void {
  const deadline = Date.now() + ms;
  const pause = new Int32Array(new SharedArrayBuffer(4));
  while (Date.now() < deadline) {
    let state = '';
    try {
      state = execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).trim();
    } catch {
      // `ps` exits non-zero once the pid is gone altogether.
    }
    if (state === '' || state.startsWith('Z')) return;
    Atomics.wait(pause, 0, 0, 10);
  }
  throw new Error(`timed out waiting for the OS to tear down pid ${String(pid)}`);
}

async function until(what: string, predicate: () => boolean, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((done) => setTimeout(done, 10));
  }
  throw new Error(`timed out waiting for: ${what}`);
}

describe('the inference host, killed for real', () => {
  it(
    'survives SIGKILL: the next call is answered by a new process',
    async () => {
      // DEFECT [2], as it was reported. FAULT INJECTED: reverting `#onClose`
      // to leave `#closed` latched and never respawn made the second
      // `getCapabilities` reject with "The inference process stopped
      // unexpectedly (SIGKILL)." — the reviewer's finding, reproduced, and
      // then fixed.
      const { supervisor, children } = spawnSupervised();
      const first = (await llama(supervisor).getCapabilities()) as { pid: number };
      expect(typeof first.pid).toBe('number');
      expect(alive(first.pid)).toBe(true);

      process.kill(first.pid, 'SIGKILL');
      await until('the OS to reap the killed host', () => !alive(first.pid));

      await until('a replacement host', () => supervisor.spawnCount === 2);
      const second = (await llama(supervisor).getCapabilities()) as { pid: number };

      expect(second.pid).not.toBe(first.pid);
      expect(alive(second.pid)).toBe(true);
      expect(children).toHaveLength(2);
      // And the status is the new host's, not the dead one's.
      expect(supervisor.hostStatus().notChecked).toContain(String(second.pid));
    },
    15_000,
  );

  it(
    'settles a call posted to a host that is dead but not yet reaped, and keeps the refused write inside the link',
    async () => {
      // The second way this file failed under load: a ping posted in the gap
      // between SIGKILL and Node reading the exit hit a closed socket, and the
      // EPIPE escaped the run as an uncaught exception with every test green.
      // Made deterministic by holding the gap open from this side: the child
      // is killed and torn down while this thread is held, so the call below
      // is written to a socket nobody will read before Node can notice.
      // FAULT INJECTED: posting with a bare `child.send(message)`, as the
      // adapter did, made 3 runs of 3 exit 1 with "Uncaught Exception: Error:
      // write EPIPE" and fail `refusedPosts` below with "expected 0 to be
      // greater than 0".
      const { supervisor, refusedPosts } = spawnSupervised();
      const first = (await llama(supervisor).getCapabilities()) as { pid: number };

      process.kill(first.pid, 'SIGKILL');
      blockUntilTornDown(first.pid);
      const lost = llama(supervisor).getCapabilities().catch((error: unknown) => error);

      // The call is not lost with the write: the exit that follows settles it.
      expect(((await lost) as { code?: string }).code).toBe('HANDLE_LOST');
      // And the race was really hit, rather than this passing because it was not.
      expect(refusedPosts.length).toBeGreaterThan(0);

      await until('a replacement host', () => supervisor.spawnCount === 2);
      const second = (await llama(supervisor).getCapabilities()) as { pid: number };
      expect(second.pid).not.toBe(first.pid);
    },
    15_000,
  );

  it(
    'replaces a host that is ALIVE and no longer answering, and terminates it',
    async () => {
      // DEFECT [4], the half no `exit` can report. The fixture stops answering
      // pings on `unload` and keeps running; nothing about the process tells
      // main it is useless. FAULT INJECTED: removing `#pingTick` from `#tick`
      // left spawnCount at 1 and the wedged process alive for the whole
      // timeout — the app permanently broken with a healthy-looking child.
      const { supervisor } = spawnSupervised();
      const first = (await llama(supervisor).getCapabilities()) as { pid: number };

      await llama(supervisor).unload({ handle: 'h' });
      // Still there. This is the state the exit-based paths cannot see.
      expect(alive(first.pid)).toBe(true);

      // Up to one interval plus one timeout after its last pong, and then some.
      await until(
        'the wedged host to be replaced',
        () => supervisor.spawnCount === 2,
        PING_INTERVAL_MS + PING_TIMEOUT_MS + 5_000,
      );
      // Terminated by the supervisor — it was never going to exit on its own.
      await until('the wedged host to be terminated', () => !alive(first.pid));

      const second = (await llama(supervisor).getCapabilities()) as { pid: number };
      expect(second.pid).not.toBe(first.pid);
    },
    15_000,
  );

  it(
    'does not kill a host that is merely slow, but still settles the call',
    async () => {
      // The distinction the ping exists to make. `listLoaded` is never
      // answered by the fixture, but pings are — a 6 GB model load looks
      // exactly like this, and a liveness check that could not tell the two
      // apart would kill the host mid-load every time.
      //
      // The call has to outlive a WHOLE ping window, or the host still being
      // alive when it times out would say nothing about the ping: a supervisor
      // that condemned any host with a call outstanding for `pingTimeoutMs`
      // would pass a call that gave up first.
      const { supervisor } = spawnSupervised({
        ...FAST,
        callTimeoutMs: PING_INTERVAL_MS + PING_TIMEOUT_MS + 500,
      });
      const first = (await llama(supervisor).getCapabilities()) as { pid: number };

      const stuck = llama(supervisor).listLoaded().catch((error: unknown) => error);
      const failure = (await stuck) as { code?: string };

      expect(failure.code).toBe('HOST_TIMEOUT');
      expect(alive(first.pid)).toBe(true);
      expect(supervisor.spawnCount).toBe(1);
      // And the host is still usable afterwards: one dead call is not a dead
      // host.
      expect(((await llama(supervisor).getCapabilities()) as { pid: number }).pid).toBe(first.pid);
    },
    15_000,
  );

  it(
    'does not condemn a host that is slow to START, as a fork on a loaded machine is',
    async () => {
      // The flake this file had, made deterministic. The double holds its
      // event loop for `SLOW_START_MS` before it can read a message, so the
      // first ping (sent `PING_INTERVAL_MS` after spawn) and the first call
      // both wait in its IPC channel. FAULT INJECTED: restoring the old window
      // (`pingIntervalMs: 60`, `pingTimeoutMs: 120`) made this call reject in
      // 5 runs of 5 with "The inference process stopped unexpectedly (no
      // answer to a liveness ping in 120ms..132ms; the process may be
      // wedged)." — the error the `dispose()` test below failed with under
      // load, raised from the same `#pingTick`, and no other test failed.
      const { supervisor } = spawnSupervised(FAST, { startupBlockMs: SLOW_START_MS });
      const first = (await llama(supervisor).getCapabilities()) as { pid: number };

      expect(alive(first.pid)).toBe(true);
      expect(supervisor.spawnCount).toBe(1);
      // And it keeps answering once it is up: the same process, not a
      // replacement that happened to boot faster.
      expect(((await llama(supervisor).getCapabilities()) as { pid: number }).pid).toBe(first.pid);
    },
    15_000,
  );

  it(
    'dispose() terminates the host and does not spawn another',
    async () => {
      const { supervisor } = spawnSupervised();
      const first = (await llama(supervisor).getCapabilities()) as { pid: number };
      supervisor.dispose();
      await until('the host to exit', () => !alive(first.pid));
      // FAULT INJECTED, with a caveat worth stating: `#disposed` is checked in
      // BOTH `#scheduleRestart` and `#attach`, and removing EITHER one alone
      // leaves this test green (exit=0) — the other still stops the respawn.
      // Removing both fails it (exit=1). So this pins the behaviour, "no host
      // outlives the app", and not either individual line.
      await new Promise((done) => setTimeout(done, 200));
      expect(supervisor.spawnCount).toBe(1);
      await expect(llama(supervisor).getCapabilities()).rejects.toThrow(/shutting down/);
    },
    15_000,
  );

  it(
    'carries the plugin dimension across a real SIGKILL and respawn',
    async () => {
      // The respawn invariant, per plugin, against a real process. Both engines
      // are served by ONE host, so one signal takes both away and the
      // replacement has to answer for both. FAULT INJECTED: dropping `plugin`
      // from the `{k:'call'}` envelope in `Supervisor.#call` made the double
      // answer `no plugin named "undefined"` for every call in this test,
      // before and after the kill.
      const { supervisor } = spawnSupervised();
      const first = (await sidecar(supervisor).describe()) as {
        pid: number;
        plugin: string;
        method: string;
      };
      // The call reached the SIDECAR, under its own method name — not
      // llama.cpp, which has no `describe` at all.
      expect(first.plugin).toBe('Sidecar');
      expect(first.method).toBe('describe');

      process.kill(first.pid, 'SIGKILL');
      await until('the OS to reap the killed host', () => !alive(first.pid));
      await until('a replacement host', () => supervisor.spawnCount === 2);

      const second = (await sidecar(supervisor).describe()) as { pid: number; plugin: string };
      expect(second.pid).not.toBe(first.pid);
      expect(second.plugin).toBe('Sidecar');
      // And llama.cpp is served by the same replacement process.
      expect((await llama(supervisor).getCapabilities()) as { pid: number }).toMatchObject({
        pid: second.pid,
        plugin: 'LlamaCpp',
      });
    },
    15_000,
  );
});
