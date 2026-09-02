/**
 * First-run model recommendation.
 *
 * This app has an unusual first-run problem: it does nothing until a
 * multi-gigabyte file has been downloaded, and that is a large commitment to
 * ask of someone who does not yet know what they are getting. A carousel
 * explaining features would make that worse — more friction before any value.
 *
 * What actually helps is the one thing a generic onboarding cannot do: this app
 * knows what device it is running on, and the catalogue knows what each model
 * needs. So it can name *one* model, say what it costs to download, and say why
 * that one. Everything else is a link to the path that requires no download at
 * all.
 */

import { canChat, type ModelManifest } from '@/domain/manifest';

export interface DeviceFit {
  readonly manifest: ModelManifest;
  /** `comfortable` clears recommendedRAM; `tight` only clears minRAM. */
  readonly fit: 'comfortable' | 'tight';
}

/**
 * The model to suggest for a device with this much memory.
 *
 * Prefers the most capable model the device is comfortable with, because a
 * first impression formed on a model that swaps and stutters is worse than one
 * formed on a smaller model that answers promptly. Falls back to the largest
 * that merely fits, and finally — when nothing fits, which is a real case on
 * older hardware — to the smallest in the catalogue, flagged as tight so the
 * caller can say so rather than pretending.
 *
 * Returns null only for an empty catalogue.
 */
export function recommendModel(
  catalog: readonly ModelManifest[],
  totalMemory: number | undefined,
): DeviceFit | null {
  /*
   * ONLY MODELS THAT CAN ANSWER. This function's whole job is naming the one
   * model a new user should download in order to start chatting, and it used to
   * rank the entire catalogue by size alone.
   *
   * That is not a hypothetical. The two smallest entries in the catalogue are a
   * text-to-speech voice (63.2 MB) and a speech recogniser (64.3 MB), and the
   * "no device profile" branch below picks the smallest — so a device whose
   * llama.cpp plugin cannot report its memory, which is exactly an emulator,
   * was offered "Start with Amy (neural voice, US English)" as its language
   * model. Measured across memory sizes: the unknown-memory branch was the only
   * one that picked a non-chat model, and it is the branch an emulator lands on.
   *
   * Filtering the candidates rather than checking the winner is the point: the
   * ranking below cannot pick something wrong if the wrong things are not in it.
   */
  const candidates = catalog.filter(canChat);
  if (candidates.length === 0) return null;

  const bySizeDesc = [...candidates].sort((a, b) => b.sizeBytes - a.sizeBytes);

  // Without a device profile — the web shim, or before the plugin has
  // reported — recommend the smallest rather than guessing high. Being wrong
  // downwards costs a smaller download; being wrong upwards costs a model that
  // will not run.
  if (typeof totalMemory !== 'number' || totalMemory <= 0) {
    const smallest = bySizeDesc[bySizeDesc.length - 1];
    return smallest ? { manifest: smallest, fit: 'tight' } : null;
  }

  const comfortable = bySizeDesc.find((m) => totalMemory >= m.recommendedRAM);
  if (comfortable) return { manifest: comfortable, fit: 'comfortable' };

  const fits = bySizeDesc.find((m) => totalMemory >= m.minRAM);
  if (fits) return { manifest: fits, fit: 'tight' };

  const smallest = bySizeDesc[bySizeDesc.length - 1];
  return smallest ? { manifest: smallest, fit: 'tight' } : null;
}
