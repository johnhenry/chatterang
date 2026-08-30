/**
 * Tool-calling as aimatey middleware (PRD §3.2).
 *
 * Implemented at the middleware layer rather than inside any one adapter, so
 * a 3B model running on the phone and a frontier model running in a data
 * centre get the identical loop: execute → find tool calls → run them →
 * append results → execute again.
 *
 * Small local models frequently emit tool calls as text rather than as
 * structured `tool_use` blocks, so the extractor accepts both. That is the
 * difference between tool calling working on-device and only working when
 * you pay for a remote provider.
 */

import type {
  BackendAdapter,
  IRChatRequest,
  IRChatResponse,
  IRMessage,
  MessageContent,
  Middleware,
  MiddlewareContext,
  MiddlewareNext,
  ToolUseContent,
} from '@johnhenry/aimatey-types';

import type { ToolRegistry } from '@/ai/tools/registry';

export interface ExecutedTool {
  readonly id: string;
  readonly name: string;
  readonly input: Record<string, unknown>;
  readonly output: string;
  readonly isError: boolean;
  readonly durationMs: number;
  readonly display?: { readonly kind: 'html' | 'json' | 'text'; readonly value: string };
}

export interface ToolMiddlewareOptions {
  registry: ToolRegistry;
  /** Hard ceiling on execute → tool → execute round trips. */
  maxIterations?: number;
  /** Notified as each tool finishes, so the UI can render it live. */
  onToolExecuted?: (tool: ExecutedTool) => void;
  /**
   * Backend to run the follow-up turn on, after tools have produced results.
   *
   * Required, because `MiddlewareContext.backend` is documented as "available
   * after routing decision" and is in fact never populated by the Bridge
   * (johnhenry/ai.matey#64). Depending on it silently truncated the loop: the
   * tool ran, the model never saw the result, and the visible answer came back
   * empty once the tool syntax was stripped.
   */
  resolveBackend?: () => BackendAdapter | undefined;
}

/**
 * Recognise a textual tool call. Local models produce these in a handful of
 * shapes; all of them reduce to a name plus a JSON argument object.
 */
export function extractTextualToolCalls(text: string): ToolUseContent[] {
  const calls: ToolUseContent[] = [];
  let index = 0;

  const push = (name: string, raw: string): void => {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        calls.push({
          type: 'tool_use',
          id: `text_call_${index++}`,
          name,
          input: parsed as Record<string, unknown>,
        });
      }
    } catch {
      // Malformed JSON is not a tool call; leave the text alone.
    }
  };

  // <tool_call>{"name": "...", "arguments": {...}}</tool_call>  (Qwen, Hermes)
  for (const match of text.matchAll(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/gi)) {
    const body = match[1];
    if (!body) continue;
    try {
      const parsed = JSON.parse(body) as { name?: string; arguments?: unknown; parameters?: unknown };
      if (typeof parsed.name === 'string') {
        const args = parsed.arguments ?? parsed.parameters ?? {};
        calls.push({
          type: 'tool_use',
          id: `text_call_${index++}`,
          name: parsed.name,
          input: (typeof args === 'object' && args ? args : {}) as Record<string, unknown>,
        });
      }
    } catch {
      // ignore
    }
  }

  // ```json { "tool": "name", "arguments": {...} } ```   (generic fenced form)
  for (const match of text.matchAll(/```(?:json|tool)?\s*(\{[\s\S]*?\})\s*```/gi)) {
    const body = match[1];
    if (!body) continue;
    try {
      const parsed = JSON.parse(body) as {
        tool?: string;
        name?: string;
        function?: string;
        arguments?: unknown;
        parameters?: unknown;
        input?: unknown;
      };
      const name = parsed.tool ?? parsed.name ?? parsed.function;
      if (typeof name === 'string') {
        const args = parsed.arguments ?? parsed.parameters ?? parsed.input ?? {};
        calls.push({
          type: 'tool_use',
          id: `text_call_${index++}`,
          name,
          input: (typeof args === 'object' && args ? args : {}) as Record<string, unknown>,
        });
      }
    } catch {
      // ignore
    }
  }

  // [TOOL_CALL] name({...})                              (Mistral-style)
  for (const match of text.matchAll(/\[TOOL_CALLS?\]\s*(\w+)\s*\(\s*(\{[\s\S]*?\})\s*\)/gi)) {
    const name = match[1];
    const body = match[2];
    if (name && body) push(name, body);
  }

  return calls;
}

/** Strip recognised tool-call syntax so the user never sees the plumbing. */
export function stripToolSyntax(text: string): string {
  return text
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, '')
    .replace(/\[TOOL_CALLS?\]\s*\w+\s*\([\s\S]*?\)/gi, '')
    .replace(/```(?:json|tool)?\s*\{[\s\S]*?"(?:tool|function)"[\s\S]*?\}\s*```/gi, '')
    .trim();
}

