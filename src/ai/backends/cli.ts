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
 * FROM `src/ai/prompt.ts`. `fromIR` calls `encodeCliTurnInput`
 * (`cli-encode.ts`, beside `cli-stream.ts`) — role-tagged message OBJECTS
 * for `claude`, a clearly-labelled transcript for `codex`/`gemini` — never
 * `renderPrompt`'s output, which is prompt TEXT built for a chat-model
 * template neither of these CLIs uses. `encodeCliTurnInput` is also where
 * `sanitiseMessages` runs, so tainted content is encoded through the SAME
 * gate the local prompt renderer uses, not a second one this file invented.
 * See that file's header for why.
 *
 * THE ONE THING THIS FILE ADDS TO ARGV, AND WHY IT IS NOT #119's MESSAGE
 * CONTENT. `encodeCliTurnInput` may return a `systemPrompt` — this app's OWN
 * persona/system text, pulled out because `claude` accepts it as a separate
 * flag value rather than a stdin frame. It crosses to `CliTurnBridge.start`
 * as its OWN named field, never folded into a generic argv array: the
 * far side (once wired) is the only place that turns it into
 * `['--append-system-prompt', value]`, as two separate argv elements, so a
 * persona string that happens to start with `--` is a flag'S VALUE and
 * never a second flag — proved in `tests/desktop-cli-turn-argv.test.ts`.
 *
 * THE TAINT/CLEARING GATE STAYS UPSTREAM OF THIS FILE, TWICE OVER. The
 * engine calls `clearForDestination` before any adapter sees a message
 * (#141, #145) — this file does not re-decide that — and `encodeCliTurnInput`
 * calls `sanitiseMessages` before any text reaches a CLI's stdin. Neither
 * gate is this file's to keep or to weaken; it only calls the second one.
 */

import type {
  AdapterMetadata,
  BackendAdapter,
  IRChatRequest,
  IRChatResponse,
  IRChatStream,
  IRStreamChunk,
  IRUsage,
} from '@johnhenry/aimatey-types';

import { encodeCliTurnInput, type CliTurnInput } from './cli-encode';
import {
  CliLineOverflowError,
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

/**
 * The one call this file needs from the far side: start a turn with the
 * already-encoded input, get a handle back.
 *
 * `stdin` and `systemPrompt` — never `messages` — is deliberate: this shape
 * cannot carry a free-form argv (there is no field for one), and
 * `systemPrompt` is typed as one opaque string, not an array a caller could
 * pad with extra flags. What the far side does with `systemPrompt` is that
 * side's decision (`apps/desktop/src/bridge/cli-specs.ts`'s
 * `buildCliTurnArgv`); this file hands over text, never argv.
 */
export interface CliTurnBridge {
  start(options: { readonly cliId: string } & CliTurnInput): CliBridgeHandle;
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

  /**
   * #119: structured turns, never a concatenated prompt string. Delegates
   * entirely to `encodeCliTurnInput` — this method exists to satisfy
   * `BackendAdapter`'s shape, not to do any of the encoding itself.
   */
  fromIR(request: IRChatRequest): CliTurnInput {
    return encodeCliTurnInput(this.#cliId, request.messages);
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
    const input = this.fromIR(request);
    const cliId = this.#cliId;
    const bridge = this.#bridge;
    const requestId = `cli_${cliId}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    async function* generate(): IRChatStream {
      const translator = createTranslatorFor(cliId, requestId);
      const splitter = createCliLineSplitter();
      const queue: IRStreamChunk[] = [];
      let ended = false;
      let wake: (() => void) | undefined;
      // Mirrors the translator's own sequence counter, which this file
      // never sees directly: every chunk the translator has ever emitted
      // (push or finish) advances this by exactly one, so it is always the
      // next number the translator's own counter would use (#120).
      let emittedCount = 0;
      const emit = (chunks: readonly IRStreamChunk[]): void => {
        queue.push(...chunks);
        emittedCount += chunks.length;
      };

      const handle = bridge.start({ cliId, ...input });

      handle.onData((chunk, stream) => {
        if (stream !== 'stdout' || ended) return;
        try {
          for (const line of splitter.push(chunk)) emit(translator.push(line));
        } catch (error) {
          if (!(error instanceof CliLineOverflowError)) throw error;
          // One error terminal, same as any other translator-level failure
          // -- and the process is still running, unlike a translator.finish()
          // case, so it has to be told to stop rather than merely reported on.
          ended = true;
          emit([
            {
              type: 'error',
              sequence: emittedCount,
              error: { code: 'cli_line_overflow', message: error.message },
            },
          ]);
          handle.cancel();
        }
        wake?.();
      });
      handle.onExit((exit) => {
        if (ended) return;
        for (const line of splitter.flush()) emit(translator.push(line));
        emit(translator.finish(exit));
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
