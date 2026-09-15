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

import {
  argumentBytes,
  argumentPreview,
  type McpCallReceipt,
  type ToolDestination,
  type WithheldWhy,
} from '@/domain/mcp';
import type { ChatterangTool, ToolRegistry } from '@/ai/tools/registry';

export interface ExecutedTool {
  readonly id: string;
  readonly name: string;
  readonly input: Record<string, unknown>;
  readonly output: string;
  readonly isError: boolean;
  readonly durationMs: number;
  readonly display?: { readonly kind: 'html' | 'json' | 'text'; readonly value: string };
  /**
   * What became of an MCP call: copied from the tool's result, or written here
   * for a call the dispatcher held back. It is present for a call that did not
   * leave as well; whether anything left is `mayHaveLeft`'s answer.
   */
  readonly receipt?: McpCallReceipt;
}

export interface ToolMiddlewareOptions {
  registry: ToolRegistry;
  /** Hard ceiling on execute → tool → execute round trips. */
  maxIterations?: number;
  /** Notified as each tool finishes, so the UI can render it live. */
  onToolExecuted?: (tool: ExecutedTool) => void;
}

/* ── Where a call's arguments may go (#6) ────────────────────────────── */

/** One call as the send sheet lists it. */
export interface DestinationCall {
  /** Server-qualified, as the tool list names it. */
  readonly toolName: string;
  readonly bytes: number;
  /** The arguments as JSON, cut short. The model wrote them, and a sheet must say so. */
  readonly preview: string;
}

/** What a person is asked to allow: one destination, and every call in this batch bound for it. */
export interface DestinationRequest {
  readonly destination: ToolDestination;
  readonly calls: readonly DestinationCall[];
}

/**
 * `calls` sends exactly the calls the request listed, and covers nothing
 * later; `conversation` allows this server, at this address, in this
 * conversation until the grant is revoked; `deny` sends nothing.
 *
 * There is no answer for the rest of the turn. A later batch's arguments may
 * have been written after a tool's output was read (`composedAfterOutput` in
 * `ai/engine.ts`), and an answer given over a harmless call on screen must not
 * cover one the person never saw.
 */
export type DestinationDecision = 'calls' | 'conversation' | 'deny';

export interface ToolDestinationPolicy {
  /** Grants the conversation already holds for this destination. */
  isGranted(destination: ToolDestination): boolean;
  /**
   * Ask. Absent means there is nobody to ask, which is a refusal.
   *
   * `signal` is the turn's. Once it aborts the dispatcher stops waiting, and
   * every call the request covered is recorded as not sent whatever is
   * answered later; an implementation should take its sheet down then, as the
   * app's `requestApproval` does.
   *
   * AN UNATTENDED CALLER MUST LEAVE THIS OUT. The app's own answer waits on
   * `requestApproval`, which resolves only when a person answers the sheet or
   * the turn is stopped, so a queued or background run that supplied it would
   * hang rather than refuse (#103, #199).
   */
  request?(request: DestinationRequest, signal?: AbortSignal): Promise<DestinationDecision>;
  /** Persist a `conversation` answer. */
  onGranted?(destination: ToolDestination): void;
}

/** Sends nothing anywhere: for a caller with no conversation to hold a grant and no one to ask. */
export const NO_DESTINATIONS: ToolDestinationPolicy = Object.freeze({ isGranted: () => false });

/**
 * `waiting`, or `undefined` as soon as `signal` aborts — whichever is first.
 *
 * For a question put to a person mid-turn (#92, owner ruling OD7). Stop has to
 * end the wait when nobody answers, and an answer that arrives after Stop must
 * reach nothing, so a caller checks `signal.aborted` after this rather than
 * trusting the value: an answer and an abort can land in the same tick.
 */
