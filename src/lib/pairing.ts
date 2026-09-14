/**
 * THE PAIRING SEAM: what either route hands off, and who takes it (#128, #130).
 *
 * The phone has two ways to begin pairing — scan a code the other machine draws,
 * or type a host and six digits — and both end in ONE request to a controller.
 * The controller is what connects, runs CPace and binds the channel, and it
 * cannot be written yet: the negotiated certificate fingerprint the binding
 * requires comes only from #181's native socket plugin, and a browser
 * `WebSocket` cannot report a peer certificate at all.
 *
 * So this file ships the SHAPE and an honest refusal, modelled on how
 * `MountHostWeb` refuses rather than pretends. `pairingController()` returns a
 * controller whose `available` is false. No screen offers pairing yet, and
 * `tests/layering.test.ts` refuses any file in `src/` other than this one,
 * `qr-scan.ts` and `qr-decode.ts` that imports the pairing half or the scanner,
 * or names `getUserMedia` — so the entry point, when it is built, arrives as an
 * edit to that allowlist rather than as an import nobody reviewed. That is a
 * rule about names: a camera reached another way, such as a file input with
 * `capture`, is not something it sees.
 *
 * The day `available` becomes true, `tests/privacy-copy.test.ts` fails until
 * every privacy surface's copy names a paired device, a paired-device panel is
 * mounted, and a table holds the devices. That forces the copy to be revisited
 * in the same change. It does not choose the sentence.
 *
 * It imports only the pairing half, which imports nothing, so it is safe on
 * every target — including the oldest phone #223 worries about.
 */

import {
  TRUST_SPKI_PIN,
  isExpired,
  isMulticastDnsName,
  type HostKind,
  type PairingAddress,
  type PairingPayload,
} from '@chatterang/tunnel/pairing';

/** What a route hands the controller. */
export type PairingRequest =
  | { readonly route: 'scanned'; readonly payload: PairingPayload }
  | {
      readonly route: 'typed';
      readonly address: PairingAddress;
      readonly port: number;
      /** Six ASCII digits, as text — CPace hashes the text. */
      readonly code: string;
      /**
       * Required, with no default. The channel binding puts it in CPace's CI so
       * a desktop and a headless server cannot be substituted for one another,
       * and it must come from the PERSON: taking it from the host's greeting
       * would let whoever answered choose it.
       */
      readonly hostKind: HostKind;
    };

/** Why a pairing did not complete, named rather than numbered. */
export type PairingRefusal =
  | 'pin-mismatch'
  | 'confirmation-failed'
  | 'expired'
  | 'unreachable'
  | 'exhausted'
  | 'unsupported-trust-mode'
  /** No controller exists on this build yet. Not the person's fault. */
  | 'transport-unavailable';

export type PairingOutcome =
  | { readonly kind: 'paired'; readonly deviceName: string }
  | { readonly kind: 'refused'; readonly reason: PairingRefusal };

export interface PairingController {
  /**
   * Can this build complete a pairing at all?
   *
   * The single value the UI keys on. While it is false, no entry point is
   * shown — so nobody is asked for camera permission for a feature that
   * cannot work.
   */
  readonly available: boolean;
  pair(request: PairingRequest, signal?: AbortSignal): Promise<PairingOutcome>;
}

/**
 * The controller this build has: one that refuses, honestly.
 *
 * It touches no network and holds nothing it is given — `tests/pairing-seam.
 * test.ts` watches `fetch` and `WebSocket` to hold it to that.
 */
export const UNAVAILABLE_PAIRING: PairingController = Object.freeze({
  available: false,
  async pair(): Promise<PairingOutcome> {
    return { kind: 'refused', reason: 'transport-unavailable' };
  },
});

/** The controller to use. One accessor, so replacing it is one line. */
export function pairingController(): PairingController {
  return UNAVAILABLE_PAIRING;
}

export type ScannedPayloadProblem = 'unsupported-trust-mode' | 'expired' | 'unreachable';

/**
 * Should a scanned payload even reach the confirm step?
 *
 * ORDER MATTERS and is deliberate:
 *
 *   1. TRUST MODE first. A payload whose trust bytes this build cannot
 *      interpret is refused whatever else is true of it — reporting it as
 *      "expired" would send the person to draw a new code that fails the
 *      same way.
 *   2. EXPIRY next, against an absolute wall-clock deadline the host wrote.
 *   3. REACHABILITY last: a payload whose EVERY address is a `.local` name has
 *      nowhere v1 can dial (#166, #222). One reachable address is enough.
 */
export function validateScannedPayload(
  payload: PairingPayload,
  nowSeconds: number,
): { readonly ok: true } | { readonly ok: false; readonly problem: ScannedPayloadProblem } {
  if (payload.trustMode !== TRUST_SPKI_PIN) return { ok: false, problem: 'unsupported-trust-mode' };
  if (isExpired(payload, nowSeconds)) return { ok: false, problem: 'expired' };
  if (payload.addresses.every((address) => isMulticastDnsName(address))) {
    return { ok: false, problem: 'unreachable' };
  }
  return { ok: true };
}
