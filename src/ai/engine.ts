/**
 * The engine: aimatey Router + Bridge, assembled (PRD §2).
 *
 * Everything above this file — chat, tasks, benchmarks, vision, the whole UI
 * — talks to `ChatterangEngine`. Everything below it is an aimatey backend
 * adapter. That is the seam that makes the Phase 2–4 runtime rollout additive
 * instead of invasive: a new engine is `router.register(id, adapter)` and a
 * manifest field, not a change to any call site.
 */

import { Bridge, Router } from '@johnhenry/aimatey-core';
import { GenericFrontendAdapter } from '@johnhenry/aimatey-frontend';
import { ChromeAIBackendAdapter, LiteRtLmBackendAdapter } from '@johnhenry/aimatey-backend-browser';
// Imported from subpaths, not the package barrel: the barrel pulls in the
// caching middleware, which imports Node's `crypto` and would be externalised
// (and then fail) inside a webview.
import { createLoggingMiddleware } from '@johnhenry/aimatey-middleware/logging';
import { createRetryMiddleware } from '@johnhenry/aimatey-middleware/retry';
import type {
  BackendAdapter,
  IRChatRequest,
  IRChatResponse,
  IRMessage,
  IRStreamChunk,
  Middleware,
} from '@johnhenry/aimatey-types';

import { LlamaCppBackendAdapter, type LlamaModelResolver } from '@/ai/backends/llama-cpp';
import {
  createToolMiddleware,
  findToolCalls,
  runToolCalls,
  stripToolSyntax,
  type ExecutedTool,
} from '@/ai/middleware/tools';
import {
  checkDevicePressure,
  classifyFailure,
  createResilienceMiddleware,
  type FallbackEvent,
  type FallbackReason,
} from '@/ai/middleware/resilience';
import { toolRegistry } from '@/ai/tools/registry';
import { connectionConfig, getProvider, type ProviderConnection } from '@/ai/providers';
import type { EngineId } from '@/domain/manifest';
import { isLocalEngine } from '@/domain/manifest';
import { newId } from '@/domain/chat';

/** Execute → tools → execute round trips permitted per turn. */
const TOOL_ITERATIONS = 4;

interface TurnResult {
  text: string;
  stats: GenerationStatsSnapshot;
  error?: string;
}

/* ── Public surface ─────────────────────────────────────────────────── */

export interface EngineTarget {
  /** Backend id registered on the router. */
  readonly backendId: string;
  readonly engine: EngineId;
  /** Model id passed to the backend. */
  readonly modelId: string;
  readonly modelName: string;
  readonly local: boolean;
}

export interface GenerationRequest {
  readonly messages: readonly IRMessage[];
  readonly target: EngineTarget;
  readonly sampler?: {
    temperature?: number;
    topP?: number;
    topK?: number;
    maxTokens?: number;
    seed?: number | null;
    stopSequences?: readonly string[];
    frequencyPenalty?: number;
    presencePenalty?: number;
  };
  readonly toolIds?: readonly string[];
  readonly signal?: AbortSignal;
}

export type GenerationEvent =
  | { readonly type: 'start'; readonly requestId: string }
  | { readonly type: 'delta'; readonly text: string }
  | { readonly type: 'tool'; readonly tool: ExecutedTool }
  | { readonly type: 'fallback'; readonly event: FallbackEvent }
  | {
      readonly type: 'done';
      readonly text: string;
      readonly stats: GenerationStatsSnapshot;
      readonly provenance: ProvenanceSnapshot;
      readonly tools: readonly ExecutedTool[];
    }
  | { readonly type: 'error'; readonly message: string };

export interface GenerationStatsSnapshot {
  promptTokens?: number;
  cachedTokens?: number;
  completionTokens?: number;
  ttftMs?: number;
  totalMs?: number;
  tokensPerSecond?: number;
  draftAcceptance?: number;
  computeBackend?: string;
  peakMemoryBytes?: number;
}

