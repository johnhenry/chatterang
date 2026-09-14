// @vitest-environment node
import { X509Certificate, createHash, createPrivateKey, createPublicKey, generateKeyPairSync, webcrypto } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { connect, createServer } from 'node:tls';
import type { Server } from 'node:tls';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { NegotiatedPeerCertificate } from '@chatterang/contracts/tunnel-socket';
import { BindingError, channelIdentifierFor } from '@chatterang/tunnel/binding';
import { HOST_DESKTOP, TRUST_SPKI_PIN, type PairingPayload } from '@chatterang/tunnel/pairing';
import {
  TUNNEL_CERTIFICATE_REISSUE_MARGIN_DAYS,
  TunnelIdentityError,
  currentTunnelCertificate,
  generateTunnelKey,
  issueTunnelCertificate,
  sameTunnelPin,
  tunnelKeyFromPkcs8Pem,
  tunnelKeyPkcs8Pem,
  tunnelPinOf,
  type TunnelKey,
  type TunnelSubjectAltName,
} from '@chatterang/tunnel/host';

/**
 * #179 and #180: the key a paired client pins, and the certificates made from it.
 *
 * Every pin assertion here is checked against a computation the module does not
 * make: node:crypto reading the certificate PEM, and the SPKI bytes sliced out
 * of the certificate's own DER — the bytes a client receives.
 */

/** The brief's independent path: node:crypto reads the certificate, exports its SPKI DER, hashes it. */
const pinByNode = (certPem: string): string =>
  createHash('sha256').update(createPublicKey(certPem).export({ type: 'spki', format: 'der' })).digest('base64');

/** One DER TLV header: where its contents start and end. */
function tlv(bytes: Uint8Array, offset: number): { tag: number; start: number; end: number } {
  const tag = bytes[offset]!;
  let length = bytes[offset + 1]!;
  let start = offset + 2;
  if (length & 0x80) {
    const count = length & 0x7f;
    length = 0;
    for (let i = 0; i < count; i += 1) length = length * 256 + bytes[start + i]!;
    start += count;
  }
  return { tag, start, end: start + length };
}

/**
 * The SubjectPublicKeyInfo exactly as it sits in a certificate's DER:
 * Certificate → tbsCertificate → [0] version, serial, signature, issuer,
 * validity, subject, subjectPublicKeyInfo.
 */
function spkiDerOf(certificate: Uint8Array): Uint8Array {
  const tbs = tlv(certificate, tlv(certificate, 0).start);
  let cursor = tbs.start;
  let field = tlv(certificate, cursor);
  if (field.tag === 0xa0) {
    cursor = field.end;
    field = tlv(certificate, cursor);
  }
  for (let skip = 0; skip < 5; skip += 1) {
    cursor = field.end;
    field = tlv(certificate, cursor);
  }
  expect(field.tag, 'subjectPublicKeyInfo is a SEQUENCE').toBe(0x30);
  return certificate.slice(cursor, field.end);
}

/** The DER encodings of three extension OIDs: 2.5.29.19, 2.5.29.15 and 2.5.29.14. */
const BASIC_CONSTRAINTS = [0x06, 0x03, 0x55, 0x1d, 0x13] as const;
const KEY_USAGE = [0x06, 0x03, 0x55, 0x1d, 0x0f] as const;
const SUBJECT_KEY_IDENTIFIER = [0x06, 0x03, 0x55, 0x1d, 0x0e] as const;

/**
 * One extension, found by its encoded OID: whether it is marked critical, and
 * the bytes of its extnValue. Read from the certificate's own DER so no
 * X.509 parser's interpretation stands between the test and the encoding.
 */
function extensionOf(certificate: Uint8Array, oid: readonly number[]): { critical: boolean; value: number[] } | null {
  for (let at = 0; at + oid.length <= certificate.length; at += 1) {
    if (!oid.every((byte, i) => certificate[at + i] === byte)) continue;
    let field = tlv(certificate, at + oid.length);
    let critical = false;
    if (field.tag === 0x01) {
      critical = certificate[field.start] === 0xff;
      field = tlv(certificate, field.end);
    }
    return field.tag === 0x04 ? { critical, value: [...certificate.slice(field.start, field.end)] } : null;
  }
  return null;
}