/**
 * Every tool call in a message, from either the structured blocks or the
 * textual forms small models emit.
 *
 * Exported because the streaming path has to drive this loop itself: aimatey's
 * `Bridge.use()` middleware does not run for streamed requests
 * (johnhenry/ai.matey#46), and a tool call cannot be executed mid-stream in
 * any case — the arguments are not complete until the turn ends.
 */
export function findToolCalls(message: IRMessage): ToolUseContent[] {
  return [...structuredToolCalls(message), ...extractTextualToolCalls(messageToText(message))];
}

/** Run a batch of tool calls, returning both IR results and UI records. */
export async function runToolCalls(
  registry: ToolRegistry,
  calls: readonly ToolUseContent[],
  options: { signal?: AbortSignal; onToolExecuted?: (tool: ExecutedTool) => void } = {},
): Promise<{ results: MessageContent[]; executed: ExecutedTool[] }> {
  const results: MessageContent[] = [];
  const executed: ExecutedTool[] = [];

  for (const call of calls) {
    if (options.signal?.aborted) break;

    const tool = registry.getByName(call.name);
    const started = performance.now();

    let output: string;
    let isError = false;
    let display: ExecutedTool['display'];

    if (!tool) {
      output = `No tool named "${call.name}" is available.`;
      isError = true;
    } else {
      try {
        const result = await tool.execute(call.input, {
          signal: options.signal,
          now: () => new Date(),
        });
        output = result.output;
        isError = Boolean(result.isError);
        display = result.display;
      } catch (error) {
        output = error instanceof Error ? error.message : String(error);
        isError = true;
      }
    }

    results.push({ type: 'tool_result', toolUseId: call.id, content: output, isError });

    const record: ExecutedTool = {
      id: call.id,
      name: call.name,
      input: call.input,
      output,
      isError,
      durationMs: Math.round(performance.now() - started),
      display,
    };
    executed.push(record);
    options.onToolExecuted?.(record);
  }

  return { results, executed };
}

function structuredToolCalls(message: IRMessage): ToolUseContent[] {
  if (typeof message.content === 'string') return [];
  return (message.content as readonly MessageContent[]).filter(
    (block): block is ToolUseContent => block.type === 'tool_use',
  );
}

function messageToText(message: IRMessage): string {
  if (typeof message.content === 'string') return message.content;
  return (message.content as readonly MessageContent[])
    .filter((block) => block.type === 'text')
    .map((block) => (block.type === 'text' ? block.text : ''))
    .join('');
}

export function createToolMiddleware(options: ToolMiddlewareOptions): Middleware {
  const maxIterations = options.maxIterations ?? 4;

  return async function toolMiddleware(
    context: MiddlewareContext,
    next: MiddlewareNext,
  ): Promise<IRChatResponse> {
    // As of aimatey 0.2.0 (ai.matey#46) `Bridge.use()` middleware also runs on
    // streamed requests. `ChatterangEngine.stream` drives its own tool loop —
    // it has to, because a tool call cannot be executed mid-stream and the
    // response rewrite that strips tool syntax is discarded by the stream
    // adapter — so running here too would execute every tool twice.
    if (context.isStreaming) return next();

    const enabled = context.request.tools ?? [];
    if (enabled.length === 0) return next();

    let response = await next();
    const executed: ExecutedTool[] = [];
    let messages: IRMessage[] = [...context.request.messages];

    for (let iteration = 0; iteration < maxIterations; iteration += 1) {
      const calls = findToolCalls(response.message);
      if (calls.length === 0) break;

      const batch = await runToolCalls(options.registry, calls, {
        signal: context.signal,
        onToolExecuted: options.onToolExecuted,
      });
      executed.push(...batch.executed);

      const results = batch.results;
      if (results.length === 0) break;

      messages = [
        ...messages,
        { role: 'assistant', content: [...calls] },
        { role: 'tool', content: results },
      ];

      const followUp: IRChatRequest = { ...context.request, messages, stream: false };
      const backend = options.resolveBackend?.() ?? context.backend;
      if (!backend) {
        // Nothing to re-execute against. Return what the model said rather
        // than an empty string — the tool results are still reported in
        // metadata, so the caller can see what ran.
        break;
      }
      response = await backend.execute(followUp, context.signal);
    }

    if (executed.length === 0) return response;

    // Hand the executed tools to the UI via response metadata, and clean the
    // model's tool syntax out of the visible answer.
    const stripped = stripToolSyntax(messageToText(response.message));
    // If stripping leaves nothing, the model's whole reply was a tool call and
    // the follow-up turn did not happen. An empty message is never the right
    // thing to show, so keep the raw text and let the caller decide.
    const visible = stripped || messageToText(response.message);

    return {
      ...response,
      message: { ...response.message, content: visible },
      metadata: {
        ...response.metadata,
        custom: { ...response.metadata.custom, toolCalls: executed },
      },
    };
  };
}
