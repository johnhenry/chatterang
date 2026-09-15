/**
 * `plugin-llama-cpp` — Capacitor bridge for the llama.cpp inference engine
 * (PRD §5). This is the Phase 1 core LLM/VLM runtime: GGUF text chat, vision
 * via `mtmd`, speculative decoding via a draft model, and hardware-tiered
 * execution (CPU → GPU → NPU).
 *
 * The web implementation in `web.ts` keeps the whole app runnable in a
 * browser during development; it reports `simulated: true` so the UI can say
 * so plainly rather than pretending a phone GPU is present.
 */

import type { ListenerHandle } from './listener.js';

/**
 * Compute backends any implementation may report.
 *
 * Widening only: every member that has ever been persisted stays valid, so
 * adding one needs no migration. Removing or renaming one would.
 *
 * `gpu-cuda` is the desktop addition — node-llama-cpp builds for cuda, metal
 * and vulkan, and the latter two were already here for mobile. There is no
 * `gpu-rocm` because node-llama-cpp does not build for it.
 */
export type ComputeBackendId =
  | 'cpu'
  | 'gpu-metal'
  | 'gpu-opencl'
  | 'gpu-vulkan'
  | 'gpu-cuda'
  | 'npu-hexagon';

export interface DeviceCapabilities {
  /** Total physical RAM in bytes. */
  totalMemory: number;
  /** Memory the OS will realistically let this process use. */
  availableMemory: number;
  /** Compute backends this build was compiled with AND this device supports. */
  backends: ComputeBackendId[];
  /** Best backend available right now. */
  preferredBackend: ComputeBackendId;
  cpuCores: number;
  /** SoC / chipset identifier, e.g. "Apple A18 Pro", "SM8650". */
  chipset: string;
  /** True when running the web development shim rather than native llama.cpp. */
  simulated: boolean;
  /** Engine build string, e.g. "llama.cpp b4321". */
  engineVersion: string;
}

export interface ThermalState {
  /** Normalised 0 (cool) → 1 (critical). */
  level: number;
  state: 'nominal' | 'fair' | 'serious' | 'critical';
  /** True when the OS has begun throttling this process. */
  throttled: boolean;
}

export interface LoadOptions {
  /** Absolute path to the GGUF file in app-private storage. */
  modelPath: string;
  /** Multimodal projector for vision models (llama.cpp `mtmd`). */
  mmprojPath?: string;
  /** Draft model for speculative decoding. */
  draftModelPath?: string;
  contextLength?: number;
  /** Layers to offload to GPU; -1 offloads everything the backend allows. */
  gpuLayers?: number;
  /** Requested backend. The engine falls back down the tier list if it fails. */
  backend?: ComputeBackendId;
  threads?: number;
  /** Load the model into memory-mapped pages rather than copying. */
  useMmap?: boolean;
  /** Chat template override when the GGUF metadata has none. */
  chatTemplate?: string;

  /**
   * The template's own control markers, for a match check at load time.
   *
   * A chat template is chosen by model id, which is a guess. When the guess is
   * wrong the markers are not in the model's vocabulary, so they tokenize as
   * ordinary text and the model answers noise — the failure looks like a broken
   * model rather than a wrong template. Passing the markers lets the engine,
   * which is the only layer that can tokenize, say so instead.
   */
  templateMarkers?: readonly string[];
}

export interface LoadResult {
  handle: string;
  /** Backend the engine actually ended up using after fallback. */
  backend: ComputeBackendId;
  contextLength: number;
  loadMs: number;
  /** Non-fatal notes, e.g. "GPU offload failed, fell back to CPU". */
  warnings: string[];
  /** Whether the loaded model can accept images. */
  supportsVision: boolean;
  /** Chat template name resolved from the GGUF metadata. */
  chatTemplate: string;
}

export interface GenerateImage {
  /** Base64 image payload without the data-URI prefix. */
  data: string;
  mediaType: string;
}

