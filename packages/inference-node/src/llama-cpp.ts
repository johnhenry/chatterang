/**
 * Node implementation of `plugin-llama-cpp`, over `node-llama-cpp`.
 *
 * This is the first implementation of the contract that actually runs a model.
 * The web shim synthesises text and says `simulated: true`; the iOS and
 * Android bridges have never been compiled. So the numbers this file reports
 * are the first real ones, and the places where it has to say "not available"
 * are worth reading as findings rather than as omissions:
 *
 *  - **`cachedTokens` is real here.** `compareContextTokens` gives the exact
 *    reused-prefix boundary, which is the thing the field was added to expose.
 *    The shim returns 0 and documents why faking it would hide a regression;
 *    on Node there is nothing to fake.
 *  - **`getThermalState()` is a documented constant** — see `thermal.ts`.
 *  - **Vision is unavailable.** node-llama-cpp 3.x has no `mtmd` binding, so a
 *    load that supplies `mmprojPath` reports `supportsVision: false` and says
 *    so in `warnings` rather than accepting images it would silently drop.
 *
 * `simulated` is `false`: a real engine either runs or the load fails.
 *
 * The engine reaches this class through the `LlamaEngine` interface rather
 * than by import, which is what makes the contract translation testable
 * without a 2 GB GGUF on the machine running `npm test`.
 */

import { arch, availableParallelism, cpus, freemem, platform, totalmem } from 'node:os';

import type {
  BenchmarkOptions,
  BenchmarkResult,
  ComputeBackendId,
  DeviceCapabilities,
  GenerateOptions,
  GenerateResult,
  GenerationEndEvent,
  ListenerHandle,
  LlamaCppPlugin,
  LoadOptions,
  LoadResult,
  ThermalState,
  TokenEvent,
} from '@chatterang/contracts';

import type {
  LlamaEngine,
  LlamaEngineContext,
  LlamaEngineFactory,
  LlamaEngineModel,
  LlamaEngineSequence,
  LlamaGpu,
  LlamaSamplingOptions,
  LlamaTokenId,
} from './engine.js';
import { createNodeLlamaCppEngine } from './node-llama-cpp.js';
import { readThermalState } from './thermal.js';

/** Sampler defaults, matching `LlamaContext.Sampler` on iOS token for token. */
const SAMPLER_DEFAULTS = {
  temperature: 0.7,
  topP: 0.95,
  topK: 40,
  minP: 0.05,
  repeatPenalty: 1.1,
  repeatLastN: 64,
  frequencyPenalty: 0,
  presencePenalty: 0,
  maxTokens: 1024,
} as const;

const BENCHMARK_DEFAULTS = { promptTokens: 512, generateTokens: 128, repetitions: 3 } as const;

interface LoadedDraft {
  model: LlamaEngineModel;
  context: LlamaEngineContext;
  sequence: LlamaEngineSequence;
}

interface LoadedHandle {
  model: LlamaEngineModel;
  context: LlamaEngineContext;
  sequence: LlamaEngineSequence;
  draft: LoadedDraft | null;
  backend: ComputeBackendId;
}

interface LlamaEventMap {
  llamaToken: TokenEvent;
  llamaEnd: GenerationEndEvent;
  llamaThermal: ThermalState;
}

export interface LlamaCppNodeOptions {
  /**
   * How to build the engine. Defaults to the real `node-llama-cpp`; tests pass
   * a fake so the contract translation can be exercised without a model file.
   */
  createEngine?: LlamaEngineFactory;
}

/** node-llama-cpp's GPU identifier → the contract's backend id. */
export function backendForGpu(gpu: LlamaGpu): ComputeBackendId {
  switch (gpu) {
    case 'metal':
      return 'gpu-metal';
    case 'cuda':
      return 'gpu-cuda';
    case 'vulkan':
      return 'gpu-vulkan';
    default:
      return 'cpu';
  }
}

