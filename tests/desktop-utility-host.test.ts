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
 *     process with SIGSEGV;
 *   - a V8 fatal error in the child reaches main as the experimental `'error'`
 *     event, `('FatalError', location, report)`, emitted through
 *     `EventEmitter#emit`, and `'exit'` follows it. With no listener that emit
 *     throws `ERR_UNHANDLED_ERROR` out of Electron's native callback and into
 *     main's `uncaughtException`.
 *
 * A fake cannot segfault. So it records the phase each post arrived in, and
 * the tests assert that no post ever arrives inside the error or exit dispatch
 * or after either. That is the post that would have taken the whole app down.
 */

import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { DEFAULT_POLICY, HANDLE_LOST, LLAMA_PLUGIN, Supervisor } from '@chatterang/desktop/bridge';
import type { SupervisorTimers } from '@chatterang/desktop/bridge';
import { HOST_EXITED, utilityHostHandle } from '@chatterang/desktop/utility-host';

type Phase =
  | 'alive'
  | 'dead, not yet reaped'
  | 'inside the error dispatch'
  | 'fatal, exit not yet dispatched'
  | 'inside the exit dispatch'
  | 'after exit';

/**
 * What a `FatalError`'s third argument carries: a Node diagnostic report, with
 * the child's environment, working directory and command line. This stands in
 * for the private part of it. It must never reach a message the supervisor
 * hands to a renderer.
 */
const REPORT_SECRET = '/Users/someone/Library/Application Support/Chatterang/models';
const FATAL_REPORT = JSON.stringify({ header: { cwd: REPORT_SECRET, commandLine: ['host.mjs', REPORT_SECRET] } });

interface Post {
  readonly message: unknown;
  readonly phase: Phase;
}

/** An Electron `UtilityProcess`, as measured. */
class FakeUtilityProcess extends EventEmitter {
  readonly posted: Post[] = [];
  kills = 0;
  #phase: Phase = 'alive';
  #exitDispatched = false;

  /** Where in its life the process is, as a post arriving now would find it. */
  get phase(): Phase {
    return this.#phase;
  }

