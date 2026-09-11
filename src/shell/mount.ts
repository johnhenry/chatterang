/**
 * Mounting a real directory into the shell's filesystem.
 *
 * `vfs.ts` projects app state into files and said, truthfully until now, that
 * nothing is mounted the app does not itself hold — no device filesystem. This
 * is the seam that changes that, deliberately and one granted folder at a time
 * (#246).
 *
 * ## Why a decorator, and why below the projection guard
 *
 * `guardProjection` in `fs.ts` already proves the shape: a `Proxy` over the
 * filesystem `just-bash` is handed, deciding by path what an operation means.
 * This is the same shape with a different job — it ROUTES rather than checks.
 *
 * The composition order is load-bearing:
 *
 *     guardProjection(mountReal(rawFs, grants))
 *
 * The guard resolves a write's parent through `realpath` before deciding
 * whether it is projected. If the mount sat above the guard, that `realpath`
 * would ask the in-memory filesystem about a path that lives on disk and get
 * an answer about nothing. Below it, the guard's own resolution flows through
 * the mount and is answered by the real filesystem.
 *
 * ## The containment rule, which is the whole security story
 *
 * A granted root is a promise that nothing outside it is reachable. Keeping
 * that promise is not prefix-matching the path the caller asked for, because
 * the path the caller asks for is not where the bytes are:
 *
 *   - `..` walks out of the root before any syscall happens
 *   - a SYMLINK inside the granted folder is followed by the operating system,
 *     which does not know about our root and will happily hand back
 *     `~/.ssh/id_ed25519`
 *   - the granted root may ITSELF be a symlink, so the string the user picked
 *     and the directory they picked are different places
 *   - `/Users/me/notes` is a prefix of `/Users/me/notes-secret`, and a
 *     `startsWith` check that forgets the separator lets the second through
 *
 * So every path is normalised, joined to the resolved root, resolved AGAIN on
 * the real side, and only then checked — with a separator boundary. The
 * resolution is the check; the string manipulation before it is bookkeeping.
 *
 * `fs.ts` learned the first half of this lesson in the virtual case, where a
 * symlink turned `/workspace/link/planted.md` into a path whose string form
 * was innocent. The real case is strictly harder, because there the kernel
 * resolves before we get a say.
 *
 * ## Why a port rather than a filesystem
 *
 * `src/` may not import a Node builtin — `tests/layering.test.ts` bans it, and
 * this file is the sort of place someone would reach for `node:fs`. The
 * adapter takes a {@link RealFsPort} instead, implemented outside `src/` over
 * the `Filesystem` plugin. That is not only a layering concession: the same
 * port is Capacitor's interface on iOS and Android, so a granted folder works
 * on mobile without this file knowing which platform it is on.
 */

import { normalizePath } from '@/shell/fs';

/**
 * The filesystem operations a mount needs, as this app can reach them.
 *
 * Deliberately small — nine methods, all of which `Filesystem` already
 * exposes. Anything not here cannot be done through a mount, which is the
 * right default for a surface the user granted one folder to.
 */
export interface RealFsPort {
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  readdir(path: string): Promise<readonly string[]>;
  stat(path: string): Promise<RealStat>;
  mkdir(path: string): Promise<void>;
  rm(path: string, options?: { readonly recursive?: boolean }): Promise<void>;
  /**
   * Resolve symlinks and `..` to a canonical absolute path.
   *
   * THE CONTAINMENT CHECK HAS NO OTHER SOURCE OF TRUTH. An implementation
   * that returns its argument unchanged — the tempting shim when a platform
   * makes this awkward — turns every guarantee in this file into a string
   * comparison against a lie. It must reject, not approximate.
   */
  realpath(path: string): Promise<string>;
}

export interface RealStat {
  readonly isDirectory: boolean;
  readonly size: number;
  readonly mtimeMs: number;
}

/** One folder the user granted, as the shell sees it. */
export interface MountGrant {
  /** The name under `/mnt`. `notes` becomes `/mnt/notes`. */
  readonly name: string;
  /** The real directory, as the picker reported it. Resolved at mount time. */
  readonly root: string;
  /**
   * May the shell write here?
   *
   * Defaults to false at every call site that builds one of these. A grant is
   * a folder the user pointed at, which is consent to read it; consent to
   * change it is a second thing and is asked for separately.
   */
  readonly writable: boolean;
}

