// @vitest-environment node
import { execFileSync } from 'node:child_process';
import {
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  generateKeyPairSync,
  randomBytes,
} from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  loadOrCreateDesktopTunnelKey,
  type AppReadyLike,
  type DesktopTunnelKeyOptions,
  type SafeStorageLike,
} from '@chatterang/desktop/tunnel-identity';
import { loadOrCreateServerTunnelKey } from '@chatterang/server/tunnel-identity';
import {
  TunnelIdentityError,
  generateTunnelKey,
  loadOrCreateTunnelKey,
  tunnelKeyPkcs8Pem,
  type AccessControlListing,
  type KeyFileStat,
  type KeyFileSystem,
  type TunnelIdentityErrorReason,
} from '@chatterang/tunnel/host';

/**
 * #179: where the tunnel key lives, on the real filesystem.
 *
 * Owner-only or refused, never tightened, never replaced — driven through the
 * two adapters the apps will call, over the one store they share. Real modes
 * and real macOS access control lists on a real temporary directory wherever
 * the operating system can produce the case; a wrapper around
 * `node:fs/promises`, or a listing, that lies about exactly one answer where it
 * cannot (another account's uid, a file created wide, an ACL listing of a shape
 * this machine never prints).
 */

// Compile-time: Electron 44's own `safeStorage` and `app` satisfy the types the adapter asks for.
type Electron = typeof import('electron');
const electronConforms = (storage: Electron['safeStorage'], app: Electron['app']): [SafeStorageLike, AppReadyLike] => [
  storage,
  app,
];
void electronConforms;

const uid = process.getuid?.() ?? -1;
const realFs: KeyFileSystem = fsPromises;
const onDarwin = process.platform === 'darwin';

interface FakeSafeStorage extends SafeStorageLike {
  available: boolean;
  backend: string;
  readonly calls: { available: number; backend: number; encrypt: number; decrypt: number };
}

/**
 * A `safeStorage` that really encrypts — AES-256-GCM under a key only this
 * object holds, with Chromium's `v10` prefix — so a flipped byte fails to
 * decrypt the way a keychain-backed one does, and the file never holds the PEM.
 */
function fakeSafeStorage(): FakeSafeStorage {
  const secret = randomBytes(32);
  const storage: FakeSafeStorage = {
    available: true,
    backend: 'gnome_libsecret',
    calls: { available: 0, backend: 0, encrypt: 0, decrypt: 0 },
    isEncryptionAvailable: () => {
      storage.calls.available += 1;
      return storage.available;
    },
    getSelectedStorageBackend: () => {
      storage.calls.backend += 1;
      return storage.backend;
    },
    encryptString(plainText) {
      if (!storage.available) throw new Error('Encryption is not available.');
      storage.calls.encrypt += 1;
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', secret, iv);
      const body = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
      return Buffer.concat([Buffer.from('v10'), iv, cipher.getAuthTag(), body]);
    },
    decryptString(encrypted) {
      if (!storage.available) throw new Error('Decryption is not available.');
      storage.calls.decrypt += 1;
      if (encrypted.subarray(0, 3).toString('latin1') !== 'v10') {
        throw new Error('Ciphertext does not appear to be encrypted.');
      }
      const decipher = createDecipheriv('aes-256-gcm', secret, encrypted.subarray(3, 15));
      decipher.setAuthTag(encrypted.subarray(15, 31));
      return Buffer.concat([decipher.update(encrypted.subarray(31)), decipher.final()]).toString('utf8');
    },
  };
  return storage;
}

const ready: AppReadyLike = { isReady: () => true };

/** The desktop adapter, called after `ready` unless the test says otherwise. */
const desktop = (options: Omit<DesktopTunnelKeyOptions, 'app'> & { readonly app?: AppReadyLike }) =>
  loadOrCreateDesktopTunnelKey({ app: ready, ...options });

let base: string;

beforeEach(() => {
  // mkdtemp makes it 0700 and ours: an ordinary data directory.
  base = realpathSync(mkdtempSync(join(tmpdir(), 'chatterang-tunnel-key-')));
});

afterEach(() => {
  vi.restoreAllMocks();
  // Strip any ACL a test added, so nothing it granted outlives it.
  if (onDarwin) execFileSync('/bin/chmod', ['-RN', base]);
  chmodSync(base, 0o700);
  rmSync(base, { recursive: true, force: true });
});

const keyPath = (dataDirectory: string): string => join(dataDirectory, 'tunnel-identity', 'key');
const modeOf = (path: string): number => lstatSync(path).mode & 0o777;

async function refused(promise: Promise<unknown>, reason: TunnelIdentityErrorReason): Promise<TunnelIdentityError> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(TunnelIdentityError);
  expect((error as TunnelIdentityError).reason).toBe(reason);
  return error as TunnelIdentityError;
}

/** No 24-character window of any secret appears in `text`. PEM armour lines are not secret. */
function expectNoKeyMaterial(text: string, secrets: readonly string[]): void {
  for (const secret of secrets) {
    const body = secret
      .split('\n')
      .filter((line) => !line.startsWith('-----'))
      .join('');
    for (let at = 0; at + 24 <= body.length; at += 12) {
      expect(text).not.toContain(body.slice(at, at + 24));
    }
  }
}

/** Rewrite the envelope in place, keeping the file 0600. */
function rewrite(path: string, edit: (envelope: Record<string, unknown>) => unknown): void {
  const envelope = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  const next = edit(envelope);
  writeFileSync(path, typeof next === 'string' || Buffer.isBuffer(next) ? next : JSON.stringify(next));
  chmodSync(path, 0o600);
}

