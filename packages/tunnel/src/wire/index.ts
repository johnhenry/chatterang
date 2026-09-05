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

/** One frame on the tunnel. */
export interface TunnelFrame {
  /** Always {@link TUNNEL_WIRE_VERSION} on send; checked on receive. */
  readonly v: number;
  /**
   * What this frame is.
   *
   * Open on purpose — see the file comment. The set of kinds is defined by the
   * protocol work in #156/#157, not by the envelope.
   */
  readonly kind: string;
  /** The payload, whatever this `kind` says it is. */
  readonly body?: unknown;
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
  let parsed: unknown;
  try {
    parsed = JSON.parse(TEXT.decode.decode(bytes));
  } catch (cause) {
    throw new TunnelWireError('frame is not UTF-8 JSON', { cause });
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new TunnelWireError('frame is not an object');
  }
  const frame = parsed as Partial<TunnelFrame>;
  if (frame.v !== TUNNEL_WIRE_VERSION) {
    throw new TunnelWireError(
      `frame version ${String(frame.v)} is not ${String(TUNNEL_WIRE_VERSION)}`,
    );
  }
  if (typeof frame.kind !== 'string' || frame.kind === '') {
    throw new TunnelWireError('frame has no kind');
  }
  return 'body' in frame
    ? { v: frame.v, kind: frame.kind, body: frame.body }
    : { v: frame.v, kind: frame.kind };
}
