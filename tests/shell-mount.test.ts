// @vitest-environment node
import { describe, expect, it } from 'vitest';

import {
  MOUNT_ROOT,
  MountEscapeError,
  MountReadOnlyError,
  MountUnsupportedError,
  isInside,
  mountReal,
  realPathWithin,
  resolveGrant,
  type ResolvedMount,
} from '@/shell/mount';

import { fakePort } from './support/fake-real-fs';

/**
 * #246. A granted folder is a promise that nothing outside it is reachable,
 * and the string the caller asks for is not where the bytes are: `..` walks
 * out before any syscall, a symlink is followed by an operating system that
 * has never heard of our root, and the root itself may be a symlink.
 *
 * Every escape below is paired with the same shape succeeding inside the root,
 * so none of these can pass by refusing everything — which is the failure mode
 * a containment check actually has.
 */

const NOTES = {
  dirs: ['/home/me', '/home/me/notes', '/home/me/notes/sub'],
  files: {
    '/home/me/notes/a.md': 'inside',
    '/home/me/notes/sub/b.md': 'deeper',
    '/home/me/.ssh/id_ed25519': 'PRIVATE KEY',
    '/home/me/notes-secret/x.md': 'sibling',
  },
};

async function mountNotes(overrides: Parameters<typeof fakePort>[0] = {}, writable = false) {
  const port = fakePort({
    ...NOTES,
    ...overrides,
    dirs: [...(NOTES.dirs ?? []), ...(overrides.dirs ?? [])],
    files: { ...NOTES.files, ...overrides.files },
  });
  const mount = await resolveGrant({ name: 'notes', root: '/home/me/notes', writable }, port);
  expect(mount, 'the grant should resolve').not.toBeNull();
  return { mount: mount!, port };
}

/** A minimal stand-in for just-bash's in-memory fs. */
function innerFs() {
  const calls: string[] = [];
  return {
    calls,
    readFile: async (path: string) => {
      calls.push(`readFile ${path}`);
      return 'in-memory';
    },
    writeFile: async (path: string, _content?: string) => {
      calls.push(`writeFile ${path}`);
    },
    realpath: async (path: string) => path,
    readdir: async () => [],
    // Present because the PROXY ONLY WRAPS METHODS THE INNER OBJECT HAS —
    // `Reflect.get` of a missing name is `undefined` and is handed back
    // untouched. A fake missing a method makes the routing test for it vacuous
    // rather than failing, which is the shape this repo keeps re-learning.
    stat: async (path: string) => {
      calls.push(`stat ${path}`);
      return { isFile: true, isDirectory: false, isSymbolicLink: false, mode: 0, size: 0 };
    },
    lstat: async (path: string) => {
      calls.push(`lstat ${path}`);
      return { isFile: true, isDirectory: false, isSymbolicLink: false, mode: 0, size: 0 };
    },
    readlink: async (path: string) => {
      calls.push(`readlink ${path}`);
      return path;
    },
  };
}

describe('isInside', () => {
  it('requires a separator boundary', () => {
    // The classic miss: /a/b is not inside /a/bc, and a bare startsWith says
    // it is. This is exactly how a sibling folder becomes reachable.
    expect(isInside('/home/me/notes', '/home/me/notes')).toBe(true);
    expect(isInside('/home/me/notes', '/home/me/notes/a.md')).toBe(true);
    expect(isInside('/home/me/notes', '/home/me/notes-secret/x.md')).toBe(false);
    expect(isInside('/home/me/notes', '/home/me')).toBe(false);
  });
});

