// @vitest-environment node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_ATTEMPT_BUDGET,
  DEFAULT_WINDOW_MS,
  createPairingWindows,
  openWindow,
} from '@chatterang/tunnel/pairing';

/**
 * #129 — a pairing secret spendable exactly once.
 *
 * Every test the ticket's Done names is here: double claim, claim after
 * expiry, claim after cancel, two screens open, a failed claim not refunding,
 * and a clock step not extending the window. Each is paired with the same
 * shape succeeding while the window is live, because a state machine that
 * refuses everything passes every refusal test ever written.
 */

const SECRET = Uint8Array.from({ length: 32 }, (_, i) => (i * 7 + 11) & 0xff);
const WRONG = Uint8Array.from(SECRET, (b, i) => (i === 17 ? b ^ 1 : b));
const T0 = 1_000_000;

const open = (over: Partial<Parameters<typeof openWindow>[0]> = {}) =>
  openWindow({ secret: SECRET, now: T0, ...over });

describe('a window is spendable exactly once', () => {
  it('accepts the right secret, once', () => {
    const w = open();
    expect(w.state(T0)).toBe('issued');
    expect(w.claim(SECRET, T0)).toEqual({ ok: true, state: 'claimed' });
    expect(w.state(T0)).toBe('claimed');
  });

  it('refuses a SECOND claim with the same correct secret', () => {
    // The whole ticket in one assertion: a token that works twice is not
    // single-use, and the phone can replay whatever it holds.
    const w = open();
    expect(w.claim(SECRET, T0).ok).toBe(true);
    const again = w.claim(SECRET, T0);
    expect(again.ok).toBe(false);
    expect(again).toMatchObject({ reason: 'not-open', state: 'claimed' });
  });

  it('refuses the wrong secret and keeps the window open while budget remains', () => {
    const w = open();
    const bad = w.claim(WRONG, T0);
    expect(bad).toMatchObject({ ok: false, reason: 'mismatch', state: 'issued' });
    // The control: a wrong guess does not close a window that still has budget.
    expect(w.claim(SECRET, T0).ok).toBe(true);
  });
});

describe('a failed claim is not refunded', () => {
  it('spends budget on arrival, not on success', () => {
    /*
     * The ordering the ticket calls out: "the token is marked spent when a
     * claim arrives, not when the claim succeeds — otherwise a failed claim
     * leaves the token live for the next attempt, and an attacker who can make
     * a claim fail gets unlimited tries." Making a claim fail is not exotic;
     * it is sending the wrong bytes.
     */
    const w = open({ attemptBudget: 3 });
    expect(w.remaining()).toBe(3);
    w.claim(WRONG, T0);
    expect(w.remaining()).toBe(2);
    w.claim(WRONG, T0);
    expect(w.remaining()).toBe(1);
  });

  it('closes the window when the budget runs out, and stays closed', () => {
    const w = open({ attemptBudget: 2 });
    expect(w.claim(WRONG, T0)).toMatchObject({ ok: false, reason: 'mismatch' });
    const last = w.claim(WRONG, T0);
    expect(last).toMatchObject({ reason: 'exhausted', state: 'cancelled', remaining: 0 });

    // And the CORRECT secret no longer works — the window is gone, not merely
    // out of guesses for this attacker.
    expect(w.claim(SECRET, T0)).toMatchObject({ ok: false, reason: 'not-open' });
  });

  it('uses #130’s budget by default, and lets the QR route ask for one', () => {
    // Two routes, one mechanism. 32 random bytes needs no guess budget; six
    // digits does, and #130 set it at five.
    expect(DEFAULT_ATTEMPT_BUDGET).toBe(5);
    const qr = open({ attemptBudget: 1 });
    expect(qr.claim(WRONG, T0)).toMatchObject({ ok: false, reason: 'exhausted' });
    expect(qr.state(T0)).toBe('cancelled');
  });
});

describe('expiry is evaluated against the clock it was given', () => {
  it('refuses a claim after the window closes', () => {
    const w = open({ windowMs: 60_000 });
    expect(w.claim(SECRET, T0 + 59_999).ok).toBe(true);

    const fresh = open({ windowMs: 60_000 });
    expect(fresh.claim(SECRET, T0 + 60_000)).toMatchObject({ ok: false, reason: 'expired' });
    expect(fresh.state(T0 + 60_000)).toBe('expired');
  });

  it('a clock STEPPING BACKWARDS does not extend the window', () => {
    /*
     * The reason the clock is injected and must be monotonic. `Date.now()`
     * steps when NTP corrects, when the timezone changes, and when a laptop
     * wakes. If expiry were computed from a wall clock, stepping it backwards
     * would reopen a window that had closed — available to anyone with local
     * access, and arrived at by accident on a machine that sleeps.
     *
     * The module cannot stop a caller passing a bad clock. What it CAN do is
     * be terminal: once `expired` has been observed it does not un-expire, so
     * a backwards step after the fact buys nothing.
     */
    const w = open({ windowMs: 60_000 });
    expect(w.state(T0 + 60_001)).toBe('expired');
    expect(w.state(T0 + 1_000)).toBe('expired');
    // 'expired' rather than 'not-open': the latch preserves WHY it closed,
    // which is what a caller needs to tell the user to draw a fresh code.
    expect(w.claim(SECRET, T0 + 1_000)).toMatchObject({ ok: false, reason: 'expired' });
  });

  it('defaults to 120s, which is a usability number under #130', () => {
    // Under CPace the bound is attempts, not seconds, so the window length
    // stopped being a security parameter. See the module header.
    expect(DEFAULT_WINDOW_MS).toBe(120_000);
    expect(open().expiresAt).toBe(T0 + 120_000);
  });
});

