import { describe, expect, it } from 'vitest';

import {
  MAX_ENDED_TURNS_REMEMBERED,
  MAX_OPEN_TURNS,
  TunnelProtocolError,
  createProtocolGate,
  createTurnLedger,
} from '@chatterang/tunnel/stream';
import {
  TUNNEL_WIRE_VERSION,
  TunnelWireError,
  decodeFrame,
  type TunnelFrame,
} from '@chatterang/tunnel/wire';

/**
 * WHAT EACH TURN MAY BE SENT, AND WHEN (#7).
 *
 * #7's frames are only meaningful in order: a `waiting` before the reply
 * streams, an `answer` to a prompt that is still open, an `ack` after a
 * terminal chunk, one `attach` per turn per socket. `createTurnLedger` keeps
 * that order per tunnel, and these hold every rule to it from both ends —
 * the end that asks for a turn and the end that runs it — because a rule that
 * is only tested from one end is only half a rule.
 *
 * Each refusal test has its allowed twin nearby, so none of them passes on a
 * ledger that refuses everything.
 */

const V = TUNNEL_WIRE_VERSION;
const turn = (id = 't1'): TunnelFrame => ({ v: V, kind: 'turn', turn: id, body: { messages: [] } });
const content = (sequence: number, id = 't1'): TunnelFrame => ({
  v: V,
  kind: 'chunk',
  turn: id,
  body: { type: 'content', sequence, delta: 'x' },
});
const done = (sequence: number, id = 't1'): TunnelFrame => ({
  v: V,
  kind: 'chunk',
  turn: id,
  body: { type: 'done', sequence, finishReason: 'stop', message: { role: 'assistant', content: 'x' } },
});
const waiting = (position = 1, id = 't1'): TunnelFrame => ({ v: V, kind: 'waiting', turn: id, body: { position } });
const prompt = (p = 'p1', id = 't1'): TunnelFrame => ({
  v: V,
  kind: 'prompt',
  turn: id,
  prompt: p,
  body: { action: 'run bash' },
});
const answer = (p = 'p1', approved = true, id = 't1'): TunnelFrame => ({
  v: V,
  kind: 'answer',
  turn: id,
  prompt: p,
  body: { approved },
});
const attach = (id = 't1'): TunnelFrame => ({ v: V, kind: 'attach', turn: id });
const ack = (id = 't1'): TunnelFrame => ({ v: V, kind: 'ack', turn: id });
const cancel = (id = 't1'): TunnelFrame => ({ v: V, kind: 'cancel', turn: id });
const refusal = (code: string, where: { turn?: string; prompt?: string } = {}): TunnelFrame => ({
  v: V,
  kind: 'error',
  ...where,
  body: { code, message: code },
});

/**
 * One end of a tunnel. `hears` is a frame from the peer; `says` is one this
 * end sends. Whether this end asks or runs a turn is decided by the frames.
 */
function end() {
  const ledger = createTurnLedger();
  return {
    hears: (frame: TunnelFrame) => ledger.check(frame, 'in'),
    says: (frame: TunnelFrame) => ledger.check(frame, 'out'),
  };
}

describe('a whole turn is allowed, from both ends', () => {
  it('from the end that runs it', () => {
    const desktop = end();
    const steps: [keyof ReturnType<typeof end>, TunnelFrame][] = [
      ['hears', turn()],
      ['says', waiting(2)],
      ['says', waiting(1)],
      ['says', prompt('p1')],
      ['hears', answer('p1', true)],
      ['says', content(0)],
      ['says', prompt('p2')],
      ['hears', answer('p2', false)],
      ['hears', cancel()],
      ['says', done(1)],
      ['hears', ack()],
    ];
    for (const [side, frame] of steps) expect(desktop[side](frame), `${side} ${frame.kind}`).toBeNull();
  });

  it('from the end that asks for it', () => {
    const phone = end();
    const steps: [keyof ReturnType<typeof end>, TunnelFrame][] = [
      ['says', turn()],
      ['hears', waiting(1)],
      ['hears', prompt('p1')],
      ['says', answer('p1', true)],
      ['hears', content(0)],
      ['hears', done(1)],
      ['says', ack()],
    ];
    for (const [side, frame] of steps) expect(phone[side](frame), `${side} ${frame.kind}`).toBeNull();
  });
});

describe('waiting', () => {
  it('is said by the end running a turn that was asked for, before it has started', () => {
    const desktop = end();
    expect(desktop.says(waiting(1, 'never'))).toMatchObject({ kind: 'waiting', turn: 'never', reason: expect.stringMatching(/nobody asked/) });
    desktop.hears(turn());
    expect(desktop.hears(waiting())).toMatchObject({ reason: expect.stringMatching(/only the end running/) });
    expect(desktop.says(waiting())).toBeNull();
    desktop.says(content(0));
    expect(desktop.says(waiting())).toMatchObject({ reason: expect.stringMatching(/has started, so it is not waiting/) });
    desktop.says(done(1));
    expect(desktop.says(waiting())).toMatchObject({ reason: expect.stringMatching(/already ended/) });
  });

  it('a prompt starts a turn too, so a position after one is refused at both ends', () => {
    const desktop = end();
    desktop.hears(turn());
    desktop.says(prompt('p1'));
    desktop.hears(answer('p1'));
    expect(desktop.says(waiting(5))).toMatchObject({ reason: expect.stringMatching(/has started/) });

    const phone = end();
    phone.says(turn());
    phone.hears(prompt('p1'));
    expect(phone.hears(waiting(5))).toMatchObject({ reason: expect.stringMatching(/has started/), replyCode: 'FRAME_UNEXPECTED' });
  });

  it('is never said about a stream nobody asked for', () => {
    const desktop = end();
    expect(desktop.says(content(0, 'unasked'))).toBeNull();
    expect(desktop.says(waiting(1, 'unasked'))).toMatchObject({ reason: expect.stringMatching(/nobody asked/) });
    expect(desktop.says(prompt('p1', 'unasked'))).toMatchObject({ reason: expect.stringMatching(/nobody asked/) });
  });
});

