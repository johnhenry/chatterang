/**
 * ONE CHANNEL BINDING, BOTH PAIRING ROUTES (#256).
 *
 * #256's asymmetry: #134's payload carries a 32-byte SPKI fingerprint, so a
 * SCANNED code lets the phone pin the certificate before it opens a socket. A
 * TYPED code is six digits and nothing else — no payload, so no fingerprint,
 * so the phone connects to whatever answers.
 *
 * CPace closes the guessing problem and not this one. A PAKE proves both
 * parties knew the same short secret; it says nothing about whether the party
 * you ran it with is the party terminating your TLS connection. The fix is to
 * put the SPKI the socket ACTUALLY negotiated into CPace's `CI`, so a
 * man-in-the-middle — who necessarily terminates two connections with two
 * certificates — makes the two honest sides derive different keys and fail
 * confirmation, learning nothing about the code from the failure.
 *
 * ## Why this is one function and not two
 *
 * #256 asks whether the QR route should use the same binding and answers its
 * own question: it should, "for one code path rather than two — the QR route's
 * pin is a STRONGER check, not a different one, and having both is defence in
 * depth". So both routes bind the negotiated SPKI here, identically, and the
 * scanned route ALSO checks it against the pin it arrived with. Two routes
 * with one binding and one extra check, rather than two bindings that can
 * drift apart.
 *
 * ## Where this sits
 *
 * Its own half, because it is the only place that needs BOTH `pairing/` (which
 * owns the payload and may import nothing, per #223 and the layering guard)
 * and `pake/` (which may import noble and nothing else). Putting it in either
 * would have broken that half's rule, and the rules are what keep the pairing
 * parser runnable on the old phone whose owner is trying to pair it.
 */

import { SPKI_BYTES, channelIdentifier } from '../pake/index.js';
import { TRUST_SPKI_PIN, type HostKind, type PairingPayload } from '../pairing/index.js';

/**
 * The two ends, as fixed labels rather than anything caller-supplied.
 *
 * CPace's `CI` names the participants. These are constants because a
 * caller-chosen label is a value an attacker can influence, and there is
 * nothing here a deployment legitimately needs to vary — the phone always
 * initiates (it is the half that scans or types) and the host always responds.
 */
const INITIATOR = 'chatterang-phone';
const RESPONDER = 'chatterang-host';

export type BindingErrorReason =
  /** The certificate the socket negotiated is not the one the code pinned. */
  | 'pin-mismatch'
  /** A trust mode this build does not implement. #154 owns the enumeration. */
  | 'unsupported-trust-mode'
  /** The plugin reported a fingerprint that is not 32 bytes. */
  | 'bad-negotiated-spki';

export class BindingError extends Error {
  override readonly name = 'BindingError';
  constructor(readonly reason: BindingErrorReason) {
    super(`pairing binding failed: ${reason}`);
  }
}

/** How the user started this pairing attempt. */
export type PairingRoute =
  | { readonly kind: 'scanned'; readonly payload: PairingPayload }
  | { readonly kind: 'typed'; readonly hostKind: HostKind };

/**
 * What the transport negotiated, reported by the native socket plugin (#181).
 *
 * `src/` cannot see a certificate — this is the value that has to cross the
 * bridge, and `packages/contracts` declares the method that carries it.
 */
export interface NegotiatedPeer {
  /** SHA-256 of the peer's SubjectPublicKeyInfo. The same 32 bytes #134 carries. */
  readonly spki: Uint8Array;
}

/**
 * Compare two fingerprints without leaking where they first differ.
 *
 * A pin mismatch is attacker-triggerable and repeatable, so an early return
 * would hand out the matching prefix a byte at a time. Length is compared
 * first and openly: it is not secret, and both values are fixed-size anyway.
 */
function equalFingerprints(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

/**
 * The `CI` for this pairing attempt.
 *
 * Throws on the scanned route when the pin does not match, BEFORE any exchange
 * runs — that is the stronger check, and failing early means an attacker with
 * the right code but the wrong certificate never gets a transcript at all.
 * On the typed route there is no pin to check and the binding IS the defence,
 * which is the whole of #256.
 */
export function channelIdentifierFor(route: PairingRoute, negotiated: NegotiatedPeer): Uint8Array {
  if (negotiated.spki.length !== SPKI_BYTES) throw new BindingError('bad-negotiated-spki');

  if (route.kind === 'scanned') {
    const { payload } = route;
    /*
     * #134 makes `trust` 32 OPAQUE bytes whose meaning is named by
     * `trustMode`, and refuses a default. So a mode this build does not
     * implement is an error rather than an assumption: reading
     * `TRUST_STATIC_KEY` bytes as a fingerprint would compare two unrelated
     * values and fail confusingly, or worse, pass.
     */
    if (payload.trustMode !== TRUST_SPKI_PIN) throw new BindingError('unsupported-trust-mode');
    if (!equalFingerprints(payload.trust, negotiated.spki)) throw new BindingError('pin-mismatch');
    return channelIdentifier({
      initiator: INITIATOR,
      responder: RESPONDER,
      hostKind: payload.hostKind,
      /*
       * THE NEGOTIATED VALUE, and the two are provably equal by the line
       * above — so this is not a second check and no test can tell the two
       * spellings apart. Mutation testing says so directly: swapping this for
       * `payload.trust` survives the whole suite, which is correct and worth
       * recording rather than papering over with an assertion that cannot
       * fail.
       *
       * It is still the right expression, for a reason that is about meaning
       * rather than defence. Channel binding is DEFINED as binding what the
       * transport actually negotiated; the pin is a separate, earlier, and
       * stronger check that the negotiated thing is the expected one. Writing
       * it this way makes both routes one expression, so the typed route
       * cannot quietly acquire different semantics from the scanned one — the
       * single failure #256 asks this module to prevent.
       */
      spki: negotiated.spki,
    });
  }

  return channelIdentifier({
    initiator: INITIATOR,
    responder: RESPONDER,
    hostKind: route.hostKind,
    spki: negotiated.spki,
  });
}
