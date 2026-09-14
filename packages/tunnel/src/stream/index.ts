/**
 * THE TWO DETECTORS A STREAM HAS ONCE IT CROSSES A WIRE (#260).
 *
 * `@johnhenry/aimatey-types` on `BaseStreamChunk.sequence`, verbatim:
 *
 *   > Contiguity is the whole point. In-process an async generator cannot drop
 *   > or reorder its own yields, so `sequence` is decoration… The moment a
 *   > stream crosses a wire — a tunnel, a gateway, a relay — it is the only
 *   > loss-detection primitive the IR has, and it can only detect loss if a gap
 *   > is illegal. A consumer that observes a gap, a repeat, or a decrease has
 *   > received a stream that is not the stream that was sent, and should fail
 *   > the turn rather than render it.
 *
 * Two things follow, and #260 asked for both as separate rulings.
 *
 * TUNNEL-ONLY, DELIBERATELY. The IR says every consumer should enforce this,
 * and enforcing it everywhere is a behaviour change for every backend — an
 * in-process generator that has always been free to number its yields loosely
 * would start failing turns that were never broken. The clause itself says why
 * the tunnel is different: in one process the fault CANNOT occur, so the check
 * can only ever be decoration there and can only ever be load-bearing here.
 * Widening it later is a decision about other backends, not about this one.
 *
 * FRAME BY FRAME, NOT OVER AN ARRAY. `@johnhenry/aimatey-utils` ships
 * `validateChunkSequence`, and #260's complaint is precisely that nothing calls
 * it — but it takes the whole stream at once, and a tunnel has to fail on the
 * frame that breaks the rule rather than after rendering everything that
 * followed it. So the rules are re-expressed incrementally here, and
 * `tests/stream-guard.test.ts` holds them to the library's own verdict on the
 * same inputs. That is what stops "two consumers inventing different rules":
 * not sharing a function, but sharing an oracle.
 *
 * ── AND A THIRD: WHAT EACH TURN MAY BE SENT, AND WHEN (#7) ──────────────
 *
 * #7's frames have a state the first two detectors cannot see: a `waiting`
 * belongs before a turn streams, an `answer` belongs to a prompt that is still
 * open, an `ack` belongs after a terminal chunk. {@link createTurnLedger}
 * keeps that state per tunnel, per turn, for frames going both ways, and
 * {@link createProtocolGate} is the one place both halves run all three.
 */

import type { IRMessage } from '@johnhenry/aimatey-types';

import {
  TUNNEL_WIRE_VERSION,
  encodeFrame,
  refusalOf,
  type FrameKind,
  type PromptId,
  type TunnelFrame,
  type TurnId,
} from '../wire/index.js';

/** What a stream did wrong. Each is a reason to fail the turn, not to warn. */
export type StreamFault =
  | { readonly kind: 'gap'; readonly expected: number; readonly got: number }
  | { readonly kind: 'repeat'; readonly sequence: number }
  | { readonly kind: 'unnumbered' }
  | { readonly kind: 'terminal-without-message' };

/** A sentence for the user. The transport knows what broke; this says it. */
export function faultMessage(fault: StreamFault): string {
  switch (fault.kind) {
    case 'gap':
      return `This reply arrived incomplete: part of it did not reach this device (expected chunk ${fault.expected}, received ${fault.got}).`;
    case 'repeat':
      /*
       * REPEAT COVERS REORDERING TOO, which is why there is no separate arm
       * for a decrease. A frame numbered below the next expected one has
       * necessarily already arrived — accepted sequences are exactly
       * 0…expected-1 — so "arrived twice" and "arrived out of order" are the
       * same observation from the receiving end. `validateChunkSequence`
       * agrees: it reports 0,1,0 as a duplicate, not as a decrease.
       */
      return `This reply did not arrive as it was sent: chunk ${fault.sequence} arrived twice or out of order, so what is shown may be wrong.`;
    case 'unnumbered':
      return 'This reply arrived without the numbering that would show whether all of it got here.';
    case 'terminal-without-message':
      return 'This reply arrived without the copy that would confirm all of it got here.';
  }
}

/**
 * The body of a chunk frame, as far as this file needs to read it.
 *
 * Structural rather than the IR's own chunk union because the frame carries
 * `body: unknown` by design — see the wire module on why the chunk is a body
 * and not the frame — and because a peer on an older build can send something
 * that is not a valid chunk at all. That case is `unnumbered`, not a crash.
 */
interface ChunkBody {
  readonly type?: unknown;
  readonly sequence?: unknown;
  readonly message?: unknown;
}

