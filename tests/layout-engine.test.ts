// @vitest-environment node
/**
 * THE LAYOUT, MEASURED IN A REAL ENGINE.
 *
 * WHY THIS FILE EXISTS. `tests/support/css.ts` resolves the cascade, the
 * custom-property graph and `calc()`, and its own docstring says it is not a
 * layout engine. That is not modesty. The defect this file was written for —
 * a session column that laid out 200 chats and let the user reach nine of them
 * — is INVISIBLE to a static resolver by construction: every declaration
 * involved was correct on its own. `.history__body` had `overflow-y: auto` and
 * `min-height: 0`, which is the whole recipe; what it did not have was a
 * bounded row above it and an unshrinkable child inside it, and only a box
 * tree knows either. Of the twenty findings the last review raised, nineteen
 * revert-checks missed, seven of them CSS. That is what a suite with no engine
 * in it looks like.
 *
 * So: Chromium, in an Electron window with `show: false`, driving the app from
 * the Vite dev server at real widths, answering with `getBoundingClientRect`,
 * `scrollHeight` and `elementFromPoint`. `tests/support/layout-probe.mjs` does
 * the measuring and owns no assertions; this file owns every assertion and
 * measures nothing. One launch for the whole file, because a launch costs
 * seconds.
 *
 * WHAT IT CANNOT SEE, stated rather than papered over:
 *
 *   - `:focus` does not match a scripted `el.focus()` in a hidden window, so
 *     focus-ring assertions stay in the static suite against the declaration.
 *   - CDP `Input.dispatchKeyEvent` with `'rawKeyDown'` skips the key's default
 *     action, so nothing here synthesises a key press. Keyboard behaviour is
 *     `tests/keys.test.ts`, against a real listener in jsdom.
 *   - the scrollbar width it measures is this machine's. That is the point —
 *     the column's budget has to survive a real one — but a platform with a
 *     wider scrollbar would report a smaller title box, so the assertion is a
 *     floor rather than an equality.
 */

import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type ViteDevServer } from 'vite';

import { declaredValue, rootProperties, substitute, thresholds, toPx } from './support/css';

/* ── What the probe answers with ─────────────────────────────────────── */

interface ListMeasurement {
  readonly present: boolean;
  readonly rows: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
  readonly scrollTop: number;
  readonly overflows: boolean;
  readonly scrolls: boolean;
  readonly withinViewport: boolean;
  readonly lastTitle?: string;
  readonly lastVisible: boolean;
  readonly lastHit: boolean;
  readonly hitTag: string | null;
}

interface Box {
  readonly width: number;
  readonly height: number;
  readonly left: number;
  readonly bottom: number;
  readonly display: string;
}

interface WidthRecord {
  readonly geometry: {
    readonly viewport: { readonly width: number; readonly height: number };
    readonly rail: Box | null;
    readonly history: Box | null;
    readonly chatMain: Box | null;
    readonly thread: Box | null;
    readonly measure: number | null;
    readonly rows: number;
    readonly historyRow: {
      readonly columnWidth: number;
      readonly bodyPaddingInline: number;
      readonly bodyClientWidth: number;
      readonly itemWidth: number;
      readonly titleWidth: number;
      readonly iconButton: number | null;
    } | null;
    readonly historyToggleShown: boolean;
  };
  readonly column: ListMeasurement;
  readonly overflowing: readonly string[];
  readonly placeholder: {
    readonly present: boolean;
    readonly placeholder: string;
    readonly textWidth: number;
    readonly room: number;
    readonly fits: boolean;
    readonly fieldHeight: number;
    readonly lineHeight: number;
  };
  readonly sheet?: ListMeasurement;
  readonly sheetBox?: {
    readonly top: number;
    readonly bottom: number;
    readonly height: number;
    readonly viewport: number;
  };
}

interface FaceMetrics {
  readonly ch: number;
  readonly renderedZero: number;
  readonly advance: number;
}

interface ProbeResult {
  readonly seeded: number;
  readonly widths: Record<string, WidthRecord>;
  readonly sweep: Record<'declared' | 'fallback', Record<string, number | null>>;
  readonly consoleErrors: readonly string[];
  readonly fonts: {
    readonly prose: string;
    readonly declared: string;
    readonly fallbackStack: string;
    readonly archivoResident: boolean;
    readonly withArchivo: FaceMetrics;
    readonly fallback: FaceMetrics;
  };
  readonly error?: string;
}

/* ── The gate ────────────────────────────────────────────────────────── */

