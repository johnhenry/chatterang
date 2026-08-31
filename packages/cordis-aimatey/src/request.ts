/**
 * DSH `GenerateOptions` -> aimatey `IRChatRequest`.
 *
 * Pure translation: no Cordis, no Router, no I/O. Everything is built from
 * copies, because a request assembled by DSH's agent loop arrives deep-frozen
 * (`deepFreeze` in dsh-llm's call-config) and mutating it throws.
 */

import { LlmError } from '@deepseek-ai/dsh-llm';
import type { ContentBlock, GenerateOptions, Message } from '@deepseek-ai/dsh-llm';
import type {
  IRChatRequest,
  IRMessage,
  IRTool,
  JSONSchema,
  MessageContent,
  TextContent,
} from '@johnhenry/aimatey-types';

/**
 * The route name that means "let the Router choose the backend".
 *
 * Every other registered route names one aimatey backend and pins the request
 * to it through `metadata.custom.backend`, which is the only key
 * `Router.executeStream` reads when picking a backend
 * (aimatey-core router.js: `request.metadata?.custom?.backend`).
 */
export const ROUTER_SENTINEL = 'aimatey';

/** Where a translation reports what it had to drop. */
export interface TranslationHooks {
  /** Something was lost and a reader needs to know. */
  warn?: (message: string) => void;
  /** Something was dropped by design; useful only when chasing a difference. */
  debug?: (message: string) => void;
}

/** Convert a DSH content block to its IR counterpart, or drop it. */
function toIRContent(
  block: ContentBlock,
  hooks: TranslationHooks,
  dropped: { reasoning: number },
): MessageContent | undefined {
  switch (block.type) {
    case 'text':
      return { type: 'text', text: block.text };

    case 'tool-call': {
      // DSH keeps tool arguments as the raw JSON string the model produced;
      // the IR insists on a parsed object. There is no honest fallback: `{}`
      // would replay the call with no arguments, which is a different call.
      let input: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(block.arguments);
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          throw new Error('tool arguments must decode to a JSON object');
        }
        input = parsed as Record<string, unknown>;
      } catch (cause) {
        throw new LlmError(
          `assistant tool-call ${block.id} carried unparseable arguments`,
          'ADAPTER_CONVERSION_ERROR',
          { cause },
        );
      }
      return { type: 'tool_use', id: block.id, name: block.name, input };
    }

    case 'tool-result': {
      // The IR's ToolResultContent admits only `string | TextContent[]`, so an
      // image or a nested block inside a tool result has nowhere to go. Naming
      // what was dropped is the difference between a puzzling model reply and
      // a traceable one.
      const text: TextContent[] = [];
      for (const inner of block.content) {
        if (inner.type === 'text') text.push({ type: 'text', text: inner.text });
        else {
          hooks.warn?.(
            `aimatey: dropped a "${inner.type}" block from tool result ${block.toolCallId} — ` +
              'the IR tool_result content admits only text',
          );
        }
      }
      return {
        type: 'tool_result',
        toolUseId: block.toolCallId,
        content: text,
        ...(block.isError === undefined ? {} : { isError: block.isError }),
      };
    }

    case 'reasoning':
      // aimatey's IR has no reasoning channel at all — "reasoning" does not
      // appear anywhere in @johnhenry/aimatey-types. Dropping is the only
      // option; counting it is what makes the drop visible.
      dropped.reasoning += 1;
      return undefined;

    case 'image':
      // Unreachable in practice: the adapter declares `inputModalities: ['text']`,
      // and LlmRuntime rewrites image blocks to placeholder text before calling
      // `stream()` (projectImagesForTextModel). Kept as a loud branch rather
      // than a silent default, because "unreachable" is a claim about someone
      // else's code.
      hooks.warn?.(
        'aimatey: dropped an image block — the adapter declares text-only input, ' +
          'so this block should have been projected to text before it arrived',
      );
      return undefined;

    default:
      // ContentBlockMap is merge-extensible: a plugin can add a block type this
      // package has never seen.
      hooks.warn?.(
        `aimatey: dropped an unrecognised content block of type "${(block as { type: string }).type}"`,
      );
      return undefined;
  }
}

/** Whether a DSH message is the tool-result shape the IR calls role `tool`. */
function isToolResultMessage(message: Message): boolean {
  return (
    message.role === 'user' && message.content.length === 1 && message.content[0]?.type === 'tool-result'
  );
}

