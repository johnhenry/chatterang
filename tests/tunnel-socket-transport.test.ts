// @vitest-environment node
import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { TLSSocket } from 'node:tls';

import { afterEach, describe, expect, it } from 'vitest';
import type { WebSocket as RawSocket } from 'ws';

import type { ListenerHandle } from '@chatterang/contracts';
import type {
  NegotiatedPeerCertificate,
  TunnelCloseFailure,
  TunnelConnectOptions,
  TunnelConnectRejectionCode,
  TunnelSocketEventName,
  TunnelSocketEvents,
  TunnelSocketPlugin,
} from '@chatterang/contracts/tunnel-socket';
import { TunnelConnectError, createTunnelClient } from '@chatterang/tunnel/client';
import {
  asTlsMaterial,
  createTunnelListener,
  generateTunnelKey,
  issueTunnelCertificate,
  tunnelKeyPkcs8Pem,
  type Tunnel,
} from '@chatterang/tunnel/host';
import { TUNNEL_WIRE_VERSION, type TunnelFrame } from '@chatterang/tunnel/wire';

import { tunnelSocketTransport } from '../src/lib/tunnel-socket-transport';
import { testGate } from './support/tunnel-gate';

/**
 * THE PRODUCTION ADAPTER, RUN FOR REAL (#295, refs #256, #184, #186).
 *
 * `packages/tunnel/src/client/index.ts` promises an app hands `createTunnelClient`
 * an adapter from the native socket plugin #181 chose to the client's own
 * `TunnelTransportFactory`. `src/lib/tunnel-socket-transport.ts` is that
 * adapter; `tests/tunnel-client-transport.test.ts` proved the SHAPE against
 * its own test-local copy before this file existed. This proves the actual
 * shipped file, against a real `ws` socket and a real `createTunnelListener`,
 * so the two cannot silently drift.
 *
 * The double below stands in for the native plugin's bridge, exactly the way
 * `tests/tunnel-client-transport.test.ts`'s `socketPluginOverWs` does: real
 * `ws` socket, real TLS, the pin checked on `secureConnect` before the upgrade
 * request (and the credential header on it) is written, and every value
 * round-tripped through `JSON.parse(JSON.stringify(...))` the way a Capacitor
 * bridge's payload actually crosses.
 */

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

function reader<T>(source: AsyncIterable<T>): () => Promise<T> {
  const iterator = source[Symbol.asyncIterator]();
  return async () => {
    const result = await iterator.next();
    if (result.done) throw new Error('the stream ended before the value this test waited for');
    return result.value;
  };
}

async function plainListener(maxTunnels = 4) {
  const gate = testGate();
  const listener = await createTunnelListener({ maxTunnels, binding: gate.binding() });
  open.push(listener);
  const { port } = listener.server.address() as AddressInfo;
  return { gate, listener, url: `ws://127.0.0.1:${String(port)}`, nextTunnel: reader(listener.tunnels()) };
}

