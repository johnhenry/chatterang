import { type ReactNode } from 'react';

import { Icon } from '@/ui/Icon';
import { useApp } from '@/state/app';

/**
 * Says plainly when the app is running the browser development shim rather
 * than a real inference engine. Without this, a developer preview would look
 * exactly like a working on-device model, which is the one thing this app
 * must never be ambiguous about.
 *
 * It occupies its own grid row rather than floating over the interface: a
 * notice that hides the thing it is describing is worse than no notice.
 */
export function ShimNotice(): ReactNode {
  const device = useApp((state) => state.device);
  const settings = useApp((state) => state.settings);
  const update = useApp((state) => state.updateSettings);

  if (!device?.simulated || settings.dismissedShimNotice) return null;

  return (
    <div className="banner" role="status">
      <span className="banner__icon">
        <Icon name="alert" size={16} />
      </span>
      <span className="grow">
        <strong>Development shim.</strong> No inference engine is present in this browser, so
        replies are synthesised rather than generated. Build for iOS or Android to run real models.
      </span>
      <button
        type="button"
        className="btn btn--ghost btn--sm"
        onClick={() => void update({ dismissedShimNotice: true })}
      >
        Got it
      </button>
    </div>
  );
}
