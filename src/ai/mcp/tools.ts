/**
 * Wrapping remote MCP tools as local ones.
 *
 * This is the one place in the app where a model action deliberately leaves the
 * device, so the rules here are stricter than the library's defaults and than
 * the annotations a server volunteers.
 *
 * Three invariants, in order of how much they matter:
 *
 * 1. **Every MCP tool is `sensitive`.** Not just the destructive ones. A
 *    "read-only" remote tool still transmits its arguments — which the model
 *    derived from the conversation — to a third party. Read-only describes
 *    what happens to the *server's* state, not to your data. In an app whose
 *    premise is that inference stays local, that distinction is the whole
 *    point, so `sensitive` is unconditional, every call waits on a grant for
 *    its server before it is dispatched (`runToolCalls`, #6), and the
 *    annotations only decide whether a call *additionally* asks about
 *    changing data there.
 *
 * 2. **The destination host is in the description the model sees and in the
 *    summary the user sees.** A tool called `search` tells you nothing. A tool
 *    called `acme.search` that says "sends arguments to api.acme.com" tells you
 *    what you are agreeing to.
 *
 * 3. **Annotations are hints from the least trustworthy party.** A server
 *    declaring `readOnlyHint: true` is asserting something about itself. Absent
 *    or false is treated as destructive; only an explicit `true` earns the
 *    quieter path, and even then the tool stays `sensitive`.
 */

import type { JSONSchema } from '@johnhenry/aimatey-types';

import {
  McpNotSent,
  argumentBytes,
  destinationHost,
  qualifiedToolName,
  type McpCallFields,
  type McpCallReceipt,
  type ToolDestination,
} from '@/domain/mcp';
import { checkToolSchema } from '@/ai/mcp/schema';
import { unlessStopped } from '@/ai/middleware/tools';
import type { ChatterangTool, ToolResult } from '@/ai/tools/registry';
import type { McpToolDescriptor } from '@/ai/mcp/client';

