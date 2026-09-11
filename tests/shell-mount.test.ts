// @vitest-environment node
import { describe, expect, it } from 'vitest';

import {
  MOUNT_ROOT,
  MountEscapeError,
  MountReadOnlyError,
  isInside,
  mountReal,
  realPathWithin,
  resolveGrant,
  type RealFsPort,
} from '@/shell/mount';

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

/**
 * A fake real filesystem with symlinks, so the escapes are real rather than
 * asserted. `links` maps a path to what it resolves to; `realpath` walks them
 * the way the kernel does, so a test cannot pass because the fake forgot.
 */
function fakePort(options: {
  files?: Record<string, string>;
  dirs?: readonly string[];
  links?: Record<string, string>;
}): RealFsPort & { written: Record<string, string> } {
  const files = { ...options.files };
  const dirs = new Set(options.dirs ?? []);
  const links = options.links ?? {};
  const written: Record<string, string> = {};

  const resolve = (path: string): string => {
    // Resolve every ancestor, longest first, the way a real lookup does.
    const parts = path.split('/').filter(Boolean);
    let current = '';
    for (const part of parts) {
      current = `${current}/${part}`;
      const link = links[current];
      if (link) current = link;
    }
    return current || '/';
  };

  const exists = (path: string) => path in files || dirs.has(path);

  return {
    written,
    realpath: async (path) => {
      const resolved = resolve(path);
      if (!exists(resolved)) throw new Error(`ENOENT: ${path}`);
      return resolved;
    },
    stat: async (path) => {
      if (!exists(path)) throw new Error(`ENOENT: ${path}`);
      return { isDirectory: dirs.has(path), size: (files[path] ?? '').length, mtimeMs: 0 };
    },
    readFile: async (path) => {
      const content = files[path];
      if (content === undefined) throw new Error(`ENOENT: ${path}`);
      return content;
    },
    readdir: async (path) =>
      Object.keys(files)
        .filter((file) => file.startsWith(`${path}/`))
        .map((file) => file.slice(path.length + 1).split('/')[0]!),
    writeFile: async (path, content) => {
      written[path] = content;
      files[path] = content;
    },
    mkdir: async (path) => {
      dirs.add(path);
    },
    rm: async (path) => {
      delete files[path];
    },
  };
}

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
    };
  }

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
    const { mount } = await mountNotes({}, true);
    const inner = { ...innerFs(), chmod: async (_path: string) => undefined };
    const fs = mountReal(inner, [mount]) as typeof inner;

    await expect(fs.chmod('/mnt/notes/a.md')).rejects.toThrow(MountReadOnlyError);
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

    await expect(fs.cp('/workspace/x', '/mnt/notes/y')).rejects.toThrow(MountReadOnlyError);
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
