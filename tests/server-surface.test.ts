/**
 * THE FOUR PLUGINS THAT ARE ON, THE NINE THAT ARE NOT, AND WHAT ONE PEER SEES
 * OF ANOTHER — over a real socket, against the REAL registration.
 *
 * ── WHY THIS FILE EXISTS ────────────────────────────────────────────────
 *
 * The second mandatory mutation came back MISSED: turning a supposedly-off
 * surface back on left the whole suite green. That was not bad luck.
 * `tests/server.test.ts` asserts "the manifest names exactly LlamaCpp" against
 * a `PluginHost` the TEST populated with one plugin — a true statement about
 * the test's own fixture and no statement at all about the server. The real
 * registration lived inline in `apps/server/src/main.ts`, an entry point that
 * runs `main()` at module scope, forks two children and requires a built
 * bundle on disk, so nothing has ever executed it.
 *
 * `apps/server/src/surface.ts` is the fix, and this is what drives it: the
 * same `registerServerSurface` the server calls, on a real `PluginHost`,
 * behind a real port, probed with real requests.
 *
 * ── WHAT IS FAKED AND WHAT IS NOT ───────────────────────────────────────
 *
 *   NOT faked  the http server, the sockets, the SSE stream, the bundle on
 *              disk, `PluginHost`, `createMainRouter`, the channel table, the
 *              REAL `createFilesystemPlugin` over a real tmpdir, and the real
 *              `servedUri` renderer the shipped server passes it.
 *   Faked      what llama.cpp and ONNX compute. `tests/server.test.ts` is
 *              where a call reaches a forked host; nothing here needs one, and
 *              two child processes per case would buy only minutes.
 */

