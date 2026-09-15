import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { BackendAdapter, IRChatRequest, IRMessage, IRStreamChunk } from '@johnhenry/aimatey-types';
import { FunctionBackendAdapter } from '@johnhenry/aimatey-backend-browser';

import { ChatterangEngine, targetFor, type EngineTarget, type GenerationEvent } from '@/ai/engine';
import type { FallbackEvent } from '@/ai/middleware/resilience';
import { reachPaired } from '@/domain/chat';
import type { ThermalState } from '@/plugins/llama-cpp';

import { drainEvents, probeManifest, probeResolver, recordingBackend } from './support/egress-probe';

/**
 * `stream()` never diverts a turn that is tunnelled to a paired device (refs #188, refs #194).
 *
 * THE PAIR OF THIS FILE is `tests/complete-divert.test.ts:196` ("does not divert
 * a failed turn aimed at a paired device") and `:221` ("does not divert a turn
 * aimed at a paired device when this phone is hot"). Those pin `complete()`.
 * Nothing pinned the streamed path for a paired target, and every chat turn in
 * this app streams.
 *
 * `stream()` has three places that can retarget a turn at the nominated cloud
 * fallback, and each is gated on `runsOnThisDevice(target)`:
 *
 *   - the device-pressure pre-flight               (src/ai/engine.ts:737)
 *   - the open-circuit guard before the egress gate (src/ai/engine.ts:807)
 *   - the loop's failure handler                   (src/ai/engine.ts:984)
 *
 * A paired desktop is not this device, so none of them applies: there is nothing
 * on this phone to divert FROM. The phone's temperature says nothing about the
 * desktop's, a paused tunnel is not a paused local engine, and a desktop that
 * failed a turn must fail it where the user can see, not hand the conversation to
 * a provider the user aimed away from.
 *
 * Every pin below passes on main. They are guards against the predicate drifting,
 * and the one drift that is easy to write is reading the wrong axis: `reach.reached`
 * or `reach.host.kind !== 'third-party'` both answer "yes" for `paired`. Each pin
 * has a LOCAL CONTROL on the same rig that DOES divert, so a pin cannot pass
 * because the fallback was never live, the circuit never opened or the device
 * never read hot.
 *
 * The device is the real pre-flight's device: the plugin `checkDevicePressure`
 * reads is mocked, not the function, as `complete-divert.test.ts` does, so the
 * reading of 0.95 goes through the shipped threshold.
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

const TUNNEL = 'tunnel:pair_1';
const CLOUD = 'conn_cloud';
const LOCAL = 'local-probe';

const DESKTOP_ASLEEP = 'the desktop is asleep';
const TUNNEL_CLOSED = 'the desktop closed the tunnel';
const DESKTOP_ANSWER = 'Answered on the desktop.';
const LOCAL_ANSWER = 'Answered on this device.';
const CLOUD_ANSWER = 'ANSWERED BY THE CLOUD.';

/** One tunnel adapter per device, registered as `tunnel:<deviceId>`. */
const paired: EngineTarget = targetFor(
  'remote',
  probeManifest.id,
  'Qwen on Studio',
  TUNNEL,
  reachPaired({ id: 'pair_1', name: 'Studio' }),
);

/** The control: a turn that DOES run here, on the same rig. */
const local: EngineTarget = targetFor('llama-cpp', probeManifest.id, probeManifest.name, LOCAL);

const history: IRMessage[] = [{ role: 'user', content: 'what is on my calendar today' }];

type Mode = 'answers' | 'throws' | 'error-chunk';

/**
 * A backend that records every streamed request it is handed, then answers,
 * throws, or reports failure as an error chunk. Both kinds of failure reach the
 * same failure handler (engine.ts:967-975); both are pinned.
 */
function scripted(mode: Mode, answer: string): { adapter: BackendAdapter; seen: IRChatRequest[] } {
  const seen: IRChatRequest[] = [];
  const adapter = new FunctionBackendAdapter({
    execute: async () => {
      throw new Error('this file drives stream(), not complete()');
    },
    executeStream: async function* (request): AsyncGenerator<IRStreamChunk> {
      seen.push(structuredClone(request));
      if (mode === 'throws') throw new Error(DESKTOP_ASLEEP);
      yield { type: 'start', sequence: 0, metadata: request.metadata };
      if (mode === 'error-chunk') {
        yield { type: 'error', sequence: 1, error: { code: 'TUNNEL_CLOSED', message: TUNNEL_CLOSED } };
        return;
      }
      yield { type: 'content', sequence: 1, delta: answer };
      yield { type: 'done', sequence: 2, finishReason: 'stop' };
    },
  });
  return { adapter, seen };
}

function fallbacks(events: readonly GenerationEvent[]): FallbackEvent[] {
  return events.flatMap((event) => (event.type === 'fallback' ? [event.event] : []));
}

function lastError(events: readonly GenerationEvent[]): string | undefined {
  const last = events.at(-1);
  return last?.type === 'error' ? last.message : undefined;
}

function doneText(events: readonly GenerationEvent[]): string | undefined {
  const done = events.find((event) => event.type === 'done');
  return done?.type === 'done' ? done.text : undefined;
}

