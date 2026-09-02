/**
 * The served deployment's security posture, as pure functions.
 *
 * Same split as `apps/desktop/src/security.ts`, and for the same reason: every
 * decision here is testable without binding a socket, so the file that DOES
 * bind one holds no decisions.
 *
 * ── THE POLICY GETS STRONGER, NOT WEAKER ────────────────────────────────
 *
 * The web `index.html` carries one meta directive — `img-src 'self' data:
 * blob:` — added when a model could exfiltrate with a single markdown image.
 * It is deliberately narrow because a document meta CSP cannot be widened per
 * deployment and "a CSP widened for each new provider is one that gets widened
 * carelessly".
 *
 * A served deployment is a real http origin, so it can do what the desktop
 * shell does: send the fuller policy as a RESPONSE HEADER, with the meta tag
 * left in place as the belt it already is. Two policies both apply; the
 * intersection is what the browser enforces, and the intersection is stricter
 * than either.
 *
 * ── AND IT DROPS THE TWO FONT ORIGINS, WHICH THE DESKTOP KEEPS ──────────
 *
 * `CSP_PRODUCTION` names `fonts.googleapis.com` and `fonts.gstatic.com`
 * because `index.html` links them and a policy that refuses the app's own
 * markup is `security.ts`'s DEFECT [9] all over again. That argument is a
 * desktop argument: the desktop shell mirrors a web build that already makes
 * that request unconditionally, so allowing it left the shell no worse than
 * the platform it mirrors.
 *
 * It does not carry over. A self-hosted, privacy-first deployment that phones
 * Google on every cold start is not "no worse than the web build" — it is the
 * one deployment whose whole premise is that the operator's machine serves
 * everything. So server mode removes BOTH halves rather than one:
 *
 *   1. {@link stripExternalStylesheets} removes the font `<link>` and its two
 *      `<link rel="preconnect">` from the HTML as it is served, so the page
 *      does not ask;
 *   2. {@link SERVED_CSP} names no external origin at all, so if step 1 ever
 *      misses a tag the browser refuses the request anyway.
 *
 * Neither half is trusted alone. `tests/server-policy.test.ts` asserts that the
 * served HTML contains no external URL AND that the policy contains no external
 * origin — so a new third-party link in `index.html` fails the suite instead of
 * quietly becoming a request from every server this repo ever runs.
 *
 * The cost is stated rather than hidden: Archivo's width axis has no system
 * equivalent, so a served deployment renders in the fallback stack that
 * `src/styles/tokens.css` already leads with. Self-hosting the two families
 * (the three steps are written out in `apps/desktop/src/security.ts`) removes
 * the cost and changes nothing here.
 */

import { CSP_PRODUCTION } from '@chatterang/desktop/security';

import { BOOTSTRAP_PATH } from './wire.js';

/**
 * The Content-Security-Policy served with every document.
 *
 * Derived from the desktop policy by REMOVAL, and `tests/server-policy.test.ts`
 * checks that claim directive by directive: the only permitted difference is
 * the two font origins. A directive that appears here and not there — or the
 * reverse — fails, because two policies that drift apart silently is how one of
 * them ends up being the weak one nobody reads.
 *
 * `connect-src 'self' https: wss:` is kept, and it is worth saying why it is
 * not a hole: the served page is a full client, and a user who configures a
 * remote provider IN THEIR OWN BROWSER is making that request from their own
 * machine with their own key. The server never sees either. Narrowing this to
 * `'self'` would not make the deployment more private; it would break the
 * provider surface while leaving the server exactly as it is.
 */
export const SERVED_CSP = [
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

/** The desktop policy, re-exported so a test can diff the two in one place. */
export { CSP_PRODUCTION };

/**
 * Security headers that are not the CSP.
 *
 * `X-Content-Type-Options` because a bundle contains `.map` and `.json` files
 * that a sniffing browser could decide are something else; `Referrer-Policy`
 * because the one-time `?token=` URL must not reach any third party even in
 * the window before it is stripped; `X-Frame-Options` because `frame-src`
 * governs what we embed and this governs who embeds us.
 */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'cross-origin-opener-policy': 'same-origin',
});

