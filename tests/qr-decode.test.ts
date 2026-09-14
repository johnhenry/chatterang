import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { decodePacketFromImageData, encodePacket } from '@johnhenry/oat-qr-fountain';
import { decodePairingUri } from '@chatterang/tunnel/pairing';
import { generatePackets, prepareSource, type OatPacket } from '@/lib/oat-fountain';
import { OAT_HEADER_BYTES, decodeFrame, type FrameRead, type QrFrame } from '@/lib/qr-decode';
import { openFountainSession, pairingUriFromBytes } from '@/lib/qr-scan';

/**
 * #128's decoder seam, tested against REAL QR codes — and, since #127's ruling,
 * against a real OAT pairing frame.
 *
 * The fixtures in `tests/fixtures/qr-codes.json` were produced by an independent
 * encoder (`qrcode@1.5.4`), not by the decoder under test and not by hand. That
 * independence is the point: a round trip through one library proves the
 * library is self-consistent, which is not the property a pairing screen needs.
 * These matrices came from somewhere else and jsQR has to agree with them.
 *
 * `oat-pairing-frame` is a pairing URI framed by OAT with a fixed artifact id
 * and seed, and drawn by `qrcode` directly — not through `renderPairingFrame` —
 * so its module matrix is a golden the drawing path cannot quietly move.
 */

interface Fixture {
  readonly size: number;
  readonly rows: readonly string[];
}
interface OatFixture extends Fixture {
  readonly uri: string;
  readonly artifactId: string;
  readonly seed: number;
  readonly frame: string;
}
const FIXTURES = JSON.parse(
  readFileSync(resolve(process.cwd(), 'tests/fixtures/qr-codes.json'), 'utf8'),
) as Record<string, Fixture>;
const OAT = FIXTURES['oat-pairing-frame'] as OatFixture;

const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

/** Paint a module matrix into pixels, the way a camera would see it on a screen. */
function render(fixture: Fixture, { scale = 6, quiet = 4, invert = false } = {}): QrFrame {
  const dim = (fixture.size + quiet * 2) * scale;
  const data = new Uint8ClampedArray(dim * dim * 4).fill(255);
  const dark = invert ? 255 : 0;
  const light = invert ? 0 : 255;
  if (invert) for (let i = 0; i < dim * dim; i += 1) { data[i * 4] = light; data[i * 4 + 1] = light; data[i * 4 + 2] = light; }
  for (let y = 0; y < fixture.size; y += 1) {
    for (let x = 0; x < fixture.size; x += 1) {
      if (fixture.rows[y]![x] !== '1') continue;
      for (let dy = 0; dy < scale; dy += 1) {
        for (let dx = 0; dx < scale; dx += 1) {
          const px = ((y + quiet) * scale + dy) * dim + ((x + quiet) * scale + dx);
          data[px * 4] = dark;
          data[px * 4 + 1] = dark;
          data[px * 4 + 2] = dark;
        }
      }
    }
  }
  return { data, width: dim, height: dim };
}

const packetOf = (read: FrameRead | null): OatPacket => {
  if (read?.kind !== 'packet') throw new Error(`expected a packet, read ${JSON.stringify(read)}`);
  return read.packet;
};

afterEach(() => {
  delete (globalThis as { BarcodeDetector?: unknown }).BarcodeDetector;
  vi.restoreAllMocks();
});

describe('decoding a real OAT pairing frame with the bundled decoder', () => {
  it('reads the packet the fixture encodes, byte for byte', async () => {
    const packet = packetOf(await decodeFrame(render(OAT)));
    expect(hex(encodePacket(packet))).toBe(OAT.frame);
    expect(hex(packet.artifactId)).toBe(OAT.artifactId);
    expect(packet.seed).toBe(OAT.seed);
    expect(packet.sourceBlockCount).toBe(1);
  });

  it('and the packet alone is the pairing code', async () => {
    const packet = packetOf(await decodeFrame(render(OAT)));
    const session = await openFountainSession(packet);
    expect(session.addPacket(packet)).toBe(true);
    const text = pairingUriFromBytes(session.reconstruct());
    session.release();
    expect(text).toBe(OAT.uri);
    expect(decodePairingUri(text!).name).toBe('Desk');
  });

  it('reads it at a smaller module scale, as a camera further away would', async () => {
    expect(hex(encodePacket(packetOf(await decodeFrame(render(OAT, { scale: 3 })))))).toBe(OAT.frame);
  });

  it('matches OAT’s own reader on every frame both read', async () => {
    /*
     * `decodeFrame` runs the same steps as OAT's `decodePacketFromImageData`
     * and keeps one answer that function throws away. Where OAT reads a packet,
     * this must read the same one; where OAT reads nothing, this reads nothing
     * or "a code that is not a packet" — never a packet of its own.
     */
    const frames = [render(OAT), render(OAT, { scale: 3 }), render(FIXTURES['482913']!), render(FIXTURES['chatterang-pair:AQEBstub']!)];
    const blank: QrFrame = { data: new Uint8ClampedArray(120 * 120 * 4).fill(255), width: 120, height: 120 };
    for (const frame of [...frames, blank]) {
      const theirs = decodePacketFromImageData(frame);
      const ours = await decodeFrame(frame);
      if (theirs === null) expect(ours?.kind).not.toBe('packet');
      else expect(packetOf(ours)).toEqual(theirs);
    }
  });

  it('pins the header shape it recognises against OAT’s own encoder', () => {
    // `decodeFrame` tells a damaged OAT frame from a menu's QR code by these
    // bytes. If a release of OAT moved them, this is where it shows.
    const uri = 'chatterang-pair:AQ';
    const bytes = Uint8Array.from(uri, (c) => c.charCodeAt(0));
    const packet = generatePackets(prepareSource(bytes, bytes.length, new Uint8Array(16).fill(0xee))).next().value;
    const frame = encodePacket(packet);
    expect(frame.length - packet.blockSize).toBe(OAT_HEADER_BYTES);
    expect(frame[0]).toBe(1);
    expect(frame[17]).toBe(1);
  });
});