/**
 * Where Electron's binary is, or `undefined` when there is none.
 *
 * A PURE FUNCTION, TESTED UNCONDITIONALLY BELOW, for the same reason
 * `resolveTestWhisper` is one: "no Electron on this machine" and "Electron is
 * there and the probe is broken" must not look the same, and a suite that
 * reports green without having observed anything is the outcome worth
 * preventing. Electron is a devDependency of `apps/desktop` and hoists to the
 * root, so on any machine that has run `npm install` this returns a path and
 * the file RUNS.
 *
 * @param resolveModule - how to resolve the `electron` package's export.
 * @param exists - how to test a path, injected so the gate itself is testable.
 * @returns the binary path, or `undefined` to skip.
 */
export function resolveElectron(
  resolveModule: () => unknown,
  exists: (path: string) => boolean,
): string | undefined {
  let answer: unknown;
  try {
    answer = resolveModule();
  } catch {
    return undefined;
  }
  if (typeof answer !== 'string' || answer.length === 0) return undefined;
  return exists(answer) ? answer : undefined;
}

const require_ = createRequire(import.meta.url);
const ELECTRON = resolveElectron(() => require_('electron'), existsSync);

/* ── The tier under test, read from the sheet ────────────────────────── */

const read = (relative: string): string => readFileSync(resolve(process.cwd(), relative), 'utf8');
const tokens = read('src/styles/tokens.css');
const componentCss = read('src/styles/components.css');
const SHEETS = [tokens, read('src/styles/base.css'), componentCss] as const;

/**
 * The threshold at which the session list stops being a modal.
 *
 * Derived from the sheet, not written here: retuning the ladder must move
 * which widths are probed, not fail a test whose subject is not the number.
 */
const WORKBENCH_TIER = ((): number => {
  for (const threshold of thresholds(tokens)) {
    const value = declaredValue(SHEETS, ':root', '--history-w', {
      width: threshold,
      finePointer: true,
    });
    if (value !== undefined && toPx(value, { rem: 16, ch: 8.59 }) > 0) return threshold;
  }
  throw new Error('no tier gives the session list a width');
})();

/** `--rail-w` and `--pad-screen` in px at the tier, from the sheet. */
const tokenAt = (name: string, width: number): number =>
  toPx(
    substitute(`var(${name})`, rootProperties(SHEETS, { width, finePointer: true })),
    { rem: 16, ch: 8.59 },
  );

const NARROW = 390;
const BELOW_TIER = 900;
const WIDE = 1440;
const CHATS = 200;

/* ── One launch, in a hook ───────────────────────────────────────────── */

let server: ViteDevServer | undefined;
let probe: ProbeResult | undefined;

beforeAll(async () => {
  if (ELECTRON === undefined) return;

  // Port 0: the suite must not fight a dev server the developer is already
  // running, and must not leave one behind either.
  server = await createServer({
    configFile: resolve(process.cwd(), 'vite.config.ts'),
    server: { port: 0, strictPort: false, host: '127.0.0.1' },
    logLevel: 'silent',
  });
  await server.listen();
  const url = server.resolvedUrls?.local[0];
  if (url === undefined) throw new Error('the dev server reported no local URL');

  const out = join(mkdtempSync(join(tmpdir(), 'chatterang-layout-')), 'probe.json');
  const widths = [NARROW, BELOW_TIER, WORKBENCH_TIER - 1, WORKBENCH_TIER, WIDE];
  // Every threshold boundary in either sheet, plus the widths a window is
  // actually dragged to. The sweep's job is to catch a tier that costs measure.
  const sweep = [
    ...new Set(
      [
        600,
        919,
        920,
        921,
        1024,
        ...[...thresholds(tokens), ...thresholds(componentCss)].flatMap((threshold) => [
          threshold - 1,
          threshold,
          threshold + 1,
        ]),
        1440,
        1920,
      ].filter((width) => width >= 600),
    ),
  ].sort((a, b) => a - b);

  /*
   * ASYNC, AND THAT IS NOT A STYLE CHOICE.
   *
   * `execFileSync` DEADLOCKS here. The Vite dev server the probe is about to
   * load runs in THIS process, and a synchronous spawn blocks this process's
   * event loop for the whole life of the child — so the server can never
   * answer the request the child is waiting for. The symptom is a probe that
   * hangs in `loadURL` until something's timeout fires, with no error and no
   * measurements, which is a very expensive way to learn this.
   */
  try {
    await promisify(execFile)(
      ELECTRON,
      [
        resolve(process.cwd(), 'tests/support/layout-probe.mjs'),
        `--url=${url}`,
        `--out=${out}`,
        `--chats=${CHATS}`,
        `--widths=${widths.join(',')}`,
        `--sweep=${sweep.join(',')}`,
      ],
      { timeout: 120_000 },
    );
  } catch (cause) {
    // The probe writes partial measurements before it exits non-zero, so the
    // JSON's own `error` is the useful message; the spawn failure is not.
    if (!existsSync(out)) throw cause;
  }
  probe = JSON.parse(readFileSync(out, 'utf8')) as ProbeResult;
}, 180_000);

