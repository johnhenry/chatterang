/**
 * Web implementation of `MountHost`: there are no mounts in a browser tab.
 *
 * A PLAIN REFUSAL, not a shim. The other web shims in this directory simulate
 * — `llama-cpp/web.ts` synthesises a response and reports `simulated: true` —
 * because a fake token stream keeps every screen exercisable and is labelled
 * where the user can see it. A fake filesystem is not the same kind of thing:
 * the shell would show `/mnt/notes` with files in it, and the person reading
 * that output has no way to tell invented files from their own. #246's whole
 * value is that what is under `/mnt` really is the folder they chose.
 *
 * `pick` answering `null` and `list` answering empty is what "no folders are
 * granted" looks like, so the shell's ordinary empty-state path handles the
 * browser with no branch of its own. The path methods throw, and would only be
 * reached by a caller acting on a mount `list` never returned.
 *
 * The File System Access API is the obvious thing to reach for here and does
 * not fit: it hands out a directory HANDLE, with no path and no `realpath`.
 * The containment rule in `src/shell/mount.ts` is "resolve, then check where
 * it landed", and a handle-based API cannot answer the resolve half — its own
 * containment is structural instead (a handle only reaches its own subtree).
 * That is a different design worth doing on its own terms, not a shim.
 */

import { WebPlugin } from '@capacitor/core';
import type { MountGrantInfo, MountHostPlugin, MountStatInfo } from './definitions';

function unavailable(method: string): Error {
  return new Error(
    `MountHost: "${method}" is not available in a browser. Folders are granted on the ` +
      'desktop app, where a real chooser can ask for one. Nothing is mounted here, and ' +
      'inventing a folder would put files in the shell that are not on your disk.',
  );
}

export class MountHostWeb extends WebPlugin implements MountHostPlugin {
  /** Not "refused" — indistinguishable from a cancelled picker, which is the truth. */
  async pick(): Promise<MountGrantInfo | null> {
    return null;
  }

  async list(): Promise<{ grants: readonly MountGrantInfo[] }> {
    return { grants: [] };
  }

  async revoke(): Promise<{ revoked: boolean }> {
    return { revoked: false };
  }

  async realpath(): Promise<{ path: string }> {
    throw unavailable('realpath');
  }

  async readFile(): Promise<{ data: string }> {
    throw unavailable('readFile');
  }

  async writeFile(): Promise<void> {
    throw unavailable('writeFile');
  }

  async readdir(): Promise<{ entries: readonly string[] }> {
    throw unavailable('readdir');
  }

  async stat(): Promise<MountStatInfo> {
    throw unavailable('stat');
  }

  async lstat(): Promise<MountStatInfo> {
    throw unavailable('lstat');
  }

  async mkdir(): Promise<void> {
    throw unavailable('mkdir');
  }

  async rm(): Promise<void> {
    throw unavailable('rm');
  }
}
