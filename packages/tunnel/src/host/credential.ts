/**
 * THE PER-DEVICE CREDENTIAL: minted once by the desktop, kept only as a digest,
 * compared in constant time, and revocable (#135).
 *
 * #135's ruling: after pairing succeeds the desktop issues that phone its own
 * credential; the phone stores it and presents it when it connects; the desktop
 * keeps only what it needs to verify it; revoking the device deletes it on the
 * desktop, and its live sockets close. This file is that sentence, minus the
 * phone's half.
 *
 * ## What is kept, and why a plain SHA-256 is enough
 *
 * The desktop keeps SHA-256 of the credential, keyed by device id, and never
 * the credential. A password would need a slow KDF, because a password is
 * guessable and a stolen digest can be attacked offline. This is not a
 * password: it is 32 bytes of CSPRNG output, so a stolen digest is 2^256 of
 * work away from the credential behind it, and a slow hash would buy nothing
 * but a slower upgrade. The digest is what `apps/server/src/token.ts` compares
 * too, for the reason it gives: fixed width, so `timingSafeEqual` never sees
 * two lengths.
 *
 * ## Where it is kept is NOT decided here
 *
 * {@link CredentialStore} is an interface because persistence is #133's open
 * question. {@link createMemoryCredentialStore} is the one implementation, and
 * it forgets every device when the process ends — correct for tests, and not
 * a registry anybody should ship.
 *
 * ## The format
 *
 *     <deviceId>.<secret>
 *
 * `deviceId` is 16 random bytes and `secret` 32, each base64url with no
 * padding, so 22 and 43 characters. base64url has no `.`, so the split is
 * unambiguous, and the phone stores ONE opaque string. The digest covers the
 * whole string, device id included, so a secret cannot be replayed under
 * another device's id.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import { isOpenedWindow, type PairingWindow } from '../pairing/index.js';

/** 16 bytes of device id: an identifier, not a secret, and never reused. */
const DEVICE_ID_BYTES = 16;
/** 32 bytes of secret: #135 asks for at least 32, and 256 bits is the floor. */
const SECRET_BYTES = 32;
/** SHA-256's output width. A stored digest of any other width is refused. */
const DIGEST_BYTES = 32;

/** Exactly what {@link DeviceCredentials.mint} produces, and nothing else. */
const CREDENTIAL_SHAPE = /^([A-Za-z0-9_-]{22})\.[A-Za-z0-9_-]{43}$/;

/**
 * What an unknown device's presentation is compared against, so an unknown
 * device takes the same path as a known one with the wrong secret. Device ids
 * are not secret; this keeps the comparison one shape rather than two, which
 * is the property worth having whether or not the id is.
 */
const UNKNOWN_DEVICE = randomBytes(DIGEST_BYTES);

/**
 * What `revoke` writes over a digest before deleting it: zero bytes, which no
 * digest is, so `verify` refuses it on width alone.
 */
const TOMBSTONE = new Uint8Array(0);

declare const CREDENTIALS_BRAND: unique symbol;

/**
 * Where the digests live. Persistence is #133's decision, not this file's.
 *
 * ASYNC, because every persistent answer — a file under the app data
 * directory, the OS keychain — is. The listener awaits it at the upgrade, and
 * `listener.close()` destroys an upgrade still waiting on it.
 */
export interface CredentialStore {
  /** The digest stored for a device, or undefined if there is none. */
  get(deviceId: string): Promise<Uint8Array | undefined>;
  /**
   * Store a device's digest. Never called with the credential itself.
   *
   * ALSO CALLED WITH AN EMPTY ARRAY, by `revoke`, before it deletes: a
   * TOMBSTONE, which `verify` refuses because it is not a digest's width. A
   * store must keep what it is given, the empty array included, so a revocation
   * whose delete fails is still a revocation after a restart.
   */
  set(deviceId: string, digest: Uint8Array): Promise<void>;
  /** Forget a device. Resolves true if there was a digest to forget. */
  delete(deviceId: string): Promise<boolean>;
}

/** A credential, as handed to the caller that completed pairing. */
export interface MintedCredential {
  readonly deviceId: string;
  /**
   * The secret the phone presents. RETURNED ONCE: nothing here keeps it, logs
   * it, or can produce it again, so a caller that drops it has a phone that
   * must pair again.
   */
  readonly credential: string;
}

/**
 * The desktop's registry of paired devices, as far as authentication needs one.
 *
 * BRANDED, so a listener cannot be handed `{ verify: async () => 'anyone' }`.
 * The only way to hold one is {@link createDeviceCredentials}, which is the
 * same argument `apps/server/src/binding.ts` makes for `AuthToken`: a gate
 * that can be written down as a literal is a gate a test double ships as.
 */
