import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  ADDRESS_IPV4,
  DEFAULT_WINDOW_MS,
  HOST_DESKTOP,
  TRUST_SPKI_PIN,
  decodePairingUri,
  encodePairingUri,
} from '@chatterang/tunnel/pairing';
import { generatePackets, prepareSource, type OatPacket } from '@/lib/oat-fountain';
import { framesForPairingUri } from '@/lib/pairing-frames';
import type { FrameRead } from '@/lib/qr-decode';
import {
  HAVE_CURRENT_DATA,
  MIN_SCAN_GAP_MS,
  classifyPacket,
  createFrameGrabber,
  openCamera,
  openFountainSession,
  startQrScan,
  type FrameSession,
  type ScanEnd,
} from '@/lib/qr-scan';

/**
 * #128: the camera scan loop's privacy behaviour, proven without a UI.
 *
 * Every stop path is tested, because a camera left running is a privacy defect:
 * the usage string promises the person nothing the camera sees goes anywhere,
 * and an indicator light that stays on after they closed the sheet breaks that
 * promise in the only way they can see.
 *
 * #127: a pairing code is OAT frames now, so the loop holds a decoder session
 * between frames. The same promise covers it — every stop path releases it —
 * and a hostile or foreign frame must not be able to hang, crash or hijack it.
 */

const VALID_URI = encodePairingUri({
  version: 1,
  hostKind: HOST_DESKTOP,
  trustMode: TRUST_SPKI_PIN,
  trust: new Uint8Array(32).fill(1),
  token: new Uint8Array(32).fill(2),
  expiresAt: 1_900_000_000,
  port: 8973,
  addresses: [{ kind: ADDRESS_IPV4, value: Uint8Array.of(192, 168, 1, 4) }],
  name: 'Desk',
});

/** One frame of `uri` as the desktop draws it: a complete packet. */
async function frameOf(uri: string): Promise<FrameRead> {
  return { kind: 'packet', packet: (await framesForPairingUri(uri)).next().value };
}

const VALID: FrameRead = await frameOf(VALID_URI);
const OTHER: FrameRead = { kind: 'other' };

/** `uri` drawn in `blockSize` blocks: a many-frame code, with a chosen artifact id. */
function codeInBlocks(uri: string, blockSize: number, id = 3): () => FrameRead {
  const bytes = Uint8Array.from(uri, (c) => c.charCodeAt(0));
  let seed = 1;
  const packets = generatePackets(prepareSource(bytes, blockSize, new Uint8Array(16).fill(id)), () => seed++);
  return () => ({ kind: 'packet', packet: packets.next().value });
}

/** A packet whose header says whatever the test says — a hostile frame, in effect. */
function forged(over: Partial<OatPacket>): FrameRead {
  const blockSize = over.blockSize ?? 16;
  return {
    kind: 'packet',
    packet: {
      version: 1,
      artifactId: new Uint8Array(16).fill(0x66),
      codec: 'qr-fountain',
      fecScheme: 'lt',
      seed: 1,
      sourceBlockCount: 1,
      blockSize,
      totalLength: blockSize,
      payload: new Uint8Array(Math.min(blockSize, 1024)),
      ...over,
    },
  };
}

/** The real session, with its release watched. */
function watchedSessions() {
  const opened: { readonly release: ReturnType<typeof vi.fn> }[] = [];
  const openSession = vi.fn(async (packet: OatPacket): Promise<FrameSession> => {
    const real = await openFountainSession(packet);
    const release = vi.fn(() => real.release());
    opened.push({ release });
    return { addPacket: (p) => real.addPacket(p), reconstruct: () => real.reconstruct(), release };
  });
  return { openSession, opened };
}

class FakeTrack {
  stop = vi.fn();
  listeners = new Map<string, Set<() => void>>();
  addEventListener(type: string, fn: () => void) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(fn);
  }
  removeEventListener(type: string, fn: () => void) {
    this.listeners.get(type)?.delete(fn);
  }
  fire(type: string) {
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn();
  }
  count() {
    return [...this.listeners.values()].reduce((n, s) => n + s.size, 0);
  }
}

