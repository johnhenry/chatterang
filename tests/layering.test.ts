import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { builtinModules } from 'node:module';
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

/**
 * Every module specifier a file names, by any of the four doors.
 *
 *   `import x from 'y'` / `export … from 'y'`   — the `from` form
 *   `import 'y'`                                 — a side-effect import, no `from`
 *   `import('y')`                                — dynamic
 *   `require('y')`                               — CommonJS
 *
 * ONE constant, used by every guard below, because the recurring failure in
 * this file has been a matcher that only recognised the form it was written
 * against. That happened twice. `require(...)` was the door all three guards
 * were still blind to: `const { app } = require('electron')` typechecks under
 * `allowJs`/`@ts-expect-error`, bundles, and matched nothing.
 *
 * A single shared constant also means the next door only has to be added once,
 * rather than to three regexes that have already drifted apart before.
 *
 * Note this is a lexical scan, not a parse: it will also match the text inside
 * a string or a comment. That is why the guards test the captured SPECIFIER
 * against an allowlist-shaped pattern rather than searching the raw source —
 * `packages/contracts/src/listener.ts` names `@capacitor/core` in a comment
 * explaining why it does not import it, and a text search flagged that.
 */
/**
 * Every module specifier a file names, in any form we can write one.
 *
 * Widened twice after revert-checks found doors standing open. A template
 * literal (`require(\`electron\`)`) and a comment between the callee and its
 * paren (`require /* x *\/ ('electron')`) both slipped a matcher that handled
 * only straight quotes and adjacent parens.
 */
const COMMENT = String.raw`(?:\s|/\*[\s\S]*?\*/)*`;
const SPECIFIER = new RegExp(
  String.raw`(?:from|import|require)${COMMENT}\(?${COMMENT}['"\`]([^'"\`]+)['"\`]`,
  'g',
);

/**
 * Node builtins, bare as well as `node:`-prefixed.
 *
 * The prefix is a convention, not a requirement: `import 'fs'` resolves to the
 * same module as `import 'node:fs'`. Banning only the prefixed spelling let the
 * unprefixed one through, and Vite answers it by externalising the module with
 * a warning while the build still exits 0 — so the failure lands at runtime in
 * the browser, which is exactly how an optional peer once blanked every page.
 */
const NODE_BUILTINS = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));

/** A specifier that reaches Node's own modules, however it is spelled. */
function isNodeBuiltin(specifier: string): boolean {
  return NODE_BUILTINS.has(specifier) || specifier.startsWith('node:');
}

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
    /require\s*\(\s*['"](@\/[^'"]+)['"]\s*\)/g,
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

/**
 * The contracts package is the one thing three implementations agree on, so it
 * must depend on none of them.
 *
 * It was extracted from `src/plugins/<name>/definitions.ts`, where it sat
 * inside the web shim's own directory and imported `PluginListenerHandle` from
 * `@capacitor/core` — a mobile framework, in a contract a Node backend has to
 * satisfy. These assertions stop it drifting back.
 */
describe('contracts package', () => {
  const CONTRACTS = resolve(process.cwd(), 'packages/contracts/src');
  const contractFiles = sourceFiles(CONTRACTS);

  it('finds the contract sources', () => {
    expect(contractFiles.length).toBeGreaterThan(2);
  });

  it('imports nothing from the app', () => {
    // A `@/` import would make the contract depend on the app that consumes it.
    const offenders = contractFiles.flatMap((file) =>
      importsOf(file).map((specifier) => `${relative(CONTRACTS, file)} -> ${specifier}`),
    );
    expect(offenders).toEqual([]);
  });

  it('imports no platform framework', () => {
    // Capacitor, Node builtins, and DOM libs are all implementation detail of
    // one implementation. A Node backend should not install a mobile framework
    // to describe an event subscription.
    // Match `from 'x'`, bare `import 'x'` and dynamic `import('x')` alike: a
    // side-effect import has no `from`, and matching only `from` let one
    // through. Specifiers, not raw text — listener.ts names
    // `@capacitor/core` in a comment explaining why it does not import it, and
    // a text search flags that as a violation.
    // `electron$` alone missed `electron/main` and `electron/renderer`, which
    // are the same package through a subpath.
    const banned = /^(@capacitor\/|node:|electron($|\/))/;
    const offenders = contractFiles
      .filter((file) =>
        [...readFileSync(file, 'utf8').matchAll(SPECIFIER)].some((m) =>
          banned.test(m[1] ?? ''),
        ),
      )
      .map((file) => relative(CONTRACTS, file));
    expect(offenders).toEqual([]);
  });

  it('is types-only, so there is nothing to build and nothing to drift', () => {
    // Every export is a type. If a runtime value appears here it needs a build
    // step, and the vite/tsconfig aliases point at source on the assumption
    // there isn't one.
    const runtime = contractFiles.filter((file) => {
      const source = readFileSync(file, 'utf8');
      return /^export (?!type)(const|function|class|let|var|default)/m.test(source);
    });
    expect(runtime.map((f) => relative(CONTRACTS, f))).toEqual([]);
  });
});

