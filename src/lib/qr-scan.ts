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
 */

import {
  DEFAULT_WINDOW_MS,
  PairingParseError,
  decodePairingUri,
  type PairingError,
  type PairingPayload,
} from '@chatterang/tunnel/pairing';

import type { QrFrame } from '@/lib/qr-decode';

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
  /** The decoder itself failed, e.g. the jsQR chunk would not load. */
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
  readonly decode: (frame: QrFrame) => Promise<string | null>;
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

  const startedAt = now();
  const tracks = options.stream.getTracks();
  let stopped = false;
  let cancelTimer: (() => void) | null = null;

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
    // Never overlapping: the next tick is scheduled only once this settles.
    options.decode(frame).then(
      (text) => {
        // A result that lands after stop is dropped. Load-bearing for the HINT
        // path in particular: a late pairing result is also stopped by the
        // latch below, but a late non-pairing code would otherwise call onHint
        // on a scan the person already ended.
        if (stopped) return;
        const delay = Math.max(MIN_SCAN_GAP_MS, now() - began);
        if (text === null) {
          next(delay);
          return;
        }
        let payload: PairingPayload;
        try {
          payload = decodePairingUri(text);
        } catch (error) {
          if (error instanceof PairingParseError && error.reason === 'not-a-pairing-uri') {
            options.onHint?.('not-a-pairing-code');
            next(delay);
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
      },
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
