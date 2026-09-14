/**
 * THE TUNNEL'S TLS IDENTITY (#179, #180): a key that lasts, and certificates
 * made from it that do not have to.
 *
 * WHAT A PAIRED CLIENT HOLDS IS THE KEY, NOT THE CERTIFICATE. #134's payload
 * carries 32 bytes, the native socket plugin reports them as
 * `NegotiatedPeerCertificate.spkiSha256` (`packages/contracts/src/
 * tunnel-socket.ts`), and `channelIdentifierFor` (`../binding/index.ts`)
 * compares and binds them. All three are the SHA-256 of the DER
 * SubjectPublicKeyInfo — the public KEY — so a certificate can be re-issued
 * from the stored key as often as anything needs and the pin a phone already
 * holds stays true. {@link TunnelPin} is that one value in both spellings those
 * two files use: 32 bytes for the binding, standard padded base64 (RFC 4648 §4)
 * for anything that crosses a bridge.
 *
 * KEY ROTATION IS NOT HERE, AND WHEN IT COMES IT IS A LOUD RE-PAIR. A new key is
 * a new pin, and there is no channel to tell a phone (#180): every paired device
 * refuses the desktop until it pairs again. So nothing here or in
 * `identity-store.ts` makes a key except when none exists — a key that fails to
 * load is refused, never quietly replaced — and how long a key lives is not
 * decided (#179 leaves it open).
 *
 * NAMES ARE A PARAMETER, EMPTY BY DEFAULT. Whether a client checks the
 * certificate's hostnames or only the pin is its own question (#180, #295). A
 * certificate carries exactly the names its caller passes, and none otherwise.
 *
 * WHY EC P-256 AND NOT ED25519. Measured with the library pinned below, on both
 * runtimes that will call this: an Ed25519 certificate issues and handshakes
 * under Node 24.18 (OpenSSL 3.5), and FAILS the TLS 1.3 handshake with alert 40
 * (handshake_failure) under Electron 44.0.0, whose Node links BoringSSL. The
 * desktop is Electron. P-256 with ECDSA-SHA256 handshakes on both, and it is the
 * signature scheme every phone TLS stack supports; Ed25519 on iOS and Android
 * was never measured.
 *
 * WHY A LIBRARY, AND WHICH (#179). The ruling rejects the system `openssl` and
 * a hand-written signer. `@peculiar/x509@2.1.0` (MIT) builds the ASN.1 and
 * hands the signature to WebCrypto — Node's own, passed explicitly — so no
 * elliptic-curve arithmetic belongs to it or to this file. It needs a Reflect
 * metadata polyfill (measured: without one its import throws, on both runtimes),
 * and `reflect-metadata@0.2.2` (Apache-2.0) is that. Both load on the first
 * issue rather than at import, so importing this entry to start a listener
 * patches no global.
 *
 * BINDS NOTHING. It is in the host half because it is Node-only and must never
 * reach the phone bundle, not because it opens anything.
 */

import {
  X509Certificate,
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  timingSafeEqual,
  webcrypto,
} from 'node:crypto';
import type { KeyObject } from 'node:crypto';

export type TunnelIdentityErrorReason =
  /**
   * Owner-only cannot be checked here: a platform whose permissions this store
   * has not been taught to read (anything but Linux and macOS), or no uid.
   */
  | 'unsupported-platform'
  /** The directory the key's directory is made in is not this account's alone to write. */
  | 'data-directory-unsafe'
  /** The key's directory is not a real, owner-only directory of this account's. */
  | 'key-directory-unsafe'
  /** The key file is not a regular, owner-only file of this account's. */
  | 'key-file-unsafe'
  /** The key file is not a key file this build writes. */
  | 'key-file-malformed'
  /** The key file is sealed, and this process has nothing to unseal it with. */
  | 'encryption-unavailable'
  /** The key file is plain, and this process can seal: a key kept in the clear where it need not be. */
  | 'protection-downgrade'
  /** The desktop asked before Electron's `ready`, when `safeStorage` cannot yet say whether it can seal. */
  | 'not-ready'
  /** The sealed key did not unseal. */
  | 'unseal-failed'
  /** The key is not an EC P-256 private key in PKCS#8 PEM. */
  | 'key-unsupported'
  /** A key is not the one its pin records, or a certificate does not carry its key. */
  | 'pin-mismatch';