describe('what a granted folder reaches', () => {
  it('resolves a path inside the root', async () => {
    // The control. A check that refuses everything passes every escape test
    // below and is useless.
    const { mount } = await mountNotes();
    expect(await realPathWithin(mount, '/mnt/notes/a.md')).toBe('/home/me/notes/a.md');
    expect(await realPathWithin(mount, '/mnt/notes/sub/b.md')).toBe('/home/me/notes/sub/b.md');
  });

  it('resolves a file that does not exist yet, via its parent', async () => {
    // A write to a new file has nothing of its own to resolve; its parent
    // does, and a parent outside the root is an escape regardless.
    const { mount } = await mountNotes();
    expect(await realPathWithin(mount, '/mnt/notes/sub/new.md')).toBe('/home/me/notes/sub/new.md');
  });

  it('refuses `..` that walks out of the root', async () => {
    const { mount } = await mountNotes();
    await expect(realPathWithin(mount, '/mnt/notes/../../etc/passwd')).rejects.toThrow(
      MountEscapeError,
    );
  });

  it('refuses a SYMLINK inside the folder pointing outside it', async () => {
    /*
     * The case this module exists for. The virtual path is innocent, the
     * string never leaves the root, and the kernel hands back a private key.
     * Only resolving on the real side catches it.
     */
    const { mount } = await mountNotes({
      links: { '/home/me/notes/escape': '/home/me/.ssh' },
      dirs: ['/home/me/.ssh'],
    });
    await expect(realPathWithin(mount, '/mnt/notes/escape/id_ed25519')).rejects.toThrow(
      MountEscapeError,
    );
  });

  it('refuses a sibling whose name merely begins with the root', async () => {
    const { mount } = await mountNotes({
      links: { '/home/me/notes/sneak': '/home/me/notes-secret' },
      dirs: ['/home/me/notes-secret'],
    });
    await expect(realPathWithin(mount, '/mnt/notes/sneak/x.md')).rejects.toThrow(MountEscapeError);
  });

  it('resolves the root itself, so a granted symlink is compared as its target', async () => {
    /*
     * The user picks `/home/me/shortcut`, which is a link to the real folder.
     * Checking against the string they picked would compare every later path
     * against a place the kernel does not agree exists.
     */
    const port = fakePort({
      ...NOTES,
      links: { '/home/me/shortcut': '/home/me/notes' },
    });
    const mount = await resolveGrant(
      { name: 'notes', root: '/home/me/shortcut', writable: false },
      port,
    );
    expect(mount?.realRoot).toBe('/home/me/notes');
    expect(await realPathWithin(mount!, '/mnt/notes/a.md')).toBe('/home/me/notes/a.md');
  });

  it('refuses a grant whose root does not resolve, rather than mounting it unchecked', async () => {
    const port = fakePort(NOTES);
    expect(await resolveGrant({ name: 'x', root: '/nope', writable: false }, port)).toBeNull();
    // And a file is not a folder.
    expect(
      await resolveGrant({ name: 'x', root: '/home/me/notes/a.md', writable: false }, port),
    ).toBeNull();
  });
});

