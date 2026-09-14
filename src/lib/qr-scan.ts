/**
 * The camera scan loop, without React (#128).
 *
 * A camera left running is a PRIVACY defect, not a bug: the usage string
 * promises "Nothing the camera sees is stored or sent anywhere", and an
 * indicator light that stays on after the sheet closed breaks the trust that
 * sentence asks for even if no frame goes anywhere. So every way this loop can
 * end goes through ONE latched `stop`, which ends every track before anything
 * else happens — including before a scanned result is handed up, so the camera
 * is already off while the person reads the confirm step.
 *
 * Everything platform-shaped is injected (the stream, the video element, the
 * frame grabber, the decoder, the clock and the scheduler), because jsdom has
 * no 2D canvas and no camera, and a loop that can only be tested on a phone is
 * a loop whose stop paths are never tested.
 *
 * ## A pairing code is one OAT frame (#127)
 *
 * The desktop draws the pairing URI as `@johnhenry/oat-qr-fountain` frames
 * (`src/lib/pairing-frames.ts`). `decodeFrame` turns a frame into a packet;
 * this loop feeds the packet to OAT's `FountainDecoder`, reconstructs the URI,
 * then parses the text with `decodePairingUri` exactly as it parsed a scanned
 * string before. Every pairing code is ONE BLOCK, so each frame carries the
 * whole URI, and the owner ruled on #127 that a frame claiming more blocks is
 * not a pairing code at all ({@link classifyPacket}). So the first packet of a
 * code completes it. The loop still holds what it opens in a session rather
 * than assuming that, so the promises below never rest on a decoder's
 * arithmetic.
 *
 * Four things this adds, each decided rather than inherited:
 *
 *   - THE SESSION IS HELD HERE AND DIES WITH THE SCAN. The decoder, and every
 *     block it has copied, is released on completion — before the result is
 *     handed up — and in `teardown`, which every other ending (cancel, the
 *     pane unmounting or going to the background, the track ending, a decoder
 *     that will not load, a malformed code, the idle timeout) goes through.
 *     `tests/pairing-scan-releases.test.ts` checks that with the garbage
 *     collector: after each ending no decoder, packet, frame or payload is
 *     reachable. ONE THING OUTLIVES THE SCAN, and it is OAT's, not this
 *     loop's: 0.1.0 caches a degree table per block count in a module-level
 *     `Map` (`robustSolitonTable` in its `lt.js`) that nothing clears. It holds
 *     numbers derived from the block count alone, never a byte of any block,
 *     and `classifyPacket` admits no block count but 1, so a scan adds at most
 *     the table for 1.
 *   - A PACKET FROM ANOTHER CODE REPLACES THE ONE BEING COLLECTED. A different
 *     artifact id, block count, block size or length is a different code, and
 *     OAT's decoder throws on the last three. Ignoring the newcomer would tie
 *     the phone to a code the desktop may have withdrawn and redrawn with a new
 *     token until the idle timeout; replacing costs nothing when every frame is
 *     complete, because the newcomer's first frame finishes it — and every
 *     frame that reaches a session is complete, because a frame claiming more
 *     than one block is refused first.
 *   - A PACKET THAT DOES NOT DESCRIBE A ONE-BLOCK, PAIRING-SIZED PAYLOAD NEVER
 *     REACHES THE DECODER. OAT 0.1.0's `decodePacket` accepts any `uint32`
 *     block count and its decoder's constructor does work in proportion to it,
 *     synchronously: one hostile frame is a hang. See {@link classifyPacket}.
 *   - NOTHING THAT GOES WRONG INSIDE A SESSION ENDS THE SCAN. A decoder that
 *     throws on a packet, or a reconstruction that fails, drops the session and
 *     the loop keeps reading. Only a decoder that cannot load ends it.
 */

import {
  DEFAULT_WINDOW_MS,
  MAX_PAIRING_URI_LENGTH,
  PairingParseError,
  decodePairingUri,
  type PairingError,
  type PairingPayload,
} from '@chatterang/tunnel/pairing';

