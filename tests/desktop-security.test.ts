import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  APP_ORIGIN,
  APP_SCHEME,
  CSP_PRODUCTION,
  confineModelPath,
  MIME,
  isAllowedExternalUrl,
  isTrustedOrigin,
  resolveBundleRequest,
  resolveBundleUrl,
  resolveWithinRoot,
} from '@chatterang/desktop/security';
import { confineRealPath } from '@chatterang/desktop/host/real-path';
import { modelPathGuard } from '@chatterang/desktop/host/model-paths';
import { onnxPathGuard } from '@chatterang/desktop/host/onnx-paths';
import { RENDERER_TEARDOWN_EVENTS } from '@chatterang/desktop/bridge';

/**
 * THE DESKTOP SHELL'S SECURITY POSTURE, ACTUALLY EXERCISED.
 *
 * Until this file existed, every one of these decisions lived in `main.ts`,
 * which the suite structurally cannot import: `protocol.registerSchemesAsPrivileged`
 * and `app.whenReady()` run at module scope, so reaching them means launching
 * Electron. The predicates were therefore mutation-free — you could delete the
 * `..` guard from the path resolver, or invert the trusted-origin test, and the
 * whole suite stayed green. That is the defect this file closes, and the
 * closure is only real if the assertions below actually fail when the code is
 * wrong, which is why each was written by breaking `security.ts` first and
 * watching vitest exit non-zero.
 *
 * SOME OF THESE TESTS USED TO ASSERT THE WRONG ANSWER ON PURPOSE, and have
 * since flipped. `isTrustedOrigin` admitted any sibling origin and
 * `isAllowedExternalUrl` admitted `file://`; those were defects [5] and [14],
 * pinned as they were so the fix would announce itself as a visible change to a
 * test file rather than arrive as a silent edit nothing was watching. They are
 * now marked FIXED and say what they used to assert. That is the mechanism
 * working, and it is worth keeping for the next one.
 */

/* ── The file stays reachable ─────────────────────────────────────────── */