/**
 * The contract's backend id → a GPU request, plus a warning when the request
 * names something no node-llama-cpp binary provides.
 *
 * `gpu-opencl` and `npu-hexagon` are mobile backends. Asking for one on a
 * desktop is not an error — it is a manifest written for a phone — so the
 * request degrades to `'auto'` and the user is told what happened.
 */
function gpuRequestFor(backend: ComputeBackendId | undefined): {
  gpu: LlamaGpu | 'auto';
  warning: string | null;
} {
  switch (backend) {
    case undefined:
      return { gpu: 'auto', warning: null };
    case 'cpu':
      return { gpu: false, warning: null };
    case 'gpu-metal':
      return { gpu: 'metal', warning: null };
    case 'gpu-cuda':
      return { gpu: 'cuda', warning: null };
    case 'gpu-vulkan':
      return { gpu: 'vulkan', warning: null };
    default:
      return {
        gpu: 'auto',
        warning: `There is no ${backend} build of llama.cpp for this platform; the engine chose a backend itself.`,
      };
  }
}

/** `-1` means "everything the backend allows", which node-llama-cpp calls `max`. */
function gpuLayersFor(layers: number | undefined): number | 'auto' | 'max' {
  if (layers === undefined) return 'auto';
  return layers < 0 ? 'max' : layers;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class LlamaCppNode implements LlamaCppPlugin {
  readonly #createEngine: LlamaEngineFactory;
  #engine: Promise<LlamaEngine> | null = null;
  #handles = new Map<string, LoadedHandle>();
  #cancelled = new Set<string>();
  #counter = 0;

  /**
   * `llamaThermal` is never emitted, and that is the honest behaviour: on Node
   * the thermal state is a documented constant (`thermal.ts`), so there is no
   * change to notify anyone about. The slot exists because the contract
   * declares it and a phone will one day fill it.
   */
  readonly #listeners: { [K in keyof LlamaEventMap]: Set<(event: LlamaEventMap[K]) => void> } = {
    llamaToken: new Set(),
    llamaEnd: new Set(),
    llamaThermal: new Set(),
  };

  constructor(options: LlamaCppNodeOptions = {}) {
    this.#createEngine = options.createEngine ?? createNodeLlamaCppEngine;
  }

  /* ── Events ───────────────────────────────────────────────────────── */

  #emit<K extends keyof LlamaEventMap>(eventName: K, event: LlamaEventMap[K]): void {
    const listeners = this.#listeners[eventName] as Set<(event: LlamaEventMap[K]) => void>;
    // Snapshot: a listener that removes itself must not skip its neighbour.
    for (const listener of [...listeners]) {
      try {
        listener(event);
      } catch {
        // A throwing listener is the listener's problem. Letting it escape
        // here would abort a generation — and, worse, skip the terminal event.
      }
    }
  }

  addListener(
    eventName: 'llamaToken',
    listener: (event: TokenEvent) => void,
  ): Promise<ListenerHandle>;
  addListener(
    eventName: 'llamaEnd',
    listener: (event: GenerationEndEvent) => void,
  ): Promise<ListenerHandle>;
  addListener(
    eventName: 'llamaThermal',
    listener: (event: ThermalState) => void,
  ): Promise<ListenerHandle>;
  async addListener(
    eventName: keyof LlamaEventMap,
    listener: (event: never) => void,
  ): Promise<ListenerHandle> {
    const listeners = this.#listeners[eventName] as Set<unknown>;
    listeners.add(listener);
    return {
      remove: async (): Promise<void> => {
        listeners.delete(listener);
      },
    };
  }

  async removeAllListeners(): Promise<void> {
    for (const listeners of Object.values(this.#listeners)) listeners.clear();
  }

  /* ── Device ───────────────────────────────────────────────────────── */

  async getCapabilities(): Promise<DeviceCapabilities> {
    const base = {
      totalMemory: totalmem(),
      cpuCores: availableParallelism(),
      chipset: cpus()[0]?.model ?? `${platform()} ${arch()}`,
      // Never simulated. On Node a real engine either loads or the call fails;
      // there is no synthesised path for this flag to warn about.
      simulated: false,
    };

    try {
      const engine = await this.#getEngine(undefined, []);
      const preferredBackend = backendForGpu(engine.gpu);
      const backends: ComputeBackendId[] = ['cpu'];
      // What the binary set actually resolved on this machine, not a list of
      // what llama.cpp can be built with.
      for (const gpu of await engine.listGpuTypes()) {
        const id = backendForGpu(gpu);
        if (!backends.includes(id)) backends.push(id);
      }
      if (!backends.includes(preferredBackend)) backends.push(preferredBackend);

      return {
        ...base,
        availableMemory: await this.#availableMemory(engine),
        backends,
        preferredBackend,
        engineVersion: engine.engineVersion,
      };
    } catch (error) {
      // No binary for this platform, or the build failed. Reporting CPU and
      // saying why beats reporting a GPU that is not there.
      return {
        ...base,
        availableMemory: freemem(),
        backends: ['cpu'],
        preferredBackend: 'cpu',
        engineVersion: `node-llama-cpp (unavailable: ${describe(error)})`,
      };
    }
  }

  /**
   * Memory a model can realistically be loaded into.
   *
   * Not `os.freemem()`. On this machine — 32 GB, nothing running — `freemem()`
   * reports 778 MB, because macOS counts reclaimable page cache as used. The
   * app's device-pressure check falls back to a remote provider below 220 MB,
   * so that number is one busy afternoon away from moving turns off-device on
   * a laptop with 30 GB going spare. It is precisely the plausible-looking
   * guess `thermal.ts` refuses to make.
   *
   * The engine's own figure is the honest one: unified memory on a Mac, the
   * card's free VRAM on a discrete GPU — in both cases the pool a model
   * actually lands in. `os.freemem()` remains the fallback for a CPU-only
   * machine, where the engine reports no device memory at all.
   */
  async #availableMemory(engine: LlamaEngine): Promise<number> {
    try {
      const { free } = await engine.getMemoryState();
      return free > 0 ? free : freemem();
    } catch {
      return freemem();
    }
  }

  async getThermalState(): Promise<ThermalState> {
    return readThermalState();
  }

  /* ── Model lifecycle ──────────────────────────────────────────────── */

  /**
   * The engine, built once.
   *
   * node-llama-cpp resolves one backend for the whole process when it loads
   * its binary, so the backend is a property of the engine rather than of a
   * model. The first `load` therefore decides it, and every later load that
   * asks for something else gets a warning instead of a second engine.
   */
  async #getEngine(
    requested: ComputeBackendId | undefined,
    warnings: string[],
  ): Promise<LlamaEngine> {
    if (!this.#engine) {
      const { gpu, warning } = gpuRequestFor(requested);
      if (warning) warnings.push(warning);
      this.#engine = this.#createEngine({ gpu }).catch((error: unknown) => {
        // Do not cache a failure: a missing binary can be installed, and the
        // next call should get a fresh attempt.
        this.#engine = null;
        throw error;
      });
    }
    return this.#engine;
  }

  async load(options: LoadOptions): Promise<LoadResult> {
    const started = performance.now();
    const warnings: string[] = [];

    const engine = await this.#getEngine(options.backend, warnings);
    const backend = backendForGpu(engine.gpu);
    if (options.backend && options.backend !== backend && warnings.length === 0) {
      warnings.push(
        `Requested ${options.backend}, but the engine is running on ${backend}. ` +
          `The compute backend is fixed for the process once the first model loads.`,
      );
    }

    if (options.mmprojPath) {
      warnings.push(
        'Images are not available on this backend: node-llama-cpp has no mtmd projector binding, so the multimodal projector was ignored.',
      );
    }

    const model = await engine.loadModel({
      modelPath: options.modelPath,
      gpuLayers: gpuLayersFor(options.gpuLayers),
      ...(options.useMmap === undefined ? {} : { useMmap: options.useMmap }),
    });

    try {
      let requestedLength = options.contextLength;
      if (requestedLength !== undefined && requestedLength > model.trainContextSize) {
        warnings.push(
          `This model was trained for ${model.trainContextSize} tokens; the requested ${requestedLength}-token context was reduced to that.`,
        );
        requestedLength = model.trainContextSize;
      }

      const context = await this.#createContext(model, requestedLength, options.threads, warnings);
      const draft = await this.#loadDraft(engine, options, context.contextSize, warnings);
      const sequence = context.getSequence(draft ? { draft: draft.sequence } : undefined);

      const handle = `node_${++this.#counter}`;
      const chatTemplate = model.chatTemplateName ?? options.chatTemplate ?? 'unknown';

      this.#handles.set(handle, { model, context, sequence, draft, backend });

      return {
        handle,
        backend,
        contextLength: context.contextSize,
        loadMs: Math.round(performance.now() - started),
        warnings,
        // node-llama-cpp 3.x cannot evaluate images at all, so this is false
        // even when a projector was supplied. The warning above says why.
        supportsVision: false,
        chatTemplate,
      };
    } catch (error) {
      await model.dispose().catch(() => undefined);
      throw error;
    }
  }

  /**
   * A context of the requested size, or the largest the engine will give.
   *
   * `load` must not throw for a recoverable problem — the app shows
   * `warnings` verbatim and carries on — and "this context does not fit in
   * VRAM" is exactly that. Only a second failure with no size constraint at
   * all is treated as fatal.
   */
  async #createContext(
    model: LlamaEngineModel,
    contextSize: number | undefined,
    threads: number | undefined,
    warnings: string[],
  ): Promise<LlamaEngineContext> {
    const threadOption = threads === undefined ? {} : { threads };
    try {
      return await model.createContext({
        ...(contextSize === undefined ? {} : { contextSize }),
        ...threadOption,
      });
    } catch (error) {
      if (contextSize === undefined) throw error;
      warnings.push(
        `A ${contextSize}-token context would not fit (${describe(error)}); using the largest one this machine allows.`,
      );
      return model.createContext(threadOption);
    }
  }

  /**
   * The draft model for speculative decoding, or null.
   *
   * A draft that fails to load is a performance loss, not a correctness one,
   * so it degrades to ordinary decoding with a warning rather than failing the
   * load and leaving the user with no model at all.
   */
  async #loadDraft(
    engine: LlamaEngine,
    options: LoadOptions,
    contextSize: number,
    warnings: string[],
  ): Promise<LoadedDraft | null> {
    if (!options.draftModelPath) return null;
    try {
      const model = await engine.loadModel({
        modelPath: options.draftModelPath,
        gpuLayers: gpuLayersFor(options.gpuLayers),
        ...(options.useMmap === undefined ? {} : { useMmap: options.useMmap }),
      });
      const context = await model.createContext({ contextSize });
      return { model, context, sequence: context.getSequence() };
    } catch (error) {
      warnings.push(
        `Speculative decoding is off: the draft model could not be loaded (${describe(error)}).`,
      );
      return null;
    }
  }

  /** Unloading a handle that is not loaded is a no-op, not an error. */
  async unload({ handle }: { handle: string }): Promise<void> {
    const loaded = this.#handles.get(handle);
    if (!loaded) return;
    this.#handles.delete(handle);
    await this.#dispose(loaded);
  }

  async #dispose(loaded: LoadedHandle): Promise<void> {
    // Innermost first, and each failure swallowed: a half-disposed handle is
    // already gone from the map, so throwing here would only strand the rest.
    const steps = [
      loaded.sequence,
      loaded.context,
      loaded.model,
      ...(loaded.draft ? [loaded.draft.sequence, loaded.draft.context, loaded.draft.model] : []),
    ];
    for (const step of steps) await step.dispose().catch(() => undefined);
  }

  async listLoaded(): Promise<{ handles: string[] }> {
    return { handles: [...this.#handles.keys()] };
  }

  /** Release every handle and the engine itself. Not part of the contract. */
  async dispose(): Promise<void> {
    for (const loaded of [...this.#handles.values()]) await this.#dispose(loaded);
    this.#handles.clear();
    const engine = this.#engine;
    this.#engine = null;
    await engine?.then((it) => it.dispose()).catch(() => undefined);
  }

  /* ── Generation ───────────────────────────────────────────────────── */

  /**
   * Streams `llamaToken` events and always ends with exactly one `llamaEnd`.
   *
   * That rule is the reason this method is shaped the way it is. The adapter's
   * streaming loop waits on the terminal event, so a path that returns or
   * throws without emitting one hangs the UI with no way back. `finish` is
   * idempotent and is called on the success path, in the `catch`, and again in
   * the `finally` — the last as a structural backstop, so a future edit that
   * introduces a fourth exit cannot silently break the guarantee.
   */
  async generate(options: GenerateOptions): Promise<GenerateResult> {
    const started = performance.now();
    const { requestId } = options;
    // A request id is the conversation turn's id, and the app reuses it when a
    // turn is retried. Clearing the flag here — as the web shim and the iOS
    // bridge both do — is what stops a cancel from one attempt killing the
    // next one. The cost is that a cancel arriving before `generate` is
    // called has no effect; the caller is expected to not start the request.
    this.#cancelled.delete(requestId);

    let text = '';
    let index = 0;
    let firstTokenAt = 0;
    let promptTokens = 0;
    let cachedTokens = 0;
    let completionTokens = 0;
    let draftAcceptance: number | undefined;
    let settled = false;

    const build = (stopReason: GenerateResult['stopReason']): GenerateResult => {
      const totalMs = Math.max(1, Math.round(performance.now() - started));
      return {
        requestId,
        text,
        promptTokens,
        cachedTokens,
        completionTokens,
        ttftMs: firstTokenAt ? Math.round(firstTokenAt - started) : totalMs,
        totalMs,
        tokensPerSecond: Number(((completionTokens / totalMs) * 1000).toFixed(2)),
        ...(draftAcceptance === undefined ? {} : { draftAcceptance }),
        stopReason,
        peakMemoryBytes: process.memoryUsage.rss(),
      };
    };

    const finish = (
      stopReason: GenerateResult['stopReason'],
      error?: string,
    ): GenerateResult => {
      const result = build(stopReason);
      if (!settled) {
        settled = true;
        this.#emit('llamaEnd', error === undefined ? result : { ...result, error });
      }
      return result;
    };

    try {
      const loaded = this.#handles.get(options.handle);
      if (!loaded) throw new Error(`No model is loaded for handle "${options.handle}".`);

      const { model, sequence } = loaded;
      const sampler = options.sampler ?? {};
      const maxTokens = sampler.maxTokens ?? SAMPLER_DEFAULTS.maxTokens;

      // `specialTokens: true`: the prompt arrives fully rendered by the app's
      // own template, so its control markers must tokenize as control tokens
      // rather than as their literal text.
      const prompt = model.tokenize(options.prompt, true);
      promptTokens = prompt.length;
      if (prompt.length === 0) return finish('stop');

      // Reuse of the KV cache across turns.
      //
      // A conversation's prompt grows by append, so turn N shares a long
      // prefix with turn N-1. `compareContextTokens` reports exactly where the
      // cached state and this prompt diverge, and that boundary is what
      // `cachedTokens` reports — it is the number that makes a regression in
      // cache reuse visible rather than merely slow.
      //
      // The last prompt token is held back: at least one token has to be
      // evaluated to produce the logits the first sample comes from, so a
      // prompt identical to the cached state still decodes one token. That is
      // also why the reported figure is measured against the held-back prefix
      // — it is the count actually served from cache, not the count that
      // matched.
      const reusable = prompt.slice(0, -1);
      cachedTokens = sequence.compareContextTokens(reusable).firstDifferentIndex;
      // `allowShift: false` keeps the cache a strict prefix of the prompt.
      // Shifting can align more tokens, but it re-evaluates what it moves and
      // makes `nextTokenIndex` stop meaning "tokens reused".
      await sequence.adaptStateToTokens(reusable, false);
      const pending = prompt.slice(sequence.nextTokenIndex);

      // Aligning the cache can take a while on a long conversation. A cancel
      // that lands during it should not then be followed by a generation.
      if (this.#cancelled.has(requestId)) return finish('cancelled');

      // Cumulative over the sequence's lifetime, so the per-request figure is
      // the difference across this call.
      const predictionsBefore = { ...sequence.tokenPredictions };

      // Every token evaluated so far, for the repetition-penalty window and
      // for detokenising each piece in the context of what precedes it.
      const history: LlamaTokenId[] = [...prompt];
      const stopSequences = (sampler.stopSequences ?? []).filter((it) => it.length > 0);

      let stopReason: GenerateResult['stopReason'] = 'stop';

      for await (const token of sequence.evaluate(pending, this.#samplingOptions(sampler, history))) {
        // Checked before the token is published, so a cancelled request never
        // emits a token the caller did not ask for.
        if (this.#cancelled.has(requestId)) {
          stopReason = 'cancelled';
          break;
        }

        const piece = model.detokenize([token], false, history);
        history.push(token);
        completionTokens += 1;
        if (index === 0) firstTokenAt = performance.now();
        text += piece;
        this.#emit('llamaToken', { requestId, token: piece, index });
        index += 1;

        // Checked on the accumulated text rather than per token, because a
        // stop sequence can straddle a token boundary.
        const matched = stopSequences.find((it) => text.endsWith(it));
        if (matched !== undefined) {
          text = text.slice(0, text.length - matched.length);
          stopReason = 'stop-sequence';
          break;
        }

        if (completionTokens >= maxTokens) {
          stopReason = 'length';
          break;
        }
      }

      if (loaded.draft) {
        const after = sequence.tokenPredictions;
        const validated = after.validated - predictionsBefore.validated;
        const checked = validated + (after.refuted - predictionsBefore.refuted);
        draftAcceptance = checked > 0 ? Number((validated / checked).toFixed(4)) : 0;
      }

      return finish(stopReason);
    } catch (error) {
      finish('error', describe(error));
      throw error;
    } finally {
      // Backstop. A no-op on every path above, and the reason a new early
      // return cannot break the terminal-event rule by accident.
      finish('error', 'Generation ended without reporting a result.');
      this.#cancelled.delete(requestId);
    }
  }

  /**
   * The sampler chain, in the same order and with the same defaults as the
   * iOS `makeSamplerChain` — penalties, top-k, top-p, min-p, temperature.
   *
   * `punishTokens` is a callback rather than an array because the penalty
   * window has to follow the context as it grows during the generation.
   */
  #samplingOptions(
    sampler: NonNullable<GenerateOptions['sampler']>,
    history: readonly LlamaTokenId[],
  ): LlamaSamplingOptions {
    const repeatLastN = sampler.repeatLastN ?? SAMPLER_DEFAULTS.repeatLastN;
    return {
      temperature: sampler.temperature ?? SAMPLER_DEFAULTS.temperature,
      topK: sampler.topK ?? SAMPLER_DEFAULTS.topK,
      topP: sampler.topP ?? SAMPLER_DEFAULTS.topP,
      minP: sampler.minP ?? SAMPLER_DEFAULTS.minP,
      // `null` means "different every time", which is the engine's own
      // default when no seed is given.
      ...(sampler.seed === undefined || sampler.seed === null ? {} : { seed: sampler.seed }),
      repeatPenalty: {
        punishTokens: () => history.slice(-repeatLastN),
        maxPunishTokens: repeatLastN,
        penalty: sampler.repeatPenalty ?? SAMPLER_DEFAULTS.repeatPenalty,
        frequencyPenalty: sampler.frequencyPenalty ?? SAMPLER_DEFAULTS.frequencyPenalty,
        presencePenalty: sampler.presencePenalty ?? SAMPLER_DEFAULTS.presencePenalty,
      },
    };
  }

  /** Cancelling a request that is not running is a no-op, not an error. */
  async cancel({ requestId }: { requestId: string }): Promise<void> {
    this.#cancelled.add(requestId);
  }

  /* ── Tokenisation ─────────────────────────────────────────────────── */

  #require(handle: string): LoadedHandle {
    const loaded = this.#handles.get(handle);
    if (!loaded) throw new Error(`No model is loaded for handle "${handle}".`);
    return loaded;
  }

  async tokenize({ handle, text }: { handle: string; text: string }): Promise<{ tokens: number[] }> {
    return { tokens: this.#require(handle).model.tokenize(text, true) };
  }

  /**
   * The contract asks for a count "without materialising the token array".
   * llama.cpp has no such call, so this materialises and discards — the same
   * cost the native bridges pay.
   */
  async countTokens({ handle, text }: { handle: string; text: string }): Promise<{ count: number }> {
    return { count: this.#require(handle).model.tokenize(text, true).length };
  }

  /* ── Benchmark ────────────────────────────────────────────────────── */

  async benchmark(options: BenchmarkOptions): Promise<BenchmarkResult> {
    const loaded = this.#require(options.handle);
    const promptTokens = options.promptTokens ?? BENCHMARK_DEFAULTS.promptTokens;
    const generateTokens = options.generateTokens ?? BENCHMARK_DEFAULTS.generateTokens;
    const repetitions = Math.max(1, options.repetitions ?? BENCHMARK_DEFAULTS.repetitions);

    const thermalBefore = readThermalState();
    const prefillSamples: number[] = [];
    const samples: number[] = [];

    // A synthetic prompt of the requested length: the point is to measure this
    // machine, not this prompt.
    const filler = 'the quick brown fox jumps over the lazy dog. '.repeat(
      Math.max(1, Math.ceil(promptTokens / 9)),
    );
    const tokens = loaded.model.tokenize(filler, false).slice(0, Math.max(2, promptTokens));

    try {
      for (let repetition = 0; repetition < repetitions; repetition += 1) {
        // Cold prefill every time. A warm cache reports a prefill throughput
        // this machine cannot sustain on a fresh prompt, which is the opposite
        // of what a benchmark is for.
        await loaded.sequence.clearHistory();

        const prefill = tokens.slice(0, -1);
        const prefillStart = performance.now();
        await loaded.sequence.evaluateWithoutGeneratingNewTokens(prefill);
        const prefillSeconds = Math.max(0.001, (performance.now() - prefillStart) / 1000);
        prefillSamples.push(prefill.length / prefillSeconds);

        // The final prompt token is evaluated inside the decode timer, because
        // it is what produces the first logits. One token of prefill against
        // `generateTokens` decoded ones.
        const decodeStart = performance.now();
        let produced = 0;
        for await (const _token of loaded.sequence.evaluate(tokens.slice(-1), { temperature: 0 })) {
          produced += 1;
          if (produced >= generateTokens) break;
        }
        const decodeSeconds = Math.max(0.001, (performance.now() - decodeStart) / 1000);
        samples.push(Number((produced / decodeSeconds).toFixed(2)));
      }
    } finally {
      // Leave no synthetic filler behind for the next turn's prefix match.
      await loaded.sequence.clearHistory().catch(() => undefined);
    }

    const mean = (values: number[]): number =>
      values.reduce((total, value) => total + value, 0) / Math.max(1, values.length);

    return {
      promptTokensPerSecond: Number(mean(prefillSamples).toFixed(2)),
      generateTokensPerSecond: Number(mean(samples).toFixed(2)),
      peakMemoryBytes: process.memoryUsage.rss(),
      thermalBefore,
      thermalAfter: readThermalState(),
      backend: loaded.backend,
      repetitions,
      samples,
    };
  }
}
