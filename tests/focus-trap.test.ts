/**
 * The Sheet's focus trap.
 *
 * THE DEFECT. `aria-modal="true"` is a promise that Tab cannot leave the
 * dialog, and the trap collected its candidates with
 *
 *   'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
 *
 * with no `:not(:disabled)`. A disabled control matches `button` and comes
 * back from `querySelectorAll`, but `focus()` on it does NOTHING — so when the
 * panel's LAST focusable was disabled, `last` was an element that could never
 * be `document.activeElement`, the "are we at the end?" comparison never
 * became true, and Tab walked straight out of the dialog into the page behind
 * it. The same bug sat one move earlier in the opening `focus()`, which used a
 * shorter list with the same omission.
 *
 * It is not hypothetical. `ChatSettingsSheet` disables its export button while
 * an export is running and that button is the last control in the panel; so
 * does every `Confirm` whose action is temporarily unavailable.
 *
 * Driven against real jsdom elements rather than a mocked NodeList, because
 * the whole bug lives in what `querySelectorAll` and `focus()` do with
 * `:disabled` — the two things a mock would have got right.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { containTab, focusableWithin } from '@/ui/primitives';

/** Build a dialog panel from a terse description of its controls. */
function panelWith(html: string): HTMLElement {
  const panel = document.createElement('div');
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'true');
  panel.innerHTML = html;
  document.body.append(panel);
  return panel;
}

/** A Tab keydown, recording whether the default was prevented. */
function tab(shiftKey = false): { key: string; shiftKey: boolean; preventDefault: () => void; prevented: boolean } {
  const event = {
    key: 'Tab',
    shiftKey,
    prevented: false,
    preventDefault(): void {
      event.prevented = true;
    },
  };
  return event;
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('what Tab is allowed to land on', () => {
  it('skips a disabled control of every kind that can be disabled', () => {
    const panel = panelWith(`
      <button id="a">ok</button>
      <input id="b" />
      <button id="c" disabled>busy</button>
      <input id="d" disabled />
      <select id="e" disabled></select>
      <textarea id="f" disabled></textarea>
    `);
    expect(focusableWithin(panel).map((el) => el.id)).toEqual(['a', 'b']);
  });

  it('skips a control that is hidden rather than disabled', () => {
    const panel = panelWith(`
      <button id="a">ok</button>
      <button id="b" hidden>gone</button>
      <button id="c" aria-hidden="true">gone</button>
    `);
    expect(focusableWithin(panel).map((el) => el.id)).toEqual(['a']);
  });

  it('skips an element taken out of the tab order', () => {
    const panel = panelWith(`
      <button id="a">ok</button>
      <div id="b" tabindex="-1">not tabbable</div>
      <div id="c" tabindex="0">tabbable</div>
    `);
    expect(focusableWithin(panel).map((el) => el.id)).toEqual(['a', 'c']);
  });

  it('returns the list a disabled candidate would have made unfocusable', () => {
    // The property the whole fix rests on, asserted directly: every element
    // the trap will try to focus CAN take focus. A disabled one cannot, and
    // that is what made the trap leak rather than throw.
    const panel = panelWith(`<button id="a">ok</button><button id="b" disabled>busy</button>`);
    for (const element of focusableWithin(panel)) {
      element.focus();
      expect(document.activeElement, `${element.id} could not take focus`).toBe(element);
    }
    // And the proof of the mechanism, so the assertion above is not a
    // coincidence of jsdom: focusing the disabled button does nothing at all.
    const disabled = panel.querySelector<HTMLElement>('#b')!;
    disabled.focus();
    expect(document.activeElement).not.toBe(disabled);
  });
});

describe('Tab cannot leave an aria-modal dialog', () => {
  it('wraps from the last control to the first', () => {
    const panel = panelWith(`<button id="a">a</button><button id="b">b</button>`);
    const last = panel.querySelector<HTMLElement>('#b')!;
    last.focus();

    const event = tab();
    expect(containTab(panel, event, document.activeElement)?.id).toBe('a');
    expect(event.prevented).toBe(true);
    expect(document.activeElement).toBe(panel.querySelector('#a'));
  });

  it('wraps backwards from the first control to the last', () => {
    const panel = panelWith(`<button id="a">a</button><button id="b">b</button>`);
    panel.querySelector<HTMLElement>('#a')!.focus();

    const event = tab(true);
    expect(containTab(panel, event, document.activeElement)?.id).toBe('b');
    expect(event.prevented).toBe(true);
  });

  it('WRAPS EVEN WHEN THE LAST CONTROL IS DISABLED', () => {
    /*
     * THE DEFECT, AS ONE ASSERTION.
     *
     * Before the fix `last` was `#gone`, which cannot hold focus. Focus sat on
     * `#b`, `active === last` was false, nothing was prevented, and the
     * browser's own Tab took the user out of the dialog and into the page
     * behind it — which the dialog had just told a screen reader was inert.
     */
    const panel = panelWith(`
      <button id="a">a</button>
      <button id="b">b</button>
      <button id="gone" disabled>Export</button>
    `);
    const realLast = panel.querySelector<HTMLElement>('#b')!;
    realLast.focus();
    expect(document.activeElement).toBe(realLast);

    const event = tab();
    expect(containTab(panel, event, document.activeElement)?.id).toBe('a');
    expect(event.prevented, 'Tab escaped the dialog').toBe(true);
    expect(document.activeElement).toBe(panel.querySelector('#a'));
  });

  it('wraps backwards even when the last control is disabled', () => {
    const panel = panelWith(`
      <button id="a">a</button>
      <button id="b">b</button>
      <button id="gone" disabled>Export</button>
    `);
    panel.querySelector<HTMLElement>('#a')!.focus();

    const event = tab(true);
    // Backwards from the first must reach the last FOCUSABLE, not the last
    // element — landing on a disabled button would leave focus on the body.
    expect(containTab(panel, event, document.activeElement)?.id).toBe('b');
    expect(document.activeElement).toBe(panel.querySelector('#b'));
  });

  it('leaves Tab alone in the middle of the dialog', () => {
    const panel = panelWith(`
      <button id="a">a</button><button id="b">b</button><button id="c">c</button>
    `);
    panel.querySelector<HTMLElement>('#b')!.focus();
    const event = tab();
    expect(containTab(panel, event, document.activeElement)).toBeNull();
    expect(event.prevented).toBe(false);
  });

  it('ignores every key that is not Tab', () => {
    const panel = panelWith(`<button id="a">a</button>`);
    for (const key of ['Escape', 'Enter', 'ArrowDown', 'a']) {
      const event = { key, shiftKey: false, prevented: false, preventDefault(): void {} };
      expect(containTab(panel, event, document.activeElement)).toBeNull();
    }
  });

  it('does nothing in a dialog with nothing focusable in it', () => {
    // Not a crash and not a wrap: there is nowhere to put focus, and the
    // sensible answer is to leave the browser to it.
    const panel = panelWith(`<p>Just a message.</p><button disabled>ok</button>`);
    const event = tab();
    expect(containTab(panel, event, document.activeElement)).toBeNull();
    expect(event.prevented).toBe(false);
  });

  it('opens on a control that can actually hold focus', () => {
    // The same omission one move earlier: the opening focus used
    // `'button, input, textarea'`, so a dialog whose FIRST control is disabled
    // opened with focus nowhere and the first Tab started from the page.
    const panel = panelWith(`
      <button id="gone" disabled>busy</button>
      <button id="a">a</button>
    `);
    const first = focusableWithin(panel)[0];
    expect(first?.id).toBe('a');
    first?.focus();
    expect(document.activeElement).toBe(first);
  });
});
