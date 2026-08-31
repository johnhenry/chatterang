/**
 * Pinning a DSH route to exactly one aimatey backend, by CONSTRUCTION.
 *
 * The defect this exists for: `metadata.custom.backend` is a *preference*, not
 * a pin. `Router.selectBackend` (aimatey-core dist/esm/router.js:495) honours it
 * only while `isBackendAvailable(name)` holds; when the named backend is
 * unhealthy or its breaker is open, control falls through the routing strategy
 * to "Final fallback: first available backend" (router.js:537-540) and ANOTHER
 * backend serves the request with no signal to the caller. That path is on the
 * PRIMARY selection route, so `fallbackStrategy: 'none'` does not gate it — it
 * only gates `nextStreamFallbackBackend` (router.js:1386-1388). Reproduced
 * against the app's own Router config (src/ai/engine.ts:149-156): with
 * `openai`'s breaker open, a request pinned to `openai` was served by
 * `llama-cpp`.
 *
 * A pre-flight check alone cannot close it. Under aimatey's DEFAULT
 * `fallbackStrategy: 'sequential'` — which the adapter does not own and cannot
 * enforce, since it accepts any Router — a backend that is healthy at selection
 * time and then throws AFTER its `start` chunk is silently replaced mid-stream.
 * Measured: the substitute served the answer and its adapter was called once.
 *
 * So the pin is structural. A named route streams through a per-request clone
 * pruned down to the single pinned backend: the Router the request travels
 * through has no other backend to substitute, whatever its config says.
 */

import type { RouterConfig } from '@johnhenry/aimatey-types';

import type { AimateyRouter } from './adapter.js';

/**
 * A view of `source` that can only ever reach `backend`.
 *
 * `clone()` copies the backend registrations (the same adapter INSTANCES), the
 * health verdict, the circuit state, and every model/translation mapping
 * (router.js:1063-1067), so the clone keeps all of the Router's semantics —
 * model translation, health tracking, in-band error normalisation — and loses
 * only the ability to choose a different backend.
 *
 * Build one per request; never cache by name. `ChatterangEngine.connectProvider`
 * calls `Router.replace` when the user rotates an API key, and a name-keyed
 * cache would keep streaming through the pre-rotation adapter. Cloning is
 * cheap: 1000 clone+prune cycles measured at ~1.6 ms.
 *
 * @param source - the app's Router, never mutated.
 * @param backend - the aimatey backend id this request named.
 * @returns a Router holding exactly that one backend.
 */
export function pinRouter(source: AimateyRouter, backend: string): AimateyRouter {
  const pinned = source.clone({
    // Belt-and-braces. With one registered backend there is nothing left to
    // route to or fall back on, so LOOSENING either of these is invisible to
    // every behavioural test — which is why they are also asserted directly as
    // a unit, rather than only through a stream.
    routingStrategy: 'explicit',
    fallbackStrategy: 'none',
    // MANDATORY, not tidiness. `clone` spreads `this.config` into
    // `new Router(...)`, and that constructor starts a health-check interval
    // whenever the value is > 0 (router.js:104). A per-request clone is never
    // disposed, so inheriting a live interval leaks one timer per request.
    // Measured by counting `setInterval` calls: a source router with
    // `healthCheckInterval: 5000` makes 1, a naive `clone()` of it makes a
    // second (1 -> 2), and a clone carrying this line makes none.
    healthCheckInterval: 0,
    // MANDATORY. `unregister` clears a `defaultBackend` that names the backend
    // being removed and fires `config.onWarning` about it (router.js:252-262).
    // Without this the app would see one spurious "defaultBackend has been
    // cleared" warning per request. This app sets no defaultBackend, but the
    // adapter's contract accepts any Router.
    defaultBackend: undefined,
    // Deliberately NOT `enableCircuitBreaker: false`: a clone inherits an open
    // circuit only when the clone itself has the breaker enabled
    // (router.js:1054-1058). That inheritance is what makes the pinned Router
    // honour the app's own health verdict instead of quietly re-arming a
    // backend the breaker had just taken out of rotation.
  } satisfies Partial<RouterConfig>);

  // Copied before iterating: `listBackends()` builds a fresh array
  // (router.js), but unregistering while walking a live view would be a bug
  // waiting for a version bump.
  for (const name of [...pinned.listBackends()]) {
    if (name !== backend) pinned.unregister(name);
  }
  return pinned;
}
