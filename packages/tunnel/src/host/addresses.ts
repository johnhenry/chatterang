/**
 * WHERE A PHONE COULD DIAL THIS HOST, AND WHY A HOST IS ALLOWED TO GUESS (#252).
 *
 * The headless server's `main.ts` refuses to turn a wildcard bind into a
 * browsable URL, and is right to: "`0.0.0.0` and `::` are bind addresses, not
 * places to browse to … Only they know which of this machine's names they
 * reach it by." That is the correct answer for a line an operator pastes, and
 * it is NOT sufficient for pairing, where the phone needs somewhere to dial and
 * there is no operator in the loop at that moment.
 *
 * So this file guesses — and that reasoning is SUPERSEDED HERE RATHER THAN
 * CONTRADICTED, which #252 asks for explicitly. Two things make that
 * legitimate:
 *
 *   1. It offers SEVERAL addresses, not one. #134's payload already ruled this
 *      way and said why: "offering one and being wrong costs a failed pairing,
 *      while offering several costs a network-topology leak to whoever
 *      photographs a code that expires in ninety seconds. The second is
 *      smaller." A guess that admits it is a guess is not the thing `main.ts`
 *      refuses to do.
 *   2. What it guesses is shown and can be replaced. The server prints the list
 *      at boot and takes `--advertise`, whose answer is then the ONLY one
 *      (`apps/server/src/addresses.ts`). #252 calls this enumerate-and-confirm.
 *
 * WHY IT LIVES IN THE TUNNEL HOST. Both apps draw pairing codes, and both need
 * this list for the payload. It was written in `apps/server`, which the
 * desktop cannot import (the server depends on the desktop), and #158 asks for
 * one implementation rather than one per app. This half is the one both apps
 * import and the one `src/` may not, which suits a file that reads `node:os`.
 *
 * ONE CONSUMER: THE PAIRING PAYLOAD. {@link pairingAddressesOf} turns the list
 * into the codec's bytes for `fitPairingPayload`, and that is where it goes.
 * The certificate is NOT a consumer. An earlier header here said the SAN list
 * had to come from this list, because a SAN list that disagreed with the
 * advertised one would fail the pin. #295's ruling removed the reason: a client
 * checks only the SPKI pin it learned at pairing, never the certificate's
 * hostname or SAN list, so the address a client dials may change freely and
 * the certificate stays free of an address list that goes stale.
 * `issueTunnelCertificate` still accepts `subjectAltNames`, and no client
 * reads them.
 */

import { networkInterfaces } from 'node:os';

import {
  ADDRESS_DNS,
  ADDRESS_IPV4,
  ADDRESS_IPV6,
  MAX_ADDRESSES,
  TypedEntryError,
  parseTypedEndpoint,
  type AddressKind,
  type PairingAddress,
  type TypedEntryReason,
} from '../pairing/index.js';

/** One place the phone could dial, as text an operator can read. */
export interface AdvertisedAddress {
  readonly kind: 'ipv4' | 'ipv6' | 'dns';
  readonly value: string;
}

/**
 * The shape of `os.networkInterfaces()`, restated so this file can be tested
 * with an injected map rather than with whatever the build machine has.
 *
 * A function that reads the real interfaces is untestable in the way that
 * matters: the interesting cases are the ones this machine does not have.
 */
export interface InterfaceAddress {
  readonly address: string;
  readonly family: string | number;
  readonly internal: boolean;
}
export type InterfaceMap = Readonly<Record<string, readonly InterfaceAddress[] | undefined>>;

/** #134's cap: the codec's own. Offering more than this cannot be encoded anyway. */
export const MAX_ADVERTISED = MAX_ADDRESSES;

const isFour = (a: InterfaceAddress): boolean => a.family === 'IPv4' || a.family === 4;

/**
 * The /64 an IPv6 address sits in — its first four groups, expanded.
 *
 * Two addresses sharing one are two names for the same position on the same
 * network, which is what makes keeping only the first of them lossless.
 */
function sixtyFour(address: string): string {
  const [head = '', tail = ''] = address.toLowerCase().split('::');
  const left = head.split(':').filter((g) => g !== '');
  const right = tail.split(':').filter((g) => g !== '');
  const fill = address.includes('::') ? Array(8 - left.length - right.length).fill('0') : [];
  return [...left, ...fill, ...right].slice(0, 4).map((g) => g.padStart(4, '0')).join(':');
}

/**
 * Rank, lowest first. The phone tries them in order, so this is a claim about
 * which address is most likely to be reachable by a phone on the same network
 * as the host — NOT about which is most correct.
 *
 * CGNAT's 100.64/10 is NOT private here: it ranks with the globally routable
 * addresses, as `pairingAddressReach` ranks it (`public-ipv4`). A tailnet
 * address is 100.64/10, and whether it deserves to rank higher is an open
 * question with one answer to change, in both places at once;
 * `tests/tunnel-pairing-fit.test.ts` holds them together.
 */
function rank(address: string, four: boolean): number {
  if (four) {
    if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(address)) return 0; // private LAN
    return 2; // globally routable
  }
  if (/^f[cd]/i.test(address)) return 1; // unique-local
  return 3; // global IPv6
}

/**
 * Addresses this machine believes a phone could reach it at, best first.
 *
 * Excluded, each for a reason a phone would otherwise pay for:
 *
 *   - **loopback** (`internal`), because the phone is by definition not this
 *     machine. A loopback address in a pairing code is a guaranteed failure.
 *   - **IPv4 link-local** (169.254/16), which means DHCP failed. It is an
 *     address the machine invented for itself, not one anybody routes to.
 *   - **IPv6 link-local** (fe80::/10), because it is unusable without a zone
 *     index, and a zone index is local to the host that wrote it — so the
 *     phone cannot act on the one we would send.
 *
 * Everything left is offered. That includes globally routable addresses, which
 * is the topology leak #252 names: a photographed code names this machine on
 * the public internet for ninety seconds. The printed list is how an operator
 * finds out they mind, and `--advertise` is how a server's operator says so.
 */
