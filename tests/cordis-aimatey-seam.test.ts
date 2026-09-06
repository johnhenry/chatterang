import { describe, expect, it } from 'vitest';

import { Context } from '@deepseek-ai/cordis';
import type { Plugin } from '@deepseek-ai/cordis';
import LlmRuntime from '@deepseek-ai/dsh-llm';
import type { GenerateOptions, Message, StreamChunk } from '@deepseek-ai/dsh-llm';
import { MessageId } from '@deepseek-ai/dsh-llm';
import InvariantRegistry from '@deepseek-ai/dsh-invariants';
import * as llmInvariant from '@deepseek-ai/dsh-llm/invariant';
import { Router } from '@johnhenry/aimatey-core';
import { FunctionBackendAdapter } from '@johnhenry/aimatey-backend-browser';
import type { BackendAdapter, IRChatRequest, IRStreamChunk } from '@johnhenry/aimatey-types';

import {
  AimateyAdapter,
  PROFILE_ROWS,
  ROUTER_SENTINEL,
  ROUTE_UNAVAILABLE_CODE,
  aimateyRouterPlugin,
  applyProfile,
  pinRouter,
} from '@chatterang/cordis-aimatey';
import type { AimateyRouter } from '@chatterang/cordis-aimatey';

import { ChatterangEngine } from '@/ai/engine';
import { catalogEntry } from '@/data/catalog';
import { DEFAULT_SAMPLER } from '@/domain/manifest';

/**
 * THE SEAM: the adapter against the Router the app actually builds.
 *
 * `tests/cordis-aimatey.test.ts` is a good suite that never once fed the
 * adapter a real `Router`. Everything there runs against `FakeRouter`, whose
 * `getBackendInfo` reported `isHealthy: true` and no `circuitBreakerState` at
 * all behind an `as unknown as BackendInfo` cast — so every availability
 * question asked of it answered "fine" for free, and 33 of 33 proposed
 * mutations survived the suite unchanged.
 *
 * So every Router in this file is the real class, and the app-config ones come
 * from `new ChatterangEngine(...)` — the app's own factory, with the exact
 * config at src/ai/engine.ts:149-156. Only the BACKENDS are fixtures, and they
 * are real `FunctionBackendAdapter` instances rather than hand-written stubs:
 * a test must not send a prompt to OpenAI, but everything between the DSH
 * request and the backend's own `executeStream` is production code.
 *
 * LAYERING: `tests/layering.test.ts` scans `src/` only (`SRC` at :16, files
 * from `sourceFiles(SRC)` at :43, the ban regex applied to those alone at
 * :215-222). A test importing both `@/ai/engine` and the DSH package is
 * therefore permitted, and no guard was weakened to allow it.
 *
 * Three things are pinned here that a mutation could previously delete for
 * free: the abort signal actually reaching `Router.executeStream`, tools going
 * OUT on the wire, and a named route never being served by a different backend.
 */

/* ── The app's own Router ─────────────────────────────────────────────── */

const manifest = catalogEntry('qwen3-4b-instruct-q4km')!;

/** Enough of a model resolver for `ChatterangEngine` to construct. */
const resolver = {
  getManifest: (id: string) => (id === manifest.id ? manifest : null),
  getPath: () => '/dev/model.gguf',
  getSampler: () => ({ ...DEFAULT_SAMPLER, maxTokens: 64 }),
};

/**
 * A Router built by the app's own factory.
 *
 * `ChatterangEngine`'s constructor is where the app's Router is configured and
 * where `llama-cpp` is registered FIRST — which matters, because
 * `getAvailableBackends()[0]` is exactly what substitutes for a pinned backend
 * that is out. The real llama-cpp adapter is then swapped for a fixture with
 * `replace`, the app's own key-rotation call, so nothing here can touch a GPU
 * or a network.
 */
function appRouter(): Router {
  return new ChatterangEngine({ resolver }).router;
}

