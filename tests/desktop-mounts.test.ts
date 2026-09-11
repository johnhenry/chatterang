/**
 * `MountHost` — the folder the user granted, and the disk it does not reach.
 *
 * THE DIFFERENCE FROM `tests/shell-mount.test.ts`, and why both exist. That
 * file drives `src/shell/mount.ts` against a FAKE port whose `realpath` walks
 * a map of links the test wrote. It proves the routing logic is right about
 * the answers it is given. It cannot prove anything about a real kernel,
 * because there isn't one — and containment here is entirely a claim about
 * what the kernel does with a path.
 *
 * So this file makes real directories, real symlinks and real files in a real
 * tmpdir, and asks the real implementation. Where the two disagree, this one
 * is right.
 *
 * Every escape below is paired with the same SHAPE succeeding inside the
 * grant, because a confinement that refuses everything passes every escape
 * test ever written and is the failure mode this one actually has.
 *
 * EIGHT FAULTS INJECTED, one at a time, each into the wired code and each
 * reverted. Every one produced a non-zero exit. What each broke, as MEASURED
 * rather than as predicted:
 *
 *   1  `locate` prefix-matches the string instead of resolving  -> 6 fail: the
 *        symlink out, the symlinked parent, the dangling link, the prefix
 *        sibling, the symlinked root, and `realpath`. NOT the `..` test —
 *        `resolve()` collapses `..` lexically before the comparison, so a
 *        prefix check does catch that one. Said plainly rather than claimed,
 *        the same way `real-path.ts` says the lexical gate's unique
 *        contribution is the NUL byte.
 *   2  `allowRoot` passed as false          -> 3 fail, every `readdir`/`stat`
 *        of the mount point itself
 *   3  the `writable` check dropped         -> 2 fail (the read-only grant, and
 *        the nested outer grant)
 *   4  `pick` stores `picked.root` unresolved -> 1 fail, the symlinked-root
 *        test, and ONLY that: the fixture `realpath`s the tmpdir up front, so
 *        no other test can tell. On macOS in the wild it is every path, since
 *        `/var/folders/…` is a link to `/private/var` — which is exactly why
 *        that one test exists.
 *   5  `pick` trusts `picked.writable` over the request -> the ceiling test
 *   6  `io()` removed from `readFile`       -> the no-reflection test
 *   7  `locate` takes the FIRST match, not the longest -> the nested-grant test
 *   8  the `maxGrants` bound removed        -> the bound test
 */

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MOUNT_METHODS, MOUNT_PLUGIN } from '../apps/desktop/src/bridge/protocol.js';
import { createMountPlugin, mountNameFor } from '../apps/desktop/src/fs/mounts.js';
import type { PickedFolder } from '../apps/desktop/src/fs/mounts.js';

let sandbox: string;
/** What the next `pick` answers with. A test sets this instead of clicking. */
let chooser: PickedFolder | null;
let chooserCalls: { writable: boolean }[];

function plugin(maxGrants?: number) {
  return createMountPlugin({
    pick: async (options) => {
      chooserCalls.push(options);
      return chooser;
    },
    ...(maxGrants === undefined ? {} : { maxGrants }),
  }) as unknown as Record<string, (input?: unknown) => Promise<any>>;
}

beforeEach(() => {
  // `realpathSync`, because on macOS this is `/var/folders/…` — itself a
  // symlink to `/private/var`. Fault 4 is the whole reason: an implementation
  // that stores the unresolved spelling refuses every path inside the folder
  // it just granted, and only a resolved fixture can tell.
  sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'chatterang-mounts-')));
  chooser = null;
  chooserCalls = [];

  mkdirSync(join(sandbox, 'notes/sub'), { recursive: true });
  mkdirSync(join(sandbox, 'notes-secret'), { recursive: true });
  mkdirSync(join(sandbox, 'private'), { recursive: true });
  writeFileSync(join(sandbox, 'notes/a.md'), 'inside the grant');
  writeFileSync(join(sandbox, 'notes/sub/b.md'), 'deeper');
  writeFileSync(join(sandbox, 'notes-secret/x.md'), 'the prefix sibling');
  writeFileSync(join(sandbox, 'private/key'), 'PRIVATE KEY');
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

