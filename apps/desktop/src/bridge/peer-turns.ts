/**
 * S7: the desktop-side handler that reads a `turn` frame off a tunnel and
 * runs it — the piece #296 says is missing. "The host half is banned from
 * the phone bundle" (`tests/layering.test.ts`'s `DESKTOP_LAYER_BAN`), which is
 * why this lives here rather than in `src/`, and why it is started by
 * whichever app starts the listener (#158) rather than starting one itself:
 * nothing here binds a socket.
 *
 * WHAT EXISTED BEFORE THIS FILE, AND WHAT IT CONNECTS. `WorkBroker`
 * (`work-broker.ts`) already has a `device` `Owner`, `attachDevice`/
 * `detachDevice`/`ack`/`revokeDevice`, and an `OwnerChannel` it documents as
 * "the listener supplies it" — built, and called by nothing but tests, before
 * this file. `WorkerHost` (`worker-host.ts`) already runs one phone unit at a
 * time on a hidden worker and resolves with its encoded end frame or a named
 * failure — also built, also called by nothing but tests. `packages/tunnel`
 * already has the wire, the codec's per-field policy, and the sequence-guarded
 * protocol gate a `Tunnel` sends and receives through. This file is the glue:
 * for each tunnel a listener hands out, decode its `turn` frames, decide
 * whether this build will run them, and if so admit them to the broker and
 * relay the worker's frames back — nothing here duplicates any of the above.
 *
 * WHAT THIS BUILD RUNS, AND WHAT IT REFUSES. `toolLoopOf(frame)` must read
 * `'requester'` — "the host serves inference only, and its reply ends at the
 * model's tool calls" (`packages/tunnel/src/wire/index.ts`) — or the turn is
 * refused `TOOL_LOOP_UNSUPPORTED` before it is admitted anywhere. That is the
 * only value the one real client sends today (`src/ai/backends/tunnel.ts`:
 * "THE TOOL LOOP STAYS ON THIS PHONE"), so nothing here needs to decide #170's
 * still-OPEN question of which of the desktop's own tools a tunnelled turn may
 * reach: under `'requester'` none of them run on the desktop at all, and
 * `toolLoop: 'host'` — the value that WOULD reach them — is refused before it
 * is anything but a `TunnelFrame`. Refusing rather than guessing is the wire's
 * own fail-closed rule for this field (`toolLoopOf`'s doc).
 *
 * THE CLEARING GATE (#145) AND `metadata.custom` (#141) ARE RE-DECIDED HERE,
 * ONCE, BEFORE A TURN EVER REACHES THE WORKER. `ClearedMessage`'s brand is
 * type-level and JSON erases it (`src/ai/taint.ts`), so a request that arrived
 * over the wire carries none of it — `clearForDestination` runs again, marking
 * this a local destination (the reply never leaves the machine under
 * `toolLoop: 'requester'`, since the desktop is inference only). `metadata.
 * custom` is a routing escape hatch this file never reads for routing — every
 * admitted turn runs on the same worker the same way — but it is still
 * stripped before the request crosses into the worker, so nothing downstream
 * can be steered by a field the wire's own header says a peer may never use
 * for that (`#141`).
 */

import type { IRChatRequest, IRMessage } from '@johnhenry/aimatey-types';

import type { Tunnel, TunnelListener } from '@chatterang/tunnel/host';
import {
  decodeFrame,
  encodeFrame,
  toolLoopOf,
  type RefusalCode,
  type RelayedPrompt,
  type TunnelFrame,
} from '@chatterang/tunnel/wire';

import { clearForDestination } from '@/ai/taint';

import type { BrokerNotice, Owner, OwnerChannel, UnitTerminal, WorkBroker } from './work-broker.js';
import { WORKER_EXECUTOR, type WorkerHost } from './worker-host.js';

export interface PeerTurnsOptions {
  readonly broker: WorkBroker;
  readonly workerHost: WorkerHost;
  /** Anomalies. Never a prompt, never a turn's text. */
  readonly warn?: (message: string) => void;
}

/** Send an `error` CONTROL frame naming `turn`, for one of `REFUSALS`' own codes. */
function refusalFrame(turn: string, code: RefusalCode): TunnelFrame {
  return { v: 1, kind: 'error', turn, body: { code, message: REFUSAL_MESSAGES[code] } };
}