async function tlsListener(maxTunnels = 4) {
  const gate = testGate();
  const key = generateTunnelKey();
  const certificate = await issueTunnelCertificate(key, { validDays: 1 });
  const listener = await createTunnelListener({
    maxTunnels,
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
  return { gate, key, listener, url: `wss://127.0.0.1:${String(port)}`, nextTunnel: reader(listener.tunnels()), upgrades: () => upgrades };
}

const toBase64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64');
const fromBase64 = (text: string): Uint8Array => new Uint8Array(Buffer.from(text, 'base64'));
const acrossBridge = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const pluginRejection = (code: TunnelConnectRejectionCode, message: string): Error =>
  Object.assign(new Error(message), { code });

const spkiSha256Of = (socket: TLSSocket): string => {
  const peer = socket.getPeerX509Certificate();
  return peer === undefined
    ? ''
    : createHash('sha256').update(peer.publicKey.export({ type: 'spki', format: 'der' })).digest('base64');
};

type AnyListener = (event: never) => void;

/** A minimal double of the native plugin's bridge, over a real `ws` socket. */
function socketPluginDouble(): TunnelSocketPlugin & { readonly connects: TunnelConnectOptions[] } {
  const listeners = new Map<TunnelSocketEventName, Set<AnyListener>>();
  const emit = <K extends TunnelSocketEventName>(name: K, event: TunnelSocketEvents[K]): void => {
    for (const listener of listeners.get(name) ?? []) (listener as (event: TunnelSocketEvents[K]) => void)(acrossBridge(event));
  };
  const sockets = new Map<string, RawSocket>();
  const peers = new Map<string, NegotiatedPeerCertificate>();
  const connects: TunnelConnectOptions[] = [];
  let issued = 0;

  return {
    connects,
    async connect(sent) {
      const options = acrossBridge(sent);
      connects.push(options);
      const secure = options.url.startsWith('wss:');
      const presents = options.credential !== undefined;
      if (presents && secure && options.expectedPeer === undefined) {
        throw pluginRejection('OPTIONS_REFUSED', 'a credential over wss: with no expectedPeer');
      }
      const { WebSocket } = await import('ws');
      issued += 1;
      const connectionId = `connection-${String(issued)}`;
      let httpStatus: number | undefined;
      let failure: TunnelCloseFailure | undefined;
      const socket = new WebSocket(options.url, {
        headers: options.credential === undefined ? {} : { 'chatterang-device-credential': options.credential },
        rejectUnauthorized: false,
        finishRequest: (request) => {
          if (!secure) {
            request.end();
            return;
          }
          request.once('socket', (raw) => {
            const tls = raw as TLSSocket;
            tls.once('secureConnect', () => {
              const negotiated = { spkiSha256: spkiSha256Of(tls) };
              if (options.expectedPeer !== undefined && negotiated.spkiSha256 !== options.expectedPeer.spkiSha256) {
                failure = 'PEER_MISMATCH';
                request.destroy(new Error('peer SPKI does not match expectedPeer'));
                return;
              }
              peers.set(connectionId, negotiated);
              request.end();
            });
          });
        },
      });
      open.push({ close: () => socket.terminate() });
      sockets.set(connectionId, socket);

      socket.on('error', () => undefined);
      socket.once('unexpected-response', (_request, response) => {
        httpStatus = response.statusCode;
        socket.terminate();
      });
      socket.once('open', () => emit('tunnelOpen', { connectionId }));
      socket.on('message', (data: Buffer) => emit('tunnelFrame', { connectionId, frame: toBase64(new Uint8Array(data)) }));
      socket.once('close', (code: number, reason: Buffer) =>
        emit('tunnelClose', {
          connectionId,
          code,
          reason: reason.toString('utf8'),
          ...(httpStatus === undefined ? {} : { httpStatus }),
          ...(failure === undefined ? {} : { failure }),
        }),
      );
      return acrossBridge({ connectionId });
    },
    async send({ connectionId, frame }) {
      const socket = sockets.get(connectionId);
      if (socket !== undefined && socket.readyState === socket.OPEN) socket.send(fromBase64(frame));
    },
    async close({ connectionId, code, reason }) {
      const socket = sockets.get(connectionId);
      if (socket === undefined) return;
      if (socket.readyState === socket.CONNECTING) socket.terminate();
      else socket.close(code, reason);
    },
    async negotiatedPeer({ connectionId }) {
      const peer = peers.get(connectionId);
      if (peer === undefined) throw new Error(`${connectionId} is not an open wss: connection`);
      return acrossBridge(peer);
    },
    async addListener(eventName: TunnelSocketEventName, listener: AnyListener): Promise<ListenerHandle> {
      const set = listeners.get(eventName) ?? new Set<AnyListener>();
      listeners.set(eventName, set);
      set.add(listener);
      return {
        remove: async () => {
          set.delete(listener);
        },
      };
    },
    async removeAllListeners() {
      listeners.clear();
    },
  };
}

const V = TUNNEL_WIRE_VERSION;
const turnFrame = (turn: string): TunnelFrame => ({ v: V, kind: 'turn', turn, toolLoop: 'host', body: { messages: [] } });

describe('tunnelSocketTransport: the shipped adapter, over a real socket', () => {
  it('carries a credentialed turn end to end through the adapter and a real listener', async () => {
    const { gate, url, nextTunnel } = await plainListener();
    const { credential, deviceId } = await gate.mintDevice();
    const plugin = socketPluginDouble();

    const client = await createTunnelClient({ url, credential, transport: tunnelSocketTransport(plugin) });
    open.push(client);
    expect(plugin.connects).toEqual([{ url, credential }]);

    const tunnel: Tunnel = await nextTunnel();
    expect(tunnel.admission).toEqual({ kind: 'device', deviceId });
    const desktopHears = reader(tunnel.receive());

    await client.send(turnFrame('t1'));
    expect(await desktopHears()).toStrictEqual(turnFrame('t1'));

    await client.close('done');
    await tunnel.closed;
    expect(client.ended()).toEqual({ kind: 'clean', reason: 'done' });
  });

  it('the negative pin test, through the adapter: a mismatched expectedPeer is PEER_MISMATCH, with nothing sent', async () => {
    const { gate, url } = await tlsListener();
    const { credential } = await gate.mintDevice();
    const impostor = generateTunnelKey();
    const plugin = socketPluginDouble();

    const pending = createTunnelClient({
      url,
      credential,
      transport: tunnelSocketTransport(plugin, { expectedPeer: { spkiSha256: impostor.pin.spkiSha256 } }),
    });
    await expect(pending).rejects.toBeInstanceOf(TunnelConnectError);
    await pending.catch((error: unknown) => {
      expect(error).toMatchObject({ code: 'PEER_MISMATCH', httpStatus: undefined });
    });
  });

  it('the control: the real pin lets the same device in through the adapter', async () => {
    const { gate, url, key, nextTunnel } = await tlsListener();
    const { credential, deviceId } = await gate.mintDevice();
    const plugin = socketPluginDouble();

    const client = await createTunnelClient({
      url,
      credential,
      transport: tunnelSocketTransport(plugin, { expectedPeer: { spkiSha256: key.pin.spkiSha256 } }),
    });
    open.push(client);
    expect((await nextTunnel()).admission).toEqual({ kind: 'device', deviceId });
  });

  it('CREDENTIAL_MISSING from the plugin becomes the client transport failure, through the adapter', async () => {
    const plugin: TunnelSocketPlugin = {
      ...socketPluginDouble(),
      connect: async () => {
        throw pluginRejection('CREDENTIAL_MISSING', 'no stored credential has that name');
      },
    };
    const pending = createTunnelClient({
      url: 'wss://127.0.0.1:9/',
      credentialRef: 'paired-desktop',
      transport: tunnelSocketTransport(plugin),
    });
    await expect(pending).rejects.toMatchObject({ code: 'CREDENTIAL_MISSING' });
  });
});
