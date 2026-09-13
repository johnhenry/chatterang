// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { DEFAULT_PORT } from '@chatterang/server';
import {
  ADDRESS_DNS,
  ADDRESS_IPV4,
  ADDRESS_IPV6,
  DEFAULT_PAIRING_PORT,
  HOST_DESKTOP,
  TRUST_SPKI_PIN,
  TypedEntryError,
  decodePairingUri,
  encodePairingUri,
  normalizeTypedCode,
  parseTypedEndpoint,
  type TypedEntryReason,
} from '@chatterang/tunnel/pairing';

/**
 * #130: the typed pairing route — a host beside six digits, port default 8973.
 *
 * Every refusal is paired with the nearest shape that is accepted, because a
 * parser that refuses everything passes every refusal test ever written.
 */

const ascii = (bytes: Uint8Array): string => String.fromCharCode(...bytes);

function refused(text: string): TypedEntryReason | 'accepted' {
  try {
    parseTypedEndpoint(text);
    return 'accepted';
  } catch (error) {
    if (error instanceof TypedEntryError) return error.reason;
    throw error;
  }
}

describe('the port', () => {
  it('defaults to the same number the headless server listens on', () => {
    // The pairing half may not import the server, so the constant is written
    // twice. This is what stops the two drifting apart silently.
    expect(DEFAULT_PAIRING_PORT).toBe(DEFAULT_PORT);
    expect(parseTypedEndpoint('desk.lan').port).toBe(DEFAULT_PORT);
  });

  it('takes an explicit port, which pairing with a desktop needs', () => {
    // #158 rules the desktop's listener port ephemeral, so the default only
    // ever finds a headless server.
    expect(parseTypedEndpoint('192.168.1.4:51234').port).toBe(51234);
    expect(parseTypedEndpoint('desk.lan:1').port).toBe(1);
    expect(parseTypedEndpoint('desk.lan:65535').port).toBe(65535);
  });

  it('refuses a port outside 1..65535, empty, signed, or with a leading zero', () => {
    for (const text of ['desk.lan:0', 'desk.lan:65536', 'desk.lan:', 'desk.lan:+80', 'desk.lan:08973', 'desk.lan:80a']) {
      expect(refused(text), text).toBe('bad-port');
    }
  });
});

describe('IPv4', () => {
  it('reads four octets into four bytes', () => {
    const { address } = parseTypedEndpoint('192.168.1.4');
    expect(address.kind).toBe(ADDRESS_IPV4);
    expect([...address.value]).toEqual([192, 168, 1, 4]);
    expect([...parseTypedEndpoint('0.0.0.0').address.value]).toEqual([0, 0, 0, 0]);
  });

  it('refuses an octet over 255, the wrong count, or a leading zero', () => {
    // A leading zero is refused rather than read, because some resolvers read
    // it as OCTAL — "010" is ambiguous between 10 and 8.
    for (const text of ['256.1.1.1', '1.2.3', '1.2.3.4.5', '01.2.3.4', '1..2.3', '1.2.3.']) {
      expect(refused(text), text).toBe('bad-ipv4');
    }
  });
});

