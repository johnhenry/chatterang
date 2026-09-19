/**
 * THE PAIRED-DEVICE REGISTRY (#133): what a host needs to verify and revoke each
 * phone's credential, kept in one owner-only file beside the tunnel key, and
 * nothing else.
 *
 *   <data directory>/tunnel-identity/                  0700, the key store's
 *   <data directory>/tunnel-identity/key               0600, the key store's
 *   <data directory>/tunnel-identity/paired-devices    0600, this file's
 *
 * The owner's ruling on #133 puts the desktop's list "in an app-data file next
 * to the certificate key (#179): owner-only permissions, encrypted with
 * `safeStorage` where available", holding what verification and revocation
 * need and never the credential, and lets it land tested but unreachable. The
 * headless server keeps the same records under `--root`, and #158 wants one
 * implementation, so this is the whole store and both apps would call it with
 * the options they already hand `loadOrCreateTunnelKey`. NOTHING CALLS IT YET.
 *
 * WHAT A RECORD HOLDS: a device id; the SHA-256 digest `createDeviceCredentials`
 * keeps (32 bytes), or the zero-byte TOMBSTONE `revoke` writes before it
 * deletes; the phone's name (#129 — offered by the phone, shown and renamed on
 * the desktop); and when it paired. No last-seen time: that is neither
 * verification nor revocation data. Nothing here says whether the tunnel is on,
 * either — #158's ruling is that it is off at every launch, never remembered.
 *
 * #170's not-sent records for a phone's turns are kept per phone BESIDE these
 * records, not in them. What this file offers them is two explicit operations
 * with a hook: a device removed (the `delete` that `revoke` makes) and a reset.
 * See {@link DeviceRegistry.watchRemovals}.
 *
 * ## Bound to one key
 *
 * The registry is BOUND to a 32-byte `bindTo`: the desktop passes its tunnel
 * key's pin; the server a digest over the pin and its operator token (#135:
 * the token is the root). The envelope records it in the clear — it is not
 * secret — and the order it is read in is the point:
 *
 *   1. format and version, so a file some other build wrote is not guessed at;
 *   2. `bindTo`. A different one discards the file and reports
 *      `cleared: 'binding-changed'`, carrying no trust forward: a key reset
 *      makes every device pair again (#180), and so does the Linux downgrade,
 *      where a plain key is refused once a keyring exists and a new key is made
 *      (#179) — after which this file is a plain envelope and a sealer is
 *      present, and refusing it would leave the desktop unable ever to pair;
 *   3. only then protection. With the binding matching, a plain file where this
 *      process can seal is refused as planted (`protection-downgrade`) — a plain
 *      envelope is one any process of this account can write, digests of its
 *      choosing included — and a sealed one where it cannot is refused
 *      (`encryption-unavailable`). Neither is rewritten or re-sealed in place.
 *
 * The sealed contents carry `bindTo` again, and must agree with the envelope,
 * so an old sealed file cannot be carried to a new binding by editing the
 * field that is in the clear.
 *
 * ## Owner-only, or refused — the key store's rules
 *
 * THE DIRECTORIES ARE THE KEY STORE'S OWN CHECK. Opening the registry calls
 * `loadOrCreateTunnelKey` with the same options, which checks the data
 * directory and the key's directory on every platform it runs on — modes and
 * owner, a macOS ACL, a Windows descriptor — and refuses what it refuses, as a
 * `TunnelIdentityError`. That call loads the key the caller already holds: on a
 * data directory with no key it would make one, which a correct caller never
 * reaches, because `bindTo` comes from that key's pin.
 *
 * THE FILE IS CHECKED HERE, TO THE SAME RULE the key store applies to its key:
 * a regular file of this account's with no group or other bits, opened
 * `O_NOFOLLOW | O_NONBLOCK` and checked through the handle it is read from; on
 * macOS no access control entry that allows anything; on Windows (#179's second
 * ruling: a user-only file there) an owner and every allow entry among this
 * account, SYSTEM and Administrators, read from its security descriptor. The
 * key store keeps its ACL and descriptor readers private, and this change leaves
 * `identity-store.ts` as it is, so the two short readers below restate its rule
 * for one file — running the same tools, with the same arguments and the path
 * in the same environment variable — rather than import it. A wide file is
 * refused, never tightened: what other accounts could reach may already have
 * been read or replaced, and every device then pairs again.
 *
 * ## Writes
 *
 * ATOMIC, AND ONE AT A TIME. Each change builds the whole next file, parses it
 * back with the same parser and sealer a later open will use, writes it to a
 * private name opened `O_EXCL` at 0600 and checked before anything is written
 * into it, syncs it, and renames it over the file. `rename` rather than the key
 * store's `link`, which fails on an existing name where this has to replace
 * one on every mint and revoke; Node documents that an existing `newPath` "will
 * be overwritten", which is what {@link RegistryFileSystem} adds to the key
 * store's file system. On Linux and macOS the directory is then synced, as the
 * key store syncs its own. A write that fails before its rename leaves the
 * previous file, and what this process holds in memory, as they were; a
 * directory sync that fails after it rejects the change with the new file
 * already in place and held, since that is what a restart would read.
 *
 * NO COPY OUTLIVES THE WRITE THAT MADE IT (#131: a revocation leaves nothing
 * behind). A process killed between filling its private name and renaming it,
 * or a write whose own removal of that name failed, leaves a whole copy of the
 * records as they were — every id, digest and name, in the clear where nothing
 * seals. Every open removes each `paired-devices.<16 hex>.tmp` before it reads
 * the file, and every change removes any after its rename, syncing the
 * directory after on Linux and macOS. A removal that fails refuses the open, or
 * rejects the change with the new file in place and held. So once a revoke's
 * delete or a reset resolves, no file here names the phone. The key store's own
 * private names are its to remove, and are left alone.
 *
 * ON WINDOWS the directory is not synced, for the key store's reason (Node
 * offers nothing that flushes a directory entry there), and Node documents the
 * overwrite and nothing about whether it is atomic there. Nobody here has
 * measured it.
 *
 * ONE PROCESS. What was read at open, then each change this process made, is
 * the answer to every `get`. The desktop is one instance and the server one
 * per `--root`; a second process writing the same file is not something this
 * coordinates. (One that opens it while this one is mid-write removes that
 * write's private name, so its rename fails and this process keeps what it had.)
 */

