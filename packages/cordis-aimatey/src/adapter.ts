/**
 * aimatey's Router, wearing DSH's `LlmAdapter` interface.
 *
 * WHICH LAYER THIS WRAPS, and why it matters: `Router.executeStream`, not
 * `Bridge.chatStream`. The Bridge runs `createToolMiddleware`, which EXECUTES
 * tool calls inside aimatey, and DSH's agent loop dispatches tools too. Wrapping
 * the Bridge would put two tool executors on one stream and run every tool
 * twice — a correctness bug, not a plumbing preference. The cost of wrapping
 * the Router is that the app's own retry and tool middleware do not run on the
 * DSH path, so DSH-side behaviour is not identical to the mobile app's. That is
 * written down in the package README rather than papered over.
 */

import { LlmAdapter, LlmError, resolveRetryPolicy } from '@deepseek-ai/dsh-llm';
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  ResolvedRetryPolicy,
  StreamChunk,
} from '@deepseek-ai/dsh-llm';
import type { Router } from '@johnhenry/aimatey-core';
import type {
  BackendAdapter,
  BackendInfo,
  IRChatRequest,
  IRStreamChunk,
  RouterConfig,
} from '@johnhenry/aimatey-types';

import { translate } from './chunks.js';
import { ROUTE_UNAVAILABLE_CODE } from './errors.js';
import { pinRouter } from './pin.js';
import { ROUTER_SENTINEL, toIRRequest } from './request.js';
import type { TranslationHooks } from './request.js';

/**
 * The part of aimatey's `Router` this adapter uses.
 *
 * Structural rather than nominal so a test can supply a Router that models the
 * real one without instantiating backends. {@link RouterConformance} below is
 * the compile-time proof that the real class still satisfies it.
 */
export interface AimateyRouter {
  /** Registered backend ids, in registration order. */
  listBackends(): readonly string[];
  /** Whether a backend of this name is registered. */
  has(name: string): boolean;
  /** The registered backend adapter, if any. */
  get(name: string): BackendAdapter | undefined;
  /** Metadata for one registered backend. */
  getBackendInfo(name: string): BackendInfo | undefined;
  /**
   * This router with different settings, sharing the same adapter INSTANCES.
   *
   * `RouterConfig` comes from `@johnhenry/aimatey-types`; `aimatey-core` does
   * not export it (tsc: TS2305).
   */
  clone(config: Partial<RouterConfig>): AimateyRouter;
  /** Drop one backend registration. Throws if the name is not registered. */
  unregister(name: string): AimateyRouter;
  /** Route and stream one IR request. Cancellation is threaded POSITIONALLY. */
  executeStream(request: IRChatRequest, signal?: AbortSignal): AsyncIterable<IRStreamChunk>;
}

/**
 * Compile-time proof that {@link AimateyRouter} is a real subset of `Router`.
 *
 * If aimatey renames or re-signatures one of these methods, this alias resolves
 * to `never` and `typecheck` fails here — rather than the fake in the test suite
 * quietly drifting away from the class it is supposed to model.
 */
export type RouterConformance = Router extends AimateyRouter ? true : never;

/** What {@link AimateyAdapter} needs to run. */
export interface AimateyAdapterOptions extends TranslationHooks {
  /** The live Router. The adapter never disposes it; see the README. */
  readonly router: AimateyRouter;
}

/**
 * Streams DSH model calls through aimatey's Router.
 *
 * One DSH provider route per aimatey backend, plus the {@link ROUTER_SENTINEL}
 * route that leaves the choice of backend to the Router.
 */
export class AimateyAdapter extends LlmAdapter {
  readonly #router: AimateyRouter;
  readonly #hooks: TranslationHooks;

  constructor(options: AimateyAdapterOptions) {
    super();
    this.#router = options.router;
    this.#hooks = { ...(options.warn ? { warn: options.warn } : {}), ...(options.debug ? { debug: options.debug } : {}) };
  }

