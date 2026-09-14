import { describe, expect, it, vi } from 'vitest';

/**
 * What `decodeFrame` makes of the BYTES in a QR code, with jsQR scripted.
 *
 * `tests/qr-decode.test.ts` reads real symbols. This file asks the question
 * those cannot reach without drawing arbitrary bytes: given that a code was
 * found, is it a packet, a code that is not a packet, or a damaged OAT frame to
 * ignore? The three want different things from the scanner — collect, "that
 * is not a pairing code", nothing — so each boundary is pinned.
 */

const jsqr = vi.hoisted(() => ({ binaryData: null as number[] | null }));
vi.mock('jsqr', () => ({
  default: () => (jsqr.binaryData === null ? null : { binaryData: jsqr.binaryData, data: '', chunks: [] }),
}));

import { encodePacket } from '@johnhenry/oat-qr-fountain';
import { generatePackets, prepareSource } from '@/lib/oat-fountain';
import { OAT_HEADER_BYTES, decodeFrame } from '@/lib/qr-decode';

const FRAME = { data: new Uint8ClampedArray(4), width: 1, height: 1 };

function validFrame(): number[] {
  const bytes = Uint8Array.from('chatterang-pair:AQ', (c) => c.charCodeAt(0));
  const packet = generatePackets(prepareSource(bytes, bytes.length, new Uint8Array(16).fill(0xab)), () => 7).next().value;
  return Array.from(encodePacket(packet));
}

async function read(binaryData: number[] | null) {
  jsqr.binaryData = binaryData;
  return decodeFrame(FRAME);
}

describe('what a found code holds', () => {
  it('no code: null', async () => {
    expect(await read(null)).toBeNull();
  });

  it('a well-formed OAT frame: its packet', async () => {
    const result = await read(validFrame());
    expect(result?.kind).toBe('packet');
    expect(result?.kind === 'packet' && result.packet.seed).toBe(7);
  });

  it('text, a URL, or nothing at all: a code that is not a packet', async () => {
    for (const text of ['https://example.com/menu', 'WIFI:S:cafe;T:WPA;P:hunter2;;', '482913', '']) {
      expect(await read(Array.from(text, (c) => c.charCodeAt(0))), JSON.stringify(text)).toEqual({ kind: 'other' });
    }
  });

  it('an OAT frame one byte short, or one byte long: damaged, so ignored — not hinted about', async () => {
    const frame = validFrame();
    expect(await read(frame.slice(0, -1))).toBeNull();
    expect(await read([...frame, 0])).toBeNull();
  });

  it('an OAT header that disagrees with its length is ignored the same way', async () => {
    const frame = validFrame();
    frame[29] = 0xff; // the block size's top byte: now far longer than the frame
    expect(await read(frame)).toBeNull();
  });

  it('bytes that start like a header but lack the LT scheme byte are not OAT-shaped', async () => {
    const frame = validFrame();
    frame[17] = 2;
    expect(frame.length).toBeGreaterThanOrEqual(OAT_HEADER_BYTES);
    expect(await read(frame)).toEqual({ kind: 'other' });
  });

  it('a different OAT version is not OAT-shaped to this build, so it reads as another code', async () => {
    // An old app shown a newer code says "not a pairing code" rather than
    // silently ignoring it, which is the failure mode the pairing URI's own
    // version byte chose too.
    const frame = validFrame();
    frame[0] = 2;
    expect(await read(frame)).toEqual({ kind: 'other' });
  });
});
