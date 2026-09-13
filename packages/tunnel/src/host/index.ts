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
 * NOT IMPLEMENTED HERE, AND THE REASON CHANGED. Node ships a WebSocket client
 * and no WebSocket server (#157) — that half still holds. What no longer holds
 * is the other half this comment used to carry: whether the listener sits
 * behind plaintext LAN plus an application-layer handshake or behind a native
 * socket plugin was #181's call, and #181 made it on 2026-09-11: **a native
 * socket plugin, on both platforms. One transport, not two.**
 *
 * This file is still the shape rather than the server, because the server is
 * #157 and #158. It is not waiting on anybody.
 */

import { createServer } from 'node:http';
import type { Server } from 'node:http';

import { assertSendable, createSequenceGuard, faultMessage } from '../stream/index.js';
import { TUNNEL_WIRE_VERSION, decodeFrame, encodeFrame, type TunnelFrame } from '../wire/index.js';

/**
 * The host end of a tunnel.
 *
 * Typed against Node's own `Server` deliberately. It would be easy to write
 * this half against a structural `{ close(): void }` and keep `node:http` out of
 * the file — and that would be a boundary that looks kept while the code below
 * it binds a socket anyway. Naming the Node type here makes the half honest
 * about what it is, and makes the guard's ban a rule with something behind it.
 */
export interface TunnelHost {
  /** The bound server. Node-only, which is the whole point of this file. */
  readonly server: Server;
  /** Send one frame to the connected peer. */
  send(frame: TunnelFrame): Promise<void>;
  /** Frames from the peer, in arrival order, until the tunnel closes. */
  receive(): AsyncIterable<TunnelFrame>;
  /** Stop listening and drop the connection. Says `bye` first. Idempotent. */
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
 * WHERE `TunnelBinding` WILL GO, AND WHY IT IS NOT HERE YET.
 *
 * `apps/server/src/binding.ts` already carries the pattern this wants: the bind
 * address and its credentials are ONE union, so "listening beyond loopback
 * without auth" is not a check someone can forget but a value TypeScript will
 * not accept. The tunnel needs the same union, and it belongs in this file.
 *
 * IT IS NO LONGER BLOCKED. This said its ARMS were the decision in #181, and
 * that a union with arms for both would sanction whichever option lost. #181
 * ruled on 2026-09-11 — a native socket plugin, one transport — so there is
 * one arm to write, and the thing standing between here and it is #157/#158
 * building the listener, not a question anyone still has to answer.
 *
 * Two constraints the ruling carries into whoever writes it. `apps/server/src/
 * binding.ts`'s pattern is the one to copy: the bind address and its
 * credentials are ONE union, so "listening beyond loopback without auth" is a
 * value TypeScript refuses rather than a check someone forgets. And #135's
 * ruling is explicit that this must NOT become a third arm of `ServerBinding`
 * — that would put an arm-dependent branch back into `checkToken`'s gate 1,
 * whose absence is that file's documented strength. A separate `TunnelBinding`
 * union, here.
 *
 * The trust field is a certificate fingerprint, not a key-agreement public
 * key: that is a consequence of the ruling, stated in it, and #134 owns the
 * QR byte that names which.
 */

/** How a tunnel ended, which is the distinction `bye` exists to make. */
export type TunnelClose =
  /** The peer said `bye` first. */
  | { readonly kind: 'clean'; readonly reason?: string }
  /** The socket went away without one. A cut, or a peer that crashed. */
  | { readonly kind: 'abnormal'; readonly code: string; readonly message: string };

export interface TunnelHostOptions {
  /**
   * Loopback port. 0 asks the OS for a free one, which is what tests want.
   *
   * THERE IS NO HOST OPTION, and that is the boundary rather than an omission.
   * Binding beyond loopback is what `TunnelBinding` exists to constrain, and
   * `TunnelBinding` is not written — #135 and #158 settled its shape and
   * #157/#158 own building it. Rung 0 (#156) is deliberately
   * `ws://127.0.0.1`: it removes every variable that is not the protocol, so a
   * stream that tears on loopback is the protocol's fault and nothing else's.
   *
   * A `host` parameter here would be the hole shaped exactly like the feature,
   * added before the union that is supposed to constrain it.
   */
  readonly port?: number;
  /** Frames this host will send on connect, before anything is received. */
  readonly greeting?: readonly TunnelFrame[];
}

/**
 * A loopback listener, for rung 0 (#156).
 *
 * `ws@8.21.3` per #157's ruling — Node ships a WebSocket CLIENT and no server,
 * and the hand-rolled handshake that works first try is exactly what makes
 * hand-rolling tempting and exactly what makes it a few hundred lines of
 * masking, extended length, fragmentation, ping/pong and close handling that a
 * phone's implementation will exercise in ways a test by the same author will
 * not.
 *
 * ONE IMPLEMENTATION, TWO CALLERS (#158): Electron and `apps/server` both
 * start this. Nothing here knows which.
 */
export async function createTunnelHost(options: TunnelHostOptions = {}): Promise<TunnelHost> {
  const { WebSocketServer } = await import('ws');
  const server = createServer();
  const sockets = new WebSocketServer({ server });

  const inbox: TunnelFrame[] = [];
  let wake: (() => void) | null = null;
  let ended: TunnelClose | null = null;
  let peer: import('ws').WebSocket | null = null;
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

  sockets.on('connection', (socket) => {
    peer = socket;
    for (const frame of options.greeting ?? []) {
      assertSendable(frame);
      socket.send(encodeFrame(frame));
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
      // Contiguity, enforced. See the client's, which carries the argument.
      const fault = guard.check(frame);
      if (fault) {
        finish({ kind: 'abnormal', code: 'SEQUENCE_BROKEN', message: faultMessage(fault) });
        socket.close();
        return;
      }
      push(frame);
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
  });

  await new Promise<void>((resolve) => server.listen(options.port ?? 0, '127.0.0.1', resolve));

  return {
    server,
    get close_(): TunnelClose | null {
      return ended;
    },
    async send(frame) {
      assertSendable(frame);
      peer?.send(encodeFrame(frame));
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
      // The obligation, from this side: say `bye` before going (#260).
      if (peer && peer.readyState === peer.OPEN) {
        peer.send(
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
       * order that has to work.
       */
      /*
       * CLASSIFIED BEFORE THE TEARDOWN, not after, and the order is the whole
       * of it. `terminate()` fires this socket's own `close` handler, which
       * latches PEER_GONE — so a host that shut itself down deliberately
       * reported its own shutdown as a cut. Every rung-0 assertion reads the
       * CLIENT's end, so nothing caught it; `ended() is clean after close()`
       * now does.
       */
      finish({ kind: 'clean', reason });

      sockets.clients.forEach((client) => client.terminate());
      server.closeAllConnections();
      await new Promise<void>((resolve) => sockets.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  } as TunnelHost;
}
