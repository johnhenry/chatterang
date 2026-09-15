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
 * THE TRANSPORT IS HANDED IN. #181 chose, on 2026-09-11: **a native socket
 * plugin, on both platforms. One transport, not two.** That plugin cannot be
 * imported here (it is `@capacitor/`), so this file does not open the phone's
 * socket at all. `createTunnelClient` takes a {@link TunnelTransport} (bytes
 * in, bytes out, one close) and runs everything that makes a tunnel a tunnel
 * over it: the protocol gate, the sequence checks, `bye`, and the close codes
 * and HTTP statuses read as faults. The plugin's contract is
 * `packages/contracts/src/tunnel-socket.ts`; an app passes in the adapter from
 * that plugin to this shape (#295). The `WebSocket` global stays the default,
 * which is rung 0 (#156).
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
 * no URL scheme, no handshake. Those belong to the transport underneath, which
 * is the native socket plugin #181 chose on a phone and the `WebSocket` global
 * at rung 0; this is the part that is the same over either, which is why it
 * could be written down before the ruling and why it needs no revision after
 * it.
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

/**
 * Where a transport connects, and what it presents.
 *
 * Built by `createTunnelClient` AFTER it has checked that `url` may carry a
 * credential, which is how that check covers every transport and not only the
 * default. At most one of `credential` and `credentialRef`, and the credential
 * is never inside `url` (#136): a transport presents it in
 * `TUNNEL_CREDENTIAL_HEADER`.
 */
export interface TunnelTransportTarget {
  readonly url: string;
  /** The device credential itself. */
  readonly credential?: string;
  /** The name a transport's own store keeps the credential under. JavaScript never holds the secret. */
  readonly credentialRef?: string;
}

/**
 * THE BYTES UNDER A TUNNEL, AND NOTHING ELSE.
 *
 * No frames, no gate, no faults: those are the client's, and they run the same
 * over every transport. What a transport owes the client:
 *
 * - `onOpen` fires at most once, when frames may be sent.
 * - `onFrame` gets one message's exact bytes. A transport decodes nothing, so
 *   `decodeFrame`'s fatal UTF-8 decoder is the one validator.
 * - `onClose` fires EXACTLY ONCE, whether or not the connection opened: the
 *   close code (1006 when there was no close frame), the reason, and
 *   `httpStatus` only when the server answered the upgrade with a status other
 *   than 101. That status is what tells a refused credential from a host that
 *   is not there.
 * - No event is delivered from inside the factory call. `createTunnelClient`
 *   registers its listeners after the factory returns, in the same turn.
 * - `send` after the connection has closed writes nothing. `close` is
 *   idempotent.
 *
 * A transport that delivers anything after its close — a frame, a second
 * close, an open — has broken this, and the client ignores and counts it (see
 * {@link TunnelClientOptions.onIgnoredAfterClose}) rather than decoding it.
 */
export interface TunnelTransport {
  send(bytes: Uint8Array): void;
  onOpen(listener: () => void): void;
  onFrame(listener: (bytes: Uint8Array) => void): void;
  onClose(listener: (code: number, reason: string, httpStatus?: number) => void): void;
  close(code?: number, reason?: string): void;
}

/** Open a connection to `target`. Called once per client, after the credential check. */
export type TunnelTransportFactory = (target: TunnelTransportTarget) => TunnelTransport;

/** Something a transport delivered after its terminal close, which the client did not read. */
export interface IgnoredAfterClose {
  readonly delivered: 'open' | 'frame' | 'close';
  /** How many deliveries this client has ignored so far, this one included. */
  readonly count: number;
}

export interface TunnelClientOptions {
  /** `ws://127.0.0.1:<port>` for rung 0; `wss:` through the socket plugin. */
  readonly url: string;
  /**
   * The device credential the host minted, presented in
   * `TUNNEL_CREDENTIAL_HEADER` and never in `url` (#136). Omitted, with no
   * `credentialRef` either, the connection presents nothing and a host admits
   * it only while it is showing a pairing code, and only to pair.
   *
   * WHERE THE DEFAULT CAN SEND IT, said plainly: the standard `WebSocket`
   * constructor has no way to set a request header. Node's (undici) takes a
   * non-standard `{ headers }` init — measured: the header arrives — and that
   * is what rung 0 runs on. A webview's `WebSocket` reads the same init as a
   * subprotocol name and throws, so on a phone the default fails loudly rather
   * than connecting without the credential. The phone's transport is #181's
   * socket plugin, passed in as {@link transport}, which sets the header itself.
   *
   * REFUSED OVER PLAINTEXT OFF LOOPBACK, BY EVERY TRANSPORT: with a credential
   * or a `credentialRef`, `url` must be `wss:`, or `ws:` to exactly
   * `127.0.0.1`. A bearer credential over plaintext on a LAN is a bearer
   * credential on the wire, which is the argument `apps/server/src/binding.ts`
   * makes for its own token. The check runs before the transport is made.
   */
  readonly credential?: string;
  /**
   * The name a transport's own store keeps the credential under, for a
   * transport that reads the secret itself so that JavaScript never holds it
   * (the socket plugin's `credentialRef`). Not with `credential`. The
   * `WebSocket` default has no store and refuses it.
   */
  readonly credentialRef?: string;
  /**
   * The transport to run the tunnel over. Omitted, the `WebSocket` global
   * ({@link webSocketTransport}), which is rung 0. The app passes the socket
   * plugin's adapter here; this file never imports a plugin.
   */
  readonly transport?: TunnelTransportFactory;
  /**
   * Told about each thing the transport delivers after its terminal close.
   * None of it is read, decoded or answered. A transport that does this has a
   * bug worth seeing, and a count is how it is seen without trusting it.
   */
  readonly onIgnoredAfterClose?: (ignored: IgnoredAfterClose) => void;
}

/**
 * Why a tunnel never opened.
 *
 * `UNREACHABLE` is the only one that means "not there". The rest are a host
 * that answered the upgrade with an HTTP status, and they need different
 * screens:
 *
 * - `CREDENTIAL_REFUSED` (401, a credential presented): revoked, or never
 *   issued there. Pair again.
 * - `PAIRING_NOT_OPEN` (401, nothing presented): the host is not showing a
 *   pairing code. There was no credential to refuse, so "pair again" would be
 *   the wrong thing to say.
 * - `HOST_COULD_NOT_CHECK` (503): the host's gate could not read its store.
 *   Nothing was revoked; try again. The host sends 503 rather than 401 for
 *   exactly this reason (`packages/tunnel/src/host/index.ts`).
 * - `UPGRADE_REFUSED`: any other status, carried in `httpStatus`.
 *
 * The `WebSocket` default can only ever say `UNREACHABLE`: a WHATWG socket
 * reports a refused upgrade as `error` then `close` 1006, with no status
 * (measured on Node 24). The status comes from a transport that can see it.
 */
export type TunnelConnectFault =
  | 'UNREACHABLE'
  | 'CREDENTIAL_REFUSED'
  | 'PAIRING_NOT_OPEN'
  | 'HOST_COULD_NOT_CHECK'
  | 'UPGRADE_REFUSED';

export class TunnelConnectError extends Error {
  override readonly name = 'TunnelConnectError';
  readonly code: TunnelConnectFault;
  /** The upgrade's HTTP status, when the host answered with one. */
  readonly httpStatus: number | undefined;

  constructor(code: TunnelConnectFault, message: string, httpStatus: number | undefined) {
    super(message);
    this.code = code;
    this.httpStatus = httpStatus;
  }
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

const UNSAFE_CREDENTIAL =
  'tunnel client: a device credential goes only over wss://, or ws:// to 127.0.0.1. ' +
  'Over plaintext on a network it is readable by anyone on the path.';

/** The target, or a refusal. Runs before any transport is made. */
function targetOf(options: TunnelClientOptions): TunnelTransportTarget {
  if (options.credential !== undefined && options.credentialRef !== undefined) {
    throw new Error('tunnel client: give a credential or a credentialRef, not both');
  }
  const presented =
    options.credential !== undefined
      ? { credential: options.credential }
      : options.credentialRef !== undefined
        ? { credentialRef: options.credentialRef }
        : null;
  if (presented !== null && !carriesCredentialSafely(options.url)) throw new Error(UNSAFE_CREDENTIAL);
  return { url: options.url, ...presented };
}

/** Why a connection closed before it opened, as a fault a screen can explain. */
function refusalOfUpgrade(target: TunnelTransportTarget, httpStatus: number | undefined): TunnelConnectError {
  const { url } = target;
  if (httpStatus === undefined) {
    return new TunnelConnectError('UNREACHABLE', `tunnel client: cannot reach ${url}`, undefined);
  }
  if (httpStatus === 401) {
    return target.credential !== undefined || target.credentialRef !== undefined
      ? new TunnelConnectError(
          'CREDENTIAL_REFUSED',
          `tunnel client: ${url} refused this device's credential. It was revoked or never issued there; pair again.`,
          401,
        )
      : new TunnelConnectError(
          'PAIRING_NOT_OPEN',
          `tunnel client: ${url} is not showing a pairing code, and this connection presented no credential`,
          401,
        );
  }
  if (httpStatus === 503) {
    return new TunnelConnectError(
      'HOST_COULD_NOT_CHECK',
      `tunnel client: ${url} could not check whether to let this connection in. Nothing was revoked; try again.`,
      503,
    );
  }
  return new TunnelConnectError(
    'UPGRADE_REFUSED',
    `tunnel client: ${url} answered the upgrade with HTTP ${String(httpStatus)}`,
    httpStatus,
  );
}

/** How an open tunnel ended, by the transport's close code, when no `bye` came first. */
function closeOf(code: number): TunnelClose {
  /*
   * A REFUSAL IS NOT A CUT. A listener already holding as many tunnels as
   * its app allows closes a new connection with `TUNNEL_CAP_CLOSE_CODE`
   * before sending anything (#169). Read as PEER_GONE, a full desktop looks
   * exactly like a cable pulled mid-stream, which is neither true nor
   * something a screen can explain.
   */
  if (code === TUNNEL_CAP_CLOSE_CODE) {
    return {
      kind: 'abnormal',
      code: 'TUNNEL_FULL',
      message: 'the other device is already holding as many connections as it allows',
    };
  }
  /*
   * The same argument for the pairing refusal (#136): a connection that was
   * let in only to pair, and tried something else or outlived the code on
   * screen. Not a cut, and not something to retry without pairing.
   */
  if (code === TUNNEL_PAIRING_ONLY_CLOSE_CODE) {
    return {
      kind: 'abnormal',
      code: 'PAIRING_ONLY',
      message: 'the other device accepted this connection only to pair',
    };
  }
  // And the window, which is a different fault: the code this connection was
  // let in under is no longer shown. Pairing again needs a new code.
  if (code === TUNNEL_PAIRING_CLOSED_CLOSE_CODE) {
    return {
      kind: 'abnormal',
      code: 'PAIRING_WINDOW_CLOSED',
      message: 'the pairing code this connection was let in under is no longer shown',
    };
  }
  /*
   * See the host's identical branch. `bye` is obliged on a deliberate close
   * (#260), so a socket that goes away without one is reported as abnormal
   * rather than as the end of a stream — which is the distinction #185 says
   * does not currently exist and which #156's faults 3 and 4 assert.
   */
  return { kind: 'abnormal', code: 'PEER_GONE', message: 'the peer went away without a bye' };
}

/**
 * The socket, with the credential in a header when there is one.
 *
 * The cast is the non-standard init described on
 * {@link TunnelClientOptions.credential}, and it is confined to this function.
 * The credential check is repeated here for a caller that uses
 * {@link webSocketTransport} directly.
 */
function openSocket(target: TunnelTransportTarget): WebSocket {
  if (target.credential === undefined) return new WebSocket(target.url);
  if (!carriesCredentialSafely(target.url)) throw new Error(UNSAFE_CREDENTIAL);
  const WithHeaders = WebSocket as unknown as new (
    url: string,
    init: { readonly headers: Readonly<Record<string, string>> },
  ) => WebSocket;
  return new WithHeaders(target.url, { headers: { [TUNNEL_CREDENTIAL_HEADER]: target.credential } });
}

/**
 * The default transport: the global `WebSocket`, which is rung 0.
 *
 * USES THE GLOBAL, which is not laziness — it is the whole reason this half can
 * exist without a plugin. Node 24 ships a WebSocket CLIENT (undici) and every
 * target this half runs in has one: the iOS and Android webviews, the desktop
 * renderer, and Node. #157's ruling is about the SERVER, which Node does not
 * ship and which lives in the other half behind a ban.
 *
 * ONLY `close` IS A TERMINAL, never `error`. A WHATWG socket that fails fires
 * `error` and then `close` — measured on Node 24 for a refused upgrade and for
 * a port nobody listens on, both `close` 1006 — so reporting `error` as well
 * would be the second terminal {@link TunnelTransport} forbids.
 */
export const webSocketTransport: TunnelTransportFactory = (target) => {
  if (target.credentialRef !== undefined) {
    throw new Error(
      'tunnel client: the WebSocket transport has no credential store, so it cannot present a credentialRef',
    );
  }
  const socket = openSocket(target);
  socket.binaryType = 'arraybuffer';
  return {
    send: (bytes) => socket.send(bytes),
    onOpen: (listener) => socket.addEventListener('open', () => listener(), { once: true }),
    onFrame: (listener) =>
      socket.addEventListener('message', (event: MessageEvent) => {
        const data = event.data as ArrayBuffer | string;
        listener(typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data));
      }),
    onClose: (listener) =>
      socket.addEventListener('close', (event: CloseEvent) => listener(event.code, event.reason), { once: true }),
    close: (code, reason) => (code === undefined ? socket.close() : socket.close(code, reason)),
  };
};

/**
 * Connect to a tunnel host, over the transport given or the `WebSocket` global.
 *
 * Rejects with a {@link TunnelConnectError} when the connection closes before
 * it opens, and with a plain `Error` when the options are refused before any
 * transport is made (a credential somewhere unsafe, or both credential forms).
 *
 * So the asymmetry in this package — a dependency on one side and a global
 * (or an injected transport) on the other — is the asymmetry in the platform,
 * not a preference.
 */
export async function createTunnelClient(options: TunnelClientOptions): Promise<TunnelClient> {
  const target = targetOf(options);
  const transport = (options.transport ?? webSocketTransport)(target);

  const inbox: TunnelFrame[] = [];
  let wake: (() => void) | null = null;
  let ended: TunnelClose | null = null;
  /**
   * Where the transport is. `closing` is this end having asked it to close;
   * `closed` is the transport's one `onClose` having arrived, after which
   * nothing it delivers is read.
   */
  let state: 'connecting' | 'open' | 'closing' | 'closed' = 'connecting';
  let opened = false;
  let ignored = 0;

  let settle!: () => void;
  const closed = new Promise<void>((resolve) => {
    settle = resolve;
  });
  let admit!: () => void;
  let refuse!: (error: TunnelConnectError) => void;
  const opening = new Promise<void>((resolve, reject) => {
    admit = resolve;
    refuse = reject;
  });
  // This tunnel's turn state and sequence counts. See the host's.
  const gate = createProtocolGate();

  /** First caller wins. See the host's, which carries the argument. */
  const finish = (close: TunnelClose): void => {
    ended ??= close;
    wake?.();
    settle();
  };

  /** This end closes the transport, once. */
  const shut = (): void => {
    if (state === 'closing' || state === 'closed') return;
    state = 'closing';
    transport.close();
  };

  const ignore = (delivered: IgnoredAfterClose['delivered']): void => {
    ignored += 1;
    options.onIgnoredAfterClose?.({ delivered, count: ignored });
  };

  transport.onOpen(() => {
    if (state === 'closed') {
      ignore('open');
      return;
    }
    if (opened) return;
    opened = true;
    if (state === 'connecting') state = 'open';
    admit();
  });

  transport.onFrame((bytes) => {
    /*
     * AFTER THE TERMINAL CLOSE, NOTHING IS READ. A transport that delivers a
     * frame after saying the connection is over has broken its contract, and a
     * frame decoded then could reach an app after `ended()` was settled, or
     * move a turn the app has already been told is over. Counted, not decoded.
     */
    if (state === 'closed') {
      ignore('frame');
      return;
    }
    let frame: TunnelFrame;
    try {
      frame = decodeFrame(bytes);
    } catch (error) {
      finish({
        kind: 'abnormal',
        code: 'FRAME_INVALID',
        message: error instanceof Error ? error.message : 'frame refused',
      });
      shut();
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
      if (state === 'open') transport.send(gate.send(verdict.reply));
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
      shut();
      return;
    }
    inbox.push(frame);
    wake?.();
  });

  transport.onClose((code, _reason, httpStatus) => {
    // Exactly one terminal; a second is the transport's bug, not a new ending.
    if (state === 'closed') {
      ignore('close');
      return;
    }
    state = 'closed';
    /*
     * CLOSED BEFORE IT OPENED: the host answered the upgrade with a status, or
     * nothing answered at all. A 401 read as "cannot reach" sends a person
     * looking for a network fault when their phone has been revoked, and a 503
     * read as 401 tells a paired phone it was revoked when it was not.
     */
    if (!opened) {
      const refusal = refusalOfUpgrade(target, httpStatus);
      finish({ kind: 'abnormal', code: refusal.code, message: refusal.message });
      refuse(refusal);
      return;
    }
    // Open, a status means nothing: the upgrade already succeeded. The close
    // code decides, and the latch holds any earlier answer (`bye`, a fault).
    finish(closeOf(code));
  });

  await opening;

  return {
    async send(frame) {
      // The obligations are symmetric: a client streams a reply back when the
      // desktop asks the phone for a turn, and a client that sends an answer
      // to a prompt nobody raised has a bug the gate throws on. See
      // `createProtocolGate`. Once the transport is closing or closed the
      // bytes are dropped, as a WHATWG socket drops them.
      const bytes = gate.send(frame);
      if (state === 'open') transport.send(bytes);
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
      if (state === 'open') {
        transport.send(
          encodeFrame({ v: TUNNEL_WIRE_VERSION, kind: 'bye', ...(reason ? { body: { reason } } : {}) }),
        );
      }
      // Before closing the transport, for the reason the host's does. See there.
      finish({ kind: 'clean', reason });
      shut();
    },
  };
}
