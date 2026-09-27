/**
 * One-time consent for an imported or marketplace persona's remote or
 * cli-agent provider preference (#23, #122; adversarial review, HIGH).
 *
 * The owner ruling this answers to: a self-authored persona's
 * `agentConfig.provider` routes silently, because the user wrote it
 * themselves. An imported or marketplace persona's is data from outside
 * this app, and naming a `remote-connection` the user happens to already
 * have — or, later, a `cli-agent` — must not be enough on its own to send a
 * turn there. `state/chat.ts`'s `resolvePersonaProvider` is the enforcement:
 * it checks `isGranted` before ever returning a connection to route to, and
 * falls back exactly as it would for a missing or disabled connection when
 * consent has not been given. This module is only the record of what was
 * granted, and the two actions — `grant`, `revoke` — that change it.
 *
 * Consent is per (persona, destination), not per persona alone: a persona
 * naming two different connections across edits is two different questions,
 * and the record for one must say nothing about the other.
 *
 * WHY THIS SURVIVES A REVOKED OR DELETED CONNECTION WITHOUT AN EXPLICIT
 * SWEEP. `destination` is the connection's OWN id. Deleting a connection and
 * adding a new one — even with the same label — mints a new id
 * (`newId('conn')`, `state/app.ts`), so a stale consent record simply never
 * matches anything again; there is nothing to clean up. The same is true if
 * a persona's `agentConfig.provider.connectionId` is edited to name a
 * different connection: the destination changes, and the old record answers
 * a question nobody is asking any more. What does NOT change the
 * destination — switching a connection off and back on — must not need a
 * fresh grant either, and does not: `resolvePersonaProvider` re-checks
 * `connection.enabled` separately, on every resolution.
 *
 * Persisted in the existing `settings` table rather than a new one: this is
 * exactly the shape `readSetting`/`writeSetting` already serve elsewhere
 * (`defaultPersonaId`), and a consent record is a flag, not a row with a
 * lifecycle of its own.
 */

import { create } from 'zustand';

import { db, writeSetting } from '@/db';

const KEY_PREFIX = 'providerConsent:';

/** The settings-table key for one (persona, destination) consent record. */
export function providerConsentKey(personaId: string, destination: string): string {
  return `${KEY_PREFIX}${personaId}:${destination}`;
}

interface ProviderConsentState {
  /** `providerConsentKey(...)` -> when it was granted. Loaded once at boot. */
  granted: Record<string, number>;

  /** Populates `granted` from disk. Call once, at app start (see App.tsx). */
  load: () => Promise<void>;
  /** Synchronous, because `resolveTarget` decides on every turn, not just at boot. */
  isGranted: (personaId: string, destination: string) => boolean;
  grant: (personaId: string, destination: string) => Promise<void>;
  revoke: (personaId: string, destination: string) => Promise<void>;
}

export const useProviderConsent = create<ProviderConsentState>((set, get) => ({
  granted: {},

  async load() {
    // `db.settings` has no "list by key prefix" — it is a flat key/value
    // table — so this reads the whole thing once and filters client-side.
    // Cheap in practice: one row per consent ever granted, not per chat or
    // per turn.
    const rows = await db.settings.toArray();
    const granted: Record<string, number> = {};
    for (const row of rows) {
      if (row.key.startsWith(KEY_PREFIX) && typeof row.value === 'number') {
        granted[row.key] = row.value;
      }
    }
    set({ granted });
  },

  isGranted(personaId, destination) {
    return providerConsentKey(personaId, destination) in get().granted;
  },

  async grant(personaId, destination) {
    const key = providerConsentKey(personaId, destination);
    const grantedAt = Date.now();
    await writeSetting(key, grantedAt);
    set({ granted: { ...get().granted, [key]: grantedAt } });
  },

  async revoke(personaId, destination) {
    const key = providerConsentKey(personaId, destination);
    await db.settings.delete(key);
    const granted = { ...get().granted };
    delete granted[key];
    set({ granted });
  },
}));