export interface ProvenanceSnapshot {
  backendId: string;
  engine: EngineId;
  modelId: string;
  modelName: string;
  local: boolean;
  fallbackFrom?: string;
  fallbackReason?: FallbackReason;
}

export interface EngineOptions {
  resolver: LlamaModelResolver;
  /** Backend id used when the device cannot serve a request locally. */
  fallbackBackendId?: string | null;
  onWarning?: (message: string) => void;
  onFallback?: (event: FallbackEvent) => void;
  debug?: boolean;
}

/* ── Engine ─────────────────────────────────────────────────────────── */

export class ChatterangEngine {
  readonly router: Router;
  readonly llama: LlamaCppBackendAdapter;

  #bridge: Bridge<GenericFrontendAdapter>;
  #options: EngineOptions;
  #remotes = new Map<string, BackendAdapter>();
  /** Default model per registered backend, used when a fallback retargets. */
  #fallbackModels = new Map<string, string>();
  #pendingTools: ExecutedTool[] = [];
  #lastFallback: FallbackEvent | null = null;

  constructor(options: EngineOptions) {
    this.#options = options;

    this.router = new Router({
      routingStrategy: 'explicit',
      fallbackStrategy: 'none', // Fallback is a consent decision, not automatic.
      trackLatency: true,
      enableCircuitBreaker: true,
      circuitBreakerThreshold: 3,
      circuitBreakerTimeout: 30_000,
    });

    this.llama = new LlamaCppBackendAdapter({
      resolver: options.resolver,
      onWarning: options.onWarning,
    });
    this.router.register('llama-cpp', this.llama);

    // Browser/WebGPU on-device runtimes, registered when the platform has
    // them. Both are genuinely local, so they share the ember identity.
    if (hasPromptApi()) {
      this.router.register('chrome-ai', new ChromeAIBackendAdapter({}));
    }

    this.#bridge = new Bridge(new GenericFrontendAdapter(), this.router, {
      debug: options.debug ?? false,
      timeout: 300_000, // On-device prefill on a cold model is genuinely slow.
      autoRequestId: true,
    });

    for (const middleware of this.#middleware()) this.#bridge.use(middleware);
  }

  #middleware(): Middleware[] {
    const stack: Middleware[] = [];

    if (this.#options.debug) {
      stack.push(createLoggingMiddleware({ level: 'debug' }) as Middleware);
    }

    stack.push(
      createResilienceMiddleware({
        resolveFallback: () => this.#resolveFallback(),
        onFallback: (event) => {
          this.#lastFallback = event;
          this.#options.onFallback?.(event);
        },
      }),
    );

    // Retries only help transient remote failures; a local OOM will not fix
    // itself on a second attempt, so the predicate excludes local backends.
    stack.push(
      createRetryMiddleware({
        maxAttempts: 2,
        initialDelay: 400,
        maxDelay: 4_000,
        backoffMultiplier: 2,
      }) as Middleware,
    );

    stack.push(
      createToolMiddleware({
        registry: toolRegistry,
        maxIterations: TOOL_ITERATIONS,
        onToolExecuted: (tool) => this.#pendingTools.push(tool),
        // The Router implements `BackendAdapter`, so the follow-up turn is
        // routed exactly like the first one.
        //
        // This used to be a workaround for ai.matey#64, where `context.backend`
        // was never populated. That is fixed as of core 0.3.0 — but the
        // override stays, because #64's fix populates the field *adaptively*:
        // the router before dispatch, narrowed to the backend that actually
        // served once a response exists. The tool loop's follow-up runs after a
        // response, so falling through to `context.backend` would pin every
        // subsequent turn to whichever backend answered the first one.
        //
        // That is a real trade, not a tidy-up: pinning keeps a conversation on
        // one model, routing again keeps fallback working when that model
        // starts failing mid-conversation. This app chooses routing.
        resolveBackend: () => this.router,
      }),
    );

    return stack;
  }

  /* ── Remote provider registration ───────────────────────────────── */

  async connectProvider(connection: ProviderConnection): Promise<void> {
    const descriptor = getProvider(connection.providerId);
    if (!descriptor) throw new Error(`Unknown provider "${connection.providerId}".`);

    const adapter = await descriptor.load(connectionConfig(connection));
    this.#remotes.set(connection.id, adapter);

    // Reconnecting an existing provider — the user rotated their API key, or
    // changed the endpoint — swaps the adapter in place. `register` would
    // throw on the duplicate name, and unregister-then-register would discard
    // the backend's latency and cost history (aimatey 0.2.0, ai.matey#49).
    if (this.router.has(connection.id)) {
      this.router.replace(connection.id, adapter);
    } else {
      this.router.register(connection.id, adapter);
    }

    const model = connection.defaultModel || descriptor.defaultModel;
    if (model) this.#fallbackModels.set(connection.id, model);
  }

  disconnectProvider(connectionId: string): void {
    this.#remotes.delete(connectionId);
    this.#fallbackModels.delete(connectionId);

    // Unregistering an absent backend still throws, so a double-disconnect
    // must not be able to take the settings screen down with it.
    try {
      this.router.unregister(connectionId);
    } catch {
      // Already gone.
    }

    if (this.#options.fallbackBackendId === connectionId) {
      this.#options = { ...this.#options, fallbackBackendId: null };
    }
  }

  /** Register a LiteRT-LM `.litertlm` bundle as an on-device backend. */
  registerLiteRtLm(backendId: string, modelUrl: string): void {
    this.router.register(backendId, new LiteRtLmBackendAdapter({ model: modelUrl }));
  }

  setFallbackBackend(backendId: string | null): void {
    this.#options = { ...this.#options, fallbackBackendId: backendId };
  }

  get fallbackBackendId(): string | null {
    return this.#options.fallbackBackendId ?? null;
  }

  listBackends(): readonly string[] {
    return this.router.listBackends();
  }

  hasBackend(id: string): boolean {
    return this.router.has(id);
  }

  /* ── Generation ─────────────────────────────────────────────────── */

  /**
   * Stream a completion. Yields UI-shaped events rather than IR chunks so
   * feature code never has to know the IR discriminated union.
   *
   * The middleware chain is driven here rather than by the Bridge, because
   * aimatey's `Bridge.use()` middleware is silently skipped for streamed
   * requests (johnhenry/ai.matey#46) and every turn in this app streams. That
   * is also the right shape for tools: a tool call cannot be executed
   * mid-stream, since its arguments are not complete until the turn ends.
   *
   * Order matches the non-streaming stack: device pressure, then generation,
   * then the tool loop.
   */
  async *stream(request: GenerationRequest): AsyncGenerator<GenerationEvent> {
    const requestId = newId('req');
    this.#pendingTools = [];
    this.#lastFallback = null;

    const started = performance.now();
    yield { type: 'start', requestId };

    // ── Pre-flight: can this device take a local generation right now? ──
    let target = request.target;
    if (target.local) {
      const pressure = await checkDevicePressure();
      const fallback = pressure ? this.#resolveFallback() : null;

      if (pressure && fallback) {
        const event: FallbackEvent = {
          reason: pressure.reason,
          from: target.backendId,
          to: fallback.name,
          detail: pressure.detail,
        };
        this.#lastFallback = event;
        this.#options.onFallback?.(event);
        yield { type: 'fallback', event };

        target = {
          backendId: fallback.name,
          engine: 'remote',
          modelId: fallback.modelId ?? target.modelId,
          modelName: fallback.modelId ?? fallback.name,
          local: false,
        };
      }
    }

    // ── Generate, then run any tools, then generate again ───────────────
    let messages: IRMessage[] = [...request.messages];
    let text = '';
    let stats: GenerationStatsSnapshot = {};
    const tools: ExecutedTool[] = [];

    for (let iteration = 0; iteration <= TOOL_ITERATIONS; iteration += 1) {
      const irRequest = this.#toIR({ ...request, messages, target }, requestId, true);

      let turn: TurnResult;
      let failure: unknown = null;

      try {
        turn = yield* this.#runTurn(irRequest, target, request.signal);
        // A backend may report failure as an error chunk rather than by
        // throwing. Both are the same event as far as diverting goes.
        if (turn.error) failure = new Error(turn.error);
      } catch (error) {
        turn = { text: '', stats: {} };
        failure = error;
      }

      if (failure) {
        if (request.signal?.aborted) break;

        // A local failure can still divert, exactly as the middleware would.
        const fallback = target.local ? this.#resolveFallback() : null;
        if (!fallback) {
          yield {
            type: 'error',
            message: failure instanceof Error ? failure.message : String(failure),
          };
          return;
        }

        const { reason, detail } = classifyFailure(failure);
        const event: FallbackEvent = { reason, from: target.backendId, to: fallback.name, detail };
        this.#lastFallback = event;
        this.#options.onFallback?.(event);
        yield { type: 'fallback', event };

        target = {
          backendId: fallback.name,
          engine: 'remote',
          modelId: fallback.modelId ?? target.modelId,
          modelName: fallback.modelId ?? fallback.name,
          local: false,
        };
        continue;
      }

      text = turn.text;
      stats = { ...stats, ...turn.stats };

      // Tool calls only become readable once the turn has finished.
      const calls =
        request.toolIds?.length && iteration < TOOL_ITERATIONS
          ? findToolCalls({ role: 'assistant', content: turn.text })
          : [];

      if (calls.length === 0) break;

      const batch = await runToolCalls(toolRegistry, calls, { signal: request.signal });
      tools.push(...batch.executed);
      for (const tool of batch.executed) yield { type: 'tool', tool };

      if (batch.results.length === 0) break;

      messages = [
        ...messages,
        { role: 'assistant', content: [...calls] },
        { role: 'tool', content: batch.results },
      ];

      // The visible answer is whatever the model says after the tools ran.
      text = '';
    }

    const totalMs = Math.round(performance.now() - started);
    yield {
      type: 'done',
      text: stripToolSyntax(text),
      stats: {
        ...stats,
        totalMs,
        tokensPerSecond:
          stats.tokensPerSecond ??
          (stats.completionTokens
            ? Number(((stats.completionTokens / totalMs) * 1000).toFixed(2))
            : undefined),
      },
      provenance: this.#provenance(target),
      tools,
    };
  }

  /**
   * One generation turn. Yields deltas as they arrive and returns the
   * accumulated text plus whatever stats the backend reported.
   */
  async *#runTurn(
    irRequest: IRChatRequest,
    target: EngineTarget,
    signal?: AbortSignal,
  ): AsyncGenerator<GenerationEvent, TurnResult> {
    let text = '';
    let stats: GenerationStatsSnapshot = {};

    const stream = this.#bridge.chatStream(irRequest, {
      signal,
      backend: target.backendId,
    }) as AsyncGenerator<IRStreamChunk>;

    for await (const chunk of stream) {
      switch (chunk.type) {
        case 'content':
          text += chunk.delta;
          yield { type: 'delta', text: chunk.delta };
          break;

        case 'metadata':
          stats = { ...stats, ...readStats(chunk.metadata?.custom), ...readUsage(chunk.usage) };
          break;

        case 'done':
          stats = { ...stats, ...readUsage(chunk.usage) };
          break;

        case 'error':
          return { text, stats, error: chunk.error.message };

        default:
          break;
      }
    }

    return { text, stats };
  }

  #resolveFallback(): { name: string; adapter: BackendAdapter; modelId?: string } | null {
    const id = this.#options.fallbackBackendId;
    if (!id) return null;
    const adapter = this.router.get(id);
    if (!adapter) return null;
    return { name: id, adapter, modelId: this.#fallbackModels.get(id) };
  }

  /** Non-streaming completion, used by tools, titling, and benchmarks. */
  async complete(request: GenerationRequest): Promise<IRChatResponse> {
    const irRequest = this.#toIR(request, newId('req'), false);
    return (await this.#bridge.chat(irRequest, {
      signal: request.signal,
      backend: request.target.backendId,
    })) as IRChatResponse;
  }

  #provenance(target: EngineTarget): ProvenanceSnapshot {
    const fallback = this.#lastFallback;
    return {
      backendId: fallback?.to ?? target.backendId,
      engine: fallback ? 'remote' : target.engine,
      modelId: target.modelId,
      modelName: target.modelName,
      local: fallback ? false : target.local,
      fallbackFrom: fallback?.from,
      fallbackReason: fallback?.reason,
    };
  }

  #toIR(request: GenerationRequest, requestId: string, stream: boolean): IRChatRequest {
    const tools = request.toolIds?.length ? toolRegistry.toIRTools(request.toolIds) : undefined;

    return {
      messages: request.messages,
      tools,
      toolChoice: tools?.length ? 'auto' : undefined,
      parameters: {
        model: request.target.modelId,
        temperature: request.sampler?.temperature,
        topP: request.sampler?.topP,
        topK: request.sampler?.topK,
        maxTokens: request.sampler?.maxTokens,
        seed: request.sampler?.seed ?? undefined,
        stopSequences: request.sampler?.stopSequences
          ? [...request.sampler.stopSequences]
          : undefined,
        frequencyPenalty: request.sampler?.frequencyPenalty,
        presencePenalty: request.sampler?.presencePenalty,
      },
      metadata: {
        requestId,
        timestamp: Date.now(),
        provenance: { frontend: 'chatterang', router: 'chatterang-router' },
        custom: {
          // The router reads its backend selection from here.
          backend: request.target.backendId,
          local: request.target.local,
          engine: request.target.engine,
        },
      },
      stream,
      streamMode: 'delta',
    };
  }
}

