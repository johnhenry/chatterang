import { Suspense, lazy, useState, type ReactNode } from 'react';

import { pairingController, type PairingController } from '@/lib/pairing';
import { useApp } from '@/state/app';
import { pairedMessage } from '@/features/pairing/wording';

/**
 * THE ONE DOOR INTO PAIRING (#128, #130).
 *
 * Renders NOTHING unless `pairingController().available` — and on every build
 * today it is false, so no Settings screen shows this section and nobody can
 * reach the sheet or be asked for a camera for a feature that cannot work.
 * `tests/layering.test.ts` holds the rest of the gate: only `SettingsScreen`
 * imports this feature, only through this file, and only this file reads the
 * accessor.
 *
 * TWO COMPONENTS, so no hook ever follows the early return. The gate reads the
 * accessor and stops; the section below it holds state.
 *
 * The sheet is a lazy chunk, loaded when the button is pressed, so its words
 * and the typed-route parser stay off the startup path of everyone who never
 * pairs. No size is claimed for that: nothing here measures a build.
 */

const PairingSheet = lazy(() =>
  import('@/features/pairing/PairingSheet').then((module) => ({ default: module.PairingSheet })),
);

export function PairingEntry(): ReactNode {
  const controller = pairingController();
  if (!controller.available) return null;
  return <PairingSection controller={controller} />;
}

function PairingSection({ controller }: { controller: PairingController }): ReactNode {
  const toast = useApp((state) => state.toast);
  const [open, setOpen] = useState(false);

  return (
    <div className="section">
      <div className="section__head">
        <h2>Pairing</h2>
      </div>
      {/* D10: the purpose, and what the typed route does not check — measured
          by the grammar accepting a public address and a DNS name. Where a
          conversation goes once paired is not said here: nothing on this build
          can pair, so that sentence waits for a controller to measure. */}
      <p className="section__hint">
        Pair this phone with Chatterang on a computer or a server. The address you type can be
        anywhere, and nothing here checks that it is on your network or whose machine it is.
      </p>
      <button type="button" className="btn btn--secondary btn--block" onClick={() => setOpen(true)}>
        Pair with a computer
      </button>
      {/* Mounted only while open, so a typed code is gone from memory once the
          sheet closes. A late "paired" still reaches the toast (D9). */}
      {open ? (
        <Suspense fallback={null}>
          <PairingSheet
            controller={controller}
            onClose={() => setOpen(false)}
            onOutcome={(outcome) => toast(pairedMessage(outcome.deviceName), 'good')}
          />
        </Suspense>
      ) : null}
    </div>
  );
}
