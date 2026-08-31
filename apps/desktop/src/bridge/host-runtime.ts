/**
 * The inference-host half of the host link, for ANY number of plugins.
 *
 * Runs inside the utility process, next to the native addons. Its whole job is
 * to turn `{k:'call'}` envelopes into method calls on the plugin they name, and
 * plugin events into `{k:'ev'}` envelopes tagged with the plugin they came
 * from — and to make sure a call is answered exactly once, including when the
 * method throws.
 *
 * WHY THIS IS KEYED BY PLUGIN NAME. The previous shape was
 * `serveLlamaCpp({link, plugin})`: one implementation, one method allowlist
 * (`LLAMA_METHODS`), one event list (`LLAMA_EVENTS`), and a wire message with
 * no plugin dimension at all. A second engine — milestone A3's Whisper, Piper
 * and diffusion — could not be addressed by it and its events had nowhere to
 * go. Worse, the collision was silent rather than type-checked: two engines
 * that both declare `generate` and `cancel` (which is exactly what a
 * transcriber and a text model both want to be called) would have been the
 * same wire message, and a `LlamaCppPlugin` would have been handed an ONNX
 * request. The registry below makes the plugin name part of the address.
 *
 * Each registration brings its OWN policy — its own method allowlist (from its
 * definition), its own argument-shape check, its own path guard, its own
 * message-opacity table — because those are properties of an engine, not of
 * the boundary. `call-shape.ts` holds llama.cpp's; ONNX will hold its own.
 *
 * Errors are FLATTENED here rather than posted as `Error` instances, because
 * structured clone would strip the prototype and any subclass identity. The
 * same flattening happens at the renderer boundary, so one error shape
 * survives both hops and `HANDLE_LOST` reaches the adapter that needs it.
 */

import { assertCloneable } from './clone.js';
import type { HostCall, HostPing, MessageLink, PluginDefinition } from './protocol.js';
import { toWireError } from './protocol.js';

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
 * Check one call's arguments, or throw a message naming what is wrong.
 *
 * Per plugin, deliberately. `assertCallShape` in `call-shape.ts` is keyed by
 * llama.cpp's method names; a second engine with its own `generate` needs its
 * own table, and one shared table would silently apply llama's required fields
 * to somebody else's method of the same name.
 */
export type CallShape = (method: string, args: readonly unknown[]) => void;

/**
 * The subset of a plugin implementation this file needs to see.
 *
 * Anything with the contract's `addListener` shape and callable methods.
 * Deliberately structural: `LlamaCppPlugin`, an `OnnxRuntimePlugin` and a test
 * fake all satisfy it without this file importing any of them.
 */
export interface HostPluginImplementation {
  /**
   * The contract declares this as a set of per-event-name overloads, so no
   * single concrete signature is assignable from all of them. `...never[]`
   * accepts any overload set while still REQUIRING the property to exist and
   * to answer with a removable handle, which is the part that matters: a
   * registration whose implementation cannot be subscribed to would forward no
   * events at all and look, from main, exactly like an engine that is quiet.
   */
  addListener(...args: never[]): Promise<{ remove(): Promise<void> }>;
}

/** `addListener` as this file actually calls it: one signature, any name. */
type AnyAddListener = (
  eventName: string,
  listener: (data: unknown) => void,
) => Promise<{ remove(): Promise<void> }>;

/** Everything one registration brings beyond its methods. */
export interface ServeOptions {
  /** Argument policy that needs the filesystem. See {@link CallGuard}. */
  readonly guard?: CallGuard;
  /** Required-field check for this plugin's methods. See {@link CallShape}. */
  readonly shape?: CallShape;
  /**
   * Methods whose ENGINE failure message must not cross the boundary verbatim.
   *
   * DEFECT [8], the second half. node-llama-cpp's load failure is
   * `Invalid GGUF magic. Expected "GGUF" but got "##\n#"` — the first four
   * bytes of the file, quoted back. Forwarded to the renderer that named the
   * file, that is a read primitive: the page learns the leading bytes of
   * anything the path guard lets through, and the presence/absence of a file
   * from which error it gets. The real text goes to the host's own `warn`,
   * which stays inside this process.
   *
   * Per plugin, because which methods open a caller-named file is an engine's
   * property: `LlamaCpp.load` does, and an ONNX session loader will too, under
   * a different method name.
   */
  readonly opaqueFailures?: Readonly<Record<string, string>>;
}

export interface HostRuntimeOptions {
  readonly link: MessageLink;
  /** Where anomalies go. Never a prompt, never generated text. */
  readonly warn?: (message: string) => void;
}

interface Registration {
  readonly definition: PluginDefinition;
  readonly implementation: HostPluginImplementation;
  readonly options: ServeOptions;
  readonly listeners: Promise<{ remove(): Promise<void> }>[];
}

/**
 * One message link, any number of plugins on it.
 *
 * The link's `onMessage` is subscribed ONCE, in the constructor, and dispatch
 * happens from the registry. Subscribing per plugin would work on Electron's
 * parent port (which appends listeners) and would double-answer every ping,
 * because the ping is answered by the boundary rather than by a plugin.
 */
export class HostRuntime {
  readonly #link: MessageLink;
  readonly #warn: (message: string) => void;
  readonly #plugins = new Map<string, Registration>();