const bodyOfChunk = (frame: { readonly body: unknown }): ChunkBody =>
  (typeof frame.body === 'object' && frame.body !== null ? frame.body : {}) as ChunkBody;

/** Is this frame terminal — the last one a well-behaved peer sends? */
function isTerminal(body: ChunkBody): boolean {
  return body.type === 'done' || body.type === 'error';
}

export interface SequenceGuard {
  /**
   * Check one frame. Returns the fault the FIRST time the stream breaks, and
   * null otherwise — including for every frame after a fault, because a stream
   * that has already broken cannot break again in a way that tells you more.
   */
  check(frame: TunnelFrame): StreamFault | null;
  /**
   * Has a terminal chunk arrived? For one turn when named; with no turn, for
   * every turn whose stream began here, and false if none did. A stream that
   * ends without one was cut.
   */
  sawTerminal(turn?: TurnId): boolean;
  /**
   * The next chunk of this turn continues a stream whose earlier frames went
   * to another socket (#7 ruling 4), so its number is the ORIGINAL stream's,
   * not 0, and counting starts from it. Only for a turn this guard has not
   * already counted: a stream it has seen cannot be restarted by asking.
   */
  resume(turn: TurnId): void;
  /** Stop keeping count for a turn nothing will send again. See the ledger. */
  forget(turn: TurnId): void;
}

/**
 * One stream's count PER TURN, and that is a correction.
 *
 * This counted one sequence per TUNNEL, which is exactly what the wire's own
 * header says a turn id exists to prevent: "two concurrent turns multiplexed on
 * one `sequence` counter interleave into nonsense". A second turn on the same
 * socket numbers its reply from 0 again, as an IR stream does, and was read as
 * a repeat of the first — so a phone could run one turn per connection and no
 * more. Every rung-0 stream was one turn, which is why nothing saw it.
 */
export function createSequenceGuard(): SequenceGuard {
  const streams = new Map<TurnId, { expected: number | null; terminal: boolean }>();
  let broken = false;

  return {
    sawTerminal(turn) {
      if (turn !== undefined) return streams.get(turn)?.terminal ?? false;
      if (streams.size === 0) return false;
      for (const stream of streams.values()) if (!stream.terminal) return false;
      return true;
    },
    resume(turn) {
      if (!streams.has(turn)) streams.set(turn, { expected: null, terminal: false });
    },
    forget(turn) {
      streams.delete(turn);
    },
    check(frame) {
      if (broken) return null;
      if (frame.kind !== 'chunk') return null;
      const body = bodyOfChunk(frame);

      const sequence = body.sequence;
      if (typeof sequence !== 'number' || !Number.isInteger(sequence)) {
        broken = true;
        return { kind: 'unnumbered' };
      }

      let stream = streams.get(frame.turn);
      if (!stream) {
        stream = { expected: 0, terminal: false };
        streams.set(frame.turn, stream);
      }
      // A resumed stream counts from its first frame, but never from below 0.
      const expected = stream.expected ?? Math.max(sequence, 0);

      /*
       * TWO ARMS, NOT THREE, AND THAT IS A CORRECTION.
       *
       * This began with a `backwards` arm for a frame numbered below the next
       * expected one, guarded by a `Set` of everything already accepted. Both
       * were dead: accepted sequences are exactly 0…expected-1, so `< expected`
       * and "already seen" are the same predicate and the third arm could not
       * be reached — brute-forced over every sequence of length ≤5 over 0…4,
       * 3905 cases, zero reaching it. The commit immediately before this one
       * removed an unreachable branch from both tunnel halves for the same
       * reason, and shipping a fresh one in the fix would have been comic.
       */
      if (sequence > expected) {
        broken = true;
        return { kind: 'gap', expected, got: sequence };
      }
      if (sequence < expected) {
        broken = true;
        return { kind: 'repeat', sequence };
      }

      stream.expected = sequence + 1;

      if (isTerminal(body)) {
        stream.terminal = true;
        /*
         * THE `done.message` OBLIGATION (#260), enforced where it is read.
         *
         * #148's checksum is the only detector faults 1 and 2 have, and it is
         * silent when `done.message` is absent — which the IR permits and
         * which nothing in this repo populates outside a fixture. So over a
         * tunnel the field is REQUIRED, and a peer that omits it has not sent
         * a cheaper stream, it has sent one whose loss cannot be detected.
         * `createTunnelHost` refuses to send such a chunk; this is the other
         * half, for a peer built before the rule existed.
         *
         * An `error` chunk is exempt: it carries no reply to check.
         */
        if (body.type === 'done' && !isMessage(body.message)) {
          broken = true;
          return { kind: 'terminal-without-message' };
        }
      }
      return null;
    },
  };
}

