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

/**
 * Anything that declares capabilities.
 *
 * Deliberately not `ModelManifest`: the shell's `model` command works from a
 * read-only projection carrying only the fields it prints, and the rule below
 * has no business demanding a download URL and a licence string to answer a
 * question about capabilities. Structural, so both satisfy it.
 */
export interface CapabilityBearing {
  readonly capabilities: readonly Capability[];
}

/**
 * Can this model answer a chat turn?
 *
 * The rule was already being applied in two places — `install()` picking the
 * first active model, and `remove()` picking a replacement — as a bare
 * `capabilities.includes('text')`. Both were the paths where the APP chooses,
 * and both were correct; every path where the USER chooses skipped it, which is
 * how a speech model became somebody's chat model.
 *
 * It lives here, named, so the question is asked in one vocabulary. Note the
 * capability is `text`: there is no `text-out`, and a check written against
 * that name would silently reject the entire catalogue.
 */
export function canChat(model: CapabilityBearing): boolean {
  return model.capabilities.includes('text');
}

/**
 * What KIND of model this is, for someone who picked it expecting a chat.
 *
 * A refusal has to be actionable, and "not registered" is not. Whisper is not
 * broken and the user did not do anything wrong — they chose the wrong kind of
 * model for the job, and the sentence should say which kind it is.
 *
 * IT NAMES THE KIND; IT DOES NOT PROMISE THE FEATURE. The first draft of this
 * function said "turns speech into text", and on the platform the report came
 * from that is false. `@chatterang/plugin-onnx-runtime` appears in none of
 * package.json, android/app/src/main/assets/capacitor.plugins.json,
 * android/capacitor.settings.gradle or ios/App/CapApp-SPM/Package.swift, so
 * `src/plugins/onnx-runtime` falls through to `registerPlugin`'s `web:`
 * implementation — which exists only on web. Driving the real `@capacitor/core`
 * with `androidBridge` set gives `"OnnxRuntime" plugin is not implemented on
 * android`; every ONNX model in the catalogue is one of these. So on the phone
 * where the bug was filed, Whisper turns speech into nothing.
 *
 * Replacing a false negative claim with a confident affirmative one is worse
 * than the bug. What a model IS holds on every platform. What it will DO for
 * you here is a per-device question this function cannot answer and does not
 * try to; the catalogue description is where that promise belongs, next to the
 * download button that is the only place it can be acted on.
 *
 * There is deliberately no `embedding` branch. `grep -rn embedding src/` finds
 * the word exactly twice, both in this file — the `Capability` union and the
 * branch that used to be here. No catalogue entry declares it and there is no
 * search to index for, so "indexes text for search" described a feature that
 * does not exist. Such a model now falls to the last line, which claims
 * nothing.
 */
export function nonChatRole(model: CapabilityBearing): string {
  if (model.capabilities.includes('audio-in')) return 'is a speech-to-text model';
  if (model.capabilities.includes('audio-out')) return 'is a text-to-speech voice';
  if (model.capabilities.includes('image-out')) return 'is an image generator';
  return 'cannot hold a conversation';
}

/**
 * Anything that declares which engine must run it.
 *
 * Structural for the same reason `CapabilityBearing` is: the shell's model
 * projection carries `engine` as a plain string, and the rule below has no
 * business demanding a whole `ModelManifest` to answer a question about one
 * field. `string` rather than `EngineId` so that projection satisfies it —
 * a manifest's own `engine` is already narrowed by `ModelManifest`.
 */
export interface EngineBearing {
  readonly engine: string;
}

/**
 * Engines with an on-device benchmark harness.
 *
 * `benchmark()` is a method on the llama.cpp plugin contract and on no other:
 * `OnnxRuntimePlugin` has no such call, so there is nothing for the benchmark
 * to drive. This is a list rather than an equality test because the missing
 * piece is a harness per engine, and the next engine to grow one (litert-lm,
 * mlc-llm) joins here rather than by editing every call site.
 */
export const BENCHMARKABLE_ENGINES: readonly EngineId[] = ['llama-cpp'];

/**
 * Can this model be measured by the on-device benchmark?
 *
 * Deliberately NOT `canChat`. The benchmark asks a different question: it
 * loads the file through a specific native plugin and times prefill and
 * decode, so what matters is which ENGINE will run it, not what the model
 * emits. Two cases separate the predicates and both are real:
 *
 *  - `gemma-3-4b` is `['text', 'vision']` on `llama-cpp`. A vision model
 *    llama.cpp can load is a legitimate benchmark subject, and a
 *    capability-shaped check would have to enumerate capabilities to say so.
 *  - A text model on `litert-lm` or `mlc-llm` would pass `canChat` and still
 *    hand a `.litertlm` file to the llama.cpp loader.
 *
 * `useBench.run` calls `LlamaCpp.load({ modelPath })` unconditionally, so
 * without this the benchmark hands Whisper's `.onnx` to the GGUF loader and
 * fails somewhere inside a native plugin — the same class of failure as the
 * reported chat bug, in a less legible place.
 */
export function canBenchmark(model: EngineBearing): boolean {
  return (BENCHMARKABLE_ENGINES as readonly string[]).includes(model.engine);
}

/**
 * The engines the benchmark can drive, as a phrase to put in a sentence.
 *
 * Derived from `BENCHMARKABLE_ENGINES` rather than typed out, so the copy
 * cannot survive the list changing under it, and printed as the engine ID —
 * `llama-cpp`, not "llama.cpp" — because that is the string the user can match
 * against: the ENGINE column of `model list` and the "Engine" row of the model
 * sheet both print the ID.
 */
export function benchmarkableEngineList(): string {
  return BENCHMARKABLE_ENGINES.join(' or ');
}

/**
 * Why a model cannot be benchmarked, in terms of the thing the user chose.
 *
 * Names the engine the model file is BUILT FOR, because that is the honest
 * reason and it is printed a few rows up in the model's own detail sheet
 * ("Engine: onnx-runtime"). The user is not being told their model is broken;
 * they are being told the stopwatch only fits one kind of runtime.
 *
 * IT NAMES THE KIND; IT DOES NOT PROMISE THE MODEL RUNS — the same rule
 * `nonChatRole` states above, and this sentence broke it. It read "runs on
 * onnx-runtime, which has no benchmark harness", which says the model runs, on
 * a runtime this app has, and that only the stopwatch is missing. On the
 * platform the report came from all three halves are false: there is no native
 * ONNX plugin on Android or iOS (see `nonChatRole` for the four files that say
 * so), so the model runs nowhere and there is no runtime to lack a harness.
 * "is built for X" is a fact about the file, true on every platform; the second
 * half is a fact about the benchmark, not a promise about the model.
 */
export function nonBenchmarkableReason(model: EngineBearing): string {
  return `is built for ${model.engine}, and the benchmark only measures ${benchmarkableEngineList()} models`;
}

export type PromptTemplate =
  | 'chatml'
  | 'llama3'
  | 'gemma'
  | 'gemma4'
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
