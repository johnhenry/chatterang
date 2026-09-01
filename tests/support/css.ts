/**
 * A small CSS resolver, so layout assertions are about VALUES rather than text.
 *
 * WHY THIS EXISTS. The failure mode this repo keeps re-learning is a harness
 * that lies, and a stylesheet test is unusually good at lying: `expect(css)
 * .toContain('.history')` passes whether or not the rule ever applies, whether
 * or not the custom property it reads resolves to anything, and whether or not
 * the media query that guards it can ever be true. Every one of those has to
 * be a real computation for the assertion to mean anything.
 *
 * WHAT IT DOES NOT DO, stated plainly rather than left to be discovered:
 *
 *   - It is not a layout engine. It resolves the CASCADE and the CUSTOM
 *     PROPERTY GRAPH at a given viewport and pointer type, and evaluates
 *     `calc()` to pixels. Box sizing, flex distribution, and what the browser
 *     actually paints are outside it; those were checked in a real browser and
 *     that check is not automated. See the note in tests/layout.test.ts.
 *   - Selector matching is EXACT TEXT, not specificity. Callers ask for a rule
 *     by the selector it is written with. Two rules that both match an element
 *     through different selectors are not merged. That is enough for a
 *     hand-written sheet and would not be enough for a generated one.
 *   - `ch` is approximated from a ratio the caller supplies, because `ch` is a
 *     property of the font file and there is no font here.
 *
 * jsdom cannot stand in for any of this: it evaluates no media query, resolves
 * no `var()`, and has no `matchMedia` at all. That was measured, not assumed —
 * a probe against jsdom 28 returned `width: "var(--w)"` and a `color` from
 * outside the media block at a 1024px viewport.
 */

/** Strip comments. Nothing in these sheets puts a comment marker in a string. */
function decomment(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '');
}

export interface Rule {
  /** The `@media` conditions this rule is nested under, outermost first. */
  readonly media: readonly string[];
  /** The selectors as written, comma-split and trimmed. */
  readonly selectors: readonly string[];
  readonly decls: ReadonlyMap<string, string>;
}

/** Index of the `}` matching the `{` at `open`. */
function closeOf(source: string, open: number): number {
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  throw new Error('unbalanced braces in stylesheet');
}

function parseDecls(body: string): Map<string, string> {
  const out = new Map<string, string>();
  let depth = 0;
  let start = 0;
  const flush = (end: number): void => {
    const text = body.slice(start, end).trim();
    start = end + 1;
    if (!text) return;
    const colon = text.indexOf(':');
    if (colon === -1) return;
    out.set(text.slice(0, colon).trim(), text.slice(colon + 1).trim());
  };
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (ch === '(') depth += 1;
    else if (ch === ')') depth -= 1;
    else if (ch === ';' && depth === 0) flush(i);
  }
  flush(body.length);
  return out;
}

/**
 * Flatten a stylesheet into rules, each carrying the media conditions it sits
 * under. `@keyframes` and other at-rules with their own grammar are skipped —
 * nothing here asserts on them, and pretending to parse them would be worse.
 */
export function parseRules(source: string): Rule[] {
  const out: Rule[] = [];
  const walk = (text: string, media: readonly string[]): void => {
    let i = 0;
    while (i < text.length) {
      const open = text.indexOf('{', i);
      if (open === -1) break;
      const prelude = text.slice(i, open).trim();
      const close = closeOf(text, open);
      const body = text.slice(open + 1, close);
      if (prelude.startsWith('@media')) {
        walk(body, [...media, prelude.slice('@media'.length).trim()]);
      } else if (!prelude.startsWith('@')) {
        out.push({
          media,
          selectors: prelude.split(',').map((s) => s.trim()).filter(Boolean),
          decls: parseDecls(body),
        });
      }
      i = close + 1;
    }
  };
  walk(decomment(source), []);
  return out;
}

/** The conditions a resolution is performed under. */
export interface Viewport {
  readonly width: number;
  /** `(pointer: fine)` — a mouse or trackpad as the PRIMARY pointing device. */
  readonly finePointer: boolean;
  readonly dark?: boolean;
  readonly reducedMotion?: boolean;
}

/**
 * Whether a media condition holds.
 *
 * THROWS on a feature it does not know. That is deliberate and is the
 * difference between a resolver and a thing that quietly answers `false`: a
 * future tier written with `(min-resolution: …)` or a range query
 * (`width >= 60rem`) must break this loudly rather than be silently skipped,
 * leaving every assertion below still green and now meaningless.
 */
export function mediaApplies(condition: string, viewport: Viewport): boolean {
  return condition
    .split(/\s+and\s+/i)
    .every((part) => {
      const match = /^\(\s*([a-z-]+)\s*:\s*([^)]+?)\s*\)$/i.exec(part.trim());
      if (!match) throw new Error(`unsupported media condition: ${condition}`);
      const [, feature, value] = match as unknown as [string, string, string];
      switch (feature) {
        case 'min-width':
          return viewport.width >= Number(/^(\d+(?:\.\d+)?)px$/.exec(value)?.[1] ?? NaN);
        case 'max-width':
          return viewport.width <= Number(/^(\d+(?:\.\d+)?)px$/.exec(value)?.[1] ?? NaN);
        case 'pointer':
          return value === (viewport.finePointer ? 'fine' : 'coarse');
        case 'any-pointer':
          return value === (viewport.finePointer ? 'fine' : 'coarse');
        case 'prefers-color-scheme':
          return value === (viewport.dark ? 'dark' : 'light');
        case 'prefers-reduced-motion':
          return value === (viewport.reducedMotion ? 'reduce' : 'no-preference');
        default:
          throw new Error(`unsupported media feature: ${feature}`);
      }
    });
}

