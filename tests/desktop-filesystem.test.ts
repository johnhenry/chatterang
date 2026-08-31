/**
 * The desktop filesystem: the implementation that was missing, and the
 * confinement that has to come with it.
 *
 * THE DEFECT. `Capacitor.isNativePlatform()` answers TRUE on desktop
 * (`getPlatform()` is `'electron'`), so `src/lib/download.ts` took its NATIVE
 * branch into `@capacitor/filesystem` — which had no desktop implementation, so
 * `@capacitor/core` fell through to the package's WEB shim and wrote the model
 * into IndexedDB, while the inference host opened models from a real directory
 * on disk that had never been created. Every test below drives the real
 * implementation against a real temporary directory; none of them launches a
 * window.
 *
 * WHY THIS FILE IS LONGER THAN THE IMPLEMENTATION. This is a renderer-facing
 * WRITE and DELETE primitive into app-private storage that CONTAINS the model
 * directory, and the repo's recurring failure has been a harness that lies
 * rather than code that breaks. So every guard here is stated as the thing it
 * refuses, and every one of them was run against a deliberately broken
 * implementation before it was believed.
 *
 * TWENTY FAULTS WERE INJECTED, one at a time, each into the wired code and each
 * reverted afterwards. Every one produced a non-zero exit. What each broke:
 *
 *   1  `confine()` skips `confineRealPath`      -> 7 fail: the SYMLINK-out-of-root
 *                                                  case on all five methods
 *   2  `writeFile` opens 'a' instead of 'w'     -> the truncate test
 *   3  the base64 validation removed            -> 2 base64 tests
 *   4  `rmdir` lstats `real` not `lexical`      -> the leaf-symlink test, AND
 *                                                  `<data>/models/llama-cpp/model.gguf`
 *                                                  was ACTUALLY DELETED — the
 *                                                  guard the design proposed
 *                                                  catches nothing, see below
 *   5  the `rmdir` symlink refusal removed      -> same test, same deletion
 *   6  the `io()` wrapper removed from `rmdir`  -> 2 fail; the raw message was
 *                                                  "ENOTEMPTY: … rmdir '/private/var/…'"
 *   7  only the five methods declared           -> 3 surface tests
 *   8  `getUri` returns `file://…` like iOS     -> 5 fail, including the join
 *   9  an absent `directory` defaults to DATA   -> 5 fail, one per method
 *   10 the encoding passed through to Node      -> the ascii/utf16 test
 *   11 `rmdir` drops its isDirectory check      -> the rmdir-on-a-file test
 *   12 model root back outside the DATA root    -> 2 wiring tests (the ORIGINAL bug)
 *   13 DATA mapped to `userData` itself         -> the mapping test
 *   14 `createRoots()` deleted from boot        -> the boot test
 *   15 the plugin never registered              -> the registration test
 *   16 the roots no longer realpath'd           -> the resolution test
 *   17 the lexical gate replaced by `resolve`   -> 5 fail, the NUL-byte case on
 *                                                  each method (and ONLY that:
 *                                                  `confineRealPath` alone does
 *                                                  catch traversal and absolute
 *                                                  paths, so the lexical gate's
 *                                                  unique contribution here is
 *                                                  the NUL, and this says so
 *                                                  rather than overclaiming)
 *   18 the implementation reads its own env     -> the "no root of its own" test
 *   19 a refusal echoes the caller's path       -> the no-reflection test
 *   20 a refusal stops naming its method        -> 10 fail, one per refused method
 */

import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  FILESYSTEM_METHODS,
  FILESYSTEM_PLUGIN,
  PluginHost,
  createMainRouter,
} from '@chatterang/desktop/bridge';
import type { PluginImplementation } from '@chatterang/desktop/bridge';
import {
  FILESYSTEM_IMPLEMENTED,
  FILESYSTEM_REFUSED,
  createFilesystemPlugin,
} from '@chatterang/desktop/fs/filesystem';
import { confineRealPath } from '@chatterang/desktop/host/real-path';
import { confineModelPath } from '@chatterang/desktop/security';

const REPO = resolve(process.cwd());

/** Base64 of a string, the way `download.ts`'s `btoa` produces it. */
function b64(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}

/**
 * Invoke a plugin method the way `PluginHost` does — one options object.
 *
 * `async` so a SYNCHRONOUS throw (which is how the ten refusals fail) arrives
 * as a rejection, exactly as it does after crossing the bridge.
 */
async function call(
  implementation: PluginImplementation,
  method: string,
  options?: unknown,
): Promise<unknown> {
  const fn = implementation[method];
  if (fn === undefined) throw new Error(`the implementation has no "${method}"`);
  return (await fn(options)) as unknown;
}

interface Fixture {
  /** The realpath'd temporary base. Everything below it. */
  readonly base: string;
  /** The `DATA` root, containing `models/`. */
  readonly data: string;
  /** The `CACHE` root, a sibling of `data`. */
  readonly cache: string;
  /** A directory OUTSIDE both roots, holding a canary file. */
  readonly outside: string;
  readonly plugin: PluginImplementation;
}

let fixture: Fixture;

beforeEach(() => {
  // REALPATH'D, and that is not incidental: macOS's tmpdir is `/var/folders/…`,
  // a symlink to `/private/var`. Handing the plugin an unresolved root makes
  // `confineModelPath`'s lexical comparison disagree with `confineRealPath`'s
  // resolved one — which is the mismatch `main.ts:realDirectory` exists to
  // prevent, and which is demonstrated live in its own test below.
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'chatterang-fs-')));
  const data = join(base, 'files', 'data');
  const cache = join(base, 'files', 'cache');
  const outside = join(base, 'outside');
  mkdirSync(join(data, 'models'), { recursive: true });
  mkdirSync(cache, { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, 'canary.txt'), 'do not touch');
  fixture = {
    base,
    data,
    cache,
    outside,
    plugin: createFilesystemPlugin({
      roots: new Map([
        ['DATA', data],
        ['CACHE', cache],
      ]),
    }),
  };
});