describe('prompt and answer', () => {
  it('a prompt is raised by the end running an open turn, under an id the turn has not used', () => {
    const desktop = end();
    expect(desktop.says(prompt('p1', 'never'))).toMatchObject({ kind: 'prompt', prompt: 'p1', reason: expect.stringMatching(/nobody asked/) });
    desktop.hears(turn());
    expect(desktop.hears(prompt('p1'))).toMatchObject({ reason: expect.stringMatching(/only the end running/) });
    expect(desktop.says(prompt('p1'))).toBeNull();
    // Reused while open, and reused once answered: a late answer to the first
    // must never land on the second.
    expect(desktop.says(prompt('p1'))).toMatchObject({ reason: expect.stringMatching(/already used/) });
    desktop.hears(answer('p1'));
    expect(desktop.says(prompt('p1'))).toMatchObject({ reason: expect.stringMatching(/already used/) });
    expect(desktop.says(prompt('p2'))).toBeNull();
  });

  it('an answer is given once, by the end that asked, to a prompt that is open', () => {
    const desktop = end();
    expect(desktop.hears(answer('p1', true, 'never'))).toMatchObject({ reason: expect.stringMatching(/no turn/) });
    desktop.hears(turn());
    expect(desktop.hears(answer('p-never'))).toMatchObject({ prompt: 'p-never', reason: expect.stringMatching(/no prompt/) });
    desktop.says(prompt('p1'));
    expect(desktop.says(answer('p1'))).toMatchObject({ reason: expect.stringMatching(/only the end that asked/) });
    expect(desktop.hears(answer('p1', false))).toBeNull();
    expect(desktop.hears(answer('p1', true))).toMatchObject({ reason: expect.stringMatching(/no prompt/) });
  });

  it('an answer that crosses its prompt’s expiry is refused (#170)', () => {
    const desktop = end();
    desktop.hears(turn());
    desktop.says(prompt('p1'));
    desktop.says(prompt('p2'));
    expect(desktop.says(refusal('PROMPT_EXPIRED', { turn: 't1', prompt: 'p1' }))).toBeNull();
    expect(desktop.hears(answer('p1', true))).toMatchObject({ reason: expect.stringMatching(/no prompt/) });
    // Only that prompt: the turn and its other prompt go on.
    expect(desktop.hears(answer('p2', true))).toBeNull();
    expect(desktop.says(content(0))).toBeNull();

    // And the phone agrees, so its own answer is refused before it is sent.
    const phone = end();
    phone.says(turn());
    phone.hears(prompt('p1'));
    phone.hears(refusal('PROMPT_EXPIRED', { turn: 't1', prompt: 'p1' }));
    expect(phone.says(answer('p1', true))).toMatchObject({ reason: expect.stringMatching(/no prompt/) });
  });

  it('a turn that ends takes its open prompts with it', () => {
    const desktop = end();
    desktop.hears(turn());
    desktop.says(prompt('p1'));
    desktop.says(done(0));
    expect(desktop.hears(answer('p1'))).toMatchObject({ reason: expect.stringMatching(/already ended/) });
  });

  it('FRAME_UNEXPECTED naming an open prompt does not close it, from either end', () => {
    /*
     * A report about one frame. It used to close the prompt it named, so a
     * peer's refused frame under an open prompt's id — answered FRAME_UNEXPECTED
     * naming that prompt — closed the prompt at the end that refused it, and the
     * real answer was then refused.
     */
    const desktop = end();
    desktop.hears(turn());
    desktop.says(prompt('p1'));
    expect(desktop.hears(prompt('p1'))).toMatchObject({ prompt: 'p1', replyCode: 'FRAME_UNEXPECTED' });
    expect(desktop.says(refusal('FRAME_UNEXPECTED', { turn: 't1', prompt: 'p1' }))).toBeNull();
    expect(desktop.hears(refusal('FRAME_UNEXPECTED', { turn: 't1', prompt: 'p1' }))).toBeNull();
    expect(desktop.hears(answer('p1'))).toBeNull();
  });
});

