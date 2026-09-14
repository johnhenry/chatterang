// @vitest-environment node
import { request } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';
import type { WebSocket as RawSocket } from 'ws';

import { createTunnelClient } from '@chatterang/tunnel/client';
import {
  createTunnelListener,
  type Tunnel,
  type TunnelListenerOptions,
} from '@chatterang/tunnel/host';
import {
  TUNNEL_CAP_CLOSE_CODE,
  TUNNEL_CREDENTIAL_HEADER,
  TUNNEL_WIRE_VERSION,
  decodeFrame,
  encodeFrame,
  type TunnelFrame,
} from '@chatterang/tunnel/wire';

import { credentialHeaders, testGate } from './support/tunnel-gate';

/**
 * ONE LISTENER, MANY TUNNELS (#158).
 *
 * `createTunnelHost` was one tunnel's lifetime under a listener's name: one
 * inbox, one sequence guard and one `peer` shared by every connection. With two
 * peers, sends went to whichever connected last, both peers' frames interleaved
 * into one stream, and after the first peer left a late socket opened onto a
 * tunnel that had already ended. These tests hold the split to its word.
 *
 * Peers are raw `ws` sockets wherever a test needs bytes the real client hides
 * — a close code, or the absence of a greeting — for the reason
 * `tests/rung0.test.ts` gives for its own raw peer.
 *
 * Manners from `tests/rung0.test.ts`: ephemeral ports, everything closed in
 * `afterEach`, and no deadlines. `eventually` polls, and the test timeout is
 * the only bound on it.
 *
 * Every peer here presents a device credential minted through the real gate
 * (#135), so what these tests measure is the listener's lifecycle and not its
 * admission — `tests/tunnel-admission.test.ts` owns that.
 */

const open: { close(): unknown }[] = [];
afterEach(async () => {
  // Reverse, so peers go before the listener they are attached to.
  for (const closeable of open.reverse()) {
    try {
      await closeable.close();
    } catch {
      // Teardown of something the test already tore down.
    }
  }
  open.length = 0;
});

const HELLO: TunnelFrame = {
  v: TUNNEL_WIRE_VERSION,
  kind: 'hello',
  body: { protocol: TUNNEL_WIRE_VERSION },
};

const BYE: TunnelFrame = { v: TUNNEL_WIRE_VERSION, kind: 'bye' };

const chunk = (sequence: number, delta: string): TunnelFrame => ({
  v: TUNNEL_WIRE_VERSION,
  kind: 'chunk',
  turn: 't1',
  body: { type: 'content', sequence, delta },
});

const deltaOf = (frame: TunnelFrame): unknown =>
  'body' in frame ? (frame.body as Record<string, unknown> | undefined)?.['delta'] : undefined;

async function listen(options: Omit<TunnelListenerOptions, 'binding'>) {
  const gate = testGate();
  const { credential } = await gate.mintDevice();
  const listener = await createTunnelListener({ ...options, binding: gate.binding() });
  open.push(listener);
  const { port } = listener.server.address() as AddressInfo;
  return { listener, port, credential, incoming: listener.tunnels()[Symbol.asyncIterator]() };
}

async function nextTunnel(incoming: AsyncIterator<Tunnel>): Promise<Tunnel> {
  const result = await incoming.next();
  if (result.done) throw new Error('the listener stopped handing out tunnels');
  return result.value;
}

interface Peer {
  readonly socket: RawSocket;
  /** Every frame this peer has received, decoded, in arrival order. */
  readonly frames: TunnelFrame[];
  /** The close code this peer's socket closed with. */
  readonly closeCode: Promise<number>;
}

async function rawPeer(port: number, credential: string): Promise<Peer> {
  const { WebSocket } = await import('ws');
  const socket = new WebSocket(`ws://127.0.0.1:${port}`, { headers: credentialHeaders(credential) });
  open.push({ close: () => socket.terminate() });
  const frames: TunnelFrame[] = [];
  socket.on('message', (data: Buffer) => frames.push(decodeFrame(new Uint8Array(data))));
  const closeCode = new Promise<number>((resolve) => {
    socket.once('close', (code: number) => resolve(code));
  });
  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve());
    socket.on('error', reject);
  });
  return { socket, frames, closeCode };
}

