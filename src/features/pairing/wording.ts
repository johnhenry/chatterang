/**
 * Every sentence the pairing sheet can show, keyed by what it is about (#128, #130).
 *
 * RECORDS, NOT SWITCHES WITH A DEFAULT. A reason added to `TypedEntryReason` or
 * `PairingRefusal` fails typecheck here until it has words of its own. A
 * fallback string would let a new refusal reach the person as a sentence
 * written about a different one, which is how "the code expired" ends up on a
 * certificate that did not match.
 *
 * None of these sentences says what a pairing SENDS, or where. That sentence
 * waits for a controller that can be measured against, because nothing on this
 * build can pair.
 */

import type { TypedEntryReason } from '@chatterang/tunnel/pairing';
import type { PairingRefusal, ScannedPayloadProblem } from '@/lib/pairing';
import type { ScanStopReason } from '@/lib/qr-scan';

/* ── Scanning ──────────────────────────────────────────────────────────── */

/** Before the camera is asked for. */
export const SCAN_INTRO = 'Point the camera at the pairing code on the other screen.';

/** While the camera is on. */
export const SCAN_LOOKING = 'Looking for a pairing code…';

/** A QR code was read, and it is not a pairing code. Scanning goes on. */
export const NOT_A_PAIRING_CODE = 'That QR code is not a pairing code. Point the camera at the one on the other screen.';

/**
 * The camera cannot be used here, and the sheet has moved to Type.
 *
 * ONE SENTENCE for unsupported, refused, absent and failed, and none of them
 * says "you denied". The phone cannot always tell them apart — Android refuses
 * without prompting when the manifest lacks the permission — and declining a
 * camera is a choice this app is for, not a mistake to report.
 */
export const CAMERA_UNAVAILABLE = 'The camera is not available here. You can type the code instead.';

/** Something else holds the camera. The pane offers "Try again". */
export const CAMERA_BUSY = 'The camera is in use by something else right now.';

/**
 * Why a scan stopped without a code, each followed by "Scan again".
 *
 * `result` and `cancelled` have no sentence: a result goes on to Confirm, and
 * a cancel is the person closing the sheet. `hidden` is the pane's own cause,
 * recorded because `handle.stop()` reports every stop it asks for as
 * `cancelled`.
 */
export const SCAN_END_WORDING: Readonly<Record<Exclude<ScanStopReason, 'result' | 'cancelled'> | 'hidden', string>> =
  Object.freeze({
    'track-ended': 'The camera stopped. Another app or a call may have taken it.',
    'decode-failed': 'The code reader could not run, so scanning stopped.',
    'invalid-code': 'That pairing code could not be read. Show a new one and scan again.',
    'idle-timeout': 'No code was found in time, and any code shown when scanning began has expired.',
    hidden: 'Scanning stopped when Chatterang went to the background.',
  });

/** A pairing code that was read and refused before any confirm step. */
export const SCANNED_PROBLEM_WORDING: Readonly<Record<ScannedPayloadProblem, string>> = Object.freeze({
  'unsupported-trust-mode': 'That code asks this phone to check the other machine in a way this version cannot.',
  expired: 'That code has expired. Show a new one and scan again.',
  unreachable: 'That code names only .local addresses, which this phone cannot reach yet.',
});

/* ── Confirm (D11) ─────────────────────────────────────────────────────── */

export const CONFIRM_TITLE = 'Pair with this computer?';
export const CONFIRM_BODY = 'Pair only if this code came from the screen in front of you.';

/**
 * The name, attributed to the code rather than asserted about the machine.
 *
 * Whoever composed the code wrote it, and a code on a shared screen or a
 * photograph can call itself "John’s MacBook" as easily as John's can.
 */
export function confirmDetail(name: string): readonly string[] {
  return [`It calls itself “${name}”.`, 'That name comes from the code, so whoever made the code chose it.'];
}

/* ── Typing ────────────────────────────────────────────────────────────── */

