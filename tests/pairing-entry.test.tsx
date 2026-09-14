/**
 * THE GATE, WITH THE ACCESSOR EVERY BUILD SHIPS (#128, #130).
 *
 * Nothing in a production build may reach the pairing sheet. This file renders
 * `PairingEntry` against the REAL `pairingController()` — no mock of
 * `@/lib/pairing` anywhere in it — and finds nothing on screen.
 * `tests/pairing-entry-available.test.tsx` is the paired control: with an
 * available controller the same component does render, so the emptiness here
 * is the gate and not a component that renders nothing at all.
 *
 * The structural half pins how the sheet is reached: Settings mounts the entry,
 * and the entry is the only thing that loads the sheet, lazily.
 * `tests/layering.test.ts` pins the rest for every file in `src/`.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { pairingController } from '@/lib/pairing';
import { PairingEntry } from '@/features/pairing/PairingEntry';

import { button, dialog, reads, render, settle, type Mounted } from './support/pairing-dom';

const mounted: Mounted[] = [];
afterEach(async () => {
  for (const mount of mounted.splice(0)) await mount.unmount();
});

/** Code without block, line or JSX comments — the question is what is written, not said. */
const code = (path: string): string =>
  readFileSync(resolve(process.cwd(), 'src', path), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|\s)\/\/.*$/gm, '$1');

describe('the pairing entry on this build', () => {
  afterEach(() => {
    delete (navigator as { mediaDevices?: unknown }).mediaDevices;
  });

  it('renders nothing: no section, no button, no dialog, and no camera request', async () => {
    expect(pairingController().available, 'this file measures the unavailable build').toBe(false);
    const getUserMedia = vi.fn(async () => ({ getTracks: () => [] }));
    Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia }, configurable: true });

    const mount = await render(<PairingEntry />);
    mounted.push(mount);
    await settle();

    expect(mount.host.innerHTML).toBe('');
    expect(button('Pair with a computer')).toBeNull();
    expect(button('Scan with camera')).toBeNull();
    expect(dialog()).toBeNull();
    expect(reads(document.body)).not.toMatch(/\bpair/i);
    expect(getUserMedia).not.toHaveBeenCalled();

    // The spy is wired: a call made through the same object registers.
    await navigator.mediaDevices.getUserMedia({ video: true });
    expect(getUserMedia).toHaveBeenCalledTimes(1);
  });
});

describe('how the sheet is reached', () => {
  it('Settings mounts the entry, and names nothing else from the feature', () => {
    const settings = code('features/settings/SettingsScreen.tsx');
    expect(settings).toContain("import { PairingEntry } from '@/features/pairing/PairingEntry';");
    expect(settings).toContain('<PairingEntry />');
    expect(settings).not.toMatch(/PairingSheet|features\/pairing\/(?!PairingEntry')/);
    // Whatever a statement binds, the only one that reaches into the feature is
    // that import: a second name taken from PairingEntry would be a way past it.
    const reaching = settings.match(/\b(?:import|export)\b[^;]*?\bfrom\s*['"][^'"]*pairing\/[^'"]*['"]/g) ?? [];
    expect(reaching).toEqual(["import { PairingEntry } from '@/features/pairing/PairingEntry'"]);
  });

  it('the entry loads the sheet only through lazy(), never statically', () => {
    const entry = code('features/pairing/PairingEntry.tsx');
    const specifier = "'@/features/pairing/PairingSheet'";
    expect(entry).toMatch(/lazy\(\s*\(\)\s*=>\s*import\('@\/features\/pairing\/PairingSheet'\)/);
    expect(entry.split(specifier).length - 1, 'the sheet is named once, in the lazy import').toBe(1);
    expect(entry).not.toMatch(/from\s+'@\/features\/pairing\/PairingSheet'/);
  });
});
