// @vitest-environment node
/**
 * `@chatterang/onnx-node` without a native binding and without a model.
 *
 * The engine is an interface, so everything that makes `OnnxRuntimeNode` a
 * CONTRACT TRANSLATOR rather than an inference engine is testable here: the
 * handle map, the release-exactly-once rule, the terminal-event guarantee, the
 * execution-provider translation, the refusal to run a graph whose names are
 * not Whisper's. Those are the behaviours most likely to regress, and
 * `tests/onnx-real-transcribe.test.ts` — the one that needs 280 MB of weights
 * — is opt-in, so if they were only testable there they would in practice be
 * tested never.
 *
 * The pure front-end pieces (WAV decode, the mel filterbank, the byte-level
 * tokenizer) are checked against values from OUTSIDE this repo where such
 * values exist, because a derivation checked against itself proves nothing.
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { TranscriptionEndEvent } from '@chatterang/contracts';
import type {
  OnnxEngine,
  OnnxGraph,
  OnnxSessionOptionsLike,
  OnnxTensorLike,
  OnnxValueMetadata,
} from '@chatterang/onnx-node';
import {
  ELECTRON_SAFE_SESSION_OPTIONS,
  OnnxRuntimeNode,
  WhisperTokenizer,
  decodeWav,
  inspectWhisper,
  melFilterBank,
  resample,
} from '@chatterang/onnx-node';

/* ── A fake ONNX Runtime ──────────────────────────────────────────────── */

interface FakeGraphSpec {
  readonly inputMetadata: OnnxValueMetadata[];
  readonly outputMetadata: OnnxValueMetadata[];
  run(feeds: Record<string, OnnxTensorLike>): Record<string, OnnxTensorLike>;
}

