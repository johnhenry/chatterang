/**
 * The one file that knows `onnxruntime-node` exists.
 *
 * The import is dynamic for the same reason as the llama.cpp sibling's: the
 * package loads a native binding at import time. Making that happen only when
 * an engine is actually requested keeps this package importable from a
 * jsdom-ish test environment, and keeps 283 MB of prebuilt binaries off the
 * path of anyone who only wanted the types.
 *
 * `enableCpuMemArena: false` IS SET ON EVERY SESSION, AND IT IS NOT A TUNING
 * CHOICE. With onnxruntime's default CPU arena, an Electron process — main or
 * utilityProcess — dies with an uncatchable SIGTRAP (utilityProcess exit code
 * 5) at around 1.1 GB RSS while plain Node reaches 6.8 GB on the identical
 * workload. Measured on the whisper-base encoder by walking the batch size:
 * arena on, Electron died at batch 4 after batch 3 succeeded at 1106 MB; arena
 * off, batches 1..8 all completed and RSS peaked at 884 MB. It is not a
 * blanket memory cap — 8 GB of touched `Buffer` commits fine in the same
 * process — so it is the arena's allocation pattern against Chromium's
 * allocator, not the total.
 *
 * The cost is about 1.5x per run. The other benefit is that RSS is 3-4x lower
 * and pages are actually returned on release.
 *
 * NOTE FOR WHOEVER CHANGES THIS: plain Node never hits the crash, so the
 * vitest-under-Node suite CANNOT catch a regression here. `tests/onnx-node.test.ts`
 * asserts the flag is passed, which is the only thing a Node-side test can
 * honestly check; the behaviour it protects is only observable in Electron.
 */

import type {
  OnnxDataType,
  OnnxEngine,
  OnnxEngineFactory,
  OnnxGraph,
  OnnxSessionOptionsLike,
  OnnxTensorData,
  OnnxTensorLike,
  OnnxValueMetadata,
} from './engine.js';

/** The bits of onnxruntime-node's surface used here, named structurally. */
interface OrtModule {
  listSupportedBackends(): { name: string; bundled: boolean }[];
  InferenceSession: {
    create(path: string, options?: Record<string, unknown>): Promise<OrtSession>;
  };
  Tensor: new (
    type: string,
    data: OnnxTensorData,
    dims: readonly number[],
  ) => OnnxTensorLike;
}

interface OrtSession {
  readonly inputNames: readonly string[];
  readonly outputNames: readonly string[];
  readonly inputMetadata: readonly OnnxValueMetadata[];
  readonly outputMetadata: readonly OnnxValueMetadata[];
  run(feeds: Record<string, unknown>): Promise<Record<string, OnnxTensorLike>>;
  release(): Promise<void>;
}

/** See the file header: this is a crash workaround, not a tuning knob. */
export const ELECTRON_SAFE_SESSION_OPTIONS = Object.freeze({ enableCpuMemArena: false });

function wrapSession(session: OrtSession): OnnxGraph {
  return {
    inputNames: session.inputNames,
    outputNames: session.outputNames,
    inputMetadata: session.inputMetadata,
    outputMetadata: session.outputMetadata,
    run: (feeds) => session.run(feeds),
    release: () => session.release(),
  };
}

/**
 * Builds an engine backed by the real `onnxruntime-node`.
 *
 * This is the default factory `OnnxRuntimeNode` uses; tests pass their own.
 */
export const createOnnxRuntimeEngine: OnnxEngineFactory = async (): Promise<OnnxEngine> => {
  // Default-imported: the package is CommonJS, and its named exports come
  // through `onnxruntime-common` on the default object.
  const ort = ((await import('onnxruntime-node')) as unknown as { default?: OrtModule })
    .default as OrtModule;

  return {
    listExecutionProviders: () => ort.listSupportedBackends().map((backend) => backend.name),
    createSession: async (modelPath: string, options: OnnxSessionOptionsLike): Promise<OnnxGraph> =>
      wrapSession(
        await ort.InferenceSession.create(modelPath, {
          ...ELECTRON_SAFE_SESSION_OPTIONS,
          ...(options.executionProviders === undefined
            ? {}
            : { executionProviders: [...options.executionProviders] }),
          ...(options.intraOpNumThreads === undefined
            ? {}
            : { intraOpNumThreads: options.intraOpNumThreads }),
        }),
      ),
    tensor: (type: OnnxDataType, data: OnnxTensorData, dims: readonly number[]): OnnxTensorLike =>
      new ort.Tensor(type, data, dims),
  };
};
