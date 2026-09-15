/**
 * What one window of the app tells the other windows of it.
 *
 * The server profile serves this bundle to ordinary browser tabs. Every tab of
 * one origin shares one database, but each has a store and a composer of its
 * own, and nothing one tab does reaches another's memory. Most of that waits for
 * a reload. One thing did not: Settings' delete of every conversation clears
 * every attachment payload, including the images a draft in another tab still
 * showed as chips, and that tab went on offering to send images that were gone
 * (owner ruling, 2026-09-14: that delete empties the composer).
 *
 * BroadcastChannel, on one name for the app. A message reaches every other
 * object bound to that name in the origin, another one in the same page
 * included, and never the object that posted it. Posted just before its page
 * reloads, it still arrives, and it needs no secure context: all measured in
 * Chromium 152. Where there is none — Safari before 15.4 — no other window is
 * told. Electron and Capacitor run one window, so there is no other to tell.
 */

export type WindowNotice = 'conversations-cleared';

const NAME = 'chatterang:windows';
const NOTICES: readonly WindowNotice[] = ['conversations-cleared'];

const listeners = new Map<WindowNotice, Set<() => void>>();

/** Opened as the module loads, so a window hears from the moment it is open. */
const channel: BroadcastChannel | null = (() => {
  try {
    return typeof BroadcastChannel === 'function' ? new BroadcastChannel(NAME) : null;
  } catch {
    return null;
  }
})();

channel?.addEventListener('message', (event: MessageEvent<unknown>) => {
  const notice = NOTICES.find((known) => known === event.data);
  if (!notice) return;
  for (const listener of [...(listeners.get(notice) ?? [])]) listener();
});

/** Tell every other window of the app. Where that cannot be said, nothing happens. */
export function tellOtherWindows(notice: WindowNotice): void {
  try {
    channel?.postMessage(notice);
  } catch {
    // A channel that cannot post tells no one, as no channel does.
  }
}

/** Run `listener` whenever another window of the app says `notice`. Returns what stops it. */
export function onOtherWindows(notice: WindowNotice, listener: () => void): () => void {
  const heard = listeners.get(notice) ?? new Set<() => void>();
  heard.add(listener);
  listeners.set(notice, heard);
  return () => {
    heard.delete(listener);
  };
}
