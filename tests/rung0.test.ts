// @vitest-environment node
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import { streamIntegrityWarning, streamedTextOf } from '@/ai/engine';
import { createTunnelClient } from '@chatterang/tunnel/client';
import { createTunnelHost } from '@chatterang/tunnel/host';
import { isMessage } from '@chatterang/tunnel/stream';
import { TUNNEL_WIRE_VERSION, encodeFrame, type TunnelFrame } from '@chatterang/tunnel/wire';

/**
 * RUNG 0 (#156): two halves of the tunnel on one machine, over loopback.
 *
 * It exists to remove every variable that is not the protocol — no TLS, no
 * certificate, no LAN, no device, no webview. If a stream tears here it is the
 * protocol's fault, and every later bug report is answerable with "does rung 0
 * reproduce it".
 *
 * IN-PROCESS RATHER THAN TWO CHILD PROCESSES, deliberately. The socket is
 * identical either way, and a child needs an IPC control channel to inject a
 * fault — which makes a failed injection indistinguishable from a hung child.
 * The isolation a child buys is isolation from shared module state, and these
 * two halves share none: the client reaches for the global `WebSocket`, the
 * host for `ws`.
 *
 * MANNERS COPIED FROM `tests/download.test.ts`, which #156 names as the
 * precedent: ephemeral ports so nothing collides, every server closed in
 * `afterEach` whether the test passed or threw, and no fixed timeouts that
 * turn a slow machine into a failure.
 */

const open: { close(): Promise<void> }[] = [];
afterEach(async () => {
  // Closed in reverse so a client goes before the host it is attached to.
  for (const closeable of open.reverse()) await closeable.close().catch(() => undefined);
  open.length = 0;
});

const chunk = (sequence: number, delta: string): TunnelFrame => ({
  v: TUNNEL_WIRE_VERSION,
  kind: 'chunk',
  turn: 't1',
  body: { type: 'content', sequence, delta },
});

/**
 * A terminal chunk. `message` is an `IRMessage`, NOT a string — and that is a
 * correction, not a detail. `StreamDoneChunk.message` is typed `IRMessage`,
 * `streamedTextOf` reads `.content`, and this fixture originally sent a bare
 * string: it compared strings itself and passed, while the detector the app
 * actually ships would have reached `.map` on `undefined` and thrown. The
 * frame body is `unknown` by design, so nothing caught it until `#260`'s
 * obligation made the shape a rule rather than a convention.
 */
const done = (sequence: number, text: string): TunnelFrame => ({
  v: TUNNEL_WIRE_VERSION,
  kind: 'chunk',
  turn: 't1',
  body: {
    type: 'done',
    sequence,
    finishReason: 'stop',
    message: { role: 'assistant', content: text },
  },
});

/** The far side's own assembly, as the app reads it. */
const assembledOf = (frame: TunnelFrame | undefined): string | undefined => {
  const message = bodyOf(frame!)?.['message'];
  return isMessage(message) ? streamedTextOf(message) : undefined;
};

/** A host and a client, connected, both registered for teardown. */
async function pair(greeting?: readonly TunnelFrame[]) {
  const host = await createTunnelHost(greeting ? { greeting } : {});
  open.push(host);
  const { port } = host.server.address() as AddressInfo;
  const client = await createTunnelClient({ url: `ws://127.0.0.1:${port}` });
  open.push(client);
  return { host, client };
}

/** Drain a receive() until it ends, so a test reads whole streams. */
async function drain(source: AsyncIterable<TunnelFrame>): Promise<TunnelFrame[]> {
  const frames: TunnelFrame[] = [];
  for await (const frame of source) frames.push(frame);
  return frames;
}

/** The stream every fault below is a mutilation of. */
const STREAM: readonly TunnelFrame[] = [
  chunk(0, 'the '),
  chunk(1, 'quick '),
  chunk(2, 'brown '),
  chunk(3, 'fox'),
  done(4, 'the quick brown fox'),
];

/** The chunk body of a frame, or undefined. Narrows once, here. */
function bodyOf(frame: TunnelFrame): Record<string, unknown> | undefined {
  return 'body' in frame ? (frame.body as Record<string, unknown> | undefined) : undefined;
}

const textOf = (frames: readonly TunnelFrame[]): string =>
  frames.map((frame) => String(bodyOf(frame)?.['delta'] ?? '')).join('');

const seqOf = (frames: readonly TunnelFrame[]): number[] =>
  frames.map((frame) => Number(bodyOf(frame)?.['sequence']));

