/**
 * Remote MCP servers.
 *
 * The whole point of this app is that inference happens on the device. An MCP
 * tool is the one thing here that deliberately breaks that: calling it sends
 * arguments — which the model derived from the conversation — to someone else's
 * server over the network.
 *
 * That is a legitimate thing to want, and it is also the sharpest edge in the
 * product. So the domain model carries the destination everywhere it goes, and
 * nothing about an MCP tool is allowed to look like a local one.
 *
 * Remote-only, over Streamable HTTP. There is no stdio transport here and there
 * should not be: stdio means spawning a local process, which a browser cannot
 * do and a mobile webview should not.
 */

export interface McpServerConfig {
  readonly id: string;
  /** Short handle used to namespace tool names: `github.create_issue`. */
  readonly name: string;
  readonly url: string;
  readonly enabled: boolean;
  /** Sent as `Authorization`. Never rendered, never mounted into the shell VFS. */
  readonly token?: string;
  readonly createdAt: number;
}

export type McpServerStatus = 'idle' | 'connecting' | 'ready' | 'error';

export interface McpServerState {
  readonly id: string;
  readonly status: McpServerStatus;
  readonly toolCount: number;
  readonly error?: string;
}

/** `https:` only, and never a credential in the URL. */
export function validateServerUrl(raw: string): { ok: true; url: string } | { ok: false; reason: string } {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { ok: false, reason: 'That is not a valid URL.' };
  }
  if (parsed.protocol !== 'https:' && parsed.hostname !== 'localhost' && parsed.hostname !== '127.0.0.1') {
    return { ok: false, reason: 'Only https: is allowed, or localhost for development.' };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, reason: 'Put credentials in the token field, not the URL.' };
  }
  return { ok: true, url: parsed.toString() };
}

/** The host a tool call would reach, for display. Never the full URL — a path can be long and is not the point. */
export function destinationHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'unknown host';
  }
}

/** Server-qualified tool id, so two servers can both expose `search`. */
export function qualifiedToolName(serverName: string, toolName: string): string {
  return `${serverName}.${toolName}`;
}

/**
 * The size of a call's arguments: their UTF-8 length as JSON, the part the
 * model composed. One function for the sheet that asks and the receipt that
 * records, so the number a person allowed and the number written down after
 * are the same number.
 */
export function argumentBytes(input: Record<string, unknown>): number {
  return new TextEncoder().encode(JSON.stringify(input)).length;
}

/**
 * A call's arguments as JSON, cut short for a sheet. Cut by code point, so a
 * truncation never splits a character in half.
 */
export function argumentPreview(input: Record<string, unknown>, limit = 120): string {
  const points = Array.from(JSON.stringify(input));
  return points.length <= limit ? points.join('') : `${points.slice(0, limit - 1).join('')}…`;
}

/**
 * Where a tool sends its arguments, carried on the tool itself.
 *
 * COPIED IN, as `PairedDevice` in domain/chat.ts is: the name and host are what
 * they were when the tool was registered. `serverId` is the part a name cannot
 * give. A server removed and re-added under the same name is a different server
 * with a different id, and the tool's own id (`mcp:<name>.<tool>`) cannot tell
 * the two apart.
 */
export interface ToolDestination {
  readonly kind: 'mcp';
  readonly serverId: string;
  readonly serverName: string;
  readonly host: string;
  readonly url: string;
}

/**
 * The record of what became of a tool call's arguments bound for an MCP server
 * (#92).
 *
 * `sent` and `failed` are taken when the call is handed over, not when it
 * returns, so `at` is when the arguments left and a call that then failed still
 * has one. `withheld` records what did NOT go, so the thread and the export can
 * say so, and no reader may count it as egress — see {@link mayHaveLeft}. Owner
 * ruling OD7 covers every way a call is held back, and `why` says which
 * ({@link WithheldWhy}).
 *
 * `outcome` is a discriminant rather than optional flags so that every reader
 * has to say what it does with each value, and `why` exists only on the outcome
 * it explains, for the same reason.
 *
 * `bytes` is the UTF-8 length of the arguments as JSON — the part the model
 * composed — not the size of the request envelope around them; for a withheld
 * call, the size of what would have gone. There is no hash: the arguments
 * themselves are stored beside this, on the invocation.
 */
export type McpCallReceipt =
  | (McpCallFields & { readonly outcome: 'sent' | 'failed' })
  | (McpCallFields & { readonly outcome: 'withheld'; readonly why: WithheldWhy });

/** What every receipt records, whatever became of the call. */
export interface McpCallFields {
  readonly serverId: string;
  readonly serverName: string;
  readonly host: string;
  /** Server-qualified (`notes.search`), whichever spelling the model called it by. */
  readonly toolName: string;
  readonly bytes: number;
  /**
   * Epoch milliseconds: when the arguments were handed to the server, or were
   * withheld. For a call Stop held back, that is when Stop landed — or, stopped
   * before its batch was dispatched, when the batch was.
   */
  readonly at: number;
}

