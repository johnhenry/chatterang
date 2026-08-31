// @vitest-environment node
/**
 * THE TRANSCRIPTION NOBODY HAD EVER RUN.
 *
 * Every other ONNX test in this repo drives a fake engine, which is the right
 * default — it makes the contract translation testable without 283 MB of
 * native binding and 280 MB of weights. But a fake engine cannot tell you
 * whether the mel filterbank is the one Whisper was trained on, and a mel
 * filterbank that is close but not right does not fail: it produces a fluent
 * transcript of the wrong words. So this file exists to put a real recording
 * through the whole path:
 *
 *   WAV bytes -> decodeAudio -> logMelSpectrogram (our FFT, our filterbank)
 *     -> encoder_model.onnx           — onnxruntime-node, a real graph
 *     -> decoder_model_merged.onnx    — with a real KV cache, step by step
 *     -> Whisper's timestamp grammar  — our suppression and segment rules
 *     -> WhisperTokenizer.decode      — byte-level BPE, back to text
 *
 * and assert that the text is the words that were actually spoken.
 *
 * OPT-IN, AND LOUD ABOUT IT. The weights are not in this repo and must not be
 * downloaded, so the suite runs only when `CHATTERANG_TEST_WHISPER` names a
 * Whisper ONNX directory. Skipping is the default and is visible in vitest's
 * own output; what is NOT allowed is the third state — a test that reports
 * green without having observed anything. Two things guard that:
 *
 *   - the gate is a pure function, tested unconditionally below, so "unset
 *     means skip" is asserted rather than assumed;
 *   - a variable that IS set but names nothing usable FAILS, naming the file
 *     it could not find. A typo must not read as "no model on this machine".
 *
 * THE AUDIO IS A FIXTURE, NOT A DOWNLOAD. `tests/fixtures/whisper-speech-16k.wav`
 * is 7.8 seconds of macOS `say(1)` output, 16 kHz mono PCM, recorded with the
 * command in `SPOKEN_COMMAND` below. Synthetic speech is a fair test of the
 * front end — it is real audio with real formants — and it makes the expected
 * transcript exact rather than a judgement call.
 */

import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { OnnxSession, TranscriptionEndEvent } from '@chatterang/contracts';
import { OnnxRuntimeNode } from '@chatterang/onnx-node';

export const WHISPER_ENV = 'CHATTERANG_TEST_WHISPER';

/** How `tests/fixtures/whisper-speech-16k.wav` was made, so it can be remade. */
const SPOKEN_COMMAND =
  'say -o tests/fixtures/whisper-speech-16k.wav --data-format=LEI16@16000 ' +
  '"The desktop shell forks a utility process for inference. ' +
  'Every generation ends exactly once, whatever happens to the host."';

/** The words in the fixture, lowercased and stripped of punctuation. */
const SPOKEN_WORDS =
  'the desktop shell forks a utility process for inference every generation ends exactly ' +
  'once whatever happens to the host';

/**
 * The Whisper directory this run should use, or `undefined` to skip.
 *
 * @param env - the process environment to read.
 * @returns the absolute pipeline directory, or `undefined` when the suite must
 *   skip.
 * @throws Error when the variable is set but does not name a directory holding
 *   an encoder, a merged decoder and a tokenizer — a typo, or a directory that
 *   is some other model's, must not be indistinguishable from "no model here".
 */
export function resolveTestWhisper(env: NodeJS.ProcessEnv): string | undefined {
  const raw = env[WHISPER_ENV];
  if (raw === undefined) return undefined;
  const root = raw.trim();
  if (root.length === 0) return undefined;

  try {
    if (!statSync(root).isDirectory()) throw new Error('not a directory');
  } catch (cause) {
    throw new Error(
      `${WHISPER_ENV} is set to ${JSON.stringify(root)} but that is not a readable directory. ` +
        'Unset it to skip this suite; a wrong path must not read as "no model here".',
      { cause },
    );
  }

  // The same two layouts `OnnxRuntimeNode.createSession` looks in. Checked
  // HERE as well so the failure names the missing file rather than surfacing
  // as a session that would not create.
  const missing = ['encoder_model.onnx', 'decoder_model_merged.onnx', 'tokenizer.json'].filter(
    (name) =>
      ![join(root, name), join(root, 'onnx', name)].some((path) => {
        try {
          return statSync(path).isFile();
        } catch {
          return false;
        }
      }),
  );
  if (missing.length > 0) {
    throw new Error(
      `${WHISPER_ENV} names ${JSON.stringify(root)}, but it holds no ${missing.join(', ')}. ` +
        'Point it at a Whisper ONNX export (encoder_model.onnx, decoder_model_merged.onnx and ' +
        'tokenizer.json, at the root or under onnx/).',
    );
  }
  return root;
}

/**
 * A gate failure, held rather than thrown at module scope.
 *
 * Thrown at module scope it would be a COLLECTION error, which some reporters
 * render indistinguishably from "this file was skipped" — the exact state this
 * gate exists to make impossible. Held here, it is asserted by a test below,
 * so a typo in the variable is a red test with the reason in it.
 */
let GATE_ERROR: unknown;

const WHISPER = ((): string | undefined => {
  try {
    return resolveTestWhisper(process.env);
  } catch (error) {
    GATE_ERROR = error;
    return undefined;
  }
})();

const FIXTURE = new URL('./fixtures/whisper-speech-16k.wav', import.meta.url);

/** Comparable form: lowercase, letters and spaces only. */
function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