/** A stat answer that is true in every respect but the one being lied about. */
function statWith(stat: KeyFileStat, change: { uid?: number; mode?: number }): KeyFileStat {
  return {
    mode: change.mode ?? stat.mode,
    uid: change.uid ?? stat.uid,
    isFile: () => stat.isFile(),
    isDirectory: () => stat.isDirectory(),
  };
}

describe('the desktop keeps its tunnel key sealed with safeStorage (#179)', () => {
  it('creates the key sealed, in a 0700 directory and a 0600 file, and reloads the same pin', async () => {
    const storage = fakeSafeStorage();
    const created = await desktop({ userData: base, safeStorage: storage });
    expect(created).toMatchObject({ created: true, protection: 'sealed', path: keyPath(base) });
    expect(modeOf(created.path)).toBe(0o600);
    expect(modeOf(dirname(created.path))).toBe(0o700);
    // No private temporary name left behind.
    expect(readdirSync(dirname(created.path))).toEqual(['key']);
    // Beside the renderer's mapped `files` tree, never inside it.
    expect(created.path.startsWith(join(base, 'files') + sep)).toBe(false);

    const raw = readFileSync(created.path, 'utf8');
    expect(JSON.parse(raw)).toMatchObject({
      format: 'chatterang-tunnel-key',
      version: 1,
      protection: 'sealed',
      spkiSha256: created.key.pin.spkiSha256,
    });
    expect(raw).not.toContain('PRIVATE KEY');
    expectNoKeyMaterial(raw, [tunnelKeyPkcs8Pem(created.key)]);
    expect(storage.calls.encrypt).toBe(1);

    const decryptsBefore = storage.calls.decrypt;
    const loaded = await desktop({ userData: base, safeStorage: storage });
    expect(loaded).toMatchObject({ created: false, protection: 'sealed', path: created.path });
    expect(loaded.key.pin.spkiSha256).toBe(created.key.pin.spkiSha256);
    expect(storage.calls.decrypt).toBe(decryptsBefore + 1);
    expect(storage.calls.encrypt).toBe(1);
  });

  it('writes a plain 0600 file when safeStorage cannot encrypt, and never calls it', async () => {
    const storage = fakeSafeStorage();
    storage.available = false;
    const created = await desktop({ userData: base, safeStorage: storage });
    expect(created).toMatchObject({ created: true, protection: 'plain' });
    expect(modeOf(created.path)).toBe(0o600);
    expect(modeOf(dirname(created.path))).toBe(0o700);
    const envelope = JSON.parse(readFileSync(created.path, 'utf8')) as Record<string, unknown>;
    expect(envelope['protection']).toBe('plain');
    expect(envelope['key']).toBe(tunnelKeyPkcs8Pem(created.key));

    const loaded = await desktop({ userData: base, safeStorage: storage });
    expect(loaded.created).toBe(false);
    expect(loaded.key.pin.spkiSha256).toBe(created.key.pin.spkiSha256);
    expect(storage.calls).toMatchObject({ encrypt: 0, decrypt: 0 });
  });

  it('refuses a sealed key once encryption is unavailable, and does not replace it', async () => {
    const storage = fakeSafeStorage();
    const { path } = await desktop({ userData: base, safeStorage: storage });
    const before = readFileSync(path);
    storage.available = false;
    const error = await refused(desktop({ userData: base, safeStorage: storage }), 'encryption-unavailable');
    expect(error.message).toContain(path);
    expect(readFileSync(path).equals(before)).toBe(true);
    expect(readdirSync(dirname(path))).toEqual(['key']);
  });

  it('refuses a plain key once encryption is available — neither loads it nor re-seals it', async () => {
    // The Linux session that wrote its key before the keyring unlocked. Loud,
    // because the alternative is loading a key anyone of this account could
    // have written, while the keychain was there to keep it.
    const storage = fakeSafeStorage();
    storage.available = false;
    const created = await desktop({ userData: base, safeStorage: storage });
    const before = readFileSync(created.path);
    storage.available = true;
    const error = await refused(desktop({ userData: base, safeStorage: storage }), 'protection-downgrade');
    expect(error.message).toContain(created.path);
    expect(readFileSync(created.path).equals(before)).toBe(true);
    expect(readdirSync(dirname(created.path))).toEqual(['key']);
    expect(storage.calls).toMatchObject({ encrypt: 0, decrypt: 0 });
  });

  it('refuses a plain key planted over a sealed one, so a key someone else chose is never served', async () => {
    const storage = fakeSafeStorage();
    const created = await desktop({ userData: base, safeStorage: storage });
    const planted = generateTunnelKey();
    rewrite(created.path, (e) => ({
      ...e,
      protection: 'plain',
      spkiSha256: planted.pin.spkiSha256,
      key: tunnelKeyPkcs8Pem(planted),
    }));
    const tampered = readFileSync(created.path);
    const error = await refused(desktop({ userData: base, safeStorage: storage }), 'protection-downgrade');
    expectNoKeyMaterial(error.message, [tunnelKeyPkcs8Pem(planted), tunnelKeyPkcs8Pem(created.key)]);
    expect(readFileSync(created.path).equals(tampered)).toBe(true);
  });
});

