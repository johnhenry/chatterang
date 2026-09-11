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
import { REACH_DEVICE, REACH_REMOTE, reachPaired } from '@/domain/chat';

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
  // Since #112 a reach is `{ host, reached }`. A row carrying either shape has
  // already been converted once -- the v7 upgrade below handles the older of
  // the two -- so neither is re-derived from a stale `local`.
  const existing = stored.reach as { kind?: unknown; reached?: unknown } | undefined;
  const converted =
    existing?.reached === 'device' ||
    existing?.reached === 'paired' ||
    existing?.reached === 'third-party' ||
    existing?.kind === 'device' ||
    existing?.kind === 'paired' ||
    existing?.kind === 'remote';
  if (converted) return { outcome: 'unchanged' };

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
  await upgradeMessageReachRows(messages, (row) => upgradeReach(row) ?? { dropProvenance: false });
}

/**
 * Apply one row-level reach upgrade across the whole table.
 *
 * Extracted so v6 and v7 share the write half rather than each owning a copy.
 * The two differ in what a row BECOMES; how a row is written back — and in
 * particular that an unreadable provenance is deleted rather than set to
 * `undefined` — is one decision and belongs in one place.
 */
export async function upgradeMessageReachRows(
  messages: ModifiableMessageTable,
  convert: (row: LegacyReachRow) => ReachUpgrade,
): Promise<void> {
  await messages.toCollection().modify((row) => {
    const upgraded = convert(row as LegacyReachRow);
    // Deleted rather than set to undefined: `provenance === undefined` and
    // "no provenance key" read the same to every consumer, but only the
    // delete leaves a row that looks like one this build would write.
    if (upgraded.dropProvenance) delete row.provenance;
    else if (upgraded.provenance) row.provenance = upgraded.provenance;
    if (upgraded.variants) row.variants = upgraded.variants;
  });
}

/* ── v7: one axis becomes two ─────────────────────────────────────────── */

/**
 * The v7 upgrade: a reach says where it RAN and how far the bytes WENT.
 *
 * v6 gave every stored turn a three-arm `Reach`. #112 showed one axis is not
 * enough: a `claude` or `codex` CLI is a process on this machine whose tokens
 * reach a vendor API, and neither `device` nor `remote` can say both halves of
 * that. So `Reach` is `{ host, reached }` now, and the three old arms are the
 * diagonal of the pair.
 *
 * THE CONVERSION IS LOSSLESS AND INVENTS NOTHING, which is why it can be a
 * plain rewrite rather than a judgement call:
 *
 *   { kind: 'device' }  ->  { host: device,      reached: 'device' }
 *   { kind: 'remote' }  ->  { host: third-party, reached: 'third-party' }
 *   { kind: 'paired' }  ->  { host: paired,      reached: 'paired' }
 *
 * Every row on disk is `device` or `remote`: the v6 upgrade above never wrote
 * `paired`, and no build that could tunnel a turn has shipped. The `paired`
 * row is handled anyway because writing a migration that cannot survive a
 * shape it will meet the moment Track B lands is a migration written twice.
 *
 * A row this cannot read keeps the v6 rule: no label rather than a plausible
 * one.
 */
type StoredReachV6 = { readonly kind?: unknown; readonly device?: unknown };

/** Convert one stored reach, or return undefined if it is already v7 or unreadable. */
export function upgradeReachValue(stored: unknown): Reach | undefined {
  if (typeof stored !== 'object' || stored === null) return undefined;
  const value = stored as StoredReachV6 & { readonly reached?: unknown };

  // Already two axes. Dexie can replay an upgrade, so this must be idempotent.
  if (typeof value.reached === 'string') return undefined;

  switch (value.kind) {
    case 'device':
      return REACH_DEVICE;
    case 'remote':
      return REACH_REMOTE;
    case 'paired': {
      const device = value.device as { id?: unknown; name?: unknown } | undefined;
      // A `paired` with no readable device is the invalid state `Reach`'s own
      // comment says must not be constructible -- "paired, but the app cannot
      // say which device" renders as the label this all exists to prevent. Drop
      // the provenance rather than write it.
      if (typeof device?.id !== 'string' || typeof device.name !== 'string') return undefined;
      return reachPaired({ id: device.id, name: device.name });
    }
    default:
      return undefined;
  }
}

/**
 * Rewrite every stored provenance from a one-axis reach to a two-axis one.
 *
 * Same shape as {@link upgradeMessageReach}: it walks the row's own provenance
 * and each variant's, because a variant carries its own and a reader that
 * found one shape on the row and another on a variant would render two
 * different labels for one message.
 */
export function upgradeMessageReachAxes(row: LegacyReachRow): ReachUpgrade {
  const convert = (provenance: unknown): Provenance | undefined | 'drop' => {
    if (typeof provenance !== 'object' || provenance === null) return undefined;
    const stored = provenance as StoredProvenance;
    if (stored.reach === undefined) return undefined;
    const reach = upgradeReachValue(stored.reach);
    if (reach === undefined) {
      // Either already v7 -- leave it -- or unreadable, in which case the v6
      // rule applies and the row loses its provenance rather than gaining a
      // guess. Told apart by whether it already has the new shape.
      const already = (stored.reach as { reached?: unknown }).reached;
      return typeof already === 'string' ? undefined : 'drop';
    }
    return { ...(stored as unknown as Provenance), reach };
  };

  const own = convert(row.provenance);
  const variants = row.variants?.map((variant) => {
    const entry = variant as { provenance?: unknown };
    const converted = convert(entry.provenance);
    if (converted === undefined) return variant as MessageVariant;
    if (converted === 'drop') {
      const { provenance: _dropped, ...rest } = entry;
      return rest as MessageVariant;
    }
    return { ...entry, provenance: converted } as MessageVariant;
  });

  const variantsChanged = variants?.some((variant, index) => variant !== row.variants?.[index]);

  return {
    ...(own !== undefined && own !== 'drop' ? { provenance: own } : {}),
    dropProvenance: own === 'drop',
    ...(variantsChanged ? { variants } : {}),
  };
}
