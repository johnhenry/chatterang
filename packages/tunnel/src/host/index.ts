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
 * NOT IMPLEMENTED HERE, ON PURPOSE. Node ships a WebSocket client and no
 * WebSocket server (#157), and whether this listens in plaintext on the LAN
 * behind an application-layer handshake or behind a native socket plugin is
 * #181's undecided call. This file is the shape, not the server.
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
 * It cannot be written yet, because its ARMS are the decision in #181. A
 * plaintext-LAN tunnel with an application-layer handshake and a native socket
 * plugin do not have the same fields, and inventing arms for both would hand
 * the reader a union that sanctions whichever option loses. Blocked, named, and
 * left alone.
 */

/**
 * The seam the listener will be built behind.
 *
 * Throws today. See the file comment: the package's deliverable in #155 is the
 * boundary and the guard, not the transport.
 */
export function createTunnelHost(): never {
  throw new Error(
    'tunnel host is not implemented: the transport option is undecided (#181); ' +
      'the WebSocket server question is #157',
  );
}
