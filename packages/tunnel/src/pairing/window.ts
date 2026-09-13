/**
 * THE PAIRING WINDOW: one secret, outstanding, spendable and then gone (#129).
 *
 * The plan's clause is "single-use token, 60-120s expiry, invalidated on use",
 * and every word of it is a behaviour with a failure mode. This is the state
 * machine those behaviours live in.
 *
 * ## Single-use is a property of the ISSUER, not of the token
 *
 * The phone cannot enforce it — it holds a string and can send it as often as
 * it likes. So the host keeps the record, and this module is that record.
 *
 * ## It answers the question #130's ruling left open
 *
 * #130 asked whether the single-use token and the PAKE are two mechanisms
 * doing one job. They are one mechanism with two settings, and the difference
 * is entropy rather than kind:
 *
 *   - The QR route's secret is 32 random bytes (#134's payload). Nobody
 *     guesses 256 bits, so the budget is ONE: the first claim spends it.
 *   - The typed route's secret is six digits. A guess is cheap, which is why
 *     #130 put CPace under it — and CPace gives an attacker one guess per
 *     connection, so what is left to bound is connections. The budget is five.
 *
 * Same window, same lifecycle, same "no refund on failure". {@link openWindow}
 * takes the budget; the route picks it.
 *
 * ## Why the window length stopped being a security parameter
 *
 * The ticket asks "60s or 120s?" and that question was posed when a short
 * window was part of what bounded brute force. Under #130 it is not: the bound
 * is attempts, not seconds. So the answer is chosen for usability —
 * {@link DEFAULT_WINDOW_MS} is 120s, because the typed route means reading six
 * digits off one screen and typing them into another, possibly around a camera
 * permission prompt (#128), and 60s is unpleasant for that. Shortening it
 * later costs nothing; a window too short to use produces a user who re-pairs
 * repeatedly, which puts MORE codes on screen rather than fewer.
 *
 * ## The clock is injected, and it must be monotonic
 *
 * `Date.now()` is wall-clock: it steps when NTP corrects, when the user
 * changes the timezone, and when a laptop wakes. A window that is checked
 * against it can be EXTENDED by stepping the clock backwards, which is a thing
 * an attacker with local access has and a thing a sleeping desktop does by
 * accident. `performance.now()` and Node's `monotonicNow` are the right
 * sources; this module takes the number rather than choosing, because the half
 * it lives in reaches for no global.
 */

/** 120 seconds. See the module header for why this is a usability number now. */
export const DEFAULT_WINDOW_MS = 120_000;

/**
 * Five, from #130's ruling: with six digits that is 5 x 10^-6 per window.
 *
 * A DEFAULT, not a policy — the QR route passes 1. The number is here rather
 * than in a comment because #130 says plainly that a counter justified by a
 * formula is a counter the next reader deletes.
 */
export const DEFAULT_ATTEMPT_BUDGET = 5;

export type WindowState =
  /** Live, with budget left and time left. */
  | 'issued'
  /** Spent successfully. Terminal. */
  | 'claimed'
  /** The clock ran out. Terminal. */
  | 'expired'
  /** The screen closed, the user cancelled, or the budget ran out. Terminal. */
  | 'cancelled';

export type ClaimOutcome =
  | { readonly ok: true; readonly state: 'claimed' }
  | { readonly ok: false; readonly reason: ClaimRefusal; readonly state: WindowState; readonly remaining: number };

export type ClaimRefusal =
  /** Wrong secret. The budget has already been decremented. */
  | 'mismatch'
  /** The window was not live when the claim arrived. */
  | 'not-open'
  | 'expired'
  | 'exhausted';

export interface PairingWindow {
  /** What the window is right now, evaluated against `now`. */
  state(now: number): WindowState;
  /**
   * Present a secret.
   *
   * THE BUDGET IS DECREMENTED BEFORE THE SECRET IS COMPARED, and that ordering
   * is the point of this method. Refunding a failed attempt hands an attacker
   * who can make a claim fail an unlimited number of tries — and "make a claim
   * fail" is not exotic, it is sending the wrong bytes.
   */
  claim(presented: Uint8Array, now: number): ClaimOutcome;
  /** Close the window. Idempotent, and terminal — nothing re-enters `issued`. */
  cancel(): void;
  /** Attempts left. Zero means the window is cancelled. */
  remaining(): number;
  /** When the window closes, on the injected clock's scale. */
  readonly expiresAt: number;
}

/**
 * Open a window over one secret.
 *
 * NOTHING PERSISTS THIS. A window that survives a restart is a window nobody
 * is watching: the person who opened the pairing screen is not necessarily at
 * the machine ten minutes later, and the whole consent story is that they are.
 * There is no serialisation here and there should not be one.
 *
 * Exactly one window may be open at a time — that is the CALLER's invariant,
 * and {@link openWindow} cannot enforce it because it does not know about the
 * others. {@link PairingWindows} does enforce it and is what callers should
 * use; this is exported for tests and for a host that genuinely has one.
 */