export function unlessStopped<T>(waiting: Promise<T>, signal: AbortSignal | undefined): Promise<T | undefined> {
  if (signal === undefined) return waiting;
  // An abort that already happened fires no event, so it is read here.
  if (signal.aborted) return Promise.resolve(undefined);
  return new Promise<T | undefined>((resolve, reject) => {
    const stop = (): void => resolve(undefined);
    signal.addEventListener('abort', stop, { once: true });
    waiting.then(
      (value) => {
        signal.removeEventListener('abort', stop);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', stop);
        reject(error);
      },
    );
  });
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
    const call = fencedCall(body);
    if (call) calls.push({ type: 'tool_use', id: `text_call_${index++}`, ...call });
  }

  // [TOOL_CALL] name({...})                              (Mistral-style)
  for (const match of text.matchAll(/\[TOOL_CALLS?\]\s*(\w+)\s*\(\s*(\{[\s\S]*?\})\s*\)/gi)) {
    const name = match[1];
    const body = match[2];
    if (name && body) push(name, body);
  }

  return calls;
}

/**
 * The call a fenced JSON block's body names, as `extractTextualToolCalls` reads
 * one: a `tool`, `name` or `function` that is a string. Undefined for any other
 * body — a tool DEFINITION, whose `function` is an object, or a config file.
 */
function fencedCall(body: string): { name: string; input: Record<string, unknown> } | undefined {
  try {
    const parsed = JSON.parse(body) as {
      tool?: unknown;
      name?: unknown;
      function?: unknown;
      arguments?: unknown;
      parameters?: unknown;
      input?: unknown;
    };
    const name = parsed.tool ?? parsed.name ?? parsed.function;
    if (typeof name !== 'string') return undefined;
    const args = parsed.arguments ?? parsed.parameters ?? parsed.input ?? {};
    return { name, input: (typeof args === 'object' && args ? args : {}) as Record<string, unknown> };
  } catch {
    return undefined;
  }
}

/**
 * Where the JSON object or array opening at `start` ends, just past its closing
 * bracket; -1 if the text ends first. A bracket inside a string is not counted.
 */
export function endOfJson(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  for (let at = start; at < text.length; at += 1) {
    const char = text[at];
    if (inString) {
      if (char === '\\') at += 1;
      else if (char === '"') inString = false;
    } else if (char === '"') {
      inString = true;
    } else if (char === '{' || char === '[') {
      depth += 1;
    } else if (char === '}' || char === ']') {
      depth -= 1;
      if (depth === 0) return at + 1;
    }
  }
  return -1;
}

/**
 * Each textual call's shape: where its JSON may open, what must follow the JSON
 * once it closes, and whether a body in that shape is a call.
 *
 * `<tool_call>` and `[TOOL_CALLS] name(` are markup whatever their JSON holds:
 * a body that does not parse is a malformed call, which runs nothing and is
 * still the model's plumbing. A fenced block is markup only when it reads as a
 * call, because any other is a code example.
 */