describe('a cancelled turn takes no more questions or answers (#170)', () => {
  it('an answer after the asker’s own cancel is refused, from both ends', () => {
    const phone = end();
    phone.says(turn());
    phone.hears(prompt('p1'));
    expect(phone.says(cancel())).toBeNull();
    expect(phone.says(answer('p1'))).toMatchObject({ kind: 'answer', prompt: 'p1', reason: expect.stringMatching(/cancelled, so none of its prompts/) });

    const desktop = end();
    desktop.hears(turn());
    desktop.says(prompt('p1'));
    expect(desktop.hears(cancel())).toBeNull();
    expect(desktop.hears(answer('p1'))).toMatchObject({ reason: expect.stringMatching(/cancelled, so none of its prompts/), replyCode: 'FRAME_UNEXPECTED' });
  });

  it('the same answer with no cancel before it is taken — the control', () => {
    const desktop = end();
    desktop.hears(turn());
    desktop.says(prompt('p1'));
    expect(desktop.hears(answer('p1'))).toBeNull();
    expect(desktop.hears(cancel())).toBeNull();
  });

  it('nothing more is asked in it, it is cancelled once, and its runner still finishes it', () => {
    const desktop = end();
    const phone = end();
    desktop.hears(turn());
    phone.says(turn());
    phone.says(cancel());
    desktop.hears(cancel());
    expect(desktop.hears(cancel())).toMatchObject({ reason: expect.stringMatching(/already cancelled/) });
    expect(phone.says(cancel())).toMatchObject({ reason: expect.stringMatching(/already cancelled/) });

    expect(desktop.says(prompt('p2'))).toMatchObject({ reason: expect.stringMatching(/cancelled, so nothing more is asked/) });
    expect(desktop.says(waiting(1))).toMatchObject({ reason: expect.stringMatching(/cancelled, so nothing more is asked/) });
    // What crossed the cancel on the wire is refused at the phone.
    expect(phone.hears(prompt('p2'))).toMatchObject({ reason: expect.stringMatching(/cancelled/), replyCode: 'FRAME_UNEXPECTED' });
    expect(phone.hears(waiting(1))).toMatchObject({ reason: expect.stringMatching(/cancelled/) });

    // Its chunks and its terminal still cross, and its result is acknowledged.
    for (const frame of [content(0), done(1)]) {
      expect(desktop.says(frame)).toBeNull();
      expect(phone.hears(frame)).toBeNull();
    }
    expect(phone.says(ack())).toBeNull();
    expect(desktop.hears(ack())).toBeNull();
  });
});

describe('attach', () => {
  it('opens a turn this socket did not know, which is sent its terminal and nothing else', () => {
    const desktop = end();
    expect(desktop.hears(attach())).toBeNull();
    // Before the terminal, the turn may still be waiting or asking.
    expect(desktop.says(waiting(1))).toBeNull();
    expect(desktop.says(prompt('p1'))).toBeNull();
    expect(desktop.says(content(0))).toMatchObject({ reason: expect.stringMatching(/terminal chunk and nothing else/) });
    expect(desktop.says(done(4))).toBeNull();
    expect(desktop.hears(ack())).toBeNull();
  });

  it('a second attach for the same turn on the same socket is refused', () => {
    const desktop = end();
    desktop.hears(attach());
    expect(desktop.hears(attach())).toMatchObject({ kind: 'attach', turn: 't1', reason: expect.stringMatching(/already attached/) });
    // And after its result was delivered and acknowledged, still refused.
    desktop.says(done(3));
    desktop.hears(ack());
    expect(desktop.hears(attach())).toMatchObject({ reason: expect.stringMatching(/already attached/) });
  });

  it('an attach for a turn already running on this socket is refused', () => {
    const desktop = end();
    desktop.hears(turn());
    expect(desktop.hears(attach())).toMatchObject({ reason: expect.stringMatching(/already attached or running/) });
    // Refusing it changed nothing: the turn still streams in the ordinary way.
    expect(desktop.says(content(0))).toBeNull();
  });

  it('an attach answered RESULT_UNKNOWN is over at both ends', () => {
    const phone = end();
    phone.says(attach('t-other'));
    phone.hears(refusal('RESULT_UNKNOWN', { turn: 't-other' }));
    expect(phone.says(ack('t-other'))).toMatchObject({ reason: expect.stringMatching(/nothing has been delivered/) });
    expect(phone.says(cancel('t-other'))).toMatchObject({ reason: expect.stringMatching(/already ended/) });
  });
});

describe('ack', () => {
  it('is given once, by the end that asked, after a terminal chunk', () => {
    const desktop = end();
    expect(desktop.hears(ack())).toMatchObject({ reason: expect.stringMatching(/no turn/) });
    desktop.hears(turn());
    expect(desktop.hears(ack())).toMatchObject({ reason: expect.stringMatching(/nothing has been delivered/) });
    desktop.says(content(0));
    expect(desktop.hears(ack())).toMatchObject({ reason: expect.stringMatching(/nothing has been delivered/) });
    desktop.says(done(1));
    expect(desktop.says(ack())).toMatchObject({ reason: expect.stringMatching(/only the end that asked/) });
    // The refusals above recorded nothing: the first real ack is accepted.
    expect(desktop.hears(ack())).toBeNull();
    expect(desktop.hears(ack())).toMatchObject({ reason: expect.stringMatching(/already acknowledged/) });
  });

  it('has nothing to acknowledge after a refusal, which delivers no result', () => {
    const desktop = end();
    desktop.hears(turn());
    desktop.says(refusal('WAIT_LIST_FULL', { turn: 't1' }));
    expect(desktop.hears(ack())).toMatchObject({ reason: expect.stringMatching(/nothing has been delivered/) });
  });

  it('follows an error chunk as it follows a done chunk', () => {
    const desktop = end();
    desktop.hears(turn());
    desktop.says({ v: V, kind: 'chunk', turn: 't1', body: { type: 'error', sequence: 0, error: { code: 'X', message: 'y' } } });
    expect(desktop.hears(ack())).toBeNull();
  });
});

