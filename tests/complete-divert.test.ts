import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { BackendAdapter, IRChatResponse, IRMessage, IRStreamChunk } from '@johnhenry/aimatey-types';
import { FunctionBackendAdapter } from '@johnhenry/aimatey-backend-browser';

import { ChatterangEngine, targetFor, type EngineTarget } from '@/ai/engine';
import type { FallbackEvent } from '@/ai/middleware/resilience';
import { markTainted } from '@/ai/taint';
import { REACH_REMOTE, reachPaired } from '@/domain/chat';
import type { ThermalState } from '@/plugins/llama-cpp';

import {
  SECRET,
  drainEvents,
  probeManifest,
  probeResolver,
  recordingBackend,
  sent,
} from './support/egress-probe';

/**
 * `complete()` must not divert a turn to the cloud fallback.
 *
 * `stream()` diverts only through its own path: only a turn that runs on this
 * device is eligible, the divert is announced as a `fallback` event before
 * anything is sent, and the egress gate runs again for the new destination, so
 * tool output is withheld unless the conversation already holds a grant. `complete()`
 * has none of that. What runs on it is the resilience middleware, and on main
 * that middleware handed the request to the nominated fallback from both of its
 * branches:
 *
 *   - the device-pressure pre-flight, for a local turn on a hot device
 *   - the failure handler, for ANY failure: it had no reach check at all, so a
 *     remote turn and a turn aimed at a paired desktop were diverted too
 *
 * The request it forwarded had been cleared for the ORIGINAL target. For a local
 * target that means nothing was withheld and the taint mark was kept, so tainted
 * history reached the cloud still marked as this app's.
 *
 * Measured on main with this file, before the guard, five of these failed: the
 * local failure resolved with the cloud's answer, and the cloud adapter was handed
 * `[..., {"role":"assistant","content":"the notes say PASSPHRASE-ORTHOGONAL-PANGOLIN-7731","metadata":{"chatterangTaint":true}}]`;
 * the hot device, the remote failure and the paired failure each reached the
 * cloud once. The streamed control passed.
 *
 * THE DEVICE IS THE REAL PRE-FLIGHT'S DEVICE. `tests/engine.test.ts` mocks
 * `checkDevicePressure` as the engine imports it. The middleware never sees that
 * mock, because it calls the function inside its own module. So this file mocks
 * one layer lower, at the Capacitor plugin both paths read, and the streamed
 * control at the bottom shows that the mock really makes the device read hot.
 * Without that control, the pre-flight tests would pass on a device that was
 * never under pressure.
 */

const NOMINAL: ThermalState = { level: 0.12, state: 'nominal', throttled: false };
const CRITICAL: ThermalState = { level: 0.95, state: 'critical', throttled: true };

const device = vi.hoisted(() => ({
  thermal: { level: 0.12, state: 'nominal', throttled: false } as {
    level: number;
    state: 'nominal' | 'fair' | 'serious' | 'critical';
    throttled: boolean;
  },
}));

vi.mock('@/plugins/llama-cpp', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/plugins/llama-cpp')>();
  return {
    ...actual,
    LlamaCpp: {
      getThermalState: async () => device.thermal,
      getCapabilities: async () => ({
        totalMemory: 8 * 1024 ** 3,
        availableMemory: 4 * 1024 ** 3,
        backends: ['cpu'],
        preferredBackend: 'cpu',
        cpuCores: 4,
        chipset: 'test',
        simulated: true,
        engineVersion: 'test',
      }),
    } as unknown as typeof actual.LlamaCpp,
  };
});

/** A backend that fails every request, the way a local engine running out of memory does. */
function failingBackend(message: string): BackendAdapter {
  return new FunctionBackendAdapter({
    execute: async () => {
      throw new Error(message);
    },
    // eslint-disable-next-line require-yield
    executeStream: async function* (): AsyncGenerator<IRStreamChunk> {
      throw new Error(message);
    },
  });
}

/** History with tool-derived text in it, so a request that reaches the cloud shows what it carried. */
const history: IRMessage[] = [
  { role: 'user', content: 'name this chat' },
  markTainted({ role: 'assistant', content: `the notes say ${SECRET}` }),
];

const local: EngineTarget = targetFor('llama-cpp', probeManifest.id, probeManifest.name, 'local-probe');

const remote: EngineTarget = {
  backendId: 'conn_primary',
  engine: 'remote',
  modelId: 'm',
  modelName: 'Primary',
  reach: REACH_REMOTE,
};

/** #197's queued turn: it runs on the user's desktop, not here. */
const paired: EngineTarget = targetFor(
  'llama-cpp',
  probeManifest.id,
  probeManifest.name,
  'tunnel_desk',
  reachPaired({ id: 'pair_1', name: 'Studio desktop' }),
);

