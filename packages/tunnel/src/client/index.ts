/**
 * THE CLIENT HALF: what the phone runs, and therefore what `src/` may import.
 *
 * The whole reason this package is split at the entry point is this file's
 * import list. `src/` is the web AND mobile bundle; `tests/layering.test.ts`
 * bans every `node:` builtin from it by all four import forms, so a single
 * `@chatterang/tunnel` entry point that re-exported both halves would be a
 * layering violation the moment `src/` imported it — and the failure would not
 * be a build error, it would be a blank page on a phone.
 *
 * So: web globals only here. `WebSocket`, `crypto.subtle`, `TextEncoder`.
 * Nothing from `node:`, nothing from `electron`, nothing from `@capacitor/` —
 * the last because the desktop renderer imports this too, and a contract that
 * needs a mobile framework installed is not shared code. All four are asserted
 * in `tests/layering.test.ts`, against these real files rather than a copy.
 *
 * NOT IMPLEMENTED HERE, ON PURPOSE. There is no transport in this file and
 * there will not be one until #181 chooses between plaintext LAN plus an
 * application-layer handshake and a native socket plugin. That is the product
 * owner's call, and #156/#157 build on top of it. What this package delivers
 * today is the BOUNDARY: a shape the transport can be poured into, with a guard
 * that fails the day someone pours it into the wrong half.
 */

import type { TunnelFrame } from '../wire/index.js';

/**
 * The client end of a tunnel.
 *
 * Deliberately expressed in {@link TunnelFrame}s and nothing else — no socket,
 * no URL scheme, no handshake. Those are the parts #181 decides; this is the
 * part that is the same either way, which is why it can be written down now.
 */
export interface TunnelClient {
  /** Hand one frame to the peer. */
  send(frame: TunnelFrame): Promise<void>;
  /** Frames from the peer, in arrival order, until the tunnel closes. */
  receive(): AsyncIterable<TunnelFrame>;
  /** Close this end. Idempotent. */
  close(): Promise<void>;
}

/**
 * Fresh random bytes, from the WEB crypto API.
 *
 * This function is small and it is the point. Pairing needs a client-side
 * random challenge under either option in #181, and the Node answer to that is
 * `node:crypto`'s `randomBytes` while the web answer is
 * `crypto.getRandomValues`. Having the web one HERE is what gives the "no
 * `node:` in the client half" guard something real to catch: the day someone
 * reaches for the Node spelling because it is what they typed last, the test
 * fails on this file rather than the phone failing on a user's desk.
 *
 * `crypto.getRandomValues` is available in every context this half runs in —
 * the iOS and Android webviews, the desktop renderer, and Node 20+ — so the
 * portable spelling costs nothing.
 */
export function randomChallenge(byteLength = 32): Uint8Array {
  if (!Number.isInteger(byteLength) || byteLength <= 0) {
    throw new RangeError(`challenge length must be a positive integer, got ${byteLength}`);
  }
  return crypto.getRandomValues(new Uint8Array(byteLength));
}

/**
 * The seam the transport will be built behind.
 *
 * It throws, and that is the honest state of this milestone: the package
 * exists, the boundary is guarded, and the thing that goes inside is blocked on
 * a decision nobody has made yet. A stub that returned a fake client would read
 * as working code and would be worse than a throw with a ticket number in it.
 */
export function createTunnelClient(): never {
  throw new Error(
    'tunnel client is not implemented: the transport option is undecided (#181); ' +
      'the client is #156',
  );
}
