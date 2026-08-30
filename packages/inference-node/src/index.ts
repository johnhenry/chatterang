/**
 * Node implementations of the Chatterang plugin contracts.
 *
 * `LlamaCppNode` satisfies `LlamaCppPlugin` from `@chatterang/contracts` —
 * the same contract the web shim and the iOS/Android bridges implement — over
 * `node-llama-cpp`. Nothing here imports that dependency at module scope: the
 * engine is built on first use behind `createNodeLlamaCppEngine`, so importing
 * this package never loads a native binding.
 */

export { LlamaCppNode, backendForGpu } from './llama-cpp.js';
export type { LlamaCppNodeOptions } from './llama-cpp.js';
export { createNodeLlamaCppEngine } from './node-llama-cpp.js';
export { readThermalState } from './thermal.js';
export type {
  LlamaEngine,
  LlamaEngineContext,
  LlamaEngineFactory,
  LlamaEngineModel,
  LlamaEngineModelOptions,
  LlamaEngineSequence,
  LlamaGpu,
  LlamaSamplingOptions,
  LlamaTokenId,
} from './engine.js';
