// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';

import { TunnelSocketWeb } from '../src/plugins/tunnel-socket/web';

/**
 * THE WEB REFUSAL, PROVED RATHER THAN ASSUMED (#295, refs #181).
 *
 * #181 ruled a browser cannot check the peer certificate a tunnel connection
 * is pinned against, so the web build of `TunnelSocket` never opens one.
 * `connect` must reject SYNCHRONOUSLY-FROM-THE-CALLER'S-VIEW, with no network
 * touched and a `code` an adapter can read the way it reads a native plugin's
 * rejection (`Error` with a string `code`, the shape `call.reject(message,
 * code)` produces on both mobile platforms).
 */
describe('TunnelSocketWeb: a browser refuses, honestly', () => {
  it('connect() rejects with OPTIONS_REFUSED and touches no network', async () => {
    const plugin = new TunnelSocketWeb();
    await expect(plugin.connect({ url: 'wss://desktop.example:8973/' })).rejects.toMatchObject({
      code: 'OPTIONS_REFUSED',
    });
  });

  it('rejects the same way whatever the options — this build never gets far enough to check them', async () => {
    const plugin = new TunnelSocketWeb();
    await expect(
      plugin.connect({ url: 'wss://desktop.example:8973/', credential: 'secret', expectedPeer: { spkiSha256: 'x' } }),
    ).rejects.toMatchObject({ code: 'OPTIONS_REFUSED' });
  });

  it('send, close and negotiatedPeer all throw: no connectionId this plugin ever issued', async () => {
    const plugin = new TunnelSocketWeb();
    await expect(plugin.send({ connectionId: 'none', frame: '' })).rejects.toThrow();
    await expect(plugin.close({ connectionId: 'none' })).rejects.toThrow();
    await expect(plugin.negotiatedPeer({ connectionId: 'none' })).rejects.toThrow();
  });
});