  postMessage(message: unknown): void {
    // Never throws, in any phase. Measured: every post returned undefined.
    this.posted.push({ message, phase: this.#phase });
  }

  kill(): boolean {
    this.kills += 1;
    // Measured: true for a live child and from inside the 'error' dispatch,
    // false from inside the exit dispatch and after it.
    return !this.#exitDispatched;
  }

  /** The process is gone, but Electron has not dispatched `'exit'` yet. */
  die(): void {
    if (this.#phase === 'alive') this.#phase = 'dead, not yet reaped';
  }

  /**
   * The child hit a non-continuable V8 error and is about to crash.
   *
   * Emitted the way Electron 44 emits it: `UtilityProcessWrapper::OnV8FatalError`
   * calls `EmitWithoutEvent("error", "FatalError", location, report)`, and
   * `ForkUtilityProcess` forwards that to `EventEmitter#emit`. So this is a
   * real `'error'` emit, and with no listener it throws, as Electron's does.
   * `'exit'` is a separate dispatch, which a test calls `exit` for. Measured,
   * it follows; Electron's source does not rule out the other order.
   */
  fatal(): void {
    this.#phase = 'inside the error dispatch';
    try {
      this.emit('error', 'FatalError', 'v8::ToLocalChecked Empty MaybeLocal', FATAL_REPORT);
    } finally {
      this.#phase = this.#exitDispatched ? 'after exit' : 'fatal, exit not yet dispatched';
    }
  }

  /** Electron dispatches `'exit'` to every listener, in registration order. */
  exit(code: number): void {
    this.#exitDispatched = true;
    this.#phase = 'inside the exit dispatch';
    this.emit('exit', code);
    this.#phase = 'after exit';
  }

  /** Posts that reached the process once its fatal error or its exit had been dispatched. */
  get postsToAnExitedProcess(): Post[] {
    return this.posted.filter(
      (post) => post.phase !== 'alive' && post.phase !== 'dead, not yet reaped',
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
): {
  supervisor: Supervisor;
  llama: LlamaFacade;
  clock: ReturnType<typeof heldClock>;
  /** Every process the supervisor has spawned, `child` first. */
  spawned: FakeUtilityProcess[];
} {
  const clock = heldClock();
  const spawned: FakeUtilityProcess[] = [];
  const supervisor: Supervisor = new Supervisor({
    spawn: () => {
      const next = spawned.length === 0 ? child : new FakeUtilityProcess();
      spawned.push(next);
      const handle = utilityHostHandle(next);
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
    spawned,
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

  it('a notify listener that releases its renderer inside the close posts nothing into the process', async () => {
    // `#onClose` latches `#closed` first but drops `#handle` last, in `#retire`,
    // after it has delivered each turn's synthesised `llamaEnd` through
    // `notify`. A listener that answers that end by releasing its renderer
    // therefore posts a `cancel` through a handle that is still live, from
    // inside the exit dispatch. Nothing in main.ts does this today; this is the
    // one callback away the adapter's latch exists for.
    // If `#onClose` is ever changed to drop `#handle` before it notifies, the
    // first expectation below stops holding, and so does the comment in
    // utility-host.ts that describes this window.
    // FAULT INJECTED: deleting the adapter's `if (exited) { throw … }` guard let
    // the cancel reach the process with phase "inside the exit dispatch".
    const child = new FakeUtilityProcess();
    const attempts: Post[] = [];
    const supervisor: Supervisor = new Supervisor({
      spawn: () => {
        const handle = utilityHostHandle(child);
        return {
          ...handle,
          link: {
            ...handle.link,
            postMessage: (message) => {
              attempts.push({ message, phase: child.phase });
              handle.link.postMessage(message);
            },
          },
        };
      },
      notify: (_plugin, eventName, _data, ownerId) => {
        if (eventName === 'llamaEnd' && ownerId !== undefined) {
          supervisor.releaseRenderer(ownerId, 'the window closed when its turn ended');
        }
      },
      timers: heldClock(),
    });
    const llama = supervisor.plugin(LLAMA_PLUGIN.name) as unknown as LlamaFacade;
    const turn = llama.generate(1, { handle: 'h', prompt: 'p', requestId: 'r1' });
    expect(child.posted.map((post) => post.phase)).toEqual(['alive']);

    expect(() => child.exit(0)).not.toThrow();

    const insideTheDispatch = attempts
      .filter((attempt) => attempt.phase === 'inside the exit dispatch')
      .map((attempt) => (attempt.message as { method?: string }).method);
    expect(insideTheDispatch).toEqual(['cancel']);
    expect(child.postsToAnExitedProcess).toEqual([]);
    // Released before `#onClose` reached its own rejections, so it settles as
    // the release said, not as HANDLE_LOST. What matters is that it settles.
    expect(await outcome(turn)).toMatchObject({ rejected: { code: 'RENDERER_GONE' } });
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

describe("a V8 fatal error (UtilityProcess 'error') is a lost host, and nothing escapes into main", () => {
  it('Electron emits it through EventEmitter, so a process nobody listens to throws', () => {
    // The premise, with no adapter: this is the throw that, in Electron, leaves
    // the native callback and reaches main's `uncaughtException`, where
    // Electron's default handler shows a modal error box.
    // dev/probe-electron-utility-process measures the real one.
    const child = new FakeUtilityProcess();
    let thrown: unknown;
    try {
      child.fatal();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ code: 'ERR_UNHANDLED_ERROR', message: expect.stringContaining('FatalError') });
    expect((thrown as Error).message).not.toContain(REPORT_SECRET);
  });

  it('the adapter latches on it: onClose fires once, and posts are refused from inside its dispatch and after', () => {
    // FAULT INJECTED: without the adapter's 'error' listener `child.fatal()`
    // threw ERR_UNHANDLED_ERROR. With a listener that reported the close but did
    // not latch, the post from inside the close reached the process. With
    // `once('error')` the second emit threw again. With each listener told
    // again, the exit added a second close. With `kill` guarded by the fatal
    // latch instead of the exit, the host that reported the error was never
    // terminated.
    const child = new FakeUtilityProcess();
    const handle = utilityHostHandle(child);
    const closed: string[] = [];
    const attempts: string[] = [];
    handle.link.onClose((reason) => {
      closed.push(reason);
      try {
        handle.link.postMessage({ k: 'ping', id: 5 });
        attempts.push('posted');
      } catch (error) {
        attempts.push((error as Error).message);
      }
    });

    expect(() => child.fatal()).not.toThrow();
    expect(closed).toEqual(['fatal V8 error']);
    expect(attempts).toEqual([expect.stringContaining(HOST_EXITED)]);
    expect(() => handle.link.postMessage({ k: 'ping', id: 6 })).toThrow(HOST_EXITED);

    // Until its exit there may be a process left to terminate.
    handle.kill();
    expect(child.kills).toBe(1);

    // A second emit must not find the listener gone, and the exit that follows
    // is the same loss, not a second one.
    expect(() => child.fatal()).not.toThrow();
    expect(() => child.exit(11)).not.toThrow();
    expect(closed).toEqual(['fatal V8 error']);
    expect(child.posted).toEqual([]);
    handle.kill();
    expect(child.kills).toBe(1);
  });

  const endings = [
    {
      name: "'error' then 'exit'",
      end: (child: FakeUtilityProcess) => {
        child.fatal();
        child.exit(11);
      },
      reason: 'fatal V8 error',
      // `#retire` terminates the host inside the 'error' dispatch; the exit
      // then adds no second kill.
      kills: 1,
    },
    { name: "'error' alone", end: (child: FakeUtilityProcess) => child.fatal(), reason: 'fatal V8 error', kills: 1 },
    { name: "'exit' alone", end: (child: FakeUtilityProcess) => child.exit(0), reason: 'exit code 0', kills: 0 },
    {
      // Not measured, and not ruled out: Electron's `OnV8FatalError` emits
      // without checking whether the process has already terminated, and its
      // JavaScript wrapper forwards 'error' whatever came before. The listener
      // must still be there, and the exit has already reported the loss.
      name: "'exit' then 'error'",
      end: (child: FakeUtilityProcess) => {
        child.exit(0);
        child.fatal();
      },
      reason: 'exit code 0',
      kills: 0,
    },
  ];

  it.each(endings)(
    '$name: nothing throws, every pending call settles as HANDLE_LOST, and nothing more is posted',
    async ({ end, reason, kills }) => {
      // The clock is held, so no ping and no deadline can settle these calls.
      // Only the adapter reporting the loss can. With 'error' alone that is the
      // only report there will be.
      // FAULT INJECTED: a listener that latched but did not report the close
      // left the calls "still pending" for 'error' alone, and let them be
      // settled by the exit, not the fatal error, for 'error' then 'exit'.
      // Removing the listener made the ending itself throw ERR_UNHANDLED_ERROR.
      // Removing it once 'exit' had fired made 'exit' then 'error' throw it,
      // and no other test noticed.
      const child = new FakeUtilityProcess();
      const { llama } = supervise(child);
      const capabilities = llama.getCapabilities();
      const turn = llama.generate(1, { handle: 'h', prompt: 'p', requestId: 'r1' });
      expect(child.posted.map((post) => post.phase)).toEqual(['alive', 'alive']);

      expect(() => end(child)).not.toThrow();

      for (const call of [capabilities, turn]) {
        const settled = await outcome(call);
        expect(settled).toMatchObject({
          rejected: { code: HANDLE_LOST, message: expect.stringContaining(reason) },
        });
        expect((settled as { rejected: Error }).rejected.message).not.toContain(REPORT_SECRET);
      }
      expect(await outcome(llama.getCapabilities())).toMatchObject({ rejected: { code: HANDLE_LOST } });
      expect(child.postsToAnExitedProcess).toEqual([]);
      expect(child.posted).toHaveLength(2);
      expect(child.kills).toBe(kills);
    },
  );

  it('a notify listener that releases its renderer inside the fatal error posts nothing into the process', async () => {
    // The same one-callback-away post as the exit case above, from inside the
    // 'error' dispatch instead.
    const child = new FakeUtilityProcess();
    const attempts: Post[] = [];
    const supervisor: Supervisor = new Supervisor({
      spawn: () => {
        const handle = utilityHostHandle(child);
        return {
          ...handle,
          link: {
            ...handle.link,
            postMessage: (message) => {
              attempts.push({ message, phase: child.phase });
              handle.link.postMessage(message);
            },
          },
        };
      },
      notify: (_plugin, eventName, _data, ownerId) => {
        if (eventName === 'llamaEnd' && ownerId !== undefined) {
          supervisor.releaseRenderer(ownerId, 'the window closed when its turn ended');
        }
      },
      timers: heldClock(),
    });
    const llama = supervisor.plugin(LLAMA_PLUGIN.name) as unknown as LlamaFacade;
    const turn = llama.generate(1, { handle: 'h', prompt: 'p', requestId: 'r1' });

    expect(() => child.fatal()).not.toThrow();

    const insideTheDispatch = attempts
      .filter((attempt) => attempt.phase === 'inside the error dispatch')
      .map((attempt) => (attempt.message as { method?: string }).method);
    expect(insideTheDispatch).toEqual(['cancel']);
    expect(child.postsToAnExitedProcess).toEqual([]);
    expect(await outcome(turn)).toMatchObject({ rejected: { code: 'RENDERER_GONE' } });
    expect(() => child.exit(11)).not.toThrow();
  });

  it('the fatal error and its exit are one loss: one replacement, which the late exit does not close', async () => {
    const child = new FakeUtilityProcess();
    const { llama, clock, spawned } = supervise(child);
    child.fatal();
    clock.advance(DEFAULT_POLICY.restartDelayMs);
    expect(spawned).toHaveLength(2);

    // Electron's exit for the first process arrives after its replacement is up.
    expect(() => child.exit(11)).not.toThrow();
    clock.advance(DEFAULT_POLICY.restartDelayMs);
    expect(spawned).toHaveLength(2);

    const replacement = spawned[1] as FakeUtilityProcess;
    const call = llama.getCapabilities();
    expect(replacement.posted.map((post) => post.phase)).toContain('alive');
    expect(await outcome(call)).toBe('still pending');
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
    // Nothing between the fork and the handle may listen for exit or for a
    // fatal error first: the adapter's latch is only first if it is registered
    // first.
    // Any quote style: nothing in the repo enforces one.
    expect(code.slice(fork, wrap)).not.toMatch(
      /\.(on|once|addListener|prependListener)\(\s*['"\x60](exit|error)['"\x60]/,
    );
  });

  it('never posts to, kills, or listens for the exit or fatal error of a utility process itself', () => {
    // FAULT INJECTED (see the commit): adding
    // `child.on('error', () => undefined);` after the fork failed this test and
    // the one above. So did the same listener in double quotes or backticks,
    // and `child.once("exit", () => undefined);`. When these matched single
    // quotes only, the double-quoted listener passed both. A listener there runs
    // before the adapter's latch, so anything it posted would reach Electron.
    expect(code).not.toMatch(/\.postMessage\(/);
    expect(code).not.toMatch(/child\.kill\(/);
    expect(code).not.toMatch(/['"\x60]exit['"\x60]/);
    expect(code).not.toMatch(/['"\x60]error['"\x60]/);
  });

  it('utility-host.ts imports no Electron, so this file drives the real handle', () => {
    const source = readFileSync(resolve(process.cwd(), 'apps/desktop/src/utility-host.ts'), 'utf8');
    const specifiers = [...source.matchAll(/(?:from|import)\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
    expect(specifiers).toEqual(['./bridge/protocol.js']);
    expect(source).toContain("import type { HostHandle } from './bridge/protocol.js';");
  });
});