export function advertisedAddresses(interfaces: InterfaceMap): readonly AdvertisedAddress[] {
  const found: { address: AdvertisedAddress; rank: number }[] = [];
  for (const list of Object.values(interfaces)) {
    for (const entry of list ?? []) {
      if (entry.internal) continue;
      const four = isFour(entry);
      const address = four ? entry.address : entry.address.replace(/%.*$/, '');
      if (four && /^169\.254\./.test(address)) continue;
      if (!four && /^fe[89ab]/i.test(address)) continue;
      if (found.some((f) => f.address.value === address)) continue;
      /*
       * ONE ADDRESS PER IPv6 /64, AND THIS WAS FOUND BY RUNNING IT.
       *
       * The unit tests could not see it because they supply the interfaces.
       * On a real machine, IPv6 privacy extensions hand out several TEMPORARY
       * addresses in the same /64 — this one produced four — and they reach
       * exactly the same network by exactly the same route. Advertising all of
       * them consumed half of #134's eight-address budget, crowding out
       * genuinely different routes, and multiplied the topology leak #252
       * names without buying one extra chance of connecting.
       *
       * v4 is not deduplicated this way: two v4 addresses on one machine are
       * normally two different networks, which is the case worth carrying.
       *
       * The `!four` guard is INTENT, not behaviour, and mutation testing says
       * so: removing it changes nothing, because `sixtyFour` of a v4 address
       * is the whole address, so the check can only ever fire where the exact
       * match above already did. Kept because a reader deciding whether v4 is
       * collapsed should not have to work that out, and recorded here so the
       * surviving mutant is a known fact rather than a missing test.
       */
      if (!four && found.some((f) => f.address.kind === 'ipv6' && sixtyFour(f.address.value) === sixtyFour(address))) {
        continue;
      }
      found.push({ address: { kind: four ? 'ipv4' : 'ipv6', value: address }, rank: rank(address, four) });
    }
  }
  return found
    .sort((a, b) => a.rank - b.rank || a.address.value.localeCompare(b.address.value))
    .slice(0, MAX_ADVERTISED)
    .map((f) => f.address);
}

/** Reads the real interfaces. Separated so the logic above stays testable. */
export function advertisedAddressesForThisMachine(): readonly AdvertisedAddress[] {
  return advertisedAddresses(networkInterfaces() as InterfaceMap);
}

const KINDS: Readonly<Record<AdvertisedAddress['kind'], { kind: AddressKind; bad: TypedEntryReason }>> = {
  ipv4: { kind: ADDRESS_IPV4, bad: 'bad-ipv4' },
  ipv6: { kind: ADDRESS_IPV6, bad: 'bad-ipv6' },
  dns: { kind: ADDRESS_DNS, bad: 'bad-dns-name' },
};

/**
 * The list as the codec carries it: each address as bytes, in the same order,
 * ready for `fitPairingPayload`, which decides which fit.
 *
 * THROUGH THE TYPED ROUTE'S PARSER, so an address a person types on the phone
 * and one a host puts in a code become the same bytes by the same rules — one
 * spelling of a number, lowercase names, no zone index.
 *
 * FAILS CLOSED, with a {@link TypedEntryError}, on text a code cannot carry as
 * written, and on the whole list if any one entry is refused — a code missing
 * an address the operator named is a code nobody asked for:
 *
 *   - a port or brackets (`192.168.1.4:8973`, `[fd00::5]`). A code carries one
 *     port for all its addresses, so a port here has nowhere to go, and
 *     dropping it would dial somewhere the operator did not say;
 *   - a zone index (`zone-index-unsupported`), which names an interface on
 *     this machine;
 *   - text whose kind is not the kind it claims — `--advertise` classifies by
 *     shape, and `desk:8973` is not the IPv6 address its colon suggests.
 *
 * A `.local` name IS carried. The typed route refuses one because a person
 * typed it and can be told at once (`local-name-unreachable`); a QR payload
 * admits one, and `fitPairingPayload` ranks it link-local, carried only when
 * there is room.
 */
export function pairingAddressesOf(addresses: readonly AdvertisedAddress[]): PairingAddress[] {
  return addresses.map(pairingAddressOf);
}

function pairingAddressOf(address: AdvertisedAddress): PairingAddress {
  const { kind, bad } = KINDS[address.kind];
  const text = address.value;
  const colons = text.split(':').length - 1;
  if (address.kind === 'ipv6' ? colons < 2 || /[[\]]/.test(text) : colons > 0) {
    throw new TypedEntryError(bad);
  }
  let parsed: PairingAddress;
  try {
    parsed = parseTypedEndpoint(text).address;
  } catch (error) {
    // The one refusal a code does not share with the typed route. It is thrown
    // only after the name has parsed, so the name is valid, and its bytes are
    // what the parser would have produced: lowercase, no trailing dot.
    if (!(error instanceof TypedEntryError) || error.reason !== 'local-name-unreachable') throw error;
    const name = (text.endsWith('.') ? text.slice(0, -1) : text).trim().toLowerCase();
    parsed = { kind: ADDRESS_DNS, value: Uint8Array.from(name, (c) => c.charCodeAt(0)) };
  }
  if (parsed.kind !== kind) throw new TypedEntryError(bad);
  return parsed;
}
