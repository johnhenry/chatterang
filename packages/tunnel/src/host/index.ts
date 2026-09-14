/**
 * THE HOST HALF: the listener, which `src/` may never import.
 *
 * A listener binds a socket. `node:http` is right there in the import list
 * below, and that import is not an accident of implementation — it is the
 * definition of this half. That is exactly why `@chatterang/tunnel/host` is in
 * `DESKTOP_LAYER_BAN` in `tests/layering.test.ts` alongside
 * `@chatterang/inference-node` and `@chatterang/onnx-node`: a mobile bundle
 * that reaches this file is a mobile bundle that has asked for a module iOS
 * does not have.
 *
 * THE BAN COVERS FOUR DOORS, not one, because a package name is only the
 * obvious route: the bare specifier `@chatterang/tunnel`, the subpath
 * `@chatterang/tunnel/host/...`, and a relative path into this directory
 * (`../../packages/tunnel/src/host/...`) all reach the same code. The bare
 * specifier is banned as well as the subpath, and `package.json` here declares
 * NO `.` export at all, so there is nothing for a bare import to resolve to —
 * belt and braces, both asserted.
 *
 * WHAT IS HERE, AND WHAT IS NOT. Node ships a WebSocket client and no WebSocket
 * server (#157), which is why this half carries `ws`. Whether the listener sits
 * behind plaintext LAN plus an application-layer handshake or behind a native
 * socket plugin was #181's call, and #181 made it on 2026-09-11: **a native
 * socket plugin, on both platforms. One transport, not two.**
 *
 * What this file builds is the listener (#158) behind its gate (#135, #136): a
 * {@link TunnelBinding} that cannot be written without a credential gate on
 * either arm, a per-device credential checked at the HTTP upgrade before `ws`
 * writes a byte, and a pairing-only admission that exists only while a pairing
 * window is open. Rung 0 (#156) runs on top of it, on loopback. NO APP STARTS
 * IT. What still has to exist before one may is AT LEAST this, and #158 holds
 * the whole gate: somewhere the paired-device registry persists (#133 — the
 * store here is an interface, and its one implementation forgets on exit),
 * certificate material the app actually makes (#179 — the TLS arm accepts it,
 * nothing here creates it), a declared surface (#170), and the inbound privacy
 * copy on every surface that makes the outbound promise, landing in the same
 * change as the start path (#221, #158). A listener that carries turns also
 * waits on #7's background substrate, per #169's ruling.
 */

import { createServer } from 'node:http';
import type { IncomingMessage, Server } from 'node:http';
import { createServer as createTlsServer } from 'node:https';
import type { Duplex } from 'node:stream';

import type { PairingWindow, PairingWindows } from '../pairing/index.js';
import { assertSendable, createSequenceGuard, faultMessage } from '../stream/index.js';
import {
  TUNNEL_CAP_CLOSE_CODE,
  TUNNEL_CREDENTIAL_HEADER,
  TUNNEL_PAIRING_ONLY_CLOSE_CODE,
  TUNNEL_WIRE_VERSION,
  decodeFrame,
  encodeFrame,
  type TunnelFrame,
} from '../wire/index.js';
import type { DeviceCredentials } from './credential.js';
import { LOOPBACK_HOST } from './tls.js';
import type { TlsMaterial } from './tls.js';

export { LOOPBACK_HOST, asTlsMaterial } from './tls.js';
export type { TlsMaterial } from './tls.js';
export { createDeviceCredentials, createMemoryCredentialStore } from './credential.js';
export type { CredentialStore, DeviceCredentials, MintedCredential } from './credential.js';

/**
 * Why a tunnel was let in, which decides what it may carry (#135, #136).
 *
 *   - `device`: it presented a credential the desktop minted, and it IS that
 *     device from here on. Revoking the device closes it.
 *   - `pairing`: it presented nothing, while a pairing code was on screen. It
 *     may carry the pairing exchange — `hello`, `pair` and `bye` — and nothing
 *     else, and only while `window` is still live or has been claimed. It is
 *     never promoted: a phone that finishes pairing reconnects with the
 *     credential it was given.
 */
export type TunnelAdmission =
  | { readonly kind: 'device'; readonly deviceId: string }
  | {
      readonly kind: 'pairing';
      /** The window this tunnel was admitted under, so the caller claims THAT one. */
      readonly window: PairingWindow;
    };

/*
 * THE TUNNEL'S TLS IDENTITY (#179, #180): the key a paired client pins, the
 * certificates made from it, and the owner-only store both apps keep it in.
 * None of it binds anything — see `identity.ts` and `identity-store.ts` — and
 * it is exported here because this is the one entry both apps import and the
 * one entry `src/` may not.
 */
export {
  TunnelIdentityError,
  generateTunnelKey,
  issueTunnelCertificate,
  sameTunnelPin,
  tunnelKeyFromPkcs8Pem,
  tunnelKeyPkcs8Pem,
  tunnelPinOf,
} from './identity.js';
export type {
  TunnelCertificate,
  TunnelCertificateOptions,
  TunnelIdentityErrorReason,
  TunnelKey,
  TunnelPin,
  TunnelSubjectAltName,
} from './identity.js';
export { loadOrCreateTunnelKey } from './identity-store.js';
export type {
  AccessControlListing,
  KeyFileHandle,
  KeyFileStat,
  KeyFileSystem,
  KeyProtection,
  KeySealer,
  StoredTunnelKey,
  TunnelKeyStoreOptions,
} from './identity-store.js';

