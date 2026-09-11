import { registerPlugin } from '@capacitor/core';
import type { MountHostPlugin } from './definitions';

export const MountHost = registerPlugin<MountHostPlugin>('MountHost', {
  web: async () => new (await import('./web')).MountHostWeb(),
});

export * from './definitions';
