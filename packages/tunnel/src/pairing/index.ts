/**
 * THE PAIRING PAYLOAD: what the QR actually carries (#134).
 *
 * The plan's load-bearing decision is that the code carries the host's ADDRESS,
 * so mDNS is not a dependency for v1. That moves discovery into this payload
 * and makes its contents a design decision rather than an implementation
 * detail — which is why it is written down here, in one file, with a parser
 * that refuses anything it does not fully understand.
 *
 * ## Where this sits, and why it imports nothing
 *
 * A fifth half of the package, under the same rule as `wire/`: NOTHING is
 * imported, not a DOM type, not a Node builtin, not a utility. Both ends load
 * it — the phone parses, the host encodes — so anything it imports is imported
 * by both.
 *
 * It goes further than `wire/` in one way that is deliberate: it uses no
 * global either. No `btoa`, no `Buffer`, no `TextEncoder`, no `crypto`. Base64
 * and UTF-8 are implemented below. That is not purity for its own sake —
 * #223 is an open ticket about the app supporting runtimes nobody has
 * measured, and this is the ONE component that has to work on all of them.
 * A parser that needs a modern global fails on exactly the old phone whose
 * user is trying to pair it, at the moment they are trying.
 *
 * ## The format
 *
 *     chatterang-pair:<base64url of the binary payload below>
 *
 * A URI, because it gives the version a natural home and a natural failure
 * mode — an old app opens it and does not understand it — without a second
 * mechanism. A fixed-order BINARY payload inside it, because JSON's key names
 * cost bytes for nothing and JSON has no canonical form.
 *
 *     offset  size  field
 *     0       1     version, currently 1
 *     1       1     hostKind: 1 = desktop, 2 = headless server
 *     2       1     trustMode: 1 = spki-pin, 2 = static-key-agreement
 *     3       32    trust — opaque, meaning named by trustMode
 *     35      32    token — single-use, spent by #129
 *     67      4     expiresAt, seconds since the Unix epoch, big-endian
 *     71      2     port, big-endian
 *     73      1     addressCount, 1..8
 *     74      ...   addresses: [kind][length][bytes] each
 *     ...     1     nameLength, 1..64
 *     ...     ...   name, UTF-8
 *
 * Trailing bytes are an ERROR, not something to ignore. A parser that accepts
 * them accepts two payloads that differ, which is the property a canonical
 * encoding exists to deny.
 *
 * ## THREE THINGS THE TICKET ASKED FOR THAT THIS DELIBERATELY DOES NOT DO
 *
 * Each is a change to #134's stated Done, and each is argued rather than
 * quietly dropped. Overrule any of them and the format has room.
 *
 * **1. No signature.** #134 says "the signature covers the whole payload
 * including the version". A signature is verifiable only against a key the
 * verifier already trusts, and at first pairing the phone trusts NOTHING —
 * this payload IS the trust anchor. A self-signature therefore proves only
 * that whoever composed the payload held a private key for a key in the same
 * payload, which an attacker composing their own payload satisfies exactly as
 * well. It would buy integrity that the QR's own error correction already
 * provides, cost 64 bytes of a budget with two consumers, and drag Ed25519
 * verification — #223's unmeasured runtime floor — into the one component that
 * must work everywhere.
 *
 * The one case where it would buy something is RE-pairing a host whose key the
 * phone already knows. That case is worse with it than without: a revoked
 * device must not be able to re-establish itself by presenting continuity with
 * the key it was revoked under, and #131 is explicit that revocation leaves
 * nothing behind.
 *
 * **2. No key algorithm, and therefore no runtime floor here.** #134's Done
 * asks for "Ed25519, plus the feature detection and the stated behaviour below
 * the floor". Once the payload carries no signature, it carries no key whose
 * algorithm a parser must know: {@link PairingPayload.trust} is 32 OPAQUE
 * bytes whose meaning is named by `trustMode`, and under #181's ruling — a
 * native socket plugin with a pinned certificate — those bytes are an SPKI
 * fingerprint rather than a public key at all.
 *
 * So the algorithm decision has not been skipped; it has moved to where the
 * material is actually generated: #179 for the certificate that gets
 * fingerprinted, #125 for device identity, #223 for the floor both sit on.
 * This file having no opinion is what lets it be the component with no floor.
 *
 * **3. No default `trustMode`.** #154 owns that byte and #181 explicitly
 * declined to force it. An encoder must state it; the parser refuses a value
 * it does not know. "No default" is itself the safe answer: a default is what
 * lets a payload mean something its author did not choose.
 *
 * ## What the #176 measurement settled, so it is not rediscovered
 *
 * The address field holds literal addresses and DNS names — NOT a WebRTC
 * offer. An iOS-generated offer contains no address at all, only
 * mDNS-obfuscated `.local` names, which is the discovery mechanism the
 * carries-the-address decision exists to avoid. Measured: 458 bytes of offer
 * SDP on both platforms, so size was never the obstacle.
 *
 * **Whether the address field may hold a `.local` name** — the one-line answer
 * #134 asks for, for #222 and #165 to point at: the GRAMMAR admits it, because
 * it is syntactically a DNS name and a parser that special-cased one suffix
 * would be lying about what it accepts. The TRANSPORT does not support it in
 * v1: nothing resolves multicast DNS, so a payload carrying only a `.local`
 * name pairs and then fails to connect. Those are different statements and
 * both are true. {@link isMulticastDnsName} exists so a caller can warn at
 * encode time rather than leaving the user to discover it at connect time.
 *
 * ## What server pairing added (#124, ruled 2026-09-11)
 *
 * The headless server pairs in v1, and three things follow:
 *
 *   - {@link PairingPayload.hostKind}. NEW, and not in #134's field list. The
 *     phone has to know what it paired with: #251 records that `reachPaired()`
 *     reports `paired` for a host that may be someone else's machine, and
 *     #221's candidate privacy copy says "your own desktop". Neither can be
 *     answered without this byte, and it cannot be inferred later.
 *   - The payload is MINTED BY THE PROCESS THAT WILL ANSWER THE SOCKET, never
 *     composed by whatever displays it. On the headless profile those are
 *     different machines: a browser reached through an SSH forward or a
 *     reverse proxy would write `127.0.0.1` into a code a phone will dial.
 *     This file cannot enforce that; it is stated because it is the rule.
 *   - A second size budget. See {@link MAX_PAIRING_URI_LENGTH}.
 */

