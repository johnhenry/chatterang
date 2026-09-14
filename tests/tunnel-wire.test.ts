import { describe, expect, it } from 'vitest';

import {
  FRAME_KINDS,
  MAX_FRAME_BYTES,
  MAX_ID_LENGTH,
  REFUSALS,
  TUNNEL_WIRE_VERSION,
  TunnelWireError,
  UNRECOGNISED_REFUSAL,
  checkPeerProtocol,
  decodeFrame,
  encodeFrame,
  isTurnScoped,
  refusalOf,
  resolveAttach,
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
  waiting: { v: TUNNEL_WIRE_VERSION, kind: 'waiting', turn: 't1', body: { position: 2 } },
  prompt: {
    v: TUNNEL_WIRE_VERSION,
    kind: 'prompt',
    turn: 't1',
    prompt: 'p1',
    body: {
      action: 'send tool output to Work MCP',
      title: 'Send tool output to Work MCP?',
      body: 'bash read 3 files from this app’s own data.',
      detail: ['bash · 120 chars'],
      confirmLabel: 'Send this turn',
      cancelLabel: 'Don’t send',
    },
  },
  answer: { v: TUNNEL_WIRE_VERSION, kind: 'answer', turn: 't1', prompt: 'p1', body: { approved: false } },
  attach: { v: TUNNEL_WIRE_VERSION, kind: 'attach', turn: 't1' },
  ack: { v: TUNNEL_WIRE_VERSION, kind: 'ack', turn: 't1' },
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

const TURN_SCOPED = ['turn', 'chunk', 'cancel', 'waiting', 'prompt', 'answer', 'attach', 'ack'] as const;

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
    for (const kind of TURN_SCOPED) {
      expect(SAMPLES[kind]).toHaveProperty('turn');
    }
    for (const kind of ['hello', 'ping', 'pong', 'bye'] as const) {
      expect(SAMPLES[kind]).not.toHaveProperty('turn');
    }
    expect(FRAME_KINDS.filter(isTurnScoped).sort()).toEqual([...TURN_SCOPED].sort());
  });

  it('keeps two concurrent turns apart', () => {
    const a = encodeFrame({ v: TUNNEL_WIRE_VERSION, kind: 'chunk', turn: 'a', body: { delta: '1' } });
    const b = encodeFrame({ v: TUNNEL_WIRE_VERSION, kind: 'chunk', turn: 'b', body: { delta: '2' } });
    const [da, db] = [decodeFrame(a), decodeFrame(b)];
    expect(da.kind === 'chunk' && da.turn).toBe('a');
    expect(db.kind === 'chunk' && db.turn).toBe('b');
  });
});

const raw = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