/* ── Fixtures ─────────────────────────────────────────────────────────── */

/** What one fixture backend recorded about the calls it served. */
interface Recorder {
  calls: number;
  requests: IRChatRequest[];
  signals: (AbortSignal | undefined)[];
}

function recorder(): Recorder {
  return { calls: 0, requests: [], signals: [] };
}

interface FixtureOptions {
  /** Extra deltas emitted after `text`, used to script a post-abort chunk. */
  readonly then?: readonly string[];
  /** Throw after the `start` chunk, modelling a backend that dies mid-stream. */
  readonly dieAfterStart?: boolean;
  /** What `Router.checkHealth(name)` will learn from this backend. */
  readonly healthy?: boolean;
}

/**
 * A real `BackendAdapter` that streams a scripted answer.
 *
 * It stamps `provenance.backend` with its own name on the `start` chunk, which
 * is what makes a provenance assertion possible at all — this repo's own
 * llama-cpp backend forwards `request.metadata` verbatim
 * (src/ai/backends/llama-cpp.ts:263) and `request.ts:213` puts no `backend` key
 * in provenance, so the real streaming path reports nothing to check.
 */
function fixture(name: string, text: string, log: Recorder, options: FixtureOptions = {}): BackendAdapter {
  return new FunctionBackendAdapter({
    execute: async () => {
      throw new Error('this fixture is stream-only');
    },
    executeStream: async function* (
      request: IRChatRequest,
      signal?: AbortSignal,
    ): AsyncGenerator<IRStreamChunk> {
      log.calls += 1;
      log.requests.push(request);
      log.signals.push(signal);
      let sequence = 0;
      yield {
        type: 'start',
        sequence: sequence++,
        metadata: { ...request.metadata, provenance: { ...request.metadata.provenance, backend: name } },
      };
      if (options.dieAfterStart === true) throw new Error(`backend "${name}" died mid-stream`);
      for (const delta of [text, ...(options.then ?? [])]) {
        yield { type: 'content', sequence: sequence++, delta };
      }
      yield { type: 'done', sequence: sequence++, finishReason: 'stop' };
    },
    ...(options.healthy === undefined ? {} : { healthCheck: async () => options.healthy === true }),
  });
}

/* ── DSH tree ─────────────────────────────────────────────────────────── */

async function boot(router: AimateyRouter): Promise<Context> {
  const ctx = new Context();
  await applyProfile(
    ctx,
    new Map<string, Plugin>([
      ['@deepseek-ai/dsh-llm', LlmRuntime as unknown as Plugin],
      ['@deepseek-ai/dsh-invariants', InvariantRegistry as unknown as Plugin],
      ['@deepseek-ai/dsh-llm/invariant', llmInvariant as unknown as Plugin],
      [
        '@chatterang/cordis-aimatey',
        {
          ...aimateyRouterPlugin,
          apply: (inner: Context) => aimateyRouterPlugin.apply(inner, { router }),
        },
      ],
    ]),
    PROFILE_ROWS,
  );
  await new Promise((done) => setTimeout(done, 0));
  return ctx;
}

function request(overrides: Partial<GenerateOptions> = {}): GenerateOptions {
  return { provider: ROUTER_SENTINEL, model: 'test-model', messages: [], ...overrides };
}

const userMessage = (text: string): Message => ({
  id: MessageId('m1'),
  role: 'user',
  content: [{ type: 'text', text }],
  source: { kind: 'user' },
});