  constructor(options: HostRuntimeOptions) {
    this.#link = options.link;
    this.#warn = options.warn ?? ((): void => undefined);

    this.#link.onMessage((raw) => {
      const message = raw as HostCall | HostPing;
      if (message === null || typeof message !== 'object') return;
      // Answered HERE, ahead of any plugin lookup and without touching an
      // implementation. A probe that had to go through a plugin would be
      // blocked by precisely the state it exists to detect, and would answer
      // "wedged" for a host that is merely busy loading a 6 GB model. It is
      // also why it must not be per-plugin: one host, one liveness answer.
      if (message.k === 'ping') {
        this.#send({ k: 'pong', id: message.id });
        return;
      }
      if (message.k !== 'call') return;
      void this.#dispatch(message);
    });
  }

  /**
   * Register one plugin under its declared name.
   *
   * @throws Error if the name is already served. A second registration under
   *   one name is not a merge and must not silently become one — the first
   *   engine would keep receiving the calls while the second looked mounted.
   */
  serve(
    definition: PluginDefinition,
    implementation: HostPluginImplementation,
    options: ServeOptions = {},
  ): void {
    if (this.#plugins.has(definition.name)) {
      throw new Error(`inference host: plugin "${definition.name}" is already served.`);
    }
    // The contract's overloads are per-event-name; this loop is generic over
    // them, so one cast at the boundary beats one line per event name — and
    // beats a second engine's event names not existing in the type at all.
    const addListener = implementation.addListener as unknown as AnyAddListener;
    const listeners = definition.events.map((name) =>
      addListener.call(implementation, name, this.#forward(definition.name, name)),
    );
    this.#plugins.set(definition.name, { definition, implementation, options, listeners });
  }

  /** Which plugins are served, in registration order. Used by tests and logs. */
  get served(): readonly string[] {
    return [...this.#plugins.keys()];
  }

  /** Stop forwarding events for every registered plugin. */
  async dispose(): Promise<void> {
    for (const registration of this.#plugins.values()) {
      for (const pending of registration.listeners) {
        const handle = await pending.catch(() => null);
        await handle?.remove().catch(() => undefined);
      }
    }
  }

  #send(message: unknown): void {
    try {
      this.#link.postMessage(message);
    } catch (error) {
      // A post that throws is the boundary telling us the far side is gone, or
      // that the payload is not cloneable. Neither is recoverable here; it
      // must not take the process down with it.
      this.#warn(`inference host could not post a message: ${toWireError(error).message}`);
    }
  }

  #forward(plugin: string, name: string) {
    return (data: unknown): void => {
      try {
        assertCloneable(data, `${plugin}.${name} event`);
      } catch (error) {
        this.#warn(
          `inference host refused to forward a ${plugin}.${name}: ${toWireError(error).message}`,
        );
        return;
      }
      this.#send({ k: 'ev', plugin, name, data });
    };
  }

  async #dispatch(call: HostCall): Promise<void> {
    try {
      const registration = this.#plugins.get(call.plugin);
      if (registration === undefined) {
        throw new Error(`inference host: no plugin named "${String(call.plugin)}".`);
      }
      const { definition, implementation, options } = registration;
      if (!definition.methods.includes(call.method)) {
        throw new Error(`inference host: "${definition.name}" has no method "${call.method}".`);
      }
      // Four steps, in this order, and the order is the point. The plugin name
      // decides WHOSE allowlist applies; the allowlist decides the method
      // exists; the shape check decides the arguments are the ones it needs and
      // says which field is missing if not; the guard decides the paths among
      // them are ones we are willing to open. Only then does anything native
      // run. Every one of these throws OUR message, which is why they are
      // outside the inner try below.
      options.shape?.(call.method, call.args);
      const args = options.guard?.(call.method, call.args) ?? call.args;

      const method = (implementation as unknown as Record<
        string,
        (...a: readonly unknown[]) => unknown
      >)[call.method];
      /* c8 ignore next */
      if (typeof method !== 'function') {
        throw new Error(`inference host: "${definition.name}.${call.method}" is absent.`);
      }

      let data: unknown;
      try {
        data = await method.apply(implementation, [...args]);
      } catch (engineError) {
        // The engine's own words, for the methods where those words describe
        // the CONTENTS of a file the renderer named.
        throw this.#opaque(registration, call.method, engineError);
      }
      assertCloneable(data, `${definition.name}.${call.method}() result`);
      this.#send({ k: 'ret', id: call.id, ok: true, data });
    } catch (error) {
      this.#send({ k: 'ret', id: call.id, ok: false, error: toWireError(error) });
    }
  }

  /** Replace an engine failure whose message would leak, and log the original. */
  #opaque(registration: Registration, method: string, error: unknown): unknown {
    const replacement = registration.options.opaqueFailures?.[method];
    if (replacement === undefined) return error;
    this.#warn(
      `inference host: ${registration.definition.name}.${method} failed: ` +
        toWireError(error).message,
    );
    return new Error(replacement);
  }
}

/**
 * Start a host runtime on one link.
 *
 * @returns the runtime, on which `serve(definition, implementation)` registers
 *   each plugin. Nothing is served until it is asked for by name.
 */
export function createHostRuntime(options: HostRuntimeOptions): HostRuntime {
  return new HostRuntime(options);
}
