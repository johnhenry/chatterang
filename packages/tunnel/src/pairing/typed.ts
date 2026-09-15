/**
 * THE TYPED ROUTE'S GRAMMAR: a host the person types, and a six-digit code.
 *
 * The owner ruled (#130) that the camera-free pairing route takes a HOST field
 * beside the six digits, with the port defaulting to 8973. The scanned route
 * carries its address inside the QR payload; the typed route has only what a
 * person can type. So this file turns that text into the SAME `PairingAddress`
 * the QR payload uses — one shape for a future controller to dial, whichever
 * route produced it.
 *
 * PARSED BY HAND, with no imports beyond this half and no globals, for the
 * reason the pairing half gives in its own header: #223 records that every
 * capability was measured on the newest runtimes, and this is the code that
 * has to work on the oldest phone whose owner is trying to pair it. So there
 * is no `URL`, no `TextEncoder` and no regex-heavy IPv6 library.
 *
 * STRICTER THAN THE QR PARSER, DELIBERATELY. The QR parser checks only that a
 * DNS name is 1..255 bytes, because the HOST wrote those bytes and the parser's
 * job is to agree with them byte for byte. Here a PERSON wrote them, on a phone
 * keyboard, and the useful thing is to say what is wrong before anything tries
 * to connect: a label that is too long, an underscore, a non-ASCII letter.
 */

import {
  ADDRESS_DNS,
  ADDRESS_IPV4,
  ADDRESS_IPV6,
  isMulticastDnsName,
  type PairingAddress,
} from './index.js';

/**
 * The port a typed host is dialled on when none is given.
 *
 * The same number as the headless server's `DEFAULT_PORT`
 * (`apps/server/src/binding.ts`), which this half may not import — and a test
 * pins the two equal, so they cannot drift apart silently. It is only a
 * DEFAULT: #158 rules the desktop's listener port ephemeral, so pairing with a
 * desktop by typing needs the port written out.
 */
export const DEFAULT_PAIRING_PORT = 8973;

/** How many digits a typed pairing code has. The CPace secret is their text. */
export const TYPED_CODE_DIGITS = 6;

export type TypedEntryReason =
  | 'empty'
  | 'bad-ipv4'
  | 'bad-ipv6'
  | 'bad-dns-name'
  | 'bad-port'
  /**
   * A `.local` name. The QR payload ADMITS these and warns, because the host
   * drew the code; here the person typed it and can be told immediately that
   * v1 does not resolve multicast DNS (#166, #222) rather than discovering it
   * as a connection that never completes.
   */
  | 'local-name-unreachable'
  /**
   * An IPv6 zone index (`fe80::1%en0`). Its own reason rather than `bad-ipv6`,
   * because the address itself is fine and the person can fix it by deleting
   * one part — which is worth saying.
   */
  | 'zone-index-unsupported'
  | 'bad-code';

export class TypedEntryError extends Error {
  override readonly name = 'TypedEntryError';
  constructor(readonly reason: TypedEntryReason) {
    super(`pairing entry refused: ${reason}`);
  }
}

export interface TypedEndpoint {
  readonly address: PairingAddress;
  readonly port: number;
}

const isDigit = (code: number): boolean => code >= 0x30 && code <= 0x39;
const isHex = (code: number): boolean =>
  isDigit(code) || (code >= 0x61 && code <= 0x66) || (code >= 0x41 && code <= 0x46);

/** A decimal port: 1..65535, digits only, no leading zero. */
function parsePort(text: string): number {
  if (text.length === 0 || text.length > 5) throw new TypedEntryError('bad-port');
  for (let i = 0; i < text.length; i += 1) {
    if (!isDigit(text.charCodeAt(i))) throw new TypedEntryError('bad-port');
  }
  // One spelling per number: "08973" would be a second way to write 8973.
  if (text.charCodeAt(0) === 0x30) throw new TypedEntryError('bad-port');
  const port = Number(text);
  if (port < 1 || port > 65535) throw new TypedEntryError('bad-port');
  return port;
}

