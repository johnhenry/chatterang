/**
 * Service worker registration.
 *
 * Deliberately narrow. Three conditions have to hold before this app registers
 * a worker at all, and each one is a real failure mode rather than caution:
 *
 * 1. **This platform wants an offline cache.** Only a browser tab does. The
 *    packaged builds — iOS, Android, and the Electron shell — already own
 *    their bundle on disk, and the plugins they route through (model
 *    downloads, file access, billing) go over the bridge, not through `fetch`.
 *    A worker there intercepts nothing useful and adds a second cache layer
 *    with its own lifecycle in front of an app that already has one.
 *
 *    It would also not work. `apps/desktop/app` is a verbatim copy of the
 *    production `dist/`, so `import.meta.env.PROD` is TRUE in the shell and
 *    registration WOULD be attempted without this guard — and MEASURED in a
 *    hidden Electron 44 window over the shell's real scheme, `register('/sw.js')`
 *    rejects: "The URL protocol of the current origin
 *    ('chatterang-desktop://app') is not supported." On iOS the WKWebView
 *    scheme is not a normal http origin either.
 *
 *    This asks `capabilities().offlineCache` rather than "am I native?"
 *    because that boolean answered TRUE on desktop for the wrong reason —
 *    right answer, wrong question. See `lib/platform.ts`.
 * 2. **Production only.** In dev, Vite serves modules it expects to control;
 *    a worker caching them is a debugging trap that outlives a hard reload.
 * 3. **Feature present.** Not every embedded browser has one.
 */

import { capabilities } from '@/lib/platform';

export function registerServiceWorker(): void {
  if (!capabilities().offlineCache) return;
  if (!import.meta.env.PROD) return;
  if (!('serviceWorker' in navigator)) return;

  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js').catch(() => {
      // A failed registration is not a failed app. Offline support is an
      // enhancement; swallowing this keeps a broken worker from taking the
      // whole surface down with it.
    });
  });
}

/**
 * The deferred install prompt, if the browser offered one.
 *
 * Chrome fires `beforeinstallprompt` once and expects the page to either call
 * `prompt()` in a user gesture or let it go. Stashing it lets the UI offer
 * installation at a sensible moment instead of whenever the browser decided.
 * iOS never fires it — there, installation is Share -> Add to Home Screen and
 * nothing in JavaScript can trigger it.
 */
let deferredPrompt: BeforeInstallPromptEvent | null = null;

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  readonly userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

export function captureInstallPrompt(onAvailable?: (available: boolean) => void): void {
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    deferredPrompt = event as BeforeInstallPromptEvent;
    onAvailable?.(true);
  });
  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    onAvailable?.(false);
  });
}

export function canInstall(): boolean {
  return deferredPrompt !== null;
}

/** Returns whether the user accepted. Safe to call when nothing is deferred. */
export async function promptInstall(): Promise<boolean> {
  if (!deferredPrompt) return false;
  await deferredPrompt.prompt();
  const { outcome } = await deferredPrompt.userChoice;
  deferredPrompt = null;
  return outcome === 'accepted';
}

/** True when running as an installed PWA rather than a browser tab. */
export function isStandalone(): boolean {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    // iOS predates display-mode and exposes this instead.
    (navigator as { standalone?: boolean }).standalone === true
  );
}
