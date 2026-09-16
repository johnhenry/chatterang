// @vitest-environment node
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import { createTunnelClient } from '@chatterang/tunnel/client';
import { createTunnelListener, type Tunnel } from '@chatterang/tunnel/host';
import { isMessage } from '@chatterang/tunnel/stream';
import { decodeFrame, encodeFrame, type TunnelFrame } from '@chatterang/tunnel/wire';

import { WorkBroker, wireDeviceTunnel } from '@chatterang/desktop/bridge';
import type { HostedUnit, WorkerHost, WorkerTurnEnd } from '@chatterang/desktop/bridge';

import { testGate } from './support/tunnel-gate';

/**
 * #296: a REAL device tunnel (a real `ws` socket over loopback, the real
 * credential gate, the real wire codec) carries a real `turn` frame into
 * `apps/desktop/src/bridge/peer-turns.ts`'s `wireDeviceTunnel`, through a REAL
 * `WorkBroker`, to a `WorkerHost` double — the same shape
 * `tests/desktop-worker-host.test.ts` uses for `WorkerHost`'s own tests, since
 * a real one needs a real Electron window (`tests/desktop-peer-turn-window.
 * test.ts` covers that half). What crosses the wire, both ways, is real bytes
 * through `encodeFrame`/`decodeFrame`; only "the worker ran an LLM" is a
 * double.
 */

const open: { close(): Promise<void> }[] = [];
afterEach(async () => {
  for (const closeable of open.reverse()) await closeable.close().catch(() => undefined);
  open.length = 0;
});

/** A listener with one device tunnel, over the real gate, on loopback. */
async function connectedTunnel(): Promise<{ tunnel: Tunnel; client: Awaited<ReturnType<typeof createTunnelClient>> }> {
  const gate = testGate();
  const { credential } = await gate.mintDevice();
  const listener = await createTunnelListener({ binding: gate.binding(), maxTunnels: 1 });
  open.push(listener);
  const tunnels = listener.tunnels()[Symbol.asyncIterator]();
  const { port } = listener.server.address() as AddressInfo;
  const clientPromise = createTunnelClient({ url: `ws://127.0.0.1:${String(port)}`, credential });
  const tunnel = (await tunnels.next()).value as Tunnel;
  const client = await clientPromise;
  open.push(client);
  return { tunnel, client };
}

/** A `WorkerHost` double: decodes the real encoded turn, and scripts a reply. */
function fakeWorkerHost(
  script: (request: { turn: string; body: Record<string, unknown> }, emit: (chunk: Record<string, unknown>) => void) => WorkerTurnEnd | Promise<WorkerTurnEnd>,
): WorkerHost & { readonly runs: { readonly unit: HostedUnit; readonly signal: AbortSignal }[] } {
  const runs: { unit: HostedUnit; signal: AbortSignal }[] = [];
  return {
    runs,
    async run(unit, encodedTurn, signal, onFrame) {
      runs.push({ unit, signal });
      const decoded = decodeFrame(encodedTurn);
      if (decoded.kind !== 'turn') throw new Error('test: expected a turn frame');
      const emit = (chunk: Record<string, unknown>): void => {
        onFrame(encodeFrame({ v: 1, kind: 'chunk', turn: decoded.turn, body: chunk }));
      };
      return script({ turn: decoded.turn, body: decoded.body as Record<string, unknown> }, emit);
    },
    condemn: () => false,
    hostedUnitOf: () => undefined,
    dispose: () => undefined,
  };
}

function turnFrame(overrides: Partial<Extract<TunnelFrame, { kind: 'turn' }>> = {}): TunnelFrame {
  return {
    v: 1,
    kind: 'turn',
    turn: 't1',
    toolLoop: 'requester',
    body: {
      messages: [{ role: 'user', content: 'hello from the phone' }],
      parameters: { model: 'm' },
      metadata: { requestId: 't1', timestamp: Date.now(), custom: { routeTo: 'somewhere-else' } },
    },
    ...overrides,
  } as TunnelFrame;
}

