/**
 * The marketplace detail sheet's provider/tool-policy disclosure (#23, #122).
 *
 * The README promises "full instructions visible before purchase"; this
 * extends that promise to a listing's `agentConfig` — what provider it
 * prefers and what it asks of the tool picker — shown in the SAME sheet, not
 * behind a second tap, and not gated behind anything that would let someone
 * reach the acquire button first. Driven against the real `ListingSheet`
 * directly (exported for this), which is simpler and faster than the full
 * `Marketplace` screen's store/pricing flow and exercises exactly the
 * component the disclosure lives in.
 */

import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { ListingSheet } = await import('@/features/personas/Marketplace');
type MarketplaceListing = import('@/data/personas').MarketplaceListing;

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function listing(overrides: Partial<MarketplaceListing['persona']> = {}): MarketplaceListing {
  return {
    id: 'listing_test',
    price: 0,
    currency: 'USD',
    productId: null,
    author: 'Someone',
    downloads: 0,
    rating: 0,
    ratingCount: 0,
    category: 'Study',
    persona: {
      id: 'persona_test',
      kind: 'assistant',
      name: 'Test Persona',
      tagline: 'A test persona',
      avatarSeed: 'test',
      description: 'Does testing.',
      tags: [],
      showThinking: false,
      builtin: false,
      ...overrides,
    },
  };
}

let host: HTMLDivElement | null = null;
let root: import('react-dom/client').Root | null = null;

async function render(tree: ReturnType<typeof createElement>): Promise<void> {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(tree);
  });
}

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  vi.restoreAllMocks();
});

describe('the provider/tool-policy disclosure', () => {
  it('renders nothing for a persona without agentConfig', async () => {
    await render(
      createElement(ListingSheet, {
        listing: listing(),
        priceLabel: 'Free',
        owned: false,
        storeReady: true,
        onClose: () => {},
      }),
    );
    expect(document.body.textContent).not.toContain('Provider & tools');
  });

  it('names the provider preference and the tool policy, before the acquire button is reachable', async () => {
    await render(
      createElement(ListingSheet, {
        listing: listing({
          agentConfig: {
            provider: { kind: 'remote-connection' },
            toolPolicy: { toolIds: ['calculator'], confirmPolicy: 'always-ask', maxToolRounds: 2 },
          },
        }),
        priceLabel: 'Free',
        owned: false,
        storeReady: true,
        onClose: () => {},
      }),
    );

    const label = document.body.textContent ?? '';
    expect(label).toContain('Provider & tools');
    expect(label).toMatch(/remote connection/i);
    expect(label).toContain('calculator');
    expect(label).toContain('Always asks before a tool call');
    expect(label).toContain('2 tool round');

    // Present in the DOM alongside the button, not behind a second
    // interaction gating it — the button is already there to click.
    const button = document.querySelector<HTMLButtonElement>('.btn--primary');
    expect(button).not.toBeNull();
    expect(button?.disabled).toBe(false);
  });

  it('names a local-model preference honestly', async () => {
    await render(
      createElement(ListingSheet, {
        listing: listing({ agentConfig: { provider: { kind: 'local' } } }),
        priceLabel: 'Free',
        owned: false,
        storeReady: true,
        onClose: () => {},
      }),
    );
    expect(document.body.textContent).toMatch(/on your device/i);
  });

  it('names a cli-agent preference as not yet available', async () => {
    await render(
      createElement(ListingSheet, {
        listing: listing({ agentConfig: { provider: { kind: 'cli-agent' } } }),
        priceLabel: 'Free',
        owned: false,
        storeReady: true,
        onClose: () => {},
      }),
    );
    expect(document.body.textContent).toMatch(/not available in this app yet/i);
  });

  it('says none of it can widen past what the app already allows', async () => {
    await render(
      createElement(ListingSheet, {
        listing: listing({ agentConfig: { toolPolicy: { toolIds: ['bash'] } } }),
        priceLabel: 'Free',
        owned: false,
        storeReady: true,
        onClose: () => {},
      }),
    );
    expect(document.body.textContent).toMatch(/can ask for more than the app already allows/i);
  });
});
