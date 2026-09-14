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
 * back to 0600, or stripping an access control list from it, would hide exactly
 * the event the owner needs to see. The same goes for a key that will not load.
 * It is never replaced with a fresh one, because a fresh key is a new pin and
 * every paired device would silently stop trusting this machine. Every refusal
 * names the file and says why; getting past it is a person's decision to delete
 * the key and pair again.
 *
 * SEALED WHERE THE CALLER CAN SEAL (#179), AND ONLY THAT. On the desktop that is
 * Electron's `safeStorage`; a process that cannot encrypt writes the PEM into
 * the same owner-only file instead. The file records which, and the record has
 * to agree with the process reading it:
 *
 *   - a sealed key, and nothing to unseal it: refused (`encryption-unavailable`);
 *   - a plain key, and a sealer: refused (`protection-downgrade`). The ruling is
 *     "encrypted where encryption is available", and a plain envelope is also
 *     the one any process running as this account can write without the
 *     keychain — a key it chose, which the desktop would then serve to every
 *     phone paired afterwards. It is not re-sealed in place either: that would
 *     keep a planted key, sealed.
 *
 * WHAT OWNER-ONLY MEANS, AND WHAT IT DOES NOT COVER. It is the boundary an SSH
 * key has: any process running as this account can read the plain file, and
 * `safeStorage` only raises that to "can ask the OS keychain". Ancestors above
 * the data directory are the account's own and are not walked.
 *
 * Mode bits are the whole answer only where the platform says so, and the store
 * runs only on the two it has been taught to read:
 *
 *   - LINUX. A POSIX access control list cannot grant past the mode: once a file
 *     has named entries, its group bits ARE the ACL mask, and the mask caps every
 *     named user and group (acl(5)). Group and other bits of 0 therefore leave no
 *     entry that grants anything. (An NFSv4 ACL on a network mount is not a POSIX
 *     ACL, and a key directory on one is outside what this checks.)
 *   - MACOS. An ACL there is independent of the mode: `chmod +a "everyone allow
 *     read"` on a 0600 file lets every account read it, and an inheritable entry
 *     on `--root` hands that to every file made below it. Node cannot read an
 *     ACL, so the store reads `/bin/ls -lde` — the tool that prints one — and
 *     refuses what it cannot parse, or cannot run. The data directory may carry
 *     entries that only let others read it, as its mode may; the key's
 *     directory and the key file may carry no allow entry at all.
 *   - EVERYTHING ELSE, Windows first, is refused rather than trusted: Windows
 *     keeps permissions in ACLs the mode does not describe, and the BSDs and
 *     illumos have NFSv4 ACLs of the macOS kind that nothing here reads.
 */

import { Buffer } from 'node:buffer';
import { execFile } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { constants } from 'node:fs';
import { join } from 'node:path';

import {
  TunnelIdentityError,
  generateTunnelKey,
  tunnelKeyFromPkcs8Pem,
  tunnelKeyPkcs8Pem,
  type TunnelIdentityErrorReason,
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

/**
 * What `/bin/ls -lde -- <path>` prints for one path — `<directory>/.` for a
 * directory — which is how this store reads a macOS access control list. A
 * function, so a test can hand the store a listing the machine running it
 * cannot produce: an unreadable one, a line of a shape nobody has seen.
 */
export type AccessControlListing = (path: string) => Promise<string>;

export type KeyProtection = 'sealed' | 'plain';

export interface TunnelKeyStoreOptions {
  /** Electron's `userData`, or the server's `--root`. Must already exist. */
  readonly dataDirectory: string;
  readonly fs: KeyFileSystem;
  /** How to seal a new key and unseal a stored one — or null where this process cannot. */
  readonly sealer: KeySealer | null;
  /** `process.platform`. Only `linux` and `darwin` are stored on. */
  readonly platform: string;
  /** The account every directory and file on the path must belong to: `process.getuid()`. */
  readonly uid: number;
  /** macOS only, and never called elsewhere. `/bin/ls` unless a test says otherwise. */
  readonly listAccessControl?: AccessControlListing;
}

export interface StoredTunnelKey {
  readonly key: TunnelKey;
  /** True only for the call that wrote the key. */
  readonly created: boolean;
  /** How the key is kept on disk — as the file says, which is also what this process can do. */
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

/** The platforms whose permissions this store knows how to read. See the header. */
const SUPPORTED_PLATFORMS: ReadonlySet<string> = new Set(['darwin', 'linux']);

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

/** One macOS access control entry: whether it allows or denies, and which rights. */
interface AccessControlEntry {
  readonly allow: boolean;
  readonly rights: readonly string[];
}

/**
 * `ls -l`'s first column: a type, nine permission characters, and `@` when the
 * file has extended attributes or `+` when it has an ACL — `@` wins when it has
 * both, which is why the entries below decide and the marker only backs them up.
 */
const LISTING_HEAD = /^[-bcdlps][-rwxsStT]{9}[@+]? /;
/** ` 0: group:everyone inherited allow read,execute`, as `ls -e` prints an entry. */
const ACCESS_CONTROL_ENTRY = /^ *\d+: \S+ (?:inherited )?(allow|deny) ([a-z_]+(?:,[a-z_]+)*)$/;
/**
 * The rights an allow entry may give on the data directory: reading it, as its
 * mode may let other accounts. Everything else — adding or removing entries,
 * changing its security, and the inheritance flags that would hand an entry to
 * the key's directory and file — is refused.
 */
const READING_RIGHTS: ReadonlySet<string> = new Set([
  'list',
  'search',
  'read',
  'execute',
  'readattr',
  'readextattr',
  'readsecurity',
]);

function listWithLs(path: string): Promise<string> {
  return new Promise((settle, fail) => {
    execFile(
      '/bin/ls',
      ['-lde', '--', path],
      { env: { LC_ALL: 'C' }, encoding: 'utf8', timeout: 10_000 },
      (error, stdout) => (error === null ? settle(stdout) : fail(error)),
    );
  });
}

/**
 * The access control entries on `path`: none off macOS, refused when they cannot be read.
 *
 * A DIRECTORY IS LISTED AS `<path>/.`. `ls -l` describes a symbolic link named
 * on its command line as the link, and with `-H` it follows the link for the
 * mode but — measured on macOS — prints no entries for the target at all, so a
 * symlinked `--root` whose target grants everything would list clean. Through
 * `/.` the kernel resolves the link and `ls` reads the directory it names, as
 * `stat` does. The key's directory and file are refused as links before they
 * are listed, so for them the suffix changes nothing.
 */
async function accessControlOf(
  options: TunnelKeyStoreOptions,
  path: string,
  kind: 'directory' | 'file',
  reason: TunnelIdentityErrorReason,
): Promise<readonly AccessControlEntry[]> {
  if (options.platform !== 'darwin') return [];
  let listing: string;
  try {
    listing = await (options.listAccessControl ?? listWithLs)(kind === 'directory' ? `${path}/.` : path);
  } catch (error) {
    // The tool's own message is dropped: it only restates the path.
    throw new TunnelIdentityError(
      reason,
      `${path}: its access control list could not be read (${errorCode(error) ?? 'error'})`,
    );
  }
  const unreadable = () =>
    new TunnelIdentityError(reason, `${path}: its access control list is not in a form this store reads`);
  const [head = '', ...lines] = (listing.endsWith('\n') ? listing.slice(0, -1) : listing).split('\n');
  if (!LISTING_HEAD.test(head)) throw unreadable();
  const entries = lines.map((line) => {
    const match = ACCESS_CONTROL_ENTRY.exec(line);
    if (match === null) throw unreadable();
    return { allow: match[1] === 'allow', rights: match[2]!.split(',') };
  });
  // A `+` with nothing listed under it is a listing this parser does not understand.
  if (head[10] === '+' && entries.length === 0) throw unreadable();
  return entries;
}

/** Refuse a key directory or file that an access control list opens to anyone. */
async function assertNoAllowEntry(
  options: TunnelKeyStoreOptions,
  path: string,
  kind: 'directory' | 'file',
): Promise<void> {
  const reason = kind === 'directory' ? 'key-directory-unsafe' : 'key-file-unsafe';
  const granted = (await accessControlOf(options, path, kind, reason)).filter((entry) => entry.allow);
  if (granted.length > 0) {
    const rights = [...new Set(granted.flatMap((entry) => entry.rights))].join(',');
    throw new TunnelIdentityError(
      reason,
      `${path} has an access control list that allows ${rights}; it must have no allow entry. ${NOT_TIGHTENED}`,
    );
  }
}

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
  // The same, granted by an ACL — or an entry the key's directory would inherit.
  const beyondReading = (await accessControlOf(options, path, 'directory', 'data-directory-unsafe'))
    .filter((entry) => entry.allow)
    .flatMap((entry) => entry.rights)
    .filter((right) => !READING_RIGHTS.has(right));
  if (beyondReading.length > 0) {
    throw new TunnelIdentityError(
      'data-directory-unsafe',
      `${path} has an access control list that allows ${[...new Set(beyondReading)].join(',')}: ` +
        'more than reading it, or an entry what is made inside it would inherit',
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
  await assertNoAllowEntry(options, path, 'directory');
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
 * `O_NONBLOCK` keeps a FIFO planted at the path from hanging the open. The ACL
 * is read by path, which is sound only because the directory it is read in has
 * just been checked to be this account's alone.
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
    await assertNoAllowEntry(options, path, 'file');
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

/**
 * The key a stored file holds — refused unless every field is exactly what this
 * build writes, the protection it records is the one this process would write,
 * and the key is the one its recorded pin names.
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
    if (sealer !== null) {
      throw new TunnelIdentityError(
        'protection-downgrade',
        `${path} keeps its key in the clear, and this process can seal. It is not loaded — a plain key ` +
          'file is one any process of this account could have written, with a key of its choosing — and ' +
          'it is not re-sealed, which would keep that key. Delete it and pair every device again.',
      );
    }
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
 * WRITTEN WHERE IT CANNOT BE HALF-SEEN, AND KEPT. A private name opened `O_EXCL`
 * at 0600, checked owner-only through its handle — and its ACL — BEFORE the
 * secret is written, synced, then hard-linked to `key`. `link` fails on an
 * existing name where `rename` would overwrite it, so two processes starting at
 * once end with one key between them. The directory is synced after the link:
 * until it is, the new name lives only in memory, and a power loss that dropped
 * it would have the next start make a second key — a new pin — after this one
 * had already been reported created and paired against. A crash leaves no key,
 * or a whole one that stays.
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
      await assertNoAllowEntry(options, temporary, 'file');
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
    await syncDirectory(options, directory);
    return { key, created: true, protection, path };
  } finally {
    // The private name goes whether or not the link happened. Failing to remove
    // it weakens nothing — it is 0600 in a 0700 directory — so that failure
    // does not replace the error that brought us here.
    await options.fs.unlink(temporary).catch(() => undefined);
  }
}

/**
 * Make a directory's entries durable. A failure is thrown, not swallowed: the
 * caller would otherwise report a key created that a crash could still take back.
 */
async function syncDirectory(options: TunnelKeyStoreOptions, directory: string): Promise<void> {
  const handle = await options.fs.open(directory, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
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
  if (
    !SUPPORTED_PLATFORMS.has(options.platform) ||
    typeof constants.O_NOFOLLOW !== 'number' ||
    typeof constants.O_DIRECTORY !== 'number'
  ) {
    throw new TunnelIdentityError(
      'unsupported-platform',
      `owner-only permissions are not something this store can check on ${options.platform}; no key is stored`,
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
