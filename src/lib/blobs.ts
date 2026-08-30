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

export async function putBlob(id: string, data: Blob): Promise<void> {
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
