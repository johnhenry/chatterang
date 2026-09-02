/**
 * Refuse to start a build that is older than its sources.
 *
 * `server:start` runs `build/server.mjs` directly, so editing a source file and
 * starting the server runs the PREVIOUS build. That is not a stale-artifact
 * annoyance here: A9's own review found the anonymous-bridge fix present in
 * source and absent from the binary the documented start command runs, which is
 * the difference between a security fix applied and a security fix running.
 *
 * A refusal rather than an automatic rebuild, in the house style: rebuilding
 * silently would make `start` sometimes take a minute and sometimes not, and
 * would hide the fact that the operator's tree and their server had diverged.
 */

import { readdirSync, statSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = dirname(here);
const built = join(root, 'build', 'server.mjs');

/** Newest mtime under a directory, or 0 if it does not exist. */
function newest(dir) {
  if (!existsSync(dir)) return 0;
  let latest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    latest = Math.max(latest, entry.isDirectory() ? newest(full) : statSync(full).mtimeMs);
  }
  return latest;
}

if (!existsSync(built)) {
  console.error('server: no build. Run `npm run server:build` first.');
  process.exit(1);
}

// The desktop bridge and the shared packages are compiled into this bundle too,
// so a change to any of them is just as stale as a change to apps/server/src.
const sources = [
  join(root, 'src'),
  join(root, '..', 'desktop', 'src'),
  join(root, '..', '..', 'packages'),
];
const newestSource = Math.max(...sources.map(newest));
const buildTime = statSync(built).mtimeMs;

if (newestSource > buildTime) {
  const age = Math.round((newestSource - buildTime) / 1000);
  console.error(
    `server: build/server.mjs is ${age}s older than its sources — it would run the previous code.\n` +
      '        Run `npm run server:build`.',
  );
  process.exit(1);
}
