/**
 * THE TWO THINGS A SERVER BINDING AND A TUNNEL BINDING SHARE, AND NOTHING ELSE.
 *
 * `apps/server/src/binding.ts` wrote these first, and they moved here so both
 * unions can hold the SAME brand (#135, #158). A `unique symbol` brand is only
 * a brand once: two copies of `TlsMaterial`, one per file, are two unrelated
 * types, so material the server read from disk would not be accepted by the
 * tunnel and the obvious fix — a cast — is the hole the brand exists to close.
 * `binding.ts` re-exports all three, and the server's behaviour is unchanged.
 *
 * WHAT DID NOT MOVE, and must not follow: the operator token (`AuthToken`) and
 * the browser-cookie helpers. #135's ruling keeps them out of the tunnel — a
 * paired phone authenticates with a device credential (`./credential.ts`), and
 * the operator token is one person reaching their own machine, not a phone.
 *
 * THIS FILE IMPORTS NOTHING, which is what lets the server re-export it without
 * its binding growing a dependency on anything the tunnel's listener needs.
 */

/**
 * The loopback address, as a literal that appears exactly once.
 *
 * `localhost` would be wrong: it resolves through the host's name service and
 * can answer `::1`, a LAN address, or whatever a hosts file says. The point of
 * a loopback arm is an address no other machine can route to, so it is the
 * address rather than a name for it.
 */
export const LOOPBACK_HOST = '127.0.0.1';

declare const TLS_BRAND: unique symbol;

/** A key and certificate, read from disk and non-empty. */
export interface TlsMaterial {
  readonly [TLS_BRAND]: true;
  readonly key: string;
  readonly cert: string;
}

/**
 * Wrap key/cert bytes as {@link TlsMaterial}.
 *
 * Both must be non-empty. An empty file is the shape a half-finished
 * certificate setup takes, and a server that started with one would be
 * advertising https while failing every handshake — which an operator reads as
 * "the network is broken", not as "there is no certificate".
 *
 * The message still names the server, verbatim, because the server is the one
 * caller that reads material an operator supplied, and its tests and its
 * operators already know this sentence.
 */
export function asTlsMaterial(key: string, cert: string): TlsMaterial {
  if (key.trim() === '' || cert.trim() === '') {
    throw new Error(
      'chatterang server: the TLS key and certificate must both be non-empty. ' +
        'Binding beyond loopback requires real material, not a placeholder.',
    );
  }
  return { key, cert } as TlsMaterial;
}
