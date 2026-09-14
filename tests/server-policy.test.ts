/**
 * The served deployment's policy, and the JSON wire's allowlist.
 *
 * Pure functions, driven directly — `tests/server.test.ts` then checks the
 * same decisions arriving as real headers on a real socket. Both are needed:
 * this file can enumerate cases a socket test cannot afford to, and the socket
 * test is the only thing that proves these functions are the ones the server
 * actually calls.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  CSP_PRODUCTION,
  NotJsonSafeError,
  SECURITY_HEADERS,
  SERVED_CSP,
  assertJsonWireSafe,
  dispatch,
  injectBootstrap,
  originAllowed,
  prepareDocument,
  readCookie,
  stripExternalStylesheets,
  tokenCookie,
} from '@chatterang/server';
import type { InvokeResult, MainRouter } from '@chatterang/desktop/bridge';

const INDEX = readFileSync(resolve(process.cwd(), 'index.html'), 'utf8');

/**
 * `default-src 'self'` -> `['default-src', "'self'"]`, per directive.
 *
 * A repeated name throws rather than overwriting. A Map keeps the last clause; a
 * browser keeps one and ignores the others. With overwriting, `"connect-src *"`
 * written above the real clause in both policies passed the parity test, which
 * compared the clauses after it.
 */
function directives(policy: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const clause of policy.split(';')) {
    const parts = clause.trim().split(/\s+/);
    const name = parts.shift();
    if (name === undefined || name === '') continue;
    if (out.has(name)) throw new Error(`${name} appears more than once in the policy`);
    out.set(name, parts);
  }
  return out;
}

describe('the served content-security-policy', () => {
  it('is the desktop policy with the two font origins removed, and nothing else', () => {
    const served = directives(SERVED_CSP);
    const desktop = directives(CSP_PRODUCTION);

    // Same directives, exactly. A directive present in one and not the other
    // is two policies drifting apart, which is how one of them becomes the
    // weak one nobody reads.
    expect([...served.keys()].sort()).toEqual([...desktop.keys()].sort());

    for (const [name, values] of desktop) {
      const local = (served.get(name) ?? []).filter((v) => !v.startsWith('https://fonts.'));
      const remote = values.filter((v) => !v.startsWith('https://fonts.'));
      expect(local).toEqual(remote);
    }

    // And the removal actually removed something — otherwise the loop above
    // would pass against two identical policies and prove nothing.
    expect(CSP_PRODUCTION).toContain('https://fonts.googleapis.com');
    expect(CSP_PRODUCTION).toContain('https://fonts.gstatic.com');
  });

  it('names no origin off this machine', () => {
    const external = [...directives(SERVED_CSP).values()]
      .flat()
      .filter((value) => /^https?:\/\//.test(value));
    expect(external).toEqual([]);
  });

  it('keeps the img-src that closed the markdown-image exfiltration', () => {
    // By parsed value, not by substring: `img-src 'self' data: blob: http:`
    // still contains the old substring, and would reopen the channel over plain
    // http. Nothing failed when `http:` was appended in both policies.
    expect(directives(SERVED_CSP).get('img-src')).toEqual(["'self'", 'data:', 'blob:']);
    const meta = /<meta http-equiv="Content-Security-Policy" content="([^"]*)"/.exec(INDEX);
    expect(meta, 'index.html carries its meta policy').not.toBeNull();
    expect(directives(meta?.[1] ?? '').get('img-src')).toEqual(["'self'", 'data:', 'blob:']);
  });

  it('sends the other four headers a served origin needs', () => {
    expect(SECURITY_HEADERS['x-content-type-options']).toBe('nosniff');
    // The one-time `?token=` must not reach a third party even in the moment
    // before it is stripped.
    expect(SECURITY_HEADERS['referrer-policy']).toBe('no-referrer');
    expect(SECURITY_HEADERS['x-frame-options']).toBe('DENY');
    expect(SECURITY_HEADERS['cross-origin-opener-policy']).toBe('same-origin');
  });
});