/** A scheduler the test drives by hand, so no real time passes. */
function fakeScheduler() {
  const queue: { run: () => void; ms: number; cancelled: boolean }[] = [];
  return {
    queue,
    schedule: (run: () => void, ms: number) => {
      const entry = { run, ms, cancelled: false };
      queue.push(entry);
      return () => {
        entry.cancelled = true;
      };
    },
    /** Run the next live timer. Returns its delay, or null if none. */
    step(): number | null {
      while (queue.length) {
        const entry = queue.shift()!;
        if (!entry.cancelled) {
          entry.run();
          return entry.ms;
        }
      }
      return null;
    },
    live: () => queue.filter((e) => !e.cancelled).length,
  };
}

/**
 * Let promises settle. A session's decoder is loaded with `import()`, which is
 * a few turns even when the module is cached, so one macrotask is not enough.
 */
const flush = async () => {
  for (let i = 0; i < 5; i += 1) await new Promise<void>((r) => setTimeout(r, 0));
};

function setup(
  overrides: {
    decode?: (f: unknown) => Promise<FrameRead | null>;
    openSession?: (packet: OatPacket) => Promise<FrameSession>;
    readyState?: number;
    videoWidth?: number;
    hidden?: boolean;
  } = {},
) {
  const track = new FakeTrack();
  const video = { readyState: overrides.readyState ?? HAVE_CURRENT_DATA, videoWidth: overrides.videoWidth ?? 640, videoHeight: 480, srcObject: {} as unknown };
  const grabber = { grab: vi.fn(() => ({ data: new Uint8ClampedArray(4), width: 1, height: 1 })), release: vi.fn() };
  const scheduler = fakeScheduler();
  let clock = 0;
  const ends: ScanEnd[] = [];
  const onResult = vi.fn();
  const onHint = vi.fn();
  const decode = vi.fn(overrides.decode ?? (async () => null));
  const handle = startQrScan({
    stream: { getTracks: () => [track] },
    video,
    grabber,
    decode,
    ...(overrides.openSession ? { openSession: overrides.openSession } : {}),
    onResult,
    onHint,
    onEnd: (end) => ends.push(end),
    schedule: scheduler.schedule,
    now: () => clock,
    isHidden: () => overrides.hidden ?? false,
  });
  return { track, video, grabber, scheduler, ends, onResult, onHint, decode, handle, advance: (ms: number) => { clock += ms; } };
}

describe('every exit turns the camera off', () => {
  it('on a result — and BEFORE the payload is handed up', async () => {
    const s = setup({ decode: async () => VALID });
    let trackStoppedFirst = false;
    s.onResult.mockImplementation(() => {
      trackStoppedFirst = s.track.stop.mock.calls.length === 1 && s.video.srcObject === null;
    });
    s.scheduler.step();
    await flush();
    expect(s.onResult).toHaveBeenCalledOnce();
    expect(s.onResult.mock.calls[0]![0].name).toBe('Desk');
    expect(trackStoppedFirst, 'the camera was still on when the payload was handed up').toBe(true);
    expect(s.ends).toEqual([{ reason: 'result' }]);
    expect(s.grabber.release).toHaveBeenCalledOnce();
  });

  it('on cancel', () => {
    const s = setup();
    s.handle.stop();
    expect(s.track.stop).toHaveBeenCalledOnce();
    expect(s.video.srcObject).toBeNull();
    expect(s.ends).toEqual([{ reason: 'cancelled' }]);
  });

  it('when the OS ends or mutes the track', () => {
    for (const type of ['ended', 'mute']) {
      const s = setup();
      s.track.fire(type);
      expect(s.track.stop, type).toHaveBeenCalledOnce();
      expect(s.ends, type).toEqual([{ reason: 'track-ended' }]);
    }
  });

  it('when the decoder itself fails', async () => {
    const s = setup({ decode: async () => { throw new Error('chunk failed to load'); } });
    s.scheduler.step();
    await flush();
    expect(s.track.stop).toHaveBeenCalledOnce();
    expect(s.ends).toEqual([{ reason: 'decode-failed' }]);
  });

  it('when a pairing code is malformed, and names why', async () => {
    const s = setup({ decode: async () => frameOf('chatterang-pair:!!!') });
    s.scheduler.step();
    await flush();
    expect(s.track.stop).toHaveBeenCalledOnce();
    expect(s.ends).toHaveLength(1);
    expect(s.ends[0]!.reason).toBe('invalid-code');
    expect(s.ends[0]!.error).toBeTruthy();
  });

  it('after the pairing window, because any code shown at the start has expired', () => {
    const s = setup();
    s.advance(DEFAULT_WINDOW_MS);
    s.scheduler.step();
    expect(s.track.stop).toHaveBeenCalledOnce();
    expect(s.ends).toEqual([{ reason: 'idle-timeout' }]);
  });

  it('stops once however many things ask, and removes its listeners', () => {
    const s = setup();
    s.handle.stop();
    s.handle.stop();
    s.track.fire('ended');
    expect(s.track.stop).toHaveBeenCalledOnce();
    expect(s.ends).toHaveLength(1);
    expect(s.track.count()).toBe(0);
    expect(s.handle.stopped).toBe(true);
  });
});