const CALL_SHAPES: readonly {
  readonly open: RegExp;
  readonly close: RegExp;
  readonly fenced: boolean;
}[] = [
  { open: /<tool_call>\s*(?=[{[])/gi, close: /^\s*<\/tool_call>/i, fenced: false },
  { open: /\[TOOL_CALLS?\]\s*\w+\s*\(\s*(?=\{)/gi, close: /^\s*\)/, fenced: false },
  { open: /```(?:json|tool)?\s*(?=\{)/gi, close: /^\s*```/, fenced: true },
];

/** A call with nothing inside it at all: `<tool_call></tool_call>`, or `[TOOL_CALLS] name()`. */
const EMPTY_CALL = /<tool_call>\s*<\/tool_call>|\[TOOL_CALLS?\]\s*\w+\s*\(\s*\)/gi;

/**
 * Strip recognised tool-call syntax so the user never sees the plumbing.
 *
 * WHAT IS STRIPPED IS A CALL, found by its JSON, not by a lazy match between
 * two markers. The patterns this replaced were `<tool_call>[\s\S]*?</tool_call>`,
 * `[TOOL_CALLS] name(` up to the first `)`, and any fenced JSON block holding a
 * quoted "tool" or "function" up to the next closing fence. So prose that named
 * `<tool_call>` and then `</tool_call>` lost every word between them — reasoning
 * that named the one and an answer that named the other lost the whole answer;
 * "[TOOL_CALLS] before (not after)" lost its aside; a JSON tool DEFINITION, and
 * two code blocks with a quoted "tool" between them, were cut; and a call whose
 * string argument held a ")" left the rest of its arguments behind.
 *
 * Now a `<tool_call>` or `[TOOL_CALLS] name(` is stripped only when JSON opens
 * right after it, and only through that JSON's closing bracket — read past any
 * bracket inside a string — and the tag or paren that closes the call. An
 * unfinished call has no end, and is left for the caller: see
 * `wordsWithoutCalls` in `state/chat.ts`.
 *
 * `readForCalls` says whether the text was read for calls. A fenced block is a
 * call only in a turn that was — the engine runs `findToolCalls` only for a
 * request that enabled a tool — and in one that was not, it is an example.
 * The tag forms are stripped either way, as they always were.
 */
export function stripToolSyntax(text: string, options: { readForCalls?: boolean } = {}): string {
  const readForCalls = options.readForCalls ?? true;
  const spans: [number, number][] = [];
  for (const { open, close, fenced } of CALL_SHAPES) {
    if (fenced && !readForCalls) continue;
    for (const match of text.matchAll(open)) {
      const from = match.index + match[0].length;
      const end = endOfJson(text, from);
      if (end === -1) continue;
      const closing = close.exec(text.slice(end));
      if (!closing || (fenced && fencedCall(text.slice(from, end)) === undefined)) continue;
      spans.push([match.index, end + closing[0].length]);
    }
  }
  for (const match of text.matchAll(EMPTY_CALL)) spans.push([match.index, match.index + match[0].length]);

  spans.sort((a, b) => a[0] - b[0]);
  let out = '';
  let at = 0;
  for (const [start, end] of spans) {
    if (start > at) out += text.slice(at, start);
    at = Math.max(at, end);
  }
  return (out + text.slice(at)).trim();
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
  registry: Pick<ToolRegistry, 'get'>,
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
    /*
     * REQUIRED FOR THE SAME REASON (#6). A tool's `execute` cannot see the
     * conversation or what it has allowed, so this is the one place a call
     * that leaves the device can be asked about before its arguments go —
     * and a caller that forgot to pass it must not compile.
     */
    destinations: ToolDestinationPolicy;
    /*
     * The tools the request these calls answer declared to the model, as the
     * registry held them when it was built. NEVER RUN: a call executes only
     * from the live registry. Read only to name a call whose tool has left the
     * registry since, so it is recorded as not sent to that server rather than
     * answered as a name nothing stands behind (#92). Leaving it out sends
     * nothing more, but loses that record, so both callers in this app pass it.
     */
    declared?: readonly ChatterangTool[];
    signal?: AbortSignal;
    onToolExecuted?: (tool: ExecutedTool) => void;
    /**
     * Asked before a call WITHOUT a destination runs — the enforcement for a
     * persona's `agentConfig.toolPolicy.confirmPolicy === 'always-ask'`
     * (#23, #122). A call WITH a destination already asks through
     * `destinations.request`; this is never consulted for one, so a call is
     * never asked about twice. Absent is the app's own default: a
     * non-destination tool (`calculator`, `datetime`, …) runs with no
     * question asked, as it always has.
     */
    confirmEachCall?: (call: ToolUseContent, signal?: AbortSignal) => Promise<boolean>;
    /*
     * This batch was read from a turn past the turn's limit on tool rounds
     * (#293). Nothing in it runs — the limit means no more tool rounds, full
     * stop — but a call with a destination still gets a `withheld` receipt,
     * why `round-limit`, so it is not a call the thread and the export never
     * heard of. Skips `refusedDestinations` entirely: nobody is asked about a
     * call that was never going to run regardless of the answer.
     */
    roundLimitReached?: boolean;
  },
): Promise<{ results: MessageContent[]; executed: ExecutedTool[] }> {
  const results: MessageContent[] = [];
  const executed: ExecutedTool[] = [];

  /*
   * WHEN STOP LANDED, which the record of every call it held back carries (#92:
   * an accurate time). Not when the loop below reaches the call: an earlier call
   * in the batch can keep running after Stop — a server or tool that does not
   * read the signal, or a sheet that was not handed it, as the bash tool's
   * confirm is not — and the export would print the moment later by as long as
   * that took. Stopped before the batch came in, the nearest this can say is
   * when it did.
   */
  let stoppedAt = options.signal?.aborted ? Date.now() : undefined;
  const noteStop = (): void => {
    stoppedAt ??= Date.now();
  };
  options.signal?.addEventListener('abort', noteStop, { once: true });
  try {
    // A tool this chat did not enable gets the SAME answer as a tool that does
    // not exist. A distinct "not enabled" message would tell the model which
    // tools are installed that the user chose not to give it.
    const tools = calls.map((call) => enabledTool(registry, options.enabledIds, call.name));
    /*
     * A TOOL THAT LEFT THE REGISTRY MID-TURN (#92, owner ruling that "not sent"
     * covers every call that did not leave). Removing a server, switching one off
     * or adding one runs `reconnect` in `state/mcp.ts`, which takes every MCP
     * tool out of the registry before it puts the enabled servers' back. A call
     * the model was writing meanwhile reaches here with nothing behind its name.
     * It was a call to a server this request declared, and it did not go, so it
     * is named from `declared` — looked up by the same enabled ids — and
     * recorded as not sent. Nothing is run from it.
     */
    const departed = calls.map((call, index) =>
      tools[index] === undefined
        ? enabledTool(
            { get: (id) => options.declared?.find((tool) => tool.id === id) },
            options.enabledIds,
            call.name,
          )
        : undefined,
    );
    // Asked BEFORE any call in the batch runs, so a sheet lists every call its
    // answer covers, and a destructive call's own confirm comes after it.
    // Skipped entirely past the round limit: nothing in this batch runs
    // whatever the answer, so nobody is asked (see `roundLimitReached`).
    const { refused, onHeldGrant } = options.roundLimitReached
      ? { refused: new Map<number, Refusal>(), onHeldGrant: new Set<number>() }
      : await refusedDestinations(calls, tools, options.destinations, options.signal);

    /*
     * A HELD GRANT IS READ AGAIN AT THE CALL, not only when the batch was asked
     * about. An earlier call in the batch can run for as long as its server
     * takes, and switching this server off and on again meanwhile withdraws the
     * grant but brings back the same record at the same address, so the live
     * check in `state/mcp.ts` passes. Without this the call went anyway, after
     * the privacy command's "Every grant to a server is dropped when it is
     * removed or switched off" had become true. A grant is withdrawn only when
     * its server is removed or switched off, so the record says the server
     * changed (#92, owner ruling on a server changed while a call waited).
     *
     * And read once more inside the call, through `stillGranted`, by a tool that
     * waits before its arguments leave: a destructive MCP call's data-change
     * confirm is awaited inside `execute`, after this check has passed.
     */
    const withdrawn = (index: number): Refusal | undefined => {
      const destination = tools[index]?.destination;
      if (!destination || !onHeldGrant.has(index) || options.destinations.isGranted(destination)) {
        return undefined;
      }
      return {
        output: `This call’s arguments were not sent to ${destination.host}: this conversation’s permission for that server was withdrawn before it went.`,
        why: 'server-changed',
      };
    };

    /*
     * Its tool gone, no sheet was raised for it and nothing can run it. The record
     * says the server changed, because taking a server's tools away is what a
     * server change does, and like a withdrawn grant that outranks Stop.
     */
    const changed = (index: number): Refusal | undefined => {
      const destination = departed[index]?.destination;
      if (!destination) return undefined;
      return {
        output: `This call’s arguments were not sent to ${destination.host}: the server changed before it went.`,
        why: 'server-changed',
      };
    };

    /*
     * STOP HOLDS BACK EVERY CALL THAT HAS NOT GONE, and each is written down (#92,
     * owner ruling that "not sent" covers every call that did not leave). That is
     * a call allowed by a grant the conversation held, or by an answer given in
     * this batch, when Stop came at another server's sheet or while an earlier
     * call ran. It waited on nobody, and until this it did not run and had no
     * record, so the thread and the export said nothing about it. Read at the
     * call, so the time on the record is when it was held back.
     */
    const stopped = (index: number): Refusal | undefined => {
      const destination = tools[index]?.destination;
      if (!destination || !options.signal?.aborted) return undefined;
      return {
        output: `This call’s arguments were not sent to ${destination.host}: the reply was stopped.`,
        why: 'stopped',
      };
    };

    /*
     * PAST THE ROUND LIMIT, every call with a destination is withheld, and
     * nothing runs (#293). There is no sheet to have answered no — the limit
     * itself is the reason — so this checks `options.roundLimitReached`
     * directly rather than reading `refused`, which `refusedDestinations` was
     * never asked to fill in for this batch.
     */
    const overLimit = (index: number): Refusal | undefined => {
      const destination = tools[index]?.destination;
      if (!destination || !options.roundLimitReached) return undefined;
      return {
        output: `This call’s arguments were not sent to ${destination.host}: the turn had already used every tool round it was allowed.`,
        why: 'round-limit',
      };
    };

    for (const [index, call] of calls.entries()) {
      const refusal =
        refused.get(index) ?? withdrawn(index) ?? changed(index) ?? stopped(index) ?? overLimit(index);
      // Nothing runs once the turn is stopped or past the round limit. A
      // refused call is still written down below, whatever refused it: a
      // refusal sends nothing, and a call the person declined before Stop
      // came is as much not sent as one Stop held back (owner ruling OD7).
      // What is skipped here without a record is only a call with no
      // destination — a tool that runs on this device, or a name the request
      // did not declare — which has no server it was not sent to.
      if ((options.signal?.aborted || options.roundLimitReached) && !refusal) continue;

      const tool = tools[index];
      // What a record names: the live tool, or the one the request declared when
      // the live one has gone. Only `tool` is ever run.
      const named = tool ?? departed[index];
      const started = performance.now();

      let output: string;
      let isError = false;
      let display: ExecutedTool['display'];
      let receipt: ExecutedTool['receipt'];

      if (refusal) {
        // Written by this app from the destination's host, which the person
        // typed; nothing in it came from the model or the server.
        output = refusal.output;
        isError = true;
        // RECORDED AS NOT SENT (#92, owner ruling OD7), so the thread and the
        // export can say what did not go. Only for a call with a destination:
        // an `mcp:` tool refused for declaring none has no host to name.
        const destination = named?.destination;
        if (named && destination) {
          receipt = {
            outcome: 'withheld',
            why: refusal.why,
            serverId: destination.serverId,
            serverName: destination.serverName,
            host: destination.host,
            toolName: named.name,
            bytes: argumentBytes(call.input),
            // A call Stop held back, at the moment Stop landed; any other, now.
            at: refusal.why === 'stopped' ? (stoppedAt ?? Date.now()) : Date.now(),
          };
        }
      } else if (!tool) {
        output = `No tool named "${call.name}" is available.`;
        isError = true;
      } else if (
        !tool.destination &&
        options.confirmEachCall &&
        !(await options.confirmEachCall(call, options.signal))
      ) {
        // ALWAYS-ASK, DECLINED. Only for a call with no destination: one WITH
        // a destination already asked through `destinations.request` above,
        // and a second ask over the same call is the "second sheet" people
        // learn to tap through. No receipt — a receipt names a server this
        // call was not sent to, and a local tool has none.
        output = `Declined: "${call.name}" was not run.`;
        isError = true;
      } else {
        try {
          const destination = tool.destination;
          const result = await tool.execute(call.input, {
            signal: options.signal,
            now: () => new Date(),
            // Only for a call a held grant let through, as `withdrawn` above. An
            // answer given in this batch is not read again: not ruled.
            ...(destination && onHeldGrant.has(index)
              ? { stillGranted: () => options.destinations.isGranted(destination) }
              : {}),
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
  } finally {
    options.signal?.removeEventListener('abort', noteStop);
  }
}

/**
 * The calls in a batch whose arguments may not leave, each with what the model
 * is told instead.
 *
 * Grouped by destination — the server record's id AND its address, because a
 * record whose URL changed is somewhere else — and asked about once per group,
 * so a sheet lists every call its answer covers and no call it does not.
 * Nothing is remembered past this batch: see {@link DestinationDecision}.
 *
 * Fails closed three times. A tool with an `mcp:` id that declares no
 * destination is not sent, because nothing can say where it would go. Any
 * answer other than `calls` or `conversation` is a refusal. And once the turn
 * is stopped nothing more is asked, and a question already open is dropped:
 * every call it covered is refused as stopped, whatever is answered after.
 *
 * `onHeldGrant` names the calls let through only by a grant the conversation
 * already held, which the dispatcher reads again before each one runs. An
 * answer given in this batch is not in it: whether withdrawing a grant voids
 * the calls a person just allowed on screen is not ruled.
 */
async function refusedDestinations(
  calls: readonly ToolUseContent[],
  tools: readonly (ChatterangTool | undefined)[],
  policy: ToolDestinationPolicy,
  signal: AbortSignal | undefined,
): Promise<{ refused: Map<number, Refusal>; onHeldGrant: Set<number> }> {
  const refused = new Map<number, Refusal>();
  const onHeldGrant = new Set<number>();
  const groups = new Map<string, { destination: ToolDestination; indices: number[] }>();

  tools.forEach((tool, index) => {
    if (tool === undefined) return;
    const destination = tool.destination;
    if (destination === undefined) {
      if (tool.id.startsWith('mcp:')) {
        refused.set(index, {
          output: `${tool.name} was not sent: it does not say where its arguments would go.`,
          why: 'not-allowed',
        });
      }
      return;
    }
    const key = `${destination.serverId} ${destination.url}`;
    const group = groups.get(key) ?? { destination, indices: [] };
    group.indices.push(index);
    groups.set(key, group);
  });

  for (const { destination, indices } of groups.values()) {
    if (policy.isGranted(destination)) {
      for (const index of indices) onHeldGrant.add(index);
      continue;
    }

    let decision: DestinationDecision | undefined = 'deny';
    if (policy.request) {
      const asked: DestinationRequest = {
        destination,
        calls: indices.map((index) => ({
          toolName: tools[index]!.name,
          bytes: argumentBytes(calls[index]!.input),
          preview: argumentPreview(calls[index]!.input),
        })),
      };
      decision = signal?.aborted ? undefined : await unlessStopped(policy.request(asked, signal), signal);
      // STOPPED WHILE ASKING (#92, owner ruling OD7). Read off the signal, not
      // the answer: nothing leaves after Stop, no grant is kept from a sheet
      // answered after it, and every call the sheet covered is recorded.
      if (signal?.aborted) {
        const output = `This call’s arguments were not sent to ${destination.host}: the reply was stopped.`;
        for (const index of indices) refused.set(index, { output, why: 'stopped' });
        continue;
      }
      if (decision === 'conversation') policy.onGranted?.(destination);
    }
    if (decision === 'calls' || decision === 'conversation') continue;

    // No `request` hook means no person to ask (#293): distinct from a person
    // answering no, so it is named `unattended` rather than folded into
    // `not-allowed`. Only reachable once an unattended caller exists (#199).
    if (policy.request) {
      const output = `The user did not allow sending this call’s arguments to ${destination.host}.`;
      for (const index of indices) refused.set(index, { output, why: 'not-allowed' });
    } else {
      const output = `This call’s arguments were not sent to ${destination.host}: this conversation has not allowed that server, and nobody could be asked.`;
      for (const index of indices) refused.set(index, { output, why: 'unattended' });
    }
  }

  return { refused, onHeldGrant };
}

/** What the model is told instead of a result, and why the call was held back. */
interface Refusal {
  readonly output: string;
  readonly why: WithheldWhy;
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

    // What this request declares, as it begins: see `declared` on `runToolCalls`.
    const declared = enabledToolIds(context.request).flatMap((id) => {
      const tool = options.registry.get(id);
      return tool ? [tool] : [];
    });
    let response = await next();
    const executed: ExecutedTool[] = [];
    let messages: IRMessage[] = [...context.request.messages];

    for (let iteration = 0; iteration < maxIterations; iteration += 1) {
      const calls = findToolCalls(response.message);
      if (calls.length === 0) break;

      const batch = await runToolCalls(options.registry, calls, {
        enabledIds: enabledToolIds(context.request),
        // A DELIBERATE CLIFF. This path (`engine.complete`) has no conversation
        // to hold a grant and no moment to raise a sheet in, so no call that
        // leaves the device is sent from it, granted or not (#6).
        destinations: NO_DESTINATIONS,
        declared,
        signal: context.signal,
        onToolExecuted: options.onToolExecuted,
      });
      executed.push(...batch.executed);

      // STOPPED, as the streaming loop in `ai/engine.ts` does. Every refused
      // call is recorded above whatever the signal says, so a stopped batch
      // still hands back results; without this the backend was handed a
      // follow-up request over those refusals after Stop (#92).
      if (context.signal?.aborted) break;

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
