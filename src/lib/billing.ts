/**
 * In-app purchase bridge for the persona marketplace (PRD §5).
 *
 * The store transaction has to happen in native code — StoreKit 2 on iOS,
 * Play Billing on Android — so this module defines the contract and delegates
 * to a Capacitor plugin when one is present. In a browser there is no store,
 * so paid listings are honestly reported as unavailable rather than silently
 * granted.
 *
 * Scope is deliberately narrow: digital persona content only. Nothing here
 * touches model downloads, which are free and come from Hugging Face.
 */

import { registerPlugin } from '@capacitor/core';

import { capabilities } from '@/lib/platform';

export interface PurchaseReceipt {
  productId: string;
  transactionId: string;
  purchasedAt: number;
}

export interface StoreProduct {
  productId: string;
  /** Localised price string from the store, e.g. "£2.49". */
  displayPrice: string;
  title: string;
  description: string;
}

interface BillingPlugin {
  isAvailable(): Promise<{ available: boolean }>;
  getProducts(options: { productIds: string[] }): Promise<{ products: StoreProduct[] }>;
  purchase(options: { productId: string }): Promise<PurchaseReceipt>;
  restorePurchases(): Promise<{ receipts: PurchaseReceipt[] }>;
}

const Billing = registerPlugin<BillingPlugin>('Billing', {
  web: async () => ({
    async isAvailable() {
      return { available: false };
    },
    async getProducts() {
      return { products: [] };
    },
    async purchase(): Promise<PurchaseReceipt> {
      throw new Error(
        'Purchases are only available in the iOS and Android apps, not in a browser.',
      );
    },
    async restorePurchases() {
      return { receipts: [] };
    },
  }),
});

/**
 * Is there an in-app purchase store here, and is it answering?
 *
 * TWO QUESTIONS, DELIBERATELY TWO CALLS. `capabilities().purchases` is static:
 * a store COULD exist on this platform. `Billing.isAvailable()` is live: the
 * store is answering right now — which on iOS can be false for a device with a
 * store (parental controls, a StoreKit failure), so the plugin call is not
 * redundant with the table.
 *
 * The gate used to be `!Capacitor.isNativePlatform()`, which is FALSE on the
 * desktop shell — so desktop fell through to a store it does not have. The
 * user-visible outcome was still correct, but only by luck: with no Billing
 * `PluginHeader`, `@capacitor/core` loads this module's own `web` stub through
 * its `capCustomPlatform` fallback, and that stub happens to answer honestly
 * (`{available:false}`). That is the SAME fallback that put model weights in
 * IndexedDB, where it was a silent lie. Identical fragility, opposite luck —
 * so desktop's answer is now stated here rather than inherited from a
 * third-party package's undocumented-by-us behaviour.
 */
export async function billingAvailable(): Promise<boolean> {
  if (!capabilities().purchases) return false;
  const { available } = await Billing.isAvailable().catch(() => ({ available: false }));
  return available;
}

/** Live store prices, so the marketplace shows the user's own currency. */
export async function getProducts(productIds: string[]): Promise<StoreProduct[]> {
  if (productIds.length === 0) return [];
  const { products } = await Billing.getProducts({ productIds }).catch(() => ({ products: [] }));
  return products;
}

export async function purchase(productId: string): Promise<PurchaseReceipt> {
  return Billing.purchase({ productId });
}

/**
 * Restore is refused where there is no store, rather than answering `[]`.
 *
 * The web stub returns an empty list, and `state/personas.ts` reads that as
 * "no previous purchases found for this account" — a sentence that implies a
 * store account the user does not have on this platform. Refusing gives the
 * caller something true to say instead.
 */
export async function restorePurchases(): Promise<PurchaseReceipt[]> {
  if (!capabilities().purchases) {
    throw new Error('Purchases are only available in the iOS and Android apps.');
  }
  const { receipts } = await Billing.restorePurchases();
  return receipts;
}