describe('nothing happens after stop', () => {
  it('grabs no frame and schedules nothing', () => {
    const s = setup();
    s.handle.stop();
    expect(s.scheduler.step()).toBeNull();
    expect(s.grabber.grab).not.toHaveBeenCalled();
  });

  it('drops a result that lands after stop', async () => {
    let resolve!: (v: FrameRead) => void;
    const s = setup({ decode: () => new Promise<FrameRead>((r) => { resolve = r; }) });
    s.scheduler.step();
    s.handle.stop();
    resolve(VALID);
    await flush();
    expect(s.onResult).not.toHaveBeenCalled();
    expect(s.ends).toEqual([{ reason: 'cancelled' }]);
  });

  it('shows no hint for a QR code that decodes after stop', async () => {
    /*
     * FOUND BY MUTATION. Deleting the loop's "drop late results" early return
     * survived every other test, because a late PAIRING result is also blocked
     * by the stop latch and a late blank frame by the scheduler. A late
     * NON-pairing code has no second guard: without the early return, a sheet
     * the person already closed would flash "that isn't a pairing code".
     */
    let resolve!: (v: FrameRead) => void;
    const s = setup({ decode: () => new Promise<FrameRead>((r) => { resolve = r; }) });
    s.scheduler.step();
    s.handle.stop();
    resolve(OTHER);
    await flush();
    expect(s.onHint).not.toHaveBeenCalled();
  });
});

describe('the loop does not burn the CPU', () => {
  it('never overlaps: a decode that has not settled means no second one', () => {
    const s = setup({ decode: () => new Promise<FrameRead | null>(() => {}) });
    s.scheduler.step();
    expect(s.decode).toHaveBeenCalledOnce();
    expect(s.scheduler.live()).toBe(0);
  });

  it('waits the floor after a fast decode', async () => {
    const s = setup({ decode: async () => null });
    s.scheduler.step();
    await flush();
    expect(s.scheduler.queue.at(-1)!.ms).toBe(MIN_SCAN_GAP_MS);
  });

  it('waits as long as the decode took, after a slow one', async () => {
    // The adaptive half: on a device where a frame takes 300 ms, the loop
    // follows the decoder instead of queueing behind it.
    let s!: ReturnType<typeof setup>;
    s = setup({ decode: async () => { s.advance(300); return null; } });
    s.scheduler.step();
    await flush();
    expect(s.scheduler.queue.at(-1)!.ms).toBe(300);
  });

  it('skips the decode when there is no frame yet, or no one is looking', () => {
    for (const o of [{ readyState: HAVE_CURRENT_DATA - 1 }, { videoWidth: 0 }, { hidden: true }]) {
      const s = setup(o);
      s.scheduler.step();
      expect(s.grabber.grab, JSON.stringify(o)).not.toHaveBeenCalled();
      expect(s.decode, JSON.stringify(o)).not.toHaveBeenCalled();
      expect(s.scheduler.live(), JSON.stringify(o)).toBe(1);
    }
  });

  it('keeps scanning past a QR code that is not a pairing code, with a hint', async () => {
    const s = setup({ decode: async () => OTHER });
    s.scheduler.step();
    await flush();
    expect(s.onHint).toHaveBeenCalledWith('not-a-pairing-code');
    expect(s.track.stop).not.toHaveBeenCalled();
    expect(s.scheduler.live()).toBe(1);
  });
});

