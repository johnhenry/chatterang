/**
 * How long a test waits on a step that must happen before it fails naming it.
 *
 * A BOUND ON A HANG, NEVER A WINDOW FOR A RACE. Every step handed to `stage` is
 * one the code under test must reach: a put that must start, a store change
 * that must come, a write that must settle, a turn that must end. A loaded
 * runner only makes such a step later, so the bound decides nothing but what a
 * hang is reported as. Nothing that asserts something does NOT happen may use
 * it — that is settled by awaiting the thing that would have done it.
 *
 * Under vitest's 5s default test timeout (vite.config.ts sets none), so a step
 * that never comes fails with its name and this duration rather than a bare
 * timeout at `it(`. Raise it with the test timeout, never past it.
 */
export const STAGE_MS = 4000;

/** `step`, or a failure saying what never happened, after `ms`. The timer is cleared either way. */
export async function stage<T>(what: string, step: Promise<T>, ms: number = STAGE_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      step,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`waited ${ms}ms for ${what}`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
