/**
 * GATE 1, ON EVERY ROUTE, ON BOTH ARMS, OVER A REAL SOCKET.
 *
 * ── WHY THIS FILE EXISTS ────────────────────────────────────────────────
 *
 * Two mandatory mutations came back MISSED. One of them was "remove the auth
 * check from one route": the whole suite stayed green. That is not a near
 * miss, it is the absence of a test — `tests/server.test.ts` drove exactly two
 * routes anonymously (`/` and the RPC path) and left the event stream, the
 * bootstrap script, the asset route and every unknown path unasserted. The
 * event stream is the worst of those to leave open, because it is what HANDS
 * OUT the session id that gate 3 exists to require: a token check skipped
 * there is a session for the asking, and then the RPC route's own check passes
 * honestly.
 *
 * So the assertion here is a TABLE, not an example. Every route this server
 * answers is driven with no credential and must refuse, and then driven with
 * the credential and must not — because "401 for everything" is also what a
 * server broken in a different way looks like, and a table of refusals with no
 * matching table of successes proves nothing at all.
 *
 * ── AND ON BOTH ARMS, WHICH IS NEW ──────────────────────────────────────
 *
 * The loopback arm used to have no token: `checkToken` returned `{k:'pass'}`
 * for the whole arm and the plugin bridge answered anonymously. Measured, in
 * two requests on 127.0.0.1: an arbitrary file write inside the data root, and
 * a recursive delete of the model directory. See `apps/server/src/binding.ts`
 * for the argument. Half the table below is the loopback arm for that reason —
 * it is the DEFAULT binding, so it is the one that has to hold.
 *
 * ── WHAT IS REAL HERE ───────────────────────────────────────────────────
 *
 * The http server, the TLS handshake, the sockets, the bundle on disk, the
 * router and the plugin host. What is NOT here is an inference host: none of
 * these assertions reach one, and standing a child process up per case would
 * buy nothing but minutes. `tests/server.test.ts` is where the wire meets a
 * real forked host.
 */

import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { PluginHost } from '@chatterang/desktop/bridge';
import {
  BOOTSTRAP_PATH,
  EVENTS_PATH,
  RPC_PATH,
  SESSION_HEADER,
  TOKEN_COOKIE,
  TOKEN_QUERY,
  asTlsMaterial,
  generateToken,
  startServer,
} from '@chatterang/server';
import type { RunningServer, ServerBinding } from '@chatterang/server';

/* ── A bundle, and a server in front of it ────────────────────────────── */

function makeBundle(): string {
  const parent = mkdtempSync(join(tmpdir(), 'chatterang-auth-'));
  const root = join(parent, 'bundle');
  mkdirSync(join(root, 'assets'), { recursive: true });
  // The repo's real index.html: `prepareDocument` refuses a document with no
  // module script, so a fixture would be asserting against a fixture.
  copyFileSync(resolve(process.cwd(), 'index.html'), join(root, 'index.html'));
  writeFileSync(join(root, 'assets', 'app.js'), 'export const marker = "asset-body";\n');
  writeFileSync(join(parent, 'outside.txt'), 'OUTSIDE-THE-BUNDLE\n');
  return root;
}

const open: RunningServer[] = [];
afterEach(() => {
  for (const server of open.splice(0)) void server.close();
});

interface Stood {
  readonly server: RunningServer;
  readonly token: string;
  readonly tls: boolean;
}

async function stand(tls?: { key: string; cert: string }): Promise<Stood> {
  const token = generateToken();
  const binding: ServerBinding =
    tls === undefined
      ? { kind: 'loopback', port: 0, token }
      : {
          kind: 'authenticated',
          host: '127.0.0.1',
          port: 0,
          token,
          tls: asTlsMaterial(tls.key, tls.cert),
        };
  // No plugins registered: nothing below reaches one, and an empty manifest is
  // a legal surface (`assertServerSurface` refuses EXTRA plugins, never
  // missing ones — see `apps/server/src/surface.ts` on why that asymmetry).
  const server = await startServer({
    binding,
    bundleRoot: makeBundle(),
    pluginHost: new PluginHost(() => false, 'server'),
    release: () => undefined,
    log: () => undefined,
  });
  open.push(server);
  return { server, token: token.value, tls: tls !== undefined };
}

/* ── A client that sends exactly what it is told to ───────────────────── */