describe('the desktop asks only after ready, and seals only into a real secret store', () => {
  it('refuses before Electron is ready, asking safeStorage nothing and writing nothing', async () => {
    const storage = fakeSafeStorage();
    const error = await refused(
      loadOrCreateDesktopTunnelKey({ userData: base, safeStorage: storage, app: { isReady: () => false } }),
      'not-ready',
    );
    expect(error.message).toContain('ready');
    expect(storage.calls).toEqual({ available: 0, backend: 0, encrypt: 0, decrypt: 0 });
    expect(readdirSync(base)).toEqual([]);
  });

  it.each(['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6'])(
    'on Linux, seals into the %s secret store',
    async (backend) => {
      const storage = fakeSafeStorage();
      storage.backend = backend;
      const created = await desktop({ userData: base, safeStorage: storage, platform: 'linux' });
      expect(created.protection).toBe('sealed');
      expect(storage.calls.backend).toBeGreaterThan(0);
    },
  );

  it.each(['basic_text', 'unknown', 'a_store_from_a_later_electron'])(
    'on Linux, a %s backend is not a secret store: the key is written plain, and says so',
    async (backend) => {
      const storage = fakeSafeStorage();
      storage.backend = backend;
      const created = await desktop({ userData: base, safeStorage: storage, platform: 'linux' });
      expect(created.protection).toBe('plain');
      expect((JSON.parse(readFileSync(created.path, 'utf8')) as Record<string, unknown>)['protection']).toBe('plain');
      expect(storage.calls.encrypt).toBe(0);
    },
  );

  it.runIf(onDarwin)('off Linux the backend is never asked: the macOS keychain seals', async () => {
    const storage = fakeSafeStorage();
    storage.backend = 'basic_text';
    const created = await desktop({ userData: base, safeStorage: storage, platform: 'darwin' });
    expect(created.protection).toBe('sealed');
    expect(storage.calls.backend).toBe(0);
  });
});

describe('a tampered key file is refused, and what it held is never echoed', () => {
  const ed25519Pem = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const planted = generateTunnelKey();

  /** [label, sealed when created, expected refusal, the edit, can this process seal when it loads (default: as created)] */
  const cases: readonly (readonly [
    label: string,
    sealed: boolean,
    reason: TunnelIdentityErrorReason,
    edit: (envelope: Record<string, unknown>) => unknown,
    sealableOnLoad?: boolean,
  ])[] = [
    ['a flipped ciphertext byte', true, 'unseal-failed', (e) => {
      const bytes = Buffer.from(String(e['key']), 'base64');
      bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 0x01;
      return { ...e, key: bytes.toString('base64') };
    }],
    ['ciphertext that was never sealed', true, 'unseal-failed', (e) => ({ ...e, key: Buffer.from('never sealed').toString('base64') })],
    ['a sealed key that is not base64', true, 'key-file-malformed', (e) => ({ ...e, key: '!!not base64!!' })],
    ['a sealed file relabelled plain', true, 'protection-downgrade', (e) => ({ ...e, protection: 'plain' })],
    ['another key planted plain over a sealed one', true, 'protection-downgrade', (e) => ({
      ...e,
      protection: 'plain',
      spkiSha256: planted.pin.spkiSha256,
      key: tunnelKeyPkcs8Pem(planted),
    })],
    // Loaded by a process that CAN seal, so the refusal is the envelope's, not
    // the missing sealer's (that one is its own test above).
    ['a plain file relabelled sealed', false, 'key-file-malformed', (e) => ({ ...e, protection: 'sealed' }), true],
    ['another key under the recorded pin', false, 'pin-mismatch', (e) => ({ ...e, key: tunnelKeyPkcs8Pem(generateTunnelKey()) })],
    ['another pin over the key', false, 'pin-mismatch', (e) => ({ ...e, spkiSha256: generateTunnelKey().pin.spkiSha256 })],
    ['an Ed25519 key', false, 'key-unsupported', (e) => ({ ...e, key: ed25519Pem })],
    ['a truncated key', false, 'key-unsupported', (e) => ({ ...e, key: String(e['key']).slice(0, 90) })],
    // The same key, so its pin still matches: refused for its encoding alone.
    ['the key as SEC1 rather than PKCS#8', false, 'key-unsupported', (e) => ({
      ...e,
      key: createPrivateKey(String(e['key'])).export({ type: 'sec1', format: 'pem' }).toString(),
    })],
    ['the key followed by a second PEM block', false, 'key-unsupported', (e) => ({
      ...e,
      key: `${String(e['key'])}${tunnelKeyPkcs8Pem(generateTunnelKey())}`,
    })],
    ['not JSON', false, 'key-file-malformed', () => 'this is not json'],
    ['an empty file', false, 'key-file-malformed', () => ''],
    ['invalid UTF-8', false, 'key-file-malformed', () => Buffer.from([0x7b, 0xff, 0xfe, 0x7d])],
    ['an array', false, 'key-file-malformed', () => '[]'],
    ['an extra field', false, 'key-file-malformed', (e) => ({ ...e, note: 'hello' })],
    ['a missing field', false, 'key-file-malformed', (e) => {
      const copy = { ...e };
      delete copy['spkiSha256'];
      return copy;
    }],
    ['another format', false, 'key-file-malformed', (e) => ({ ...e, format: 'something-else' })],
    ['version 2', false, 'key-file-malformed', (e) => ({ ...e, version: 2 })],
    ['version "1"', false, 'key-file-malformed', (e) => ({ ...e, version: '1' })],
    ['an unknown protection', false, 'key-file-malformed', (e) => ({ ...e, protection: 'rot13' })],
    ['a pin that is not a base64 SHA-256', false, 'key-file-malformed', (e) => ({ ...e, spkiSha256: 'abc' })],
    ['an empty key', false, 'key-file-malformed', (e) => ({ ...e, key: '' })],
  ];

  // Each row is passed whole and destructured here: an optional tuple element
  // defeats `it.each`'s per-position parameter types.
  it.each(cases.map((row): [string, (typeof cases)[number]] => [row[0], row]))('%s', async (_label, row) => {
    const [, sealed, reason, edit, sealableOnLoad] = row;
    const storage = fakeSafeStorage();
    storage.available = sealed;
    const created = await desktop({ userData: base, safeStorage: storage });
    const storedKey = String((JSON.parse(readFileSync(created.path, 'utf8')) as Record<string, unknown>)['key']);
    rewrite(created.path, edit);
    const tampered = readFileSync(created.path);
    storage.available = sealableOnLoad ?? sealed;

    const error = await refused(desktop({ userData: base, safeStorage: storage }), reason);
    expectNoKeyMaterial(error.message, [tunnelKeyPkcs8Pem(created.key), storedKey]);
    // Refused, not replaced.
    expect(readFileSync(created.path).equals(tampered)).toBe(true);
    expect(readdirSync(dirname(created.path))).toEqual(['key']);
  });
});

