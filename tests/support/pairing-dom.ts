/**
 * Rendering and driving the pairing sheet in jsdom (#128, #130).
 *
 * The repo has no Testing Library, so this is the small part of it the pairing
 * tests need: render with `react-dom` under `act`, find controls the way a
 * person or a screen reader does — by label, by role and accessible name — and
 * type and click through the same events React listens for. Shared, because
 * the privacy suite measures the request the sheet builds with the same
 * driver the sheet's own tests use, and two drivers would drift.
 */

import { act, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';

export interface Mounted {
  readonly host: HTMLElement;
  unmount(): Promise<void>;
}

export async function render(element: ReactElement): Promise<Mounted> {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(element);
  });
  let gone = false;
  return {
    host,
    async unmount() {
      if (gone) return;
      gone = true;
      await act(async () => {
        root.unmount();
      });
      host.remove();
    },
  };
}

/** Text as a reader sees it, whitespace collapsed. */
export function reads(node: Element | null): string {
  return (node?.textContent ?? '').replace(/\s+/g, ' ').trim();
}

/** The open dialog, or null. */
export function dialog(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[role="dialog"]');
}

/** The input a `<label for>` with exactly this text names. */
export function byLabel(text: string): HTMLInputElement {
  const label = [...document.querySelectorAll('label[for]')].find((node) => reads(node) === text);
  if (!label) throw new Error(`no label reads "${text}"`);
  const input = document.getElementById(label.getAttribute('for') ?? '');
  if (!(input instanceof HTMLInputElement)) throw new Error(`label "${text}" names no input`);
  return input;
}

/** A button by its accessible name: `aria-label`, else its text. Null when absent. */
export function button(name: string): HTMLButtonElement | null {
  return (
    [...document.querySelectorAll('button')].find(
      (node) => (node.getAttribute('aria-label') ?? reads(node)) === name,
    ) ?? null
  );
}

export function mustButton(name: string): HTMLButtonElement {
  const found = button(name);
  if (!found) throw new Error(`no button named "${name}"`);
  return found;
}

/** The error an input's `aria-describedby` points at, or null. */
export function errorFor(input: HTMLInputElement): string | null {
  const ids = (input.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean);
  const error = ids.map((id) => document.getElementById(id)).find((node) => node?.classList.contains('field__error'));
  return error ? reads(error) : null;
}

/** Type into a controlled input the way a keyboard does: the native setter, then `input`. */
export async function typeInto(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

export async function click(target: HTMLElement): Promise<void> {
  await act(async () => {
    target.click();
  });
}

/** Let pending promises settle inside `act`, so state set after an `await` is rendered. */
export async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}