/**
 * One tunnel: one peer's connection, and everything that belongs to it alone.
 *
 * ITS OWN inbox, sequence guard, `ended` latch and socket. The host used to
 * keep one set of those for every connection it accepted (#158): each peer's
 * frames went into ONE inbox through ONE sequence guard, and `peer` was
 * overwritten by every new socket. With two peers, sends went to the latest,
 * the two streams interleaved into one, and after the first peer left a late
 * socket opened onto a tunnel that had already ended. A listener now hands out
 * one of these per connection instead.
 */
export interface Tunnel {
  /** Why this tunnel was admitted. See {@link TunnelAdmission}. */
  readonly admission: TunnelAdmission;
  /**
   * Send one frame to this tunnel's peer.
   *
   * On a PAIRING tunnel a frame outside the exchange, or any frame once the
   * window it was admitted under has expired or been cancelled, is not sent:
   * the tunnel ends as PAIRING_ONLY or PAIRING_WINDOW_CLOSED and this rejects.
   */
  send(frame: TunnelFrame): Promise<void>;
  /** Frames from this peer, in arrival order, until the tunnel closes. */
  receive(): AsyncIterable<TunnelFrame>;
  /**
   * Say `bye` to this peer and drop its connection. Every other tunnel, and
   * the listener, keep running — which is what closing one revoked device's
   * socket needs (#135), and what revocation now calls. Idempotent.
   */
  close(reason?: string): Promise<void>;
  /** How the tunnel ended, or null while it is open. */
  ended(): TunnelClose | null;
  /**
   * Resolves once the tunnel has ended, however it ended.
   *
   * Exists because {@link ended} latches the FIRST classification and a caller
   * has no other way to know the latch has seen everything it is going to see.
   * A cut arrives as two events in quick succession — the decode failure, then
   * the socket going away — and a caller that reads `ended()` between them
   * gets the right answer for the wrong reason. Awaiting this reads it after.
   */
  readonly closed: Promise<void>;
}

/**
 * The host end of a tunnel.
 *
 * Typed against Node's own `Server` deliberately. It would be easy to write
 * this half against a structural `{ close(): void }` and keep `node:http` out of
 * the file — and that would be a boundary that looks kept while the code below
 * it binds a socket anyway. Naming the Node type here makes the half honest
 * about what it is, and makes the guard's ban a rule with something behind it.
 */
export interface TunnelHost extends Omit<Tunnel, 'admission'> {
  /** The bound server. Node-only, which is the whole point of this file. */
  readonly server: Server;
  /** Stop listening and drop the connection. Says `bye` first. Idempotent. */
  close(reason?: string): Promise<void>;
}

/**
 * One bound socket that outlives the tunnels it accepts (#158).
 *
 * #158 asks for a listener that stops on app quit and on an explicit toggle,
 * which needs something long-lived to stop — and a tunnel is over the moment
 * its peer leaves. So the two are separate objects: this one is started and
 * stopped, and the tunnels come and go underneath it.
 */
export interface TunnelListener {
  /**
   * The bound server. Node-only, as above. An `https.Server` on the TLS arm,
   * which Node declares as an `http.Server` too.
   */
  readonly server: Server;
  /**
   * Each admitted connection's tunnel, in the order admitted, until the
   * listener closes. A tunnel is handed out ONCE: two loops over this share
   * one queue rather than each seeing every tunnel.
   */
  tunnels(): AsyncIterable<Tunnel>;
  /**
   * Stop accepting, destroy every upgrade still being decided, say `bye` on
   * every open tunnel and drop it, then close the server. Idempotent.
   */
  close(reason?: string): Promise<void>;
}

/**
 * Who decides whether a connection gets in. REQUIRED ON BOTH ARMS of
 * {@link TunnelBinding}.
 *
 *   - `credentials` verifies a device credential and is told of revocations.
 *     Branded, so it cannot be a literal that says yes.
 *   - `pairing` is where the desktop's pairing window lives. A connection with
 *     no credential is admitted only while `pairing.current()` is `issued`.
 *   - `now` is the clock that window was opened on. MONOTONIC, and the same
 *     scale — `packages/tunnel/src/pairing/window.ts` says why a wall clock
 *     extends a window — and required, so the listener cannot read a window
 *     against a different clock than the one that opened it.
 */
export interface TunnelGate {
  readonly credentials: DeviceCredentials;
  readonly pairing: PairingWindows;
  readonly now: () => number;
}

