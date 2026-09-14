/**
 * The ENCODE half of `@johnhenry/oat-qr-fountain`: drawing a packet as a QR
 * image, which is what pulls in `qrcode` (#127).
 *
 * It stands in for `@johnhenry/oat-qr-fountain/encode`, which the published
 * 0.1.0 does not export — see `src/lib/oat-fountain.ts` for the whole account.
 * Only `src/lib/pairing-frames.ts` reaches it, and only through a dynamic
 * `import()`, so `qrcode` is fetched by the screen that draws a pairing code
 * and by nothing that scans one.
 */

export { renderPacketToDataUrl } from '@johnhenry/oat-qr-fountain';