import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import type { IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { LLAMA_METHODS, LLAMA_PLUGIN, ONNX_METHODS, PluginHost } from '@chatterang/desktop/bridge';
import type { PluginImplementation } from '@chatterang/desktop/bridge';
import { createFilesystemPlugin } from '@chatterang/desktop/fs/filesystem';
import { confineModelPath } from '@chatterang/desktop/security';
import { confineRealPath } from '@chatterang/desktop/host/real-path';
import {
  BOOTSTRAP_PATH,
  EVENTS_PATH,
  OFF_SURFACES,
  RPC_PATH,
  SERVER_PLUGINS,
  SESSION_HEADER,
  TOKEN_COOKIE,
  assertServerSurface,
  generateToken,
  registerServerSurface,
  servedUri,
  startServer,
} from '@chatterang/server';
import type { RunningServer } from '@chatterang/server';

/* ── A machine to serve from ──────────────────────────────────────────── */

interface Roots {
  readonly data: string;
  readonly cache: string;
  readonly models: string;
}

/**
 * The shipped layout, made for real.
 *
 * `<root>/files/data`, `<root>/files/data/models`, `<root>/files/cache` — the
 * containment matters and is the reason the model root is not a sibling: see
 * `apps/server/src/main.ts`. Realpath'd once, because on macOS `/tmp` is a
 * symlink to `/private/tmp` and `confineRealPath` compares resolved paths.
 */
function makeRoots(): Roots {
  const root = mkdtempSync(join(tmpdir(), 'chatterang-surface-'));
  const data = join(root, 'files', 'data');
  const cache = join(root, 'files', 'cache');
  const models = join(data, 'models');
  for (const directory of [data, cache, models]) mkdirSync(directory, { recursive: true });
  return { data: realpathSync(data), cache: realpathSync(cache), models: realpathSync(models) };
}

function makeBundle(): string {
  const parent = mkdtempSync(join(tmpdir(), 'chatterang-surface-bundle-'));
  const root = join(parent, 'bundle');
  mkdirSync(root, { recursive: true });
  copyFileSync(resolve(process.cwd(), 'index.html'), join(root, 'index.html'));
  return root;
}

/** Every declared method, answered with the name it was called by. */
function echoPlugin(methods: readonly string[]): PluginImplementation {
  const implementation: Record<string, (...args: readonly unknown[]) => unknown> = {};
  for (const method of methods) {
    implementation[method] = (...args: readonly unknown[]): unknown => ({ method, args });
  }
  return implementation;
}

interface Stood {
  readonly server: RunningServer;
  readonly host: PluginHost;
  readonly roots: Roots;
  readonly cookie: string;
}

const open: RunningServer[] = [];
afterEach(() => {
  for (const server of open.splice(0)) void server.close();
});

/**
 * The server, standing on the REAL registration.
 *
 * `registerServerSurface` is what `main.ts` calls, with the same four fields.
 * Swapping the two engine implementations for echoes changes what a call
 * COMPUTES and nothing about which calls are reachable, which is the only
 * thing this file measures. The filesystem is not swapped: it is the shipped
 * plugin over a real directory, because half of what is measured here is what
 * it hands back.
 */
async function stand(extra?: PluginImplementation): Promise<Stood> {
  const roots = makeRoots();
  // The SHIPPED wiring: `main.ts` gives `PluginHost` a delivery function that
  // forwards to the registry `startServer` creates, so an event notified here
  // travels the real path to a real socket. A stub that answered false would
  // make every isolation claim below unfalsifiable.
  let sessions: RunningServer['sessions'] | undefined;
  const host = new PluginHost(
    (senderId, payload) => sessions?.deliver(senderId, payload) ?? false,
    'server',
  );
  registerServerSurface(host, {
    llama: echoPlugin(LLAMA_METHODS),
    onnx: echoPlugin(ONNX_METHODS),
    filesystem: createFilesystemPlugin({
      roots: new Map([
        ['DATA', roots.data],
        ['CACHE', roots.cache],
      ]),
      renderUri: servedUri(roots),
    }),
    dsh: echoPlugin(['getStatus', 'listProviders']),
  });
  if (extra !== undefined) {
    // THE FAULT INJECTION, wired in the same place a real fifth registration
    // would be: after the surface, on the same host, by a caller that thought
    // it was adding a feature.
    host.register({ name: 'Shell', methods: ['exec'], events: [] }, extra);
  }

  const token = generateToken();
  const server = await startServer({
    binding: { kind: 'loopback', port: 0, token },
    bundleRoot: makeBundle(),
    pluginHost: host,
    release: (senderId) => host.releaseSender(senderId),
    log: () => undefined,
  });
  sessions = server.sessions;
  open.push(server);
  return {
    server,
    host,
    roots,
    cookie: `${TOKEN_COOKIE}=${encodeURIComponent(token.value)}`,
  };
}

/* ── A client ─────────────────────────────────────────────────────────── */

interface Answer {
  status: number;
  body: string;
}

function send(
  stood: Stood,
  path: string,
  options: { method?: string; headers?: Record<string, string>; anonymous?: true } = {},
  body?: string,
): Promise<Answer> {
  return new Promise((done, fail) => {
    const request = httpRequest(
      {
        host: '127.0.0.1',
        port: stood.server.port,
        path,
        method: options.method ?? 'GET',
        headers:
          options.anonymous === true
            ? { ...options.headers }
            : { cookie: stood.cookie, ...options.headers },
      },
      (response: IncomingMessage) => {
        let text = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => {
          text += chunk;
        });
        response.on('end', () => done({ status: response.statusCode ?? 0, body: text }));
      },
    );
    request.on('error', fail);
    if (body !== undefined) request.write(body);
    request.end();
  });
}

/** One live event stream: its session id, and every frame that arrived. */
interface Peer {
  sessionId: string;
  frames: Record<string, unknown>[];
  waitFor(predicate: (frames: Record<string, unknown>[]) => boolean, ms?: number): Promise<void>;
  close(): void;
}

