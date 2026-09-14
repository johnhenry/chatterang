/**
 * DEADLINES THAT SAY WHERE THEY WERE, AND HOW LONG THEY WAITED.
 *
 * WHY THIS FILE EXISTS. On a GitHub-hosted runner (run 34872871078) every
 * engine test in `tests/layout-engine.test.ts` failed at once with "timed out
 * evaluating the engine to settle at 390px". The same commit passed on a
 * re-run, and passes every time on a laptop, where that wait takes about 17ms.
 * The wait was ONE evaluation of two animation frames under a flat 15s
 * deadline: a renderer starved for longer than that by a loaded runner was
 * reported exactly like a renderer that would never answer, and the message
 * said neither how long it had waited nor what it had last seen.
 *
 * So a wait here is a CONDITION with a budget, not a guess about time: it
 * returns the moment the condition holds, a look that runs out is retried
 * rather than fatal, and when the budget is spent the error names the stage,
 * the milliseconds waited, and what the last look saw.
 *
 * THREE DIFFERENT FAILURES, AND ONLY ONE OF THEM IS THE RUNNER'S FAULT:
 *
 *   - `unanswered` — the renderer did not answer: a look ran out, or no look
 *     had answered when the budget was spent. A starved or hung renderer. This
 *     is the harness timeout, and it says nothing about the layout.
 *   - `unmet` — the renderer answered, and the condition was false. Sixty
 *     seconds of a responsive page that never reached the state is the page
 *     (or the probe's own step) being wrong, not the runner being slow, and it
 *     must not be excused as a timeout.
 *   - a look that THREW — a script error is deterministic, so it fails the
 *     stage at once, naming the stage, instead of being retried for the whole
 *     budget and then reported as a timeout.
 *
 * Electron-free on purpose, so the test file can import it and prove the
 * messages. `layout-probe.mjs` runs under Electron and cannot be imported.
 *
 * TYPES: `probe-waits.d.mts`. tsconfig has no `allowJs`, so that file is what
 * the typecheck reads; an export added here and not there is invisible to it.
 */

/** A wait that ran out, carrying what it was waiting for. */
export class StageTimeout extends Error {
  constructor({ stage, waitedMs, budgetMs, lastObserved = null, note = null, kind = 'unanswered' }) {
    super(describeTimeout({ stage, waitedMs, budgetMs, lastObserved, note }));
    this.name = 'StageTimeout';
    this.kind = kind;
    this.stage = stage;
    this.waitedMs = Math.round(waitedMs);
    this.budgetMs = Math.round(budgetMs);
    this.lastObserved = lastObserved;
    this.note = note;
  }

  toJSON() {
    return {
      kind: this.kind,
      stage: this.stage,
      waitedMs: this.waitedMs,
      budgetMs: this.budgetMs,
      lastObserved: this.lastObserved,
      note: this.note,
    };
  }
}

/**
 * `timed out <stage> after <n>ms (budget <n>ms)[, <note>][; last observed: <what>]`
 *
 * `stage` reads as the continuation of "timed out": "waiting for the app
 * shell to mount", "evaluating the sheet box", "loading http://…".
 */
export function describeTimeout({ stage, waitedMs, budgetMs, lastObserved = null, note = null }) {
  let message = `timed out ${stage} after ${Math.round(waitedMs)}ms (budget ${Math.round(budgetMs)}ms)`;
  if (note) message += `, ${note}`;
  if (lastObserved) message += `; last observed: ${lastObserved}`;
  return message;
}

/**
 * The line every engine test fails with when the probe did not finish.
 *
 * Decided by WHAT the last look saw, not by the fact that a wait ended: only a
 * renderer that did not answer is a harness timeout. A condition that stayed
 * false while the renderer answered is a real failure and says so, and any
 * other error is reported as the probe failing, as it always was.
 */
export function probeFailureMessage({ error, failure }) {
  if (failure === undefined || failure === null) return `the layout probe failed: ${error}`;
  const line = String(error ?? '').split('\n')[0];
  if (failure.kind === 'unmet') {
    return (
      'the layout probe stopped at a step that never came true while the renderer kept ' +
      `answering (a real failure in the page or the probe, not a slow runner): ${line}`
    );
  }
  return (
    'the layout probe ran out of time on a renderer that did not answer, so nothing in this ' +
    `file was measured (a harness timeout, not a layout finding): ${line}`
  );
}

/**
 * The probe's overall budget.
 *
 * A stage asks for its own budget and is given the smaller of that and what
 * is left, with a note when the overall budget is what cut it short. A probe
 * that is slow EVERYWHERE then fails at the stage it had reached, saying so,
 * rather than being killed from outside with nothing written.
 */
export function createBudget(totalMs, now = Date.now) {
  const startedAt = now();
  const elapsed = () => now() - startedAt;
  const remaining = () => Math.max(0, totalMs - elapsed());
  return {
    totalMs,
    elapsed,
    remaining,
    cap(stageMs) {
      const left = remaining();
      if (left >= stageMs) return { ms: stageMs, note: null };
      return {
        ms: left,
        note: `cut short by the probe's ${totalMs}ms overall budget, ${Math.round(elapsed())}ms in`,
      };
    },
  };
}

/**
 * Settle `work`, or reject with an `unanswered` `StageTimeout` once `budgetMs`
 * has passed. `work` is not cancelled — nothing can cancel an evaluation the
 * renderer has queued — only no longer waited for.
 */
export async function withDeadline(work, { stage, budgetMs, note = null, now = Date.now }) {
  const started = now();
  let timer;
  const deadline = new Promise((_resolve, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new StageTimeout({ stage, waitedMs: now() - started, budgetMs, note, kind: 'unanswered' }),
        ),
      budgetMs,
    );
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Ask `check` until it answers done, within `budgetMs`.
 *
 * `check(attemptMs)` is ONE look, which must answer within `attemptMs` or
 * throw a `StageTimeout`, and resolves `{ done: true, value }` or
 * `{ done: false, observed }`. A look that does not answer does not end the
 * stage — a renderer busy for twenty seconds on a loaded runner answers the
 * next one — but it is remembered, and the timeout says what the last look saw
 * and is `unanswered` or `unmet` according to it. A look that throws anything
 * else fails the stage at once: a script error does not get better by waiting.
 */
export async function pollUntil({
  stage,
  budgetMs,
  check,
  attemptMs = budgetMs,
  intervalMs = 100,
  note = null,
  now = Date.now,
}) {
  const started = now();
  let lastObserved = 'no look had answered yet';
  let kind = 'unanswered';
  for (;;) {
    const left = budgetMs - (now() - started);
    if (left <= 0) {
      throw new StageTimeout({ stage, waitedMs: now() - started, budgetMs, lastObserved, note, kind });
    }
    try {
      const answer = await check(Math.min(attemptMs, left));
      if (answer.done) return answer.value;
      lastObserved = answer.observed;
      kind = 'unmet';
    } catch (error) {
      if (!(error instanceof StageTimeout)) {
        const reason = String(error && error.message ? error.message : error);
        throw new Error(
          `${stage} failed after ${Math.round(now() - started)}ms: a look threw: ${reason}`,
          { cause: error },
        );
      }
      lastObserved = `a look did not answer within ${error.budgetMs}ms`;
      kind = 'unanswered';
    }
    const pause = Math.min(intervalMs, budgetMs - (now() - started));
    if (pause > 0) await new Promise((resolve) => setTimeout(resolve, pause));
  }
}