/**
 * Why a call's arguments were withheld (#92, owner ruling OD7).
 *
 * - `not-allowed`: this conversation did not allow the server — the person
 *   said no to the send sheet.
 * - `unattended`: the server was not allowed, and nobody could be asked — the
 *   caller that ran this turn passed no `request` hook (#199, #293). Distinct
 *   from `not-allowed` because "a person said no" and "there was no person to
 *   ask" are different facts, and only the first is a decision anyone made.
 *   Latent until an unattended caller exists to reach it.
 * - `declined`: the server was allowed, and the person said no when asked about
 *   a call the server does not call read-only changing data there.
 * - `server-changed`: nobody refused it. The server record it was prepared for
 *   was removed, switched off, renamed or pointed elsewhere while it waited, or
 *   no client was left to send it ({@link McpNotSent}); or the conversation's
 *   grant for it was withdrawn while an earlier call ran; or its tool had left
 *   the registry by the time it was dispatched, because a server was removed,
 *   switched off or added while the model was still writing the call.
 * - `stopped`: the reply was stopped before the call went, and nothing else
 *   held it back. Nothing leaves after Stop, so this is every such call in the
 *   batch: one waiting on a person, at the send sheet or the data-change
 *   confirm, whatever was answered after; one whose own send sheet was never
 *   raised, because Stop came at an earlier sheet or before the batch was
 *   dispatched; one already allowed — by a grant the conversation held or an
 *   answer given in this batch — that had not yet run when Stop came, at
 *   another server's sheet or while an earlier call ran; and one already
 *   complete in text the model was still streaming when Stop landed — read
 *   after the fact, from the partial text the abort left behind, the same way
 *   a finished turn's text is read (#293).
 * - `round-limit`: the call was read from a model turn's finished text, but
 *   that turn came after the turn's limit on tool rounds (`TOOL_ITERATIONS`),
 *   so it was never dispatched (#293). `stripToolSyntax` still removes it from
 *   the displayed text; this is the record that says why nothing happened.
 * - `reply-failed`: the call was complete in the text of a model turn whose
 *   stream then failed, with no fallback to finish the turn, so it was never
 *   dispatched. The failed reply's stored words have their calls read out, as
 *   a finished reply's are, and without this record nothing said the model
 *   had written a call that did not go.
 *
 * A call here is one whose text was complete enough for {@link findToolCalls}
 * or its textual forms to read it as a call — whether that text came from a
 * turn that finished normally, one cut short by Stop, one run past the round
 * limit, or one whose stream failed. Text that never became a complete call —
 * an argument still streaming when Stop landed — was never read as a call at
 * all: it was not sent, and it has no record, because there is nothing named
 * yet to record.
 *
 * Each reads differently in the thread and the export, because each is a
 * different thing to have happened.
 */
export type WithheldWhy =
  | 'not-allowed'
  | 'unattended'
  | 'declined'
  | 'server-changed'
  | 'stopped'
  | 'round-limit'
  | 'reply-failed';

/**
 * Could this call's arguments have reached the server?
 *
 * The question a record of egress is kept for. `failed` answers yes, because a
 * call can fail after its arguments arrived; `withheld` answers no, whatever
 * held the call back. An outcome this build has never heard of — a row written
 * by a later one — falls to the `never` branch and answers true: kept as if
 * something left, the direction it is safe to be wrong in.
 */
export function mayHaveLeft(receipt: McpCallReceipt | undefined): boolean {
  if (receipt === undefined) return false;
  switch (receipt.outcome) {
    case 'sent':
    case 'failed':
      return true;
    case 'withheld':
      return false;
    default:
      unhandledOutcome(receipt);
      return true;
  }
}

/**
 * The outcome of a receipt no branch of a reader handles: a row written by a
 * later build.
 *
 * Called from a switch's `default`. Its parameter is `never`, so that switch
 * stops compiling the moment an outcome is added and left unhandled; at
 * runtime it hands back what was stored, for the reader to show. The receipt
 * is passed rather than its `outcome`, because once every member of the union
 * is handled the receipt itself is `never` and has no `outcome` to read.
 */
export function unhandledOutcome(receipt: never): string {
  return String((receipt as { readonly outcome?: unknown }).outcome);
}

/**
 * The same for a withheld receipt's `why`: a reason a later build added. The
 * reader still knows the call was not sent, and shows the reason as stored
 * rather than guessing what it meant.
 */
export function unhandledWhy(why: never): string {
  return String(why);
}

/**
 * A refusal made BEFORE any byte left: there is no client, or the server a call
 * was prepared for is no longer the server its name points at.
 *
 * Distinct from every other failure because it is the one recorded as not sent
 * (`withheld`, why `server-changed`) rather than as an attempt. Any other error
 * may arrive after the arguments were delivered, and recording such a call as
 * not sent would be wrong in the flattering direction.
 */
export class McpNotSent extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'McpNotSent';
  }
}
