// @vitest-environment node
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import { classifyFrame, createTunnelClient } from '@chatterang/tunnel/client';
import { createTunnelListener, type Tunnel } from '@chatterang/tunnel/host';
import { TunnelProtocolError, createTurnLedger } from '@chatterang/tunnel/stream';
import {
  REFUSALS,
  TUNNEL_WIRE_VERSION,
  TunnelWireError,
  decodeFrame,
  encodeFrame,
  refusalOf,
  toolLoopOf,
  type TunnelFrame,
} from '@chatterang/tunnel/wire';

import { credentialHeaders, testGate } from './support/tunnel-gate';

/**
 * WHO RUNS THE TOOL LOOP (#152, refs #159 and #296).
 *
 * The owner's ruling on #152: the request says who owns the tool loop, the
 * device that asks can require that the loop stays with it, the far side
 * refuses with a defined frame, and the flag is part of the wire contract. So
 * it is a named field on the `turn` frame — never `metadata.custom` (#141) —
 * and a refusal code in `REFUSALS`.
 *
 * THE DECODE RULE IS WHAT MAKES THE REFUSAL SENDABLE. A `turn` whose
 * `toolLoop` is missing or a value this build does not know is still a frame:
 * if `decodeFrame` threw on it, the tunnel would close on a `TunnelWireError`
 * and `TOOL_LOOP_UNSUPPORTED` could never be sent. So decode carries the raw
 * value, `toolLoopOf` is the one reader, and it answers `null` for anything but
 * the two values — which a host refuses, failing closed. The null cases are
 * built from raw JSON bytes for that reason: `encodeFrame` would refuse them.
 *
 * Manners from `tests/rung0-vocabulary.test.ts`: real client and listener on
 * loopback through the real credential gate, ephemeral ports, everything closed
 * in `afterEach`, no fixed timeouts.
 */

const open: { close(): unknown }[] = [];
afterEach(async () => {
  for (const closeable of open.reverse()) {
    try {
      await closeable.close();
    } catch {
      // Teardown of something the test already tore down.
    }
  }
  open.length = 0;
});

const V = TUNNEL_WIRE_VERSION;
const CODE = 'TOOL_LOOP_UNSUPPORTED';
const raw = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));

const turnFrame = (turn: string, toolLoop: 'requester' | 'host'): TunnelFrame => ({
  v: V,
  kind: 'turn',
  turn,
  toolLoop,
  body: { messages: [] },
});
const content = (turn: string, sequence: number): TunnelFrame => ({
  v: V,
  kind: 'chunk',
  turn,
  body: { type: 'content', sequence, delta: 'x' },
});
const done = (turn: string, sequence: number): TunnelFrame => ({
  v: V,
  kind: 'chunk',
  turn,
  body: { type: 'done', sequence, finishReason: 'stop', message: { role: 'assistant', content: 'x' } },
});
const promptFrame = (turn: string, prompt: string): TunnelFrame => ({
  v: V,
  kind: 'prompt',
  turn,
  prompt,
  body: { action: 'run bash' },
});
const cancel = (turn: string): TunnelFrame => ({ v: V, kind: 'cancel', turn });
const refusal = (code: string, where: { turn?: string; prompt?: string }): TunnelFrame => ({
  v: V,
  kind: 'error',
  ...where,
  body: { code, message: `refused: ${code}` },
});

/** A decoded frame, narrowed to a turn or the test fails here. */
function asTurn(frame: TunnelFrame): Extract<TunnelFrame, { kind: 'turn' }> {
  if (frame.kind !== 'turn') throw new Error(`expected a turn frame, got ${frame.kind}`);
  return frame;
}

function reader<T>(source: AsyncIterable<T>): () => Promise<T> {
  const iterator = source[Symbol.asyncIterator]();
  return async () => {
    const result = await iterator.next();
    if (result.done) throw new Error('the stream ended before the frame this test waited for');
    return result.value;
  };
}

async function eventually(check: () => boolean): Promise<void> {
  while (!check()) await new Promise((resolve) => setTimeout(resolve, 5));
}

async function listen() {
  const gate = testGate();
  const { credential } = await gate.mintDevice();
  const listener = await createTunnelListener({ maxTunnels: 1, binding: gate.binding() });
  open.push(listener);
  const { port } = listener.server.address() as AddressInfo;
  const next = reader(listener.tunnels());
  const nextTunnel = async (): Promise<{ tunnel: Tunnel; hears: () => Promise<TunnelFrame> }> => {
    const tunnel = await next();
    return { tunnel, hears: reader(tunnel.receive()) };
  };
  return { port, credential, nextTunnel };
}

