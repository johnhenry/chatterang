/**
 * Conversation model.
 *
 * Messages are stored in a shape close to the aimatey IR so that turning a
 * thread into an `IRChatRequest` is a projection, not a translation. Each
 * assistant message records which backend actually served it — that is what
 * lets a single thread honestly mix local and remote turns (PRD §3.5).
 */

import type { EngineId, SamplerSettings } from './manifest';

export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

export interface ImageAttachment {
  readonly kind: 'image';
  readonly id: string;
  readonly mediaType: string;
  /**
   * Size of the payload, for labelling. The bytes themselves live in the
   * `blobs` table keyed by this attachment's id — see src/lib/blobs.ts for why
   * they are not inline any more.
   */
  readonly bytes?: number;
  readonly width?: number;
  readonly height?: number;
}

export interface AudioAttachment {
  readonly kind: 'audio';
  readonly id: string;
  readonly mediaType: string;
  /** See ImageAttachment.bytes — the payload lives in the `blobs` table. */
  readonly bytes?: number;
  readonly durationMs?: number;
  readonly transcript?: string;
}

export type Attachment = ImageAttachment | AudioAttachment;

export interface ToolInvocation {
  readonly id: string;
  readonly name: string;
  readonly input: Record<string, unknown>;
  readonly output?: string;
  readonly isError?: boolean;
  readonly durationMs?: number;
}

/**
 * A device this install has paired with, as it was at the moment of the turn.
 *
 * COPIED IN, NEVER LOOKED UP. `src/domain/` may not import `@/db`, and more to
 * the point a provenance record is permanent while a pairing is not: a
 * transcript from March has to keep rendering after the desktop it names has
 * been unpaired, renamed, or thrown away. A record that stored only an id and
 * resolved the name at render time would go blank exactly when the user most
 * needs to read it.
 *
 * Both fields, because they answer different questions. `name` is the only
 * thing that can be shown to a person — "your desktop" is not a true label
 * when a user has paired three of them — and it is a snapshot, which is the
 * honest thing for it to be: it says what the device was called when the
 * reply came back. `id` is the stable join key, so a later screen can still
 * group turns by device across a rename, and so two desktops that share a
 * name are still two devices.
 */
export interface PairedDevice {
  /** Pairing id. Stable across a rename; not reused after unpairing. */
  readonly id: string;
  /** The device's name AS IT WAS when this turn ran. */
  readonly name: string;
}

/**
 * How far a reply travelled. Three destinations, one value.
 *
 * This replaces `local: boolean`, which had two answers for a question that
 * now has three. A paired desktop is neither: the bytes left this phone, so
 * it is not `local`, and no third party received them, so it is not `remote`
 * in the sense every surface in this app means by that word. A boolean cannot
 * hold that, and the failure mode of making it hold that is not cosmetic —
 * `local: true` for a tunnel removes the egress sheet (#144, #188), and
 * `local: false` raises a third-party consent prompt for the user's own
 * machine.
 *
 * It is a discriminated union rather than a bare string plus an optional
 * device field, for the reason {@link MessageVariant} is a record rather than
 * a string: the invalid state should not be constructible. "Paired, but the
 * app cannot say which device" is exactly as useless as "Remote", and a
 * `reach: 'paired'` with a `pairedDevice` someone forgot to set would render
 * as the label this whole change exists to stop the app printing.
 *
 * NOTHING WRITES `paired` YET. The producer is the tunnel (Track B), and the
 * chip and the copy that render it are #210–#219. What lands here is the shape
 * those tickets consume, so that none of them has to invent a private third
 * value of its own.
 */
export type Reach =
  /** Ran on this device. Nothing left it. */
  | { readonly kind: 'device' }
  /** Ran on a device the user paired. The bytes left this device; no third party saw them. */
  | { readonly kind: 'paired'; readonly device: PairedDevice }
  /** Served by a third party — a provider connection. */
  | { readonly kind: 'remote' };

/** Ran here. */
export const REACH_DEVICE: Reach = Object.freeze({ kind: 'device' as const });

/** Went to a third party. */
export const REACH_REMOTE: Reach = Object.freeze({ kind: 'remote' as const });

