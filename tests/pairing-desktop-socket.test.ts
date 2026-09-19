// @vitest-environment node
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, expectTypeOf, it } from 'vitest';

import { PluginHost, TUNNEL_SOCKET_PLUGIN } from '../apps/desktop/src/bridge/index.js';
import { createTunnelSocketPlugin } from '../apps/desktop/src/net/tunnel-socket.js';
import type { ListenerHandle } from '@chatterang/contracts';
import type { NegotiatedPeerCertificate, TunnelSocketEventName } from '@chatterang/contracts/tunnel-socket';
import { channelIdentifierFor, type PairingRoute } from '@chatterang/tunnel/binding';
import {
  asTlsMaterial,
  createTunnelListener,
  generateTunnelKey,
  issueTunnelCertificate,
  tunnelKeyPkcs8Pem,
  type Tunnel,
} from '@chatterang/tunnel/host';
import { ADDRESS_IPV4, HOST_DESKTOP, TRUST_SPKI_PIN, type PairingPayload } from '@chatterang/tunnel/pairing';
import { PairingConnectionClosedError, openBoundPairingConnection, type PairingSocket } from '@/lib/pairing';
import type { TunnelSocket } from '@/plugins/tunnel-socket';

import { testGate } from './support/tunnel-gate.js';

/**
 * THE PAIRING SEAM OVER A REAL SOCKET PLUGIN (#256, over #295's plugin).
 *
 * `tests/pairing-seam.test.ts` drives `openBoundPairingConnection` over a fake
 * plugin, which can stage what no real plugin should do. This drives the same
 * function over the one leg of the plugin that runs here: the Electron
 * desktop's, `apps/desktop/src/net/tunnel-socket.ts`, registered in a real
 * `PluginHost` under `TUNNEL_SOCKET_PLUGIN` (so its method and event names are
 * checked against that declaration), dialling a real `createTunnelListener`
 * over real TLS with a pairing window open. Such a connection presents no
 * credential and is admitted as a pairing tunnel.
 *
 * WHAT STANDS IN: the last hop to a renderer. `PluginHost` delivers to a
 * function here rather than through `createRendererBridge` and the Capacitor
 * shim to a page; `tests/desktop-bridge.test.ts` covers that hop. The iOS and
 * Android legs in `native/plugin-tunnel-socket/` are not run by anything here.
 *
 * The CPace exchange is not defined, so nothing is sent on a bound connection.
 * This proves the binding's input is what the real handshake negotiated, not
 * that a pairing completes.
 */

// The plugin `src/` registers is one a controller can hand to the seam as it is.
expectTypeOf<typeof TunnelSocket>().toExtend<PairingSocket>();

const open: { close(): unknown }[] = [];
afterEach(async () => {
  for (const closeable of open.reverse()) {
    try {
      await closeable.close();
    } catch {
      // Teardown of something the test already tore down.
    }
  }
  open.length = 0;
});

/** A real TLS listener with its own key and certificate, holding pairing tunnels. */
async function pairingListener() {
  const gate = testGate();
  const key = generateTunnelKey();
  const certificate = await issueTunnelCertificate(key, { validDays: 1 });
  const listener = await createTunnelListener({
    maxTunnels: 4,
    binding: {
      kind: 'tls',
      host: '127.0.0.1',
      port: 0,
      tls: asTlsMaterial(tunnelKeyPkcs8Pem(key), certificate.certPem),
      gate: gate.gate,
    },
  });
  open.push(listener);
  const { port } = listener.server.address() as AddressInfo;
  let upgrades = 0;
  listener.server.on('upgrade', () => (upgrades += 1));
  const tunnels = listener.tunnels()[Symbol.asyncIterator]();
  const nextTunnel = async (): Promise<Tunnel> => {
    const next = await tunnels.next();
    if (next.done) throw new Error('the listener ended before admitting a tunnel');
    return next.value;
  };
  return { gate, key, url: `wss://127.0.0.1:${String(port)}`, nextTunnel, upgrades: () => upgrades };
}

const RENDERER = 7;

/**
 * The desktop leg as a renderer would call it: every method through
 * `PluginHost.invoke` (so `connect` is stamped with its sender, and arguments
 * and results must survive structured clone), every event through
 * `PluginHost.addListener` and `notifyListeners`, cloned on delivery.
 */
