/**
 * The desktop's tunnel key, sealed with Electron's `safeStorage` (#179).
 *
 * The store itself — owner-only or refused, never repaired, never quietly
 * replaced — is `packages/tunnel/src/host/identity-store.ts`, shared with the
 * headless server. What is desktop here is three things: the directory
 * (`app.getPath('userData')`, so the key sits beside `userData/files`, never
 * inside the tree the renderer's filesystem maps), the sealer, and when it may
 * be asked.
 *
 * IMPORTS NO ELECTRON, the `permissions.ts` pattern: typed against the
 * `safeStorage` methods and the one `app` method it calls, so
 * `tests/tunnel-identity-store.test.ts` runs the real store with a fake that
 * encrypts, one that cannot, and one that lies.
 *
 * AFTER `ready`, OR REFUSED. Electron's `isEncryptionAvailable()` answers false
 * on Linux and Windows until the app has emitted `ready`. A false answer writes
 * a plain key, and once `safeStorage` can seal, the store refuses a plain key as
 * a downgrade — so one early call would leave a key every later start refuses.
 * The order is therefore checked, through `app.isReady()`, before `safeStorage`
 * is asked anything, rather than left to a comment.
 *
 * WHAT COUNTS AS BEING ABLE TO SEAL, DECIDED ONCE PER CALL: `isEncryptionAvailable()`
 * true, and on Linux a real secret store behind it. Electron's documentation
 * says that where it finds no secret store — `getSelectedStorageBackend()`
 * returns `basic_text` — what `safeStorage` encrypts is unprotected, because the
 * password is hard-coded. A key sealed that way would be reported `sealed` while
 * being as readable as a plain file. So on Linux only the named secret stores
 * seal; `basic_text`, `unknown`, and any backend a later Electron adds write a
 * plain 0600 file and say so. Able to seal: a new key is written sealed, a
 * sealed key can be read, and a plain key is refused (a downgrade). Unable: a
 * new key is written plain, and a sealed key is REFUSED rather than replaced —
 * which is what a Linux session without its keyring looks like, and a fresh key
 * there would be a silent re-pair of every device.
 *
 * ON WINDOWS, SEALED OR NOTHING (#179's second ruling). `safeStorage` there is
 * DPAPI, which Electron documents as available once `ready` has been emitted
 * and as protecting what it encrypts from other users of the machine — not from
 * other apps running as the same user. The sealer is the same one macOS gets,
 * with no backend to ask. What differs is in the store: it keeps a Windows key
 * only sealed, so if `isEncryptionAvailable()` is false after `ready` nothing is
 * written and the call is refused (`encryption-unavailable`), and the file's
 * owner and DACL are read with Get-Acl in place of a mode. DPAPI is documented
 * as decrypting only for the logon credential that encrypted, so a sealed key
 * that reaches another account or another machine does not unseal, and is
 * refused rather than replaced, like any other.
 *
 * The synchronous methods are the ones Electron 44's own declarations carry
 * without a deprecation; Electron's newer docs move to async variants, and
 * following them is a change to this one adapter.
 *
 * NOTHING CALLS THIS YET. `main.ts` starts no listener (#158, #169) and does not
 * create the identity either; wiring it is part of the change that starts one.
 */

import * as fsPromises from 'node:fs/promises';

import { TunnelIdentityError, loadOrCreateTunnelKey } from '@chatterang/tunnel/host';
import type { KeyFileSystem, KeySealer, StoredTunnelKey, WindowsToolRunner } from '@chatterang/tunnel/host';

/** The methods of Electron's `safeStorage` this uses, and nothing else. */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Uint8Array;
  decryptString(encrypted: Buffer): string;
  /** Linux only; called only there. */
  getSelectedStorageBackend(): string;
}

/** The one method of Electron's `app` this uses. */
export interface AppReadyLike {
  isReady(): boolean;
}

export interface DesktopTunnelKeyOptions {
  /** `app.getPath('userData')`. */
  readonly userData: string;
  /** Electron's `app`: asked whether `ready` has been emitted, and nothing else. */
  readonly app: AppReadyLike;
  readonly safeStorage: SafeStorageLike;
  /** `node:fs/promises` unless a test says otherwise. */
  readonly fs?: KeyFileSystem;
  /** `process.platform` unless a test says otherwise. */
  readonly platform?: string;
  /** `process.getuid()` unless a test says otherwise. Not read on Windows. */
  readonly uid?: number;
  /** Windows only: runs `whoami` and PowerShell's Get-Acl. `execFile` unless a test says otherwise. */
  readonly runWindowsTool?: WindowsToolRunner;
  /** Windows only: `process.env.SystemRoot` unless a test says otherwise. */
  readonly systemRoot?: string;
}

/**
 * The Linux backends that are a secret store. An allowlist: a backend this
 * build has not heard of writes a plain file, which is labelled plain, rather
 * than a "sealed" one nobody has checked.
 */
const LINUX_SECRET_STORES: ReadonlySet<string> = new Set(['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6']);

function sealerFor(safeStorage: SafeStorageLike, platform: string): KeySealer | null {
  if (!safeStorage.isEncryptionAvailable()) return null;
  if (platform === 'linux' && !LINUX_SECRET_STORES.has(safeStorage.getSelectedStorageBackend())) return null;
  return {
    seal: (plaintext) => safeStorage.encryptString(plaintext),
    unseal: (sealed) => safeStorage.decryptString(Buffer.from(sealed)),
  };
}

/** Load the desktop's tunnel key, or create it sealed where `safeStorage` can really seal. */
export async function loadOrCreateDesktopTunnelKey(options: DesktopTunnelKeyOptions): Promise<StoredTunnelKey> {
  if (!options.app.isReady()) {
    throw new TunnelIdentityError(
      'not-ready',
      "the tunnel key was asked for before Electron's ready event, when safeStorage cannot yet say whether it can seal",
    );
  }
  const platform = options.platform ?? process.platform;
  return loadOrCreateTunnelKey({
    dataDirectory: options.userData,
    fs: options.fs ?? fsPromises,
    sealer: sealerFor(options.safeStorage, platform),
    platform,
    uid: options.uid ?? process.getuid?.() ?? -1,
    runWindowsTool: options.runWindowsTool,
    systemRoot: options.systemRoot,
  });
}
