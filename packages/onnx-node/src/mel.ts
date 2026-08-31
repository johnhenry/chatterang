/**
 * Whisper's log-mel front end, written out.
 *
 * The ONNX export starts at `input_features`: an 80 x 3000 log-mel
 * spectrogram. Everything before that — window, FFT, mel filterbank,
 * normalisation — is the caller's job and exists in no dependency this repo
 * has, so it is here.
 *
 * IT HAS TO BE EXACT, and that is why the filterbank is derived rather than
 * approximated. Whisper's `mel_filters.npz` is `librosa.filters.mel(sr=16000,
 * n_fft=400, n_mels=80, htk=False, norm='slaney')`, which is a closed form:
 * the Slaney mel scale (linear below 1 kHz, logarithmic above) sampled at
 * n_mels+2 points, triangular ramps between them, each row scaled by
 * `2 / (mel_f[i+2] - mel_f[i])`. A filterbank that is close but not right does
 * not fail — it produces a fluent transcript of the wrong words, which is the
 * exact plausible-looking-garbage failure this milestone was warned about. So
 * `tests/onnx-node.test.ts` pins the derived matrix against reference values
 * rather than trusting the derivation.
 *
 * The FFT is Bluestein's algorithm, because Whisper's `n_fft` is 400 and 400
 * is not a power of two. Zero-padding to 512 was the tempting shortcut and is
 * wrong: it changes the frequency grid the filterbank is defined on.
 */

/** Whisper's fixed front-end geometry, from `preprocessor_config.json`. */
export const SAMPLE_RATE = 16000;
export const N_FFT = 400;
export const HOP_LENGTH = 160;
/** 30 seconds. Whisper's encoder has no other input length. */
export const N_SAMPLES = 480000;
export const N_FRAMES = 3000;

/* ── FFT ──────────────────────────────────────────────────────────────── */

/** In-place radix-2 Cooley-Tukey. `re`/`im` must be a power-of-two length. */
function fftRadix2(re: Float64Array, im: Float64Array, inverse: boolean): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i += 1) {
    let bit = n >> 1;
    for (; (j & bit) !== 0; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i]!;
      re[i] = re[j]!;
      re[j] = tr;
      const ti = im[i]!;
      im[i] = im[j]!;
      im[j] = ti;
    }
  }

  const sign = inverse ? 1 : -1;
  for (let length = 2; length <= n; length <<= 1) {
    const angle = (sign * 2 * Math.PI) / length;
    const wr = Math.cos(angle);
    const wi = Math.sin(angle);
    for (let start = 0; start < n; start += length) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < length / 2; k += 1) {
        const a = start + k;
        const b = a + length / 2;
        const xr = re[b]! * cr - im[b]! * ci;
        const xi = re[b]! * ci + im[b]! * cr;
        re[b] = re[a]! - xr;
        im[b] = im[a]! - xi;
        re[a] = re[a]! + xr;
        im[a] = im[a]! + xi;
        const nr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = nr;
      }
    }
  }

  if (inverse) {
    for (let i = 0; i < n; i += 1) {
      re[i] = re[i]! / n;
      im[i] = im[i]! / n;
    }
  }
}

/**
 * A DFT of an arbitrary length, via Bluestein's chirp-z transform.
 *
 * The chirp angle uses `n² mod 2N` rather than `n²`: the exponential has
 * period `2N` in `n²`, and at N=400 the raw square reaches 160000, where the
 * multiply by π/N throws away bits that the triangle ramps then notice.
 */
export class Dft {
  readonly #n: number;
  readonly #chirpRe: Float64Array;
  readonly #chirpIm: Float64Array;
  readonly #kernelRe: Float64Array;
  readonly #kernelIm: Float64Array;
  readonly #ar: Float64Array;
  readonly #ai: Float64Array;

