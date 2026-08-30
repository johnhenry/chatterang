/**
 * The slice of an inference engine the plugin actually uses.
 *
 * `LlamaCppNode` is a contract translator: it turns `LlamaCppPlugin` calls into
 * engine calls and engine output into contract shapes. Almost none of that
 * work needs a real model, and requiring one to test it would mean the
 * behaviours most likely to regress — the terminal-event rule, the handle map,
 * the cache-reuse arithmetic — are the ones nobody can run.
 *
 * So the engine is an interface, narrow enough that a fake implementing it is
 * a few dozen lines, and `node-llama-cpp` is bound to it in exactly one file
 * (`node-llama-cpp.ts`). Nothing else in this package imports that dependency,
 * which is also why the tests run in a jsdom worker without loading a native
 * binding.
 *
 * The shapes here follow node-llama-cpp's own vocabulary rather than
 * inventing a second one — a wrapper that renames everything is a wrapper you
 * have to read twice.
 */

/**
 * A token id.
 *
 * node-llama-cpp brands its `Token` type nominally; the cast back and forth
 * lives in `node-llama-cpp.ts` and nowhere else.
 */
export type LlamaTokenId = number;

/** GPU backends node-llama-cpp builds binaries for. `false` means CPU only. */
export type LlamaGpu = 'metal' | 'cuda' | 'vulkan' | false;

export interface LlamaSamplingOptions {
  temperature?: number;
  topK?: number;
  topP?: number;
  minP?: number;
  seed?: number;
  repeatPenalty?: {
    /** Called per step so the penalty window follows the growing context. */
    punishTokens: () => LlamaTokenId[];
    maxPunishTokens?: number;
    penalty?: number;
    frequencyPenalty?: number;
    presencePenalty?: number;
  };
}

export interface LlamaEngineSequence {
  /** Number of tokens currently held in this sequence's KV cache. */
  readonly nextTokenIndex: number;

  /**
   * Speculative-decoding statistics, when the sequence was created with a
   * draft. `validated + refuted` is the number of proposals that were checked.
   */
  readonly tokenPredictions: { validated: number; refuted: number };

  /**
   * Index of the first token where the cached state and `tokens` diverge —
   * i.e. the length of the reusable prefix. Cheap; does not mutate state.
   */
  compareContextTokens(tokens: LlamaTokenId[]): { firstDifferentIndex: number };

  /**
   * Truncate the cached state to the prefix it shares with `tokens`.
   *
   * `allowShift` lets the engine relocate tokens to align a non-prefix match,
   * which costs re-evaluation; the plugin passes `false` so the state after
   * this call is exactly the shared prefix and `nextTokenIndex` is its length.
   */
  adaptStateToTokens(tokens: LlamaTokenId[], allowShift?: boolean): Promise<void>;

  clearHistory(): Promise<void>;

  /** Append `tokens`, then yield sampled tokens until stopped or EOG. */
  evaluate(tokens: LlamaTokenId[], options?: LlamaSamplingOptions): AsyncIterable<LlamaTokenId>;

  /** Prefill only: append `tokens` without sampling anything. */
  evaluateWithoutGeneratingNewTokens(tokens: LlamaTokenId[]): Promise<void>;

  dispose(): Promise<void>;
}

export interface LlamaEngineContext {
  readonly contextSize: number;
  /**
   * `draft` is a sequence from a smaller model; passing it turns on
   * speculative decoding for this sequence.
   */
  getSequence(options?: { draft?: LlamaEngineSequence }): LlamaEngineSequence;
  dispose(): Promise<void>;
}

export interface LlamaEngineModel {
  /** Context length the weights were trained for. */
  readonly trainContextSize: number;
  /** Chat template name resolved from the GGUF metadata, when there is one. */
  readonly chatTemplateName: string | null;
  tokenize(text: string, specialTokens?: boolean): LlamaTokenId[];
  /**
   * `lastTokens` is the text that precedes these tokens; the detokenizer needs
   * it to decide about leading spaces and to continue a multi-byte character.
   */
  detokenize(
    tokens: readonly LlamaTokenId[],
    specialTokens?: boolean,
    lastTokens?: readonly LlamaTokenId[],
  ): string;
  createContext(options?: {
    contextSize?: number;
    threads?: number;
  }): Promise<LlamaEngineContext>;
  dispose(): Promise<void>;
}

export interface LlamaEngineModelOptions {
  modelPath: string;
  /** `'max'` offloads every layer the backend allows; `'auto'` lets it decide. */
  gpuLayers?: number | 'auto' | 'max';
  useMmap?: boolean;
}

export interface LlamaEngine {
  /** The backend the loaded binary actually resolved to. */
  readonly gpu: LlamaGpu;
  /** Engine build string, e.g. `"llama.cpp b4321"`. */
  readonly engineVersion: string;
  /** GPU backends this machine has the drivers and binaries for. */
  listGpuTypes(): Promise<LlamaGpu[]>;
  /**
   * Memory the engine itself would allocate a model into.
   *
   * On a unified-memory machine this is the whole system pool; on a discrete
   * GPU it is that card's VRAM. Both are `0` when there is no GPU at all.
   */
  getMemoryState(): Promise<{ free: number; total: number }>;
  loadModel(options: LlamaEngineModelOptions): Promise<LlamaEngineModel>;
  dispose(): Promise<void>;
}

/**
 * Creates the engine.
 *
 * `gpu` is a *request*: the binary resolves one backend for the whole process,
 * so the engine reports through `LlamaEngine.gpu` what it settled on, and the
 * plugin turns any disagreement into a load warning rather than a failure.
 */
export type LlamaEngineFactory = (options: { gpu: LlamaGpu | 'auto' }) => Promise<LlamaEngine>;