describe('permissions wider than owner-only are refused, never tightened', () => {
  it.each([
    ['0640', 0o640],
    ['0604', 0o604],
    ['0660', 0o660],
    ['0606', 0o606],
    ['0644', 0o644],
    ['0620', 0o620],
    ['0602', 0o602],
    ['0610', 0o610],
    ['0601', 0o601],
  ] as const)('a key file at mode %s', async (label, mode) => {
    const storage = fakeSafeStorage();
    const { path } = await desktop({ userData: base, safeStorage: storage });
    const bytes = readFileSync(path);
    chmodSync(path, mode);
    const error = await refused(desktop({ userData: base, safeStorage: storage }), 'key-file-unsafe');
    expect(error.message).toContain(`mode ${label}`);
    expect(modeOf(path)).toBe(mode);
    expect(readFileSync(path).equals(bytes)).toBe(true);
  });

  it.each([
    ['0750', 0o750],
    ['0705', 0o705],
    ['0770', 0o770],
    ['0711', 0o711],
    ['0701', 0o701],
  ] as const)('a key directory at mode %s', async (label, mode) => {
    const storage = fakeSafeStorage();
    const { path } = await desktop({ userData: base, safeStorage: storage });
    chmodSync(dirname(path), mode);
    const error = await refused(desktop({ userData: base, safeStorage: storage }), 'key-directory-unsafe');
    expect(error.message).toContain(`mode ${label}`);
    expect(modeOf(dirname(path))).toBe(mode);
  });

  it('a key directory that already exists wide is refused before any key is made', async () => {
    const directory = join(base, 'tunnel-identity');
    mkdirSync(directory);
    chmodSync(directory, 0o755);
    await refused(desktop({ userData: base, safeStorage: fakeSafeStorage() }), 'key-directory-unsafe');
    expect(readdirSync(directory)).toEqual([]);
  });

  it.each([
    ['0770', 0o770],
    ['0757', 0o757],
    ['0722', 0o722],
  ] as const)('a data directory other accounts can write, at mode %s', async (label, mode) => {
    chmodSync(base, mode);
    const error = await refused(desktop({ userData: base, safeStorage: fakeSafeStorage() }), 'data-directory-unsafe');
    expect(error.message).toContain(`mode ${label}`);
    expect(readdirSync(base)).toEqual([]);
  });

  it('a data directory others may read but not write is the ordinary case, and is accepted', async () => {
    chmodSync(base, 0o755);
    const { created } = await desktop({ userData: base, safeStorage: fakeSafeStorage() });
    expect(created).toBe(true);
  });
});