/** Grant `<sandbox>/notes` and hand back the plugin holding it. */
async function granted(writable = false, api = plugin()) {
  chooser = { root: join(sandbox, 'notes'), writable };
  const info = await api['pick']!({ writable });
  expect(info, 'the grant should have been made').not.toBeNull();
  return { api, info: info as { id: string; name: string; root: string; writable: boolean } };
}

describe('granting is the only way a root comes into existence', () => {
  it('has no grants, and therefore reaches nothing, until someone picks', async () => {
    const api = plugin();
    expect((await api['list']!()).grants).toEqual([]);
    await expect(api['readFile']!({ path: join(sandbox, 'notes/a.md') })).rejects.toThrow(
      /not inside a folder you granted/,
    );
  });

  it('takes the root from the chooser and never from the caller', async () => {
    // The renderer names paths on every other method. It cannot name THIS
    // one: `pick` ignores its input except for the writable request, so a
    // prompt-injected `mount('/')` has nowhere to put the '/'.
    const api = plugin();
    chooser = { root: join(sandbox, 'notes'), writable: false };
    const info = await api['pick']!({ root: '/', path: '/', writable: false });
    expect(info.root).toBe(join(sandbox, 'notes'));
    // And '/' is still unreachable afterwards.
    await expect(api['readdir']!({ path: '/' })).rejects.toThrow(/not inside a folder/);
  });

  it('answers null when the person cancels, and grants nothing', async () => {
    const api = plugin();
    chooser = null;
    expect(await api['pick']!({ writable: false })).toBeNull();
    expect((await api['list']!()).grants).toEqual([]);
  });

  it('refuses a chooser answer that cannot be resolved', async () => {
    const api = plugin();
    chooser = { root: join(sandbox, 'no-such-folder'), writable: false };
    await expect(api['pick']!({ writable: false })).rejects.toThrow(/could not be resolved/);
    expect((await api['list']!()).grants).toEqual([]);
  });

  it('grants no more than was asked, and no more than was offered', async () => {
    const api = plugin();

    // Asked for read; the chooser offers write anyway. The request is the
    // ceiling: a renderer that asked to read must not be handed a writable
    // folder it never told the user about.
    chooser = { root: join(sandbox, 'notes'), writable: true };
    const readOnly = await api['pick']!({ writable: false });
    expect(readOnly.writable).toBe(false);
    expect(chooserCalls.at(-1)).toEqual({ writable: false });

    // Asked for write; the person said read-only. The answer is the floor.
    chooser = { root: join(sandbox, 'private'), writable: false };
    const refused = await api['pick']!({ writable: true });
    expect(refused.writable).toBe(false);
  });

  it('bounds how many folders can be granted at once', async () => {
    const api = plugin(2);
    chooser = { root: join(sandbox, 'notes'), writable: false };
    await api['pick']!({});
    chooser = { root: join(sandbox, 'private'), writable: false };
    await api['pick']!({});
    chooser = { root: join(sandbox, 'notes-secret'), writable: false };
    await expect(api['pick']!({})).rejects.toThrow(/already granted/);
  });

  it('withdraws a grant, and says so honestly the second time', async () => {
    const { api, info } = await granted();
    expect(await api['readFile']!({ path: join(sandbox, 'notes/a.md') })).toEqual({
      data: 'inside the grant',
    });

    expect(await api['revoke']!({ id: info.id })).toEqual({ revoked: true });
    // Withdrawn means unreachable IMMEDIATELY, not at the next rebuild.
    await expect(api['readFile']!({ path: join(sandbox, 'notes/a.md') })).rejects.toThrow(
      /not inside a folder you granted/,
    );
    expect(await api['revoke']!({ id: info.id })).toEqual({ revoked: false });
    expect(await api['revoke']!({ id: 'never-granted' })).toEqual({ revoked: false });
  });
});

