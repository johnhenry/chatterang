/**
 * Context-window budgeting.
 *
 * A model's context is a hard wall. Walk into it and llama.cpp truncates
 * silently from the front — which usually means the system prompt and the
 * persona go first, and the model appears to have had a personality
 * transplant mid-conversation. Budgeting here, before the request leaves,
 * means the app decides what to drop and can say what it dropped.
 *
 * Estimation, not tokenisation, on purpose. The exact count is only knowable
 * from a loaded model (`LlamaCpp.countTokens`), which is async and needs the
 * model resident — neither is available while assembling a request. So this
 * estimates conservatively to decide what fits, and the UI reports the *real*
 * `promptTokens` the engine returns once a turn completes.
 */

import type { IRMessage, MessageContent } from '@johnhenry/aimatey-types';

/**
 * Characters per token for English prose under a byte-pair vocabulary.
 * Deliberately low (a pessimistic estimate produces a larger token count),
 * because over-estimating costs a dropped turn and under-estimating costs a
 * truncated system prompt.
 */
const CHARS_PER_TOKEN = 3.3;

/**
 * Tokens an image occupies once projected. Varies by model — a SigLIP-based
 * projector at 896px is ~256 per tile and Gemma 3 uses 256 flat, while some
 * models tile large images into thousands. This is the conservative end.
 */
const TOKENS_PER_IMAGE = 800;

/** Per-message overhead for chat-template markers (role headers, separators). */
const TOKENS_PER_MESSAGE = 4;

export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/** Estimated token cost of one IR message, including its attachments. */
export function estimateMessageTokens(message: IRMessage): number {
  if (typeof message.content === 'string') {
    return estimateTokens(message.content) + TOKENS_PER_MESSAGE;
  }

  let total = TOKENS_PER_MESSAGE;
  for (const block of message.content as readonly MessageContent[]) {
    switch (block.type) {
      case 'text':
        total += estimateTokens(block.text);
        break;
      case 'image':
        total += TOKENS_PER_IMAGE;
        break;
      case 'audio':
        total += estimateTokens(block.transcript ?? '') + 100;
        break;
      case 'tool_use':
        total += estimateTokens(block.name + JSON.stringify(block.input));
        break;
      case 'tool_result':
        total += estimateTokens(
          typeof block.content === 'string'
            ? block.content
            : block.content.map((part) => part.text).join(''),
        );
        break;
      default:
        total += 50;
        break;
    }
  }
  return total;
}

export function estimateConversationTokens(messages: readonly IRMessage[]): number {
  return messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0);
}

export interface ContextBudget {
  /** The model's full context window, in tokens. */
  readonly contextLength: number;
  /** Tokens reserved for the reply. */
  readonly reserveForResponse: number;
  /** What the prompt may occupy: contextLength − reserve. */
  readonly promptBudget: number;
}

export function contextBudget(contextLength: number, maxTokens: number): ContextBudget {
  // Never reserve so much that there is no room to say anything, and never so
  // little that the model is cut off mid-sentence.
  const reserve = Math.min(Math.max(maxTokens, 128), Math.floor(contextLength * 0.5));
  return {
    contextLength,
    reserveForResponse: reserve,
    promptBudget: Math.max(256, contextLength - reserve),
  };
}

export interface FitResult {
  /** The messages that fit, in order. */
  readonly messages: IRMessage[];
  /** Estimated tokens the kept messages occupy. */
  readonly estimatedTokens: number;
  /** How many history messages were dropped to make room. */
  readonly dropped: number;
  /**
   * True when even the pinned messages exceed the budget. The request is sent
   * anyway — refusing would be worse — but the caller should warn.
   */
  readonly overflowed: boolean;
}

/**
 * Trim a conversation to fit a budget.
 *
 * Policy, in priority order:
 *
 *  1. **System messages are never dropped.** They carry the persona and the
 *     model's own instructions; losing them is the failure this exists to
 *     prevent.
 *  2. **The final user message is never dropped.** It is the question.
 *  3. **History is dropped oldest-first**, and a tool result is dropped
 *     together with the assistant turn that called it — an orphaned
 *     `tool_result` referring to a `tool_use` that is no longer present
 *     confuses every model that supports tools.
 */
export function fitToContext(messages: readonly IRMessage[], budget: ContextBudget): FitResult {
  // Pinned: every system message, plus the trailing run of non-history
  // messages (the current question and any post-history instruction).
  const lastUserIndex = findLastIndex(messages, (message) => message.role === 'user');

  const pinned = new Set<number>();
  messages.forEach((message, index) => {
    if (message.role === 'system') pinned.add(index);
  });
  if (lastUserIndex >= 0) {
    for (let index = lastUserIndex; index < messages.length; index += 1) pinned.add(index);
  }

  const pinnedCost = [...pinned].reduce(
    (sum, index) => sum + estimateMessageTokens(messages[index] as IRMessage),
    0,
  );

  if (pinnedCost >= budget.promptBudget) {
    // Nothing optional is left to drop. Send it and let the caller warn.
    const kept = messages.filter((_, index) => pinned.has(index));
    return {
      messages: kept,
      estimatedTokens: pinnedCost,
      dropped: messages.length - kept.length,
      overflowed: true,
    };
  }

  // Walk the droppable history newest-first, keeping what fits.
  const keep = new Set(pinned);
  let used = pinnedCost;

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (keep.has(index)) continue;
    const message = messages[index] as IRMessage;

    // A tool result and the assistant turn that produced it travel together.
    const partner = message.role === 'tool' ? index - 1 : -1;
    const group = partner >= 0 && !keep.has(partner) ? [partner, index] : [index];
    const cost = group.reduce(
      (sum, at) => sum + estimateMessageTokens(messages[at] as IRMessage),
      0,
    );

    if (used + cost > budget.promptBudget) break;
    for (const at of group) keep.add(at);
    used += cost;
  }

  const kept = messages.filter((_, index) => keep.has(index));
  return {
    messages: kept,
    estimatedTokens: used,
    dropped: messages.length - kept.length,
    overflowed: false,
  };
}

/** Human-readable summary for the context meter. */
export function describeUsage(used: number, contextLength: number): string {
  const pct = contextLength > 0 ? Math.round((used / contextLength) * 100) : 0;
  return `${used.toLocaleString()} / ${contextLength.toLocaleString()} (${pct}%)`;
}

/** Tone for the context meter: it should look different as it fills. */
export function usageTone(used: number, contextLength: number): 'ember' | 'warn' | 'crit' {
  if (contextLength <= 0) return 'ember';
  const ratio = used / contextLength;
  if (ratio >= 0.9) return 'crit';
  if (ratio >= 0.7) return 'warn';
  return 'ember';
}

function findLastIndex<T>(items: readonly T[], predicate: (item: T) => boolean): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (predicate(items[index] as T)) return index;
  }
  return -1;
}
