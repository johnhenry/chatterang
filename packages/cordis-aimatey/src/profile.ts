/**
 * The narrowed DSH profile for the chatterang desktop/server target.
 *
 * The profile is expressed HERE, as typed data, and rendered to
 * `cordis.patch.yml` beside it. That is not a stylistic choice: a DSH patch
 * file is consumed by `@deepseek-ai/cordis-plugin-loader`, which this repo does
 * not install (the eight installed `@deepseek-ai/*` packages are cordis,
 * cosmokit, dsh-attachment, dsh-brand, dsh-invariants, dsh-llm, dsh-timeout and
 * schemastery). Nothing here can read the YAML back, so treating the YAML as
 * the source of truth would mean shipping a file no test can check.
 *
 * Instead {@link PROFILE_ROWS} is the source of truth, {@link renderPatchYaml}
 * renders it, `tests/cordis-aimatey.test.ts` asserts the checked-in file still
 * matches, and {@link applyProfile} mounts the same rows by hand on a tree built
 * with `ctx.plugin()` — which is how the target actually boots today.
 *
 * Notes for whoever edits the YAML later, from reading the loader's own
 * behaviour and dsh-base's header comment:
 *   - row order carries no load semantics; activation is service-availability
 *     driven, so the grouping is for readers only;
 *   - a non-`insert` patch REPLACES the target row's whole `config` rather than
 *     merging into it;
 *   - a patch whose `id` matches nothing only WARNS through the loader logger,
 *     so a typo is a silent no-op;
 *   - a row's YAML `inject:` is ADDITIVE to the plugin's static `inject`;
 *   - `disabled: true` rows are invisible to both `assertEntriesLoaded` and
 *     `assertEntriesActivated`, so disabling a row also disables its assertion.
 */

import type { Context, Plugin } from '@deepseek-ai/cordis';

import type { MountedEntry } from './assert-boot.js';

/** One row of a DSH profile patch. */
export interface ProfileRow {
  /** Stable row id; later patches address the row by this. */
  readonly id: string;
  /** The plugin module specifier the loader imports. */
  readonly name: string;
  /** Plugin config, passed verbatim. */
  readonly config?: Readonly<Record<string, unknown>>;
}

/**
 * Every row this target needs, and nothing else.
 *
 * `@deepseek-ai/dsh-llm` is NOT a DeepSeek provider — it *is* the `llm` service
 * (`LlmRuntime extends Service`, `super(ctx, 'llm')`), an adapter registry with
 * no provider of its own. DeepSeek's own provider code lives in
 * `dsh-llm-deepseek` and `dsh-llm-pi-ai`, which is why those can be dropped
 * while this row must stay.
 */
export const PROFILE_ROWS: readonly ProfileRow[] = Object.freeze([
  // The `llm` service itself: the adapter registry every model call goes
  // through. Six rows of dsh-base declare `inject: ['llm']` and are dark
  // without it — session-title-llm, llm-pi-ai, compaction-basic,
  // session-checkpoint-policy, agent-loop and llm-deepseek.
  Object.freeze({ id: 'llm', name: '@deepseek-ai/dsh-llm' }),
  // The invariant registry. `llm-invariant` declares `inject: ['invariants']`,
  // so without this row Cordis parks it PENDING and the boot is green with the
  // stream grammar unenforced — the exact silent-absence trap this package's
  // boot assertion exists for.
  Object.freeze({ id: 'invariants', name: '@deepseek-ai/dsh-invariants' }),
  // The only machine oracle for the chunk grammar (validateStream). Mounted
  // deliberately, and asserted ACTIVE rather than merely present.
  Object.freeze({ id: 'llm-invariant', name: '@deepseek-ai/dsh-llm/invariant' }),
  // This package.
  Object.freeze({ id: 'aimatey-router', name: '@chatterang/cordis-aimatey' }),
]);

