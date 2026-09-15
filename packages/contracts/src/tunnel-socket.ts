/**
 * The native socket plugin's contract: all of it (#181, #256, #295).
 *
 * #181 ruled the phone's transport is a native socket plugin terminating
 * pinned TLS, on both platforms, one transport rather than two. This file is
 * everything `src/` may ask of that plugin: open a connection, send frames,
 * hear frames, close it, and read what the handshake negotiated. It is declared
 * here, types only, where all three implementations can see it: the web shim,
 * the native bridges, and the Node backend.
 *
 * It used to declare `negotiatedPeer` alone and hand connect, send and close to
 * #158. #158 built the listener, which is the other end, so that hand-off
 * pointed at nothing. The rest is here now.
 *
 * WHO CALLS IT. Not `createTunnelClient`: `packages/tunnel/src/client/` may
 * import no `@capacitor/` (`tests/layering.test.ts`), and it imports nothing
 * from here either. The client takes a `TunnelTransport` (bytes in, bytes out,
 * one close), and an app passes in an adapter from this plugin to that shape.
 * The protocol gate, the sequence checks, `bye` and the close-code faults all
 * run in the client, over whatever transport it was handed.
 *
 * FRAMES CROSS AS BASE64 OF THE EXACT BYTES, and the plugin validates none of
 * them: not UTF-8, not JSON, not the frame. A Capacitor bridge's payload is
 * JSON, where a `Uint8Array` arrives as an object with numeric keys and a string
 * is text. A plugin that decoded a message as text before handing it over would
 * turn an invalid byte into a replacement character, and `decodeFrame`'s fatal
 * UTF-8 decoder, which is the one validator on every other end, would never see
 * it. So one WebSocket message is one `frame`, binary or text alike, and
 * `decodeFrame` on the JavaScript side is still the only thing that decides
 * whether it is a frame.
 */

import type { ListenerHandle } from './listener.js';

/**
 * What the transport negotiated with the peer.
 *
 * A FINGERPRINT AND NOT THE CERTIFICATE, for two reasons. The 32 bytes are
 * what #134's payload already carries, so the QR route's pin and the typed
 * route's binding compare the same value rather than two representations of
 * it. And a whole certificate crossing the bridge invites a caller to parse it
 * in `src/` — which is an X.509 parser in the app bundle, on a phone, for a
 * decision the plugin has already made.
 */
export interface NegotiatedPeerCertificate {
  /**
   * SHA-256 of the peer's SubjectPublicKeyInfo, base64.
   *
   * Base64 rather than bytes because this crosses a Capacitor bridge, where
   * the payload is JSON and a `Uint8Array` arrives as an object with numeric
   * keys. The caller decodes once, at the boundary.
   */
  readonly spkiSha256: string;
}

/**
 * What to connect to, and what to present.
 *
 * AT MOST ONE OF `credential` AND `credentialRef`, and neither for a
 * connection that only pairs. The credential goes in
 * `chatterang-device-credential` (the wire's `TUNNEL_CREDENTIAL_HEADER`) on the
 * upgrade request and never in `url` (#136). A listener refuses any request
 * target but `/` with 400, a query string included.
 *
 * WHERE THE SECRET LIVES IS NOT DECIDED HERE, and the two forms exist so that
 * it does not have to be. Whether the phone keeps its device credential in the
 * OS keychain or keystore, reached through this plugin, or in app storage like
 * an API key is an open owner question. #126 recorded that a device KEY on iOS
 * belongs in the Keychain under `kSecAttrAccessibleWhenUnlockedThisDeviceOnly`,
 * which `src/` cannot reach (restated in #124's ruling). `credentialRef` fits
 * that answer: the plugin reads the secret itself and JavaScript never holds
 * it. `credential` fits the other. Either ruling lands without a change to this
 * contract.
 *
 * A CREDENTIAL IS WRITTEN ONLY WHERE IT IS SAFE, and the plugin checks this
 * itself rather than trusting its caller. With either form present:
 *
 * - `url` is `wss:`, or `ws:` to exactly `127.0.0.1` (a test harness; never a
 *   paired phone). Anything else, and `connect` rejects before any socket is
 *   made. This is the rule `createTunnelClient` applies to every transport.
 * - Over `wss:`, `expectedPeer` is REQUIRED, and the plugin aborts the TLS
 *   handshake when the peer's SPKI SHA-256 differs, BEFORE it writes the
 *   upgrade request. The check cannot move to JavaScript: the credential is in
 *   the request headers, and they are written before any event reaches `src/`.
 *   So a credential never reaches a peer that is not the paired one.
 *
 * Without a credential, `expectedPeer` is optional. The QR route knows the pin
 * before connecting and should pass it; the typed route learns it from
 * {@link TunnelSocketPlugin.negotiatedPeer} and binds it (#256). With no
 * `expectedPeer`, any certificate is accepted, and nothing but pairing may
 * travel until the caller has checked what was negotiated.
 */