function connect(stood: Stood): Promise<Peer> {
  return new Promise((done, fail) => {
    const request = httpRequest(
      {
        host: '127.0.0.1',
        port: stood.server.port,
        path: EVENTS_PATH,
        method: 'GET',
        headers: { cookie: stood.cookie },
      },
      (response: IncomingMessage) => {
        if (response.statusCode !== 200) {
          fail(new Error(`event stream refused: ${String(response.statusCode)}`));
          return;
        }
        const frames: Record<string, unknown>[] = [];
        const peer: Peer = {
          sessionId: '',
          frames,
          waitFor: (predicate, ms = 2_000) =>
            new Promise<void>((met, missed) => {
              const started = Date.now();
              const poll = setInterval(() => {
                if (predicate(frames)) {
                  clearInterval(poll);
                  met();
                } else if (Date.now() - started > ms) {
                  clearInterval(poll);
                  missed(new Error(`timed out; frames so far: ${JSON.stringify(frames)}`));
                }
              }, 5);
            }),
          close: () => request.destroy(),
        };
        let buffer = '';
        let settled = false;
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => {
          buffer += chunk;
          for (let cut = buffer.indexOf('\n\n'); cut !== -1; cut = buffer.indexOf('\n\n')) {
            const block = buffer.slice(0, cut);
            buffer = buffer.slice(cut + 2);
            if (!block.startsWith('data: ')) continue;
            const frame = JSON.parse(block.slice('data: '.length)) as Record<string, unknown>;
            frames.push(frame);
            if (frame['k'] === 'session' && !settled) {
              settled = true;
              peer.sessionId = String(frame['id']);
              done(peer);
            }
          }
        });
      },
    );
    request.on('error', (error) => {
      if ((error as { code?: string }).code !== 'ECONNRESET') fail(error);
    });
    request.end();
  });
}

async function call(stood: Stood, peer: Peer, body: unknown): Promise<{ ok: boolean; data?: unknown; error?: { message: string } }> {
  const answer = await send(
    stood,
    RPC_PATH,
    { method: 'POST', headers: { 'content-type': 'application/json', [SESSION_HEADER]: peer.sessionId } },
    JSON.stringify(body),
  );
  expect(answer.status).toBe(200);
  return JSON.parse(answer.body) as { ok: boolean; data?: unknown; error?: { message: string } };
}

const invoke = (plugin: string, method: string, ...args: unknown[]): unknown => ({
  k: 'invoke',
  plugin,
  method,
  args,
});

/* ── What is on ───────────────────────────────────────────────────────── */

describe('the surface the shipped registration puts on the wire', () => {
  it('is exactly four plugins, named by the manifest the page is handed', async () => {
    const stood = await stand();
    const bootstrap = await send(stood, BOOTSTRAP_PATH);
    expect(bootstrap.status).toBe(200);

    const names = [...bootstrap.body.matchAll(/"name":"([A-Za-z]+)","methods"/g)].map((m) => m[1]);
    expect(names).toEqual(['LlamaCpp', 'OnnxRuntime', 'Filesystem', 'DshHost']);
    // And the list in `surface.ts` is what that came from, rather than a
    // second spelling of it that could drift.
    expect(names).toEqual(SERVER_PLUGINS.map((plugin) => plugin.name));
  });

  it('answers a call to each of the four, so the refusals below mean something', async () => {
    const stood = await stand();
    const peer = await connect(stood);

    for (const [plugin, method] of [
      ['LlamaCpp', 'getCapabilities'],
      ['OnnxRuntime', 'getExecutionProviders'],
      ['DshHost', 'getStatus'],
    ] as const) {
      const answer = await call(stood, peer, invoke(plugin, method));
      expect({ plugin, ok: answer.ok }).toEqual({ plugin, ok: true });
    }

    // Filesystem separately, because it is the real plugin and needs a path.
    const made = await call(stood, peer, invoke('Filesystem', 'mkdir', { path: 'models/llama', directory: 'DATA' }));
    expect(made.ok).toBe(true);

    peer.close();
  });
});

/* ── What is off ──────────────────────────────────────────────────────── */