async function drain(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

function terminalOf(chunks: StreamChunk[]): Extract<StreamChunk, { type: 'finish' }> {
  const finishes = chunks.filter((chunk) => chunk.type === 'finish');
  expect(finishes).toHaveLength(1);
  expect(chunks.at(-1)?.type).toBe('finish');
  return finishes[0] as Extract<StreamChunk, { type: 'finish' }>;
}

/** Every character the consumer would have rendered. */
function rendered(chunks: StreamChunk[]): string {
  return chunks
    .filter((chunk): chunk is Extract<StreamChunk, { type: 'text-delta' }> => chunk.type === 'text-delta')
    .map((chunk) => chunk.text)
    .join('');
}

/** Drain a raw IR stream, folding a throw into a comparable record. */
async function drainIR(stream: AsyncIterable<IRStreamChunk>): Promise<IRStreamChunk[]> {
  const chunks: IRStreamChunk[] = [];
  try {
    for await (const chunk of stream) chunks.push(chunk);
  } catch (cause) {
    chunks.push({
      type: 'error',
      sequence: -1,
      error: { code: 'THREW', message: String(cause) },
    } as unknown as IRStreamChunk);
  }
  return chunks;
}

/* ── The Router really is the app's ───────────────────────────────────── */

describe('the seam is the real thing', () => {
  it('is a real Router, configured by the app, with llama-cpp registered first', () => {
    const router = appRouter();
    // Not a fake wearing the interface: the concrete class the app builds.
    expect(router).toBeInstanceOf(Router);
    expect(router.listBackends()).toEqual(['llama-cpp']);
    expect(router.config).toMatchObject({
      routingStrategy: 'explicit',
      fallbackStrategy: 'none',
      enableCircuitBreaker: true,
      circuitBreakerThreshold: 3,
    });
    // `llama-cpp` being FIRST is load-bearing for every substitution test
    // below: `getAvailableBackends()[0]` is what serves a pinned request whose
    // backend is out.
    expect(router.listBackends()[0]).toBe('llama-cpp');
  });
});

/* ── (a) The abort signal ─────────────────────────────────────────────── */

describe('abort threading, through the real Router', () => {
  it('hands Router.executeStream the caller’s exact AbortSignal object', async () => {
    const log = recorder();
    const router = appRouter();
    router.replace('llama-cpp', fixture('llama-cpp', 'hi', log));
    const ctx = await boot(router);

    const controller = new AbortController();
    await drain(ctx.llm.stream(request({ provider: 'llama-cpp', signal: controller.signal })));

    // Identity, not equivalence. The Router forwards the signal it was handed
    // POSITIONALLY down to the backend adapter, so seeing the very same object
    // at the far end is proof it was passed at the near end. A `new
    // AbortSignal` synthesized anywhere in between would fail this.
    expect(log.signals).toHaveLength(1);
    expect(log.signals[0]).toBe(controller.signal);
  });

  it('lets no chunk scripted after the abort reach the consumer', async () => {
    const log = recorder();
    const router = appRouter();
    // The fixture keeps talking after the first delta. Only the signal reaching
    // the Router stops it: `translate` does NOT poll the signal inside its
    // loop, it only reads it once the source is exhausted (chunks.ts, the
    // 'exhausted' branch), so an unthreaded signal lets POISON straight
    // through.
    router.replace('llama-cpp', fixture('llama-cpp', 'first', log, { then: ['POISON-AFTER-ABORT'] }));
    const ctx = await boot(router);

    const controller = new AbortController();
    const chunks: StreamChunk[] = [];
    for await (const chunk of ctx.llm.stream(
      request({ provider: 'llama-cpp', signal: controller.signal }),
    )) {
      chunks.push(chunk);
      if (chunk.type === 'text-delta') controller.abort();
    }

    expect(rendered(chunks)).toBe('first');
    expect(rendered(chunks)).not.toContain('POISON');
    // aimatey's Router breaks out and returns with no terminal chunk at all;
    // the signal is the only evidence that the silence was an abort.
    expect(terminalOf(chunks).reason.kind).toBe('aborted');
  });

  it('threads the signal on the sentinel route too, which is a separate path', async () => {
    // `stream()` has two bodies — sentinel and named — each with its own call
    // to `executeStream`. A test that only ever exercises one of them leaves
    // the other's signal argument free to delete.
    const log = recorder();
    const router = appRouter();
    router.replace('llama-cpp', fixture('llama-cpp', 'first', log, { then: ['POISON-AFTER-ABORT'] }));
    const ctx = await boot(router);

    const controller = new AbortController();
    const chunks: StreamChunk[] = [];
    for await (const chunk of ctx.llm.stream(request({ signal: controller.signal }))) {
      chunks.push(chunk);
      if (chunk.type === 'text-delta') controller.abort();
    }

    expect(log.signals[0]).toBe(controller.signal);
    expect(rendered(chunks)).toBe('first');
    expect(terminalOf(chunks).reason.kind).toBe('aborted');
  });
});

/* ── (b) Tools, outbound ──────────────────────────────────────────────── */

describe('tools reach the backend, through the real Router', () => {
  it('carries a ToolSchema out as IR `tools` with toolChoice "auto"', async () => {
    const log = recorder();
    const router = appRouter();
    router.replace('llama-cpp', fixture('llama-cpp', 'ok', log));
    const ctx = await boot(router);

    await drain(
      ctx.llm.stream(
        request({
          provider: 'llama-cpp',
          messages: [userMessage('what is the weather?')],
          tools: [
            {
              name: 'get_weather',
              description: 'Look up the weather.',
              parameters: {
                type: 'object',
                properties: { city: { type: 'string' } },
                required: ['city'],
              },
            },
          ],
        }),
      ),
    );

    // The headline A4 capability, asserted where it counts: on the request the
    // BACKEND received, after the real Router's model translation, not on the
    // return value of `toIRRequest`.
    const seen = log.requests[0];
    expect(seen?.tools).toEqual([
      {
        name: 'get_weather',
        description: 'Look up the weather.',
        parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
      },
    ]);
    expect(seen?.toolChoice).toBe('auto');
  });

  it('sends no tools field at all when the caller passed none', async () => {
    const log = recorder();
    const router = appRouter();
    router.replace('llama-cpp', fixture('llama-cpp', 'ok', log));
    const ctx = await boot(router);

    await drain(ctx.llm.stream(request({ provider: 'llama-cpp', messages: [userMessage('hi')] })));

    // An unconditional `toolChoice: 'auto'` would tell a provider to consider
    // tools on every plain chat turn.
    expect(log.requests[0]).not.toHaveProperty('tools');
    expect(log.requests[0]).not.toHaveProperty('toolChoice');
  });
});

/* ── (c) The route pin ────────────────────────────────────────────────── */

describe('a named route is never served by another backend', () => {
  it('CONTROL: a Router really does substitute a different backend', async () => {
    /*
     * The load-bearing control. If aimatey ever stops substituting, every
     * assertion in this block passes for a reason that has nothing to do with
     * the pin, and the whole block is vacuous.
     *
     * IT FIRED. As of aimatey-core 0.4.0 this used `appRouter()` and no longer
     * substituted, because ai.matey#134/#135 taught `selectBackend` to honour
     * `fallbackStrategy: 'none'` — which is exactly what the engine configures.
     * So the app's own router now refuses on its own.
     *
     * The control is kept, and moved to a Router carrying the library's
     * DEFAULT fallback strategy, because that is what the pin defends against
     * now: not the app's current configuration, but the Router class's
     * behaviour under any configuration this adapter does not own. The seam
     * says so itself — its guarantee is a one-backend Router, and it "holds
     * whatever routingStrategy/fallbackStrategy the app configured, which this
     * adapter neither owns nor can enforce". Pinning the control to the app's
     * config would make the block re-vacuous the moment that config changed.
     */
    const local = recorder();
    const cloud = recorder();
    const router = new Router({ routingStrategy: 'explicit' });
    router.register('llama-cpp', fixture('llama-cpp', 'hello from llama-cpp', local));
    router.register('openai', fixture('openai', 'hello from openai', cloud));
    // Public, deterministic, and — with an explicit 0 timeout — schedules no
    // auto-recovery timer (`if (timeoutMs ?? ...)` is falsy at 0), so the
    // circuit stays open with no fake timers involved.
    router.openCircuitBreaker('openai', 0);

    const chunks = await drainIR(
      router.executeStream({
        messages: [{ role: 'user', content: 'q' }],
        parameters: { model: 'm' },
        metadata: { requestId: 'r', timestamp: 0, custom: { backend: 'openai' } },
        stream: true,
        streamMode: 'delta',
      }),
    );

    const text = chunks
      .filter((chunk) => chunk.type === 'content')
      .map((chunk) => (chunk as { delta: string }).delta)
      .join('');
    expect(text).toBe('hello from llama-cpp');
    expect(cloud.calls).toBe(0);
    expect(local.calls).toBe(1);
  });

  it('the app Router now refuses on its own, since aimatey 0.4.0', async () => {
    /*
     * The other half of the control above, and the reason it had to move.
     *
     * ai.matey#134: `selectBackend` fell through to "first available backend"
     * regardless of `fallbackStrategy: 'none'`, so the strategy the engine
     * configures was not honoured at selection time. Fixed in #135, shipped in
     * aimatey-core 0.4.0, which this pins: the same setup as the control, but
     * on the app's router, now throws instead of substituting.
     *
     * Kept separate from the seam's own pin so a regression upstream is
     * distinguishable from a regression in the adapter.
     */
    const local = recorder();
    const cloud = recorder();
    const router = appRouter();
    router.replace('llama-cpp', fixture('llama-cpp', 'hello from llama-cpp', local));
    router.register('openai', fixture('openai', 'hello from openai', cloud));
    router.openCircuitBreaker('openai', 0);

    const chunks = await drainIR(
      router.executeStream({
        messages: [{ role: 'user', content: 'q' }],
        parameters: { model: 'm' },
        metadata: { requestId: 'r', timestamp: 0, custom: { backend: 'openai' } },
        stream: true,
        streamMode: 'delta',
      }),
    );

    // It reports the refusal as an error CHUNK rather than by throwing, which
    // is worth pinning: a caller that only wraps the loop in try/catch would
    // see an empty stream and no exception.
    const errors = chunks.filter((chunk) => chunk.type === 'error');
    expect(errors).toHaveLength(1);
    expect((errors[0] as { error: { code: string } }).error.code).toBe('NO_BACKEND_AVAILABLE');

    // No renderable output, and neither backend ran: refused at selection,
    // before any I/O, so no key is used and no prompt leaves the device.
    const text = chunks
      .filter((chunk) => chunk.type === 'content')
      .map((chunk) => (chunk as { delta: string }).delta)
      .join('');
    expect(text).toBe('');
    expect(cloud.calls).toBe(0);
    expect(local.calls).toBe(0);
  });

  it('refuses a breaker-open named route instead of substituting', async () => {
    const local = recorder();
    const cloud = recorder();
    const router = appRouter();
    router.replace('llama-cpp', fixture('llama-cpp', 'hello from llama-cpp', local));
    router.register('openai', fixture('openai', 'hello from openai', cloud));
    router.openCircuitBreaker('openai', 0);
    const ctx = await boot(router);

    const chunks = await drain(ctx.llm.stream(request({ provider: 'openai' })));
    const terminal = terminalOf(chunks);

    expect(terminal.reason).toMatchObject({
      kind: 'error',
      failure: { code: ROUTE_UNAVAILABLE_CODE },
    });
    expect(String((terminal.reason as { failure: { message: string } }).failure.message)).toContain(
      'refusing to substitute',
    );
    // Nobody was called: refused before any I/O, so no key is used and no
    // prompt leaves the device on a backend the caller did not name.
    expect(cloud.calls).toBe(0);
    expect(local.calls).toBe(0);
    // ZERO renderable output. A design that substitutes and then complains
    // would still produce a terminal error, and would still be wrong.
    expect(rendered(chunks)).toBe('');
  });

  it('cannot be substituted MID-STREAM, even under aimatey’s default fallback', async () => {
    // The structural test, and the one a pre-flight check cannot pass. Both
    // backends are HEALTHY, so any availability check waves this through; the
    // pinned backend then dies after its `start` chunk and aimatey's DEFAULT
    // `fallbackStrategy: 'sequential'` hands the request to the other one.
    // Verified against the raw Router: without the pin the substitute served
    // "hello from cloud" and its adapter was called once.
    const pinned = recorder();
    const cloud = recorder();
    const router = new Router({}); // aimatey's own defaults, NOT the app's.
    router.register('pinned', fixture('pinned', 'never seen', pinned, { dieAfterStart: true }));
    router.register('cloud', fixture('cloud', 'hello from cloud', cloud));
    expect(router.config.fallbackStrategy ?? 'sequential').toBe('sequential');
    const ctx = await boot(router);

    const chunks = await drain(ctx.llm.stream(request({ provider: 'pinned' })));

    expect(cloud.calls).toBe(0);
    expect(pinned.calls).toBe(1);
    expect(rendered(chunks)).toBe('');
    expect(rendered(chunks)).not.toContain('cloud');
    expect(terminalOf(chunks).reason.kind).toBe('error');
  });

  it('refuses a named route whose backend failed its health check', async () => {
    const local = recorder();
    const cloud = recorder();
    const router = appRouter();
    router.replace('llama-cpp', fixture('llama-cpp', 'hello from llama-cpp', local));
    router.register('openai', fixture('openai', 'hello from openai', cloud, { healthy: false }));
    expect(await router.checkHealth('openai')).toBe(false);
    expect(router.getBackendInfo('openai')?.isHealthy).toBe(false);
    const ctx = await boot(router);

    const chunks = await drain(ctx.llm.stream(request({ provider: 'openai' })));

    expect(terminalOf(chunks).reason).toMatchObject({
      kind: 'error',
      failure: { code: ROUTE_UNAVAILABLE_CODE },
    });
    expect(cloud.calls).toBe(0);
    expect(local.calls).toBe(0);
    expect(rendered(chunks)).toBe('');
  });

  it('does NOT refuse a half-open (recovering) backend', async () => {
    // Over-refusal is its own failure. aimatey's own `isBackendAvailable`
    // (router.js:1651-1655) reads `!== 'open'`, so half-open is routable; a
    // check written as `=== 'closed'` would take a recovering backend out of
    // service permanently.
    const cloud = recorder();
    const router = appRouter();
    router.register('openai', fixture('openai', 'hello from openai', cloud));
    // 1 ms, then the breaker's own auto-recovery moves it to half-open.
    router.openCircuitBreaker('openai', 1);
    await new Promise((done) => setTimeout(done, 20));
    expect(router.getBackendInfo('openai')?.circuitBreakerState).toBe('half-open');
    const ctx = await boot(router);

    const chunks = await drain(ctx.llm.stream(request({ provider: 'openai' })));

    expect(rendered(chunks)).toBe('hello from openai');
    expect(cloud.calls).toBe(1);
  });

  it('picks up a rotated adapter, because the pin is built per request', async () => {
    // `ChatterangEngine.connectProvider` swaps the adapter in place with
    // `Router.replace` when the user rotates an API key. A pinned clone cached
    // by name would keep streaming through the OLD adapter — and, worse, the
    // old key.
    const before = recorder();
    const after = recorder();
    const router = appRouter();
    router.replace('llama-cpp', fixture('llama-cpp', 'local', recorder()));
    router.register('openai', fixture('openai', 'before rotation', before));
    const ctx = await boot(router);

    expect(rendered(await drain(ctx.llm.stream(request({ provider: 'openai' }))))).toBe(
      'before rotation',
    );

    router.replace('openai', fixture('openai', 'after rotation', after));

    expect(rendered(await drain(ctx.llm.stream(request({ provider: 'openai' }))))).toBe(
      'after rotation',
    );
    expect(before.calls).toBe(1);
    expect(after.calls).toBe(1);
  });

  it('leaves the sentinel route free to choose another backend', async () => {
    // The pin must not become a global ban on routing. Same Router and same
    // failure as the mid-stream test, asked for on the sentinel route: here
    // substitution is exactly what the caller asked for.
    const pinned = recorder();
    const cloud = recorder();
    const router = new Router({});
    router.register('pinned', fixture('pinned', 'never seen', pinned, { dieAfterStart: true }));
    router.register('cloud', fixture('cloud', 'hello from cloud', cloud));
    const ctx = await boot(router);

    const chunks = await drain(ctx.llm.stream(request({ provider: ROUTER_SENTINEL })));

    expect(rendered(chunks)).toBe('hello from cloud');
    expect(cloud.calls).toBe(1);
  });

  it('reports a backend unregistered since mount as NO_BACKEND_AVAILABLE, not ROUTE_UNAVAILABLE', async () => {
    // "Gone" and "here but not routable" are different facts, and the second
    // one is actionable.
    const router = appRouter();
    router.replace('llama-cpp', fixture('llama-cpp', 'local', recorder()));
    router.register('openai', fixture('openai', 'cloud', recorder()));
    const ctx = await boot(router);
    router.unregister('openai');

    expect(terminalOf(await drain(ctx.llm.stream(request({ provider: 'openai' })))).reason).toMatchObject(
      { kind: 'error', failure: { code: 'NO_BACKEND_AVAILABLE' } },
    );
  });

  it('terminates with a classified failure when nothing at all is routable', async () => {
    // Not a hang. The sentinel route with every backend out has no pin to fall
    // back on, and must still reach exactly one terminal chunk.
    const router = appRouter();
    router.replace('llama-cpp', fixture('llama-cpp', 'local', recorder(), { healthy: false }));
    expect(await router.checkHealth('llama-cpp')).toBe(false);
    const ctx = await boot(router);

    const terminal = terminalOf(await drain(ctx.llm.stream(request({ provider: ROUTER_SENTINEL }))));

    expect(terminal.reason.kind).toBe('error');
    expect((terminal.reason as { failure: { code: string } }).failure.code).toBe('NO_BACKEND_AVAILABLE');
  });
});

/* ── Provenance ───────────────────────────────────────────────────────── */

describe('provenance says which backend actually served the request', () => {
  /** The backend names the adapter's debug hook reported a stream starting on. */
  async function startedOn(router: AimateyRouter, provider: string): Promise<string[]> {
    const lines: string[] = [];
    const adapter = new AimateyAdapter({ router, debug: (line) => lines.push(line) });
    try {
      for await (const _chunk of adapter.stream(request({ provider }))) void _chunk;
    } catch {
      // A refusal or a backend failure is a legitimate outcome here; what the
      // provenance said before it is the point.
    }
    return lines
      .map((line) => /stream started on backend "([^"]+)"/.exec(line)?.[1])
      .filter((name): name is string => name !== undefined);
  }

  it('CONTROL: without a pin, the SUBSTITUTE stamps its own provenance', async () => {
    const router = new Router({});
    router.register('pinned', fixture('pinned', 'never seen', recorder(), { dieAfterStart: true }));
    router.register('cloud', fixture('cloud', 'hello from cloud', recorder()));
    // Straight through the Router, as the adapter used to do. aimatey withholds
    // a failed attempt's preamble, so the `start` chunk that survives is the
    // substitute's — which is precisely why provenance can detect this.
    const seen: string[] = [];
    for await (const chunk of router.executeStream({
      messages: [{ role: 'user', content: 'q' }],
      parameters: { model: 'm' },
      metadata: { requestId: 'r', timestamp: 0, custom: { backend: 'pinned' } },
      stream: true,
      streamMode: 'delta',
    })) {
      if (chunk.type === 'start') seen.push(String(chunk.metadata.provenance?.backend));
    }
    expect(seen).toEqual(['cloud']);
  });

  it('reports the pinned backend on a healthy named route', async () => {
    const router = appRouter();
    router.replace('llama-cpp', fixture('llama-cpp', 'local', recorder()));
    router.register('openai', fixture('openai', 'cloud', recorder()));

    expect(await startedOn(router, 'openai')).toEqual(['openai']);
  });

  it('never reports another backend’s provenance on a pinned route', async () => {
    const router = new Router({});
    router.register('pinned', fixture('pinned', 'never seen', recorder(), { dieAfterStart: true }));
    router.register('cloud', fixture('cloud', 'hello from cloud', recorder()));

    // LIVE-CHANNEL CONTROL, and the reason it is inside this test rather than
    // beside it. The assertion below is negative, so it passes for free the
    // moment the observation channel dies — reword the debug line at
    // chunks.ts:165 and `[]` is still `[]`. Proving the same helper, on the
    // same router, still reports a backend is what makes the emptiness mean
    // "no other backend served" rather than "nothing was observed".
    expect(await startedOn(router, 'cloud')).toEqual(['cloud']);

    // The control above shows this same setup reporting `cloud` without the
    // pin. With it, the pinned attempt is the only attempt — and since aimatey
    // withholds the preamble of an attempt that fails, no `start` chunk
    // survives at all. "No provenance" is the honest answer; "cloud" would be
    // a lie.
    expect(await startedOn(router, 'pinned')).toEqual([]);
  });
});