async function phone(port: number, credential: string) {
  const client = await createTunnelClient({ url: `ws://127.0.0.1:${port}`, credential });
  open.push(client);
  return { client, hears: reader(client.receive()) };
}

/** A phone that writes bytes, so it can send a turn `encodeFrame` would refuse. */
async function rawPhone(port: number, credential: string) {
  const { WebSocket } = await import('ws');
  const socket = new WebSocket(`ws://127.0.0.1:${port}`, { headers: credentialHeaders(credential) });
  open.push({ close: () => socket.terminate() });
  const frames: TunnelFrame[] = [];
  socket.on('message', (data: Buffer) => frames.push(decodeFrame(new Uint8Array(data))));
  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve());
    socket.on('error', reject);
  });
  return { frames, sendBytes: (bytes: Uint8Array) => socket.send(bytes) };
}

/** One end of a tunnel's ledger. `hears` is from the peer; `says` is this end's. */
function end() {
  const ledger = createTurnLedger();
  return {
    hears: (frame: TunnelFrame) => ledger.check(frame, 'in'),
    says: (frame: TunnelFrame) => ledger.check(frame, 'out'),
  };
}

describe('the turn frame says who runs the tool loop', () => {
  it.each(['requester', 'host'] as const)('round-trips toolLoop %s as a field of the frame itself', (toolLoop) => {
    const frame = turnFrame('t1', toolLoop);
    const bytes = encodeFrame(frame);
    // On the envelope, beside `turn` — not inside the request body (#141).
    expect(JSON.parse(new TextDecoder().decode(bytes))).toStrictEqual({
      v: V,
      kind: 'turn',
      turn: 't1',
      toolLoop,
      body: { messages: [] },
    });
    const decoded = decodeFrame(bytes);
    expect(decoded).toStrictEqual(frame);
    expect(toolLoopOf(asTurn(decoded))).toBe(toolLoop);
  });

  it('decodes a missing or unknown toolLoop without closing anything, and toolLoopOf reads it as null', () => {
    const cases: readonly [string, Record<string, unknown>][] = [
      ['missing', {}],
      ['phone', { toolLoop: 'phone' }],
      ['HOST', { toolLoop: 'HOST' }],
      ['1', { toolLoop: 1 }],
      ['null', { toolLoop: null }],
      ['padded', { toolLoop: 'host ' }],
      ['a list', { toolLoop: ['host'] }],
      ['an object', { toolLoop: { owner: 'host' } }],
    ];
    for (const [name, fields] of cases) {
      const decoded = asTurn(decodeFrame(raw({ v: V, kind: 'turn', turn: 't1', ...fields, body: {} })));
      expect(toolLoopOf(decoded), name).toBeNull();
      // Carried as it came, so a host can refuse it and say what it was asked.
      expect(decoded.toolLoop, name).toStrictEqual(fields.toolLoop);
    }
  });

  it('refuses to write a turn that does not say requester or host', () => {
    for (const toolLoop of [undefined, 'phone', 'HOST', 1, null]) {
      const frame = { v: V, kind: 'turn', turn: 't1', toolLoop, body: {} } as unknown as TunnelFrame;
      expect(() => encodeFrame(frame), String(toolLoop)).toThrow(TunnelWireError);
      expect(() => encodeFrame(frame), String(toolLoop)).toThrow(/toolLoop/);
    }
    const omitted = { v: V, kind: 'turn', turn: 't1', body: {} } as unknown as TunnelFrame;
    expect(() => encodeFrame(omitted)).toThrow(/toolLoop/);
  });
});

