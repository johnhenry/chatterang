/**
 * The fix has to reach a model that is ALREADY INSTALLED.
 *
 * THE REPORT this file finishes. `gemma-4-12B-it-QAT-Q4_0.gguf` has no
 * `<start_of_turn>` anywhere in its 262144-entry vocabulary, so a Gemma 4
 * driven with the Gemma 2/3 markers answers "Australia's capital city of
 * Australia's capital city of" where the right markers get "Canberra".
 * `inferTemplate` learned to say `gemma4`, and for a fresh install that is the
 * end of it.
 *
 * It is not the end of it for the person who filed the report, because the
 * template they are running was decided once, at install, and written to disk:
 *
 *   - `state/models.ts` `install()` puts the whole manifest into IndexedDB
 *     verbatim, `promptTemplate` included;
 *   - `load()` reads those rows back with no validation and no refresh;
 *   - `install()` early-returns when the model is already installed, so
 *     re-installing cannot re-decide it either;
 *   - and `ai/backends/llama-cpp.ts` PREFERS `manifest.promptTemplate` over
 *     `inferTemplate(modelId)`.
 *
 * So the row keeps saying `'gemma'` across the upgrade and the model keeps
 * repeating itself. Only a migration can reach it. These tests drive the real
 * `version(5)` hook that `src/db/index.ts` registers — pulled off the real
 * Dexie instance, not a copy of it — and the real decision it runs, and they
 * measure the repair through the real prompt renderer rather than asserting
 * that a string changed.
 *
 * The other half of a migration is what it REFUSES to touch. Re-inferring
 * every row would overwrite the catalogue's hand-set templates with a guess,
 * so the catalogue is here too, entry by entry.
 */

import { describe, expect, it } from 'vitest';

import type { IRMessage } from '@johnhenry/aimatey-types';
import type { PromptTemplate } from '@/domain/manifest';
import { renderPrompt } from '@/ai/prompt';
import { CATALOG } from '@/data/catalog';
import { db, supersededTemplate, upgradeModelTemplates } from '@/db';

/* ── The reported model, as it sits on disk ─────────────────────────── */

/*
 * Built the way it was actually built. `HuggingFaceBrowser.tsx` derives the
 * row key from the repo and the file — `hf_<repo>_<file>` with slashes
 * flattened — and stamps `promptTemplate: inferTemplate(detail.id)` into the
 * manifest, which on the pre-fix build was `'gemma'`. `install()` then writes
 * that object through unchanged.
 */
const REPO = 'lmstudio-community/gemma-4-12B-it-QAT-GGUF';
const FILE = 'gemma-4-12B-it-QAT-Q4_0.gguf';
const REPORTED_ID = `hf_${REPO}_${FILE}`.replaceAll('/', '_');

/** `null` for the rows that never had a template at all. */
function reportedRow(template: PromptTemplate | null = 'gemma'): Record<string, unknown> {
  return {
    id: REPORTED_ID,
    state: 'installed',
    manifest: {
      id: REPORTED_ID,
      name: 'gemma-4-12B-it-QAT-GGUF · Q4_0',
      engine: 'llama-cpp',
      format: 'gguf',
      source: { repo: REPO, file: FILE },
      ...(template === null ? {} : { promptTemplate: template }),
    },
  };
}

const conversation: IRMessage[] = [
  { role: 'user', content: 'What is the capital city of Australia?' },
];

/** The template a row would actually be run with. Mirrors llama-cpp's read. */
function templateOf(row: Record<string, unknown>): unknown {
  return (row.manifest as Record<string, unknown>).promptTemplate;
}

/* ── A transaction, narrowed to what the upgrade uses ───────────────── */

function fakeTable(rows: Record<string, unknown>[]) {
  return {
    toCollection: () => ({
      modify: async (apply: (row: Record<string, unknown>) => void) => {
        // Dexie hands the callback the stored object and writes back what it
        // left behind, nested objects included.
        for (const row of rows) apply(row);
        return rows.length;
      },
    }),
  };
}

