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

import { createProtocolGate, faultMessage } from '../stream/index.js';
import {
  TUNNEL_CAP_CLOSE_CODE,
  TUNNEL_CREDENTIAL_HEADER,
  TUNNEL_PAIRING_CLOSED_CLOSE_CODE,
  TUNNEL_PAIRING_ONLY_CLOSE_CODE,
  TUNNEL_WIRE_VERSION,
  decodeFrame,
  encodeFrame,
  refusalOf,
  type PromptId,
  type RefusalKind,
  type RelayedPrompt,
  type TunnelFrame,
  type TurnId,
} from '../wire/index.js';

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

/**
 * What one frame means to the end that asked for a turn — which is what an app
 * renders from (#7).
 *
 * `completed`, `failed` and `refused` are three different outcomes and are kept
 * three: a reply that finished, a reply the far side's model or backend ended
 * with an error chunk, and a turn the far side would not take or could not
 * finish. A refusal says which kind (busy, quitting, suspended, refused, …) and
 * whether the turn it names is over.
 */
export type TurnUpdate =
  /** Nothing to render: a control frame, or one only an asker sends. */
  | { readonly kind: 'other' }
  /** Admitted, and waiting for the one slot. `position` 1 is next. */
  | { readonly kind: 'waiting'; readonly turn: TurnId; readonly position: number }
  /** A tool needs an answer before its call may go (#170). */
  | {
      readonly kind: 'prompt';
      readonly turn: TurnId;
      readonly prompt: PromptId;
      readonly body: RelayedPrompt;
    }
  /** Part of the reply. */
  | { readonly kind: 'streaming'; readonly turn: TurnId }
  /** The reply's `done` chunk. */
  | { readonly kind: 'completed'; readonly turn: TurnId }
  /** An `error` chunk: the far side's model or backend failed the turn. */
  | { readonly kind: 'failed'; readonly turn: TurnId }
  /**
   * An `error` frame. A refusal names no turn when it refuses the connection,
   * and then, if it ends turns, it ends every turn its sender was running.
   */
  | {
      readonly kind: 'refused';
      readonly refusal: RefusalKind;
      readonly endsTurn: boolean;
      readonly code: string;
      readonly message: string;
      readonly turn?: TurnId;
      readonly prompt?: PromptId;
    };

/**
 * Classify one frame for the end that asked for its turn.
 *
 * AN UNKNOWN CODE IS A FAILURE. A refusal this build has no row for is
 * `unrecognised` and ends the turn it names (`UNRECOGNISED_REFUSAL`): read as
 * anything gentler, a newer desktop's refusal would leave the phone showing a
 * turn as running, or finished, that the desktop has already given up on. A
 * chunk is `completed` only for a `done` type, never for a type this build
 * does not know.
 *
 * THIS DOES NOT CHECK STATE; `createProtocolGate` does, and `createTunnelClient`
 * runs it on every frame before an app can read one. A frame outside its turn's
 * state never reaches an app, and neither does a refusal of a turn that already
 * had its terminal, so what an app classifies is one terminal per turn it asked
 * for: `completed`, `failed`, or a refusal that ends it. A frame handed to this
 * function from anywhere else has had none of those checks.
 */
export function classifyFrame(frame: TunnelFrame): TurnUpdate {
  switch (frame.kind) {
    case 'waiting':
      return { kind: 'waiting', turn: frame.turn, position: frame.body.position };
    case 'prompt':
      return { kind: 'prompt', turn: frame.turn, prompt: frame.prompt, body: frame.body };
    case 'chunk': {
      const type =
        typeof frame.body === 'object' && frame.body !== null
          ? (frame.body as { readonly type?: unknown }).type
          : undefined;
      if (type === 'done') return { kind: 'completed', turn: frame.turn };
      if (type === 'error') return { kind: 'failed', turn: frame.turn };
      return { kind: 'streaming', turn: frame.turn };
    }
    case 'error': {
      const refusal = refusalOf(frame.body.code);
      return {
        kind: 'refused',
        refusal: refusal.kind,
        endsTurn: refusal.endsTurn,
        code: frame.body.code,
        message: frame.body.message,
        ...(frame.turn === undefined ? {} : { turn: frame.turn }),
        ...(frame.prompt === undefined ? {} : { prompt: frame.prompt }),
      };
    }
    case 'turn':
    case 'cancel':
    case 'answer':
    case 'attach':
    case 'ack':
    case 'hello':
    case 'ping':
    case 'pong':
    case 'bye':
    case 'pair':
      return { kind: 'other' };
  }
}

/** How a tunnel ended. Mirrors the host's, deliberately — one vocabulary. */
export type TunnelClose =
  | { readonly kind: 'clean'; readonly reason?: string }
  | { readonly kind: 'abnormal'; readonly code: string; readonly message: string };

export interface TunnelClientOptions {
  /** `ws://127.0.0.1:<port>` for rung 0. */
  readonly url: string;
  /**
   * The device credential the host minted, sent in `TUNNEL_CREDENTIAL_HEADER`
   * and never in `url` (#136). Omitted, the connection presents nothing and a
   * host admits it only while it is showing a pairing code, and only to pair.
   *
   * WHERE THIS WORKS, said plainly: the standard `WebSocket` constructor has
   * no way to set a request header. Node's (undici) takes a non-standard
   * `{ headers }` init — measured: the header arrives — and that is what rung
   * 0 runs on. A webview's `WebSocket` reads the same init as a subprotocol
   * name and throws, so on a phone this fails loudly rather than connecting
   * without the credential. The phone's real transport is #181's native socket
   * plugin, which sets the header itself.
   *
   * REFUSED OVER PLAINTEXT OFF LOOPBACK: with a credential, `url` must be
   * `wss:`, or `ws:` to exactly `127.0.0.1`. A bearer credential over plaintext
   * on a LAN is a bearer credential on the wire, which is the argument
   * `apps/server/src/binding.ts` makes for its own token.
   */
  readonly credential?: string;
}

