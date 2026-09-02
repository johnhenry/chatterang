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
 * VIEWPORT AND INPUT ARE NOT PLATFORM QUESTIONS. This is the rule that keeps
 * the seam from becoming the boolean again under a new name. `capabilities()`
 * answers what the HOST can do — which sink, which handoff, whether a store
 * exists. It does not answer how wide the window is, whether there is a mouse,
 * or whether a physical keyboard is attached, and it must never be asked to:
 *
 *   An Electron window can be 400 px wide. An iPad can be 1200 px and driven
 *   by a trackpad. A phone can have a Bluetooth keyboard. A desktop browser
 *   can be a touchscreen laptop.
 *
 * So `if (capabilities().id === 'electron')` for "desktop chrome" is WRONG ON
 * THE MERITS as well as being identity branching — it is the same
 * `isNativePlatform()` mistake with a better-looking spelling, and it would
 * be wrong on the four counts above the day it is written. The right question
 * is a media query, asked of the browser at the moment it matters:
 *
 *   `hasFinePointer()`                   is there a mouse or trackpad?
 *   `matchMedia('(min-width: …)')`        how much room is there?
 *   `matchMedia('(any-hover: hover)')`    can anything hover?
 *
 * `tests/layering.test.ts` enforces this: `capabilities().id` — and its
 * destructured spelling — may appear in `src/` only in this file. The `id`
 * field exists so a diagnostic can NAME the host, not so a component can
 * branch on it.
 *
 * NOT MEMOISED. `getPlatform()` is a property read against a global the shell
 * sets before the bundle loads, and it cannot change while the app is running.
 * Caching it would save nothing measurable and would make the seam a thing
 * tests have to reset, which is how a resolved-once value ends up lying in the
 * one place it matters.
 */

import { Capacitor } from '@capacitor/core';

