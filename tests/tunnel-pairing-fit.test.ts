// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { advertisedAddresses, type InterfaceMap } from '../apps/server/src/addresses.js';
import {
  ADDRESS_DNS,
  ADDRESS_IPV4,
  HOST_DESKTOP,
  HOST_SERVER,
  MAX_ADDRESSES,
  MAX_NAME_BYTES,
  MAX_PAIRING_URI_LENGTH,
  PAIRING_REACH_ORDER,
  PairingFitError,
  PairingParseError,
  TRUST_SPKI_PIN,
  decodePairingUri,
  encodePairingUri,
  fitPairingPayload,
  pairingAddressReach,
  parseTypedEndpoint,
  type PairingAddress,
  type PairingPayload,
  type PairingReach,
} from '@chatterang/tunnel/pairing';

/**
 * #127: WHEN A HOST'S PAYLOAD WILL NOT FIT, ADDRESSES GIVE WAY AND THE NAME
 * DOES NOT.
 *
 * Ruled by the owner: the code carries the addresses most likely reachable
 * from a phone first, drops from the end until `encodePairingUri` accepts it,
 * and never truncates the device name. Every test that shows something being
 * dropped is paired with the same shape one step inside the budget keeping it,
 * so a function that dropped everything could not pass.
 */

/** An address from its text, through the typed route's own parser. */
const at = (text: string): PairingAddress => parseTypedEndpoint(text).address;
const dns = (name: string): PairingAddress => ({ kind: ADDRESS_DNS, value: Uint8Array.from(name, (c) => c.charCodeAt(0)) });

function payload(
  addresses: readonly PairingAddress[],
  name = 'Desk',
  hostKind: typeof HOST_DESKTOP | typeof HOST_SERVER = HOST_DESKTOP,
): PairingPayload {
  return {
    version: 1,
    hostKind,
    trustMode: TRUST_SPKI_PIN,
    trust: new Uint8Array(32).fill(0xab),
    token: new Uint8Array(32).fill(0xcd),
    expiresAt: 1_900_000_000,
    port: 51234,
    addresses,
    name,
  };
}

function reasonOf(run: () => unknown): unknown {
  try {
    run();
    return null;
  } catch (error) {
    if (error instanceof PairingParseError || error instanceof PairingFitError) return error.reason;
    throw error;
  }
}

/** Labels for addresses, by identity: the fitted payload carries the caller's objects. */
function labeller(entries: Record<string, PairingAddress>) {
  const names = new Map<PairingAddress, string>(Object.entries(entries).map(([label, address]) => [address, label]));
  return (addresses: readonly PairingAddress[]) => addresses.map((address) => names.get(address) ?? '?');
}

/* The five addresses #303 measured: a laptop with a LAN IPv4, two ULAs, a temporary global and a link-local. */
const LAN = at('192.168.1.23');
const ULA = at('fd7a:115c:b1e0::a:b0c');
const GLOBAL = at('2600:1700:80a0:1e00::1234');
const LINK = at('fe80::1');
const ULA2 = at('fd00::2');
const MEASURED_ADDRESSES = [LAN, ULA, GLOBAL, LINK, ULA2];
const label = labeller({ LAN, ULA, GLOBAL, LINK, ULA2 });

describe("the case #303 measured: one IPv4, four IPv6 and a 64-byte name", () => {
  const cjk = '桌'.repeat(21) + 'x';

  it('is over the budget as it stands, for an ASCII name and a CJK one', () => {
    for (const name of ['x'.repeat(MAX_NAME_BYTES), cjk]) {
      expect(new TextEncoder().encode(name)).toHaveLength(MAX_NAME_BYTES);
      expect(reasonOf(() => encodePairingUri(payload(MEASURED_ADDRESSES, name)))).toBe('too-long');
    }
  });

  it('fits by dropping the link-local address alone, and keeps the whole name', () => {
    for (const name of ['x'.repeat(MAX_NAME_BYTES), cjk]) {
      const fitted = fitPairingPayload(payload(MEASURED_ADDRESSES, name));
      expect(label(fitted.addresses), name).toEqual(['LAN', 'ULA', 'ULA2', 'GLOBAL']);
      expect(fitted.name).toBe(name);

      const uri = encodePairingUri(fitted);
      expect(uri).toHaveLength(282);
      expect(uri.length).toBeLessThanOrEqual(MAX_PAIRING_URI_LENGTH);
      const back = decodePairingUri(uri);
      expect(back.name).toBe(name);
      expect(back.addresses).toHaveLength(4);
    }
  });

  it('changes nothing but the addresses, and leaves the caller’s payload as it was', () => {
    const original = payload(MEASURED_ADDRESSES, 'x'.repeat(MAX_NAME_BYTES), HOST_SERVER);
    const fitted = fitPairingPayload(original);
    expect({ ...fitted, addresses: original.addresses }).toEqual(original);
    expect(label(original.addresses)).toEqual(['LAN', 'ULA', 'GLOBAL', 'LINK', 'ULA2']);
  });
});

