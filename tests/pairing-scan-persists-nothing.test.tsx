/**
 * "NOTHING THE CAMERA SEES IS STORED OR SENT ANYWHERE" — THE CONDUCT (#128).
 *
 * The camera usage string makes that promise in an OS dialog, and
 * `tests/privacy-copy.test.ts` pins the sentence. This file measures it where
 * the scanner lands: a real scan through the real sheet, pane and loop, driven
 * twice — read a code, reach Confirm, Cancel; read it again, reach Confirm,
 * Pair — with every place a frame or the decoded text could go watched.
 *
 * WHAT IT DOES NOT CLAIM. Once a controller exists, the PAYLOAD derived from a
 * frame is sent to the host that drew it; that is what pairing is (#128's
 * owner comment carries Apple's caveat). What is measured here is that pair()
 * receives the parsed payload and nothing else — no pixels, no canvas, no
 * blob — and that no store, network path, clipboard or log receives anything.
 *
 * Its own file, because it mocks `@/db`, `@/lib/blobs`, both Capacitor storage
 * plugins and the decoder for the whole module graph.
 */

import { useState, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const spies = vi.hoisted(() => ({
  blobsPut: vi.fn(async () => {}),
  putBlob: vi.fn(async () => {}),
  preferencesSet: vi.fn(async () => {}),
  writeFile: vi.fn(async () => ({ uri: '' })),
  decodeFrame: vi.fn<(frame: { data: Uint8ClampedArray; width: number; height: number }) => Promise<string | null>>(),
}));

vi.mock('@/db', () => ({ db: { blobs: { put: spies.blobsPut } } }));
vi.mock('@/lib/blobs', () => ({ putBlob: spies.putBlob }));
vi.mock('@capacitor/preferences', () => ({ Preferences: { set: spies.preferencesSet } }));
vi.mock('@capacitor/filesystem', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@capacitor/filesystem')>();
  return { ...actual, Filesystem: { writeFile: spies.writeFile } };
});
vi.mock('@/lib/qr-decode', () => ({ decodeFrame: spies.decodeFrame }));

import { ADDRESS_IPV4, HOST_DESKTOP, TRUST_BYTES, TRUST_SPKI_PIN, decodePairingUri, encodePairingUri } from '@chatterang/tunnel/pairing';
import type { PairingController, PairingOutcome, PairingRequest } from '@/lib/pairing';
import { PairingSheet } from '@/features/pairing/PairingSheet';
import { CONFIRM_TITLE } from '@/features/pairing/wording';
import { CAMERA_USAGE_DESCRIPTION } from '../scripts/patch-native.mjs';

import { button, click, mustButton, reads, render, settle, type Mounted } from './support/pairing-dom';

const URI = encodePairingUri({
  version: 1,
  hostKind: HOST_DESKTOP,
  trustMode: TRUST_SPKI_PIN,
  trust: Uint8Array.from({ length: TRUST_BYTES }, (_, i) => i + 1),
  token: new Uint8Array(32).fill(2),
  expiresAt: 4_000_000_000,
  port: 51234,
  addresses: [{ kind: ADDRESS_IPV4, value: Uint8Array.of(192, 168, 1, 4) }],
  name: 'Desk',
});