describe('turn, cancel and chunk', () => {
  it('a turn id is used once on a tunnel, even after its turn ended', () => {
    const desktop = end();
    expect(desktop.hears(turn())).toBeNull();
    expect(desktop.hears(turn())).toMatchObject({ reason: expect.stringMatching(/already in use/) });
    desktop.says(done(0));
    expect(desktop.hears(turn())).toMatchObject({ reason: expect.stringMatching(/already in use/) });
    expect(desktop.hears(turn('t2'))).toBeNull();
  });

  it('a cancel comes from the end that asked, while the turn is open', () => {
    const desktop = end();
    expect(desktop.hears(cancel())).toMatchObject({ reason: expect.stringMatching(/no turn/) });
    desktop.hears(turn());
    expect(desktop.says(cancel())).toMatchObject({ reason: expect.stringMatching(/only the end that asked/) });
    expect(desktop.hears(cancel())).toBeNull();
    desktop.says(done(0));
    expect(desktop.hears(cancel())).toMatchObject({ reason: expect.stringMatching(/already ended/) });
  });

  it('a reply streams from the end running the turn, and stops at its terminal', () => {
    const phone = end();
    phone.says(turn());
    expect(phone.says(content(0))).toMatchObject({ reason: expect.stringMatching(/does not stream its reply/) });
    expect(phone.hears(content(0))).toBeNull();
    expect(phone.hears(done(1))).toBeNull();
    expect(phone.hears(content(2))).toMatchObject({ reason: expect.stringMatching(/already ended/) });
  });

  it('a stream nobody asked for is still carried, with the receiver as its asker', () => {
    // Rung 0's greeting shape. The receiver can cancel it and acknowledge it,
    // and cannot stream it back.
    const phone = end();
    expect(phone.hears(content(0, 'unasked'))).toBeNull();
    expect(phone.says(cancel('unasked'))).toBeNull();
    expect(phone.says(content(1, 'unasked'))).toMatchObject({ reason: expect.stringMatching(/does not stream/) });
    expect(phone.hears(done(1, 'unasked'))).toBeNull();
    expect(phone.says(ack('unasked'))).toBeNull();
  });
});

describe('errors change state only from the end running the turn', () => {
  it('a refusal that ends turns ends the turn it names', () => {
    for (const code of ['WAIT_LIST_FULL', 'DESKTOP_QUITTING', 'HOST_SUSPENDED', 'HOST_DOES_NOT_RUN_TURNS']) {
      const phone = end();
      phone.says(turn());
      expect(phone.hears(refusal(code, { turn: 't1' })), code).toBeNull();
      expect(phone.hears(content(0)), code).toMatchObject({ reason: expect.stringMatching(/already ended/) });
    }
    const phone = end();
    phone.says(attach());
    expect(phone.hears(refusal('RESULT_UNKNOWN', { turn: 't1' }))).toBeNull();
    expect(phone.hears(done(0))).toMatchObject({ reason: expect.stringMatching(/already ended/) });
  });

  it('a code this build does not know ends the turn, failing closed', () => {
    const phone = end();
    phone.says(turn());
    phone.hears(refusal('FROM_A_NEWER_BUILD', { turn: 't1' }));
    expect(phone.says(cancel())).toMatchObject({ reason: expect.stringMatching(/already ended/) });
  });

  it('FRAME_UNEXPECTED and PROMPT_EXPIRED leave the turn open', () => {
    const phone = end();
    phone.says(turn());
    phone.hears(prompt('p1'));
    phone.hears(refusal('FRAME_UNEXPECTED', { turn: 't1' }));
    phone.hears(refusal('PROMPT_EXPIRED', { turn: 't1', prompt: 'p1' }));
    expect(phone.hears(content(0))).toBeNull();
  });

  it('a refusal the table defines is refused from the end that asked, and changes nothing', () => {
    const desktop = end();
    desktop.hears(turn());
    desktop.says(prompt('p1'));
    for (const [code, where] of [
      ['WAIT_LIST_FULL', { turn: 't1' }],
      ['DESKTOP_QUITTING', { turn: 't1' }],
      ['PROMPT_EXPIRED', { turn: 't1', prompt: 'p1' }],
    ] as const) {
      expect(desktop.hears(refusal(code, where)), code).toMatchObject({
        reason: expect.stringMatching(/sent by the end running a turn/),
        replyCode: 'FRAME_UNEXPECTED',
      });
    }
    // A code this build does not know is carried from the asker: it cannot
    // tell what that code means, so it reads nothing into it.
    expect(desktop.hears(refusal('FROM_A_NEWER_BUILD', { turn: 't1' }))).toBeNull();
    // The turn is open and its prompt still takes an answer.
    expect(desktop.hears(answer('p1'))).toBeNull();
    expect(desktop.says(content(0))).toBeNull();

    // And the end that asked cannot send one.
    const phone = end();
    phone.says(turn());
    expect(phone.says(refusal('HOST_SUSPENDED', { turn: 't1' }))).toMatchObject({
      reason: expect.stringMatching(/sent by the end running a turn/),
    });
  });

  it('a refusal of the whole connection ends every turn its sender runs, and no other', () => {
    const phone = end();
    phone.says(turn('asked-1'));
    phone.says(turn('asked-2'));
    // A turn the phone is running for the desktop, in the other direction.
    phone.hears(turn('run-by-phone'));
    expect(phone.hears(refusal('DESKTOP_QUITTING'))).toBeNull();
    expect(phone.says(cancel('asked-1'))).toMatchObject({ reason: expect.stringMatching(/already ended/) });
    expect(phone.says(cancel('asked-2'))).toMatchObject({ reason: expect.stringMatching(/already ended/) });
    expect(phone.says(content(0, 'run-by-phone'))).toBeNull();

    const untouched = end();
    untouched.says(turn());
    untouched.hears(refusal('FRAME_UNEXPECTED'));
    expect(untouched.hears(content(0))).toBeNull();
  });

  it('a refusal of a turn nobody knows is dropped without a reply, and records nothing', () => {
    const phone = end();
    expect(phone.hears(refusal('WAIT_LIST_FULL', { turn: 'unknown' }))).toMatchObject({
      reason: expect.stringMatching(/no turn/),
      replyCode: null,
    });
    expect(phone.says(turn('unknown'))).toBeNull();
  });
});

