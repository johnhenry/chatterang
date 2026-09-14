/**
 * The inference host's handle over an Electron `UtilityProcess`
 * (`apps/desktop/src/utility-host.ts`).
 *
 * It is driven over a fake process that behaves the way
 * `dev/probe-electron-utility-process` measured Electron 44.0.0 behaving:
 *
 *   - `postMessage` never throws, whether the process is alive or dead;
 *   - a post to a process that has died is silently dropped;
 *   - a post made from INSIDE the `'exit'` dispatch killed Electron's main
 *     process with SIGSEGV.
 *
 * A fake cannot segfault. So it records the phase each post arrived in, and
 * the tests assert that no post ever arrives inside the exit dispatch or after
 * it. That is the post that would have taken the whole app down.
 */

import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { DEFAULT_POLICY, HANDLE_LOST, LLAMA_PLUGIN, Supervisor } from '@chatterang/desktop/bridge';
import type { SupervisorTimers } from '@chatterang/desktop/bridge';
import { HOST_EXITED, utilityHostHandle } from '@chatterang/desktop/utility-host';

type Phase = 'alive' | 'dead, not yet reaped' | 'inside the exit dispatch' | 'after exit';

interface Post {
  readonly message: unknown;
  readonly phase: Phase;
}

/** An Electron `UtilityProcess`, as measured. */
class FakeUtilityProcess extends EventEmitter {
  readonly posted: Post[] = [];
  kills = 0;
  #phase: Phase = 'alive';

