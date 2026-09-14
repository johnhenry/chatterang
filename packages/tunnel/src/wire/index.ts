/**
 * THE WIRE: the frame envelope both halves agree on, and the codec for it.
 *
 * This is the bottom of the package. It imports nothing — not a Node builtin,
 * not a DOM type, not the client half, not the host half — because everything
 * it names becomes a dependency of the phone bundle AND of the listener at the
 * same time.
 *
 * WHY THIS IS NOT IN `packages/contracts`. #155 asks the question directly, and
 * the answer is in the guard: `tests/layering.test.ts` pins contracts as
 * types-only ("nothing to build and nothing to drift"), and a wire format is
 * not only types — it is a format plus the one pair of functions that reads and
 * writes it. Putting `TunnelFrame` in contracts and `encodeFrame` here would
 * split a format from its codec across two packages, which is precisely the
 * drift the contracts guard exists to prevent. So the whole of it lives here,
 * and contracts stays types-only.
 *
 * WHAT THIS DELIBERATELY DOES NOT DECIDE. `kind` is an open `string`, not a
 * union. The frames that exist — pairing, chunk, error, close — are #156's and
 * #157's to name, and the transport underneath is #181's to choose, which is
 * not a decision this file or this agent gets to make. What is fixed here is
 * only the shape of the envelope and the fact that a version travels in it, so
 * that a phone and a desktop on different builds disagree LOUDLY at frame one
 * rather than quietly at chunk four hundred.
 *
 * ── #159 RESOLVED THE ABOVE ───────────────────────────────────────────
 *
 * `kind` is a union now. The transport is a native socket plugin on both
 * platforms (#181) and the frames are JSON text with a transport-owned
 * correlation id (#159), so the two things this file was waiting on have
 * answers.
 *
 * WHY A CORRELATION ID AT ALL. `IRStreamChunk` describes one response and
 * carries `sequence` from `BaseStreamChunk`. A socket carries more than one
 * thing at once — a request going up, chunks coming down, a cancel mid-stream,
 * a heartbeat both ways, and a queued request being drained — and two
 * concurrent turns multiplexed on one `sequence` counter interleave into
 * nonsense. `turn` is that id.
 *
 * WHY NOT `IRMetadata.requestId`. It is documented as "stable across retries
 * and fallbacks for correlation", and a far-side Router retry keeps it BY
 * DESIGN. A value deliberately stable across retries cannot identify a stream.
 * Tempting and wrong, which is why it is written down rather than left for
 * someone to rediscover.
 *
 * WHY THE CHUNK IS A `body` AND NOT THE FRAME. `{ kind: 'chunk', turn, body }`
 * keeps the IR union on the far side of this envelope, so aimatey can add a
 * seventh chunk type without touching the wire. It is also why this file still
 * imports nothing, not even a type: the wire does not know what a chunk IS.
 * Whoever reads `body` applies `@chatterang/tunnel/codec` to it.
 *
 * WHY `kind` AND NOT A ONE-CHARACTER `k`. `apps/server/src/wire.ts` uses `k`
 * and is the precedent for the rest of this shape, but `kind` is already what
 * this envelope ships. Renaming a wire field for terseness is a breaking change
 * across two independently-updated binaries in exchange for three bytes a
 * frame, against payloads where base64 images dominate. Not worth it.
 */

/**
 * The envelope version, on every frame.
 *
 * A tunnel is the one place in this app where two independently-updated
 * binaries meet: the phone updates through an app store and the desktop
 * through a download, so they are routinely different builds. Version-on-every
 * frame is cheap and makes the mismatch a decode error with a number in it.
 */
export const TUNNEL_WIRE_VERSION = 1;

/**
 * The id that ties frames to one turn.
 *
 * Minted by whichever side starts the turn and echoed by the other. Opaque:
 * nothing may parse meaning out of it.
 */
export type TurnId = string;

/**
 * The largest frame this build will decode.
 *
 * Sized the way `apps/server/src/wire.ts:117` sizes its own: against the one
 * payload that is genuinely large. A turn carries base64 images inline until
 * they move to by-reference, and 8 MiB leaves room for several while refusing
 * anything an order of magnitude past it — so a peer cannot make this process
 * hold a gigabyte by announcing one. Smaller than the server's 32 MiB because
 * model weights do not cross a tunnel; turns do.
 */