function fakeTx(rows: Record<string, unknown>[]): unknown {
  return {
    table(name: string) {
      if (name !== 'models') throw new Error(`the upgrade touched an unexpected table: ${name}`);
      return fakeTable(rows);
    },
  };
}

interface DexieVersion {
  _cfg?: { version?: number; contentUpgrade?: (tx: unknown) => unknown | Promise<unknown> };
}

const versions = (db as unknown as { _versions: DexieVersion[] })._versions;

/* ── The schema itself ──────────────────────────────────────────────── */

describe('the version this migration claims', () => {
  it('is 5, and no other version claims it', () => {
    // Two `.version(n)` calls sharing an n is worse than the bug being fixed:
    // Dexie keeps the last one and the other migration silently never runs.
    // Parallel work on this file is exactly how that happens, so it is asserted
    // rather than remembered.
    const declared = versions.map((version) => version._cfg?.version);

    expect(declared).toContain(5);
    expect(new Set(declared).size).toBe(declared.length);
    expect([...declared]).toEqual([...declared].sort((a, b) => Number(a) - Number(b)));
  });

  it('is still reached by an install on the shipped build, whatever follows it', () => {
    // This used to assert `max === 5`, which was a proxy for "an old install
    // ends up running this upgrade". v6 (`src/db/reach.ts`) now sits above it
    // and the proxy has stopped tracking the claim: Dexie runs every version
    // between the stored one and the newest, in order, so what matters for
    // THIS migration is that 5 is declared and below the top — not that it is
    // the top. The top is asserted where the top is written, in
    // `tests/reach.test.ts`.
    const declared = versions.map((version) => Number(version._cfg?.version));
    expect(declared).toContain(5);
    expect(Math.max(...declared)).toBeGreaterThanOrEqual(5);
  });
});

const v5 = versions.find((version) => version._cfg?.version === 5)?._cfg?.contentUpgrade;

/* ── The repair, through the hook that is actually registered ───────── */

describe('the v5 upgrade, run as Dexie would run it', () => {
  it('is registered with something to do', () => {
    expect(typeof v5).toBe('function');
  });

  it('repairs the reported model, and the repair changes the prompt', async () => {
    const row = reportedRow();

    // Before: the markers this model does not have. This is the defect, not a
    // paraphrase of it.
    const before = renderPrompt(templateOf(row) as PromptTemplate, conversation);
    expect(before).toContain('<start_of_turn>');
    expect(before).not.toContain('<|turn>');

    await v5!(fakeTx([row]));

    expect(templateOf(row)).toBe('gemma4');

    const after = renderPrompt(templateOf(row) as PromptTemplate, conversation);
    expect(after).toContain('<|turn>');
    expect(after).toContain('<turn|>');
    expect(after).not.toContain('<start_of_turn>');
    expect(after).not.toContain('<end_of_turn>');
  });

  it('leaves every other row in the table exactly as it found it', async () => {
    const rows: Record<string, unknown>[] = [
      reportedRow(),
      // A catalogue model, hand-set and correct.
      { id: 'gemma-3-4b-it-q4km', manifest: { id: 'gemma-3-4b-it-q4km', promptTemplate: 'gemma' } },
      // Already repaired, or installed after the fix.
      reportedRow('gemma4'),
      // Never had one: `llama-cpp.ts` falls through to `inferTemplate` for
      // this row, so it was never stale and there is nothing to write.
      reportedRow(null),
      { id: 'llama-3.2-3b-instruct-q4km', manifest: { id: 'l', promptTemplate: 'llama3' } },
    ];

    await v5!(fakeTx(rows));

    expect(rows.map(templateOf)).toEqual([
      'gemma4',
      'gemma',
      'gemma4',
      undefined,
      'llama3',
    ]);
  });

  it('does not invent a manifest, or a template, where there is none', async () => {
    const rows: Record<string, unknown>[] = [
      { id: 'orphan' },
      { id: 'null-manifest', manifest: null },
      { id: '', manifest: { promptTemplate: 'gemma' } },
    ];

    await expect(v5!(fakeTx(rows))).resolves.not.toThrow();
    expect(rows).toEqual([
      { id: 'orphan' },
      { id: 'null-manifest', manifest: null },
      { id: '', manifest: { promptTemplate: 'gemma' } },
    ]);
  });
});