class FakeTrack {
  stop = vi.fn();
  addEventListener() {}
  removeEventListener() {}
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

const mounted: Mounted[] = [];

beforeEach(() => {
  stub(HTMLMediaElement.prototype, 'readyState', { get: () => 4 });
  stub(HTMLVideoElement.prototype, 'videoWidth', { get: () => 640 });
  stub(HTMLVideoElement.prototype, 'videoHeight', { get: () => 480 });
  stub(HTMLCanvasElement.prototype, 'getContext', {
    value: () => ({
      drawImage: () => {},
      getImageData: (_x: number, _y: number, w: number, h: number) => ({
        data: new Uint8ClampedArray(w * h * 4).fill(7),
        width: w,
        height: h,
      }),
    }),
  });
});

afterEach(async () => {
  for (const mount of mounted.splice(0)) await mount.unmount();
  for (const restore of restorers.splice(0).reverse()) restore();
  vi.restoreAllMocks();
});

function Harness({ controller }: { controller: PairingController }): ReactNode {
  const [open, setOpen] = useState(true);
  return open ? <PairingSheet controller={controller} onClose={() => setOpen(false)} onOutcome={() => {}} /> : null;
}

const confirmOpen = () => [...document.querySelectorAll('[role="dialog"] h2')].some((h) => reads(h) === CONFIRM_TITLE);

async function until(ready: () => unknown, what: string): Promise<void> {
  for (let i = 0; i < 100; i += 1) {
    if (ready()) return;
    await settle();
  }
  throw new Error(`never happened: ${what}`);
}

/** Everything reachable from a value, so nothing can hide a frame one level down. */
function* graph(value: unknown, seen = new Set<unknown>()): Generator<unknown> {
  if (value === null || typeof value !== 'object' || seen.has(value)) {
    yield value;
    return;
  }
  seen.add(value);
  yield value;
  if (ArrayBuffer.isView(value)) return;
  for (const child of Object.values(value)) yield* graph(child, seen);
}

describe('a scan persists nothing', () => {
  it('stores, sends, copies and logs nothing across Cancel and Pair, and pair() receives only the parsed payload', async () => {
    // The claim, from the file the sync step writes into the native projects.
    expect(CAMERA_USAGE_DESCRIPTION).toContain('Nothing the camera sees is stored or sent anywhere.');

    /* Every route off the device or into storage, watched. */
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const xhrOpen = vi.spyOn(XMLHttpRequest.prototype, 'open');
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const toBlob = vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(() => {});
    const toDataURL = vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockImplementation(() => '');
    const socket = vi.fn();
    const worker = vi.fn();
    const beacon = vi.fn(() => true);
    const idbOpen = vi.fn();
    const objectUrl = vi.fn(() => 'blob:x');
    const clipboardWrite = vi.fn(async () => {});
    stub(globalThis, 'WebSocket', { value: socket, writable: true });
    stub(globalThis, 'Worker', { value: worker, writable: true });
    stub(globalThis, 'indexedDB', { value: { open: idbOpen }, writable: true });
    stub(URL, 'createObjectURL', { value: objectUrl, writable: true });
    stub(navigator, 'sendBeacon', { value: beacon, writable: true });
    stub(navigator, 'clipboard', { value: { writeText: clipboardWrite }, writable: true });
    const consoles = (['log', 'info', 'warn', 'error', 'debug'] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => {}),
    );

    const track = new FakeTrack();
    const getUserMedia = vi.fn(async () => ({ getTracks: () => [track] }) as unknown as MediaStream);
    stub(navigator, 'mediaDevices', { value: { getUserMedia } });
    const frames: Uint8ClampedArray[] = [];
    spies.decodeFrame.mockImplementation(async (frame) => {
      frames.push(frame.data);
      return URI;
    });

    const pair = vi.fn<(request: PairingRequest, signal?: AbortSignal) => Promise<PairingOutcome>>(async () => ({
      kind: 'paired',
      deviceName: 'Desk',
    }));
    mounted.push(await render(<Harness controller={{ available: true, pair }} />));

    // Once: read, Confirm, Cancel.
    await click(mustButton('Scan with camera'));
    await until(confirmOpen, 'Confirm');
    await click(mustButton('Cancel'));
    expect(confirmOpen()).toBe(false);
    expect(pair).not.toHaveBeenCalled();

    // Twice: read, Confirm, Pair.
    await click(mustButton('Scan with camera'));
    await until(confirmOpen, 'Confirm again');
    await click(mustButton('Pair'));
    await settle();

    // Frames really flowed, so the zeros below are about where they went.
    expect(frames.length).toBeGreaterThanOrEqual(2);
    expect(frames[0]).toBeInstanceOf(Uint8ClampedArray);
    expect(getUserMedia).toHaveBeenCalledTimes(2);
    expect(track.stop).toHaveBeenCalledTimes(2);

    for (const [name, spy] of Object.entries({
      'db.blobs.put': spies.blobsPut,
      putBlob: spies.putBlob,
      'Preferences.set': spies.preferencesSet,
      'Filesystem.writeFile': spies.writeFile,
      fetch: fetchSpy,
      'XMLHttpRequest.open': xhrOpen,
      WebSocket: socket,
      'navigator.sendBeacon': beacon,
      Worker: worker,
      'Storage.setItem': setItem,
      'indexedDB.open': idbOpen,
      'canvas.toBlob': toBlob,
      'canvas.toDataURL': toDataURL,
      'URL.createObjectURL': objectUrl,
      'clipboard.writeText': clipboardWrite,
    })) {
      expect(spy, name).not.toHaveBeenCalled();
    }

    expect(pair).toHaveBeenCalledTimes(1);
    const request = pair.mock.calls[0]![0];
    expect(request).toStrictEqual({ route: 'scanned', payload: decodePairingUri(URI) });
    // The fingerprint the Type pane's sentence says a scanned code carries.
    expect((request as Extract<PairingRequest, { route: 'scanned' }>).payload.trust).toHaveLength(TRUST_BYTES);
    for (const node of graph(request)) {
      expect(node instanceof Uint8ClampedArray, 'a frame buffer reached pair()').toBe(false);
      expect(node instanceof Blob, 'a blob reached pair()').toBe(false);
      expect(frames.includes(node as Uint8ClampedArray)).toBe(false);
    }

    // tests/setup.ts installs no console handling, so zero calls is not the
    // claim. No argument may be a frame or carry the decoded text.
    for (const arg of consoles.flatMap((spy) => spy.mock.calls.flat())) {
      expect(arg instanceof Uint8ClampedArray).toBe(false);
      expect(String(arg)).not.toContain('chatterang-pair:');
    }

    /* The paired control: every watcher above registers a call made directly. */
    const { db } = (await import('@/db')) as unknown as { db: { blobs: { put: (row: unknown) => Promise<void> } } };
    await db.blobs.put({});
    const { putBlob } = await import('@/lib/blobs');
    await putBlob('control', new Blob());
    const { Preferences } = await import('@capacitor/preferences');
    await Preferences.set({ key: 'control', value: '1' });
    const { Filesystem } = await import('@capacitor/filesystem');
    await Filesystem.writeFile({ path: 'control', data: '1' });
    fetchSpy.mockResolvedValueOnce(new Response(''));
    await fetch('https://example.com/control');
    xhrOpen.mockImplementationOnce(() => {});
    new XMLHttpRequest().open('GET', 'https://example.com/control');
    new (globalThis.WebSocket as unknown as new (url: string) => unknown)('wss://example.com');
    navigator.sendBeacon('https://example.com/control');
    new (globalThis.Worker as unknown as new (url: string) => unknown)('control.js');
    localStorage.setItem('control', '1');
    localStorage.removeItem('control');
    (globalThis.indexedDB as unknown as { open: (name: string) => void }).open('control');
    document.createElement('canvas').toBlob(() => {});
    document.createElement('canvas').toDataURL();
    URL.createObjectURL(new Blob());
    await navigator.clipboard.writeText('control');
    for (const spy of [
      spies.blobsPut, spies.putBlob, spies.preferencesSet, spies.writeFile, fetchSpy, xhrOpen, socket,
      beacon, worker, setItem, idbOpen, toBlob, toDataURL, objectUrl, clipboardWrite,
    ]) {
      expect(spy).toHaveBeenCalledTimes(1);
    }
    console.log(URI);
    expect(consoles[0]!.mock.calls.flat()).toContain(URI);
    expect(button('Scan with camera')).toBeNull();
  });
});
