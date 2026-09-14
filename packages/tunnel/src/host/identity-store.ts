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
 * the same owner-only file instead — except on Windows, below. The file records
 * which, and the record has to agree with the process reading it:
 *
 *   - a sealed key, and nothing to unseal it: refused (`encryption-unavailable`);
 *   - a plain key, and a sealer: refused (`protection-downgrade`). The ruling is
 *     "encrypted where encryption is available", and a plain envelope is also
 *     the one any process running as this account can write without the
 *     keychain — a key it chose, which the desktop would then serve to every
 *     phone paired afterwards. It is not re-sealed in place either: that would
 *     keep a planted key, sealed. On Linux this is the key written before a
 *     keyring existed, and the owner ruled it refused rather than sealed (#179).
 *
 * WHAT OWNER-ONLY MEANS, AND WHAT IT DOES NOT COVER. It is the boundary an SSH
 * key has: any process running as this account can read the plain file, and
 * `safeStorage` only raises that to "can ask the OS keychain" — on Windows, to
 * "can call DPAPI as this account", which Electron documents as protecting from
 * other users on the machine and not from other apps of the same user.
 * Ancestors above the data directory are the account's own and are not walked.
 *
 * Mode bits are the whole answer only where the platform says so, and the store
 * runs only on the three it has been taught to read:
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
 *   - WINDOWS (#179's second ruling). The mode Node reports there describes
 *     nothing but the read-only attribute, and there is no uid, so neither is
 *     read. What decides is the security descriptor, read below: its owner, and
 *     every entry of its DACL. The key is kept ONLY sealed (DPAPI, through
 *     `safeStorage`): a process that cannot seal stores nothing, rather than
 *     writing a plain key the ruling does not allow there.
 *   - EVERYTHING ELSE is refused rather than trusted: the BSDs and illumos have
 *     NFSv4 ACLs of the macOS kind that nothing here reads.
 *
 * HOW WINDOWS IS READ, AND WHY NOT `icacls`. `icacls` prints account NAMES, in
 * the language Windows is installed in ("VORDEFINIERT\Administratoren"), so a
 * parser that knows "BUILTIN\Administrators" refuses every German desktop, and
 * one that does not know names cannot tell an account from a group. The
 * security descriptor's SDDL string names SIDs, identically on every install:
 * `(Get-Acl -LiteralPath <path>).Sddl`, documented in PowerShell's Get-Acl
 * reference with the example `O:BAG:SYD:PAI(A;OICI;FA;;;BA)...`. So the store
 * runs Windows PowerShell for that one property — the path handed over in an
 * environment variable, never spliced into the command — and `whoami /user /fo
 * csv /nh` for the SID of the account it runs as. Both are run by absolute path
 * under `%SystemRoot%\System32`. Anything in either output this parser was not
 * written for — an ACE type other than allow and deny, a flag or right it has
 * no meaning for, an object ACE, a conditional expression — refuses the key
 * rather than being skipped.
 *
 * WHO MAY BE IN A WINDOWS DESCRIPTOR: this account, SYSTEM (`SY`) and
 * BUILTIN\Administrators (`BA`), as owner or in an allow entry; anyone in a deny
 * entry, which grants nothing. SYSTEM and Administrators are not something the
 * store can keep out — an administrator can take ownership of any file
 * (`takeown`, documented for exactly that) and SYSTEM is the machine — and they
 * are what every profile directory under `C:\Users` grants by inheritance, so
 * refusing them would refuse every ordinary install while protecting nothing.
 * Every other SID is another principal: an allow entry for it on the key's
 * directory or file is refused, and on the data directory it may only let that
 * principal read the directory itself — never write it, and never be inherited
 * by what is made inside it.
 *
 * MADE RIGHT, NOT FIXED. Node cannot create a file with a chosen DACL on
 * Windows (`mode` there only sets the read-only attribute), and rewriting a DACL
 * after creation would be exactly the repair this store refuses. A new
 * directory or file takes its DACL from its parent's inheritable entries, so the
 * data directory is refused if any inheritable entry grants another principal
 * anything — before the key's directory is made — and the new directory, then
 * the new file before the secret is written into it, are read back and checked.
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

/**
 * Run one Windows tool and resolve with what it printed to standard output;
 * reject when it could not be run or exited with an error. `env` is added to
 * this process's environment for that one run.
 *
 * Only ever called on Windows, with an absolute `file` under `%SystemRoot%`.
 * A function, so a test on any machine can hand the store the output of a
 * Windows it does not have: a descriptor that grants another account, one that
 * does not parse, a tool that fails.
 */
export type WindowsToolRunner = (
  file: string,
  args: readonly string[],
  env: Readonly<Record<string, string>>,
) => Promise<string>;

export type KeyProtection = 'sealed' | 'plain';

export interface TunnelKeyStoreOptions {
  /** Electron's `userData`, or the server's `--root`. Must already exist. */
  readonly dataDirectory: string;
  readonly fs: KeyFileSystem;
  /** How to seal a new key and unseal a stored one — or null where this process cannot. */
  readonly sealer: KeySealer | null;
  /** `process.platform`. Only `linux`, `darwin` and `win32` are stored on. */
  readonly platform: string;
  /**
   * Linux and macOS: the account every directory and file on the path must
   * belong to, `process.getuid()`. Not read on Windows, which has no uid; the
   * account there is the SID `whoami` reports.
   */
  readonly uid: number;
  /** macOS only, and never called elsewhere. `/bin/ls` unless a test says otherwise. */
  readonly listAccessControl?: AccessControlListing;
  /** Windows only, and never called elsewhere. `execFile` unless a test says otherwise. */
  readonly runWindowsTool?: WindowsToolRunner;
  /** Windows only: where `System32` is. `process.env.SystemRoot` unless a test says otherwise. */
  readonly systemRoot?: string;
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

/** The platforms whose POSIX modes, and on macOS ACLs, this store reads. See the header. */
const POSIX_PLATFORMS: ReadonlySet<string> = new Set(['darwin', 'linux']);
const WINDOWS = 'win32';

/** Any permission for group or other. */
const NOT_OWNER = 0o077;
/** Write permission for group or other. */
const OTHERS_WRITE = 0o022;

const modeOf = (stat: KeyFileStat): string => (stat.mode & 0o7777).toString(8).padStart(4, '0');

function errorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' || typeof code === 'number' ? String(code) : undefined;
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

/*
 * ---------------------------------------------------------------------------
 * WINDOWS: the security descriptor, as SDDL.
 * ---------------------------------------------------------------------------
 */

/** The environment variable the path reaches PowerShell through. Never the command text. */
const ACL_PATH_VARIABLE = 'CHATTERANG_TUNNEL_ACL_PATH';
/**
 * The whole PowerShell command. `Stop` turns Get-Acl's non-terminating error —
 * a path it cannot read — into a failed exit rather than an empty success.
 */
const GET_ACL_COMMAND = `$ErrorActionPreference = 'Stop'; (Get-Acl -LiteralPath $env:${ACL_PATH_VARIABLE}).Sddl`;
const POWERSHELL_ARGS = ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', GET_ACL_COMMAND] as const;
const WHOAMI_ARGS = ['/user', '/fo', 'csv', '/nh'] as const;

/** `C:\Windows`: a drive, and path segments with nothing Windows reserves in them. */
const SYSTEM_ROOT = /^[A-Za-z]:(?:\\[^\\/:*?"<>|\r\n]+)+$/;

/** An SDDL SID: a two-letter alias (`SY`, `BA`) or a SID string (`S-1-5-21-…`). */
const SDDL_SID = String.raw`(?:[A-Z]{2}|S-1-\d+(?:-\d+)+)`;
const SID_ONLY = new RegExp(`^${SDDL_SID}$`);
/** `"desktop\name","S-1-5-21-…"` — `whoami /user /fo csv /nh`. The name is quoted CSV and never read. */
const WHOAMI_LINE = /^"(?:[^"]|"")*","(S-1-\d+(?:-\d+)+)"$/;
/**
 * Owner, optional group, the DACL — its flags and its ACEs — and an optional
 * SACL, which grants nothing and is not read. A descriptor with no `D:` has no
 * DACL at all, which Windows reads as full access for everyone, and does not
 * match.
 */
const DESCRIPTOR = new RegExp(
  String.raw`^O:(${SDDL_SID})(?:G:${SDDL_SID})?D:((?:P|AI|AR|NO_ACCESS_CONTROL)*)((?:\([^()]*\))*)` +
    String.raw`(?:S:(?:P|AI|AR|NO_ACCESS_CONTROL)*(?:\([^()]*\))*)?$`,
);
const ACE = /\(([^()]*)\)/g;
/** The ACE flags an allow or deny entry on a file or directory can carry. */
const ACE_FLAGS: ReadonlySet<string> = new Set(['CI', 'OI', 'NP', 'IO', 'ID', 'SA', 'FA', 'TP', 'CR']);
/** Inherited by what is made inside a directory: object inherit, container inherit. */
const INHERITABLE: ReadonlySet<string> = new Set(['OI', 'CI']);

/** SDDL rights codes, as the access mask bits they stand for. */
const RIGHTS: ReadonlyMap<string, number> = new Map([
  ['GA', 0x10000000],
  ['GR', 0x80000000],
  ['GW', 0x40000000],
  ['GX', 0x20000000],
  ['RC', 0x00020000],
  ['SD', 0x00010000],
  ['WD', 0x00040000],
  ['WO', 0x00080000],
  ['CC', 0x00000001],
  ['DC', 0x00000002],
  ['LC', 0x00000004],
  ['SW', 0x00000008],
  ['RP', 0x00000010],
  ['WP', 0x00000020],
  ['DT', 0x00000040],
  ['LO', 0x00000080],
  ['CR', 0x00000100],
  ['FA', 0x001f01ff],
  ['FR', 0x00120089],
  ['FW', 0x00120116],
  ['FX', 0x001200a0],
  ['KA', 0x000f003f],
  ['KR', 0x00020019],
  ['KW', 0x00020006],
  ['KX', 0x00020019],
]);
/**
 * What another principal may be allowed on the data directory: listing and
 * traversing it, reading its attributes and its security — what mode 0755 lets
 * other accounts do on Linux. FILE_READ_DATA (list), FILE_READ_EA,
 * FILE_EXECUTE (traverse), FILE_READ_ATTRIBUTES, READ_CONTROL, SYNCHRONIZE,
 * GENERIC_READ and GENERIC_EXECUTE. Any other bit — adding a file or a
 * subdirectory, deleting a child, writing attributes, the DACL or the owner — is
 * refused.
 */
const WINDOWS_READING_MASK = 0x00000001 | 0x00000008 | 0x00000020 | 0x00000080 | 0x00020000 | 0x00100000 | 0x80000000 | 0x20000000;

/** The SIDs that may own, or be allowed, anything on the key's path besides this account. See the header. */
const WINDOWS_UNAVOIDABLE: readonly string[] = ['SY', 'S-1-5-18', 'BA', 'S-1-5-32-544'];

interface WindowsAccessEntry {
  readonly allow: boolean;
  readonly flags: ReadonlySet<string>;
  readonly mask: number;
  readonly sid: string;
}

interface WindowsDescriptor {
  readonly owner: string;
  /** Null for `D:NO_ACCESS_CONTROL`: no DACL, so no restriction at all. */
  readonly entries: readonly WindowsAccessEntry[] | null;
}

interface WindowsAccess {
  /** This account's SID, and SYSTEM and Administrators. */
  readonly permitted: ReadonlySet<string>;
  read(path: string): Promise<string>;
}

/** What the store resolved about the platform once, before touching the disk. */
interface StoreContext {
  readonly options: TunnelKeyStoreOptions;
  /** Null off Windows. */
  readonly windows: WindowsAccess | null;
}

function runWithExecFile(
  file: string,
  args: readonly string[],
  env: Readonly<Record<string, string>>,
): Promise<string> {
  return new Promise((settle, fail) => {
    execFile(
      file,
      [...args],
      // PowerShell's first start on a cold machine takes seconds; a check that
      // never answers is still a refusal, just a slower one.
      { env: { ...process.env, ...env }, encoding: 'utf8', timeout: 60_000, windowsHide: true },
      (error, stdout) => (error === null ? settle(stdout) : fail(error)),
    );
  });
}

/** The account this process runs as, and how to read a descriptor — or refused. */
async function windowsAccessFor(options: TunnelKeyStoreOptions): Promise<WindowsAccess> {
  const root = options.systemRoot ?? process.env['SystemRoot'];
  if (root === undefined || !SYSTEM_ROOT.test(root)) {
    throw new TunnelIdentityError(
      'unsupported-platform',
      '%SystemRoot% is not a local absolute path, so the tools that read a Windows ACL cannot be found; no key is stored',
    );
  }
  const run = options.runWindowsTool ?? runWithExecFile;
  const system32 = `${root}\\System32`;
  let printed: string;
  try {
    printed = await run(`${system32}\\whoami.exe`, WHOAMI_ARGS, {});
  } catch (error) {
    // The tool's own message is dropped, as `ls`'s is.
    throw new TunnelIdentityError(
      'unsupported-platform',
      `the account this process runs as could not be read (${errorCode(error) ?? 'error'}); no key is stored`,
    );
  }
  const match = WHOAMI_LINE.exec(printed.trim());
  if (match === null) {
    throw new TunnelIdentityError(
      'unsupported-platform',
      'the account this process runs as is not in a form this store reads; no key is stored',
    );
  }
  const powershell = `${system32}\\WindowsPowerShell\\v1.0\\powershell.exe`;
  return {
    permitted: new Set([match[1]!, ...WINDOWS_UNAVOIDABLE]),
    read: (path) => run(powershell, POWERSHELL_ARGS, { [ACL_PATH_VARIABLE]: path }),
  };
}

/** The rights field of one ACE, as an access mask — or null when it is not one this parser knows. */
function rightsMask(rights: string): number | null {
  if (/^0x[0-9A-Fa-f]{1,8}$/.test(rights)) return Number.parseInt(rights.slice(2), 16) >>> 0;
  if (!/^(?:[A-Z]{2})+$/.test(rights)) return null;
  let mask = 0;
  for (let at = 0; at < rights.length; at += 2) {
    const bits = RIGHTS.get(rights.slice(at, at + 2));
    if (bits === undefined) return null;
    mask |= bits;
  }
  return mask >>> 0;
}

/** Parse `Get-Acl`'s SDDL, or refuse. Nothing unrecognised is skipped. */
function parseDescriptor(sddl: string, path: string, reason: TunnelIdentityErrorReason): WindowsDescriptor {
  const unreadable = () =>
    new TunnelIdentityError(reason, `${path}: its security descriptor is not in a form this store reads`);
  const match = DESCRIPTOR.exec(sddl.trim());
  if (match === null) throw unreadable();
  const [, owner, daclFlags, aces] = match;
  if (daclFlags!.includes('NO_ACCESS_CONTROL')) return { owner: owner!, entries: null };
  const entries = [...aces!.matchAll(ACE)].map(([, body]): WindowsAccessEntry => {
    const fields = body!.split(';');
    if (fields.length !== 6) throw unreadable();
    const [type, flags, rights, objectType, inheritedObjectType, sid] = fields as [string, string, string, string, string, string];
    if (type !== 'A' && type !== 'D') throw unreadable();
    if (flags.length % 2 !== 0) throw unreadable();
    const flagSet = new Set<string>();
    for (let at = 0; at < flags.length; at += 2) {
      const flag = flags.slice(at, at + 2);
      if (!ACE_FLAGS.has(flag)) throw unreadable();
      flagSet.add(flag);
    }
    const mask = rightsMask(rights);
    if (mask === null) throw unreadable();
    // Object ACE GUIDs belong to directory-service objects, never to a file.
    if (objectType !== '' || inheritedObjectType !== '') throw unreadable();
    if (!SID_ONLY.test(sid)) throw unreadable();
    return { allow: type === 'A', flags: flagSet, mask, sid };
  });
  return { owner: owner!, entries };
}

/** Read and check one path's Windows security descriptor. See the header for the rules. */
async function checkWindowsDescriptor(
  windows: WindowsAccess,
  path: string,
  subject: 'data directory' | 'key directory' | 'key file',
  reason: TunnelIdentityErrorReason,
): Promise<void> {
  let sddl: string;
  try {
    sddl = await windows.read(path);
  } catch (error) {
    throw new TunnelIdentityError(
      reason,
      `${path}: its security descriptor could not be read (${errorCode(error) ?? 'error'})`,
    );
  }
  const { owner, entries } = parseDescriptor(sddl, path, reason);
  const wide = subject === 'data directory' ? '' : ` ${NOT_TIGHTENED}`;
  if (!windows.permitted.has(owner)) {
    throw new TunnelIdentityError(
      reason,
      `${path} is owned by ${owner}, which is not this account, SYSTEM or Administrators.${wide}`,
    );
  }
  if (entries === null) {
    throw new TunnelIdentityError(reason, `${path} has no access control list, so every account has full access.${wide}`);
  }
  for (const entry of entries) {
    if (!entry.allow || windows.permitted.has(entry.sid)) continue;
    if (subject !== 'data directory') {
      throw new TunnelIdentityError(
        reason,
        `${path} has an access control entry that allows ${entry.sid}; only this account, SYSTEM and ` +
          `Administrators may be allowed anything on it. ${NOT_TIGHTENED}`,
      );
    }
    if ([...entry.flags].some((flag) => INHERITABLE.has(flag))) {
      throw new TunnelIdentityError(
        reason,
        `${path} has an access control entry for ${entry.sid} that what is made inside it would inherit`,
      );
    }
    if ((entry.mask & ~WINDOWS_READING_MASK) !== 0) {
      throw new TunnelIdentityError(
        reason,
        `${path} has an access control entry that allows ${entry.sid} more than reading it ` +
          `(0x${entry.mask.toString(16).padStart(8, '0')})`,
      );
    }
  }
}

/*
 * ---------------------------------------------------------------------------
 * MACOS: the access control list, as `ls -lde` prints it.
 * ---------------------------------------------------------------------------
 */

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

/**
 * Refuse a key directory or file that an access control list opens to anyone:
 * on macOS any allow entry, on Windows an allow entry for any principal but
 * this account, SYSTEM and Administrators, or an owner outside them.
 */
async function assertNoAllowEntry(context: StoreContext, path: string, kind: 'directory' | 'file'): Promise<void> {
  const reason = kind === 'directory' ? 'key-directory-unsafe' : 'key-file-unsafe';
  if (context.windows !== null) {
    await checkWindowsDescriptor(context.windows, path, kind === 'directory' ? 'key directory' : 'key file', reason);
    return;
  }
  const granted = (await accessControlOf(context.options, path, kind, reason)).filter((entry) => entry.allow);
  if (granted.length > 0) {
    const rights = [...new Set(granted.flatMap((entry) => entry.rights))].join(',');
    throw new TunnelIdentityError(
      reason,
      `${path} has an access control list that allows ${rights}; it must have no allow entry. ${NOT_TIGHTENED}`,
    );
  }
}

async function checkDataDirectory(context: StoreContext): Promise<void> {
  const { options } = context;
  const path = options.dataDirectory;
  let stat: KeyFileStat;
  try {
    // POSIX: `stat`, following a link — `--root` may legitimately be a
    // symlink, and it is what it points at that has to be this account's.
    // Windows: `lstat`, and a link or junction is refused below. Whether Get-Acl
    // reads a reparse point or its target is not something this store can
    // observe, so it is never asked about one.
    stat = await (context.windows === null ? options.fs.stat(path) : options.fs.lstat(path));
  } catch (error) {
    throw new TunnelIdentityError('data-directory-unsafe', `${path} cannot be read (${errorCode(error) ?? 'error'})`);
  }
  if (!stat.isDirectory()) {
    throw new TunnelIdentityError('data-directory-unsafe', `${path} is not a directory`);
  }
  if (context.windows !== null) {
    await checkWindowsDescriptor(context.windows, path, 'data directory', 'data-directory-unsafe');
    return;
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

async function ensureKeyDirectory(context: StoreContext, path: string): Promise<void> {
  const { options } = context;
  let stat: KeyFileStat;
  try {
    stat = await options.fs.lstat(path);
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error;
    try {
      // On Windows the mode is ignored and the directory takes the data
      // directory's inheritable entries, which were checked above.
      await options.fs.mkdir(path, { mode: 0o700 });
    } catch (mkdirError) {
      // Another process made it first. Whatever it made is checked below.
      if (errorCode(mkdirError) !== 'EEXIST') throw mkdirError;
    }
    stat = await options.fs.lstat(path);
  }
  // `lstat` describes a symbolic link — or a Windows junction — as itself, not
  // its target, so a link here is "not a directory" and refused by this one condition.
  if (!stat.isDirectory()) {
    throw new TunnelIdentityError('key-directory-unsafe', `${path} is not a directory`);
  }
  if (context.windows === null) {
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
  await assertNoAllowEntry(context, path, 'directory');
}

/** A regular file — and on Linux and macOS, this account's with no group or other bits. Windows reads its descriptor instead. */
function assertOwnerOnlyFile(context: StoreContext, stat: KeyFileStat, path: string): void {
  if (!stat.isFile()) {
    throw new TunnelIdentityError('key-file-unsafe', `${path} is not a regular file`);
  }
  if (context.windows !== null) return;
  const { uid } = context.options;
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
 *
 * WINDOWS HAS NEITHER FLAG — Node documents only O_APPEND, O_CREAT, O_EXCL,
 * O_RDONLY, O_RDWR, O_TRUNC and O_WRONLY there — so the path is `lstat`-ed
 * first and a link, junction or anything but a regular file is refused before
 * the open. That is a check then a use, sound for the same reason the ACL read
 * is: only this account, SYSTEM and Administrators can change what is in the
 * key's directory, and it was checked a moment ago.
 */
async function readKeyFile(context: StoreContext, path: string): Promise<Uint8Array | null> {
  const { options } = context;
  let flags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
  if (context.windows !== null) {
    let entry: KeyFileStat;
    try {
      entry = await options.fs.lstat(path);
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return null;
      throw error;
    }
    assertOwnerOnlyFile(context, entry, path);
    flags = constants.O_RDONLY;
  }
  let handle: KeyFileHandle;
  try {
    handle = await options.fs.open(path, flags);
  } catch (error) {
    const code = errorCode(error);
    if (code === 'ENOENT') return null;
    if (code === 'ELOOP' || code === 'EMLINK') {
      throw new TunnelIdentityError('key-file-unsafe', `${path} is a symbolic link`);
    }
    throw error;
  }
  try {
    assertOwnerOnlyFile(context, await handle.stat(), path);
    await assertNoAllowEntry(context, path, 'file');
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
 *
 * ON WINDOWS THE DIRECTORY IS NOT SYNCED. Node documents no `O_DIRECTORY` there,
 * and nothing in its file system API that flushes a directory entry, so no sync
 * is attempted rather than one whose effect nobody here has measured. On Windows
 * a power loss soon after a key is first made can therefore still take it back,
 * and this comment is where that is said.
 */
async function createKeyFile(context: StoreContext, directory: string, path: string): Promise<StoredTunnelKey | null> {
  const { options } = context;
  const key = generateTunnelKey();
  const { sealer } = options;
  const protection: KeyProtection = sealer === null ? 'plain' : 'sealed';
  const pem = tunnelKeyPkcs8Pem(key);
  const body = sealer === null ? pem : Buffer.from(sealer.seal(pem)).toString('base64');
  const contents = `${JSON.stringify({ format: FORMAT, version: VERSION, protection, spkiSha256: key.pin.spkiSha256, key: body })}\n`;

  openKeyFile(new TextEncoder().encode(contents), sealer, path);

  const temporary = join(directory, `${KEY_FILE}.${randomBytes(8).toString('hex')}.tmp`);
  const exclusive = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL;
  const handle = await options.fs.open(
    temporary,
    context.windows === null ? exclusive | constants.O_NOFOLLOW : exclusive,
    0o600,
  );
  try {
    try {
      assertOwnerOnlyFile(context, await handle.stat(), temporary);
      await assertNoAllowEntry(context, temporary, 'file');
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
    if (context.windows === null) await syncDirectory(options, directory);
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

/** Everything decided about the platform before the disk is touched — or refused. */
async function contextFor(options: TunnelKeyStoreOptions): Promise<StoreContext> {
  if (options.platform === WINDOWS) {
    // #179: on Windows the key is sealed with DPAPI. A process that cannot seal
    // stores nothing, and a plain key there is never written.
    if (options.sealer === null) {
      throw new TunnelIdentityError(
        'encryption-unavailable',
        'on Windows the tunnel key is kept only sealed with the signed-in account (DPAPI), and this ' +
          'process cannot seal; no key is stored',
      );
    }
    return { options, windows: await windowsAccessFor(options) };
  }
  if (
    !POSIX_PLATFORMS.has(options.platform) ||
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
  return { options, windows: null };
}

/**
 * The tunnel key for this data directory, created on first use.
 *
 * Every check runs on every call, load and create alike: an owner-only
 * directory and file written by an earlier run can be widened later, and the
 * load is where that has to be noticed.
 */
export async function loadOrCreateTunnelKey(options: TunnelKeyStoreOptions): Promise<StoredTunnelKey> {
  const context = await contextFor(options);
  await checkDataDirectory(context);
  const directory = join(options.dataDirectory, KEY_DIRECTORY);
  await ensureKeyDirectory(context, directory);
  const path = join(directory, KEY_FILE);

  // Twice at most: a create that lost the race reads the winner's key.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const existing = await readKeyFile(context, path);
    if (existing !== null) {
      const { key, protection } = openKeyFile(existing, options.sealer, path);
      return { key, created: false, protection, path };
    }
    const created = await createKeyFile(context, directory, path);
    if (created !== null) return created;
  }
  throw new Error(`${path} was created by another process and then removed before it could be read`);
}