const basePayload = {
  version: 1,
  hostKind: HOST_DESKTOP,
  trustMode: TRUST_SPKI_PIN,
  token: new Uint8Array(32).fill(7),
  expiresAt: 1_800_000_000,
  port: 8443,
  addresses: [{ kind: 1, value: Uint8Array.of(192, 168, 1, 10) }],
  name: 'John’s MacBook',
};

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((done) => server.close(() => done()))),
  );
});

/** A loopback TLS server built from the material, counting completed handshakes. */
async function serve(key: TunnelKey, certPem: string): Promise<{ port: number; secured: () => number }> {
  let secured = 0;
  const server = createServer({ key: tunnelKeyPkcs8Pem(key), cert: certPem, minVersion: 'TLSv1.3' }, (socket) => {
    secured += 1;
    socket.on('error', () => undefined);
    socket.end();
  });
  servers.push(server);
  await new Promise<void>((ready) => server.listen(0, '127.0.0.1', () => ready()));
  return { port: (server.address() as AddressInfo).port, secured: () => secured };
}

/**
 * A client whose only check is the pin — `rejectUnauthorized: false`, no
 * hostname — which is the client #295 describes. It completes the handshake,
 * hashes the SPKI the connection negotiated, and accepts only an equal pin.
 */
function connectPinned(
  port: number,
  pin: string,
): Promise<{ accepted: boolean; peerPin: string; protocol: string | null }> {
  return new Promise((settle, fail) => {
    const socket = connect({ host: '127.0.0.1', port, rejectUnauthorized: false }, () => {
      const peer = socket.getPeerX509Certificate();
      const peerPin =
        peer === undefined
          ? ''
          : createHash('sha256').update(peer.publicKey.export({ type: 'spki', format: 'der' })).digest('base64');
      const protocol = socket.getProtocol();
      const accepted = peerPin === pin;
      if (!accepted) {
        // Refused: drop the connection before anything is sent on it.
        socket.destroy();
        settle({ accepted, peerPin, protocol });
        return;
      }
      /*
       * ACCEPTED: close gracefully and wait. Under TLS 1.3 the client's handshake
       * completes before the server has read the client's Finished, so a
       * `destroy()` here reset the connection before the server's own handshake
       * finished — measured: the server's connection handler never ran.
       */
      socket.once('close', () => settle({ accepted, peerPin, protocol }));
      socket.end();
    });
    socket.once('error', fail);
  });
}

