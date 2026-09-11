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
 * And one more, which the first draft of this file got WRONG and an
 * adversarial review reproduced against a real filesystem:
 *
 *   - a DANGLING symlink fails `realpath` exactly the way an absent file
 *     does, so a leaf that "does not exist yet" may be a link pointing
 *     anywhere. Treating the two as the same thing made this an
 *     arbitrary-file-CREATE primitive outside the grant, and the check was
 *     INVERTED: it held whenever the target already existed and failed
 *     exactly when the write would make something new. `lstat` is what tells
 *     them apart, and is why {@link RealFsPort} has one.
 *
 * ## What `just-bash` actually calls, which is not what it looks like
 *
 * Routing is a TABLE of which argument of which method names a path
 * ({@link PATH_ARGS}), read out of `IFileSystem` rather than guessed. Every
 * shortcut here was wrong in both directions at once: scanning every string
 * that starts with `/` treated FILE CONTENT as a second path, and assuming
 * the path is `args[0]` broke `resolvePath(base, path)` — whose base is the
 * cwd, so every absolute access to a mount from outside it was refused as a
 * cross-filesystem operation and `ls /mnt/notes` could not work at all.
 *
 * Two methods are synchronous in `IFileSystem` and neither touches a disk, so
 * they are not routed at all; wrapping them in `async` returned Promises to
 * callers that use the value directly.
 *
 * None of that was visible from unit tests over a fake port. It took running
 * a real `Bash` — `tests/shell.test.ts` — which is where it is pinned now.
 *
 *
 * ## What this still does not close, stated rather than left to be assumed
 *
 * IT IS TOCTOU-RACY. Resolving a path and acting on it are two operations, so
 * a symlink planted between them is followed. The same admission is on
 * `apps/desktop/src/host/real-path.ts`, and it is inherited here rather than
 * introduced: closing it needs `O_NOFOLLOW`/`openat` semantics in the PORT's
 * write path, which Node does not portably expose and Capacitor's filesystem
 * does not expose at all. The ancestor walk is then defence in depth rather
 * than the only guard.
 *
 * Two things make it narrower than it sounds. The shell cannot plant a link
 * itself — `dispatch` is a closed switch with no `symlink` case, and
 * `MountHost` has no such method either — so the race needs a second process
 * writing into the granted folder at the moment the shell reads it. And the
 * host re-checks independently, so winning the race in the renderer wins
 * nothing on its own.
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
  /**
   * Stat WITHOUT following a final symlink.
   *
   * Not a convenience. {@link realPathWithin} walks back to the deepest
   * ancestor that resolves, and a DANGLING symlink fails `realpath` exactly
   * the way an absent file does — so without a way to tell those apart, a
   * link pointing at a file that does not exist yet is treated as a missing
   * leaf, its name is re-attached to the resolved parent, and the write is
   * performed through it. `real-path.ts` records finding the same hole on the
   * desktop side by testing; this is the method that closes it here.
   */
  lstat(path: string): Promise<RealStat>;
  mkdir(path: string, options?: { readonly recursive?: boolean }): Promise<void>;
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
  /**
   * Meaningful only from `lstat`. `stat` follows links, so it answers about
   * the target and this is false there — which is what `FsStat` expects.
   */
  readonly isSymbolicLink: boolean;
  readonly size: number;
  readonly mtimeMs: number;
  /** POSIX mode bits. `just-bash`'s `FsStat` requires a number, not a guess. */
  readonly mode: number;
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

/**
 * A path that resolved outside the folder it was granted under.
 *
 * THE MESSAGE NAMES THE REQUEST AND NEVER THE RESOLUTION. `message` is what
 * `just-bash` prints to stderr, which the user reads and the model reads — and
 * the resolution is where a SYMLINK pointed, which is a location outside the
 * grant that nobody on this side was entitled to learn. An earlier version
 * interpolated it, which made every refusal a working `readlink` for anything
 * the folder happened to point at, and contradicted this module's own rule
 * about `realpath` answering with the virtual path for exactly that reason.
 *
 * `resolved` stays as a FIELD so app-side logging can have it. A field is not
 * printed by accident; a message is printed by definition.
 */
export class MountEscapeError extends Error {
  override readonly name = 'MountEscapeError';
  readonly code = 'EACCES';
  constructor(
    readonly requested: string,
    readonly resolved: string,
  ) {
    super(`EACCES: ${requested} resolves outside the folder you granted`);
  }
}

