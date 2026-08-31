/**
 * Boot assertions, because Cordis is silent where it should be loud.
 *
 * A plugin whose `inject` is unsatisfied is not an error in Cordis — the fiber
 * is parked in PENDING and `await fiber` RESOLVES. So a tree missing the
 * `@deepseek-ai/dsh-llm` row boots green, reports no failure, and simply has no
 * `llm` service and no registered routes. Verified directly: mounting the
 * aimatey-router plugin before `LlmRuntime` gives `await fiber` a clean
 * resolution with `fiber.state === 0` and `ctx.get('llm') === undefined`.
 *
 * These assertions are therefore not belt-and-braces. They are the only thing
 * between "the desktop target has no model provider" and "the desktop target
 * started fine".
 */

import type { Context, Fiber } from '@deepseek-ai/cordis';

/**
 * The part of a Cordis `Fiber` the tree walk reads.
 *
 * Structural rather than nominal for the same reason `AimateyRouter` is: a test
 * has to be able to hand the walk an entry in a state a real tree is hard to
 * hold still in — DISPOSED, UNLOADING — without disposing a live tree to get
 * there. {@link FiberConformance} below is the compile-time proof that the real
 * class still satisfies it.
 */
export interface FiberLike {
  /** Current lifecycle state; see {@link FIBER_STATE_NAMES}. */
  readonly state: number;
}

/**
 * Compile-time proof that {@link FiberLike} is a real subset of `Fiber`.
 *
 * If cordis renames `state` or stops typing it as a number, this alias resolves
 * to `never` and `typecheck` fails here rather than the walk quietly reading
 * `undefined` and finding every row healthy.
 */
export type FiberConformance = Fiber extends FiberLike ? true : never;

/**
 * `FiberState`, spelled out, because it cannot be imported at runtime.
 *
 * `FiberState` is declared `const enum` in `@deepseek-ai/cordis`
 * (lib/types/fiber.d.ts:67), so it has no runtime export at all — importing it
 * and reading a member yields `undefined`, and `state !== undefined` would then
 * be true for every fiber in every state. The ordinals are therefore written
 * here, and `tests/cordis-aimatey.test.ts` reads them back off REAL fibers in
 * real states rather than trusting this array to have been copied correctly.
 */
export const FIBER_STATE_NAMES = [
  'PENDING',
  'LOADING',
  'ACTIVE',
  'FAILED',
  'DISPOSED',
  'UNLOADING',
] as const;

/** The one state a mounted profile row is allowed to be in after boot. */
export const FIBER_ACTIVE = 2;

/** Name one fiber state for a human, without pretending to know an unknown one. */
function stateName(state: number): string {
  return FIBER_STATE_NAMES[state] ?? `UNKNOWN(${String(state)})`;
}

/** One profile row, and the fiber `ctx.plugin()` returned for it. */
export interface MountedEntry {
  /** The row's stable id, as written in the profile. */
  readonly id: string;
  /** The plugin module specifier the row names. */
  readonly name: string;
  /** The fiber that row's mount produced. */
  readonly fiber: FiberLike;
}

/** What {@link assertBoot} checked, and what it could not. */
export interface BootReport {
  /** Service names confirmed present and ACTIVE. */
  readonly services: readonly string[];
  /** Provider routes confirmed registered on the `llm` service. */
  readonly routes: readonly string[];
  /**
   * Profile row ids confirmed ACTIVE by the per-entry walk.
   *
   * Empty when no entries were supplied — which is not the same as "the walk
   * found nothing", and is why {@link BootReport.notChecked} still says so in
   * words.
   */
  readonly entries: readonly string[];
  /**
   * What this report does NOT cover, in words.
   *
   * WAS CALLED `treeAssertion`, and that was defect [15]. The name read as the
   * result of a third assertion layer — a per-entry walk of the profile rows
   * for anything stuck PENDING or FAILED — and both of its branches returned a
   * sentence saying no such walk ran.
   *
   * THE WALK NOW EXISTS; see {@link assertEntries}. What made it look
   * impossible was framing it as a walk of a LOADER's rows: no loader is
   * installed, so there was nothing to enumerate. But this target does not need
   * one. `applyProfile` mounts each row with `ctx.plugin()`, which returns
   * `Fiber & PromiseLike<Fiber>` (cordis registry.d.ts:198), and a fiber knows
   * its own state. Handing those fibers back turns the walk into an ordinary
   * assertion over data we were already producing and throwing away.
   *
   * This field now describes what is left: rows nobody handed in, and plugins
   * mounted outside `applyProfile`.
   */
  readonly notChecked: string;
}

/**
 * LAYER 1 — every named service is present.
 *
 * This is the only check that catches a row nobody ever wrote. `ctx.get(name)`
 * in strict mode already encodes "the providing fiber is ACTIVE", so no
 * `FiberState` comparison is needed — which is just as well, because
 * `FiberState` is a TypeScript `const enum` with no runtime export and reading
 * it through an import yields `undefined`.
 *
 * @param ctx - the context to interrogate.
 * @param required - service names the caller cannot run without.
 * @throws Error naming every missing service, not just the first.
 */
