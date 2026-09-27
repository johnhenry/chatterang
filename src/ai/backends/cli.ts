/**
 * THE RENDERER-SIDE CLI BACKEND ADAPTER (#42, #115, #119).
 *
 * This is the sibling `tunnel.ts`'s own header describes: the phone's/page's
 * end of a turn that runs somewhere else, adapted to the same
 * `BackendAdapter` shape the engine and its tool loop already treat every
 * backend as. What is particular to a local CLI lives here.
 *
 * WHY THIS NEVER IMPORTS `@chatterang/desktop`. Exactly `src/peer-turn-worker.ts`'s
 * reason: `tests/layering.test.ts`'s shell-app guard bans that specifier from
 * `src/` outright, by name, static or dynamic, so the mobile/web bundle can
 * never resolve Electron or `node:child_process` through this file. The
 * desktop's spawn plugin (`apps/desktop/src/bridge/cli-turns.ts`) is on the
 * OTHER side of a `contextBridge` boundary this pass does not wire yet (see
 * that file's own "why this is not yet a PluginHost plugin" note) — what
 * would cross it is a `CliTurnBridge`, a small, LOCALLY-DECLARED interface
 * (never imported from the desktop package) that a future preload script
 * would implement and expose on `window`, the same way
 * `src/peer-turn-worker.ts` reads `window.__peerTurn`.
 *
 * STRUCTURED INPUT (#119), THE WHOLE POINT OF THIS FILE EXISTING SEPARATELY
 * FROM `src/ai/prompt.ts`. `fromIR` hands the CLI the IR's OWN message
 * objects, unmodified — never `renderPrompt`'s output, which is prompt TEXT
 * built for a template the CLI does not use and would not accept. A CLI
 * builds its own system prompt and its own turn structure; concatenating
 * this app's messages into one string before handing them over would be
 * exactly the mistake #119 exists to name and refuse.
 *
 * THE TAINT/CLEARING GATE STAYS UPSTREAM OF THIS FILE. `executeStream` takes
 * whatever `IRChatRequest.messages` the engine gives it — the engine is what
 * calls `clearForDestination` before it ever reaches an adapter (#141, #145),
 * and this file does not re-decide that; it is not this file's gate to keep
 * or to weaken.
 */

import type {
  AdapterMetadata,
  BackendAdapter,
  IRChatRequest,
  IRChatResponse,
  IRChatStream,
  IRMessage,
  IRStreamChunk,
  IRUsage,
} from '@johnhenry/aimatey-types';

import {
  createCliLineSplitter,
  createClaudeTranslator,
  createCodexTranslator,
  type CliStreamTranslator,
} from './cli-stream';

/** How a process ended, mirroring the desktop spawn plugin's `CliTurnExit` shape without importing it. */
export interface CliBridgeExit {
  readonly code: number | null;
  readonly signal: string | null;
}

/**
 * What one running turn looks like from this side of the boundary. A future
 * preload implements this over the real spawn plugin; tests implement it
 * over a fake that never spawns anything.
 */
export interface CliBridgeHandle {
  onData(listener: (chunk: Uint8Array, stream: 'stdout' | 'stderr') => void): void;
  onExit(listener: (exit: CliBridgeExit) => void): void;
  cancel(): void;
}

/** The one call this file needs from the far side: start a turn with structured messages, get a handle back. */
export interface CliTurnBridge {
  start(options: { readonly cliId: string; readonly messages: readonly IRMessage[] }): CliBridgeHandle;
}

/** Every CLI this build has a stream translator for (#115). `gemini` is not here yet — see `cli-stream.ts`'s closing note. */
const SUPPORTED_CLI_IDS = ['claude', 'codex'] as const;
export type SupportedCliId = (typeof SUPPORTED_CLI_IDS)[number];

export function isSupportedCliId(id: string): id is SupportedCliId {
  return (SUPPORTED_CLI_IDS as readonly string[]).includes(id);
}