/**
 * WHERE THE TUNNEL LISTENS, AND WHO GETS IN, AS ONE VALUE (#135, #158).
 *
 * `apps/server/src/binding.ts`'s pattern: the bind address and what guards it
 * are one union, so an ungated listener is not a check someone can forget but a
 * value TypeScript refuses. Its own union and NOT a third arm of
 * `ServerBinding`, per #135's ruling — a third arm would put an arm-dependent
 * branch back into `checkToken`'s gate 1, and the operator token and the cookie
 * helpers stay out of the tunnel. The two share only `LOOPBACK_HOST` and the
 * `TlsMaterial` brand, which moved into `./tls.ts` so both unions hold the same
 * type.
 *
 *   { kind: 'loopback', port, gate }             — no host field AT ALL
 *   { kind: 'tls',      host, port, tls, gate }  — any address, with material
 *
 * THE LOOPBACK ARM IS GATED TOO, and that is the fail-closed reading of the
 * rulings rather than a thing either of them says in so many words. "Only this
 * machine can reach 127.0.0.1" is not true of a listener that Tailscale Serve
 * sits in front of, and #154's re-scope recommends exactly that as the remote
 * path over a loopback arm (#124 records it, still awaiting its own ruling):
 * `tailscale serve` forwards an HTTPS name to a loopback port, so a loopback
 * tunnel listener is reachable from anywhere that name is. Gating the arm costs
 * nothing if the ruling goes the other way, and an ungated one would be wrong
 * the day it goes this way. And `apps/server/src/binding.ts`
 * measured the other half — a stranger's process on the same machine is not
 * the operator. A loopback arm without the gate is the exception that file
 * removed, back again one package over.
 *
 * `port` 0 asks the OS for a free one: ephemeral for the desktop and fixed for
 * the server, per #158, and chosen by whoever builds the binding.
 */
export type TunnelBinding =
  | {
      readonly kind: 'loopback';
      readonly port: number;
      readonly gate: TunnelGate;
    }
  | {
      readonly kind: 'tls';
      /** Any address, including a loopback one. The certificate is what varies. */
      readonly host: string;
      readonly port: number;
      readonly tls: TlsMaterial;
      readonly gate: TunnelGate;
    };

/** The loopback arm, which is all rung 0 may bind. */
export type LoopbackTunnelBinding = Extract<TunnelBinding, { readonly kind: 'loopback' }>;

/** How a tunnel ended, which is the distinction `bye` exists to make. */
export type TunnelClose =
  /** The peer said `bye` first. */
  | { readonly kind: 'clean'; readonly reason?: string }
  /** The socket went away without one. A cut, or a peer that crashed. */
  | { readonly kind: 'abnormal'; readonly code: string; readonly message: string };

export interface TunnelHostOptions {
  /**
   * LOOPBACK ONLY. Rung 0 (#156) is deliberately `ws://127.0.0.1`: it removes
   * every variable that is not the protocol, so a stream that tears on
   * loopback is the protocol's fault and nothing else's. The gate is not one of
   * the variables it removes — rung 0 runs through the real one, with a test
   * credential minted by a real pairing window.
   */
  readonly binding: LoopbackTunnelBinding;
  /**
   * Frames this host will send on connect, before anything is received — to a
   * DEVICE tunnel. A pairing tunnel gets no greeting: what it may carry is the
   * exchange, and the exchange is the caller's to run.
   */
  readonly greeting?: readonly TunnelFrame[];
}

export interface TunnelListenerOptions {
  /** Where to listen, and the gate every connection meets. See {@link TunnelBinding}. */
  readonly binding: TunnelBinding;
  /** As {@link TunnelHostOptions.greeting}: device tunnels only. */
  readonly greeting?: readonly TunnelFrame[];
  /**
   * The most tunnels this listener holds at once. REQUIRED, WITH NO DEFAULT.
   *
   * How many phones an app serves at once is that app's decision, and a number
   * picked here would be a decision made in the one place that cannot see the
   * app. #169's recommendations ask for a named constant per limit, enforced
   * at accept time: this is the enforcement, and the constant is the caller's.
   *
   * A connection past the cap is closed with `TUNNEL_CAP_CLOSE_CODE` before
   * anything is sent to it or read from it. A slot frees when a socket closes,
   * not when its tunnel is classified — a peer that said `bye` and kept its
   * socket open is still holding a connection. Pairing tunnels count against
   * it like any other.
   *
   * WHAT IS NOT HERE: replacing a device's stale socket with its new one, the
   * #169 recommendation this does not build. Device identity exists now
   * (`admission.deviceId`), so it is buildable; it is not built. Until it is, a
   * reconnecting phone needs a free slot while its old socket times out.
   */
  readonly maxTunnels: number;
}

type Socket = import('ws').WebSocket;

/** What a pairing tunnel may carry: the exchange, its opening, and its end. */
const PAIRING_KINDS: ReadonlySet<TunnelFrame['kind']> = new Set(['hello', 'pair', 'bye']);

/**
 * One connection's tunnel, over a socket that has already been admitted.
 *
 * Everything a peer can affect lives in this closure, which is the whole of
 * the split: nothing here can reach another connection's inbox, guard, latch
 * or socket, because nothing here can name them.
 */
