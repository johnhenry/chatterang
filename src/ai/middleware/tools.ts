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
import { closeReasoning, maskReasoning, reasoningSpans } from '@/domain/chat';
import { encodeUntrusted } from '@/ai/taint';
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
 * The names a textual call can give and be run by: each tool a request offered,
 * by its name and by its id, as `enabledTool` resolves a call's name.
 */
export function callNames(tools: readonly Pick<ChatterangTool, 'id' | 'name'>[]): string[] {
  return tools.flatMap((tool) => [tool.id, tool.name]);
}

/**
 * Where a call opens as this app writes one in a text prompt's history:
 * `[tool NAME(`, with the arguments' `{` after it. The match ends there, and
 * its group is the name.
 *
 * `messageText` in ai/prompt.ts renders a call that ran as
 * `[tool NAME({…})]` for a model whose prompt is a text template, so the
 * follow-up request shows the model its own call that way. A small model asked
 * for another call copies what its previous turn shows: none of the other
 * forms read it, so the call never ran, and its arguments — which the first
 * tool's output could have written — stayed in the stored reply and were sent
 * back in every later request.
 *
 * A model RECOUNTING what it did copies the same thing: "I filed it:
 * [tool notes.note({…})]". That copy repeats a call the history showed, name
 * and arguments, and is not run again; it is stripped as any call is. See
 * {@link shownCalls}. Only this form is read that way: a model's own call
 * markup is its call, the same arguments again or not.
 */
