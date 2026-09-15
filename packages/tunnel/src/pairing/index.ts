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
   *
   * When they do not all fit {@link MAX_PAIRING_URI_LENGTH},
   * {@link fitPairingPayload} decides which are carried, and in what order
   * (ruled on #127).
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
 * The hard cap on the whole URI, in characters: 296, RULED BY THE OWNER (#127).
 *
 * TWO CONSUMERS, and the second one is tighter and differently shaped.
 *
 * #134 budgeted against "a mid-size QR at error-correction level M … scannable
 * on a laptop screen at arm's length". Server pairing added a terminal: a
 * headless host draws its code in Unicode half-blocks over SSH, where the
 * constraint is COLUMNS. A QR of version V is `4V + 17` modules square and
 * wants a 4-module quiet zone each side, so an 80-column terminal fits version
 * 13 (69 + 8 = 77 columns) and no more.
 *
 * DERIVED, THEN MEASURED AGAINST THE FRAME #127 DRAWS, THEN RULED. The first
 * cap, 300, was derived from the byte-mode capacity of a version-13 code at
 * level M for a QR holding the URI alone. #127 draws the URI as an OAT frame
 * instead (`src/lib/pairing-frames.ts`), which adds a 34-byte header, and
 * `tests/pairing-frames.test.ts` draws those frames, reads the pixels back
 * through the phone's decoder, and pins the version of each:
 *
 *     URI   frame   QR at M
 *     291    325    v13     server, four addresses incl. DNS, 64-byte name
 *     296    330    v13     server, five addresses, 57-byte name
 *     297    331    v13     no pairing URI is this long (see below)
 *     298    332    v14     73 + 8 = 81 columns: does not fit 80
 *     299    333    v14
 *     300    334    v14
 *
 * So the old cap admitted three lengths that do not fit a terminal, and the
 * owner lowered it to 296: EVERY CODE DRAWS AT VERSION 13 OR SMALLER. 297 is
 * not the edge, although its frame is exactly v13-M's 331 bytes, because
 * base64url never produces it — a 281-character body leaves one character
 * over, which encodes no whole byte, so no payload encodes to 297 characters.
 * 296 is therefore the longest URI this encoder can emit that
 * stays at v13, and a URI of 297 to 300 characters is refused as `too-long` by
 * the encoder AND the parser, so the phone agrees with the screen about where
 * the edge is.
 *
 * THE CAP BINDS BEFORE THE FIELD LIMITS DO, and a real host can reach it. One
 * IPv4 and four IPv6 addresses — what a laptop with a link-local, a ULA and
 * temporary global addresses carries — with a 64-byte name (21 CJK characters)
 * is inside MAX_ADDRESSES and MAX_NAME_BYTES and is refused here as `too-long`.
 * The owner ruled what gives way: ADDRESSES, NEVER THE NAME. See
 * {@link fitPairingPayload}.
 */
export const MAX_PAIRING_URI_LENGTH = 296;

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

/* ── fitting a host's addresses into the budget (#127) ────────────────── */

/**
 * How likely a phone is to reach an address as this payload carries it.
 * {@link PAIRING_REACH_ORDER} is the order a code carries them in, most likely
 * first. `unroutable` is not in that order, because no code carries one. See
 * {@link fitPairingPayload} for why the order is this one.
 */
export type PairingReach =
  | 'private-ipv4'
  | 'unique-local-ipv6'
  | 'public-ipv4'
  | 'public-ipv6'
  | 'dns-name'
  | 'link-local'
  | 'unroutable';

export const PAIRING_REACH_ORDER: readonly PairingReach[] = [
  'private-ipv4',
  'unique-local-ipv6',
  'public-ipv4',
  'public-ipv6',
  'dns-name',
  'link-local',
];

/**
 * Which {@link PairingReach} an address falls in. Bytes in, because the
 * payload holds bytes; see {@link fitPairingPayload} for each boundary.
 */
export function pairingAddressReach(address: PairingAddress): PairingReach {
  const v = address.value;
  if (address.kind === ADDRESS_IPV4 && v.length === 4) {
    const [a, b] = [v[0]!, v[1]!];
    if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return 'private-ipv4';
    if (a === 169 && b === 254) return 'link-local';
    if (a === 0 || a === 127 || a >= 224) return 'unroutable';
    return 'public-ipv4';
  }
  if (address.kind === ADDRESS_IPV6 && v.length === 16) {
    if ((v[0]! & 0xfe) === 0xfc) return 'unique-local-ipv6';
    if (v[0] === 0xfe && (v[1]! & 0xc0) === 0x80) return 'link-local';
    if (v[0] === 0xff) return 'unroutable';
    let zeroes = 0;
    for (let i = 0; i < 15; i += 1) if (v[i] === 0) zeroes += 1;
    if (zeroes === 15 && (v[15] === 0 || v[15] === 1)) return 'unroutable';
    return 'public-ipv6';
  }
  if (address.kind === ADDRESS_DNS) return isMulticastDnsName(address) ? 'link-local' : 'dns-name';
  // A malformed address. fitPairingPayload refuses it before asking.
  return 'unroutable';
}

/** Why a payload could not be fitted into the budget at all. */
export type PairingFitReason =
  /**
   * Every address the host gave is one no phone can dial: loopback,
   * unspecified, multicast or reserved. After those are dropped there is
   * nothing left to put in a code, and the format needs at least one address.
   */
  | 'no-usable-address'
  /**
   * The most reachable address alone, beside the whole name, is over
   * {@link MAX_PAIRING_URI_LENGTH}. Only a DNS name is that long. The name is
   * at most 64 bytes, and one IP address of either family always fits beside
   * it (an IPv6 address beside a 64-byte name is 226 characters), while a DNS
   * name of 70 bytes or more does not. So this happens when no address ranks
   * above the names (none private, unique-local or public) and the first name
   * is too long to sit beside the device name. It happens EVEN IF a shorter
   * name or a link-local address later in the order would fit alone, because
   * addresses are dropped strictly from the end.
   */
  | 'no-address-fits';

export class PairingFitError extends Error {
  override readonly name = 'PairingFitError';
  constructor(readonly reason: PairingFitReason) {
    super(`pairing code cannot be drawn: ${reason}`);
  }
}

/**
 * The largest payload that fits the budget: THE WHOLE NAME, and as many of the
 * host's addresses as fit, most reachable first. Ruled by the owner on #127.
 *
 * WHAT GIVES WAY, AND WHAT DOES NOT. When a payload is over
 * {@link MAX_PAIRING_URI_LENGTH}, addresses are dropped from the END of the
 * order below, one at a time, until {@link encodePairingUri} accepts it. The
 * name is NEVER truncated: it is what the phone shows in "Pair with …?", and
 * a name cut mid-word — or mid-character, since the budget is bytes — is a
 * name the person has to trust without recognising. Rejected by the owner:
 * truncating the name first, and making the user choose addresses.
 *
 * THE ORDER, and it is applied even when nothing has to be dropped, because a
 * code's addresses are "most-preferred first" ({@link PairingPayload.addresses})
 * and the phone tries them in that order. Within one class the host's own
 * order is kept. The classes are the codec's three address kinds, split by
 * what a phone on the same network can do with each:
 *
 *   1. `private-ipv4` — RFC 1918: 10/8, 172.16/12, 192.168/16. The address a
 *      phone on the same Wi-Fi reaches, and six bytes each.
 *   2. `unique-local-ipv6` — fc00::/7. The same network by IPv6, and stable,
 *      unlike the temporary globals a laptop cycles through.
 *   3. `public-ipv4` — every other unicast IPv4, INCLUDING CGNAT's 100.64/10.
 *      Checked rather than assumed: `host/addresses.ts` ranks only
 *      RFC 1918 as private and puts 100.64/10 with the globally routable
 *      addresses, and nothing else in the codebase ranks reachability. A
 *      tailnet address is 100.64/10, and whether it deserves to rank higher is
 *      a question for that ranking, not a second answer here.
 *   4. `public-ipv6` — every other unicast IPv6.
 *   5. `dns-name` — a name costs the phone a lookup through whatever resolver
 *      it has, may resolve to any of the above, and costs 2 + its length bytes
 *      where an address costs 6 or 18, so dropping one frees the most room.
 *   6. `link-local` — what a phone can use only by luck AS CARRIED, so it is
 *      dropped before anything else and carried only when there is room. IPv6
 *      link-local (fe80::/10) is here, not beside the ULA as the ruling's
 *      summary put it, and the codec is why: an address holds sixteen bytes
 *      and no zone index, so a link-local address arrives with its interface
 *      left to chance — the reason `typed.ts` refuses a zone
 *      (`zone-index-unsupported`) and `host/addresses.ts` never
 *      advertises fe80::/10 at all. With it: IPv4 link-local 169.254/16 (DHCP
 *      failed, per the same file), and a `.local` name, whose multicast DNS is
 *      link-scoped and which v1 does not resolve ({@link isMulticastDnsName}).
 *
 * Classes 1–4 are the ranks `host/addresses.ts` already gives the addresses a
 * host advertises (the headless server, and the desktop once it pairs),
 * restated because this half imports nothing; `tests/tunnel-pairing-fit.test.ts`
 * holds the two to the same order.
 *
 * NEVER AN ADDRESS NO PHONE CAN DIAL, whether or not there is room. Class
 * `unroutable` is dropped before ranking: loopback 127/8 and ::1 (on the phone
 * they name the phone), the unspecified 0/8 and :: (bind addresses, not
 * places to dial), and multicast and reserved IPv4 224/3 and IPv6 ff00::/8. It
 * is what `host/addresses.ts` leaves out as `internal`, extended to
 * the ranges a host enumerating its own interfaces would not see there. A
 * link-local address stays, because on one network it can work.
 *
 * ONE OF EACH. A repeated address (the same kind and bytes, a DNS name
 * compared without ASCII case) reaches nothing the first did not, so only the
 * first is kept. Otherwise a host that listed one ULA four times would push a
 * genuinely different route out of a code under pressure.
 * `host/addresses.ts` removes duplicates for the same reason.
 *
 * STRICTLY FROM THE END. A shorter address later in the order is never carried
 * in place of a longer one earlier that does not fit; that would put a less
 * reachable address in the code instead of a more reachable one, which is a
 * reordering the ruling did not make.
 *
 * AT LEAST ONE ADDRESS, because the format requires one. A payload with none
 * is refused as `no-addresses`. One whose every address is unroutable throws
 * {@link PairingFitError} `no-usable-address`, and one whose most reachable
 * address does not fit beside the name throws `no-address-fits`. Neither
 * returns a code that could not be dialled.
 *
 * FAILS CLOSED ON EVERYTHING ELSE. Only `too-long` is fitted. Every other
 * refusal from {@link encodePairingUri} — a bad name, no addresses, more than
 * {@link MAX_ADDRESSES}, a malformed address — is checked on the payload AS
 * GIVEN, before anything is dropped, and thrown as it is. Each is wrong with
 * every smaller payload too, and dropping a malformed address, or counting
 * the list only after duplicates are gone, would hide a host bug inside a code
 * that happens to scan.
 */
export function fitPairingPayload(payload: PairingPayload): PairingPayload {
  try {
    encodePairingUri(payload);
  } catch (error) {
    if (!(error instanceof PairingParseError) || error.reason !== 'too-long') throw error;
  }

  const kept: { address: PairingAddress; index: number; rank: number }[] = [];
  payload.addresses.forEach((address, index) => {
    const reach = pairingAddressReach(address);
    if (reach === 'unroutable') return;
    if (kept.some((entry) => sameAddress(entry.address, address))) return;
    kept.push({ address, index, rank: PAIRING_REACH_ORDER.indexOf(reach) });
  });
  if (kept.length === 0) throw new PairingFitError('no-usable-address');

  const ranked = kept
    // The index breaks ties, so the host's order within a class survives even
    // on an engine whose sort is not stable — V8 before 7.0 was not, and #223
    // is about exactly those runtimes.
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((entry) => entry.address);

  for (let count = ranked.length; ; count -= 1) {
    const candidate: PairingPayload = { ...payload, addresses: ranked.slice(0, count) };
    try {
      encodePairingUri(candidate);
      return candidate;
    } catch (error) {
      if (!(error instanceof PairingParseError) || error.reason !== 'too-long') throw error;
    }
    if (count <= 1) throw new PairingFitError('no-address-fits');
  }
}

/** The same address twice: one kind, the same bytes, a DNS name without ASCII case. */
function sameAddress(a: PairingAddress, b: PairingAddress): boolean {
  if (a.kind !== b.kind || a.value.length !== b.value.length) return false;
  const fold = (c: number): number => (a.kind === ADDRESS_DNS && c >= 0x41 && c <= 0x5a ? c + 0x20 : c);
  for (let i = 0; i < a.value.length; i += 1) if (fold(a.value[i]!) !== fold(b.value[i]!)) return false;
  return true;
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
