/**
 * THE HOST HALF: the listener, which `src/` may never import.
 *
 * A listener binds a socket. `node:net` is right there in the import list
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

import type { Server } from 'node:net';

import type { TunnelFrame } from '../wire/index.js';

/**
 * The host end of a tunnel.
 *
 * Typed against Node's own `Server` deliberately. It would be easy to write
 * this half against a structural `{ close(): void }` and keep `node:net` out of
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
  /** Stop listening and drop the connection. Idempotent. */
  close(): Promise<void>;
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

/**
 * The seam the listener will be built behind.
 *
 * Throws today. See the file comment: the package's deliverable in #155 is the
 * boundary and the guard, not the transport — and the transport is now a
 * decided thing that has not been built, which is a different sentence from
 * the one this used to print.
 */
export function createTunnelHost(): never {
  throw new Error(
    'tunnel host is not implemented: the transport is a native socket plugin ' +
      '(#181, ruled 2026-09-11) and the listener is #157/#158',
  );
}
