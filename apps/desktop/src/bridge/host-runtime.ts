/**
 * The inference-host half of the host link.
 *
 * Runs inside the utility process, next to `LlamaCppNode` and the native
 * addon. Its whole job is to turn `{k:'call'}` envelopes into method calls and
 * plugin events into `{k:'ev'}` envelopes — and to make sure a call is
 * answered exactly once, including when the method throws.
 *
 * Errors are FLATTENED here rather than posted as `Error` instances, because
 * structured clone would strip the prototype and any subclass identity. The
 * same flattening happens at the renderer boundary, so one error shape
 * survives both hops and `HANDLE_LOST` reaches the adapter that needs it.
 */

import type { LlamaCppPlugin } from '@chatterang/contracts';

import { assertCloneable } from './clone.js';
import type { HostCall, LlamaEventName, MessageLink } from './protocol.js';
import { LLAMA_EVENTS, LLAMA_METHODS, toWireError } from './protocol.js';

export interface HostRuntimeOptions {
  readonly link: MessageLink;
  readonly plugin: LlamaCppPlugin;
  /** Where anomalies go. Never a prompt, never generated text. */
  readonly warn?: (message: string) => void;
}

/**
 * Serve one `LlamaCppPlugin` over a message link.
 *
 * @returns a disposer that stops forwarding events.
 */
export function serveLlamaCpp(options: HostRuntimeOptions): () => Promise<void> {
  const { link, plugin } = options;
  const warn = options.warn ?? ((): void => undefined);

  const send = (message: unknown): void => {
    try {
      link.postMessage(message);
    } catch (error) {
      // A post that throws is the boundary telling us the far side is gone, or
      // that the payload is not cloneable. Neither is recoverable here; it
      // must not take the process down with it.
      warn(`inference host could not post a message: ${toWireError(error).message}`);
    }
  };

  const forward = (name: LlamaEventName) => (data: unknown): void => {
    try {
      assertCloneable(data, `${name} event`);
    } catch (error) {
      warn(`inference host refused to forward a ${name}: ${toWireError(error).message}`);
      return;
    }
    send({ k: 'ev', name, data });
  };

  const handles = LLAMA_EVENTS.map((name) =>
    // The contract's overloads are per-event-name; the loop is generic over
    // them, so one cast at the boundary beats three near-identical lines.
    (plugin.addListener as (n: string, l: (d: unknown) => void) => Promise<{ remove(): Promise<void> }>)(
      name,
      forward(name),
    ),
  );

  link.onMessage((raw) => {
    const message = raw as HostCall;
    if (message === null || typeof message !== 'object' || message.k !== 'call') return;
    void dispatch(message);
  });

  async function dispatch(call: HostCall): Promise<void> {
    try {
      if (!(LLAMA_METHODS as readonly string[]).includes(call.method)) {
        throw new Error(`inference host: no method "${call.method}".`);
      }
      const method = (plugin as unknown as Record<string, (...a: readonly unknown[]) => unknown>)[
        call.method
      ];
      /* c8 ignore next */
      if (typeof method !== 'function') throw new Error(`inference host: "${call.method}" is absent.`);
      const data = await method.apply(plugin, [...call.args]);
      assertCloneable(data, `${call.method}() result`);
      send({ k: 'ret', id: call.id, ok: true, data });
    } catch (error) {
      send({ k: 'ret', id: call.id, ok: false, error: toWireError(error) });
    }
  }

  return async (): Promise<void> => {
    for (const pending of handles) {
      const handle = await pending.catch(() => null);
      await handle?.remove().catch(() => undefined);
    }
  };
}
