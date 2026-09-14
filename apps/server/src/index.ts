/**
 * `apps/server` — the headless profile, and an explicit account of what it
 * does NOT do.
 *
 * ── WHAT THIS SERVES ────────────────────────────────────────────────────
 *
 * Two things, and they are the whole list: the built web bundle, and the
 * plugin bridge in front of the same two inference hosts the Electron shell
 * runs. `apps/desktop/src/host/entry.ts` needed one change to run headless —
 * it now accepts a Node fork's IPC channel as well as Electron's parent port —
 * and nothing else in the host path knew it was in Electron at all.
 *
 * ── WHAT IT OWNS, WHICH IS ALMOST NOTHING ───────────────────────────────
 *
 * THE SERVER IS STATELESS WITH RESPECT TO USER DATA. Chats, personas, provider
 * connections, API keys, egress grants and blobs live in the connecting
 * browser's IndexedDB, exactly as they do on the web target: `src/db/index.ts`
 * is Dexie over IndexedDB, fifteen modules import it, and its own header says
 * there is no server-side counterpart to any of its tables. Giving the server
 * a database would not be configuration — it would be a rewrite of the state
 * layer plus a tenancy model for every table in it, and this milestone does
 * not pretend to have one.
 *
 * So two browsers pointed at one server are two independent users who happen
 * to share a GPU. That is the honest reading, and it makes three things true
 * that would otherwise need enforcing:
 *
 *   - `liveStores()`/`buildVfs` have no principal to take, and need none: they
 *     project the browser's OWN Dexie tables, in the browser, and nothing they
 *     touch crosses this wire.
 *   - The shell's confirm gate is exactly as sound as it is on the web target
 *     — a person at a keyboard, driving their own data. `actor` is not a field
 *     on this wire; the wire carries plugin calls and nothing else.
 *   - No provider key ever enters this process. The inference host builds its
 *     Router with one local backend and zero remote providers; remote calls
 *     are made by the browser, from the user's own machine, with the user's own
 *     key. The server is not in that path and cannot log what it never sees.
 *
 * ── THE ONE THING IT DOES SHARE, SAID PLAINLY ───────────────────────────
 *
 * The model directory and the GPU. Every authenticated peer sees the same
 * weights, can add to them, and can remove them — `Filesystem` is registered
 * with the desktop implementation confined to the data root, because the
 * alternative is worse rather than smaller: with NO Filesystem plugin
 * registered, `@capacitor/core` falls through to its own web shim and a model
 * download lands in the connecting browser's IndexedDB, where the process with
 * the GPU can never read it. That is eb3a279's bug, and "we left the plugin
 * out to be safe" is how it comes back. Measured, not reasoned: with a custom
 * platform set and no plugin header seeded, `registerPlugin` resolves to the
 * web implementation on every platform id tried.
 *
 * A shared model directory among authenticated operators is a shared machine
 * behaving like a shared machine. It is not tenancy, and it is not described
 * as any.
 *
 * ── WHAT IS OFF, AND HOW OFF IS ENFORCED ────────────────────────────────
 *
 * The reachable surface of this server is the MANIFEST and nothing else:
 * `PluginHost` refuses a plugin name it does not hold and a method the
 * definition does not declare, before touching any implementation. So "the
 * shell is not exposed" is not a promise about intent, it is the absence of a
 * row.
 *
 * Which four rows there are, which nine surfaces are off, and the boot-time
 * refusal that keeps the list honest all live in `surface.ts` —
 * `assertServerSurface` runs below, on the manifest, before this process binds
 * a port. That file exists because this paragraph used to be the only thing
 * enforcing it: the registration was inline in `main.ts`, no test executed
 * `main.ts`, and a fifth `pluginHost.register(…)` left the suite green.
 * `tests/server-surface.test.ts` now drives the real registration over a real
 * socket, and `tests/server-auth.test.ts` does the same for the token.
 */

import { createServer as createHttpServer } from 'node:http';
import type { Server } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';

import type { PluginHost } from '@chatterang/desktop/bridge';
import { createMainRouter } from '@chatterang/desktop/bridge';

import { listenHost, scheme, selfOrigin } from './binding.js';
import type { ServerBinding } from './binding.js';
import { serverBootstrapSource } from './client-bootstrap.js';
import { createRequestListener } from './http.js';
import { SessionRegistry } from './sessions.js';
import { assertServerSurface } from './surface.js';

