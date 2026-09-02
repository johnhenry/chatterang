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

import type { BackendAdapter, IRChatRequest, IRStreamChunk } from '@johnhenry/aimatey-types';
import { FunctionBackendAdapter } from '@johnhenry/aimatey-backend-browser';

import type { GenerationEvent } from '@/ai/engine';
import { DEFAULT_SAMPLER } from '@/domain/manifest';
import { catalogEntry } from '@/data/catalog';

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

export const cloudTarget = {
  backendId: 'cloud',
  engine: 'remote' as const,
  modelId: 'gpt-4o-mini',
  modelName: 'GPT-4o mini',
  local: false,
};

/** A backend that records every request it is handed, then replies to script. */
export function recordingBackend(turns: string[]): {
  adapter: BackendAdapter;
  seen: IRChatRequest[];
} {
  const seen: IRChatRequest[] = [];
  let turn = 0;
  const next = (request: IRChatRequest): string => {
    seen.push(structuredClone(request));
    return turns[Math.min(turn++, turns.length - 1)] ?? '';
  };

  return {
    seen,
    adapter: new FunctionBackendAdapter({
      execute: async (request) => ({
        message: { role: 'assistant', content: next(request) },
        finishReason: 'stop',
        metadata: { requestId: request.metadata.requestId, timestamp: Date.now() },
      }),
      executeStream: async function* (request): AsyncGenerator<IRStreamChunk> {
        const text = next(request);
        yield { type: 'start', sequence: 0, metadata: request.metadata };
        yield { type: 'content', sequence: 1, delta: text };
        yield { type: 'done', sequence: 2, finishReason: 'stop' };
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
