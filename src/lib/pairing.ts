/**
 * THE PAIRING SEAM: what either route hands off, and who takes it (#128, #130).
 *
 * The phone has two ways to begin pairing — scan a code the other machine draws,
 * or type a host and six digits — and both end in ONE request to a controller.
 * The controller is what connects, runs CPace and binds the channel, and it
 * cannot be written yet. Its binding step is here now:
 * `openBoundPairingConnection` takes the certificate fingerprint #181's native
 * socket plugin negotiated and puts it into CPace's `CI` (#256). The CPace
 * message exchange that would use that `CI` is not defined, and no platform
 * plugin exists, so nothing on this build calls it. A browser `WebSocket`
 * cannot report a peer certificate at all.
 *
 * So this file ships the SHAPE and an honest refusal, modelled on how
 * `MountHostWeb` refuses rather than pretends. `pairingController()` returns a
 * controller whose `available` is false. The one entry point,
 * `src/features/pairing/PairingEntry.tsx`, renders nothing while it is, so no
 * screen offers pairing. `tests/layering.test.ts` refuses any file in `src/`
 * outside this one, `qr-scan.ts`, `qr-decode.ts` and `src/features/pairing/`
 * that imports the pairing half or the scanner, or names `getUserMedia`; it
 * lets only `SettingsScreen.tsx` import that feature, and only through
 * `PairingEntry`. That is a rule about names: a camera reached another way,
 * such as a file input with `capture`, is not something it sees.
 *
 * The day `available` becomes true, `tests/privacy-copy.test.ts` fails until
 * every privacy surface's copy names a paired device, a paired-device panel is
 * mounted, and a table holds the devices. That forces the copy to be revisited
 * in the same change. It does not choose the sentence.
 *
 * LOADING IT loads only the pairing half, which imports nothing, so it is safe
 * on every target — including the oldest phone #223 worries about. The binding
 * half brings CPace and noble with it, so it arrives by dynamic `import()` when
 * a connection is bound and never when this file loads. The socket contract and
 * the binding's route are type imports, which are erased.
 * `tests/pairing-seam.test.ts` holds the file to that.
 */

import type {
  TunnelCloseEvent,
  TunnelConnectOptions,
  TunnelSocketPlugin,
} from '@chatterang/contracts/tunnel-socket';
import type { PairingRoute } from '@chatterang/tunnel/binding';
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
  /**
   * Run one pairing to its outcome.
   *
   * ABORT IS A REQUEST, NOT A ROLLBACK (D9, #124). Aborting `signal` asks the
   * controller to stop; it does not promise nothing happened. An exchange the
   * host already committed may have paired, so the promise still settles with
   * what DID happen, and a caller that aborted keeps awaiting it. The sheet
   * surfaces a late `paired` rather than dropping it: a host holding a pairing
   * the phone never mentioned is the failure that fails open.
   */
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

/* ── Binding a connection to what it negotiated (#256) ─────────────────── */

/**
 * The part of the socket plugin (#181, #295) a pairing connection uses.
 *
 * Handed in, never looked up: nothing in `src/` registers the plugin yet, and a
 * seam that found its own transport could not be driven over a fake.
 */
export type PairingSocket = Pick<TunnelSocketPlugin, 'connect' | 'close' | 'negotiatedPeer' | 'addListener'>;

/** An open pairing connection, and the `CI` its CPace exchange must use. */
export interface BoundPairingConnection {
  /** The handle `connect` returned. Every later call about it names this. */
  readonly connectionId: string;
  /** From the certificate THIS connection negotiated, via `channelIdentifierFor`. */
  readonly ci: Uint8Array;
}

/**
 * The connection ended before it opened, and here is how.
 *
 * Carried whole rather than turned into a {@link PairingRefusal}: a
 * `PEER_MISMATCH` failure, a 4410 close and a host nobody reached are three
 * different sentences, and choosing them is the controller's job, which has the
 * words. The message names the close code only: the reason is the peer's text.
 */
export class PairingConnectionClosedError extends Error {
  override readonly name = 'PairingConnectionClosedError';
  constructor(readonly close: TunnelCloseEvent) {
    super(`pairing connection ended before it opened (close code ${String(close.code)})`);
  }
}

/**
 * Standard padded base64 of exactly 32 bytes, canonically: 43 characters, the
 * last carrying no set unused bit, then one `=`. That is what the contract says
 * the plugin reports, and what `identity.ts` computes for the same key. A value
 * a lenient decoder would still accept (whitespace, no padding, base64url) is a
 * bridge that is not doing what it says, so it is refused rather than repaired.
 */
const SPKI_SHA256_BASE64 = /^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$/;