describe('a QR code that is not an OAT frame', () => {
  it('reads a six-digit code as a code, and not as a packet', async () => {
    expect(await decodeFrame(render(FIXTURES['482913']!))).toEqual({ kind: 'other' });
  });

  it('reads a pairing URI drawn as plain text as not a packet either', async () => {
    /*
     * The format before #127's ruling. No host draws it: the desktop screen
     * draws OAT frames, and there is no other screen. So it is a QR code that
     * is not a pairing code, which is what the scanner will say — one format,
     * one parser, and no second path for a crafted code to aim at.
     */
    expect(await decodeFrame(render(FIXTURES['chatterang-pair:AQEBstub']!))).toEqual({ kind: 'other' });
  });

  it('returns null for a blank frame rather than throwing', async () => {
    /*
     * THE ORDINARY CASE, not an error. Most frames in a scan loop contain no
     * code, and a decoder that threw on them would make the loop's happy path
     * an exception handler.
     */
    const blank: QrFrame = { data: new Uint8ClampedArray(120 * 120 * 4).fill(255), width: 120, height: 120 };
    expect(await decodeFrame(blank)).toBeNull();
  });

  it('returns null for noise, so it does not invent a payload', async () => {
    const data = new Uint8ClampedArray(120 * 120 * 4);
    for (let i = 0; i < data.length; i += 4) {
      const v = (i * 2654435761) % 256;
      data[i] = v; data[i + 1] = v; data[i + 2] = v; data[i + 3] = 255;
    }
    expect(await decodeFrame({ data, width: 120, height: 120 })).toBeNull();
  });

  it('returns null for a frame too damaged to read, and does not throw', async () => {
    // Paint over a band of the symbol wider than level M can correct.
    const frame = render(OAT);
    const { data, width } = frame;
    for (let y = Math.floor(width * 0.35); y < Math.floor(width * 0.65); y += 1) {
      for (let x = 0; x < width; x += 1) data[(y * width + x) * 4] = data[(y * width + x) * 4 + 1] = data[(y * width + x) * 4 + 2] = 0;
    }
    expect(await decodeFrame(frame)).toBeNull();
  });
});

describe('the platform decoder is not used, even where there is one', () => {
  it('is never constructed or asked, and the bundled decoder answers', async () => {
    /*
     * MEASURED, not assumed. In Chromium 152 on macOS, `BarcodeDetector`
     * finds a 233-byte OAT pairing frame and returns a `rawValue` of length
     * ZERO — the symbol found, every byte gone — and does the same when the
     * frame's artifact id is plain ASCII, while the same URI drawn as a plain
     * byte-mode QR code reads back exactly. See `src/lib/qr-decode.ts`.
     */
    const detect = vi.fn().mockResolvedValue([{ rawValue: 'from-the-platform' }]);
    const constructed = vi.fn();
    (globalThis as { BarcodeDetector?: unknown }).BarcodeDetector = class {
      constructor() {
        constructed();
      }
      detect = detect;
    };
    expect(hex(encodePacket(packetOf(await decodeFrame(render(OAT)))))).toBe(OAT.frame);
    expect(await decodeFrame(render(FIXTURES['482913']!))).toEqual({ kind: 'other' });
    expect(constructed).not.toHaveBeenCalled();
    expect(detect).not.toHaveBeenCalled();
  });
});

describe('the frame is borrowed, never kept', () => {
  it('takes pixels and returns a packet, with nothing to persist with', async () => {
    /*
     * #128 requires that a scan never persists a frame, and the camera usage
     * string promises the user exactly that in an OS dialog: "Nothing the
     * camera sees is stored or sent anywhere."
     *
     * The strongest available check is structural rather than behavioural: the
     * module imports nothing that could store or send. A test that watched a
     * blob store would only prove this ONE path is clean; reading the import
     * list proves there is no path.
     */
    const source = readFileSync(resolve(process.cwd(), 'src/lib/qr-decode.ts'), 'utf8');
    // COMMENTS STRIPPED FIRST. The module's own docstring explains that it
    // uses no fetch and no Worker, and a bare search would match the
    // explanation and call it a violation — which is how a guard comes to
    // report on prose instead of on code.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

    // Static imports are TYPES only, erased at build: nothing loads with the module.
    const imports = [...code.matchAll(/^import\s.*?from\s+'([^']+)'/gm)].map((m) => m[0]);
    expect(imports).toEqual(["import type { OatPacket } from '@/lib/oat-fountain'"]);

    const dynamic = [...code.matchAll(/\bimport\('([^']+)'\)/g)].map((m) => m[1]);
    expect(dynamic).toEqual(['jsqr', '@/lib/oat-fountain']);

    // And nothing that could reach a store or a network, by name.
    for (const forbidden of ['fetch', 'XMLHttpRequest', 'indexedDB', 'localStorage', 'Dexie', 'Worker', 'BarcodeDetector']) {
      expect(code, `${forbidden} appears in the code`).not.toMatch(new RegExp(`\\b${forbidden}\\b`));
    }
    // The strip must not have eaten the file: the real code is still there.
    expect(code).toContain('export async function decodeFrame');
  });

  it('does not mutate the caller’s pixels', async () => {
    // A decoder that binarised in place would corrupt the frame a UI is still
    // painting to a canvas.
    const frame = render(OAT);
    const before = frame.data.slice();
    await decodeFrame(frame);
    expect(frame.data).toEqual(before);
  });
});