function openTunnel(
  socket: Socket,
  admission: TunnelAdmission,
  greeting: readonly TunnelFrame[],
  now: () => number,
): Tunnel {
  const inbox: TunnelFrame[] = [];
  let wake: (() => void) | null = null;
  let ended: TunnelClose | null = null;
  const guard = createSequenceGuard();

  let settle!: () => void;
  const closed = new Promise<void>((resolve) => {
    settle = resolve;
  });

  const push = (frame: TunnelFrame): void => {
    inbox.push(frame);
    wake?.();
  };
  /**
   * Record how the tunnel ended. FIRST CALLER WINS, and that is the contract.
   *
   * A tear arrives as a burst: a decode failure and then a socket close, or a
   * `bye` and then a socket close. The first of those is the one that says
   * something — the second is the consequence — so `??=` is not defensiveness,
   * it is the rule that a tunnel which ended for a reason keeps that reason.
   * `tests/rung0.test.ts` pins it by awaiting `closed` and re-reading.
   */
  const finish = (close: TunnelClose): void => {
    ended ??= close;
    wake?.();
    settle();
  };

  /**
   * THE PAIRING TUNNEL'S RULE, IN BOTH DIRECTIONS (#136): the exchange and
   * nothing else, and only while the window that let it in is still live or
   * has been claimed. A `claimed` window is allowed on purpose — the credential
   * is handed over after the claim, on this tunnel. `expired` and `cancelled`
   * are the code no longer being shown, and "reachable only while the desktop
   * shows a code" covers a tunnel already open as much as one arriving.
   *
   * Evaluated when a frame moves, never scheduled, for the reason `window.ts`
   * gives: a timer does not fire on a sleeping machine. A pairing tunnel that
   * sends nothing holds its slot until the caller closes it or the listener
   * does.
   */
  const refusal = (frame: TunnelFrame): { code: string; message: string } | null => {
    if (admission.kind !== 'pairing') return null;
    if (!PAIRING_KINDS.has(frame.kind)) {
      return {
        code: 'PAIRING_ONLY',
        message: `a tunnel admitted to pair may carry only the pairing exchange, not a ${frame.kind} frame`,
      };
    }
    const state = admission.window.state(now());
    if (state === 'expired' || state === 'cancelled') {
      return {
        code: 'PAIRING_WINDOW_CLOSED',
        message: 'the pairing code this tunnel was admitted under is no longer shown',
      };
    }
    return null;
  };

  const refuse = (refused: { code: string; message: string }): void => {
    finish({ kind: 'abnormal', ...refused });
    // `close`, not `terminate`: the code is the phone's only way to tell a
    // refusal from a cut. See `TUNNEL_PAIRING_ONLY_CLOSE_CODE`.
    socket.close(TUNNEL_PAIRING_ONLY_CLOSE_CODE, 'pairing only');
  };

  if (admission.kind === 'device') {
    for (const frame of greeting) {
      assertSendable(frame);
      socket.send(encodeFrame(frame));
    }
  }

  socket.on('message', (data: Buffer) => {
    let frame: TunnelFrame;
    try {
      frame = decodeFrame(new Uint8Array(data));
    } catch (error) {
      // A frame the codec refused. Reported with the peer's own vocabulary
      // rather than thrown, so the caller sees one kind of thing.
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
    // BEFORE the inbox and before the sequence guard: a frame a pairing tunnel
    // may not carry is never read into anything.
    const refused = refusal(frame);
    if (refused) {
      refuse(refused);
      return;
    }
    // Contiguity, enforced. See the client's, which carries the argument.
    const fault = guard.check(frame);
    if (fault) {
      finish({ kind: 'abnormal', code: 'SEQUENCE_BROKEN', message: faultMessage(fault) });
      socket.close();
      return;
    }
    push(frame);
  });

  socket.on('error', (error: Error & { code?: string }) => {
    /*
     * A PEER THAT BREAKS THE WEBSOCKET PROTOCOL ITSELF — an unmasked frame, a
     * length past `ws`'s limit, invalid UTF-8 — is refused by `ws` below the
     * codec, and `ws` reports that as an `error` event on this socket. With no
     * listener an `error` event THROWS: one peer's bad byte was an uncaught
     * exception that took down every tunnel in the process, which a listener
     * holding several tunnels cannot survive. It is this tunnel's fault and
     * this tunnel's end, so it is classified the way the codec's refusals
     * are. Any other socket error is the connection failing, and the `close`
     * that follows reports that as PEER_GONE.
     */
    if (error.code?.startsWith('WS_ERR_')) {
      finish({ kind: 'abnormal', code: 'FRAME_INVALID', message: error.message });
    }
  });

  socket.on('close', () => {
    /*
     * THE `bye` OBLIGATION, AND WHY IT IS LOAD-BEARING (#260).
     *
     * `bye` exists "so the far side can tell it from a dropped link", which
     * only holds if sending it is required. Without the obligation a clean
     * end and a cut are the SAME EVENT — not merely an undefined outcome for
     * #156's faults 3 and 4 but an untestable one, because the assertion has
     * nothing to distinguish.
     *
     * A host that CRASHES cannot send it, so "no bye" means "cut or crashed"
     * rather than "cut". That is the correct reading: both are the far side
     * going away without saying so, and both owe the caller the same answer.
     */
    /*
     * UNCONDITIONAL, because the latch above already holds every other
     * answer. This used to test a `saidBye` flag, which read well and was
     * DEAD CODE: a `bye` sets `ended` in the branch that receives it, and a
     * deliberate close sets it before tearing down, so by the time this
     * fires either the tunnel is already classified or nobody said anything.
     * Mutation testing found it — flipping that branch changed no test —
     * and a condition no input can reach is a claim the reader cannot trust.
     */
    finish({ kind: 'abnormal', code: 'PEER_GONE', message: 'the peer went away without a bye' });
  });

  let closing: Promise<void> | null = null;

  return {
    admission,
    async send(frame) {
      assertSendable(frame);
      const refused = refusal(frame);
      if (refused) {
        refuse(refused);
        throw new Error(`tunnel: ${refused.message}`);
      }
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
    close(reason) {
      closing ??= (async () => {
        // The obligation, from this side: say `bye` before going (#260).
        if (socket.readyState === socket.OPEN) {
          socket.send(
            encodeFrame({ v: TUNNEL_WIRE_VERSION, kind: 'bye', ...(reason ? { body: { reason } } : {}) }),
          );
          /*
           * A TURN OF THE LOOP SO THE FRAME ACTUALLY LEAVES. `send` queues; the
           * socket is torn down on the next line. Without this the `bye` that
           * the whole clean-vs-abnormal distinction rests on is written into a
           * socket that closes before it flushes, and every deliberate close
           * looks like a cut — the exact confusion #260's obligation removes.
           */
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
        }
        /*
         * CLASSIFIED BEFORE THE TEARDOWN, not after, and the order is the whole
         * of it. `terminate()` fires this socket's own `close` handler, which
         * latches PEER_GONE — so a host that shut itself down deliberately
         * reported its own shutdown as a cut. Every rung-0 assertion reads the
         * CLIENT's end, so nothing caught it; `ended() is clean after close()`
         * now does.
         */
        finish({ kind: 'clean', reason });
        socket.terminate();
      })();
      return closing;
    },
  } satisfies Tunnel;
}

/**
 * What the upgrade request asked for, decided before `ws` sees it.
 *
 * A refusal carries only a status. The peer is told 400, 401 or 503 and nothing
 * about which check failed: a wrong credential, a revoked one and an unknown
 * device are the same answer, because the difference is only useful to someone
 * guessing.
 */
type Decision =
  | { readonly admit: TunnelAdmission }
  | { readonly refuse: 400 | 401 | 503 };

/**
 * THE GATE, AT THE UPGRADE (#135, #136). In this order, each step final:
 *
 * 1. THE URL CARRIES NOTHING. Anything but `/` is a 400, and a query string is
 *    the case that matters: #136 rules the credential never travels in the
 *    URL, where request-line logs and history keep it, and a listener that
 *    IGNORED `?credential=…` would let a client that sends it there keep
 *    working and keep leaking it. Refusing the whole request-target rather
 *    than looking for a parameter by name is deliberate — the tunnel has no
 *    path or query it wants, and a name-based check is one spelling away from
 *    missing it. Refused even when a valid header is present too.
 * 2. A CREDENTIAL HEADER IS FINAL. Present — even empty, even malformed, even
 *    wrong — it is verified, and a failure is 401. It never falls through to
 *    pairing: a phone whose credential was revoked is not quietly offered the
 *    pairing exchange instead.
 * 3. NO CREDENTIAL: admitted ONLY while a pairing window is `issued` — asked in
 *    the turn that admits — and then only to pair. Otherwise 401.
 */
async function decide(request: IncomingMessage, gate: TunnelGate): Promise<Decision> {
  if (request.url !== '/') return { refuse: 400 };

  const presented = request.headers[TUNNEL_CREDENTIAL_HEADER];
  if (presented !== undefined) {
    // A TYPE NARROWING, NOT A GATE ANYONE REACHES TODAY: Node joins a repeated
    // custom header into one string (which the credential's shape then
    // refuses), and only a handful of named headers arrive as arrays. The type
    // admits an array, so an array is refused rather than coerced.
    if (typeof presented !== 'string') return { refuse: 401 };
    const deviceId = await gate.credentials.verify(presented);
    return deviceId === null ? { refuse: 401 } : { admit: { kind: 'device', deviceId } };
  }

  // No window at all is a refusal here. Whether a window is still `issued` is
  // asked ONCE, in the turn that admits (see `settle`), because deciding takes
  // turns of the event loop and the answer can change in them — and a second
  // copy of the same question here would be a check no test could tell apart.
  const window = gate.pairing.current();
  return window === null ? { refuse: 401 } : { admit: { kind: 'pairing', window } };
}

const STATUS_TEXT = { 400: 'Bad Request', 401: 'Unauthorized', 503: 'Service Unavailable' } as const;

/**
 * Answer an upgrade with a plain HTTP status and no body, then drop it.
 *
 * `end` then destroy on `finish`, as `ws`'s own `abortHandshake` does: a
 * `write` followed at once by `destroy` can discard the status before it
 * leaves, and a refused client would see a reset rather than a 401.
 */
function refuseUpgrade(socket: Duplex, status: 400 | 401 | 503): void {
  if (!socket.writable) {
    socket.destroy();
    return;
  }
  socket.once('finish', () => socket.destroy());
  socket.end(`HTTP/1.1 ${String(status)} ${STATUS_TEXT[status]}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

/** Until a socket is handed to `ws`, its errors are nobody's to throw. */
const ignoreSocketError = (): void => undefined;

/**
 * Where to bind, or a refusal. The union already refuses the unsafe shapes at
 * compile time; this refuses them from a caller the compiler did not see — a
 * `ServerBinding` handed over by a JavaScript caller, a gate that is not one,
 * a port that is not a port.
 */
function bindTarget(binding: TunnelBinding): { host: string; tls: TlsMaterial | null } {
  const { gate } = binding as { gate?: Partial<TunnelGate> };
  if (
    typeof gate?.credentials?.verify !== 'function' ||
    typeof gate.credentials.isRevoked !== 'function' ||
    typeof gate.credentials.watchRevocations !== 'function' ||
    typeof gate.pairing?.current !== 'function' ||
    typeof gate.now !== 'function'
  ) {
    throw new TypeError('tunnel: a binding without a credential gate is not a binding.');
  }
  if (!Number.isInteger(binding.port) || binding.port < 0 || binding.port > 65_535) {
    throw new RangeError(`tunnel: ${String(binding.port)} is not a port.`);
  }
  switch (binding.kind) {
    case 'loopback':
      return { host: LOOPBACK_HOST, tls: null };
    case 'tls': {
      if (typeof binding.host !== 'string' || binding.host.trim() === '') {
        throw new RangeError('tunnel: the TLS arm needs an address to bind.');
      }
      const { tls } = binding as { tls?: Partial<TlsMaterial> };
      if (typeof tls?.key !== 'string' || typeof tls.cert !== 'string') {
        throw new TypeError('tunnel: the TLS arm needs TLS material made by asTlsMaterial.');
      }
      return { host: binding.host, tls: binding.tls };
    }
    default: {
      const unknown: never = binding;
      throw new TypeError(`tunnel: unknown binding kind ${JSON.stringify((unknown as { kind?: unknown }).kind)}.`);
    }
  }
}

/** A bound listener before anyone has decided what to do with its tunnels. */
interface Bound {
  readonly server: Server;
  /**
   * Admit nobody else, from this turn on, and stop the server taking new
   * connections. Open tunnels are left alone.
   *
   * NOT JUST `server.close()`, which is what rung 0's wrapper used to call. That
   * refuses new TCP connections and still lets a connection already inside a
   * request finish its upgrade; the flag this sets is read at the upgrade.
   */
  stopAccepting(): void;
  close(reason?: string): Promise<void>;
}

/**
 * Bind, and hand each admitted connection's tunnel to `admit` SYNCHRONOUSLY.
 *
 * Synchronous because {@link createTunnelHost} needs to know about its one
 * tunnel in the same turn the connection arrives, and needs to stop accepting
 * in the same turn that tunnel ends. A queue in between would leave a gap in
 * which a second peer could be admitted to a host that is already over.
 */
async function listen(options: TunnelListenerOptions, admit: (tunnel: Tunnel) => void): Promise<Bound> {
  const { maxTunnels, binding } = options;
  // Fails closed. A cap of 0, NaN or 1.5 is a caller's mistake, and clamping it
  // to something would hide the mistake behind a number nobody chose.
  if (!Number.isInteger(maxTunnels) || maxTunnels < 1) {
    throw new RangeError(`maxTunnels must be a positive integer, got ${String(maxTunnels)}`);
  }
  const target = bindTarget(binding);
  const { gate } = binding;

  const { WebSocketServer } = await import('ws');
  const server = target.tls === null ? createServer() : createTlsServer({ key: target.tls.key, cert: target.tls.cert });
  /*
   * `noServer`, AND THE UPGRADE WIRED BY HAND, because `{ server }` is what
   * turned a busy port into a crash. Handed a server, `ws` adds its own `error`
   * listener to it that re-emits on the WebSocketServer
   * (`ws/lib/websocket-server.js:125-131`), and nothing listened there — so
   * EADDRINUSE was thrown from inside the server's own `emit`, before any
   * `once('error')` added afterwards could run. With `noServer` the server's
   * events are this file's alone. This is the `ws` README's own pattern, and
   * so is authenticating in the `upgrade` handler before `handleUpgrade`.
   */
  const sockets = new WebSocketServer({ noServer: true });
  const live = new Set<Tunnel>();
  /**
   * Upgrades the gate has not finished with: a credential still being
   * verified, or a refusal still being written. `listener.close()` destroys
   * them. `http.Server.close()` would otherwise wait on each — an upgrade is no
   * longer the server's request to time out, and a store that never answers
   * would hold a quit open forever.
   */
  const pending = new Set<Duplex>();
  let accepting = true;

  /*
   * REVOCATION CLOSES LIVE TUNNELS, NOT ONLY THE NEXT CONNECT (#135, #169).
   * Each of the device's tunnels says `bye` with the reason and goes through
   * its own close, which leaves every other tunnel and the listener running.
   */
  const unwatch = gate.credentials.watchRevocations(async (deviceId) => {
    const revoked = [...live].filter(
      (tunnel) => tunnel.admission.kind === 'device' && tunnel.admission.deviceId === deviceId,
    );
    await Promise.all(revoked.map((tunnel) => tunnel.close('revoked')));
  });

  server.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    /*
     * ADMISSION ENDS HERE, AT THE UPGRADE, and not at `server.close()`. Closing
     * the server refuses new TCP connections, but a connection already inside
     * an HTTP request is not idle, so it survives the close and can still
     * finish upgrading. Measured on rung 0's wrapper: a peer whose request line
     * reached the server while the tunnel was live got `101 Switching
     * Protocols` after `closed` resolved, and became the host's tunnel. So a
     * peer that is too late is dropped here, before `ws` writes a byte: the
     * nearest a connected socket can come to ECONNREFUSED, and no close code
     * that would claim the listener is full rather than going.
     */
    if (!accepting) {
      socket.destroy();
      return;
    }
    socket.on('error', ignoreSocketError);
    pending.add(socket);
    socket.once('close', () => pending.delete(socket));

    const settle = (decision: Decision): void => {
      // `close()` may have run while the gate was deciding. It destroyed this
      // socket already; a decision that arrives afterwards admits nobody.
      if (!accepting || socket.destroyed) {
        socket.destroy();
        return;
      }
      if ('refuse' in decision) {
        refuseUpgrade(socket, decision.refuse);
        return;
      }
      const { admit: admission } = decision;
      /*
       * THE LAST WORD, IN THE TURN THAT ADMITS. Deciding took turns of the
       * event loop; handing the socket to `ws` below does not. So the two
       * things that can change in between are asked here, with nothing after
       * them but the handshake.
       *
       * THE WINDOW is asked here and only here: expired, claimed, or cancelled
       * (issuing a new code cancels the old window, so a replaced window is a
       * cancelled one) is a 401.
       *
       * THE DEVICE is asked twice, and the second time is labelled rather than
       * defended. `verify` already refuses a device revoked while its store
       * read was pending, for every caller. This re-check covers only the
       * turns between `verify` returning and this line, which no test can aim
       * at: mutation testing removes it alone and the suite stays green, and
       * removes it together with `verify`'s and the revocation-during-read
       * test fails.
       */
      const stale =
        admission.kind === 'device'
          ? gate.credentials.isRevoked(admission.deviceId)
          : admission.window.state(gate.now()) !== 'issued';
      if (stale) {
        refuseUpgrade(socket, 401);
        return;
      }
      pending.delete(socket);
      socket.removeListener('error', ignoreSocketError);
      /*
       * With no `verifyClient`, `handleUpgrade` reaches its callback
       * synchronously (`completeUpgrade` in `ws/lib/websocket-server.js`), so
       * `connection` — and the tunnel joining `live`, where revocation can find
       * it — runs in this same turn.
       */
      sockets.handleUpgrade(request, socket, head, (ws) => sockets.emit('connection', ws, request, admission));
    };

    // A gate that throws — a store that cannot be read — admits nobody. 503,
    // not 401: a paired phone told "unauthorized" would conclude it was
    // revoked, and it was not.
    decide(request, gate).then(settle, () => settle({ refuse: 503 }));
  });

  sockets.on('connection', (socket: Socket, _request: IncomingMessage, admission: TunnelAdmission) => {
    /*
     * THE CAP, AT ACCEPT TIME, AND FIRST (#169). Before the greeting and before
     * anything that reads from the socket, so a refused peer is told the code
     * and nothing else, and no frame it sends is ever read into anything.
     */
    if (live.size >= maxTunnels) {
      // A refused socket belongs to no tunnel, and its protocol errors must not
      // throw either. See `openTunnel`'s `error` handler for why they would.
      socket.on('error', () => undefined);
      socket.close(TUNNEL_CAP_CLOSE_CODE, 'tunnel limit reached');
      return;
    }

    const tunnel = openTunnel(socket, admission, options.greeting ?? [], gate.now);
    live.add(tunnel);
    // The SOCKET closing frees the slot, not the tunnel being classified; see
    // `maxTunnels`.
    socket.on('close', () => live.delete(tunnel));
    admit(tunnel);
  });

  // A busy port rejects rather than hanging, as `apps/server/src/index.ts`'s
  // own listen does. Removed on success so a later error is not a rejection of
  // a promise that already resolved.
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(binding.port, target.host, () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
  } catch (error) {
    // A listener that never bound must not stay subscribed to revocations.
    unwatch();
    throw error;
  }

  let closing: Promise<void> | null = null;

  return {
    server,
    stopAccepting() {
      accepting = false;
      server.close();
    },
    close(reason) {
      closing ??= (async () => {
        // In the first turn, before any wait below: those waits are real turns
        // of the event loop, and an upgrade landing in one must not be admitted.
        accepting = false;
        // An upgrade still waiting on the gate goes now, whatever the gate is
        // doing. Its decision, if one ever arrives, finds it destroyed.
        for (const socket of pending) socket.destroy();
        pending.clear();
        unwatch();
        // Every open tunnel says `bye` and goes, each through its own close.
        await Promise.all([...live].map((tunnel) => tunnel.close(reason)));

        /*
         * `closeAllConnections()` BEFORE `server.close()`, and this is the bug
         * that cost the first run of rung 0.
         *
         * `http.Server.close()` stops accepting and then WAITS for every open
         * connection to end on its own. A connected tunnel never ends on its
         * own, so the callback never fired and `close()` hung forever — which
         * presented as all nine rung-0 tests timing out at once, i.e. as the
         * transport not working rather than as teardown not completing.
         *
         * The earlier connect probe passed only because it closed the CLIENT
         * first, leaving the server with nothing to wait for. A harness that
         * tears down in the other order is the ordinary case, so this is the
         * order that has to work. Tunnels are gone by this line; what is left
         * is a refused socket mid-handshake, or a plain HTTP connection that
         * never asked to upgrade.
         */
        sockets.clients.forEach((client) => client.terminate());
        server.closeAllConnections();
        await new Promise<void>((resolve) => sockets.close(() => resolve()));
        await new Promise<void>((resolve) => server.close(() => resolve()));
      })();
      return closing;
    },
  };
}

/**
 * One listener, many tunnels (#158), behind the gate (#135, #136).
 *
 * `ws@8.21.3` per #157's ruling — Node ships a WebSocket CLIENT and no server,
 * and the hand-rolled handshake that works first try is exactly what makes
 * hand-rolling tempting and exactly what makes it a few hundred lines of
 * masking, extended length, fragmentation, ping/pong and close handling that a
 * phone's implementation will exercise in ways a test by the same author will
 * not.
 *
 * ONE IMPLEMENTATION, TWO CALLERS (#158): Electron and `apps/server` both
 * start this. Nothing here knows which, and nothing here starts it: no app
 * calls this yet.
 */
export async function createTunnelListener(options: TunnelListenerOptions): Promise<TunnelListener> {
  const queue: Tunnel[] = [];
  const waiters: (() => void)[] = [];
  let handingOut = true;
  const wakeAll = (): void => {
    for (const wake of waiters.splice(0)) wake();
  };

  const bound = await listen(options, (tunnel) => {
    queue.push(tunnel);
    wakeAll();
  });

  return {
    server: bound.server,
    async *tunnels() {
      for (;;) {
        while (queue.length > 0) yield queue.shift()!;
        if (!handingOut) return;
        await new Promise<void>((resolve) => waiters.push(resolve));
      }
    },
    async close(reason) {
      handingOut = false;
      wakeAll();
      await bound.close(reason);
    },
  } satisfies TunnelListener;
}

/**
 * A loopback listener for exactly one tunnel, for rung 0 (#156).
 *
 * A listener capped at ONE, whose one tunnel is the host. It STOPS ACCEPTING
 * the moment that tunnel ends: rung 0's host is one tunnel's lifetime, and a
 * port that kept listening afterwards completed handshakes onto a tunnel that
 * would never read another frame, reporting "on" while serving nothing. A late
 * peer now gets ECONNREFUSED; a peer that connected earlier but finishes its
 * upgrade late is dropped at the upgrade, unanswered; and a second peer while
 * the first is still connected gets `TUNNEL_CAP_CLOSE_CODE`.
 *
 * THROUGH THE SAME GATE, and rung 0 gets in with a TEST CREDENTIAL: its tests
 * open a pairing window, claim it and mint a device credential exactly as a
 * desktop would, and its client presents that credential in the header. There
 * is no ungated door for a test to use and a caller to find later.
 */
export async function createTunnelHost(options: TunnelHostOptions): Promise<TunnelHost> {
  let tunnel: Tunnel | null = null;
  // How the host ended if it was closed before any peer arrived.
  let endedEmpty: TunnelClose | null = null;

  let arrive!: () => void;
  const arrived = new Promise<void>((resolve) => {
    arrive = resolve;
  });
  let settle!: () => void;
  const closed = new Promise<void>((resolve) => {
    settle = resolve;
  });

  const bound = await listen({ ...options, maxTunnels: 1 }, (admitted) => {
    tunnel = admitted;
    arrive();
    void admitted.closed.then(() => {
      // Stop admitting in the turn the tunnel ends, before the next connection
      // or upgrade can be read, so a caller that awaits `closed` never races
      // the listener: a new connection is refused, and one already mid-request
      // is dropped at its upgrade. See `Bound.stopAccepting`.
      bound.stopAccepting();
      settle();
    });
  });

  return {
    server: bound.server,
    async send(frame) {
      // Checked here too, so a frame that may never be sent is refused even
      // before a peer has arrived to send it to.
      assertSendable(frame);
      await tunnel?.send(frame);
    },
    async *receive() {
      await arrived;
      if (tunnel) yield* tunnel.receive();
    },
    ended: () => tunnel?.ended() ?? endedEmpty,
    closed,
    async close(reason) {
      if (tunnel) {
        await tunnel.close(reason);
      } else {
        endedEmpty ??= { kind: 'clean', reason };
        arrive();
        settle();
      }
      await bound.close(reason);
    },
    /*
     * `satisfies`, NOT `as`. The cast hid a `get close_()` that `TunnelHost`
     * never declared and nothing read; `satisfies` makes an undeclared member
     * a compile error rather than something a reviewer has to notice.
     */
  } satisfies TunnelHost;
}
