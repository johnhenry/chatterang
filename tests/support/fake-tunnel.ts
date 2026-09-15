/**
 * A tunnel for tests: two in-memory ends, each behind the REAL protocol gate.
 *
 * The phone's end is a `TunnelClient` that does what `createTunnelClient` does
 * with a frame (packages/tunnel/src/client/index.ts): decode it, end cleanly on
 * `bye`, run it through `createProtocolGate`, answer a refusal, drop a stale
 * terminal, end SEQUENCE_BROKEN on a fault, and otherwise queue it for
 * `receive()`. The desktop's end runs its own gate, so a frame the desktop
 * could not send in the ledger's state throws in the script that sent it.
 *
 * What is NOT here is the socket, and that is the point: the tunnel adapter
 * never builds one (`createTunnelClient` throws in a webview), it is handed a
 * `connect`. So the socket's endings are named directly — a cut without `bye`,
 * or a close code — with the codes and sentences the real client gives them.
 *
 * Delivery is one microtask per frame, in order, and every sending method
 * resolves once its frame has been read, so a script can say "three chunks and
 * then a cut" and mean it.
 */

import type { TunnelClient, TunnelClose } from '@chatterang/tunnel/client';
import { createProtocolGate, faultMessage } from '@chatterang/tunnel/stream';
import {
  TUNNEL_WIRE_VERSION,
  decodeFrame,
  encodeFrame,
  type TunnelFrame,
} from '@chatterang/tunnel/wire';

const V = TUNNEL_WIRE_VERSION;

type TurnRequest = Extract<TunnelFrame, { readonly kind: 'turn' }>;

/** The endings a real client reports without a `bye`, with the message it gives each. */
export const ABNORMAL_ENDS = {
  PEER_GONE: 'the peer went away without a bye',
  TUNNEL_FULL: 'the other device is already holding as many connections as it allows',
  PAIRING_ONLY: 'the other device accepted this connection only to pair',
  PAIRING_WINDOW_CLOSED: 'the pairing code this connection was let in under is no longer shown',
} as const;

export type AbnormalEnd = keyof typeof ABNORMAL_ENDS;

/** The desktop's side of one turn, as a script drives it. */
export interface Desk {
  /** The `turn` frame the desktop read. */
  readonly turn: TurnRequest;
  waiting(position: number): Promise<void>;
  /** One `content` chunk, after a `start` chunk if none has gone. */
  content(text: string): Promise<void>;
  /** The `done` chunk, carrying the reply so far as its message. */
  done(finishReason?: string): Promise<void>;
  /**
   * A `done` chunk with no message, as a build from before #260 would send.
   * It goes around the desktop's gate, which refuses to send one.
   */
  doneWithoutMessage(): Promise<void>;
  /** An `error` chunk: the desktop's model or backend failed the turn. */
  errorChunk(code: string, message: string): Promise<void>;
  /** An `error` frame naming this turn, or with `connection`, naming none. */
  refuse(code: string, options?: { readonly connection?: boolean }): Promise<void>;
  prompt(id: string, action: string): Promise<void>;
  /** Number the next chunk one past where it should be: a lost frame. */
  skipSequence(): void;
  /** The socket goes away without a `bye`. */
  cut(): void;
  /** The socket closes with one of the codes the client names. */
  closeWith(code: AbnormalEnd): void;
  bye(): Promise<void>;
  /** The first frame of this kind the desktop reads for this turn. */
  next(kind: 'cancel' | 'answer'): Promise<TunnelFrame>;
}

export type DesktopScript = (desk: Desk) => Promise<void>;

export interface FakeTunnelOptions {
  /**
   * The phone's end reads frames WITHOUT its gate, as a client built without
   * one would. For the one check an adapter keeps for itself.
   */
  readonly receiveUngated?: boolean;
  /** `connect` rejects, as it does for a desktop that is not there. */
  readonly unreachable?: boolean;
}

export interface FakeTunnel {
  /** Open a new connection. Bound, so it can be handed over as it is. */
  readonly connect: () => Promise<TunnelClient>;
  /** How many connections `connect` opened. */
  readonly connections: () => number;
  /** How many times `connect` was called, including the calls that rejected. */
  readonly connectAttempts: () => number;
  /** Every frame handed to the phone end's `send`, including any its gate threw on. */
  readonly phoneSent: readonly TunnelFrame[];
  /** Every frame the desktop end read and accepted. */
  readonly desktopRead: readonly TunnelFrame[];
  /** Anything a desktop script threw: a script the gate would not let run is a broken test. */
  readonly scriptErrors: readonly unknown[];
}

