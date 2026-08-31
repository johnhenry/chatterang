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

import type { Context } from '@deepseek-ai/cordis';

/** What {@link assertBoot} checked, and what it could not. */
export interface BootReport {
  /** Service names confirmed present and ACTIVE. */
  readonly services: readonly string[];
  /** Provider routes confirmed registered on the `llm` service. */
  readonly routes: readonly string[];
  /**
   * Why no tree-level (per-entry) assertion ran.
   *
   * Layers 1 and 2 below catch every failure mode this package can produce: a
   * missing `llm` service, and a plugin that mounted but registered nothing. A
   * third layer walking the loader's entries would additionally catch unrelated
   * rows stuck PENDING — but no loader is mounted on this target, so that code
   * could not be exercised and is not written. This field says so out loud
   * instead of letting a caller assume the tree was checked.
   */
  readonly treeAssertion: string;
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

/** What a full boot assertion is asked to confirm. */
export interface BootExpectation {
  /** Service names that must be present and active. */
  readonly services: readonly string[];
  /** Provider routes that must be registered on `llm`. */
  readonly routes?: readonly string[];
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
  assertServices(ctx, expectation.services);
  const routes = expectation.routes ?? [];
  if (routes.length > 0) assertRoutes(ctx, routes);
  return {
    services: [...expectation.services],
    routes: [...routes],
    treeAssertion:
      ctx.get('loader') === undefined
        ? 'skipped: no loader is mounted, so there are no profile entries to walk'
        : 'not performed: a loader is mounted, but per-entry PENDING/FAILED assertion is not implemented in A4',
  };
}