/**
 * Remove every stylesheet and preconnect that points off this machine.
 *
 * Deliberately a narrow, boring transform: it deletes whole `<link>` elements
 * whose `href` is absolute and not same-origin. It does not attempt to rewrite
 * anything, because a rewrite that half-works produces a page that renders and
 * is wrong, and this repo has shipped enough of those.
 */
export function stripExternalStylesheets(html: string): string {
  return html.replace(/<link\b[^>]*>/gi, (tag) => {
    const href = /href\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1] ?? '';
    return /^https?:\/\//i.test(href) ? '' : tag;
  });
}

/**
 * Put the bootstrap script in front of the app's own module script.
 *
 * ORDER IS THE WHOLE THING. `@capacitor/core` reads `window.Capacitor` and
 * `window.CapacitorCustomPlatform` ONCE, at module load, and
 * `registerPlugin('LlamaCpp', …)` in `src/plugins/llama-cpp/index.ts` runs
 * during the bundle's own evaluation. Seed the globals after that and they are
 * ignored: `getPlatform()` answers `'web'`, no plugin header exists, and every
 * call resolves to `src/plugins/llama-cpp/web.ts` — the development shim that
 * SYNTHESISES text and reports `simulated: true`. Measured against the real
 * `@capacitor/core`: with the platform named `'server'` and no header seeded,
 * a `registerPlugin` call resolves to the web implementation on every platform
 * id tried.
 *
 * That failure looks like a working server. It streams plausible prose while
 * the machine's real llama.cpp host sits idle, which is why the ordering is
 * asserted in `tests/server-policy.test.ts` by INDEX rather than by presence.
 *
 * A SEPARATE FILE, NOT AN INLINE BLOCK, because `script-src 'self'` admits no
 * inline script and the whole policy would have to be weakened with a nonce or
 * a hash to allow one. The built `index.html` contains exactly one script tag
 * and zero inline scripts today, and this keeps it at one plus one.
 */
export function injectBootstrap(html: string, bootstrapPath = BOOTSTRAP_PATH): string {
  const tag = `<script src="${bootstrapPath}"></script>`;
  const moduleScript = /<script\b[^>]*type=["']module["'][^>]*>/i.exec(html);
  if (moduleScript?.index !== undefined) {
    return `${html.slice(0, moduleScript.index)}${tag}\n    ${html.slice(moduleScript.index)}`;
  }
  // No module script to precede: the bundle has changed shape, and guessing a
  // position would put the seeding after the thing it must precede. Refusing
  // is the same posture as the host refusing to guess a model root.
  throw new Error(
    'chatterang server: the served index.html has no <script type="module">, so there is no ' +
      'point before the app bundle at which the platform can be named. Refusing to serve a ' +
      'page that would silently fall through to the development plugin shims.',
  );
}

/** Everything a served HTML document needs doing to it, in order. */
export function prepareDocument(html: string): string {
  return injectBootstrap(stripExternalStylesheets(html));
}

/* ── Who is allowed to talk to the API ────────────────────────────────── */

/**
 * Is this request's `Origin` our own?
 *
 * A missing `Origin` is ACCEPTED, and that is not a hole: browsers omit it on
 * same-origin GETs, and every state-changing route additionally requires a
 * session id that only the event stream hands out and only same-origin script
 * can read. A present-but-foreign `Origin` is refused outright — that is the
 * cross-site request, arriving labelled.
 *
 * `null` is refused explicitly. It is what a sandboxed iframe, a `data:` URL
 * and some redirect chains send, and none of those is a page of ours.
 */
export function originAllowed(origin: string | undefined, expected: readonly string[]): boolean {
  if (origin === undefined || origin === '') return true;
  return expected.includes(origin);
}

/** Read one cookie out of a `Cookie` header, without a parser dependency. */
export function readCookie(header: string | undefined, name: string): string | undefined {
  if (header === undefined) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return undefined;
}

/**
 * The `Set-Cookie` value for the token cookie.
 *
 * `HttpOnly` so no script can read it back out — including a compromised
 * dependency in the app's own bundle. `Secure` unconditionally, because the
 * cookie only ever exists in the authenticated arm and that arm is always TLS.
 * `SameSite=Strict` so it is not attached to a cross-site navigation, which is
 * the second layer under the custom-header requirement on the API routes.
 * `Path=/` because the assets and the API both need it.
 */
export function tokenCookie(name: string, value: string): string {
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Strict`;
}