describe('the key and its directory must be what they appear to be', () => {
  it('refuses a key file that is a symbolic link, even to a good key', async () => {
    const storage = fakeSafeStorage();
    const good = await desktop({ userData: mkdtempSync(join(base, 'good-')), safeStorage: storage });
    const userData = mkdtempSync(join(base, 'user-data-'));
    mkdirSync(join(userData, 'tunnel-identity'), { mode: 0o700 });
    symlinkSync(good.path, keyPath(userData));
    const error = await refused(desktop({ userData, safeStorage: storage }), 'key-file-unsafe');
    expect(error.message).toContain('symbolic link');
    expect(lstatSync(keyPath(userData)).isSymbolicLink()).toBe(true);
  });

  it('refuses a key directory that is a symbolic link, even to a good one', async () => {
    const storage = fakeSafeStorage();
    const good = await desktop({ userData: mkdtempSync(join(base, 'good-')), safeStorage: storage });
    const userData = mkdtempSync(join(base, 'user-data-'));
    symlinkSync(dirname(good.path), join(userData, 'tunnel-identity'));
    await refused(desktop({ userData, safeStorage: storage }), 'key-directory-unsafe');
  });

  it('follows a data directory that is a symbolic link, as a --root may be, and accepts it', async () => {
    const target = mkdtempSync(join(base, 'root-'));
    const root = join(base, 'root-link');
    symlinkSync(target, root);
    const created = await loadOrCreateServerTunnelKey({ root });
    expect(created).toMatchObject({ created: true, path: keyPath(root) });
    expect(existsSync(keyPath(target))).toBe(true);
    expect((await loadOrCreateServerTunnelKey({ root })).key.pin.spkiSha256).toBe(created.key.pin.spkiSha256);
  });

  it('refuses a directory where the key file should be, and a file where its directory should be', async () => {
    const storage = fakeSafeStorage();
    const a = mkdtempSync(join(base, 'a-'));
    mkdirSync(keyPath(a), { recursive: true, mode: 0o700 });
    const error = await refused(desktop({ userData: a, safeStorage: storage }), 'key-file-unsafe');
    expect(error.message).toContain('not a regular file');

    const b = mkdtempSync(join(base, 'b-'));
    writeFileSync(join(b, 'tunnel-identity'), 'not a directory', { mode: 0o600 });
    await refused(desktop({ userData: b, safeStorage: storage }), 'key-directory-unsafe');
  });

  it('refuses a FIFO planted where the key should be, without hanging on the open', async () => {
    const directory = join(base, 'tunnel-identity');
    mkdirSync(directory, { mode: 0o700 });
    const fifo = join(directory, 'key');
    execFileSync('mkfifo', ['-m', '600', fifo]);
    let timer: NodeJS.Timeout | undefined;
    try {
      const hung = new Promise<never>((_settle, fail) => {
        timer = setTimeout(() => fail(new Error('the open of a FIFO at the key path hung')), 3000);
      });
      const error = await Promise.race([
        refused(loadOrCreateServerTunnelKey({ root: base }), 'key-file-unsafe'),
        hung,
      ]);
      expect(error.message).toContain('not a regular file');
    } finally {
      clearTimeout(timer);
      // Release an open that did block, so a failing run does not leak a thread.
      try {
        closeSync(openSync(fifo, constants.O_WRONLY | constants.O_NONBLOCK));
      } catch {
        // ENXIO: nothing was waiting on it.
      }
    }
  });

  it('refuses a data directory that is missing or is not a directory, and creates neither', async () => {
    const storage = fakeSafeStorage();
    await refused(desktop({ userData: join(base, 'missing'), safeStorage: storage }), 'data-directory-unsafe');
    writeFileSync(join(base, 'a-file'), '', { mode: 0o600 });
    await refused(desktop({ userData: join(base, 'a-file'), safeStorage: storage }), 'data-directory-unsafe');
    expect(readdirSync(base)).toEqual(['a-file']);
  });
});

describe('everything on the path must belong to this account', () => {
  /** `node:fs/promises`, lying about the owner in exactly one kind of answer. */
  function lyingAbout(target: 'stat' | 'lstat' | 'handle'): KeyFileSystem {
    const other = (stat: KeyFileStat) => statWith(stat, { uid: uid + 1 });
    return {
      ...realFs,
      stat: async (path) => (target === 'stat' ? other(await fsPromises.stat(path)) : fsPromises.stat(path)),
      lstat: async (path) => (target === 'lstat' ? other(await fsPromises.lstat(path)) : fsPromises.lstat(path)),
      open: async (path, flags, mode) => {
        const handle = await fsPromises.open(path, flags, mode);
        if (target !== 'handle') return handle;
        return {
          stat: async () => other(await handle.stat()),
          readFile: () => handle.readFile(),
          writeFile: (data) => handle.writeFile(data),
          sync: () => handle.sync(),
          close: () => handle.close(),
        };
      },
    };
  }

  it.each([
    ['data directory', 'stat', 'data-directory-unsafe'],
    ['key directory', 'lstat', 'key-directory-unsafe'],
    ['key file', 'handle', 'key-file-unsafe'],
  ] as const)('refuses a %s that belongs to another account', async (_label, target, reason) => {
    const storage = fakeSafeStorage();
    const { path } = await desktop({ userData: base, safeStorage: storage });
    const bytes = readFileSync(path);
    const error = await refused(desktop({ userData: base, safeStorage: storage, fs: lyingAbout(target) }), reason);
    expect(error.message).toContain(`belongs to uid ${uid + 1}, not ${uid}`);
    expect(readFileSync(path).equals(bytes)).toBe(true);
  });

  it('checks ownership against the uid it is given', async () => {
    await refused(desktop({ userData: base, safeStorage: fakeSafeStorage(), uid: uid + 1 }), 'data-directory-unsafe');
  });
});

/*
 * MACOS ACCESS CONTROL LISTS, FOR REAL. `chmod +a` needs no privilege on a file
 * this account owns, so every case the store has to see is produced here on
 * the actual filesystem and read back by the store's actual `ls`.
 */
