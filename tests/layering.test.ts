import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Import-direction guards.
 *
 * These exist because a circular import broke the entire app while
 * typechecking perfectly: `state/app` imported the shell tool, which reads
 * every store, one of which imports `state/app` back. TypeScript is happy with
 * a cycle; the browser is not, and the failure — "cannot access
 * 'resolverHooks' before initialization" — surfaces as a blank page at
 * startup, nowhere near the import that caused it.
 */

const SRC = resolve(process.cwd(), 'src');

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

/** Every `@/…` specifier a file imports, static or dynamic, type or value. */
function importsOf(file: string): string[] {
  const source = readFileSync(file, 'utf8');
  const specifiers: string[] = [];
  const patterns = [
    /(?:^|\n)\s*import\s[^;]*?from\s+['"](@\/[^'"]+)['"]/g,
    /(?:^|\n)\s*export\s[^;]*?from\s+['"](@\/[^'"]+)['"]/g,
    /import\(\s*['"](@\/[^'"]+)['"]\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) specifiers.push(match[1]!);
  }
  return specifiers;
}

const files = sourceFiles(SRC);
const rel = (file: string): string => relative(SRC, file).replaceAll('\\', '/');

describe('import layering', () => {
  it('finds source files to check', () => {
    // A guard that silently checks nothing is worse than no guard.
    expect(files.length).toBeGreaterThan(30);
  });

  it('no store imports the shell', () => {
    // The shell reads every store. A store importing it back closes the cycle
    // that produced a blank page at startup.
    const offenders = files
      .filter((file) => rel(file).startsWith('state/'))
      .flatMap((file) =>
        importsOf(file)
          .filter((specifier) => specifier.startsWith('@/shell'))
          .map((specifier) => `${rel(file)} -> ${specifier}`),
      );

    expect(offenders).toEqual([]);
  });

  it('no domain module imports a store, the engine, or a feature', () => {
    // `domain/` is the contract layer: schemas and pure functions. Anything it
    // imports becomes a dependency of everything.
    const offenders = files
      .filter((file) => rel(file).startsWith('domain/'))
      .flatMap((file) =>
        importsOf(file)
          .filter((s) => /^@\/(state|features|ai|shell|db)\b/.test(s))
          .map((specifier) => `${rel(file)} -> ${specifier}`),
      );

    expect(offenders).toEqual([]);
  });

  it('no feature is imported by a store or the ai layer', () => {
    // Features sit at the top. Anything below reaching up into them is a cycle
    // waiting to happen.
    const offenders = files
      .filter((file) => /^(state|ai|shell|domain|db)\//.test(rel(file)))
      .flatMap((file) =>
        importsOf(file)
          .filter((specifier) => specifier.startsWith('@/features'))
          .map((specifier) => `${rel(file)} -> ${specifier}`),
      );

    expect(offenders).toEqual([]);
  });

  it('the plugin layer depends on nothing above it', () => {
    // Capacitor plugin definitions must stay portable — they are the contract
    // the native implementations are written against.
    const offenders = files
      .filter((file) => rel(file).startsWith('plugins/'))
      .flatMap((file) =>
        importsOf(file)
          .filter((s) => /^@\/(state|features|ai|shell|db|data)\b/.test(s))
          .map((specifier) => `${rel(file)} -> ${specifier}`),
      );

    expect(offenders).toEqual([]);
  });

  it('detects a cycle among the modules it checks', () => {
    // Full cycle detection over the `@/` graph, so the next one is caught
    // wherever it appears rather than only in the directions listed above.
    const graph = new Map<string, string[]>();
    for (const file of files) {
      graph.set(
        rel(file).replace(/\.tsx?$/, ''),
        importsOf(file).map((specifier) => specifier.replace(/^@\//, '')),
      );
    }

    // Resolve `a/b` to `a/b/index` when that is what exists.
    const resolveNode = (name: string): string =>
      graph.has(name) ? name : graph.has(`${name}/index`) ? `${name}/index` : name;

    const cycles: string[] = [];
    const state = new Map<string, 'visiting' | 'done'>();

    const walk = (node: string, path: string[]): void => {
      if (state.get(node) === 'done') return;
      if (state.get(node) === 'visiting') {
        cycles.push([...path.slice(path.indexOf(node)), node].join(' -> '));
        return;
      }
      state.set(node, 'visiting');
      for (const next of graph.get(node) ?? []) {
        const target = resolveNode(next);
        if (graph.has(target)) walk(target, [...path, node]);
      }
      state.set(node, 'done');
    };

    for (const node of graph.keys()) walk(node, []);
    expect(cycles).toEqual([]);
  });
});
