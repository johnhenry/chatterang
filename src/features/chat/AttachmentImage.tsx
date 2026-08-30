import type { ReactNode } from 'react';

import { useBlobUrl } from '@/lib/useBlobUrl';

/**
 * An attachment image, read from the blob store.
 *
 * Both the composer preview and the transcript use this, so the object-URL
 * lifetime is handled in exactly one place. Before, each rendered a
 * `data:` URI built from base64 held in the message row.
 */
export function AttachmentImage({ id, alt }: { id: string; alt: string }): ReactNode {
  const url = useBlobUrl(id);
  // No placeholder dimensions: the container is already sized by CSS, and a
  // flash of a broken-image icon is worse than a beat of empty space.
  if (!url) return null;
  return <img src={url} alt={alt} />;
}
