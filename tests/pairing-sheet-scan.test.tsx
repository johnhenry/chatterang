/**
 * THE SCAN PANE AND CONFIRM, DRIVEN THROUGH A REAL DOM (#128, D4, D6, D11).
 *
 * jsdom has no camera, no media pipeline and no 2D canvas, so the platform is
 * stubbed at its edges and nowhere else: `navigator.mediaDevices` answers with
 * fake tracks, the video element reports a frame, the canvas returns pixels,
 * and the decoder module is mocked to script what a frame "contains". The scan
 * loop, the pane and the sheet all run as shipped, and the pane takes no
 * test-only props.
 *
 * What is measured: the sheet opens on Type even where a camera can scan
 * (#124); the camera is not asked for until the person presses Scan with
 * camera; every camera outcome lands somewhere honest; every exit turns
 * the camera off, including closing mid-prompt and going to the background; a
 * scanned code is validated and its name attributed before anything is sent;
 * and Confirm sends the payload exactly as it was read.
 */

import { StrictMode, act, useState, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const platform = vi.hoisted(() => ({ cameraScan: true }));
const decoder = vi.hoisted(() => ({ decodeFrame: vi.fn<(frame: unknown) => Promise<string | null>>() }));

vi.mock('@/lib/platform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/platform')>();
  return { ...actual, capabilities: () => ({ ...actual.capabilities(), cameraScan: platform.cameraScan }) };
});
vi.mock('@/lib/qr-decode', () => ({ decodeFrame: decoder.decodeFrame }));

import {
  ADDRESS_DNS,
  ADDRESS_IPV4,
  DEFAULT_WINDOW_MS,
  HOST_DESKTOP,
  TRUST_SPKI_PIN,
  TRUST_STATIC_KEY,
  decodePairingUri,
  encodePairingUri,
  type PairingPayload,
} from '@chatterang/tunnel/pairing';
import {
  validateScannedPayload,
  type PairingController,
  type PairingOutcome,
  type PairingRequest,
} from '@/lib/pairing';
import { PairingSheet } from '@/features/pairing/PairingSheet';
import {
  CAMERA_BUSY,
  CAMERA_UNAVAILABLE,
  CONFIRM_TITLE,
  NOT_A_PAIRING_CODE,
  SCANNED_PROBLEM_WORDING,
  SCAN_END_WORDING,
  confirmDetail,
} from '@/features/pairing/wording';

import {
  button,
  byLabel,
  click,
  dialog,
  mustButton,
  reads,
  readsShown,
  render,
  settle,
  type Mounted,
} from './support/pairing-dom';

/* ── The platform's edges ───────────────────────────────────────────── */

class FakeTrack {
  stop = vi.fn();
  private listeners = new Map<string, Set<() => void>>();
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
}

const streamOf = (track: FakeTrack) => ({ getTracks: () => [track] }) as unknown as MediaStream;

function camera(answer: () => Promise<MediaStream>) {
  const getUserMedia = vi.fn(answer);
  Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia }, configurable: true });
  return getUserMedia;
}

function refusedWith(name: string) {
  return camera(async () => {
    throw Object.assign(new Error('camera'), { name });
  });
}

const restorers: (() => void)[] = [];
function stub(target: object, key: string, descriptor: PropertyDescriptor) {
  const original = Object.getOwnPropertyDescriptor(target, key);
  Object.defineProperty(target, key, { configurable: true, ...descriptor });
  restorers.push(() => {
    if (original) Object.defineProperty(target, key, original);
    else delete (target as Record<string, unknown>)[key];
  });
}

beforeEach(() => {
  // A video element with a current frame, and a canvas that can read one.
  stub(HTMLMediaElement.prototype, 'readyState', { get: () => 4 });
  stub(HTMLVideoElement.prototype, 'videoWidth', { get: () => 640 });
  stub(HTMLVideoElement.prototype, 'videoHeight', { get: () => 480 });
  stub(HTMLCanvasElement.prototype, 'getContext', {
    value: () => ({
      drawImage: () => {},
      getImageData: (_x: number, _y: number, w: number, h: number) => ({
        data: new Uint8ClampedArray(w * h * 4),
        width: w,
        height: h,
      }),
    }),
  });
  decoder.decodeFrame.mockReset();
  decoder.decodeFrame.mockResolvedValue(null);
});

