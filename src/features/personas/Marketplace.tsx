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
                  disabled={has || purchasing === listing.id || (listing.price > 0 && !storeReady)}
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

      <button
        type="button"
        className="btn btn--ghost btn--block"
        onClick={() => void usePersonas.getState().restore()}
      >
        Restore purchases
      </button>

      <ListingSheet
        listing={detail}
        priceLabel={detail ? priceLabel(detail) : ''}
        owned={detail ? ownsListing(usePersonas.getState(), detail) : false}
        onClose={() => setDetail(null)}
      />
    </>
  );
}

function ListingSheet({
  listing,
  priceLabel,
  owned,
  onClose,
}: {
  listing: MarketplaceListing | null;
  priceLabel: string;
  owned: boolean;
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
          disabled={owned}
          onClick={() => {
            void usePersonas.getState().acquire(listing);
            onClose();
          }}
        >
          {owned ? 'Already in your personas' : `Get for ${priceLabel}`}
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
    </Sheet>
  );
}
