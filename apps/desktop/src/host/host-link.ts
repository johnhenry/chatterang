/**
 * Where the inference host's parent link comes from, and the two shapes it
 * arrives in.
 *
 * WHY THIS IS A FILE RATHER THAN SIX LINES IN `entry.ts`. Until A9 the host had
 * exactly one parent — Electron's `utilityProcess` — and `entry.ts` read
 * `process.parentPort` inline and threw if it was missing. Measured before
 * touching anything: `node apps/desktop/build/host.mjs /tmp/models llama` exits
 * 1 with "no parentPort. This entry point only runs inside an Electron
 * utilityProcess." That refusal was the ONLY Electron-shaped thing in the whole
 * host path — no `app.getPath`, no `BrowserWindow`, no `electron` import; the
 * model root already arrives as `argv[2]` precisely so main is the only place
 * that knows where `userData` is.
 *
 * So the headless profile does not need a second entry point, a second bundle
 * or a flag. It needs this one guard to admit the OTHER kind of parent, and to
 * go on refusing everything else.
 *
 * THE TWO SHAPES ARE NOT INTERCHANGEABLE, which is the whole reason this is
 * tested rather than assumed:
 *
 *   Electron utilityProcess   `process.parentPort.on('message', e => …)`
 *                             delivers an EVENT: the payload is `e.data`.
 *   Node child_process.fork   `process.on('message', m => …)`
 *                             delivers the MESSAGE ITSELF.
 *
 * Unwrap the wrong one and every message arrives as `undefined` — a host that
 * boots, answers pings (the supervisor's ping is a `postMessage`, so it never
 * arrives either), and settles nothing. That failure has no type, no exception
 * and no log line; it looks like a wedged engine.
 *
 * WHAT DECIDES, AND WHY IT IS `send` RATHER THAN `on`. Every Node process has
 * `process.on`. Only a process forked WITH AN IPC CHANNEL has `process.send`.
 * Testing `on` would make every plain `node host.mjs` look like a forked child
 * and hang instead of refusing, which is the exact "reads as a working guard
 * and is not one" failure `entry.ts` argues against about the model root.
 *
 * THE REFUSAL IS KEPT. A process with neither parent still throws, still exits
 * 1, and still says what it needed — `tests/server-host-link.test.ts` asserts
 * that by removing the link and watching it fail, and `tests/server.test.ts`
 * runs the real built bundle under plain Node to see the refusal at an exit
 * code rather than in a description of one.
 */

import type { MessageLink } from '../bridge/protocol.js';

/** Electron's utility-process parent port, typed only as much as we use it. */
export interface ParentPort {
  postMessage(message: unknown): void;
  on(event: 'message', listener: (event: { data: unknown }) => void): void;
}

/**
 * The slice of a Node `process` this needs — the fork half.
 *
 * `send` and `disconnect` are both optional because they are both absent in a
 * process that was not forked with an IPC channel, which is the case this file
 * exists to refuse.
 */
export interface HostProcess {
  parentPort?: ParentPort;
  send?: (message: unknown) => unknown;
  on(event: string, listener: (...args: never[]) => void): unknown;
}

/**
 * The link to whoever forked this host, or a refusal.
 *
 * @throws Error naming both accepted parents. A host with no parent has nobody
 *   to answer and nothing to serve; guessing a transport would be the same
 *   mistake as guessing a model root.
 */
export function hostLink(host: HostProcess): MessageLink {
  const port = host.parentPort;
  if (port !== undefined) {
    return {
      postMessage: (message) => port.postMessage(message),
      onMessage: (listener) => port.on('message', (event) => listener(event.data)),
      // The parent port has no close event worth listening to: if main goes
      // away, Electron kills this process with it. `onClose` exists for the
      // OTHER end of this link, in the supervisor, which is where a death
      // matters.
      onClose: () => undefined,
    };
  }

  const send = host.send;
  if (typeof send === 'function') {
    return {
      postMessage: (message) => {
        send.call(host, message);
      },
      onMessage: (listener) => {
        host.on('message', ((message: unknown) => listener(message)) as (
          ...args: never[]
        ) => void);
      },
      /*
       * `disconnect`, and it is NOT the no-op its Electron sibling is.
       *
       * Electron kills a utility process when main exits. Node does not: a
       * `child_process.fork` child outlives its parent quite happily, and an
       * orphaned inference host is one that still holds the GPU, the model
       * file and the port's worth of RAM while nothing can reach it or kill
       * it. `disconnect` is the IPC channel closing, which is what a dead
       * parent looks like from here.
       */
      onClose: (listener) => {
        host.on('disconnect', (() => listener('parent disconnected')) as (
          ...args: never[]
        ) => void);
      },
    };
  }

  throw new Error(
    'inference host: no parent link. This entry point runs inside an Electron utilityProcess ' +
      '(process.parentPort) or as a Node child_process.fork with an IPC channel (process.send), ' +
      'and it was started as neither.',
  );
}