describe('a turn has one terminal', () => {
  const ending = ['DESKTOP_QUITTING', 'HOST_SUSPENDED', 'WAIT_LIST_FULL', 'HOST_DOES_NOT_RUN_TURNS', 'FROM_A_NEWER_BUILD'];

  it('the end running a turn may refuse it once, and not after it is over or for a turn it never had', () => {
    for (const code of ending) {
      const desktop = end();
      desktop.hears(turn());
      expect(desktop.says(refusal(code, { turn: 't1' })), code).toBeNull();
      expect(desktop.says(refusal(code, { turn: 't1' })), code).toMatchObject({ reason: expect.stringMatching(/already ended/) });
    }

    const desktop = end();
    desktop.hears(turn());
    desktop.says(done(0));
    for (const code of [...ending, 'RESULT_UNKNOWN']) {
      expect(desktop.says(refusal(code, { turn: 't1' })), code).toMatchObject({ reason: expect.stringMatching(/already ended/) });
    }
    expect(desktop.says(refusal('PROMPT_EXPIRED', { turn: 't1', prompt: 'p1' }))).toMatchObject({
      reason: expect.stringMatching(/already ended/),
    });
    expect(desktop.says(refusal('DESKTOP_QUITTING', { turn: 'never' }))).toMatchObject({ reason: expect.stringMatching(/no turn/) });
    // A report that a late frame for it went nowhere is still allowed.
    expect(desktop.says(refusal('FRAME_UNEXPECTED', { turn: 't1' }))).toBeNull();
  });

  it('a refusal of a turn that already had its terminal is dropped by the end that asked, without a reply', () => {
    for (const code of ending) {
      const phone = end();
      phone.says(turn());
      phone.hears(done(0));
      expect(phone.hears(refusal(code, { turn: 't1' })), code).toMatchObject({
        reason: expect.stringMatching(/already ended/),
        replyCode: null,
      });
    }
    // A refusal is a terminal too.
    const phone = end();
    phone.says(turn());
    expect(phone.hears(refusal('HOST_SUSPENDED', { turn: 't1' }))).toBeNull();
    expect(phone.hears(refusal('DESKTOP_QUITTING', { turn: 't1' }))).toMatchObject({ replyCode: null });
    // The control: a refusal of a turn still open is its terminal, and is read.
    const open = end();
    open.says(turn());
    open.hears(content(0));
    expect(open.hears(refusal('DESKTOP_QUITTING', { turn: 't1' }))).toBeNull();
  });
});

describe('a refusal that says the turn had not started', () => {
  for (const code of ['WAIT_LIST_FULL', 'HOST_DOES_NOT_RUN_TURNS']) {
    it(`${code} is refused once the turn has started, at both ends`, () => {
      for (const start of [content(0), prompt('p1')]) {
        const desktop = end();
        desktop.hears(turn());
        desktop.says(start);
        expect(desktop.says(refusal(code, { turn: 't1' })), start.kind).toMatchObject({
          reason: expect.stringMatching(/had not started, and it has/),
        });
        const phone = end();
        phone.says(turn());
        phone.hears(start);
        expect(phone.hears(refusal(code, { turn: 't1' })), start.kind).toMatchObject({
          reason: expect.stringMatching(/had not started, and it has/),
          replyCode: 'FRAME_UNEXPECTED',
        });
        // Refused, so the turn goes on to its real terminal.
        expect(phone.hears(done(1)), start.kind).toBeNull();
      }
      // The control: before it started it is the turn's terminal, and a
      // `waiting` does not start a turn.
      const desktop = end();
      desktop.hears(turn());
      desktop.says(waiting(1));
      expect(desktop.says(refusal(code, { turn: 't1' }))).toBeNull();
    });
  }

  it('HOST_DOES_NOT_RUN_TURNS for the whole connection is refused while a turn its sender runs has started', () => {
    const desktop = end();
    desktop.hears(turn('started'));
    desktop.hears(turn('queued'));
    desktop.says(content(0, 'started'));
    expect(desktop.says(refusal('HOST_DOES_NOT_RUN_TURNS'))).toMatchObject({
      reason: expect.stringMatching(/one its sender runs has/),
    });
    // Refused, so nothing ended: the started turn finishes, and then it may.
    expect(desktop.says(done(1, 'started'))).toBeNull();
    expect(desktop.says(refusal('HOST_DOES_NOT_RUN_TURNS'))).toBeNull();
    expect(desktop.says(waiting(1, 'queued'))).toMatchObject({ reason: expect.stringMatching(/already ended/) });
  });

  it('RESULT_UNKNOWN answers an attach, and nothing else', () => {
    const desktop = end();
    desktop.hears(turn());
    expect(desktop.says(refusal('RESULT_UNKNOWN', { turn: 't1' }))).toMatchObject({
      reason: expect.stringMatching(/did not come by attach/),
    });
    const phone = end();
    phone.says(turn());
    expect(phone.hears(refusal('RESULT_UNKNOWN', { turn: 't1' }))).toMatchObject({
      reason: expect.stringMatching(/did not come by attach/),
      replyCode: 'FRAME_UNEXPECTED',
    });
    // The control.
    desktop.hears(attach('a1'));
    expect(desktop.says(refusal('RESULT_UNKNOWN', { turn: 'a1' }))).toBeNull();
  });
});

