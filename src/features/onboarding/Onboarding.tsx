import { type ReactNode } from 'react';

import { Icon } from '@/ui/Icon';
import { Sheet } from '@/ui/primitives';
import { CATALOG } from '@/data/catalog';
import { formatBytes } from '@/domain/manifest';
import { recommendModel } from '@/domain/onboarding';

import { useApp } from '@/state/app';
import { useModels } from '@/state/models';

/**
 * First run.
 *
 * Deliberately one screen, not a carousel. The app does nothing until a
 * multi-gigabyte file has been downloaded, so every panel of feature marketing
 * placed before that is friction charged to someone who has not had any value
 * yet.
 *
 * It does the one thing a generic onboarding cannot: it knows the device, so it
 * names a specific model, states what the download costs, and says why that
 * one. The alternative that needs no download at all is given equal weight
 * rather than buried — for someone evaluating the app, "try it without
 * downloading anything" is the honest first step.
 */
export function Onboarding({ open, onClose }: { open: boolean; onClose: () => void }): ReactNode {
  const device = useApp((state) => state.device);
  const install = useModels((state) => state.install);

  const pick = recommendModel(CATALOG, device?.totalMemory);

  return (
    <Sheet open={open} title="Welcome" onClose={onClose}>
      <p className="section__hint">
        Chatterang runs language models on this device. Conversations stay in local storage,
        and nothing is sent anywhere unless you connect a remote provider — in which case
        every message that leaves is marked in the thread.
      </p>

      {pick ? (
        <div className="section">
          <div className="section__head">
            <h2 className="grow">Start with {pick.manifest.name}</h2>
            <span className="chip chip--local">
              <Icon name="flame" size={11} />
              {formatBytes(pick.manifest.sizeBytes, 1)}
            </span>
          </div>
          <p className="section__hint">
            {pick.manifest.bestFor}.{' '}
            {pick.fit === 'comfortable'
              ? device?.chipset
                ? `Comfortable on ${device.chipset}.`
                : 'Comfortable on this device.'
              : 'This is the smallest model available — it will be slow on this device, but it will run.'}{' '}
            It downloads once and then works offline.
          </p>
          <button
            type="button"
            className="btn btn--block"
            onClick={() => {
              void install(pick.manifest);
              onClose();
            }}
          >
            <Icon name="download" size={16} />
            Download {formatBytes(pick.manifest.sizeBytes, 1)}
          </button>
        </div>
      ) : null}

      <div className="section">
        <div className="section__head">
          <h2>Not ready to download?</h2>
        </div>
        <p className="section__hint">
          Connect a remote provider in Settings and use Chatterang straight away. Those
          messages leave the device, and the app says so on every one of them.
        </p>
        <button type="button" className="btn btn--secondary btn--block" onClick={onClose}>
          Look around first
        </button>
      </div>
    </Sheet>
  );
}
