/**
 * Node implementation of `plugin-onnx-runtime`, over `onnxruntime-node`.
 *
 * WHAT IS REAL HERE, AND WHAT IS NOT. The web shim reports `simulated: true`
 * and the UI shows a banner, because faking output hides regressions. This
 * implementation reports `simulated: false`, and it has to earn that:
 *
 *  - `getExecutionProviders` reports what the loaded binary actually compiled
 *    in, not a platform table.
 *  - `createSession` opens real files, builds real `InferenceSession`s, and
 *    reports the load time it measured.
 *  - `releaseSession` / `releaseTask` really free native memory, exactly once.
 *  - `transcribe` runs a real Whisper: mel front end, encoder, merged decoder
 *    with a KV cache, Whisper's timestamp grammar, real segment boundaries.
 *  - `synthesize` and `diffuse` REFUSE. Piper and diffusion are not in this
 *    milestone, and a `synthesize` that returned silence or a `diffuse` that
 *    returned a gradient would be the shim's dishonesty with a native addon
 *    behind it. They throw a message saying so. `createSession` still loads a
 *    tts or diffusion graph — that part is real and worth having — and warns
 *    that no pipeline will run it.
 *
 * The engine reaches this class through the `OnnxEngine` interface rather than
 * by import, which is what makes the contract translation testable without
 * 283 MB of native binding and 280 MB of weights on the machine running
 * `npm test`.
 */

