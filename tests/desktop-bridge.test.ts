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

import {
  BRIDGE_KEYS,
  DEFAULT_POLICY,
  DSH_PLUGIN,
  EVENT_CHANNEL,
  HANDLE_LOST,
  HOST_TIMEOUT,
  LLAMA_EVENTS,
  LLAMA_METHODS,
  LLAMA_PLUGIN,
  PluginHost,
  Supervisor,
  allowedChannels,
  assertCloneable,
  capacitorShimSource,
  channelCollisions,
  createMainRouter,
  createRendererBridge,
  fromWireError,
  installCapacitorShim,
  methodChannel,
  serveLlamaCpp,
} from '@chatterang/desktop/bridge';
import type {
  BootManifest,
  HostMessage,
  MessageLink,
  NotifyListeners,
  PluginImplementation,
  PreloadBridge,
  RendererIpc,
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
 * preload bridge, the real `serveLlamaCpp`, the real `LlamaCppNode` from
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
      serveLlamaCpp({ link: pair.host, plugin: make() });
      hosts.push(pair);
      return {
        link: pair.main,
        kill: () => {
          pair.killedBySupervisor = true;
          pair.kill('terminated by the supervisor');
        },
      };
    },
    notify: (eventName, data) => host.notifyListeners(LLAMA_PLUGIN.name, eventName, data),
    timers: clock,
    ...(options.policy === undefined ? {} : { policy: options.policy }),
  });

  host.register(LLAMA_PLUGIN, supervisor as unknown as PluginImplementation);
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
      host.releaseSender(1);
      supervisor.releaseRenderer('The window that started this generation was closed.');
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

  it('registers the real Supervisor without complaint, so the forwarders all exist', () => {
    // The counterpart to the test above: the check is only worth having if it
    // passes for the object we actually ship.
    const pair = createLinkPair();
    const host = new PluginHost(() => true);
    const supervisor = new Supervisor({
      spawn: () => ({ link: pair.main, kill: () => pair.kill('terminated') }),
      notify: () => undefined,
      timers: manualClock(),
    });
    expect(() =>
      host.register(LLAMA_PLUGIN, supervisor as unknown as PluginImplementation),
    ).not.toThrow();
    expect(LLAMA_METHODS).toHaveLength(10);
    expect(LLAMA_EVENTS).toEqual(['llamaToken', 'llamaEnd', 'llamaThermal']);
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

    const second = supervisor.getCapabilities();
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
    expect(supervisor.hostStatus().treeAssertion).toMatch(/has not finished booting/);

    hosts[0]?.send({
      k: 'boot',
      status: { mounted: true, services: ['llm'], routes: ['llama'], treeAssertion: 'walked' },
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
      status: { mounted: true, services: ['llm'], routes: ['llama-2'], treeAssertion: 'walked' },
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
    await expect(supervisor.getCapabilities()).rejects.toThrow(/is not being restarted again/);
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
    expect(await supervisor.getCapabilities()).toBe('fine');

    await clock.advance(DEFAULT_POLICY.pingIntervalMs + 1);
    expect((hosts[0]?.posted.at(-1) as { k: string }).k).toBe('ping');
    expect(supervisor.spawnCount).toBe(1);

    await clock.advance(DEFAULT_POLICY.pingTimeoutMs + 1);
    // Condemned, and terminated — the process was never going to exit on its
    // own, and leaving it running would double the GPU its replacement wants.
    expect(hosts[0]?.killed).toBe(true);

    await clock.advance(DEFAULT_POLICY.restartDelayMs + 1);
    expect(supervisor.spawnCount).toBe(2);
    expect(await supervisor.getCapabilities()).toBe('fine');
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
    const slow = supervisor.load({ modelPath: '/models/big.gguf' });
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
    // `serveLlamaCpp` against a plugin whose every method hangs.
    const pair = createLinkPair();
    const hanging = {
      addListener: async () => ({ remove: async () => undefined }),
      generate: () => new Promise(() => undefined),
      getCapabilities: () => new Promise(() => undefined),
    } as unknown as LlamaCppPlugin;
    serveLlamaCpp({ link: pair.host, plugin: hanging });

    const seen: unknown[] = [];
    pair.main.onMessage((message) => seen.push(message));
    pair.main.postMessage({ k: 'call', id: 1, method: 'getCapabilities', args: [] });
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
