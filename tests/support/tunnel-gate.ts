/**
 * A tunnel gate for tests, built from the REAL parts (#135, #136).
 *
 * Every listener test goes through the gate a desktop would use: a real
 * `createDeviceCredentials`, a real pairing-window holder, and a device
 * credential minted the only way one can be — by opening a window, claiming it
 * and minting against the claim. There is no test-only door in the listener,
 * so this is where rung 0's test credential comes from.
 *
 * The clock is a number the test moves, on the same scale the windows are
 * opened on, which is what `TunnelGate.now` requires.
 */

import {
  TUNNEL_CREDENTIAL_HEADER,
} from '@chatterang/tunnel/wire';
import {
  createDeviceCredentials,
  createMemoryCredentialStore,
  type CredentialStore,
  type DeviceCredentials,
  type LoopbackTunnelBinding,
  type MintedCredential,
  type TunnelGate,
} from '@chatterang/tunnel/host';
import {
  createPairingWindows,
  openWindow,
  type PairingWindow,
  type PairingWindows,
} from '@chatterang/tunnel/pairing';

export interface TestGate {
  readonly gate: TunnelGate;
  readonly credentials: DeviceCredentials;
  readonly pairing: PairingWindows;
  /** The monotonic clock the gate reads. Move it to expire a window. */
  readonly clock: { now: number };
  /**
   * Pair a device as a desktop would, off to one side: a window of its own,
   * claimed with its own secret, minted against the claim. It does not touch
   * `pairing`, so a test's own window is not cancelled by minting a device.
   */
  mintDevice(): Promise<MintedCredential>;
  /** Show a pairing code: issue a window on `pairing`, as the desktop's screen does. */
  showCode(windowMs?: number): { readonly window: PairingWindow; readonly secret: Uint8Array };
  /** The loopback arm, on an ephemeral port unless one is named. */
  binding(port?: number): LoopbackTunnelBinding;
}

const secretBytes = (): Uint8Array => crypto.getRandomValues(new Uint8Array(32));

export function testGate(store: CredentialStore = createMemoryCredentialStore()): TestGate {
  const clock = { now: 1_000 };
  const credentials = createDeviceCredentials(store);
  const pairing = createPairingWindows();
  const gate: TunnelGate = { credentials, pairing, now: () => clock.now };

  return {
    gate,
    credentials,
    pairing,
    clock,
    async mintDevice() {
      const secret = secretBytes();
      const window = openWindow({ secret, now: clock.now, attemptBudget: 1 });
      const claimed = window.claim(secret, clock.now);
      if (!claimed.ok) throw new Error('test gate: the minting window would not claim');
      return credentials.mint(window, clock.now);
    },
    showCode(windowMs) {
      const secret = secretBytes();
      const window = pairing.issue({ secret, now: clock.now, ...(windowMs === undefined ? {} : { windowMs }) });
      return { window, secret };
    },
    binding: (port = 0) => ({ kind: 'loopback', port, gate }),
  };
}

/**
 * A store whose reads the test can hold open and see arrive: how a test puts
 * an upgrade in the middle of being decided, on purpose.
 *
 * THE VALUE IS READ BEFORE THE HOLD, not after, and that is the race being
 * modelled: the store has already answered with the digest, and the answer is
 * still on its way back when the revocation lands. Reading after the hold let
 * a revocation's delete empty the store first, so `verify` refused for want of
 * a digest and the test passed with every revocation check removed — mutation
 * testing found it.
 */
export function holdableStore(inner: CredentialStore = createMemoryCredentialStore()) {
  let hold = false;
  let signalRead!: () => void;
  const read = new Promise<void>((resolve) => {
    signalRead = resolve;
  });
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const store: CredentialStore = {
    async get(deviceId) {
      const answer = await inner.get(deviceId);
      if (hold) {
        signalRead();
        await released;
      }
      return answer;
    },
    set: (deviceId, digest) => inner.set(deviceId, digest),
    delete: (deviceId) => inner.delete(deviceId),
  };
  return {
    store,
    /** From now on, reads wait for `release`. */
    holdReads: () => {
      hold = true;
    },
    /** Resolves when a held read has arrived. */
    read,
    release: () => release(),
  };
}

/** The request headers a paired device sends. */
export const credentialHeaders = (credential: string): Record<string, string> => ({
  [TUNNEL_CREDENTIAL_HEADER]: credential,
});
