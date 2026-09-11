/**
 * The `RealFsPort` the shell's `/mnt` runs on, and the grants behind it (#246).
 *
 * `src/shell/mount.ts` is the routing and containment logic and holds no
 * filesystem at all — `src/` may not name a Node builtin, and a browser tab
 * has no real files. This is the seam between it and a platform that does:
 * `MountHost`, implemented on the desktop by `apps/desktop/src/fs/mounts.ts`
 * and refused honestly everywhere else.
 *
 * ## Two containment checks, on purpose
 *
 * `mount.ts` resolves a path and checks it landed inside the granted root;
 * `fs/mounts.ts` does the same thing again in the main process before it
 * touches a file. That is not redundancy to be tidied away — they protect
 * different things from different attackers:
 *
 *   - the renderer's check is what makes the SHELL's behaviour explainable:
 *     `/mnt/notes/../../etc/passwd` is refused with a message about the folder
 *     you granted, and the model driving the shell gets a coherent answer.
 *   - the host's check is what holds when the renderer is wrong or hostile. A
 *     web page is a thing that can be made to send any message; a main-process
 *     check that trusted the page's own bookkeeping would be decoration.
 *
 * If only one could exist it would be the host's. Both exist because the first
 * makes the feature usable and the second makes it safe.
 *
 * ## Grants are not persisted, and the shell must not cache them
 *
 * The host holds grants in memory for the life of the process and says why.
 * The consequence here is that {@link listGrants} is the truth and a copy of
 * it is not: a revoked grant that the shell still has in `ShellOptions.mounts`
 * would show a mount point whose every operation then fails in the host. So
 * the shell is REBUILT when grants change rather than patched — see
 * `ShellSheet`.
 */

import { create } from 'zustand';

import { capabilities } from '@/lib/platform';
import { MountHost } from '@/plugins/mount-host';
import type { MountGrantInfo } from '@/plugins/mount-host';
import type { MountGrant, RealFsPort, RealStat } from '@/shell/mount';

export type { MountGrantInfo };

/**
 * Can a folder be granted here at all?
 *
 * Asked of the platform table rather than the plugin, which is the unusual
 * direction and the reason is on `folderGrants` itself: on a served
 * deployment the plugin would work perfectly and open a chooser on somebody
 * else's screen.
 */
export function canGrantFolders(): boolean {
  return capabilities().folderGrants;
}

/**
 * Ask the person for a folder. `null` when they declined, or cannot be asked.
 *
 * `writable` is a REQUEST. The answer's own `writable` is what was agreed, and
 * may be `false` for a grant that asked for `true` — the host asks separately
 * about changing files and defaults to no. Callers must read it back rather
 * than assume they got what they asked for.
 */
export async function grantFolder(options?: { writable?: boolean }): Promise<MountGrantInfo | null> {
  if (!canGrantFolders()) return null;
  return MountHost.pick({ writable: options?.writable === true });
}

export async function listGrants(): Promise<readonly MountGrantInfo[]> {
  if (!canGrantFolders()) return [];
  const { grants } = await MountHost.list();
  return grants;
}

export async function revokeGrant(id: string): Promise<boolean> {
  if (!canGrantFolders()) return false;
  const { revoked } = await MountHost.revoke({ id });
  return revoked;
}

/** What the shell needs from a grant, dropping the host's bookkeeping. */
export function asMountGrant(info: MountGrantInfo): MountGrant {
  return { name: info.name, root: info.root, writable: info.writable };
}

/**
 * The port itself: nine methods, each one plugin call, no logic.
 *
 * DELIBERATELY THIN. Every decision — which grant a path belongs to, whether
 * it escapes, whether the grant allows writing — is made in one of the two
 * places named at the top of this file. A convenience added here (a cache, a
 * retry, a normalisation) would be a third place that can disagree with both.
 */
export const mountHostPort: RealFsPort = {
  async readFile(path: string): Promise<string> {
    const { data } = await MountHost.readFile({ path });
    return data;
  },
  async writeFile(path: string, content: string): Promise<void> {
    await MountHost.writeFile({ path, data: content });
  },
  async readdir(path: string): Promise<readonly string[]> {
    const { entries } = await MountHost.readdir({ path });
    return entries;
  },
  async stat(path: string): Promise<RealStat> {
    return MountHost.stat({ path });
  },
  async lstat(path: string): Promise<RealStat> {
    return MountHost.lstat({ path });
  },
  async mkdir(path: string, options?: { readonly recursive?: boolean }): Promise<void> {
    await MountHost.mkdir({ path, recursive: options?.recursive === true });
  },
  async rm(path: string, options?: { readonly recursive?: boolean }): Promise<void> {
    await MountHost.rm({ path, recursive: options?.recursive === true });
  },
  async realpath(path: string): Promise<string> {
    const resolved = await MountHost.realpath({ path });
    return resolved.path;
  },
};


/* ── The grants, mirrored where every reader can see the same list ────── */

/**
 * A MIRROR, NOT A RECORD. The grants themselves live in the host process and
 * nothing here can create one — this store asks, and displays the answer. It
 * is a store rather than a `useState` in one component because `privacy`,
 * `mount list`, the shell's filesystem and anything added later must all be
 * looking at the same list; a component holding its own copy is how one of
 * them ends up naming a folder the user withdrew ten seconds ago.
 *
 * IT LIVES IN `src/shell/` RATHER THAN `src/state/`, which is where a zustand
 * store would otherwise go, because `tests/layering.test.ts` forbids a store
 * importing the shell — the shell reads every store, and a store reading it
 * back is the cycle that once produced a blank page at startup. This one is
 * unavoidably shell-shaped: it exists to feed `ShellOptions.mounts` and is
 * built out of `mount.ts`'s own types. So it sits on the shell's side of the
 * boundary and the direction stays one-way.
 *
 * NOT PERSISTED, DELIBERATELY, and the host is why: it holds grants in memory
 * for the life of the process, so a `db` table here would restore rows that no
 * longer correspond to anything and show mounts whose every operation fails.
 * "Grants end when the app closes" is a consequence of the host's design, and
 * this file must not quietly contradict it.
 */
interface MountState {
  grants: readonly MountGrantInfo[];
  /** False where no chooser can be put in front of a person. See `folderGrants`. */
  canGrant: boolean;
  refresh: () => Promise<void>;
  /**
   * Open the chooser. Answers what was AGREED, which may be less than asked:
   * write access is a second question the host asks and defaults to no.
   */
  grant: (writable: boolean) => Promise<MountGrantInfo | null>;
  revoke: (id: string) => Promise<boolean>;
}

export const useMounts = create<MountState>((set, get) => ({
  grants: [],
  canGrant: canGrantFolders(),

  async refresh() {
    set({ grants: await listGrants() });
  },

  async grant(writable) {
    const granted = await grantFolder({ writable });
    // Re-read rather than appending the answer: the host is the record, and a
    // list built by appending diverges the first time a grant fails to be
    // stored for a reason this side did not predict.
    await get().refresh();
    return granted;
  },

  async revoke(id) {
    const revoked = await revokeGrant(id);
    await get().refresh();
    return revoked;
  },
}));

/** The grants in the shape `ChatterangShell` mounts, read live. */
export function shellMounts(): readonly MountGrant[] {
  return useMounts.getState().grants.map(asMountGrant);
}
