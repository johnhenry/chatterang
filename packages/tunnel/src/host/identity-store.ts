/**
 * WHERE THE TUNNEL'S KEY LIVES (#179): owner-only, or refused — written once,
 * for both apps.
 *
 * #158 gives the listener one implementation and two callers, and the same
 * argument holds for the key it serves with: two copies of "check the mode"
 * is how one of them quietly stops checking. So this is the whole store, and
 * `apps/desktop/src/tunnel-identity.ts` and `apps/server/src/tunnel-identity.ts`
 * differ only in the directory they name and whether they can seal.
 *
 *   <data directory>/tunnel-identity/       0700, this account's
 *   <data directory>/tunnel-identity/key    0600, this account's
 *
 * The data directory is Electron's `userData` or the server's `--root`. The key
 * sits beside the `files/` tree those apps map into the renderer's filesystem,
 * never inside it.
 *
 * REFUSED, NOT REPAIRED — the difference from `apps/server/src/token.ts`, which
 * tightens a wide token file on read. A key file other accounts could read may
 * already have been copied, and a pin cannot be revoked (#180): chmod-ing it
 * back to 0600 would hide exactly the event the owner needs to see. The same
 * goes for a key that will not load. It is never replaced with a fresh one,
 * because a fresh key is a new pin and every paired device would silently stop
 * trusting this machine. Every refusal names the file and says why; getting
 * past it is a person's decision to delete the key and pair again.
 *
 * SEALED WHERE THE CALLER CAN SEAL (#179). On the desktop that is Electron's
 * `safeStorage`; a process that cannot encrypt writes the PEM into the same
 * owner-only file instead. The file records which, so a sealed key is never
 * read as plain text. A plain key found where sealing has since become
 * possible is loaded as it is and reported as plain: upgrading it in place is a
 * write nobody has ruled on, and it would keep the same pin, so it can be
 * added without a re-pair.
 *
 * WHAT OWNER-ONLY DOES NOT COVER. It is the boundary an SSH key has: any process
 * running as this account can read the plain file, and `safeStorage` only
 * raises that to "can ask the OS keychain". Ancestors above the data directory
 * are the account's own and are not walked. Windows keeps permissions in ACLs,
 * which mode bits cannot see, so this store refuses to run there until that is
 * decided rather than trusting a mode Windows does not have.
 */

import { Buffer } from 'node:buffer';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { constants } from 'node:fs';
import { join } from 'node:path';

import {
  TunnelIdentityError,
  generateTunnelKey,
  tunnelKeyFromPkcs8Pem,
  tunnelKeyPkcs8Pem,
  type TunnelKey,
} from './identity.js';

/** The parts of a `Stats` this store reads. */
export interface KeyFileStat {
  readonly mode: number;
  readonly uid: number;
  isFile(): boolean;
  isDirectory(): boolean;
}