/** Ran on one named paired device. */
export function reachPaired(device: PairedDevice): Reach {
  return { kind: 'paired', device: { id: device.id, name: device.name } };
}

/** Where a message was produced. Drives the local/remote colour split. */
export interface Provenance {
  /** aimatey backend-adapter id that served the request. */
  readonly backendId: string;
  readonly engine: EngineId;
  readonly modelId: string;
  readonly modelName: string;
  /**
   * How far this reply travelled. Was `local: boolean`; the Dexie v6 upgrade
   * (`src/db/reach.ts`) rewrites stored rows.
   */
  readonly reach: Reach;
  /** Set when the router fell back from another backend. */
  readonly fallbackFrom?: string;
  readonly fallbackReason?: string;
  /**
   * Whether this reply's request carried tool output off the device.
   *
   * Absent when there was no tool output in play. A remote message that
   * carried the contents of your conversations is materially different from
   * one that carried only the words you typed, and the chip alone cannot say
   * which it was.
   */
  readonly toolEgress?: 'granted' | 'withheld';
}

/* ── Reading a reach ────────────────────────────────────────────────── */

/**
 * The four answers a reader can get, including the one the type says is
 * impossible.
 *
 * `unknown` is not a member of {@link Reach} and cannot be written. It is what
 * a reader gets from a row that reached it without the v6 upgrade having run —
 * a database restored from a backup, an import from another install, a row
 * hand-written by a future writer that forgot the field. The alternative to
 * naming that case is `provenance.reach.kind` throwing inside a renderer,
 * which takes the whole thread down rather than one label with it.
 *
 * A reader that must NAME the destination should switch on this and print
 * nothing for `unknown`, which is what the app already does with an absent
 * `provenance` (see {@link MessageVariant.provenance}).
 */
export type ReachKind = 'device' | 'paired' | 'remote' | 'unknown';

/** What kind of reach a record carries, tolerating a row that has none. */
export function reachKind(provenance: { readonly reach?: Reach } | undefined): ReachKind {
  const kind = provenance?.reach?.kind;
  return kind === 'device' || kind === 'paired' || kind === 'remote' ? kind : 'unknown';
}

/**
 * Did this reply run on THIS device?
 *
 * The narrow question, and the only one that may be used to grant something.
 * Unknown answers `false`: a row whose reach was never written down has not
 * been shown to have stayed here.
 */
export function ranOnDevice(provenance: { readonly reach?: Reach } | undefined): boolean {
  return reachKind(provenance) === 'device';
}

/**
 * Did the bytes leave this device?
 *
 * True for `paired` as well as `remote` — a tunnelled turn crossed the network
 * even though nobody else read it, and every question about egress, consent
 * and grants is about that crossing rather than about who was at the far end.
 * Unknown answers `true`, which is the direction unknown has to fail in here.
 */
export function leftThisDevice(provenance: { readonly reach?: Reach } | undefined): boolean {
  return reachKind(provenance) !== 'device';
}

/**
 * Did a third party serve this reply?
 *
 * The question that gates anything a provider must never see — this app's own
 * bookkeeping marks, for instance (`src/ai/taint.ts`). `paired` answers
 * `false`, because the far end is the user's own machine running this same
 * code. Unknown answers `true`: failing to strip is a leak, and failing to
 * mark is only a missing chip.
 *
 * Both this and {@link leftThisDevice} answer `true` for unknown, so no
 * caller can use the pair to derive a confident label out of a row that has
 * none. Labelling goes through {@link reachKind}.
 */
export function reachedThirdParty(provenance: { readonly reach?: Reach } | undefined): boolean {
  const kind = reachKind(provenance);
  return kind === 'remote' || kind === 'unknown';
}

/** The paired device a reply ran on, or undefined if it was not a paired one. */
export function pairedDevice(
  provenance: { readonly reach?: Reach } | undefined,
): PairedDevice | undefined {
  const reach = provenance?.reach;
  return reach?.kind === 'paired' ? reach.device : undefined;
}

