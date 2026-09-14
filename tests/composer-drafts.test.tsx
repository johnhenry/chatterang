/**
 * AN IMAGE THAT NEVER BECAME PART OF A MESSAGE DOES NOT STAY ON THE DEVICE.
 *
 * The composer writes an image's payload to the blob table the moment it is
 * ATTACHED, before any message exists to name it. Removing the chip, or leaving
 * the draft behind — `App.tsx` unmounts the chat screen, and this composer with
 * it, on every switch to another tab — left the payload on disk. Nothing named
 * it, so neither deleting a chat nor anything else ever took it, and no screen
 * could show it.
 *
 * The REAL `Composer` is mounted, in a real DOM, over the real `lib/blobs.ts`.
 * The blob table is held in memory at the table boundary; a write can be held
 * open, which is how an image is still being written when the composer goes.
 *
 * A draft's payload is also HELD while it is being composed, so the sweep that
 * deletes payloads no message names (`sweepOrphanBlobs`) cannot take an image
 * someone is about to send. The composer lets go when it hands the image over:
 * from there the send holds it, which `tests/chat-removal.test.ts` measures
 * through the real store.
 */

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { stage } from './support/stage';

const fake = vi.hoisted(() => {
  const blobs = new Map<string, { id: string }>();
  /** Every id whose write has landed. */
  const landed = new Set<string>();
  const listeners = new Set<() => void>();
  const changed = (): void => {
    for (const listener of [...listeners]) listener();
  };
  let holding: Promise<void> | null = null;
  let releaseHold = (): void => {};

  const db = {
    blobs: {
      // Applied once it is let go: a held write has not landed.
      put: vi.fn(async (row: { id: string }) => {
        changed();
        if (holding) await holding;
        blobs.set(row.id, row);
        landed.add(row.id);
        changed();
      }),
      get: vi.fn(async (id: string) => blobs.get(id)),
      bulkDelete: vi.fn(async (ids: string[]) => {
        for (const id of ids) blobs.delete(id);
        changed();
      }),
      toCollection: () => ({ primaryKeys: async () => [...blobs.keys()] }),
    },
    // No message names anything: every payload here is a draft's.
    messages: { each: vi.fn(async () => {}) },
  };

  return {
    db,
    blobs,
    landed,
    /** Resolves once `holds()` is true: at once if it already is, otherwise on the table change that makes it so. */
    when(holds: () => boolean): Promise<void> {
      if (holds()) return Promise.resolve();
      return new Promise<void>((resolve) => {
        const listener = (): void => {
          if (!holds()) return;
          listeners.delete(listener);
          resolve();
        };
        listeners.add(listener);
      });
    },
    holdWrites(): void {
      holding = new Promise<void>((resolve) => (releaseHold = resolve));
    },
    releaseWrites(): void {
      holding = null;
      releaseHold();
    },
    reset(): void {
      blobs.clear();
      landed.clear();
      listeners.clear();
      holding = null;
      releaseHold();
    },
  };
});

vi.mock('@/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/db')>()),
  db: fake.db,
}));

const { Composer } = await import('@/features/chat/Composer');
const { sweepOrphanBlobs } = await import('@/lib/blobs');

type Attachment = import('@/domain/chat').Attachment;

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  fake.reset();
  vi.clearAllMocks();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  // The chip previews the payload through an object URL, which jsdom lacks.
  Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:preview'), revokeObjectURL: vi.fn() });
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  container?.remove();
  container = null;
});

const macrotask = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

async function mount(onSend: (text: string, attachments: Attachment[]) => void = () => undefined): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      createElement(Composer, {
        disabled: false,
        generating: false,
        acceptsImages: true,
        placeholder: 'Message',
        onSend,
        onStop: () => undefined,
      }),
    );
  });
}

async function unmount(): Promise<void> {
  await act(async () => root?.unmount());
  root = null;
}

/** Pick an image in the file chooser. Resolves once its write has been MADE, landed or not. */
async function pick(): Promise<string> {
  const input = container?.querySelector<HTMLInputElement>('input[type="file"]');
  if (!input) throw new Error('the composer offers no file input');
  const file = new File([new Uint8Array([137, 80, 78, 71])], 'cat.png', { type: 'image/png' });
  Object.defineProperty(input, 'files', { configurable: true, value: { 0: file, length: 1 } });
  await act(async () => {
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await stage('the image’s write to be made', fake.when(() => fake.db.blobs.put.mock.calls.length === 1));
  return (fake.db.blobs.put.mock.calls[0]![0] as { id: string }).id;
}

/** Pick an image and let its write land, and the chip render. */
async function attach(): Promise<string> {
  const id = await pick();
  await act(async () => {
    await stage('the image’s write to land', fake.when(() => fake.landed.has(id)));
    // What follows the write in the composer is promises only.
    await macrotask();
  });
  if (!chip()) throw new Error('no chip was rendered for the attached image');
  return id;
}

const chip = (): HTMLButtonElement | null =>
  container?.querySelector<HTMLButtonElement>('button[aria-label="Remove attachment"]') ?? null;

describe('an image attached and never sent', () => {
  it('is deleted from the device when its chip is removed', async () => {
    await mount();
    const id = await attach();
    expect(fake.blobs.has(id), 'the control: attaching wrote it').toBe(true);

    await act(async () => chip()?.click());

    await stage('the removed image’s payload to be deleted', fake.when(() => !fake.blobs.has(id)));
    expect(chip()).toBeNull();
  });

  it('is deleted from the device when the draft is left behind', async () => {
    // Switching to another tab unmounts the chat screen, and the draft with it.
    await mount();
    const id = await attach();

    await unmount();

    await stage('the abandoned draft’s payload to be deleted', fake.when(() => !fake.blobs.has(id)));
  });

  it('is deleted once its write lands, when the draft was left behind while it was still being written', async () => {
    // The delete made as the composer went away ran before the write landed,
    // and took nothing.
    await mount();
    fake.holdWrites();
    const id = await pick();

    await unmount();
    fake.releaseWrites();

    await stage(
      'the payload written after the draft went to be deleted',
      fake.when(() => fake.landed.has(id) && !fake.blobs.has(id)),
    );
  });

  it('is held against the sweep while it is being composed', async () => {
    await mount();
    const id = await attach();

    await sweepOrphanBlobs();

    expect(fake.blobs.has(id), 'no message names it yet, and it is still on screen').toBe(true);
    expect(chip()).not.toBeNull();
  });
});

describe('an image attached and sent', () => {
  it('is handed over, not deleted, and the composer holds it no longer', async () => {
    const sent: Attachment[][] = [];
    await mount((_text, attachments) => {
      sent.push(attachments);
    });
    const id = await attach();

    const send = container?.querySelector<HTMLButtonElement>('button[aria-label="Send"]');
    await act(async () => send?.click());
    expect(sent, 'the send was handed the image').toEqual([[expect.objectContaining({ kind: 'image', id })]]);

    // Nor when the composer then goes: the image is the message's now.
    await unmount();
    expect(fake.db.blobs.bulkDelete).not.toHaveBeenCalled();
    expect(fake.blobs.has(id)).toBe(true);

    // What holds it from here is whoever it was handed to. This `onSend` holds
    // nothing and wrote no row, so the sweep takes it: the composer did not keep
    // a hold that would have kept it on the device for ever.
    await sweepOrphanBlobs();
    expect(fake.blobs.has(id), 'the composer let go').toBe(false);
  });
});