describe('a refusal of every turn is final for the tunnel', () => {
  it('a turn that crossed it is refused with the same code at one end and is over at both', () => {
    const phone = end();
    const desktop = end();
    // On the wire at once: the phone's turn going up, the desktop's refusal coming down.
    expect(phone.says(turn())).toBeNull();
    expect(desktop.says(refusal('HOST_SUSPENDED'))).toBeNull();
    // The desktop reads the turn after its refusal: refused with that code, and never read.
    expect(desktop.hears(turn())).toMatchObject({ kind: 'turn', turn: 't1', replyCode: 'HOST_SUSPENDED' });
    // The phone reads the refusal after its turn: that turn is over.
    expect(phone.hears(refusal('HOST_SUSPENDED'))).toBeNull();
    // The desktop's repeat naming the turn is the one refusal it owes it, once…
    expect(desktop.says(refusal('HOST_SUSPENDED', { turn: 't1' }))).toBeNull();
    expect(desktop.says(refusal('HOST_SUSPENDED', { turn: 't1' }))).toMatchObject({ reason: expect.stringMatching(/already ended/) });
    // …and at the phone it is a second terminal, dropped without a reply.
    expect(phone.hears(refusal('HOST_SUSPENDED', { turn: 't1' }))).toMatchObject({ replyCode: null });
    // Neither end can run it.
    expect(desktop.says(content(0))).toMatchObject({ reason: expect.stringMatching(/already ended/) });
    expect(desktop.says(prompt('p1'))).toMatchObject({ reason: expect.stringMatching(/already ended/) });
  });

  it('the end that received it asks for nothing more, and is streamed nothing new', () => {
    const phone = end();
    phone.says(turn());
    phone.hears(refusal('DESKTOP_QUITTING'));
    expect(phone.says(turn('t2'))).toMatchObject({
      reason: expect.stringMatching(/the other end refused every turn on this tunnel \(DESKTOP_QUITTING\)/),
      replyCode: 'FRAME_UNEXPECTED',
    });
    expect(phone.says(attach('t3'))).toMatchObject({ reason: expect.stringMatching(/the other end refused every turn/) });
    expect(phone.hears(content(0, 'unasked'))).toMatchObject({ reason: expect.stringMatching(/the other end refused every turn/) });
    // The other direction is untouched: the phone may still run a turn the desktop asks for.
    expect(phone.hears(turn('for-the-phone'))).toBeNull();
    expect(phone.says(content(0, 'for-the-phone'))).toBeNull();
  });

  it('the end that sent it starts nothing new, and owes a crossed turn exactly its own code', () => {
    const desktop = end();
    desktop.says(refusal('DESKTOP_QUITTING'));
    expect(desktop.says(content(0, 'unasked'))).toMatchObject({ reason: expect.stringMatching(/this end refused every turn/) });
    expect(desktop.hears(attach('a1'))).toMatchObject({ replyCode: 'DESKTOP_QUITTING' });
    expect(desktop.says(waiting(1, 'a1'))).toMatchObject({ reason: expect.stringMatching(/already ended/) });
    expect(desktop.says(refusal('HOST_SUSPENDED', { turn: 'a1' }))).toMatchObject({ reason: expect.stringMatching(/already ended/) });
    expect(desktop.says(refusal('DESKTOP_QUITTING', { turn: 'a1' }))).toBeNull();
  });

  it('a refusal of one turn is not final — the control', () => {
    const phone = end();
    phone.says(turn());
    phone.hears(refusal('HOST_SUSPENDED', { turn: 't1' }));
    expect(phone.says(turn('t2'))).toBeNull();

    const desktop = end();
    desktop.hears(turn());
    desktop.says(refusal('HOST_SUSPENDED', { turn: 't1' }));
    expect(desktop.hears(turn('t2'))).toBeNull();
    expect(desktop.says(content(0, 't2'))).toBeNull();
  });
});

