// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { hasDisguisingCharacter } from '@/features/pairing/wording';
import {
  DeviceRegistryError,
  TunnelIdentityError,
  createDeviceCredentials,
  loadOrCreateTunnelKey,
  openDeviceRegistry,
  type AccessControlListing,
  type CredentialStore,
  type DeviceRegistry,
  type DeviceRegistryErrorReason,
  type DeviceRegistryOptions,
  type DeviceRemoval,
  type KeyFileHandle,
  type KeySealer,
  type MintedCredential,
  type RegistryFileSystem,
  type WindowsToolRunner,
} from '@chatterang/tunnel/host';
import { openWindow, type PairingWindow } from '@chatterang/tunnel/pairing';

/**
 * #133: the paired-device registry, on the real filesystem.
 *
 * The owner ruled that the desktop keeps its list "in an app-data file next to
 * the certificate key (#179): owner-only permissions, encrypted with
 * `safeStorage` where available", holding what verification and revocation
 * need and never the credential, and that it may land tested but unreachable.
 * The server keeps the same records under `--root` (#158: one implementation).
 *
 * Every test runs the real store over a real temporary directory, through
 * `createDeviceCredentials` where a credential is involved, and "a restart" is
 * a second registry opened over the same files. Where the machine cannot
 * produce a case — another account's uid, a Windows descriptor, a rename that
 * fails — a wrapper lies about exactly one answer.
 */

const uid = process.getuid?.() ?? -1;
const realFs: RegistryFileSystem = fsPromises;
const onDarwin = process.platform === 'darwin';
const onPosix = process.platform !== 'win32';
const NOW = 1_757_808_000_000;

interface TestSealer extends KeySealer {
  readonly calls: { seal: number; unseal: number };
}

/**
 * A sealer that really encrypts — AES-256-GCM under a key only this object
 * holds — so a sealed file holds none of what it seals, a flipped byte fails,
 * and the tests can decrypt what the store wrote before searching it.
 */
function testSealer(): TestSealer {
  const secret = randomBytes(32);
  const sealer: TestSealer = {
    calls: { seal: 0, unseal: 0 },
    seal(plaintext) {
      sealer.calls.seal += 1;
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', secret, iv);
      const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), body]);
    },
    unseal(sealed) {
      sealer.calls.unseal += 1;
      const bytes = Buffer.from(sealed);
      const decipher = createDecipheriv('aes-256-gcm', secret, bytes.subarray(0, 12));
      decipher.setAuthTag(bytes.subarray(12, 28));
      return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8');
    },
  };
  return sealer;
}

let base: string;
let sealer: TestSealer;
let bindTo: Uint8Array;

beforeEach(() => {
  // mkdtemp makes it 0700 and ours: an ordinary data directory.
  base = realpathSync(mkdtempSync(join(tmpdir(), 'chatterang-paired-devices-')));
  sealer = testSealer();
  bindTo = randomBytes(32);
});

afterEach(() => {
  // Strip any ACL a test added, so nothing it granted outlives it.
  if (onDarwin) execFileSync('/bin/chmod', ['-RN', base]);
  if (existsSync(join(base, 'tunnel-identity'))) chmodSync(join(base, 'tunnel-identity'), 0o700);
  chmodSync(base, 0o700);
  rmSync(base, { recursive: true, force: true });
});

const keyDirectory = (root = base): string => join(root, 'tunnel-identity');
const registryFile = (root = base): string => join(keyDirectory(root), 'paired-devices');

function options(overrides: Partial<DeviceRegistryOptions> = {}): DeviceRegistryOptions {
  return {
    dataDirectory: base,
    fs: realFs,
    sealer,
    platform: process.platform,
    uid,
    bindTo,
    now: () => NOW,
    ...overrides,
  };
}

const open = (overrides: Partial<DeviceRegistryOptions> = {}): Promise<DeviceRegistry> =>
  openDeviceRegistry(options(overrides));

/** A pairing window that `openWindow` made and a phone claimed: what `mint` asks for. */
function claimedWindow(): PairingWindow {
  const secret = randomBytes(32);
  const window = openWindow({ secret, now: 0 });
  expect(window.claim(secret, 0).ok).toBe(true);
  return window;
}

const mint = (store: CredentialStore): Promise<MintedCredential> =>
  createDeviceCredentials(store).mint(claimedWindow(), 0);

const verifyOn = (registry: DeviceRegistry, credential: string): Promise<string | null> =>
  createDeviceCredentials(registry.store).verify(credential);

/** A store whose delete fails and whose get and set are the registry's own. */
function deleteFails(store: CredentialStore): CredentialStore {
  return {
    get: (deviceId) => store.get(deviceId),
    set: (deviceId, digest) => store.set(deviceId, digest),
    delete: async () => {
      throw Object.assign(new Error('EIO: the delete failed'), { code: 'EIO' });
    },
  };
}

