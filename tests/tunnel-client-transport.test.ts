// @vitest-environment node
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
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
import {
  TunnelConnectError,
  classifyFrame,
  createTunnelClient,
  type TunnelClient,
  type TunnelClientOptions,
  type TunnelTransportFactory,
  type TunnelTransportFailure,
  type TunnelTransportTarget,
} from '@chatterang/tunnel/client';
import {
  asTlsMaterial,
  createTunnelListener,
  generateTunnelKey,
  issueTunnelCertificate,
  tunnelKeyPkcs8Pem,
  type CredentialStore,
  type Tunnel,
} from '@chatterang/tunnel/host';
import {
  TUNNEL_CAP_CLOSE_CODE,
  TUNNEL_PAIRING_CLOSED_CLOSE_CODE,
  TUNNEL_PAIRING_ONLY_CLOSE_CODE,
  TUNNEL_WIRE_VERSION,
  decodeFrame,
  encodeFrame,
  type TunnelFrame,
} from '@chatterang/tunnel/wire';

import { credentialHeaders, testGate, type TestGate } from './support/tunnel-gate';

/**
 * THE CLIENT OVER A TRANSPORT IT WAS HANDED (#295, refs #256, #184, #186).
 *
 * The phone's only transport is #181's native socket plugin, and
 * `createTunnelClient` hard-wired the WHATWG `WebSocket` global. So a phone
 * could not run the one client there is: the protocol gate, the sequence
 * checks, `bye` and the close-code faults all lived inside a function that
 * would only ever open a browser socket.
 *
 * WHAT STANDS IN FOR THE PLUGIN. `socketPluginOverWs` is a double of
 * `TunnelSocketPlugin` over a real `ws` socket, and every value it hands across
 * goes through JSON first, as a Capacitor bridge's payload does: frames as
 * base64 of the exact bytes, never text. `overPlugin` is the adapter an app
 * passes in (#295 U2 builds the real one); `client/` imports neither. Against
 * a real `createTunnelListener` through the real credential gate, this is the
 * phone's path with only the native code swapped for Node.
 *
 * Over `wss:` the double checks `expectedPeer` the way the contract obliges a
 * plugin to: on the connection that will carry the request, after the TLS
 * handshake and before the upgrade request (and the credential in its headers)
 * is written. `connect` rejects as a native plugin does, with a string `code`.
 *
 * `scriptedTransport` is a transport a test drives by hand, for what no honest
 * socket does: a frame after its own close, a second close, a status after the
 * upgrade.
 *
 * FAIL-FIRST, AND WHY SOME OF THESE RUN ONLY OVER THE INJECTED TRANSPORT. The
 * `WebSocket` default already maps 4503, 4403, 4410 and a cut to their faults
 * (`tests/tunnel-listener.test.ts`, `tests/tunnel-admission.test.ts`,
 * `tests/rung0.test.ts`). Those tests would pass on a client that ignored the
 * `transport` option. So each test here first proves the plugin carried the
 * connection, and the one test that uses the default is labelled a control.
 *
 * Manners from `tests/tunnel-loop-owner.test.ts`: ephemeral loopback ports,
 * everything closed in `afterEach`, no fixed timeouts.
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

const V = TUNNEL_WIRE_VERSION;

const turnFrame = (turn: string): TunnelFrame => ({
  v: V,
  kind: 'turn',
  turn,
  toolLoop: 'host',
  body: { messages: [] },
});
const content = (turn: string, sequence: number, delta: string): TunnelFrame => ({
  v: V,
  kind: 'chunk',
  turn,
  body: { type: 'content', sequence, delta },
});
const done = (turn: string, sequence: number): TunnelFrame => ({
  v: V,
  kind: 'chunk',
  turn,
  body: { type: 'done', sequence, finishReason: 'stop', message: { role: 'assistant', content: 'x' } },
});
const BYE: TunnelFrame = { v: V, kind: 'bye' };

function reader<T>(source: AsyncIterable<T>): () => Promise<T> {
  const iterator = source[Symbol.asyncIterator]();
  return async () => {
    const result = await iterator.next();
    if (result.done) throw new Error('the stream ended before the value this test waited for');
    return result.value;
  };
}

async function drain<T>(source: AsyncIterable<T>): Promise<T[]> {
  const all: T[] = [];
  for await (const value of source) all.push(value);
  return all;
}

/** The rejection a promise ends in, or a failure if it resolves. */
async function rejectionOf(pending: Promise<unknown>): Promise<unknown> {
  return pending.then(
    (value) => {
      if (value && typeof (value as TunnelClient).close === 'function') open.push(value as TunnelClient);
      throw new Error('expected a rejection, and it connected');
    },
    (error: unknown) => error,
  );
}

const toBase64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64');
const fromBase64 = (text: string): Uint8Array => new Uint8Array(Buffer.from(text, 'base64'));
/** A Capacitor bridge carries JSON. Everything the double hands across goes through it. */
const acrossBridge = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/**
 * A plugin's rejection as it reaches JavaScript: an `Error` with a string
 * `code`, which is what `call.reject(message, code)` produces on both
 * platforms (Android `PluginCall.reject(String msg, String code)`, iOS
 * `CAPPluginCall.reject(_:_:)`).
 */