/* ── pinRouter, as a unit ─────────────────────────────────────────────── */

describe('pinRouter', () => {
  it('prunes to exactly the pinned backend and neutralises the clone’s config', () => {
    const warnings: unknown[] = [];
    const source = new Router({
      routingStrategy: 'round-robin',
      fallbackStrategy: 'sequential',
      // Non-zero on purpose: the constructor starts a health-check interval
      // whenever this is > 0 (router.js:104), and a per-request clone is never
      // disposed.
      healthCheckInterval: 5_000,
      defaultBackend: 'cloud',
      enableCircuitBreaker: true,
      onWarning: (warning: unknown) => warnings.push(warning),
    });
    try {
      source.register('local', fixture('local', 'local', recorder()));
      source.register('cloud', fixture('cloud', 'cloud', recorder()));

      const pinned = pinRouter(source, 'local') as Router;

      expect(pinned.listBackends()).toEqual(['local']);
      // These four are invisible to every behavioural test in this file — with
      // one backend registered there is nothing to route to or fall back on —
      // so they are asserted directly or not at all.
      expect(pinned.config.routingStrategy).toBe('explicit');
      expect(pinned.config.fallbackStrategy).toBe('none');
      expect(pinned.config.healthCheckInterval).toBe(0);
      expect(pinned.config.defaultBackend).toBeUndefined();
      // Pruning the backend that WAS the default must not spam the app's
      // warning channel once per request (router.js:252-262).
      expect(warnings).toEqual([]);
      // The source is untouched.
      expect(source.listBackends()).toEqual(['local', 'cloud']);
      expect(source.config.defaultBackend).toBe('cloud');
    } finally {
      source.dispose();
    }
  });

  it('inherits the app router’s open circuit, rather than re-arming a dead backend', () => {
    const source = appRouter();
    source.register('openai', fixture('openai', 'cloud', recorder()));
    source.openCircuitBreaker('openai', 0);

    // `clone` copies an open circuit only into a clone that still has the
    // breaker enabled (router.js:1054-1058) — so `enableCircuitBreaker: false`
    // must NOT be in pinRouter's config patch.
    expect((pinRouter(source, 'openai') as Router).getBackendInfo('openai')?.circuitBreakerState).toBe(
      'open',
    );
  });
});
