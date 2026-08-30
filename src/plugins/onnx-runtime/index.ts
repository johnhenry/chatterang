import { registerPlugin } from '@capacitor/core';
import type { OnnxRuntimePlugin } from './definitions';

export const OnnxRuntime = registerPlugin<OnnxRuntimePlugin>('OnnxRuntime', {
  web: async () => new (await import('./web')).OnnxRuntimeWeb(),
});

export * from './definitions';
