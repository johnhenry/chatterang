/**
 * The platform seam.
 *
 * THE DEFECT THIS CLOSES. Every platform decision in `src/` used to be a
 * BOOLEAN — `Capacitor.isNativePlatform()`, which is literally
 * `getPlatform() !== 'web'`. There were four such sites, written when there
 * were two platforms and nothing had changed them since. The desktop shell
 * reports `'electron'`, so the boolean answers TRUE and all four took the
 * NATIVE path on a platform that implements only some of what native means:
 *
 *   - `download.ts` took the native branch into `@capacitor/filesystem`, which
 *     had no desktop implementation, so `@capacitor/core` fell through to the
 *     package's WEB shim and every model went into IndexedDB where the engine
 *     could never read it. That one cost a day.
 *   - `export.ts` still calls `Share.share`, which `apps/desktop` does not
 *     register, so export threw, was caught, and reported 'cancelled'.
 *   - `billing.ts` fell through to a store that does not exist.
 *   - `pwa.ts` returned early, which is RIGHT — but for the wrong reason.
 *
 * A boolean cannot answer a question with three answers, and it will be four
 * when the headless server (A9) lands.
 *
 * THE RULE THIS FILE EXISTS TO ENFORCE. This is the only module in `src/`
 * permitted to name a platform. `tests/layering.test.ts` makes that a guard
 * rather than a habit: `Capacitor.isNativePlatform` and `Capacitor.getPlatform`
 * may appear in exactly one file, this one. The fifth site fails the build the
 * day it is written.
 *
 * CAPABILITIES, NOT IDENTITY. Every caller asks what it actually needs to know
 * — "which sink do I write gigabytes to?", "how does a file leave this app?" —
 * rather than "am I native?". That is what each site was really asking, and it
 * makes A9 a new ROW rather than a new branch in four files.
 *
 * WHERE A PLUGIN ANSWERS BETTER, ASK THE PLUGIN. This table is a static
 * statement about what a platform COULD do. It does not replace a live check,
 * and there is one sharp rule about when delegating is safe:
 *
 *   A capability question may be delegated to a Capacitor plugin only when its
 *   web fallback REFUSES rather than PRETENDS.
 *
 *   Share      `canShare()` -> `{value:false}` on desktop.        Honest.
 *   Billing    `isAvailable()` -> `{available:false}`.            Honest.
 *   Filesystem `isPluginAvailable('Filesystem')` is TRUE on plain
 *              web, because the package ships a web impl that
 *              silently succeeds into IndexedDB.                  LIES.
 *
 * So `export.ts` and `billing.ts` consult their plugins after consulting this
 * table, and `download.ts` must NEVER ask `isPluginAvailable('Filesystem')` —
 * doing so would reinstate on the web target the exact bug eb3a279 fixed.
 *
 * NOT MEMOISED. `getPlatform()` is a property read against a global the shell
 * sets before the bundle loads, and it cannot change while the app is running.
 * Caching it would save nothing measurable and would make the seam a thing
 * tests have to reset, which is how a resolved-once value ends up lying in the
 * one place it matters.
 */

import { Capacitor } from '@capacitor/core';

/** The platforms this app is built for. A9's `'server'` becomes a fifth. */
export type PlatformId = 'web' | 'ios' | 'android' | 'electron';

/** Where multi-gigabyte model weights are written, and what a path then means. */
export type ModelStore =
  /**
   * A real directory on a real disk, through `@capacitor/filesystem`. Paths
   * handed back are paths the inference host can open.
   */
  | 'filesystem'
  /**
   * The Origin Private File System. Sandboxed, quota'd, and addressed by
   * handle — `opfs://…` strings are meaningful only to the web engine.
   */
  | 'opfs';

/** How a user-facing file leaves the app. */
export type FileHandoff =
  /** The OS share sheet — the only route to Files/Mail/an editor on iOS. */
  | 'share-sheet'
  /**
   * An `<a download>` on a blob URL.
   *
   * In a browser that is the download shelf. In the Electron shell it is the
   * OS save dialog: the renderer's download reaches `session`'s
   * `will-download`, and `apps/desktop/src/main.ts` registers no handler, so
   * Electron's default — prompt for a location — applies. Same code in `src/`,
   * the right UX on both, and no new plugin.
   */
  | 'browser-download';

export interface PlatformCapabilities {
  readonly id: PlatformId;
  /** Which sink a model download writes to. NEVER ask a plugin this. */
  readonly modelStore: ModelStore;
  /**
   * A second cache layer in front of the bundle is both POSSIBLE and WANTED.
   *
   * Two clauses, and the packaged platforms fail both: the shell already owns
   * its bundle on disk, and a custom scheme is not one a service worker can
   * register on. A protocol test alone would not do — Capacitor Android serves
   * from `https://localhost` and would pass it — so this is a platform-shape
   * decision and belongs in a table.
   */
  readonly offlineCache: boolean;
  readonly fileHandoff: FileHandoff;
  /**
   * A digital-goods store COULD exist here. The plugin still gets the final
   * word: on iOS a store can exist and still be unavailable (parental
   * controls, a StoreKit failure), which is a different question from this one.
   */
  readonly purchases: boolean;
}

/**
 * One row per platform. A new platform is a row, not a branch.
 *
 *                web              ios / android    electron
 *   modelStore   opfs             filesystem       filesystem
 *   offlineCache true             false            false
 *   fileHandoff  browser-download share-sheet      browser-download
 *   purchases    false            true             false
 */
const PLATFORMS: Readonly<Record<PlatformId, PlatformCapabilities>> = Object.freeze({
  web: {
    id: 'web',
    modelStore: 'opfs',
    offlineCache: true,
    fileHandoff: 'browser-download',
    purchases: false,
  },
  ios: {
    id: 'ios',
    modelStore: 'filesystem',
    offlineCache: false,
    fileHandoff: 'share-sheet',
    purchases: true,
  },
  android: {
    id: 'android',
    modelStore: 'filesystem',
    offlineCache: false,
    fileHandoff: 'share-sheet',
    purchases: true,
  },
  electron: {
    id: 'electron',
    modelStore: 'filesystem',
    offlineCache: false,
    fileHandoff: 'browser-download',
    purchases: false,
  },
});

/**
 * The row for a platform id this build has never heard of.
 *
 * `getPlatform()` returns whatever a custom platform called itself, so a shell
 * we do not know about is reachable. Falling back to the WEB row would be the
 * original bug's exact shape — a packaged app told to use OPFS, or a webview
 * handed a download anchor that does nothing. So an unknown platform is
 * treated as a packaged one with no claims made on its behalf: a real
 * filesystem (which every packaged platform has), no service worker, no store.
 * It reports its own id rather than pretending to be one of the four.
 */
function unknownPlatform(id: string): PlatformCapabilities {
  return {
    id: id as PlatformId,
    modelStore: 'filesystem',
    offlineCache: false,
    fileHandoff: 'browser-download',
    purchases: false,
  };
}

/** What this platform can do. The only platform question `src/` may ask. */
export function capabilities(): PlatformCapabilities {
  const id = Capacitor.getPlatform();
  return PLATFORMS[id as PlatformId] ?? unknownPlatform(id);
}
