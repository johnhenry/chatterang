// @vitest-environment node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  ADDRESS_DNS,
  ADDRESS_IPV4,
  ADDRESS_IPV6,
  HOST_DESKTOP,
  HOST_SERVER,
  MAX_ADDRESSES,
  MAX_NAME_BYTES,
  MAX_PAIRING_URI_LENGTH,
  PAIRING_SCHEME,
  PAIRING_VERSION,
  PairingParseError,
  TRUST_SPKI_PIN,
  TRUST_STATIC_KEY,
  decodePairingUri,
  encodePairingUri,
  isExpired,
  isMulticastDnsName,
  type PairingAddress,
  type PairingPayload,
} from '@chatterang/tunnel/pairing';

import { uncappedPairingUri } from './support/uncapped-pairing-uri';

/**
 * #134. The payload a pairing QR carries.
 *
 * THE FAILURE MODE THIS FILE IS WRITTEN AGAINST is a parser that accepts more
 * than it should. Every refusal below is paired with the same shape being
 * ACCEPTED one step inside the bound, because a codec that rejects everything
 * passes every rejection test ever written — the same discipline
 * `tests/mcp-schema.test.ts` and `tests/desktop-mounts.test.ts` use, and for
 * the same reason.
 */

const TRUST = new Uint8Array(32).fill(0xab);
const TOKEN = new Uint8Array(32).fill(0xcd);
const V4 = (a: number, b: number, c: number, d: number): PairingAddress => ({
  kind: ADDRESS_IPV4,
  value: new Uint8Array([a, b, c, d]),
});
const DNS = (name: string): PairingAddress => ({
  kind: ADDRESS_DNS,
  value: new Uint8Array([...name].map((ch) => ch.charCodeAt(0))),
});

function payload(overrides: Partial<PairingPayload> = {}): PairingPayload {
  return {
    version: PAIRING_VERSION,
    hostKind: HOST_DESKTOP,
    trustMode: TRUST_SPKI_PIN,
    trust: TRUST,
    token: TOKEN,
    expiresAt: 1_800_000_000,
    port: 8973,
    addresses: [V4(192, 168, 1, 4)],
    name: "John's MacBook",
    ...overrides,
  };
}

/** Re-encode a decoded payload, which is what "canonical" has to mean. */
const roundTrip = (value: PairingPayload) => decodePairingUri(encodePairingUri(value));

describe('the payload round-trips', () => {
  it('preserves every field exactly', () => {
    const original = payload();
    const back = roundTrip(original);
    expect(back.version).toBe(PAIRING_VERSION);
    expect(back.hostKind).toBe(HOST_DESKTOP);
    expect(back.trustMode).toBe(TRUST_SPKI_PIN);
    expect([...back.trust]).toEqual([...TRUST]);
    expect([...back.token]).toEqual([...TOKEN]);
    expect(back.expiresAt).toBe(1_800_000_000);
    expect(back.port).toBe(8973);
    expect(back.name).toBe("John's MacBook");
    expect(back.addresses).toHaveLength(1);
    expect([...back.addresses[0]!.value]).toEqual([192, 168, 1, 4]);
  });

  it('is canonical: encoding a decoded payload gives the identical string', () => {
    // The property a fixed-order binary format exists to have, and the one a
    // JSON payload could not: one payload, one spelling.
    const uri = encodePairingUri(payload());
    expect(encodePairingUri(decodePairingUri(uri))).toBe(uri);
  });

  it('carries a headless server as a different host kind from a desktop', () => {
    // #124's ruling: the phone has to know what it paired with. #251 records
    // that `reachPaired()` reports `paired` for a host that may be somebody
    // else's machine, and it cannot be inferred from the address — a desktop
    // and a server can both be at 192.168.1.4.
    expect(roundTrip(payload({ hostKind: HOST_SERVER })).hostKind).toBe(HOST_SERVER);
    expect(roundTrip(payload({ hostKind: HOST_DESKTOP })).hostKind).toBe(HOST_DESKTOP);
  });

  it('carries every address kind, and several at once', () => {
    const addresses = [
      V4(10, 0, 0, 2),
      { kind: ADDRESS_IPV6, value: new Uint8Array(16).fill(7) } as PairingAddress,
      DNS('desk.tailnet.ts.net'),
    ];
    const back = roundTrip(payload({ addresses, name: 'srv' }));
    expect(back.addresses.map((a) => a.kind)).toEqual([ADDRESS_IPV4, ADDRESS_IPV6, ADDRESS_DNS]);
    expect([...back.addresses[1]!.value]).toEqual([...new Uint8Array(16).fill(7)]);
  });

  it('preserves a non-ASCII device name', () => {
    // UTF-8 is hand-rolled in this module (no TextEncoder), so this is the
    // test that the hand-rolling is right rather than merely present.
    for (const name of ['Ægir’s Mac', '桌面', 'Café — 🖥️', 'Ünïcôdé']) {
      expect(roundTrip(payload({ name })).name, name).toBe(name);
    }
  });

  it('round-trips every byte value through base64url', () => {
    // Base64 is also hand-rolled. Exhaustive over all 256 values and over
    // every length remainder mod 3, which is where a hand-rolled encoder
    // actually breaks.
    for (const length of [30, 31, 32]) {
      const trust = new Uint8Array(32);
      for (let i = 0; i < 32; i += 1) trust[i] = (i * 7 + length) & 0xff;
      const token = new Uint8Array(32);
      for (let i = 0; i < 32; i += 1) token[i] = 255 - i;
      const back = roundTrip(payload({ trust, token, name: 'x'.repeat(length % 8 || 1) }));
      expect([...back.trust], `length ${length}`).toEqual([...trust]);
      expect([...back.token]).toEqual([...token]);
    }
  });
});