const mounted: Mounted[] = [];
afterEach(async () => {
  for (const mount of mounted.splice(0)) await mount.unmount();
  for (const restore of restorers.splice(0).reverse()) restore();
  delete (navigator as { mediaDevices?: unknown }).mediaDevices;
  platform.cameraScan = true;
  vi.restoreAllMocks();
});

/* ── Fixtures ───────────────────────────────────────────────────────── */

const text = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));

function code(over: Partial<PairingPayload> = {}): string {
  return encodePairingUri({
    version: 1,
    hostKind: HOST_DESKTOP,
    trustMode: TRUST_SPKI_PIN,
    trust: Uint8Array.from({ length: 32 }, (_, i) => i + 1),
    token: new Uint8Array(32).fill(2),
    expiresAt: 4_000_000_000,
    port: 51234,
    addresses: [{ kind: ADDRESS_IPV4, value: Uint8Array.of(192, 168, 1, 4) }],
    name: 'Desk',
    ...over,
  } as PairingPayload);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function fakeController(answer: () => Promise<PairingOutcome> = async () => ({ kind: 'refused', reason: 'unreachable' })) {
  const pair = vi.fn<(request: PairingRequest, signal?: AbortSignal) => Promise<PairingOutcome>>(answer);
  const controller: PairingController = { available: true, pair };
  return { controller, pair };
}

type Paired = Extract<PairingOutcome, { kind: 'paired' }>;

function Harness(props: { controller: PairingController; onOutcome: (o: Paired) => void; onClose: () => void }): ReactNode {
  const [open, setOpen] = useState(true);
  if (!open) return null;
  return (
    <PairingSheet
      controller={props.controller}
      onOutcome={props.onOutcome}
      onClose={() => {
        props.onClose();
        setOpen(false);
      }}
    />
  );
}

/** Select Scan. The sheet opens on Type (#124), so every scan starts with this tap. */
async function scanPane() {
  await click(mustButton('Scan'));
  expect(mustButton('Scan').getAttribute('aria-pressed')).toBe('true');
}

/** Open the sheet, and select Scan unless the test measures what it opens on. */
async function open(controller: PairingController, { selectScan = true } = {}) {
  const onOutcome = vi.fn<(o: Paired) => void>();
  const onClose = vi.fn();
  mounted.push(await render(<Harness controller={controller} onOutcome={onOutcome} onClose={onClose} />));
  expect(dialog()).not.toBeNull();
  if (selectScan) await scanPane();
  return { onOutcome, onClose, mount: mounted[mounted.length - 1]! };
}

/** Let timers and promises run until `ready` holds, or fail naming what never happened. */
async function until<T>(ready: () => T | null | undefined | false, what: string): Promise<T> {
  for (let i = 0; i < 100; i += 1) {
    const value = ready();
    if (value) return value;
    await settle();
  }
  throw new Error(`never happened: ${what}`);
}

const status = () => [...document.querySelectorAll('[role="status"]')].map((node) => reads(node));
const video = () => document.querySelector('video');
const confirmOpen = () => [...document.querySelectorAll('[role="dialog"] h2')].some((h) => reads(h) === CONFIRM_TITLE);

/** Press Scan with camera and wait for the preview. The decoder is left pending unless given. */
async function scanning(decode?: () => Promise<string | null>) {
  if (decode) decoder.decodeFrame.mockImplementation(decode);
  await click(mustButton('Scan with camera'));
  return until(video, 'the camera preview');
}

/* ── Asking for the camera ──────────────────────────────────────────── */

const TYPED_ADMISSION =
  "Typing a code is weaker than scanning one. A scanned code carries the computer's certificate fingerprint; six typed digits do not.";

describe('the camera is asked for only when the person presses Scan with camera (D4)', () => {
  it('opens on Type where a camera can scan, with the admission on screen and Scan one tap away (#124)', async () => {
    // The owner ruled that the sheet always opens on Type, so the typed route's
    // admission is read before a route is picked. The camera row here is true.
    const getUserMedia = camera(async () => streamOf(new FakeTrack()));
    await open(fakeController().controller, { selectScan: false });

    expect(mustButton('Type').getAttribute('aria-pressed')).toBe('true');
    expect(mustButton('Scan').getAttribute('aria-pressed')).toBe('false');
    expect(byLabel('Computer address')).toBeInstanceOf(HTMLInputElement);
    // Seen, not merely present: textContent would count a hidden paragraph.
    expect(readsShown(dialog())).toContain(TYPED_ADMISSION);
    expect(button('Scan with camera')).toBeNull();
    await settle();
    expect(getUserMedia).not.toHaveBeenCalled();

    await click(mustButton('Scan'));
    expect(button('Scan with camera')).not.toBeNull();
  });

  it('requests nothing on open or on switching panes, and asks once Scan with camera is pressed', async () => {
    const getUserMedia = camera(async () => streamOf(new FakeTrack()));
    await open(fakeController().controller);

    expect(button('Scan with camera')).not.toBeNull();
    await settle();
    await click(mustButton('Type'));
    expect(byLabel('Computer address')).toBeInstanceOf(HTMLInputElement);
    await click(mustButton('Scan'));
    await settle();
    expect(getUserMedia).not.toHaveBeenCalled();

    await click(mustButton('Scan with camera'));
    await until(video, 'the camera preview');
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(getUserMedia).toHaveBeenCalledWith({ audio: false, video: { facingMode: { ideal: 'environment' } } });
  });

  it('offers Type alone where the platform row has no camera, and says nothing about one', async () => {
    platform.cameraScan = false;
    const getUserMedia = camera(async () => streamOf(new FakeTrack()));
    await open(fakeController().controller, { selectScan: false });

    expect(button('Scan')).toBeNull();
    expect(button('Type')).toBeNull();
    expect(button('Scan with camera')).toBeNull();
    expect(byLabel('Computer address')).toBeInstanceOf(HTMLInputElement);
    expect(readsShown(dialog())).toContain(TYPED_ADMISSION);
    expect(document.querySelector('.field__error')).toBeNull();
    expect(status()).toEqual([]);
    expect(reads(dialog())).not.toMatch(/camera/i);
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it('control: readsShown drops every way these tests know of hiding a sentence, and keeps a shown one', () => {
    // Without this, a readsShown that returned textContent would let the
    // "on screen" checks above pass on a hidden admission.
    const fixture = document.createElement('div');
    fixture.innerHTML = [
      '<p>shown</p>',
      '<p hidden>by-hidden</p>',
      '<div aria-hidden="true"><p>by-aria-hidden</p></div>',
      '<div inert><p>by-inert</p></div>',
      '<div style="display: none"><p>by-display</p></div>',
      '<div style="visibility: hidden"><p>by-visibility</p></div>',
      '<details><summary>why</summary><p>by-closed-details</p>loose-in-details</details>',
      '<details open><summary>open</summary><p>in-open-details</p></details>',
    ].join('');
    document.body.append(fixture);
    try {
      const hidden = ['by-hidden', 'by-aria-hidden', 'by-inert', 'by-display', 'by-visibility', 'by-closed-details', 'loose-in-details'];
      for (const word of hidden) expect(reads(fixture), `textContent counts ${word}`).toContain(word);
      const seen = readsShown(fixture);
      for (const word of hidden) expect(seen, word).not.toContain(word);
      expect(seen).toContain('shown');
      expect(seen).toContain('why');
      expect(seen).toContain('in-open-details');

      // A node whose ancestor hides it reads as nothing, even asked directly.
      expect(readsShown(fixture.querySelector('[aria-hidden] p'))).toBe('');
      expect(readsShown(fixture.querySelector('details:not([open]) p'))).toBe('');
      expect(readsShown(fixture.querySelector('p'))).toBe('shown');
    } finally {
      fixture.remove();
    }
  });
});

describe('what the camera answers', () => {
  it('sends an unsupported, refused, absent or failed camera to Type, in neutral words', async () => {
    const cases: readonly [string, () => unknown][] = [
      ['no mediaDevices at all', () => undefined],
      ['NotAllowedError', () => refusedWith('NotAllowedError')],
      ['NotFoundError', () => refusedWith('NotFoundError')],
      ['an error named TypeError', () => refusedWith('TypeError')],
    ];
    for (const [label, arrange] of cases) {
      arrange();
      const { mount } = await open(fakeController().controller);
      await click(mustButton('Scan with camera'));
      await until(() => button('Type')?.getAttribute('aria-pressed') === 'true', `${label}: Type selected`);
      expect(byLabel('Computer address'), label).toBeInstanceOf(HTMLInputElement);
      expect(status(), label).toEqual([CAMERA_UNAVAILABLE]);
      // The Type pane a refused camera lands on is the same pane, admission and all (D2).
      expect(readsShown(dialog()), label).toContain(TYPED_ADMISSION);
      expect(document.querySelector('.field__error'), label).toBeNull();
      expect(reads(dialog()), label).not.toMatch(/den(y|ied)/i);
      await mount.unmount();
      delete (navigator as { mediaDevices?: unknown }).mediaDevices;
    }
  });

  it('offers a retry when something else holds the camera, and asks again when pressed', async () => {
    const track = new FakeTrack();
    const getUserMedia = vi
      .fn<() => Promise<MediaStream>>()
      .mockRejectedValueOnce(Object.assign(new Error('busy'), { name: 'NotReadableError' }))
      .mockResolvedValueOnce(streamOf(track));
    Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia }, configurable: true });
    await open(fakeController().controller);

    await click(mustButton('Scan with camera'));
    const retry = await until(() => button('Try again'), 'a retry');
    expect(status()).toEqual([CAMERA_BUSY]);
    expect(mustButton('Scan').getAttribute('aria-pressed')).toBe('true');

    await click(retry);
    await until(video, 'the camera preview');
    expect(getUserMedia).toHaveBeenCalledTimes(2);
  });
});