describe('it drops from the end, only as many as it must, and never the name', () => {
  it('at the edge of the budget: a 296-character code keeps every address, a 298-character one loses exactly one', () => {
    /*
     * THE CAP, SEEN FROM HERE. With five addresses a 57-byte name is exactly
     * 296 characters and a 58-byte one 298 — the length the old cap of 300
     * admitted and a terminal cannot show.
     */
    const edge = fitPairingPayload(payload(MEASURED_ADDRESSES, 'n'.repeat(57), HOST_SERVER));
    expect(label(edge.addresses)).toEqual(['LAN', 'ULA', 'ULA2', 'GLOBAL', 'LINK']);
    expect(encodePairingUri(edge)).toHaveLength(296);

    const over = fitPairingPayload(payload(MEASURED_ADDRESSES, 'n'.repeat(58), HOST_SERVER));
    expect(label(over.addresses)).toEqual(['LAN', 'ULA', 'ULA2', 'GLOBAL']);
    expect(over.name).toBe('n'.repeat(58));
    expect(encodePairingUri(over)).toHaveLength(274);
  });

  it('keeps the longest run of the order that fits, and not one address more', () => {
    const P1 = at('10.0.0.2');
    const P2 = at('192.168.4.7');
    const U1 = at('fd12::1');
    const U2 = at('fc00::9');
    const A1 = at('203.0.113.9');
    const A2 = at('100.64.0.7');
    const G1 = at('2001:db8::1');
    const G2 = at('2001:db8:1::1');
    const name = labeller({ P1, P2, U1, U2, A1, A2, G1, G2 });
    const host = [G2, A1, U1, P2, G1, U2, A2, P1];
    // By class, and within a class in the host's order: P2 was listed before P1.
    const order = [P2, P1, U1, U2, A1, A2, G2, G1];

    const fitted = fitPairingPayload(payload(host, 'x'.repeat(MAX_NAME_BYTES)));
    expect(name(fitted.addresses)).toEqual(['P2', 'P1', 'U1', 'U2', 'A1', 'A2']);
    expect(encodePairingUri(fitted).length).toBeLessThanOrEqual(MAX_PAIRING_URI_LENGTH);
    // Maximal: the next address in the order would not have fitted.
    expect(reasonOf(() => encodePairingUri({ ...fitted, addresses: order.slice(0, 7) }))).toBe('too-long');

    // The control: a short name leaves room for all eight, in the same order.
    expect(name(fitPairingPayload(payload(host, 'Desk')).addresses)).toEqual(name(order));
  });

  it('refuses rather than cut the name, when not even the most reachable address fits beside it', () => {
    const long = dns('a'.repeat(70));
    const name = 'x'.repeat(MAX_NAME_BYTES);
    const error = (() => {
      try {
        fitPairingPayload(payload([long], name));
        return null;
      } catch (caught) {
        return caught;
      }
    })();
    expect(error).toBeInstanceOf(PairingFitError);
    expect((error as PairingFitError).reason).toBe('no-address-fits');

    // The control: the same address fits beside a shorter name, so the refusal
    // is the whole name being kept, not the address being unusable.
    expect(fitPairingPayload(payload([long], 'Desk')).addresses).toEqual([long]);
    // And the name alone is inside its own field limit: nothing here is invalid.
    expect(reasonOf(() => encodePairingUri(payload([at('192.168.1.4')], name)))).toBeNull();
  });

  it('drops strictly from the end: a shorter address later in the order is not carried instead of one earlier that does not fit', () => {
    /*
     * PINNED AS THE RULING READS. Both are names, so the host's order between
     * them stands, and the ruling drops from the end; skipping ahead to a
     * name that happens to be shorter would be a different rule.
     */
    const long = dns('a'.repeat(70));
    const short = dns('desk.lan');
    const name = 'x'.repeat(MAX_NAME_BYTES);
    expect(reasonOf(() => fitPairingPayload(payload([long, short], name)))).toBe('no-address-fits');
    expect(fitPairingPayload(payload([short, long], name)).addresses).toEqual([short]);
  });
});

