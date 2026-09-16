/**
 * `TunnelSocket`, run for real: the desktop's own leg of #181's ruling
 * (#295, refs #181, #256, #184, #186).
 *
 * #181 ruled the tunnel's transport is a native socket plugin, on both mobile
 * platforms, terminating pinned TLS itself because a WebView cannot see the
 * certificate a pin has to be checked against. The owner's follow-up ruling on
 * #295 extends that to this shell: "the Electron desktop is a tunnel client
 * too, in v1 — not only a host. Besides iOS and Android, the desktop app can
 * open a tunnel to another desktop." The Chromium renderer this app's UI runs
 * in is exactly as unable to read a peer certificate as a phone's WebView, so
 * it needs the same plugin boundary — and here, for once, "native" is simply
 * Node, already running in this process, with a real TLS client and a real
 * `X509Certificate`.
 *
 * WHAT THIS FILE CHECKS, so `packages/contracts/src/tunnel-socket.ts` stays
 * true of every implementation and not only the mobile ones:
 *
 *   - `connect` validates its options exactly as the contract requires,
 *     BEFORE any socket is made: an unparseable `url`, a credential somewhere
 *     other than `wss:` or `ws://127.0.0.1`, a `wss:` credential with no
 *     `expectedPeer`, both credential forms at once (all `OPTIONS_REFUSED`),
 *     and a `credentialRef` this store does not hold (`CREDENTIAL_MISSING`).
 *   - Over `wss:`, `expectedPeer` is checked on THIS connection's own
 *     handshake, before the upgrade request — and so before the credential in
 *     its header — is written. A mismatch never sends the credential anywhere
 *     (`PEER_MISMATCH`, reported through `tunnelClose` with no event before
 *     it, matching #181's negative-pin requirement).
 *   - `negotiatedPeer` answers only for a connection that is OPEN RIGHT NOW,
 *     never from a cache keyed by host — #256's channel binding is only as
 *     good as this method's freshness.
 *
 * WHY `ws` AND NOT THE UNDICI `WebSocket` GLOBAL `client/index.ts` uses at rung
 * 0: that global cannot see the underlying `tls.TLSSocket`, which is the one
 * thing this plugin exists to check before the handshake's upgrade request is
 * written. `packages/tunnel/src/host/index.ts` already depends on `ws` for the
 * SERVER half; this is the client half of the same library, and
 * `tests/tunnel-client-transport.test.ts`'s `socketPluginOverWs` proved this
 * exact approach — `finishRequest` gating on `secureConnect` — against a real
 * listener before this file existed.
 *
 * WHERE THE CREDENTIAL STORE LIVES: `credentialRef` names an entry in an
 * injected {@link CredentialRefStore}, deliberately never a global — nothing
 * about pairing or persisting a device credential on the desktop is decided
 * here. With none injected, every `credentialRef` is `CREDENTIAL_MISSING`,
 * which is the honest answer for a store that holds nothing, not a stub
 * standing in for one that does.
 *
 * WHY THIS LIVES IN `net/` AND NOT IN `bridge/`. `tests/layering.test.ts`
 * ("the desktop bridge stays platform-free") refuses any Node builtin or
 * `electron` import inside `apps/desktop/src/bridge/` — that directory is
 * "a type or a frozen array", tested through fake ports with no window.
 * `fs/mounts.ts` and `fs/filesystem.ts` are the precedent for a plugin
 * IMPLEMENTATION that genuinely needs Node living beside `bridge/` rather than
 * in it, importing `PluginImplementation` and `SENDER_SCOPED` from there
 * rather than being exported through `bridge/index.ts`'s barrel. This file
 * follows the same shape, and `main.ts` imports it directly.
 */

import { createHash } from 'node:crypto';
import type { TLSSocket } from 'node:tls';

import type {
  NegotiatedPeerCertificate,
  TunnelCloseFailure,
  TunnelConnectRejectionCode,
} from '@chatterang/contracts/tunnel-socket';

import type { PluginImplementation, PluginMethod } from '../bridge/plugin-host.js';
import { SENDER_SCOPED, TUNNEL_SOCKET_PLUGIN } from '../bridge/protocol.js';

/** Reads a device credential a `credentialRef` names. Never written here. */
export interface CredentialRefStore {
  get(ref: string): string | undefined;
}

const EMPTY_STORE: CredentialRefStore = { get: () => undefined };

export interface TunnelSocketPluginOptions {
  /** How an event reaches the renderer that opened its connection. */
  readonly notify: (eventName: (typeof TUNNEL_SOCKET_PLUGIN.events)[number], data: unknown, ownerId: number) => void;
  /** Where a `credentialRef` is looked up. Defaults to a store that holds nothing. */
  readonly credentials?: CredentialRefStore;
}

/** A plugin rejection as `call.reject` would produce it: an `Error` with a string `code`. */
function refused(code: TunnelConnectRejectionCode, message: string): Error {
  return Object.assign(new Error(message), { code });
}

