// @vitest-environment node
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';
import type { WebSocket as RawSocket } from 'ws';

import { classifyFrame, createTunnelClient } from '@chatterang/tunnel/client';
import { createTunnelListener, type Tunnel } from '@chatterang/tunnel/host';
import { MAX_OPEN_TURNS, TunnelProtocolError } from '@chatterang/tunnel/stream';
import {
  TUNNEL_WIRE_VERSION,
  decodeFrame,
  encodeFrame,
  resolveAttach,
  type RelayedPrompt,
  type TunnelFrame,
} from '@chatterang/tunnel/wire';

import { credentialHeaders, testGate, type TestGate } from './support/tunnel-gate';

/**
 * RUNG 0 FOR #7's VOCABULARY: every new frame, over a real socket on loopback.
 *
 * The same rung as `tests/rung0.test.ts` (#156) — no TLS and no LAN, through
 * the credential gate every listener has — so a frame that misbehaves here is
 * the protocol's fault. The real
 * `createTunnelClient` plays the phone and the real `createTunnelListener`
 * the desktop's socket; what the desktop DOES with a frame (its wait list,
 * its prompt timeout, the results it holds) is the work broker's (#7) and does
 * not exist, so the test plays that part by hand, one frame at a time.
 *
 * DEVICE IDENTITY IS THE GATE'S. Every socket here presents a device
 * credential minted through the real gate (`tests/support/tunnel-gate.ts`), and
 * the device a tunnel belongs to is its `admission.deviceId` — read off the
 * credential, never out of a frame. Nothing in a frame names a device.
 *
 * Where a peer has to break a rule the real client will not let it break —
 * answer a prompt after it expired, attach twice — the peer is a raw `ws`
 * socket, for the reason `faultyHost` in `tests/rung0.test.ts` gives.
 *
 * Manners from `tests/rung0.test.ts`: ephemeral ports, everything closed in
 * `afterEach`, no fixed timeouts. `eventually` polls; the test timeout bounds it.
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
  credentialOf.clear();
});

/** The credential each listener's one minted device holds, by port. */
const credentialOf = new Map<number, string>();

const V = TUNNEL_WIRE_VERSION;
const turnFrame = (turn: string): TunnelFrame => ({ v: V, kind: 'turn', turn, body: { messages: [] } });
const content = (turn: string, sequence: number, delta: string): TunnelFrame => ({
  v: V,
  kind: 'chunk',
  turn,
  body: { type: 'content', sequence, delta },
});
const done = (turn: string, sequence: number, text: string): TunnelFrame => ({
  v: V,
  kind: 'chunk',
  turn,
  body: { type: 'done', sequence, finishReason: 'stop', message: { role: 'assistant', content: text } },
});
const waiting = (turn: string, position: number): TunnelFrame => ({ v: V, kind: 'waiting', turn, body: { position } });
const promptFrame = (turn: string, prompt: string, body: RelayedPrompt = { action: 'run bash' }): TunnelFrame => ({
  v: V,
  kind: 'prompt',
  turn,
  prompt,
  body,
});
const answerFrame = (turn: string, prompt: string, approved: boolean): TunnelFrame => ({
  v: V,
  kind: 'answer',
  turn,
  prompt,
  body: { approved },
});
const attach = (turn: string): TunnelFrame => ({ v: V, kind: 'attach', turn });
const ack = (turn: string): TunnelFrame => ({ v: V, kind: 'ack', turn });
const cancel = (turn: string): TunnelFrame => ({ v: V, kind: 'cancel', turn });
const refusal = (code: string, where: { turn?: string; prompt?: string }): TunnelFrame => ({
  v: V,
  kind: 'error',
  ...where,
  body: { code, message: `refused: ${code}` },
});

/** A frame reduced to what these tests compare: kind, turn, prompt, code. */
const summary = (frame: TunnelFrame): unknown[] => [
  frame.kind,
  'turn' in frame ? frame.turn : undefined,
  'prompt' in frame ? frame.prompt : undefined,
  frame.kind === 'error' ? frame.body.code : undefined,
];

