import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

import { Context } from '@deepseek-ai/cordis';
import type { Plugin } from '@deepseek-ai/cordis';
import LlmRuntime, { LlmError } from '@deepseek-ai/dsh-llm';
import type { GenerateOptions, Message, StreamChunk } from '@deepseek-ai/dsh-llm';
import { CallId, MessageId } from '@deepseek-ai/dsh-llm';
import InvariantRegistry from '@deepseek-ai/dsh-invariants';
import * as llmInvariant from '@deepseek-ai/dsh-llm/invariant';
import { ErrorCode } from '@johnhenry/aimatey-types';
import type {
  BackendAdapter,
  BackendInfo,
  IRChatRequest,
  IRStreamChunk,
} from '@johnhenry/aimatey-types';

import {
  AIMATEY_TO_DSH_CODE,
  AimateyAdapter,
  FIBER_ACTIVE,
  FIBER_STATE_NAMES,
  NOT_LOADED_MARKER,
  PASS_THROUGH_CODES,
  PROFILE_ROWS,
  ROUTER_SENTINEL,
  aimateyRouterPlugin,
  applyProfile,
  assertBoot,
  assertEntries,
  assertRoutes,
  assertServices,
  mapCode,
  renderPatchYaml,
  routesFor,
  toIRRequest,
} from '@chatterang/cordis-aimatey';
import type { AimateyRouter, MountedEntry, RouterConformance } from '@chatterang/cordis-aimatey';

/**
 * A4: aimatey's Router registered as an LLM provider inside a DSH Cordis tree.
 *
 * Two things make this suite worth reading before trusting it.
 *
 * First, the fake Router MODELS the real one rather than replaying canned
 * chunks. It reads `metadata.custom.backend` exactly where
 * `Router.executeStream` reads it, and — critically — it reproduces the real
 * Router's abort behaviour, which is to break out of its loop, count a SUCCESS
 * and return with no `done` chunk, no `error` chunk and no throw. A fake that
 * politely emitted a terminal on abort would make the adapter's hardest rule
 * untestable.
 *
 * Second, every green assertion here is backed by a negative control that shows
 * the same check failing on a real fault. `describe('negative controls')` boots
 * a tree with a row missing, and feeds the invariant a deliberately broken
 * stream, before any happy path is allowed to mean anything.
 */

/* ── Type-level conformance ───────────────────────────────────────────── */

/**
 * The adapter takes a structural `AimateyRouter`, not the concrete class, so
 * this fake can exist. This line is the proof that the structural port is still
 * a real subset of `Router`: if aimatey re-signatures one of those methods,
 * `RouterConformance` resolves to `never` and `npm run typecheck` fails here.
 */
export const routerConformance: RouterConformance = true;

/* ── The fake Router ──────────────────────────────────────────────────── */

/** One scripted backend: what it streams, in IR chunks. */
interface FakeBackend {
  /** Provider display name, as `BackendInfo.metadata.provider`. */
  provider: string;
  /** The chunks to stream, minus the `sequence` field this fake stamps. */
  script: (request: IRChatRequest) => Omit<IRStreamChunk, 'sequence'>[];
  /** Models this backend advertises, or `undefined` for "no listModels". */
  models?: { id: string; name: string }[];
  /** Throw from the stream after this many chunks, to model a transport fault. */
  throwAfter?: { chunks: number; error: Error };
}

/**
 * A Router that behaves like aimatey's on the paths this adapter depends on.
 *
 * What it models, and why each matters:
 *  - backend selection reads `request.metadata?.custom?.backend`, the one key
 *    `Router.executeStream` consults;
 *  - the abort path breaks and returns WITHOUT a terminal chunk, counting the
 *    request as successful, exactly as aimatey-core does;
 *  - `getBackendInfo`/`get`/`has`/`listBackends` answer from one registry, so a
 *    test that unregisters a backend sees it everywhere at once;
 *  - `disposed` records whether anyone called `dispose()`, because the plugin
 *    must never dispose a Router the app also holds.
 */
class FakeRouter implements AimateyRouter {
  readonly #backends = new Map<string, FakeBackend>();
  /** Every request this router was handed, for assertions on the translation. */
  readonly seen: IRChatRequest[];
  /** Backend chosen per request, in order. */
  readonly routed: string[];
  /** Availability, per backend — what `getBackendInfo` reports. */
  readonly #health = new Map<string, { isHealthy: boolean; circuitBreakerState: string }>();
  disposed = false;

  /**
   * @param seen - shared with the router this one was cloned from, so a test
   *   that asserts on `seen`/`routed` still sees a request the adapter sent
   *   through a per-request pinned CLONE rather than through this instance.
   */
  constructor(seen: IRChatRequest[] = [], routed: string[] = []) {
    this.seen = seen;
    this.routed = routed;
  }

  register(name: string, backend: FakeBackend): this {
    this.#backends.set(name, backend);
    this.#health.set(name, { isHealthy: true, circuitBreakerState: 'closed' });
    return this;
  }

  /** Model an unhealthy or breaker-tripped backend, which the real one can. */
  setHealth(name: string, health: { isHealthy?: boolean; circuitBreakerState?: string }): this {
    const current = this.#health.get(name) ?? { isHealthy: true, circuitBreakerState: 'closed' };
    this.#health.set(name, { ...current, ...health });
    return this;
  }

  unregister(name: string): this {
    this.#backends.delete(name);
    this.#health.delete(name);
    return this;
  }