describe('containment, against a real kernel', () => {
  it('reads inside the grant — the control every refusal below needs', async () => {
    const { api } = await granted();
    expect(await api['readFile']!({ path: join(sandbox, 'notes/a.md') })).toEqual({
      data: 'inside the grant',
    });
    expect(await api['readFile']!({ path: join(sandbox, 'notes/sub/b.md') })).toEqual({
      data: 'deeper',
    });
    expect((await api['readdir']!({ path: join(sandbox, 'notes') })).entries.sort()).toEqual([
      'a.md',
      'sub',
    ]);
  });

  it('lists the granted folder itself', async () => {
    // `allowRoot`. The model directory's rule is "the root is a directory,
    // never a model"; a mount's root is the first thing anyone reads, and
    // refusing it would make the mount point the one unreachable path in it.
    const { api } = await granted();
    expect((await api['stat']!({ path: join(sandbox, 'notes') })).isDirectory).toBe(true);
  });

  it('refuses `..` out of the grant', async () => {
    const { api } = await granted();
    await expect(
      api['readFile']!({ path: join(sandbox, 'notes/../private/key') }),
    ).rejects.toThrow(/not inside a folder you granted/);
  });

  it('refuses a REAL symlink pointing out of the grant', async () => {
    /*
     * The one the issue names first, and the one a string check cannot catch:
     * the path is spelled entirely inside the granted folder, and the kernel
     * follows it out. The link is real and so is the file it points at.
     */
    symlinkSync(join(sandbox, 'private/key'), join(sandbox, 'notes/escape'));
    // The control: without confinement this is exactly what would be read.
    expect(readFileSync(join(sandbox, 'notes/escape'), 'utf8')).toBe('PRIVATE KEY');

    const { api } = await granted();
    await expect(api['readFile']!({ path: join(sandbox, 'notes/escape') })).rejects.toThrow(
      /not inside a folder you granted/,
    );
    // And it does not leak where the link pointed.
    await expect(api['readFile']!({ path: join(sandbox, 'notes/escape') })).rejects.toThrow(
      /^(?!.*private\/key)/,
    );
  });

  it('refuses a path under a symlinked PARENT, with the leaf absent', async () => {
    // The downloader's case, in reverse: the leaf does not exist, so a naive
    // `realpath` throws and a naive implementation treats the path as "not
    // there yet" and writes through the link.
    symlinkSync(join(sandbox, 'private'), join(sandbox, 'notes/door'));
    const { api } = await granted(true);
    await expect(
      api['writeFile']!({ path: join(sandbox, 'notes/door/planted'), data: 'x' }),
    ).rejects.toThrow(/not inside a folder you granted/);
  });

  it('refuses a DANGLING symlink rather than treating it as absent', async () => {
    // `real-path.ts` records finding this by testing: a dangling link treated
    // as a missing file hands back a path inside the root that `open` follows
    // out of it — an arbitrary write with a write primitive behind it.
    symlinkSync(join(sandbox, 'private/not-yet'), join(sandbox, 'notes/pending'));
    const { api } = await granted(true);
    await expect(
      api['writeFile']!({ path: join(sandbox, 'notes/pending'), data: 'x' }),
    ).rejects.toThrow(/not inside a folder you granted/);
  });

  it('refuses the prefix sibling', async () => {
    // `<sandbox>/notes` is a string prefix of `<sandbox>/notes-secret`.
    const { api } = await granted();
    await expect(
      api['readFile']!({ path: join(sandbox, 'notes-secret/x.md') }),
    ).rejects.toThrow(/not inside a folder you granted/);
  });

  it('resolves a grant whose ROOT is itself a symlink', async () => {
    // The person picked `link-to-notes`; the chooser may hand back either
    // spelling. Both must reach the same folder and neither must reach past
    // it — a root stored unresolved refuses everything inside itself.
    symlinkSync(join(sandbox, 'notes'), join(sandbox, 'via-link'));
    const api = plugin();
    chooser = { root: join(sandbox, 'via-link'), writable: false };
    const info = await api['pick']!({});
    expect(info.root).toBe(join(sandbox, 'notes'));

    expect(await api['readFile']!({ path: join(sandbox, 'via-link/a.md') })).toEqual({
      data: 'inside the grant',
    });
    await expect(api['readFile']!({ path: join(sandbox, 'private/key') })).rejects.toThrow();
  });

  it('refuses a path with a NUL byte before any syscall', async () => {
    const { api } = await granted();
    await expect(
      api['readFile']!({ path: `${join(sandbox, 'notes/a.md')}\0.png` }),
    ).rejects.toThrow(/not inside a folder you granted/);
  });

  it('refuses a path that is not a string, and one that is empty', async () => {
    const { api } = await granted();
    for (const path of [undefined, null, 42, {}, [], '']) {
      await expect(api['stat']!({ path }), `accepted ${JSON.stringify(path)}`).rejects.toThrow(
        /not inside a folder you granted/,
      );
    }
  });

  it('answers realpath with the real path, and only inside the grant', async () => {
    const { api } = await granted();
    symlinkSync(join(sandbox, 'notes/sub'), join(sandbox, 'notes/shortcut'));
    expect(await api['realpath']!({ path: join(sandbox, 'notes/shortcut/b.md') })).toEqual({
      path: join(sandbox, 'notes/sub/b.md'),
    });
  });
});