describe('the parser refuses what it does not fully understand', () => {
  /** Flip one byte of the base64url body, keeping it valid base64url. */
  function tamper(uri: string, index: number): string {
    const prefix = `${PAIRING_SCHEME}:`;
    const body = uri.slice(prefix.length);
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const at = alphabet.indexOf(body[index]!);
    const swapped = alphabet[(at + 1) % 64]!;
    return prefix + body.slice(0, index) + swapped + body.slice(index + 1);
  }

  it('refuses a URI that is not one of ours, and accepts one that is', () => {
    for (const uri of ['', 'https://example.com/x', 'chatterang-pairing:AAAA', 'AAAA']) {
      expect(() => decodePairingUri(uri), uri).toThrow(PairingParseError);
    }
    expect(() => decodePairingUri(encodePairingUri(payload()))).not.toThrow();
  });

  it('refuses an unknown version before it reads anything else', () => {
    /*
     * The reason the version is byte zero. A future payload may reorder every
     * field after it; reading further to produce a nicer message would be
     * reading a format this parser does not know.
     */
    const uri = encodePairingUri(payload());
    const bumped = tamper(uri, 0);
    const error = (() => {
      try {
        decodePairingUri(bumped);
        return null;
      } catch (caught) {
        return caught as PairingParseError;
      }
    })();
    expect(error?.reason).toBe('unknown-version');
    // The control: version 1 is accepted.
    expect(decodePairingUri(uri).version).toBe(PAIRING_VERSION);
  });

  it('refuses a truncated payload at every length, and accepts the whole one', () => {
    const uri = encodePairingUri(payload());
    const body = uri.slice(`${PAIRING_SCHEME}:`.length);
    for (let cut = 1; cut < body.length; cut += 1) {
      expect(
        () => decodePairingUri(`${PAIRING_SCHEME}:${body.slice(0, cut)}`),
        `accepted a payload cut to ${cut} chars`,
      ).toThrow(PairingParseError);
    }
    expect(() => decodePairingUri(uri)).not.toThrow();
  });

  it('refuses trailing bytes rather than ignoring them', () => {
    /*
     * The property a canonical encoding exists to have. Ignoring them accepts
     * two byte strings that decode to one payload — and is how a field added
     * by a newer version gets silently discarded by an older parser that
     * should have refused the whole code.
     */
    const uri = encodePairingUri(payload());
    // Four more base64url characters is three more bytes, which keeps the
    // body well-formed and the payload over-long.
    const error = (() => {
      try {
        decodePairingUri(`${uri}AAAA`);
        return null;
      } catch (caught) {
        return caught as PairingParseError;
      }
    })();
    expect(error?.reason).toBe('trailing-bytes');
  });

  it('refuses a character that is not base64url', () => {
    const uri = encodePairingUri(payload());
    for (const bad of ['+', '/', '=', '!', ' ']) {
      expect(() => decodePairingUri(uri + bad), bad).toThrow(PairingParseError);
    }
  });

  it('notices a tampered field rather than decoding it silently', () => {
    /*
     * WHAT THIS TEST DOES AND DOES NOT CLAIM. There is no signature — see the
     * module header for the argument — so tampering is not DETECTED
     * cryptographically. What is asserted is weaker and still worth having:
     * a changed byte either produces a different payload the caller can see,
     * or is refused by a bound. It never silently yields the original.
     */
    const original = payload();
    const uri = encodePairingUri(original);
    const body = uri.slice(`${PAIRING_SCHEME}:`.length);
    let differed = 0;
    for (let i = 0; i < body.length; i += 1) {
      const changed = tamper(uri, i);
      try {
        const back = decodePairingUri(changed);
        expect(JSON.stringify(back), `byte ${i} decoded identically`).not.toBe(
          JSON.stringify(decodePairingUri(uri)),
        );
        differed += 1;
      } catch {
        differed += 1;
      }
    }
    expect(differed).toBe(body.length);
  });

  it('refuses an unknown host kind and an unknown trust mode, and accepts the known ones', () => {
    for (const hostKind of [0, 3, 255]) {
      expect(() => encodePairingUri(payload({ hostKind: hostKind as never }))).toThrow(
        PairingParseError,
      );
    }
    for (const trustMode of [0, 3, 255]) {
      expect(() => encodePairingUri(payload({ trustMode: trustMode as never }))).toThrow(
        PairingParseError,
      );
    }
    // Both known trust modes survive: #154 owns the default, and a
    // one-value enumeration would be a constant with extra steps.
    expect(roundTrip(payload({ trustMode: TRUST_SPKI_PIN })).trustMode).toBe(TRUST_SPKI_PIN);
    expect(roundTrip(payload({ trustMode: TRUST_STATIC_KEY })).trustMode).toBe(TRUST_STATIC_KEY);
  });

  it('refuses an address whose length does not match its kind', () => {
    const wrong: PairingAddress[] = [
      { kind: ADDRESS_IPV4, value: new Uint8Array(3) },
      { kind: ADDRESS_IPV4, value: new Uint8Array(16) },
      { kind: ADDRESS_IPV6, value: new Uint8Array(4) },
      { kind: ADDRESS_DNS, value: new Uint8Array(0) },
    ];
    for (const address of wrong) {
      expect(() => encodePairingUri(payload({ addresses: [address] })), String(address.kind))
        .toThrow(PairingParseError);
    }
    // The controls, one per kind, at the length that is right.
    expect(() => encodePairingUri(payload({ addresses: [V4(1, 2, 3, 4)] }))).not.toThrow();
    expect(() =>
      encodePairingUri(payload({ addresses: [{ kind: ADDRESS_IPV6, value: new Uint8Array(16) }] })),
    ).not.toThrow();
    expect(() => encodePairingUri(payload({ addresses: [DNS('a')] }))).not.toThrow();
  });

  it('bounds the address count and the name, and accepts the value at the bound', () => {
    const one = V4(1, 2, 3, 4);
    expect(() => encodePairingUri(payload({ addresses: [] }))).toThrow(PairingParseError);
    expect(() =>
      encodePairingUri(payload({ addresses: Array(MAX_ADDRESSES + 1).fill(one), name: 'x' })),
    ).toThrow(PairingParseError);
    // At the bound, not past it.
    expect(() =>
      encodePairingUri(payload({ addresses: Array(MAX_ADDRESSES).fill(one), name: 'x' })),
    ).not.toThrow();

    expect(() => encodePairingUri(payload({ name: '' }))).toThrow(PairingParseError);
    expect(() => encodePairingUri(payload({ name: 'x'.repeat(MAX_NAME_BYTES + 1) }))).toThrow(
      PairingParseError,
    );
    expect(() => encodePairingUri(payload({ name: 'x'.repeat(MAX_NAME_BYTES) }))).not.toThrow();
  });

  it('refuses malformed UTF-8 in the name rather than replacing it', () => {
    /*
     * An overlong encoding and a surrogate are two ways to spell one string,
     * which a canonical format cannot have. Built by hand because no encoder
     * would produce them.
     */
    const uri = encodePairingUri(payload({ name: 'ab', addresses: [V4(1, 2, 3, 4)] }));
    const prefix = `${PAIRING_SCHEME}:`;
    const bytes = [...atob(uri.slice(prefix.length).replace(/-/g, '+').replace(/_/g, '/'))].map(
      (ch) => ch.charCodeAt(0),
    );
    // The name is the last two bytes; replace with an overlong 'a' (C1 81).
    const overlong = [...bytes.slice(0, -2), 0xc1, 0x81];
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    let encoded = '';
    for (let i = 0; i < overlong.length; i += 3) {
      const [a, b, c] = [overlong[i]!, overlong[i + 1], overlong[i + 2]];
      encoded += alphabet[a >> 2]! + alphabet[((a & 3) << 4) | ((b ?? 0) >> 4)]!;
      if (b === undefined) break;
      encoded += alphabet[((b & 15) << 2) | ((c ?? 0) >> 6)]!;
      if (c === undefined) break;
      encoded += alphabet[c & 63]!;
    }
    expect(() => decodePairingUri(prefix + encoded)).toThrow(PairingParseError);
  });
});

