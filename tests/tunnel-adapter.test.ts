import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { IRChatRequest, IRChatStream, IRStreamChunk } from '@johnhenry/aimatey-types';
import { CodecRefusal } from '@chatterang/tunnel/codec';
import { encodeFrame, toolLoopOf, type TunnelFrame } from '@chatterang/tunnel/wire';

import { TunnelBackendAdapter } from '@/ai/backends/tunnel';
import { ChatterangEngine, targetFor, type GenerationEvent } from '@/ai/engine';
import { reachPaired } from '@/domain/chat';

import { drainEvents, probeManifest, probeResolver, recordingBackend } from './support/egress-probe';
import { fakeTunnel, type AbnormalEnd, type DesktopScript, type FakeTunnelOptions } from './support/fake-tunnel';

/**
 * The phone's end of a paired turn: `TunnelBackendAdapter` over an injected
 * `TunnelClient` (S10 U3; refs #184, #185, #186, #188, #190).
 *
 * Driven two ways. Through a real `ChatterangEngine`, whose real Router carries
 * the shipped breaker, so what is asserted is what a chat turn does. And
 * straight through `executeStream`, so "exactly one terminal" is counted on the
 * adapter's own chunks rather than inferred from what the engine made of them.
 *
 * The desktop is `tests/support/fake-tunnel.ts`: two in-memory ends, each behind
 * the real `createProtocolGate`.
 */

const DEVICE = { id: 'pair_1', name: 'Studio' };
const TUNNEL = 'tunnel:pair_1';
const CLOUD = 'conn_cloud';
const MODEL_NAME = 'Qwen on Studio';

/** What the engine says when a stream ends with no terminal at all (engine.ts:1187-1192). */
const EMPTY_RESPONSE_SENTENCE = 'This reply ended before it was complete — the connection stopped part-way.';

/** #7's eighth ruling, verbatim. */
const HOST_DOES_NOT_RUN_TURNS_SENTENCE = "this server doesn't run phone turns yet";

const paired = targetFor('remote', probeManifest.id, MODEL_NAME, TUNNEL, reachPaired(DEVICE));
const history = [{ role: 'user' as const, content: 'what is on my calendar today' }];

function rig(script: DesktopScript, options: FakeTunnelOptions = {}) {
  const engine = new ChatterangEngine({ resolver: probeResolver, fallbackBackendId: null });
  const tunnel = fakeTunnel(script, options);
  const waiting: number[] = [];
  const adapter = new TunnelBackendAdapter({
    device: DEVICE,
    connect: tunnel.connect,
    router: engine.router,
    onWaiting: (position) => waiting.push(position),
  });
  engine.router.register(adapter.backendId, adapter);
  return { engine, tunnel, adapter, waiting };
}

function request(custom: Record<string, unknown> = {}): IRChatRequest {
  return {
    messages: [...history],
    parameters: { model: probeManifest.id },
    metadata: { requestId: 'req_tunnel', timestamp: 0, custom },
    stream: true,
  };
}