import { Buffer } from 'node:buffer';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { dirname, join } from 'node:path';

import { MAX_NAME_BYTES } from '../pairing/index.js';
import type { CredentialStore } from './credential.js';
import {
  loadOrCreateTunnelKey,
  type KeyFileHandle,
  type KeyFileStat,
  type KeyFileSystem,
  type KeyProtection,
  type TunnelKeyStoreOptions,
} from './identity-store.js';

/**
 * The key store's file system, with `rename` and `readdir`: the registry
 * replaces its file on every change, where the key store only ever creates
 * one, and it lists its directory to find a copy an unfinished write left
 * behind. Declared here, so the key store's own interface — and every caller
 * that hands it one — is unchanged. `node:fs/promises` is one.
 */
export interface RegistryFileSystem extends KeyFileSystem {
  rename(oldPath: string, newPath: string): Promise<void>;
  /** The names in a directory. */
  readdir(path: string): Promise<string[]>;
}

export interface DeviceRegistryOptions extends Omit<TunnelKeyStoreOptions, 'fs'> {
  /** `node:fs/promises` in an app; a wrapper that fails on purpose in a test. */
  readonly fs: RegistryFileSystem;
  /**
   * What the registry is bound to, exactly 32 bytes: the tunnel key's pin on
   * the desktop, a digest over the pin and the operator token on the server.
   * A different value at open clears every device.
   */
  readonly bindTo: Uint8Array;
  /** When a device paired, in ms since the epoch. `Date.now` unless a test says otherwise. */
  readonly now?: () => number;
}

/** A paired device, as a list shows it: no digest, and nothing a phone presents. */
export interface DeviceRecord {
  readonly deviceId: string;
  /** The phone's name (#129), or '' until one is set. */
  readonly name: string;
  readonly pairedAt: number;
  /**
   * Revoked, and kept only as a tombstone because its delete did not finish.
   * It verifies nothing; removing it again finishes the job.
   */
  readonly revoked: boolean;
}

/** What a removal watcher is told: one device gone, or every device. */
export type DeviceRemoval =
  | { readonly kind: 'device'; readonly deviceId: string }
  | { readonly kind: 'reset' };