/** One iterator per source, so two waits never race for one `wake`. */
function reader<T>(source: AsyncIterable<T>): () => Promise<T> {
  const iterator = source[Symbol.asyncIterator]();
  return async () => {
    const result = await iterator.next();
    if (result.done) throw new Error('the stream ended before the frame this test waited for');
    return result.value;
  };
}

async function eventually(check: () => boolean): Promise<void> {
  while (!check()) await new Promise((resolve) => setTimeout(resolve, 5));
}

async function listen(maxTunnels: number, greeting?: readonly TunnelFrame[]): Promise<{
  port: number;
  gate: TestGate;
  nextTunnel: () => Promise<{ tunnel: Tunnel; hears: () => Promise<TunnelFrame> }>;
}> {
  const gate = testGate();
  const { credential } = await gate.mintDevice();
  const listener = await createTunnelListener({
    maxTunnels,
    binding: gate.binding(),
    ...(greeting === undefined ? {} : { greeting }),
  });
  open.push(listener);
  const { port } = listener.server.address() as AddressInfo;
  credentialOf.set(port, credential);
  const next = reader(listener.tunnels());
  /** The next admitted tunnel, with a reader over what it receives. */
  const nextTunnel = async (): Promise<{ tunnel: Tunnel; hears: () => Promise<TunnelFrame> }> => {
    const tunnel = await next();
    return { tunnel, hears: reader(tunnel.receive()) };
  };
  return { port, gate, nextTunnel };
}

/** The device a tunnel's credential names: the gate's answer, never a frame's. */
const deviceOf = (tunnel: Tunnel): string => (tunnel.admission.kind === 'device' ? tunnel.admission.deviceId : '');

async function phone(port: number, credential = credentialOf.get(port)) {
  const client = await createTunnelClient({
    url: `ws://127.0.0.1:${port}`,
    ...(credential === undefined ? {} : { credential }),
  });
  open.push(client);
  return { client, hears: reader(client.receive()) };
}

/** A phone that sends whatever it is told to, in whatever state. */
async function rawPhone(port: number, credential = credentialOf.get(port)) {
  const { WebSocket } = await import('ws');
  const socket = new WebSocket(`ws://127.0.0.1:${port}`, {
    headers: credential === undefined ? {} : credentialHeaders(credential),
  });
  open.push({ close: () => socket.terminate() });
  const frames: TunnelFrame[] = [];
  socket.on('message', (data: Buffer) => frames.push(decodeFrame(new Uint8Array(data))));
  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve());
    socket.on('error', reject);
  });
  return { socket, frames, send: (frame: TunnelFrame) => socket.send(encodeFrame(frame)) };
}

describe('waiting', () => {
  it('a waiting turn is told its place, then streams, and the phone reads each step', async () => {
    const { port, nextTunnel } = await listen(1);
    const { client, hears } = await phone(port);
    const { tunnel, hears: desktopHears } = await nextTunnel();

    await client.send(turnFrame('t1'));
    expect(await desktopHears()).toEqual(turnFrame('t1'));

    await tunnel.send(waiting('t1', 2));
    await tunnel.send(waiting('t1', 1));
    await tunnel.send(content('t1', 0, 'the '));
    // A turn that is streaming is not waiting, and the desktop may not say so.
    await expect(tunnel.send(waiting('t1', 1))).rejects.toThrow(TunnelProtocolError);
    await tunnel.send(done('t1', 1, 'the answer'));

    const updates = [];
    for (let index = 0; index < 4; index += 1) updates.push(classifyFrame(await hears()));
    expect(updates).toEqual([
      { kind: 'waiting', turn: 't1', position: 2 },
      { kind: 'waiting', turn: 't1', position: 1 },
      { kind: 'streaming', turn: 't1' },
      { kind: 'completed', turn: 't1' },
    ]);
    expect(client.ended()).toBeNull();
  });

  it('a second turn on the same socket numbers its reply from 0, and is not a broken stream', async () => {
    /*
     * RED BEFORE THIS CHANGE: one sequence count per tunnel read t2's first
     * chunk as a repeat of t1's, and the phone's tunnel ended SEQUENCE_BROKEN.
     * One slot and a wait list mean a phone sends turn after turn on one
     * socket, so this is the ordinary case.
     */
    const { port, nextTunnel } = await listen(1);
    const { client, hears } = await phone(port);
    const { tunnel, hears: desktopHears } = await nextTunnel();

    for (const id of ['t1', 't2']) {
      await client.send(turnFrame(id));
      expect(await desktopHears()).toEqual(turnFrame(id));
      await tunnel.send(content(id, 0, 'the '));
      await tunnel.send(done(id, 1, 'the answer'));
      expect(classifyFrame(await hears())).toEqual({ kind: 'streaming', turn: id });
      expect(classifyFrame(await hears())).toEqual({ kind: 'completed', turn: id });
      await client.send(ack(id));
      expect(await desktopHears()).toEqual(ack(id));
    }
    expect(client.ended()).toBeNull();
    expect(tunnel.ended()).toBeNull();
  });
});