describe('the order is reachability from a phone', () => {
  const cases: readonly [string, PairingReach][] = [
    ['10.0.0.1', 'private-ipv4'],
    ['10.255.255.255', 'private-ipv4'],
    ['9.255.255.255', 'public-ipv4'],
    ['11.0.0.0', 'public-ipv4'],
    ['172.15.255.255', 'public-ipv4'],
    ['172.16.0.0', 'private-ipv4'],
    ['172.31.255.255', 'private-ipv4'],
    ['172.32.0.0', 'public-ipv4'],
    ['192.167.255.255', 'public-ipv4'],
    ['192.168.0.1', 'private-ipv4'],
    ['192.169.0.1', 'public-ipv4'],
    // CGNAT: ranked with the public addresses, as apps/server/src/addresses.ts ranks it.
    ['100.64.0.1', 'public-ipv4'],
    ['100.127.255.255', 'public-ipv4'],
    ['8.8.8.8', 'public-ipv4'],
    ['223.255.255.255', 'public-ipv4'],
    ['224.0.0.251', 'unusable'],
    ['255.255.255.255', 'unusable'],
    ['169.254.1.1', 'unusable'],
    ['169.253.1.1', 'public-ipv4'],
    ['127.0.0.1', 'unusable'],
    ['0.0.0.0', 'unusable'],
    ['fbff::1', 'public-ipv6'],
    ['fc00::1', 'unique-local-ipv6'],
    ['fdff:ffff::1', 'unique-local-ipv6'],
    ['fe7f::1', 'public-ipv6'],
    ['fe80::1', 'unusable'],
    ['febf::1', 'unusable'],
    ['fec0::1', 'public-ipv6'],
    ['ff02::1', 'unusable'],
    ['::1', 'unusable'],
    ['::', 'unusable'],
    ['::2', 'public-ipv6'],
    ['2001:db8::1', 'public-ipv6'],
  ];

  it('classifies each boundary', () => {
    for (const [text, reach] of cases) expect(pairingAddressReach(at(text)), text).toBe(reach);
    expect(pairingAddressReach(dns('desk.tailnet-abcd.ts.net'))).toBe('dns-name');
    expect(pairingAddressReach(dns('desk.local'))).toBe('unusable');
    expect(pairingAddressReach(dns('Desk.LOCAL'))).toBe('unusable');
  });

  it('is private IPv4, unique-local IPv6, public IPv4, public IPv6, names, then what a phone cannot use', () => {
    expect(PAIRING_REACH_ORDER).toEqual([
      'private-ipv4',
      'unique-local-ipv6',
      'public-ipv4',
      'public-ipv6',
      'dns-name',
      'unusable',
    ]);
  });

  const PRIVATE = at('192.168.1.4');
  const ULA_A = at('fd00::5');
  const PUBLIC4 = at('203.0.113.9');
  const CGNAT = at('100.101.102.103');
  const PUBLIC6 = at('2001:db8::1');
  const NAME = dns('desk.tailnet-abcd.ts.net');
  const LINK_LOCAL = at('fe80::1');
  const MDNS = dns('desk.local');
  const name = labeller({ PRIVATE, ULA_A, PUBLIC4, CGNAT, PUBLIC6, NAME, LINK_LOCAL, MDNS });
  const expected = ['PRIVATE', 'ULA_A', 'PUBLIC4', 'CGNAT', 'PUBLIC6', 'NAME', 'LINK_LOCAL', 'MDNS'];

  it('puts every host ordering into the same order, keeping the host’s order within a class', () => {
    const inOrder = [PRIVATE, ULA_A, PUBLIC4, CGNAT, PUBLIC6, NAME, LINK_LOCAL, MDNS];
    const orderings = [
      inOrder,
      [...inOrder].reverse(),
      [MDNS, NAME, PUBLIC6, CGNAT, PUBLIC4, ULA_A, LINK_LOCAL, PRIVATE],
      [LINK_LOCAL, PRIVATE, NAME, ULA_A, MDNS, PUBLIC4, PUBLIC6, CGNAT],
      [PUBLIC6, PUBLIC4, CGNAT, ULA_A, NAME, PRIVATE, MDNS, LINK_LOCAL],
    ];
    for (const host of orderings) {
      const fitted = fitPairingPayload(payload(host));
      expect(fitted.addresses, name(host).join(',')).toHaveLength(host.length);
      const got = name(fitted.addresses);
      // Across classes, the order is fixed.
      const rank = (label: string) => ['PRIVATE', 'ULA_A', ['PUBLIC4', 'CGNAT'], 'PUBLIC6', 'NAME', ['LINK_LOCAL', 'MDNS']]
        .findIndex((entry) => (Array.isArray(entry) ? entry.includes(label) : entry === label));
      expect(got.map(rank), name(host).join(',')).toEqual([0, 1, 2, 2, 3, 4, 5, 5]);
      // Within a class, the host's order stands.
      const hostOrder = (a: string, b: string) => name(host).indexOf(a) < name(host).indexOf(b);
      expect(hostOrder(got[2]!, got[3]!), `public IPv4 in ${name(host).join(',')}`).toBe(true);
      expect(hostOrder(got[6]!, got[7]!), `unusable in ${name(host).join(',')}`).toBe(true);
    }
    expect(name(fitPairingPayload(payload(orderings[0]!)).addresses)).toEqual(expected);
  });

  it('keeps a private address over a CGNAT one, a ULA over a public IPv4, and drops link-local before a name', () => {
    const tight = 'x'.repeat(MAX_NAME_BYTES);
    expect(name(fitPairingPayload(payload([CGNAT, PRIVATE])).addresses)).toEqual(['PRIVATE', 'CGNAT']);
    expect(name(fitPairingPayload(payload([PUBLIC4, ULA_A])).addresses)).toEqual(['ULA_A', 'PUBLIC4']);
    expect(name(fitPairingPayload(payload([LINK_LOCAL, NAME])).addresses)).toEqual(['NAME', 'LINK_LOCAL']);
    // Under pressure the order is what decides: four IPv6 addresses beside a
    // 64-byte name do not all fit, and the ones that go are the last.
    const pressed = fitPairingPayload(payload([LINK_LOCAL, PUBLIC6, ULA_A, at('fd00::6'), PRIVATE], tight));
    expect(name(pressed.addresses)).toEqual(['PRIVATE', 'ULA_A', '?', 'PUBLIC6']);
  });

  it('agrees with the order a headless server advertises in', () => {
    /*
     * ONE RANKING, TWO COPIES. `apps/server/src/addresses.ts` ranks what a
     * server advertises; this half imports nothing, so it restates the ranks,
     * and this holds the two together — CGNAT included, which is where they
     * would most plausibly part.
     */
    const map: InterfaceMap = {
      en0: [
        { address: '2001:db8::1', family: 'IPv6', internal: false },
        { address: '100.64.0.7', family: 'IPv4', internal: false },
      ],
      en1: [
        { address: 'fd00::5', family: 'IPv6', internal: false },
        { address: '10.1.2.3', family: 'IPv4', internal: false },
      ],
    };
    const advertised = advertisedAddresses(map).map((entry) => entry.value);
    expect(advertised).toEqual(['10.1.2.3', 'fd00::5', '100.64.0.7', '2001:db8::1']);
    for (const host of [[...advertised].reverse(), [advertised[2]!, advertised[0]!, advertised[3]!, advertised[1]!]]) {
      const addresses = host.map(at);
      const texts = new Map(addresses.map((address, i) => [address, host[i]!]));
      const fitted = fitPairingPayload(payload(addresses));
      expect(fitted.addresses.map((address) => texts.get(address))).toEqual(advertised);
    }
  });
});

