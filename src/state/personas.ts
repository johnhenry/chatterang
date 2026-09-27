/**
 * Persona state: the built-ins, anything the user has written or imported,
 * and marketplace entitlements.
 */

import { create } from 'zustand';

import { db, type MarketplaceEntitlement } from '@/db';
import { BUILT_IN_PERSONAS, MARKETPLACE, type MarketplaceListing } from '@/data/personas';
import {
  fromCharacterCard,
  toCharacterCard,
  type CharacterCardV2,
  type Persona,
  type PersonaDraft,
} from '@/domain/persona';
import { newId } from '@/domain/chat';
import { useApp } from '@/state/app';
import { purchase, restorePurchases } from '@/lib/billing';

interface PersonaState {
  loaded: boolean;
  byId: Record<string, Persona>;
  entitlements: Record<string, MarketplaceEntitlement>;
  defaultPersonaId: string | null;
  /** In-flight purchase, so the marketplace can show a spinner. */
  purchasing: string | null;

  load: () => Promise<void>;
  save: (draft: PersonaDraft) => Promise<string>;
  remove: (id: string) => Promise<void>;
  duplicate: (id: string) => Promise<string>;
  setDefault: (id: string | null) => Promise<void>;

  importCard: (card: CharacterCardV2) => Promise<string>;
  exportCard: (id: string) => CharacterCardV2 | null;

  acquire: (listing: MarketplaceListing) => Promise<void>;
  restore: () => Promise<void>;
}

