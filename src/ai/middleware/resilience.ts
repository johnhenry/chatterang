/**
 * Device-pressure fallback (PRD §3.5).
 *
 * This is the capability no single reference app has: when the phone is too
 * hot, too low on memory, or the local engine simply fails, the request moves
 * to a configured remote backend instead of dying — and the user is told, in
 * the thread, that this specific turn left the device.
 *
 * The consent model matters more than the mechanism. Falling back to a remote
 * provider means sending the conversation off-device, so it never happens
 * unless the user has explicitly nominated a fallback backend, and every
 * fallback is recorded in the message's provenance.
 *
 * In the middleware below a nomination is necessary and not sufficient. It
 * diverts a request only when its caller supplies `clearForFallback`, which
 * hands back the messages cleared for the fallback, and only a turn that runs
 * on this device is eligible. The engine never supplies it: this middleware
 * returns early on streamed requests, so the one request it acts on is
 * `complete()`'s, and `complete()` has nothing to announce a divert with and no
 * gate for the new destination. The divert a chat turn gets is
 * `ChatterangEngine.stream`'s own, built with the exports above the middleware.
 */

import type {
  BackendAdapter,
  IRChatRequest,
  IRChatResponse,
  Middleware,
  MiddlewareContext,
  MiddlewareNext,
} from '@johnhenry/aimatey-types';

import type { ClearedMessage } from '@/ai/taint';
import { LlamaCpp } from '@/plugins/llama-cpp';
import type { ThermalState } from '@/plugins/llama-cpp';

export type FallbackReason =
  | 'thermal'
  | 'memory'
  | 'engine-error'
  | 'model-missing'
  | 'timeout'
  | 'none';

export interface FallbackEvent {
  readonly reason: FallbackReason;
  readonly from: string;
  readonly to: string;
  readonly detail: string;
}

export interface FallbackTarget {
  readonly name: string;
  readonly adapter: BackendAdapter;
  /** Model the fallback backend should use, since the local id is meaningless there. */
  readonly modelId?: string;
}

export interface ResilienceOptions {
  /** The backend to divert to, or null when the user has nominated none. */
  resolveFallback: () => FallbackTarget | null;
  /**
   * What THIS request may carry to the fallback: its messages, cleared for the
   * fallback, or null to refuse. Leaving it out is a refusal, and so is any
   * answer but a message list.
   *
   * A nomination names the backend a divert would use. It does not say what a
   * given request may take there. The messages on `context.request` were
   * cleared for the ORIGINAL target. For a local target nothing was withheld
   * and the taint mark was kept, so forwarding them would hand tool output to
   * the fallback still carrying this app's mark. So the middleware never sends
   * them. It sends only what this returns, and the `ClearedMessage` brand means
   * the answer has been through `clearForDestination`, the same enforcement
   * `ChatterangEngine#toIR` relies on. Which grant covers the fallback, if any,
   * is the caller's to decide.
   *
   * Clearing is not the whole of consent. `stream()` also announces a divert
   * before anything is sent, and can raise the egress sheet for the new
   * destination. A caller that can do neither leaves this out, as the engine
   * does.
   */
  clearForFallback?: (
    context: MiddlewareContext,
    fallback: FallbackTarget,
  ) => readonly ClearedMessage[] | null;
  /** Refuse to start a local generation above this thermal level (0–1). */
  thermalCeiling?: number;
  /** Refuse to start when free memory drops below this many bytes. */
  memoryFloor?: number;
  onFallback?: (event: FallbackEvent) => void;
  onThermalReading?: (state: ThermalState) => void;
}

/** Classify a failure so the user gets a reason, not a stack trace. */
export function classifyFailure(error: unknown): { reason: FallbackReason; detail: string } {
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();

  if (lower.includes('not installed') || lower.includes('missing')) {
    return { reason: 'model-missing', detail: message };
  }
  if (lower.includes('memory') || lower.includes('alloc') || lower.includes('oom')) {
    return { reason: 'memory', detail: message };
  }
  if (lower.includes('thermal') || lower.includes('throttl')) {
    return { reason: 'thermal', detail: message };
  }
  if (lower.includes('timeout') || lower.includes('timed out')) {
    return { reason: 'timeout', detail: message };
  }
  return { reason: 'engine-error', detail: message };
}