describe('a turn tunnelled to a paired device', () => {
  let onFallback: ReturnType<typeof vi.fn<(event: FallbackEvent) => void>>;
  let engine: ChatterangEngine;
  let cloud: ReturnType<typeof recordingBackend>;

  beforeEach(() => {
    device.thermal = NOMINAL;
    onFallback = vi.fn<(event: FallbackEvent) => void>();
    // A real Router: the engine builds its own, with the shipped breaker.
    engine = new ChatterangEngine({ resolver: probeResolver, fallbackBackendId: null, onFallback });
    cloud = recordingBackend([CLOUD_ANSWER]);
    engine.router.register(CLOUD, cloud.adapter);
    engine.setFallbackBackend(CLOUD);
  });

  /* ── (a) The failure handler, engine.ts:984 ────────────────────────── */

  describe.each([
    ['throws', DESKTOP_ASLEEP],
    ['error-chunk', TUNNEL_CLOSED],
  ] as const)('(a) the tunnel backend %s', (mode, failure) => {
    it('surfaces the failure: no fallback event, the cloud is never called, the turn ends in error', async () => {
      const desk = scripted(mode, DESKTOP_ANSWER);
      engine.router.register(TUNNEL, desk.adapter);

      const events = await drainEvents(engine.stream({ messages: history, target: paired }));

      // The tunnel really was asked: this is the failure handler, not the
      // unregistered-backend backstop above the pre-flight.
      expect(desk.seen).toHaveLength(1);

      expect(fallbacks(events)).toEqual([]);
      expect(onFallback).not.toHaveBeenCalled();
      expect(cloud.seen).toHaveLength(0);

      expect(events.some((event) => event.type === 'done')).toBe(false);
      expect(events.at(-1)?.type).toBe('error');
      expect(lastError(events)).toContain(failure);
    });

    it('control: the same failure on a local turn IS diverted to the nominated cloud', async () => {
      const onDevice = scripted(mode, LOCAL_ANSWER);
      engine.router.register(LOCAL, onDevice.adapter);

      const events = await drainEvents(engine.stream({ messages: history, target: local }));

      expect(onDevice.seen).toHaveLength(1);
      expect(fallbacks(events)).toMatchObject([{ from: LOCAL, to: CLOUD }]);
      expect(cloud.seen).toHaveLength(1);
      expect(doneText(events)).toBe(CLOUD_ANSWER);
    });
  });

  /* ── (b) The open-circuit guard, engine.ts:807 ─────────────────────── */

  describe('(b) the tunnel backend’s circuit is open', () => {
    it('refuses: no fallback event, the cloud is never called, the turn ends in error', async () => {
      const desk = scripted('answers', DESKTOP_ANSWER);
      engine.router.register(TUNNEL, desk.adapter);
      engine.router.openCircuitBreaker(TUNNEL);

      // The precondition, asked the way the guard asks it.
      expect(engine.router.isBackendAvailable(TUNNEL)).toBe(false);
      expect(engine.router.isBackendAvailable(CLOUD)).toBe(true);

      const events = await drainEvents(engine.stream({ messages: history, target: paired }));

      expect(fallbacks(events)).toEqual([]);
      expect(onFallback).not.toHaveBeenCalled();
      expect(cloud.seen).toHaveLength(0);
      // Nothing was sent anywhere: the paused tunnel is not tried either.
      expect(desk.seen).toHaveLength(0);

      expect(events.some((event) => event.type === 'done')).toBe(false);
      expect(events.at(-1)?.type).toBe('error');
      // The guard's own sentence, about the model the user chose.
      expect(lastError(events)).toContain('Qwen on Studio');
      expect(lastError(events)).toContain('paused');
      expect(lastError(events)).not.toContain(CLOUD);
    });

    it('control: a local turn whose circuit is open IS diverted to the nominated cloud', async () => {
      const onDevice = scripted('answers', LOCAL_ANSWER);
      engine.router.register(LOCAL, onDevice.adapter);
      engine.router.openCircuitBreaker(LOCAL);
      expect(engine.router.isBackendAvailable(LOCAL)).toBe(false);

      const events = await drainEvents(engine.stream({ messages: history, target: local }));

      expect(fallbacks(events)).toMatchObject([{ reason: 'engine-error', from: LOCAL, to: CLOUD }]);
      expect(onDevice.seen).toHaveLength(0);
      expect(cloud.seen).toHaveLength(1);
      expect(doneText(events)).toBe(CLOUD_ANSWER);
    });
  });

  /* ── (c) The device-pressure pre-flight, engine.ts:737 ─────────────── */

  describe('(c) this phone is hot (thermal 0.95)', () => {
    it('still sends the turn to the tunnel, and not to the cloud', async () => {
      device.thermal = CRITICAL;
      const desk = scripted('answers', DESKTOP_ANSWER);
      engine.router.register(TUNNEL, desk.adapter);

      const events = await drainEvents(engine.stream({ messages: history, target: paired }));

      expect(desk.seen).toHaveLength(1);
      expect(cloud.seen).toHaveLength(0);
      expect(fallbacks(events)).toEqual([]);
      expect(onFallback).not.toHaveBeenCalled();
      expect(events.at(-1)?.type).toBe('done');
      expect(doneText(events)).toBe(DESKTOP_ANSWER);
    });

    it('control: on the same hot phone a local turn IS diverted, so the device really reads hot', async () => {
      device.thermal = CRITICAL;
      const onDevice = scripted('answers', LOCAL_ANSWER);
      engine.router.register(LOCAL, onDevice.adapter);

      const events = await drainEvents(engine.stream({ messages: history, target: local }));

      expect(fallbacks(events)).toMatchObject([{ reason: 'thermal', from: LOCAL, to: CLOUD }]);
      expect(onDevice.seen).toHaveLength(0);
      expect(cloud.seen).toHaveLength(1);
      expect(doneText(events)).toBe(CLOUD_ANSWER);
    });
  });
});
