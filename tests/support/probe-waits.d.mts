/**
 * Types for `probe-waits.mjs`, which is plain JavaScript because the layout
 * probe runs under Electron with no transform. tsconfig has no `allowJs`, so
 * THIS is what the typecheck reads: keep it in step with the module.
 */

/**
 * `unanswered`: the renderer did not answer (a harness timeout).
 * `unmet`: the renderer answered and the condition stayed false (a real failure).
 */
export type StageTimeoutKind = 'unanswered' | 'unmet';

export interface StageTimeoutDetails {
  readonly kind: StageTimeoutKind;
  readonly stage: string;
  readonly waitedMs: number;
  readonly budgetMs: number;
  readonly lastObserved: string | null;
  readonly note: string | null;
}

export interface StageTimeoutInit {
  readonly stage: string;
  readonly waitedMs: number;
  readonly budgetMs: number;
  readonly lastObserved?: string | null;
  readonly note?: string | null;
  readonly kind?: StageTimeoutKind;
}

export declare class StageTimeout extends Error implements StageTimeoutDetails {
  constructor(init: StageTimeoutInit);
  readonly kind: StageTimeoutKind;
  readonly stage: string;
  readonly waitedMs: number;
  readonly budgetMs: number;
  readonly lastObserved: string | null;
  readonly note: string | null;
  toJSON(): StageTimeoutDetails;
}

export declare function describeTimeout(init: StageTimeoutInit): string;

export declare function probeFailureMessage(result: {
  readonly error?: string;
  readonly failure?: StageTimeoutDetails | null;
}): string;

export interface Budget {
  readonly totalMs: number;
  elapsed(): number;
  remaining(): number;
  cap(stageMs: number): { readonly ms: number; readonly note: string | null };
}

export declare function createBudget(totalMs: number, now?: () => number): Budget;

export declare function withDeadline<T>(
  work: Promise<T>,
  options: {
    readonly stage: string;
    readonly budgetMs: number;
    readonly note?: string | null;
    readonly now?: () => number;
  },
): Promise<T>;

export type LookAnswer<T> =
  | { readonly done: true; readonly value: T }
  | { readonly done: false; readonly observed: string };

export declare function pollUntil<T>(options: {
  readonly stage: string;
  readonly budgetMs: number;
  readonly check: (attemptMs: number) => Promise<LookAnswer<T>>;
  readonly attemptMs?: number;
  readonly intervalMs?: number;
  readonly note?: string | null;
  readonly now?: () => number;
}): Promise<T>;