export function describeFallback(reason: FallbackReason): string {
  switch (reason) {
    case 'thermal':
      return 'Your device is running hot, so this reply was generated remotely.';
    case 'memory':
      return 'There was not enough free memory to run the local model, so this reply was generated remotely.';
    case 'model-missing':
      return 'The local model is not installed, so this reply was generated remotely.';
    case 'timeout':
      return 'The local model took too long, so this reply was generated remotely.';
    case 'engine-error':
      return 'The local engine could not complete this reply, so it was generated remotely.';
    case 'none':
      return '';
  }
}

/** Thermal ceiling above which a local generation should not be started. */
export const DEFAULT_THERMAL_CEILING = 0.85;
/** Free memory below which a local generation should not be started. */
export const DEFAULT_MEMORY_FLOOR = 220 * 1024 * 1024;

/**
 * Ask the device whether it can take a local generation right now.
 *
 * Exported so the streaming path can run the same pre-flight the middleware
 * does — aimatey's `Bridge.use()` middleware never runs for streamed requests
 * (johnhenry/ai.matey#46), and every chat turn in this app streams.
 *
 * Returns null when the device is fine, or the reason it is not.
 */
export async function checkDevicePressure(options: {
  thermalCeiling?: number;
  memoryFloor?: number;
  onThermalReading?: (state: ThermalState) => void;
} = {}): Promise<{ reason: FallbackReason; detail: string } | null> {
  const ceiling = options.thermalCeiling ?? DEFAULT_THERMAL_CEILING;
  const floor = options.memoryFloor ?? DEFAULT_MEMORY_FLOOR;

  const pressure = await readPressure(options.onThermalReading);
  if (!pressure) return null;

  if (pressure.thermal.level >= ceiling || pressure.thermal.throttled) {
    return {
      reason: 'thermal',
      detail: `Thermal state ${pressure.thermal.state} (${pressure.thermal.level.toFixed(2)}).`,
    };
  }

  if (pressure.availableMemory > 0 && pressure.availableMemory < floor) {
    return {
      reason: 'memory',
      detail: `Only ${Math.round(pressure.availableMemory / 1024 / 1024)} MB free.`,
    };
  }

  return null;
}