export function openWindow(options: {
  readonly secret: Uint8Array;
  readonly now: number;
  readonly windowMs?: number;
  readonly attemptBudget?: number;
}): PairingWindow {
  const secret = options.secret;
  const expiresAt = options.now + (options.windowMs ?? DEFAULT_WINDOW_MS);
  let left = options.attemptBudget ?? DEFAULT_ATTEMPT_BUDGET;
  let terminal: WindowState | null = null;

  const evaluate = (now: number): WindowState => {
    if (terminal !== null) return terminal;
    // Expiry is evaluated, never scheduled. A timer is a thing that does not
    // fire on a sleeping machine, and the window has to be closed when it is
    // ASKED ABOUT, not when a callback happens to run.
    //
    // AND IT LATCHES. Returning `expired` without recording it left the window
    // able to un-expire: step the clock back below `expiresAt` and the next
    // call said `issued` again. The comment above this function claimed
    // terminality and the code did not have it — caught by the clock-step test
    // in `tests/tunnel-pairing-window.test.ts`, which is the one test written
    // specifically because a wall clock can move backwards.
    //
    // A caller passing a bad clock cannot be stopped from here. What CAN be
    // guaranteed is that a window observed closed stays closed, so a backwards
    // step after the fact buys nothing.
    if (now >= expiresAt) {
      terminal = 'expired';
      return 'expired';
    }
    return 'issued';
  };

  return {
    expiresAt,
    remaining: () => (terminal === null ? left : 0),
    state: evaluate,
    cancel() {
      // Only from a live state. `cancel()` after `claimed` must not rewrite
      // history into a cancellation that never happened.
      if (terminal === null) terminal = 'cancelled';
    },
    claim(presented, now) {
      const before = evaluate(now);
      if (before !== 'issued') {
        return { ok: false, reason: before === 'expired' ? 'expired' : 'not-open', state: before, remaining: 0 };
      }

      // DECREMENT FIRST. See the interface comment: the attempt is spent by
      // arriving, not by succeeding.
      left -= 1;

      const matched = equalCt(secret, presented);
      if (matched) {
        terminal = 'claimed';
        return { ok: true, state: 'claimed' };
      }

      if (left <= 0) {
        terminal = 'cancelled';
        return { ok: false, reason: 'exhausted', state: 'cancelled', remaining: 0 };
      }
      return { ok: false, reason: 'mismatch', state: 'issued', remaining: left };
    },
  };
}

/**
 * The holder that enforces "exactly one outstanding".
 *
 * Opening the pairing screen twice must not leave two live secrets. The ticket
 * names it: drawing a new code kills the old one. That is a property of the
 * COLLECTION rather than of any window, which is why it is a separate type
 * instead of a static in the one above.
 */
export interface PairingWindows {
  /** Open a window, cancelling whatever was outstanding. */
  issue(options: Parameters<typeof openWindow>[0]): PairingWindow;
  /** The outstanding window, or null. */
  current(): PairingWindow | null;
  /** Close whatever is open. Called when the screen closes and at shutdown. */
  cancel(): void;
}

export function createPairingWindows(): PairingWindows {
  let open: PairingWindow | null = null;
  return {
    issue(options) {
      // Cancel BEFORE replacing, so the old secret is dead even if creating
      // the new one throws. A window left live by an error is the one nobody
      // is watching.
      open?.cancel();
      open = openWindow(options);
      return open;
    },
    current: () => open,
    cancel() {
      open?.cancel();
      open = null;
    },
  };
}

/**
 * Constant-time comparison, with the length folded in rather than checked.
 *
 * `apps/server/src/token.ts:75-81` hashes both sides first, because
 * `timingSafeEqual` THROWS on length-mismatched buffers and the obvious guard
 * — compare lengths, then bytes — leaks the length through an early return.
 * That file's secret is a user-supplied string of unknown length.
 *
 * The same rule reached differently here, and the difference is deliberate:
 * hashing needs a hash, and this half reaches for no global and imports
 * nothing. So the loop runs a FIXED number of iterations set by the stored
 * secret, and the length difference is folded into the accumulator instead of
 * short-circuiting. Same property, no dependency.
 */
function equalCt(secret: Uint8Array, presented: Uint8Array): boolean {
  let diff = secret.length ^ presented.length;
  for (let i = 0; i < secret.length; i += 1) {
    /*
     * `?? ~secret[i]!` rather than `?? 0` is DEFENCE IN DEPTH, NOT A REACHABLE
     * GUARD, and labelled so nobody defends it as one. The length is already
     * folded into `diff` on the line above, so a short presentation can never
     * compare equal whatever fills the missing bytes — measured: swapping this
     * for `?? 0` leaves the suite green, while removing the length fold fails
     * two tests.
     *
     * It stays because the two lines protect each other. If someone later
     * decides the length fold is redundant (it looks it, right up until you
     * delete it), this is what stops a secret full of zero bytes matching an
     * empty presentation.
     */
    diff |= secret[i]! ^ (presented[i] ?? ~secret[i]!);
  }
  return diff === 0;
}
