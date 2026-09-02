/**
 * Local database.
 *
 * Everything lives on the device: chats, messages, personas, model records,
 * benchmark runs, provider connections. Nothing here is synchronised
 * anywhere, and there is no server-side counterpart to any of these tables.
 */

import type { McpServerConfig } from '@/domain/mcp';
import Dexie, { type EntityTable } from 'dexie';

import type { Chat, Message } from '@/domain/chat';
import type { Persona } from '@/domain/persona';
import type { ComputeBackend, EngineId, ModelManifest, SamplerSettings } from '@/domain/manifest';
import type { ProviderConnection } from '@/ai/providers';
import { upgradeVariants, type LegacyMessageRow } from '@/db/variants';
import { upgradeModelTemplates } from '@/db/model-template';

export { upgradeVariants, type LegacyMessageRow, type VariantUpgrade } from '@/db/variants';
export { supersededTemplate, upgradeModelTemplates, type StoredModelRow } from '@/db/model-template';

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

/** An attachment payload. See src/lib/blobs.ts for why these are not inline. */
export interface StoredBlob {
  readonly id: string;
  readonly mediaType: string;
  readonly data: Blob;
  readonly bytes: number;
  readonly createdAt: number;
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
  mcpServers!: EntityTable<McpServerConfig, 'id'>;
  blobs!: EntityTable<StoredBlob, 'id'>;

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
    // v2 adds remote MCP servers. Additive only — Dexie carries v1 data
    // forward, so an existing install keeps its chats.
    this.version(2).stores({
      mcpServers: 'id, name, enabled, createdAt',
    });
    /*
     * v3 moves attachment payloads out of the message row.
     *
     * They were stored inline as base64, so opening a conversation
     * deserialised every image in it before rendering a character. The upgrade
     * rewrites existing messages: each attachment's base64 becomes a Blob in
     * `blobs` keyed by the attachment id, and the attachment keeps only its
     * metadata.
     *
     * Done inside the Dexie upgrade transaction so it is atomic — a partial
     * migration would leave attachments with neither inline data nor a blob
     * row, which renders as a permanently broken image with no way back.
     */
    this.version(3)
      .stores({ blobs: 'id, createdAt' })
      .upgrade(async (tx) => {
        const messages = await tx.table('messages').toArray();
        for (const message of messages) {
          const attachments = message.attachments as
            | { id: string; mediaType: string; data?: string }[]
            | undefined;
          if (!attachments?.some((a) => typeof a.data === 'string')) continue;

          const stripped = [];
          for (const attachment of attachments) {
            if (typeof attachment.data !== 'string') {
              stripped.push(attachment);
              continue;
            }
            const blob = base64ToBlobSync(attachment.data, attachment.mediaType);
            await tx.table('blobs').put({
              id: attachment.id,
              mediaType: attachment.mediaType,
              data: blob,
              bytes: blob.size,
              createdAt: message.createdAt ?? Date.now(),
            });
            const { data: _dropped, ...rest } = attachment;
            stripped.push({ ...rest, bytes: blob.size });
          }
          await tx.table('messages').update(message.id, { attachments: stripped });
        }
      });

    /*
     * v4 gives a variant its own provenance.
     *
     * Through v3, `Message.variants` was `string[]` — the TEXT of the
     * generations not on display — while `provenance`, `toolCalls` and `stats`
     * sat on the row describing whichever generation was made last. Switching
     * variants moved the text and left the rest, so a reply that came back
     * from a provider was rendered under the on-device flame and exported as
     * "(on device)". `MessageVariant` makes that unrepresentable; this brings
     * existing rows into it.
     *
     * The schema is unchanged — no index mentions `variants` — so this version
     * restates the `messages` store and does its work in `upgrade`.
     */
    this.version(4)
      .stores({ messages: 'id, chatId, createdAt, [chatId+createdAt]' })
      .upgrade(async (tx) => {
        await tx
          .table('messages')
          .toCollection()
          .modify((message: Record<string, unknown>) => {
            const upgraded = upgradeVariants(message as LegacyMessageRow);
            if (!upgraded) return;
            message.variants = upgraded.variants;
            message.variantIndex = upgraded.variantIndex;
            // Deleted rather than set: these three describe a generation this
            // row can no longer be shown to be displaying. `upgradeVariants`
            // says when, and why it will not guess instead.
            if (upgraded.detach) {
              delete message.provenance;
              delete message.stats;
              delete message.toolCalls;
            }
          });
      });

    /*
     * v5 re-decides a prompt template that was inferred wrongly.
     *
     * `install()` copies the manifest into the row verbatim and `load()` reads
     * it back unexamined, so a manifest field is frozen at install time —
     * including `promptTemplate`, which `backends/llama-cpp.ts` prefers over
     * `inferTemplate()`. Fixing the inference therefore fixes nothing for
     * anyone who already installed the model: a Gemma 4 installed before the
     * `gemma4` template existed still carries `'gemma'`, still gets markers
     * that are not in its vocabulary, and still answers "Australia's capital
     * city of Australia's capital city of".
     *
     * {@link upgradeModelTemplates} says which rows that describes and, more
     * importantly, which it refuses to touch — a catalogue entry's hand-set
     * template is not a stale guess and must survive this.
     *
     * The schema is unchanged; the store is restated so the version has one,
     * as v4 does.
     */
    this.version(5)
      .stores({ models: 'id, state, lastUsedAt, installedAt' })
      .upgrade(async (tx) => {
        await upgradeModelTemplates(tx.table('models'));
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
  await db.transaction('rw', db.chats, db.messages, db.blobs, async () => {
    const messages = await db.messages.where('chatId').equals(chatId).toArray();
    // Attachment payloads live in their own table now, so deleting the
    // conversation has to delete them too. Without this they orphan: rows no
    // message references, which nothing ever cleans up and which no UI can
    // show you. That is the growth problem this move was meant to fix,
    // reappearing one table over.
    const attachmentIds = messages.flatMap((m) => (m.attachments ?? []).map((a) => a.id));
    if (attachmentIds.length > 0) await db.blobs.bulkDelete(attachmentIds);
    await db.messages.where('chatId').equals(chatId).delete();
    await db.chats.delete(chatId);
  });
}

export async function clearAllConversations(): Promise<void> {
  await db.transaction('rw', db.chats, db.messages, db.blobs, async () => {
    await db.messages.clear();
    await db.chats.clear();
    // Every payload belonged to a conversation, so clearing them all clears
    // these too.
    await db.blobs.clear();
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

/**
 * Base64 -> Blob, duplicated from lib/blobs.ts on purpose.
 *
 * The Dexie upgrade runs during database open, before the module graph has
 * necessarily settled, and importing from lib/blobs.ts would create a cycle:
 * blobs.ts imports `db` from here. Twelve lines of duplication is the cheaper
 * of the two problems.
 */
function base64ToBlobSync(data: string, mediaType: string): Blob {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mediaType });
}
