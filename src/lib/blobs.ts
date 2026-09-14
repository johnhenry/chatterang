/**
 * Attachment payload storage.
 *
 * Attachments used to carry their bytes inline in the message row, base64
 * encoded. Three costs, in ascending order of how much they matter:
 *
 * 1. **Base64 is 33% larger than the bytes it encodes.** A 12MB image — the
 *    composer's own limit — occupied ~16MB.
 * 2. **It is a string.** IndexedDB stores `Blob` natively; a base64 payload has
 *    to be fully materialised in JS as one contiguous string to be written or
 *    read.
 * 3. **Loading a conversation loaded every image in it.**
 *    `messages.where('chatId').equals(id)` returns whole rows, so opening a
 *    thread with ten screenshots deserialised ~160MB of string before
 *    rendering a single character. That is the one that actually hurts, and it
 *    got worse with every image the conversation accumulated.
 *
 * Payloads now live in their own table keyed by attachment id. A message row
 * carries the id, media type and dimensions — enough to lay out and label the
 * attachment — and the bytes are fetched only by whoever actually needs them:
 * the renderer (as an object URL, never base64) or the request builder (as
 * base64, for the one turn being sent).
 */

import { db } from '@/db';

// StoredBlob is declared in @/db beside the other row types. Declaring it here
// and importing it there created a cycle (db -> lib/blobs -> db) that
// tests/layering.test.ts caught — the db owns the shape of its own rows.
export type { StoredBlob } from '@/db';

/*
 * ── Other windows ────────────────────────────────────────────────────────
 *
 * WHAT A SWEEP CANNOT SEE FROM HERE. The holds below (`holdBlobs`) are this
 * window's memory. The server profile serves this bundle to ordinary browser
 * tabs, and every tab of one origin shares one database. So a tab that had just
 * launched swept away the image a draft in another tab was still showing as a
 * chip, and the image of a message another tab sent while its sweep was
 * reading: neither was in the rows it read, and neither hold was in its memory.
 *
 * So a sweep runs only in a window that is the only one open. Each window holds
 * a Web Lock of its own name, under `WINDOW`, for as long as it is open; the
 * browser lets go of it when the window goes. A sweep holds `SWEEP`
 * exclusively, asks which locks are held, and deletes nothing if another
 * window's is among them. A window takes its own lock while it holds `SWEEP`
 * shared, so no window joins between a sweep's question and its deletes; and a
 * window writes no payload until it has joined (`putBlob`).
 *
 * Where there are no Web Locks — an origin that is not a secure context — no
 * other window can be seen, so no sweep runs. A draft let go still deletes its
 * own payloads (`Composer`).
 */
const locks: LockManager | undefined = globalThis.navigator?.locks;
const SWEEP = 'chatterang:attachment-sweep';
const WINDOW = 'chatterang:attachment-window:';
const ownWindow = `${WINDOW}${Date.now().toString(36)}.${Math.random().toString(36).slice(2)}`;

/**
 * Settles once this window holds its own lock, or once it cannot take one.
 * Taken as the module loads, so a window is seen from the moment it is open,
 * whether or not it has written anything yet.
 */
const joined: Promise<void> = locks ? join(locks) : Promise.resolve();

function join(manager: LockManager): Promise<void> {
  return new Promise<void>((settle) => {
    try {
      manager
        .request(SWEEP, { mode: 'shared' }, () =>
          new Promise<void>((entered) => {
            manager
              .request(ownWindow, () => {
                entered();
                // Held until this window goes.
                return new Promise<never>(() => {});
              })
              .catch(() => entered());
          }),
        )
        .then(
          () => settle(),
          () => settle(),
        );
    } catch {
      settle();
    }
  });
}

export async function putBlob(id: string, data: Blob): Promise<void> {
  // Not before another window's sweep can see this one. See "Other windows".
  await joined;
  await db.blobs.put({
    id,
    mediaType: data.type || 'application/octet-stream',
    data,
    bytes: data.size,
    createdAt: Date.now(),
  });
}

export async function getBlob(id: string): Promise<Blob | undefined> {
  return (await db.blobs.get(id))?.data;
}

/**
 * An object URL for display.
 *
 * Callers must revoke it. Rendering an image this way never materialises the
 * base64 form, which is the whole point — the browser reads the Blob directly.
 */
export async function blobObjectUrl(id: string): Promise<string | undefined> {
  const blob = await getBlob(id);
  return blob ? URL.createObjectURL(blob) : undefined;
}