async function eventually(check: () => boolean | Promise<boolean>): Promise<void> {
  while (!(await check())) await new Promise((resolve) => setTimeout(resolve, 5));
}

const connectionsOf = (server: Server): Promise<number> =>
  new Promise((resolve, reject) => {
    server.getConnections((error, count) => (error ? reject(error) : resolve(count)));
  });

async function drain(source: AsyncIterable<TunnelFrame>): Promise<TunnelFrame[]> {
  const frames: TunnelFrame[] = [];
  for await (const frame of source) frames.push(frame);
  return frames;
}

describe('one listener, many tunnels', () => {
  it('two tunnels do not share frames', async () => {
    const { port, incoming, credential } = await listen({ maxTunnels: 2 });
    const a = await rawPeer(port, credential);
    const tunnelA = await nextTunnel(incoming);
    const b = await rawPeer(port, credential);
    const tunnelB = await nextTunnel(incoming);

    // Each send reaches its own peer. The old host sent to whichever peer
    // connected LAST, so both of these would have landed on `b`.
    await tunnelA.send(chunk(0, 'to a'));
    await tunnelB.send(chunk(0, 'to b'));
    await eventually(() => a.frames.length + b.frames.length === 2);
    expect(a.frames.map(deltaOf)).toEqual(['to a']);
    expect(b.frames.map(deltaOf)).toEqual(['to b']);

    // Interleaved, and each peer numbering from 0: one shared inbox would mix
    // the streams, and one shared sequence guard would call the second `0` a
    // gap.
    a.socket.send(encodeFrame(chunk(0, 'a0')));
    b.socket.send(encodeFrame(chunk(0, 'b0')));
    a.socket.send(encodeFrame(chunk(1, 'a1')));
    b.socket.send(encodeFrame(chunk(1, 'b1')));
    a.socket.send(encodeFrame(BYE));
    b.socket.send(encodeFrame(BYE));
    // Both byes read, so everything each peer sent before its bye is in —
    // a socket delivers in order even though two sockets need not.
    await Promise.all([tunnelA.closed, tunnelB.closed]);

    expect((await drain(tunnelA.receive())).map(deltaOf)).toEqual(['a0', 'a1']);
    expect((await drain(tunnelB.receive())).map(deltaOf)).toEqual(['b0', 'b1']);
    expect(tunnelA.ended()).toEqual({ kind: 'clean' });
    expect(tunnelB.ended()).toEqual({ kind: 'clean' });
  });

  it('the cap is enforced at accept time, before any greeting', async () => {
    const { listener, port, incoming, credential } = await listen({ maxTunnels: 2, greeting: [HELLO] });
    const a = await rawPeer(port, credential);
    const tunnelA = await nextTunnel(incoming);
    const b = await rawPeer(port, credential);
    const tunnelB = await nextTunnel(incoming);

    const refused = await rawPeer(port, credential);
    expect(await refused.closeCode).toBe(TUNNEL_CAP_CLOSE_CODE);
    /*
     * WAIT FOR THE SERVER'S SIDE of the refusal, not only the client's. The
     * client's close event and the server's handling of that socket are not
     * ordered, so assertions about the admitted tunnels read before the server
     * has finished with the refused one would pass for the wrong reason.
     */
    await eventually(async () => (await connectionsOf(listener.server)) === 2);

    // Zero frames: refused before the greeting, not after it.
    expect(refused.frames).toEqual([]);
    // And the refusal disturbed nobody it did not refuse.
    expect(tunnelA.ended()).toBeNull();
    expect(tunnelB.ended()).toBeNull();
    // The admitted peers did get the greeting, so the empty list above is the
    // refusal and not a listener that greets nobody.
    await eventually(() => a.frames.length === 1 && b.frames.length === 1);
    expect(a.frames).toEqual([HELLO]);

    // A refused socket frees no slot: the next one is refused too.
    const fourth = await rawPeer(port, credential);
    expect(await fourth.closeCode).toBe(TUNNEL_CAP_CLOSE_CODE);
  });

  it('a refused client hears TUNNEL_FULL, not PEER_GONE', async () => {
    /*
     * #169 asks for a refusal the client can render. Classified as PEER_GONE,
     * a full listener is indistinguishable from a cable pulled mid-stream.
     */
    const { port, incoming, credential } = await listen({ maxTunnels: 1 });
    await rawPeer(port, credential);
    await nextTunnel(incoming);

    const client = await createTunnelClient({ url: `ws://127.0.0.1:${port}`, credential });
    open.push(client);
    await client.closed;
    expect(client.ended()).toMatchObject({ kind: 'abnormal', code: 'TUNNEL_FULL' });
  });

  it('a connection after one ends is a new tunnel', async () => {
    // Capped at ONE, so the second peer is admitted only if the first peer's
    // slot really came back.
    const { port, incoming, credential } = await listen({ maxTunnels: 1, greeting: [HELLO] });
    const a = await rawPeer(port, credential);
    const tunnelA = await nextTunnel(incoming);

    a.socket.terminate();
    await tunnelA.closed;
    expect(tunnelA.ended()).toMatchObject({ kind: 'abnormal', code: 'PEER_GONE' });

    const b = await rawPeer(port, credential);
    const tunnelB = await Promise.race([
      nextTunnel(incoming),
      b.closeCode.then((code) => {
        throw new Error(`the second peer was refused with ${String(code)}`);
      }),
    ]);
    expect(tunnelB).not.toBe(tunnelA);
    expect(tunnelB.ended()).toBeNull();
    await eventually(() => b.frames.length === 1);
    expect(b.frames).toEqual([HELLO]);
  });

  it('closing one tunnel leaves the others and the listener open', async () => {
    // The primitive #135's revocation needs: one device's socket closed,
    // nobody else's.
    const { listener, port, incoming, credential } = await listen({ maxTunnels: 2 });
    const a = await rawPeer(port, credential);
    const tunnelA = await nextTunnel(incoming);
    const b = await rawPeer(port, credential);
    const tunnelB = await nextTunnel(incoming);

    await tunnelA.close('revoked');
    await a.closeCode;
    expect(a.frames).toEqual([{ v: TUNNEL_WIRE_VERSION, kind: 'bye', body: { reason: 'revoked' } }]);
    expect(tunnelA.ended()).toEqual({ kind: 'clean', reason: 'revoked' });

    // The other tunnel is untouched and still carries frames.
    expect(tunnelB.ended()).toBeNull();
    b.socket.send(encodeFrame(chunk(0, 'still here')));
    const next = await tunnelB.receive()[Symbol.asyncIterator]().next();
    expect(next.done ? undefined : deltaOf(next.value)).toBe('still here');

    // And the listener still accepts, into the slot the closed tunnel gave back.
    expect(listener.server.listening).toBe(true);
    const c = await rawPeer(port, credential);
    const tunnelC = await Promise.race([
      nextTunnel(incoming),
      c.closeCode.then((code) => {
        throw new Error(`a peer after a per-tunnel close was refused with ${String(code)}`);
      }),
    ]);
    expect(tunnelC.ended()).toBeNull();
  });

  it('listener.close() with live tunnels resolves, and every peer hears bye', async () => {
    const { listener, port, incoming, credential } = await listen({ maxTunnels: 2 });
    const a = await rawPeer(port, credential);
    const tunnelA = await nextTunnel(incoming);
    const b = await rawPeer(port, credential);
    const tunnelB = await nextTunnel(incoming);

    /*
     * A PLAIN HTTP REQUEST NOBODY ANSWERS, held open. `http.Server.close()`
     * waits for every connection to end on its own, and this one never will —
     * which is the hang `closeAllConnections()` exists to prevent. Awaiting
     * `request` means the server is mid-request, so it is not an idle
     * connection that `close()` would drop by itself.
     */
    const requested = new Promise<void>((resolve) => {
      listener.server.once('request', () => resolve());
    });
    const pending = request({ host: '127.0.0.1', port, path: '/' });
    pending.on('error', () => undefined);
    pending.end();
    open.push({ close: () => pending.destroy() });
    await requested;

    await listener.close('shutting down');

    await Promise.all([a.closeCode, b.closeCode]);
    const bye = { v: TUNNEL_WIRE_VERSION, kind: 'bye', body: { reason: 'shutting down' } };
    expect(a.frames.at(-1)).toEqual(bye);
    expect(b.frames.at(-1)).toEqual(bye);
    expect(tunnelA.ended()).toEqual({ kind: 'clean', reason: 'shutting down' });
    expect(tunnelB.ended()).toEqual({ kind: 'clean', reason: 'shutting down' });
    expect(listener.server.listening).toBe(false);
    // A closed listener stops handing out tunnels, so a loop over them ends.
    expect(await incoming.next()).toEqual({ done: true, value: undefined });
  });

  it('an upgrade that lands once close() has begun is dropped, not handed out', async () => {
    /*
     * `close()` STOPS ADMITTING IN ITS FIRST TURN, before it waits on any
     * tunnel's `bye`. Those waits are real turns of the event loop, and an
     * upgrade landing in one would otherwise be admitted to a listener that is
     * going: a 101, a tunnel queued for a loop that is about to end, and a
     * terminate a moment later. Loopback gives no way to aim a peer's bytes at
     * that turn, so the test holds one real upgrade back from the listener and
     * delivers it itself, in the same turn as `close()`.
     */
    const { listener, port, incoming, credential } = await listen({ maxTunnels: 2 });
    await rawPeer(port, credential);
    await nextTunnel(incoming);

    const handlers = listener.server.listeners('upgrade') as ((...args: unknown[]) => void)[];
    listener.server.removeAllListeners('upgrade');
    const held = new Promise<unknown[]>((resolve) => {
      listener.server.once('upgrade', (...args: unknown[]) => resolve(args));
    });
    const { connect } = await import('node:net');
    const late = connect(port, '127.0.0.1');
    open.push({ close: () => late.destroy() });
    late.on('error', () => undefined);
    const answer = new Promise<string>((resolve) => {
      late.once('data', (data: Buffer) => resolve(data.toString('latin1')));
      late.once('close', () => resolve(''));
    });
    // With a valid credential, so the drop is close()'s and not the gate's.
    late.write(upgradeRequest(port, credential));
    const upgrade = await held;
    for (const handler of handlers) listener.server.on('upgrade', handler);

    const closing = listener.close();
    listener.server.emit('upgrade', ...upgrade);
    await closing;

    expect(await answer).toBe('');
    expect(await incoming.next()).toEqual({ done: true, value: undefined });
  });

  it('refuses a cap that is not a positive integer', async () => {
    // No default and no clamping: a cap of 0 or NaN is a caller's mistake, and
    // a listener that quietly admitted everyone would hide it.
    for (const maxTunnels of [0, -1, 1.5, Number.NaN]) {
      const attempt = createTunnelListener({ maxTunnels, binding: testGate().binding() });
      attempt.then((listener) => open.push(listener), () => undefined);
      await expect(attempt, String(maxTunnels)).rejects.toThrow(RangeError);
    }
  });

  it('has no default cap: the caller must name one', () => {
    /*
     * A TYPE-LEVEL ASSERTION, and `npm run typecheck` is what runs it: `tests/`
     * is in the root tsconfig. If `maxTunnels` ever gains a default, the
     * directive below is unused and the typecheck fails. The runtime line is
     * only there to give the test a body.
     */
    // The binding is supplied, so the directive below is about maxTunnels alone
    // and would go unused the day it gained a default.
    const binding = testGate().binding();
    // @ts-expect-error maxTunnels is required
    const options: TunnelListenerOptions = { binding };
    expect(options).toEqual({ binding });
  });
});

