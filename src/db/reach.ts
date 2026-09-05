/**
 * The v6 upgrade: a provenance says which of three destinations it reached.
 *
 * Through v5, `Provenance.local` was a boolean, and every stored assistant
 * turn carries one. `Reach` replaces it because the app now has three
 * destinations and a boolean has two answers — a paired desktop is not
 * `local` (the bytes left the phone) and not `remote` in the sense the chip,
 * the transcript and the egress sheet all mean by that word (no third party
 * received them). Widening the type reaches no row on disk; only a migration
 * can, and until it has run every persisted turn has a `local` the readers no
 * longer look at and no `reach` for them to look at instead.
 *
 * Kept out of `src/db/index.ts` for the reason `db/variants.ts` and
 * `db/model-template.ts` are: the decision can be imported — and tested —
 * without constructing a Dexie instance, and `version(6).upgrade` over there
 * is a call to {@link upgradeMessageReach} and nothing else.
 *
 * THIS MIGRATION INVENTS NOTHING, and in particular it never writes `paired`.
 * No build before this one could tunnel a turn, so no stored row is a paired
 * one; a row that claimed otherwise would be a guess, and the rule this file
 * inherits from the v4 upgrade is that a generation whose origin was not
 * recorded gets NO label rather than a plausible one.
 */

import type { MessageVariant, Provenance, Reach } from '@/domain/chat';
import { REACH_DEVICE, REACH_REMOTE } from '@/domain/chat';

/** A message row as it may be found on disk, before or after the upgrade. */
export interface LegacyReachRow {
  readonly provenance?: unknown;
  readonly variants?: readonly unknown[];
}

export interface ReachUpgrade {
  /** Replacement for the row's own `provenance`. Absent when it must go. */
  readonly provenance?: Provenance;
  /**
   * Whether the row's `provenance` key must be DELETED.
   *
   * Set when the row had one whose destination cannot be read: a record with
   * neither a `reach` nor a boolean `local` does not say where the reply ran,
   * and the app renders an absent provenance as absent — no chip, no model
   * name — which is the true thing to render. `stats` and `toolCalls` stay:
   * unlike the v4 upgrade, this one is not moving text between generations,
   * so they still describe the words they sit next to.
   */
  readonly dropProvenance: boolean;
  /** Replacement variant list, when at least one entry changed. */
  readonly variants?: readonly MessageVariant[];
}

/** A stored provenance, mid-migration: `local` may still be there, `reach` may not. */
type StoredProvenance = Omit<Provenance, 'reach'> & {
  readonly reach?: unknown;
  readonly local?: unknown;
};

type Converted =
  /** Already carries a reach — a re-run, or a row written by this build. */
  | { readonly outcome: 'unchanged' }
  /** Rewritten from `local`. */
  | { readonly outcome: 'rewritten'; readonly provenance: Provenance }
  /** Says nothing about where it ran, so it cannot be kept. */
  | { readonly outcome: 'unrecorded' };

/**
 * Rewrite one stored provenance.
 *
 * `local: true` is `device` and `local: false` is `remote`, which is exact:
 * those are the only two things any shipped build could produce, and
 * `EngineTarget.local` — the boolean they were copied from — was
 * `isLocalEngine(engine)`, membership of a list of engines that run in this
 * process. Nothing in it was ever a network hop to a machine of the user's.
 *
 * The old key is DELETED rather than left beside the new one. A row carrying
 * both is a row a reader can still get a two-way answer out of, and the entire
 * point of the three-valued type is that there is no longer a boolean to
 * branch on. It also means a half-migrated database is detectable instead of
 * silently coarse.
 */
function convert(value: unknown): Converted {
  if (typeof value !== 'object' || value === null) return { outcome: 'unrecorded' };
  const stored = value as StoredProvenance;

  // Idempotence. `modify` runs over every row and Dexie can replay an upgrade;
  // a reach that is already there is never re-derived from a stale `local`.
  const kind = (stored.reach as Reach | undefined)?.kind;
  if (kind === 'device' || kind === 'paired' || kind === 'remote') return { outcome: 'unchanged' };

  if (typeof stored.local !== 'boolean') return { outcome: 'unrecorded' };

  const { local: _dropped, reach: _replaced, ...rest } = stored;
  return {
    outcome: 'rewritten',
    provenance: { ...rest, reach: stored.local ? REACH_DEVICE : REACH_REMOTE },
  };
}

/**
 * Bring one message row's provenance — its own, and each variant's — onto
 * `reach`, or return null when there is nothing here to do.
 *
 * A variant whose provenance has to be dropped is marked `unrecorded`, the
 * flag the v4 upgrade introduced for exactly this: it renders as no chip and
 * no model name, and it counts as tool-derived for taint, because a
 * generation whose origin is unknown has unknown tool use too and that is the
 * direction unknown fails in. A variant that never had a provenance is left
 * alone — it is already in that state and re-flagging it would rewrite rows
 * this migration has no business touching.
 */
export function upgradeReach(row: LegacyReachRow): ReachUpgrade | null {
  const own = row.provenance === undefined ? null : convert(row.provenance);

  const legacy = row.variants;
  let variants: MessageVariant[] | undefined;
  if (Array.isArray(legacy)) {
    let touched = false;
    const rewritten = legacy.map((entry) => {
      if (typeof entry !== 'object' || entry === null) return entry as MessageVariant;
      const variant = entry as MessageVariant;
      if (variant.provenance === undefined) return variant;
      const converted = convert(variant.provenance);
      if (converted.outcome === 'unchanged') return variant;
      touched = true;
      if (converted.outcome === 'rewritten') {
        return { ...variant, provenance: converted.provenance };
      }
      const { provenance: _gone, ...kept } = variant;
      return { ...kept, unrecorded: true } as MessageVariant;
    });
    if (touched) variants = rewritten;
  }

  if (variants === undefined && (own === null || own.outcome === 'unchanged')) return null;

  return {
    provenance: own?.outcome === 'rewritten' ? own.provenance : undefined,
    dropProvenance: own?.outcome === 'unrecorded',
    variants,
  };
}

/** The subset of a Dexie table this upgrade uses, so a test can stand in for one. */
export interface ModifiableMessageTable {
  toCollection(): {
    modify(fn: (row: Record<string, unknown>) => void): Promise<unknown>;
  };
}

/** Run {@link upgradeReach} over every message row. */
export async function upgradeMessageReach(messages: ModifiableMessageTable): Promise<void> {
  await messages.toCollection().modify((row) => {
    const upgraded = upgradeReach(row as LegacyReachRow);
    if (!upgraded) return;
    // Deleted rather than set to undefined: `provenance === undefined` and
    // "no provenance key" read the same to every consumer, but only the
    // delete leaves a row that looks like one this build would write.
    if (upgraded.dropProvenance) delete row.provenance;
    else if (upgraded.provenance) row.provenance = upgraded.provenance;
    if (upgraded.variants) row.variants = upgraded.variants;
  });
}