describe('cancellation is terminal, and nothing re-enters issued', () => {
  it('refuses a claim after cancel', () => {
    const w = open();
    w.cancel();
    expect(w.state(T0)).toBe('cancelled');
    expect(w.claim(SECRET, T0)).toMatchObject({ ok: false, reason: 'not-open' });
  });

  it('cancel after a successful claim does not rewrite it as a cancellation', () => {
    // A claimed window is a thing that HAPPENED. Overwriting the record with
    // 'cancelled' on a late screen-close would lose that.
    const w = open();
    w.claim(SECRET, T0);
    w.cancel();
    expect(w.state(T0)).toBe('claimed');
  });

  it('cancel is idempotent', () => {
    const w = open();
    w.cancel(); w.cancel();
    expect(w.state(T0)).toBe('cancelled');
    expect(w.remaining()).toBe(0);
  });
});

describe('exactly one window is outstanding', () => {
  it('issuing a second code kills the first', () => {
    /*
     * "Opening the pairing screen twice must not leave two live tokens;
     * drawing a new code kills the old one." Two live secrets is two chances
     * for an attacker and one screen the user is not looking at.
     */
    const windows = createPairingWindows();
    const first = windows.issue({ secret: SECRET, now: T0 });
    const second = windows.issue({ secret: WRONG, now: T0 });

    expect(first.state(T0)).toBe('cancelled');
    expect(first.claim(SECRET, T0)).toMatchObject({ ok: false, reason: 'not-open' });
    // The control: the new one works.
    expect(second.claim(WRONG, T0).ok).toBe(true);
    expect(windows.current()).toBe(second);
  });

  it('cancelling the holder closes what is open and forgets it', () => {
    const windows = createPairingWindows();
    const w = windows.issue({ secret: SECRET, now: T0 });
    windows.cancel();
    expect(w.state(T0)).toBe('cancelled');
    expect(windows.current()).toBeNull();
  });

  it('has nothing outstanding before anything is issued', () => {
    expect(createPairingWindows().current()).toBeNull();
  });
});

describe('the comparison', () => {
  it('refuses a presentation of the wrong length without matching a prefix', () => {
    // A truncated presentation must not match, and neither must a padded one.
    const w1 = open();
    expect(w1.claim(SECRET.slice(0, 16), T0).ok).toBe(false);
    const w2 = open();
    expect(w2.claim(new Uint8Array([...SECRET, 0]), T0).ok).toBe(false);
    const w3 = open();
    expect(w3.claim(new Uint8Array(0), T0).ok).toBe(false);
    // The control, so the above is not "refuses everything".
    expect(open().claim(SECRET, T0).ok).toBe(true);
  });

  it('does not accidentally match a short presentation against zero bytes', () => {
    /*
     * This passes on BOTH fills — measured — because the length fold already
     * refuses it. The assertion is kept for the case where the length fold is
     * ever removed, and `window.ts` labels the fill as defence in depth rather
     * than as a guard a test covers. Recorded here so the next reader does not
     * conclude from a green run that the fill is load-bearing.
     */
    const zeros = new Uint8Array(32); // every byte is 0
    const w = openWindow({ secret: zeros, now: T0 });
    expect(w.claim(new Uint8Array(0), T0).ok).toBe(false);
    expect(openWindow({ secret: zeros, now: T0 }).claim(zeros, T0).ok).toBe(true);
  });

  it('compares in a fixed number of iterations, set by the secret', () => {
    /*
     * `apps/server/src/token.ts` hashes both sides first because
     * timingSafeEqual throws on a length mismatch and a length pre-check leaks
     * through the early return. Hashing needs a hash, and this half imports
     * nothing — so the loop is fixed-length over the SECRET and the length
     * difference is folded into the accumulator instead.
     *
     * Read from source, and honest about what that proves: that nobody
     * rewrote it to short-circuit, not that it is constant-time in the engine.
     */
    const source = readFileSync(resolve(process.cwd(), 'packages/tunnel/src/pairing/window.ts'), 'utf8');
    const fn = source.slice(source.indexOf('function equalCt'));
    const body = fn.slice(0, fn.indexOf('\n}'));
    expect(body).toContain('diff |=');
    expect(body).toContain('secret.length ^ presented.length');
    expect(body, 'equalCt returns early inside the loop').not.toMatch(/for\s*\([^)]*\)\s*\{[^}]*return/);
  });
});
