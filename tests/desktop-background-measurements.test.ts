import { describe, expect, it } from 'vitest';

import type {
  GenerateOptions,
  GenerateResult,
  GenerationEndEvent,
  LlamaCppPlugin,
  TokenEvent,
} from '@chatterang/contracts';
import type {
  LlamaEngine,
  LlamaEngineContext,
  LlamaEngineModel,
  LlamaEngineSequence,
  LlamaGpu,
  LlamaTokenId,
} from '@chatterang/inference-node';
import { LlamaCppNode } from '@chatterang/inference-node';
import {
  DEFAULT_POLICY,
  HANDLE_LOST,
  HOST_TIMEOUT,
  LLAMA_HOST_POLICY,
  LLAMA_PLUGIN,
  Supervisor,
  createHostRuntime,
} from '@chatterang/desktop/bridge';
import type { HostMessage, MessageLink, SupervisorTimers } from '@chatterang/desktop/bridge';

/**
 * #7 BUILD SLICE S1: MEASUREMENTS, AND NOTHING THAT CHANGES WHAT SHIPS.
 *
 * Every test here pins what the code does TODAY, including where today is
 * wrong for background work. They are characterisations, not fixes: a test in
 * this file going red means the measured behaviour changed, and the note in
 * `docs/BACKGROUND-WORK-MEASUREMENTS.md` that quotes it has to change with it.
 *
 * What is measured, and where the result is used:
 *
 *   1. The Supervisor across a simulated sleep, with a turn and a ping
 *      outstanding. The work broker (S2) and the lifecycle wiring (S7) both
 *      lean on what the Supervisor does on the first tick after a wake.
 *   2. Two concurrent `generate` calls on one loaded llama handle, at the only
 *      layer a test can reach without a model file: `LlamaCppNode` over an
 *      engine double. What llama.cpp itself does is NOT measured here — no
 *      GGUF exists in CI — and the note says so.
 *   3. Whether an UNCHANGED Supervisor can serve a worker that speaks the host
 *      envelope over a real `MessageChannel`. The static half of that question
 *      (which layers the envelope drags in) lives in `tests/layering.test.ts`,
 *      next to the bans it is measured against.
 */

/* ── A clock the test owns ────────────────────────────────────────────── */

interface ManualClock extends SupervisorTimers {
  /** Move the wall clock forward by `ms` in ONE step, then run one tick. */
  advance(ms: number): Promise<void>;
}

/**
 * The same shape `tests/desktop-bridge.test.ts` drives the Supervisor with.
 *
 * ONE STEP IS THE POINT. `systemTimers()` reads `Date.now()`, which counts the
 * time a machine spends suspended on every OS, while the tick itself is an
 * interval: after a wake the first tick sees the whole suspended span at once.
 * A single `advance` across the span is that tick.
 */
function manualClock(): ManualClock {
  let now = 0;
  const ticks = new Set<() => void>();
  const pending = new Set<{ at: number; fn: () => void }>();
  return {
    now: () => now,
    every: (_ms, fn) => {
      ticks.add(fn);
      return () => ticks.delete(fn);
    },
    after: (ms, fn) => {
      const entry = { at: now + ms, fn };
      pending.add(entry);
      return () => pending.delete(entry);
    },
    async advance(ms: number): Promise<void> {
      now += ms;
      for (const entry of [...pending]) {
        if (entry.at > now) continue;
        pending.delete(entry);
        entry.fn();
      }
      for (const fn of [...ticks]) fn();
      await new Promise((done) => setTimeout(done, 0));
    },
  };
}

const settle = async (): Promise<void> => {
  await new Promise((done) => setTimeout(done, 10));
};

/* ══ 1. The Supervisor across a sleep ═══════════════════════════════════ */

interface WiredHost {
  readonly posted: HostMessage[];
  killed: boolean;
  /** Deliver one envelope from the host, synchronously. */
  send(message: HostMessage): void;
}