export type TunnelConnectOptions =
  | {
      readonly url: string;
      readonly credential?: undefined;
      readonly credentialRef?: undefined;
      readonly expectedPeer?: NegotiatedPeerCertificate;
    }
  | {
      readonly url: string;
      /** The device credential itself. */
      readonly credential: string;
      readonly credentialRef?: undefined;
      readonly expectedPeer?: NegotiatedPeerCertificate;
    }
  | {
      readonly url: string;
      readonly credential?: undefined;
      /**
       * The name the platform store keeps the credential under. `connect`
       * rejects when it names nothing.
       */
      readonly credentialRef: string;
      readonly expectedPeer?: NegotiatedPeerCertificate;
    };

/** The handshake finished: frames may be sent. At most once per connection. */
export interface TunnelOpenEvent {
  readonly connectionId: string;
}

/** One message from the peer. Never before `tunnelOpen`, never after `tunnelClose`. */
export interface TunnelFrameEvent {
  readonly connectionId: string;
  /** Base64 of the message's exact bytes. Not decoded, not checked. */
  readonly frame: string;
}

/**
 * Why the PLUGIN ended a connection before it opened, when that was not a host
 * answering and not a host missing.
 *
 * `PEER_MISMATCH`: the TLS handshake completed with a key whose SPKI SHA-256
 * is not `expectedPeer`, and the plugin aborted before writing the upgrade
 * request. That is a desktop that reset its identity, or something else
 * answering at its address. Either way nothing was sent to it, and the screen
 * that explains it is not the one for a host that is not there.
 */
export type TunnelCloseFailure = 'PEER_MISMATCH';

/**
 * The connection is over. EXACTLY ONE per connection `connect` resolved,
 * whether or not it ever opened, and nothing about that connection after it.
 *
 * A refused upgrade, an unreachable host, a failed pin, a cut and a close frame
 * all end here, told apart by the fields below and not by a second event: a
 * status is a host that answered, a `failure` is the plugin refusing the peer,
 * and neither is a host nobody reached.
 */
export interface TunnelCloseEvent {
  readonly connectionId: string;
  /**
   * The close code from the peer's close frame. 1006 when there was none: the
   * connection never opened, or it was cut.
   */
  readonly code: number;
  /** The close frame's reason, or empty. */
  readonly reason: string;
  /**
   * The HTTP status the server answered the upgrade with, when it answered one
   * other than 101. Present only then: the connection never opened, and `code`
   * is 1006. A 401 (credential refused) and a 503 (the host could not check)
   * are different faults from "cannot reach", and without this field every one
   * of them looks like a host that is not there.
   */
  readonly httpStatus?: number;
  /**
   * Why the plugin itself ended the connection before it opened. Present only
   * then, with `code` 1006 and no `httpStatus`: the plugin wrote no request, so
   * nothing answered one. See {@link TunnelCloseFailure}.
   */
  readonly failure?: TunnelCloseFailure;
}