afterAll(async () => {
  await server?.close();
});

/** The probe's answer, or a failure that says the probe never ran. */
function measured(): ProbeResult {
  if (probe === undefined) throw new Error('the layout probe produced no measurements');
  if (probe.error !== undefined) throw new Error(`the layout probe failed: ${probe.error}`);
  return probe;
}

const atWidth = (width: number): WidthRecord => {
  const record = measured().widths[String(width)];
  if (record === undefined) throw new Error(`the probe did not visit ${width}px`);
  return record;
};

describe('the layout probe itself', () => {
  it('has a gate that can tell "no Electron" from "Electron is broken"', () => {
    const never = (): never => {
      throw new Error('no such module');
    };
    expect(resolveElectron(never, () => true)).toBeUndefined();
    expect(resolveElectron(() => 42, () => true)).toBeUndefined();
    expect(resolveElectron(() => '', () => true)).toBeUndefined();
    // Present in the package but missing on disk is NOT "no Electron here":
    // it is a broken install, and it must not read as a clean skip either.
    expect(resolveElectron(() => '/nope/Electron', () => false)).toBeUndefined();
    expect(resolveElectron(() => '/bin/Electron', () => true)).toBe('/bin/Electron');
  });

  it('is installed on this machine, so the rest of this file is not skipped', () => {
    // If this ever fails, every assertion below has been skipped and the CSS
    // in this repo has no engine checking it at all.
    expect(ELECTRON, 'Electron is not installed; the engine suite cannot run').toBeTypeOf(
      'string',
    );
  });
});

describe.skipIf(ELECTRON === undefined)('the session list is reachable', () => {
  it('seeded the whole list rather than a screenful', () => {
    expect(measured().seeded).toBe(CHATS);
    expect(atWidth(WIDE).geometry.rows).toBe(CHATS);
  });

  it('renders the app without a console error', () => {
    expect(measured().consoleErrors).toEqual([]);
  });

  for (const width of [WORKBENCH_TIER, WIDE]) {
    it(`lets the ${CHATS}th chat be scrolled to and clicked in the column at ${width}px`, () => {
      /*
       * THE CRITICAL DEFECT, AND THE ONLY TEST THAT COULD HAVE SEEN IT.
       *
       * Shipped behaviour: `scrollHeight === clientHeight`, so there was
       * nothing to scroll; the rows past the fold were laid out anyway — the
       * 191st sat at y=14016 in a box 617px tall — and `.card--flush`'s
       * `overflow: hidden` cut them off. Nine to eleven chats were reachable
       * and the rest were not reachable by mouse, touch or keyboard.
       *
       * Three assertions rather than one, because each is true in a case where
       * the user still cannot get there: a container can overflow and not
       * scroll, a row can be inside the box and covered by something, and a
       * row can be hittable at a point that is not in the row.
       */
      const { column } = atWidth(width);
      expect(column.present).toBe(true);
      expect(column.rows).toBe(CHATS);
      expect(column.overflows, 'the column has nothing to scroll').toBe(true);
      expect(column.scrolls, 'the column did not move when scrolled to its end').toBe(true);
      expect(column.scrollHeight).toBeGreaterThan(column.clientHeight * 10);
      expect(column.withinViewport, 'the column hangs outside the window').toBe(true);
      // The LAST chat by name, so "reachable" cannot be satisfied by a
      // truncated list that happens to scroll.
      expect(column.lastTitle).toBe('Seeded chat 1');
      expect(column.lastVisible, 'the last row is outside the scrolled box').toBe(true);
      expect(column.lastHit, `a click at the last row landed on ${column.hitTag}`).toBe(true);
    });
  }

  for (const width of [NARROW, BELOW_TIER]) {
    it(`lets the ${CHATS}th chat be reached in the sheet at ${width}px`, () => {
      // Below the tier the sheet is the ONLY route to the list, so a clipped
      // sheet is the same defect wearing a different container. Opened the way
      // a user opens it — the rail's button — not by setting state.
      const { sheet, geometry } = atWidth(width);
      expect(geometry.historyToggleShown, 'there is no way to open the list here').toBe(true);
      expect(sheet, 'the sheet never opened').toBeDefined();
      expect(sheet?.rows).toBe(CHATS);
      expect(sheet?.overflows).toBe(true);
      expect(sheet?.scrolls).toBe(true);
      expect(sheet?.lastTitle).toBe('Seeded chat 1');
      expect(sheet?.lastVisible).toBe(true);
      expect(sheet?.lastHit, `a click at the last row landed on ${sheet?.hitTag}`).toBe(true);
    });
  }

  it('keeps the sheet inside the window it is drawn over', () => {
    const { sheetBox } = atWidth(NARROW);
    expect(sheetBox).toBeDefined();
    expect(sheetBox!.bottom).toBeLessThanOrEqual(sheetBox!.viewport + 1);
    expect(sheetBox!.top).toBeGreaterThanOrEqual(0);
  });

  it('hides the column entirely below the tier rather than zero-sizing it', () => {
    // A 0px column full of focusable rows would be reachable by Tab and
    // invisible, which is worse than either.
    const below = atWidth(WORKBENCH_TIER - 1);
    expect(below.geometry.history?.display).toBe('none');
    expect(below.geometry.history?.width).toBe(0);
    expect(below.geometry.historyToggleShown).toBe(true);
  });
});