function createTranslatorFor(cliId: SupportedCliId, requestId: string): CliStreamTranslator {
  return cliId === 'claude' ? createClaudeTranslator(requestId) : createCodexTranslator(requestId);
}

/**
 * A `BackendAdapter` over one local agent CLI, driven entirely by an
 * injected {@link CliTurnBridge} — this class spawns nothing itself.
 */
export class CliBackendAdapter implements BackendAdapter {
  readonly metadata: AdapterMetadata;
  readonly #cliId: SupportedCliId;
  readonly #bridge: CliTurnBridge;

  constructor(cliId: SupportedCliId, bridge: CliTurnBridge) {
    this.#cliId = cliId;
    this.#bridge = bridge;
    this.metadata = {
      name: `cli:${cliId}`,
      version: '0.0.0',
      provider: cliId,
      capabilities: {
        streaming: true,
        multiModal: false,
        tools: false,
        // A CLI builds its own system prompt out of its own conversation
        // structure -- it is not this app's IR->messages mapping to declare
        // a strategy for, so the least presumptuous truthful answer is given
        // here rather than a copied cloud-provider default.
        systemMessageStrategy: 'in-messages',
        supportsMultipleSystemMessages: false,
      },
    };
  }

  /** #119: the request's own message objects, unmodified — never a concatenated prompt string. */
  fromIR(request: IRChatRequest): { readonly messages: readonly IRMessage[] } {
    return { messages: request.messages };
  }

  toIR(
    response: { readonly text: string; readonly usage?: IRUsage },
    _originalRequest: IRChatRequest,
    _latencyMs: number,
  ): IRChatResponse {
    return {
      message: { role: 'assistant', content: response.text },
      finishReason: 'stop',
      usage: response.usage,
      metadata: { requestId: `cli_${this.#cliId}_${Date.now()}`, timestamp: Date.now() },
    };
  }

  async execute(request: IRChatRequest, signal?: AbortSignal): Promise<IRChatResponse> {
    const start = Date.now();
    let text = '';
    let usage: IRUsage | undefined;
    for await (const chunk of this.executeStream(request, signal)) {
      if (chunk.type === 'content') text += chunk.delta;
      else if (chunk.type === 'done') usage = chunk.usage;
      else if (chunk.type === 'error') throw new Error(chunk.error.message);
    }
    return this.toIR({ text, usage }, request, Date.now() - start);
  }

  executeStream(request: IRChatRequest, signal?: AbortSignal): IRChatStream {
    const { messages } = this.fromIR(request);
    const cliId = this.#cliId;
    const bridge = this.#bridge;
    const requestId = `cli_${cliId}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    async function* generate(): IRChatStream {
      const translator = createTranslatorFor(cliId, requestId);
      const splitter = createCliLineSplitter();
      const queue: IRStreamChunk[] = [];
      let ended = false;
      let wake: (() => void) | undefined;

      const handle = bridge.start({ cliId, messages });

      handle.onData((chunk, stream) => {
        if (stream !== 'stdout') return;
        for (const line of splitter.push(chunk)) queue.push(...translator.push(line));
        wake?.();
      });
      handle.onExit((exit) => {
        for (const line of splitter.flush()) queue.push(...translator.push(line));
        queue.push(...translator.finish(exit));
        ended = true;
        wake?.();
      });

      const onAbort = (): void => handle.cancel();
      signal?.addEventListener('abort', onAbort);

      try {
        for (;;) {
          if (queue.length > 0) {
            // Non-null: the length check above is the guard.
            const chunk = queue.shift() as IRStreamChunk;
            yield chunk;
            if (chunk.type === 'done' || chunk.type === 'error') return;
            continue;
          }
          if (ended) return;
          await new Promise<void>((resolveWake) => {
            wake = resolveWake;
          });
        }
      } finally {
        signal?.removeEventListener('abort', onAbort);
      }
    }

    return generate();
  }
}
