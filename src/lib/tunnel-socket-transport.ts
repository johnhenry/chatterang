/**
 * THE ADAPTER `packages/tunnel/src/client/index.ts` PROMISES AN APP WRITES
 * (#295, refs #256, #184, #186).
 *
 * `createTunnelClient` takes a {@link TunnelTransportFactory} and never a
 * plugin — the client half may import nothing from `@capacitor/`
 * (`tests/layering.test.ts`), because it is also the desktop renderer's
 * bundle and, on the day it is used there, the phone's. This file is the one
 * piece that is allowed to know both shapes: the native socket plugin #181
 * chose (`TunnelSocketPlugin`, `packages/contracts/src/tunnel-socket.ts`) on
 * one side, and the transport the client runs its protocol gate over on the
 * other.
 *
 * `tests/tunnel-client-transport.test.ts` proved this shape end to end against
 * a double of the plugin over a real `ws` socket (`socketPluginOverWs` /
 * `overPlugin` there); this is that adapter, kept in one place so a real
 * plugin build and the test double are adapted identically rather than by two
 * near-copies that drift.
 *
 * WHAT IT DOES NOT DO. It does not call `TunnelSocket.connect` itself, does not
 * choose a URL, and does not read a credential — those are `TunnelClientOptions`
 * and `TunnelTransportTarget`, decided above this file. It only turns the
 * plugin's events into the three callbacks `TunnelTransport` promises, and a
 * rejected `connect` into that transport's one `onClose` — because the
 * contract sends no event after a `connect` rejection, and nothing else would
 * ever end the client's wait for one (see {@link TunnelSocketPlugin.connect}).
 */

import type {
  NegotiatedPeerCertificate,
  TunnelConnectOptions,
  TunnelSocketEventName,
  TunnelSocketPlugin,
} from '@chatterang/contracts/tunnel-socket';
import type { TunnelTransport, TunnelTransportFactory, TunnelTransportFailure } from '@chatterang/tunnel/client';

/** A rejection's `code`, when the plugin gave it one as a string. */
function rejectionCodeOf(error: unknown): string | undefined {
  const code = typeof error === 'object' && error !== null ? (error as { readonly code?: unknown }).code : undefined;
  return typeof code === 'string' ? code : undefined;
}

/**
 * Everything else the caller has already decided: the pin, if any, for the
 * desktop this device paired with. Not part of {@link TunnelTransportTarget} —
 * that type is the client's own, shared with every transport, and a pin is
 * this plugin's business alone.
 */
export interface TunnelSocketTransportOptions {
  /**
   * The desktop's expected certificate fingerprint, when the caller already
   * knows it (the QR route's pin, or #256's binding on the typed route once it
   * has learned one). Omitted, the plugin accepts any certificate and nothing
   * but pairing may travel until the caller has checked what it negotiated —
   * see {@link TunnelSocketPlugin.negotiatedPeer}.
   */
  readonly expectedPeer?: NegotiatedPeerCertificate;
}

/**
 * Adapt a `TunnelSocketPlugin` instance into the factory `createTunnelClient`
 * runs its protocol over.
 *
 * ONE TRANSPORT PER CALL, matching {@link TunnelTransportFactory}'s own
 * contract: `createTunnelClient` calls the factory once per client, so this
 * closes over exactly one `connectionId` and never mixes two connections'
 * events. Every listener this attaches filters on that id, which is what lets
 * one plugin instance serve several concurrent clients safely — the plugin
 * itself, not this file, is the one thing that must not be constructed twice.
 */
export function tunnelSocketTransport(
  plugin: TunnelSocketPlugin,
  options: TunnelSocketTransportOptions = {},
): TunnelTransportFactory {
  return (target) => {
    const on = {
      open: [] as (() => void)[],
      frame: [] as ((bytes: Uint8Array) => void)[],
      close: [] as ((code: number, reason: string, httpStatus?: number, failure?: TunnelTransportFailure) => void)[],
    };
    let connectionId: string | null = null;
    const isOurs = (event: { readonly connectionId: string }): boolean => event.connectionId === connectionId;

    const fromBase64 = (text: string): Uint8Array => Uint8Array.from(atob(text), (char) => char.charCodeAt(0));
    const toBase64 = (bytes: Uint8Array): string => btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(''));

    const connected = (async (): Promise<string | null> => {
      // Registered BEFORE `connect` is called, so no event for this
      // connection can arrive before a listener is here to filter it —
      // `TunnelSocketPlugin.connect`'s own obligation, taken at its word.
      await plugin.addListener('tunnelOpen', (event) => {
        if (isOurs(event)) for (const listener of on.open) listener();
      });
      await plugin.addListener('tunnelFrame', (event) => {
        if (isOurs(event)) for (const listener of on.frame) listener(fromBase64(event.frame));
      });
      await plugin.addListener('tunnelClose', (event) => {
        if (!isOurs(event)) return;
        for (const listener of on.close) listener(event.code, event.reason, event.httpStatus, event.failure);
      });

      const peer = options.expectedPeer === undefined ? {} : { expectedPeer: options.expectedPeer };
      const connectOptions: TunnelConnectOptions =
        target.credential !== undefined
          ? { url: target.url, credential: target.credential, ...peer }
          : target.credentialRef !== undefined
            ? { url: target.url, credentialRef: target.credentialRef, ...peer }
            : { url: target.url, ...peer };

      try {
        const result = await plugin.connect(connectOptions);
        connectionId = result.connectionId;
        return connectionId;
      } catch (error) {
        /*
         * A REJECTED `connect` IS STILL THE CLIENT'S ONE CLOSE. See this
         * file's header: no event follows a rejection, so this is the only
         * place that can end `createTunnelClient`'s wait for one.
         * `CREDENTIAL_MISSING` is the one rejection code with a screen of its
         * own (a device restored from a backup); everything else, named or
         * not, is `TRANSPORT_FAILED` rather than "cannot reach" — an unnamed
         * refusal from a newer plugin build must fail closed, not silently
         * read as a network fault.
         */
        const failure: TunnelTransportFailure =
          rejectionCodeOf(error) === 'CREDENTIAL_MISSING' ? 'CREDENTIAL_MISSING' : 'TRANSPORT_FAILED';
        for (const listener of on.close) listener(1006, '', undefined, failure);
        return null;
      }
    })();

    const transport: TunnelTransport = {
      send: (bytes) => {
        void connected.then((id) => (id === null ? undefined : plugin.send({ connectionId: id, frame: toBase64(bytes) })));
      },
      onOpen: (listener) => on.open.push(listener),
      onFrame: (listener) => on.frame.push(listener),
      onClose: (listener) => on.close.push(listener),
      close: (code, reason) => {
        void connected.then((id) =>
          id === null
            ? undefined
            : plugin.close({ connectionId: id, ...(code === undefined ? {} : { code }), ...(reason === undefined ? {} : { reason }) }),
        );
      },
    };
    return transport;
  };
}

/** Every event name this adapter listens for, kept as a value for tests to check against the contract. */
export const TUNNEL_SOCKET_TRANSPORT_EVENTS: readonly TunnelSocketEventName[] = ['tunnelOpen', 'tunnelFrame', 'tunnelClose'];
