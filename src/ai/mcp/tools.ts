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
 *    point, so `sensitive` is unconditional and the annotations only decide
 *    whether a call *additionally* needs per-call approval.
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

import { destinationHost, qualifiedToolName } from '@/domain/mcp';
import { checkToolSchema } from '@/ai/mcp/schema';
import type { ChatterangTool, ToolResult } from '@/ai/tools/registry';
import type { McpToolDescriptor } from '@/ai/mcp/client';

export interface McpToolOptions {
  /** The server's URL, for showing where a call goes. */
  readonly serverUrl: string;
  /** Shown to the user before a destructive call runs. */
  confirm(action: string): Promise<boolean>;
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

  return {
    id: `mcp:${qualified}`,
    name: qualified,
    summary: `${descriptor.description || descriptor.name} — sends data to ${host}`,
    // Unconditional. See invariant 1 above.
    sensitive: true,
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
      // Only destructive calls interrupt. A read-only remote call is still
      // off-device, which is why the tool is sensitive and had to be enabled
      // for this chat — that is the consent boundary. Prompting again per call
      // would train the user to dismiss the sheet without reading it, which is
      // worse than not prompting.
      if (!descriptor.readOnly) {
        const approved = await options.confirm(
          `run “${descriptor.name}” on ${host}, which may change data there`,
        );
        if (!approved) {
          return { output: 'The user declined that tool call.', isError: true };
        }
      }

      try {
        const result = await options.call(
          descriptor.server,
          descriptor.name,
          input,
          context.signal,
        );
        return renderResult(result);
      } catch (error) {
        return {
          output: `${qualified} failed: ${error instanceof Error ? error.message : String(error)}`,
          isError: true,
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