import type { FountainDecoder, OatPacket } from '@/lib/oat-fountain';
import type { FrameRead, QrFrame } from '@/lib/qr-decode';

/**
 * Longest edge of a frame handed to the decoder, in pixels.
 *
 * MEASURED, on the jsQR branch (the only branch iOS has), Node on an Apple
 * silicon Mac — an UPPER bound on quality, not a phone measurement:
 *
 *     frame                       320     480     640     960
 *     blank                       1.4     3.1     5.5    12.5  ms
 *     texture (blur r=2)         11.6    25.5    46.5      —   ms
 *     texture (blur r=6)          5.0    11.2    20.0      —   ms
 *     code on texture             2.8     6.1    10.3      —   ms  (decodes)
 *     per-pixel white noise      59.5   140.9   268.2   677.7 ms  (pessimistic)
 *
 * Cost grows with pixel count AND with fine texture, and a camera frame is
 * texture. 480 keeps a textured frame near 11–26 ms here while leaving room for
 * a code that fills well under half the frame; 640 roughly doubles the cost
 * for margin the pairing screen does not need.
 */
export const MAX_SCAN_EDGE_PX = 480;

/**
 * The shortest gap between decode attempts, in milliseconds.
 *
 * The next attempt waits `max(MIN_SCAN_GAP_MS, lastDecodeMs)` AFTER the last
 * one settles, so the decoder holds the CPU at most half the time on ANY
 * device. That is a derived rule rather than a measured constant, and it is
 * the point: decode cost varied 50x with frame content on one machine, and a
 * phone may be several times slower again, so no fixed interval is right for
 * both. On this Mac a textured 480 frame decodes in 11–26 ms and the 100 ms
 * floor dominates (under ten attempts a second); on a device where it takes
 * 250 ms, the loop follows the decoder instead of queueing behind it.
 */
export const MIN_SCAN_GAP_MS = 100;

/** `HTMLMediaElement.HAVE_CURRENT_DATA`, named, so a frame exists to read. */
export const HAVE_CURRENT_DATA = 2;

/* ── Opening the camera ─────────────────────────────────────────────── */

export type CameraOutcome =
  | { readonly kind: 'ok'; readonly stream: MediaStream }
  /** No `getUserMedia` here at all — offer Type, with no error text. */
  | { readonly kind: 'unsupported' }
  /**
   * Refused. Never phrased as "you denied": Android returns `NotAllowedError`
   * WITHOUT prompting when the manifest lacks CAMERA, so the person may never
   * have been asked.
   */
  | { readonly kind: 'denied' }
  | { readonly kind: 'no-camera' }
  /** Another app holds it, or the OS interrupted — worth a retry button. */
  | { readonly kind: 'busy' }
  | { readonly kind: 'failed' };

type MediaLike = { getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream> };

/**
 * Ask for the rear camera, video only, and name what happened.
 *
 * Classified by `DOMException.name`, because that is the only part of the
 * error the spec pins; messages differ by engine and version.
 */
export async function openCamera(media: MediaLike | undefined): Promise<CameraOutcome> {
  if (media === undefined || typeof media.getUserMedia !== 'function') return { kind: 'unsupported' };
  try {
    const stream = await media.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: 'environment' } },
    });
    return { kind: 'ok', stream };
  } catch (error) {
    const name = (error as { name?: unknown } | null)?.name;
    if (name === 'NotAllowedError' || name === 'SecurityError') return { kind: 'denied' };
    if (name === 'NotFoundError' || name === 'OverconstrainedError') return { kind: 'no-camera' };
    if (name === 'NotReadableError' || name === 'AbortError') return { kind: 'busy' };
    return { kind: 'failed' };
  }
}

/* ── Grabbing a frame ───────────────────────────────────────────────── */

