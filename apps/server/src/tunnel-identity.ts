/**
 * The headless server's tunnel key: a 0600 file under `--root` (#179).
 *
 *   <root>/tunnel-identity/key    0600, in a 0700 directory
 *
 * Beside `<root>/server-token` and outside `<root>/files`, the tree the server
 * maps as `Directory.Data`/`Directory.Cache` — so no peer's `readFile` reaches
 * it. The store is `packages/tunnel/src/host/identity-store.ts`, the same one
 * the desktop uses (#158: one implementation, two callers). The server has no
 * `safeStorage` and no keychain, so it never seals, and a sealed key file is
 * refused here rather than replaced (#179's ruling: a plain owner-only file).
 *
 * NOT ON WINDOWS. The store keeps a Windows key only sealed with DPAPI (#179's
 * second ruling, which is about the desktop), and the server has nothing to seal
 * with, so on Windows it stores no key and is refused (`encryption-unavailable`)
 * — as it was refused before Windows was supported at all. A headless Windows
 * host is a question nobody has ruled on.
 *
 * UNLIKE `token.ts`, a wide file is refused, not tightened; the store's header
 * says why. And unlike the token, nothing here is printed: the key is never
 * shown to anyone, and its pin reaches a phone through pairing (#134).
 *
 * NOTHING CALLS THIS YET. `main.ts` starts no tunnel listener; wiring it is
 * part of the change that starts one, together with the entry for this file in
 * `main.ts`'s layout comment.
 */

import * as fsPromises from 'node:fs/promises';

import { loadOrCreateTunnelKey } from '@chatterang/tunnel/host';
import type { KeyFileSystem, StoredTunnelKey } from '@chatterang/tunnel/host';

export interface ServerTunnelKeyOptions {
  /** The resolved `--root`. */
  readonly root: string;
  /** `node:fs/promises` unless a test says otherwise. */
  readonly fs?: KeyFileSystem;
  /** `process.platform` unless a test says otherwise. */
  readonly platform?: string;
  /** `process.getuid()` unless a test says otherwise. */
  readonly uid?: number;
}

/** Load the server's tunnel key, or create it as a plain owner-only file. */
export function loadOrCreateServerTunnelKey(options: ServerTunnelKeyOptions): Promise<StoredTunnelKey> {
  return loadOrCreateTunnelKey({
    dataDirectory: options.root,
    fs: options.fs ?? fsPromises,
    sealer: null,
    platform: options.platform ?? process.platform,
    uid: options.uid ?? process.getuid?.() ?? -1,
  });
}
