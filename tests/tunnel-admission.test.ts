// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { X509Certificate, createHash } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import type { AddressInfo, Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { TLSSocket } from 'node:tls';

import { afterEach, describe, expect, it } from 'vitest';
import type { WebSocket as RawSocket } from 'ws';

import { createTunnelClient } from '@chatterang/tunnel/client';
import {
  MAX_PAIRING_BACKLOG,
  MAX_PAIRING_FRAME_BYTES,
  MAX_PAIRING_TUNNELS,
  PAIRING_HANDOVER_MS,
  asTlsMaterial,
  createDeviceCredentials,
  createMemoryCredentialStore,
  createTunnelHost,
  createTunnelListener,
  generateTunnelKey,
  issueTunnelCertificate,
  tunnelKeyPkcs8Pem,
  type CredentialStore,
  type DeviceCredentials,
  type Tunnel,
  type TunnelBinding,
  type TunnelGate,
  type TunnelListener,
  type TunnelListenerOptions,
} from '@chatterang/tunnel/host';
import { openWindow, type PairingWindow } from '@chatterang/tunnel/pairing';
import {
  MAX_FRAME_BYTES,
  TUNNEL_CAP_CLOSE_CODE,
  TUNNEL_CREDENTIAL_HEADER,
  TUNNEL_PAIRING_CLOSED_CLOSE_CODE,
  TUNNEL_PAIRING_ONLY_CLOSE_CODE,
  TUNNEL_WIRE_VERSION,
  decodeFrame,
  encodeFrame,
  type TunnelFrame,
} from '@chatterang/tunnel/wire';

import { codeOf } from './support/source-scan';
import { credentialHeaders, holdableStore, testGate, type TestGate } from './support/tunnel-gate';

/**
 * THE GATE AT THE UPGRADE (#135, #136).
 *
 * #135: a paired phone authenticates with a per-device credential the desktop
 * mints, the desktop keeps only what it needs to verify it, and revoking the
 * device deletes it and closes its live sockets. #136: with no credential, a
 * connection gets in only while the desktop is showing a pairing code, and then
 * only for the pairing exchange; the credential travels in a header, never in
 * the URL.
 *
 * Peers are raw `ws` clients, because the thing under test is request headers
 * and HTTP statuses, and the browser-API client can set neither and reports a
 * refusal as "cannot reach". A refusal "before the upgrade" is observed as the
 * client receiving an HTTP status instead of `101 Switching Protocols`.
 *
 * Manners from `tests/tunnel-listener.test.ts`: ephemeral ports, everything
 * closed in `afterEach`, no deadlines — `eventually` polls and the test timeout
 * is the only bound.
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

const HELLO: TunnelFrame = { v: TUNNEL_WIRE_VERSION, kind: 'hello', body: { protocol: TUNNEL_WIRE_VERSION } };
const PAIR: TunnelFrame = { v: TUNNEL_WIRE_VERSION, kind: 'pair', body: { step: 'message', bytes: 'AAEC' } };
const chunk = (sequence: number, delta: string): TunnelFrame => ({
  v: TUNNEL_WIRE_VERSION,
  kind: 'chunk',
  turn: 't1',
  body: { type: 'content', sequence, delta },
});

/** One of each kind a pairing tunnel may NOT carry. */
const OUTSIDE_THE_EXCHANGE: readonly TunnelFrame[] = [
  { v: TUNNEL_WIRE_VERSION, kind: 'turn', turn: 't1', body: { messages: [] } },
  chunk(0, 'x'),
  { v: TUNNEL_WIRE_VERSION, kind: 'cancel', turn: 't1' },
  { v: TUNNEL_WIRE_VERSION, kind: 'ping' },
  { v: TUNNEL_WIRE_VERSION, kind: 'pong' },
  { v: TUNNEL_WIRE_VERSION, kind: 'error', body: { code: 'X', message: 'x' } },
];

async function eventually(check: () => boolean | Promise<boolean>): Promise<void> {
  while (!(await check())) await new Promise((resolve) => setTimeout(resolve, 5));
}

async function listen(
  gate: TestGate = testGate(),
  options: Partial<Omit<TunnelListenerOptions, 'binding'>> = {},
) {
  const listener = await createTunnelListener({ maxTunnels: 4, ...options, binding: gate.binding() });
  open.push(listener);
  const { port } = listener.server.address() as AddressInfo;
  return { listener, port, incoming: listener.tunnels()[Symbol.asyncIterator]() };
}

async function nextTunnel(incoming: AsyncIterator<Tunnel>): Promise<Tunnel> {
  const result = await incoming.next();
  if (result.done) throw new Error('the listener stopped handing out tunnels');
  return result.value;
}

interface Peer {
  readonly socket: RawSocket;
  readonly frames: TunnelFrame[];
  readonly closeCode: Promise<number>;
}

type Outcome =
  /** Refused with an HTTP status: the upgrade never happened. */
  | { readonly status: number }
  /** Upgraded. */
  | { readonly peer: Peer }
  /** Neither: the connection went away with no answer. */
  | { readonly error: Error };

/** Attempt an upgrade and report what came back. */
async function connect(
  port: number,
  options: { readonly credential?: string; readonly path?: string } = {},
): Promise<Outcome> {
  const { WebSocket } = await import('ws');
  const socket = new WebSocket(`ws://127.0.0.1:${port}${options.path ?? ''}`, {
    headers: options.credential === undefined ? {} : credentialHeaders(options.credential),
  });
  open.push({ close: () => socket.terminate() });
  socket.on('error', () => undefined);
  const frames: TunnelFrame[] = [];
  socket.on('message', (data: Buffer) => frames.push(decodeFrame(new Uint8Array(data))));
  const closeCode = new Promise<number>((resolve) => socket.once('close', (code: number) => resolve(code)));
  return new Promise<Outcome>((resolve) => {
    socket.once('unexpected-response', (request, response) => {
      resolve({ status: response.statusCode ?? 0 });
      request.destroy();
    });
    socket.once('open', () => resolve({ peer: { socket, frames, closeCode } }));
    socket.once('error', (error: Error) => resolve({ error }));
  });
}

function peerOf(outcome: Outcome): Peer {
  if (!('peer' in outcome)) throw new Error(`expected an upgrade, got ${JSON.stringify(outcome)}`);
  return outcome.peer;
}

/**
 * The listener's end of the NEXT TCP connection, so a test can wait until the
 * listener has read bytes a peer sent without reading the frames itself.
 * Register before connecting.
 */
function nextServerSocket(listener: TunnelListener): Promise<Socket> {
  return new Promise<Socket>((resolveSocket) => listener.server.once('connection', resolveSocket));
}

/**
 * Bytes a client frame of this encoding occupies on the wire: a 2-byte header
 * and a 4-byte mask, for a payload under 126 bytes, which every frame this is
 * used for is.
 */
function wireBytes(frames: readonly Uint8Array[]): number {
  for (const frame of frames) expect(frame.byteLength).toBeLessThan(126);
  return frames.reduce((total, frame) => total + frame.byteLength + 6, 0);
}

function pairingAdmission(tunnel: Tunnel): Extract<Tunnel['admission'], { kind: 'pairing' }> {
  if (tunnel.admission.kind !== 'pairing') throw new Error('expected a pairing tunnel');
  return tunnel.admission;
}

/**
 * An upgrade written by hand, for a request no WebSocket client will send: a
 * header given twice. Resolves with the status line once the listener drops
 * the connection, so it is only for requests that are refused.
 */
