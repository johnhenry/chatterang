/**
 * The build that runs must be the build that was fixed.
 *
 * `npm run server:start` executes `apps/server/build/server.mjs` directly. A9's
 * review found the anonymous-bridge fix present in source and ABSENT from that
 * binary — the difference between a security fix applied and a security fix
 * running. Nothing noticed, because nothing compared the two.
 */

import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(process.cwd());
const GUARD = join(ROOT, 'apps/server/scripts/check-fresh.mjs');

/**
 * Run the guard against a synthetic tree.
 *
 * The guard resolves its paths from its OWN location rather than the cwd —
 * which is right, since it must check the tree it ships in — so it has to be
 * copied into the fixture rather than pointed at it.
 */
function runGuard(serverRoot: string): number {
  const scripts = join(serverRoot, 'scripts');
  mkdirSync(scripts, { recursive: true });
  copyFileSync(GUARD, join(scripts, 'check-fresh.mjs'));
  try {
    execFileSync('node', [join(scripts, 'check-fresh.mjs')], { stdio: 'pipe' });
    return 0;
  } catch (error) {
    return (error as { status?: number }).status ?? -1;
  }
}

describe('server:start refuses a build older than its sources', () => {
  it('the guard exists and start actually invokes it', () => {
    // A guard nothing calls is the same defect one layer up.
    expect(existsSync(GUARD)).toBe(true);
    const pkg = JSON.parse(
      execFileSync('cat', [join(ROOT, 'apps/server/package.json')], { encoding: 'utf8' }),
    ) as { scripts: Record<string, string> };
    expect(pkg.scripts.start).toContain('check-fresh.mjs');
  });

  it('refuses when a source file is newer than the build', () => {
    const base = mkdtempSync(join(tmpdir(), 'fresh-'));
    const server = join(base, 'apps', 'server');
    mkdirSync(join(server, 'build'), { recursive: true });
    mkdirSync(join(server, 'src'), { recursive: true });
    mkdirSync(join(base, 'apps', 'desktop', 'src'), { recursive: true });
    mkdirSync(join(base, 'packages'), { recursive: true });
    writeFileSync(join(server, 'build', 'server.mjs'), '// built');
    writeFileSync(join(server, 'src', 'http.ts'), '// source');

    const old = new Date(Date.now() - 60_000);
    utimesSync(join(server, 'build', 'server.mjs'), old, old);
    expect(runGuard(server)).toBe(1);
  });

  it('accepts when the build is newer', () => {
    const base = mkdtempSync(join(tmpdir(), 'fresh-ok-'));
    const server = join(base, 'apps', 'server');
    mkdirSync(join(server, 'build'), { recursive: true });
    mkdirSync(join(server, 'src'), { recursive: true });
    mkdirSync(join(base, 'apps', 'desktop', 'src'), { recursive: true });
    mkdirSync(join(base, 'packages'), { recursive: true });
    writeFileSync(join(server, 'src', 'http.ts'), '// source');
    const old = new Date(Date.now() - 60_000);
    utimesSync(join(server, 'src', 'http.ts'), old, old);
    writeFileSync(join(server, 'build', 'server.mjs'), '// built');

    expect(runGuard(server)).toBe(0);
  });

  it('watches the desktop bridge and packages, not only apps/server/src', () => {
    // Both are compiled INTO this bundle, so a change to either is just as
    // stale. Watching only apps/server/src is how the real staleness was missed
    // when this was first checked by hand.
    const base = mkdtempSync(join(tmpdir(), 'fresh-wide-'));
    const server = join(base, 'apps', 'server');
    mkdirSync(join(server, 'build'), { recursive: true });
    mkdirSync(join(server, 'src'), { recursive: true });
    const desktop = join(base, 'apps', 'desktop', 'src');
    mkdirSync(desktop, { recursive: true });
    mkdirSync(join(base, 'packages'), { recursive: true });
    writeFileSync(join(server, 'src', 'http.ts'), '// source');
    writeFileSync(join(server, 'build', 'server.mjs'), '// built');
    const old = new Date(Date.now() - 60_000);
    utimesSync(join(server, 'build', 'server.mjs'), old, old);
    utimesSync(join(server, 'src', 'http.ts'), old, old);
    // Only the DESKTOP source is new.
    writeFileSync(join(desktop, 'bridge.ts'), '// newer');

    expect(runGuard(server)).toBe(1);
  });
});
