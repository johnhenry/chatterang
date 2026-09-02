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
  /** Alternate generations for this turn, newest last. */
  readonly variants?: readonly string[];
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
