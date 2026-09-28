/**
 * The shared rig for measuring what leaves the device.
 *
 * Two suites drive it — `privacy.test.ts` for the rule, `privacy-copy.test.ts`
 * for the sentences the app prints about the rule — and they must drive the
 * SAME rig. `layering.test.ts` carries the scar from the alternative: a guard
 * whose form tests asserted against a byte-identical second copy of the thing
 * under test, so weakening the real one left every test green.
 *
 * Everything here records at the `BackendAdapter` boundary, the last app-owned
 * code before a provider SDK. Assertions are about the bytes a backend was
 * handed, never about a flag the engine set about itself.
 */

import { vi } from 'vitest';

import type { BackendAdapter, FinishReason, IRChatRequest, IRStreamChunk } from '@johnhenry/aimatey-types';
import { FunctionBackendAdapter } from '@johnhenry/aimatey-backend-browser';

import type { GenerationEvent } from '@/ai/engine';
import { createMcpTool } from '@/ai/mcp/tools';
import type { ToolDestinationPolicy } from '@/ai/middleware/tools';
import { DEFAULT_SAMPLER } from '@/domain/manifest';
import { catalogEntry } from '@/data/catalog';
import { REACH_REMOTE } from '@/domain/chat';

/** The canary. If it is in a request, conversation bytes left the device. */
export const SECRET = 'PASSPHRASE-ORTHOGONAL-PANGOLIN-7731';

export const probeManifest = catalogEntry('qwen3-4b-instruct-q4km')!;

export const probeResolver = {
  getManifest: (id: string) => (id === probeManifest.id ? probeManifest : null),
  getPath: () => '/dev/model.gguf',
  getSampler: () => ({ ...DEFAULT_SAMPLER, maxTokens: 64 }),
};

/** What a model emits to call the probe tool. */
export const CALL = '<tool_call>{"name":"leaky","arguments":{}}</tool_call>';

/** Stands in for `bash`: returns the user's own data, as the shell would. */
export const leakyTool = {
  id: 'leaky',
  name: 'leaky',
  description: 'Reads this app’s own data.',
  summary: 'probe',
  parameters: { type: 'object' as const, properties: {} },
  execute: async () => ({
    output: `# Therapy notes\n\n## You\n\nmy ${SECRET}\n`,
  }),
};

/* ── The MCP probe (#6) ─────────────────────────────────────────────── */

/** Where the MCP probe's tool sends, as its destination declares it. */
export const PROBE_SERVER = { serverId: 'mcp_probe', url: 'https://notes.example/mcp' } as const;

/** What a model emits to call the MCP probe with the canary in its arguments. */
export const MCP_CALL = `<tool_call>{"name":"notes.note","arguments":{"text":"${SECRET}"}}</tool_call>`;

/** The same call carrying nothing from the conversation. */
export const MCP_CALL_CLEAN =
  '<tool_call>{"name":"notes.note","arguments":{"text":"a shopping list"}}</tool_call>';

/**
 * A real MCP tool whose server is a spy.
 *
 * Built by the shipped `createMcpTool`, so its destination, its receipt and its
 * destructive confirm are the real ones. `call` is where the arguments would
 * reach the network: if it was called, they went.
 */
export function mcpProbe(
  options: { serverName?: string; serverId?: string; serverUrl?: string; readOnly?: boolean } = {},
) {
  const readOnly = options.readOnly ?? true;
  const call = vi.fn(
    async (_server: string, _name: string, _args: Record<string, unknown>, _signal?: AbortSignal) => ({
      content: [{ type: 'text', text: 'filed' }],
    }),
  );
  const confirm = vi.fn(async (_action: string, _signal?: AbortSignal) => true);
  const tool = createMcpTool(
    {
      server: options.serverName ?? 'notes',
      name: 'note',
      description: 'File a note',
      readOnly,
      destructive: !readOnly,
      inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
    },
    {
      serverId: options.serverId ?? PROBE_SERVER.serverId,
      serverUrl: options.serverUrl ?? PROBE_SERVER.url,
      confirm,
      call,
    },
  );
  if (!tool) throw new Error('createMcpTool refused the probe’s schema');
  return { tool, call, confirm };
}

