/**
 * `MountHost` — the real directory behind `/mnt/<name>` (#246).
 *
 * `src/shell/mount.ts` routes shell paths under `/mnt` to a folder the user
 * granted. It holds no filesystem: `src/` may not name a Node builtin, so it
 * takes a `RealFsPort` and this is what implements it on the desktop.
 *
 * ## The root is never an argument
 *
 * Every other method here takes a path from the renderer, which is the same
 * shape `fs/filesystem.ts` uses and for the same reason — confinement comes
 * from resolving a path, not from refusing to be told one. {@link pick} is the
 * exception in the other direction: the ROOT cannot come from the renderer at
 * all, because the renderer is a web page driving a shell a MODEL can drive.
 * A named root is a root a prompt injection can name, and `mount('/')` costs
 * nothing to ask for.
 *
 * So the only way a grant comes into existence is the operating system's own
 * folder chooser, which the injected `pick` opens. Nothing in this file can
 * create a grant without a human having clicked Open. That is the whole
 * argument for why the nine methods below are safe to expose at all.
 *
 * `writable` is the host's answer, never the caller's request, for the same
 * reason: the renderer may ask, and what it gets back is what the person
 * agreed to.
 *
 * ## Grants do not survive the process
 *
 * A `Map` in memory, deliberately. A grant that outlives a restart is an
 * ambient capability wearing a consent event's clothes — the person who
 * clicked Open last Tuesday is not here to be asked again, and the folder may
 * no longer hold what they were agreeing to share. Re-picking costs a click.
 *
 * ## Confinement, and where the honest version of it already lives
 *
 * `host/real-path.ts:confineRealPath` is the one that resolves symlinks, walks
 * back to the deepest existing ancestor so an absent leaf still gets its
 * PARENT checked, refuses a dangling symlink rather than treating it as
 * absent, and compares with a separator boundary. That function was written
 * for the model directory; #246 gave it `allowRoot`, because `ls /mnt/notes`
 * is the first thing anyone does with a granted folder and the root is not a
 * path to refuse here.
 *
 * Reusing it rather than writing a second one is the point. Its own comments
 * record a dangling-symlink arbitrary-write that was found by testing; a copy
 * is how that fix ends up in one of them.
 *
 * ## What this still does not close
 *
 * TOCTOU, inherited from `host/real-path.ts` and stated there too: a symlink
 * swapped between `confineRealPath` and the syscall is followed. Closing it
 * needs `O_NOFOLLOW`/`openat`, which Node does not portably expose. Narrower
 * than it sounds — this plugin has no symlink-CREATING method, so the race
 * needs another process writing into the granted folder at that moment — and
 * not narrow enough to leave unsaid.
 *
 * ## What refusals may say
 *
 * The REQUESTED path is echoed; the RESOLVED one never is. The caller named
 * the request, so repeating it tells them nothing they did not have — but a
 * symlink inside a granted folder points somewhere the caller may not know,
 * and naming that in an error turns every refusal into a readable link target.
 * Syscall messages are swallowed for the same reason: Node puts the absolute
 * path in every `ENOENT`.
 *
 * Refusals do not distinguish "outside every grant" from "does not exist", so
 * they are not an existence oracle for the rest of the disk.
 */

