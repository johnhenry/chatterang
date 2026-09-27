import { useEffect, useMemo, useState, type ReactNode } from 'react';

import { Icon } from '@/ui/Icon';
import { Sheet } from '@/ui/primitives';
import { MARKETPLACE, type MarketplaceListing } from '@/data/personas';
import { billingAvailable, getProducts, type StoreProduct } from '@/lib/billing';
import { usePersonas, ownsListing } from '@/state/personas';
import { Avatar } from '@/features/personas/Avatar';
import type { Persona } from '@/domain/persona';

/**
 * Persona marketplace (PRD §3.2, §5).
 *
 * Purchases go through the platform store, scoped to digital persona content
 * only. Prices come from the store rather than being hard-coded, so the user
 * sees their own currency and any regional pricing.
 */

const CATEGORIES = ['All', 'Writing', 'Roleplay', 'Study', 'Work', 'Play'] as const;
type Category = (typeof CATEGORIES)[number];

/**
 * Can this listing be acquired here, right now?
 *
 * ONE GATE, because there turned out to be TWO purchase entry points. The card
 * button consulted `storeReady`; the detail sheet's "Get for …" did not — it
 * was passed `priceLabel` and `owned` and nothing about whether a store
 * exists. On the web and in the desktop shell that left one route correctly
 * disabled and an identical one, one tap further in, enabled and ending at the
 * Billing stub's throw.
 *
 * Both sites call this now, and `tests/platform.test.ts` holds the count of
 * `acquire` call sites equal to the count of gates — so a third entry point
 * cannot be added without one.
 *
 * Free personas are data and work everywhere; only a PAID one needs a store.
 */
export function canAcquire(listing: MarketplaceListing, storeReady: boolean): boolean {
  return listing.price === 0 || storeReady;
}