describe('the app never reaches the desktop-only layer', () => {
  it('src/ imports neither DSH nor the Cordis plugin that hosts it', () => {
    // DSH is Node-only and pulls native addons (koffi, node-pty). A single
    // import from src/ would put them in the mobile bundle, where they cannot
    // load at all. The seam is one-way by construction: cordis-aimatey imports
    // aimatey, never the reverse.
    // Two Node-only packages, three doors each. inference-node was missed on
    // the first pass: it pulls node-llama-cpp's native binaries, which cannot
    // load in a webview, and it was simply absent from the list.
    // Three doors, not one. A bare specifier is the obvious route; a subpath
    // (`@chatterang/cordis-aimatey/src/adapter`) and a relative path into the
    // package (`../packages/cordis-aimatey/...`) reach exactly the same code.
    // An earlier version anchored the scoped name with `$` and had no relative
    // rule, and was revert-checked only against bare specifiers — the one form
    // it already caught. Both other doors were open.
    const banned =
      /^(@deepseek-ai\/|@chatterang\/(cordis-aimatey|inference-node)(\/|$))|(^|\/)packages\/(cordis-aimatey|inference-node)(\/|$)/;
    const offenders = files
      .filter((file) =>
        [...readFileSync(file, 'utf8').matchAll(SPECIFIER)].some((m) =>
          banned.test(m[1] ?? ''),
        ),
      )
      .map((file) => relative(SRC, file));
    expect(offenders).toEqual([]);
  });

  it('src/ never imports the Electron shell, Electron itself, or a Node builtin', () => {
    // A5 added `apps/desktop`, and it is the same seam as the one above with
    // the same doors. The shell imports Electron, `node:fs`, `utilityProcess`
    // and `@deepseek-ai/*`; one import from `src/` would put all of that in the
    // mobile bundle, where none of it exists.
    //
    // The direction is one-way ON PURPOSE and only in this direction:
    // `apps/desktop` DOES import `src/ai/prompt.ts`, so the inference host
    // renders chat templates with the same code the renderer does rather than
    // a copy that drifts. That is why this guard names the desktop layer
    // rather than banning the pair from knowing about each other.
    //
    // AND ELECTRON AND `node:` DIRECTLY, which is what this guard was missing.
    // Naming only the desktop DIRECTORY assumed the only way to reach Electron
    // from `src/` was through the shell — but `import { ipcRenderer } from
    // 'electron'` and `import { readFile } from 'node:fs'` reach it without
    // mentioning `apps/desktop` at all, and `src/` is the mobile and web bundle
    // too. `node:fs` in the renderer is not a desktop feature; on iOS it is a
    // module that does not exist, and the failure is a blank page.
    //
    // Doors, checked as five: the bare specifier, a subpath
    // (`@chatterang/desktop/bridge` — which is how the tests import it, so it
    // is not hypothetical), a relative path into the directory, bare
    // `electron`/`electron/...`, and any `node:` builtin. The specifier matcher
    // itself covers `require(...)` as well as the three import forms.
    const banned =
      /^@chatterang\/desktop(\/|$)|(^|\/)apps\/desktop(\/|$)|^electron($|\/)|(^|\/)node_modules(\/|$)/;
    const offenders = files
      .filter((file) =>
        [...readFileSync(file, 'utf8').matchAll(SPECIFIER)].some((m) => {
          const specifier = m[1] ?? '';
          return banned.test(specifier) || isNodeBuiltin(specifier);
        }),
      )
      .map((file) => relative(SRC, file));
    expect(offenders).toEqual([]);
  });

  it('the specifier matcher sees all four import forms, including require', () => {
    // The guards above are only as good as what they can see, and this file's
    // recurring failure is a matcher revert-checked against the one form it
    // already caught. Asserted directly on the matcher, so each door is a named
    // expectation rather than something a reader has to infer from a regex.
    const forms = [
      "import { app } from 'electron';",
      "export { x } from 'electron/main';",
      "import 'electron';",
      "const m = await import('electron');",
      "const { app } = require('electron');",
      "const { app } = require ( 'electron' );",
    ];
    for (const form of forms) {
      const found = [...form.matchAll(new RegExp(SPECIFIER.source, 'g'))].map((m) => m[1]);
      expect(found, form).toContain(form.includes('/main') ? 'electron/main' : 'electron');
    }
  });
});

/**
 * The desktop bridge is testable because it is not Electron.
 *
 * `tests/desktop-bridge.test.ts` drives `apps/desktop/src/bridge` end to end
 * through a pair of fake ports — which is only possible while that directory
 * imports no Electron and no Node builtins. One `import { app } from
 * 'electron'` there would not fail typecheck and would not fail any bridge
 * test; it would fail the whole suite at import time, days later, with an
 * error pointing at vitest rather than at the import.
 */
describe('the desktop bridge stays platform-free', () => {
  const BRIDGE = resolve(process.cwd(), 'apps/desktop/src/bridge');
  const bridgeFiles = sourceFiles(BRIDGE);

  it('finds the bridge sources', () => {
    expect(bridgeFiles.length).toBeGreaterThan(5);
  });

  it('imports neither Electron nor a Node builtin', () => {
    // Same banned set as before; what changed is that the shared SPECIFIER
    // matcher now also sees `require('electron')`, which this guard was blind
    // to for as long as it existed.
    const banned = /^(electron$|electron\/|node:)/;
    const offenders = bridgeFiles.flatMap((file) =>
      [...readFileSync(file, 'utf8').matchAll(SPECIFIER)]
        .map((m) => m[1] ?? '')
        .filter((specifier) => banned.test(specifier))
        .map((specifier) => `${relative(BRIDGE, file)} -> ${specifier}`),
    );
    expect(offenders).toEqual([]);
  });
});
