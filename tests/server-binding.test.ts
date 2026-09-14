/**
 * THE BINDING, AND THE THINGS THAT CANNOT BE WRITTEN DOWN.
 *
 * The milestone's requirement is that binding beyond loopback without auth is
 * IMPOSSIBLE rather than discouraged, so half the assertions in this file are
 * compile-time. `@ts-expect-error` is not a comment here: `npm run typecheck`
 * includes `tests/`, and a `@ts-expect-error` on a line that STOPS being an
 * error is itself an error. So the day someone widens `ServerBinding` to admit
 * a host without a token, this file fails the build — which is the only place
 * a guarantee of this shape can actually live.
 *
 * The runtime half covers the parser, which is the other way an operator meets
 * the rule: `--host 0.0.0.0` has to refuse loudly rather than start.
 */

import { chmodSync, existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_PORT,
  LOOPBACK_HOST,
  SERVER_FLAGS,
  asAuthToken,
  asTlsMaterial,
  cookieIsSecure,
  generateToken,
  listenHost,
  parseArgv,
  readOrCreateToken,
  resolveBinding,
  selfOrigin,
  tokenMatches,
} from '@chatterang/server';
import type { ServerBinding } from '@chatterang/server';

const MATERIAL = asTlsMaterial('-----BEGIN KEY-----\nk\n', '-----BEGIN CERT-----\nc\n');

/** Credentials that succeed, so a refusal below is about the RULE. */
function credentials(): Parameters<typeof resolveBinding>[1] {
  return { tls: () => MATERIAL, token: () => generateToken() };
}

describe('the binding type', () => {
  it('has no way to spell a non-loopback address without a token and a certificate', () => {
    // Each of these is a value someone would reasonably try to write, and each
    // is a TYPE error. If any one of them stops being an error, this test
    // fails to COMPILE — see the file header.

    // @ts-expect-error the authenticated arm requires both a token and TLS.
    const noCredentials: ServerBinding = { kind: 'authenticated', host: '0.0.0.0', port: 8080 };

    const loopbackWithHost: ServerBinding = {
      kind: 'loopback',
      port: 8080,
      // @ts-expect-error the loopback arm has no host field to put an address in.
      host: '0.0.0.0',
      token: generateToken(),
    };

    // The loopback arm carries a token TOO, and this is the pin for it. The
    // arm shipped without one and the plugin bridge answered every process on
    // the machine; see the header of `apps/server/src/binding.ts`. The day
    // someone drops the field to make a test shorter, the BUILD fails.
    // @ts-expect-error the loopback arm cannot be written down without a token.
    const loopbackWithoutToken: ServerBinding = { kind: 'loopback', port: 8080 };

    const loopbackNotAToken: ServerBinding = {
      kind: 'loopback',
      port: 8080,
      // @ts-expect-error not on this arm either: a token is not a string.
      token: 'hunter2',
    };

    const notAToken: ServerBinding = {
      kind: 'authenticated',
      host: '0.0.0.0',
      port: 8080,
      // @ts-expect-error a token is not a string an operator can invent.
      token: 'hunter2',
      tls: MATERIAL,
    };

    const notCertificates: ServerBinding = {
      kind: 'authenticated',
      host: '0.0.0.0',
      port: 8080,
      token: generateToken(),
      // @ts-expect-error TLS material is not an object literal either.
      tls: { key: '', cert: '' },
    };

    // The values still exist at runtime; it is the types that refuse.
    expect([
      noCredentials,
      loopbackWithHost,
      loopbackWithoutToken,
      loopbackNotAToken,
      notAToken,
      notCertificates,
    ]).toHaveLength(6);
  });

  it('binds the loopback arm to a constant, with no field behind it', () => {
    const binding: ServerBinding = { kind: 'loopback', port: 1234, token: generateToken() };
    expect(listenHost(binding)).toBe(LOOPBACK_HOST);
    expect(LOOPBACK_HOST).toBe('127.0.0.1');
    expect(selfOrigin(binding)).toBe('http://127.0.0.1:1234');
    // No `Secure` on the cookie for this arm, and it is not an oversight:
    // there is no https origin here to send it back over. See
    // `binding.ts:cookieIsSecure`.
    expect(cookieIsSecure(binding)).toBe(false);
  });

  it('binds the authenticated arm where it was told, over https', () => {
    const binding: ServerBinding = {
      kind: 'authenticated',
      host: '10.0.0.4',
      port: 443,
      token: generateToken(),
      tls: MATERIAL,
    };
    expect(listenHost(binding)).toBe('10.0.0.4');
    expect(cookieIsSecure(binding)).toBe(true);
    // The default port for the scheme is omitted, because that is how a
    // browser spells an origin and the origin check compares strings.
    expect(selfOrigin(binding)).toBe('https://10.0.0.4');
  });
});

