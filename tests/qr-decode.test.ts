import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { decodeFrame, hasNativeDetector, type QrFrame } from '@/lib/qr-decode';

/**
 * #128's decoder seam, tested against REAL QR codes.
 *
 * The fixture in `tests/fixtures/qr-codes.json` was produced by an independent
 * encoder (`qrcode@1.5.4`), not by the decoder under test and not by hand. That
 * independence is the point: a round trip through one library proves the
 * library is self-consistent, which is not the property a pairing screen needs.
 * These matrices came from somewhere else and jsQR has to agree with them.
 */

interface Fixture {
  readonly size: number;
  readonly rows: readonly string[];
}
const FIXTURES = JSON.parse(
  readFileSync(resolve(process.cwd(), 'tests/fixtures/qr-codes.json'), 'utf8'),
) as Record<string, Fixture>;

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

afterEach(() => {
  delete (globalThis as { BarcodeDetector?: unknown }).BarcodeDetector;
  vi.restoreAllMocks();
});

describe('decoding a real code with the bundled decoder', () => {
  it('reads a six-digit pairing code', async () => {
    expect(await decodeFrame(render(FIXTURES['482913']!))).toBe('482913');
  });

  it('reads a longer payload, which is a bigger symbol', async () => {
    // 25x25 rather than 21x21 — a different version, so this is not the same
    // decode path with different bits.
    const payload = 'chatterang-pair:AQEBstub';
    expect(await decodeFrame(render(FIXTURES[payload]!))).toBe(payload);
  });

  it('reads it at a smaller module scale, as a camera further away would', async () => {
    expect(await decodeFrame(render(FIXTURES['482913']!, { scale: 3 }))).toBe('482913');
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
});

describe('the platform decoder, when there is one', () => {
  it('is absent in this environment, which is what iOS looks like', () => {
    // jsdom has no BarcodeDetector, and neither does any iOS origin measured
    // in dev/probe-128. So every test above exercised the bundled path.
    expect(hasNativeDetector()).toBe(false);
  });

  it('is used in preference when present', async () => {
    const detect = vi.fn().mockResolvedValue([{ rawValue: 'from-the-platform' }]);
    (globalThis as { BarcodeDetector?: unknown }).BarcodeDetector = class {
      detect = detect;
    };
    expect(hasNativeDetector()).toBe(true);
    expect(await decodeFrame(render(FIXTURES['482913']!))).toBe('from-the-platform');
    expect(detect).toHaveBeenCalledOnce();
  });

  it('asks it for QR only, not every barcode format', async () => {
    let options: { formats?: readonly string[] } | undefined;
    (globalThis as { BarcodeDetector?: unknown }).BarcodeDetector = class {
      constructor(opts?: { formats?: readonly string[] }) { options = opts; }
      detect = vi.fn().mockResolvedValue([]);
    };
    await decodeFrame(render(FIXTURES['482913']!));
    expect(options?.formats).toEqual(['qr_code']);
  });

  it('reports no code as null, not as a failure', async () => {
    (globalThis as { BarcodeDetector?: unknown }).BarcodeDetector = class {
      detect = vi.fn().mockResolvedValue([]);
    };
    expect(await decodeFrame(render(FIXTURES['482913']!))).toBeNull();
  });

  it('FALLS BACK to the bundled decoder when the platform one throws', async () => {
    /*
     * Some Android WebViews expose `BarcodeDetector` and then reject `detect`
     * for formats they do not really support. A scanner that gave up there
     * would be broken on exactly the devices #223 is about — and the bundled
     * decoder is already downloaded, so using it costs nothing.
     */
    (globalThis as { BarcodeDetector?: unknown }).BarcodeDetector = class {
      detect = vi.fn().mockRejectedValue(new Error('NotSupportedError'));
    };
    expect(await decodeFrame(render(FIXTURES['482913']!))).toBe('482913');
  });
});

describe('the frame is borrowed, never kept', () => {
  it('takes pixels and returns a string, with nothing to persist with', async () => {
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

    const imports = [...code.matchAll(/^import\s.*?from\s+'([^']+)'/gm)].map((m) => m[1]);
    expect(imports).toEqual([]);

    const dynamic = [...code.matchAll(/await import\('([^']+)'\)/g)].map((m) => m[1]);
    expect(dynamic).toEqual(['jsqr']);

    // And nothing that could reach a store or a network, by name.
    for (const forbidden of ['fetch', 'XMLHttpRequest', 'indexedDB', 'localStorage', 'Dexie', 'Worker']) {
      expect(code, `${forbidden} appears in the code`).not.toMatch(new RegExp(`\\b${forbidden}\\b`));
    }
    // The strip must not have eaten the file: the real code is still there.
    expect(code).toContain('export async function decodeFrame');
  });

  it('does not mutate the caller’s pixels', async () => {
    // A decoder that binarised in place would corrupt the frame a UI is still
    // painting to a canvas.
    const frame = render(FIXTURES['482913']!);
    const before = frame.data.slice();
    await decodeFrame(frame);
    expect(frame.data).toEqual(before);
  });
});
