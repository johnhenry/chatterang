/**
 * Model manifest schema (PRD §5).
 *
 * A manifest declares everything the app needs to decide whether a model can
 * run on this device, which engine should run it, and what it is capable of.
 * The `engine` field is an aimatey backend-adapter id — the same string used
 * to register the adapter on the router — so adding a runtime in a later
 * phase is purely additive here.
 */

import type { ComputeBackendId } from '@chatterang/contracts';

/** Engine ids map 1:1 onto aimatey backend-adapter registration names. */
export const ENGINE_IDS = [
  'llama-cpp', // Phase 1 — core LLM/VLM (GGUF)
  'onnx-runtime', // Phase 1 — TTS / STT / diffusion
  'litert-lm', // Phase 1 — WebGPU on-device (web + Android preview)
  'chrome-ai', // Phase 1 — OS-provided on-device model, where present
  'mlc-llm', // Phase 2
  'cactus', // Phase 3
  'executorch', // Phase 4
  'remote', // any aimatey remote provider adapter
] as const;

export type EngineId = (typeof ENGINE_IDS)[number];

/** Engines that execute on this device. Everything else leaves the device. */
export const LOCAL_ENGINES: readonly EngineId[] = [
  'llama-cpp',
  'onnx-runtime',
  'litert-lm',
  'chrome-ai',
  'mlc-llm',
  'cactus',
  'executorch',
];

export function isLocalEngine(engine: EngineId): boolean {
  return LOCAL_ENGINES.includes(engine);
}

/** Which phase of the rollout plan (PRD §4) introduced this engine. */
export const ENGINE_PHASE: Record<EngineId, 1 | 2 | 3 | 4> = {
  'llama-cpp': 1,
  'onnx-runtime': 1,
  'litert-lm': 1,
  'chrome-ai': 1,
  remote: 1,
  'mlc-llm': 2,
  cactus: 3,
  executorch: 4,
};

export type ModelFormat =
  | 'gguf'
  | 'onnx'
  | 'litertlm'
  | 'mlc'
  | 'cactus'
  | 'pte'
  | 'safetensors'
  | 'none';

export type Quantization =
  | 'Q2_K'
  | 'Q3_K_M'
  | 'Q4_0'
  | 'Q4_K_M'
  | 'Q5_K_M'
  | 'Q6_K'
  | 'Q8_0'
  | 'F16'
  | 'INT4'
  | 'INT8'
  | 'FP32'
  | 'mixed';

export type Capability =
  | 'text'
  | 'vision'
  | 'audio-in' // speech-to-text
  | 'audio-out' // text-to-speech
  | 'image-out' // diffusion
  | 'embedding'
  | 'tools'
  | 'thinking'
  | 'draft'; // usable as a speculative-decoding draft model

/** Compute backends, ordered worst-to-best; the loader walks this downward. */
/**
 * Re-exported from the plugin contract rather than redeclared.
 *
 * This was an independent copy with identical members, which meant widening one
 * silently diverged it from the other — and this is the copy that gets
 * persisted (`db.models.lastBackend`) while the contract's is what a plugin
 * reports. One declaration, one source of truth.
 */
export type ComputeBackend = ComputeBackendId;

export interface ModelSource {
  /** Hugging Face repo id, e.g. "bartowski/Llama-3.2-3B-Instruct-GGUF". */
  readonly repo: string;
  /** File within the repo. */
  readonly file: string;
  /** Direct download URL, when not resolvable from repo + file. */
  readonly url?: string;
  /** Whether the repo requires an accepted licence + HF token. */
  readonly gated?: boolean;
  /** Extra files that must be fetched alongside (mmproj, tokenizer, vocoder). */
  readonly companions?: readonly { readonly file: string; readonly role: CompanionRole }[];
}

export type CompanionRole = 'mmproj' | 'tokenizer' | 'vocoder' | 'config' | 'vae' | 'text-encoder';

export interface ModelManifest {
  readonly id: string;
  readonly name: string;
  readonly author: string;
  readonly description: string;

  /** aimatey backend-adapter id that must serve this model. */
  readonly engine: EngineId;
  readonly format: ModelFormat;
  readonly quantization: Quantization;
  readonly capabilities: readonly Capability[];

  /** Download size in bytes. */
  readonly sizeBytes: number;
  /** Minimum device RAM in bytes for this model to load at all. */
  readonly minRAM: number;
  /** RAM at which the model runs comfortably; below this we warn. */
  readonly recommendedRAM: number;
  /** Preferred compute backend; the loader falls back down the tier list. */
  readonly recommendedBackend: ComputeBackend;