/* ── Every exit turns the camera off ────────────────────────────────── */

describe('every exit turns the camera off', () => {
  it('stops every track and clears the preview before Confirm appears', async () => {
    const track = new FakeTrack();
    const stream = streamOf(track);
    camera(async () => stream);
    await open(fakeController().controller);
    const frame = deferred<string | null>();
    const preview = await scanning(() => frame.promise);
    expect(preview.srcObject).toBe(stream);
    expect(track.stop).not.toHaveBeenCalled();

    frame.resolve(code());
    await until(confirmOpen, 'Confirm');
    expect(track.stop).toHaveBeenCalledTimes(1);
    expect(preview.srcObject).toBeNull();
    expect(video()).toBeNull();
  });

  it('stops when the sheet closes mid-scan, whether or not the parent unmounts it', async () => {
    for (const parentKeepsIt of [false, true]) {
      const track = new FakeTrack();
      camera(async () => streamOf(track));
      const { controller } = fakeController();
      let mount: Mounted;
      if (parentKeepsIt) {
        mount = await render(<PairingSheet controller={controller} onClose={() => {}} onOutcome={() => {}} />);
        mounted.push(mount);
        await scanPane();
      } else {
        mount = (await open(controller)).mount;
      }
      const preview = await scanning(() => new Promise(() => {}));

      await click(mustButton('Close'));
      expect(track.stop, `parent keeps it: ${parentKeepsIt}`).toHaveBeenCalledTimes(1);
      expect(preview.srcObject).toBeNull();
      expect(dialog()).toBeNull();
      expect(video()).toBeNull();
      await mount.unmount();
    }
  });

  it('stops a stream that arrives after the sheet closed during the permission prompt', async () => {
    const track = new FakeTrack();
    const prompt = deferred<MediaStream>();
    camera(() => prompt.promise);
    await open(fakeController().controller);

    await click(mustButton('Scan with camera'));
    await click(mustButton('Close'));
    expect(dialog()).toBeNull();

    prompt.resolve(streamOf(track));
    await settle();
    await settle();
    expect(track.stop).toHaveBeenCalledTimes(1);
    expect(video()).toBeNull();
  });

  it('stops when the app goes to the background, and offers Scan again (D6)', async () => {
    const track = new FakeTrack();
    camera(async () => streamOf(track));
    await open(fakeController().controller);
    const preview = await scanning(() => new Promise(() => {}));

    stub(document, 'hidden', { get: () => true });
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });

    expect(track.stop).toHaveBeenCalledTimes(1);
    expect(preview.srcObject).toBeNull();
    expect(status()).toEqual([SCAN_END_WORDING.hidden]);
    expect(button('Scan again')).not.toBeNull();
  });

  it('stops a stream that arrives while the app is in the background, and offers Scan again (D6)', async () => {
    // The person pressed Scan with camera and left before the prompt answered,
    // or the WebView went hidden around the system dialog. The only
    // visibilitychange fired while the pane was still opening, and none comes
    // while it stays hidden, so the pane has to look when the stream arrives.
    const track = new FakeTrack();
    const prompt = deferred<MediaStream>();
    camera(() => prompt.promise);
    await open(fakeController().controller);

    await click(mustButton('Scan with camera'));
    stub(document, 'hidden', { get: () => true });
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    prompt.resolve(streamOf(track));
    await until(() => button('Scan again'), 'Scan again');

    expect(track.stop).toHaveBeenCalledTimes(1);
    expect(video()).toBeNull();
    expect(status()).toEqual([SCAN_END_WORDING.hidden]);
    expect(decoder.decodeFrame).not.toHaveBeenCalled();
  });

  it('ignores a visibilitychange that leaves the app visible', async () => {
    const track = new FakeTrack();
    camera(async () => streamOf(track));
    await open(fakeController().controller);
    await scanning(() => new Promise(() => {}));

    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(track.stop).not.toHaveBeenCalled();
    expect(video()).not.toBeNull();
  });

  it('keeps the camera on until the result under StrictMode, which the app renders in', async () => {
    // src/main.tsx wraps the app in <StrictMode>, which runs a component's
    // effects an extra time when it mounts. A scan started from a mount-time
    // effect would stop its own tracks there and restart on a dead stream;
    // this pane mounts idle and starts only on a press, and this shows it.
    const track = new FakeTrack();
    const stream = streamOf(track);
    const getUserMedia = camera(async () => stream);
    const frame = deferred<string | null>();
    decoder.decodeFrame.mockImplementation(() => frame.promise);
    mounted.push(
      await render(
        <StrictMode>
          <PairingSheet controller={fakeController().controller} onClose={() => {}} onOutcome={() => {}} />
        </StrictMode>,
      ),
    );

    await scanPane();
    await click(mustButton('Scan with camera'));
    const preview = await until(video, 'the camera preview');
    await settle();
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(track.stop).not.toHaveBeenCalled();
    expect(preview.srcObject).toBe(stream);

    frame.resolve(code());
    await until(confirmOpen, 'Confirm');
    expect(track.stop).toHaveBeenCalledTimes(1);
  });
});

