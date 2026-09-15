/**
 * The machine's sleep and wake, handed to the work broker (#7 ruling 7).
 *
 * THE RULING: no keep-awake. When the machine suspends, stop admitting and
 * settle running work with a defined reason; when it wakes, admit again.
 * `WorkBroker.suspend()` and `resume()` are that ruling (see `work-broker.ts`).
 * This file is only the join from the platform's power events to them. It
 * covers the desktop's own turns as well as a paired phone's, because both are
 * units in the one broker: a local turn decoding when the lid closes ends
 * `HOST_SUSPENDED`, and its window is told why (`local-turns.ts`).
 *
 * NOTHING HERE KEEPS THE MACHINE AWAKE, and nothing may. A sleep ends work; it
 * is never postponed for it. `tests/desktop-security.test.ts` pins that
 * `main.ts` names no `powerSaveBlocker`.
 *
 * WHAT THIS DOES NOT DO: notice a sleep that arrives without a suspend event.
 * The broker checks each deadline against its clock where the deadline is
 * used, which bounds what a missed event can cost; telling a sleep apart from
 * a stall by the clock alone is not this file's job.
 *
 * Repeats are the broker's to ignore: a second 'suspend' changes nothing, and a
 * 'resume' with no 'suspend' before it changes nothing (`resume()` only leaves
 * the suspended state).
 *
 * PLATFORM-FREE, like the rest of the bridge (`tests/layering.test.ts`). The
 * source is structural: Electron's `powerMonitor` satisfies it, and `main.ts`
 * passes it from inside `start()`, which runs after `app.whenReady()`.
 */

import type { WorkBroker } from './work-broker.js';

/** The two power events the broker acts on. */
export type PowerEvent = 'suspend' | 'resume';

/** Where power events come from. Electron's `powerMonitor` in `main.ts`. */
export interface PowerEventSource {
  on(event: PowerEvent, listener: () => void): void;
  removeListener(event: PowerEvent, listener: () => void): void;
}

/**
 * Send the source's 'suspend' to `broker.suspend()` and its 'resume' to
 * `broker.resume()`.
 *
 * @returns a function that removes exactly the two listeners this added.
 */
export function wirePowerEvents(
  source: PowerEventSource,
  broker: Pick<WorkBroker, 'suspend' | 'resume'>,
): () => void {
  const onSuspend = (): void => broker.suspend();
  const onResume = (): void => broker.resume();
  source.on('suspend', onSuspend);
  source.on('resume', onResume);
  return () => {
    source.removeListener('suspend', onSuspend);
    source.removeListener('resume', onResume);
  };
}