interface Answer {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

function send(
  stood: Stood,
  path: string,
  options: { method?: string; headers?: Record<string, string> } = {},
  body?: string,
): Promise<Answer> {
  return new Promise((done, fail) => {
    const call = stood.tls ? httpsRequest : httpRequest;
    const request = call(
      {
        host: '127.0.0.1',
        port: stood.server.port,
        path,
        method: options.method ?? 'GET',
        headers: options.headers ?? {},
        rejectUnauthorized: false,
      },
      (response: IncomingMessage) => {
        let text = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => {
          text += chunk;
        });
        // The event stream never ends on its own; take what arrived and hang
        // up, which is also what a browser closing an `EventSource` does.
        const settle = (): void =>
          done({ status: response.statusCode ?? 0, headers: response.headers, body: text });
        response.on('end', settle);
        if (response.statusCode === 200 && path === EVENTS_PATH) {
          setTimeout(() => {
            request.destroy();
            settle();
          }, 150);
        }
      },
    );
    request.on('error', (error) => {
      // A destroyed event stream rejects the request object; the response was
      // already settled above, so this is noise rather than a failure.
      if ((error as { code?: string }).code !== 'ECONNRESET') fail(error);
    });
    if (body !== undefined) request.write(body);
    request.end();
  });
}

function cookie(stood: Stood): Record<string, string> {
  return { cookie: `${TOKEN_COOKIE}=${encodeURIComponent(stood.token)}` };
}

/**
 * Every route this server answers, as a table.
 *
 * The point of the table is that adding a route to `http.ts` without adding a
 * row here is visible: `handle()` has five branches and an asset fallback, and
 * all six are named below.
 */
const ROUTES: readonly { name: string; path: string; method?: string; body?: string }[] = [
  { name: 'the document', path: '/' },
  { name: 'an asset', path: '/assets/app.js' },
  { name: 'the bootstrap script', path: BOOTSTRAP_PATH },
  { name: 'the event stream', path: EVENTS_PATH },
  {
    name: 'the RPC route',
    path: RPC_PATH,
    method: 'POST',
    body: JSON.stringify({ k: 'invoke', plugin: 'LlamaCpp', method: 'getCapabilities', args: [] }),
  },
  { name: 'a path the bundle does not have', path: '/no/such/thing' },
  { name: 'a traversal attempt', path: '/%2e%2e/outside.txt' },
];

function opensslAvailable(): boolean {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function selfSigned(): { key: string; cert: string } {
  const dir = mkdtempSync(join(tmpdir(), 'chatterang-auth-tls-'));
  const keyPath = join(dir, 'key.pem');
  const certPath = join(dir, 'cert.pem');
  execFileSync(
    'openssl',
    ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyPath, '-out', certPath, '-days', '1', '-subj', '/CN=localhost'],
    { stdio: 'ignore' },
  );
  return { key: readFileSync(keyPath, 'utf8'), cert: readFileSync(certPath, 'utf8') };
}

/* ── The table, on the loopback arm ───────────────────────────────────── */