describe('resolving a binding from what the operator asked for', () => {
  it('gives a bare request the loopback arm', () => {
    const binding = resolveBinding({}, credentials());
    expect(binding.kind).toBe('loopback');
    expect(binding.port).toBe(DEFAULT_PORT);
  });

  it('REFUSES a host beyond loopback with no certificate', () => {
    expect(() => resolveBinding({ host: '0.0.0.0' }, credentials())).toThrow(
      /refusing to bind 0\.0\.0\.0/,
    );
    expect(() => resolveBinding({ host: '192.168.1.204', port: 8080 }, credentials())).toThrow(
      /certificate/,
    );
  });

  it('refuses half a certificate rather than starting with it', () => {
    expect(() =>
      resolveBinding({ host: '0.0.0.0', tlsKeyPath: '/tmp/key.pem' }, credentials()),
    ).toThrow(/go together/);
    expect(() =>
      resolveBinding({ host: '0.0.0.0', tlsCertPath: '/tmp/cert.pem' }, credentials()),
    ).toThrow(/go together/);
  });

  it('accepts a host beyond loopback WITH material, and takes a token for it', () => {
    let tokensTaken = 0;
    const binding = resolveBinding(
      { host: '0.0.0.0', port: 8443, tlsKeyPath: '/k', tlsCertPath: '/c' },
      {
        tls: () => MATERIAL,
        token: () => {
          tokensTaken += 1;
          return generateToken();
        },
      },
    );
    expect(binding.kind).toBe('authenticated');
    // The token is not optional in that arm: it was fetched, not skipped.
    expect(tokensTaken).toBe(1);
  });

  it('takes a token even for a loopback address once TLS is asked for', () => {
    // TLS on loopback is the authenticated arm with a local address. Treating
    // it as "loopback, so no token" would be a way to ask for the second arm
    // and get the first one's rules.
    const binding = resolveBinding(
      { host: '127.0.0.1', tlsKeyPath: '/k', tlsCertPath: '/c' },
      credentials(),
    );
    expect(binding.kind).toBe('authenticated');
    expect(cookieIsSecure(binding)).toBe(true);
  });

  it('takes a token for the bare loopback arm too, rather than skipping one', () => {
    // THE REGRESSION THIS PINS. `resolveBinding({})` used to answer
    // `{kind:'loopback', port}` and never call `credentials.token()` at all —
    // which is what made the plugin bridge anonymous to every process on the
    // machine. Counting the calls is the only way to see it from here: the
    // binding LOOKS the same either way until something asks for the secret.
    let tokensTaken = 0;
    const binding = resolveBinding(
      {},
      {
        tls: () => MATERIAL,
        token: () => {
          tokensTaken += 1;
          return generateToken();
        },
      },
    );
    expect(binding.kind).toBe('loopback');
    expect(tokensTaken).toBe(1);
    expect(binding.token.value).toHaveLength(43);
  });

  it('refuses a port that is not one', () => {
    expect(() => resolveBinding({ port: 0 }, credentials())).toThrow(/is not a port/);
    expect(() => resolveBinding({ port: 70_000 }, credentials())).toThrow(/is not a port/);
  });
});

