// @vitest-environment node
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';

import { describe, expect, it, vi } from 'vitest';

/*
 * The decoder class the loop builds, replaced with one that records every
 * instance and every array it reconstructs — weakly, so recording them keeps
 * nothing alive. Hoisted, because the mock factory runs before the imports.
 */
const tracked = vi.hoisted(() => ({
  decoders: [] as WeakRef<object>[],
  reconstructed: [] as WeakRef<object>[],
}));

vi.mock('@/lib/oat-fountain', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/oat-fountain')>();
  class TrackedDecoder extends actual.FountainDecoder {
    constructor(...args: ConstructorParameters<typeof actual.FountainDecoder>) {
      super(...args);
      tracked.decoders.push(new WeakRef(this));
    }
    override reconstruct(): Uint8Array {
      const bytes = super.reconstruct();
      tracked.reconstructed.push(new WeakRef(bytes));
      return bytes;
    }
  }
  return { ...actual, FountainDecoder: TrackedDecoder };
});

import {
  ADDRESS_IPV4,
  DEFAULT_WINDOW_MS,
  HOST_DESKTOP,
  TRUST_SPKI_PIN,
  encodePairingUri,
} from '@chatterang/tunnel/pairing';
import { generatePackets, prepareSource, type OatPacket } from '@/lib/oat-fountain';
import type { FrameRead, QrFrame } from '@/lib/qr-decode';
import { HAVE_CURRENT_DATA, startQrScan, type ScanEnd, type ScanHandle } from '@/lib/qr-scan';

/**
 * #128 and #127: WHAT THE CAMERA SAW IS UNREACHABLE ONCE THE SCAN ENDS.
 *
 * `tests/pairing-scan.test.ts` proves the loop CALLS `release()` on every
 * ending, and `tests/pairing-scan-persists-nothing.test.tsx` proves nothing
 * reaches a store, the network, `pair()` or a log. Neither can see a reference
 * the loop keeps for itself: a module-level array that every packet is pushed
 * into passes both. This file asks the garbage collector instead. After each
 * ending, and a real collection, no decoder, packet, packet buffer, frame buffer
 * or reconstructed payload may still be reachable.
 *
 * THE CONTROL comes first: a session still collecting IS reachable, so a probe
 * that reported everything collected could not pass it.
 *
 * Two things the harness has to avoid, both of which make the probe report a
 * retention that is the test's own:
 *   - `vi.fn` for anything that receives or returns a packet or a frame. Its
 *     `mock.calls` and `mock.results` keep every argument and return value.
 *   - handing the loop the packet OAT's generator yielded. A suspended
 *     generator keeps the last payload it built, so each packet is copied.
 */

setFlagsFromString('--expose_gc');
const collectGarbage = runInNewContext('gc') as () => void;