export interface DeviceRegistry {
  /** The records, as `createDeviceCredentials` reads and writes them. */
  readonly store: CredentialStore;
  /**
   * Whether opening discarded every device because the binding changed. A
   * store kept beside this one (#170's not-sent records) treats it as a reset.
   */
  readonly cleared: null | 'binding-changed';
  readonly path: string;
  /** How the file is kept: sealed where this process can seal, as the key is. */
  readonly protection: KeyProtection;
  /** Every device on file, in the order they paired. */
  list(): readonly DeviceRecord[];
  /**
   * Name or rename a paired device (#129). Refused for a name that is blank,
   * past `MAX_NAME_BYTES` of UTF-8, not well-formed, or carrying a character
   * that can disguise it — the set `src/features/pairing/wording.ts` refuses to
   * show — and for a device that is not paired or is revoked.
   */
  setName(deviceId: string, name: string): Promise<void>;
  /**
   * Forget every device: the file is replaced by one that holds none, and then
   * every removal watcher is told `{ kind: 'reset' }`.
   *
   * IT CLOSES NO TUNNEL. A caller with a listener running revokes each device
   * through `DeviceCredentials` first, which is what closes a device's live
   * tunnels, and resets after.
   */
  reset(): Promise<void>;
  /**
   * Be told when a device is removed — the `delete` that `revoke` makes — or
   * every device is, by `reset`. Told only once the file no longer holds it,
   * never for a change whose write failed, and awaited: a watcher that rejects
   * makes that `delete` or `reset` reject too, after the change, so a caller is
   * not told a phone's records went with it when they did not. Returns the
   * unsubscribe.
   *
   * THE HOOK FOR #170: a store of a phone's not-sent records deletes that
   * phone's on `device` and all of them on `reset`, and when it opens it deletes
   * any phone's that `list()` no longer has — which covers `cleared`, and a
   * removal whose watchers were never told: the process ended first, or the
   * directory sync or the removal of a leftover copy after the rename failed,
   * which rejects the change after the file has already lost the device.
   */
  watchRemovals(onRemoved: (removal: DeviceRemoval) => Promise<void>): () => void;
}

export type DeviceRegistryErrorReason =
  /** `bindTo` is not 32 bytes. */
  | 'binding-invalid'
  /** The registry file, or the new file a write made, is not a regular, owner-only file of this account's. */
  | 'registry-file-unsafe'
  /** The registry file is not one this build writes. */
  | 'registry-malformed'
  /** The registry file says it is a version this build does not read. */
  | 'unknown-version'
  /** The registry file is sealed, the binding matches, and this process cannot unseal it. */
  | 'encryption-unavailable'
  /** The registry file is plain, the binding matches, and this process can seal. */
  | 'protection-downgrade'
  /** The registry file's sealed contents did not unseal. */
  | 'unseal-failed'
  /** A name `setName` will not keep. */
  | 'name-refused'
  /** `setName` for a device that is not paired, or is revoked. */
  | 'unknown-device';

export class DeviceRegistryError extends Error {
  override readonly name = 'DeviceRegistryError';
  constructor(
    readonly reason: DeviceRegistryErrorReason,
    detail: string,
  ) {
    super(`paired-device registry refused (${reason}): ${detail}`);
  }
}

const REGISTRY_FILE = 'paired-devices';
/** The private name a write fills before its rename, and no other name. */
const TEMPORARY_FILE = new RegExp(`^${REGISTRY_FILE}\\.[0-9a-f]{16}\\.tmp$`);
const FORMAT = 'chatterang-paired-devices';
const VERSION = 1;
const ENVELOPE_FIELDS = ['bindTo', 'contents', 'format', 'protection', 'version'].join(',');
const CONTENTS_FIELDS = ['bindTo', 'devices'].join(',');
const RECORD_FIELDS = ['deviceId', 'digest', 'name', 'pairedAt'].join(',');

/** `bindTo`'s width, and a digest's: SHA-256's. */
const BIND_BYTES = 32;
const DIGEST_BYTES = 32;
/** 32 bytes in standard padded base64. */
const BASE64_32 = /^[A-Za-z0-9+/]{43}=$/;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
/** A device id as `createDeviceCredentials` makes one: 16 bytes, base64url. */
const DEVICE_ID = /^[A-Za-z0-9_-]{22}$/;

/**
 * Characters that can make a name read as something other than what it is:
 * C0 and C1 controls, and the bidirectional embeddings, overrides and isolates.
 * The same set as `src/features/pairing/wording.ts`, which the phone uses and
 * the owner's ruling on #129 names; a package cannot import from `src/`, so it
 * is written again here and the test holds the two together.
 */
const DISGUISING = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u;
/** A lone surrogate: text that has no UTF-8 spelling, so no byte length to bound. */
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

const NOT_TIGHTENED =
  'It is not tightened here: what other accounts could reach may already have been read or replaced. ' +
  'Delete it and pair every device again.';

interface StoredDevice {
  /** 32 bytes, or 0 for a tombstone. */
  readonly digest: Uint8Array;
  readonly name: string;
  readonly pairedAt: number;
}

type Devices = ReadonlyMap<string, StoredDevice>;

function errorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' || typeof code === 'number' ? String(code) : undefined;
}

const modeOf = (stat: KeyFileStat): string => (stat.mode & 0o7777).toString(8).padStart(4, '0');

