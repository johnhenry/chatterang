// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { fakePort } from './support/fake-real-fs';

/**
 * THE TEST THAT WOULD HAVE CAUGHT IT, and the reason it lives in its own file.
 *
 * #246's argument for building the shell mount before the CLI work is one
 * sentence: "It is a shell feature, not a CLI one. The app's own `bash` tool
 * gets it, and any model does." `src/shell/tool.ts` was not in the pull
 * request that made the claim. `createBashTool` built its shell with neither
 * `mounts` nor `realFs`, so the model's shell had no `/mnt` at all — while
 * `liveStores()` DID carry the grant registry, so `mount list` and `privacy`
 * named the user's absolute host path in a shell that could not open it.
 *
 * Every mount test on that branch drove `new ChatterangShell({...})` directly
 * with `actor: 'user'`. None drove THIS function, which is the only shell a
 * model ever touches, so none could see the gap. This one calls
 * `createBashTool` itself, with the two modules it reaches for replaced — the
 * seam has to be the real one or the test is testing a shell built to look
 * like the tool rather than the tool.
 */

const GRANT = { name: 'notes', root: '/real/notes', writable: false };
const REGISTRY_ROW = {
  id: 'm1',
  name: 'notes',
  root: '/Users/jane/Documents/Divorce',
  writable: false,
  grantedAt: 0,
};

let port = fakePort({});
let grants: { name: string; root: string; writable: boolean }[] = [];

vi.mock('@/shell/real-fs', () => ({
  // A getter, so a test can change the grant set after the tool is built —
  // the case the production code has to survive, since the tool caches its
  // shell for the life of the app.
  shellMounts: () => grants,
  // A Proxy rather than `port` itself: `beforeEach` replaces `port`, and a
  // direct reference would pin the first one for the whole file.
  mountHostPort: new Proxy({} as Record<string, unknown>, {
    get: (_target, key) => (port as unknown as Record<string | symbol, unknown>)[key],
  }),
}));

vi.mock('@/shell/stores', () => ({
  liveStores: () => ({
    models: () => ({
      installed: {},
      activeModelId: null,
      install: async () => undefined,
      remove: async () => undefined,
      setActive: async () => undefined,
    }),
    catalog: () => [],
    chats: () => ({
      list: [],
      activeChatId: null,
      messagesFor: async () => [],
      open: async () => undefined,
      create: async () => 'chat_new',
    }),
    personas: () => [],
    providers: () => ({ list: [], toggle: async () => undefined }),
    device: () => null,
    benchmarks: () => [],
    runBenchmark: async () => undefined,
    // The process-wide grant registry, which is NOT the same thing as what
    // this shell mounted. Keeping them different is the whole point.
    mounts: () => ({
      list: [REGISTRY_ROW],
      canGrant: true,
      grant: async () => null,
      revoke: async () => false,
    }),
  }),
}));

const { createBashTool } = await import('@/shell/tool');

function run(tool: ReturnType<typeof createBashTool>, command: string) {
  return tool.execute({ command }, { signal: undefined } as never) as Promise<{
    output: string;
    isError?: boolean;
  }>;
}

describe('the bash tool a model drives', () => {
  beforeEach(() => {
    port = fakePort({
      dirs: ['/real', '/real/notes'],
      files: { '/real/notes/a.md': 'the granted file\n' },
    });
    grants = [];
  });

  it('has no /mnt when nothing is granted, and says nothing about folders', async () => {
    const confirm = vi.fn(async () => true);
    const tool = createBashTool({ confirm });

    expect((await run(tool, 'ls /mnt')).isError).toBe(true);
    // And the registry row must not turn into a claim.
    const list = await run(tool, 'mount list');
    expect(list.output).toContain('not mounted here');
    expect(list.output).not.toContain('Divorce');
    expect(confirm).not.toHaveBeenCalled();
  });

  it('reads a granted folder — the sentence #246 was built on', async () => {
    grants = [GRANT];
    const tool = createBashTool({ confirm: vi.fn(async () => true) });

    const listed = await run(tool, 'ls /mnt/notes');
    expect(listed.isError).toBeFalsy();
    expect(listed.output).toContain('a.md');

    const read = await run(tool, 'cat /mnt/notes/a.md');
    expect(read.output).toContain('the granted file');
  });

  it('never hands the model the folder’s place on disk', async () => {
    /*
     * `mount.ts` answers `realpath` with the VIRTUAL path and keeps the host
     * path out of every error message, so the folder's location does not leak.
     * These are the three commands that could undo that in one line.
     */
    grants = [GRANT];
    const tool = createBashTool({ confirm: vi.fn(async () => true) });

    for (const command of ['mount list', 'privacy', 'chatterang', 'cd /mnt/notes && pwd -P']) {
      const { output } = await run(tool, command);
      expect(output, `${command} leaked the host path`).not.toContain('/Users/jane');
      expect(output, `${command} leaked the host path`).not.toContain('Divorce');
      expect(output, `${command} leaked the real root`).not.toContain('/real/notes');
    }

    // The control: it is told the mount point, which is what governs the bytes.
    expect((await run(tool, 'mount list')).output).toContain('/mnt/notes');
  });

  it('refuses to write to a read-only grant, and writes to a writable one', async () => {
    grants = [GRANT];
    const readOnly = createBashTool({ confirm: vi.fn(async () => true) });
    expect((await run(readOnly, 'echo x > /mnt/notes/new.md')).isError).toBe(true);
    expect(port.written).toEqual({});

    grants = [{ ...GRANT, writable: true }];
    const writable = createBashTool({ confirm: vi.fn(async () => true) });
    expect((await run(writable, 'echo x > /mnt/notes/new.md')).isError).toBeFalsy();
    expect(port.written['/real/notes/new.md']).toContain('x');
  });

  it('sees a folder granted after the tool was already built', async () => {
    // The tool caches its shell for the life of the app, so a snapshot taken
    // at construction would never show a folder granted afterwards.
    const tool = createBashTool({ confirm: vi.fn(async () => true) });
    expect((await run(tool, 'ls /mnt/notes')).isError).toBe(true);
    grants = [GRANT];
    expect((await run(tool, 'ls /mnt/notes')).output).toContain('a.md');
    grants = [];
    expect((await run(tool, 'ls /mnt/notes')).isError).toBe(true);
  });

  it('cannot grant a folder itself', async () => {
    // Two gates, and the second is not clickable from in here. The first is
    // asserted by refusing; the chooser is the host's and is never reached.
    const confirm = vi.fn(async () => false);
    const tool = createBashTool({ confirm });
    const result = await run(tool, 'mount add --write');
    expect(result.isError).toBe(true);
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('folder chooser'), undefined);
  });
});
