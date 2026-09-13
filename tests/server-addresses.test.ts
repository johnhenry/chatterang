import { describe, expect, it } from 'vitest';

import {
  advertisedAddresses,
  describeAdvertised,
  MAX_ADVERTISED,
  type InterfaceMap,
} from '../apps/server/src/addresses.js';

/**
 * #252: a headless server that can name its own address.
 *
 * Driven with INJECTED interface maps, because the interesting cases are the
 * ones this build machine does not have — a link-local-only host, a host with
 * nine addresses, a host with nothing but loopback. A test that read the real
 * `os.networkInterfaces()` would assert whatever the CI runner happens to be.
 */

const v4 = (address: string, internal = false) => ({ address, family: 'IPv4', internal });
const v6 = (address: string, internal = false) => ({ address, family: 'IPv6', internal });

describe('what a phone could actually dial', () => {
  it('offers the LAN address and drops loopback', () => {
    const map: InterfaceMap = {
      lo0: [v4('127.0.0.1', true), v6('::1', true)],
      en0: [v4('192.168.1.10')],
    };
    expect(advertisedAddresses(map)).toEqual([{ kind: 'ipv4', value: '192.168.1.10' }]);
  });

  it('drops IPv4 link-local, which means DHCP failed rather than "reachable"', () => {
    const map: InterfaceMap = { en0: [v4('169.254.3.4'), v4('10.0.0.5')] };
    expect(advertisedAddresses(map)).toEqual([{ kind: 'ipv4', value: '10.0.0.5' }]);
  });

  it('drops IPv6 link-local, because its zone index is meaningless to the phone', () => {
    // fe80::/10 needs a scope id, and a scope id is local to the host that
    // wrote it — so the phone cannot act on the one we would send.
    const map: InterfaceMap = { en0: [v6('fe80::1%en0'), v6('fd00::5')] };
    expect(advertisedAddresses(map)).toEqual([{ kind: 'ipv6', value: 'fd00::5' }]);
  });

  it('strips a zone suffix from an address it does keep', () => {
    const map: InterfaceMap = { en0: [v6('fd00::5%en0')] };
    expect(advertisedAddresses(map)).toEqual([{ kind: 'ipv6', value: 'fd00::5' }]);
  });

  it('accepts the numeric family that node also uses', () => {
    // `os.networkInterfaces()` has reported family as both 'IPv4' and 4
    // across Node versions; reading only one spelling would silently classify
    // every v4 address as v6 and reorder the whole list.
    const map: InterfaceMap = { en0: [{ address: '192.168.1.10', family: 4, internal: false }] };
    expect(advertisedAddresses(map)).toEqual([{ kind: 'ipv4', value: '192.168.1.10' }]);
  });

  it('returns nothing when the machine has only loopback, rather than inventing one', () => {
    const map: InterfaceMap = { lo0: [v4('127.0.0.1', true)] };
    expect(advertisedAddresses(map)).toEqual([]);
  });
});

