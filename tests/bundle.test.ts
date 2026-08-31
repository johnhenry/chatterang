/**
 * Build-integrity guards.
 *
 * These exist because `npm run build:web` exited 0 while shipping an app that
 * was blank on every page, in the browser as well as in the desktop shell.
 *
 * `@johnhenry/aimatey-backend-browser` declares `@litert-lm/core` as an
 * OPTIONAL peer dependency and imports it lazily, so the package is built to
 * work without it. The bundler resolved that lazy import anyway and, on
 * failing, emitted a stub that throws during module evaluation — taking the
 * whole bundle down before React could mount. Nothing caught it: the build
 * succeeded, the tests passed, and only loading the page revealed it.
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(process.cwd());
const MODULES = join(ROOT, 'node_modules');

/** Optional peers our own dependencies declare, that are NOT installed. */
function uninstalledOptionalPeers(): string[] {
  const out = new Set<string>();
  for (const scope of ['@johnhenry']) {
    const dir = join(MODULES, scope);
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      const manifest = join(dir, name, 'package.json');
      if (!existsSync(manifest)) continue;
      const meta = JSON.parse(readFileSync(manifest, 'utf8')).peerDependenciesMeta ?? {};
      for (const [peer, value] of Object.entries(meta)) {
        if ((value as { optional?: boolean })?.optional && !existsSync(join(MODULES, peer))) {
          out.add(peer);
        }
      }
    }
  }
  return [...out];
}

describe('the web bundle cannot ship an unresolved optional peer', () => {
  it('externalises every optional peer that is not installed', () => {
    // An optional peer that is neither installed nor externalised is one the
    // bundler will try to resolve and fail on. Whether that failure is fatal
    // depends on where the import sits in the graph — which is not a thing to
    // leave to luck, because when it is fatal the whole app is blank and the
    // build still reports success.
    const config = readFileSync(join(ROOT, 'vite.config.ts'), 'utf8');
    const externalBlock = /external:\s*\[([^\]]*)\]/.exec(config)?.[1] ?? '';
    const patterns = [...externalBlock.matchAll(/\/\^([^/\\]*(?:\\.[^/\\]*)*)\\?\//g)].map((m) =>
      m[1]!.replace(/\\\//g, '/'),
    );

    const unguarded = uninstalledOptionalPeers().filter(
      (peer) => !patterns.some((prefix) => peer.startsWith(prefix)),
    );
    expect(unguarded).toEqual([]);
  });

  it('leaves no unresolved-import stub in the built output', () => {
    // Only meaningful once dist/ exists; `npm run verify` builds before this
    // matters, and a fresh checkout should not fail for want of an artefact.
    const assets = join(ROOT, 'dist', 'assets');
    if (!existsSync(assets)) return;

    const offenders = readdirSync(assets)
      .filter((file) => file.endsWith('.js'))
      .filter((file) => /Could not resolve "[^"]+"/.test(readFileSync(join(assets, file), 'utf8')))
      .sort();
    expect(offenders).toEqual([]);
  });
});

describe('every source file on disk is a source file in git', () => {
  it('tracks all of src, packages and apps/desktop/src', () => {
    /*
     * `.gitignore` carried an unanchored `models/` rule for downloaded weights.
     * It also matched `src/features/models/`, so four UI source files were
     * silently untracked: a fresh clone could not build them, and every green
     * test run in this repo was measured against a working tree that git did
     * not have. Nothing noticed, because the local tree was always complete.
     *
     * This compares the two sources of truth directly, which is the only check
     * that could have caught it.
     */
    const roots = ['src', 'packages', 'apps/desktop/src'];
    const onDisk = new Set<string>();
    const walk = (dir: string): void => {
      if (!existsSync(dir)) return;
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = `${dir}/${entry.name}`;
        if (entry.isDirectory()) {
          if (entry.name === 'node_modules' || entry.name === 'dist') continue;
          walk(full);
        } else if (/\.(ts|tsx|css)$/.test(entry.name)) {
          onDisk.add(full);
        }
      }
    };
    for (const root of roots) walk(root);
    expect(onDisk.size).toBeGreaterThan(60);

    const tracked = new Set(
      execFileSync('git', ['ls-files', ...roots], { encoding: 'utf8' })
        .split('\n')
        .filter((line) => /\.(ts|tsx|css)$/.test(line)),
    );

    const untracked = [...onDisk].filter((file) => !tracked.has(file)).sort();
    expect(untracked).toEqual([]);
  });
});