export function fakeTunnel(script: DesktopScript, options: FakeTunnelOptions = {}): FakeTunnel {
  const phoneSent: TunnelFrame[] = [];
  const desktopRead: TunnelFrame[] = [];
  const scriptErrors: unknown[] = [];
  let connections = 0;
  let connectAttempts = 0;

  const open = (): TunnelClient => {
    connections += 1;
    const phoneGate = createProtocolGate();
    const deskGate = createProtocolGate();

    const inbox: TunnelFrame[] = [];
    let wake: (() => void) | null = null;
    let ended: TunnelClose | null = null;
    let deskOpen = true;
    let settle!: () => void;
    const closed = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const finish = (close: TunnelClose): void => {
      ended ??= close;
      deskOpen = false;
      wake?.();
      settle();
    };

    const waiters: { kind: string; turn: string; resolve: (frame: TunnelFrame) => void }[] = [];

    /** Bytes reach the phone. `createTunnelClient`'s message handler, without the socket. */
    const toPhone = (bytes: Uint8Array): Promise<void> =>
      new Promise((resolve) => {
        queueMicrotask(() => {
          try {
            if (ended) return;
            const frame = decodeFrame(bytes);
            if (frame.kind === 'bye') {
              finish({ kind: 'clean', reason: frame.body?.reason });
              return;
            }
            if (options.receiveUngated !== true) {
              const verdict = phoneGate.receive(frame);
              if (verdict.verdict === 'refuse') {
                void toDesk(phoneGate.send(verdict.reply));
                return;
              }
              if (verdict.verdict === 'stale') return;
              if (verdict.verdict === 'fault') {
                finish({ kind: 'abnormal', code: 'SEQUENCE_BROKEN', message: faultMessage(verdict.fault) });
                return;
              }
            }
            inbox.push(frame);
            wake?.();
          } finally {
            resolve();
          }
        });
      });

    /** Bytes reach the desktop. */
    const toDesk = (bytes: Uint8Array): Promise<void> =>
      new Promise((resolve) => {
        queueMicrotask(() => {
          try {
            if (!deskOpen) return;
            const frame = decodeFrame(bytes);
            if (frame.kind === 'bye') {
              desktopRead.push(frame);
              deskOpen = false;
              return;
            }
            const verdict = deskGate.receive(frame);
            if (verdict.verdict === 'refuse') {
              void deskSend(verdict.reply);
              return;
            }
            if (verdict.verdict !== 'accept') return;
            desktopRead.push(frame);
            if (frame.kind === 'turn') {
              void script(desk(frame)).catch((error: unknown) => scriptErrors.push(error));
              return;
            }
            if ('turn' in frame) {
              for (const waiter of waiters.splice(0)) {
                if (waiter.kind === frame.kind && waiter.turn === frame.turn) waiter.resolve(frame);
                else waiters.push(waiter);
              }
            }
          } finally {
            resolve();
          }
        });
      });

    /** The desktop sends through its gate, which throws on a frame out of its state. */
    const deskSend = async (frame: TunnelFrame): Promise<void> => {
      if (!deskOpen || ended) return;
      await toPhone(deskGate.send(frame));
    };

    const desk = (request: TurnRequest): Desk => {
      const turn = request.turn;
      let sequence = 0;
      let started = false;
      let reply = '';
      const start = async (): Promise<void> => {
        if (started) return;
        started = true;
        await deskSend({
          v: V,
          kind: 'chunk',
          turn,
          body: { type: 'start', sequence: sequence++, metadata: { requestId: `desk_${turn}`, timestamp: 0 } },
        });
      };
      return {
        turn: request,
        waiting: (position) => deskSend({ v: V, kind: 'waiting', turn, body: { position } }),
        async content(text) {
          await start();
          reply += text;
          await deskSend({ v: V, kind: 'chunk', turn, body: { type: 'content', sequence: sequence++, delta: text } });
        },
        async done(finishReason = 'stop') {
          await start();
          await deskSend({
            v: V,
            kind: 'chunk',
            turn,
            body: {
              type: 'done',
              sequence: sequence++,
              finishReason,
              message: { role: 'assistant', content: reply },
            },
          });
        },
        async doneWithoutMessage() {
          await start();
          if (!deskOpen || ended) return;
          await toPhone(
            encodeFrame({ v: V, kind: 'chunk', turn, body: { type: 'done', sequence: sequence++, finishReason: 'stop' } }),
          );
        },
        async errorChunk(code, message) {
          await start();
          await deskSend({
            v: V,
            kind: 'chunk',
            turn,
            body: { type: 'error', sequence: sequence++, error: { code, message } },
          });
        },
        refuse: (code, refusal = {}) =>
          deskSend({
            v: V,
            kind: 'error',
            ...(refusal.connection === true ? {} : { turn }),
            body: { code, message: `the desktop refused: ${code}` },
          }),
        prompt: (id, action) => deskSend({ v: V, kind: 'prompt', turn, prompt: id, body: { action } }),
        skipSequence() {
          sequence += 1;
        },
        cut() {
          finish({ kind: 'abnormal', code: 'PEER_GONE', message: ABNORMAL_ENDS.PEER_GONE });
        },
        closeWith(code) {
          finish({ kind: 'abnormal', code, message: ABNORMAL_ENDS[code] });
        },
        async bye() {
          if (!deskOpen || ended) return;
          await toPhone(encodeFrame({ v: V, kind: 'bye' }));
          deskOpen = false;
        },
        next(kind) {
          const seen = desktopRead.find((frame) => frame.kind === kind && 'turn' in frame && frame.turn === turn);
          if (seen) return Promise.resolve(seen);
          return new Promise((resolve) => waiters.push({ kind, turn, resolve }));
        },
      };
    };

    return {
      async send(frame) {
        phoneSent.push(frame);
        const bytes = phoneGate.send(frame);
        if (!ended) await toDesk(bytes);
      },
      async *receive() {
        for (;;) {
          while (inbox.length > 0) yield inbox.shift()!;
          if (ended) return;
          await new Promise<void>((resolve) => {
            wake = () => {
              wake = null;
              resolve();
            };
          });
        }
      },
      ended: () => ended,
      closed,
      async close(reason?: string) {
        if (!ended && deskOpen) {
          await toDesk(encodeFrame({ v: V, kind: 'bye', ...(reason ? { body: { reason } } : {}) }));
        }
        finish({ kind: 'clean', reason });
      },
    };
  };

  return {
    connect: async () => {
      connectAttempts += 1;
      if (options.unreachable === true) throw new Error('fake tunnel: nothing is listening');
      return open();
    },
    connections: () => connections,
    connectAttempts: () => connectAttempts,
    phoneSent,
    desktopRead,
    scriptErrors,
  };
}