/** Is this an `IRMessage` — the shape `streamedTextOf` can actually read? */
export function isMessage(value: unknown): value is IRMessage {
  if (typeof value !== 'object' || value === null) return false;
  const content = (value as { content?: unknown }).content;
  return typeof content === 'string' || Array.isArray(content);
}

/**
 * THE OBLIGATION FROM THE SENDING SIDE (#260).
 *
 * The receiving guard above can only report that `done.message` was missing.
 * This refuses to send such a chunk at all, and the distinction is the whole
 * point of writing the rule down: #260 predicted that "the first reviewer
 * optimising bandwidth deletes it unless the requirement is written down",
 * because the field is a second full copy of the reply. A comment is not a
 * requirement. A throw is.
 *
 * Throws rather than returning a fault because this is a programming error in
 * OUR host, not a fault in someone else's peer — the two deserve different
 * treatment and the same function would blur them.
 */
export function assertSendable(frame: TunnelFrame): void {
  if (frame.kind !== 'chunk') return;
  const body = bodyOfChunk(frame);
  if (body.type !== 'done') return;
  if (!isMessage(body.message)) {
    throw new TypeError(
      'a tunnelled `done` chunk must carry `message` as an IRMessage (#260): it is the only ' +
        'detector a dropped or reordered frame has, and a stream without it cannot be checked',
    );
  }
}

/**
 * How many ENDED turns a tunnel remembers, so a late frame for one is refused.
 *
 * An ended turn is remembered only so that something arriving after its end —
 * a cancel that crossed its terminal on the wire, a second `ack`, a turn id
 * used again — is refused rather than read as a new turn. One slot means a
 * device has one turn running at a time (#7 ruling 3) and acknowledges each
 * result as it arrives, so the turns that can still draw a late frame are the
 * last few, not the last thousand. Without a bound, a paired device that kept
 * one socket open and sent turn after turn — each refused as `WAIT_LIST_FULL`,
 * each ended — would grow this table for as long as the socket lived.
 *
 * Past the bound the oldest ended turn is forgotten: a late frame for it is
 * then refused as belonging to no turn, except a `turn` or `attach` reusing
 * its id, which is read as new, and a `chunk`, which is carried as rung 0's
 * unasked-for streams are (see the ledger).
 */
export const MAX_ENDED_TURNS_REMEMBERED = 64;

/** Which way a frame is going, from this end of the tunnel. */
export type FrameDirection = 'out' | 'in';

/** A frame outside its turn's state, and why. */
export interface ProtocolViolation {
  readonly kind: FrameKind;
  readonly turn?: TurnId;
  readonly prompt?: PromptId;
  readonly reason: string;
}

/** Thrown when THIS end tries to send a frame outside its turn's state. */
export class TunnelProtocolError extends Error {
  override readonly name = 'TunnelProtocolError';
  constructor(readonly violation: ProtocolViolation) {
    super(`cannot send this ${violation.kind} frame: ${violation.reason}`);
  }
}

export interface TurnLedger {
  /**
   * Check one frame against its turn's state and, if it is allowed, record it.
   * A frame that is not allowed changes nothing and comes back as the reason.
   */
  check(frame: TunnelFrame, direction: FrameDirection): ProtocolViolation | null;
}

interface TurnState {
  /** Which end asked for the turn: sent its `turn`, or its `attach`. */
  readonly asker: FrameDirection;
  /**
   * How this tunnel came to know the turn. `unsolicited` is a `chunk` for a
   * turn nobody asked for on this tunnel — see the ledger on why it is carried.
   */
  readonly via: 'turn' | 'attach' | 'unsolicited';
  streamed: boolean;
  /** A terminal chunk has crossed, so there is something to `ack`. */
  delivered: boolean;
  ended: boolean;
  acked: boolean;
  readonly prompts: Map<PromptId, 'open' | 'answered'>;
}

const opposite = (direction: FrameDirection): FrameDirection => (direction === 'in' ? 'out' : 'in');