/** Can this URL carry a credential? `wss:` anywhere, or plaintext loopback. */
function carriesCredentialSafely(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return parsed.protocol === 'wss:' || (parsed.protocol === 'ws:' && parsed.hostname === '127.0.0.1');
}

/**
 * The socket, with the credential in a header when there is one.
 *
 * The cast is the non-standard init described on
 * {@link TunnelClientOptions.credential}, and it is confined to this function.
 */
function openSocket(options: TunnelClientOptions): WebSocket {
  if (options.credential === undefined) return new WebSocket(options.url);
  if (!carriesCredentialSafely(options.url)) {
    throw new Error(
      'tunnel client: a device credential goes only over wss://, or ws:// to 127.0.0.1. ' +
        'Over plaintext on a network it is readable by anyone on the path.',
    );
  }
  const WithHeaders = WebSocket as unknown as new (
    url: string,
    init: { readonly headers: Readonly<Record<string, string>> },
  ) => WebSocket;
  return new WithHeaders(options.url, { headers: { [TUNNEL_CREDENTIAL_HEADER]: options.credential } });
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
  const socket = openSocket(options);
  socket.binaryType = 'arraybuffer';

  const inbox: TunnelFrame[] = [];
  let wake: (() => void) | null = null;
  let ended: TunnelClose | null = null;

  let settle!: () => void;
  const closed = new Promise<void>((resolve) => {
    settle = resolve;
  });
  // This tunnel's turn state and sequence counts. See the host's.
  const gate = createProtocolGate();

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
     * THE SAME STATE CHECK AS THE HOST'S (#7), because a phone must not render
     * a prompt for a turn it never asked for, or a `waiting` for a reply that
     * is already streaming. Dropped unread and answered `FRAME_UNEXPECTED`.
     */
    const verdict = gate.receive(frame);
    if (verdict.verdict === 'refuse') {
      if (socket.readyState === WebSocket.OPEN) socket.send(gate.send(verdict.reply));
      return;
    }
    /*
     * A SECOND TERMINAL NEVER REACHES THE APP. A refusal of a turn that already
     * ended here — the desktop's named repeat of a refusal of every turn, or a
     * desktop settling one turn twice — is dropped and not answered, so a phone
     * never renders "completed" and then "quitting" for one reply.
     */
    if (verdict.verdict === 'stale') return;
    /*
     * CONTIGUITY, ENFORCED (#260). The IR calls `sequence` "the only
     * loss-detection primitive the IR has" once a stream crosses a wire and
     * says a consumer that sees a gap "should fail the turn rather than render
     * it". Failing here rather than at the end is the point: the frames after
     * a gap are not the stream that was sent, so rendering them and warning
     * afterwards shows the user something and then takes it back.
     */
    if (verdict.verdict === 'fault') {
      finish({ kind: 'abnormal', code: 'SEQUENCE_BROKEN', message: faultMessage(verdict.fault) });
      socket.close();
      return;
    }
    inbox.push(frame);
    wake?.();
  });

  socket.addEventListener('close', (event: CloseEvent) => {
    /*
     * A REFUSAL IS NOT A CUT. A listener already holding as many tunnels as
     * its app allows closes a new connection with `TUNNEL_CAP_CLOSE_CODE`
     * before sending anything (#169). Read as PEER_GONE, a full desktop looks
     * exactly like a cable pulled mid-stream, which is neither true nor
     * something a screen can explain.
     */
    if (event.code === TUNNEL_CAP_CLOSE_CODE) {
      finish({
        kind: 'abnormal',
        code: 'TUNNEL_FULL',
        message: 'the other device is already holding as many connections as it allows',
      });
      return;
    }
    /*
     * The same argument for the pairing refusal (#136): a connection that was
     * let in only to pair, and tried something else or outlived the code on
     * screen. Not a cut, and not something to retry without pairing.
     */
    if (event.code === TUNNEL_PAIRING_ONLY_CLOSE_CODE) {
      finish({
        kind: 'abnormal',
        code: 'PAIRING_ONLY',
        message: 'the other device accepted this connection only to pair',
      });
      return;
    }
    // And the window, which is a different fault: the code this connection was
    // let in under is no longer shown. Pairing again needs a new code.
    if (event.code === TUNNEL_PAIRING_CLOSED_CLOSE_CODE) {
      finish({
        kind: 'abnormal',
        code: 'PAIRING_WINDOW_CLOSED',
        message: 'the pairing code this connection was let in under is no longer shown',
      });
      return;
    }
    /*
     * See the host's identical branch. `bye` is obliged on a deliberate close
     * (#260), so a socket that goes away without one is reported as abnormal
     * rather than as the end of a stream — which is the distinction #185 says
     * does not currently exist and which #156's faults 3 and 4 assert.
     */
    // Otherwise unconditional; the latch holds every other answer. See the host's.
    finish({ kind: 'abnormal', code: 'PEER_GONE', message: 'the peer went away without a bye' });
  });

  await new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => resolve(), { once: true });
    socket.addEventListener('error', () => reject(new Error(`tunnel client: cannot reach ${options.url}`)), { once: true });
  });

  return {
    async send(frame) {
      // The obligations are symmetric: a client streams a reply back when the
      // desktop asks the phone for a turn, and a client that sends an answer
      // to a prompt nobody raised has a bug the gate throws on. See
      // `createProtocolGate`.
      socket.send(gate.send(frame));
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