const REFUSAL_MESSAGES: Readonly<Record<RefusalCode, string>> = {
  WAIT_LIST_FULL: 'Too many turns are waiting for the model on this computer. Try again shortly.',
  DESKTOP_QUITTING: 'The desktop app is quitting, so this turn cannot run.',
  HOST_SUSPENDED: 'The computer is going to sleep, so this turn cannot run.',
  HOST_DOES_NOT_RUN_TURNS: 'This host does not run a paired device’s turns.',
  TOOL_LOOP_UNSUPPORTED: 'This desktop only runs a turn whose tool loop stays with the device that sent it.',
  PROMPT_EXPIRED: 'That question was not answered in time.',
  RESULT_UNKNOWN: 'Nothing is held here for that turn.',
  FRAME_UNEXPECTED: 'That frame was not read.',
};

/** A `chunk` frame carrying a stream-level error, exempt from the #260 `message` obligation. */
function errorChunk(turn: string, sequence: number, code: string, message: string): TunnelFrame {
  return { v: 1, kind: 'chunk', turn, body: { type: 'error', sequence, error: { code, message } } };
}

/** Is this a plausible enough `IRChatRequest` to run — has messages to clear and run? */
function isChatRequest(value: unknown): value is IRChatRequest {
  return (
    typeof value === 'object' &&
    value !== null &&
    Array.isArray((value as { messages?: unknown }).messages)
  );
}

/**
 * The taint-clearing note for a tunnelled turn's withheld tool output.
 *
 * Mirrors the shape `src/ai/engine.ts` builds locally; kept here rather than
 * imported so this file does not reach into the engine for one string.
 */
function withheldNote(characters: number): string {
  return `[${String(characters)} characters of tool output were withheld]`;
}

/**
 * Re-run the clearing gate (#145) and strip `metadata.custom` (#141) before a
 * request crosses into the worker.
 *
 * `local: true` and `allowed: true`: the reply never leaves this machine
 * under `toolLoop: 'requester'` (the desktop is inference only, and the
 * device that asked keeps the tool loop and any output it produces), so this
 * is exactly the destination `clearForDestination` calls local.
 *
 * `metadata.custom` is dropped rather than merely ignored: this file never
 * reads it for routing (every admitted turn runs the same way, on the same
 * worker), but a field left in place could still be echoed back by something
 * downstream that does not know its provenance. Gone is the only value #141
 * needs to hold for.
 */
function prepareRequest(request: IRChatRequest): IRChatRequest {
  const cleared = clearForDestination(request.messages, {
    allowed: true,
    local: true,
    note: withheldNote,
  }) as unknown as readonly IRMessage[];
  if (request.metadata.custom === undefined) {
    return { ...request, messages: cleared };
  }
  const { custom: _custom, ...restMetadata } = request.metadata;
  return { ...request, messages: cleared, metadata: restMetadata };
}

/**
 * One connected device tunnel's turns, admitted to the broker and run on the
 * worker host. Call once per tunnel a listener hands out.
 */