/** A row deliberately left out of {@link PROFILE_ROWS}, and why. */
export interface ExcludedRow {
  readonly id: string;
  readonly name: string;
  readonly reason: string;
}

/**
 * Rows dropped on purpose.
 *
 * Recorded rather than merely absent, so the next reader can tell a decision
 * from an oversight.
 */
export const EXCLUDED_ROWS: readonly ExcludedRow[] = Object.freeze([
  Object.freeze({
    id: 'llm-deepseek',
    name: '@deepseek-ai/dsh-llm-deepseek',
    reason:
      "DeepSeek's own provider adapter. It would claim its own provider routes and expect a DEEPSEEK_API_KEY; this target routes every model call through aimatey.",
  }),
  Object.freeze({
    id: 'llm-pi-ai',
    name: '@deepseek-ai/dsh-llm-pi-ai',
    reason: 'The second shipped provider adapter, for the same reason as llm-deepseek.',
  }),
  Object.freeze({
    id: 'web-search-deepseek',
    name: '@deepseek-ai/dsh-web-search-deepseek',
    reason: "A DeepSeek-hosted search backend. Out of scope for A4, and it is a network egress this target has not opted into.",
  }),
  Object.freeze({
    id: 'session-telemetry-otel',
    name: '@deepseek-ai/dsh-session-telemetry-otel',
    reason:
      'Ships session telemetry to a DeepSeek-hosted OTLP endpoint by default (DSH_TELEMETRY_OTLP_URL falls back to harness-telemetry.deepseeksvc.com). A privacy-first on-device app does not enable that silently.',
  }),
  Object.freeze({
    id: 'sandbox-policy',
    name: '@deepseek-ai/dsh-sandbox-policy',
    reason:
      "Not adopted from dsh-sdk-minimal, whose patch sets `mode: danger-full-access`. That profile is a worked example of the patch format, not a policy to inherit; A4 mounts no sandbox at all rather than mounting a permissive one.",
  }),
]);

/**
 * The one line of the rendered header that says what the file is.
 *
 * Exported so the assertion that it is present is checking the same string the
 * renderer writes, rather than a copy of it that can drift.
 */
export const NOT_LOADED_MARKER =
  'GENERATED ARTEFACT — NOT A BOOT INPUT. No loader reads this file.';

/**
 * Render {@link PROFILE_ROWS} as a DSH patch file.
 *
 * A patch file is a top-level YAML array of patch options; one `insert:` with
 * no `id` appends to the empty profile root.
 *
 * The header is long on purpose. The file previously opened with "GENERATED
 * from … PROFILE_ROWS", which is true and still leaves a reader believing the
 * thing it describes is what boots the tree — a checked-in profile in DSH's own
 * patch format, sitting in the package that mounts the tree, reads as
 * load-bearing. It is not, and the header now says which file is.
 *
 * @returns the YAML text, ending in a newline.
 */