const URI = encodePairingUri({
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

/** `URI`'s packets in `blockSize` blocks, each one a copy nothing else holds. */
function packetsOf(blockSize: number, id: number): () => OatPacket {
  const bytes = Uint8Array.from(URI, (c) => c.charCodeAt(0));
  let seed = 1;
  const packets = generatePackets(prepareSource(bytes, blockSize, new Uint8Array(16).fill(id)), () => seed++);
  return () => {
    const packet = packets.next().value;
    return { ...packet, artifactId: packet.artifactId.slice(), payload: packet.payload.slice() };
  };
}

/** Let promise chains and the decoder's `import()` settle. */
const settle = async () => {
  for (let i = 0; i < 5; i += 1) await new Promise<void>((r) => setTimeout(r, 0));
};

/**
 * WeakRefs are held strongly until the job that created or dereferenced them
 * ends, so collection happens on a later turn, and more than once.
 */
async function reachable(refs: readonly WeakRef<object>[]): Promise<number> {
  for (let i = 0; i < 3; i += 1) {
    await new Promise<void>((r) => setTimeout(r, 0));
    collectGarbage();
  }
  return refs.filter((ref) => ref.deref() !== undefined).length;
}

interface Probe {
  readonly handle: ScanHandle;
  readonly ends: ScanEnd[];
  readonly results: string[];
  readonly step: () => Promise<void>;
  readonly advance: (ms: number) => void;
  readonly fireEnded: () => void;
  readonly failDecoding: () => void;
  /** Every packet, packet buffer and frame buffer the loop was handed. */
  readonly seen: WeakRef<object>[];
  readonly setNext: (next: () => OatPacket) => void;
}

/** A scan with no `vi.fn` anywhere a packet or a frame passes. */
function scan(first: () => OatPacket): Probe {
  const seen: WeakRef<object>[] = [];
  const ends: ScanEnd[] = [];
  const results: string[] = [];
  const queue: (() => void)[] = [];
  const listeners = new Map<string, () => void>();
  let clock = 0;
  let next = first;
  let failing = false;

  const handle = startQrScan({
    stream: {
      getTracks: () => [
        {
          stop: () => {},
          addEventListener: (type: string, listener: () => void) => listeners.set(type, listener),
          removeEventListener: (type: string) => listeners.delete(type),
        },
      ],
    },
    video: { readyState: HAVE_CURRENT_DATA, videoWidth: 64, videoHeight: 48, srcObject: {} },
    grabber: {
      grab: (): QrFrame => {
        const frame = { data: new Uint8ClampedArray(64 * 48 * 4), width: 64, height: 48 };
        seen.push(new WeakRef(frame.data));
        return frame;
      },
      release: () => {},
    },
    decode: async (): Promise<FrameRead> => {
      if (failing) throw new Error('chunk failed to load');
      const packet = next();
      seen.push(new WeakRef(packet), new WeakRef(packet.payload), new WeakRef(packet.artifactId));
      return { kind: 'packet', packet };
    },
    onResult: (payload) => results.push(payload.name),
    onEnd: (end) => ends.push(end),
    schedule: (run) => {
      queue.push(run);
      return () => {
        const at = queue.indexOf(run);
        if (at >= 0) queue.splice(at, 1);
      };
    },
    now: () => clock,
    isHidden: () => false,
  });

  return {
    handle,
    ends,
    results,
    seen,
    step: async () => {
      queue.shift()?.();
      await settle();
    },
    advance: (ms) => {
      clock += ms;
    },
    fireEnded: () => listeners.get('ended')?.(),
    failDecoding: () => {
      failing = true;
    },
    setNext: (replacement) => {
      next = replacement;
    },
  };
}

/** Reset the recorders, so each test counts only its own scan. */
function fresh(): void {
  tracked.decoders.length = 0;
  tracked.reconstructed.length = 0;
}

describe('once a scan ends, nothing the camera saw is reachable', () => {
  it('the control: a code still being collected IS reachable, so the probe can see a retention', async () => {
    fresh();
    const s = scan(packetsOf(16, 1));
    await s.step();
    expect(tracked.decoders).toHaveLength(1);
    expect(s.ends).toEqual([]);
    expect(await reachable(tracked.decoders), 'the live decoder').toBe(1);
    s.handle.stop();
  });

  it('on a result: the decoder, every packet, every frame and the reconstructed bytes', async () => {
    fresh();
    const s = scan(packetsOf(URI.length, 2));
    await s.step();
    expect(s.results).toEqual(['Desk']);
    expect(s.ends).toEqual([{ reason: 'result' }]);
    expect(tracked.reconstructed).toHaveLength(1);
    expect(s.seen.length).toBeGreaterThanOrEqual(4);
    expect(await reachable(tracked.decoders), 'decoders').toBe(0);
    expect(await reachable(tracked.reconstructed), 'reconstructed bytes').toBe(0);
    expect(await reachable(s.seen), 'packets and frames').toBe(0);
  });

  const endings: readonly [string, (s: Probe) => void | Promise<void>, ScanEnd['reason']][] = [
    ['on cancel, which is also backgrounding and closing', (s) => s.handle.stop(), 'cancelled'],
    ['when the OS ends the track', (s) => s.fireEnded(), 'track-ended'],
    ['on the idle timeout', async (s) => {
      s.advance(DEFAULT_WINDOW_MS);
      await s.step();
    }, 'idle-timeout'],
    ['when the decoder fails', async (s) => {
      s.failDecoding();
      await s.step();
    }, 'decode-failed'],
  ];

  for (const [label, end, reason] of endings) {
    it(`${label}: a part-collected code`, async () => {
      fresh();
      const s = scan(packetsOf(16, 3));
      await s.step();
      await s.step();
      expect(s.ends).toEqual([]);
      expect(tracked.decoders).toHaveLength(1);

      await end(s);
      expect(s.ends.map((e) => e.reason)).toEqual([reason]);
      expect(await reachable(tracked.decoders), 'decoders').toBe(0);
      expect(await reachable(s.seen), 'packets and frames').toBe(0);
    });
  }

  it('a code replaced by another mid-scan is unreachable while the scan reads on', async () => {
    fresh();
    const s = scan(packetsOf(16, 4));
    await s.step();
    expect(tracked.decoders).toHaveLength(1);
    const oldDecoder = tracked.decoders.slice();
    const oldPackets = s.seen.slice();

    s.setNext(packetsOf(16, 5));
    await s.step();
    expect(tracked.decoders).toHaveLength(2);
    expect(s.ends).toEqual([]);
    expect(await reachable(oldDecoder), 'the replaced decoder').toBe(0);
    expect(await reachable(oldPackets), "the replaced code's packets and frames").toBe(0);
    expect(await reachable(tracked.decoders), 'the live decoder').toBe(1);
    s.handle.stop();
  });
});