/**
 * WHAT EACH TURN MAY BE SENT, AND WHEN — ONE TABLE, BOTH ENDS, BOTH DIRECTIONS.
 *
 * Roles are per turn, not per half. The end that sends a turn's `turn` (or its
 * `attach`) is its ASKER; the other end RUNS it. Under #7 the phone asks and
 * the desktop runs, but nothing here says which device is which, so neither
 * half decides a question the rulings keep for the apps.
 *
 * - `turn`, `attach`: a turn id this tunnel is not already using. The sender
 *   becomes the asker.
 * - `cancel`: the asker, while the turn is open.
 * - `waiting`: the runner, for a turn that was asked for, before its first
 *   chunk.
 * - `prompt`: the runner, while the turn is open, with a prompt id this turn
 *   has not used — so a late answer can never land on a reused id.
 * - `answer`: the asker, to a prompt that is open.
 * - `chunk`: the runner, while the turn is open. A turn that arrived by
 *   `attach` is sent one chunk only, its terminal (resuming mid-stream is
 *   #162's later option). A terminal chunk ends the turn.
 * - `ack`: the asker, once, after a terminal chunk.
 * - `error`: always carried. From a turn's runner it can close one prompt
 *   (its `prompt` field) and, if its code ends turns (see `REFUSALS`), end the
 *   turn — or, naming no turn, every turn that end is running.
 *
 * ONE EXCEPTION, CARRIED FOR NOW: a `chunk` for a turn this tunnel has no
 * record of is still carried, and opens that turn with the receiver as its
 * asker. Rung 0 streams a reply as a greeting nobody asked for, and #156's
 * and #158's tests stream up the wire the same way; refusing it is a change to
 * what those tests mean, which is its own change, not a side effect of this
 * one. It cannot be used to reach a prompt: `waiting` and `prompt` need a turn
 * that was actually asked for.
 */
export function createTurnLedger(
  options: { readonly onForget?: (turn: TurnId) => void } = {},
): TurnLedger {
  const turns = new Map<TurnId, TurnState>();
  /** Ended turns still remembered, oldest first. */
  const ended: TurnId[] = [];

  const end = (turn: TurnId, state: TurnState): void => {
    if (state.ended) return;
    state.ended = true;
    // Nothing can be asked or answered in a turn that is over.
    state.prompts.clear();
    ended.push(turn);
    while (ended.length > MAX_ENDED_TURNS_REMEMBERED) {
      const oldest = ended.shift()!;
      turns.delete(oldest);
      options.onForget?.(oldest);
    }
  };

  const open = (asker: FrameDirection, via: TurnState['via']): TurnState => ({
    asker,
    via,
    streamed: false,
    delivered: false,
    ended: false,
    acked: false,
    prompts: new Map(),
  });

  return {
    check(frame, direction) {
      const refuse = (reason: string): ProtocolViolation => ({
        kind: frame.kind,
        ...('turn' in frame && frame.turn !== undefined ? { turn: frame.turn } : {}),
        ...('prompt' in frame && frame.prompt !== undefined ? { prompt: frame.prompt } : {}),
        reason,
      });

      switch (frame.kind) {
        case 'hello':
        case 'ping':
        case 'pong':
        case 'bye':
        case 'pair':
          return null;

        case 'error': {
          const refusal = refusalOf(frame.body.code);
          if (frame.turn === undefined) {
            if (!refusal.endsTurn) return null;
            for (const [turn, state] of [...turns]) {
              if (state.asker !== direction) end(turn, state);
            }
            return null;
          }
          const state = turns.get(frame.turn);
          // From the asker, or about a turn that is over or unknown: a report,
          // carried as it came, that changes nothing here.
          if (!state || state.ended || state.asker === direction) return null;
          if (frame.prompt !== undefined && state.prompts.get(frame.prompt) === 'open') {
            state.prompts.set(frame.prompt, 'answered');
          }
          if (refusal.endsTurn) end(frame.turn, state);
          return null;
        }

        case 'turn':
        case 'attach': {
          if (turns.has(frame.turn)) {
            return refuse(
              frame.kind === 'turn'
                ? 'that turn id is already in use on this tunnel'
                : 'that turn is already attached or running on this tunnel',
            );
          }
          turns.set(frame.turn, open(direction, frame.kind === 'turn' ? 'turn' : 'attach'));
          return null;
        }

        case 'cancel': {
          const state = turns.get(frame.turn);
          if (!state) return refuse('no turn with that id is on this tunnel');
          if (state.asker !== direction) return refuse('only the end that asked for a turn may cancel it');
          if (state.ended) return refuse('that turn has already ended');
          return null;
        }

        case 'chunk': {
          const known = turns.get(frame.turn);
          const state = known ?? open(opposite(direction), 'unsolicited');
          if (state.asker === direction) {
            return refuse('the end that asked for a turn does not stream its reply');
          }
          if (state.ended) return refuse('that turn has already ended');
          const terminal = isTerminal(bodyOfChunk(frame));
          if (state.via === 'attach' && !terminal) {
            return refuse('an attached turn is sent its terminal chunk and nothing else');
          }
          if (!known) turns.set(frame.turn, state);
          state.streamed = true;
          if (terminal) {
            state.delivered = true;
            end(frame.turn, state);
          }
          return null;
        }

        case 'waiting':
        case 'prompt': {
          const state = turns.get(frame.turn);
          if (!state || state.via === 'unsolicited') return refuse('nobody asked for that turn on this tunnel');
          if (state.asker === direction) return refuse('only the end running a turn says it is waiting or asks a question');
          if (state.ended) return refuse('that turn has already ended');
          if (frame.kind === 'waiting') {
            if (state.streamed) return refuse('that turn is already streaming, so it is not waiting');
            return null;
          }
          if (state.prompts.has(frame.prompt)) return refuse('that prompt id was already used in this turn');
          state.prompts.set(frame.prompt, 'open');
          return null;
        }

        case 'answer': {
          const state = turns.get(frame.turn);
          if (!state) return refuse('no turn with that id is on this tunnel');
          if (state.asker !== direction) return refuse('only the end that asked for a turn answers its prompts');
          if (state.ended) return refuse('that turn has already ended');
          if (state.prompts.get(frame.prompt) !== 'open') {
            return refuse('no prompt with that id is waiting for an answer in this turn');
          }
          state.prompts.set(frame.prompt, 'answered');
          return null;
        }

        case 'ack': {
          const state = turns.get(frame.turn);
          if (!state) return refuse('no turn with that id is on this tunnel');
          if (state.asker !== direction) return refuse('only the end that asked for a turn acknowledges its result');
          if (!state.delivered) return refuse('nothing has been delivered for that turn to acknowledge');
          if (state.acked) return refuse('that turn was already acknowledged');
          state.acked = true;
          return null;
        }
      }
    },
  };
}