describe('the tunnel key and its pin (#179, #180)', () => {
  it('is EC P-256, pinned as the SHA-256 of its SubjectPublicKeyInfo in both spellings', () => {
    const key = generateTunnelKey();
    expect(key.privateKey.type).toBe('private');
    expect(key.privateKey.asymmetricKeyType).toBe('ec');
    expect(key.privateKey.asymmetricKeyDetails?.namedCurve).toBe('prime256v1');

    const independent = createHash('sha256')
      .update(createPublicKey(key.privateKey).export({ type: 'spki', format: 'der' }))
      .digest();
    expect(key.pin.spki).toHaveLength(32);
    expect(Buffer.from(key.pin.spki).equals(independent)).toBe(true);
    expect(key.pin.spkiSha256).toBe(independent.toString('base64'));
    expect(key.pin.spkiSha256).toMatch(/^[A-Za-z0-9+/]{43}=$/);

    const other = generateTunnelKey();
    expect(other.pin.spkiSha256).not.toBe(key.pin.spkiSha256);
    expect(sameTunnelPin(key.pin, other.pin)).toBe(false);
    expect(sameTunnelPin(key.pin, tunnelPinOf(createPublicKey(key.privateKey)))).toBe(true);
  });

  it('is the value the plugin contract reports and the channel binding consumes', () => {
    const key = generateTunnelKey();
    // Compile-time as much as run-time: the base64 spelling IS the contract's field.
    const reported: NegotiatedPeerCertificate = { spkiSha256: key.pin.spkiSha256 };
    // "The caller decodes once, at the boundary" — and gets the binding's 32 bytes.
    const negotiated = { spki: new Uint8Array(Buffer.from(reported.spkiSha256, 'base64')) };
    expect(negotiated.spki).toEqual(key.pin.spki);

    const payload = { ...basePayload, trust: key.pin.spki } as PairingPayload;
    const scanned = channelIdentifierFor({ kind: 'scanned', payload }, negotiated);
    const typed = channelIdentifierFor({ kind: 'typed', hostKind: HOST_DESKTOP }, { spki: key.pin.spki });
    expect(Buffer.from(scanned).equals(Buffer.from(typed))).toBe(true);

    // And another key's pin is the scanned route's pin mismatch.
    const other = generateTunnelKey();
    expect(() => channelIdentifierFor({ kind: 'scanned', payload }, { spki: other.pin.spki })).toThrow(BindingError);
  });

  it('survives the PEM round trip a stored key makes, with the same pin', () => {
    const key = generateTunnelKey();
    const pem = tunnelKeyPkcs8Pem(key);
    expect(pem).toMatch(/^-----BEGIN PRIVATE KEY-----\n/);
    expect(tunnelKeyFromPkcs8Pem(pem).pin.spkiSha256).toBe(key.pin.spkiSha256);
  });

  it('refuses a key that is not EC P-256 in one unencrypted PKCS#8 PEM block, and never echoes it', () => {
    const pem = { privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } } as const;
    const p256 = generateKeyPairSync('ec', { namedCurve: 'P-256', ...pem });
    const p256Key = createPrivateKey(p256.privateKey);
    const cases: readonly (readonly [string, string])[] = [
      ['Ed25519', generateKeyPairSync('ed25519', pem).privateKey],
      ['P-384', generateKeyPairSync('ec', { namedCurve: 'P-384', ...pem }).privateKey],
      ['RSA', generateKeyPairSync('rsa', { modulusLength: 2048, ...pem }).privateKey],
      ['a public key', p256.publicKey],
      ['garbage', '-----BEGIN PRIVATE KEY-----\nbm90IGEga2V5IGF0IGFsbCwgbm90IGV2ZW4gY2xvc2U=\n-----END PRIVATE KEY-----\n'],
      ['empty', ''],
      // The right key in the wrong wrapping. `createPrivateKey` takes every one
      // of these and returns the P-256 key, so each is refused by its encoding.
      ['the P-256 key as SEC1', p256Key.export({ type: 'sec1', format: 'pem' }).toString()],
      ['the P-256 key, then another PEM block', `${p256.privateKey}${generateTunnelKey().privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()}`],
      ['the P-256 key, then trailing text', `${p256.privateKey}trailing text\n`],
      ['the P-256 key, with text before it', `a note\n${p256.privateKey}`],
      ['the P-256 key, encrypted', p256Key.export({ type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase: 'x' }).toString()],
    ];
    for (const [label, text] of cases) {
      let error: unknown;
      try {
        tunnelKeyFromPkcs8Pem(text);
      } catch (caught) {
        error = caught;
      }
      expect(error, label).toBeInstanceOf(TunnelIdentityError);
      expect((error as TunnelIdentityError).reason, label).toBe('key-unsupported');
      for (const line of text.split('\n').filter((l) => l.length >= 16 && !l.startsWith('-----'))) {
        expect((error as Error).message, label).not.toContain(line.slice(0, 24));
      }
    }
    // The control: the same encoding on the right curve is accepted.
    expect(tunnelKeyFromPkcs8Pem(p256.privateKey).privateKey.asymmetricKeyDetails?.namedCurve).toBe('prime256v1');
  });
});

