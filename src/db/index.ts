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
import {
  upgradeMessageReachAxes,
  upgradeMessageReachRows,
  upgradeMessageReach,
} from '@/db/reach';

export { upgradeVariants, type LegacyMessageRow, type VariantUpgrade } from '@/db/variants';
export { supersededTemplate, upgradeModelTemplates, type StoredModelRow } from '@/db/model-template';
export {
  upgradeMessageReach,
  upgradeMessageReachAxes,
  upgradeReach,
  upgradeReachValue,
  type LegacyReachRow,
  type ReachUpgrade,
} from '@/db/reach';

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

/** What a paired host lets this phone use it for. `inference` is the only grant v1 writes (#133). */
export type PairedDeviceCapability = 'inference';

/**
 * A desktop or headless server this phone has paired with (#133).
 *
 * LANDED BEFORE ANYTHING CAN WRITE IT. The owner's #133 ruling lets this table
 * arrive tested but unreachable, ahead of the pairing controller, the
 * paired-devices panel (#137) and the privacy copy, which land together.
 * Nothing in `src/` reads or writes it until then, and
 * `tests/db-paired-devices.test.ts` fails the day something does.
 *
 * WHAT IS NOT HERE, ON PURPOSE:
 *
 *   - The CREDENTIAL. The desktop mints `<deviceId>.<secret>` and the phone
 *     presents it on every connection, but where the phone keeps that secret
 *     is not ruled (#135: an OS keychain through the socket plugin, or a row
 *     like an API key). A column would decide it by default, in the same
 *     database the model-driven tools run beside. So there is no column.
 *   - The desktop's DIGEST of that credential. That is the desktop's record,
 *     kept in its main process (#133 ruling, #179), not the phone's.
 *   - Any TRANSCRIPT, and any MODEL LIST or capability cache. Those are
 *     derived and go stale, and a stale model list is how a phone offers a
 *     model the desktop no longer has. Ask the host.
 *
 * ERASING HERE DOES NOT REACH THE DESKTOP. `eraseEverything()` deletes this
 * table with the rest of the database, and the desktop still holds its record
 * of this phone, and will accept the credential if it is presented again. That
 * asymmetry is revocation's to close (#131 item 6), not this table's.
 *
 * The shell does not project this table (`tests/shell.test.ts`).
 */
export interface PairedDeviceRecord {
  /**
   * The `deviceId` the host minted: the part of the credential before the dot
   * (packages/tunnel/src/host/credential.ts), 16 bytes of base64url.
   *
   * The same id the desktop's registry keys on and a turn's
   * `{ kind: 'paired', device }` reach carries (`PairedDevice` in
   * `src/domain/chat.ts`), so a transcript, this row and the host's record
   * agree about which device is which (#125). Not reused after unpairing.
   */
  readonly id: string;
  /**
   * The host certificate's SPKI fingerprint, base64: the 32 trust bytes the
   * pairing code carried (#181). Indexed, so a reconnect can find the row for
   * the certificate it was actually shown.
   */
  readonly spkiPin: string;
  /**
   * The pairing code's host-kind byte, as words: 1 is `desktop`, 2 is `server`
   * (`HOST_DESKTOP`/`HOST_SERVER` in packages/tunnel/src/pairing). Words and
   * not the byte, because `src/db` may not import the pairing half
   * (`tests/layering.test.ts`).
   */
  readonly hostKind: 'desktop' | 'server';
  /** The host's name as it was at pairing, shown to a person. */
  readonly name: string;
  /**
   * A CACHE of where the host said it might be reached, most-preferred first,
   * as text. May go stale; the pin, not the address, says who answered.
   */
  readonly addresses: readonly string[];
  /** A cache, as `addresses` is. */
  readonly port: number;
  readonly pairedAt: number;
  /**
   * Grants, not an identity: a later capability is a new grant on an existing
   * pairing rather than a second pairing system, and revoking drops grants
   * (#133, #131).
   */
  readonly capabilities: readonly PairedDeviceCapability[];
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
  pairedDevices!: EntityTable<PairedDeviceRecord, 'id'>;

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

