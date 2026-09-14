import { readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { decodePacketFromImageData, encodePacket } from '@johnhenry/oat-qr-fountain';
import {
  ADDRESS_DNS,
  ADDRESS_IPV4,
  ADDRESS_IPV6,
  HOST_DESKTOP,
  HOST_SERVER,
  MAX_ADDRESSES,
  MAX_NAME_BYTES,
  MAX_PAIRING_URI_LENGTH,
  PairingParseError,
  TRUST_SPKI_PIN,
  decodePairingUri,
  encodePairingUri,
  type PairingAddress,
  type PairingPayload,
} from '@chatterang/tunnel/pairing';
import { FountainDecoder, generatePackets, prepareSource, type OatPacket } from '@/lib/oat-fountain';
import {
  ARTIFACT_ID_BYTES,
  PAIRING_FRAME_EC_LEVEL,
  PAIRING_FRAME_QUIET_ZONE,
  framesForPairingUri,
  pairingUriToBytes,
  renderPairingFrame,
} from '@/lib/pairing-frames';
import { OAT_HEADER_BYTES, decodeFrame } from '@/lib/qr-decode';
import { classifyPacket, openFountainSession, pairingUriFromBytes } from '@/lib/qr-scan';

import { codeOf, sourceFiles } from './support/source-scan';
import { decodePngDataUrl, type Pixels } from './support/png';

/**
 * #127: THE PAIRING CODE AS OAT FRAMES, measured and read back from pixels.
 *
 * The owner ruled that the desktop draws the pairing payload with
 * `@johnhenry/oat-qr-fountain`. These tests are the measurement that ruling
 * asked for before a screen is built — how big a real payload's frame is and
 * what QR version it draws at — and the round trip the screen will depend on:
 * encode with `encodePairingUri`, frame, DRAW TO A PNG, decode the PNG's
 * pixels with the phone's own decoder, collect with OAT's decoder, parse.
 *
 * No step is skipped or stubbed, and the PNG is decoded by `support/png.ts`,
 * not by anything the code under test uses.
 */

const V4 = (...bytes: number[]): PairingAddress => ({ kind: ADDRESS_IPV4, value: Uint8Array.from(bytes) });
const V6 = (hex: string): PairingAddress => ({
  kind: ADDRESS_IPV6,
  value: Uint8Array.from(hex.match(/../g)!, (pair) => parseInt(pair, 16)),
});
const DNS = (name: string): PairingAddress => ({ kind: ADDRESS_DNS, value: Uint8Array.from(name, (c) => c.charCodeAt(0)) });

function payload(over: Partial<PairingPayload>): PairingPayload {
  return {
    version: 1,
    hostKind: HOST_DESKTOP,
    trustMode: TRUST_SPKI_PIN,
    // A pinned SPKI fingerprint and a token: 32 bytes each, values irrelevant to size.
    trust: Uint8Array.from({ length: 32 }, (_, i) => (i * 37 + 11) & 0xff),
    token: Uint8Array.from({ length: 32 }, (_, i) => (i * 91 + 200) & 0xff),
    expiresAt: 1_900_000_090,
    port: 51234,
    addresses: [V4(192, 168, 1, 4)],
    name: 'Desk',
    ...over,
  };
}

const LAN = V4(192, 168, 1, 23);
const ULA = V6('fd7a115cb1e0000000000000000a0b0c');
const GLOBAL = V6('2600170080a01e000000000000001234');
const LINK = V6('fe800000000000000000000000000001');
const ULA2 = V6('fd000000000000000000000000000002');

/**
 * THE MEASURED TABLE. `src/lib/pairing-frames.ts` and `MAX_PAIRING_URI_LENGTH`
 * quote these rows; if a number here changes, those comments are wrong.
 */
const MEASURED: readonly {
  readonly label: string;
  readonly payload: PairingPayload;
  readonly uri: number;
  readonly frame: number;
  readonly version: number;
}[] = [
  { label: 'desktop, one IPv4, "Desk"', payload: payload({}), uri: 130, frame: 164, version: 9 },
  {
    label: 'desktop, IPv4 + two IPv6, "John’s MacBook Pro"',
    payload: payload({ addresses: [LAN, ULA, GLOBAL], name: 'John’s MacBook Pro' }),
    uri: 199,
    frame: 233,
    version: 11,
  },
  {
    label: 'server, 3 IPv4 + 3 IPv6, "homelab"',
    payload: payload({
      hostKind: HOST_SERVER,
      addresses: [V4(192, 168, 1, 4), V4(10, 0, 0, 2), V4(100, 101, 102, 103), ULA, GLOBAL, LINK],
      name: 'homelab',
    }),
    uri: 222,
    frame: 256,
    version: 12,
  },
  {
    label: 'desktop, IPv4 + four IPv6, "John’s MacBook Pro"',
    payload: payload({ addresses: [LAN, ULA, GLOBAL, LINK, ULA2], name: 'John’s MacBook Pro' }),
    uri: 247,
    frame: 281,
    version: 12,
  },
  {
    label: 'desktop, IPv4 + two IPv6, 64-byte name',
    payload: payload({ addresses: [LAN, ULA, GLOBAL], name: 'x'.repeat(MAX_NAME_BYTES) }),
    uri: 258,
    frame: 292,
    version: 13,
  },
  {
    label: 'server, 2 IPv4 + IPv6 + tailnet DNS, 64-byte name',
    payload: payload({
      hostKind: HOST_SERVER,
      addresses: [V4(192, 168, 1, 4), V4(10, 0, 0, 2), V6('fefefefefefefefefefefefefefefefe'), DNS('chatterang-host.tailnet-abcd.ts.net')],
      name: 'x'.repeat(MAX_NAME_BYTES),
    }),
    uri: 291,
    frame: 325,
    version: 13,
  },
  {
    label: 'server, IPv4 + 4 IPv6, 57-byte name: the longest URI that stays at v13',
    payload: payload({ hostKind: HOST_SERVER, addresses: [LAN, ULA, GLOBAL, LINK, ULA2], name: 'n'.repeat(57) }),
    uri: 296,
    frame: 330,
    version: 13,
  },
  {
    label: 'server, IPv4 + 4 IPv6, 58-byte name: the next URI there is',
    payload: payload({ hostKind: HOST_SERVER, addresses: [LAN, ULA, GLOBAL, LINK, ULA2], name: 'n'.repeat(58) }),
    uri: 298,
    frame: 332,
    version: 14,
  },
  {
    label: 'server, IPv4 + 4 IPv6, 60-byte name: the cap',
    payload: payload({ hostKind: HOST_SERVER, addresses: [LAN, ULA, GLOBAL, LINK, ULA2], name: 'n'.repeat(60) }),
    uri: 300,
    frame: 334,
    version: 14,
  },
];

/**
 * The symbol's geometry, read from the pixels rather than from the encoder.
 *
 * The top-left finder pattern is seven modules wide, so its first dark run
 * gives the scale; where it starts gives the quiet zone; the rest follows.
 */
function symbolOf(pixels: Pixels): { readonly quietZone: number; readonly modules: number; readonly version: number } {
  const dark = (x: number, y: number) => pixels.data[(y * pixels.width + x) * 4]! < 128;
  let top = -1;
  let left = -1;
  for (let y = 0; y < pixels.height && top < 0; y += 1) {
    for (let x = 0; x < pixels.width; x += 1) {
      if (dark(x, y)) {
        [top, left] = [y, x];
        break;
      }
    }
  }
  let run = 0;
  while (dark(left + run, top)) run += 1;
  const scale = run / 7;
  const quietZone = left / scale;
  const modules = pixels.width / scale - 2 * quietZone;
  return { quietZone, modules, version: (modules - 17) / 4 };
}

async function firstFrame(uri: string): Promise<OatPacket> {
  return (await framesForPairingUri(uri)).next().value;
}

/** Collect one packet with the scanner's own session, and read the text back. */
async function collectOne(packet: OatPacket): Promise<string | null> {
  const session = await openFountainSession(packet);
  try {
    if (!session.addPacket(packet)) return null;
    return pairingUriFromBytes(session.reconstruct());
  } finally {
    session.release();
  }
}

describe('a real pairing payload, framed, drawn and read back from pixels', () => {
  it('the table covers the realistic cases and both edges of the cap', () => {
    expect(MEASURED.map((row) => row.uri)).toContain(MAX_PAIRING_URI_LENGTH);
    expect(Math.max(...MEASURED.map((row) => row.uri))).toBe(MAX_PAIRING_URI_LENGTH);
  });

  for (const row of MEASURED) {
    it(row.label, async () => {
      const uri = encodePairingUri(row.payload);
      expect(uri.length, 'URI characters').toBe(row.uri);

      const packet = await firstFrame(uri);
      // THE SINGLE-FRAME ASSERTION. One block, the size of the whole URI, so
      // this packet alone is the code.
      expect(packet.sourceBlockCount).toBe(1);
      expect(packet.blockSize).toBe(uri.length);
      expect(packet.totalLength).toBe(uri.length);
      expect(encodePacket(packet).length, 'frame bytes').toBe(row.frame);
      expect(row.frame - row.uri).toBe(OAT_HEADER_BYTES);

      const pixels = decodePngDataUrl(await renderPairingFrame(packet));
      const symbol = symbolOf(pixels);
      expect(symbol.quietZone).toBe(PAIRING_FRAME_QUIET_ZONE);
      // The version pins the level too: for these lengths L and Q each land on
      // a different version than M does.
      expect(symbol.version, 'QR version at level M').toBe(row.version);

      const read = await decodeFrame(pixels);
      expect(read?.kind).toBe('packet');
      const scanned = (read as { packet: OatPacket }).packet;
      expect(scanned).toEqual(packet);
      // OAT's own reader agrees with the phone's on the same pixels.
      expect(decodePacketFromImageData(pixels)).toEqual(scanned);
      expect(classifyPacket(scanned)).toBe('pairing');

      const text = await collectOne(scanned);
      expect(text).toBe(uri);
      expect(decodePairingUri(text!)).toEqual(row.payload);
    });
  }

  it('draws at the level and quiet zone it states', () => {
    expect(PAIRING_FRAME_EC_LEVEL).toBe('M');
    expect(PAIRING_FRAME_QUIET_ZONE).toBe(4);
  });

  it('a payload every field limit admits can still be too long to encode, so a screen must choose what to leave out', () => {
    /*
     * NOT A REALISTIC-OR-NOT CLAIM, a measured edge. The table above picks
     * names that fit; this one does not. One IPv4 and four IPv6 addresses — a
     * laptop with a link-local, a ULA and temporary global addresses has that
     * many — with a 64-byte name (21 CJK characters) is inside MAX_ADDRESSES
     * and MAX_NAME_BYTES, and over MAX_PAIRING_URI_LENGTH. `encodePairingUri`
     * refuses it, so #127's screen has to trim addresses or the name, and to
     * stay at version 13 it has to reach 296 characters, not 300.
     */
    const over = payload({ addresses: [LAN, ULA, GLOBAL, LINK, ULA2], name: 'x'.repeat(MAX_NAME_BYTES) });
    expect(over.addresses.length).toBeLessThanOrEqual(MAX_ADDRESSES);
    let reason: unknown = null;
    try {
      encodePairingUri(over);
    } catch (error) {
      reason = error instanceof PairingParseError ? error.reason : error;
    }
    expect(reason).toBe('too-long');
    // One address fewer fits, at the version the terminal budget allows.
    expect(encodePairingUri({ ...over, addresses: over.addresses.slice(0, 4) }).length).toBeLessThanOrEqual(296);
  });
});

describe('every frame of a code is the whole code', () => {
  const uri = encodePairingUri(MEASURED[1]!.payload);

  it('any single frame completes it, whichever frame it is', async () => {
    const frames = await framesForPairingUri(uri);
    const taken: OatPacket[] = [];
    for (let i = 0; i < 50; i += 1) {
      const packet = frames.next().value;
      if ([0, 1, 6, 49].includes(i)) taken.push(packet);
    }
    // Different frames, not one frame four times.
    expect(new Set(taken.map((packet) => packet.seed)).size).toBe(taken.length);
    for (const packet of taken) {
      expect(await collectOne(packet)).toBe(uri);
    }
  });

  it('gives each code a fresh 16-byte artifact id, shared by all of its frames', async () => {
    const a = await framesForPairingUri(uri);
    const b = await framesForPairingUri(uri);
    const [a1, a2, b1] = [a.next().value, a.next().value, b.next().value];
    expect(a1.artifactId).toHaveLength(ARTIFACT_ID_BYTES);
    expect(a2.artifactId).toEqual(a1.artifactId);
    expect(b1.artifactId).not.toEqual(a1.artifactId);
  });

  it('a repeated frame is harmless, to a one-block code and to a many-block one', async () => {
    const single = await firstFrame(uri);
    const session = await openFountainSession(single);
    expect(session.addPacket(single)).toBe(true);
    expect(session.addPacket(single)).toBe(true);
    expect(pairingUriFromBytes(session.reconstruct())).toBe(uri);
    session.release();

    // A code drawn in 16-byte blocks: the fountain code proper. A repeat is
    // ignored by seed, and the code still completes from enough frames.
    const bytes = pairingUriToBytes(uri);
    const source = prepareSource(bytes, 16, new Uint8Array(ARTIFACT_ID_BYTES).fill(9));
    let seed = 1;
    const packets = generatePackets(source, () => seed++);
    const decoder = new FountainDecoder(source.sourceBlockCount, source.blockSize, source.totalLength);
    const first = packets.next().value;
    expect(first.sourceBlockCount).toBeGreaterThan(1);
    expect(decoder.addPacket(first)).toBe(false);
    expect(() => decoder.addPacket(first)).not.toThrow();
    expect(decoder.packetsSeen).toBe(1);
    let complete = false;
    for (let i = 0; i < 500 && !complete; i += 1) complete = decoder.addPacket(packets.next().value);
    expect(complete).toBe(true);
    expect(pairingUriFromBytes(decoder.reconstruct())).toBe(uri);
  });

  it('released, a session holds nothing and refuses to be used', async () => {
    const packet = await firstFrame(uri);
    const session = await openFountainSession(packet);
    session.release();
    session.release();
    expect(() => session.addPacket(packet)).toThrow(/released/);
    expect(() => session.reconstruct()).toThrow(/released/);
  });
});

describe('why the scanner separates codes itself', () => {
  /*
   * OAT's decoder throws on a packet whose block count or block size differ
   * from its session — and says nothing at all about a packet from another
   * artifact with the SAME shape. Two codes for one host differ only in their
   * token, so they are the same length, and that is the case that matters.
   * `qr-scan.ts` compares artifact ids for exactly this reason.
   */
  it('OAT throws on a different shape, and silently accepts a different code of the same shape', async () => {
    const a = encodePairingUri(payload({ token: new Uint8Array(32).fill(1) }));
    const b = encodePairingUri(payload({ token: new Uint8Array(32).fill(7) }));
    expect(a.length).toBe(b.length);

    const decoder = new FountainDecoder(1, a.length, a.length);
    const longer = await firstFrame(encodePairingUri(payload({ name: 'Desk two' })));
    expect(() => decoder.addPacket(longer)).toThrow(/does not belong/);

    const fromB = await firstFrame(b);
    expect(decoder.addPacket(fromB)).toBe(true);
    expect(pairingUriFromBytes(decoder.reconstruct())).toBe(b);
  });
});

describe('a pairing URI is printable ASCII, both ways', () => {
  it('frames the bytes of the text and reads them back', () => {
    for (const row of MEASURED) {
      const uri = encodePairingUri(row.payload);
      expect(pairingUriFromBytes(pairingUriToBytes(uri))).toBe(uri);
    }
  });

  it('refuses to frame anything that is not', () => {
    for (const bad of ['', 'chatterang-pair: AQ', 'chatterang-pair:é', 'chatterang-pair:\n']) {
      expect(() => pairingUriToBytes(bad), JSON.stringify(bad)).toThrow(RangeError);
    }
  });

  it('reads nothing back from bytes that are not', () => {
    for (const bad of [[], [0x63, 0x00], [0x63, 0x20], [0x63, 0x7f], [0x63, 0x80], [0xff]]) {
      expect(pairingUriFromBytes(Uint8Array.from(bad)), JSON.stringify(bad)).toBeNull();
    }
  });
});

describe('where the QR libraries can be reached from', () => {
  /*
   * STRUCTURAL, because the property is about what a bundler CAN pull in, and
   * one run proves nothing about that.
   *
   * The published 0.1.0 has no `/fountain` or `/encode` entrypoint, and its root
   * names both `qrcode` and `jsqr` (see `src/lib/oat-fountain.ts`). So: only the
   * two stand-in modules may name the package; only `pairing-frames.ts` may
   * name the encode half, the one that brings `qrcode`; both are reached by
   * VALUE only through `import()`; and nothing on the scan path names
   * `pairing-frames.ts` at all.
   */
  const SRC = resolve(process.cwd(), 'src');
  const rel = (file: string) => relative(SRC, file).replaceAll('\\', '/');
  const files = sourceFiles(SRC).map((file) => ({ file: rel(file), code: codeOf(readFileSync(file, 'utf8')) }));

  /** Every specifier a file names, and how: a value import, a type import, or `import()`. */
  function uses(code: string): { readonly specifier: string; readonly how: 'static' | 'type' | 'dynamic' }[] {
    const found: { specifier: string; how: 'static' | 'type' | 'dynamic' }[] = [];
    for (const match of code.matchAll(/^\s*(import|export)\s+(type\s+)?[^;]*?\bfrom\s+['"]([^'"]+)['"]/gm)) {
      found.push({ specifier: match[3]!, how: match[2] ? 'type' : 'static' });
    }
    for (const match of code.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) {
      found.push({ specifier: match[1]!, how: 'dynamic' });
    }
    return found;
  }

  const naming = (specifier: string) =>
    files.flatMap(({ file, code }) =>
      uses(code)
        .filter((use) => use.specifier === specifier)
        .map((use) => `${file} ${use.how}`),
    );

  it('reads the imports it is meant to read', () => {
    expect(uses("import type { A } from '@/x';\nconst m = await import('@/y');\nexport { b } from '@/z';")).toEqual([
      { specifier: '@/x', how: 'type' },
      { specifier: '@/z', how: 'static' },
      { specifier: '@/y', how: 'dynamic' },
    ]);
  });

  it('only the two stand-ins name the package', () => {
    expect(naming('@johnhenry/oat-qr-fountain').sort()).toEqual(
      ['lib/oat-encode.ts static', 'lib/oat-fountain.ts static', 'lib/oat-fountain.ts type'].sort(),
    );
  });

  it('only pairing-frames.ts reaches the encode half, and only lazily', () => {
    expect(naming('@/lib/oat-encode')).toEqual(['lib/pairing-frames.ts dynamic']);
  });

  it('the fountain half is reached by value only lazily, from the scanner and the frame helper', () => {
    const uses = naming('@/lib/oat-fountain');
    expect(uses.filter((use) => use.endsWith(' static'))).toEqual([]);
    expect(uses.filter((use) => use.endsWith(' dynamic')).sort()).toEqual(
      ['lib/pairing-frames.ts dynamic', 'lib/qr-decode.ts dynamic', 'lib/qr-scan.ts dynamic'].sort(),
    );
  });

  it('nothing on the scan path names the frame helper', () => {
    expect(naming('@/lib/pairing-frames')).toEqual([]);
  });

  it('the stand-ins are re-exports and nothing else', () => {
    for (const name of ['lib/oat-fountain.ts', 'lib/oat-encode.ts']) {
      const { code } = files.find((entry) => entry.file === name)!;
      const statements = code
        .split(';')
        .map((statement) => statement.trim())
        .filter(Boolean);
      expect(statements.length, name).toBeGreaterThan(0);
      for (const statement of statements) {
        expect(statement, name).toMatch(/^export (type )?\{[^}]*\} from '@johnhenry\/oat-qr-fountain'$/);
      }
    }
  });
});