describe('the loopback binding, which is the default one', () => {
  it('refuses EVERY route to a caller with no token', async () => {
    const stood = await stand();
    for (const route of ROUTES) {
      const answer = await send(stood, route.path, { method: route.method }, route.body);
      expect(
        { route: route.name, status: answer.status },
        `${route.name} answered a caller with no token`,
      ).toEqual({ route: route.name, status: 401 });
      // And it answered nothing worth having: not the app, not an asset, not
      // the file one directory outside the bundle root.
      expect(answer.body).not.toContain('<html');
      expect(answer.body).not.toContain('asset-body');
      expect(answer.body).not.toContain('OUTSIDE-THE-BUNDLE');
    }
  });

  it('answers the same routes to a caller that has it', async () => {
    /*
     * THE OTHER HALF, AND THE TEST ABOVE IS WORTHLESS WITHOUT IT. A server
     * that 401s unconditionally — a mistyped cookie name, a check that never
     * passes — satisfies every assertion in the previous case perfectly.
     */
    const stood = await stand();
    const headers = cookie(stood);

    const document = await send(stood, '/', { headers });
    expect(document.status).toBe(200);
    expect(document.body).toContain('<html');

    const asset = await send(stood, '/assets/app.js', { headers });
    expect(asset.status).toBe(200);
    expect(asset.body).toContain('asset-body');

    const bootstrap = await send(stood, BOOTSTRAP_PATH, { headers });
    expect(bootstrap.status).toBe(200);
    expect(bootstrap.body).toContain('CapacitorCustomPlatform');

    const stream = await send(stood, EVENTS_PATH, { headers });
    expect(stream.status).toBe(200);
    expect(stream.body).toContain('"k":"session"');

    // Past gate 1 and refused by gate 3, which is the correct 401 and a
    // different one: this caller has the token and no session.
    const rpc = await send(
      stood,
      RPC_PATH,
      { method: 'POST', headers: { ...headers, 'content-type': 'application/json' } },
      JSON.stringify({ k: 'invoke', plugin: 'LlamaCpp', method: 'getCapabilities', args: [] }),
    );
    expect(rpc.status).toBe(401);
    expect(rpc.body).toContain('No session');

    // The traversal is still refused, by the resolver rather than by the gate.
    const climb = await send(stood, '/%2e%2e/outside.txt', { headers });
    expect(climb.status).not.toBe(200);
    expect(climb.body).not.toContain('OUTSIDE-THE-BUNDLE');
  });

  it('hands an anonymous caller no session id, which is the whole of gate 3', async () => {
    /*
     * THE ROUTE THE MISSED MUTATION WOULD HAVE OPENED.
     *
     * `SESSION_HEADER` is documented as a CSRF guard on the grounds that the
     * session id is "128 random bits handed out only on the event stream".
     * That sentence is only true while the event stream itself is gated: a
     * token check skipped THERE hands out the id for free, and every later
     * gate then passes on its own merits. So this asserts the absence of an
     * id, not merely a status code.
     */
    const stood = await stand();
    const anonymous = await send(stood, EVENTS_PATH);
    expect(anonymous.status).toBe(401);
    expect(anonymous.body).not.toContain('"k":"session"');
    expect(anonymous.body).not.toMatch(/[0-9a-f]{32}/);

    // A guessed id does not work either, which is what makes the absence
    // above matter rather than being merely tidy.
    const guessed = await send(
      stood,
      RPC_PATH,
      {
        method: 'POST',
        headers: { ...cookie(stood), [SESSION_HEADER]: 'f'.repeat(32) },
      },
      JSON.stringify({ k: 'invoke', plugin: 'LlamaCpp', method: 'getCapabilities', args: [] }),
    );
    expect(guessed.status).toBe(401);
  });

  it('refuses a wrong token and adopts the right one exactly once', async () => {
    const stood = await stand();

    const wrong = await send(stood, `/?${TOKEN_QUERY}=${'x'.repeat(43)}`);
    expect(wrong.status).toBe(401);

    const adopt = await send(stood, `/?${TOKEN_QUERY}=${stood.token}`);
    expect(adopt.status).toBe(303);
    // Path only. An absolute Location built from a client-supplied Host header
    // is an open redirect, and the query with the secret in it is gone.
    expect(String(adopt.headers['location'])).toBe('/');

    const set = String(adopt.headers['set-cookie']);
    expect(set).toContain('HttpOnly');
    expect(set).toContain('SameSite=Strict');
    // NOT `Secure` on this arm: there is no https origin to send it back over,
    // and a browser that honours the attribute strictly would drop it and loop
    // forever. See `binding.ts:cookieIsSecure`.
    expect(set).not.toContain('Secure');

    const after = await send(stood, '/', { headers: { cookie: set.split(';')[0] ?? '' } });
    expect(after.status).toBe(200);
    expect(after.body).toContain('<html');
    // The secret is not in anything the server hands back.
    expect(after.body).not.toContain(stood.token);
  });

  it('says what to do without naming a directory on this disk', async () => {
    const stood = await stand();
    const refused = await send(stood, '/');
    expect(refused.status).toBe(401);
    expect(refused.body).toContain('<root>/server-token');
    // The literal `<root>`, not the real one: the peer being refused is
    // exactly the peer that should not learn the operator's layout.
    expect(refused.body).not.toContain(tmpdir());
    expect(refused.body).not.toMatch(/\/(Users|home|private|var)\//);
  });
});

/* ── The same table, over a real TLS handshake ────────────────────────── */

describe.runIf(opensslAvailable())('the authenticated binding', () => {
  it('refuses EVERY route to a caller with no token', async () => {
    const stood = await stand(selfSigned());
    for (const route of ROUTES) {
      const answer = await send(stood, route.path, { method: route.method }, route.body);
      expect(
        { route: route.name, status: answer.status },
        `${route.name} answered a caller with no token`,
      ).toEqual({ route: route.name, status: 401 });
      expect(answer.body).not.toContain('<html');
      expect(answer.body).not.toContain('asset-body');
    }
  });

  it('answers the document and the stream to a caller that has it', async () => {
    const stood = await stand(selfSigned());
    const headers = cookie(stood);

    const document = await send(stood, '/', { headers });
    expect(document.status).toBe(200);
    expect(document.body).toContain('<html');
    expect(document.body).not.toContain(stood.token);

    const stream = await send(stood, EVENTS_PATH, { headers });
    expect(stream.status).toBe(200);
    expect(stream.body).toContain('"k":"session"');
  });

  it('sets Secure on this arm, because there is a TLS origin to send it over', async () => {
    const stood = await stand(selfSigned());
    const adopt = await send(stood, `/?${TOKEN_QUERY}=${stood.token}`);
    expect(adopt.status).toBe(303);
    const set = String(adopt.headers['set-cookie']);
    expect(set).toContain('Secure');
    expect(set).toContain('HttpOnly');
    expect(set).toContain('SameSite=Strict');
  });
});
