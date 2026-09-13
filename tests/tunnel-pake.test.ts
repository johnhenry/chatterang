// @vitest-environment node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { sha512 } from '@noble/hashes/sha2.js';
import { describe, expect, it } from 'vitest';

import {
  PakeError,
  SESSION_KEY_BYTES,
  beginExchange,
  calculateGenerator,
  channelIdentifier,
  computeConfirmation,
  finish,
  generatorString,
  prependLen,
  secretPoint,
} from '@chatterang/tunnel/pake';

/**
 * CPace (#130), against draft-irtf-cfrg-cpace-21's own test vectors.
 *
 * THE VECTORS ARE PARSED, NOT TRANSCRIBED, and that is a lesson rather than a
 * preference. The first attempt at this hand-copied `generator_string` out of
 * the draft's wrapped text and it failed — the computed value was 170 bytes,
 * exactly as the draft states, and the transcription had dropped two. The
 * draft ships base64-encoded JSON copies of every vector precisely because
 * that happens, so `tests/support/cpace-vectors.json` holds them decoded
 * verbatim and nothing here retypes a hex string.
 *
 * A cryptographic implementation that is subtly wrong still completes
 * successfully against itself. The vectors are the only thing in this file
 * that is not self-consistency.
 */

const VECTORS = JSON.parse(
  readFileSync(resolve(process.cwd(), 'tests/support/cpace-vectors.json'), 'utf8'),
) as {
  helpers: Record<string, string>[];
  generator: Record<string, string | number>;
  exchange: Record<string, string>;
  invalidY: Record<string, string | Record<string, string>>;
};

const unhex = (s: string) => Uint8Array.from(Buffer.from(s, 'hex'));
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex').toUpperCase();
const lvCat = (...p: Uint8Array[]) => {
  const parts = p.map(prependLen);
  const out = new Uint8Array(parts.reduce((n, x) => n + x.length, 0));
  let at = 0;
  for (const x of parts) { out.set(x, at); at += x.length; }
  return out;
};
const utf8 = (s: string) => new TextEncoder().encode(s);

describe('the string helpers, against Appendix A', () => {
  it('prepend_len matches every vector, including the multi-byte length', () => {
    const v = VECTORS.helpers[0]!;
    expect(hex(prependLen(new Uint8Array(0)))).toBe(v["prepend_len(b'')"]);
    expect(hex(prependLen(unhex(v["b'1234'"]!)))).toBe(v["prepend_len(b'1234')"]);
    // 127 bytes is the boundary: one length byte becomes two at 128.
    const long = Uint8Array.from({ length: 127 }, (_, i) => i);
    expect(hex(prependLen(long))).toBe(v['prepend_len(bytes(range(127)))']);
  });

  it('lv_cat matches, including an empty field in the middle', () => {
    // The empty field is the interesting one: a concatenation that dropped it
    // would produce a different byte string for a different input set, which
    // is exactly the ambiguity length prefixes exist to prevent.
    const v = VECTORS.helpers[1]!;
    const got = lvCat(unhex(v["b'1234'"]!), unhex(v["b'5'"]!), new Uint8Array(0), unhex(v["b'678'"]!));
    expect(hex(got)).toBe(v["lv_cat(b'1234',b'5',b'',b'678')"]);
  });
});

