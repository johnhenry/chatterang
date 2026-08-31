/**
 * A REAL filesystem behind `@capacitor/filesystem`, for the desktop shell.
 *
 * THE BUG THIS CLOSES. `Capacitor.isNativePlatform()` is `getPlatform() !==
 * 'web'`, and the desktop shell reports `'electron'` — so it answers TRUE.
 * `src/lib/download.ts:44` branches on that and takes the NATIVE path, calling
 * `Filesystem.mkdir/writeFile/appendFile/getUri`. `apps/desktop` provided no
 * Filesystem implementation, so `@capacitor/core` fell through to the npm
 * package's WEB shim, which writes into IndexedDB (`DB_NAME = 'Disc'`,
 * `node_modules/@capacitor/filesystem/dist/esm/web.js:27`) — while the
 * inference host opens models from a real directory on disk. The two halves
 * could never meet. (That is a reading of the code path, not an observed
 * artefact: no download has ever completed on desktop, and the app's IndexedDB
 * contains only its own Dexie data.)
 *
 * The seam was a MISSING IMPLEMENTATION, not a branching bug. `download.ts` and
 * `src/lib/export.ts` are already calling the right API for a native platform,
 * and neither changes.
 *
 * FIVE METHODS ARE IMPLEMENTED; TEN REFUSE. Declaring only the five would not
 * refuse the other ten — it would silently reinstate the bug for them.
 * `@capacitor/core`'s `createPluginMethod` (dist/index.js:88-107) checks the
 * plugin header first, and for a method the header does NOT list it takes
 * `else if (impl) return impl[prop].bind(impl)` — where `impl` is the WEB
 * implementation, because `loadPluginImplementation` selects `'web'` whenever
 * `capCustomPlatform !== null`. An undeclared `readdir` therefore still reaches
 * IndexedDB and still succeeds there. So every invocable method is declared,
 * and the ten we cannot honour throw by name. Same house rule as `synthesize`
 * and `diffuse` in `packages/onnx-node`: refuse rather than invent an answer.
 *
 * ROOTS ARE INJECTED, NEVER DERIVED. This module calls no `app.getPath()` and
 * reads no environment. Electron main supplies the roots; a headless server
 * (milestone A9) supplies its own. That is the same discipline
 * `host/entry.ts:49` argues for about the model root — "a host that cannot tell
 * where the model directory is has no basis for confining anything to it, and
 * quietly picking a directory would be a confinement to the wrong place."
 *
 * It is also what keeps this file testable and Electron-free, so
 * `tests/desktop-filesystem.test.ts` drives the real code against a tmpdir
 * instead of launching a window. `apps/desktop/src` outside `bridge/` MAY
 * import `node:` builtins; see `host/model-paths.ts` for that distinction.
 *
 * CONFINEMENT ON EVERY PATH, EVERY CALL. This is a renderer-facing WRITE
 * primitive into app-private storage that CONTAINS the model directory, so the
 * lexical gate (`security.ts:confineModelPath`) and then the filesystem's own
 * answer (`host/real-path.ts:confineRealPath`) run on every method, every time
 * — not once per download. The renderer chooses the path on each of the ~1000
 * `appendFile` calls a multi-gigabyte model takes; a check done once and cached
 * is a check the caller can walk past.
 *
 * WHAT IS STILL NOT CLOSED, stated rather than left to be assumed: this
 * inherits `real-path.ts`'s TOCTOU race — a symlink swapped between the check
 * and the write defeats it. The Capacitor surface implemented here contains no
 * symlink-CREATING method, so this plugin cannot plant one; `rename` and `copy`
 * would need the same treatment on BOTH endpoints if they are ever added.
 */

