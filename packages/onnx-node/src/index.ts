/**
 * The Node ONNX Runtime backend.
 *
 * `OnnxRuntimeNode` satisfies `OnnxRuntimePlugin` from `@chatterang/contracts`
 * — the same contract the web shim and the iOS/Android bridges implement —
 * over `onnxruntime-node`. Nothing here imports that dependency at module
 * scope: the engine is built on first use behind `createOnnxRuntimeEngine`, so
 * importing this package never loads a 283 MB native binding.
 *
 * SEPARATE FROM `@chatterang/inference-node` ON PURPOSE. That package's whole
 * dependency is node-llama-cpp; this one's is onnxruntime-node, and the two
 * have different platform support (there is no darwin/x64 onnxruntime prebuild
 * at all) and very different packaging consequences. Keeping them apart means
 * the desktop build can ship one without the other, and means a mistake that
 * pulls ONNX into a bundle names ONNX in the error.
 *
 * DESKTOP ONLY. `tests/layering.test.ts` forbids `src/` from importing this
 * package, `onnxruntime-node` or `onnxruntime-common` by any of the import
 * forms it knows about. The web and mobile bundles cannot load a native
 * binding, and 283 MB of prebuilt binaries is not something to discover in a
 * bundle report.
 */

export { OnnxRuntimeNode } from './onnx-runtime.js';
export type { OnnxRuntimeNodeOptions } from './onnx-runtime.js';
export { createOnnxRuntimeEngine, ELECTRON_SAFE_SESSION_OPTIONS } from './onnxruntime-node.js';
export { decodeAudio, decodeBase64, decodeWav, resample } from './audio.js';
export type { DecodedAudio } from './audio.js';
export {
  Dft,
  HOP_LENGTH,
  N_FFT,
  N_FRAMES,
  N_SAMPLES,
  SAMPLE_RATE,
  hzToMel,
  logMelSpectrogram,
  melFilterBank,
  melToHz,
} from './mel.js';
export { WhisperTokenizer } from './tokenizer.js';
export type { WhisperSpecialTokens } from './tokenizer.js';
export { inspectWhisper, readGenerationConfig, runWhisper } from './whisper.js';
export type {
  TranscribeSegment,
  WhisperGenerationConfig,
  WhisperRunOptions,
  WhisperRunResult,
  WhisperShape,
} from './whisper.js';
export type {
  OnnxDataType,
  OnnxEngine,
  OnnxEngineFactory,
  OnnxGraph,
  OnnxSessionOptionsLike,
  OnnxTensorData,
  OnnxTensorLike,
  OnnxValueMetadata,
} from './engine.js';
