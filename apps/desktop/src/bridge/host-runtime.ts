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

import { assertCallShape } from './call-shape.js';
import { assertCloneable } from './clone.js';
import type { HostCall, HostPing, LlamaEventName, MessageLink } from './protocol.js';
import { LLAMA_EVENTS, LLAMA_METHODS, toWireError } from './protocol.js';

/**
 * Rewrite a call's arguments before the plugin sees them, or throw to refuse.
 *
 * Exists for exactly one policy: confining `load`'s three path fields to the
 * app's model directory (defect [8]). That needs `node:path` and the app's
 * `userData` location, neither of which this directory may know about — the
 * layering guard in `tests/layering.test.ts` forbids a Node builtin here, and
 * it forbids it for a reason (this code is driven end-to-end by tests through
 * fake ports). So the policy is INJECTED from `host/entry.ts`, which is allowed
 * both, and the seam is one function rather than a set of hooks.
 *
 * @returns the arguments to actually call the method with.
 * @throws Error to refuse the call outright. The message reaches the renderer.
 */
export type CallGuard = (method: string, args: readonly unknown[]) => readonly unknown[];

/**
 * Methods whose ENGINE failure message must not cross the boundary verbatim.
 *
 * DEFECT [8], the second half. node-llama-cpp's load failure is
 * `Invalid GGUF magic. Expected "GGUF" but got "##\n#"` — the first four bytes
 * of the file, quoted back. Forwarded to the renderer that named the file, that
 * is a read primitive: the page learns the leading bytes of anything the check
 * above lets through, and the presence/absence of a file from which error it
 * gets. Replaced by a fixed sentence; the real text goes to the host's own
 * `warn`, which stays inside this process.
 *
 * The cost is real and is accepted rather than hidden: a genuine load failure
 * (a truncated download, a model too large for memory) now reads the same as a
 * wrong file. The engine's own words are one `warn` away for anyone debugging,
 * and a diagnostic that is also an oracle is not a diagnostic worth keeping.
 */
const OPAQUE_FAILURES: Readonly<Record<string, string>> = Object.freeze({
  load: 'The model could not be loaded. Check that the file is a complete GGUF model in the app’s model folder.',
});

export interface HostRuntimeOptions {
  readonly link: MessageLink;
  readonly plugin: LlamaCppPlugin;
  /** Where anomalies go. Never a prompt, never generated text. */
  readonly warn?: (message: string) => void;
  /** Argument policy that needs the filesystem. See {@link CallGuard}. */
  readonly guard?: CallGuard;
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
    const message = raw as HostCall | HostPing;
    if (message === null || typeof message !== 'object') return;
    // Answered HERE, ahead of the method allowlist and without touching the
    // plugin. A probe that had to go through `LlamaCppNode` would be blocked by
    // precisely the state it exists to detect, and would answer "wedged" for a
    // host that is merely busy loading a 6 GB model.
    if (message.k === 'ping') {
      send({ k: 'pong', id: message.id });
      return;
    }
    if (message.k !== 'call') return;
    void dispatch(message);
  });

  async function dispatch(call: HostCall): Promise<void> {
    try {
      if (!(LLAMA_METHODS as readonly string[]).includes(call.method)) {
        throw new Error(`inference host: no method "${call.method}".`);
      }
      // Three steps, in this order, and the order is the point. The allowlist
      // decides the method exists; the shape check decides the arguments are
      // the ones it needs and says which field is missing if not; the guard
      // decides the paths among them are ones we are willing to open. Only
      // then does anything native run. Every one of these throws OUR message,
      // which is why they are outside the inner try below.
      assertCallShape(call.method, call.args);
      const args = options.guard?.(call.method, call.args) ?? call.args;

      const method = (plugin as unknown as Record<string, (...a: readonly unknown[]) => unknown>)[
        call.method
      ];
      /* c8 ignore next */
      if (typeof method !== 'function') throw new Error(`inference host: "${call.method}" is absent.`);

      let data: unknown;
      try {
        data = await method.apply(plugin, [...args]);
      } catch (engineError) {
        // The engine's own words, for the methods where those words describe
        // the CONTENTS of a file the renderer named.
        throw opaque(call.method, engineError);
      }
      assertCloneable(data, `${call.method}() result`);
      send({ k: 'ret', id: call.id, ok: true, data });
    } catch (error) {
      send({ k: 'ret', id: call.id, ok: false, error: toWireError(error) });
    }
  }

  /** Replace an engine failure whose message would leak, and log the original. */
  function opaque(method: string, error: unknown): unknown {
    const replacement = OPAQUE_FAILURES[method];
    if (replacement === undefined) return error;
    warn(`inference host: ${method} failed: ${toWireError(error).message}`);
    return new Error(replacement);
  }

  return async (): Promise<void> => {
    for (const pending of handles) {
      const handle = await pending.catch(() => null);
      await handle?.remove().catch(() => undefined);
    }
  };
}
