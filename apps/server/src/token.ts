/**
 * The operator token: made once, kept 0600, compared in constant time.
 *
 * WHAT IT IS FOR. It is the only thing between a peer and this machine's GPU,
 * model directory and inference hosts. It is NOT an API key and must not be
 * confused with one: no provider credential ever enters this process (see
 * `apps/server/src/index.ts`), so there is exactly one secret here and it is
 * the server's own.
 *
 * DELIVERY IS THE HARD PART, AND THE ANSWER IS A ONE-TIME QUERY.
 * `?token=…` in a URL is a bad place for a secret to LIVE — it lands in
 * history, in the Referer header of every outbound link, and in any log that
 * records request lines. But it is the only channel a browser gives an
 * operator who has just been printed a string on a terminal. So it is accepted
 * exactly once, on any GET that carries it: the response sets an HttpOnly,
 * Secure, SameSite=Strict cookie and 303s to the same path with the query
 * stripped, and every later request authenticates with the cookie. The token
 * appears in exactly one request line and then never again.
 *
 * WHY THE COMPARISON HASHES FIRST. `timingSafeEqual` throws on
 * length-mismatched buffers, so the obvious guard — compare lengths, then
 * compare bytes — leaks the length through the early return. Hashing both
 * sides to a fixed 32 bytes first means every comparison takes the same shape
 * whatever was sent, and `===` on strings (which short-circuits on the first
 * differing byte) never touches the secret at all.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';

import { asAuthToken } from './binding.js';
import type { AuthToken } from './binding.js';

/** 32 bytes of CSPRNG output, base64url — 256 bits, no padding, URL-safe. */
export function generateToken(): AuthToken {
  return asAuthToken(randomBytes(32).toString('base64url'));
}

/**
 * The token for this data root, created on first use.
 *
 * MODE 0600 ON BOTH PATHS, and the second one is the one that gets forgotten:
 * a file written by an earlier run with a wide umask stays wide, so the mode
 * is asserted on read as well as set on write. A credential readable by every
 * account on the machine is not a credential on a machine with more than one
 * account — which is exactly the machine someone runs a server on.
 *
 * @returns the token, and whether this call is what created it. The caller
 *   prints it only when it is new: printing it every start puts the secret in
 *   the scrollback of every terminal the operator has ever used.
 */
export function readOrCreateToken(path: string): { token: AuthToken; created: boolean } {
  if (existsSync(path)) {
    const value = readFileSync(path, 'utf8').trim();
    chmodSync(path, 0o600);
    return { token: asAuthToken(value), created: false };
  }
  const token = generateToken();
  // `mode` on the open, not a chmod after: between a world-readable create and
  // a chmod there is a window in which the secret is readable, and it is the
  // window in which the secret is most interesting.
  writeFileSync(path, `${token.value}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return { token, created: true };
}

/** SHA-256 of a string, as bytes. Fixed width whatever went in. */
function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

/**
 * Is `presented` the token?
 *
 * Constant time with respect to the secret. Returns false for an empty or
 * absent presentation without a special case, because the digest of `''` is
 * simply not the digest of the token.
 */
export function tokenMatches(token: AuthToken, presented: string | undefined): boolean {
  if (presented === undefined) return false;
  return timingSafeEqual(digest(token.value), digest(presented));
}
