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
 * The file arrived as a pure EXTRACTION — every predicate behaving exactly as
 * `main.ts` had behaved, wrong parts included, each marked DEFECT with a test
 * asserting the wrong answer on purpose. Two of those have since been fixed
 * here ([5] the origin test, [14] the external-scheme allowlist) and their
 * tests flipped, which is the whole point of having pinned them: the change is
 * visible as a diff in a test file rather than as a silent edit nothing was
 * watching. Each fix keeps a WAS DEFECT note saying what the old behaviour was
 * and why the obvious repair would have been wrong.
 */

import { join, resolve, sep } from 'node:path';

/** The privileged scheme the production bundle is served from. */
export const APP_SCHEME = 'chatterang-desktop';

/** The only origin a window of ours is ever allowed to be showing. */
export const APP_ORIGIN = `${APP_SCHEME}://app`;

/**
 * The two third-party origins the app's own `index.html` reaches for.
 *
 * DEFECT [9]: the production policy allowed NEITHER, while `index.html` links a
 * Google Fonts stylesheet and the font files it pulls. In a packaged build the
 * app's own typography was therefore refused by its own policy — silently, as a
 * console message in a window nobody has open, with the page falling back to
 * the system stack. The CSP and the markup disagreed and nothing checked.
 *
 * THE RIGHT FIX IS TO SELF-HOST THESE, AND THAT IS NOT WHAT THIS IS. Vendoring
 * Archivo and IBM Plex Mono into the bundle would delete both origins, restore
 * `font-src 'self' data:`, and remove a third-party round trip from the cold
 * start of an app whose whole premise is that it does not phone anywhere. I did
 * not do it because it means downloading font binaries into the repository, and
 * that is not a thing to do on a user's machine without asking them. It is a
 * fetch away for whoever picks this up:
 *
 *   1. put `archivo-*.woff2` and `ibm-plex-mono-*.woff2` under `public/fonts/`;
 *   2. replace the `<link>` and both `<link rel="preconnect">` in `index.html`
 *      with local `@font-face` rules (the family names in
 *      `src/styles/tokens.css` already lead the stacks, so nothing else moves);
 *   3. delete this constant and put `font-src 'self' data:` back.
 *
 * The test in `tests/desktop-security.test.ts` derives the allowed origins from
 * `index.html` itself, so step 2 FAILS THE SUITE until step 3 is done — the
 * policy cannot silently stay wide after the markup stops needing it, which is
 * the drift that produced this defect in the first place.
 *
 * THE TRADE, PLAINLY: with these two origins the desktop build renders the
 * typography the design was drawn in (Archivo's width axis is used by
 * `--wdth-condensed`/`--wdth-expanded` and has no system-font equivalent) and
 * matches the web build, at the cost of one request to Google on every cold
 * start. Without them the app renders in the system stack and talks to nobody.
 * The web build already makes that request unconditionally — it has no CSP — so
 * this leaves the desktop shell no worse than the platform it mirrors, rather
 * than quietly making the desktop the only place the design does not apply.
 */
const FONT_STYLE_ORIGIN = 'https://fonts.googleapis.com';
const FONT_FILE_ORIGIN = 'https://fonts.gstatic.com';