/**
 * An operation a mount does not perform, as distinct from one it refuses.
 *
 * `MountReadOnlyError` says "this folder was granted for reading", and saying
 * that about a READ is a lie that sends whoever reads it to the grant instead
 * of to the missing case. Four reads used to fail that way — every one of them
 * listed as a read and absent from `dispatch` — and the error said the folder
 * was read-only.
 */
export class MountUnsupportedError extends Error {
  override readonly name = 'MountUnsupportedError';
  readonly code = 'ENOSYS';
  constructor(operation: string, path: string, detail = '') {
    super(
      `ENOSYS: ${operation} '${path}' is not supported inside a granted folder` +
        (detail ? ` — ${detail}` : ''),
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
  if (!isMountName(grant.name)) return null;
  try {
    const realRoot = await port.realpath(grant.root);
    const stat = await port.stat(realRoot);
    if (!stat.isDirectory) return null;
    const virtualRoot = normalizePath(`${MOUNT_ROOT}/${grant.name}`);
    /*
     * AN UNREACHABLE ASSERTION, AND SAID SO RATHER THAN DEFENDED AS A CHECK.
     * `isMountName` above already forbids every spelling that could reach this
     * line, so no test can fail for deleting it — measured, not assumed:
     * removing it leaves the suite green while removing `isMountName` does
     * not. It stays because it asserts the RESULT rather than the filter, and
     * the filter is the kind of thing that gets loosened by someone who wants
     * a folder with a space in it. What it catches is not a bad mount point:
     * it is a `virtualRoot` of `/`, which owns the whole virtual tree —
     * `/chats` included — after which the projection writes the user's own
     * transcripts onto their real disk.
     */
    if (!isInside(MOUNT_ROOT, virtualRoot) || virtualRoot === MOUNT_ROOT) return null;
    return {
      name: grant.name,
      virtualRoot,
      realRoot: normalizePath(realRoot),
      writable: grant.writable,
      port,
    };
  } catch {
    return null;
  }
}

/**
 * Is this a name that can be ONE segment under `/mnt`?
 *
 * The containment reasoning in this module is all about the real side, and the
 * virtual side was taken on trust — `normalizePath('/mnt/..')` is `/`, so a
 * grant named `..` would have claimed the whole tree. The host derives names
 * from a folder's basename and would never produce one, which is exactly the
 * argument that stops being true the moment a second implementation exists.
 */
export function isMountName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name) && name !== '.' && name !== '..';
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
      /*
       * `realpath` FAILING DOES NOT MEAN THE ENTRY IS ABSENT, and treating it
       * that way was an arbitrary-file-CREATE primitive outside the grant.
       *
       * The line above this loop used to assert "a path that does not exist
       * has no symlinks of its own". A DANGLING symlink is precisely a path
       * `realpath` reports as non-existent and which is a symlink of its own:
       *
       *     <granted>/pwn -> ~/.ssh/authorized_keys      (target absent)
       *     echo '...' > /mnt/notes/pwn
       *
       * `realpath` threw, `pwn` was re-attached to the resolved parent as a
       * plain name, `isInside` said yes because the string was inside, and the
       * kernel followed the link on O_CREAT and made the file. Reproduced
       * against this code with a real filesystem. The check was INVERTED: it
       * held whenever the target already existed and failed exactly when the
       * write would create something new.
       *
       * `lstat` does not follow the final link, so it succeeds exactly when
       * something IS there. A successful lstat therefore means `realpath`
       * failed for a reason that is not absence — a dangling link, a loop, a
       * directory we may not traverse — and none of those may be walked past.
       */
      try {
        await mount.port.lstat(probe);
        throw new MountEscapeError(virtualPath, probe);
      } catch (inner) {
        if (inner instanceof MountEscapeError) throw inner;
        // lstat failed too: genuinely absent. Fall through.
      }
      const cut = probe.lastIndexOf('/');
      if (cut <= 0) throw new MountEscapeError(virtualPath, joined);
      trailing.push(probe.slice(cut + 1));
      probe = probe.slice(0, cut);
    }
  }
}