const pluginRejection = (code: TunnelConnectRejectionCode, message: string): Error =>
  Object.assign(new Error(message), { code });

/** The SHA-256 of the SPKI this TLS connection negotiated, base64. */
const spkiSha256Of = (socket: TLSSocket): string => {
  const peer = socket.getPeerX509Certificate();
  return peer === undefined
    ? ''
    : createHash('sha256').update(peer.publicKey.export({ type: 'spki', format: 'der' })).digest('base64');
};

interface SocketPluginDouble extends TunnelSocketPlugin {
  /** Every connect the plugin was asked for, as it arrived across the bridge. */
  readonly connects: TunnelConnectOptions[];
  /** The platform store a `credentialRef` names. Nothing in `src/` reads it. */
  readonly keychain: Map<string, string>;
  /** Cut a connection the way a pulled cable does: no close frame, no `bye`. */
  cut(connectionId: string): void;
}

type AnyListener = (event: never) => void;

/**
 * `TunnelSocketPlugin` over a real `ws` socket. A double, but a strict one:
 * each connection reports exactly one `tunnelClose`, a refused upgrade reports
 * its HTTP status (from `ws`'s `unexpected-response`), and no event for a
 * connection is emitted before `connect` has resolved with its id — every one
 * of them waits on network I/O.
 */
