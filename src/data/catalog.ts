/**
 * Curated model catalog.
 *
 * Every entry points at a real, publicly downloadable file, with the sizes it
 * actually has, so the storage and memory maths on the Models screen is
 * truthful before anything is downloaded. The Hugging Face browser lets people
 * go beyond this list; the catalog exists so the first run has good answers
 * rather than an empty search box.
 */

import type { ModelManifest } from '@/domain/manifest';

const GB = 1024 ** 3;
const MB = 1024 ** 2;

export const CATALOG: readonly ModelManifest[] = [
  /* ── Text ─────────────────────────────────────────────────────────── */
  {
    id: 'llama-3.2-3b-instruct-q4km',
    name: 'Llama 3.2 3B Instruct',
    author: 'Meta',
    description:
      'A well-rounded small model. Good instruction following and summarising, comfortable on most phones from the last few years.',
    engine: 'llama-cpp',
    format: 'gguf',
    quantization: 'Q4_K_M',
    capabilities: ['text', 'tools'],
    sizeBytes: 2_019_377_696,
    minRAM: 3 * GB,
    recommendedRAM: 6 * GB,
    recommendedBackend: 'gpu-metal',
    contextLength: 8192,
    parameterCount: '3.2B',
    license: 'Llama 3.2 Community License',
    source: {
      repo: 'bartowski/Llama-3.2-3B-Instruct-GGUF',
      file: 'Llama-3.2-3B-Instruct-Q4_K_M.gguf',
    },
    promptTemplate: 'llama3',
    defaultSampler: { temperature: 0.7, topP: 0.9, minP: 0.05 },
    draftModels: ['qwen2.5-0.5b-instruct-q4km'],
    bestFor: 'Everyday questions, rewriting, and summaries',
  },
  {
    id: 'qwen3-4b-instruct-q4km',
    name: 'Qwen3 4B Instruct',
    author: 'Alibaba Qwen',
    description:
      'Strong reasoning and code for its size, with reliable tool calling. The best default if your device has the memory for it.',
    engine: 'llama-cpp',
    format: 'gguf',
    quantization: 'Q4_K_M',
    capabilities: ['text', 'tools', 'thinking'],
    sizeBytes: 2_497_281_120,
    minRAM: 4 * GB,
    recommendedRAM: 8 * GB,
    recommendedBackend: 'gpu-metal',
    contextLength: 32768,
    parameterCount: '4B',
    license: 'Apache-2.0',
    source: {
      repo: 'unsloth/Qwen3-4B-Instruct-2507-GGUF',
      file: 'Qwen3-4B-Instruct-2507-Q4_K_M.gguf',
    },
    promptTemplate: 'qwen',
    defaultSampler: { temperature: 0.7, topP: 0.8, topK: 20, minP: 0 },
    draftModels: ['qwen2.5-0.5b-instruct-q4km'],
    bestFor: 'Reasoning, code, and tool use',
  },
  {
    id: 'qwen3-1.7b-q4km',
    name: 'Qwen3 1.7B',
    author: 'Alibaba Qwen',
    description:
      'Shows its working. A reasoning-tuned model small enough to stay responsive on mid-range hardware.',
    engine: 'llama-cpp',
    format: 'gguf',
    quantization: 'Q4_K_M',
    capabilities: ['text', 'thinking', 'tools'],
    sizeBytes: 1_107_409_472,
    minRAM: 2 * GB,
    recommendedRAM: 4 * GB,
    recommendedBackend: 'gpu-metal',
    contextLength: 32768,
    parameterCount: '1.7B',
    license: 'Apache-2.0',
    source: { repo: 'unsloth/Qwen3-1.7B-GGUF', file: 'Qwen3-1.7B-Q4_K_M.gguf' },
    promptTemplate: 'qwen',
    defaultSampler: { temperature: 0.6, topP: 0.95, topK: 20 },
    bestFor: 'Watching a model reason on a small device',
  },
  {
    id: 'qwen2.5-1.5b-instruct-q4km',
    name: 'Qwen2.5 1.5B Instruct',
    author: 'Alibaba Qwen',
    description: 'Quick and undemanding. A sensible first model when storage is tight.',
    engine: 'llama-cpp',
    format: 'gguf',
    quantization: 'Q4_K_M',
    capabilities: ['text', 'tools'],
    sizeBytes: 986_048_768,
    minRAM: 2 * GB,
    recommendedRAM: 4 * GB,
    recommendedBackend: 'cpu',
    contextLength: 32768,
    parameterCount: '1.5B',
    license: 'Apache-2.0',
    source: {
      repo: 'bartowski/Qwen2.5-1.5B-Instruct-GGUF',
      file: 'Qwen2.5-1.5B-Instruct-Q4_K_M.gguf',
    },
    promptTemplate: 'qwen',
    bestFor: 'Fast replies on older phones',
  },
  {
    id: 'phi-3.5-mini-q4km',
    name: 'Phi-3.5 Mini',
    author: 'Microsoft',
    description:
      'Trained heavily on textbook-style data. Punches above its weight on maths and structured reasoning.',
    engine: 'llama-cpp',
    format: 'gguf',
    quantization: 'Q4_K_M',
    capabilities: ['text'],
    sizeBytes: 2_393_232_672,
    minRAM: 4 * GB,
    recommendedRAM: 6 * GB,
    recommendedBackend: 'gpu-metal',
    contextLength: 16384,
    parameterCount: '3.8B',
    license: 'MIT',
    source: {
      repo: 'bartowski/Phi-3.5-mini-instruct-GGUF',
      file: 'Phi-3.5-mini-instruct-Q4_K_M.gguf',
    },
    promptTemplate: 'phi',
    bestFor: 'Maths and step-by-step explanation',
  },

  /* ── Draft models for speculative decoding ────────────────────────── */
  {
    id: 'qwen2.5-0.5b-instruct-q4km',
    name: 'Qwen2.5 0.5B Instruct',
    author: 'Alibaba Qwen',
    description:
      'Tiny. Useful mostly as a draft model: it guesses the next few words and a larger model checks them, which speeds generation up without changing the output.',
    engine: 'llama-cpp',
    format: 'gguf',
    quantization: 'Q4_K_M',
    capabilities: ['text', 'draft'],
    sizeBytes: 397_808_192,
    minRAM: 1 * GB,
    recommendedRAM: 2 * GB,
    recommendedBackend: 'cpu',
    contextLength: 32768,
    parameterCount: '0.5B',
    license: 'Apache-2.0',
    source: {
      repo: 'bartowski/Qwen2.5-0.5B-Instruct-GGUF',
      file: 'Qwen2.5-0.5B-Instruct-Q4_K_M.gguf',
    },
    promptTemplate: 'qwen',
    bestFor: 'Speeding up a larger Qwen model',
  },

  /* ── Vision ───────────────────────────────────────────────────────── */
  {
    id: 'gemma-3-4b-it-q4km',
    name: 'Gemma 3 4B (vision)',
    author: 'Google',
    description:
      'Reads images as well as text. Ask it what is in a photo, transcribe a sign, or describe a screenshot — entirely offline.',
    engine: 'llama-cpp',
    format: 'gguf',
    quantization: 'Q4_K_M',
    capabilities: ['text', 'vision'],
    sizeBytes: 2_489_757_856 + 851_251_104,
    minRAM: 5 * GB,
    recommendedRAM: 8 * GB,
    recommendedBackend: 'gpu-metal',
    contextLength: 8192,
    parameterCount: '4B',
    license: 'Gemma Terms of Use',
    source: {
      repo: 'ggml-org/gemma-3-4b-it-GGUF',
      file: 'gemma-3-4b-it-Q4_K_M.gguf',
      companions: [{ file: 'mmproj-model-f16.gguf', role: 'mmproj' }],
    },
    promptTemplate: 'gemma',
    bestFor: 'Questions about photos and screenshots',
  },
  {
    id: 'smolvlm-500m-q8',
    name: 'SmolVLM 500M (vision)',
    author: 'Hugging Face',
    description:
      'A very small vision model. Less capable than Gemma 3, but it loads in seconds and runs on almost anything.',
    engine: 'llama-cpp',
    format: 'gguf',
    quantization: 'Q8_0',
    capabilities: ['text', 'vision'],
    sizeBytes: 436_806_912 + 108_783_360,
    minRAM: 1 * GB,
    recommendedRAM: 3 * GB,
    recommendedBackend: 'cpu',
    contextLength: 8192,
    parameterCount: '500M',
    license: 'Apache-2.0',
    source: {
      repo: 'ggml-org/SmolVLM-500M-Instruct-GGUF',
      file: 'SmolVLM-500M-Instruct-Q8_0.gguf',
      companions: [{ file: 'mmproj-SmolVLM-500M-Instruct-Q8_0.gguf', role: 'mmproj' }],
    },
    promptTemplate: 'chatml',
    bestFor: 'Quick image descriptions on any device',
  },

  /* ── Speech ───────────────────────────────────────────────────────── */
  {
    id: 'whisper-tiny-en-onnx',
    name: 'Whisper Tiny (English)',
    author: 'OpenAI',
    description:
      'Turns speech into text on the device. Fast enough to keep up with normal dictation, and the audio never leaves your phone.',
    engine: 'onnx-runtime',
    format: 'onnx',
    quantization: 'INT8',
    capabilities: ['audio-in'],
    sizeBytes: 30_718_858 + 32 * MB,
    minRAM: 1 * GB,
    recommendedRAM: 2 * GB,
    recommendedBackend: 'cpu',
    contextLength: 448,
    parameterCount: '39M',
    license: 'MIT',
    source: {
      repo: 'onnx-community/whisper-tiny.en',
      file: 'onnx/decoder_model_merged_quantized.onnx',
      companions: [
        { file: 'onnx/encoder_model_quantized.onnx', role: 'text-encoder' },
        { file: 'tokenizer.json', role: 'tokenizer' },
        { file: 'config.json', role: 'config' },
      ],
    },
    bestFor: 'Dictation and voice notes',
  },
  {
    id: 'piper-en-us-amy-medium',
    name: 'Amy (neural voice, US English)',
    author: 'Rhasspy Piper',
    description:
      'A neural voice that sounds the same on every device, unlike the built-in OS voices which vary by phone.',
    engine: 'onnx-runtime',
    format: 'onnx',
    quantization: 'FP32',
    capabilities: ['audio-out'],
    sizeBytes: 63_201_294,
    minRAM: 512 * MB,
    recommendedRAM: 2 * GB,
    recommendedBackend: 'cpu',
    contextLength: 0,
    license: 'MIT',
    source: {
      repo: 'rhasspy/piper-voices',
      file: 'en/en_US/amy/medium/en_US-amy-medium.onnx',
      companions: [
        { file: 'en/en_US/amy/medium/en_US-amy-medium.onnx.json', role: 'config' },
      ],
    },
    bestFor: 'Reading replies aloud with a consistent voice',
  },

  /* ── Image generation ─────────────────────────────────────────────── */
  {
    id: 'sd-turbo-onnx',
    name: 'SD-Turbo',
    author: 'Stability AI',
    description:
      'Generates a picture in one to four steps rather than the usual twenty-plus. Runs in its own isolated process so it cannot disturb a loaded language model.',
    engine: 'onnx-runtime',
    format: 'onnx',
    quantization: 'FP32',
    capabilities: ['image-out'],
    sizeBytes: 2_600_000_000,
    minRAM: 6 * GB,
    recommendedRAM: 8 * GB,
    recommendedBackend: 'gpu-metal',
    contextLength: 77,
    license: 'Stability AI Non-Commercial Research Community License',
    source: {
      repo: 'tlwu/sd-turbo-onnxruntime',
      file: 'unet/model.onnx',
      companions: [
        { file: 'vae_decoder/model.onnx', role: 'vae' },
        { file: 'text_encoder/model.onnx', role: 'text-encoder' },
        { file: 'tokenizer/tokenizer.json', role: 'tokenizer' },
      ],
    },
    bestFor: 'Quick illustrations without a network connection',
  },
];

export function catalogEntry(id: string): ModelManifest | undefined {
  return CATALOG.find((manifest) => manifest.id === id);
}

/**
 * Devices below this much RAM do not get offered image generation at all
 * (PRD §6 — diffusion memory pressure).
 */
export const IMAGE_GEN_RAM_FLOOR = 6 * GB;
