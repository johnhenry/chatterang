/**
 * Tool registry (PRD §3.2).
 *
 * One extensible registry, surfaced to the model as IR tools and executed by
 * the tool middleware. Tools are pure functions over JSON: none of them may
 * reach the network, because a tool that phoned home would quietly break the
 * promise the whole app is built on.
 */

import type { IRTool, JSONSchema } from '@johnhenry/aimatey-types';

export interface ToolContext {
  /** Signals cancellation when the user stops generation. */
  readonly signal?: AbortSignal;
  /** Current time, injected so tools stay testable. */
  readonly now: () => Date;
}

export interface ToolResult {
  /** Text handed back to the model. */
  readonly output: string;
  /** Optional payload the UI renders instead of raw text. */
  readonly display?: { readonly kind: 'html' | 'json' | 'text'; readonly value: string };
  readonly isError?: boolean;
}

export interface ChatterangTool {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly parameters: JSONSchema;
  /** One-line summary shown in the tool picker. */
  readonly summary: string;
  /** Tools that touch device state are opt-in per chat. */
  readonly sensitive?: boolean;
  execute(input: Record<string, unknown>, context: ToolContext): Promise<ToolResult>;
}

/* ── Built-in tools ─────────────────────────────────────────────────── */

/**
 * A small, total expression evaluator. Deliberately not `eval`: this parses a
 * fixed grammar so a model cannot talk the app into running arbitrary code.
 */
export function evaluateExpression(input: string): number {
  const TOKEN =
    /\d+\.?\d*|[(),+\-*/%^]|\b(?:pi|e|sqrt|abs|round|floor|ceil|min|max|log|ln|sin|cos|tan)\b/gi;

  const tokens = input.match(TOKEN);
  if (!tokens) throw new Error('That does not look like an arithmetic expression.');

  // Reject anything the tokeniser did not recognise instead of quietly
  // dropping it. Without this, `process.exit(1)` tokenises to `( 1 )` and
  // returns 1 — a calculator that answers questions it did not understand is
  // worse than one that refuses.
  if (tokens.join('') !== input.replace(/\s+/g, '')) {
    throw new Error('That expression contains characters I do not understand.');
  }

  let position = 0;
  const peek = (): string | undefined => tokens[position];
  const take = (): string => {
    const token = tokens[position];
    if (token === undefined) throw new Error('The expression ends unexpectedly.');
    position += 1;
    return token;
  };

  const parseExpression = (): number => {
    let value = parseTerm();
    for (;;) {
      const token = peek();
      if (token === '+') {
        take();
        value += parseTerm();
      } else if (token === '-') {
        take();
        value -= parseTerm();
      } else return value;
    }
  };

  const parseTerm = (): number => {
    let value = parsePower();
    for (;;) {
      const token = peek();
      if (token === '*') {
        take();
        value *= parsePower();
      } else if (token === '/') {
        take();
        const divisor = parsePower();
        if (divisor === 0) throw new Error('Division by zero.');
        value /= divisor;
      } else if (token === '%') {
        take();
        value %= parsePower();
      } else return value;
    }
  };

  const parsePower = (): number => {
    const base = parseUnary();
    if (peek() === '^') {
      take();
      return base ** parsePower();
    }
    return base;
  };

  const FUNCTIONS: Record<string, (...args: number[]) => number> = {
    sqrt: Math.sqrt,
    abs: Math.abs,
    round: Math.round,
    floor: Math.floor,
    ceil: Math.ceil,
    min: Math.min,
    max: Math.max,
    log: Math.log10,
    ln: Math.log,
    sin: Math.sin,
    cos: Math.cos,
    tan: Math.tan,
  };

  const parseUnary = (): number => {
    const token = peek();
    if (token === '-') {
      take();
      return -parseUnary();
    }
    if (token === '+') {
      take();
      return parseUnary();
    }
    return parseAtom();
  };

  const parseAtom = (): number => {
    const token = take();
    if (token === '(') {
      const value = parseExpression();
      if (take() !== ')') throw new Error('Unbalanced parentheses.');
      return value;
    }
    const lower = token.toLowerCase();
    if (lower === 'pi') return Math.PI;
    if (lower === 'e') return Math.E;

    const fn = FUNCTIONS[lower];
    if (fn) {
      if (take() !== '(') throw new Error(`${lower} needs parentheses.`);
      const args = [parseExpression()];
      while (peek() === ',') {
        take();
        args.push(parseExpression());
      }
      if (take() !== ')') throw new Error('Unbalanced parentheses.');
      return fn(...args);
    }

    const value = Number(token);
    if (Number.isNaN(value)) throw new Error(`Unexpected "${token}".`);
    return value;
  };

  const result = parseExpression();
  if (position !== tokens.length) throw new Error('Trailing characters in the expression.');
  if (!Number.isFinite(result)) throw new Error('The result is not a finite number.');
  return result;
}