describe('the mounted filesystem', () => {
  it('leaves every path outside /mnt to the in-memory filesystem', async () => {
    const { mount } = await mountNotes();
    const inner = innerFs();
    const fs = mountReal(inner, [mount]) as typeof inner;

    expect(await fs.readFile('/workspace/scratch.txt')).toBe('in-memory');
    expect(await fs.readFile('/chats/a.md')).toBe('in-memory');
    expect(inner.calls).toEqual(['readFile /workspace/scratch.txt', 'readFile /chats/a.md']);
  });

  it('reads a mounted path from the real side', async () => {
    const { mount } = await mountNotes();
    const inner = innerFs();
    const fs = mountReal(inner, [mount]) as typeof inner;

    expect(await fs.readFile('/mnt/notes/a.md')).toBe('inside');
    // And it did not touch the in-memory filesystem on the way.
    expect(inner.calls).toEqual([]);
  });

  it('refuses a write to a read-only grant', async () => {
    const { mount, port } = await mountNotes();
    const fs = mountReal(innerFs(), [mount]) as ReturnType<typeof innerFs>;

    await expect(fs.writeFile('/mnt/notes/a.md', 'changed')).rejects.toThrow(MountReadOnlyError);
    expect(port.written).toEqual({});
  });

  it('allows a write to a writable grant, and still contains it', async () => {
    // The control for the refusal above: read-only is a property of the grant,
    // not a module that cannot write at all.
    const { mount, port } = await mountNotes({}, true);
    const fs = mountReal(innerFs(), [mount]) as ReturnType<typeof innerFs>;

    await fs.writeFile('/mnt/notes/sub/new.md', 'written');
    expect(port.written['/home/me/notes/sub/new.md']).toBe('written');
  });

  it('refuses a write through a symlink even when the grant is writable', async () => {
    const { mount, port } = await mountNotes(
      { links: { '/home/me/notes/escape': '/home/me/.ssh' }, dirs: ['/home/me/.ssh'] },
      true,
    );
    const fs = mountReal(innerFs(), [mount]) as ReturnType<typeof innerFs>;

    await expect(fs.writeFile('/mnt/notes/escape/authorized_keys', 'x')).rejects.toThrow(
      MountEscapeError,
    );
    expect(port.written).toEqual({});
  });

  it('reports the VIRTUAL path from realpath, not the host path', async () => {
    /*
     * Handing the shell an absolute host path would leak where the folder
     * lives into every error message and `pwd` — and would let a later call
     * address it directly, outside the mount and outside every check here.
     */
    const { mount } = await mountNotes();
    const fs = mountReal(innerFs(), [mount]) as ReturnType<typeof innerFs>;

    expect(await fs.realpath('/mnt/notes/a.md')).toBe('/mnt/notes/a.md');
  });

  it('refuses an operation it has not thought about, rather than forwarding it', async () => {
    // A closed switch, so `just-bash` growing a method is a refusal here and
    // not a silent new capability on the user's disk.
    //
    // ENOSYS, not EROFS: the grant here is WRITABLE, so "this folder was
    // granted for reading" would be a false explanation sending whoever read
    // it to the grant instead of to the missing case. Four real READS used to
    // fail with exactly that wrong error.
    const { mount } = await mountNotes({}, true);
    const inner = { ...innerFs(), chmod: async (_path: string) => undefined };
    const fs = mountReal(inner, [mount]) as typeof inner;

    await expect(fs.chmod('/mnt/notes/a.md')).rejects.toThrow(MountUnsupportedError);
  });

  it('refuses a two-path operation where the mount is not the first argument', async () => {
    /*
     * The blind spot: `cp('/workspace/x', '/mnt/notes/y')` checked only
     * args[0], found no mount, and passed through to the IN-MEMORY filesystem
     * — writing a shadow at a path that reads route to the real side. The
     * write appeared to succeed and the file was never there.
     */
    const { mount, port } = await mountNotes({}, true);
    const inner = { ...innerFs(), cp: async (_from: string, _to: string) => undefined };
    const fs = mountReal(inner, [mount]) as typeof inner;

    await expect(fs.cp('/workspace/x', '/mnt/notes/y')).rejects.toThrow(MountUnsupportedError);
    // Neither side was touched: not the real one, and not the in-memory shadow.
    expect(port.written).toEqual({});
    expect(inner.calls).toEqual([]);
  });

  it('refuses a two-path operation out of the mount as well', async () => {
    // The other direction: copying a granted file into scratch space is an
    // export the grant did not authorise, and it is refused for the same
    // reason rather than by accident.
    const { mount } = await mountNotes({}, true);
    const inner = { ...innerFs(), cp: async (_from: string, _to: string) => undefined };
    const fs = mountReal(inner, [mount]) as typeof inner;

    await expect(fs.cp('/mnt/notes/a.md', '/workspace/leak.md')).rejects.toThrow();
    expect(inner.calls).toEqual([]);
  });

  it('is a no-op with no grants, so the unmounted shell is byte-identical', async () => {
    const inner = innerFs();
    expect(mountReal(inner, [])).toBe(inner);
  });

  it('leaves an unmatched /mnt path to the in-memory filesystem', async () => {
    // `/mnt/other` is not a mount; it is just a path. Special-casing it would
    // make "no such grant" and "escape" indistinguishable.
    const { mount } = await mountNotes();
    const inner = innerFs();
    const fs = mountReal(inner, [mount]) as typeof inner;

    expect(await fs.readFile('/mnt/other/x')).toBe('in-memory');
    expect(MOUNT_ROOT).toBe('/mnt');
  });
});