/** Why a name is refused, or null. */
function nameRefusal(name: unknown): string | null {
  if (typeof name !== 'string') return 'a name is text';
  if (LONE_SURROGATE.test(name)) return 'the name is not well-formed text';
  if (name.trim() === '') return 'the name is blank';
  if (DISGUISING.test(name)) {
    return 'the name contains a control or direction-changing character, which can make it read as another name';
  }
  if (Buffer.byteLength(name, 'utf8') > MAX_NAME_BYTES) return `the name is longer than ${MAX_NAME_BYTES} bytes`;
  return null;
}

/*
 * ---------------------------------------------------------------------------
 * The file's own permissions: the key store's rule for its key, for this file.
 * ---------------------------------------------------------------------------
 */

/** What the key store resolved about Windows, resolved again here for this file. */
interface WindowsAccess {
  /** This account's SID, and SYSTEM and Administrators. */
  readonly permitted: ReadonlySet<string>;
  read(path: string): Promise<string>;
}

interface RegistryContext {
  readonly options: DeviceRegistryOptions;
  /** Null off Windows. */
  readonly windows: WindowsAccess | null;
}

/** The key store's variable, command and arguments, so both read a descriptor the same way. */
const ACL_PATH_VARIABLE = 'CHATTERANG_TUNNEL_ACL_PATH';
const GET_ACL_COMMAND = `$ErrorActionPreference = 'Stop'; (Get-Acl -LiteralPath $env:${ACL_PATH_VARIABLE}).Sddl`;
const POWERSHELL_ARGS = ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', GET_ACL_COMMAND] as const;
const WHOAMI_ARGS = ['/user', '/fo', 'csv', '/nh'] as const;
const SYSTEM_ROOT = /^[A-Za-z]:(?:\\[^\\/:*?"<>|\r\n]+)+$/;
const SDDL_SID = String.raw`(?:[A-Z]{2}|S-1-\d+(?:-\d+)+)`;
const SID_ONLY = new RegExp(`^${SDDL_SID}$`);
const WHOAMI_LINE = /^"(?:[^"]|"")*","(S-1-\d+(?:-\d+)+)"$/;
const DESCRIPTOR = new RegExp(
  String.raw`^O:(${SDDL_SID})(?:G:${SDDL_SID})?D:((?:P|AI|AR|NO_ACCESS_CONTROL)*)((?:\([^()]*\))*)` +
    String.raw`(?:S:(?:P|AI|AR|NO_ACCESS_CONTROL)*(?:\([^()]*\))*)?$`,
);
const ACE = /\(([^()]*)\)/g;
const ACE_FLAGS: ReadonlySet<string> = new Set(['CI', 'OI', 'NP', 'IO', 'ID', 'SA', 'FA', 'TP', 'CR']);
/** A rights field: a hex mask, or two-letter codes. Which rights does not change the verdict for a file. */
const ACE_RIGHTS = /^(?:0x[0-9A-Fa-f]{1,8}|(?:[A-Z]{2})+)$/;
const WINDOWS_UNAVOIDABLE: readonly string[] = ['SY', 'S-1-5-18', 'BA', 'S-1-5-32-544'];

/** `ls -l`'s first column, and one entry of `ls -e`, as the key store reads them. */
const LISTING_HEAD = /^[-bcdlps][-rwxsStT]{9}[@+]? /;
const ACCESS_CONTROL_ENTRY = /^ *\d+: \S+ (?:inherited )?(allow|deny) ([a-z_]+(?:,[a-z_]+)*)$/;

function runWithExecFile(
  file: string,
  args: readonly string[],
  env: Readonly<Record<string, string>>,
): Promise<string> {
  return new Promise((settle, fail) => {
    execFile(
      file,
      [...args],
      { env: { ...process.env, ...env }, encoding: 'utf8', timeout: 60_000, windowsHide: true },
      (error, stdout) => (error === null ? settle(stdout) : fail(error)),
    );
  });
}

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

const unsafe = (detail: string) => new DeviceRegistryError('registry-file-unsafe', detail);

async function windowsAccessFor(options: DeviceRegistryOptions): Promise<WindowsAccess> {
  const root = options.systemRoot ?? process.env['SystemRoot'];
  if (root === undefined || !SYSTEM_ROOT.test(root)) {
    throw unsafe('%SystemRoot% is not a local absolute path, so the file’s security descriptor cannot be read');
  }
  const run = options.runWindowsTool ?? runWithExecFile;
  const system32 = `${root}\\System32`;
  let printed: string;
  try {
    printed = await run(`${system32}\\whoami.exe`, WHOAMI_ARGS, {});
  } catch (error) {
    throw unsafe(`the account this process runs as could not be read (${errorCode(error) ?? 'error'})`);
  }
  const match = WHOAMI_LINE.exec(printed.trim());
  if (match === null) throw unsafe('the account this process runs as is not in a form this store reads');
  const powershell = `${system32}\\WindowsPowerShell\\v1.0\\powershell.exe`;
  return {
    permitted: new Set([match[1]!, ...WINDOWS_UNAVOIDABLE]),
    read: (path) => run(powershell, POWERSHELL_ARGS, { [ACL_PATH_VARIABLE]: path }),
  };
}

