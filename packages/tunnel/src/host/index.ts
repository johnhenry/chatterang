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
 * What this file builds is rung 0 of that (#156): a real listener that speaks
 * the real wire format, on loopback, with no TLS and no credential. It exists to
 * hold the protocol to its word. No app starts it. What has to exist before one
 * may is AT LEAST this, and #158 holds the whole gate: a device credential
 * (#135), certificate material (#179), a declared surface (#170), and the
 * inbound privacy copy on every surface that makes the outbound promise,
 * landing in the same change as the start path (#221, #158). A listener that
 * carries turns also waits on #7's background substrate, per #169's ruling.
 */

import { createServer } from 'node:http';
import type { Server } from 'node:http';

import { assertSendable, createSequenceGuard, faultMessage } from '../stream/index.js';
import {
  TUNNEL_CAP_CLOSE_CODE,
  TUNNEL_WIRE_VERSION,
  decodeFrame,
  encodeFrame,
  type TunnelFrame,
} from '../wire/index.js';

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
  /** Send one frame to this tunnel's peer. */
  send(frame: TunnelFrame): Promise<void>;
  /** Frames from this peer, in arrival order, until the tunnel closes. */
  receive(): AsyncIterable<TunnelFrame>;
  /**
   * Say `bye` to this peer and drop its connection. Every other tunnel, and
   * the listener, keep running — which is what closing one revoked device's
   * socket will need (#135). Idempotent.
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
export interface TunnelHost extends Tunnel {
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
  /** The bound server. Node-only, as above. */
  readonly server: Server;
  /**
   * Each admitted connection's tunnel, in the order admitted, until the
   * listener closes. A tunnel is handed out ONCE: two loops over this share
   * one queue rather than each seeing every tunnel.
   */
  tunnels(): AsyncIterable<Tunnel>;
  /**
   * Stop accepting, say `bye` on every open tunnel and drop it, then close the
   * server. Idempotent.
   */
  close(reason?: string): Promise<void>;
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

export interface TunnelListenerOptions extends TunnelHostOptions {
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
   * socket open is still holding a connection.
   *
   * WHAT IS NOT HERE: replacing a device's stale socket with its new one, the
   * #169 recommendation this does not build. Knowing that two sockets are the
   * same device needs device identity, which is #135's and does not exist yet.
   * Until it does, a reconnecting phone needs a free slot while its old socket
   * times out.
   */
  readonly maxTunnels: number;
}

type Socket = import('ws').WebSocket;

/**
 * One connection's tunnel, over a socket that has already been admitted.
 *
 * Everything a peer can affect lives in this closure, which is the whole of
 * the split: nothing here can reach another connection's inbox, guard, latch
 * or socket, because nothing here can name them.
 */
function openTunnel(socket: Socket, greeting: readonly TunnelFrame[]): Tunnel {
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

  for (const frame of greeting) {
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
    async send(frame) {
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
  const { maxTunnels } = options;
  // Fails closed. A cap of 0, NaN or 1.5 is a caller's mistake, and clamping it
  // to something would hide the mistake behind a number nobody chose.
  if (!Number.isInteger(maxTunnels) || maxTunnels < 1) {
    throw new RangeError(`maxTunnels must be a positive integer, got ${String(maxTunnels)}`);
  }

  const { WebSocketServer } = await import('ws');
  const server = createServer();
  /*
   * `noServer`, AND THE UPGRADE WIRED BY HAND, because `{ server }` is what
   * turned a busy port into a crash. Handed a server, `ws` adds its own `error`
   * listener to it that re-emits on the WebSocketServer
   * (`ws/lib/websocket-server.js:125-131`), and nothing listened there — so
   * EADDRINUSE was thrown from inside the server's own `emit`, before any
   * `once('error')` added afterwards could run. With `noServer` the server's
   * events are this file's alone. This is the `ws` README's own pattern.
   */
  const sockets = new WebSocketServer({ noServer: true });
  const live = new Set<Tunnel>();
  let accepting = true;

  server.on('upgrade', (request, socket, head) => {
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
     *
     * The ONLY such check, because nothing can slip in after it. With no
     * `verifyClient`, `handleUpgrade` reaches its callback synchronously
     * (`completeUpgrade` in `ws/lib/websocket-server.js`), so `connection` runs
     * in this same turn.
     */
    if (!accepting) {
      socket.destroy();
      return;
    }
    sockets.handleUpgrade(request, socket, head, (ws) => sockets.emit('connection', ws, request));
  });

  sockets.on('connection', (socket: Socket) => {
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

    const tunnel = openTunnel(socket, options.greeting ?? []);
    live.add(tunnel);
    // The SOCKET closing frees the slot, not the tunnel being classified; see
    // `maxTunnels`.
    socket.on('close', () => live.delete(tunnel));
    admit(tunnel);
  });

  // A busy port rejects rather than hanging, as `apps/server/src/index.ts`'s
  // own listen does. Removed on success so a later error is not a rejection of
  // a promise that already resolved.
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

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
 * One listener, many tunnels (#158).
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
 */
export async function createTunnelHost(options: TunnelHostOptions = {}): Promise<TunnelHost> {
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
