import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  ADDRESS_IPV4,
  DEFAULT_WINDOW_MS,
  HOST_DESKTOP,
  TRUST_SPKI_PIN,
  encodePairingUri,
} from '@chatterang/tunnel/pairing';
import {
  HAVE_CURRENT_DATA,
  MIN_SCAN_GAP_MS,
  createFrameGrabber,
  openCamera,
  startQrScan,
  type ScanEnd,
} from '@/lib/qr-scan';

/**
 * #128: the camera scan loop's privacy behaviour, proven without a UI.
 *
 * Every stop path is tested, because a camera left running is a privacy defect:
 * the usage string promises the person nothing the camera sees goes anywhere,
 * and an indicator light that stays on after they closed the sheet breaks that
 * promise in the only way they can see.
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

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

function setup(overrides: { decode?: (f: unknown) => Promise<string | null>; readyState?: number; videoWidth?: number; hidden?: boolean } = {}) {
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
    const s = setup({ decode: async () => VALID_URI });
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
    const s = setup({ decode: async () => 'chatterang-pair:!!!' });
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
    let resolve!: (v: string) => void;
    const s = setup({ decode: () => new Promise<string>((r) => { resolve = r; }) });
    s.scheduler.step();
    s.handle.stop();
    resolve(VALID_URI);
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
    let resolve!: (v: string) => void;
    const s = setup({ decode: () => new Promise<string>((r) => { resolve = r; }) });
    s.scheduler.step();
    s.handle.stop();
    resolve('https://example.com/menu');
    await flush();
    expect(s.onHint).not.toHaveBeenCalled();
  });
});

describe('the loop does not burn the CPU', () => {
  it('never overlaps: a decode that has not settled means no second one', () => {
    const s = setup({ decode: () => new Promise<string | null>(() => {}) });
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
    const s = setup({ decode: async () => 'https://example.com/menu' });
    s.scheduler.step();
    await flush();
    expect(s.onHint).toHaveBeenCalledWith('not-a-pairing-code');
    expect(s.track.stop).not.toHaveBeenCalled();
    expect(s.scheduler.live()).toBe(1);
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
  it('names nothing that could store, send or log a frame', () => {
    /*
     * STRUCTURAL, like the decoder's guard: reading the imports and names
     * proves there is no path, where watching one run proves one path clean.
     */
    for (const path of ['src/lib/qr-scan.ts', 'src/lib/pairing.ts']) {
      const source = readFileSync(resolve(process.cwd(), path), 'utf8');
      const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      expect(code, `${path}: comment strip ate the code`).toMatch(/export (async )?function/);
      const imports = [...code.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]);
      for (const specifier of imports) {
        expect(['@chatterang/tunnel/pairing', '@/lib/qr-decode'], `${path} imports ${specifier}`).toContain(specifier);
      }
      for (const name of ['fetch', 'XMLHttpRequest', 'indexedDB', 'localStorage', 'sessionStorage', 'Dexie', 'Worker', 'toBlob', 'toDataURL', 'createObjectURL', 'putBlob', 'clipboard', 'console']) {
        expect(code, `${path} names ${name}`).not.toMatch(new RegExp(`\\b${name}\\b`));
      }
    }
  });
});
