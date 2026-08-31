/**
 * Audio in, mono float32 at a known rate out.
 *
 * `TranscribeOptions` gives us base64 bytes and a free-string `mediaType`, and
 * nothing else. There is no `AudioContext` in a utility process, so every step
 * from container to samples is here.
 *
 * The rule this file follows is the one the whole milestone follows: REFUSE
 * WHAT WE CANNOT DECODE. A container we do not understand throws a message
 * naming what it was, rather than being read as raw PCM and producing a
 * confident transcript of white noise. Whisper will happily hallucinate words
 * from noise, so a wrong decode here does not look like a failure — it looks
 * like a bad model.
 */

/** What `decodeAudio` understood. */
export interface DecodedAudio {
  /** Mono, in [-1, 1], at `sampleRate`. */
  readonly samples: Float32Array;
  readonly sampleRate: number;
  /** Channels the source had, before the downmix. */
  readonly channels: number;
  /** Honest notes about lossy steps taken to get here. */
  readonly warnings: readonly string[];
}

/** WAVE format tags we can read. */
const WAVE_FORMAT_PCM = 1;
const WAVE_FORMAT_IEEE_FLOAT = 3;
const WAVE_FORMAT_EXTENSIBLE = 0xfffe;

/** Media types that mean "a RIFF/WAVE container". */
const WAV_TYPES = new Set([
  'audio/wav',
  'audio/wave',
  'audio/x-wav',
  'audio/vnd.wave',
  'audio/x-pn-wav',
]);

/** The media type without its parameters, lowercased. */
function baseType(mediaType: string): string {
  return (mediaType.split(';')[0] ?? '').trim().toLowerCase();
}

/**
 * Bytes from a base64 string, tolerating the `data:` URL a browser produces.
 *
 * @throws Error when the payload is not decodable base64.
 */
