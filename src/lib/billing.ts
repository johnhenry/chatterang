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

import { Capacitor, registerPlugin } from '@capacitor/core';

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

export async function billingAvailable(): Promise<boolean> {
  if (!Capacitor.isNativePlatform()) return false;
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

export async function restorePurchases(): Promise<PurchaseReceipt[]> {
  const { receipts } = await Billing.restorePurchases();
  return receipts;
}
