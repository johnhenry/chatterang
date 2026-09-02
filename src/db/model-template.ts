/**
 * The v5 upgrade: a prompt template we guessed, and guessed wrong.
 *
 * `install()` writes the whole manifest into IndexedDB verbatim
 * (`state/models.ts`), `load()` reads those rows straight back with no
 * revalidation, and `install()` early-returns on a model that is already
 * installed — so nothing in the ordinary life of an installed model ever
 * re-decides a field of its manifest. `ai/backends/llama-cpp.ts` then PREFERS
 * the persisted field over the inference:
 *
 *     const template = manifest?.promptTemplate ?? inferTemplate(modelId);
 *
 * That chain is why fixing `inferTemplate` fixes nothing for the person who
 * reported the bug. Somebody who installed
 * `lmstudio-community/gemma-4-12B-it-QAT-GGUF` on the build before `gemma4`
 * existed has `promptTemplate: 'gemma'` on disk, and keeps getting
 * "Australia's capital city of Australia's capital city of" out of a model
 * that answers "Canberra" the moment the markers are right — because
 * `gemma-4-12B-it-QAT-Q4_0.gguf` has no `<start_of_turn>` in its vocabulary at
 * all, so the Gemma 2/3 markers arrive as seven ordinary text tokens. A code
 * change cannot reach a row; only a migration can.
 *
 * Kept out of `src/db/index.ts` for the same reason `db/variants.ts` is: the
 * decision can then be imported — and tested — without constructing a Dexie
 * instance, and `version(5).upgrade` over there is a call to
 * {@link upgradeModelTemplates} and nothing else.
 */

import { inferTemplate } from '@/ai/prompt';
import type { PromptTemplate } from '@/domain/manifest';

/** A model row as it may be found on disk. Only the fields this decision reads. */
export interface StoredModelRow {
  readonly id?: unknown;
  readonly manifest?: { readonly id?: unknown; readonly promptTemplate?: unknown } | null;
}

/**
 * Results a previous release's `inferTemplate` produced that this one no
 * longer would: `from` is what it used to answer for an id that today's
 * `inferTemplate` answers `to`.
 *
 * This table is the whole safety argument, so it is worth saying what it is
 * there instead of.
 *
 * The obvious migration is "re-run `inferTemplate` over every installed row
 * and write the answer down". That is wrong, because `promptTemplate` has two
 * provenances and only one of them is a guess:
 *
 * - `data/catalog.ts` sets it by hand on every entry. Those values are chosen
 *   and checked against the file — `gemma-3-4b-it-q4km` says `'gemma'` because
 *   that is what the model wants, not because anything inferred it.
 * - `features/models/HuggingFaceBrowser.tsx` sets it to
 *   `inferTemplate(detail.id)` at the moment of install. That one is a guess
 *   from a string, and it is the only one that can be stale.
 *
 * Nothing on the row records which of the two it got, and no screen lets a
 * person edit the field, so the provenance has to be reconstructed. A stored
 * value is treated as OUR OWN SUPERSEDED GUESS — and only then rewritten —
 * when it is exactly what a retired rule produced for that id. Everything else
 * is left alone: a value today's inference agrees with (nothing to fix), a
 * value that disagrees in a direction no release of ours ever produced
 * (someone meant it, or a catalogue entry did), and a row with no
 * `promptTemplate` at all (the backend already falls through to the
 * inference there, so it was never stale).
 *
 * One entry, because one rule changed. The catalogue's `gemma-3-4b-it-q4km` —
 * the only shipped entry that says `'gemma'` — cannot match it: today's
 * `inferTemplate` still answers `'gemma'` for that id, which is what the
 * lookarounds in the `gemma4` pattern exist to guarantee.
 */
const SUPERSEDED: readonly { readonly from: PromptTemplate; readonly to: PromptTemplate }[] = [
  { from: 'gemma', to: 'gemma4' },
];

/**
 * The template this row should be carrying, or null to leave it as it is.
 *
 * Inference runs on the row's own key, which is the id
 * `backends/llama-cpp.ts` passes to `inferTemplate` when a row has no
 * template — so a repaired row and that fallback cannot disagree afterwards.
 */
export function supersededTemplate(row: StoredModelRow): PromptTemplate | null {
  const stored = row.manifest?.promptTemplate;
  if (typeof stored !== 'string') return null;

  const key = typeof row.id === 'string' && row.id !== '' ? row.id : row.manifest?.id;
  if (typeof key !== 'string' || key === '') return null;

  const inferred = inferTemplate(key);
  if (inferred === stored) return null;

  return SUPERSEDED.some((rule) => rule.from === stored && rule.to === inferred) ? inferred : null;
}

/** The `models` table, narrowed to what the upgrade does with it. */
interface ModifiableTable {
  toCollection(): { modify(apply: (row: Record<string, unknown>) => void): PromiseLike<unknown> };
}

/**
 * Rewrite the rows whose template was a guess we have since retired.
 *
 * The value is REPLACED rather than deleted. Deleting it would make the row
 * fall through to `inferTemplate` on every load and never need a migration
 * again, which is tempting — but `promptTemplate` has readers other than the
 * backend, and they do not share that fallback: `ModelDetail.tsx` renders
 * `manifest.promptTemplate ?? 'chatml'`, so a cleared field would show a
 * Gemma 4 model's prompt format as "ChatML" on the model's own screen.
 */
export async function upgradeModelTemplates(models: ModifiableTable): Promise<void> {
  await models.toCollection().modify((row) => {
    const replacement = supersededTemplate(row as StoredModelRow);
    if (replacement === null) return;
    // In place, on the nested object: `modify` writes back the row it handed
    // us, and `manifest` is part of that row.
    (row.manifest as Record<string, unknown>).promptTemplate = replacement;
  });
}