/** Windows: an owner, and every allow entry, among this account, SYSTEM and Administrators — or refused. */
async function checkWindowsFile(windows: WindowsAccess, path: string): Promise<void> {
  let sddl: string;
  try {
    sddl = await windows.read(path);
  } catch (error) {
    throw unsafe(`${path}: its security descriptor could not be read (${errorCode(error) ?? 'error'})`);
  }
  const unreadable = () => unsafe(`${path}: its security descriptor is not in a form this store reads`);
  const match = DESCRIPTOR.exec(sddl.trim());
  if (match === null) throw unreadable();
  const [, owner, daclFlags, aces] = match;
  if (!windows.permitted.has(owner!)) {
    throw unsafe(`${path} is owned by ${owner}, which is not this account, SYSTEM or Administrators. ${NOT_TIGHTENED}`);
  }
  if (daclFlags!.includes('NO_ACCESS_CONTROL')) {
    throw unsafe(`${path} has no access control list, so every account has full access. ${NOT_TIGHTENED}`);
  }
  for (const [, body] of aces!.matchAll(ACE)) {
    const fields = body!.split(';');
    if (fields.length !== 6) throw unreadable();
    const [type, flags, rights, objectType, inheritedObjectType, sid] = fields as [string, string, string, string, string, string];
    if (type !== 'A' && type !== 'D') throw unreadable();
    if (flags.length % 2 !== 0) throw unreadable();
    for (let at = 0; at < flags.length; at += 2) {
      if (!ACE_FLAGS.has(flags.slice(at, at + 2))) throw unreadable();
    }
    if (!ACE_RIGHTS.test(rights) || objectType !== '' || inheritedObjectType !== '' || !SID_ONLY.test(sid)) {
      throw unreadable();
    }
    if (type === 'A' && !windows.permitted.has(sid)) {
      throw unsafe(
        `${path} has an access control entry that allows ${sid}; only this account, SYSTEM and ` +
          `Administrators may be allowed anything on it. ${NOT_TIGHTENED}`,
      );
    }
  }
}

/** macOS: no access control entry that allows anything — or refused. Nothing to read elsewhere. */
async function checkMacAccessControl(options: DeviceRegistryOptions, path: string): Promise<void> {
  if (options.platform !== 'darwin') return;
  let listing: string;
  try {
    listing = await (options.listAccessControl ?? listWithLs)(path);
  } catch (error) {
    throw unsafe(`${path}: its access control list could not be read (${errorCode(error) ?? 'error'})`);
  }
  const unreadable = () => unsafe(`${path}: its access control list is not in a form this store reads`);
  const [head = '', ...lines] = (listing.endsWith('\n') ? listing.slice(0, -1) : listing).split('\n');
  if (!LISTING_HEAD.test(head)) throw unreadable();
  const allowed = lines.flatMap((line) => {
    const entry = ACCESS_CONTROL_ENTRY.exec(line);
    if (entry === null) throw unreadable();
    return entry[1] === 'allow' ? entry[2]!.split(',') : [];
  });
  if (head[10] === '+' && lines.length === 0) throw unreadable();
  if (allowed.length > 0) {
    throw unsafe(
      `${path} has an access control list that allows ${[...new Set(allowed)].join(',')}; it must have no ` +
        `allow entry. ${NOT_TIGHTENED}`,
    );
  }
}

/** A regular file — and on Linux and macOS, this account's with no group or other bits. */
function assertOwnerOnlyFile(context: RegistryContext, stat: KeyFileStat, path: string): void {
  if (!stat.isFile()) throw unsafe(`${path} is not a regular file`);
  if (context.windows !== null) return;
  const { uid } = context.options;
  if (stat.uid !== uid) throw unsafe(`${path} belongs to uid ${stat.uid}, not ${uid}`);
  if ((stat.mode & 0o077) !== 0) {
    throw unsafe(`${path} is open to other accounts (mode ${modeOf(stat)}); it must be 0600. ${NOT_TIGHTENED}`);
  }
}

/** The access control list or descriptor: nothing but this account, or refused. */
async function assertNoOtherAccess(context: RegistryContext, path: string): Promise<void> {
  if (context.windows !== null) {
    await checkWindowsFile(context.windows, path);
    return;
  }
  await checkMacAccessControl(context.options, path);
}

/**
 * The registry file's bytes, or null when there is none — opened, then checked
 * through the handle it is read from, as the key store reads its key. On
 * Windows, which has neither `O_NOFOLLOW` nor `O_NONBLOCK`, the path is
 * `lstat`-ed and anything but a regular file refused before the open.
 */