describe('the security predicates stay platform-free', () => {
  const FILE = resolve(process.cwd(), 'apps/desktop/src/security.ts');
  const source = readFileSync(FILE, 'utf8');

  it('reads the real file', () => {
    // A guard that silently checks an empty string is worse than no guard.
    expect(source.length).toBeGreaterThan(1000);
    expect(source).toContain('export function isTrustedOrigin');
  });

  it('imports no Electron, by any of the four doors', () => {
    // The whole point of the extraction. One `import { app } from 'electron'`
    // here and this file joins main.ts on the far side of the wall — not with
    // a typecheck failure, but by taking the entire suite down at import time.
    //
    // Four specifier forms, checked as four: bare, subpath, a relative path
    // into node_modules, and `require(...)`. The matcher recognising only the
    // form it was written against is how the other layering guards in this
    // repo went blind, twice.
    const specifiers = [
      ...source.matchAll(/(?:from|import|require)\s*\(?\s*['"]([^'"]+)['"]/g),
    ].map((match) => match[1] ?? '');
    expect(specifiers.length).toBeGreaterThan(0);
    expect(specifiers.filter((s) => /(^|\/)electron($|\/)/.test(s))).toEqual([]);
  });
});

/* ── Origin trust ─────────────────────────────────────────────────────── */

describe('isTrustedOrigin', () => {
  it('accepts the app origin and pages under it', () => {
    expect(isTrustedOrigin(APP_ORIGIN, '')).toBe(true);
    expect(isTrustedOrigin(`${APP_ORIGIN}/index.html`, '')).toBe(true);
    expect(isTrustedOrigin(`${APP_ORIGIN}/settings?tab=models#x`, '')).toBe(true);
  });

  it('refuses an unrelated origin', () => {
    expect(isTrustedOrigin('https://example.com/', '')).toBe(false);
    expect(isTrustedOrigin('file:///etc/passwd', '')).toBe(false);
    expect(isTrustedOrigin('about:blank', '')).toBe(false);
    expect(isTrustedOrigin('', '')).toBe(false);
  });

  it('refuses another host on our own scheme', () => {
    expect(isTrustedOrigin(`${APP_SCHEME}://evil/index.html`, '')).toBe(false);
  });

  it('[5] FIXED: refuses a sibling origin that merely shares the prefix', () => {
    // THIS TEST FLIPPED. It used to assert `true` for all three, because
    // `url.startsWith(APP_ORIGIN)` is not an origin comparison: these are
    // DIFFERENT origins that happen to begin with the same characters, and
    // every one of them was trusted — while `protocol.handle` ignored the URL
    // host and served each the same bundle off the same disk, so a page there
    // was a working copy of the app that could reach every plugin channel.
    expect(isTrustedOrigin('chatterang-desktop://appzz/index.html', '')).toBe(false);
    expect(isTrustedOrigin('chatterang-desktop://app-evil/index.html', '')).toBe(false);
    expect(isTrustedOrigin('chatterang-desktop://app.evil.example/', '')).toBe(false);
    // The reviewer's two exact strings, spelled out as the bar asked.
    expect(isTrustedOrigin('chatterang-desktop://appzz', '')).toBe(false);
    expect(isTrustedOrigin('chatterang-desktop://app-evil', '')).toBe(false);
    // ...and the legitimate origin still works, which is the half a fix like
    // this loses if `new URL(url).origin` is used naively: WHATWG gives a
    // non-special scheme the origin string 'null', so comparing `.origin` to
    // APP_ORIGIN would refuse OUR OWN pages too and the app would show no
    // plugins and refuse to navigate to itself.
    expect(isTrustedOrigin(APP_ORIGIN, '')).toBe(true);
    expect(isTrustedOrigin(`${APP_ORIGIN}/index.html`, '')).toBe(true);
  });

  it('[5] treats the host case-insensitively, as Chromium does', () => {
    // Chromium lower-cases the host of a `standard: true` scheme; Node's URL
    // does not. Same origin, so it must answer the same way — otherwise the
    // fix above would refuse a page the browser considers ours.
    expect(isTrustedOrigin('chatterang-desktop://APP/index.html', '')).toBe(true);
  });

  it('[5] refuses a URL whose userinfo is dressed up as our host', () => {
    // Parses to host `evil` with username `app`, so the origin comparison
    // already refuses it. Refused explicitly as well: a URL carrying
    // credentials has no business being a page of ours under any parse.
    expect(isTrustedOrigin('chatterang-desktop://app@evil/index.html', '')).toBe(false);
    expect(isTrustedOrigin('chatterang-desktop://app:x@evil/', '')).toBe(false);

    // And the case the origin comparison does NOT catch on its own, which is
    // why the explicit refusal is there and not merely belt-and-braces: the
    // host really is `app`, so the tuple matches, and only the userinfo check
    // rejects it. Without this assertion that line is a mutant that survives —
    // it was, until this expectation was added.
    expect(isTrustedOrigin('chatterang-desktop://evil@app/index.html', '')).toBe(false);
    expect(isTrustedOrigin('http://user:pw@localhost:5273/', 'http://localhost:5273')).toBe(false);
  });

  it('refuses a hostless URL on our own scheme', () => {
    // One slash, so there is no authority at all: host is ''. It must not
    // compare equal to anything.
    expect(isTrustedOrigin('chatterang-desktop:/app/index.html', '')).toBe(false);
    expect(isTrustedOrigin('chatterang-desktop:app', '')).toBe(false);

    // The case that makes the hostless refusal load-bearing rather than tidy,
    // and the one that kept a mutant alive until it was written: TWO hostless
    // URLs would otherwise compare EQUAL. Point the dev-server variable at a
    // `file://` URL — a plausible thing to try — and every file on the disk
    // becomes a trusted origin, because both sides reduce to `file://`.
    expect(isTrustedOrigin('file:///etc/passwd', 'file:///Users/me/app/index.html')).toBe(false);
    expect(isTrustedOrigin('about:blank', 'about:blank')).toBe(false);
  });

  it('ignores the dev server when none is configured', () => {
    // A packaged build has `DEV_SERVER_URL === ''`. If the empty string were
    // ever fed to `startsWith`, EVERY url would be trusted.
    expect(isTrustedOrigin('http://localhost:5273/', '')).toBe(false);
    expect(isTrustedOrigin('https://anything.example/', '')).toBe(false);
  });

  it('accepts the configured dev server', () => {
    expect(isTrustedOrigin('http://localhost:5273/', 'http://localhost:5273')).toBe(true);
    expect(isTrustedOrigin('http://localhost:5273/index.html', 'http://localhost:5273')).toBe(true);
  });

  it('[5] FIXED: a dev-server port no longer prefixes a longer port', () => {
    // THIS TEST FLIPPED. `http://localhost:5273` prefixes
    // `http://localhost:52739`, so a page on that other port was trusted. It
    // only bit when a dev URL was set, and `scripts/sync.mjs` refuses to
    // package a build carrying one — but it was the same missing origin
    // comparison, so it was fixed in the same edit.
    expect(isTrustedOrigin('http://localhost:52739/', 'http://localhost:5273')).toBe(false);
    // A dev server URL that does not parse trusts nothing rather than
    // everything.
    expect(isTrustedOrigin('http://localhost:5273/', 'not a url')).toBe(false);
  });
});

/* ── Leaving the app ──────────────────────────────────────────────────── */

describe('isAllowedExternalUrl', () => {
  it('allows the http schemes a link is supposed to use', () => {
    expect(isAllowedExternalUrl('https://example.com/docs')).toBe(true);
    expect(isAllowedExternalUrl('http://example.com/docs')).toBe(true);
  });

  it('[14] FIXED: refuses every other scheme', () => {
    // THIS TEST FLIPPED — every expectation below used to be `true`. `main.ts`
    // handed `will-navigate` and `setWindowOpenHandler` URLs straight to
    // `shell.openExternal` with no allowlist at all, and model output renders
    // as Markdown, so the string is model-reachable and the OS launched
    // whatever was registered for the scheme.
    expect(isAllowedExternalUrl('file:///Users/someone/.ssh/id_ed25519')).toBe(false);
    expect(isAllowedExternalUrl('smb://attacker.example/share')).toBe(false);
    expect(isAllowedExternalUrl('ms-msdt:/id')).toBe(false);
    expect(isAllowedExternalUrl('javascript:alert(1)')).toBe(false);
    expect(isAllowedExternalUrl('not a url at all')).toBe(false);
    expect(isAllowedExternalUrl('')).toBe(false);
    // Two more registered-handler schemes that exist on a stock macOS install.
    expect(isAllowedExternalUrl('ftp://attacker.example/x')).toBe(false);
    expect(isAllowedExternalUrl('mailto:someone@example.com')).toBe(false);
  });

  it('[14] matches the parsed protocol, not a prefix of the text', () => {
    // The mirror of the [5] mistake. A scheme that merely BEGINS with `http`
    // is a different scheme, and a URL whose path begins with `https://` is
    // not an https URL at all.
    expect(isAllowedExternalUrl('httpsfoo://example.com/')).toBe(false);
    expect(isAllowedExternalUrl('javascript:void("https://example.com")')).toBe(false);
    expect(isAllowedExternalUrl('x-custom:https://example.com')).toBe(false);
    // ...and the two real ones still pass, in mixed case, which is what the
    // parser normalises and a text comparison would not.
    expect(isAllowedExternalUrl('HTTPS://Example.com/Docs')).toBe(true);
  });

  it('[14] is a pure predicate — no OS handler is reachable from a test', () => {
    // Stated as an assertion rather than a comment: this module exports a
    // function that answers a question about a string. `shell.openExternal`
    // lives in main.ts and is never called from here, so there is no arrangement
    // of these tests that can launch anything on the machine running them.
    expect(typeof isAllowedExternalUrl).toBe('function');
    expect(isAllowedExternalUrl.length).toBe(1);
  });
});

/* ── Serving the bundle ───────────────────────────────────────────────── */

describe('resolveWithinRoot', () => {
  const ROOT = '/opt/chatterang/app';

  it('resolves a path inside the root', () => {
    expect(resolveWithinRoot(ROOT, '/index.html')).toBe(`${ROOT}/index.html`);
    expect(resolveWithinRoot(ROOT, '/assets/main-a1b2.js')).toBe(`${ROOT}/assets/main-a1b2.js`);
  });

  it('strips leading slashes rather than treating the path as absolute', () => {
    // `join(root, '/etc/passwd')` is `root/etc/passwd`, but `//etc/passwd` and
    // deeper runs of slashes must not change that.
    expect(resolveWithinRoot(ROOT, '////index.html')).toBe(`${ROOT}/index.html`);
  });

  it('refuses to escape the root', () => {
    expect(resolveWithinRoot(ROOT, '/../../../etc/passwd')).toBeNull();
    expect(resolveWithinRoot(ROOT, '/assets/../../../../etc/hosts')).toBeNull();
  });

  it('refuses a percent-encoded escape', () => {
    // The check is on the RESOLVED path, after decoding, which is the only
    // version of this check that works: rejecting the literal text `..` would
    // miss this entirely.
    expect(resolveWithinRoot(ROOT, '/%2e%2e/%2e%2e/etc/passwd')).toBeNull();
    expect(resolveWithinRoot(ROOT, '/assets/%2E%2E%2F%2E%2E%2Fetc/passwd')).toBeNull();
  });

  it('does not reject a harmless name that merely CONTAINS two dots', () => {
    // The mirror of the test above, and it was added because a mutant survived
    // without it: replacing the resolved-path comparison with
    // `decoded.includes('..')` kept every escape test green. That naive check
    // is wrong in the other direction — it 404s a real asset — and nothing
    // noticed. A bundler emitting `vendor..chunk.js` is all it takes.
    expect(resolveWithinRoot(ROOT, '/assets/vendor..chunk.js')).toBe(
      `${ROOT}/assets/vendor..chunk.js`,
    );
    expect(resolveWithinRoot(ROOT, '/assets/..hidden/x.js')).toBe(`${ROOT}/assets/..hidden/x.js`);
  });

  it('refuses a SIBLING directory that shares the root as a prefix', () => {
    // `/opt/chatterang/app-secrets` starts with `/opt/chatterang/app`. The
    // trailing-separator step in the comparison is what rejects it; drop that
    // one line and this is the only test in the suite that notices.
    expect(resolveWithinRoot(ROOT, '/../app-secrets/keys.json')).toBeNull();
    expect(resolveWithinRoot('/opt/chatterang/app/', '/../app-secrets/keys.json')).toBeNull();
  });

  it('allows the root itself', () => {
    expect(resolveWithinRoot(ROOT, '/')).toBe(ROOT);
    expect(resolveWithinRoot(ROOT, '')).toBe(ROOT);
  });

  it('CURRENT BEHAVIOUR: throws on a malformed escape rather than 404ing', () => {
    // `decodeURIComponent('%zz')` throws a URIError. In `main.ts` that escaped
    // `serveBundle`'s try block (which wraps only the read) and surfaced as a
    // rejected `protocol.handle` promise. Recorded, not silently changed —
    // whoever decides a 404 is better now has a test to flip.
    expect(() => resolveWithinRoot(ROOT, '/%zz')).toThrow(URIError);
  });
});

describe('resolveBundleRequest', () => {
  const ROOT = '/opt/chatterang/app';

  it('serves index.html for the root path, with the CSP', () => {
    expect(resolveBundleRequest(ROOT, '/')).toEqual({
      file: `${ROOT}/index.html`,
      contentType: MIME['.html'],
      csp: CSP_PRODUCTION,
    });
  });

  it('serves a real asset with its own type and NO csp header', () => {
    // The CSP belongs on documents. Putting it on every response is not a
    // safety improvement, it is a header on a PNG.
    expect(resolveBundleRequest(ROOT, '/assets/main-a1b2.js')).toEqual({
      file: `${ROOT}/assets/main-a1b2.js`,
      contentType: MIME['.js'],
    });
    expect(resolveBundleRequest(ROOT, '/icons/logo.png')?.csp).toBeUndefined();
    expect(resolveBundleRequest(ROOT, '/fonts/x.woff2')?.contentType).toBe('font/woff2');
  });

  it('falls back to index.html for an extensionless client route', () => {
    // The SPA fallback. Get this backwards and every deep link is a blank
    // page — the exact failure mode this app keeps shipping.
    const target = resolveBundleRequest(ROOT, '/settings');
    expect(target).toEqual({
      file: `${ROOT}/index.html`,
      contentType: MIME['.html'],
      csp: CSP_PRODUCTION,
    });
  });

  it('does NOT fall back for a missing asset — that stays a real request', () => {
    // An extension means "this is a file"; the caller 404s when the read fails
    // rather than handing the page HTML with a `.js` content type.
    expect(resolveBundleRequest(ROOT, '/assets/gone.js')?.file).toBe(`${ROOT}/assets/gone.js`);
  });

  it('matches extensions case-insensitively', () => {
    expect(resolveBundleRequest(ROOT, '/icons/LOGO.PNG')?.contentType).toBe('image/png');
  });

  it('serves an unknown extension as an opaque download', () => {
    const target = resolveBundleRequest(ROOT, '/models/tokenizer.bin');
    expect(target?.contentType).toBe('application/octet-stream');
    expect(target?.csp).toBeUndefined();
  });

  it('returns null for anything that escapes the root', () => {
    expect(resolveBundleRequest(ROOT, '/../../../etc/passwd')).toBeNull();
    expect(resolveBundleRequest(ROOT, '/%2e%2e/%2e%2e/etc/passwd')).toBeNull();
  });
});

describe('resolveBundleUrl', () => {
  const ROOT = '/opt/chatterang/app';

  it('serves our own origin exactly as the pathname resolver would', () => {
    expect(resolveBundleUrl(ROOT, `${APP_ORIGIN}/index.html`)).toEqual(
      resolveBundleRequest(ROOT, '/index.html'),
    );
    expect(resolveBundleUrl(ROOT, `${APP_ORIGIN}/assets/main-a1b2.js`)).toEqual(
      resolveBundleRequest(ROOT, '/assets/main-a1b2.js'),
    );
    // The SPA fallback survives the extra layer, query string and all.
    expect(resolveBundleUrl(ROOT, `${APP_ORIGIN}/settings?tab=models#x`)?.file).toBe(
      `${ROOT}/index.html`,
    );
  });

  it('[5] FIXED: serves NOTHING to a sibling host on our own scheme', () => {
    // The second half of [5], and the one that made the first half so bad:
    // `protocol.handle` is registered for the SCHEME, so Chromium hands it
    // requests for every host on it, and the old code read the pathname and
    // answered. `chatterang-desktop://app-evil/` was a complete, working,
    // second copy of the application served off the same disk.
    expect(resolveBundleUrl(ROOT, 'chatterang-desktop://appzz/index.html')).toBeNull();
    expect(resolveBundleUrl(ROOT, 'chatterang-desktop://app-evil/index.html')).toBeNull();
    expect(resolveBundleUrl(ROOT, 'chatterang-desktop://app.evil.example/')).toBeNull();
    expect(resolveBundleUrl(ROOT, 'chatterang-desktop://evil/assets/main.js')).toBeNull();
  });

  it('refuses a foreign scheme and an unparseable request', () => {
    expect(resolveBundleUrl(ROOT, 'https://app/index.html')).toBeNull();
    expect(resolveBundleUrl(ROOT, 'file:///opt/chatterang/app/index.html')).toBeNull();
    expect(resolveBundleUrl(ROOT, 'not a url')).toBeNull();
  });

  it('still refuses a traversal the URL parser does not eat first', () => {
    // The origin check is in ADDITION to the path check, not instead of it —
    // but which traversals reach the path check is worth pinning, because it
    // is not what you would guess. The URL parser normalises `..` segments out
    // of a pathname, INCLUDING `%2e%2e` ones, so those never arrive here at
    // all: `chatterang-desktop://app/../../../etc/passwd` has pathname
    // `/etc/passwd` by the time anyone looks at it, and resolves harmlessly
    // inside the root.
    expect(new URL(`${APP_ORIGIN}/../../../etc/passwd`).pathname).toBe('/etc/passwd');
    expect(resolveBundleUrl(ROOT, `${APP_ORIGIN}/../../../etc/passwd`)?.file).toBe(
      `${ROOT}/index.html`,
    );

    // An ENCODED SLASH is the form the parser leaves intact, and it is the one
    // the path guard exists for: `%2e%2e%2f` is not a path segment to the
    // parser, so it survives into `resolveWithinRoot`, which decodes and
    // resolves before comparing and therefore catches it.
    expect(new URL(`${APP_ORIGIN}/%2e%2e%2f%2e%2e%2fetc/passwd`).pathname).toBe(
      '/%2e%2e%2f%2e%2e%2fetc/passwd',
    );
    expect(resolveBundleUrl(ROOT, `${APP_ORIGIN}/%2e%2e%2f%2e%2e%2fetc/passwd`)).toBeNull();
    expect(resolveBundleUrl(ROOT, `${APP_ORIGIN}/assets/%2e%2e%2f%2e%2e%2fapp-secrets/k.json`)).toBeNull();
  });

  it('does not consult the dev server', () => {
    // `protocol.handle` only ever serves the custom scheme; a dev build loads
    // over http and never reaches it. So this resolver has exactly one
    // acceptable origin and takes no parameter that could widen it.
    expect(resolveBundleUrl.length).toBe(2);
    expect(resolveBundleUrl(ROOT, 'http://localhost:5273/index.html')).toBeNull();
  });
});

/* ── The policy itself ────────────────────────────────────────────────── */

describe('CSP_PRODUCTION', () => {
  const directives = new Map(
    CSP_PRODUCTION.split('; ').map((part) => {
      const [name, ...values] = part.split(' ');
      return [name ?? '', values];
    }),
  );

  it('locks scripts to self with no inline escape hatch', () => {
    // `'unsafe-inline'` in script-src would make the rest of this policy
    // decorative.
    expect(directives.get('script-src')).toEqual(["'self'"]);
    expect(CSP_PRODUCTION).not.toContain("script-src 'self' 'unsafe-inline'");
    expect(CSP_PRODUCTION).not.toContain("'unsafe-eval'");
  });

  it('denies plugins, frames and form posts outright', () => {
    expect(directives.get('object-src')).toEqual(["'none'"]);
    expect(directives.get('frame-src')).toEqual(["'none'"]);
    expect(directives.get('base-uri')).toEqual(["'self'"]);
    expect(directives.get('form-action')).toEqual(["'self'"]);
  });

  it('has a default-src fallback so an unlisted directive is not open', () => {
    expect(directives.get('default-src')).toEqual(["'self'"]);
  });

  /**
   * [9], AND THE ONLY VERSION OF THIS TEST THAT STAYS TRUE.
   *
   * The defect was a DISAGREEMENT: the policy allowed no external origin while
   * `index.html` linked two, so the packaged app refused its own typography and
   * nothing noticed. A test that hard-codes either side pins today's answer and
   * lets the two drift apart again the moment one of them moves.
   *
   * So the expected origins are DERIVED FROM THE MARKUP. Whichever way the next
   * person resolves this — self-hosting the families and deleting the link, or
   * adding a third-party asset — the policy has to move with the markup or this
   * fails. It is a bidirectional check: no origin the page needs may be missing,
   * and no origin the page has stopped needing may remain.
   */
  const html = readFileSync(resolve(process.cwd(), 'index.html'), 'utf8');
  const htmlOrigins = new Set(
    [...html.matchAll(/https?:\/\/[^"'\s/]+/g)].map((match) => match[0]),
  );

  it('[9] allows every external origin index.html actually reaches for', () => {
    // Missing one is the defect as it shipped: the app's own fonts, refused by
    // the app's own policy, silently, in a window nobody has a console open on.
    for (const origin of htmlOrigins) {
      expect(CSP_PRODUCTION, `index.html loads ${origin} and the CSP must allow it`).toContain(
        origin,
      );
    }
  });

  it('[9] allows NOTHING external that index.html has stopped needing', () => {
    // The other direction, and the one that makes self-hosting a real event
    // rather than a good intention: vendor the two families, delete the
    // `<link>` and both preconnects, and this test fails until `style-src` and
    // `font-src` go back to `'self'`. The policy cannot quietly stay wide.
    const external = [...CSP_PRODUCTION.matchAll(/https?:\/\/[^\s;]+/g)].map((m) => m[0]);
    expect([...new Set(external)].sort()).toEqual([...htmlOrigins].sort());
  });

  it('[9] names the font origins individually, not as a blanket scheme', () => {
    // `style-src https:` would also satisfy the test above and would allow
    // every host on the internet to supply a stylesheet. The origins are the
    // point; the scheme is not.
    expect(directives.get('style-src')).toEqual([
      "'self'",
      "'unsafe-inline'",
      'https://fonts.googleapis.com',
    ]);
    expect(directives.get('font-src')).toEqual([
      "'self'",
      'data:',
      'https://fonts.gstatic.com',
    ]);
    for (const directive of ['style-src', 'font-src', 'img-src', 'script-src', 'default-src']) {
      expect(directives.get(directive), directive).not.toContain('https:');
    }
    // And there are exactly two, so a third arriving is a decision someone has
    // to make on purpose.
    expect(htmlOrigins.size).toBe(2);
  });
});

/* ── main.ts, checked the only way it can be ──────────────────────────── */

/**
 * STATIC GUARDS ON THE FILE NO TEST CAN IMPORT.
 *
 * `main.ts` runs `protocol.registerSchemesAsPrivileged` and `app.whenReady()`
 * at module scope, so importing it needs a live Electron runtime and the suite
 * cannot. Everything with a decision in it has been moved out — but the WIRING
 * is still a place things go wrong, and defect [6] was exactly that: a
 * `webContents` event nobody registered a handler for.
 *
 * These assertions read the file as text. That is weaker than executing it and
 * is said plainly rather than dressed up: they prove a call site exists, not
 * that Electron delivers to it. What they do catch is the whole class of defect
 * [6] — a required handler simply absent — and a predicate call site quietly
 * bypassed, both of which were unverified before.
 */
describe('main.ts wiring', () => {
  const MAIN = resolve(process.cwd(), 'apps/desktop/src/main.ts');
  const source = readFileSync(MAIN, 'utf8');

  it('reads the real file', () => {
    expect(source.length).toBeGreaterThan(2000);
    expect(source).toContain('function createWindow');
  });

  it('[6] registers a handler for EVERY renderer departure, crash included', () => {
    // The list lives in `bridge/renderer-lifecycle.ts`, which is testable; this
    // is the join between that list and the file that has to act on it. Adding
    // a name there without wiring it here fails this test, and so does deleting
    // the `render-process-gone` line that closes [6].
    const missing = RENDERER_TEARDOWN_EVENTS.filter(
      (event) =>
        !new RegExp(`contents\\.(on|once)\\(\\s*'${event}'`).test(source) ||
        !source.includes(`teardown('${event}')`),
    );
    expect(missing).toEqual([]);
    // And specifically the one that was absent, spelled out so the reason this
    // test exists survives a refactor of the loop above.
    expect(source).toContain("contents.on('render-process-gone'");
  });

  it('[14] routes BOTH openExternal call sites through the allowlist', () => {
    // `will-navigate` and `setWindowOpenHandler`. Two call sites is how a fix
    // lands on one and misses the other, so the count is asserted rather than
    // assumed.
    const opens = [...source.matchAll(/shell\.openExternal\(/g)];
    expect(opens.length).toBe(2);
    const guarded = [...source.matchAll(/isAllowedExternalUrl\(url\)\)\s*void shell\.openExternal\(url\)/g)];
    expect(guarded.length).toBe(2);
  });

  it('[5] serves the bundle by URL, not by pathname alone', () => {
    // `resolveBundleRequest` takes a pathname and cannot see the host, which is
    // how a sibling origin was served the same bundle. `protocol.handle` must
    // go through the URL-aware resolver.
    expect(source).toContain('resolveBundleUrl(root, request.url)');
    expect(source).not.toContain('resolveBundleRequest(');
  });

  it('[5] gates the IPC trust check on the parsed-origin predicate', () => {
    // The predicate is tested directly; this asserts the file that RUNS uses
    // it. A correct predicate nothing calls is the shape defect [3] already
    // took once — right code in src/, dead in the shipping process.
    expect(source).toContain('isTrustedOrigin(');
    expect(source).not.toMatch(/startsWith\(\s*APP_ORIGIN/);
  });

  it('[9] sets the CSP the resolver chose as a response header', () => {
    // The constant lives in security.ts and reaches main.ts as `target.csp`,
    // so this pins the assignment rather than the constant's name.
    expect(source).toMatch(/headers\['content-security-policy'\]\s*=/);
    expect(source).toContain('target.csp');
  });

  it('[11] passes an owner to notifyListeners rather than broadcasting', () => {
    // Without the third argument every window receives every llamaToken and
    // every llamaEnd — including terminal events for turns it never started.
    const calls = [...source.matchAll(/notifyListeners\s*\(/g)];
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      const tail = source.slice(call.index ?? 0, (call.index ?? 0) + 220);
      expect(tail).toMatch(/ownerId|senderId/);
    }
  });

  it('routes an event by the plugin name the supervisor gives, not by a constant', () => {
    // `main.ts` cannot be imported by any test — `protocol.registerSchemes
    // Privileged` and `app.whenReady()` run at module scope — so the wiring is
    // pinned as text. Two halves, and both matter: the notify must FORWARD the
    // supervisor's plugin name, and the registration must use the facade the
    // supervisor builds per engine rather than the supervisor object itself.
    //
    // FAULT INJECTED both ways. Restoring `notifyListeners(LLAMA_PLUGIN.name,
    // …)` failed the first two assertions; restoring
    // `pluginHost.register(LLAMA_PLUGIN, supervisor as unknown as
    // PluginImplementation)` failed the third.
    const at = source.indexOf('pluginHost.notifyListeners');
    expect(at).toBeGreaterThan(0);
    expect(source.slice(at, at + 60)).toMatch(/notifyListeners\(\s*pluginName,/);
    expect(source).not.toMatch(/notifyListeners\(\s*LLAMA_PLUGIN\.name/);
    expect(source).toContain('fleet.plugin(LLAMA_PLUGIN.name)');
    expect(source).toContain('fleet.plugin(ONNX_PLUGIN.name)');
  });

  it('forks one host PER ENGINE, and names the engine in the fork', () => {
    // THE ISOLATION, at the one site no test can execute. `main.ts` is where
    // the multiplicity lands, and three things about it are load-bearing:
    //
    //  1. the fork carries the engine name, or `host-engine.ts` refuses to
    //     boot (that refusal is what stops a silent wrong-addon load);
    //  2. the fleet is built from an entry PER ENGINE — one entry serving both
    //     is the shared process this milestone removed;
    //  3. the ONNX entry gets its own ping budget, which is only safe because
    //     its host holds nothing llama.cpp depends on.
    //
    // FAULT INJECTED, one at a time, each against the wired file: dropping
    // `engineName` from the fork args failed (1); collapsing the two FLEET
    // entries to one failed (2); deleting the ONNX `policy` failed (3).
    expect(source).toMatch(/\[modelRoot\(\),\s*engineName\]/);
    expect(source).toContain("{ engine: LLAMA_ENGINE, host: 'llama' }");
    expect(source).toMatch(/\{ engine: ONNX_ENGINE, host: 'onnx', policy: \{ pingTimeoutMs: \d/);
    // Two hosts, not one shared one. `HostFleet` throws on a duplicate host
    // name, so this pins the half a boot check cannot: that they DIFFER.
    const hosts = [...source.matchAll(/host: '([a-z]+)'/g)].map((m) => m[1]);
    expect(hosts).toHaveLength(2);
    expect(new Set(hosts).size).toBe(2);
  });

  it('tears a departed renderer down across the WHOLE fleet', () => {
    // The one wiring mistake the split makes possible that fails SILENTLY: a
    // teardown reaching one supervisor leaks exactly the other engine's turns
    // and sessions, forever, with the app still working. So the call site must
    // name the fleet and must not be able to name a single supervisor.
    //
    // FAULT INJECTED: `releaseRenderer: (id, reason) => llamaSupervisor
    // .releaseRenderer(id, reason)` fails the first assertion.
    expect(source).toMatch(/releaseRenderer:\s*\(id, reason\) =>\s*fleet\.releaseRenderer\(/);
    // And the quit path, which has the same shape and the same silence.
    expect(source).toContain('fleet.dispose()');
    // No supervisor is constructed here at all any more. One built beside the
    // fleet would be a second, unsupervised host serving the same plugins.
    expect(source).not.toMatch(/new Supervisor\(/);
  });

  it('[13] does not re-swallow a throwing notify', () => {
    // The reordered settle only helps while main.ts lets the throw reach the
    // Supervisor. Wrapping the notify in a bare try/catch restores the silent
    // drop the reorder was written to prevent.
    // Look BEFORE the call, not after it: a wrapping `try {` sits ahead of
    // `notifyListeners`, so slicing forward from the call could never see it.
    // The first version of this test did exactly that and passed against the
    // very mutation it was written to catch.
    const at = source.indexOf('pluginHost.notifyListeners');
    expect(at).toBeGreaterThan(0);
    const before = source.slice(Math.max(0, at - 300), at);
    expect(before).not.toMatch(/try\s*\{[^}]*$/);
  });

  it('keeps the security defaults on the window it opens', () => {
    // Not a decision that can be extracted — it is an object literal Electron
    // reads — so it is pinned here.
    for (const setting of [
      'contextIsolation: true',
      'nodeIntegration: false',
      'sandbox: true',
      'webviewTag: false',
    ]) {
      expect(source).toContain(setting);
    }
  });
});

/* ── Model files ──────────────────────────────────────────────────────── */

describe('confineModelPath', () => {
  const ROOT = '/Users/someone/Library/Application Support/Chatterang/models';

  it('accepts a model inside the directory, absolute or relative', () => {
    expect(confineModelPath(ROOT, `${ROOT}/llama-cpp/gemma/model.gguf`)).toBe(
      `${ROOT}/llama-cpp/gemma/model.gguf`,
    );
    // A relative path is resolved against the root rather than the process cwd.
    expect(confineModelPath(ROOT, 'llama-cpp/gemma/model.gguf')).toBe(
      `${ROOT}/llama-cpp/gemma/model.gguf`,
    );
  });

  it('[8] FIXED: refuses the arbitrary absolute path that made this an oracle', () => {
    // The reviewer's exact reproduction. From the live page,
    // `invoke('LlamaCpp','load',[{modelPath:'/etc/hosts'}])` came back with
    // `Invalid GGUF magic. Expected "GGUF" but got "##\n#"` — the first four
    // bytes of a file the renderer cannot otherwise read.
    expect(confineModelPath(ROOT, '/etc/hosts')).toBeNull();
    expect(confineModelPath(ROOT, '/etc/passwd')).toBeNull();
    expect(confineModelPath(ROOT, '/Users/someone/.ssh/id_ed25519')).toBeNull();
  });

  it('[8] refuses a traversal out of the directory', () => {
    expect(confineModelPath(ROOT, '../../../etc/hosts')).toBeNull();
    expect(confineModelPath(ROOT, 'llama-cpp/../../../../etc/hosts')).toBeNull();
    expect(confineModelPath(ROOT, `${ROOT}/../secrets/key.pem`)).toBeNull();
  });

  it('[8] refuses a SIBLING directory that shares the root as a prefix', () => {
    // `…/Chatterang/models-backup` starts with `…/Chatterang/models`. The
    // separator in the comparison is the only thing that rejects it.
    expect(confineModelPath(ROOT, `${ROOT}-backup/model.gguf`)).toBeNull();
    expect(confineModelPath(`${ROOT}/`, `${ROOT}-backup/model.gguf`)).toBeNull();
  });

  it('[8] refuses the root itself, which is a directory and not a model', () => {
    expect(confineModelPath(ROOT, ROOT)).toBeNull();
    expect(confineModelPath(ROOT, '')).toBeNull();
    expect(confineModelPath(ROOT, '.')).toBeNull();
  });

  it('[8] refuses a NUL byte, so the checked path is the opened path', () => {
    // Stated precisely, because the obvious claim is wrong and a mutant proved
    // it: a NUL CANNOT be used to escape the root here. Truncation only
    // shortens a string, and a prefix of something under the root is either
    // still under the root or shorter than it — `ok.gguf\0/../../../etc/hosts`
    // resolves out of the root and is refused by the containment check alone.
    //
    // What the NUL check does buy is that the path we validated and RETURN is
    // the path the native addon opens. Without it, `gemma/model.gguf\0extra`
    // is inside the root, passes, and comes back as a resolved path whose C
    // representation stops four characters earlier than the string we checked.
    // A guard whose answer describes a different file than the one that gets
    // opened is not a guard, however narrow the gap is today.
    expect(confineModelPath(ROOT, 'gemma/model.gguf\0extra')).toBeNull();
    expect(confineModelPath(ROOT, `${ROOT}/a.gguf\0`)).toBeNull();
    // These two are refused by the containment check, with or without it.
    expect(confineModelPath(ROOT, 'ok.gguf\0/../../../etc/hosts')).toBeNull();
    expect(confineModelPath(ROOT, '/etc/hosts\0.gguf')).toBeNull();
  });

  it('[8] does not reject a legitimate name with dots or spaces in it', () => {
    // The mirror test. A containment check written as "reject any string
    // containing .." would 404 a real model, and Hugging Face filenames are
    // full of dots.
    expect(confineModelPath(ROOT, 'gemma-4-12b.Q4_K_M..v2.gguf')).toBe(
      `${ROOT}/gemma-4-12b.Q4_K_M..v2.gguf`,
    );
    expect(confineModelPath(ROOT, 'my models/a model.gguf')).toBe(`${ROOT}/my models/a model.gguf`);
  });
});

describe('the files no test can import still carry their guards', () => {
  // preload.ts and host/entry.ts run in processes the suite cannot enter, and
  // both are load-bearing: the preload is where defect [3]'s error codes were
  // being stripped, and the host entry is the process boundary [8]'s path
  // confinement sits behind. Static assertions are weaker than execution, and
  // are here because the alternative is nothing at all.
  const read = (rel: string) => readFileSync(resolve(process.cwd(), rel), 'utf8');

  it('[3] the preload hands the wire result across without unwrapping it', () => {
    const preload = read('apps/desktop/src/preload.ts');
    expect(preload.length).toBeGreaterThan(200);
    // contextBridge strips custom own properties from Errors, so unwrapping on
    // this side loses the code. The raw {ok,error} must cross intact.
    expect(preload).not.toContain('fromWireError');
  });

  it('the preload exposes exactly one bridge object', () => {
    const preload = read('apps/desktop/src/preload.ts');
    expect([...preload.matchAll(/exposeInMainWorld\s*\(/g)].length).toBe(1);
  });

  it('[8] the host confines model paths, and the engine that serves them applies it', () => {
    const paths = read('apps/desktop/src/host/model-paths.ts');
    expect(paths).toContain('PATH_FIELDS');
    // The confinement is worth nothing if the process boundary skips it.
    // Pin the import and the call, not a loose alternation: the first version
    // accepted the word "confinement" from a nearby comment, so breaking the
    // real import left the test green.
    //
    // It moved out of `entry.ts` when the host was split one process per
    // engine: `entry.ts` now only picks a branch, and each branch mounts its
    // own plugin with its own guard. Pinning the OLD file would have been a
    // test that passes because the thing it names no longer does anything.
    const llama = read('apps/desktop/src/host/llama-engine.ts');
    expect(llama).toMatch(/import\s*\{[^}]*modelPathGuard[^}]*\}\s*from\s*'\.\/model-paths\.js'/);
    expect(llama).toContain('modelPathGuard(');
  });

  it('[8] the ONNX host confines its own paths, which are a different set', () => {
    // The second engine's guard, which nothing pinned at all. `onnxPathGuard`
    // covers `modelPath` and every `companions` value — a different field set
    // from llama.cpp's — so the llama assertion above says nothing about it,
    // and after the split they are applied in two different files.
    const paths = read('apps/desktop/src/host/onnx-paths.ts');
    // Every `companions` value, not a fixed field list — that is the whole
    // reason this guard is not a copy of llama.cpp's.
    expect(paths).toContain('confineModelPath');
    expect(paths).toContain('companions');
    const onnx = read('apps/desktop/src/host/onnx-engine.ts');
    expect(onnx).toMatch(/import\s*\{[^}]*onnxPathGuard[^}]*\}\s*from\s*'\.\/onnx-paths\.js'/);
    expect(onnx).toContain('onnxPathGuard(');
  });

  it('the entry point still refuses to serve an engine it was not told to be', () => {
    // What is left in `entry.ts` after the guards moved out: the selector. A
    // host that guessed its engine would load the wrong native addon, and the
    // wrong guard with it, and would look like it worked — so the selector is
    // read before anything is imported and there is no default.
    const entry = read('apps/desktop/src/host/entry.ts');
    expect(entry).toMatch(/import\s*\{[^}]*parseEngineName[^}]*\}\s*from\s*'\.\/host-engine\.js'/);
    expect(entry).toContain('parseEngineName(process.argv)');
    const selector = read('apps/desktop/src/host/host-engine.ts');
    // No default: the `??` and `||` forms are exactly how a default gets
    // added, and either one silently makes every mis-fork a llama host.
    expect(selector).not.toMatch(/argv\[3\]\s*(\?\?|\|\|)/);
  });
});

/* ── Symlinks ─────────────────────────────────────────────────────────── */

describe('confineRealPath', () => {
  /*
   * `confineModelPath` is lexical by design and says so: it resolves `..` and
   * refuses absolute paths, and its own doc notes that symlink resolution
   * "belongs in the host". The host half was never written, so a symlink INSIDE
   * the model folder passed the guard and the engine followed it wherever it
   * pointed. Reproduced before the fix: with
   * `<root>/escape.onnx -> <tmp>/outside.txt`, the guard returned
   * `<root>/escape.onnx` — a path that opens a file outside the root.
   *
   * `confineModelPath`'s own tests above are untouched; it still does exactly
   * what it did. This covers the half that now runs after it.
   */
  const raw = mkdtempSync(join(tmpdir(), 'confine-'));
  // macOS hands out /var/folders/…, a symlink to /private/var. Keeping BOTH
  // spellings is what makes the unresolved-root case below meaningful.
  const real = realpathSync(raw);
  const root = join(real, 'models');
  const rawRoot = join(raw, 'models');

  mkdirSync(join(root, 'nested'), { recursive: true });
  mkdirSync(join(real, 'elsewhere'), { recursive: true });
  writeFileSync(join(real, 'outside.txt'), 'not a model');
  writeFileSync(join(root, 'real.gguf'), 'x');
  symlinkSync(join(real, 'outside.txt'), join(root, 'escape.onnx'));
  symlinkSync(join(real, 'elsewhere'), join(root, 'evildir'));
  symlinkSync(join(root, 'real.gguf'), join(root, 'inside-link'));

  it('refuses a symlink pointing out of the model folder', () => {
    expect(confineRealPath(root, join(root, 'escape.onnx'))).toBeNull();
  });

  it('refuses a path under a symlinked parent, even when the file is absent', () => {
    // The case a downloader creates: the target does not exist yet, so only
    // resolving the deepest EXISTING ancestor catches the escape.
    expect(confineRealPath(root, join(root, 'evildir', 'new.onnx'))).toBeNull();
  });

  it('accepts a real file inside the folder', () => {
    expect(confineRealPath(root, join(root, 'real.gguf'))).toBe(join(root, 'real.gguf'));
  });

  it('accepts a download target that does not exist yet', () => {
    const target = join(root, 'nested', 'download.gguf');
    expect(confineRealPath(root, target)).toBe(target);
  });

  it('accepts a symlink that stays inside the folder', () => {
    // Refusing this would be a false positive: the file it opens IS in the root.
    expect(confineRealPath(root, join(root, 'inside-link'))).toBe(join(root, 'real.gguf'));
  });

  it('refuses the root itself, which is a directory and not a model', () => {
    expect(confineRealPath(root, root)).toBeNull();
  });

  it('accepts a legitimate file under an UNRESOLVED root', () => {
    // If only the candidate were resolved, every path under a symlinked root —
    // which is what macOS hands out — would look like an escape.
    expect(confineRealPath(rawRoot, join(root, 'real.gguf'))).toBe(join(root, 'real.gguf'));
  });

  it('still refuses an escape when the root is unresolved', () => {
    expect(confineRealPath(rawRoot, join(root, 'escape.onnx'))).toBeNull();
  });

  it('refuses when the model folder does not exist at all', () => {
    expect(confineRealPath(join(real, 'no-such-root'), join(real, 'no-such-root', 'm.gguf'))).toBeNull();
  });
});

describe('the guards actually apply the symlink check', () => {
  /*
   * `confineRealPath` is pinned thoroughly above — but every one of those tests
   * passed while the guards did not call it at all. Deleting the call from
   * either guard left the whole suite green, which is the same shape as a
   * correct function nobody invokes. These two go through the guards.
   */
  const real = realpathSync(mkdtempSync(join(tmpdir(), 'guard-sym-')));
  const root = join(real, 'models');
  mkdirSync(join(root, 'whisper'), { recursive: true });
  writeFileSync(join(real, 'outside.txt'), 'not a model');
  writeFileSync(join(root, 'ok.gguf'), 'x');
  writeFileSync(join(root, 'whisper', 'encoder_model.onnx'), 'x');
  symlinkSync(join(real, 'outside.txt'), join(root, 'escape.gguf'));
  symlinkSync(join(real, 'outside.txt'), join(root, 'whisper', 'escape.onnx'));

  it('modelPathGuard refuses a symlink out of the model folder', () => {
    const guard = modelPathGuard(root);
    expect(() => guard('load', [{ modelPath: 'escape.gguf' }])).toThrow(/model folder/);
    // And still passes a real one, so the refusal is about the symlink.
    const [ok] = guard('load', [{ modelPath: 'ok.gguf' }]) as [Record<string, unknown>];
    expect(ok['modelPath']).toBe(join(root, 'ok.gguf'));
  });

  it('modelPathGuard refuses a symlinked companion too', () => {
    const guard = modelPathGuard(root);
    expect(() =>
      guard('load', [{ modelPath: 'ok.gguf', mmprojPath: 'escape.gguf' }]),
    ).toThrow(/model folder/);
  });

  it('onnxPathGuard refuses a symlinked model and a symlinked companion', () => {
    const guard = onnxPathGuard(root);
    expect(() => guard('createSession', [{ task: 'stt', modelPath: 'escape.gguf' }])).toThrow(
      /model folder/,
    );
    expect(() =>
      guard('createSession', [
        { task: 'stt', modelPath: 'whisper', companions: { encoder: 'whisper/escape.onnx' } },
      ]),
    ).toThrow(/model folder/);
  });
});