async function chunksOf(stream: IRChatStream): Promise<IRStreamChunk[]> {
  const chunks: IRStreamChunk[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

const terminals = (chunks: readonly IRStreamChunk[]) =>
  chunks.filter((chunk) => chunk.type === 'done' || chunk.type === 'error');

/** Exactly one terminal, and it is the last chunk. Returns it. */
function theTerminal(chunks: readonly IRStreamChunk[]): IRStreamChunk {
  expect(terminals(chunks)).toHaveLength(1);
  const last = chunks.at(-1)!;
  expect(last.type === 'done' || last.type === 'error').toBe(true);
  // The adapter numbers its own stream, so what it yields is contiguous.
  expect(chunks.map((chunk) => chunk.sequence)).toEqual(chunks.map((_, index) => index));
  return last;
}

const errorCode = (chunk: IRStreamChunk): string | undefined => (chunk.type === 'error' ? chunk.error.code : undefined);
const deltas = (chunks: readonly IRStreamChunk[]) =>
  chunks.flatMap((chunk) => (chunk.type === 'content' ? [chunk.delta] : []));
const kinds = (frames: readonly TunnelFrame[], kind: TunnelFrame['kind']) => frames.filter((frame) => frame.kind === kind);
const lastError = (events: readonly GenerationEvent[]) => {
  const last = events.at(-1);
  return last?.type === 'error' ? last.message : undefined;
};

const replies =
  (...texts: string[]): DesktopScript =>
  async (desk) => {
    for (const text of texts) await desk.content(text);
    await desk.done();
  };

describe('TunnelBackendAdapter', () => {
  /* ── 1. A turn, end to end ─────────────────────────────────────────── */

  it('registered on a real Router as tunnel:<deviceId>, streams start, deltas and done through the engine', async () => {
    const { engine, tunnel, adapter } = rig(replies('Hello ', 'from ', 'Studio.'));
    expect(adapter.backendId).toBe(TUNNEL);

    const events = await drainEvents(engine.stream({ messages: history, target: paired }));

    expect(events.map((event) => event.type)).toEqual(['start', 'delta', 'delta', 'delta', 'done']);
    const done = events.at(-1);
    expect(done?.type === 'done' ? done.text : undefined).toBe('Hello from Studio.');
    expect(tunnel.scriptErrors).toEqual([]);

    // What went up: one turn, whose tool loop stays on this phone (#152), and
    // whose body is the request the engine built for this destination.
    const [turn] = kinds(tunnel.desktopRead, 'turn');
    expect(kinds(tunnel.desktopRead, 'turn')).toHaveLength(1);
    expect(turn?.kind === 'turn' ? toolLoopOf(turn) : null).toBe('requester');
    const body = turn?.kind === 'turn' ? (turn.body as IRChatRequest) : undefined;
    expect(body?.messages).toEqual(history);
    expect(body?.metadata.custom?.backend).toBe(TUNNEL);
  });

  it('declares streaming and no multimodal input', () => {
    const { adapter } = rig(replies('x'));
    expect(adapter.metadata.capabilities.streaming).toBe(true);
    expect(adapter.metadata.capabilities.multiModal).toBe(false);
  });

  /* ── 2. A cut is the tunnel's failure, not the engine's generic one ── */

  it('a cut after three chunks ends in error with PEER_GONE, not the engine’s EMPTY_RESPONSE', async () => {
    const cutAfterThree: DesktopScript = async (desk) => {
      await desk.content('one ');
      await desk.content('two ');
      await desk.content('three');
      desk.cut();
    };

    const direct = rig(cutAfterThree);
    const chunks = await chunksOf(direct.adapter.executeStream(request()));
    expect(deltas(chunks)).toEqual(['one ', 'two ', 'three']);
    expect(errorCode(theTerminal(chunks))).toBe('PEER_GONE');

    const { engine } = rig(cutAfterThree);
    const events = await drainEvents(engine.stream({ messages: history, target: paired }));
    expect(events.some((event) => event.type === 'done')).toBe(false);
    expect(events.at(-1)?.type).toBe('error');
    expect(lastError(events)).not.toBe(EMPTY_RESPONSE_SENTENCE);
    expect(lastError(events)).toContain(DEVICE.name);
  });

  it.each([
    ['TUNNEL_FULL'],
    ['PAIRING_ONLY'],
    ['PAIRING_WINDOW_CLOSED'],
  ] as const)('an abnormal end with %s becomes one error chunk with that code', async (code: AbnormalEnd) => {
    const { adapter } = rig(async (desk) => {
      await desk.content('partial');
      desk.closeWith(code);
    });
    const chunks = await chunksOf(adapter.executeStream(request()));
    expect(errorCode(theTerminal(chunks))).toBe(code);
  });

  it('a bye before the reply finished is an error, not a done', async () => {
    const { adapter } = rig(async (desk) => {
      await desk.content('partial');
      await desk.bye();
    });
    const chunks = await chunksOf(adapter.executeStream(request()));
    expect(theTerminal(chunks).type).toBe('error');
  });

  it('a desktop that cannot be reached is one error chunk, and no turn is sent', async () => {
    const { adapter, tunnel } = rig(replies('never'), { unreachable: true });
    const chunks = await chunksOf(adapter.executeStream(request()));
    expect(theTerminal(chunks).type).toBe('error');
    expect(tunnel.phoneSent).toEqual([]);
  });

  /* ── 3. A gap fails the turn before anything after it is shown ──────── */

  it('a sequence gap gives SEQUENCE_BROKEN before any later delta', async () => {
    const gap: DesktopScript = async (desk) => {
      await desk.content('one ');
      await desk.content('two ');
      desk.skipSequence();
      await desk.content('four');
      await desk.done();
    };

    const direct = rig(gap);
    const chunks = await chunksOf(direct.adapter.executeStream(request()));
    expect(deltas(chunks)).toEqual(['one ', 'two ']);
    expect(errorCode(theTerminal(chunks))).toBe('SEQUENCE_BROKEN');

    const { engine } = rig(gap);
    const events = await drainEvents(engine.stream({ messages: history, target: paired }));
    expect(events.flatMap((event) => (event.type === 'delta' ? [event.text] : []))).toEqual(['one ', 'two ']);
    expect(events.at(-1)?.type).toBe('error');
  });

  /* ── 4. A refusal is never done ────────────────────────────────────── */

  describe.each([
    ['WAIT_LIST_FULL', {}],
    ['HOST_DOES_NOT_RUN_TURNS', {}],
    ['HOST_DOES_NOT_RUN_TURNS', { connection: true }],
    ['TOOL_LOOP_UNSUPPORTED', {}],
    ['DESKTOP_QUITTING', {}],
    ['DESKTOP_QUITTING', { connection: true }],
    ['HOST_SUSPENDED', {}],
    ['FROM_A_NEWER_BUILD', {}],
  ] as const)('a %s refusal %o', (code, scope) => {
    it('is one error chunk carrying the code, and never done', async () => {
      const { adapter, tunnel } = rig((desk) => desk.refuse(code, scope));
      const chunks = await chunksOf(adapter.executeStream(request()));
      expect(chunks.some((chunk) => chunk.type === 'done')).toBe(false);
      expect(errorCode(theTerminal(chunks))).toBe(code);
      expect(tunnel.scriptErrors).toEqual([]);
    });

    it('ends the engine’s turn in error', async () => {
      const { engine } = rig((desk) => desk.refuse(code, scope));
      const events = await drainEvents(engine.stream({ messages: history, target: paired }));
      expect(events.some((event) => event.type === 'done')).toBe(false);
      expect(events.at(-1)?.type).toBe('error');
    });
  });

  it('a refusal after the reply started is still never done', async () => {
    const { adapter } = rig(async (desk) => {
      await desk.content('half a reply');
      await desk.refuse('HOST_SUSPENDED');
    });
    const chunks = await chunksOf(adapter.executeStream(request()));
    expect(deltas(chunks)).toEqual(['half a reply']);
    expect(errorCode(theTerminal(chunks))).toBe('HOST_SUSPENDED');
  });

  it('a FRAME_UNEXPECTED naming the turn before anything ran ends it, rather than waiting forever', async () => {
    const { adapter } = rig((desk) => desk.refuse('FRAME_UNEXPECTED'));
    const chunks = await chunksOf(adapter.executeStream(request()));
    expect(errorCode(theTerminal(chunks))).toBe('FRAME_UNEXPECTED');
  });

  it(`renders HOST_DOES_NOT_RUN_TURNS as "${HOST_DOES_NOT_RUN_TURNS_SENTENCE}" (#7, eighth ruling)`, async () => {
    const { engine } = rig((desk) => desk.refuse('HOST_DOES_NOT_RUN_TURNS'));
    const events = await drainEvents(engine.stream({ messages: history, target: paired }));
    expect(lastError(events)).toBe(HOST_DOES_NOT_RUN_TURNS_SENTENCE);
  });

  it('an error chunk from the desktop passes through with its own code and message', async () => {
    const failing: DesktopScript = async (desk) => {
      await desk.content('so far');
      await desk.errorChunk('generation_failed', 'the desktop ran out of memory');
    };
    const direct = rig(failing);
    const chunks = await chunksOf(direct.adapter.executeStream(request()));
    const terminal = theTerminal(chunks);
    expect(terminal).toMatchObject({ type: 'error', error: { code: 'generation_failed', message: 'the desktop ran out of memory' } });

    const { engine } = rig(failing);
    const events = await drainEvents(engine.stream({ messages: history, target: paired }));
    expect(lastError(events)).toBe('the desktop ran out of memory');
  });

  /* ── 5. What the breaker counts (#186) ─────────────────────────────── */

  describe.each(['WAIT_LIST_FULL', 'HOST_SUSPENDED', 'DESKTOP_QUITTING'])('%s', (code) => {
    it('three in a row leave the Router circuit closed, and the next turn still reaches the desktop', async () => {
      const { engine, tunnel } = rig((desk) => desk.refuse(code));

      for (let attempt = 1; attempt <= 3; attempt += 1) {
        const events = await drainEvents(engine.stream({ messages: history, target: paired }));
        expect(events.at(-1)?.type).toBe('error');
        expect(engine.router.getBackendInfo(TUNNEL)?.circuitBreakerState).toBe('closed');
        expect(engine.router.isBackendAvailable(TUNNEL)).toBe(true);
      }

      const fourth = await drainEvents(engine.stream({ messages: history, target: paired }));
      expect(lastError(fourth)).not.toContain('paused');
      expect(kinds(tunnel.desktopRead, 'turn')).toHaveLength(4);
    });
  });

  // #186's "unreachable (desktop asleep) — retry cheaply": a refused connection
  // arrives in milliseconds, so three of them and a thirty-second pause is
  // noise. Each turn tries the desktop again, and the engine never tells the
  // person to re-enter a key for a device that has none.
  it('a desktop that cannot be reached, turn after turn, leaves the circuit closed and every turn tries it again', async () => {
    const { engine, tunnel } = rig(replies('never'), { unreachable: true });

    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const events = await drainEvents(engine.stream({ messages: history, target: paired }));
      expect(tunnel.connectAttempts()).toBe(attempt);
      expect(lastError(events)).toBe(`${DEVICE.name} could not be reached.`);
      expect(engine.router.getBackendInfo(TUNNEL)?.circuitBreakerState).toBe('closed');
      expect(engine.router.isBackendAvailable(TUNNEL)).toBe(true);
    }
    expect(tunnel.phoneSent).toEqual([]);
  });

  it('a desktop that cannot be reached is one PEER_UNREACHABLE error chunk', async () => {
    const { adapter } = rig(replies('never'), { unreachable: true });
    const chunks = await chunksOf(adapter.executeStream(request()));
    expect(errorCode(theTerminal(chunks))).toBe('PEER_UNREACHABLE');
  });

  describe.each([
    ['a cut', (async (desk) => desk.cut()) satisfies DesktopScript],
    ['a refusal this build does not know', ((desk) => desk.refuse('FROM_A_NEWER_BUILD')) satisfies DesktopScript],
  ])('control: %s', (_, script) => {
    it('three in a row DO open the circuit, so the breaker is live on this rig', async () => {
      const { engine, tunnel } = rig(script);
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        await drainEvents(engine.stream({ messages: history, target: paired }));
      }
      expect(engine.router.getBackendInfo(TUNNEL)?.circuitBreakerState).toBe('open');

      const fourth = await drainEvents(engine.stream({ messages: history, target: paired }));
      expect(lastError(fourth)).toContain('paused');
      expect(kinds(tunnel.desktopRead, 'turn')).toHaveLength(3);
    });
  });

  it('settles only its own entry: another backend’s open circuit stays open', async () => {
    const { engine } = rig((desk) => desk.refuse('WAIT_LIST_FULL'));
    engine.router.register(CLOUD, recordingBackend(['cloud']).adapter);
    engine.router.openCircuitBreaker(CLOUD);

    await drainEvents(engine.stream({ messages: history, target: paired }));

    expect(engine.router.getBackendInfo(CLOUD)?.circuitBreakerState).toBe('open');
  });

  /* ── 6. Stop ──────────────────────────────────────────────────────── */

  it('Stop mid-reply sends exactly one cancel, and the stream ends with one terminal', async () => {
    const { adapter, tunnel } = rig(async (desk) => {
      await desk.content('one ');
      await desk.content('two ');
      await desk.next('cancel');
      await desk.done('cancelled');
    });
    const controller = new AbortController();
    const chunks: IRStreamChunk[] = [];
    for await (const chunk of adapter.executeStream(request(), controller.signal)) {
      chunks.push(chunk);
      if (deltas(chunks).length === 2) controller.abort();
    }

    expect(kinds(tunnel.phoneSent, 'cancel')).toHaveLength(1);
    expect(kinds(tunnel.desktopRead, 'cancel')).toHaveLength(1);
    const terminal = theTerminal(chunks);
    // Not an error: three Stops must not pause the tunnel (router.js trackStream).
    expect(terminal).toMatchObject({ type: 'done', finishReason: 'cancelled' });
  });

  it('Stop through the engine sends exactly one cancel and leaves the circuit closed', async () => {
    const { engine, tunnel } = rig(async (desk) => {
      await desk.content('one ');
      await desk.next('cancel');
    });
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const controller = new AbortController();
      const events: GenerationEvent[] = [];
      for await (const event of engine.stream({ messages: history, target: paired, signal: controller.signal })) {
        events.push(event);
        if (event.type === 'delta') controller.abort();
      }
      expect(events.some((event) => event.type === 'error')).toBe(false);
    }
    expect(kinds(tunnel.phoneSent, 'cancel')).toHaveLength(3);
    expect(engine.router.getBackendInfo(TUNNEL)?.circuitBreakerState).toBe('closed');
  });

  it('Stop while waiting sends one cancel, and no place in line is reported after it', async () => {
    const controller = new AbortController();
    const { adapter, tunnel, waiting } = rig(async (desk) => {
      await desk.waiting(2);
      await desk.next('cancel');
    });
    const chunks: IRStreamChunk[] = [];
    const stream = adapter.executeStream(request(), controller.signal);
    const drained = (async () => {
      for await (const chunk of stream) chunks.push(chunk);
    })();
    await expect.poll(() => waiting).toEqual([2]);
    controller.abort();
    await drained;

    expect(kinds(tunnel.phoneSent, 'cancel')).toHaveLength(1);
    expect(waiting).toEqual([2]);
    expect(theTerminal(chunks)).toMatchObject({ type: 'done', finishReason: 'cancelled' });
  });

  it('a turn stopped before it began sends nothing at all', async () => {
    const { adapter, tunnel } = rig(replies('never'));
    const controller = new AbortController();
    controller.abort();
    const chunks = await chunksOf(adapter.executeStream(request(), controller.signal));
    expect(tunnel.connections()).toBe(0);
    expect(tunnel.phoneSent).toEqual([]);
    expect(theTerminal(chunks)).toMatchObject({ type: 'done', finishReason: 'cancelled' });
  });

  /* ── 7. done.message is required over a tunnel (#260) ───────────────── */

  it('a done without message is an error, through the gate', async () => {
    const { adapter } = rig(async (desk) => {
      await desk.content('unverifiable');
      await desk.doneWithoutMessage();
    });
    const chunks = await chunksOf(adapter.executeStream(request()));
    expect(chunks.some((chunk) => chunk.type === 'done')).toBe(false);
    expect(theTerminal(chunks).type).toBe('error');
  });

  it('a done without message is an error even from a client that does not run the gate', async () => {
    const script: DesktopScript = async (desk) => {
      await desk.content('unverifiable');
      await desk.doneWithoutMessage();
    };
    const direct = rig(script, { receiveUngated: true });
    const chunks = await chunksOf(direct.adapter.executeStream(request()));
    expect(chunks.some((chunk) => chunk.type === 'done')).toBe(false);
    expect(errorCode(theTerminal(chunks))).toBe('SEQUENCE_BROKEN');

    const { engine } = rig(script, { receiveUngated: true });
    const events = await drainEvents(engine.stream({ messages: history, target: paired }));
    expect(events.some((event) => event.type === 'done')).toBe(false);
    expect(events.at(-1)?.type).toBe('error');
  });

  it('a done passes through with the desktop’s own copy of the reply as its message', async () => {
    const { adapter } = rig(replies('Hello ', 'there.'));
    const chunks = await chunksOf(adapter.executeStream(request()));
    expect(theTerminal(chunks)).toMatchObject({
      type: 'done',
      finishReason: 'stop',
      message: { role: 'assistant', content: 'Hello there.' },
    });
  });

  /* ── waiting goes to onWaiting, never into chunks ─────────────────── */

  it('waiting positions go to onWaiting and never into the stream', async () => {
    const { adapter, waiting } = rig(async (desk) => {
      await desk.waiting(2);
      await desk.waiting(1);
      await desk.content('your turn');
      await desk.done();
    });
    const chunks = await chunksOf(adapter.executeStream(request()));
    expect(chunks.map((chunk) => chunk.type)).toEqual(['start', 'content', 'done']);
    // 0 when the reply starts, which is what takes "Waiting" off the rail.
    expect(waiting).toEqual([2, 1, 0]);
  });

  /* ── a relayed prompt is out of scope: the loop stays here, so no ───── */

  it('answers a prompt with no, because this turn asked to keep its tool loop', async () => {
    let answer: TunnelFrame | undefined;
    const { adapter } = rig(async (desk) => {
      await desk.prompt('p1', 'Run ls in /chats');
      answer = await desk.next('answer');
      await desk.content('did nothing');
      await desk.done();
    });
    const chunks = await chunksOf(adapter.executeStream(request()));
    expect(answer).toMatchObject({ kind: 'answer', prompt: 'p1', body: { approved: false } });
    expect(theTerminal(chunks).type).toBe('done');
  });

  /* ── fromIR and the codec ─────────────────────────────────────────── */

  it('fromIR returns a sendable turn frame, a new id each time, the body the request', () => {
    const { adapter } = rig(replies('x'));
    const first = adapter.fromIR(request({ backend: TUNNEL }));
    const second = adapter.fromIR(request());
    expect(first.kind).toBe('turn');
    expect(toolLoopOf(first)).toBe('requester');
    expect(first.turn).not.toBe(second.turn);
    expect(() => encodeFrame(first)).not.toThrow();
    expect(first.body).toEqual(request({ backend: TUNNEL }));
  });

  it('refuses a request the codec will not send, before any connection is opened', async () => {
    const { adapter, tunnel } = rig(replies('never'));
    const unsendable = request({ size: 10n });
    expect(() => adapter.fromIR(unsendable)).toThrow(CodecRefusal);

    const chunks = await chunksOf(adapter.executeStream(unsendable));
    const terminal = theTerminal(chunks);
    expect(errorCode(terminal)).toBe('CODEC_REFUSED');
    expect(terminal.type === 'error' ? terminal.error.message : '').toContain('metadata.custom.size');
    expect(tunnel.connections()).toBe(0);
  });

  /* ── 8. The phone never diverts its turn to its own cloud (#188) ───── */

  describe.each([
    ['a cut', (async (desk) => {
      await desk.content('partial');
      desk.cut();
    }) satisfies DesktopScript],
    ['a busy refusal', ((desk) => desk.refuse('WAIT_LIST_FULL')) satisfies DesktopScript],
    ['an error chunk', ((desk) => desk.errorChunk('generation_failed', 'boom')) satisfies DesktopScript],
  ])('with a nominated cloud fallback registered, %s', (_, script) => {
    it('never calls the cloud: no fallback, the turn ends in error', async () => {
      const { engine, tunnel } = rig(script);
      const cloud = recordingBackend(['ANSWERED BY THE CLOUD.']);
      engine.router.register(CLOUD, cloud.adapter);
      engine.setFallbackBackend(CLOUD);

      const events = await drainEvents(engine.stream({ messages: history, target: paired }));

      expect(kinds(tunnel.desktopRead, 'turn')).toHaveLength(1);
      expect(cloud.seen).toHaveLength(0);
      expect(events.some((event) => event.type === 'fallback')).toBe(false);
      expect(events.at(-1)?.type).toBe('error');
    });
  });

  /* ── 9. The file itself ───────────────────────────────────────────── */

  describe('src/ai/backends/tunnel.ts', () => {
    const source = () => readFileSync(resolve(process.cwd(), 'src/ai/backends/tunnel.ts'), 'utf8');
    const DOUBLE_CAST = /\bas\s+unknown\s+as\b/;

    it('has no double cast', () => {
      expect(DOUBLE_CAST.test('const x = y as unknown as Z;')).toBe(true);
      expect(source()).not.toMatch(DOUBLE_CAST);
    });

    it('imports only the client type, the wire, the stream, the codec and the IR types', () => {
      const specifiers = [...source().matchAll(/^import\s+(type\s+)?[^;]*?from\s+'([^']+)';/gms)].map(
        (match) => `${match[1] ? 'type ' : ''}${match[2]}`,
      );
      expect(specifiers.length).toBeGreaterThan(0);
      const allowed = new Set([
        'type @chatterang/tunnel/client',
        '@chatterang/tunnel/wire',
        'type @chatterang/tunnel/wire',
        '@chatterang/tunnel/stream',
        '@chatterang/tunnel/codec',
        'type @johnhenry/aimatey-types',
      ]);
      expect(specifiers.filter((specifier) => !allowed.has(specifier))).toEqual([]);
    });
  });
});