/** The URI scheme. A custom scheme so an old app fails visibly, not silently. */
export const PAIRING_SCHEME = 'chatterang-pair';

/** The only version this parser understands. */
export const PAIRING_VERSION = 1;

/**
 * What kind of host drew this code.
 *
 * Not cosmetic, and not inferable from the address: a desktop and a server can
 * both be at `192.168.1.4`. See the module header — #251 and #221 both need
 * the phone to know which it paired with, and pair time is the only moment the
 * information exists.
 */
export const HOST_DESKTOP = 1;
export const HOST_SERVER = 2;
export type HostKind = typeof HOST_DESKTOP | typeof HOST_SERVER;

/**
 * What the 32 trust bytes mean. #154 owns the enumeration; this is its shape.
 *
 * Under #181's ruling v1 uses {@link TRUST_SPKI_PIN}. `TRUST_STATIC_KEY` is
 * kept because #154's re-scope established both surviving options wanted 32
 * bytes in the same position, and deleting the arm would make the byte
 * pointless — a one-value enumeration is a constant with extra steps.
 */
export const TRUST_SPKI_PIN = 1;
export const TRUST_STATIC_KEY = 2;
export type TrustMode = typeof TRUST_SPKI_PIN | typeof TRUST_STATIC_KEY;

export const ADDRESS_IPV4 = 1;
export const ADDRESS_IPV6 = 2;
export const ADDRESS_DNS = 3;
export type AddressKind = typeof ADDRESS_IPV4 | typeof ADDRESS_IPV6 | typeof ADDRESS_DNS;

export interface PairingAddress {
  readonly kind: AddressKind;
  /**
   * Four bytes for v4, sixteen for v6, 1..255 ASCII bytes for a DNS name.
   *
   * Bytes rather than a string even for DNS, so the encoder and the parser
   * agree byte for byte and no normalisation happens between them.
   */
  readonly value: Uint8Array;
}