interface CanvasLike {
  width: number;
  height: number;
  getContext(
    kind: '2d',
    options?: { willReadFrequently?: boolean },
  ): {
    drawImage(source: unknown, x: number, y: number, w: number, h: number): void;
    getImageData(x: number, y: number, w: number, h: number): QrFrame;
  } | null;
}

export interface FrameGrabber {
  grab(video: { readonly videoWidth: number; readonly videoHeight: number }): QrFrame | null;
  /** Zero the canvas so no pixel of the last frame stays in memory. */
  release(): void;
}

/**
 * One reused, off-DOM canvas, scaled so the longest edge is at most `maxEdge`.
 * Never scaled UP: a small frame stays small, because upscaling adds pixels
 * the decoder pays for and no detail it can use.
 */
export function createFrameGrabber(
  maxEdge: number = MAX_SCAN_EDGE_PX,
  createCanvas: () => CanvasLike = () => document.createElement('canvas') as unknown as CanvasLike,
): FrameGrabber {
  const canvas = createCanvas();
  const context = canvas.getContext('2d', { willReadFrequently: true });
  return {
    grab(video) {
      if (context === null || video.videoWidth === 0 || video.videoHeight === 0) return null;
      const scale = Math.min(1, maxEdge / Math.max(video.videoWidth, video.videoHeight));
      const width = Math.max(1, Math.round(video.videoWidth * scale));
      const height = Math.max(1, Math.round(video.videoHeight * scale));
      if (canvas.width !== width) canvas.width = width;
      if (canvas.height !== height) canvas.height = height;
      context.drawImage(video, 0, 0, width, height);
      return context.getImageData(0, 0, width, height);
    },
    release() {
      canvas.width = 0;
      canvas.height = 0;
    },
  };
}

/* ── Collecting a code's packets ────────────────────────────────────── */

/**
 * What a packet's header describes, before anything is built for it.
 *
 *   - `pairing`: a self-consistent payload in ONE block, no longer than a
 *     pairing URI may be.
 *   - `too-large`: a well-formed OAT transfer of something bigger — a real
 *     artifact, just not a pairing code. The person is told so.
 *   - `many-blocks`: a well-formed OAT transfer that claims more than one
 *     block, whatever its size. Not a pairing code, and the person is told so.
 *   - `malformed`: a header that contradicts itself — zero lengths, a block
 *     count that does not follow from the length and block size, a payload of
 *     the wrong size. Ignored without a word, like a frame with no code.
 *
 * CHECKED BEFORE A DECODER EXISTS, and that order is the point. The block
 * count, block size and length are attacker-written `uint32`s, and OAT 0.1.0's
 * `FountainDecoder` constructor allocates and computes in proportion to the
 * block count. Bounding the length and the block size by
 * `MAX_PAIRING_URI_LENGTH`, and requiring the block count to follow from them,
 * bounds the block count; requiring it to be 1 fixes it.
 *
 * ONE BLOCK, RULED BY THE OWNER (#127). Every pairing code is a single frame
 * that carries the whole URI (`src/lib/pairing-frames.ts` draws nothing else),
 * so a frame claiming more blocks is not a pairing code — even when the bytes
 * its blocks would add up to are a valid pairing URI. Refusing it narrows what
 * a foreign or hostile frame can make the phone do to a constant, and keeps
 * OAT 0.1.0's per-block-count table cache at its one entry. When OAT 0.1.1's
 * own block-count bound arrives, this stays as the second guard. Multi-frame
 * pairing codes would need a new decision.
 *
 * WHY `many-blocks` GETS THE HINT, and is not ignored like `malformed`. #303's
 * line between the two is whether the header is TRUE: a header that
 * contradicts itself is damage or forgery and earns silence, while a header
 * that describes a real transfer of something that is not a pairing code earns
 * "that is not a pairing code" (`too-large`). A self-consistent many-block
 * header is the second kind — it is exactly what OAT's own sender draws for any
 * artifact it splits, and what a desktop drawing some future multi-frame code
 * would draw. Silence there would leave the person holding the phone at a code
 * that never scans until the idle timeout, which is the failure `qr-decode.ts`
 * already refuses for a newer OAT version. Self-consistency is checked FIRST,
 * so a forged header with a huge block count stays silent.
 */