/**
 * Why the identity was refused.
 *
 * THE MESSAGE NEVER CARRIES KEY MATERIAL. Every refusal here is about bytes
 * that are a secret or were meant to be, so messages name paths, modes, owners
 * and reasons, and a parser's own error is dropped rather than chained.
 */
export class TunnelIdentityError extends Error {
  override readonly name = 'TunnelIdentityError';
  constructor(
    readonly reason: TunnelIdentityErrorReason,
    detail: string,
  ) {
    super(`tunnel identity refused (${reason}): ${detail}`);
  }
}

/** The value a paired client pins, in both spellings the tunnel uses. */
export interface TunnelPin {
  /** SHA-256 of the DER SubjectPublicKeyInfo: `NegotiatedPeer.spki`'s 32 bytes. */
  readonly spki: Uint8Array;
  /** The same 32 bytes, standard padded base64: `NegotiatedPeerCertificate.spkiSha256`. */
  readonly spkiSha256: string;
}

/**
 * The tunnel's private key, and its pin.
 *
 * A `KeyObject` rather than PEM text: logging one prints its type and no key
 * material, so the secret leaves this form only through
 * {@link tunnelKeyPkcs8Pem}, where a search can find every use.
 */
export interface TunnelKey {
  readonly privateKey: KeyObject;
  readonly pin: TunnelPin;
}

/** The pin of a public key, or of a private key's public half. */
export function tunnelPinOf(key: KeyObject): TunnelPin {
  const publicKey = key.type === 'public' ? key : createPublicKey(key);
  const digest = createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest();
  return { spki: new Uint8Array(digest), spkiSha256: digest.toString('base64') };
}

/** Are two pins the same key? Constant time over the 32 bytes. */
export function sameTunnelPin(a: TunnelPin, b: TunnelPin): boolean {
  return a.spki.length === b.spki.length && timingSafeEqual(a.spki, b.spki);
}

/** A new EC P-256 key. The only place a tunnel key is made. */
export function generateTunnelKey(): TunnelKey {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return { privateKey, pin: tunnelPinOf(privateKey) };
}

/**
 * One unencrypted PKCS#8 PEM block and nothing else: what {@link tunnelKeyPkcs8Pem}
 * writes. Line lengths are not pinned, so a runtime that wraps base64 differently
 * still reads its own file.
 */
const PKCS8_PEM = /^-----BEGIN PRIVATE KEY-----\n(?:[A-Za-z0-9+/=]+\n)+-----END PRIVATE KEY-----\n?$/;

/**
 * A stored key, read back — refused unless it is an EC P-256 private key, as
 * exactly one unencrypted PKCS#8 PEM block.
 *
 * A key of any other kind is not converted or accepted "for now": its pin would
 * be a different value, and the certificate it signed would fail the handshake
 * on at least one runtime (see the header). The PEM is checked before
 * `createPrivateKey` sees it because that parser is more forgiving than the
 * name of this function: it takes a SEC1 `EC PRIVATE KEY` block, and it reads
 * the first block of a file and ignores whatever follows it.
 */
export function tunnelKeyFromPkcs8Pem(pem: string): TunnelKey {
  if (!PKCS8_PEM.test(pem)) {
    throw new TunnelIdentityError('key-unsupported', 'the stored key is not one unencrypted PKCS#8 PEM block');
  }
  let privateKey: KeyObject;
  try {
    privateKey = createPrivateKey({ key: pem, format: 'pem' });
  } catch {
    throw new TunnelIdentityError('key-unsupported', 'the stored key is not a readable private key');
  }
  const curve = privateKey.asymmetricKeyDetails?.namedCurve;
  // The curve alone decides: only an EC key reports `prime256v1`, so a
  // separate key-type check would be a condition no input can make matter.
  if (curve !== 'prime256v1') {
    const found = `${privateKey.asymmetricKeyType ?? 'unknown'}${curve === undefined ? '' : ` ${curve}`}`;
    throw new TunnelIdentityError('key-unsupported', `expected an EC P-256 private key, found ${found}`);
  }
  return { privateKey, pin: tunnelPinOf(privateKey) };
}