export function renderPatchYaml(): string {
  const lines: string[] = [
    '# The chatterang desktop/server profile: the narrowed DSH tree that hosts',
    "# aimatey's Router as an LLM provider.",
    '#',
    '# ' + NOT_LOADED_MARKER,
    '#',
    '# Nothing reads this file at runtime — not the desktop shell, not the',
    '# inference host, not the Electron main process. It is a RENDERING of',
    '# PROFILE_ROWS in packages/cordis-aimatey/src/profile.ts, kept in the',
    '# repository so the shipped tree can be read in the format DSH states a',
    '# profile in — and so it is ready for a loader, should one ever be mounted.',
    '#',
    '# WHAT ACTUALLY BOOTS THE TREE, and it is not this file:',
    '#',
    '#   apps/desktop/src/host/entry.ts   -> mountDsh({ router })',
    '#   apps/desktop/src/host/dsh.ts     -> applyProfile(ctx, modules, PROFILE_ROWS)',
    '#                                    -> assertBoot(ctx, { services, routes })',
    '#',
    '# So the shipped tree DOES come from the profile — from PROFILE_ROWS, the',
    '# typed source of truth, which `applyProfile` mounts row by row against a',
    '# module map the host supplies. What it does not come from is this YAML.',
    '#',
    '# WHY NOT. Turning a row into a mounted plugin is a LOADER\'s job:',
    '# `@deepseek-ai/cordis-plugin-loader` is what imports a row `name` and',
    '# applies a patch file. It is not installed here (`npm ls` reports it',
    '# empty), `@deepseek-ai/cordis` 4.0.2 exports no loader of its own, and the',
    '# eight installed `@deepseek-ai/*` packages are cordis, cosmokit,',
    '# dsh-attachment, dsh-brand, dsh-invariants, dsh-llm, dsh-timeout and',
    '# schemastery. Parsing this file by hand instead would need a YAML parser',
    '# that is only present transitively (yaml@2.9.0, via vite and just-bash),',
    '# and would buy nothing: the rows would be the ones PROFILE_ROWS already',
    '# holds, arrived at through a parse that can fail.',
    '#',
    '# DELETING THIS FILE CHANGES NO RUNTIME BEHAVIOUR. It fails exactly one',
    '# test — the one asserting it still matches its generator.',
    '#',
    '# Edit profile.ts, not this file; tests/cordis-aimatey.test.ts asserts they',
    '# match, and also asserts that no shipped source names this file.',
    '#',
    '# This is a complete tree, not a layer over dsh-base: every DeepSeek-specific',
    '# row is deliberately absent. See EXCLUDED_ROWS in profile.ts for which, and why.',
    '#',
    '# Row order carries no load semantics — activation is service-availability',
    '# driven — so the order below is for readers.',
    '',
    '- insert:',
  ];
  for (const row of PROFILE_ROWS) {
    lines.push('', `    - id: ${row.id}`, `      name: '${row.name}'`);
    for (const [key, value] of Object.entries(row.config ?? {})) {
      lines.push(`      ${key}: ${JSON.stringify(value)}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Mount every profile row on a hand-built Cordis tree.
 *
 * The loader is what would normally turn a row's `name` into a plugin; with no
 * loader mounted, the caller supplies the mapping. Passing the modules in
 * rather than importing them here keeps this file free of a static dependency
 * on plugins a given host may not have installed.
 *
 * This does NOT assert the tree came up — that is {@link assertBoot}'s job, and
 * the separation is the point: awaiting these fibers proves nothing, because an
 * unsatisfied `inject` parks a fiber in PENDING and still resolves.
 *
 * It does, however, HAND BACK the fibers, which is what makes the assertion
 * possible at all. `ctx.plugin()` returns `Fiber & PromiseLike<Fiber>` (cordis
 * registry.d.ts:198) and a fiber knows its own state; this used to await that
 * value for its timing and drop it, which is precisely why the per-entry walk
 * looked as though it needed a loader nobody has installed.
 *
 * @param ctx - the root context.
 * @param modules - row `name` -> the plugin to mount for it.
 * @param rows - the rows to mount; defaults to {@link PROFILE_ROWS}.
 * @returns one entry per mounted row, in mount order, for {@link assertEntries}.
 * @throws Error naming every row with no module supplied.
 */
export async function applyProfile(
  ctx: Context,
  modules: ReadonlyMap<string, Plugin>,
  rows: readonly ProfileRow[] = PROFILE_ROWS,
): Promise<MountedEntry[]> {
  const missing = rows.filter((row) => !modules.has(row.name)).map((row) => row.name);
  if (missing.length > 0) {
    throw new Error(`cordis-aimatey: no module supplied for profile row(s): ${missing.join(', ')}`);
  }
  const mounted: MountedEntry[] = [];
  for (const row of rows) {
    const plugin = modules.get(row.name);
    if (plugin === undefined) continue;
    const fiber = await ctx.plugin(plugin, row.config);
    mounted.push({ id: row.id, name: row.name, fiber });
  }
  return mounted;
}
