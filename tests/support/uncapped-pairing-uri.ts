import { PAIRING_SCHEME, encodePairingUri, type PairingPayload } from '@chatterang/tunnel/pairing';

/**
 * A payload's URI as `encodePairingUri` writes it, WITHOUT the length cap.
 *
 * The encoder refuses anything over `MAX_PAIRING_URI_LENGTH`, so a test that
 * needs the parser, the frame drawer or the scanner to see a real URI past the
 * cap has to write one itself. It borrows every byte it can from the encoder:
 * the same payload is encoded with a one-byte name — the name is the last
 * field — and the real name is put back in its place.
 * `tests/tunnel-pairing.test.ts` holds this to the encoder's own output under
 * the cap, so it cannot drift into writing something the encoder would not.
 */
export function uncappedPairingUri(payload: PairingPayload): string {
  const prefix = `${PAIRING_SCHEME}:`;
  const short = encodePairingUri({ ...payload, name: 'n' });
  const base64 = short.slice(prefix.length).replaceAll('-', '+').replaceAll('_', '/');
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=');
  const bytes = Array.from(atob(padded), (c) => c.charCodeAt(0));
  const name = new TextEncoder().encode(payload.name);
  bytes.splice(bytes.length - 2, 2, name.length, ...name);
  const body = btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
  return prefix + body;
}
