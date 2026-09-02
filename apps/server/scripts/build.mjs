/**
 * Bundle the headless server's one entry point.
 *
 * The same arrangement `apps/desktop/scripts/build.mjs` uses and for the same
 * reason: the workspace packages export raw TypeScript with no build step, so
 * something has to transpile before Node can run it, and esbuild does it in
 * milliseconds. `npm run typecheck` at the repo root is what CHECKS these
 * files — it already includes `apps/server/src`.
 *
 * WHAT THIS DOES NOT BUILD: the inference host. `apps/desktop/scripts/build.mjs`
 * emits `host.mjs`, and the server forks that file rather than a second copy of
 * it — one entry point, one bundle, two shells. `main.ts` refuses to start if
 * it is missing and says which command produces it, so a half-built deployment
 * is a boot failure rather than a page whose plugin calls have nowhere to go.
 *
 * WHAT STAYS EXTERNAL, AND WHY: nothing native is reachable from here. The
 * server process holds the http server, the plugin host and the supervisors;
 * every native addon lives on the far side of the fork. `@johnhenry/*` is left
 * external for the same reason the desktop build does — large, pure JS, and no
 * reason to duplicate.
 */

import { rm, mkdir } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/*
 * esbuild, from wherever this checkout actually has it.
 *
 * It is declared as a devDependency of this package, which is where npm will
 * put it on the next install. Until then the only copy in the tree is the one
 * `apps/desktop` was installed with, and a build script that fails with
 * "Cannot find package 'esbuild'" on a fresh checkout of a repo that plainly
 * contains one is a worse first impression than four lines of resolution. The
 * fallback resolves the SAME version — the two packages declare the same range
 * — and disappears the moment `npm install` runs.
 */
const esbuild = await import('esbuild').catch(
  async () => import('../../desktop/node_modules/esbuild/lib/main.js'),
);

const here = dirname(fileURLToPath(import.meta.url));
const app = resolve(here, '..');
const repo = resolve(app, '../..');
const out = join(app, 'build');

/** The repo's own path aliases, the same ones tsconfig and vite resolve. */
const aliasPlugin = {
  name: 'chatterang-aliases',
  setup(build) {
    const map = [
      [/^@chatterang\/contracts$/, join(repo, 'packages/contracts/src/index.ts')],
      [/^@chatterang\/contracts\/(.*)$/, join(repo, 'packages/contracts/src/$1.ts')],
      [/^@chatterang\/desktop\/(.*)$/, join(repo, 'apps/desktop/src/$1')],
      [/^@\/(.*)$/, join(repo, 'src/$1')],
    ];
    build.onResolve({ filter: /^(@chatterang\/|@\/)/ }, (args) => {
      for (const [pattern, target] of map) {
        const match = pattern.exec(args.path);
        if (match === null) continue;
        const base = target.replace('$1', match[1] ?? '');
        // A path returned from onResolve is FINAL: esbuild does not then try
        // extensions on it, so the candidates are tried here.
        for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts')]) {
          if (existsSync(candidate) && statSync(candidate).isFile()) return { path: candidate };
        }
        throw new Error(`server build: cannot resolve "${args.path}" (tried ${base}[.ts|/index.ts])`);
      }
      return null;
    });
  },
};

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

await esbuild.build({
  bundle: true,
  platform: 'node',
  target: 'node22',
  sourcemap: true,
  logLevel: 'info',
  plugins: [aliasPlugin],
  resolveExtensions: ['.ts', '.tsx', '.mjs', '.js', '.json'],
  entryPoints: [{ in: join(app, 'src/main.ts'), out: 'server' }],
  outdir: out,
  outExtension: { '.js': '.mjs' },
  format: 'esm',
  external: ['@johnhenry/*'],
});

console.log('server: built server.mjs');
