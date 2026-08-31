/**
 * Whisper, as two ONNX graphs and a decode loop.
 *
 * The export gives you an encoder (mel -> hidden states) and a merged decoder
 * (tokens + hidden states + KV cache -> logits + KV cache). Everything between
 * them — the forced prompt, greedy sampling, the suppression lists, Whisper's
 * timestamp grammar, segment assembly and the 30-second window walk — is
 * written here, because it exists in no dependency this repo has.
 *
 * THE GRAPH IS INSPECTED, NOT ASSUMED. Whisper exports differ: three files or
 * a merged decoder with a `use_cache_branch` switch; 80 mel bins or 128; six
 * layers or thirty-two. `inspectWhisper` reads the real input names and
 * derives the layer count, head count and head dimension from them, and
 * REFUSES with the actual names when they are not a Whisper decoder's. That is
 * the direct analogue of the llama.cpp plugin's chat-template check, and it is
 * here for the same reason: a model file and the code's assumption about it
 * disagreeing should be loud, not a fluent transcript of the wrong words.
 */

import type { OnnxEngine, OnnxGraph, OnnxTensorLike, OnnxValueMetadata } from './engine.js';
import { N_FRAMES, N_SAMPLES, SAMPLE_RATE, logMelSpectrogram } from './mel.js';
import type { WhisperTokenizer } from './tokenizer.js';

/** The `generation_config.json` fields the decode loop obeys. */
export interface WhisperGenerationConfig {
  readonly suppressTokens: readonly number[];
  readonly beginSuppressTokens: readonly number[];
  /** Caps how far into the window the FIRST timestamp may be. 50 = 1 second. */
  readonly maxInitialTimestampIndex: number | undefined;
  readonly maxLength: number;
  readonly isMultilingual: boolean;
}

/** Everything about a loaded Whisper, derived from the files themselves. */
export interface WhisperShape {
  readonly nMels: number;
  readonly layers: number;
  readonly heads: number;
  readonly headDim: number;
  readonly vocabSize: number;
  /** `past_key_values.N.decoder.key`-style names, in layer order. */
  readonly pastNames: readonly string[];
  readonly presentNames: readonly string[];
}

/** Parse `generation_config.json` into what the loop needs, with defaults. */
export function readGenerationConfig(raw: unknown): WhisperGenerationConfig {
  const json = (raw ?? {}) as Record<string, unknown>;
  const numbers = (value: unknown): number[] =>
    Array.isArray(value) ? value.filter((it): it is number => typeof it === 'number') : [];
  const max = json['max_initial_timestamp_index'];
  return {
    suppressTokens: numbers(json['suppress_tokens']),
    beginSuppressTokens: numbers(json['begin_suppress_tokens']),
    maxInitialTimestampIndex: typeof max === 'number' ? max : undefined,
    maxLength: typeof json['max_length'] === 'number' ? json['max_length'] : 448,
    isMultilingual: json['is_multilingual'] !== false,
  };
}

function metadataFor(
  graph: OnnxGraph,
  name: string,
): OnnxValueMetadata | undefined {
  return graph.inputMetadata.find((it) => it.name === name);
}

/**
 * Derive the model's shape from the two graphs, or refuse and say why.
 *
 * @throws Error quoting the graph's own input names when they are not a
 *   Whisper encoder/decoder pair.
 */