export const MAX_FRAME_BYTES = 8 * 1024 * 1024;

/**
 * The WebSocket close code a listener refuses a connection with when it is
 * already holding as many tunnels as its caller allowed (#169).
 *
 * In 4000-4999, the range RFC 6455 leaves to applications and `ws` accepts;
 * 4000 plus HTTP's 503, which is what the refusal is. It lives HERE rather than
 * in the host because the client has to recognise it and may not import the
 * host half. Without a number both ends share, a refusal reaches the phone as
 * PEER_GONE — a pulled cable mid-stream, which is neither what happened nor
 * something a screen can explain.
 */
export const TUNNEL_CAP_CLOSE_CODE = 4503;

/**
 * The close code for a PAIRING-ONLY tunnel that tried to carry something other
 * than the pairing exchange, or more of it than a pairing needs (#136). A
 * pairing window that closed is {@link TUNNEL_PAIRING_CLOSED_CLOSE_CODE}.
 *
 * A phone with no device credential reaches the listener only while the
 * desktop is showing a pairing code, and then only for the exchange. 4000 plus
 * HTTP's 403: the connection was let in, and this is not something it may do.
 * Here rather than in the host for the reason {@link TUNNEL_CAP_CLOSE_CODE} is.
 */
export const TUNNEL_PAIRING_ONLY_CLOSE_CODE = 4403;

/**
 * The close code for a PAIRING-ONLY tunnel whose pairing window has closed
 * (#136): the code it was admitted under expired, was dismissed or replaced, or
 * another connection completed the pairing — or this one did, and its time to
 * receive the credential is over.
 *
 * Its own code, not {@link TUNNEL_PAIRING_ONLY_CLOSE_CODE}: a phone whose code
 * ran out mid-exchange did nothing it may not do, and telling it otherwise
 * sends its user looking for the wrong fault. 4000 plus HTTP's 410 Gone.
 */
export const TUNNEL_PAIRING_CLOSED_CLOSE_CODE = 4410;

/**
 * The request header a paired device presents its credential in (#135, #136).
 *
 * A HEADER, NEVER THE URL. #136's ruling: a credential in a query string lands
 * in request-line logs, proxy logs and history, so the listener refuses a URL
 * that carries one rather than ignoring it. The native socket plugin (#181)
 * sets this header on the phone. Lower case because Node hands header names to
 * the listener lower-cased, and one spelling is one spelling to grep for.
 */
export const TUNNEL_CREDENTIAL_HEADER = 'chatterang-device-credential';

/** Frames that belong to one turn, and carry its id. */
export type TurnFrame =
  /** A turn going up. `body` is the request; the codec decides what may cross. */
  | { readonly v: number; readonly kind: 'turn'; readonly turn: TurnId; readonly body: unknown }
  /** One `IRStreamChunk` coming down, as a payload rather than as the frame. */
  | { readonly v: number; readonly kind: 'chunk'; readonly turn: TurnId; readonly body: unknown }
  /** Stop this turn. Mid-stream, which is why it needs the id. */
  | { readonly v: number; readonly kind: 'cancel'; readonly turn: TurnId };

/**
 * One message of the pairing exchange (#130, #136).
 *
 * THE ONLY FRAME A PAIRING-ONLY TUNNEL MAY CARRY, beside `hello` and `bye`. It
 * exists so that rule has something to name: without a kind of its own, "the
 * pairing exchange and nothing else" is a sentence the listener cannot enforce.
 * `body` is the exchange's step — a CPace message, a confirmation tag, the
 * credential handed over at the end — and, like `chunk`, the wire does not know
 * what one IS. Its shape is the exchange's to define.
 */
export type PairFrame = { readonly v: number; readonly kind: 'pair'; readonly body: unknown };