/** Can this URL carry a credential? `wss:` anywhere, or plaintext loopback — the contract's own rule. */
function carriesCredentialSafely(url: URL): boolean {
  return url.protocol === 'wss:' || (url.protocol === 'ws:' && url.hostname === '127.0.0.1');
}

const toBase64 = (bytes: Buffer): string => bytes.toString('base64');
const fromBase64 = (text: string): Buffer => Buffer.from(text, 'base64');

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

/** A validated `connect()` request. Never trusts `raw` beyond what it checks here. */
interface ParsedConnect {
  readonly rawUrl: string;
  readonly url: URL;
  readonly credential?: string;
  readonly credentialRefName?: string;
  readonly expectedPeer?: NegotiatedPeerCertificate;
}

/**
 * `raw` crossed the renderer boundary as untyped data (`PluginHost.invoke`
 * checks it is CLONEABLE, never that it is a `TunnelConnectOptions`), so this
 * is where the contract's own validation duties for `connect` actually run —
 * see this file's header. Every failure here is `OPTIONS_REFUSED`.
 */
function parseConnect(raw: unknown): ParsedConnect {
  const record = asRecord(raw);
  const rawUrl = record['url'];
  if (typeof rawUrl !== 'string') throw refused('OPTIONS_REFUSED', 'TunnelSocket: connect() needs a string url.');
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw refused('OPTIONS_REFUSED', `TunnelSocket: "${rawUrl}" is not a URL.`);
  }

  const credential = record['credential'];
  const credentialRefName = record['credentialRef'];
  if (credential !== undefined && typeof credential !== 'string') {
    throw refused('OPTIONS_REFUSED', 'TunnelSocket: connect() needs credential to be a string.');
  }
  if (credentialRefName !== undefined && typeof credentialRefName !== 'string') {
    throw refused('OPTIONS_REFUSED', 'TunnelSocket: connect() needs credentialRef to be a string.');
  }
  if (credential !== undefined && credentialRefName !== undefined) {
    throw refused('OPTIONS_REFUSED', 'TunnelSocket: connect() was given a credential and a credentialRef together.');
  }

  const expectedPeerRaw = record['expectedPeer'];
  let expectedPeer: NegotiatedPeerCertificate | undefined;
  if (expectedPeerRaw !== undefined) {
    const spkiSha256 = asRecord(expectedPeerRaw)['spkiSha256'];
    if (typeof spkiSha256 !== 'string') {
      throw refused('OPTIONS_REFUSED', 'TunnelSocket: connect() needs expectedPeer.spkiSha256 to be a string.');
    }
    expectedPeer = { spkiSha256 };
  }

  return {
    rawUrl,
    url,
    ...(credential === undefined ? {} : { credential }),
    ...(credentialRefName === undefined ? {} : { credentialRefName }),
    ...(expectedPeer === undefined ? {} : { expectedPeer }),
  };
}

/** The SHA-256 of the SPKI this TLS connection negotiated, base64 — what a pin is checked against. */
function spkiSha256Of(socket: TLSSocket): string | undefined {
  const peer = socket.getPeerX509Certificate();
  if (peer === undefined) return undefined;
  return createHash('sha256').update(peer.publicKey.export({ type: 'spki', format: 'der' })).digest('base64');
}

interface OpenConnection {
  readonly ownerId: number;
  readonly socket: import('ws').WebSocket;
  peer?: NegotiatedPeerCertificate;
}

/**
 * Build the main-process implementation `PluginHost.register(TUNNEL_SOCKET_PLUGIN, …)` takes.
 *
 * ONE INSTANCE MAY SERVE MANY RENDERERS AND MANY CONNECTIONS. `connect` is
 * {@link SENDER_SCOPED}, so every connection this returns is stamped with the
 * `senderId` that opened it, and every event only ever reaches that one
 * renderer — the same rule `LlamaCpp.generate`'s `llamaToken` follows in
 * `local-turns.ts`, applied here to a socket rather than a token stream.
 */
