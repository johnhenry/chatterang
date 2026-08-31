/**
 * ONE PROCESS PER ENGINE, and the guard on the thing that makes it worth doing.
 *
 * The inference host is one bundled entry point forked twice, and each fork
 * loads exactly one engine through a dynamic `import()` chosen by `argv[3]`.
 * That dynamism is not a style: it is the whole of the split's second benefit.
 *
 * WHY THE ONNX HOST MUST NOT LOAD node-llama-cpp. Importing node-llama-cpp
 * registers a SIGTERM listener (and a SIGINT one) on the process, and a JS
 * signal listener REPLACES the OS default action with a callback — a callback
 * that cannot run while a synchronous native call holds the event loop. So a
 * process that has loaded it survives `kill()` until its blocking call
 * returns. Measured on this machine, same child, SIGTERM sent 1000 ms into a
 * ~2 s ONNX run:
 *
 *   onnxruntime alone                     -> exited after 24 ms
 *   onnxruntime + node-llama-cpp imported -> ran the whole 2112 ms and exited
 *                                            1136 ms after the signal
 *   SIGKILL                               -> 26 ms in both
 *
 * The premise was re-measured for this change, inside a real headless Electron
 * `utilityProcess` on this machine — no BrowserWindow, `app.exit(0)` at the
 * end — by counting listeners as each addon is imported:
 *
 *   baseline                 SIGTERM 0, SIGINT 0
 *   after onnxruntime-node   SIGTERM 0, SIGINT 0
 *   after node-llama-cpp     SIGTERM 1, SIGINT 1
 *
 * Electron's `utilityProcess.kill()` is documented as SIGTERM with no signal
 * parameter, so that one listener is the difference between a host that can be
 * preempted mid-run and one that cannot. `OnnxRuntimeNode.cancel`
 * only sets a flag that `runWhisper` checks BETWEEN runs, so killing the host
 * is the ONLY thing that can preempt a run in progress — and it only works on
 * a host that never imported node-llama-cpp.
 *
 * THIS IS THE REGRESSION SHAPE THE BRIEF WARNS ABOUT. One `import` added to
 * `onnx-engine.ts` for convenience takes that guarantee away, changes no
 * behaviour any other test observes, and leaves the whole suite green. The
 * same is true of removing `splitting: true` from the host build: esbuild
 * keeps a local dynamic import lazy but HOISTS every EXTERNAL import to the
 * top of a single-file bundle as a static `import` statement, so the ONNX host
 * would load `@deepseek-ai/*` and `@johnhenry/aimatey-core` at startup for an
 * engine with no route to any of them.
 *
 * So this file checks both levels, and neither is a restatement of the other:
 *
 *   1. THE SOURCE import graph, walked statically from each engine module.
 *   2. THE BUILT output, by RUNNING `apps/desktop/scripts/build.mjs` — the
 *      real shipped build script, not a copy of its options — and walking the
 *      chunk graph it emits.
 *
 * (2) is what actually describes the running process, and it is the one that
 * catches a bundler-configuration mistake that (1) cannot see.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(process.cwd());
const DESKTOP = join(ROOT, 'apps/desktop');
const HOST = join(DESKTOP, 'src/host');

/* ── 1. The source import graph ───────────────────────────────────────── */

/**
 * The module specifiers one file imports, split by how.
 *
 * The distinction is the whole subject: a STATIC import runs in every process
 * that loads the module, while a DYNAMIC one runs only on the branch that asks
 * for it. `entry.ts` picks its engine with the second kind, which is what
 * makes one bundle serve two processes.
 *
 * The static clause is deliberately restricted to characters that can appear
 * in an import clause — no `.`, no backtick, no parenthesis — because the
 * first version used `[\s\S]*?` and matched from a real `import` line down
 * into a COMMENT containing the words "from '@chatterang/inference-node'".
 * That comment is in `entry.ts`, it is describing the mistake this file
 * exists to prevent, and the walker reported it as an import. A prose match
 * would have made every assertion below pass or fail for the wrong reason.
 *
 * `import type` alone is excluded: it is erased and loads nothing. Only that
 * exact form — `import { type X, value }` still loads the module.
 */
function moduleEdges(source: string): { statics: string[]; dynamics: string[] } {
  const statics: string[] = [];
  const clause = /^[ \t]*(?:import|export)[ \t]+((?:type[ \t]+)?[\w${}*,\s]*?)[ \t\n]*from[ \t]*['"]([^'"]+)['"]/gm;
  for (const match of source.matchAll(clause)) {
    if (/^type[ \t]+$/.test(match[1] ?? '')) continue;
    statics.push(match[2]!);
  }
  for (const match of source.matchAll(/^[ \t]*import[ \t]*['"]([^'"]+)['"]/gm)) {
    statics.push(match[1]!);
  }
  return {
    statics,
    dynamics: [...source.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]!),
  };
}

