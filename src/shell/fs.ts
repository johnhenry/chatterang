/**
 * The projection guard.
 *
 * `buildVfs` projects the app's own data into files, and four separate places
 * called that projection "read-only". It was not. `just-bash` writes through
 * whatever filesystem it is handed, so `echo forged > /chats/notes.md`
 * succeeded, and because `mount()` overlays rather than rebuilds, the forged
 * file outlived every remount and read back exactly like a transcript.
 *
 * That is worse than it sounds, because of who is typing. The model drives
 * this shell. Exfiltration is the obvious risk and the one the shell already
 * refuses; forgery is the quieter one. A model that can write into `/chats`
 * can manufacture the user's own words, read them back a turn later, and cite
 * them — to the user, and to the next model that mounts the same directory.
 * Nothing downstream can tell a planted file from a real one, because there
 * is nothing in a projected file that says where it came from.
 *
 * So the projection is now read-only in the only way that means anything: the
 * filesystem refuses the write. `/workspace` stays writable, and so does the
 * rest of the synthetic tree — `/tmp`, a file dropped at `/` — because scratch
 * space is what makes pipelines usable and none of it is mistakable for the
 * user's data.
 *
 * `mount()` writes the projection through {@link GuardedFs.project}, which
 * addresses the underlying filesystem directly instead of unlocking the guard
 * for a moment. There is no unlocked moment to race, and no argv that reaches
 * the escape, because the escape is not on the object the shell holds.
 *
 * This wraps rather than reimplements: unknown methods are forwarded, so an
 * upstream addition does not silently lose behaviour. Methods that are not
 * known to be read-only have every absolute path argument checked, so an
 * upstream addition does not silently gain a way through either.
 */

import { isProjectedPath } from '@/shell/vfs';

export interface GuardedFs {
  /** The filesystem to hand to `new Bash({ fs })`. Refuses projected writes. */
  readonly fs: unknown;
  /** Write one projected file. App code only — the shell never sees this. */
  project(path: string, content: string): Promise<void>;
  /** Drop a projected file that a later mount no longer projects. */
  unproject(path: string): Promise<void>;
}

/**
 * Methods that only read. Everything else is treated as a mutation.
 *
 * Erring this way is deliberate: if `just-bash` grows a write method this
 * file has never heard of, the guard refuses it on a projected path rather
 * than waving it through because the name was unfamiliar.
 */
const READ_ONLY_METHODS = new Set([
  'readFile',
  'readFileBytes',
  'readFileBuffer',
  'exists',
  'stat',
  'lstat',
  'readdir',
  'readdirWithFileTypes',
  'readlink',
  'realpath',
  'resolvePath',
  'getAllPaths',
]);

/**
 * Which argument of a mutating method names the path being changed.
 *
 * `cp` writes its destination only; `mv` writes its destination and unlinks
 * its source, so both are checked. `symlink(target, linkPath)` creates
 * `linkPath` — the target is just a string until something follows it, and
 * following it is a read.
 */
const MUTATION_TARGETS: Record<string, readonly number[]> = {
  writeFile: [0],
  appendFile: [0],
  mkdir: [0],
  rm: [0],
  chmod: [0],
  utimes: [0],
  symlink: [1],
  link: [1],
  cp: [1],
  mv: [0, 1],
};

/** Collapse `.`, `..` and repeated slashes; resolve a relative path against `/`. */
export function normalizePath(path: string): string {
  const parts: string[] = [];
  for (const segment of path.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      parts.pop();
      continue;
    }
    parts.push(segment);
  }
  return `/${parts.join('/')}`;
}

/** The parts of `IFileSystem` this file calls itself. */
interface InnerFs {
  realpath(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>;
}

/**
 * The path a write would actually land on.
 *
 * The parent directory is resolved through `realpath` first, because a
 * symlink is a rename: `ln -s /chats /workspace/link` turns
 * `/workspace/link/planted.md` into a path whose string form is innocent and
 * whose destination is not. A parent that does not exist yet cannot be
 * resolved and cannot be a symlink either, so the literal path is used.
 */
async function targetPath(inner: InnerFs, path: string): Promise<string> {
  const absolute = normalizePath(path);
  const cut = absolute.lastIndexOf('/');
  const parent = cut <= 0 ? '/' : absolute.slice(0, cut);
  const name = absolute.slice(cut + 1);

  let resolvedParent = parent;
  try {
    resolvedParent = normalizePath(await inner.realpath(parent));
  } catch {
    // Nothing to resolve. Fall through with the literal parent.
  }

  return name ? normalizePath(`${resolvedParent}/${name}`) : resolvedParent;
}

class ReadOnlyProjectionError extends Error {
  readonly code = 'EROFS';
  constructor(operation: string, path: string) {
    super(
      `EROFS: read-only file system, ${operation} '${path}' — ` +
        'this is a projection of app data, not a place to write. Use /workspace.',
    );
    this.name = 'ReadOnlyProjectionError';
  }
}

export function guardProjection(inner: object): GuardedFs {
  const raw = inner as InnerFs;

  const check = async (operation: string, path: string): Promise<void> => {
    const target = await targetPath(raw, path);
    if (isProjectedPath(target)) throw new ReadOnlyProjectionError(operation, target);
  };

  const fs = new Proxy(inner, {
    get(target, property) {
      const value = Reflect.get(target, property, target) as unknown;
      if (typeof value !== 'function' || typeof property !== 'string') return value;
      const call = (args: unknown[]) => (value as (...a: unknown[]) => unknown).apply(target, args);
      if (READ_ONLY_METHODS.has(property)) return (...args: unknown[]) => call(args);

      // `mv` needs both of its arguments checked before either is touched, so
      // the guard is a single async prelude rather than a check per argument.
      const indices = MUTATION_TARGETS[property];
      return async (...args: unknown[]) => {
        const paths =
          indices?.map((index) => args[index]) ??
          // An unfamiliar method: check every absolute path it was handed.
          args.filter((arg) => typeof arg === 'string' && arg.startsWith('/'));
        for (const path of paths) {
          if (typeof path === 'string') await check(property, path);
        }
        return call(args);
      };
    },
  });

  return {
    fs,
    project: (path, content) => raw.writeFile(path, content),
    unproject: async (path) => {
      await raw.rm(path, { force: true }).catch(() => undefined);
    },
  };
}