export interface GenerationStats {
  readonly promptTokens?: number;
  /** Prompt tokens served from the KV cache instead of re-processed. */
  readonly cachedTokens?: number;
  readonly completionTokens?: number;
  /** Time from send to first token. */
  readonly ttftMs?: number;
  readonly totalMs?: number;
  readonly tokensPerSecond?: number;
  /** Fraction of draft tokens accepted, when speculative decoding was on. */
  readonly draftAcceptance?: number;
  readonly computeBackend?: string;
  readonly peakMemoryBytes?: number;
}

/**
 * One generation of an assistant turn.
 *
 * This used to be a bare string, and that is the whole defect: `regenerate`
 * carried the previous TEXT forward and `cycleVariant` swapped the TEXT back,
 * while `provenance` — the chip, the model name, the local/remote split — sat
 * on the row and never moved. So a reply that came back from a provider was
 * rendered under the ember flame, this app's own mark for a turn that ran on
 * the device, and written into the exported transcript as "(on device)".
 *
 * The fix is not a check at the two call sites. It is that a generation and
 * where it came from are one value, so there is no longer a way to move one
 * without the other. Everything a turn is judged by travels in here:
 * `provenance` for where it ran, `toolCalls` for what it read (which is what
 * taint is derived from), `stats` for what it cost, `thinking` for the trace.
 */
export interface MessageVariant {
  readonly content: string;
  readonly thinking?: string;
  readonly toolCalls?: readonly ToolInvocation[];
  /**
   * Where this generation ran.
   *
   * Absent means UNKNOWN — never "on device". A generation recovered from a
   * build that stored variants as bare strings has no recorded origin, and the
   * plausible guess (the row's own provenance) is precisely the confident
   * falsehood this record exists to prevent. {@link MessageVariant.unrecorded}
   * says which kind of absence this is.
   */
  readonly provenance?: Provenance;
  readonly stats?: GenerationStats;
  /**
   * Set on text whose origin is not a recorded generation: one recovered by
   * the v4 upgrade from a bare `string` variant, or one a person has edited by
   * hand, so that no model can honestly be named beside it.
   *
   * It renders as no chip and no model name, which is what the UI already does
   * for a message with no provenance, and it counts as tool-derived for taint:
   * its tool use cannot be shown either, and unknown has to fail closed in
   * that direction while it fails silent in the other.
   */
  readonly unrecorded?: true;
}

export interface Message {
  readonly id: string;
  readonly chatId: string;
  readonly role: MessageRole;
  content: string;
  /** Reasoning trace, kept separate so it can be collapsed or hidden. */
  thinking?: string;
  readonly attachments?: readonly Attachment[];
  readonly toolCalls?: readonly ToolInvocation[];
  readonly provenance?: Provenance;
  readonly stats?: GenerationStats;
  readonly createdAt: number;
  /** Set while a message is still being generated. */
  streaming?: boolean;
  /** Set when generation failed; content holds the user-facing explanation. */
  error?: string;
  /**
   * Every generation of this turn, oldest last-but-one, newest last —
   * INCLUDING the one currently projected onto the fields above.
   *
   * The list used to hold only the generations that were NOT on display, with
   * the row itself standing in for the current one. That cost a second defect
   * as well as the provenance one: `cycleVariant` overwrote `content` in
   * place, so the row's own newest text was gone the moment you looked at an
   * older one and could not be got back. Holding every generation as data
   * makes the row a projection of `variants[variantIndex]` rather than a
   * participant, so there is nothing left to overwrite.
   *
   * Absent on a turn that has never been regenerated: one generation needs no
   * list, and the row alone is not ambiguous.
   */
  readonly variants?: readonly MessageVariant[];
  /** Which of {@link variants} the fields above are showing. */
  variantIndex?: number;
}

export type ChatMode = 'chat' | 'task';

/** One conversation's permission to send tool output to one connection. */
export interface EgressGrant {
  /** Router/connection id, not the provider family — the key the engine gates on. */
  readonly connectionId: string;
  readonly grantedAt: number;
}