export function decodeBase64(audio: string): Uint8Array {
  const comma = audio.startsWith('data:') ? audio.indexOf(',') : -1;
  const payload = comma === -1 ? audio : audio.slice(comma + 1);
  const bytes = Buffer.from(payload, 'base64');
  if (bytes.length === 0) {
    throw new Error('The audio payload decoded to zero bytes; there is nothing to transcribe.');
  }
  return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

interface WavChunk {
  readonly id: string;
  readonly offset: number;
  readonly size: number;
}

/** Walk a RIFF file's top-level chunks. */
function riffChunks(view: DataView, bytes: Uint8Array): WavChunk[] {
  const chunks: WavChunk[] = [];
  let cursor = 12;
  while (cursor + 8 <= bytes.length) {
    const id = String.fromCharCode(
      bytes[cursor]!,
      bytes[cursor + 1]!,
      bytes[cursor + 2]!,
      bytes[cursor + 3]!,
    );
    const size = view.getUint32(cursor + 4, true);
    chunks.push({ id, offset: cursor + 8, size });
    // Chunks are word-aligned; an odd size is followed by a pad byte.
    cursor += 8 + size + (size % 2);
  }
  return chunks;
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  let out = '';
  for (let i = 0; i < length; i += 1) out += String.fromCharCode(bytes[offset + i] ?? 0);
  return out;
}

/**
 * Decode a RIFF/WAVE file into interleaved float samples.
 *
 * Handles 8/16/24/32-bit integer PCM and 32/64-bit IEEE float, including the
 * `WAVE_FORMAT_EXTENSIBLE` wrapper `say(1)` and most recorders emit.
 *
 * @throws Error naming what was found, when the file is not a WAVE we can read.
 */
export function decodeWav(bytes: Uint8Array): DecodedAudio {
  if (bytes.length < 44 || ascii(bytes, 0, 4) !== 'RIFF' || ascii(bytes, 8, 4) !== 'WAVE') {
    throw new Error(
      `The audio is not a RIFF/WAVE file: it begins with ${JSON.stringify(
        ascii(bytes, 0, 4),
      )}. Supply WAV bytes, or a mediaType this build can decode.`,
    );
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chunks = riffChunks(view, bytes);
  const fmt = chunks.find((chunk) => chunk.id === 'fmt ');
  const data = chunks.find((chunk) => chunk.id === 'data');
  if (fmt === undefined || data === undefined) {
    throw new Error(
      `The WAVE file is missing its ${fmt === undefined ? '"fmt "' : '"data"'} chunk; ` +
        `it has ${chunks.map((chunk) => JSON.stringify(chunk.id)).join(', ') || 'none'}.`,
    );
  }

  let format = view.getUint16(fmt.offset, true);
  const channels = view.getUint16(fmt.offset + 2, true);
  const sampleRate = view.getUint32(fmt.offset + 4, true);
  const bitsPerSample = view.getUint16(fmt.offset + 14, true);
  if (format === WAVE_FORMAT_EXTENSIBLE && fmt.size >= 40) {
    // The real tag is the first two bytes of the extensible sub-format GUID.
    format = view.getUint16(fmt.offset + 24, true);
  }

  if (channels === 0 || sampleRate === 0) {
    throw new Error(`The WAVE header is not usable: ${channels} channels at ${sampleRate} Hz.`);
  }

  const end = Math.min(bytes.length, data.offset + data.size);
  const usable = end - data.offset;
  const bytesPerSample = bitsPerSample / 8;
  const frameBytes = bytesPerSample * channels;
  if (frameBytes <= 0 || usable < frameBytes) {
    throw new Error(
      `The WAVE file declares ${bitsPerSample}-bit samples in ${channels} channels but carries ` +
        `${usable} bytes of audio, which is less than one frame.`,
    );
  }
  const frames = Math.floor(usable / frameBytes);

  const read = readerFor(format, bitsPerSample, view);
  const interleaved = new Float32Array(frames * channels);
  for (let i = 0; i < frames * channels; i += 1) {
    interleaved[i] = read(data.offset + i * bytesPerSample);
  }

  const warnings: string[] = [];
  const mono = downmix(interleaved, channels);
  if (channels > 1) warnings.push(`Mixed ${channels} channels down to mono for transcription.`);
  return { samples: mono, sampleRate, channels, warnings };
}

/** A per-sample reader for one WAVE encoding, or a refusal naming it. */
function readerFor(
  format: number,
  bitsPerSample: number,
  view: DataView,
): (offset: number) => number {
  if (format === WAVE_FORMAT_PCM) {
    switch (bitsPerSample) {
      // 8-bit WAVE is UNSIGNED; every other integer width is signed. Reading
      // it as signed is silent — it produces audio, just inverted and offset.
      case 8:
        return (offset) => (view.getUint8(offset) - 128) / 128;
      case 16:
        return (offset) => view.getInt16(offset, true) / 32768;
      case 24:
        return (offset) => {
          const raw =
            view.getUint8(offset) | (view.getUint8(offset + 1) << 8) | (view.getInt8(offset + 2) << 16);
          return raw / 8388608;
        };
      case 32:
        return (offset) => view.getInt32(offset, true) / 2147483648;
      default:
        break;
    }
  }
  if (format === WAVE_FORMAT_IEEE_FLOAT) {
    if (bitsPerSample === 32) return (offset) => view.getFloat32(offset, true);
    if (bitsPerSample === 64) return (offset) => view.getFloat64(offset, true);
  }
  throw new Error(
    `This build cannot decode WAVE format tag ${format} at ${bitsPerSample} bits per sample. ` +
      'Supported: PCM 8/16/24/32-bit and IEEE float 32/64-bit.',
  );
}

function downmix(interleaved: Float32Array, channels: number): Float32Array {
  if (channels === 1) return interleaved;
  const frames = Math.floor(interleaved.length / channels);
  const mono = new Float32Array(frames);
  for (let frame = 0; frame < frames; frame += 1) {
    let sum = 0;
    for (let channel = 0; channel < channels; channel += 1) {
      sum += interleaved[frame * channels + channel] ?? 0;
    }
    mono[frame] = sum / channels;
  }
  return mono;
}

/**
 * Linear resampling to `target` Hz.
 *
 * Linear interpolation, and that is a compromise stated rather than hidden: it
 * does not band-limit, so downsampling aliases energy above the new Nyquist
 * back into the passband. For 44.1/48 kHz speech going to 16 kHz the aliased
 * band is mostly sibilance, and whisper-base tolerates it; a proper polyphase
 * filter would be better and is not written here. The honest mitigation is
 * that the caller is TOLD, through `warnings`, whenever this ran.
 */
export function resample(samples: Float32Array, from: number, to: number): Float32Array {
  if (from === to) return samples;
  if (samples.length === 0) return samples;
  const ratio = from / to;
  const length = Math.max(1, Math.round(samples.length / ratio));
  const out = new Float32Array(length);
  for (let i = 0; i < length; i += 1) {
    const position = i * ratio;
    const left = Math.floor(position);
    const right = Math.min(samples.length - 1, left + 1);
    const fraction = position - left;
    out[i] = (samples[left] ?? 0) * (1 - fraction) + (samples[right] ?? 0) * fraction;
  }
  return out;
}

/**
 * Base64 audio of a declared media type, as mono float32 at `targetRate`.
 *
 * @param audio - base64 (or a `data:` URL), as `TranscribeOptions.audio`.
 * @param mediaType - the caller's declared type. Parameters are ignored except
 *   `rate` on the raw-PCM types, which have no header to carry it.
 * @param targetRate - the rate the model wants; 16000 for Whisper.
 * @throws Error naming the media type, when it is one we cannot decode.
 */
export function decodeAudio(
  audio: string,
  mediaType: string,
  targetRate: number,
): DecodedAudio {
  const bytes = decodeBase64(audio);
  const type = baseType(mediaType);
  const warnings: string[] = [];

  let decoded: DecodedAudio;
  if (WAV_TYPES.has(type)) {
    decoded = decodeWav(bytes);
  } else if (type === 'audio/l16' || type === 'audio/pcm' || type === 'audio/x-pcm') {
    // Headerless signed 16-bit little-endian PCM. The rate has to come from
    // the media-type parameter, because there is nothing else to read it from.
    const rate = Number.parseInt(rateParameter(mediaType) ?? '', 10);
    if (!Number.isFinite(rate) || rate <= 0) {
      throw new Error(
        `"${type}" carries no header, so its sample rate must be declared as a media-type ` +
          'parameter, e.g. "audio/l16;rate=16000".',
      );
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const samples = new Float32Array(Math.floor(bytes.length / 2));
    for (let i = 0; i < samples.length; i += 1) samples[i] = view.getInt16(i * 2, true) / 32768;
    decoded = { samples, sampleRate: rate, channels: 1, warnings: [] };
  } else {
    throw new Error(
      `This build cannot decode "${mediaType || '(no media type)'}". It reads WAV ` +
        '(audio/wav) and headerless PCM (audio/l16;rate=…). Compressed containers — mp3, ' +
        'm4a, ogg, webm — need a decoder this process does not have.',
    );
  }

  warnings.push(...decoded.warnings);
  if (decoded.sampleRate !== targetRate) {
    warnings.push(
      `Resampled from ${decoded.sampleRate} Hz to ${targetRate} Hz with linear interpolation, ` +
        'which does not band-limit; transcription of very noisy audio may suffer.',
    );
  }

  return {
    samples: resample(decoded.samples, decoded.sampleRate, targetRate),
    sampleRate: targetRate,
    channels: decoded.channels,
    warnings,
  };
}

/** The `rate=` media-type parameter, if there is one. */
function rateParameter(mediaType: string): string | undefined {
  for (const part of mediaType.split(';').slice(1)) {
    const [key, value] = part.split('=');
    if ((key ?? '').trim().toLowerCase() === 'rate') return (value ?? '').trim();
  }
  return undefined;
}