describe('the ten surfaces that are off', () => {
  it('are refused by the channel table, before any implementation is looked up', async () => {
    const stood = await stand();
    const peer = await connect(stood);

    for (const surface of OFF_SURFACES) {
      const answer = await call(stood, peer, invoke(surface, 'exec', { command: 'ls' }));
      expect({ surface, ok: answer.ok }).toEqual({ surface, ok: false });
      expect(answer.data).toBeUndefined();
      /*
       * THE ROUTER'S REFUSAL, NOT THE PLUGIN HOST'S, AND IT MATTERS WHICH.
       * `PluginHost.invoke` has a coded `UNKNOWN_PLUGIN` rejection; what comes
       * back is one step earlier than that. `createMainRouter` builds its
       * channel table from the manifest, so a plugin with no row has no
       * channel and the call is never looked up in an implementation at all.
       */
      expect(answer.error?.message).toContain('no handler for channel');
      expect(answer.error?.message).toContain(`chatterang:call:${surface}:exec`);
    }

    peer.close();
  });

  it('appear nowhere in the script the page is served', async () => {
    const stood = await stand();
    const bootstrap = await send(stood, BOOTSTRAP_PATH);
    for (const surface of OFF_SURFACES) {
      expect({ surface, present: bootstrap.body.includes(`"${surface}"`) }).toEqual({
        surface,
        present: false,
      });
    }
  });

  it('REFUSES TO BIND A PORT if one of them is registered after all', async () => {
    /*
     * THE FAULT INJECTION FOR THIS WHOLE FILE, and the mutation that came back
     * missed. A fifth `pluginHost.register(SHELL_PLUGIN, …)` — the exact edit
     * someone makes when they want the server to do one more thing — must not
     * be a thing the suite shrugs at.
     *
     * It is asserted as a BOOT FAILURE rather than as a 403, because a refusal
     * at request time is a refusal that has to be got right on every route,
     * and this one has to be got right once. The server never listens.
     */
    await expect(stand({ exec: async () => ({ stdout: '' }) })).rejects.toThrow(
      /refusing to serve a bridge that exposes Shell/,
    );

    // The same rule as a pure function, so the message can be read without a
    // socket: it names what is extra and what the declared set is.
    expect(() =>
      assertServerSurface({
        platform: 'server',
        plugins: [...SERVER_PLUGINS, { name: 'Shell', methods: ['exec'], events: [] }],
      }),
    ).toThrow(/Shell/);

    // AND `Cli` NAMED, EXPLICITLY (#118): a local agent CLI is desktop-only
    // by #115's own ruling, and #42/#112 both turn on it being run on THIS
    // machine's own credentials, reaching a vendor -- exactly the kind of
    // capability a server that merely serves a bundle to a peer must never
    // pick up as a fifth registration.
    expect(() =>
      assertServerSurface({
        platform: 'server',
        plugins: [...SERVER_PLUGINS, { name: 'Cli', methods: ['startTurn', 'cancelTurn'], events: [] }],
      }),
    ).toThrow(/Cli/);
    // And it does NOT refuse a smaller surface: a plugin missing is a
    // functionality problem, not a security one, and only the security one
    // gets to stop the process. See `surface.ts`.
    expect(() => assertServerSurface({ platform: 'server', plugins: [LLAMA_PLUGIN] })).not.toThrow();
  });
});

/* ── What comes back on the success path ──────────────────────────────── */

describe('the uri a served peer is handed', () => {
  it('is the name the loader knows a model by, not this machine s layout', async () => {
    const stood = await stand();
    const peer = await connect(stood);

    await call(stood, peer, invoke('Filesystem', 'mkdir', { path: 'models/llama', directory: 'DATA' }));
    const written = await call(
      stood,
      peer,
      invoke('Filesystem', 'writeFile', { path: 'models/llama/tiny.gguf', directory: 'DATA', data: '' }),
    );
    expect(written.ok).toBe(true);

    const got = await call(
      stood,
      peer,
      invoke('Filesystem', 'getUri', { path: 'models/llama/tiny.gguf', directory: 'DATA' }),
    );
    expect(got.ok).toBe(true);

    for (const [name, answer] of [['writeFile', written], ['getUri', got]] as const) {
      const uri = (answer.data as { uri: string }).uri;
      // THE CLAIM: relative, and containing no part of the server's layout.
      expect({ name, absolute: isAbsolute(uri) }).toEqual({ name, absolute: false });
      expect(uri).not.toContain(stood.roots.data);
      expect(uri).not.toContain(stood.roots.models);
      expect(uri).not.toContain(tmpdir());
      expect(uri).toBe(join('llama', 'tiny.gguf'));
    }

    /*
     * AND IT IS STILL A PATH THE CALLER CAN USE, which is the half that makes
     * this a fix rather than a redaction. `src/lib/download.ts` stores this
     * string and hands it to `LlamaCpp.load`; the host runs it through
     * `confineModelPath` (a `resolve` against the model root) and then
     * `confineRealPath`, and replaces the field with what comes out. Both are
     * the REAL functions here, so this is the load path's own arithmetic.
     */
    const uri = (got.data as { uri: string }).uri;
    const lexical = confineModelPath(stood.roots.models, uri);
    expect(lexical).toBe(join(stood.roots.models, 'llama', 'tiny.gguf'));
    expect(confineRealPath(stood.roots.models, lexical as string)).toBe(lexical);

    peer.close();
  });

  it('still refuses a path outside the roots without echoing it', async () => {
    // The failure path was already careful, and this pins that the success
    // path getting a new shape did not disturb it.
    const stood = await stand();
    const peer = await connect(stood);
    const escaped = await call(
      stood,
      peer,
      invoke('Filesystem', 'getUri', { path: '../../outside.gguf', directory: 'DATA' }),
    );
    expect(escaped.ok).toBe(false);
    expect(escaped.error?.message).toContain('not echoed back');
    expect(escaped.error?.message).not.toContain(tmpdir());
    peer.close();
  });
});