export function wireDeviceTunnel(tunnel: Tunnel, options: PeerTurnsOptions): void {
  const { broker, workerHost } = options;
  const warn = options.warn ?? ((): void => undefined);
  if (tunnel.admission.kind !== 'device') {
    // A pairing tunnel may carry only the pairing exchange (`packages/tunnel/
    // src/host/index.ts`'s own PAIRING_KINDS rule) and never reaches `turn` —
    // this function has nothing to do for one.
    return;
  }
  const deviceId = tunnel.admission.deviceId;
  const owner: Owner = { kind: 'device', id: deviceId };

  /** The last sequence number this tunnel has streamed for a turn, for a synthesised terminal's own number. */
  const lastSequence = new Map<string, number>();

  const send = (frame: TunnelFrame): void => {
    void tunnel.send(frame).catch((error: unknown) => {
      warn(`peer-turns: could not send a ${frame.kind} frame: ${errorKind(error)}.`);
    });
  };

  const channel: OwnerChannel = {
    send(notice: BrokerNotice): boolean {
      switch (notice.kind) {
        case 'waiting':
          send({ v: 1, kind: 'waiting', turn: notice.unitId, body: { position: notice.position } });
          return true;
        case 'started':
          // No wire frame of its own (#7's vocabulary has none for it): the
          // device already knows it started the moment `waiting` stops or its
          // first chunk arrives.
          return true;
        case 'prompt':
          // Dead today: nothing in this file calls `broker.requestPrompt` for
          // a device owner, since `toolLoop: 'requester'` never runs a tool on
          // this desktop to raise one. Kept so `BrokerNotice`'s vocabulary is
          // handled in full, for whichever of #152's loops relays one first.
          send({
            v: 1,
            kind: 'prompt',
            turn: notice.unitId,
            prompt: notice.promptId,
            body: notice.prompt as RelayedPrompt,
          });
          return true;
        case 'terminal':
          deliverTerminal(notice.terminal);
          return true;
      }
    },
    close(reason): void {
      void tunnel.close(reason === 'SOCKET_REPLACED' ? 'replaced' : 'revoked');
    },
  };

  /**
   * The unit's one terminal, from the broker (`#deliverTerminal`), turned into
   * the wire frame the phone actually sees — on the turn that finishes it, AND
   * again on every reconnect until it is `ack`'d (ruling 4).
   */
  function deliverTerminal(terminal: UnitTerminal): void {
    const turn = terminal.unitId;
    switch (terminal.end) {
      case 'COMPLETED': {
        const result = terminal.value as { kind: 'ended'; frame: Uint8Array } | { kind: 'failed'; code: string; message: string };
        if (result.kind === 'ended') {
          try {
            const decoded = decodeFrame(result.frame);
            if (decoded.kind === 'chunk' && decoded.turn === turn) {
              send(decoded);
              return;
            }
            warn(`peer-turns: the worker's terminal for ${turn} was not that turn's chunk.`);
          } catch (error) {
            warn(`peer-turns: could not decode the worker's terminal for ${turn}: ${errorKind(error)}.`);
          }
          send(errorChunk(turn, nextSequence(turn), 'PEER_TURN_FAILED', 'The worker’s reply could not be read.'));
          return;
        }
        send(errorChunk(turn, nextSequence(turn), result.code, result.message));
        return;
      }
      case 'FAILED': {
        const message = terminal.error instanceof Error ? terminal.error.message : 'The turn failed.';
        send(errorChunk(turn, nextSequence(turn), 'PEER_TURN_FAILED', message));
        return;
      }
      case 'CANCELLED':
        // Only reachable while the unit was still WAITING: nothing ever
        // streamed, so there is no worker terminal to relay.
        send(errorChunk(turn, 0, 'CANCELLED', 'The turn was cancelled before it started.'));
        return;
      case 'WORKER_LOST':
        send(errorChunk(turn, nextSequence(turn), 'WORKER_LOST', 'The worker running this turn stopped.'));
        return;
      case 'DEADLINE':
        send(errorChunk(turn, nextSequence(turn), 'DEADLINE', 'The turn produced nothing for too long.'));
        return;
      case 'HOST_SUSPENDED':
        send(refusalFrame(turn, 'HOST_SUSPENDED'));
        return;
      case 'DESKTOP_QUITTING':
        send(refusalFrame(turn, 'DESKTOP_QUITTING'));
        return;
      case 'OWNER_LOST':
        // Windows only (`work-broker.ts`); a device's unit never ends this way.
        return;
      case 'OWNER_REVOKED':
        // The broker already delivers nothing for this end (`#deliverTerminal`
        // returns before calling `#deliver`), so this is never actually seen.
        return;
    }
  }

  function nextSequence(turn: string): number {
    const next = (lastSequence.get(turn) ?? -1) + 1;
    return next;
  }

  const relay = (turn: string) =>
    (encodedChunk: Uint8Array): void => {
      let decoded: TunnelFrame;
      try {
        decoded = decodeFrame(encodedChunk);
      } catch (error) {
        warn(`peer-turns: the worker sent an unreadable frame for ${turn}: ${errorKind(error)}.`);
        return;
      }
      if (decoded.kind !== 'chunk' || decoded.turn !== turn) return;
      const body = decoded.body as { readonly type?: unknown; readonly sequence?: unknown };
      if (typeof body.sequence === 'number') lastSequence.set(turn, body.sequence);
      // The TERMINAL chunk (done/error) is sent once, from `deliverTerminal`
      // above, using the identical bytes the worker resolved `run()` with —
      // not from here, or the ledger would see two terminals for one turn.
      if (body.type === 'done' || body.type === 'error') return;
      send(decoded);
    };

  async function handleTurn(frame: Extract<TunnelFrame, { kind: 'turn' }>): Promise<void> {
    const loop = toolLoopOf(frame);
    if (loop !== 'requester') {
      send(refusalFrame(frame.turn, 'TOOL_LOOP_UNSUPPORTED'));
      return;
    }
    if (!isChatRequest(frame.body)) {
      send(errorChunk(frame.turn, 0, 'PEER_TURN_FAILED', 'This turn could not be read.'));
      return;
    }

    let prepared: IRChatRequest;
    try {
      prepared = prepareRequest(frame.body);
    } catch (error) {
      send(errorChunk(frame.turn, 0, 'PEER_TURN_FAILED', errorKind(error)));
      return;
    }

    const encodedTurn = encodeFrame({ v: 1, kind: 'turn', turn: frame.turn, toolLoop: 'requester', body: prepared });
    const admission = broker.admit({
      owner,
      unitId: frame.turn,
      executor: WORKER_EXECUTOR,
      start: (signal) => workerHost.run({ owner, unitId: frame.turn }, encodedTurn, signal, relay(frame.turn)),
    });
    if (!admission.admitted) {
      switch (admission.refusal) {
        case 'WAIT_LIST_FULL':
        case 'OWNER_WAIT_LIST_FULL':
        case 'SLOT_BUSY':
        case 'DUPLICATE_UNIT':
          send(refusalFrame(frame.turn, 'WAIT_LIST_FULL'));
          return;
        case 'HOST_SUSPENDED':
          send(refusalFrame(frame.turn, 'HOST_SUSPENDED'));
          return;
        case 'DESKTOP_QUITTING':
          send(refusalFrame(frame.turn, 'DESKTOP_QUITTING'));
          return;
        case 'OWNER_REVOKED':
          // The tunnel is already being closed by `attachDevice`'s own
          // refusal below in this case; nothing more to answer here.
          return;
      }
    }
  }

  if (!broker.attachDevice(deviceId, channel)) {
    void tunnel.close('revoked');
    return;
  }
  void tunnel.closed.then(() => broker.detachDevice(deviceId, channel));

  void (async () => {
    for await (const frame of tunnel.receive()) {
      switch (frame.kind) {
        case 'turn':
          void handleTurn(frame).catch((error: unknown) => {
            warn(`peer-turns: handling a turn threw: ${errorKind(error)}.`);
          });
          break;
        case 'cancel':
          broker.cancel(owner, frame.turn);
          break;
        case 'answer':
          broker.answerPrompt(owner, frame.turn, frame.prompt, frame.body.approved);
          break;
        case 'attach':
          if (!broker.heldFor(deviceId).includes(frame.turn)) {
            send({ v: 1, kind: 'error', turn: frame.turn, body: { code: 'RESULT_UNKNOWN', message: REFUSAL_MESSAGES.RESULT_UNKNOWN } });
          }
          // Held: `attachDevice`'s own connect-time replay (below) already
          // sent it, and every held result for this device is re-sent again
          // whenever its channel is (re)attached — this frame asked for
          // exactly what already went out.
          break;
        case 'ack':
          broker.ack(deviceId, frame.turn);
          break;
        default:
          // `waiting`/`prompt` are the RUNNER's to send, never the asker's, and
          // the tunnel's own protocol gate refuses one from the peer before it
          // ever reaches `receive()` (`createTurnLedger`). Every other kind is
          // connection-level and the host layer already handled it.
          break;
      }
    }
  })().catch((error: unknown) => {
    warn(`peer-turns: reading this tunnel ended unexpectedly: ${errorKind(error)}.`);
  });
}

/** An error's class name or message, for a warning that must never carry a turn's text. */
function errorKind(error: unknown): string {
  return error instanceof Error ? error.name || error.message : typeof error;
}

/**
 * Wire every tunnel a listener hands out, for as long as the listener runs.
 *
 * The one function #158 needs: nothing here binds a socket or decides where
 * one listens, so this is the whole of what "started by whichever app starts
 * the listener" (#296) asks this file to be ready for. Not called by
 * `main.ts` today — no app starts a tunnel listener yet (#158) — so this
 * exists ready for the day one does, exercised directly by this file's own
 * tests in the meantime.
 */
export async function wirePeerTunnels(listener: TunnelListener, options: PeerTurnsOptions): Promise<void> {
  for await (const tunnel of listener.tunnels()) {
    wireDeviceTunnel(tunnel, options);
  }
}