  postMessage(message: unknown): void {
    // Never throws, in any phase. Measured: every post returned undefined.
    this.posted.push({ message, phase: this.#phase });
  }

  kill(): boolean {
    this.kills += 1;
    return this.#phase === 'alive';
  }

  /** The process is gone, but Electron has not dispatched `'exit'` yet. */
  die(): void {
    if (this.#phase === 'alive') this.#phase = 'dead, not yet reaped';
  }

  /** Electron dispatches `'exit'` to every listener, in registration order. */
  exit(code: number): void {
    this.#phase = 'inside the exit dispatch';
    this.emit('exit', code);
    this.#phase = 'after exit';
  }

  /** Posts that reached the process once its exit had been dispatched. */
  get postsToAnExitedProcess(): Post[] {
    return this.posted.filter(
      (post) => post.phase === 'inside the exit dispatch' || post.phase === 'after exit',
    );
  }
}

interface LlamaFacade {
  getCapabilities(): Promise<unknown>;
  generate(senderId: number, options: unknown): Promise<unknown>;
}

/** A clock that moves only when a test moves it, so no ping can rescue a call by accident. */
function heldClock(): SupervisorTimers & { advance(ms: number): void } {
  let now = 0;
  const ticks = new Set<() => void>();
  const pending = new Set<{ at: number; fn: () => void }>();
  return {
    now: () => now,
    every: (_ms, fn) => {
      ticks.add(fn);
      return () => ticks.delete(fn);
    },
    after: (ms, fn) => {
      const entry = { at: now + ms, fn };
      pending.add(entry);
      return () => pending.delete(entry);
    },
    advance(ms) {
      now += ms;
      for (const entry of [...pending]) {
        if (entry.at > now) continue;
        pending.delete(entry);
        entry.fn();
      }
      for (const fn of [...ticks]) fn();
    },
  };
}

/**
 * How a promise stands once the event loop has had a turn.
 *
 * A call that hangs is the failure being tested for, so it is reported as a
 * value rather than left to hit vitest's timeout.
 */
async function outcome(promise: Promise<unknown>): Promise<unknown> {
  const pending = Symbol('pending');
  const result = await Promise.race([
    promise.then(
      (value) => ({ resolved: value }),
      (error: unknown) => ({ rejected: error }),
    ),
    new Promise((done) => setTimeout(() => done(pending), 20)),
  ]);
  return result === pending ? 'still pending' : result;
}

/**
 * A real `Supervisor` whose first host is `child`, wrapped by the real adapter.
 *
 * `between` runs inside `spawn`, after the adapter has registered its latch and
 * before the supervisor registers its `onClose`. An `'exit'` listener added
 * there runs in the same place a future listener in `main.ts` would.
 */
function supervise(
  child: FakeUtilityProcess,
  between?: (supervisor: () => Supervisor) => void,
): { supervisor: Supervisor; llama: LlamaFacade; clock: ReturnType<typeof heldClock> } {
  const clock = heldClock();
  let spawned = 0;
  const supervisor: Supervisor = new Supervisor({
    spawn: () => {
      spawned += 1;
      const handle = utilityHostHandle(spawned === 1 ? child : new FakeUtilityProcess());
      between?.(() => supervisor);
      return handle;
    },
    notify: () => undefined,
    timers: clock,
  });
  return {
    supervisor,
    llama: supervisor.plugin(LLAMA_PLUGIN.name) as unknown as LlamaFacade,
    clock,
  };
}

describe('the host handle over a utility process', () => {
  it('passes a post to a live process through, untouched', () => {
    const child = new FakeUtilityProcess();
    const handle = utilityHostHandle(child);
    const message = { k: 'ping', id: 1 };
    handle.link.postMessage(message);
    expect(child.posted).toEqual([{ message, phase: 'alive' }]);
  });

  it('refuses a post from inside the exit dispatch, where Electron 44 crashed main', () => {
    // `onClose` is the route the supervisor registers through, so this listener
    // runs where `Supervisor#onClose` does.
    // FAULT INJECTED: deleting the `if (exited) { throw … }` guard from
    // `utilityHostHandle` let the post through with phase "inside the exit
    // dispatch". On Electron 44 that post is a SIGSEGV in the main process.
    const child = new FakeUtilityProcess();
    const handle = utilityHostHandle(child);
    const attempts: string[] = [];
    handle.link.onClose(() => {
      try {
        handle.link.postMessage({ k: 'ping', id: 2 });
        attempts.push('posted');
      } catch (error) {
        attempts.push((error as Error).message);
      }
    });

    child.exit(0);

    expect(child.postsToAnExitedProcess).toEqual([]);
    expect(attempts).toEqual([expect.stringContaining(HOST_EXITED)]);
  });

  it('refuses a post after exit too, rather than dropping it silently', () => {
    const child = new FakeUtilityProcess();
    const handle = utilityHostHandle(child);
    child.exit(1);
    expect(() => handle.link.postMessage({ k: 'ping', id: 3 })).toThrow(HOST_EXITED);
    expect(child.posted).toEqual([]);
  });

  it('reports the exit code to onClose and delivers messages to onMessage', () => {
    const child = new FakeUtilityProcess();
    const handle = utilityHostHandle(child);
    const closed: string[] = [];
    const received: unknown[] = [];
    handle.link.onClose((reason) => closed.push(reason));
    handle.link.onMessage((message) => received.push(message));

    child.emit('message', { k: 'pong', id: 4 });
    child.exit(7);

    expect(received).toEqual([{ k: 'pong', id: 4 }]);
    expect(closed).toEqual(['exit code 7']);
  });

  it('kills a live process, and never one that has exited', () => {
    const child = new FakeUtilityProcess();
    const handle = utilityHostHandle(child);
    handle.kill();
    expect(child.kills).toBe(1);
    child.exit(0);
    handle.kill();
    handle.kill();
    expect(child.kills).toBe(1);
  });
});

describe('a post that does not go settles as HANDLE_LOST, and never hangs', () => {
  it('a call made inside the exit dispatch is refused, settles, and never reaches the process', async () => {
    // Every pending call settles through the refusal, not only through the exit
    // listener that runs after it. The message says which path settled them.
    // FAULT INJECTED: removing the try/catch from `Supervisor#post` made the
    // refusal reject the late call with a bare Error and no `code`, so it was
    // not HANDLE_LOST and the adapter would reload nothing.
    const child = new FakeUtilityProcess();
    let late: Promise<unknown> | undefined;
    const { llama } = supervise(child, (supervisor) => {
      child.once('exit', () => {
        late = (supervisor().plugin(LLAMA_PLUGIN.name) as unknown as LlamaFacade).getCapabilities();
      });
    });
    const early = llama.getCapabilities();
    expect(child.posted).toHaveLength(1);

    expect(() => child.exit(9)).not.toThrow();

    expect(late).toBeDefined();
    expect(await outcome(late as Promise<unknown>)).toMatchObject({
      rejected: { code: HANDLE_LOST, message: expect.stringContaining(HOST_EXITED) },
    });
    expect(await outcome(early)).toMatchObject({ rejected: { code: HANDLE_LOST } });
    expect(child.postsToAnExitedProcess).toEqual([]);
  });

  it('a call to a host whose exit the supervisor never heard settles instead of hanging', async () => {
    // The exit was dispatched before the supervisor listened, so its `onClose`
    // will never fire and the clock is held, so no ping will either. Only the
    // refusal can settle this call.
    // FAULT INJECTED: making the guard `return` instead of `throw` left this
    // call "still pending" forever. So did keeping `Supervisor#post`'s catch
    // but having it only warn instead of calling `#onClose`.
    const child = new FakeUtilityProcess();
    const handle = utilityHostHandle(child);
    child.exit(1);
    const supervisor = new Supervisor({
      spawn: () => handle,
      notify: () => undefined,
      timers: heldClock(),
    });
    const call = (supervisor.plugin(LLAMA_PLUGIN.name) as unknown as LlamaFacade).getCapabilities();

    expect(await outcome(call)).toMatchObject({ rejected: { code: HANDLE_LOST } });
    expect(child.posted).toEqual([]);
  });

  it('a call dropped into a dead process before its exit is dispatched is settled by the exit', async () => {
    // The window the adapter cannot see: the process is gone and Electron has
    // not said so. Measured, a post here is dropped silently and does not
    // crash. The supervisor's own exit wiring is what settles it.
    const child = new FakeUtilityProcess();
    const { llama } = supervise(child);
    child.die();
    const call = llama.getCapabilities();
    expect(child.posted.at(-1)?.phase).toBe('dead, not yet reaped');
    expect(await outcome(call)).toBe('still pending');

    child.exit(0);

    expect(await outcome(call)).toMatchObject({
      rejected: { code: HANDLE_LOST, message: expect.stringContaining('exit code 0') },
    });
    expect(child.postsToAnExitedProcess).toEqual([]);
  });

  it('and if that exit never came, the liveness ping settles it and terminates the process', async () => {
    const child = new FakeUtilityProcess();
    const { llama, clock } = supervise(child);
    child.die();
    const call = llama.getCapabilities();

    clock.advance(DEFAULT_POLICY.pingIntervalMs);
    expect(await outcome(call)).toBe('still pending');
    clock.advance(DEFAULT_POLICY.pingTimeoutMs);

    expect(await outcome(call)).toMatchObject({
      rejected: { code: HANDLE_LOST, message: expect.stringContaining('liveness ping') },
    });
    expect(child.kills).toBe(1);
  });
});

describe('main.ts builds every inference host handle through it', () => {
  // main.ts cannot be imported by a test (protocol and app calls run at module
  // scope), so its wiring is pinned as source text, comments stripped.
  const code = readFileSync(resolve(process.cwd(), 'apps/desktop/src/main.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n');

  it('hands the forked child to utilityHostHandle, in the same turn as the fork', () => {
    // FAULT INJECTED: restoring main.ts's own inline link
    // (`postMessage: (message) => child.postMessage(message)`) around the
    // adapter failed this test and the one below.
    expect(code).toContain("import { utilityHostHandle } from './utility-host.js';");
    const fork = code.indexOf('const child = utilityProcess.fork(');
    const wrap = code.indexOf('return utilityHostHandle(child);');
    expect(fork).toBeGreaterThan(-1);
    expect(wrap).toBeGreaterThan(fork);
    // Nothing between the fork and the handle may listen for exit first.
    expect(code.slice(fork, wrap)).not.toMatch(/\.(on|once|addListener|prependListener)\(\s*'exit'/);
  });

  it('never posts to, kills or listens for the exit of a utility process itself', () => {
    expect(code).not.toMatch(/\.postMessage\(/);
    expect(code).not.toMatch(/child\.kill\(/);
    expect(code).not.toMatch(/'exit'/);
  });

  it('utility-host.ts imports no Electron, so this file drives the real handle', () => {
    const source = readFileSync(resolve(process.cwd(), 'apps/desktop/src/utility-host.ts'), 'utf8');
    const specifiers = [...source.matchAll(/(?:from|import)\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
    expect(specifiers).toEqual(['./bridge/protocol.js']);
    expect(source).toContain("import type { HostHandle } from './bridge/protocol.js';");
  });
});
