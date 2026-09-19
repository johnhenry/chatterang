/**
 * THE GATE'S PAIRED CONTROL: an available controller, mocked (#128, #130).
 *
 * `tests/pairing-entry.test.tsx` renders the entry with the real accessor and
 * finds nothing. That would also pass for an entry that renders nothing ever,
 * so this file mocks `@/lib/pairing` to answer `available: true` and finds the
 * section, the button and the sheet. A separate file because `vi.mock` is
 * hoisted over the whole file: the real-accessor test must not share it.
 *
 * It also measures the entry's one piece of wiring — a completed pairing
 * becomes a toast, including one that completes after the sheet closed (D9),
 * with the host's name quoted or withheld (D5, D11).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => ({ pair: vi.fn() }));

vi.mock('@/lib/pairing', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/pairing')>();
  return { ...actual, pairingController: () => ({ available: true, pair: fake.pair }) };
});

import type { PairingOutcome } from '@/lib/pairing';
import { capabilities } from '@/lib/platform';
import { PairingEntry } from '@/features/pairing/PairingEntry';
import { useApp } from '@/state/app';

import {
  button,
  byLabel,
  click,
  dialog,
  mustButton,
  reads,
  render,
  settle,
  typeInto,
  type Mounted,
} from './support/pairing-dom';
import { stage } from './support/stage';

const mounted: Mounted[] = [];

beforeEach(() => {
  useApp.setState({ toasts: [] });
  fake.pair.mockReset();
});
afterEach(async () => {
  for (const mount of mounted.splice(0)) await mount.unmount();
});

/**
 * How long a press may take to become a sheet on screen: the sheet's chunk
 * transformed and evaluated, then rendered. A BOUND ON A HANG, NEVER A WINDOW
 * FOR A RACE (`tests/support/stage.ts`): a pressed entry must load its sheet,
 * and a loaded runner only makes that later. It used to be 50 rounds of
 * `settle()`, a count that a runner busy with other files spent before the
 * chunk arrived. Generous, because under load the first press spends it
 * transforming the chunk; free, because the wait returns the moment the sheet
 * is there.
 */
const SHEET_MS = 15_000;
/**
 * Each test's timeout here: `SHEET_MS` and the rest of a test, under load. Over
 * `SHEET_MS`, so a sheet that never loads fails naming the sheet rather than
 * at `it(` (stage.ts: raise the bound with the test timeout, never past it).
 */
const TEST_MS = 25_000;

/**
 * Wait until the lazy sheet has loaded, or fail naming it. It opens on Type,
 * which every test here pairs by, although the real `web` row jsdom runs can
 * scan (#124): so Type here is the sheet's choice, not a missing camera.
 *
 * Two waits, each on the thing it means:
 *   - The lazy import itself. The press rendered `lazy()`, which called
 *     `import()` for the sheet; the module runner hands this `import()` the
 *     same evaluation, so it resolves when the sheet's module has loaded.
 *   - The render. React retries the suspended boundary once `lazy()`'s own
 *     promise settles; each look lets that work run inside `act`. What bounds
 *     the looks is what is left of `SHEET_MS`, not a count of them, so a sheet
 *     that never renders still fails here, only later.
 */
async function sheetLoaded(): Promise<HTMLElement> {
  const started = Date.now();
  await stage("the lazy sheet's module to load", import('@/features/pairing/PairingSheet'), SHEET_MS);
  while (dialog() === null && Date.now() - started < SHEET_MS) await settle();
  const found = dialog();
  expect(found, `the lazy sheet never loaded (waited ${Date.now() - started}ms of ${SHEET_MS}ms)`).not.toBeNull();
  expect(capabilities().cameraScan, 'this row can scan').toBe(true);
  expect(mustButton('Type').getAttribute('aria-pressed'), 'the sheet opened on Type').toBe('true');
  return found!;
}

async function openSheet(): Promise<void> {
  mounted.push(await render(<PairingEntry />));
  await click(mustButton('Pair with a computer'));
  await sheetLoaded();
}

async function pairTyped(): Promise<void> {
  await typeInto(byLabel('Computer address'), '192.168.1.4:51234');
  await typeInto(byLabel('Six-digit code'), '123456');
  await click(mustButton('Chatterang desktop app'));
  await click(mustButton('Pair'));
  await settle();
}

const toasts = () => useApp.getState().toasts.map(({ message, tone }) => ({ message, tone }));

describe('the pairing entry when a controller is available', { timeout: TEST_MS }, () => {
  it('shows the section and its button, and opens the sheet only when pressed', async () => {
    const mount = await render(<PairingEntry />);
    mounted.push(mount);

    expect(reads(mount.host)).toContain('Pair this phone with Chatterang on a computer or a server.');
    const entry = mustButton('Pair with a computer');
    expect(dialog()).toBeNull();

    await click(entry);
    const sheet = await sheetLoaded();
    expect(reads(sheet)).toContain('Pair with a computer');
    expect(byLabel('Computer address')).toBeInstanceOf(HTMLInputElement);
    expect(fake.pair).not.toHaveBeenCalled();
  });

  it('turns a completed pairing into a toast that quotes the host’s name', async () => {
    fake.pair.mockResolvedValue({ kind: 'paired', deviceName: 'Desk' } satisfies PairingOutcome);
    await openSheet();
    await pairTyped();
    expect(fake.pair).toHaveBeenCalledTimes(1);
    expect(dialog()).toBeNull();
    expect(toasts()).toEqual([{ message: 'Paired with “Desk”.', tone: 'good' }]);
  });

  it('still toasts a pairing that completes after the sheet was closed (D9)', async () => {
    let finish!: (outcome: PairingOutcome) => void;
    fake.pair.mockImplementation(() => new Promise<PairingOutcome>((resolve) => (finish = resolve)));
    await openSheet();
    await pairTyped();
    await click(mustButton('Close'));
    expect(dialog()).toBeNull();
    expect(toasts()).toEqual([]);

    finish({ kind: 'paired', deviceName: 'Desk' });
    await settle();
    expect(toasts()).toEqual([{ message: 'Paired with “Desk”.', tone: 'good' }]);
    // Reopening starts empty: the closed sheet's typed code is not kept.
    await click(mustButton('Pair with a computer'));
    await sheetLoaded();
    expect(byLabel('Six-digit code').value).toBe('');
  });

  it('reports a pairing whose answer carries no name, and the sheet does not stick open', async () => {
    // A controller that says "paired" and omits the name has still paired. The
    // toast says so, in words that are true of a missing name.
    fake.pair.mockResolvedValue({ kind: 'paired' } as unknown as PairingOutcome);
    await openSheet();
    await pairTyped();
    expect(dialog()).toBeNull();
    expect(toasts()).toEqual([{ message: 'Paired. The other machine gave no name.', tone: 'good' }]);
  });

  it('withholds a name that can disguise itself, and still reports the pairing', async () => {
    fake.pair.mockResolvedValue({ kind: 'paired', deviceName: '\u202ekoobcam' } satisfies PairingOutcome);
    await openSheet();
    await pairTyped();
    const [toast] = toasts();
    expect(toast?.message.startsWith('Paired.')).toBe(true);
    expect(toast?.message).not.toContain('koobcam');
    expect(button('Pair with a computer')).not.toBeNull();
  });
});