/* ── How a scan can end ─────────────────────────────────────────────── */

describe('each way a scan ends without a code has its own words and Scan again', () => {
  it('names every stop reason, and the words differ', () => {
    const words = Object.values(SCAN_END_WORDING);
    expect(new Set(words).size).toBe(words.length);
    expect(Object.keys(SCAN_END_WORDING).sort()).toEqual(
      ['decode-failed', 'hidden', 'idle-timeout', 'invalid-code', 'track-ended'].sort(),
    );
  });

  it('says only what the phone measured when its window runs out, and claims no code expired', () => {
    // The phone times its own scan with DEFAULT_WINDOW_MS. A code's deadline is
    // whatever its host wrote into expiresAt, and a code still valid after the
    // phone's window has run out passes validateScannedPayload. So the phone
    // cannot say that a code shown when scanning began has expired.
    const began = 1_900_000_000;
    const windowEnd = began + DEFAULT_WINDOW_MS / 1000;
    const longLived = decodePairingUri(code({ expiresAt: windowEnd + 600 }));
    expect(validateScannedPayload(longLived, windowEnd + 1)).toEqual({ ok: true });
    expect(SCAN_END_WORDING['idle-timeout']).toBe('No pairing code was found in time, so scanning stopped.');
    expect(SCAN_END_WORDING['idle-timeout']).not.toMatch(/expire/i);
  });

  it('when the OS ends the track', async () => {
    const track = new FakeTrack();
    camera(async () => streamOf(track));
    await open(fakeController().controller);
    await scanning(() => new Promise(() => {}));
    await act(async () => track.fire('ended'));
    await until(() => button('Scan again'), 'Scan again');
    expect(status()).toEqual([SCAN_END_WORDING['track-ended']]);
    expect(track.stop).toHaveBeenCalledTimes(1);
  });

  it('when the decoder fails', async () => {
    const track = new FakeTrack();
    camera(async () => streamOf(track));
    await open(fakeController().controller);
    decoder.decodeFrame.mockRejectedValue(new Error('chunk failed to load'));
    await click(mustButton('Scan with camera'));
    await until(() => button('Scan again'), 'Scan again');
    expect(status()).toEqual([SCAN_END_WORDING['decode-failed']]);
    expect(track.stop).toHaveBeenCalledTimes(1);
  });

  it('when a pairing code is malformed', async () => {
    const track = new FakeTrack();
    camera(async () => streamOf(track));
    await open(fakeController().controller);
    decoder.decodeFrame.mockResolvedValue('chatterang-pair:!!!');
    await click(mustButton('Scan with camera'));
    await until(() => button('Scan again'), 'Scan again');
    expect(status()).toEqual([SCAN_END_WORDING['invalid-code']]);
    expect(track.stop).toHaveBeenCalledTimes(1);
  });

  it('when nothing is read within the window', async () => {
    const track = new FakeTrack();
    camera(async () => streamOf(track));
    let clock = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => clock);
    await open(fakeController().controller);
    await scanning(async () => null);
    // Let the first decode settle, so the next attempt is already scheduled
    // on the unmoved clock, then move the clock past the window.
    await settle();
    await settle();
    clock = 1e9;
    await until(() => button('Scan again'), 'Scan again');
    expect(status()).toEqual([SCAN_END_WORDING['idle-timeout']]);
    expect(track.stop).toHaveBeenCalledTimes(1);
  });

  it('keeps scanning past a QR code that is not a pairing code, with a hint', async () => {
    const track = new FakeTrack();
    camera(async () => streamOf(track));
    await open(fakeController().controller);
    decoder.decodeFrame.mockResolvedValueOnce('https://example.com/menu').mockImplementation(() => new Promise(() => {}));
    await click(mustButton('Scan with camera'));
    await until(() => status().includes(NOT_A_PAIRING_CODE), 'the hint');
    expect(track.stop).not.toHaveBeenCalled();
    expect(video()).not.toBeNull();
    expect(button('Scan again')).toBeNull();
  });
});