async function settle(
  promise: Promise<IRChatResponse>,
): Promise<{ response?: IRChatResponse; error?: string }> {
  try {
    return { response: await promise };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

describe('complete() never diverts a turn to the fallback', () => {
  let onFallback: ReturnType<typeof vi.fn<(event: FallbackEvent) => void>>;
  let engine: ChatterangEngine;
  let cloud: ReturnType<typeof recordingBackend>;

  beforeEach(() => {
    device.thermal = NOMINAL;
    onFallback = vi.fn<(event: FallbackEvent) => void>();
    engine = new ChatterangEngine({ resolver: probeResolver, fallbackBackendId: null, onFallback });
    cloud = recordingBackend(['ANSWERED BY THE CLOUD.']);
    engine.router.register('conn_cloud', cloud.adapter);
    engine.setFallbackBackend('conn_cloud');
  });

  /* ── The failure handler ───────────────────────────────────────────── */

  it('surfaces a local failure rather than sending the turn to the nominated fallback', async () => {
    engine.router.register('local-probe', failingBackend('not enough memory'));

    const outcome = await settle(engine.complete({ messages: history, target: local }));

    // What the defect did: the cloud was handed the request, SECRET included.
    expect(sent(cloud.seen).join('')).not.toContain(SECRET);
    expect(cloud.seen).toHaveLength(0);
    expect(onFallback).not.toHaveBeenCalled();

    // The failure is what the caller gets.
    expect(outcome.response).toBeUndefined();
    expect(outcome.error).toContain('not enough memory');
  });

  it('fails with the same error a caller with no fallback nominated gets', async () => {
    // The paired control for the test above: a refused divert must look like
    // "nothing nominated", not like a new failure of its own.
    engine.router.register('local-probe', failingBackend('not enough memory'));
    const refused = await settle(engine.complete({ messages: history, target: local }));

    const bare = new ChatterangEngine({ resolver: probeResolver, fallbackBackendId: null });
    bare.router.register('local-probe', failingBackend('not enough memory'));
    const unnominated = await settle(bare.complete({ messages: history, target: local }));

    expect(unnominated.error).toBeDefined();
    expect(refused.error).toBe(unnominated.error);
  });

  /*
   * The two below pin the REFUSAL on this path, not the reach check. The engine
   * supplies no `clearForFallback`, so the middleware refuses before reach
   * matters, and both would still pass with `isLocal` removed from the failure
   * handler (measured). The reach check is pinned by the middleware unit tests
   * "does not divert a remote failure, even where diverting is allowed" and
   * "does not divert a turn declared not local, whatever its backend is called".
   */
  it('does not divert a remote failure', async () => {
    engine.router.register('conn_primary', failingBackend('provider 500'));

    const outcome = await settle(engine.complete({ messages: history, target: remote }));

    expect(cloud.seen).toHaveLength(0);
    expect(outcome.error).toContain('provider 500');
  });

  it('does not divert a failed turn aimed at a paired device', async () => {
    engine.router.register('tunnel_desk', failingBackend('desktop asleep'));

    const outcome = await settle(engine.complete({ messages: history, target: paired }));

    expect(cloud.seen).toHaveLength(0);
    expect(outcome.error).toContain('desktop asleep');
  });

  /* ── The device-pressure pre-flight ────────────────────────────────── */

  it('does not divert a local turn on a hot device: the local backend serves it', async () => {
    device.thermal = CRITICAL;
    const onDevice = recordingBackend(['Answered on this device.']);
    engine.router.register('local-probe', onDevice.adapter);

    const response = await engine.complete({ messages: history, target: local });

    expect(cloud.seen).toHaveLength(0);
    expect(onFallback).not.toHaveBeenCalled();
    expect(onDevice.seen).toHaveLength(1);
    expect(response.message.content).toBe('Answered on this device.');
    expect(response.metadata.custom?.fallbackTo).toBeUndefined();
  });

  it('does not divert a turn aimed at a paired device when this phone is hot', async () => {
    // The phone's temperature says nothing about the desktop's. `custom.local` is
    // false for this target, so the pre-flight never applied to it, and this
    // passed on main too. Pinned so it stays true if `local` stops being derived
    // from `reach.host`.
    device.thermal = CRITICAL;
    const desk = recordingBackend(['Answered on the desktop.']);
    engine.router.register('tunnel_desk', desk.adapter);

    const response = await engine.complete({ messages: history, target: paired });

    expect(cloud.seen).toHaveLength(0);
    expect(desk.seen).toHaveLength(1);
    expect(response.message.content).toBe('Answered on the desktop.');
  });

  /* ── The control that makes the pre-flight tests mean something ───── */

  it('control: on the same hot device, stream() still diverts, announced, and withholds the tool output', async () => {
    // Shows the plugin mock above makes the device read hot. `checkDevicePressure`
    // is also what the middleware's own pre-flight calls, reading the same plugin.
    device.thermal = CRITICAL;
    engine.router.register('local-probe', recordingBackend(['should not be used']).adapter);

    const events = await drainEvents(engine.stream({ messages: history, target: local }));

    const fallback = events.find((event) => event.type === 'fallback');
    expect(fallback?.type === 'fallback' ? fallback.event.reason : null).toBe('thermal');
    expect(onFallback).toHaveBeenCalledOnce();
    expect(cloud.seen).toHaveLength(1);
    // No policy and a fallback-chosen destination: the gate withholds.
    expect(sent(cloud.seen)[0]).not.toContain(SECRET);
    expect(events.some((event) => event.type === 'egress')).toBe(true);
  });
});