describe('the served document', () => {
  it('removes every external stylesheet, and keeps every local link', () => {
    // The real index.html, so this is vacuous the day it stops linking fonts —
    // which is checked, rather than assumed.
    expect(INDEX).toContain('https://fonts.googleapis.com');
    const stripped = stripExternalStylesheets(INDEX);
    expect(stripped).not.toContain('fonts.googleapis.com');
    expect(stripped).not.toContain('fonts.gstatic.com');
    expect(stripped).toContain('rel="manifest"');
    expect(stripped).toContain('/favicon-32.png');
    expect(stripped).toContain('apple-touch-icon');
  });

  it('puts the bootstrap before the app bundle', () => {
    const html = injectBootstrap(INDEX);
    const bootstrapAt = html.indexOf('/__chatterang/bootstrap.js');
    const moduleAt = html.indexOf('type="module"');
    expect(bootstrapAt).toBeGreaterThan(-1);
    expect(bootstrapAt).toBeLessThan(moduleAt);
  });

  it('refuses a document with no module script rather than guessing a position', () => {
    // A bundle that changed shape. Injecting at the end would put the seeding
    // AFTER the thing it has to precede, and the page would fall through to
    // the development plugin shims with no error anywhere.
    expect(() => injectBootstrap('<html><body>nothing here</body></html>')).toThrow(
      /no <script type="module">/,
    );
  });

  it('does both, and leaves the meta policy alone', () => {
    const prepared = prepareDocument(INDEX);
    expect(prepared).not.toContain('fonts.googleapis.com');
    expect(prepared).toContain("img-src 'self' data: blob:");
    expect(prepared.indexOf('/__chatterang/bootstrap.js')).toBeLessThan(
      prepared.indexOf('type="module"'),
    );
  });
});

describe('who may call the API', () => {
  const ours = ['http://127.0.0.1:8973', 'http://localhost:8973'];

  it('accepts our own origins and a request that sends none', () => {
    // A same-origin GET omits `Origin` in every browser; refusing that would
    // refuse the app itself.
    expect(originAllowed(undefined, ours)).toBe(true);
    expect(originAllowed('', ours)).toBe(true);
    expect(originAllowed('http://127.0.0.1:8973', ours)).toBe(true);
    expect(originAllowed('http://localhost:8973', ours)).toBe(true);
  });

  it('refuses anything else, including the shapes that look like ours', () => {
    for (const origin of [
      'https://evil.example',
      // A prefix of ours is a different origin — the exact defect the desktop
      // shell's `isTrustedOrigin` was fixed for.
      'http://127.0.0.1:89731',
      'http://127.0.0.1.evil.example',
      'http://localhost:8973.evil.example',
      // Sandboxed iframes and data: URLs send this. None of them is our page.
      'null',
    ]) {
      expect(originAllowed(origin, ours)).toBe(false);
    }
  });
});

describe('the token cookie', () => {
  it('cannot be read by script, sent over plaintext, or attached cross-site', () => {
    const cookie = tokenCookie('chatterang_token', 'abc/def', true);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('SameSite=Strict');
    expect(cookie).toContain('Path=/');
    // Encoded, so a token containing a cookie delimiter cannot inject an
    // attribute of its own.
    expect(cookie).toContain('abc%2Fdef');
  });

  it('drops only Secure on the plaintext arm, and keeps the other three', () => {
    // The loopback arm has a token now, so this cookie is set over http. A
    // `Secure` cookie there is accepted by browsers that treat 127.0.0.1 as a
    // trustworthy origin and dropped by ones that do not — an authentication
    // that works in three browsers and loops in the fourth. The two attributes
    // that actually defend it are not conditional.
    const cookie = tokenCookie('chatterang_token', 'abc/def', false);
    expect(cookie).not.toContain('Secure');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
    expect(cookie).toContain('Path=/');
  });

  it('reads one cookie out of a header with several', () => {
    expect(readCookie('a=1; chatterang_token=xyz; b=2', 'chatterang_token')).toBe('xyz');
    expect(readCookie('chatterang_token=xyz', 'chatterang_token')).toBe('xyz');
    expect(readCookie('other=xyz', 'chatterang_token')).toBeUndefined();
    expect(readCookie(undefined, 'chatterang_token')).toBeUndefined();
    // A cookie whose NAME merely ends with ours must not answer for it.
    expect(readCookie('not_chatterang_token=xyz', 'chatterang_token')).toBeUndefined();
  });
});