/** Four decimal octets, 0..255 each, no leading zeros — `01.2.3.4` is refused. */
function parseIpv4(text: string): Uint8Array | null {
  const parts = text.split('.');
  if (parts.length !== 4) return null;
  const out = new Uint8Array(4);
  for (let i = 0; i < 4; i += 1) {
    const part = parts[i]!;
    if (part.length === 0 || part.length > 3) return null;
    for (let j = 0; j < part.length; j += 1) if (!isDigit(part.charCodeAt(j))) return null;
    // A leading zero is refused rather than read: some resolvers treat it as
    // OCTAL, so "010" is ambiguous between 10 and 8.
    if (part.length > 1 && part.charCodeAt(0) === 0x30) return null;
    const value = Number(part);
    if (value > 255) return null;
    out[i] = value;
  }
  return out;
}

/**
 * Sixteen bytes from IPv6 text, with `::` compression and an optional embedded
 * IPv4 tail (`::ffff:192.168.1.4`). Zone indexes are handled by the caller.
 */
function parseIpv6(text: string): Uint8Array | null {
  const doubled = text.indexOf('::');
  /*
   * INTENT, NOT BEHAVIOUR — and mutation testing says so. A second `::` always
   * leaves an empty group in the tail, which the group check refuses anyway,
   * so deleting this line changes no outcome. It stays because "at most one
   * `::`" is the rule a reader is checking for, and finding it only as a side
   * effect of the empty-group check would make them work it out.
   */
  if (doubled !== -1 && text.indexOf('::', doubled + 1) !== -1) return null;

  const groups = (side: string): number[] | null => {
    if (side === '') return [];
    const out: number[] = [];
    const pieces = side.split(':');
    for (let i = 0; i < pieces.length; i += 1) {
      const piece = pieces[i]!;
      const last = i === pieces.length - 1;
      if (last && piece.includes('.')) {
        const v4 = parseIpv4(piece);
        if (v4 === null) return null;
        out.push((v4[0]! << 8) | v4[1]!, (v4[2]! << 8) | v4[3]!);
        continue;
      }
      if (piece.length === 0 || piece.length > 4) return null;
      for (let j = 0; j < piece.length; j += 1) if (!isHex(piece.charCodeAt(j))) return null;
      out.push(parseInt(piece, 16));
    }
    return out;
  };

  let head: number[] | null;
  let tail: number[] | null;
  if (doubled === -1) {
    head = groups(text);
    tail = [];
    if (head === null || head.length !== 8) return null;
  } else {
    head = groups(text.slice(0, doubled));
    tail = groups(text.slice(doubled + 2));
    if (head === null || tail === null) return null;
    // `::` stands for at least one zero group, so eight explicit groups plus
    // `::` is too many.
    if (head.length + tail.length > 7) return null;
  }

  const all = [...head, ...new Array<number>(8 - head.length - tail.length).fill(0), ...tail];
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 8; i += 1) {
    bytes[i * 2] = all[i]! >> 8;
    bytes[i * 2 + 1] = all[i]! & 0xff;
  }
  return bytes;
}

/**
 * A hostname: ASCII letters, digits and hyphens in dot-separated labels of
 * 1..63, no label starting or ending with a hyphen, 253 characters at most.
 * Lowercased, because DNS is case-insensitive and one spelling is easier to
 * compare. One trailing dot (a fully-qualified name) is accepted and dropped.
 */
function parseDnsName(text: string): Uint8Array | null {
  const name = (text.endsWith('.') ? text.slice(0, -1) : text).toLowerCase();
  if (name.length === 0 || name.length > 253) return null;
  const labels = name.split('.');
  for (const label of labels) {
    if (label.length === 0 || label.length > 63) return null;
    if (label.charCodeAt(0) === 0x2d || label.charCodeAt(label.length - 1) === 0x2d) return null;
    for (let i = 0; i < label.length; i += 1) {
      const code = label.charCodeAt(i);
      const ok = isDigit(code) || (code >= 0x61 && code <= 0x7a) || code === 0x2d;
      if (!ok) return null;
    }
  }
  const bytes = new Uint8Array(name.length);
  for (let i = 0; i < name.length; i += 1) bytes[i] = name.charCodeAt(i);
  return bytes;
}

/**
 * Turn what a person typed into the address and port a controller dials.
 *
 * Accepted shapes: `192.168.1.4`, `192.168.1.4:51234`, `desk.lan`,
 * `desk.lan:51234`, `fe80::1`, `[fe80::1]`, `[fe80::1]:8973`.
 *
 * A BARE IPv6 ADDRESS CANNOT CARRY A PORT, and that is not a limitation this
 * file chose: `fe80::1:8973` is a valid ADDRESS whose last group is 8973. The
 * only unambiguous way to add a port to IPv6 is brackets, which is what URLs
 * settled on for the same reason.
 */
