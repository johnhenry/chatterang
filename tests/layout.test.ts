import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  declaredValue,
  parseRules,
  rootProperties,
  substitute,
  thresholds,
  toPx,
  type Viewport,
} from './support/css';

// `import.meta.url` is an http URL under the jsdom transform, so resolve from
// the project root instead.
const read = (relative: string): string => readFileSync(resolve(process.cwd(), relative), 'utf8');
const css = read('src/styles/components.css');
const tokens = read('src/styles/tokens.css');
const base = read('src/styles/base.css');

/** Cascade order, as `main.tsx` imports them. */
const SHEETS = [tokens, base, css] as const;

/**
 * The declaration block for a top-level rule, as written.
 *
 * Anchored to the start of a line so `.rail` does not match inside a compound
 * selector like `.app:has(.banner) .rail`.
 */
function block(selector: string): string {
  const marker = `\n${selector} {`;
  const index = css.indexOf(marker);
  if (index === -1) throw new Error(`No top-level rule found for "${selector}"`);
  return css.slice(index + 1, css.indexOf('}', index));
}

/**
 * `1ch` in pixels at `--t-base`.
 *
 * `ch` is the advance of "0" in the font that actually rendered, so it is a
 * RANGE rather than a number. Every width computed below is checked at both
 * ends, because a ladder that only holds once the web font is resident is a
 * ladder that breaks on every cold load.
 *
 * BOTH NUMBERS ARE MEASURED NOW, AND THE UPPER ONE WAS WRONG. It was 0.60,
 * assumed rather than measured; the real fallback face resolves `1ch` to
 * 9.4482px at 15px, which is 0.6299em. That is 30px of reading column, and it
 * is exactly what put the workbench tier 24px too low and made the text
 * column NARROW as the window crossed it. The live measurement is in
 * tests/layout-engine.test.ts, which asserts the tier against whatever the
 * running engine reports; these two are the design's written-down assumption,
 * and the engine test is what stops them drifting from the truth again.
 */
const CH_RATIOS = { archivo: 0.5727, widestFallback: 0.6299 } as const;
const BASE_FONT_PX = 15;
const lengths = (ratio: number) => ({ rem: 16, ch: ratio * BASE_FONT_PX });

const at = (width: number, finePointer = false): Viewport => ({ width, finePointer });

/** A token's value in px at a viewport. */
function token(name: string, viewport: Viewport, ratio: number = CH_RATIOS.archivo): number {
  return toPx(substitute(`var(${name})`, rootProperties(SHEETS, viewport)), lengths(ratio));
}

/** A property's value in px on a rule written with exactly `selector`. */
function computed(selector: string, property: string, viewport: Viewport, ratio: number = CH_RATIOS.archivo): number {
  const declared = declaredValue(SHEETS, selector, property, viewport);
  if (declared === undefined) throw new Error(`${selector} declares no ${property}`);
  return toPx(substitute(declared, rootProperties(SHEETS, viewport)), lengths(ratio));
}

/**
 * The threshold at which the shell becomes `rail | body`.
 *
 * Derived from the sheet rather than written down here: the whole point of
 * parsing is that retuning the ladder is not supposed to fail a test whose
 * subject is not the number.
 */
const RAIL_TIER = (() => {
  for (const threshold of thresholds(css)) {
    const columns = declaredValue([css], '.app', 'grid-template-columns', at(threshold));
    if (columns?.includes('--rail-w')) return threshold;
  }
  throw new Error('no tier gives .app a rail column');
})();

/** The threshold at which the session list stops being a modal. */
const WORKBENCH_TIER = (() => {
  for (const threshold of thresholds(tokens)) {
    if (token('--history-w', at(threshold)) > 0) return threshold;
  }
  throw new Error('no tier gives the session list a width');
})();

/**
 * Guards the app shell's grid.
 *
 * The shell had a real bug: rows were assigned by auto-placement, so when the
 * banner was not rendered every child shifted up a row and the tab bar
 * inherited the `1fr` row — growing to 422px on a short screen. Named areas
 * fix it, and these assertions keep it fixed, because the failure only shows
 * up in a browser at a particular child count and is easy to reintroduce.
 */
