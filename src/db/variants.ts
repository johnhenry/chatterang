/**
 * The v4 upgrade: a variant carries its own provenance.
 *
 * Kept out of `src/db/index.ts` so the decision can be imported — and tested —
 * without constructing a Dexie instance. `version(4).upgrade` over there is a
 * loop around {@link upgradeVariants} and nothing else.
 */

import type { GenerationStats, MessageVariant, Provenance, ToolInvocation } from '@/domain/chat';

/** A message row as it may be found on disk, before or after the upgrade. */
export interface LegacyMessageRow {
  readonly content?: string;
  readonly thinking?: string;
  readonly toolCalls?: readonly ToolInvocation[];
  readonly provenance?: Provenance;
  readonly stats?: GenerationStats;
  readonly variants?: readonly unknown[];
  readonly variantIndex?: number;
}

export interface VariantUpgrade {
  readonly variants: MessageVariant[];
  readonly variantIndex: number;
  /**
   * Whether the row's own `provenance`/`stats`/`toolCalls` must be dropped
   * because they describe a generation the row is no longer displaying.
   */
  readonly detach: boolean;
}

/**
 * Rewrite one row's variants, or return null when there is nothing to do.
 *
 * Through v3, `Message.variants` was `string[]` — the TEXT of the generations
 * not on display — while `provenance`, `toolCalls` and `stats` sat on the row
 * describing whichever generation was made last. Switching variants moved the
 * text and left the rest, so a reply that came back from a provider rendered
 * under the on-device flame and exported as "(on device)".
 *
 * The one thing this must never do is guess. An old string variant records no
 * origin, and the plausible guess — the row's own provenance — is exactly the
 * confident falsehood the shape change exists to prevent. So a recovered
 * generation is marked `unrecorded`: it renders with no chip and no model
 * name, the way any message with no provenance already does, and it counts as
 * tool-derived for taint, because its tool use is equally unrecorded and that
 * is the direction unknown has to fail in.
 *
 * The row's own fields join the list as a recorded generation only when they
 * can be shown to belong to the text they sit next to. Two conditions, and
 * both are needed:
 *
 *   1. `variantIndex` is absent or past the end of the old list — the row was
 *      displaying its own newest generation rather than an older one.
 *   2. the row's text is not a duplicate of any old variant.
 *
 * (2) is the interesting one. The old `cycleVariant` overwrote `content` in
 * place, so a row that had ever been cycled has lost its newest text and
 * `content` is a copy of an older variant — and after cycling all the way
 * round, `variantIndex` points past the end again, so (1) alone is satisfied
 * by a row whose fields describe a generation that no longer exists. A
 * duplicate is that row's signature. Two generations that genuinely produced
 * identical text are indistinguishable from it and lose a true label; that is
 * the cheaper of the two mistakes by a wide margin, and it is the one this
 * whole change is about not making in the other direction.
 */
export function upgradeVariants(row: LegacyMessageRow): VariantUpgrade | null {
  const legacy = row.variants;
  if (!Array.isArray(legacy) || legacy.length === 0) return null;
  // Already records — a re-run, or a row written by this build. Nothing here
  // may overwrite a provenance that WAS recorded.
  if (!legacy.some((entry) => typeof entry === 'string')) return null;

  const recovered: MessageVariant[] = legacy.map((entry) =>
    typeof entry === 'string' ? { content: entry, unrecorded: true } : (entry as MessageVariant),
  );

  const content = row.content ?? '';
  const ownNewest =
    (row.variantIndex === undefined || row.variantIndex >= legacy.length) &&
    !recovered.some((variant) => variant.content === content);

  if (ownNewest) {
    return {
      variants: [
        ...recovered,
        {
          content,
          thinking: row.thinking,
          toolCalls: row.toolCalls,
          provenance: row.provenance,
          stats: row.stats,
        },
      ],
      variantIndex: recovered.length,
      detach: false,
    };
  }

  // The row is showing text it cannot attribute, and its own newest generation
  // is not recoverable — the old `cycleVariant` wrote over it. So nothing is
  // appended, and the fields describing that lost generation are dropped
  // rather than reassigned to the text now on screen. The entry this lands on
  // is `unrecorded`, so the turn still counts as tool-derived for taint even
  // though its `toolCalls` have gone with them.
  const showing = recovered.findIndex((variant) => variant.content === content);
  return {
    variants: recovered,
    variantIndex: showing === -1 ? Math.min(row.variantIndex ?? 0, recovered.length - 1) : showing,
    detach: true,
  };
}