describe('a pairing code is OAT packets, collected (#127)', () => {
  it('one frame is the whole code: delivered once, with the session released first', async () => {
    const { openSession, opened } = watchedSessions();
    const s = setup({ decode: async () => VALID, openSession });
    let releasedFirst = false;
    s.onResult.mockImplementation(() => {
      releasedFirst = opened[0]?.release.mock.calls.length === 1;
    });
    s.scheduler.step();
    await flush();
    expect(s.onResult).toHaveBeenCalledOnce();
    expect(releasedFirst, 'the decoder session was still held when the payload was handed up').toBe(true);
    expect(openSession).toHaveBeenCalledOnce();
    expect(s.ends).toEqual([{ reason: 'result' }]);
    expect(s.scheduler.step()).toBeNull();
  });

  it('a code drawn in smaller blocks still completes, from enough of its frames, once', async () => {
    const { openSession, opened } = watchedSessions();
    const next = codeInBlocks(VALID_URI, 16);
    const s = setup({ decode: async () => next(), openSession });
    for (let i = 0; i < 300 && s.ends.length === 0; i += 1) {
      s.scheduler.step();
      await flush();
    }
    expect(s.onResult).toHaveBeenCalledOnce();
    expect(s.onResult.mock.calls[0]![0].name).toBe('Desk');
    expect(s.decode.mock.calls.length).toBeGreaterThan(1);
    expect(openSession).toHaveBeenCalledOnce();
    expect(opened[0]!.release).toHaveBeenCalledOnce();
    expect(s.onHint).not.toHaveBeenCalled();
  });

  it('a repeated frame is harmless: no hint, no ending, and the code still completes once', async () => {
    const next = codeInBlocks(VALID_URI, 16);
    const first = next();
    const reads = [first, first, first];
    const s = setup({ decode: async () => reads.shift() ?? next() });
    for (let i = 0; i < 300 && s.ends.length === 0; i += 1) {
      s.scheduler.step();
      await flush();
    }
    expect(s.onHint).not.toHaveBeenCalled();
    expect(s.onResult).toHaveBeenCalledOnce();
    expect(s.ends).toEqual([{ reason: 'result' }]);
  });

  describe('a partial code is released however the scan ends', () => {
    /*
     * FOUND BY MUTATION, the reason this block exists: with `dropSession()`
     * removed from teardown, every test above still passed, because a
     * complete code releases its session on the completion path. Only a code
     * that is PART-collected when the scan ends proves the ending releases it.
     */
    const endings: readonly [string, (s: ReturnType<typeof setup>) => void | Promise<void>, ScanEnd['reason']][] = [
      ['cancel, which is also the pane going to the background or closing', (s) => s.handle.stop(), 'cancelled'],
      ['the OS ending the track', (s) => s.track.fire('ended'), 'track-ended'],
      ['the idle timeout', (s) => { s.advance(DEFAULT_WINDOW_MS); s.scheduler.step(); }, 'idle-timeout'],
      ['the decoder failing on the next frame', async (s) => {
        s.decode.mockImplementation(async () => { throw new Error('chunk failed to load'); });
        s.scheduler.step();
        await flush();
      }, 'decode-failed'],
    ];

    for (const [label, end, reason] of endings) {
      it(label, async () => {
        const { openSession, opened } = watchedSessions();
        const next = codeInBlocks(VALID_URI, 16);
        const s = setup({ decode: async () => next(), openSession });
        s.scheduler.step();
        await flush();
        expect(opened).toHaveLength(1);
        expect(opened[0]!.release).not.toHaveBeenCalled();
        expect(s.ends).toEqual([]);

        await end(s);
        expect(s.ends.map((e) => e.reason)).toEqual([reason]);
        expect(opened[0]!.release).toHaveBeenCalledOnce();
        expect(s.track.stop).toHaveBeenCalledOnce();
      });
    }

    it('a complete code that is malformed is released before the ending is reported', async () => {
      const { openSession, opened } = watchedSessions();
      const read = await frameOf('chatterang-pair:!!!');
      const s = setup({ decode: async () => read, openSession });
      let releasedFirst = false;
      const ends = s.ends;
      ends.push = (...items) => {
        releasedFirst = opened[0]?.release.mock.calls.length === 1;
        return Array.prototype.push.apply(ends, items);
      };
      s.scheduler.step();
      await flush();
      expect(s.ends.map((e) => e.reason)).toEqual(['invalid-code']);
      expect(releasedFirst).toBe(true);
    });

    it('a session that finishes loading after the scan stopped is released, not kept', async () => {
      let resolveOpen!: (session: FrameSession) => void;
      const release = vi.fn();
      const addPacket = vi.fn(() => true);
      const s = setup({
        decode: async () => VALID,
        openSession: () => new Promise<FrameSession>((r) => { resolveOpen = r; }),
      });
      s.scheduler.step();
      await flush();
      s.handle.stop();
      resolveOpen({ addPacket, reconstruct: () => new Uint8Array(), release });
      await flush();
      expect(release).toHaveBeenCalledOnce();
      expect(addPacket).not.toHaveBeenCalled();
      expect(s.onResult).not.toHaveBeenCalled();
      expect(s.ends).toEqual([{ reason: 'cancelled' }]);
    });
  });

  describe('a packet from another code', () => {
    it('replaces the code being collected, and the newcomer is delivered on its first frame', async () => {
      /*
       * THE DECISION, pinned. Ignoring the newcomer would tie the phone to a
       * code the desktop may have withdrawn until the idle timeout; replacing
       * costs nothing when every frame is complete.
       */
      const { openSession, opened } = watchedSessions();
      const other = encodePairingUri({ ...decodePairingUri(VALID_URI), name: 'Other desk' });
      const partial = codeInBlocks(VALID_URI, 16, 1);
      const newcomer = await frameOf(other);
      const reads = [partial(), newcomer];
      const s = setup({ decode: async () => reads.shift() ?? null, openSession });

      s.scheduler.step();
      await flush();
      expect(opened).toHaveLength(1);

      s.scheduler.step();
      await flush();
      expect(opened[0]!.release).toHaveBeenCalledOnce();
      expect(openSession).toHaveBeenCalledTimes(2);
      expect(s.onResult).toHaveBeenCalledOnce();
      expect(s.onResult.mock.calls[0]![0].name).toBe('Other desk');
    });

    it('with the same artifact id but another shape is another code too, and does not throw', async () => {
      const { openSession, opened } = watchedSessions();
      const partial = codeInBlocks(VALID_URI, 16, 5);
      const bytes = Uint8Array.from(VALID_URI, (c) => c.charCodeAt(0));
      const reshaped: FrameRead = {
        kind: 'packet',
        packet: generatePackets(prepareSource(bytes, bytes.length, new Uint8Array(16).fill(5))).next().value,
      };
      const reads = [partial(), reshaped];
      const s = setup({ decode: async () => reads.shift() ?? null, openSession });
      s.scheduler.step();
      await flush();
      s.scheduler.step();
      await flush();
      expect(opened[0]!.release).toHaveBeenCalledOnce();
      expect(s.onResult).toHaveBeenCalledOnce();
      expect(s.ends).toEqual([{ reason: 'result' }]);
    });

    it('with the same shape but another artifact id is another code: the held session is let go, never fed', async () => {
      /*
       * THE ARTIFACT-ID COMPARISON, pinned in the loop. OAT's own decoder
       * accepts a packet of the same shape from another artifact without a
       * word (`tests/pairing-frames.test.ts`), and two codes for one host
       * differ only in their token, so they ARE the same shape. Feeding one
       * code's blocks to another's session would rebuild neither.
       *
       * FOUND BY MUTATION: with the comparison replaced by `return true`,
       * every other test still passed.
       */
      const { openSession, opened } = watchedSessions();
      const dusk = encodePairingUri({ ...decodePairingUri(VALID_URI), name: 'Dusk', token: new Uint8Array(32).fill(9) });
      expect(dusk.length).toBe(VALID_URI.length);
      const desk = codeInBlocks(VALID_URI, 16, 1);
      const other = codeInBlocks(dusk, 16, 2);
      const reads = [desk()];
      const s = setup({ decode: async () => reads.shift() ?? other(), openSession });

      s.scheduler.step();
      await flush();
      expect(opened).toHaveLength(1);
      expect(s.ends).toEqual([]);

      s.scheduler.step();
      await flush();
      expect(opened[0]!.release, 'the first code was not let go').toHaveBeenCalledOnce();
      expect(openSession).toHaveBeenCalledTimes(2);

      for (let i = 0; i < 300 && s.ends.length === 0; i += 1) {
        s.scheduler.step();
        await flush();
      }
      expect(s.ends).toEqual([{ reason: 'result' }]);
      expect(s.onResult).toHaveBeenCalledOnce();
      expect(s.onResult.mock.calls[0]![0].name).toBe('Dusk');
      expect(s.onHint).not.toHaveBeenCalled();
    });

    it('never crashes the loop: a session that throws is dropped and reading goes on', async () => {
      /*
       * OAT's decoder throws on a packet of another shape. The loop replaces
       * a mismatched session before that can happen, so this forces the throw
       * with a session that always does — the case of a decoder that rejects
       * a packet for a reason this build does not foresee.
       */
      const release = vi.fn();
      const reads: FrameRead[] = [VALID, VALID];
      let opens = 0;
      const s = setup({
        decode: async () => reads.shift() ?? null,
        openSession: async (packet) => {
          opens += 1;
          if (opens === 1) {
            return { addPacket: () => { throw new Error('packet does not belong to this decode session'); }, reconstruct: () => new Uint8Array(), release };
          }
          return openFountainSession(packet);
        },
      });
      s.scheduler.step();
      await flush();
      expect(release).toHaveBeenCalledOnce();
      expect(s.ends).toEqual([]);
      expect(s.onHint).not.toHaveBeenCalled();
      expect(s.scheduler.live()).toBe(1);

      s.scheduler.step();
      await flush();
      expect(s.onResult).toHaveBeenCalledOnce();
    });
  });

  describe('a header that describes no pairing code', () => {
    it('that could hang the decoder never reaches it, and is ignored without a word', async () => {
      /*
       * OAT 0.1.0's `decodePacket` passes a block count of fifty million, and
       * `new FountainDecoder(50_000_000, …)` fills an array that long before it
       * looks at anything else. The loop must refuse it first.
       */
      const openSession = vi.fn(openFountainSession);
      for (const hostile of [
        forged({ sourceBlockCount: 50_000_000, blockSize: 16, totalLength: 50 }),
        forged({ sourceBlockCount: 0xffffffff, blockSize: 1, totalLength: 1 }),
        forged({ sourceBlockCount: 1, blockSize: 16, totalLength: 0 }),
        forged({ sourceBlockCount: 1, blockSize: 16, totalLength: 17 }),
        forged({ blockSize: 16, payload: new Uint8Array(15) }),
      ]) {
        const s = setup({ decode: async () => hostile, openSession });
        const started = Date.now();
        s.scheduler.step();
        await flush();
        expect(Date.now() - started).toBeLessThan(1_000);
        expect(openSession).not.toHaveBeenCalled();
        expect(s.onHint).not.toHaveBeenCalled();
        expect(s.ends).toEqual([]);
        expect(s.scheduler.live()).toBe(1);
      }
    });

    it('that is a real OAT transfer of something larger gets the hint, and no session', async () => {
      const openSession = vi.fn(openFountainSession);
      const s = setup({ decode: async () => forged({ sourceBlockCount: 5, blockSize: 200, totalLength: 1_000 }), openSession });
      s.scheduler.step();
      await flush();
      expect(s.onHint).toHaveBeenCalledWith('not-a-pairing-code');
      expect(openSession).not.toHaveBeenCalled();
      expect(s.scheduler.live()).toBe(1);
    });

    it('classifies each shape by what it describes', () => {
      const verdict = (over: Partial<OatPacket>) => classifyPacket((forged(over) as { packet: OatPacket }).packet);
      expect(verdict({ blockSize: 130, totalLength: 130 })).toBe('pairing');
      expect(verdict({ sourceBlockCount: 9, blockSize: 16, totalLength: 130 })).toBe('pairing');
      expect(verdict({ blockSize: 300, totalLength: 300 })).toBe('pairing');
      expect(verdict({ blockSize: 301, totalLength: 301 })).toBe('too-large');
      expect(verdict({ sourceBlockCount: 4, blockSize: 300, totalLength: 1_000 })).toBe('too-large');
      expect(verdict({ sourceBlockCount: 9, blockSize: 16, totalLength: 129 })).toBe('pairing');
      expect(verdict({ sourceBlockCount: 10, blockSize: 16, totalLength: 130 })).toBe('malformed');
      expect(verdict({ sourceBlockCount: 0, blockSize: 16, totalLength: 16 })).toBe('malformed');
      expect(verdict({ artifactId: new Uint8Array(15) })).toBe('malformed');
    });
  });

  describe('a code that completes and is not a pairing code', () => {
    it('gets the hint when its text is not a pairing URI, lets go of it, and scanning goes on', async () => {
      /*
       * The one completion that does not end the scan, so the one where
       * nothing else would release the session: teardown never runs.
       */
      const { openSession, opened } = watchedSessions();
      const read = await frameOf('https://example.com/menu');
      const s = setup({ decode: async () => read, openSession });
      s.scheduler.step();
      await flush();
      expect(s.onHint).toHaveBeenCalledWith('not-a-pairing-code');
      expect(opened[0]!.release).toHaveBeenCalledOnce();
      expect(s.ends).toEqual([]);
      expect(s.scheduler.live()).toBe(1);
    });

    it('gets the hint when its bytes are not text at all', async () => {
      const bytes = Uint8Array.of(0xff, 0x00, 0x10, 0x80);
      const read: FrameRead = { kind: 'packet', packet: generatePackets(prepareSource(bytes, bytes.length, new Uint8Array(16))).next().value };
      const s = setup({ decode: async () => read });
      s.scheduler.step();
      await flush();
      expect(s.onHint).toHaveBeenCalledWith('not-a-pairing-code');
      expect(s.ends).toEqual([]);
    });
  });

  it('a decoder that cannot load ends the scan, with the camera off', async () => {
    const s = setup({ decode: async () => VALID, openSession: async () => { throw new Error('chunk failed to load'); } });
    s.scheduler.step();
    await flush();
    expect(s.ends).toEqual([{ reason: 'decode-failed' }]);
    expect(s.track.stop).toHaveBeenCalledOnce();
  });
});