/** The prefix every mount lives under. */
export const MOUNT_ROOT = '/mnt';

export class MountEscapeError extends Error {
  override readonly name = 'MountEscapeError';
  readonly code = 'EACCES';
  constructor(
    readonly requested: string,
    readonly resolved: string,
  ) {
    super(
      `EACCES: ${requested} resolves to ${resolved}, which is outside the folder you granted`,
    );
  }
}

export class MountReadOnlyError extends Error {
  override readonly name = 'MountReadOnlyError';
  readonly code = 'EROFS';
  constructor(operation: string, path: string) {
    super(`EROFS: read-only mount, ${operation} '${path}' — this folder was granted for reading`);
  }
}

/**
 * Is `candidate` inside `root`, with a separator boundary?
 *
 * `/a/b` contains `/a/b` and `/a/b/c`, and does NOT contain `/a/bc`. The
 * separator is the whole point: a bare `startsWith` treats a sibling whose
 * name merely begins with the root's as being inside it, which is the classic
 * way a containment check reads correct and is not.
 */
export function isInside(root: string, candidate: string): boolean {
  if (candidate === root) return true;
  return candidate.startsWith(root.endsWith('/') ? root : `${root}/`);
}

/** A mount, after its root has been resolved on the real side. */
export interface ResolvedMount {
  readonly name: string;
  readonly virtualRoot: string;
  /** `realpath` of the granted root. Not the string the user picked. */
  readonly realRoot: string;
  readonly writable: boolean;
  readonly port: RealFsPort;
}

/**
 * Resolve a grant's root once, so every later check compares against the
 * directory rather than against the name it was reached by.
 *
 * A root that cannot be resolved is not mounted. Mounting it anyway and
 * checking against the unresolved string would mean every containment decision
 * for that grant is made against a path the kernel does not agree with.
 */
export async function resolveGrant(
  grant: MountGrant,
  port: RealFsPort,
): Promise<ResolvedMount | null> {
  try {
    const realRoot = await port.realpath(grant.root);
    const stat = await port.stat(realRoot);
    if (!stat.isDirectory) return null;
    return {
      name: grant.name,
      virtualRoot: normalizePath(`${MOUNT_ROOT}/${grant.name}`),
      realRoot: normalizePath(realRoot),
      writable: grant.writable,
      port,
    };
  } catch {
    return null;
  }
}

/** Which mount, if any, owns a virtual path. */
function mountFor(mounts: readonly ResolvedMount[], virtualPath: string): ResolvedMount | undefined {
  return mounts.find((mount) => isInside(mount.virtualRoot, virtualPath));
}

/**
 * The real path a virtual one names, checked for containment.
 *
 * Four steps, and the order matters:
 *
 *   1. normalise the virtual path, collapsing `..` BEFORE it can be joined
 *   2. join what is left of it to the RESOLVED root
 *   3. resolve again on the real side — this is where a symlink is caught
 *   4. check containment with a separator boundary
 *
 * Step 3 is done on the nearest existing ancestor when the path itself does
 * not exist yet, because a file being created has nothing to resolve. Its
 * PARENT does, and a parent outside the root is an escape whether or not the
 * leaf exists.
 */
export async function realPathWithin(mount: ResolvedMount, virtualPath: string): Promise<string> {
  const normalised = normalizePath(virtualPath);
  if (!isInside(mount.virtualRoot, normalised)) {
    throw new MountEscapeError(virtualPath, normalised);
  }
  const relative = normalised.slice(mount.virtualRoot.length).replace(/^\/+/, '');
  const joined = normalizePath(relative ? `${mount.realRoot}/${relative}` : mount.realRoot);

  // Resolve the deepest ancestor that exists. A path that does not exist has
  // no symlinks of its own, but every segment above it might.
  let probe = joined;
  const trailing: string[] = [];
  for (;;) {
    try {
      const resolved = normalizePath(await mount.port.realpath(probe));
      // A copy: `reverse()` mutates, and it is only safe today because this
      // branch always exits the loop. An edit that continued instead would
      // get a reversed `trailing` on the next pass.
      const full = normalizePath([resolved, ...[...trailing].reverse()].join('/'));
      if (!isInside(mount.realRoot, full)) throw new MountEscapeError(virtualPath, full);
      return full;
    } catch (error) {
      if (error instanceof MountEscapeError) throw error;
      const cut = probe.lastIndexOf('/');
      if (cut <= 0) throw new MountEscapeError(virtualPath, joined);
      trailing.push(probe.slice(cut + 1));
      probe = probe.slice(0, cut);
    }
  }
}

