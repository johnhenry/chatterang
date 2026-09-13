import { sha512 } from '@noble/hashes/sha2.js';
import { describe, expect, it } from 'vitest';

import {
  BindingError,
  channelIdentifierFor,
  type PairingRoute,
} from '@chatterang/tunnel/binding';
import {
  beginExchange,
  computeConfirmation,
  finish,
  PakeError,
} from '@chatterang/tunnel/pake';
import {
  HOST_DESKTOP,
  HOST_SERVER,
  TRUST_SPKI_PIN,
  TRUST_STATIC_KEY,
  type PairingPayload,
} from '@chatterang/tunnel/pairing';

/**
 * #256: one channel binding, both pairing routes.
 *
 * The MITM case is testable IN PROCESS, with no network and no certificate —
 * which is the point #256 makes and the reason this is a cheap test for an
 * expensive property. An attacker in the path terminates two TLS connections
 * with two certificates; here that is just two different byte strings.
 */

const utf8 = (s: string) => new TextEncoder().encode(s);
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

const SPKI_REAL = sha512(utf8('the desktop’s real certificate')).slice(0, 32);
const SPKI_MITM = sha512(utf8('an attacker’s own certificate')).slice(0, 32);

function payloadWith(over: Partial<PairingPayload> = {}): PairingPayload {
  return {
    version: 1,
    hostKind: HOST_DESKTOP,
    trustMode: TRUST_SPKI_PIN,
    trust: SPKI_REAL,
    token: new Uint8Array(32).fill(7),
    expiresAt: 1_800_000_000,
    port: 8443,
    addresses: [{ kind: 1, value: Uint8Array.of(192, 168, 1, 10) }],
    name: 'John’s MacBook',
    ...over,
  } as PairingPayload;
}

describe('one binding, both routes — the core of #256', () => {
  it('the typed and scanned routes produce the SAME channel identifier', () => {
    /*
     * THE CLAIM #256 ACTUALLY MAKES: "one implementation used by both routes".
     * If these differed, the QR route and the typed route would be two
     * bindings that can drift apart, and a fix to one would silently not
     * apply to the other.
     */
    const scanned = channelIdentifierFor(
      { kind: 'scanned', payload: payloadWith() },
      { spki: SPKI_REAL },
    );
    const typed = channelIdentifierFor(
      { kind: 'typed', hostKind: HOST_DESKTOP },
      { spki: SPKI_REAL },
    );
    expect(hex(scanned)).toBe(hex(typed));
  });

  it('binds the NEGOTIATED certificate, so two hosts are two identifiers', () => {
    const a = channelIdentifierFor({ kind: 'typed', hostKind: HOST_DESKTOP }, { spki: SPKI_REAL });
    const b = channelIdentifierFor({ kind: 'typed', hostKind: HOST_DESKTOP }, { spki: SPKI_MITM });
    expect(hex(a)).not.toBe(hex(b));
  });

  it('a desktop and a headless server differ even on the same certificate', () => {
    const desktop = channelIdentifierFor({ kind: 'typed', hostKind: HOST_DESKTOP }, { spki: SPKI_REAL });
    const server = channelIdentifierFor({ kind: 'typed', hostKind: HOST_SERVER }, { spki: SPKI_REAL });
    expect(hex(desktop)).not.toBe(hex(server));
  });
});