export {
  LOOPBACK_HOST,
  DEFAULT_PORT,
  SERVER_FLAGS,
  asAuthToken,
  asTlsMaterial,
  listenHost,
  parseArgv,
  cookieIsSecure,
  resolveBinding,
  scheme,
  selfOrigin,
} from './binding.js';
export type { AuthToken, ServerBinding, TlsMaterial } from './binding.js';
export { generateToken, readOrCreateToken, tokenMatches } from './token.js';
export {
  CSP_PRODUCTION,
  SECURITY_HEADERS,
  SERVED_CSP,
  injectBootstrap,
  originAllowed,
  prepareDocument,
  readCookie,
  stripExternalStylesheets,
  tokenCookie,
} from './policy.js';
export { checkToken, createRequestListener, dispatch } from './http.js';
export type { ServerRoutes } from './http.js';
export { installServerBridge, serverBootstrapSource, SERVER_BRIDGE_GLOBAL } from './client-bootstrap.js';
export {
  OFF_SURFACES,
  SERVER_PLUGINS,
  assertServerSurface,
  registerServerSurface,
  servedUri,
} from './surface.js';
export type { ServedRoots, ServerImplementations } from './surface.js';
export { SessionRegistry, encodeFrame } from './sessions.js';
export type { Session, SessionSink } from './sessions.js';
export { assertJsonWireSafe, NotJsonSafeError } from './wire.js';
export * from './wire.js';

export interface ServerOptions {
  readonly binding: ServerBinding;
  /** The directory holding the built bundle. */
  readonly bundleRoot: string;
  /**
   * The plugin host, already populated.
   *
   * Passed in rather than built here, because what is registered on it IS the
   * server's whole attack surface and that decision belongs somewhere it can
   * be read in one place — `surface.ts`, which `main.ts` calls. `startServer`
   * checks the result with `assertServerSurface` rather than trusting the
   * caller, because "passed in" is also how a fifth plugin would arrive.
   */
  readonly pluginHost: PluginHost;
  /** A peer went away. `main.ts` wires this to `HostFleet.releaseRenderer`. */
  readonly release: (senderId: number, reason: string) => void;
  readonly log?: (line: string) => void;
}

export interface RunningServer {
  /** The port actually bound — resolved, so `port: 0` is usable in a test. */
  readonly port: number;
  readonly origin: string;
  readonly sessions: SessionRegistry;
  close(): Promise<void>;
}

/**
 * Bind, and answer.
 *
 * `listenHost(binding)` is the only expression in this program that decides an
 * address, and for the loopback arm it is a constant with no field behind it.
 * That is the milestone's requirement met by construction: there is no value
 * an operator can pass that makes this line bind anywhere else without also
 * carrying a token and a certificate.
 */
export async function startServer(options: ServerOptions): Promise<RunningServer> {
  const log = options.log ?? ((line: string): void => console.log(`[chatterang-server] ${line}`));
  const sessions = new SessionRegistry();
  const router = createMainRouter(options.pluginHost);
  const manifest = router.bootstrap();
  // BEFORE THE SOCKET, not after. The manifest is what the channel table was
  // built from and what the served bootstrap embeds, so this is the reachable
  // surface rather than the intended one — and a server that would expose a
  // fifth plugin never binds a port at all. See `surface.ts`.
  assertServerSurface(manifest);

  const host = listenHost(options.binding);
  const listener = createRequestListener({
    binding: options.binding,
    bundleRoot: options.bundleRoot,
    router,
    sessions,
    bootstrapScript: serverBootstrapSource(manifest),
    configuredOrigins: allowedOrigins(options.binding, host),
    /*
     * BOTH HALVES, HERE, WHERE THE CALLER CANNOT FORGET ONE.
     *
     * A peer going away has to reach two objects: `PluginHost`, which holds
     * its event subscriptions, and the host fleet, which holds its in-flight
     * turns and open native sessions. `renderer-lifecycle.ts` exists on the
     * desktop side because missing one of them "leaks exactly the other
     * engine's turns and sessions for every window that ever closes — no
     * error, no log, nothing a boot check can see".
     *
     * The subscription half is done here rather than left to `main.ts`,
     * because `startServer` already holds the plugin host and a caller that
     * wired only the fleet would leave a growing table behind every closed
     * tab — with every entry still counted as a delivery target.
     */
    release: (senderId, reason) => {
      options.pluginHost.releaseSender(senderId);
      options.release(senderId, reason);
    },
    log,
  });

  const server: Server =
    options.binding.kind === 'authenticated'
      ? createHttpsServer(
          { key: options.binding.tls.key, cert: options.binding.tls.cert },
          listener,
        )
      : createHttpServer(listener);

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.binding.port, host, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : options.binding.port;

  return {
    port,
    origin: `${scheme(options.binding)}://${host}${port === 443 || port === 80 ? '' : `:${port}`}`,
    sessions,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        // An open event stream is a live connection: without this, `close`
        // waits for a peer that is deliberately never going to hang up.
        server.closeAllConnections?.();
      }),
  };
}

/**
 * Every spelling of "us" a browser might put in an `Origin` header.
 *
 * `127.0.0.1` and `localhost` are the same machine and different origins, and
 * a person types whichever they remember. Both are admitted for a loopback
 * binding; for an authenticated one only the address it was told to bind is,
 * because there the origin is part of what the certificate is for.
 */
export function allowedOrigins(binding: ServerBinding, host: string): readonly string[] {
  const origins = [selfOrigin(binding, host)];
  if (binding.kind === 'loopback') {
    origins.push(selfOrigin(binding, 'localhost'), selfOrigin(binding, '[::1]'));
  }
  return origins;
}