import { appendFile, lstat, mkdir, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { PluginImplementation, PluginMethod } from '../bridge/plugin-host.js';
import { FILESYSTEM_METHODS } from '../bridge/protocol.js';
import { confineRealPath } from '../host/real-path.js';
import { confineModelPath } from '../security.js';

/** The five methods this shell actually performs. */
export const FILESYSTEM_IMPLEMENTED: readonly string[] = Object.freeze([
  'appendFile',
  'getUri',
  'mkdir',
  'rmdir',
  'writeFile',
]);

/**
 * The ten invocable methods that REFUSE, by name.
 *
 * Written out rather than derived, so adding a method to `FILESYSTEM_METHODS`
 * without deciding which side it falls on is a boot failure: `PluginHost
 * .register` refuses a declared method the implementation does not have.
 * `tests/desktop-filesystem.test.ts` also checks the two lists partition the
 * real plugin's declared surface, read from `definitions.d.ts`.
 *
 * `checkPermissions`/`requestPermissions` are the arguable pair: the web shim
 * and iOS both answer `{publicStorage:'granted'}`, and on desktop that is TRUE
 * — there is no permission gate — so answering would not be a fabricated
 * result in the way a fake `readdir` would be. They refuse anyway, because
 * nothing in `src/` calls either, and a plugin that answers a question it was
 * never asked is surface with no caller. If a caller appears, granting is the
 * defensible change.
 */
export const FILESYSTEM_REFUSED: readonly string[] = Object.freeze([
  'checkPermissions',
  'requestPermissions',
  'readFile',
  'readFileInChunks',
  'deleteFile',
  'readdir',
  'stat',
  'rename',
  'copy',
  'downloadFile',
]);

/** What one platform's roots look like: a `Directory` enum VALUE to a real directory. */
export interface FilesystemPluginOptions {
  /**
   * `Directory` value -> absolute directory on disk.
   *
   * A `Map`, not a record: the key is a renderer-supplied string, and a plain
   * object would answer `__proto__` and `constructor` from `Object.prototype`.
   * A `Map` has no such keys to inherit.
   *
   * Every root MUST already exist. `confineRealPath` starts by `realpath`ing
   * the root and returns null when that throws, so a missing root refuses
   * EVERYTHING — including the `mkdir` that would have created it. Creating
   * them belongs where they are known (main.ts), not where they would be
   * guessed.
   */
  readonly roots: ReadonlyMap<string, string>;
}

/**
 * Standard, PADDED base64 — what `btoa` emits, which is what `download.ts`
 * sends.
 *
 * Validated explicitly because `Buffer.from(s,'base64')` silently DISCARDS
 * invalid characters instead of throwing: a naive implementation writes
 * truncated garbage where the contract (`definitions.d.ts:139-147`) says an
 * error will be thrown, and a truncated model reads as a bad model rather than
 * a bad write. The empty string matches, and must: `download.ts:206` writes
 * `data: ''` to create-and-truncate before it appends.
 */
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

/**
 * A caller-supplied `directory` value, safe to put in a message.
 *
 * The enum's values are SCREAMING_SNAKE ASCII. Anything else is named
 * generically rather than echoed: the caller is a web page, and reflecting an
 * arbitrary string back is one more thing it can use a message to carry.
 */
function nameDirectory(value: unknown): string {
  return typeof value === 'string' && /^[A-Z_]{1,32}$/.test(value)
    ? `"${value}"`
    : 'an unrecognised value';
}

function nameEncoding(value: unknown): string {
  return typeof value === 'string' && /^[a-z0-9-]{1,16}$/.test(value)
    ? `"${value}"`
    : 'an unrecognised value';
}

/**
 * Map `options.directory` to a root, refusing an absent or unmapped one.
 *
 * ABSENT IS A REFUSAL, not a default. `directory` is optional on four of the
 * five implemented methods, and native resolves a directory-less path as an
 * absolute file URL — precisely the arbitrary-path oracle defect [8] closed.
 * There is no safe default root, and picking one silently is the failure mode
 * `host/entry.ts` already argues against.
 */
function rootFor(roots: ReadonlyMap<string, string>, method: string, directory: unknown): string {
  if (typeof directory !== 'string' || directory === '') {
    throw new Error(
      `desktop filesystem: "${method}" needs a "directory". This platform has no default ` +
        'root, and a path with no root would name anywhere on the disk.',
    );
  }
  const root = roots.get(directory);
  if (root === undefined) {
    throw new Error(
      `desktop filesystem: "${method}" cannot use directory ${nameDirectory(directory)}. ` +
        'This shell maps DATA and CACHE only; the other Capacitor directories name iOS and ' +
        'Android storage classes that have no desktop equivalent, and inventing one would be ' +
        'a confinement to the wrong place.',
    );
  }
  return root;
}

/** The one refusal every path check answers with. Never echoes the path. */
function refusePath(method: string, directory: unknown): Error {
  return new Error(
    `desktop filesystem: "${method}" must name a path inside the application's ` +
      `${nameDirectory(directory)} folder. The path is not echoed back.`,
  );
}

interface Confined {
  /** The path as the lexical gate resolved it — symlinks NOT followed. */
  readonly lexical: string;
  /** The path the filesystem would actually open — symlinks followed. */
  readonly real: string;
}

/**
 * The one rule, applied identically to all five methods.
 *
 * (1) map `directory` to a root; (2) the lexical gate — rejects '', NUL bytes,
 * and anything resolving outside the root; (3) the filesystem's answer —
 * `realpath` of the root and of the deepest EXISTING ancestor, with the missing
 * tail re-attached, then a strict `root + sep` prefix. A symlinked PARENT
 * pointing outside the root is caught this way even though the leaf does not
 * exist yet, which is exactly the downloader's situation.
 *
 * Both halves are returned because `rmdir` needs the un-followed one too.
 */
function confine(
  roots: ReadonlyMap<string, string>,
  method: string,
  options: Record<string, unknown>,
): Confined {
  const directory = options['directory'];
  const root = rootFor(roots, method, directory);
  const path = options['path'];
  const lexical = typeof path === 'string' ? confineModelPath(root, path) : null;
  if (lexical === null) throw refusePath(method, directory);
  const real = confineRealPath(root, lexical);
  if (real === null) throw refusePath(method, directory);
  return { lexical, real };
}

/**
 * `data` + `encoding` into bytes, or a refusal.
 *
 * NO `data:` PREFIX IS STRIPPED, deliberately and unlike the web shim
 * (web.js:201), which splits on the first comma before validating. Native does
 * not strip, neither consumer sends one, and a silent split turns
 * `data:text/plain,hello` into a five-byte file rather than an error.
 */
function decode(method: string, data: unknown, encoding: unknown): Buffer {
  if (typeof data !== 'string') {
    throw new Error(
      `desktop filesystem: "${method}" needs its "data" as a string. A Blob is web-only — ` +
        'the plugin type says so — and one cannot cross this bridge at all.',
    );
  }
  if (encoding === undefined || encoding === null) {
    if (!BASE64.test(data)) {
      throw new Error(
        `desktop filesystem: "${method}" was given data that is not valid base64. With no ` +
          '"encoding" the data is the file\'s bytes as standard padded base64. Node\'s ' +
          'decoder discards invalid characters instead of failing, so this is refused rather ' +
          'than written short; a "data:" prefix is not stripped here either.',
      );
    }
    return Buffer.from(data, 'base64');
  }
  if (encoding === 'utf8') return Buffer.from(data, 'utf8');
  throw new Error(
    `desktop filesystem: "${method}" cannot use encoding ${nameEncoding(encoding)}. This ` +
      'shell supports base64 (no "encoding") and "utf8". "ascii" and "utf16" are declared ' +
      'Android-only, and "utf16" is not a Node encoding name at all — passing it through ' +
      'would throw somewhere that does not name this boundary.',
  );
}

/**
 * Run the syscalls, and never let their message out.
 *
 * A Node `ENOENT`/`EISDIR`/`EACCES` message carries the full absolute path,
 * which `toWireError` would forward verbatim to the page — handing back the
 * `userData` location the confinement exists to keep private. The errno code
 * is kept because it is what a bug report needs; the path is not.
 */
async function io<T>(method: string, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    const named = typeof code === 'string' && /^[A-Z]{1,16}$/.test(code) ? ` (${code})` : '';
    throw new Error(
      `desktop filesystem: "${method}" failed${named}. The path is not echoed back.`,
    );
  }
}