/** The private key as PKCS#8 PEM: what a TLS context and the key store need. */
export function tunnelKeyPkcs8Pem(key: TunnelKey): string {
  return key.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
}

/** A name a certificate may carry. Canonical spellings only; see {@link issueTunnelCertificate}. */
export type TunnelSubjectAltName =
  | { readonly type: 'dns'; readonly value: string }
  | { readonly type: 'ip'; readonly value: string };

export interface TunnelCertificateOptions {
  /**
   * Days from `now` until the certificate expires. REQUIRED, WITH NO DEFAULT.
   *
   * How long one certificate lasts is part of the lifetime question #179 leaves
   * open, and a number picked here would be that decision made where nobody can
   * see it. Re-issuing is free — the key, and so the pin, does not change.
   */
  readonly validDays: number;
  /** Names to carry. Omitted or empty: none (#180, #295). */
  readonly subjectAltNames?: readonly TunnelSubjectAltName[];
  /** The issuing clock. Tests fix it. */
  readonly now?: Date;
}

export interface TunnelCertificate {
  readonly certPem: string;
  /** The pin of the key the certificate carries — the issuing key's pin. */
  readonly pin: TunnelPin;
  readonly serialNumber: string;
  readonly notBefore: Date;
  readonly notAfter: Date;
}

/** The subject. Fixed, so no caller string is ever parsed as a distinguished name. */
const COMMON_NAME = 'Chatterang tunnel';
const MS_PER_DAY = 86_400_000;
/**
 * How far `notBefore` is back-dated. A phone whose clock runs behind the
 * desktop's would otherwise be handed a certificate that is not yet valid.
 */
const CLOCK_SKEW_MS = 60 * 60 * 1000;

const DNS_LABEL = /^(?!-)[A-Za-z0-9-]{1,63}(?<!-)$/;
const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;

/**
 * Refuse a name rather than normalise it.
 *
 * Canonical means: DNS names of letters, digits and hyphens with no wildcard and
 * no trailing dot; IP addresses spelled the way the WHATWG URL parser serialises
 * them, so `192.168.001.1` (which it reads as octal) and a zone-scoped IPv6 are
 * refused rather than turned into an address nobody wrote.
 */
function assertSubjectAltName(name: TunnelSubjectAltName): void {
  if (name.type === 'dns') {
    if (name.value.length > 253 || !name.value.split('.').every((label) => DNS_LABEL.test(label))) {
      throw new RangeError(`not a DNS name a tunnel certificate carries: ${JSON.stringify(name.value)}`);
    }
    return;
  }
  if (name.type === 'ip') {
    const v6 = name.value.includes(':');
    let hostname: string;
    try {
      hostname = new URL(`https://${v6 ? `[${name.value}]` : name.value}/`).hostname;
    } catch {
      hostname = '';
    }
    // Compared as written, not lower-cased first: `FE80::1` serialises as
    // `fe80::1`, and a spelling the parser would change is refused.
    const canonical = v6 ? hostname === `[${name.value}]` : IPV4.test(name.value) && hostname === name.value;
    if (!canonical) throw new RangeError(`not a canonical IP address: ${JSON.stringify(name.value)}`);
    return;
  }
  throw new RangeError(
    `unsupported subject alternative name type: ${JSON.stringify((name as { type?: unknown }).type)}`,
  );
}

type X509 = typeof import('@peculiar/x509');
let x509Loading: Promise<X509> | null = null;

/**
 * The library, loaded once and on demand.
 *
 * THE ORDER IS THE REQUIREMENT: `tsyringe`, which `@peculiar/x509` imports,
 * throws at module evaluation unless `Reflect.getMetadata` already exists. A
 * failed load is forgotten so the next call retries instead of replaying it.
 */
function loadX509(): Promise<X509> {
  x509Loading ??= (async () => {
    await import('reflect-metadata');
    return import('@peculiar/x509');
  })().catch((error: unknown) => {
    x509Loading = null;
    throw error;
  });
  return x509Loading;
}

