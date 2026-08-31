/**
 * The platform seam, and the two callers whose desktop behaviour was correct
 * only by accident.
 *
 * WHAT THE TABLE IS FOR. Every platform decision in `src/` used to be
 * `Capacitor.isNativePlatform()` — `getPlatform() !== 'web'` — at four sites.
 * The desktop shell reports `'electron'`, so that boolean answered TRUE and
 * every site took the native path on a platform that is native in some ways
 * and not others. `src/lib/platform.ts` replaces the boolean with one row per
 * platform, and `tests/layering.test.ts` makes it the only file in `src/`
 * allowed to name one.
 *
 * WHY THE UNKNOWN-PLATFORM ROW IS TESTED AS CAREFULLY AS THE FOUR REAL ONES.
 * `getPlatform()` returns whatever a custom platform called itself, so a shell
 * this build has never heard of is reachable — A9's headless server will be
 * exactly that on the day before its row is written. Falling back to the WEB
 * row would hand a packaged app OPFS and a download anchor, which is the shape
 * of the bug that started all this.
 */

import { describe, expect, it, vi } from 'vitest';

const platform = vi.hoisted(() => ({ id: 'web' }));

vi.mock('@capacitor/core', async (importActual) => {
  const actual = await importActual<typeof import('@capacitor/core')>();
  return {
    ...actual,
    Capacitor: {
      ...actual.Capacitor,
      getPlatform: () => platform.id,
      isNativePlatform: () => platform.id !== 'web',
    },
    // `billing.ts` registers its plugin at module scope; this captures the
    // call so a test can decide what the store answers.
    registerPlugin: (_name: string) => ({
      isAvailable: async () => {
        billing.calls.push('isAvailable');
        return { available: billing.available };
      },
      getProducts: async () => {
        billing.calls.push('getProducts');
        return { products: [] };
      },
      purchase: async () => {
        billing.calls.push('purchase');
        throw new Error('no');
      },
      restorePurchases: async () => {
        billing.calls.push('restorePurchases');
        return { receipts: [] };
      },
    }),
  };
});

const billing = vi.hoisted(() => ({ available: true, calls: [] as string[] }));

const { capabilities } = await import('@/lib/platform');
const { billingAvailable, restorePurchases } = await import('@/lib/billing');

function on<T>(id: string, work: () => T): T {
  platform.id = id;
  try {
    return work();
  } finally {
    platform.id = 'web';
  }
}

describe('the capability table', () => {
  it('gives the web a service worker, OPFS, a download, and no store', () => {
    expect(on('web', capabilities)).toEqual({
      id: 'web',
      modelStore: 'opfs',
      offlineCache: true,
      fileHandoff: 'browser-download',
      purchases: false,
    });
  });

  for (const id of ['ios', 'android']) {
    it(`gives ${id} a real filesystem, a share sheet, a store, and no worker`, () => {
      expect(on(id, capabilities)).toEqual({
        id,
        modelStore: 'filesystem',
        offlineCache: false,
        fileHandoff: 'share-sheet',
        purchases: true,
      });
    });
  }

  it('gives the desktop shell a real filesystem, a download, and no store', () => {
    /*
     * THE ROW THE MILESTONE IS ABOUT. Three of these four fields were being
     * answered by `isNativePlatform()`, and it got two of them wrong: the
     * share sheet (there is no Share plugin in the shell, so export silently
     * did nothing) and the store (there is no Billing plugin, so billing fell
     * through to a fallback that happened to be honest). `offlineCache: false`
     * is the one it got right — and MEASURED in a hidden Electron window,
     * registration on `chatterang-desktop://app` is refused by Chromium
     * anyway, so it is right twice over.
     */
    expect(on('electron', capabilities)).toEqual({
      id: 'electron',
      modelStore: 'filesystem',
      offlineCache: false,
      fileHandoff: 'browser-download',
      purchases: false,
    });
  });

  it('treats an unfamiliar platform as packaged, never as the web', () => {
    // FAULT INJECTED: the fallback changed to `PLATFORMS.web`. Observed: this
    // failed on `modelStore` — a packaged shell would have been handed OPFS,
    // which is the original defect wearing a different hat. Exit 1.
    const unknown = on('some-future-shell', capabilities);
    expect(unknown.modelStore).toBe('filesystem');
    expect(unknown.offlineCache).toBe(false);
    expect(unknown.purchases).toBe(false);
    // It reports its own id rather than claiming to be one of the four.
    expect(unknown.id).toBe('some-future-shell');
  });

  it('answers the same thing twice — it is a lookup, not a latch', () => {
    // Not memoised, deliberately: a resolved-once value is a thing tests have
    // to reset, and this seam is asked from four places.
    expect(on('ios', capabilities)).toEqual(on('ios', capabilities));
    expect(on('web', capabilities).modelStore).toBe('opfs');
    expect(on('electron', capabilities).modelStore).toBe('filesystem');
  });
});

describe('billing states its desktop answer instead of inheriting it', () => {
  it('does not even ask the store where a platform has none', async () => {
    /*
     * `!Capacitor.isNativePlatform()` is FALSE on desktop, so the old guard
     * fell THROUGH and called `Billing.isAvailable()` on a platform with no
     * Billing implementation. The answer came back `{available:false}` — but
     * from `@capacitor/core`'s `capCustomPlatform` fallback to this module's
     * own web stub, which is the SAME fallback that put model weights in
     * IndexedDB. There it was a silent lie; here it happened to be honest.
     *
     * FAULT INJECTED: the guard restored to `!Capacitor.isNativePlatform()`.
     * Observed: `isAvailable` appeared in the call log for 'electron', and
     * with a plugin that answers `{available:true}` — a plugin the shell could
     * plausibly gain — `billingAvailable()` returned TRUE. Exit 1.
     */
    billing.calls = [];
    billing.available = true;

    platform.id = 'electron';
    expect(await billingAvailable()).toBe(false);
    platform.id = 'web';
    expect(await billingAvailable()).toBe(false);

    expect(billing.calls).toEqual([]);
  });

  it('still lets the store have the last word where one could exist', async () => {
    // Static capability and live availability are two questions: on iOS a
    // store can exist and still be unavailable — parental controls, a
    // StoreKit failure — so the plugin call is not redundant with the table.
    billing.calls = [];
    platform.id = 'ios';

    billing.available = true;
    expect(await billingAvailable()).toBe(true);

    billing.available = false;
    expect(await billingAvailable()).toBe(false);

    expect(billing.calls).toEqual(['isAvailable', 'isAvailable']);
    platform.id = 'web';
  });

  it('refuses to restore purchases where there is no store to restore from', async () => {
    // The web stub answers `[]`, which `state/personas.ts` reports as "No
    // previous purchases found for this account." — implying an account the
    // user does not have on this platform.
    billing.calls = [];
    platform.id = 'electron';
    await expect(restorePurchases()).rejects.toThrow(/only available in the iOS and Android apps/);
    expect(billing.calls).toEqual([]);
    platform.id = 'web';
  });
});
