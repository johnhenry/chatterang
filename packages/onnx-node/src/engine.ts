/**
 * The slice of ONNX Runtime this package actually uses.
 *
 * Same reasoning as `packages/inference-node/src/engine.ts`, and for a sharper
 * reason: `onnxruntime-node` is a 283 MB native binding, and almost none of
 * what `OnnxRuntimeNode` does needs it. The handle map, the double-release
 * rule, the terminal-event guarantee, the execution-provider translation, the
 * refusal to run a graph whose input names disagree with what Whisper looks
 * like — all of that is contract translation, and requiring a 200 MB model
 * file to test it would mean the behaviours most likely to regress are the
 * ones nobody can run.
 *
 * So the engine is an interface, `onnxruntime-node.ts` is the only file that
 * imports the dependency, and the unit suite drives a fake.
 *
 * The vocabulary follows onnxruntime's own — `feeds`, `inputMetadata`,
 * `release` — rather than inventing a second one.
 */

/** onnxruntime's tensor element types, as the strings it uses. */
export type OnnxDataType =
  | 'float32'
  | 'float64'
  | 'float16'
  | 'int64'
  | 'int32'
  | 'int16'
  | 'int8'
  | 'uint8'
  | 'uint16'
  | 'uint32'
  | 'uint64'
  | 'bool'
  | 'string';

/** The typed arrays this package builds tensors out of. */
export type OnnxTensorData = Float32Array | BigInt64Array | Uint8Array;

export interface OnnxTensorLike {
  readonly type: string;
  readonly dims: readonly number[];
  readonly data: OnnxTensorData;
}

/**
 * One declared input or output of a graph.
 *
 * `shape` carries STRINGS for symbolic dimensions — `'batch_size'`,
 * `'encoder_sequence_length'` — which is why anything building a tensor has to
 * substitute them rather than read a number. Feeding whisper-base's encoder a
 * `feature_size` of 1 because the metadata said `'feature_size'` produces
 * `Input channels C is not equal to kernel channels * group. C: 1 kernel
 * channels: 80`, which is the graph telling you it was never asked.
 */
export interface OnnxValueMetadata {
  readonly name: string;
  readonly type: string;
  readonly shape: readonly (number | string)[];
}

export interface OnnxSessionOptionsLike {
  /**
   * Execution providers to try, most preferred first, in onnxruntime's own
   * naming (`'cpu'`, `'coreml'`, `'webgpu'`, …) — NOT the contract's.
   */
  readonly executionProviders?: readonly string[];
  readonly intraOpNumThreads?: number;
}

export interface OnnxGraph {
  readonly inputNames: readonly string[];
  readonly outputNames: readonly string[];
  readonly inputMetadata: readonly OnnxValueMetadata[];
  readonly outputMetadata: readonly OnnxValueMetadata[];
  run(feeds: Record<string, OnnxTensorLike>): Promise<Record<string, OnnxTensorLike>>;
  /**
   * Free the native session.
   *
   * NOT idempotent in onnxruntime — a second call throws `Session already
   * disposed.` — and there is no finalizer, so it must be called exactly once,
   * explicitly. `OnnxRuntimeNode` is what makes "exactly once" true; this
   * interface just says the requirement out loud.
   */
  release(): Promise<void>;
}

export interface OnnxEngine {
  /**
   * Execution providers COMPILED INTO this build, in onnxruntime's naming.
   *
   * Compiled-in, not working: on this machine CoreML is listed and does load,
   * but its MLProgram mode fails outright on Whisper. Which is why
   * `createSession` attempts the requested provider and degrades with a
   * warning rather than trusting this list.
   */
  listExecutionProviders(): readonly string[];
  createSession(modelPath: string, options: OnnxSessionOptionsLike): Promise<OnnxGraph>;
  tensor(type: OnnxDataType, data: OnnxTensorData, dims: readonly number[]): OnnxTensorLike;
}

/** Built on first use, so importing this package loads no native binding. */
export type OnnxEngineFactory = () => Promise<OnnxEngine>;
