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
 * RANGE rather than a number: Archivo's digit is ~0.57em and the rest of the
 * declared fallback stack runs to ~0.60em. Every width computed below is
 * checked at both ends, because a ladder that only holds once the web font is
 * resident is a ladder that breaks on every cold load.
 */
const CH_RATIOS = { archivo: 0.57, widestFallback: 0.6 } as const;
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

    const before = readingWidth(medium - 1, CH_RATIOS.archivo);
    const worst = readingWidth(medium, CH_RATIOS.archivo);
    expect(before - worst).toBeCloseTo(12.3, 1);

    // And it is a band, not a cliff: find where it recovers and hold that.
    let recovered = medium;
    while (readingWidth(recovered, CH_RATIOS.archivo) < before && recovered < medium + 200) {
      recovered += 1;
    }
    expect(recovered - medium).toBe(13);
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
    // The derivation in tokens.css, checked against the rule it is derived
    // from: a row is [title][pin][delete] inside .list__item's own padding and
    // gaps, and what is left over is the title.
    const viewport = at(WORKBENCH_TIER, true);
    const props = rootProperties(SHEETS, viewport);
    const padding = declaredValue(SHEETS, '.list__item', 'padding', viewport) ?? '';
    const inline = substitute(padding.trim().split(/\s+/)[1] ?? '', props);
    const gap = substitute(declaredValue(SHEETS, '.list__item', 'gap', viewport) ?? '', props);
    const iconButton = token('--icon-btn', viewport);

    const chrome = 2 * toPx(inline, lengths(0.57)) + 2 * toPx(gap, lengths(0.57)) + 2 * iconButton;
    const forTitle = token('--history-w', viewport) - chrome;
    // ~20 characters at --t-base is where two chats opened from similar
    // prompts stop looking identical in the list.
    expect(forTitle / (0.57 * BASE_FONT_PX)).toBeGreaterThanOrEqual(20);
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

  it('leaves no control height in the component sheet as a bare number', () => {
    // The 26 hardcoded pixel heights this milestone inherited. Anything left
    // in the range a pointer target occupies is a control that the density
    // axis cannot reach.
    const offenders: string[] = [];
    for (const rule of parseRules(css)) {
      for (const property of ['height', 'min-height'] as const) {
        const value = rule.decls.get(property);
        const literal = /^(\d+(?:\.\d+)?)px$/.exec(value ?? '');
        if (!literal) continue;
        const px = Number(literal[1]);
        if (px >= 24 && px <= 64) offenders.push(`${rule.selectors.join(', ')} { ${property}: ${value} }`);
      }
    }
    // `.attachment` (56px) is an image thumbnail, not a control: it is what a
    // pointer target sits ON TOP of, and scaling it with density would resize
    // the picture rather than the button.
    expect(offenders).toEqual(['.attachment { height: 56px }']);
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