/**
 * Which arguments of a method NAME A PATH.
 *
 * The shape `fs.ts:MUTATION_TARGETS` already uses, and for the same reason:
 * positional guesswork gets this wrong in both directions. Scanning every
 * string that starts with `/` treated `writeFile(path, "/etc/passwd is a
 * file\n")` — ordinary FILE CONTENT — as a second path, and missed nothing in
 * exchange. Meanwhile assuming the path is `args[0]` is wrong for
 * `resolvePath(base, path)` and for every two-path operation.
 *
 * A method NOT in this table and not in {@link UNROUTED} is unknown, and an
 * unknown method that was handed a mounted path is refused rather than guessed
 * at — see the proxy below.
 *
 * Indices are from `just-bash`'s `IFileSystem`
 * (`node_modules/just-bash/dist/fs/interface.d.ts`), read rather than assumed.
 */
const PATH_ARGS: Readonly<Record<string, readonly number[]>> = Object.freeze({
  readFile: [0],
  readFileBytes: [0],
  readFileBuffer: [0],
  writeFile: [0],
  appendFile: [0],
  exists: [0],
  stat: [0],
  lstat: [0],
  readlink: [0],
  realpath: [0],
  readdir: [0],
  readdirWithFileTypes: [0],
  mkdir: [0],
  rm: [0],
  chmod: [0],
  utimes: [0],
  // Both sides, because either one being in a mount makes it a decision
  // this file has to take rather than one the in-memory filesystem takes.
  cp: [0, 1],
  mv: [0, 1],
  symlink: [0, 1],
  link: [0, 1],
});

/**
 * Methods that pass straight through, mounted path or not.
 *
 * Both are SYNCHRONOUS in `IFileSystem` and neither touches a filesystem:
 *
 *   `resolvePath(base, path)` is string arithmetic — joining and collapsing
 *   `.` and `..`. Routing it was wrong twice over: it returned `args[0]`, the
 *   BASE, discarding the path entirely, and the mounted path is `args[1]`, so
 *   the two-path refusal fired on `resolvePath('/', '/mnt/notes')` and made
 *   every absolute access to a mount fail from a cwd outside it. `ls
 *   /mnt/notes` could not work. There is no containment consequence to
 *   passing it through: what it returns is re-checked by the real operation
 *   that follows.
 *
 *   `getAllPaths()` takes no path and enumerates the in-memory tree. A
 *   granted folder is NOT in it, which is a real limitation — a glob does not
 *   see mounted files — stated here rather than papered over with a listing
 *   this file would have to keep in step with a disk.
 */
const UNROUTED: ReadonlySet<string> = new Set(['resolvePath', 'getAllPaths']);

/**
 * The real path of a virtual one WITHOUT following its final component.
 *
 * `lstat` exists to answer about a link rather than about its target, and
 * resolving the whole path first destroys the question: the link is followed,
 * so it reports whatever it points at — and for a link pointing OUT of the
 * grant it does not report at all, because resolution refuses. `ls -l` of an
 * ordinary folder that happens to contain a stale `node_modules/.bin` link
 * would fail entirely.
 *
 * Still contained, and for a reason worth stating rather than assuming: the
 * PARENT goes through {@link realPathWithin} in full — resolved, re-resolved
 * on the real side, and checked with a separator boundary — and what is
 * appended is a single name that `normalizePath` guarantees contains no
 * separator and is not `..`. The leaf is never followed here, and `lstat` does
 * not follow it either. Nothing else may use this.
 */
export async function realLeafWithin(mount: ResolvedMount, virtualPath: string): Promise<string> {
  const normalised = normalizePath(virtualPath);
  const cut = normalised.lastIndexOf('/');
  const leaf = normalised.slice(cut + 1);
  // The mount root itself has no leaf to preserve.
  if (leaf === '' || leaf === '.' || leaf === '..') return realPathWithin(mount, normalised);
  const parent = cut <= 0 ? '/' : normalised.slice(0, cut);
  const realParent = await realPathWithin(mount, parent);
  return normalizePath(`${realParent}/${leaf}`);
}

/**
 * Operations whose final component must NOT be resolved before they run.
 *
 * Only `lstat`, and only because that is the entire definition of `lstat`.
 */
const LEAF_ONLY: ReadonlySet<string> = new Set(['lstat']);

/** Operations that only read, mirroring `fs.ts`'s list for the same reason. */
const READING: ReadonlySet<string> = new Set([
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
]);

/**
 * A mount table: fixed, or read fresh on every operation.
 *
 * The FUNCTION form is what makes revocation mean something. With an array
 * captured at construction, a grant the user withdrew keeps working until the
 * shell is rebuilt — and "your consent applies until this component next
 * remounts" is not a sentence anyone should have to read. With a supplier,
 * the table is consulted per call and a revoked folder stops answering on the
 * next one.
 *
 * The array form stays because a fixed table is the honest shape for a test
 * and for a shell that is handed its grants once.
 */
