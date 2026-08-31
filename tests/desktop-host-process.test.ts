import { fork } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { Supervisor, systemTimers } from '@chatterang/desktop/bridge';
import type { HostHandle, SupervisorPolicy } from '@chatterang/desktop/bridge';

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

/** Short enough for a test, structured exactly like the shipped defaults. */
const FAST: Partial<SupervisorPolicy> = {
  tickMs: 10,
  callTimeoutMs: 4_000,
  generateIdleTimeoutMs: 4_000,
  pingIntervalMs: 60,
  pingTimeoutMs: 120,
  restartDelayMs: 30,
};

interface Spawned {
  readonly supervisor: Supervisor;
  readonly children: ChildProcess[];
}

const running: Supervisor[] = [];
const forked: ChildProcess[] = [];

afterEach(() => {
  for (const supervisor of running.splice(0)) supervisor.dispose();
  for (const child of forked.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
});

function spawnSupervised(policy: Partial<SupervisorPolicy> = FAST): Spawned {
  const children: ChildProcess[] = [];
  const supervisor = new Supervisor({
    spawn: (): HostHandle => {
      const child = fork(HOST_SCRIPT, [], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
      children.push(child);
      forked.push(child);
      return {
        link: {
          postMessage: (message) => {
            if (child.connected) child.send(message as object);
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
    timers: systemTimers(),
    policy,
  });
  running.push(supervisor);
  return { supervisor, children };
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
      const first = (await supervisor.getCapabilities()) as { pid: number };
      expect(typeof first.pid).toBe('number');
      expect(alive(first.pid)).toBe(true);

      process.kill(first.pid, 'SIGKILL');
      await until('the OS to reap the killed host', () => !alive(first.pid));

      await until('a replacement host', () => supervisor.spawnCount === 2);
      const second = (await supervisor.getCapabilities()) as { pid: number };

      expect(second.pid).not.toBe(first.pid);
      expect(alive(second.pid)).toBe(true);
      expect(children).toHaveLength(2);
      // And the status is the new host's, not the dead one's.
      expect(supervisor.hostStatus().notChecked).toContain(String(second.pid));
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
      const first = (await supervisor.getCapabilities()) as { pid: number };

      await supervisor.unload({ handle: 'h' });
      // Still there. This is the state the exit-based paths cannot see.
      expect(alive(first.pid)).toBe(true);

      await until('the wedged host to be replaced', () => supervisor.spawnCount === 2);
      // Terminated by the supervisor — it was never going to exit on its own.
      await until('the wedged host to be terminated', () => !alive(first.pid));

      const second = (await supervisor.getCapabilities()) as { pid: number };
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
      const { supervisor } = spawnSupervised({ ...FAST, callTimeoutMs: 400 });
      const first = (await supervisor.getCapabilities()) as { pid: number };

      const stuck = supervisor.listLoaded().catch((error: unknown) => error);
      const failure = (await stuck) as { code?: string };

      expect(failure.code).toBe('HOST_TIMEOUT');
      expect(alive(first.pid)).toBe(true);
      expect(supervisor.spawnCount).toBe(1);
      // And the host is still usable afterwards: one dead call is not a dead
      // host.
      expect(((await supervisor.getCapabilities()) as { pid: number }).pid).toBe(first.pid);
    },
    15_000,
  );

  it(
    'dispose() terminates the host and does not spawn another',
    async () => {
      const { supervisor } = spawnSupervised();
      const first = (await supervisor.getCapabilities()) as { pid: number };
      supervisor.dispose();
      await until('the host to exit', () => !alive(first.pid));
      // FAULT INJECTED, with a caveat worth stating: `#disposed` is checked in
      // BOTH `#scheduleRestart` and `#attach`, and removing EITHER one alone
      // leaves this test green (exit=0) — the other still stops the respawn.
      // Removing both fails it (exit=1). So this pins the behaviour, "no host
      // outlives the app", and not either individual line.
      await new Promise((done) => setTimeout(done, 200));
      expect(supervisor.spawnCount).toBe(1);
      await expect(supervisor.getCapabilities()).rejects.toThrow(/shutting down/);
    },
    15_000,
  );
});
