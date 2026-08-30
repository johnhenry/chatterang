/**
 * The one file that knows `node-llama-cpp` exists.
 *
 * Everything else in this package talks to the `LlamaEngine` interface, so
 * this is where the dependency, its nominal `Token` brand, and its class
 * hierarchy are converted into the plain shapes the plugin uses.
 *
 * The import is dynamic on purpose. `node-llama-cpp` loads a native binding at
 * import time; making that happen only when an engine is actually requested
 * keeps the package importable from a browser-ish test environment and keeps
 * the cost off the path of anyone who only wanted the types.
 */

import type {
  DraftSequenceTokenPredictor as DraftPredictorClass,
  LlamaContext,
  LlamaContextSequence,
  LlamaModel,
  Token,
} from 'node-llama-cpp';

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

/**
 * Recovers the real sequence behind a wrapper.
 *
 * Speculative decoding needs a `LlamaContextSequence` from the draft model,
 * but the plugin only ever holds the wrapper. A WeakMap keeps the association
 * without putting an escape hatch on the public interface.
 */
const realSequences = new WeakMap<LlamaEngineSequence, LlamaContextSequence>();

function wrapSequence(sequence: LlamaContextSequence): LlamaEngineSequence {
  const wrapper: LlamaEngineSequence = {
    get nextTokenIndex() {
      return sequence.nextTokenIndex;
    },
    get tokenPredictions() {
      const { validated, refuted } = sequence.tokenPredictions;
      return { validated, refuted };
    },
    compareContextTokens: (tokens: LlamaTokenId[]) =>
      sequence.compareContextTokens(tokens as Token[]),
    adaptStateToTokens: (tokens: LlamaTokenId[], allowShift?: boolean) =>
      sequence.adaptStateToTokens(tokens as Token[], allowShift),
    clearHistory: () => sequence.clearHistory(),
    evaluate: (tokens: LlamaTokenId[], options?: LlamaSamplingOptions) =>
      sequence.evaluate(tokens as Token[], {
        ...options,
        repeatPenalty: options?.repeatPenalty
          ? {
              ...options.repeatPenalty,
              punishTokens: () => options.repeatPenalty!.punishTokens() as Token[],
            }
          : undefined,
      }),
    evaluateWithoutGeneratingNewTokens: (tokens: LlamaTokenId[]) =>
      sequence.evaluateWithoutGeneratingNewTokens(tokens as Token[]),
    dispose: () => sequence.dispose(),
  };
  realSequences.set(wrapper, sequence);
  return wrapper;
}

function wrapContext(
  context: LlamaContext,
  DraftPredictor: typeof DraftPredictorClass,
): LlamaEngineContext {
  return {
    get contextSize() {
      return context.contextSize;
    },
    getSequence: (options) => {
      const draft = options?.draft ? realSequences.get(options.draft) : undefined;
      return wrapSequence(
        context.getSequence(draft ? { tokenPredictor: new DraftPredictor(draft) } : undefined),
      );
    },
    dispose: () => context.dispose(),
  };
}

function wrapModel(
  model: LlamaModel,
  chatTemplateName: string | null,
  DraftPredictor: typeof DraftPredictorClass,
): LlamaEngineModel {
  return {
    get trainContextSize() {
      return model.trainContextSize;
    },
    chatTemplateName,
    tokenize: (text: string, specialTokens?: boolean) => model.tokenize(text, specialTokens),
    detokenize: (
      tokens: readonly LlamaTokenId[],
      specialTokens?: boolean,
      lastTokens?: readonly LlamaTokenId[],
    ) => model.detokenize(tokens as readonly Token[], specialTokens, lastTokens as readonly Token[]),
    createContext: async (options) =>
      wrapContext(
        await model.createContext({
          contextSize: options?.contextSize ?? 'auto',
          ...(options?.threads === undefined ? {} : { threads: options.threads }),
        }),
        DraftPredictor,
      ),
    dispose: () => model.dispose(),
  };
}

/**
 * Builds an engine backed by the real `node-llama-cpp`.
 *
 * This is the default factory `LlamaCppNode` uses; tests pass their own.
 */
export const createNodeLlamaCppEngine: LlamaEngineFactory = async ({ gpu }): Promise<LlamaEngine> => {
  const { getLlama, getLlamaGpuTypes, resolveChatWrapper, DraftSequenceTokenPredictor } =
    await import('node-llama-cpp');

  const llama = await getLlama({ gpu });

  return {
    get gpu(): LlamaGpu {
      return llama.gpu;
    },
    engineVersion: `llama.cpp ${llama.llamaCppRelease.release}`,
    listGpuTypes: () => getLlamaGpuTypes('supported'),
    getMemoryState: async () => {
      const { free, total } = await llama.getVramState();
      return { free, total };
    },
    loadModel: async (options) => {
      const model = await llama.loadModel({
        modelPath: options.modelPath,
        gpuLayers: options.gpuLayers ?? 'auto',
        ...(options.useMmap === undefined ? {} : { useMmap: options.useMmap }),
      });

      // The name of the template, not the template itself: the app renders
      // prompts on the JS side, so this is reported for display and for the
      // "does the GGUF disagree with the manifest" check, not used to format.
      let chatTemplateName: string | null = null;
      try {
        chatTemplateName = resolveChatWrapper(model).wrapperName;
      } catch {
        chatTemplateName = null;
      }

      return wrapModel(model, chatTemplateName, DraftSequenceTokenPredictor);
    },
    dispose: () => llama.dispose(),
  };
};