describe(`at most ${MAX_OPEN_TURNS} open turns for each end that asks`, () => {
  it('refuses the peer’s turn past the bound, without recording it, and takes one again once a turn ends', () => {
    const desktop = end();
    for (let index = 0; index < MAX_OPEN_TURNS; index += 1) {
      expect(desktop.hears(turn(`t${String(index)}`)), String(index)).toBeNull();
    }
    expect(desktop.hears(turn('over'))).toMatchObject({ reason: expect.stringMatching(/already open/), replyCode: 'FRAME_UNEXPECTED' });
    expect(desktop.hears(attach('over'))).toMatchObject({ reason: expect.stringMatching(/already open/) });
    desktop.says(refusal('WAIT_LIST_FULL', { turn: 't0' }));
    expect(desktop.hears(turn('over'))).toBeNull();
    expect(desktop.hears(turn('over-again'))).toMatchObject({ reason: expect.stringMatching(/already open/) });
  });

  it('refuses a stream nobody asked for past the bound — the kind only its sender can end', () => {
    const phone = end();
    for (let index = 0; index < MAX_OPEN_TURNS; index += 1) {
      expect(phone.hears(content(0, `u${String(index)}`)), String(index)).toBeNull();
    }
    expect(phone.hears(content(0, 'over'))).toMatchObject({ reason: expect.stringMatching(/already open/) });
    phone.hears(done(1, 'u0'));
    expect(phone.hears(content(0, 'over'))).toBeNull();

    const desktop = end();
    for (let index = 0; index < MAX_OPEN_TURNS; index += 1) desktop.says(content(0, `u${String(index)}`));
    expect(desktop.says(content(0, 'over'))).toMatchObject({ reason: expect.stringMatching(/already open/) });
  });

  it('holds this end’s own asks to it, so a peer that keeps to the bound never meets the other end’s', () => {
    const phone = end();
    for (let index = 0; index < MAX_OPEN_TURNS; index += 1) phone.says(turn(`t${String(index)}`));
    expect(phone.says(turn('over'))).toMatchObject({ reason: expect.stringMatching(/already open/) });
    expect(phone.says(attach('over'))).toMatchObject({ reason: expect.stringMatching(/already open/) });
  });

  it('counts each asking end apart', () => {
    const desktop = end();
    for (let index = 0; index < MAX_OPEN_TURNS; index += 1) desktop.hears(turn(`from-phone-${String(index)}`));
    // Full for the phone's asks — and a stream the desktop starts unasked is
    // one the phone would be asker of — while the desktop's own asks are not.
    expect(desktop.says(content(0, 'unasked'))).toMatchObject({ reason: expect.stringMatching(/already open/) });
    expect(desktop.says(turn('from-desktop'))).toBeNull();
  });
});

describe(`the ledger remembers ${MAX_ENDED_TURNS_REMEMBERED} ended turns, and no more`, () => {
  it('forgets the oldest ended turn once one more ends, and says which', () => {
    const forgotten: string[] = [];
    const ledger = createTurnLedger({ onForget: (id) => forgotten.push(id) });
    for (let index = 0; index <= MAX_ENDED_TURNS_REMEMBERED; index += 1) {
      const id = `t${String(index)}`;
      ledger.check(turn(id), 'in');
      ledger.check(refusal('WAIT_LIST_FULL', { turn: id }), 'out');
      // Exactly at the bound nothing is forgotten; one past it, the first is.
      expect(forgotten, id).toEqual(index < MAX_ENDED_TURNS_REMEMBERED ? [] : ['t0']);
    }
    expect(ledger.check(turn('t0'), 'in')).toBeNull();
    expect(ledger.check(turn('t1'), 'in')).toMatchObject({ reason: expect.stringMatching(/already in use/) });
  });

  it('never forgets a turn that is still open', () => {
    const forgotten: string[] = [];
    const ledger = createTurnLedger({ onForget: (id) => forgotten.push(id) });
    ledger.check(turn('open'), 'in');
    for (let index = 0; index < MAX_ENDED_TURNS_REMEMBERED * 2; index += 1) {
      ledger.check(turn(`t${String(index)}`), 'in');
      ledger.check(done(0, `t${String(index)}`), 'out');
    }
    expect(forgotten).toHaveLength(MAX_ENDED_TURNS_REMEMBERED);
    expect(forgotten).not.toContain('open');
    expect(ledger.check(turn('open'), 'in')).toMatchObject({ reason: expect.stringMatching(/already in use/) });
    expect(ledger.check(done(0, 'open'), 'out')).toBeNull();
  });

  it('forgets a result still waiting for its ack last, so the ack is not refused', () => {
    const phone = end();
    phone.says(turn('held'));
    phone.hears(done(0, 'held'));
    for (let index = 0; index < MAX_ENDED_TURNS_REMEMBERED; index += 1) {
      phone.says(turn(`t${String(index)}`));
      phone.hears(refusal('WAIT_LIST_FULL', { turn: `t${String(index)}` }));
    }
    expect(phone.says(ack('held'))).toBeNull();

    // Only when every remembered turn is waiting for an ack does the oldest go.
    const forgotten: string[] = [];
    const ledger = createTurnLedger({ onForget: (id) => forgotten.push(id) });
    for (let index = 0; index <= MAX_ENDED_TURNS_REMEMBERED; index += 1) {
      ledger.check(turn(`d${String(index)}`), 'out');
      ledger.check(done(0, `d${String(index)}`), 'in');
    }
    expect(forgotten).toEqual(['d0']);
  });
});