function desktopSocket(): { readonly socket: PairingSocket; readonly host: PluginHost } {
  const subscribers = new Map<number, (event: never) => void>();
  const host = new PluginHost((senderId, payload) => {
    if (senderId !== RENDERER) return false;
    subscribers.get(payload.subscriptionId)?.(structuredClone(payload.data) as never);
    return true;
  });
  host.register(
    TUNNEL_SOCKET_PLUGIN,
    createTunnelSocketPlugin({
      notify: (eventName, data, ownerId) => host.notifyListeners(TUNNEL_SOCKET_PLUGIN.name, eventName, data, ownerId),
    }),
  );

  const invoke = (method: string, options: unknown): Promise<unknown> =>
    host.invoke(RENDERER, TUNNEL_SOCKET_PLUGIN.name, method, [options]);
  let subscriptions = 0;
  const socket: PairingSocket = {
    connect: async (options) => (await invoke('connect', options)) as { readonly connectionId: string },
    close: async (options) => {
      await invoke('close', options);
    },
    negotiatedPeer: async (options) => (await invoke('negotiatedPeer', options)) as NegotiatedPeerCertificate,
    async addListener(eventName: TunnelSocketEventName, listener: (event: never) => void): Promise<ListenerHandle> {
      subscriptions += 1;
      const id = subscriptions;
      host.addListener(RENDERER, TUNNEL_SOCKET_PLUGIN.name, eventName, id);
      subscribers.set(id, listener);
      return {
        remove: async () => {
          host.removeListener(RENDERER, id);
          subscribers.delete(id);
        },
      };
    },
  };
  return { socket, host };
}

function scanned(trust: Uint8Array): PairingRoute {
  const payload = {
    version: 1,
    hostKind: HOST_DESKTOP,
    trustMode: TRUST_SPKI_PIN,
    trust,
    token: new Uint8Array(32).fill(2),
    expiresAt: 1_000,
    port: 8973,
    addresses: [{ kind: ADDRESS_IPV4, value: Uint8Array.of(127, 0, 0, 1) }],
    name: 'Desk',
  } as PairingPayload;
  return { kind: 'scanned', payload };
}

const TYPED: PairingRoute = { kind: 'typed', hostKind: HOST_DESKTOP };

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');

/** A promise that must settle, rather than a test that hangs until vitest's own timeout. */
function within<T>(promise: Promise<T>, ms = 5_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`did not settle within ${String(ms)} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const failed = (promise: Promise<unknown>): Promise<unknown> =>
  within(promise.then(() => null, (error: unknown) => error));

describe('openBoundPairingConnection over the desktop leg of the socket plugin, against a real listener', () => {
  it('scanned, the real pin: admitted as a pairing tunnel, and bound to the certificate the handshake produced', async () => {
    const { gate, key, url, nextTunnel, upgrades } = await pairingListener();
    gate.showCode();
    const { socket, host } = desktopSocket();
    const route = scanned(key.pin.spki);

    const bound = await within(openBoundPairingConnection(socket, url, route));

    expect(hex(bound.ci)).toBe(hex(channelIdentifierFor(route, { spki: key.pin.spki })));
    expect((await nextTunnel()).admission.kind).toBe('pairing');
    expect(upgrades()).toBe(1);
    // Handed back open, for the exchange that is not written yet.
    expect(await socket.negotiatedPeer({ connectionId: bound.connectionId })).toEqual({
      spkiSha256: key.pin.spkiSha256,
    });
    expect(host.subscriptionCount()).toBe(0);
    await socket.close({ connectionId: bound.connectionId });
  });

  it('typed: no pin to pass, so the binding is to whatever the real handshake negotiated', async () => {
    const { gate, key, url, nextTunnel } = await pairingListener();
    gate.showCode();
    const { socket, host } = desktopSocket();

    const bound = await within(openBoundPairingConnection(socket, url, TYPED));

    expect(hex(bound.ci)).toBe(hex(channelIdentifierFor(TYPED, { spki: key.pin.spki })));
    expect((await nextTunnel()).admission.kind).toBe('pairing');
    expect(host.subscriptionCount()).toBe(0);
    await socket.close({ connectionId: bound.connectionId });
  });

  it('scanned, another desktop’s pin: refused on the handshake before the upgrade is written, and that close reaches the caller whole', async () => {
    const { gate, url, upgrades } = await pairingListener();
    gate.showCode();
    const { socket, host } = desktopSocket();
    const elsewhere = generateTunnelKey().pin;

    const error = await failed(openBoundPairingConnection(socket, url, scanned(elsewhere.spki)));

    expect(error).toBeInstanceOf(PairingConnectionClosedError);
    expect((error as PairingConnectionClosedError).close).toMatchObject({ code: 1006, failure: 'PEER_MISMATCH' });
    expect(upgrades()).toBe(0);
    expect(host.subscriptionCount()).toBe(0);
  });

  it('no code on screen: the host answers 401, and that close reaches the caller whole', async () => {
    const { url, upgrades } = await pairingListener();
    const { socket, host } = desktopSocket();

    const error = await failed(openBoundPairingConnection(socket, url, TYPED));

    expect(error).toBeInstanceOf(PairingConnectionClosedError);
    const { close } = error as PairingConnectionClosedError;
    expect(close).toMatchObject({ code: 1006, httpStatus: 401 });
    expect(close.failure).toBeUndefined();
    expect(upgrades()).toBe(1);
    expect(host.subscriptionCount()).toBe(0);
  });
});