describe('the scanned route keeps its pin, as a STRONGER check', () => {
  it('refuses before any exchange when the certificate is not the pinned one', () => {
    /*
     * #256: "the QR route's pin is a stronger check, not a different one, and
     * having both is defence in depth". Failing here rather than at
     * confirmation means an attacker holding the right code but the wrong
     * certificate never obtains a transcript at all.
     */
    expect(() =>
      channelIdentifierFor({ kind: 'scanned', payload: payloadWith() }, { spki: SPKI_MITM }),
    ).toThrow(BindingError);
    try {
      channelIdentifierFor({ kind: 'scanned', payload: payloadWith() }, { spki: SPKI_MITM });
    } catch (e) {
      expect((e as BindingError).reason).toBe('pin-mismatch');
    }
  });

  it('binds the negotiated value, which after the pin check is the same value', () => {
    /*
     * RECORDED BECAUSE MUTATION TESTING FOUND IT AND IT IS NOT A GAP.
     *
     * Replacing `negotiated.spki` with `payload.trust` inside the scanned
     * branch survives this whole suite, and must: the pin check immediately
     * above proves the two are byte-identical, so no observable behaviour
     * distinguishes them. An equivalent mutant is a fact about the code, not a
     * missing test, and the honest response is to say so rather than to invent
     * an assertion that cannot fail.
     *
     * What IS testable is the thing that makes the choice matter — that the
     * pin check runs at all — and the test above covers exactly that.
     */
    const pinned = channelIdentifierFor({ kind: 'scanned', payload: payloadWith() }, { spki: SPKI_REAL });
    const typed = channelIdentifierFor({ kind: 'typed', hostKind: HOST_DESKTOP }, { spki: SPKI_REAL });
    expect(hex(pinned)).toBe(hex(typed));
  });

  it('accepts the matching one — the paired control', () => {
    expect(() =>
      channelIdentifierFor({ kind: 'scanned', payload: payloadWith() }, { spki: SPKI_REAL }),
    ).not.toThrow();
  });

  it('refuses a trust mode this build does not implement, rather than guessing', () => {
    // #134 makes `trust` 32 OPAQUE bytes and refuses a default `trustMode`.
    // Reading static-key bytes as a fingerprint would compare two unrelated
    // values — confusingly failing, or worse, passing.
    expect(() =>
      channelIdentifierFor(
        { kind: 'scanned', payload: payloadWith({ trustMode: TRUST_STATIC_KEY }) },
        { spki: SPKI_REAL },
      ),
    ).toThrow(BindingError);
  });

  it('refuses a negotiated fingerprint that is not 32 bytes', () => {
    // A short fingerprint from a buggy bridge would still "work" — both sides
    // agreeing — while binding less than was measured.
    for (const n of [0, 16, 31, 33]) {
      expect(() =>
        channelIdentifierFor({ kind: 'typed', hostKind: HOST_DESKTOP }, { spki: new Uint8Array(n) }),
      ).toThrow(BindingError);
    }
  });
});

describe('the man in the middle, end to end', () => {
  const sid = Uint8Array.from({ length: 16 }, (_, i) => i + 1);
  /*
   * Valid ristretto255 scalars, which `fill(11)` is not: scalars are
   * little-endian and must be below the group order, so a full 32 bytes of
   * 0x0b overflows it. Setting only the low byte keeps them small and legal.
   * The paired control below is what caught this — a made-up scalar threw
   * RangeError, and a suite without the control would have read that as the
   * MITM test passing.
   */
  const scalarA = (() => { const s = new Uint8Array(32); s[0] = 11; return s; })();
  const scalarB = (() => { const s = new Uint8Array(32); s[0] = 22; return s; })();
  const CODE = '418329';

  /** Both sides type the right code; each sees the certificate given. */
  function pairOver(phoneSees: Uint8Array, hostSees: Uint8Array, route?: PairingRoute) {
    const r = route ?? ({ kind: 'typed', hostKind: HOST_DESKTOP } as const);
    const a = beginExchange({
      role: 'initiator', code: CODE, sid, scalar: scalarA,
      ci: channelIdentifierFor(r, { spki: phoneSees }),
    });
    const b = beginExchange({
      role: 'responder', code: CODE, sid, scalar: scalarB,
      ci: channelIdentifierFor(r, { spki: hostSees }),
    });
    return {
      ca: computeConfirmation(a.pending, b.message),
      cb: computeConfirmation(b.pending, a.message),
    };
  }

  it('an attacker who ALSO knows the code is still detected', () => {
    /*
     * The case a PAKE alone does not catch. Both honest parties knew the right
     * code — the guessing problem is closed — but the attacker terminated two
     * TLS connections, so the phone bound its certificate and the host bound
     * its own. Different CI, different key, confirmation fails, and the
     * failure tells the attacker nothing about the code.
     */
    const { ca, cb } = pairOver(SPKI_MITM, SPKI_REAL);
    expect(() => finish(ca, cb.tag)).toThrow(PakeError);
  });

  it('the same two parties with no one in the middle agree — the paired control', () => {
    // Without this, the test above passes on a binding that fails everything.
    const { ca, cb } = pairOver(SPKI_REAL, SPKI_REAL);
    expect(hex(finish(ca, cb.tag))).toBe(hex(finish(cb, ca.tag)));
  });

  it('the scanned route behaves identically once the pin has passed', () => {
    // Same binding, so the QR route's exchange is the typed route's exchange.
    const scanned = { kind: 'scanned', payload: payloadWith() } as const;
    const { ca, cb } = pairOver(SPKI_REAL, SPKI_REAL, scanned);
    expect(hex(finish(ca, cb.tag))).toBe(hex(finish(cb, ca.tag)));
  });
});