export type PacketVerdict = 'pairing' | 'too-large' | 'many-blocks' | 'malformed';

/** The only block count a pairing code has. See {@link classifyPacket}. */
export const PAIRING_BLOCK_COUNT = 1;

export function classifyPacket(packet: OatPacket): PacketVerdict {
  const { sourceBlockCount, blockSize, totalLength, payload, artifactId } = packet;
  if (artifactId.length !== 16 || payload.length !== blockSize) return 'malformed';
  if (sourceBlockCount === 0 || blockSize === 0 || totalLength === 0) return 'malformed';
  if (sourceBlockCount !== Math.ceil(totalLength / blockSize)) return 'malformed';
  if (totalLength > MAX_PAIRING_URI_LENGTH || blockSize > MAX_PAIRING_URI_LENGTH) return 'too-large';
  if (sourceBlockCount !== PAIRING_BLOCK_COUNT) return 'many-blocks';
  return 'pairing';
}

/** One code's packets being collected. Owned by the loop; released with it. */
export interface FrameSession {
  /** True once the payload can be reconstructed. Ignores a repeated packet. */
  addPacket(packet: OatPacket): boolean;
  /** The payload's bytes. Throws before the session is complete. */
  reconstruct(): Uint8Array;
  /** Drop the decoder and every block it holds. Idempotent. */
  release(): void;
}

/**
 * OAT's decoder for the code `packet` belongs to, behind a `release`.
 *
 * The wrapper exists for the release: a `FountainDecoder` keeps a copy of every
 * block it has solved and every packet still pending, and has no way to be
 * emptied. Dropping the only reference is how its buffers are let go, and this
 * is the only reference.
 */
export async function openFountainSession(packet: OatPacket): Promise<FrameSession> {
  const { FountainDecoder: Decoder } = await import('@/lib/oat-fountain');
  let decoder: FountainDecoder | null = new Decoder(packet.sourceBlockCount, packet.blockSize, packet.totalLength);
  const live = (): FountainDecoder => {
    if (decoder === null) throw new Error('this scan session was released');
    return decoder;
  };
  return {
    addPacket: (next) => live().addPacket(next),
    reconstruct: () => live().reconstruct(),
    release: () => {
      decoder = null;
    },
  };
}

/**
 * The reconstructed bytes as a pairing URI, or null if they cannot be one.
 *
 * Printable ASCII only, the same rule `pairingUriToBytes` frames with. Anything
 * else is some other OAT transfer, and is a "not a pairing code" rather than a
 * malformed one.
 */
export function pairingUriFromBytes(bytes: Uint8Array): string | null {
  let text = '';
  for (const byte of bytes) {
    if (byte < 0x21 || byte > 0x7e) return null;
    text += String.fromCharCode(byte);
  }
  return text.length === 0 ? null : text;
}

/** Is `packet` another packet of the code `held` is collecting? */
function sameCode(held: HeldSession, packet: OatPacket): boolean {
  if (
    held.sourceBlockCount !== packet.sourceBlockCount ||
    held.blockSize !== packet.blockSize ||
    held.totalLength !== packet.totalLength ||
    held.artifactId.length !== packet.artifactId.length
  ) {
    return false;
  }
  return held.artifactId.every((byte, i) => byte === packet.artifactId[i]);
}

interface HeldSession {
  readonly artifactId: Uint8Array;
  readonly sourceBlockCount: number;
  readonly blockSize: number;
  readonly totalLength: number;
  readonly frames: FrameSession;
}

/* ── The loop ───────────────────────────────────────────────────────── */

interface TrackLike {
  stop(): void;
  addEventListener(type: 'ended' | 'mute', listener: () => void): void;
  removeEventListener(type: 'ended' | 'mute', listener: () => void): void;
}

