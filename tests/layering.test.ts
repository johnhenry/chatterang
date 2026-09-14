import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { builtinModules } from 'node:module';
import { describe, expect, it } from 'vitest';

import { SPECIFIER, codeOf, sourceFiles } from './support/source-scan';

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
 * The one ban the src/ desktop-layer guard enforces.
 *
 * Shared, not copied. The form tests below previously asserted against a
 * byte-identical second copy, so weakening the ban that is actually applied to
 * real files left every one of them green — a revert-check that verified a
 * duplicate of the thing under test. Exactly the failure this file keeps
 * re-learning, committed inside the guard against it.
 */
/*
 * A3 ADDED `@chatterang/tunnel` — AND ONLY HALF OF IT, WHICH IS NEW HERE.
 *
 * Every other name in this regex is banned outright: there is no part of
 * `onnx-node` the phone may have. `packages/tunnel` (#155) is the first package
 * that is banned and importable AT ONCE, because a tunnel has two ends and one
 * of them is the phone. So the ban is written against ENTRY POINTS:
 *
 *   @chatterang/tunnel            BANNED — the bare specifier, see below
 *   @chatterang/tunnel/host       BANNED — this is the half that binds a socket
 *   @chatterang/tunnel/client     allowed — web globals only
 *   @chatterang/tunnel/wire       allowed — imports nothing at all
 *
 * The BARE specifier is banned even though `packages/tunnel/package.json`
 * declares no `.` export for it to resolve to. Those are two independent
 * guards on purpose: the package.json key is asserted absent in the tunnel
 * block below, and if someone adds a `.` that re-exports both halves — the
 * obvious convenience, and the thing that silently deletes this boundary — the
 * bare import still fails here rather than shipping `node:http` to a phone.
 *
 * Relative paths get the same treatment, at both plausible layouts
 * (`packages/tunnel/host` and today's `packages/tunnel/src/host`), because
 * `../../packages/tunnel/src/host/index` reaches the identical code without
 * naming the package at all — the door this file's own comments record being
 * left open twice before.
 */
const DESKTOP_LAYER_BAN =
  /^(@deepseek-ai\/|@chatterang\/(cordis-aimatey|inference-node|onnx-node)(\/|$)|@chatterang\/tunnel($|\/host(\/|$))|onnxruntime-(node|common)(\/|$)|node-llama-cpp(\/|$))|(^|\/)(packages\/(cordis-aimatey|inference-node|onnx-node)|packages\/tunnel\/(src\/)?host|node_modules\/(onnxruntime-node|onnxruntime-common|node-llama-cpp))(\/|$)/;

/*
 * `SPECIFIER`, `codeOf` and `sourceFiles` live in `tests/support/source-scan.ts`
 * — the one matcher every guard below uses, and the one comment stripper, with
 * the history of each door they were widened to see. They moved out of this
 * file, unchanged, when the privacy-copy suite's listen inventory needed the
 * same stripper: a second copy is the failure this file keeps re-learning.
 */

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
/**
 * A package `src/` imports but nothing declares does not exist as far as the
 * bundle is concerned — it is there because something else happened to pull it
 * in. #239.
 *
 * The guards above ban by NAME: Node builtins, `electron`, the
 * `@chatterang/desktop|server` specifiers, the packages in
 * `DESKTOP_LAYER_BAN`. Each was added after the specific thing it names bit
 * us. That leaves the whole category they are instances of: an ordinary npm
 * package that only works in Node. `ws` is not a builtin, not `electron`, not
 * `@chatterang/*` and its specifier contains no path, so
 * `import WebSocket from 'ws'` in `src/` passed every one of them — and Vite
 * answers an unresolvable import by externalising it with a warning while the
 * build still exits 0, which is the blank-page-in-a-webview failure
 * `import layering`'s own header describes.
 *
 * This one bans by DERIVATION instead: `src/` may import what this app
 * declares, plus the workspace packages, and nothing else. A dependency of
 * `apps/desktop` is not a dependency of the bundle, so `ws` fails here without
 * anybody having to remember to name it — which is the point, because the
 * failure mode of a denylist is the entry nobody thought to add.
 */
