import { inflateSync } from 'node:zlib';

/**
 * Decode a PNG `data:` URL into RGBA pixels, in Node, with no dependency.
 *
 * For `tests/pairing-frames.test.ts`, which reads a drawn pairing frame back
 * through the phone's decoder. jsdom has no 2D canvas to draw the image into,
 * and reaching for `pngjs` would mean importing a package this repository does
 * not declare — it is only here because `qrcode` depends on it.
 *
 * Handles what a PNG encoder like `qrcode`'s writes: 8 bits per channel,
 * truecolour with or without alpha, not interlaced, all five row filters.
 * Anything else throws rather than returning wrong pixels.
 */
export interface Pixels {
  readonly data: Uint8ClampedArray;
  readonly width: number;
  readonly height: number;
}

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export function decodePngDataUrl(url: string): Pixels {
  const match = /^data:image\/png;base64,(.+)$/.exec(url);
  if (match === null) throw new Error('not a PNG data URL');
  const png = Buffer.from(match[1]!, 'base64');
  if (!SIGNATURE.every((byte, i) => png[i] === byte)) throw new Error('not a PNG');

  let width = 0;
  let height = 0;
  let channels = 0;
  const idat: Buffer[] = [];
  for (let at = 8; at < png.length; ) {
    const length = png.readUInt32BE(at);
    const type = png.toString('latin1', at + 4, at + 8);
    const body = png.subarray(at + 8, at + 8 + length);
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      const [depth, colour, , , interlace] = [body[8], body[9], body[10], body[11], body[12]];
      if (depth !== 8 || interlace !== 0 || (colour !== 2 && colour !== 6)) {
        throw new Error(`unsupported PNG: depth ${depth}, colour ${colour}, interlace ${interlace}`);
      }
      channels = colour === 6 ? 4 : 3;
    } else if (type === 'IDAT') {
      idat.push(body);
    } else if (type === 'IEND') {
      break;
    }
    at += 12 + length;
  }

  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const rows = new Uint8Array(height * stride);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)]!;
    const source = y * (stride + 1) + 1;
    const out = y * stride;
    for (let x = 0; x < stride; x += 1) {
      const left = x >= channels ? rows[out + x - channels]! : 0;
      const up = y > 0 ? rows[out + x - stride]! : 0;
      const upLeft = y > 0 && x >= channels ? rows[out + x - stride - channels]! : 0;
      const value = raw[source + x]!;
      let predicted: number;
      if (filter === 0) predicted = 0;
      else if (filter === 1) predicted = left;
      else if (filter === 2) predicted = up;
      else if (filter === 3) predicted = (left + up) >> 1;
      else if (filter === 4) {
        const p = left + up - upLeft;
        const [pa, pb, pc] = [Math.abs(p - left), Math.abs(p - up), Math.abs(p - upLeft)];
        predicted = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
      } else throw new Error(`unknown PNG filter ${filter}`);
      rows[out + x] = (value + predicted) & 0xff;
    }
  }

  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    data[i * 4] = rows[i * channels]!;
    data[i * 4 + 1] = rows[i * channels + 1]!;
    data[i * 4 + 2] = rows[i * channels + 2]!;
    data[i * 4 + 3] = channels === 4 ? rows[i * channels + 3]! : 255;
  }
  return { data, width, height };
}