describe('read-only is the default, and it is enforced', () => {
  it('refuses every write against a read-only grant', async () => {
    const { api } = await granted(false);
    const target = join(sandbox, 'notes/new.md');
    await expect(api['writeFile']!({ path: target, data: 'x' })).rejects.toThrow(
      /granted for reading only/,
    );
    await expect(api['mkdir']!({ path: join(sandbox, 'notes/dir') })).rejects.toThrow(
      /granted for reading only/,
    );
    await expect(api['rm']!({ path: join(sandbox, 'notes/a.md') })).rejects.toThrow(
      /granted for reading only/,
    );
    // Nothing happened: the refusal is not a message in front of a write.
    expect(readFileSync(join(sandbox, 'notes/a.md'), 'utf8')).toBe('inside the grant');
  });

  it('performs the same writes against a writable grant', async () => {
    // The paired control. Without it every assertion above passes on an
    // implementation that refuses everything.
    const { api } = await granted(true);
    await api['writeFile']!({ path: join(sandbox, 'notes/new.md'), data: 'written' });
    expect(readFileSync(join(sandbox, 'notes/new.md'), 'utf8')).toBe('written');
    await api['mkdir']!({ path: join(sandbox, 'notes/dir') });
    await api['rm']!({ path: join(sandbox, 'notes/new.md') });
    expect((await api['readdir']!({ path: join(sandbox, 'notes') })).entries).toContain('dir');
  });

  it('refuses a non-string payload rather than writing "[object Object]"', async () => {
    const { api } = await granted(true);
    await expect(
      api['writeFile']!({ path: join(sandbox, 'notes/a.md'), data: { toString: () => 'x' } }),
    ).rejects.toThrow(/UTF-8 string/);
    expect(readFileSync(join(sandbox, 'notes/a.md'), 'utf8')).toBe('inside the grant');
  });
});

describe('nested grants resolve to the most specific one', () => {
  it('does not let an outer read-only grant shadow an inner writable one', async () => {
    // Two clicks produce this, and the answer must not depend on their order.
    for (const order of [0, 1] as const) {
      const api = plugin();
      const picks = [
        { root: sandbox, writable: false },
        { root: join(sandbox, 'notes'), writable: true },
      ];
      for (const pick of order === 0 ? picks : [...picks].reverse()) {
        chooser = pick;
        await api['pick']!({ writable: pick.writable });
      }

      const target = join(sandbox, `notes/nested-${order}.md`);
      await api['writeFile']!({ path: target, data: 'ok' });
      expect(readFileSync(target, 'utf8'), `order ${order}`).toBe('ok');

      // And the outer grant still covers what only it contains — read-only.
      expect(await api['readFile']!({ path: join(sandbox, 'private/key') })).toEqual({
        data: 'PRIVATE KEY',
      });
      await expect(
        api['writeFile']!({ path: join(sandbox, 'private/key'), data: 'overwritten' }),
      ).rejects.toThrow(/granted for reading only/);
    }
  });
});