async function readRegistryFile(context: RegistryContext, path: string): Promise<Uint8Array | null> {
  const { fs } = context.options;
  let flags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
  if (context.windows !== null) {
    let entry: KeyFileStat;
    try {
      entry = await fs.lstat(path);
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return null;
      throw error;
    }
    assertOwnerOnlyFile(context, entry, path);
    flags = constants.O_RDONLY;
  }
  let handle: KeyFileHandle;
  try {
    handle = await fs.open(path, flags);
  } catch (error) {
    const code = errorCode(error);
    if (code === 'ENOENT') return null;
    if (code === 'ELOOP' || code === 'EMLINK') throw unsafe(`${path} is a symbolic link`);
    throw error;
  }
  try {
    assertOwnerOnlyFile(context, await handle.stat(), path);
    await assertNoOtherAccess(context, path);
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

/*
 * ---------------------------------------------------------------------------
 * The file's format.
 * ---------------------------------------------------------------------------
 */

const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64');

/** The whole file for these devices, bound to `bindTo`, sealed when there is a sealer. */
function registryText(devices: Devices, bindTo: Uint8Array, sealer: DeviceRegistryOptions['sealer']): string {
  const binding = b64(bindTo);
  const inner = {
    bindTo: binding,
    devices: [...devices]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([deviceId, device]) => ({
        deviceId,
        digest: device.digest.byteLength === 0 ? '' : b64(device.digest),
        name: device.name,
        pairedAt: device.pairedAt,
      })),
  };
  const protection: KeyProtection = sealer === null ? 'plain' : 'sealed';
  const contents = sealer === null ? inner : b64(sealer.seal(JSON.stringify(inner)));
  return `${JSON.stringify({ format: FORMAT, version: VERSION, protection, bindTo: binding, contents })}\n`;
}

/**
 * The devices a file holds for this binding — or `'other-binding'` when it was
 * written for another one, which the caller discards — or refused. The order
 * of the checks is the header's.
 */
function parseRegistry(
  bytes: Uint8Array,
  sealer: DeviceRegistryOptions['sealer'],
  bindTo: Uint8Array,
  path: string,
): Map<string, StoredDevice> | 'other-binding' {
  const malformed = (what: string) => new DeviceRegistryError('registry-malformed', `${path}: ${what}`);
  const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);
  const fieldsOf = (value: Record<string, unknown>) => Object.keys(value).sort().join(',');

  let envelope: unknown;
  try {
    envelope = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw malformed('not a paired-devices file');
  }
  if (!isRecord(envelope) || envelope['format'] !== FORMAT) throw malformed('not a paired-devices file');
  if (envelope['version'] !== VERSION) {
    throw new DeviceRegistryError(
      'unknown-version',
      `${path} is version ${JSON.stringify(envelope['version'])}, and this build reads only version ${VERSION}`,
    );
  }
  if (fieldsOf(envelope) !== ENVELOPE_FIELDS) throw malformed('unexpected fields');
  const binding = envelope['bindTo'];
  if (typeof binding !== 'string' || !BASE64_32.test(binding)) throw malformed('the binding is not 32 bytes of base64');

  // The binding before the protection: a file from another binding carries no
  // trust forward, whatever it was sealed with.
  if (!Buffer.from(binding, 'base64').equals(Buffer.from(bindTo))) return 'other-binding';

  const { protection, contents } = envelope;
  let inner: unknown;
  if (protection === 'sealed') {
    if (sealer === null) {
      throw new DeviceRegistryError(
        'encryption-unavailable',
        `${path} is sealed, and this process cannot unseal it. It is not replaced: every paired device would ` +
          'have to pair again.',
      );
    }
    if (typeof contents !== 'string' || !BASE64.test(contents)) throw malformed('the sealed contents are not base64');
    let text: string;
    try {
      text = sealer.unseal(Buffer.from(contents, 'base64'));
    } catch {
      // The sealer's own message is dropped: it describes the ciphertext.
      throw new DeviceRegistryError('unseal-failed', `${path} did not unseal`);
    }
    try {
      inner = JSON.parse(text);
    } catch {
      throw malformed('the sealed contents are not a list of devices');
    }
  } else if (protection === 'plain') {
    if (sealer !== null) {
      throw new DeviceRegistryError(
        'protection-downgrade',
        `${path} keeps its records in the clear, and this process can seal. It is not loaded — a plain file ` +
          'is one any process of this account could have written, with digests of its choosing — and it is ' +
          'not re-sealed, which would keep them. Delete it and pair every device again.',
      );
    }
    inner = contents;
  } else {
    throw malformed('unknown protection');
  }

  if (!isRecord(inner) || fieldsOf(inner) !== CONTENTS_FIELDS) throw malformed('the contents have unexpected fields');
  if (inner['bindTo'] !== binding) throw malformed('the contents are bound to something other than the envelope says');
  const listed = inner['devices'];
  if (!Array.isArray(listed)) throw malformed('the devices are not a list');

  const devices = new Map<string, StoredDevice>();
  for (const record of listed) {
    if (!isRecord(record) || fieldsOf(record) !== RECORD_FIELDS) throw malformed('a device has unexpected fields');
    const { deviceId, digest, name, pairedAt } = record;
    if (typeof deviceId !== 'string' || !DEVICE_ID.test(deviceId)) throw malformed('a device id is not one this build makes');
    if (devices.has(deviceId)) throw malformed('a device is listed twice');
    if (typeof digest !== 'string' || (digest !== '' && !BASE64_32.test(digest))) {
      throw malformed('a digest is neither 32 bytes nor a tombstone');
    }
    if (typeof name !== 'string' || (name !== '' && nameRefusal(name) !== null)) throw malformed('a name is not one setName keeps');
    if (typeof pairedAt !== 'number' || !Number.isSafeInteger(pairedAt) || pairedAt < 0) {
      throw malformed('a pairing time is not a time');
    }
    devices.set(deviceId, {
      digest: digest === '' ? new Uint8Array(0) : new Uint8Array(Buffer.from(digest, 'base64')),
      name,
      pairedAt,
    });
  }
  return devices;
}

