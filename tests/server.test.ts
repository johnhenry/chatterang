/**
 * THE SERVER, BOUND TO A REAL PORT AND ANSWERED WITH REAL REQUESTS.
 *
 * Everything in this file goes over a socket. Nothing here reads the router to
 * decide whether a route is reachable — the brief for this milestone is
 * explicit that "do not conclude a route is unreachable by reading the router"
 * — so every claim below is a status code, a header, or a body that came back
 * over TCP from `apps/server/src`.
 *
 * The inference host is a REAL forked child process
 * (`tests/fixtures/server-host-double.mjs`) speaking the same IPC protocol with
 * the same `serialization: 'advanced'` the shipped server uses, because the
 * property that matters most here — one peer's tokens reach that peer and no
 * other — cannot be established against a mock that was told what to emit.
 *
 * WHAT IS FAKED AND WHAT IS NOT:
 *   NOT faked  the http server, the TLS handshake, the sockets, the SSE
 *              stream, the child process, the IPC serializer, the bundle on
 *              disk, `PluginHost`, `Supervisor`, `HostFleet`, the router.
 *   Faked      what the child computes. It answers instantly instead of
 *              loading a 4 GB GGUF.
 */

import { execFileSync, fork, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  HostFleet,
  LLAMA_ENGINE,
  LLAMA_PLUGIN,
  PluginHost,
  systemTimers,
} from '@chatterang/desktop/bridge';
import type { HostHandle } from '@chatterang/desktop/bridge';
import {
  BOOTSTRAP_PATH,
  EVENTS_PATH,
  RPC_PATH,
  SESSION_HEADER,
  TOKEN_QUERY,
  asTlsMaterial,
  generateToken,
  startServer,
} from '@chatterang/server';
import type { RunningServer } from '@chatterang/server';

const HOST_SCRIPT = resolve(process.cwd(), 'tests/fixtures/server-host-double.mjs');
if (!existsSync(HOST_SCRIPT)) throw new Error(`missing server host double: ${HOST_SCRIPT}`);

/**
 * The REAL inference host bundle, built by the REAL build script, into a
 * directory only this file uses.
 *
 * Built here rather than reused from `apps/desktop/build` because
 * `tests/desktop-host-split.test.ts` runs the same script against that
 * location and the script starts by deleting it — two vitest workers, one
 * directory, and a fork of a file that is being rewritten. `CHATTERANG_BUILD_OUT`
 * is read by the shipped script for exactly this, so what runs below is still
 * the bundle the app ships and not a description of one.
 *
 * INSIDE THE REPO, not in a tmpdir, and that was measured rather than assumed.
 * The first version of this built into `os.tmpdir()`, and the ONNX host then
 * answered `{providers: [], simulated: false}`: `node-llama-cpp` and
 * `onnxruntime-node` are deliberately EXTERNAL to this bundle, so they resolve
 * by walking up from the bundle's own directory — which outside the repo finds
 * no `node_modules` at all. The host still ran, still answered, and still said
 * it was not simulating. See the assertion below for what that means.
 */
const BUILD_OUT = resolve(process.cwd(), 'apps/desktop/build.server-test');
execFileSync('node', ['scripts/build.mjs'], {
  cwd: resolve(process.cwd(), 'apps/desktop'),
  env: { ...process.env, CHATTERANG_BUILD_OUT: BUILD_OUT },
  stdio: 'pipe',
});
const BUILT_HOST = join(BUILD_OUT, 'host.mjs');
if (!existsSync(BUILT_HOST)) throw new Error(`the desktop build produced no host.mjs in ${BUILD_OUT}`);

/* ── A bundle on disk, built from the repo's own index.html ───────────── */

/**
 * The REAL `index.html`, not a fixture of one.
 *
 * The document transforms this file asserts — the font links removed, the
 * bootstrap injected before the module script, the `img-src` meta left alone —
 * are only worth anything against the markup the app actually ships. A fixture
 * would keep passing after someone added a third-party script tag to the real
 * one, which is the drift these assertions exist to catch.
 */
