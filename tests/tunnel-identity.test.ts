// @vitest-environment node
import { X509Certificate, createHash, createPublicKey, generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { connect, createServer } from 'node:tls';
import type { Server } from 'node:tls';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { NegotiatedPeerCertificate } from '@chatterang/contracts/tunnel-socket';
import { BindingError, channelIdentifierFor } from '@chatterang/tunnel/binding';
import { HOST_DESKTOP, TRUST_SPKI_PIN, type PairingPayload } from '@chatterang/tunnel/pairing';
import {
  TunnelIdentityError,
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

/** The DER encodings of two extension OIDs: 2.5.29.19 and 2.5.29.15. */
const BASIC_CONSTRAINTS = [0x06, 0x03, 0x55, 0x1d, 0x13] as const;
const KEY_USAGE = [0x06, 0x03, 0x55, 0x1d, 0x0f] as const;

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

  it('refuses a key that is not EC P-256, and never echoes it', () => {
    const pem = { privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } } as const;
    const p256 = generateKeyPairSync('ec', { namedCurve: 'P-256', ...pem });
    const cases: readonly (readonly [string, string])[] = [
      ['Ed25519', generateKeyPairSync('ed25519', pem).privateKey],
      ['P-384', generateKeyPairSync('ec', { namedCurve: 'P-384', ...pem }).privateKey],
      ['RSA', generateKeyPairSync('rsa', { modulusLength: 2048, ...pem }).privateKey],
      ['a public key', p256.publicKey],
      ['garbage', '-----BEGIN PRIVATE KEY-----\nbm90IGEga2V5IGF0IGFsbCwgbm90IGV2ZW4gY2xvc2U=\n-----END PRIVATE KEY-----\n'],
      ['empty', ''],
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
      { type: 'ip', value: '999.1.1.1' },
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

describe('the X.509 library reaches the desktop and the server, never the app bundle (#179)', () => {
  it('is pinned in packages/tunnel, undeclared at the root, and loaded only on first issue', () => {
    const manifest = (path: string) =>
      JSON.parse(readFileSync(resolve(process.cwd(), path), 'utf8')) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
    const root = manifest('package.json');
    const tunnel = manifest('packages/tunnel/package.json');
    // Undeclared at the root is what makes `tests/layering.test.ts`'s derived
    // rule ("src/ imports only what this app declares") refuse them in `src/`.
    for (const name of ['@peculiar/x509', 'reflect-metadata']) {
      expect(root.dependencies?.[name], name).toBeUndefined();
      expect(root.devDependencies?.[name], name).toBeUndefined();
    }
    // Exact versions, per the ruling.
    expect(tunnel.dependencies?.['@peculiar/x509']).toBe('2.1.0');
    expect(tunnel.dependencies?.['reflect-metadata']).toBe('0.2.2');

    // No static import of either, so importing the host entry patches no global.
    const source = readFileSync(resolve(process.cwd(), 'packages/tunnel/src/host/identity.ts'), 'utf8');
    const staticImport = /^\s*import\s[^;]*?['"](?:@peculiar\/x509|reflect-metadata)['"]/m;
    expect(source).not.toMatch(staticImport);
    expect(source).toContain("await import('reflect-metadata')");
    expect(source).toContain("import('@peculiar/x509')");
    // The matcher sees the imports it exists to catch.
    expect("import 'reflect-metadata';").toMatch(staticImport);
    expect("import * as x509 from '@peculiar/x509';").toMatch(staticImport);
  });
});