/**
 * A self-signed certificate for `key`.
 *
 * What it is: EC P-256 signed with ECDSA-SHA256, `CN=Chatterang tunnel`, not a
 * CA (critical), digital signature only (critical), server auth, a subject key
 * identifier, a random positive 16-byte serial, and a subject alternative name
 * extension only when names are given.
 *
 * CHECKED BEFORE IT IS RETURNED. The certificate is parsed back with Node's own
 * X.509 parser and refused unless the key it carries has `key`'s pin. That is
 * the one property every client depends on, and the library's encoder and
 * Node's parser are two different programs — so it is asserted where they meet
 * rather than assumed.
 */
export async function issueTunnelCertificate(
  key: TunnelKey,
  options: TunnelCertificateOptions,
): Promise<TunnelCertificate> {
  const { validDays } = options;
  // Fails closed. 0, NaN and 1.5 are a caller's mistake, and clamping would
  // hide it behind a lifetime nobody chose.
  if (!Number.isSafeInteger(validDays) || validDays < 1) {
    throw new RangeError(`validDays must be a positive integer, got ${String(validDays)}`);
  }
  const names = options.subjectAltNames ?? [];
  for (const name of names) assertSubjectAltName(name);

  // Whole seconds: X.509 times carry no milliseconds, and the dates returned
  // should be the dates the certificate says.
  const now = Math.floor((options.now ?? new Date()).getTime() / 1000) * 1000;
  const notBefore = new Date(now - CLOCK_SKEW_MS);
  const notAfter = new Date(now + validDays * MS_PER_DAY);
  if (Number.isNaN(notBefore.getTime()) || Number.isNaN(notAfter.getTime())) {
    throw new RangeError('the certificate validity is not a representable date range');
  }

  const x509 = await loadX509();
  // Node's WebCrypto, named rather than found on `globalThis`: this is the
  // implementation that signs, and it is chosen here. The cast is between
  // Node's and the DOM's declarations of the same interface.
  const crypto = webcrypto as unknown as Crypto;
  const algorithm = { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' };

  const pkcs8 = key.privateKey.export({ type: 'pkcs8', format: 'der' });
  let keys: CryptoKeyPair;
  try {
    keys = {
      privateKey: await crypto.subtle.importKey('pkcs8', new Uint8Array(pkcs8), algorithm, false, ['sign']),
      publicKey: await crypto.subtle.importKey(
        'spki',
        new Uint8Array(createPublicKey(key.privateKey).export({ type: 'spki', format: 'der' })),
        algorithm,
        true,
        ['verify'],
      ),
    };
  } finally {
    pkcs8.fill(0);
  }

  const serial = randomBytes(16);
  // Positive, and no leading zero octet: DER INTEGERs are signed.
  serial[0] = (serial[0]! & 0x7f) | 0x40;
  const serialNumber = serial.toString('hex');

  const certificate = await x509.X509CertificateGenerator.createSelfSigned(
    {
      serialNumber,
      name: [{ CN: [COMMON_NAME] }],
      notBefore,
      notAfter,
      signingAlgorithm: algorithm,
      keys,
      extensions: [
        new x509.BasicConstraintsExtension(false, undefined, true),
        new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature, true),
        new x509.ExtendedKeyUsageExtension([x509.ExtendedKeyUsage.serverAuth], false),
        await x509.SubjectKeyIdentifierExtension.create(keys.publicKey, false, crypto),
        ...(names.length > 0
          ? [new x509.SubjectAlternativeNameExtension(names.map(({ type, value }) => ({ type, value })), false)]
          : []),
      ],
    },
    crypto,
  );

  const certPem = certificate.toString('pem');
  const pin = tunnelPinOf(new X509Certificate(certPem).publicKey);
  if (!sameTunnelPin(pin, key.pin)) {
    throw new TunnelIdentityError('pin-mismatch', 'the issued certificate does not carry the key it was issued for');
  }
  return { certPem, pin, serialNumber, notBefore, notAfter };
}