describe('a live mount table', () => {
  /**
   * These pin the two properties the supplier form exists for, and the one it
   * broke on the way in.
   */

  it('sees a folder granted after the filesystem was built', async () => {
    const { mount } = await mountNotes({ files: { '/home/me/notes/a.md': 'hello' } });
    let table: ResolvedMount[] = [];
    const inner = innerFs();
    const fs = mountReal(inner, () => table) as typeof inner;

    // Before the grant: an ordinary unknown path, answered in memory.
    expect(await fs.readFile('/mnt/notes/a.md')).toBe('in-memory');
    table = [mount];
    expect(await fs.readFile('/mnt/notes/a.md')).toBe('hello');
  });

  it('stops answering for a folder that was withdrawn', async () => {
    // The half that matters: a grant the user took back must stop working
    // without waiting for anything to be rebuilt.
    const { mount } = await mountNotes({ files: { '/home/me/notes/a.md': 'hello' } });
    let table: ResolvedMount[] = [mount];
    const inner = innerFs();
    const fs = mountReal(inner, () => table) as typeof inner;

    expect(await fs.readFile('/mnt/notes/a.md')).toBe('hello');
    table = [];
    expect(await fs.readFile('/mnt/notes/a.md')).toBe('in-memory');
  });

  it('does not turn a synchronous inner method into a promise', async () => {
    /**
     * THE BUG THIS PINS, found by `tests/shell.test.ts` and invisible here
     * until now: the proxy used to be `async`, so wrapping the filesystem made
     * every method return a Promise — including the ones `just-bash`
     * implements synchronously. That was harmless only while `mountReal`
     * returned the filesystem unwrapped for an empty table, which a LIVE table
     * cannot do. Twenty-five shell tests went red; every write to /workspace
     * failed.
     *
     * The fake port in this file is all-async, so nothing above can see it.
     * This asserts the shape directly instead.
     */
    const { mount } = await mountNotes();
    const inner = {
      ...innerFs(),
      // A synchronous method, like the ones a real filesystem has.
      resolvePathSync: (path: string): string => path,
    };

    for (const table of [() => [] as ResolvedMount[], () => [mount]]) {
      const fs = mountReal(inner, table) as typeof inner;
      const answer = fs.resolvePathSync('/workspace/x') as unknown;
      expect(answer, 'a passthrough call must keep its own shape').toBe('/workspace/x');
      expect(answer).not.toBeInstanceOf(Promise);
    }
  });

  it('still refuses by rejecting rather than throwing synchronously', async () => {
    // The control for the change above: making the wrapper synchronous must
    // not make a refusal arrive at a different place than an I/O failure does.
    const { mount } = await mountNotes();
    const inner = innerFs();
    const fs = mountReal(inner, () => [mount]) as typeof inner;

    let returned: unknown;
    expect(() => {
      returned = fs.writeFile('/mnt/notes/a.md', 'x');
    }).not.toThrow();
    await expect(returned).rejects.toThrow(MountReadOnlyError);
  });
});