describe('the clean path', () => {
  it('carries a whole stream across, in order, and ends cleanly', async () => {
    const { host, client } = await pair(STREAM);
    await host.close();

    const received = await drain(client.receive());
    expect(textOf(received)).toBe('the quick brown fox');
    expect(client.ended()).toEqual({ kind: 'clean' });
  });

  it('the assembled text agrees with the concatenated deltas', async () => {
    /*
     * #156 calls this "the disagreement this transport can create and an
     * in-process call cannot". An async generator cannot drop its own yields;
     * a socket can. So the `done` chunk carries the far side's own assembly
     * and the two are compared — which is #148's checksum, exercised here
     * against a real wire for the first time.
     */
    const { host, client } = await pair(STREAM);
    await host.close();

    const received = await drain(client.receive());
    expect(assembledOf(received.at(-1))).toBe(textOf(received.slice(0, -1)));
    // Read through the app's own reader, so the fixture cannot drift from the
    // shape `streamIntegrityWarning` actually consumes.
    expect(streamIntegrityWarning(textOf(received.slice(0, -1)), { role: 'assistant', content: 'the quick brown fox' })).toBeNull();
  });
});

describe('fault 1 — a dropped frame', () => {
  it('fails the stream at the gap, rather than rendering what arrived', async () => {
    /*
     * INJECTED BY THE HARNESS, not by the wire. A WebSocket delivers whole
     * messages in order over TCP, so a frame cannot go missing by accident —
     * which is why this is written by omitting one at the source.
     *
     * THE OUTCOME CHANGED WITH #260's RULING. The IR says a consumer that sees
     * a gap "should fail the turn rather than render it", and the tunnel now
     * does: the stream ends at the gap, not at the end. Rendering the rest and
     * warning afterwards would show the user something and then take it back.
     */
    const lossy = STREAM.filter((frame) => bodyOf(frame)?.['sequence'] !== 2);
    const { host, client } = await pair(lossy);

    const received = await drain(client.receive());
    expect(textOf(received)).toBe('the quick ');
    const close = client.ended();
    expect(close).toMatchObject({ kind: 'abnormal', code: 'SEQUENCE_BROKEN' });
    // The sentence too, not just the code: #148's argument is that the user
    // reads a torn reply as the MODEL failing, so the wording is the fix.
    expect(close?.kind === 'abnormal' ? close.message : '').toContain('incomplete');
    await host.close();
  });

  it('a RENUMBERED drop is contiguous, and only done.message catches it', async () => {
    /*
     * THE CASE THAT JUSTIFIES THE `done.message` OBLIGATION (#260).
     *
     * Contiguity catches a gap. It is blind to a relay that drops a frame and
     * renumbers what follows — the sequence is perfect, and the only thing
     * left that disagrees is the far side's own assembly. #260 called
     * `done.message` "the only detector faults 1 and 2 have"; with contiguity
     * enforced it is narrower than that and more important: it is the only
     * detector for the loss that contiguity cannot see.
     */
    const renumbered: TunnelFrame[] = [
      chunk(0, 'the '),
      chunk(1, 'quick '),
      chunk(2, 'fox'), // 'brown ' dropped, and the gap papered over
      done(3, 'the quick brown fox'),
    ];
    const { host, client } = await pair(renumbered);
    await host.close();

    const received = await drain(client.receive());
    // The transport is satisfied: no gap, and it closed cleanly.
    expect(client.ended()).toEqual({ kind: 'clean' });

    const deltas = textOf(received.slice(0, -1));
    expect(deltas).toBe('the quick fox');
    expect(assembledOf(received.at(-1))).toBe('the quick brown fox');

    // And this is the app's own detector, run over what actually crossed the
    // wire — not a fixture built to look like it.
    const warning = streamIntegrityWarning(deltas, { role: 'assistant', content: 'the quick brown fox' });
    expect(warning).not.toBeNull();
    expect(warning?.category).toBe('transport-degraded');
    expect(warning?.message).toContain('6 characters did not reach this device');
  });
});

describe('fault 2 — two frames reordered', () => {
  it('fails the stream, because the sequence is what notices', async () => {
    /*
     * A length check could not see this: same frames, same count, different
     * order. `sequence` is the whole reason the IR carries a counter that is
     * "decoration" in one process.
     */
    const swapped = [STREAM[0]!, STREAM[2]!, STREAM[1]!, STREAM[3]!, STREAM[4]!];
    const { host, client } = await pair(swapped);

    const received = await drain(client.receive());
    expect(seqOf(received)).toEqual([0]);
    expect(client.ended()).toMatchObject({ kind: 'abnormal', code: 'SEQUENCE_BROKEN' });
    await host.close();
  });

  it('the same frames in order are clean — the paired control', async () => {
    const { host, client } = await pair(STREAM);
    await host.close();
    const received = await drain(client.receive());
    expect(seqOf(received)).toEqual([0, 1, 2, 3, 4]);
    expect(client.ended()).toEqual({ kind: 'clean' });
  });
});