export type MountTable = readonly ResolvedMount[] | (() => readonly ResolvedMount[]);

/**
 * Route filesystem calls under `/mnt` to a real directory.
 *
 * Everything outside `/mnt` passes through to the in-memory filesystem
 * untouched, so the projections, `/workspace` and `/tmp` behave exactly as
 * they did. A `/mnt` path with no matching grant is not special-cased: it
 * simply is not a mount, and the in-memory filesystem answers for it as it
 * would for any other unknown path.
 *
 * READ ONCE PER OPERATION, not per argument. A two-path call must decide
 * against ONE table, or a revocation landing between the two reads would make
 * `cp` see a mount for its source and none for its destination.
 */
export function mountReal(inner: object, table: MountTable): object {
  const read = typeof table === 'function' ? table : () => table;
  // Only the fixed form can be known empty for the life of the proxy. A
  // supplier that is empty NOW may not be after the next grant, so it is
  // wrapped regardless — and a wrapped filesystem with no mounts passes
  // everything through, which is what the unwrapped one does.
  if (typeof table !== 'function' && table.length === 0) return inner;

  return new Proxy(inner, {
    get(target, property) {
      const value = Reflect.get(target, property, target) as unknown;
      if (typeof value !== 'function' || typeof property !== 'string') return value;
      const passthrough = (args: unknown[]) =>
        (value as (...a: unknown[]) => unknown).apply(target, args);

      /*
       * NOT `async`, AND THAT IS LOAD-BEARING RATHER THAN A STYLE CHOICE.
       *
       * An `async` wrapper makes every method of the wrapped filesystem return
       * a Promise — including `resolvePath` and `getAllPaths`, which
       * `IFileSystem` declares synchronous and whose callers use the value
       * directly. The zero-mount case used to be safe only because
       * `mountReal` returned the filesystem UNWRAPPED when the table was
       * empty; a live table cannot do that, so the wrapper is always present
       * and must not change the shape of a call it does not route.
       *
       * Found by `tests/shell.test.ts`, not by the mount tests, which is the
       * lesson: those drive an all-async fake port and therefore CANNOT see
       * it. Twenty-five real shell tests went red — every write to
       * `/workspace` — from a change that looked local to a feature none of
       * them had enabled.
       */
      if (UNROUTED.has(property)) return (...args: unknown[]) => passthrough(args);

      const indices = PATH_ARGS[property];
      if (indices === undefined) {
        /*
         * An operation this file has never heard of. `just-bash` growing one
         * must not become a silent new capability on the user's disk, and it
         * must not silently write a SHADOW into the in-memory tree at a path
         * whose reads route to the real side either — the write appears to
         * succeed and the file is never there.
         *
         * Thrown synchronously on purpose: an unknown method may be sync or
         * async, and a rejected promise from a sync method is a value nobody
         * checks. Loud beats shaped-correctly here.
         */
        return (...args: unknown[]) => {
          const mounts = read();
          const hit =
            mounts.length > 0 &&
            args.some(
              (arg) =>
                typeof arg === 'string' &&
                arg.startsWith('/') &&
                mountFor(mounts, normalizePath(arg)) !== undefined,
            );
          if (hit) {
            throw new MountUnsupportedError(
              property,
              String(args[0]),
              'this is an operation the mount adapter has not been taught',
            );
          }
          return passthrough(args);
        };
      }

      return (...args: unknown[]) => {
        const mounts = read();
        // A FAST PATH, NOT A CHECK, and labelled so nobody defends it as one:
        // with an empty table the scan below finds nothing and passes through
        // anyway, so deleting this changes no behaviour and no test. It earns
        // its place on volume — every filesystem call in a shell that never
        // granted a folder comes through here.
        if (mounts.length === 0) return passthrough(args);

        const touched = indices
          .map((index) => ({ index, arg: args[index] }))
          .filter((entry): entry is { index: number; arg: string } => typeof entry.arg === 'string')
          .map((entry) => ({ ...entry, mount: mountFor(mounts, normalizePath(entry.arg)) }))
          .filter((entry) => entry.mount !== undefined);

        if (touched.length === 0) return passthrough(args);

        // Every refusal below is a REJECTED PROMISE rather than a synchronous
        // throw. Every method that reaches here is async in `IFileSystem`, its
        // caller awaits it, and a refusal should be indistinguishable from an
        // `EACCES` to everything that handles one.
        return (async () => {
          const owner = touched[0]!.mount!;
          const first = touched[0]!.arg;

          if (indices.length > 1) {
            /*
             * `cp`, `mv`, `symlink` and `link`, in EITHER direction and even
             * with both ends inside one mount. Refused rather than
             * half-performed: copying between the in-memory tree and a real
             * folder is a real feature and it is not this one, and doing it
             * in one direction only is worse than not doing it.
             *
             * ENOSYS rather than EROFS, because "this folder was granted for
             * reading" is false for three of these four cases and sends
             * whoever reads it to the grant instead of to the missing feature.
             */
            throw new MountUnsupportedError(
              property,
              first,
              'copying, moving and linking across a granted folder are not supported',
            );
          }

          if (!READING.has(property) && !owner.writable) {
            throw new MountReadOnlyError(property, first);
          }

          const real = LEAF_ONLY.has(property)
            ? await realLeafWithin(owner, first)
            : await realPathWithin(owner, first);
          return dispatch(owner, property, real, args);
        })();
      };
    },
  });
}