describe('everything but the budget fails closed', () => {
  it('refuses a payload with no address, rather than inventing one', () => {
    expect(reasonOf(() => fitPairingPayload(payload([])))).toBe('no-addresses');
  });

  it('refuses a name over its field limit, rather than truncating it to fit', () => {
    expect(reasonOf(() => fitPairingPayload(payload([LAN], 'x'.repeat(MAX_NAME_BYTES + 1))))).toBe('bad-name');
    expect(fitPairingPayload(payload([LAN], 'x'.repeat(MAX_NAME_BYTES))).name).toHaveLength(MAX_NAME_BYTES);
  });

  it('refuses more addresses than the format holds, rather than choosing among them', () => {
    const nine = Array.from({ length: MAX_ADDRESSES + 1 }, (_, i) => at(`192.168.1.${i + 1}`));
    expect(reasonOf(() => fitPairingPayload(payload(nine)))).toBe('too-many-addresses');
    expect(fitPairingPayload(payload(nine.slice(0, MAX_ADDRESSES))).addresses).toHaveLength(MAX_ADDRESSES);
  });

  it('refuses a malformed address even where it would have been dropped', () => {
    /*
     * A five-byte IPv4 address sorts last and the payload is over budget, so a
     * fitter that only looked at length would drop it and draw a code. It must
     * not: a malformed address is a host bug, and hiding it inside a code that
     * happens to scan is how it would never be found.
     */
    const broken: PairingAddress = { kind: ADDRESS_IPV4, value: Uint8Array.of(192, 168, 1, 4, 0) };
    expect(pairingAddressReach(broken)).toBe('unusable');
    const over = payload([...MEASURED_ADDRESSES.slice(0, 4), broken], 'x'.repeat(MAX_NAME_BYTES));
    expect(reasonOf(() => fitPairingPayload(over))).toBe('bad-address-length');
  });
});