describe('what the JSON wire will carry', () => {
  it('accepts every shape the declared plugin surface actually sends', () => {
    // Taken from `packages/contracts`: audio and images cross as base64
    // strings, so nothing on the real surface needs more than JSON.
    expect(() =>
      assertJsonWireSafe(
        [
          {
            handle: 'whisper-base',
            audio: 'UklGRiQAAABXQVZF',
            mediaType: 'audio/wav',
            streamPartials: true,
            requestId: 'r-1',
            messages: [{ role: 'user', content: 'hello' }],
            options: { temperature: 0.7, maxTokens: 256, stop: ['\n'] },
          },
        ],
        'args',
      ),
    ).not.toThrow();
  });

  it('allows an undefined property, because JSON already treats it as absent', () => {
    // `{language: undefined}` and `{}` are the same call to every method on
    // this wire, and `JSON.stringify` makes them the same bytes.
    expect(() => assertJsonWireSafe({ language: undefined }, 'options')).not.toThrow();
  });

  it('refuses an undefined ARRAY element, because that one changes meaning', () => {
    // A hole in an array becomes `null`, and a caller handed `null` where an
    // element was missing has a corrupted value rather than a refused one.
    expect(() => assertJsonWireSafe(['a', undefined], 'args')).toThrow(NotJsonSafeError);
    expect(() => assertJsonWireSafe(['a', undefined], 'args')).toThrow(/args\[1\]/);
  });

  it('refuses everything JSON would quietly mangle, and says where', () => {
    const cases: [unknown, RegExp][] = [
      [{ audio: new Uint8Array([1, 2, 3]) }, /audio/],
      [{ when: new Date() }, /when/],
      [{ seen: new Map() }, /seen/],
      [{ ids: new Set() }, /ids/],
      [{ size: 10n }, /size/],
      [{ ratio: Number.NaN }, /ratio/],
      [{ ratio: Number.POSITIVE_INFINITY }, /ratio/],
      [{ onToken: () => undefined }, /onToken/],
      [{ tag: Symbol('x') }, /tag/],
      [{ nested: { deep: { signal: new AbortController().signal } } }, /nested\.deep\.signal/],
    ];
    for (const [value, path] of cases) {
      expect(() => assertJsonWireSafe(value, 'args')).toThrow(NotJsonSafeError);
      expect(() => assertJsonWireSafe(value, 'args')).toThrow(path);
    }
  });

  it('refuses a value too deep to be a call rather than recursing into it', () => {
    let deep: unknown = 'end';
    for (let at = 0; at < 200; at += 1) deep = { deep };
    expect(() => assertJsonWireSafe(deep, 'args')).toThrow(/nested deeper/);
  });
});

describe('one wire operation onto one channel', () => {
  /** A router that records what it was asked, and answers. */
  function spy(): { router: MainRouter; seen: { channel: string; payload: unknown }[] } {
    const seen: { channel: string; payload: unknown }[] = [];
    const router: MainRouter = {
      bootstrap: () => ({ platform: 'server', plugins: [] }),
      channels: () => [],
      handle: async (_senderId, channel, payload): Promise<InvokeResult> => {
        seen.push({ channel, payload });
        return { ok: true, data: 'answered' };
      },
    };
    return { router, seen };
  }

  it('composes the channel the router built its table from', async () => {
    const { router, seen } = spy();
    await dispatch(router, 7, { k: 'invoke', plugin: 'LlamaCpp', method: 'generate', args: [1] });
    expect(seen[0]?.channel).toContain('LlamaCpp');
    expect(seen[0]?.channel).toContain('generate');
    expect(seen[0]?.payload).toEqual([1]);
  });

  it('routes the three listener operations to their own channels', async () => {
    const { router, seen } = spy();
    await dispatch(router, 1, { k: 'addListener', plugin: 'LlamaCpp', event: 'llamaToken', subscriptionId: 3 });
    await dispatch(router, 1, { k: 'removeListener', subscriptionId: 3 });
    await dispatch(router, 1, { k: 'removeAllListeners', plugin: 'LlamaCpp' });
    expect(seen.map((call) => call.channel)).toEqual([
      'chatterang:listener:add',
      'chatterang:listener:remove',
      'chatterang:listener:remove-all',
    ]);
    expect(seen[0]?.payload).toEqual({
      pluginName: 'LlamaCpp',
      eventName: 'llamaToken',
      subscriptionId: 3,
    });
  });

  it('refuses a body that is not a request, without reaching the router', async () => {
    const { router, seen } = spy();
    for (const body of [null, 'a string', 42, { k: 'exec' }, { k: 'invoke', plugin: 'X' }]) {
      const answer = await dispatch(router, 1, body);
      expect(answer.ok).toBe(false);
    }
    expect(seen).toEqual([]);
  });
});
