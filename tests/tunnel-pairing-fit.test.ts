// @vitest-environment node
import { describe, expect, it } from 'vitest';

import {
  advertisedAddresses,
  pairingAddressesOf,
  type AdvertisedAddress,
  type InterfaceMap,
} from '@chatterang/tunnel/host';
import {
  ADDRESS_DNS,
  ADDRESS_IPV4,
  ADDRESS_IPV6,
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
  TypedEntryError,
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

    // The same holds when what comes after the name is a link-local address,
    // which ranks last and alone would fit: no IP address ranks above the
    // name, so the name is the most reachable address and it does not fit.
    const link = at('fe80::1');
    expect(reasonOf(() => fitPairingPayload(payload([link, long], name)))).toBe('no-address-fits');
    expect(fitPairingPayload(payload([link], name)).addresses).toEqual([link]);
    // One IP address that ranks above the names is enough to fit.
    expect(fitPairingPayload(payload([long, at('2001:db8::1')], name)).addresses).toHaveLength(1);
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
    // CGNAT: ranked with the public addresses, as packages/tunnel/src/host/addresses.ts ranks it.
    ['100.64.0.1', 'public-ipv4'],
    ['100.127.255.255', 'public-ipv4'],
    ['8.8.8.8', 'public-ipv4'],
    ['223.255.255.255', 'public-ipv4'],
    ['224.0.0.251', 'unroutable'],
    ['240.0.0.1', 'unroutable'],
    ['255.255.255.255', 'unroutable'],
    ['169.254.1.1', 'link-local'],
    ['169.254.255.255', 'link-local'],
    ['169.253.1.1', 'public-ipv4'],
    ['169.255.0.1', 'public-ipv4'],
    ['127.0.0.1', 'unroutable'],
    ['127.255.255.255', 'unroutable'],
    ['126.255.255.255', 'public-ipv4'],
    ['128.0.0.1', 'public-ipv4'],
    ['0.0.0.0', 'unroutable'],
    ['0.255.255.255', 'unroutable'],
    ['1.0.0.0', 'public-ipv4'],
    ['fbff::1', 'public-ipv6'],
    ['fc00::1', 'unique-local-ipv6'],
    ['fdff:ffff::1', 'unique-local-ipv6'],
    ['fe7f::1', 'public-ipv6'],
    ['fe80::1', 'link-local'],
    ['febf::1', 'link-local'],
    ['fec0::1', 'public-ipv6'],
    ['ff02::1', 'unroutable'],
    ['feff::1', 'public-ipv6'],
    ['::1', 'unroutable'],
    ['::', 'unroutable'],
    ['::2', 'public-ipv6'],
    ['1::1', 'public-ipv6'],
    ['2001:db8::1', 'public-ipv6'],
  ];

  it('classifies each boundary', () => {
    for (const [text, reach] of cases) expect(pairingAddressReach(at(text)), text).toBe(reach);
    expect(pairingAddressReach(dns('desk.tailnet-abcd.ts.net'))).toBe('dns-name');
    expect(pairingAddressReach(dns('desk.local'))).toBe('link-local');
    expect(pairingAddressReach(dns('Desk.LOCAL'))).toBe('link-local');
    expect(pairingAddressReach(dns('desk.localhost'))).toBe('dns-name');
  });

  it('is private IPv4, unique-local IPv6, public IPv4, public IPv6, names, then link-local, and never the unroutable', () => {
    expect(PAIRING_REACH_ORDER).toEqual([
      'private-ipv4',
      'unique-local-ipv6',
      'public-ipv4',
      'public-ipv6',
      'dns-name',
      'link-local',
    ]);
    expect(PAIRING_REACH_ORDER).not.toContain('unroutable');
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
      expect(hostOrder(got[6]!, got[7]!), `link-local in ${name(host).join(',')}`).toBe(true);
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

  it('agrees with the order a host advertises in', () => {
    /*
     * ONE RANKING, TWO COPIES. `packages/tunnel/src/host/addresses.ts` ranks
     * what a host (the headless server, and the desktop once it pairs)
     * advertises; `pairing/` imports nothing, so it restates the ranks, and
     * this holds the two together — CGNAT included, which is where they would
     * most plausibly part.
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

describe('a host’s enumerated list, drawn into a code', () => {
  /*
   * THE LIST A HOST PRINTS IS THE LIST ITS CODE CARRIES. The enumeration makes
   * text, because an operator reads it; the codec carries bytes. The desktop
   * and the server both need that step, so it lives beside the enumeration in
   * the host (`pairingAddressesOf`), not once in each app.
   */
  const v4 = (address: string) => ({ address, family: 'IPv4', internal: false });
  const v6 = (address: string) => ({ address, family: 'IPv6', internal: false });

  it('turns each advertised address into the bytes the codec carries, in the same order', () => {
    const advertised: AdvertisedAddress[] = [
      { kind: 'ipv4', value: '192.168.1.10' },
      { kind: 'ipv6', value: 'fd00::5' },
      { kind: 'dns', value: 'Desk.Example.com.' },
      { kind: 'dns', value: 'desk.local' },
    ];
    const converted = pairingAddressesOf(advertised);
    expect(converted).toEqual([at('192.168.1.10'), at('fd00::5'), at('desk.example.com'), dns('desk.local')]);
    expect(converted.map((address) => address.kind)).toEqual([ADDRESS_IPV4, ADDRESS_IPV6, ADDRESS_DNS, ADDRESS_DNS]);
    // A `.local` name is carried the way a QR payload admits one (see
    // `local-name-unreachable` in typed.ts), and the fit ranks it link-local.
    expect(pairingAddressReach(converted[3]!)).toBe('link-local');
    expect(decodePairingUri(encodePairingUri(payload(converted))).addresses).toEqual(converted);
  });

  it('fits the 296-character cap and drops addresses from the least-reachable end', () => {
    const map: InterfaceMap = {
      en0: [v4('192.168.1.10'), v6('fd00:1::5'), v6('2001:db8:1:2::1')],
      en1: [v4('10.0.0.5'), v6('fd00:2::5'), v6('2001:db8:3:4::1')],
      wan: [v4('203.0.113.9'), v4('100.64.0.7')],
    };
    const advertised = advertisedAddresses(map);
    const texts = advertised.map((address) => address.value);
    expect(texts).toEqual([
      '10.0.0.5', '192.168.1.10', 'fd00:1::5', 'fd00:2::5', '100.64.0.7', '203.0.113.9', '2001:db8:1:2::1', '2001:db8:3:4::1',
    ]);
    const converted = pairingAddressesOf(advertised);
    expect(MAX_PAIRING_URI_LENGTH).toBe(296);

    // Beside a short name all eight fit, and none is dropped.
    expect(fitPairingPayload(payload(converted, 'Desk', HOST_SERVER)).addresses).toEqual(converted);

    // Beside the whole 64-byte name they do not, so some give way…
    const tight = payload(converted, 'x'.repeat(MAX_NAME_BYTES), HOST_SERVER);
    expect(reasonOf(() => encodePairingUri(tight))).toBe('too-long');
    const fitted = fitPairingPayload(tight);
    expect(encodePairingUri(fitted).length).toBeLessThanOrEqual(MAX_PAIRING_URI_LENGTH);
    const kept = fitted.addresses.length;
    expect(kept).toBeGreaterThan(0);
    expect(kept).toBeLessThan(converted.length);
    // …from the END: what stays is the first `kept`, the same objects in order,
    fitted.addresses.forEach((address, i) => expect(address, texts[i]).toBe(converted[i]));
    // one more would not have fit,
    expect(reasonOf(() => encodePairingUri({ ...tight, addresses: converted.slice(0, kept + 1) }))).toBe('too-long');
    // and what went is the least reachable: the global IPv6 addresses.
    expect(texts.slice(kept)).toEqual(['2001:db8:1:2::1', '2001:db8:3:4::1']);
  });

  it('refuses text a code could not carry as written, rather than dropping or reinterpreting it', () => {
    const reason = (address: AdvertisedAddress): unknown => {
      try {
        pairingAddressesOf([address]);
        return null;
      } catch (error) {
        if (error instanceof TypedEntryError) return error.reason;
        throw error;
      }
    };
    // A port has nowhere to go: a code carries one port for all its addresses.
    expect(reason({ kind: 'ipv4', value: '192.168.1.10:8973' })).toBe('bad-ipv4');
    expect(reason({ kind: 'dns', value: 'desk.lan:8973' })).toBe('bad-dns-name');
    expect(reason({ kind: 'ipv6', value: '[fd00::5]:8973' })).toBe('bad-ipv6');
    expect(reason({ kind: 'ipv6', value: '[fd00::5]' })).toBe('bad-ipv6');
    // A zone index names an interface on the host, which the phone does not have.
    expect(reason({ kind: 'ipv6', value: 'fe80::1%en0' })).toBe('zone-index-unsupported');
    // The kind an address claims is the kind it has to be.
    expect(reason({ kind: 'dns', value: '10.0.0.1' })).toBe('bad-dns-name');
    expect(reason({ kind: 'ipv4', value: 'fd00::5' })).toBe('bad-ipv4');
    expect(reason({ kind: 'ipv4', value: 'desk.lan' })).toBe('bad-ipv4');
    expect(reason({ kind: 'ipv6', value: '10.0.0.1' })).toBe('bad-ipv6');
    expect(reason({ kind: 'ipv6', value: 'a:b' })).toBe('bad-ipv6');
    expect(reason({ kind: 'ipv4', value: '010.0.0.1' })).toBe('bad-ipv4');
    // One bad entry refuses the list: a code without an address the operator
    // named is a code nobody asked for.
    expect(() =>
      pairingAddressesOf([{ kind: 'ipv4', value: '192.168.1.10' }, { kind: 'ipv4', value: '300.0.0.1' }]),
    ).toThrow(TypedEntryError);
    // Control: each shape above, written correctly, converts.
    for (const ok of [
      { kind: 'ipv4', value: '192.168.1.10' },
      { kind: 'dns', value: 'desk.lan' },
      { kind: 'ipv6', value: 'fd00::5' },
      { kind: 'ipv6', value: 'fe80::1' },
      { kind: 'ipv6', value: '::ffff:192.168.1.4' },
    ] as const) {
      expect(reason(ok), ok.value).toBeNull();
    }
    expect(pairingAddressesOf([])).toEqual([]);
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
    expect(pairingAddressReach(broken)).toBe('unroutable');
    const over = payload([...MEASURED_ADDRESSES.slice(0, 4), broken], 'x'.repeat(MAX_NAME_BYTES));
    expect(reasonOf(() => fitPairingPayload(over))).toBe('bad-address-length');
    // And with room to spare, where it would be dropped as unroutable instead.
    expect(reasonOf(() => fitPairingPayload(payload([LAN, broken])))).toBe('bad-address-length');
    const emptyName: PairingAddress = { kind: ADDRESS_DNS, value: new Uint8Array(0) };
    expect(reasonOf(() => fitPairingPayload(payload([LAN, emptyName])))).toBe('bad-address-length');
  });

  it('counts the addresses as given, before duplicates or unroutable ones are dropped', () => {
    const nine = [...Array.from({ length: MAX_ADDRESSES }, () => LAN), at('127.0.0.1')];
    expect(reasonOf(() => fitPairingPayload(payload(nine)))).toBe('too-many-addresses');
    expect(fitPairingPayload(payload(nine.slice(0, MAX_ADDRESSES))).addresses).toEqual([LAN]);
  });
});

describe('a code never carries an address no phone can dial, or the same address twice', () => {
  const UNROUTABLE = ['127.0.0.1', '127.1.2.3', '::1', '0.0.0.0', '::', '224.0.0.251', '239.255.255.250', '240.0.0.1', '255.255.255.255', 'ff02::1'];

  it('drops loopback, unspecified, multicast and reserved addresses even when there is room for them', () => {
    const host = [at('127.0.0.1'), LAN, at('::1'), at('0.0.0.0'), at('::'), at('224.0.0.251'), at('ff02::1'), ULA];
    const fitted = fitPairingPayload(payload(host));
    expect(label(fitted.addresses)).toEqual(['LAN', 'ULA']);
    expect(encodePairingUri(fitted).length).toBeLessThan(MAX_PAIRING_URI_LENGTH);
    // The control: every one of them is a well-formed address the encoder
    // would carry, so the fitter is what keeps them out.
    expect(reasonOf(() => encodePairingUri(payload(host)))).toBeNull();
  });

  it('keeps what can work on one network, when there is room: link-local of both families and a .local name', () => {
    const LINK4 = at('169.254.10.20');
    const MDNS = dns('desk.local');
    const name = labeller({ LAN, LINK, LINK4, MDNS });
    expect(name(fitPairingPayload(payload([MDNS, LINK4, at('127.0.0.1'), LINK, LAN])).addresses)).toEqual([
      'LAN',
      'MDNS',
      'LINK4',
      'LINK',
    ]);
  });

  it('refuses, naming why, when every address is one no phone can dial', () => {
    for (const text of UNROUTABLE) {
      expect(reasonOf(() => fitPairingPayload(payload([at(text)]))), text).toBe('no-usable-address');
    }
    expect(reasonOf(() => fitPairingPayload(payload(UNROUTABLE.slice(0, MAX_ADDRESSES).map(at))))).toBe('no-usable-address');
    const error = (() => {
      try {
        fitPairingPayload(payload([at('127.0.0.1')]));
        return null;
      } catch (caught) {
        return caught;
      }
    })();
    expect(error).toBeInstanceOf(PairingFitError);
    // The control: one address a phone could reach is enough.
    expect(label(fitPairingPayload(payload([at('127.0.0.1'), LINK])).addresses)).toEqual(['LINK']);
  });

  it('keeps the first of a repeated address, so a repeat cannot push a different route out', () => {
    const tight = 'x'.repeat(MAX_NAME_BYTES);
    const ULA_B = at('fd00::1');
    const ULA_C = at('fd00:0:0:0:0:0:0:1'); // the same sixteen bytes, written another way
    const ULA_D = at('fd00::1');
    const PUBLIC6 = at('2001:db8::1');
    const name = labeller({ LAN, ULA_B, ULA_C, ULA_D, PUBLIC6 });

    const fitted = fitPairingPayload(payload([ULA_B, ULA_C, ULA_D, ULA_B, LAN, PUBLIC6], tight));
    expect(name(fitted.addresses)).toEqual(['LAN', 'ULA_B', 'PUBLIC6']);
    expect(fitted.addresses[1]).toBe(ULA_B);
    // The control: without the repeats the same three fit, so it was the
    // repeats, not the budget, that would have cost PUBLIC6 its place.
    expect(name(fitPairingPayload(payload([ULA_B, LAN, PUBLIC6], tight)).addresses)).toEqual(['LAN', 'ULA_B', 'PUBLIC6']);
    // And the same bytes under a different kind are not a repeat.
    expect(fitPairingPayload(payload([at('10.0.0.1'), dns('\n\0\0')])).addresses).toHaveLength(2);
  });

  it('treats a DNS name as the same name in any ASCII case, and keeps the host’s spelling of the first', () => {
    const upper = dns('Desk.Example.COM');
    const lower = dns('desk.example.com');
    const other = dns('desk.example.org');
    const fitted = fitPairingPayload(payload([upper, lower, other]));
    expect(fitted.addresses).toEqual([upper, other]);
    expect(fitted.addresses[0]).toBe(upper);
  });
});
