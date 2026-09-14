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

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

const { capabilities, hasFinePointer, unreachable } = await import('@/lib/platform');
const { canAcquire } = await import('@/features/personas/Marketplace');
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
      // #246. The File System Access API could genuinely grant a directory
      // here, and the row still says no: it hands out a HANDLE with no path,
      // and `src/shell/mount.ts`'s containment is "resolve, then check where
      // it landed". A handle cannot answer the resolve half.
      folderGrants: false,
      cameraScan: true,
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
        // False until a document-picker grant is wired to `MountHost`.
        // Capacitor's Filesystem reaches app-private storage, which is not a
        // folder the person chose.
        folderGrants: false,
        // #128. On iOS this is true only because patch-native writes
        // NSCameraUsageDescription; without it `navigator.mediaDevices` is
        // undefined in WKWebView (dev/probe-128).
        cameraScan: true,
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
      // #246's one true row: `apps/desktop/src/main.ts` puts Electron's own
      // `showOpenDialog` behind `MountHost.pick`, so a grant here is a modal
      // a person accepted.
      folderGrants: true,
      // The desktop draws codes rather than scanning them, and its Electron
      // permission handler (apps/desktop/src/permissions.ts) denies `media`.
      cameraScan: false,
    });
  });

  it('gives the served deployment the server row, and justifies each field', () => {
    /*
     * A9'S ROW. Nothing in this file previously forced a NEW row's values to
     * be argued for — a wrong one would have shipped green — so each field
     * here is asserted against the reason it holds, not against the table.
     *
     * `modelStore: 'filesystem'`  the weights live on the SERVER's disk,
     *   because the server's inference host is what opens them. `'opfs'` would
     *   put a multi-gigabyte download in the connecting browser's private
     *   filesystem, where the process with the GPU can never read it — which
     *   is eb3a279 on a fifth platform. The row is a claim about the
     *   `Filesystem` plugin being routed over the wire, and
     *   `tests/server-bootstrap.test.ts` is where that claim is checked
     *   against the real `@capacitor/core`.
     *
     * `fileHandoff: 'browser-download'`  a real browser with a real download
     *   shelf, saving to the machine the PERSON is at — which is not the
     *   machine the file was computed on. `'share-sheet'` would call a plugin
     *   the server does not register.
     *
     * `offlineCache: false`  the one genuine judgement call, and the only
     *   field where the packaged platforms' second clause fails on its own. A
     *   served http origin CAN register a service worker, so "not possible"
     *   stops applying; "not wanted" does not. The server owns the bundle on
     *   local disk, so there is no latency to hide, and a second cache with
     *   its own lifecycle in front of an app whose bundle changes when the
     *   operator upgrades the server is a stale-page bug for somebody else.
     *
     * `purchases: false`  there is no store here.
     *
     * `folderGrants: false`  NOT because the plugin is missing. `apps/server`
     *   could serve `MountHost` as readily as it serves `Filesystem`, and
     *   every call would succeed — against the OPERATOR's disk, with the
     *   chooser opening on the operator's screen. The person clicking "grant
     *   a folder" is somewhere else and would be granting a folder they have
     *   never seen. There is nobody at the other end to consent, so there is
     *   no consent event and no grant. This is also the field that makes the
     *   row NOT redundant with `unknownPlatform` — see below; it agrees by
     *   value and for a different reason.
     */
    expect(on('server', capabilities)).toEqual({
      id: 'server',
      modelStore: 'filesystem',
      offlineCache: false,
      fileHandoff: 'browser-download',
      purchases: false,
      folderGrants: false,
      cameraScan: false,
    });

    /*
     * SAID PLAINLY: THIS ASSERTION CANNOT TELL THE ROW FROM THE FALLBACK.
     *
     * `unknownPlatform()` answers filesystem / false / browser-download /
     * false and reports the id it was given — which is field for field what
     * the server row says. So deleting the row would not fail this test, and
     * claiming otherwise would be exactly the vacuous guard this file keeps
     * warning about.
     *
     * What actually forces the row to exist is the TYPE: `PLATFORMS` is a
     * `Readonly<Record<PlatformId, PlatformCapabilities>>`, so adding 'server'
     * to the union without a row is a compile error — measured, one error, at
     * `platform.ts`'s table. The agreement between the two is not an accident
     * either: `unknownPlatform` was written as "a packaged platform with no
     * claims made on its behalf", and a served deployment is precisely that.
     * The row exists so the values are STATED and argued, not inferred.
     */
    expect(on('some-future-shell', capabilities)).toEqual({
      ...on('server', capabilities),
      id: 'some-future-shell',
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
    // And grants no folder. The one field where "no" is the safe answer as
    // well as the honest one: an unknown shell's chooser, if it has one, is
    // in front of nobody this app can reason about.
    expect(unknown.folderGrants).toBe(false);
    // Nor a camera: an unknown shell's permission model is unknown too.
    expect(unknown.cameraScan).toBe(false);
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

/**
 * The pointer question, which is NOT a platform question.
 *
 * A6's review found the seam's front door standing open: `capabilities().id
 * === 'electron'` for "is this desktop chrome?" would have typechecked, read
 * as principled, and been WRONG — an Electron window can be 400 px wide and an
 * iPad can be 1200 px on a trackpad. `tests/layering.test.ts` now bans that
 * spelling in `src/`; this is the answer it leaves in its place.
 */
describe('viewport and input are asked of the browser, not of the table', () => {
  const asked: string[] = [];

  function withPointer<T>(matches: boolean | null, work: () => T): T {
    const before = Object.getOwnPropertyDescriptor(globalThis, 'matchMedia');
    Object.defineProperty(globalThis, 'matchMedia', {
      value:
        matches === null
          ? undefined
          : (query: string) => {
              asked.push(query);
              return { matches } as MediaQueryList;
            },
      configurable: true,
      writable: true,
    });
    try {
      return work();
    } finally {
      if (before) Object.defineProperty(globalThis, 'matchMedia', before);
      else Reflect.deleteProperty(globalThis, 'matchMedia');
    }
  }

  it('reports a mouse when the browser says there is one', () => {
    asked.length = 0;
    expect(withPointer(true, hasFinePointer)).toBe(true);
    expect(asked).toEqual(['(pointer: fine)']);
  });

  it('reports touch when the browser says the primary pointer is coarse', () => {
    asked.length = 0;
    expect(withPointer(false, hasFinePointer)).toBe(false);
    expect(asked).toEqual(['(pointer: fine)']);
  });

  it('does not throw where matchMedia is missing, and answers touch', () => {
    // FAULT INJECTED: `globalThis.matchMedia?.(...)` changed to
    // `globalThis.matchMedia(...)`. Observed: TypeError —
    // "globalThis.matchMedia is not a function", exit 1. The safe default
    // matters: a newline can be deleted, a message sent early cannot be
    // unsent.
    expect(withPointer(null, hasFinePointer)).toBe(false);
  });

  it('is not the platform table wearing a media query', () => {
    // The whole point. The SAME platform answers both ways depending on the
    // hardware in front of it, which is why no row could ever have held this.
    platform.id = 'electron';
    try {
      expect(withPointer(false, hasFinePointer)).toBe(false);
      expect(withPointer(true, hasFinePointer)).toBe(true);
      // And the table is unmoved by any of it.
      expect(capabilities().modelStore).toBe('filesystem');
    } finally {
      platform.id = 'web';
    }
  });
});

/**
 * The compile error, proved by actually compiling.
 *
 * A test that has already been compiled cannot assert on the compiler, so this
 * runs `tsc` for real and reads its EXIT CODE. Both directions are checked:
 * the exhaustive switch must compile clean, and the same switch with one more
 * union member must FAIL — otherwise the `never` parameter is decoration and a
 * fifth `ModelStore` would reach users as a silent fallback rather than a
 * broken build, which is exactly what the ternary it replaced did.
 */
describe('an unhandled capability is a build failure, not a fallback', () => {
  function compile(source: string): { code: number; output: string } {
    const dir = mkdtempSync(join(tmpdir(), 'chatterang-exhaustive-'));
    const file = join(dir, 'case.ts');
    writeFileSync(file, source, 'utf8');
    try {
      execFileSync(
        'npx',
        ['tsc', '--noEmit', '--strict', '--target', 'es2022', '--moduleResolution', 'bundler', '--module', 'esnext', file],
        { cwd: process.cwd(), stdio: 'pipe' },
      );
      return { code: 0, output: '' };
    } catch (error) {
      const e = error as { status?: number; stdout?: Buffer; stderr?: Buffer };
      return {
        code: e.status ?? 1,
        output: `${e.stdout?.toString() ?? ''}${e.stderr?.toString() ?? ''}`,
      };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  /**
   * The REAL `unreachable`, lifted out of `src/lib/platform.ts` as text.
   *
   * NOT A COPY. This started as a hand-written duplicate of the helper and was
   * revert-checked: widening the real signature from `value: never` to
   * `value: unknown` — which removes the entire compile-time guarantee — left
   * this test GREEN, because it was compiling its own copy. That is the
   * byte-identical-duplicate failure this repo has now hit twice, committed
   * inside the guard against it. Reading the shipped source is the fix.
   */
  const seam = readFileSync(join(process.cwd(), 'src/lib/platform.ts'), 'utf8');
  const helperMatch = /export function unreachable\([\s\S]*?\n}/.exec(seam);
  const HELPER = (helperMatch?.[0] ?? '').replace(/^export /, '');

  const dispatch = (union: string, cases: string) => `${HELPER}
type ModelStore = ${union};
declare const store: ModelStore;
function openSink(): string {
  switch (store) {
${cases}
    default:
      return unreachable(store, 'model store');
  }
}
void openSink;
`;

  it('lifts the real helper rather than a copy of it', () => {
    // If the extraction ever silently fails, both compile tests below become
    // assertions about an empty string — green, and meaningless.
    expect(helperMatch, 'unreachable() not found in src/lib/platform.ts').not.toBeNull();
    expect(HELPER).toContain('value: never');
    expect(HELPER).toContain('throw new Error');
  });

  it('compiles while every member of the union is handled', () => {
    const { code, output } = compile(
      dispatch("'filesystem' | 'opfs'", "    case 'filesystem':\n      return 'fs';\n    case 'opfs':\n      return 'opfs';"),
    );
    expect(output).toBe('');
    expect(code).toBe(0);
  }, 60000);

  it('FAILS to compile the moment a member has no arm', () => {
    // A fifth platform's sink — A9's headless server is the concrete case.
    const { code, output } = compile(
      dispatch(
        "'filesystem' | 'opfs' | 'object-store'",
        "    case 'filesystem':\n      return 'fs';\n    case 'opfs':\n      return 'opfs';",
      ),
    );
    expect(code).not.toBe(0);
    // And it fails FOR THE RIGHT REASON, naming the member nobody handled.
    expect(output).toContain('object-store');
    expect(output).toMatch(/not assignable to parameter of type 'never'/);
  }, 60000);

  it('throws at runtime too, because the compiler only sees this build', () => {
    // `capabilities()` resolves a string from a shell this build has never
    // heard of, so exhaustiveness over the SOURCE is not exhaustiveness over
    // the VALUE. Refusing loudly beats defaulting to the web.
    expect(() => unreachable('object-store' as never, 'model store')).toThrow(
      /Unhandled model store: object-store/,
    );
  });
});

/**
 * The marketplace's SECOND purchase entry point.
 *
 * `storeReady` gated the card's button and the Restore button. It did not gate
 * the detail sheet's "Get for …", which is an equal route to the same
 * `acquire()` — so on the web and in the desktop shell one button was
 * correctly disabled and an identical one, a single tap further in, was live
 * and ended at the Billing stub's throw. `billingAvailable()` had the answer
 * the whole time; one of the two callers was never asked to consult it.
 */
describe('every route into a purchase asks the seam', () => {
  const marketplace = readFileSync(
    join(process.cwd(), 'src/features/personas/Marketplace.tsx'),
    'utf8',
  );

  it('gates exactly as many purchase entry points as it has', () => {
    /*
     * A COUNT, not a spot check, because the defect was an entry point nobody
     * had counted. There is no React renderer in this repo, so the assertion
     * is on the source — and a count is the shape of assertion that survives a
     * THIRD button being added, which a test naming the two existing ones
     * would not.
     *
     * FAULT INJECTED: `!canAcquire(listing, storeReady)` removed from the
     * sheet's `disabled`. Observed: 2 acquire sites against 1 gate, exit 1.
     */
    const acquires = [...marketplace.matchAll(/\.acquire\(/g)];
    expect(acquires.length).toBeGreaterThan(1);

    /*
     * TIED TO THE `disabled` ATTRIBUTE, not merely present in the file.
     *
     * REVERT-CHECKED AND MISSED FIRST TIME: a version of this counted
     * `canAcquire(listing, storeReady)` anywhere in the source, so deleting
     * the gate from the sheet's `disabled={owned || needsStore}` left the
     * binding `const needsStore = …` behind — the count still matched and the
     * test stayed green while the button was live again. The gate has to be
     * found where it actually disables something.
     */
    for (const site of acquires) {
      const before = marketplace.slice(Math.max(0, site.index - 600), site.index);
      const at = before.lastIndexOf('disabled={');
      expect(at, `no disabled= before .acquire( at ${site.index}`).toBeGreaterThan(-1);

      let depth = 0;
      let end = at + 'disabled={'.length - 1;
      for (let i = at + 'disabled={'.length - 1; i < before.length; i += 1) {
        if (before[i] === '{') depth += 1;
        else if (before[i] === '}') {
          depth -= 1;
          if (depth === 0) {
            end = i;
            break;
          }
        }
      }
      const expression = before.slice(at, end + 1);
      expect(expression, `ungated purchase button: ${expression}`).toContain('canAcquire');
    }
  });

  it('passes the answer to the sheet rather than leaving it behind', () => {
    // The sheet is a separate component and simply was not given the prop.
    expect(marketplace).toMatch(/<ListingSheet[\s\S]{0,400}storeReady=\{storeReady\}/);
    expect(marketplace).toMatch(/storeReady: boolean;/);
  });

  it('lets a free persona through wherever it is, and a paid one only with a store', () => {
    // The gate itself, which is the one piece of this that is testable as a
    // function rather than as text.
    const free = { price: 0 } as Parameters<typeof canAcquire>[0];
    const paid = { price: 4.99 } as Parameters<typeof canAcquire>[0];

    expect(canAcquire(free, false)).toBe(true);
    expect(canAcquire(free, true)).toBe(true);
    expect(canAcquire(paid, false)).toBe(false);
    expect(canAcquire(paid, true)).toBe(true);
  });
});