export function assertServices(ctx: Context, required: readonly string[]): void {
  const missing = required.filter((name) => ctx.get(name) === undefined);
  if (missing.length > 0) {
    throw new Error(
      `cordis-aimatey: required service(s) absent after boot: ${missing.join(', ')}. ` +
        'Cordis parks an unsatisfied `inject` as PENDING and resolves the fiber anyway, ' +
        'so a missing profile row does not fail the boot on its own.',
    );
  }
}

/**
 * LAYER 2 — the routes we shipped are actually routable.
 *
 * A plugin object can be constructed, mounted and disposed without ever having
 * registered an adapter. Asserting on `listProviders()` asserts the thing a
 * caller will use, rather than the fact that some code ran.
 *
 * @param ctx - a context whose `llm` service is present (see {@link assertServices}).
 * @param expected - provider routes that must be registered.
 * @throws Error naming the missing routes and listing what is registered.
 */
export function assertRoutes(ctx: Context, expected: readonly string[]): void {
  const llm = ctx.get('llm') as { listProviders(): { id: string }[] } | undefined;
  if (llm === undefined) {
    throw new Error('cordis-aimatey: cannot assert provider routes — the `llm` service is absent.');
  }
  const registered = llm.listProviders().map((provider) => provider.id);
  const missing = expected.filter((route) => !registered.includes(route));
  if (missing.length > 0) {
    throw new Error(
      `cordis-aimatey: provider route(s) not registered: ${missing.join(', ')}. ` +
        `Registered routes: ${registered.length > 0 ? registered.join(', ') : '(none)'}.`,
    );
  }
}

/**
 * LAYER 3 — every profile row this boot mounted is ACTIVE.
 *
 * The layer the other two cannot cover. Layer 1 asks whether a SERVICE is
 * there, so a row that provides no service — `llm-invariant` is the one that
 * matters here — can be parked PENDING forever and pass: it injects
 * `invariants`, and without that registry the stream grammar is simply not
 * enforced while every other assertion stays green. Layer 2 asks whether OUR
 * routes are registered, which says nothing about anyone else's row.
 *
 * `await fiber` is not this assertion. A fiber whose `inject` is unsatisfied
 * resolves cleanly with `state === PENDING`, which is the whole reason this
 * file exists.
 *
 * @param entries - the rows mounted, each with the fiber its mount returned.
 * @throws Error naming every row that is not ACTIVE, and the state it is in.
 */
export function assertEntries(entries: readonly MountedEntry[]): void {
  const stuck = entries.filter((entry) => entry.fiber.state !== FIBER_ACTIVE);
  if (stuck.length > 0) {
    throw new Error(
      'cordis-aimatey: profile row(s) did not activate: ' +
        stuck.map((entry) => `${entry.id} (${entry.name}) is ${stateName(entry.fiber.state)}`).join(', ') +
        '. A PENDING row is waiting on a service nobody provides; Cordis resolves its fiber anyway.',
    );
  }
}

/** What a full boot assertion is asked to confirm. */
export interface BootExpectation {
  /** Service names that must be present and active. */
  readonly services: readonly string[];
  /** Provider routes that must be registered on `llm`. */
  readonly routes?: readonly string[];
  /**
   * The rows this boot mounted, for the per-entry walk.
   *
   * Optional because a caller that built its tree some other way has no fibers
   * to offer, and an assertion that cannot run must say so rather than pass.
   */
  readonly entries?: readonly MountedEntry[];
}

/**
 * Run every boot assertion this package can honestly make.
 *
 * @param ctx - the booted context.
 * @param expectation - the services and routes to confirm.
 * @returns what was confirmed, and what was not checked.
 * @throws Error on the first layer that fails.
 */
export function assertBoot(ctx: Context, expectation: BootExpectation): BootReport {
  // Order matters for the message a human reads first. A missing `llm` service
  // is the cause; the aimatey-router row sitting PENDING is the symptom, and
  // reporting the symptom first would send the reader to the wrong file.
  assertServices(ctx, expectation.services);
  const routes = expectation.routes ?? [];
  if (routes.length > 0) assertRoutes(ctx, routes);
  const entries = expectation.entries ?? [];
  if (entries.length > 0) assertEntries(entries);
  return {
    services: [...expectation.services],
    routes: [...routes],
    entries: entries.map((entry) => entry.id),
    notChecked:
      entries.length === 0
        ? 'the per-entry tree walk: no mounted rows were supplied, so no fiber state was read'
        : `plugins mounted outside the ${String(entries.length)} row(s) supplied — the walk reads ` +
          'exactly the fibers it was handed, and Cordis offers no enumeration of the rest',
  };
}
