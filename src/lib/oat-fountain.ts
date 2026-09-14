/**
 * The FOUNTAIN half of `@johnhenry/oat-qr-fountain`: packet framing and the LT
 * encoder and decoder, with neither QR library (#127, #128).
 *
 * ## Why this file exists instead of `@johnhenry/oat-qr-fountain/fountain`
 *
 * OAT's README documents three subpath entrypoints — `/fountain`, `/encode`,
 * `/decode` — so a receiver never ships `qrcode` and a sender never ships
 * `jsqr`. THE PUBLISHED 0.1.0 DOES NOT HAVE THEM. Its `exports` map has only
 * `.`, and its root re-exports a module that imports BOTH `qrcode` and `jsqr` at
 * top level; the split landed upstream on 2026-09-04, three weeks after 0.1.0
 * was published, and is not on npm. Importing a subpath from 0.1.0 does not
 * resolve at all.
 *
 * So this module stands in for `/fountain`: it names only what the fountain
 * half needs, and the scanner and the pairing-frame helper reach it with a
 * dynamic `import()`, never statically. The package declares
 * `"sideEffects": false`, so a bundler that sees only these names drops the
 * module that imports the QR libraries — `npm run build:web` is how that was
 * checked, not assumed. When a release with the subpaths is published, the one
 * specifier below becomes `@johnhenry/oat-qr-fountain/fountain` and nothing
 * else changes.
 *
 * ## What 0.1.0 does not guard, so its callers must
 *
 * 0.1.0's `decodePacket` accepts ANY `uint32` block count, and
 * `FountainDecoder`'s constructor does work proportional to it, synchronously —
 * one hostile frame is a hang. Upstream bounded this after 0.1.0 as well. The
 * scanner does not rely on either version: `src/lib/qr-scan.ts` refuses a
 * packet that does not describe a pairing-sized, self-consistent payload
 * BEFORE a decoder is constructed for it.
 *
 * 0.1.0 also keeps a module-level cache of one degree table per block count it
 * has seen, and never empties it. The tables are numbers computed from the
 * count, not packet contents; `src/lib/qr-scan.ts` records what that means for
 * a scan.
 */

export { FountainDecoder, decodePacket, generatePackets, prepareSource } from '@johnhenry/oat-qr-fountain';
export type { OatPacket } from '@johnhenry/oat-qr-fountain';