  /**
   * A copy holding the same backends, sharing this one's observation log.
   *
   * Config is not modelled: what a clone's config does is asserted directly
   * against the REAL Router in `tests/cordis-aimatey-seam.test.ts`, because a
   * fake that answers config questions about itself proves nothing about
   * aimatey.
   */
  clone(): FakeRouter {
    const next = new FakeRouter(this.seen, this.routed);
    for (const [name, backend] of this.#backends) next.register(name, backend);
    for (const [name, health] of this.#health) next.#health.set(name, { ...health });
    return next;
  }

  listBackends(): readonly string[] {
    return [...this.#backends.keys()];
  }

  has(name: string): boolean {
    return this.#backends.has(name);
  }

  get(name: string): BackendAdapter | undefined {
    const backend = this.#backends.get(name);
    if (backend === undefined) return undefined;
    const listModels =
      backend.models === undefined
        ? {}
        : {
            listModels: async () => ({
              models: backend.models ?? [],
              source: 'static' as const,
              fetchedAt: Date.now(),
              isComplete: true,
            }),
          };
    // Only the members the adapter reads are modelled; the rest of
    // BackendAdapter is irrelevant to route/catalog translation.
    return { metadata: { provider: backend.provider }, ...listModels } as unknown as BackendAdapter;
  }

  getBackendInfo(name: string): BackendInfo | undefined {
    const backend = this.#backends.get(name);
    if (backend === undefined) return undefined;
    const health = this.#health.get(name) ?? { isHealthy: true, circuitBreakerState: 'closed' };
    return {
      name,
      adapter: this.get(name) as BackendAdapter,
      metadata: { name, version: '0.0.0', provider: backend.provider },
      // Both fields are REQUIRED on the real `BackendInfo`. An earlier version
      // hardcoded `isHealthy: true` and omitted `circuitBreakerState` entirely
      // behind the cast below — so every availability assertion written against
      // this fake passed for free.
      isHealthy: health.isHealthy,
      circuitBreakerState: health.circuitBreakerState,
    } as unknown as BackendInfo;
  }

  dispose(): void {
    this.disposed = true;
  }

  async *executeStream(
    request: IRChatRequest,
    signal?: AbortSignal,
  ): AsyncGenerator<IRStreamChunk, void, undefined> {
    this.seen.push(request);
    const preferred = request.metadata.custom?.['backend'];
    const name =
      typeof preferred === 'string' && this.#backends.has(preferred)
        ? preferred
        : (this.listBackends()[0] ?? '');
    this.routed.push(name);
    const backend = this.#backends.get(name);
    if (backend === undefined) {
      yield {
        type: 'error',
        sequence: 0,
        error: { code: ErrorCode.NO_BACKEND_AVAILABLE, message: `no backend "${name}"` },
      };
      return;
    }

    let sequence = 0;
    for (const chunk of backend.script(request)) {
      // Verbatim from aimatey-core: the signal is checked BEFORE yielding, and
      // an abort breaks out with no terminal chunk of any kind.
      if (signal?.aborted === true) return;
      if (backend.throwAfter !== undefined && sequence >= backend.throwAfter.chunks) {
        throw backend.throwAfter.error;
      }
      yield { ...chunk, sequence: sequence++ } as IRStreamChunk;
    }
  }
}

/* ── Test-tree helpers ────────────────────────────────────────────────── */

/** The plugin modules a profile row maps to on this target. */
function profileModules(router: AimateyRouter): Map<string, Plugin> {
  return new Map<string, Plugin>([
    ['@deepseek-ai/dsh-llm', LlmRuntime as unknown as Plugin],
    ['@deepseek-ai/dsh-invariants', InvariantRegistry as unknown as Plugin],
    ['@deepseek-ai/dsh-llm/invariant', llmInvariant as unknown as Plugin],
    [
      '@chatterang/cordis-aimatey',
      { ...aimateyRouterPlugin, apply: (inner: Context) => aimateyRouterPlugin.apply(inner, { router }) },
    ],
  ]);
}

/** Boot the narrowed profile, optionally leaving rows out. */
async function boot(router: AimateyRouter, omit: string[] = []): Promise<Context> {
  return (await bootWithEntries(router, omit)).ctx;
}

/** The same boot, keeping the fibers `applyProfile` hands back. */
async function bootWithEntries(
  router: AimateyRouter,
  omit: string[] = [],
): Promise<{ ctx: Context; entries: MountedEntry[] }> {
  const ctx = new Context();
  const rows = PROFILE_ROWS.filter((row) => !omit.includes(row.id));
  const entries = await applyProfile(ctx, profileModules(router), rows);
  // Pending fibers settle on a microtask once their services appear.
  await new Promise((done) => setTimeout(done, 0));
  return { ctx, entries };
}

/** A minimal DSH request. */
function request(overrides: Partial<GenerateOptions> = {}): GenerateOptions {
  return { provider: ROUTER_SENTINEL, model: 'test-model', messages: [], ...overrides };
}

/** Drain a stream, returning every chunk the consumer actually saw. */
async function drain(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

/** The one terminal chunk, asserting there is exactly one and it is last. */
function terminalOf(chunks: StreamChunk[]): Extract<StreamChunk, { type: 'finish' }> {
  const finishes = chunks.filter((chunk) => chunk.type === 'finish');
  expect(finishes).toHaveLength(1);
  expect(chunks.at(-1)?.type).toBe('finish');
  return finishes[0] as Extract<StreamChunk, { type: 'finish' }>;
}

/** A backend that streams plain text and stops. */
const echoBackend: FakeBackend = {
  provider: 'Echo Inc',
  models: [{ id: 'echo-1', name: 'Echo One' }],
  script: () => [
    { type: 'start', metadata: { requestId: 'r', timestamp: 0, provenance: { backend: 'echo' } } },
    { type: 'content', delta: 'Hel' },
    { type: 'content', delta: 'lo' },
    { type: 'done', finishReason: 'stop', usage: { promptTokens: 7, completionTokens: 3, totalTokens: 10 } },
  ],
};

/* ── Negative controls, first ─────────────────────────────────────────── */

describe('negative controls: the checks can see a fault', () => {
  it('the boot assertion fails when the aimatey-router row is missing', async () => {
    const ctx = await boot(new FakeRouter().register('echo', echoBackend), ['aimatey-router']);
    // The tree is otherwise healthy: `llm` is there, the plugin simply is not.
    expect(ctx.get('llm')).toBeDefined();
    expect(() => assertBoot(ctx, { services: ['llm', 'invariants'], routes: [ROUTER_SENTINEL] })).toThrow(
      /provider route\(s\) not registered: aimatey/,
    );
  });

  it('the boot assertion fails, naming `llm`, when the dsh-llm row is missing', async () => {
    const router = new FakeRouter().register('echo', echoBackend);
    const ctx = await boot(router, ['llm']);
    // This is the trap the assertion exists for: Cordis parked the plugin in
    // PENDING and `applyProfile` awaited every fiber without complaint.
    expect(() => assertServices(ctx, ['llm', 'invariants'])).toThrow(/service\(s\) absent after boot: llm/);
  });

  it('the invariant companion is armed: a delta with no block-start throws', async () => {
    // If this passes silently, every "the sequence is legal" assertion below is
    // worthless, because nothing would be checking the grammar.
    const ctx = await boot(new FakeRouter().register('echo', echoBackend), ['aimatey-router']);
    const { LlmAdapter } = await import('@deepseek-ai/dsh-llm');
    class Broken extends LlmAdapter {
      override providerInfo(provider: string) {
        return { id: provider, name: 'broken' };
      }
      async *stream(): AsyncGenerator<StreamChunk, void, undefined> {
        yield { type: 'text-delta', index: 0, text: 'no block was opened' };
        yield { type: 'finish', reason: { kind: 'stop' } };
      }
    }
    ctx.llm.registerAdapter(['broken'], new Broken());
    await expect(drain(ctx.llm.stream(request({ provider: 'broken' })))).rejects.toThrow(
      /requires an open text block/,
    );
  });

  it('a stream that ends with no terminal is caught by the invariant', async () => {
    const ctx = await boot(new FakeRouter().register('echo', echoBackend), ['aimatey-router']);
    const { LlmAdapter } = await import('@deepseek-ai/dsh-llm');
    class Silent extends LlmAdapter {
      override providerInfo(provider: string) {
        return { id: provider, name: 'silent' };
      }
      // eslint-disable-next-line require-yield
      async *stream(): AsyncGenerator<StreamChunk, void, undefined> {
        return;
      }
    }
    ctx.llm.registerAdapter(['silent'], new Silent());
    await expect(drain(ctx.llm.stream(request({ provider: 'silent' })))).rejects.toThrow(
      /ended without a terminal finish chunk/,
    );
  });
});

/* ── The terminal-finish rule ─────────────────────────────────────────── */

describe('every stream ends with exactly one terminal finish', () => {
  it('on success', async () => {
    const router = new FakeRouter().register('echo', echoBackend);
    const ctx = await boot(router);
    const chunks = await drain(ctx.llm.stream(request()));

    expect(chunks.map((chunk) => chunk.type)).toEqual([
      'block-start',
      'text-delta',
      'text-delta',
      'block-end',
      'usage',
      'finish',
    ]);
    expect(terminalOf(chunks).reason).toEqual({ kind: 'stop' });
    expect(chunks[3]).toEqual({ type: 'block-end', index: 0, block: { type: 'text', text: 'Hello' } });
  });

  it('on error — an IR error chunk becomes a terminal error finish with a mapped code', async () => {
    const router = new FakeRouter().register('flaky', {
      provider: 'Flaky',
      script: () => [
        { type: 'content', delta: 'partial' },
        {
          type: 'error',
          error: { code: ErrorCode.RATE_LIMIT_EXCEEDED, message: 'slow down' },
        },
      ],
    });
    const ctx = await boot(router);
    const chunks = await drain(ctx.llm.stream(request()));

    const terminal = terminalOf(chunks);
    expect(terminal.reason.kind).toBe('error');
    // The whole point of the mapping table: a raw aimatey code would have been
    // laundered into 'UNKNOWN' by normalizeLlmFailure.
    expect(terminal.reason).toMatchObject({ failure: { code: 'RATE_LIMIT', message: 'slow down' } });
    // The partial text is still closed off, so the assembler keeps what arrived.
    expect(chunks.map((chunk) => chunk.type)).toEqual(['block-start', 'text-delta', 'block-end', 'finish']);
  });

  it('on abort — even though the Router returns no terminal chunk at all', async () => {
    const controller = new AbortController();
    const router = new FakeRouter().register('slow', {
      provider: 'Slow',
      script: () => [
        { type: 'content', delta: 'begin' },
        // The fake aborts mid-stream and then returns, exactly as aimatey-core
        // does: no done chunk, no error chunk, no throw.
        { type: 'content', delta: 'never reaches the consumer' },
      ],
    });
    const ctx = await boot(router);

    const chunks: StreamChunk[] = [];
    for await (const chunk of ctx.llm.stream(request({ signal: controller.signal }))) {
      chunks.push(chunk);
      if (chunk.type === 'text-delta') controller.abort();
    }

    const terminal = terminalOf(chunks);
    expect(terminal.reason.kind).toBe('aborted');
    expect(terminal.reason).toMatchObject({ failure: { code: 'ABORTED' } });
  });

  it('on a silent exhaustion that is not an abort — EMPTY_RESPONSE, not a fake stop', async () => {
    // Reachable for real: src/ai/backends/llama-cpp.ts returns early when
    // generation produced no result, and the Router forwards that clean end as
    // a success.
    const router = new FakeRouter().register('empty', { provider: 'Empty', script: () => [] });
    const ctx = await boot(router);
    const terminal = terminalOf(await drain(ctx.llm.stream(request())));

    expect(terminal.reason).toEqual({
      kind: 'error',
      failure: {
        code: 'EMPTY_RESPONSE',
        message: 'provider stream ended without a terminal chunk',
      },
    });
  });

  it('on a throw from inside the Router', async () => {
    const router = new FakeRouter().register('boom', {
      provider: 'Boom',
      script: () => [{ type: 'content', delta: 'a' }, { type: 'content', delta: 'b' }],
      throwAfter: { chunks: 1, error: Object.assign(new Error('socket died'), { code: 'NETWORK_ERROR' }) },
    });
    const ctx = await boot(router);
    const terminal = terminalOf(await drain(ctx.llm.stream(request())));

    expect(terminal.reason).toMatchObject({
      kind: 'error',
      failure: { code: 'TRANSPORT', message: 'socket died' },
    });
  });

  it('content_filter is reported as a failure, not as a normal stop', async () => {
    const router = new FakeRouter().register('filtered', {
      provider: 'Filtered',
      script: () => [{ type: 'content', delta: 'hi' }, { type: 'done', finishReason: 'content_filter' }],
    });
    const ctx = await boot(router);
    const terminal = terminalOf(await drain(ctx.llm.stream(request())));

    expect(terminal.reason).toMatchObject({ kind: 'error', failure: { code: 'CONTENT_FILTER' } });
  });

  it('a second terminal is impossible: chunks after `done` are never reached', async () => {
    // The IR permits nonsense; DSH does not. An adapter that forwarded a chunk
    // after the terminal would trip "emitted <type> after terminal finish".
    const router = new FakeRouter().register('chatty', {
      provider: 'Chatty',
      script: () => [
        { type: 'content', delta: 'one' },
        { type: 'done', finishReason: 'stop' },
        { type: 'content', delta: 'after the end' },
        { type: 'done', finishReason: 'length' },
      ],
    });
    const ctx = await boot(router);
    const chunks = await drain(ctx.llm.stream(request()));

    expect(chunks.filter((chunk) => chunk.type === 'finish')).toHaveLength(1);
    expect(terminalOf(chunks).reason).toEqual({ kind: 'stop' });
    expect(chunks.filter((chunk) => chunk.type === 'text-delta')).toHaveLength(1);
  });
});

/* ── Usage ────────────────────────────────────────────────────────────── */

describe('usage', () => {
  it('is emitted exactly once even when the backend reports it twice', async () => {
    // This is the llama-cpp shape from this very repo: usage on a metadata
    // chunk at :359 AND on the done chunk at :382. Forwarding both would trip
    // "LLM stream emitted usage more than once".
    const router = new FakeRouter().register('llama', {
      provider: 'llama.cpp',
      script: () => [
        { type: 'content', delta: 'hi' },
        {
          type: 'metadata',
          usage: { promptTokens: 11, completionTokens: 2, totalTokens: 13 },
          metadata: { custom: { tokensPerSecond: 42 } },
        },
        { type: 'done', finishReason: 'stop', usage: { promptTokens: 11, completionTokens: 2, totalTokens: 13 } },
      ],
    });
    const ctx = await boot(router);
    const chunks = await drain(ctx.llm.stream(request()));

    const usage = chunks.filter((chunk) => chunk.type === 'usage');
    expect(usage).toHaveLength(1);
    expect(usage[0]).toEqual({ type: 'usage', usage: { inputTokens: 11, outputTokens: 2 } });
  });

  it('comes immediately before the finish, never after', async () => {
    const router = new FakeRouter().register('echo', echoBackend);
    const ctx = await boot(router);
    const chunks = await drain(ctx.llm.stream(request()));

    const usageAt = chunks.findIndex((chunk) => chunk.type === 'usage');
    const finishAt = chunks.findIndex((chunk) => chunk.type === 'finish');
    expect(usageAt).toBeGreaterThanOrEqual(0);
    expect(finishAt).toBe(usageAt + 1);
  });

  it('leaves cache and reasoning counts undefined rather than zero', async () => {
    // undefined means "not measured"; 0 would mean "measured, and it was zero".
    // A plausible-looking zero is how a real regression becomes invisible.
    const router = new FakeRouter().register('echo', echoBackend);
    const ctx = await boot(router);
    const chunks = await drain(ctx.llm.stream(request()));
    const usage = chunks.find((chunk) => chunk.type === 'usage');

    expect(usage).toBeDefined();
    const reported = (usage as Extract<StreamChunk, { type: 'usage' }>).usage;
    expect('cacheReadTokens' in reported).toBe(false);
    expect('cacheWriteTokens' in reported).toBe(false);
    expect('reasoningTokens' in reported).toBe(false);
  });

  it('is omitted entirely when the backend never reported any', async () => {
    const router = new FakeRouter().register('quiet', {
      provider: 'Quiet',
      script: () => [{ type: 'content', delta: 'hi' }, { type: 'done', finishReason: 'stop' }],
    });
    const ctx = await boot(router);
    const chunks = await drain(ctx.llm.stream(request()));

    expect(chunks.some((chunk) => chunk.type === 'usage')).toBe(false);
    expect(terminalOf(chunks).reason).toEqual({ kind: 'stop' });
  });
});

/* ── Tool calls ───────────────────────────────────────────────────────── */

describe('tool calls', () => {
  it('frames a streamed tool call and concatenates the raw JSON fragments', async () => {
    const router = new FakeRouter().register('tools', {
      provider: 'Tools',
      script: () => [
        { type: 'tool_use', id: 'call_1', name: 'get_weather', inputDelta: '', index: 0 },
        { type: 'tool_use', id: 'call_1', name: 'get_weather', inputDelta: '{"loc', index: 0 },
        { type: 'tool_use', id: 'call_1', name: 'get_weather', inputDelta: 'ation":"SF"}', index: 0 },
        { type: 'done', finishReason: 'tool_calls' },
      ],
    });
    const ctx = await boot(router);
    const chunks = await drain(ctx.llm.stream(request()));

    expect(chunks.map((chunk) => chunk.type)).toEqual([
      'block-start',
      'tool-call-delta',
      'tool-call-delta',
      'tool-call-delta',
      'block-end',
      'finish',
    ]);
    expect(chunks[0]).toEqual({ type: 'block-start', index: 0, blockType: 'tool-call' });
    expect(chunks[4]).toEqual({
      type: 'block-end',
      index: 0,
      block: {
        type: 'tool-call',
        id: 'call_1',
        name: 'get_weather',
        // Raw, exactly as streamed: never parsed and re-serialized.
        arguments: '{"location":"SF"}',
      },
    });
    expect(terminalOf(chunks).reason).toEqual({ kind: 'tool-calls' });
  });

  it('gives each tool-call id its own block index, keyed on the id not the IR index', async () => {
    // StreamToolUseChunk.index is a tool-call ordinal in its own numbering
    // space; treating it as a DSH block index is the classic way to collide
    // with the text block at index 0.
    const router = new FakeRouter().register('tools', {
      provider: 'Tools',
      script: () => [
        { type: 'content', delta: 'thinking aloud' },
        { type: 'tool_use', id: 'a', name: 'one', inputDelta: '{}', index: 0 },
        { type: 'tool_use', id: 'b', name: 'two', inputDelta: '{}', index: 1 },
        { type: 'done', finishReason: 'tool_calls' },
      ],
    });
    const ctx = await boot(router);
    const chunks = await drain(ctx.llm.stream(request()));

    const starts = chunks.filter((chunk) => chunk.type === 'block-start');
    expect(starts).toEqual([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'block-start', index: 1, blockType: 'tool-call' },
      { type: 'block-start', index: 2, blockType: 'tool-call' },
    ]);
    expect(chunks.filter((chunk) => chunk.type === 'block-end')).toHaveLength(3);
  });
});

/* ── Request translation ──────────────────────────────────────────────── */

describe('request translation', () => {
  const message = (role: Message['role'], content: Message['content']): Message => ({
    id: MessageId('m1'),
    role,
    content,
    source: { kind: 'user' },
  });

  it('pins the backend through metadata.custom.backend, and omits it for the sentinel', () => {
    expect(toIRRequest(request(), 'ollama').metadata.custom).toMatchObject({ backend: 'ollama' });
    expect(toIRRequest(request(), undefined).metadata.custom).not.toHaveProperty('backend');
  });

  it('routes to the named backend and lets the sentinel fall through', async () => {
    const router = new FakeRouter().register('one', echoBackend).register('two', echoBackend);
    const ctx = await boot(router);

    await drain(ctx.llm.stream(request({ provider: 'two' })));
    await drain(ctx.llm.stream(request({ provider: ROUTER_SENTINEL })));

    // Second call had no preference, so the fake picked its first backend —
    // the same "router decides" behaviour the sentinel exists to expose.
    expect(router.routed).toEqual(['two', 'one']);
  });

  it('prepends the system slot as a message and keeps an existing system message', () => {
    const ir = toIRRequest(
      request({ system: 'be brief', messages: [message('system', [{ type: 'text', text: 'be kind' }])] }),
      undefined,
    );
    // Both survive, in order. Merging them would be an invention.
    expect(ir.messages).toHaveLength(2);
    expect(ir.messages[0]).toEqual({ role: 'system', content: 'be brief' });
    expect(ir.messages[1]).toEqual({ role: 'system', content: [{ type: 'text', text: 'be kind' }] });
  });

  it('sets streamMode delta and stream true', () => {
    const ir = toIRRequest(request(), undefined);
    expect(ir.stream).toBe(true);
    // Under 'accumulated' each chunk carries the whole text so far; forwarding
    // that as a delta would repeat the message.
    expect(ir.streamMode).toBe('delta');
  });

  it('copies only the sampler fields DSH can express', () => {
    const ir = toIRRequest(
      request({ temperature: 0.3, maxTokens: 64, stop: ['END'] }),
      undefined,
    );
    expect(ir.parameters).toEqual({
      model: 'test-model',
      temperature: 0.3,
      maxTokens: 64,
      stopSequences: ['END'],
    });
    // topP/topK/seed/user are absent on purpose: a DSH caller who set nothing
    // must get the provider's defaults, not chatterang's.
  });

  it('turns a single tool-result message into an IR `tool` role', () => {
    const toolResult = message('user', [
      { type: 'tool-result', toolCallId: CallId('c1'), content: [{ type: 'text', text: '72F' }] },
    ]);
    const ir = toIRRequest(request({ messages: [toolResult] }), ROUTER_SENTINEL);

    expect(ir.messages[0]).toEqual({
      role: 'tool',
      content: [{ type: 'tool_result', toolUseId: 'c1', content: [{ type: 'text', text: '72F' }] }],
    });
  });

  it('warns rather than silently flattening a non-text block inside a tool result', () => {
    const warnings: string[] = [];
    const toolResult = message('user', [
      {
        type: 'tool-result',
        toolCallId: CallId('c1'),
        content: [
          { type: 'text', text: 'here it is' },
          { type: 'tool-call', id: CallId('nested'), name: 'x', arguments: '{}' },
        ],
      },
    ]);
    toIRRequest(request({ messages: [toolResult] }), ROUTER_SENTINEL, {
      warn: (line) => warnings.push(line),
    });

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('tool-call');
    expect(warnings[0]).toContain('c1');
  });

  it('parses assistant tool-call arguments, and refuses rather than substituting {}', () => {
    const ok = toIRRequest(
      request({
        messages: [message('assistant', [{ type: 'tool-call', id: CallId('c1'), name: 'f', arguments: '{"a":1}' }])],
      }),
      undefined,
    );
    expect(ok.messages[0]).toEqual({
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'c1', name: 'f', input: { a: 1 } }],
    });

    expect(() =>
      toIRRequest(
        request({
          messages: [message('assistant', [{ type: 'tool-call', id: CallId('c2'), name: 'f', arguments: '{"a":' }])],
        }),
        undefined,
      ),
    ).toThrow(LlmError);
  });

  it('drops reasoning blocks and says how many, because the IR has no reasoning channel', () => {
    const notes: string[] = [];
    const ir = toIRRequest(
      request({
        messages: [
          message('assistant', [
            { type: 'reasoning', text: 'hmm' },
            { type: 'text', text: 'answer' },
            { type: 'reasoning', text: 'hmm again' },
          ]),
        ],
      }),
      undefined,
      { debug: (line) => notes.push(line) },
    );

    expect(ir.messages[0]?.content).toEqual([{ type: 'text', text: 'answer' }]);
    expect(notes.join('\n')).toContain('dropped 2 reasoning block(s)');
  });

  it('never mutates a frozen request', () => {
    const frozen = Object.freeze(request({ stop: Object.freeze(['END']) as unknown as string[] }));
    expect(() => toIRRequest(frozen, ROUTER_SENTINEL)).not.toThrow();
  });
});

/* ── Adapter surface ──────────────────────────────────────────────────── */

describe('adapter surface', () => {
  it('names the sentinel route and takes backend display names from the router', async () => {
    const router = new FakeRouter().register('echo', echoBackend);
    const adapter = new AimateyAdapter({ router });

    expect(adapter.providerInfo(ROUTER_SENTINEL)).toEqual({ id: ROUTER_SENTINEL, name: 'aimatey (router)' });
    expect(adapter.providerInfo('echo')).toEqual({ id: 'echo', name: 'Echo Inc' });
    // Falls back to the route itself rather than to an empty name, which would
    // fail registration with INVALID_ADAPTER.
    expect(adapter.providerInfo('gone')).toEqual({ id: 'gone', name: 'gone' });
  });

  it('advertises models only where a backend implements listModels', async () => {
    const router = new FakeRouter()
      .register('echo', echoBackend)
      .register('bare', { provider: 'Bare', script: () => [] });
    const adapter = new AimateyAdapter({ router });

    await expect(adapter.listModels('echo')).resolves.toEqual([
      { provider: 'echo', id: 'echo-1', name: 'Echo One' },
    ]);
    // The Router class has no listModels of its own, so the sentinel has
    // nothing to advertise; [] is explicitly legal and advisory.
    await expect(adapter.listModels(ROUTER_SENTINEL)).resolves.toEqual([]);
    await expect(adapter.listModels('bare')).resolves.toEqual([]);
  });

  it('declares text-only input and no reasoning support', async () => {
    const adapter = new AimateyAdapter({ router: new FakeRouter() });
    const resolved = await adapter.resolveModel(ROUTER_SENTINEL, 'some-model');

    // id must be the requested string verbatim or the registry rejects it.
    expect(resolved).toEqual({
      provider: ROUTER_SENTINEL,
      id: 'some-model',
      name: 'some-model',
      inputModalities: ['text'],
    });
    expect(resolved).not.toHaveProperty('reasoning');
    expect(resolved).not.toHaveProperty('context');
    expect(resolved).not.toHaveProperty('defaultMaxTokens');
  });

  it('refuses a reasoningEffort request at the boundary instead of ignoring it', async () => {
    const router = new FakeRouter().register('echo', echoBackend);
    const ctx = await boot(router);
    const terminal = terminalOf(
      await drain(
        ctx.llm.stream(request({ reasoningEffort: 'high' as GenerateOptions['reasoningEffort'] })),
      ),
    );

    expect(terminal.reason).toMatchObject({
      kind: 'error',
      failure: { code: 'UNSUPPORTED_REASONING_EFFORT' },
    });
    // Refused before any provider I/O.
    expect(router.seen).toHaveLength(0);
  });

  it('declares a retry policy that does not retry, since aimatey already does', () => {
    const adapter = new AimateyAdapter({ router: new FakeRouter() });
    const policy = adapter.providerRetryPolicy('echo');
    expect(policy.mode).toBe('normal');
    expect(policy).toMatchObject({ maxRetries: 0 });
    // retryableCodes must stay non-empty even at maxRetries 0.
    expect((policy as { retryableCodes: readonly string[] }).retryableCodes.length).toBeGreaterThan(0);
  });
});

/* ── Registration lifecycle ───────────────────────────────────────────── */

describe('registration lifecycle', () => {
  it('claims the sentinel plus one route per backend', () => {
    const router = new FakeRouter().register('echo', echoBackend).register('ollama', echoBackend);
    expect(routesFor(router)).toEqual([ROUTER_SENTINEL, 'echo', 'ollama']);
  });

  it('drops the sentinel, loudly, when a backend has taken that name', () => {
    // registerAdapter is all-or-nothing: a duplicate anywhere throws
    // DUPLICATE_ADAPTER and NOTHING registers. Losing the sentinel beats losing
    // the mount.
    const router = new FakeRouter().register(ROUTER_SENTINEL, echoBackend);
    const warnings: string[] = [];
    const routes = routesFor(router, (line) => warnings.push(line));

    expect(routes).toEqual([ROUTER_SENTINEL]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('reserved name');
  });

  it('pins a backend that took the reserved name, instead of letting the router choose', async () => {
    // The warning routesFor emits says the reserved name "now pins that
    // backend". It did the opposite: `stream` compared the route against the
    // ROUTER_SENTINEL constant, so the request took the router-choose branch
    // and the real backend named "aimatey" was reachable through no pinned
    // route at all. Two other backends are registered so a router-choose would
    // have something else to pick.
    const router = new FakeRouter()
      .register(ROUTER_SENTINEL, echoBackend)
      .register('alpha', echoBackend)
      .register('beta', echoBackend);
    const ctx = await boot(router);

    const terminal = terminalOf(await drain(ctx.llm.stream(request({ provider: ROUTER_SENTINEL }))));
    expect(terminal.reason).toEqual({ kind: 'stop' });

    // The pin is carried, and it names the backend rather than being absent.
    expect(router.seen.at(-1)?.metadata?.custom).toMatchObject({ backend: ROUTER_SENTINEL });
    expect(router.routed.at(-1)).toBe(ROUTER_SENTINEL);
  });

  it('still lets the router choose when no backend has taken the reserved name', async () => {
    // The other half: the sentinel must keep working as "let the Router pick"
    // in the ordinary case, so the fix above cannot have simply deleted it.
    const router = new FakeRouter().register('alpha', echoBackend);
    const ctx = await boot(router);

    const terminal = terminalOf(await drain(ctx.llm.stream(request({ provider: ROUTER_SENTINEL }))));
    expect(terminal.reason).toEqual({ kind: 'stop' });
    expect(router.seen.at(-1)?.metadata?.custom ?? {}).not.toHaveProperty('backend');
  });

  it('registers every route, and after dispose the provider is gone', async () => {
    const router = new FakeRouter().register('echo', echoBackend);
    const ctx = new Context();
    await ctx.plugin(InvariantRegistry as unknown as Plugin);
    await ctx.plugin(LlmRuntime as unknown as Plugin);
    await ctx.plugin(llmInvariant as unknown as Plugin);
    const fiber = await ctx.plugin(
      { ...aimateyRouterPlugin, apply: (inner) => aimateyRouterPlugin.apply(inner, { router }) },
      undefined,
    );
    await new Promise((done) => setTimeout(done, 0));

    expect(ctx.llm.listProviders().map((provider) => provider.id)).toEqual([ROUTER_SENTINEL, 'echo']);
    const before = terminalOf(await drain(ctx.llm.stream(request({ provider: 'echo' }))));
    expect(before.reason).toEqual({ kind: 'stop' });

    fiber.dispose();
    await new Promise((done) => setTimeout(done, 0));

    expect(ctx.llm.listProviders()).toEqual([]);
    const after = terminalOf(await drain(ctx.llm.stream(request({ provider: 'echo' }))));
    expect(after.reason).toMatchObject({ kind: 'error', failure: { code: 'NO_ADAPTER' } });
    // The app holds the same Router and owns its health-check timer.
    expect(router.disposed).toBe(false);
  });

  it('refuses a call for a backend that has gone away since mount', async () => {
    const router = new FakeRouter().register('echo', echoBackend);
    const ctx = await boot(router);
    router.unregister('echo');

    const terminal = terminalOf(await drain(ctx.llm.stream(request({ provider: 'echo' }))));
    expect(terminal.reason).toMatchObject({
      kind: 'error',
      failure: { code: 'NO_BACKEND_AVAILABLE' },
    });
  });
});

/* ── Boot assertion ───────────────────────────────────────────────────── */

describe('boot assertion', () => {
  it('passes on a complete tree and reports what it could not check', async () => {
    const { ctx, entries } = await bootWithEntries(new FakeRouter().register('echo', echoBackend));
    const report = assertBoot(ctx, {
      services: ['llm', 'invariants'],
      routes: [ROUTER_SENTINEL, 'echo'],
      entries,
    });

    expect(report.services).toEqual(['llm', 'invariants']);
    expect(report.routes).toEqual([ROUTER_SENTINEL, 'echo']);
    // LAYER 3, which used to be a sentence explaining why it did not exist.
    // [15] renamed `treeAssertion` to `notChecked` because both of its branches
    // described a walk that never ran; the walk now runs, over the fibers
    // `applyProfile` returns, and `notChecked` describes what is genuinely
    // left rather than the missing layer.
    expect(report.entries).toEqual(['llm', 'invariants', 'llm-invariant', 'aimatey-router']);
    expect(report.notChecked).toMatch(/^plugins mounted outside the 4 row\(s\) supplied/);
    expect(report).not.toHaveProperty('treeAssertion');
  });

  it('still says so when no entries are supplied, rather than reporting a walk', async () => {
    // A caller that built its tree some other way has no fibers to hand in.
    // The assertion that cannot run must SAY it did not run — this is the
    // branch that keeps `notChecked` honest now that the other one is real.
    const ctx = await boot(new FakeRouter().register('echo', echoBackend));
    const report = assertBoot(ctx, { services: ['llm'] });
    expect(report.entries).toEqual([]);
    expect(report.notChecked).toMatch(/^the per-entry tree walk: no mounted rows were supplied/);
  });

  /* ── LAYER 3: the per-entry walk ────────────────────────────────────── */

  it('reads the const-enum ordinals off REAL fibers rather than trusting the table', async () => {
    // `FiberState` is a `const enum` (cordis lib/types/fiber.d.ts:67) with NO
    // runtime export: importing it and reading a member yields `undefined`, so
    // the walk compares against a literal. A literal copied wrong would make
    // every fiber look wrong or every fiber look fine, and nothing else in this
    // repo would notice. So the ordinals are checked against fibers whose state
    // we know from the outside.
    expect(FIBER_STATE_NAMES[FIBER_ACTIVE]).toBe('ACTIVE');

    const healthy = await bootWithEntries(new FakeRouter().register('echo', echoBackend));
    for (const entry of healthy.entries) {
      expect(FIBER_STATE_NAMES[entry.fiber.state]).toBe('ACTIVE');
    }

    // The same row, with the service it injects removed: Cordis parks it and
    // resolves the fiber anyway. This is the state the whole file exists for.
    const parked = await bootWithEntries(new FakeRouter().register('echo', echoBackend), ['llm']);
    const router = parked.entries.find((entry) => entry.id === 'aimatey-router');
    expect(router).toBeDefined();
    expect(FIBER_STATE_NAMES[router!.fiber.state]).toBe('PENDING');
    expect(router!.fiber.state).not.toBe(FIBER_ACTIVE);
  });

  it('fails loudly when a row throws AT mount — that case never needed a walk', async () => {
    // Worth pinning, because it bounds what layer 3 is for. `ctx.plugin()`
    // returns `Fiber & PromiseLike<Fiber>`, and awaiting it REJECTS when the
    // plugin's `apply` throws while that await is outstanding. Mounting
    // `llm-invariant` twice does exactly that — the invariant registry refuses
    // a second registration of the same package — so `applyProfile` throws and
    // no assertion is involved at all.
    const ctx = new Context();
    await expect(
      applyProfile(ctx, profileModules(new FakeRouter().register('echo', echoBackend)), [
        ...PROFILE_ROWS,
        { id: 'llm-invariant-again', name: '@deepseek-ai/dsh-llm/invariant' },
      ]),
    ).rejects.toThrow(/already registered/);
  });

  it('catches a dead row that layers 1 and 2 cannot see at all', async () => {
    // THE CASE FOR LAYER 3, and the reason it is not covered by the test above.
    // A row whose `inject` is unsatisfied at mount is PARKED: `await` on its
    // fiber resolves cleanly, `applyProfile` returns, and the plugin's `apply`
    // runs LATER — when the service it waited for appears. A throw at that
    // point has no caller left to reject: the fiber goes FAILED in silence.
    //
    // Row order is what makes this reachable, and the profile's own header
    // says order carries no load semantics — so a reordering is a legal edit
    // that can produce exactly this. Both `llm-invariant` rows here mount
    // BEFORE the `invariants` registry they inject, so both park; when the
    // registry arrives, the first registers `@deepseek-ai/dsh-llm` and the
    // second is refused.
    //
    // `llm-invariant` also provides no service and claims no provider route,
    // so layers 1 and 2 are structurally blind to it — the stream grammar goes
    // unenforced while every other assertion passes.
    const ctx = new Context();
    const entries = await applyProfile(
      ctx,
      profileModules(new FakeRouter().register('echo', echoBackend)),
      [
        { id: 'llm-invariant', name: '@deepseek-ai/dsh-llm/invariant' },
        { id: 'llm-invariant-again', name: '@deepseek-ai/dsh-llm/invariant' },
        { id: 'llm', name: '@deepseek-ai/dsh-llm' },
        { id: 'invariants', name: '@deepseek-ai/dsh-invariants' },
        { id: 'aimatey-router', name: '@chatterang/cordis-aimatey' },
      ],
    );
    await new Promise((done) => setTimeout(done, 0));

    // Layers 1 and 2 are perfectly happy.
    expect(() => assertServices(ctx, ['llm', 'invariants'])).not.toThrow();
    expect(() => assertRoutes(ctx, [ROUTER_SENTINEL, 'echo'])).not.toThrow();

    // Layer 3 is not.
    expect(() => assertEntries(entries)).toThrow(/llm-invariant-again/);
    expect(() => assertEntries(entries)).toThrow(/is FAILED/);
    // And assertBoot fails for the same reason once it is given the entries.
    expect(() =>
      assertBoot(ctx, { services: ['llm', 'invariants'], routes: [ROUTER_SENTINEL], entries }),
    ).toThrow(/did not activate/);
  });

  it('names every stuck row and the state it is in, not just the first', () => {
    // Synthetic entries, because a real tree cannot be held still in DISPOSED
    // and UNLOADING at the same time — and because a message that reported one
    // row would send a reader back for a second run to find the next.
    expect(() =>
      assertEntries([
        { id: 'a', name: '@x/a', fiber: { state: 0 } },
        { id: 'b', name: '@x/b', fiber: { state: 2 } },
        { id: 'c', name: '@x/c', fiber: { state: 3 } },
        { id: 'd', name: '@x/d', fiber: { state: 99 } },
      ]),
    ).toThrow(/a \(@x\/a\) is PENDING, c \(@x\/c\) is FAILED, d \(@x\/d\) is UNKNOWN\(99\)/);
  });

  it('accepts a tree in which every row is ACTIVE', () => {
    expect(() => assertEntries([{ id: 'a', name: '@x/a', fiber: { state: FIBER_ACTIVE } }])).not.toThrow();
    expect(() => assertEntries([])).not.toThrow();
  });

  it('names every missing service, not just the first', () => {
    const ctx = new Context();
    expect(() => assertServices(ctx, ['llm', 'invariants'])).toThrow(/llm, invariants/);
  });

  it('reports what IS registered when a route is missing', async () => {
    const ctx = await boot(new FakeRouter().register('echo', echoBackend));
    expect(() => assertRoutes(ctx, ['nope'])).toThrow(/Registered routes: aimatey, echo/);
  });

  it('refuses to assert routes when the llm service is absent', () => {
    const ctx = new Context();
    expect(() => assertRoutes(ctx, [ROUTER_SENTINEL])).toThrow(/`llm` service is absent/);
  });
});

/* ── Profile ──────────────────────────────────────────────────────────── */

describe('the narrowed profile', () => {
  it('keeps dsh-llm, because it IS the llm service', () => {
    const names = PROFILE_ROWS.map((row) => row.name);
    expect(names).toContain('@deepseek-ai/dsh-llm');
    expect(names).toContain('@deepseek-ai/dsh-invariants');
    expect(names).toContain('@deepseek-ai/dsh-llm/invariant');
    expect(names).toContain('@chatterang/cordis-aimatey');
  });

  it('drops the DeepSeek-specific rows and the telemetry row', () => {
    const names = PROFILE_ROWS.map((row) => row.name);
    for (const dropped of [
      '@deepseek-ai/dsh-llm-deepseek',
      '@deepseek-ai/dsh-llm-pi-ai',
      '@deepseek-ai/dsh-web-search-deepseek',
      '@deepseek-ai/dsh-session-telemetry-otel',
    ]) {
      expect(names).not.toContain(dropped);
    }
  });

  it('adopts no sandbox policy at all, and certainly not danger-full-access', () => {
    const rendered = renderPatchYaml();
    expect(rendered).not.toContain('danger-full-access');
    expect(rendered).not.toContain('sandbox');
  });

  it('matches the checked-in cordis.patch.yml', () => {
    // The YAML is generated; profile.ts is the source of truth. No loader is
    // mounted on this target, so nothing else can check the file at all.
    const path = resolve(process.cwd(), 'packages/cordis-aimatey/cordis.patch.yml');
    expect(readFileSync(path, 'utf8')).toBe(renderPatchYaml());
  });

  it('says in its own first lines that it is not a boot input', () => {
    // A checked-in profile in DSH's own patch format, sitting in the package
    // that mounts the tree, reads as load-bearing whatever a README says. The
    // marker is asserted against the exported constant rather than a copy, so
    // rewording it in one place and not the other fails here.
    const path = resolve(process.cwd(), 'packages/cordis-aimatey/cordis.patch.yml');
    const header = readFileSync(path, 'utf8').split('\n\n')[0] ?? '';
    expect(header).toContain(NOT_LOADED_MARKER);
    // And it names what DOES boot the tree, so a reader is not left to guess.
    expect(header).toContain('applyProfile(ctx, modules, PROFILE_ROWS)');
    expect(header).toContain('apps/desktop/src/host/entry.ts');
  });

  it('is named by no shipped source file — the claim, machine-checked', () => {
    // THE EVIDENCE FOR THE HEADER. "Nothing reads this file" is a claim about
    // the whole tree, and prose cannot keep it true. This is a lexical scan
    // for the file's own name across everything that ships: if someone later
    // wires a loader in, they must also correct the header that says nobody
    // did.
    const roots = [
      resolve(process.cwd(), 'src'),
      resolve(process.cwd(), 'packages/contracts/src'),
      resolve(process.cwd(), 'packages/cordis-aimatey/src'),
      resolve(process.cwd(), 'packages/inference-node/src'),
      resolve(process.cwd(), 'apps/desktop/src'),
      resolve(process.cwd(), 'apps/desktop/scripts'),
    ];
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.(tsx?|mjs|cjs|js)$/.test(entry)) files.push(full);
      }
    };
    for (const root of roots) walk(root);
    // A scan that silently walked nothing would pass for free. This suite has
    // shipped exactly that failure before.
    expect(files.length).toBeGreaterThan(40);

    const namers = files
      .filter((file) => {
        const source = readFileSync(file, 'utf8');
        // The comment in profile.ts that explains the file is the one place
        // the name is legitimately written; it is prose, not a read.
        if (file.endsWith(`${sep}profile.ts`)) return false;
        return source.includes('cordis.patch');
      })
      .map((file) => relative(process.cwd(), file));
    expect(namers).toEqual([]);
  });