describe('app shell grid', () => {
  const shell = block('.app');

  it('places children by name, not by document order', () => {
    expect(shell).toContain('grid-template-areas');
    expect(shell).toMatch(/'banner'\s*'rail'\s*'body'\s*'nav'/);
  });

  it('assigns every shell child an explicit area', () => {
    // Anything in the grid without an area is auto-placed, which is exactly
    // how the bug got in.
    for (const [selector, area] of [
      ['.banner', 'banner'],
      ['.rail', 'rail'],
      ['.app__body', 'body'],
      ['.tabbar', 'nav'],
    ] as const) {
      expect(block(selector)).toContain(`grid-area: ${area}`);
    }
  });

  it('gives the body the only flexible row', () => {
    expect(shell).toContain('grid-template-rows: auto auto 1fr auto');
  });

  it('keeps the tab bar at its content height even if handed extra space', () => {
    expect(block('.tabbar')).toContain('align-content: start');
  });

  it('constrains the column so one wide child cannot widen the app', () => {
    // The other half of the same class of bug: grid items default to a
    // minimum of their content width.
    expect(shell).toContain('grid-template-columns: minmax(0, 1fr)');
  });
});

describe('wide-screen shell', () => {
  it('re-lays the same named areas rather than reordering children', () => {
    // Asserted against the RAIL tier specifically, not "the widest block".
    // A7 added a third tier above it, and a test that reached for the last
    // media query in the file would have started asserting the rail's areas
    // against a block that has nothing to do with the rail.
    const areas = declaredValue([css], '.app', 'grid-template-areas', at(RAIL_TIER));
    expect(areas).toMatch(/'nav banner'\s*'nav rail'\s*'nav body'/);
  });

  it('opens the rail wide enough that the reading column never narrows', () => {
    // The ladder's one arithmetic constraint. When the rail appears at
    // breakpoint B and takes --rail-w, the body column becomes B - rail. If
    // that is less than the medium tier's content cap, crossing the breakpoint
    // makes the reading column *narrower* — which is what the 860px rail did
    // against a 760px cap that only existed above it.
    const rail = token('--rail-w', at(RAIL_TIER));
    const mediumCap = token('--content-wide', at(RAIL_TIER - 1));
    expect(rail).toBe(232);
    expect(mediumCap).toBe(680);
    expect(RAIL_TIER).toBeGreaterThanOrEqual(rail + mediumCap);
  });
});

/**
 * The workbench tier: the session list as a grid slot rather than a modal.
 *
 * Everything here is COMPUTED at a real width — the media queries evaluated,
 * the `var()` graph resolved, the `calc()` reduced to pixels — because the
 * failure this file is guarding against is a rule that exists and never
 * applies. `expect(css).toContain('.history')` would pass on a sheet whose
 * every history rule sat behind `@media (min-width: 99999px)`.
 */