describe('the done.message obligation, from the sending side (#260)', () => {
  it('the host refuses to send a terminal chunk without it', async () => {
    /*
     * #260 predicted the failure mode exactly: the field is a second full copy
     * of the reply, so "the first reviewer optimising bandwidth deletes it
     * unless the requirement is written down". A comment is not a requirement.
     */
    const { host } = await pair();
    await expect(
      host.send({
        v: TUNNEL_WIRE_VERSION,
        kind: 'chunk',
        turn: 't1',
        body: { type: 'done', sequence: 0, finishReason: 'stop' },
      }),
    ).rejects.toThrow(/must carry `message`/);
  });

  it('and refuses a bare string, which is the shape that used to pass', async () => {
    const { host } = await pair();
    await expect(
      host.send({
        v: TUNNEL_WIRE_VERSION,
        kind: 'chunk',
        turn: 't1',
        body: { type: 'done', sequence: 0, finishReason: 'stop', message: 'the quick brown fox' },
      }),
    ).rejects.toThrow(/IRMessage/);
  });
});

/**
 * A DELIBERATELY MISBEHAVING HOST, which is what rung 0 is for.
 *
 * The real `createTunnelHost` cannot cut its own socket without saying `bye`,
 * and it should not be able to — the `bye` obligation (#260) is the thing
 * under test, and a production method that skips it would be a hole shaped
 * exactly like the fault. `encodeFrame` likewise overwrites `v`, so a real
 * host cannot put a wrong-version frame on the wire either.
 *
 * So the faults live HERE, in a server the test owns and that speaks the wire
 * format by hand. That is the shape `tests/download.test.ts` already uses —
 * #156 names it as the precedent — and it keeps the misbehaviour out of the
 * code that is supposed to behave.
 */