export type InboundVerdict =
  /** Carry it: hand the frame to whoever reads this tunnel. */
  | { readonly verdict: 'accept' }
  /**
   * Drop it unread and send `reply`: the frame is outside its turn's state,
   * and the far side is told which frame went nowhere. The tunnel stays open —
   * the commonest cause is a race, such as an answer crossing its prompt's
   * expiry on the wire, and a race is not a broken peer.
   */
  | { readonly verdict: 'refuse'; readonly violation: ProtocolViolation; readonly reply: TunnelFrame }
  /** The stream is not the stream that was sent: fail the tunnel (#260). */
  | { readonly verdict: 'fault'; readonly fault: StreamFault };

export interface ProtocolGate {
  /**
   * The bytes to write for a frame this end is sending — or a throw, because a
   * frame this end may not send is this end's bug: a `TypeError` for #260's
   * obligation, a `TunnelWireError` for a frame the far end could not read back
   * as written, and a {@link TunnelProtocolError} for one outside its turn's
   * state. Nothing is recorded for a frame that throws.
   */
  send(frame: TunnelFrame): Uint8Array;
  /** A decoded frame from the peer, other than `bye`. */
  receive(frame: TunnelFrame): InboundVerdict;
}

/**
 * All three checks, in the one order both halves need them.
 *
 * Inbound, the ledger runs before the sequence guard, so a frame refused for
 * its state is never counted: a chunk arriving after its turn's terminal is
 * a frame out of place, not a break in a stream that already finished.
 */
export function createProtocolGate(): ProtocolGate {
  const guard = createSequenceGuard();
  const ledger = createTurnLedger({ onForget: (turn) => guard.forget(turn) });

  return {
    send(frame) {
      assertSendable(frame);
      const bytes = encodeFrame(frame);
      const violation = ledger.check(frame, 'out');
      if (violation) throw new TunnelProtocolError(violation);
      if (frame.kind === 'attach') guard.resume(frame.turn);
      return bytes;
    },
    receive(frame) {
      const violation = ledger.check(frame, 'in');
      if (violation) {
        return {
          verdict: 'refuse',
          violation,
          reply: {
            v: TUNNEL_WIRE_VERSION,
            kind: 'error',
            ...(violation.turn === undefined ? {} : { turn: violation.turn }),
            ...(violation.turn !== undefined && violation.prompt !== undefined
              ? { prompt: violation.prompt }
              : {}),
            body: {
              code: 'FRAME_UNEXPECTED',
              message: `this ${violation.kind} frame was not read: ${violation.reason}`,
            },
          },
        };
      }
      const fault = guard.check(frame);
      if (fault) return { verdict: 'fault', fault };
      return { verdict: 'accept' };
    },
  };
}