/* ── What it refuses to touch ───────────────────────────────────────── */

describe('the difference between a stale guess and a decision', () => {
  it('rewrites only a value a retired rule of ours produced', () => {
    // `'gemma'` on a Gemma 4 id is what our own `inferTemplate` used to
    // answer, so it is ours to correct.
    expect(supersededTemplate(reportedRow('gemma'))).toBe('gemma4');

    // Nothing this app ever inferred would put these on a Gemma 4 id, so
    // whoever put them there meant them, and the migration keeps its hands off
    // even though today's inference disagrees with all three.
    expect(supersededTemplate(reportedRow('raw'))).toBeNull();
    expect(supersededTemplate(reportedRow('chatml'))).toBeNull();
    expect(supersededTemplate(reportedRow('llama3'))).toBeNull();
  });

  it('leaves every catalogue entry alone', () => {
    // The catalogue's templates are hand-set against the actual files. A
    // migration that re-infers them replaces a checked value with a guess —
    // and `gemma-3-4b-it-q4km`, whose id contains three 4s, is precisely the
    // entry a careless rule would break.
    const rewritten = CATALOG.filter(
      (manifest) => supersededTemplate({ id: manifest.id, manifest }) !== null,
    ).map((manifest) => manifest.id);

    expect(rewritten).toEqual([]);
  });

  it('reads the row key, so a repaired row agrees with the backend fallback', () => {
    // `llama-cpp.ts` infers from the id it was asked to load when a row has no
    // template. Repairing from any other string could leave the two disagreeing
    // for the same model.
    expect(supersededTemplate({ id: REPORTED_ID, manifest: { promptTemplate: 'gemma' } })).toBe(
      'gemma4',
    );
    // A Gemma 3 row keeps `'gemma'`: the id infers `'gemma'` today, so there is
    // no supersession to apply.
    expect(
      supersededTemplate({ id: 'gemma-3-4b-it-q4km', manifest: { promptTemplate: 'gemma' } }),
    ).toBeNull();
    // And a size that merely starts with 4 is not a version 4.
    expect(
      supersededTemplate({ id: 'hf_google_gemma-4b-it_gemma-4b.gguf', manifest: { promptTemplate: 'gemma' } }),
    ).toBeNull();
  });
});

/* ── The direct decision, on the shapes disk can hold ───────────────── */

describe('supersededTemplate', () => {
  it('says nothing to do when the field is absent or not a string', () => {
    expect(supersededTemplate(reportedRow(null))).toBeNull();
    expect(supersededTemplate({ id: REPORTED_ID, manifest: { promptTemplate: 4 } })).toBeNull();
    expect(supersededTemplate({ id: REPORTED_ID })).toBeNull();
    expect(supersededTemplate({})).toBeNull();
  });

  it('falls back to the manifest id when the row key is missing', () => {
    expect(
      supersededTemplate({ manifest: { id: REPORTED_ID, promptTemplate: 'gemma' } }),
    ).toBe('gemma4');
  });

  it('is idempotent — a second run has nothing left to do', async () => {
    const row = reportedRow();
    await upgradeModelTemplates(fakeTable([row]));
    expect(templateOf(row)).toBe('gemma4');
    expect(supersededTemplate(row)).toBeNull();
    await upgradeModelTemplates(fakeTable([row]));
    expect(templateOf(row)).toBe('gemma4');
  });
});