describe('IPv6', () => {
  it('reads a compressed address, bare or bracketed', () => {
    const expected = [0xfe, 0x80, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1];
    for (const text of ['fe80::1', '[fe80::1]', '[fe80::1]:8973', 'FE80::1']) {
      const { address } = parseTypedEndpoint(text);
      expect(address.kind, text).toBe(ADDRESS_IPV6);
      expect([...address.value], text).toEqual(expected);
    }
    expect(parseTypedEndpoint('[fe80::1]:51234').port).toBe(51234);
  });

  it('reads the full form, the loopback, and an embedded IPv4 tail', () => {
    expect([...parseTypedEndpoint('2001:db8:0:0:0:0:0:1').address.value]).toEqual(
      [0x20, 0x01, 0x0d, 0xb8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
    );
    expect([...parseTypedEndpoint('::1').address.value]).toEqual([...new Array(15).fill(0), 1]);
    expect([...parseTypedEndpoint('::ffff:192.168.1.4').address.value]).toEqual(
      [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff, 192, 168, 1, 4],
    );
  });

  it('treats a bare address with a trailing group as an ADDRESS, not a port', () => {
    // `fe80::1:8973` is a valid address whose last group is 8973. Brackets are
    // the only unambiguous way to give IPv6 a port.
    const { address, port } = parseTypedEndpoint('fe80::1:8973');
    expect(port).toBe(DEFAULT_PAIRING_PORT);
    expect([...address.value].slice(12)).toEqual([0, 1, 0x89, 0x73]);
  });

  it('refuses a zone index by its own name, because the address has nowhere to carry it', () => {
    /*
     * `PairingAddress` holds sixteen bytes and no interface, and it is shared
     * with the QR payload. A zone the person typed would name the PHONE's
     * interface — so the earlier reason ("an interface on another machine")
     * was the server's reason, copied, and wrong here. A distinct reason lets
     * the screen say "remove the %en0 part" rather than "bad address".
     */
    expect(refused('fe80::1%en0')).toBe('zone-index-unsupported');
    expect(refused('[fe80::1%en0]:8973')).toBe('zone-index-unsupported');
    expect(refused('fe80::1%1')).toBe('zone-index-unsupported');
    // Paired control: the same address without the zone is accepted.
    expect(refused('fe80::1')).toBe('accepted');
    // And a `%` outside an IPv6 literal is not mistaken for a zone.
    expect(refused('desk%lan')).toBe('bad-dns-name');
  });

  it('refuses two ::, too many groups, an overlong group, or an unclosed bracket', () => {
    for (const text of ['1::2::3', '1:2:3:4:5:6:7:8:9', '1:2:3:4:5:6:7::8', '12345::1', '[fe80::1', '[fe80::1]x', 'fe80::g']) {
      expect(refused(text), text).toBe('bad-ipv6');
    }
  });
});

describe('DNS names', () => {
  it('reads a hostname as lowercase ASCII bytes', () => {
    const { address } = parseTypedEndpoint('Desk-2.LAN');
    expect(address.kind).toBe(ADDRESS_DNS);
    expect(ascii(address.value)).toBe('desk-2.lan');
  });

  it('accepts one trailing dot and drops it', () => {
    expect(ascii(parseTypedEndpoint('desk.lan.').address.value)).toBe('desk.lan');
  });

  it('accepts a 63-character label and refuses a 64-character one', () => {
    expect(refused(`${'a'.repeat(63)}.lan`)).toBe('accepted');
    expect(refused(`${'a'.repeat(64)}.lan`)).toBe('bad-dns-name');
  });

  it('refuses an underscore, an edge hyphen, an empty label, or a non-ASCII letter', () => {
    // The QR parser accepts any 1..255 bytes because the HOST wrote them. A
    // person typed these, and saying what is wrong beats a connection that
    // never completes.
    for (const text of ['desk_lan', '-desk.lan', 'desk-.lan', 'desk..lan', 'dësk.lan', 'desk lan']) {
      expect(refused(text), text).toBe('bad-dns-name');
    }
  });

  it('refuses a .local name by name, because v1 does not resolve multicast DNS', () => {
    expect(refused('desk.local')).toBe('local-name-unreachable');
    expect(refused('Desk.LOCAL:51234')).toBe('local-name-unreachable');
    // Paired control: a name merely CONTAINING "local" is fine.
    expect(refused('local.lan')).toBe('accepted');
  });
});

describe('empty input', () => {
  it('is refused as empty, including whitespace and a lone port', () => {
    for (const text of ['', '   ', ':8973']) expect(refused(text), JSON.stringify(text)).toBe('empty');
  });
});

describe('one shape for both routes', () => {
  it('produces an address the QR payload encodes and decodes unchanged', () => {
    /*
     * The point of emitting `PairingAddress` rather than a string: a future
     * controller dials ONE shape whichever route produced it. Proven by
     * putting each typed address through the QR codec and getting it back.
     */
    for (const text of ['192.168.1.4', 'fe80::1', 'desk.lan']) {
      const { address, port } = parseTypedEndpoint(text);
      const uri = encodePairingUri({
        version: 1,
        hostKind: HOST_DESKTOP,
        trustMode: TRUST_SPKI_PIN,
        trust: new Uint8Array(32).fill(1),
        token: new Uint8Array(32).fill(2),
        expiresAt: 1_900_000_000,
        port,
        addresses: [address],
        name: 'Desk',
      });
      const back = decodePairingUri(uri).addresses[0]!;
      expect(back.kind, text).toBe(address.kind);
      expect([...back.value], text).toEqual([...address.value]);
    }
  });
});

describe('the typed code', () => {
  it('strips spaces and hyphens, and returns a string', () => {
    expect(normalizeTypedCode('482913')).toBe('482913');
    expect(normalizeTypedCode('482 913')).toBe('482913');
    expect(normalizeTypedCode('482-913')).toBe('482913');
    expect(normalizeTypedCode(' 4-8 2 9-1 3 ')).toBe('482913');
  });

  it('keeps a leading zero, because CPace hashes the text', () => {
    // `012345` and `12345` are different secrets. A Number() on this path
    // would turn one into the other without any error.
    expect(normalizeTypedCode('012345')).toBe('012345');
    expect(typeof normalizeTypedCode('012345')).toBe('string');
  });

  it('refuses five or seven digits, letters, and look-alike digits', () => {
    // Full-width and Arabic-Indic digits render like ASCII and hash differently
    // from what the other screen displayed.
    for (const text of ['12345', '1234567', '48291a', '４８２９１３', '٤٨٢٩١٣', '', '482.913']) {
      expect(() => normalizeTypedCode(text), JSON.stringify(text)).toThrow(TypedEntryError);
    }
  });
});
