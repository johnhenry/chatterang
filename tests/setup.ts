/**
 * Test environment shims.
 *
 * jsdom does not implement the browser APIs the app leans on, so they are
 * stubbed here rather than in each test — but only the ones whose absence
 * would break unrelated code paths. Anything a test actually asserts on is
 * stubbed inside that test instead.
 */

import { vi } from 'vitest';

import { broadcastChannels, setBroadcastChannel } from './support/broadcast-channel';
import { setNavigatorLocks, webLocks } from './support/web-locks';

// Web Locks, which `src/lib/blobs.ts` uses to see whether another window of the
// origin is open before its launch sweep deletes anything. jsdom has none, and
// without them no sweep runs. A fresh set for every file, in memory: Node's own
// are per thread and outlive a file. See `tests/support/web-locks.ts`.
{
  const locks = webLocks();
  (globalThis as { __webLocks?: unknown }).__webLocks = locks;
  setNavigatorLocks(locks.window());
}

// BroadcastChannel, which `src/lib/other-windows.ts` uses to tell the other
// windows of the origin what one of them did. A fresh set for every file, in
// memory, so no message crosses from one file's windows to another's. See
// `tests/support/broadcast-channel.ts`.
{
  const channels = broadcastChannels();
  (globalThis as { __broadcastChannels?: unknown }).__broadcastChannels = channels;
  setBroadcastChannel(channels.window().BroadcastChannel);
}

if (!('crypto' in globalThis) || typeof globalThis.crypto.randomUUID !== 'function') {
  Object.defineProperty(globalThis, 'crypto', {
    value: {
      ...globalThis.crypto,
      randomUUID: () => `${Math.random().toString(16).slice(2)}-0000-0000-0000-000000000000`,
    },
    configurable: true,
  });
}

if (typeof globalThis.performance === 'undefined') {
  Object.defineProperty(globalThis, 'performance', {
    value: { now: () => Date.now() },
    configurable: true,
  });
}

// The dictation and speech paths call these; the tests that care replace them.
Object.defineProperty(globalThis, 'speechSynthesis', {
  value: {
    speak: vi.fn(),
    cancel: vi.fn(),
    getVoices: () => [],
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  },
  configurable: true,
  writable: true,
});
