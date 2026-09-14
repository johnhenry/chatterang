/**
 * llama.cpp as an aimatey backend adapter.
 *
 * This is the seam the whole architecture turns on (PRD §2): the native
 * Capacitor plugin is wrapped to satisfy `BackendAdapter`, so the router,
 * middleware stack, and every UI call site treat on-device llama.cpp exactly
 * as they treat OpenAI or Ollama. Adding MLC-LLM in Phase 2 means writing a
 * sibling of this file — nothing above it changes.
 */

import type {
  AdapterMetadata,
  BackendAdapter,
  IRChatRequest,
  IRChatResponse,
  IRChatStream,
  IRMessage,
  ListModelsResult,
  MessageContent,
} from '@johnhenry/aimatey-types';

import { LlamaCpp } from '@/plugins/llama-cpp';
import type {
  ComputeBackendId,
  GenerateImage,
  GenerateResult,
  TokenEvent,
  TurnWaitingEvent,
} from '@/plugins/llama-cpp';
import type { ModelManifest, SamplerSettings } from '@/domain/manifest';
import { inferTemplate, renderPrompt, templateStopSequences } from '@/ai/prompt';

/** Everything the adapter needs to turn a model id into a loaded handle. */
export interface LlamaModelResolver {
  /** Manifest for an installed model, or null when it is not installed. */
  getManifest(modelId: string): ModelManifest | null;
  /** Absolute on-device path for an installed model file. */
  getPath(modelId: string, role?: 'model' | 'mmproj' | 'draft'): string | null;
  /** Saved sampler settings for a model. */
  getSampler(modelId: string): SamplerSettings;
}

export interface LlamaCppBackendConfig {
  resolver: LlamaModelResolver;
  /** Preferred compute backend; the engine falls back down the tier list. */
  backend?: ComputeBackendId;
  /** Called whenever a load reports non-fatal warnings. */
  onWarning?: (message: string) => void;
  /** Called with per-token throughput so the UI can show a live readout. */
  onProgress?: (progress: { requestId: string; tokens: number; elapsedMs: number }) => void;
  /**
   * Called when a streamed generation is waiting for the model, and with
   * `position: 0` when it starts (#7). Only the desktop reports this.
   */
  onWaiting?: (event: TurnWaitingEvent) => void;
}

/**
 * The one subscription the contract does not declare.
 *
 * `llamaWaiting` is emitted by the desktop's main process alone (see
 * `TurnWaitingEvent`), so it is typed here, at the one call site, rather than
 * added to an interface every inference host implements.
 */
interface WaitingEvents {
  addListener(
    eventName: 'llamaWaiting',
    listener: (event: TurnWaitingEvent) => void,
  ): Promise<{ remove(): Promise<void> }>;
}

interface LoadedHandle {
  handle: string;
  modelId: string;
  backend: ComputeBackendId;
  contextLength: number;
  supportsVision: boolean;
}

