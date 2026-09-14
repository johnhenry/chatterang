/**
 * Read one camera frame into an OAT packet (#128, #127).
 *
 * ## What a pairing code is
 *
 * The desktop draws the pairing URI as an Optical Artifact Transport frame
 * (`@johnhenry/oat-qr-fountain`, ruled on #127): a byte-mode QR code whose
 * content is OAT's 34-byte binary header — version, a random 16-byte artifact
 * id, the LT scheme, a seed, the block count, the block size and the total
 * length — followed by one block. `src/lib/pairing-frames.ts` is what draws it.
 *
 * This module turns pixels into that packet and nothing more. Collecting packets
 * into a payload, and deciding whether the payload is a pairing code, belong to
 * `qr-scan.ts`, because that is state, and state has to end with the scan.
 *
 * ## Why jsQR reads every frame, and `BarcodeDetector` reads none
 *
 * `BarcodeDetector` used to be preferred where it existed. It is not used at
 * all now, and the reason is the DATA, not the device:
 *
 *   - What it returns is `rawValue`, a string. The Shape Detection API exposes
 *     no bytes and gives byte mode no character set, so what a platform makes
 *     of bytes that are not text is its own choice.
 *   - An OAT header is not text. Every pairing frame carries NUL bytes — a
 *     block count of 1 is `00 00 00 01` — and its artifact id is 16 random
 *     bytes, so a frame with no byte at or above 0x80 turns up once in 65,536
 *     codes. Read as UTF-8, each of those bytes becomes U+FFFD and the header
 *     is gone. Read as Latin-1 it would survive, and nothing says which a given
 *     WebView does.
 *   - jsQR returns `binaryData`, the bytes the symbol encodes. It is what OAT's
 *     own `decodePacketFromImageData` reads, and on iOS it was already the only
 *     decoder there is.
 *
 * MEASURED where a `BarcodeDetector` exists to measure: Chromium 152 on macOS,
 * one page, three images drawn by `qrcode@1.5.4` at level M.
 *
 *     image                                          found  rawValue
 *     OAT pairing frame, 233 bytes, random id          1    ""  (length 0)
 *     the same frame with an all-ASCII artifact id      1    ""  (length 0)
 *     the same 199-character URI as a plain byte QR     1    exact, 199 chars
 *
 * So it is not a question of how high bytes are mapped: the detector finds the
 * symbol and hands back nothing, even when the only non-text bytes are the
 * header's NULs, while the paired control proves the detector reads codes on
 * that machine. Android's WebView was not measured; the first bullet above is
 * why no measurement there could make a string the right carrier.
 *
 * Keeping the platform decoder for ordinary QR codes alone would mean running
 * two decoders over every frame to learn which kind it holds — on the phone
 * this loop is throttled to protect, for a hint.
 *
 * ## Why not `decodePacketFromImageData` itself
 *
 * It is jsQR, then `binaryData`, then `decodePacket`, and it answers null both
 * for a frame with no code in it and for a code that is not a packet. The
 * scanner has to tell those apart: a restaurant menu's code gets "that is not a
 * pairing code" (#128), and an empty frame gets nothing. So this module runs
 * the same three steps and keeps the middle answer. `tests/qr-decode.test.ts`
 * holds the two to the same packet on every frame they both read.
 *
 * ## Why a bundled decoder exists at all
 *
 * `BarcodeDetector` is ABSENT on iOS at every origin measured — WKWebView at
 * `capacitor://localhost`, WKWebView at `http://localhost`, and mobile Safari
 * (`dev/probe-128/`). Android's WebView has it, but #223 records that the
 * WebView is a separately-updatable APK and `minSdkVersion 24` does not bound
 * its version. The binary argument above removes it from Android too.
 *
 * ## Why jsQR, and not the faster options
 *
 * THE CONTENT-SECURITY-POLICY DECIDES THIS, and it was measured rather than
 * reasoned about. Serving a page under this repo's verbatim `SERVED_CSP`
 * (`apps/server/src/policy.ts`) in a real browser:
 *
 *     WASM instantiate : BLOCKED — CompileError, "violates the following
 *                        Content Security Policy directive"
 *     blob: Worker     : BLOCKED — and the error event carries NO message,
 *                        so it fails silently in product terms
 *
 * and the paired control, the same page under the only policy in force at
 * `capacitor://localhost` (`index.html`'s `img-src`-only meta tag), allows
 * both. So a WASM decoder or a worker-based one works on the phone and breaks
 * on desktop and server.
 *
 * Admitting either means editing `CSP_PRODUCTION` and `SERVED_CSP` in lockstep
 * — `tests/server-policy.test.ts` diffs them directive-by-directive and permits
 * only the two font origins — and the WASM case also rewrites
 * `tests/desktop-security.test.ts`, which pins `script-src` to exactly
 * `["'self'"]`. Those tests exist so that weakening cannot happen quietly, and
 * a pairing screen is not a good enough reason to spend them. jsQR asks for
 * nothing: no WebAssembly, no Worker, no Blob, no fetch, no eval. Neither does
 * OAT's fountain half.
 *
 * ## Why both are imported lazily
 *
 * jsQR is 47 KB minified and gzipped, and 54.7% of its raw bytes are a
 * Shift-JIS Kanji table a pairing frame will never reach. It is a UMD with no
 * `module` entry and no `sideEffects` field, so bundlers tree-shake nothing out
 * of it — measured at 47,098 bundled against 46,778 minify-only. OAT's fountain
 * half is reached through `src/lib/oat-fountain.ts`, because the published
 * package has no `/fountain` entrypoint and its root also names `qrcode`. A
 * dynamic `import()` keeps both out of the initial bundle and off the device of
 * every user who never pairs.
 *
 * Stripping the Kanji table is a real 4.3x saving and is deliberately NOT done
 * here: it means owning a fork of a decoder that has not been published since
 * 2021, and that is a separate decision with its own measurement.
 *
 * ## The frame is borrowed, never kept
 *
 * #128 requires that a scan never persists a frame — "frames never touch the
 * blob store and never reach a model" — and the camera usage string promises
 * it to the user in an OS dialog. This module takes the pixels as an argument
 * and returns a packet it does not keep. It holds no module-level state, opens
 * no store, and has nothing to persist WITH, which is a stronger guarantee than
 * a rule somebody has to follow.
 */