/**
 * The Content-Security-Policy served with every document from the app scheme.
 *
 * `'unsafe-inline'` in `style-src` is load-bearing: the renderer's styling
 * injects style elements at runtime. Scripts have no such escape hatch, which
 * is the half that matters.
 *
 * The two font origins are the ONLY external hosts the policy names, and they
 * are named individually rather than as `https:` — see above for why they are
 * here at all and what removing them takes.
 *
 * `connect-src` IS THE OPPOSITE: IT ADMITS SCHEMES, NOT HOSTS, AND `http:` IS AN
 * OWNER RULING (#284). The provider adapters (`src/ai/providers.ts`) run in this
 * renderer with no main-process proxy, so this one directive decides which model
 * servers the desktop can reach. Ollama (`http://localhost:11434`), LM Studio
 * (`http://localhost:1234/v1`) and the custom OpenAI-compatible endpoint
 * (`http://localhost:5001/v1`) all default to plain http, and without `http:`
 * the packaged app refused every one of them at its default address.
 *
 * Asked to choose between naming the loopback origins (`http://localhost:*`,
 * `http://127.0.0.1:*`, `http://[::1]:*`) and admitting the scheme, the owner
 * chose the scheme, so a provider on another machine on the network is
 * reachable too. THE COST, STATED SO IT IS NOT LOST: `https:` and `wss:` already
 * let a compromised renderer reach any host on the internet (#168 calls that
 * wider than the rest of the policy), and `http:` adds any plain-http host as
 * well — every device on the user's LAN included, routers and printers and admin
 * pages alike. CSP cannot express "private addresses only", which is why the
 * choice was binary. It was the owner's decision, not something derived here.
 *
 * MEASURED, not inferred — `dev/probe-electron-csp-http/`, Electron 44.0.0 /
 * Chrome 152, pages on the real `chatterang-desktop://app` scheme under the
 * shipped permission handler, fetching a permissive-CORS server on this machine:
 *
 *                            before #284      this policy    no CSP
 *     127.0.0.1              refused by CSP   works          works
 *     localhost              refused by CSP   works          works
 *     LAN, 192.168/16        refused by CSP   works          works
 *     CGNAT, 100.64/10       refused by CSP   works          works
 *
 * So the refusal was the policy's alone, and the ruling reaches the network
 * hosts it was made for: the scheme is `secure: true`, yet Chromium's
 * mixed-content block did not fire from it. The same fetches from a genuinely
 * `https:` page WERE refused as mixed content for both non-loopback addresses —
 * the control showing the probe would have seen that block. One Chromium
 * version's behaviour, not a documented guarantee; rerun the probe on upgrade.
 *
 * WHAT STILL REFUSES, AND IS NOT OURS: every request carries
 * `Origin: chatterang-desktop://app`, and a stock Ollama 0.34.0 answers it with
 * 403 (it accepts loopback web origins and `app://`) until the user sets
 * `OLLAMA_ORIGINS`. That is the provider's CORS; nothing in this policy moves it.
 *
 * NOT `ws:`. A plaintext loopback socket is #168's question, with its own
 * options and its own argument for naming origins narrowly. This ruling does not
 * answer it, and `tests/desktop-security.test.ts` fails if `ws:` appears here.
 *
 * This moves what the page is PERMITTED to reach, not what the app sends: a
 * provider request still goes only to a connection the user added, at the
 * address that connection holds.
 */
export const CSP_PRODUCTION = [
  "default-src 'self'",
  "script-src 'self'",
  `style-src 'self' 'unsafe-inline' ${FONT_STYLE_ORIGIN}`,
  "img-src 'self' data: blob:",
  `font-src 'self' data: ${FONT_FILE_ORIGIN}`,
  "connect-src 'self' https: wss: http:",
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
 * WAS DEFECT [5]: this used to be `url.startsWith(APP_ORIGIN)`, which is a
 * string prefix test and therefore not an origin test at all.
 * `chatterang-desktop://appzz`, `chatterang-desktop://app-evil` and
 * `chatterang-desktop://app.evil.example` are all DIFFERENT origins that share
 * the prefix, and every one of them was trusted — while `protocol.handle`
 * ignored the URL host entirely and served each of them the same bundle off the
 * same disk. A page there reached every plugin channel. The dev-server arm had
 * the identical hole: `http://localhost:5273` prefixes `http://localhost:52739`.
 *
 * NOT `new URL(url).origin`, WHICH WOULD HAVE BROKEN THE APP. The defect report
 * proposed comparing `.origin`, and that is wrong here: WHATWG only defines a
 * tuple origin for *special* schemes, so in Node — which is what runs in
 * Electron's main process — `new URL('chatterang-desktop://app').origin` is the
 * string `'null'`. Comparing it to `APP_ORIGIN` is false for our own pages, so
 * the shipped app would have trusted nothing, shown no plugins, and refused to
 * navigate to itself. The comparison is built from `protocol` + `host` instead,
 * which is the tuple Chromium actually uses for a scheme registered
 * `standard: true`.
 *
 * @param url the URL to judge, as `webContents.getURL()` reports it.
 * @param devServerUrl `CHATTERANG_DEV_SERVER_URL`, or `''` in a real build.
 */
export function isTrustedOrigin(url: string, devServerUrl: string): boolean {
  const origin = originOf(url);
  if (origin === null) return false;
  if (origin === APP_ORIGIN) return true;
  if (devServerUrl === '') return false;
  const dev = originOf(devServerUrl);
  return dev !== null && origin === dev;
}

/**
 * The `scheme://host[:port]` tuple of `url`, or null if there isn't one.
 *
 * Null covers three separate refusals, and each is deliberate:
 *
 *   - the string does not parse as a URL at all (`''`, `'not a url'`);
 *   - it carries no host (`file:///x`, `about:blank`, `chatterang-desktop:/x`
 *     with one slash) — a hostless URL cannot equal a host-bearing origin, and
 *     saying so here beats letting `'file://' === 'chatterang-desktop://app'`
 *     answer it by accident;
 *   - it carries credentials (`chatterang-desktop://app@evil/`). Those parse to
 *     host `evil` so the comparison would already refuse them, but a URL whose
 *     userinfo is designed to be mistaken for the host is refused outright
 *     rather than by a coincidence of parsing.
 *
 * The host is lower-cased because Chromium lower-cases it for a standard
 * scheme and Node does not, so `chatterang-desktop://APP/` is the same origin
 * and must answer the same way.
 */
function originOf(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.host === '') return null;
  if (parsed.username !== '' || parsed.password !== '') return null;
  return `${parsed.protocol}//${parsed.host.toLowerCase()}`;
}

