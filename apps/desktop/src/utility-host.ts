/**
 * One inference host's `HostHandle`, built over an Electron `UtilityProcess`.
 *
 * It lives outside `main.ts` for the same reason `permissions.ts` does:
 * `main.ts` cannot be imported by a test, and this is logic. It imports no
 * Electron. It is typed against the four `UtilityProcess` members it uses, so
 * `tests/desktop-utility-host.test.ts` drives it over a fake process.
 *
 * WHY IT IS A LATCH AND NOT A TRY/CATCH. Measured with
 * `dev/probe-electron-utility-process` on Electron 44.0.0:
 *
 *   - `UtilityProcess.postMessage` NEVER THROWS for a child that is dead, dying
 *     or gone. Every post returned `undefined`: in the same tick as `kill()`,
 *     after a SIGKILL from outside, in bursts across the exit, and long after
 *     it. A post that does not crash is silently dropped. So a catch here
 *     would catch nothing.
 *   - A post made from INSIDE the child's `'exit'` dispatch kills Electron's
 *     MAIN process with SIGSEGV. There is no exception and no event; the
 *     process is gone. Counted across every run of the probe, it did so in
 *     16 of 16 runs for a child that aborted, 16 of 16 for a child SIGKILLed
 *     from outside, and 15 of 17 after `child.kill()`. A child that called
 *     `process.exit` survived it in 16 of 16.
 *     A post queued out of that dispatch survived every time: from a microtask
 *     or `setImmediate` after `kill()` and after a SIGKILL, and from a timer
 *     after `kill()`, 10 of 10 each.
 *
 * The `'exit'` listeners are exactly where `Supervisor#onClose` runs, and
 * `#onClose` does NOT stop posts by itself. It latches `#closed` first, so a
 * new `#call` is refused. But `#handle` stays live until `#retire`, at the very
 * end, after `#onClose` has delivered each turn's synthesised end through
 * `notify`, synchronously. `releaseRenderer` and `#tick`'s cancel post through
 * `#post`, which checks `#handle` and not `#closed`. So a `notify` listener
 * that called `releaseRenderer` would post from inside the dispatch. Today
 * nothing posts there only because `main.ts`'s `notify` sends to a renderer
 * and calls nothing back, and a native crash is not a failure mode one
 * callback should be able to buy. `tests/desktop-utility-host.test.ts` drives
 * that callback against the real `Supervisor` and shows the post it makes.
 *
 * So the process is marked exited in the FIRST `'exit'` listener, registered
 * here, before any caller can register one. Every post after that throws
 * instead of reaching Electron. `Supervisor#post` already treats a throwing
 * link as a lost host: it runs `#onClose`, which rejects every pending call
 * with `HANDLE_LOST`. A post that would have crashed main, or been dropped
 * into a dead process and left its call waiting, becomes a settled
 * `HANDLE_LOST`.
 */

import type { HostHandle } from './bridge/protocol.js';

/** The slice of Electron's `UtilityProcess` a host handle needs, and nothing else. */
export interface UtilityProcessLike {
  postMessage(message: unknown): void;
  on(event: 'message', listener: (message: unknown) => void): unknown;
  once(event: 'exit', listener: (code: number) => void): unknown;
  kill(): boolean;
}

/** The start of the message a post to an exited host throws with. */
export const HOST_EXITED = 'the inference host has exited';

/**
 * Build the handle the supervisor talks to one forked utility process through.
 *
 * MUST be called in the same synchronous turn as `utilityProcess.fork`, before
 * anything else listens for `'exit'`. EventEmitter runs listeners in the order
 * they were registered, and the latch is only first if it is registered first.
 */
export function utilityHostHandle(child: UtilityProcessLike): HostHandle {
  let exited = false;
  child.once('exit', () => {
    exited = true;
  });

  return {
    link: {
      postMessage: (message) => {
        if (exited) {
          throw new Error(`${HOST_EXITED}; the message was not posted to it.`);
        }
        child.postMessage(message);
      },
      onMessage: (listener) => {
        child.on('message', (message: unknown) => listener(message));
      },
      onClose: (listener) => {
        child.once('exit', (code: number) => listener(`exit code ${code}`));
      },
    },
    // Idempotent and safe after exit, as `HostHandle` requires. The call that
    // matters is the one for a host declared lost while its process is still
    // running: an unanswered ping means wedged, not dead, and a wedged host
    // still holds the GPU its replacement is about to ask for.
    kill: () => {
      if (exited) return;
      child.kill();
    },
  };
}