import type { OatPacket } from '@/lib/oat-fountain';

/** Exactly the three fields `ImageData` carries, and what `getUserMedia` yields. */
export interface QrFrame {
  readonly data: Uint8ClampedArray;
  readonly width: number;
  readonly height: number;
}

/**
 * The shape every OAT frame has: its header length, and the two fixed bytes in
 * it. `tests/qr-decode.test.ts` pins these against OAT's own `encodePacket`, so
 * a package upgrade that moved them fails there rather than here.
 */
export const OAT_HEADER_BYTES = 34;
const OAT_VERSION_AT = 0;
const OAT_SCHEME_AT = 17;
const OAT_VERSION = 1;
const OAT_SCHEME_LT = 1;

/** What one frame held, when it held a QR code at all. */
export type FrameRead =
  /** An OAT packet. Not trusted and not yet a pairing code — just well-formed. */
  | { readonly kind: 'packet'; readonly packet: OatPacket }
  /** A QR code that is not an OAT frame: a menu, a URL, a Wi-Fi code. */
  | { readonly kind: 'other' };

/**
 * Read a frame, or null when there is nothing to act on.
 *
 * NULL IS THE ORDINARY CASE, not an error: most frames in a scan loop contain
 * no code at all, and a decoder that threw on them would make the loop's happy
 * path an exception handler. A frame whose code has OAT's shape but that
 * `decodePacket` refuses — a damaged frame, or one whose header disagrees with
 * its own length — is null too: it is not a menu to hint about, and it is not a
 * packet to trust. A genuine fault, a decoder that will not load, still throws.
 */
export async function decodeFrame(frame: QrFrame): Promise<FrameRead | null> {
  const [{ default: jsQR }, { decodePacket }] = await Promise.all([
    import('jsqr'),
    import('@/lib/oat-fountain'),
  ]);
  const result = jsQR(frame.data, frame.width, frame.height);
  if (result === null) return null;

  const bytes = Uint8Array.from(result.binaryData);
  const packet = decodePacket(bytes);
  if (packet !== null) return { kind: 'packet', packet };

  const oatShaped =
    bytes.length >= OAT_HEADER_BYTES &&
    bytes[OAT_VERSION_AT] === OAT_VERSION &&
    bytes[OAT_SCHEME_AT] === OAT_SCHEME_LT;
  return oatShaped ? null : { kind: 'other' };
}