  /**
   * Display metadata for one route.
   *
   * Validated at REGISTRATION time, not at call time: `id` must equal the route
   * and `name` must be non-empty, or `registerAdapter` throws INVALID_ADAPTER
   * and the mount fails loudly.
   */
  /**
   * `aimatey` is the router-choose route ONLY while no backend owns that name.
   *
   * Comparing against the constant alone made a backend registered under the
   * reserved name reachable through no pinned route at all: the request took
   * the sentinel branch and the Router chose freely, which is the opposite of
   * what `routesFor`'s warning promises. Asking the router each time also keeps
   * the answer correct when that backend is registered after mount.
   */
  #isRouterChoice(provider: string): boolean {
    return provider === ROUTER_SENTINEL && !this.#router.has(ROUTER_SENTINEL);
  }

  override providerInfo(provider: string): LlmProviderInfo {
    if (this.#isRouterChoice(provider)) return { id: provider, name: 'aimatey (router)' };
    const info = this.#router.getBackendInfo(provider);
    return { id: provider, name: info?.metadata.provider ?? provider };
  }

  /**
   * The advisory model catalog for one route.
   *
   * `Router` itself has no `listModels`, so the sentinel route has nothing to
   * advertise, and a backend route answers only if its adapter implements the
   * optional method. Returning `[]` is explicitly legal: catalog membership is
   * advisory and never used for routing or request validation.
   */
  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    if (this.#isRouterChoice(provider)) return [];
    try {
      const backend = this.#router.get(provider);
      if (typeof backend?.listModels !== 'function') return [];
      const result = await backend.listModels();
      const seen = new Set<string>();
      const models: LlmModelInfo[] = [];
      for (const model of result.models) {
        // Duplicate ids fail the whole catalog with INVALID_CATALOG, and a
        // rejected catalog is strictly worse than a shorter one.
        if (seen.has(model.id)) continue;
        seen.add(model.id);
        models.push({ provider, id: model.id, name: model.name.length > 0 ? model.name : model.id });
      }
      return models;
    } catch (cause) {
      this.#hooks.warn?.(
        `aimatey: backend "${provider}" failed to list models: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
      return [];
    }
  }

  /**
   * Exact-model metadata.
   *
   * `id` must be the requested string verbatim or the registry rejects it with
   * INVALID_MODEL_INFO. Nothing else is known: aimatey performs no model lookup
   * here, so `context`, `defaultMaxTokens` and `reasoning` are left off rather
   * than filled with a plausible number — both context fields are strictly
   * validated, and a made-up context window would silently change how the loop
   * compacts a conversation.
   *
   * `inputModalities: ['text']` is the one deliberate positive claim. It is a
   * NEGATIVE capability declaration — it says images are not accepted — and it
   * makes `LlmRuntime` rewrite image blocks into placeholder text before this
   * adapter is called. Omitting the field entirely would mean "unknown", which
   * DISABLES that projection and lets images arrive here unhandled.
   *
   * There is deliberately no `reasoning` block: a caller passing
   * `reasoningEffort` is then refused with UNSUPPORTED_REASONING_EFFORT before
   * any provider I/O, which is the honest answer, because aimatey's IR has no
   * reasoning channel at all.
   */
  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return { provider, id: model, name: model, inputModalities: ['text'] };
  }

  /**
   * The retry policy captured with each route.
   *
   * `maxRetries: 0` because aimatey already owns retry for this path: the
   * Router has a circuit breaker and a fallback chain of its own, and base
   * dsh-llm never retries anyway (`LlmRuntime.stream` calls the adapter once).
   * Declaring it is insurance against a profile later adding the optional
   * dsh-llm-retry row on top of aimatey's own recovery and getting two.
   */
  override providerRetryPolicy(provider: string): ResolvedRetryPolicy {
    return resolveRetryPolicy({ mode: 'normal', maxRetries: 0 }, `aimatey: provider "${provider}" retryPolicy`);
  }

  /**
   * Stream one model call.
   *
   * `prepareCall` is deliberately not overridden: the base implementation calls
   * `resolveModel` and binds `stream`, and our `resolveModel` does no I/O, so
   * the extra per-request call costs nothing.
   *
   * Two paths. {@link ROUTER_SENTINEL} means "let the Router choose", so it
   * streams through the app's Router untouched. Every other route NAMES one
   * backend, and a named route is a promise about provenance — so it is
   * refused up front if that backend is not routable, and otherwise streamed
   * through a Router that structurally cannot reach any other backend.
   */
  async *stream(options: GenerateOptions): AsyncGenerator<StreamChunk, void, undefined> {
    if (this.#isRouterChoice(options.provider)) {
      const request = toIRRequest(options, undefined, this.#hooks);
      // The signal is threaded positionally; aimatey does not read it from the
      // request object.
      yield* translate(this.#router.executeStream(request, options.signal), options.signal, this.#hooks);
      return;
    }

    const info = this.#router.getBackendInfo(options.provider);
    if (info === undefined) {
      // The route set is captured once at mount; a backend removed since then
      // would otherwise surface as an opaque routing failure from inside the
      // Router.
      throw new LlmError(
        `aimatey backend "${options.provider}" is no longer registered on the router`,
        'NO_BACKEND_AVAILABLE',
      );
    }

    // Pre-flight. The pin below already makes substitution impossible, so this
    // is not the guarantee — it is the diagnostic front door, and it earns its
    // place by failing BEFORE any I/O: no API key is used and no prompt leaves
    // the device on a backend the caller did not name.
    //
    // The condition mirrors aimatey's own `isBackendAvailable`
    // (router.js:1651-1655) exactly, including `!== 'open'` rather than
    // `=== 'closed'`, so a HALF-OPEN backend — one the breaker is letting
    // recover — is not spuriously refused. Both fields are required members of
    // `BackendInfo` (aimatey-types dist/types/router.d.ts:216-226), so a shape
    // change breaks the build here rather than silently reading `undefined`.
    if (!info.isHealthy || info.circuitBreakerState === 'open') {
      throw new LlmError(
        `aimatey backend "${options.provider}" is not routable right now ` +
          `(healthy=${String(info.isHealthy)}, circuit=${String(info.circuitBreakerState)}) — ` +
          'refusing to substitute another backend for a named route; ' +
          `use the "${ROUTER_SENTINEL}" route to let the router choose.`,
        ROUTE_UNAVAILABLE_CODE,
      );
    }

    const request = toIRRequest(options, options.provider, this.#hooks);
    // WHAT THIS BUYS: substitution is structurally impossible, because a
    // one-backend Router leaves router.js:537-540 ("first available backend")
    // nothing to select and leaves the mid-stream fallback chain empty. It
    // holds whatever `routingStrategy`/`fallbackStrategy` the app configured,
    // which this adapter neither owns nor can enforce.
    //
    // WHAT IT COSTS: failures on this path never reach the APP router's
    // breaker. Measured — five failing pinned requests left the app router at
    // `circuitBreakerState='closed', consecutiveFailures=0, totalRequests=0`,
    // where five direct ones opened it after three. There is no public API to
    // record a failure back onto a Router, so this is documented rather than
    // half-fixed; it is bounded by `providerRetryPolicy` already being
    // `maxRetries: 0` above, so DSH cannot hammer a dead backend, and by the
    // pre-flight still reading the APP router's verdict, so the app's own
    // traffic keeps gating the DSH path.
    yield* translate(
      pinRouter(this.#router, options.provider).executeStream(request, options.signal),
      options.signal,
      this.#hooks,
    );
  }
}