  constructor(n: number) {
    this.#n = n;
    let m = 1;
    while (m < 2 * n - 1) m <<= 1;

    this.#chirpRe = new Float64Array(n);
    this.#chirpIm = new Float64Array(n);
    for (let i = 0; i < n; i += 1) {
      const angle = (-Math.PI * ((i * i) % (2 * n))) / n;
      this.#chirpRe[i] = Math.cos(angle);
      this.#chirpIm[i] = Math.sin(angle);
    }

    // b[i] = conj(chirp[i]), extended evenly around the circular buffer.
    const br = new Float64Array(m);
    const bi = new Float64Array(m);
    br[0] = this.#chirpRe[0]!;
    bi[0] = -this.#chirpIm[0]!;
    for (let i = 1; i < n; i += 1) {
      br[i] = this.#chirpRe[i]!;
      bi[i] = -this.#chirpIm[i]!;
      br[m - i] = br[i]!;
      bi[m - i] = bi[i]!;
    }
    fftRadix2(br, bi, false);
    this.#kernelRe = br;
    this.#kernelIm = bi;

    this.#ar = new Float64Array(m);
    this.#ai = new Float64Array(m);
  }

  /**
   * Transform one real frame.
   *
   * @param input - `n` real samples.
   * @param outRe - receives the real parts of bins `0..bins-1`.
   * @param outIm - receives the imaginary parts.
   * @param bins - how many bins to write; Whisper wants `n/2 + 1`.
   */
  realForward(input: Float64Array, outRe: Float64Array, outIm: Float64Array, bins: number): void {
    const { length } = this.#ar;
    this.#ar.fill(0);
    this.#ai.fill(0);
    for (let i = 0; i < this.#n; i += 1) {
      const x = input[i]!;
      this.#ar[i] = x * this.#chirpRe[i]!;
      this.#ai[i] = x * this.#chirpIm[i]!;
    }
    fftRadix2(this.#ar, this.#ai, false);
    for (let i = 0; i < length; i += 1) {
      const r = this.#ar[i]! * this.#kernelRe[i]! - this.#ai[i]! * this.#kernelIm[i]!;
      const im = this.#ar[i]! * this.#kernelIm[i]! + this.#ai[i]! * this.#kernelRe[i]!;
      this.#ar[i] = r;
      this.#ai[i] = im;
    }
    fftRadix2(this.#ar, this.#ai, true);
    for (let k = 0; k < bins; k += 1) {
      outRe[k] = this.#ar[k]! * this.#chirpRe[k]! - this.#ai[k]! * this.#chirpIm[k]!;
      outIm[k] = this.#ar[k]! * this.#chirpIm[k]! + this.#ai[k]! * this.#chirpRe[k]!;
    }
  }
}

/* ── Mel filterbank ───────────────────────────────────────────────────── */

/** Slaney mel: linear to 1 kHz at 200/3 Hz per mel, logarithmic above. */
export function hzToMel(hz: number): number {
  const fSp = 200 / 3;
  const minLogHz = 1000;
  const minLogMel = minLogHz / fSp;
  const logStep = Math.log(6.4) / 27;
  return hz < minLogHz ? hz / fSp : minLogMel + Math.log(hz / minLogHz) / logStep;
}

export function melToHz(mel: number): number {
  const fSp = 200 / 3;
  const minLogHz = 1000;
  const minLogMel = minLogHz / fSp;
  const logStep = Math.log(6.4) / 27;
  return mel < minLogMel ? mel * fSp : minLogHz * Math.exp(logStep * (mel - minLogMel));
}

/**
 * `librosa.filters.mel(sr, n_fft, n_mels, htk=False, norm='slaney')`.
 *
 * @returns `nMels` rows of `n_fft/2 + 1` weights, flattened row-major.
 */
export function melFilterBank(
  sampleRate: number,
  nFft: number,
  nMels: number,
): Float64Array {
  const bins = Math.floor(nFft / 2) + 1;
  const fftFreqs = new Float64Array(bins);
  for (let i = 0; i < bins; i += 1) fftFreqs[i] = (i * sampleRate) / nFft;

  const minMel = hzToMel(0);
  const maxMel = hzToMel(sampleRate / 2);
  const melPoints = new Float64Array(nMels + 2);
  for (let i = 0; i < nMels + 2; i += 1) {
    melPoints[i] = melToHz(minMel + ((maxMel - minMel) * i) / (nMels + 1));
  }

  const weights = new Float64Array(nMels * bins);
  for (let mel = 0; mel < nMels; mel += 1) {
    const lowerEdge = melPoints[mel]!;
    const centre = melPoints[mel + 1]!;
    const upperEdge = melPoints[mel + 2]!;
    const lowerWidth = centre - lowerEdge;
    const upperWidth = upperEdge - centre;
    // Slaney normalisation: each triangle carries unit area in frequency, so
    // a wide high-frequency band does not out-weigh a narrow low one.
    const enorm = 2 / (upperEdge - lowerEdge);
    for (let bin = 0; bin < bins; bin += 1) {
      const freq = fftFreqs[bin]!;
      const lower = (freq - lowerEdge) / lowerWidth;
      const upper = (upperEdge - freq) / upperWidth;
      const value = Math.max(0, Math.min(lower, upper));
      weights[mel * bins + bin] = value * enorm;
    }
  }
  return weights;
}

/* ── The spectrogram ──────────────────────────────────────────────────── */

/** Periodic Hann, which is what `torch.hann_window` builds by default. */
function hannWindow(size: number): Float64Array {
  const window = new Float64Array(size);
  for (let i = 0; i < size; i += 1) window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size);
  return window;
}

/**
 * `x` padded or trimmed to exactly 30 seconds, then reflection-padded by
 * `nFft/2` on each side — `torch.stft(..., center=True)`'s own padding.
 */
function centeredWindow(samples: Float32Array, nSamples: number, pad: number): Float64Array {
  const padded = new Float64Array(nSamples + 2 * pad);
  const count = Math.min(samples.length, nSamples);
  for (let i = 0; i < count; i += 1) padded[pad + i] = samples[i]!;
  // Reflect WITHOUT repeating the edge sample, matching torch's 'reflect'.
  for (let i = 1; i <= pad; i += 1) {
    padded[pad - i] = padded[pad + i]!;
    padded[pad + nSamples - 1 + i] = padded[pad + nSamples - 1 - i]!;
  }
  return padded;
}

export interface LogMelOptions {
  readonly nMels: number;
  readonly nSamples?: number;
  readonly nFrames?: number;
}

/**
 * Whisper's `input_features`: `nMels x nFrames`, flattened row-major.
 *
 * Steps, in Whisper's own order: 30-second pad/trim, centred STFT with a
 * periodic Hann window, power spectrum, mel projection, `log10` with a 1e-10
 * floor, a dynamic-range clamp 8 decades below the maximum, and the affine
 * `(x + 4) / 4`.
 */
export function logMelSpectrogram(
  samples: Float32Array,
  options: LogMelOptions,
): Float32Array {
  const nMels = options.nMels;
  const nSamples = options.nSamples ?? N_SAMPLES;
  const nFrames = options.nFrames ?? N_FRAMES;
  const bins = N_FFT / 2 + 1;

  const window = hannWindow(N_FFT);
  const padded = centeredWindow(samples, nSamples, N_FFT / 2);
  const filters = melFilterBank(SAMPLE_RATE, N_FFT, nMels);

  const dft = new Dft(N_FFT);
  const frame = new Float64Array(N_FFT);
  const re = new Float64Array(bins);
  const im = new Float64Array(bins);
  const power = new Float64Array(bins);

  const mel = new Float64Array(nMels * nFrames);
  let maximum = -Infinity;

  for (let t = 0; t < nFrames; t += 1) {
    const offset = t * HOP_LENGTH;
    for (let i = 0; i < N_FFT; i += 1) frame[i] = padded[offset + i]! * window[i]!;
    dft.realForward(frame, re, im, bins);
    for (let k = 0; k < bins; k += 1) power[k] = re[k]! * re[k]! + im[k]! * im[k]!;

    for (let m = 0; m < nMels; m += 1) {
      let sum = 0;
      const row = m * bins;
      for (let k = 0; k < bins; k += 1) sum += filters[row + k]! * power[k]!;
      const value = Math.log10(Math.max(sum, 1e-10));
      mel[m * nFrames + t] = value;
      if (value > maximum) maximum = value;
    }
  }

  const floor = maximum - 8;
  const features = new Float32Array(nMels * nFrames);
  for (let i = 0; i < features.length; i += 1) {
    features[i] = (Math.max(mel[i]!, floor) + 4) / 4;
  }
  return features;
}
