/**
 * Copy the built web bundle into the desktop app directory.
 *
 * There is no `npx cap sync` step here, and that is deliberate rather than an
 * omission: Capacitor's Electron platform CLIs hardcode `<repo>/electron` as
 * the platform directory, which contradicts building this under `apps/desktop`
 * alongside the existing layout. The runtime half is all we need, and it reads
 * from `app.getAppPath()` — so this script writes what it reads and nothing
 * scaffolds a directory at the repo root.
 *
 * `dist/` is already `npm run build:web`'s output and already what
 * `capacitor.config.ts`'s `webDir` names, so mobile and desktop consume the
 * byte-identical bundle.
 */

import { cp, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const desktop = resolve(here, '..');
const repo = resolve(desktop, '../..');
const source = join(repo, 'dist');
const target = join(desktop, 'app');

// A packaged build must never carry a dev-server URL: `isTrusted` in main.ts
// prefix-matches against it, and `http://localhost:5273` also prefixes
// `http://localhost:52739`. Refused here rather than left to a habit.
if ((process.env['CHATTERANG_DEV_SERVER_URL'] ?? '') !== '') {
  console.error(
    'desktop: refusing to sync with CHATTERANG_DEV_SERVER_URL set. ' +
      'A packaged build must not carry a dev-server URL.',
  );
  process.exit(1);
}

try {
  const info = await stat(join(source, 'index.html'));
  if (!info.isFile()) throw new Error('not a file');
} catch {
  console.error(`desktop: ${source}/index.html is missing. Run \`npm run build:web\` first.`);
  process.exit(1);
}

await rm(target, { recursive: true, force: true });
await cp(source, target, { recursive: true });
console.log(`desktop: copied ${source} -> ${target}`);