export interface DeviceCredentials {
  readonly [CREDENTIALS_BRAND]: true;
  /**
   * Mint a credential for the phone that just completed pairing.
   *
   * ONLY FOR A PAIRING THAT COMPLETED, AND ONCE PER PAIRING. The window must
   * be `claimed` — the exchange succeeded — and a window that has minted
   * before is refused, even if the first mint's store write failed. So a
   * credential cannot be made without a pairing behind it, and one pairing
   * cannot be spent into two devices.
   */
  mint(window: PairingWindow, now: number): Promise<MintedCredential>;
  /**
   * The device a presented credential belongs to, or null.
   *
   * Null for anything malformed, unknown, wrong or revoked, with no reason
   * attached: the peer is told 401 whichever it was.
   */
  verify(presented: string): Promise<string | null>;
  /**
   * Has this device been revoked in this process? Synchronous, so the listener
   * can ask it in the same turn it admits a tunnel — after the store read that
   * `verify` awaited, with nothing in between.
   */
  isRevoked(deviceId: string): boolean;
  /**
   * Revoke a device: forget its digest and close its live tunnels.
   *
   * THE REFUSAL COMES FIRST, synchronously, before the store is even asked. A
   * `verify` already waiting on the store for this device finishes into a
   * refusal, and a store whose delete fails still leaves the device refused for
   * the life of the process — the rejection is rethrown, the device is not let
   * back in.
   *
   * AND IT OUTLIVES THE PROCESS. Before the delete, the digest is overwritten
   * with a tombstone (see {@link CredentialStore.set}), so a delete that fails
   * leaves a row no registry over the same store will accept — not the digest a
   * restarted registry, with an empty `revoked` set, would let back in. The
   * delete's failure is still rethrown, since the store is not in the state
   * the caller asked for.
   */
  revoke(deviceId: string): Promise<boolean>;
  /**
   * Be told when a device is revoked. The listener's use: close that device's
   * live tunnels. `revoke` waits for every watcher. Returns the unsubscribe.
   */
  watchRevocations(onRevoke: (deviceId: string) => Promise<void>): () => void;
}

/**
 * Windows that have minted a credential, across every registry in the process.
 * Module-level rather than per registry, so two registries cannot each spend
 * one pairing.
 */
const spent = new WeakSet<PairingWindow>();

/** SHA-256 of the credential, as the bytes a store keeps. */
function digest(credential: string): Buffer {
  return createHash('sha256').update(credential, 'utf8').digest();
}

/**
 * THE COMPARISON, AND THE ONLY ONE.
 *
 * `timingSafeEqual`, over two digests that are both {@link DIGEST_BYTES} long
 * by the time they arrive — so it never throws, and it never short-circuits on
 * the first differing byte the way `===` on strings or `Buffer.equals` may.
 * `tests/tunnel-admission.test.ts` reads this function's body and fails if it
 * compares any other way.
 */
function digestsMatch(stored: Uint8Array, presented: Uint8Array): boolean {
  return timingSafeEqual(stored, presented);
}

export function createDeviceCredentials(store: CredentialStore): DeviceCredentials {
  const revoked = new Set<string>();
  const watchers = new Set<(deviceId: string) => Promise<void>>();

  return {
    async mint(window, now) {
      // A window `openWindow` made, not an object that answers `claimed`: the
      // brand is a type, and this is the same question asked at runtime.
      if (!isOpenedWindow(window)) {
        throw new Error('tunnel: a device credential is minted only against a pairing window.');
      }
      if (window.state(now) !== 'claimed') {
        throw new Error('tunnel: a device credential is minted only for a pairing that completed.');
      }
      if (spent.has(window)) {
        throw new Error('tunnel: this pairing has already minted a device credential.');
      }
      // Spent BEFORE the store write, so a failed write does not reopen it and
      // a second concurrent mint on the same window is refused.
      spent.add(window);
      const deviceId = randomBytes(DEVICE_ID_BYTES).toString('base64url');
      const credential = `${deviceId}.${randomBytes(SECRET_BYTES).toString('base64url')}`;
      await store.set(deviceId, digest(credential));
      return { deviceId, credential };
    },

    async verify(presented) {
      const shape = CREDENTIAL_SHAPE.exec(presented);
      if (shape === null) return null;
      const deviceId = shape[1]!;

      const stored = await store.get(deviceId);
      // A digest of the wrong width is a store that is broken or tampered
      // with, and is refused rather than handed to a comparison that throws.
      const known = stored !== undefined && stored.byteLength === DIGEST_BYTES;
      const matched = digestsMatch(known ? stored : UNKNOWN_DEVICE, digest(presented));

      // Asked AFTER the await, and only there: a revocation that landed while
      // the store was being read wins, and so does one whose delete failed and
      // left the digest behind.
      return known && matched && !revoked.has(deviceId) ? deviceId : null;
    },

    isRevoked: (deviceId) => revoked.has(deviceId),

    async revoke(deviceId) {
      revoked.add(deviceId);
      const closing = Promise.allSettled([...watchers].map((watcher) => watcher(deviceId)));
      try {
        // The tombstone first, so the delete below failing is not the digest
        // surviving. Its own failure is not fatal: the delete that follows is
        // what removes the digest, and a delete that fails too is rethrown.
        await store.set(deviceId, TOMBSTONE).catch(() => undefined);
        return await store.delete(deviceId);
      } finally {
        await closing;
      }
    },

    watchRevocations(onRevoke) {
      watchers.add(onRevoke);
      return () => {
        watchers.delete(onRevoke);
      };
    },
  } as DeviceCredentials;
}

/**
 * Digests in a `Map`, gone when the process ends.
 *
 * FOR TESTS, and for nothing that has to remember a phone across a restart —
 * where the registry persists is #133's open decision. Copies in and out, so a
 * caller holding a returned digest cannot edit the one stored.
 */
export function createMemoryCredentialStore(): CredentialStore {
  const digests = new Map<string, Uint8Array>();
  return {
    async get(deviceId) {
      const found = digests.get(deviceId);
      return found === undefined ? undefined : new Uint8Array(found);
    },
    async set(deviceId, value) {
      digests.set(deviceId, new Uint8Array(value));
    },
    async delete(deviceId) {
      return digests.delete(deviceId);
    },
  };
}