/**
 * Base64 for the wire, produced on demand.
 *
 * The IR wants `{ type: 'base64', data }`, so this conversion is unavoidable —
 * but it now happens once per attachment per request, rather than for every
 * attachment in the conversation on every load.
 */
export async function blobToBase64(id: string): Promise<string | undefined> {
  const blob = await getBlob(id);
  if (!blob) return undefined;
  const buffer = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < buffer.length; i += CHUNK) {
    binary += String.fromCharCode(...buffer.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export async function deleteBlobs(ids: readonly string[]): Promise<void> {
  if (ids.length > 0) await db.blobs.bulkDelete([...ids]);
}

/** How many holds each payload has, by attachment id. See `holdBlobs`. */
const holds = new Map<string, number>();

/** For each sweep running now, every id held at any moment since it started. See `sweepOrphanBlobs`. */
const sweeps = new Set<Set<string>>();

/**
 * Keep payloads from `sweepOrphanBlobs` until the function returned is called.
 * Calling it twice lets go once.
 *
 * A payload is written when its image is ATTACHED, and nothing on disk names it
 * until the row of the message it is sent in is written. Until then only a hold
 * says it is wanted: the composer holds a draft's payloads while they are on
 * screen, and a message row being written holds the payloads it names
 * (`putMessage` in state/chat.ts) — from the moment `useChats.send` is called,
 * which is the moment the composer lets go.
 */
export function holdBlobs(ids: readonly string[]): () => void {
  for (const id of ids) {
    holds.set(id, (holds.get(id) ?? 0) + 1);
    for (const kept of sweeps) kept.add(id);
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    for (const id of ids) {
      const left = (holds.get(id) ?? 1) - 1;
      if (left > 0) holds.set(id, left);
      else holds.delete(id);
    }
  };
}

/**
 * Delete every payload that no message row names and nothing holds. Run once
 * the chat list has loaded (`useChats.load`).
 *
 * The composer deletes a draft's payloads when the draft lets them go, but not
 * every draft is let go: the app can be killed with one on screen. And a chat
 * deleted before its image was sent took only what its rows named. Either way a
 * payload stayed on the device that nothing named and no screen could show.
 *
 * WHAT IS KEPT: a payload a row names in what this read, and one held AT ANY
 * MOMENT from the start of the sweep until its delete is made — not only one
 * held when the delete is made. A message sent after the rows were read writes
 * its row and lets go of its hold before the delete, and its row is not in
 * what was read. So the sweep is registered before it reads anything, and every
 * hold taken while it runs is noted against it.
 *
 * AND EVERYTHING, WHILE ANOTHER WINDOW IS OPEN. Its holds are not here to be
 * seen. Nothing is deleted then, nor while a window is joining or another is
 * sweeping, nor where there are no Web Locks; the next launch of a window that
 * is alone sweeps. See "Other windows" at the top of this file.
 *
 * Every payload in the table is an attachment's (see the top of this file). A
 * read that fails deletes nothing.
 */
export async function sweepOrphanBlobs(): Promise<void> {
  if (!locks) return;
  const manager = locks;
  const kept = new Set(holds.keys());
  sweeps.add(kept);
  try {
    await manager.request(SWEEP, { mode: 'exclusive', ifAvailable: true }, async (lock) => {
      if (!lock) return;
      const { held = [], pending = [] } = await manager.query();
      const others = [...held, ...pending].some(
        ({ name }) => name !== undefined && name.startsWith(WINDOW) && name !== ownWindow,
      );
      if (others) return;
      const named = new Set<string>();
      const [stored] = await Promise.all([
        db.blobs.toCollection().primaryKeys(),
        db.messages.each((row) => {
          for (const attachment of row.attachments ?? []) named.add(attachment.id);
        }),
      ]);
      await deleteBlobs(stored.filter((id) => !named.has(id) && !kept.has(id)));
    });
  } finally {
    sweeps.delete(kept);
  }
}

/** Total bytes held by attachment payloads, for the storage readout. */
export async function blobBytes(): Promise<number> {
  let total = 0;
  await db.blobs.each((row) => {
    total += row.bytes;
  });
  return total;
}

/** Decode a base64 payload into a Blob. Used by the v3 migration and by tests. */
export function base64ToBlob(data: string, mediaType: string): Blob {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mediaType });
}