describe('the workbench tier', () => {
  /** How wide the app's body column is at a viewport, in px. */
  const bodyWidth = (width: number): number =>
    width - (width >= RAIL_TIER ? token('--rail-w', at(width)) : 0);

  /** How wide the TEXT of the thread is: the cap, or the room, whichever is less. */
  const readingWidth = (width: number, ratio: number): number => {
    const viewport = at(width);
    const cap = computed('.thread', 'max-width', viewport, ratio);
    const pad = token('--pad-screen', viewport, ratio);
    const column = bodyWidth(width) - token('--history-w', viewport, ratio);
    return Math.max(0, Math.min(cap, column) - 2 * pad);
  };

  it('is a real threshold in both sheets, and the same one', () => {
    // Two files name this tier: tokens.css gives the column its width, and
    // components.css turns it on. They are the same number or the column is
    // 304px wide and invisible, or 0px wide and displayed.
    const shown = thresholds(css).find(
      (threshold) => declaredValue([css], '.history', 'display', at(threshold)) === 'flex',
    );
    expect(WORKBENCH_TIER).toBe(shown);
    expect(WORKBENCH_TIER).toBeGreaterThan(RAIL_TIER);
  });

  it('holds nothing focusable below the tier', () => {
    // The column is always mounted — which container the list is in is a CSS
    // question — so below the tier it must be `display: none` rather than a
    // zero-width box with tabbable buttons inside it.
    expect(declaredValue([css], '.history', 'display', at(WORKBENCH_TIER - 1))).toBe('none');
    expect(token('--history-w', at(WORKBENCH_TIER - 1))).toBe(0);
  });

  it('bounds the chat body\'s grid row instead of letting it size to content', () => {
    /*
     * A SHAPE ASSERTION, AND THE ONLY HONEST PLACE FOR ONE.
     *
     * `.app__body--split` declares `grid-template-areas` and
     * `grid-template-columns`; its single row was implicit and therefore
     * `auto`. Reverting the explicit row TODAY changes nothing measurable —
     * driven with 200 chats in a real engine at 1208 and 1440, the column
     * still scrolls — because both children carry `min-height: 0` and so
     * contribute nothing to an auto row's minimum. It is redundant, and it is
     * redundant with a rule in a different block.
     *
     * What it actually guards was measured too: with this row removed AND
     * `.history`'s `min-height: 0` removed, the column stops scrolling and the
     * 200th chat becomes unreachable; with the row present and that
     * `min-height` gone, it holds. So the assertion is here, as shape, rather
     * than in the engine suite as behaviour — because the behaviour it
     * protects is a second failure away, and a test that can only see the
     * second failure would let the first one back in.
     */
    const block = declaredValue(SHEETS, '.app__body--split', 'grid-template-rows', at(1440));
    expect(block).toBe('minmax(0, 1fr)');
  });

  it('gives the chat body a real second column at the tier and none below it', () => {
    const columns = (width: number): string =>
      substitute(
        declaredValue(SHEETS, '.app__body--split', 'grid-template-columns', at(width)) ?? '',
        rootProperties(SHEETS, at(width)),
      );
    expect(columns(WORKBENCH_TIER)).toBe('304px minmax(0, 1fr)');
    expect(columns(WORKBENCH_TIER - 1)).toBe('0px minmax(0, 1fr)');
  });

  it('opens only where all three columns already fit, in either font', () => {
    // The same constraint the rail tier answers, one column later: rail +
    // history + the full measure must fit, or the reading column NARROWS as
    // the window widens. Checked at both ends of the `ch` range because the
    // measure is 66ch and `ch` is whatever font actually rendered.
    //
    // THIS IS THE ASSERTION THAT SHOULD HAVE CAUGHT THE 1184 TIER AND DID NOT.
    // It was already the right shape; it was fed a fallback ratio of 0.60 that
    // nobody had measured, and at 0.60 a 1184 tier fits with 30px to spare. At
    // the measured 0.6299 it does not fit at all.
    for (const ratio of Object.values(CH_RATIOS)) {
      const viewport = at(WORKBENCH_TIER);
      const needed =
        token('--rail-w', viewport, ratio) +
        token('--history-w', viewport, ratio) +
        computed('.thread', 'max-width', viewport, ratio);
      expect(needed, `ch ratio ${ratio}`).toBeLessThanOrEqual(WORKBENCH_TIER);
    }
  });

  it('never narrows the reading column as the window widens', () => {
    // The invariant the whole ladder exists for, computed rather than argued.
    // Every threshold is swept at its own boundary, so a tier that steals from
    // the measure fails here whatever the number is.
    //
    // Swept from the medium tier upward. Below it there is a 13px band where
    // the column does narrow, which is NOT this milestone's and is measured
    // exactly in the test below rather than hidden by starting the sweep here.
    const medium = thresholds(tokens)[0]!;
    const widths = [medium, medium + 1, 613, 640, 767, 919, 920, 921, 1024];
    for (const threshold of [...thresholds(tokens), ...thresholds(css)]) {
      if (threshold <= medium) continue;
      widths.push(threshold - 1, threshold, threshold + 1);
    }
    widths.push(1440, 1680, 1920, 2560);
    widths.sort((a, b) => a - b);

    for (const ratio of Object.values(CH_RATIOS)) {
      let previous = -Infinity;
      for (const width of widths) {
        const reading = readingWidth(width, ratio);
        expect(
          reading,
          `reading column narrowed at ${width}px (ch ${ratio}): ${previous} -> ${reading}`,
        ).toBeGreaterThanOrEqual(previous);
        previous = reading;
      }
    }
  });

  it('records the one place the ladder still narrows, which A7 did not add', () => {
    /*
     * A FINDING, not an exemption. The sweep above starts at the medium tier
     * because crossing INTO it costs measure, and writing that down with its
     * exact magnitude is the only honest alternative to a sweep that quietly
     * skips it.
     *
     * At 599px the thread is capped at `--measure + 2 × --s-4` and the text is
     * the full 66ch. At 600px `--pad-screen` steps from --s-4 to --s-5, so the
     * cap grows by 16px while the VIEWPORT has not — the thread is now
     * viewport-bound, and the extra padding comes straight out of the text.
     * The column recovers as soon as the window reaches the new cap.
     *
     * It is the same shape as the defect the 920 tier was created to fix, one
     * tier down and an order of magnitude smaller, and fixing it means moving
     * the 600px breakpoint — which is a tablet-portrait width that this
     * milestone has no way to check. Left alone, measured, and bounded: if it
     * grows, this fails.
     */
    const medium = thresholds(tokens)[0]!;
    expect(medium).toBe(600);

    // 14.97px, not the 12.3px that used to be written here. The magnitude did
    // not change; the `ch` ratio it is computed from did, from an assumed 0.57
    // to a measured 0.5727. Restating it is the point of the assertion.
    const before = readingWidth(medium - 1, CH_RATIOS.archivo);
    const worst = readingWidth(medium, CH_RATIOS.archivo);
    expect(before - worst).toBeCloseTo(14.97, 1);

    // And it is a band, not a cliff: find where it recovers and hold that.
    let recovered = medium;
    while (readingWidth(recovered, CH_RATIOS.archivo) < before && recovered < medium + 200) {
      recovered += 1;
    }
    expect(recovered - medium).toBe(15);
  });

  it('spends only the gutter: the reading column is identical either side', () => {
    // The tier's actual promise. Below it the thread is capped with dead space
    // around it; above it the thread is the same width and the dead space is
    // the session list.
    for (const ratio of Object.values(CH_RATIOS)) {
      expect(readingWidth(WORKBENCH_TIER, ratio)).toBe(readingWidth(WORKBENCH_TIER - 1, ratio));
    }
  });

  it('gives the session column enough width for the row it has to hold', () => {
    /*
     * THE DERIVATION, WITH THE THREE THINGS IT USED TO LEAVE OUT.
     *
     * A row is [title + preview][pin][delete], and the old sum counted
     * `.list__item`'s padding, its two gaps and its two icon buttons — and
     * stopped. It omitted `.history__body`'s 12px of padding on each side and
     * the card's two 1px borders, and so claimed 176px for the title where
     * there are 146. It then divided by the advance of "0" and called the
     * answer characters, which the width of a digit is not.
     *
     * TWO MORE ARE STILL MISSING HERE AND CANNOT BE ADDED. `.history`'s own
     * 1px right border is on a different element than this sum walks, and —
     * once the list is long enough to scroll, which is the entire reason the
     * column exists — the scrollbar takes its own width out of the same
     * budget. No static reading of a stylesheet knows how wide a scrollbar is.
     * So this arrives at 158 and the engine measures 146 with 200 chats in it,
     * and the 12px between them is those two. The measurement is in
     * tests/layout-engine.test.ts, which is the assertion this one defers to.
     */
    const viewport = at(WORKBENCH_TIER, true);
    const props = rootProperties(SHEETS, viewport);
    const px = (value: string): number => toPx(substitute(value, props), lengths(CH_RATIOS.archivo));
    const inline = (selector: string): number => {
      const padding = declaredValue(SHEETS, selector, 'padding', viewport) ?? '';
      const parts = padding.trim().split(/\s+/);
      return px(parts[1] ?? parts[0] ?? '0');
    };
    const gap = px(declaredValue(SHEETS, '.list__item', 'gap', viewport) ?? '0');
    const iconButton = token('--icon-btn', viewport);
    const hairline = px(declaredValue(SHEETS, '.card', 'border', viewport)?.split(/\s+/)[0] ?? '0');

    const chrome =
      2 * inline('.history__body') +
      2 * hairline +
      2 * inline('.list__item') +
      2 * gap +
      2 * iconButton;
    const forTitle = token('--history-w', viewport) - chrome;
    expect(forTitle).toBe(158);

    /*
     * CHARACTERS ARE COUNTED WITH THE PROSE ADVANCE, NOT WITH `ch`.
     *
     * Archivo's "0" is 8.59px and its average prose advance is 6.637px — the
     * digit is 29% wider than the average letter — so dividing a title box by
     * `ch` undercounts by a third. Both are measured in the engine test; this
     * uses the ratio it reports.
     */
    const proseAdvance = 6.637;
    // ~20 characters at --t-base is where two chats opened from similar
    // prompts stop looking identical in the list. Checked against the number
    // the engine actually measures, not against this one, so the two things
    // the sum cannot see are inside the budget rather than outside it.
    const measuredWithScrollbar = 146;
    expect(forTitle).toBeGreaterThanOrEqual(measuredWithScrollbar);
    expect(measuredWithScrollbar / proseAdvance).toBeGreaterThanOrEqual(20);
  });

  it('has no button padding silently eating the row', () => {
    // `.list__main` is a <div> in SettingRow and a <button> in ChatList, and
    // base.css resets a button's font, colour, background and border but not
    // its PADDING — so Chrome's UA `padding: 1px 6px` survived on one of the
    // two and the same row was 12px narrower on one screen than the other.
    expect(block('.list__main')).toContain('padding: 0');
  });
});

