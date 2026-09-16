// @vitest-environment node
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import {
  PluginHost,
  TUNNEL_SOCKET_PLUGIN,
  type EventDelivery,
  type EventPayload,
  type PluginImplementation,
} from '../apps/desktop/src/bridge/index.js';
import { createTunnelSocketPlugin, type CredentialRefStore } from '../apps/desktop/src/net/tunnel-socket.js';
import {
  asTlsMaterial,
  createTunnelListener,
  generateTunnelKey,
  issueTunnelCertificate,
  tunnelKeyPkcs8Pem,
  type Tunnel,
} from '@chatterang/tunnel/host';
import { TUNNEL_WIRE_VERSION, decodeFrame, encodeFrame, type TunnelFrame } from '@chatterang/tunnel/wire';

import { testGate } from './support/tunnel-gate.js';

/**
 * THE DESKTOP'S OWN LEG OF #181's RULING, RUN FOR REAL (#295).
 *
 * `apps/desktop/src/bridge/tunnel-socket.ts` is the Node implementation the
 * owner's ruling on #295 requires: "the Electron desktop is a tunnel client
 * too, in v1 — not only a host." This proves it against a REAL
 * `createTunnelListener` — a real TCP socket, real TLS, a real self-signed
 * certificate minted with `generateTunnelKey`/`issueTunnelCertificate`, and a
 * real pin check on a real `tls.TLSSocket` — the same host code every other
 * tunnel test in this repo runs against. Nothing here is mocked except the
 * event delivery from `PluginHost` to a renderer in the last `describe`, which
 * `tests/desktop-bridge.test.ts` already proves matches the real
 * `contextBridge` boundary; duplicating that proof here would test Electron,
 * not this plugin.
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

/** A real, plaintext loopback listener — a device credential minted for real. */
async function plainListener(maxTunnels = 4) {
  const gate = testGate();
  const listener = await createTunnelListener({ maxTunnels, binding: gate.binding() });
  open.push(listener);
  const { port } = listener.server.address() as AddressInfo;
  let upgrades = 0;
  listener.server.on('upgrade', () => (upgrades += 1));
  return { gate, listener, url: `ws://127.0.0.1:${String(port)}`, nextTunnel: reader(listener.tunnels()), upgrades: () => upgrades };
}

/** A real TLS listener, with its own generated key and self-signed certificate. */
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
  return { gate, listener, key, url: `wss://127.0.0.1:${String(port)}`, nextTunnel: reader(listener.tunnels()), upgrades: () => upgrades };
}

/** Every event one plugin instance has emitted, in call order — the test's own `notify`. */
function recordedEvents() {
  const events: { readonly name: string; readonly data: any; readonly ownerId: number }[] = [];
  const notify = (name: string, data: unknown, ownerId: number): void => {
    events.push({ name, data, ownerId });
  };
  return { events, notify, of: (name: string) => events.filter((e) => e.name === name) };
}