/** Every custom property `:root` carries at this viewport, in cascade order. */
export function rootProperties(sheets: readonly string[], viewport: Viewport): Map<string, string> {
  const props = new Map<string, string>();
  for (const sheet of sheets) {
    for (const rule of parseRules(sheet)) {
      if (!rule.media.every((condition) => mediaApplies(condition, viewport))) continue;
      // Exact `:root` only. `:root[data-theme='dark']` is a different element
      // state and must not leak into the default resolution.
      if (!rule.selectors.includes(':root')) continue;
      for (const [name, value] of rule.decls) {
        if (name.startsWith('--')) props.set(name, value);
      }
    }
  }
  return props;
}

/**
 * The last declaration of `property` on a rule written with exactly
 * `selector`, at this viewport. `undefined` when nothing declares it.
 */
export function declaredValue(
  sheets: readonly string[],
  selector: string,
  property: string,
  viewport: Viewport,
): string | undefined {
  let found: string | undefined;
  for (const sheet of sheets) {
    for (const rule of parseRules(sheet)) {
      if (!rule.selectors.includes(selector)) continue;
      if (!rule.media.every((condition) => mediaApplies(condition, viewport))) continue;
      const value = rule.decls.get(property);
      if (value !== undefined) found = value;
    }
  }
  return found;
}

/** Substitute `var(--x)` / `var(--x, fallback)` until nothing is left. */
export function substitute(value: string, props: ReadonlyMap<string, string>): string {
  let out = value;
  for (let pass = 0; pass < 16; pass += 1) {
    const next = out.replace(/var\(\s*(--[\w-]+)\s*(?:,\s*([^()]*))?\)/g, (_whole, name: string, fallback?: string) => {
      const resolved = props.get(name);
      if (resolved !== undefined) return resolved;
      if (fallback !== undefined) return fallback;
      throw new Error(`unresolved custom property ${name} in "${value}"`);
    });
    if (next === out) return out;
    out = next;
  }
  throw new Error(`custom property cycle in "${value}"`);
}

export interface LengthContext {
  /** px per rem. 16 unless the page sets a root font-size, and it does not. */
  readonly rem: number;
  /** px per ch — the advance of "0" in the rendered font at this size. */
  readonly ch: number;
}

/**
 * Evaluate a length expression to pixels: `calc()`, `+ - * /`, px / rem / ch.
 *
 * Deliberately narrow. Anything it cannot evaluate throws rather than
 * returning a number that happens to look plausible.
 */
export function toPx(expression: string, context: LengthContext): number {
  const matched = expression
    .replace(/\bcalc\b/g, '')
    .match(/\d+(?:\.\d+)?(?:px|rem|ch)?|[-+*/()]/g);
  if (!matched) throw new Error(`not a length: "${expression}"`);
  const tokens: readonly string[] = matched;

  let at = 0;
  const peek = (): string | undefined => tokens[at];

  const primary = (): number => {
    const token = tokens[at];
    if (token === undefined) throw new Error(`unexpected end of "${expression}"`);
    at += 1;
    if (token === '(') {
      const value = sum();
      if (tokens[at] !== ')') throw new Error(`unbalanced parens in "${expression}"`);
      at += 1;
      return value;
    }
    if (token === '-') return -primary();
    if (token === '+') return primary();
    const unit = /^(\d+(?:\.\d+)?)(px|rem|ch)?$/.exec(token);
    if (!unit) throw new Error(`not a length token: "${token}" in "${expression}"`);
    const magnitude = Number(unit[1]);
    if (unit[2] === 'rem') return magnitude * context.rem;
    if (unit[2] === 'ch') return magnitude * context.ch;
    return magnitude; // px, or a bare number used as a multiplier
  };

  const product = (): number => {
    let value = primary();
    while (peek() === '*' || peek() === '/') {
      const op = tokens[at];
      at += 1;
      const right = primary();
      value = op === '*' ? value * right : value / right;
    }
    return value;
  };

  function sum(): number {
    let value = product();
    while (peek() === '+' || peek() === '-') {
      const op = tokens[at];
      at += 1;
      const right = product();
      value = op === '+' ? value + right : value - right;
    }
    return value;
  }

  const result = sum();
  if (at !== tokens.length) throw new Error(`trailing tokens in "${expression}"`);
  return result;
}

/** Every `@media (min-width: Npx)` threshold in a sheet, ascending, deduped. */
export function thresholds(source: string): number[] {
  return [...new Set([...decomment(source).matchAll(/@media \(min-width:\s*(\d+)px\)/g)].map((m) => Number(m[1])))].sort(
    (a, b) => a - b,
  );
}
