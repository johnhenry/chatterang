/**
 * Symlink-aware path confinement — the half `confineModelPath` defers.
 *
 * `security.ts:confineModelPath` is deliberately pure and lexical: it resolves
 * `..`, refuses absolute paths outside the root, and rejects NUL bytes. Its own
 * doc says what it does not do — "it does not resolve symlinks… closing that
 * needs `realpath`, which is async and file-existence dependent, and belongs in
 * the host rather than in a pure function". That was the right split, and the
 * host half was never written. This is it.
 *
 * Without it, a symlink INSIDE the model folder pointing anywhere on the disk
 * passes the lexical check and the engine follows it. Verified before the fix:
 * with a symlink `<root>/escape.onnx -> <tmp>/outside.txt`,
 * `confineModelPath(root, 'escape.onnx')` returned `<root>/escape.onnx` — a
 * path that opens a file outside the root.
 *
 * Exploiting it needs a second primitive: something that creates a symlink
 * inside the model folder. Nothing exposed to the renderer does that today, and
 * the desktop downloader — the component that will write there — is not built
 * yet. That is the reason to fix it now rather than later: the guard should be
 * correct when the capability arrives, not after someone remembers.
 *
 * WHAT THIS STILL DOES NOT DO: it is TOCTOU-racy. A symlink swapped between
 * this check and the engine's `open` defeats it. Closing that needs
 * `O_NOFOLLOW`/`openat` semantics Node does not portably expose, and it already
 * requires an attacker who can write into app-private storage. Stated rather
 * than left to be assumed.
 */

import { lstatSync, realpathSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';

/**
 * Re-check containment after resolving symlinks.
 *
 * Runs after `confineModelPath`, never instead of it: the lexical gate rejects
 * NUL bytes and `..` before any I/O, and this resolves what the filesystem
 * would actually open. Synchronous on purpose — `CallGuard` is synchronous, and
 * this runs per call in a host process that already blocks for hundreds of
 * milliseconds inside native inference.
 *
 * @param modelRoot the app's model directory. Need not itself be resolved:
 *   macOS hands out `/var/folders/…`, which is a symlink to `/private/var`, so
 *   resolving only the candidate would refuse every legitimate path.
 * @param resolvedCandidate an absolute path that already passed the lexical gate.
 * @returns the real absolute path, or null if it escapes the root.
 */
export function confineRealPath(modelRoot: string, resolvedCandidate: string): string | null {
  let realRoot: string;
  try {
    realRoot = realpathSync(modelRoot);
  } catch {
    // No root means nothing is inside it. A missing model folder is a refusal,
    // not an error to distinguish from a rejected path.
    return null;
  }

  /*
   * The candidate may not exist yet — a download target is the ordinary case.
   * So resolve the deepest ancestor that DOES exist and re-attach the tail that
   * does not. A parent symlink pointing outside the root is caught this way
   * even when the leaf is absent, which is precisely the case a downloader
   * creates.
   */
  let existing = resolvedCandidate;
  const missing: string[] = [];
  for (;;) {
    try {
      existing = realpathSync(existing);
      break;
    } catch {
      /*
       * `realpath` failed. Either the entry does not exist — the ordinary
       * download-target case — or it EXISTS as a dangling symlink, which is a
       * very different thing.
       *
       * Treating a dangling link as "absent" and re-attaching its name made
       * this function hand back a path inside the root that `open` would
       * follow OUT of it. With a write primitive on the other side (the
       * desktop Filesystem plugin) that is an arbitrary-write: verified by
       * creating `<root>/innocent.gguf -> <tmp>/ARBITRARY-WRITE-TARGET.txt`
       * with the target absent, and watching a write land outside the root.
       *
       * `lstat` does not follow the link, so it succeeds exactly when the
       * entry is really there. A symlink whose target resolves INSIDE the root
       * is unaffected — `realpath` succeeds for those and never reaches here.
       */
      try {
        if (lstatSync(existing).isSymbolicLink()) return null;
      } catch {
        // Genuinely absent. Fall through and treat it as a missing component.
      }
      const parent = dirname(existing);
      // `dirname` is a fixed point at the filesystem root; without this a
      // candidate on a non-existent volume would spin forever.
      if (parent === existing) return null;
      missing.unshift(existing.slice(parent.length + 1));
      existing = parent;
    }
  }

  const real = missing.length === 0 ? existing : resolve(existing, ...missing);
  // Strictly inside, with the separator: the root itself is a directory, never
  // a model, and `/models` must not prefix-match `/models-evil`.
  const prefix = realRoot.endsWith(sep) ? realRoot : `${realRoot}${sep}`;
  if (!real.startsWith(prefix)) return null;
  // `resolve` cannot leave a `..` behind, but assert it rather than assume it.
  if (relative(realRoot, real).split(sep).includes('..')) return null;
  return real;
}
