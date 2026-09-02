/**
 * Conversation export.
 *
 * The shell has had `chat export <id>` since the shell landed, and it renders a
 * good transcript — provenance included, so a reader can see which turns left
 * the device. What was missing was a way to get that out of the app without
 * typing a command.
 *
 * `renderTranscript` is reused rather than reimplemented. Two renderers would
 * drift, and the one thing an export must not do is quietly disagree with
 * itself about what a conversation contained.
 *
 * That reuse is also why this file needed no fix of its own when the chip and
 * the transcript were made to follow the text. A turn that has been
 * regenerated holds every generation it has had, and the heading has to name
 * the one whose words are printed underneath it — `renderTranscript` reads
 * both out of the displayed generation now, and a second renderer here would
 * have been a second place to get that wrong. What this file contributes is
 * the rows: `db.messages`, which is where `cycleVariant` writes the projected
 * row, so the file the user downloads says what the thread said on screen.
 */

import { Directory, Encoding, Filesystem } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';

import { db } from '@/db';
import type { Chat } from '@/domain/chat';
import { capabilities } from '@/lib/platform';
import { renderTranscript } from '@/shell/commands';

/** A filename that is safe on every platform and still recognisable. */
export function exportFilename(chat: { title: string; updatedAt: number }): string {
  const stamp = new Date(chat.updatedAt).toISOString().slice(0, 10);
  const slug =
    (chat.title || 'conversation')
      .toLowerCase()
      // Windows forbids <>:"/\|?*, and a leading dot hides the file on Unix.
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'conversation';
  return `${slug}-${stamp}.md`;
}

export async function buildTranscript(chat: Chat): Promise<string> {
  const messages = await db.messages.where('chatId').equals(chat.id).sortBy('createdAt');
  return renderTranscript(chat, messages);
}

export type ExportOutcome = 'shared' | 'downloaded' | 'cancelled';

/**
 * Hand the transcript to the platform.
 *
 * THREE ANSWERS, NOT TWO — and the third is why this was broken. The old test
 * was `Capacitor.isNativePlatform()`, which the desktop shell answers TRUE, so
 * export took the share-sheet branch on a platform that registers no Share
 * plugin. `@capacitor/core` then fell through to the package's WEB shim, whose
 * `share()` throws unless `navigator.share` exists — and in Electron on macOS
 * it does not. The bare `catch` below turned that throw into `'cancelled'`,
 * which `ChatScreen` does not toast. So export did NOTHING, said NOTHING, and
 * left one orphan `.md` in the cache root per attempt, because the file it
 * wrote for the share sheet was never consumed. Confirmed end to end against
 * the real shim in a hidden Electron window before it was changed.
 *
 * Now each platform is asked what it can do with a file:
 *
 *   share-sheet       iOS and Android. The only route to "save to Files",
 *                     "send to someone", or "open in an editor" — a bare
 *                     filesystem write would land somewhere unreachable. The
 *                     file goes to `Directory.Cache` rather than `Documents`
 *                     because it exists only to be handed over, and the OS is
 *                     free to reclaim it; Documents would accumulate a copy
 *                     per export with nothing deleting them.
 *   browser-download  Web AND the desktop shell. An `<a download>` on a blob
 *                     URL: the download shelf in a browser, and in Electron
 *                     the OS save dialog, because the shell registers no
 *                     `will-download` handler so the default applies. No new
 *                     plugin, no new native code, and it is the branch this
 *                     function already had.
 *
 * `Share.canShare()` is consulted as well as the table, because "a share sheet
 * exists on this platform" and "the sheet will accept this right now" are two
 * questions. When it says no there is nothing to hand the file to, so the
 * cache copy is deleted rather than left behind and the caller is told — an
 * export that silently does nothing is the defect this replaces.
 */
export async function exportConversation(chat: Chat): Promise<ExportOutcome> {
  const markdown = await buildTranscript(chat);
  const filename = exportFilename(chat);

  if (capabilities().fileHandoff === 'share-sheet') {
    await Filesystem.writeFile({
      path: filename,
      data: markdown,
      directory: Directory.Cache,
      encoding: Encoding.UTF8,
    });
    const { uri } = await Filesystem.getUri({ path: filename, directory: Directory.Cache });

    const shareable = await Share.canShare()
      .then((result) => result.value)
      .catch(() => false);
    if (!shareable) {
      // Nothing will consume the file, so it does not stay on disk.
      await Filesystem.deleteFile({ path: filename, directory: Directory.Cache }).catch(
        () => undefined,
      );
      throw new Error('Sharing is not available on this device, so the chat was not exported.');
    }

    try {
      await Share.share({ title: chat.title || 'Conversation', url: uri });
      return 'shared';
    } catch {
      // The share sheet throws on dismissal, which is not an error — the user
      // simply changed their mind, and telling them something failed would be
      // wrong. This is reached only after `canShare()` said yes, so it is a
      // dismissal rather than an absent implementation.
      return 'cancelled';
    }
  }

  const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    return 'downloaded';
  } finally {
    // Revoke on the next tick: revoking synchronously can race the download in
    // some browsers, which then saves an empty file.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}