/** `FsStat` as `just-bash` declares it — plain booleans, a mode, and a Date. */
function asFsStat(stat: RealStat): object {
  return {
    // WAS `isFile: () => …`, which is Node's `fs.Stats` shape and not this
    // one. `IFileSystem` declares plain booleans, and a FUNCTION IS TRUTHY —
    // so every mounted entry read as a file AND a directory AND a symlink at
    // once, and every consumer believed whichever it asked about first.
    isFile: !stat.isDirectory && !stat.isSymbolicLink,
    isDirectory: stat.isDirectory,
    isSymbolicLink: stat.isSymbolicLink,
    mode: stat.mode,
    size: stat.size,
    mtime: new Date(stat.mtimeMs),
  };
}

/** UTF-8 bytes of a string, as the two byte shapes `IFileSystem` asks for. */
function utf8Bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/**
 * One filesystem operation, against the real side.
 *
 * A closed switch rather than a forwarding proxy, and deliberately: an
 * operation this file has not thought about must not reach a real directory
 * because its name happened to match. `just-bash` growing a `chmod` should be
 * a refusal here, not a silent new capability on the user's disk.
 *
 * THE SWITCH AND `READING` HAVE TO BE KEPT IN STEP, and were not: four reads
 * — `readFileBytes`, `readFileBuffer`, `readdirWithFileTypes` and `readlink`
 * — were listed as reads, passed the writability gate, fell off the end of
 * this switch, and were reported as `EROFS: read-only mount`. `cat` on a
 * read-granted folder failed, and the error blamed the grant.
 */