const CAPABILITIES = {
  streaming: true,
  multiModal: true,
  supportsAudio: false,
  supportsDocuments: false,
  supportsVideo: false,
  tools: true,
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

export class LlamaCppBackendAdapter implements BackendAdapter {
  readonly metadata: AdapterMetadata = {
    name: 'llama-cpp',
    version: '1.0.0',
    provider: 'llama.cpp (on-device)',
    capabilities: CAPABILITIES,
  };

  #config: LlamaCppBackendConfig;
  #loaded: LoadedHandle | null = null;
  #loading: Promise<LoadedHandle> | null = null;

  constructor(config: LlamaCppBackendConfig) {
    this.#config = config;
  }

  /* ── Conversion ───────────────────────────────────────────────────── */

  fromIR(request: IRChatRequest): { prompt: string; images: GenerateImage[] } {
    const modelId = request.parameters?.model ?? '';
    const manifest = this.#config.resolver.getManifest(modelId);
    const template = manifest?.promptTemplate ?? inferTemplate(modelId);
    return {
      prompt: renderPrompt(template, request.messages),
      images: collectImages(request.messages),
    };
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
        details: {
          tokensPerSecond: response.tokensPerSecond,
          ttftMs: response.ttftMs,
          cachedTokens: response.cachedTokens,
          draftAcceptance: response.draftAcceptance,
        },
      },
      metadata: {
        ...originalRequest.metadata,
        providerResponseId: response.requestId,
        provenance: {
          ...originalRequest.metadata.provenance,
          backend: this.metadata.name,
        },
        custom: {
          ...originalRequest.metadata.custom,
          local: true,
          engine: 'llama-cpp',
          computeBackend: this.#loaded?.backend,
          latencyMs,
          peakMemoryBytes: response.peakMemoryBytes,
          tokensPerSecond: response.tokensPerSecond,
          ttftMs: response.ttftMs,
          cachedTokens: response.cachedTokens,
          draftAcceptance: response.draftAcceptance,
        },
      },
    };
  }

  /* ── Model lifecycle ──────────────────────────────────────────────── */

  async #ensureLoaded(modelId: string): Promise<LoadedHandle> {
    if (this.#loaded?.modelId === modelId) return this.#loaded;
    if (this.#loading) {
      const pending = await this.#loading;
      if (pending.modelId === modelId) return pending;
    }

    this.#loading = this.#load(modelId);
    try {
      this.#loaded = await this.#loading;
      return this.#loaded;
    } finally {
      this.#loading = null;
    }
  }

  async #load(modelId: string): Promise<LoadedHandle> {
    const manifest = this.#config.resolver.getManifest(modelId);
    if (!manifest) {
      throw new Error(`"${modelId}" is not installed. Download it from Models first.`);
    }

    const modelPath = this.#config.resolver.getPath(modelId, 'model');
    if (!modelPath) {
      throw new Error(`The file for "${manifest.name}" is missing. Try downloading it again.`);
    }

    // Only one large model stays resident; loading a second would double peak
    // memory on devices that cannot afford it.
    if (this.#loaded) {
      await LlamaCpp.unload({ handle: this.#loaded.handle }).catch(() => undefined);
      this.#loaded = null;
    }

    const sampler = this.#config.resolver.getSampler(modelId);
    const draftPath = sampler.draftModelId
      ? this.#config.resolver.getPath(sampler.draftModelId, 'model')
      : null;

    const result = await LlamaCpp.load({
      modelPath,
      mmprojPath: this.#config.resolver.getPath(modelId, 'mmproj') ?? undefined,
      draftModelPath: draftPath ?? undefined,
      contextLength: manifest.contextLength,
      backend: this.#config.backend ?? manifest.recommendedBackend,
      gpuLayers: -1,
      useMmap: true,
      chatTemplate: manifest.promptTemplate,
      // The template is chosen by model id, which is a guess. Hand the engine
      // its markers so a wrong guess is reported at load rather than showing up
      // later as an incoherent model.
      templateMarkers: templateStopSequences(
        manifest.promptTemplate ?? inferTemplate(manifest.id),
      ),
    });

    for (const warning of result.warnings) this.#config.onWarning?.(warning);

    return {
      handle: result.handle,
      modelId,
      backend: result.backend,
      contextLength: result.contextLength,
      supportsVision: result.supportsVision,
    };
  }

  /**
   * Drop the cached handle when the engine that owned it went away.
   *
   * The desktop shell runs inference in a separate process so a native-addon
   * abort is recoverable; the process restarts and every handle it held dies
   * with it. Without this, `#ensureLoaded` short-circuits on the cached
   * `modelId` forever and every retry sends a handle that no longer exists —
   * a permanent, silent wedge until the app is relaunched, which is worse than
   * a hang because it reads as a broken model.
   *
   * `HANDLE_LOST` is the wire code `apps/desktop` attaches to exactly this
   * failure. It is a string literal here rather than an import because `src/`
   * may not import the desktop layer at all — `tests/layering.test.ts`
   * enforces that in three import forms. `tests/desktop-bridge.test.ts` binds
   * the two ends by driving this adapter with the constant the bridge exports.
   */
  #forgetHandleOnLoss(error: unknown): void {
    const code = (error as { code?: unknown } | null)?.code;
    if (code === 'HANDLE_LOST') this.#loaded = null;
  }

  async unload(): Promise<void> {
    if (!this.#loaded) return;
    await LlamaCpp.unload({ handle: this.#loaded.handle }).catch(() => undefined);
    this.#loaded = null;
  }

  /** Currently resident model id, for the instrument rail. */
  get residentModelId(): string | null {
    return this.#loaded?.modelId ?? null;
  }

  get computeBackend(): ComputeBackendId | null {
    return this.#loaded?.backend ?? null;
  }

  /* ── Execution ────────────────────────────────────────────────────── */

  async execute(request: IRChatRequest, signal?: AbortSignal): Promise<IRChatResponse> {
    const started = performance.now();
    const loaded = await this.#ensureLoaded(request.parameters?.model ?? '');
    const { prompt, images } = this.fromIR(request);
    const requestId = request.metadata.requestId;

    const abort = (): void => void LlamaCpp.cancel({ requestId }).catch(() => undefined);
    signal?.addEventListener('abort', abort, { once: true });

    try {
      const result = await LlamaCpp.generate({
        handle: loaded.handle,
        prompt,
        images,
        sampler: this.#sampler(request, loaded.modelId),
        requestId,
      });
      return this.toIR(result, request, Math.round(performance.now() - started));
    } catch (error) {
      this.#forgetHandleOnLoss(error);
      throw error;
    } finally {
      signal?.removeEventListener('abort', abort);
    }
  }

  executeStream(request: IRChatRequest, signal?: AbortSignal): IRChatStream {
    return this.#stream(request, signal);
  }

  async *#stream(request: IRChatRequest, signal?: AbortSignal): IRChatStream {
    const started = performance.now();
    const requestId = request.metadata.requestId;
    let sequence = 0;

    yield { type: 'start', sequence: sequence++, metadata: request.metadata };

    let loaded: LoadedHandle;
    try {
      loaded = await this.#ensureLoaded(request.parameters?.model ?? '');
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

    const { prompt, images } = this.fromIR(request);

    // Bridge the plugin's event stream into an async queue the generator can
    // pull from. Tokens that arrive before the consumer asks are buffered.
    const queue: string[] = [];
    let notify: (() => void) | null = null;
    let finished: GenerateResult | null = null;
    let failure: Error | null = null;

    const wake = (): void => {
      notify?.();
      notify = null;
    };

    const listener = await LlamaCpp.addListener('llamaToken', (event: TokenEvent) => {
      if (event.requestId !== requestId) return;
      queue.push(event.token);
      wake();
    });

    // #7: on the desktop, this turn can wait for the one slot it shares with a
    // paired phone's turns, and this window is told where it stands. A
    // platform that does not know the event may refuse the subscription; that
    // means "never waits here", not a failed turn.
    const waiting = await Promise.resolve()
      .then(() =>
        (LlamaCpp as unknown as WaitingEvents).addListener('llamaWaiting', (event) => {
          // Not after Stop (#305): a place in line for a stopped turn would
          // put "Waiting" on the rail for a turn the person has ended.
          if (event.requestId !== requestId || signal?.aborted === true) return;
          this.#config.onWaiting?.(event);
        }),
      )
      .catch(() => null);

    const abort = (): void => void LlamaCpp.cancel({ requestId }).catch(() => undefined);
    signal?.addEventListener('abort', abort, { once: true });

    // STOPPED WHILE SUBSCRIBING (#305, #7). Both subscriptions above are
    // awaited, and an abort that happened during them fires no event, so the
    // listener just added would never cancel what follows. On the desktop that
    // generation waits for the slot it shares with a paired phone and starts on
    // the host once the slot frees, long after Stop. Nothing is asked for; the
    // engine reads the aborted signal and ends the turn as stopped.
    if (signal?.aborted === true) {
      signal.removeEventListener('abort', abort);
      await listener.remove().catch(() => undefined);
      await waiting?.remove().catch(() => undefined);
      return;
    }

    const generation = LlamaCpp.generate({
      handle: loaded.handle,
      prompt,
      images,
      sampler: this.#sampler(request, loaded.modelId),
      requestId,
    })
      .then((result) => {
        finished = result;
      })
      .catch((error: unknown) => {
        this.#forgetHandleOnLoss(error);
        failure = error instanceof Error ? error : new Error(String(error));
      })
      .finally(wake);

    try {
      let emitted = 0;
      while (!finished && !failure) {
        if (queue.length === 0) {
          await new Promise<void>((resolve) => {
            notify = resolve;
          });
          continue;
        }
        const token = queue.shift();
        if (token === undefined) continue;
        emitted += 1;
        yield { type: 'content', sequence: sequence++, delta: token, role: 'assistant' };
        if (emitted % 8 === 0) {
          this.#config.onProgress?.({
            requestId,
            tokens: emitted,
            elapsedMs: Math.round(performance.now() - started),
          });
        }
      }

      // Drain anything that landed between the last poll and completion.
      while (queue.length > 0) {
        const token = queue.shift();
        if (token === undefined) continue;
        yield { type: 'content', sequence: sequence++, delta: token, role: 'assistant' };
      }

      if (failure) {
        yield {
          type: 'error',
          sequence: sequence++,
          error: { code: 'generation_failed', message: (failure as Error).message },
        };
        return;
      }

      const result = finished as GenerateResult | null;
      if (!result) return;

      yield {
        type: 'metadata',
        sequence: sequence++,
        usage: {
          promptTokens: result.promptTokens,
          completionTokens: result.completionTokens,
          totalTokens: result.promptTokens + result.completionTokens,
        },
        metadata: {
          custom: {
            local: true,
            engine: 'llama-cpp',
            computeBackend: loaded.backend,
            tokensPerSecond: result.tokensPerSecond,
            ttftMs: result.ttftMs,
            cachedTokens: result.cachedTokens,
            draftAcceptance: result.draftAcceptance,
            peakMemoryBytes: result.peakMemoryBytes,
          },
        },
      };

      const response = this.toIR(result, request, Math.round(performance.now() - started));
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
      await waiting?.remove().catch(() => undefined);
      await generation.catch(() => undefined);
    }
  }

  /* ── Optional capabilities ────────────────────────────────────────── */

  async healthCheck(): Promise<boolean> {
    try {
      await LlamaCpp.getCapabilities();
      return true;
    } catch {
      return false;
    }
  }

  /** On-device inference has no marginal cost. */
  async estimateCost(): Promise<number | null> {
    return 0;
  }

  async listModels(): Promise<ListModelsResult> {
    return { models: [], source: 'static', fetchedAt: Date.now(), isComplete: true };
  }

  /** Token count against the resident model, for the context meter. */
  async countTokens(modelId: string, text: string): Promise<number> {
    const loaded = await this.#ensureLoaded(modelId);
    const { count } = await LlamaCpp.countTokens({ handle: loaded.handle, text });
    return count;
  }

  #sampler(request: IRChatRequest, modelId: string): Record<string, unknown> {
    const saved = this.#config.resolver.getSampler(modelId);
    const params = request.parameters ?? {};
    const manifest = this.#config.resolver.getManifest(modelId);
    const template = manifest?.promptTemplate ?? inferTemplate(modelId);

    return {
      temperature: params.temperature ?? saved.temperature,
      topP: params.topP ?? saved.topP,
      topK: params.topK ?? saved.topK,
      minP: saved.minP,
      repeatPenalty: saved.repeatPenalty,
      repeatLastN: saved.repeatLastN,
      frequencyPenalty: params.frequencyPenalty ?? saved.frequencyPenalty,
      presencePenalty: params.presencePenalty ?? saved.presencePenalty,
      maxTokens: params.maxTokens ?? saved.maxTokens,
      seed: params.seed ?? saved.seed,
      stopSequences: [
        ...(params.stopSequences ?? saved.stopSequences),
        ...templateStopSequences(template),
      ],
      draftTokens: saved.draftTokens,
    };
  }
}

function collectImages(messages: readonly IRMessage[]): GenerateImage[] {
  const images: GenerateImage[] = [];
  for (const message of messages) {
    if (typeof message.content === 'string') continue;
    for (const block of message.content as readonly MessageContent[]) {
      if (block.type !== 'image') continue;
      if (block.source.type === 'base64') {
        images.push({ data: block.source.data, mediaType: block.source.mediaType });
      }
    }
  }
  return images;
}