export interface PairingPayload {
  readonly version: number;
  readonly hostKind: HostKind;
  readonly trustMode: TrustMode;
  /** 32 opaque bytes. See the module header: no algorithm lives here. */
  readonly trust: Uint8Array;
  /** 32 bytes, single-use. Spending it exactly once is #129. */
  readonly token: Uint8Array;
  /**
   * ABSOLUTE, seconds since the Unix epoch.
   *
   * Absolute rather than a duration so the phone refuses a stale code without
   * needing to know when it was drawn — it needs only to know what time it is,
   * which is a much weaker assumption than agreeing a clock with the host.
   */
  readonly expiresAt: number;
  readonly port: number;
  /**
   * Every address the host believes it might be reachable at, most-preferred
   * first.
   *
   * ALL OF THEM, which #134 left open. A headless server cannot know which of
   * its interfaces the phone can reach — #252 records that it cannot even
   * enumerate them yet — so offering one and being wrong costs a failed
   * pairing, while offering several costs a network-topology leak to whoever
   * photographs a code that expires in ninety seconds. The second is smaller.
   */
  readonly addresses: readonly PairingAddress[];
  /** Human-readable, so the phone can say "Pair with John's MacBook?" */
  readonly name: string;
}

/** Bounds, all enforced by the parser rather than left to the encoder. */
export const MAX_ADDRESSES = 8;
export const MAX_NAME_BYTES = 64;
export const TRUST_BYTES = 32;
export const TOKEN_BYTES = 32;

/**
 * The hard cap on the whole URI, in characters.
 *
 * TWO CONSUMERS NOW, and the second one is tighter and differently shaped.
 *
 * #134 budgeted against "a mid-size QR at error-correction level M … scannable
 * on a laptop screen at arm's length". Server pairing added a terminal: a
 * headless host draws its code in Unicode half-blocks over SSH, where the
 * constraint is COLUMNS. A QR of version V is `4V + 17` modules square and
 * wants a 4-module quiet zone each side, so an 80-column terminal fits version
 * 13 (69 + 8 = 77 columns) and no more.
 *
 * DERIVED, THEN MEASURED AGAINST THE FRAME #127 DRAWS — and the measurement
 * moved the edge. 300 characters was chosen against the byte-mode capacity of a
 * version-13 code at level M with margin, from the module arithmetic above,
 * for a QR holding the URI alone. #127's ruling draws the URI as an OAT frame
 * instead (`src/lib/pairing-frames.ts`), which adds a 34-byte header, and
 * `tests/pairing-frames.test.ts` draws payloads built with this encoder, reads
 * the pixels back through the phone's decoder, and pins the version of each:
 *
 *     payload                                     URI   frame   QR at M
 *     desktop, one IPv4, short name               130    164    v9
 *     desktop, three addresses, 64-byte name      258    292    v13
 *     server, four addresses incl. DNS, 64 bytes  291    325    v13
 *     server, five addresses, 57-byte name        296    330    v13
 *     server, five addresses, 60-byte name        300    334    v14
 *
 * So the derivation holds up to 296 characters and NOT for the three longer
 * URIs this cap admits: 298, 299 and 300 characters draw at version 14, which
 * with the quiet zone above is 73 + 8 = 81 columns and does not fit 80. The cap
 * is deliberately left at 300. The largest realistic payload measured is 291
 * characters; whether to lower the cap to 296 belongs with the terminal
 * renderer (#124), not to a change that only measured it. Nothing has been
 * scanned by a camera yet — that is still #127's screen.
 */
export const MAX_PAIRING_URI_LENGTH = 300;

/** Everything that can be wrong with a payload, named rather than numbered. */
export type PairingError =
  | 'not-a-pairing-uri'
  | 'bad-base64'
  | 'unknown-version'
  | 'truncated'
  | 'trailing-bytes'
  | 'unknown-host-kind'
  | 'unknown-trust-mode'
  | 'unknown-address-kind'
  | 'bad-address-length'
  | 'no-addresses'
  | 'too-many-addresses'
  | 'bad-name'
  | 'too-long';