describe('a certificate issued from the key', () => {
  it('parses, carries the key, and its SPKI hash matches two independent computations', async () => {
    const key = generateTunnelKey();
    const cert = await issueTunnelCertificate(key, { validDays: 30 });
    const parsed = new X509Certificate(cert.certPem);

    const der = new Uint8Array(parsed.raw);
    const viaDer = createHash('sha256').update(spkiDerOf(der)).digest('base64');
    expect(pinByNode(cert.certPem)).toBe(key.pin.spkiSha256);
    expect(viaDer).toBe(key.pin.spkiSha256);
    expect(cert.pin.spkiSha256).toBe(key.pin.spkiSha256);

    expect(parsed.checkPrivateKey(key.privateKey)).toBe(true);
    expect(parsed.verify(parsed.publicKey)).toBe(true);
    expect(parsed.subject).toBe('CN=Chatterang tunnel');
    expect(parsed.issuer).toBe(parsed.subject);
    /*
     * `X509Certificate.ca` CANNOT SAY THIS ALONE. OpenSSL calls a certificate a
     * CA only when basicConstraints says cA AND any key usage includes
     * keyCertSign — and this one's key usage is digital signature only, so a
     * certificate issued with `cA: TRUE` still read `ca === false`. Mutation
     * testing found it: flipping the flag passed this whole file. So the two
     * extensions are read from the DER: basicConstraints critical with cA
     * absent (DER omits the FALSE default), key usage critical with
     * digitalSignature and nothing else.
     */
    expect(parsed.ca).toBe(false);
    expect(extensionOf(der, BASIC_CONSTRAINTS)).toEqual({ critical: true, value: [0x30, 0x00] });
    expect(extensionOf(der, KEY_USAGE)).toEqual({ critical: true, value: [0x03, 0x02, 0x07, 0x80] });
    expect(parsed.keyUsage).toEqual(['1.3.6.1.5.5.7.3.1']);
    expect(cert.serialNumber).toMatch(/^[4-7][0-9a-f]{31}$/);
    expect(parsed.serialNumber.toLowerCase()).toBe(cert.serialNumber);

    // The subject key identifier the doc comment promises: non-critical, and
    // RFC 5280 §4.2.1.2 method (1) — SHA-1 of the subjectPublicKey BIT STRING's
    // bits, which for P-256 are the 65-octet uncompressed point closing the SPKI.
    const point = spkiDerOf(der).slice(-65);
    expect(point[0], 'an uncompressed EC point').toBe(0x04);
    const identifier = [...createHash('sha1').update(point).digest()];
    expect(extensionOf(der, SUBJECT_KEY_IDENTIFIER)).toEqual({ critical: false, value: [0x04, 0x14, ...identifier] });
  });

  it('gives every certificate a positive 16-octet serial with no leading zero octet', async () => {
    // Many issues, not one: a random first octet passes a single `^[4-7]`
    // check one time in four, which is how dropping the masking survived.
    const key = generateTunnelKey();
    const serials = new Set<string>();
    for (let issued = 0; issued < 32; issued += 1) {
      const { certPem, serialNumber } = await issueTunnelCertificate(key, { validDays: 1 });
      expect(serialNumber).toMatch(/^[4-7][0-9a-f]{31}$/);
      expect(new X509Certificate(certPem).serialNumber.toLowerCase()).toBe(serialNumber);
      serials.add(serialNumber);
    }
    expect(serials.size).toBe(32);
  });

  it('forgets a library load that failed, so the next issue loads it again', async () => {
    // A fresh copy of the module, so its cached load starts empty, whose first
    // import of the library fails.
    vi.resetModules();
    vi.doMock('@peculiar/x509', () => {
      throw new Error('the library failed to load');
    });
    try {
      const fresh = await import('@chatterang/tunnel/host');
      const key = fresh.generateTunnelKey();
      await expect(fresh.issueTunnelCertificate(key, { validDays: 1 })).rejects.toThrow();
      vi.doUnmock('@peculiar/x509');
      const cert = await fresh.issueTunnelCertificate(key, { validDays: 1 });
      expect(pinByNode(cert.certPem)).toBe(key.pin.spkiSha256);
    } finally {
      vi.doUnmock('@peculiar/x509');
      vi.resetModules();
    }
  });

  it('carries no names unless it is given some, and then exactly those (#180, #295)', async () => {
    const key = generateTunnelKey();
    const bare = new X509Certificate((await issueTunnelCertificate(key, { validDays: 1 })).certPem);
    expect(bare.subjectAltName).toBeUndefined();
    expect(bare.checkHost('localhost')).toBeUndefined();
    expect(bare.checkIP('127.0.0.1')).toBeUndefined();

    const named = new X509Certificate(
      (
        await issueTunnelCertificate(key, {
          validDays: 1,
          subjectAltNames: [
            { type: 'dns', value: 'johns-macbook.local' },
            { type: 'ip', value: '192.168.1.50' },
            { type: 'ip', value: 'fe80::1' },
          ],
        })
      ).certPem,
    );
    expect(named.checkHost('johns-macbook.local')).toBe('johns-macbook.local');
    expect(named.checkIP('192.168.1.50')).toBe('192.168.1.50');
    expect(named.checkIP('fe80::1')).toBe('fe80::1');
    expect(named.checkHost('localhost')).toBeUndefined();
    expect(named.checkIP('192.168.1.51')).toBeUndefined();
  });

  it('refuses a name it would have to guess at', async () => {
    const key = generateTunnelKey();
    for (const name of [
      { type: 'dns', value: '' },
      { type: 'dns', value: '*.local' },
      { type: 'dns', value: 'bad name.local' },
      { type: 'dns', value: 'a..b' },
      { type: 'dns', value: 'trailing.local.' },
      { type: 'dns', value: '-leading.local' },
      { type: 'dns', value: `${'a'.repeat(64)}.local` },
      { type: 'dns', value: 'trailing-.local' },
      // 254 octets, every label within 63: refused for its length alone.
      { type: 'dns', value: ['a'.repeat(63), 'b'.repeat(63), 'c'.repeat(63), 'd'.repeat(62)].join('.') },
      { type: 'ip', value: '999.1.1.1' },
      // The URL parser serialises it `fe80::1`: a spelling it would change.
      { type: 'ip', value: 'FE80::1' },
      { type: 'ip', value: '192.168.001.1' },
      { type: 'ip', value: '1.2.3' },
      { type: 'ip', value: 'johns-macbook.local' },
      { type: 'ip', value: '0:0:0:0:0:0:0:1' },
      { type: 'ip', value: 'fe80::1%en0' },
      { type: 'uri', value: 'https://example.com' },
    ]) {
      await expect(
        issueTunnelCertificate(key, { validDays: 1, subjectAltNames: [name as TunnelSubjectAltName] }),
        JSON.stringify(name),
      ).rejects.toThrow(RangeError);
    }

    // The limits are limits, not a stricter rule: 253 octets and a 63-octet label pass.
    const longest = ['a'.repeat(63), 'b'.repeat(63), 'c'.repeat(63), 'd'.repeat(61)].join('.');
    expect(longest).toHaveLength(253);
    const named = await issueTunnelCertificate(key, { validDays: 1, subjectAltNames: [{ type: 'dns', value: longest }] });
    expect(new X509Certificate(named.certPem).subjectAltName).toBe(`DNS:${longest}`);
  });

  it('lasts validDays from a back-dated start, and refuses a lifetime nobody chose', async () => {
    const key = generateTunnelKey();
    const cert = await issueTunnelCertificate(key, { validDays: 30, now: new Date('2026-09-14T12:00:00.750Z') });
    expect(cert.notBefore.toISOString()).toBe('2026-09-14T11:00:00.000Z');
    expect(cert.notAfter.toISOString()).toBe('2026-10-14T12:00:00.000Z');
    const parsed = new X509Certificate(cert.certPem);
    expect(new Date(parsed.validFrom).toISOString()).toBe(cert.notBefore.toISOString());
    expect(new Date(parsed.validTo).toISOString()).toBe(cert.notAfter.toISOString());

    for (const validDays of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53]) {
      await expect(issueTunnelCertificate(key, { validDays }), String(validDays)).rejects.toThrow(RangeError);
    }
  });

  it('reissuing keeps the pin — the key outlives the certificate (#180)', async () => {
    const key = generateTunnelKey();
    const first = await issueTunnelCertificate(key, { validDays: 1 });
    // Reissued from the key as a store would hand it back: through its PEM.
    const second = await issueTunnelCertificate(tunnelKeyFromPkcs8Pem(tunnelKeyPkcs8Pem(key)), {
      validDays: 90,
      subjectAltNames: [{ type: 'dns', value: 'renamed.local' }],
    });
    expect(second.certPem).not.toBe(first.certPem);
    expect(second.serialNumber).not.toBe(first.serialNumber);
    expect(pinByNode(first.certPem)).toBe(key.pin.spkiSha256);
    expect(pinByNode(second.certPem)).toBe(key.pin.spkiSha256);
    expect(second.pin.spkiSha256).toBe(first.pin.spkiSha256);
  });

  it('refuses to hand out a certificate that does not carry the key it was issued for', async () => {
    const signing = generateTunnelKey();
    const forged: TunnelKey = { privateKey: signing.privateKey, pin: generateTunnelKey().pin };
    const error = await issueTunnelCertificate(forged, { validDays: 1 }).then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(TunnelIdentityError);
    expect((error as TunnelIdentityError).reason).toBe('pin-mismatch');
  });
});

