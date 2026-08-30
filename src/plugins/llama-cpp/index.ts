import { registerPlugin } from '@capacitor/core';
import type { LlamaCppPlugin } from './definitions';

export const LlamaCpp = registerPlugin<LlamaCppPlugin>('LlamaCpp', {
  web: async () => new (await import('./web')).LlamaCppWeb(),
});

export * from './definitions';