function socketPluginOverWs(): SocketPluginDouble {
  const listeners = new Map<TunnelSocketEventName, Set<AnyListener>>();
  const emit = <K extends TunnelSocketEventName>(name: K, event: TunnelSocketEvents[K]): void => {
    for (const listener of listeners.get(name) ?? []) {
      (listener as (event: TunnelSocketEvents[K]) => void)(acrossBridge(event));
    }
  };
  const sockets = new Map<string, RawSocket>();
  const peers = new Map<string, NegotiatedPeerCertificate>();
  const connects: TunnelConnectOptions[] = [];
  const keychain = new Map<string, string>();
  let issued = 0;

  const socketOf = (connectionId: string): RawSocket => {
    const socket = sockets.get(connectionId);
    if (socket === undefined) throw new Error(`no connection ${connectionId}`);
    return socket;
  };

  return {
    connects,
    keychain,
    cut: (connectionId) => socketOf(connectionId).terminate(),
    async connect(sent) {
      const options = acrossBridge(sent);
      connects.push(options);
      const secure = options.url.startsWith('wss:');
      const presents = options.credential !== undefined || options.credentialRef !== undefined;
      if (options.credential !== undefined && options.credentialRef !== undefined) {
        throw pluginRejection('OPTIONS_REFUSED', 'a credential and a credentialRef together');
      }
      if (presents && secure && options.expectedPeer === undefined) {
        throw pluginRejection('OPTIONS_REFUSED', 'a credential over wss: with no expectedPeer');
      }
      const credential =
        options.credentialRef === undefined ? options.credential : keychain.get(options.credentialRef);
      if (options.credentialRef !== undefined && credential === undefined) {
        throw pluginRejection('CREDENTIAL_MISSING', 'no stored credential has that name');
      }
      const { WebSocket } = await import('ws');
      issued += 1;
      const connectionId = `connection-${String(issued)}`;
      let httpStatus: number | undefined;
      let failure: TunnelCloseFailure | undefined;
      const socket = new WebSocket(options.url, {
        headers: credential === undefined ? {} : credentialHeaders(credential),
        // The pin is the only check, as #295 describes the phone's.
        rejectUnauthorized: false,
        /*
         * THE PIN BEFORE THE REQUEST. `ws` writes the upgrade request, and the
         * credential in its headers, at `request.end()`, and `finishRequest`
         * is where that call is made. Over `wss:` it waits for this connection's
         * handshake and ends the request only for the expected key.
         *
         * Measured by mutating this double, on Node 24: with `end()` called
         * first, a check made synchronously in `secureConnect` still stops the
         * request (Node releases what was written during the handshake only
         * after that event's listeners return), but a check deferred one tick
         * lets the request reach the listener, and the test below fails. Held
         * here, a deferred check is safe too. A native plugin's check may well
         * be asynchronous, so the order the contract asks for is the one kept.
         */
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
      socket.on('message', (data: Buffer) =>
        emit('tunnelFrame', { connectionId, frame: toBase64(new Uint8Array(data)) }),
      );
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
      const socket = socketOf(connectionId);
      if (socket.readyState === socket.OPEN) socket.send(fromBase64(frame));
    },
    async close({ connectionId, code, reason }) {
      const socket = socketOf(connectionId);
      if (socket.readyState === socket.CONNECTING) socket.terminate();
      else socket.close(code, reason);
    },
    async negotiatedPeer({ connectionId }) {
      const socket = socketOf(connectionId);
      const peer = peers.get(connectionId);
      if (socket.readyState !== socket.OPEN || peer === undefined) {
        throw new Error(`${connectionId} is not an open wss: connection`);
      }
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

/** A rejection's `code`, when it has a string one. */
const rejectionCodeOf = (error: unknown): string | undefined => {
  const code = typeof error === 'object' && error !== null ? (error as { readonly code?: unknown }).code : undefined;
  return typeof code === 'string' ? code : undefined;
};

/**
 * The adapter an app passes in: plugin events to a `TunnelTransport`.
 * Records the target each connection was opened for. `expectedPeer` is the pin
 * an app's adapter holds for the desktop it was paired with.
 */
function overPlugin(
  plugin: TunnelSocketPlugin,
  targets: TunnelTransportTarget[] = [],
  pinned: { readonly expectedPeer?: NegotiatedPeerCertificate } = {},
): TunnelTransportFactory {
  return (target) => {
    targets.push(target);
    const on = {
      open: [] as (() => void)[],
      frame: [] as ((bytes: Uint8Array) => void)[],
      close: [] as ((code: number, reason: string, httpStatus?: number, failure?: TunnelTransportFailure) => void)[],
    };
    let id: string | null = null;
    const ours = (event: { readonly connectionId: string }): boolean => event.connectionId === id;
    const connected = (async (): Promise<string | null> => {
      await plugin.addListener('tunnelOpen', (event) => {
        if (ours(event)) for (const listener of on.open) listener();
      });
      await plugin.addListener('tunnelFrame', (event) => {
        if (ours(event)) for (const listener of on.frame) listener(fromBase64(event.frame));
      });
      await plugin.addListener('tunnelClose', (event) => {
        if (!ours(event)) return;
        for (const listener of on.close) listener(event.code, event.reason, event.httpStatus, event.failure);
      });
      const peer = pinned.expectedPeer === undefined ? {} : { expectedPeer: pinned.expectedPeer };
      const options: TunnelConnectOptions =
        target.credential !== undefined
          ? { url: target.url, credential: target.credential, ...peer }
          : target.credentialRef !== undefined
            ? { url: target.url, credentialRef: target.credentialRef, ...peer }
            : { url: target.url, ...peer };
      try {
        id = (await plugin.connect(options)).connectionId;
      } catch (error) {
        /*
         * A REJECTED CONNECT IS STILL THE CLIENT'S ONE CLOSE. The contract sends
         * no event after a rejection, so nothing but this adapter can end the
         * client's wait. The code names the failure; a code this adapter does
         * not know is TRANSPORT_FAILED, never "cannot reach".
         */
        const failure: TunnelTransportFailure =
          rejectionCodeOf(error) === 'CREDENTIAL_MISSING' ? 'CREDENTIAL_MISSING' : 'TRANSPORT_FAILED';
        for (const listener of on.close) listener(1006, '', undefined, failure);
        return null;
      }
      return id;
    })();
    return {
      send: (bytes) => {
        void connected.then((connectionId) =>
          connectionId === null ? undefined : plugin.send({ connectionId, frame: toBase64(bytes) }),
        );
      },
      onOpen: (listener) => {
        on.open.push(listener);
      },
      onFrame: (listener) => {
        on.frame.push(listener);
      },
      onClose: (listener) => {
        on.close.push(listener);
      },
      close: (code, reason) => {
        void connected.then((connectionId) =>
          connectionId === null
            ? undefined
            : plugin.close({
                connectionId,
                ...(code === undefined ? {} : { code }),
                ...(reason === undefined ? {} : { reason }),
              }),
        );
      },
    };
  };
}

/** A transport the test drives by hand. */
function scriptedTransport(options: { readonly closesAtOnce?: boolean } = {}) {
  const targets: TunnelTransportTarget[] = [];
  const sent: Uint8Array[] = [];
  const closeCalls: { code?: number; reason?: string }[] = [];
  const deliver = {
    open: (): void => undefined,
    frame: (_bytes: Uint8Array): void => undefined,
    close: (_code: number, _reason: string, _httpStatus?: number, _failure?: TunnelTransportFailure): void =>
      undefined,
  };
  const factory: TunnelTransportFactory = (target) => {
    targets.push(target);
    // Never in the factory's own turn: the client registers after it returns.
    if (options.closesAtOnce) setTimeout(() => deliver.close(1006, ''), 0);
    return {
      send: (bytes) => {
        sent.push(bytes);
      },
      onOpen: (listener) => {
        deliver.open = listener;
      },
      onFrame: (listener) => {
        deliver.frame = listener;
      },
      onClose: (listener) => {
        deliver.close = listener;
      },
      close: (code, reason) => {
        closeCalls.push({
          ...(code === undefined ? {} : { code }),
          ...(reason === undefined ? {} : { reason }),
        });
      },
    };
  };
  return {
    factory,
    targets,
    sent,
    closeCalls,
    open: () => deliver.open(),
    frame: (frame: TunnelFrame | Uint8Array) =>
      deliver.frame(frame instanceof Uint8Array ? frame : encodeFrame(frame)),
    close: (code: number, reason = '', httpStatus?: number, failure?: TunnelTransportFailure) =>
      deliver.close(code, reason, httpStatus, failure),
  };
}

/** A client over a scripted transport that has opened. */
async function scriptedClient(options: Partial<TunnelClientOptions> = {}) {
  const transport = scriptedTransport();
  const pending = createTunnelClient({ url: 'ws://127.0.0.1:9/', ...options, transport: transport.factory });
  transport.open();
  const client = await pending;
  open.push(client);
  return { client, transport };
}

async function listen(gate: TestGate = testGate(), maxTunnels = 1) {
  const listener = await createTunnelListener({ maxTunnels, binding: gate.binding() });
  open.push(listener);
  const { port } = listener.server.address() as AddressInfo;
  const next = reader(listener.tunnels());
  return { gate, listener, url: `ws://127.0.0.1:${String(port)}`, nextTunnel: (): Promise<Tunnel> => next() };
}

describe('the socket plugin contract', () => {
  it('is exported from the contracts package as ./tunnel-socket', () => {
    const root = resolve(process.cwd(), 'packages/contracts');
    const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
      exports: Record<string, string>;
    };
    expect(manifest.exports['./tunnel-socket']).toBe('./src/tunnel-socket.ts');
    expect(existsSync(resolve(root, manifest.exports['./tunnel-socket'] ?? 'missing'))).toBe(true);
  });
});

describe('a credentialed turn over an injected transport', () => {
  it('carries a turn end to end through the plugin, frame for frame, with the credential in no URL', async () => {
    const { gate, url, nextTunnel } = await listen();
    const { credential, deviceId } = await gate.mintDevice();
    const plugin = socketPluginOverWs();
    const targets: TunnelTransportTarget[] = [];

    const client = await createTunnelClient({ url, credential, transport: overPlugin(plugin, targets) });
    open.push(client);
    // The plugin carried it, not the WebSocket global.
    expect(plugin.connects).toEqual([{ url, credential }]);
    expect(targets).toEqual([{ url, credential }]);
    // Still frames and nothing else (BN10 builds on exactly this).
    expect(Object.keys(client).sort()).toEqual(['close', 'closed', 'ended', 'receive', 'send']);

    const tunnel = await nextTunnel();
    expect(tunnel.admission).toEqual({ kind: 'device', deviceId });
    const hears = reader(client.receive());
    const desktopHears = reader(tunnel.receive());

    await client.send(turnFrame('t1'));
    expect(await desktopHears()).toStrictEqual(turnFrame('t1'));

    // Not ASCII, so a bridge that turned bytes into text and back would show.
    const reply = content('t1', 0, 'héllo \u{1F30D} — café');
    await tunnel.send(reply);
    await tunnel.send(done('t1', 1));
    const first = await hears();
    expect(first).toStrictEqual(reply);
    expect(classifyFrame(first)).toEqual({ kind: 'streaming', turn: 't1' });
    expect(classifyFrame(await hears())).toEqual({ kind: 'completed', turn: 't1' });

    await client.close('finished');
    await tunnel.closed;
    expect(tunnel.ended()).toEqual({ kind: 'clean', reason: 'finished' });
    expect(client.ended()).toEqual({ kind: 'clean', reason: 'finished' });

    for (const { url: carried } of [...plugin.connects, ...targets]) {
      expect(carried).toBe(url);
      expect(carried).not.toContain(credential);
    }
  });

  it('carries it by credentialRef, so the secret stays in the plugin and never crosses into the client', async () => {
    const { gate, url, nextTunnel } = await listen();
    const { credential, deviceId } = await gate.mintDevice();
    const plugin = socketPluginOverWs();
    plugin.keychain.set('paired-desktop', credential);
    const targets: TunnelTransportTarget[] = [];

    const client = await createTunnelClient({
      url,
      credentialRef: 'paired-desktop',
      transport: overPlugin(plugin, targets),
    });
    open.push(client);
    expect(targets).toEqual([{ url, credentialRef: 'paired-desktop' }]);
    expect((await nextTunnel()).admission).toEqual({ kind: 'device', deviceId });
    expect(JSON.stringify([targets, plugin.connects])).not.toContain(credential);
  });

  it('hands the transport the URL it was given and the credential beside it, never inside it', async () => {
    const { client, transport } = await scriptedClient({ url: 'wss://127.0.0.1:9/', credential: 'secret' });
    expect(transport.targets).toStrictEqual([{ url: 'wss://127.0.0.1:9/', credential: 'secret' }]);
    expect(client.ended()).toBeNull();
  });
});

describe('a credential goes only where it is safe, over every transport', () => {
  const UNSAFE = ['ws://192.0.2.1:9/', 'ws://localhost:9/', 'ws://[::1]:9/', 'http://127.0.0.1:9/', 'not a url'];

  it('refuses a credential over plaintext anywhere but 127.0.0.1 before the transport is made', async () => {
    for (const url of UNSAFE) {
      // A transport that would report "unreachable" at once, so a client that
      // skipped the check fails this assertion rather than hanging.
      const transport = scriptedTransport({ closesAtOnce: true });
      await expect(createTunnelClient({ url, credential: 'secret', transport: transport.factory }), url).rejects.toThrow(
        /wss/,
      );
      expect(transport.targets, url).toEqual([]);
    }
  });

  it('refuses a credentialRef on the same terms, because the plugin will present a credential for it', async () => {
    // Before any socket: on a client with no `credentialRef`, the loop below
    // would open real connections.
    expect(TunnelConnectError).toBeTypeOf('function');
    for (const url of UNSAFE) {
      const transport = scriptedTransport({ closesAtOnce: true });
      await expect(
        createTunnelClient({ url, credentialRef: 'paired-desktop', transport: transport.factory }),
        url,
      ).rejects.toThrow(/wss/);
      expect(transport.targets, url).toEqual([]);
    }
  });

  it('refuses a credential and a credentialRef together', async () => {
    const transport = scriptedTransport({ closesAtOnce: true });
    await expect(
      createTunnelClient({
        url: 'wss://127.0.0.1:9/',
        credential: 'secret',
        credentialRef: 'paired-desktop',
        transport: transport.factory,
      }),
    ).rejects.toThrow(/credentialRef/);
    expect(transport.targets).toEqual([]);
  });

  it('the WebSocket default refuses a credentialRef, having no store to read it from', async () => {
    await expect(createTunnelClient({ url: 'ws://127.0.0.1:9/', credentialRef: 'paired-desktop' })).rejects.toThrow(
      /credentialRef/,
    );
  });
});

describe('close codes, over the injected transport', () => {
  it('keeps the numbers the listener closes with', () => {
    expect([TUNNEL_CAP_CLOSE_CODE, TUNNEL_PAIRING_ONLY_CLOSE_CODE, TUNNEL_PAIRING_CLOSED_CLOSE_CODE]).toEqual([
      4503, 4403, 4410,
    ]);
  });

  it.each([
    [TUNNEL_CAP_CLOSE_CODE, 'TUNNEL_FULL'],
    [TUNNEL_PAIRING_ONLY_CLOSE_CODE, 'PAIRING_ONLY'],
    [TUNNEL_PAIRING_CLOSED_CLOSE_CODE, 'PAIRING_WINDOW_CLOSED'],
    [1006, 'PEER_GONE'],
    [1000, 'PEER_GONE'],
  ])('a close with %i and no bye is %s', async (code, fault) => {
    const { client, transport } = await scriptedClient();
    transport.close(code);
    await client.closed;
    expect(client.ended()).toMatchObject({ kind: 'abnormal', code: fault });
  });

  it('a bye before the close is clean, whatever the code (the paired control)', async () => {
    const { client, transport } = await scriptedClient();
    transport.frame({ ...BYE, body: { reason: 'going' } });
    transport.close(1006);
    await client.closed;
    expect(client.ended()).toEqual({ kind: 'clean', reason: 'going' });
  });

  it('a status on a close after the upgrade is not a refusal: the close code decides', async () => {
    const { client, transport } = await scriptedClient();
    transport.close(TUNNEL_CAP_CLOSE_CODE, '', 401);
    await client.closed;
    expect(client.ended()).toMatchObject({ kind: 'abnormal', code: 'TUNNEL_FULL' });
  });

  it('a full listener is TUNNEL_FULL through the plugin', async () => {
    const { gate, url, nextTunnel } = await listen(testGate(), 1);
    const { credential } = await gate.mintDevice();
    const plugin = socketPluginOverWs();
    const first = await createTunnelClient({ url, credential, transport: overPlugin(plugin) });
    open.push(first);
    expect(plugin.connects).toHaveLength(1);
    await nextTunnel();

    const second = await createTunnelClient({ url, credential, transport: overPlugin(plugin) });
    open.push(second);
    await second.closed;
    expect(second.ended()).toMatchObject({ kind: 'abnormal', code: 'TUNNEL_FULL' });
    expect(plugin.connects).toHaveLength(2);
  });

  it('a pairing tunnel that tries a turn is PAIRING_ONLY through the plugin', async () => {
    const { gate, url, nextTunnel } = await listen(testGate(), 4);
    gate.showCode();
    const plugin = socketPluginOverWs();
    const client = await createTunnelClient({ url, transport: overPlugin(plugin) });
    open.push(client);
    expect(plugin.connects).toEqual([{ url }]);
    await nextTunnel();

    await client.send(content('t1', 0, 'a turn from a phone nobody paired'));
    await client.closed;
    expect(client.ended()).toMatchObject({ kind: 'abnormal', code: 'PAIRING_ONLY' });
  });

  it('a pairing code taken off the screen is PAIRING_WINDOW_CLOSED through the plugin', async () => {
    const { gate, url, nextTunnel } = await listen(testGate(), 4);
    gate.showCode();
    const plugin = socketPluginOverWs();
    const client = await createTunnelClient({ url, transport: overPlugin(plugin) });
    open.push(client);
    expect(plugin.connects).toEqual([{ url }]);
    await nextTunnel();

    gate.pairing.cancel();
    await client.closed;
    expect(client.ended()).toMatchObject({ kind: 'abnormal', code: 'PAIRING_WINDOW_CLOSED' });
  });

  it('a cut with no bye is PEER_GONE at both ends through the plugin', async () => {
    const { gate, url, nextTunnel } = await listen();
    const { credential } = await gate.mintDevice();
    const plugin = socketPluginOverWs();
    const client = await createTunnelClient({ url, credential, transport: overPlugin(plugin) });
    open.push(client);
    expect(plugin.connects).toHaveLength(1);
    const tunnel = await nextTunnel();

    plugin.cut('connection-1');
    await client.closed;
    expect(client.ended()).toMatchObject({ kind: 'abnormal', code: 'PEER_GONE' });
    await tunnel.closed;
    expect(tunnel.ended()).toMatchObject({ kind: 'abnormal', code: 'PEER_GONE' });
  });

  it("the desktop's bye is clean through the plugin", async () => {
    const { gate, url, nextTunnel } = await listen();
    const { credential } = await gate.mintDevice();
    const plugin = socketPluginOverWs();
    const client = await createTunnelClient({ url, credential, transport: overPlugin(plugin) });
    open.push(client);
    expect(plugin.connects).toHaveLength(1);
    const tunnel = await nextTunnel();

    await tunnel.close('desktop quitting');
    await client.closed;
    expect(client.ended()).toEqual({ kind: 'clean', reason: 'desktop quitting' });
  });
});

describe('an upgrade refused with an HTTP status', () => {
  it('401 with a credential is CREDENTIAL_REFUSED, not "cannot reach"', async () => {
    const { gate, url } = await listen();
    const { credential, deviceId } = await gate.mintDevice();
    expect(await gate.credentials.revoke(deviceId)).toBe(true);
    const plugin = socketPluginOverWs();

    const error = await rejectionOf(createTunnelClient({ url, credential, transport: overPlugin(plugin) }));
    expect(plugin.connects).toHaveLength(1);
    expect(error).toBeInstanceOf(TunnelConnectError);
    expect(error).toMatchObject({ code: 'CREDENTIAL_REFUSED', httpStatus: 401 });
    expect((error as Error).message).toMatch(/pair/);
    expect((error as Error).message).not.toMatch(/cannot reach/);
  });

  it('401 with no credential, when no code is shown, is PAIRING_NOT_OPEN: there was no credential to refuse', async () => {
    const { url } = await listen(testGate(), 4);
    const plugin = socketPluginOverWs();

    const error = await rejectionOf(createTunnelClient({ url, transport: overPlugin(plugin) }));
    expect(plugin.connects).toHaveLength(1);
    expect(error).toBeInstanceOf(TunnelConnectError);
    expect(error).toMatchObject({ code: 'PAIRING_NOT_OPEN', httpStatus: 401 });
  });

  it('503, a gate that could not read its store, is HOST_COULD_NOT_CHECK: nothing was revoked', async () => {
    const unreadable: CredentialStore = {
      get: () => Promise.reject(new Error('the store cannot be read')),
      set: () => Promise.resolve(),
      delete: () => Promise.resolve(false),
    };
    const { gate, url } = await listen(testGate(unreadable));
    const { credential } = await gate.mintDevice();
    const plugin = socketPluginOverWs();

    const error = await rejectionOf(createTunnelClient({ url, credential, transport: overPlugin(plugin) }));
    expect(plugin.connects).toHaveLength(1);
    expect(error).toBeInstanceOf(TunnelConnectError);
    expect(error).toMatchObject({ code: 'HOST_COULD_NOT_CHECK', httpStatus: 503 });
    expect((error as Error).message).not.toMatch(/cannot reach/);
  });

  it('400, a URL carrying anything but /, is UPGRADE_REFUSED with its status', async () => {
    const { gate, url } = await listen();
    const { credential } = await gate.mintDevice();
    const plugin = socketPluginOverWs();

    const error = await rejectionOf(
      createTunnelClient({ url: `${url}/?credential=${credential}`, transport: overPlugin(plugin) }),
    );
    expect(plugin.connects).toHaveLength(1);
    expect(error).toBeInstanceOf(TunnelConnectError);
    expect(error).toMatchObject({ code: 'UPGRADE_REFUSED', httpStatus: 400 });
  });

  it('a port nobody answers on is UNREACHABLE, with no status', async () => {
    const { listener, url } = await listen();
    await listener.close();
    const plugin = socketPluginOverWs();

    const error = await rejectionOf(createTunnelClient({ url, transport: overPlugin(plugin) }));
    expect(plugin.connects).toHaveLength(1);
    expect(error).toBeInstanceOf(TunnelConnectError);
    expect(error).toMatchObject({ code: 'UNREACHABLE' });
    expect((error as TunnelConnectError).httpStatus).toBeUndefined();
    expect((error as Error).message).toMatch(/cannot reach/);
  });

  it.each([
    [{ credential: 'secret' }, 401, 'CREDENTIAL_REFUSED'],
    [{ credentialRef: 'paired-desktop' }, 401, 'CREDENTIAL_REFUSED'],
    [{}, 401, 'PAIRING_NOT_OPEN'],
    [{ credential: 'secret' }, 503, 'HOST_COULD_NOT_CHECK'],
    [{}, 503, 'HOST_COULD_NOT_CHECK'],
    [{ credential: 'secret' }, 400, 'UPGRADE_REFUSED'],
    [{}, 404, 'UPGRADE_REFUSED'],
    [{ credential: 'secret' }, undefined, 'UNREACHABLE'],
  ] as const)('%o refused with %s before opening is %s', async (presented, status, code) => {
    const transport = scriptedTransport();
    const pending = createTunnelClient({ url: 'ws://127.0.0.1:9/', ...presented, transport: transport.factory });
    transport.close(1006, '', status);
    const error = await rejectionOf(pending);
    expect(error).toBeInstanceOf(TunnelConnectError);
    expect(error).toMatchObject({ code, httpStatus: status });
  });

  it('CONTROL: the WebSocket default cannot see the status, so its 401 still reads "cannot reach"', async () => {
    // Passes on main by design. The WHATWG socket reports a refused upgrade as
    // `error` then `close` 1006 with no status (measured on Node 24), which is
    // why the status has to come from a transport that can see it.
    const { gate, url } = await listen();
    const { credential, deviceId } = await gate.mintDevice();
    await gate.credentials.revoke(deviceId);
    await expect(createTunnelClient({ url, credential })).rejects.toThrow(/cannot reach/);
  });
});

describe('a connection that failed before any host answered is not "cannot reach"', () => {
  const pendingOver = (transport: ReturnType<typeof scriptedTransport>) =>
    createTunnelClient({
      url: 'wss://desktop.example:8973/',
      credentialRef: 'paired-desktop',
      transport: transport.factory,
    });

  it.each([
    ['PEER_MISMATCH', 'PEER_MISMATCH'],
    ['CREDENTIAL_MISSING', 'CREDENTIAL_MISSING'],
    ['TRANSPORT_FAILED', 'TRANSPORT_FAILED'],
    // A failure this build has no name for fails closed, as an unknown refusal does.
    ['A_FAILURE_FROM_A_NEWER_TRANSPORT', 'TRANSPORT_FAILED'],
  ] as const)('a close before opening with failure %s is %s, with no status', async (failure, code) => {
    const transport = scriptedTransport();
    const pending = pendingOver(transport);
    transport.close(1006, '', undefined, failure as TunnelTransportFailure);
    const error = await rejectionOf(pending);
    expect(error).toBeInstanceOf(TunnelConnectError);
    expect(error).toMatchObject({ code, httpStatus: undefined });
    expect((error as Error).message).not.toMatch(/cannot reach/);
  });

  it('a failed pin outranks a status: no request was written, so no status answers this device', async () => {
    const transport = scriptedTransport();
    const pending = pendingOver(transport);
    transport.close(1006, '', 401, 'PEER_MISMATCH');
    expect(await rejectionOf(pending)).toMatchObject({ code: 'PEER_MISMATCH', httpStatus: undefined });
  });

  it('each says what happened and what to do about it', async () => {
    const said = async (failure: TunnelTransportFailure): Promise<string> => {
      const transport = scriptedTransport();
      const pending = pendingOver(transport);
      transport.close(1006, '', undefined, failure);
      return ((await rejectionOf(pending)) as Error).message;
    };
    const mismatch = await said('PEER_MISMATCH');
    expect(mismatch).toMatch(/nothing was sent/i);
    expect(mismatch).toMatch(/pair again/i);
    expect(await said('CREDENTIAL_MISSING')).toMatch(/pair again/i);
    expect(await said('TRANSPORT_FAILED')).not.toMatch(/pair again/i);
  });

  it('a failure on a close after the upgrade is not a refusal: the close code decides', async () => {
    const { client, transport } = await scriptedClient();
    transport.close(TUNNEL_CAP_CLOSE_CODE, '', undefined, 'PEER_MISMATCH');
    await client.closed;
    expect(client.ended()).toMatchObject({ kind: 'abnormal', code: 'TUNNEL_FULL' });
  });
});

describe('the plugin failing before any host answered, through the adapter', () => {
  it('a credentialRef that names nothing is CREDENTIAL_MISSING, and createTunnelClient settles', async () => {
    const { listener, url } = await listen();
    let upgrades = 0;
    listener.server.on('upgrade', () => {
      upgrades += 1;
    });
    // An empty keychain: a phone restored from a backup, which does not carry a
    // this-device-only item.
    const plugin = socketPluginOverWs();

    const error = await rejectionOf(
      createTunnelClient({ url, credentialRef: 'paired-desktop', transport: overPlugin(plugin) }),
    );
    expect(plugin.connects).toEqual([{ url, credentialRef: 'paired-desktop' }]);
    expect(error).toBeInstanceOf(TunnelConnectError);
    expect(error).toMatchObject({ code: 'CREDENTIAL_MISSING', httpStatus: undefined });
    expect((error as Error).message).not.toMatch(/cannot reach/);
    expect(upgrades).toBe(0);
  });

  it('a wss: credential with no expectedPeer is refused by the plugin, and the client hears TRANSPORT_FAILED', async () => {
    const plugin = socketPluginOverWs();
    const error = await rejectionOf(
      createTunnelClient({ url: 'wss://127.0.0.1:9/', credential: 'secret', transport: overPlugin(plugin) }),
    );
    expect(plugin.connects).toHaveLength(1);
    expect(error).toBeInstanceOf(TunnelConnectError);
    expect(error).toMatchObject({ code: 'TRANSPORT_FAILED', httpStatus: undefined });
    expect((error as Error).message).not.toMatch(/cannot reach/);
  });

  it("a desktop that no longer holds the paired key is PEER_MISMATCH, and its listener never sees the request", async () => {
    // The paired desktop reset its TLS identity: it now serves another key.
    const paired = generateTunnelKey();
    const reset = generateTunnelKey();
    const certificate = await issueTunnelCertificate(reset, { validDays: 1 });
    const gate = testGate();
    const { credential, deviceId } = await gate.mintDevice();
    const listener = await createTunnelListener({
      maxTunnels: 2,
      binding: {
        kind: 'tls',
        host: '127.0.0.1',
        port: 0,
        tls: asTlsMaterial(tunnelKeyPkcs8Pem(reset), certificate.certPem),
        gate: gate.gate,
      },
    });
    open.push(listener);
    let upgrades = 0;
    listener.server.on('upgrade', () => {
      upgrades += 1;
    });
    const { port } = listener.server.address() as AddressInfo;
    const url = `wss://127.0.0.1:${String(port)}`;
    const plugin = socketPluginOverWs();

    const error = await rejectionOf(
      createTunnelClient({
        url,
        credential,
        transport: overPlugin(plugin, [], { expectedPeer: { spkiSha256: paired.pin.spkiSha256 } }),
      }),
    );
    expect(plugin.connects).toHaveLength(1);
    expect(error).toBeInstanceOf(TunnelConnectError);
    expect(error).toMatchObject({ code: 'PEER_MISMATCH', httpStatus: undefined });
    // The handshake ran (that is how the key was seen); the request carrying
    // the credential was never written.
    expect(upgrades).toBe(0);

    // The control: pinned to the key the listener does serve, the same device
    // is let in, and the counter above does count a request.
    const incoming = reader(listener.tunnels());
    const client = await createTunnelClient({
      url,
      credential,
      transport: overPlugin(plugin, [], { expectedPeer: { spkiSha256: reset.pin.spkiSha256 } }),
    });
    open.push(client);
    expect((await incoming()).admission).toEqual({ kind: 'device', deviceId });
    expect(upgrades).toBe(1);
    expect(await plugin.negotiatedPeer({ connectionId: 'connection-2' })).toEqual({
      spkiSha256: reset.pin.spkiSha256,
    });
  });
});

describe('the gate runs unchanged over any transport', () => {
  it('a sequence gap is SEQUENCE_BROKEN, and the client closes the transport', async () => {
    const { client, transport } = await scriptedClient();
    transport.frame(content('t1', 0, 'a'));
    transport.frame(content('t1', 2, 'c'));
    await client.closed;
    expect(client.ended()).toMatchObject({ kind: 'abnormal', code: 'SEQUENCE_BROKEN' });
    expect(await drain(client.receive())).toEqual([content('t1', 0, 'a')]);
    expect(transport.closeCalls).toHaveLength(1);
  });

  it("bytes that are not UTF-8 are FRAME_INVALID: decodeFrame's decoder is the one validator", async () => {
    const { client, transport } = await scriptedClient();
    transport.frame(new Uint8Array([0x7b, 0xff, 0x7d]));
    await client.closed;
    expect(client.ended()).toMatchObject({ kind: 'abnormal', code: 'FRAME_INVALID' });
    expect(transport.closeCalls).toHaveLength(1);
  });

  it('a frame outside its turn is answered while open, and not once the client is closing', async () => {
    const { client, transport } = await scriptedClient();
    const stray: TunnelFrame = { v: V, kind: 'prompt', turn: 'never-asked', prompt: 'p1', body: { action: 'run bash' } };
    transport.frame(stray);
    expect(transport.sent.map((bytes) => decodeFrame(bytes))).toMatchObject([
      { kind: 'error', body: { code: 'FRAME_UNEXPECTED' } },
    ]);

    await client.close('done');
    transport.frame(stray);
    // The answer above and the bye, and nothing after.
    expect(transport.sent.map((bytes) => decodeFrame(bytes).kind)).toEqual(['error', 'bye']);
    expect(transport.closeCalls).toHaveLength(1);
  });
});

describe('a transport that breaks its contract', () => {
  it('what arrives after its terminal close is ignored and counted, and none of it is decoded', async () => {
    const ignored: unknown[] = [];
    const { client, transport } = await scriptedClient({ onIgnoredAfterClose: (event) => ignored.push(event) });
    transport.frame(content('t1', 0, 'before'));
    transport.close(1006);
    await client.closed;
    expect(client.ended()).toMatchObject({ kind: 'abnormal', code: 'PEER_GONE' });

    // Three frames that each do something visible if decoded: one the app
    // would read, one that fails to decode, and a gap that closes the transport.
    transport.frame(content('t1', 1, 'after'));
    transport.frame(new Uint8Array([0xff, 0xfe]));
    transport.frame(content('t2', 5, 'a gap'));
    // A second terminal close, and an open, neither of which can happen.
    transport.close(TUNNEL_CAP_CLOSE_CODE);
    transport.open();

    expect(await drain(client.receive())).toEqual([content('t1', 0, 'before')]);
    expect(client.ended()).toMatchObject({ kind: 'abnormal', code: 'PEER_GONE' });
    // And this end writes nothing to a transport that has closed.
    await client.send({ v: V, kind: 'ping' });
    expect(transport.sent).toEqual([]);
    expect(transport.closeCalls).toEqual([]);
    expect(ignored).toEqual([
      { delivered: 'frame', count: 1 },
      { delivered: 'frame', count: 2 },
      { delivered: 'frame', count: 3 },
      { delivered: 'close', count: 4 },
      { delivered: 'open', count: 5 },
    ]);
  });

  it('a transport that closes and then opens has not connected', async () => {
    const transport = scriptedTransport();
    const pending = createTunnelClient({ url: 'ws://127.0.0.1:9/', transport: transport.factory });
    transport.close(1006);
    transport.open();
    const error = await rejectionOf(pending);
    expect(error).toMatchObject({ code: 'UNREACHABLE' });
  });
});