/** Poll for a condition a background socket event will eventually make true. No fixed timeout. */
async function until(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const toBase64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64');
const fromBase64 = (text: string): Buffer => Buffer.from(text, 'base64');

const V = TUNNEL_WIRE_VERSION;
const turnFrame = (turn: string): TunnelFrame => ({ v: V, kind: 'turn', turn, toolLoop: 'host', body: { messages: [] } });
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

/** `connect` is `SENDER_SCOPED`: `senderId` first, then the renderer's own argument. */
function methodsOf(plugin: PluginImplementation) {
  return plugin as unknown as {
    connect(senderId: number, options: unknown): Promise<{ readonly connectionId: string }>;
    send(options: unknown): Promise<void>;
    close(options: unknown): Promise<void>;
    negotiatedPeer(options: unknown): Promise<{ readonly spkiSha256: string }>;
  };
}

describe('createTunnelSocketPlugin: connect() validates before any socket is made', () => {
  it('refuses an unparseable url', async () => {
    const plugin = methodsOf(createTunnelSocketPlugin({ notify: recordedEvents().notify }));
    await expect(plugin.connect(1, { url: 'not a url' })).rejects.toMatchObject({ code: 'OPTIONS_REFUSED' });
  });

  it('refuses a credential and a credentialRef together', async () => {
    const plugin = methodsOf(createTunnelSocketPlugin({ notify: recordedEvents().notify }));
    await expect(
      plugin.connect(1, { url: 'wss://127.0.0.1:9/', credential: 'a', credentialRef: 'b' }),
    ).rejects.toMatchObject({ code: 'OPTIONS_REFUSED' });
  });

  it('refuses a credential over plaintext off loopback', async () => {
    const plugin = methodsOf(createTunnelSocketPlugin({ notify: recordedEvents().notify }));
    await expect(plugin.connect(1, { url: 'ws://192.0.2.1:9/', credential: 'secret' })).rejects.toMatchObject({
      code: 'OPTIONS_REFUSED',
    });
  });

  it('refuses a wss: credential with no expectedPeer', async () => {
    const plugin = methodsOf(createTunnelSocketPlugin({ notify: recordedEvents().notify }));
    await expect(plugin.connect(1, { url: 'wss://127.0.0.1:9/', credential: 'secret' })).rejects.toMatchObject({
      code: 'OPTIONS_REFUSED',
    });
  });

  it('a credentialRef naming nothing is CREDENTIAL_MISSING, with no store injected', async () => {
    const plugin = methodsOf(createTunnelSocketPlugin({ notify: recordedEvents().notify }));
    await expect(
      plugin.connect(1, { url: 'wss://127.0.0.1:9/', credentialRef: 'paired-desktop' }),
    ).rejects.toMatchObject({ code: 'CREDENTIAL_MISSING' });
  });

  it('a credentialRef the injected store DOES hold is read, then refused for safety — proving the read happened', async () => {
    const store: CredentialRefStore = { get: (ref) => (ref === 'paired-desktop' ? 'secret' : undefined) };
    const { events, notify } = recordedEvents();
    const plugin = methodsOf(createTunnelSocketPlugin({ notify, credentials: store }));
    // Off loopback and plaintext: this fails the SAFETY check, not the store
    // lookup, which is what proves the store really was read.
    await expect(
      plugin.connect(1, { url: 'ws://192.0.2.1:9/', credentialRef: 'paired-desktop' }),
    ).rejects.toMatchObject({ code: 'OPTIONS_REFUSED' });
    expect(events).toEqual([]);
  });
});

describe('createTunnelSocketPlugin: a real connection over a real listener', () => {
  it('carries a credentialed connection end to end, frame for frame, over plaintext loopback', async () => {
    const { gate, url, nextTunnel } = await plainListener();
    const { credential, deviceId } = await gate.mintDevice();
    const events = recordedEvents();
    const plugin = methodsOf(createTunnelSocketPlugin({ notify: events.notify }));

    const { connectionId } = await plugin.connect(7, { url, credential });
    await until(() => events.of('tunnelOpen').length > 0, 'tunnelOpen');
    expect(events.of('tunnelOpen')[0]).toMatchObject({ data: { connectionId }, ownerId: 7 });

    const tunnel: Tunnel = await nextTunnel();
    expect(tunnel.admission).toEqual({ kind: 'device', deviceId });
    const desktopHears = reader(tunnel.receive());

    await plugin.send({ connectionId, frame: toBase64(encodeFrame(turnFrame('t1'))) });
    expect(await desktopHears()).toStrictEqual(turnFrame('t1'));

    // Not ASCII, so a plugin that decoded and re-encoded text would show it.
    const reply = content('t1', 0, 'héllo \u{1F30D} — café');
    await tunnel.send(reply);
    await tunnel.send(done('t1', 1));
    await until(() => events.of('tunnelFrame').length >= 2, 'two tunnelFrame events');
    const heard = events.of('tunnelFrame').map((e) => decodeFrame(fromBase64(e.data.frame)));
    expect(heard).toEqual([reply, done('t1', 1)]);

    await plugin.close({ connectionId, reason: 'done' });
    await tunnel.closed;
    await until(() => events.of('tunnelClose').length > 0, 'tunnelClose');
    // No `bye` app frame was sent — this plugin closes the raw socket, and
    // the tunnel client above it (not this file) is what says `bye`. So the
    // listener reads this as an abnormal end, correctly: nothing here claims
    // otherwise.
    expect(tunnel.ended()).toMatchObject({ kind: 'abnormal' });
    expect(events.of('tunnelClose')[0]).toMatchObject({ data: { connectionId }, ownerId: 7 });
  });

  it('THE NEGATIVE PIN TEST: a mismatched expectedPeer is refused before the upgrade request, over real TLS', async () => {
    const { gate, url, upgrades } = await tlsListener();
    const { credential } = await gate.mintDevice();
    const impostor = generateTunnelKey();
    const events = recordedEvents();
    const plugin = methodsOf(createTunnelSocketPlugin({ notify: events.notify }));

    // `connect` resolves once the ATTEMPT has started, not once it is open —
    // the contract's own rule. The refusal arrives only through `tunnelClose`.
    await plugin.connect(5, { url, credential, expectedPeer: { spkiSha256: impostor.pin.spkiSha256 } });
    await until(() => events.of('tunnelClose').length > 0, 'tunnelClose (peer mismatch)');

    expect(events.of('tunnelOpen')).toEqual([]);
    expect(events.of('tunnelClose')[0]).toMatchObject({ data: { failure: 'PEER_MISMATCH', code: 1006 }, ownerId: 5 });
    // The handshake ran (that is how the mismatch was seen); the request
    // carrying the credential was never written, so the listener never saw
    // an upgrade at all.
    expect(upgrades()).toBe(0);
  });

  it('the control: the real pin lets the same device in, and DOES write the upgrade', async () => {
    const { gate, url, key, nextTunnel, upgrades } = await tlsListener();
    const { credential, deviceId } = await gate.mintDevice();
    const events = recordedEvents();
    const plugin = methodsOf(createTunnelSocketPlugin({ notify: events.notify }));

    const { connectionId } = await plugin.connect(5, {
      url,
      credential,
      expectedPeer: { spkiSha256: key.pin.spkiSha256 },
    });
    await until(() => events.of('tunnelOpen').length > 0, 'tunnelOpen');
    expect((await nextTunnel()).admission).toEqual({ kind: 'device', deviceId });
    expect(upgrades()).toBe(1);

    // `negotiatedPeer` answers for THIS open connection, and matches the
    // pin the TLS handshake actually produced — #256's binding needs exactly
    // this freshness.
    expect(await plugin.negotiatedPeer({ connectionId })).toEqual({ spkiSha256: key.pin.spkiSha256 });
  });

  it('negotiatedPeer throws for a connection this plugin never issued, or one not open', async () => {
    const { gate, url, key } = await tlsListener();
    const { credential } = await gate.mintDevice();
    const events = recordedEvents();
    const plugin = methodsOf(createTunnelSocketPlugin({ notify: events.notify }));

    await expect(plugin.negotiatedPeer({ connectionId: 'no-such-connection' })).rejects.toThrow();

    const { connectionId } = await plugin.connect(9, {
      url,
      credential,
      expectedPeer: { spkiSha256: key.pin.spkiSha256 },
    });
    // Asked before it has opened: not yet a peer to report.
    await expect(plugin.negotiatedPeer({ connectionId })).rejects.toThrow();
    await until(() => events.of('tunnelOpen').length > 0, 'tunnelOpen');

    await plugin.close({ connectionId });
    await until(() => events.of('tunnelClose').length > 0, 'tunnelClose');
    // Asked again once it has closed: no longer an open connection.
    await expect(plugin.negotiatedPeer({ connectionId })).rejects.toThrow();
  });
});

describe('through a real PluginHost: registration, and one renderer per connection', () => {
  it('delivers tunnelOpen/tunnelFrame/tunnelClose only to the renderer that called connect', async () => {
    const { gate, url, nextTunnel } = await plainListener();
    const { credential, deviceId } = await gate.mintDevice();

    const deliveries: (EventPayload & { readonly senderId: number })[] = [];
    const deliver: EventDelivery = (senderId, payload) => {
      deliveries.push({ ...payload, data: structuredClone(payload.data), senderId });
      return true;
    };
    const host = new PluginHost(deliver);
    host.register(
      TUNNEL_SOCKET_PLUGIN,
      createTunnelSocketPlugin({
        notify: (eventName, data, ownerId) => host.notifyListeners(TUNNEL_SOCKET_PLUGIN.name, eventName, data, ownerId),
      }),
    );

    const OWNER = 100;
    const BYSTANDER = 200;
    host.addListener(OWNER, 'TunnelSocket', 'tunnelOpen', 1);
    host.addListener(OWNER, 'TunnelSocket', 'tunnelClose', 2);
    host.addListener(BYSTANDER, 'TunnelSocket', 'tunnelOpen', 1);
    host.addListener(BYSTANDER, 'TunnelSocket', 'tunnelClose', 2);

    const { connectionId } = (await host.invoke(OWNER, 'TunnelSocket', 'connect', [{ url, credential }])) as {
      connectionId: string;
    };
    await until(() => deliveries.some((d) => d.eventName === 'tunnelOpen'), 'tunnelOpen delivered');
    await nextTunnel();

    await host.invoke(OWNER, 'TunnelSocket', 'close', [{ connectionId, reason: 'done' }]);
    await until(() => deliveries.some((d) => d.eventName === 'tunnelClose'), 'tunnelClose delivered');

    expect(deliveries.length).toBeGreaterThan(0);
    // Every delivery went to OWNER, who called `connect`, and NEVER to
    // BYSTANDER, who holds an identical subscription — `notifyListeners`'s own
    // `ownerId` scoping, exercised through the real host rather than asserted
    // about it in the abstract.
    expect(deliveries.every((d) => d.senderId === OWNER)).toBe(true);
    expect(deliveries.some((d) => d.senderId === BYSTANDER)).toBe(false);
    expect(host.subscriptionCount()).toBe(4);
    host.releaseSender(OWNER);
    expect(host.subscriptionCount()).toBe(2);

    void deviceId;
  });
});