/** The repo's own aliases, resolved the way the desktop build resolves them. */
function resolveSpecifier(from: string, specifier: string): string | null {
  let base: string | null = null;
  if (specifier.startsWith('.')) {
    base = resolve(dirname(from), specifier.replace(/\.js$/, ''));
  } else if (specifier.startsWith('@chatterang/')) {
    base = join(ROOT, 'packages', specifier.slice('@chatterang/'.length), 'src/index');
  } else if (specifier.startsWith('@/')) {
    base = join(ROOT, 'src', specifier.slice(2));
  }
  if (base === null) return null;
  for (const candidate of [`${base}.ts`, `${base}.tsx`, base, join(base, 'index.ts')]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/**
 * Every package ONE module can reach — by any path, at any time.
 *
 * Local edges are followed only when they are STATIC, because a module that
 * is never statically reachable is never in this process at all. Package
 * specifiers are collected from BOTH kinds, and that is deliberate: both
 * native addons are loaded through a dynamic `import()` inside their own
 * wrapper (`inference-node/src/node-llama-cpp.ts:127`,
 * `onnx-node/src/onnxruntime-node.ts:85`), so counting only static ones would
 * report `node-llama-cpp` absent from the LLAMA host and make every assertion
 * below vacuously true.
 *
 * So the claim this function supports is the strong one: not "the ONNX host
 * does not load node-llama-cpp at startup" but "no code path in the ONNX host
 * can load it at all", which is what actually keeps the SIGTERM listener out.
 */
function reachablePackages(entry: string): Set<string> {
  const packages = new Set<string>();
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const { statics, dynamics } = moduleEdges(readFileSync(file, 'utf8'));
    for (const specifier of statics) {
      const resolved = resolveSpecifier(file, specifier);
      if (resolved === null) packages.add(specifier);
      else queue.push(resolved);
    }
    for (const specifier of dynamics) {
      if (resolveSpecifier(file, specifier) === null) packages.add(specifier);
    }
  }
  return packages;
}

/** Anything whose presence in a process means node-llama-cpp is in it. */
const LLAMA_ONLY = ['node-llama-cpp', '@chatterang/inference-node'];

describe('the ONNX host loads nothing of llama.cpp', () => {
  it('is looking at real files with real imports in them', () => {
    // The CONTROL. Every assertion below is an absence, and an absence is what
    // a broken walker reports for everything — a typo'd path, a regex that
    // matches nothing, a resolver that swallows the queue. So first: the
    // walker finds what is definitely there.
    const llama = reachablePackages(join(HOST, 'llama-engine.ts'));
    expect(llama).toContain('@johnhenry/aimatey-core');
    expect([...llama].some((name) => name.startsWith('@deepseek-ai/'))).toBe(true);
    // And it reaches the engine package, which is three files deep from here:
    // llama-engine.ts -> @chatterang/inference-node -> llama-cpp.ts ->
    // node-llama-cpp.ts. A walker that stopped at the first hop would report
    // this absent and would report every assertion below "clean" too.
    expect(llama).toContain('node-llama-cpp');
  });

  it('onnx-engine.ts reaches neither node-llama-cpp nor the package that loads it', () => {
    // FAULT INJECTED: adding `import { LlamaCppNode } from
    // '@chatterang/inference-node';` to `onnx-engine.ts` fails this
    // (`['@chatterang/inference-node', 'node-llama-cpp']` for `[]`). Without
    // this test that import changes nothing any other assertion can see.
    const onnx = reachablePackages(join(HOST, 'onnx-engine.ts'));
    expect(onnx).toContain('onnxruntime-node');
    expect(LLAMA_ONLY.filter((name) => onnx.has(name))).toEqual([]);
    // The Cordis tree too. It mounts only in the llama host, and dragging it
    // in would cost the ONNX process eight packages it has no route to.
    expect([...onnx].filter((name) => name.startsWith('@deepseek-ai/'))).toEqual([]);
  });

  it('entry.ts reaches NEITHER engine statically — both are behind the selector', () => {
    // The entry point is loaded by both processes, so a static import here is
    // a static import in both of them. This is the assertion that says the
    // `await import()` pair at the bottom of `main()` is doing real work.
    //
    // FAULT INJECTED: replacing the `await import('./llama-engine.js')` with a
    // top-level static import fails this (received the whole llama closure).
    const entry = reachablePackages(join(HOST, 'entry.ts'));
    expect([...entry].filter((name) => !name.startsWith('node:'))).toEqual([]);
    // …and reaches BOTH engines dynamically, which is the half an empty set
    // cannot distinguish from an entry point that mounts no engine at all.
    const { dynamics } = moduleEdges(readFileSync(join(HOST, 'entry.ts'), 'utf8'));
    expect(dynamics).toEqual(['./llama-engine.js', './onnx-engine.js']);
  });

  it('host-engine.ts, which both engines import, imports neither of them', () => {
    // The shared type module. If it imported either engine for a type, the
    // next author needing a VALUE would drop the `type` keyword and both hosts
    // would load both addons — with nothing failing.
    // Asserted against the IMPORT LIST, not the file text: this module's
    // header names both engines in prose, and a `toContain` check would have
    // been failing on a comment rather than on an edge.
    const { statics, dynamics } = moduleEdges(readFileSync(join(HOST, 'host-engine.ts'), 'utf8'));
    expect([...statics, ...dynamics].filter((s) => /-engine/.test(s))).toEqual([]);
    expect(reachablePackages(join(HOST, 'host-engine.ts'))).toEqual(new Set());
  });
});

/* ── 2. The built output, from the real build script ──────────────────── */

/**
 * The packages ONE fork of the host can reach.
 *
 * Seeded with `host.mjs` and this engine's chunk. Local edges are followed
 * when static; the entry's two `import('./host-<engine>-engine-*.mjs')` calls
 * are the selector itself and are deliberately NOT followed, because the whole
 * claim is that the other one is never asked for. Package specifiers are
 * collected from both kinds, for the reason `reachablePackages` states.
 */
function loadedBy(buildDir: string, engineChunk: string): Set<string> {
  const packages = new Set<string>();
  const seen = new Set<string>();
  const queue = ['host.mjs', engineChunk];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const { statics, dynamics } = moduleEdges(readFileSync(join(buildDir, file), 'utf8'));
    for (const specifier of statics) {
      if (specifier.startsWith('.')) queue.push(specifier.replace(/^\.\//, ''));
      else packages.add(specifier);
    }
    for (const specifier of dynamics) {
      if (!specifier.startsWith('.')) packages.add(specifier);
    }
  }
  return packages;
}

describe('the built host, as the two processes actually load it', () => {
  const buildDir = join(DESKTOP, 'build');

  // THE REAL SHIPPED BUILD SCRIPT, run rather than described. Asserting
  // against a copy of its esbuild options would be asserting that a duplicate
  // of the thing under test agrees with itself; this way a change to
  // `scripts/build.mjs` is what these assertions see. It takes ~60 ms.
  execFileSync('node', ['scripts/build.mjs'], { cwd: DESKTOP, stdio: 'pipe' });

  const chunks = readdirSync(buildDir).filter((f) => f.endsWith('.mjs'));
  const chunkFor = (engine: string): string => {
    const found = chunks.find((f) => f.startsWith(`host-${engine}-engine-`));
    if (found === undefined) {
      throw new Error(
        `no emitted chunk for the ${engine} engine. Found: ${chunks.join(', ')}. ` +
          'A single-file host bundle means both engines load in both processes.',
      );
    }
    return found;
  };

  it('emits one chunk per engine, which is what makes the fork lazy', () => {
    // CONTROL, and the thing `splitting: true` buys. Without it esbuild emits
    // one `host.mjs` with every external import hoisted to the top.
    expect(chunkFor('llama')).toBeTruthy();
    expect(chunkFor('onnx')).toBeTruthy();
    // And the entry reaches them ONLY dynamically.
    const entry = moduleEdges(readFileSync(join(buildDir, 'host.mjs'), 'utf8'));
    expect(entry.dynamics.some((d) => d.includes('llama-engine'))).toBe(true);
    expect(entry.dynamics.some((d) => d.includes('onnx-engine'))).toBe(true);
    expect(entry.statics.filter((s) => /engine/.test(s))).toEqual([]);
  });

  it('the llama fork loads node-llama-cpp and the ONNX fork does not', () => {
    const llama = loadedBy(buildDir, chunkFor('llama'));
    const onnx = loadedBy(buildDir, chunkFor('onnx'));

    // CONTROL first: the llama fork really does load it, so "absent from the
    // ONNX fork" is a fact about the ONNX fork and not about this walker.
    expect(llama).toContain('node-llama-cpp');
    expect(onnx).toContain('onnxruntime-node');

    // THE GUARANTEE. A SIGTERM listener in this process is what would stop
    // `kill()` preempting a blocking `InferenceSession.run`.
    expect(onnx.has('node-llama-cpp')).toBe(false);
    // And the eight packages of the Cordis tree, which is the RSS half.
    expect([...onnx].filter((n) => n.startsWith('@deepseek-ai/'))).toEqual([]);
    expect([...onnx].filter((n) => n.startsWith('@johnhenry/'))).toEqual([]);
    // The reverse is true too, and cheap to say: the llama host has no reason
    // to map a second native runtime's binary.
    expect(llama.has('onnxruntime-node')).toBe(false);
  });

  it('main.ts forks the same one entry point for both', () => {
    // The split would also be undone by growing a second entry point that
    // main forks by name — the chunking above would still pass. `host.mjs` is
    // the only host path main knows.
    const main = readFileSync(join(DESKTOP, 'src/main.ts'), 'utf8');
    const forks = [...main.matchAll(/utilityProcess\.fork\(/g)];
    expect(forks).toHaveLength(1);
    expect(main).toContain("'build', 'host.mjs'");
    expect(existsSync(join(buildDir, 'host.mjs'))).toBe(true);
  });
});