/**
 * Require a directory to already exist.
 *
 * The web shim auto-creates one level of missing parent inside `writeFile` and
 * `appendFile`. This does not, and the divergence is deliberate: neither
 * consumer relies on it (`download.ts` calls `mkdir` first; `export.ts` writes
 * into the cache root itself, which main creates at boot), and a write that
 * quietly conjures directories is a write whose failures are invisible —
 * `download.ts:197` already swallows every `mkdir` error, so a confinement
 * refusal there would surface as a puzzling message about the file.
 */
async function requireDirectory(method: string, directory: string): Promise<void> {
  const info = await io(method, async () => stat(directory).catch(() => null));
  if (info === null || !info.isDirectory()) {
    throw new Error(
      `desktop filesystem: "${method}" needs its parent directory to exist. Create it with ` +
        'mkdir first, or pass recursive:true.',
    );
  }
}

/** Throw for one method this shell does not perform, naming it and the closed set. */
function refuseMethod(method: string): PluginMethod {
  return (): never => {
    throw new Error(
      `desktop filesystem: "${method}" is not implemented on this platform. This shell ` +
        `implements ${FILESYSTEM_IMPLEMENTED.join(', ')} only; it will not answer for a ` +
        'method it cannot honour.',
    );
  };
}

/**
 * The plugin implementation `PluginHost.register` takes.
 *
 * Pure: no Electron, no `app.getPath`, no environment. Everything
 * platform-shaped arrives in `options.roots`.
 */
