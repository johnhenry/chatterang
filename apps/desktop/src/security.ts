/**
 * The desktop shell's security posture, as pure functions.
 *
 * WHY THIS FILE EXISTS.
 *
 * `main.ts` is the one file in `apps/desktop` the test suite structurally
 * cannot reach: importing it runs `protocol.registerSchemesAsPrivileged` and
 * `app.whenReady()` at module scope, so it needs a live Electron runtime. That
 * is fine for the wiring — a `BrowserWindow` constructor call is not logic —
 * but every *decision* that lived there was therefore unverified: the
 * trusted-origin check, the bundle path resolver, the CSP, the navigation lock
 * and the two `shell.openExternal` call sites were all mutation-free. You could
 * delete the `..` guard from `resolveWithinRoot` and the whole suite stayed
 * green.
 *
 * So the decisions live here, where they import no Electron and
 * `tests/desktop-security.test.ts` drives them directly, and `main.ts` keeps
 * only the Electron objects it has to touch. This is the same split that makes
 * `src/bridge` testable, applied to the security surface.
 *
 * NOTHING IN THIS FILE IS A FIX. It is an extraction: every predicate below
 * behaves exactly as the code in `main.ts` behaved before it moved, including
 * where that behaviour is wrong. The known-wrong parts are marked DEFECT and
 * have tests that assert the wrong answer on purpose, so the phase that fixes
 * them has a failing test to flip rather than a blank page.
 */

import { join } from 'node:path';

/** The privileged scheme the production bundle is served from. */
export const APP_SCHEME = 'chatterang-desktop';

/** The only origin a window of ours is ever allowed to be showing. */
export const APP_ORIGIN = `${APP_SCHEME}://app`;

/**
 * The Content-Security-Policy served with every document from the app scheme.
 *
 * `'unsafe-inline'` in `style-src` is load-bearing: the renderer's styling
 * injects style elements at runtime. Scripts have no such escape hatch, which
 * is the half that matters.
 */
export const CSP_PRODUCTION = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self' https: wss:",
  "object-src 'none'",
  "frame-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

/** Extension → content type for everything the bundle actually contains. */
export const MIME: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
  '.map': 'application/json; charset=utf-8',
};

const HTML_TYPE = MIME['.html'] ?? 'text/html; charset=utf-8';

/* ── Origin trust ─────────────────────────────────────────────────────── */

/**
 * Is `url` a page we are willing to treat as our own?
 *
 * Used for two different questions that happen to have the same answer: may
 * this sender reach a plugin (the `isTrusted` half that does not need a frame),
 * and may this navigation proceed in-window (the navigation lock). Both call
 * sites in `main.ts` had their own copy of this expression; a single predicate
 * means a fix cannot land on one and miss the other.
 *
 * DEFECT [5]: this is a string prefix test, so it is not an origin test.
 * `chatterang-desktop://appzz` and `chatterang-desktop://app-evil` both pass —
 * and `protocol.handle` ignores the URL host entirely, so those sibling hosts
 * are served the same bundle from the same disk. `tests/desktop-security.test.ts`
 * asserts today's wrong answers so that the fix (compare `new URL(url).origin`)
 * shows up as those tests flipping rather than as a silent behaviour change.
 *
 * The dev-server arm has the same shape and the same hole:
 * `http://localhost:5273` prefixes `http://localhost:52739`. It only applies
 * when `CHATTERANG_DEV_SERVER_URL` is set, and `scripts/sync.mjs` refuses to
 * package a build that has one.
 *
 * @param url the URL to judge, as `webContents.getURL()` reports it.
 * @param devServerUrl `CHATTERANG_DEV_SERVER_URL`, or `''` in a real build.
 */
export function isTrustedOrigin(url: string, devServerUrl: string): boolean {
  if (url.startsWith(APP_ORIGIN)) return true;
  return devServerUrl !== '' && url.startsWith(devServerUrl);
}

/* ── Leaving the app ──────────────────────────────────────────────────── */

/**
 * May this URL be handed to the OS via `shell.openExternal`?
 *
 * DEFECT [14]: TODAY, ANYTHING MAY. There is no allowlist in `main.ts` — both
 * `will-navigate` and `setWindowOpenHandler` pass a page-controlled string
 * straight to the OS handler, so `file://`, `smb://` and every macOS-registered
 * application scheme launch on the user's behalf. Model output renders as
 * Markdown, which makes the string model-reachable.
 *
 * This function exists so the fix has exactly one place to land and both call
 * sites already route through it. It returns `true` unconditionally because
 * that is what the shipped code does; the tests assert that, and the fix flips
 * them. The parameter is deliberately unused for now.
 */
export function isAllowedExternalUrl(_url: string): boolean {
  return true;
}

/* ── Serving the bundle from disk ─────────────────────────────────────── */

/**
 * Resolve a request path inside the app root, or reject it.
 *
 * Returns null for anything that escapes, so `../../../etc/passwd` is a 404
 * rather than a file read. Note that the check is on the *resolved* path, not
 * on the text of the request, so `%2e%2e%2f` and `/a/../../b` are caught too —
 * `join` normalises before the comparison.
 *
 * Throws whatever `decodeURIComponent` throws on a malformed escape (`/%zz`).
 * That is the behaviour this had in `main.ts`, where it surfaced as a rejected
 * `protocol.handle` promise rather than a 404; it is recorded in a test rather
 * than quietly changed here.
 */
export function resolveWithinRoot(root: string, pathname: string): string | null {
  const decoded = decodeURIComponent(pathname).replace(/^\/+/, '');
  const resolved = join(root, decoded);
  const prefix = root.endsWith('/') ? root : `${root}/`;
  return resolved === root || resolved.startsWith(prefix) ? resolved : null;
}

/** What `serveBundle` should read and what headers it should answer with. */
export interface BundleTarget {
  /** Absolute path of the file to read. */
  readonly file: string;
  /** The `content-type` header value. */
  readonly contentType: string;
  /** The `content-security-policy` header value, for documents only. */
  readonly csp?: string;
}

/**
 * Decide what a request for `pathname` should serve — with no filesystem access.
 *
 * The SPA fallback is the subtle part: an extensionless path is a client route
 * (`/settings`), so it serves `index.html` rather than 404ing, while a path
 * that *has* an extension is a real asset request and 404s if the file is
 * missing. Getting that backwards makes every deep link a blank page, which is
 * precisely the class of failure this app keeps shipping, so it is tested here
 * rather than discovered in a window.
 *
 * Returns null when the path escapes the root; the caller answers 404.
 */
export function resolveBundleRequest(root: string, pathname: string): BundleTarget | null {
  const target = resolveWithinRoot(root, pathname === '/' ? '/index.html' : pathname);
  if (target === null) return null;

  const extension = /\.[a-z0-9]+$/i.exec(target)?.[0]?.toLowerCase() ?? '';
  const file = extension === '' ? join(root, 'index.html') : target;
  const contentType =
    extension === '' ? HTML_TYPE : (MIME[extension] ?? 'application/octet-stream');

  return contentType === HTML_TYPE ? { file, contentType, csp: CSP_PRODUCTION } : { file, contentType };
}