describe('prompt and answer (#170)', () => {
  it('the desktop’s prompt reaches the phone whole, and the phone’s answer reaches the desktop once', async () => {
    const { port, nextTunnel } = await listen(1);
    const { client, hears } = await phone(port);
    const { tunnel, hears: desktopHears } = await nextTunnel();
    const sheet: RelayedPrompt = {
      action: 'send tool output to Work MCP',
      title: 'Send tool output to Work MCP?',
      body: 'bash read 3 files from this app’s own data.',
      detail: ['bash · 120 chars', 'ls · 40 chars'],
      confirmLabel: 'Send this turn',
      cancelLabel: 'Don’t send',
    };

    await client.send(turnFrame('t1'));
    await desktopHears();
    await tunnel.send(promptFrame('t1', 'p1', sheet));

    expect(classifyFrame(await hears())).toEqual({ kind: 'prompt', turn: 't1', prompt: 'p1', body: sheet });
    await client.send(answerFrame('t1', 'p1', true));
    expect(await desktopHears()).toEqual(answerFrame('t1', 'p1', true));

    // The phone cannot answer twice, and the desktop cannot re-use the id.
    await expect(client.send(answerFrame('t1', 'p1', false))).rejects.toThrow(TunnelProtocolError);
    await expect(tunnel.send(promptFrame('t1', 'p1', sheet))).rejects.toThrow(TunnelProtocolError);

    await tunnel.send(done('t1', 0, 'sent'));
    expect(classifyFrame(await hears())).toEqual({ kind: 'completed', turn: 't1' });
  });

  it('an answer that crosses its prompt’s expiry is refused, never read, and the turn goes on', async () => {
    const { port, nextTunnel } = await listen(1);
    const peer = await rawPhone(port);
    const { tunnel, hears: desktopHears } = await nextTunnel();

    peer.send(turnFrame('t1'));
    expect(await desktopHears()).toEqual(turnFrame('t1'));
    await tunnel.send(promptFrame('t1', 'p1'));
    // The broker's timeout ran out — its constant, not the wire's — so the
    // call is refused and recorded as not sent.
    await tunnel.send(refusal('PROMPT_EXPIRED', { turn: 't1', prompt: 'p1' }));
    await eventually(() => peer.frames.length === 2);
    expect(classifyFrame(peer.frames[1]!)).toMatchObject({
      kind: 'refused',
      refusal: 'prompt-expired',
      endsTurn: false,
      turn: 't1',
      prompt: 'p1',
    });

    // The phone's yes was already on the wire.
    peer.send(answerFrame('t1', 'p1', true));
    peer.send(cancel('t1'));
    // The answer never came out of receive(); the frame after it did, so the
    // tunnel stayed open through the refusal.
    expect(await desktopHears()).toEqual(cancel('t1'));
    await eventually(() => peer.frames.length === 3);
    expect(summary(peer.frames[2]!)).toEqual(['error', 't1', 'p1', 'FRAME_UNEXPECTED']);
    expect(tunnel.ended()).toBeNull();
    await tunnel.send(done('t1', 0, 'finished without that call'));
  });

  it('the real phone refuses to send an answer to a prompt that expired', async () => {
    const { port, nextTunnel } = await listen(1);
    const { client, hears } = await phone(port);
    const { tunnel, hears: desktopHears } = await nextTunnel();

    await client.send(turnFrame('t1'));
    await desktopHears();
    await tunnel.send(promptFrame('t1', 'p1'));
    await tunnel.send(refusal('PROMPT_EXPIRED', { turn: 't1', prompt: 'p1' }));
    await hears();
    await hears();
    await expect(client.send(answerFrame('t1', 'p1', true))).rejects.toThrow(TunnelProtocolError);
  });

  it('the real phone refuses to answer a prompt after it cancelled the turn, and the desktop may only finish it', async () => {
    const { port, nextTunnel } = await listen(1);
    const { client, hears } = await phone(port);
    const { tunnel, hears: desktopHears } = await nextTunnel();

    await client.send(turnFrame('t1'));
    await desktopHears();
    await tunnel.send(promptFrame('t1', 'p1'));
    expect(classifyFrame(await hears())).toMatchObject({ kind: 'prompt', prompt: 'p1' });

    await client.send(cancel('t1'));
    // #170: a prompt whose turn is cancelled is refused, and never sent later
    // without a fresh answer — so there is no answer to send.
    await expect(client.send(answerFrame('t1', 'p1', true))).rejects.toThrow(TunnelProtocolError);
    expect(await desktopHears()).toEqual(cancel('t1'));

    await expect(tunnel.send(promptFrame('t1', 'p2'))).rejects.toThrow(TunnelProtocolError);
    await expect(tunnel.send(waiting('t1', 1))).rejects.toThrow(TunnelProtocolError);
    await tunnel.send(done('t1', 0, 'stopped'));
    expect(classifyFrame(await hears())).toEqual({ kind: 'completed', turn: 't1' });
    expect(client.ended()).toBeNull();
  });

  it('an answer a raw phone sends after its own cancel is never read, and is answered FRAME_UNEXPECTED', async () => {
    const { port, nextTunnel } = await listen(1);
    const peer = await rawPhone(port);
    const { tunnel, hears: desktopHears } = await nextTunnel();

    peer.send(turnFrame('t1'));
    await desktopHears();
    await tunnel.send(promptFrame('t1', 'p1'));
    await eventually(() => peer.frames.length === 1);

    peer.send(cancel('t1'));
    peer.send(answerFrame('t1', 'p1', true));
    peer.send(ack('t1'));
    // The cancel is read; the yes behind it never comes out of receive().
    expect(await desktopHears()).toEqual(cancel('t1'));
    await eventually(() => peer.frames.length === 3);
    expect(peer.frames.slice(1).map(summary)).toEqual([
      ['error', 't1', 'p1', 'FRAME_UNEXPECTED'],
      ['error', 't1', undefined, 'FRAME_UNEXPECTED'],
    ]);
    expect(tunnel.ended()).toBeNull();
  });
});