/** A complete WebSocket upgrade request, as the bytes a raw TCP peer writes. */
const upgradeRequest = (port: number, credential: string): string =>
  [
    'GET / HTTP/1.1',
    `Host: 127.0.0.1:${String(port)}`,
    'Upgrade: websocket',
    'Connection: Upgrade',
    // RFC 6455's own sample nonce: any 16 bytes, base64.
    'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
    'Sec-WebSocket-Version: 13',
    `${TUNNEL_CREDENTIAL_HEADER}: ${credential}`,
    '',
    '',
  ].join('\r\n');

/**
 * A peer that breaks the WebSocket protocol itself, which no WebSocket client
 * will do on request — so it is written by hand over raw TCP, for the reason
 * `faultyHost` in `tests/rung0.test.ts` is.
 */
async function protocolBreaker(port: number, credential: string) {
  const { connect } = await import('node:net');
  const tcp = connect(port, '127.0.0.1');
  open.push({ close: () => tcp.destroy() });
  tcp.on('error', () => undefined);
  const gone = new Promise<void>((resolve) => tcp.once('close', () => resolve()));
  await new Promise<void>((resolve, reject) => {
    tcp.once('data', (data: Buffer) =>
      data.toString('latin1').startsWith('HTTP/1.1 101')
        ? resolve()
        : reject(new Error('the listener did not upgrade the connection')),
    );
    tcp.write(upgradeRequest(port, credential));
  });
  return {
    /** A text frame WITHOUT the mask RFC 6455 requires of every client frame. */
    sendUnmasked: () => tcp.write(Buffer.from([0x81, 0x02, 0x68, 0x69])),
    gone,
  };
}

