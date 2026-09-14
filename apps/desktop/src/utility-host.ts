/**
 * One inference host's `HostHandle`, built over an Electron `UtilityProcess`.
 *
 * It lives outside `main.ts` for the same reason `permissions.ts` does:
 * `main.ts` cannot be imported by a test, and this is logic. It imports no
 * Electron. It is typed against the `UtilityProcess` members it uses, so
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
 *
 * A V8 FATAL ERROR IS THE SAME LOSS, ONE DISPATCH EARLIER. When the child hits
 * a non-continuable V8 error, Electron emits the experimental `'error'` event,
 * `('FatalError', location, report)`, and then `'exit'`. Measured (a failed V8
 * API check in the child; a heap-limit out-of-memory emits no `'error'`):
 *
 *   - `'error'` is a plain `EventEmitter` emit in main. With NO listener it
 *     throws `ERR_UNHANDLED_ERROR` out of Electron's native callback into
 *     main's `uncaughtException`. `main.ts` installs no handler for that, so
 *     Electron's default one shows a modal error box, and main's JavaScript
 *     is blocked inside it until the box is closed. While it is up the
 *     `'exit'` is not delivered, so the supervisor does not hear the host is
 *     gone: in three runs killed 15 to 20 s in, it never was; in two where
 *     the box was closed, it was delivered afterwards.
 *   - With main not blocked, `'exit'` followed `'error'` within 3 ms in every
 *     run. No run saw the other order, but Electron's source does not rule it
 *     out (see the listener below).
 *   - A post and a `kill()` made from inside the `'error'` dispatch both
 *     survived, 11 of 11 each. See the probe README.
 *
 * So the adapter listens for `'error'` itself, first, with `on` and not
 * `once`, so no emit can find it gone. It marks the process exited, the same
 * latch `'exit'` sets, so no post reaches Electron from then on, and it reports
 * the close to every `onClose` listener at once, so pending calls settle as
 * `HANDLE_LOST` even if the `'exit'` never comes. Each listener is told once:
 * the `'exit'` that follows is the same loss, not a second one.
 *
 * It reads none of the event's arguments. The report is a Node diagnostic
 * report of the child: its environment variables, working directory, command
 * line (with the model directory) and stacks. None of it is kept, logged, or
 * put in the close reason, which becomes a message renderers are shown.
 *
 * A fatal error does NOT stop `kill`. Until `'exit'` is dispatched there may
 * be a process to terminate, and `#retire` kills the host it gives up on, in
 * this same dispatch, so that a replacement never runs beside a host that
 * reported its end and did not reach it.
 */

import type { HostHandle } from './bridge/protocol.js';

/** The slice of Electron's `UtilityProcess` a host handle needs, and nothing else. */
export interface UtilityProcessLike {
  postMessage(message: unknown): void;
  on(event: 'message', listener: (message: unknown) => void): unknown;
  on(event: 'error', listener: (type: string, location: string, report: string) => void): unknown;
  once(event: 'exit', listener: (code: number) => void): unknown;
  kill(): boolean;
}

/** The start of the message a post to an exited host throws with. */
export const HOST_EXITED = 'the inference host has exited';

/** The close reason for a host whose process reported a V8 fatal error. */
const FATAL_ERROR = 'fatal V8 error';

/**
 * Build the handle the supervisor talks to one forked utility process through.
 *
 * MUST be called in the same synchronous turn as `utilityProcess.fork`, before
 * anything else listens for `'exit'` or `'error'`. EventEmitter runs listeners
 * in the order they were registered, and the latch is only first if it is
 * registered first.
 */
export function utilityHostHandle(child: UtilityProcessLike): HostHandle {
  // Set by the fatal error or the exit, whichever is dispatched first. No post
  // reaches Electron once it is set.
  let exited = false;
  // Set by the exit alone. Until then there may still be a process to kill.
  let reaped = false;
  const fatalListeners: Array<(reason: string) => void> = [];

  // Never removed, and not `once`. An `'error'` that finds no listener throws
  // into main, and one can come after `'exit'` as well as before it: Electron
  // 44's `OnV8FatalError` does not check whether the process has terminated,
  // and `ForkUtilityProcess#emit` still forwards `'error'` after its `'exit'`.
  child.on('error', () => {
    exited = true;
    for (const tell of [...fatalListeners]) tell(FATAL_ERROR);
  });
  child.once('exit', () => {
    exited = true;
    reaped = true;
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
        let told = false;
        const tell = (reason: string): void => {
          if (told) return;
          told = true;
          listener(reason);
        };
        fatalListeners.push(tell);
        child.once('exit', (code: number) => tell(`exit code ${code}`));
      },
    },
    // Idempotent and safe after exit, as `HostHandle` requires. The call that
    // matters is the one for a host declared lost while its process is still
    // running: an unanswered ping means wedged, not dead, and a wedged host
    // still holds the GPU its replacement is about to ask for. A host that
    // reported a fatal error is in the same position until its exit arrives.
    kill: () => {
      if (reaped) return;
      child.kill();
    },
  };
}