describe('what a refusal is allowed to say', () => {
  it('does not echo a syscall message, which carries the path', async () => {
    const { api } = await granted();
    await expect(api['readFile']!({ path: join(sandbox, 'notes/absent.md') })).rejects.toThrow(
      /The path is not echoed back/,
    );
    await expect(api['readFile']!({ path: join(sandbox, 'notes/absent.md') })).rejects.toThrow(
      /ENOENT\)/,
    );
  });

  it('refuses an over-long path without quoting it back', async () => {
    const { api } = await granted();
    await expect(api['stat']!({ path: `/${'a'.repeat(600)}` })).rejects.toThrow(
      /"path" is not|is not inside a folder you granted/,
    );
  });
});

describe('mount names', () => {
  it('slugs a folder name into one path segment', () => {
    expect(mountNameFor('/home/me/Notes', new Set())).toBe('notes');
    expect(mountNameFor('/home/me/My Project (v2)', new Set())).toBe('my-project-v2');
    // A name made entirely of punctuation would slug to '' and produce
    // `/mnt/`, which is not a path.
    expect(mountNameFor('/home/me/...', new Set())).toBe('folder');
  });

  it('deduplicates without producing a name that needs quoting', () => {
    expect(mountNameFor('/a/notes', new Set(['notes']))).toBe('notes-2');
    expect(mountNameFor('/a/notes', new Set(['notes', 'notes-2']))).toBe('notes-3');
  });
});

describe('the declared surface', () => {
  it('implements every method it declares, and declares every one it has', async () => {
    // `PluginHost.register` refuses a declared method the implementation does
    // not have, so a missing one is a boot failure — but an EXTRA one is not,
    // and an undeclared method is unreachable rather than loudly absent.
    const api = plugin();
    expect([...MOUNT_METHODS].sort()).toEqual(Object.keys(api).sort());
    expect(MOUNT_PLUGIN.name).toBe('MountHost');
    expect(MOUNT_PLUGIN.events).toEqual([]);
  });
});

describe('lstat answers about the link, without following it', () => {
  it('reports a symlink as a symlink, even one pointing out of the grant', async () => {
    /*
     * `stat` resolves and therefore refuses a link pointing out — correctly.
     * `lstat` must not, or `ls -l` of an ordinary folder holding one stale
     * `node_modules/.bin` entry fails entirely. Confining the PARENT and
     * leaving the final component alone is both the safe answer and the only
     * useful one; nothing here reveals where the link points.
     */
    symlinkSync(join(sandbox, 'private/key'), join(sandbox, 'notes/outward'));
    symlinkSync(join(sandbox, 'notes/a.md'), join(sandbox, 'notes/inward'));
    const { api } = await granted();

    for (const name of ['outward', 'inward']) {
      const info = await api['lstat']!({ path: join(sandbox, `notes/${name}`) });
      expect(info.isSymbolicLink, name).toBe(true);
      expect(info.isDirectory).toBe(false);
    }

    // `stat` follows, so the outward link is refused and the inward one reads
    // as its target. Both halves, so neither method is silently the other.
    await expect(api['stat']!({ path: join(sandbox, 'notes/outward') })).rejects.toThrow(
      /not inside a folder you granted/,
    );
    const followed = await api['stat']!({ path: join(sandbox, 'notes/inward') });
    expect(followed.isSymbolicLink).toBe(false);
    expect(followed.size).toBe('inside the grant'.length);
  });

  it('does not let the leaf exemption reach outside the grant', async () => {
    // The exemption is one path COMPONENT appended to a fully confined
    // parent. A parent outside the grant is refused as ever, and `..` in the
    // leaf position cannot survive `resolve`.
    const { api } = await granted();
    await expect(api['lstat']!({ path: join(sandbox, 'private/key') })).rejects.toThrow(
      /not inside a folder you granted/,
    );
    await expect(api['lstat']!({ path: join(sandbox, 'notes/../private/key') })).rejects.toThrow(
      /not inside a folder you granted/,
    );
    // The control: a real entry inside the grant still answers.
    expect((await api['lstat']!({ path: join(sandbox, 'notes/a.md') })).isDirectory).toBe(false);
  });
});