/*
 * ---------------------------------------------------------------------------
 * Writing it.
 * ---------------------------------------------------------------------------
 */

/**
 * Replace the file with `text`: a private name, checked before it holds
 * anything, synced, renamed over the file. Resolves once the rename is done;
 * the private name is removed whenever it was not renamed.
 */
async function replaceRegistryFile(context: RegistryContext, directory: string, path: string, text: string): Promise<void> {
  const { fs } = context.options;
  const temporary = join(directory, `${REGISTRY_FILE}.${randomBytes(8).toString('hex')}.tmp`);
  const exclusive = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL;
  const handle = await fs.open(temporary, context.windows === null ? exclusive | constants.O_NOFOLLOW : exclusive, 0o600);
  let renamed = false;
  try {
    try {
      assertOwnerOnlyFile(context, await handle.stat(), temporary);
      await assertNoOtherAccess(context, temporary);
      await handle.writeFile(text);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temporary, path);
    renamed = true;
  } finally {
    // Failing to remove it weakens nothing — it is 0600 in a 0700 directory —
    // so that failure does not replace the error that brought us here.
    if (!renamed) await fs.unlink(temporary).catch(() => undefined);
  }
}

/** Make a directory's entries durable, as the key store does. Not on Windows. */
async function syncDirectory(fs: KeyFileSystem, directory: string): Promise<void> {
  const handle = await fs.open(directory, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * Remove every private name a write left behind, and resolve to whether there
 * was one. Each holds a whole copy of the records as they were when it was
 * written, so one left in place would outlive the revoke or reset that forgot
 * a phone (#131). A name already gone counts as removed; any other failure
 * rejects. The key store's own private names are not this file's to remove.
 */
async function removeLeftovers(fs: RegistryFileSystem, directory: string): Promise<boolean> {
  let removed = false;
  for (const name of await fs.readdir(directory)) {
    if (!TEMPORARY_FILE.test(name)) continue;
    try {
      await fs.unlink(join(directory, name));
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error;
    }
    removed = true;
  }
  return removed;
}

/**
 * Open the paired-device registry for this data directory.
 *
 * The key store's checks run first, on every open, then any copy an unfinished
 * write left is removed, then the file's own checks. A refusal from the file's
 * checks leaves the file as it was, except that a file bound to another
 * `bindTo` is replaced by an empty one and reported as `cleared`.
 */
export async function openDeviceRegistry(options: DeviceRegistryOptions): Promise<DeviceRegistry> {
  if (!(options.bindTo instanceof Uint8Array) || options.bindTo.byteLength !== BIND_BYTES) {
    throw new DeviceRegistryError('binding-invalid', `bindTo must be ${BIND_BYTES} bytes`);
  }
  const bindTo = new Uint8Array(options.bindTo);
  const now = options.now ?? Date.now;

  const key = await loadOrCreateTunnelKey(options);
  const directory = dirname(key.path);
  const path = join(directory, REGISTRY_FILE);
  const context: RegistryContext = {
    options,
    windows: options.platform === 'win32' ? await windowsAccessFor(options) : null,
  };

  /** Remove what an unfinished write left, and make that durable where the key store syncs. */
  const sweep = async (): Promise<void> => {
    if ((await removeLeftovers(options.fs, directory)) && context.windows === null) {
      await syncDirectory(options.fs, directory);
    }
  };

  /** The whole next file, parsed back before it is written, then written. */
  const write = async (next: Devices): Promise<void> => {
    const text = registryText(next, bindTo, options.sealer);
    const reread = parseRegistry(new TextEncoder().encode(text), options.sealer, bindTo, path);
    if (reread === 'other-binding' || reread.size !== next.size) {
      throw new Error(`${path}: the file about to be written does not read back as itself`);
    }
    await replaceRegistryFile(context, directory, path, text);
  };

  // A process killed between a write and its rename left its copy: before
  // anything is read or written.
  await sweep();

  let devices: Devices = new Map();
  let cleared: null | 'binding-changed' = null;
  const existing = await readRegistryFile(context, path);
  if (existing !== null) {
    const parsed = parseRegistry(existing, options.sealer, bindTo, path);
    if (parsed === 'other-binding') {
      cleared = 'binding-changed';
      await write(devices);
      if (context.windows === null) await syncDirectory(options.fs, directory);
    } else {
      devices = parsed;
    }
  }

  let tail: Promise<unknown> = Promise.resolve();
  /** One change at a time, each from the last one's result. */
  const serialised = <T>(step: () => Promise<T>): Promise<T> => {
    const result = tail.then(step);
    tail = result.catch(() => undefined);
    return result;
  };
  /**
   * Write `next`, and hold it once the file does; then remove a copy an
   * earlier write of this process could not, so that once a change resolves no
   * copy holds what it replaced.
   */
  const commit = async (next: Devices): Promise<void> => {
    await write(next);
    devices = next;
    if (context.windows === null) await syncDirectory(options.fs, directory);
    await sweep();
  };

  const watchers = new Set<(removal: DeviceRemoval) => Promise<void>>();
  const tell = async (removal: DeviceRemoval): Promise<void> => {
    const outcomes = await Promise.allSettled([...watchers].map(async (watcher) => watcher(removal)));
    const failures = outcomes.flatMap((outcome) => (outcome.status === 'rejected' ? [outcome.reason as unknown] : []));
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        `paired-device registry: ${removal.kind === 'reset' ? 'every device was' : 'the device was'} removed, ` +
          'and a removal watcher failed',
      );
    }
  };

  const store: CredentialStore = {
    async get(deviceId) {
      const found = devices.get(deviceId);
      return found === undefined ? undefined : new Uint8Array(found.digest);
    },
    set(deviceId, digest) {
      return serialised(async () => {
        if (!DEVICE_ID.test(deviceId)) throw new TypeError('paired-device registry: not a device id');
        if (digest.byteLength !== DIGEST_BYTES && digest.byteLength !== 0) {
          throw new TypeError('paired-device registry: a digest is 32 bytes, or empty for a tombstone');
        }
        const known = devices.get(deviceId);
        // A tombstone replaces a digest. With no digest there is nothing to
        // keep refused, so nothing is written.
        if (known === undefined && digest.byteLength === 0) return;
        const next = new Map(devices);
        next.set(deviceId, {
          digest: new Uint8Array(digest),
          name: known?.name ?? '',
          pairedAt: known?.pairedAt ?? now(),
        });
        await commit(next);
      });
    },
    async delete(deviceId) {
      const removed = await serialised(async () => {
        if (!devices.has(deviceId)) return false;
        const next = new Map(devices);
        next.delete(deviceId);
        await commit(next);
        return true;
      });
      if (removed) await tell({ kind: 'device', deviceId });
      return removed;
    },
  };

  return {
    store,
    cleared,
    path,
    protection: key.protection,
    list: () =>
      [...devices]
        .map(([deviceId, device]) => ({
          deviceId,
          name: device.name,
          pairedAt: device.pairedAt,
          revoked: device.digest.byteLength === 0,
        }))
        .sort((a, b) => a.pairedAt - b.pairedAt || (a.deviceId < b.deviceId ? -1 : 1)),
    setName: (deviceId, name) =>
      serialised(async () => {
        const refusal = nameRefusal(name);
        if (refusal !== null) throw new DeviceRegistryError('name-refused', refusal);
        const known = devices.get(deviceId);
        if (known === undefined || known.digest.byteLength === 0) {
          throw new DeviceRegistryError('unknown-device', 'there is no paired device with that id');
        }
        if (known.name === name) return;
        const next = new Map(devices);
        next.set(deviceId, { ...known, name });
        await commit(next);
      }),
    async reset() {
      await serialised(() => commit(new Map()));
      await tell({ kind: 'reset' });
    },
    watchRemovals(onRemoved) {
      watchers.add(onRemoved);
      return () => {
        watchers.delete(onRemoved);
      };
    },
  };
}
