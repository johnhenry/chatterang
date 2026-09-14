import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { installPermissionHandlers, type PermissionSessionLike } from '@chatterang/desktop/permissions';
import {
  APP_ORIGIN,
  DESKTOP_GRANTED_PERMISSIONS,
  isPermissionGranted,
  permissionRequestUrl,
} from '@chatterang/desktop/security';

/**
 * The desktop's Electron permission policy.
 *
 * Electron approves every permission request automatically when no handler is
 * installed, and the shell installed none — so the renderer could obtain the
 * camera, microphone, location and more without the app asking. No untrusted
 * script path to those APIs was found (model HTML renders in a script-less
 * `sandbox=""` iframe, and navigation is locked to the app origin), so this is
 * defence in depth: it decides what a future renderer compromise could reach.
 */

const APP_PAGE = `${APP_ORIGIN}/index.html`;
const NO_DEV = '';

/**
 * Every permission type Electron 44's session docs list for the request
 * handler, plus one this build has never heard of. Deny-by-default is only
 * proven if the unfamiliar one is denied too.
 */
const ELECTRON_PERMISSIONS = [
  'ar', 'automatic-fullscreen', 'background-fetch', 'background-sync', 'captured-surface-control',
  'clipboard-read', 'clipboard-sanitized-write', 'deprecated-sync-clipboard-read', 'display-capture',
  'fileSystem', 'fullscreen', 'geolocation', 'geolocation-approximate', 'hand-tracking', 'hid',
  'idle-detection', 'keyboardLock', 'local-fonts', 'local-network', 'local-network-access',
  'loopback-network', 'media', 'mediaKeySystem', 'midi', 'midiSysex', 'nfc', 'notifications',
  'openExternal', 'payment-handler', 'periodic-background-sync', 'persistent-storage', 'pointerLock',
  'screen-wake-lock', 'sensors', 'serial', 'smart-card', 'speaker-selection', 'storage-access',
  'system-wake-lock', 'top-level-storage-access', 'usb', 'vr', 'web-app-installation',
  'web-printing', 'window-management', 'unknown', 'some-permission-chromium-adds-next-year',
];

describe('what the desktop grants', () => {
  it('grants exactly one permission, and it is clipboard write', () => {
    // Load-bearing, measured: under a deny-all handler in Electron 44,
    // `navigator.clipboard.writeText` fails with NotAllowedError, which would
    // break every copy button in the app.
    expect([...DESKTOP_GRANTED_PERMISSIONS]).toEqual(['clipboard-sanitized-write']);
  });

  it('grants clipboard write to the app’s own page, in the main frame', () => {
    expect(isPermissionGranted({ permission: 'clipboard-sanitized-write', requestingUrl: APP_PAGE, isMainFrame: true }, NO_DEV)).toBe(true);
  });

  it('denies every other permission Electron can ask about, including one it has not invented yet', () => {
    const granted = ELECTRON_PERMISSIONS.filter((permission) =>
      isPermissionGranted({ permission, requestingUrl: APP_PAGE, isMainFrame: true }, NO_DEV),
    );
    expect(granted).toEqual(['clipboard-sanitized-write']);
  });

  it('never grants a subframe, even from the app’s own origin', () => {
    // The only frames the app creates are `sandbox=""` model-HTML previews.
    expect(isPermissionGranted({ permission: 'clipboard-sanitized-write', requestingUrl: APP_PAGE, isMainFrame: false }, NO_DEV)).toBe(false);
  });

  it('never grants another origin, a sandboxed document, or an unknown one', () => {
    for (const requestingUrl of [
      'https://evil.example/', 'about:srcdoc', 'about:blank', '', 'null',
      'chatterang-desktop://app-evil/', 'chatterang-desktop://app.evil.example/', 'http://localhost:5273/',
    ]) {
      expect(
        isPermissionGranted({ permission: 'clipboard-sanitized-write', requestingUrl, isMainFrame: true }, NO_DEV),
        requestingUrl,
      ).toBe(false);
    }
  });

  it('trusts the dev server only when one is configured', () => {
    const query = { permission: 'clipboard-sanitized-write', requestingUrl: 'http://localhost:5273/', isMainFrame: true };
    expect(isPermissionGranted(query, 'http://localhost:5273')).toBe(true);
    expect(isPermissionGranted(query, '')).toBe(false);
  });
});

describe('which URL a request is about', () => {
  it('prefers the requesting URL, then the origin, then the main frame’s own URL', () => {
    expect(permissionRequestUrl({ requestingUrl: 'a://x/1', isMainFrame: true }, 'b://y', 'c://z/')).toBe('a://x/1');
    expect(permissionRequestUrl({ isMainFrame: true }, 'b://y', 'c://z/')).toBe('b://y');
    expect(permissionRequestUrl({ isMainFrame: true }, '', 'c://z/')).toBe('c://z/');
  });

  it('gives a subframe with nothing to go on an empty URL, which no origin test accepts', () => {
    // Measured: media and geolocation checks arrive with an EMPTY origin. A
    // subframe must not borrow the window's URL to fill that in.
    expect(permissionRequestUrl({ isMainFrame: false }, '', APP_PAGE)).toBe('');
    expect(permissionRequestUrl({}, '', APP_PAGE)).toBe('');
  });
});