export type ScanStopReason =
  /** A pairing payload was read. The camera is already off when it is handed up. */
  | 'result'
  | 'cancelled'
  /** The OS ended or muted the track — another app, a call, a revoked grant. */
  | 'track-ended'
  /** The decoder itself failed, e.g. the jsQR or OAT chunk would not load. */
  | 'decode-failed'
  /** A pairing code, but a malformed one. Named by `error`. */
  | 'invalid-code'
  /** Nothing read within the window; any code shown when this began has expired. */
  | 'idle-timeout';

export interface ScanEnd {
  readonly reason: ScanStopReason;
  readonly error?: PairingError;
}

export interface ScanOptions {
  readonly stream: { getTracks(): readonly TrackLike[] };
  readonly video: {
    readonly readyState: number;
    readonly videoWidth: number;
    readonly videoHeight: number;
    srcObject: unknown;
  };
  readonly grabber: FrameGrabber;
  readonly decode: (frame: QrFrame) => Promise<FrameRead | null>;
  /** Where a code's packets are collected. OAT's decoder unless a test says otherwise. */
  readonly openSession?: (packet: OatPacket) => Promise<FrameSession>;
  readonly onResult: (payload: PairingPayload) => void;
  readonly onEnd: (end: ScanEnd) => void;
  /** A QR code that is not a pairing code — a hint, and scanning continues. */
  readonly onHint?: (hint: 'not-a-pairing-code') => void;
  readonly schedule?: (run: () => void, ms: number) => () => void;
  readonly now?: () => number;
  readonly isHidden?: () => boolean;
  readonly idleMs?: number;
}

export interface ScanHandle {
  /** Idempotent. The first stop wins; later ones do nothing. */
  stop(): void;
  readonly stopped: boolean;
}

const defaultSchedule = (run: () => void, ms: number): (() => void) => {
  const id = setTimeout(run, ms);
  return () => clearTimeout(id);
};