describe('src/ imports only what this app declares', () => {
  const manifest = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
    workspaces?: string[];
  };

  /** `@scope/name` or `name`, dropping any subpath. */
  function packageOf(specifier: string): string {
    const parts = specifier.split('/');
    return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]!;
  }

  const workspacePackages = new Set(
    ['packages', 'apps'].flatMap((group) => {
      const dir = resolve(process.cwd(), group);
      if (!existsSync(dir)) return [];
      return readdirSync(dir)
        .map((name) => resolve(dir, name, 'package.json'))
        .filter((file) => existsSync(file))
        .map((file) => (JSON.parse(readFileSync(file, 'utf8')) as { name?: string }).name)
        .filter((name): name is string => Boolean(name));
    }),
  );

  const declared = new Set([...Object.keys(manifest.dependencies ?? {}), ...workspacePackages]);

  it('finds the manifest, the workspaces, and the imports it is meant to read', () => {
    // Without these, an empty `declared` would report every import as an
    // offender and an empty specifier list would report none. Both are a broken
    // test reading as a result, and the third assertion is the one that matters:
    // the first draft of this guard used `importsOf`, which only matches `@/`
    // specifiers, so it read nothing and passed.
    expect(declared.size).toBeGreaterThan(5);
    expect(workspacePackages.size).toBeGreaterThan(1);
    expect(sourceFiles(SRC).length).toBeGreaterThan(20);

    const seen = sourceFiles(SRC).flatMap((file) =>
      [...codeOf(readFileSync(file, 'utf8')).matchAll(new RegExp(SPECIFIER.source, 'g'))].map(
        (match) => match[1] ?? '',
      ),
    );
    // Bare packages this app certainly imports. If the extractor stops seeing
    // these, it has stopped seeing everything.
    expect(seen).toContain('react');
    expect(seen).toContain('zustand');

    // And the shape filter keeps them. A filter tight enough to drop prose and
    // also drop `@scope/pkg` would make this guard silently vacuous again.
    const shaped = (specifier: string) => /^[@a-zA-Z.][^\n]*$/.test(specifier);
    for (const real of ['react', '@capacitor/core', '@johnhenry/aimatey-types', './x', '@/domain/chat']) {
      expect(shaped(real), real).toBe(true);
    }
    expect(shaped(',\n          ')).toBe(false);
  });

  it('names no package the manifest does not', () => {
    const offenders = sourceFiles(SRC)
      .flatMap((file) =>
        // `SPECIFIER` over `codeOf`, NOT `importsOf` — that helper only matches
        // `@/` specifiers, because it exists for the contracts test. Used here
        // it returned nothing at all and this assertion passed against an empty
        // list, which is the exact failure this file keeps re-learning. The
        // control below is what caught it.
        [...codeOf(readFileSync(file, 'utf8')).matchAll(new RegExp(SPECIFIER.source, 'g'))]
          .map((match) => match[1] ?? '')
          // `SPECIFIER` matches the WORD `from`/`import`/`require` before any
          // quote, which is deliberate — it is how `require ( 'electron' )` is
          // caught. The cost is that prose ending in "from" followed by the
          // next string in an array literal matches too; `shell/commands.ts`
          // has exactly that in the privacy copy. The neighbouring guards
          // never noticed because a non-specifier matches no ban. This one
          // treats anything undeclared as an offender, so it has to tell a
          // specifier from a sentence: real ones have no newline and begin
          // with a letter, `@` or `.`.
          .filter((specifier) => /^[@a-zA-Z.][^\n]*$/.test(specifier))
          // Relative paths and the `@/` alias resolve inside `src/` itself.
          .filter((specifier) => !specifier.startsWith('.') && !specifier.startsWith('@/'))
          // Builtins are the neighbouring guard's job; leaving them out keeps a
          // failure here pointing at one cause rather than two.
          .filter((specifier) => !isNodeBuiltin(specifier))
          .map((specifier) => packageOf(specifier))
          .filter((name) => !declared.has(name))
          .map((name) => `${relative(SRC, file)} -> ${name}`),
      )
      .filter((entry, index, all) => all.indexOf(entry) === index);

    expect(offenders).toEqual([]);
  });

  it('would catch a Node-only dependency of another workspace', () => {
    // The control. `ws` is what #157 chose for the WebSocket server, and it
    // belongs to apps/desktop and apps/server — never to the bundle. If this
    // assertion ever fails it means `ws` reached the root manifest, and the
    // protection this guard exists to give is gone.
    expect(declared.has('ws')).toBe(false);
    expect(packageOf('ws')).toBe('ws');
    expect(packageOf('@modelcontextprotocol/client/streamable')).toBe('@modelcontextprotocol/client');
  });
});

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

/**
 * THE TUNNEL PACKAGE (#155): the first package that is banned and importable at
 * the same time.
 *
 * Every other package in this repo is one or the other. `contracts` is
 * platform-agnostic and `src/` may have all of it; `inference-node`,
 * `onnx-node` and `cordis-aimatey` are Node-only and `src/` may have none of
 * it. A tunnel has two ends, and one of them is the phone — so
 * `packages/tunnel` is split at the ENTRY POINT and the boundary runs through
 * the middle of it:
 *
 *   src/wire/    imports nothing at all.               `src/` MAY import it.
 *   src/client/  web globals only (no `node:`).        `src/` MAY import it.
 *   src/host/    `node:http`, and a socket to bind.     `src/` MAY NOT.
 *
 * WHY THE PACKAGE-NAME BAN ABOVE IS NOT ENOUGH BY ITSELF, and why this block
 * exists rather than one more name in `DESKTOP_LAYER_BAN`. The dangerous edge
 * is not `src/` naming the host entry — that is banned and revert-checked. It
 * is `packages/tunnel/src/client/` importing `../host/index.js`, INSIDE the
 * package, where the specifier `src/` writes is still `@chatterang/tunnel
 * /client` and every guard above waves it through while `node:http` rides into
 * the mobile bundle behind it. A ban that only watches the front door is a ban
 * on the front door.
 *
 * That guard has to be written whether the halves are two entry points or two
 * packages, which is what settled #155's open question: once it exists, one
 * package costs strictly less machinery for the same rule, and the wire types —
 * the entire reason to share anything — stay in one place. See
 * `packages/tunnel/README.md`.
 *
 * Shaped after the `contracts` block above, and asserted against the real files
 * rather than a copy, for the reason recorded at the top of this file.
 */
