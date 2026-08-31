/**
 * Bundle the three Electron entry points.
 *
 * `packages/inference-node` exports raw TypeScript (`"exports": {".":
 * "./src/index.ts"}`) with no `dist/` and no build step, so Electron cannot
 * import it directly and something has to transpile. esbuild does it in
 * milliseconds, which is why there is no tsc emit step here — `npm run
 * typecheck` at the repo root is what checks these files, and it already
 * includes `apps/desktop/src`.
 *
 * WHAT STAYS EXTERNAL, AND WHY EACH ONE:
 *
 *   electron          — supplied by the runtime; bundling it is meaningless.
 *   node-llama-cpp    — must resolve to the real prebuilt package so its
 *                       platform binary is found. Inlining it would break the
 *                       `.node` lookup entirely.
 *   onnxruntime-node  — same, and more so: its `.node` binding is found by a
 *                       path built from `__dirname` (`bin/napi-v6/<platform>/
 *                       <arch>/`), and the binding then loads
 *                       `@rpath/libonnxruntime.1.dylib` beside itself. Move
 *                       either and the require fails at run time, not at
 *                       build time.
 *   @deepseek-ai/*    — `dsh-llm` does `createRequire(import.meta.url)
 *                       ('../package.json')` at runtime. Single-file bundling
 *                       moves the module and that read fails.
 *   @johnhenry/*      — large, pure JS, and no reason to duplicate.
 */

import { rm, mkdir } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as esbuild from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const desktop = resolve(here, '..');
const repo = resolve(desktop, '../..');
const out = join(desktop, 'build');

/**
 * Resolve the repo's own path aliases, the same ones tsconfig and vite use.
 *
 * `@/ai/prompt` in particular: the inference host imports the app's chat
 * template renderer rather than copying it, so a conversation produces
 * byte-identical prompt text on desktop and on mobile. That module is pure —
 * its only imports are types — which is what makes the import safe in a Node
 * process. The direction is `apps/desktop -> src`, which is the allowed one.
 */
const aliasPlugin = {
  name: 'chatterang-aliases',
  setup(build) {
    const map = [
      [/^@chatterang\/contracts$/, join(repo, 'packages/contracts/src/index.ts')],
      [/^@chatterang\/contracts\/(.*)$/, join(repo, 'packages/contracts/src/$1.ts')],
      [/^@chatterang\/inference-node$/, join(repo, 'packages/inference-node/src/index.ts')],
      [/^@chatterang\/onnx-node$/, join(repo, 'packages/onnx-node/src/index.ts')],
      [/^@chatterang\/cordis-aimatey$/, join(repo, 'packages/cordis-aimatey/src/index.ts')],
      [/^@\/(.*)$/, join(repo, 'src/$1')],
    ];
    build.onResolve({ filter: /^(@chatterang\/|@\/)/ }, (args) => {
      for (const [pattern, target] of map) {
        const match = pattern.exec(args.path);
        if (match === null) continue;
        const base = target.replace('$1', match[1] ?? '');
        // A path returned from onResolve is FINAL: esbuild does not then try
        // extensions on it. `@/ai/prompt` has none, so the candidates are
        // tried here. (Found the hard way — the first version of this plugin
        // failed with "Cannot read file: .../src/ai/prompt".)
        for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts')]) {
          if (existsSync(candidate) && statSync(candidate).isFile()) return { path: candidate };
        }
        throw new Error(`desktop build: cannot resolve "${args.path}" (tried ${base}[.ts|.tsx|/index.ts])`);
      }
      return null;
    });
  },
};

const shared = {
  bundle: true,
  platform: 'node',
  target: 'node22',
  sourcemap: true,
  logLevel: 'info',
  plugins: [aliasPlugin],
  resolveExtensions: ['.ts', '.tsx', '.mjs', '.js', '.json'],
};

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

await esbuild.build({
  ...shared,
  entryPoints: [join(desktop, 'src/main.ts')],
  outfile: join(out, 'main.cjs'),
  format: 'cjs',
  external: ['electron'],
});

await esbuild.build({
  ...shared,
  entryPoints: [join(desktop, 'src/preload.ts')],
  outfile: join(out, 'preload.cjs'),
  format: 'cjs',
  external: ['electron'],
});

/*
 * The inference host, CODE-SPLIT — and the splitting is load-bearing.
 *
 * One entry point, forked twice with different arguments; `entry.ts` picks its
 * engine with a dynamic `import()`. In a single-file ESM bundle that choice is
 * only half real: esbuild keeps a local dynamic import lazy, but it HOISTS
 * every EXTERNAL import to the top of the file as a static `import` statement.
 * Built that way, the ONNX host still loaded `@deepseek-ai/cordis`,
 * `@deepseek-ai/dsh-llm`, `@deepseek-ai/dsh-invariants` and
 * `@johnhenry/aimatey-core` at startup — verified by reading the emitted
 * `host.mjs` — for an engine that has no route to any of them.
 *
 * With `splitting`, each dynamically imported branch becomes its own chunk and
 * its external imports stay inside it. `tests/desktop-host-split.test.ts`
 * asserts, against the built output when it exists, that the entry chunk
 * hoists neither engine's dependencies.
 *
 * `outdir` rather than `outfile` because splitting emits more than one file;
 * `out: 'host'` plus the `.mjs` extension keeps the path `main.ts` forks
 * (`build/host.mjs`) exactly as it was.
 */
await esbuild.build({
  ...shared,
  entryPoints: [{ in: join(desktop, 'src/host/entry.ts'), out: 'host' }],
  outdir: out,
  outExtension: { '.js': '.mjs' },
  format: 'esm',
  splitting: true,
  chunkNames: 'host-[name]-[hash]',
  external: ['node-llama-cpp', 'onnxruntime-node', '@deepseek-ai/*', '@johnhenry/*'],
});

console.log('desktop: built main.cjs, preload.cjs, host.mjs');
