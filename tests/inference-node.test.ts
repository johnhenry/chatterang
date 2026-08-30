import { describe, expect, it, vi } from 'vitest';
import type {
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
import { LlamaCppNode, backendForGpu } from '@chatterang/inference-node';

/**
 * The Node llama.cpp plugin, tested without a model file.
 *
 * Nobody running `npm test` has a GGUF, and requiring one would mean the
 * behaviours most likely to break in a refactor — the terminal-event rule, the
 * handle map, the cache-reuse arithmetic — are exactly the ones nobody can
 * run. So `node-llama-cpp` reaches the plugin through the `LlamaEngine`
 * interface and these tests supply a fake that implements only what the plugin
 * calls.
 *
 * That is not a compromise, it is the subject: the plugin's job is contract
 * translation, and translation is what a fake exercises. What it cannot cover
 * is whether llama.cpp itself produces sensible tokens, which no unit test was
 * ever going to establish.
 */

/* ── The fake engine ──────────────────────────────────────────────────── */

/**
 * A reversible word-level tokenizer.
 *
 * Real round-tripping matters here: the prefix-reuse tests assert that two
 * prompts sharing a leading run of words share a leading run of token ids, and
 * a hash-based fake id would make that accidental rather than structural.
 */
class FakeVocabulary {
  #ids = new Map<string, number>();
  #texts: string[] = [];

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

interface FakeScript {
  /** One entry per `generate` call; the last is reused once exhausted. */
  replies?: string[];
  /** Throw from `evaluate` once this many tokens have been yielded. */
  throwAfterTokens?: number;
  /** Context size the fake context reports. */
  contextSize?: number;
  /** Make `createContext` reject the first time it is asked for a size. */
  refuseContextSize?: boolean;
  chatTemplateName?: string | null;
  trainContextSize?: number;
  gpu?: LlamaGpu;
  gpuTypes?: LlamaGpu[];
  /** What the engine says it can allocate a model into. */
  memory?: { free: number; total: number };
  /** Reject `loadModel` for these paths, to exercise the draft-model fallback. */
  failingModelPaths?: string[];
  /** Runs inside `adaptStateToTokens`, so a test can act mid-alignment. */
  onAdaptState?: () => void;
}

class FakeSequence implements LlamaEngineSequence {
  /** The KV cache, modelled as the tokens it holds. */
  state: LlamaTokenId[] = [];
  tokenPredictions = { validated: 0, refuted: 0 };
  /** Every batch handed to `evaluate`, for prefill-vs-decode assertions. */
  evaluated: LlamaTokenId[][] = [];
  prefilled: LlamaTokenId[][] = [];
  disposed = false;

  #vocabulary: FakeVocabulary;
  #script: FakeScript;
  #call = 0;

  constructor(vocabulary: FakeVocabulary, script: FakeScript) {
    this.#vocabulary = vocabulary;
    this.#script = script;
  }

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
    const { firstDifferentIndex } = this.compareContextTokens(tokens);
    this.state = this.state.slice(0, firstDifferentIndex);
    this.#script.onAdaptState?.();
  }

  async clearHistory(): Promise<void> {
    this.state = [];
  }

  async *evaluate(tokens: LlamaTokenId[]): AsyncIterable<LlamaTokenId> {
    this.evaluated.push([...tokens]);
    this.state.push(...tokens);

    const replies = this.#script.replies ?? ['ok'];
    const reply = replies[Math.min(this.#call, replies.length - 1)] ?? '';
    this.#call += 1;

    let yielded = 0;
    for (const token of this.#vocabulary.encode(reply)) {
      if (this.#script.throwAfterTokens !== undefined && yielded >= this.#script.throwAfterTokens) {
        throw new Error('engine exploded mid-stream');
      }
      // Sampled tokens enter the cache, which is what lets the next turn's
      // prefix match include the model's own reply.
      this.state.push(token);
      yielded += 1;
      yield token;
    }
  }

  async evaluateWithoutGeneratingNewTokens(tokens: LlamaTokenId[]): Promise<void> {
    this.prefilled.push([...tokens]);
    this.state.push(...tokens);
  }

  async dispose(): Promise<void> {
    this.disposed = true;
  }
}

class FakeContext implements LlamaEngineContext {
  readonly contextSize: number;
  sequences: FakeSequence[] = [];
  drafts: (LlamaEngineSequence | undefined)[] = [];
  disposed = false;

  #vocabulary: FakeVocabulary;
  #script: FakeScript;

  constructor(vocabulary: FakeVocabulary, script: FakeScript, contextSize: number) {
    this.#vocabulary = vocabulary;
    this.#script = script;
    this.contextSize = contextSize;
  }

  getSequence(options?: { draft?: LlamaEngineSequence }): LlamaEngineSequence {
    this.drafts.push(options?.draft);
    const sequence = new FakeSequence(this.#vocabulary, this.#script);
    this.sequences.push(sequence);
    return sequence;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
  }
}

class FakeModel implements LlamaEngineModel {
  readonly trainContextSize: number;
  readonly chatTemplateName: string | null;
  contexts: FakeContext[] = [];
  contextRequests: (number | undefined)[] = [];
  disposed = false;

  #vocabulary: FakeVocabulary;
  #script: FakeScript;
  #refusals: number;

  constructor(vocabulary: FakeVocabulary, script: FakeScript) {
    this.#vocabulary = vocabulary;
    this.#script = script;
    this.#refusals = script.refuseContextSize ? 1 : 0;
    this.trainContextSize = script.trainContextSize ?? 8192;
    this.chatTemplateName = script.chatTemplateName === undefined ? 'chatML' : script.chatTemplateName;
  }

  tokenize(text: string): LlamaTokenId[] {
    return this.#vocabulary.encode(text);
  }

  detokenize(tokens: readonly LlamaTokenId[]): string {
    return this.#vocabulary.decode(tokens);
  }

  async createContext(options?: { contextSize?: number }): Promise<LlamaEngineContext> {
    this.contextRequests.push(options?.contextSize);
    if (options?.contextSize !== undefined && this.#refusals > 0) {
      this.#refusals -= 1;
      throw new Error('not enough VRAM');
    }
    const context = new FakeContext(
      this.#vocabulary,
      this.#script,
      options?.contextSize ?? this.#script.contextSize ?? 4096,
    );
    this.contexts.push(context);
    return context;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
  }
}

class FakeEngine implements LlamaEngine {
  readonly gpu: LlamaGpu;
  readonly engineVersion = 'llama.cpp b-fake';
  models: FakeModel[] = [];
  requestedGpu: LlamaGpu | 'auto' | null = null;
  disposed = false;

  #vocabulary = new FakeVocabulary();
  #script: FakeScript;

  constructor(script: FakeScript) {
    this.#script = script;
    this.gpu = script.gpu ?? false;
  }

  async listGpuTypes(): Promise<LlamaGpu[]> {
    return this.#script.gpuTypes ?? [];
  }

  async getMemoryState(): Promise<{ free: number; total: number }> {
    return this.#script.memory ?? { free: 0, total: 0 };
  }

  async loadModel(options: { modelPath: string }): Promise<LlamaEngineModel> {
    if (this.#script.failingModelPaths?.includes(options.modelPath)) {
      throw new Error(`cannot open ${options.modelPath}`);
    }
    const model = new FakeModel(this.#vocabulary, this.#script);
    this.models.push(model);
    return model;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
  }
}

function fakePlugin(script: FakeScript = {}): {
  plugin: LlamaCppNode;
  engine: FakeEngine;
} {
  const engine = new FakeEngine(script);
  const plugin = new LlamaCppNode({
    createEngine: async ({ gpu }) => {
      engine.requestedGpu = gpu;
      return engine;
    },
  });
  return { plugin, engine };
}

async function loadOne(
  plugin: LlamaCppNode,
  options: Partial<Parameters<LlamaCppPlugin['load']>[0]> = {},
): Promise<string> {
  const { handle } = await plugin.load({ modelPath: '/models/test.gguf', ...options });
  return handle;
}

/** Every `llamaEnd` the plugin emits, in order. */
function recordEnds(plugin: LlamaCppNode): GenerationEndEvent[] {
  const events: GenerationEndEvent[] = [];
  void plugin.addListener('llamaEnd', (event) => events.push(event));
  return events;
}

function recordTokens(plugin: LlamaCppNode): TokenEvent[] {
  const events: TokenEvent[] = [];
  void plugin.addListener('llamaToken', (event) => events.push(event));
  return events;
}

/* ── The terminal-event rule ──────────────────────────────────────────── */

/**
 * `generate` always emits exactly one `llamaEnd`.
 *
 * `native/README.md` states it and the adapter's streaming loop waits on it,
 * so a path that returns or throws without one hangs the UI with no way back.
 * Three separate tests because a refactor breaks these paths independently:
 * the success path is the one people run, and the other two are the ones that
 * quietly stop working.
 */
describe('llamaEnd is terminal', () => {
  it('fires on success', async () => {
    const { plugin } = fakePlugin({ replies: ['Hello there.'] });
    const ends = recordEnds(plugin);
    const handle = await loadOne(plugin);

    const result = await plugin.generate({ handle, prompt: 'hi', requestId: 'r1' });

    expect(ends).toHaveLength(1);
    expect(ends[0]?.requestId).toBe('r1');
    expect(ends[0]?.error).toBeUndefined();
    expect(ends[0]?.stopReason).toBe('stop');
    expect(ends[0]?.text).toBe('Hello there.');
    expect(result.text).toBe('Hello there.');
  });

  it('fires on error, and carries the message', async () => {
    const { plugin } = fakePlugin({ replies: ['one two three'], throwAfterTokens: 1 });
    const ends = recordEnds(plugin);
    const handle = await loadOne(plugin);

    await expect(
      plugin.generate({ handle, prompt: 'hi', requestId: 'r2' }),
    ).rejects.toThrow('engine exploded mid-stream');

    expect(ends).toHaveLength(1);
    expect(ends[0]?.stopReason).toBe('error');
    expect(ends[0]?.error).toBe('engine exploded mid-stream');
    // The tokens that did arrive before the failure are still reported, so a
    // partial answer is not silently discarded.
    expect(ends[0]?.completionTokens).toBe(1);
  });

  it('fires on cancel', async () => {
    const { plugin } = fakePlugin({ replies: ['one two three four'] });
    const ends = recordEnds(plugin);
    const handle = await loadOne(plugin);

    // Cancel from inside the token stream: the plugin checks the flag before
    // publishing each token, so the next one never reaches a listener.
    void plugin.addListener('llamaToken', (event) => {
      if (event.index === 0) void plugin.cancel({ requestId: event.requestId });
    });
    const tokens = recordTokens(plugin);

    const result = await plugin.generate({ handle, prompt: 'hi', requestId: 'r3' });

    expect(ends).toHaveLength(1);
    expect(ends[0]?.stopReason).toBe('cancelled');
    expect(ends[0]?.error).toBeUndefined();
    expect(result.stopReason).toBe('cancelled');
    expect(tokens).toHaveLength(1);
  });

  it('fires even when the handle does not exist', async () => {
    // The rule is unconditional. iOS rejects this case before emitting
    // anything, which is the shape of bug the rule exists to prevent.
    const { plugin } = fakePlugin();
    const ends = recordEnds(plugin);

    await expect(
      plugin.generate({ handle: 'nope', prompt: 'hi', requestId: 'r4' }),
    ).rejects.toThrow(/No model is loaded/);

    expect(ends).toHaveLength(1);
    expect(ends[0]?.stopReason).toBe('error');
  });

  it('fires once, not once per listener call, and not twice on the error path', async () => {
    const { plugin } = fakePlugin({ replies: ['a b'], throwAfterTokens: 0 });
    const ends = recordEnds(plugin);
    const handle = await loadOne(plugin);

    await expect(plugin.generate({ handle, prompt: 'hi', requestId: 'r5' })).rejects.toThrow();

    // The `finally` backstop must not double-emit after the `catch` has fired.
    expect(ends).toHaveLength(1);
  });

  it('survives a listener that throws', async () => {
    // A broken listener must not abort the generation — and must not stop the
    // other listeners from seeing the terminal event.
    const { plugin } = fakePlugin({ replies: ['fine'] });
    void plugin.addListener('llamaEnd', () => {
      throw new Error('listener is broken');
    });
    const ends = recordEnds(plugin);
    const handle = await loadOne(plugin);

    await expect(plugin.generate({ handle, prompt: 'hi', requestId: 'r6' })).resolves.toBeDefined();
    expect(ends).toHaveLength(1);
  });
});

/* ── Cache reuse ──────────────────────────────────────────────────────── */

/**
 * `cachedTokens` reports the reused KV-cache prefix.
 *
 * Prefill dominates a long conversation: without reuse, turn 10 reprocesses
 * every token of turns 1–9 before emitting anything. The web shim returns a
 * hard-coded 0 and documents why faking it hides that regression; on Node
 * `compareContextTokens` gives the real boundary, so these tests pin it.
 */
describe('cachedTokens', () => {
  it('is 0 on a cold context', async () => {
    const { plugin } = fakePlugin({ replies: ['reply'] });
    const handle = await loadOne(plugin);

    const result = await plugin.generate({
      handle,
      prompt: 'the quick brown fox',
      requestId: 'c1',
    });

    expect(result.cachedTokens).toBe(0);
    expect(result.promptTokens).toBe(4);
  });

  it('counts the shared prefix on a follow-up turn', async () => {
    const first = 'the quick brown fox ';
    const reply = 'yes indeed ';
    const { plugin } = fakePlugin({ replies: [reply] });
    const handle = await loadOne(plugin);

    await plugin.generate({ handle, prompt: first, requestId: 'c2' });

    // Turn two is turn one's prompt, plus the model's own reply, plus more —
    // exactly how a conversation grows.
    const result = await plugin.generate({
      handle,
      prompt: `${first}${reply}and then some`,
      requestId: 'c3',
    });

    // Four prompt tokens plus the two the model generated are already resident.
    expect(result.cachedTokens).toBe(6);
    expect(result.promptTokens).toBe(9);
  });

  it('counts only the tokens that actually match', async () => {
    const { plugin } = fakePlugin({ replies: ['x'] });
    const handle = await loadOne(plugin);

    await plugin.generate({ handle, prompt: 'alpha beta gamma', requestId: 'c4' });
    const result = await plugin.generate({ handle, prompt: 'alpha beta delta', requestId: 'c5' });

    // "alpha " and "beta " are shared; "delta" is not.
    expect(result.cachedTokens).toBe(2);
  });

  it('never claims the whole prompt, so there is always a token to sample from', async () => {
    const { plugin, engine } = fakePlugin({ replies: [''] });
    const handle = await loadOne(plugin);

    const prompt = 'alpha beta gamma';
    await plugin.generate({ handle, prompt, requestId: 'c6' });
    const result = await plugin.generate({ handle, prompt, requestId: 'c7' });

    expect(result.cachedTokens).toBe(2);
    // The final prompt token is re-evaluated rather than reused, which is what
    // produces the logits for the first sample.
    const sequence = engine.models[0]?.contexts[0]?.sequences[0];
    expect(sequence?.evaluated.at(-1)).toHaveLength(1);
  });
});

/* ── Handles ──────────────────────────────────────────────────────────── */

describe('handle lifecycle', () => {
  it('listLoaded reflects load and unload', async () => {
    const { plugin } = fakePlugin();

    expect(await plugin.listLoaded()).toEqual({ handles: [] });

    const first = await loadOne(plugin);
    const second = await loadOne(plugin, { modelPath: '/models/other.gguf' });
    expect((await plugin.listLoaded()).handles).toEqual([first, second]);

    await plugin.unload({ handle: first });
    expect((await plugin.listLoaded()).handles).toEqual([second]);

    await plugin.unload({ handle: second });
    expect((await plugin.listLoaded()).handles).toEqual([]);
  });

  it('unloading a handle that does not exist is a no-op', async () => {
    const { plugin } = fakePlugin();
    await expect(plugin.unload({ handle: 'never-loaded' })).resolves.toBeUndefined();
    expect((await plugin.listLoaded()).handles).toEqual([]);
  });

  it('unload releases the sequence, the context and the model', async () => {
    const { plugin, engine } = fakePlugin();
    const handle = await loadOne(plugin);
    const model = engine.models[0];
    const context = model?.contexts[0];

    await plugin.unload({ handle });

    expect(context?.sequences[0]?.disposed).toBe(true);
    expect(context?.disposed).toBe(true);
    expect(model?.disposed).toBe(true);
  });

  it('a handle is unusable once unloaded', async () => {
    const { plugin } = fakePlugin();
    const handle = await loadOne(plugin);
    await plugin.unload({ handle });

    await expect(plugin.tokenize({ handle, text: 'x' })).rejects.toThrow(/No model is loaded/);
  });
});

describe('cancel', () => {
  it('is a no-op for a requestId that is not running', async () => {
    const { plugin } = fakePlugin();
    await expect(plugin.cancel({ requestId: 'never-started' })).resolves.toBeUndefined();
  });

  it('lands while the KV cache is being aligned', async () => {
    // Aligning a long conversation's cache is the one slow await before any
    // token is sampled. A cancel arriving there must not be followed by a
    // generation.
    const script: FakeScript = { replies: ['unreachable'] };
    const { plugin } = fakePlugin(script);
    const tokens = recordTokens(plugin);
    const ends = recordEnds(plugin);
    const handle = await loadOne(plugin);

    script.onAdaptState = (): void => void plugin.cancel({ requestId: 'mid' });
    const result = await plugin.generate({ handle, prompt: 'hi there', requestId: 'mid' });

    expect(result.stopReason).toBe('cancelled');
    expect(tokens).toHaveLength(0);
    expect(ends).toHaveLength(1);
  });

  it('does not carry over to the next use of the same requestId', async () => {
    // A requestId is the turn's id and the app reuses it on a retry, so
    // `generate` clears the flag. That is deliberate: the alternative is a
    // cancel from an abandoned attempt silently killing the replacement.
    const { plugin } = fakePlugin({ replies: ['fine'] });
    const handle = await loadOne(plugin);

    await plugin.cancel({ requestId: 'x' });
    const first = await plugin.generate({ handle, prompt: 'hi', requestId: 'x' });
    const second = await plugin.generate({ handle, prompt: 'hi', requestId: 'x' });

    expect(first.stopReason).toBe('stop');
    expect(second.stopReason).toBe('stop');
  });
});

/* ── Load ─────────────────────────────────────────────────────────────── */

describe('load', () => {
  it('reports the backend the engine actually resolved to', async () => {
    const { plugin, engine } = fakePlugin({ gpu: 'metal' });
    const result = await plugin.load({ modelPath: '/m.gguf', backend: 'gpu-metal' });

    expect(engine.requestedGpu).toBe('metal');
    expect(result.backend).toBe('gpu-metal');
    expect(result.warnings).toEqual([]);
  });

  it('warns rather than fails when the requested backend is not what it got', async () => {
    const { plugin } = fakePlugin({ gpu: false });
    const result = await plugin.load({ modelPath: '/m.gguf', backend: 'gpu-cuda' });

    expect(result.backend).toBe('cpu');
    expect(result.warnings.join(' ')).toMatch(/Requested gpu-cuda/);
  });

  it('degrades a mobile-only backend request to whatever the engine picks', async () => {
    const { plugin, engine } = fakePlugin({ gpu: false });
    const result = await plugin.load({ modelPath: '/m.gguf', backend: 'npu-hexagon' });

    expect(engine.requestedGpu).toBe('auto');
    expect(result.warnings.join(' ')).toMatch(/no npu-hexagon build/);
  });

  it('says images are unavailable instead of accepting a projector it cannot use', async () => {
    const { plugin } = fakePlugin();
    const result = await plugin.load({ modelPath: '/m.gguf', mmprojPath: '/mmproj.gguf' });

    expect(result.supportsVision).toBe(false);
    expect(result.warnings.join(' ')).toMatch(/mtmd projector/);
  });

  it('clamps a context longer than the model was trained for', async () => {
    const { plugin, engine } = fakePlugin({ trainContextSize: 4096 });
    const result = await plugin.load({ modelPath: '/m.gguf', contextLength: 32_768 });

    expect(engine.models[0]?.contextRequests).toEqual([4096]);
    expect(result.contextLength).toBe(4096);
    expect(result.warnings.join(' ')).toMatch(/trained for 4096 tokens/);
  });

  it('falls back to an engine-chosen context when the requested one will not fit', async () => {
    const { plugin, engine } = fakePlugin({ refuseContextSize: true, contextSize: 2048 });
    const result = await plugin.load({ modelPath: '/m.gguf', contextLength: 8192 });

    expect(engine.models[0]?.contextRequests).toEqual([8192, undefined]);
    expect(result.contextLength).toBe(2048);
    expect(result.warnings.join(' ')).toMatch(/would not fit/);
  });

  it('turns off speculative decoding rather than failing when the draft will not load', async () => {
    const { plugin, engine } = fakePlugin({ failingModelPaths: ['/draft.gguf'] });
    const result = await plugin.load({ modelPath: '/m.gguf', draftModelPath: '/draft.gguf' });

    expect(result.handle).toBeTruthy();
    expect(result.warnings.join(' ')).toMatch(/Speculative decoding is off/);
    expect(engine.models[0]?.contexts[0]?.drafts).toEqual([undefined]);
  });

  it('wires the draft sequence in when it does load', async () => {
    const { plugin, engine } = fakePlugin();
    await plugin.load({ modelPath: '/m.gguf', draftModelPath: '/draft.gguf' });

    expect(engine.models).toHaveLength(2);
    expect(engine.models[0]?.contexts[0]?.drafts[0]).toBeDefined();
  });

  it('prefers the template name the GGUF resolved to over the caller override', async () => {
    const { plugin } = fakePlugin({ chatTemplateName: 'gemma' });
    const result = await plugin.load({ modelPath: '/m.gguf', chatTemplate: 'chatml' });
    expect(result.chatTemplate).toBe('gemma');
  });

  it('falls back to the override when the GGUF names no template', async () => {
    const { plugin } = fakePlugin({ chatTemplateName: null });
    const result = await plugin.load({ modelPath: '/m.gguf', chatTemplate: 'chatml' });
    expect(result.chatTemplate).toBe('chatml');
  });

  it('does not cache a failed engine', async () => {
    const createEngine = vi
      .fn<() => Promise<LlamaEngine>>()
      .mockRejectedValueOnce(new Error('no binary'))
      .mockResolvedValue(new FakeEngine({}));
    const plugin = new LlamaCppNode({ createEngine });

    await expect(plugin.load({ modelPath: '/m.gguf' })).rejects.toThrow('no binary');
    await expect(plugin.load({ modelPath: '/m.gguf' })).resolves.toBeDefined();
    expect(createEngine).toHaveBeenCalledTimes(2);
  });
});

/* ── Device probe ─────────────────────────────────────────────────────── */

describe('getCapabilities', () => {
  it('is never simulated, and reports what the engine resolved', async () => {
    const { plugin } = fakePlugin({ gpu: 'cuda', gpuTypes: ['cuda', 'vulkan'] });
    const capabilities = await plugin.getCapabilities();

    expect(capabilities.simulated).toBe(false);
    expect(capabilities.preferredBackend).toBe('gpu-cuda');
    expect(capabilities.backends).toEqual(['cpu', 'gpu-cuda', 'gpu-vulkan']);
    expect(capabilities.engineVersion).toBe('llama.cpp b-fake');
    expect(capabilities.totalMemory).toBeGreaterThan(0);
    expect(capabilities.cpuCores).toBeGreaterThan(0);
    expect(capabilities.chipset).not.toBe('');
  });

  it('takes availableMemory from the pool a model would load into', async () => {
    // Not `os.freemem()`: on a 32 GB Mac that reports a few hundred MB, which
    // would trip the app's 220 MB fallback floor and move a turn off-device
    // for no reason.
    const { plugin } = fakePlugin({ gpu: 'metal', memory: { free: 26e9, total: 34e9 } });
    const capabilities = await plugin.getCapabilities();
    expect(capabilities.availableMemory).toBe(26e9);
  });

  it('falls back to the OS figure when the engine reports no device memory', async () => {
    const { plugin } = fakePlugin({ gpu: false, memory: { free: 0, total: 0 } });
    const capabilities = await plugin.getCapabilities();
    expect(capabilities.availableMemory).toBeGreaterThan(0);
  });

  it('reports CPU and says why when the engine will not start', async () => {
    const plugin = new LlamaCppNode({
      createEngine: async () => {
        throw new Error('no prebuilt binary for this platform');
      },
    });
    const capabilities = await plugin.getCapabilities();

    expect(capabilities.backends).toEqual(['cpu']);
    expect(capabilities.preferredBackend).toBe('cpu');
    expect(capabilities.engineVersion).toMatch(/unavailable: no prebuilt binary/);
    // Still not simulated: nothing is pretending to generate text.
    expect(capabilities.simulated).toBe(false);
  });

  it('maps every GPU identifier the engine can report', () => {
    expect(backendForGpu('metal')).toBe('gpu-metal');
    expect(backendForGpu('cuda')).toBe('gpu-cuda');
    expect(backendForGpu('vulkan')).toBe('gpu-vulkan');
    expect(backendForGpu(false)).toBe('cpu');
  });

  it('reports the documented thermal constant', async () => {
    const { plugin } = fakePlugin();
    expect(await plugin.getThermalState()).toEqual({
      level: 0,
      state: 'nominal',
      throttled: false,
    });
  });
});

/* ── Tokenisation ─────────────────────────────────────────────────────── */

describe('tokenize and countTokens', () => {
  it('agree with each other', async () => {
    const { plugin } = fakePlugin();
    const handle = await loadOne(plugin);
    const text = 'the quick brown fox jumps';

    const { tokens } = await plugin.tokenize({ handle, text });
    const { count } = await plugin.countTokens({ handle, text });

    expect(tokens).toHaveLength(5);
    expect(count).toBe(tokens.length);
  });

  it('reject an unknown handle rather than returning an empty count', async () => {
    const { plugin } = fakePlugin();
    await expect(plugin.tokenize({ handle: 'nope', text: 'x' })).rejects.toThrow();
    await expect(plugin.countTokens({ handle: 'nope', text: 'x' })).rejects.toThrow();
  });
});

/* ── Streaming and stop conditions ────────────────────────────────────── */

describe('generate', () => {
  it('emits one llamaToken per token, indexed in order', async () => {
    const { plugin } = fakePlugin({ replies: ['one two three'] });
    const tokens = recordTokens(plugin);
    const handle = await loadOne(plugin);

    const result = await plugin.generate({ handle, prompt: 'hi', requestId: 's1' });

    expect(tokens.map((event) => event.index)).toEqual([0, 1, 2]);
    expect(tokens.map((event) => event.token).join('')).toBe('one two three');
    expect(result.completionTokens).toBe(3);
    // The assembled text has to agree with the deltas that preceded it.
    expect(result.text).toBe(tokens.map((event) => event.token).join(''));
  });

  it('stops at maxTokens and says so', async () => {
    const { plugin } = fakePlugin({ replies: ['one two three four five'] });
    const handle = await loadOne(plugin);

    const result = await plugin.generate({
      handle,
      prompt: 'hi',
      requestId: 's2',
      sampler: { maxTokens: 2 },
    });

    expect(result.stopReason).toBe('length');
    expect(result.completionTokens).toBe(2);
  });

  it('trims a stop sequence off the result', async () => {
    const { plugin } = fakePlugin({ replies: ['hello END trailing'] });
    const handle = await loadOne(plugin);

    const result = await plugin.generate({
      handle,
      prompt: 'hi',
      requestId: 's3',
      sampler: { stopSequences: ['END '] },
    });

    expect(result.stopReason).toBe('stop-sequence');
    expect(result.text).toBe('hello ');
  });

  it('ignores an empty stop sequence rather than stopping immediately', async () => {
    const { plugin } = fakePlugin({ replies: ['hello there'] });
    const handle = await loadOne(plugin);

    const result = await plugin.generate({
      handle,
      prompt: 'hi',
      requestId: 's4',
      sampler: { stopSequences: [''] },
    });

    expect(result.stopReason).toBe('stop');
    expect(result.text).toBe('hello there');
  });

  it('returns immediately for an empty prompt', async () => {
    const { plugin } = fakePlugin({ replies: ['unused'] });
    const ends = recordEnds(plugin);
    const handle = await loadOne(plugin);

    const result = await plugin.generate({ handle, prompt: '', requestId: 's5' });

    expect(result.promptTokens).toBe(0);
    expect(result.completionTokens).toBe(0);
    expect(ends).toHaveLength(1);
  });

  it('reports draftAcceptance only when a draft model is loaded', async () => {
    const { plugin } = fakePlugin({ replies: ['a'] });
    const plain = await loadOne(plugin);
    const withDraft = await loadOne(plugin, { draftModelPath: '/draft.gguf' });

    const withoutDraft = await plugin.generate({ handle: plain, prompt: 'hi', requestId: 'd1' });
    const drafted = await plugin.generate({ handle: withDraft, prompt: 'hi', requestId: 'd2' });

    expect(withoutDraft.draftAcceptance).toBeUndefined();
    expect(drafted.draftAcceptance).toBe(0);
  });
});

describe('listeners', () => {
  it('stop firing once removed', async () => {
    const { plugin } = fakePlugin({ replies: ['a b'] });
    const seen: TokenEvent[] = [];
    const listener = await plugin.addListener('llamaToken', (event) => seen.push(event));
    const handle = await loadOne(plugin);

    await listener.remove();
    await plugin.generate({ handle, prompt: 'hi', requestId: 'l1' });

    expect(seen).toEqual([]);
  });

  it('removeAllListeners clears every channel', async () => {
    const { plugin } = fakePlugin({ replies: ['a b'] });
    const tokens = recordTokens(plugin);
    const ends = recordEnds(plugin);
    const handle = await loadOne(plugin);

    await plugin.removeAllListeners();
    await plugin.generate({ handle, prompt: 'hi', requestId: 'l2' });

    expect(tokens).toEqual([]);
    expect(ends).toEqual([]);
  });
});

/* ── Benchmark ────────────────────────────────────────────────────────── */

describe('benchmark', () => {
  it('measures prefill and decode separately, once per repetition', async () => {
    const { plugin, engine } = fakePlugin({ replies: ['a b c d e f g h'] });
    const handle = await loadOne(plugin);

    const result = await plugin.benchmark({
      handle,
      promptTokens: 20,
      generateTokens: 4,
      repetitions: 2,
    });

    const sequence = engine.models[0]?.contexts[0]?.sequences[0];
    // Prefill goes through the no-sampling path; decode is seeded by the one
    // token held back from it.
    expect(sequence?.prefilled).toHaveLength(2);
    expect(sequence?.prefilled[0]).toHaveLength(19);
    expect(sequence?.evaluated.every((batch) => batch.length === 1)).toBe(true);

    expect(result.repetitions).toBe(2);
    expect(result.samples).toHaveLength(2);
    expect(result.promptTokensPerSecond).toBeGreaterThan(0);
    expect(result.generateTokensPerSecond).toBeGreaterThan(0);
    expect(result.backend).toBe('cpu');
    expect(result.thermalBefore).toEqual(result.thermalAfter);
  });

  it('leaves no synthetic filler in the cache for the next turn', async () => {
    const { plugin, engine } = fakePlugin({ replies: ['x'] });
    const handle = await loadOne(plugin);

    await plugin.benchmark({ handle, promptTokens: 10, generateTokens: 1, repetitions: 1 });

    expect(engine.models[0]?.contexts[0]?.sequences[0]?.state).toEqual([]);

    // And the next generation therefore starts cold rather than matching a
    // prefix of the benchmark's filler.
    const result = await plugin.generate({ handle, prompt: 'the quick', requestId: 'b1' });
    expect(result.cachedTokens).toBe(0);
  });

  it('rejects an unknown handle', async () => {
    const { plugin } = fakePlugin();
    await expect(plugin.benchmark({ handle: 'nope' })).rejects.toThrow(/No model is loaded/);
  });
});

/* ── Shutdown ─────────────────────────────────────────────────────────── */

describe('dispose', () => {
  it('releases every handle and the engine', async () => {
    const { plugin, engine } = fakePlugin();
    await loadOne(plugin);
    await loadOne(plugin, { modelPath: '/models/two.gguf' });

    await plugin.dispose();

    expect((await plugin.listLoaded()).handles).toEqual([]);
    expect(engine.models.every((model) => model.disposed)).toBe(true);
    expect(engine.disposed).toBe(true);
  });
});
