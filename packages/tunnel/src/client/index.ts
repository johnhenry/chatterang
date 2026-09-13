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
 * NOT IMPLEMENTED HERE, AND NO LONGER FOR THE REASON THIS COMMENT USED TO
 * GIVE. It said the transport waits on #181 choosing between plaintext LAN
 * plus an application-layer handshake and a native socket plugin. #181 chose,
 * on 2026-09-11: **a native socket plugin, on both platforms. One transport,
 * not two.**
 *
 * Plaintext `ws://` lost on one measured fact, recorded here because a
 * rejected option that is not written down is one somebody re-proposes:
 * `network_security_config.xml` is static, baked at build time, and the
 * desktop's LAN IP is not knowable when the APK is built. Without a
 * build-time-stable hostname the narrow exception degrades to a global
 * `cleartextTrafficPermitted="true"`, and the hostname that would have
 * rescued it — an mDNS name resolving inside a WebView — has never been
 * measured. Two transports was rejected on its own warning: two threat
 * models, two negative tests, and two failure classifications for #186.
 *
 * So what is missing here is WORK, not a decision. The client is #156; the
 * listener is #157 and #158. What this package delivers today is still the
 * BOUNDARY: a shape the transport is poured into, with a guard that fails the
 * day someone pours it into the wrong half.
 */

import { assertSendable, createSequenceGuard, faultMessage } from '../stream/index.js';
import { TUNNEL_WIRE_VERSION, decodeFrame, encodeFrame, type TunnelFrame } from '../wire/index.js';

/**
 * The client end of a tunnel.
 *
 * Deliberately expressed in {@link TunnelFrame}s and nothing else — no socket,
 * no URL scheme, no handshake. Those belong to the native socket plugin #181
 * chose and #156 builds; this is the part that was the same under either
 * option, which is why it could be written down before the ruling and why it
 * needs no revision after it.
 */
export interface TunnelClient {
  /** Hand one frame to the peer. */
  send(frame: TunnelFrame): Promise<void>;
  /** Frames from the peer, in arrival order, until the tunnel closes. */
  receive(): AsyncIterable<TunnelFrame>;
  /** Close this end. Says `bye` first, per #260. Idempotent. */
  close(reason?: string): Promise<void>;
  /** How the tunnel ended, or null while it is open. */
  ended(): TunnelClose | null;
  /** Resolves once the tunnel has ended. See the host's, which this mirrors. */
  readonly closed: Promise<void>;
}

/**
 * Fresh random bytes, from the WEB crypto API.
 *
 * This function is small and it is the point. Pairing needs a client-side
 * random challenge under the transport #181 chose — as it would have under the
 * one it rejected — and the Node answer to that is
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

/** How a tunnel ended. Mirrors the host's, deliberately — one vocabulary. */
export type TunnelClose =
  | { readonly kind: 'clean'; readonly reason?: string }
  | { readonly kind: 'abnormal'; readonly code: string; readonly message: string };

export interface TunnelClientOptions {
  /** `ws://127.0.0.1:<port>` for rung 0. */
  readonly url: string;
}

/**
 * Connect to a tunnel host.
 *
 * USES THE GLOBAL `WebSocket`, which is not laziness — it is the whole reason
 * this half can exist. Node 24 ships a WebSocket CLIENT (undici) and every
 * target this half runs in has one: the iOS and Android webviews, the desktop
 * renderer, and Node. #157's ruling is about the SERVER, which Node does not
 * ship and which lives in the other half behind a ban.
 *
 * So the asymmetry in this package — a dependency on one side and a global on
 * the other — is the asymmetry in the platform, not a preference.
 */
export async function createTunnelClient(options: TunnelClientOptions): Promise<TunnelClient> {
  const socket = new WebSocket(options.url);
  socket.binaryType = 'arraybuffer';

  const inbox: TunnelFrame[] = [];
  let wake: (() => void) | null = null;
  let ended: TunnelClose | null = null;

  let settle!: () => void;
  const closed = new Promise<void>((resolve) => {
    settle = resolve;
  });
  const guard = createSequenceGuard();

  /** First caller wins. See the host's, which carries the argument. */
  const finish = (close: TunnelClose): void => {
    ended ??= close;
    wake?.();
    settle();
  };

  socket.addEventListener('message', (event: MessageEvent) => {
    const data = event.data as ArrayBuffer | string;
    let frame: TunnelFrame;
    try {
      frame = decodeFrame(
        typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data),
      );
    } catch (error) {
      finish({
        kind: 'abnormal',
        code: 'FRAME_INVALID',
        message: error instanceof Error ? error.message : 'frame refused',
      });
      socket.close();
      return;
    }
    if (frame.kind === 'bye') {
      finish({ kind: 'clean', reason: frame.body?.reason });
      return;
    }
    /*
     * CONTIGUITY, ENFORCED (#260). The IR calls `sequence` "the only
     * loss-detection primitive the IR has" once a stream crosses a wire and
     * says a consumer that sees a gap "should fail the turn rather than render
     * it". Failing here rather than at the end is the point: the frames after
     * a gap are not the stream that was sent, so rendering them and warning
     * afterwards shows the user something and then takes it back.
     */
    const fault = guard.check(frame);
    if (fault) {
      finish({ kind: 'abnormal', code: 'SEQUENCE_BROKEN', message: faultMessage(fault) });
      socket.close();
      return;
    }
    inbox.push(frame);
    wake?.();
  });

  socket.addEventListener('close', () => {
    /*
     * See the host's identical branch. `bye` is obliged on a deliberate close
     * (#260), so a socket that goes away without one is reported as abnormal
     * rather than as the end of a stream — which is the distinction #185 says
     * does not currently exist and which #156's faults 3 and 4 assert.
     */
    // Unconditional; the latch holds every other answer. See the host's.
    finish({ kind: 'abnormal', code: 'PEER_GONE', message: 'the peer went away without a bye' });
  });

  await new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => resolve(), { once: true });
    socket.addEventListener('error', () => reject(new Error(`tunnel client: cannot reach ${options.url}`)), { once: true });
  });

  return {
    async send(frame) {
      // The obligation is symmetric: a client streams a reply back when the
      // desktop asks the phone for a turn. See `assertSendable`.
      assertSendable(frame);
      socket.send(encodeFrame(frame));
    },
    async *receive() {
      for (;;) {
        while (inbox.length > 0) yield inbox.shift()!;
        if (ended) return;
        await new Promise<void>((resolve) => {
          wake = () => {
            wake = null;
            resolve();
          };
        });
      }
    },
    ended: () => ended,
    closed,
    async close(reason?: string) {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(
          encodeFrame({ v: TUNNEL_WIRE_VERSION, kind: 'bye', ...(reason ? { body: { reason } } : {}) }),
        );
      }
      // Before `socket.close()`, for the reason the host's does. See there.
      finish({ kind: 'clean', reason });
      socket.close();
    },
  };
}
