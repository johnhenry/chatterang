import { registerPlugin } from '@capacitor/core';
import type { TunnelSocketPlugin } from './definitions';

export const TunnelSocket = registerPlugin<TunnelSocketPlugin>('TunnelSocket', {
  web: async () => new (await import('./web')).TunnelSocketWeb(),
});

export * from './definitions';