/** Convert one DSH message, dropping what the IR cannot carry. */
function toIRMessage(
  message: Message,
  hooks: TranslationHooks,
  dropped: { reasoning: number },
): IRMessage {
  const content: MessageContent[] = [];
  for (const block of message.content) {
    const mapped = toIRContent(block, hooks, dropped);
    if (mapped !== undefined) content.push(mapped);
  }
  // `Message.id` and `Message.source` are dropped: the IR has no counterpart,
  // and IRMessage.metadata is not a safe carrier because nothing reads it back.
  return { role: isToolResultMessage(message) ? 'tool' : message.role, content };
}

/**
 * Build the IR request for one DSH call.
 *
 * @param options - the fully assembled DSH request, treated as immutable.
 * @param provider - the registered route this call arrived on; anything other
 *   than {@link ROUTER_SENTINEL} pins the aimatey backend of the same name.
 * @param hooks - where dropped content is reported.
 * @returns a freshly built IR request; `options` is never read after return.
 */
export function toIRRequest(
  options: GenerateOptions,
  /**
   * The aimatey backend to pin, or `undefined` for router-choice.
   *
   * Deliberately not the DSH provider string: deriving "is this router-choice?"
   * here by comparing against {@link ROUTER_SENTINEL} meant a real backend
   * registered under that reserved name silently lost its pin. The caller is
   * the only place that knows which it is, so it says so.
   */
  pinned: string | undefined,
  hooks: TranslationHooks = {},
): IRChatRequest {
  const dropped = { reasoning: 0 };
  const messages: IRMessage[] = [];

  // DSH keeps the system prompt in a slot beside the message list; the IR has
  // no such slot. If `options.messages` already carries a system message, both
  // survive in order — merging them would be an invention.
  if (options.system !== undefined && options.system.length > 0) {
    messages.push({ role: 'system', content: options.system });
  }
  for (const message of options.messages) messages.push(toIRMessage(message, hooks, dropped));

  if (dropped.reasoning > 0) {
    hooks.debug?.(
      `aimatey: dropped ${dropped.reasoning} reasoning block(s) from the outbound history — ` +
        'the aimatey IR has no reasoning channel',
    );
  }

  const tools: IRTool[] | undefined = options.tools?.map((tool) => ({
    name: tool.name,
    // DSH permits an empty description. Passing it through produces a
    // semantically empty IRTool, which is what the caller asked for; inventing
    // text here would put words in the model's prompt that nobody wrote.
    description: tool.description,
    // Widening, not conversion: DSH types `parameters` as Record<string, unknown>
    // and the IR as a structured JSONSchema. Same object either way.
    parameters: tool.parameters as JSONSchema,
  }));

  const custom: Record<string, unknown> = {};
  if (pinned !== undefined) custom['backend'] = pinned;
  // Carried under namespaced keys purely so a DSH-side log line and an
  // aimatey-side log line can be joined. Nothing in aimatey reads either, and
  // neither influences routing.
  if (options.sessionId !== undefined) custom['dshSessionId'] = options.sessionId;
  if (options.purpose !== undefined) custom['dshPurpose'] = options.purpose;

  return {
    messages,
    ...(tools === undefined || tools.length === 0 ? {} : { tools, toolChoice: 'auto' as const }),
    parameters: {
      // Verbatim. `resolveModel()` must return this exact id back or the
      // registry rejects it with INVALID_MODEL_INFO, so namespacing it here
      // would break the round trip.
      model: options.model,
      ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
      ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
      ...(options.stop === undefined ? {} : { stopSequences: [...options.stop] }),
      // topP, topK, frequencyPenalty, presencePenalty, seed and user are left
      // undefined on purpose. DSH cannot express any of them, so a caller who
      // set nothing must get the provider's own defaults — not chatterang's.
    },
    metadata: {
      requestId: newRequestId(),
      timestamp: Date.now(),
      provenance: { frontend: 'dsh', router: 'chatterang-router' },
      custom,
    },
    stream: true,
    // Mandatory. Under 'accumulated' each content chunk carries the whole text
    // so far, and forwarding that as a text-delta would repeat the message.
    streamMode: 'delta',
  };
}

/** A request id, from `crypto.randomUUID` where it exists. */
function newRequestId(): string {
  const uuid = globalThis.crypto?.randomUUID;
  if (typeof uuid === 'function') return uuid.call(globalThis.crypto);
  // Older runtimes without WebCrypto: the id only has to be unique enough to
  // correlate two log lines, so a random suffix is honest here.
  return `dsh-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
