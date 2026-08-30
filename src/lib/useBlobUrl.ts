import { useEffect, useState } from 'react';

import { blobObjectUrl } from '@/lib/blobs';

/**
 * An object URL for a stored attachment, revoked on unmount.
 *
 * Object URLs are a manual allocation: the browser holds the Blob alive until
 * `revokeObjectURL`, so a thread that scrolled past fifty images without
 * revoking would pin all fifty. The cleanup is the point of the hook.
 */
export function useBlobUrl(id: string | undefined): string | undefined {
  const [url, setUrl] = useState<string>();

  useEffect(() => {
    if (!id) {
      setUrl(undefined);
      return undefined;
    }
    let revoked = false;
    let current: string | undefined;

    void blobObjectUrl(id).then((next) => {
      // The component may have unmounted while the read was in flight; a URL
      // created after that would never be revoked.
      if (revoked) {
        if (next) URL.revokeObjectURL(next);
        return;
      }
      current = next;
      setUrl(next);
    });

    return () => {
      revoked = true;
      if (current) URL.revokeObjectURL(current);
    };
  }, [id]);

  return url;
}
