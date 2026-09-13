/**
 * CPace — turning a typed pairing code into a real key (#130).
 *
 * A six-digit code is 10^6 possibilities and a LAN attacker walks that space in
 * seconds, so a scheme that compares the code is only as strong as its rate
 * limiting — and rate limiting is the kind of thing that gets refactored away.
 * A PAKE removes the arithmetic: an attacker gets ONE guess per connection and
 * learns nothing from a failure.
 *
 * CPace is what the CFRG selected for the balanced case (2026-03-20; OPAQUE was
 * the augmented pick). Balanced is the family this needs: the issuer prints a
 * code, the person types the same code, nothing is registered and no verifier
 * is stored. SPAKE2 says in its own abstract that it "was not selected";
 * J-PAKE is shape-correct and ships no test vectors in RFC 8236 or RFC 8235,
 * which for a cryptographic implementation is disqualifying.
 *
 * Suite: **ristretto255 / SHA-512**, `draft-irtf-cfrg-cpace-21`.
 *
 * ## THE API IS THE SECURITY PROPERTY
 *
 * CPace produces a shared key. It does NOT tell you the peer derived the same
 * one, and it does not mandate key confirmation. So this module adds it — and
 * makes it structural rather than documented:
 *
 *     beginExchange()   -> your message. No key.
 *     computeConfirmation(peer message) -> your TAG. Still no key.
 *     finish(peer tag)  -> the session key, or it throws.
 *
 * There is no exported function that returns a session key without a peer tag
 * to compare. That is deliberate and it is the whole shape: the neighbouring
 * wsh repo has three closed issues (#35, #39, #40) of the form "this guard can
 * be deleted and the suite stays green", including AES-GCM nonce reuse passing
 * 443/443. An exported `deriveIsk()` beside an exported `verifyTag()` is that
 * failure waiting for an integrator who calls the first and forgets the second.
 *
 * {@link calculateGenerator} and {@link secretPoint} are exported because the
 * draft's test vectors address them directly. Neither returns a session key,
 * so neither is a way around the above.
 *
 * ## Entropy is a PARAMETER, not a global
 *
 * `y` is supplied by the caller. Three reasons, in order of weight: the test
 * vectors fix it, so a module that generated it internally could not be checked
 * against the draft at all; #223 is open about runtimes nobody has measured and
 * this module then reaches for nothing; and a caller that must pass randomness
 * is a caller that had to think about where it came from.
 *
 * ## What this module does not close
 *
 * A PAKE proves both sides knew the code. It does NOT prove the peer is the
 * far end of your TLS connection. On the QR route the phone holds the
 * certificate fingerprint before it connects (#134 carries it); on the TYPED
 * route it holds six digits and nothing else, so a man-in-the-middle
 * presenting its own certificate runs the exchange with the user undetected.
 *
 * {@link channelIdentifier} is where that is fixed — the peer's SPKI goes into
 * CPace's `CI`, so two sides that negotiated different certificates derive
 * different keys and confirmation fails. #256 owns wiring the SPKI through
 * from the socket plugin. **Until it is wired, the typed route is weaker than
 * the QR route**, and that is a sentence for the UI, not only for this comment.
 */

import { ristretto255, ristretto255_hasher } from '@noble/curves/ed25519.js';
import { hmac } from '@noble/hashes/hmac.js';
import { sha512 } from '@noble/hashes/sha2.js';

/** The suite's domain separators, verbatim from draft-21 §7.3. */
const DSI = 'CPaceRistretto255';
const DSI_ISK = 'CPaceRistretto255_ISK';
/** Ours, not the draft's: CPace does not define key confirmation. */
const DSI_MAC = 'CPaceRistretto255_MAC/chatterang';
const DSI_SESSION = 'CPaceRistretto255_SK/chatterang';

/** SHA-512's input block size, which sets the ZPAD length. */
const HASH_BLOCK_BYTES = 128;

export const SCALAR_BYTES = 32;
export const TAG_BYTES = 32;
export const SESSION_KEY_BYTES = 32;

export type Role = 'initiator' | 'responder';

export class PakeError extends Error {
  override readonly name = 'PakeError';
  constructor(readonly reason: PakeErrorReason) {
    super(`pairing exchange failed: ${reason}`);
  }
}

