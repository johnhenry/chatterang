/**
 * aimatey's Router, registered as a provider inside a DeepSeek Harness tree.
 *
 * The direction matters: this package imports aimatey, never the reverse, and
 * nothing under `src/` may import this one. DSH is Node-only and pulls native
 * addons (koffi, node-pty) that cannot load in a mobile webview at all —
 * `tests/layering.test.ts` enforces the seam.
 *
 * The shape below was proven against the real packages rather than inferred.
 * `@deepseek-ai/dsh-llm` *is* the `llm` service — an adapter registry — not a
 * DeepSeek provider; that code lives in `dsh-llm-deepseek`. Omitting the row
 * disables six others including `agent-loop` (session-title-llm, llm-pi-ai,
 * compaction-basic, session-checkpoint-policy, agent-loop and llm-deepseek all
 * declare `inject: ['llm']` in dsh-base), and the failure is silent: Cordis
 * parks an unsatisfied `inject` as PENDING, so `await fiber` resolves and boot
 * reports green with the services simply absent. Hence `inject` below, and
 * hence `assertBoot`.
 *
 * The service CLASS is `LlmRuntime`, not `LlmService` — `import { LlmService }`
 * fails at runtime. The service NAME is still `llm`.
 */

import type { Context, Plugin } from '@deepseek-ai/cordis';

import { AimateyAdapter } from './adapter.js';
import type { AimateyRouter } from './adapter.js';
import { ROUTER_SENTINEL } from './request.js';

export const PLUGIN_NAME = 'aimatey-router';

/** Services this plugin cannot run without. See the note above on silence. */
export const REQUIRED_SERVICES = ['llm'] as const;

export { AimateyAdapter } from './adapter.js';
export type { AimateyAdapterOptions, AimateyRouter, RouterConformance } from './adapter.js';
export { translate } from './chunks.js';
export { AIMATEY_TO_DSH_CODE, PASS_THROUGH_CODES, ROUTE_UNAVAILABLE_CODE, mapCode } from './errors.js';
export { pinRouter } from './pin.js';
export { ROUTER_SENTINEL, toIRRequest } from './request.js';
export type { TranslationHooks } from './request.js';
export { assertBoot, assertRoutes, assertServices } from './assert-boot.js';
export type { BootExpectation, BootReport } from './assert-boot.js';
export {
  EXCLUDED_ROWS,
  PROFILE_ROWS,
  applyProfile,
  renderPatchYaml,
} from './profile.js';
export type { ExcludedRow, ProfileRow } from './profile.js';

/** Config for the {@link aimateyRouterPlugin} row. */
export interface AimateyRouterConfig {
  /**
   * The live Router.
   *
   * The plugin never calls `router.dispose()` on unmount: `src/ai/engine.ts`
   * holds the same instance and owns its health-check timer, so disposing it
   * here would stop the app's own routing.
   *
   * ROUTING CONTRACT. A NAMED route is pinned adapter-side and does not consult
   * this router's `routingStrategy`, `fallbackStrategy`, `defaultBackend` or
   * capability routing at all: it streams through a per-request clone holding
   * only the named backend (see `pinRouter`), and is refused outright if that
   * backend is unhealthy or its circuit is open. Only {@link ROUTER_SENTINEL}
   * lets this router choose. The behaviour change that buys: a named route
   * that used to be served quietly by a SUBSTITUTE backend now fails with
   * `ROUTE_UNAVAILABLE`.
   */
  readonly router: AimateyRouter;
}

/**
 * The provider routes this plugin claims for one Router.
 *
 * {@link ROUTER_SENTINEL} means "let the Router choose"; every other route names
 * one backend and pins the request to it. The sentinel also guarantees the array
 * is non-empty even with zero backends registered, which matters because
 * `registerAdapter([])` throws INVALID_ADAPTER.
 *
 * @param router - the router whose backends to expose.
 * @param warn - where the backend-name collision is reported.
 * @returns the deduplicated route list.
 */
export function routesFor(router: AimateyRouter, warn?: (message: string) => void): string[] {
  const backends = [...router.listBackends()];
  if (backends.includes(ROUTER_SENTINEL)) {
    // registerAdapter is all-or-nothing: a duplicate anywhere in the array
    // throws DUPLICATE_ADAPTER and nothing registers. A backend literally named
    // "aimatey" therefore costs us the sentinel rather than the whole mount.
    warn?.(
      `cordis-aimatey: a backend is registered under the reserved name "${ROUTER_SENTINEL}", ` +
        'so the router-choose route is not offered; that name now pins that backend.',
      // True because `stream` asks the router whether the name is taken rather
      // than comparing against the constant. The dedupe below is unchanged: it
      // already collapsed the two, and rewriting it changes nothing.
    );
  }
  return [...new Set([ROUTER_SENTINEL, ...backends])];
}

/**
 * The Cordis plugin.
 *
 * `inject` uses the ARRAY form on purpose: cordis 4.0.2 has no
 * `{required, optional}` form, and an object's KEYS become the service names —
 * so `inject: { required: ['llm'] }` would wait forever on services called
 * "required", silently.
 *
 * The route set is captured ONCE, at mount. aimatey emits no event when a
 * backend is registered or unregistered, so there is no push channel to track;
 * a backend connected after mount is not routable until the plugin remounts.
 * Polling `listBackends()` on a timer would make the staleness window
 * nondeterministic rather than removing it.
 */
export const aimateyRouterPlugin: Plugin.Object<AimateyRouterConfig> = {
  name: PLUGIN_NAME,
  inject: [...REQUIRED_SERVICES],
  apply(ctx: Context, config: AimateyRouterConfig) {
    const logger = ctx.logger(PLUGIN_NAME);
    const warn = (message: string): void => logger.warn(message);
    const debug = (message: string): void => logger.debug(message);
    const routes = routesFor(config.router, warn);
    // The handle is a callable disposer that also carries `.replace()`, so
    // returning it registers it as this fiber's effect: on unmount every route
    // goes away and a call on one terminates with NO_ADAPTER.
    return ctx.llm.registerAdapter(routes, new AimateyAdapter({ router: config.router, warn, debug }));
  },
};

export default aimateyRouterPlugin;