describe('the handlers main.ts installs', () => {
  function fakeSession() {
    let request: Parameters<PermissionSessionLike['setPermissionRequestHandler']>[0] | undefined;
    let check: Parameters<PermissionSessionLike['setPermissionCheckHandler']>[0] | undefined;
    const session: PermissionSessionLike = {
      setPermissionRequestHandler: vi.fn((h) => { request = h; }),
      setPermissionCheckHandler: vi.fn((h) => { check = h; }),
    };
    installPermissionHandlers(session, NO_DEV);
    return { session, request: request!, check: check! };
  }
  const page = (url: string) => ({ getURL: () => url });

  it('installs BOTH handlers, because most APIs check before they request', () => {
    const { session } = fakeSession();
    expect(session.setPermissionRequestHandler).toHaveBeenCalledOnce();
    expect(session.setPermissionCheckHandler).toHaveBeenCalledOnce();
  });

  it('answers a request through the callback', () => {
    const { request } = fakeSession();
    const callback = vi.fn();
    request(page(APP_PAGE), 'clipboard-sanitized-write', callback, { requestingUrl: APP_PAGE, isMainFrame: true });
    expect(callback).toHaveBeenLastCalledWith(true);
    request(page(APP_PAGE), 'media', callback, { requestingUrl: APP_PAGE, isMainFrame: true });
    expect(callback).toHaveBeenLastCalledWith(false);
  });

  it('answers a check with the same policy, using the window URL for an empty-origin main frame', () => {
    const { check } = fakeSession();
    expect(check(page(APP_PAGE), 'clipboard-sanitized-write', '', { isMainFrame: true })).toBe(true);
    expect(check(page(APP_PAGE), 'media', '', { isMainFrame: true })).toBe(false);
    expect(check(page(APP_PAGE), 'clipboard-sanitized-write', '', { isMainFrame: false })).toBe(false);
    // Electron may pass no webContents to a check at all.
    expect(check(null, 'clipboard-sanitized-write', '', { isMainFrame: true })).toBe(false);
  });

  it('denies a SUBFRAME that reports the app’s own URL, on both handlers', () => {
    /*
     * FOUND BY MUTATION. Forcing the check handler to treat every frame as the
     * main frame survived the suite, because the subframe test above carried no
     * URL and was denied by the empty-URL fallback instead of the main-frame
     * rule. A subframe that DOES report the app's URL is what the main-frame
     * rule exists for: same origin, and still never trusted.
     */
    const { request, check } = fakeSession();
    const callback = vi.fn();
    request(page(APP_PAGE), 'clipboard-sanitized-write', callback, { requestingUrl: APP_PAGE, isMainFrame: false });
    expect(callback).toHaveBeenLastCalledWith(false);
    expect(check(page(APP_PAGE), 'clipboard-sanitized-write', APP_ORIGIN, { requestingUrl: APP_PAGE, isMainFrame: false })).toBe(false);
  });

  it('denies a request from a page that is not the app', () => {
    const { request } = fakeSession();
    const callback = vi.fn();
    request(page('https://evil.example/'), 'clipboard-sanitized-write', callback, { isMainFrame: true });
    expect(callback).toHaveBeenLastCalledWith(false);
  });
});

describe('main.ts installs it before any window can load', () => {
  // main.ts cannot be imported by a test (protocol and app calls run at module
  // scope), so its wiring is pinned as source text, comments stripped.
  const code = readFileSync(resolve(process.cwd(), 'apps/desktop/src/main.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n');

  it('calls installPermissionHandlers on the default session, exactly once', () => {
    expect(code).toMatch(/import \{[^}]*\bsession\b[^}]*\} from 'electron'/);
    expect(code).toContain("import { installPermissionHandlers } from './permissions.js';");
    expect(code.match(/installPermissionHandlers\(/g)).toHaveLength(1);
    expect(code).toContain('installPermissionHandlers(session.defaultSession, DEV_SERVER_URL);');
  });

  it('does so inside whenReady and before start(), which creates the window', () => {
    const ready = code.indexOf('app.whenReady().then(');
    const install = code.indexOf('installPermissionHandlers(session.defaultSession');
    const startCall = code.indexOf('start();', ready);
    expect(ready).toBeGreaterThan(-1);
    expect(install).toBeGreaterThan(ready);
    expect(startCall).toBeGreaterThan(install);
  });

  it('never clears a handler or installs a second, looser one', () => {
    expect(code).not.toMatch(/setPermission(Request|Check)Handler\(/);
  });
});

describe('the wiring stays platform-free', () => {
  it('permissions.ts imports no Electron, so this file can drive the real handlers', () => {
    const source = readFileSync(resolve(process.cwd(), 'apps/desktop/src/permissions.ts'), 'utf8');
    const specifiers = [...source.matchAll(/(?:from|import)\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
    expect(specifiers).toEqual(['./security.js']);
  });
});
