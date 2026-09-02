import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ShellStores } from '@/shell';

/**
 * The boot guard, asserted where it actually has to hold: on the path a shell
 * takes when it starts.
 *
 * `tests/shell.test.ts` already covers `assertConfinedBuild` as a function —
 * that the browser build passes, that the real Node build throws, that a
 * registered `curl` throws. What none of that covered is whether anything
 * *calls* it. Deleting the one line `assertConfinedBuild(module)` from
 * `ChatterangShell.#start` left the whole suite green: every assertion about
 * confinement was about a function the shell no longer used.
 *
 * So these drive `ChatterangShell.ready()` against a substituted `just-bash`
 * module and assert on what the shell does, not on what the checker returns.
 * The two cases are the same shell, the same stores, and the same stub module
 * — differing only in whether it exports `ReadWriteFs`.
 */

/** Flipped between cases; read by the module factory on each `#start`. */
const build = vi.hoisted(() => ({ exposesRealFilesystem: false }));

class StubFs {
  files = new Map<string, string>();
  async realpath(path: string): Promise<string> {
    return path;
  }
  async writeFile(path: string, content: string): Promise<void> {
    this.files.set(path, content);
  }
  async rm(path: string): Promise<void> {
    this.files.delete(path);
  }
}

vi.mock('just-bash/browser', () => ({
  Bash: class {
    fs: unknown;
    constructor(options: { fs?: unknown }) {
      this.fs = options.fs;
    }
    async exec(): Promise<{ stdout: string; stderr: string; exitCode: number }> {
      return { stdout: 'stub', stderr: '', exitCode: 0 };
    }
    async writeFile(): Promise<void> {}
    async readFile(): Promise<string> {
      return '';
    }
  },
  InMemoryFs: StubFs,
  defineCommand: (name: string, execute: unknown) => ({ name, execute }),
  getCommandNames: () => ['cat', 'grep'],
  getNetworkCommandNames: () => ['curl'],
  // A getter, not a field: `assertConfinedBuild` reads it once per shell start,
  // so one mocked module can play both builds.
  get ReadWriteFs() {
    return build.exposesRealFilesystem ? class {} : undefined;
  },
}));

function stores(): ShellStores {
  return {
    models: () => ({
      installed: {},
      activeModelId: null,
      install: async () => {},
      remove: async () => {},
      setActive: async () => {},
    }),
    catalog: () => [],
    chats: () => ({
      list: [],
      activeChatId: null,
      messagesFor: async () => [],
      open: async () => {},
      create: async () => 'chat_1',
    }),
    personas: () => [],
    providers: () => ({ list: [], toggle: async () => {} }),
    device: () => null,
    benchmarks: () => [],
    runBenchmark: async () => {},
  };
}

async function startShell(): Promise<{ ready: () => Promise<void> }> {
  const { ChatterangShell } = await import('@/shell');
  return new ChatterangShell({ stores: stores(), actor: 'model', confirm: async () => true });
}

describe('the shell refuses to start on an unconfined build', () => {
  beforeEach(() => {
    build.exposesRealFilesystem = false;
    vi.resetModules();
  });

  it('starts normally on a build that cannot address a real filesystem', async () => {
    // The control. Without it, the rejection below would prove only that this
    // stub cannot start a shell at all.
    const shell = await startShell();
    await expect(shell.ready()).resolves.toBeUndefined();
  });

  it('rejects when the module can address a real filesystem', async () => {
    build.exposesRealFilesystem = true;
    const shell = await startShell();
    await expect(shell.ready()).rejects.toThrow(/ReadWriteFs/);
  });

  it('keeps rejecting rather than starting once and remembering it worked', async () => {
    // `ready()` memoises `#start`, so a shell that swallowed the throw would
    // report success on every later call. The second await must reject too.
    build.exposesRealFilesystem = true;
    const shell = await startShell();
    await expect(shell.ready()).rejects.toThrow(/ReadWriteFs/);
    await expect(shell.ready()).rejects.toThrow(/ReadWriteFs/);
  });
});
