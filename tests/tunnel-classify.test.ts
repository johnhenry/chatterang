import { describe, expect, it } from 'vitest';

import { classifyFrame, type TurnUpdate } from '@chatterang/tunnel/client';
import {
  FRAME_KINDS,
  REFUSALS,
  TUNNEL_WIRE_VERSION,
  type FrameKind,
  type TunnelFrame,
} from '@chatterang/tunnel/wire';

/**
 * WHAT A PHONE RENDERS FROM A FRAME (#7).
 *
 * #169: "a silent wait is indistinguishable from a hung app", and "the
 * connection closed" tells the user nothing. So the client reads every frame
 * into one of a few outcomes an app can put on screen — and busy, quitting,
 * suspended and refused are four of them, not one.
 */

const V = TUNNEL_WIRE_VERSION;
const refusalFrame = (code: string, where: { turn?: string; prompt?: string } = { turn: 't1' }): TunnelFrame => ({
  v: V,
  kind: 'error',
  ...where,
  body: { code, message: `because ${code}` },
});

const SAMPLES: Record<FrameKind, TunnelFrame> = {
  turn: { v: V, kind: 'turn', turn: 't1', body: {} },
  chunk: { v: V, kind: 'chunk', turn: 't1', body: { type: 'content', sequence: 0, delta: 'x' } },
  cancel: { v: V, kind: 'cancel', turn: 't1' },
  waiting: { v: V, kind: 'waiting', turn: 't1', body: { position: 3 } },
  prompt: { v: V, kind: 'prompt', turn: 't1', prompt: 'p1', body: { action: 'run bash', title: 'Run this?' } },
  answer: { v: V, kind: 'answer', turn: 't1', prompt: 'p1', body: { approved: true } },
  attach: { v: V, kind: 'attach', turn: 't1' },
  ack: { v: V, kind: 'ack', turn: 't1' },
  hello: { v: V, kind: 'hello', body: { protocol: V } },
  ping: { v: V, kind: 'ping' },
  pong: { v: V, kind: 'pong' },
  bye: { v: V, kind: 'bye' },
  error: refusalFrame('WAIT_LIST_FULL'),
  pair: { v: V, kind: 'pair', body: { step: 'message' } },
};

describe('every frame has a reading', () => {
  it('for each kind this build knows', () => {
    const readings = Object.fromEntries(FRAME_KINDS.map((kind) => [kind, classifyFrame(SAMPLES[kind]).kind]));
    expect(readings).toEqual({
      turn: 'other',
      chunk: 'streaming',
      cancel: 'other',
      waiting: 'waiting',
      prompt: 'prompt',
      answer: 'other',
      attach: 'other',
      ack: 'other',
      hello: 'other',
      ping: 'other',
      pong: 'other',
      bye: 'other',
      error: 'refused',
      pair: 'other',
    });
  });

  it('a waiting turn is told its place, and a prompt is carried whole', () => {
    expect(classifyFrame(SAMPLES.waiting)).toEqual({ kind: 'waiting', turn: 't1', position: 3 });
    expect(classifyFrame(SAMPLES.prompt)).toEqual({
      kind: 'prompt',
      turn: 't1',
      prompt: 'p1',
      body: { action: 'run bash', title: 'Run this?' },
    });
  });

  it('a chunk is completed only when it is a done chunk', () => {
    const chunk = (body: unknown): TunnelFrame => ({ v: V, kind: 'chunk', turn: 't1', body });
    expect(classifyFrame(chunk({ type: 'done', sequence: 1, message: { role: 'assistant', content: 'x' } }))).toEqual({
      kind: 'completed',
      turn: 't1',
    });
    expect(classifyFrame(chunk({ type: 'error', sequence: 1, error: { code: 'X', message: 'y' } }))).toEqual({
      kind: 'failed',
      turn: 't1',
    });
    // A type this build does not know, or no body at all, is never a finish.
    for (const body of [{ type: 'finished', sequence: 1 }, {}, null, 'done']) {
      expect(classifyFrame(chunk(body)), JSON.stringify(body)).toEqual({ kind: 'streaming', turn: 't1' });
    }
  });
});

describe('refusals', () => {
  it('each defined code reads as its row in the table', () => {
    for (const [code, row] of Object.entries(REFUSALS)) {
      const where = row.scope === 'prompt' ? { turn: 't1', prompt: 'p1' } : { turn: 't1' };
      expect(classifyFrame(refusalFrame(code, where)), code).toEqual({
        kind: 'refused',
        refusal: row.kind,
        endsTurn: row.endsTurn,
        code,
        message: `because ${code}`,
        ...where,
      });
    }
  });

  it('busy, quitting, suspended and refused are four different things to render', () => {
    const kinds = ['WAIT_LIST_FULL', 'DESKTOP_QUITTING', 'HOST_SUSPENDED', 'HOST_DOES_NOT_RUN_TURNS'].map(
      (code) => classifyFrame(refusalFrame(code)),
    );
    expect(kinds.map((update) => (update.kind === 'refused' ? update.refusal : update.kind))).toEqual([
      'busy',
      'quitting',
      'suspended',
      'refused',
    ]);
    expect(kinds.every((update) => update.kind === 'refused' && update.endsTurn)).toBe(true);
  });

  it('a prompt that expired is that call refused, and the turn goes on', () => {
    expect(classifyFrame(refusalFrame('PROMPT_EXPIRED', { turn: 't1', prompt: 'p1' }))).toMatchObject({
      kind: 'refused',
      refusal: 'prompt-expired',
      endsTurn: false,
      turn: 't1',
      prompt: 'p1',
    });
  });

  it('a refusal of the whole connection names no turn and still ends turns', () => {
    const update = classifyFrame(refusalFrame('HOST_SUSPENDED', {}));
    expect(update).toEqual({
      kind: 'refused',
      refusal: 'suspended',
      endsTurn: true,
      code: 'HOST_SUSPENDED',
      message: 'because HOST_SUSPENDED',
    });
    expect(update).not.toHaveProperty('turn');
  });

  it('a code this build does not know is a failure that ends the turn, never a success', () => {
    const successes: TurnUpdate['kind'][] = ['completed', 'streaming', 'waiting', 'other'];
    for (const code of ['FROM_A_NEWER_BUILD', 'OK', 'toString', '__proto__', '']) {
      for (const where of [{ turn: 't1' }, {}]) {
        const update = classifyFrame(refusalFrame(code, where));
        expect(successes, `${code} ${JSON.stringify(where)}`).not.toContain(update.kind);
        expect(update, code).toMatchObject({ kind: 'refused', refusal: 'unrecognised', endsTurn: true, code });
      }
    }
  });
});