  it('applyProfile refuses a row it has no module for', async () => {
    await expect(applyProfile(new Context(), new Map())).rejects.toThrow(
      /no module supplied for profile row\(s\)/,
    );
  });
});

/* ── The error table ──────────────────────────────────────────────────── */

describe('the aimatey -> DSH error table', () => {
  it('covers every member of aimatey ErrorCode', () => {
    // Without this, a new aimatey code silently starts passing through
    // undocumented, and the table rots without anyone noticing.
    const uncovered = Object.values(ErrorCode).filter(
      (code) => !(code in AIMATEY_TO_DSH_CODE) && !PASS_THROUGH_CODES.includes(code),
    );
    expect(uncovered).toEqual([]);
  });

  it('lists no code that aimatey does not define', () => {
    const known = new Set<string>(Object.values(ErrorCode));
    const strays = [...Object.keys(AIMATEY_TO_DSH_CODE), ...PASS_THROUGH_CODES].filter(
      (code) => !known.has(code),
    );
    expect(strays).toEqual([]);
  });

  it('passes an unmapped code through literally rather than laundering it to UNKNOWN', () => {
    expect(mapCode('SOME_FUTURE_CODE')).toBe('SOME_FUTURE_CODE');
    expect(mapCode('RATE_LIMIT_EXCEEDED')).toBe('RATE_LIMIT');
    expect(mapCode('')).toBe('UNKNOWN');
  });
});
