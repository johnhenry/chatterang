import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Chat } from '@/domain/chat';

/**
 * EXPORT WAS SILENTLY DOING NOTHING ON DESKTOP, and every piece of that was
 * reachable from `src/`: the platform test was `Capacitor.isNativePlatform()`,
 * which the Electron shell answers TRUE, so export took the share-sheet branch
 * on a platform that registers no Share plugin; `@capacitor/core` fell through
 * to the package's web shim, whose `share()` throws when `navigator.share` is
 * absent — which it is in Electron on macOS; `export.ts` caught everything and
 * returned 'cancelled'; and `ChatScreen` only toasts on 'downloaded'. No file,
 * no message, and one orphan `.md` left in the cache root per attempt.
 *
 * These tests drive the real `exportConversation` with the platform swapped
 * underneath it, because that boolean is the whole defect.
 */
const platform = vi.hoisted(() => ({ id: 'electron' }));

vi.mock('@capacitor/core', async (importActual) => {
  const actual = await importActual<typeof import('@capacitor/core')>();
  return {
    ...actual,
    Capacitor: {
      ...actual.Capacitor,
      getPlatform: () => platform.id,
      isNativePlatform: () => platform.id !== 'web',
    },
  };
});

const share = vi.hoisted(() => ({
  canShare: true,
  throwOnShare: false,
  calls: [] as string[],
}));

vi.mock('@capacitor/share', () => ({
  Share: {
    canShare: async () => {
      share.calls.push('canShare');
      return { value: share.canShare };
    },
    share: async (options: { url?: string }) => {
      share.calls.push(`share:${options.url ?? ''}`);
      if (share.throwOnShare) throw new Error('User cancelled');
      return { activityType: 'x' };
    },
  },
}));

const fs = vi.hoisted(() => ({ calls: [] as string[], files: new Map<string, string>() }));

vi.mock('@capacitor/filesystem', async (importActual) => {
  const actual = await importActual<typeof import('@capacitor/filesystem')>();
  return {
    ...actual,
    Filesystem: {
      writeFile: async (options: { path: string; data: string }) => {
        fs.calls.push(`writeFile:${options.path}`);
        fs.files.set(options.path, options.data);
        return { uri: `/cache/${options.path}` };
      },
      getUri: async (options: { path: string }) => {
        fs.calls.push(`getUri:${options.path}`);
        return { uri: `/cache/${options.path}` };
      },
      deleteFile: async (options: { path: string }) => {
        fs.calls.push(`deleteFile:${options.path}`);
        fs.files.delete(options.path);
      },
    },
  };
});

vi.mock('@/db', () => ({
  db: {
    messages: {
      where: () => ({ equals: () => ({ sortBy: async () => [] }) }),
    },
  },
}));

vi.mock('@/shell/commands', () => ({
  renderTranscript: () => '# A conversation\n',
}));

const { exportConversation, exportFilename } = await import('@/lib/export');

/**
 * The filename is the one part of export a user sees before they see the file,
 * and it has to survive three filesystems.
 */
describe('export filename', () => {
  it('is dated and slugged from the title', () => {
    expect(exportFilename({ title: 'Rust borrow checker', updatedAt: Date.parse('2026-08-30T11:00:00Z') }))
      .toBe('rust-borrow-checker-2026-08-30.md');
  });

  it('strips characters Windows forbids in a filename', () => {
    // < > : " / \ | ? * would all make the file unsaveable on Windows and some
    // would be path separators elsewhere.
    const name = exportFilename({ title: 'a<b>c:d"e/f\\g|h?i*j', updatedAt: 0 });
    expect(name).not.toMatch(/[<>:"/\\|?*]/);
  });

  it('never produces a leading dot, which would hide the file on Unix', () => {
    expect(exportFilename({ title: '...hidden', updatedAt: 0 }).startsWith('.')).toBe(false);
  });

  it('falls back rather than producing a bare date for an untitled chat', () => {
    expect(exportFilename({ title: '', updatedAt: 0 })).toMatch(/^conversation-/);
    // A title of only punctuation slugs to nothing — same fallback, not an
    // empty stem.
    expect(exportFilename({ title: '!!!', updatedAt: 0 })).toMatch(/^conversation-/);
  });

  it('bounds the length so a long first message cannot make an unopenable name', () => {
    const name = exportFilename({ title: 'x'.repeat(500), updatedAt: 0 });
    // 255 is the common filesystem ceiling; stay far under it.
    expect(name.length).toBeLessThan(80);
  });

  it('always ends in .md, since that is what the content is', () => {
    expect(exportFilename({ title: 'notes.txt', updatedAt: 0 })).toMatch(/\.md$/);
  });
});

/* ── Where the file actually goes ────────────────────────────────────── */

const chat = {
  id: 'chat_1',
  title: 'My chat',
  updatedAt: Date.parse('2026-08-31T09:00:00Z'),
} as unknown as Chat;

const FILENAME = 'my-chat-2026-08-31.md';

let clicks: { download: string; href: string }[];

beforeEach(() => {
  fs.calls = [];
  fs.files.clear();
  share.calls = [];
  share.canShare = true;
  share.throwOnShare = false;
  clicks = [];

  // jsdom implements neither of these, and the download branch is built on
  // both.
  Object.defineProperty(URL, 'createObjectURL', {
    value: () => 'blob:test',
    configurable: true,
  });
  Object.defineProperty(URL, 'revokeObjectURL', { value: () => {}, configurable: true });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    clicks.push({ download: this.download, href: this.href });
  });
});

