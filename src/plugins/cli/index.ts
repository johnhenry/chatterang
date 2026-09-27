import { registerPlugin } from '@capacitor/core';
import type { CliPlugin } from './definitions';

export const Cli = registerPlugin<CliPlugin>('Cli', {
  web: async () => new (await import('./web')).CliWeb(),
});

export * from './definitions';