describe('order is a claim about reachability, best first', () => {
  it('puts a private LAN address ahead of a globally routable one', () => {
    const map: InterfaceMap = { en0: [v4('203.0.113.9'), v4('192.168.1.10')] };
    expect(advertisedAddresses(map).map((a) => a.value)).toEqual(['192.168.1.10', '203.0.113.9']);
  });

  it('ranks private v4, then unique-local v6, then public v4, then global v6', () => {
    const map: InterfaceMap = {
      a: [v4('203.0.113.9')],
      b: [v6('2001:db8::1')],
      c: [v6('fd00::5')],
      d: [v4('10.1.2.3')],
    };
    expect(advertisedAddresses(map).map((a) => a.value)).toEqual([
      '10.1.2.3', 'fd00::5', '203.0.113.9', '2001:db8::1',
    ]);
  });

  it('treats every private v4 block as private, not just 192.168', () => {
    for (const address of ['10.0.0.1', '172.16.0.1', '172.31.255.254', '192.168.0.1']) {
      const map: InterfaceMap = { a: [v4('203.0.113.9')], b: [v4(address)] };
      expect(advertisedAddresses(map)[0]?.value).toBe(address);
    }
    // And 172.32 is NOT private — the block ends at 172.31.
    const outside: InterfaceMap = { a: [v4('172.32.0.1')], b: [v4('192.168.0.1')] };
    expect(advertisedAddresses(outside)[0]?.value).toBe('192.168.0.1');
  });

  it('caps the list at what #134’s payload can carry', () => {
    const map: InterfaceMap = {
      en0: Array.from({ length: 12 }, (_, i) => v4(`192.168.1.${i + 10}`)),
    };
    expect(advertisedAddresses(map)).toHaveLength(MAX_ADVERTISED);
  });

  it('offers one address per IPv6 /64, not every privacy-extension temporary', () => {
    /*
     * FOUND BY RUNNING IT AGAINST A REAL MACHINE, which the injected maps
     * above cannot show. IPv6 privacy extensions hand out several temporary
     * addresses in the same /64; this machine had four. They reach the same
     * network by the same route, so advertising all of them consumed half of
     * #134's eight-address budget and multiplied #252's topology leak while
     * buying no extra chance of connecting.
     */
    const map: InterfaceMap = {
      en0: [
        v6('2001:db8:1:2::1'),
        v6('2001:db8:1:2:aaaa:bbbb:cccc:dddd'),
        v6('2001:db8:1:2:1111:2222:3333:4444'),
        v6('2001:db8:9:9::1'),
      ],
    };
    const out = advertisedAddresses(map).map((a) => a.value);
    expect(out).toHaveLength(2);
    expect(out).toContain('2001:db8:1:2::1');
    expect(out).toContain('2001:db8:9:9::1');
  });

  it('expands :: before comparing, so a compressed address is the same /64', () => {
    /*
     * THE CASE THE FIRST VERSION OF THESE TESTS MISSED, found by mutation:
     * every address above happened to put `::` AFTER the fourth group, where
     * expansion changes nothing, so dropping the expansion entirely left the
     * suite green. `2001:db8::1` is `2001:db8:0:0:…` — the same /64 as the
     * second address here — and only an expanded comparison sees that.
     */
    const map: InterfaceMap = {
      en0: [v6('2001:db8::1'), v6('2001:db8:0:0:aaaa:bbbb:cccc:dddd')],
    };
    expect(advertisedAddresses(map)).toHaveLength(1);

    // And a genuinely different /64 still survives, so this is not collapsing
    // everything that starts with the same two groups.
    const other: InterfaceMap = { en0: [v6('2001:db8::1'), v6('2001:db8:1:0::9')] };
    expect(advertisedAddresses(other)).toHaveLength(2);
  });

  it('does not collapse two IPv4 addresses, which are normally two networks', () => {
    // The v6 rule above must not become a v4 rule: two v4 addresses on one
    // machine usually mean two different networks, which is the case worth
    // carrying.
    const map: InterfaceMap = { en0: [v4('192.168.1.10')], en1: [v4('10.0.0.5')] };
    expect(advertisedAddresses(map)).toHaveLength(2);
  });

  it('does not offer the same address twice because two interfaces report it', () => {
    const map: InterfaceMap = { en0: [v4('192.168.1.10')], bridge0: [v4('192.168.1.10')] };
    expect(advertisedAddresses(map)).toHaveLength(1);
  });
});

describe('the operator’s answer replaces ours', () => {
  it('uses only the override, never appending the guess to it', () => {
    /*
     * A list that appended the enumeration to the override would re-leak
     * exactly what an operator setting this flag is usually trying not to
     * publish — and would do it invisibly, because the flag appeared honoured.
     */
    const map: InterfaceMap = { en0: [v4('192.168.1.10'), v4('203.0.113.9')] };
    expect(advertisedAddresses(map, 'desk.example.com')).toEqual([
      { kind: 'dns', value: 'desk.example.com' },
    ]);
  });

  it('classifies what the operator typed', () => {
    const none: InterfaceMap = {};
    expect(advertisedAddresses(none, '10.0.0.4')[0]?.kind).toBe('ipv4');
    expect(advertisedAddresses(none, 'fd00::9')[0]?.kind).toBe('ipv6');
    expect(advertisedAddresses(none, 'desk.local')[0]?.kind).toBe('dns');
  });

  it('ignores an empty or blank override rather than advertising nothing', () => {
    const map: InterfaceMap = { en0: [v4('192.168.1.10')] };
    expect(advertisedAddresses(map, '')).toHaveLength(1);
    expect(advertisedAddresses(map, '   ')).toHaveLength(1);
  });
});

describe('the confirm half, which is what keeps enumeration honest', () => {
  it('prints what will be advertised, so a wrong guess is visible', () => {
    // #252's objection to a silent --advertise is that a wrong value fails
    // invisibly. Enumeration earns its place by being printed.
    const lines = describeAdvertised([{ kind: 'ipv4', value: '192.168.1.10' }], false);
    expect(lines.join(' ')).toContain('192.168.1.10');
    expect(lines.join(' ')).toContain('--advertise');
  });

  it('says so when the operator overrode it, and stops offering advice', () => {
    const lines = describeAdvertised([{ kind: 'dns', value: 'desk.example.com' }], true);
    expect(lines.join(' ')).toContain('--advertise');
    expect(lines.join(' ')).toContain('desk.example.com');
    expect(lines).toHaveLength(1);
  });

  it('says pairing will not work when there is nothing to advertise', () => {
    // Silence here would ship codes with an empty address list and a phone
    // with nowhere to dial.
    const lines = describeAdvertised([], false);
    expect(lines.join(' ')).toContain('will not work');
    expect(lines.join(' ')).toContain('--advertise');
  });
});
