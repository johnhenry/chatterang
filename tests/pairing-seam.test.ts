import { createHash, generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ListenerHandle } from '@chatterang/contracts';
import type {
  NegotiatedPeerCertificate,
  TunnelCloseEvent,
  TunnelConnectOptions,
  TunnelOpenEvent,
  TunnelSocketEventName,
  TunnelSocketPlugin,
} from '@chatterang/contracts/tunnel-socket';
import { BindingError, channelIdentifierFor, type PairingRoute } from '@chatterang/tunnel/binding';
import {
  ADDRESS_DNS,
  ADDRESS_IPV4,
  HOST_DESKTOP,
  TRUST_SPKI_PIN,
  TRUST_STATIC_KEY,
  type PairingPayload,
} from '@chatterang/tunnel/pairing';
import {
  PairingConnectionClosedError,
  UNAVAILABLE_PAIRING,
  openBoundPairingConnection,
  pairingController,
  validateScannedPayload,
} from '@/lib/pairing';

import { codeOf } from './support/source-scan';

const text = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));

function payload(over: Partial<PairingPayload> = {}): PairingPayload {
  return {
    version: 1,
    hostKind: HOST_DESKTOP,
    trustMode: TRUST_SPKI_PIN,
    trust: new Uint8Array(32).fill(1),
    token: new Uint8Array(32).fill(2),
    expiresAt: 1_000,
    port: 8973,
    addresses: [{ kind: ADDRESS_IPV4, value: Uint8Array.of(192, 168, 1, 4) }],
    name: 'Desk',
    ...over,
  } as PairingPayload;
}

describe('validating a scanned payload before the confirm step', () => {
  it('lets a valid, unexpired, reachable payload through', () => {
    expect(validateScannedPayload(payload(), 999)).toEqual({ ok: true });
  });

  it('refuses an expired one — expiry is absolute wall-clock seconds', () => {
    expect(validateScannedPayload(payload(), 1_000)).toEqual({ ok: false, problem: 'expired' });
  });

  it('refuses a trust mode this build cannot interpret, BEFORE checking expiry', () => {
    // Calling an unreadable payload "expired" would send the person to draw a
    // new code that fails the same way.
    expect(validateScannedPayload(payload({ trustMode: TRUST_STATIC_KEY }), 5_000)).toEqual({ ok: false, problem: 'unsupported-trust-mode' });
  });

  it('refuses a payload whose EVERY address is a .local name', () => {
    const local = { kind: ADDRESS_DNS, value: text('desk.local') } as const;
    expect(validateScannedPayload(payload({ addresses: [local] }), 999)).toEqual({ ok: false, problem: 'unreachable' });
  });

  it('accepts one reachable address among .local ones — the paired control', () => {
    const local = { kind: ADDRESS_DNS, value: text('desk.local') } as const;
    const lan = { kind: ADDRESS_IPV4, value: Uint8Array.of(10, 0, 0, 5) } as const;
    expect(validateScannedPayload(payload({ addresses: [local, lan] }), 999)).toEqual({ ok: true });
  });
});

describe('the controller this build has', () => {
  afterEach(() => vi.restoreAllMocks());

  it('is unavailable, so no entry point asks for a camera it cannot use', () => {
    expect(pairingController()).toBe(UNAVAILABLE_PAIRING);
    expect(pairingController().available).toBe(false);
  });

  it('refuses honestly and touches no network', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const socket = vi.fn();
    const original = globalThis.WebSocket;
    (globalThis as { WebSocket: unknown }).WebSocket = socket;
    try {
      const outcome = await UNAVAILABLE_PAIRING.pair({ route: 'scanned', payload: payload() });
      expect(outcome).toEqual({ kind: 'refused', reason: 'transport-unavailable' });
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(socket).not.toHaveBeenCalled();
    } finally {
      (globalThis as { WebSocket: unknown }).WebSocket = original;
    }
  });
});

/**
 * THE NEGOTIATED CERTIFICATE, INTO THE BINDING (#256, over #295's contract).
 *
 * #256's remaining item is that "the binding is not wired to a real socket".
 * `channelIdentifierFor` has existed since #265 and the socket plugin's
 * contract since #326; nothing called one with the other. This is that call
 * site, driven here over a fake plugin, which can stage what a real plugin
 * should never do. The plugin landed in #332:
 * `tests/pairing-desktop-socket.test.ts` runs this same function over its
 * desktop leg (`apps/desktop/src/net/tunnel-socket.ts`) against a real TLS
 * listener. Its iOS and Android legs (`native/plugin-tunnel-socket/`) have not
 * been compiled or run, so on a phone this path has never run.
 *
 * The fake keeps the contract's rules that matter here: `negotiatedPeer`
 * throws for a handle that is not open, and events carry a `connectionId`.
 * It does NOT check the pin itself, which is the plugin's job over `wss:`: a
 * plugin that got that wrong is exactly the case the JavaScript check is for.
 */