/* ── Leaving the app ──────────────────────────────────────────────────── */

/** The only two schemes a link may hand to the operating system. */
const EXTERNAL_SCHEMES: readonly string[] = ['http:', 'https:'];

/**
 * May this URL be handed to the OS via `shell.openExternal`?
 *
 * WAS DEFECT [14]: this returned `true` for everything, because `main.ts` had
 * no allowlist — `will-navigate` and `setWindowOpenHandler` passed a
 * page-controlled string straight to the OS handler. `file://`, `smb://` and
 * every macOS-registered application scheme (`ms-msdt:`, and whatever else the
 * user has installed) launched on the user's behalf. Model output renders as
 * Markdown, so the string is model-reachable: a model that emits
 * `[click](ms-excel:ofv|u|…)` was enough.
 *
 * Two schemes, matched on the PARSED protocol rather than on the text. A prefix
 * test would be the same mistake as the one above: `https:...` is a scheme and
 * `httpsfoo:` is a different one, and only the parser knows which is which.
 * Anything that does not parse is refused — an unparseable string is not a
 * safer input than a parseable one.
 *
 * This is a pure predicate on purpose. It is tested by calling it, never by
 * firing a real OS handler; `shell.openExternal` is not something a test suite
 * should be able to reach.
 */
/**
 * THE PERMISSIONS THE DESKTOP GRANTS, AND IT IS ONE.
 *
 * Electron approves every permission request automatically when no handler is
 * installed (its security tutorial, "Handle session permission requests from
 * remote content"), and until this existed the shell installed none. So every
 * camera, microphone, location and notification request from the renderer was
 * granted with no prompt from the app — macOS still showed its own one-time
 * system prompt; Windows and Linux showed nothing.
 *
 * DENY BY DEFAULT, because Electron forwards EVERY permission type Chromium
 * requests and that list grows with Chromium. An allowlist stays correct when a
 * new permission appears; a blocklist silently grants it.
 *
 * MEASURED, not inferred — a hidden Electron 44.0.0 / Chrome 152 window on the
 * real `chatterang-desktop://app` scheme, focused, with a simulated user
 * gesture, under this allowlist and under deny-all:
 *
 *     navigator.clipboard.writeText   allowlist: works    deny-all: NotAllowedError
 *     navigator.clipboard.readText    allowlist: denied   deny-all: denied
 *     getUserMedia / Notification /   denied under both, each reaching the
 *       geolocation                     request handler with the page's URL
 *     fetch to 127.0.0.1              never reaches the handler at all
 *
 * So `clipboard-sanitized-write` is load-bearing: deny-all breaks every copy
 * button in the app (`CopyButton` in src/ui/primitives.tsx, "Copy prompt" in
 * the studio). And denying Local Network Access cannot break a self-hosted
 * provider, because Electron never asks.
 *
 * NOT GRANTED, each deliberately: `media` (the desktop serves ONNX speech
 * through its native bridge and draws pairing codes rather than scanning them —
 * `cameraScan` is false there), `clipboard-read` (nothing in the app reads the
 * clipboard, and reading it is how a page learns what you copied elsewhere),
 * `notifications`, `geolocation`, `display-capture`, `fullscreen`,
 * `openExternal` (links leave through `isAllowedExternalUrl` in the main
 * process, which needs no renderer permission).
 */
export const DESKTOP_GRANTED_PERMISSIONS: ReadonlySet<string> = new Set(['clipboard-sanitized-write']);

export interface PermissionQuery {
  readonly permission: string;
  /** The URL of the frame asking, or `''` when Electron could not say. */
  readonly requestingUrl: string;
  readonly isMainFrame: boolean;
}

/**
 * Should the desktop grant this permission request or check?
 *
 * Three conditions, all required: the permission is on the allowlist, it comes
 * from the MAIN frame, and that frame is the app's own origin. A subframe never
 * qualifies — the only frames the app creates are `sandbox=""` model-HTML
 * previews, and nothing inside one should ever hold a permission.
 */
export function isPermissionGranted(query: PermissionQuery, devServerUrl: string): boolean {
  if (!DESKTOP_GRANTED_PERMISSIONS.has(query.permission)) return false;
  if (!query.isMainFrame) return false;
  return isTrustedOrigin(query.requestingUrl, devServerUrl);
}