async function dispatch(
  mount: ResolvedMount,
  operation: string,
  real: string,
  args: readonly unknown[],
): Promise<unknown> {
  const { port } = mount;
  const virtual = normalizePath(args[0] as string);

  switch (operation) {
    case 'readFile': {
      // `readFile(path, options)` may name an encoding. The port answers UTF-8
      // text and nothing else, so a different one is refused rather than
      // answered with the wrong bytes under the right name.
      const encoding = encodingOf(args[1]);
      if (encoding !== undefined && encoding !== 'utf8' && encoding !== 'utf-8') {
        throw new MountUnsupportedError(
          operation,
          virtual,
          `a granted folder is read as UTF-8 text; "${encoding}" is not available here`,
        );
      }
      return port.readFile(real);
    }

    /*
     * The byte reads. The port carries TEXT — `MountHost.readFile` answers a
     * UTF-8 string — so these are the UTF-8 encoding of that text rather than
     * the file's literal bytes. For a text file they are the same thing; for a
     * JPEG they are not, and a JPEG has already been mangled by the time it
     * reaches here. Stated rather than hidden: a granted folder is for text,
     * and making it carry bytes is a change to the contract, not to this line.
     */
    case 'readFileBytes': {
      // A `ByteString`: latin1-shaped, one character per byte. Callers are
      // required not to treat it as text, which is the type's whole purpose.
      const bytes = utf8Bytes(await port.readFile(real));
      let out = '';
      for (const byte of bytes) out += String.fromCharCode(byte);
      return out;
    }
    case 'readFileBuffer':
      return utf8Bytes(await port.readFile(real));

    case 'exists':
      return port
        .stat(real)
        .then(() => true)
        .catch(() => false);

    case 'stat':
      return asFsStat(await port.stat(real));
    case 'lstat':
      // `port.lstat` on a path whose LEAF was deliberately left unresolved —
      // see `realLeafWithin`. Both halves matter: `stat` here would report a
      // symlink as whatever it points at, and a fully resolved path would
      // have followed the link before we got here.
      return asFsStat(await port.lstat(real));

    case 'readdir':
      return port.readdir(real);
    case 'readdirWithFileTypes': {
      // `readdir` + `lstat`, which is what the method exists to save — but a
      // wrong answer costs more than the round trips. `lstat` so a symlink
      // reads as one rather than as its target.
      const names = await port.readdir(real);
      return Promise.all(
        names.map(async (name) => {
          const entry = await port.lstat(normalizePath(`${real}/${name}`)).catch(() => null);
          return {
            name,
            isFile: entry !== null && !entry.isDirectory && !entry.isSymbolicLink,
            isDirectory: entry?.isDirectory ?? false,
            isSymbolicLink: entry?.isSymbolicLink ?? false,
          };
        }),
      );
    }

    /*
     * `readlink` is REFUSED, and it is the one refusal here that is a policy
     * rather than a gap. Its answer is a link's target — which, for the links
     * that matter, is a path OUTSIDE the granted folder. Returning it would
     * hand the caller the location this module goes out of its way not to put
     * in an error message.
     */
    case 'readlink':
      throw new MountUnsupportedError(
        operation,
        virtual,
        'a link inside a granted folder may point outside it, and its target is not ours to report',
      );

    case 'realpath':
      // The VIRTUAL path, not the real one. Handing the shell an absolute host
      // path would leak where the folder lives on disk into every error
      // message and every `pwd`, and would let a later call address it
      // directly — outside the mount, and outside every check in this file.
      return virtual;

    case 'writeFile':
      return port.writeFile(real, contentOf(operation, virtual, args[1]));
    case 'appendFile': {
      /*
       * Read, concatenate, write. NOT ATOMIC, and the alternative was refusing
       * `>>` in a granted folder, which is an ordinary enough idiom that
       * refusing it would be the surprising choice. The window is between this
       * read and this write, in a single-process shell the user is driving one
       * command at a time; it is not a containment property, because both ends
       * go through the same confinement.
       */
      const existing = await port.readFile(real).catch(() => '');
      return port.writeFile(real, existing + contentOf(operation, virtual, args[1]));
    }

    case 'mkdir':
      return port.mkdir(real, args[1] as { recursive?: boolean } | undefined);

    case 'rm': {
      /*
       * `rm -rf /mnt/notes` RESOLVES TO THE GRANTED ROOT, and deleting it is
       * not "emptying the folder you granted" — it unlinks an entry in the
       * folder's PARENT, which was never granted. `isInside` admits the root
       * because reading it is the first thing anyone does; unlinking it is the
       * one shape where that admission is wrong.
       */
      if (real === mount.realRoot) {
        // Its own error, not `MountEscapeError`: this path did NOT resolve
        // outside the grant, it resolved exactly to it, and "resolves outside
        // the folder you granted" would send whoever read it looking for a
        // symlink that is not there.
        throw new MountUnsupportedError(
          operation,
          virtual,
          'removing the folder itself would unlink it from its parent, which you did not grant',
        );
      }
      return port.rm(real, args[1] as { recursive?: boolean } | undefined);
    }

    default:
      throw new MountUnsupportedError(operation, virtual);
  }
}

/** A `readFile` encoding argument, in either of the two shapes it may take. */
function encodingOf(options: unknown): string | undefined {
  if (typeof options === 'string') return options;
  if (typeof options === 'object' && options !== null) {
    const encoding = (options as { encoding?: unknown }).encoding;
    if (typeof encoding === 'string') return encoding;
  }
  return undefined;
}

/**
 * File content as the port can carry it.
 *
 * REFUSED RATHER THAN COERCED. `String(new Uint8Array([1,2,3]))` is `"1,2,3"`,
 * so a byte write used to put the DECIMAL SPELLING of the bytes into the
 * user's real file — a silent corruption with a successful exit code. The
 * port is text; a caller with bytes is told so.
 */
function contentOf(operation: string, path: string, content: unknown): string {
  if (typeof content === 'string') return content;
  throw new MountUnsupportedError(
    operation,
    path,
    'a granted folder carries UTF-8 text, and this write was given raw bytes',
  );
}