/** Frames about the connection rather than about a turn. */
export type ControlFrame =
  /**
   * First frame, both directions. `protocol` is checked and a mismatch is a
   * refusal with a number in it — see {@link TUNNEL_WIRE_VERSION}.
   */
  | {
      readonly v: number;
      readonly kind: 'hello';
      readonly body: { readonly protocol: number; readonly build?: string };
    }
  | { readonly v: number; readonly kind: 'ping' }
  | { readonly v: number; readonly kind: 'pong' }
  /** Going away on purpose, so the far side can tell it from a dropped link. */
  | { readonly v: number; readonly kind: 'bye'; readonly body?: { readonly reason?: string } }
  /**
   * A TRANSPORT-level failure.
   *
   * Deliberately distinct from `StreamErrorChunk`, which is a model-level error
   * the far side produced and which travels inside a `chunk` frame. Collapsing
   * the two is exactly how a transport failure gets reported to the user as a
   * model failure — the defect #148 was ruled on. `turn` is present when the
   * failure belongs to one.
   */
  | {
      readonly v: number;
      readonly kind: 'error';
      readonly turn?: TurnId;
      readonly body: { readonly code: string; readonly message: string };
    };

/** One frame on the tunnel. */
export type TunnelFrame = TurnFrame | ControlFrame | PairFrame;

/** Every `kind` this build knows, for validation and for exhaustive tests. */
export const FRAME_KINDS = [
  'turn',
  'chunk',
  'cancel',
  'hello',
  'ping',
  'pong',
  'bye',
  'error',
  'pair',
] as const;

export type FrameKind = (typeof FRAME_KINDS)[number];

/**
 * The kinds that must carry a {@link TurnId}.
 *
 * A type predicate rather than a `Set.has` call, because `has` returns a
 * boolean and narrows nothing — the decoder below would then be building a
 * union member from a `kind` the compiler still believes could be `ping`.
 */
function isTurnScoped(kind: FrameKind): kind is 'turn' | 'chunk' | 'cancel' {
  return kind === 'turn' || kind === 'chunk' || kind === 'cancel';
}

/** Raised when bytes on the wire are not a frame this build can read. */
export class TunnelWireError extends Error {
  override readonly name = 'TunnelWireError';
}

const TEXT = { encode: new TextEncoder(), decode: new TextDecoder('utf-8', { fatal: true }) };

/**
 * A frame, as bytes.
 *
 * `TextEncoder` rather than `Buffer`: this runs on the phone as well as on the
 * desktop, and `Buffer` is the Node half of a boundary this package exists to
 * keep. The same reason there is no `JSON.stringify` shortcut taken over a
 * `Uint8Array` return — the caller on either side hands bytes to a socket.
 */
export function encodeFrame(frame: TunnelFrame): Uint8Array {
  return TEXT.encode.encode(JSON.stringify({ ...frame, v: TUNNEL_WIRE_VERSION }));
}

/**
 * Bytes, as a frame — or a thrown {@link TunnelWireError}.
 *
 * Throwing rather than returning a partial frame is the point. A tunnel peer is
 * not this process and is not this build; bytes arriving here have been on a
 * network and may be from anything. Every field is checked before the value
 * escapes this function, so nothing downstream has to ask whether `kind` is
 * really a string.
 */
