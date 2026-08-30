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
    const wide = css.slice(css.indexOf('@media (min-width: 860px)'));
    expect(wide).toMatch(/'nav banner'\s*'nav rail'\s*'nav body'/);
  });
});
