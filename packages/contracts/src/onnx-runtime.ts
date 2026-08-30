/**
 * `plugin-onnx-runtime` — Capacitor bridge for ONNX Runtime (PRD §5).
 *
 * Deliberately a *separate* plugin and a separate aimatey backend adapter
 * from llama.cpp. Diffusion in particular has a memory profile that must not
 * be able to evict or fragment the LLM engine's allocations, so it runs in
 * its own session with its own lifecycle (PRD §6, image-gen memory risk).
 *
 * Covers three Phase 1 capabilities:
 *   - speech-to-text (Whisper)
 *   - neural text-to-speech (VITS/Piper-class models)
 *   - image generation (a latent-diffusion pipeline)
 */

import type { ListenerHandle } from './listener.js';

export type OnnxTask = 'stt' | 'tts' | 'diffusion';

export type OnnxExecutionProvider = 'cpu' | 'coreml' | 'nnapi' | 'xnnpack' | 'webgpu' | 'wasm';

export interface OnnxSessionOptions {
  task: OnnxTask;
  /** Absolute path to the .onnx file (or the pipeline's root directory). */
  modelPath: string;
  /** Companion assets keyed by role: tokenizer, vocoder, vae, text-encoder. */
  companions?: Record<string, string>;
  executionProvider?: OnnxExecutionProvider;
  threads?: number;
}

export interface OnnxSession {
  handle: string;
  task: OnnxTask;
  executionProvider: OnnxExecutionProvider;
  loadMs: number;
  warnings: string[];
}

/* ── Speech to text ─────────────────────────────────────────────────── */

export interface TranscribeOptions {
  handle: string;
  /** Base64 PCM/WAV audio. */
  audio: string;
  mediaType: string;
  language?: string;
  /** Emit `onnxPartial` events while decoding. */
  streamPartials?: boolean;
  requestId: string;
}

export interface TranscribeResult {
  requestId: string;
  text: string;
  language: string;
  durationMs: number;
  segments: { start: number; end: number; text: string }[];
}

/* ── Text to speech ─────────────────────────────────────────────────── */

export interface SynthesizeOptions {
  handle: string;
  text: string;
  /** Voice id within the loaded model. */
  voice?: string;
  /** 0.5 – 2.0. */
  rate?: number;
  pitch?: number;
  requestId: string;
}

export interface SynthesizeResult {
  requestId: string;
  /** Base64 WAV. */
  audio: string;
  mediaType: string;
  sampleRate: number;
  durationMs: number;
}

/* ── Image generation ───────────────────────────────────────────────── */

export interface DiffuseOptions {
  handle: string;
  prompt: string;
  negativePrompt?: string;
  steps?: number;
  guidanceScale?: number;
  width?: number;
  height?: number;
  seed?: number | null;
  requestId: string;
}

export interface DiffuseResult {
  requestId: string;
  /** Base64 PNG. */
  image: string;
  mediaType: string;
  width: number;
  height: number;
  steps: number;
  seed: number;
  durationMs: number;
  peakMemoryBytes: number;
}

export interface DiffusionProgressEvent {
  requestId: string;
  step: number;
  totalSteps: number;
  /** Base64 PNG preview of the current latent, when the pipeline offers one. */
  preview?: string;
}

export interface PartialTranscriptEvent {
  requestId: string;
  text: string;
}

export interface OnnxRuntimePlugin {
  /** Execution providers this build supports on this device. */
  getExecutionProviders(): Promise<{
    providers: OnnxExecutionProvider[];
    preferred: OnnxExecutionProvider;
    simulated: boolean;
  }>;

  createSession(options: OnnxSessionOptions): Promise<OnnxSession>;
  releaseSession(options: { handle: string }): Promise<void>;
  /** Free every diffusion session; called on memory-pressure warnings. */
  releaseTask(options: { task: OnnxTask }): Promise<void>;

  transcribe(options: TranscribeOptions): Promise<TranscribeResult>;
  synthesize(options: SynthesizeOptions): Promise<SynthesizeResult>;
  diffuse(options: DiffuseOptions): Promise<DiffuseResult>;
  cancel(options: { requestId: string }): Promise<void>;

  addListener(
    eventName: 'onnxProgress',
    listener: (event: DiffusionProgressEvent) => void,
  ): Promise<ListenerHandle>;
  addListener(
    eventName: 'onnxPartial',
    listener: (event: PartialTranscriptEvent) => void,
  ): Promise<ListenerHandle>;
  removeAllListeners(): Promise<void>;
}