describe('the ristretto255 suite, against Appendix B.3', () => {
  const G = VECTORS.generator;
  const X = VECTORS.exchange;

  it('computes generator_string, its hash, and the generator', () => {
    const out = calculateGenerator(unhex(G['PRS'] as string), unhex(G['CI'] as string), unhex(G['sid'] as string));
    expect(hex(out.generatorString)).toBe(G['generator_string(G.DSI,PRS,CI,sid,H.s_in_bytes)']);
    expect(hex(out.hash)).toBe(G['hash result']);
    expect(hex(out.generator.toBytes())).toBe(G['encoded generator g']);
  });

  it('derives both public shares from the draft’s scalars', () => {
    const ci = unhex(X['CI']!);
    const sid = unhex(X['sid']!);
    const a = beginExchange({ role: 'initiator', code: unhex(X['PRS']!), ci, sid, scalar: unhex(X['ya']!), ad: unhex(X['ADa']!) });
    const b = beginExchange({ role: 'responder', code: unhex(X['PRS']!), ci, sid, scalar: unhex(X['yb']!), ad: unhex(X['ADb']!) });
    expect(hex(a.message)).toBe(X['Ya']);
    expect(hex(b.message)).toBe(X['Yb']);
  });

  it('computes the same secret point from either side', () => {
    expect(hex(secretPoint(unhex(X['ya']!), unhex(X['Yb']!)))).toBe(X['K']);
    expect(hex(secretPoint(unhex(X['yb']!), unhex(X['Ya']!)))).toBe(X['K']);
  });

  it('derives a session key that could only come from the draft’s ISK', () => {
    /*
     * The ISK is not exported — see the module header on why nothing that
     * yields key material is reachable without a peer tag. So it is verified
     * INDIRECTLY: the session key is a fixed derivation from the ISK, so
     * recomputing it here from the draft's ISK_IR and matching what finish()
     * returns pins the ISK exactly. A wrong ISK cannot produce this.
     */
    const ci = unhex(X['CI']!);
    const sid = unhex(X['sid']!);
    const a = beginExchange({ role: 'initiator', code: unhex(X['PRS']!), ci, sid, scalar: unhex(X['ya']!), ad: unhex(X['ADa']!) });
    const b = beginExchange({ role: 'responder', code: unhex(X['PRS']!), ci, sid, scalar: unhex(X['yb']!), ad: unhex(X['ADb']!) });

    const ca = computeConfirmation(a.pending, b.message, unhex(X['ADb']!));
    const cb = computeConfirmation(b.pending, a.message, unhex(X['ADa']!));

    const fromDraft = sha512(lvCat(utf8('CPaceRistretto255_SK/chatterang'), unhex(X['ISK_IR']!))).slice(0, SESSION_KEY_BYTES);
    expect(hex(finish(ca, cb.tag))).toBe(hex(fromDraft));
    expect(hex(finish(cb, ca.tag))).toBe(hex(fromDraft));
  });

  it('refuses every invalid Y the draft lists, and accepts the one it marks valid', () => {
    /*
     * CPace is the only candidate that ships NEGATIVE vectors, and this is the
     * paired-control discipline built into the spec itself: the same block
     * carries a "Valid" entry, so a check that refused everything would fail
     * here rather than pass.
     */
    const scalar = unhex(X['ya']!);
    let refused = 0;
    for (const [name, encoded] of Object.entries(VECTORS.invalidY)) {
      if (typeof encoded !== 'string') continue;
      expect(() => secretPoint(scalar, unhex(encoded)), `accepted ${name}`).toThrow(PakeError);
      refused += 1;
    }
    expect(refused, 'the fixture carried no invalid vectors').toBeGreaterThan(0);

    /*
     * The draft's own paired control, and it is a full sub-vector rather than
     * a bare encoding: its own scalar, its own point, and the answer. So this
     * checks that `scalar_mult_vfy` is right, not merely that it accepts.
     */
    const valid = VECTORS.invalidY['Valid'] as Record<string, string>;
    expect(hex(secretPoint(unhex(valid['s']!), unhex(valid['X']!)))).toBe(
      valid['G.scalar_mult_vfy(s,X)'],
    );
  });

  it('the draft’s own invalid set includes the identity, which is the case noble accepts', () => {
    // Invalid Y2 is 32 zero bytes. Worth naming: the spec authors chose to
    // vector exactly the encoding the library does not reject on its own.
    expect(VECTORS.invalidY['Invalid Y2']).toBe('0'.repeat(64));
  });
});

describe('the identity abort, which the library does not make for us', () => {
  it('refuses an all-zero peer share', () => {
    /*
     * MEASURED: ristretto255.Point.fromBytes(new Uint8Array(32)) returns a
     * point whose is0() is true rather than throwing. So CPace's "MUST abort
     * if K is the identity" is the application's job, and it is the scheme's
     * one silent-failure point — a wrong implementation still completes
     * against itself.
     */
    const error = (() => {
      try { secretPoint(unhex(VECTORS.exchange['ya']!), new Uint8Array(32)); return null; }
      catch (caught) { return caught as PakeError; }
    })();
    expect(error).toBeInstanceOf(PakeError);
    expect(error?.reason).toBe('degenerate-shared-point');
  });
});

