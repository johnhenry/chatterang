import { describe, expect, it } from 'vitest';

import {
  FRAME_KINDS,
  MAX_FRAME_BYTES,
  TUNNEL_WIRE_VERSION,
  TunnelWireError,
  checkPeerProtocol,
  decodeFrame,
  encodeFrame,
  type TunnelFrame,
} from '@chatterang/tunnel/wire';

/**
 * #159. `IRStreamChunk` describes one response and has no correlation id, so
 * two concurrent turns multiplexed on its `sequence` counter interleave into
 * nonsense. These pin the envelope that fixes it — and, as that ticket's Done
 * requires, round-trip EVERY arm rather than a representative sample. An arm
 * nothing exercises is an arm that is wrong.
 */

/** One of every kind, so the exhaustiveness check below has something to find. */
const SAMPLES: Record<string, TunnelFrame> = {
  turn: { v: TUNNEL_WIRE_VERSION, kind: 'turn', turn: 't1', body: { messages: [] } },
  chunk: {
    v: TUNNEL_WIRE_VERSION,
    kind: 'chunk',
    turn: 't1',
    body: { type: 'content', sequence: 3, delta: 'hi' },
  },
  cancel: { v: TUNNEL_WIRE_VERSION, kind: 'cancel', turn: 't1' },
  hello: { v: TUNNEL_WIRE_VERSION, kind: 'hello', body: { protocol: TUNNEL_WIRE_VERSION } },
  ping: { v: TUNNEL_WIRE_VERSION, kind: 'ping' },
  pong: { v: TUNNEL_WIRE_VERSION, kind: 'pong' },
  bye: { v: TUNNEL_WIRE_VERSION, kind: 'bye', body: { reason: 'user closed the app' } },
  error: {
    v: TUNNEL_WIRE_VERSION,
    kind: 'error',
    turn: 't1',
    body: { code: 'PEER_GONE', message: 'the desktop stopped responding' },
  },
  pair: { v: TUNNEL_WIRE_VERSION, kind: 'pair', body: { step: 'message', bytes: 'AAEC' } },
};

describe('the tunnel envelope', () => {
  it('has a sample for every kind it declares', () => {
    // The control on the round-trip below: without this, adding a ninth kind
    // and forgetting its sample leaves the suite green and the arm untested.
    expect(Object.keys(SAMPLES).sort()).toEqual([...FRAME_KINDS].sort());
  });

  it.each(FRAME_KINDS)('round-trips a %s frame unchanged', (kind) => {
    const frame = SAMPLES[kind]!;
    expect(decodeFrame(encodeFrame(frame))).toEqual(frame);
  });

  it('carries a correlation id on exactly the frames that belong to a turn', () => {
    // Two concurrent turns is the whole reason this exists.
    for (const kind of ['turn', 'chunk', 'cancel'] as const) {
      expect(SAMPLES[kind]).toHaveProperty('turn');
    }
    for (const kind of ['hello', 'ping', 'pong', 'bye'] as const) {
      expect(SAMPLES[kind]).not.toHaveProperty('turn');
    }
  });

  it('keeps two concurrent turns apart', () => {
    const a = encodeFrame({ v: TUNNEL_WIRE_VERSION, kind: 'chunk', turn: 'a', body: { delta: '1' } });
    const b = encodeFrame({ v: TUNNEL_WIRE_VERSION, kind: 'chunk', turn: 'b', body: { delta: '2' } });
    const [da, db] = [decodeFrame(a), decodeFrame(b)];
    expect(da.kind === 'chunk' && da.turn).toBe('a');
    expect(db.kind === 'chunk' && db.turn).toBe('b');
  });
});

describe('what the envelope refuses', () => {
  const raw = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

  it('refuses a version it does not speak, with the number in it', () => {
    const bytes = raw({ v: 99, kind: 'ping' });
    expect(() => decodeFrame(bytes)).toThrow(TunnelWireError);
    expect(() => decodeFrame(bytes)).toThrow(/99/);
  });

  it('refuses a kind it does not know, naming what arrived', () => {
    // The likely cause is a peer on a build that knows a kind this one does
    // not, and the version number alone does not say which kind.
    expect(() => decodeFrame(raw({ v: TUNNEL_WIRE_VERSION, kind: 'teleport' }))).toThrow(
      /teleport/,
    );
  });

  it('refuses a turn-scoped frame with no turn id', () => {
    for (const kind of ['turn', 'chunk', 'cancel']) {
      expect(() => decodeFrame(raw({ v: TUNNEL_WIRE_VERSION, kind, body: {} })), kind).toThrow(
        /turn id/,
      );
    }
  });

  it('refuses a hello with no protocol number, and an error with no code', () => {
    expect(() => decodeFrame(raw({ v: TUNNEL_WIRE_VERSION, kind: 'hello', body: {} }))).toThrow(
      /protocol/,
    );
    expect(() =>
      decodeFrame(raw({ v: TUNNEL_WIRE_VERSION, kind: 'error', body: { code: 'X' } })),
    ).toThrow(/code and message/);
  });

  it('refuses a pair frame with no body, and carries a body it does not interpret (#136)', () => {
    // A pairing step with nothing in it is not a step, and a pairing tunnel
    // may carry nothing but these — so an empty one is refused at the codec.
    expect(() => decodeFrame(raw({ v: TUNNEL_WIRE_VERSION, kind: 'pair' }))).toThrow(/pair frame has no body/);
    const opaque = { anything: [1, 'two', { three: null }] };
    expect(decodeFrame(raw({ v: TUNNEL_WIRE_VERSION, kind: 'pair', body: opaque }))).toEqual({
      v: TUNNEL_WIRE_VERSION,
      kind: 'pair',
      body: opaque,
    });
  });

  it('refuses an oversized frame before parsing it', () => {
    // Size first: a peer announcing 900MiB must not get this process to
    // allocate it in order to discover the frame was invalid.
    const huge = new Uint8Array(MAX_FRAME_BYTES + 1);
    expect(() => decodeFrame(huge)).toThrow(/over the/);
  });

  it('does not smuggle a body onto a frame that carries none', () => {
    const decoded = decodeFrame(raw({ v: TUNNEL_WIRE_VERSION, kind: 'ping', body: { x: 1 } }));
    expect(decoded).toEqual({ v: TUNNEL_WIRE_VERSION, kind: 'ping' });
  });

  it('refuses bytes that are not UTF-8 JSON', () => {
    expect(() => decodeFrame(new Uint8Array([0xff, 0xfe, 0xfd]))).toThrow(/UTF-8 JSON/);
  });
});

describe('the protocol handshake', () => {
  it('accepts a peer on this protocol', () => {
    expect(checkPeerProtocol(TUNNEL_WIRE_VERSION)).toEqual({ ok: true });
  });

  it('says which side is behind, rather than just refusing', () => {
    // "It stopped working" is the outcome this exists to prevent. A phone and
    // a desktop will be on different app versions constantly.
    const newer = checkPeerProtocol(TUNNEL_WIRE_VERSION + 1);
    expect(newer.ok).toBe(false);
    expect(newer.ok === false && newer.reason).toMatch(/Update this app/);

    const older = checkPeerProtocol(TUNNEL_WIRE_VERSION - 1);
    expect(older.ok).toBe(false);
    expect(older.ok === false && older.reason).toMatch(/Update the other device/);
  });
});