    /*
     * v6 replaces the provenance boolean with a three-valued reach.
     *
     * Every stored assistant turn carries `provenance.local`, and the readers
     * — the chip, the transcript heading, the egress gate — now read
     * `provenance.reach` instead. Widening the type reaches no row on disk, so
     * without this an existing install renders every one of its past replies
     * with an unknown destination.
     *
     * {@link upgradeMessageReach} says what each row becomes, and what it
     * refuses to invent: nothing here writes `paired`, because no build that
     * wrote these rows could tunnel a turn.
     *
     * The schema is unchanged — no index mentions `provenance` — so the store
     * is restated for the version to have one, as v4 and v5 do.
     */
    this.version(6)
      .stores({ messages: 'id, chatId, createdAt, [chatId+createdAt]' })
      .upgrade(async (tx) => {
        await upgradeMessageReach(tx.table('messages'));
      });

    /**
     * v7: a reach says where it RAN as well as how far the bytes WENT.
     *
     * v6 gave every turn a three-arm `Reach`. #112 showed one axis cannot hold
     * a locally-hosted process with a vendor upstream — a `claude` CLI is on
     * this machine AND reaches api.anthropic.com, and labelling it either
     * `device` or `remote` gets something wrong that matters: `device` removes
     * the egress sheet and ships taint marks to a vendor; `remote` is secure
     * and silent about the machine.
     *
     * The conversion is lossless — the old three arms are the diagonal of the
     * new pair — so this is a rewrite and not a judgement call.
     *
     * ON THE VERSION NUMBER. #133 (a paired-device table) and #195 (a durable
     * queue) both describe themselves as v7. They cannot all be. This one is
     * v7 because it landed; both of those are unbuilt and blocked on substrate
     * that does not exist, and each will need re-reading against this before it
     * picks its own number. Whoever goes next takes v8.
     *
     * Schema unchanged — no index mentions `provenance` — so the store is
     * restated for the version to have one, as v4, v5 and v6 do.
     */
    this.version(7)
      .stores({ messages: 'id, chatId, createdAt, [chatId+createdAt]' })
      .upgrade(async (tx) => {
        await upgradeMessageReachRows(tx.table('messages'), upgradeMessageReachAxes);
      });

    /**
     * v8 — `Provenance.warnings` (#259).
     *
     * NO UPGRADE FUNCTION, and that is the whole migration. The field is
     * optional and every row written before this version simply does not have
     * one; there is nothing to convert, because the warnings those turns would
     * have carried were computed and discarded at the time. Backfilling them
     * would mean inventing them.
     *
     * The store is restated so the version has one, exactly as v4, v5, v6 and
     * v7 do — no index mentions `provenance`, so the schema is unchanged.
     *
     * ON THE VERSION NUMBER, per v7's note: #133 (a paired-device table) and
     * #195 (a durable queue) both still describe themselves as v7 in their
     * bodies. This is v8 because it landed. Whoever goes next takes v9.
     */
    this.version(8).stores({ messages: 'id, chatId, createdAt, [chatId+createdAt]' });

    /**
     * v9 — `ToolInvocation.receipt`, the record that an MCP call's arguments
     * were handed to a server (#92).
     *
     * NO UPGRADE FUNCTION, as v8. The field is optional, and a call made before
     * this version has no receipt because none was taken: backfilling one from
     * a stored invocation would state a time nobody recorded.
     *
     * Restated as v4 to v8 are; no index mentions `toolCalls`. Per v7's note,
     * #133 and #195 still describe themselves as v7. Whoever goes next takes
     * v10.
     */
    this.version(9).stores({ messages: 'id, chatId, createdAt, [chatId+createdAt]' });

    /**
     * v10 — the phone's paired-device table (#133), which the owner's ruling
     * placed at the next version after v9.
     *
     * ADDITIVE, NO UPGRADE FUNCTION, as `mcpServers` at v2: a new table
     * restates nothing an install holds and rewrites no row, so a v9 install
     * opens here with its chats and messages as they were. See
     * {@link PairedDeviceRecord} for what the row holds and, more to the
     * point, what it does not.
     *
     * ON THE VERSION NUMBER, per v7's note: #133 is v10 because it landed.
     * #195 (a durable queue) takes v11.
     */
    this.version(10).stores({ pairedDevices: 'id, spkiPin' });
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