/* ── Helpers ────────────────────────────────────────────────────────── */

function hasPromptApi(): boolean {
  return typeof (globalThis as { LanguageModel?: unknown }).LanguageModel !== 'undefined';
}

/**
 * The boundary where native metrics become UI state.
 *
 * Exported for tests. A metric the plugin reports but this function forgets is
 * invisible everywhere downstream, which is exactly how `draftAcceptance`
 * reached the UI layer plumbed but unread for so long.
 */
export function readStats(custom: Record<string, unknown> | undefined): GenerationStatsSnapshot {
  if (!custom) return {};
  const pick = (key: string): number | undefined =>
    typeof custom[key] === 'number' ? (custom[key] as number) : undefined;
  return {
    ttftMs: pick('ttftMs'),
    cachedTokens: pick('cachedTokens'),
    tokensPerSecond: pick('tokensPerSecond'),
    draftAcceptance: pick('draftAcceptance'),
    peakMemoryBytes: pick('peakMemoryBytes'),
    computeBackend:
      typeof custom.computeBackend === 'string' ? (custom.computeBackend as string) : undefined,
  };
}

function readUsage(
  usage: { promptTokens?: number; completionTokens?: number } | undefined,
): GenerationStatsSnapshot {
  if (!usage) return {};
  return { promptTokens: usage.promptTokens, completionTokens: usage.completionTokens };
}

/** Build an engine target from a model id and the engine that serves it. */
export function targetFor(
  engine: EngineId,
  modelId: string,
  modelName: string,
  /** Router registration name. Not an EngineId — remote connections use their
   *  own generated ids. Defaults to the engine name, which is how the local
   *  engines are registered. */
  backendId: string = engine,
): EngineTarget {
  return { backendId, engine, modelId, modelName, local: isLocalEngine(engine) };
}