export class PairingParseError extends Error {
  override readonly name = 'PairingParseError';
  constructor(readonly reason: PairingError) {
    super(`pairing code rejected: ${reason}`);
  }
}

/* ── base64url and UTF-8, by hand ─────────────────────────────────────── */

/*
 * BY HAND, and the module header says why: this file uses no global, because
 * it is the one component that has to work on the runtimes #223 says nobody
 * has measured. `btoa` is a global that exists everywhere it needs to today —
 * and "today" is exactly the assumption #223 exists to question.
 *
 * base64URL: `-` and `_` for the last two, and NO padding. Padding in a QR is
 * two wasted modules and a second way to spell the same payload.
 */
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

function toBase64Url(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!;
    const b = bytes[i + 1];
    const c = bytes[i + 2];
    out += ALPHABET[a >> 2]!;
    out += ALPHABET[((a & 0x03) << 4) | ((b ?? 0) >> 4)]!;
    if (b === undefined) break;
    out += ALPHABET[((b & 0x0f) << 2) | ((c ?? 0) >> 6)]!;
    if (c === undefined) break;
    out += ALPHABET[c & 0x3f]!;
  }
  return out;
}

function fromBase64Url(text: string): Uint8Array {
  // A reverse table built once. A `indexOf` per character is O(n·64) and this
  // runs on the oldest phone in the fleet.
  const values: number[] = [];
  for (let i = 0; i < text.length; i += 1) {
    const value = ALPHABET.indexOf(text[i]!);
    // Rejected rather than skipped. A decoder that ignores a stray character
    // accepts a payload the encoder never produced, which is the same defect
    // as accepting trailing bytes.
    if (value < 0) throw new PairingParseError('bad-base64');
    values.push(value);
  }
  // 1 leftover character cannot encode any whole byte, so it is malformed
  // rather than empty.
  if (values.length % 4 === 1) throw new PairingParseError('bad-base64');

  const out = new Uint8Array(Math.floor((values.length * 6) / 8));
  let at = 0;
  for (let i = 0; i < values.length; i += 4) {
    const [a, b, c, d] = [values[i]!, values[i + 1], values[i + 2], values[i + 3]];
    if (b === undefined) break;
    out[at++] = ((a << 2) | (b >> 4)) & 0xff;
    if (c === undefined) break;
    out[at++] = ((b << 4) | (c >> 2)) & 0xff;
    if (d === undefined) break;
    out[at++] = ((c << 6) | d) & 0xff;
  }
  return out;
}

/** UTF-8 encode. Surrogate pairs handled; a lone surrogate becomes U+FFFD. */
function toUtf8(text: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < text.length; i += 1) {
    let code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const low = text.charCodeAt(i + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (low - 0xdc00);
        i += 1;
      } else {
        code = 0xfffd;
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      code = 0xfffd;
    }

    if (code < 0x80) out.push(code);
    else if (code < 0x800) out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    else if (code < 0x10000)
      out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    else
      out.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      );
  }
  return new Uint8Array(out);
}

/** UTF-8 decode. Malformed input is an ERROR, not a replacement character. */
function fromUtf8(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  while (i < bytes.length) {
    const a = bytes[i]!;
    let code: number;
    let length: number;
    if (a < 0x80) [code, length] = [a, 1];
    else if ((a & 0xe0) === 0xc0) [code, length] = [a & 0x1f, 2];
    else if ((a & 0xf0) === 0xe0) [code, length] = [a & 0x0f, 3];
    else if ((a & 0xf8) === 0xf0) [code, length] = [a & 0x07, 4];
    else throw new PairingParseError('bad-name');

    if (i + length > bytes.length) throw new PairingParseError('bad-name');
    for (let k = 1; k < length; k += 1) {
      const next = bytes[i + k]!;
      if ((next & 0xc0) !== 0x80) throw new PairingParseError('bad-name');
      code = (code << 6) | (next & 0x3f);
    }
    // Overlong encodings and surrogates rejected: both are ways to spell one
    // string two ways, which a canonical format cannot have.
    const minimum = [0, 0, 0x80, 0x800, 0x10000][length]!;
    if (code < minimum || (code >= 0xd800 && code <= 0xdfff) || code > 0x10ffff) {
      throw new PairingParseError('bad-name');
    }

    if (code < 0x10000) out += String.fromCharCode(code);
    else {
      const v = code - 0x10000;
      out += String.fromCharCode(0xd800 + (v >> 10), 0xdc00 + (v & 0x3ff));
    }
    i += length;
  }
  return out;
}

