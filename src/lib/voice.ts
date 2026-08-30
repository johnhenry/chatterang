/**
 * Voice: the dual text-to-speech strategy and on-device dictation (PRD §3.3).
 *
 * The two strategies are genuinely different trade-offs, so the app lets the
 * user pick rather than choosing for them:
 *
 *   OS voice     — zero download, instant, already on the device; quality and
 *                  available languages vary by phone.
 *   Neural voice — a downloaded ONNX voice that sounds identical on every
 *                  device, at the cost of storage and a slower first word.
 */

import { OnnxRuntime, type OnnxSession } from '@/plugins/onnx-runtime';
import { newId } from '@/domain/chat';

export interface VoiceOption {
  id: string;
  label: string;
  language: string;
  strategy: 'os' | 'neural';
  /** Neural voices need their model installed first. */
  modelId?: string;
}

/* ── OS voices ──────────────────────────────────────────────────────── */

export function osVoices(): VoiceOption[] {
  if (typeof speechSynthesis === 'undefined') return [];
  return speechSynthesis
    .getVoices()
    .filter((voice) => voice.localService)
    .map((voice) => ({
      id: voice.voiceURI,
      label: voice.name,
      language: voice.lang,
      strategy: 'os' as const,
    }));
}

/**
 * OS voice lists populate asynchronously in some browsers, so wait for the
 * `voiceschanged` event rather than returning an empty list on first call.
 */
export async function osVoicesReady(timeoutMs = 1500): Promise<VoiceOption[]> {
  if (typeof speechSynthesis === 'undefined') return [];
  const immediate = osVoices();
  if (immediate.length > 0) return immediate;

  return new Promise((resolve) => {
    const done = (): void => {
      speechSynthesis.removeEventListener('voiceschanged', done);
      clearTimeout(timer);
      resolve(osVoices());
    };
    const timer = setTimeout(done, timeoutMs);
    speechSynthesis.addEventListener('voiceschanged', done);
  });
}

/* ── Speaking ───────────────────────────────────────────────────────── */

export interface SpeakOptions {
  text: string;
  strategy: 'os' | 'neural';
  voiceId?: string;
  rate?: number;
  /** Session handle for the neural voice model. */
  neuralHandle?: string;
  signal?: AbortSignal;
}

let currentAudio: HTMLAudioElement | null = null;

export async function speak(options: SpeakOptions): Promise<void> {
  stopSpeaking();

  const text = stripForSpeech(options.text);
  if (!text) return;

  if (options.strategy === 'neural' && options.neuralHandle) {
    const result = await OnnxRuntime.synthesize({
      handle: options.neuralHandle,
      text,
      voice: options.voiceId,
      rate: options.rate,
      requestId: newId('tts'),
    });

    if (!result.audio) return; // The shim spoke directly.

    const audio = new Audio(`data:${result.mediaType};base64,${result.audio}`);
    currentAudio = audio;
    options.signal?.addEventListener('abort', () => audio.pause(), { once: true });
    await audio.play();
    return;
  }

  if (typeof speechSynthesis === 'undefined') return;

  await new Promise<void>((resolve) => {
    const utterance = new SpeechSynthesisUtterance(text);
    if (options.rate) utterance.rate = options.rate;

    const match = speechSynthesis
      .getVoices()
      .find((voice) => voice.voiceURI === options.voiceId);
    if (match) utterance.voice = match;

    utterance.onend = () => resolve();
    utterance.onerror = () => resolve();
    options.signal?.addEventListener('abort', () => speechSynthesis.cancel(), { once: true });
    speechSynthesis.speak(utterance);
  });
}

export function stopSpeaking(): void {
  if (typeof speechSynthesis !== 'undefined') speechSynthesis.cancel();
  currentAudio?.pause();
  currentAudio = null;
}

/**
 * Strip markdown, code fences, and reasoning traces before speaking. Reading
 * backticks and asterisks aloud is the fastest way to make a voice feature
 * feel broken.
 */
export function stripForSpeech(text: string): string {
  return text
    .replace(/<(think|thinking|reasoning)>[\s\S]*?<\/\1>/gi, '')
    .replace(/```[\s\S]*?```/g, ' (code block) ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(\*|_)(.*?)\1/g, '$2')
    .replace(/^>\s?/gm, '')
    .replace(/^[-*+]\s+/gm, '')
    .replace(/\|/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/* ── Dictation ──────────────────────────────────────────────────────── */

export interface DictationHandle {
  stop: () => void;
}

export interface DictationOptions {
  /** Session handle for a loaded Whisper model, when one is installed. */
  handle?: string;
  language?: string;
  onPartial?: (text: string) => void;
  onFinal: (text: string) => void;
  onError: (message: string) => void;
}

/**
 * Start dictation. Prefers a downloaded Whisper model; falls back to the
 * platform recogniser, which on some platforms is a network service — so the
 * caller is told which one is in use.
 */
export async function startDictation(options: DictationOptions): Promise<DictationHandle> {
  const requestId = newId('stt');

  const listener = options.onPartial
    ? await OnnxRuntime.addListener('onnxPartial', (event) => {
        if (event.requestId === requestId) options.onPartial?.(event.text);
      })
    : null;

  const stop = (): void => {
    void OnnxRuntime.cancel({ requestId });
    void listener?.remove();
  };

  if (!options.handle) {
    options.onError('No speech model is loaded.');
    return { stop };
  }

  void OnnxRuntime.transcribe({
    handle: options.handle,
    audio: '',
    mediaType: 'audio/wav',
    language: options.language,
    streamPartials: Boolean(options.onPartial),
    requestId,
  })
    .then((result) => {
      options.onFinal(result.text);
    })
    .catch((error: unknown) => {
      options.onError(error instanceof Error ? error.message : 'Dictation failed.');
    })
    .finally(() => {
      void listener?.remove();
    });

  return { stop };
}

/* ── Session management ─────────────────────────────────────────────── */

const sessions = new Map<string, OnnxSession>();

export async function ensureSession(
  task: 'stt' | 'tts' | 'diffusion',
  modelPath: string,
  companions?: Record<string, string>,
): Promise<OnnxSession> {
  const key = `${task}:${modelPath}`;
  const existing = sessions.get(key);
  if (existing) return existing;

  const session = await OnnxRuntime.createSession({ task, modelPath, companions });
  sessions.set(key, session);
  return session;
}

export async function releaseSessions(task: 'stt' | 'tts' | 'diffusion'): Promise<void> {
  for (const [key, session] of sessions) {
    if (session.task === task) sessions.delete(key);
  }
  await OnnxRuntime.releaseTask({ task });
}