describe('the properties a passing mutation would have hidden', () => {
  /**
   * Every assertion here was written after a deliberate break in the wired
   * code went UNNOTICED by the rest of this file. A guard nothing fails for is
   * not a guard; these are the failures.
   */

  it('refuses a grant whose name is not one segment under /mnt', async () => {
    /*
     * `normalizePath('/mnt/..')` is `/`, so a grant named `..` would have a
     * `virtualRoot` of `/` — and `mountFor` would then hand it EVERY path in
     * the virtual tree, `/chats` included. The projection writes there.
     */
    const port = fakePort(NOTES);
    for (const name of ['..', '.', '', '/', 'a/b', '../../etc', 'x'.repeat(65), '-leading-dash']) {
      expect(
        await resolveGrant({ name, root: '/home/me/notes', writable: false }, port),
        `accepted the name ${JSON.stringify(name)}`,
      ).toBeNull();
    }
    // The control: ordinary names still resolve, so this is not refusing all.
    for (const name of ['notes', 'my-notes', 'notes.2', 'a_b', 'x'.repeat(64)]) {
      expect(
        await resolveGrant({ name, root: '/home/me/notes', writable: false }, port),
        `refused the name ${JSON.stringify(name)}`,
      ).not.toBeNull();
    }
  });

  it('keeps the host path out of an escape error’s message', async () => {
    /*
     * `message` is what `just-bash` prints to stderr — read by the user and by
     * the model. The resolution is where a SYMLINK pointed, which is a
     * location outside the grant. Interpolating it made every refusal a
     * working `readlink` for anything the folder happened to point at, and
     * contradicted this module's own reason for `realpath` answering with the
     * virtual path.
     */
    const { mount } = await mountNotes({
      links: { '/home/me/notes/escape': '/home/me/.ssh' },
      dirs: ['/home/me/.ssh'],
    });

    const error = await realPathWithin(mount, '/mnt/notes/escape/id_ed25519').catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(MountEscapeError);
    const escape = error as MountEscapeError;
    expect(escape.message).not.toContain('/home/me');
    expect(escape.message).toContain('/mnt/notes/escape');
    // Kept as a FIELD, because app-side logging may want it. A field is not
    // printed by accident; a message is printed by definition.
    expect(escape.resolved).toContain('/home/me');
  });

  it('never routes resolvePath, whichever argument the mount is in', async () => {
    /*
     * `resolvePath(base, path)` is synchronous string arithmetic. Routing it
     * broke the feature two ways at once: it returned the BASE and dropped the
     * path, and with both arguments scanned, `resolvePath('/', '/mnt/notes')`
     * was refused as a cross-filesystem operation — so no absolute access to a
     * mount could work from a cwd outside it. `ls /mnt/notes` was impossible.
     */
    const { mount } = await mountNotes();
    const inner = {
      ...innerFs(),
      resolvePath: (base: string, path: string): string =>
        path.startsWith('/') ? path : `${base}/${path}`,
    };
    const fs = mountReal(inner, () => [mount]) as typeof inner;

    for (const [base, path] of [
      ['/', '/mnt/notes'],
      ['/mnt/notes', 'sub'],
      ['/mnt/notes', '/mnt/notes/a.md'],
      ['/workspace', '/mnt/notes/a.md'],
    ] as const) {
      const answer = fs.resolvePath(base, path) as unknown;
      expect(answer, `resolvePath(${base}, ${path}) returned a promise`).not.toBeInstanceOf(Promise);
      expect(answer).toBe(path.startsWith('/') ? path : `${base}/${path}`);
    }
  });

  it('refuses a byte write rather than writing the decimal spelling of the bytes', async () => {
    /*
     * `String(new Uint8Array([104, 105]))` is `"104,105"`. The port carries
     * text, so a byte write used to succeed, report exit 0, and leave
     * `104,105` in the user's real file.
     */
    const { mount, port } = await mountNotes({}, true);
    const inner = innerFs();
    const fs = mountReal(inner, () => [mount]) as typeof inner & {
      writeFile(path: string, content: unknown): Promise<void>;
    };

    await expect(
      fs.writeFile('/mnt/notes/a.md', new Uint8Array([104, 105])),
    ).rejects.toThrow(MountUnsupportedError);
    expect(port.written).toEqual({});

    // The control: text still writes.
    await fs.writeFile('/mnt/notes/a.md', 'hi');
    expect(port.written['/home/me/notes/a.md']).toBe('hi');
  });

  it('refuses an unfamiliar method that was handed a mounted path, and passes one that was not', async () => {
    /*
     * The other half of the closed switch. A method `PATH_ARGS` has never
     * heard of must not reach the in-memory filesystem for a `/mnt` path: it
     * would write a SHADOW at a path whose reads route to the real side, so
     * the write appears to succeed and the file is never there.
     *
     * Thrown synchronously, because an unknown method may be either sync or
     * async and a rejected promise from a sync method is a value nobody
     * checks.
     */
    const { mount } = await mountNotes({}, true);
    const inner = {
      ...innerFs(),
      truncateAt: (path: string, _length: number): string => {
        inner.calls.push(`truncateAt ${path}`);
        return path;
      },
    };
    const fs = mountReal(inner, () => [mount]) as typeof inner;

    expect(() => fs.truncateAt('/mnt/notes/a.md', 0)).toThrow(MountUnsupportedError);
    expect(inner.calls).toEqual([]);

    // The control: outside a mount it is forwarded, with its own shape.
    expect(fs.truncateAt('/workspace/x', 0)).toBe('/workspace/x');
    expect(inner.calls).toEqual(['truncateAt /workspace/x']);
  });
});

