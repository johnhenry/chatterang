import { describe, expect, it } from 'vitest';

import { exportFilename } from '@/lib/export';

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