describe.runIf(onDarwin)('a macOS access control list is read, and what it grants is refused', () => {
  const addAcl = (path: string, entry: string): void => {
    execFileSync('/bin/chmod', ['+a', entry, path]);
  };
  const listing = (path: string): string => execFileSync('/bin/ls', ['-lde', '--', path], { encoding: 'utf8' });
  const INHERITED_READ = 'group:everyone allow list,search,file_inherit,directory_inherit';

  it('refuses an inheritable entry on the data directory, before anything is made', async () => {
    addAcl(base, INHERITED_READ);
    const error = await refused(loadOrCreateServerTunnelKey({ root: base }), 'data-directory-unsafe');
    expect(error.message).toContain('file_inherit');
    expect(readdirSync(base)).toEqual([]);
  });

  it('refuses the same entry on the target of a symlinked --root', async () => {
    const target = mkdtempSync(join(base, 'root-'));
    addAcl(target, INHERITED_READ);
    const root = join(base, 'root-link');
    symlinkSync(target, root);
    await refused(loadOrCreateServerTunnelKey({ root }), 'data-directory-unsafe');
    expect(readdirSync(target)).toEqual([]);
  });

  it('refuses an entry that lets other accounts add to the data directory', async () => {
    addAcl(base, 'group:everyone allow add_subdirectory');
    await refused(loadOrCreateServerTunnelKey({ root: base }), 'data-directory-unsafe');
  });

  it('accepts entries that only let others read the data directory, as mode 0755 is accepted', async () => {
    addAcl(base, 'group:everyone allow list,search');
    expect((await loadOrCreateServerTunnelKey({ root: base })).created).toBe(true);
  });

  it.each([
    ['the server’s plain key', 'server'],
    ['the desktop’s sealed key', 'desktop'],
  ] as const)('refuses an allow entry on %s at 0600, and leaves the entry where it is', async (_label, app) => {
    const storage = fakeSafeStorage();
    const load = () => (app === 'server' ? loadOrCreateServerTunnelKey({ root: base }) : desktop({ userData: base, safeStorage: storage }));
    const { path } = await load();
    const bytes = readFileSync(path);
    addAcl(path, 'group:everyone allow read');
    expect(modeOf(path)).toBe(0o600);
    const error = await refused(load(), 'key-file-unsafe');
    expect(error.message).toContain('allows read');
    expect(listing(path)).toContain('group:everyone allow read');
    expect(readFileSync(path).equals(bytes)).toBe(true);
  });

  it('refuses an allow entry on the key directory', async () => {
    const { path } = await loadOrCreateServerTunnelKey({ root: base });
    addAcl(dirname(path), 'group:everyone allow list,search');
    await refused(loadOrCreateServerTunnelKey({ root: base }), 'key-directory-unsafe');
  });

  it('accepts a deny entry, which grants nothing', async () => {
    const { path } = await loadOrCreateServerTunnelKey({ root: base });
    addAcl(path, 'user:nobody deny delete');
    addAcl(dirname(path), 'user:nobody deny delete');
    expect(listing(path)).toContain('deny delete');
    expect((await loadOrCreateServerTunnelKey({ root: base })).created).toBe(false);
  });
});

describe('an access control listing the store cannot read is refused', () => {
  /** A listing with no entries: what `ls -lde` prints for a path without an ACL. */
  const bare = (path: string): string => `drwx------  2 someone  staff  64 Sep 14 12:00 ${path}\n`;
  const store = (listAccessControl: AccessControlListing, platform = 'darwin') =>
    loadOrCreateTunnelKey({ dataDirectory: base, fs: realFs, sealer: null, platform, uid, listAccessControl });

  it('lists the data directory, the key directory, the new file before its secret, and the key file on load', async () => {
    const events: string[] = [];
    const recording: AccessControlListing = async (path) => {
      events.push(`list ${path}`);
      return bare(path);
    };
    const writes: KeyFileSystem = {
      ...realFs,
      open: async (path, flags, mode) => {
        const handle = await fsPromises.open(path, flags, mode);
        return {
          stat: () => handle.stat(),
          readFile: () => handle.readFile(),
          writeFile: async (data) => {
            events.push(`write ${path}`);
            await handle.writeFile(data);
          },
          sync: () => handle.sync(),
          close: () => handle.close(),
        };
      },
    };
    const directory = join(base, 'tunnel-identity');
    const created = await loadOrCreateTunnelKey({
      dataDirectory: base,
      fs: writes,
      sealer: null,
      platform: 'darwin',
      uid,
      listAccessControl: recording,
    });
    const temporary = events.find((event) => /^write .*key\.[0-9a-f]{16}\.tmp$/.test(event))!.slice('write '.length);
    expect(events).toEqual([`list ${base}/.`, `list ${directory}/.`, `list ${temporary}`, `write ${temporary}`]);

    events.length = 0;
    await store(recording);
    expect(events).toEqual([`list ${base}/.`, `list ${directory}/.`, `list ${created.path}`]);
  });

  it('never runs it off macOS', async () => {
    const created = await store(() => Promise.reject(new Error('listed on linux')), 'linux');
    expect(created.created).toBe(true);
  });

  it('refuses a listing that fails, and makes nothing', async () => {
    const error = await refused(
      store(() => Promise.reject(Object.assign(new Error('ls: secret detail'), { code: 'ENOENT' }))),
      'data-directory-unsafe',
    );
    expect(error.message).toContain('could not be read (ENOENT)');
    expect(error.message).not.toContain('secret detail');
    expect(readdirSync(base)).toEqual([]);
  });

  it.each([
    ['no listing at all', () => ''],
    ['an error where the listing should be', () => 'ls: cannot access\n'],
    ['an ACL marker with no entries under it', (path: string) => `drwx------+ 2 someone  staff  64 Sep 14 12:00 ${path}\n`],
    ['an entry with no rights', (path: string) => `${bare(path)} 0: group:everyone allow\n`],
    ['an entry that neither allows nor denies', (path: string) => `${bare(path)} 0: group:everyone permit read\n`],
    ['a principal with a space in it', (path: string) => `${bare(path)} 0: group:every one allow read\n`],
    ['a line that is not an entry', (path: string) => `${bare(path)}something else\n`],
  ] as const)('refuses %s', async (_label, print) => {
    await refused(store(async (path) => print(path)), 'data-directory-unsafe');
    expect(readdirSync(base)).toEqual([]);
  });

  it.each(['readattr,readextattr,readsecurity', 'list,search', 'read,execute'])(
    'lets an allow entry of %s stand on the data directory',
    async (rights) => {
      const listing: AccessControlListing = async (path) =>
        path === `${base}/.` ? `${bare(path)} 0: group:everyone inherited allow ${rights}\n` : bare(path);
      expect((await store(listing)).created).toBe(true);
    },
  );

  it.each(['add_file', 'add_subdirectory', 'delete_child', 'writesecurity', 'chown', 'delete', 'file_inherit', 'directory_inherit'])(
    'refuses an allow entry of %s on the data directory',
    async (right) => {
      const listing: AccessControlListing = async (path) =>
        path === `${base}/.` ? `${bare(path)} 0: group:everyone allow list,${right}\n` : bare(path);
      const error = await refused(store(listing), 'data-directory-unsafe');
      expect(error.message).toContain(right);
    },
  );

  it('refuses an allow entry on the new file before the secret is written into it', async () => {
    const listing: AccessControlListing = async (path) =>
      path.endsWith('.tmp') ? `${bare(path)} 0: group:everyone allow read\n` : bare(path);
    const error = await refused(store(listing), 'key-file-unsafe');
    expect(error.message).toContain('allows read');
    expect(readdirSync(join(base, 'tunnel-identity'))).toEqual([]);
  });
});

