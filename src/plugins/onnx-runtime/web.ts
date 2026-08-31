/**
 * Web implementation of `plugin-onnx-runtime`.
 *
 * Same honesty rule as the llama.cpp shim: use a real browser capability
 * where one exists, and clearly label what is synthesised.
 *
 *  - TTS uses `speechSynthesis`, which really is an on-device OS voice.
 *  - STT uses the browser's SpeechRecognition when present, otherwise
 *    returns a labelled placeholder transcript.
 *  - Diffusion renders a deterministic procedural image from the prompt on a
 *    canvas. It is not a diffusion model, and the result is tagged as such.
 */

import { WebPlugin } from '@capacitor/core';
import type {
  DiffuseOptions,
  DiffuseResult,
  OnnxExecutionProvider,
  OnnxRuntimePlugin,
  OnnxSession,
  OnnxSessionOptions,
  OnnxTask,
  SynthesizeOptions,
  SynthesizeResult,
  TranscribeOptions,
  TranscribeResult,
} from './definitions';

interface SpeechRecognitionLike {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  start(): void;
  stop(): void;
  onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onend: (() => void) | null;
}

function getSpeechRecognition(): (new () => SpeechRecognitionLike) | null {
  const w = globalThis as {
    SpeechRecognition?: new () => SpeechRecognitionLike;
    webkitSpeechRecognition?: new () => SpeechRecognitionLike;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export class OnnxRuntimeWeb extends WebPlugin implements OnnxRuntimePlugin {
  #sessions = new Map<string, OnnxSession>();
  #cancelled = new Set<string>();
  #counter = 0;

  async getExecutionProviders(): Promise<{
    providers: OnnxExecutionProvider[];
    preferred: OnnxExecutionProvider;
    simulated: boolean;
  }> {
    const providers: OnnxExecutionProvider[] = ['wasm'];
    if ('gpu' in navigator) providers.unshift('webgpu');
    return {
      providers,
      preferred: providers[0] ?? 'wasm',
      simulated: true,
    };
  }

  async createSession(options: OnnxSessionOptions): Promise<OnnxSession> {
    const started = performance.now();
    const handle = `onnx_${options.task}_${++this.#counter}`;
    const warnings: string[] = [];

    if (options.task === 'tts' && typeof speechSynthesis === 'undefined') {
      warnings.push('No speech synthesis available in this browser.');
    }
    if (options.task === 'stt' && !getSpeechRecognition()) {
      warnings.push('No speech recognition available in this browser.');
    }
    if (options.task === 'diffusion') {
      warnings.push('Image generation on the web shim is procedural, not diffusion.');
    }

    const session: OnnxSession = {
      handle,
      task: options.task,
      executionProvider: options.executionProvider ?? ('gpu' in navigator ? 'webgpu' : 'wasm'),
      loadMs: Math.round(performance.now() - started),
      warnings,
    };
    this.#sessions.set(handle, session);
    return session;
  }

  async releaseSession({ handle }: { handle: string }): Promise<void> {
    this.#sessions.delete(handle);
  }

  async releaseTask({ task }: { task: OnnxTask }): Promise<void> {
    for (const [handle, session] of this.#sessions) {
      if (session.task === task) this.#sessions.delete(handle);
    }
  }

  /**
   * Ends with exactly one `onnxEnd`, on every path.
   *
   * The event was added to the contract for the Node backend, whose desktop
   * supervisor needs a terminal event to end a turn on. A contract event the
   * SHIM never fires would be the same hazard one layer down — a listener
   * written against the contract would work on desktop and wait forever on the
   * web — so it is emitted here too, including on the no-recogniser path.
   */
  async transcribe(options: TranscribeOptions): Promise<TranscribeResult> {
    const Recognition = getSpeechRecognition();
    const started = performance.now();
    let settled = false;
    const finish = (result: TranscribeResult, error?: string): TranscribeResult => {
      if (!settled) {
        settled = true;
        this.notifyListeners('onnxEnd', error === undefined ? result : { ...result, error });
      }
      return result;
    };

    if (!Recognition) {
      const text = '[No on-device speech recognition available in this browser.]';
      return finish(
        {
          requestId: options.requestId,
          text,
          language: options.language ?? 'en',
          durationMs: Math.round(performance.now() - started),
          segments: [{ start: 0, end: 0, text }],
        },
        'No on-device speech recognition is available in this browser.',
      );
    }

    // The browser API listens to the live microphone rather than a buffer, so
    // this path is used by the live dictation flow, not file transcription.
    const text = await new Promise<string>((resolve) => {
      const recognition = new Recognition();
      recognition.lang = options.language ?? 'en-US';
      recognition.interimResults = Boolean(options.streamPartials);
      recognition.continuous = false;

      let latest = '';
      recognition.onresult = (event) => {
        latest = Array.from({ length: event.results.length }, (_, i) => {
          const result = event.results[i];
          return result?.[0]?.transcript ?? '';
        }).join('');
        if (options.streamPartials) {
          this.notifyListeners('onnxPartial', { requestId: options.requestId, text: latest });
        }
      };
      recognition.onerror = () => resolve(latest);
      recognition.onend = () => resolve(latest);
      recognition.start();
    });

    return finish({
      requestId: options.requestId,
      text,
      language: options.language ?? 'en',
      durationMs: Math.round(performance.now() - started),
      // Still {0, 0}: the browser recogniser reports no timings at all, and
      // inventing them would make the shim look like the Node backend, which
      // measures them. See `packages/onnx-node` for real segment boundaries.
      segments: [{ start: 0, end: 0, text }],
    });
  }

  async synthesize(options: SynthesizeOptions): Promise<SynthesizeResult> {
    const started = performance.now();

    if (typeof speechSynthesis !== 'undefined') {
      await new Promise<void>((resolve) => {
        const utterance = new SpeechSynthesisUtterance(options.text);
        if (options.rate) utterance.rate = options.rate;
        if (options.pitch) utterance.pitch = options.pitch;
        const voices = speechSynthesis.getVoices();
        const match = options.voice
          ? voices.find((voice) => voice.voiceURI === options.voice || voice.name === options.voice)
          : undefined;
        if (match) utterance.voice = match;
        utterance.onend = () => resolve();
        utterance.onerror = () => resolve();
        speechSynthesis.speak(utterance);
      });
    }

    // The browser speaks directly; there is no PCM buffer to hand back.
    return {
      requestId: options.requestId,
      audio: '',
      mediaType: 'audio/wav',
      sampleRate: 22050,
      durationMs: Math.round(performance.now() - started),
    };
  }

  async diffuse(options: DiffuseOptions): Promise<DiffuseResult> {
    const started = performance.now();
    const width = options.width ?? 512;
    const height = options.height ?? 512;
    const steps = options.steps ?? 20;
    const seed = options.seed ?? hashString(options.prompt);
    this.#cancelled.delete(options.requestId);

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas is unavailable, so image generation cannot run.');

    let cursor = seed >>> 0;
    const rand = (): number => {
      cursor = (cursor * 1664525 + 1013904223) >>> 0;
      return cursor / 0xffffffff;
    };

    // Field of soft radial washes, seeded from the prompt. Reveals
    // progressively so the progress events are real, not faked timings.
    const hueBase = Math.round(rand() * 360);
    ctx.fillStyle = `hsl(${hueBase} 24% 8%)`;
    ctx.fillRect(0, 0, width, height);

    for (let step = 1; step <= steps; step += 1) {
      if (this.#cancelled.has(options.requestId)) break;

      const blobs = 3;
      for (let i = 0; i < blobs; i += 1) {
        const x = rand() * width;
        const y = rand() * height;
        const radius = (0.08 + rand() * 0.34) * Math.min(width, height);
        const hue = (hueBase + rand() * 120 - 60 + 360) % 360;
        const gradient = ctx.createRadialGradient(x, y, 0, x, y, radius);
        gradient.addColorStop(0, `hsl(${hue} ${40 + rand() * 45}% ${45 + rand() * 25}% / 0.30)`);
        gradient.addColorStop(1, `hsl(${hue} 50% 20% / 0)`);
        ctx.fillStyle = gradient;
        ctx.beginPath();
        ctx.arc(x, y, radius, 0, Math.PI * 2);
        ctx.fill();
      }

      this.notifyListeners('onnxProgress', {
        requestId: options.requestId,
        step,
        totalSteps: steps,
      });
      await new Promise((resolve) => setTimeout(resolve, 40));
    }

    return {
      requestId: options.requestId,
      image: canvas.toDataURL('image/png').split(',')[1] ?? '',
      mediaType: 'image/png',
      width,
      height,
      steps,
      seed,
      durationMs: Math.round(performance.now() - started),
      peakMemoryBytes: width * height * 4 * 8,
    };
  }

  async cancel({ requestId }: { requestId: string }): Promise<void> {
    this.#cancelled.add(requestId);
    if (typeof speechSynthesis !== 'undefined') speechSynthesis.cancel();
  }
}

function hashString(text: string): number {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}