/** The 32 bytes a plugin reported, decoded once, at the boundary; or null. */
function spkiFromBridge(reported: unknown): Uint8Array | null {
  if (typeof reported !== 'string' || !SPKI_SHA256_BASE64.test(reported)) return null;
  return Uint8Array.from(atob(reported), (char) => char.charCodeAt(0));
}

const toBase64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes));

/**
 * Open a pairing connection and bind it to the certificate it negotiated.
 *
 * In order: subscribe to `tunnelOpen` and `tunnelClose`, `connect`, wait for
 * THAT handle's `tunnelOpen`, ask `negotiatedPeer` for that handle, decode the
 * fingerprint, and hand it to `channelIdentifierFor` with `route`. The plugin
 * is asked for the peer of the connection it just opened, by its handle, and
 * never before it opened: a man in the middle's connection is to the same host.
 *
 * - SCANNED: the code carries the pin, so `connect` passes it as
 *   `expectedPeer` and the plugin refuses another key before writing anything.
 *   The binding checks it again here and throws `pin-mismatch`, so a plugin
 *   that got that wrong still sends nothing on the connection. A trust mode
 *   this build cannot check is refused before anything is dialled.
 * - TYPED: six digits carry no pin, so nothing is expected and the binding is
 *   the whole defence (#256). The typed route is still weaker than the QR route
 *   (#130), and this does not change that sentence.
 *
 * NO CREDENTIAL, in either form: a connection that pairs presents none. Nothing
 * here is kept: not the fingerprint, not the handle, not the `CI`.
 *
 * THROWS, after closing the connection when one was opened:
 * - `BindingError` (`pin-mismatch`, `unsupported-trust-mode`,
 *   `bad-negotiated-spki`), from the binding half;
 * - {@link PairingConnectionClosedError}, when the connection ended before it
 *   opened (nothing is closed: it is already over);
 * - whatever `connect` or `negotiatedPeer` rejected with, unchanged.
 *
 * FRAMES ARE NOT READ HERE, and this subscribes only until it settles. A caller
 * that runs an exchange on the connection subscribes to `tunnelFrame` and
 * `tunnelClose` BEFORE calling this and keeps what it hears by handle, so that
 * a frame or a close arriving before this resolves is not lost.
 */
export async function openBoundPairingConnection(
  socket: PairingSocket,
  url: string,
  route: PairingRoute,
): Promise<BoundPairingConnection> {
  const { BindingError, channelIdentifierFor } = await import('@chatterang/tunnel/binding');
  if (route.kind === 'scanned' && route.payload.trustMode !== TRUST_SPKI_PIN) {
    throw new BindingError('unsupported-trust-mode');
  }

  type Heard = 'open' | TunnelCloseEvent;
  /** Unset until `connect` resolves. Events heard before then wait in `early`. */
  let ours: string | null = null;
  const early: { readonly connectionId: string; readonly heard: Heard }[] = [];
  let opened: () => void = () => undefined;
  let endedFirst: (event: TunnelCloseEvent) => void = () => undefined;
  const opening = new Promise<void>((resolveOpen, rejectOpen) => {
    opened = resolveOpen;
    endedFirst = (event) => rejectOpen(new PairingConnectionClosedError(event));
  });
  // Observed here so a connect that rejects leaves no unhandled rejection behind.
  opening.catch(() => undefined);
  const hear = (connectionId: string, heard: Heard): void => {
    if (ours === null) {
      early.push({ connectionId, heard });
      return;
    }
    if (connectionId !== ours) return;
    if (heard === 'open') opened();
    else endedFirst(heard);
  };

  const subscriptions: { remove(): Promise<void> }[] = [];
  try {
    subscriptions.push(await socket.addListener('tunnelOpen', (event) => hear(event.connectionId, 'open')));
    subscriptions.push(await socket.addListener('tunnelClose', (event) => hear(event.connectionId, event)));

    const options: TunnelConnectOptions =
      route.kind === 'scanned' ? { url, expectedPeer: { spkiSha256: toBase64(route.payload.trust) } } : { url };
    const { connectionId } = await socket.connect(options);
    ours = connectionId;
    for (const event of early.splice(0)) hear(event.connectionId, event.heard);

    try {
      await opening;
      const spki = spkiFromBridge((await socket.negotiatedPeer({ connectionId })).spkiSha256);
      if (spki === null) throw new BindingError('bad-negotiated-spki');
      return { connectionId, ci: channelIdentifierFor(route, { spki }) };
    } catch (error) {
      if (!(error instanceof PairingConnectionClosedError)) {
        await socket.close({ connectionId }).catch(() => undefined);
      }
      throw error;
    }
  } finally {
    await Promise.all(subscriptions.map((subscription) => subscription.remove().catch(() => undefined)));
  }
}