describe('refusals', () => {
  it('each refusal reaches the phone as its own kind, and ends the turn at both ends', async () => {
    const { port, nextTunnel } = await listen(1);
    const { client, hears } = await phone(port);
    const { tunnel, hears: desktopHears } = await nextTunnel();
    const codes = ['WAIT_LIST_FULL', 'DESKTOP_QUITTING', 'HOST_SUSPENDED', 'HOST_DOES_NOT_RUN_TURNS', 'FROM_A_NEWER_BUILD'];

    for (const code of codes) {
      await client.send(turnFrame(code));
      expect(await desktopHears()).toEqual(turnFrame(code));
      await tunnel.send(refusal(code, { turn: code }));
    }
    const read = [];
    for (const code of codes) {
      const update = classifyFrame(await hears());
      expect(update, code).toMatchObject({ kind: 'refused', turn: code, code });
      read.push(update.kind === 'refused' ? [update.refusal, update.endsTurn] : update.kind);
    }
    expect(read).toEqual([
      ['busy', true],
      ['quitting', true],
      ['suspended', true],
      ['refused', true],
      ['unrecognised', true],
    ]);

    // Over at both ends: the desktop cannot stream a refused turn, and the
    // phone cannot cancel one — including the one whose code it did not know.
    for (const code of codes) {
      await expect(tunnel.send(content(code, 0, 'too late')), code).rejects.toThrow(TunnelProtocolError);
      await expect(client.send(cancel(code)), code).rejects.toThrow(TunnelProtocolError);
    }
    expect(client.ended()).toBeNull();
  });

  it('a desktop that quits says so for the whole connection, then says bye', async () => {
    const { port, nextTunnel } = await listen(1);
    const { client, hears } = await phone(port);
    const { tunnel, hears: desktopHears } = await nextTunnel();

    await client.send(turnFrame('t1'));
    await desktopHears();
    await tunnel.send(content('t1', 0, 'the '));
    await tunnel.send(refusal('DESKTOP_QUITTING', {}));
    await tunnel.close('the desktop is quitting');

    expect(classifyFrame(await hears())).toEqual({ kind: 'streaming', turn: 't1' });
    expect(classifyFrame(await hears())).toEqual({
      kind: 'refused',
      refusal: 'quitting',
      endsTurn: true,
      code: 'DESKTOP_QUITTING',
      message: 'refused: DESKTOP_QUITTING',
    });
    await client.closed;
    expect(client.ended()).toEqual({ kind: 'clean', reason: 'the desktop is quitting' });
    // The refusal named no turn and ended the one the desktop was running.
    await expect(client.send(cancel('t1'))).rejects.toThrow(TunnelProtocolError);
  });
});

