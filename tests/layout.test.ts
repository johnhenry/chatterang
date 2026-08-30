import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// `import.meta.url` is an http URL under the jsdom transform, so resolve from
// the project root instead.
const css = readFileSync(resolve(process.cwd(), 'src/styles/components.css'), 'utf8');

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
 * Every `@media (min-width: Npx)` threshold in the sheet, ascending.
 *
 * The wide-screen test used to slice from the literal string
 * `@media (min-width: 860px)`, which made retuning the ladder fail a test whose
 * subject is not the threshold. Parse instead, so the assertion is about what
 * the widest tier *does*, not where it starts.
 */
function thresholds(): number[] {
  return [...css.matchAll(/@media \(min-width:\s*(\d+)px\)/g)]
    .map((m) => Number(m[1]))
    .sort((a, b) => a - b);
}

/** The body of the widest `min-width` block. */
function widestBlock(): string {
  const widest = thresholds().at(-1);
  if (widest === undefined) throw new Error('No min-width media query found');
  return css.slice(css.indexOf(`@media (min-width: ${widest}px)`));
}

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
    expect(widestBlock()).toMatch(/'nav banner'\s*'nav rail'\s*'nav body'/);
  });

  it('opens the rail wide enough that the reading column never narrows', () => {
    // The ladder's one arithmetic constraint. When the rail appears at
    // breakpoint B and takes --rail-w, the body column becomes B - rail. If
    // that is less than the medium tier's content cap, crossing the breakpoint
    // makes the reading column *narrower* — which is what the 860px rail did
    // against a 760px cap that only existed above it.
    const rail = 232;
    const mediumCap = 680;
    expect(thresholds().at(-1)).toBeGreaterThanOrEqual(rail + mediumCap);
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
  const html = readFileSync(resolve(process.cwd(), 'index.html'), 'utf8');
  const tokens = readFileSync(resolve(process.cwd(), 'src/styles/tokens.css'), 'utf8');

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