describe('the two methods whose whole value is what they refuse to follow', () => {
  it('answers lstat about the LINK and stat about its target', async () => {
    /*
     * Dispatching `lstat` to `port.stat` passes every other test in this file
     * and quietly removes the distinction the method exists for — a symlink
     * would report as whatever it points at, which is how `ls -l` stops being
     * able to show you that something is a link at all.
     */
    const { mount } = await mountNotes({
      links: { '/home/me/notes/here': '/home/me/notes/a.md' },
    });
    const fs = mountReal(innerFs(), () => [mount]) as {
      stat(path: string): Promise<{ isSymbolicLink: boolean; isFile: boolean }>;
      lstat(path: string): Promise<{ isSymbolicLink: boolean; isFile: boolean }>;
    };

    const followed = await fs.stat('/mnt/notes/here');
    expect(followed.isSymbolicLink).toBe(false);
    expect(followed.isFile).toBe(true);

    const itself = await fs.lstat('/mnt/notes/here');
    expect(itself.isSymbolicLink).toBe(true);
    expect(itself.isFile).toBe(false);
  });

  it('refuses readlink, because a link’s target is not ours to report', async () => {
    /*
     * A POLICY, not a gap. `readlink`'s answer is where a link points, and for
     * the links that matter that is a path OUTSIDE the granted folder —
     * exactly the location `MountEscapeError` goes out of its way to keep out
     * of a message. Answering it would hand the caller that path directly.
     */
    const { mount } = await mountNotes({
      links: {
        '/home/me/notes/escape': '/home/me/.ssh',
        '/home/me/notes/here': '/home/me/notes/a.md',
      },
      dirs: ['/home/me/.ssh'],
    });
    const fs = mountReal(innerFs(), () => [mount]) as { readlink(path: string): Promise<string> };

    // A link that stays INSIDE the grant: resolution succeeds, so this is the
    // policy refusing rather than containment refusing incidentally.
    const inside = await fs.readlink('/mnt/notes/here').catch((caught: unknown) => caught);
    expect(inside).toBeInstanceOf(MountUnsupportedError);
    expect((inside as Error).message).not.toContain('/home/me');

    // A link pointing OUT never even reaches the policy — containment refuses
    // it first. Both are refusals, and neither names where it pointed.
    const outward = await fs.readlink('/mnt/notes/escape').catch((caught: unknown) => caught);
    expect(outward).toBeInstanceOf(MountEscapeError);
    expect((outward as Error).message).not.toContain('/home/me');
  });
});