describe('the opt-in gate', () => {
  it('skips when the variable is unset or blank', () => {
    expect(resolveTestWhisper({})).toBeUndefined();
    expect(resolveTestWhisper({ [WHISPER_ENV]: '   ' })).toBeUndefined();
  });

  it('FAILS when the variable names a directory that is not there', () => {
    expect(() =>
      resolveTestWhisper({ [WHISPER_ENV]: '/nowhere/at/all/whisper-base' }),
    ).toThrowError(/not a readable directory/);
  });

  it('FAILS when the directory exists but holds no Whisper', () => {
    // `tests/` is a real directory with none of the three files in it, which
    // is exactly the "pointed at the wrong place" case.
    expect(() =>
      resolveTestWhisper({ [WHISPER_ENV]: new URL('.', import.meta.url).pathname }),
    ).toThrowError(/holds no encoder_model\.onnx/);
  });

  it('did not swallow a gate error', () => {
    // If the variable IS set and resolution threw, that failure surfaces here
    // rather than as a silently skipped suite.
    expect(GATE_ERROR).toBeUndefined();
  });
});

describe.runIf(WHISPER !== undefined)(
  'a real Whisper transcription',
  () => {
    let plugin: OnnxRuntimeNode;
    let session: OnnxSession;
    let audio: string;

    beforeAll(async () => {
      plugin = new OnnxRuntimeNode();
      session = await plugin.createSession({ task: 'stt', modelPath: WHISPER! });
      audio = readFileSync(FIXTURE).toString('base64');
    }, 120_000);

    afterAll(async () => {
      await plugin?.dispose();
    });

    it('reports the execution providers the binary actually compiled in', async () => {
      const providers = await plugin.getExecutionProviders();
      // Never simulated: a real session either creates or the call fails.
      expect(providers.simulated).toBe(false);
      expect(providers.providers).toContain('cpu');
      expect(providers.preferred).toBe('cpu');
      // Nothing the Node binding cannot reach may be listed.
      expect(providers.providers).not.toContain('wasm');
      expect(providers.providers).not.toContain('nnapi');
      expect(providers.providers).not.toContain('xnnpack');
    });

    it('loaded two real graphs and measured the time it took', () => {
      expect(session.task).toBe('stt');
      expect(session.executionProvider).toBe('cpu');
      expect(session.loadMs).toBeGreaterThan(0);
      // No warnings: this export is exactly the layout the loader looks for.
      expect(session.warnings).toEqual([]);
    });

    it(
      `transcribes the words that were actually spoken (${SPOKEN_COMMAND.slice(0, 40)}…)`,
      async () => {
        const partials: string[] = [];
        const ends: TranscriptionEndEvent[] = [];
        await plugin.addListener('onnxPartial', (event) => partials.push(event.text));
        await plugin.addListener('onnxEnd', (event) => ends.push(event));

        const result = await plugin.transcribe({
          handle: session.handle,
          audio,
          mediaType: 'audio/wav',
          streamPartials: true,
          requestId: 'real-1',
        });

        // THE ASSERTION THIS FILE EXISTS FOR. A wrong mel filterbank, a wrong
        // KV cache or a wrong byte-level decode all still produce fluent
        // English; only the actual words distinguish them.
        expect(normalise(result.text)).toBe(SPOKEN_WORDS);
        expect(result.language).toBe('en');
        expect(result.requestId).toBe('real-1');

        // Real timestamps, not the shim's {0, 0}. The fixture is 7.82 s.
        expect(result.segments.length).toBeGreaterThanOrEqual(1);
        const last = result.segments.at(-1)!;
        expect(last.end).toBeGreaterThan(1);
        expect(last.end).toBeLessThanOrEqual(8.1);
        for (const segment of result.segments) {
          expect(segment.end).toBeGreaterThanOrEqual(segment.start);
        }

        // Streaming really streamed, and ended exactly once.
        expect(partials.length).toBeGreaterThan(3);
        expect(normalise(partials.at(-1)!)).toBe(SPOKEN_WORDS);
        expect(ends).toHaveLength(1);
        expect(ends[0]!.error).toBeUndefined();
        expect(ends[0]!.text).toBe(result.text);

        await plugin.removeAllListeners();
      },
      120_000,
    );

    it('detects the language when the caller does not name one', async () => {
      const result = await plugin.transcribe({
        handle: session.handle,
        audio,
        mediaType: 'audio/wav',
        requestId: 'real-2',
      });
      expect(result.language).toBe('en');
    }, 120_000);

    it('releases the native sessions exactly once, and a second release is a no-op', async () => {
      const extra = await plugin.createSession({ task: 'stt', modelPath: WHISPER! });
      expect((await plugin.listLoaded()).handles).toContain(extra.handle);

      await plugin.releaseSession({ handle: extra.handle });
      // onnxruntime's own release() throws `Session already disposed.` on a
      // second call, so this only passes because the plugin latches.
      await expect(plugin.releaseSession({ handle: extra.handle })).resolves.toBeUndefined();
      expect((await plugin.listLoaded()).handles).not.toContain(extra.handle);
    }, 120_000);

    it('refuses to synthesise or diffuse rather than inventing output', async () => {
      await expect(
        plugin.synthesize({ handle: session.handle, text: 'hello', requestId: 'tts-1' }),
      ).rejects.toThrowError(/not implemented/);
      await expect(
        plugin.diffuse({ handle: session.handle, prompt: 'a cat', requestId: 'img-1' }),
      ).rejects.toThrowError(/not implemented/);
    });
  },
  180_000,
);
