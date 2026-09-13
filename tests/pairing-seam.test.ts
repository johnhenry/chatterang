import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ADDRESS_DNS,
  ADDRESS_IPV4,
  HOST_DESKTOP,
  TRUST_SPKI_PIN,
  TRUST_STATIC_KEY,
  type PairingPayload,
} from '@chatterang/tunnel/pairing';
import { UNAVAILABLE_PAIRING, pairingController, validateScannedPayload } from '@/lib/pairing';

const text = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));

function payload(over: Partial<PairingPayload> = {}): PairingPayload {
  return {
    version: 1,
    hostKind: HOST_DESKTOP,
    trustMode: TRUST_SPKI_PIN,
    trust: new Uint8Array(32).fill(1),
    token: new Uint8Array(32).fill(2),
    expiresAt: 1_000,
    port: 8973,
    addresses: [{ kind: ADDRESS_IPV4, value: Uint8Array.of(192, 168, 1, 4) }],
    name: 'Desk',
    ...over,
  } as PairingPayload;
}

describe('validating a scanned payload before the confirm step', () => {
  it('lets a valid, unexpired, reachable payload through', () => {
    expect(validateScannedPayload(payload(), 999)).toEqual({ ok: true });
  });

  it('refuses an expired one — expiry is absolute wall-clock seconds', () => {
    expect(validateScannedPayload(payload(), 1_000)).toEqual({ ok: false, problem: 'expired' });
  });

  it('refuses a trust mode this build cannot interpret, BEFORE checking expiry', () => {
    // Calling an unreadable payload "expired" would send the person to draw a
    // new code that fails the same way.
    expect(validateScannedPayload(payload({ trustMode: TRUST_STATIC_KEY }), 5_000)).toEqual({ ok: false, problem: 'unsupported-trust-mode' });
  });

  it('refuses a payload whose EVERY address is a .local name', () => {
    const local = { kind: ADDRESS_DNS, value: text('desk.local') } as const;
    expect(validateScannedPayload(payload({ addresses: [local] }), 999)).toEqual({ ok: false, problem: 'unreachable' });
  });

  it('accepts one reachable address among .local ones — the paired control', () => {
    const local = { kind: ADDRESS_DNS, value: text('desk.local') } as const;
    const lan = { kind: ADDRESS_IPV4, value: Uint8Array.of(10, 0, 0, 5) } as const;
    expect(validateScannedPayload(payload({ addresses: [local, lan] }), 999)).toEqual({ ok: true });
  });
});

describe('the controller this build has', () => {
  afterEach(() => vi.restoreAllMocks());

  it('is unavailable, so no entry point asks for a camera it cannot use', () => {
    expect(pairingController()).toBe(UNAVAILABLE_PAIRING);
    expect(pairingController().available).toBe(false);
  });

  it('refuses honestly and touches no network', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const socket = vi.fn();
    const original = globalThis.WebSocket;
    (globalThis as { WebSocket: unknown }).WebSocket = socket;
    try {
      const outcome = await UNAVAILABLE_PAIRING.pair({ route: 'scanned', payload: payload() });
      expect(outcome).toEqual({ kind: 'refused', reason: 'transport-unavailable' });
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(socket).not.toHaveBeenCalled();
    } finally {
      (globalThis as { WebSocket: unknown }).WebSocket = original;
    }
  });
});
