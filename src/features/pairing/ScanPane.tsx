import { useEffect, useRef, useState, type ReactNode } from 'react';

import type { PairingPayload } from '@chatterang/tunnel/pairing';
import { createFrameGrabber, openCamera, startQrScan, type ScanHandle } from '@/lib/qr-scan';
import { decodeFrame } from '@/lib/qr-decode';
import {
  CAMERA_BUSY,
  NOT_A_PAIRING_CODE,
  SCAN_END_WORDING,
  SCAN_INTRO,
  SCAN_LOOKING,
} from '@/features/pairing/wording';

/**
 * The Scan pane: the one component that holds a camera (#128).
 *
 * THE CAMERA IS ASKED FOR ONLY WHEN THE PERSON PRESSES "Scan with camera" (D4).
 * Opening the sheet asks for nothing, so a person who types, or who declines
 * cameras on principle, is never shown a permission prompt they did not ask
 * for.
 *
 * EVERY WAY OUT STOPS IT. The loop in `qr-scan.ts` turns the tracks off before
 * a result is handed up and on every stop path; this pane adds the three exits
 * only a component can see:
 *   - unmounting (the sheet closed, or the person switched to Type), through
 *     the effect's cleanup;
 *   - the app going to the background (D6), through `visibilitychange`, because
 *     whether a phone mutes the track then is platform-dependent and a live
 *     camera nobody can see breaks the promise the usage string makes — and
 *     the app already being there when the stream arrives, because the event
 *     fired while the permission prompt was up and will not fire again;
 *   - a stream that arrives after the pane is gone, because the person closed
 *     the sheet while the permission prompt was still up.
 *
 * `handle.stop()` always reports `cancelled`, so the pane records why IT asked
 * before asking, and only a stop it caused while visible offers "Scan again".
 *
 * Nothing here keeps a frame. Pixels go from the video to the decoder and back
 * as text; `tests/pairing-scan-persists-nothing.test.tsx` watches a run.
 */

export interface ScanPaneProps {
  /**
   * A payload was read, and the camera is already off. Answers the sentence to
   * show when the payload is refused, or null when it goes on to Confirm.
   */
  readonly onResult: (payload: PairingPayload) => string | null;
  /** No camera can be used here — absent, refused, missing or failed. Not an error. */
  readonly onUnavailable: () => void;
  /** A pairing is in flight; scanning over it is not offered. */
  readonly busy: boolean;
}

type Phase =
  /** Waiting for the person. `message` says why the last scan ended, if one did. */
  | { readonly kind: 'idle'; readonly message: string | null }
  | { readonly kind: 'opening' }
  /** Something else holds the camera: worth a retry. */
  | { readonly kind: 'camera-busy' }
  | { readonly kind: 'scanning'; readonly stream: MediaStream };

export function ScanPane({ onResult, onUnavailable, busy }: ScanPaneProps): ReactNode {
  const [phase, setPhase] = useState<Phase>({ kind: 'idle', message: null });
  const [hint, setHint] = useState(false);
  const video = useRef<HTMLVideoElement>(null);
  const mounted = useRef(false);
  const hidden = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // Latest callbacks, so a parent re-rendering with new inline functions does
  // not tear the scan down and start it again.
  const callbacks = useRef({ onResult, onUnavailable });
  useEffect(() => {
    callbacks.current = { onResult, onUnavailable };
  });

  async function start(): Promise<void> {
    setHint(false);
    setPhase({ kind: 'opening' });
    const outcome = await openCamera(navigator.mediaDevices);
    if (!mounted.current) {
      // Closed while the permission prompt was up. A stream that arrives now
      // belongs to nobody, so it is stopped before anything can draw it.
      if (outcome.kind === 'ok') for (const track of outcome.stream.getTracks()) track.stop();
      return;
    }
    if (outcome.kind === 'ok') setPhase({ kind: 'scanning', stream: outcome.stream });
    else if (outcome.kind === 'busy') setPhase({ kind: 'camera-busy' });
    else {
      // Unsupported, refused, absent or failed all go to Type. Never "you
      // denied": Android refuses without prompting when the manifest lacks the
      // permission, so the person may never have been asked.
      setPhase({ kind: 'idle', message: null });
      callbacks.current.onUnavailable();
    }
  }

  useEffect(() => {
    if (phase.kind !== 'scanning' || video.current === null) return undefined;
    const element = video.current;
    element.srcObject = phase.stream;
    hidden.current = false;

    const handle: ScanHandle = startQrScan({
      stream: phase.stream,
      video: element,
      grabber: createFrameGrabber(),
      decode: decodeFrame,
      onHint: () => setHint(true),
      onResult: (payload) => {
        setPhase({ kind: 'idle', message: callbacks.current.onResult(payload) });
      },
      onEnd: (end) => {
        if (end.reason === 'result') return;
        if (end.reason === 'cancelled') {
          // Cancelled is every stop this pane asked for. Only backgrounding
          // leaves the pane on screen to say so; unmounting leaves nothing.
          if (hidden.current) setPhase({ kind: 'idle', message: SCAN_END_WORDING.hidden });
          return;
        }
        setPhase({ kind: 'idle', message: SCAN_END_WORDING[end.reason] });
      },
    });

    const onVisibility = (): void => {
      if (!document.hidden) return;
      hidden.current = true;
      handle.stop();
    };
    document.addEventListener('visibilitychange', onVisibility);
    // A stream that arrives while the app is already hidden gets no event: the
    // one that fired came while the pane was still opening, and nothing fires
    // again until the app is shown. Look now instead of waiting to be told.
    if (document.hidden) onVisibility();
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      handle.stop();
    };
  }, [phase]);

  if (phase.kind === 'scanning') {
    return (
      <div className="field">
        <video
          ref={video}
          autoPlay
          playsInline
          muted
          aria-label="Camera preview"
          style={{ display: 'block', width: '100%' }}
        />
        <p className="section__hint" role="status">
          {hint ? NOT_A_PAIRING_CODE : SCAN_LOOKING}
        </p>
      </div>
    );
  }

  const ended = phase.kind === 'idle' && phase.message !== null;
  return (
    <div className="field">
      <p className="section__hint" role={ended || phase.kind === 'camera-busy' ? 'status' : undefined}>
        {phase.kind === 'camera-busy' ? CAMERA_BUSY : ended ? phase.message : SCAN_INTRO}
      </p>
      <button
        type="button"
        className="btn"
        disabled={busy || phase.kind === 'opening'}
        onClick={() => void start()}
      >
        {phase.kind === 'camera-busy' ? 'Try again' : ended ? 'Scan again' : 'Scan with camera'}
      </button>
    </div>
  );
}