async function faultyHost(script: {
  readonly frames?: readonly TunnelFrame[];
  /** Raw bytes, bypassing `encodeFrame`. For a frame no encoder would emit. */
  readonly raw?: Uint8Array;
  /** Destroy the socket without a `bye`, as a cut or a crash does. */
  readonly cut?: boolean;
}) {
  const { WebSocketServer } = await import('ws');
  const server = createServer();
  const sockets = new WebSocketServer({ server });

  sockets.on('connection', (socket) => {
    for (const frame of script.frames ?? []) socket.send(encodeFrame(frame));
    if (script.raw) socket.send(script.raw);
    if (script.cut) {
      // `terminate()`, not `close()`: no close handshake, no `bye`. This is a
      // pulled cable, which is the fault being injected.
      setTimeout(() => socket.terminate(), 10);
    }
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  open.push({
    close: async () => {
      sockets.clients.forEach((client) => client.terminate());
      server.closeAllConnections();
      await new Promise<void>((resolve) => sockets.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  });

  const client = await createTunnelClient({ url: `ws://127.0.0.1:${port}` });
  open.push(client);
  return client;
}

describe('fault 3 — the socket is cut mid-stream', () => {
  it('reports PEER_GONE rather than ending the stream quietly', async () => {
    /*
     * #185: "a tunnel stream that ends when the socket closes is
     * indistinguishable from one that finished". It is distinguishable now,
     * and the thing that distinguishes it is the `bye` obligation.
     */
    const client = await faultyHost({ frames: [chunk(0, 'the '), chunk(1, 'quick ')], cut: true });

    const received = await drain(client.receive());
    expect(textOf(received)).toBe('the quick ');
    expect(client.ended()).toMatchObject({ kind: 'abnormal', code: 'PEER_GONE' });
  });
});

describe('fault 4 — cut between the last content chunk and done', () => {
  it('is abnormal, not a finished turn — the case #185 is about', async () => {
    /*
     * THE ONE THAT MATTERS MOST. Every content chunk arrived; only the
     * terminal one did not. Before the `bye` obligation this was
     * byte-identical to a stream that finished, and the app rendered a
     * truncated reply as a complete one — which is what #262 just fixed at the
     * engine layer and what this pins at the transport layer.
     */
    const client = await faultyHost({ frames: STREAM.slice(0, 4), cut: true });

    const received = await drain(client.receive());
    expect(textOf(received)).toBe('the quick brown fox');
    // EVERY delta arrived, which is what makes it indistinguishable without
    // the close classification.
    expect(received).toHaveLength(4);
    expect(received.some((frame) => bodyOf(frame)?.['type'] === 'done')).toBe(false);
    expect(client.ended()).toMatchObject({ kind: 'abnormal', code: 'PEER_GONE' });
  });

  it('the same frames with a clean close are CLEAN — the paired control', async () => {
    // Without this, the test above passes on a client that calls everything
    // abnormal. The difference between them is one frame.
    const { host, client } = await pair(STREAM.slice(0, 4));
    await host.close();
    const received = await drain(client.receive());
    expect(received).toHaveLength(4);
    expect(client.ended()).toEqual({ kind: 'clean' });
  });
});

describe('a frame the codec refuses', () => {
  it('is FRAME_INVALID, and does not look like a peer going away', async () => {
    /*
     * Raw bytes, because `encodeFrame` stamps the current version over
     * whatever it is handed — so a real host cannot emit this and the fault
     * has to be written by hand. A wrong-version peer can.
     */
    const wrongVersion = new TextEncoder().encode(
      JSON.stringify({ v: 99, kind: 'chunk', turn: 't1', body: {} }),
    );
    const client = await faultyHost({ raw: wrongVersion });

    await drain(client.receive());
    expect(client.ended()).toMatchObject({ kind: 'abnormal', code: 'FRAME_INVALID' });
  });

  it('stays FRAME_INVALID after the socket finishes closing', async () => {
    /*
     * THE LATCH, WHICH NOTHING ELSE HERE TESTS.
     *
     * A refused frame closes the socket, so the close event lands a moment
     * later carrying PEER_GONE. `receive()` returns as soon as the tunnel is
     * classified — BEFORE that second event — so the assertion above reads the
     * right answer without ever proving the second event cannot overwrite it.
     * Mutation testing showed exactly that: turning `??=` into `=` changed no
     * test. Awaiting `closed` reads the value after both events have landed.
     */
    const wrongVersion = new TextEncoder().encode(
      JSON.stringify({ v: 99, kind: 'chunk', turn: 't1', body: {} }),
    );
    const client = await faultyHost({ raw: wrongVersion });

    await drain(client.receive());
    await client.closed;
    expect(client.ended()).toMatchObject({ kind: 'abnormal', code: 'FRAME_INVALID' });
  });
});

describe('each half reports its OWN close', () => {
  it('the host that closed deliberately says clean, not PEER_GONE', async () => {
    /*
     * Every other assertion in this file reads the CLIENT's end, which is how
     * the host came to report its own deliberate shutdown as a cut: `close()`
     * terminated the socket first, the socket's close handler latched
     * PEER_GONE, and the `clean` that followed was swallowed by the latch.
     * A host that cannot tell "I shut down" from "my peer vanished" cannot
     * report either one to #186.
     */
    const { host } = await pair(STREAM);
    await host.close('done for now');

    expect(host.ended()).toEqual({ kind: 'clean', reason: 'done for now' });
    await host.closed;
    expect(host.ended()).toEqual({ kind: 'clean', reason: 'done for now' });
  });

  it('the client says bye too, and the host hears it as clean', async () => {
    /*
     * THE MIRROR, and it was missing. Every other test closes from the host
     * side, so the client's own `bye` was written and never observed —
     * mutation testing caught it by replacing that frame with a `cancel` and
     * watching all twelve tests stay green. The obligation is symmetric (#260)
     * and a one-sided test only pins one side of it.
     */
    const { host, client } = await pair();
    await client.close('user closed the sheet');

    await host.closed;
    expect(host.ended()).toEqual({ kind: 'clean', reason: 'user closed the sheet' });
  });

  it('the host whose peer vanished says PEER_GONE', async () => {
    /*
     * THE PAIRED CONTROL: same method, opposite cause, so the test above
     * cannot pass on a host that calls everything clean.
     *
     * The peer here is a raw `ws` client rather than `createTunnelClient`,
     * for the reason `faultyHost` exists: the real client says `bye` before it
     * goes, and being unable to skip that is the property under test. So the
     * misbehaviour is written by hand, on this side too.
     */
    const host = await createTunnelHost({});
    open.push(host);
    const { port } = host.server.address() as AddressInfo;

    const { WebSocket: RawSocket } = await import('ws');
    const peer = new RawSocket(`ws://127.0.0.1:${port}`);
    await new Promise<void>((resolve, reject) => {
      peer.on('open', () => resolve());
      peer.on('error', reject);
    });
    peer.terminate(); // A pulled cable: no close frame, no `bye`.

    await host.closed;
    expect(host.ended()).toMatchObject({ kind: 'abnormal', code: 'PEER_GONE' });
  });
});

describe('the listener lifecycle', () => {
  it('a port already in use rejects rather than crashing', async () => {
    /*
     * EADDRINUSE USED TO BE AN UNCAUGHT EXCEPTION. `listen` had no error path,
     * so the promise never settled — and `ws`, attached with `{ server }`,
     * forwarded the server's `error` onto a WebSocketServer nobody listened
     * to, which throws. A caller holding a busy port got a crashed process
     * rather than a rejection it could report.
     *
     * The race is not a slow-machine timeout: a bind error comes back in
     * microseconds. It only decides how a regression is REPORTED — as a
     * named non-settlement here rather than a generic test timeout.
     */
    const occupant = createServer();
    await new Promise<void>((resolve) => occupant.listen(0, '127.0.0.1', resolve));
    open.push({ close: () => new Promise<void>((resolve) => occupant.close(() => resolve())) });
    const { port } = occupant.address() as AddressInfo;

    const attempt = createTunnelHost({ port });
    // A regression that binds anyway must not leak a server into the next test.
    attempt.then((host) => open.push(host), () => undefined);

    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsettled = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('createTunnelHost never settled')), 2000);
    });
    try {
      await expect(Promise.race([attempt, unsettled])).rejects.toMatchObject({ code: 'EADDRINUSE' });
    } finally {
      clearTimeout(timer);
    }
  });

  it('an error after listening is not swallowed by the listen promise', async () => {
    /*
     * THE OTHER HALF OF THAT ERROR PATH. The `once('error', reject)` that turns
     * a busy port into a rejection comes off once the bind succeeds. Left on,
     * it would take the next server error and hand it to a promise that has
     * already resolved, where it vanishes — and a failed listener looks like a
     * healthy one.
     */
    const host = await createTunnelHost({});
    open.push(host);
    expect(() => host.server.emit('error', new Error('after listen'))).toThrow('after listen');
  });

  it('the single-tunnel host sends to the peer it admitted', async () => {
    /*
     * The host is a listener capped at one tunnel now, so `send` forwards to
     * that tunnel. Every other test here streams through the GREETING, which a
     * forward that went nowhere would leave undisturbed.
     */
    const { host, client } = await pair();
    await host.send(chunk(0, 'the '));
    await host.close();
    expect(textOf(await drain(client.receive()))).toBe('the ');
  });

  it('the single-tunnel host stops accepting once its tunnel ends', async () => {
    /*
     * RUNG 0's HOST IS ONE TUNNEL'S LIFETIME, and the socket now agrees. It
     * used to keep listening after its tunnel ended, so a late peer completed
     * a handshake onto a tunnel that would never read another frame, and the
     * port reported "on" while serving nothing. ECONNREFUSED is the honest
     * answer.
     */
    const host = await createTunnelHost({});
    open.push(host);
    const { port } = host.server.address() as AddressInfo;

    const { WebSocket: RawSocket } = await import('ws');
    const connect = () =>
      new Promise<InstanceType<typeof RawSocket>>((resolve, reject) => {
        const peer = new RawSocket(`ws://127.0.0.1:${port}`);
        open.push({ close: async () => peer.terminate() });
        peer.on('open', () => resolve(peer));
        peer.on('error', reject);
      });

    (await connect()).terminate();
    await host.closed;
    expect(host.ended()).toMatchObject({ kind: 'abnormal', code: 'PEER_GONE' });

    await expect(connect()).rejects.toMatchObject({ code: 'ECONNREFUSED' });
  });

  it('the single-tunnel host receives from the peer it admitted', async () => {
    // The mirror of `sends to the peer it admitted`. No other test here reads
    // `host.receive()`, so a forward that yielded nothing would pass them all.
    const { host, client } = await pair();
    await client.send(chunk(0, 'up the wire'));
    await client.close();
    expect(textOf(await drain(host.receive()))).toBe('up the wire');
    expect(host.ended()).toEqual({ kind: 'clean' });
  });

  it('a host closed before any peer arrives ends clean, and says so', async () => {
    /*
     * The one path with no tunnel behind it. `closed` must still resolve and
     * `receive()` must still end, or a caller that shuts down an unused host
     * waits forever for a peer that is never coming.
     */
    const host = await createTunnelHost({});
    open.push(host);
    await host.close('never used');
    await host.closed;
    expect(host.ended()).toEqual({ kind: 'clean', reason: 'never used' });
    expect(await drain(host.receive())).toEqual([]);
  });
});