const APP_CALL_OPENING = /\[tool\s+([^()[\]{}\n]+?)\s*\(\s*(?=\{)/gi;

/**
 * The calls a request's history shows the model: every `tool_use` block in its
 * messages, as `messageText` in ai/prompt.ts writes each into a text template's
 * prompt, `[tool NAME({…})]`. In a turn's tool loop these are the calls its
 * earlier rounds made. See {@link extractTextualToolCalls}'s `shown`.
 */
export function shownCalls(messages: readonly IRMessage[]): ToolUseContent[] {
  return messages.flatMap((message) => structuredToolCalls(message));
}

/**
 * A call's name and arguments as a text template's history shows them, for
 * telling a recount of that call from a new one: every string in them, keys
 * included, as `sanitiseMessages` in ai/prompt.ts encodes a tool block's
 * (`encodeUntrusted`), and each object's keys in one order. A model copies
 * what it was shown — `10∶30` for the `10:30` the call was written with — or
 * writes the value as it first did; both read the same here, because encoding
 * an encoded string leaves it as it is.
 */
function asShown(name: string, input: unknown): string {
  const encode = (value: unknown): unknown => {
    if (typeof value === 'string') return encodeUntrusted(value);
    if (Array.isArray(value)) return value.map(encode);
    if (value !== null && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value)
          .map(([key, inner]) => [encodeUntrusted(key), encode(inner)] as const)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
      );
    }
    return value;
  };
  return JSON.stringify([encodeUntrusted(name), encode(input)]);
}

/**
 * `raw` read as a call's JSON: JSON, or JSON as a small model writes a call —
 * strings in single quotes, keys left unquoted, a comma before a closing
 * bracket, and Python's `True`, `False` and `None` — or undefined when it is
 * neither. The order of its tokens is checked, as JSON's is: this reads a
 * call's arguments, where {@link writesJson} only asks whether a call is being
 * written.
 */
export function looseJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    // Not JSON itself; read on as a small model writes it.
  }
  const notJson = new Error('not a call’s JSON');
  let at = 0;
  const skipSpace = (): void => {
    while (at < raw.length && /\s/.test(raw.charAt(at))) at += 1;
  };
  const quoted = (): string | undefined => {
    const quote = raw.charAt(at);
    if (quote !== '"' && quote !== "'") return undefined;
    let end = at + 1;
    while (end < raw.length && raw.charAt(end) !== quote) end += raw.charAt(end) === '\\' ? 2 : 1;
    if (end >= raw.length) throw notJson;
    const body = raw.slice(at + 1, end);
    at = end + 1;
    // Its escapes read as JSON's, and a single-quoted string's own quotes too.
    let asJson = '';
    for (let index = 0; index < body.length; index += 1) {
      const char = body.charAt(index);
      if (char === '\\') {
        const next = body.charAt(index + 1);
        asJson += next === "'" ? "'" : `\\${next}`;
        index += 1;
      } else if (char === '"') {
        asJson += '\\"';
      } else if (char < ' ') {
        asJson += `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`;
      } else {
        asJson += char;
      }
    }
    try {
      return JSON.parse(`"${asJson}"`) as string;
    } catch {
      return body;
    }
  };
  const bare = (pattern: RegExp): string | undefined => {
    pattern.lastIndex = at;
    const word = pattern.exec(raw)?.[0];
    if (word !== undefined) at += word.length;
    return word;
  };
  const value = (): unknown => {
    skipSpace();
    const char = raw.charAt(at);
    if (char === '{' || char === '[') {
      const object = char === '{';
      const closer = object ? '}' : ']';
      const out: Record<string, unknown> = {};
      const items: unknown[] = [];
      at += 1;
      skipSpace();
      while (raw.charAt(at) !== closer) {
        if (object) {
          const key = quoted() ?? bare(LOOSE_KEY);
          if (key === undefined) throw notJson;
          skipSpace();
          if (raw.charAt(at) !== ':') throw notJson;
          at += 1;
          // Defined, not assigned: a key `__proto__` is a key, as JSON.parse reads it.
          Object.defineProperty(out, key, { value: value(), enumerable: true, writable: true, configurable: true });
        } else {
          items.push(value());
        }
        skipSpace();
        if (raw.charAt(at) === ',') {
          at += 1;
          skipSpace();
        } else if (raw.charAt(at) !== closer) {
          throw notJson;
        }
      }
      at += 1;
      return object ? out : items;
    }
    const string = quoted();
    if (string !== undefined) return string;
    const word = bare(BARE_WORD);
    if (word === undefined || !JSON_WORD.test(word)) throw notJson;
    const literal = LITERALS.get(word);
    return literal === undefined && !LITERALS.has(word) ? Number(word) : literal;
  };
  try {
    const parsed = value();
    skipSpace();
    return at === raw.length ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** A key a small model leaves unquoted. */
const LOOSE_KEY = /[A-Za-z_$][\w$.-]*/y;
/** What each bare word that is not a number stands for, JSON's and Python's. */
const LITERALS: ReadonlyMap<string, unknown> = new Map<string, unknown>([
  ['true', true],
  ['false', false],
  ['null', null],
  ['True', true],
  ['False', false],
  ['None', null],
]);

/**
 * Recognise a textual tool call. Local models produce these in a handful of
 * shapes; all of them reduce to a name plus a JSON argument object.
 *
 * `offered` is what the request offered, as {@link callNames} gives it. A
 * fenced JSON block is a call only when it names one of those: see
 * `fencedCall`.
 *
 * `shown` is the calls the request's history showed the model, as
 * {@link shownCalls} gives them. A call in this app's own history form that
 * repeats one of them, name and arguments, is the model recounting what it
 * did, not a call: see `APP_CALL_OPENING`.
 *
 * NOTHING IN REASONING IS A CALL. Reasoning is the model thinking: its words
 * are never the reply's, and a call it names — "I could call <tool_call>{…}
 * </tool_call>, but I know this" — is not one the round made. Read with its
 * reasoning in it, a round ran a call only mentioned there and sent a
 * follow-up, and ran a call drafted there and then made twice. A block the
 * round closed is reasoning. One still open at the end is reasoning unless
 * the model ended the round (`ended`, see {@link TextEnding}): a round the
 * model ended with its reasoning open wrote its call before it closed it, and
 * the call runs. Stop, or a limit on tokens, cut the model's thinking short,
 * and a call it drafted there is not one it made: read as a round the model
 * ended, a round cut off at its limit mid-reasoning ran the call it was only
 * weighing, and sent an MCP server its arguments. See `reasoningSpans`.
 *
 * UNLESS THE MODEL ENDED THE ROUND WITH NOTHING OUTSIDE ITS REASONING. A
 * reasoning model can write its call inside its think block and close the
 * block with nothing after it: that call is the one the round made. Read as a
 * call only named there, it never ran, no follow-up was asked for, nothing said
 * why, and the reply was stored with no words. A call named in reasoning and
 * then answered, or drafted there and then made, has words or a call outside
 * the reasoning. A round Stop or a limit cut there could still have gone on to
 * either, so its reasoning stays reasoning.
 */
export function extractTextualToolCalls(
  text: string,
  offered: readonly string[],
  shown: readonly ToolUseContent[],
  { ended = 'model' }: { readonly ended?: TextEnding } = {},
): ToolUseContent[] {
  // Read outside its finished calls: a `<think>` a call's string argument names
  // is that argument's words. See `reasoningOutsideCalls`.
  const spans = reasoningOutsideCalls(text, offered, { unclosed: ended !== 'model' });
  let outside = '';
  let from = 0;
  for (const [start, stop] of spans) {
    outside += text.slice(from, start);
    from = stop;
  }
  outside += text.slice(from);
  const reasoning = ended === 'model' && outside.trim() === '' ? [] : spans;
  const inReasoning = (at: number): boolean => reasoning.some(([start, end]) => at >= start && at < end);

  // READ AS THE STRIPPER READS THEM: every call is one `callMarkup` finds, the
  // markup `stripToolSyntax` takes out of the words. The reader read a tag's
  // body only as one strict JSON object followed by its closing tag, and the
  // stripper took out more — several calls in one tag, an array of them,
  // Qwen3-Coder's XML, a name before its JSON, a trailing comma, a closing
  // brace too many or too few. Such a call, finished, was stripped and never
  // ran; stopped, it vanished from the words with no record that it had not
  // gone, which is the record #331 writes for a call it reads.
  //
  // THE OUTERMOST MARKUP ONLY: a call inside another's string, or the fenced
  // block inside a tag, is part of that call, not one of its own.
  const markup: CallMarkup[] = [];
  let end = 0;
  for (const found of callMarkup(text, offered).sort((a, b) => a.start - b.start || b.end - a.end)) {
    if (found.start < end) continue;
    end = found.end;
    if (!inReasoning(found.start)) markup.push(found);
  }

  // A COPY — a call in this app's own history form, `[tool NAME({…})]` — IS
  // READ ONLY WHEN NOTHING ELSE IS THE SAME CALL.
  //
  // NOT ONE THE HISTORY SHOWED. This is the form the follow-up's history shows
  // the model its own call in, and a model recounting what it did — "I filed
  // it: [tool notes.note({…})]" — copies it. Read as a call, it ran again: a
  // second note filed on the server, a second message sent. The copy is
  // stripped from the words as any call is, and runs nothing.
  //
  // NOR ONE THIS REPLY MAKES AGAIN. Compared with the history alone, a call the
  // reply announced in this form and then made in the model's own markup —
  // "Next, [tool notes.note({…})]:" and the `<tool_call>` — ran twice, and so
  // did one made and then recounted in the same reply, or written in this form
  // twice. Only this form is read that way: two of a model's own calls are its
  // calls.
  const copies = new Set(
    [...shown, ...markup.flatMap((found) => (found.copy ? [] : found.calls))].map((call) =>
      asShown(call.name, call.input),
    ),
  );
  const calls: ToolUseContent[] = [];
  for (const found of markup) {
    for (const call of found.calls) {
      if (found.copy) {
        const copy = asShown(call.name, call.input);
        if (copies.has(copy)) continue;
        copies.add(copy);
      }
      calls.push({ type: 'tool_use', id: `text_call_${calls.length}`, name: call.name, input: call.input });
    }
  }
  return calls;
}

/** A call a reply writes: the tool it names, and the arguments it gives it. */
interface WrittenCall {
  readonly name: string;
  readonly input: Record<string, unknown>;
}

/**
 * A call's markup in a reply's text, from `start` to just before `end`, and the
 * calls read from it.
 *
 * `calls` is empty for markup no call can be read from — a tag with nothing in
 * it, or a body that names no tool — which is still the model's markup, and is
 * stripped. `copy` is this app's own history form: see `APP_CALL_OPENING`.
 */
interface CallMarkup {
  readonly start: number;
  readonly end: number;
  readonly calls: readonly WrittenCall[];
  readonly copy: boolean;
}

/** A plain object, as a call's arguments are. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * The calls a tag's JSON holds: an object naming its tool by `name`, `tool` or
 * `function` with its arguments in `arguments`, `parameters` or `input`, or an
 * array of such objects. None from anything else.
 */
function callsInJson(parsed: unknown): WrittenCall[] {
  if (Array.isArray(parsed)) return parsed.flatMap((item) => (isRecord(item) ? callsInJson(item) : []));
  if (!isRecord(parsed)) return [];
  const name = [parsed['name'], parsed['tool'], parsed['function']].find(
    (value): value is string => typeof value === 'string',
  );
  if (name === undefined) return [];
  const args = parsed['arguments'] ?? parsed['parameters'] ?? parsed['input'] ?? {};
  return [{ name, input: isRecord(args) ? args : {} }];
}

/** A call to `name` with `raw`'s JSON as its arguments, when that JSON is an object. */
function callWithArguments(name: string, raw: string): WrittenCall[] {
  const input = looseJson(raw);
  return isRecord(input) ? [{ name, input }] : [];
}

/**
 * The call a fenced JSON block's body names, as `extractTextualToolCalls` reads
 * one: an object whose `tool`, `name` or `function` is a string naming a tool
 * the turn offered, with its arguments in `arguments`, `parameters` or `input`.
 * Undefined for any other body — a config file, a data record, an example
 * naming a tool the turn did not offer, or a nested tool definition, whose
 * `function` is an object.
 *
 * ONLY A NAME THE TURN OFFERED, by id or by name (`offered`, as
 * {@link callNames} gives it). A tag or `[TOOL_CALLS]` is a model's call markup
 * whatever it names, and is run and refused as a name nothing stands behind; a
 * fenced block is the shape of any JSON example. `name` is the commonest key a
 * JSON record has: a sample user record, `{"name": "Alice Chen", "email": …}`,
 * was run as a call to a tool named "Alice Chen" and stripped from the reply,
 * and in a chat whose only tool id named a disconnected server a generic
 * example `{"tool": "search", "arguments": …}` was run and stripped the same way.
 * Neither names an offered tool, so neither is a call.
 *
 * WHATEVER OTHER KEYS IT HOLDS BESIDE ITS ARGUMENTS (the owner's ruling). A
 * model that writes a call with an `id` or a `type` beside its name and
 * arguments is still calling the tool, and requiring nothing but a name and its
 * arguments left such a call unrun and in the reply. So a FLAT tool definition
 * naming an offered tool, `{"name": "calculate", "description": …,
 * "parameters": {…}}`, IS a call: its name is an offered tool, and its
 * `parameters` are read as the arguments.
 *
 * BUT A CALL CARRIES ITS ARGUMENTS — an `arguments`, `parameters` or `input`
 * key — OR IS NOTHING BUT ITS NAME, a call to a tool that takes none. A tool's
 * id is as plain a word as its name, and a record whose `name` is one is not a
 * call: `{"name": "calculator", "version": "1.0.0", …}`, a package.json for a
 * project named after the calculator tool's id, was run as a call to it and
 * stripped from the reply the person had asked for, and so was a column
 * definition `{"name": "datetime", "type": "timestamp"}`. A call to a tool
 * that takes no arguments written with more keys than its name and none for
 * arguments, `{"id": "call_0", "name": "get_datetime"}`, is read as words: the
 * accepted cost of not running a record.
 */
function fencedCall(
  body: string,
  offered: readonly string[],
): { name: string; input: Record<string, unknown> } | undefined {
  try {
    const parsed = JSON.parse(body) as {
      tool?: unknown;
      name?: unknown;
      function?: unknown;
      arguments?: unknown;
      parameters?: unknown;
      input?: unknown;
    } | null;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
    const name = parsed.tool ?? parsed.name ?? parsed.function;
    if (typeof name !== 'string' || !offered.includes(name)) return undefined;
    const keys = Object.keys(parsed);
    const carriesArguments = keys.some((key) => ARGUMENT_KEYS.has(key));
    if (!carriesArguments && !keys.every((key) => NAMING_KEYS.has(key))) return undefined;
    const args = parsed.arguments ?? parsed.parameters ?? parsed.input ?? {};
    return { name, input: (typeof args === 'object' && args ? args : {}) as Record<string, unknown> };
  } catch {
    return undefined;
  }
}

/**
 * Where the string whose quote is at `at` ends, just past its closing quote; -1
 * if the text ends first. Either quote opens one, as a small model writes a
 * call's JSON (see {@link looseJson}).
 *
 * EVERY SCANNER THAT FINDS WHERE A CALL'S JSON ENDS READS ITS STRINGS HERE.
 * They knew only JSON's double quote while the body was read with both, so a
 * `}` or `]` inside a single-quoted string closed the JSON early — the stripper
 * took the call out, and nothing could be read from what was left, so it never
 * ran, and stopped, no record said it had not gone — and a `"` inside one
 * opened a string that never closed, so the call was neither read nor
 * stripped, its arguments stored and sent back.
 */
function stringEnd(text: string, at: number): number {
  const quote = text.charAt(at);
  for (let end = at + 1; end < text.length; end += 1) {
    const char = text.charAt(end);
    if (char === '\\') end += 1;
    else if (char === quote) return end + 1;
  }
  return -1;
}

/**
 * Whether the character at `at` opens a string in a call's JSON (see
 * {@link stringEnd}): a double quote; or a single quote where a token starts —
 * the start of the JSON, or after a bracket, a comma, a colon, a paren or an
 * `=`, with only whitespace between.
 *
 * A SINGLE QUOTE INSIDE A WORD IS AN APOSTROPHE. Read as a string's opening,
 * the `it's` of a malformed body, `{name: calculate, arguments: {note: it's}}`,
 * opened a string that never closed: the call was neither stripped nor cut, and
 * its arguments were stored and sent back, where they had been stripped.
 */
function opensString(text: string, at: number): boolean {
  const char = text.charAt(at);
  if (char === '"') return true;
  if (char !== "'") return false;
  let before = at - 1;
  while (before >= 0 && /\s/.test(text.charAt(before))) before -= 1;
  return before < 0 || /[{[,:(=]/.test(text.charAt(before));
}

/**
 * Where the JSON object or array opening at `start` ends, just past its closing
 * bracket; -1 if the text ends first. A bracket inside a string, in either
 * quote, is not counted: see {@link stringEnd}.
 */
export function endOfJson(text: string, start: number): number {
  let depth = 0;
  for (let at = start; at < text.length; at += 1) {
    const char = text[at];
    if (opensString(text, at)) {
      const end = stringEnd(text, at);
      if (end === -1) return -1;
      at = end - 1;
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
 * What ends each tag or paren form of a call, once its JSON is written: the
 * token as a sticky pattern, for {@link shortCallEnd}, and as text with no
 * whitespace, for {@link unfinishedCallAt}'s reading of a call stopped partway
 * through its end.
 */
const CALL_END = {
  tag: { token: /<\/tool_call>/iy, text: '</tool_call>' },
  fencedTag: { token: /\x60{3}\s*<\/tool_call>/iy, text: '\x60\x60\x60</tool_call>' },
  paren: { token: /\)/y, text: ')' },
  bracket: { token: /\)\s*\]/y, text: ')]' },
} as const;

/**
 * The opening of a next call, `<tool_call>` or `[TOOL_CALLS]`, at the start of
 * what follows a tag or `[TOOL_CALLS]` call's JSON: it ends a call written
 * without its own close. See `CALL_SHAPES`.
 */
const NEXT_CALL = /^(?:<tool_call>|\[TOOL_CALLS?\])/i;

/**
 * A tool call's opening marker with nothing after it, in a text STOPPED OR CUT
 * SHORT: `<tool_call>` followed by the end of the text or a lone `{`;
 * `[TOOL_CALL]` or `[TOOL_CALLS]` followed by the end, by a tool name the text
 * ends in, or by `name(`. A stopped turn's text ends wherever Stop landed, so a
 * bare marker there may be a call begun; that it may also be a marker named in
 * prose is the accepted limit.
 *
 * SO DOES A TEXT CUT SHORT (see {@link TextEnding}): at its limit on tokens, in
 * a stream that failed, or in a local round that died before the cloud
 * fallback finished the turn. Read as a reply the model ended, a round cut off
 * on `<tool_call>` kept it: in the stored reply, in a failed row Try again keeps
 * as a version, and in a finished turn's words beside the cloud's, and in every
 * later request. Stop at the same character cut it.
 *
 * A NAME AFTER `[TOOL_CALLS]`, HERE AND IN EVERY FORM THAT WRITES ONE BEFORE
 * ITS ARGUMENTS, is a tool's name or id as `CALL_NAME` reads one: word
 * characters, dots, colons and hyphens. Every MCP tool is named `server.tool`,
 * with the id `mcp:server.tool`, and these forms read a word alone: a call to
 * one was neither read, run, stripped nor cut, so its arguments were stored
 * and sent back, finished or stopped, and Stop catching it complete wrote no
 * record that it had not gone.
 */
const CALL_MARKER_AT_END =
  /<tool_call>\s*(?:\x60{3}(?:json|tool)?\s*)?(?:\{|<\/?[a-z_]*)?\s*$|\[TOOL_CALLS?\](?:\s*[\w.:-]+\s*\(\s*|[ \t]*[\w.:-]*\s*)$|\[tool\s+[^()[\]{}\n]+?\s*\(\s*$/i;

/**
 * A call visibly opened with nothing inside it, in a reply THE MODEL ENDED:
 * `<tool_call>{` or `[TOOL_CALLS] name(` at the end. A finished reply ended
 * where the model ended it, and one ending on a bare `[TOOL_CALLS]` or
 * `<tool_call>`, or on "[TOOL_CALLS] token", is a sentence naming the marker:
 * the stopped pattern above cut "Mistral models put every call after the
 * special token [TOOL_CALLS]" to "... the special token".
 */
const CALL_OPENED_AT_END =
  /<tool_call>\s*(?:\x60{3}(?:json|tool)?\s*)?\{\s*$|\[TOOL_CALLS?\]\s*[\w.:-]+\s*\(\s*$|\[tool\s+[^()[\]{}\n]+?\s*\(\s*$/i;

/**
 * A call's opening shape with its arguments begun: `<tool_call>` and the `{`
 * or `[` a call's JSON opens with, or `[TOOL_CALL]`/`[TOOL_CALLS]`, `name(` and
 * a `{`. The match ends where the arguments' `{` or `[` starts.
 *
 * A fenced call wrapped in the tag opens `<tool_call>`, a fence, and a `{`.
 * Qwen3-Coder's opens `<tool_call>` and `<function=`: see `xmlCallEnd`. One
 * whose body is a name and its JSON opens `<tool_call>`, the name, and a `(` or
 * `{`: see `taggedCallsEnd`, which reads an array of calls too. This app's own
 * rendering opens `[tool`, the name, `(` and a `{`: see `APP_CALL_OPENING`. A
 * `[TOOL_CALLS]` call written as Python writes one opens its name, `(` and a
 * keyword: see `readKeywordArguments`, which the tag form's reading uses too.
 *
 * NOT ONLY `{"`. A small model's call is often single-quoted, leaves its keys
 * unquoted, or is an array of calls, and the opening this read — the `{"` of
 * strict JSON — let a turn stopped inside any of them keep the call, its
 * arguments stored and sent back. Whether what follows is a call being written
 * or prose naming the tag is {@link writesJson}'s question, which reads a
 * single-quoted string and an unquoted key as a call's own.
 *
 * A fence's backtick is spelled `\x60`: the source scans in
 * tests/support/source-scan.ts read a bare one in a regex literal as the start
 * of a string.
 */
const CALL_OPENING = /<tool_call>\s*(?=[{[])|\[TOOL_CALLS?\]\s*[\w.:-]+\s*\(\s*(?=[{A-Za-z_])|<tool_call>\s*(?=<function=)|<tool_call>\s*\x60{3}(?:json|tool)?\s*(?=\{)|<tool_call>\s*(?=[\w.:-]+\s*[({])|\[tool\s+[^()[\]{}\n]+?\s*\(\s*(?=\{)/gi;

/**
 * Where the JSON object opening at `start` ends, just past its closing brace;
 * -1 if the text ends first. A brace inside a string, in either quote, is not
 * counted: see {@link stringEnd}.
 */
function endOfObject(text: string, start: number): number {
  let depth = 0;
  for (let at = start; at < text.length; at += 1) {
    const char = text[at];
    if (opensString(text, at)) {
      const end = stringEnd(text, at);
      if (end === -1) return -1;
      at = end - 1;
    } else if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) return at + 1;
    }
  }
  return -1;
}

/**
 * A word a call's JSON writes bare: a number, `true`, `false` or `null`, or
 * Python's `True`, `False` or `None`, which a model writing its call as a
 * Python dict writes in their place. Read as JSON's alone, a single-quoted call
 * holding `True` was read as prose, and a turn stopped inside it kept it.
 */
const JSON_WORD = /^(?:-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null|True|False|None)$/;
/** Any bare word, read where {@link writesJson} finds one. */
const BARE_WORD = /[\w.+-]+/y;
/** A colon after a bare word, which makes it a key a small model left unquoted. */
const AFTER_KEY = /\s*:/y;
/** The keys a tag form's JSON names its tool by, as `extractTextualToolCalls` and `fencedCall` read them. */
const NAMING_KEYS: ReadonlySet<string> = new Set(['name', 'tool', 'function']);
/** The keys a fenced call carries its arguments in, as `fencedCall` reads them. */
const ARGUMENT_KEYS: ReadonlySet<string> = new Set(['arguments', 'parameters', 'input']);

/**
 * How a text ended, which decides what at its end is a call still being
 * written: see {@link unfinishedCallAt}.
 *
 * - `'stopped'`: Stop landed in it.
 * - `'cut'`: its stream was cut short. It failed, or it finished for any reason
 *   but the model's own, as at its limit on tokens.
 * - `'model'`: the model ended it, and its stream said so: `stop`, or
 *   `tool_calls`.
 */
export type TextEnding = 'stopped' | 'cut' | 'model';

/**
 * Where in a call a text that ends inside it ends: `'open'`, in its structure
 * — its brackets, a key, the tool's name, a bare value, a tag — where nothing
 * but the call can stand; `'in-value'`, in the words of one of its values — a
 * string, or a Qwen3-Coder parameter's value — which can be anything, a
 * sentence included.
 */
export type Unended = 'open' | 'in-value';

/**
 * Could the text from `start`, where a call's JSON opens, to the end of the text
 * be that JSON still being written? `'in-value'` when it could, and the text
 * ends inside one of its values' strings: see {@link Unended}.
 *
 * Only JSON's own tokens stand outside its strings — brackets, colons, commas,
 * strings, numbers, `true`, `false`, `null`, and a key left unquoted — and a
 * word the text ends in, which may be one of those half written. Nothing is
 * asked of their order: a small model's call can be malformed and is still its
 * call.
 *
 * `tagged` is a tag form's JSON, whose top-level keys are the call's own and
 * whose `name` names a tool. Neither holds a space, unless the name is the start
 * of an offered tool's that does (an MCP server's name can). The call's own
 * object is the top-level one, or one in a top-level array of calls.
 *
 * A STRING MAY BE SINGLE-QUOTED, AND A KEY UNQUOTED, as a small model writes
 * them. Read as JSON's strings alone, a call written `{'name': 'notes.note',
 * 'arguments': {'text': '…` was not a call being written, and a turn stopped
 * inside one kept it, its arguments stored and sent back.
 *
 * THE BRACES AND QUOTES ALONE CANNOT TELL A CALL FROM PROSE. A finished reply
 * explaining how to parse a call — "look for the prefix `[TOOL_CALLS]
 * get_weather({` in the output and read the JSON until its brackets balance",
 * or "Qwen starts each call with `<tool_call>{"name": "` and the tool name
 * follows" — has a brace that never closes, or a quote that never does, and was
 * cut from the call's opening on: the sentences after it, which the person had
 * watched arrive, were gone from the stored reply and every later request.
 *
 * `until`, when given, is where JSON that closed ends, just past its closing
 * bracket: then the question is whether what lies between is JSON's tokens
 * alone, as `taggedCallsEnd` asks of each call in a tag.
 */
function writesJson(
  text: string,
  start: number,
  {
    tagged,
    offered,
    until = text.length,
  }: { readonly tagged: boolean; readonly offered: readonly string[]; readonly until?: number },
): boolean | 'in-value' {
  /** Each bracket still open: an object reading a key, or reading the value of `naming` one; or an array. */
  const containers: { readonly object: boolean; key: boolean; naming: boolean }[] = [];
  /** Whether the object on top is the call's own: at the top level, or in a top-level array of calls. */
  const callsOwn = (): boolean =>
    containers.length === 1 || (containers.length === 2 && containers[0]?.object === false);
  let at = start;
  while (at < until) {
    const char = text.charAt(at);
    const top = containers.at(-1);
    if (/\s/.test(char)) {
      at += 1;
    } else if (char === '"' || char === "'") {
      let end = at + 1;
      while (end < until && text.charAt(end) !== char) end += text.charAt(end) === '\\' ? 2 : 1;
      const body = text.slice(at + 1, end);
      const ownWord = tagged && callsOwn() && top !== undefined && top.object && (top.key || top.naming);
      if (ownWord && /\s/.test(body) && !offered.some((name) => name.startsWith(body))) return false;
      // The text ends inside it: in a key, or the tool's name, which are the
      // call's structure; or in a value, whose words can be anything. So can a
      // key's that holds a space, as no argument's name does: "its arguments
      // are `{"` and then each key…" is a sentence.
      if (end >= until) {
        const structure = (top?.object === true && top.key && !/\s/.test(body)) || ownWord;
        return structure ? true : 'in-value';
      }
      if (top?.object && top.key) top.naming = NAMING_KEYS.has(body);
      at = end + 1;
    } else if (char === '{' || char === '[') {
      containers.push({ object: char === '{', key: char === '{', naming: false });
      at += 1;
    } else if (char === '}' || char === ']') {
      containers.pop();
      // Closed before the end: not JSON still being written, nor JSON that ends there.
      if (containers.length === 0) return at + 1 === until;
      at += 1;
    } else if (char === ':') {
      if (top?.object) top.key = false;
      at += 1;
    } else if (char === ',') {
      if (top?.object) {
        top.key = true;
        top.naming = false;
      }
      at += 1;
    } else {
      BARE_WORD.lastIndex = at;
      const word = BARE_WORD.exec(text)?.[0];
      if (word === undefined) return false;
      at += word.length;
      AFTER_KEY.lastIndex = at;
      if (!JSON_WORD.test(word) && at < until && !AFTER_KEY.test(text)) return false;
      // An unquoted key names the tool as a quoted one does.
      if (top?.object && top.key) top.naming = NAMING_KEYS.has(word);
    }
  }
  return true;
}

/**
 * Where a tool call still being written starts, or -1: a call's opening shape
 * with the text ending inside it.
 *
 * Its arguments' JSON still open at the end of the text; or closed, with
 * nothing after them but what is left of the call's own end — some of
 * `</tool_call>`, or of the `)`. Or an opening marker the text ends on. A call
 * with a closing bracket too few that its tag or paren ends is finished, as
 * `stripToolSyntax` reads it: see {@link shortCallEnd}.
 *
 * ANCHORED TO THE END OF THE TEXT, NOT TO THE MARKER. Any `<tool_call>` or
 * `[tool_calls]` was cut to the end of the reply, and a reply can name one in
 * words: "Qwen wraps each call in a `<tool_call>` tag", or a TOML example with
 * a `[tool_calls]` table. Then any `<tool_call>{"` was, and a reply can show
 * one: an example of Qwen's format with no closing tag and the explanation
 * after it, cut from the example on — finished or stopped, and a reply whose
 * words began with such an example was stored with none and shown as
 * "Stopped before its first word". Everything after it, which the person had
 * watched arrive, was gone.
 *
 * AND THE TEXT IS ONE ROUND'S. Handed a tool turn's rounds joined, the end of
 * the text is the last round's: a call the calling round ended inside was
 * either cut with every later round's words — its string or its JSON ran on
 * into them — or, closed with no tag, followed by those words and kept, its
 * arguments stored and sent back. Each round is cut where it ends, by
 * {@link cutUnfinishedCall}, before the next is joined to it.
 *
 * ENDING INSIDE ITS ARGUMENTS MEANS WRITING JSON TO THE END, as
 * {@link writesJson} reads it. A brace that never closes, or a quote that
 * never does, is as often a sentence naming a call's opening and going on.
 * `offered` is the names a call can give, as {@link callNames} gives them.
 *
 * AND ONLY A TEXT CUT SHORT ENDS INSIDE A VALUE'S WORDS (`ended`: see
 * {@link TextEnding}). A string, or a Qwen3-Coder parameter's value, can hold
 * any words, so an opening named in prose with no closing quote or tag after
 * it — Qwen3-Coder's `<tool_call>`, `<function=get_weather>` and
 * `<parameter=city>` on lines of their own in a code block, and the sentences
 * after it; "A Python-style call looks like <tool_call>search(query=" and
 * then…" — reads as a call still being written to the end of the text, and a
 * reply the model finished was cut from it: every word after it, which the
 * person had watched arrive, was gone from the stored reply and every later
 * request, and a reply that began with one was stored with no words at all. A
 * model that ends its reply has ended any call it wrote, so in a text the model
 * ended, words that run on from inside a value are a sentence. A text Stop
 * landed in, or cut short — a stream that died, one at its limit on tokens —
 * ended wherever it was, and is cut from the call. Where the text ends in a
 * call's structure, it is a call being written however the text ended.
 */
export function unfinishedCallAt(
  text: string,
  { ended, offered }: { readonly ended: TextEnding; readonly offered: readonly string[] },
): number {
  /** Whether a call the text ends inside, at `where` in it, is one being written. */
  const beingWritten = (where: Unended): boolean => where === 'open' || ended !== 'model';
  let from = 0;
  // CALLS WRITTEN WITHOUT THEIR CLOSE, EACH ENDED BY THE NEXT ONE'S OPENING (see
  // `CALL_SHAPES`), are cut together: `chain` is where the first starts, and
  // `next` where the opening after the last stands. Cut from the call after
  // them alone, the last had nothing after it to end it, and was neither
  // stripped nor cut: its arguments were stored and sent back.
  let chain: number | undefined;
  let next = -1;
  for (const match of text.matchAll(CALL_OPENING)) {
    if (match.index < from) continue;
    if (match.index !== next) chain = undefined;
    const cutFrom = chain ?? match.index;
    const open = match.index + match[0].length;
    if (text.startsWith('<', open)) {
      // Qwen3-Coder's XML body, read by its structure: see `xmlCallEnd`.
      const end = xmlCallEnd(text, match.index);
      if (typeof end === 'string') {
        if (beingWritten(end)) return cutFrom;
        continue;
      }
      if (end !== -1) from = end;
      continue;
    }
    const form =
      CALL_END[
        /^\[tool\s/i.test(match[0])
          ? 'bracket'
          : !match[0].startsWith('<')
            ? 'paren'
            : match[0].includes('\x60')
              ? 'fencedTag'
              : 'tag'
      ];
    if (form === CALL_END.tag && text.charAt(open) !== '{') {
      // A name and its JSON inside the tag, read by its structure: see `taggedCallsEnd`.
      const end = taggedCallsEnd(text, match.index, offered);
      if (typeof end === 'string') {
        if (beingWritten(end)) return cutFrom;
        continue;
      }
      if (end !== -1) from = end;
      continue;
    }
    if (form === CALL_END.paren && text.charAt(open) !== '{') {
      // Python's keyword arguments: see `readKeywordArguments`.
      const { end } = readKeywordArguments(text, open);
      if (typeof end === 'string') {
        if (beingWritten(end)) return cutFrom;
        continue;
      }
      if (end !== -1) from = end;
      continue;
    }
    const short = shortCallEnd(text, open, form.token);
    if (short !== -1) {
      from = short;
      continue;
    }
    const close = endOfObject(text, open);
    if (close === -1) {
      const writing = writesJson(text, open, { tagged: form === CALL_END.tag || form === CALL_END.fencedTag, offered });
      if (writing && beingWritten(writing === true ? 'open' : writing)) return cutFrom;
      continue;
    }
    // Stray closing brackets are the call's, as `stripToolSyntax` reads them:
    // a call with a brace too many, stopped before its closing tag.
    // Compared with no whitespace: a fenced call's end is a fence, a line break
    // and `</tool_call>`, and none of a call's closing tokens holds a space.
    const stray = /^[\s}\]]*/.exec(text.slice(close))?.[0].length ?? 0;
    const after = text.slice(close + stray);
    const rest = after.replace(/\s+/g, '').toLowerCase();
    if (form.text.startsWith(rest)) return cutFrom;
    // Or partway into the opening of a next call, the one that would end this
    // call written without its close (see `NEXT_CALL`).
    const unclosable = form === CALL_END.tag || form === CALL_END.paren;
    if (unclosable && ['<tool_call>', '[tool_calls]', '[tool_call]'].some((opening) => opening.startsWith(rest))) {
      return cutFrom;
    }
    // More calls after it inside the same tag: see `taggedCallsEnd`.
    if (form === CALL_END.tag) {
      const end = taggedCallsEnd(text, match.index, offered);
      if (typeof end === 'string') {
        if (beingWritten(end)) return cutFrom;
        continue;
      }
      if (end !== -1) {
        from = end;
        continue;
      }
    }
    // Written without its close, the next call's opening right after it.
    if (unclosable && NEXT_CALL.test(after)) {
      chain = cutFrom;
      next = close + stray;
    } else {
      chain = undefined;
    }
    from = close;
  }
  // A text stopped or cut short ends wherever it was, on a bare marker too.
  const at = text.search(ended === 'model' ? CALL_OPENED_AT_END : CALL_MARKER_AT_END);
  return chain !== undefined && at === next ? chain : at;
}

/**
 * `text` up to where a tool call it ended inside starts — see
 * {@link unfinishedCallAt} — or all of it. `ended` is how the text ended (see
 * {@link TextEnding}); `offered` is the names a call can give, as
 * {@link callNames} gives them.
 *
 * Found in its WORDS: a round's text still holds its reasoning, and a call its
 * reasoning names is not one the round was writing. See `maskReasoning`. Its
 * reasoning is read outside its finished calls: see
 * {@link reasoningOutsideCalls}.
 */
export function cutUnfinishedCall(
  text: string,
  reading: { readonly ended: TextEnding; readonly offered: readonly string[] },
): string {
  const at = unfinishedCallAt(maskReasoning(text, reasoningOutsideCalls(text, reading.offered)), reading);
  return at === -1 ? text : text.slice(0, at);
}

/**
 * `text` with each finished call's markup, as `callMarkup` finds it, blanked to
 * spaces. Every other character stays where it was.
 */
function blankCalls(text: string, offered: readonly string[]): string {
  let out = '';
  let at = 0;
  for (const { start, end } of callMarkup(text, offered).sort((a, b) => a.start - b.start)) {
    if (end <= at) continue;
    const from = Math.max(start, at);
    out += text.slice(at, from) + ' '.repeat(end - from);
    at = end;
  }
  return out + text.slice(at);
}

/**
 * Where each reasoning block in a round's text stands, as `reasoningSpans` in
 * domain/chat.ts reads them, with each finished call's markup read as the
 * call's own. `unclosed` is as `reasoningSpans` takes it.
 *
 * A REASONING TAG IN A CALL'S STRING ARGUMENT IS THE ARGUMENT'S WORDS: a note
 * saying "reason inside <thinking> tags". Read as reasoning opening there, it
 * ran to the end of the round. A call after it was taken for one drafted in
 * reasoning, and not recorded when Stop caught it; a round cut short was cut
 * from the call's opening, every word after it with it; and the store closed
 * the "reasoning" where the round ended, which split the call in two — half
 * of it, arguments and all, stored as the reply's words and sent back, where
 * the stripper could not find it. See {@link closeReasoningOutsideCalls}.
 */
export function reasoningOutsideCalls(
  text: string,
  offered: readonly string[],
  { unclosed = true }: { readonly unclosed?: boolean } = {},
): [number, number][] {
  return reasoningSpans(blankCalls(text, offered), { unclosed });
}

/**
 * `closeReasoning` from domain/chat.ts, reading the reasoning outside the
 * text's finished calls (see {@link reasoningOutsideCalls}): a reasoning tag a
 * call's string argument names leaves no reasoning open.
 */
export function closeReasoningOutsideCalls(text: string, offered: readonly string[]): string {
  return closeReasoning(text, blankCalls(text, offered));
}

/**
 * Each textual call's shape: where its JSON may open, what must follow the JSON
 * once it closes, and whether a body in that shape is a call.
 *
 * `<tool_call>` and `[TOOL_CALLS] name(` are markup whatever their JSON holds.
 * A malformed body is read as a small model writes JSON (see {@link looseJson})
 * and runs as the call it names; one that names no tool even then runs nothing,
 * and is still the model's plumbing. A fenced block is markup only when it reads
 * as a call, because any other is a code example.
 *
 * A tag or paren's close may come after stray closing brackets: a small model's
 * commonest malformed call has one brace too many, `{"name": …, "arguments":
 * {…}}}`, and its JSON closed a brace early and was not followed by the tag, so
 * the call and its arguments were kept as the reply's words and sent back.
 *
 * THE NEXT CALL'S OPENING ENDS A CALL WRITTEN WITHOUT ITS CLOSE, in the tag and
 * `[TOOL_CALLS]` forms: `<tool_call>{…}` then `<tool_call>{…}</tool_call>`, or
 * `[TOOL_CALLS] a({…}` then `[TOOL_CALLS] b({…})`, with only whitespace and
 * stray brackets between (`NEXT_CALL`, either opening after either form). A
 * small model writing two calls leaves out the first's close, and read by a
 * close that had to follow its JSON the first was neither read, stripped nor
 * cut: only the second ran, and the first, arguments and all, was stored and
 * sent back in every later request. The lazy match main stripped with took
 * both out. Words between them are prose.
 *
 * `short` is the token that ends a tag or paren form, for a call with a closing
 * bracket too few: see {@link shortCallEnd}. A fenced block has none, because
 * any other is a code example.
 *
 * `read` is the calls the markup holds, from its JSON and its opening's match,
 * whose group is the tool's name in the forms that write it before the JSON; or
 * undefined when a fenced block is not a call, and so not markup at all. It is
 * `extractTextualToolCalls`'s reading, so what is stripped as a call is read as
 * that call. `copy` is this app's own history form: see `APP_CALL_OPENING`.
 */
const CALL_SHAPES: readonly {
  readonly open: RegExp;
  readonly close: RegExp;
  readonly short?: RegExp;
  readonly read: (json: string, opening: RegExpExecArray, offered: readonly string[]) => WrittenCall[] | undefined;
  readonly copy?: boolean;
}[] = [
  {
    open: /<tool_call>\s*(?=[{[])/gi,
    close: /^[\s}\]]*(?:<\/tool_call>|(?=<tool_call>|\[TOOL_CALLS?\]))/i,
    short: CALL_END.tag.token,
    read: (json) => callsInJson(looseJson(json)),
  },
  // The tag around a fenced block: markup whatever the JSON holds, as the tag
  // form is. Stripping only the fenced call inside left `<tool_call>\n\n</tool_call>`.
  {
    open: /<tool_call>\s*```(?:json|tool)?\s*(?=[{[])/gi,
    close: /^[\s}\]]*```\s*<\/tool_call>/i,
    short: CALL_END.fencedTag.token,
    read: (json) => callsInJson(looseJson(json)),
  },
  {
    open: /\[TOOL_CALLS?\]\s*([\w.:-]+)\s*\(\s*(?=\{)/gi,
    close: /^[\s}\]]*(?:\)|(?=\[TOOL_CALLS?\]|<tool_call>))/i,
    short: CALL_END.paren.token,
    read: (json, opening) => callWithArguments(opening[1] ?? '', json),
  },
  // This app's own rendering of a call in a text prompt's history, which a model
  // copies: see `APP_CALL_OPENING`. Markup whatever its JSON holds, as the
  // Mistral form is.
  {
    open: APP_CALL_OPENING,
    close: /^[\s}\]]*\)\s*\]/,
    short: CALL_END.bracket.token,
    read: (json, opening) => callWithArguments(opening[1]?.trim() ?? '', json),
    copy: true,
  },
  {
    open: /```(?:json|tool)?\s*(?=\{)/gi,
    close: /^\s*```/,
    read: (json, _opening, offered) => {
      const call = fencedCall(json, offered);
      return call ? [call] : undefined;
    },
  },
];

/**
 * Every finished call's markup in `text`, and the calls read from it: what
 * `stripToolSyntax` takes out of a reply's words, and what
 * `extractTextualToolCalls` reads as its calls. One reading, so that a call the
 * words lose is a call that runs, or is recorded as not sent.
 *
 * Markup can nest — a call inside another's string, the fenced block inside a
 * tag — and one call can be found by two readers: the stripper takes out the
 * union, and the reader reads the outermost.
 */
function callMarkup(text: string, offered: readonly string[]): CallMarkup[] {
  const found: CallMarkup[] = [];
  for (const { open, close, short, read, copy = false } of CALL_SHAPES) {
    for (const match of text.matchAll(open)) {
      const from = match.index + match[0].length;
      // A closing bracket too few, ended by its tag or paren: read before the
      // JSON's end, which a later brace in the text can supply. See `shortCallEnd`.
      const shortened = short ? shortCall(text, from, short) : undefined;
      let json: string;
      let end: number;
      if (shortened) {
        ({ json, end } = shortened);
      } else {
        const closed = endOfJson(text, from);
        if (closed === -1) continue;
        const closing = close.exec(text.slice(closed));
        if (!closing) continue;
        json = text.slice(from, closed);
        end = closed + closing[0].length;
      }
      const calls = read(json, match, offered);
      if (calls) found.push({ start: match.index, end, calls, copy });
    }
  }
  for (const match of text.matchAll(EMPTY_CALL)) {
    const name = match[1];
    found.push({
      start: match.index,
      end: match.index + match[0].length,
      calls: name ? [{ name, input: {} }] : [],
      copy: false,
    });
  }
  for (const match of text.matchAll(KEYWORD_CALL_OPENING)) {
    const { end, input } = readKeywordArguments(text, match.index + match[0].length);
    if (typeof end === 'number' && end !== -1) {
      found.push({ start: match.index, end, calls: [{ name: match[1] ?? '', input }], copy: false });
    }
  }
  for (const match of text.matchAll(XML_CALL_OPENING)) {
    const { end, calls } = readXmlCall(text, match.index);
    if (typeof end === 'number' && end !== -1) found.push({ start: match.index, end, calls, copy: false });
  }
  for (const match of text.matchAll(TAG_OPENING)) {
    const { end, calls } = readTaggedCalls(text, match.index, offered);
    if (typeof end === 'number' && end !== -1) found.push({ start: match.index, end, calls, copy: false });
  }
  return found;
}

/**
 * Where a call whose JSON opens at `start` and has a closing bracket too few
 * ends: just past `short`, the token that ends its form, when that token comes
 * outside any string before the JSON's brackets close, and the JSON before it
 * parses once the brackets still open are closed. -1 for anything else — a call
 * whose JSON closes, one still being written, or prose.
 *
 * A small model's other commonest malformed call is a brace too few:
 * `<tool_call>{"name": "leaky", "arguments": {"path": "notes.md"}</tool_call>`.
 * Its JSON never closes, so it was not stripped, and the unfinished-call cut
 * read it as a call still being written: everything after it went, the words
 * the model wrote after its closing tag, and in a tool turn the follow-up's
 * whole answer. The reply was stored with none of them, or with no words at all
 * and shown as "Stopped before its first word".
 *
 * THE FIRST SUCH TOKEN, AND ONLY JSON BEFORE IT. Prose between an opening shape
 * and a closing tag it names — "write `<tool_call>{"name": "x"` and end it with
 * `</tool_call>`" — does not parse, and keeps every word. The call read this
 * way runs, from the JSON with its missing brackets: see {@link shortCall}.
 *
 * Its strings are read in either quote, and its JSON as a call's is (see
 * {@link looseJson}): a single-quoted call with a brace too few was read as
 * neither, and was kept, its arguments stored and sent back.
 */
export function shortCallEnd(text: string, start: number, short: RegExp): number {
  return shortCall(text, start, short)?.end ?? -1;
}

/**
 * {@link shortCallEnd}'s reading, with the call's JSON as it parsed: the text
 * from `start` to the token, and the brackets that were missing.
 */
function shortCall(text: string, start: number, short: RegExp): { end: number; json: string } | undefined {
  const open: string[] = [];
  for (let at = start; at < text.length; at += 1) {
    const char = text[at];
    if (opensString(text, at)) {
      const end = stringEnd(text, at);
      if (end === -1) return undefined;
      at = end - 1;
    } else if (char === '{' || char === '[') {
      open.push(char);
    } else if (char === '}' || char === ']') {
      open.pop();
      if (open.length === 0) return undefined;
    } else if (open.length > 0) {
      short.lastIndex = at;
      const token = short.exec(text);
      if (!token) continue;
      const closers = open.map((bracket) => (bracket === '{' ? '}' : ']')).reverse().join('');
      const json = text.slice(start, at) + closers;
      return isRecord(looseJson(json)) ? { end: at + token[0].length, json } : undefined;
    }
  }
  return undefined;
}

/**
 * A call with nothing inside it at all: `<tool_call></tool_call>`, which names
 * no tool, or `[TOOL_CALLS] name()`, a call to a tool that takes no arguments.
 * The group is that name.
 */
const EMPTY_CALL = /<tool_call>\s*<\/tool_call>|\[TOOL_CALLS?\]\s*([\w.:-]+)\s*\(\s*\)/gi;

/** Where a Qwen3-Coder call may start: a `<tool_call>` with `<function=` after it. See {@link xmlCallEnd}. */
export const XML_CALL_OPENING = /<tool_call>\s*(?=<function=)/gi;

/**
 * Where a Qwen3-Coder call starting at `at` ends, just past its `</tool_call>`;
 * {@link Unended} when the text ends inside one — `'in-value'` inside a
 * parameter's value, whose words can be anything; -1 when what is there is not
 * one.
 *
 *     <tool_call>
 *     <function=NAME>
 *     <parameter=KEY>
 *     VALUE
 *     </parameter>
 *     </function>
 *     </tool_call>
 *
 * The call runs: the function is the tool, and each parameter an argument
 * whose value is the text between its tags, one line break either side taken
 * off, as Qwen3-Coder writes it. Its values are strings: nothing in the call
 * says which is a number. It was only stripped, and a call the words lost
 * never ran, and a stopped one had no record that it had not gone.
 *
 * READ BY ITS STRUCTURE, as a JSON call is by its brackets: these tags in this
 * order, with nothing but whitespace between them outside a parameter's value.
 * A lazy match from `<tool_call>` to `</tool_call>` takes every word of a
 * sentence that names both, and prose naming this form's tags stops matching
 * the structure as soon as it goes on.
 */
export function xmlCallEnd(text: string, at: number): number | Unended {
  return readXmlCall(text, at).end;
}

/** {@link xmlCallEnd}'s reading, with the call it read when it is whole. */
function readXmlCall(text: string, at: number): { end: number | Unended; calls: WrittenCall[] } {
  let pos = at;
  /** Read `word` here, in any case: true; `'open'` when the text ends partway through it; or false. */
  const read = (word: string): boolean | 'open' => {
    const piece = text.slice(pos, pos + word.length).toLowerCase();
    if (piece === word) {
      pos += word.length;
      return true;
    }
    return pos + piece.length === text.length && word.startsWith(piece) ? 'open' : false;
  };
  /**
   * Read `NAME>`: a name with no space or angle bracket in it, and the `>`
   * after it; `'open'` when the text ends first. The name comes back in an
   * object, so that a tool or parameter named `open` is not read as the text
   * ending inside its name — or a text ending there as a parameter named `open`.
   */
  const readName = (): { readonly name: string } | 'open' | false => {
    const name = /^[^\s<>]*/.exec(text.slice(pos))?.[0] ?? '';
    pos += name.length;
    if (pos === text.length) return 'open';
    if (name === '' || text.charAt(pos) !== '>') return false;
    pos += 1;
    return { name };
  };
  const skipSpace = (): void => {
    while (pos < text.length && /\s/.test(text.charAt(pos))) pos += 1;
  };
  const notACall = (step: boolean | 'open'): { end: number | Unended; calls: WrittenCall[] } => ({
    end: step === 'open' ? 'open' : -1,
    calls: [],
  });

  let step = read('<tool_call>');
  if (step !== true) return notACall(step);
  skipSpace();
  step = read('<function=');
  if (step !== true) return notACall(step);
  const tool = readName();
  if (typeof tool !== 'object') return notACall(tool);
  const { name } = tool;
  const input: Record<string, unknown> = {};
  for (;;) {
    skipSpace();
    if (pos === text.length) return notACall('open');
    step = read('<parameter=');
    if (step === 'open') return notACall('open');
    if (step === true) {
      const key = readName();
      if (typeof key !== 'object') return notACall(key);
      const close = text.toLowerCase().indexOf('</parameter>', pos);
      if (close === -1) {
        // Its value runs to the end of the text: the call is still being
        // written, or a sentence named its opening and went on (see
        // `unfinishedCallAt`). Unless the text ends inside the tag that closes
        // it, which is the call's structure, as a JSON call's closing tag is.
        const tag = text.lastIndexOf('<');
        const closing =
          tag >= pos && text.length - tag >= 2 && '</parameter>'.startsWith(text.slice(tag).toLowerCase());
        return { end: closing ? 'open' : 'in-value', calls: [] };
      }
      const value = text.slice(pos, close).replace(/^\r?\n/, '').replace(/\r?\n$/, '');
      Object.defineProperty(input, key.name, { value, enumerable: true, writable: true, configurable: true });
      pos = close + '</parameter>'.length;
      continue;
    }
    step = read('</function>');
    if (step !== true) return notACall(step);
    skipSpace();
    step = read('</tool_call>');
    if (step !== true) return notACall(step);
    return { end: pos, calls: [{ name, input }] };
  }
}

/** Where a call {@link taggedCallsEnd} reads may start: any `<tool_call>`. */
const TAG_OPENING = /<tool_call>/gi;
/** A tool's name as a call inside a tag writes it before its JSON: by name or by id. */
const CALL_NAME = /[\w.:-]+/y;
/** The tag that ends every `<tool_call>`. */
const TAG_END = '</tool_call>';

/**
 * Where a `<tool_call>` starting at `at` whose body is calls ends, just past its
 * `</tool_call>`; {@link Unended} when the text ends inside one; -1 when what is
 * there is not one.
 *
 *     <tool_call>
 *     {"name": "a", "arguments": {…}}
 *     {"name": "b", "arguments": {…}}
 *     </tool_call>
 *
 *     <tool_call>a({…})</tool_call>
 *
 *     <tool_call>
 *     a
 *     {…}
 *     </tool_call>
 *
 * One or more calls, each a JSON object or array, or a name and its JSON object
 * in parens or not, with whitespace between them and nothing else. A turn that
 * offered a tool strips a tag form whatever its body. The single-object form
 * `stripToolSyntax` already strips took out neither, so both calls, arguments
 * included, were stored as the reply's words and sent back to the model; the
 * lazy `<tool_call>[\s\S]*?</tool_call>` it replaced had removed them.
 *
 * EACH CALL IN IT RUNS, as `extractTextualToolCalls` reads it from
 * {@link readTaggedCalls}. They were only stripped: a call the words lost never
 * ran, and a stopped one had no record that it had not gone.
 *
 * READ BY ITS STRUCTURE, as `xmlCallEnd` reads Qwen3-Coder's: prose naming both
 * tags has words between them that are neither a name followed by JSON nor
 * JSON, and keeps every one. A call's JSON is read as its tokens alone (see
 * {@link writesJson}), and one with a closing bracket too few ends at its tag or
 * paren (see {@link shortCallEnd}), so a later brace in the text cannot carry a
 * call across the words after it.
 */
export function taggedCallsEnd(text: string, at: number, offered: readonly string[]): number | Unended {
  return readTaggedCalls(text, at, offered).end;
}

/**
 * {@link taggedCallsEnd}'s reading, with the calls it read: a name before its
 * JSON calls that tool with the JSON as its arguments; bare JSON is a call
 * object, or an array of them, as a tag's single object is read.
 */
function readTaggedCalls(
  text: string,
  at: number,
  offered: readonly string[],
): { end: number | Unended; calls: WrittenCall[] } {
  let pos = at + '<tool_call>'.length;
  let written = 0;
  const calls: WrittenCall[] = [];
  const reading = (end: number | Unended): { end: number | Unended; calls: WrittenCall[] } => ({ end, calls });
  const skipSpace = (): void => {
    while (pos < text.length && /\s/.test(text.charAt(pos))) pos += 1;
  };
  for (;;) {
    skipSpace();
    if (pos === text.length) return reading(written > 0 ? 'open' : -1);
    const rest = text.slice(pos, pos + TAG_END.length).toLowerCase();
    if (rest === TAG_END) return reading(written > 0 ? pos + TAG_END.length : -1);
    if (pos + rest.length === text.length && TAG_END.startsWith(rest)) return reading(written > 0 ? 'open' : -1);

    CALL_NAME.lastIndex = pos;
    const name = CALL_NAME.exec(text)?.[0];
    let paren = false;
    if (name !== undefined) {
      pos += name.length;
      skipSpace();
      paren = text.charAt(pos) === '(';
      if (paren) {
        pos += 1;
        skipSpace();
      }
      // A name the text ends on is as likely a word; with its paren, a call begun.
      if (pos === text.length) return reading(paren ? 'open' : -1);
    }
    // Python's keyword arguments in its parens: see `readKeywordArguments`.
    if (name !== undefined && paren && text.charAt(pos) !== '{') {
      const keywords = readKeywordArguments(text, pos);
      if (typeof keywords.end === 'string' || keywords.end === -1) return reading(keywords.end);
      calls.push({ name, input: keywords.input });
      written += 1;
      pos = keywords.end;
      continue;
    }
    const opener = text.charAt(pos);
    if (opener !== '{' && !(name === undefined && opener === '[')) return reading(-1);
    const read = (json: string): WrittenCall[] =>
      name === undefined ? callsInJson(looseJson(json)) : callWithArguments(name, json);

    const shortened = shortCall(text, pos, paren ? CALL_END.paren.token : CALL_END.tag.token);
    if (shortened) {
      calls.push(...read(shortened.json));
      written += 1;
      if (!paren) return reading(shortened.end);
      pos = shortened.end;
      continue;
    }
    const end = endOfJson(text, pos);
    if (end === -1) {
      const writing = writesJson(text, pos, { tagged: name === undefined, offered });
      return reading(writing === 'in-value' ? writing : writing ? 'open' : -1);
    }
    if (!writesJson(text, pos, { tagged: false, offered, until: end })) return reading(-1);
    const json = text.slice(pos, end);
    pos = end;
    // Stray closing brackets are the call's, as the single-object form reads them.
    while (pos < text.length && /[\s}\]]/.test(text.charAt(pos))) pos += 1;
    if (paren) {
      if (pos === text.length) return reading('open');
      if (text.charAt(pos) !== ')') return reading(-1);
      pos += 1;
    }
    calls.push(...read(json));
    written += 1;
  }
}

/**
 * Where a `[TOOL_CALLS]` call written as Python writes one opens: the marker,
 * its name and `(`, with a word after it. The group is the name. See
 * {@link readKeywordArguments}.
 */
const KEYWORD_CALL_OPENING = /\[TOOL_CALLS?\]\s*([\w.:-]+)\s*\(\s*(?=[A-Za-z_])/gi;
/** A keyword argument's name and its `=`, as Python writes one. */
const KEYWORD = /([A-Za-z_]\w*)\s*=(?!=)\s*/y;

/**
 * Where a call's arguments written as Python writes them, from `start` just
 * inside its `(`, end: just past the `)`; {@link Unended} when the text ends
 * inside them — `'in-value'` inside a string; -1 when what is there is not such
 * arguments. `input` is what they give.
 *
 *     <tool_call>notes.note(text="Call Ana", pinned=True)</tool_call>
 *     [TOOL_CALLS] note(text='Call Ana', tags=['work'])
 *
 * The body `stripToolSyntax` read was JSON alone, so a finished reply kept such
 * a call, arguments and all, and sent it back in every later request; the lazy
 * patterns it replaced had removed it. It is a call, and runs, each value read
 * as a call's JSON is: see {@link looseJson}.
 *
 * NAMED ARGUMENTS ONLY, as every model format that writes a call this way
 * names them. A call written positionally, `note("Call Ana")`, names no
 * parameter its value is for: nothing can run it, and it is left as words.
 * Neither is a word that is no value, so "[TOOL_CALLS] before (not after)" is
 * prose.
 */
function readKeywordArguments(
  text: string,
  start: number,
): { end: number | Unended; input: Record<string, unknown> } {
  const input: Record<string, unknown> = {};
  let pos = start;
  const reading = (end: number | Unended): { end: number | Unended; input: Record<string, unknown> } => ({
    end,
    input,
  });
  const skipSpace = (): void => {
    while (pos < text.length && /\s/.test(text.charAt(pos))) pos += 1;
  };
  for (;;) {
    skipSpace();
    if (pos === text.length) return reading('open');
    if (text.charAt(pos) === ')') return reading(pos + 1);
    KEYWORD.lastIndex = pos;
    const keyword = KEYWORD.exec(text);
    // A name the text ends inside or on is a keyword being written.
    if (!keyword) return reading(/^[A-Za-z_]\w*\s*$/.test(text.slice(pos)) ? 'open' : -1);
    pos += keyword[0].length;
    const end = valueEnd(text, pos);
    if (typeof end === 'string' || end === -1) return reading(end);
    const value = looseJson(text.slice(pos, end));
    if (value === undefined) return reading(-1);
    Object.defineProperty(input, keyword[1] ?? '', { value, enumerable: true, writable: true, configurable: true });
    pos = end;
    skipSpace();
    if (pos === text.length) return reading('open');
    if (text.charAt(pos) === ',') pos += 1;
    else if (text.charAt(pos) !== ')') return reading(-1);
  }
}

/**
 * Where the value a keyword argument gives, from `start`, ends: a string in
 * either quote, a list or dict read past the brackets in its strings, or a bare
 * word. {@link Unended} when the text ends inside it — `'in-value'` inside a
 * string; -1 when it is none of these.
 */
function valueEnd(text: string, start: number): number | Unended {
  let depth = 0;
  let quote = '';
  for (let at = start; at < text.length; at += 1) {
    const char = text.charAt(at);
    if (quote !== '') {
      if (char === '\\') {
        at += 1;
      } else if (char === quote) {
        quote = '';
        if (depth === 0) return at + 1;
      }
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === '{' || char === '[') {
      depth += 1;
    } else if (char === '}' || char === ']') {
      depth -= 1;
      if (depth < 0) return -1;
      if (depth === 0) return at + 1;
    } else if (depth === 0) {
      BARE_WORD.lastIndex = at;
      const word = BARE_WORD.exec(text)?.[0];
      if (word === undefined) return -1;
      return at + word.length === text.length ? 'open' : at + word.length;
    }
  }
  // The text ends inside a string's words, or in a list or dict's structure.
  return quote === '' ? 'open' : 'in-value';
}

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
 * bracket inside a string — and the tag or paren that closes the call. A
 * `<tool_call>` whose body is Qwen3-Coder's XML is stripped only when it is
 * whole, by its structure: see {@link xmlCallEnd}. An unfinished call has no
 * end, and is left for the caller: see `wordsWithoutCalls` in `state/chat.ts`.
 *
 * WHAT IS STRIPPED IS WHAT `extractTextualToolCalls` READS: both take the
 * markup `callMarkup` finds. A call the words lose runs in a finished turn, and
 * is recorded as not sent in a stopped one or past the round limit — unless it
 * names no tool, when there is nothing to run or record.
 *
 * `offered` is what the turn's request offered, as {@link callNames} gives it.
 * A fenced block is stripped only when it names one of those — the call
 * `extractTextualToolCalls` would have read and run — and is an example
 * otherwise. The tag forms are stripped whatever they name.
 *
 * `ran` is whether a tool ran in the turn. A TURN THAT OFFERED NO TOOL AND RAN
 * NONE HAS NOTHING STRIPPED: nothing it wrote can be a call. The tag forms were
 * stripped from every reply, and one explaining how a model formats a call —
 * Qwen's `<tool_call>{"name": "get_weather", …}</tool_call>` in a code block,
 * or "Mistral writes `[TOOL_CALLS] get_weather({…})`" — lost its example. In a
 * turn that offered a tool, or ran one, they are markup whatever their body,
 * malformed ones included.
 */
export function stripToolSyntax(
  text: string,
  { offered, ran }: { readonly offered: readonly string[]; readonly ran: boolean },
): string {
  if (offered.length === 0 && !ran) return text.trim();
  // The markup `extractTextualToolCalls` reads its calls from: see `callMarkup`.
  const spans = callMarkup(text, offered).sort((a, b) => a.start - b.start);
  let out = '';
  let at = 0;
  for (const { start, end } of spans) {
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
 *
 * `offered` and `shown` are REQUIRED, as `enabledIds` is on `runToolCalls`: a
 * reading that left out `offered` took a data record for a call, and one that
 * left out `shown` ran a call again when the model recounted it. `shown` is
 * {@link shownCalls} of the messages the reply answers. `ended` is how the
 * message ended (see {@link TextEnding}), which decides whether reasoning it
 * left open is still reasoning: see {@link extractTextualToolCalls}.
 */
export function findToolCalls(
  message: IRMessage,
  offered: readonly string[],
  shown: readonly ToolUseContent[],
  reading: { readonly ended?: TextEnding } = {},
): ToolUseContent[] {
  return [
    ...structuredToolCalls(message),
    ...extractTextualToolCalls(messageToText(message), offered, shown, reading),
  ];
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
    /*
     * This batch was read from a turn whose stream failed, with nothing to
     * finish it. As past the round limit, nothing in it runs and nobody is
     * asked, and a call with a destination gets a `withheld` receipt, why
     * `reply-failed`: the failed reply's words have their calls read out, and
     * without the record nothing said the model had written a call that did
     * not go.
     */
    replyFailed?: boolean;
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
    // Skipped entirely past the round limit, or after the reply failed:
    // nothing in this batch runs whatever the answer, so nobody is asked (see
    // `roundLimitReached` and `replyFailed`).
    const neverRuns = options.roundLimitReached === true || options.replyFailed === true;
    const { refused, onHeldGrant } = neverRuns
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

    /*
     * AFTER THE REPLY FAILED, every call with a destination is withheld, and
     * nothing runs, as past the round limit: the failure is the reason, and
     * nobody was asked. See `replyFailed`.
     */
    const failedReply = (index: number): Refusal | undefined => {
      const destination = tools[index]?.destination;
      if (!destination || !options.replyFailed) return undefined;
      return {
        output: `This call’s arguments were not sent to ${destination.host}: the reply failed before it went.`,
        why: 'reply-failed',
      };
    };

    for (const [index, call] of calls.entries()) {
      const refusal =
        refused.get(index) ??
        withdrawn(index) ??
        changed(index) ??
        stopped(index) ??
        overLimit(index) ??
        failedReply(index);
      // Nothing runs once the turn is stopped, past the round limit, or
      // failed. A refused call is still written down below, whatever refused
      // it: a refusal sends nothing, and a call the person declined before
      // Stop came is as much not sent as one Stop held back (owner ruling
      // OD7). What is skipped here without a record is only a call with no
      // destination — a tool that runs on this device, or a name the request
      // did not declare — which has no server it was not sent to.
      if ((options.signal?.aborted || neverRuns) && !refusal) continue;

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
      // `messages` is what this response answers: a follow-up's holds the calls
      // earlier rounds made, which a model recounting them copies.
      const calls = findToolCalls(response.message, callNames(declared), shownCalls(messages));
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
    const stripped = stripToolSyntax(messageToText(response.message), { offered: callNames(declared), ran: true });
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