interface Wired {
  readonly supervisor: Supervisor;
  readonly hosts: WiredHost[];
  readonly clock: ManualClock;
  readonly ends: GenerationEndEvent[];
  readonly warnings: string[];
  generate(senderId: number, options: GenerateOptions): Promise<unknown>;
}

/** A Supervisor over hosts that answer only what `answer` tells them to. */
function wired(answer?: (host: WiredHost, message: HostMessage) => void): Wired {
  const clock = manualClock();
  const hosts: WiredHost[] = [];
  const ends: GenerationEndEvent[] = [];
  const warnings: string[] = [];
  const supervisor = new Supervisor({
    spawn: () => {
      const listeners: ((message: unknown) => void)[] = [];
      const host: WiredHost = {
        posted: [],
        killed: false,
        send: (message) => {
          for (const listener of listeners) listener(message);
        },
      };
      hosts.push(host);
      return {
        link: {
          postMessage: (message) => {
            host.posted.push(message as HostMessage);
            answer?.(host, message as HostMessage);
          },
          onMessage: (listener) => listeners.push(listener),
          onClose: () => undefined,
        },
        kill: () => {
          host.killed = true;
        },
      };
    },
    notify: (_plugin, eventName, data) => {
      if (eventName === 'llamaEnd') ends.push(data as GenerationEndEvent);
    },
    warn: (message) => warnings.push(message),
    timers: clock,
  });
  const facade = supervisor.plugin(LLAMA_PLUGIN.name) as unknown as {
    generate(senderId: number, options: GenerateOptions): Promise<unknown>;
  };
  return {
    supervisor,
    hosts,
    clock,
    ends,
    warnings,
    generate: (senderId, options) => facade.generate(senderId, options),
  };
}

/** Eight hours: a laptop closed overnight. */
const OVERNIGHT_MS = 8 * 60 * 60 * 1000;

