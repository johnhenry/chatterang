/**
 * Saying that a turn was degraded, once, in a way something reads.
 *
 * `IRMetadata.warnings` has existed all along and this app has never read it
 * (#149). Worse, its one writer — `src/ai/middleware/resilience.ts` — sits
 * inside middleware that early-returns on every streamed request, and every
 * chat turn streams. So the channel had a writer that never ran and a reader
 * that did not exist, which is indistinguishable from not having a channel.
 *
 * That mattered once three separate rulings needed somewhere to report a
 * degraded turn: #142 (a quarantined inbound value), #148 (a `done.message`
 * mismatch, which must read as a *transport* failure rather than a model one)
 * and #186 (four tunnel transport classifications). Three bespoke routes is
 * how `delta`, `accumulated` and `done.message` became three channels for one
 * fact — the defect #148 exists to fix. So: one channel, adopted properly.
 *
 * ## Why a projection rather than `IRWarning[]` itself
 *
 * `IRWarning` is defined upstream in `@johnhenry/aimatey-types`. Persisting it
 * verbatim puts a shape this repo does not own into the database, where an
 * upstream change becomes a migration. {@link TurnWarning} is ours, the
 * mapping is one function, and the fields it drops — `originalValue`,
 * `transformedValue`, `field` — are about parameter translation, which is not
 * what a user is ever shown.
 */

import type { IRWarning } from '@johnhenry/aimatey-types';

import type { FallbackReason } from '@/ai/middleware/resilience';
import { describeFallback } from '@/ai/middleware/resilience';
import type { TurnWarning } from '@/domain/chat';

/*
 * `TurnWarning` MOVED TO `domain/` IN #259, and re-exported here so every
 * existing import keeps working. The move is the fix, not housekeeping:
 * `Provenance` has to carry these to persist them, `Provenance` lives in
 * `domain/`, and `tests/layering.test.ts` forbids `domain/` importing `@/ai`.
 * While the type lived here there was no legal way for a persisted record to
 * hold one — the warnings channel could not reach the database because of
 * where its type was declared.
 */
export type { TurnWarning };

/** Narrow an upstream `IRWarning` to the projection this app persists. */
export function projectWarning(warning: IRWarning): TurnWarning {
  return {
    category: warning.category,
    severity: warning.severity,
    message: warning.message,
    ...(warning.source === undefined ? {} : { source: warning.source }),
  };
}

/**
 * The warnings on a response, if it carried any.
 *
 * Tolerates the field being absent, which is the common case: most backends
 * never set it.
 */
export function warningsOf(warnings: readonly IRWarning[] | undefined): TurnWarning[] {
  return (warnings ?? []).map(projectWarning);
}

/**
 * The warning for a turn the Router diverted to another backend.
 *
 * The streaming path never reaches the resilience middleware, so it produces
 * its own `FallbackEvent` and the middleware's warning is never written. Both
 * paths now describe the divert the same way by coming through here, rather
 * than one saying it in `metadata.warnings` and the other in an event nobody
 * converts — which was the same one-fact-two-channels shape all over again.
 *
 * `model-substituted` rather than `capability-unsupported`: every
 * `FallbackReason` ends with a different model serving the turn, which is what
 * that member means. The upstream docs are explicit that reaching for
 * `capability-unsupported` to describe "a fallback forced by device pressure
 * rather than by a missing capability" is how a category stops carrying
 * information — and device pressure is exactly what `thermal` and `memory`
 * are.
 */
export function fallbackWarning(reason: FallbackReason, from: string): TurnWarning | null {
  if (reason === 'none') return null;
  return {
    category: 'model-substituted',
    severity: 'warning',
    message: describeFallback(reason),
    source: from,
  };
}

/**
 * Merge warning lists without repeating an identical one.
 *
 * A turn can pick up the same condition twice — once from the response's own
 * metadata and once from the engine's view of the divert — and telling the
 * user the same sentence twice reads as two problems.
 */
export function mergeWarnings(
  ...lists: readonly (readonly TurnWarning[] | undefined)[]
): TurnWarning[] {
  const seen = new Set<string>();
  const out: TurnWarning[] = [];
  for (const list of lists) {
    for (const warning of list ?? []) {
      // JSON rather than a delimiter. A separator has to be a character
      // that cannot appear in the data, and the obvious pick -- NUL --
      // makes this source file binary: `file` reports "data", and grep
      // then skips it ENTIRELY AND SILENTLY. In a repo whose guards are
      // grep-style scans over source (tests/layering.test.ts), a file no
      // scanner can see is worse than a key collision.
      const key = JSON.stringify([warning.category, warning.message, warning.source ?? '']);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(warning);
    }
  }
  return out;
}