async function refused(promise: Promise<unknown>, reason: DeviceRegistryErrorReason): Promise<DeviceRegistryError> {
  const error = await promise.then(
    () => {
      throw new Error(`expected a refusal (${reason}), and it succeeded`);
    },
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(DeviceRegistryError);
  expect((error as DeviceRegistryError).reason, (error as Error).message).toBe(reason);
  return error as DeviceRegistryError;
}

interface StoredRecord {
  readonly deviceId: string;
  readonly digest: string;
  readonly name: string;
  readonly pairedAt: number;
}

interface Envelope {
  readonly format: unknown;
  readonly version: unknown;
  readonly protection: unknown;
  readonly bindTo: unknown;
  readonly contents: unknown;
}

const envelopeOf = (path = registryFile()): Envelope => JSON.parse(readFileSync(path, 'utf8')) as Envelope;

/** The records, decrypted with the test's sealer where the file is sealed. */
function contentsOf(
  envelope: Envelope,
  with_: KeySealer | null = sealer,
): { readonly bindTo: string; readonly devices: readonly StoredRecord[] } {
  if (envelope.protection === 'sealed') {
    return JSON.parse(with_!.unseal(Buffer.from(envelope.contents as string, 'base64'))) as {
      bindTo: string;
      devices: StoredRecord[];
    };
  }
  return envelope.contents as { bindTo: string; devices: StoredRecord[] };
}

const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64');
const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('base64');
const temporaries = (root = base): string[] => readdirSync(keyDirectory(root)).filter((name) => name.endsWith('.tmp'));

interface Faults {
  readonly fs: RegistryFileSystem;
  /** Fail the `nth` rename from now (1 = the next one). */
  failRename(nth: number): void;
  /** The next handle `writeFile` writes half of what it was given, then throws. */
  failWriteHalfway(): void;
  /** The next `unlink` throws, and removes nothing. */
  failNextUnlink(): void;
  readonly renames: string[];
}

/** `node:fs/promises`, with a rename, a write or an unlink that fails on request. */
function faulty(): Faults {
  let renameCountdown = 0;
  let halfway = false;
  let unlinkFails = false;
  const renames: string[] = [];
  const fs: RegistryFileSystem = {
    ...realFs,
    rename: async (from, to) => {
      renames.push(to);
      if (renameCountdown > 0) {
        renameCountdown -= 1;
        if (renameCountdown === 0) throw Object.assign(new Error('EIO: rename failed'), { code: 'EIO' });
      }
      return fsPromises.rename(from, to);
    },
    unlink: async (path) => {
      if (unlinkFails) {
        unlinkFails = false;
        throw Object.assign(new Error('EIO: unlink failed'), { code: 'EIO' });
      }
      return fsPromises.unlink(path);
    },
    open: async (path, flags, mode) => {
      const handle = await fsPromises.open(path, flags, mode);
      const wrapped: KeyFileHandle = {
        stat: () => handle.stat(),
        readFile: () => handle.readFile(),
        writeFile: async (data) => {
          if (halfway) {
            halfway = false;
            await handle.writeFile(data.slice(0, Math.floor(data.length / 2)));
            throw Object.assign(new Error('ENOSPC: no space left'), { code: 'ENOSPC' });
          }
          await handle.writeFile(data);
        },
        sync: () => handle.sync(),
        close: () => handle.close(),
      };
      return wrapped;
    },
  };
  return {
    fs,
    renames,
    failRename: (nth) => {
      renameCountdown = nth;
    },
    failWriteHalfway: () => {
      halfway = true;
    },
    failNextUnlink: () => {
      unlinkFails = true;
    },
  };
}

describe('the paired-device registry (#133): verification data only, in one owner-only file beside the tunnel key', () => {
  describe('a paired phone is remembered across a restart', () => {
    it('a credential minted over the registry verifies through a registry opened after a restart', async () => {
      const registry = await open();
      expect(registry.cleared).toBeNull();
      const { deviceId, credential } = await mint(registry.store);

      // Beside the key, in the key store's owner-only directory, and nothing else left behind.
      expect(registry.path).toBe(registryFile());
      expect(readdirSync(keyDirectory()).sort()).toEqual(['key', 'paired-devices']);
      if (onPosix) expect(statSync(registryFile()).mode & 0o777).toBe(0o600);

      const restarted = await open();
      expect(restarted.cleared).toBeNull();
      expect(await verifyOn(restarted, credential)).toBe(deviceId);
      const wrong = `${credential.slice(0, -1)}${credential.endsWith('A') ? 'B' : 'A'}`;
      expect(await verifyOn(restarted, wrong)).toBeNull();
      expect(restarted.list()).toEqual([{ deviceId, name: '', pairedAt: NOW, revoked: false }]);
    });

    it('is bound, on the desktop, to the pin of the key it sits beside, and kept the way the key is kept', async () => {
      const stored = await loadOrCreateTunnelKey({ dataDirectory: base, fs: realFs, sealer, platform: process.platform, uid });
      const registry = await open({ bindTo: stored.key.pin.spki });
      await mint(registry.store);
      expect(registry.protection).toBe(stored.protection);
      expect(envelopeOf()).toMatchObject({
        format: 'chatterang-paired-devices',
        version: 1,
        protection: 'sealed',
        bindTo: stored.key.pin.spkiSha256,
      });
    });

    it('keeps every one of several mints made at once, across a restart', async () => {
      const registry = await open();
      const minted = await Promise.all([1, 2, 3, 4, 5].map(() => mint(registry.store)));
      expect(registry.list()).toHaveLength(5);

      const restarted = await open();
      for (const { deviceId, credential } of minted) {
        expect(await verifyOn(restarted, credential)).toBe(deviceId);
      }
      expect(restarted.list().map((device) => device.deviceId).sort()).toEqual(
        minted.map((device) => device.deviceId).sort(),
      );
    });
  });

  describe('a revocation outlives the process', () => {
    it('a revoke whose delete throws leaves the tombstone, and a registry opened after a restart still refuses it', async () => {
      const registry = await open();
      const credentials = createDeviceCredentials(deleteFails(registry.store));
      const gone = await credentials.mint(claimedWindow(), 0);
      const kept = await credentials.mint(claimedWindow(), 0);

      await expect(credentials.revoke(gone.deviceId)).rejects.toThrow(/delete failed/);

      const restarted = await open();
      expect(await verifyOn(restarted, gone.credential)).toBeNull();
      expect(await verifyOn(restarted, kept.credential)).toBe(kept.deviceId);
      expect(restarted.list().find((device) => device.deviceId === gone.deviceId)?.revoked).toBe(true);
      const record = contentsOf(envelopeOf()).devices.find((device) => device.deviceId === gone.deviceId);
      expect(record?.digest).toBe('');
    });

    it('when rename throws, the previous file is still readable, and a revoke’s tombstone still refuses after a restart', async () => {
      const faults = faulty();
      const registry = await open({ fs: faults.fs });
      const credentials = createDeviceCredentials(registry.store);
      const gone = await credentials.mint(claimedWindow(), 0);
      const kept = await credentials.mint(claimedWindow(), 0);

      // The revoke's tombstone is the next write; its delete is the one after.
      faults.failRename(2);
      await expect(credentials.revoke(gone.deviceId)).rejects.toThrow(/rename failed/);
      expect(temporaries()).toEqual([]);

      const restarted = await open();
      expect(await verifyOn(restarted, gone.credential)).toBeNull();
      expect(await verifyOn(restarted, kept.credential)).toBe(kept.deviceId);

      // A mint whose rename fails: nothing changes on disk or in memory.
      const before = readFileSync(registryFile());
      faults.failRename(1);
      await expect(mint(registry.store)).rejects.toThrow(/rename failed/);
      expect(readFileSync(registryFile())).toEqual(before);
      expect(temporaries()).toEqual([]);
      expect(registry.list().map((device) => device.deviceId).sort()).toEqual([gone.deviceId, kept.deviceId].sort());
      expect((await open()).list()).toHaveLength(2);
    });

    it('a write that fails part way leaves the previous file whole', async () => {
      const faults = faulty();
      const registry = await open({ fs: faults.fs });
      const kept = await mint(registry.store);
      const before = readFileSync(registryFile());

      faults.failWriteHalfway();
      await expect(mint(registry.store)).rejects.toThrow(/ENOSPC/);
      expect(readFileSync(registryFile())).toEqual(before);
      expect(temporaries()).toEqual([]);

      const restarted = await open();
      expect(await verifyOn(restarted, kept.credential)).toBe(kept.deviceId);
      expect(restarted.list()).toHaveLength(1);
    });
  });

  /*
   * #131: a revocation leaves nothing behind. A write's private name holds a
   * whole copy of the records — every id, digest and name, in the clear where
   * nothing seals — so one that is never renamed or removed would outlive the
   * revoke and the reset that were meant to forget the phone.
   */
  describe('a copy an unfinished write left behind is removed', () => {
    const stalePath = (): string => join(keyDirectory(), 'paired-devices.0011223344556677.tmp');

    it('a copy a killed process left is removed at the next open, so a revoke and a reset then leave nothing that names the phone', async () => {
      const registry = await open({ sealer: null });
      const { deviceId } = await mint(registry.store);
      await registry.setName(deviceId, 'Alice’s phone');

      // Killed after its private name was written and synced, before the rename:
      // on disk, that is a write whose rename and whose clean-up both failed.
      const dying = faulty();
      const killed = await open({ sealer: null, fs: dying.fs });
      dying.failRename(1);
      dying.failNextUnlink();
      await expect(killed.setName(deviceId, 'Alice’s old phone')).rejects.toThrow(/rename failed/);
      expect(temporaries()).toHaveLength(1);
      expect(readFileSync(join(keyDirectory(), temporaries()[0]!), 'utf8')).toContain(deviceId);

      // Removed on open, before anything is written.
      const restarted = await open({ sealer: null });
      expect(temporaries()).toEqual([]);

      expect(await createDeviceCredentials(restarted.store).revoke(deviceId)).toBe(true);
      await restarted.reset();
      expect(readdirSync(keyDirectory()).sort()).toEqual(['key', 'paired-devices']);
      const left = readFileSync(registryFile(), 'utf8');
      expect(left).not.toContain(deviceId);
      expect(left).not.toContain('Alice');
    });

    it('a copy this process could not remove is removed by its next change, so the revoke after it leaves nothing that names the phone', async () => {
      const faults = faulty();
      const registry = await open({ sealer: null, fs: faults.fs });
      const credentials = createDeviceCredentials(registry.store);
      const gone = await credentials.mint(claimedWindow(), 0);
      const kept = await credentials.mint(claimedWindow(), 0);
      await registry.setName(gone.deviceId, 'Alice’s phone');

      faults.failRename(1);
      faults.failNextUnlink();
      await expect(registry.setName(gone.deviceId, 'Alice’s old phone')).rejects.toThrow(/rename failed/);
      expect(temporaries()).toHaveLength(1);

      expect(await credentials.revoke(gone.deviceId)).toBe(true);
      expect(readdirSync(keyDirectory()).sort()).toEqual(['key', 'paired-devices']);
      const left = readFileSync(registryFile(), 'utf8');
      expect(left).not.toContain(gone.deviceId);
      expect(left).not.toContain('Alice');
      expect(left).toContain(kept.deviceId);
    });

    it.runIf(onPosix)('removes only its own private names, takes one already gone as removed, and syncs the directory after', async () => {
      const registry = await open();
      const kept = await mint(registry.store);
      writeFileSync(stalePath(), readFileSync(registryFile()), { mode: 0o600 });
      // The key store's private name, and names this build does not write.
      const others = ['key.0011223344556677.tmp', 'paired-devices.backup', 'paired-devices.00112233445566AA.tmp'];
      for (const name of others) writeFileSync(join(keyDirectory(), name), 'not the registry’s\n', { mode: 0o600 });

      const steps: string[] = [];
      const recording: RegistryFileSystem = {
        ...realFs,
        // One more, gone by the time it is removed.
        readdir: async (path) => [...(await fsPromises.readdir(path)), 'paired-devices.ffffffffffffffff.tmp'],
        unlink: async (path) => {
          steps.push(`unlink ${path}`);
          await fsPromises.unlink(path);
        },
        open: async (path, flags, mode) => {
          const handle = await fsPromises.open(path, flags, mode);
          return {
            stat: () => handle.stat(),
            readFile: () => handle.readFile(),
            writeFile: (data) => handle.writeFile(data),
            sync: async () => {
              steps.push(`sync ${path}`);
              await handle.sync();
            },
            close: () => handle.close(),
          };
        },
      };

      const restarted = await open({ fs: recording });
      expect(existsSync(stalePath())).toBe(false);
      expect(readdirSync(keyDirectory()).sort()).toEqual(['key', 'paired-devices', ...others].sort());
      const removedAt = steps.indexOf(`unlink ${stalePath()}`);
      expect(removedAt).toBeGreaterThanOrEqual(0);
      expect(steps.lastIndexOf(`sync ${keyDirectory()}`)).toBeGreaterThan(removedAt);
      expect(await verifyOn(restarted, kept.credential)).toBe(kept.deviceId);
    });

    it('a copy that cannot be removed refuses the open, and the registry file is left as it was', async () => {
      const registry = await open();
      await mint(registry.store);
      writeFileSync(stalePath(), readFileSync(registryFile()), { mode: 0o600 });
      const before = readFileSync(registryFile());
      const stuck: RegistryFileSystem = {
        ...realFs,
        unlink: async (path) => {
          if (path === stalePath()) throw Object.assign(new Error(`EACCES: permission denied, unlink '${path}'`), { code: 'EACCES' });
          await fsPromises.unlink(path);
        },
      };

      await expect(open({ fs: stuck })).rejects.toMatchObject({ code: 'EACCES' });
      expect(existsSync(stalePath())).toBe(true);
      expect(readFileSync(registryFile())).toEqual(before);
    });
  });

  describe('protection: once the binding matches, a mismatch is refused and never rewritten', () => {
    /** A registry file written in `other` with the same binding, with `with_` as its sealer. */
    async function writtenElsewhere(with_: KeySealer | null): Promise<{ file: string; minted: MintedCredential }> {
      const other = realpathSync(mkdtempSync(join(tmpdir(), 'chatterang-paired-devices-other-')));
      const registry = await open({ dataDirectory: other, sealer: with_ });
      const minted = await mint(registry.store);
      const file = join(base, 'planted');
      writeFileSync(file, readFileSync(registryFile(other)), { mode: 0o600 });
      rmSync(other, { recursive: true, force: true });
      return { file, minted };
    }

    it('a plain file where this process can seal is refused as planted, and its bytes are unchanged', async () => {
      const registry = await open();
      await mint(registry.store);
      const { file, minted } = await writtenElsewhere(null);
      writeFileSync(registryFile(), readFileSync(file));
      const before = readFileSync(registryFile());
      expect(envelopeOf().protection).toBe('plain');

      const error = await refused(open(), 'protection-downgrade');
      expect(error.message).toContain(registryFile());
      expect(readFileSync(registryFile())).toEqual(before);
      // Not re-sealed in place either, which would keep what was planted.
      await refused(open(), 'protection-downgrade');
      expect(readFileSync(registryFile())).toEqual(before);
      expect(minted.deviceId).toMatch(/^[A-Za-z0-9_-]{22}$/);
    });

    it('a sealed file where this process cannot seal is refused, and its bytes are unchanged', async () => {
      const registry = await open({ sealer: null });
      await mint(registry.store);
      const { file } = await writtenElsewhere(sealer);
      writeFileSync(registryFile(), readFileSync(file));
      const before = readFileSync(registryFile());
      expect(envelopeOf().protection).toBe('sealed');

      await refused(open({ sealer: null }), 'encryption-unavailable');
      expect(readFileSync(registryFile())).toEqual(before);
    });

    it('after a Linux keyring arrives and the key is made again, a plain file with a sealer present is cleared, not refused (#179)', async () => {
      const plainKey = await loadOrCreateTunnelKey({ dataDirectory: base, fs: realFs, sealer: null, platform: process.platform, uid });
      const before = await open({ sealer: null, bindTo: plainKey.key.pin.spki });
      const old = await mint(before.store);
      expect(envelopeOf().protection).toBe('plain');

      // #179: the plain key is refused once a keyring exists; it is deleted and a NEW key is made.
      rmSync(plainKey.path);
      const sealedKey = await loadOrCreateTunnelKey({ dataDirectory: base, fs: realFs, sealer, platform: process.platform, uid });
      expect(sealedKey.key.pin.spkiSha256).not.toBe(plainKey.key.pin.spkiSha256);

      const after = await open({ bindTo: sealedKey.key.pin.spki });
      expect(after.cleared).toBe('binding-changed');
      expect(after.list()).toEqual([]);
      expect(await verifyOn(after, old.credential)).toBeNull();
      expect(envelopeOf()).toMatchObject({ protection: 'sealed', bindTo: sealedKey.key.pin.spkiSha256 });
      expect(contentsOf(envelopeOf()).devices).toEqual([]);
      expect((await open({ bindTo: sealedKey.key.pin.spki })).cleared).toBeNull();
    });

    it('a sealed file where this process cannot seal is cleared, not refused, when the binding changed', async () => {
      const registry = await open();
      const old = await mint(registry.store);
      rmSync(join(keyDirectory(), 'key'));
      const plainKey = await loadOrCreateTunnelKey({ dataDirectory: base, fs: realFs, sealer: null, platform: process.platform, uid });

      const after = await open({ sealer: null, bindTo: plainKey.key.pin.spki });
      expect(after.cleared).toBe('binding-changed');
      expect(await verifyOn(after, old.credential)).toBeNull();
      expect(envelopeOf()).toMatchObject({ protection: 'plain', bindTo: plainKey.key.pin.spkiSha256 });
    });

    it('refuses a sealed file whose binding in the clear was rewritten: the sealed contents carry it too', async () => {
      const registry = await open();
      await mint(registry.store);
      const moved = randomBytes(32);
      const envelope = envelopeOf();
      writeFileSync(registryFile(), `${JSON.stringify({ ...envelope, bindTo: b64(moved) })}\n`);
      const before = readFileSync(registryFile());

      await refused(open({ bindTo: moved }), 'registry-malformed');
      expect(readFileSync(registryFile())).toEqual(before);
    });
  });

  describe('owner-only, or refused — never tightened', () => {
    it.runIf(onPosix).each([
      ['0640', 0o640],
      ['0604', 0o604],
      ['0660', 0o660],
    ])(
      'a registry file with mode %s is refused and left as it is',
      async (label, mode) => {
        const registry = await open();
        await mint(registry.store);
        chmodSync(registryFile(), mode);
        const before = readFileSync(registryFile());

        const error = await refused(open(), 'registry-file-unsafe');
        expect(error.message).toContain(registryFile());
        expect(error.message).toContain(label);
        expect(statSync(registryFile()).mode & 0o777).toBe(mode);
        expect(readFileSync(registryFile())).toEqual(before);
      },
    );

    it.runIf(onPosix)('a registry file another account owns is refused', async () => {
      const registry = await open();
      await mint(registry.store);
      const theirs: RegistryFileSystem = {
        ...realFs,
        open: async (path, flags, mode) => {
          const handle = await fsPromises.open(path, flags, mode);
          if (path !== registryFile()) return handle;
          return {
            stat: async () => {
              const stat = await handle.stat();
              return { mode: stat.mode, uid: uid + 1, isFile: () => stat.isFile(), isDirectory: () => stat.isDirectory() };
            },
            readFile: () => handle.readFile(),
            writeFile: (data) => handle.writeFile(data),
            sync: () => handle.sync(),
            close: () => handle.close(),
          };
        },
      };
      const error = await refused(open({ fs: theirs }), 'registry-file-unsafe');
      expect(error.message).toContain(`uid ${uid + 1}`);
    });

    it.runIf(onPosix)('a symbolic link where the file should be is refused, and what it points at is left alone', async () => {
      const registry = await open();
      await mint(registry.store);
      const target = join(base, 'elsewhere');
      writeFileSync(target, readFileSync(registryFile()), { mode: 0o600 });
      rmSync(registryFile());
      symlinkSync(target, registryFile());
      const before = readFileSync(target);

      const error = await refused(open(), 'registry-file-unsafe');
      expect(error.message).toMatch(/symbolic link/);
      expect(readFileSync(target)).toEqual(before);
      expect(lstatSync(registryFile()).isSymbolicLink()).toBe(true);
    });

    it.runIf(onPosix)('a new file created wide is refused before anything is written into it', async () => {
      const registry = await open();
      const kept = await mint(registry.store);
      const before = readFileSync(registryFile());
      const written: string[] = [];
      const wide: RegistryFileSystem = {
        ...realFs,
        open: async (path, flags, mode) => {
          const handle = await fsPromises.open(path, flags, mode);
          return {
            stat: async () => {
              const stat = await handle.stat();
              const mode_ = path.endsWith('.tmp') ? stat.mode | 0o044 : stat.mode;
              return { mode: mode_, uid: stat.uid, isFile: () => stat.isFile(), isDirectory: () => stat.isDirectory() };
            },
            readFile: () => handle.readFile(),
            writeFile: async (data) => {
              written.push(path);
              await handle.writeFile(data);
            },
            sync: () => handle.sync(),
            close: () => handle.close(),
          };
        },
      };
      const widened = await open({ fs: wide });
      await refused(mint(widened.store), 'registry-file-unsafe');
      expect(written).toEqual([]);
      expect(readFileSync(registryFile())).toEqual(before);
      expect(temporaries()).toEqual([]);
      expect(await verifyOn(await open(), kept.credential)).toBe(kept.deviceId);
    });

    it.runIf(onPosix)('the directories are the key store’s own check: a widened key directory is refused before the file is read', async () => {
      const registry = await open();
      await mint(registry.store);
      chmodSync(keyDirectory(), 0o750);

      const error = await open().then(
        () => null,
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(TunnelIdentityError);
      expect((error as TunnelIdentityError).reason).toBe('key-directory-unsafe');
      expect(statSync(keyDirectory()).mode & 0o777).toBe(0o750);
    });

    it.runIf(onDarwin)('an access control entry that lets another account read the file is refused, and not stripped', async () => {
      const registry = await open();
      await mint(registry.store);
      execFileSync('/bin/chmod', ['+a', 'everyone allow read', registryFile()]);
      const before = readFileSync(registryFile());

      const error = await refused(open(), 'registry-file-unsafe');
      expect(error.message).toContain('read');
      expect(execFileSync('/bin/ls', ['-le', registryFile()], { encoding: 'utf8' })).toMatch(/everyone allow read/);
      expect(readFileSync(registryFile())).toEqual(before);
    });

    describe('a macOS access control list, read the way the key store reads one', () => {
      /** `ls -lde` as it prints a path with no ACL — or, for the registry file, what `forFile` says. */
      const listing =
        (forFile: string | undefined): AccessControlListing =>
        async (path) => {
          if (path === registryFile() && forFile !== undefined) return forFile;
          const directory = path.endsWith('/.');
          return `${directory ? 'drwx------' : '-rw-------'}  1 me  staff  96 Sep 18 09:00 ${path}\n`;
        };
      const onMac = (forFile?: string) => open({ platform: 'darwin', listAccessControl: listing(forFile) });

      it('refuses an allow entry on the file, and a listing it cannot read, on any machine', async () => {
        const registry = await onMac();
        await mint(registry.store);
        const before = readFileSync(registryFile());

        await refused(
          onMac(`-rw-------+ 1 me  staff  300 Sep 18 09:00 ${registryFile()}\n 0: group:everyone allow read\n`),
          'registry-file-unsafe',
        );
        await refused(onMac(`-rw-------+ 1 me  staff  300 Sep 18 09:00 ${registryFile()}\n`), 'registry-file-unsafe');
        await refused(onMac('total 8\n'), 'registry-file-unsafe');
        expect(readFileSync(registryFile())).toEqual(before);

        // A deny entry grants nothing, and is not a reason to refuse.
        const denied = await onMac(
          `-rw-------+ 1 me  staff  300 Sep 18 09:00 ${registryFile()}\n 0: group:everyone deny read\n`,
        );
        expect(denied.list()).toHaveLength(1);
      });
    });

    /*
     * WINDOWS (#179's second ruling: a user-only file there), driven from a
     * machine that is not Windows, as `tests/tunnel-identity-store.test.ts`
     * drives the key store: the real temporary directory, `platform: 'win32'`,
     * and a runner answering `whoami` and Get-Acl with fixtures in the shapes
     * those tools print. NONE OF THIS RAN ON WINDOWS.
     */
    describe('on Windows, the file’s own security descriptor is read', () => {
      const SYSTEM_ROOT = 'C:\\Windows';
      const WHOAMI = 'C:\\Windows\\System32\\whoami.exe';
      const POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
      const PATH_VARIABLE = 'CHATTERANG_TUNNEL_ACL_PATH';
      const USER = 'S-1-5-21-1004336348-1177238915-682003330-1001';
      const OTHER = 'S-1-5-21-1004336348-1177238915-682003330-1002';
      const GROUP = 'S-1-5-21-1004336348-1177238915-682003330-513';
      const profileDirectory = (): string =>
        `O:${USER}G:${GROUP}D:AI(A;OICIID;FA;;;SY)(A;OICIID;FA;;;BA)(A;OICIID;FA;;;${USER})`;
      const profileFile = (extra = '', owner = USER): string =>
        `O:${owner}G:${GROUP}D:AI${extra}(A;ID;FA;;;SY)(A;ID;FA;;;BA)(A;ID;FA;;;${USER})`;

      function windowsTools(answer: (path: string) => string | undefined = () => undefined, runs: string[] = []): WindowsToolRunner {
        return async (file, _args, env) => {
          if (file === WHOAMI) {
            runs.push('whoami');
            return `"desktop-7f3k2q\\john","${USER}"\r\n`;
          }
          if (file === POWERSHELL) {
            const path = env[PATH_VARIABLE]!;
            runs.push(`get-acl ${path}`);
            return `${answer(path) ?? (lstatSync(path).isDirectory() ? profileDirectory() : profileFile())}\r\n`;
          }
          throw Object.assign(new Error(`not a tool this Windows has: ${file}`), { code: 'ENOENT' });
        };
      }

      const onWindows = (tools: WindowsToolRunner = windowsTools()) =>
        open({ platform: 'win32', uid: -1, systemRoot: SYSTEM_ROOT, runWindowsTool: tools });

      it('reads the file’s descriptor on every open, and opens a clean one', async () => {
        const registry = await onWindows();
        const minted = await mint(registry.store);
        const runs: string[] = [];
        const restarted = await onWindows(windowsTools(undefined, runs));
        expect(runs).toContain(`get-acl ${registryFile()}`);
        expect(await verifyOn(restarted, minted.credential)).toBe(minted.deviceId);
        expect(envelopeOf().protection).toBe('sealed');
      });

      it.each([
        ['allows another account to read it', profileFile(`(A;;FR;;;${OTHER})`)],
        ['allows Everyone to write it', profileFile('(A;;FW;;;WD)')],
        ['is owned by another account', profileFile('', OTHER)],
        ['has no access control list at all', `O:${USER}G:${GROUP}D:NO_ACCESS_CONTROL`],
        ['has an entry of a type this reader was not written for', profileFile(`(XA;;FA;;;${USER})`)],
        ['is not a descriptor', 'Access denied'],
      ])('refuses a file whose descriptor %s, and leaves it as it is', async (_label, sddl) => {
        const registry = await onWindows();
        await mint(registry.store);
        const before = readFileSync(registryFile());
        const error = await refused(
          onWindows(windowsTools((path) => (path === registryFile() ? sddl : undefined))),
          'registry-file-unsafe',
        );
        expect(error.message).toContain(registryFile());
        expect(readFileSync(registryFile())).toEqual(before);
      });

      it('reads a new file’s descriptor before anything is written into it', async () => {
        const registry = await onWindows();
        const kept = await mint(registry.store);
        const before = readFileSync(registryFile());
        const wide = await onWindows(
          windowsTools((path) => (/paired-devices\.[0-9a-f]{16}\.tmp$/.test(path) ? profileFile(`(A;;FR;;;${OTHER})`) : undefined)),
        );
        await refused(mint(wide.store), 'registry-file-unsafe');
        expect(readFileSync(registryFile())).toEqual(before);
        expect(temporaries()).toEqual([]);
        expect(await verifyOn(await onWindows(), kept.credential)).toBe(kept.deviceId);
      });
    });
  });

  describe('only a file this build writes is read', () => {
    it('an unknown version is refused, and its bytes are unchanged', async () => {
      const registry = await open();
      await mint(registry.store);
      for (const version of [2, 0, '1']) {
        writeFileSync(registryFile(), `${JSON.stringify({ ...envelopeOf(), version })}\n`);
        const before = readFileSync(registryFile());
        await refused(open(), 'unknown-version');
        expect(readFileSync(registryFile())).toEqual(before);
      }
    });

    it('a file with a field this build does not write, another format, or no JSON at all is refused', async () => {
      const registry = await open({ sealer: null });
      await mint(registry.store);
      const envelope = envelopeOf();
      const contents = contentsOf(envelope, null);
      for (const planted of [
        `${JSON.stringify({ ...envelope, lastSeenAt: NOW })}\n`,
        `${JSON.stringify({ ...envelope, format: 'chatterang-tunnel-key' })}\n`,
        `${JSON.stringify({ ...envelope, contents: { ...contents, listening: true } })}\n`,
        `${JSON.stringify({ ...envelope, contents: { ...contents, devices: contents.devices.map((device) => ({ ...device, lastSeenAt: NOW })) } })}\n`,
        `${JSON.stringify({ ...envelope, contents: { ...contents, devices: contents.devices.map((device) => ({ ...device, digest: b64(randomBytes(31)) })) } })}\n`,
        `${JSON.stringify({ ...envelope, contents: { ...contents, devices: [...contents.devices, ...contents.devices] } })}\n`,
        'not json at all\n',
      ]) {
        writeFileSync(registryFile(), planted);
        await refused(open({ sealer: null }), 'registry-malformed');
        expect(readFileSync(registryFile(), 'utf8')).toBe(planted);
      }
    });
  });

  describe('what the file holds', () => {
    it.each([
      ['sealed', true],
      ['plain', false],
    ])('a %s file holds 32-byte digests and zero-byte tombstones, never a credential or its secret', async (_label, sealed) => {
      const with_ = sealed ? sealer : null;
      const registry = await open({ sealer: with_ });
      const credentials = createDeviceCredentials(deleteFails(registry.store));
      const kept = await credentials.mint(claimedWindow(), 0);
      const gone = await credentials.mint(claimedWindow(), 0);
      await registry.setName(kept.deviceId, 'Kept phone');
      await expect(credentials.revoke(gone.deviceId)).rejects.toThrow(/delete failed/);

      const raw = readFileSync(registryFile(), 'utf8');
      const envelope = envelopeOf();
      expect(envelope.protection).toBe(sealed ? 'sealed' : 'plain');
      const contents = contentsOf(envelope, with_);
      const searched = `${raw}\n${JSON.stringify(contents)}`;
      for (const { credential } of [kept, gone]) {
        const [, secret] = credential.split('.') as [string, string];
        const secretBytes = Buffer.from(secret, 'base64url');
        expect(searched).not.toContain(credential);
        for (const encoding of ['base64url', 'base64', 'hex'] as const) {
          expect(searched).not.toContain(secretBytes.toString(encoding));
        }
      }
      if (sealed) {
        // Sealed means sealed: no digest and no name in the clear.
        expect(raw).not.toContain(sha256(kept.credential));
        expect(raw).not.toContain('Kept phone');
      }

      expect(Buffer.from(envelope.bindTo as string, 'base64')).toEqual(Buffer.from(bindTo));
      expect(contents.bindTo).toBe(envelope.bindTo);
      const byId = new Map(contents.devices.map((device) => [device.deviceId, device]));
      expect(byId.get(kept.deviceId)).toEqual({ deviceId: kept.deviceId, digest: sha256(kept.credential), name: 'Kept phone', pairedAt: NOW });
      expect(byId.get(gone.deviceId)).toEqual({ deviceId: gone.deviceId, digest: '', name: '', pairedAt: NOW });
      for (const device of contents.devices) {
        expect(Object.keys(device).sort()).toEqual(['deviceId', 'digest', 'name', 'pairedAt']);
        expect([0, 32]).toContain(Buffer.from(device.digest, 'base64').length);
      }
    });

    it('list() carries no digest: a device id, its name, when it paired, and whether it is revoked', async () => {
      const registry = await open();
      const credentials = createDeviceCredentials(deleteFails(registry.store));
      const kept = await credentials.mint(claimedWindow(), 0);
      const gone = await credentials.mint(claimedWindow(), 0);
      await expect(credentials.revoke(gone.deviceId)).rejects.toThrow(/delete failed/);

      const listed = registry.list();
      expect(listed).toHaveLength(2);
      for (const device of listed) {
        expect(Object.keys(device).sort()).toEqual(['deviceId', 'name', 'pairedAt', 'revoked']);
        for (const value of Object.values(device)) expect(value).not.toBeInstanceOf(Uint8Array);
      }
      expect(JSON.stringify(listed)).not.toContain(sha256(kept.credential));
      expect(listed.find((device) => device.deviceId === gone.deviceId)?.revoked).toBe(true);
      expect(listed.find((device) => device.deviceId === kept.deviceId)?.revoked).toBe(false);
    });
  });

  describe('the binding (#135, #179, #180)', () => {
    it('a different bindTo clears every device, says binding-changed, and no old credential verifies', async () => {
      const registry = await open();
      const a = await mint(registry.store);
      const b = await mint(registry.store);

      const moved = randomBytes(32);
      const rebound = await open({ bindTo: moved });
      expect(rebound.cleared).toBe('binding-changed');
      expect(rebound.list()).toEqual([]);
      expect(await verifyOn(rebound, a.credential)).toBeNull();
      expect(await verifyOn(rebound, b.credential)).toBeNull();
      expect(envelopeOf().bindTo).toBe(b64(moved));
      expect(contentsOf(envelopeOf()).devices).toEqual([]);

      expect((await open({ bindTo: moved })).cleared).toBeNull();
      // Going back carries nothing back.
      const back = await open();
      expect(back.cleared).toBe('binding-changed');
      expect(await verifyOn(back, a.credential)).toBeNull();
    });

    it('a bindTo that is not 32 bytes is refused before anything on disk is touched', async () => {
      await refused(open({ bindTo: randomBytes(31) }), 'binding-invalid');
      await refused(open({ bindTo: new Uint8Array(0) }), 'binding-invalid');
      expect(readdirSync(base)).toEqual([]);
    });
  });

  describe('the phone’s name (#129)', () => {
    it('a new device has no name until one is set, and a name and a rename are kept across a restart', async () => {
      const registry = await open();
      const { deviceId } = await mint(registry.store);
      expect(registry.list()[0]?.name).toBe('');

      await registry.setName(deviceId, 'John’s iPhone');
      expect((await open()).list()[0]?.name).toBe('John’s iPhone');
      const again = await open();
      await again.setName(deviceId, 'Work phone 📱');
      expect((await open()).list()[0]).toEqual({ deviceId, name: 'Work phone 📱', pairedAt: NOW, revoked: false });
      // 64 bytes of UTF-8 is the pairing code's bound on a name, and fits.
      await again.setName(deviceId, 'é'.repeat(32));
      expect((await open()).list()[0]?.name).toBe('é'.repeat(32));
    });

    it('refuses a name with a hidden or direction-changing character, a blank one, or one past 64 bytes, and writes nothing', async () => {
      const registry = await open();
      const { deviceId } = await mint(registry.store);
      await registry.setName(deviceId, 'Phone');
      const before = readFileSync(registryFile());

      const disguising = ['\u202ekoobcam', 'a\u2066b\u2069', 'tab\there', 'nul\u0000', 'del\u007f', 'next\u0085line', '\u202a'];
      for (const name of disguising) {
        // The same characters the phone's wording refuses to show (src/features/pairing/wording.ts).
        expect(hasDisguisingCharacter(name), JSON.stringify(name)).toBe(true);
        await refused(registry.setName(deviceId, name), 'name-refused');
      }
      for (const name of ['', '   ', 'é'.repeat(33), 'x'.repeat(65), 'broken \ud800 half']) {
        await refused(registry.setName(deviceId, name), 'name-refused');
      }
      expect(readFileSync(registryFile())).toEqual(before);
      expect(registry.list()[0]?.name).toBe('Phone');
    });

    it('refuses a name for a device that is not paired, or is revoked', async () => {
      const registry = await open();
      const credentials = createDeviceCredentials(deleteFails(registry.store));
      const gone = await credentials.mint(claimedWindow(), 0);
      await expect(credentials.revoke(gone.deviceId)).rejects.toThrow(/delete failed/);

      await refused(registry.setName(gone.deviceId, 'Revoked'), 'unknown-device');
      await refused(registry.setName('AAAAAAAAAAAAAAAAAAAAAA', 'Stranger'), 'unknown-device');
    });
  });

  /*
   * #170: the desktop's not-sent records for a phone's turns are kept per phone
   * BESIDE these records and deleted when that phone is removed or pairing is
   * reset. They are not kept here; these are the operations a records store
   * hooks into.
   */
  describe('removal and reset are explicit, and a records store can hook into both', () => {
    it('a revoke tells every removal watcher, once the file no longer holds the device', async () => {
      const registry = await open();
      const credentials = createDeviceCredentials(registry.store);
      const gone = await credentials.mint(claimedWindow(), 0);
      const kept = await credentials.mint(claimedWindow(), 0);
      const told: DeviceRemoval[] = [];
      const onDisk: string[][] = [];
      const stop = registry.watchRemovals(async (removal) => {
        told.push(removal);
        onDisk.push(contentsOf(envelopeOf()).devices.map((device) => device.deviceId));
      });

      expect(await credentials.revoke(gone.deviceId)).toBe(true);
      expect(told).toEqual([{ kind: 'device', deviceId: gone.deviceId }]);
      expect(onDisk).toEqual([[kept.deviceId]]);
      // #131: a revocation that finished leaves no row, tombstone or name behind.
      expect(readFileSync(registryFile(), 'utf8')).not.toContain(gone.deviceId);
      expect(JSON.stringify(contentsOf(envelopeOf()))).not.toContain(gone.deviceId);
      expect(registry.list().map((device) => device.deviceId)).toEqual([kept.deviceId]);

      stop();
      await credentials.revoke(kept.deviceId);
      expect(told).toHaveLength(1);
    });

    it('a removal whose write fails tells no watcher', async () => {
      const faults = faulty();
      const registry = await open({ fs: faults.fs });
      const credentials = createDeviceCredentials(registry.store);
      const gone = await credentials.mint(claimedWindow(), 0);
      const told: DeviceRemoval[] = [];
      registry.watchRemovals(async (removal) => {
        told.push(removal);
      });

      faults.failRename(2);
      await expect(credentials.revoke(gone.deviceId)).rejects.toThrow(/rename failed/);
      expect(told).toEqual([]);
    });

    it('a watcher that fails makes the revoke reject, and the device is still removed', async () => {
      const registry = await open();
      const credentials = createDeviceCredentials(registry.store);
      const gone = await credentials.mint(claimedWindow(), 0);
      const told: DeviceRemoval[] = [];
      registry.watchRemovals(async () => {
        throw new Error('the not-sent records could not be deleted');
      });
      registry.watchRemovals(async (removal) => {
        told.push(removal);
      });

      await expect(credentials.revoke(gone.deviceId)).rejects.toThrow(/removal watcher/);
      expect(told).toEqual([{ kind: 'device', deviceId: gone.deviceId }]);
      const restarted = await open();
      expect(restarted.list()).toEqual([]);
      expect(await verifyOn(restarted, gone.credential)).toBeNull();
    });

    it('reset forgets every device, tells each watcher once, and nothing verifies after a restart', async () => {
      const registry = await open();
      const a = await mint(registry.store);
      const b = await mint(registry.store);
      const told: DeviceRemoval[] = [];
      registry.watchRemovals(async (removal) => {
        told.push(removal);
      });

      await registry.reset();
      expect(told).toEqual([{ kind: 'reset' }]);
      expect(registry.list()).toEqual([]);
      expect(await verifyOn(registry, a.credential)).toBeNull();

      const restarted = await open();
      expect(restarted.cleared).toBeNull();
      expect(restarted.list()).toEqual([]);
      expect(await verifyOn(restarted, a.credential)).toBeNull();
      expect(await verifyOn(restarted, b.credential)).toBeNull();
    });

    it('a reset whose write fails keeps every device and tells no watcher', async () => {
      const faults = faulty();
      const registry = await open({ fs: faults.fs });
      const a = await mint(registry.store);
      const told: DeviceRemoval[] = [];
      registry.watchRemovals(async (removal) => {
        told.push(removal);
      });

      faults.failRename(1);
      await expect(registry.reset()).rejects.toThrow(/rename failed/);
      expect(told).toEqual([]);
      expect(registry.list()).toHaveLength(1);
      expect(await verifyOn(await open(), a.credential)).toBe(a.deviceId);
    });
  });

  describe('invariants', () => {
    const root = process.cwd();

    function sourceFiles(directory: string): string[] {
      return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : sourceFiles(path);
        return /\.(?:[cm]?[jt]s|[jt]sx)$/.test(entry.name) ? [path] : [];
      });
    }

    it('nothing in either app, or in src/, calls the registry: it lands tested but unreachable (#133)', () => {
      const scanned = ['src', 'apps/desktop/src', 'apps/server/src'].flatMap((directory) => sourceFiles(resolve(root, directory)));
      expect(scanned.length).toBeGreaterThan(100);
      const callers = scanned.filter((file) => /openDeviceRegistry|device-registry/.test(readFileSync(file, 'utf8')));
      expect(callers).toEqual([]);
    });

    it('the module names no socket and no listener: it cannot turn the tunnel on (#158)', () => {
      const code = readFileSync(resolve(root, 'packages/tunnel/src/host/device-registry.ts'), 'utf8');
      const specifiers = [...code.matchAll(/\bfrom\s+'([^']+)'/g)].map((match) => match[1]).sort();
      expect([...new Set(specifiers)]).toEqual([
        '../pairing/index.js',
        './credential.js',
        './identity-store.js',
        'node:buffer',
        'node:child_process',
        'node:crypto',
        'node:fs',
        'node:path',
      ]);
      expect(code).not.toMatch(/\.\s*listen\s*\(|WebSocketServer|createTunnel(?:Host|Listener)/);
    });
  });
});