export function inspectWhisper(encoder: OnnxGraph, decoder: OnnxGraph): WhisperShape {
  const features = metadataFor(encoder, 'input_features');
  if (features === undefined) {
    throw new Error(
      'This is not a Whisper encoder: it has no "input_features" input. Its inputs are ' +
        `${encoder.inputNames.map((it) => JSON.stringify(it)).join(', ')}.`,
    );
  }
  // Dimension 1 is the mel bin count; it is a NUMBER in some exports and the
  // symbolic string "feature_size" in others, so fall back to Whisper's 80
  // rather than feeding the graph the string's length.
  const melDim = features.shape[1];
  const nMels = typeof melDim === 'number' && melDim > 0 ? melDim : 80;

  for (const required of ['input_ids', 'encoder_hidden_states', 'use_cache_branch']) {
    if (!decoder.inputNames.includes(required)) {
      throw new Error(
        `This is not a merged Whisper decoder: it has no "${required}" input. Its inputs are ` +
          `${decoder.inputNames.slice(0, 6).map((it) => JSON.stringify(it)).join(', ')}` +
          `${decoder.inputNames.length > 6 ? `, … (${decoder.inputNames.length} total)` : ''}. ` +
          'A three-file export (decoder_model.onnx plus decoder_with_past_model.onnx) is not ' +
          'supported by this build; point `companions.decoder` at decoder_model_merged.onnx.',
      );
    }
  }

  const pastNames: string[] = [];
  for (let layer = 0; ; layer += 1) {
    const names = [
      `past_key_values.${layer}.decoder.key`,
      `past_key_values.${layer}.decoder.value`,
      `past_key_values.${layer}.encoder.key`,
      `past_key_values.${layer}.encoder.value`,
    ];
    if (!names.every((name) => decoder.inputNames.includes(name))) break;
    pastNames.push(...names);
  }
  const layers = pastNames.length / 4;
  if (layers === 0) {
    throw new Error(
      'The decoder declares no "past_key_values.0.decoder.key" input, so its KV cache cannot ' +
        'be fed. This build needs an export with past_key_values as graph inputs.',
    );
  }

  const presentNames = pastNames.map((name) => name.replace('past_key_values.', 'present.'));
  const missingPresent = presentNames.filter((name) => !decoder.outputNames.includes(name));
  if (missingPresent.length > 0) {
    throw new Error(
      `The decoder has ${layers} past_key_values inputs but does not output ` +
        `${JSON.stringify(missingPresent[0])}, so the cache cannot be carried forward.`,
    );
  }

  const kv = metadataFor(decoder, 'past_key_values.0.decoder.key');
  const heads = typeof kv?.shape[1] === 'number' ? kv.shape[1] : 0;
  const headDim = typeof kv?.shape[3] === 'number' ? kv.shape[3] : 0;
  if (heads <= 0 || headDim <= 0) {
    throw new Error(
      'The decoder\'s KV cache has symbolic head dimensions ' +
        `(${JSON.stringify(kv?.shape ?? [])}), so an empty cache cannot be shaped. This build ` +
        'needs an export with a fixed head count and head size.',
    );
  }

  const logits = decoder.outputMetadata.find((it) => it.name === 'logits');
  const vocabDim = logits?.shape[2];
  const vocabSize = typeof vocabDim === 'number' ? vocabDim : 0;

  return { nMels, layers, heads, headDim, vocabSize, pastNames, presentNames };
}

/** One second. The smallest a window walk may advance, so it always terminates. */
const HOP_FLOOR_SAMPLES = SAMPLE_RATE;

/* ── The decode loop ──────────────────────────────────────────────────── */