export interface Chat {
  readonly id: string;
  title: string;
  readonly mode: ChatMode;
  personaId: string | null;
  modelId: string | null;
  /** Per-chat sampler overrides on top of the model defaults. */
  sampler: Partial<SamplerSettings> | null;
  /** Tool ids enabled for this chat. */
  tools: string[];
  /**
   * Destinations this conversation has agreed may receive tool output.
   *
   * Per conversation and per connection, because neither alone is the decision
   * the user made: enabling `bash` says nothing about where its output goes,
   * and connecting a provider says nothing about which of your conversations
   * it may read. Absent on chats created before the grant existed, which reads
   * as "no grants" — the safe way round.
   */
  egressGrants?: EgressGrant[];
  showThinking: boolean;
  readonly createdAt: number;
  updatedAt: number;
  pinned?: boolean;
  /** Cached count so the chat list does not have to load messages. */
  messageCount: number;
  /** Cached preview line for the chat list. */
  preview: string;
}

/* ── Variants ───────────────────────────────────────────────────────── */

/**
 * The row's currently displayed generation, read back as a record.
 *
 * Used when a turn that has never been regenerated becomes the first entry of
 * its own list. Everything {@link applyVariant} writes, this reads.
 */
export function currentVariant(message: Message): MessageVariant {
  return {
    content: message.content,
    thinking: message.thinking,
    toolCalls: message.toolCalls,
    provenance: message.provenance,
    stats: message.stats,
  };
}

/**
 * Project one generation onto the row that displays it.
 *
 * Every field is written, including the ones that are absent on the incoming
 * variant — that is the point. A partial projection is how the old code left
 * `provenance` behind while `content` moved, and `undefined` here means the
 * chip, the model name, the tool blocks and the tok/s readout all disappear
 * together rather than describing a turn that is no longer on screen.
 */
export function applyVariant(message: Message, index: number): Message {
  const variant = message.variants?.[index];
  if (!variant) return message;
  return {
    ...message,
    content: variant.content,
    thinking: variant.thinking,
    toolCalls: variant.toolCalls,
    provenance: variant.provenance,
    stats: variant.stats,
    variantIndex: index,
  };
}

/**
 * Is the generation on display one whose origin was never written down?
 *
 * Read by the taint derivation, which cannot see a `toolCalls` list that was
 * never recorded and must therefore treat the turn as tool-derived.
 */
export function displaysUnrecorded(message: Message): boolean {
  const index = message.variantIndex;
  if (index === undefined) return false;
  return message.variants?.[index]?.unrecorded === true;
}

export function newId(prefix: string): string {
  const random =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID().replaceAll('-', '').slice(0, 12)
      : Math.random().toString(36).slice(2, 14);
  return `${prefix}_${random}`;
}

/** Derive a chat title from its first user message. */
export function deriveTitle(text: string): string {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  if (!cleaned) return 'New chat';
  return cleaned.length > 42 ? `${cleaned.slice(0, 41).trimEnd()}…` : cleaned;
}

/**
 * Split a raw model response into visible answer and reasoning trace.
 * Handles the `<think>` convention used by reasoning-tuned open models, and
 * returns partial reasoning while a block is still open so the UI can render
 * the trace live (PRD §3.4 — Thinking Mode).
 */
export function splitThinking(raw: string): { content: string; thinking: string; open: boolean } {
  const OPEN = /<(think|thinking|reasoning)>/i;
  const CLOSE = /<\/(think|thinking|reasoning)>/i;

  const openMatch = OPEN.exec(raw);
  if (!openMatch) return { content: raw, thinking: '', open: false };

  const before = raw.slice(0, openMatch.index);
  const rest = raw.slice(openMatch.index + openMatch[0].length);

  const closeMatch = CLOSE.exec(rest);
  if (!closeMatch) {
    // Block still open — everything after the tag is reasoning so far.
    return { content: before, thinking: rest, open: true };
  }

  const thinking = rest.slice(0, closeMatch.index);
  const after = rest.slice(closeMatch.index + closeMatch[0].length);
  const tail = splitThinking(after);
  return {
    content: (before + tail.content).replace(/^\n+/, ''),
    thinking: (thinking + (tail.thinking ? `\n${tail.thinking}` : '')).trim(),
    open: tail.open,
  };
}