async function rawUpgrade(port: number, lines: readonly string[]): Promise<string> {
  const { connect: tcpConnect } = await import('node:net');
  const tcp = tcpConnect(port, '127.0.0.1');
  open.push({ close: () => tcp.destroy() });
  tcp.on('error', () => undefined);
  return new Promise<string>((resolve) => {
    let received = '';
    tcp.on('data', (data: Buffer) => {
      received += data.toString('latin1');
    });
    tcp.once('close', () => resolve(received.split('\r\n')[0] ?? ''));
    tcp.write(
      [
        'GET / HTTP/1.1',
        `Host: 127.0.0.1:${String(port)}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
        'Sec-WebSocket-Version: 13',
        ...lines,
        '',
        '',
      ].join('\r\n'),
    );
  });
}

describe('a device credential, at the upgrade', () => {
  it('is admitted as the device it was minted for', async () => {
    const gate = testGate();
    const a = await gate.mintDevice();
    const b = await gate.mintDevice();
    const { port, incoming } = await listen(gate);

    peerOf(await connect(port, { credential: a.credential }));
    expect((await nextTunnel(incoming)).admission).toEqual({ kind: 'device', deviceId: a.deviceId });
    // A second device is ITSELF, so the first assertion is not a gate that
    // names every tunnel after the first device it knows.
    peerOf(await connect(port, { credential: b.credential }));
    expect((await nextTunnel(incoming)).admission).toEqual({ kind: 'device', deviceId: b.deviceId });
    expect(a.deviceId).not.toBe(b.deviceId);
  });

  it('a wrong, unknown or malformed credential is refused with 401, before the upgrade', async () => {
    const gate = testGate();
    const a = await gate.mintDevice();
    const b = await gate.mintDevice();
    const { port, incoming } = await listen(gate);

    const [aId, aSecret] = a.credential.split('.') as [string, string];
    const [, bSecret] = b.credential.split('.') as [string, string];
    const flipped = `${aSecret.slice(0, -1)}${aSecret.endsWith('A') ? 'B' : 'A'}`;
    for (const [name, credential] of [
      ['the right device with one character of its secret changed', `${aId}.${flipped}`],
      ["another device's secret under this device's id", `${aId}.${bSecret}`],
      ['a well-formed credential for a device nobody minted', `${'A'.repeat(22)}.${aSecret}`],
      ['the device id alone', aId],
      ['the secret alone', aSecret],
      ['the credential with trailing bytes', `${a.credential}x`],
      ['an empty header', ''],
    ] as const) {
      expect(await connect(port, { credential: credential }), name).toEqual({ status: 401 });
    }

    // Nothing refused was handed out: the next tunnel is the one a valid
    // credential opens, not a refused peer queued ahead of it.
    peerOf(await connect(port, { credential: a.credential }));
    expect((await nextTunnel(incoming)).admission).toEqual({ kind: 'device', deviceId: a.deviceId });
  });

  it('a header given twice is refused, not read as either value', async () => {
    const gate = testGate();
    const a = await gate.mintDevice();
    const { port } = await listen(gate);
    const line = `${TUNNEL_CREDENTIAL_HEADER}: ${a.credential}`;
    expect(await rawUpgrade(port, [line, line])).toBe('HTTP/1.1 401 Unauthorized');
  });

  it('no credential, with no pairing code shown, is refused with 401', async () => {
    const { port } = await listen();
    expect(await connect(port)).toEqual({ status: 401 });
  });

  it('a credential is verified even while a pairing code is shown, and a bad one is never offered pairing', async () => {
    /*
     * THE HEADER IS FINAL. A phone whose credential was revoked or corrupted
     * must not be quietly admitted to the pairing exchange because a code
     * happens to be on screen — that would be a revoked device reaching the
     * one thing that mints credentials.
     */
    const gate = testGate();
    const a = await gate.mintDevice();
    await gate.credentials.revoke(a.deviceId);
    const { port } = await listen(gate);
    gate.showCode();

    expect(await connect(port, { credential: a.credential })).toEqual({ status: 401 });
    expect(await connect(port, { credential: 'not a credential' })).toEqual({ status: 401 });
    // The control: the same window admits a peer that presents nothing.
    peerOf(await connect(port));
  });

  it('a store that cannot be read admits nobody, and says 503 rather than 401', async () => {
    const inner = createMemoryCredentialStore();
    const failing: CredentialStore = {
      get: async () => {
        throw new Error('the registry is unreadable');
      },
      set: (deviceId, digest) => inner.set(deviceId, digest),
      delete: (deviceId) => inner.delete(deviceId),
    };
    const gate = testGate(failing);
    const a = await gate.mintDevice();
    const { port } = await listen(gate);
    expect(await connect(port, { credential: a.credential })).toEqual({ status: 503 });
  });

  it('a stored digest of the wrong width is refused, not thrown', async () => {
    /*
     * `timingSafeEqual` THROWS on two lengths. A store that hands back 31 bytes
     * — broken or tampered with — must be a refusal of that device, not a
     * rejected verify that the listener reports as a broken registry.
     */
    const inner = createMemoryCredentialStore();
    const short: CredentialStore = {
      get: async (deviceId) => (await inner.get(deviceId))?.slice(1),
      set: (deviceId, digest) => inner.set(deviceId, digest),
      delete: (deviceId) => inner.delete(deviceId),
    };
    const gate = testGate(short);
    const a = await gate.mintDevice();
    const { port } = await listen(gate);
    expect(await connect(port, { credential: a.credential })).toEqual({ status: 401 });
  });
});

describe('the URL carries nothing', () => {
  it('a credential in the query is REFUSED, not ignored — even beside a valid header', async () => {
    /*
     * #136: never in the URL, where request-line logs and history keep it.
     * IGNORING it is the failure: a client that sends it there would keep
     * working, and keep leaking it. So the request is refused whatever else it
     * carries, and the client finds out.
     */
    const gate = testGate();
    const a = await gate.mintDevice();
    const { port, incoming } = await listen(gate);
    gate.showCode();

    // A valid credential in the query, with nothing in the header — which,
    // with a code shown, would otherwise be admitted to pair.
    expect(await connect(port, { path: `/?credential=${a.credential}` })).toEqual({ status: 400 });
    // A valid credential in BOTH places.
    expect(await connect(port, { path: `/?credential=${a.credential}`, credential: a.credential })).toEqual({
      status: 400,
    });
    // Whatever the parameter is called.
    expect(await connect(port, { path: `/?token=${a.credential}`, credential: a.credential })).toEqual({
      status: 400,
    });
    // And in the path.
    expect(await connect(port, { path: `/${a.credential}`, credential: a.credential })).toEqual({ status: 400 });

    // The control: the same credential, in the header, on `/`.
    peerOf(await connect(port, { credential: a.credential }));
    expect((await nextTunnel(incoming)).admission).toEqual({ kind: 'device', deviceId: a.deviceId });
  });
});

describe('pairing, only while a code is shown (#136)', () => {
  it('no credential while a window is open is admitted to PAIR, bound to that window', async () => {
    const gate = testGate();
    const { port, incoming } = await listen(gate);
    const { window } = gate.showCode();

    const peer = peerOf(await connect(port));
    const tunnel = await nextTunnel(incoming);
    expect(tunnel.admission.kind).toBe('pairing');
    expect(tunnel.admission.kind === 'pairing' ? tunnel.admission.window : null).toBe(window);

    // The exchange crosses, both ways.
    peer.socket.send(encodeFrame(HELLO));
    peer.socket.send(encodeFrame(PAIR));
    const inbound = tunnel.receive()[Symbol.asyncIterator]();
    expect((await inbound.next()).value).toEqual(HELLO);
    expect((await inbound.next()).value).toEqual(PAIR);
    await tunnel.send(PAIR);
    await eventually(() => peer.frames.length === 1);
    expect(peer.frames).toEqual([PAIR]);
    expect(tunnel.ended()).toBeNull();
  });

  it('a frame outside the exchange closes it with the named code, and is never read', async () => {
    const gate = testGate();
    const { port, incoming } = await listen(gate);
    gate.showCode();

    for (const frame of OUTSIDE_THE_EXCHANGE) {
      const peer = peerOf(await connect(port));
      const tunnel = await nextTunnel(incoming);
      peer.socket.send(encodeFrame(PAIR));
      peer.socket.send(encodeFrame(frame));

      expect(await peer.closeCode, frame.kind).toBe(TUNNEL_PAIRING_ONLY_CLOSE_CODE);
      await tunnel.closed;
      expect(tunnel.ended(), frame.kind).toMatchObject({ kind: 'abnormal', code: 'PAIRING_ONLY' });
      // The pair frame before it was delivered; the refused frame was not.
      const received: TunnelFrame[] = [];
      for await (const got of tunnel.receive()) received.push(got);
      expect(received, frame.kind).toEqual([PAIR]);
    }
  });

  it('the desktop cannot send a pairing tunnel anything outside the exchange either', async () => {
    const gate = testGate();
    const { port, incoming } = await listen(gate);
    gate.showCode();
    const peer = peerOf(await connect(port));
    const tunnel = await nextTunnel(incoming);

    await expect(tunnel.send(chunk(0, 'a reply for a phone nobody paired'))).rejects.toThrow(
      /only the pairing exchange/,
    );
    expect(await peer.closeCode).toBe(TUNNEL_PAIRING_ONLY_CLOSE_CODE);
    expect(peer.frames).toEqual([]);
    expect(tunnel.ended()).toMatchObject({ kind: 'abnormal', code: 'PAIRING_ONLY' });
  });

  it('a pairing tunnel gets no greeting, and a device tunnel on the same listener does', async () => {
    const gate = testGate();
    const a = await gate.mintDevice();
    const { port, incoming } = await listen(gate, { greeting: [HELLO] });

    const device = peerOf(await connect(port, { credential: a.credential }));
    await nextTunnel(incoming);
    await eventually(() => device.frames.length === 1);
    expect(device.frames).toEqual([HELLO]);

    gate.showCode();
    const pairing = peerOf(await connect(port));
    const tunnel = await nextTunnel(incoming);
    // Something the desktop DOES send arrives, so the empty list before it is
    // the absence of a greeting and not a peer that hears nothing.
    await tunnel.send(PAIR);
    await eventually(() => pairing.frames.length === 1);
    expect(pairing.frames).toEqual([PAIR]);
  });

  it('refuses a peer with no credential once the window has expired, been claimed, or been cancelled', async () => {
    const gate = testGate();
    const { port } = await listen(gate);

    const expiring = gate.showCode(1_000);
    peerOf(await connect(port));
    gate.clock.now = expiring.window.expiresAt;
    expect(await connect(port), 'expired').toEqual({ status: 401 });

    const claimed = gate.showCode();
    peerOf(await connect(port));
    expect(claimed.window.claim(claimed.secret, gate.clock.now).ok).toBe(true);
    expect(await connect(port), 'claimed').toEqual({ status: 401 });

    gate.showCode();
    peerOf(await connect(port));
    gate.pairing.cancel();
    expect(await connect(port), 'cancelled').toEqual({ status: 401 });

    // Each state was preceded by the same window ADMITTING a peer, so each 401
    // is that state's and not a listener that refuses everyone.
  });

  it('a window cancelled while the upgrade is being decided refuses it', async () => {
    /*
     * THE RE-CHECK IN THE TURN THAT ADMITS. The decision and the handshake
     * are separate turns; a code dismissed between them must not let the
     * peer through. The pairing holder here cancels its window the moment
     * the gate has looked at it, which is as late as anything can land.
     */
    const inner = testGate();
    let cancelAfterLook = false;
    const pairing: TunnelGate['pairing'] = {
      issue: (options) => inner.pairing.issue(options),
      cancel: () => inner.pairing.cancel(),
      current: () => {
        const window = inner.pairing.current();
        if (cancelAfterLook) queueMicrotask(() => inner.pairing.cancel());
        return window;
      },
    };
    const listener = await createTunnelListener({
      maxTunnels: 2,
      binding: { kind: 'loopback', port: 0, gate: { ...inner.gate, pairing } },
    });
    open.push(listener);
    const { port } = listener.server.address() as AddressInfo;

    inner.showCode();
    peerOf(await connect(port));
    cancelAfterLook = true;
    expect(await connect(port)).toEqual({ status: 401 });
  });

  it('a pairing tunnel ends the moment its code is dismissed or replaced, while it sends nothing', async () => {
    /*
     * #136: reachable only while the desktop shows a code. A silent pairing
     * tunnel used to be checked only when a frame moved, so in review it
     * outlived a dismissed code for as long as the listener ran.
     */
    const gate = testGate();
    const { port, incoming } = await listen(gate);

    gate.showCode();
    const dismissedPeer = peerOf(await connect(port));
    const dismissed = await nextTunnel(incoming);
    gate.pairing.cancel();
    // In the turn the code is dismissed: no await between the two.
    expect(dismissed.ended()).toMatchObject({ kind: 'abnormal', code: 'PAIRING_WINDOW_CLOSED' });
    expect(await dismissedPeer.closeCode).toBe(TUNNEL_PAIRING_CLOSED_CLOSE_CODE);

    gate.showCode();
    const replacedPeer = peerOf(await connect(port));
    const replaced = await nextTunnel(incoming);
    gate.showCode();
    expect(replaced.ended()).toMatchObject({ kind: 'abnormal', code: 'PAIRING_WINDOW_CLOSED' });
    expect(await replacedPeer.closeCode).toBe(TUNNEL_PAIRING_CLOSED_CLOSE_CODE);
    expect([...dismissedPeer.frames, ...replacedPeer.frames]).toEqual([]);
  });

  it('a silent pairing tunnel ends when its code expires, on a timer, with nothing else happening', async () => {
    /*
     * A 20 ms window on the test's clock, so the listener's timer is due in
     * 20 ms of real time. If it fires before the clock is moved it asks, finds
     * the window still issued, and sets itself again — so this waits on the
     * close it means, not on a race with the timer.
     */
    const gate = testGate();
    const { port, incoming } = await listen(gate);
    const code = gate.showCode(20);
    const peer = peerOf(await connect(port));
    const tunnel = await nextTunnel(incoming);
    gate.clock.now = code.window.expiresAt;
    expect(await peer.closeCode).toBe(TUNNEL_PAIRING_CLOSED_CLOSE_CODE);
    expect(tunnel.ended()).toMatchObject({ kind: 'abnormal', code: 'PAIRING_WINDOW_CLOSED' });
  });

  it('and at the next upgrade of anyone, if its timer has not fired', async () => {
    /*
     * The default window, so the timer is two minutes away and cannot be what
     * ends it. A DEVICE connects — the gate never asks a device about the
     * window — so the only thing left that asks is the sweep at the upgrade.
     */
    const gate = testGate();
    const a = await gate.mintDevice();
    const { port, incoming } = await listen(gate);
    const code = gate.showCode();
    const peer = peerOf(await connect(port));
    const tunnel = await nextTunnel(incoming);
    gate.clock.now = code.window.expiresAt;
    expect(tunnel.ended()).toBeNull();

    peerOf(await connect(port, { credential: a.credential }));
    expect(await peer.closeCode).toBe(TUNNEL_PAIRING_CLOSED_CLOSE_CODE);
    expect(tunnel.ended()).toMatchObject({ kind: 'abnormal', code: 'PAIRING_WINDOW_CLOSED' });
  });

  it('and at its next frame, the desktop sending included', async () => {
    const gate = testGate();
    const { port, incoming } = await listen(gate);
    const code = gate.showCode();
    const peer = peerOf(await connect(port));
    const tunnel = await nextTunnel(incoming);
    gate.clock.now = code.window.expiresAt;
    await expect(tunnel.send(PAIR)).rejects.toThrow(/no longer shown/);
    expect(await peer.closeCode).toBe(TUNNEL_PAIRING_CLOSED_CLOSE_CODE);
    expect(peer.frames).toEqual([]);
  });

  it('the tunnel that claims keeps its channel for the handover, and every other pairing tunnel under the window ends at once', async () => {
    /*
     * Measured in review before this: a stranger connected beside the real
     * phone, the phone's pairing claimed the window, and an hour later the
     * stranger's tunnel still carried `pair` frames both ways. A claim is now
     * made THROUGH the tunnel, so the listener knows whose it was.
     */
    const gate = testGate();
    const a = await gate.mintDevice();
    const { port, incoming } = await listen(gate);
    const code = gate.showCode();
    const phonePeer = peerOf(await connect(port));
    const phone = await nextTunnel(incoming);
    const strangerPeer = peerOf(await connect(port));
    const stranger = await nextTunnel(incoming);

    expect(pairingAdmission(phone).claim(code.secret)).toEqual({ ok: true, state: 'claimed' });
    // The stranger, silent, ends in the claim's own turn.
    expect(stranger.ended()).toMatchObject({ kind: 'abnormal', code: 'PAIRING_WINDOW_CLOSED' });
    expect(await strangerPeer.closeCode).toBe(TUNNEL_PAIRING_CLOSED_CLOSE_CODE);

    // The claimant still carries the exchange both ways: its credential goes back on it.
    phonePeer.socket.send(encodeFrame(PAIR));
    expect((await phone.receive()[Symbol.asyncIterator]().next()).value).toEqual(PAIR);
    gate.clock.now += PAIRING_HANDOVER_MS - 1;
    await phone.send(PAIR);
    await eventually(() => phonePeer.frames.length === 1);
    expect(phone.ended()).toBeNull();

    // Until the handover is spent on the gate's clock — asked here by the next upgrade.
    gate.clock.now += 1;
    peerOf(await connect(port, { credential: a.credential }));
    expect(await phonePeer.closeCode).toBe(TUNNEL_PAIRING_CLOSED_CLOSE_CODE);
    expect(phone.ended()).toMatchObject({ kind: 'abnormal', code: 'PAIRING_WINDOW_CLOSED' });
  });

  it('a window claimed directly, with no tunnel to attribute it to, ends every pairing tunnel under it', async () => {
    const gate = testGate();
    const { port, incoming } = await listen(gate);
    const code = gate.showCode();
    const first = peerOf(await connect(port));
    await nextTunnel(incoming);
    const second = peerOf(await connect(port));
    await nextTunnel(incoming);

    expect(code.window.claim(code.secret, gate.clock.now).ok).toBe(true);
    expect(await first.closeCode).toBe(TUNNEL_PAIRING_CLOSED_CLOSE_CODE);
    expect(await second.closeCode).toBe(TUNNEL_PAIRING_CLOSED_CLOSE_CODE);
  });

  it('a pairing tunnel that has ended cannot claim, and the window stays open for one that can', async () => {
    const gate = testGate();
    const { port, incoming } = await listen(gate);
    const code = gate.showCode();
    const peer = peerOf(await connect(port));
    const tunnel = await nextTunnel(incoming);
    peer.socket.terminate();
    await tunnel.closed;

    expect(() => pairingAdmission(tunnel).claim(code.secret)).toThrow(/has ended/);
    expect(code.window.state(gate.clock.now)).toBe('issued');
  });

  it("pairing tunnels have their own cap, and never hold a paired phone's slot", async () => {
    /*
     * Measured in review before this: with `maxTunnels: 2`, two silent peers
     * that connected while a code was shown kept a paired phone out — its valid
     * credential was admitted and then closed with the cap code — until the
     * listener restarted.
     */
    const gate = testGate();
    const a = await gate.mintDevice();
    const { port, incoming } = await listen(gate, { maxTunnels: 1 });
    gate.showCode();

    for (let i = 0; i < MAX_PAIRING_TUNNELS; i += 1) {
      peerOf(await connect(port));
      expect((await nextTunnel(incoming)).admission.kind).toBe('pairing');
    }
    const over = peerOf(await connect(port));
    expect(await over.closeCode).toBe(TUNNEL_CAP_CLOSE_CODE);

    // Every pairing slot is taken, and the one device slot is still the phone's.
    const phone = peerOf(await connect(port, { credential: a.credential }));
    expect((await nextTunnel(incoming)).admission).toEqual({ kind: 'device', deviceId: a.deviceId });
    phone.socket.send(encodeFrame(chunk(0, 'still mine')));
    expect(phone.socket.readyState).toBe(phone.socket.OPEN);
  });

  it('a pairing tunnel may not send a message past MAX_PAIRING_FRAME_BYTES; a device may', async () => {
    const gate = testGate();
    const a = await gate.mintDevice();
    const { port, incoming } = await listen(gate);
    const filler = 'A'.repeat(MAX_PAIRING_FRAME_BYTES);

    // The control: a device's message of the same size is read.
    const device = peerOf(await connect(port, { credential: a.credential }));
    const deviceTunnel = await nextTunnel(incoming);
    expect(encodeFrame(chunk(0, filler)).byteLength).toBeGreaterThan(MAX_PAIRING_FRAME_BYTES);
    device.socket.send(encodeFrame(chunk(0, filler)));
    expect((await deviceTunnel.receive()[Symbol.asyncIterator]().next()).value).toEqual(chunk(0, filler));

    gate.showCode();
    const stranger = peerOf(await connect(port));
    const pairing = await nextTunnel(incoming);
    const big: TunnelFrame = { v: TUNNEL_WIRE_VERSION, kind: 'pair', body: filler };
    stranger.socket.send(encodeFrame(big));
    // 1009, Message Too Big: `ws` refused it, before buffering it into a frame.
    expect(await stranger.closeCode).toBe(1009);
    await pairing.closed;
    expect(pairing.ended()).toMatchObject({ kind: 'abnormal', code: 'FRAME_INVALID' });
  });

  it("a device's message past MAX_FRAME_BYTES is refused by ws, not buffered and handed to the codec", async () => {
    /*
     * The codec refuses it too, but only after `ws` has buffered it — up to
     * `ws`'s own 100 MiB default. The codec's refusal closes with no code
     * (1005); `ws`'s, with 1009. So the code says which one stopped it.
     */
    const gate = testGate();
    const a = await gate.mintDevice();
    const { port, incoming } = await listen(gate);
    const device = peerOf(await connect(port, { credential: a.credential }));
    const tunnel = await nextTunnel(incoming);
    device.socket.send(new Uint8Array(MAX_FRAME_BYTES + 1));
    expect(await device.closeCode).toBe(1009);
    await tunnel.closed;
    expect(tunnel.ended()).toMatchObject({ kind: 'abnormal', code: 'FRAME_INVALID' });
  });

  it('a pairing tunnel that queues more than MAX_PAIRING_BACKLOG unread frames is closed, not buffered', async () => {
    /*
     * Measured in review before this: sixteen 4 MiB `pair` frames, nobody
     * reading, all accepted and the tunnel still open. The listener's socket's
     * `bytesRead` says when every frame has been read off the wire, so the
     * control half waits on that rather than on a clock.
     */
    const gate = testGate();
    const { listener, port, incoming } = await listen(gate);
    gate.showCode();
    const serverSide = nextServerSocket(listener);
    const stranger = peerOf(await connect(port));
    const tunnel = await nextTunnel(incoming);
    const socket = await serverSide;
    const base = socket.bytesRead;
    const frame = encodeFrame(PAIR);

    // Exactly the backlog, read in full, and the tunnel is still open.
    const backlog = Array.from({ length: MAX_PAIRING_BACKLOG }, () => frame);
    for (const each of backlog) stranger.socket.send(each);
    await eventually(() => socket.bytesRead - base >= wireBytes(backlog));
    expect(tunnel.ended()).toBeNull();

    // One more.
    stranger.socket.send(frame);
    expect(await stranger.closeCode).toBe(TUNNEL_PAIRING_ONLY_CLOSE_CODE);
    expect(tunnel.ended()).toMatchObject({ kind: 'abnormal', code: 'PAIRING_BACKLOG' });
    const received: TunnelFrame[] = [];
    for await (const got of tunnel.receive()) received.push(got);
    expect(received).toHaveLength(MAX_PAIRING_BACKLOG);
  });

  it("rung 0's host admits devices only: no credential is refused even while a code is shown", async () => {
    const gate = testGate();
    const host = await createTunnelHost({ binding: gate.binding() });
    open.push(host);
    const { port } = host.server.address() as AddressInfo;
    gate.showCode();
    expect(await connect(port)).toEqual({ status: 401 });
    expect(host.ended()).toBeNull();
  });

  it('the real client hears PAIRING_WINDOW_CLOSED when the code goes, which is not PAIRING_ONLY', async () => {
    const gate = testGate();
    const { port, incoming } = await listen(gate);
    gate.showCode();

    const client = await createTunnelClient({ url: `ws://127.0.0.1:${port}` });
    open.push(client);
    await nextTunnel(incoming);
    gate.pairing.cancel();
    await client.closed;
    expect(client.ended()).toMatchObject({ kind: 'abnormal', code: 'PAIRING_WINDOW_CLOSED' });
    expect(TUNNEL_PAIRING_CLOSED_CLOSE_CODE).not.toBe(TUNNEL_PAIRING_ONLY_CLOSE_CODE);
  });

  it('the real client hears PAIRING_ONLY, not PEER_GONE', async () => {
    const gate = testGate();
    const { port, incoming } = await listen(gate);
    gate.showCode();

    const client = await createTunnelClient({ url: `ws://127.0.0.1:${port}` });
    open.push(client);
    await nextTunnel(incoming);
    await client.send(chunk(0, 'a turn from a phone nobody paired'));
    await client.closed;
    expect(client.ended()).toMatchObject({ kind: 'abnormal', code: 'PAIRING_ONLY' });
  });
});

describe('revocation (#135)', () => {
  it("closes that device's live tunnel, refuses it next time, and leaves another device's open", async () => {
    const gate = testGate();
    const a = await gate.mintDevice();
    const b = await gate.mintDevice();
    const { listener, port, incoming } = await listen(gate);

    const peerA = peerOf(await connect(port, { credential: a.credential }));
    const tunnelA = await nextTunnel(incoming);
    const peerB = peerOf(await connect(port, { credential: b.credential }));
    const tunnelB = await nextTunnel(incoming);

    expect(await gate.credentials.revoke(a.deviceId)).toBe(true);

    // Closed, not merely refused on next connect — and told why.
    await peerA.closeCode;
    expect(peerA.frames.at(-1)).toEqual({ v: TUNNEL_WIRE_VERSION, kind: 'bye', body: { reason: 'revoked' } });
    expect(tunnelA.ended()).toEqual({ kind: 'clean', reason: 'revoked' });

    // The other device is untouched and still carries frames.
    expect(tunnelB.ended()).toBeNull();
    peerB.socket.send(encodeFrame(chunk(0, 'still here')));
    const next = await tunnelB.receive()[Symbol.asyncIterator]().next();
    expect(next.done ? undefined : next.value).toEqual(chunk(0, 'still here'));
    expect(listener.server.listening).toBe(true);

    // The revoked device is refused; the other is still admitted.
    expect(await connect(port, { credential: a.credential })).toEqual({ status: 401 });
    peerOf(await connect(port, { credential: b.credential }));
    expect((await nextTunnel(incoming)).admission).toEqual({ kind: 'device', deviceId: b.deviceId });
  });

  it('closes EVERY tunnel the device holds, and they have ended by the time revoke resolves', async () => {
    /*
     * Two sockets for one device is the ordinary case until #169's stale-socket
     * replacement is built. Asserted in the turn `revoke` resolves, before
     * either peer's close is awaited: `revoke` waits for the listener to close
     * them, and a test that awaited the peers first could not see that.
     */
    const gate = testGate();
    const a = await gate.mintDevice();
    const { port, incoming } = await listen(gate);
    const first = peerOf(await connect(port, { credential: a.credential }));
    const firstTunnel = await nextTunnel(incoming);
    const second = peerOf(await connect(port, { credential: a.credential }));
    const secondTunnel = await nextTunnel(incoming);

    await gate.credentials.revoke(a.deviceId);
    expect(firstTunnel.ended()).toEqual({ kind: 'clean', reason: 'revoked' });
    expect(secondTunnel.ended()).toEqual({ kind: 'clean', reason: 'revoked' });
    for (const peer of [first, second]) {
      await peer.closeCode;
      expect(peer.frames.at(-1)).toEqual({ v: TUNNEL_WIRE_VERSION, kind: 'bye', body: { reason: 'revoked' } });
    }
  });

  it('drops the frames a revoked device had queued, where a plain close leaves them readable', async () => {
    /*
     * #135: revocation purges the queue. Measured in review before this: a
     * `turn` the desktop had not read yet was still yielded by `receive()`
     * after `revoke()` resolved. The listener's socket's `bytesRead` says when
     * the frames have been read off the wire, without reading them.
     */
    const turn = (id: string): TunnelFrame => ({ v: TUNNEL_WIRE_VERSION, kind: 'turn', turn: id, body: { messages: [] } });
    const frames = ['t1', 't2', 't3'].map((id) => encodeFrame(turn(id)));
    const gate = testGate();
    const revokedDevice = await gate.mintDevice();
    const closedDevice = await gate.mintDevice();
    const { listener, port, incoming } = await listen(gate);

    const queue = async (credential: string) => {
      const serverSide = nextServerSocket(listener);
      const peer = peerOf(await connect(port, { credential }));
      const tunnel = await nextTunnel(incoming);
      const socket = await serverSide;
      const base = socket.bytesRead;
      for (const frame of frames) peer.socket.send(frame);
      await eventually(() => socket.bytesRead - base >= wireBytes(frames));
      return tunnel;
    };
    const drain = async (tunnel: Tunnel) => {
      const received: TunnelFrame[] = [];
      for await (const got of tunnel.receive()) received.push(got);
      return received;
    };

    // The control: queued, then closed deliberately, and all three still read.
    const closed = await queue(closedDevice.credential);
    await closed.close('done');
    expect(await drain(closed)).toEqual([turn('t1'), turn('t2'), turn('t3')]);

    const revoked = await queue(revokedDevice.credential);
    await gate.credentials.revoke(revokedDevice.deviceId);
    expect(await drain(revoked)).toEqual([]);
  });

  it('reads nothing a peer sends after this side has begun closing', async () => {
    /*
     * The frames are written in the same turn `close()` is called, so the
     * listener can only read them afterwards, while its `bye` is flushing.
     * Measured in review before this: fifty frames sent in the turn a device
     * was revoked all reached `receive()`.
     */
    const gate = testGate();
    const a = await gate.mintDevice();
    const { port, incoming } = await listen(gate);
    const peer = peerOf(await connect(port, { credential: a.credential }));
    const tunnel = await nextTunnel(incoming);

    await new Promise<void>((resolveSent) => {
      setTimeout(() => {
        void tunnel.close('going');
        for (let i = 0; i < 50; i += 1) peer.socket.send(encodeFrame(chunk(i, 'after')));
        resolveSent();
      }, 0);
    });
    const received: TunnelFrame[] = [];
    for await (const got of tunnel.receive()) received.push(got);
    expect(received).toEqual([]);
    expect(tunnel.ended()).toEqual({ kind: 'clean', reason: 'going' });
  });

  it('delivers nothing a peer sends after its own bye', async () => {
    // One write, so the listener reads both in order: the `bye` ends the
    // tunnel, and the chunk behind it is not read into anything.
    const gate = testGate();
    const a = await gate.mintDevice();
    const { port, incoming } = await listen(gate);
    const peer = peerOf(await connect(port, { credential: a.credential }));
    const tunnel = await nextTunnel(incoming);
    const bye = encodeFrame({ v: TUNNEL_WIRE_VERSION, kind: 'bye', body: { reason: 'leaving' } });
    const late = encodeFrame(chunk(0, 'after my bye'));
    peer.socket.send(bye);
    peer.socket.send(late);

    const received: TunnelFrame[] = [];
    for await (const got of tunnel.receive()) received.push(got);
    expect(tunnel.ended()).toEqual({ kind: 'clean', reason: 'leaving' });
    expect(received).toEqual([]);
  });

  it('a closed listener stops listening for revocations', async () => {
    // #158's toggle stops and starts a listener over one registry. A stopped
    // listener that stayed subscribed would be called on every revocation after.
    const gate = testGate();
    let watching = 0;
    const counted = {
      ...gate.credentials,
      watchRevocations(onRevoke: (deviceId: string) => Promise<void>) {
        watching += 1;
        const off = gate.credentials.watchRevocations(onRevoke);
        return () => {
          watching -= 1;
          off();
        };
      },
    } as DeviceCredentials;
    const listener = await createTunnelListener({
      maxTunnels: 1,
      binding: { kind: 'loopback', port: 0, gate: { ...gate.gate, credentials: counted } },
    });
    open.push(listener);
    expect(watching).toBe(1);
    await listener.close();
    expect(watching).toBe(0);
  });

  it('forgets the digest', async () => {
    const store = createMemoryCredentialStore();
    const gate = testGate(store);
    const a = await gate.mintDevice();
    expect(await store.get(a.deviceId)).toBeDefined();
    expect(await gate.credentials.revoke(a.deviceId)).toBe(true);
    expect(await store.get(a.deviceId)).toBeUndefined();
    expect(await gate.credentials.verify(a.credential)).toBeNull();
  });

  it('a revocation that lands while the credential is being read wins', async () => {
    const held = holdableStore();
    const gate = testGate(held.store);
    const a = await gate.mintDevice();
    const { port } = await listen(gate);

    held.holdReads();
    const outcome = connect(port, { credential: a.credential });
    await held.read;
    await gate.credentials.revoke(a.deviceId);
    held.release();
    expect(await outcome).toEqual({ status: 401 });
  });

  it('a store whose delete fails still leaves the device refused, and its tunnel closed', async () => {
    const inner = createMemoryCredentialStore();
    const stuck: CredentialStore = {
      get: (deviceId) => inner.get(deviceId),
      set: (deviceId, digest) => inner.set(deviceId, digest),
      delete: async () => {
        throw new Error('the registry is read-only');
      },
    };
    const gate = testGate(stuck);
    const a = await gate.mintDevice();
    const { port, incoming } = await listen(gate);
    const peer = peerOf(await connect(port, { credential: a.credential }));
    const tunnel = await nextTunnel(incoming);

    await expect(gate.credentials.revoke(a.deviceId)).rejects.toThrow(/read-only/);
    await peer.closeCode;
    expect(tunnel.ended()).toEqual({ kind: 'clean', reason: 'revoked' });
    // The row is still in the store, and the device is refused anyway — by
    // the registry itself, not only by the listener asking `isRevoked`.
    expect(await gate.credentials.verify(a.credential)).toBeNull();
    expect(await connect(port, { credential: a.credential })).toEqual({ status: 401 });

    // AND AFTER A RESTART. The row left behind is a zero-byte tombstone, not
    // the digest, so a registry opened over the same store — with no memory of
    // the revocation — refuses the device too. Measured in review before this:
    // it admitted it.
    expect(await inner.get(a.deviceId)).toEqual(new Uint8Array(0));
    expect(await createDeviceCredentials(stuck).verify(a.credential)).toBeNull();
  });

  it('a tombstone that cannot be written does not stop the delete', async () => {
    const inner = createMemoryCredentialStore();
    const noTombstones: CredentialStore = {
      get: (deviceId) => inner.get(deviceId),
      set: async (deviceId, digest) => {
        if (digest.byteLength === 0) throw new Error('refuses empty rows');
        await inner.set(deviceId, digest);
      },
      delete: (deviceId) => inner.delete(deviceId),
    };
    const gate = testGate(noTombstones);
    const a = await gate.mintDevice();
    expect(await gate.credentials.revoke(a.deviceId)).toBe(true);
    expect(await inner.get(a.deviceId)).toBeUndefined();
    expect(await createDeviceCredentials(noTombstones).verify(a.credential)).toBeNull();
  });
});

describe('close() and an upgrade still being decided', () => {
  it('destroys a pending upgrade whose verifier never resolves', async () => {
    /*
     * An upgrade is no longer the HTTP server's request, so `server.close()`
     * waits on it like any open connection — and a registry that never
     * answers would hold a quit open forever. The test timeout is the bound.
     */
    const inner = createMemoryCredentialStore();
    let signalRead!: () => void;
    const read = new Promise<void>((resolve) => {
      signalRead = resolve;
    });
    const silent: CredentialStore = {
      get: () => {
        signalRead();
        return new Promise<Uint8Array | undefined>(() => undefined);
      },
      set: (deviceId, digest) => inner.set(deviceId, digest),
      delete: (deviceId) => inner.delete(deviceId),
    };
    const gate = testGate(silent);
    const a = await gate.mintDevice();
    const { listener, port, incoming } = await listen(gate);

    const outcome = connect(port, { credential: a.credential });
    await read;
    await listener.close();

    const settled = await outcome;
    expect('error' in settled, JSON.stringify(settled)).toBe(true);
    expect(listener.server.listening).toBe(false);
    expect(await incoming.next()).toEqual({ done: true, value: undefined });
  });
});

describe('the credential itself', () => {
  it('is 32 random bytes of secret under a 16-byte device id, base64url, and never the same twice', async () => {
    const gate = testGate();
    const a = await gate.mintDevice();
    const b = await gate.mintDevice();
    for (const minted of [a, b]) {
      expect(minted.credential).toMatch(/^[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/);
      const [deviceId, secret] = minted.credential.split('.') as [string, string];
      expect(deviceId).toBe(minted.deviceId);
      expect(Buffer.from(secret, 'base64url')).toHaveLength(32);
      expect(Buffer.from(deviceId, 'base64url')).toHaveLength(16);
    }
    expect(a.credential).not.toBe(b.credential);
    expect(a.credential.split('.')[1]).not.toBe(b.credential.split('.')[1]);
  });

  it('the store is handed a digest, never the credential', async () => {
    const written: [string, Uint8Array][] = [];
    const inner = createMemoryCredentialStore();
    const recording: CredentialStore = {
      get: (deviceId) => inner.get(deviceId),
      set: async (deviceId, digest) => {
        written.push([deviceId, new Uint8Array(digest)]);
        await inner.set(deviceId, digest);
      },
      delete: (deviceId) => inner.delete(deviceId),
    };
    const gate = testGate(recording);
    const a = await gate.mintDevice();

    expect(written).toHaveLength(1);
    const [deviceId, digest] = written[0]!;
    expect(deviceId).toBe(a.deviceId);
    expect(Buffer.from(digest)).toEqual(createHash('sha256').update(a.credential, 'utf8').digest());
    const [, secret] = a.credential.split('.') as [string, string];
    for (const encoding of ['utf8', 'latin1', 'hex', 'base64', 'base64url'] as const) {
      expect(Buffer.from(digest).toString(encoding)).not.toContain(secret);
    }
  });

  it('is minted only for a pairing that completed, and once per pairing', async () => {
    const credentials = createDeviceCredentials(createMemoryCredentialStore());
    const secret = new Uint8Array(32).fill(9);

    const unclaimed = openWindow({ secret, now: 0 });
    await expect(credentials.mint(unclaimed, 0)).rejects.toThrow(/completed/);

    const expired = openWindow({ secret, now: 0, windowMs: 10 });
    await expect(credentials.mint(expired, 10)).rejects.toThrow(/completed/);

    // Something that only SAYS it is a claimed window. Measured in review
    // before the brand: a literal like this minted a credential `verify` took.
    const literal = {
      state: () => 'claimed',
      claim: () => ({ ok: true, state: 'claimed' }),
      cancel: () => undefined,
      remaining: () => 0,
      expiresAt: 0,
      onClose: () => () => undefined,
    } as unknown as PairingWindow;
    await expect(credentials.mint(literal, 0)).rejects.toThrow(/against a pairing window/);
    const real = openWindow({ secret, now: 0 });
    expect(real.claim(secret, 0).ok).toBe(true);
    // Nor a copy of a real, claimed one.
    await expect(credentials.mint({ ...real }, 0)).rejects.toThrow(/against a pairing window/);

    const claimed = openWindow({ secret, now: 0 });
    expect(claimed.claim(secret, 0).ok).toBe(true);
    const minted = await credentials.mint(claimed, 0);
    expect(await credentials.verify(minted.credential)).toBe(minted.deviceId);
    await expect(credentials.mint(claimed, 0)).rejects.toThrow(/already/);
    // Not per registry: a second registry cannot spend the same pairing.
    await expect(createDeviceCredentials(createMemoryCredentialStore()).mint(claimed, 0)).rejects.toThrow(/already/);
  });

  it('is compared with timingSafeEqual over digests, and in no other way', () => {
    /*
     * Read from source, and honest about what that proves: that nobody
     * rewrote the comparison into `===`, `Buffer.equals` or `Buffer.compare`
     * — which pass every behavioural test above, because a correct answer
     * arrived in variable time is still a correct answer. Not that the
     * engine runs it in constant time.
     */
    const code = codeOf(readFileSync(resolve(process.cwd(), 'packages/tunnel/src/host/credential.ts'), 'utf8'));
    const start = code.indexOf('function digestsMatch(');
    expect(start, 'credential.ts no longer declares digestsMatch').toBeGreaterThanOrEqual(0);
    const body = code.slice(code.indexOf('{', start), code.indexOf('\n}', start));
    expect(body).toContain('timingSafeEqual(');
    expect(body, 'digestsMatch compares with an equality operator').not.toMatch(/[!=]==?/);

    // The one comparison is the one used: `timingSafeEqual` is called exactly
    // once in the file, inside `digestsMatch`, and `verify` calls that.
    expect(code.match(/\btimingSafeEqual\s*\(/g)).toHaveLength(1);
    const verify = code.slice(code.indexOf('async verify('), code.indexOf('isRevoked:'));
    expect(verify).toContain('digestsMatch(');
    expect(code, 'a second comparison was written beside it').not.toMatch(/\.equals\s*\(|Buffer\.compare\s*\(/);
  });
});

describe('the tunnel binding (#135, #158)', () => {
  it('cannot be written down without a gate on either arm, or with parts that are literals', () => {
    /*
     * A TYPE-LEVEL ASSERTION, which `npm run typecheck` runs: `tests/` is in
     * the root tsconfig, and a `@ts-expect-error` on a line that stops being an
     * error is itself an error. The runtime line only gives the test a body.
     */
    const { gate } = testGate();
    const material = asTlsMaterial('key', 'cert');

    // @ts-expect-error the loopback arm requires a gate: loopback is reachable through local forwarding.
    const loopbackNoGate: TunnelBinding = { kind: 'loopback', port: 0 };
    // @ts-expect-error the TLS arm requires a gate.
    const tlsNoGate: TunnelBinding = { kind: 'tls', host: '0.0.0.0', port: 0, tls: material };
    // @ts-expect-error the TLS arm cannot be written without material.
    const tlsNoMaterial: TunnelBinding = { kind: 'tls', host: '0.0.0.0', port: 0, gate };
    // @ts-expect-error TLS material is branded: a literal is not material.
    const literalMaterial: TunnelBinding = { kind: 'tls', host: '0.0.0.0', port: 0, gate, tls: { key: 'k', cert: 'c' } };
    // @ts-expect-error a ServerBinding arm is not a tunnel binding (#135).
    const serverArm: TunnelBinding = { kind: 'authenticated', host: '0.0.0.0', port: 0, gate, tls: material };
    const loopbackWithHost: TunnelBinding = {
      kind: 'loopback',
      port: 0,
      gate,
      // @ts-expect-error the loopback arm has no host field to put an address in.
      host: '0.0.0.0',
    };
    const literalCredentials: TunnelGate = {
      ...gate,
      // @ts-expect-error the credential registry is branded: a verifier that says yes cannot be written down.
      credentials: {
        mint: async () => ({ deviceId: 'd', credential: 'c' }),
        verify: async () => 'anyone',
        isRevoked: () => false,
        revoke: async () => true,
        watchRevocations: () => () => undefined,
      },
    };

    // @ts-expect-error a pairing window is branded: a literal that answers `claimed` is not one.
    const literalWindow: PairingWindow = {
      state: () => 'claimed',
      claim: () => ({ ok: true, state: 'claimed' }),
      cancel: () => undefined,
      remaining: () => 0,
      expiresAt: 0,
      onClose: () => () => undefined,
    };

    expect(
      [
        loopbackNoGate,
        tlsNoGate,
        tlsNoMaterial,
        literalMaterial,
        serverArm,
        loopbackWithHost,
        literalCredentials,
        literalWindow,
      ],
    ).toHaveLength(8);
  });

  it('the loopback arm binds 127.0.0.1, whatever else an object carries', async () => {
    // Every other test connects to 127.0.0.1, which a listener on 0.0.0.0
    // answers too — so the bind address is asserted, not inferred.
    const gate = testGate();
    const listener = await createTunnelListener({
      maxTunnels: 1,
      binding: { ...gate.binding(), host: '0.0.0.0' } as unknown as TunnelBinding,
    });
    open.push(listener);
    expect((listener.server.address() as AddressInfo).address).toBe('127.0.0.1');
  });

  it('refuses at runtime what a caller the compiler did not see might hand it', async () => {
    /*
     * THE MESSAGES ARE PINNED, NOT ONLY THE ERROR CLASSES. Most of these would
     * fail without the listener's own refusal anyway — Node throws a
     * RangeError for a bad port, and reading `.key` off missing material is a
     * TypeError — so a class-only assertion passes with the checks deleted.
     * Mutation testing said so. The message is what shows the refusal is this
     * file's, made before anything was bound.
     */
    const { gate } = testGate();
    const material = asTlsMaterial('key', 'cert');
    const noGate = /without a credential gate/;
    for (const [name, binding, error, message] of [
      ['no gate', { kind: 'loopback', port: 0 }, TypeError, noGate],
      ['a gate with no credentials', { kind: 'loopback', port: 0, gate: { ...gate, credentials: {} } }, TypeError, noGate],
      ['a gate with no pairing', { kind: 'loopback', port: 0, gate: { ...gate, pairing: {} } }, TypeError, noGate],
      ['a gate with no clock', { kind: 'loopback', port: 0, gate: { ...gate, now: undefined } }, TypeError, noGate],
      ['a server arm', { kind: 'authenticated', host: '0.0.0.0', port: 0, gate, tls: material }, TypeError, /unknown binding kind "authenticated"/],
      ['a port past 65535', { kind: 'loopback', port: 65_536, gate }, RangeError, /65536 is not a port/],
      ['a fractional port', { kind: 'loopback', port: 1.5, gate }, RangeError, /1\.5 is not a port/],
      ['a negative port', { kind: 'loopback', port: -1, gate }, RangeError, /-1 is not a port/],
      ['a TLS arm with no address', { kind: 'tls', host: ' ', port: 0, gate, tls: material }, RangeError, /needs an address/],
      ['a TLS arm with no material', { kind: 'tls', host: '127.0.0.1', port: 0, gate }, TypeError, /asTlsMaterial/],
    ] as const) {
      const attempt = createTunnelListener({ maxTunnels: 1, binding: binding as unknown as TunnelBinding });
      attempt.then((listener) => open.push(listener), () => undefined);
      await expect(attempt, name).rejects.toThrow(error);
      await expect(attempt, name).rejects.toThrow(message);
    }
  });
});

function opensslAvailable(): boolean {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** Throwaway material, as `tests/server-auth.test.ts` makes its own. */
function selfSigned(): { key: string; cert: string } {
  const dir = mkdtempSync(join(tmpdir(), 'chatterang-tunnel-tls-'));
  const keyPath = join(dir, 'key.pem');
  const certPath = join(dir, 'cert.pem');
  execFileSync(
    'openssl',
    ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyPath, '-out', certPath, '-days', '1', '-subj', '/CN=localhost'],
    { stdio: 'ignore' },
  );
  return { key: readFileSync(keyPath, 'utf8'), cert: readFileSync(certPath, 'utf8') };
}

describe.runIf(opensslAvailable())('the TLS arm', () => {
  it('serves wss with the material it was handed, behind the same gate', async () => {
    /*
     * Whether the phone checks the certificate's names or only its SPKI pin
     * is #180/#295's open question, so this client checks neither: what is
     * under test is that the TLS arm is TLS, and that it is gated.
     */
    const pem = selfSigned();
    const gate = testGate();
    const a = await gate.mintDevice();
    const listener = await createTunnelListener({
      maxTunnels: 2,
      binding: { kind: 'tls', host: '127.0.0.1', port: 0, tls: asTlsMaterial(pem.key, pem.cert), gate: gate.gate },
    });
    open.push(listener);
    const { port, address } = listener.server.address() as AddressInfo;
    expect(address).toBe('127.0.0.1');
    const incoming = listener.tunnels()[Symbol.asyncIterator]();

    /*
     * THE CERTIFICATE SERVED IS THE ONE HANDED OVER, compared by fingerprint.
     * `rejectUnauthorized: false` means the handshake would succeed with any
     * certificate at all — measured in review: a listener serving a freshly
     * made `CN=IMPOSTOR` passed this test before the comparison was added.
     */
    const expected = new X509Certificate(pem.cert).fingerprint256;
    const { WebSocket } = await import('ws');
    const attempt = (headers: Record<string, string>) =>
      new Promise<{ outcome: number | 'open'; fingerprint: string }>((resolveAttempt) => {
        const socket = new WebSocket(`wss://127.0.0.1:${String(port)}`, { headers, rejectUnauthorized: false });
        open.push({ close: () => socket.terminate() });
        socket.on('error', () => undefined);
        const served = (response: { socket: unknown }) =>
          (response.socket as TLSSocket).getPeerCertificate().fingerprint256;
        socket.once('unexpected-response', (request, response) => {
          resolveAttempt({ outcome: response.statusCode ?? 0, fingerprint: served(response) });
          request.destroy();
        });
        socket.once('upgrade', (response) => {
          const fingerprint = served(response);
          socket.once('open', () => resolveAttempt({ outcome: 'open', fingerprint }));
        });
      });

    expect(await attempt({})).toEqual({ outcome: 401, fingerprint: expected });
    expect(await attempt(credentialHeaders(a.credential))).toEqual({ outcome: 'open', fingerprint: expected });
    expect((await nextTunnel(incoming)).admission).toEqual({ kind: 'device', deviceId: a.deviceId });

    // And it is not also answering plaintext on the same port.
    expect(await connect(port, { credential: a.credential })).not.toHaveProperty('peer');
  });
});

describe.runIf(!opensslAvailable())('the TLS arm, where openssl is missing', () => {
  it('is not skipped quietly in CI', () => {
    // `describe.runIf` above skips without a word. Locally that is a skip in
    // the summary; in CI it would be the TLS arm going untested, so it fails.
    expect(process.env['CI'], 'openssl is not installed, so the TLS arm test above did not run').toBeFalsy();
  });
});

describe("the TLS arm, serving the tunnel's own identity (#179)", () => {
  it("serves a certificate issued from the tunnel key, so a peer sees that key's pin, behind the same gate", async () => {
    /*
     * The two halves meet here: `identity.ts` makes the key and a certificate,
     * and the TLS arm serves them as `TlsMaterial`. What a paired client holds
     * is the key's pin (#180), so that is what is compared, computed from the
     * DER the peer received rather than by `tunnelPinOf`. It needs no openssl,
     * so unlike the test above it runs everywhere.
     */
    const key = generateTunnelKey();
    const certificate = await issueTunnelCertificate(key, { validDays: 1 });
    const gate = testGate();
    const a = await gate.mintDevice();
    const listener = await createTunnelListener({
      maxTunnels: 2,
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
    const incoming = listener.tunnels()[Symbol.asyncIterator]();

    const { WebSocket } = await import('ws');
    const pinServed = (response: { socket: unknown }) =>
      createHash('sha256')
        .update(
          new X509Certificate((response.socket as TLSSocket).getPeerCertificate().raw).publicKey.export({
            type: 'spki',
            format: 'der',
          }),
        )
        .digest('base64');
    const attempt = (headers: Record<string, string>) =>
      new Promise<{ outcome: number | 'open'; pin: string }>((resolveAttempt) => {
        const socket = new WebSocket(`wss://127.0.0.1:${String(port)}`, { headers, rejectUnauthorized: false });
        open.push({ close: () => socket.terminate() });
        socket.on('error', () => undefined);
        socket.once('unexpected-response', (request, response) => {
          resolveAttempt({ outcome: response.statusCode ?? 0, pin: pinServed(response) });
          request.destroy();
        });
        socket.once('upgrade', (response) => {
          const pin = pinServed(response);
          socket.once('open', () => resolveAttempt({ outcome: 'open', pin }));
        });
      });

    expect(await attempt({})).toEqual({ outcome: 401, pin: key.pin.spkiSha256 });
    expect(await attempt(credentialHeaders(a.credential))).toEqual({ outcome: 'open', pin: key.pin.spkiSha256 });
    expect((await nextTunnel(incoming)).admission).toEqual({ kind: 'device', deviceId: a.deviceId });
  });
});

describe('the client and the credential', () => {
  it('refuses to send a credential over plaintext anywhere but 127.0.0.1', async () => {
    const gate = testGate();
    const a = await gate.mintDevice();
    for (const url of ['ws://192.0.2.1:9/', 'ws://localhost:9/', 'ws://[::1]:9/', 'not a url']) {
      await expect(createTunnelClient({ url, credential: a.credential }), url).rejects.toThrow(/wss/);
    }
  });
});