export function createTunnelSocketPlugin(options: TunnelSocketPluginOptions): PluginImplementation {
  const credentials = options.credentials ?? EMPTY_STORE;
  const connections = new Map<string, OpenConnection>();
  let issued = 0;

  const connectionOf = (connectionId: string): OpenConnection => {
    const connection = connections.get(connectionId);
    if (connection === undefined) throw new Error(`TunnelSocket: no connection "${connectionId}".`);
    return connection;
  };

  async function connect(ownerId: number, raw: unknown): Promise<{ readonly connectionId: string }> {
    const { rawUrl, url, credential, credentialRefName, expectedPeer } = parseConnect(raw);

    if (credential !== undefined && credentialRefName !== undefined) {
      throw refused('OPTIONS_REFUSED', 'TunnelSocket: connect() was given a credential and a credentialRef together.');
    }

    let presentedCredential: string | undefined = credential;
    if (credentialRefName !== undefined) {
      presentedCredential = credentials.get(credentialRefName);
      if (presentedCredential === undefined) {
        throw refused('CREDENTIAL_MISSING', `TunnelSocket: no stored credential is named "${credentialRefName}".`);
      }
    }

    const presents = presentedCredential !== undefined;
    if (presents && !carriesCredentialSafely(url)) {
      throw refused(
        'OPTIONS_REFUSED',
        `TunnelSocket: a device credential goes only over wss://, or ws:// to 127.0.0.1 — not ${rawUrl}.`,
      );
    }
    if (presents && url.protocol === 'wss:' && expectedPeer === undefined) {
      throw refused('OPTIONS_REFUSED', 'TunnelSocket: a credential over wss: needs an expectedPeer.');
    }

    const { WebSocket } = await import('ws');
    issued += 1;
    const connectionId = `tunnel-socket-${String(issued)}`;
    let httpStatus: number | undefined;
    let failure: TunnelCloseFailure | undefined;

    const socket = new WebSocket(rawUrl, {
      headers: presentedCredential === undefined ? {} : { 'chatterang-device-credential': presentedCredential },
      // The pin (checked below) is this plugin's trust root, not the CA list.
      rejectUnauthorized: false,
      /*
       * THE PIN BEFORE THE REQUEST. See `tests/tunnel-client-transport.test.ts`'s
       * `socketPluginOverWs`, which measured that a synchronous check inside
       * `secureConnect` still holds `request.end()` — `ws` calls `finishRequest`
       * once and only once, and it is what actually writes the upgrade
       * request (and the credential header on it), so a rejection here means
       * that request, and the credential in it, is never sent.
       */
      finishRequest: (request) => {
        if (url.protocol !== 'wss:') {
          request.end();
          return;
        }
        request.once('socket', (raw) => {
          const tls = raw as TLSSocket;
          tls.once('secureConnect', () => {
            const spkiSha256 = spkiSha256Of(tls);
            const negotiated: NegotiatedPeerCertificate | undefined =
              spkiSha256 === undefined ? undefined : { spkiSha256 };
            if (
              expectedPeer !== undefined &&
              (negotiated === undefined || negotiated.spkiSha256 !== expectedPeer.spkiSha256)
            ) {
              failure = 'PEER_MISMATCH';
              request.destroy(new Error('TunnelSocket: the peer SPKI does not match expectedPeer.'));
              return;
            }
            if (negotiated !== undefined) connections.get(connectionId)!.peer = negotiated;
            request.end();
          });
        });
      },
    });

    connections.set(connectionId, { ownerId, socket });

    socket.on('error', () => undefined /* reported through tunnelClose, below */);
    socket.once('unexpected-response', (_request, response) => {
      httpStatus = response.statusCode;
      socket.terminate();
    });
    socket.once('open', () => options.notify('tunnelOpen', { connectionId }, ownerId));
    socket.on('message', (data: Buffer) => options.notify('tunnelFrame', { connectionId, frame: toBase64(data) }, ownerId));
    socket.once('close', (code: number, reason: Buffer) => {
      options.notify(
        'tunnelClose',
        {
          connectionId,
          code,
          reason: reason.toString('utf8'),
          ...(httpStatus === undefined ? {} : { httpStatus }),
          ...(failure === undefined ? {} : { failure }),
        },
        ownerId,
      );
      connections.delete(connectionId);
    });

    return { connectionId };
  }

  function connectionIdOf(raw: unknown): string {
    const connectionId = asRecord(raw)['connectionId'];
    if (typeof connectionId !== 'string') {
      throw new Error('TunnelSocket: this method needs a string connectionId.');
    }
    return connectionId;
  }

  async function send(raw: unknown): Promise<void> {
    const { socket } = connectionOf(connectionIdOf(raw));
    const frame = asRecord(raw)['frame'];
    if (typeof frame !== 'string') throw new Error('TunnelSocket: send() needs a string frame.');
    if (socket.readyState === socket.OPEN) socket.send(fromBase64(frame));
  }

  async function close(raw: unknown): Promise<void> {
    const { socket } = connectionOf(connectionIdOf(raw));
    const record = asRecord(raw);
    const code = record['code'];
    const reason = record['reason'];
    if (socket.readyState === socket.CONNECTING) socket.terminate();
    else socket.close(typeof code === 'number' ? code : undefined, typeof reason === 'string' ? reason : undefined);
  }

  async function negotiatedPeer(raw: unknown): Promise<NegotiatedPeerCertificate> {
    const connectionId = connectionIdOf(raw);
    const connection = connectionOf(connectionId);
    if (connection.socket.readyState !== connection.socket.OPEN || connection.peer === undefined) {
      throw new Error(`TunnelSocket: "${connectionId}" is not an open wss: connection.`);
    }
    return connection.peer;
  }

  const implementation: Record<string, PluginMethod> = {
    connect: connect as PluginMethod,
    send,
    close,
    negotiatedPeer,
  };
  return Object.assign(implementation, { [SENDER_SCOPED]: ['connect'] }) as unknown as PluginImplementation;
}
