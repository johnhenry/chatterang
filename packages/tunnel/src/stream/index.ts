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
 */

import type { IRMessage } from '@johnhenry/aimatey-types';

import type { TunnelFrame } from '../wire/index.js';

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
  /** Has a terminal chunk arrived? A stream that ends without one was cut. */
  sawTerminal(): boolean;
}

export function createSequenceGuard(): SequenceGuard {
  let expected = 0;
  let broken = false;
  let terminal = false;

  return {
    sawTerminal: () => terminal,
    check(frame) {
      if (broken) return null;
      if (frame.kind !== 'chunk') return null;
      const body = (frame.body ?? {}) as ChunkBody;

      const sequence = body.sequence;
      if (typeof sequence !== 'number' || !Number.isInteger(sequence)) {
        broken = true;
        return { kind: 'unnumbered' };
      }

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

      expected = sequence + 1;

      if (isTerminal(body)) {
        terminal = true;
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
  const body = (frame.body ?? {}) as ChunkBody;
  if (body.type !== 'done') return;
  if (!isMessage(body.message)) {
    throw new TypeError(
      'a tunnelled `done` chunk must carry `message` as an IRMessage (#260): it is the only ' +
        'detector a dropped or reordered frame has, and a stream without it cannot be checked',
    );
  }
}