/** Operations that only read, mirroring `fs.ts`'s list for the same reason. */
const READING = new Set([
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
]);

/**
 * Route filesystem calls under `/mnt` to a real directory.
 *
 * Everything outside `/mnt` passes through to the in-memory filesystem
 * untouched, so the projections, `/workspace` and `/tmp` behave exactly as
 * they did. A `/mnt` path with no matching grant is not special-cased: it
 * simply is not a mount, and the in-memory filesystem answers for it as it
 * would for any other unknown path.
 */
export function mountReal(inner: object, mounts: readonly ResolvedMount[]): object {
  if (mounts.length === 0) return inner;

  return new Proxy(inner, {
    get(target, property) {
      const value = Reflect.get(target, property, target) as unknown;
      if (typeof value !== 'function' || typeof property !== 'string') return value;
      const passthrough = (args: unknown[]) =>
        (value as (...a: unknown[]) => unknown).apply(target, args);

      return async (...args: unknown[]) => {
        /*
         * EVERY string argument, not just the first.
         *
         * `cp`, `mv`, `rename`, `link` and `symlink` take two paths, and the
         * mounted one is not always args[0]. Checking only args[0] let
         * `cp /workspace/x /mnt/notes/y` fall through to the in-memory
         * filesystem, which wrote a shadow at a path that reads route to the
         * real side — so the write appeared to succeed and the file was never
         * there. Not an escape, but silent data loss, and the same blind spot
         * would hide a genuine one the moment `dispatch` grew a two-path case.
         */
        const touched = args
          .filter((arg): arg is string => typeof arg === 'string' && arg.startsWith('/'))
          .map((arg) => ({ arg, mount: mountFor(mounts, normalizePath(arg)) }))
          .filter((entry) => entry.mount !== undefined);

        if (touched.length === 0) return passthrough(args);

        // A cross-filesystem operation is refused rather than half-performed.
        // Copying between the in-memory tree and a real folder is a real
        // feature and it is not this one; doing it by accident, in one
        // direction only, is worse than not doing it.
        const first = args[0];
        const owner = touched[0]!.mount!;
        if (touched.length !== 1 || typeof first !== 'string' || touched[0]!.arg !== first) {
          throw new MountReadOnlyError(property, String(args[0]));
        }

        if (!READING.has(property) && !owner.writable) {
          throw new MountReadOnlyError(property, first);
        }

        const real = await realPathWithin(owner, first);
        return dispatch(owner, property, real, args);
      };
    },
  });
}

/**
 * One filesystem operation, against the real side.
 *
 * A closed switch rather than a forwarding proxy, and deliberately: an
 * operation this file has not thought about must not reach a real directory
 * because its name happened to match. `just-bash` growing a `chmod` should be
 * a refusal here, not a silent new capability on the user's disk.
 */
async function dispatch(
  mount: ResolvedMount,
  operation: string,
  real: string,
  args: readonly unknown[],
): Promise<unknown> {
  const { port } = mount;
  switch (operation) {
    case 'readFile':
      return port.readFile(real);
    case 'exists':
      return port
        .stat(real)
        .then(() => true)
        .catch(() => false);
    case 'stat':
    case 'lstat': {
      const stat = await port.stat(real);
      return {
        isFile: () => !stat.isDirectory,
        isDirectory: () => stat.isDirectory,
        isSymbolicLink: () => false,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
      };
    }
    case 'readdir':
      return port.readdir(real);
    case 'realpath':
    case 'resolvePath':
      // The VIRTUAL path, not the real one. Handing the shell an absolute host
      // path would leak where the folder lives on disk into every error
      // message and every `pwd`, and would let a later call address it
      // directly — outside the mount, and outside every check in this file.
      return normalizePath(args[0] as string);
    case 'writeFile':
      return port.writeFile(real, String(args[1] ?? ''));
    case 'mkdir':
      return port.mkdir(real);
    case 'rm':
      return port.rm(real, args[1] as { recursive?: boolean } | undefined);
    default:
      throw new MountReadOnlyError(operation, args[0] as string);
  }
}