/* ── the codec ────────────────────────────────────────────────────────── */

function addressLengthFor(kind: AddressKind, length: number): boolean {
  if (kind === ADDRESS_IPV4) return length === 4;
  if (kind === ADDRESS_IPV6) return length === 16;
  return length >= 1 && length <= 255;
}

/**
 * Encode a payload to its URI form.
 *
 * Throws on anything the parser would reject, so a host cannot draw a code
 * nothing can read. The bound checks are here AND in the parser deliberately:
 * an encoder that trusted its caller would put the failure on the phone, at
 * the moment someone is standing in front of a screen trying to scan.
 */
export function encodePairingUri(payload: PairingPayload): string {
  if (payload.version !== PAIRING_VERSION) throw new PairingParseError('unknown-version');
  if (payload.hostKind !== HOST_DESKTOP && payload.hostKind !== HOST_SERVER) {
    throw new PairingParseError('unknown-host-kind');
  }
  if (payload.trustMode !== TRUST_SPKI_PIN && payload.trustMode !== TRUST_STATIC_KEY) {
    throw new PairingParseError('unknown-trust-mode');
  }
  if (payload.trust.length !== TRUST_BYTES || payload.token.length !== TOKEN_BYTES) {
    throw new PairingParseError('truncated');
  }
  if (payload.addresses.length === 0) throw new PairingParseError('no-addresses');
  if (payload.addresses.length > MAX_ADDRESSES) throw new PairingParseError('too-many-addresses');

  const name = toUtf8(payload.name);
  if (name.length === 0 || name.length > MAX_NAME_BYTES) throw new PairingParseError('bad-name');

  const bytes: number[] = [payload.version, payload.hostKind, payload.trustMode];
  bytes.push(...payload.trust, ...payload.token);
  // Unsigned 32-bit seconds: valid until 2106, and four bytes rather than
  // eight because a pairing code that expires in ninety seconds has no use
  // for millisecond precision.
  const expiry = Math.floor(payload.expiresAt);
  if (!Number.isFinite(expiry) || expiry < 0 || expiry > 0xffffffff) {
    throw new PairingParseError('truncated');
  }
  bytes.push((expiry >>> 24) & 0xff, (expiry >>> 16) & 0xff, (expiry >>> 8) & 0xff, expiry & 0xff);

  if (!Number.isInteger(payload.port) || payload.port < 1 || payload.port > 0xffff) {
    throw new PairingParseError('truncated');
  }
  bytes.push((payload.port >> 8) & 0xff, payload.port & 0xff);

  bytes.push(payload.addresses.length);
  for (const address of payload.addresses) {
    if (
      address.kind !== ADDRESS_IPV4 &&
      address.kind !== ADDRESS_IPV6 &&
      address.kind !== ADDRESS_DNS
    ) {
      throw new PairingParseError('unknown-address-kind');
    }
    if (!addressLengthFor(address.kind, address.value.length)) {
      throw new PairingParseError('bad-address-length');
    }
    bytes.push(address.kind, address.value.length, ...address.value);
  }

  bytes.push(name.length, ...name);

  const uri = `${PAIRING_SCHEME}:${toBase64Url(new Uint8Array(bytes))}`;
  // The budget is enforced where a code is MADE, so a host cannot draw one the
  // scanner cannot read. See MAX_PAIRING_URI_LENGTH for what it is derived
  // from and what it is not.
  if (uri.length > MAX_PAIRING_URI_LENGTH) throw new PairingParseError('too-long');
  return uri;
}

/**
 * Parse a URI back to a payload, refusing anything not fully understood.
 *
 * Every refusal is named. A parser that throws one error for everything makes
 * "this code is from a newer version" indistinguishable from "your camera
 * misread it", and those want different things from the person holding the
 * phone.
 */