/* ── What one peer sees of another ────────────────────────────────────── */

describe('two browsers pointed at one server', () => {
  it('get distinct sessions, and neither is told anything about the other', async () => {
    const stood = await stand();
    const alice = await connect(stood);
    const bob = await connect(stood);

    expect(alice.sessionId).not.toBe(bob.sessionId);
    expect(alice.sessionId).toMatch(/^[0-9a-f]{32}$/);
    // Nothing on Bob's stream mentions Alice: the id is written to exactly one
    // connection, as its first frame, and there is no route that lists
    // sessions for anyone to ask.
    expect(JSON.stringify(bob.frames)).not.toContain(alice.sessionId);

    alice.close();
    bob.close();
  });

  it('cannot unsubscribe each other, which is the tenancy claim this server makes', async () => {
    const stood = await stand();
    const alice = await connect(stood);
    const bob = await connect(stood);

    for (const peer of [alice, bob]) {
      const subscribed = await call(stood, peer, {
        k: 'addListener',
        plugin: 'LlamaCpp',
        event: 'llamaToken',
        subscriptionId: 1,
      });
      expect(subscribed.ok).toBe(true);
    }
    expect(stood.host.subscriptionCount()).toBe(2);

    /*
     * THE MEASUREMENT. Both peers chose subscription id 1 — a reloaded page
     * restarts its counter, so ids collide across peers by construction — and
     * Bob now asks for ALL of them to be removed. `PluginHost` namespaces the
     * table by sender, so this removes one.
     *
     * The fault injection is the count: without the sender in the key, Bob's
     * `removeAllListeners` takes Alice's subscription with it and this reads
     * 0 rather than 1. "Alice still receives" alone would not distinguish the
     * two, because a broadcast reaches an empty table quietly.
     */
    const removed = await call(stood, bob, { k: 'removeAllListeners', plugin: 'LlamaCpp' });
    expect(removed.ok).toBe(true);
    expect(stood.host.subscriptionCount()).toBe(1);

    // And the one that survived is Alice's. Broadcast — no owner — so this is
    // the most generous case for a leak: it reaches every live subscription,
    // and there is exactly one, on her stream.
    expect(stood.host.notifyListeners('LlamaCpp', 'llamaToken', { requestId: 'a', text: 'x' })).toBe(1);
    await alice.waitFor((frames) => frames.some((frame) => frame['k'] === 'event'));
    expect(bob.frames.filter((frame) => frame['k'] === 'event')).toEqual([]);

    alice.close();
    bob.close();
  });

  it('share the model directory, and this test says so rather than implying otherwise', async () => {
    /*
     * THE HONEST FINDING, MEASURED. `index.ts` says the model directory and
     * the GPU are shared among authenticated peers and that this is a shared
     * machine behaving like one. That is a claim about what a second peer CAN
     * do, so it is asserted rather than left as prose: Bob sees Alice's file
     * and can delete it.
     *
     * It is not a leak of USER data — there is none in this process; chats,
     * personas, provider connections and keys live in each browser's own
     * IndexedDB (`src/db/index.ts`), and the wire carries plugin calls only.
     * It is a leak of MODELS, to peers who all hold the same operator token.
     * Since gate 1 now covers every route, "another peer" means "someone the
     * operator gave the token to", which is a narrower thing than it was when
     * loopback answered anonymously.
     */
    const stood = await stand();
    const alice = await connect(stood);
    const bob = await connect(stood);

    await call(stood, alice, invoke('Filesystem', 'mkdir', { path: 'models/llama', directory: 'DATA' }));
    await call(
      stood,
      alice,
      invoke('Filesystem', 'writeFile', { path: 'models/llama/alice.gguf', directory: 'DATA', data: '' }),
    );
    expect(readFileSync(join(stood.roots.models, 'llama', 'alice.gguf'), 'utf8')).toBe('');

    const bobDeletes = await call(
      stood,
      bob,
      invoke('Filesystem', 'rmdir', { path: 'models/llama', directory: 'DATA', recursive: true }),
    );
    expect(bobDeletes.ok).toBe(true);
    expect(() => readFileSync(join(stood.roots.models, 'llama', 'alice.gguf'), 'utf8')).toThrow();

    alice.close();
    bob.close();
  });

  it('THE TWO REQUESTS FROM THE REPORT, replayed with no token', async () => {
    /*
     * The measurement that started this run, run again against the code that
     * answers it now. Both were made on 127.0.0.1 in two requests with no
     * credential of any kind, and both were answered `{"ok":true}`:
     *
     *   Filesystem.writeFile  arbitrary bytes inside the data root
     *   Filesystem.rmdir      the model directory, recursively
     *
     * This is not a duplicate of `tests/server-auth.test.ts`, which drives the
     * routes on a server with NO plugins registered. Here the real
     * `Filesystem` implementation is registered and confined to a real
     * directory, so the thing being refused is the thing that did the damage,
     * and the file on disk is checked afterwards rather than the status alone.
     */
    const stood = await stand();
    const peer = await connect(stood);
    await call(stood, peer, invoke('Filesystem', 'mkdir', { path: 'models/llama', directory: 'DATA' }));
    await call(
      stood,
      peer,
      invoke('Filesystem', 'writeFile', { path: 'models/llama/real.gguf', directory: 'DATA', data: '' }),
    );
    const model = join(stood.roots.models, 'llama', 'real.gguf');
    expect(readFileSync(model, 'utf8')).toBe('');

    for (const attack of [
      invoke('Filesystem', 'writeFile', { path: 'models/planted.txt', directory: 'DATA', data: '' }),
      invoke('Filesystem', 'rmdir', { path: 'models', directory: 'DATA', recursive: true }),
    ]) {
      // With the session id of a REAL peer, and still no token: the session
      // was the only thing this call ever needed, and it is not enough now.
      const answer = await send(
        stood,
        RPC_PATH,
        {
          anonymous: true,
          method: 'POST',
          headers: { 'content-type': 'application/json', [SESSION_HEADER]: peer.sessionId },
        },
        JSON.stringify(attack),
      );
      expect(answer.status).toBe(401);
      expect(answer.body).not.toContain('"ok":true');
    }

    // Nothing happened on the disk, which is the assertion the status code is
    // standing in for.
    expect(readFileSync(model, 'utf8')).toBe('');
    expect(() => readFileSync(join(stood.roots.models, 'planted.txt'), 'utf8')).toThrow();

    peer.close();
  });

  it('cannot reach anything outside the data root, however they ask', async () => {
    const stood = await stand();
    const peer = await connect(stood);
    const outside = join(stood.roots.data, '..', '..', 'escaped.txt');
    writeFileSync(outside, 'ESCAPED\n');

    for (const path of ['../../escaped.txt', '/etc/hosts', 'models/../../../escaped.txt']) {
      const answer = await call(
        stood,
        peer,
        invoke('Filesystem', 'writeFile', { path, directory: 'DATA', data: '' }),
      );
      expect({ path, ok: answer.ok }).toEqual({ path, ok: false });
    }
    expect(readFileSync(outside, 'utf8')).toBe('ESCAPED\n');

    peer.close();
  });
});
