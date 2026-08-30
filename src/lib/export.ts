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
 */

import { Capacitor } from '@capacitor/core';
import { Directory, Encoding, Filesystem } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';

import { db } from '@/db';
import type { Chat } from '@/domain/chat';
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
 * Native gets the share sheet, which is the only route to "save to Files",
 * "send to someone", or "open in an editor" on iOS — a bare filesystem write
 * would land somewhere the user cannot reach. Web gets a download.
 *
 * The file is written to `Directory.Cache` rather than `Documents`: it exists
 * only to be handed to the share sheet, and the OS is free to reclaim it
 * afterwards. Writing to Documents would accumulate a copy per export with
 * nothing ever deleting them.
 */
export async function exportConversation(chat: Chat): Promise<ExportOutcome> {
  const markdown = await buildTranscript(chat);
  const filename = exportFilename(chat);

  if (Capacitor.isNativePlatform()) {
    await Filesystem.writeFile({
      path: filename,
      data: markdown,
      directory: Directory.Cache,
      encoding: Encoding.UTF8,
    });
    const { uri } = await Filesystem.getUri({ path: filename, directory: Directory.Cache });
    try {
      await Share.share({ title: chat.title || 'Conversation', url: uri });
      return 'shared';
    } catch {
      // The share sheet throws on dismissal, which is not an error — the user
      // simply changed their mind, and telling them something failed would be
      // wrong.
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
