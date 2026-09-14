/**
 * The desktop's tunnel key, sealed with Electron's `safeStorage` (#179).
 *
 * The store itself — owner-only or refused, never repaired, never quietly
 * replaced — is `packages/tunnel/src/host/identity-store.ts`, shared with the
 * headless server. What is desktop here is two things: the directory
 * (`app.getPath('userData')`, so the key sits beside `userData/files`, never
 * inside the tree the renderer's filesystem maps) and the sealer.
 *
 * IMPORTS NO ELECTRON, the `permissions.ts` pattern: typed against the three
 * `safeStorage` methods it calls, so `tests/tunnel-identity-store.test.ts` runs
 * the real store with a fake that encrypts, one that cannot, and one that lies.
 *
 * `isEncryptionAvailable()` DECIDES, ONCE PER CALL. True: a new key is written
 * sealed, and a sealed key can be read. False: a new key is written as a plain
 * 0600 file, and a sealed key is REFUSED rather than replaced — which is what
 * a Linux session without its keyring looks like, and a fresh key there would
 * be a silent re-pair of every device. Electron answers false before `ready`,
 * so this must be called after it. The synchronous methods are the ones Electron
 * 44's own declarations carry without a deprecation; Electron's newer docs move
 * to async variants, and following them is a change to this one adapter.
 *
 * NOTHING CALLS THIS YET. `main.ts` starts no listener (#158, #169) and does not
 * create the identity either; wiring it is part of the change that starts one.
 */

import * as fsPromises from 'node:fs/promises';

import { loadOrCreateTunnelKey } from '@chatterang/tunnel/host';
import type { KeyFileSystem, StoredTunnelKey } from '@chatterang/tunnel/host';

/** The three methods of Electron's `safeStorage` this uses, and nothing else. */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Uint8Array;
  decryptString(encrypted: Buffer): string;
}

export interface DesktopTunnelKeyOptions {
  /** `app.getPath('userData')`. */
  readonly userData: string;
  readonly safeStorage: SafeStorageLike;
  /** `node:fs/promises` unless a test says otherwise. */
  readonly fs?: KeyFileSystem;
  /** `process.platform` unless a test says otherwise. */
  readonly platform?: string;
  /** `process.getuid()` unless a test says otherwise. */
  readonly uid?: number;
}

/** Load the desktop's tunnel key, or create it sealed where `safeStorage` can seal. */
export function loadOrCreateDesktopTunnelKey(options: DesktopTunnelKeyOptions): Promise<StoredTunnelKey> {
  const { safeStorage } = options;
  return loadOrCreateTunnelKey({
    dataDirectory: options.userData,
    fs: options.fs ?? fsPromises,
    sealer: safeStorage.isEncryptionAvailable()
      ? {
          seal: (plaintext) => safeStorage.encryptString(plaintext),
          unseal: (sealed) => safeStorage.decryptString(Buffer.from(sealed)),
        }
      : null,
    platform: options.platform ?? process.platform,
    uid: options.uid ?? process.getuid?.() ?? -1,
  });
}
