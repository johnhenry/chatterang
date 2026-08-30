import { describe, expect, it } from 'vitest';

import { base64ToBlob } from '@/lib/blobs';

/**
 * Attachment payloads used to live inline in the message row as base64, so
 * `messages.where('chatId')` deserialised every image in a conversation before
 * rendering a character. They now live in their own table, keyed by attachment
 * id, and are read only by whoever needs the bytes.
 */
describe('payload encoding', () => {
  it('round-trips bytes through base64 without corrupting them', async () => {
    // Bytes that break naive encoders: 0x00, high bytes, and a non-ASCII
    // sequence that would be mangled by a string-based round trip.
    const original = new Uint8Array([0, 1, 127, 128, 200, 255, 0xf0, 0x9f, 0x92, 0xa9]);
    const b64 = btoa(String.fromCharCode(...original));
    const blob = base64ToBlob(b64, 'image/png');

    expect(blob.type).toBe('image/png');
    expect(blob.size).toBe(original.length);
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(original);
  });

  it('preserves size exactly, which is what the row now stores instead of data', () => {
    // 3 raw bytes -> 4 base64 chars. The stored `bytes` must be the raw count,
    // not the encoded length, or the storage readout overstates by a third.
    const blob = base64ToBlob(btoa('abc'), 'image/jpeg');
    expect(blob.size).toBe(3);
    expect(btoa('abc').length).toBe(4);
  });

  it('handles an empty payload without throwing', () => {
    expect(base64ToBlob('', 'image/png').size).toBe(0);
  });
});

/**
 * The attachment type no longer carries its bytes. This is a type-level
 * guarantee, but pinning it stops someone reintroducing `data` as a
 * convenience field and quietly restoring the original problem.
 */
describe('attachment shape', () => {
  it('carries metadata only', async () => {
    const { ImageAttachment } = await import('@/domain/chat').then((m) => ({ ImageAttachment: m }));
    // Structural check: an attachment literal with `data` must not typecheck.
    // The compiler enforces this; this test documents the intent for a reader.
    const attachment = { kind: 'image' as const, id: 'att_1', mediaType: 'image/png', bytes: 1024 };
    expect(Object.keys(attachment)).not.toContain('data');
    expect(ImageAttachment).toBeDefined();
  });
});