export function createFilesystemPlugin(options: FilesystemPluginOptions): PluginImplementation {
  const roots = options.roots;

  const implementation: Record<string, PluginMethod> = {
    /**
     * Create-or-TRUNCATE, and the truncation is part of the contract.
     *
     * `download.ts:206` writes `data: ''` before its append loop, which is only
     * a reset if this truncates. Opened with 'a' instead, a retried download
     * would silently produce a double-length file that then fails GGUF magic at
     * load — a failure that reads as a bad model rather than a bad write.
     *
     * The returned `uri` is the real path, for the same reason `getUri` returns
     * one. Nothing in `src/` reads it — both consumers call `getUri` separately
     * — so its shape is free; answering consistently costs nothing.
     */
    writeFile: async (raw: unknown): Promise<{ uri: string }> => {
      const request = asRecord(raw);
      const { real } = confine(roots, 'writeFile', request);
      const bytes = decode('writeFile', request['data'], request['encoding']);
      const parent = dirname(real);
      if (request['recursive'] === true) {
        await io('writeFile', () => mkdir(parent, { recursive: true }));
      } else {
        await requireDirectory('writeFile', parent);
      }
      await io('writeFile', () => writeFile(real, bytes, { flag: 'w' }));
      return { uri: real };
    },

    /**
     * Append bytes, in order, one ~4 MiB slice at a time.
     *
     * Confined on EVERY call. `download.ts` sends roughly one call per 4 MiB of
     * model — a few hundred to a few thousand for a real one — and the renderer
     * supplies the path each time.
     */
    appendFile: async (raw: unknown): Promise<void> => {
      const request = asRecord(raw);
      const { real } = confine(roots, 'appendFile', request);
      const bytes = decode('appendFile', request['data'], request['encoding']);
      await requireDirectory('appendFile', dirname(real));
      await io('appendFile', () => appendFile(real, bytes));
    },

    /**
     * Create a directory, refusing one that already exists.
     *
     * That refusal is the CONTRACT, not POSIX intuition: the web shim throws
     * 'Current directory does already exist.' even with `recursive: true`
     * (web.js:301), and iOS maps the same case to `.directoryAlreadyExists`.
     * `download.ts:197` swallows every mkdir error, so a second download of the
     * same model is unaffected.
     *
     * `confineRealPath` is strictly-inside — it returns null for the root
     * itself — so `mkdir('')` or `mkdir('.')` cannot target a root. Roots are
     * created at boot instead, where they are known.
     */
    mkdir: async (raw: unknown): Promise<void> => {
      const request = asRecord(raw);
      const { lexical, real } = confine(roots, 'mkdir', request);
      const exists = await io('mkdir', async () => lstat(lexical).catch(() => null));
      if (exists !== null) {
        throw new Error('desktop filesystem: "mkdir" refused: that directory already exists.');
      }
      const recursive = request['recursive'] === true;
      if (!recursive) await requireDirectory('mkdir', dirname(real));
      // Every intermediate directory `recursive` creates is under a root that
      // has already been confined, because `real` is strictly inside it.
      await io('mkdir', () => mkdir(real, { recursive }));
    },

    /**
     * Remove a directory — the dangerous one, and the only method with a rule
     * of its own.
     *
     * THE HOLE THIS CLOSES. `confineRealPath` RESOLVES the final component. So
     * `rmdir({path:'link', recursive:true})`, where `<root>/link` is a symlink
     * to `<root>/models`, would hand `fs.rm` the resolved TARGET: every model
     * deleted, and the link still sitting there. Node's recursive `rm` does not
     * follow symlinks among the CHILDREN it walks, but the top-level path it is
     * given has already been realpath'd — that is the gap. So the LEXICAL path
     * is `lstat`ed and a symlink at the leaf is refused outright. (Checking the
     * confined path instead, as one might expect, catches nothing: it is
     * realpath'd and therefore never a symlink.)
     *
     * `recursive` is applied to the CONFINED path, never to the caller's
     * string: re-joining the original after checking a different one is how a
     * guard ends up describing a different file than the one that is opened.
     *
     * And it must be a DIRECTORY — the contract's 'Requested path is not a
     * directory' — so rmdir cannot be used to delete a file.
     */
    rmdir: async (raw: unknown): Promise<void> => {
      const request = asRecord(raw);
      const { lexical, real } = confine(roots, 'rmdir', request);
      const leaf = await io('rmdir', async () => lstat(lexical).catch(() => null));
      if (leaf === null) {
        throw new Error('desktop filesystem: "rmdir" refused: that folder does not exist.');
      }
      if (leaf.isSymbolicLink()) {
        throw new Error(
          'desktop filesystem: "rmdir" will not remove a symbolic link. Removing it ' +
            'recursively would delete what it points at and leave the link behind.',
        );
      }
      const target = await io('rmdir', async () => lstat(real).catch(() => null));
      if (target === null || !target.isDirectory()) {
        throw new Error('desktop filesystem: "rmdir" refused: that path is not a directory.');
      }
      if (request['recursive'] === true) {
        await io('rmdir', () => rm(real, { recursive: true }));
      } else {
        await io('rmdir', () => rmdir(real));
      }
    },

    /**
     * THE JOIN, and the one place desktop deliberately diverges from native.
     *
     * `download.ts:218` stores this string verbatim as the model's path;
     * `state/models.ts` persists it; `ai/backends/llama-cpp.ts` hands it to
     * `LlamaCpp.load` and `lib/voice.ts` to `OnnxRuntime.createSession`. Both
     * are gated by `confineModelPath` then `confineRealPath`, which are pure
     * `node:path`/`realpath` code — a `file:///…` string, which is what iOS and
     * Android return here, would `resolve()` to `<modelRoot>/file:/…` and be
     * REFUSED. So this answers with a bare absolute POSIX path, and the
     * divergence is written down rather than discovered later.
     *
     * It is already realpath'd and strictly inside the root, so the model guard
     * accepts it UNCHANGED. `tests/desktop-filesystem.test.ts` pins that
     * property — `confineRealPath(modelRoot, uri) === uri` — rather than the
     * string's shape, because the shape is not what matters.
     *
     * The file need not exist, matching the web shim, which answers for an
     * absent entry too.
     */
    getUri: async (raw: unknown): Promise<{ uri: string }> => {
      const { real } = confine(roots, 'getUri', asRecord(raw));
      return { uri: real };
    },
  };

  for (const method of FILESYSTEM_REFUSED) implementation[method] = refuseMethod(method);

  // Cheap, and it has caught the shape of mistake this file is most exposed to:
  // a method added to the definition and to neither list. `PluginHost.register`
  // would also refuse it, but this names the omission where it happened.
  const missing = FILESYSTEM_METHODS.filter((method) => implementation[method] === undefined);
  if (missing.length > 0) {
    throw new Error(
      `desktop filesystem: declared method(s) with no implementation and no refusal: ${missing.join(', ')}.`,
    );
  }

  return implementation;
}