export function decodePairingUri(uri: string): PairingPayload {
  if (uri.length > MAX_PAIRING_URI_LENGTH) throw new PairingParseError('too-long');
  const prefix = `${PAIRING_SCHEME}:`;
  if (!uri.startsWith(prefix)) throw new PairingParseError('not-a-pairing-uri');

  const bytes = fromBase64Url(uri.slice(prefix.length));
  let at = 0;
  const take = (count: number): Uint8Array => {
    if (at + count > bytes.length) throw new PairingParseError('truncated');
    const slice = bytes.slice(at, at + count);
    at += count;
    return slice;
  };
  const byte = (): number => take(1)[0]!;

  const version = byte();
  // FIRST, and before anything else is interpreted. A future payload may
  // reorder every field after this byte; reading further to produce a better
  // message would be reading a format this code does not know.
  if (version !== PAIRING_VERSION) throw new PairingParseError('unknown-version');

  const hostKind = byte();
  if (hostKind !== HOST_DESKTOP && hostKind !== HOST_SERVER) {
    throw new PairingParseError('unknown-host-kind');
  }
  const trustMode = byte();
  if (trustMode !== TRUST_SPKI_PIN && trustMode !== TRUST_STATIC_KEY) {
    throw new PairingParseError('unknown-trust-mode');
  }

  const trust = take(TRUST_BYTES);
  const token = take(TOKEN_BYTES);
  const expiryBytes = take(4);
  const expiresAt =
    expiryBytes[0]! * 0x1000000 + (expiryBytes[1]! << 16) + (expiryBytes[2]! << 8) + expiryBytes[3]!;
  const portBytes = take(2);
  const port = (portBytes[0]! << 8) | portBytes[1]!;

  const addressCount = byte();
  if (addressCount === 0) throw new PairingParseError('no-addresses');
  if (addressCount > MAX_ADDRESSES) throw new PairingParseError('too-many-addresses');

  const addresses: PairingAddress[] = [];
  for (let i = 0; i < addressCount; i += 1) {
    const kind = byte();
    if (kind !== ADDRESS_IPV4 && kind !== ADDRESS_IPV6 && kind !== ADDRESS_DNS) {
      throw new PairingParseError('unknown-address-kind');
    }
    const length = byte();
    if (!addressLengthFor(kind, length)) throw new PairingParseError('bad-address-length');
    addresses.push({ kind, value: take(length) });
  }

  const nameLength = byte();
  if (nameLength === 0 || nameLength > MAX_NAME_BYTES) throw new PairingParseError('bad-name');
  const name = fromUtf8(take(nameLength));

  // TRAILING BYTES ARE AN ERROR. Accepting them accepts two byte strings that
  // decode to one payload, which is exactly what a canonical encoding denies —
  // and it is how a field appended by a newer version gets silently discarded
  // by an older parser that should have refused the whole code.
  if (at !== bytes.length) throw new PairingParseError('trailing-bytes');

  return { version, hostKind, trustMode, trust, token, expiresAt, port, addresses, name };
}

/**
 * Has this code expired, as of `nowSeconds`?
 *
 * Separate from parsing on purpose. A parser that consulted a clock could not
 * be tested without one, and "the code is stale" is a different answer for the
 * user than "the code is malformed" — the first says try again, the second
 * says something is wrong.
 */
export function isExpired(payload: PairingPayload, nowSeconds: number): boolean {
  return nowSeconds >= payload.expiresAt;
}

/**
 * Is this a multicast-DNS name — the case v1 parses and cannot connect to?
 *
 * The one-line answer #134 asks for, as a function so a host can warn while
 * DRAWING the code rather than leaving the user to discover it at connect
 * time. See the module header: the grammar admits `.local` because it is a DNS
 * name; the transport does not resolve it. #222 owns iOS emitting nothing else,
 * #166 owns the deferral that assumed it would not come up.
 */
export function isMulticastDnsName(address: PairingAddress): boolean {
  if (address.kind !== ADDRESS_DNS) return false;
  let name = '';
  for (const code of address.value) name += String.fromCharCode(code);
  return name.toLowerCase().endsWith('.local');
}

/* The single-use window (#129), re-exported so `/pairing` is one entry point. */
export * from './window.js';

/* The typed route's grammar (#130), re-exported for the same reason. */
export * from './typed.js';