/**
 * The `code` on a `connect` rejection. A Capacitor plugin rejects with
 * `call.reject(message, code)` (Android `PluginCall.reject(String, String)`,
 * iOS `CAPPluginCall.reject(_:_:)`), and that code reaches JavaScript on the
 * error.
 *
 * - `CREDENTIAL_MISSING`: `credentialRef` names nothing in the platform store.
 *   A phone restored from a backup does this, because an item kept
 *   this-device-only does not travel. It needs pairing again, which is a
 *   different screen from "cannot reach".
 * - `OPTIONS_REFUSED`: any other refusal listed on {@link TunnelSocketPlugin.connect}.
 *   A bug in the caller, not a fault a person can fix.
 *
 * The message is for a log and never carries the credential.
 */
export type TunnelConnectRejectionCode = 'CREDENTIAL_MISSING' | 'OPTIONS_REFUSED';

/** The plugin's events, by name. */
export interface TunnelSocketEvents {
  readonly tunnelOpen: TunnelOpenEvent;
  readonly tunnelFrame: TunnelFrameEvent;
  readonly tunnelClose: TunnelCloseEvent;
}

export type TunnelSocketEventName = keyof TunnelSocketEvents;

export interface TunnelSocketPlugin {
  /**
   * Start a connection, and answer with its handle.
   *
   * RESOLVES ONCE THE ATTEMPT HAS STARTED, not once it is open. Opening,
   * refusal and failure all arrive as events carrying the handle, and the
   * plugin emits NO EVENT for a connection before this call has resolved, so a
   * caller that registered its listeners first can match every event it hears.
   *
   * Rejects, with no socket made and no event to follow, when the options are
   * refused: an unparseable `url`, a credential somewhere unsafe, a `wss:`
   * credential with no `expectedPeer`, or both credential forms at once
   * (`OPTIONS_REFUSED`); or a `credentialRef` that names nothing
   * (`CREDENTIAL_MISSING`). See {@link TunnelConnectOptions} and
   * {@link TunnelConnectRejectionCode}.
   *
   * A REJECTION IS STILL AN ENDING. Because no event follows it, an adapter
   * from this plugin to the tunnel client's transport must report it as that
   * transport's one close, with its failure, and never leave the client
   * waiting for an event that will not come.
   */
  connect(options: TunnelConnectOptions): Promise<{ readonly connectionId: string }>;

  /**
   * Write one frame: the decoded bytes of `frame`, as one binary message.
   *
   * To a connection that has closed, resolves and writes nothing: its
   * `tunnelClose` has already said so. Rejects for a handle this plugin never
   * issued.
   */
  send(options: { readonly connectionId: string; readonly frame: string }): Promise<void>;

  /**
   * Close a connection, with a close code and reason when given. Idempotent.
   * One `tunnelClose` still follows, and only one.
   */
  close(options: {
    readonly connectionId: string;
    readonly code?: number;
    readonly reason?: string;
  }): Promise<void>;

  /**
   * The peer certificate for an OPEN connection, by its handle.
   *
   * Throws when the handle names no open connection. It must not answer from
   * a cache keyed by host: the whole point is what THIS connection negotiated,
   * and a man-in-the-middle's connection is to the same host as the honest
   * one. #256's binding is only as good as this method's freshness.
   */
  negotiatedPeer(options: { readonly connectionId: string }): Promise<NegotiatedPeerCertificate>;

  addListener(eventName: 'tunnelOpen', listener: (event: TunnelOpenEvent) => void): Promise<ListenerHandle>;
  addListener(eventName: 'tunnelFrame', listener: (event: TunnelFrameEvent) => void): Promise<ListenerHandle>;
  addListener(eventName: 'tunnelClose', listener: (event: TunnelCloseEvent) => void): Promise<ListenerHandle>;
  removeAllListeners(): Promise<void>;
}