export function createResilienceMiddleware(options: ResilienceOptions): Middleware {
  const thermalCeiling = options.thermalCeiling ?? 0.85;
  const memoryFloor = options.memoryFloor ?? 220 * 1024 * 1024;

  return async function resilienceMiddleware(
    context: MiddlewareContext,
    next: MiddlewareNext,
  ): Promise<IRChatResponse> {
    // See the note in `tools.ts`: the engine owns the streaming path and runs
    // this same pre-flight and fallback itself. Doing it here as well would
    // send a diverted request to the fallback backend twice.
    if (context.isStreaming) return next();

    const backendName = context.backendName ?? 'local';
    const declaredLocal = (context.request.metadata.custom as { local?: boolean } | undefined)
      ?.local;
    const isLocal =
      declaredLocal ??
      (backendName.startsWith('llama') ||
        backendName.startsWith('litert') ||
        backendName.startsWith('chrome'));

    /*
     * Where a divert is decided, for both branches below.
     *
     * Only a turn that runs on this device is eligible, which is the rule
     * `stream()` follows (`runsOnThisDevice`), and the caller must supply
     * `clearForFallback`. Both are checked before the fallback is resolved, so
     * a refusal never depends on what happens to be nominated. The failure
     * handler used to skip both: it diverted on nomination alone, and a remote
     * or paired turn that failed went to the fallback too
     * (tests/complete-divert.test.ts).
     *
     * What goes is only what `clearForFallback` cleared for the fallback. The
     * request's own messages were cleared for the original target, and they are
     * never forwarded.
     */
    const divert = (): { fallback: FallbackTarget; messages: readonly ClearedMessage[] } | null => {
      if (!isLocal || !options.clearForFallback) return null;
      const fallback = options.resolveFallback();
      if (!fallback) return null;
      const messages = options.clearForFallback(context, fallback);
      return Array.isArray(messages) ? { fallback, messages } : null;
    };

    // Pre-flight: only local engines are subject to device pressure.
    if (isLocal) {
      const pressure = await checkDevicePressure({
        thermalCeiling,
        memoryFloor,
        onThermalReading: options.onThermalReading,
      });

      if (pressure) {
        // Refused, the local backend takes the turn, as it does with nothing nominated.
        const diverted = divert();
        if (diverted) {
          const { fallback, messages } = diverted;
          options.onFallback?.({
            reason: pressure.reason,
            from: backendName,
            to: fallback.name,
            detail: pressure.detail,
          });
          const response = await fallback.adapter.execute(
            retarget(context.request, fallback, messages),
            context.signal,
          );
          return annotate(response, backendName, fallback.name, pressure.reason);
        }
      }
    }

    try {
      return await next();
    } catch (error) {
      if (context.signal?.aborted) throw error;

      const diverted = divert();
      if (!diverted) throw error;
      const { fallback, messages } = diverted;

      const { reason, detail } = classifyFailure(error);
      options.onFallback?.({ reason, from: backendName, to: fallback.name, detail });
      const response = await fallback.adapter.execute(
        retarget(context.request, fallback, messages),
        context.signal,
      );
      return annotate(response, backendName, fallback.name, reason);
    }
  };
}

/**
 * Point a request at the fallback backend. The local model id means nothing
 * to a remote provider, so it is replaced (or dropped, letting the adapter's
 * own default apply), and the router's explicit-backend hint is rewritten.
 *
 * The messages are replaced too, with the ones cleared for the fallback. The
 * request's own were cleared for the original target, and spreading them
 * through is how a local turn's tainted history reached the cloud still marked.
 */
function retarget(
  request: IRChatRequest,
  fallback: FallbackTarget,
  messages: readonly ClearedMessage[],
): IRChatRequest {
  const { model: _localModel, ...parameters } = request.parameters ?? {};
  return {
    ...request,
    messages,
    parameters: fallback.modelId ? { ...parameters, model: fallback.modelId } : parameters,
    metadata: {
      ...request.metadata,
      custom: { ...request.metadata.custom, backend: fallback.name, local: false },
    },
  };
}

function annotate(
  response: IRChatResponse,
  from: string,
  to: string,
  reason: FallbackReason,
): IRChatResponse {
  return {
    ...response,
    metadata: {
      ...response.metadata,
      warnings: [
        ...(response.metadata.warnings ?? []),
        {
          // `model-substituted`, not `capability-unsupported` (#149). Every
          // FallbackReason ends with a different model serving the turn, which
          // is what that member means. The upstream doc for
          // `transport-degraded` names this misuse directly: reaching for
          // `capability-unsupported` to describe "a fallback forced by device
          // pressure rather than by a missing capability" is how a category
          // stops carrying information -- and device pressure is exactly what
          // `thermal` and `memory` are.
          category: 'model-substituted',
          severity: 'warning',
          message: describeFallback(reason),
          source: from,
        },
      ],
      custom: {
        ...response.metadata.custom,
        fallbackFrom: from,
        fallbackTo: to,
        fallbackReason: reason,
      },
    },
  };
}

async function readPressure(
  onReading?: (state: ThermalState) => void,
): Promise<{ thermal: ThermalState; availableMemory: number } | null> {
  try {
    const [thermal, capabilities] = await Promise.all([
      LlamaCpp.getThermalState(),
      LlamaCpp.getCapabilities(),
    ]);
    onReading?.(thermal);
    return { thermal, availableMemory: capabilities.availableMemory };
  } catch {
    return null;
  }
}