/**
 * The density axis.
 *
 * `--tap` is a touch minimum and must not govern a mouse-driven window; WCAG
 * 2.5.8 (AA) still wants 24px for any pointer target. Both halves are asserted
 * here, at resolved pixel values, because the whole axis is custom properties
 * resolving through a media query and a rule that merely EXISTS proves nothing.
 */
describe('density', () => {
  const CONTROL_TOKENS = [
    '--ctl-row',
    '--ctl-rail',
    '--ctl-lg',
    '--ctl',
    '--icon-btn',
    '--ctl-sm',
    '--ctl-xs',
  ] as const;

  /** WCAG 2.5.8 Target Size (Minimum), AA. */
  const WCAG_MINIMUM = 24;
  /** The floor this design uses, above the legal one. See tokens.css. */
  const FLOOR = 28;

  it('keeps the touch minimum at 44px whatever the window is doing', () => {
    for (const width of [375, 920, 1440, 2560]) {
      expect(token('--tap', at(width, false))).toBe(44);
    }
  });

  it('shrinks every control token for a fine pointer, and only then', () => {
    for (const name of CONTROL_TOKENS) {
      const coarse = token(name, at(1440, false));
      const fine = token(name, at(1440, true));
      expect(fine, `${name} did not compact for a mouse`).toBeLessThan(coarse);
    }
  });

  it('never drops a control below the floor, at any width or pointer', () => {
    for (const finePointer of [false, true]) {
      for (const width of [320, 600, 920, 1184, 1920]) {
        for (const name of CONTROL_TOKENS) {
          const height = token(name, at(width, finePointer));
          expect(height, `${name} at ${width}px fine=${finePointer}`).toBeGreaterThanOrEqual(FLOOR);
          expect(height).toBeGreaterThanOrEqual(WCAG_MINIMUM);
        }
      }
    }
  });

  it('is driven by the pointer and not by the viewport', () => {
    // A 400px Electron window with a mouse is compact; a 1400px touchscreen is
    // not. If any control token responded to width, the axis would be a
    // disguised platform check.
    for (const name of CONTROL_TOKENS) {
      const narrow = token(name, at(360, true));
      const wide = token(name, at(2560, true));
      expect(wide, name).toBe(narrow);
    }
  });

  it('leaves NO pixel height in the component sheet as a bare number', () => {
    /*
     * ZERO OFFENDERS, NOT A LIST OF THEM.
     *
     * This started at 26 bare pixel heights, was cut to 16, and the check that
     * guarded the remainder only looked at 24-64px — the band a pointer target
     * occupies. That let `.slider` sit at 22px and its thumb at 18px, both of
     * them real drag targets, both under WCAG 2.5.8's 24px floor, and both
     * invisible to this test BY CONSTRUCTION. A window that excludes the
     * failures it is looking for is not a check.
     *
     * So: every height and width in the sheet resolves through a token. The
     * distinction the density axis is FOR is made in tokens.css instead —
     * `--ctl-*` for anything a pointer lands on, `--g-*` for marks, tracks,
     * grips and thumbnails, which are the same size for a finger and a mouse
     * because they are drawings rather than targets.
     */
    const offenders: string[] = [];
    for (const rule of parseRules(css)) {
      for (const property of ['height', 'min-height', 'max-height', 'width'] as const) {
        const value = rule.decls.get(property);
        if (/^\d+(?:\.\d+)?px$/.test(value ?? '')) {
          offenders.push(`${rule.selectors.join(', ')} { ${property}: ${value} }`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('keeps the slider thumb at WCAG 2.5.8 for both pointers', () => {
    // The two heights the old 24-64px window could not see. A slider thumb is
    // a drag target; 18px failed the standard for every pointer there is.
    for (const finePointer of [false, true]) {
      const thumb = token('--ctl-thumb', at(1440, finePointer));
      expect(thumb, `thumb at fine=${finePointer}`).toBeGreaterThanOrEqual(WCAG_MINIMUM);
    }
    // And it is on the axis: a finger gets more of it than a cursor does.
    expect(token('--ctl-thumb', at(1440, false))).toBeGreaterThan(
      token('--ctl-thumb', at(1440, true)),
    );
    // The input's own box is the thumb's box, so the drag target cannot drift
    // away from the element that receives the drag.
    expect(block('.slider')).toContain('height: var(--ctl-thumb)');
  });

  it('keeps the graphic scale OUT of the density axis, on purpose', () => {
    // A 2px rule is 2px for a finger and for a mouse. If these ever started
    // responding to the pointer, the drawings would change size for no gain.
    for (const name of ['--g-hair', '--g-track', '--g-dot', '--g-thumbnail'] as const) {
      expect(token(name, at(1440, false)), name).toBe(token(name, at(1440, true)));
    }
  });

  it('keeps the 16px text-entry floor out of the density axis', () => {
    // --t-control is the anti-zoom floor, not a control height. If density
    // ever reached it, iOS would start zooming on focus again.
    for (const finePointer of [false, true]) {
      expect(
        substitute('var(--t-control)', rootProperties(SHEETS, at(1440, finePointer))),
      ).toBe('1rem');
    }
  });
});

/**
 * Accessibility invariants that a layout change is well placed to break.
 */
describe('accessibility floors survive the new tier', () => {
  it('keeps a visible focus ring rather than removing the outline globally', () => {
    const outline = declaredValue([base], ':focus-visible', 'outline', at(1440));
    expect(outline).toBeDefined();
    expect(outline).not.toBe('none');
    expect(outline).toContain('2px');
  });

  it('still answers prefers-reduced-motion', () => {
    const reduced = parseRules(base).some(
      (rule) =>
        rule.media.some((condition) => condition.includes('prefers-reduced-motion')) &&
        rule.decls.get('animation-duration')?.includes('!important'),
    );
    expect(reduced).toBe(true);
  });

  it('gives the session column a name a screen reader can announce', () => {
    const screen = read('src/features/chat/ChatScreen.tsx');
    expect(screen).toContain('<aside className="history" aria-label="Chats">');
  });
});

/**
 * Pinch-zoom, and the reason it was disabled.
 *
 * The viewport carried `maximum-scale=1.0, user-scalable=no`, which fails
 * WCAG 1.4.4 (Resize Text) outright — and iOS Safari has ignored it since 10
 * anyway, so it bought nothing on the platform it was presumably added for.
 *
 * The real motivation for that flag is always the same: iOS zooms the viewport
 * when a focused form control computes below 16px. The fix is the floor, not
 * the lock. These two assertions are a pair — remove the floor and someone will
 * reintroduce the lock to stop the zooming.
 */
describe('viewport and text-entry controls', () => {
  const html = read('index.html');

  it('does not disable pinch-zoom', () => {
    const viewport = html.match(/name="viewport"[\s\S]*?content="([^"]*)"/)?.[1] ?? '';
    expect(viewport).not.toMatch(/user-scalable\s*=\s*no/);
    expect(viewport).not.toMatch(/maximum-scale/);
  });

  it('keeps viewport-fit=cover, which the safe-area insets depend on', () => {
    const viewport = html.match(/name="viewport"[\s\S]*?content="([^"]*)"/)?.[1] ?? '';
    expect(viewport).toContain('viewport-fit=cover');
  });

  it('floors text-entry controls at 16px so iOS does not zoom on focus', () => {
    expect(tokens).toMatch(/--t-control:\s*1rem/);
    // Every control that takes text must use it. A control left on the body
    // scale (15px) reintroduces the focus zoom this pair exists to prevent.
    for (const rule of ['.composer__input', '.term__field']) {
      const start = css.indexOf(`\n${rule} {`);
      expect(start, `${rule} not found`).toBeGreaterThan(-1);
      expect(css.slice(start, css.indexOf('}', start))).toContain('font-size: var(--t-control)');
    }
    // The shared .input/.textarea/.select rule.
    const shared = css.indexOf('\n.input,\n.textarea,\n.select {');
    expect(shared).toBeGreaterThan(-1);
    expect(css.slice(shared, css.indexOf('}', shared))).toContain('font-size: var(--t-control)');
  });
});
