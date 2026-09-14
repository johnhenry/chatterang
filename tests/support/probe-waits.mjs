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
 * the milliseconds waited, and what the last look saw — a condition still
 * false, a look that threw, or a renderer that did not answer. Those are three
 * different failures, and none of them is a layout finding.
 *
 * Electron-free on purpose, so the test file can import it and prove the
 * messages. `layout-probe.mjs` runs under Electron and cannot be imported.
 *
 * TYPES: `probe-waits.d.mts`. tsconfig has no `allowJs`, so that file is what
 * the typecheck reads; an export added here and not there is invisible to it.
 */

/** A wait that ran out, carrying what it was waiting for. */
export class StageTimeout extends Error {
  constructor({ stage, waitedMs, budgetMs, lastObserved = null, note = null }) {
    super(describeTimeout({ stage, waitedMs, budgetMs, lastObserved, note }));
    this.name = 'StageTimeout';
    this.stage = stage;
    this.waitedMs = Math.round(waitedMs);
    this.budgetMs = Math.round(budgetMs);
    this.lastObserved = lastObserved;
    this.note = note;
  }

  toJSON() {
    return {
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

/** Settle `work`, or reject with a `StageTimeout` once `budgetMs` has passed. */
export async function withDeadline(work, { stage, budgetMs, note = null, now = Date.now }) {
  const started = now();
  let timer;
  const deadline = new Promise((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new StageTimeout({ stage, waitedMs: now() - started, budgetMs, note })),
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
 * throw, and resolves `{ done: true, value }` or `{ done: false, observed }`.
 * A look that throws or does not answer does not end the stage — a renderer
 * busy for twenty seconds on a loaded runner answers the next one — but it is
 * remembered, and the timeout says what the last look saw.
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
  for (;;) {
    const left = budgetMs - (now() - started);
    if (left <= 0) {
      throw new StageTimeout({ stage, waitedMs: now() - started, budgetMs, lastObserved, note });
    }
    try {
      const answer = await check(Math.min(attemptMs, left));
      if (answer.done) return answer.value;
      lastObserved = answer.observed;
    } catch (error) {
      lastObserved =
        error instanceof StageTimeout
          ? `a look did not answer within ${error.budgetMs}ms`
          : `a look threw: ${String(error && error.message ? error.message : error)}`;
    }
    const pause = Math.min(intervalMs, budgetMs - (now() - started));
    if (pause > 0) await new Promise((resolve) => setTimeout(resolve, pause));
  }
}