describe('export hands the file to whatever this platform can actually do with one', () => {
  it('desktop downloads it — and never touches the share sheet', async () => {
    /*
     * THE BUG, PINNED. On `'electron'` this used to write a file into the
     * cache root and hand it to a Share plugin that is not registered.
     *
     * FAULT INJECTED: the branch put back to `Capacitor.isNativePlatform()`.
     * Observed: the outcome was 'shared' rather than 'downloaded' and the
     * share sheet was reached — exit 1. (In the shell the same branch ends in
     * 'cancelled', because the real `ShareWeb.share` throws where this test's
     * stub succeeds. Either way the user gets no file; what this pins is that
     * desktop must not be routed to the sheet at all.)
     */
    platform.id = 'electron';

    const outcome = await exportConversation(chat);

    expect(outcome).toBe('downloaded');
    expect(clicks).toEqual([{ download: FILENAME, href: 'blob:test' }]);
    // No share sheet, and no orphan left in the cache root.
    expect(share.calls).toEqual([]);
    expect(fs.calls).toEqual([]);
  });

  it('web downloads it, exactly as it always did', async () => {
    platform.id = 'web';
    expect(await exportConversation(chat)).toBe('downloaded');
    expect(clicks).toHaveLength(1);
    expect(share.calls).toEqual([]);
  });

  it('ios writes to the cache and opens the share sheet', async () => {
    platform.id = 'ios';

    const outcome = await exportConversation(chat);

    expect(outcome).toBe('shared');
    expect(fs.calls).toEqual([`writeFile:${FILENAME}`, `getUri:${FILENAME}`]);
    expect(share.calls).toEqual(['canShare', `share:/cache/${FILENAME}`]);
    // The file the sheet was given is the transcript, not an empty stub.
    expect(fs.files.get(FILENAME)).toContain('A conversation');
    expect(clicks).toEqual([]);
  });

  it('a dismissed share sheet is not an error', async () => {
    platform.id = 'android';
    share.throwOnShare = true;
    expect(await exportConversation(chat)).toBe('cancelled');
  });

  it('a share sheet that cannot take the file says so, and leaves nothing behind', async () => {
    /*
     * The other half of the old defect: `share()` threw and the bare `catch`
     * reported a user decision that never happened. `canShare()` is asked
     * first, so a refusal is distinguishable from a dismissal — and the cache
     * copy is deleted, because nothing is going to consume it.
     *
     * FAULT INJECTED: the `canShare()` gate removed. Observed: the export
     * resolved 'shared' instead of rejecting, with the cache copy still on
     * disk — a success reported for a sheet that never opened. Exit 1.
     */
    platform.id = 'ios';
    share.canShare = false;

    await expect(exportConversation(chat)).rejects.toThrow(/Sharing is not available/);
    expect(fs.calls).toContain(`deleteFile:${FILENAME}`);
    expect(fs.files.has(FILENAME)).toBe(false);
    expect(share.calls).toEqual(['canShare']);
  });
});

describe('the export module asks the seam, not the platform', () => {
  it('names no platform of its own', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync('src/lib/export.ts', 'utf8');
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    expect(code).not.toContain('isNativePlatform');
    expect(code).toContain("capabilities().fileHandoff === 'share-sheet'");
  });
});
