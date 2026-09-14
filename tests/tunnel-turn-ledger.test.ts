import { describe, expect, it } from 'vitest';

import {
  MAX_ENDED_TURNS_REMEMBERED,
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
      ['hears', cancel()],
      ['hears', answer('p2', false)],
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
  it('is said by the end running a turn that was asked for, before its first chunk', () => {
    const desktop = end();
    expect(desktop.says(waiting(1, 'never'))).toMatchObject({ kind: 'waiting', turn: 'never', reason: expect.stringMatching(/nobody asked/) });
    desktop.hears(turn());
    expect(desktop.hears(waiting())).toMatchObject({ reason: expect.stringMatching(/only the end running/) });
    expect(desktop.says(waiting())).toBeNull();
    desktop.says(content(0));
    expect(desktop.says(waiting())).toMatchObject({ reason: expect.stringMatching(/already streaming/) });
    desktop.says(done(1));
    expect(desktop.says(waiting())).toMatchObject({ reason: expect.stringMatching(/already ended/) });
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

describe('errors are always carried, and change state only from the end running the turn', () => {
  it('a refusal that ends turns ends the turn it names', () => {
    for (const code of ['WAIT_LIST_FULL', 'DESKTOP_QUITTING', 'HOST_SUSPENDED', 'HOST_DOES_NOT_RUN_TURNS', 'RESULT_UNKNOWN']) {
      const phone = end();
      phone.says(turn());
      expect(phone.hears(refusal(code, { turn: 't1' })), code).toBeNull();
      expect(phone.hears(content(0)), code).toMatchObject({ reason: expect.stringMatching(/already ended/) });
    }
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

  it('an error from the end that asked changes nothing', () => {
    const desktop = end();
    desktop.hears(turn());
    desktop.says(prompt('p1'));
    expect(desktop.hears(refusal('WAIT_LIST_FULL', { turn: 't1' }))).toBeNull();
    expect(desktop.hears(refusal('PROMPT_EXPIRED', { turn: 't1', prompt: 'p1' }))).toBeNull();
    // The turn is open and its prompt still takes an answer.
    expect(desktop.hears(answer('p1'))).toBeNull();
    expect(desktop.says(content(0))).toBeNull();
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

  it('an error for a turn nobody knows is carried and records nothing', () => {
    const phone = end();
    expect(phone.hears(refusal('WAIT_LIST_FULL', { turn: 'unknown' }))).toBeNull();
    expect(phone.says(turn('unknown'))).toBeNull();
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