export const usePersonas = create<PersonaState>((set, get) => ({
  loaded: false,
  byId: {},
  entitlements: {},
  defaultPersonaId: null,
  purchasing: null,

  async load() {
    const stored = await db.personas.toArray();

    // Built-ins are re-seeded on every launch so app updates can improve them,
    // but a user's own edits to a duplicate are never touched.
    const missing = BUILT_IN_PERSONAS.filter(
      (persona) => !stored.some((entry) => entry.id === persona.id),
    );
    if (missing.length > 0) await db.personas.bulkPut([...missing]);

    const all = [...stored.filter((entry) => !entry.builtin), ...BUILT_IN_PERSONAS];
    const byId: Record<string, Persona> = {};
    for (const persona of all) byId[persona.id] = persona;

    const entitlementRows = await db.entitlements.toArray();
    const entitlements: Record<string, MarketplaceEntitlement> = {};
    for (const row of entitlementRows) entitlements[row.id] = row;

    const defaultPersonaId =
      ((await db.settings.get('defaultPersonaId'))?.value as string | undefined) ?? 'persona_chatterang';

    set({ loaded: true, byId, entitlements, defaultPersonaId });
  },

  async save(draft) {
    const now = Date.now();
    const existing = draft.id ? get().byId[draft.id] : undefined;

    const persona: Persona = {
      ...draft,
      id: draft.id ?? newId('persona'),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      version: (existing?.version ?? 0) + 1,
      builtin: false,
      // Sticky across edits: re-saving an imported persona through the
      // editor does not launder its origin into 'authored' just because the
      // editor is where the save happened (#23, #122) — only a caller that
      // explicitly sets `draft.origin` (today, only `importCard`) overrides
      // it. A brand new persona with nothing set here — the ordinary editor
      // "create" path — is what 'authored' actually means.
      origin: draft.origin ?? existing?.origin ?? 'authored',
    };

    await db.personas.put(persona);
    set({ byId: { ...get().byId, [persona.id]: persona } });
    return persona.id;
  },

  async remove(id) {
    const persona = get().byId[id];
    if (!persona || persona.builtin) return;

    await db.personas.delete(id);
    const byId = { ...get().byId };
    delete byId[id];
    set({ byId });

    if (get().defaultPersonaId === id) await get().setDefault('persona_chatterang');
  },

  async duplicate(id) {
    const persona = get().byId[id];
    if (!persona) throw new Error('That persona no longer exists.');

    const { id: _id, builtin: _builtin, listingId: _listingId, ...rest } = persona;
    return get().save({ ...rest, name: `${persona.name} (copy)` });
  },

  async setDefault(id) {
    set({ defaultPersonaId: id });
    await db.settings.put({ key: 'defaultPersonaId', value: id });
  },

  async importCard(card) {
    const draft = fromCharacterCard(card);
    // Set here, from the import CODE PATH — never from the card's own
    // `agentConfig.source.forSurface`, which is attacker-controlled data
    // (#23, #122; adversarial review, HIGH). This is what gates a remote or
    // cli-agent `agentConfig.provider` behind the one-time consent in
    // `state/chat.ts`'s `resolvePersonaProvider`.
    const id = await get().save({ ...draft, origin: 'imported' });
    useApp.getState().toast(`Imported ${draft.name}.`, 'good');
    return id;
  },

  exportCard(id) {
    const persona = get().byId[id];
    return persona ? toCharacterCard(persona) : null;
  },

  async acquire(listing) {
    const app = useApp.getState();

    if (get().byId[listing.persona.id]) {
      app.toast(`${listing.persona.name} is already in your personas.`, 'info');
      return;
    }

    if (listing.price > 0 && listing.productId) {
      set({ purchasing: listing.id });
      try {
        const receipt = await purchase(listing.productId);
        const entitlement: MarketplaceEntitlement = {
          id: listing.id,
          personaId: listing.persona.id,
          productId: listing.productId,
          purchasedAt: Date.now(),
          transactionId: receipt.transactionId,
        };
        await db.entitlements.put(entitlement);
        set({ entitlements: { ...get().entitlements, [listing.id]: entitlement } });
      } catch (error) {
        app.toast(
          error instanceof Error ? error.message : 'The purchase did not complete.',
          'crit',
        );
        return;
      } finally {
        set({ purchasing: null });
      }
    }

    const now = Date.now();
    const persona: Persona = {
      ...listing.persona,
      createdAt: now,
      updatedAt: now,
      version: 1,
      builtin: false,
      // From the acquisition code path, not from `listing.persona` itself
      // (#23, #122) — same reasoning as `importCard`.
      origin: 'marketplace',
    };
    await db.personas.put(persona);
    set({ byId: { ...get().byId, [persona.id]: persona } });
    app.toast(`${persona.name} added to your personas.`, 'good');
  },

  async restore() {
    const app = useApp.getState();
    try {
      const receipts = await restorePurchases();
      if (receipts.length === 0) {
        app.toast('No previous purchases found for this account.', 'info');
        return;
      }

      let added = 0;
      for (const receipt of receipts) {
        const match = MARKETPLACE.find((entry) => entry.productId === receipt.productId);
        if (!match) continue;

        await db.entitlements.put({
          id: match.id,
          personaId: match.persona.id,
          productId: receipt.productId,
          purchasedAt: receipt.purchasedAt,
          transactionId: receipt.transactionId,
        });

        if (!get().byId[match.persona.id]) {
          const now = Date.now();
          await db.personas.put({
            ...match.persona,
            createdAt: now,
            updatedAt: now,
            version: 1,
            builtin: false,
            origin: 'marketplace',
          });
          added += 1;
        }
      }

      await get().load();
      app.toast(
        added > 0 ? `Restored ${added} persona${added === 1 ? '' : 's'}.` : 'Purchases restored.',
        'good',
      );
    } catch (error) {
      app.toast(error instanceof Error ? error.message : 'Could not restore purchases.', 'crit');
    }
  },
}));

/* ── Selectors ──────────────────────────────────────────────────────── */

export function personaList(state: PersonaState): Persona[] {
  return Object.values(state.byId).sort((a, b) => {
    if (Boolean(a.builtin) !== Boolean(b.builtin)) return a.builtin ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

export function ownsListing(state: PersonaState, listing: MarketplaceListing): boolean {
  return Boolean(state.entitlements[listing.id]) || Boolean(state.byId[listing.persona.id]);
}