describe('opening the camera', () => {
  it('asks for the rear camera and no microphone', async () => {
    const getUserMedia = vi.fn(async () => ({}) as MediaStream);
    await openCamera({ getUserMedia });
    expect(getUserMedia).toHaveBeenCalledWith({ audio: false, video: { facingMode: { ideal: 'environment' } } });
  });

  it('names each failure by DOMException name, never as "you denied"', async () => {
    const cases: [string, string][] = [
      ['NotAllowedError', 'denied'], ['SecurityError', 'denied'],
      ['NotFoundError', 'no-camera'], ['OverconstrainedError', 'no-camera'],
      ['NotReadableError', 'busy'], ['AbortError', 'busy'],
      ['SomethingNew', 'failed'],
    ];
    for (const [name, kind] of cases) {
      const outcome = await openCamera({ getUserMedia: async () => { throw Object.assign(new Error('x'), { name }); } });
      expect(outcome.kind, name).toBe(kind);
    }
  });

  it('says unsupported when there is no getUserMedia at all', async () => {
    expect((await openCamera(undefined)).kind).toBe('unsupported');
    expect((await openCamera({})).kind).toBe('unsupported');
  });
});

describe('grabbing a frame', () => {
  function fakeCanvas() {
    const draws: number[][] = [];
    const canvas = {
      width: 300, height: 150,
      getContext: () => ({
        drawImage: (_s: unknown, x: number, y: number, w: number, h: number) => draws.push([x, y, w, h]),
        getImageData: (_x: number, _y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
      }),
    };
    return { canvas, draws };
  }

  it('scales the longest edge down to the cap', () => {
    const { canvas, draws } = fakeCanvas();
    const frame = createFrameGrabber(480, () => canvas).grab({ videoWidth: 1280, videoHeight: 720 });
    expect([frame!.width, frame!.height]).toEqual([480, 270]);
    expect(draws[0]).toEqual([0, 0, 480, 270]);
  });

  it('never scales a small frame up', () => {
    const { canvas } = fakeCanvas();
    const frame = createFrameGrabber(480, () => canvas).grab({ videoWidth: 320, videoHeight: 240 });
    expect([frame!.width, frame!.height]).toEqual([320, 240]);
  });

  it('zeroes the canvas on release, so no pixel of the last frame stays', () => {
    const { canvas } = fakeCanvas();
    const grabber = createFrameGrabber(480, () => canvas);
    grabber.grab({ videoWidth: 640, videoHeight: 480 });
    grabber.release();
    expect([canvas.width, canvas.height]).toEqual([0, 0]);
  });
});

describe('a scan persists nothing', () => {
  /*
   * STRUCTURAL, like the decoder's guard: reading the imports and names
   * proves there is no path, where watching one run proves one path clean.
   * `tests/pairing-scan-persists-nothing.test.tsx` watches the run.
   *
   * PER FILE, because the sheet and its scan pane import more than the loop
   * does, and one shared list would let the loop import what only the sheet
   * needs. No `@/ui/*` wildcard: `src/ui/Rail.tsx` imports three stores.
   *
   * `qr-decode.ts` joined the list with #127: it now reaches OAT's fountain
   * half as well as jsQR, so what it may import is stated here too.
   */
  const ALLOWED: Readonly<Record<string, readonly string[]>> = {
    'src/lib/qr-scan.ts': ['@chatterang/tunnel/pairing', '@/lib/oat-fountain', '@/lib/qr-decode'],
    'src/lib/qr-decode.ts': ['@/lib/oat-fountain', 'jsqr'],
    'src/lib/pairing.ts': ['@chatterang/tunnel/pairing'],
    'src/features/pairing/ScanPane.tsx': [
      'react',
      '@chatterang/tunnel/pairing',
      '@/lib/qr-scan',
      '@/lib/qr-decode',
      '@/features/pairing/wording',
    ],
    'src/features/pairing/PairingSheet.tsx': [
      'react',
      '@chatterang/tunnel/pairing',
      '@/ui/primitives',
      '@/lib/platform',
      '@/lib/pairing',
      '@/features/pairing/ScanPane',
      '@/features/pairing/wording',
    ],
    'src/features/pairing/wording.ts': ['@chatterang/tunnel/pairing', '@/lib/pairing', '@/lib/qr-scan'],
  };
  const BANNED = [
    'fetch', 'XMLHttpRequest', 'WebSocket', 'sendBeacon', 'indexedDB', 'localStorage', 'sessionStorage',
    'Dexie', 'db', 'Preferences', 'Filesystem', 'Worker', 'toBlob', 'toDataURL', 'createObjectURL',
    'putBlob', 'clipboard', 'console',
  ];

  const codeOf = (source: string): string => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  /** Static `from '…'` and dynamic `import('…')`, type-only imports included. */
  const importsOf = (code: string): string[] =>
    [...code.matchAll(/(?:\bfrom\s+|\bimport\s*\(\s*)'([^']+)'/g)].map((m) => m[1]!);

  it('reads dynamic and type-only imports as well as static ones', () => {
    expect(importsOf("const m = await import('@/db');")).toEqual(['@/db']);
    expect(importsOf("import type { X } from '@/lib/blobs';")).toEqual(['@/lib/blobs']);
    expect(importsOf("export { y } from '@/lib/export';")).toEqual(['@/lib/export']);
    expect(importsOf("// import('@/db')".replace(/^\s*\/\/.*$/gm, ''))).toEqual([]);
  });

  it('each file imports only its own list, and names nothing that could store, send or log a frame', () => {
    for (const [path, allowed] of Object.entries(ALLOWED)) {
      const code = codeOf(readFileSync(resolve(process.cwd(), path), 'utf8'));
      expect(code, `${path}: comment strip ate the code`).toMatch(/export (async )?function/);
      for (const specifier of importsOf(code)) {
        expect(allowed, `${path} imports ${specifier}`).toContain(specifier);
      }
      for (const name of BANNED) {
        expect(code, `${path} names ${name}`).not.toMatch(new RegExp(`\\b${name}\\b`));
      }
    }
  });
});
