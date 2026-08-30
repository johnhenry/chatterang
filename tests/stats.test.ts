import { describe, expect, it } from 'vitest';

import { readStats } from '@/ai/engine';

/**
 * `readStats` decides which numbers the native plugins report actually reach
 * the UI. A field it drops is invisible everywhere downstream and fails
 * silently — no error, just a readout that never appears. That is precisely
 * what happened to `draftAcceptance`, which the llama.cpp plugin has reported
 * since it landed and which nothing rendered.
 */
describe('native metrics reaching the UI', () => {
  it('carries every metric the plugins report', () => {
    const stats = readStats({
      ttftMs: 120,
      cachedTokens: 900,
      tokensPerSecond: 31.5,
      draftAcceptance: 0.72,
      peakMemoryBytes: 2_400_000_000,
      computeBackend: 'metal',
    });

    expect(stats).toEqual({
      ttftMs: 120,
      cachedTokens: 900,
      tokensPerSecond: 31.5,
      draftAcceptance: 0.72,
      peakMemoryBytes: 2_400_000_000,
      computeBackend: 'metal',
    });
  });

  it('keeps a zero, which is a real reading and not a missing one', () => {
    // 0% draft acceptance means speculation is paying for nothing — the single
    // most actionable value this metric can take. A truthiness check would drop
    // it, which is the same falsy-zero bug that bit the Gemini adapter.
    expect(readStats({ draftAcceptance: 0 }).draftAcceptance).toBe(0);
    expect(readStats({ cachedTokens: 0 }).cachedTokens).toBe(0);
  });

  it('ignores values of the wrong type rather than passing them through', () => {
    const stats = readStats({ tokensPerSecond: 'fast', computeBackend: 42 });
    expect(stats.tokensPerSecond).toBeUndefined();
    expect(stats.computeBackend).toBeUndefined();
  });

  it('returns an empty snapshot when the plugin reported nothing', () => {
    expect(readStats(undefined)).toEqual({});
  });
});
