/**
 * Test environment shims.
 *
 * jsdom does not implement the browser APIs the app leans on, so they are
 * stubbed here rather than in each test — but only the ones whose absence
 * would break unrelated code paths. Anything a test actually asserts on is
 * stubbed inside that test instead.
 */

import { vi } from 'vitest';

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
