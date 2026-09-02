/**
 * The request listener: four routes, three gates, and nothing else.
 *
 * ── THE GATES, IN ORDER, AND WHY THAT ORDER ─────────────────────────────
 *
 *   1. TOKEN     — on EVERY route, assets included.
 *   2. ORIGIN    — on the two API routes.
 *   3. SESSION   — on the two API routes.
 *
 * Gate 1 covers the assets deliberately. "An auth layer is only as good as its
 * coverage of the inference routes" is the usual warning and it is the right
 * one, but the converse matters too: gating only the API and serving the
 * bundle to anyone makes the deployment's existence, version and shape public,
 * and gives an attacker the exact client that knows how to drive it. The
 * bundle is not a secret; serving it to an anonymous peer is still a decision,
 * and this server does not make it.
 *
 * Gates 2 and 3 are what make a LOOPBACK binding with no token something other
 * than "unauthenticated". `http://127.0.0.1:8973` is reachable from every page
 * in the operator's browser: any website can POST to it. It cannot READ the
 * response — the same-origin policy still applies — but a side effect does not
 * need a readable response. Two things stop it, and both are needed:
 *
 *   the custom session header forces a CORS preflight, which is answered with
 *   nothing permissive, so the real request is never sent;
 *   the session id is 128 random bits handed out only on the event stream,
 *   which a cross-origin page cannot read.
 *
 * A `<form>` post cannot set a header at all, and a `fetch` that sets one is
 * preflighted. That is the whole defence and it is why `SESSION_HEADER` is
 * documented as a CSRF guard rather than as plumbing.
 *
 * ── WHAT IS NOT HERE ────────────────────────────────────────────────────
 *
 * No CORS allowances, no `Access-Control-Allow-Origin`, no OPTIONS handler
 * that answers anything but a refusal. Adding one is how the two gates above
 * stop working, so their absence is load-bearing rather than unfinished.
 */

import { readFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';

import {
  LISTENER_ADD_CHANNEL,
  LISTENER_REMOVE_ALL_CHANNEL,
  LISTENER_REMOVE_CHANNEL,
  methodChannel,
} from '@chatterang/desktop/bridge';
import type { InvokeResult, MainRouter } from '@chatterang/desktop/bridge';
import { resolveBundleRequest } from '@chatterang/desktop/security';

import { requiresToken } from './binding.js';
import type { ServerBinding } from './binding.js';
import { SERVED_CSP, SECURITY_HEADERS, originAllowed, prepareDocument, readCookie, tokenCookie } from './policy.js';
import type { SessionRegistry } from './sessions.js';
import { tokenMatches } from './token.js';
import {
  BOOTSTRAP_PATH,
  EVENTS_PATH,
  MAX_BODY_BYTES,
  RPC_PATH,
  SESSION_HEADER,
  TOKEN_COOKIE,
  TOKEN_QUERY,
} from './wire.js';

export interface ServerRoutes {
  readonly binding: ServerBinding;
  /** The directory holding the built web bundle — `dist/`, or a copy of it. */
  readonly bundleRoot: string;
  readonly router: MainRouter;
  readonly sessions: SessionRegistry;
  /** The generated bootstrap script, built once at start. */
  readonly bootstrapScript: string;
  /**
   * Origins this deployment knows itself by, from the binding.
   *
   * A SECOND source is consulted per request — see {@link expectedOrigins} —
   * because a binding on port 0, behind a reverse proxy, or reached by a name
   * the operator chose does not know every spelling of itself.
   */
  readonly configuredOrigins: readonly string[];
  /** A peer went away: settle its turns and drop its subscriptions. */
  readonly release: (senderId: number, reason: string) => void;
  readonly log: (line: string) => void;
}

/**
 * Every origin this request may legitimately have come from.
 *
 * THE `Host` HEADER IS THE RELIABLE HALF, and it is not the hole it looks
 * like. Both `Host` and `Origin` are set by the BROWSER on a cross-site
 * request, and the browser sets `Host` to the server it is talking to and
 * `Origin` to the page that asked. A page on `https://evil.example` reaching
 * `http://127.0.0.1:8973` therefore sends `Host: 127.0.0.1:8973` and
 * `Origin: https://evil.example`, and they do not match. An attacker who can
 * forge the `Host` header is not a web page — it is a direct client, which has
 * no cookies and no session id and is refused by the other two gates.
 *
 * Without this the check would be wrong for every deployment whose bound port
 * is not the port it was configured with, which includes `port: 0` and every
 * reverse proxy.
 */
function expectedOrigins(routes: ServerRoutes, hostHeader: string | undefined): readonly string[] {
  if (hostHeader === undefined || hostHeader === '') return routes.configuredOrigins;
  const protocol = routes.binding.kind === 'loopback' ? 'http' : 'https';
  return [...routes.configuredOrigins, `${protocol}://${hostHeader}`];
}

/** Text response with the standard headers. Never carries a secret. */
function refuse(response: ServerResponse, status: number, message: string): void {
  response.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    ...SECURITY_HEADERS,
  });
  response.end(`${message}\n`);
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    ...SECURITY_HEADERS,
  });
  response.end(text);
}