export function decodeFrame(bytes: Uint8Array): TunnelFrame {
  // Size first, before parsing. A peer that announces 900 MiB should not get
  // this process to allocate it in order to find out the frame was invalid.
  if (bytes.byteLength > MAX_FRAME_BYTES) {
    throw new TunnelWireError(
      `frame is ${String(bytes.byteLength)} bytes, over the ${String(MAX_FRAME_BYTES)} limit`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(TEXT.decode.decode(bytes));
  } catch (cause) {
    throw new TunnelWireError('frame is not UTF-8 JSON', { cause });
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new TunnelWireError('frame is not an object');
  }

  const frame = parsed as Record<string, unknown>;
  if (frame.v !== TUNNEL_WIRE_VERSION) {
    throw new TunnelWireError(
      `frame version ${String(frame.v)} is not ${String(TUNNEL_WIRE_VERSION)}`,
    );
  }

  const kind = frame.kind;
  if (typeof kind !== 'string' || !FRAME_KINDS.includes(kind as FrameKind)) {
    // Naming what arrived, because the common cause is a peer on a build that
    // knows a kind this one does not — and the number alone does not say which.
    throw new TunnelWireError(`unknown frame kind ${JSON.stringify(kind)}`);
  }
  const k = kind as FrameKind;

  /*
   * Per-arm validation, not a cast.
   *
   * The previous version checked `kind` was a non-empty string and returned
   * `body` unexamined, which is fine for an open envelope and wrong for a
   * union: downstream code that switches on `kind` would then be trusting a
   * shape nothing checked. Bytes here have been on a network and are from
   * another build.
   */
  if (isTurnScoped(k)) {
    const turn = frame.turn;
    if (typeof turn !== 'string' || turn === '') {
      throw new TunnelWireError(`${k} frame has no turn id`);
    }
    if (k === 'cancel') return { v: TUNNEL_WIRE_VERSION, kind: k, turn };
    return { v: TUNNEL_WIRE_VERSION, kind: k, turn, body: frame.body };
  }

  if (k === 'hello') {
    const body = frame.body;
    if (typeof body !== 'object' || body === null) {
      throw new TunnelWireError('hello frame has no body');
    }
    const { protocol, build } = body as Record<string, unknown>;
    if (typeof protocol !== 'number' || !Number.isInteger(protocol)) {
      throw new TunnelWireError('hello frame has no protocol number');
    }
    return {
      v: TUNNEL_WIRE_VERSION,
      kind: 'hello',
      body: typeof build === 'string' ? { protocol, build } : { protocol },
    };
  }

  if (k === 'error') {
    const body = frame.body;
    if (typeof body !== 'object' || body === null) {
      throw new TunnelWireError('error frame has no body');
    }
    const { code, message } = body as Record<string, unknown>;
    if (typeof code !== 'string' || typeof message !== 'string') {
      throw new TunnelWireError('error frame has no code and message');
    }
    const turn = frame.turn;
    return typeof turn === 'string' && turn !== ''
      ? { v: TUNNEL_WIRE_VERSION, kind: 'error', turn, body: { code, message } }
      : { v: TUNNEL_WIRE_VERSION, kind: 'error', body: { code, message } };
  }

  if (k === 'pair') {
    // Carried, not interpreted: see `PairFrame`. Required, because a pairing
    // step with nothing in it is not a step.
    if (!('body' in frame)) throw new TunnelWireError('pair frame has no body');
    return { v: TUNNEL_WIRE_VERSION, kind: 'pair', body: frame.body };
  }

  if (k === 'bye') {
    const body = frame.body;
    const reason =
      typeof body === 'object' && body !== null
        ? (body as Record<string, unknown>).reason
        : undefined;
    return typeof reason === 'string'
      ? { v: TUNNEL_WIRE_VERSION, kind: 'bye', body: { reason } }
      : { v: TUNNEL_WIRE_VERSION, kind: 'bye' };
  }

  // ping and pong carry nothing, and must not be given anything on the way out.
  return { v: TUNNEL_WIRE_VERSION, kind: k };
}

/**
 * Is a peer's `hello` one this build can talk to? (#159)
 *
 * Separate from {@link decodeFrame} because they answer different questions: a
 * frame can be perfectly well-formed and still come from a build this one
 * cannot speak to. Both sides call this, and a refusal is an `error` frame with
 * a number in it rather than a dropped connection — a phone and a desktop will
 * be on different app versions constantly, and "it just stopped working" is the
 * outcome this exists to prevent.
 */
export function checkPeerProtocol(protocol: number): { ok: true } | { ok: false; reason: string } {
  if (protocol === TUNNEL_WIRE_VERSION) return { ok: true };
  return {
    ok: false,
    reason:
      protocol > TUNNEL_WIRE_VERSION
        ? `the other device speaks tunnel protocol ${String(protocol)}; this one speaks ${String(TUNNEL_WIRE_VERSION)}. Update this app.`
        : `the other device speaks tunnel protocol ${String(protocol)}; this one speaks ${String(TUNNEL_WIRE_VERSION)}. Update the other device.`,
  };
}
