import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  APP_ORIGIN,
  APP_SCHEME,
  CSP_PRODUCTION,
  MIME,
  isAllowedExternalUrl,
  isTrustedOrigin,
  resolveBundleRequest,
  resolveWithinRoot,
} from '@chatterang/desktop/security';

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
 * SOME OF THESE TESTS ASSERT THE WRONG ANSWER ON PURPOSE. `isTrustedOrigin`
 * admits a sibling origin and `isAllowedExternalUrl` admits `file://`; both are
 * known defects ([5] and [14]) that later phases fix. Pinning today's behaviour
 * means the fix announces itself as these tests flipping — a visible, reviewed
 * change — instead of arriving as a silent edit nothing was watching. Each such
 * test is marked DEFECT and says what the corrected answer will be.
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

  it('DEFECT [5]: admits a sibling origin, because it is a string prefix test', () => {
    // `startsWith` is not an origin comparison. These are DIFFERENT origins and
    // every one of them is trusted today — and `protocol.handle` ignores the
    // URL host, so each is served the same bundle off the same disk and can
    // then reach every plugin channel.
    //
    // AFTER [5] these three become `false` (parsed-origin equality). This test
    // is the one that flips.
    expect(isTrustedOrigin('chatterang-desktop://appzz/index.html', '')).toBe(true);
    expect(isTrustedOrigin('chatterang-desktop://app-evil/index.html', '')).toBe(true);
    expect(isTrustedOrigin('chatterang-desktop://app.evil.example/', '')).toBe(true);
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

  it('DEFECT [5]: a dev-server port prefixes a longer port', () => {
    // `http://localhost:5273` prefixes `http://localhost:52739`, so a page on
    // that other port is trusted. It only bites when a dev URL is set, and
    // `scripts/sync.mjs` refuses to package a build carrying one — but it is
    // the same missing origin comparison, so [5] fixes it in the same edit and
    // this expectation becomes `false`.
    expect(isTrustedOrigin('http://localhost:52739/', 'http://localhost:5273')).toBe(true);
  });
});

/* ── Leaving the app ──────────────────────────────────────────────────── */

describe('isAllowedExternalUrl', () => {
  it('allows the http schemes a link is supposed to use', () => {
    expect(isAllowedExternalUrl('https://example.com/docs')).toBe(true);
    expect(isAllowedExternalUrl('http://example.com/docs')).toBe(true);
  });

  it('DEFECT [14]: allows every other scheme too, because there is no allowlist', () => {
    // `main.ts` hands `will-navigate` and `setWindowOpenHandler` URLs straight
    // to `shell.openExternal`. Model output renders as Markdown, so the string
    // is model-reachable, and the OS launches whatever is registered for the
    // scheme. Every expectation below becomes `false` under [14].
    expect(isAllowedExternalUrl('file:///Users/someone/.ssh/id_ed25519')).toBe(true);
    expect(isAllowedExternalUrl('smb://attacker.example/share')).toBe(true);
    expect(isAllowedExternalUrl('ms-msdt:/id')).toBe(true);
    expect(isAllowedExternalUrl('javascript:alert(1)')).toBe(true);
    expect(isAllowedExternalUrl('not a url at all')).toBe(true);
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

  it('DEFECT [9]: blocks the webfonts index.html actually asks for', () => {
    // `index.html` links `fonts.googleapis.com` and preconnects
    // `fonts.gstatic.com`; the policy allows neither in style-src nor font-src,
    // so in a packaged build the app's own typography is refused. The fix is to
    // self-host the two families and delete the link — which makes this test's
    // expectations the CORRECT ones and leaves the tightened policy in place.
    expect(directives.get('style-src')).toEqual(["'self'", "'unsafe-inline'"]);
    expect(directives.get('font-src')).toEqual(["'self'", 'data:']);
    expect(CSP_PRODUCTION).not.toContain('fonts.googleapis.com');
    expect(CSP_PRODUCTION).not.toContain('fonts.gstatic.com');

    const html = readFileSync(resolve(process.cwd(), 'index.html'), 'utf8');
    expect(html).toContain('fonts.googleapis.com');
  });
});