export type PakeErrorReason =
  /** K was the identity. The draft says MUST abort; noble will not do it for us. */
  | 'degenerate-shared-point'
  /** The peer's message was not a valid ristretto255 encoding. */
  | 'bad-peer-message'
  /** Key confirmation failed: wrong code, or a peer that is not who we reached. */
  | 'confirmation-failed'
  | 'bad-scalar-length'
  /** The SPKI fingerprint was not 32 bytes, so the binding would be wrong. */
  | 'bad-spki-length'
  /** `hostKind` was not a single byte — a desktop and a server must differ. */
  | 'bad-host-kind'
  /** One side contributed nothing to `sid`, which §10.9 forbids. */
  | 'one-sided-sid';

const text = (s: string): Uint8Array => new TextEncoder().encode(s);

function concat(...parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

/**
 * draft-21 §5.1 `prepend_len`, and the reason the whole format is unambiguous.
 *
 * A length prefix on every field means no two different field sets can produce
 * one byte string, which is what stops an attacker moving a byte from the end
 * of the code into the start of the channel identifier.
 */
export function prependLen(b: Uint8Array): Uint8Array {
  let n = b.length;
  const prefix: number[] = [];
  do {
    const v = n & 0x7f;
    n >>>= 7;
    prefix.push(n > 0 ? v | 0x80 : v);
  } while (n > 0);
  return concat(Uint8Array.from(prefix), b);
}

const lvCat = (...parts: readonly Uint8Array[]): Uint8Array => concat(...parts.map(prependLen));

/**
 * draft-21 §5.2 `generator_string`, including ZPAD.
 *
 * ZPAD fills the rest of the first hash block so that a long password cannot
 * shift what follows it into a different block — the draft is explicit that it
 * is there for the hash's internal structure, not for the format.
 */
export function generatorString(
  prs: Uint8Array,
  ci: Uint8Array,
  sid: Uint8Array,
  dsi: string = DSI,
): Uint8Array {
  const d = text(dsi);
  const zpadLen = Math.max(0, HASH_BLOCK_BYTES - (prependLen(d).length + prependLen(prs).length) - 1);
  return concat(prependLen(d), prependLen(prs), prependLen(new Uint8Array(zpadLen)), prependLen(ci), prependLen(sid));
}

/** The per-exchange generator. Exported because §B.3.1 vectors it directly. */
export function calculateGenerator(prs: Uint8Array, ci: Uint8Array, sid: Uint8Array) {
  const gs = generatorString(prs, ci, sid);
  const hash = sha512(gs);
  // The ristretto255 one-way map over 64 uniform bytes — `deriveToCurve`, not
  // `hashToCurve`, which would run expand_message over the input first and
  // produce a different point than the draft's vectors.
  // `deriveToCurve` is optional in noble's hasher type. It is present for
  // ristretto255 and the draft has no alternative construction, so a missing
  // one is a broken dependency rather than a case to fall back from — and a
  // fallback here would silently produce a different generator than the
  // vectors, which is the one failure this whole file is arranged to prevent.
  const derive = ristretto255_hasher.deriveToCurve;
  if (typeof derive !== 'function') {
    throw new Error('@noble/curves: ristretto255_hasher.deriveToCurve is missing; CPace cannot be computed');
  }
  return { generatorString: gs, hash, generator: derive(hash) };
}

/** Little-endian scalar, as the draft writes them, to the bigint noble wants. */
function scalarOf(bytes: Uint8Array): bigint {
  if (bytes.length !== SCALAR_BYTES) throw new PakeError('bad-scalar-length');
  let n = 0n;
  for (let i = bytes.length - 1; i >= 0; i -= 1) n = (n << 8n) | BigInt(bytes[i]!);
  return n;
}

/**
 * `scalar_mult_vfy`: the shared point, with the abort the draft requires.
 *
 * THE ABORT IS OURS TO MAKE, measured rather than assumed:
 * `ristretto255.Point.fromBytes(new Uint8Array(32))` RETURNS a point whose
 * `is0()` is true rather than throwing. So a library that looks like it is
 * validating encodings is not validating this one, and CPace's "MUST abort if
 * K is the identity" would silently not happen.
 *
 * Exported because §B.3.4 and §B.3.11 (the negative vectors) address it. It
 * returns a point, never a key.
 */
export function secretPoint(scalar: Uint8Array, peerEncoded: Uint8Array): Uint8Array {
  let peer;
  try {
    peer = ristretto255.Point.fromBytes(peerEncoded);
  } catch {
    throw new PakeError('bad-peer-message');
  }
  const k = peer.multiply(scalarOf(scalar));
  if (k.is0()) throw new PakeError('degenerate-shared-point');
  return k.toBytes();
}

/** A 32-byte SHA-256 SPKI fingerprint — the same 32 bytes #134's payload carries. */
export const SPKI_BYTES = 32;

/**
 * The channel identifier, and the answer to #256.
 *
 * CPace's `CI` is an application-chosen identity string; the draft's own
 * vectors use `lv_cat(initiator, responder)`. Putting the peer's SPKI in it is
 * what binds the exchange to the TLS connection it ran over: a
 * man-in-the-middle terminates two connections with two certificates, so the
 * two honest parties compute different `CI`, derive different keys, and
 * confirmation fails. The attacker learns nothing about the code from that
 * failure, which is the property the PAKE contributes and a rate limit cannot.
 *
 * ## `spki` IS REQUIRED, AND THAT IS THE CHANGE
 *
 * It used to be optional, "so the draft's test vectors can be reproduced".
 * That is a real need and it was met the wrong way: an optional field that the
 * entire security property depends on is a field a caller omits by accident,
 * and the exchange then succeeds — unbound, silently, with both sides agreeing
 * on a key. #256 exists because the typed route has no binding; a binding that
 * a caller can forget to pass reproduces that defect inside the fix.
 *
 * The vectors are served by {@link unboundChannelIdentifier} instead, which
 * names what it is. Same reasoning as the `done.message` obligation in #260:
 * a requirement that is only a comment is not a requirement.
 *
 * ## What goes in, and what deliberately does not
 *
 * `hostKind` is in, per #256's question about it: a desktop and a headless
 * server are different trust propositions (#249 argues the server end at
 * length), and binding it means one cannot be substituted for the other even
 * if an attacker somehow held the right certificate.
 *
 * The HOST AND PORT are deliberately OUT. They look like free extra binding
 * and they are not: the same legitimate desktop is reachable as a LAN address,
 * as an mDNS name (#222) and over a relay, so binding them breaks pairing
 * whenever the route changes while adding nothing — the SPKI already names the
 * endpoint cryptographically, which an address does not. Written down so it is
 * not re-proposed as an obvious improvement.
 */
export function channelIdentifier(parts: {
  readonly initiator: Uint8Array | string;
  readonly responder: Uint8Array | string;
  readonly hostKind: number;
  readonly spki: Uint8Array;
}): Uint8Array {
  if (parts.spki.length !== SPKI_BYTES) throw new PakeError('bad-spki-length');
  if (!Number.isInteger(parts.hostKind) || parts.hostKind < 1 || parts.hostKind > 255) {
    throw new PakeError('bad-host-kind');
  }
  const as = (v: Uint8Array | string) => (typeof v === 'string' ? text(v) : v);
  return lvCat(as(parts.initiator), as(parts.responder), Uint8Array.of(parts.hostKind), parts.spki);
}

/**
 * The draft's own two-field `CI`, for reproducing its test vectors.
 *
 * Named so that reading a call site tells you the exchange is UNBOUND. Nothing
 * in the app may call this: an unbound exchange is exactly the weakness #256
 * was filed about, and `tests/tunnel-pake.test.ts` asserts no production
 * module calls it.
 */
export function unboundChannelIdentifier(parts: {
  readonly initiator: Uint8Array | string;
  readonly responder: Uint8Array | string;
}): Uint8Array {
  const as = (v: Uint8Array | string) => (typeof v === 'string' ? text(v) : v);
  return lvCat(as(parts.initiator), as(parts.responder));
}

/**
 * `sid` from BOTH parties, which draft §10.9 requires and #130's ruling repeats.
 *
 * An issuer-chosen `sid` lets one side replay a transcript at the other, so
 * the draft suggests each side contribute an ephemeral random string. Taking
 * two arguments is how that stops being advice: there is no way to build a
 * `sid` here from one party's bytes alone, so the requirement is the type
 * rather than a sentence someone has to have read.
 *
 * Order is fixed by ROLE, not by arrival, so both sides compute the same bytes
 * without negotiating who went first.
 */
export function sessionIdentifier(parts: {
  readonly initiatorNonce: Uint8Array;
  readonly responderNonce: Uint8Array;
}): Uint8Array {
  if (parts.initiatorNonce.length === 0 || parts.responderNonce.length === 0) {
    throw new PakeError('one-sided-sid');
  }
  return lvCat(parts.initiatorNonce, parts.responderNonce);
}

/** draft-21 §5.4 `transcript_ir` — ordered, for initiator/responder mode. */
function transcriptIr(ya: Uint8Array, ada: Uint8Array, yb: Uint8Array, adb: Uint8Array): Uint8Array {
  return lvCat(ya, ada, yb, adb);
}

/** §5.5: the ISK. Internal — the only caller is {@link computeConfirmation}. */
function deriveIsk(sid: Uint8Array, k: Uint8Array, transcript: Uint8Array): Uint8Array {
  return sha512(concat(lvCat(text(DSI_ISK), sid, k), transcript));
}

/** Constant-time compare. A tag check that short-circuits is a timing oracle. */
function equalCt(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

/* ── the three-step exchange ─────────────────────────────────────────── */

export interface PendingExchange {
  readonly role: Role;
  readonly scalar: Uint8Array;
  readonly message: Uint8Array;
  readonly ad: Uint8Array;
  readonly sid: Uint8Array;
}

export interface ConfirmingExchange {
  /** The tag to SEND. The session key is not in here. */
  readonly tag: Uint8Array;
  readonly expected: Uint8Array;
  readonly sessionKey: Uint8Array;
}

/**
 * Step one: our public share. Returns no key and cannot.
 *
 * `sid` must come from BOTH parties — draft §10.9 suggests concatenating
 * ephemeral random strings each side contributes. An issuer-chosen `sid` lets
 * the issuer replay a transcript.
 */
export function beginExchange(opts: {
  readonly role: Role;
  readonly code: Uint8Array | string;
  readonly ci: Uint8Array;
  readonly sid: Uint8Array;
  /** 32 bytes of entropy. See the module header on why this is a parameter. */
  readonly scalar: Uint8Array;
  readonly ad?: Uint8Array;
}): { readonly message: Uint8Array; readonly pending: PendingExchange } {
  const prs = typeof opts.code === 'string' ? text(opts.code) : opts.code;
  const { generator } = calculateGenerator(prs, opts.ci, opts.sid);
  const message = generator.multiply(scalarOf(opts.scalar)).toBytes();
  return {
    message,
    pending: {
      role: opts.role,
      scalar: opts.scalar,
      message,
      ad: opts.ad ?? new Uint8Array(0),
      sid: opts.sid,
    },
  };
}

/**
 * Step two: the confirmation tag to send. STILL NO KEY.
 *
 * The identity abort happens here, inside, where it cannot be forgotten.
 */
export function computeConfirmation(
  pending: PendingExchange,
  peerMessage: Uint8Array,
  peerAd: Uint8Array = new Uint8Array(0),
): ConfirmingExchange {
  const k = secretPoint(pending.scalar, peerMessage);

  const transcript =
    pending.role === 'initiator'
      ? transcriptIr(pending.message, pending.ad, peerMessage, peerAd)
      : transcriptIr(peerMessage, peerAd, pending.message, pending.ad);

  const isk = deriveIsk(pending.sid, k, transcript);
  const macKey = sha512(lvCat(text(DSI_MAC), isk)).slice(0, 32);
  const tagFor = (role: Role) => hmac(sha512, macKey, concat(text(role), transcript)).slice(0, TAG_BYTES);

  return {
    tag: tagFor(pending.role),
    expected: tagFor(pending.role === 'initiator' ? 'responder' : 'initiator'),
    sessionKey: sha512(lvCat(text(DSI_SESSION), isk)).slice(0, SESSION_KEY_BYTES),
  };
}

/**
 * Step three, and the ONLY way to a session key.
 *
 * Throws on a bad tag rather than returning a flag. A boolean return is a
 * boolean somebody does not check, and the whole reason this module has three
 * steps instead of one is to make the unchecked path unwritable.
 */
export function finish(confirming: ConfirmingExchange, peerTag: Uint8Array): Uint8Array {
  if (!equalCt(confirming.expected, peerTag)) throw new PakeError('confirmation-failed');
  return confirming.sessionKey;
}
