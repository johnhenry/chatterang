import { describe, expect, it } from 'vitest';

import { recommendModel } from '@/domain/onboarding';
import type { Capability, ModelManifest } from '@/domain/manifest';

const GB = 1024 ** 3;

/**
 * `capabilities` is not decoration here. The recommendation ranks only models
 * that can hold a conversation, so a fixture without it is not a manifest this
 * function would ever be handed — it stands for a catalogue entry, and every
 * real catalogue entry declares what it can do.
 */
function model(
  id: string,
  sizeGB: number,
  minGB: number,
  recGB: number,
  capabilities: readonly Capability[] = ['text'],
): ModelManifest {
  return {
    id,
    sizeBytes: sizeGB * GB,
    minRAM: minGB * GB,
    recommendedRAM: recGB * GB,
    capabilities,
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

  /* ── It has to be a model you can actually talk to ─────────────────── */

  describe('models that cannot hold a conversation', () => {
    // The two smallest entries in the real catalogue are a text-to-speech
    // voice and a speech recogniser, both far smaller than any language model.
    const withSpeech = [
      ...catalog,
      model('tts-voice', 0.06, 0.5, 1, ['audio-out']),
      model('speech-to-text', 0.07, 0.5, 1, ['audio-in']),
      model('diffusion', 0.5, 1, 2, ['image-out']),
    ];

    it('never recommends one, at any device size', () => {
      for (const memory of [undefined, 0, 1 * GB, 2 * GB, 4 * GB, 8 * GB, 16 * GB]) {
        const pick = recommendModel(withSpeech, memory);
        expect(pick?.manifest.capabilities).toContain('text');
      }
    });

    it('recommends a language model on a device that reports nothing', () => {
      // THE EMULATOR CASE. `getCapabilities()` fails, `device` is null, and
      // this branch takes the smallest in the catalogue — which, unfiltered,
      // was a 63 MB text-to-speech voice offered as the app's language model.
      const pick = recommendModel(withSpeech, undefined);
      expect(pick?.manifest.id).toBe('small');
      expect(pick?.fit).toBe('tight');
    });

    it('returns null when the catalogue has nothing that can chat', () => {
      // Not the same as an empty catalogue, and it must not resolve to "the
      // smallest of the wrong things".
      expect(recommendModel([model('tts-voice', 0.06, 0.5, 1, ['audio-out'])], 16 * GB)).toBeNull();
    });
  });
});
