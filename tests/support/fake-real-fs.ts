import type { RealFsPort } from '@/shell/mount';

/**
 * A fake real filesystem with symlinks, shared by every test that needs one.
 *
 * SHARED, NOT COPIED, and the repo has the scar: `tests/layering.test.ts`
 * records a guard that asserted against a byte-identical second copy of the
 * thing under test, so weakening the real one left every assertion green. A
 * fake whose `realpath`/`lstat` semantics drift between two files is the same
 * failure — the escape tests would be measuring a different kernel from the
 * one the end-to-end tests measure.
 *
 * The semantics that matter, both POSIX-faithful on purpose:
 *
 *   `realpath` walks EVERY ancestor, longest-prefix first, and throws when
 *   the resolved path is not there — including when the final component is a
 *   symlink whose target is missing.
 *
 *   `lstat` does NOT follow the final component, so it succeeds for exactly
 *   that dangling link. Telling those two apart is the whole containment
 *   story for a path that does not exist yet; a fake that got it wrong would
 *   make the test pass and the product unsafe.
 */
export function fakePort(options: {
  files?: Record<string, string>;
  dirs?: readonly string[];
  links?: Record<string, string>;
}): RealFsPort & { written: Record<string, string> } {
  const files = { ...options.files };
  const dirs = new Set(options.dirs ?? []);
  const links = options.links ?? {};
  const written: Record<string, string> = {};

  const resolve = (path: string): string => {
    // Resolve every ancestor, longest first, the way a real lookup does.
    const parts = path.split('/').filter(Boolean);
    let current = '';
    for (const part of parts) {
      current = `${current}/${part}`;
      const link = links[current];
      if (link) current = link;
    }
    return current || '/';
  };

  const exists = (path: string) => path in files || dirs.has(path);

  return {
    written,
    realpath: async (path) => {
      const resolved = resolve(path);
      if (!exists(resolved)) throw new Error(`ENOENT: ${path}`);
      return resolved;
    },
    stat: async (path) => {
      if (!exists(path)) throw new Error(`ENOENT: ${path}`);
      return {
        isDirectory: dirs.has(path),
        isSymbolicLink: false,
        size: (files[path] ?? '').length,
        mtimeMs: 0,
        mode: dirs.has(path) ? 0o040755 : 0o100644,
      };
    },
    /**
     * POSIX `lstat`: it does NOT follow the final component, so it succeeds
     * for a symlink whose target is missing — which is the exact case
     * `realpath` reports identically to absence, and the reason this method
     * exists on the port at all.
     */
    lstat: async (path) => {
      const link = links[path];
      if (link !== undefined) {
        return {
          isDirectory: false,
          isSymbolicLink: true,
          size: link.length,
          mtimeMs: 0,
          mode: 0o120777,
        };
      }
      if (!exists(path)) throw new Error(`ENOENT: ${path}`);
      return {
        isDirectory: dirs.has(path),
        isSymbolicLink: false,
        size: (files[path] ?? '').length,
        mtimeMs: 0,
        mode: dirs.has(path) ? 0o040755 : 0o100644,
      };
    },
    readFile: async (path) => {
      const content = files[path];
      if (content === undefined) throw new Error(`ENOENT: ${path}`);
      return content;
    },
    readdir: async (path) =>
      Object.keys(files)
        .filter((file) => file.startsWith(`${path}/`))
        .map((file) => file.slice(path.length + 1).split('/')[0]!),
    writeFile: async (path, content) => {
      written[path] = content;
      files[path] = content;
    },
    mkdir: async (path) => {
      dirs.add(path);
    },
    rm: async (path) => {
      delete files[path];
    },
  };
}