const calculator: ChatterangTool = {
  id: 'calculator',
  name: 'calculate',
  summary: 'Arithmetic the model can trust',
  description:
    'Evaluate an arithmetic expression exactly. Supports + - * / % ^, parentheses, pi, e, and sqrt, abs, round, floor, ceil, min, max, log, ln, sin, cos, tan.',
  parameters: {
    type: 'object',
    properties: {
      expression: {
        type: 'string',
        description: 'The arithmetic expression, e.g. "(1920 * 1080) / 1e6"',
      },
    },
    required: ['expression'],
  },
  async execute(input) {
    const expression = String(input.expression ?? '');
    try {
      const value = evaluateExpression(expression);
      return { output: `${expression} = ${value}` };
    } catch (error) {
      return {
        output: error instanceof Error ? error.message : 'Could not evaluate that expression.',
        isError: true,
      };
    }
  },
};

const datetime: ChatterangTool = {
  id: 'datetime',
  name: 'get_datetime',
  summary: 'The current date and time on this device',
  description:
    'Get the current date and time from the device clock, optionally in a specific IANA timezone.',
  parameters: {
    type: 'object',
    properties: {
      timezone: {
        type: 'string',
        description: 'IANA timezone, e.g. "Europe/Lisbon". Defaults to the device timezone.',
      },
    },
  },
  async execute(input, context) {
    const now = context.now();
    const timezone =
      typeof input.timezone === 'string' && input.timezone
        ? input.timezone
        : Intl.DateTimeFormat().resolvedOptions().timeZone;
    try {
      const formatted = new Intl.DateTimeFormat('en-GB', {
        dateStyle: 'full',
        timeStyle: 'long',
        timeZone: timezone,
      }).format(now);
      return { output: `${formatted} (${timezone})` };
    } catch {
      return { output: `"${timezone}" is not a timezone I recognise.`, isError: true };
    }
  },
};

const renderHtml: ChatterangTool = {
  id: 'render_html',
  name: 'render_html',
  summary: 'Draw a small self-contained page',
  description:
    'Render a self-contained HTML fragment for the user to look at — a chart, a table, a diagram, a small layout. Inline all CSS. No network requests are permitted.',
  parameters: {
    type: 'object',
    properties: {
      html: { type: 'string', description: 'A complete, self-contained HTML fragment.' },
      title: { type: 'string', description: 'Short label for the rendered block.' },
      height: { type: 'integer', description: 'Preferred height in pixels (120–640).' },
    },
    required: ['html'],
  },
  async execute(input) {
    const html = String(input.html ?? '');
    if (!html.trim()) return { output: 'No HTML was provided.', isError: true };
    return {
      output: `Rendered ${html.length} characters of HTML for the user.`,
      display: { kind: 'html', value: html },
    };
  },
};

export const BUILT_IN_TOOLS: readonly ChatterangTool[] = [calculator, datetime, renderHtml];

/* ── Registry ───────────────────────────────────────────────────────── */

export class ToolRegistry {
  #tools = new Map<string, ChatterangTool>();

  constructor(tools: readonly ChatterangTool[] = BUILT_IN_TOOLS) {
    for (const tool of tools) this.register(tool);
  }

  register(tool: ChatterangTool): void {
    this.#tools.set(tool.id, tool);
  }

  unregister(id: string): void {
    this.#tools.delete(id);
  }

  get(id: string): ChatterangTool | undefined {
    return this.#tools.get(id);
  }

  /** Look up by the name the model calls, which may differ from the id. */
  getByName(name: string): ChatterangTool | undefined {
    for (const tool of this.#tools.values()) {
      if (tool.name === name) return tool;
    }
    return this.#tools.get(name);
  }

  list(): ChatterangTool[] {
    return [...this.#tools.values()];
  }

  /** Project the enabled subset into IR tool definitions. */
  toIRTools(enabledIds: readonly string[]): IRTool[] {
    return enabledIds
      .map((id) => this.#tools.get(id))
      .filter((tool): tool is ChatterangTool => Boolean(tool))
      .map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      }));
  }
}

export const toolRegistry = new ToolRegistry();
