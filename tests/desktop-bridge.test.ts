import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type {
  GenerateOptions,
  GenerateResult,
  GenerationEndEvent,
  LlamaCppPlugin,
  TokenEvent,
} from '@chatterang/contracts';
import type {
  LlamaEngine,
  LlamaEngineContext,
  LlamaEngineModel,
  LlamaEngineSequence,
  LlamaGpu,
  LlamaTokenId,
} from '@chatterang/inference-node';
import { LlamaCppNode } from '@chatterang/inference-node';
import { modelPathGuard } from '@chatterang/desktop/host/model-paths';

import {
  BRIDGE_KEYS,
  DEFAULT_POLICY,
  DSH_METHODS,
  DSH_PLUGIN,
  EVENT_CHANNEL,
  HANDLE_LOST,
  HOST_TIMEOUT,
  LLAMA_ENGINE,
  LLAMA_EVENTS,
  LLAMA_OPAQUE_FAILURES,
  LLAMA_METHODS,
  LLAMA_PLUGIN,
  PluginHost,
  RENDERER_TEARDOWN_EVENTS,
  SENDER_SCOPED,
  Supervisor,
  allowedChannels,
  assertCloneable,
  capacitorShimSource,
  channelCollisions,
  createMainRouter,
  createRendererBridge,
  fromWireError,
  installCapacitorShim,
  REQUIRED_ARGUMENTS,
  assertCallShape,
  methodChannel,
  createHostRuntime,
  LLAMA_HOST_POLICY,
  releaseRendererOn,
  teardownReason,
} from '@chatterang/desktop/bridge';
import type {
  BootManifest,
  EngineSpec,
  EventPayload,
  HostMessage,
  HostPluginImplementation,
  PluginDefinition,
  InvokeResult,
  MessageLink,
  NotifyListeners,
  PluginImplementation,
  PreloadBridge,
  RendererIpc,
  CallGuard,
  RendererTeardownTargets,
  ShimTarget,
  SupervisorPolicy,
  SupervisorTimers,
} from '@chatterang/desktop/bridge';

/**
 * THE DESKTOP BRIDGE, DRIVEN ACROSS A REAL SERIALIZATION BOUNDARY.
 *
 * Nothing here launches Electron, and that is the point rather than a
 * compromise. A window that opens proves the wiring; it does not prove what
 * actually breaks — that a `generate` promise settles when the inference
 * process is killed mid-token, that `removeAllListeners` during a stream does
 * not hang the turn, that an `AbortSignal` in a payload is refused instead of
 * arriving as `{}`. Those need a boundary you can fault-inject, so both
 * boundaries here are modelled with `structuredClone`, which is the same
 * algorithm Electron uses and which throws `DataCloneError` on exactly the
 * same values.
 *
 * Everything between the fake ports is production code: the real
 * `PluginHost`, the real `Supervisor`, the real `createMainRouter`, the real
 * preload bridge, the real `HostRuntime`, the real `LlamaCppNode` from
 * `packages/inference-node`, and — in the Capacitor section — the real
 * `@capacitor/core` and the app's own `src/plugins/llama-cpp`.
 *
 * EVERY TEST BELOW HAS BEEN RUN AGAINST A DELIBERATELY BROKEN BUILD. Where a
 * test guards a specific line, the comment says which line was removed and
 * what the failure looked like. A test that has only ever seen correct code
 * proves nothing.
 */

/* ── Boundary doubles ─────────────────────────────────────────────────── */

interface LinkPair {
  readonly main: MessageLink;
  readonly host: MessageLink;
  /** Kill the inference host, as a native-addon abort would. */
  kill(reason: string): void;
  /** True once this host has been terminated, by either side. */
  readonly dead: boolean;
  /** Set when the SUPERVISOR terminated it, rather than it dying on its own. */
  killedBySupervisor: boolean;
}

/**
 * Two ports with real structured-clone semantics.
 *
 * Delivery is asynchronous (a microtask) because Electron's is, and because a
 * synchronous double would hide every ordering bug this file exists to catch.
 */
function createLinkPair(): LinkPair {
  const listeners: { main: ((m: unknown) => void)[]; host: ((m: unknown) => void)[] } = {
    main: [],
    host: [],
  };
  const closers: ((reason: string) => void)[] = [];
  let open = true;

  const side = (self: 'main' | 'host'): MessageLink => {
    const other = self === 'main' ? 'host' : 'main';
    return {
      postMessage(message) {
        if (!open) return;
        // Throws DataCloneError for a function or an EventTarget, exactly as
        // the real port does — the loud half of the failure mode.
        const cloned = structuredClone(message);
        queueMicrotask(() => {
          if (!open) return;
          for (const listener of listeners[other]) listener(cloned);
        });
      },
      onMessage(listener) {
        listeners[self].push(listener);
      },
      onClose(listener) {
        if (self === 'main') closers.push(listener);
      },
    };
  };

  const pair = {
    main: side('main'),
    host: side('host'),
    killedBySupervisor: false,
    get dead(): boolean {
      return !open;
    },
    kill(reason: string): void {
      if (!open) return;
      open = false;
      for (const close of closers) close(reason);
    },
  };
  return pair;
}

/* ── The clock, held still ────────────────────────────────────────────── */

interface ManualClock extends SupervisorTimers {
  /** Move the wall clock forward and run whatever that makes due. */
  advance(ms: number): Promise<void>;
}

/**
 * A clock a test owns.
 *
 * The watchdog's whole job is measured in minutes, and a suite that waited
 * them out would either take minutes or assert against shortened deadlines
 * that are not the ones shipped. Holding the clock still also means the
 * DEFAULT policy is what every test below exercises: nothing fires unless a
 * test moves time, and when it does, it moves it by an exact amount.
 */
function manualClock(): ManualClock {
  let now = 0;
  const ticks = new Set<() => void>();
  const pending = new Set<{ at: number; fn: () => void }>();
  return {
    now: () => now,
    every: (_ms, fn) => {
      ticks.add(fn);
      return () => ticks.delete(fn);
    },
    after: (ms, fn) => {
      const entry = { at: now + ms, fn };
      pending.add(entry);
      return () => pending.delete(entry);
    },
    async advance(ms: number): Promise<void> {
      now += ms;
      for (const entry of [...pending]) {
        if (entry.at > now) continue;
        pending.delete(entry);
        entry.fn();
      }
      // The tick is deadline-driven, not count-driven, so running it once
      // after a jump is equivalent to running it every `tickMs` across it.
      for (const fn of [...ticks]) fn();
      await new Promise((done) => setTimeout(done, 0));
    },
  };
}

/* ── The contextBridge hop, modelled ──────────────────────────────────── */

/**
 * What `contextBridge.exposeInMainWorld` does to a value, as a function.
 *
 * THIS IS NOT `structuredClone`, AND THE DIFFERENCE IS DEFECT [3]. The ports
 * above are modelled with structured clone because that is the algorithm
 * Electron's IPC actually uses. `contextBridge` is a THIRD boundary with its
 * own rules, and the two disagree in both directions:
 *
 *   - structured clone THROWS on a function; contextBridge passes one through
 *     as a proxy, which is the only reason an event callback works at all;
 *   - structured clone carries an `Error`'s own properties across; **
 *     contextBridge reduces an `Error` to its message and stack and DROPS
 *     custom own properties** — including `code`.
 *
 * So a test that modelled the preload-to-page hop with `structuredClone`
 * would have shown `HANDLE_LOST` arriving intact when in the shipped app it
 * did not. This double reproduces the one documented behaviour the defect
 * turns on, and `the contextBridge double is not a no-op` below proves it is
 * not vacuous by showing the old arrangement failing through it.
 *
 * WHAT THIS DOUBLE IS NOT: real Electron. It models Electron's documented
 * behaviour for the value shapes this bridge actually passes — plain objects,
 * arrays, primitives, functions and Errors. It does not model the frozen
 * result objects, the proxy identity rules, or anything else.
 */
function crossContextBridge<T>(value: T): T {
  return cross(value) as T;
}

function cross(value: unknown): unknown {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'function') {
      const fn = value as (...args: unknown[]) => unknown;
      return (...args: unknown[]): unknown => {
        let result: unknown;
        try {
          result = fn(...args.map((arg) => cross(arg)));
        } catch (error) {
          // A SYNCHRONOUS throw crosses too, and loses the same properties.
          // Missed on the first draft of this double, and caught by the test
          // below that asserts the double is not a no-op — which is exactly
          // what that test is for.
          throw cross(error);
        }
        if (result instanceof Promise) {
          return result.then(
            (settled) => cross(settled),
            (error: unknown) => {
              throw cross(error);
            },
          );
        }
        return cross(result);
      };
    }
    return value;
  }
  if (value instanceof Error) {
    // THE DEFECT, in one line. `code` does not survive; message and stack do.
    const copy = new Error(value.message);
    copy.stack = value.stack;
    return copy;
  }
  if (Array.isArray(value)) return value.map((entry) => cross(entry));
  const prototype = Object.getPrototypeOf(value) as object | null;
  if (prototype !== Object.prototype && prototype !== null) {
    // Anything that is not a plain object crosses as ITSELF. contextBridge
    // proxies such a value rather than flattening it, and the distinction
    // matters here: an `AbortSignal` flattened to `{}` on the way in would
    // sail past `assertCloneable`, and the test that proves the bridge refuses
    // one would be passing for a reason that does not exist in the app.
    // Caught by exactly that test while this double was being written.
    return value;
  }
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) out[key] = cross(entry);
  return out;
}

/* ── The page's view of the bridge ────────────────────────────────────── */

/**
 * What a page script sees after the shim has run: values, and throws that
 * carry `code`.
 *
 * Built by DRIVING THE REAL SHIM rather than by re-implementing it. Every
 * `h.bridge.invoke` below therefore crosses the modelled contextBridge and
 * comes back through `installCapacitorShim`'s own `unwrap` — which is where
 * the error is now rebuilt, and the only place a test can prove that it is.
 */
interface PageBridge {
  getBootstrap(): BootManifest;
  invoke(pluginName: string, method: string, args: readonly unknown[]): Promise<unknown>;
  addListener(
    pluginName: string,
    eventName: string,
    callback: (data: unknown) => void,
  ): Promise<number>;
  removeListener(subscriptionId: number): Promise<void>;
  removeAllListeners(pluginName: string): Promise<void>;
}

function pageBridge(exposed: PreloadBridge): PageBridge {
  const target: ShimTarget = {};
  installCapacitorShim(target, exposed);
  const capacitor = target.Capacitor as {
    nativePromise(plugin: string, method: string, options?: unknown): Promise<unknown>;
    nativeCallback(
      plugin: string,
      method: string,
      options: Record<string, unknown> | undefined,
      callback?: (data: unknown) => void,
    ): Promise<unknown>;
  };
  return {
    getBootstrap: () => exposed.getBootstrap(),
    // Capacitor's proxy passes at most one options object per call, which is
    // exactly the shape every method in `LLAMA_METHODS` takes.
    invoke: (pluginName, method, args) => capacitor.nativePromise(pluginName, method, args[0]),
    addListener: async (pluginName, eventName, callback) =>
      (await capacitor.nativeCallback(pluginName, 'addListener', { eventName }, callback)) as number,
    removeListener: async (subscriptionId) => {
      await capacitor.nativeCallback('LlamaCpp', 'removeListener', { callbackId: subscriptionId });
    },
    removeAllListeners: async (pluginName) => {
      await capacitor.nativePromise(pluginName, 'removeAllListeners');
    },
  };
}

/**
 * The `LlamaCpp` facade the supervisor builds from the engine's definition.
 *
 * The supervisor is no longer itself a plugin implementation: it serves any
 * number of engines, and an object carrying every engine's methods at once has
 * no way to say which `generate` a call meant. `main.ts` registers this same
 * facade; these tests call it directly where the point is the supervisor rather
 * than the whole bridge.
 */
interface LlamaFacade {
  getCapabilities(): Promise<unknown>;
  getThermalState(): Promise<unknown>;
  load(options: unknown): Promise<unknown>;
  unload(options: unknown): Promise<unknown>;
  listLoaded(): Promise<unknown>;
  generate(senderId: number, options: unknown): Promise<unknown>;
  cancel(senderId: number, options: unknown): Promise<void>;
}

function llamaOf(supervisor: Supervisor): LlamaFacade {
  return supervisor.plugin(LLAMA_PLUGIN.name) as unknown as LlamaFacade;
}

interface Harness {
  /** The page's view: through contextBridge, through the real shim. */
  readonly bridge: PageBridge;
  /** What `contextBridge.exposeInMainWorld` published, as the page sees it. */
  readonly exposed: PreloadBridge;
  /** The preload object itself, before it crosses anything. */
  readonly preload: PreloadBridge;
  readonly host: PluginHost;
  readonly supervisor: Supervisor;
  readonly clock: ManualClock;
  /** Every channel the renderer named, in order. */
  readonly channels: string[];
  /** Every host the supervisor has spawned, oldest first. */
  readonly hosts: LinkPair[];
  killHost(reason?: string): void;
  destroyRenderer(): void;
}

interface HarnessOptions {
  readonly dsh?: PluginImplementation;
  readonly policy?: Partial<SupervisorPolicy>;
}

/** Renderer -> preload -> main -> inference host, all real, twice serialized. */
function harness(
  plugin: LlamaCppPlugin | (() => LlamaCppPlugin),
  options: HarnessOptions = {},
): Harness {
  const make = typeof plugin === 'function' ? plugin : (): LlamaCppPlugin => plugin;
  const hosts: LinkPair[] = [];

  let eventListener: ((payload: unknown) => void) | null = null;
  let rendererAlive = true;

  const host = new PluginHost((_senderId, payload) => {
    if (!rendererAlive || eventListener === null) return false;
    const cloned = structuredClone(payload);
    const deliver = eventListener;
    queueMicrotask(() => deliver(cloned));
    return true;
  });

  const clock = manualClock();
  const supervisor = new Supervisor({
    // A FACTORY, exactly as `main.ts` supplies one: each call is a new host
    // process with a new port, which is what makes a respawn observable.
    spawn: () => {
      const pair = createLinkPair();
      // Through the GENERIC runtime, with llama.cpp's own policy passed in —
      // the same two lines `host/entry.ts` runs. A convenience wrapper here
      // would leave the shipped registration path untested.
      createHostRuntime({ link: pair.host }).serve(LLAMA_PLUGIN, make(), LLAMA_HOST_POLICY);
      hosts.push(pair);
      return {
        link: pair.main,
        kill: () => {
          pair.killedBySupervisor = true;
          pair.kill('terminated by the supervisor');
        },
      };
    },
    notify: (pluginName, eventName, data, ownerId) =>
      host.notifyListeners(pluginName, eventName, data, ownerId),
    timers: clock,
    ...(options.policy === undefined ? {} : { policy: options.policy }),
  });

  host.register(LLAMA_PLUGIN, supervisor.plugin(LLAMA_PLUGIN.name));
  if (options.dsh !== undefined) host.register(DSH_PLUGIN, options.dsh);

  const router = createMainRouter(host);
  const channels: string[] = [];

  const ipc: RendererIpc = {
    sendSync(channel) {
      channels.push(channel);
      return structuredClone(router.bootstrap());
    },
    async invoke(channel, payload) {
      channels.push(channel);
      const cloned = structuredClone(payload);
      return structuredClone(await router.handle(1, channel, cloned));
    },
    on(channel, listener) {
      if (channel === EVENT_CHANNEL) eventListener = listener;
    },
  };

  const preload = createRendererBridge(ipc);
  const exposed = crossContextBridge(preload);

  return {
    bridge: pageBridge(exposed),
    exposed,
    preload,
    host,
    supervisor,
    clock,
    channels,
    hosts,
    killHost: (reason = 'SIGKILL') => hosts[hosts.length - 1]?.kill(reason),
    destroyRenderer: () => {
      rendererAlive = false;
      // Through the same dispatcher `main.ts` uses, rather than a copy of what
      // it happens to do today: the point of `releaseRendererOn` is that all
      // three departures run one teardown, and a test that reimplements the
      // teardown proves only that the test agrees with itself.
      releaseRendererOn('destroyed', 1, {
        releaseSender: (id) => host.releaseSender(id),
        releaseRenderer: (id, reason) => supervisor.releaseRenderer(id, reason),
        forget: () => undefined,
      });
    },
  };
}

/* ── A llama.cpp engine, without a GGUF ───────────────────────────────── */

class FakeVocabulary {
  readonly #ids = new Map<string, number>();
  readonly #texts: string[] = [];
  encode(text: string): LlamaTokenId[] {
    return (text.match(/\S+\s*|\s+/g) ?? []).map((piece) => {
      const existing = this.#ids.get(piece);
      if (existing !== undefined) return existing;
      const id = this.#texts.push(piece) - 1;
      this.#ids.set(piece, id);
      return id;
    });
  }
  decode(tokens: readonly LlamaTokenId[]): string {
    return tokens.map((token) => this.#texts[token] ?? '').join('');
  }
}

class FakeSequence implements LlamaEngineSequence {
  state: LlamaTokenId[] = [];
  readonly tokenPredictions = { validated: 0, refuted: 0 };
  /** Tokens the engine actually produced, so a cancel can be shown to bite. */
  emitted = 0;

  constructor(
    private readonly vocabulary: FakeVocabulary,
    private readonly reply: string,
  ) {}