describe('what the envelope refuses', () => {
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
    /*
     * EVERY turn-scoped kind, each otherwise complete, so the only thing wrong
     * with it is the missing id. A `prompt` with its prompt id and a valid
     * body, and no turn, is the case that matters most: a prompt nobody can
     * tie to a turn is a prompt whose answer could approve anything.
     */
    const rest: Record<(typeof TURN_SCOPED)[number], Record<string, unknown>> = {
      turn: { body: {} },
      chunk: { body: {} },
      cancel: {},
      waiting: { body: { position: 1 } },
      prompt: { prompt: 'p1', body: { action: 'run bash' } },
      answer: { prompt: 'p1', body: { approved: true } },
      attach: {},
      ack: {},
    };
    for (const kind of TURN_SCOPED) {
      const frame = { v: TUNNEL_WIRE_VERSION, kind, ...rest[kind] };
      expect(() => decodeFrame(raw(frame)), kind).toThrow(/turn id/);
      expect(() => encodeFrame(frame as unknown as TunnelFrame), kind).toThrow(/turn id/);
      for (const turn of ['', 7, null]) {
        expect(() => decodeFrame(raw({ ...frame, turn })), `${kind} ${String(turn)}`).toThrow(/turn id/);
      }
      // The control: the same frame with its id is a frame.
      expect(decodeFrame(raw({ ...frame, turn: 't1' })).kind, kind).toBe(kind);
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

  it(`refuses an id longer than ${MAX_ID_LENGTH} characters, in either direction`, () => {
    /*
     * Both ends now keep state keyed by these ids for a tunnel's life. The
     * boundary is measured on both sides of it, and on the old `turn` frame as
     * well as the new ones, because the table the id lands in is the same.
     */
    const fits = 'x'.repeat(MAX_ID_LENGTH);
    const over = 'x'.repeat(MAX_ID_LENGTH + 1);
    const turnFrame = (turn: string) => ({ v: TUNNEL_WIRE_VERSION, kind: 'turn', turn, body: {} });
    const promptFrame = (prompt: string) => ({
      v: TUNNEL_WIRE_VERSION,
      kind: 'prompt',
      turn: 't1',
      prompt,
      body: { action: 'run bash' },
    });
    expect(decodeFrame(raw(turnFrame(fits))).kind).toBe('turn');
    expect(decodeFrame(raw(promptFrame(fits))).kind).toBe('prompt');
    expect(() => decodeFrame(raw(turnFrame(over)))).toThrow(/over the 128 limit/);
    expect(() => decodeFrame(raw(promptFrame(over)))).toThrow(/prompt id is 129 characters/);
    expect(() => encodeFrame(turnFrame(over) as TunnelFrame)).toThrow(TunnelWireError);
    expect(() =>
      decodeFrame(raw({ v: TUNNEL_WIRE_VERSION, kind: 'error', turn: over, body: { code: 'X', message: 'y' } })),
    ).toThrow(/turn id/);
  });
});

describe('#7’s frames: each field checked on the way in and on the way out', () => {
  const frame = (kind: string, fields: Record<string, unknown>) => ({
    v: TUNNEL_WIRE_VERSION,
    kind,
    turn: 't1',
    ...fields,
  });
  /** Refused as bytes from a peer AND as a frame this end tries to write. */
  const refusedBothWays = (value: Record<string, unknown>, pattern: RegExp) => {
    expect(() => decodeFrame(raw(value)), `decode ${JSON.stringify(value)}`).toThrow(pattern);
    expect(() => encodeFrame(value as unknown as TunnelFrame), `encode ${JSON.stringify(value)}`).toThrow(
      pattern,
    );
  };

  it('a waiting position is a whole number from 1', () => {
    for (const position of [0, -1, 1.5, '2', null, true, 2 ** 53]) {
      refusedBothWays(frame('waiting', { body: { position } }), /position/);
    }
    refusedBothWays(frame('waiting', {}), /no body/);
    // And the ends of what is allowed.
    for (const position of [1, Number.MAX_SAFE_INTEGER]) {
      expect(decodeFrame(raw(frame('waiting', { body: { position } })))).toEqual(
        frame('waiting', { body: { position } }),
      );
    }
  });

  it('a position JSON would change is refused at the send, not discovered at the far end', () => {
    // NaN and Infinity are written as `null`. Encoding them would put a frame
    // on the wire that closes the tunnel at the other end as FRAME_INVALID.
    expect(JSON.stringify({ position: Number.NaN })).toBe('{"position":null}');
    for (const position of [Number.NaN, Infinity]) {
      expect(() => encodeFrame(frame('waiting', { body: { position } }) as unknown as TunnelFrame)).toThrow(
        /position/,
      );
    }
  });

  it('a prompt needs its prompt id and an action, and every other field is text', () => {
    const body = { action: 'run bash' };
    refusedBothWays(frame('prompt', { body }), /prompt id/);
    refusedBothWays(frame('prompt', { prompt: '', body }), /prompt id/);
    refusedBothWays(frame('prompt', { prompt: 'p1' }), /no body/);
    refusedBothWays(frame('prompt', { prompt: 'p1', body: ['run bash'] }), /no body/);
    refusedBothWays(frame('prompt', { prompt: 'p1', body: {} }), /no action/);
    refusedBothWays(frame('prompt', { prompt: 'p1', body: { action: '' } }), /no action/);
    for (const field of ['title', 'body', 'confirmLabel', 'cancelLabel']) {
      refusedBothWays(frame('prompt', { prompt: 'p1', body: { ...body, [field]: 5 } }), new RegExp(`${field} is not a string`));
    }
    refusedBothWays(frame('prompt', { prompt: 'p1', body: { ...body, detail: 'one line' } }), /not a list/);
    refusedBothWays(frame('prompt', { prompt: 'p1', body: { ...body, detail: ['a', 2] } }), /detail line 1/);
  });

  it('a hole in a prompt’s detail is refused, not written as null', () => {
    // `every` skips holes, so a check written with it passes this list.
    const detail: string[] = ['first'];
    detail[2] = 'third';
    expect(detail.every((line) => typeof line === 'string')).toBe(true);
    expect(() =>
      encodeFrame(frame('prompt', { prompt: 'p1', body: { action: 'run bash', detail } }) as unknown as TunnelFrame),
    ).toThrow(/detail line 1/);
  });

  it('a prompt field this build does not know is dropped coming in and refused going out', () => {
    /*
     * THE ASYMMETRY `codec/` STATES, applied to the prompt. A newer desktop's
     * extra field reaches an older phone as the sheet without it, which is a
     * narrower yes. The same field written by THIS build would be dropped by
     * JSON — `onExtended` is a function — and the phone would be shown a
     * different sheet from the one the desktop meant.
     */
    const withExtra = frame('prompt', {
      prompt: 'p1',
      body: { action: 'run bash', extendedLabel: 'Send for this conversation' },
    });
    expect(decodeFrame(raw(withExtra))).toEqual(frame('prompt', { prompt: 'p1', body: { action: 'run bash' } }));
    expect(() => encodeFrame(withExtra as unknown as TunnelFrame)).toThrow(/extendedLabel/);
    expect(() =>
      encodeFrame(
        frame('prompt', { prompt: 'p1', body: { action: 'run bash', onExtended: () => undefined } }) as unknown as TunnelFrame,
      ),
    ).toThrow(/onExtended/);
  });

  it('an answer is a yes or a no, for one prompt', () => {
    refusedBothWays(frame('answer', { body: { approved: true } }), /prompt id/);
    refusedBothWays(frame('answer', { prompt: 'p1' }), /no body/);
    for (const approved of ['yes', 1, null, undefined]) {
      refusedBothWays(frame('answer', { prompt: 'p1', body: { approved } }), /yes or no/);
    }
  });

  it('attach and ack carry a turn id and nothing else', () => {
    for (const kind of ['attach', 'ack']) {
      const extra = frame(kind, { device: 'phone-b' });
      // A device named in a frame is a claim nobody verified. Dropped coming
      // in, refused going out.
      expect(decodeFrame(raw(extra))).toEqual(frame(kind, {}));
      expect(() => encodeFrame(extra as unknown as TunnelFrame), kind).toThrow(/device/);
    }
  });

  it('writes the checked frame, so nothing the frame does not have reaches the socket', () => {
    const bytes = encodeFrame({ v: TUNNEL_WIRE_VERSION, kind: 'ping', secret: 'x' } as unknown as TunnelFrame);
    expect(new TextDecoder().decode(bytes)).toBe(`{"v":${String(TUNNEL_WIRE_VERSION)},"kind":"ping"}`);
  });
});

describe('the error frame’s refusal vocabulary', () => {
  const error = (fields: Record<string, unknown>, code: string) => ({
    v: TUNNEL_WIRE_VERSION,
    kind: 'error',
    ...fields,
    body: { code, message: 'because' },
  });

  it('defines exactly these codes, as one frozen table', () => {
    expect(REFUSALS).toEqual({
      WAIT_LIST_FULL: { kind: 'busy', scope: 'turn', endsTurn: true },
      DESKTOP_QUITTING: { kind: 'quitting', scope: 'turn-or-connection', endsTurn: true },
      HOST_SUSPENDED: { kind: 'suspended', scope: 'turn-or-connection', endsTurn: true },
      HOST_DOES_NOT_RUN_TURNS: { kind: 'refused', scope: 'turn-or-connection', endsTurn: true },
      PROMPT_EXPIRED: { kind: 'prompt-expired', scope: 'prompt', endsTurn: false },
      RESULT_UNKNOWN: { kind: 'result-unknown', scope: 'turn', endsTurn: true },
      FRAME_UNEXPECTED: { kind: 'unexpected', scope: 'any', endsTurn: false },
    });
    expect(Object.isFrozen(REFUSALS)).toBe(true);
    for (const row of Object.values(REFUSALS)) expect(Object.isFrozen(row)).toBe(true);
  });

  it('reads a code it does not know as a failure that ends the turn', () => {
    expect(refusalOf('FROM_A_NEWER_BUILD')).toBe(UNRECOGNISED_REFUSAL);
    expect(UNRECOGNISED_REFUSAL).toEqual({ kind: 'unrecognised', scope: 'any', endsTurn: true });
    // Names every object inherits are not codes this build defines.
    for (const code of ['toString', 'constructor', '__proto__', 'hasOwnProperty']) {
      expect(refusalOf(code), code).toBe(UNRECOGNISED_REFUSAL);
    }
  });

  it('holds each defined code to its scope', () => {
    expect(() => decodeFrame(raw(error({}, 'WAIT_LIST_FULL')))).toThrow(/must name the turn/);
    expect(() => decodeFrame(raw(error({}, 'RESULT_UNKNOWN')))).toThrow(/must name the turn/);
    expect(() => decodeFrame(raw(error({ turn: 't1' }, 'PROMPT_EXPIRED')))).toThrow(/must name the prompt/);
    expect(() => decodeFrame(raw(error({ turn: 't1', prompt: 'p1' }, 'DESKTOP_QUITTING')))).toThrow(
      /refuses a turn, not a prompt/,
    );
    expect(() => decodeFrame(raw(error({ turn: 't1', prompt: 'p1' }, 'WAIT_LIST_FULL')))).toThrow(
      /refuses a turn, not a prompt/,
    );
    // And what each scope allows.
    for (const [fields, code] of [
      [{}, 'DESKTOP_QUITTING'],
      [{ turn: 't1' }, 'DESKTOP_QUITTING'],
      [{}, 'HOST_SUSPENDED'],
      [{}, 'HOST_DOES_NOT_RUN_TURNS'],
      [{ turn: 't1' }, 'HOST_DOES_NOT_RUN_TURNS'],
      [{ turn: 't1', prompt: 'p1' }, 'PROMPT_EXPIRED'],
      [{}, 'FRAME_UNEXPECTED'],
      [{ turn: 't1', prompt: 'p1' }, 'FRAME_UNEXPECTED'],
      [{ turn: 't1', prompt: 'p1' }, 'FROM_A_NEWER_BUILD'],
    ] as const) {
      expect(decodeFrame(raw(error(fields, code))), `${code} ${JSON.stringify(fields)}`).toEqual(error(fields, code));
    }
  });

  it('refuses a prompt with no turn, and a malformed turn rather than dropping it', () => {
    expect(() => decodeFrame(raw(error({ prompt: 'p1' }, 'FRAME_UNEXPECTED')))).toThrow(/names a prompt but no turn/);
    // It used to be dropped, which turned a refusal of one turn into a refusal
    // naming none — and one naming none ends every turn its sender runs.
    expect(() => decodeFrame(raw(error({ turn: 7 }, 'FROM_A_NEWER_BUILD')))).toThrow(/turn id/);
  });
});

describe('the attach rule', () => {
  const held = [
    { device: 'phone-a', turn: 't1', reply: 'for a' },
    { device: 'phone-b', turn: 't2', reply: 'for b' },
    // One turn id used by two devices: ids are minted by each phone.
    { device: 'phone-b', turn: 't1', reply: 'for b, same id' },
  ];

  it('hands a device its own held result', () => {
    expect(resolveAttach(held, 'phone-a', 't1')).toEqual({ ok: true, held: held[0] });
    expect(resolveAttach(held, 'phone-b', 't1')).toEqual({ ok: true, held: held[2] });
  });

  it('gives another device’s result the same answer as a turn never held', () => {
    const others = resolveAttach(held, 'phone-a', 't2');
    expect(others).toEqual({ ok: false, code: 'RESULT_UNKNOWN' });
    expect(resolveAttach(held, 'phone-a', 'never')).toEqual(others);
    expect(resolveAttach(held, 'phone-c', 't1')).toEqual(others);
  });

  it('collects nothing for a socket no credential authenticated', () => {
    expect(resolveAttach([{ device: '', turn: 't1' }], '', 't1')).toEqual({ ok: false, code: 'RESULT_UNKNOWN' });
  });

  it('delivers neither of two results held under one device and turn', () => {
    const twice = [
      { device: 'phone-a', turn: 't1', reply: 'one' },
      { device: 'phone-a', turn: 't1', reply: 'two' },
    ];
    expect(resolveAttach(twice, 'phone-a', 't1')).toEqual({ ok: false, code: 'RESULT_UNKNOWN' });
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