function makeBundle(): { root: string; outsideName: string } {
  const parent = mkdtempSync(join(tmpdir(), 'chatterang-serve-'));
  const root = join(parent, 'bundle');
  mkdirSync(join(root, 'assets'), { recursive: true });
  copyFileSync(resolve(process.cwd(), 'index.html'), join(root, 'index.html'));
  writeFileSync(join(root, 'assets', 'app.js'), 'export const marker = "asset-body";\n');
  // A file the server must never serve, one directory OUTSIDE the bundle root
  // — so the traversal assertion is about a real file that really exists,
  // rather than about a 404 that would have happened anyway.
  writeFileSync(join(parent, 'outside.txt'), 'OUTSIDE-THE-BUNDLE\n');
  return { root, outsideName: 'outside.txt' };
}

/* ── A tiny http client, because jsdom's fetch is not the thing under test ── */

interface Answer {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

function send(
  options: {
    port: number;
    path: string;
    method?: string;
    headers?: Record<string, string>;
    tls?: boolean;
    host?: string;
  },
  body?: string,
): Promise<Answer> {
  return new Promise((resolvePromise, reject) => {
    const call = options.tls === true ? httpsRequest : httpRequest;
    const req = call(
      {
        host: options.host ?? '127.0.0.1',
        port: options.port,
        path: options.path,
        method: options.method ?? 'GET',
        headers: options.headers ?? {},
        // A self-signed certificate generated by this test: the handshake is
        // real, the trust anchor is not the point.
        rejectUnauthorized: false,
      },
      (response: IncomingMessage) => {
        let text = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => {
          text += chunk;
        });
        response.on('end', () =>
          resolvePromise({ status: response.statusCode ?? 0, headers: response.headers, body: text }),
        );
      },
    );
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

/** One live event stream, and everything that arrived on it. */
interface Stream {
  sessionId: string;
  frames: Record<string, unknown>[];
  /** Resolve once `predicate` is satisfied, or reject after `ms`. */
  waitFor(predicate: (frames: Record<string, unknown>[]) => boolean, ms?: number): Promise<void>;
  close(): void;
}

function openStream(port: number, headers: Record<string, string> = {}, tls = false): Promise<Stream> {
  return new Promise((resolvePromise, reject) => {
    const call = tls ? httpsRequest : httpRequest;
    const req = call(
      {
        host: '127.0.0.1',
        port,
        path: EVENTS_PATH,
        method: 'GET',
        headers,
        rejectUnauthorized: false,
      },
      (response: IncomingMessage) => {
        if (response.statusCode !== 200) {
          reject(new Error(`event stream refused: ${String(response.statusCode)}`));
          return;
        }
        const frames: Record<string, unknown>[] = [];
        let buffer = '';
        let settled = false;
        const stream: Stream = {
          sessionId: '',
          frames,
          waitFor: (predicate, ms = 2_000) =>
            new Promise<void>((done, fail) => {
              const started = Date.now();
              const poll = setInterval(() => {
                if (predicate(frames)) {
                  clearInterval(poll);
                  done();
                } else if (Date.now() - started > ms) {
                  clearInterval(poll);
                  fail(new Error(`timed out; frames so far: ${JSON.stringify(frames)}`));
                }
              }, 5);
            }),
          close: () => {
            req.destroy();
          },
        };
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => {
          buffer += chunk;
          let cut = buffer.indexOf('\n\n');
          while (cut !== -1) {
            const block = buffer.slice(0, cut);
            buffer = buffer.slice(cut + 2);
            cut = buffer.indexOf('\n\n');
            if (!block.startsWith('data: ')) continue;
            const frame = JSON.parse(block.slice('data: '.length)) as Record<string, unknown>;
            frames.push(frame);
            if (frame['k'] === 'session' && !settled) {
              settled = true;
              stream.sessionId = String(frame['id']);
              resolvePromise(stream);
            }
          }
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

/* ── The harness ──────────────────────────────────────────────────────── */

interface Harness {
  server: RunningServer;
  pluginHost: PluginHost;
  fleet: HostFleet;
  children: ChildProcess[];
}

const running: Harness[] = [];

afterEach(() => {
  for (const harness of running.splice(0)) {
    harness.fleet.dispose();
    void harness.server.close();
    for (const child of harness.children) child.kill('SIGKILL');
  }
});

async function stand(options: { tls?: { key: string; cert: string } } = {}): Promise<
  Harness & { bundleRoot: string; token: string }
> {
  const children: ChildProcess[] = [];
  const spawn = (): HostHandle => {
    const child = fork(HOST_SCRIPT, [], { serialization: 'advanced', stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    children.push(child);
    let exited = false;
    child.once('exit', () => {
      exited = true;
    });
    return {
      link: {
        postMessage: (message) => {
          if (child.connected) child.send(message as object);
        },
        onMessage: (listener) => {
          child.on('message', (message: unknown) => listener(message));
        },
        onClose: (listener) => {
          child.once('exit', () => listener('exit'));
        },
      },
      kill: () => {
        if (!exited) child.kill();
      },
    };
  };

  let sessions: RunningServer['sessions'] | undefined;
  const pluginHost = new PluginHost(
    (senderId, payload) => sessions?.deliver(senderId, payload) ?? false,
    'server',
  );
  const fleet = new HostFleet({
    spawn,
    entries: [{ engine: LLAMA_ENGINE, host: 'llama' }],
    notify: (plugin, event, data, ownerId) =>
      pluginHost.notifyListeners(plugin, event, data, ownerId),
    timers: systemTimers(),
  });
  pluginHost.register(LLAMA_PLUGIN, fleet.plugin(LLAMA_PLUGIN.name));

  const bundle = makeBundle();
  const token = generateToken();
  const binding =
    options.tls === undefined
      ? ({ kind: 'loopback', port: 0 } as const)
      : ({
          kind: 'authenticated',
          host: '127.0.0.1',
          port: 0,
          tls: asTlsMaterial(options.tls.key, options.tls.cert),
          token,
        } as const);

  const server = await startServer({
    binding,
    bundleRoot: bundle.root,
    pluginHost,
    release: (senderId, reason) => fleet.releaseRenderer(senderId, reason),
    log: () => undefined,
  });
  sessions = server.sessions;

  const harness: Harness = { server, pluginHost, fleet, children };
  running.push(harness);
  return { ...harness, bundleRoot: bundle.root, token: token.value };
}

/** Call the RPC route the way the served bootstrap does. */
async function rpc(
  port: number,
  sessionId: string | undefined,
  body: unknown,
  extra: Record<string, string> = {},
  tls = false,
): Promise<Answer> {
  const headers: Record<string, string> = { 'content-type': 'application/json', ...extra };
  if (sessionId !== undefined) headers[SESSION_HEADER] = sessionId;
  return send({ port, path: RPC_PATH, method: 'POST', headers, tls }, JSON.stringify(body));
}

/* ── The bundle ───────────────────────────────────────────────────────── */

describe('the served bundle', () => {
  it('serves index.html with the bootstrap in front of the app bundle', async () => {
    const { server } = await stand();
    const answer = await send({ port: server.port, path: '/' });

    expect(answer.status).toBe(200);
    expect(answer.headers['content-type']).toContain('text/html');

    const bootstrapAt = answer.body.indexOf(BOOTSTRAP_PATH);
    const moduleAt = answer.body.indexOf('type="module"');
    expect(bootstrapAt).toBeGreaterThan(-1);
    expect(moduleAt).toBeGreaterThan(-1);
    // ORDER, not presence. `@capacitor/core` reads its globals once, while the
    // app bundle is evaluating; a bootstrap that loads after it is a bootstrap
    // that does nothing at all, and the page falls through to the development
    // plugin shims that synthesise text.
    expect(bootstrapAt).toBeLessThan(moduleAt);
  });

  it('serves a document that reaches nothing off this machine', async () => {
    const { server } = await stand();
    const answer = await send({ port: server.port, path: '/' });

    // The source document DOES link Google Fonts — otherwise this assertion
    // would be vacuous, so it is checked rather than assumed.
    expect(readFileSync(resolve(process.cwd(), 'index.html'), 'utf8')).toContain(
      'fonts.googleapis.com',
    );
    expect(answer.body).not.toContain('fonts.googleapis.com');
    expect(answer.body).not.toContain('fonts.gstatic.com');
    expect(/https?:\/\//.test(answer.body.replace(/<!--[\s\S]*?-->/g, ''))).toBe(false);

    const csp = String(answer.headers['content-security-policy']);
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    // The img-src that closed the one-markdown-image exfiltration is still in
    // the markup, and the header does not widen it.
    expect(answer.body).toContain("img-src 'self' data: blob:");
    expect(csp).toContain("img-src 'self' data: blob:");
    expect(csp).not.toContain('fonts.googleapis.com');
  });

  it('serves an asset, and never serves a file outside the bundle', async () => {
    const { server } = await stand();

    const asset = await send({ port: server.port, path: '/assets/app.js' });
    expect(asset.status).toBe(200);
    expect(asset.body).toContain('asset-body');

    /*
     * The desktop shell's own resolver, over a socket.
     *
     * `%2e%2e` is the form that matters: a WHATWG `URL` normalises a literal
     * `/../x` away before anything sees it, so a test that only sent that form
     * would be asserting against the URL parser rather than against the guard.
     * Percent-encoded dots survive parsing and are decoded by
     * `resolveWithinRoot` itself, which is where the confinement has to hold.
     */
    for (const path of [
      '/%2e%2e/outside.txt',
      '/assets/%2e%2e/%2e%2e/outside.txt',
      '/%2e%2e%2foutside.txt',
    ]) {
      const climb = await send({ port: server.port, path });
      expect(climb.body).not.toContain('OUTSIDE-THE-BUNDLE');
      expect(climb.status).not.toBe(200);
    }
  });

  it('serves the bootstrap script, and it names the server platform', async () => {
    const { server } = await stand();
    const answer = await send({ port: server.port, path: BOOTSTRAP_PATH });

    expect(answer.status).toBe(200);
    expect(answer.headers['content-type']).toContain('text/javascript');
    expect(answer.body).toContain('CapacitorCustomPlatform');
    expect(answer.body).toContain('"server"');
    expect(answer.body).toContain('PluginHeaders');
    // The manifest travels in the script, which is what lets `registerPlugin`
    // resolve synchronously with no round trip.
    expect(answer.body).toContain('LlamaCpp');
  });
});

/* ── The reachable surface ────────────────────────────────────────────── */

describe('what a peer can reach', () => {
  it('is exactly the registered plugins, and refuses everything else by name', async () => {
    const { server } = await stand();
    const stream = await openStream(server.port);

    /*
     * MEASURED, AND IT REFUSES ONE STEP EARLIER THAN EXPECTED.
     *
     * `PluginHost.invoke` has a coded `UNKNOWN_PLUGIN` rejection, and the
     * first version of this test asserted that code. What actually comes back
     * is the ROUTER's refusal — "no handler for channel …" — because
     * `createMainRouter` builds its channel table from the manifest and a
     * plugin the manifest does not contain has no key in it. The call never
     * reaches the plugin host at all, which is the stronger of the two
     * refusals and the one worth pinning: a name the server does not serve is
     * not a name that gets as far as being looked up in an implementation.
     */
    const shell = await rpc(server.port, stream.sessionId, {
      k: 'invoke',
      plugin: 'Shell',
      method: 'exec',
      args: [{ command: 'ls' }],
    });
    expect(shell.status).toBe(200);
    const shellResult = JSON.parse(shell.body) as { ok: boolean; data?: unknown; error: { message: string } };
    expect(shellResult.ok).toBe(false);
    expect(shellResult.data).toBeUndefined();
    expect(shellResult.error.message).toContain('no handler for channel');

    // An undeclared method on a plugin that IS registered, refused the same
    // way and for the same reason.
    const undeclared = await rpc(server.port, stream.sessionId, {
      k: 'invoke',
      plugin: 'LlamaCpp',
      method: 'readFile',
      args: [],
    });
    expect(JSON.parse(undeclared.body)).toMatchObject({ ok: false });

    // And the manifest the page is handed names exactly what is registered,
    // which is where "the shell is not exposed" stops being a promise about
    // intent: there is no row for it.
    const bootstrap = await send({ port: server.port, path: BOOTSTRAP_PATH });
    const names = [...bootstrap.body.matchAll(/"name":"([A-Za-z]+)","methods"/g)].map((m) => m[1]);
    expect(names).toEqual(['LlamaCpp']);
    expect(bootstrap.body).not.toContain('Shell');

    stream.close();
  });

  it('refuses a call with no session, however well formed', async () => {
    const { server } = await stand();

    const anonymous = await rpc(server.port, undefined, {
      k: 'invoke',
      plugin: 'LlamaCpp',
      method: 'getCapabilities',
      args: [],
    });
    expect(anonymous.status).toBe(401);

    // A guessed id is not a session either — this is the fault injection for
    // the assertion above: without it, "401" could mean the route is simply
    // broken for everyone.
    const guessed = await rpc(server.port, 'f'.repeat(32), {
      k: 'invoke',
      plugin: 'LlamaCpp',
      method: 'getCapabilities',
      args: [],
    });
    expect(guessed.status).toBe(401);

    const stream = await openStream(server.port);
    const real = await rpc(server.port, stream.sessionId, {
      k: 'invoke',
      plugin: 'LlamaCpp',
      method: 'getCapabilities',
      args: [],
    });
    expect(real.status).toBe(200);
    stream.close();
  });

  it('refuses a cross-origin caller even with a valid session', async () => {
    const { server } = await stand();
    const stream = await openStream(server.port);

    const foreign = await rpc(
      server.port,
      stream.sessionId,
      { k: 'invoke', plugin: 'LlamaCpp', method: 'getCapabilities', args: [] },
      { origin: 'https://evil.example' },
    );
    expect(foreign.status).toBe(403);

    const own = await rpc(
      server.port,
      stream.sessionId,
      { k: 'invoke', plugin: 'LlamaCpp', method: 'getCapabilities', args: [] },
      { origin: `http://127.0.0.1:${server.port}` },
    );
    expect(own.status).toBe(200);

    // And the event stream itself, which is where a session id would be
    // stolen from if a cross-origin page could open one.
    await expect(openStream(server.port, { origin: 'https://evil.example' })).rejects.toThrow(
      /403/,
    );

    stream.close();
  });
});

/* ── The whole path: browser -> socket -> bridge -> child process ─────── */

describe('a call across the wire', () => {
  it('reaches a real forked inference host and comes back', async () => {
    const { server } = await stand();
    const stream = await openStream(server.port);

    const answer = await rpc(server.port, stream.sessionId, {
      k: 'invoke',
      plugin: 'LlamaCpp',
      method: 'getCapabilities',
      args: [],
    });

    const result = JSON.parse(answer.body) as { ok: boolean; data: { pid: number; method: string } };
    expect(result.ok).toBe(true);
    expect(result.data.method).toBe('getCapabilities');
    // A different process answered: the pid is not this one's.
    expect(result.data.pid).toBeGreaterThan(0);
    expect(result.data.pid).not.toBe(process.pid);

    stream.close();
  });

  it('streams one peer its own tokens, and gives the other peer none', async () => {
    const { server, pluginHost } = await stand();
    const alice = await openStream(server.port);
    const bob = await openStream(server.port);
    expect(alice.sessionId).not.toBe(bob.sessionId);

    // Both peers subscribe to the same event on the same plugin.
    for (const peer of [alice, bob]) {
      const subscribed = await rpc(server.port, peer.sessionId, {
        k: 'addListener',
        plugin: 'LlamaCpp',
        event: 'llamaToken',
        subscriptionId: 1,
      });
      expect(JSON.parse(subscribed.body)).toMatchObject({ ok: true });
    }
    expect(pluginHost.subscriptionCount()).toBe(2);

    // Alice generates. The host double emits two llamaToken events carrying
    // her requestId, then the terminal event.
    const generated = await rpc(server.port, alice.sessionId, {
      k: 'invoke',
      plugin: 'LlamaCpp',
      method: 'generate',
      args: [{ requestId: 'alice-1', messages: [] }],
    });
    expect(JSON.parse(generated.body)).toMatchObject({ ok: true });

    await alice.waitFor((frames) => frames.filter((f) => f['k'] === 'event').length >= 2);
    const tokens = alice.frames.filter((f) => f['eventName'] === 'llamaToken');
    expect(tokens.length).toBe(2);
    expect((tokens[0]?.['data'] as { requestId: string }).requestId).toBe('alice-1');

    // THE CLAIM. Bob subscribed to the same event and received none of it.
    expect(bob.frames.filter((f) => f['k'] === 'event')).toEqual([]);

    /*
     * THE FAULT INJECTION FOR THAT CLAIM. "Bob received nothing" is exactly
     * what a broken stream also looks like, so the same subscription is now
     * asked to carry something that genuinely belongs to nobody:
     * `llamaThermal` describes the machine, has no requestId, and is
     * broadcast. If Bob's connection were simply dead this would fail.
     */
    await rpc(server.port, bob.sessionId, {
      k: 'addListener',
      plugin: 'LlamaCpp',
      event: 'llamaThermal',
      subscriptionId: 2,
    });
    await rpc(server.port, bob.sessionId, {
      k: 'invoke',
      plugin: 'LlamaCpp',
      method: 'getThermalState',
      args: [],
    });
    await bob.waitFor((frames) => frames.some((f) => f['eventName'] === 'llamaThermal'));

    alice.close();
    bob.close();
  });

  it('releases a peer when its stream closes', async () => {
    const { server, pluginHost } = await stand();
    const peer = await openStream(server.port);

    await rpc(server.port, peer.sessionId, {
      k: 'addListener',
      plugin: 'LlamaCpp',
      event: 'llamaToken',
      subscriptionId: 1,
    });
    expect(pluginHost.subscriptionCount()).toBe(1);
    expect(server.sessions.size).toBe(1);

    peer.close();
    await new Promise((done) => setTimeout(done, 100));

    // The subscription is gone, the session is gone, and a call made with the
    // dead session id is refused — which is what makes this a release rather
    // than a leak with a tidy counter.
    expect(server.sessions.size).toBe(0);
    expect(pluginHost.subscriptionCount()).toBe(0);
    const afterwards = await rpc(server.port, peer.sessionId, {
      k: 'invoke',
      plugin: 'LlamaCpp',
      method: 'getCapabilities',
      args: [],
    });
    expect(afterwards.status).toBe(401);
  });
});

/* ── Auth, over a real TLS handshake ──────────────────────────────────── */

function opensslAvailable(): boolean {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function selfSigned(): { key: string; cert: string } {
  const dir = mkdtempSync(join(tmpdir(), 'chatterang-tls-'));
  const keyPath = join(dir, 'key.pem');
  const certPath = join(dir, 'cert.pem');
  execFileSync(
    'openssl',
    ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyPath, '-out', certPath, '-days', '1', '-subj', '/CN=localhost'],
    { stdio: 'ignore' },
  );
  return { key: readFileSync(keyPath, 'utf8'), cert: readFileSync(certPath, 'utf8') };
}

describe.runIf(opensslAvailable())('the authenticated binding', () => {
  it('refuses every route without the token, and adopts it exactly once', async () => {
    const material = selfSigned();
    const { server, token } = await stand({ tls: material });
    const port = server.port;

    // Gate 1 covers the ASSETS, not only the API. An anonymous peer does not
    // get the bundle either.
    const anonymous = await send({ port, path: '/', tls: true });
    expect(anonymous.status).toBe(401);
    expect(anonymous.body).not.toContain('<html');

    const anonymousRpc = await rpc(port, undefined, { k: 'invoke' }, {}, true);
    expect(anonymousRpc.status).toBe(401);

    // A wrong token is refused. Without this the 200 below could mean the
    // check passes anything.
    const wrong = await send({ port, path: `/?${TOKEN_QUERY}=${'x'.repeat(43)}`, tls: true });
    expect(wrong.status).toBe(401);

    // The real one is adopted: a redirect that sets a cookie and drops the
    // secret out of the URL.
    const adopt = await send({ port, path: `/?${TOKEN_QUERY}=${token}`, tls: true });
    expect(adopt.status).toBe(303);
    expect(String(adopt.headers['location'])).toBe('/');
    const cookie = String(adopt.headers['set-cookie']);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('SameSite=Strict');

    const withCookie = await send({
      port,
      path: '/',
      tls: true,
      headers: { cookie: cookie.split(';')[0] ?? '' },
    });
    expect(withCookie.status).toBe(200);
    expect(withCookie.body).toContain('<html');

    // And the secret is not in anything the server hands out.
    expect(withCookie.body).not.toContain(token);
    const bootstrap = await send({
      port,
      path: BOOTSTRAP_PATH,
      tls: true,
      headers: { cookie: cookie.split(';')[0] ?? '' },
    });
    expect(bootstrap.body).not.toContain(token);
  });
});

/* ── The headless host, against the real built bundle ─────────────────── */

describe('the built inference host, run headless', () => {
  it('still refuses to start with no parent link at all', async () => {
    const { status, stderr } = spawnPlain([BUILT_HOST, mkdtempSync(join(tmpdir(), 'm-')), 'llama']);
    // The guard that was the ONLY Electron-shaped thing in the host path is
    // still a guard: a process with neither `parentPort` nor `send` refuses.
    expect(status).toBe(1);
    expect(stderr).toContain('no parent link');
  });

  it('runs the real ONNX engine under a plain Node fork and answers a real call', async () => {
    const child = fork(BUILT_HOST, [mkdtempSync(join(tmpdir(), 'models-')), 'onnx'], {
      serialization: 'advanced',
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    try {
      const answer = await new Promise<Record<string, unknown>>((done, fail) => {
        const timer = setTimeout(() => fail(new Error('the headless host never answered')), 60_000);
        child.on('message', (message: unknown) => {
          const wire = message as { k?: string; id?: number; data?: Record<string, unknown> };
          if (wire.k !== 'ret' || wire.id !== 1) return;
          clearTimeout(timer);
          done(wire as Record<string, unknown>);
        });
        child.send({ k: 'call', id: 1, plugin: 'OnnxRuntime', method: 'getExecutionProviders', args: [] });
      });

      expect(answer['ok']).toBe(true);
      const data = answer['data'] as { providers: string[]; simulated: boolean };
      /*
       * BOTH HALVES, AND THE SECOND ONE IS NOT DECORATION.
       *
       * `simulated: false` is the claim this milestone most needs to be true —
       * the failure it must never ship is a served deployment streaming
       * convincing output from a development shim. But `simulated` alone does
       * NOT establish that the native addon loaded. Measured, by accident,
       * while building this bundle into a directory outside the repo: the host
       * answered `{providers: [], simulated: false}` — a real host, a real
       * process, an honest `simulated` flag, and no execution providers at all,
       * because the external `onnxruntime-node` could not be resolved from
       * there.
       *
       * So the non-empty provider list is the half that says the addon is
       * really there, and it is asserted because the empty case was seen.
       */
      expect(data.simulated).toBe(false);
      expect(data.providers.length).toBeGreaterThan(0);
      expect(data.providers).toContain('cpu');
    } finally {
      child.kill('SIGKILL');
    }
  }, 90_000);
});

/** Run a node script to completion and report its exit code. */
function spawnPlain(args: string[]): { status: number | null; stderr: string } {
  const result = spawnSync(process.execPath, args, { encoding: 'utf8' });
  return { status: result.status, stderr: `${result.stderr}${result.stdout}` };
}