/**
 * Read a body, refusing one that is too large as it arrives.
 *
 * Refused DURING the read, not after: a limit checked on the assembled buffer
 * is a limit that has already been exceeded in memory by the time it fires.
 */
async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    total += buffer.byteLength;
    if (total > MAX_BODY_BYTES) {
      throw new Error(`chatterang server: request body exceeds ${MAX_BODY_BYTES} bytes.`);
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/* ── Gate 1: the token ────────────────────────────────────────────────── */

type TokenVerdict =
  | { readonly k: 'pass' }
  | { readonly k: 'refuse' }
  /** The one-time `?token=` arrived: set the cookie and send them back clean. */
  | { readonly k: 'adopt'; readonly cookie: string; readonly location: string };

/**
 * Decide whether this request carries the operator token.
 *
 * A loopback binding has no token to carry, so this passes everything — the
 * binding TYPE is what guarantees that arm never reached a network address.
 */
export function checkToken(binding: ServerBinding, url: URL, cookieHeader: string | undefined): TokenVerdict {
  if (!requiresToken(binding)) return { k: 'pass' };
  if (tokenMatches(binding.token, readCookie(cookieHeader, TOKEN_COOKIE))) return { k: 'pass' };

  const presented = url.searchParams.get(TOKEN_QUERY);
  if (presented !== null && tokenMatches(binding.token, presented)) {
    const clean = new URL(url);
    clean.searchParams.delete(TOKEN_QUERY);
    return {
      k: 'adopt',
      cookie: tokenCookie(TOKEN_COOKIE, binding.token.value),
      // Path and query only: an absolute Location built from a client-supplied
      // Host header is an open redirect waiting to happen.
      location: `${clean.pathname}${clean.search}`,
    };
  }
  return { k: 'refuse' };
}

/* ── The listener ─────────────────────────────────────────────────────── */

export function createRequestListener(
  routes: ServerRoutes,
): (request: IncomingMessage, response: ServerResponse) => void {
  return (request, response) => {
    void handle(routes, request, response).catch((error: unknown) => {
      // Nothing about the failure reaches the peer beyond a status: an error
      // message from this process can name a path on the operator's disk.
      routes.log(`request failed: ${error instanceof Error ? error.message : String(error)}`);
      if (!response.headersSent) refuse(response, 500, 'Internal error');
      else response.end();
    });
  };
}

async function handle(
  routes: ServerRoutes,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const url = new URL(request.url ?? '/', 'http://placeholder.invalid');
  const method = request.method ?? 'GET';

  // Gate 1, before the route is even looked at.
  const verdict = checkToken(routes.binding, url, request.headers.cookie);
  if (verdict.k === 'refuse') {
    refuse(response, 401, 'Unauthorized');
    return;
  }
  if (verdict.k === 'adopt') {
    response.writeHead(303, {
      location: verdict.location,
      'set-cookie': verdict.cookie,
      ...SECURITY_HEADERS,
    });
    response.end();
    return;
  }

  if (url.pathname === EVENTS_PATH) {
    if (method !== 'GET') return refuse(response, 405, 'Method not allowed');
    if (!originAllowed(request.headers.origin, expectedOrigins(routes, request.headers.host))) {
      return refuse(response, 403, 'Forbidden');
    }
    return openEventStream(routes, request, response);
  }

  if (url.pathname === RPC_PATH) {
    if (method !== 'POST') return refuse(response, 405, 'Method not allowed');
    if (!originAllowed(request.headers.origin, expectedOrigins(routes, request.headers.host))) {
      return refuse(response, 403, 'Forbidden');
    }
    return handleRpc(routes, request, response);
  }

  if (method !== 'GET' && method !== 'HEAD') return refuse(response, 405, 'Method not allowed');

  if (url.pathname === BOOTSTRAP_PATH) {
    response.writeHead(200, {
      'content-type': 'text/javascript; charset=utf-8',
      'cache-control': 'no-store',
      'content-security-policy': SERVED_CSP,
      ...SECURITY_HEADERS,
    });
    response.end(method === 'HEAD' ? undefined : routes.bootstrapScript);
    return;
  }

  return serveAsset(routes, url.pathname, method, response);
}

/* ── Assets ───────────────────────────────────────────────────────────── */

async function serveAsset(
  routes: ServerRoutes,
  pathname: string,
  method: string,
  response: ServerResponse,
): Promise<void> {
  // `resolveBundleRequest` is the desktop shell's resolver, unchanged: it does
  // the `..` confinement, the extensionless -> index.html fallback that makes
  // deep links work in a single-page app, and the content type. Reusing it
  // means the traversal guard `tests/desktop-security.test.ts` drives is the
  // one running here, rather than a second one written from the same idea.
  let target: ReturnType<typeof resolveBundleRequest>;
  try {
    // `resolveWithinRoot` calls `decodeURIComponent`, which THROWS on a
    // malformed escape (`/%zz`). A 500 there would report an internal failure
    // for what is simply a bad path, and a 500 is a thing people investigate.
    target = resolveBundleRequest(routes.bundleRoot, pathname);
  } catch {
    return refuse(response, 400, 'Bad request');
  }
  if (target === null) return refuse(response, 404, 'Not found');

  let body: Buffer;
  try {
    body = await readFile(target.file);
  } catch {
    return refuse(response, 404, 'Not found');
  }

  const isDocument = target.csp !== undefined;
  const payload = isDocument ? Buffer.from(prepareDocument(body.toString('utf8')), 'utf8') : body;

  response.writeHead(200, {
    'content-type': target.contentType,
    'content-length': payload.byteLength,
    // The document carries the served policy — which is the desktop policy
    // minus its two font origins, so a served deployment reaches nothing off
    // this machine. The meta `img-src` in the markup stays as the belt.
    ...(isDocument ? { 'content-security-policy': SERVED_CSP, 'cache-control': 'no-store' } : {}),
    ...SECURITY_HEADERS,
  });
  response.end(method === 'HEAD' ? undefined : payload);
}

/* ── The event stream ─────────────────────────────────────────────────── */

function openEventStream(
  routes: ServerRoutes,
  request: IncomingMessage,
  response: ServerResponse,
): void {
  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    ...SECURITY_HEADERS,
  });

  const session = routes.sessions.open({
    /*
     * `false` MEANS GONE, NOT BUSY — and this is the subtle one.
     *
     * `ServerResponse.write` answers false for BACKPRESSURE: the kernel buffer
     * is full and the caller should wait for `drain`. `EventDelivery` answers
     * false for a renderer that no longer exists, and `PluginHost` responds by
     * DELETING the subscription. Wiring the two together directly would make a
     * fast token stream unsubscribe itself the first time a client read
     * slowly, and the failure would be a generation that stops mid-sentence
     * on exactly the machines too slow to keep up.
     */
    write: (chunk) => {
      if (response.writableEnded || response.destroyed) return false;
      response.write(chunk);
      return true;
    },
  });

  // A comment frame every 15 s. Not decoration: an idle SSE connection through
  // any intermediary is indistinguishable from a dead one, and the first
  // symptom is a page that stops receiving tokens with no error anywhere.
  const heartbeat = setInterval(() => {
    if (!response.writableEnded) response.write(': keep-alive\n\n');
  }, 15_000);
  // The interval must not hold the process open on its own.
  heartbeat.unref?.();

  const finish = (): void => {
    clearInterval(heartbeat);
    const senderId = routes.sessions.close(session.id);
    if (senderId !== undefined) routes.release(senderId, 'the event stream closed');
  };
  request.on('close', finish);
  response.on('close', finish);
}