describe('a TLS server built from the material, over loopback', () => {
  it('accepts a connection whose peer SPKI is the pin, and a pinning client refuses any other key', async () => {
    const key = generateTunnelKey();
    const server = await serve(key, (await issueTunnelCertificate(key, { validDays: 1 })).certPem);

    const pinned = await connectPinned(server.port, key.pin.spkiSha256);
    expect(pinned).toEqual({ accepted: true, peerPin: key.pin.spkiSha256, protocol: 'TLSv1.3' });
    await vi.waitFor(() => expect(server.secured()).toBe(1));

    const refused = await connectPinned(server.port, generateTunnelKey().pin.spkiSha256);
    expect(refused.accepted).toBe(false);
    expect(refused.peerPin).toBe(key.pin.spkiSha256);
  });

  it('a certificate reissued on the same key is invisible to a client holding the pin', async () => {
    const key = generateTunnelKey();
    const before = await serve(key, (await issueTunnelCertificate(key, { validDays: 1 })).certPem);
    const after = await serve(key, (await issueTunnelCertificate(key, { validDays: 365 })).certPem);
    expect((await connectPinned(before.port, key.pin.spkiSha256)).accepted).toBe(true);
    expect((await connectPinned(after.port, key.pin.spkiSha256)).accepted).toBe(true);
  });
});

