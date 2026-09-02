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

/** Where a message was produced. Drives the local/remote colour split. */
export interface Provenance {
  /** aimatey backend-adapter id that served the request. */
  readonly backendId: string;
  readonly engine: EngineId;
  readonly modelId: string;
  readonly modelName: string;
  readonly local: boolean;
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