import { readFile, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';

import type {
  DiffuseOptions,
  DiffuseResult,
  DiffusionProgressEvent,
  ListenerHandle,
  OnnxExecutionProvider,
  OnnxRuntimePlugin,
  OnnxSession,
  OnnxSessionOptions,
  OnnxTask,
  PartialTranscriptEvent,
  SynthesizeOptions,
  SynthesizeResult,
  TranscribeOptions,
  TranscribeResult,
  TranscriptionEndEvent,
} from '@chatterang/contracts';

import { decodeAudio } from './audio.js';
import type { OnnxEngine, OnnxEngineFactory, OnnxGraph } from './engine.js';
import { SAMPLE_RATE } from './mel.js';
import { createOnnxRuntimeEngine } from './onnxruntime-node.js';
import { WhisperTokenizer } from './tokenizer.js';
import type { WhisperGenerationConfig, WhisperShape } from './whisper.js';
import { inspectWhisper, readGenerationConfig, runWhisper } from './whisper.js';

interface OnnxEventMap {
  onnxProgress: DiffusionProgressEvent;
  onnxPartial: PartialTranscriptEvent;
  onnxEnd: TranscriptionEndEvent;
}

/** A loaded Whisper: two graphs and the companions that make them decodable. */
interface LoadedWhisper {
  readonly encoder: OnnxGraph;
  readonly decoder: OnnxGraph;
  readonly tokenizer: WhisperTokenizer;
  readonly generation: WhisperGenerationConfig;
  readonly shape: WhisperShape;
}

interface LoadedSession {
  readonly session: OnnxSession;
  /** Every native session this handle owns, in release order. */
  readonly graphs: readonly OnnxGraph[];
  readonly whisper: LoadedWhisper | null;
  /**
   * Set by whichever of `releaseSession` / `releaseTask` / `dispose` gets here
   * first.
   *
   * onnxruntime's `release()` is NOT idempotent — a second call throws
   * `Session already disposed.` — so "releasing a handle twice is a no-op",
   * which every other lifecycle method in this repo promises, has to be made
   * true here rather than inherited.
   *
   * A STRUCTURAL BACKSTOP, and a no-op today: every caller removes the handle
   * from the map BEFORE awaiting the release, so a second call finds nothing.
   * That ordering is the real guarantee and `tests/onnx-node.test.ts` pins it
   * with a concurrent double-release. This flag is what stops a future edit
   * that reorders those two lines from becoming a double free — the same role
   * `finish` in `generate`'s `finally` plays for the terminal event.
   */
  released: boolean;
}

export interface OnnxRuntimeNodeOptions {
  /**
   * How to build the engine. Defaults to the real `onnxruntime-node`; tests
   * pass a fake so the contract translation runs without a native binding.
   */
  readonly createEngine?: OnnxEngineFactory;
}

/**
 * onnxruntime's provider names -> the contract's.
 *
 * `dml` (Windows) and `cuda` (Linux) have NO name in the contract's union, so
 * they map to nothing and are reported as a warning instead of being silently
 * dropped or misreported as `cpu`. `nnapi`, `xnnpack` and `wasm` exist in the
 * union and are unreachable from the Node binding, so they never appear.
 */
const PROVIDER_NAMES: Readonly<Record<string, OnnxExecutionProvider>> = Object.freeze({
  cpu: 'cpu',
  coreml: 'coreml',
  webgpu: 'webgpu',
});

/**
 * The provider a session gets when the caller does not ask for one.
 *
 * CPU, deliberately, and measured rather than assumed: on the whisper-base
 * encoder here CoreML is 3.4x SLOWER than CPU warm (435 ms against 128 ms),
 * adds 1.9 s to session load, and changes the numerics in the fourth decimal
 * place because it runs fp16 on the ANE. WebGPU was the fastest warm path
 * (85 ms) but was never validated against a reference transcript. So the
 * default is the one whose output we have checked, and the others are an
 * explicit opt-in.
 */
const DEFAULT_PROVIDER: OnnxExecutionProvider = 'cpu';

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class OnnxRuntimeNode implements OnnxRuntimePlugin {
  readonly #createEngine: OnnxEngineFactory;
  #engine: Promise<OnnxEngine> | null = null;
  readonly #handles = new Map<string, LoadedSession>();
  readonly #cancelled = new Set<string>();
  #counter = 0;

  /**
   * `onnxProgress` is never emitted, and that is the honest behaviour: it is
   * the diffusion step event, and `diffuse` refuses in this build. The slot
   * exists because the contract declares it.
   */
  readonly #listeners: { [K in keyof OnnxEventMap]: Set<(event: OnnxEventMap[K]) => void> } = {
    onnxProgress: new Set(),
    onnxPartial: new Set(),
    onnxEnd: new Set(),
  };

  constructor(options: OnnxRuntimeNodeOptions = {}) {
    this.#createEngine = options.createEngine ?? createOnnxRuntimeEngine;
  }

  /* ── Events ───────────────────────────────────────────────────────── */

  #emit<K extends keyof OnnxEventMap>(eventName: K, event: OnnxEventMap[K]): void {
    const listeners = this.#listeners[eventName] as Set<(event: OnnxEventMap[K]) => void>;
    // Snapshot: a listener that removes itself must not skip its neighbour.
    for (const listener of [...listeners]) {
      try {
        listener(event);
      } catch {
        // A throwing listener is the listener's problem. Letting it escape
        // here would abort a transcription — and, worse, skip the terminal
        // event, which is the one thing the wire cannot recover from.
      }
    }
  }

  addListener(
    eventName: 'onnxProgress',
    listener: (event: DiffusionProgressEvent) => void,
  ): Promise<ListenerHandle>;
  addListener(
    eventName: 'onnxPartial',
    listener: (event: PartialTranscriptEvent) => void,
  ): Promise<ListenerHandle>;
  addListener(
    eventName: 'onnxEnd',
    listener: (event: TranscriptionEndEvent) => void,
  ): Promise<ListenerHandle>;
  async addListener(
    eventName: keyof OnnxEventMap,
    listener: (event: never) => void,
  ): Promise<ListenerHandle> {
    const listeners = this.#listeners[eventName] as Set<unknown>;
    listeners.add(listener);
    return {
      remove: async (): Promise<void> => {
        listeners.delete(listener);
      },
    };
  }

  async removeAllListeners(): Promise<void> {
    for (const listeners of Object.values(this.#listeners)) listeners.clear();
  }

  /* ── Providers ────────────────────────────────────────────────────── */

  async #getEngine(): Promise<OnnxEngine> {
    if (!this.#engine) {
      this.#engine = this.#createEngine().catch((error: unknown) => {
        // Do not cache a failure: a missing binary can be installed, and the
        // next call should get a fresh attempt.
        this.#engine = null;
        throw error;
      });
    }
    return this.#engine;
  }

  /**
   * What this build compiled in, translated into names the contract has.
   *
   * `simulated: false`: on Node a real session either creates or the call
   * fails; there is no synthesised path for this flag to warn about. What this
   * list does NOT promise is that every provider WORKS — CoreML is compiled in
   * here and its MLProgram mode fails outright on Whisper — which is why
   * `createSession` probes by trial and degrades with a warning.
   */
  async getExecutionProviders(): Promise<{
    providers: OnnxExecutionProvider[];
    preferred: OnnxExecutionProvider;
    simulated: boolean;
  }> {
    try {
      const engine = await this.#getEngine();
      const providers: OnnxExecutionProvider[] = [];
      for (const name of engine.listExecutionProviders()) {
        const mapped = PROVIDER_NAMES[name.toLowerCase()];
        if (mapped !== undefined && !providers.includes(mapped)) providers.push(mapped);
      }
      // NOT unshifted with `cpu`. Every real onnxruntime build has a CPU
      // provider, so adding one when the engine did not report it would never
      // be WRONG in practice — and that is exactly why it is removed: it made
      // "a provider with no contract name is dropped, not renamed" untestable,
      // because a `dml` mistakenly mapped onto `cpu` disappeared into an entry
      // that was there anyway.
      return {
        providers,
        preferred: providers.includes(DEFAULT_PROVIDER) ? DEFAULT_PROVIDER : providers[0] ?? DEFAULT_PROVIDER,
        simulated: false,
      };
    } catch {
      // No binary for this platform. Reporting an empty list beats reporting
      // providers that cannot be reached — and `createSession` will fail with
      // the real reason.
      return { providers: [], preferred: DEFAULT_PROVIDER, simulated: false };
    }
  }

  /* ── Session lifecycle ────────────────────────────────────────────── */

  /**
   * Open one graph on the requested provider, or on CPU with a warning.
   *
   * The fallback is the whole point: `listSupportedBackends()` reports what
   * was compiled in, not what will run this graph. A provider that cannot is
   * a performance loss, not a correctness one, so it degrades.
   */
  async #openGraph(
    engine: OnnxEngine,
    path: string,
    requested: OnnxExecutionProvider,
    threads: number | undefined,
    warnings: string[],
    /** Every graph opened by this `createSession`, in the order it opened. */
    opened: OnnxGraph[],
  ): Promise<{ graph: OnnxGraph; provider: OnnxExecutionProvider }> {
    const threadOption = threads === undefined ? {} : { intraOpNumThreads: threads };
    // Recorded BEFORE this method returns, not by its caller afterwards. The
    // caller's `push` is a separate statement, and every statement between an
    // open and its record is a window in which a throw strands native memory
    // nothing holds a handle to.
    const record = (graph: OnnxGraph): OnnxGraph => {
      opened.push(graph);
      return graph;
    };
    if (requested !== 'cpu') {
      try {
        return {
          graph: record(
            await engine.createSession(path, {
              executionProviders: [requested],
              ...threadOption,
            }),
          ),
          provider: requested,
        };
      } catch (error) {
        warnings.push(
          `The ${requested} execution provider could not run this model (${describe(error)}); ` +
            'it is running on the CPU instead.',
        );
      }
    }
    return {
      graph: record(
        await engine.createSession(path, { executionProviders: ['cpu'], ...threadOption }),
      ),
      provider: 'cpu',
    };
  }

  async createSession(options: OnnxSessionOptions): Promise<OnnxSession> {
    const started = performance.now();
    const warnings: string[] = [];
    const engine = await this.#getEngine();

    const requested = options.executionProvider ?? DEFAULT_PROVIDER;
    if (PROVIDER_NAMES[requested] === undefined) {
      warnings.push(
        `The "${requested}" execution provider does not exist in a Node build of ONNX Runtime; ` +
          'the CPU provider was used instead.',
      );
    }
    const provider: OnnxExecutionProvider =
      PROVIDER_NAMES[requested] === undefined ? 'cpu' : requested;

    /*
     * EVERY graph this call opens, recorded the instant it opens.
     *
     * ONE release path, and the array is the reason it can be one. There used
     * to be three: this method's `catch`, and two more inside `#loadWhisper`.
     * Two of the three were unguarded and the third was DEAD — nothing between
     * `#loadWhisper` returning and `graphs.push(...)` can throw, so this
     * `catch` could only ever run with an empty array, and deleting its body
     * left the whole suite green (measured: exit 0, 662 passed). A cleanup
     * that cannot execute is not a backstop; it reads as one.
     *
     * So the array is passed DOWN and filled as each `createSession` returns.
     * Every failure after the first graph opens — a decoder that will not
     * parse, a tokenizer read that throws, `inspectWhisper` refusing a graph
     * whose shape it does not recognise — now lands in one `catch` that has
     * the real list in front of it. `tests/onnx-node.test.ts` injects all
     * three.
     */
    const graphs: OnnxGraph[] = [];
    let whisper: LoadedWhisper | null = null;
    let resolved: OnnxExecutionProvider = provider;

    try {
      if (options.task === 'stt') {
        const loaded = await this.#loadWhisper(engine, options, provider, warnings, graphs);
        whisper = loaded.whisper;
        resolved = loaded.provider;
      } else {
        const opened = await this.#openGraph(
          engine,
          options.modelPath,
          provider,
          options.threads,
          warnings,
          graphs,
        );
        resolved = opened.provider;
        warnings.push(
          options.task === 'tts'
            ? 'The graph loaded, but this build has no Piper/VITS pipeline: `synthesize` will ' +
              'refuse rather than return silence.'
            : 'The graph loaded, but this build has no diffusion pipeline: `diffuse` will ' +
              'refuse rather than return a placeholder image.',
        );
      }
    } catch (error) {
      // Nothing is registered, so nothing would ever release these. Native
      // memory, and on this engine that is hundreds of megabytes per graph.
      for (const graph of graphs) await graph.release().catch(() => undefined);
      throw error;
    }

    const handle = `onnx_${options.task}_${++this.#counter}`;
    const session: OnnxSession = {
      handle,
      task: options.task,
      executionProvider: resolved,
      loadMs: Math.round(performance.now() - started),
      warnings,
    };
    this.#handles.set(handle, { session, graphs, whisper, released: false });
    return session;
  }

  /**
   * Resolve and open a Whisper pipeline.
   *
   * `modelPath` may be the pipeline directory or the encoder file; either way
   * `companions` wins where it is given. The layout looked for is the one
   * every Hugging Face ONNX export uses: weights under `onnx/`, the tokenizer
   * and configs beside it.
   *
   * THROWS FREELY, and does not clean up. Every graph it opens is appended to
   * `opened` as it opens, and `createSession` — the only caller — releases
   * that list in one `catch`. It used to release its own, in two separate
   * `catch` blocks that had to be kept in step with the sequence between
   * them; the second of the two was missing from the path where
   * `inspectWhisper` throws, and the suite was green with it deleted.
   */
  async #loadWhisper(
    engine: OnnxEngine,
    options: OnnxSessionOptions,
    provider: OnnxExecutionProvider,
    warnings: string[],
    opened: OnnxGraph[],
  ): Promise<{ whisper: LoadedWhisper; provider: OnnxExecutionProvider }> {
    const companions = options.companions ?? {};
    const root = (await isDirectory(options.modelPath))
      ? options.modelPath
      : dirname(options.modelPath);
    const near = (name: string): string[] => [join(root, name), join(root, 'onnx', name)];

    const encoderPath =
      companions['encoder'] ??
      ((await isDirectory(options.modelPath))
        ? await firstExisting(near('encoder_model.onnx'))
        : options.modelPath);
    const decoderPath =
      companions['decoder'] ?? (await firstExisting(near('decoder_model_merged.onnx')));
    const tokenizerPath =
      companions['tokenizer'] ?? (await firstExisting(near('tokenizer.json')));

    for (const [role, path] of [
      ['encoder', encoderPath],
      ['decoder', decoderPath],
      ['tokenizer', tokenizerPath],
    ] as const) {
      if (path === undefined) {
        throw new Error(
          `A Whisper session needs an ${role}, and none was found under ` +
            `${JSON.stringify(root)}. Supply it as \`companions.${role}\`.`,
        );
      }
    }

    const tokenizer = WhisperTokenizer.fromJson(
      JSON.parse(await readFile(tokenizerPath!, 'utf8')) as unknown,
    );

    const generationPath =
      companions['generationConfig'] ?? (await firstExisting(near('generation_config.json')));
    let generation: WhisperGenerationConfig;
    if (generationPath === undefined) {
      // Defaults, and say so: the suppression lists are what stop the decoder
      // emitting punctuation-only loops, so running without them is a quality
      // change the caller should know about.
      generation = readGenerationConfig({});
      warnings.push(
        'No generation_config.json was found beside the model, so the token suppression lists ' +
          'are empty. Transcripts may contain tokens Whisper normally suppresses.',
      );
    } else {
      generation = readGenerationConfig(JSON.parse(await readFile(generationPath, 'utf8')));
    }

    const encoderOpen = await this.#openGraph(
      engine,
      encoderPath!,
      provider,
      options.threads,
      warnings,
      opened,
    );
    const decoderOpen = await this.#openGraph(
      engine,
      decoderPath!,
      encoderOpen.provider,
      options.threads,
      warnings,
      opened,
    );

    const shape = inspectWhisper(encoderOpen.graph, decoderOpen.graph);
    if (shape.vocabSize > 0 && shape.vocabSize !== tokenizer.size) {
      // Loud, not silent. A decoder that emits 51865 ids decoded against a
      // 51866-entry table is off by one for every special token — which
      // reads as a working transcriber producing slightly wrong words.
      warnings.push(
        `The decoder emits ${shape.vocabSize} logits but the tokenizer defines ` +
          `${tokenizer.size} tokens. They are not the same model's; expect wrong text.`,
      );
    }
    return {
      whisper: {
        encoder: encoderOpen.graph,
        decoder: decoderOpen.graph,
        tokenizer,
        generation,
        shape,
      },
      provider: decoderOpen.provider,
    };
  }

  /** Releasing a handle that is not loaded, or is already released, is a no-op. */
  async releaseSession({ handle }: { handle: string }): Promise<void> {
    const loaded = this.#handles.get(handle);
    if (loaded === undefined) return;
    this.#handles.delete(handle);
    await this.#release(loaded);
  }

  async #release(loaded: LoadedSession): Promise<void> {
    if (loaded.released) return;
    loaded.released = true;
    for (const graph of loaded.graphs) {
      // Each failure swallowed: the handle is already gone from the map, so
      // throwing here would only strand the graphs after this one.
      await graph.release().catch(() => undefined);
    }
  }

  /** Free every session of one task. The memory-pressure valve, for real. */
  async releaseTask({ task }: { task: OnnxTask }): Promise<void> {
    for (const [handle, loaded] of [...this.#handles]) {
      if (loaded.session.task !== task) continue;
      this.#handles.delete(handle);
      await this.#release(loaded);
    }
  }

  async listLoaded(): Promise<{ handles: string[] }> {
    return { handles: [...this.#handles.keys()] };
  }

  /** Release every handle. Not part of the contract. */
  async dispose(): Promise<void> {
    for (const [handle, loaded] of [...this.#handles]) {
      this.#handles.delete(handle);
      await this.#release(loaded);
    }
    this.#engine = null;
  }

  /* ── Transcription ────────────────────────────────────────────────── */

  /**
   * Streams `onnxPartial` events and always ends with exactly one `onnxEnd`.
   *
   * Same shape, and for the same reason, as `LlamaCppNode.generate`: the
   * desktop supervisor's streaming loop waits on the terminal event, so a path
   * that returns or throws without emitting one hangs the caller with no way
   * back. `finish` is idempotent and is called on the success path, in the
   * `catch`, and again in the `finally` — the last as a structural backstop,
   * so a future edit that introduces a fourth exit cannot silently break the
   * guarantee.
   */
  async transcribe(options: TranscribeOptions): Promise<TranscribeResult> {
    const started = performance.now();
    const { requestId } = options;
    // Cleared on entry, as the web shim and the llama.cpp plugin both do: a
    // request id is a turn's id and the app reuses it on retry, so a cancel
    // from one attempt must not kill the next.
    this.#cancelled.delete(requestId);

    let text = '';
    let language = options.language ?? '';
    let segments: TranscribeResult['segments'] = [];
    let settled = false;

    const build = (): TranscribeResult => ({
      requestId,
      text,
      language,
      durationMs: Math.max(1, Math.round(performance.now() - started)),
      segments,
    });

    const finish = (error?: string): TranscribeResult => {
      const result = build();
      if (!settled) {
        settled = true;
        this.#emit('onnxEnd', error === undefined ? result : { ...result, error });
      }
      return result;
    };

    try {
      const loaded = this.#handles.get(options.handle);
      if (loaded === undefined) {
        throw new Error(`No ONNX session is loaded for handle "${options.handle}".`);
      }
      if (loaded.whisper === null) {
        throw new Error(
          `Session "${options.handle}" was created for the "${loaded.session.task}" task, so it ` +
            'cannot transcribe. Create it with `task: "stt"`.',
        );
      }

      // The audio bytes ARE the input. There is no microphone in this process,
      // which is the difference from the web shim: it ignores `audio` entirely
      // and opens the live recogniser. A caller that sends nothing gets told.
      if (options.audio === '') {
        throw new Error(
          'No audio was supplied. The Node transcriber has no microphone: `audio` must carry ' +
            'the recording as base64, unlike the web shim, which listens live and ignores it.',
        );
      }

      const audio = decodeAudio(options.audio, options.mediaType, SAMPLE_RATE);
      const engine = await this.#getEngine();

      const run = await runWhisper({
        engine,
        encoder: loaded.whisper.encoder,
        decoder: loaded.whisper.decoder,
        tokenizer: loaded.whisper.tokenizer,
        generation: loaded.whisper.generation,
        shape: loaded.whisper.shape,
        samples: audio.samples,
        language: options.language,
        cancelled: () => this.#cancelled.has(requestId),
        ...(options.streamPartials === true
          ? {
              onPartial: (partial: string): void => {
                // Checked before publishing, so a cancelled request never
                // emits a partial the caller did not ask for.
                if (this.#cancelled.has(requestId)) return;
                this.#emit('onnxPartial', { requestId, text: partial });
              },
            }
          : {}),
      });

      text = run.text;
      language = run.language;
      segments = run.segments.map((segment) => ({ ...segment }));

      return run.cancelled ? finish('The transcription was cancelled.') : finish();
    } catch (error) {
      finish(describe(error));
      throw error;
    } finally {
      // Backstop. A no-op on every path above, and the reason a new early
      // return cannot break the terminal-event rule by accident.
      finish('The transcription ended without reporting a result.');
      this.#cancelled.delete(requestId);
    }
  }

  /* ── Deferred pipelines ───────────────────────────────────────────── */

  /**
   * Refuses. Piper/VITS is not in this milestone.
   *
   * Returning `audio: ''` the way the web shim does would be a lie here: the
   * shim's empty buffer means "the browser already spoke", and this process
   * has no speaker. A caller that got silence back would have no way to tell
   * it from a synthesis that produced nothing.
   */
  async synthesize(options: SynthesizeOptions): Promise<SynthesizeResult> {
    void options;
    throw new Error(
      'Speech synthesis is not implemented in this build. The ONNX session layer loads a ' +
        'tts graph, but no Piper/VITS pipeline runs it, and returning silent audio would be ' +
        'indistinguishable from a synthesis that failed.',
    );
  }

  /** Refuses. Latent diffusion is not in this milestone. */
  async diffuse(options: DiffuseOptions): Promise<DiffuseResult> {
    void options;
    throw new Error(
      'Image generation is not implemented in this build. The ONNX session layer loads a ' +
        'diffusion graph, but no UNet loop runs it, and returning a procedural image the way ' +
        'the web shim does would hide the absence rather than report it.',
    );
  }

  /** Cancelling a request that is not running is a no-op, not an error. */
  async cancel({ requestId }: { requestId: string }): Promise<void> {
    this.#cancelled.add(requestId);
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** The first of `paths` that exists, resolved to absolute. */
async function firstExisting(paths: readonly string[]): Promise<string | undefined> {
  for (const path of paths) {
    try {
      const info = await stat(path);
      if (info.isFile()) return isAbsolute(path) ? path : resolve(path);
    } catch {
      // Not there; try the next layout.
    }
  }
  return undefined;
}