/*
 * #180, RULED: the key lives until it is deliberately reset, and its
 * certificates are re-issued from it before they expire. What a paired client
 * holds is the SPKI pin, so every assertion here that a certificate was replaced
 * is paired with one that the pin — computed by node:crypto from the new
 * certificate, not taken from the module — did not move.
 */
describe('a certificate is re-issued from the same key before it expires (#180)', () => {
  const T = new Date('2026-09-14T12:00:00.000Z');
  const DAY = 86_400_000;
  const at = (days: number, ms = 0): Date => new Date(T.getTime() + days * DAY + ms);

  it('names the margin: thirty days', () => {
    expect(TUNNEL_CERTIFICATE_REISSUE_MARGIN_DAYS).toBe(30);
  });

  it('keeps a certificate that carries the key, is valid, and has more than the margin left', async () => {
    const key = generateTunnelKey();
    const issued = await issueTunnelCertificate(key, { validDays: 90, now: T });
    // One millisecond short of thirty days left.
    const kept = await currentTunnelCertificate(key, issued.certPem, { validDays: 90, now: at(60, -1) });
    expect(kept).toMatchObject({ issued: false, previous: 'current' });
    expect(kept.certificate).toEqual(issued);
  });

  it('re-issues inside the margin from the same key: a new certificate, the same SPKI pin', async () => {
    const key = generateTunnelKey();
    const issued = await issueTunnelCertificate(key, { validDays: 90, now: T });
    // Handed back through its PEM, as a store would.
    const stored = tunnelKeyFromPkcs8Pem(tunnelKeyPkcs8Pem(key));
    const renewed = await currentTunnelCertificate(stored, issued.certPem, { validDays: 90, now: at(60) });
    expect(renewed).toMatchObject({ issued: true, previous: 'expiring' });
    expect(renewed.certificate.certPem).not.toBe(issued.certPem);
    expect(renewed.certificate.serialNumber).not.toBe(issued.serialNumber);
    expect(renewed.certificate.notAfter.toISOString()).toBe(at(150).toISOString());

    expect(pinByNode(renewed.certificate.certPem)).toBe(pinByNode(issued.certPem));
    expect(pinByNode(renewed.certificate.certPem)).toBe(key.pin.spkiSha256);
    expect(new X509Certificate(renewed.certificate.certPem).checkPrivateKey(key.privateKey)).toBe(true);

    // And the renewal is what is kept from then on.
    const next = await currentTunnelCertificate(key, renewed.certificate.certPem, { validDays: 90, now: at(61) });
    expect(next).toMatchObject({ issued: false, previous: 'current' });

    // A client that holds only the pin accepts the renewed certificate.
    const server = await serve(key, renewed.certificate.certPem);
    expect((await connectPinned(server.port, key.pin.spkiSha256)).accepted).toBe(true);
  });

  it.each([
    ['exactly at its expiry', 90, 'expired'],
    ['a month after its expiry', 120, 'expired'],
    ['before its back-dated start', -1, 'not-yet-valid'],
  ] as const)('re-issues a certificate %s, from the same key', async (_label, days, previous) => {
    const key = generateTunnelKey();
    const issued = await issueTunnelCertificate(key, { validDays: 90, now: T });
    const renewed = await currentTunnelCertificate(key, issued.certPem, { validDays: 90, now: at(days) });
    expect(renewed).toMatchObject({ issued: true, previous });
    expect(pinByNode(renewed.certificate.certPem)).toBe(key.pin.spkiSha256);
  });

  it('issues one from the key when there is none', async () => {
    const key = generateTunnelKey();
    const first = await currentTunnelCertificate(key, null, { validDays: 90, now: T });
    expect(first).toMatchObject({ issued: true, previous: 'missing' });
    expect(pinByNode(first.certificate.certPem)).toBe(key.pin.spkiSha256);
  });

  it('never serves a certificate of another key: it issues one from this key instead', async () => {
    const key = generateTunnelKey();
    const other = await issueTunnelCertificate(generateTunnelKey(), { validDays: 90, now: T });
    const renewed = await currentTunnelCertificate(key, other.certPem, { validDays: 90, now: at(1) });
    expect(renewed).toMatchObject({ issued: true, previous: 'another-key' });
    expect(pinByNode(renewed.certificate.certPem)).toBe(key.pin.spkiSha256);
  });

  it('never serves a certificate that carries this key but was signed by another', async () => {
    const key = generateTunnelKey();
    const signer = generateTunnelKey();
    await import('reflect-metadata');
    const x509 = await import('@peculiar/x509');
    const crypto = webcrypto as unknown as Crypto;
    const algorithm = { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' };
    const forged = await x509.X509CertificateGenerator.create(
      {
        serialNumber: '4a',
        subject: 'CN=Chatterang tunnel',
        issuer: 'CN=Chatterang tunnel',
        notBefore: at(0, -3_600_000),
        notAfter: at(90),
        signingAlgorithm: algorithm,
        publicKey: await crypto.subtle.importKey(
          'spki',
          new Uint8Array(createPublicKey(key.privateKey).export({ type: 'spki', format: 'der' })),
          algorithm,
          true,
          ['verify'],
        ),
        signingKey: await crypto.subtle.importKey(
          'pkcs8',
          new Uint8Array(signer.privateKey.export({ type: 'pkcs8', format: 'der' })),
          algorithm,
          false,
          ['sign'],
        ),
      },
      crypto,
    );
    const forgedPem = forged.toString('pem');
    // The control: it does carry this key, so only the signature tells it apart.
    expect(pinByNode(forgedPem)).toBe(key.pin.spkiSha256);

    const renewed = await currentTunnelCertificate(key, forgedPem, { validDays: 90, now: at(1) });
    expect(renewed).toMatchObject({ issued: true, previous: 'not-signed-by-key' });
    expect(renewed.certificate.certPem).not.toBe(forgedPem);
    const parsed = new X509Certificate(renewed.certificate.certPem);
    expect(parsed.verify(createPublicKey(key.privateKey))).toBe(true);
    expect(pinByNode(renewed.certificate.certPem)).toBe(key.pin.spkiSha256);
  });

  it('replaces anything that is not exactly one certificate it can read', async () => {
    const key = generateTunnelKey();
    const issued = await issueTunnelCertificate(key, { validDays: 90, now: T });
    const second = await issueTunnelCertificate(key, { validDays: 90, now: T });
    for (const [label, text] of [
      ['empty', ''],
      ['garbage', 'not a certificate'],
      ['a PEM block that is not DER', '-----BEGIN CERTIFICATE-----\nbm90IGEgY2VydGlmaWNhdGU=\n-----END CERTIFICATE-----\n'],
      ['the private key', tunnelKeyPkcs8Pem(key)],
      ['two certificates', `${issued.certPem}${second.certPem}`],
      ['the certificate with text before it', `a note\n${issued.certPem}`],
      ['the certificate with text after it', `${issued.certPem}trailing\n`],
    ] as const) {
      const renewed = await currentTunnelCertificate(key, text, { validDays: 90, now: at(1) });
      expect(renewed, label).toMatchObject({ issued: true, previous: 'unreadable' });
      expect(pinByNode(renewed.certificate.certPem), label).toBe(key.pin.spkiSha256);
    }
  });

  it('refuses a lifetime inside the margin, which would re-issue on every call, and a clock that is not a date', async () => {
    const key = generateTunnelKey();
    for (const validDays of [TUNNEL_CERTIFICATE_REISSUE_MARGIN_DAYS, 1, 0, -1, 30.5, 45.5, Number.NaN]) {
      await expect(currentTunnelCertificate(key, null, { validDays }), String(validDays)).rejects.toThrow(RangeError);
    }
    await expect(currentTunnelCertificate(key, null, { validDays: 90, now: new Date('not a date') })).rejects.toThrow(
      RangeError,
    );
    // The limit is the margin, not a stricter rule.
    const shortest = await currentTunnelCertificate(key, null, { validDays: TUNNEL_CERTIFICATE_REISSUE_MARGIN_DAYS + 1, now: T });
    expect(shortest.issued).toBe(true);
    expect((await currentTunnelCertificate(key, shortest.certificate.certPem, { validDays: 31, now: T })).issued).toBe(false);
    // Refused even when a certificate would be kept and nothing issued.
    await expect(
      currentTunnelCertificate(key, shortest.certificate.certPem, { validDays: 45.5, now: T }),
    ).rejects.toThrow(RangeError);
  });
});

// Where the library may be imported, and that importing the host loads none of
// it, is `tests/tunnel-identity-library.test.ts`: the runtime half of that needs
// a worker in which nothing has issued a certificate yet, and this file issues many.