import { lstat, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';

import type { MountGrantInfo, MountStatInfo } from '@chatterang/contracts/mount-host';

import type { PluginImplementation, PluginMethod } from '../bridge/plugin-host.js';
import { confineRealPath } from '../host/real-path.js';

/** What the injected chooser answers with. `null` means the person cancelled. */
export interface PickedFolder {
  /** An absolute directory. Need not be resolved; this file resolves it. */
  readonly root: string;
  /** What the person actually agreed to, which may be less than was asked. */
  readonly writable: boolean;
}

export interface MountPluginOptions {
  /**
   * Open the operating system's folder chooser.
   *
   * Injected for the reason `createFilesystemPlugin`'s roots are: this module
   * calls no Electron and reads no environment, so the tests drive the real
   * code against a tmpdir instead of launching a window.
   *
   * AN IMPLEMENTATION THAT DOES NOT ASK A HUMAN BREAKS EVERY GUARANTEE ABOVE.
   * Answering from configuration would make `MountHost` an ambient grant of
   * whatever that configuration named.
   */
  pick(options: { readonly writable: boolean }): Promise<PickedFolder | null>;

  /**
   * How many folders may be granted at once. Default 8.
   *
   * A bound rather than none, because `pick` is callable in a loop and a
   * thousand live grants is a thousand roots every path check walks.
   */
  readonly maxGrants?: number;
}

interface Grant {
  readonly id: string;
  readonly name: string;
  /** Already `realpath`d at grant time. */
  readonly root: string;
  readonly writable: boolean;
  readonly grantedAt: number;
}

/** Methods that may touch a read-only grant. Everything else needs `writable`. */
const READING: ReadonlySet<string> = new Set(['realpath', 'readFile', 'readdir', 'stat', 'lstat']);

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

/**
 * A mount name from a directory: the basename, slugged, never empty.
 *
 * It becomes a path segment in the shell (`/mnt/<name>`), so it may not carry
 * a separator, a `.` that could read as `..`, or anything the shell would have
 * to quote. Unicode folder names are common and mostly survive; one made
 * entirely of punctuation falls back rather than producing an empty segment.
 */
export function mountNameFor(root: string, taken: ReadonlySet<string>): string {
  const slug = basename(root)
    .normalize('NFKD')
    .replace(/[^\p{Letter}\p{Number}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
    .toLowerCase();
  const base = slug === '' ? 'folder' : slug;
  if (!taken.has(base)) return base;
  // `notes-2`, not `notes (2)`: a space would need quoting at every prompt.
  for (let n = 2; ; n += 1) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** The refusal every path check answers with. Never names the resolved path. */
function refuse(method: string, requested: unknown): Error {
  const named = typeof requested === 'string' && requested.length <= 512 ? ` "${requested}"` : '';
  return new Error(
    `mount host: "${method}"${named} is not inside a folder you granted. Grants are made by ` +
      'choosing a folder, and a path that resolves out of one — through .. or a symlink — is ' +
      'outside it however it was spelled.',
  );
}

/**
 * Run the syscalls, and never let their message out.
 *
 * Same rule as `fs/filesystem.ts:io`: Node's `ENOENT`/`EACCES` messages carry
 * an absolute path, and here that path may be a symlink's TARGET — somewhere
 * the caller could not otherwise learn about. The errno code is kept because
 * it is what distinguishes "no such file" from "permission denied" for a user
 * reading shell output.
 */
async function io<T>(method: string, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    const named = typeof code === 'string' && /^[A-Z]{1,16}$/.test(code) ? ` (${code})` : '';
    throw new Error(`mount host: "${method}" failed${named}. The path is not echoed back.`);
  }
}

/**
 * Which grant a path belongs to, and where it really is.
 *
 * MOST SPECIFIC WINS when grants nest, which is what a mount table does and
 * the only rule that stays true as grants are added: a read-only grant of
 * `~/projects` must not silently make a writable grant of
 * `~/projects/scratch` read-only, nor the reverse. Nesting is easy to produce
 * with two clicks and the answer should not depend on click order.
 */
function locate(
  grants: ReadonlyMap<string, Grant>,
  path: unknown,
): { readonly grant: Grant; readonly real: string } | null {
  // The lexical floor, before any syscall. A NUL byte cannot escape a root,
  // but it makes the path this checks differ from the path Node opens, and a
  // guard whose answer describes a different file is not a guard.
  if (typeof path !== 'string' || path === '' || path.includes('\0')) return null;
  const candidate = resolve(path);

  let best: { grant: Grant; real: string } | null = null;
  for (const grant of grants.values()) {
    const real = confineRealPath(grant.root, candidate, { allowRoot: true });
    if (real === null) continue;
    if (best === null || grant.root.length > best.grant.root.length) best = { grant, real };
  }
  return best;
}

/**
 * The plugin implementation `PluginHost.register` takes.
 *
 * Pure: no Electron, no `app.getPath`, no environment. The chooser arrives in
 * `options.pick`.
 */
export function createMountPlugin(options: MountPluginOptions): PluginImplementation {
  const grants = new Map<string, Grant>();
  const maxGrants = options.maxGrants ?? 8;
  let nextId = 0;

  const info = (grant: Grant): MountGrantInfo => ({
    id: grant.id,
    name: grant.name,
    root: grant.root,
    writable: grant.writable,
    grantedAt: grant.grantedAt,
  });

  /**
   * Resolve and authorise in one place, so no method can skip half of it.
   *
   * `leafOnly` confines the PARENT and leaves the final component alone,
   * which is what `lstat` means and the only method that gets it. Resolving
   * the whole path would follow the very link the caller is asking about —
   * reporting its target, and refusing outright for a link pointing out of
   * the grant, so `ls -l` of a folder holding one stale `node_modules/.bin`
   * entry would fail entirely. Containment still holds: the parent goes
   * through the full check, what is appended is one path component, and
   * `lstat` does not follow it.
   */
  function gate(
    method: string,
    raw: unknown,
    leafOnly = false,
  ): { readonly grant: Grant; readonly real: string } {
    const request = asRecord(raw);
    const path = request['path'];
    if (leafOnly && typeof path === 'string' && path !== '' && !path.includes('\0')) {
      const candidate = resolve(path);
      const leaf = basename(candidate);
      const parent = dirname(candidate);
      if (leaf !== '' && leaf !== '.' && leaf !== '..' && parent !== candidate) {
        const found = locate(grants, parent);
        if (found === null) throw refuse(method, path);
        return { grant: found.grant, real: resolve(found.real, leaf) };
      }
    }
    const found = locate(grants, request['path']);
    if (found === null) throw refuse(method, request['path']);
    if (!READING.has(method) && !found.grant.writable) {
      throw new Error(
        `mount host: "${method}" needs write access to "${found.grant.name}", and that folder ` +
          'was granted for reading only. Grant it again and allow writing if that is what ' +
          'you meant.',
      );
    }
    return found;
  }

  const implementation: Record<string, PluginMethod> = {
    /**
     * The only way a grant is created.
     *
     * The root is `realpath`d BEFORE it is stored, so every later check
     * compares against the directory the person chose rather than the string
     * the chooser spelled it with — on macOS those differ routinely
     * (`/tmp` is `/private/tmp`), and confining to the unresolved spelling
     * refuses every legitimate path inside it.
     */
    pick: async (raw: unknown): Promise<MountGrantInfo | null> => {
      if (grants.size >= maxGrants) {
        throw new Error(
          `mount host: ${maxGrants} folders are already granted. Revoke one before granting ` +
            'another.',
        );
      }
      const wanted = asRecord(raw)['writable'] === true;
      const picked = await options.pick({ writable: wanted });
      if (picked === null) return null;

      // `confineRealPath(root, root, {allowRoot:true})` is `realpath` plus the
      // proof that it IS a directory we can resolve — a chooser that answered
      // with something unresolvable must not become a root every later check
      // compares against.
      const root = confineRealPath(picked.root, resolve(picked.root), { allowRoot: true });
      if (root === null) {
        throw new Error(
          'mount host: that folder could not be resolved, so it was not granted. Nothing is ' +
            'mounted against a path this host cannot confine to.',
        );
      }
      const entry: Grant = {
        id: `m${(nextId += 1)}`,
        name: mountNameFor(root, new Set([...grants.values()].map((g) => g.name))),
        root,
        // The host's answer. A chooser may grant less than was asked; it may
        // never grant more, so this is `&&` rather than `picked.writable`.
        writable: wanted && picked.writable,
        grantedAt: Date.now(),
      };
      grants.set(entry.id, entry);
      return info(entry);
    },

    list: async (): Promise<{ grants: MountGrantInfo[] }> => ({
      grants: [...grants.values()].map(info),
    }),

    revoke: async (raw: unknown): Promise<{ revoked: boolean }> => {
      const id = asRecord(raw)['id'];
      return { revoked: typeof id === 'string' && grants.delete(id) };
    },

    /**
     * The method everything else rests on.
     *
     * Answers the REAL path — symlinks followed — so a caller that resolves
     * first and acts second is acting on the file this host would open. The
     * shell does exactly that: `src/shell/mount.ts` resolves before it decides
     * whether a path is inside the mount at all.
     */
    realpath: async (raw: unknown): Promise<{ path: string }> => ({
      path: gate('realpath', raw).real,
    }),

    readFile: async (raw: unknown): Promise<{ data: string }> => {
      const { real } = gate('readFile', raw);
      return { data: await io('readFile', () => readFile(real, 'utf8')) };
    },

    writeFile: async (raw: unknown): Promise<void> => {
      const { real } = gate('writeFile', raw);
      const data = asRecord(raw)['data'];
      if (typeof data !== 'string') {
        throw new Error('mount host: "writeFile" needs its "data" as a UTF-8 string.');
      }
      await io('writeFile', () => writeFile(real, data, 'utf8'));
    },

    readdir: async (raw: unknown): Promise<{ entries: string[] }> => {
      const { real } = gate('readdir', raw);
      return { entries: await io('readdir', () => readdir(real)) };
    },

    stat: async (raw: unknown): Promise<MountStatInfo> => {
      const { real } = gate('stat', raw);
      const info_ = await io('stat', () => stat(real));
      return {
        isDirectory: info_.isDirectory(),
        // `stat` followed the link, so what it describes is the TARGET. A
        // caller that wanted to know about the link itself asked `lstat`.
        isSymbolicLink: false,
        size: info_.size,
        mtimeMs: info_.mtimeMs,
        mode: info_.mode,
      };
    },

    /**
     * The one method whose value is what it does NOT do.
     *
     * `gate(..., true)` confined the PARENT and left the final component
     * alone, so this answers about the LINK. That is safe and it is also the
     * only useful answer: resolving the leaf first would follow the link, and
     * for a link pointing out of the grant would refuse rather than report.
     *
     * It does not become a way to ask where a link points: `isSymbolicLink`
     * and a size are all that come back, and `readlink` is not on this
     * plugin's surface at all.
     */
    lstat: async (raw: unknown): Promise<MountStatInfo> => {
      const { real } = gate('lstat', raw, true);
      const info_ = await io('lstat', () => lstat(real));
      return {
        isDirectory: info_.isDirectory(),
        isSymbolicLink: info_.isSymbolicLink(),
        size: info_.size,
        mtimeMs: info_.mtimeMs,
        mode: info_.mode,
      };
    },

    mkdir: async (raw: unknown): Promise<void> => {
      const { real } = gate('mkdir', raw);
      const recursive = asRecord(raw)['recursive'] === true;
      await io('mkdir', () => mkdir(real, { recursive }));
    },

    /**
     * Delete, and the `recursive` flag is the caller's.
     *
     * `force` is NOT set: a caller asking to remove something that is not
     * there has made a mistake worth reporting, and this is the one method
     * where silence costs the user data rather than a message.
     */
    rm: async (raw: unknown): Promise<void> => {
      const { real } = gate('rm', raw);
      const recursive = asRecord(raw)['recursive'] === true;
      await io('rm', () => rm(real, { recursive }));
    },
  };

  return implementation as PluginImplementation;
}
