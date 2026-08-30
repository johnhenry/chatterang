import { describe, expect, it } from 'vitest';

import { recommendModel } from '@/domain/onboarding';
import type { ModelManifest } from '@/domain/manifest';

const GB = 1024 ** 3;

function model(id: string, sizeGB: number, minGB: number, recGB: number): ModelManifest {
  return {
    id,
    sizeBytes: sizeGB * GB,
    minRAM: minGB * GB,
    recommendedRAM: recGB * GB,
  } as unknown as ModelManifest;
}

const catalog = [
  model('small', 1, 2, 3),
  model('medium', 2, 3, 6),
  model('large', 5, 6, 12),
];

describe('first-run model recommendation', () => {
  it('picks the most capable model the device is comfortable with', () => {
    const result = recommendModel(catalog, 16 * GB);
    expect(result?.manifest.id).toBe('large');
    expect(result?.fit).toBe('comfortable');
  });

  it('steps down rather than recommending one that will stutter', () => {
    // 8GB clears large's minRAM (6) but not its recommendedRAM (12). A first
    // impression formed on a model that swaps is worse than one formed on a
    // smaller model that answers promptly.
    const result = recommendModel(catalog, 8 * GB);
    expect(result?.manifest.id).toBe('medium');
    expect(result?.fit).toBe('comfortable');
  });

  it('falls back to what merely fits, and says so', () => {
    // 2GB clears only small's minRAM.
    const result = recommendModel(catalog, 2 * GB);
    expect(result?.manifest.id).toBe('small');
    expect(result?.fit).toBe('tight');
  });

  it('still suggests something when nothing fits, flagged tight', () => {
    // Real case on older hardware. Recommending nothing leaves a dead end;
    // recommending the smallest with an honest label does not.
    const result = recommendModel(catalog, 1 * GB);
    expect(result?.manifest.id).toBe('small');
    expect(result?.fit).toBe('tight');
  });

  it('guesses low when the device has not reported', () => {
    // The web shim, or before the plugin answers. Being wrong downwards costs
    // a smaller download; being wrong upwards costs a model that will not run.
    for (const unknown of [undefined, 0]) {
      const result = recommendModel(catalog, unknown);
      expect(result?.manifest.id).toBe('small');
      expect(result?.fit).toBe('tight');
    }
  });

  it('returns null only for an empty catalogue', () => {
    expect(recommendModel([], 16 * GB)).toBeNull();
  });
});