describe('the gate both halves run', () => {
  it('throws on a frame this end may not send, and records nothing for it', () => {
    const desktop = createProtocolGate();
    desktop.receive(turn());

    expect(() => desktop.send(answer('p1'))).toThrow(TunnelProtocolError);

    // A frame the far end could not read back as written.
    expect(() =>
      desktop.send({ v: V, kind: 'prompt', turn: 't1', prompt: 'p1', body: { action: 'run bash', title: 5 } } as unknown as TunnelFrame),
    ).toThrow(TunnelWireError);
    // …did not use the prompt id up.
    expect(() => desktop.send(prompt('p1'))).not.toThrow();
    expect(() => desktop.send(prompt('p1'))).toThrow(TunnelProtocolError);

    // #260's obligation, and a `done` it refused did not end the turn.
    expect(() =>
      desktop.send({ v: V, kind: 'chunk', turn: 't1', body: { type: 'done', sequence: 0, finishReason: 'stop' } }),
    ).toThrow(TypeError);
    expect(() => desktop.send(content(0))).not.toThrow();
  });

  it('names the violation when it throws', () => {
    const phone = createProtocolGate();
    try {
      phone.send(ack('t9'));
      expect.unreachable('an ack for no turn was sent');
    } catch (error) {
      expect(error).toBeInstanceOf(TunnelProtocolError);
      expect((error as TunnelProtocolError).violation).toMatchObject({ kind: 'ack', turn: 't9' });
      expect((error as Error).message).toMatch(/cannot send this ack frame: no turn/);
    }
  });

  it('refuses an inbound frame with a FRAME_UNEXPECTED reply that names it and can be sent', () => {
    const desktop = createProtocolGate();
    desktop.receive(turn());
    const verdict = desktop.receive(answer('p-never'));
    if (verdict.verdict !== 'refuse') throw new Error(`expected a refusal, got ${verdict.verdict}`);
    expect(verdict.violation).toMatchObject({ kind: 'answer', turn: 't1', prompt: 'p-never' });
    expect(verdict.reply).toMatchObject({
      v: V,
      kind: 'error',
      turn: 't1',
      prompt: 'p-never',
      body: { code: 'FRAME_UNEXPECTED', message: expect.stringMatching(/answer frame was not read/) },
    });
    expect(decodeFrame(desktop.send(verdict.reply))).toEqual(verdict.reply);
    // And the tunnel's state is what it was: the turn still streams.
    expect(() => desktop.send(content(0))).not.toThrow();
  });

  it('drops a second terminal as stale, with no reply to send', () => {
    const phone = createProtocolGate();
    phone.send(turn());
    expect(phone.receive(done(0))).toEqual({ verdict: 'accept' });
    expect(phone.receive(refusal('DESKTOP_QUITTING', { turn: 't1' }))).toMatchObject({
      verdict: 'stale',
      violation: { kind: 'error', turn: 't1', replyCode: null },
    });
    expect(phone.receive(refusal('DESKTOP_QUITTING', { turn: 't1' }))).not.toHaveProperty('reply');
  });

  it('answers a turn that crossed a refusal of every turn with that code, sendable once through the gate', () => {
    const desktop = createProtocolGate();
    desktop.send(refusal('HOST_SUSPENDED'));
    const verdict = desktop.receive(turn('crossed'));
    if (verdict.verdict !== 'refuse') throw new Error(`expected a refusal, got ${verdict.verdict}`);
    expect(verdict.reply).toEqual({
      v: V,
      kind: 'error',
      turn: 'crossed',
      body: { code: 'HOST_SUSPENDED', message: expect.stringMatching(/turn frame was not read: this end refused every turn/) },
    });
    expect(decodeFrame(desktop.send(verdict.reply))).toEqual(verdict.reply);
    expect(() => desktop.send(verdict.reply)).toThrow(TunnelProtocolError);
  });

  it('accepts a second turn numbering its reply from 0 on the same tunnel', () => {
    const phone = createProtocolGate();
    phone.send(turn('t1'));
    expect(phone.receive(content(0, 't1'))).toEqual({ verdict: 'accept' });
    expect(phone.receive(done(1, 't1'))).toEqual({ verdict: 'accept' });
    phone.send(turn('t2'));
    expect(phone.receive(content(0, 't2'))).toEqual({ verdict: 'accept' });
  });

  it('reads a chunk after its turn’s terminal as out of state, not as a broken stream', () => {
    const phone = createProtocolGate();
    phone.send(turn());
    phone.receive(done(0));
    expect(phone.receive(content(1))).toMatchObject({ verdict: 'refuse' });
    // Refused, not a fault: the next turn is not failed by it.
    phone.send(turn('t2'));
    expect(phone.receive(content(0, 't2'))).toEqual({ verdict: 'accept' });
  });

  it('an attach resumes the count at the held terminal, and nothing else does', () => {
    const phone = createProtocolGate();
    phone.send(attach());
    expect(phone.receive(done(7))).toEqual({ verdict: 'accept' });

    // The paired control: the same terminal without an attach is a gap.
    const control = createProtocolGate();
    expect(control.receive(done(7))).toEqual({ verdict: 'fault', fault: { kind: 'gap', expected: 0, got: 7 } });
  });

  it('refuses an attached turn a content chunk as state, before the stream is counted', () => {
    const phone = createProtocolGate();
    phone.send(attach());
    expect(phone.receive(content(3))).toMatchObject({ verdict: 'refuse' });
    expect(phone.receive(done(4))).toEqual({ verdict: 'accept' });
  });

  it('forgetting an ended turn forgets its count too', () => {
    const phone = createProtocolGate();
    expect(phone.receive(done(0, 'old'))).toEqual({ verdict: 'accept' });
    expect(phone.receive(done(1, 'old'))).toMatchObject({ verdict: 'refuse' });
    // Acknowledged, so it is not kept back as a result waiting for its ack.
    phone.send(ack('old'));
    for (let index = 0; index < MAX_ENDED_TURNS_REMEMBERED; index += 1) {
      const id = `t${String(index)}`;
      phone.send(turn(id));
      phone.receive(refusal('WAIT_LIST_FULL', { turn: id }));
    }
    // Forgotten by the ledger AND the guard: a stream under the old id counts
    // from 0 again, where a guard that still remembered would call it a repeat.
    expect(phone.receive(done(0, 'old'))).toEqual({ verdict: 'accept' });
  });
});