describe('where owner-only cannot be checked, nothing is stored', () => {
  const untouchable = new Proxy({} as KeyFileSystem, {
    get: (_target, property) => () => {
      throw new Error(`the store touched fs.${String(property)}`);
    },
  });

  it.each(['win32', 'freebsd', 'openbsd', 'sunos', 'aix', 'android', 'cygwin'])(
    'refuses %s, whose permissions this store has not been taught to read, before touching the disk',
    async (platform) => {
      const error = await refused(
        desktop({ userData: base, safeStorage: fakeSafeStorage(), platform, fs: untouchable }),
        'unsupported-platform',
      );
      expect(error.message).toContain(platform);
      await refused(loadOrCreateServerTunnelKey({ root: base, platform, fs: untouchable }), 'unsupported-platform');
    },
  );

  it('refuses a process with no uid to check ownership against', async () => {
    for (const bad of [-1, 1.5, Number.NaN]) {
      await refused(
        desktop({ userData: base, safeStorage: fakeSafeStorage(), uid: bad, fs: untouchable }),
        'unsupported-platform',
      );
    }
  });
});

describe('the key is written so that no one else ever sees it, and so that it stays', () => {
  it('checks the new file is owner-only before writing the secret into it', async () => {
    const writes: string[] = [];
    const wideAtCreate: KeyFileSystem = {
      ...realFs,
      open: async (path, flags, mode) => {
        const handle = await fsPromises.open(path, flags, mode);
        return {
          stat: async () => {
            const stat = await handle.stat();
            return statWith(stat, { mode: stat.mode | 0o044 });
          },
          readFile: () => handle.readFile(),
          writeFile: async (data) => {
            writes.push(data);
            await handle.writeFile(data);
          },
          sync: () => handle.sync(),
          close: () => handle.close(),
        };
      },
    };
    const error = await refused(
      desktop({ userData: base, safeStorage: fakeSafeStorage(), fs: wideAtCreate }),
      'key-file-unsafe',
    );
    expect(error.message).toContain('mode 0644');
    expect(writes).toEqual([]);
    // No key, and no temporary name left behind.
    expect(readdirSync(join(base, 'tunnel-identity'))).toEqual([]);
  });

  it('never writes through a file that is already at its private name', async () => {
    let planted = '';
    const plantsFirst: KeyFileSystem = {
      ...realFs,
      open: (path, flags, mode) => {
        if ((flags & constants.O_CREAT) !== 0) {
          planted = path;
          writeFileSync(path, 'planted', { mode: 0o600 });
        }
        return fsPromises.open(path, flags, mode);
      },
    };
    const error = await desktop({ userData: base, safeStorage: fakeSafeStorage(), fs: plantsFirst }).then(
      () => null,
      (caught: unknown) => caught,
    );
    expect((error as { code?: string } | null)?.code).toBe('EEXIST');
    expect(readFileSync(planted, 'utf8')).toBe('planted');
    expect(existsSync(keyPath(base))).toBe(false);
  });

  it('verifies a sealed key unseals to itself before writing anything', async () => {
    const lying = fakeSafeStorage();
    const otherPem = tunnelKeyPkcs8Pem(generateTunnelKey());
    lying.decryptString = () => otherPem;
    await refused(desktop({ userData: base, safeStorage: lying }), 'pin-mismatch');
    expect(readdirSync(join(base, 'tunnel-identity'))).toEqual([]);

    const broken = fakeSafeStorage();
    broken.decryptString = () => {
      throw new Error('the keychain said no');
    };
    const error = await refused(desktop({ userData: base, safeStorage: broken }), 'unseal-failed');
    expect(error.message).not.toContain('the keychain said no');
    expect(readdirSync(join(base, 'tunnel-identity'))).toEqual([]);
  });

  /** `node:fs/promises`, recording links and syncs — and failing a directory sync when told to. */
  function recordingSyncs(events: string[], directorySync: 'works' | 'fails'): KeyFileSystem {
    return {
      ...realFs,
      link: async (existing, target) => {
        await fsPromises.link(existing, target);
        events.push(`link ${target}`);
      },
      open: async (path, flags, mode) => {
        const handle = await fsPromises.open(path, flags, mode);
        const isDirectory = (flags & constants.O_DIRECTORY) !== 0;
        return {
          stat: () => handle.stat(),
          readFile: () => handle.readFile(),
          writeFile: (data) => handle.writeFile(data),
          sync: async () => {
            if (isDirectory && directorySync === 'fails') {
              throw Object.assign(new Error('EIO: i/o error, fsync'), { code: 'EIO' });
            }
            await handle.sync();
            events.push(`sync ${isDirectory ? 'directory' : 'file'} ${path}`);
          },
          close: () => handle.close(),
        };
      },
    };
  }

  it('syncs the key directory after the link, before reporting the key created', async () => {
    const events: string[] = [];
    const directory = join(base, 'tunnel-identity');
    const created = await loadOrCreateServerTunnelKey({ root: base, fs: recordingSyncs(events, 'works') });
    events.push('reported created');
    expect(created.created).toBe(true);
    expect(events.map((event) => event.replace(/key\.[0-9a-f]{16}\.tmp$/, 'key.<private>.tmp'))).toEqual([
      `sync file ${join(directory, 'key.<private>.tmp')}`,
      `link ${keyPath(base)}`,
      `sync directory ${directory}`,
      'reported created',
    ]);
  });

  it('a key directory that will not sync fails the create, rather than reporting a key a crash could take back', async () => {
    const error = await loadOrCreateServerTunnelKey({ root: base, fs: recordingSyncs([], 'fails') }).then(
      () => null,
      (caught: unknown) => caught,
    );
    expect((error as { code?: string } | null)?.code).toBe('EIO');
    // The link did happen, so the next start finds that key rather than making another.
    const next = await loadOrCreateServerTunnelKey({ root: base });
    expect(next.created).toBe(false);
    expect(readdirSync(join(base, 'tunnel-identity'))).toEqual(['key']);
  });

  it('two starts at once end with one key between them', async () => {
    // Both creates are held at the link until both have reached it, so the
    // race is the one that matters: two fresh keys, one name.
    let waiting: (() => void)[] = [];
    const barrier: KeyFileSystem = {
      ...realFs,
      link: (existing, target) =>
        new Promise<void>((linked, failed) => {
          waiting.push(() => void fsPromises.link(existing, target).then(linked, failed));
          if (waiting.length === 2) {
            const release = waiting;
            waiting = [];
            for (const go of release) go();
          }
        }),
    };
    const storage = fakeSafeStorage();
    const [a, b] = await Promise.all([
      desktop({ userData: base, safeStorage: storage, fs: barrier }),
      desktop({ userData: base, safeStorage: storage, fs: barrier }),
    ]);
    expect([a.created, b.created].sort()).toEqual([false, true]);
    expect(a.key.pin.spkiSha256).toBe(b.key.pin.spkiSha256);
    expect(readdirSync(join(base, 'tunnel-identity'))).toEqual(['key']);
    expect((JSON.parse(readFileSync(a.path, 'utf8')) as Record<string, unknown>)['spkiSha256']).toBe(
      a.key.pin.spkiSha256,
    );
  });

  it('writes nothing to the console, on creation, on load, or on refusal', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => undefined),
    );
    const storage = fakeSafeStorage();
    const { path } = await desktop({ userData: base, safeStorage: storage });
    await desktop({ userData: base, safeStorage: storage });
    rewrite(path, (e) => ({ ...e, key: Buffer.from('never sealed').toString('base64') }));
    await refused(desktop({ userData: base, safeStorage: storage }), 'unseal-failed');
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });
});

