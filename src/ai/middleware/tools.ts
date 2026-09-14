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
  IRChatRequest,
  IRChatResponse,
  IRMessage,
  MessageContent,
  Middleware,
  MiddlewareContext,
  MiddlewareNext,
  ToolUseContent,
} from '@johnhenry/aimatey-types';

import type { McpCallReceipt } from '@/domain/mcp';
import type { ChatterangTool, ToolRegistry } from '@/ai/tools/registry';

export interface ExecutedTool {
  readonly id: string;
  readonly name: string;
  readonly input: Record<string, unknown>;
  readonly output: string;
  readonly isError: boolean;
  readonly durationMs: number;
  readonly display?: { readonly kind: 'html' | 'json' | 'text'; readonly value: string };
  /** Copied from the tool's result: this call's arguments went to an MCP server. */
  readonly receipt?: McpCallReceipt;
}

export interface ToolMiddlewareOptions {
  registry: ToolRegistry;
  /** Hard ceiling on execute → tool → execute round trips. */
  maxIterations?: number;
  /** Notified as each tool finishes, so the UI can render it live. */
  onToolExecuted?: (tool: ExecutedTool) => void;
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
/**
 * The tool ids the engine enabled for this turn, carried in request metadata.
 *
 * The IR request only names tools (`request.tools` is what the MODEL is told),
 * and a name is not a grant: two registered tools can share one. So the engine
 * puts the chat's enabled ids in `metadata.custom.toolIds`, and anything that
 * is not a clean string array reads as NO tools. Failing closed is the point —
 * a request that forgot to say which tools are enabled runs none of them.
 */
export function enabledToolIds(request: IRChatRequest): readonly string[] {
  const raw = request.metadata.custom?.['toolIds'];
  return Array.isArray(raw) && raw.every((id) => typeof id === 'string') ? (raw as string[]) : [];
}

/**
 * The tool a call names, looked up ONLY among the tools this chat enabled.
 *
 * THIS IS THE ENFORCEMENT, and until it existed there was none. The dispatcher
 * called `registry.getByName(call.name)` on the GLOBAL registry, so a chat with
 * only `calculator` enabled would run any registered tool the model named —
 * including an MCP tool connected for a different purpose. `Chat.tools` is
 * documented as "Tool ids enabled for this chat"; it was a list of what the
 * model was TOLD about, not a limit on what could run. Reproduced before this
 * was written: a probe tool the chat never enabled executed once.
 *
 * Resolved through the enabled IDS rather than filtered by name, because a name
 * allowlist still lets a non-enabled tool through when it shares a name with an
 * enabled one — `getByName` returns whichever registered first.
 */
function enabledTool(
  registry: ToolRegistry,
  enabledIds: readonly string[],
  name: string,
): ChatterangTool | undefined {
  for (const id of enabledIds) {
    const tool = registry.get(id);
    if (tool !== undefined && (tool.name === name || tool.id === name)) return tool;
  }
  return undefined;
}

export async function runToolCalls(
  registry: ToolRegistry,
  calls: readonly ToolUseContent[],
  /*
   * `enabledIds` is REQUIRED, not optional, and that is deliberate. An optional
   * safety parameter is one a future caller omits, and the omission would
   * silently restore the hole this closes.
   */
  options: {
    enabledIds: readonly string[];
    signal?: AbortSignal;
    onToolExecuted?: (tool: ExecutedTool) => void;
  },
): Promise<{ results: MessageContent[]; executed: ExecutedTool[] }> {
  const results: MessageContent[] = [];
  const executed: ExecutedTool[] = [];

  for (const call of calls) {
    if (options.signal?.aborted) break;

    // A tool this chat did not enable gets the SAME answer as a tool that does
    // not exist. A distinct "not enabled" message would tell the model which
    // tools are installed that the user chose not to give it.
    const tool = enabledTool(registry, options.enabledIds, call.name);
    const started = performance.now();

    let output: string;
    let isError = false;
    let display: ExecutedTool['display'];
    let receipt: ExecutedTool['receipt'];

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
        receipt = result.receipt;
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
      receipt,
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
        enabledIds: enabledToolIds(context.request),
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

      // The backend that served the turn the tool call came from.
      //
      // ai.matey#64 populates this adaptively: the router before dispatch,
      // narrowed to the concrete adapter once a response exists. The follow-up
      // runs after a response, so this is the specific backend — which is what
      // we want. The model that asked for the tool is the one that should read
      // its result.
      //
      // This used to route back through the Router instead. With
      // `routingStrategy: 'explicit'` the follow-up carries the same backend
      // selection, so it resolved to the same adapter anyway; the only
      // difference was an extra hop and a chance for circuit-breaker state to
      // change mid-loop and strand the tool work.
      const backend = context.backend;
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
