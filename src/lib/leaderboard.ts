/**
 * Leaderboard publishing (PRD §3.6).
 *
 * The only outbound network call the app makes that is not a model download
 * or an explicitly configured remote provider. It is per-run, opt-in, and the
 * exact payload is shown to the user before it is sent — see the consent
 * sheet in the Benchmarks screen.
 */

import type { BenchmarkRun } from '@/db';

const ENDPOINT = import.meta.env.VITE_LEADERBOARD_URL ?? '';

/**
 * Exactly what leaves the device. Deliberately contains no identifiers: no
 * install id, no device serial, no timestamps precise enough to correlate.
 * The date is truncated to the day for the same reason.
 */
export interface LeaderboardPayload {
  readonly model: string;
  readonly quantization: string;
  readonly engine: string;
  readonly computeBackend: string;
  readonly chipset: string;
  readonly promptTokensPerSecond: number;
  readonly generateTokensPerSecond: number;
  readonly peakMemoryMB: number;
  readonly repetitions: number;
  readonly day: string;
  readonly appVersion: string;
}

export function buildPayload(run: BenchmarkRun, quantization = ''): LeaderboardPayload {
  return {
    model: run.modelName,
    quantization,
    engine: run.engine,
    computeBackend: run.backend,
    chipset: run.chipset,
    promptTokensPerSecond: Number(run.promptTokensPerSecond.toFixed(2)),
    generateTokensPerSecond: Number(run.generateTokensPerSecond.toFixed(2)),
    peakMemoryMB: Math.round(run.peakMemoryBytes / 1024 / 1024),
    repetitions: run.repetitions,
    day: new Date(run.createdAt).toISOString().slice(0, 10),
    appVersion: __APP_VERSION__,
  };
}

export async function publishRun(run: BenchmarkRun): Promise<void> {
  if (!ENDPOINT) {
    throw new Error(
      'No leaderboard endpoint is configured in this build, so there is nowhere to publish to.',
    );
  }

  const response = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(buildPayload(run)),
  });

  if (!response.ok) {
    throw new Error(`The leaderboard rejected the run (${response.status}).`);
  }
}