class FakeGraph implements OnnxGraph {
  releases = 0;
  #disposed = false;
  constructor(private readonly spec: FakeGraphSpec) {}
  get inputNames(): string[] {
    return this.spec.inputMetadata.map((it) => it.name);
  }
  get outputNames(): string[] {
    return this.spec.outputMetadata.map((it) => it.name);
  }
  get inputMetadata(): readonly OnnxValueMetadata[] {
    return this.spec.inputMetadata;
  }
  get outputMetadata(): readonly OnnxValueMetadata[] {
    return this.spec.outputMetadata;
  }
  async run(feeds: Record<string, OnnxTensorLike>): Promise<Record<string, OnnxTensorLike>> {
    if (this.#disposed) throw new Error('Session already disposed.');
    return this.spec.run(feeds);
  }
  async release(): Promise<void> {
    this.releases += 1;
    // onnxruntime's own behaviour, reproduced deliberately: a second release
    // THROWS. Making the fake lenient here would let the plugin's latch rot
    // and the real binding would be the thing that noticed.
    if (this.#disposed) throw new Error('Session already disposed.');
    this.#disposed = true;
  }
}

interface FakeEngineOptions {
  readonly providers?: string[];
  /** Called per createSession; return a graph or throw to refuse. */
  readonly open: (path: string, options: OnnxSessionOptionsLike) => FakeGraph;
}

interface FakeEngineRecord {
  readonly engine: OnnxEngine;
  readonly opened: { path: string; options: OnnxSessionOptionsLike }[];
  readonly graphs: FakeGraph[];
}

function fakeEngine(options: FakeEngineOptions): FakeEngineRecord {
  const opened: { path: string; options: OnnxSessionOptionsLike }[] = [];
  const graphs: FakeGraph[] = [];
  const engine: OnnxEngine = {
    listExecutionProviders: () => options.providers ?? ['cpu'],
    createSession: async (path, sessionOptions) => {
      opened.push({ path, options: sessionOptions });
      const graph = options.open(path, sessionOptions);
      graphs.push(graph);
      return graph;
    },
    tensor: (type, data, dims) => ({ type, data, dims: [...dims] }),
  };
  return { engine, opened, graphs };
}

/* ── A fake Whisper ───────────────────────────────────────────────────── */

const LAYERS = 2;
const HEADS = 2;
const HEAD_DIM = 4;

/** The tiny vocabulary the fake decoder emits into. */
const FAKE_TOKENIZER = {
  // Byte-level: "Ġ" (U+0120) is the space byte, as GPT-2 displays it.
  model: { vocab: { Hello: 0, 'Ġworld': 1, 'Ġcaf': 2, 'Ã©': 3 } },
  added_tokens: [
    { id: 10, content: '<|endoftext|>' },
    { id: 11, content: '<|startoftranscript|>' },
    { id: 12, content: '<|en|>' },
    { id: 13, content: '<|transcribe|>' },
    { id: 14, content: '<|translate|>' },
    { id: 15, content: '<|notimestamps|>' },
    { id: 16, content: '<|0.00|>' },
    { id: 17, content: '<|0.02|>' },
    { id: 18, content: '<|0.04|>' },
    { id: 19, content: '<|0.06|>' },
  ],
};
const FAKE_VOCAB_SIZE = 20;

function metadata(name: string, type: string, shape: (number | string)[]): OnnxValueMetadata {
  return { name, type, shape };
}

function whisperEncoderSpec(): FakeGraphSpec {
  return {
    inputMetadata: [metadata('input_features', 'float32', ['batch_size', 80, 3000])],
    outputMetadata: [metadata('last_hidden_state', 'float32', ['batch_size', 1500, 8])],
    run: () => ({
      last_hidden_state: { type: 'float32', data: new Float32Array(1500 * 8), dims: [1, 1500, 8] },
    }),
  };
}

function kvNames(prefix: string): string[] {
  const names: string[] = [];
  for (let layer = 0; layer < LAYERS; layer += 1) {
    for (const half of ['decoder', 'encoder']) {
      for (const part of ['key', 'value']) names.push(`${prefix}.${layer}.${half}.${part}`);
    }
  }
  return names;
}

/**
 * A decoder that emits `script` one token per step.
 *
 * `onStep` runs before each answer, which is how the cancellation test lands a
 * `cancel` in the middle of a decode rather than before or after it.
 */
function whisperDecoderSpec(script: number[], onStep?: (step: number) => void): FakeGraphSpec {
  let step = 0;
  return {
    inputMetadata: [
      metadata('input_ids', 'int64', ['batch_size', 'decoder_sequence_length']),
      metadata('encoder_hidden_states', 'float32', ['batch_size', 1500, 8]),
      ...kvNames('past_key_values').map((name) =>
        metadata(name, 'float32', ['batch_size', HEADS, 'past_decoder_sequence_length', HEAD_DIM]),
      ),
      metadata('use_cache_branch', 'bool', [1]),
    ],
    outputMetadata: [
      metadata('logits', 'float32', ['batch_size', 'decoder_sequence_length', FAKE_VOCAB_SIZE]),
      ...kvNames('present').map((name) =>
        metadata(name, 'float32', ['batch_size', HEADS, 'past_decoder_sequence_length + 1', HEAD_DIM]),
      ),
    ],
    run: () => {
      onStep?.(step);
      const logits = new Float32Array(FAKE_VOCAB_SIZE).fill(-10);
      // Past the end of the script, insist on <|endoftext|> so a loop cannot
      // run away and hide a bug behind a timeout.
      const token = script[step] ?? 10;
      logits[token] = 10;
      step += 1;
      const out: Record<string, OnnxTensorLike> = {
        logits: { type: 'float32', data: logits, dims: [1, 1, FAKE_VOCAB_SIZE] },
      };
      for (const name of kvNames('present')) {
        out[name] = {
          type: 'float32',
          data: new Float32Array(HEADS * HEAD_DIM),
          dims: [1, HEADS, 1, HEAD_DIM],
        };
      }
      return out;
    },
  };
}

/** A directory with the three files `createSession` looks for. */
function whisperDirectory(): string {
  const root = mkdtempSync(join(tmpdir(), 'chatterang-onnx-'));
  writeFileSync(join(root, 'encoder_model.onnx'), 'not read by the fake engine');
  writeFileSync(join(root, 'decoder_model_merged.onnx'), 'not read by the fake engine');
  writeFileSync(join(root, 'tokenizer.json'), JSON.stringify(FAKE_TOKENIZER));
  return root;
}

/** One second of 16 kHz silence as a base64 WAV. */
function silentWav(seconds = 1): string {
  const samples = 16000 * seconds;
  const buffer = Buffer.alloc(44 + samples * 2);
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + samples * 2, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(16000, 24);
  buffer.writeUInt32LE(32000, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(samples * 2, 40);
  return buffer.toString('base64');
}

/** A plugin wired to a fake Whisper that emits `script`. */
async function loadedWhisper(
  script: number[],
  onStep?: (step: number) => void,
): Promise<{ plugin: OnnxRuntimeNode; handle: string; graphs: FakeGraph[] }> {
  const record = fakeEngine({
    providers: ['cpu', 'coreml'],
    open: (path) =>
      new FakeGraph(
        path.includes('encoder') ? whisperEncoderSpec() : whisperDecoderSpec(script, onStep),
      ),
  });
  const plugin = new OnnxRuntimeNode({ createEngine: async () => record.engine });
  const session = await plugin.createSession({ task: 'stt', modelPath: whisperDirectory() });
  return { plugin, handle: session.handle, graphs: record.graphs };
}

/* ── Execution providers ──────────────────────────────────────────────── */

describe('execution providers', () => {
  it('reports only providers the contract can name, and is never simulated', async () => {
    // `dml` and `cuda` are real onnxruntime providers with NO name in the
    // contract's union. Reporting either as `cpu` would be a lie about what
    // ran; dropping them silently is the honest option and is what happens.
    const record = fakeEngine({
      providers: ['cpu', 'coreml', 'webgpu', 'dml', 'cuda'],
      open: () => new FakeGraph(whisperEncoderSpec()),
    });
    const plugin = new OnnxRuntimeNode({ createEngine: async () => record.engine });

    const answer = await plugin.getExecutionProviders();
    expect(answer.providers).toEqual(['cpu', 'coreml', 'webgpu']);
    expect(answer.preferred).toBe('cpu');
    // The web shim says `true` and the UI shows a banner. Here a real session
    // either creates or the call fails, so there is nothing to warn about.
    expect(answer.simulated).toBe(false);
  });

  it('drops a provider the contract cannot name rather than renaming it', async () => {
    // `dml` and `cuda` must not become some other provider's name. Reported as
    // `cpu`, a Windows machine running DirectML would say it ran on the CPU —
    // and every performance number after that would be attributed wrongly.
    const record = fakeEngine({
      providers: ['dml', 'cuda'],
      open: () => new FakeGraph(whisperEncoderSpec()),
    });
    const plugin = new OnnxRuntimeNode({ createEngine: async () => record.engine });
    const answer = await plugin.getExecutionProviders();
    expect(answer.providers).toEqual([]);
    expect(answer.preferred).toBe('cpu');
  });

  it('never lists a provider the Node binding cannot reach', async () => {
    const record = fakeEngine({ providers: ['cpu'], open: () => new FakeGraph(whisperEncoderSpec()) });
    const plugin = new OnnxRuntimeNode({ createEngine: async () => record.engine });
    const answer = await plugin.getExecutionProviders();
    for (const unreachable of ['wasm', 'nnapi', 'xnnpack']) {
      expect(answer.providers).not.toContain(unreachable);
    }
  });

  it('answers with an empty list rather than a guess when the binding will not load', async () => {
    const plugin = new OnnxRuntimeNode({
      createEngine: async () => {
        throw new Error('no prebuilt binary for darwin/x64');
      },
    });
    const answer = await plugin.getExecutionProviders();
    expect(answer.providers).toEqual([]);
    expect(answer.simulated).toBe(false);
  });

  it('falls back to the CPU with a warning when the requested provider cannot run the graph', async () => {
    // Exactly the CoreML case: `listSupportedBackends()` says it is compiled
    // in, and MLProgram mode then fails on the actual graph.
    const record = fakeEngine({
      providers: ['cpu', 'coreml'],
      open: (path, options) => {
        if (options.executionProviders?.includes('coreml') === true) {
          throw new Error('Failed to create MLModel, error: Error in building plan.');
        }
        return new FakeGraph(path.includes('encoder') ? whisperEncoderSpec() : whisperDecoderSpec([10]));
      },
    });
    const plugin = new OnnxRuntimeNode({ createEngine: async () => record.engine });

    const session = await plugin.createSession({
      task: 'stt',
      modelPath: whisperDirectory(),
      executionProvider: 'coreml',
    });
    expect(session.executionProvider).toBe('cpu');
    expect(session.warnings.join(' ')).toMatch(/coreml execution provider could not run/);
  });

  it('says so when asked for a provider a Node build does not have at all', async () => {
    const record = fakeEngine({ open: () => new FakeGraph(whisperEncoderSpec()) });
    const plugin = new OnnxRuntimeNode({ createEngine: async () => record.engine });
    const session = await plugin.createSession({
      task: 'tts',
      modelPath: '/models/voice.onnx',
      executionProvider: 'nnapi',
    });
    expect(session.executionProvider).toBe('cpu');
    expect(session.warnings.join(' ')).toMatch(/"nnapi" execution provider does not exist/);
  });

  it('keeps the CPU arena OFF, which is an Electron crash workaround', () => {
    // Plain Node never hits the crash this prevents, so no test running under
    // Node can observe the behaviour. Pinning the flag is the most an
    // in-process test can honestly do; the comment in onnxruntime-node.ts
    // records the Electron measurement.
    expect(ELECTRON_SAFE_SESSION_OPTIONS).toEqual({ enableCpuMemArena: false });
  });
});

/* ── Session lifecycle ────────────────────────────────────────────────── */

describe('session lifecycle', () => {
  it('releases every native session exactly once, and a second release is a no-op', async () => {
    const { plugin, handle, graphs } = await loadedWhisper([10]);
    expect(graphs).toHaveLength(2);

    await plugin.releaseSession({ handle });
    expect(graphs.map((graph) => graph.releases)).toEqual([1, 1]);

    // The fake THROWS on a second release, exactly as onnxruntime does. This
    // resolving is the whole assertion.
    await expect(plugin.releaseSession({ handle })).resolves.toBeUndefined();
    expect(graphs.map((graph) => graph.releases)).toEqual([1, 1]);
    expect((await plugin.listLoaded()).handles).toEqual([]);
  });

  it('releases exactly once even when two releases are in flight together', async () => {
    // The sequential case above passes on the map delete alone. THIS one is
    // what pins the ordering: release-then-delete would let both calls find
    // the same entry and free every graph twice, and the counter would say so
    // even though the plugin swallows the engine's second-release throw.
    const { plugin, handle, graphs } = await loadedWhisper([10]);
    await Promise.all([
      plugin.releaseSession({ handle }),
      plugin.releaseSession({ handle }),
      plugin.releaseTask({ task: 'stt' }),
      plugin.dispose(),
    ]);
    expect(graphs.map((graph) => graph.releases)).toEqual([1, 1]);
  });

  it('releasing a handle that was never loaded is a no-op', async () => {
    const { plugin } = await loadedWhisper([10]);
    await expect(plugin.releaseSession({ handle: 'onnx_stt_999' })).resolves.toBeUndefined();
  });

  it('releaseTask frees every session of that task and leaves the others alone', async () => {
    const record = fakeEngine({
      open: (path) =>
        new FakeGraph(path.includes('encoder') ? whisperEncoderSpec() : whisperDecoderSpec([10])),
    });
    const plugin = new OnnxRuntimeNode({ createEngine: async () => record.engine });
    const stt = await plugin.createSession({ task: 'stt', modelPath: whisperDirectory() });
    const tts = await plugin.createSession({ task: 'tts', modelPath: '/models/voice.onnx' });

    await plugin.releaseTask({ task: 'stt' });
    expect((await plugin.listLoaded()).handles).toEqual([tts.handle]);
    // Two graphs for the stt handle, none for the tts one.
    expect(record.graphs.filter((graph) => graph.releases > 0)).toHaveLength(2);
    expect(record.graphs.every((graph) => graph.releases <= 1)).toBe(true);
    void stt;
  });

  it('releases what it opened when a later graph fails to load', async () => {
    const record = fakeEngine({
      open: (path) => {
        if (path.includes('decoder')) throw new Error('Protobuf parsing failed.');
        return new FakeGraph(whisperEncoderSpec());
      },
    });
    const plugin = new OnnxRuntimeNode({ createEngine: async () => record.engine });
    await expect(
      plugin.createSession({ task: 'stt', modelPath: whisperDirectory() }),
    ).rejects.toThrowError(/Protobuf parsing failed/);
    // The encoder opened and must not be stranded: nothing holds its handle.
    expect(record.graphs.map((graph) => graph.releases)).toEqual([1]);
    expect((await plugin.listLoaded()).handles).toEqual([]);
  });

  it('releases BOTH graphs when the pair opens and then fails inspection', async () => {
    /*
     * THE ERROR PATH THAT WAS UNGUARDED. Both graphs open, and
     * `inspectWhisper` then refuses the pair — the ordinary "you pointed
     * `companions.decoder` at the wrong file" failure. That is the largest
     * stranding this class can produce: whisper-base is 79 MB of encoder and
     * 199 MB of decoder, both live native sessions, and after the throw
     * nothing holds a handle to either.
     *
     * FAULT INJECTED, against the code as it was: deleting the two
     * `graph.release()` lines from `#loadWhisper`'s `inspectWhisper` catch
     * left the WHOLE SUITE green — `npx vitest run` exited 0 with 662 passed.
     * With this test present the same deletion fails (`[0, 0]` received for
     * `[1, 1]`). The release now lives in `createSession`'s single catch, over
     * the array `#openGraph` fills as it opens, so deleting THAT fails here
     * too.
     */
    const record = fakeEngine({
      // Both files answer with an ENCODER graph, so the second one is opened
      // successfully and is then not a merged decoder — no `input_ids`.
      open: () => new FakeGraph(whisperEncoderSpec()),
    });
    const plugin = new OnnxRuntimeNode({ createEngine: async () => record.engine });

    await expect(
      plugin.createSession({ task: 'stt', modelPath: whisperDirectory() }),
    ).rejects.toThrowError(/not a merged Whisper decoder/);

    // Two graphs opened; two released, exactly once each. The fake throws on a
    // second release, so a double free would surface as a rejection above
    // rather than as a silent extra count.
    expect(record.graphs).toHaveLength(2);
    expect(record.graphs.map((graph) => graph.releases)).toEqual([1, 1]);
    expect((await plugin.listLoaded()).handles).toEqual([]);
  });

  it('warns that a tts or diffusion graph has no pipeline behind it', async () => {
    const record = fakeEngine({ open: () => new FakeGraph(whisperEncoderSpec()) });
    const plugin = new OnnxRuntimeNode({ createEngine: async () => record.engine });
    const tts = await plugin.createSession({ task: 'tts', modelPath: '/models/voice.onnx' });
    const diffusion = await plugin.createSession({ task: 'diffusion', modelPath: '/models/unet.onnx' });
    expect(tts.warnings.join(' ')).toMatch(/`synthesize` will refuse/);
    expect(diffusion.warnings.join(' ')).toMatch(/`diffuse` will refuse/);
  });
});

/* ── The terminal-event rule ──────────────────────────────────────────── */

describe('the terminal-event rule', () => {
  /** Collect every `onnxEnd` a run emits. */
  async function watch(plugin: OnnxRuntimeNode): Promise<TranscriptionEndEvent[]> {
    const ends: TranscriptionEndEvent[] = [];
    await plugin.addListener('onnxEnd', (event) => ends.push(event));
    return ends;
  }

  it('emits exactly one onnxEnd on success, carrying the result', async () => {
    // <|0.00|> Hello world <|0.06|> <|endoftext|>
    const { plugin, handle } = await loadedWhisper([16, 0, 1, 19, 10]);
    const ends = await watch(plugin);

    const result = await plugin.transcribe({
      handle,
      audio: silentWav(),
      mediaType: 'audio/wav',
      // Named, so the fake decoder's script is not consumed by the
      // language-detection step this pipeline runs when it is omitted.
      language: 'en',
      requestId: 'turn-1',
    });

    expect(result.text).toBe('Hello world');
    expect(result.segments).toEqual([{ start: 0, end: 0.06, text: 'Hello world' }]);
    expect(ends).toHaveLength(1);
    expect(ends[0]!.requestId).toBe('turn-1');
    expect(ends[0]!.text).toBe('Hello world');
    expect(ends[0]!.error).toBeUndefined();
  });

  it('emits exactly one onnxEnd, carrying the error, when the run throws', async () => {
    const { plugin } = await loadedWhisper([10]);
    const ends = await watch(plugin);

    await expect(
      plugin.transcribe({
        handle: 'onnx_stt_nope',
        audio: silentWav(),
        mediaType: 'audio/wav',
        requestId: 'turn-2',
      }),
    ).rejects.toThrowError(/No ONNX session is loaded/);

    expect(ends).toHaveLength(1);
    expect(ends[0]!.error).toMatch(/No ONNX session is loaded/);
    // The backstop in `finally` must not append a SECOND end after the catch.
    expect(ends[0]!.error).not.toMatch(/without reporting a result/);
  });

  it('emits exactly one onnxEnd when the run is cancelled mid-decode', async () => {
    let plugin!: OnnxRuntimeNode;
    const loaded = await loadedWhisper([16, 0, 1, 19, 10], (step) => {
      // Land the cancel between decode steps, which is where the loop checks.
      // The loop checks between steps, so a cancel raised during step 1's
      // run is seen before step 2 begins: two tokens sampled, not four.
      if (step === 1) void plugin.cancel({ requestId: 'turn-3' });
    });
    plugin = loaded.plugin;
    const ends = await watch(plugin);

    const result = await plugin.transcribe({
      handle: loaded.handle,
      audio: silentWav(),
      mediaType: 'audio/wav',
      language: 'en',
      requestId: 'turn-3',
    });

    expect(ends).toHaveLength(1);
    expect(ends[0]!.error).toMatch(/cancelled/);
    // It stopped early: the full script would have decoded four tokens.
    expect(result.text.length).toBeLessThan('Hello world'.length);
  });

  it('a throwing listener cannot swallow the terminal event for the others', async () => {
    const { plugin, handle } = await loadedWhisper([16, 0, 1, 19, 10]);
    const seen: string[] = [];
    await plugin.addListener('onnxEnd', () => {
      throw new Error('a listener that throws');
    });
    await plugin.addListener('onnxEnd', (event) => seen.push(event.text));

    await plugin.transcribe({
      handle,
      audio: silentWav(),
      mediaType: 'audio/wav',
      language: 'en',
      requestId: 'turn-4',
    });
    expect(seen).toEqual(['Hello world']);
  });

  it('streams partials only when asked, and stops publishing them after a cancel', async () => {
    let plugin!: OnnxRuntimeNode;
    const loaded = await loadedWhisper([16, 0, 1, 19, 10], (step) => {
      // Step 1's token IS published; the cancel raised during step 2's run
      // suppresses step 2's. Both halves in one run: partials really stream,
      // and they really stop.
      if (step === 2) void plugin.cancel({ requestId: 'turn-5' });
    });
    plugin = loaded.plugin;
    const partials: string[] = [];
    await plugin.addListener('onnxPartial', (event) => partials.push(event.text));

    await plugin.transcribe({
      handle: loaded.handle,
      audio: silentWav(),
      mediaType: 'audio/wav',
      language: 'en',
      requestId: 'turn-5',
      streamPartials: true,
    });
    // Step 0 produced a timestamp, which is a control marker and is never
    // published; step 1 produced "Hello"; step 2's word was decoded but not
    // published, because the cancel landed first.
    expect(partials).toEqual(['Hello']);

    const quiet: string[] = [];
    const second = await loadedWhisper([16, 0, 1, 19, 10]);
    await second.plugin.addListener('onnxPartial', (event) => quiet.push(event.text));
    await second.plugin.transcribe({
      handle: second.handle,
      audio: silentWav(),
      mediaType: 'audio/wav',
      language: 'en',
      requestId: 'turn-6',
    });
    expect(quiet).toEqual([]);
  });

  it('cancelling an unknown request is a no-op, and does not poison the next turn', async () => {
    const { plugin, handle } = await loadedWhisper([16, 0, 1, 19, 10]);
    await expect(plugin.cancel({ requestId: 'never-started' })).resolves.toBeUndefined();
    // The same id, now actually used: `transcribe` clears the flag on entry,
    // which is what stops a cancel from one attempt killing a retry.
    await expect(plugin.cancel({ requestId: 'turn-7' })).resolves.toBeUndefined();
    const result = await plugin.transcribe({
      handle,
      audio: silentWav(),
      mediaType: 'audio/wav',
      language: 'en',
      requestId: 'turn-7',
    });
    expect(result.text).toBe('Hello world');
  });

  it('refuses an empty audio payload rather than transcribing nothing', async () => {
    // `src/lib/voice.ts` sends `audio: ''` today, because the web shim listens
    // to the microphone and ignores the field. There is no microphone here.
    const { plugin, handle } = await loadedWhisper([10]);
    await expect(
      plugin.transcribe({ handle, audio: '', mediaType: 'audio/wav', requestId: 'turn-8' }),
    ).rejects.toThrowError(/has no microphone/);
  });

  it('refuses to transcribe through a session created for another task', async () => {
    const record = fakeEngine({ open: () => new FakeGraph(whisperEncoderSpec()) });
    const plugin = new OnnxRuntimeNode({ createEngine: async () => record.engine });
    const tts = await plugin.createSession({ task: 'tts', modelPath: '/models/voice.onnx' });
    await expect(
      plugin.transcribe({
        handle: tts.handle,
        audio: silentWav(),
        mediaType: 'audio/wav',
        requestId: 'turn-9',
      }),
    ).rejects.toThrowError(/cannot transcribe/);
  });
});

/* ── The pipelines that are NOT here ──────────────────────────────────── */

describe('the deferred pipelines', () => {
  it('synthesize refuses rather than returning silence', async () => {
    const record = fakeEngine({ open: () => new FakeGraph(whisperEncoderSpec()) });
    const plugin = new OnnxRuntimeNode({ createEngine: async () => record.engine });
    const tts = await plugin.createSession({ task: 'tts', modelPath: '/models/voice.onnx' });
    await expect(
      plugin.synthesize({ handle: tts.handle, text: 'hello', requestId: 'tts-1' }),
    ).rejects.toThrowError(/not implemented/);
  });

  it('diffuse refuses rather than returning a procedural image', async () => {
    const record = fakeEngine({ open: () => new FakeGraph(whisperEncoderSpec()) });
    const plugin = new OnnxRuntimeNode({ createEngine: async () => record.engine });
    const session = await plugin.createSession({ task: 'diffusion', modelPath: '/models/unet.onnx' });
    await expect(
      plugin.diffuse({ handle: session.handle, prompt: 'a cat', requestId: 'img-1' }),
    ).rejects.toThrowError(/not implemented/);
  });
});

/* ── Graph inspection ─────────────────────────────────────────────────── */

describe('graph inspection', () => {
  it('refuses a graph that is not a Whisper encoder, quoting its real inputs', () => {
    const encoder = new FakeGraph({
      inputMetadata: [metadata('cache_frames', 'float32', [1, 1])],
      outputMetadata: [metadata('hidden_state', 'float32', [1, 1])],
      run: () => ({}),
    });
    const decoder = new FakeGraph(whisperDecoderSpec([10]));
    expect(() => inspectWhisper(encoder, decoder)).toThrowError(
      /not a Whisper encoder.*"cache_frames"/s,
    );
  });

  it('refuses a three-file export and names the file to use instead', () => {
    const decoder = new FakeGraph({
      // A `decoder_model.onnx` has no cache switch and no past inputs.
      inputMetadata: [
        metadata('input_ids', 'int64', [1, 1]),
        metadata('encoder_hidden_states', 'float32', [1, 1500, 8]),
      ],
      outputMetadata: [metadata('logits', 'float32', [1, 1, 20])],
      run: () => ({}),
    });
    expect(() => inspectWhisper(new FakeGraph(whisperEncoderSpec()), decoder)).toThrowError(
      /decoder_model_merged\.onnx/,
    );
  });

  it('derives the layer, head and vocabulary sizes from the graph rather than assuming', () => {
    const shape = inspectWhisper(
      new FakeGraph(whisperEncoderSpec()),
      new FakeGraph(whisperDecoderSpec([10])),
    );
    expect(shape).toMatchObject({
      nMels: 80,
      layers: LAYERS,
      heads: HEADS,
      headDim: HEAD_DIM,
      vocabSize: FAKE_VOCAB_SIZE,
    });
    expect(shape.pastNames).toHaveLength(LAYERS * 4);
  });

  it('warns when the tokenizer and the decoder are not the same model', async () => {
    const record = fakeEngine({
      open: (path) =>
        new FakeGraph(
          path.includes('encoder')
            ? whisperEncoderSpec()
            : {
                ...whisperDecoderSpec([10]),
                outputMetadata: [
                  metadata('logits', 'float32', [1, 1, 51865]),
                  ...kvNames('present').map((name) => metadata(name, 'float32', [1, 2, 1, 4])),
                ],
              },
        ),
    });
    const plugin = new OnnxRuntimeNode({ createEngine: async () => record.engine });
    const session = await plugin.createSession({ task: 'stt', modelPath: whisperDirectory() });
    expect(session.warnings.join(' ')).toMatch(/51865 logits but the tokenizer defines 20/);
  });
});

/* ── The front end ────────────────────────────────────────────────────── */

describe('the mel filterbank', () => {
  /*
   * PINNED AGAINST AN OUTSIDE IMPLEMENTATION. These values were produced by
   * `@huggingface/transformers`'s `mel_filter_bank(201, 80, 0, 8000, 16000,
   * 'slaney', 'slaney')` — a separate implementation of the same librosa
   * function, in a package this repo does not depend on. Our matrix agreed
   * with all 16080 of its entries to a maximum absolute difference of
   * 2.05e-16, i.e. floating-point identical.
   *
   * They are pinned rather than merely derived because a derivation checked
   * against itself proves nothing, and because the failure mode is silent: an
   * HTK-scaled filterbank still transcribes short clean speech correctly, and
   * a linear one produces "The dust-top show through a subtle tone of process
   * for inference" — fluent, confident, and wrong.
   */
  const REFERENCE: [number, number, number][] = [
    [0, 1, 0.024862593984176087],
    [1, 2, 0.022871772096078016],
    [33, 33, 0.018177473406255303],
    [79, 190, 0.0022320550527126443],
    [79, 199, 0.0004487590275890477],
  ];

  it('matches the reference filterbank entry for entry', () => {
    const filters = melFilterBank(16000, 400, 80);
    expect(filters).toHaveLength(80 * 201);
    for (const [row, column, expected] of REFERENCE) {
      expect(filters[row * 201 + column], `row ${row}, column ${column}`).toBeCloseTo(expected, 15);
    }
  });

  it('has the total weight the Slaney normalisation produces', () => {
    const filters = melFilterBank(16000, 400, 80);
    let total = 0;
    for (const value of filters) total += value;
    // An HTK-scaled bank sums to a different number, so this is the cheap
    // whole-matrix check that the SCALE is right and not just five cells.
    expect(total).toBeCloseTo(1.9990241029178575, 12);
  });

  it('is triangular: every row rises to one peak and falls back to zero', () => {
    const filters = melFilterBank(16000, 400, 80);
    for (let row = 0; row < 80; row += 1) {
      const values = Array.from(filters.slice(row * 201, (row + 1) * 201));
      const peak = values.indexOf(Math.max(...values));
      for (let i = 1; i <= peak; i += 1) expect(values[i]!).toBeGreaterThanOrEqual(values[i - 1]!);
      for (let i = peak + 1; i < values.length; i += 1) {
        expect(values[i]!).toBeLessThanOrEqual(values[i - 1]!);
      }
      expect(values.at(-1)).toBeCloseTo(0, 10);
    }
  });
});

describe('audio decoding', () => {
  it('reads a 16-bit mono WAV', () => {
    const wav = Buffer.from(silentWav(), 'base64');
    const decoded = decodeWav(new Uint8Array(wav));
    expect(decoded.sampleRate).toBe(16000);
    expect(decoded.channels).toBe(1);
    expect(decoded.samples).toHaveLength(16000);
  });

  it('refuses bytes that are not a RIFF file, quoting what it found', () => {
    expect(() => decodeWav(new TextEncoder().encode('OggS.....a very long ogg file'))).toThrowError(
      /not a RIFF\/WAVE file: it begins with "OggS"/,
    );
  });

  it('refuses a media type it cannot decode instead of guessing', async () => {
    const { plugin, handle } = await loadedWhisper([10]);
    await expect(
      plugin.transcribe({
        handle,
        audio: Buffer.from('not audio').toString('base64'),
        mediaType: 'audio/mpeg',
        requestId: 'turn-a',
      }),
    ).rejects.toThrowError(/cannot decode "audio\/mpeg"/);
  });

  it('refuses headerless PCM with no declared rate', async () => {
    const { plugin, handle } = await loadedWhisper([10]);
    await expect(
      plugin.transcribe({
        handle,
        audio: Buffer.alloc(320).toString('base64'),
        mediaType: 'audio/l16',
        requestId: 'turn-b',
      }),
    ).rejects.toThrowError(/sample rate must be declared/);
  });

  it('resamples to the requested rate', () => {
    const source = Float32Array.from({ length: 100 }, (_, i) => i / 100);
    expect(resample(source, 32000, 16000)).toHaveLength(50);
    expect(resample(source, 8000, 16000)).toHaveLength(200);
    expect(resample(source, 16000, 16000)).toBe(source);
  });
});

describe('the Whisper tokenizer', () => {
  const tokenizer = WhisperTokenizer.fromJson(FAKE_TOKENIZER);

  it('decodes byte-level tokens back to text', () => {
    expect(tokenizer.decode([0, 1])).toBe('Hello world');
  });

  it('reassembles a multi-byte character split across two tokens', () => {
    // "café": the two bytes of "é" arrive as separate tokens. Decoding token
    // by token would produce replacement characters for every accented word.
    expect(tokenizer.decode([2, 3])).toBe(' café');
  });

  it('drops control markers by default and keeps them on request', () => {
    expect(tokenizer.decode([11, 12, 0, 1, 10])).toBe('Hello world');
    expect(tokenizer.decode([11, 0], { skipSpecial: false })).toBe('<|startoftranscript|>Hello');
  });

  it('reads the control tokens out of the vocabulary rather than hard-coding ids', () => {
    expect(tokenizer.special.startOfTranscript).toBe(11);
    expect(tokenizer.special.timestampBegin).toBe(16);
    expect(tokenizer.special.languages.get('en')).toBe(12);
    expect(tokenizer.isTimestamp(17)).toBe(true);
    expect(tokenizer.isTimestamp(15)).toBe(false);
    expect(tokenizer.timestampSeconds(19)).toBeCloseTo(0.06, 10);
  });

  it('refuses a vocabulary that is not a Whisper one', () => {
    expect(() =>
      WhisperTokenizer.fromJson({ model: { vocab: { hello: 0 } }, added_tokens: [] }),
    ).toThrowError(/no "<\|startoftranscript\|>" token/);
    expect(() => WhisperTokenizer.fromJson({})).toThrowError(/no `model\.vocab`/);
  });
});