export function parseTypedEndpoint(text: string): TypedEndpoint {
  const input = text.trim();
  if (input.length === 0) throw new TypedEntryError('empty');

  /*
   * A ZONE INDEX (`fe80::1%en0`) CANNOT BE CARRIED, and that is the reason it
   * is refused — not the one `host/addresses.ts` gives. There, a zone came from
   * the HOST and names an interface on a different machine.
   * Here the person typed it on the phone, so it would name the phone's own
   * interface and could be meaningful. But `PairingAddress` is shared with the
   * QR payload and holds sixteen bytes and no interface, so a zone has nowhere
   * to go; dropping it silently would dial a link-local address with the
   * interface left to chance.
   *
   * Checked here rather than inside the IPv6 parser, because that parser
   * already refuses `%` as a non-hex character — which made an explicit check
   * there a line no input could reach on its own. Hoisted, it names the reason.
   */
  const bracketed = input.startsWith('[');
  const ipv6Text = bracketed ? input.slice(1, input.indexOf(']') === -1 ? undefined : input.indexOf(']')) : input;
  if ((bracketed || input.split(':').length - 1 > 1) && ipv6Text.includes('%')) {
    throw new TypedEntryError('zone-index-unsupported');
  }

  if (input.startsWith('[')) {
    const close = input.indexOf(']');
    if (close === -1) throw new TypedEntryError('bad-ipv6');
    const bytes = parseIpv6(input.slice(1, close));
    if (bytes === null) throw new TypedEntryError('bad-ipv6');
    const rest = input.slice(close + 1);
    if (rest !== '' && !rest.startsWith(':')) throw new TypedEntryError('bad-ipv6');
    const port = rest === '' ? DEFAULT_PAIRING_PORT : parsePort(rest.slice(1));
    return { address: { kind: ADDRESS_IPV6, value: bytes }, port };
  }

  const colons = input.split(':').length - 1;
  if (colons > 1) {
    const bytes = parseIpv6(input);
    if (bytes === null) throw new TypedEntryError('bad-ipv6');
    return { address: { kind: ADDRESS_IPV6, value: bytes }, port: DEFAULT_PAIRING_PORT };
  }

  const colon = input.indexOf(':');
  const host = colon === -1 ? input : input.slice(0, colon);
  const port = colon === -1 ? DEFAULT_PAIRING_PORT : parsePort(input.slice(colon + 1));
  if (host.length === 0) throw new TypedEntryError('empty');

  // Digits and dots only is an IPv4 attempt, never a hostname: a name whose
  // every label is numeric is not a name anyone resolves.
  let numeric = true;
  for (let i = 0; i < host.length; i += 1) {
    const code = host.charCodeAt(i);
    if (!isDigit(code) && code !== 0x2e) numeric = false;
  }
  if (numeric) {
    const bytes = parseIpv4(host);
    if (bytes === null) throw new TypedEntryError('bad-ipv4');
    return { address: { kind: ADDRESS_IPV4, value: bytes }, port };
  }

  const bytes = parseDnsName(host);
  if (bytes === null) throw new TypedEntryError('bad-dns-name');
  const address: PairingAddress = { kind: ADDRESS_DNS, value: bytes };
  if (isMulticastDnsName(address)) throw new TypedEntryError('local-name-unreachable');
  return { address, port };
}

/**
 * The six digits, as a STRING, with spaces and hyphens removed.
 *
 * A string and never a number: CPace hashes the code's TEXT, so `012345` and
 * `12345` are different secrets, and a `Number()` anywhere on this path would
 * silently turn one into the other. Only ASCII digits are accepted — a phone
 * keyboard can produce full-width or Arabic-Indic digits that look identical
 * and hash differently from what the other screen displayed.
 */
export function normalizeTypedCode(text: string): string {
  let digits = '';
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code === 0x20 || code === 0x2d) continue;
    if (!isDigit(code)) throw new TypedEntryError('bad-code');
    digits += text[i];
  }
  if (digits.length !== TYPED_CODE_DIGITS) throw new TypedEntryError('bad-code');
  return digits;
}