export function startQrScan(options: ScanOptions): ScanHandle {
  const schedule = options.schedule ?? defaultSchedule;
  const now = options.now ?? (() => performance.now());
  const isHidden = options.isHidden ?? (() => typeof document !== 'undefined' && document.hidden);
  const idleMs = options.idleMs ?? DEFAULT_WINDOW_MS;
  const openSession = options.openSession ?? openFountainSession;

  const startedAt = now();
  const tracks = options.stream.getTracks();
  let stopped = false;
  let cancelTimer: (() => void) | null = null;
  /** The code being collected. Never outlives the scan: see the module header. */
  let session: HeldSession | null = null;

  const dropSession = (): void => {
    const held = session;
    session = null;
    held?.frames.release();
  };

  /** Everything that turns the camera off. Runs exactly once. */
  const teardown = (): boolean => {
    if (stopped) return false;
    stopped = true;
    cancelTimer?.();
    cancelTimer = null;
    for (const track of tracks) {
      track.removeEventListener('ended', onTrackGone);
      track.removeEventListener('mute', onTrackGone);
      track.stop();
    }
    options.video.srcObject = null;
    options.grabber.release();
    dropSession();
    return true;
  };

  const finish = (end: ScanEnd): void => {
    if (teardown()) options.onEnd(end);
  };

  function onTrackGone(): void {
    finish({ reason: 'track-ended' });
  }

  const next = (ms: number): void => {
    if (stopped) return;
    cancelTimer = schedule(tick, ms);
  };

  const hint = (delay: number): void => {
    options.onHint?.('not-a-pairing-code');
    next(delay);
  };

  /** Parse reconstructed text as a pairing code, and hand it up or say why not. */
  const deliver = (text: string, delay: number): void => {
    let payload: PairingPayload;
    try {
      payload = decodePairingUri(text);
    } catch (error) {
      if (error instanceof PairingParseError && error.reason === 'not-a-pairing-uri') {
        hint(delay);
        return;
      }
      finish({
        reason: 'invalid-code',
        ...(error instanceof PairingParseError ? { error: error.reason } : {}),
      });
      return;
    }
    // The camera goes off BEFORE the payload is handed up.
    if (!teardown()) return;
    options.onResult(payload);
    options.onEnd({ reason: 'result' });
  };

  /** Feed one packet to its code's session, and deliver if that completed it. */
  const collect = async (packet: OatPacket, delay: number): Promise<void> => {
    if (session !== null && !sameCode(session, packet)) dropSession();

    let held = session;
    if (held === null) {
      let frames: FrameSession;
      try {
        frames = await openSession(packet);
      } catch {
        finish({ reason: 'decode-failed' });
        return;
      }
      // Stopped while the decoder loaded: nothing may hold what it would keep.
      if (stopped) {
        frames.release();
        return;
      }
      held = {
        artifactId: packet.artifactId,
        sourceBlockCount: packet.sourceBlockCount,
        blockSize: packet.blockSize,
        totalLength: packet.totalLength,
        frames,
      };
      session = held;
    }

    let bytes: Uint8Array | null = null;
    try {
      if (held.frames.addPacket(packet)) bytes = held.frames.reconstruct();
    } catch {
      // A session that throws is not one to keep feeding. Drop it and read on.
      dropSession();
      next(delay);
      return;
    }
    if (bytes === null) {
      next(delay);
      return;
    }

    // Released BEFORE the text is parsed or anything is handed up. Not zeroed:
    // jsQR's result, the packet OAT decoded and the decoder each hold their own
    // copy of these bytes, and this code can reach none of them. What makes
    // them go is that nothing refers to them once the session is dropped —
    // `tests/pairing-scan-releases.test.ts` asks the garbage collector.
    dropSession();
    const text = pairingUriFromBytes(bytes);
    if (text === null) {
      hint(delay);
      return;
    }
    deliver(text, delay);
  };

  const onRead = (read: FrameRead | null, began: number): Promise<void> | void => {
    // A read that lands after stop is dropped. Load-bearing for the HINT path
    // in particular: a late pairing result is also stopped by the latch in
    // `deliver`, but a late non-pairing code would otherwise call onHint on a
    // scan the person already ended.
    if (stopped) return undefined;
    const delay = Math.max(MIN_SCAN_GAP_MS, now() - began);
    if (read === null) return next(delay);
    if (read.kind === 'other') return hint(delay);
    const verdict = classifyPacket(read.packet);
    if (verdict === 'malformed') return next(delay);
    if (verdict === 'too-large' || verdict === 'many-blocks') return hint(delay);
    return collect(read.packet, delay);
  };

  function tick(): void {
    cancelTimer = null;
    if (stopped) return;
    if (now() - startedAt >= idleMs) {
      finish({ reason: 'idle-timeout' });
      return;
    }
    // Nothing to read, or nobody looking: skip the decode entirely. A hidden
    // page still has a live stream until something stops it, and decoding
    // frames nobody can see is battery spent on nothing.
    const video = options.video;
    if (isHidden() || video.readyState < HAVE_CURRENT_DATA || video.videoWidth === 0) {
      next(MIN_SCAN_GAP_MS);
      return;
    }
    const frame = options.grabber.grab(video);
    if (frame === null) {
      next(MIN_SCAN_GAP_MS);
      return;
    }

    const began = now();
    // Never overlapping: the next tick is scheduled only once this settles,
    // including a session that is still loading its decoder.
    options.decode(frame).then(
      (read) => onRead(read, began),
      () => {
        finish({ reason: 'decode-failed' });
      },
    );
  }

  for (const track of tracks) {
    track.addEventListener('ended', onTrackGone);
    track.addEventListener('mute', onTrackGone);
  }
  next(0);

  return {
    stop: () => finish({ reason: 'cancelled' }),
    get stopped() {
      return stopped;
    },
  };
}
