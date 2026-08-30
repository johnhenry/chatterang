/**
 * Local database.
 *
 * Everything lives on the device: chats, messages, personas, model records,
 * benchmark runs, provider connections. Nothing here is synchronised
 * anywhere, and there is no server-side counterpart to any of these tables.
 */

import Dexie, { type EntityTable } from 'dexie';

import type { Chat, Message } from '@/domain/chat';
import type { Persona } from '@/domain/persona';
import type { ComputeBackend, EngineId, ModelManifest, SamplerSettings } from '@/domain/manifest';
import type { ProviderConnection } from '@/ai/providers';

export type InstallState = 'available' | 'queued' | 'downloading' | 'installed' | 'failed';

export interface InstalledModel {
  /** Manifest id. */
  id: string;
  manifest: ModelManifest;
  state: InstallState;
  /** Bytes fetched so far. */
  downloadedBytes: number;
  /** Absolute paths, keyed by role. */
  paths: Record<string, string>;
  /** Saved sampler settings for this model (PRD §3.1). */
  sampler: SamplerSettings;
  /** System prompt saved with the model, independent of any persona. */
  systemPrompt: string;
  installedAt: number | null;
  lastUsedAt: number | null;
  useCount: number;
  error?: string;
  /** Populated after a successful load. */
  lastBackend?: ComputeBackend;
}

export interface BenchmarkRun {
  id: string;
  modelId: string;
  modelName: string;
  engine: EngineId;
  backend: string;
  device: string;
  chipset: string;
  promptTokensPerSecond: number;
  generateTokensPerSecond: number;
  peakMemoryBytes: number;
  thermalStart: number;
  thermalEnd: number;
  samples: number[];
  repetitions: number;
  createdAt: number;
  /** Set once the user has consented to publishing this specific run. */
  uploadedAt: number | null;
}

export interface GeneratedImage {
  id: string;
  prompt: string;
  negativePrompt: string;
  /** Base64 PNG. */
  data: string;
  mediaType: string;
  width: number;
  height: number;
  steps: number;
  seed: number;
  modelId: string;
  durationMs: number;
  createdAt: number;
}

export interface MarketplaceEntitlement {
  /** Listing id from the marketplace catalog. */
  id: string;
  personaId: string;
  productId: string;
  purchasedAt: number;
  /** Store transaction id, retained for restore-purchases. */
  transactionId: string;
}

export interface AppSetting {
  key: string;
  value: unknown;
}

class ChatterangDatabase extends Dexie {
  chats!: EntityTable<Chat, 'id'>;
  messages!: EntityTable<Message, 'id'>;
  personas!: EntityTable<Persona, 'id'>;
  models!: EntityTable<InstalledModel, 'id'>;
  benchmarks!: EntityTable<BenchmarkRun, 'id'>;
  images!: EntityTable<GeneratedImage, 'id'>;
  connections!: EntityTable<ProviderConnection, 'id'>;
  entitlements!: EntityTable<MarketplaceEntitlement, 'id'>;
  settings!: EntityTable<AppSetting, 'key'>;

  constructor() {
    super('chatterang');
    this.version(1).stores({
      chats: 'id, updatedAt, mode, personaId, pinned',
      messages: 'id, chatId, createdAt, [chatId+createdAt]',
      personas: 'id, name, kind, updatedAt, builtin',
      models: 'id, state, lastUsedAt, installedAt',
      benchmarks: 'id, modelId, createdAt',
      images: 'id, createdAt',
      connections: 'id, providerId, enabled',
      entitlements: 'id, personaId',
      settings: 'key',
    });
  }
}

export const db = new ChatterangDatabase();

/* ── Setting helpers ────────────────────────────────────────────────── */

export async function readSetting<T>(key: string, fallback: T): Promise<T> {
  const row = await db.settings.get(key);
  return row ? (row.value as T) : fallback;
}

export async function writeSetting(key: string, value: unknown): Promise<void> {
  await db.settings.put({ key, value });
}

/* ── Cascading deletes ──────────────────────────────────────────────── */

export async function deleteChat(chatId: string): Promise<void> {
  await db.transaction('rw', db.chats, db.messages, async () => {
    await db.messages.where('chatId').equals(chatId).delete();
    await db.chats.delete(chatId);
  });
}

export async function clearAllConversations(): Promise<void> {
  await db.transaction('rw', db.chats, db.messages, async () => {
    await db.messages.clear();
    await db.chats.clear();
  });
}

/**
 * Delete everything the app has stored. Offered in Settings because a
 * privacy-first app has to make erasure as easy as it makes creation.
 */
export async function eraseEverything(): Promise<void> {
  await db.delete();
  await db.open();
}