export interface GenerateSampler {
  temperature?: number;
  topP?: number;
  topK?: number;
  minP?: number;
  repeatPenalty?: number;
  repeatLastN?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  maxTokens?: number;
  seed?: number | null;
  stopSequences?: string[];
  /** Tokens the draft model proposes per verification step. */
  draftTokens?: number;
}

export interface GenerateOptions {
  handle: string;
  /** Fully rendered prompt. The template is applied on the JS side so the
   *  same conversation produces the same prompt on every engine. */
  prompt: string;
  images?: GenerateImage[];
  sampler?: GenerateSampler;
  /** Correlates `llamaToken` events with this request. */
  requestId: string;
}

export interface GenerateResult {
  requestId: string;
  text: string;
  promptTokens: number;
  /**
   * Prompt tokens served from the KV cache rather than re-processed.
   *
   * Prefill dominates the cost of a long conversation: without cache reuse,
   * turn 10 re-processes every token of turns 1–9 before emitting anything.
   * This is the number that says whether that is happening, so a regression
   * in cache reuse is visible rather than merely slow.
   */
  cachedTokens: number;
  completionTokens: number;
  ttftMs: number;
  totalMs: number;
  tokensPerSecond: number;
  /** Fraction of speculative draft tokens accepted, when enabled. */
  draftAcceptance?: number;
  stopReason: 'stop' | 'length' | 'stop-sequence' | 'cancelled' | 'error';
  peakMemoryBytes?: number;
}

export interface TokenEvent {
  requestId: string;
  /** Incremental text for this step. */
  token: string;
  /** Index of this token within the response. */
  index: number;
}

/**
 * A generation that is WAITING for the one slot it runs in (#7).
 *
 * Emitted as `llamaWaiting` by the desktop's main process, and by nothing
 * else: the desktop's own turns and a paired phone's share one slot, and
 * whoever waits is told. `position` 1 is next; 0 means the wait is over and
 * the turn has started.
 *
 * Deliberately NOT one of `LlamaCppPlugin.addListener`'s overloads. No
 * inference host emits it, so declaring it on the contract every host
 * implements would be a promise three of them do not keep. A platform with no
 * shared slot refuses the subscription or never fires it.
 */
export interface TurnWaitingEvent {
  requestId: string;
  position: number;
}

export interface GenerationEndEvent extends GenerateResult {
  error?: string;
}

export interface BenchmarkOptions {
  handle: string;
  /** Prompt-processing batch size to measure. */
  promptTokens?: number;
  /** Tokens to generate while measuring decode throughput. */
  generateTokens?: number;
  repetitions?: number;
}

export interface BenchmarkResult {
  /** Prompt-processing throughput (prefill). */
  promptTokensPerSecond: number;
  /** Token-generation throughput (decode). */
  generateTokensPerSecond: number;
  peakMemoryBytes: number;
  thermalBefore: ThermalState;
  thermalAfter: ThermalState;
  backend: ComputeBackendId;
  repetitions: number;
  /** Per-repetition decode throughput, for variance display. */
  samples: number[];
}

export interface LlamaCppPlugin {
  /** Probe the device before offering models the hardware cannot run. */
  getCapabilities(): Promise<DeviceCapabilities>;
  getThermalState(): Promise<ThermalState>;

  load(options: LoadOptions): Promise<LoadResult>;
  unload(options: { handle: string }): Promise<void>;
  /** Handles currently resident in memory. */
  listLoaded(): Promise<{ handles: string[] }>;

  /** Streams `llamaToken` events, then resolves with the full result. */
  generate(options: GenerateOptions): Promise<GenerateResult>;
  cancel(options: { requestId: string }): Promise<void>;

  tokenize(options: { handle: string; text: string }): Promise<{ tokens: number[] }>;
  /** Token count without materialising the token array. */
  countTokens(options: { handle: string; text: string }): Promise<{ count: number }>;

  benchmark(options: BenchmarkOptions): Promise<BenchmarkResult>;

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
  removeAllListeners(): Promise<void>;
}
