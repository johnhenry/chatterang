/**
 * llama.cpp as an aimatey backend, IN the inference process.
 *
 * This is the one thing A5 has to write twice, and it is worth saying why
 * rather than letting the duplication look accidental.
 * `src/ai/backends/llama-cpp.ts` is the same adapter for the renderer — but it
 * talks to llama.cpp through the Capacitor plugin proxy, across two process
 * boundaries. Here we are already inside the process that owns the model, so
 * the adapter calls `LlamaCppNode` directly and there is no proxy to reuse.
 *
 * What is NOT duplicated: prompt rendering. `renderPrompt`, `inferTemplate` and
 * `templateStopSequences` are imported from `src/ai/prompt.ts`, which is pure
 * (its only imports are types) and is the reason a conversation produces
 * byte-identical prompt text on every engine. Copying it here would make the
 * desktop path silently disagree with the mobile one, which is exactly the
 * confound that module exists to remove. The import direction is
 * `apps/desktop -> src`, which is the allowed one; `tests/layering.test.ts`
 * forbids the reverse.
 *
 * SCOPE, stated rather than hidden: this adapter resolves a model id as an
 * absolute GGUF path. The renderer owns the model catalogue and the download
 * manager; the inference host has no view of either, and inventing a second
 * catalogue for A5 would be a bigger commitment than the milestone needs. A
 * DSH caller therefore names a file. That is a real limitation, not an
 * oversight.
 */

import type {
  AdapterMetadata,
  BackendAdapter,
  IRChatRequest,
  IRChatResponse,
  IRChatStream,
} from '@johnhenry/aimatey-types';

import type { GenerateResult, LlamaCppPlugin, TokenEvent } from '@chatterang/contracts';

import type { PromptTemplate } from '@/domain/manifest';
import { inferTemplate, renderPrompt, templateStopSequences } from '@/ai/prompt';

export interface DesktopLlamaBackendOptions {
  /** The in-process plugin. `LlamaCppNode` in production. */
  readonly plugin: LlamaCppPlugin;
  /** Model id -> absolute GGUF path. Defaults to treating the id as the path. */
  readonly resolvePath?: (modelId: string) => string;
  /** Chat template for a model id. Defaults to inference from the id. */
  readonly resolveTemplate?: (modelId: string) => PromptTemplate;
}

const CAPABILITIES = {
  streaming: true,
  multiModal: false,
  supportsAudio: false,
  supportsDocuments: false,
  supportsVideo: false,
  tools: false,
  structuredOutput: 'fallback',
  systemMessageStrategy: 'in-messages',
  supportsMultipleSystemMessages: true,
  supportsTemperature: true,
  supportsTopP: true,
  supportsTopK: true,
  supportsSeed: true,
  supportsFrequencyPenalty: true,
  supportsPresencePenalty: true,
} as const;

export class DesktopLlamaBackend implements BackendAdapter<{ prompt: string }, GenerateResult> {
  readonly metadata: AdapterMetadata = {
    name: 'llama-cpp-desktop',
    version: '1.0.0',
    provider: 'llama.cpp (desktop, in-process)',
    capabilities: CAPABILITIES,
  };

  readonly #options: DesktopLlamaBackendOptions;
  /** Model id -> handle. One resident model, as on mobile. */
  #loaded: { modelId: string; handle: string } | null = null;

  constructor(options: DesktopLlamaBackendOptions) {
    this.#options = options;
  }