/** The platforms this app is built for. A9 made `'server'` the fifth. */
export type PlatformId = 'web' | 'ios' | 'android' | 'electron' | 'server';

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
  /**
   * Which host this is, for DIAGNOSTICS — a support banner, a bug report, a
   * log line.
   *
   * NOT A BRANCH. `capabilities().id === 'electron'` is banned in `src/` by
   * `tests/layering.test.ts`, because every question anyone has wanted to ask
   * it has turned out to be a question about the sink, the handoff, the store,
   * or the viewport. See the header: viewport and input are media queries.
   */
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
 *                web              ios / android    electron          server
 *   modelStore   opfs             filesystem       filesystem        filesystem
 *   offlineCache true             false            false             false
 *   fileHandoff  browser-download share-sheet      browser-download  browser-download
 *   purchases    false            true             false             false
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
  /*
   * A9: the bundle served by `apps/server`, running in an ordinary browser
   * against a headless host on the machine that serves it.
   *
   * THE ROW IS THE CHEAP HALF, AND IT IS NOT THE HALF THAT MAKES IT TRUE.
   * `Capacitor.getPlatform()` answers `'server'` only because the served
   * bootstrap seeds `CapacitorCustomPlatform` before the bundle loads, and
   * naming the platform does not decide which implementation answers a plugin
   * call. Measured against the real `@capacitor/core`: with the platform named
   * `'server'` and NO plugin header seeded, `registerPlugin('LlamaCpp', {web})`
   * resolves to the WEB development shim — the one that synthesises text and
   * reports `simulated: true`. So this row is honest only while
   * `apps/server/src/client-bootstrap.ts` also seeds the headers; that file,
   * not this one, is what stops a served deployment from streaming invented
   * prose that looks like inference.
   *
   *   modelStore: 'filesystem'
   *     The weights live on the SERVER's disk, because the server's inference
   *     host is what opens them. `'opfs'` would put a multi-gigabyte download
   *     in the connecting browser's Origin Private File System, where the
   *     process with the GPU can never read it — eb3a279's bug on a fifth
   *     platform. This row is therefore a claim about `@capacitor/filesystem`
   *     being routed over the wire to the server's real directory; the server
   *     registers `FILESYSTEM_PLUGIN` for exactly that reason, and a server
   *     that omitted it would silently write into IndexedDB.
   *
   *   offlineCache: false
   *     Both clauses fail, but only just, and this is the row's one genuine
   *     judgement call. A served http origin CAN register a service worker —
   *     unlike the packaged platforms, the "not possible" half stops applying.
   *     It is still not WANTED: the server owns the bundle on local disk, so
   *     there is no latency to hide, and a second cache with its own lifecycle
   *     in front of an app whose bundle changes when the operator upgrades the
   *     server is a stale-page bug waiting for someone else to debug.
   *
   *   fileHandoff: 'browser-download'
   *     A real browser with a real download shelf, saving to the machine the
   *     PERSON is sitting at — which is not the machine the file was computed
   *     on. That difference is the point of server mode, and `<a download>` is
   *     the only handoff that respects it.
   *
   *   purchases: false
   *     There is no store here, and nothing in the served bundle should look
   *     for one.
   */
  server: {
    id: 'server',
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

/**
 * Is there a mouse or a trackpad?
 *
 * THIS IS NOT A PLATFORM QUESTION, which is exactly why it lives beside the
 * table rather than in it. A table row is a static claim about a host; this
 * changes when a user plugs in a mouse, drags an Electron window onto a touch
 * display, or picks up an iPad with a Magic Keyboard. `capabilities()` is
 * resolved from a global fixed before the bundle loads and could never track
 * that.
 *
 * It is here so there is ONE place to ask, rather than the two hand-rolled
 * `matchMedia('(pointer: fine)')` calls this replaces — `Composer` (does Enter
 * send, or insert a newline?) and `ShellSheet` (does clicking the transcript
 * focus the input, or dismiss the keyboard?). Both were already asking the
 * RIGHT question; they were just asking it twice, which is how the second copy
 * ends up being the one someone rewrites as a platform check.
 *
 * `pointer` describes the PRIMARY pointing device. A phone with a Bluetooth
 * mouse reports `coarse` for `pointer` and `fine` for `any-pointer`; the two
 * callers here both want the primary one, because both are asking about the
 * input the user is most likely reaching for.
 *
 * Defaults to FALSE where `matchMedia` is missing (jsdom without a stub, an
 * SSR pass): the touch behaviour is the safe one — a newline can be deleted,
 * a message sent early cannot be unsent.
 */
export function hasFinePointer(): boolean {
  return globalThis.matchMedia?.('(pointer: fine)').matches ?? false;
}

/**
 * The compile error a new row is supposed to cause.
 *
 * THE DEFECT THIS CLOSES. Both capability dispatches were TERNARIES —
 * `modelStore === 'filesystem' ? fs : opfs` — so any value that was not
 * `'filesystem'` silently got WEB behaviour. That is not a hypothetical
 * failure mode: writing model weights into a web sink on a platform that has a
 * real disk is the original bug of this milestone, and a ternary is the exact
 * shape that produced it. A row added to the table without a matching arm
 * would have reinstated it silently.
 *
 * Called from the `default` of an exhaustive switch, this makes that a
 * COMPILE error. TypeScript narrows the scrutinee to `never` once every member
 * is handled; add a member and the narrowing leaves that member's type behind,
 * which is not assignable to `never`, and the build stops on the dispatch that
 * has not been updated — not on a user's machine, months later, with a model
 * in the wrong place.
 *
 * The runtime throw is the second half and is not decoration: `capabilities()`
 * resolves a string from a shell this build has never seen, so the compiler's
 * exhaustiveness is a claim about the SOURCE, not about the value. If one
 * arrives anyway, refusing loudly beats defaulting to the web.
 */
export function unreachable(value: never, what: string): never {
  throw new Error(`Unhandled ${what}: ${String(value)}`);
}