/** What is wrong with the typed address or code, in the person's terms. */
export const TYPED_ENTRY_WORDING: Readonly<Record<TypedEntryReason, string>> = Object.freeze({
  empty: 'Type the address of the computer you are pairing with.',
  'bad-ipv4': 'That is not an IPv4 address: four numbers from 0 to 255, separated by dots, with no leading zeros.',
  'bad-ipv6': 'That is not an IPv6 address. To add a port, put the address in brackets, like [fe80::1]:8973.',
  'bad-dns-name': 'That is not a host name. A name uses only letters, digits, hyphens and dots.',
  'bad-port': 'The port after the colon has to be a number from 1 to 65535, written without a leading zero.',
  'local-name-unreachable':
    'A name ending in .local cannot be reached from this phone yet. Type the computer’s IP address instead.',
  'zone-index-unsupported': 'Leave out the % and what follows it. This address cannot carry an interface name.',
  'bad-code': 'The code is six digits. Spaces and hyphens are fine; other characters are not.',
});

/**
 * Asked for when the person submits without saying what they are pairing with.
 *
 * There is no default to fall back on: `PairingRequest.hostKind` has to come
 * from the person, because taking it from whatever answers would let that
 * machine choose it.
 */
export const HOST_KIND_PROMPT = 'Choose whether this is the Chatterang desktop app or a Chatterang server.';

/**
 * Why a pairing the controller attempted did not complete.
 *
 * Each says what the controller reported and no more. `confirmation-failed`
 * names both of its causes, because the phone cannot tell a mistyped code from
 * a machine that is not the one showing it, and blaming the typing would be
 * the reassuring half. `transport-unavailable` is the build, never the person.
 */
export const REFUSAL_WORDING: Readonly<Record<PairingRefusal, string>> = Object.freeze({
  'pin-mismatch': 'The machine that answered did not present the certificate this code named.',
  'confirmation-failed':
    'The code was not accepted. It was mistyped, or whatever answered is not the machine showing it.',
  expired: 'That code has expired. Show a new one and try again.',
  unreachable: 'Nothing answered at that address.',
  exhausted: 'Too many attempts have used this code up. Show a new one and try again.',
  'unsupported-trust-mode': 'That code asks this phone to check the other machine in a way this version cannot.',
  'transport-unavailable': 'This version of Chatterang cannot complete a pairing yet. Nothing you entered caused this.',
});

/**
 * A pair() that threw, or answered with something that is not an outcome.
 *
 * It does not say "nothing was paired": an exchange that failed after the host
 * committed may have left a pairing there, and this phone cannot know.
 */
export const GENERIC_REFUSAL = 'Pairing did not finish, and no reason was given.';

/**
 * Characters that can make a name read as something other than what it is.
 *
 * C0 and C1 controls (including DEL), which can move or erase what is drawn
 * around them, and the bidirectional embeddings, overrides and isolates
 * (U+202A–U+202E, U+2066–U+2069), which reorder it: `\u202ekoobcam` renders as
 * "macbook". The pairing parser checks only that a name is well-formed UTF-8
 * of the right length, so a host — or whoever composed the code — can put any
 * of these in it.
 */
const DISGUISING = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u;

/** Does a host-written name contain a character that can disguise it? */
export function hasDisguisingCharacter(name: string): boolean {
  return DISGUISING.test(name);
}

/**
 * What the toast says when a pairing completed.
 *
 * The name is the host's, so it is quoted as a name the machine gave rather
 * than stated as a fact about it. A name that could disguise itself is not
 * shown at all — the pairing still happened and is still reported, because a
 * completed pairing the phone stays silent about is the worse failure.
 *
 * Each withheld case gives the reason that is true of it. A blank name hides
 * nothing, so it is not accused of hiding something; a name that is blank but
 * holds a control character, such as a tab, gets the sentence about controls.
 */
export function pairedMessage(deviceName: string): string {
  if (hasDisguisingCharacter(deviceName)) {
    return 'Paired. The other machine’s name is not shown, because it contains characters that can disguise text.';
  }
  if (deviceName.trim().length === 0) return 'Paired. The other machine gave no name.';
  return `Paired with “${deviceName}”.`;
}
