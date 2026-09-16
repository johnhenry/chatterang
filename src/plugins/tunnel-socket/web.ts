/**
 * Web implementation of `TunnelSocket`: a browser refuses (#295, refs #181).
 *
 * #181 ruled the tunnel client is a native socket plugin on iOS and Android,
 * terminating pinned TLS itself, because a browser `WebSocket` cannot report
 * the peer certificate a pin has to be checked against
 * (`NegotiatedPeerCertificate`, `packages/contracts/src/tunnel-socket.ts`).
 * There is no "connect anyway and skip the pin" answer here — the contract's
 * whole point is that a connection is trusted only once the plugin has
 * checked it, and a web build cannot check it at all.
 *
 * A PLAIN REFUSAL, not a shim, for the same reason `mount-host/web.ts` is one
 * and not a fake filesystem: a simulated tunnel would show a person a paired
 * desktop that is not there. `connect` rejects with `OPTIONS_REFUSED`
 * ({@link TunnelConnectRejectionCode}) before anything is dialled, matching
 * what {@link TunnelSocketPlugin.connect} promises for options this build
 * refuses outright — no event follows, no socket is opened, and the codes
 * this plugin never issues (`CREDENTIAL_MISSING`, a `tunnelOpen` or
 * `tunnelClose`) are not answers to lean on here.
 *
 * `send`, `close` and `negotiatedPeer` all throw: every one of their contracts
 * is scoped to a `connectionId` this plugin never hands out, because
 * `connect` never resolves with one.
 */

import { WebPlugin } from '@capacitor/core';
import type { TunnelConnectOptions, TunnelSocketPlugin } from './definitions';

const REFUSAL =
  'TunnelSocket: a browser cannot check the peer certificate a tunnel connection is pinned ' +
  'against, so this build refuses to open one. #181 chose a native socket plugin on iOS and ' +
  'Android for exactly this reason.';

function noSuchConnection(method: string): Error {
  return new Error(`TunnelSocket: "${method}" was called with a connectionId this plugin never issued.`);
}

export class TunnelSocketWeb extends WebPlugin implements TunnelSocketPlugin {
  async connect(_options: TunnelConnectOptions): Promise<{ readonly connectionId: string }> {
    // No `Object.assign` needed: `call.reject(message, code)` on the native
    // side surfaces as an `Error` with a string `code` (#295's contract doc),
    // and this is the web equivalent of that same rejection.
    throw Object.assign(new Error(REFUSAL), { code: 'OPTIONS_REFUSED' });
  }

  async send(_options: { readonly connectionId: string; readonly frame: string }): Promise<void> {
    throw noSuchConnection('send');
  }

  async close(_options: {
    readonly connectionId: string;
    readonly code?: number;
    readonly reason?: string;
  }): Promise<void> {
    throw noSuchConnection('close');
  }

  async negotiatedPeer(
    _options: Parameters<TunnelSocketPlugin['negotiatedPeer']>[0],
  ): ReturnType<TunnelSocketPlugin['negotiatedPeer']> {
    throw noSuchConnection('negotiatedPeer');
  }
}