describe('one terminal per turn', () => {
  /** A desktop that writes whatever it is told to, for a phone that is the real client. */
  async function rawDesktop() {
    const server = createServer();
    const { WebSocketServer } = await import('ws');
    const sockets = new WebSocketServer({ server });
    const heard: TunnelFrame[] = [];
    const connected = new Promise<RawSocket>((resolve) => {
      sockets.on('connection', (socket) => {
        socket.on('message', (data: Buffer) => heard.push(decodeFrame(new Uint8Array(data))));
        resolve(socket);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    open.push({
      close: async () => {
        sockets.clients.forEach((client) => client.terminate());
        server.closeAllConnections();
        await new Promise<void>((resolve) => sockets.close(() => resolve()));
        await new Promise<void>((resolve) => server.close(() => resolve()));
      },
    });
    const { port } = server.address() as AddressInfo;
    const { client, hears } = await phone(port);
    return { client, hears, desktop: await connected, heard };
  }

  it('a refusal after a turn’s terminal never reaches the phone’s app, and is not answered', async () => {
    const { client, hears, desktop, heard } = await rawDesktop();
    await client.send(turnFrame('t1'));
    await eventually(() => heard.length === 1);

    desktop.send(encodeFrame(done('t1', 0, 'the answer')));
    desktop.send(encodeFrame(refusal('DESKTOP_QUITTING', { turn: 't1' })));
    desktop.send(encodeFrame(refusal('FROM_A_NEWER_BUILD', { turn: 't1' })));
    desktop.send(encodeFrame({ v: V, kind: 'ping' }));

    expect(classifyFrame(await hears())).toEqual({ kind: 'completed', turn: 't1' });
    // The next thing the app reads is the ping: neither refusal got through.
    expect(await hears()).toEqual({ v: V, kind: 'ping' });
    // And the phone said nothing about them: the next frame the desktop hears is the ack.
    await client.send(ack('t1'));
    await eventually(() => heard.length === 2);
    expect(heard.map(summary)).toEqual([
      ['turn', 't1', undefined, undefined],
      ['ack', 't1', undefined, undefined],
    ]);
    expect(client.ended()).toBeNull();
  });

  it('the desktop drops a refusal of a turn it has no record of, or one already over, and says nothing', async () => {
    const { port, nextTunnel } = await listen(1);
    const peer = await rawPhone(port);
    const { tunnel, hears: desktopHears } = await nextTunnel();

    peer.send(refusal('DESKTOP_QUITTING', { turn: 'never' }));
    // A stream nobody asked for, so the desktop is its asker, then refused twice.
    peer.send(done('unasked', 0, 'x'));
    peer.send(refusal('FROM_A_NEWER_BUILD', { turn: 'unasked' }));
    peer.send(turnFrame('marker'));

    expect(await desktopHears()).toEqual(done('unasked', 0, 'x'));
    expect(await desktopHears()).toEqual(turnFrame('marker'));
    await tunnel.send(refusal('WAIT_LIST_FULL', { turn: 'marker' }));
    await eventually(() => peer.frames.length === 1);
    expect(peer.frames.map(summary)).toEqual([['error', 'marker', undefined, 'WAIT_LIST_FULL']]);
    expect(tunnel.ended()).toBeNull();
  });

  it('a refusal of every turn that crosses a turn on the wire leaves both ends agreeing it never ran', async () => {
    const { port, nextTunnel } = await listen(1);
    const { client, hears } = await phone(port);
    const { tunnel, hears: desktopHears } = await nextTunnel();

    /*
     * CROSSED ON PURPOSE. Neither send yields to the event loop, so neither end
     * has read the other's frame when it writes its own: the desktop refuses
     * every turn before it reads t1, and the phone asks for t1 before it reads
     * that refusal. Uncrossed, the phone's own gate would refuse to send t1.
     */
    await tunnel.send(refusal('HOST_SUSPENDED', {}));
    await client.send(turnFrame('t1'));

    expect(classifyFrame(await hears())).toEqual({
      kind: 'refused',
      refusal: 'suspended',
      endsTurn: true,
      code: 'HOST_SUSPENDED',
      message: 'refused: HOST_SUSPENDED',
    });
    // The desktop never read t1, and answered it HOST_SUSPENDED; the phone
    // already had t1's terminal, so the next thing it reads is the pong.
    await client.send({ v: V, kind: 'ping' });
    expect(await desktopHears()).toEqual({ v: V, kind: 'ping' });
    await tunnel.send({ v: V, kind: 'pong' });
    expect(await hears()).toEqual({ v: V, kind: 'pong' });

    // Neither end can run it, or start anything else on this tunnel.
    await expect(tunnel.send(content('t1', 0, 'resumed'))).rejects.toThrow(TunnelProtocolError);
    await expect(tunnel.send(content('t9', 0, 'unasked'))).rejects.toThrow(TunnelProtocolError);
    await expect(client.send(turnFrame('t2'))).rejects.toThrow(TunnelProtocolError);
    expect(client.ended()).toBeNull();
    expect(tunnel.ended()).toBeNull();
  });
});

describe('collecting a held result after the socket dropped (#7 ruling 4)', () => {
  it('a reconnecting phone attaches, is sent the held terminal, and acknowledges it', async () => {
    const { port, nextTunnel } = await listen(2);

    // First socket: the phone asks, the desktop starts, the socket drops.
    const cut = await rawPhone(port);
    const first = await nextTunnel();
    cut.send(turnFrame('t-held'));
    expect(await first.hears()).toEqual(turnFrame('t-held'));
    await first.tunnel.send(content('t-held', 0, 'the '));
    await eventually(() => cut.frames.length === 1);
    cut.socket.terminate();
    await first.tunnel.closed;
    expect(first.tunnel.ended()).toMatchObject({ kind: 'abnormal', code: 'PEER_GONE' });

    // The desktop finished the turn anyway, and holds its terminal.
    const held = [{ device: deviceOf(first.tunnel), turn: 't-held', terminal: done('t-held', 1, 'the answer') }];

    // Second socket, same phone: the same credential, so the same device.
    const { client, hears } = await phone(port);
    const second = await nextTunnel();
    expect(deviceOf(second.tunnel)).not.toBe('');
    expect(deviceOf(second.tunnel)).toBe(deviceOf(first.tunnel));
    await client.send(attach('t-held'));
    expect(await second.hears()).toEqual(attach('t-held'));

    const found = resolveAttach(held, deviceOf(second.tunnel), 't-held');
    if (!found.ok) throw new Error('the phone that asked for the turn was refused its own result');
    await second.tunnel.send(found.held.terminal);

    // The held terminal carries the ORIGINAL stream's number, 1, and the
    // phone's count resumed there: not a gap, not SEQUENCE_BROKEN.
    expect(classifyFrame(await hears())).toEqual({ kind: 'completed', turn: 't-held' });
    expect(client.ended()).toBeNull();

    await client.send(ack('t-held'));
    expect(await second.hears()).toEqual(ack('t-held'));
    // And the same turn cannot be collected twice on this socket.
    await expect(client.send(attach('t-held'))).rejects.toThrow(TunnelProtocolError);
  });

  it('the same held terminal without an attach is a gap — the paired control', async () => {
    const { port, nextTunnel } = await listen(1);
    const { client, hears } = await phone(port);
    const { tunnel } = await nextTunnel();

    await tunnel.send(done('t-held', 1, 'the answer'));
    await expect(hears()).rejects.toThrow(/stream ended/);
    await client.closed;
    expect(client.ended()).toMatchObject({ kind: 'abnormal', code: 'SEQUENCE_BROKEN' });
  });

  it('another device’s attach gets RESULT_UNKNOWN, the same as a turn nothing holds', async () => {
    const { port, gate, nextTunnel } = await listen(1);
    const phoneA = await gate.mintDevice();
    const held = [{ device: phoneA.deviceId, turn: 't-held', terminal: done('t-held', 1, 'the answer') }];

    // The phone that connects is a different paired device.
    const { client, hears } = await phone(port);
    const { tunnel, hears: desktopHears } = await nextTunnel();
    const device = deviceOf(tunnel);
    expect(device).not.toBe('');
    expect(device).not.toBe(phoneA.deviceId);

    for (const turn of ['t-held', 't-never']) {
      await client.send(attach(turn));
      expect(await desktopHears()).toEqual(attach(turn));
      const found = resolveAttach(held, device, turn);
      if (found.ok) throw new Error(`${device} was handed a result held for ${found.held.device}`);
      await tunnel.send(refusal(found.code, { turn }));
    }

    const [other, never] = [classifyFrame(await hears()), classifyFrame(await hears())];
    const shape = { kind: 'refused', refusal: 'result-unknown', endsTurn: true, code: 'RESULT_UNKNOWN' };
    expect(other).toEqual({ ...shape, turn: 't-held', message: 'refused: RESULT_UNKNOWN' });
    expect(never).toEqual({ ...shape, turn: 't-never', message: 'refused: RESULT_UNKNOWN' });
    // A refused attach delivered nothing, so there is nothing to acknowledge.
    await expect(client.send(ack('t-held'))).rejects.toThrow(TunnelProtocolError);
    // And the result is still held for the device it belongs to.
    expect(resolveAttach(held, phoneA.deviceId, 't-held')).toMatchObject({ ok: true });
  });
});

describe('a frame outside its turn’s state', () => {
  it('a greeting is held to its turn’s state like every other send', async () => {
    /*
     * The greeting goes out before anything is received, and it goes through
     * the same gate as `send`: a turn a greeting ended is over at this end too.
     * A greeting written straight to the socket would leave this end's ledger
     * blind to it, and the chunk below would go out after the terminal.
     */
    const { port, nextTunnel } = await listen(1, [done('g', 0, 'hello')]);
    const { client, hears } = await phone(port);
    const { tunnel } = await nextTunnel();

    expect(classifyFrame(await hears())).toEqual({ kind: 'completed', turn: 'g' });
    await expect(tunnel.send(content('g', 1, 'more'))).rejects.toThrow(TunnelProtocolError);
    // The control: a different turn still streams.
    await tunnel.send(content('h', 0, 'fine'));
    expect(classifyFrame(await hears())).toEqual({ kind: 'streaming', turn: 'h' });
    expect(client.ended()).toBeNull();
  });

  it('is answered FRAME_UNEXPECTED by the desktop and never read, and the tunnel stays open', async () => {
    const { port, nextTunnel } = await listen(1);
    const peer = await rawPhone(port);
    const { tunnel, hears: desktopHears } = await nextTunnel();

    peer.send(turnFrame('t1'));
    peer.send(waiting('t1', 1)); // a phone saying its own turn is waiting
    peer.send(answerFrame('t1', 'p-never', true)); // an answer nobody asked for
    peer.send(ack('t1')); // an ack before anything was delivered
    peer.send(attach('a1'));
    peer.send(attach('a1')); // a second attach on the same socket
    peer.send(promptFrame('t1', 'p1')); // a phone asking the desktop a question about its own turn
    peer.send(cancel('t1'));

    expect(await desktopHears()).toEqual(turnFrame('t1'));
    expect(await desktopHears()).toEqual(attach('a1'));
    expect(await desktopHears()).toEqual(cancel('t1'));
    await eventually(() => peer.frames.length === 5);
    expect(peer.frames.map(summary)).toEqual([
      ['error', 't1', undefined, 'FRAME_UNEXPECTED'],
      ['error', 't1', 'p-never', 'FRAME_UNEXPECTED'],
      ['error', 't1', undefined, 'FRAME_UNEXPECTED'],
      ['error', 'a1', undefined, 'FRAME_UNEXPECTED'],
      ['error', 't1', 'p1', 'FRAME_UNEXPECTED'],
    ]);
    expect(tunnel.ended()).toBeNull();
  });

  it(`a phone that opens more than ${MAX_OPEN_TURNS} turns has the extra one refused and not recorded, and the tunnel stays open`, async () => {
    const { port, nextTunnel } = await listen(1);
    const peer = await rawPhone(port);
    const { tunnel, hears: desktopHears } = await nextTunnel();
    const over = `t${String(MAX_OPEN_TURNS)}`;

    for (let index = 0; index <= MAX_OPEN_TURNS; index += 1) peer.send(turnFrame(`t${String(index)}`));
    peer.send({ v: V, kind: 'ping' });
    for (let index = 0; index < MAX_OPEN_TURNS; index += 1) {
      expect(await desktopHears()).toEqual(turnFrame(`t${String(index)}`));
    }
    // The one past the bound was never read: the next frame is the ping.
    expect(await desktopHears()).toEqual({ v: V, kind: 'ping' });
    await eventually(() => peer.frames.length === 1);
    expect(summary(peer.frames[0]!)).toEqual(['error', over, undefined, 'FRAME_UNEXPECTED']);

    // One turn ends, and the refused id — never recorded — is taken.
    await tunnel.send(refusal('WAIT_LIST_FULL', { turn: 't0' }));
    peer.send(turnFrame(over));
    expect(await desktopHears()).toEqual(turnFrame(over));
    expect(tunnel.ended()).toBeNull();
  });

  it('a prompt with no turn id is not a frame at all: FRAME_INVALID, and nothing is read', async () => {
    const { port, nextTunnel } = await listen(1);
    const peer = await rawPhone(port);
    const { tunnel, hears: desktopHears } = await nextTunnel();

    peer.socket.send(
      new TextEncoder().encode(JSON.stringify({ v: V, kind: 'prompt', prompt: 'p1', body: { action: 'run bash' } })),
    );
    await tunnel.closed;
    expect(tunnel.ended()).toMatchObject({ kind: 'abnormal', code: 'FRAME_INVALID', message: expect.stringMatching(/turn id/) });
    await expect(desktopHears()).rejects.toThrow(/stream ended/);
  });

  it('is dropped by the phone too, which says so to the desktop', async () => {
    /*
     * The real host cannot send a prompt for a turn nobody asked for — its
     * gate throws — so the desktop here is a raw server writing frames by
     * hand, as `faultyHost` in `tests/rung0.test.ts` does.
     */
    const server = createServer();
    const { WebSocketServer } = await import('ws');
    const sockets = new WebSocketServer({ server });
    const heard: TunnelFrame[] = [];
    const connected = new Promise<RawSocket>((resolve) => {
      sockets.on('connection', (socket) => {
        socket.on('message', (data: Buffer) => heard.push(decodeFrame(new Uint8Array(data))));
        resolve(socket);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    open.push({
      close: async () => {
        sockets.clients.forEach((client) => client.terminate());
        server.closeAllConnections();
        await new Promise<void>((resolve) => sockets.close(() => resolve()));
        await new Promise<void>((resolve) => server.close(() => resolve()));
      },
    });
    const { port } = server.address() as AddressInfo;

    const { client, hears } = await phone(port);
    const desktop = await connected;
    desktop.send(encodeFrame(promptFrame('t-unasked', 'p1')));
    desktop.send(encodeFrame(waiting('t-unasked', 1)));
    // A stream nobody asked for is still carried (rung 0's greeting shape),
    // which gives this test a frame to wait for after the two refusals.
    desktop.send(encodeFrame(done('t-stream', 0, 'x')));

    expect(classifyFrame(await hears())).toEqual({ kind: 'completed', turn: 't-stream' });
    await eventually(() => heard.length === 2);
    expect(heard.map(summary)).toEqual([
      ['error', 't-unasked', 'p1', 'FRAME_UNEXPECTED'],
      ['error', 't-unasked', undefined, 'FRAME_UNEXPECTED'],
    ]);
    expect(client.ended()).toBeNull();
  });
});