export interface McpToolOptions {
  /** The server record's id: the one thing that tells two same-name servers apart. */
  readonly serverId: string;
  /** The server's URL, for showing where a call goes. */
  readonly serverUrl: string;
  /**
   * Shown to the user before a destructive call runs. `signal` is the turn's:
   * Stop takes the sheet down, and the call does not go.
   */
  confirm(action: string, signal?: AbortSignal): Promise<boolean>;
  call(
    server: string,
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown>;
}

/**
 * Wrap a remote MCP tool, or refuse to.
 *
 * `null` means the server's `inputSchema` did not survive
 * {@link checkToolSchema} — too deep, too large, cyclic, or carrying a key
 * that is dangerous for a downstream decoder to walk. The tool is then not
 * offered at all rather than offered with a trimmed schema, because a model
 * calling a tool against a schema its server did not write is worse than a
 * tool that is missing. See `src/ai/mcp/schema.ts`.
 */
export function createMcpTool(
  descriptor: McpToolDescriptor,
  options: McpToolOptions,
): ChatterangTool | null {
  const host = destinationHost(options.serverUrl);
  const qualified = qualifiedToolName(descriptor.server, descriptor.name);

  const check = checkToolSchema(descriptor.inputSchema);
  if (!check.ok) {
    console.warn(
      `[mcp] refusing tool ${qualified} from ${host}: its inputSchema is ${check.reason}` +
        (check.at ? ` at ${check.at}` : ''),
    );
    return null;
  }

  const destination: ToolDestination = {
    kind: 'mcp',
    serverId: options.serverId,
    serverName: descriptor.server,
    host,
    url: options.serverUrl,
  };

  return {
    id: `mcp:${qualified}`,
    name: qualified,
    summary: `${descriptor.description || descriptor.name} — sends data to ${host}`,
    // Unconditional. See invariant 1 above.
    sensitive: true,
    // Unconditional too: a tool that leaves the device says where, by server
    // id, so what checks or records a call never has to trust a name.
    destination,
    description: [
      descriptor.description || `The ${descriptor.name} tool on ${descriptor.server}.`,
      '',
      `This tool runs on a remote server (${host}), not on this device.`,
      'Its arguments leave the device when it is called.',
      descriptor.readOnly
        ? 'The server describes it as read-only.'
        : 'The server does not describe it as read-only, so it may change data.',
    ].join('\n'),
    parameters: descriptor.inputSchema as JSONSchema, // checked above, not asserted

    async execute(input, context): Promise<ToolResult> {
      // TWO QUESTIONS, AND THIS IS THE SECOND. Whether these arguments may
      // leave for this server was asked before this ran, at dispatch — that is
      // where a grant can see the conversation (`runToolCalls`). What is asked
      // here is whether a call the server does not declare read-only may
      // change data there. They are different harms, so a grant for the whole
      // conversation never answers this one (#6); a read-only call asks
      // nothing more here.
      const bytes = argumentBytes(input);
      const fields = (at: number): McpCallFields => ({
        serverId: options.serverId,
        serverName: descriptor.server,
        host,
        toolName: qualified,
        bytes,
        at,
      });

      if (!descriptor.readOnly) {
        const action = `run “${descriptor.name}” on ${host}, which may change data there`;
        const approved = context.signal?.aborted
          ? undefined
          : await unlessStopped(options.confirm(action, context.signal), context.signal);
        // STOPPED WHILE ASKING (#92). The owner's ruling is that nothing leaves
        // after Stop; it names the send sheet, and this is the other sheet a
        // call waits on, so it is held to the same. Read off the signal, not
        // the answer: a yes that lands with or after Stop does not send.
        if (context.signal?.aborted) {
          return {
            output: `${qualified} was not sent: the reply was stopped.`,
            isError: true,
            receipt: { ...fields(context.now().getTime()), outcome: 'withheld', why: 'stopped' },
          };
        }
        if (!approved) {
          // RECORDED AS NOT SENT (#92, owner ruling OD7). Saying no to the
          // data-change question declines the call as surely as a no to the
          // send sheet does, and the record says which of the two it was.
          return {
            output: 'The user declined that tool call.',
            isError: true,
            receipt: { ...fields(context.now().getTime()), outcome: 'withheld', why: 'declined' },
          };
        }
      }

      // THE SENT RECEIPT IS TAKEN HERE: after the confirm, so `at` is not when
      // the question was first asked, and before the hand-off, so `at` is when
      // the arguments left and a call that then throws still has one. `now` is
      // read once; the catch below must not read it again.
      const at = context.now().getTime();
      const receipt = (outcome: 'sent' | 'failed'): McpCallReceipt => ({ ...fields(at), outcome });

      try {
        const result = await options.call(
          descriptor.server,
          descriptor.name,
          input,
          context.signal,
        );
        return { ...renderResult(result), receipt: receipt('sent') };
      } catch (error) {
        // REFUSED BEFORE ANYTHING LEFT (#92, owner ruling OD7): the server this
        // call was prepared for changed while it waited, or no client is left to
        // send it. Recorded as not sent, and as nobody's refusal.
        if (error instanceof McpNotSent) {
          return {
            output: `${qualified} was not sent: ${error.message}`,
            isError: true,
            receipt: { ...fields(at), outcome: 'withheld', why: 'server-changed' },
          };
        }
        // Anything else may have failed after the arguments were delivered — a
        // server error, a connection dropped mid-response. It is recorded as an
        // attempt, which is the direction it is safe to be wrong in.
        return {
          output: `${qualified} failed: ${error instanceof Error ? error.message : String(error)}`,
          isError: true,
          receipt: receipt('failed'),
        };
      }
    },
  };
}

/**
 * MCP results are a content-block array. Flatten the text for the model and
 * keep the structured form for the UI when there is one.
 */
export function renderResult(result: unknown): ToolResult {
  const record = result as { content?: unknown; isError?: boolean; structuredContent?: unknown };
  const blocks = Array.isArray(record?.content) ? record.content : [];

  const text = blocks
    .map((block: unknown) => {
      const b = block as { type?: string; text?: string };
      if (b?.type === 'text' && typeof b.text === 'string') return b.text;
      // Images and audio are described rather than inlined: dropping a base64
      // blob into the transcript would bloat IndexedDB for no reading benefit.
      if (b?.type) return `[${b.type} content]`;
      return '';
    })
    .filter(Boolean)
    .join('\n');

  if (record?.structuredContent !== undefined) {
    return {
      output: text || JSON.stringify(record.structuredContent),
      display: { kind: 'json', value: JSON.stringify(record.structuredContent, null, 2) },
      isError: record.isError === true,
    };
  }

  return {
    output: text || 'The tool returned no content.',
    isError: record?.isError === true,
  };
}