  #template(modelId: string): PromptTemplate {
    return this.#options.resolveTemplate?.(modelId) ?? inferTemplate(modelId);
  }

  fromIR(request: IRChatRequest): { prompt: string } {
    const modelId = request.parameters?.model ?? '';
    return { prompt: renderPrompt(this.#template(modelId), request.messages) };
  }

  toIR(response: GenerateResult, originalRequest: IRChatRequest, latencyMs: number): IRChatResponse {
    return {
      message: { role: 'assistant', content: response.text },
      finishReason:
        response.stopReason === 'length'
          ? 'length'
          : response.stopReason === 'cancelled'
            ? 'cancelled'
            : response.stopReason === 'error'
              ? 'error'
              : 'stop',
      usage: {
        promptTokens: response.promptTokens,
        completionTokens: response.completionTokens,
        totalTokens: response.promptTokens + response.completionTokens,
      },
      metadata: {
        ...originalRequest.metadata,
        providerResponseId: response.requestId,
        custom: {
          ...originalRequest.metadata.custom,
          local: true,
          engine: 'llama-cpp',
          latencyMs,
          tokensPerSecond: response.tokensPerSecond,
        },
      },
    };
  }

  async #ensureLoaded(modelId: string): Promise<string> {
    if (this.#loaded?.modelId === modelId) return this.#loaded.handle;
    if (this.#loaded !== null) {
      await this.#options.plugin.unload({ handle: this.#loaded.handle }).catch(() => undefined);
      this.#loaded = null;
    }
    const modelPath = this.#options.resolvePath?.(modelId) ?? modelId;
    const result = await this.#options.plugin.load({ modelPath, gpuLayers: -1, useMmap: true });
    this.#loaded = { modelId, handle: result.handle };
    return result.handle;
  }

  async execute(request: IRChatRequest, signal?: AbortSignal): Promise<IRChatResponse> {
    const started = Date.now();
    const modelId = request.parameters?.model ?? '';
    const handle = await this.#ensureLoaded(modelId);
    const requestId = request.metadata.requestId;

    // The signal is converted HERE, at the edge, exactly as the renderer
    // adapter does. It never becomes part of any payload: an AbortSignal is an
    // EventTarget, so it cannot be cloned across a boundary, and the contract
    // already keys cancellation by requestId instead.
    const abort = (): void => void this.#options.plugin.cancel({ requestId }).catch(() => undefined);
    signal?.addEventListener('abort', abort, { once: true });
    try {
      const result = await this.#options.plugin.generate({
        handle,
        prompt: this.fromIR(request).prompt,
        sampler: { stopSequences: [...templateStopSequences(this.#template(modelId))] },
        requestId,
      });
      return this.toIR(result, request, Date.now() - started);
    } finally {
      signal?.removeEventListener('abort', abort);
    }
  }

  executeStream(request: IRChatRequest, signal?: AbortSignal): IRChatStream {
    return this.#stream(request, signal);
  }

  async *#stream(request: IRChatRequest, signal?: AbortSignal): IRChatStream {
    const started = Date.now();
    const requestId = request.metadata.requestId;
    let sequence = 0;
    yield { type: 'start', sequence: sequence++, metadata: request.metadata };

    const modelId = request.parameters?.model ?? '';
    let handle: string;
    try {
      handle = await this.#ensureLoaded(modelId);
    } catch (error) {
      yield {
        type: 'error',
        sequence: sequence++,
        error: {
          code: 'model_load_failed',
          message: error instanceof Error ? error.message : String(error),
        },
      };
      return;
    }

    const queue: string[] = [];
    let wake: (() => void) | null = null;
    let finished: GenerateResult | null = null;
    let failure: Error | null = null;
    const nudge = (): void => {
      wake?.();
      wake = null;
    };

    const listener = await this.#options.plugin.addListener('llamaToken', (event: TokenEvent) => {
      if (event.requestId !== requestId) return;
      queue.push(event.token);
      nudge();
    });

    const abort = (): void => void this.#options.plugin.cancel({ requestId }).catch(() => undefined);
    signal?.addEventListener('abort', abort, { once: true });

    // The generation promise is the terminal signal, here as across IPC. The
    // loop below cannot hang on a lost `llamaEnd`, because it never waits for
    // one.
    const generation = this.#options.plugin
      .generate({
        handle,
        prompt: this.fromIR(request).prompt,
        sampler: { stopSequences: [...templateStopSequences(this.#template(modelId))] },
        requestId,
      })
      .then((result) => {
        finished = result;
      })
      .catch((error: unknown) => {
        failure = error instanceof Error ? error : new Error(String(error));
      })
      .finally(nudge);

    try {
      while (finished === null && failure === null) {
        if (queue.length === 0) {
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
          continue;
        }
        const token = queue.shift();
        if (token === undefined) continue;
        yield { type: 'content', sequence: sequence++, delta: token, role: 'assistant' };
      }
      while (queue.length > 0) {
        const token = queue.shift();
        if (token === undefined) continue;
        yield { type: 'content', sequence: sequence++, delta: token, role: 'assistant' };
      }

      const error = failure as Error | null;
      if (error !== null) {
        yield {
          type: 'error',
          sequence: sequence++,
          error: { code: 'generation_failed', message: error.message },
        };
        return;
      }

      const result = finished as GenerateResult | null;
      if (result === null) return;
      const response = this.toIR(result, request, Date.now() - started);
      yield {
        type: 'done',
        sequence: sequence++,
        finishReason: response.finishReason,
        usage: response.usage,
        message: response.message,
      };
    } finally {
      signal?.removeEventListener('abort', abort);
      await listener.remove().catch(() => undefined);
      await generation.catch(() => undefined);
    }
  }

  async healthCheck(): Promise<boolean> {
    try {
      await this.#options.plugin.getCapabilities();
      return true;
    } catch {
      return false;
    }
  }
}