/**
 * The URL a permission request or check is about, from Electron's details —
 * which are only partly filled in, and MEASURABLY so.
 *
 * Checks for `media`, `geolocation` and `web-app-installation` arrived with no
 * `requestingUrl` and an EMPTY `requestingOrigin`, before the page's URL was
 * committed. Reading only `requestingUrl` would treat those as having no origin
 * — correct for them, and wrong for anything the app legitimately needs that is
 * checked the same way. So: the requesting URL, then the requesting origin,
 * then — for the MAIN frame only — the URL the window itself has loaded. A
 * subframe with nothing to go on gets `''`, which no origin test accepts.
 */
export function permissionRequestUrl(
  details: { readonly requestingUrl?: string; readonly isMainFrame?: boolean },
  requestingOrigin: string,
  webContentsUrl: string,
): string {
  if (details.requestingUrl) return details.requestingUrl;
  if (requestingOrigin) return requestingOrigin;
  return details.isMainFrame === true ? webContentsUrl : '';
}

export function isAllowedExternalUrl(url: string): boolean {
  try {
    return EXTERNAL_SCHEMES.includes(new URL(url).protocol);
  } catch {
    return false;
  }
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

/**
 * Resolve a whole request URL, host included — what `protocol.handle` needs.
 *
 * The other half of DEFECT [5]. `protocol.handle` is registered for the SCHEME,
 * not for one host on it, so it was handed `chatterang-desktop://app-evil/…`
 * and answered by looking at the pathname alone. The sibling host was served
 * the same bundle off the same disk, which is what turned a loose prefix test
 * into a second, fully working copy of the app at an origin the trust check
 * would then have to keep refusing forever.
 *
 * Refusing here means there is nothing at that origin to load in the first
 * place, so the two halves close from opposite directions: `isTrustedOrigin`
 * stops a page there reaching a plugin, and this stops a page existing there.
 *
 * @returns null for a foreign origin or an escaping path; the caller answers 404.
 */
export function resolveBundleUrl(root: string, url: string): BundleTarget | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  // `''` for the dev server: the dev server is loaded over http and never
  // reaches this handler, so the only origin this may serve is our own.
  if (!isTrustedOrigin(url, '')) return null;
  return resolveBundleRequest(root, parsed.pathname);
}

/* ── Model files ──────────────────────────────────────────────────────── */

/**
 * Confine a model path to the app's model directory, or refuse it.
 *
 * WAS DEFECT [8], THE FIRST HALF. `LlamaCpp.load` took an arbitrary absolute
 * path and handed it to the engine, which made the plugin a filesystem oracle
 * for the page: calling
 * `invoke('LlamaCpp','load',[{modelPath:'/etc/hosts'}])` from the live page
 * rejected with `Invalid GGUF magic. Expected "GGUF" but got "##\n#"` — the
 * literal first four bytes of a file the renderer cannot otherwise read. The
 * same applies to `mmprojPath` and `draftModelPath`, which are the same
 * parameter under two other names and were both open.
 *
 * The second half is in `bridge/host-runtime.ts`: even for a path inside the
 * directory, the engine's own failure message is not forwarded. Either half
 * alone leaves the other leak — confine the path and the message still quotes
 * bytes of any file the user put in the model directory; hide the message and
 * the *timing* and *shape* of the failure still distinguish a readable file
 * from an absent one anywhere on the disk.
 *
 * A RELATIVE path is resolved against the root, so `gemma/model.gguf` works and
 * `../../../etc/hosts` does not. An ABSOLUTE path is kept absolute — that is
 * what `resolve` does with one — and then has to be inside the root like any
 * other, which is what makes `/etc/hosts` a refusal rather than a read.
 *
 * WHAT THIS DOES NOT DO: it does not resolve symlinks. A symlink placed INSIDE
 * the model directory and pointing outside it would still be followed by the
 * engine. Closing that needs `realpath`, which is async and file-existence
 * dependent, and belongs in the host rather than in a pure function; it is
 * stated here rather than left to be assumed, and it requires an attacker who
 * can already write into app-private storage.
 *
 * @param modelRoot the app's model directory, absolute.
 * @param candidate the path the renderer asked for.
 * @returns the resolved absolute path, or null if it is not inside the root.
 */
export function confineModelPath(modelRoot: string, candidate: string): string | null {
  // A NUL byte cannot escape the root — truncation only shortens, and a prefix
  // of something under the root is still under it. What it CAN do is make the
  // path we validate and return differ from the path the native addon opens,
  // because the C representation stops at the NUL. A guard whose answer
  // describes a different file than the one that gets opened is not a guard.
  if (candidate === '' || candidate.includes('\0')) return null;
  const root = resolve(modelRoot);
  const resolved = resolve(root, candidate);
  // Strictly inside: the root itself is a directory, never a model.
  return resolved.startsWith(root.endsWith(sep) ? root : `${root}${sep}`) ? resolved : null;
}