/* ── A code that was read ───────────────────────────────────────────── */

describe('a scanned code is checked before anything is sent', () => {
  async function scanOnce(uri: string) {
    const track = new FakeTrack();
    camera(async () => streamOf(track));
    const fake = fakeController();
    const sheet = await open(fake.controller);
    decoder.decodeFrame.mockResolvedValueOnce(uri).mockImplementation(() => new Promise(() => {}));
    await click(mustButton('Scan with camera'));
    await until(() => confirmOpen() || button('Scan again'), 'Confirm or Scan again');
    return { ...fake, ...sheet, track };
  }

  it('refuses what validateScannedPayload refuses, in its words, and shows no Confirm', async () => {
    const cases: readonly [string, keyof typeof SCANNED_PROBLEM_WORDING][] = [
      [code({ expiresAt: 1_000 }), 'expired'],
      [code({ trustMode: TRUST_STATIC_KEY }), 'unsupported-trust-mode'],
      [code({ addresses: [{ kind: ADDRESS_DNS, value: text('desk.local') }] }), 'unreachable'],
    ];
    for (const [uri, problem] of cases) {
      const { pair, track, mount } = await scanOnce(uri);
      expect(confirmOpen(), problem).toBe(false);
      expect(status(), problem).toEqual([SCANNED_PROBLEM_WORDING[problem]]);
      expect(button('Scan again'), problem).not.toBeNull();
      expect(track.stop, problem).toHaveBeenCalledTimes(1);
      expect(pair, problem).not.toHaveBeenCalled();
      await mount.unmount();
    }
  });

  it('refuses a name with a bidi override or a control character, in the invalid-code words (D11)', async () => {
    for (const ch of [0x202e, 0x2066, 0x07, 0x85]) {
      const name = `Desk${String.fromCharCode(ch)}koob`;
      const { pair, mount } = await scanOnce(code({ name }));
      expect(confirmOpen(), name).toBe(false);
      expect(status(), name).toEqual([SCAN_END_WORDING['invalid-code']]);
      expect(reads(document.body)).not.toContain('koob');
      expect(pair).not.toHaveBeenCalled();
      await mount.unmount();
    }
    // The paired control: a plain name reaches Confirm, attributed to the code.
    await scanOnce(code({ name: 'John’s MacBook' }));
    expect(confirmOpen()).toBe(true);
    const details = [...document.querySelectorAll('.confirm__detail li')].map((li) => reads(li));
    expect(details).toEqual(confirmDetail('John’s MacBook'));
    expect(details[0]).toBe('It calls itself “John’s MacBook”.');
  });

  it('does not quote a name that is only blank space, and says the code gives none', async () => {
    // The parser admits any 1..64 bytes of UTF-8, so a single space is a name
    // it accepts. Quoting it would draw empty marks as if they named a machine.
    for (const blank of [' ', '   ', String.fromCharCode(0xa0)]) {
      const { pair, mount } = await scanOnce(code({ name: blank }));
      expect(confirmOpen(), JSON.stringify(blank)).toBe(true);
      const details = [...document.querySelectorAll('.confirm__detail li')].map((li) => reads(li));
      expect(details, JSON.stringify(blank)).toEqual(['The code gives no name.']);
      expect(reads(document.body), JSON.stringify(blank)).not.toContain('calls itself');
      expect(pair).not.toHaveBeenCalled();
      await mount.unmount();
    }
    expect(confirmDetail('')).toEqual(['The code gives no name.']);
  });

  it('sends the payload exactly as it was read on Pair, and nothing on Cancel', async () => {
    const uri = code();
    const { pair } = await scanOnce(uri);
    expect(confirmOpen()).toBe(true);

    await click(mustButton('Cancel'));
    expect(confirmOpen()).toBe(false);
    expect(pair).not.toHaveBeenCalled();
    expect(dialog()).not.toBeNull();

    decoder.decodeFrame.mockReset();
    decoder.decodeFrame.mockResolvedValueOnce(uri).mockImplementation(() => new Promise(() => {}));
    await click(mustButton('Scan with camera'));
    await until(confirmOpen, 'Confirm again');
    await click(mustButton('Pair'));
    await settle();

    expect(pair).toHaveBeenCalledTimes(1);
    const [request, signal] = pair.mock.calls[0]!;
    expect(request).toStrictEqual({ route: 'scanned', payload: decodePairingUri(uri) });
    expect(Object.keys(request).sort()).toEqual(['payload', 'route']);
    expect(signal).toBeInstanceOf(AbortSignal);
  });

  it('still hands up a scanned pairing that completes after the sheet closed (D9)', async () => {
    const pending = deferred<PairingOutcome>();
    const { controller, pair } = fakeController(() => pending.promise);
    camera(async () => streamOf(new FakeTrack()));
    const { onOutcome, onClose } = await open(controller);
    decoder.decodeFrame.mockResolvedValueOnce(code()).mockImplementation(() => new Promise(() => {}));
    await click(mustButton('Scan with camera'));
    await until(confirmOpen, 'Confirm');
    await click(mustButton('Pair'));
    expect(pair).toHaveBeenCalledTimes(1);
    expect(pair.mock.calls[0]![1]!.aborted).toBe(false);

    await click(mustButton('Close'));
    expect(pair.mock.calls[0]![1]!.aborted).toBe(true);
    pending.resolve({ kind: 'paired', deviceName: 'Desk' });
    await settle();
    expect(onOutcome).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
