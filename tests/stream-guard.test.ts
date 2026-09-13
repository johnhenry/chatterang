// @vitest-environment node
import { validateChunkSequence } from '@johnhenry/aimatey-utils';
import type { IRStreamChunk } from '@johnhenry/aimatey-types';
import { describe, expect, it } from 'vitest';

import { createSequenceGuard, faultMessage, isMessage } from '@chatterang/tunnel/stream';
import { TUNNEL_WIRE_VERSION, type TunnelFrame } from '@chatterang/tunnel/wire';

/**
 * THE ORACLE TEST (#260).
 *
 * The guard re-expresses `validateChunkSequence`'s rules incrementally,
 * because a tunnel has to fail on the frame that breaks the rule rather than
 * after rendering everything that followed it. Re-expressing a rule is how two
 * consumers come to disagree, so the rules are not merely COPIED from the
 * library — they are checked against it, on every sequence short enough to
 * enumerate.
 *
 * If a future version of `@johnhenry/aimatey-utils` changes what counts as a
 * broken stream, this fails here rather than in a tunnel on someone's desk.
 */

const frameOf = (sequence: unknown, type = 'content'): TunnelFrame => ({
  v: TUNNEL_WIRE_VERSION,
  kind: 'chunk',
  turn: 't1',
  body: { type, sequence, delta: 'x' },
});

/** Run the whole sequence through a fresh guard; did it break? */
function guardRejects(sequences: readonly number[]): boolean {
  const guard = createSequenceGuard();
  return sequences.some((sequence) => guard.check(frameOf(sequence)) !== null);
}

function libraryRejects(sequences: readonly number[]): boolean {
  const chunks = sequences.map(
    (sequence) => ({ type: 'content', sequence, delta: 'x' }) as unknown as IRStreamChunk,
  );
  return !validateChunkSequence(chunks).valid;
}

/** Every sequence of length 1..4 over 0..4. 780 cases, all enumerated. */
function* allSequences(): Generator<number[]> {
  const VALUES = [0, 1, 2, 3, 4];
  for (let length = 1; length <= 4; length += 1) {
    const indices = new Array<number>(length).fill(0);
    for (;;) {
      yield indices.map((i) => VALUES[i]!);
      let position = length - 1;
      while (position >= 0 && indices[position] === VALUES.length - 1) {
        indices[position] = 0;
        position -= 1;
      }
      if (position < 0) break;
      indices[position]! += 1;
    }
  }
}

describe('the guard agrees with the IR’s own validator', () => {
  it('on every sequence of length 1 to 4 over 0 to 4', () => {
    const disagreements: string[] = [];
    let cases = 0;
    let rejected = 0;
    for (const sequences of allSequences()) {
      cases += 1;
      const mine = guardRejects(sequences);
      if (mine) rejected += 1;
      if (mine !== libraryRejects(sequences)) {
        disagreements.push(`[${sequences.join(',')}] guard=${mine} library=${!mine}`);
      }
    }
    expect(cases).toBe(780);
    // A test that enumerated 780 cases and rejected none would agree with a
    // guard that never fires. Most of these sequences are broken.
    expect(rejected).toBeGreaterThan(700);
    expect(disagreements).toEqual([]);
  });
});

describe('the guard reports WHICH fault, which the library does not', () => {
  it('names a gap, and stops at the frame that broke the stream', () => {
    const guard = createSequenceGuard();
    expect(guard.check(frameOf(0))).toBeNull();
    expect(guard.check(frameOf(1))).toBeNull();
    expect(guard.check(frameOf(3))).toEqual({ kind: 'gap', expected: 2, got: 3 });
    // Silent afterwards: a stream that has already broken cannot break again
    // in a way that tells the user anything more.
    expect(guard.check(frameOf(4))).toBeNull();
  });

  it('names a repeat', () => {
    const guard = createSequenceGuard();
    guard.check(frameOf(0));
    guard.check(frameOf(1));
    expect(guard.check(frameOf(1))).toEqual({ kind: 'repeat', sequence: 1 });
  });

  it('reports a frame that arrived out of order as a repeat, like the library', () => {
    /*
     * There is no separate `backwards` fault, because there cannot be one: a
     * number below the next expected one has necessarily already arrived. The
     * library says the same — it calls 0,1,0 a duplicate — and an arm no input
     * can reach is a claim the reader cannot trust.
     */
    const guard = createSequenceGuard();
    guard.check(frameOf(0));
    guard.check(frameOf(1));
    guard.check(frameOf(2));
    expect(guard.check(frameOf(1))).toEqual({ kind: 'repeat', sequence: 1 });
    expect(validateChunkSequence(
      [0, 1, 2, 1].map((sequence) => ({ type: 'content', sequence, delta: 'x' }) as unknown as IRStreamChunk),
    ).duplicates).toEqual([1]);
  });

  it('refuses a stream that never started at zero', () => {
    expect(createSequenceGuard().check(frameOf(1))).toEqual({ kind: 'gap', expected: 0, got: 1 });
  });

  it('refuses a chunk with no sequence at all', () => {
    expect(createSequenceGuard().check(frameOf(undefined))).toEqual({ kind: 'unnumbered' });
    expect(createSequenceGuard().check(frameOf('2'))).toEqual({ kind: 'unnumbered' });
    expect(createSequenceGuard().check(frameOf(1.5))).toEqual({ kind: 'unnumbered' });
  });

  it('ignores control frames, which carry no sequence and never could', () => {
    const guard = createSequenceGuard();
    expect(guard.check({ v: TUNNEL_WIRE_VERSION, kind: 'ping' })).toBeNull();
    expect(guard.check({ v: TUNNEL_WIRE_VERSION, kind: 'bye' })).toBeNull();
    // And the stream is still intact afterwards.
    expect(guard.check(frameOf(0))).toBeNull();
  });
});