export function Marketplace(): ReactNode {
  const [category, setCategory] = useState<Category>('All');
  const [detail, setDetail] = useState<MarketplaceListing | null>(null);
  const [prices, setPrices] = useState<Record<string, StoreProduct>>({});
  const [storeReady, setStoreReady] = useState(false);

  const entitlements = usePersonas((state) => state.entitlements);
  const owned = usePersonas((state) => state.byId);
  const purchasing = usePersonas((state) => state.purchasing);

  useEffect(() => {
    void (async () => {
      const available = await billingAvailable();
      setStoreReady(available);
      if (!available) return;

      const ids = MARKETPLACE.map((listing) => listing.productId).filter(
        (id): id is string => Boolean(id),
      );
      const products = await getProducts(ids);
      setPrices(Object.fromEntries(products.map((product) => [product.productId, product])));
    })();
  }, []);

  const listings = useMemo(
    () =>
      MARKETPLACE.filter((listing) => category === 'All' || listing.category === category).sort(
        (a, b) => Number(b.featured ?? false) - Number(a.featured ?? false) || b.downloads - a.downloads,
      ),
    [category],
  );

  const priceLabel = (listing: MarketplaceListing): string => {
    if (listing.price === 0) return 'Free';
    const product = listing.productId ? prices[listing.productId] : undefined;
    return product?.displayPrice ?? `$${listing.price.toFixed(2)}`;
  };

  return (
    <>
      <div className="scroll-x">
        <div className="row" style={{ gap: 'var(--s-2)', paddingBottom: 2 }}>
          {CATEGORIES.map((entry) => (
            <button
              key={entry}
              type="button"
              className="chip chip--button"
              aria-pressed={category === entry}
              onClick={() => setCategory(entry)}
            >
              {entry}
            </button>
          ))}
        </div>
      </div>

      {!storeReady ? (
        <p className="section__hint">
          Paid personas can only be bought in the iOS and Android apps. Free ones work everywhere.
        </p>
      ) : null}

      <div className="section">
        {listings.map((listing) => {
          const has = Boolean(entitlements[listing.id]) || Boolean(owned[listing.persona.id]);
          return (
            <div key={listing.id} className="card">
              <div className="row" style={{ gap: 'var(--s-3)', alignItems: 'flex-start' }}>
                <Avatar persona={listing.persona as Persona} size={42} />
                <div className="list__main">
                  <span className="card__title">
                    {listing.persona.name}
                    {listing.featured ? (
                      <span className="chip chip--local" style={{ marginLeft: 8 }}>
                        <Icon name="star" size={10} />
                        Featured
                      </span>
                    ) : null}
                  </span>
                  <span className="list__sub">{listing.persona.tagline}</span>
                </div>
              </div>

              <div className="row" style={{ gap: 'var(--s-2)', flexWrap: 'wrap' }}>
                <span className="chip">{listing.category}</span>
                <span className="chip">
                  <Icon name="star" size={10} />
                  {listing.rating.toFixed(1)} · {listing.ratingCount.toLocaleString()}
                </span>
                <span className="chip">{listing.downloads.toLocaleString()} downloads</span>
                <span className="readout">by {listing.author}</span>
              </div>

              <div className="row" style={{ gap: 'var(--s-2)' }}>
                <button
                  type="button"
                  className="btn btn--secondary btn--sm grow"
                  onClick={() => setDetail(listing)}
                >
                  Preview
                </button>
                <button
                  type="button"
                  className="btn btn--primary btn--sm grow"
                  disabled={has || purchasing === listing.id || !canAcquire(listing, storeReady)}
                  onClick={() => void usePersonas.getState().acquire(listing)}
                >
                  {purchasing === listing.id ? <span className="spinner" /> : null}
                  {has ? (
                    <>
                      <Icon name="check" size={14} />
                      Added
                    </>
                  ) : (
                    <>
                      <Icon name="bag" size={14} />
                      {priceLabel(listing)}
                    </>
                  )}
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {/*
        Only where a store exists. On the web and in the desktop shell this
        button reached the Billing web stub, got an empty list back, and toasted
        "No previous purchases found for this account." — implying a store
        account the user does not have on this platform. `billingAvailable()`
        already answers the question; the button now honours it.
      */}
      {storeReady ? (
        <button
          type="button"
          className="btn btn--ghost btn--block"
          onClick={() => void usePersonas.getState().restore()}
        >
          Restore purchases
        </button>
      ) : null}

      {/*
        `storeReady` reaches the SHEET as well as the card. It did not, and the
        sheet is a second, equal purchase entry point: the card's button asked
        the seam and the sheet's "Get for …" did not, so on the web and in the
        desktop shell one route was correctly disabled while the other sat one
        tap further in, enabled, ending at a Billing stub that throws.
      */}
      <ListingSheet
        listing={detail}
        priceLabel={detail ? priceLabel(detail) : ''}
        owned={detail ? ownsListing(usePersonas.getState(), detail) : false}
        storeReady={storeReady}
        onClose={() => setDetail(null)}
      />
    </>
  );
}

/** Exported for tests: the detail sheet, driven directly rather than through the full store/pricing flow. */
export function ListingSheet({
  listing,
  priceLabel,
  owned,
  storeReady,
  onClose,
}: {
  listing: MarketplaceListing | null;
  priceLabel: string;
  owned: boolean;
  /** Whether a store exists here AND is answering. Same question the card asks. */
  storeReady: boolean;
  onClose: () => void;
}): ReactNode {
  if (!listing) return null;
  const persona = listing.persona;

  return (
    <Sheet
      open
      title={persona.name}
      onClose={onClose}
      footer={
        <button
          type="button"
          className="btn btn--primary btn--block"
          disabled={owned || !canAcquire(listing, storeReady)}
          onClick={() => {
            void usePersonas.getState().acquire(listing);
            onClose();
          }}
        >
          {owned
            ? 'Already in your personas'
            : !canAcquire(listing, storeReady)
              ? 'Only in the iOS and Android apps'
              : `Get for ${priceLabel}`}
        </button>
      }
    >
      <div className="row" style={{ gap: 'var(--s-3)' }}>
        <Avatar persona={persona as Persona} size={56} />
        <div className="list__main">
          <span className="list__title">{persona.tagline}</span>
          <span className="list__sub">by {listing.author}</span>
        </div>
      </div>

      <p style={{ color: 'var(--ink-2)', lineHeight: 'var(--lh-body)' }}>{persona.description}</p>

      {persona.firstMessage ? (
        <div className="card card--quiet">
          <span className="label">Opens with</span>
          <p style={{ fontSize: 'var(--t-sm)', whiteSpace: 'pre-wrap', color: 'var(--ink-2)' }}>
            {persona.firstMessage}
          </p>
        </div>
      ) : null}

      {persona.systemPrompt ? (
        <div className="field">
          <span className="field__label">How it behaves</span>
          <p
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 'var(--t-xs)',
              color: 'var(--ink-2)',
              whiteSpace: 'pre-wrap',
              lineHeight: 1.6,
            }}
          >
            {persona.systemPrompt}
          </p>
          <span className="field__hint">
            Personas are just instructions — nothing is hidden from you before you buy.
          </span>
        </div>
      ) : null}

      {/*
        Shown unconditionally, before the footer's "Get for …" button is
        even reachable — this is the disclosure the README promises
        ("full instructions visible before purchase"), and it renders for
        nothing that has no `agentConfig` (#23, #122). A `remote-connection`
        or `cli-agent` preference here is still consent-gated the same way
        any other imported/marketplace persona's is (`origin: 'marketplace'`
        is set at `acquire()`, not by anything on the listing) — this text
        says so rather than describing a connection that may not even exist
        for whoever is reading it, since the listing cannot know that.
      */}
      {persona.agentConfig ? (
        <div className="card card--quiet">
          <span className="label">Provider & tools</span>
          {persona.agentConfig.provider ? <p>{providerDisclosure(persona.agentConfig.provider.kind)}</p> : null}
          {persona.agentConfig.toolPolicy ? (
            <ul style={{ margin: 0, paddingLeft: 'var(--s-4)', color: 'var(--ink-2)', fontSize: 'var(--t-sm)' }}>
              {persona.agentConfig.toolPolicy.toolIds?.length ? (
                <li>Asks to pre-enable: {persona.agentConfig.toolPolicy.toolIds.join(', ')}</li>
              ) : null}
              {persona.agentConfig.toolPolicy.mcpServerIds?.length ? (
                <li>
                  Asks to use MCP servers you have added: {persona.agentConfig.toolPolicy.mcpServerIds.join(', ')}
                </li>
              ) : null}
              {persona.agentConfig.toolPolicy.confirmPolicy === 'always-ask' ? (
                <li>Always asks before a tool call, even where the app would not.</li>
              ) : null}
              {typeof persona.agentConfig.toolPolicy.maxToolRounds === 'number' ? (
                <li>Up to {persona.agentConfig.toolPolicy.maxToolRounds} tool round(s) per turn.</li>
              ) : null}
            </ul>
          ) : null}
          <span className="field__hint">
            None of this can ask for more than the app already allows — a sensitive tool or a
            server you have not added stays out regardless of what a persona asks for.
          </span>
        </div>
      ) : null}
    </Sheet>
  );
}

/** One honest sentence about a persona's provider preference, for the marketplace disclosure. */
function providerDisclosure(kind: 'local' | 'remote-connection' | 'cli-agent'): string {
  switch (kind) {
    case 'local':
      return 'Prefers to run on a model on your device.';
    case 'remote-connection':
      return (
        'Prefers a remote connection — cloud or self-hosted, depending on which you set up. ' +
        'You will be asked before anything is sent there.'
      );
    case 'cli-agent':
      return 'Prefers a command-line agent — not available in this app yet.';
  }
}