  get nextTokenIndex(): number {
    return this.state.length;
  }
  compareContextTokens(tokens: LlamaTokenId[]): { firstDifferentIndex: number } {
    for (let i = 0; i < this.state.length; i += 1) {
      if (this.state[i] !== tokens[i]) return { firstDifferentIndex: i };
    }
    return { firstDifferentIndex: this.state.length };
  }
  async adaptStateToTokens(tokens: LlamaTokenId[]): Promise<void> {
    this.state = this.state.slice(0, this.compareContextTokens(tokens).firstDifferentIndex);
  }
  async clearHistory(): Promise<void> {
    this.state = [];
  }
  async *evaluate(tokens: LlamaTokenId[]): AsyncIterable<LlamaTokenId> {
    this.state.push(...tokens);
    for (const token of this.vocabulary.encode(this.reply)) {
      // A real decode step is not instantaneous, and a cancel that has to
      // cross two serialized boundaries needs somewhere to land. A synchronous
      // generator here would make the cancellation test pass for the wrong
      // reason — or never pass at all.
      await new Promise((done) => setTimeout(done, 1));
      this.state.push(token);
      this.emitted += 1;
      yield token;
    }
  }
  async evaluateWithoutGeneratingNewTokens(tokens: LlamaTokenId[]): Promise<void> {
    this.state.push(...tokens);
  }
  async dispose(): Promise<void> {}
}

class FakeContext implements LlamaEngineContext {
  readonly contextSize = 4096;
  readonly sequences: FakeSequence[] = [];
  constructor(
    private readonly vocabulary: FakeVocabulary,
    private readonly reply: string,
  ) {}
  getSequence(): LlamaEngineSequence {
    const sequence = new FakeSequence(this.vocabulary, this.reply);
    this.sequences.push(sequence);
    return sequence;
  }
  async dispose(): Promise<void> {}
}

class FakeModel implements LlamaEngineModel {
  readonly trainContextSize = 8192;
  readonly chatTemplateName = 'chatML';
  readonly contexts: FakeContext[] = [];
  constructor(
    private readonly vocabulary: FakeVocabulary,
    private readonly reply: string,
  ) {}
  tokenize(text: string): LlamaTokenId[] {
    return this.vocabulary.encode(text);
  }
  detokenize(tokens: readonly LlamaTokenId[]): string {
    return this.vocabulary.decode(tokens);
  }
  async createContext(): Promise<LlamaEngineContext> {
    const context = new FakeContext(this.vocabulary, this.reply);
    this.contexts.push(context);
    return context;
  }
  async dispose(): Promise<void> {}
}

class FakeEngine implements LlamaEngine {
  readonly gpu: LlamaGpu = false;
  readonly engineVersion = 'llama.cpp b-fake';
  readonly models: FakeModel[] = [];
  readonly #vocabulary = new FakeVocabulary();
  constructor(private readonly reply: string) {}
  async listGpuTypes(): Promise<LlamaGpu[]> {
    return [];
  }
  async getMemoryState(): Promise<{ free: number; total: number }> {
    return { free: 0, total: 0 };
  }
  async loadModel(): Promise<LlamaEngineModel> {
    const model = new FakeModel(this.#vocabulary, this.reply);
    this.models.push(model);
    return model;
  }
  async dispose(): Promise<void> {}
}

function realPlugin(reply: string): { plugin: LlamaCppNode; engine: FakeEngine } {
  const engine = new FakeEngine(reply);
  return { plugin: new LlamaCppNode({ createEngine: async () => engine }), engine };
}

/**
 * A plugin whose `generate` does whatever a test tells it to.
 *
 * This is the fault injector for the terminal-event rule: a host that emits
 * `llamaEnd` twice, or never, or dies without emitting at all. `LlamaCppNode`
 * cannot be made to do any of those — it is correct — so proving the
 * supervisor's guard is real needs a host that is not.
 */
class ScriptedPlugin {
  readonly #listeners = new Map<string, Set<(event: unknown) => void>>();
  constructor(
    private readonly onGenerate: (
      options: GenerateOptions,
      emit: (name: string, data: unknown) => void,
    ) => Promise<GenerateResult>,
  ) {}
  emit(name: string, data: unknown): void {
    for (const listener of this.#listeners.get(name) ?? []) listener(data);
  }
  async addListener(name: string, listener: (event: unknown) => void): Promise<{ remove(): Promise<void> }> {
    const set = this.#listeners.get(name) ?? new Set();
    set.add(listener);
    this.#listeners.set(name, set);
    return { remove: async () => void set.delete(listener) };
  }
  async removeAllListeners(): Promise<void> {
    this.#listeners.clear();
  }
  generate(options: GenerateOptions): Promise<GenerateResult> {
    return this.onGenerate(options, (name, data) => this.emit(name, data));
  }
  async cancel(): Promise<void> {}
  async getCapabilities(): Promise<unknown> {
    return { simulated: true };
  }
}

function scripted(
  onGenerate: (
    options: GenerateOptions,
    emit: (name: string, data: unknown) => void,
  ) => Promise<GenerateResult>,
): LlamaCppPlugin {
  return new ScriptedPlugin(onGenerate) as unknown as LlamaCppPlugin;
}

function endEvent(requestId: string, stopReason: GenerateResult['stopReason']): GenerationEndEvent {
  return {
    requestId,
    text: '',
    promptTokens: 0,
    cachedTokens: 0,
    completionTokens: 0,
    ttftMs: 0,
    totalMs: 1,
    tokensPerSecond: 0,
    stopReason,
  };
}

/** Subscribe through the real preload bridge and collect what arrives. */
async function collect<T>(bridge: PageBridge, eventName: string): Promise<T[]> {
  const received: T[] = [];
  await bridge.addListener(LLAMA_PLUGIN.name, eventName, (data) => received.push(data as T));
  return received;
}

const settle = async (): Promise<void> => {
  await new Promise((done) => setTimeout(done, 10));
};

async function loadOne(bridge: PageBridge): Promise<string> {
  const result = (await bridge.invoke(LLAMA_PLUGIN.name, 'load', [
    { modelPath: '/models/test.gguf' },
  ])) as { handle: string };
  return result.handle;
}

/* ══ The terminal-event rule, across the boundary ═══════════════════════ */

describe('exactly one llamaEnd reaches the renderer', () => {
  it('on success', async () => {
    // FAULT INJECTED: deleting the `if (entry.ended) return;` guard in
    // Supervisor.#settle made this 2 (the host's own event, then the
    // synthesised one on `ret`). Observed as `expected 2 to be 1`.
    const { plugin } = realPlugin('hello there friend');
    const h = harness(plugin);
    const ends = await collect<GenerationEndEvent>(h.bridge, 'llamaEnd');
    const handle = await loadOne(h.bridge);

    const result = (await h.bridge.invoke(LLAMA_PLUGIN.name, 'generate', [
      { handle, prompt: 'hi', requestId: 'r1' },
    ])) as GenerateResult;
    await settle();

    expect(result.stopReason).toBe('stop');
    expect(result.text).toBe('hello there friend');
    expect(ends).toHaveLength(1);
    expect(ends[0]?.requestId).toBe('r1');
    expect(h.supervisor.inflightCount).toBe(0);
  });

  it('on error, and the invoke rejects rather than hanging', async () => {
    const { plugin } = realPlugin('never reached');
    const h = harness(plugin);
    const ends = await collect<GenerationEndEvent>(h.bridge, 'llamaEnd');

    await expect(
      h.bridge.invoke(LLAMA_PLUGIN.name, 'generate', [
        { handle: 'no-such-handle', prompt: 'hi', requestId: 'r2' },
      ]),
    ).rejects.toThrow(/No model is loaded/);
    await settle();

    expect(ends).toHaveLength(1);
    expect(ends[0]?.stopReason).toBe('error');
  });

  it('on cancel, and the cancel actually stops the generation', async () => {
    // FAULT INJECTED two ways. (1) Making Supervisor.cancel a no-op left
    // stopReason 'stop' and all 6 tokens emitted. (2) Making the fake
    // sequence's `evaluate` synchronous (no await between tokens) also left
    // all 6 — which is why the await is there and commented, rather than
    // being an accident of the fixture.
    const { plugin, engine } = realPlugin('one two three four five six');
    const h = harness(plugin);
    const ends = await collect<GenerationEndEvent>(h.bridge, 'llamaEnd');
    const tokens = await collect<TokenEvent>(h.bridge, 'llamaToken');
    const handle = await loadOne(h.bridge);

    const generation = h.bridge.invoke(LLAMA_PLUGIN.name, 'generate', [
      { handle, prompt: 'hi', requestId: 'r3' },
    ]);
    // Let a couple of tokens through, then cancel across both boundaries.
    await new Promise((done) => setTimeout(done, 3));
    await h.bridge.invoke(LLAMA_PLUGIN.name, 'cancel', [{ requestId: 'r3' }]);

    const result = (await generation) as GenerateResult;
    await settle();

    expect(result.stopReason).toBe('cancelled');
    expect(ends).toHaveLength(1);
    expect(ends[0]?.stopReason).toBe('cancelled');

    const sequence = engine.models[0]?.contexts[0]?.sequences[0];
    expect(sequence).toBeDefined();
    // Six tokens were available; the cancel has to have cut it short, or this
    // test would pass against a build where cancellation does nothing.
    expect(sequence?.emitted).toBeLessThan(6);
    expect(tokens.length).toBe(result.completionTokens);
  });

  it('when a faulty host emits llamaEnd twice for one request', async () => {
    // The injected fault IS the test: `LlamaCppNode` cannot be made to do
    // this, so the supervisor's idempotence needs a host that is wrong.
    const h = harness(
      scripted(async (options, emit) => {
        emit('llamaEnd', endEvent(options.requestId, 'stop'));
        emit('llamaEnd', endEvent(options.requestId, 'stop'));
        return endEvent(options.requestId, 'stop');
      }),
    );
    const ends = await collect<GenerationEndEvent>(h.bridge, 'llamaEnd');

    await h.bridge.invoke(LLAMA_PLUGIN.name, 'generate', [
      { handle: 'h', prompt: 'p', requestId: 'r4' },
    ]);
    await settle();

    expect(ends).toHaveLength(1);
  });

  it('when a faulty host returns without emitting llamaEnd at all', async () => {
    // The other direction: nothing to deduplicate, so the supervisor has to
    // synthesise one. Deleting that `#settle` call in the resolve path made
    // this 0 — a turn the UI would never see end if it waited on the event.
    const h = harness(scripted(async (options) => endEvent(options.requestId, 'length')));
    const ends = await collect<GenerationEndEvent>(h.bridge, 'llamaEnd');

    await h.bridge.invoke(LLAMA_PLUGIN.name, 'generate', [
      { handle: 'h', prompt: 'p', requestId: 'r5' },
    ]);
    await settle();

    expect(ends).toHaveLength(1);
    expect(ends[0]?.stopReason).toBe('length');
  });

  it('when the inference process is killed mid-generation', async () => {
    // The failure the whole three-process topology exists for. Without
    // Supervisor.#onClose the generate promise stays pending FOREVER —
    // `ipcRenderer.invoke` has no timeout — and vitest reports a test that
    // hangs until the suite times out rather than one that fails.
    const h = harness(
      scripted(
        () =>
          new Promise<GenerateResult>(() => {
            /* never settles: the host dies first */
          }),
      ),
    );
    const ends = await collect<GenerationEndEvent>(h.bridge, 'llamaEnd');

    const generation = h.bridge.invoke(LLAMA_PLUGIN.name, 'generate', [
      { handle: 'h', prompt: 'p', requestId: 'r6' },
    ]);
    await settle();
    h.killHost('SIGKILL');

    await expect(generation).rejects.toThrow(/inference process stopped unexpectedly/);
    await expect(generation).rejects.toMatchObject({ code: HANDLE_LOST });
    await settle();

    expect(ends).toHaveLength(1);
    expect(ends[0]?.stopReason).toBe('error');
    expect(h.supervisor.inflightCount).toBe(0);
  });

  it('is not emitted at all when the renderer that asked for it is gone', async () => {
    // A synthesised terminal event broadcast after a reload would be a turn
    // the new page never started. The turn is settled locally instead.
    const h = harness(
      scripted(
        () =>
          new Promise<GenerateResult>(() => {
            /* still running when the window closes */
          }),
      ),
    );
    const ends = await collect<GenerationEndEvent>(h.bridge, 'llamaEnd');

    const generation = h.bridge.invoke(LLAMA_PLUGIN.name, 'generate', [
      { handle: 'h', prompt: 'p', requestId: 'r7' },
    ]);
    await settle();
    h.destroyRenderer();

    await expect(generation).rejects.toMatchObject({ code: 'RENDERER_GONE' });
    await settle();

    expect(ends).toHaveLength(0);
    expect(h.supervisor.inflightCount).toBe(0);
    expect(h.host.subscriptionCount()).toBe(0);
  });
});

/* ══ Subscriptions ══════════════════════════════════════════════════════ */

describe('listener lifecycle', () => {
  it('an event arriving after removeAllListeners does not reach the removed listener', async () => {
    // FAULT INJECTED: making PluginHost.removeAllListeners a no-op failed on
    // the subscription count first — `expected 1 to be +0` — because the main
    // side had kept the entry. Both sides are asserted on purpose: the
    // renderer's callback map is cleared too, so a page that ignored the
    // round trip would still stop hearing the event, and a main side that
    // ignored it would still stop sending.
    const { plugin } = realPlugin('a b c');
    const h = harness(plugin);
    const tokens = await collect<TokenEvent>(h.bridge, 'llamaToken');
    const handle = await loadOne(h.bridge);

    await h.bridge.removeAllListeners(LLAMA_PLUGIN.name);
    expect(h.host.subscriptionCount()).toBe(0);

    const result = (await h.bridge.invoke(LLAMA_PLUGIN.name, 'generate', [
      { handle, prompt: 'hi', requestId: 'r8' },
    ])) as GenerateResult;
    await settle();

    expect(tokens).toHaveLength(0);
    // The turn still completed. This is the property that makes the invoke
    // promise the authority and the event merely advisory: dropping every
    // listener mid-flight cannot hang the UI.
    expect(result.stopReason).toBe('stop');
    expect(result.text).toBe('a b c');
  });

  it('a removed handle stops receiving while a sibling keeps receiving', async () => {
    const { plugin } = realPlugin('x y');
    const h = harness(plugin);
    const kept: TokenEvent[] = [];
    const dropped: TokenEvent[] = [];
    await h.bridge.addListener(LLAMA_PLUGIN.name, 'llamaToken', (d) => kept.push(d as TokenEvent));
    const id = await h.bridge.addListener(LLAMA_PLUGIN.name, 'llamaToken', (d) =>
      dropped.push(d as TokenEvent),
    );
    await h.bridge.removeListener(id);

    const handle = await loadOne(h.bridge);
    await h.bridge.invoke(LLAMA_PLUGIN.name, 'generate', [
      { handle, prompt: 'hi', requestId: 'r9' },
    ]);
    await settle();

    expect(kept.length).toBeGreaterThan(0);
    expect(dropped).toHaveLength(0);
  });

  it('refuses a subscription to an event the plugin does not declare', async () => {
    const h = harness(scripted(async (o) => endEvent(o.requestId, 'stop')));
    await expect(
      h.bridge.addListener(LLAMA_PLUGIN.name, 'llamaWhatever', () => undefined),
    ).rejects.toThrow(/emits no event "llamaWhatever"/);
    expect(h.host.subscriptionCount()).toBe(0);
  });
});

/* ══ The serialization boundary ═════════════════════════════════════════ */

describe('values that cannot cross are refused, not silently mangled', () => {
  it('refuses a function in the arguments before a channel is named', async () => {
    const h = harness(scripted(async (o) => endEvent(o.requestId, 'stop')));
    const before = h.channels.length;
    await expect(
      h.bridge.invoke(LLAMA_PLUGIN.name, 'generate', [{ onToken: (): void => undefined }]),
    ).rejects.toThrow(/functions are not cloneable/);
    // Refused in the preload, so nothing was ever sent.
    expect(h.channels.length).toBe(before);
  });

  it('refuses an AbortSignal, which is what makes requestId-keyed cancel the design', async () => {
    const h = harness(scripted(async (o) => endEvent(o.requestId, 'stop')));
    await expect(
      h.bridge.invoke(LLAMA_PLUGIN.name, 'generate', [
        { requestId: 'r', signal: new AbortController().signal },
      ]),
    ).rejects.toThrow(/AbortSignal is a class instance/);
  });

  it('refuses a class instance, which structuredClone would deliver prototype-stripped', () => {
    // THE QUIET FAILURE, and the reason `assertCloneable` exists at all.
    // structuredClone does NOT throw here: it returns a plain object that
    // looks right and has no methods. Proven rather than asserted.
    class LoadedHandle {
      constructor(readonly handle: string) {}
      describe(): string {
        return `handle ${this.handle}`;
      }
    }
    const value = new LoadedHandle('h1');
    const survived = structuredClone(value) as LoadedHandle;
    expect(survived.handle).toBe('h1');
    expect((survived as { describe?: unknown }).describe).toBeUndefined();

    expect(() => assertCloneable({ loaded: value }, 'args')).toThrow(
      /args\.loaded cannot cross.*LoadedHandle is a class instance/s,
    );
  });

  it('allows the shapes the protocol actually uses', () => {
    expect(() =>
      assertCloneable({
        prompt: 'hi',
        images: [{ data: 'AAA', mediaType: 'image/png' }],
        sampler: { stopSequences: ['<|im_end|>'], seed: null, maxTokens: 64 },
        buffer: new Uint8Array([1, 2, 3]),
        when: new Date(0),
        cause: new TypeError('nope'),
      }),
    ).not.toThrow();
  });

  it('refuses a non-cloneable RESULT rather than letting it arrive as {}', async () => {
    class Weird {
      readonly n = 1;
    }
    const h = harness(scripted(async (o) => endEvent(o.requestId, 'stop')));
    // Register a second plugin whose method returns something unsendable.
    h.host.register(
      { name: 'Odd', methods: ['bad'], events: [] },
      { bad: async () => new Weird() },
    );
    await expect(h.host.invoke(1, 'Odd', 'bad', [])).rejects.toThrow(/Weird is a class instance/);
  });

  it('refuses a non-cloneable EVENT payload rather than delivering half of it', () => {
    const host = new PluginHost(() => true);
    host.register(LLAMA_PLUGIN, Object.fromEntries(
      LLAMA_METHODS.map((m) => [m, async () => undefined]),
    ) as PluginImplementation);
    host.addListener(1, LLAMA_PLUGIN.name, 'llamaToken', 1);
    expect(() =>
      host.notifyListeners(LLAMA_PLUGIN.name, 'llamaToken', { emit: (): void => undefined }),
    ).toThrow(/functions are not cloneable/);
  });
});

/* ══ The channel allowlist ══════════════════════════════════════════════ */

describe('the renderer can only ever name a channel from the manifest', () => {
  it('exposes exactly the five allowlisted functions', () => {
    const h = harness(scripted(async (o) => endEvent(o.requestId, 'stop')));
    // Asserted against the PRELOAD object, which is the one `contextBridge`
    // actually publishes — the page's view is built from it by the shim and
    // would hide a sixth property rather than reveal one.
    const exposed = Object.fromEntries(
      BRIDGE_KEYS.map((key) => [key, (h.preload as unknown as Record<string, unknown>)[key]]),
    );
    // Both directions: nothing missing, and nothing extra. The preload builds
    // the exposed object from this same list, so the allowlist is one list.
    expect(Object.keys(exposed).sort()).toEqual([...BRIDGE_KEYS].sort());
    expect(Object.keys(h.preload).sort()).toEqual([...BRIDGE_KEYS].sort());
    for (const key of BRIDGE_KEYS) expect(typeof exposed[key]).toBe('function');
    expect((h.preload as unknown as Record<string, unknown>)['ipcRenderer']).toBeUndefined();
    expect((h.preload as unknown as Record<string, unknown>)['require']).toBeUndefined();
  });

  it('touches no channel outside the allowlist during a whole session', async () => {
    const { plugin } = realPlugin('a b');
    const h = harness(plugin);
    await collect(h.bridge, 'llamaToken');
    const handle = await loadOne(h.bridge);
    await h.bridge.invoke(LLAMA_PLUGIN.name, 'generate', [
      { handle, prompt: 'hi', requestId: 'rA' },
    ]);
    await h.bridge.removeAllListeners(LLAMA_PLUGIN.name);

    const allowed = allowedChannels(h.bridge.getBootstrap());
    expect(h.channels.length).toBeGreaterThan(3);
    expect(h.channels.filter((channel) => !allowed.has(channel))).toEqual([]);
  });

  it('refuses an undeclared method without sending anything', async () => {
    const h = harness(scripted(async (o) => endEvent(o.requestId, 'stop')));
    const before = h.channels.length;
    await expect(h.bridge.invoke(LLAMA_PLUGIN.name, 'evalArbitrary', [])).rejects.toThrow(
      /has no method "evalArbitrary"/,
    );
    await expect(h.bridge.invoke('Filesystem', 'readFile', [])).rejects.toThrow(
      /no plugin named "Filesystem"/,
    );
    expect(h.channels.length).toBe(before);
  });

  it('refuses an undeclared method on the main side too, not only in the preload', async () => {
    // The preload's guard is a better error message; this one is the rule.
    const h = harness(scripted(async (o) => endEvent(o.requestId, 'stop')));
    await expect(h.host.invoke(1, LLAMA_PLUGIN.name, 'evalArbitrary', [])).rejects.toThrow(
      /has no method "evalArbitrary"/,
    );
    const router = createMainRouter(h.host);
    const answer = await router.handle(1, 'chatterang:call:LlamaCpp:evalArbitrary', []);
    expect(answer).toMatchObject({ ok: false });
  });

  it('cannot produce a method channel that collides with a listener channel', () => {
    // `@capawesome/capacitor-electron` builds both as `capacitor:<plugin>:
    // <method>`, so a plugin with a method called `addListener` registers two
    // ipcMain handlers on one channel and throws at boot. The namespaces here
    // are disjoint by construction; these are the adversarial cases.
    expect(
      channelCollisions([
        { name: 'LlamaCpp', methods: ['addListener', 'removeAllListeners'], events: [] },
        { name: 'listener', methods: ['add', 'remove', 'remove-all'], events: [] },
        { name: 'call', methods: ['LlamaCpp'], events: [] },
      ]),
    ).toEqual([]);
    expect(methodChannel('listener', 'add')).not.toBe('chatterang:listener:add');
  });

  it('still refuses a plugin that declares a bridge-owned method name', () => {
    const host = new PluginHost(() => true);
    expect(() =>
      host.register(
        { name: 'Bad', methods: ['addListener'], events: [] },
        { addListener: async () => undefined },
      ),
    ).toThrow(/reserved method\(s\): addListener/);
  });

  it('refuses a plugin whose implementation is missing a declared method', () => {
    // Caught at registration, where it reads as a missing forwarder, rather
    // than at runtime where it reads as a broken bridge.
    const host = new PluginHost(() => true);
    expect(() => host.register(LLAMA_PLUGIN, { load: async () => undefined })).toThrow(
      /does not have: getCapabilities/,
    );
  });

  it('registers the real Supervisor facade without complaint, so the forwarders all exist', () => {
    // The counterpart to the test above: the check is only worth having if it
    // passes for the object we actually ship. The facade is BUILT from the
    // definition, so this also says the two cannot drift — a method added to
    // `LLAMA_METHODS` gets a forwarder by construction rather than by someone
    // remembering to write one.
    const pair = createLinkPair();
    const host = new PluginHost(() => true);
    const supervisor = new Supervisor({
      spawn: () => ({ link: pair.main, kill: () => pair.kill('terminated') }),
      notify: () => undefined,
      timers: manualClock(),
    });
    expect(() => host.register(LLAMA_PLUGIN, supervisor.plugin(LLAMA_PLUGIN.name))).not.toThrow();
    expect(LLAMA_METHODS).toHaveLength(10);
    expect(LLAMA_EVENTS).toEqual(['llamaToken', 'llamaEnd', 'llamaThermal']);
    // And a name it serves no engine for is refused rather than registered as
    // a manifest entry whose every call would fail at runtime.
    expect(() => supervisor.plugin('OnnxRuntime')).toThrow(/serves no engine named "OnnxRuntime"/);
  });
});

/* ══ The real @capacitor/core, unchanged src/ ═══════════════════════════ */

describe('registerPlugin in src/ resolves to the desktop bridge', () => {
  // ONE registration for the whole block, on purpose. `@capacitor/core`
  // installs `window.Capacitor` at module load and refuses to register a
  // plugin name twice, and `vi.resetModules()` cannot help: vitest
  // externalizes node_modules, so the module is loaded natively and survives
  // a registry reset. Discovered by the second test in this block failing with
  // Capacitor's own "already registered" warning and zero subscriptions.
  let shared: Harness;
  let LlamaCpp: LlamaCppPlugin;
  let platform = '';

  beforeAll(async () => {
    shared = harness(realPlugin('p q r').plugin);
    installCapacitorShim(globalThis as never, shared.exposed);
    const core = await import('@capacitor/core');
    LlamaCpp = core.registerPlugin<LlamaCppPlugin>('LlamaCpp', {
      web: async () => new (await import('@/plugins/llama-cpp/web')).LlamaCppWeb(),
    });
    platform = core.Capacitor.getPlatform();
  });

  afterAll(() => {
    delete (globalThis as { Capacitor?: unknown }).Capacitor;
    delete (globalThis as { CapacitorCustomPlatform?: unknown }).CapacitorCustomPlatform;
  });

  it('routes a method call through the bridge and not through the web shim', async () => {
    expect(platform).toBe('electron');
    const capabilities = await LlamaCpp.getCapabilities();
    // The web shim reports `simulated: true`; the Node engine reports false.
    // This assertion is the whole point of the test: with the header missing,
    // Capacitor serves the call from the shim and this reads `true`.
    expect(capabilities.simulated).toBe(false);
    expect(capabilities.engineVersion).toContain('b-fake');
  });

  it('addListener resolves to a ListenerHandle whose remove() actually removes', async () => {
    // THE CLAIM THIS TEST EXISTS FOR. With a plugin header, Capacitor's proxy
    // takes the `addListenerNative` path, which wraps the event name as
    // `addListener({eventName}, cb)` before it reaches our `nativeCallback`.
    // Without one it passes the bare STRING, and `options.eventName` would be
    // undefined — a subscription that registers cleanly and never fires.
    // FAULT INJECTED: dropping the `addListener` entry from the headers gave
    // `expected +0 to be 1` on the subscription count — and the reason is
    // worse than the bare-string hazard above. With no header for the method,
    // `createPluginMethod` falls through to `impl[prop].bind(impl)` and binds
    // the WEB SHIM's own `addListener`. The call succeeds, a handle comes
    // back, and the subscription is registered against a simulator that will
    // never produce a token. Silent, and invisible from the page.
    const h = shared;
    const seen: TokenEvent[] = [];
    const handle = await LlamaCpp.addListener('llamaToken', (event) => seen.push(event));
    expect(typeof handle.remove).toBe('function');
    expect(h.host.subscriptionCount()).toBe(1);

    const loaded = await LlamaCpp.load({ modelPath: '/models/test.gguf' });
    await LlamaCpp.generate({ handle: loaded.handle, prompt: 'hi', requestId: 'rc1' });
    await settle();
    expect(seen.length).toBeGreaterThan(0);

    await handle.remove();
    expect(h.host.subscriptionCount()).toBe(0);

    const before = seen.length;
    await LlamaCpp.generate({ handle: loaded.handle, prompt: 'hi again', requestId: 'rc2' });
    await settle();
    expect(seen.length).toBe(before);
  });

  it('removeAllListeners() goes through the bridge, not through the web shim', async () => {
    const h = shared;
    await LlamaCpp.addListener('llamaToken', () => undefined);
    await LlamaCpp.addListener('llamaEnd', () => undefined);
    expect(h.host.subscriptionCount()).toBe(2);
    await LlamaCpp.removeAllListeners();
    expect(h.host.subscriptionCount()).toBe(0);
  });

  it('the shim source is self-contained, so the main world can evaluate it', () => {
    // The preload runs this function's OWN SOURCE through
    // `webFrame.executeJavaScript`, because contextBridge publishes frozen
    // objects and `createCapacitor` writes to `window.Capacitor`. A call to a
    // module-scope helper would typecheck, bundle, and throw ReferenceError at
    // startup. FAULT INJECTED: extracting the header builder into a
    // module-level `pluginHeaders()` made this throw
    // `pluginHeaders is not defined`.
    const manifest = { platform: 'electron', plugins: [LLAMA_PLUGIN] };
    const fakeWindow: Record<string, unknown> = {
      __chatterangDesktop: { getBootstrap: () => manifest },
    };
    const source = capacitorShimSource('__chatterangDesktop');
    // Evaluated with `window` as its ONLY free variable, exactly as the main
    // world would provide it — nothing from this module is in scope.
    new Function('window', source)(fakeWindow);

    const capacitor = fakeWindow['Capacitor'] as { PluginHeaders: { name: string; methods: { name: string }[] }[] };
    expect(fakeWindow['CapacitorCustomPlatform']).toEqual({ name: 'electron' });
    expect(capacitor.PluginHeaders[0]?.name).toBe('LlamaCpp');
    expect(capacitor.PluginHeaders[0]?.methods.map((m) => m.name)).toContain('addListener');
    expect(capacitor.PluginHeaders[0]?.methods.map((m) => m.name)).toContain('generate');
  });
});

/* ══ The src/ adapter's half of the crash contract ══════════════════════ */

describe('a lost handle is dropped rather than cached forever', () => {
  it('the adapter reloads the model after a HANDLE_LOST failure', async () => {
    // Without this, a host restart wedges the adapter permanently: every retry
    // re-sends a handle that no longer exists and fails identically until the
    // app is relaunched. FAULT INJECTED: removing `#forgetHandleOnLoss` from
    // the stream catch left `loads` at 1 and the second turn failing too.
    vi.resetModules();
    const calls = { load: 0, generate: 0 };
    const fake = {
      load: async () => {
        calls.load += 1;
        return {
          handle: `h${calls.load}`,
          backend: 'cpu',
          contextLength: 4096,
          loadMs: 1,
          warnings: [],
          supportsVision: false,
          chatTemplate: 'chatml',
        };
      },
      unload: async () => undefined,
      generate: async () => {
        calls.generate += 1;
        if (calls.generate === 1) {
          const error = new Error('The inference process stopped unexpectedly (SIGKILL).');
          Object.assign(error, { code: HANDLE_LOST });
          throw error;
        }
        return {
          requestId: 'x',
          text: 'recovered',
          promptTokens: 1,
          cachedTokens: 0,
          completionTokens: 1,
          ttftMs: 1,
          totalMs: 1,
          tokensPerSecond: 1,
          stopReason: 'stop',
        };
      },
      cancel: async () => undefined,
      addListener: async () => ({ remove: async () => undefined }),
    };
    vi.doMock('@/plugins/llama-cpp', () => ({ LlamaCpp: fake }));

    const { LlamaCppBackendAdapter } = await import('@/ai/backends/llama-cpp');
    const adapter = new LlamaCppBackendAdapter({
      resolver: {
        getManifest: () => ({ name: 'M', contextLength: 4096, promptTemplate: 'chatml' }) as never,
        getPath: () => '/models/m.gguf',
        getSampler: () => ({ stopSequences: [], seed: null, draftModelId: null }) as never,
      },
    });

    const request = {
      messages: [{ role: 'user', content: 'hi' }],
      parameters: { model: 'm' },
      metadata: { requestId: 'q1', custom: {}, provenance: {} },
    } as never;

    await expect(adapter.execute(request)).rejects.toMatchObject({ code: HANDLE_LOST });
    expect(adapter.residentModelId).toBeNull();

    const response = await adapter.execute(request);
    expect(response.message.content).toBe('recovered');
    expect(calls.load).toBe(2);
    vi.doUnmock('@/plugins/llama-cpp');
  });
});

/* ══ The host comes back ════════════════════════════════════════════════ */

/**
 * A supervisor over hand-built links, for the cases the fake port cannot show.
 *
 * `createLinkPair` models a host honestly and therefore stops delivering when
 * it dies — which is exactly wrong for testing what happens when a host we
 * have given up on speaks anyway, or when a host is alive enough to answer
 * calls and not alive enough to answer a ping. These links are dumber and
 * fully controlled.
 */
interface WiredHost {
  readonly posted: unknown[];
  /** Deliver a message to main as if this host had sent it. */
  send(message: unknown): void;
  /** Signal `exit` to main. */
  close(reason: string): void;
  killed: boolean;
}

function wiredSupervisor(options: {
  policy?: Partial<SupervisorPolicy>;
  answer?: (host: WiredHost, message: HostMessage) => void;
  notify?: NotifyListeners;
  engines?: readonly EngineSpec[];
}): { supervisor: Supervisor; hosts: WiredHost[]; clock: ManualClock; warnings: string[] } {
  const hosts: WiredHost[] = [];
  const warnings: string[] = [];
  const clock = manualClock();
  const supervisor = new Supervisor({
    spawn: () => {
      const listeners: ((m: unknown) => void)[] = [];
      const closers: ((r: string) => void)[] = [];
      const host: WiredHost = {
        posted: [],
        killed: false,
        send: (message) => {
          for (const listener of listeners) listener(message);
        },
        close: (reason) => {
          for (const closer of closers) closer(reason);
        },
      };
      hosts.push(host);
      return {
        link: {
          postMessage: (message) => {
            host.posted.push(message);
            options.answer?.(host, message as HostMessage);
          },
          onMessage: (listener) => listeners.push(listener),
          onClose: (listener) => closers.push(listener),
        },
        kill: () => {
          host.killed = true;
        },
      };
    },
    notify: options.notify ?? ((): void => undefined),
    warn: (message) => warnings.push(message),
    timers: clock,
    ...(options.engines === undefined ? {} : { engines: options.engines }),
    ...(options.policy === undefined ? {} : { policy: options.policy }),
  });
  return { supervisor, hosts, clock, warnings };
}

describe('a dead inference host is replaced, not mourned', () => {
  it('a call that arrives after the host died succeeds against its replacement', async () => {
    // DEFECT [2]. The shipped build forked once and latched `#closed` forever:
    // kill the child and every later call failed with HANDLE_LOST until the
    // app was relaunched. FAULT INJECTED to confirm this test sees it —
    // deleting the `this.#scheduleRestart()` call from `#onClose` gave
    // `expected 1 to be 2` on spawnCount and left the second call rejecting
    // with "The inference process stopped unexpectedly (SIGKILL)."
    const h = harness(() => scripted(async (o) => endEvent(o.requestId, 'stop')));
    expect(await h.bridge.invoke(LLAMA_PLUGIN.name, 'getCapabilities', [])).toMatchObject({
      simulated: true,
    });

    h.killHost('SIGKILL');
    await settle();

    // The gap between one host dying and the next existing is not a hang: a
    // call made in it fails immediately, with the code the adapter recovers on.
    await expect(
      h.bridge.invoke(LLAMA_PLUGIN.name, 'getCapabilities', []),
    ).rejects.toMatchObject({ code: HANDLE_LOST });

    await h.clock.advance(DEFAULT_POLICY.restartDelayMs + 1);

    expect(h.supervisor.spawnCount).toBe(2);
    expect(h.hosts).toHaveLength(2);
    expect(await h.bridge.invoke(LLAMA_PLUGIN.name, 'getCapabilities', [])).toMatchObject({
      simulated: true,
    });
    // And a whole generation runs on the replacement, with its one llamaEnd.
    const ends = await collect<GenerationEndEvent>(h.bridge, 'llamaEnd');
    await h.bridge.invoke(LLAMA_PLUGIN.name, 'generate', [
      { handle: 'h', prompt: 'p', requestId: 'after-restart' },
    ]);
    await settle();
    expect(ends).toHaveLength(1);
    expect(ends[0]?.requestId).toBe('after-restart');
  });

  it('ignores a message from a host it has already given up on', async () => {
    // `MessageLink` has no unsubscribe, so a retired host's listener still
    // points at the supervisor. Call ids come from one counter and a restarted
    // host answers ids it never saw, so without the epoch check a late message
    // from a dead host settles a live call with a dead host's answer.
    // FAULT INJECTED: removing `if (epoch !== this.#generation) return;` from
    // the `onMessage` wiring in `#attach` resolved the second call with
    // `{ from: 'the host that died' }`.
    const { supervisor, hosts, clock } = wiredSupervisor({});
    hosts[0]?.close('exit code 9');
    await clock.advance(DEFAULT_POLICY.restartDelayMs + 1);
    expect(hosts).toHaveLength(2);

    const second = llamaOf(supervisor).getCapabilities();
    const call = hosts[1]?.posted.at(-1) as { k: string; id: number };
    expect(call.k).toBe('call');

    hosts[0]?.send({ k: 'ret', id: call.id, ok: true, data: { from: 'the host that died' } });
    await settle();
    hosts[1]?.send({ k: 'ret', id: call.id, ok: true, data: { from: 'the host that lives' } });

    expect(await second).toEqual({ from: 'the host that lives' });
  });

  it('reports the status of the host that is running, not the one that booted', async () => {
    // DEFECT [2], second half. `main.ts` held the first boot report in a
    // variable and served it forever, so after a respawn `DshHost.getStatus()`
    // answered `mounted: true` about a process that no longer existed —
    // and "mounted" is exactly what a caller checks before deciding the
    // inference stack is usable.
    const { supervisor, hosts, clock } = wiredSupervisor({});
    expect(supervisor.hostStatus().mounted).toBe(false);
    expect(supervisor.hostStatus().notChecked).toMatch(/has not finished booting/);

    hosts[0]?.send({
      k: 'boot',
      status: { mounted: true, services: ['llm'], routes: ['llama'], notChecked: 'walked' },
    });
    expect(supervisor.hostStatus()).toMatchObject({ mounted: true, routes: ['llama'] });

    hosts[0]?.close('exit code 9');
    // FAULT INJECTED: dropping `this.#boot = null;` from `#onClose` kept
    // `mounted: true` here — the stale answer the defect is about.
    expect(supervisor.hostStatus().mounted).toBe(false);
    expect(supervisor.hostStatus().error).toMatch(/stopped unexpectedly/);

    await clock.advance(DEFAULT_POLICY.restartDelayMs + 1);
    hosts[1]?.send({
      k: 'boot',
      status: { mounted: true, services: ['llm'], routes: ['llama-2'], notChecked: 'walked' },
    });
    expect(supervisor.hostStatus().routes).toEqual(['llama-2']);
  });

  it('stops restarting a host that will not stay up, and says so', async () => {
    // A host that dies on startup — a missing model directory, a native addon
    // that aborts on load — would otherwise be respawned forever, one process
    // per attempt. FAULT INJECTED: removing the `maxRestarts` check spun to
    // 200 spawns before the test's own loop stopped it.
    const { supervisor, hosts, clock } = wiredSupervisor({ policy: { maxRestarts: 3 } });
    for (let attempt = 0; attempt < 10; attempt += 1) {
      hosts.at(-1)?.close('exit code 1');
      await clock.advance(DEFAULT_POLICY.restartDelayMs + 1);
    }
    expect(supervisor.spawnCount).toBe(4);
    await expect(llamaOf(supervisor).getCapabilities()).rejects.toThrow(/is not being restarted again/);
  });

  it('terminates a host it replaces, so two are never decoding at once', async () => {
    const { hosts, clock } = wiredSupervisor({});
    hosts[0]?.close('exit code 9');
    await clock.advance(DEFAULT_POLICY.restartDelayMs + 1);
    // FAULT INJECTED: removing the `#retire()` call from `#onClose` left this
    // false — and in the app that is a wedged host still holding the GPU its
    // replacement is about to ask for.
    expect(hosts[0]?.killed).toBe(true);
    expect(hosts[1]?.killed).toBe(false);
  });
});

/* ══ A host that is alive and useless ═══════════════════════════════════ */

describe('a WEDGED host terminates too, though it never exits', () => {
  it('a generation that produces nothing is settled by its deadline, exactly once', async () => {
    // THE HANG THE TERMINAL-EVENT RULE EXISTS TO PREVENT, and the one path
    // that still produced it. A host that is alive but wedged — a spinning
    // decode, a hung Metal call — emits no `exit`, so `#onClose` never fires;
    // `ipcRenderer.invoke` has no timeout, so the renderer waits forever.
    // FAULT INJECTED: deleting the deadline sweep from `#tick` made this test
    // hang until vitest's own timeout killed it, which is precisely the
    // failure being fixed.
    const h = harness(
      scripted(
        () =>
          new Promise<GenerateResult>(() => {
            /* a wedged host: alive, answering pings, producing nothing */
          }),
      ),
    );
    const ends = await collect<GenerationEndEvent>(h.bridge, 'llamaEnd');

    const generation = h.bridge.invoke(LLAMA_PLUGIN.name, 'generate', [
      { handle: 'h', prompt: 'p', requestId: 'wedged' },
    ]);
    // The rejection is asserted below, but it HAPPENS inside `advance`, so it
    // needs a handler before then or Node reports an unhandled rejection and
    // vitest fails the file for a reason that is not the test's.
    void generation.catch(() => undefined);
    await settle();

    await h.clock.advance(DEFAULT_POLICY.generateIdleTimeoutMs + 1);

    await expect(generation).rejects.toMatchObject({ code: HOST_TIMEOUT });
    await expect(generation).rejects.toThrow(/stopped answering/);
    await settle();

    expect(ends).toHaveLength(1);
    expect(ends[0]?.stopReason).toBe('error');
    expect(h.supervisor.inflightCount).toBe(0);

    // And the host was NOT replaced: it is still answering pings, so as far as
    // the supervisor knows it is a host that produced a bad turn, not a dead
    // one. The deadline settles the turn; only the ping condemns the process.
    expect(h.supervisor.spawnCount).toBe(1);
  });

  it('a token buys its generation more time, so a long answer is not cut off', async () => {
    // A fixed cap on generation time would break exactly the workloads this
    // app exists for, and a timeout that breaks working generations gets
    // raised until it is useless. FAULT INJECTED: removing the `llamaToken`
    // branch from `#receive` timed the generation out at the first advance.
    let emitToken: ((data: unknown) => void) | null = null;
    const h = harness(
      scripted(
        (options, emit) =>
          new Promise<GenerateResult>(() => {
            emitToken = (data) => emit('llamaToken', data);
            void options;
          }),
      ),
    );
    const ends = await collect<GenerationEndEvent>(h.bridge, 'llamaEnd');
    const generation = h.bridge.invoke(LLAMA_PLUGIN.name, 'generate', [
      { handle: 'h', prompt: 'p', requestId: 'slow' },
    ]);
    void generation.catch(() => undefined);
    await settle();

    const idle = DEFAULT_POLICY.generateIdleTimeoutMs;
    await h.clock.advance(idle - 1_000);
    (emitToken as unknown as (data: unknown) => void)({
      requestId: 'slow',
      token: 'still here',
      index: 0,
    });
    await settle();

    // Past the ORIGINAL deadline, and still running because of that one token.
    await h.clock.advance(2_000);
    expect(ends).toHaveLength(0);
    expect(h.supervisor.inflightCount).toBe(1);

    await h.clock.advance(idle + 1);
    await expect(generation).rejects.toMatchObject({ code: HOST_TIMEOUT });
    await settle();
    expect(ends).toHaveLength(1);
  });

  it('a host that stops answering pings is condemned while its process still runs', async () => {
    // The other half of [4], and the one no `exit` can ever report. This host
    // answers calls it feels like answering and ignores pings entirely; its
    // process is alive throughout. FAULT INJECTED: removing the `#pingTick`
    // call from `#tick` left spawnCount at 1 forever — the wedged host is
    // never replaced and the app never works again.
    const { supervisor, hosts, clock } = wiredSupervisor({
      answer: (host, message) => {
        // Calls are answered; pings are not. Alive, and useless.
        if (message.k === 'call') host.send({ k: 'ret', id: message.id, ok: true, data: 'fine' });
      },
    });
    expect(await llamaOf(supervisor).getCapabilities()).toBe('fine');

    await clock.advance(DEFAULT_POLICY.pingIntervalMs + 1);
    expect((hosts[0]?.posted.at(-1) as { k: string }).k).toBe('ping');
    expect(supervisor.spawnCount).toBe(1);

    await clock.advance(DEFAULT_POLICY.pingTimeoutMs + 1);
    // Condemned, and terminated — the process was never going to exit on its
    // own, and leaving it running would double the GPU its replacement wants.
    expect(hosts[0]?.killed).toBe(true);

    await clock.advance(DEFAULT_POLICY.restartDelayMs + 1);
    expect(supervisor.spawnCount).toBe(2);
    expect(await llamaOf(supervisor).getCapabilities()).toBe('fine');
  });

  it('a host that answers pings is never condemned, however long it takes', async () => {
    // The counterpart, and the reason the ping is a separate mechanism from
    // the deadline: loading a 6 GB GGUF takes seconds during which no call
    // returns, and a liveness check that could not tell that from a wedge
    // would kill the host mid-load, every time.
    const { supervisor, hosts, clock } = wiredSupervisor({
      answer: (host, message) => {
        if (message.k === 'ping') host.send({ k: 'pong', id: message.id });
      },
    });
    const slow = llamaOf(supervisor).load({ modelPath: '/models/big.gguf' });
    void slow.catch(() => undefined);
    for (let minute = 0; minute < 5; minute += 1) {
      await clock.advance(60_000);
    }
    expect(supervisor.spawnCount).toBe(1);
    expect(hosts[0]?.killed).toBe(false);
    // The CALL still has a deadline — nothing hangs — but the process lives.
    await expect(slow).rejects.toMatchObject({ code: HOST_TIMEOUT });
  });

  it('the real host runtime answers a ping without touching the plugin', async () => {
    // The probe must not be routed through `LlamaCppNode`: it would then be
    // blocked by precisely the state it exists to detect. This drives the real
    // `HostRuntime` against a plugin whose every method hangs. The ping is
    // answered by the RUNTIME, once, ahead of the plugin registry — which is
    // also why it must not be per-plugin: two served engines would otherwise
    // send two pongs for one ping.
    const pair = createLinkPair();
    const hanging = {
      addListener: async () => ({ remove: async () => undefined }),
      generate: () => new Promise(() => undefined),
      getCapabilities: () => new Promise(() => undefined),
    } as unknown as LlamaCppPlugin;
    createHostRuntime({ link: pair.host }).serve(LLAMA_PLUGIN, hanging, LLAMA_HOST_POLICY);

    const seen: unknown[] = [];
    pair.main.onMessage((message) => seen.push(message));
    pair.main.postMessage({
      k: 'call',
      id: 1,
      plugin: LLAMA_PLUGIN.name,
      method: 'getCapabilities',
      args: [],
    });
    pair.main.postMessage({ k: 'ping', id: 77 });
    await settle();

    expect(seen).toContainEqual({ k: 'pong', id: 77 });
    expect(seen.filter((m) => (m as { k: string }).k === 'ret')).toHaveLength(0);
  });
});

/* ══ The third boundary: contextBridge ══════════════════════════════════ */

describe('an error code survives the contextBridge hop', () => {
  it('the double is not a no-op: it drops custom own properties from an Error', () => {
    // THE MODEL THIS SECTION RESTS ON, asserted rather than assumed. If this
    // is wrong in the permissive direction every test below passes for free,
    // so it is checked in both: `code` is gone, `message` is not.
    const thrower = crossContextBridge({
      go: (): never => {
        const error = new Error('the inference process stopped unexpectedly (SIGKILL).');
        Object.assign(error, { code: HANDLE_LOST });
        throw error;
      },
    });
    let caught: unknown;
    try {
      thrower.go();
    } catch (error) {
      caught = error;
    }
    expect((caught as Error).message).toMatch(/SIGKILL/);
    expect((caught as { code?: string }).code).toBeUndefined();

    // The same failure as DATA crosses whole. That difference is the fix.
    const asData = crossContextBridge({
      go: (): unknown => ({ ok: false, error: { message: 'gone', code: HANDLE_LOST } }),
    });
    expect(asData.go()).toEqual({ ok: false, error: { message: 'gone', code: HANDLE_LOST } });
  });

  it('the SHIPPED arrangement loses HANDLE_LOST, which is why the unwrap moved', async () => {
    // DEFECT [3], reproduced. This is what `createRendererBridge` used to do:
    // unwrap in the preload, so an `Error` — not data — crossed. The code is
    // stripped, `src/ai/backends/llama-cpp.ts` never sees HANDLE_LOST, and the
    // one change A5 made to `src/` is unreachable in the running app.
    const preloadThatUnwraps = crossContextBridge({
      invoke: async (): Promise<unknown> => {
        const wire = { message: 'The inference process stopped unexpectedly.', code: HANDLE_LOST };
        throw fromWireError(wire);
      },
    });
    const shipped = await preloadThatUnwraps.invoke().catch((error: unknown) => error);
    expect((shipped as Error).message).toMatch(/stopped unexpectedly/);
    expect((shipped as { code?: string }).code).toBeUndefined();
  });

  it('the page sees HANDLE_LOST when the host dies mid-generation', async () => {
    // The fix, end to end: supervisor -> main -> IPC -> preload -> **the
    // contextBridge hop** -> the real `installCapacitorShim` -> the page. Every
    // `h.bridge` call in this file takes that route, so the whole suite now
    // exercises it; this one names the property.
    const h = harness(
      scripted(
        () =>
          new Promise<GenerateResult>(() => {
            /* never settles: the host dies first */
          }),
      ),
    );
    const generation = h.bridge.invoke(LLAMA_PLUGIN.name, 'generate', [
      { handle: 'h', prompt: 'p', requestId: 'lost' },
    ]);
    await settle();
    h.killHost('SIGKILL');
    await expect(generation).rejects.toMatchObject({ code: HANDLE_LOST });
  });

  it('a deadline reaches the page as HOST_TIMEOUT, not as an anonymous Error', async () => {
    const h = harness(
      scripted(
        () =>
          new Promise<GenerateResult>(() => {
            /* wedged */
          }),
      ),
    );
    const generation = h.bridge.invoke(LLAMA_PLUGIN.name, 'generate', [
      { handle: 'h', prompt: 'p', requestId: 'wedged-code' },
    ]);
    void generation.catch(() => undefined);
    await settle();
    await h.clock.advance(DEFAULT_POLICY.generateIdleTimeoutMs + 1);
    await expect(generation).rejects.toMatchObject({ code: HOST_TIMEOUT });
  });

  it('a NOT_CLONEABLE refusal keeps its code across the hop too', async () => {
    // The preload no longer throws at all — it answers `{ok:false}` — so this
    // is the check that its LOCAL refusals still arrive as throws with their
    // code, and not as a resolved result object the page would treat as data.
    const h = harness(scripted(async (o) => endEvent(o.requestId, 'stop')));
    const refused = await h.bridge
      .invoke(LLAMA_PLUGIN.name, 'generate', [{ onToken: (): void => undefined }])
      .catch((error: unknown) => error);
    expect((refused as Error).message).toMatch(/functions are not cloneable/);
    expect((refused as { code?: string }).code).toBe('NOT_CLONEABLE');
  });

  it("the shim's inlined unwrap agrees with fromWireError, so the copy cannot drift", () => {
    // `installCapacitorShim` cannot CALL `fromWireError`: its source is
    // stringified and evaluated in the main world, where nothing from this
    // module is in scope. The duplication is required; this is what keeps it
    // honest. FAULT INJECTED: dropping the `Object.assign(error, {code})` line
    // from the shim's unwrap failed on the code comparison.
    const cases = [
      { message: 'plain' },
      { message: 'coded', code: HANDLE_LOST },
      { message: 'timed out', code: HOST_TIMEOUT },
    ];
    for (const wire of cases) {
      const target: ShimTarget = {};
      installCapacitorShim(target, {
        getBootstrap: () => ({ platform: 'electron', plugins: [LLAMA_PLUGIN] }),
        invoke: async () => ({ ok: false, error: wire }),
      } as unknown as PreloadBridge);
      const capacitor = target.Capacitor as {
        nativePromise(p: string, m: string, o?: unknown): Promise<unknown>;
      };
      const expected = fromWireError(wire);
      void expect(capacitor.nativePromise('LlamaCpp', 'load', {})).rejects.toMatchObject({
        message: expected.message,
        ...(wire.code === undefined ? {} : { code: wire.code }),
      });
    }
  });

  it('the code survives the shim source that is actually EVALUATED, not just imported', async () => {
    // The preload runs `capacitorShimSource(...)` through
    // `webFrame.executeJavaScript`; the imported function is not what ships.
    // This drives the STRING, with `window` as its only free variable, and
    // pushes a coded failure all the way through it.
    const manifest = { platform: 'electron', plugins: [LLAMA_PLUGIN] };
    const fakeWindow: Record<string, unknown> = {
      __chatterangDesktop: {
        getBootstrap: () => manifest,
        invoke: async () => ({
          ok: false,
          error: { message: 'The inference process stopped unexpectedly.', code: HANDLE_LOST },
        }),
      },
    };
    new Function('window', capacitorShimSource('__chatterangDesktop'))(fakeWindow);
    const capacitor = fakeWindow['Capacitor'] as {
      nativePromise(p: string, m: string, o?: unknown): Promise<unknown>;
    };
    const caught = await capacitor
      .nativePromise('LlamaCpp', 'generate', { requestId: 'x' })
      .catch((error: unknown) => error);
    expect((caught as Error) instanceof Error).toBe(true);
    expect((caught as { code?: string }).code).toBe(HANDLE_LOST);
  });

  it('refuses an answer that is not a result, rather than handing the page undefined', async () => {
    const target: ShimTarget = {};
    installCapacitorShim(target, {
      getBootstrap: () => ({ platform: 'electron', plugins: [LLAMA_PLUGIN] }),
      invoke: async () => 'not a result',
    } as unknown as PreloadBridge);
    const capacitor = target.Capacitor as {
      nativePromise(p: string, m: string, o?: unknown): Promise<unknown>;
    };
    await expect(capacitor.nativePromise('LlamaCpp', 'load', {})).rejects.toThrow(
      /not a result/,
    );
  });
});

/* ── Two windows, and the things that used to leak between them ───────── */

/**
 * A supervisor wired to a `PluginHost` with TWO renderers subscribed.
 *
 * The harness above ships one window because A5 ships one window, which is
 * exactly why the sender-scoping defect went unnoticed: with a single renderer,
 * "deliver to the owner" and "deliver to everyone" are the same behaviour and
 * no test can tell them apart. These tests open a second one, where they are
 * different behaviours and the shipped code chose the wrong one.
 *
 * The inference host is the `wiredSupervisor` fake, because these tests need to
 * emit a token for a named requestId at a chosen moment — which is the whole
 * question — rather than to run an engine.
 */
function twoWindows(options: { notify?: NotifyListeners } = {}): {
  readonly host: PluginHost;
  readonly supervisor: Supervisor;
  readonly hosts: WiredHost[];
  readonly clock: ManualClock;
  readonly warnings: string[];
  /** What each renderer actually received, in order. */
  readonly inbox: Map<number, EventPayload[]>;
  /** Invoke as a renderer, through the real router. */
  call(senderId: number, method: string, args: readonly unknown[]): Promise<InvokeResult>;
} {
  const inbox = new Map<number, EventPayload[]>([
    [1, []],
    [2, []],
  ]);
  const host = new PluginHost((senderId, payload) => {
    const box = inbox.get(senderId);
    if (box === undefined) return false;
    box.push(structuredClone(payload));
    return true;
  });

  const wired = wiredSupervisor({
    // A `generate` is deliberately left unanswered: the test decides when the
    // turn ends, which is the only way to have two of them in flight at once.
    notify:
      options.notify ??
      ((pluginName, eventName, data, ownerId) =>
        host.notifyListeners(pluginName, eventName, data, ownerId)),
  });

  host.register(LLAMA_PLUGIN, wired.supervisor.plugin(LLAMA_PLUGIN.name));
  const router = createMainRouter(host);

  for (const senderId of inbox.keys()) {
    for (const eventName of LLAMA_EVENTS) {
      host.addListener(senderId, LLAMA_PLUGIN.name, eventName, 1 + LLAMA_EVENTS.indexOf(eventName));
    }
  }

  return {
    host,
    supervisor: wired.supervisor,
    hosts: wired.hosts,
    clock: wired.clock,
    warnings: wired.warnings,
    inbox,
    call: (senderId, method, args) =>
      router.handle(senderId, methodChannel(LLAMA_PLUGIN.name, method), args),
  };
}

/** Every event of one name a renderer received, newest last. */
function seen(inbox: Map<number, EventPayload[]>, senderId: number, eventName: string): unknown[] {
  return (inbox.get(senderId) ?? [])
    .filter((payload) => payload.eventName === eventName)
    .map((payload) => payload.data);
}

/** Start a generation from one window and leave it in flight. */
function begin(
  w: ReturnType<typeof twoWindows>,
  senderId: number,
  requestId: string,
): Promise<InvokeResult> {
  return w.call(senderId, 'generate', [{ handle: 'h', prompt: 'p', requestId }]);
}

describe('a generation belongs to the window that started it', () => {
  it('[11] delivers a token only to the window whose turn it is', async () => {
    // DEFECT [11]. `plugin-host.ts` did `void senderId` and `notifyListeners`
    // had no owner parameter, so EVERY llamaToken went to EVERY subscribed
    // window. Two windows chatting meant each one's answer appeared, token by
    // token, inside the other one's turn. This is the leak half of the defect;
    // the cancellation half is the test below.
    const w = twoWindows();
    void begin(w, 1, 'r1');
    void begin(w, 2, 'r2');
    await settle();

    w.hosts[0]?.send({ k: 'ev', plugin: LLAMA_PLUGIN.name, name: 'llamaToken', data: { requestId: 'r1', token: 'one' } });
    w.hosts[0]?.send({ k: 'ev', plugin: LLAMA_PLUGIN.name, name: 'llamaToken', data: { requestId: 'r2', token: 'two' } });

    expect(seen(w.inbox, 1, 'llamaToken')).toEqual([{ requestId: 'r1', token: 'one' }]);
    expect(seen(w.inbox, 2, 'llamaToken')).toEqual([{ requestId: 'r2', token: 'two' }]);
  });

  it('[11] delivers the terminal event only to the window whose turn it is', async () => {
    const w = twoWindows();
    void begin(w, 1, 'r1');
    void begin(w, 2, 'r2');
    await settle();

    w.hosts[0]?.send({ k: 'ev', plugin: LLAMA_PLUGIN.name, name: 'llamaEnd', data: endEvent('r1', 'stop') });
    await settle();

    expect(seen(w.inbox, 1, 'llamaEnd')).toHaveLength(1);
    expect(seen(w.inbox, 2, 'llamaEnd')).toEqual([]);
  });

  it('[11] broadcasts an event that belongs to the machine, not to a turn', async () => {
    // The mirror test, and the reason ownership is a parameter rather than a
    // blanket rule: `llamaThermal` describes the hardware. Scoping it to an
    // owner it does not have would deliver it to nobody, which is a quieter
    // failure than delivering it to everybody and just as wrong.
    const w = twoWindows();
    void begin(w, 1, 'r1');
    await settle();

    w.hosts[0]?.send({ k: 'ev', plugin: LLAMA_PLUGIN.name, name: 'llamaThermal', data: { state: 'nominal' } });

    expect(seen(w.inbox, 1, 'llamaThermal')).toEqual([{ state: 'nominal' }]);
    expect(seen(w.inbox, 2, 'llamaThermal')).toEqual([{ state: 'nominal' }]);
  });

  it('[11] drops a token for a generation nobody is running', async () => {
    // With no owner to address it to, the choice is broadcast or drop, and
    // broadcast is how the leak worked in the first place.
    const w = twoWindows();
    void begin(w, 1, 'r1');
    await settle();

    w.hosts[0]?.send({ k: 'ev', plugin: LLAMA_PLUGIN.name, name: 'llamaToken', data: { requestId: 'ghost', token: 'x' } });

    expect(seen(w.inbox, 1, 'llamaToken')).toEqual([]);
    expect(seen(w.inbox, 2, 'llamaToken')).toEqual([]);
    expect(w.warnings.join('\n')).toMatch(/token for a generation that is not in flight/);
  });

  it('[11] a window going away ends its own generation and NOT the other one', async () => {
    // The cancellation half. `releaseRenderer` walked the whole map, so one
    // window's reload rejected the other window's generate promise with a
    // reason that was, for it, simply false.
    const w = twoWindows();
    const first = begin(w, 1, 'r1');
    const second = begin(w, 2, 'r2');
    await settle();
    expect(w.supervisor.inflightCount).toBe(2);

    w.supervisor.releaseRenderer(1, 'The window that started this generation was closed.');
    await settle();

    expect(await first).toMatchObject({ ok: false, error: { code: 'RENDERER_GONE' } });
    expect(w.supervisor.inflightCount).toBe(1);

    // The survivor is still a live turn: it answers, and it answers to itself.
    w.hosts[0]?.send({ k: 'ev', plugin: LLAMA_PLUGIN.name, name: 'llamaEnd', data: endEvent('r2', 'stop') });
    const call = w.hosts[0]?.posted.find(
      (m) => (m as { method?: string }).method === 'generate',
    ) as { id: number } | undefined;
    w.hosts[0]?.send({ k: 'ret', id: (call?.id ?? 0) + 1, ok: true, data: endEvent('r2', 'stop') });
    await settle();
    expect(await second).toMatchObject({ ok: true });
    expect(seen(w.inbox, 2, 'llamaEnd')).toHaveLength(1);
    expect(seen(w.inbox, 1, 'llamaEnd')).toEqual([]);
  });

  it('[11] one window cannot cancel another window s generation', async () => {
    const w = twoWindows();
    void begin(w, 1, 'r1');
    await settle();
    const before = w.hosts[0]?.posted.length ?? 0;

    // Window 2 asks to cancel window 1's turn. A no-op, and deliberately
    // indistinguishable from cancelling something that was never running — a
    // different answer would let one window probe what another is doing.
    expect(await w.call(2, 'cancel', [{ requestId: 'r1' }])).toMatchObject({ ok: true });
    expect(w.hosts[0]?.posted.length).toBe(before);

    // Its owner can. Not awaited: the owner's cancel is a real call to the
    // host and this fake host answers nothing, so the promise stays pending —
    // which is itself the proof that window 2's cancel took the early return
    // rather than the same path.
    void w.call(1, 'cancel', [{ requestId: 'r1' }]);
    await settle();
    expect(w.hosts[0]?.posted.at(-1)).toMatchObject({ method: 'cancel' });
    expect(w.hosts[0]?.posted.length).toBe(before + 1);
  });
});

describe('two turns cannot share one requestId', () => {
  it('[12] refuses a generation whose requestId is already running', async () => {
    // DEFECT [12]. `#inflight.set` was unconditional, so the second generate
    // REPLACED the first one's record — and that record carries `ended`. One
    // llamaEnd then served two turns: the first never got one and was left to
    // its deadline, and the second arrived against a record already settled.
    const w = twoWindows();
    const first = begin(w, 1, 'r1');
    await settle();

    const second = await begin(w, 1, 'r1');
    expect(second).toMatchObject({ ok: false });
    expect((second as { error: { message: string } }).error.message).toMatch(
      /requestId "r1" is already running/,
    );

    // The refusal did not disturb the turn that was already running: it still
    // ends exactly once, and its own promise still settles. Under the shipped
    // code the second generate replaced the first one's record, so the first
    // turn's promise was left to the deadline — which is what this assertion
    // catches, and it catches it as a HANG rather than a wrong value.
    expect(w.supervisor.inflightCount).toBe(1);
    w.hosts[0]?.send({ k: 'ev', plugin: LLAMA_PLUGIN.name, name: 'llamaEnd', data: endEvent('r1', 'stop') });
    const call = w.hosts[0]?.posted.find(
      (m) => (m as { method?: string }).method === 'generate',
    ) as { id: number } | undefined;
    w.hosts[0]?.send({ k: 'ret', id: call?.id ?? 0, ok: true, data: endEvent('r1', 'stop') });

    expect(await first).toMatchObject({ ok: true });
    expect(seen(w.inbox, 1, 'llamaEnd')).toHaveLength(1);
    expect(w.supervisor.inflightCount).toBe(0);
  });

  it('[12] refuses it across windows too, because the host keys by it as well', async () => {
    const w = twoWindows();
    void begin(w, 1, 'r1');
    await settle();
    const clash = await begin(w, 2, 'r1');
    expect(clash).toMatchObject({ ok: false });
    expect(w.supervisor.inflightCount).toBe(1);
  });

  it('[12] frees the id again once the turn is over', async () => {
    // The refusal is about a LIVE id, not a used one. A renderer that restarts
    // its counter after a reload must not be locked out.
    const w = twoWindows();
    void begin(w, 1, 'r1');
    await settle();
    w.supervisor.releaseRenderer(1, 'closed');
    await settle();
    expect(w.supervisor.inflightCount).toBe(0);

    void begin(w, 1, 'r1');
    await settle();
    expect(w.supervisor.inflightCount).toBe(1);
  });
});

describe('a terminal event that could not be delivered is not spent', () => {
  it('[13] retries the turn s llamaEnd when the first delivery throws', async () => {
    // DEFECT [13]. `#settle` set `entry.ended = true` and THEN notified, so a
    // delivery that threw consumed the turn's one terminal event without
    // delivering it. The page saw no llamaEnd at all — while the `ret` that
    // arrived afterwards found `ended` already set, returned silently, and
    // resolved the generate promise as a clean success.
    //
    // The payload here is one `PluginHost` refuses BEFORE delivering anything,
    // which is the realistic shape: `assertCloneable` runs first, so a bad
    // payload throws with nothing sent.
    const w = twoWindows();
    void begin(w, 1, 'r1');
    await settle();

    // A function in the payload: structured clone cannot carry it.
    w.hosts[0]?.send({
      k: 'ev',
      plugin: LLAMA_PLUGIN.name,
      name: 'llamaEnd',
      data: { ...endEvent('r1', 'stop'), onDone: (): void => undefined },
    });
    await settle();

    expect(seen(w.inbox, 1, 'llamaEnd')).toEqual([]);
    expect(w.warnings.join('\n')).toMatch(/could not deliver LlamaCpp\.llamaEnd/);

    // The turn is still open, so the host's own return settles it — with a
    // payload we can actually deliver.
    const call = w.hosts[0]?.posted.find(
      (m) => (m as { method?: string }).method === 'generate',
    ) as { id: number } | undefined;
    w.hosts[0]?.send({ k: 'ret', id: call?.id ?? 0, ok: true, data: endEvent('r1', 'stop') });
    await settle();

    expect(seen(w.inbox, 1, 'llamaEnd')).toHaveLength(1);
    expect(w.supervisor.inflightCount).toBe(0);
  });

  it('[13] still emits exactly one when the first delivery succeeds', async () => {
    // The other half: retrying a FAILED delivery must not turn a successful one
    // into two. `ended` is set from the delivery's result, so a delivered event
    // closes the turn exactly as before.
    const w = twoWindows();
    void begin(w, 1, 'r1');
    await settle();

    w.hosts[0]?.send({ k: 'ev', plugin: LLAMA_PLUGIN.name, name: 'llamaEnd', data: endEvent('r1', 'stop') });
    const call = w.hosts[0]?.posted.find(
      (m) => (m as { method?: string }).method === 'generate',
    ) as { id: number } | undefined;
    w.hosts[0]?.send({ k: 'ret', id: call?.id ?? 0, ok: true, data: endEvent('r1', 'stop') });
    await settle();

    expect(seen(w.inbox, 1, 'llamaEnd')).toHaveLength(1);
  });

  it('[13] a delivery failure does not escape into the message loop', async () => {
    // `#receive` runs inside the link's message listener, which in production
    // is Electron's `message` handler on a utility process. An exception
    // thrown out of it is an unhandled error in the main process.
    const w = twoWindows({
      notify: () => {
        throw new Error('delivery exploded');
      },
    });
    void begin(w, 1, 'r1');
    await settle();

    expect(() =>
      w.hosts[0]?.send({ k: 'ev', plugin: LLAMA_PLUGIN.name, name: 'llamaEnd', data: endEvent('r1', 'stop') }),
    ).not.toThrow();
    expect(() =>
      w.hosts[0]?.send({ k: 'ev', plugin: LLAMA_PLUGIN.name, name: 'llamaThermal', data: { state: 'hot' } }),
    ).not.toThrow();
  });
});

/* ── Sender scoping, as a mechanism ───────────────────────────────────── */

describe('PluginHost sender scoping', () => {
  const DEFINITION = { name: 'Scoped', methods: ['plain', 'owned'], events: [] };

  it('[11] passes the sender id only to the methods that asked for it', async () => {
    const calls: { method: string; args: unknown[] }[] = [];
    const host = new PluginHost(() => true);
    host.register(DEFINITION, {
      plain: (...args) => void calls.push({ method: 'plain', args: [...args] }),
      owned: (...args) => void calls.push({ method: 'owned', args: [...args] }),
      [SENDER_SCOPED]: ['owned'],
    });

    await host.invoke(7, 'Scoped', 'plain', ['a', 'b']);
    await host.invoke(7, 'Scoped', 'owned', ['a', 'b']);

    expect(calls[0]).toEqual({ method: 'plain', args: ['a', 'b'] });
    // In FRONT of the renderer's arguments, never appended: appending would
    // make the position depend on how many arguments the renderer chose to
    // send, and the renderer chooses that.
    expect(calls[1]).toEqual({ method: 'owned', args: [7, 'a', 'b'] });
  });

  it('[11] refuses to register a scoped name the plugin does not declare', () => {
    // A typo here means an author believes a method is scoped and it is not,
    // which is defect [11] reintroduced silently. Refused at boot instead.
    const host = new PluginHost(() => true);
    expect(() =>
      host.register(DEFINITION, {
        plain: () => undefined,
        owned: () => undefined,
        [SENDER_SCOPED]: ['owned', 'ownd'],
      }),
    ).toThrow(/marks method\(s\) sender-scoped that it does not declare: ownd/);
  });

  it('[11] the supervisor scopes exactly generate and cancel', () => {
    // Named as an assertion rather than left implicit: every other LlamaCpp
    // method answers a question about the machine or the loaded model, with the
    // same answer for every window. If a method that owns per-window state is
    // added later, this list is where it has to appear.
    const { supervisor } = wiredSupervisor({});
    const scoped = supervisor.plugin(LLAMA_PLUGIN.name)[SENDER_SCOPED] ?? [];
    expect([...scoped].sort()).toEqual(['cancel', 'generate']);
    for (const method of scoped) {
      expect(LLAMA_METHODS).toContain(method);
    }
  });

  it('[11] scopes delivery in notifyListeners, without pruning the others', () => {
    // The owner filter must SKIP a foreign subscription, not attempt delivery
    // and prune it: `notifyListeners` deletes any subscription whose delivery
    // is refused, so probing one window while addressing another would quietly
    // unsubscribe it.
    const reached: number[] = [];
    const host = new PluginHost((senderId) => {
      reached.push(senderId);
      return true;
    });
    host.register(LLAMA_PLUGIN, {
      ...Object.fromEntries(LLAMA_METHODS.map((m) => [m, () => undefined])),
    });
    host.addListener(1, LLAMA_PLUGIN.name, 'llamaToken', 1);
    host.addListener(2, LLAMA_PLUGIN.name, 'llamaToken', 1);

    expect(host.notifyListeners(LLAMA_PLUGIN.name, 'llamaToken', { t: 1 }, 2)).toBe(1);
    expect(reached).toEqual([2]);
    expect(host.subscriptionCount()).toBe(2);

    expect(host.notifyListeners(LLAMA_PLUGIN.name, 'llamaToken', { t: 2 })).toBe(2);
    expect(reached).toEqual([2, 1, 2]);
  });
});

/* ── A renderer can go away three ways, and one of them was unhandled ─── */

describe('renderer teardown', () => {
  function targets(): {
    log: string[];
    released: number[];
    forgotten: number[];
    api: RendererTeardownTargets;
  } {
    const log: string[] = [];
    const released: number[] = [];
    const forgotten: number[] = [];
    return {
      log,
      released,
      forgotten,
      api: {
        releaseSender: (id) => log.push(`releaseSender:${String(id)}`),
        releaseRenderer: (id, reason) => {
          released.push(id);
          log.push(`releaseRenderer:${String(id)}:${reason}`);
        },
        forget: (id) => {
          forgotten.push(id);
          log.push(`forget:${String(id)}`);
        },
      },
    };
  }

  it('[6] a crash runs the same cleanup as a close', () => {
    // DEFECT [6]. `main.ts` registered cleanup on `did-start-navigation` and
    // `destroyed` only. A renderer CRASH fires neither — an instrumented build
    // logged `render-process-gone reason=crashed destroyed=false` — so neither
    // `releaseSender` nor `releaseRenderer` ran: the subscriptions stayed in
    // the table and the generation kept decoding for a page that no longer
    // existed.
    const t = targets();
    releaseRendererOn('render-process-gone', 5, t.api);
    expect(t.log).toEqual([
      'releaseSender:5',
      `releaseRenderer:5:${teardownReason('render-process-gone')}`,
    ]);
  });

  it('[6] every listed departure releases both the subscriptions and the turns', () => {
    // Asserted over the LIST rather than per event, so an event added to
    // `RENDERER_TEARDOWN_EVENTS` without a case is caught here.
    for (const event of RENDERER_TEARDOWN_EVENTS) {
      const t = targets();
      releaseRendererOn(event, 9, t.api);
      expect(t.log.slice(0, 2)).toEqual([
        'releaseSender:9',
        `releaseRenderer:9:${teardownReason(event)}`,
      ]);
      expect(t.released).toEqual([9]);
      expect(teardownReason(event).length).toBeGreaterThan(10);
    }
  });

  it('[6] only a destroyed renderer is forgotten', () => {
    // A crashed webContents is NOT destroyed and can be reloaded into.
    // Forgetting it would leave the reloaded page unable to receive events.
    for (const event of RENDERER_TEARDOWN_EVENTS) {
      const t = targets();
      releaseRendererOn(event, 3, t.api);
      expect(t.forgotten).toEqual(event === 'destroyed' ? [3] : []);
    }
  });

  it('[6] names the three departures, and says which is which', () => {
    expect([...RENDERER_TEARDOWN_EVENTS]).toEqual([
      'did-start-navigation',
      'render-process-gone',
      'destroyed',
    ]);
    // Each reason describes what happened to THAT window. The page shows this
    // string as the failure of its own turn, so a crash saying "navigated
    // away" would be a lie the user could act on.
    expect(teardownReason('render-process-gone')).toMatch(/stopped responding/);
    expect(teardownReason('did-start-navigation')).toMatch(/navigated away/);
    expect(teardownReason('destroyed')).toMatch(/closed/);
    expect(new Set(RENDERER_TEARDOWN_EVENTS.map(teardownReason)).size).toBe(3);
  });
});

/* ── The inference-host boundary checks what it is handed ─────────────── */

/**
 * The host runtime serving llama.cpp on one side of a real port, driven by hand
 * from the other.
 *
 * Direct rather than through the whole bridge, because the questions here are
 * about the host's own boundary: what it refuses, and what it is willing to say
 * about a failure. The supervisor sitting in between would add nothing but
 * distance from the assertion.
 */
function hostBoundary(options: {
  plugin?: Partial<LlamaCppPlugin>;
  guard?: CallGuard;
}): {
  call(method: string, args: readonly unknown[]): Promise<{ ok: boolean; message: string }>;
  readonly warnings: string[];
  readonly reached: { method: string; args: readonly unknown[] }[];
} {
  const pair = createLinkPair();
  const warnings: string[] = [];
  const reached: { method: string; args: readonly unknown[] }[] = [];

  const base = Object.fromEntries(
    LLAMA_METHODS.map((method) => [
      method,
      (...args: readonly unknown[]) => {
        reached.push({ method, args });
        return Promise.resolve({ ok: true });
      },
    ]),
  );
  const plugin = {
    ...base,
    ...options.plugin,
    addListener: async () => ({ remove: async (): Promise<void> => undefined }),
  } as unknown as LlamaCppPlugin;

  createHostRuntime({ link: pair.host, warn: (message: string) => warnings.push(message) }).serve(
    LLAMA_PLUGIN,
    plugin,
    { ...LLAMA_HOST_POLICY, ...(options.guard === undefined ? {} : { guard: options.guard }) },
  );

  let nextId = 1;
  return {
    warnings,
    reached,
    call: (method, args) =>
      new Promise((resolveCall) => {
        const id = nextId++;
        pair.main.onMessage((message) => {
          const answer = message as { k: string; id: number; ok: boolean; error?: { message: string } };
          if (answer.k !== 'ret' || answer.id !== id) return;
          resolveCall({ ok: answer.ok, message: answer.error?.message ?? '' });
        });
        pair.main.postMessage({ k: 'call', id, plugin: LLAMA_PLUGIN.name, method, args });
      }),
  };
}

describe('argument shape at the inference-host boundary', () => {
  it('[16] names the method and the field, instead of a stack-trace artefact', async () => {
    // DEFECT [16]. Passing `modelId` where the contract says `modelPath` used
    // to produce `Cannot read properties of undefined (reading 'toLowerCase')`
    // — raised inside node-llama-cpp, flattened onto the host link, flattened
    // again onto the plugin bridge, and delivered to the page naming neither
    // the method nor the field.
    const h = hostBoundary({});
    const answer = await h.call('load', [{ modelId: 'gemma-4-12b' }]);

    expect(answer.ok).toBe(false);
    expect(answer.message).toContain('"load"');
    expect(answer.message).toContain('modelPath');
    // And the engine was never reached, so no native code ran on a bad call.
    expect(h.reached).toEqual([]);
  });

  it('[16] checks every method that has a required field', async () => {
    const cases: [string, unknown[], string][] = [
      ['unload', [{}], 'handle'],
      ['generate', [{ handle: 'h', prompt: 'p' }], 'requestId'],
      ['generate', [{ prompt: 'p', requestId: 'r' }], 'handle'],
      ['cancel', [{}], 'requestId'],
      ['tokenize', [{ text: 'x' }], 'handle'],
      ['countTokens', [{ handle: 'h' }], 'text'],
      ['benchmark', [{}], 'handle'],
    ];
    for (const [method, args, field] of cases) {
      const answer = await hostBoundary({}).call(method, args);
      expect(answer.ok, `${method} should have been refused`).toBe(false);
      expect(answer.message).toContain(field);
      expect(answer.message).toContain(`"${method}"`);
    }
  });

  it('[16] refuses an empty identifier but allows an empty prompt', async () => {
    // An empty `handle` or `requestId` names nothing; letting one through only
    // moves the failure further in. An empty prompt is unusual and meaningful.
    expect((await hostBoundary({}).call('unload', [{ handle: '' }])).ok).toBe(false);
    expect((await hostBoundary({}).call('cancel', [{ requestId: '' }])).ok).toBe(false);
    expect(
      (await hostBoundary({}).call('generate', [{ handle: 'h', prompt: '', requestId: 'r' }])).ok,
    ).toBe(true);
  });

  it('[16] refuses a missing options object without reading through it', async () => {
    for (const args of [[], [undefined], [null], ['a string'], [['an', 'array']]]) {
      const answer = await hostBoundary({}).call('load', args);
      expect(answer.ok).toBe(false);
      expect(answer.message).toMatch(/needs an options object/);
    }
  });

  it('[16] leaves the methods that need nothing alone', async () => {
    for (const method of ['getCapabilities', 'getThermalState', 'listLoaded']) {
      expect((await hostBoundary({}).call(method, [])).ok).toBe(true);
    }
  });

  it('[16] never echoes the value back, because one of the fields is the prompt', async () => {
    // This message crosses two boundaries and lands wherever the renderer logs
    // errors. Naming the TYPE of a bad value is a diagnostic; quoting it puts a
    // conversation in a log by way of an error message.
    const answer = await hostBoundary({}).call('generate', [
      { handle: 'h', prompt: { secret: 'the user typed this' }, requestId: 'r' },
    ]);
    expect(answer.ok).toBe(false);
    expect(answer.message).not.toContain('the user typed this');
    expect(answer.message).toContain('a object');
  });

  it('[16] covers every method the host serves, with no gaps', () => {
    // The table lists methods that need nothing as empty arrays rather than
    // omitting them, so it is a statement about all ten.
    expect(Object.keys(REQUIRED_ARGUMENTS).sort()).toEqual([...LLAMA_METHODS].sort());
  });

  it('[16] is callable as a pure function, which is how it is checked', () => {
    expect(() => assertCallShape('load', [{ modelPath: '/models/x.gguf' }])).not.toThrow();
    expect(() => assertCallShape('load', [{}])).toThrow(/modelPath/);
    // An unknown method is not this check's business — the allowlist runs
    // first, and two guards disagreeing about which methods exist is how a
    // legitimate call starts being refused for the wrong reason.
    expect(() => assertCallShape('somethingElse', [])).not.toThrow();
  });
});

describe('load is not a filesystem oracle', () => {
  /** The guard `host/entry.ts` installs, with a root a test can name. */
  const ROOT = '/app-data/models';

  it('[8] refuses a path outside the model directory, before the engine runs', async () => {
    const h = hostBoundary({ guard: modelPathGuard(ROOT) });
    const answer = await h.call('load', [{ modelPath: '/etc/hosts' }]);

    expect(answer.ok).toBe(false);
    expect(answer.message).toMatch(/must name a file inside the application's model folder/);
    expect(h.reached).toEqual([]);
    // The refusal does not echo the path back. Reflecting a caller-supplied
    // path is one more piece of the filesystem confirmed to a web page.
    expect(answer.message).not.toContain('/etc/hosts');
  });

  it('[8] guards mmprojPath and draftModelPath too, not just modelPath', async () => {
    // The same loader, under two other names. Fixing one of three would leave
    // the oracle open with an extra keystroke.
    for (const field of ['mmprojPath', 'draftModelPath']) {
      const h = hostBoundary({ guard: modelPathGuard(ROOT) });
      const answer = await h.call('load', [
        { modelPath: `${ROOT}/ok.gguf`, [field]: '/etc/hosts' },
      ]);
      expect(answer.ok, field).toBe(false);
      expect(answer.message).toContain(field);
      expect(h.reached).toEqual([]);
    }
  });

  it('[8] passes a legitimate model through, resolved', async () => {
    const h = hostBoundary({ guard: modelPathGuard(ROOT) });
    expect((await h.call('load', [{ modelPath: 'gemma/model.gguf', gpuLayers: -1 }])).ok).toBe(true);
    expect(h.reached[0]?.args[0]).toEqual({ modelPath: `${ROOT}/gemma/model.gguf`, gpuLayers: -1 });
  });

  it('[8] leaves every other method s arguments untouched', async () => {
    const h = hostBoundary({ guard: modelPathGuard(ROOT) });
    await h.call('generate', [{ handle: 'h', prompt: 'p', requestId: 'r' }]);
    expect(h.reached[0]?.args).toEqual([{ handle: 'h', prompt: 'p', requestId: 'r' }]);
  });

  it('[8] does NOT forward the engine s message, which quotes the file s bytes', async () => {
    // The second half, and neither half is sufficient alone. node-llama-cpp
    // answers a non-GGUF file with `Invalid GGUF magic. Expected "GGUF" but got
    // "##\n#"` — the first four bytes, quoted back. Confining the path stops
    // `/etc/hosts`; it does not stop the same read of anything the user has put
    // in the model folder, and the page named the file either way.
    const h = hostBoundary({
      plugin: {
        load: () => {
          throw new Error('Invalid GGUF magic. Expected "GGUF" but got "##\n#"');
        },
      },
      guard: modelPathGuard(ROOT),
    });
    const answer = await h.call('load', [{ modelPath: `${ROOT}/notes.txt` }]);

    expect(answer.ok).toBe(false);
    expect(answer.message).not.toContain('GGUF magic');
    expect(answer.message).not.toContain('##');
    expect(answer.message).toMatch(/could not be loaded/);
    // The engine's own words are kept, on this side of the boundary, for
    // anyone debugging. That is where the cost of the fixed message is paid.
    expect(h.warnings.join('\n')).toContain('Invalid GGUF magic');
  });

  it('[8] still forwards OUR refusals verbatim — they are the useful ones', async () => {
    // The shape check and the path guard raise messages we wrote, naming a
    // method and a field. Those must not be swallowed by the same blanket that
    // hides the engine's, or the fix for [16] is undone by the fix for [8].
    const h = hostBoundary({ guard: modelPathGuard(ROOT) });
    expect((await h.call('load', [{ modelId: 'x' }])).message).toContain('modelPath');
    expect((await h.call('load', [{ modelPath: '/etc/hosts' }])).message).toMatch(
      /model folder/,
    );
  });

  it('[8] leaves other methods failures readable', async () => {
    // Only `load` names a file whose contents an error can describe. Blanketing
    // every method would cost every diagnostic in the app for nothing.
    const h = hostBoundary({
      plugin: {
        unload: () => {
          throw new Error('no such handle: h9');
        },
      },
    });
    expect((await h.call('unload', [{ handle: 'h9' }])).message).toContain('no such handle: h9');
  });
});

/* ══ TWO ENGINES ON ONE WIRE ═══════════════════════════════════════════ */

/**
 * A SECOND plugin, registered alongside llama.cpp.
 *
 * Not ONNX — that is milestone A3, and adding it here would be adding the
 * feature rather than proving the seam. This is a fake with its own name, its
 * own methods and its own event names, which is the only thing the plugin
 * dimension needs in order to be exercised rather than merely declared.
 *
 * TWO OF ITS METHODS COLLIDE WITH LLAMA.CPP'S ON PURPOSE. `generate` and
 * `cancel` are exactly the names a transcriber and a text model both want, and
 * a wire that carries only a method name cannot tell those two calls apart —
 * the old `{k:'call', id, method, args}` would have delivered either to
 * whichever single plugin the host happened to be serving. Its EVENT names do
 * not collide, because the sharper question there is different: an event has to
 * find the right in-flight table, and the terminal-event name is what the
 * supervisor matches on. A `Transcriber.end` must not settle a `LlamaCpp` turn,
 * and — the case that costs a whole engine's guarantee if it is wrong — must
 * not settle one that shares its requestId.
 */
const TRANSCRIBER: PluginDefinition = Object.freeze({
  name: 'Transcriber',
  methods: Object.freeze(['describe', 'load', 'generate', 'cancel']),
  events: Object.freeze(['chunk', 'end', 'level']),
});

/** Its streaming contract: different method and event names, same guarantees. */
const TRANSCRIBER_ENGINE: EngineSpec = Object.freeze({
  definition: TRANSCRIBER,
  stream: Object.freeze({
    start: 'generate',
    cancel: 'cancel',
    terminal: 'end',
    progress: Object.freeze(['chunk']),
    synthesise: (requestId: string, error: string) => ({ requestId, error, aborted: true }),
  }),
});

/** One call as it appears on the wire, so a test can assert who it was for. */
interface PostedCall {
  readonly k?: string;
  readonly id?: number;
  readonly plugin?: string;
  readonly method?: string;
  readonly args?: readonly unknown[];
}

/**
 * Two engines, one supervisor, one host, two renderers.
 *
 * Everything between the router and the wire is production code; only the host
 * is a double, because these tests have to hold two turns open simultaneously
 * and decide by hand which one ends.
 */
function twoEngines(
  options: { policy?: Partial<SupervisorPolicy>; engines?: readonly EngineSpec[] } = {},
): {
  readonly host: PluginHost;
  readonly supervisor: Supervisor;
  readonly hosts: WiredHost[];
  readonly clock: ManualClock;
  readonly warnings: string[];
  readonly inbox: Map<number, EventPayload[]>;
  call(
    senderId: number,
    pluginName: string,
    method: string,
    args: readonly unknown[],
  ): Promise<InvokeResult>;
  /** Every `{k:'call'}` the supervisor has posted, oldest first. */
  posted(): PostedCall[];
  /** Deliver an event as if the named plugin had emitted it. */
  emit(pluginName: string, name: string, data: unknown): void;
} {
  const inbox = new Map<number, EventPayload[]>([
    [1, []],
    [2, []],
  ]);
  const host = new PluginHost((senderId, payload) => {
    const box = inbox.get(senderId);
    if (box === undefined) return false;
    box.push(structuredClone(payload));
    return true;
  });

  const wired = wiredSupervisor({
    engines: options.engines ?? [LLAMA_ENGINE, TRANSCRIBER_ENGINE],
    notify: (pluginName, eventName, data, ownerId) =>
      host.notifyListeners(pluginName, eventName, data, ownerId),
    ...(options.policy === undefined ? {} : { policy: options.policy }),
  });

  host.register(LLAMA_PLUGIN, wired.supervisor.plugin(LLAMA_PLUGIN.name));
  host.register(TRANSCRIBER, wired.supervisor.plugin(TRANSCRIBER.name));
  const router = createMainRouter(host);

  let subscriptionId = 1;
  for (const senderId of inbox.keys()) {
    for (const definition of [LLAMA_PLUGIN, TRANSCRIBER]) {
      for (const eventName of definition.events) {
        host.addListener(senderId, definition.name, eventName, subscriptionId++);
      }
    }
  }

  return {
    host,
    supervisor: wired.supervisor,
    hosts: wired.hosts,
    clock: wired.clock,
    warnings: wired.warnings,
    inbox,
    call: (senderId, pluginName, method, args) =>
      router.handle(senderId, methodChannel(pluginName, method), args),
    posted: () =>
      (wired.hosts[0]?.posted ?? []).filter((m) => (m as PostedCall).k === 'call') as PostedCall[],
    emit: (pluginName, name, data) =>
      wired.hosts[0]?.send({ k: 'ev', plugin: pluginName, name, data }),
  };
}

/** Every event of one plugin+name a renderer received, newest last. */
function sawFrom(
  inbox: Map<number, EventPayload[]>,
  senderId: number,
  pluginName: string,
  eventName: string,
): unknown[] {
  return (inbox.get(senderId) ?? [])
    .filter((p) => p.pluginName === pluginName && p.eventName === eventName)
    .map((p) => p.data);
}

/** Watch a promise without awaiting it, so "still pending" is assertable. */
function watch<T>(promise: Promise<T>): () => T | undefined {
  let value: T | undefined;
  void promise.then((v) => {
    value = v;
  });
  return () => value;
}

/** Start a turn on one engine and leave it in flight. */
function beginOn(
  w: ReturnType<typeof twoEngines>,
  senderId: number,
  pluginName: string,
  requestId: string,
): () => InvokeResult | undefined {
  return watch(
    w.call(senderId, pluginName, 'generate', [{ handle: 'h', prompt: 'p', requestId }]),
  );
}

describe('two engines in flight at once', () => {
  it('keeps their turns apart even when they share a requestId', async () => {
    // THE REASON THIS PHASE EXISTS. Two engines, two turns, ONE requestId —
    // which is not a contrived collision: ids are minted per caller and nothing
    // coordinates them across engines. With a single `#inflight` map keyed by
    // requestId alone, `engine.inflight.set('r1', …)` for the second turn
    // overwrote the first and the two shared one terminal-event flag.
    const w = twoEngines();
    const llama = beginOn(w, 1, LLAMA_PLUGIN.name, 'r1');
    const transcript = beginOn(w, 1, TRANSCRIBER.name, 'r1');
    await settle();

    expect(w.supervisor.inflightCountFor(LLAMA_PLUGIN.name)).toBe(1);
    expect(w.supervisor.inflightCountFor(TRANSCRIBER.name)).toBe(1);
    expect(w.supervisor.inflightCount).toBe(2);

    // Both calls went out addressed to their own plugin, under the method name
    // they share.
    const starts = w.posted().filter((m) => m.method === 'generate');
    expect(starts.map((m) => m.plugin)).toEqual([LLAMA_PLUGIN.name, TRANSCRIBER.name]);
    expect(llama()).toBeUndefined();
    expect(transcript()).toBeUndefined();
  });

  it("one engine's abort does not settle or cancel the other's turn", async () => {
    // The invariant named in the brief, stated as sharply as it can be: same
    // requestId, same window, abort one. FAULT INJECTED: routing every `{k:
    // 'call'}` through the first registered engine (`#engine()` returning
    // `[...this.#engines.values()][0]`) failed this test with
    // `expected 'LlamaCpp' to be 'Transcriber'` on the cancel that went out —
    // the abort of a transcription arriving at llama.cpp for a requestId it
    // also holds.
    const w = twoEngines();
    const llama = beginOn(w, 1, LLAMA_PLUGIN.name, 'r1');
    const transcript = beginOn(w, 1, TRANSCRIBER.name, 'r1');
    await settle();

    // Not awaited: the host double answers nothing on its own, which is what
    // lets two turns stay open at once.
    void w.call(1, TRANSCRIBER.name, 'cancel', [{ requestId: 'r1' }]);
    await settle();

    // The cancel that went out is the TRANSCRIBER's, on its own plugin address.
    const cancels = w.posted().filter((m) => m.method === 'cancel');
    expect(cancels).toHaveLength(1);
    expect(cancels[0]?.plugin).toBe(TRANSCRIBER.name);

    // The transcription ends, exactly once, on its own event name, and its
    // own call settles.
    const start = w.posted().find((m) => m.plugin === TRANSCRIBER.name && m.method === 'generate');
    w.emit(TRANSCRIBER.name, 'end', { requestId: 'r1', aborted: true });
    w.hosts[0]?.send({ k: 'ret', id: start?.id ?? 0, ok: true, data: { requestId: 'r1' } });
    await settle();
    expect(sawFrom(w.inbox, 1, TRANSCRIBER.name, 'end')).toHaveLength(1);

    // And the generation is untouched: no terminal event, still in flight,
    // still unsettled.
    expect(sawFrom(w.inbox, 1, LLAMA_PLUGIN.name, 'llamaEnd')).toEqual([]);
    expect(w.supervisor.inflightCountFor(LLAMA_PLUGIN.name)).toBe(1);
    expect(llama()).toBeUndefined();
    expect(transcript()).toBeDefined();
  });

  it("one engine's terminal event does not end the other's turn", async () => {
    // The same isolation from the event side. A `Transcriber.end` and a
    // `LlamaCpp.llamaEnd` for requestId "r1" are two different facts, and
    // before the plugin dimension the supervisor could only see the requestId.
    const w = twoEngines();
    const llama = beginOn(w, 1, LLAMA_PLUGIN.name, 'r1');
    const transcript = beginOn(w, 1, TRANSCRIBER.name, 'r1');
    await settle();

    w.emit(LLAMA_PLUGIN.name, 'llamaEnd', endEvent('r1', 'stop'));
    await settle();

    expect(sawFrom(w.inbox, 1, LLAMA_PLUGIN.name, 'llamaEnd')).toHaveLength(1);
    expect(sawFrom(w.inbox, 1, TRANSCRIBER.name, 'end')).toEqual([]);
    expect(w.supervisor.inflightCountFor(TRANSCRIBER.name)).toBe(1);
    expect(transcript()).toBeUndefined();
    // The generation's own promise is still open until its `ret` arrives; the
    // terminal event and the settlement are separate paths on purpose.
    expect(llama()).toBeUndefined();
  });

  it("one engine's progress does not extend the other's deadline", async () => {
    // A token is proof that THIS engine is working. Crediting it to another
    // engine's turn would keep a wedged decode alive forever behind a healthy
    // transcription — the exact failure the idle deadline exists to end.
    const w = twoEngines({ policy: { generateIdleTimeoutMs: 1_000, tickMs: 100 } });
    const llama = beginOn(w, 1, LLAMA_PLUGIN.name, 'r1');
    const transcript = beginOn(w, 1, TRANSCRIBER.name, 'r1');
    await settle();

    await w.clock.advance(900);
    w.emit(TRANSCRIBER.name, 'chunk', { requestId: 'r1', text: 'hel' });
    await w.clock.advance(200);

    // The generation timed out on schedule; the transcription bought itself
    // another second.
    expect(llama()).toMatchObject({ ok: false, error: { code: HOST_TIMEOUT } });
    expect(transcript()).toBeUndefined();
    expect(w.supervisor.inflightCountFor(TRANSCRIBER.name)).toBe(1);

    // The deadline's cancel named the engine whose call expired, with that
    // engine's own cancel method — not a bare `cancel` the wrong plugin would
    // have answered for a requestId they both hold.
    const cancels = w.posted().filter((m) => m.method === 'cancel');
    expect(cancels).toHaveLength(1);
    expect(cancels[0]?.plugin).toBe(LLAMA_PLUGIN.name);
    expect(cancels[0]?.args).toEqual([{ requestId: 'r1' }]);
  });

  it("addresses a deadline's cancel at the engine whose call expired", async () => {
    // The mirror of the test above, and it is the one that catches a hard-coded
    // address. FAULT INJECTED: `plugin: LLAMA_PLUGIN.name, method: 'cancel'` in
    // `#tick`'s cancel post — which every OTHER test in this file survives,
    // because llama.cpp is the engine whose turn expires in all of them. Here
    // it is the transcription that expires, and the injected build failed with
    // `expected 'LlamaCpp' to be 'Transcriber'`: an abandoned transcription
    // left decoding, and a cancel delivered to llama.cpp for a requestId it
    // also holds.
    const w = twoEngines({ policy: { generateIdleTimeoutMs: 1_000, tickMs: 100 } });
    const llama = beginOn(w, 1, LLAMA_PLUGIN.name, 'r1');
    const transcript = beginOn(w, 1, TRANSCRIBER.name, 'r1');
    await settle();

    // Only the generation shows progress, so only the generation's deadline
    // moves. A token credited to both would keep the wedged transcription alive.
    await w.clock.advance(900);
    w.emit(LLAMA_PLUGIN.name, 'llamaToken', { requestId: 'r1', token: 'a' });
    await w.clock.advance(200);

    expect(transcript()).toMatchObject({ ok: false, error: { code: HOST_TIMEOUT } });
    expect(llama()).toBeUndefined();
    expect(w.supervisor.inflightCountFor(LLAMA_PLUGIN.name)).toBe(1);

    const cancels = w.posted().filter((m) => m.method === 'cancel');
    expect(cancels).toHaveLength(1);
    expect(cancels[0]?.plugin).toBe(TRANSCRIBER.name);
  });

  it('lets an engine set its own idle deadline, shorter than the policy default', async () => {
    // `generateIdleTimeoutMs` is a policy about text decode. A transcriber that
    // has produced nothing for two minutes is a different judgement, so the
    // spec may override it — and the override has to be read from the engine
    // the call belongs to, not from the first one.
    const impatient: EngineSpec = {
      definition: TRANSCRIBER,
      stream: { ...TRANSCRIBER_ENGINE.stream!, idleTimeoutMs: 300 },
    };
    const w = twoEngines({
      policy: { generateIdleTimeoutMs: 5_000, tickMs: 100 },
      engines: [LLAMA_ENGINE, impatient],
    });
    const llama = beginOn(w, 1, LLAMA_PLUGIN.name, 'r1');
    const transcript = beginOn(w, 1, TRANSCRIBER.name, 'r1');
    await settle();

    // Progress resets it to the ENGINE's 300ms, not to the policy's 5s. FAULT
    // INJECTED: `pending.deadlineAt = now + this.#policy.generateIdleTimeoutMs`
    // in `#extendDeadline` — the first expiry below still fired, so only this
    // second half caught it (`expected undefined to match object`), which is
    // why the chunk is here rather than the test stopping at the first.
    await w.clock.advance(200);
    w.emit(TRANSCRIBER.name, 'chunk', { requestId: 'r1', text: 'a' });
    await w.clock.advance(200);
    expect(transcript()).toBeUndefined();
    await w.clock.advance(200);
    expect(transcript()).toMatchObject({ ok: false, error: { code: HOST_TIMEOUT } });
    expect(llama()).toBeUndefined();

    // And with no progress at all it expires on its own clock, well before the
    // policy default the generation is still waiting on.
    const fresh = twoEngines({
      policy: { generateIdleTimeoutMs: 5_000, tickMs: 100 },
      engines: [LLAMA_ENGINE, impatient],
    });
    const other = beginOn(fresh, 1, TRANSCRIBER.name, 'r1');
    const stillGoing = beginOn(fresh, 1, LLAMA_PLUGIN.name, 'r1');
    await settle();
    await fresh.clock.advance(400);
    expect(other()).toMatchObject({ ok: false, error: { code: HOST_TIMEOUT } });
    expect(stillGoing()).toBeUndefined();
  });

  it('gives each engine its own terminal event when the host dies', async () => {
    // One process holds both engines, so losing it loses both — and each turn
    // has to end on ITS OWN event name. A single hard-coded `llamaEnd` would
    // have left the transcription with no terminal event at all, and would have
    // sent a `llamaEnd` for a turn no `LlamaCpp` listener started.
    const w = twoEngines();
    const llama = beginOn(w, 1, LLAMA_PLUGIN.name, 'r1');
    const transcript = beginOn(w, 1, TRANSCRIBER.name, 'r1');
    await settle();

    w.hosts[0]?.close('SIGKILL');
    await settle();

    const ends = sawFrom(w.inbox, 1, LLAMA_PLUGIN.name, 'llamaEnd');
    const stops = sawFrom(w.inbox, 1, TRANSCRIBER.name, 'end');
    expect(ends).toHaveLength(1);
    expect(stops).toHaveLength(1);
    // Each carries the payload ITS engine's spec synthesises, not the other's.
    expect(ends[0]).toMatchObject({ requestId: 'r1', stopReason: 'error' });
    expect(stops[0]).toMatchObject({ requestId: 'r1', aborted: true });
    expect(llama()).toMatchObject({ ok: false, error: { code: HANDLE_LOST } });
    expect(transcript()).toMatchObject({ ok: false, error: { code: HANDLE_LOST } });
    expect(w.supervisor.inflightCount).toBe(0);
  });

  it('ends a turn exactly once per engine on a success the host forgot to announce', async () => {
    // The terminal-event rule, per engine, on the success path: a `ret` with no
    // event before it still produces exactly one terminal event — and a `ret`
    // AFTER the event does not produce a second.
    const w = twoEngines();
    beginOn(w, 1, LLAMA_PLUGIN.name, 'r1');
    beginOn(w, 1, TRANSCRIBER.name, 'r1');
    await settle();

    const starts = w.posted().filter((m) => m.method === 'generate');
    const llamaId = starts.find((m) => m.plugin === LLAMA_PLUGIN.name)?.id ?? 0;
    const otherId = starts.find((m) => m.plugin === TRANSCRIBER.name)?.id ?? 0;

    // The transcriber announces its end AND returns; llama.cpp only returns.
    w.emit(TRANSCRIBER.name, 'end', { requestId: 'r1', aborted: false });
    w.hosts[0]?.send({ k: 'ret', id: otherId, ok: true, data: { requestId: 'r1' } });
    w.hosts[0]?.send({ k: 'ret', id: llamaId, ok: true, data: endEvent('r1', 'stop') });
    await settle();

    expect(sawFrom(w.inbox, 1, TRANSCRIBER.name, 'end')).toHaveLength(1);
    expect(sawFrom(w.inbox, 1, LLAMA_PLUGIN.name, 'llamaEnd')).toHaveLength(1);
    expect(w.supervisor.inflightCount).toBe(0);
  });

  it('ends a turn exactly once per engine when the host rejects it', async () => {
    // And the error path. The rejection reaches the caller, and the turn still
    // gets its one terminal event — synthesised by the engine whose turn it is.
    const w = twoEngines();
    const transcript = beginOn(w, 1, TRANSCRIBER.name, 'r1');
    beginOn(w, 1, LLAMA_PLUGIN.name, 'r1');
    await settle();

    const start = w.posted().find((m) => m.plugin === TRANSCRIBER.name && m.method === 'generate');
    w.hosts[0]?.send({
      k: 'ret',
      id: start?.id ?? 0,
      ok: false,
      error: { message: 'the decoder gave up' },
    });
    await settle();

    expect(transcript()).toMatchObject({ ok: false, error: { message: 'the decoder gave up' } });
    const stops = sawFrom(w.inbox, 1, TRANSCRIBER.name, 'end');
    expect(stops).toHaveLength(1);
    expect(stops[0]).toMatchObject({ requestId: 'r1', error: 'the decoder gave up' });
    // The other engine's turn is untouched by its neighbour's failure.
    expect(sawFrom(w.inbox, 1, LLAMA_PLUGIN.name, 'llamaEnd')).toEqual([]);
    expect(w.supervisor.inflightCountFor(LLAMA_PLUGIN.name)).toBe(1);
  });

  it('scopes a second engine s events to the window that started the turn', async () => {
    // Sender scoping is a property of every engine, not of llama.cpp. A new
    // plugin whose events were broadcast would reintroduce defect [11] with a
    // different payload — one window's transcript in another window's page.
    const w = twoEngines();
    beginOn(w, 1, TRANSCRIBER.name, 'r1');
    beginOn(w, 2, TRANSCRIBER.name, 'r2');
    await settle();

    w.emit(TRANSCRIBER.name, 'chunk', { requestId: 'r1', text: 'one' });
    w.emit(TRANSCRIBER.name, 'chunk', { requestId: 'r2', text: 'two' });
    await settle();

    expect(sawFrom(w.inbox, 1, TRANSCRIBER.name, 'chunk')).toEqual([
      { requestId: 'r1', text: 'one' },
    ]);
    expect(sawFrom(w.inbox, 2, TRANSCRIBER.name, 'chunk')).toEqual([
      { requestId: 'r2', text: 'two' },
    ]);

    // An event with no turn — `level` is not in the stream's `progress` list —
    // describes the machine and reaches both, exactly as `llamaThermal` does.
    w.emit(TRANSCRIBER.name, 'level', { db: -12 });
    await settle();
    expect(sawFrom(w.inbox, 1, TRANSCRIBER.name, 'level')).toHaveLength(1);
    expect(sawFrom(w.inbox, 2, TRANSCRIBER.name, 'level')).toHaveLength(1);
  });

  it('checks turn ownership in the engine the cancel names', async () => {
    // The ownership check has to read THIS engine's table. Reading any other
    // engine's is invisible while both engines' turns happen to belong to the
    // same window — so the two turns here have DIFFERENT owners under the same
    // requestId, which is the only arrangement in which a wrong-table lookup
    // shows up at all.
    //
    // FAULT INJECTED: `[...this.#engines.values()][0]?.inflight.get(requestId)`
    // in `#cancelTurn`, i.e. always the first engine's table. Every other test
    // in this file stayed green; this one failed both ways round —
    // `expected [] to have a length of 1` for the legitimate cancel, and
    // `expected 1 to be +0` for the one that should have been refused.
    const w = twoEngines();
    beginOn(w, 1, LLAMA_PLUGIN.name, 'r1');
    beginOn(w, 2, TRANSCRIBER.name, 'r1');
    await settle();

    // Window 2 owns the transcription, so its cancel is honoured.
    void w.call(2, TRANSCRIBER.name, 'cancel', [{ requestId: 'r1' }]);
    await settle();
    let cancels = w.posted().filter((m) => m.method === 'cancel');
    expect(cancels).toHaveLength(1);
    expect(cancels[0]?.plugin).toBe(TRANSCRIBER.name);

    // Window 2 does NOT own the generation under the same id, so its cancel of
    // that one is the no-op the contract promises — indistinguishable from
    // "not running", so a cancel cannot probe another window.
    void w.call(2, LLAMA_PLUGIN.name, 'cancel', [{ requestId: 'r1' }]);
    await settle();
    cancels = w.posted().filter((m) => m.method === 'cancel');
    expect(cancels).toHaveLength(1);
    expect(w.supervisor.inflightCountFor(LLAMA_PLUGIN.name)).toBe(1);
  });

  it('refuses a cross-engine cancel from a window that owns neither turn', async () => {
    // Ownership is checked in the turn's OWN engine. Window 2 cancelling
    // window 1's transcription must be the same no-op it is for a generation.
    const w = twoEngines();
    beginOn(w, 1, TRANSCRIBER.name, 'r1');
    await settle();

    await w.call(2, TRANSCRIBER.name, 'cancel', [{ requestId: 'r1' }]);
    await settle();

    expect(w.posted().filter((m) => m.method === 'cancel')).toEqual([]);
    expect(w.supervisor.inflightCountFor(TRANSCRIBER.name)).toBe(1);
  });

  it('releases both engines for a departing window, and only that window', async () => {
    // A window that is gone is gone for every engine it was using. Scoped to
    // the sender, across all engines — the two halves of the same rule.
    const w = twoEngines();
    const mineLlama = beginOn(w, 1, LLAMA_PLUGIN.name, 'r1');
    const mineOther = beginOn(w, 1, TRANSCRIBER.name, 'r1');
    const theirs = beginOn(w, 2, LLAMA_PLUGIN.name, 'r2');
    await settle();
    expect(w.supervisor.inflightCount).toBe(3);

    w.supervisor.releaseRenderer(1, 'The window that started this generation was closed.');
    await settle();

    expect(w.supervisor.inflightCountFor(LLAMA_PLUGIN.name)).toBe(1);
    expect(w.supervisor.inflightCountFor(TRANSCRIBER.name)).toBe(0);
    expect(mineLlama()).toMatchObject({ ok: false, error: { code: 'RENDERER_GONE' } });
    expect(mineOther()).toMatchObject({ ok: false, error: { code: 'RENDERER_GONE' } });
    expect(theirs()).toBeUndefined();

    // One cancel per abandoned turn, each on its own plugin — and none for the
    // window that is still there.
    const cancels = w.posted().filter((m) => m.method === 'cancel');
    expect(cancels.map((m) => `${String(m.plugin)}/${String((m.args?.[0] as { requestId: string }).requestId)}`).sort()).toEqual(
      ['LlamaCpp/r1', 'Transcriber/r1'],
    );
    // No terminal event was sent to a page that no longer exists.
    expect(sawFrom(w.inbox, 1, TRANSCRIBER.name, 'end')).toEqual([]);
    expect(sawFrom(w.inbox, 1, LLAMA_PLUGIN.name, 'llamaEnd')).toEqual([]);
  });

  it('drops an event from a plugin it serves no engine for', async () => {
    // A host emitting for an engine main does not know about is not something
    // to broadcast on a guess. Dropped, and said out loud.
    const w = twoEngines();
    w.emit('OnnxRuntime', 'onnxPartial', { requestId: 'r1' });
    await settle();

    expect(w.warnings.join('\n')).toMatch(/unknown plugin "OnnxRuntime"/);
    expect(w.inbox.get(1)).toEqual([]);
  });

  it('drops an event name the engine s own definition does not declare', async () => {
    // The manifest is the contract in both directions: a renderer cannot
    // subscribe to an undeclared event, so delivering one would be delivering
    // to nobody — and a host that has started emitting names we do not know is
    // a host worth being told about.
    const w = twoEngines();
    w.emit(TRANSCRIBER.name, 'llamaToken', { requestId: 'r1', token: 'x' });
    await settle();

    expect(w.warnings.join('\n')).toMatch(/"llamaToken", which "Transcriber" does not declare/);
    expect(w.inbox.get(1)).toEqual([]);
  });

  it('refuses two engines registered under one name', () => {
    // The plugin name IS the wire address. Two engines sharing one is ambiguous
    // in both directions and there is no arrangement of the maps that fixes it.
    expect(
      () =>
        new Supervisor({
          spawn: () => ({ link: createLinkPair().main, kill: () => undefined }),
          notify: () => undefined,
          timers: manualClock(),
          engines: [LLAMA_ENGINE, { definition: LLAMA_PLUGIN }],
        }),
    ).toThrow(/two engines are registered as "LlamaCpp"/);
  });

  it('gives a plugin with no stream no turns, no owner and no scoped methods', () => {
    // `DshHost` is one: two questions about the tree, no generation to own.
    // It must still be servable, and it must not acquire a sender-scoped
    // `generate` by accident.
    const { supervisor } = wiredSupervisor({
      engines: [LLAMA_ENGINE, { definition: DSH_PLUGIN }],
    });
    const dsh = supervisor.plugin(DSH_PLUGIN.name);
    expect(dsh[SENDER_SCOPED]).toEqual([]);
    expect(Object.keys(dsh).sort()).toEqual([...DSH_METHODS].sort());
    expect(supervisor.inflightCountFor(DSH_PLUGIN.name)).toBe(0);
    expect(supervisor.engines).toEqual([LLAMA_PLUGIN.name, DSH_PLUGIN.name]);
  });
});

/* ══ The host runtime, serving two plugins ═════════════════════════════ */

/**
 * `HostRuntime` with llama.cpp AND a second engine on one link.
 *
 * This is the other end of the same seam: the supervisor's half is above, and
 * this is the half that runs inside the utility process. It is driven through a
 * real port, by hand, because the questions are about dispatch and refusal.
 */
function twoServed(
  options: { fail?: Readonly<Record<string, string>>; guard?: CallGuard } = {},
): {
  call(plugin: string, method: string, args: readonly unknown[]): Promise<{
    ok: boolean;
    message: string;
    data: unknown;
  }>;
  readonly events: { plugin: string; name: string; data: unknown }[];
  readonly reached: { plugin: string; method: string; args: readonly unknown[] }[];
  readonly warnings: string[];
  /** Every (plugin, event) the runtime actually subscribed to, in order. */
  readonly subscribed: { plugin: string; name: string }[];
  /** Every subscription the runtime removed on dispose. */
  readonly removed: string[];
  dispose(): Promise<void>;
  emitLlama(name: string, data: unknown): void;
  emitOther(name: string, data: unknown): void;
} {
  const pair = createLinkPair();
  const warnings: string[] = [];
  const reached: { plugin: string; method: string; args: readonly unknown[] }[] = [];
  const events: { plugin: string; name: string; data: unknown }[] = [];
  const subscribed: { plugin: string; name: string }[] = [];
  const removed: string[] = [];
  const emitters = new Map<string, Map<string, (data: unknown) => void>>();

  const implementation = (name: string, methods: readonly string[]): HostPluginImplementation => {
    const listeners = new Map<string, (data: unknown) => void>();
    emitters.set(name, listeners);
    return {
      ...Object.fromEntries(
        methods.map((method) => [
          method,
          (...args: readonly unknown[]) => {
            reached.push({ plugin: name, method, args });
            const failure = options.fail?.[`${name}.${method}`];
            if (failure !== undefined) return Promise.reject(new Error(failure));
            return Promise.resolve({ plugin: name, method });
          },
        ]),
      ),
      addListener: (eventName: string, listener: (data: unknown) => void) => {
        listeners.set(eventName, listener);
        subscribed.push({ plugin: name, name: eventName });
        return Promise.resolve({
          remove: async (): Promise<void> => void removed.push(`${name}:${eventName}`),
        });
      },
    } as unknown as HostPluginImplementation;
  };

  const runtime = createHostRuntime({
    link: pair.host,
    warn: (message: string) => warnings.push(message),
  });
  runtime.serve(LLAMA_PLUGIN, implementation(LLAMA_PLUGIN.name, LLAMA_METHODS), {
    ...LLAMA_HOST_POLICY,
    ...(options.guard === undefined ? {} : { guard: options.guard }),
  });
  // No shape table and no opacity table: a second engine's policy is its own,
  // and llama.cpp's must not be applied to it by default.
  runtime.serve(TRANSCRIBER, implementation(TRANSCRIBER.name, TRANSCRIBER.methods));

  pair.main.onMessage((message) => {
    const m = message as { k: string; plugin?: string; name?: string; data?: unknown };
    if (m.k === 'ev') events.push({ plugin: m.plugin ?? '', name: m.name ?? '', data: m.data });
  });

  let nextId = 1;
  return {
    events,
    reached,
    warnings,
    subscribed,
    removed,
    dispose: () => runtime.dispose(),
    emitLlama: (name, data) => emitters.get(LLAMA_PLUGIN.name)?.get(name)?.(data),
    emitOther: (name, data) => emitters.get(TRANSCRIBER.name)?.get(name)?.(data),
    call: (plugin, method, args) =>
      new Promise((done) => {
        const id = nextId++;
        pair.main.onMessage((message) => {
          const answer = message as {
            k: string;
            id: number;
            ok: boolean;
            data?: unknown;
            error?: { message: string };
          };
          if (answer.k !== 'ret' || answer.id !== id) return;
          done({ ok: answer.ok, message: answer.error?.message ?? '', data: answer.data });
        });
        pair.main.postMessage({ k: 'call', id, plugin, method, args });
      }),
  };
}

describe('the inference host serves plugins by name', () => {
  it('routes a shared method name to the plugin the call names', async () => {
    // `generate` exists on both. Before the plugin dimension there was one
    // implementation and one allowlist, so this call had exactly one possible
    // destination whatever the caller meant.
    const h = twoServed();
    await h.call(TRANSCRIBER.name, 'generate', [{ handle: 'h', prompt: 'p', requestId: 'r1' }]);
    await h.call(LLAMA_PLUGIN.name, 'generate', [{ handle: 'h', prompt: 'p', requestId: 'r1' }]);

    expect(h.reached.map((r) => r.plugin)).toEqual([TRANSCRIBER.name, LLAMA_PLUGIN.name]);
  });

  it('applies each plugin s own method allowlist', async () => {
    // `describe` is the transcriber's; `load` is llama.cpp's. Neither may be
    // reached through the other's name, and the refusal says whose surface was
    // actually asked.
    const h = twoServed();
    const wrongWay = await h.call(LLAMA_PLUGIN.name, 'describe', []);
    const otherWay = await h.call(TRANSCRIBER.name, 'benchmark', [{ handle: 'h' }]);

    expect(wrongWay.ok).toBe(false);
    expect(wrongWay.message).toBe('inference host: "LlamaCpp" has no method "describe".');
    expect(otherWay.ok).toBe(false);
    expect(otherWay.message).toBe('inference host: "Transcriber" has no method "benchmark".');
    expect(h.reached).toEqual([]);
  });

  it('refuses a call for a plugin it does not serve', async () => {
    const h = twoServed();
    const answer = await h.call('OnnxRuntime', 'transcribe', [{}]);
    expect(answer.ok).toBe(false);
    expect(answer.message).toMatch(/no plugin named "OnnxRuntime"/);
    expect(h.reached).toEqual([]);
  });

  it('applies each plugin s own argument-shape table, and only its own', async () => {
    // llama.cpp's `generate` needs a handle and a requestId. The transcriber's
    // `generate` is a different method that happens to share a name — applying
    // llama's required fields to it would refuse legitimate calls, which is how
    // a shared table breaks the engine it was not written for.
    const h = twoServed();
    const refused = await h.call(LLAMA_PLUGIN.name, 'generate', [{ prompt: 'p' }]);
    const allowed = await h.call(TRANSCRIBER.name, 'generate', [{ audio: 'wav' }]);

    expect(refused.ok).toBe(false);
    expect(refused.message).toContain('"generate"');
    expect(refused.message).toContain('handle');
    expect(allowed.ok).toBe(true);
    expect(h.reached).toEqual([
      { plugin: TRANSCRIBER.name, method: 'generate', args: [{ audio: 'wav' }] },
    ]);
  });

  it('tags every forwarded event with the plugin that emitted it', async () => {
    // The forwarding used to be `LLAMA_EVENTS.map(...)` with no plugin on the
    // envelope. A second engine's events would have arrived indistinguishable
    // from llama.cpp's — and `end` and `llamaEnd` are only different names by
    // luck, not by construction.
    const h = twoServed();
    h.emitLlama('llamaToken', { requestId: 'r1', token: 'a' });
    h.emitOther('chunk', { requestId: 'r1', text: 'b' });
    await settle();

    expect(h.events).toEqual([
      { plugin: LLAMA_PLUGIN.name, name: 'llamaToken', data: { requestId: 'r1', token: 'a' } },
      { plugin: TRANSCRIBER.name, name: 'chunk', data: { requestId: 'r1', text: 'b' } },
    ]);
  });

  it('subscribes each plugin to exactly the events its definition declares', () => {
    // The allowlist runs in this direction too. The forwarding loop used to be
    // `LLAMA_EVENTS.map(...)` — a constant — so a second engine would have been
    // subscribed to llama.cpp's three event names and to none of its own.
    const h = twoServed();
    expect(h.subscribed).toEqual([
      ...LLAMA_EVENTS.map((name) => ({ plugin: LLAMA_PLUGIN.name, name })),
      ...TRANSCRIBER.events.map((name) => ({ plugin: TRANSCRIBER.name, name })),
    ]);
  });

  it('keeps one plugin s opaque-failure policy off the other', async () => {
    // `load` is opaque for llama.cpp because its failure quotes the bytes of a
    // file the renderer named. Nothing on the transcriber has that property, so
    // its failures stay readable — which is the point of the table being per
    // plugin rather than a rule about method names. Both engines fail here,
    // with the same words, and only one of them is replaced.
    // THE SAME METHOD NAME on both engines, so the only thing that can decide
    // which policy applies is the plugin. FAULT INJECTED: making `#opaque` scan
    // every registration's table for the method name replaced the transcriber's
    // message too — `expected '…could not be loaded…' to be 'Invalid GGUF
    // magic…'` — which is a diagnostic destroyed on behalf of an engine that
    // never asked.
    const quoted = 'Invalid GGUF magic. Expected "GGUF" but got "##"';
    const h = twoServed({
      fail: { 'LlamaCpp.load': quoted, 'Transcriber.load': quoted },
    });
    const hidden = await h.call(LLAMA_PLUGIN.name, 'load', [{ modelPath: '/m.gguf' }]);
    const shown = await h.call(TRANSCRIBER.name, 'load', [{ anything: true }]);

    expect(hidden.message).not.toContain('GGUF magic');
    expect(hidden.message).toMatch(/could not be loaded/);
    expect(shown.message).toBe(quoted);
    // The engine's own words are kept on this side, named by plugin.
    expect(h.warnings.join('\n')).toContain('LlamaCpp.load failed');
    expect(Object.keys(LLAMA_OPAQUE_FAILURES)).toEqual(['load']);
  });

  it('keeps one plugin s path guard off the other', async () => {
    // The model-directory confinement (defect [8]) is llama.cpp's, because it
    // is about the directory llama.cpp's models live in. Applying it to another
    // engine would refuse that engine's legitimate paths — a security control
    // silently becoming a bug in code it was never written for.
    //
    // FAULT INJECTED: folding every registration's guard over the arguments
    // (`reduce`) refused the transcriber's `/etc/hosts` too, and this test
    // failed with `expected false to be true`.
    const h = twoServed({ guard: modelPathGuard('/app-data/models') });
    const refused = await h.call(LLAMA_PLUGIN.name, 'load', [{ modelPath: '/etc/hosts' }]);
    const allowed = await h.call(TRANSCRIBER.name, 'load', [{ modelPath: '/etc/hosts' }]);

    expect(refused.ok).toBe(false);
    expect(refused.message).toMatch(/model folder/);
    expect(allowed.ok).toBe(true);
    // Reached verbatim: no other engine's guard rewrote it on the way in.
    expect(h.reached).toEqual([
      { plugin: TRANSCRIBER.name, method: 'load', args: [{ modelPath: '/etc/hosts' }] },
    ]);
  });

  it('answers one ping once, however many plugins are served', async () => {
    // The ping is the boundary's, not a plugin's. Subscribed per plugin it
    // would answer twice for two engines, and a supervisor matching on the
    // echoed id would treat the second pong as an answer to a ping it never
    // sent.
    const pair = createLinkPair();
    const seen: unknown[] = [];
    const runtime = createHostRuntime({ link: pair.host });
    const stub = {
      addListener: async () => ({ remove: async (): Promise<void> => undefined }),
    } as unknown as HostPluginImplementation;
    runtime.serve({ name: 'A', methods: [], events: [] }, stub);
    runtime.serve({ name: 'B', methods: [], events: [] }, stub);

    pair.main.onMessage((message) => seen.push(message));
    pair.main.postMessage({ k: 'ping', id: 9 });
    await settle();

    expect(seen).toEqual([{ k: 'pong', id: 9 }]);
    expect(runtime.served).toEqual(['A', 'B']);
  });

  it('refuses to serve two plugins under one name', () => {
    const runtime = createHostRuntime({ link: createLinkPair().host });
    const stub = {
      addListener: async () => ({ remove: async (): Promise<void> => undefined }),
    } as unknown as HostPluginImplementation;
    runtime.serve(LLAMA_PLUGIN, stub);
    expect(() => runtime.serve(LLAMA_PLUGIN, stub)).toThrow(/"LlamaCpp" is already served/);
  });

  it('removes EVERY plugin s subscriptions on dispose, not just the first s', async () => {
    // The disposer used to close over one plugin's handle array. With a
    // registry it has to walk all of them, and a walk that stops at the first
    // registration leaves the second engine subscribed to an engine that is
    // going away.
    const h = twoServed();
    await h.dispose();
    expect(h.removed.sort()).toEqual([
      'LlamaCpp:llamaEnd',
      'LlamaCpp:llamaThermal',
      'LlamaCpp:llamaToken',
      'Transcriber:chunk',
      'Transcriber:end',
      'Transcriber:level',
    ]);
  });

  it('registers both definitions on the plugin bridge without a channel collision', () => {
    // The renderer-facing half. Two plugins with two identically named methods
    // are only safe because the channel scheme is `chatterang:call:<plugin>:
    // <method>` — a flat namespace would register two handlers on one channel.
    const host = new PluginHost(() => true);
    const stub = (methods: readonly string[]): PluginImplementation =>
      Object.fromEntries(methods.map((m) => [m, () => undefined])) as PluginImplementation;
    host.register(LLAMA_PLUGIN, stub(LLAMA_METHODS));
    host.register(TRANSCRIBER, stub(TRANSCRIBER.methods));

    expect(channelCollisions([LLAMA_PLUGIN, TRANSCRIBER])).toEqual([]);
    const channels = allowedChannels(host.manifest());
    expect(channels.has(methodChannel(LLAMA_PLUGIN.name, 'generate'))).toBe(true);
    expect(channels.has(methodChannel(TRANSCRIBER.name, 'generate'))).toBe(true);
    expect(methodChannel(LLAMA_PLUGIN.name, 'generate')).not.toBe(
      methodChannel(TRANSCRIBER.name, 'generate'),
    );
  });
});