describe('the done.message obligation (#260)', () => {
  const doneFrame = (sequence: number, message?: unknown): TunnelFrame => ({
    v: TUNNEL_WIRE_VERSION,
    kind: 'chunk',
    turn: 't1',
    body: { type: 'done', sequence, finishReason: 'stop', message },
  });

  it('refuses a done chunk with no message', () => {
    const guard = createSequenceGuard();
    guard.check(frameOf(0));
    expect(guard.check(doneFrame(1))).toEqual({ kind: 'terminal-without-message' });
  });

  it('refuses a done chunk whose message is not an IRMessage', () => {
    /*
     * THE FIXTURE BUG THIS RULE EXISTS TO CATCH. `StreamDoneChunk.message` is
     * an `IRMessage`, not a string — and `streamedTextOf` reads `.content`,
     * so a bare string reaches `.map` on `undefined` and throws. A fixture
     * that sends a string passes any test that compares strings itself and
     * crashes the detector the app actually ships.
     */
    const guard = createSequenceGuard();
    guard.check(frameOf(0));
    expect(guard.check(doneFrame(1, 'the quick brown fox'))).toEqual({
      kind: 'terminal-without-message',
    });
  });

  it('accepts a real IRMessage, string content or blocks', () => {
    const plain = createSequenceGuard();
    plain.check(frameOf(0));
    expect(plain.check(doneFrame(1, { role: 'assistant', content: 'hello' }))).toBeNull();
    expect(plain.sawTerminal()).toBe(true);

    const blocks = createSequenceGuard();
    blocks.check(frameOf(0));
    expect(
      blocks.check(doneFrame(1, { role: 'assistant', content: [{ type: 'text', text: 'hi' }] })),
    ).toBeNull();
  });

  it('exempts an error chunk, which carries no reply to check', () => {
    const guard = createSequenceGuard();
    guard.check(frameOf(0));
    expect(
      guard.check({
        v: TUNNEL_WIRE_VERSION,
        kind: 'chunk',
        turn: 't1',
        body: { type: 'error', sequence: 1, error: { code: 'X', message: 'y' } },
      }),
    ).toBeNull();
    expect(guard.sawTerminal()).toBe(true);
  });

  it('knows a stream that never reached a terminal chunk', () => {
    const guard = createSequenceGuard();
    guard.check(frameOf(0));
    guard.check(frameOf(1));
    expect(guard.sawTerminal()).toBe(false);
  });
});

describe('isMessage', () => {
  it('accepts what streamedTextOf can read and rejects what it cannot', () => {
    expect(isMessage({ role: 'assistant', content: 'x' })).toBe(true);
    expect(isMessage({ role: 'assistant', content: [] })).toBe(true);
    expect(isMessage('x')).toBe(false);
    expect(isMessage(null)).toBe(false);
    expect(isMessage(undefined)).toBe(false);
    expect(isMessage({ role: 'assistant' })).toBe(false);
    expect(isMessage({ content: 42 })).toBe(false);
  });
});

describe('every fault has a sentence', () => {
  it('and none of them blames the model', () => {
    const faults = [
      { kind: 'gap', expected: 2, got: 3 },
      { kind: 'repeat', sequence: 1 },
      { kind: 'unnumbered' },
      { kind: 'terminal-without-message' },
    ] as const;
    for (const fault of faults) {
      const sentence = faultMessage(fault);
      expect(sentence.length).toBeGreaterThan(20);
      // #148's argument: "the user currently reads a scrambled reply as the
      // MODEL failing. It is the transport, and blaming the wrong component is
      // the actual defect."
      expect(sentence.toLowerCase()).not.toContain('model');
    }
  });
});