/** A conversation that holds a grant for exactly the probe's server, at the probe's address. */
export const GRANTED_PROBE: ToolDestinationPolicy = {
  isGranted: (destination) =>
    destination.serverId === PROBE_SERVER.serverId && destination.url === PROBE_SERVER.url,
};

export const cloudTarget = {
  backendId: 'cloud',
  engine: 'remote' as const,
  modelId: 'gpt-4o-mini',
  modelName: 'GPT-4o mini',
  reach: REACH_REMOTE,
};

/**
 * A reply as a script for {@link recordingBackend} writes one when its stream
 * ends for a reason of its own, or says how many tokens it spent: a plain
 * string ends as the model ending it, `finishReason: 'stop'`, and says nothing
 * of its tokens.
 */
export interface EndedReply {
  readonly text: string;
  readonly finishReason: FinishReason;
  readonly completionTokens?: number;
}

/** `text` as a reply the backend cut off at its limit on tokens, `finishReason: 'length'`. */
export function cutOff(text: string): EndedReply {
  return { text, finishReason: 'length' };
}

/** A backend that records every request it is handed, then replies to script. */
export function recordingBackend(turns: readonly (string | EndedReply)[]): {
  adapter: BackendAdapter;
  seen: IRChatRequest[];
} {
  const seen: IRChatRequest[] = [];
  let turn = 0;
  const next = (request: IRChatRequest): EndedReply => {
    seen.push(structuredClone(request));
    const scripted = turns[Math.min(turn++, turns.length - 1)] ?? '';
    return typeof scripted === 'string' ? { text: scripted, finishReason: 'stop' } : scripted;
  };

  return {
    seen,
    adapter: new FunctionBackendAdapter({
      execute: async (request) => {
        const { text, finishReason } = next(request);
        return {
          message: { role: 'assistant', content: text },
          finishReason,
          metadata: { requestId: request.metadata.requestId, timestamp: Date.now() },
        };
      },
      executeStream: async function* (request): AsyncGenerator<IRStreamChunk> {
        const { text, finishReason, completionTokens } = next(request);
        yield { type: 'start', sequence: 0, metadata: request.metadata };
        yield { type: 'content', sequence: 1, delta: text };
        yield {
          type: 'done',
          sequence: 2,
          finishReason,
          ...(completionTokens === undefined
            ? {}
            : { usage: { promptTokens: 1, completionTokens, totalTokens: completionTokens + 1 } }),
        };
      },
    }),
  };
}

/** A local backend that answers once with a tool call, then dies. */
export function callsThenFails(): BackendAdapter {
  let turn = 0;
  return new FunctionBackendAdapter({
    execute: async () => {
      throw new Error('not enough memory');
    },
    executeStream: async function* (request): AsyncGenerator<IRStreamChunk> {
      if (turn++ > 0) throw new Error('not enough memory');
      yield { type: 'start', sequence: 0, metadata: request.metadata };
      yield { type: 'content', sequence: 1, delta: CALL };
      yield { type: 'done', sequence: 2, finishReason: 'stop' };
    },
  });
}

export async function drainEvents(
  stream: AsyncGenerator<GenerationEvent>,
): Promise<GenerationEvent[]> {
  const events: GenerationEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

/** The bytes each recorded request actually carried. */
export function sent(requests: readonly IRChatRequest[]): string[] {
  return requests.map((request) => JSON.stringify(request.messages));
}

/** A sheet that answers the same way every time and counts how often it ran. */
export function sheet(answer: 'deny' | 'turn' | 'conversation') {
  return vi.fn(async () => answer);
}