describe('the command line', () => {
  it('reads the flags it has', () => {
    expect(
      parseArgv(['--root', '/srv/chatterang', '--port', '9000', '--host', 'example.internal']),
    ).toEqual({ root: '/srv/chatterang', port: 9000, host: 'example.internal' });
  });

  it('refuses the flag someone will inevitably try', () => {
    // Silently ignoring `--no-auth` would leave an operator believing it did
    // something. There is no such flag, and saying so is the point.
    for (const flag of ['--no-auth', '--insecure', '--allow-remote', '--disable-tls']) {
      expect(() => parseArgv([flag])).toThrow(/unknown option/);
    }
  });

  it('refuses a flag with no value rather than swallowing the next one', () => {
    expect(() => parseArgv(['--root'])).toThrow(/needs a value/);
    expect(() => parseArgv(['--root', '--port'])).toThrow(/needs a value/);
  });

  it('every flag in the table round-trips and is named in the refusal', () => {
    // THE DRIFT THIS PINS. The refusal was a hand-written sentence beside a
    // switch, and `--advertise` (#252) joined the switch without joining the
    // sentence, so an operator who mistyped it was handed a list without it.
    const refusal = (() => {
      try {
        parseArgv(['--no-auth']);
      } catch (error) {
        return (error as Error).message;
      }
      throw new Error('--no-auth was accepted');
    })();

    for (const [flag, spec] of Object.entries(SERVER_FLAGS)) {
      const argv = (() => {
        switch (spec.arity) {
          case 'value':
            return [flag, '9000'];
          default: {
            // A new arity fails to compile here until this test drives it.
            const unhandled: never = spec.arity;
            throw new Error(`no way to drive arity ${String(unhandled)}`);
          }
        }
      })();
      // Exactly one field written, holding the value: a row whose `set` does
      // nothing, or writes two fields, is not a flag this server takes.
      expect(Object.values(parseArgv(argv)).map(String), flag).toEqual(['9000']);
    }

    // The names in the refusal ARE the table's keys — neither a flag the
    // parser accepts and the sentence omits, nor one it names and refuses.
    const named = refusal.replace('unknown option --no-auth', '').match(/--[a-z][a-z-]*/g) ?? [];
    expect([...named].sort()).toEqual(Object.keys(SERVER_FLAGS).sort());
    expect(named).toContain('--advertise');
    expect(refusal).toContain('There is no flag that turns authentication off');
  });

  it('reads every flag into its own field', () => {
    // `main.ts` reads these by field name; a row writing the neighbouring
    // field (a key path into `tlsCertPath`) would start with half a certificate.
    expect(
      parseArgv([
        '--root', '/srv/chatterang',
        '--bundle', '/srv/dist',
        '--hosts', '/srv/host.mjs',
        '--port', '8443',
        '--host', '0.0.0.0',
        '--advertise', 'studio.local',
        '--tls-key', '/etc/key.pem',
        '--tls-cert', '/etc/cert.pem',
      ]),
    ).toEqual({
      root: '/srv/chatterang',
      bundle: '/srv/dist',
      hosts: '/srv/host.mjs',
      port: 8443,
      host: '0.0.0.0',
      advertise: 'studio.local',
      tlsKeyPath: '/etc/key.pem',
      tlsCertPath: '/etc/cert.pem',
    });
  });

  it('refuses a name the table inherits rather than owns', () => {
    // A plain index would find `Object.prototype` behind these and hand the
    // parser something that is not a row. They are unknown options.
    for (const token of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      expect(() => parseArgv([token]), token).toThrow(/unknown option/);
    }
  });
});

describe('the operator token', () => {
  const root = (): string => mkdtempSync(join(tmpdir(), 'chatterang-token-'));

  it('is 256 bits, and is created 0600', () => {
    const path = join(root(), 'server-token');
    const { token, created } = readOrCreateToken(path);
    expect(created).toBe(true);
    // base64url of 32 bytes is 43 characters.
    expect(token.value).toHaveLength(43);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(path, 'utf8').trim()).toBe(token.value);
  });

  it('re-reads the same token, and narrows a file an earlier run left wide', () => {
    const path = join(root(), 'server-token');
    const first = readOrCreateToken(path);

    // THE FAULT INJECTION. A file written under a wide umask, or copied by an
    // operator, stays wide — and a credential every account on the machine can
    // read is not a credential on the kind of machine anyone runs a server on.
    chmodSync(path, 0o644);
    expect(statSync(path).mode & 0o777).toBe(0o644);

    const second = readOrCreateToken(path);
    expect(second.created).toBe(false);
    expect(second.token.value).toBe(first.token.value);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('refuses a token file somebody hand-edited into something guessable', () => {
    const path = join(root(), 'server-token');
    writeFileSync(path, 'letmein\n', { mode: 0o600 });
    expect(() => readOrCreateToken(path)).toThrow(/is not a credential/);
    expect(existsSync(path)).toBe(true);
  });

  it('matches only itself', () => {
    const token = generateToken();
    expect(tokenMatches(token, token.value)).toBe(true);
    expect(tokenMatches(token, undefined)).toBe(false);
    expect(tokenMatches(token, '')).toBe(false);
    // A prefix, a suffix, and one flipped character: the comparison hashes
    // both sides to a fixed width first, so none of these is distinguishable
    // by how long it takes to say no.
    expect(tokenMatches(token, token.value.slice(0, -1))).toBe(false);
    expect(tokenMatches(token, `${token.value}x`)).toBe(false);
    /*
     * FLIPPED, NOT SUBSTITUTED WITH A LITERAL. This line used to be
     * `` `x${token.value.slice(1)}` ``, which is not a flipped character when
     * the token already begins with `x` — one run in 64, on a random 43-char
     * base64url string, in which the "wrong" token IS the token and this
     * asserted `false` about a value that is equal. Observed, on this branch,
     * as `expected true to be false` with nothing else changed.
     */
    const first = token.value[0] === 'x' ? 'y' : 'x';
    expect(tokenMatches(token, `${first}${token.value.slice(1)}`)).toBe(false);
    expect(tokenMatches(token, asAuthToken('a'.repeat(43)).value)).toBe(false);
  });

  it('never generates the same token twice', () => {
    const seen = new Set(Array.from({ length: 50 }, () => generateToken().value));
    expect(seen.size).toBe(50);
  });
});
