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
  DSH_PLUGIN,
  EVENT_CHANNEL,
  HANDLE_LOST,
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
  installCapacitorShim,
  methodChannel,
  serveLlamaCpp,
} from '@chatterang/desktop/bridge';
import type {
  DesktopBridge,
  MessageLink,
  PluginImplementation,
  RendererIpc,
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

  return {
    main: side('main'),
    host: side('host'),
    kill(reason) {
      if (!open) return;
      open = false;
      for (const close of closers) close(reason);
    },
  };
}

interface Harness {
  readonly bridge: DesktopBridge;
  readonly host: PluginHost;
  readonly supervisor: Supervisor;
  /** Every channel the renderer named, in order. */
  readonly channels: string[];
  killHost(reason?: string): void;
  destroyRenderer(): void;
}

/** Renderer -> preload -> main -> inference host, all real, twice serialized. */
function harness(plugin: LlamaCppPlugin, dsh?: PluginImplementation): Harness {
  const pair = createLinkPair();
  serveLlamaCpp({ link: pair.host, plugin });

  let eventListener: ((payload: unknown) => void) | null = null;
  let rendererAlive = true;

  const host = new PluginHost((_senderId, payload) => {
    if (!rendererAlive || eventListener === null) return false;
    const cloned = structuredClone(payload);
    const deliver = eventListener;
    queueMicrotask(() => deliver(cloned));
    return true;
  });

  const supervisor = new Supervisor({
    link: pair.main,
    notify: (eventName, data) => host.notifyListeners(LLAMA_PLUGIN.name, eventName, data),
  });

  host.register(LLAMA_PLUGIN, supervisor as unknown as PluginImplementation);
  if (dsh !== undefined) host.register(DSH_PLUGIN, dsh);

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

  return {
    bridge: createRendererBridge(ipc),
    host,
    supervisor,
    channels,
    killHost: (reason = 'SIGKILL') => pair.kill(reason),
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
async function collect<T>(bridge: DesktopBridge, eventName: string): Promise<T[]> {
  const received: T[] = [];
  await bridge.addListener(LLAMA_PLUGIN.name, eventName, (data) => received.push(data as T));
  return received;
}

const settle = async (): Promise<void> => {
  await new Promise((done) => setTimeout(done, 10));
};

async function loadOne(bridge: DesktopBridge): Promise<string> {
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
    const exposed = Object.fromEntries(
      BRIDGE_KEYS.map((key) => [key, (h.bridge as unknown as Record<string, unknown>)[key]]),
    );
    // Both directions: nothing missing, and nothing extra. The preload builds
    // the exposed object from this same list, so the allowlist is one list.
    expect(Object.keys(exposed).sort()).toEqual([...BRIDGE_KEYS].sort());
    expect(Object.keys(h.bridge).sort()).toEqual([...BRIDGE_KEYS].sort());
    for (const key of BRIDGE_KEYS) expect(typeof exposed[key]).toBe('function');
    expect((h.bridge as unknown as Record<string, unknown>)['ipcRenderer']).toBeUndefined();
    expect((h.bridge as unknown as Record<string, unknown>)['require']).toBeUndefined();
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
    const supervisor = new Supervisor({ link: pair.main, notify: () => undefined });
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
    installCapacitorShim(globalThis as never, shared.bridge);
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