describe('key confirmation, which CPace does not mandate', () => {
  const ci = channelIdentifier({ initiator: 'phone', responder: 'desktop' });
  const sid = unhex('7e4b4791d6a8ef019b936c79fb7f2c57');
  const scalarA = unhex(VECTORS.exchange['ya']!);
  const scalarB = unhex(VECTORS.exchange['yb']!);

  const run = (codeA: string, codeB: string, ciA = ci, ciB = ci) => {
    const a = beginExchange({ role: 'initiator', code: codeA, ci: ciA, sid, scalar: scalarA });
    const b = beginExchange({ role: 'responder', code: codeB, ci: ciB, sid, scalar: scalarB });
    const ca = computeConfirmation(a.pending, b.message);
    const cb = computeConfirmation(b.pending, a.message);
    return { ca, cb };
  };

  it('agrees on a key when both sides typed the same code', () => {
    const { ca, cb } = run('418329', '418329');
    const keyA = finish(ca, cb.tag);
    const keyB = finish(cb, ca.tag);
    expect(hex(keyA)).toBe(hex(keyB));
    expect(keyA).toHaveLength(SESSION_KEY_BYTES);
  });

  it('fails confirmation when the codes differ by one digit', () => {
    // The whole point of the scheme: a wrong guess fails, and the failure
    // carries no information about how wrong it was.
    const { ca, cb } = run('418329', '418328');
    expect(() => finish(ca, cb.tag)).toThrow(PakeError);
    expect(() => finish(cb, ca.tag)).toThrow(PakeError);
  });

  it('names confirmation failure distinctly from a malformed message', () => {
    const { ca, cb } = run('418329', '999999');
    try { finish(ca, cb.tag); expect.unreachable(); }
    catch (e) { expect((e as PakeError).reason).toBe('confirmation-failed'); }
  });
});

describe('channel binding — #256, and what it is for', () => {
  const sid = unhex('7e4b4791d6a8ef019b936c79fb7f2c57');
  const scalarA = unhex(VECTORS.exchange['ya']!);
  const scalarB = unhex(VECTORS.exchange['yb']!);
  const SPKI_REAL = sha512(utf8('the desktop’s real certificate')).slice(0, 32);
  const SPKI_MITM = sha512(utf8('an attacker’s own certificate')).slice(0, 32);

  const exchange = (spkiA: Uint8Array, spkiB: Uint8Array) => {
    const code = '418329';
    const a = beginExchange({ role: 'initiator', code, ci: channelIdentifier({ initiator: 'phone', responder: 'desktop', spki: spkiA }), sid, scalar: scalarA });
    const b = beginExchange({ role: 'responder', code, ci: channelIdentifier({ initiator: 'phone', responder: 'desktop', spki: spkiB }), sid, scalar: scalarB });
    return { ca: computeConfirmation(a.pending, b.message), cb: computeConfirmation(b.pending, a.message) };
  };

  it('fails when the two sides negotiated DIFFERENT certificates', () => {
    /*
     * THE MITM CASE, and it is testable in-process without a network. An
     * attacker in the path terminates two TLS connections with two
     * certificates, so each honest party binds a different SPKI into CI,
     * derives a different key, and confirmation fails — even though BOTH
     * sides knew the correct code, which is precisely the situation a PAKE
     * alone does not detect.
     */
    const { ca, cb } = exchange(SPKI_REAL, SPKI_MITM);
    expect(() => finish(ca, cb.tag)).toThrow(PakeError);
  });

  it('succeeds when they negotiated the same one — the paired control', () => {
    // Without this the test above passes on a binding that breaks everything.
    const { ca, cb } = exchange(SPKI_REAL, SPKI_REAL);
    expect(hex(finish(ca, cb.tag))).toBe(hex(finish(cb, ca.tag)));
  });

  it('an unbound exchange and a bound one are different exchanges', () => {
    // If omitting the SPKI produced the same key as including it, the binding
    // would be decoration. This is what makes #256's wiring load-bearing.
    const bound = exchange(SPKI_REAL, SPKI_REAL);
    const code = '418329';
    const ci = channelIdentifier({ initiator: 'phone', responder: 'desktop' });
    const a = beginExchange({ role: 'initiator', code, ci, sid, scalar: scalarA });
    const b = beginExchange({ role: 'responder', code, ci, sid, scalar: scalarB });
    const unbound = { ca: computeConfirmation(a.pending, b.message), cb: computeConfirmation(b.pending, a.message) };
    expect(hex(finish(bound.ca, bound.cb.tag))).not.toBe(hex(finish(unbound.ca, unbound.cb.tag)));
  });
});