describe('binding an open pairing connection to what it negotiated (#256)', () => {
  const URL_DIALLED = 'wss://192.168.1.4:8973/';
  const DESKTOP_TYPED: PairingRoute = { kind: 'typed', hostKind: HOST_DESKTOP };

  const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

  /** A real P-256 key's pin, computed the way `identity.ts` computes one. */
  function realPin(): { readonly spki: Uint8Array; readonly spkiSha256: string } {
    const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const digest = createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest();
    return { spki: new Uint8Array(digest), spkiSha256: digest.toString('base64') };
  }

  type AnyListener = (event: never) => void;

  function fakeSocket(
    /**
     * What `negotiatedPeer` resolves with, by handle. Any value, not only a
     * certificate: a bridge's answer is JSON nobody typed on the way over.
     */
    peers: Readonly<Record<string, unknown>>,
    options: { readonly ids?: readonly string[]; readonly openDuringConnect?: boolean; readonly rejectConnect?: Error } = {},
  ) {
    /** Every method called, in order, with the handle it named. */
    const calls: string[] = [];
    const connects: TunnelConnectOptions[] = [];
    const listeners = new Map<TunnelSocketEventName, Set<AnyListener>>();
    const open = new Set<string>();
    const ids = [...(options.ids ?? ['connection-1'])];
    const each = (name: TunnelSocketEventName) => [...(listeners.get(name) ?? [])];

    const emitOpen = (connectionId: string): void => {
      open.add(connectionId);
      for (const listener of each('tunnelOpen')) (listener as (event: TunnelOpenEvent) => void)({ connectionId });
    };
    const emitClose = (event: TunnelCloseEvent): void => {
      open.delete(event.connectionId);
      for (const listener of each('tunnelClose')) (listener as (event: TunnelCloseEvent) => void)(event);
    };

    const socket: TunnelSocketPlugin = {
      async connect(sent) {
        calls.push('connect');
        connects.push(sent);
        if (options.rejectConnect !== undefined) throw options.rejectConnect;
        const connectionId = ids.shift() ?? 'connection-unplanned';
        // A bridge whose event beats the call's own resolution to JavaScript.
        if (options.openDuringConnect) emitOpen(connectionId);
        return { connectionId };
      },
      async send({ connectionId }) {
        calls.push(`send ${connectionId}`);
      },
      async close({ connectionId }) {
        calls.push(`close ${connectionId}`);
        open.delete(connectionId);
      },
      async negotiatedPeer({ connectionId }) {
        calls.push(`negotiatedPeer ${connectionId}`);
        if (!open.has(connectionId) || !Object.hasOwn(peers, connectionId)) {
          throw new Error(`${connectionId} is not an open connection`);
        }
        return peers[connectionId] as NegotiatedPeerCertificate;
      },
      async addListener(eventName: TunnelSocketEventName, listener: AnyListener): Promise<ListenerHandle> {
        calls.push(`addListener ${eventName}`);
        const set = listeners.get(eventName) ?? new Set<AnyListener>();
        listeners.set(eventName, set);
        set.add(listener);
        return {
          remove: async () => {
            set.delete(listener);
          },
        };
      },
      async removeAllListeners() {
        calls.push('removeAllListeners');
        listeners.clear();
      },
    };

    return {
      socket,
      calls,
      connects,
      emitOpen,
      emitClose,
      /** The calls that are not subscriptions. */
      acts: () => calls.filter((call) => !call.startsWith('addListener')),
      listening: () => [...listeners.values()].reduce((sum, set) => sum + set.size, 0),
    };
  }

  async function until(check: () => boolean, what: string): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (!check()) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await new Promise((settle) => setTimeout(settle, 1));
    }
  }

  const ticks = async (n: number): Promise<void> => {
    for (let i = 0; i < n; i += 1) await new Promise((settle) => setTimeout(settle, 0));
  };

  /** A promise that must settle, rather than a test that hangs until vitest's own timeout. */
  function within<T>(promise: Promise<T>, ms = 2_000): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`did not settle within ${String(ms)} ms`)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  }

  afterEach(() => vi.restoreAllMocks());

  it('scanned, matching: pins the certificate on connect, binds what was negotiated, and hands back the connection', async () => {
    const pin = realPin();
    const route: PairingRoute = { kind: 'scanned', payload: payload({ trust: pin.spki }) };
    const fake = fakeSocket({ 'connection-1': { spkiSha256: pin.spkiSha256 } });

    const pending = openBoundPairingConnection(fake.socket, URL_DIALLED, route);
    await until(() => fake.calls.includes('connect'), 'connect');
    fake.emitOpen('connection-1');
    const bound = await within(pending);

    expect(bound.connectionId).toBe('connection-1');
    expect(hex(bound.ci)).toBe(hex(channelIdentifierFor(route, { spki: pin.spki })));
    // The QR route knows the pin before it dials, so the plugin checks it too;
    // a pairing connection presents no credential in either form.
    expect(fake.connects).toEqual([{ url: URL_DIALLED, expectedPeer: { spkiSha256: pin.spkiSha256 } }]);
    expect(fake.acts()).toEqual(['connect', 'negotiatedPeer connection-1']);
    // Subscribed before dialling, so no event for this connection can be missed.
    expect(fake.calls.indexOf('addListener tunnelOpen')).toBeLessThan(fake.calls.indexOf('connect'));
    expect(fake.calls.indexOf('addListener tunnelClose')).toBeLessThan(fake.calls.indexOf('connect'));
    expect(fake.listening()).toBe(0);
  });

  it('scanned, mismatching: throws pin-mismatch before anything is sent, and closes the connection', async () => {
    const pin = realPin();
    const impostor = realPin();
    const route: PairingRoute = { kind: 'scanned', payload: payload({ trust: pin.spki }) };
    // A plugin that failed to enforce `expectedPeer` and reported the truth.
    const fake = fakeSocket({ 'connection-1': { spkiSha256: impostor.spkiSha256 } });

    const pending = openBoundPairingConnection(fake.socket, URL_DIALLED, route);
    await until(() => fake.calls.includes('connect'), 'connect');
    fake.emitOpen('connection-1');
    const error = await within(pending.then(() => null, (e: unknown) => e));

    expect(error).toBeInstanceOf(BindingError);
    expect((error as BindingError).reason).toBe('pin-mismatch');
    expect(fake.acts()).toEqual(['connect', 'negotiatedPeer connection-1', 'close connection-1']);
    expect(fake.listening()).toBe(0);
  });

  it('typed: two different reported certificates are two different channel identifiers', async () => {
    const first = realPin();
    const second = realPin();
    const fake = fakeSocket(
      { 'connection-1': { spkiSha256: first.spkiSha256 }, 'connection-2': { spkiSha256: second.spkiSha256 } },
      { ids: ['connection-1', 'connection-2'] },
    );

    const a = openBoundPairingConnection(fake.socket, URL_DIALLED, DESKTOP_TYPED);
    await until(() => fake.connects.length === 1, 'first connect');
    fake.emitOpen('connection-1');
    const boundA = await within(a);

    const b = openBoundPairingConnection(fake.socket, URL_DIALLED, DESKTOP_TYPED);
    await until(() => fake.connects.length === 2, 'second connect');
    fake.emitOpen('connection-2');
    const boundB = await within(b);

    expect(hex(boundA.ci)).not.toBe(hex(boundB.ci));
    expect(hex(boundA.ci)).toBe(hex(channelIdentifierFor(DESKTOP_TYPED, { spki: first.spki })));
    expect(hex(boundB.ci)).toBe(hex(channelIdentifierFor(DESKTOP_TYPED, { spki: second.spki })));
    // Six typed digits carry no pin, so there is nothing to ask the plugin to check.
    expect(fake.connects).toEqual([{ url: URL_DIALLED }, { url: URL_DIALLED }]);
  });

  it('asks negotiatedPeer for the handle connect returned, and only once that connection has opened', async () => {
    const ours = realPin();
    const other = realPin();
    const fake = fakeSocket({
      'connection-7': { spkiSha256: ours.spkiSha256 },
      // Another connection to the SAME host: what a man in the middle's is.
      'connection-other': { spkiSha256: other.spkiSha256 },
    }, { ids: ['connection-7'] });

    const pending = openBoundPairingConnection(fake.socket, URL_DIALLED, DESKTOP_TYPED);
    await until(() => fake.calls.includes('connect'), 'connect');
    await ticks(10);
    expect(fake.acts()).toEqual(['connect']);

    fake.emitOpen('connection-other');
    await ticks(10);
    expect(fake.acts(), 'another connection opening is not this one opening').toEqual(['connect']);

    fake.emitOpen('connection-7');
    const bound = await within(pending);
    expect(fake.acts()).toEqual(['connect', 'negotiatedPeer connection-7']);
    expect(hex(bound.ci)).toBe(hex(channelIdentifierFor(DESKTOP_TYPED, { spki: ours.spki })));
  });

  it('hears an open that arrives before connect has finished returning its handle', async () => {
    const pin = realPin();
    const fake = fakeSocket({ 'connection-1': { spkiSha256: pin.spkiSha256 } }, { openDuringConnect: true });
    const bound = await within(openBoundPairingConnection(fake.socket, URL_DIALLED, DESKTOP_TYPED));
    expect(hex(bound.ci)).toBe(hex(channelIdentifierFor(DESKTOP_TYPED, { spki: pin.spki })));
  });

  it('a connection that ends before it opens rejects with its close, and asks nothing more of it', async () => {
    const fake = fakeSocket({});
    const pending = openBoundPairingConnection(
      fake.socket,
      URL_DIALLED,
      { kind: 'scanned', payload: payload({ trust: realPin().spki }) },
    );
    await until(() => fake.calls.includes('connect'), 'connect');

    fake.emitClose({ connectionId: 'connection-other', code: 1000, reason: '' });
    await ticks(10);
    expect(fake.listening(), 'another connection ending is not this one ending').toBe(2);

    // The plugin refused the peer's key before writing anything to it.
    const ended: TunnelCloseEvent = { connectionId: 'connection-1', code: 1006, reason: '', failure: 'PEER_MISMATCH' };
    fake.emitClose(ended);
    const error = await within(pending.then(() => null, (e: unknown) => e));

    expect(error).toBeInstanceOf(PairingConnectionClosedError);
    expect((error as PairingConnectionClosedError).close).toEqual(ended);
    expect(fake.acts()).toEqual(['connect']);
    expect(fake.listening()).toBe(0);
  });

  it('a refused connect is rethrown as the plugin gave it, with nothing left subscribed', async () => {
    const refusal = Object.assign(new Error('options refused'), { code: 'OPTIONS_REFUSED' });
    const fake = fakeSocket({}, { rejectConnect: refusal });
    const error = await within(
      openBoundPairingConnection(fake.socket, URL_DIALLED, DESKTOP_TYPED).then(() => null, (e: unknown) => e),
    );
    expect(error).toBe(refusal);
    expect(fake.acts()).toEqual(['connect']);
    expect(fake.listening()).toBe(0);
  });

  it('refuses a reported fingerprint that is not the canonical base64 of 32 bytes, and closes the connection', async () => {
    const pin = realPin();
    const canonical = pin.spkiSha256;
    const last = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    // The same bytes with the final character's two unused bits set.
    const nonCanonical = `${canonical.slice(0, 42)}${last[last.indexOf(canonical[42]!) + 1]!}=`;
    const reports: readonly (readonly [string, unknown])[] = [
      ['whitespace a lenient decoder skips', `${canonical.slice(0, 20)} ${canonical.slice(20)}`],
      ['no padding', canonical.slice(0, 43)],
      ['base64url', Buffer.from(new Uint8Array(32).fill(0xfb)).toString('base64url')],
      ['31 bytes', Buffer.from(pin.spki.subarray(0, 31)).toString('base64')],
      ['33 bytes', Buffer.from([...pin.spki, 0]).toString('base64')],
      ['unused bits set', nonCanonical],
      ['empty', ''],
      ['not a string', 42],
    ];
    expect(nonCanonical).not.toBe(canonical);

    for (const [label, spkiSha256] of reports) {
      const fake = fakeSocket({ 'connection-1': { spkiSha256 } });
      const pending = openBoundPairingConnection(fake.socket, URL_DIALLED, DESKTOP_TYPED);
      await until(() => fake.calls.includes('connect'), `connect (${label})`);
      fake.emitOpen('connection-1');
      const error = await within(pending.then(() => null, (e: unknown) => e));
      expect(error, label).toBeInstanceOf(BindingError);
      expect((error as BindingError).reason, label).toBe('bad-negotiated-spki');
      expect(fake.acts(), label).toEqual(['connect', 'negotiatedPeer connection-1', 'close connection-1']);
      expect(fake.listening(), label).toBe(0);
    }
  });

  it('refuses a negotiatedPeer that resolves with no certificate at all, as bad-negotiated-spki, and closes the connection', async () => {
    const pin = realPin();
    const routes: readonly (readonly [string, PairingRoute])[] = [
      ['typed', DESKTOP_TYPED],
      ['scanned', { kind: 'scanned', payload: payload({ trust: pin.spki }) }],
    ];
    const answers: readonly (readonly [string, unknown])[] = [
      // A bridge that answered with no data, or with null: reading a field of
      // either is a TypeError, which is not the module's refusal.
      ['undefined', undefined],
      ['null', null],
      // Controls: already refused before this test, and must stay refused.
      ['an object without the field', {}],
      ['the fingerprint itself, not in an object', pin.spkiSha256],
    ];

    for (const [routeLabel, route] of routes) {
      for (const [answerLabel, answer] of answers) {
        const label = `${routeLabel}, negotiatedPeer resolved ${answerLabel}`;
        const fake = fakeSocket({ 'connection-1': answer });
        const pending = openBoundPairingConnection(fake.socket, URL_DIALLED, route);
        await until(() => fake.calls.includes('connect'), `connect (${label})`);
        fake.emitOpen('connection-1');
        const error = await within(pending.then(() => null, (e: unknown) => e));
        expect(error, label).toBeInstanceOf(BindingError);
        expect((error as BindingError).reason, label).toBe('bad-negotiated-spki');
        expect(fake.acts(), label).toEqual(['connect', 'negotiatedPeer connection-1', 'close connection-1']);
        expect(fake.listening(), label).toBe(0);
      }
    }
  });

  it('does not dial at all for a scanned code whose trust mode this build cannot check', async () => {
    const fake = fakeSocket({});
    const error = await within(
      openBoundPairingConnection(
        fake.socket,
        URL_DIALLED,
        { kind: 'scanned', payload: payload({ trustMode: TRUST_STATIC_KEY }) },
      ).then(() => null, (e: unknown) => e),
    );
    expect(error).toBeInstanceOf(BindingError);
    expect((error as BindingError).reason).toBe('unsupported-trust-mode');
    expect(fake.calls).toEqual([]);
  });

  it('stores nothing and opens nothing of its own while it binds', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const browserSocket = vi.fn();
    const original = globalThis.WebSocket;
    (globalThis as { WebSocket: unknown }).WebSocket = browserSocket;
    try {
      const pin = realPin();
      const fake = fakeSocket({ 'connection-1': { spkiSha256: pin.spkiSha256 } }, { openDuringConnect: true });
      await within(
        openBoundPairingConnection(fake.socket, URL_DIALLED, { kind: 'scanned', payload: payload({ trust: pin.spki }) }),
      );
      expect(setItem).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(browserSocket).not.toHaveBeenCalled();
    } finally {
      (globalThis as { WebSocket: unknown }).WebSocket = original;
    }
  });

  it('loads no CPace code with the seam: the binding half is imported only when a connection is bound', () => {
    /*
     * `src/lib/pairing.ts` is loaded wherever the pairing entry is (Settings),
     * on every phone, including the old ones #223 is open about. The binding
     * half brings `pake/` and noble with it, which nothing on this build runs,
     * so its only door here is a dynamic `import()`. Type imports are erased.
     *
     * Every static form counts, not only the one with `from`: a side-effect
     * `import '…'` loads the module just the same, and so does an import whose
     * every name is marked `type` (under `verbatimModuleSyntax` it is emitted as
     * `import {} from '…'`). Either quote. Only `import type` and `export type`
     * are erased whole. Comments are stripped by the stripper
     * `tests/layering.test.ts`'s import guards use, which leaves strings alone.
     */
    const code = codeOf(readFileSync(resolve(process.cwd(), 'src/lib/pairing.ts'), 'utf8'));
    const staticValueImports = [
      ...code.matchAll(/^\s*(?:import|export)\b(?!\s*type\b)\s*(?:[^;'"]*?\bfrom\s*)?['"]([^'"]+)['"]/gm),
    ].map((match) => match[1]);
    expect(staticValueImports).toEqual(['@chatterang/tunnel/pairing']);
  });
});