describe('S1.1 the Supervisor across a simulated sleep (characterisation, not a fix)', () => {
  it('a turn and a ping outstanding when the lid closes: the first tick after wake times the turn out AND condemns a host that was about to answer', async () => {
    // A HEALTHY host. It answers every ping — but the answer to the ping that
    // was in flight when the machine suspended is still queued on wake, which
    // is the case this measures. Nothing about the host is wedged.
    const queuedPongs: HostMessage[] = [];
    const w = wired((_host, message) => {
      if (message.k === 'ping') queuedPongs.push({ k: 'pong', id: message.id });
    });

    const turn = w.generate(7, { handle: 'h', prompt: 'p', requestId: 'across-sleep' });
    void turn.catch(() => undefined);

    // The ping goes out on schedule.
    await w.clock.advance(DEFAULT_POLICY.pingIntervalMs + 1);
    expect(queuedPongs).toHaveLength(1);

    // The turn is making progress right up to the suspend: a token resets its
    // idle deadline, so on a machine that never slept it has two minutes left.
    w.hosts[0]?.send({
      k: 'ev',
      plugin: LLAMA_PLUGIN.name,
      name: 'llamaToken',
      data: { requestId: 'across-sleep', token: 'still decoding', index: 0 } satisfies TokenEvent,
    });
    expect(w.supervisor.inflightCount).toBe(1);

    // The machine sleeps overnight and wakes. One tick sees all of it.
    await w.clock.advance(OVERNIGHT_MS);
    await settle();

    // MEASURED, 1: the turn's promise rejects as a timeout...
    await expect(turn).rejects.toMatchObject({ code: HOST_TIMEOUT });
    // ...and exactly one terminal event reaches the window, so "every
    // generation ends exactly once" still holds across the sleep.
    expect(w.ends).toHaveLength(1);
    expect(w.ends[0]?.requestId).toBe('across-sleep');
    expect(w.ends[0]?.stopReason).toBe('error');
    // MEASURED, 2: but that one terminal names the HOST as dead, not the turn
    // as slow. The deadline sweep rejects the call first; the ping check in
    // the same tick then condemns the host and synthesises the end from its
    // own message; the rejection's settle arrives at a table already cleared.
    expect(w.ends[0]?.error).toMatch(/stopped unexpectedly \(no answer to a liveness ping in \d+ms/);
    expect(w.warnings).toContain('inference host ended a generation that is not in flight.');

    // MEASURED, 3: the healthy host is killed and replaced. On the desktop
    // that is a llama process torn down and a model reloaded on every wake
    // that catches a ping in flight.
    expect(w.hosts[0]?.killed).toBe(true);
    await w.clock.advance(DEFAULT_POLICY.restartDelayMs + 1);
    expect(w.supervisor.spawnCount).toBe(2);

    // And the answer it was about to give is dropped as coming from a host
    // the supervisor has given up on.
    for (const pong of queuedPongs) w.hosts[0]?.send(pong);
    expect(w.supervisor.spawnCount).toBe(2);
  });

  it('the threshold is the ping budget, not the night: a suspend of pingTimeoutMs with a ping in flight is enough', async () => {
    // Under the budget: the host survives and its late pong is accepted.
    const nap = wired();
    await nap.clock.advance(DEFAULT_POLICY.pingIntervalMs + 1);
    const ping = nap.hosts[0]?.posted.at(-1);
    expect(ping?.k).toBe('ping');
    await nap.clock.advance(DEFAULT_POLICY.pingTimeoutMs - 1);
    expect(nap.hosts[0]?.killed).toBe(false);
    nap.hosts[0]?.send({ k: 'pong', id: (ping as { id: number }).id });
    await nap.clock.advance(DEFAULT_POLICY.tickMs);
    expect(nap.hosts[0]?.killed).toBe(false);
    expect(nap.supervisor.spawnCount).toBe(1);

    // At the budget: condemned. Ten seconds with the lid shut is a sleep.
    const shut = wired();
    await shut.clock.advance(DEFAULT_POLICY.pingIntervalMs + 1);
    await shut.clock.advance(DEFAULT_POLICY.pingTimeoutMs);
    expect(shut.hosts[0]?.killed).toBe(true);
  });

  it('with no ping in flight the host is kept, but a turn is still timed out by any suspend past its idle deadline', async () => {
    // Pings are answered at once, so none is outstanding at the suspend.
    const w = wired((host, message) => {
      if (message.k === 'ping') host.send({ k: 'pong', id: message.id });
    });
    const turn = w.generate(7, { handle: 'h', prompt: 'p', requestId: 'turn-only' });
    void turn.catch(() => undefined);
    w.hosts[0]?.send({
      k: 'ev',
      plugin: LLAMA_PLUGIN.name,
      name: 'llamaToken',
      data: { requestId: 'turn-only', token: 'x', index: 0 } satisfies TokenEvent,
    });

    // Just under the idle deadline: the turn survives the suspend.
    await w.clock.advance(DEFAULT_POLICY.generateIdleTimeoutMs - 1);
    expect(w.supervisor.inflightCount).toBe(1);
    expect(w.ends).toHaveLength(0);

    // Past it, measured from the last token: HOST_TIMEOUT, one terminal, and
    // the host kept, because it answered the ping the wake tick sent.
    await w.clock.advance(2);
    await expect(turn).rejects.toMatchObject({ code: HOST_TIMEOUT });
    await settle();
    expect(w.ends).toHaveLength(1);
    expect(w.ends[0]?.error).toMatch(/stopped answering/);
    expect(w.hosts[0]?.killed).toBe(false);
    expect(w.supervisor.spawnCount).toBe(1);
  });
});

/* ══ 2. Two generates on one handle ═════════════════════════════════════ */

class Vocabulary {
  readonly #ids = new Map<string, number>();
  readonly #texts: string[] = [];
  encode(text: string): LlamaTokenId[] {
    return (text.match(/\S+\s*|\s+/g) ?? []).map((piece) => {
      const existing = this.#ids.get(piece);
      if (existing !== undefined) return existing;
      const id = this.#texts.push(piece) - 1;
      this.#ids.set(piece, id);
      return id;
    });
  }
  decode(tokens: readonly LlamaTokenId[]): string {
    return tokens.map((token) => this.#texts[token] ?? '').join('');
  }
}

/**
 * A sequence that records what it was asked to do, and when.
 *
 * `adaptStateToTokens` truncates the way node-llama-cpp 3.20.0's does with
 * `allowShift: false` — it erases from the first differing token to the end —
 * because that is the call a second turn makes on a sequence the first turn is
 * still decoding into. The truncation is the DOUBLE's; the real sequence's
 * behaviour under that call is not measured here.
 */
class RecordingSequence implements LlamaEngineSequence {
  state: LlamaTokenId[] = [];
  readonly tokenPredictions = { validated: 0, refuted: 0 };
  activeEvaluations = 0;
  maxActiveEvaluations = 0;
  /** Alignments that ran while another turn's `evaluate` was mid-stream, and what they erased. */
  readonly alignmentsDuringDecode: { erased: number }[] = [];

  constructor(
    private readonly vocabulary: Vocabulary,
    private readonly reply: string,
  ) {}

  get nextTokenIndex(): number {
    return this.state.length;
  }
  compareContextTokens(tokens: LlamaTokenId[]): { firstDifferentIndex: number } {
    for (let i = 0; i < this.state.length; i += 1) {
      if (this.state[i] !== tokens[i]) return { firstDifferentIndex: i };
    }
    return { firstDifferentIndex: this.state.length };
  }
  async adaptStateToTokens(tokens: LlamaTokenId[]): Promise<void> {
    const keep = this.compareContextTokens(tokens).firstDifferentIndex;
    if (this.activeEvaluations > 0) {
      this.alignmentsDuringDecode.push({ erased: this.state.length - keep });
    }
    this.state = this.state.slice(0, keep);
  }
  async clearHistory(): Promise<void> {
    this.state = [];
  }
  async *evaluate(tokens: LlamaTokenId[]): AsyncIterable<LlamaTokenId> {
    this.activeEvaluations += 1;
    this.maxActiveEvaluations = Math.max(this.maxActiveEvaluations, this.activeEvaluations);
    try {
      this.state.push(...tokens);
      for (const token of this.vocabulary.encode(this.reply)) {
        await new Promise((done) => setTimeout(done, 1));
        this.state.push(token);
        yield token;
      }
    } finally {
      this.activeEvaluations -= 1;
    }
  }
  async evaluateWithoutGeneratingNewTokens(tokens: LlamaTokenId[]): Promise<void> {
    this.state.push(...tokens);
  }
  async dispose(): Promise<void> {}
}

class RecordingEngine implements LlamaEngine {
  readonly gpu: LlamaGpu = false;
  readonly engineVersion = 'llama.cpp b-measurement';
  readonly sequences: RecordingSequence[] = [];
  readonly #vocabulary = new Vocabulary();
  constructor(private readonly reply: string) {}
  async listGpuTypes(): Promise<LlamaGpu[]> {
    return [];
  }
  async getMemoryState(): Promise<{ free: number; total: number }> {
    return { free: 0, total: 0 };
  }
  async loadModel(): Promise<LlamaEngineModel> {
    const vocabulary = this.#vocabulary;
    const reply = this.reply;
    const sequences = this.sequences;
    return {
      trainContextSize: 8192,
      chatTemplateName: 'chatML',
      tokenize: (text: string) => vocabulary.encode(text),
      detokenize: (tokens: readonly LlamaTokenId[]) => vocabulary.decode(tokens),
      createContext: async (): Promise<LlamaEngineContext> => ({
        contextSize: 4096,
        getSequence: () => {
          const sequence = new RecordingSequence(vocabulary, reply);
          sequences.push(sequence);
          return sequence;
        },
        dispose: async () => undefined,
      }),
      dispose: async () => undefined,
    };
  }
  async dispose(): Promise<void> {}
}

describe('S1.2 two concurrent generate calls on one loaded handle (plugin layer only)', () => {
  it('LlamaCppNode neither refuses nor queues a second turn on a handle that is decoding: both reach the one sequence at once', async () => {
    // WHY THIS LAYER. The question the design asks is what llama.cpp does with
    // two generations on one loaded model, and that needs a GGUF — which no CI
    // run has and this suite does not download. What CAN be measured without
    // one is whether anything between the bridge and the native sequence
    // serialises the two. If something did, the broker's slot would be a
    // second lock; this shows it would be the only one.
    const engine = new RecordingEngine('one two three four five six seven eight nine ten');
    const plugin = new LlamaCppNode({ createEngine: async () => engine });
    const ends: GenerationEndEvent[] = [];
    await plugin.addListener('llamaEnd', (event) => ends.push(event));

    let firstTokenSeen: () => void = () => undefined;
    const firstToken = new Promise<void>((done) => {
      firstTokenSeen = done;
    });
    await plugin.addListener('llamaToken', (event) => {
      if (event.requestId === 'first') firstTokenSeen();
    });

    const { handle } = await plugin.load({ modelPath: '/models/one.gguf' });
    expect(engine.sequences).toHaveLength(1);
    const sequence = engine.sequences[0]!;

    const first = plugin.generate({ handle, prompt: 'the first turn asks about apples', requestId: 'first' });
    await firstToken;
    const second = plugin.generate({ handle, prompt: 'another turn asks about pears', requestId: 'second' });

    const [a, b] = (await Promise.all([first, second])) as [GenerateResult, GenerateResult];

    // MEASURED: no refusal, no queue. Both turns decoded on the ONE sequence
    // the handle owns, at the same time.
    expect(a.stopReason).toBe('stop');
    expect(b.stopReason).toBe('stop');
    expect(sequence.maxActiveEvaluations).toBe(2);
    // And the second turn's prefix alignment ran while the first was still
    // decoding into that sequence, erasing context the first had written.
    expect(sequence.alignmentsDuringDecode.length).toBeGreaterThan(0);
    expect(sequence.alignmentsDuringDecode[0]?.erased).toBeGreaterThan(0);
    // The plugin's own terminal rule holds per turn regardless.
    expect(ends.map((event) => event.requestId).sort()).toEqual(['first', 'second']);

    await plugin.dispose();
  });
});

/* ══ 3. An unchanged Supervisor over a real MessagePort ═════════════════ */

/** The Node `MessagePort` surface the adapter uses: EventEmitter-style `on`. */
interface NodePort {
  on(event: 'message', listener: (message: unknown) => void): void;
  on(event: 'close', listener: () => void): void;
  postMessage(message: unknown): void;
  close(): void;
}

/**
 * A `MessageLink` over one end of a real `MessageChannel`.
 *
 * Loss is the port's own `close` event, which is what Electron documents for
 * `MessagePortMain` ("emitted when the remote end ... becomes disconnected").
 * Whether a renderer that CRASHES disconnects its end is not measured here;
 * that needs a window and belongs to the worker host (S5).
 */
function portLink(port: MessagePort): MessageLink {
  const node = port as unknown as NodePort;
  return {
    postMessage: (message) => node.postMessage(message),
    onMessage: (listener) => node.on('message', listener),
    onClose: (listener) => node.on('close', () => listener('the message port closed')),
  };
}

/** A worker-shaped plugin: `generate` does what the test says. */
function workerPlugin(
  onGenerate: (options: GenerateOptions, emit: (name: string, data: unknown) => void) => Promise<GenerateResult>,
): LlamaCppPlugin {
  const listeners = new Map<string, Set<(data: unknown) => void>>();
  const emit = (name: string, data: unknown): void => {
    for (const listener of listeners.get(name) ?? []) listener(data);
  };
  return {
    addListener: async (name: string, listener: (data: unknown) => void) => {
      const set = listeners.get(name) ?? new Set();
      set.add(listener);
      listeners.set(name, set);
      return { remove: async () => void set.delete(listener) };
    },
    removeAllListeners: async () => listeners.clear(),
    generate: (options: GenerateOptions) => onGenerate(options, emit),
    cancel: async () => undefined,
  } as unknown as LlamaCppPlugin;
}

function endOf(requestId: string): GenerationEndEvent {
  return {
    requestId,
    text: 'done',
    promptTokens: 1,
    cachedTokens: 0,
    completionTokens: 1,
    ttftMs: 1,
    totalMs: 1,
    tokensPerSecond: 1,
    stopReason: 'stop',
  };
}

describe('S1.3 an unchanged Supervisor serves the host envelope over a real MessageChannel', () => {
  it('a turn runs end to end across the port, with its one terminal event', async () => {
    const ports: NodePort[] = [];
    const ends: GenerationEndEvent[] = [];
    const supervisor = new Supervisor({
      spawn: () => {
        const { port1, port2 } = new MessageChannel();
        ports.push(port1 as unknown as NodePort, port2 as unknown as NodePort);
        createHostRuntime({ link: portLink(port2) }).serve(
          LLAMA_PLUGIN,
          workerPlugin(async (options, emit) => {
            emit('llamaToken', { requestId: options.requestId, token: 'done', index: 0 });
            const end = endOf(options.requestId);
            emit('llamaEnd', end);
            return end;
          }),
          LLAMA_HOST_POLICY,
        );
        return { link: portLink(port1), kill: () => (port2 as unknown as NodePort).close() };
      },
      notify: (_plugin, eventName, data) => {
        if (eventName === 'llamaEnd') ends.push(data as GenerationEndEvent);
      },
      timers: manualClock(),
    });
    try {
      const facade = supervisor.plugin(LLAMA_PLUGIN.name) as unknown as {
        generate(senderId: number, options: GenerateOptions): Promise<GenerateResult>;
      };
      const result = await facade.generate(3, { handle: 'h', prompt: 'p', requestId: 'over-a-port' });
      await settle();
      expect(result.stopReason).toBe('stop');
      expect(ends.map((end) => end.requestId)).toEqual(['over-a-port']);
      expect(supervisor.inflightCount).toBe(0);
    } finally {
      supervisor.dispose();
      for (const port of ports) port.close();
    }
  });

  it('closing the far end mid-turn is loss: one synthesised terminal and HANDLE_LOST, with no change to the class', async () => {
    const ports: NodePort[] = [];
    const ends: GenerationEndEvent[] = [];
    let started: () => void = () => undefined;
    const running = new Promise<void>((done) => {
      started = done;
    });
    const supervisor = new Supervisor({
      spawn: () => {
        const { port1, port2 } = new MessageChannel();
        ports.push(port1 as unknown as NodePort, port2 as unknown as NodePort);
        createHostRuntime({ link: portLink(port2) }).serve(
          LLAMA_PLUGIN,
          workerPlugin(() => {
            started();
            return new Promise<GenerateResult>(() => undefined);
          }),
          LLAMA_HOST_POLICY,
        );
        return { link: portLink(port1), kill: () => (port2 as unknown as NodePort).close() };
      },
      notify: (_plugin, eventName, data) => {
        if (eventName === 'llamaEnd') ends.push(data as GenerationEndEvent);
      },
      timers: manualClock(),
    });
    try {
      const facade = supervisor.plugin(LLAMA_PLUGIN.name) as unknown as {
        generate(senderId: number, options: GenerateOptions): Promise<GenerateResult>;
      };
      const turn = facade.generate(3, { handle: 'h', prompt: 'p', requestId: 'port-lost' });
      void turn.catch(() => undefined);
      await running;

      // The worker's end of the channel goes away.
      ports[1]?.close();

      await expect(turn).rejects.toMatchObject({ code: HANDLE_LOST });
      await settle();
      expect(ends).toHaveLength(1);
      expect(ends[0]?.requestId).toBe('port-lost');
      expect(ends[0]?.error).toMatch(/the message port closed/);
    } finally {
      supervisor.dispose();
      for (const port of ports) port.close();
    }
  });
});
