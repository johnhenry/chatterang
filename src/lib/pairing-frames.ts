/**
 * THE PAIRING CODE AS THE DESKTOP DRAWS IT: OAT frames, each one complete (#127).
 *
 * Ruled by the owner on #127: the desktop draws the pairing payload with
 * `@johnhenry/oat-qr-fountain`, and the phone's scanner decodes OAT frames. OAT
 * is a fountain code — ordinarily an artifact becomes an endless stream of
 * packets and a receiver needs enough of them, in any order — but the block
 * size is the sender's to choose, and a pairing code chooses:
 *
 *   BLOCK SIZE = THE URI'S LENGTH. The source is then one block (k = 1), every
 *   packet carries the whole URI, and ANY SINGLE FRAME the phone reads
 *   reconstructs it. A screen may show one frame or cycle through equivalent
 *   ones; scanning does not depend on which.
 *
 * No screen draws this yet. #127's screen waits on the certificate and the
 * listener; this is the codec it will call, so its size can be measured and its
 * frames scanned before there is anything to put them on.
 *
 * ## Measured
 *
 * Each row is a payload built with `encodePairingUri`, framed here, drawn by
 * `renderPairingFrame`, and read back from the image's pixels by the phone's
 * decoder. `tests/pairing-frames.test.ts` pins every number.
 *
 *     payload                                              URI  frame  QR (level M)
 *     desktop, one IPv4, "Desk"                            130   164   v9   53 modules
 *     desktop, IPv4 + two IPv6, "John’s MacBook Pro"       199   233   v11  61
 *     server, 3 IPv4 + 3 IPv6, "homelab"                   222   256   v12  65
 *     desktop, IPv4 + four IPv6, "John’s MacBook Pro"      247   281   v12  65
 *     desktop, IPv4 + two IPv6, 64-byte name               258   292   v13  69
 *     server, 2 IPv4 + IPv6 + tailnet DNS, 64-byte name    291   325   v13  69
 *     server, IPv4 + 4 IPv6, 57-byte name — the cap        296   330   v13  69
 *
 * and past the cap, frames of URIs that `encodePairingUri` and
 * `decodePairingUri` now refuse, drawn anyway to show where the edge is:
 *
 *     297 characters (no base64url body is this long)      297   331   v13  69
 *     298 characters: IPv4 + 4 IPv6, 58-byte name          298   332   v14  73
 *     299 characters                                       299   333   v14  73
 *     300 characters: the old cap                          300   334   v14  73
 *
 * A frame is the URI's bytes plus OAT's 34-byte header, and the header is all it
 * costs: measured once with `qrcode@1.5.4` and not pinned, the first two URIs
 * drawn as plain text QR codes are v8 and v10. v14 is 81 columns with the quiet
 * zone, one too many for the terminal a headless server draws in, so the owner
 * lowered `MAX_PAIRING_URI_LENGTH` from 300 to 296 (#127): every code draws at
 * v13 or smaller. That constant records the rest of the argument.
 *
 * The field limits admit payloads the cap does not: one IPv4 and four IPv6
 * addresses with a 64-byte name is refused by `encodePairingUri` as too long
 * (pinned in the test). The owner ruled what a screen does then: it calls
 * `fitPairingPayload`, which drops the least reachable addresses and never
 * shortens the name.
 *
 * ONE BLOCK, BOTH WAYS. This draws one-block frames only, and the phone refuses
 * any frame that claims more (`classifyPacket` in `qr-scan.ts`, ruled on #127).
 *
 * ## Choices, and why
 *
 *   - THE URI'S ASCII BYTES, not the binary payload inside it. Carrying the
 *     binary would save about a quarter of the frame, and would make the frame
 *     a second encoding of the payload that `decodePairingUri` — the one parser
 *     that refuses what it does not understand — never sees.
 *   - A FRESH RANDOM ARTIFACT ID PER CODE. The phone treats a new artifact id as
 *     a new code and drops whatever it held (`qr-scan.ts`), so a code redrawn
 *     with a new token is never mixed with the old one, and two screens are
 *     never one session.
 *   - LEVEL M and a FOUR-MODULE QUIET ZONE, stated rather than inherited. M is
 *     the level #134 budgeted against; four modules is the QR specification's
 *     quiet zone and the one `MAX_PAIRING_URI_LENGTH` was derived with. OAT's
 *     own default margin is two.
 *
 * ## What this does not do
 *
 * It verifies nothing and signs nothing — OAT's README says the same of itself.
 * The payload's authenticity comes from the PAKE and the channel binding
 * (#257, #256, #265), and the phone still parses the reconstructed text with
 * `decodePairingUri`.
 *
 * ## Where it sits
 *
 * It imports nothing at module load but types. The fountain half is reached
 * lazily through `src/lib/oat-fountain.ts`, and `qrcode` only through
 * `src/lib/oat-encode.ts` when a frame is drawn, so a screen that imports this
 * pays for the QR library when it draws and not before. The scanner does not
 * import it at all.
 */

import type { OatPacket } from '@/lib/oat-fountain';

/** OAT's artifact id is exactly this long; its encoder throws on anything else. */
export const ARTIFACT_ID_BYTES = 16;

/** The error-correction level a pairing frame is drawn at. See the header. */
export const PAIRING_FRAME_EC_LEVEL = 'M';

/** Quiet zone around a drawn frame, in modules. See the header. */
export const PAIRING_FRAME_QUIET_ZONE = 4;

/**
 * A pairing URI as the bytes a frame carries.
 *
 * PRINTABLE ASCII OR NOTHING. `encodePairingUri` writes a scheme, a colon and
 * base64url, all of it between `!` and `~`, so anything else is not a pairing
 * URI and is refused here rather than framed. The phone applies the same rule
 * to what it reconstructs (`pairingUriFromBytes` in `qr-scan.ts`).
 */
export function pairingUriToBytes(uri: string): Uint8Array {
  if (uri.length === 0) throw new RangeError('a pairing URI is never empty');
  const bytes = new Uint8Array(uri.length);
  for (let i = 0; i < uri.length; i += 1) {
    const code = uri.charCodeAt(i);
    if (code < 0x21 || code > 0x7e) throw new RangeError('a pairing URI is printable ASCII');
    bytes[i] = code;
  }
  return bytes;
}

/**
 * The frames for one pairing code: an ENDLESS iterator of packets.
 *
 * OAT's generator never finishes, so a caller takes what it draws — one
 * packet, or the next packet each time the image changes — and never loops
 * until it ends. Every packet it yields shares one fresh artifact id, has a
 * block count of 1, and alone carries the whole URI.
 */
export async function framesForPairingUri(uri: string): Promise<IterableIterator<OatPacket>> {
  const bytes = pairingUriToBytes(uri);
  const { generatePackets, prepareSource } = await import('@/lib/oat-fountain');
  const artifactId = crypto.getRandomValues(new Uint8Array(ARTIFACT_ID_BYTES));
  return generatePackets(prepareSource(bytes, bytes.length, artifactId));
}

/** Draw one frame as a PNG `data:` URL, at the stated level and quiet zone. */
export async function renderPairingFrame(packet: OatPacket): Promise<string> {
  const { renderPacketToDataUrl } = await import('@/lib/oat-encode');
  return renderPacketToDataUrl(packet, {
    errorCorrectionLevel: PAIRING_FRAME_EC_LEVEL,
    margin: PAIRING_FRAME_QUIET_ZONE,
  });
}