/* ── The RPC route ────────────────────────────────────────────────────── */

async function handleRpc(
  routes: ServerRoutes,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const header = request.headers[SESSION_HEADER];
  const presented = Array.isArray(header) ? header[0] : header;
  const session = routes.sessions.find(presented);
  if (session === undefined) {
    // 401 rather than 400: a caller without a live session is a caller that
    // has not read the event stream, which is exactly the cross-origin case.
    refuse(response, 401, 'No session');
    return;
  }

  let body: string;
  try {
    body = await readBody(request);
  } catch {
    refuse(response, 413, 'Body too large');
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    refuse(response, 400, 'Malformed body');
    return;
  }

  sendJson(response, 200, await dispatch(routes.router, session.senderId, parsed));
}

/**
 * One wire operation onto one router channel.
 *
 * Every branch ends in `router.handle`, which answers an `InvokeResult` and
 * never rejects — the same contract the Electron side relies on so that a
 * `code` like `HANDLE_LOST` survives the trip. The adapter in
 * `src/ai/backends/llama-cpp.ts` drops its cached handle on that code; lose it
 * and a host restart wedges the client until the page is reloaded.
 */
export async function dispatch(
  router: MainRouter,
  senderId: number,
  message: unknown,
): Promise<InvokeResult> {
  const wire = message as { k?: unknown } | null;
  if (wire === null || typeof wire !== 'object') {
    return { ok: false, error: { message: 'chatterang server: that is not a request.' } };
  }
  switch (wire.k) {
    case 'invoke': {
      const call = wire as unknown as { plugin: string; method: string; args?: readonly unknown[] };
      if (typeof call.plugin !== 'string' || typeof call.method !== 'string') {
        return { ok: false, error: { message: 'chatterang server: a call needs a plugin and a method.' } };
      }
      // The channel is COMPOSED here and then looked up: `handle` refuses any
      // channel that is not a key of the table it built from the manifest, so
      // a plugin or method the manifest never declared cannot become a route.
      return router.handle(senderId, methodChannel(call.plugin, call.method), call.args ?? []);
    }
    case 'addListener': {
      const add = wire as unknown as { plugin: string; event: string; subscriptionId: number };
      return router.handle(senderId, LISTENER_ADD_CHANNEL, {
        pluginName: add.plugin,
        eventName: add.event,
        subscriptionId: Number(add.subscriptionId),
      });
    }
    case 'removeListener': {
      const remove = wire as unknown as { subscriptionId: number };
      return router.handle(senderId, LISTENER_REMOVE_CHANNEL, {
        subscriptionId: Number(remove.subscriptionId),
      });
    }
    case 'removeAllListeners': {
      const all = wire as unknown as { plugin: string };
      return router.handle(senderId, LISTENER_REMOVE_ALL_CHANNEL, { pluginName: all.plugin });
    }
    default:
      return {
        ok: false,
        error: { message: `chatterang server: no operation "${String(wire.k)}".` },
      };
  }
}