describe('expiry is separate from parsing', () => {
  it('parses an expired code and reports it expired', () => {
    /*
     * Deliberately not the parser's job. "The code is stale" tells the user to
     * try again; "the code is malformed" tells them something is wrong. A
     * parser that consulted a clock could also not be tested without one.
     */
    const stale = payload({ expiresAt: 1_000 });
    const back = roundTrip(stale);
    expect(back.expiresAt).toBe(1_000);
    expect(isExpired(back, 1_001)).toBe(true);
    expect(isExpired(back, 999)).toBe(false);
    // The boundary is inclusive: a code expiring exactly now is expired.
    expect(isExpired(back, 1_000)).toBe(true);
  });

  it('carries an absolute time large enough not to wrap in this app’s lifetime', () => {
    // u32 seconds: valid to 2106. Four bytes rather than eight, because a code
    // that expires in ninety seconds has no use for milliseconds.
    const far = roundTrip(payload({ expiresAt: 4_000_000_000 }));
    expect(far.expiresAt).toBe(4_000_000_000);
    expect(() => encodePairingUri(payload({ expiresAt: 0x1_0000_0000 }))).toThrow(
      PairingParseError,
    );
  });
});

describe('the size budget', () => {
  it('a realistic desktop code is well inside it', () => {
    const uri = encodePairingUri(payload());
    expect(uri.length).toBeLessThanOrEqual(MAX_PAIRING_URI_LENGTH);
    // #134 budgeted "roughly 130-170 characters" for this exact shape — one
    // address, one 32-byte trust field, one token — and it lands there.
    expect(uri.length).toBeLessThan(180);
  });

  it('the worst case a host can legitimately draw still fits', () => {
    /*
     * The case that actually bounds the format: a server offering everything
     * it might be reachable at. #252 says it cannot enumerate its interfaces
     * yet, so this is the shape to budget against rather than the one that
     * exists today.
     */
    const worst = payload({
      hostKind: HOST_SERVER,
      addresses: [
        V4(192, 168, 1, 4),
        V4(10, 0, 0, 2),
        { kind: ADDRESS_IPV6, value: new Uint8Array(16).fill(0xfe) },
        DNS('chatterang-host.tailnet-abcd.ts.net'),
      ],
      name: 'x'.repeat(MAX_NAME_BYTES),
    });
    const uri = encodePairingUri(worst);
    expect(uri.length).toBeLessThanOrEqual(MAX_PAIRING_URI_LENGTH);
    expect(decodePairingUri(uri).addresses).toHaveLength(4);
  });

  it('refuses to draw a code over the budget, at encode time', () => {
    /*
     * ENFORCED WHERE THE CODE IS MADE. A host that can draw an unscannable
     * code puts the failure in front of a person holding a phone at a screen,
     * which is the worst place for it and the hardest to diagnose.
     */
    const huge = payload({
      addresses: Array.from({ length: MAX_ADDRESSES }, () => DNS('a'.repeat(255))),
      name: 'x'.repeat(MAX_NAME_BYTES),
    });
    const error = (() => {
      try {
        encodePairingUri(huge);
        return null;
      } catch (caught) {
        return caught as PairingParseError;
      }
    })();
    expect(error?.reason).toBe('too-long');
  });

  it('the bound is a real constraint, not a number nothing approaches', () => {
    // A budget no payload can reach is not a budget. The worst legitimate
    // case above must use a meaningful fraction of it, or the cap is
    // decoration and would not catch a format that grew.
    const worst = encodePairingUri(
      payload({
        addresses: [
          V4(1, 2, 3, 4),
          { kind: ADDRESS_IPV6, value: new Uint8Array(16) },
          DNS('chatterang-host.tailnet-abcd.ts.net'),
        ],
        name: 'x'.repeat(MAX_NAME_BYTES),
      }),
    );
    expect(worst.length).toBeGreaterThan(MAX_PAIRING_URI_LENGTH / 2);
  });

  describe('is 296 characters, so every code draws at QR version 13 (ruled on #127)', () => {
    /*
     * One IPv4 and four IPv6 addresses: with a 57-byte name the URI is exactly
     * 296 characters, and each byte more of name adds a character or two —
     * 298, 299, 300, the lengths the old cap of 300 admitted and an 80-column
     * terminal cannot show. `tests/pairing-frames.test.ts` measures the QR
     * versions; this pins the cap on both sides of the codec.
     */
    const five = [
      V4(192, 168, 1, 23),
      ...[1, 2, 3, 4].map((n): PairingAddress => ({ kind: ADDRESS_IPV6, value: new Uint8Array(16).fill(n) })),
    ];
    const at = (nameBytes: number) => payload({ hostKind: HOST_SERVER, addresses: five, name: 'n'.repeat(nameBytes) });
    const reasonOf = (run: () => unknown): unknown => {
      try {
        run();
        return null;
      } catch (error) {
        return error instanceof PairingParseError ? error.reason : error;
      }
    };

    it('is the number the ruling names', () => {
      expect(MAX_PAIRING_URI_LENGTH).toBe(296);
    });

    it('encodes and decodes a 296-character code', () => {
      const edge = encodePairingUri(at(57));
      expect(edge).toHaveLength(296);
      expect(decodePairingUri(edge).name).toBe('n'.repeat(57));
    });

    it('refuses to encode 298, 299 or 300 characters', () => {
      for (const [nameBytes, length] of [[58, 298], [59, 299], [60, 300]] as const) {
        expect(uncappedPairingUri(at(nameBytes)), `${nameBytes}-byte name`).toHaveLength(length);
        expect(reasonOf(() => encodePairingUri(at(nameBytes))), `${length} characters`).toBe('too-long');
      }
    });

    it('refuses to decode them too, so the phone and the screen agree where the edge is', () => {
      // The helper writes exactly what the encoder writes, where the encoder will write it.
      expect(uncappedPairingUri(at(57))).toBe(encodePairingUri(at(57)));
      expect(uncappedPairingUri(at(1))).toBe(encodePairingUri(at(1)));
      for (const nameBytes of [58, 59, 60]) {
        const uri = uncappedPairingUri(at(nameBytes));
        expect(reasonOf(() => decodePairingUri(uri)), `${uri.length} characters`).toBe('too-long');
      }
      // 297 characters is a length no payload encodes to, and it is refused for
      // its length before its malformed body is read.
      const edge = encodePairingUri(at(57));
      expect(reasonOf(() => decodePairingUri(`${edge}A`))).toBe('too-long');
    });
  });
});