describe('the API shape is the security property', () => {
  it('exports no function that returns a session key without a peer tag', async () => {
    /*
     * The structural claim from the ruling, asserted rather than trusted.
     * wsh #35/#39/#40 are three closed issues of the form "this guard can be
     * deleted and the suite stays green" — an exported deriveIsk() beside an
     * exported verifyTag() is that failure waiting for an integrator who
     * calls the first and forgets the second.
     *
     * `finish` is the only exported name that yields key material, and it
     * cannot be called without something to compare.
     */
    const mod = await import('@chatterang/tunnel/pake');
    const exported = Object.keys(mod).filter((k) => typeof (mod as Record<string, unknown>)[k] === 'function');
    expect(exported.sort()).toEqual([
      // A class, not a function that returns anything.
      'PakeError',
      'beginExchange',
      'calculateGenerator',
      'channelIdentifier',
      'computeConfirmation',
      'finish',
      'generatorString',
      'prependLen',
      'secretPoint',
    ]);
    // Of those, the ones that touch secrets return a point or a tag, never a key.
    const ci = channelIdentifier({ initiator: 'a', responder: 'b' });
    const sid = new Uint8Array(16);
    const a = beginExchange({ role: 'initiator', code: 'x', ci, sid, scalar: unhex(VECTORS.exchange['ya']!) });
    expect(Object.keys(a.pending).sort()).toEqual(['ad', 'message', 'role', 'scalar', 'sid']);
  });

  it('rejects a scalar that is not 32 bytes rather than padding it', () => {
    const ci = channelIdentifier({ initiator: 'a', responder: 'b' });
    for (const n of [0, 16, 31, 33]) {
      expect(() =>
        beginExchange({ role: 'initiator', code: 'x', ci, sid: new Uint8Array(16), scalar: new Uint8Array(n) }),
      ).toThrow(PakeError);
    }
    expect(() =>
      beginExchange({ role: 'initiator', code: 'x', ci, sid: new Uint8Array(16), scalar: new Uint8Array(32).fill(3) }),
    ).not.toThrow();
  });

  it('generatorString is exported for the vectors and yields no secret', () => {
    expect(generatorString(utf8('pw'), utf8('ci'), new Uint8Array(4))).toBeInstanceOf(Uint8Array);
  });
});

describe('the two properties a mutation survived, and what each is worth', () => {
  const ci = channelIdentifier({ initiator: 'phone', responder: 'desktop' });
  const sid = unhex('7e4b4791d6a8ef019b936c79fb7f2c57');
  const pair = () => {
    const a = beginExchange({ role: 'initiator', code: '418329', ci, sid, scalar: unhex(VECTORS.exchange['ya']!) });
    const b = beginExchange({ role: 'responder', code: '418329', ci, sid, scalar: unhex(VECTORS.exchange['yb']!) });
    return { ca: computeConfirmation(a.pending, b.message), cb: computeConfirmation(b.pending, a.message) };
  };

  it('gives each role a DIFFERENT tag, so a reflected one cannot pass', () => {
    /*
     * FOUND BY MUTATION: making both roles compute one tag left the whole
     * suite green, because a shared tag still matches on both sides. What it
     * loses is reflection resistance — an attacker who has to produce a valid
     * tag can simply echo back the one they just received, without knowing
     * the key or the code.
     *
     * That is the same class as wsh #35: "the E2E nonce role tag is computed,
     * stored, and never read — the receive path cannot reject a reflected
     * frame." Same defect, one repo over, already closed there.
     */
    const { ca, cb } = pair();
    expect(hex(ca.tag)).not.toBe(hex(cb.tag));

    // Reflection: hand each side back its own tag rather than the peer's.
    expect(() => finish(ca, ca.tag)).toThrow(PakeError);
    expect(() => finish(cb, cb.tag)).toThrow(PakeError);

    // The control: the peer's real tag still works, so this is not refusing all.
    expect(() => finish(ca, cb.tag)).not.toThrow();
  });

  it('compares tags without short-circuiting — a guard that CANNOT fail here', () => {
    /*
     * SAID PLAINLY BECAUSE IT IS THE WEAK ONE. Replacing the constant-time
     * compare with an early-return leaves this suite green, and no assertion
     * over inputs and outputs can distinguish them: both answer the same
     * booleans. Timing is not observable from a unit test, and a timing
     * measurement in CI would be a flake generator rather than a guard.
     *
     * So this reads the source, which proves only that nobody edited it to
     * short-circuit. It is worth having anyway — the realistic way this
     * regresses is somebody "simplifying" the loop, and that is exactly what
     * a source check catches — but it must not be mistaken for evidence that
     * the comparison IS constant-time in the engine, which neither this nor
     * anything else in this repo establishes.
     */
    const source = readFileSync(resolve(process.cwd(), 'packages/tunnel/src/pake/index.ts'), 'utf8');
    const body = source.slice(source.indexOf('function equalCt'));
    const fn = body.slice(0, body.indexOf('\n}'));
    expect(fn).toContain('diff |=');
    expect(fn, 'equalCt returns early on a byte difference').not.toMatch(/for\s*\([^)]*\)\s*\{[^}]*return/);
  });
});