describe.skipIf(ELECTRON === undefined)('the workbench is three real columns', () => {
  it('is a nav rail, a session column and a chat pane at 1440', () => {
    const { rail, history, chatMain, viewport } = atWidth(WIDE).geometry;
    expect(viewport.width).toBe(WIDE);
    expect(rail?.width).toBe(tokenAt('--rail-w', WIDE));
    expect(history?.width).toBe(tokenAt('--history-w', WIDE));
    expect(chatMain?.width).toBe(WIDE - (rail?.width ?? 0) - (history?.width ?? 0));
    // Side by side, not stacked.
    expect(history?.left).toBe(rail?.width);
    expect(chatMain?.left).toBe((rail?.width ?? 0) + (history?.width ?? 0));
  });

  it('centres the reading measure inside the chat pane', () => {
    const { measure, chatMain } = atWidth(WIDE).geometry;
    expect(measure).toBeGreaterThan(0);
    expect(measure!).toBeLessThan(chatMain!.width);
  });

  it('scrolls nothing sideways, scanned box by box', () => {
    // NOT `body.scrollWidth <= body.clientWidth`, which is VACUOUS here:
    // `.app` sets `overflow: hidden`, so the body cannot report a scroll width
    // larger than its client width whatever is inside it. That assertion
    // passed on every layout it was ever run against, including broken ones.
    for (const width of Object.keys(measured().widths)) {
      expect(measured().widths[width]!.overflowing, `boxes wider than ${width}px`).toEqual([]);
    }
  });
});

describe.skipIf(ELECTRON === undefined)('the reading measure never narrows', () => {
  it('measures both faces rather than assuming a ratio', () => {
    const { withArchivo, fallback, archivoResident } = measured().fonts;
    expect(archivoResident, 'the web font did not load; the run proves less').toBe(true);
    expect(withArchivo.ch).toBeGreaterThan(0);
    // The fallback face IS wider. If it ever stops being, the tier is sized
    // against the wrong end and the whole argument in tokens.css is backwards.
    expect(fallback.ch).toBeGreaterThan(withArchivo.ch);
  });

  it('opens the third column only where all three already fit, in the WIDER face', () => {
    /*
     * DEFECT 2, AS ARITHMETIC AGAINST A LIVE MEASUREMENT.
     *
     * The tier was 1184, sized against an assumed 0.60em digit that put 66ch
     * at ~594px. The digit was never measured. It is measured here, in the
     * face that actually renders when Archivo is absent — offline, on the
     * first paint of a cold load, and for anyone who blocks web fonts — and if
     * the sum exceeds the tier the reading column narrows as the window
     * crosses it.
     */
    const { fallback } = measured().fonts;
    const measure = 66 * fallback.ch;
    const needed =
      tokenAt('--rail-w', WORKBENCH_TIER) +
      tokenAt('--history-w', WORKBENCH_TIER) +
      measure +
      2 * tokenAt('--pad-screen', WORKBENCH_TIER);
    expect(
      needed,
      `the workbench tier is ${WORKBENCH_TIER} but needs ${needed.toFixed(2)} in the fallback face`,
    ).toBeLessThanOrEqual(WORKBENCH_TIER);
  });

  it('never gets smaller as the window gets bigger, in either face', () => {
    // The ladder's one promise, measured rather than computed. The static
    // suite checks the same thing from the sheet; this checks the box.
    for (const face of ['declared', 'fallback'] as const) {
      const measures = measured().sweep[face];
      const widths = Object.keys(measures)
        .map(Number)
        .sort((a, b) => a - b);
      let previous = -Infinity;
      for (const width of widths) {
        const value = measures[String(width)];
        expect(value, `no thread to measure at ${width}px`).not.toBeNull();
        expect(
          value!,
          `the reading measure narrowed at ${width}px (${face}): ${previous} -> ${value}`,
        ).toBeGreaterThanOrEqual(previous);
        previous = value!;
      }
    }
  });

  it('spends only the gutter: the measure is identical either side of the tier', () => {
    // The tier's actual promise, at the boundary, in the face that decides it.
    const measures = measured().sweep.fallback;
    const below = measures[String(WORKBENCH_TIER - 1)];
    const at = measures[String(WORKBENCH_TIER)];
    expect(below).not.toBeNull();
    expect(at).toBeCloseTo(below!, 1);
  });
});