describe('the headless server keeps a plain 0600 file under --root (#179)', () => {
  it('creates the key under --root, outside the mapped files tree, and reloads the same pin', async () => {
    const created = await loadOrCreateServerTunnelKey({ root: base });
    expect(created).toMatchObject({ created: true, protection: 'plain', path: keyPath(base) });
    expect(modeOf(created.path)).toBe(0o600);
    expect(modeOf(dirname(created.path))).toBe(0o700);
    expect(created.path.startsWith(join(base, 'files') + sep)).toBe(false);
    expect((JSON.parse(readFileSync(created.path, 'utf8')) as Record<string, unknown>)['protection']).toBe('plain');

    const loaded = await loadOrCreateServerTunnelKey({ root: base });
    expect(loaded.created).toBe(false);
    expect(loaded.key.pin.spkiSha256).toBe(created.key.pin.spkiSha256);
  });

  it('shares the store’s refusals: a sealed key it cannot unseal, a key file other accounts can read', async () => {
    const desktopData = mkdtempSync(join(base, 'desktop-'));
    await desktop({ userData: desktopData, safeStorage: fakeSafeStorage() });
    await refused(loadOrCreateServerTunnelKey({ root: desktopData }), 'encryption-unavailable');

    const root = mkdtempSync(join(base, 'root-'));
    const { path } = await loadOrCreateServerTunnelKey({ root });
    chmodSync(path, 0o644);
    await refused(loadOrCreateServerTunnelKey({ root }), 'key-file-unsafe');
  });
});

describe('the desktop adapter is typed against Electron, not linked to it', () => {
  it('names no electron module (the permissions.ts pattern)', () => {
    const source = readFileSync(resolve(process.cwd(), 'apps/desktop/src/tunnel-identity.ts'), 'utf8');
    expect(source).not.toMatch(/(?:from|import|require)\s*\(?\s*['"]electron['"]/);
    // The matcher is not blind.
    expect("import { safeStorage } from 'electron';").toMatch(/(?:from|import|require)\s*\(?\s*['"]electron['"]/);
  });
});