/** The parts of a `node:fs/promises` `FileHandle` this store uses. */
export interface KeyFileHandle {
  stat(): Promise<KeyFileStat>;
  readFile(): Promise<Uint8Array>;
  writeFile(data: string): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

/**
 * The parts of `node:fs/promises` this store uses — typed structurally, so
 * tests hand it the real module or a wrapper that lies about exactly one thing.
 */
export interface KeyFileSystem {
  stat(path: string): Promise<KeyFileStat>;
  lstat(path: string): Promise<KeyFileStat>;
  mkdir(path: string, options: { readonly mode: number }): Promise<unknown>;
  open(path: string, flags: number, mode?: number): Promise<KeyFileHandle>;
  link(existingPath: string, newPath: string): Promise<void>;
  unlink(path: string): Promise<void>;
}

/** Something that encrypts to bytes only this account, on this machine, can decrypt. */
export interface KeySealer {
  seal(plaintext: string): Uint8Array;
  unseal(sealed: Uint8Array): string;
}

export type KeyProtection = 'sealed' | 'plain';

export interface TunnelKeyStoreOptions {
  /** Electron's `userData`, or the server's `--root`. Must already exist. */
  readonly dataDirectory: string;
  readonly fs: KeyFileSystem;
  /** How to seal a new key and unseal a stored one — or null where this process cannot. */
  readonly sealer: KeySealer | null;
  /** `process.platform`. */
  readonly platform: string;
  /** The account every directory and file on the path must belong to: `process.getuid()`. */
  readonly uid: number;
}

export interface StoredTunnelKey {
  readonly key: TunnelKey;
  /** True only for the call that wrote the key. */
  readonly created: boolean;
  /** How the key is kept on disk — as the file says, not as this process could. */
  readonly protection: KeyProtection;
  readonly path: string;
}

const KEY_DIRECTORY = 'tunnel-identity';
const KEY_FILE = 'key';
const FORMAT = 'chatterang-tunnel-key';
const VERSION = 1;
const ENVELOPE_FIELDS = ['format', 'key', 'protection', 'spkiSha256', 'version'].join(',');
const PIN_BASE64 = /^[A-Za-z0-9+/]{43}=$/;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** Any permission for group or other. */
const NOT_OWNER = 0o077;
/** Write permission for group or other. */
const OTHERS_WRITE = 0o022;

const modeOf = (stat: KeyFileStat): string => (stat.mode & 0o7777).toString(8).padStart(4, '0');

function errorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

/** Refused rather than tightened, and the message says why. See the header. */
const NOT_TIGHTENED =
  'It is not tightened here: something other accounts could reach may already have been copied, ' +
  'and a pinned key cannot be revoked. Delete it and pair every device again to replace it.';

async function checkDataDirectory(options: TunnelKeyStoreOptions): Promise<void> {
  const path = options.dataDirectory;
  let stat: KeyFileStat;
  try {
    // `stat`, following a link: `--root` may legitimately be a symlink, and it
    // is what it points at that has to be this account's.
    stat = await options.fs.stat(path);
  } catch (error) {
    throw new TunnelIdentityError('data-directory-unsafe', `${path} cannot be read (${errorCode(error) ?? 'error'})`);
  }
  if (!stat.isDirectory()) {
    throw new TunnelIdentityError('data-directory-unsafe', `${path} is not a directory`);
  }
  if (stat.uid !== options.uid) {
    throw new TunnelIdentityError('data-directory-unsafe', `${path} belongs to uid ${stat.uid}, not ${options.uid}`);
  }
  // Another account that can write here can swap the key's directory out.
  if ((stat.mode & OTHERS_WRITE) !== 0) {
    throw new TunnelIdentityError(
      'data-directory-unsafe',
      `${path} is writable by other accounts (mode ${modeOf(stat)})`,
    );
  }
}

async function ensureKeyDirectory(options: TunnelKeyStoreOptions, path: string): Promise<void> {
  let stat: KeyFileStat;
  try {
    stat = await options.fs.lstat(path);
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error;
    try {
      await options.fs.mkdir(path, { mode: 0o700 });
    } catch (mkdirError) {
      // Another process made it first. Whatever it made is checked below.
      if (errorCode(mkdirError) !== 'EEXIST') throw mkdirError;
    }
    stat = await options.fs.lstat(path);
  }
  // `lstat` describes a symbolic link as itself, not its target, so a link here
  // is "not a directory" and refused by this one condition.
  if (!stat.isDirectory()) {
    throw new TunnelIdentityError('key-directory-unsafe', `${path} is not a directory`);
  }
  if (stat.uid !== options.uid) {
    throw new TunnelIdentityError('key-directory-unsafe', `${path} belongs to uid ${stat.uid}, not ${options.uid}`);
  }
  if ((stat.mode & NOT_OWNER) !== 0) {
    throw new TunnelIdentityError(
      'key-directory-unsafe',
      `${path} is open to other accounts (mode ${modeOf(stat)}); it must be 0700. ${NOT_TIGHTENED}`,
    );
  }
}

function assertOwnerOnlyFile(stat: KeyFileStat, uid: number, path: string): void {
  if (!stat.isFile()) {
    throw new TunnelIdentityError('key-file-unsafe', `${path} is not a regular file`);
  }
  if (stat.uid !== uid) {
    throw new TunnelIdentityError('key-file-unsafe', `${path} belongs to uid ${stat.uid}, not ${uid}`);
  }
  if ((stat.mode & NOT_OWNER) !== 0) {
    throw new TunnelIdentityError(
      'key-file-unsafe',
      `${path} is open to other accounts (mode ${modeOf(stat)}); it must be 0600. ${NOT_TIGHTENED}`,
    );
  }
}

/**
 * The key file's bytes, or null when there is no key file.
 *
 * OPENED, THEN CHECKED THROUGH THE OPEN HANDLE. `O_NOFOLLOW` refuses a symlink
 * at the open, and the mode and owner are read from the descriptor that is then
 * read from — not from a path someone could swap between a check and a read.
 * `O_NONBLOCK` keeps a FIFO planted at the path from hanging the open.
 */
async function readKeyFile(options: TunnelKeyStoreOptions, path: string): Promise<Uint8Array | null> {
  let handle: KeyFileHandle;
  try {
    handle = await options.fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    const code = errorCode(error);
    if (code === 'ENOENT') return null;
    if (code === 'ELOOP' || code === 'EMLINK') {
      throw new TunnelIdentityError('key-file-unsafe', `${path} is a symbolic link`);
    }
    throw error;
  }
  try {
    assertOwnerOnlyFile(await handle.stat(), options.uid, path);
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

/**
 * The key a stored file holds — refused unless every field is exactly what this
 * build writes and the key is the one its recorded pin names.
 */
function openKeyFile(
  bytes: Uint8Array,
  sealer: KeySealer | null,
  path: string,
): { key: TunnelKey; protection: KeyProtection } {
  const malformed = (what: string) => new TunnelIdentityError('key-file-malformed', `${path}: ${what}`);

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw malformed('not a tunnel key file');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw malformed('not a tunnel key file');
  }
  const fields = parsed as Record<string, unknown>;
  if (Object.keys(fields).sort().join(',') !== ENVELOPE_FIELDS) throw malformed('unexpected fields');
  if (fields['format'] !== FORMAT || fields['version'] !== VERSION) throw malformed('unknown format or version');
  const { protection, spkiSha256, key } = fields;
  if (typeof spkiSha256 !== 'string' || !PIN_BASE64.test(spkiSha256)) {
    throw malformed('the recorded pin is not a base64 SHA-256');
  }
  if (typeof key !== 'string' || key === '') throw malformed('no key');

  let pem: string;
  if (protection === 'sealed') {
    if (sealer === null) {
      throw new TunnelIdentityError(
        'encryption-unavailable',
        `${path} is sealed, and this process cannot unseal it. It is not replaced: a new key is a new ` +
          'pin, and every paired device would have to pair again.',
      );
    }
    if (!BASE64.test(key)) throw malformed('the sealed key is not base64');
    try {
      pem = sealer.unseal(Buffer.from(key, 'base64'));
    } catch {
      // The sealer's own message is dropped: it describes the ciphertext.
      throw new TunnelIdentityError('unseal-failed', `${path} did not unseal`);
    }
  } else if (protection === 'plain') {
    pem = key;
  } else {
    throw malformed('unknown protection');
  }

  const opened = tunnelKeyFromPkcs8Pem(pem);
  const recorded = Buffer.from(spkiSha256, 'base64');
  if (!(recorded.length === opened.pin.spki.length && timingSafeEqual(recorded, opened.pin.spki))) {
    throw new TunnelIdentityError('pin-mismatch', `${path} holds a key that is not the one its pin records`);
  }
  return { key: opened, protection };
}

/**
 * Make a key and write it, or return null when another process wrote one first.
 *
 * VERIFIED BEFORE IT IS WRITTEN: the exact bytes about to go to disk are opened
 * with the same parser and sealer a later load will use, so a sealer whose
 * output does not unseal fails here with nothing written, rather than leaving a
 * key every later start refuses.
 *
 * WRITTEN WHERE IT CANNOT BE HALF-SEEN. A private name opened `O_EXCL` at
 * 0600, checked owner-only through its handle BEFORE the secret is written,
 * synced, then hard-linked to `key`. `link` fails on an existing name where
 * `rename` would overwrite it, so two processes starting at once end with one
 * key between them, and a crash leaves either no key or a whole one.
 */
async function createKeyFile(
  options: TunnelKeyStoreOptions,
  directory: string,
  path: string,
): Promise<StoredTunnelKey | null> {
  const key = generateTunnelKey();
  const { sealer } = options;
  const protection: KeyProtection = sealer === null ? 'plain' : 'sealed';
  const pem = tunnelKeyPkcs8Pem(key);
  const body = sealer === null ? pem : Buffer.from(sealer.seal(pem)).toString('base64');
  const contents = `${JSON.stringify({ format: FORMAT, version: VERSION, protection, spkiSha256: key.pin.spkiSha256, key: body })}\n`;

  openKeyFile(new TextEncoder().encode(contents), sealer, path);

  const temporary = join(directory, `${KEY_FILE}.${randomBytes(8).toString('hex')}.tmp`);
  const handle = await options.fs.open(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    try {
      assertOwnerOnlyFile(await handle.stat(), options.uid, temporary);
      await handle.writeFile(contents);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await options.fs.link(temporary, path);
    } catch (error) {
      if (errorCode(error) === 'EEXIST') return null;
      throw error;
    }
    return { key, created: true, protection, path };
  } finally {
    // The private name goes whether or not the link happened. Failing to remove
    // it weakens nothing — it is 0600 in a 0700 directory — so that failure
    // does not replace the error that brought us here.
    await options.fs.unlink(temporary).catch(() => undefined);
  }
}

/**
 * The tunnel key for this data directory, created on first use.
 *
 * Every check runs on every call, load and create alike: an owner-only
 * directory and file written by an earlier run can be widened later, and the
 * load is where that has to be noticed.
 */
export async function loadOrCreateTunnelKey(options: TunnelKeyStoreOptions): Promise<StoredTunnelKey> {
  if (options.platform === 'win32' || typeof constants.O_NOFOLLOW !== 'number') {
    throw new TunnelIdentityError(
      'unsupported-platform',
      `owner-only permissions cannot be checked with mode bits on ${options.platform}; no key is stored`,
    );
  }
  if (!Number.isSafeInteger(options.uid) || options.uid < 0) {
    throw new TunnelIdentityError('unsupported-platform', 'this process has no uid to check ownership against');
  }

  await checkDataDirectory(options);
  const directory = join(options.dataDirectory, KEY_DIRECTORY);
  await ensureKeyDirectory(options, directory);
  const path = join(directory, KEY_FILE);

  // Twice at most: a create that lost the race reads the winner's key.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const existing = await readKeyFile(options, path);
    if (existing !== null) {
      const { key, protection } = openKeyFile(existing, options.sealer, path);
      return { key, created: false, protection, path };
    }
    const created = await createKeyFile(options, directory, path);
    if (created !== null) return created;
  }
  throw new Error(`${path} was created by another process and then removed before it could be read`);
}