export interface TranscribeSegment {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

export interface WhisperRunOptions {
  readonly engine: OnnxEngine;
  readonly encoder: OnnxGraph;
  readonly decoder: OnnxGraph;
  readonly tokenizer: WhisperTokenizer;
  readonly generation: WhisperGenerationConfig;
  readonly shape: WhisperShape;
  readonly samples: Float32Array;
  /** BCP-47-ish code, or undefined to detect. */
  readonly language: string | undefined;
  /** Called with the running transcript after each decoded token. */
  readonly onPartial?: (text: string) => void;
  /** Checked between decode steps; true stops the run where it stands. */
  readonly cancelled?: () => boolean;
}

export interface WhisperRunResult {
  readonly text: string;
  readonly language: string;
  readonly segments: readonly TranscribeSegment[];
  readonly cancelled: boolean;
}

/** An empty KV entry: zero past positions, correctly shaped otherwise. */
function emptyCache(
  engine: OnnxEngine,
  shape: WhisperShape,
): Record<string, OnnxTensorLike> {
  const feeds: Record<string, OnnxTensorLike> = {};
  for (const name of shape.pastNames) {
    feeds[name] = engine.tensor('float32', new Float32Array(0), [1, shape.heads, 0, shape.headDim]);
  }
  return feeds;
}

function boolTensor(engine: OnnxEngine, value: boolean): OnnxTensorLike {
  return engine.tensor('bool', Uint8Array.of(value ? 1 : 0), [1]);
}

function idsTensor(engine: OnnxEngine, ids: readonly number[]): OnnxTensorLike {
  return engine.tensor('int64', BigInt64Array.from(ids, BigInt), [1, ids.length]);
}

/** The logits of the LAST position, as a plain array we can mutate. */
function lastPositionLogits(logits: OnnxTensorLike): Float32Array {
  const [, seqLen = 1, vocab = 0] = logits.dims;
  const data = logits.data as Float32Array;
  return data.subarray((seqLen - 1) * vocab, seqLen * vocab) as Float32Array;
}

function argmax(values: Float32Array): number {
  let best = 0;
  let bestValue = -Infinity;
  for (let i = 0; i < values.length; i += 1) {
    const value = values[i]!;
    if (value > bestValue) {
      bestValue = value;
      best = i;
    }
  }
  return best;
}

/**
 * Whisper's timestamp grammar, applied to one step's logits in place.
 *
 * Four rules, all from the reference decoder:
 *   - a timestamp is always followed by either another timestamp (closing a
 *     segment) or text, never by a second opening timestamp;
 *   - timestamps never go backwards;
 *   - the first timestamp cannot be later than `max_initial_timestamp_index`;
 *   - if the timestamps collectively outweigh the best text token, a timestamp
 *     is emitted even though no single one is the argmax. That last rule is
 *     what stops a segment running to the end of the window, so it is not
 *     optional decoration.
 */
function applyTimestampRules(
  logits: Float32Array,
  sampled: readonly number[],
  tokenizer: WhisperTokenizer,
  generation: WhisperGenerationConfig,
): void {
  const { timestampBegin, noTimestamps, endOfText } = tokenizer.special;
  logits[noTimestamps] = -Infinity;

  const last = sampled.at(-1);
  const lastWasTimestamp = last !== undefined && last >= timestampBegin;
  const penultimate = sampled.at(-2);
  const penultimateWasTimestamp = penultimate === undefined || penultimate >= timestampBegin;

  if (lastWasTimestamp) {
    if (penultimateWasTimestamp) {
      // Two timestamps closed a segment; the next token must be text.
      for (let id = timestampBegin; id < logits.length; id += 1) logits[id] = -Infinity;
    } else {
      // One open timestamp; the segment must be closed before more text.
      for (let id = 0; id < endOfText; id += 1) logits[id] = -Infinity;
    }
  }

  const timestamps = sampled.filter((id) => id >= timestampBegin);
  const lastTimestamp = timestamps.at(-1);
  if (lastTimestamp !== undefined) {
    const floor =
      lastWasTimestamp && !penultimateWasTimestamp ? lastTimestamp : lastTimestamp + 1;
    for (let id = timestampBegin; id < floor && id < logits.length; id += 1) {
      logits[id] = -Infinity;
    }
  }

  if (sampled.length === 0 && generation.maxInitialTimestampIndex !== undefined) {
    const ceiling = timestampBegin + generation.maxInitialTimestampIndex;
    for (let id = ceiling + 1; id < logits.length; id += 1) logits[id] = -Infinity;
  }

  // log-softmax, then compare the timestamps' total mass against the best text.
  let max = -Infinity;
  for (let i = 0; i < logits.length; i += 1) if (logits[i]! > max) max = logits[i]!;
  if (!Number.isFinite(max)) return;
  let sum = 0;
  for (let i = 0; i < logits.length; i += 1) sum += Math.exp(logits[i]! - max);
  const logZ = max + Math.log(sum);

  let timestampMass = 0;
  for (let id = timestampBegin; id < logits.length; id += 1) {
    timestampMass += Math.exp(logits[id]! - logZ);
  }
  let bestText = -Infinity;
  for (let id = 0; id < timestampBegin; id += 1) if (logits[id]! > bestText) bestText = logits[id]!;
  if (Math.log(Math.max(timestampMass, Number.MIN_VALUE)) > bestText - logZ) {
    for (let id = 0; id < timestampBegin; id += 1) logits[id] = -Infinity;
  }
}

/** Encode one 30-second window; returns the encoder hidden states. */
async function encodeWindow(
  options: WhisperRunOptions,
  window: Float32Array,
): Promise<OnnxTensorLike> {
  const features = logMelSpectrogram(window, { nMels: options.shape.nMels });
  const input = options.engine.tensor('float32', features, [1, options.shape.nMels, N_FRAMES]);
  const output = await options.encoder.run({ input_features: input });
  const hidden = output['last_hidden_state'] ?? output[options.encoder.outputNames[0] ?? ''];
  if (hidden === undefined) {
    throw new Error(
      `The Whisper encoder produced no "last_hidden_state"; it output ` +
        `${options.encoder.outputNames.map((it) => JSON.stringify(it)).join(', ')}.`,
    );
  }
  return hidden;
}

/**
 * One decoder step.
 *
 * The encoder half of the KV cache is computed ONCE, on the first call with
 * `use_cache_branch = false`, and carried unchanged forever after. Recomputing
 * it each step is the classic way to make this loop correct and four times
 * slower; feeding the placeholder the graph returns on later steps is the
 * classic way to make it fast and wrong.
 */
async function decodeStep(
  options: WhisperRunOptions,
  hidden: OnnxTensorLike,
  ids: readonly number[],
  cache: Record<string, OnnxTensorLike>,
  useCache: boolean,
): Promise<{ logits: Float32Array; cache: Record<string, OnnxTensorLike> }> {
  const { engine, decoder, shape } = options;
  const feeds: Record<string, OnnxTensorLike> = {
    input_ids: idsTensor(engine, ids),
    encoder_hidden_states: hidden,
    use_cache_branch: boolTensor(engine, useCache),
    ...cache,
  };
  const output = await decoder.run(feeds);
  const logits = output['logits'];
  if (logits === undefined) throw new Error('The Whisper decoder produced no "logits" output.');

  const next: Record<string, OnnxTensorLike> = {};
  for (let layer = 0; layer < shape.layers; layer += 1) {
    for (const half of ['decoder', 'encoder'] as const) {
      for (const part of ['key', 'value'] as const) {
        const pastName = `past_key_values.${layer}.${half}.${part}`;
        const presentName = `present.${layer}.${half}.${part}`;
        const produced = output[presentName];
        next[pastName] =
          half === 'encoder' && useCache
            ? cache[pastName]!
            : (produced ?? cache[pastName]!);
      }
    }
  }
  return { logits: lastPositionLogits(logits), cache: next };
}

/** One decoder step over `<|startoftranscript|>` alone, argmaxed over languages. */
async function detectLanguage(
  options: WhisperRunOptions,
  hidden: OnnxTensorLike,
): Promise<string> {
  const { tokenizer } = options;
  const { logits } = await decodeStep(
    options,
    hidden,
    [tokenizer.special.startOfTranscript],
    emptyCache(options.engine, options.shape),
    false,
  );
  let best = 'en';
  let bestValue = -Infinity;
  for (const [code, id] of tokenizer.special.languages) {
    const value = logits[id];
    if (value !== undefined && value > bestValue) {
      bestValue = value;
      best = code;
    }
  }
  return best;
}

/** Split one window's sampled tokens into timestamped segments. */
function assembleSegments(
  sampled: readonly number[],
  tokenizer: WhisperTokenizer,
  offsetSeconds: number,
  windowSeconds: number,
): { segments: TranscribeSegment[]; consumedSeconds: number } {
  const isTimestamp = sampled.map((id) => tokenizer.isTimestamp(id));
  const boundaries: number[] = [];
  for (let i = 0; i + 1 < sampled.length; i += 1) {
    if (isTimestamp[i] === true && isTimestamp[i + 1] === true) boundaries.push(i + 1);
  }

  const segments: TranscribeSegment[] = [];
  if (boundaries.length === 0) {
    // No closed pair: one segment for the whole window. Its END is the last
    // timestamp the model emitted when there is one — the reference decoder
    // does the same — because the window is 30 s of padding around however
    // much speech there was, and reporting the padding as speech would make
    // every short clip's last segment run to 30 s.
    const text = tokenizer.decode(sampled).trim();
    if (text.length > 0) {
      const timestamps = sampled.filter((id) => tokenizer.isTimestamp(id));
      const first = timestamps[0];
      const last = timestamps.at(-1);
      const start = first === undefined ? 0 : tokenizer.timestampSeconds(first);
      const end =
        last === undefined || last === first ? windowSeconds : tokenizer.timestampSeconds(last);
      segments.push({ start: offsetSeconds + start, end: offsetSeconds + end, text });
    }
    // The walk still advances a whole window: without a closed pair there is
    // no boundary to resume from, and seeking to a lone opening timestamp
    // would decode the same audio again.
    return { segments, consumedSeconds: windowSeconds };
  }

  let sliceStart = 0;
  let consumed = 0;
  for (const boundary of boundaries) {
    const slice = sampled.slice(sliceStart, boundary);
    const open = slice[0];
    const close = slice.at(-1);
    if (open !== undefined && close !== undefined) {
      const start = tokenizer.timestampSeconds(open);
      const end = tokenizer.timestampSeconds(close);
      const text = tokenizer.decode(slice).trim();
      if (text.length > 0) {
        segments.push({ start: offsetSeconds + start, end: offsetSeconds + end, text });
      }
      consumed = end;
    }
    sliceStart = boundary;
  }
  // A trailing open segment belongs to the NEXT window: seeking to the last
  // closed timestamp is what stops a sentence being cut in half at 30 s.
  return { segments, consumedSeconds: consumed > 0 ? consumed : windowSeconds };
}

/**
 * Transcribe every 30-second window of `samples`.
 *
 * Greedy, single pass, no temperature fallback: the reference decoder retries
 * a window at rising temperature when the result looks degenerate, and that is
 * NOT implemented here. The consequence is stated rather than hidden — a
 * window that produces a repetition loop stays as it came out, capped by
 * `max_length`, instead of being re-rolled.
 */
export async function runWhisper(options: WhisperRunOptions): Promise<WhisperRunResult> {
  const { engine, tokenizer, generation, shape } = options;
  const total = options.samples.length;
  const segments: TranscribeSegment[] = [];
  let language = options.language;
  let text = '';
  let cancelled = false;

  for (let offset = 0; offset < Math.max(total, 1); ) {
    const window = options.samples.subarray(offset, Math.min(total, offset + N_SAMPLES));
    const hidden = await encodeWindow(options, window);
    const offsetSeconds = offset / SAMPLE_RATE;
    const windowSeconds = Math.min(N_SAMPLES, total - offset) / SAMPLE_RATE;

    if (language === undefined) {
      language = generation.isMultilingual ? await detectLanguage(options, hidden) : 'en';
    }
    const languageToken =
      tokenizer.special.languages.get(language) ?? tokenizer.special.languages.get('en');

    const prompt = [
      tokenizer.special.startOfTranscript,
      ...(languageToken === undefined ? [] : [languageToken]),
      tokenizer.special.transcribe,
    ];

    const sampled: number[] = [];
    let cache = emptyCache(engine, shape);
    let ids: number[] = prompt;
    let useCache = false;

    while (sampled.length < generation.maxLength) {
      if (options.cancelled?.() === true) {
        cancelled = true;
        break;
      }
      const step = await decodeStep(options, hidden, ids, cache, useCache);
      cache = step.cache;
      useCache = true;

      const logits = step.logits;
      for (const id of generation.suppressTokens) {
        if (id >= 0 && id < logits.length) logits[id] = -Infinity;
      }
      if (sampled.length === 0) {
        for (const id of generation.beginSuppressTokens) {
          if (id >= 0 && id < logits.length) logits[id] = -Infinity;
        }
      }
      applyTimestampRules(logits, sampled, tokenizer, generation);

      const next = argmax(logits);
      if (next === tokenizer.special.endOfText) break;
      sampled.push(next);
      ids = [next];

      if (options.onPartial !== undefined && !tokenizer.isSpecial(next)) {
        options.onPartial(text + tokenizer.decode(sampled));
      }
    }

    const assembled = assembleSegments(sampled, tokenizer, offsetSeconds, windowSeconds);
    segments.push(...assembled.segments);
    // Joined ONCE at the end, over every window's segments together. Appending
    // per window left no separator at the seam, so the last sentence of one
    // window and the first of the next ran together ("…turn.5. Whisper reads").
    text = segments.map((segment) => segment.text).join(' ');

    if (cancelled) break;
    // Always advance: a window that produced nothing usable must not be
    // decoded again forever.
    const advance = Math.max(
      HOP_FLOOR_SAMPLES,
      Math.min(N_SAMPLES, Math.round(assembled.consumedSeconds * SAMPLE_RATE)),
    );
    offset += advance;
    if (offset >= total) break;
  }

  return {
    text: text.trim(),
    language: language ?? 'en',
    segments,
    cancelled,
  };
}