describe('a peer that breaks the WebSocket protocol', () => {
  it('ends its own tunnel as FRAME_INVALID, and nothing else', async () => {
    /*
     * MEASURED BEFORE THE FIX: one unmasked frame from any peer was an
     * uncaught exception ("Invalid WebSocket frame: MASK must be set"), because
     * `ws` reports it as an `error` event and nothing listened. In a listener
     * holding several tunnels that is one peer taking down all of them.
     */
    const { listener, port, incoming, credential } = await listen({ maxTunnels: 2 });
    const good = await rawPeer(port, credential);
    const tunnelGood = await nextTunnel(incoming);
    const bad = await protocolBreaker(port, credential);
    const tunnelBad = await nextTunnel(incoming);

    bad.sendUnmasked();
    await tunnelBad.closed;
    expect(tunnelBad.ended()).toMatchObject({ kind: 'abnormal', code: 'FRAME_INVALID' });

    expect(tunnelGood.ended()).toBeNull();
    good.socket.send(encodeFrame(chunk(0, 'unbothered')));
    const next = await tunnelGood.receive()[Symbol.asyncIterator]().next();
    expect(next.done ? undefined : deltaOf(next.value)).toBe('unbothered');
    expect(listener.server.listening).toBe(true);
  });

  it('does not take the listener down when it is a peer the cap refused', async () => {
    /*
     * A refused socket is mid close-handshake, and `ws` still reads what the
     * peer sends until that finishes — so a refused peer can raise the same
     * `error`. It belongs to no tunnel, so there is no tunnel to assert on:
     * without a listener for it, the failure is vitest's unhandled-error
     * report failing the run, which is the crash this pins.
     */
    const { listener, port, incoming, credential } = await listen({ maxTunnels: 1 });
    const good = await rawPeer(port, credential);
    const tunnelGood = await nextTunnel(incoming);

    const refused = await protocolBreaker(port, credential);
    refused.sendUnmasked();
    await refused.gone;
    await eventually(async () => (await connectionsOf(listener.server)) === 1);

    expect(tunnelGood.ended()).toBeNull();
    expect(good.frames).toEqual([]);
    expect(listener.server.listening).toBe(true);
  });

  it('a refused peer that never answers the close does not hold listener.close() open', async () => {
    /*
     * RFC 6455 OBLIGES A PEER TO ANSWER A CLOSE FRAME, and `ws` waits 30
     * seconds for that answer before giving up on the socket. A peer the cap
     * refused is mid close-handshake: still one of `ws`'s clients and still one
     * of the server's connections, which `closeAllConnections()` does not
     * reach once upgraded and `server.close()` waits for. Measured with the
     * step that terminates leftover clients removed: `listener.close()` took
     * 30 seconds, and a quit hook waiting on it would too. Every other peer in
     * these tests is a `ws` client, which answers a close by itself, so none of
     * them could see it. The test timeout is the bound.
     */
    const { listener, port, incoming, credential } = await listen({ maxTunnels: 1 });
    await rawPeer(port, credential);
    await nextTunnel(incoming);

    // Upgraded and refused in the same turn on the server's side, and it never
    // writes another byte.
    const silent = await protocolBreaker(port, credential);

    await listener.close();
    await silent.gone;
    expect(listener.server.listening).toBe(false);
  });
});