describe('wireDeviceTunnel runs a real turn frame end to end (#296)', () => {
  it('admits the turn, strips metadata.custom before the worker sees it, and streams the reply back', async () => {
    const seenByWorker: Record<string, unknown>[] = [];
    const workerHost = fakeWorkerHost((request, emit) => {
      seenByWorker.push(request.body);
      emit({ type: 'content', sequence: 0, delta: 'hi ' });
      emit({ type: 'content', sequence: 1, delta: 'there' });
      const terminal = encodeFrame({
        v: 1,
        kind: 'chunk',
        turn: request.turn,
        body: { type: 'done', sequence: 2, finishReason: 'stop', message: { role: 'assistant', content: 'hi there' } },
      });
      return { kind: 'ended', frame: terminal };
    });
    const broker = new WorkBroker({ notifyWindow: () => false });
    const { tunnel, client } = await connectedTunnel();
    wireDeviceTunnel(tunnel, { broker, workerHost });

    await client.send(turnFrame());

    const frames: TunnelFrame[] = [];
    for await (const frame of client.receive()) {
      frames.push(frame);
      if (frame.kind === 'chunk' && (frame.body as { type?: string }).type === 'done') break;
    }

    const bodies = frames.map((frame) => (frame.kind === 'chunk' ? (frame.body as { type: string }) : null));
    expect(bodies.map((body) => body?.type)).toEqual(['content', 'content', 'done']);

    // #141: the worker never sees `metadata.custom` — it is not read for
    // routing, and it is not forwarded either.
    expect(seenByWorker).toHaveLength(1);
    const metadata = seenByWorker[0]!.metadata as { custom?: unknown };
    expect(metadata.custom).toBeUndefined();

    // #260: the terminal `done` carries a real, checkable message.
    const terminal = frames.at(-1)!;
    expect(terminal.kind).toBe('chunk');
    if (terminal.kind !== 'chunk') throw new Error('unreachable');
    const message = (terminal.body as { message?: unknown }).message;
    expect(isMessage(message)).toBe(true);
  });

  it('refuses a turn that does not keep the tool loop on the requester, and never starts the worker', async () => {
    const workerHost = fakeWorkerHost(() => ({ kind: 'ended', frame: new Uint8Array() }));
    const broker = new WorkBroker({ notifyWindow: () => false });
    const { tunnel, client } = await connectedTunnel();
    wireDeviceTunnel(tunnel, { broker, workerHost });

    await client.send(turnFrame({ toolLoop: 'host' }));

    const frame = (await client.receive()[Symbol.asyncIterator]().next()).value as TunnelFrame;
    expect(frame.kind).toBe('error');
    if (frame.kind !== 'error') throw new Error('unreachable');
    expect(frame.turn).toBe('t1');
    expect(frame.body.code).toBe('TOOL_LOOP_UNSUPPORTED');
    expect(workerHost.runs).toHaveLength(0);
  });

  it('cancels the worker’s signal when the device sends cancel', async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = () => resolve();
    });
    const workerHost = fakeWorkerHost(async (request, emit) => {
      emit({ type: 'content', sequence: 0, delta: 'part' });
      await held;
      return {
        kind: 'ended',
        frame: encodeFrame({
          v: 1,
          kind: 'chunk',
          turn: request.turn,
          body: { type: 'error', sequence: 1, error: { code: 'CANCELLED', message: 'cancelled' } },
        }),
      };
    });
    const broker = new WorkBroker({ notifyWindow: () => false });
    const { tunnel, client } = await connectedTunnel();
    wireDeviceTunnel(tunnel, { broker, workerHost });

    await client.send(turnFrame());
    // Give the worker a moment to start and record its run before cancelling.
    await new Promise((resolve) => setTimeout(resolve, 20));
    await client.send({ v: 1, kind: 'cancel', turn: 't1' });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(workerHost.runs).toHaveLength(1);
    expect(workerHost.runs[0]!.signal.aborted).toBe(true);
    release();
  });
});