describe('the .local question, answered in one place', () => {
  it('parses a .local name and reports it as one', () => {
    /*
     * #134 asks for a one-line statement so #222 and #165 have something to
     * point at. The GRAMMAR admits it — it is syntactically a DNS name, and a
     * parser that special-cased one suffix would be lying about what it
     * accepts. The TRANSPORT does not resolve it in v1, so a code carrying
     * only this pairs and then fails to connect.
     */
    const address = DNS('johns-macbook.local');
    const back = roundTrip(payload({ addresses: [address] }));
    expect(back.addresses[0]!.kind).toBe(ADDRESS_DNS);
    expect(isMulticastDnsName(back.addresses[0]!)).toBe(true);
  });

  it('does not call anything else multicast DNS', () => {
    expect(isMulticastDnsName(DNS('desk.tailnet.ts.net'))).toBe(false);
    expect(isMulticastDnsName(DNS('local'))).toBe(false);
    expect(isMulticastDnsName(DNS('notlocal'))).toBe(false);
    expect(isMulticastDnsName(V4(192, 168, 1, 4))).toBe(false);
    // Case-insensitive, because DNS is.
    expect(isMulticastDnsName(DNS('Desk.LOCAL'))).toBe(true);
  });
});

describe('the module depends on nothing', () => {
  it('names no import at all, like the wire half', () => {
    // Asserted here as well as in tests/layering.test.ts because THIS is the
    // file that explains why: #223 says the app supports runtimes nobody has
    // measured, and this is the one component that has to work on all of them.
    // A parser that needs a modern global fails on exactly the old phone whose
    // user is trying to pair it.
    const source = readFileSync(
      resolve(process.cwd(), 'packages/tunnel/src/pairing/index.ts'),
      'utf8',
    );
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
    expect(code).not.toMatch(/\bimport\b/);
    for (const global of ['btoa', 'atob', 'Buffer', 'TextEncoder', 'TextDecoder', 'crypto']) {
      expect(code, `pairing/index.ts reaches for ${global}`).not.toContain(global);
    }
  });
});