describe('TOOL_LOOP_UNSUPPORTED', () => {
  const error = (fields: Record<string, unknown>) => ({
    v: V,
    kind: 'error',
    ...fields,
    body: { code: CODE, message: 'because' },
  });

  it('is a refusal of one turn that ends it, sent before the turn starts', () => {
    expect(REFUSALS.TOOL_LOOP_UNSUPPORTED).toStrictEqual({
      kind: 'refused',
      scope: 'turn',
      endsTurn: true,
      beforeStart: true,
    });
    expect(Object.isFrozen(REFUSALS.TOOL_LOOP_UNSUPPORTED)).toBe(true);
    expect(refusalOf(CODE)).toBe(REFUSALS.TOOL_LOOP_UNSUPPORTED);
  });

  it('must name the turn it refuses, and never a prompt', () => {
    expect(() => decodeFrame(raw(error({})))).toThrow(/must name the turn/);
    expect(() => decodeFrame(raw(error({ turn: 't1', prompt: 'p1' })))).toThrow(/refuses a turn, not a prompt/);
    expect(decodeFrame(raw(error({ turn: 't1' })))).toStrictEqual(error({ turn: 't1' }));
  });

  it('over loopback: sent before any chunk, the phone reads a refusal that ends the turn at both ends', async () => {
    const { port, credential, nextTunnel } = await listen();
    const { client, hears } = await phone(port, credential);
    const { tunnel, hears: desktopHears } = await nextTunnel();

    await client.send(turnFrame('t1', 'host'));
    const heard = asTurn(await desktopHears());
    expect(toolLoopOf(heard)).toBe('host');
    // A host that serves inference only does not run the loop it was asked to.
    await tunnel.send(refusal(CODE, { turn: 't1' }));

    expect(classifyFrame(await hears())).toStrictEqual({
      kind: 'refused',
      refusal: 'refused',
      endsTurn: true,
      code: CODE,
      message: `refused: ${CODE}`,
      turn: 't1',
    });
    // Over at both ends: nothing more streams, and there is nothing to cancel.
    await expect(tunnel.send(content('t1', 0))).rejects.toThrow(TunnelProtocolError);
    await expect(client.send(cancel('t1'))).rejects.toThrow(TunnelProtocolError);
    expect(client.ended()).toBeNull();
    expect(tunnel.ended()).toBeNull();
  });

  it('over loopback: a turn with no toolLoop, or one this build does not know, is refused and the tunnel stays open', async () => {
    const { port, credential, nextTunnel } = await listen();
    const peer = await rawPhone(port, credential);
    const { tunnel, hears: desktopHears } = await nextTunnel();

    peer.sendBytes(raw({ v: V, kind: 'turn', turn: 't1', body: { messages: [] } }));
    peer.sendBytes(raw({ v: V, kind: 'turn', turn: 't2', toolLoop: 'phone', body: { messages: [] } }));
    for (const turn of ['t1', 't2']) {
      const heard = asTurn(await desktopHears());
      expect(heard.turn).toBe(turn);
      // Fail closed: what the host cannot read as requester or host, it refuses.
      expect(toolLoopOf(heard), turn).toBeNull();
      await tunnel.send(refusal(CODE, { turn }));
    }
    await eventually(() => peer.frames.length === 2);
    expect(peer.frames).toStrictEqual([refusal(CODE, { turn: 't1' }), refusal(CODE, { turn: 't2' })]);
    expect(tunnel.ended()).toBeNull();
  });

  it('over loopback: sent after a chunk, the desktop may not send it, and the turn finishes as it was going', async () => {
    const { port, credential, nextTunnel } = await listen();
    const { client, hears } = await phone(port, credential);
    const { tunnel, hears: desktopHears } = await nextTunnel();

    await client.send(turnFrame('t1', 'requester'));
    await desktopHears();
    await tunnel.send(content('t1', 0));
    await expect(tunnel.send(refusal(CODE, { turn: 't1' }))).rejects.toThrow(/had not started, and it has/);
    await tunnel.send(done('t1', 1));

    expect(classifyFrame(await hears())).toEqual({ kind: 'streaming', turn: 't1' });
    expect(classifyFrame(await hears())).toEqual({ kind: 'completed', turn: 't1' });
    expect(client.ended()).toBeNull();
  });

  it('the ledger refuses it once a chunk or a prompt has started the turn, from both ends, and allows it before', () => {
    for (const starts of [content('t1', 0), promptFrame('t1', 'p1')]) {
      const desktop = end();
      expect(desktop.hears(turnFrame('t1', 'host'))).toBeNull();
      expect(desktop.says(starts)).toBeNull();
      expect(desktop.says(refusal(CODE, { turn: 't1' })), starts.kind).toMatchObject({
        kind: 'error',
        turn: 't1',
        reason: expect.stringMatching(/had not started, and it has/),
      });

      const asker = end();
      expect(asker.says(turnFrame('t1', 'host'))).toBeNull();
      expect(asker.hears(starts)).toBeNull();
      expect(asker.hears(refusal(CODE, { turn: 't1' })), starts.kind).toMatchObject({
        kind: 'error',
        turn: 't1',
        replyCode: 'FRAME_UNEXPECTED',
      });
    }

    // The allowed twin, so none of the above passes on a ledger refusing everything.
    const desktop = end();
    expect(desktop.hears(turnFrame('t1', 'requester'))).toBeNull();
    expect(desktop.says(refusal(CODE, { turn: 't1' }))).toBeNull();
    const asker = end();
    expect(asker.says(turnFrame('t1', 'requester'))).toBeNull();
    expect(asker.hears(refusal(CODE, { turn: 't1' }))).toBeNull();
    // And it ended the turn: a chunk after it is refused.
    expect(asker.hears(content('t1', 0))).toMatchObject({ reason: expect.stringMatching(/already ended/) });
  });
});
