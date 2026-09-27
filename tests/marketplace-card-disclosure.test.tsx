/**
 * THE CARD'S OWN BUY BUTTON, NOT JUST "PREVIEW" (adversarial review, HIGH,
 * refs #23, #122).
 *
 * `ListingSheet`'s disclosure (`tests/marketplace-disclosure.test.tsx`) is
 * only ever seen by someone who taps "Preview". The card's OTHER button —
 * price or "Free" — called `acquire()` directly, the exact same one tap
 * whether or not the listing had a provider/tool-policy preference to
 * disclose. The README promises "full instructions visible before
 * purchase"; a second, faster route to the same purchase that skips them is
 * exactly what that promise forbids.
 *
 * Driven against the real `Marketplace` component this time (not
 * `ListingSheet` directly), because the bug was specifically in which
 * BUTTON reached `acquire()` — a test of `ListingSheet` alone cannot see a
 * card-level button that bypasses it.
 */

import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const tables = vi.hoisted(() => ({
  personas: { put: vi.fn(async () => {}), delete: vi.fn(async () => {}), toArray: async () => [] },
  entitlements: { put: vi.fn(async () => {}), toArray: async () => [] },
}));

vi.mock('@/db', () => ({
  db: tables,
  readSetting: async (_key: string, fallback: unknown) => fallback,
  writeSetting: vi.fn(async () => {}),
}));

vi.mock('@/lib/billing', () => ({
  billingAvailable: async () => false,
  getProducts: async () => [],
  purchase: async () => {
    throw new Error('not reached in this test');
  },
  restorePurchases: async () => [],
}));

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { usePersonas } = await import('@/state/personas');
const { Marketplace } = await import('@/features/personas/Marketplace');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement | null = null;
let root: import('react-dom/client').Root | null = null;

async function render(tree: ReturnType<typeof createElement>): Promise<void> {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(tree);
  });
  // Lets the store's `billingAvailable()` effect settle before assertions.
  await act(async () => {
    await Promise.resolve();
  });
}

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  vi.restoreAllMocks();
});

beforeEach(() => {
  usePersonas.setState({ byId: {}, entitlements: {}, purchasing: null, loaded: true } as never);
});

describe('the marketplace card’s buy button', () => {
  it('opens the disclosure sheet instead of calling acquire() directly', async () => {
    const acquireSpy = vi.spyOn(usePersonas.getState(), 'acquire');

    await render(createElement(Marketplace));

    // "The Tutor" is free ($0), so its card button reads "Free" rather than
    // a price — either way, it is the card's SECOND button (after Preview).
    const cards = Array.from(document.querySelectorAll('.card'));
    expect(cards.length).toBeGreaterThan(0);

    const firstCard = cards[0]!;
    const [previewButton, buyButton] = Array.from(firstCard.querySelectorAll<HTMLButtonElement>('button'));
    expect(previewButton?.textContent).toContain('Preview');
    expect(buyButton).toBeDefined();

    // Nothing acquired yet, and no sheet open yet.
    expect(acquireSpy).not.toHaveBeenCalled();
    expect(document.querySelector('.sheet')).toBeNull();

    await act(async () => {
      buyButton?.click();
    });

    // The disclosure sheet is now open — and acquire() STILL was not called.
    expect(document.querySelector('.sheet')).not.toBeNull();
    expect(document.body.textContent).toContain('nothing is hidden from you before you buy');
    expect(acquireSpy).not.toHaveBeenCalled();

    // Only from the SHEET's own footer button does acquire() ever run.
    const sheetButton = document.querySelector<HTMLButtonElement>('.sheet .btn--primary');
    expect(sheetButton).not.toBeNull();
    await act(async () => {
      sheetButton?.click();
    });
    expect(acquireSpy).toHaveBeenCalledTimes(1);
  });

  it('(paired) "Preview" already opened the same sheet — the fix makes the other button match it, not diverge', async () => {
    await render(createElement(Marketplace));

    const firstCard = document.querySelector('.card')!;
    const previewButton = firstCard.querySelector<HTMLButtonElement>('button')!;
    await act(async () => {
      previewButton.click();
    });

    expect(document.querySelector('.sheet')).not.toBeNull();
  });
});