describe('the tunnel package', () => {
  const TUNNEL = resolve(process.cwd(), 'packages/tunnel/src');
  const tunnelFiles = sourceFiles(TUNNEL);
  const relTunnel = (file: string): string => relative(TUNNEL, file).replaceAll('\\', '/');
  const half = (
    name: 'wire' | 'codec' | 'pairing' | 'pake' | 'stream' | 'binding' | 'client' | 'host',
  ): string[] =>
    tunnelFiles.filter((file) => relTunnel(file).startsWith(`${name}/`));

  /** Every specifier a file names, with comments stripped first. */
  const specifiersOf = (file: string): string[] =>
    [...codeOf(readFileSync(file, 'utf8')).matchAll(SPECIFIER)].map((m) => m[1] ?? '');

  it('finds every half, so none of these rules is vacuous', () => {
    // A boundary guard that runs against an empty directory passes and proves
    // nothing — the failure mode of every "no offenders" assertion in this
    // file, and the reason each block here opens with a count.
    expect(tunnelFiles.map(relTunnel).sort()).not.toEqual([]);
    for (const name of ['wire', 'codec', 'pairing', 'pake', 'stream', 'binding', 'client', 'host'] as const) {
      expect(half(name).length, `packages/tunnel/src/${name} is empty`).toBeGreaterThan(0);
    }
  });

  it('the wire half imports nothing at all', () => {
    // The bottom of the package, and the one file both ends load. Anything it
    // imports is imported by the phone AND by the listener, so the rule is not
    // "no Node builtins" but "nothing": a DOM type, a Capacitor helper and a
    // utility package are each equally a dependency the other end did not ask
    // for. It is also what lets the codec live here rather than being split
    // from its own types across two packages.
    const offenders = half('wire').flatMap((file) =>
      specifiersOf(file).map((specifier) => `${relTunnel(file)} -> ${specifier}`),
    );
    expect(offenders).toEqual([]);
  });

  it('the pairing half imports nothing, and reaches for no global either', () => {
    /*
     * THE SAME RULE AS `wire`, FOR A DIFFERENT AND STRONGER REASON (#134).
     *
     * `wire` imports nothing because both ends load it. `pairing` imports
     * nothing AND uses no global, because #223 is an open ticket recording
     * that every mobile capability this app relies on was measured on the
     * NEWEST runtimes while the app supports the oldest — and this is the one
     * component that has to work on all of them. A pairing parser that needs
     * `TextDecoder` or `crypto.subtle` fails on exactly the old phone whose
     * owner is trying to pair it, at the moment they are trying.
     *
     * So base64url and UTF-8 are implemented in the file. That is a cost, and
     * this guard is what stops someone paying it and then quietly reaching for
     * `btoa` in the next edit.
     */
    /*
     * "Nothing" means nothing FROM OUTSIDE THIS HALF. A `./`-relative import
     * of a sibling file is the half being more than one file, which is not
     * what this rule protects against — the danger is a dependency the phone
     * did not ask for, or `../host`, which is `node:http` in the mobile bundle.
     *
     * So: `./x` is allowed, and ANY specifier containing `..` is not, which
     * bans reaching into another half by relative path as well as reaching out
     * of the package. Written as an allowlist so widening it is an edit here.
     */
    const sameHalf = (specifier: string) => specifier.startsWith('./') && !specifier.includes('..');
    const offenders = half('pairing').flatMap((file) =>
      specifiersOf(file)
        .filter((specifier) => !sameHalf(specifier))
        .map((specifier) => `${relTunnel(file)} -> ${specifier}`),
    );
    expect(offenders).toEqual([]);

    // The ban has something behind it: a sibling import exists and is allowed,
    // so this rule is not passing because the half happens to be one file.
    expect(
      half('pairing').flatMap(specifiersOf).filter(sameHalf).length,
      'no sibling import exists, so the allowance above is untested',
    ).toBeGreaterThan(0);

    // And the thing it must still catch, asserted directly rather than assumed.
    expect(sameHalf('../host/index.js')).toBe(false);
    expect(sameHalf('@noble/curves/ed25519.js')).toBe(false);
    expect(sameHalf('node:crypto')).toBe(false);

    const globals = ['btoa', 'atob', 'Buffer', 'TextEncoder', 'TextDecoder', 'crypto'];
    const reached = half('pairing').flatMap((file) => {
      const code = codeOf(readFileSync(file, 'utf8'));
      return globals
        .filter((name) => new RegExp(`\\b${name}\\b`).test(code))
        .map((name) => `${relTunnel(file)} -> ${name}`);
    });
    expect(reached).toEqual([]);
  });

  it('the pake half may import noble and nothing else that matters', () => {
    /*
     * THE ONE HALF WITH A DEPENDENCY, and the rule is written as an allowlist
     * rather than a ban so that adding a second one is a deliberate edit here.
     *
     * `pairing/` imports nothing and reaches for no global; `pake/` cannot
     * meet that — CPace needs elliptic-curve arithmetic, and #130's ruling is
     * explicit that hand-rolling it is not on the table. What it CAN meet is
     * everything else: no Node builtin, no Electron, no Capacitor, and no
     * global. Entropy is a parameter precisely so this stays true, which is
     * also what lets the draft's test vectors fix the scalar.
     */
    const allowed = /^@noble\/(curves|hashes)\//;
    const offenders = half('pake').flatMap((file) =>
      specifiersOf(file)
        .filter((specifier) => !allowed.test(specifier))
        .map((specifier) => `${relTunnel(file)} -> ${specifier}`),
    );
    expect(offenders).toEqual([]);

    // The same global ban `pairing/` carries. #223 is open about runtimes
    // nobody has measured, and a PAKE that reaches for `crypto.subtle` would
    // have thrown away the one advantage it has over a signature scheme.
    const globals = ['btoa', 'atob', 'Buffer', 'TextDecoder', 'crypto'];
    const reached = half('pake').flatMap((file) => {
      const code = codeOf(readFileSync(file, 'utf8'));
      return globals
        .filter((name) => new RegExp(`\\b${name}\\b`).test(code))
        .map((name) => `${relTunnel(file)} -> ${name}`);
    });
    expect(reached).toEqual([]);
  });

  it('the client half imports no Node builtin, no Electron and no Capacitor', () => {
    // This half is the mobile and web bundle's, so it lives under exactly the
    // rules `src/` does. `@capacitor/` is banned for the same reason it is
    // banned in `contracts`: the desktop renderer imports this too, and a
    // shared contract that needs a mobile framework installed is not shared.
    const banned = /^(@capacitor\/|electron($|\/))/;
    const offenders = half('client').flatMap((file) =>
      specifiersOf(file)
        .filter((specifier) => banned.test(specifier) || isNodeBuiltin(specifier))
        .map((specifier) => `${relTunnel(file)} -> ${specifier}`),
    );
    expect(offenders).toEqual([]);
  });

  it('no importable half reaches into the host half', () => {
    // THE EDGE A PACKAGE-NAME BAN CANNOT SEE. `src/` importing
    // `@chatterang/tunnel/client` is allowed and always will be; if that file
    // imports `../host/index.js`, `node:http` is in the phone bundle and every
    // other guard in this file still passes.
    //
    // EVERY IMPORTABLE HALF, not only `client`. This rule used to cover `client`
    // alone, while `binding/` and `stream/` — both importable from `src/` —
    // were checked by nothing at all: neither appeared in any rule in this
    // block, so a `../host` import in either would have passed the whole file.
    //
    // Both spellings, because the relative path is the one someone actually
    // types from inside the package and the package name is the one a
    // refactor leaves behind.
    const reachesHost = (specifier: string): boolean =>
      DESKTOP_LAYER_BAN.test(specifier) || /(^|\/)\.\.\/host(\/|$)/.test(`/${specifier}`);
    const importable = ['client', 'binding', 'stream', 'pairing', 'pake'] as const;
    const offenders = importable.flatMap((name) =>
      half(name).flatMap((file) =>
        specifiersOf(file)
          .filter(reachesHost)
          .map((specifier) => `${relTunnel(file)} -> ${specifier}`),
      ),
    );
    expect(offenders).toEqual([]);

    // The check can fail: both spellings are caught, and a sibling half is not.
    expect(reachesHost('../host/index.js')).toBe(true);
    expect(reachesHost('@chatterang/tunnel/host')).toBe(true);
    expect(reachesHost('../pake/index.js')).toBe(false);
  });

  it('the binding half imports only the two halves it joins', () => {
    /*
     * `binding/` exists as its own half for one reason: it is the only place
     * that needs both `pairing/` (which may import nothing) and `pake/` (which
     * may import noble and nothing else). So it may import exactly those two,
     * plus its own siblings — not noble directly, not `../host`, not a builtin.
     */
    const ALLOWED = new Set(['../pake/index.js', '../pairing/index.js']);
    const allowed = (specifier: string): boolean =>
      ALLOWED.has(specifier) || (specifier.startsWith('./') && !specifier.includes('..'));
    const offenders = half('binding').flatMap((file) =>
      specifiersOf(file)
        .filter((specifier) => !allowed(specifier))
        .map((specifier) => `${relTunnel(file)} -> ${specifier}`),
    );
    expect(offenders).toEqual([]);

    // Positive control: both allowances are actually used, so neither passes
    // because the file happens not to import it.
    const used = half('binding').flatMap(specifiersOf);
    expect(used).toContain('../pake/index.js');
    expect(used).toContain('../pairing/index.js');
    expect(allowed('../host/index.js')).toBe(false);
    expect(allowed('@noble/curves/ed25519.js')).toBe(false);
    expect(allowed('node:crypto')).toBe(false);
  });

  it('the stream half imports the wire and the IR types, and the types only as types', () => {
    // `stream/` is loaded by both ends, so it gets `wire/`'s manners plus the
    // one thing it needs to name: the IR message shape. That is a TYPE, and a
    // value import from the IR package would put runtime code in a half that
    // was written to carry none.
    const ALLOWED = new Set(['../wire/index.js', '@johnhenry/aimatey-types']);
    const offenders = half('stream').flatMap((file) =>
      specifiersOf(file)
        .filter((specifier) => !ALLOWED.has(specifier))
        .map((specifier) => `${relTunnel(file)} -> ${specifier}`),
    );
    expect(offenders).toEqual([]);

    const valueImportsOfTypes = half('stream').flatMap((file) =>
      [...codeOf(readFileSync(file, 'utf8')).matchAll(/import\s+(?!type\b)[^;]*?from\s+['"]@johnhenry\/aimatey-types['"]/g)]
        .map(() => relTunnel(file)),
    );
    expect(valueImportsOfTypes, 'a VALUE import from @johnhenry/aimatey-types').toEqual([]);

    expect(half('stream').flatMap(specifiersOf)).toContain('../wire/index.js');
  });

  it('neither shared half imports the app', () => {
    // A `@/` import would make the tunnel depend on the app that consumes it —
    // and this package is meant to be consumed by `apps/desktop` as well.
    const offenders = [
      ...half('wire'),
      ...half('codec'),
      ...half('pairing'),
      ...half('pake'),
      ...half('stream'),
      ...half('binding'),
      ...half('client'),
      ...half('host'),
    ].flatMap((file) =>
      specifiersOf(file)
        .filter((specifier) => specifier.startsWith('@/'))
        .map((specifier) => `${relTunnel(file)} -> ${specifier}`),
    );
    expect(offenders).toEqual([]);
  });

  it('the host half really does name a Node builtin, so its ban is load-bearing', () => {
    // The half of this boundary that is easy to get wrong by ACCIDENTALLY
    // GETTING IT RIGHT. If `host/` never touches `node:`, then banning it from
    // `src/` costs nothing, catches nothing, and reads in review as a boundary
    // being enforced — until the day the listener is actually written and the
    // ban's justification arrives after the code it was supposed to constrain.
    //
    // So the ban is required to have something behind it, asserted in the
    // positive direction. `import type { Server } from 'node:http'` in
    // `host/index.ts` is deliberate for exactly this reason, and the comment
    // there says so.
    const named = half('host').flatMap((file) => specifiersOf(file).filter(isNodeBuiltin));
    expect(named.length, 'packages/tunnel/src/host names no Node builtin').toBeGreaterThan(0);
  });

  it('declares no "." export, so a bare @chatterang/tunnel resolves to nothing', () => {
    // The one plausible way this boundary disappears without anyone deciding to
    // delete it: someone adds `".": "./src/index.ts"` re-exporting both halves
    // because a bare import is tidier, and `src/` gets `node:http` through a
    // specifier no ban mentions. `DESKTOP_LAYER_BAN` bans the bare specifier as
    // well for the same reason — two independent guards, because this one is a
    // convenience someone will genuinely want.
    const manifest = JSON.parse(
      readFileSync(resolve(process.cwd(), 'packages/tunnel/package.json'), 'utf8'),
    ) as { exports?: Record<string, unknown> };
    // `./codec` joins wire and client on the importable side: it is the IR
    // serialization policy (#142), and the phone is one of the two ends that
    // has to apply it. It names no Node builtin, which the ban above checks.
    // `./pairing` joins the importable side (#134): the phone is the half that
    // SCANS a pairing code, so the parser has to be in its bundle. It imports
    // nothing and reaches for no global, which the rule above checks.
    // `./stream` joins the importable side (#260): it is the contiguity guard
    // and the `done.message` obligation, and BOTH halves apply it — the phone
    // streams a reply back when the desktop asks it for a turn, so a rule that
    // lived only in the host would be enforced in one direction. It imports a
    // type and `../wire`, which the ban above checks.
    // `./binding` joins it for #256: it is the ONE channel binding both pairing
    // routes use, and it is its own half because it is the only place needing
    // both `pairing/` (which may import nothing) and `pake/` (which may import
    // noble and nothing else). Putting it in either would break that half's rule.
    expect(Object.keys(manifest.exports ?? {}).sort()).toEqual([
      './binding',
      './client',
      './codec',
      './host',
      './pairing',
      './pake',
      './stream',
      './wire',
    ]);
  });

  it('the tsconfig and vite aliases enumerate entry points, never the directory', () => {
    // A wildcard is the back door. `"@chatterang/tunnel/*": ["packages/tunnel
    // /src/*"]` in tsconfig — or `'@chatterang/tunnel': …/packages/tunnel/src`
    // in vite, where a string alias matches the specifier AND every subpath
    // under it — makes `@chatterang/tunnel/host` resolve for anything that
    // asks. The ban above would still fail the test, but the code would
    // typecheck and bundle, and the failure would be a lint someone waives
    // rather than an import that does not exist.
    for (const [name, source] of [
      ['tsconfig.json', readFileSync(resolve(process.cwd(), 'tsconfig.json'), 'utf8')],
      ['vite.config.ts', readFileSync(resolve(process.cwd(), 'vite.config.ts'), 'utf8')],
    ] as const) {
      // Comments stripped, both directions. BOTH of these files carry comments
      // that spell the wildcard out in order to explain why it is not used —
      // which a raw text search reads as the violation itself, and which is the
      // exact trap this file's contracts block documents at `SPECIFIER`.
      const code = codeOf(source);
      for (const entry of ['wire', 'codec', 'pairing', 'pake', 'stream', 'binding', 'client', 'host']) {
        expect(code, `${name} does not map @chatterang/tunnel/${entry}`).toContain(
          `@chatterang/tunnel/${entry}`,
        );
      }
      expect(code, `${name} maps @chatterang/tunnel with a wildcard`).not.toContain(
        '@chatterang/tunnel/*',
      );
      // The bare key, in either file's quoting.
      for (const bare of [
        '"@chatterang/tunnel":',
        "'@chatterang/tunnel':",
        '"@chatterang/tunnel" :',
      ]) {
        expect(code, `${name} maps a bare @chatterang/tunnel`).not.toContain(bare);
      }
    }
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
    //
    // A3 ADDED `@chatterang/onnx-node`, AND THE npm PACKAGE NAMES WITH IT.
    // The workspace package is the obvious entry, but it is not the only one:
    // npm hoists `onnxruntime-node` to the ROOT `node_modules`, so
    // `import * as ort from 'onnxruntime-node'` in `src/` resolved and passed
    // every guard in this file. That is 283 MB of prebuilt native binaries —
    // with no darwin/x64 build at all — one import away from the web and
    // mobile bundles. `node-llama-cpp` had the identical hole and is closed
    // here too; it was never a new category, only an unnoticed one.
    const banned = DESKTOP_LAYER_BAN;
    const offenders = files
      .filter((file) =>
        [...readFileSync(file, 'utf8').matchAll(SPECIFIER)].some((m) =>
          banned.test(m[1] ?? ''),
        ),
      )
      .map((file) => relative(SRC, file));
    expect(offenders).toEqual([]);
  });

  it('src/ never imports a shell app, Electron itself, or a Node builtin', () => {
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
    // A9 ADDED `apps/server`, AND IT IS THE SAME SEAM. The headless server
    // imports `node:http`, `node:https`, `node:crypto`, `node:child_process`
    // and the desktop bridge; one import of it from `src/` would put all of
    // that in the web and mobile bundles. It is named here rather than left
    // to the `apps/desktop` rule, because that rule spells the directory and
    // would have waved `@chatterang/server` straight through — the guard would
    // have looked like it covered the case and would not have.
    //
    // Doors, checked as five: the bare specifier, a subpath
    // (`@chatterang/desktop/bridge` — which is how the tests import it, so it
    // is not hypothetical), a relative path into either directory, bare
    // `electron`/`electron/...`, and any `node:` builtin. The specifier matcher
    // itself covers `require(...)` as well as the three import forms.
    const banned =
      /^@chatterang\/(desktop|server)(\/|$)|(^|\/)apps\/(desktop|server)(\/|$)|^electron($|\/)|(^|\/)node_modules(\/|$)/;
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

    // The same five doors, spelled with A3's specifiers, and asserted against
    // the BAN as well as the matcher — a specifier the matcher sees and the
    // regex then waves through is the failure this file keeps re-learning.
    const onnxBan = DESKTOP_LAYER_BAN;
    const onnxForms: [string, string][] = [
      ["import * as ort from 'onnxruntime-node';", 'onnxruntime-node'],
      ["import { Tensor } from 'onnxruntime-common';", 'onnxruntime-common'],
      ["export { OnnxRuntimeNode } from '@chatterang/onnx-node';", '@chatterang/onnx-node'],
      ["import 'onnxruntime-node/dist/backend';", 'onnxruntime-node/dist/backend'],
      ["const m = await import('../../packages/onnx-node/src/index');", '../../packages/onnx-node/src/index'],
      ["const ort = require('../node_modules/onnxruntime-node');", '../node_modules/onnxruntime-node'],
      ["const ort = require(`onnxruntime-node`);", 'onnxruntime-node'],
      ["const ort = require /* sneaky */ ('onnxruntime-node');", 'onnxruntime-node'],
      ["import { getLlama } from 'node-llama-cpp';", 'node-llama-cpp'],
      // The tunnel's banned half (#155), by every door. The bare specifier is
      // here because a later `.` export is the one plausible way this boundary
      // disappears without anyone deciding to delete it.
      ["import { createTunnelHost } from '@chatterang/tunnel/host';", '@chatterang/tunnel/host'],
      ["import type { TunnelHost } from '@chatterang/tunnel';", '@chatterang/tunnel'],
      ["export { listen } from '@chatterang/tunnel/host/listener';", '@chatterang/tunnel/host/listener'],
      ["import '@chatterang/tunnel/host';", '@chatterang/tunnel/host'],
      [
        "const h = await import('../../packages/tunnel/src/host/index');",
        '../../packages/tunnel/src/host/index',
      ],
      ["const h = require(`@chatterang/tunnel/host`);", '@chatterang/tunnel/host'],
    ];
    for (const [form, specifier] of onnxForms) {
      const found = [...form.matchAll(new RegExp(SPECIFIER.source, 'g'))].map((m) => m[1]);
      expect(found, form).toContain(specifier);
      expect(onnxBan.test(specifier), `${form} -> ${specifier}`).toBe(true);
    }

    // And the control: a name that merely LOOKS like one of them is not banned,
    // so the rule is a rule and not a substring search.
    //
    // The tunnel's ALLOWED entry points are controls in the strongest sense
    // here: a ban that swallowed them would not merely be over-broad, it would
    // make the package useless to `src/`, which is the half of #155 that has to
    // work. `tunnel-host-web` is the lookalike — a name that starts with the
    // banned string and is a different package.
    for (const allowed of [
      'onnxruntime-web',
      '@chatterang/contracts',
      'node-llama-cpp-web',
      '@chatterang/tunnel/client',
      '@chatterang/tunnel/wire',
      '../../packages/tunnel/src/client/index',
      '../../packages/tunnel/src/wire/index',
      '@chatterang/tunnel-host-web',
    ]) {
      expect(onnxBan.test(allowed), allowed).toBe(false);
    }

    // The shell-app ban, spelled the same way and revert-checked the same way.
    // The `@chatterang/server` forms are the ones the previous version of this
    // regex missed, so they are named individually rather than trusted to a
    // shared alternation.
    const shellBan =
      /^@chatterang\/(desktop|server)(\/|$)|(^|\/)apps\/(desktop|server)(\/|$)|^electron($|\/)|(^|\/)node_modules(\/|$)/;
    const shellForms: [string, string][] = [
      ["import { startServer } from '@chatterang/server';", '@chatterang/server'],
      ["import { SERVED_CSP } from '@chatterang/server/policy';", '@chatterang/server/policy'],
      ["const s = await import('../../apps/server/src/index');", '../../apps/server/src/index'],
      ["import { PluginHost } from '@chatterang/desktop/bridge';", '@chatterang/desktop/bridge'],
      ["const m = require('../apps/desktop/src/main');", '../apps/desktop/src/main'],
    ];
    for (const [form, specifier] of shellForms) {
      const found = [...form.matchAll(new RegExp(SPECIFIER.source, 'g'))].map((m) => m[1]);
      expect(found, form).toContain(specifier);
      expect(shellBan.test(specifier), `${form} -> ${specifier}`).toBe(true);
    }
    for (const allowed of ['@chatterang/contracts', 'apps-server-helpers', '@chatterang/servers']) {
      expect(shellBan.test(allowed), allowed).toBe(false);
    }
  });
});

/**
 * The platform seam: one file may name a platform, and it is not the four that
 * used to.
 *
 * Every platform decision in `src/` was a BOOLEAN — `Capacitor
 * .isNativePlatform()`, which is `getPlatform() !== 'web'` — at four sites
 * written when there were two platforms. The desktop shell reports
 * `'electron'`, so the boolean answered TRUE and all four took the NATIVE path
 * on a platform that implements only part of what native means. One of them
 * (`download.ts`) wrote every model into IndexedDB, where the inference host
 * could never read it.
 *
 * The fix is a capability table in `src/lib/platform.ts`. This guard is what
 * keeps it the only one: the FIFTH site fails here the day it is written,
 * rather than the day someone runs the desktop build and notices a feature
 * silently doing nothing.
 */
describe('only the platform seam names a platform', () => {
  const SEAM = 'lib/platform.ts';

  /** A CALL to Capacitor's platform accessors, in either spelling. */
  const NAMES_A_PLATFORM = /\bCapacitor\s*\.\s*(isNativePlatform|getPlatform)\b/;

  /**
   * READING THE SEAM'S OWN `id` FIELD — the front door this guard used to hold
   * open.
   *
   * The rule above bans `Capacitor.getPlatform()`, and the table it forced
   * everyone through exposes `id`. So `capabilities().id === 'electron'` is
   * `isNativePlatform()` again with better manners: it typechecks, it reads as
   * principled, it goes through the seam, and it is the SAME mistake. This
   * file previously listed `const platform = capabilities().id;` as an ALLOWED
   * form — a matcher assertion that read as a sanction, and would have been
   * one the first time A7 wanted "is this desktop chrome?" for a keyboard
   * shortcut or a density switch.
   *
   * It is wrong on the merits and not merely on principle. An Electron window
   * can be 400 px wide; an iPad can be 1200 px on a trackpad; a phone can have
   * a Bluetooth keyboard. Viewport and input are MEDIA QUERIES —
   * `hasFinePointer()`, `matchMedia('(min-width: …)')` — asked of the browser
   * at the moment they matter, not of a table fixed before the bundle loaded.
   *
   * TWO DOORS, because a property read is not the only way to reach a field.
   * `const { id } = capabilities()` gets there without the word `.id` ever
   * following a paren, and a guard that saw only the first spelling would have
   * been a guard against one spelling.
   */
  const BRANCHES_ON_IDENTITY =
    /\bcapabilities\s*\(\s*\)\s*\.\s*id\b|\{[^}]*\bid\b[^}]*\}\s*=\s*capabilities\s*\(\s*\)/;

  /*
   * `codeOf` used to live here. It is in `tests/support/source-scan.ts` now,
   * unchanged, because the tunnel guard and the privacy-copy suite's listen
   * inventory need it too — and the reason it exists is still this
   * rule: the four sites that USED to name a platform now carry comments
   * explaining what they did and why it was wrong. Those comments are the
   * documentation this milestone is made of, and a guard that forbids writing
   * them down is a guard that pushes the explanation out of the code.
   */

  it('finds the seam itself, so this guard is not vacuous', () => {
    // A guard that would pass on a repo where nobody calls Capacitor at all is
    // a guard that proves nothing. The seam MUST name the platform — that is
    // its job — and every other file must not.
    const seam = files.find((file) => rel(file) === SEAM);
    expect(seam, 'src/lib/platform.ts is missing').toBeDefined();
    expect(NAMES_A_PLATFORM.test(codeOf(readFileSync(seam!, 'utf8')))).toBe(true);
  });

  it('no other file in src/ asks Capacitor which platform this is', () => {
    const offenders = files
      .filter((file) => rel(file) !== SEAM)
      .filter((file) => NAMES_A_PLATFORM.test(codeOf(readFileSync(file, 'utf8'))))
      .map((file) => rel(file));
    expect(offenders).toEqual([]);
  });

  it('the matcher sees a call and ignores a comment about one', () => {
    // The recurring failure in this file is a matcher revert-checked only
    // against the form it already caught, so both halves are asserted: what it
    // must see, and what it must not fire on.
    for (const form of [
      'if (Capacitor.isNativePlatform()) return;',
      'const id = Capacitor.getPlatform();',
      'return Capacitor\n  .isNativePlatform();',
      "const f = eval('Capacitor.getPlatform()');",
    ]) {
      expect(NAMES_A_PLATFORM.test(codeOf(form)), form).toBe(true);
    }
    for (const allowed of [
      '// the guard used to be Capacitor.isNativePlatform()',
      '/* Capacitor.getPlatform() answers "electron" here */',
      "capabilities().modelStore === 'filesystem'",
    ]) {
      expect(NAMES_A_PLATFORM.test(codeOf(allowed)), allowed).toBe(false);
    }

    // And the stripper does not eat code: a URL inside a string is not a
    // comment, and what follows it on that line still counts.
    const tricky = "const u = 'https://example.com'; Capacitor.getPlatform();";
    expect(NAMES_A_PLATFORM.test(codeOf(tricky))).toBe(true);
  });

  it('no file in src/ branches on WHICH platform this is, seam included', () => {
    // The seam may NAME a platform — that is its job — but nothing in `src/`,
    // the seam included, may read `capabilities().id` and compare it. The
    // table's own rows are object literals; `capabilities()` is what callers
    // hold, and `.id` on it is a decision site by definition.
    const offenders = files
      .filter((file) => BRANCHES_ON_IDENTITY.test(codeOf(readFileSync(file, 'utf8'))))
      .map((file) => rel(file));
    expect(offenders).toEqual([]);
  });

  it('the identity matcher sees both doors and does not fire on a capability', () => {
    // The failure this file keeps re-learning is a matcher revert-checked only
    // against the spelling it already caught, so both halves are asserted.
    for (const branch of [
      "if (capabilities().id === 'electron') return;",
      'const platform = capabilities().id;',
      'switch (capabilities() . id) {',
      'const { id } = capabilities();',
      'const { modelStore, id } = capabilities();',
      'const { id: host } = capabilities();',
    ]) {
      expect(BRANCHES_ON_IDENTITY.test(codeOf(branch)), branch).toBe(true);
    }

    // Controls. Every other field of the table is the whole point of having
    // one, and `id` on something that is not the seam is just an id.
    for (const allowed of [
      "capabilities().modelStore === 'filesystem'",
      "capabilities().fileHandoff === 'share-sheet'",
      'if (!capabilities().purchases) return false;',
      'const { modelStore } = capabilities();',
      'const { offlineCache, purchases } = capabilities();',
      'void usePersonas.getState().acquire(listing.id);',
      'if (manifest.id === active.id) return;',
      "hasFinePointer() ? 'desktop' : 'touch'",
    ]) {
      expect(BRANCHES_ON_IDENTITY.test(codeOf(allowed)), allowed).toBe(false);
    }
  });

  it('the two pointer questions ask the browser, not the table', () => {
    // The precedent the rule above generalises. Both sites were already
    // correct and both were hand-rolled, which is how the second copy becomes
    // the one someone rewrites as `capabilities().id === 'electron'`.
    const callers = ['features/chat/Composer.tsx', 'features/shell/ShellSheet.tsx'];
    for (const caller of callers) {
      const file = files.find((f) => rel(f) === caller);
      expect(file, `${caller} is missing`).toBeDefined();
      const source = readFileSync(file!, 'utf8');
      expect(source, caller).toContain('hasFinePointer');
      // And not a fourth private copy of the query alongside the helper.
      expect(codeOf(source), caller).not.toContain("matchMedia('(pointer: fine)')");
    }

    // The helper itself is where the query lives, and it lives in the seam.
    const seam = files.find((f) => rel(f) === SEAM);
    expect(readFileSync(seam!, 'utf8')).toContain("'(pointer: fine)'");
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

/**
 * The pairing building blocks have one way in, and it is the seam (#128, #130).
 *
 * `pairingController().available` is false, and whatever offers pairing is
 * meant to key on it. Nothing enforced that. A screen could import the scanner,
 * the pairing half or `getUserMedia` directly, never ask the seam, and ask for
 * a camera for a feature that cannot work — which `src/lib/pairing.ts` says
 * does not happen. That is the Marketplace failure (c8a3082): a gate that held
 * only because nothing had walked around it yet.
 *
 * `tests/pairing-scan.test.ts` reads what the two lib files import. It says
 * nothing about who imports THEM, and its `from '…'` regex does not see
 * `import('…')`. This reads every file in `src/` through `SPECIFIER`, which
 * sees all four doors, and resolves relative paths rather than matching names.
 *
 * `pake` and `binding` are banned with `pairing`: they are the other two halves
 * of the same exchange (the CPace step, and the binding that joins it to the
 * parser), and neither has a use in `src/` outside a pairing controller.
 *
 * WHAT IT CANNOT SEE: the camera half is a NAME, `getUserMedia`. A camera
 * reached another way — `<input type="file" capture>`, which a phone's WebView
 * hands to the system camera, or a native plugin — passes, so neither this nor
 * `src/lib/pairing.ts` claims more than that name.
 *
 * THE FEATURE IS INSIDE THE RULE, BEHIND ONE DOOR. `src/features/pairing/`
 * holds the sheet and its entry, so ALLOWED includes it. That would be a second
 * way in if anything could import it, so the rules after the matcher's own
 * test hold the door: only `SettingsScreen.tsx` imports the feature, only its
 * `PairingEntry`, and only `PairingEntry` reads `pairingController()`. The one
 * component that renders nothing while `available` is false is the only way
 * onto a screen, and `tests/pairing-entry.test.tsx` renders it to show it.
 */
describe('only the pairing seam reaches the pairing building blocks', () => {
  const FEATURE = 'features/pairing/';
  const ALLOWED = new Set([
    'lib/pairing.ts',
    'lib/qr-scan.ts',
    'lib/qr-decode.ts',
    // The sheet and its entry, safe only because of the door rule below.
    ...files.map(rel).filter((file) => file.startsWith(FEATURE)),
  ]);
  const BLOCKS = new Set(['lib/pairing', 'lib/qr-scan', 'lib/qr-decode']);
  const TUNNEL_PAIRING =
    /^@chatterang\/tunnel\/(?:pairing|pake|binding)(?:\/|$)|(?:^|\/)packages\/tunnel\/(?:src\/)?(?:pairing|pake|binding)(?:\/|$)/;
  const CAMERA = /\b(?:webkit|moz)?getusermedia\b/i;

  const scanned = files;

  /** The module a specifier names, as a path under `src/` with no extension — or null. */
  const inSrc = (file: string, specifier: string): string | null => {
    const target = specifier.startsWith('@/')
      ? resolve(SRC, specifier.slice(2))
      : specifier.startsWith('.')
        ? resolve(file, '..', specifier)
        : null;
    if (target === null) return null;
    return relative(SRC, target)
      .replaceAll('\\', '/')
      .replace(/\.(?:[cm]?[jt]s|[jt]sx)$/, '')
      .replace(/\/index$/, '');
  };

  /** Each way this file reaches pairing: the specifier, or `getUserMedia`. */
  const reaches = (file: string, source: string): string[] => {
    const code = codeOf(source);
    const doors = [...code.matchAll(new RegExp(SPECIFIER.source, 'g'))]
      .map((match) => match[1] ?? '')
      .filter((specifier) => TUNNEL_PAIRING.test(specifier) || BLOCKS.has(inSrc(file, specifier) ?? ''));
    return CAMERA.test(code) ? [...doors, 'getUserMedia'] : doors;
  };

  it('finds the seam and the scanner reaching them, so the rule is not vacuous', () => {
    expect(scanned.length).toBeGreaterThan(30);
    const reachers = scanned.filter((file) => reaches(file, readFileSync(file, 'utf8')).length > 0).map(rel);
    expect(reachers).toEqual(expect.arrayContaining(['lib/pairing.ts', 'lib/qr-scan.ts']));
  });

  it('no other file in src/ imports the pairing half or the scanner, or names getUserMedia', () => {
    const offenders = scanned
      .filter((file) => !ALLOWED.has(rel(file)))
      .flatMap((file) => reaches(file, readFileSync(file, 'utf8')).map((door) => `${rel(file)} -> ${door}`));
    expect(
      offenders,
      'Something in src/ reached pairing without the seam. Whatever offers pairing goes through ' +
        '`pairingController()` and renders nothing while `available` is false; if this is that ' +
        'entry point, widen ALLOWED to it here, in the same change, and say why.',
    ).toEqual([]);
  });

  it('the matcher sees every door, resolves relative paths, and ignores a comment', () => {
    // Asserted from a screen's position, because that is where a second door
    // would be written.
    const at = resolve(SRC, 'features/chat/X.tsx');
    for (const door of [
      "import { pairingController } from '@/lib/pairing';",
      "const m = await import('@/lib/qr-scan');",
      "import { decodeFrame } from '../../lib/qr-decode';",
      "export { openCamera } from '@/lib/qr-scan.js';",
      "const { parsePairingUri } = require('@chatterang/tunnel/pairing');",
      "import { cpace } from '@chatterang/tunnel/pake';",
      "import { bind } from '@chatterang/tunnel/binding';",
      "const p = await import('../../../packages/tunnel/src/pairing/index');",
      'const s = await navigator.mediaDevices.getUserMedia({ video: true });',
      "const s = navigator.mediaDevices['getUserMedia'];",
    ]) {
      expect(reaches(at, door), door).not.toEqual([]);
    }
    for (const allowed of [
      '// `getUserMedia` needs a secure origin',
      "/* import('@/lib/qr-scan') once the sheet exists */",
      "import { capabilities } from '@/lib/platform';",
      "import { encodeFrame } from '@chatterang/tunnel/wire';",
      "import { copy } from '@/lib/pairing-copy';",
      // Resolved, not matched by name: from features/chat this is a sibling.
      "import { x } from './pairing';",
    ]) {
      expect(reaches(at, allowed), allowed).toEqual([]);
    }
  });

  /** Each module under the pairing feature a file imports, as a path under `src/`. */
  const entries = (file: string, source: string): string[] =>
    [...codeOf(source).matchAll(new RegExp(SPECIFIER.source, 'g'))]
      .map((match) => inSrc(file, match[1] ?? ''))
      .filter((target): target is string => target !== null && `${target}/`.startsWith(FEATURE));

  const DOOR = 'features/settings/SettingsScreen.tsx -> features/pairing/PairingEntry';

  it('the pairing feature has one door: SettingsScreen imports PairingEntry, and nothing else comes in', () => {
    const doors = scanned
      .filter((file) => !rel(file).startsWith(FEATURE))
      .flatMap((file) => entries(file, readFileSync(file, 'utf8')).map((target) => `${rel(file)} -> ${target}`));
    expect(doors, 'SettingsScreen no longer mounts the entry, so the rule below checks nothing').toContain(DOOR);
    expect(
      doors.filter((door) => door !== DOOR),
      'Something reached the pairing feature past its entry. PairingEntry renders nothing while ' +
        '`pairingController().available` is false; any other import of the feature is a way onto a ' +
        'screen that never asks.',
    ).toEqual([]);
  });

  it('inside the feature, only PairingEntry reads the accessor', () => {
    // The sheet takes the controller as a prop. A second reader would be a
    // second gate, and two gates drift.
    const readers = scanned
      .filter((file) => rel(file).startsWith(FEATURE))
      .filter((file) => /\bpairingController\b/.test(codeOf(readFileSync(file, 'utf8'))))
      .map(rel);
    expect(readers).toEqual(['features/pairing/PairingEntry.tsx']);
  });

  it('the door matcher resolves the feature however it is named, and ignores a comment', () => {
    const settings = resolve(SRC, 'features/settings/SettingsScreen.tsx');
    const chat = resolve(SRC, 'features/chat/X.tsx');
    expect(entries(settings, "import { PairingEntry } from '@/features/pairing/PairingEntry';")).toEqual([
      'features/pairing/PairingEntry',
    ]);
    for (const [at, door] of [
      [settings, "import { PairingSheet } from '@/features/pairing/PairingSheet';"],
      [settings, "const Sheet = lazy(() => import('../pairing/PairingSheet'));"],
      [chat, "import { PairingEntry } from '@/features/pairing/PairingEntry';"],
      [chat, "export * from '@/features/pairing';"],
      [chat, "import { pairedMessage } from '../pairing/wording.ts';"],
    ] as const) {
      expect(entries(at, door), door).not.toEqual([]);
    }
    for (const [at, allowed] of [
      // Resolved: from features/chat this is features/chat/pairing.
      [chat, "import { x } from './pairing/PairingSheet';"],
      [chat, "// import { PairingSheet } from '@/features/pairing/PairingSheet';"],
      [settings, "import { x } from '@/features/pairings';"],
    ] as const) {
      expect(entries(at, allowed), allowed).toEqual([]);
    }
  });
});