describe.skipIf(ELECTRON === undefined)('the numbers the comments claim', () => {
  it('gives the session row the character budget the column is sized for', () => {
    /*
     * DEFECT 9b. tokens.css claimed "the remaining 176px carries ~23
     * characters", from a sum that counted `.list__item`'s padding, its gaps
     * and its two icon buttons and stopped there — omitting `.history__body`'s
     * 12px of padding each side, the card's two 1px borders, `.history`'s own
     * right border, and the scrollbar that appears precisely when the list is
     * long enough to be worth having a column for.
     */
    const row = atWidth(WORKBENCH_TIER).geometry.historyRow;
    expect(row).not.toBeNull();
    expect(row!.columnWidth).toBe(tokenAt('--history-w', WORKBENCH_TIER));
    expect(row!.bodyPaddingInline).toBe(24);
    // A floor, not an equality: a platform with a wider scrollbar reports
    // less, and the budget has to survive that rather than describe this Mac.
    expect(row!.titleWidth).toBeLessThanOrEqual(158);
    expect(row!.titleWidth).toBeGreaterThanOrEqual(140);

    const characters = row!.titleWidth / measured().fonts.withArchivo.advance;
    expect(characters).toBeGreaterThanOrEqual(20);
    // And the old claim is false, which is the finding: 23 characters was
    // never available in this column.
    expect(characters).toBeLessThan(23);
  });

  it('counts 66ch in prose characters rather than in zeroes', () => {
    // DEFECT 9a. tokens.css said "66ch is roughly 64 rendered characters".
    // The digit is WIDER than the average letter, not narrower, so the true
    // figure is about 85 — a third more, and the difference between "the
    // measure is too wide" and "the measure is right".
    const { withArchivo } = measured().fonts;
    const characters = (66 * withArchivo.ch) / withArchivo.advance;
    expect(characters).toBeGreaterThan(80);
    expect(characters).toBeLessThan(90);
    // Which is inside the band typography asks for, and 64 would not have been
    // a reason to leave the measure alone.
    expect(characters).toBeLessThanOrEqual(90);
    expect(withArchivo.advance).toBeLessThan(withArchivo.ch);
  });

  it('fits the first-run placeholder in the field it is shown in, on a phone', () => {
    /*
     * DEFECT 9c. "Install a model or connect a provider first" measured 265px
     * in a field offering 245px at 390px of viewport. A placeholder that does
     * not fit does not ellipsize — it wraps — and the field is 38px tall with
     * a 21.6px line box, so the second line was cut in half. It is the one
     * sentence a brand-new user is guaranteed to read.
     */
    const { placeholder } = atWidth(NARROW);
    expect(placeholder.present).toBe(true);
    expect(
      placeholder.fits,
      `"${placeholder.placeholder}" is ${placeholder.textWidth.toFixed(0)}px in ${placeholder.room}px`,
    ).toBe(true);
    // One line, with the field tall enough for it. Two lines do not fit and
    // are not allowed to be the plan.
    expect(placeholder.fieldHeight).toBeLessThan(2 * placeholder.lineHeight);
    // Room for a face wider than the one that rendered: the fallback runs
    // about 5% wider than Archivo, and this is measured in whichever loaded.
    expect(placeholder.textWidth * 1.1).toBeLessThanOrEqual(placeholder.room);
  });
});
