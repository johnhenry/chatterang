/**
 * The native socket plugin's contract, as far as PAIRING needs it (#181, #256).
 *
 * #181 ruled the transport is a native socket plugin terminating pinned TLS,
 * on both platforms, one transport rather than two. This declares only the
 * part #256 blocks on: **`src/` cannot see a certificate.** The plugin does —
 * it performed the handshake — and the channel binding is worthless unless
 * that value crosses the bridge.
 *
 * Deliberately NOT the whole socket API. #158 gives the listener one
 * implementation and two callers, and the connect/send/close surface belongs
 * with that work. What is here is the one method whose absence makes #256
 * unimplementable, declared where all three implementations can see it:
 * the web shim, the native bridges, and the Node backend.
 */

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

export interface TunnelSocketPlugin {
  /**
   * The peer certificate for an OPEN connection, by its handle.
   *
   * Throws when the handle names no open connection. It must not answer from
   * a cache keyed by host: the whole point is what THIS connection negotiated,
   * and a man-in-the-middle's connection is to the same host as the honest
   * one. #256's binding is only as good as this method's freshness.
   */
  negotiatedPeer(options: { readonly connectionId: string }): Promise<NegotiatedPeerCertificate>;
}