afterEach(() => {
  rmSync(fixture.base, { recursive: true, force: true });
});

/* ── The declared surface ─────────────────────────────────────────────── */

describe('the declared surface is the real plugin surface, not a chosen subset', () => {
  /** Every method `FilesystemPlugin` declares, read from the package itself. */
  function declaredMembers(): string[] {
    const file = join(REPO, 'node_modules/@capacitor/filesystem/dist/esm/definitions.d.ts');
    const source = readFileSync(file, 'utf8');
    const at = source.indexOf('export interface FilesystemPlugin {');
    expect(at).toBeGreaterThan(0);
    const body = source.slice(at);
    const inner = body.slice(0, body.indexOf('\n}'));
    return [...inner.matchAll(/^ {4}([A-Za-z][A-Za-z0-9]*)\s*\(/gm)].map((m) => m[1] ?? '');
  }

  it('declares every INVOCABLE method the package declares — all fifteen', () => {
    /*
     * THE ASSERTION THAT KEEPS THE WHOLE REFUSAL PLAN HONEST.
     *
     * Declaring only the five we serve does NOT refuse the other ten. Read
     * `@capacitor/core/dist/index.js:88-107`: `createPluginMethod` looks the
     * method up in the plugin HEADER, and for one the header does not list it
     * falls to `else if (impl) return impl[prop].bind(impl)` — where `impl` is
     * the package's WEB implementation, because `loadPluginImplementation`
     * selects `'web'` whenever a custom platform is set, which ours always is.
     * An undeclared `readdir` therefore reaches IndexedDB and SUCCEEDS there:
     * the exact bug this plugin exists to close, quietly reinstated for ten
     * methods.
     *
     * Read from `definitions.d.ts` rather than copied, so a package upgrade
     * that adds a sixteenth method fails here instead of silently leaving one
     * door open.
     */
    const members = declaredMembers();
    expect(members).toHaveLength(17);
    // The bridge serves these two itself; `PluginHost.register` refuses a
    // plugin that declares either. See `LLAMA_METHODS`.
    const invocable = members.filter(
      (name) => name !== 'addListener' && name !== 'removeAllListeners',
    );
    expect([...FILESYSTEM_METHODS].sort()).toEqual([...invocable].sort());
    expect(FILESYSTEM_METHODS).toHaveLength(15);
  });

  it('partitions those fifteen into five implemented and ten refused', () => {
    expect(FILESYSTEM_IMPLEMENTED).toHaveLength(5);
    expect(FILESYSTEM_REFUSED).toHaveLength(10);
    const union = [...FILESYSTEM_IMPLEMENTED, ...FILESYSTEM_REFUSED].sort();
    expect(union).toEqual([...FILESYSTEM_METHODS].sort());
    // Disjoint: a name on both lists would be implemented and then overwritten
    // by its own refusal, which is a working method turning into a dead one.
    expect(new Set(union).size).toBe(15);
  });

  it('registers on the bridge, with fifteen channels and no events', () => {
    const host = new PluginHost(() => true);
    expect(() => host.register(FILESYSTEM_PLUGIN, fixture.plugin)).not.toThrow();
    const manifest = host.manifest();
    const declared = manifest.plugins.find((it) => it.name === 'Filesystem');
    expect(declared?.methods).toHaveLength(15);
    expect(declared?.events).toEqual([]);
    const channels = createMainRouter(host).channels();
    // Including the ones that only refuse: the channel has to exist for the
    // refusal to be reachable at all.
    expect(channels).toContain('chatterang:call:Filesystem:readdir');
    expect(channels).toContain('chatterang:call:Filesystem:writeFile');
  });

  it('refuses a listener rather than accepting one that can never fire', () => {
    // A BEHAVIOUR CHANGE, and an intended one. Registering a PluginHeader flips
    // the renderer proxy's `addListener` onto the bridge's native path, so the
    // deprecated `progress` event now reaches `PluginHost.addListener`. With
    // `events: []` it is refused by name instead of becoming a subscription
    // that silently never fires — which is what the web shim would have given.
    const host = new PluginHost(() => true);
    host.register(FILESYSTEM_PLUGIN, fixture.plugin);
    expect(() => host.addListener(1, 'Filesystem', 'progress', 1)).toThrow(/emits no event/);
  });
});

/* ── The five methods, against a real directory ───────────────────────── */

describe('the five implemented methods do real work on a real filesystem', () => {
  it('writeFile creates a file from base64 and getUri names it', async () => {
    const written = (await call(fixture.plugin, 'writeFile', {
      path: 'models/note.bin',
      directory: 'DATA',
      data: b64('hello bytes'),
    })) as { uri: string };
    const target = join(fixture.data, 'models', 'note.bin');
    expect(existsSync(target)).toBe(true);
    expect(readFileSync(target, 'utf8')).toBe('hello bytes');
    expect(written.uri).toBe(target);

    const { uri } = (await call(fixture.plugin, 'getUri', {
      path: 'models/note.bin',
      directory: 'DATA',
    })) as { uri: string };
    expect(uri).toBe(target);
  });

  it('writeFile TRUNCATES, which is what makes a retried download correct', async () => {
    /*
     * `download.ts:206` writes `data: ''` before its append loop, and that is
     * only a reset if this truncates. Opened with 'a' instead, a retried or
     * resumed download silently produces a DOUBLE-LENGTH file that then fails
     * GGUF magic at load — a failure that reads as a bad model rather than as a
     * bad write.
     */
    const path = 'models/retry.bin';
    await call(fixture.plugin, 'writeFile', { path, directory: 'DATA', data: b64('first pass') });
    await call(fixture.plugin, 'writeFile', { path, directory: 'DATA', data: '' });
    await call(fixture.plugin, 'appendFile', { path, directory: 'DATA', data: b64('second') });
    expect(readFileSync(join(fixture.data, path), 'utf8')).toBe('second');
  });

  it('appendFile concatenates byte-exactly, in the order it was called', async () => {
    const path = 'models/stream.bin';
    await call(fixture.plugin, 'writeFile', { path, directory: 'DATA', data: '' });
    for (const slice of ['alpha-', 'beta-', 'gamma']) {
      await call(fixture.plugin, 'appendFile', { path, directory: 'DATA', data: b64(slice) });
    }
    expect(readFileSync(join(fixture.data, path), 'utf8')).toBe('alpha-beta-gamma');
  });

  it('appendFile survives bytes that are not valid UTF-8', async () => {
    // The payload is a model, not text. A base64 round trip that went through a
    // string would corrupt every high byte, and the corruption would only show
    // up as a bad GGUF header, gigabytes later.
    const raw = Buffer.from([0x00, 0xff, 0x80, 0x7f, 0xc3, 0x28]);
    const path = 'models/binary.bin';
    await call(fixture.plugin, 'writeFile', { path, directory: 'DATA', data: '' });
    await call(fixture.plugin, 'appendFile', {
      path,
      directory: 'DATA',
      data: raw.toString('base64'),
    });
    expect([...readFileSync(join(fixture.data, path))]).toEqual([...raw]);
  });

  it('writeFile honours Encoding.UTF8, which is how export.ts calls it', async () => {
    // `src/lib/export.ts:59-64` — the transcript is text, not base64, and it
    // goes to the CACHE root with no `recursive`.
    await call(fixture.plugin, 'writeFile', {
      path: 'chat-2026-08-31.md',
      data: '# Conversation\n\nnon-ascii: こんにちは\n',
      directory: 'CACHE',
      encoding: 'utf8',
    });
    expect(readFileSync(join(fixture.cache, 'chat-2026-08-31.md'), 'utf8')).toBe(
      '# Conversation\n\nnon-ascii: こんにちは\n',
    );
  });

  it('mkdir creates the download directory, and refuses to create it twice', async () => {
    // `download.ts:197` passes `recursive: true` and swallows every error, so
    // the second refusal is invisible to it — which is why the contract's
    // "already exists" throw is safe to honour here. The web shim
    // (web.js:301) and iOS both throw even with `recursive`.
    await call(fixture.plugin, 'mkdir', {
      path: 'models/llama-cpp/gemma-3-4b',
      directory: 'DATA',
      recursive: true,
    });
    expect(existsSync(join(fixture.data, 'models/llama-cpp/gemma-3-4b'))).toBe(true);
    await expect(
      call(fixture.plugin, 'mkdir', {
        path: 'models/llama-cpp/gemma-3-4b',
        directory: 'DATA',
        recursive: true,
      }),
    ).rejects.toThrow(/already exists/);
  });

  it('mkdir without recursive refuses a missing parent', async () => {
    await expect(
      call(fixture.plugin, 'mkdir', { path: 'models/a/b/c', directory: 'DATA' }),
    ).rejects.toThrow(/parent directory to exist/);
    expect(existsSync(join(fixture.data, 'models/a'))).toBe(false);
  });

  it('writeFile refuses a missing parent unless asked to create it', async () => {
    await expect(
      call(fixture.plugin, 'writeFile', {
        path: 'models/nope/file.bin',
        directory: 'DATA',
        data: b64('x'),
      }),
    ).rejects.toThrow(/parent directory to exist/);
    await call(fixture.plugin, 'writeFile', {
      path: 'models/yes/file.bin',
      directory: 'DATA',
      data: b64('x'),
      recursive: true,
    });
    expect(readFileSync(join(fixture.data, 'models/yes/file.bin'), 'utf8')).toBe('x');
  });

  it('rmdir removes a model directory recursively, and refuses the non-recursive form', async () => {
    const dir = 'models/llama-cpp/gemma-3-4b';
    await call(fixture.plugin, 'mkdir', { path: dir, directory: 'DATA', recursive: true });
    await call(fixture.plugin, 'writeFile', {
      path: `${dir}/model.gguf`,
      directory: 'DATA',
      data: b64('weights'),
    });
    await expect(call(fixture.plugin, 'rmdir', { path: dir, directory: 'DATA' })).rejects.toThrow(
      /"rmdir" failed/,
    );
    expect(existsSync(join(fixture.data, dir))).toBe(true);

    await call(fixture.plugin, 'rmdir', { path: dir, directory: 'DATA', recursive: true });
    expect(existsSync(join(fixture.data, dir))).toBe(false);
    // The engine directory above it survives: `deleteModelFiles` deletes one
    // model, not one engine's worth.
    expect(existsSync(join(fixture.data, 'models/llama-cpp'))).toBe(true);
  });

  it('rmdir refuses a file, so it cannot be used as a delete primitive', async () => {
    await call(fixture.plugin, 'writeFile', {
      path: 'models/a-file.bin',
      directory: 'DATA',
      data: b64('x'),
    });
    await expect(
      call(fixture.plugin, 'rmdir', {
        path: 'models/a-file.bin',
        directory: 'DATA',
        recursive: true,
      }),
    ).rejects.toThrow(/not a directory/);
    expect(existsSync(join(fixture.data, 'models/a-file.bin'))).toBe(true);
  });

  it('getUri answers for a path that does not exist yet', async () => {
    // The web shim does (`entry?.path || path`), and the downloader asks before
    // anything is on disk.
    const { uri } = (await call(fixture.plugin, 'getUri', {
      path: 'models/not-yet/model.gguf',
      directory: 'DATA',
    })) as { uri: string };
    expect(uri).toBe(join(fixture.data, 'models/not-yet/model.gguf'));
    expect(existsSync(uri)).toBe(false);
  });
});

/* ── Data validation ──────────────────────────────────────────────────── */

describe('the base64 contract is enforced rather than assumed', () => {
  it('refuses data that is not valid base64, instead of writing it short', async () => {
    /*
     * `Buffer.from(s,'base64')` silently DISCARDS invalid characters — it does
     * not throw — so without an explicit check the plugin writes truncated
     * garbage where the contract (definitions.d.ts:139-147) says an error will
     * be thrown. Measured, and asserted here so the premise is not folklore:
     * `Buffer.from('not base64!!','base64')` yields bytes rather than failing.
     */
    expect(Buffer.from('not base64!!', 'base64').length).toBeGreaterThan(0);
    await expect(
      call(fixture.plugin, 'writeFile', {
        path: 'models/bad.bin',
        directory: 'DATA',
        data: 'not base64!!',
      }),
    ).rejects.toThrow(/not valid base64/);
    expect(existsSync(join(fixture.data, 'models/bad.bin'))).toBe(false);
  });

  it('accepts the empty string, which is how a download starts', async () => {
    await call(fixture.plugin, 'writeFile', {
      path: 'models/empty.bin',
      directory: 'DATA',
      data: '',
    });
    expect(readFileSync(join(fixture.data, 'models/empty.bin'))).toHaveLength(0);
  });

  it('does NOT strip a data: prefix, unlike the web shim', async () => {
    // web.js:201 splits on the first comma before validating; native does not,
    // and neither consumer sends one. Silently splitting would turn
    // `data:text/plain,hello` into a five-byte file rather than an error.
    await expect(
      call(fixture.plugin, 'writeFile', {
        path: 'models/prefixed.bin',
        directory: 'DATA',
        data: `data:application/octet-stream;base64,${b64('hello')}`,
      }),
    ).rejects.toThrow(/not valid base64/);
  });

  it('refuses a non-string data, naming Blob as web-only', async () => {
    await expect(
      call(fixture.plugin, 'writeFile', {
        path: 'models/blob.bin',
        directory: 'DATA',
        data: { size: 1 },
      }),
    ).rejects.toThrow(/Blob is web-only/);
  });

  it('refuses ascii and utf16 by name rather than handing them to Node', async () => {
    // `utf16` is not a Node encoding at all — Node spells it `utf16le` — so a
    // pass-through would throw an opaque "Unknown encoding" from somewhere that
    // does not name this boundary. Both are declared Android-only.
    for (const encoding of ['ascii', 'utf16']) {
      await expect(
        call(fixture.plugin, 'writeFile', {
          path: 'models/enc.txt',
          directory: 'DATA',
          data: 'plain',
          encoding,
        }),
      ).rejects.toThrow(new RegExp(`cannot use encoding "${encoding}"`));
    }
    expect(existsSync(join(fixture.data, 'models/enc.txt'))).toBe(false);
  });
});

/* ── Confinement ──────────────────────────────────────────────────────── */

/** What each method needs beyond `path`/`directory`, so all five drive alike. */
const EXTRA: Record<string, Record<string, unknown>> = {
  writeFile: { data: '' },
  appendFile: { data: '' },
  mkdir: { recursive: true },
  rmdir: { recursive: true },
  getUri: {},
};

describe('confinement refuses every escape, on every method', () => {
  const CASES: [string, string][] = [
    ['a traversal', '../../../escape.txt'],
    ['a traversal through the root', 'models/../../../escape.txt'],
    ['an absolute path outside the root', '/etc/passwd'],
    ['an absolute path just past the root', '/tmp/../etc/passwd'],
    ['an empty path', ''],
    // A NUL cannot escape the root by itself, but it makes the path we
    // validate differ from the path the OS opens, because the C
    // representation stops at the NUL. A guard whose answer describes a
    // different file than the one that gets opened is not a guard.
    ['a NUL byte', 'models/model.gguf\u0000.txt'],
  ];

  for (const method of FILESYSTEM_IMPLEMENTED) {
    for (const [label, path] of CASES) {
      it(`${method} refuses ${label}`, async () => {
        await expect(
          call(fixture.plugin, method, { path, directory: 'DATA', ...EXTRA[method] }),
        ).rejects.toThrow(/must name a path inside/);
      });
    }

    it(`${method} refuses a SYMLINK out of the root`, async () => {
      /*
       * The case `confineModelPath` alone cannot see: a link INSIDE the root
       * whose target is outside it passes every lexical check and the
       * filesystem then follows it. `confineRealPath` resolves the deepest
       * EXISTING ancestor, so this is caught even when the leaf does not exist
       * yet — which is precisely the downloader's situation.
       *
       * The canary assertions are the half that matters: a guard that throws
       * and writes anyway is a guard that reads as working and is not.
       */
      symlinkSync(fixture.outside, join(fixture.data, 'bridge'));
      await expect(
        call(fixture.plugin, method, {
          path: 'bridge/escaped.bin',
          directory: 'DATA',
          ...EXTRA[method],
        }),
      ).rejects.toThrow(/must name a path inside/);
      expect(readdirSync(fixture.outside).sort()).toEqual(['canary.txt']);
      expect(readFileSync(join(fixture.outside, 'canary.txt'), 'utf8')).toBe('do not touch');
    });

    it(`${method} refuses the root itself`, async () => {
      // `confineRealPath` is strictly-inside, so no method can target a root.
      // That is what lets the roots be created once at boot and never touched.
      for (const path of ['.', './', '/']) {
        await expect(
          call(fixture.plugin, method, { path, directory: 'DATA', ...EXTRA[method] }),
        ).rejects.toThrow(/must name a path inside/);
      }
      expect(existsSync(fixture.data)).toBe(true);
    });

    it(`${method} refuses an absent directory rather than defaulting`, async () => {
      // Optional on four of the five in the Capacitor type. Native resolves a
      // directory-less path as an absolute file URL — the arbitrary-path oracle
      // defect [8] closed — and there is no safe default root to pick.
      await expect(
        call(fixture.plugin, method, { path: 'models/x.bin', ...EXTRA[method] }),
      ).rejects.toThrow(/needs a "directory"/);
    });

    it(`${method} refuses the seven unmapped Directory values, by name`, async () => {
      for (const directory of [
        'DOCUMENTS',
        'LIBRARY',
        'EXTERNAL',
        'EXTERNAL_STORAGE',
        'EXTERNAL_CACHE',
        'LIBRARY_NO_CLOUD',
        'TEMPORARY',
      ]) {
        await expect(
          call(fixture.plugin, method, { path: 'x.bin', directory, ...EXTRA[method] }),
        ).rejects.toThrow(new RegExp(`cannot use directory "${directory}"`));
      }
    });
  }

  it('rmdir refuses a symlink at the leaf, even one pointing INSIDE the root', async () => {
    /*
     * THE ONE GENUINELY DANGEROUS INTERACTION, and the one the obvious guard
     * misses.
     *
     * `confineRealPath` RESOLVES the final component. So `rmdir({path:'shortcut',
     * recursive:true})`, where `<data>/shortcut` points at `<data>/models`,
     * hands `fs.rm` the resolved TARGET: every model deleted, and the link
     * still sitting there. Node's recursive `rm` does not follow symlinks among
     * the CHILDREN it walks, but the top-level path it is given has already
     * been realpath'd — that is the gap.
     *
     * Checking whether the CONFINED path is a symlink catches nothing: it is
     * realpath'd and therefore never one. The check has to be on the LEXICAL
     * path, which is why the implementation returns both.
     */
    mkdirSync(join(fixture.data, 'models', 'llama-cpp'), { recursive: true });
    writeFileSync(join(fixture.data, 'models', 'llama-cpp', 'model.gguf'), 'weights');
    symlinkSync(join(fixture.data, 'models'), join(fixture.data, 'shortcut'));

    // The error is CAPTURED rather than asserted with `rejects.toThrow`, so
    // that the survival assertions still run when the refusal is missing.
    // Otherwise the first injection stops the test at the throw and the
    // deletion — the thing that actually matters — is never checked.
    let message = '';
    try {
      await call(fixture.plugin, 'rmdir', { path: 'shortcut', directory: 'DATA', recursive: true });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(existsSync(join(fixture.data, 'models', 'llama-cpp', 'model.gguf'))).toBe(true);
    expect(readdirSync(join(fixture.data, 'models'))).toEqual(['llama-cpp']);
    expect(message).toMatch(/will not remove a symbolic link/);
  });

  it('rmdir refuses a symlink whose target is outside the root, and leaves it alone', async () => {
    symlinkSync(fixture.outside, join(fixture.data, 'bridge'));
    await expect(
      call(fixture.plugin, 'rmdir', { path: 'bridge', directory: 'DATA', recursive: true }),
    ).rejects.toThrow();
    expect(readdirSync(fixture.outside).sort()).toEqual(['canary.txt']);
  });

  it('refusals never echo the caller path or the root back to the page', async () => {
    // The caller is a web page. A reflected path is one more piece of the
    // filesystem confirmed to it — the same reasoning as `model-paths.ts:29-32`
    // — and a raw Node ENOENT/ENOTEMPTY message carries the FULL absolute path,
    // which `toWireError` would forward verbatim.
    const secret = 'sekrit-path-component';
    const messages: string[] = [];
    for (const method of FILESYSTEM_IMPLEMENTED) {
      for (const options of [
        { path: `../${secret}`, directory: 'DATA' },
        { path: `models/${secret}`, directory: 'DOCUMENTS' },
        { path: `models/${secret}`, directory: 'DATA' },
        { path: `models/${secret}`, directory: 'DATA', recursive: false },
      ]) {
        try {
          await call(fixture.plugin, method, { ...EXTRA[method], ...options });
        } catch (error) {
          messages.push((error as Error).message);
        }
      }
    }
    expect(messages.length).toBeGreaterThan(0);
    for (const message of messages) {
      expect(message).not.toContain(secret);
      expect(message).not.toContain(fixture.base);
      expect(message).not.toContain(realpathSync(tmpdir()));
    }
  });

  it('a non-empty rmdir does not leak the path through Node errno text', async () => {
    // The specific message that used to escape: "ENOTEMPTY: directory not
    // empty, rmdir '/private/var/folders/…'".
    const dir = 'models/full';
    await call(fixture.plugin, 'mkdir', { path: dir, directory: 'DATA', recursive: true });
    await call(fixture.plugin, 'writeFile', {
      path: `${dir}/a.bin`,
      directory: 'DATA',
      data: b64('a'),
    });
    let message = '';
    try {
      await call(fixture.plugin, 'rmdir', { path: dir, directory: 'DATA' });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/"rmdir" failed \(ENOTEMPTY\)/);
    expect(message).not.toContain(fixture.base);
  });
});

/* ── Two roots ───────────────────────────────────────────────────────── */

describe('a dangling symlink is not an absent file', () => {
  /*
   * The hole this plugin turned from theory into a write primitive.
   *
   * `confineRealPath` walks up to the deepest EXISTING ancestor so a download
   * target that does not exist yet is still allowed. A symlink whose target is
   * absent makes `realpath` throw, so it looked absent — and the walk handed
   * back a path inside the root that `open` follows OUT of it. Verified before
   * the fix: `<root>/innocent.gguf -> <tmp>/ARBITRARY-WRITE-TARGET.txt` with
   * the target missing, then a write that created that file outside the root.
   */
  it('writeFile refuses a dangling symlink at the leaf', async () => {
    const outside = join(fixture.outside, 'ARBITRARY-WRITE-TARGET.txt');
    symlinkSync(outside, join(fixture.data, 'innocent.gguf'));

    await expect(
      call(fixture.plugin, 'writeFile', {
        path: 'innocent.gguf',
        directory: 'DATA',
        data: b64('PWNED'),
      }),
    ).rejects.toThrow();
    expect(existsSync(outside)).toBe(false);
  });

  it('appendFile refuses one too', async () => {
    const outside = join(fixture.outside, 'APPEND-TARGET.txt');
    symlinkSync(outside, join(fixture.data, 'append-me.bin'));

    await expect(
      call(fixture.plugin, 'appendFile', {
        path: 'append-me.bin',
        directory: 'DATA',
        data: b64('PWNED'),
      }),
    ).rejects.toThrow();
    expect(existsSync(outside)).toBe(false);
  });

  it('still accepts a symlink whose target is inside the root', async () => {
    // The fix must not refuse every symlink: one that resolves inside is fine,
    // and refusing it would be a false positive that breaks legitimate layouts.
    writeFileSync(join(fixture.data, 'real.bin'), 'x');
    symlinkSync(join(fixture.data, 'real.bin'), join(fixture.data, 'alias.bin'));

    const { uri } = (await call(fixture.plugin, 'getUri', {
      path: 'alias.bin',
      directory: 'DATA',
    })) as { uri: string };
    expect(uri).toBe(join(fixture.data, 'real.bin'));
  });
});

describe('a real download slice, at the size download.ts actually sends', () => {
  it('appendFile accepts a 4 MiB slice without blowing the stack', async () => {
    /*
     * `download.ts` slices a model into 4 MiB blobs, which is a 5,592,408
     * character base64 string. The first validator here was
     * /^(?:[A-Za-z0-9+\/]{4})*.../ — catastrophic on an input that long:
     * testing one threw `RangeError: Maximum call stack size exceeded`, so no
     * model in the catalogue could finish downloading. Every unit test passed,
     * because every unit test used a short string.
     */
    const slice = Buffer.alloc(4 * 1024 * 1024).toString('base64');
    expect(slice.length).toBe(5_592_408);

    await call(fixture.plugin, 'writeFile', {
      path: 'models/big.gguf',
      directory: 'DATA',
      data: '',
    });
    await call(fixture.plugin, 'appendFile', {
      path: 'models/big.gguf',
      directory: 'DATA',
      data: slice,
    });

    expect(statSync(join(fixture.data, 'models', 'big.gguf')).size).toBe(4 * 1024 * 1024);
  });
});

describe('Directory.Data and Directory.Cache are different roots', () => {
  it('writes the same path into two different places', async () => {
    // Not a formality: `export.ts` writes to CACHE and `download.ts` to DATA,
    // and a single-root implementation would have put a transcript into the
    // model directory — inside the folder the inference host is confined to.
    await call(fixture.plugin, 'writeFile', {
      path: 'same-name.txt',
      directory: 'DATA',
      data: 'from data',
      encoding: 'utf8',
    });
    await call(fixture.plugin, 'writeFile', {
      path: 'same-name.txt',
      directory: 'CACHE',
      data: 'from cache',
      encoding: 'utf8',
    });
    expect(readFileSync(join(fixture.data, 'same-name.txt'), 'utf8')).toBe('from data');
    expect(readFileSync(join(fixture.cache, 'same-name.txt'), 'utf8')).toBe('from cache');

    const dataUri = (await call(fixture.plugin, 'getUri', {
      path: 'same-name.txt',
      directory: 'DATA',
    })) as { uri: string };
    const cacheUri = (await call(fixture.plugin, 'getUri', {
      path: 'same-name.txt',
      directory: 'CACHE',
    })) as { uri: string };
    expect(dataUri.uri).not.toBe(cacheUri.uri);
  });

  it('cannot reach the CACHE root through a DATA traversal', async () => {
    // They are siblings, so `../cache/x` is a real escape attempt rather than a
    // hypothetical one.
    await expect(
      call(fixture.plugin, 'writeFile', {
        path: '../cache/sneak.txt',
        directory: 'DATA',
        data: 'x',
        encoding: 'utf8',
      }),
    ).rejects.toThrow(/must name a path inside/);
    expect(existsSync(join(fixture.cache, 'sneak.txt'))).toBe(false);
  });
});

/* ── The join with the model guard ────────────────────────────────────── */

describe('getUri returns a path the inference host will accept', () => {
  it('survives confineModelPath and confineRealPath UNCHANGED', async () => {
    /*
     * THE JOIN THAT DID NOT EXIST. `download.ts:218` stores this string as the
     * model's path, `state/models.ts` persists it, and `LlamaCpp.load` is then
     * handed it — where `modelPathGuard` runs `confineModelPath` and then
     * `confineRealPath` against the host's model root.
     *
     * Pinned as the PROPERTY rather than as a string shape, because the shape
     * is not what matters. What matters is that the guard accepts it and does
     * not rewrite it: a `file:///…` string — which is what iOS
     * (`url.absoluteString`) and Android return here — would `resolve()` to
     * `<modelRoot>/file:/…` and be refused. Desktop diverges from native
     * deliberately, and this is the test that says so.
     */
    const modelRoot = join(fixture.data, 'models');
    await call(fixture.plugin, 'mkdir', {
      path: 'models/llama-cpp/gemma-3-4b',
      directory: 'DATA',
      recursive: true,
    });
    await call(fixture.plugin, 'writeFile', {
      path: 'models/llama-cpp/gemma-3-4b/model.gguf',
      directory: 'DATA',
      data: b64('GGUF'),
    });
    const { uri } = (await call(fixture.plugin, 'getUri', {
      path: 'models/llama-cpp/gemma-3-4b/model.gguf',
      directory: 'DATA',
    })) as { uri: string };

    const lexical = confineModelPath(modelRoot, uri);
    expect(lexical).not.toBeNull();
    expect(confineRealPath(modelRoot, lexical as string)).toBe(uri);
    expect(readFileSync(uri, 'utf8')).toBe('GGUF');
  });

  it('still refuses a DATA path that is outside the model root', async () => {
    // The guard is still a guard: `Directory.Data` is WIDER than the model
    // root, so a transcript in the DATA root must not become loadable.
    const modelRoot = join(fixture.data, 'models');
    await call(fixture.plugin, 'writeFile', {
      path: 'notes.txt',
      directory: 'DATA',
      data: 'x',
      encoding: 'utf8',
    });
    const { uri } = (await call(fixture.plugin, 'getUri', {
      path: 'notes.txt',
      directory: 'DATA',
    })) as { uri: string };
    expect(confineModelPath(modelRoot, uri)).toBeNull();
  });

  it('needs the roots resolved, which is why main.ts realpaths them', async () => {
    /*
     * THE MISMATCH `realDirectory` EXISTS FOR, demonstrated rather than
     * asserted. `confineModelPath` is purely lexical and compares against
     * whatever root string it was handed; `getUri` answers with a realpath'd
     * one. Hand the guard an UNRESOLVED root whose ancestor is a symlink and
     * the two spellings disagree, so every path the downloader stored is
     * refused at load — with nothing on either side looking wrong.
     *
     * The same shape as macOS's own tmpdir, `/var/folders/…`, which is a
     * symlink to `/private/var`.
     */
    const shadow = join(fixture.base, 'shadow');
    symlinkSync(join(fixture.base, 'files'), shadow);
    const unresolvedData = join(shadow, 'data');
    const plugin = createFilesystemPlugin({ roots: new Map([['DATA', unresolvedData]]) });
    const { uri } = (await call(plugin, 'getUri', {
      path: 'models/m.gguf',
      directory: 'DATA',
    })) as { uri: string };

    // The plugin itself is correct either way — it resolves.
    expect(uri).toBe(join(fixture.data, 'models', 'm.gguf'));
    // But a guard handed the UNRESOLVED root refuses what the plugin returned…
    expect(confineModelPath(join(unresolvedData, 'models'), uri)).toBeNull();
    // …and the same guard handed the RESOLVED root accepts it.
    expect(confineModelPath(join(fixture.data, 'models'), uri)).not.toBeNull();
  });
});

/* ── The ten refusals ─────────────────────────────────────────────────── */

describe('the ten unimplemented methods refuse by name, and touch nothing', () => {
  for (const method of FILESYSTEM_REFUSED) {
    it(`${method} throws, naming itself and the closed set`, async () => {
      await expect(
        call(fixture.plugin, method, { path: 'models/x.bin', directory: 'DATA' }),
      ).rejects.toThrow(new RegExp(`"${method}" is not implemented on this platform`));
      // And says what IS implemented, so the message is actionable rather than
      // just a wall.
      await expect(
        call(fixture.plugin, method, { path: 'models/x.bin', directory: 'DATA' }),
      ).rejects.toThrow(/appendFile, getUri, mkdir, rmdir, writeFile/);
    });
  }

  it('never fabricates a result, and never reaches the disk', async () => {
    // The house rule `synthesize` and `diffuse` in packages/onnx-node already
    // follow: refuse rather than invent output. A fake `readdir` answering `[]`
    // would read as "the model is not downloaded" forever.
    writeFileSync(join(fixture.data, 'present.txt'), 'still here');
    for (const method of FILESYSTEM_REFUSED) {
      await expect(
        call(fixture.plugin, method, { path: 'present.txt', directory: 'DATA' }),
      ).rejects.toThrow();
    }
    expect(readFileSync(join(fixture.data, 'present.txt'), 'utf8')).toBe('still here');
  });

  it('checkPermissions refuses rather than answering granted — a decision, not an omission', async () => {
    // Both the web shim and iOS answer `{publicStorage:'granted'}`, and on
    // desktop that is TRUE. Refusing is the choice because nothing in `src/`
    // calls either, and this pins it so the choice is visible if reversed.
    await expect(call(fixture.plugin, 'checkPermissions')).rejects.toThrow(/not implemented/);
    await expect(call(fixture.plugin, 'requestPermissions')).rejects.toThrow(/not implemented/);
  });
});

/* ── A root that does not exist ───────────────────────────────────────── */

describe('a missing root refuses everything, which is why main creates them at boot', () => {
  it('refuses every method while the root is absent, and works once it exists', async () => {
    /*
     * `confineRealPath` starts with `realpathSync(modelRoot)` and returns null
     * when that throws (real-path.ts:49-56), so a root that does not exist
     * refuses EVERY path under it — INCLUDING the `mkdir` that would have
     * created it. That is the whole reason boot has to create the roots: the
     * model root was previously created lazily by a downloader that was writing
     * somewhere else, so it never appeared on disk at all, and `export.ts`
     * calls no `mkdir` for the cache root ever.
     */
    const absent = join(fixture.base, 'never-created');
    const plugin = createFilesystemPlugin({ roots: new Map([['DATA', absent]]) });
    for (const method of FILESYSTEM_IMPLEMENTED) {
      await expect(
        call(plugin, method, { path: 'models/x.bin', directory: 'DATA', ...EXTRA[method] }),
      ).rejects.toThrow(/must name a path inside/);
    }
    // Not even the directory it is being asked to make.
    expect(existsSync(absent)).toBe(false);

    mkdirSync(absent, { recursive: true });
    await call(plugin, 'mkdir', { path: 'models', directory: 'DATA', recursive: true });
    expect(existsSync(join(absent, 'models'))).toBe(true);
  });
});

/* ── The wiring, pinned as text ───────────────────────────────────────── */

describe('main.ts wires the filesystem the way this file was tested', () => {
  // `main.ts` cannot be imported by any test — `protocol.registerSchemes
  // Privileged` and `app.whenReady()` run at module scope — so the wiring is
  // pinned as source text, the same way the rest of it is in
  // `tests/desktop-security.test.ts`.
  const source = readFileSync(join(REPO, 'apps/desktop/src/main.ts'), 'utf8');

  /**
   * The same text with comments removed, for the NEGATIVE assertions.
   *
   * A lexical scan of a file this heavily commented matches its own prose:
   * `main.ts` explains why `app.getPath('cache')` must NOT be a root, and
   * `not.toContain("getPath('cache')")` failed on that explanation. Both
   * failures were exactly this. `tests/layering.test.ts` records the same trap
   * — a text search there flagged a comment saying why a module is not
   * imported.
   *
   * Block comments and comment-only lines only; it does not parse, so a `/*`
   * inside a string literal would confuse it. Neither file has one.
   */
  function code(text: string): string {
    return text
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('//'))
      .join('\n');
  }

  const mainCode = code(source);
  const implementation = code(
    readFileSync(join(REPO, 'apps/desktop/src/fs/filesystem.ts'), 'utf8'),
  );

  it('registers the plugin with INJECTED roots', () => {
    expect(source).toContain(
      'pluginHost.register(FILESYSTEM_PLUGIN, createFilesystemPlugin({ roots }))',
    );
    expect(source).toMatch(/const roots = filesystemRoots\(\);/);
  });

  it('keeps the implementation free of Electron and of any root of its own', () => {
    // This is the property that makes the file testable against a tmpdir AND
    // liftable into a package the moment A9 has a second consumer. A single
    // `app.getPath` here would be a root guessed where no test can see it.
    expect(implementation).not.toContain('getPath(');
    expect(implementation).not.toMatch(/from 'electron'/);
    expect(implementation).not.toContain('process.env');
  });

  it('creates every root at boot, before anything can ask for one', () => {
    expect(source).toMatch(/function createRoots\(\): void \{/);
    expect(source).toMatch(/^\s*createRoots\(\);$/m);
    expect(source).toMatch(/mkdirSync\(directory, \{ recursive: true \}\)/);
    // All three: the two mapped roots AND the model directory inside DATA.
    expect(source).toMatch(/\[dataRoot\(\), cacheRoot\(\), join\(dataRoot\(\), MODEL_DIR\)\]/);
  });

  it('maps DATA and CACHE only, and neither to a directory Chromium or the user owns', () => {
    expect(source).toMatch(/\['DATA', realDirectory\(dataRoot\(\)\)\]/);
    expect(source).toMatch(/\['CACHE', realDirectory\(cacheRoot\(\)\)\]/);
    // The roots are in a subtree of our own, not `userData` itself — which
    // holds Cookies, Local Storage, Session Storage, IndexedDB, Preferences,
    // Local State and Trust Tokens, all of them verified present on this
    // machine and all of them writable through `writeFile` if DATA were
    // mapped there.
    expect(source).toMatch(/function dataRoot\(\): string \{\n\s*return join\(filesRoot\(\), 'data'\);/);
    expect(source).toMatch(/function cacheRoot\(\): string \{\n\s*return join\(filesRoot\(\), 'cache'\);/);
    // `app.getPath('cache')` is ~/Library/Caches and `app.getPath('documents')`
    // is the user's own Documents folder — verified live on this machine.
    // Neither may become a mapped root.
    expect(mainCode).not.toContain("getPath('cache')");
    expect(mainCode).not.toContain("getPath('documents')");
    // And nothing but `userData`, so a new root cannot appear from a directory
    // Electron picked.
    expect([...mainCode.matchAll(/getPath\('([a-zA-Z]+)'\)/g)].map((m) => m[1])).toEqual([
      'userData',
    ]);
    // Exactly two entries in the map.
    const mapped = [...source.matchAll(/\['([A-Z_]+)', realDirectory\(/g)].map((m) => m[1]);
    expect(mapped.sort()).toEqual(['CACHE', 'DATA']);
  });

  it('keeps the model root INSIDE the DATA root, which is what makes the join work', () => {
    expect(source).toMatch(
      /function modelRoot\(\): string \{\n\s*return realDirectory\(join\(dataRoot\(\), MODEL_DIR\)\);/,
    );
    expect(source).toMatch(/const MODEL_DIR = 'models';/);
    // Still forked with the model root and the engine name — the pin
    // `tests/desktop-security.test.ts` also holds.
    expect(source).toMatch(/\[modelRoot\(\),\s*engineName\]/);
  });

  it('resolves the roots, so the lexical guard and the resolved one agree', () => {
    expect(source).toMatch(/function realDirectory\(directory: string\): string \{/);
    expect(source).toContain('realpathSync(directory)');
  });
});

/* ── The source is in git ─────────────────────────────────────────────── */

describe('the new source is tracked', () => {
  it('has fs/filesystem.ts and this test in git', () => {
    // `.gitignore` once carried an unanchored `models/` rule that hid four
    // source files from git while every test stayed green. `fs/` is a short,
    // generic directory name of exactly the kind a broad ignore rule catches,
    // so it is checked directly rather than trusted.
    const tracked = execFileSync(
      'git',
      ['ls-files', '--cached', '--others', '--exclude-standard'],
      { cwd: REPO, encoding: 'utf8' },
    )
      .split('\n')
      .filter(Boolean);
    expect(tracked).toContain('apps/desktop/src/fs/filesystem.ts');
    expect(tracked).toContain('tests/desktop-filesystem.test.ts');
  });
});