  readonly contextLength: number;
  readonly parameterCount?: string;
  readonly license: string;
  readonly source: ModelSource;

  /** Chat template family, used when the engine cannot infer it from GGUF. */
  readonly promptTemplate?: PromptTemplate;
  /** Sampler defaults the publisher recommends. */
  readonly defaultSampler?: Partial<SamplerSettings>;
  /** Model ids usable as draft models for speculative decoding. */
  readonly draftModels?: readonly string[];
  /** Short, honest note about what this model is actually good at. */
  readonly bestFor?: string;
}

export type PromptTemplate =
  | 'chatml'
  | 'llama3'
  | 'gemma'
  | 'mistral'
  | 'phi'
  | 'qwen'
  | 'zephyr'
  | 'vicuna'
  | 'alpaca'
  | 'raw';

/**
 * Sampler settings (PRD §3.1 — saved per model, overridable per chat).
 * Ranges match llama.cpp semantics; adapters clamp to their own ranges and
 * surface an IR warning when they do.
 */
export interface SamplerSettings {
  temperature: number;
  topP: number;
  topK: number;
  minP: number;
  repeatPenalty: number;
  repeatLastN: number;
  frequencyPenalty: number;
  presencePenalty: number;
  maxTokens: number;
  seed: number | null;
  stopSequences: string[];
  /** Draft model id for speculative decoding / multi-token prediction. */
  draftModelId: string | null;
  /** How many tokens the draft model proposes per verification step. */
  draftTokens: number;
}

export const DEFAULT_SAMPLER: SamplerSettings = {
  temperature: 0.7,
  topP: 0.95,
  topK: 40,
  minP: 0.05,
  repeatPenalty: 1.1,
  repeatLastN: 64,
  frequencyPenalty: 0,
  presencePenalty: 0,
  maxTokens: 1024,
  seed: null,
  stopSequences: [],
  draftModelId: null,
  draftTokens: 5,
};

export const SAMPLER_RANGES: Record<
  keyof Pick<
    SamplerSettings,
    | 'temperature'
    | 'topP'
    | 'topK'
    | 'minP'
    | 'repeatPenalty'
    | 'repeatLastN'
    | 'frequencyPenalty'
    | 'presencePenalty'
    | 'maxTokens'
    | 'draftTokens'
  >,
  { min: number; max: number; step: number; label: string; hint: string }
> = {
  temperature: {
    min: 0,
    max: 2,
    step: 0.05,
    label: 'Temperature',
    hint: 'Higher wanders further from the likeliest next word.',
  },
  topP: {
    min: 0,
    max: 1,
    step: 0.01,
    label: 'Top-P',
    hint: 'Consider words until their probabilities add up to this.',
  },
  topK: { min: 0, max: 200, step: 1, label: 'Top-K', hint: 'Only ever consider this many words.' },
  minP: {
    min: 0,
    max: 1,
    step: 0.01,
    label: 'Min-P',
    hint: 'Drop words far less likely than the best one.',
  },
  repeatPenalty: {
    min: 1,
    max: 2,
    step: 0.01,
    label: 'Repeat penalty',
    hint: 'Push back on words it has already used.',
  },
  repeatLastN: {
    min: 0,
    max: 2048,
    step: 16,
    label: 'Repeat window',
    hint: 'How far back the repeat penalty looks.',
  },
  frequencyPenalty: {
    min: -2,
    max: 2,
    step: 0.05,
    label: 'Frequency penalty',
    hint: 'Penalise words by how often they appear.',
  },
  presencePenalty: {
    min: -2,
    max: 2,
    step: 0.05,
    label: 'Presence penalty',
    hint: 'Penalise words that appear at all.',
  },
  maxTokens: {
    min: 32,
    max: 8192,
    step: 32,
    label: 'Response limit',
    hint: 'Stop after this many words-worth of output.',
  },
  draftTokens: {
    min: 1,
    max: 16,
    step: 1,
    label: 'Draft tokens',
    hint: 'How far the small model guesses ahead each step.',
  },
};

/** Human-readable byte size, e.g. "1.8 GB". */
export function formatBytes(bytes: number, digits = 1): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** i;
  return `${value.toFixed(i === 0 ? 0 : digits)} ${units[i]}`;
}

/** Resolve a Hugging Face download URL from a manifest source. */
export function resolveSourceUrl(source: ModelSource, file = source.file): string {
  if (source.url && file === source.file) return source.url;
  return `https://huggingface.co/${source.repo}/resolve/main/${encodeURIComponent(file)}?download=true`;
}
