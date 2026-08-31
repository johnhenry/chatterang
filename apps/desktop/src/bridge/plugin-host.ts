/**
 * The main-process half of the plugin bridge.
 *
 * This is what `registerPlugin('LlamaCpp', …)` in `src/` ends up talking to.
 * It owns three things and nothing else:
 *
 *   1. the manifest — which plugins exist and which methods they expose;
 *   2. the subscription table — who is listening to what, per renderer;
 *   3. the guard rail — that a renderer can only ever name something in (1).
 *
 * It holds no inference state, no ports and no Electron objects. Event
 * delivery is a callback supplied by the caller, which is what lets the tests
 * wire it to a fake port with structured-clone semantics and drive the real
 * code end to end.
 */

import { channelCollisions } from './channels.js';
import { assertCloneable } from './clone.js';
import type { BootManifest, PluginDefinition } from './protocol.js';
import { SENDER_SCOPED } from './protocol.js';

/** A method a plugin exposes to the renderer. */
export type PluginMethod = (...args: readonly unknown[]) => unknown;

/**
 * The main-process object a plugin's declared methods are called on.
 *
 * The optional {@link SENDER_SCOPED} key names the methods that are called with
 * the calling renderer's id as their first argument. See the symbol's own
 * documentation for why that is opt-in and why it is a symbol.
 */
export interface PluginImplementation {
  readonly [method: string]: PluginMethod;
  readonly [SENDER_SCOPED]?: readonly string[];
}

/** One event, addressed at one subscription in one renderer. */
export interface EventPayload {
  readonly pluginName: string;
  readonly subscriptionId: number;
  readonly eventName: string;
  readonly data: unknown;
}

/**
 * How an event reaches a renderer.
 *
 * Returns whether it was actually delivered. A destroyed renderer answers
 * false, which is how the host prunes subscriptions it can no longer reach.
 */
export type EventDelivery = (senderId: number, payload: EventPayload) => boolean;

/**
 * Names the bridge serves itself, on its own channels.
 *
 * A plugin that declares one of these as an invocable method would shadow the
 * subscription machinery. In a flat channel namespace that is a duplicate
 * handler registration; here the namespaces are disjoint so it could not
 * collide, but it would still mean two different things answer to one name in
 * the renderer proxy. Refused at registration, loudly.
 */
const RESERVED_METHODS: readonly string[] = ['addListener', 'removeListener', 'removeAllListeners'];

interface Registration {
  readonly definition: PluginDefinition;
  readonly implementation: PluginImplementation;
}

interface Subscription {
  readonly senderId: number;
  readonly pluginName: string;
  readonly eventName: string;
  readonly subscriptionId: number;
}

/** Error carrying a machine-readable `code`, so the renderer can branch on it. */
class BridgeError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'BridgeError';
  }
}

export class PluginHost {
  readonly #plugins = new Map<string, Registration>();
  /** Keyed `${senderId}:${subscriptionId}` — subscription ids are per-renderer. */
  readonly #subscriptions = new Map<string, Subscription>();
  readonly #deliver: EventDelivery;

  constructor(deliver: EventDelivery) {
    this.#deliver = deliver;
  }

  /**
   * Register a plugin, refusing anything that would make the bridge ambiguous.
   *
   * Four things are checked here rather than trusted, because each of them
   * fails silently or confusingly later: a duplicate plugin, a reserved method
   * name, a declared method the implementation does not actually have, and a
   * channel-name collision.
   *
   * @throws Error naming the exact problem.
   */
  register(definition: PluginDefinition, implementation: PluginImplementation): void {
    if (this.#plugins.has(definition.name)) {
      throw new Error(`desktop bridge: plugin "${definition.name}" is already registered.`);
    }

    const reserved = definition.methods.filter((method) => RESERVED_METHODS.includes(method));
    if (reserved.length > 0) {
      throw new Error(
        `desktop bridge: plugin "${definition.name}" declares reserved method(s): ` +
          `${reserved.join(', ')}. The bridge serves these itself; a plugin that declares ` +
          'one would shadow the subscription machinery.',
      );
    }

    // The registration-time equivalent of a smoke test: a method declared but
    // absent is a rejection every caller sees as UNKNOWN_METHOD at runtime,
    // which reads like a bridge bug rather than a missing forwarder.
    const absent = definition.methods.filter(
      (method) => typeof implementation[method] !== 'function',
    );
    if (absent.length > 0) {
      throw new Error(
        `desktop bridge: plugin "${definition.name}" declares method(s) its implementation ` +
          `does not have: ${absent.join(', ')}.`,
      );
    }

    // A scoped name the definition never declared is unreachable, which means
    // the author believes a method is sender-scoped and it is not — the exact
    // shape of defect [11], reintroduced by a typo. Refused at registration.
    const scoped = implementation[SENDER_SCOPED] ?? [];
    const undeclared = scoped.filter((method) => !definition.methods.includes(method));
    if (undeclared.length > 0) {
      throw new Error(
        `desktop bridge: plugin "${definition.name}" marks method(s) sender-scoped that it does ` +
          `not declare: ${undeclared.join(', ')}.`,
      );
    }

    const definitions = [...[...this.#plugins.values()].map((it) => it.definition), definition];
    const collisions = channelCollisions(definitions);
    if (collisions.length > 0) {
      throw new Error(`desktop bridge: channel name collision: ${collisions.join(', ')}.`);
    }

    this.#plugins.set(definition.name, { definition, implementation });
  }

  /** What the renderer is told at boot. The only source of channel names. */
  manifest(): BootManifest {
    return {
      platform: 'electron',
      plugins: [...this.#plugins.values()].map((it) => it.definition),
    };
  }

  /**
   * Invoke one declared method.
   *
   * Order matters: the plugin name and method name are checked against the
   * manifest BEFORE the arguments are looked at and before the implementation
   * is touched, so an unknown name never reaches plugin code.
   *
   * `senderId` reaches the implementation only for methods it marked
   * {@link SENDER_SCOPED}. It used to reach nothing at all — the parameter was
   * accepted and immediately discarded with `void senderId`, which is what left
   * the supervisor unable to tell one window's generations from another's.
   *
   * @throws BridgeError for an unknown plugin or method.
   * @throws NotCloneableError when arguments or the result would not survive.
   */
  async invoke(
    senderId: number,
    pluginName: string,
    method: string,
    args: readonly unknown[],
  ): Promise<unknown> {
    const registration = this.#plugins.get(pluginName);
    if (registration === undefined) {
      throw new BridgeError('UNKNOWN_PLUGIN', `desktop bridge: no plugin named "${pluginName}".`);
    }
    if (!registration.definition.methods.includes(method)) {
      throw new BridgeError(
        'UNKNOWN_METHOD',
        `desktop bridge: "${pluginName}" has no method "${method}".`,
      );
    }

    // Checked on this side too, not only in the renderer. The renderer's guard
    // catches the common case with a better message; this one is what makes
    // the rule true regardless of who is calling.
    assertCloneable(args, `${pluginName}.${method}(arguments)`);

    const implementation = registration.implementation[method];
    /* c8 ignore next */
    if (implementation === undefined) throw new BridgeError('UNKNOWN_METHOD', 'unreachable');
    // The sender id goes in FRONT of the renderer's arguments, never appended:
    // appending would make it depend on how many arguments the renderer chose
    // to send, and the renderer chooses that.
    const scoped = registration.implementation[SENDER_SCOPED]?.includes(method) ?? false;
    const result = await implementation.apply(
      registration.implementation,
      scoped ? [senderId, ...args] : [...args],
    );
    assertCloneable(result, `${pluginName}.${method}() result`);
    return result;
  }

  /**
   * Subscribe one renderer to one event.
   *
   * The subscription id is chosen by the renderer and is only unique WITHIN
   * that renderer, so it is namespaced by sender here. A reloaded page that
   * restarts its counter at 1 therefore overwrites its own stale entries
   * rather than shadowing another window's.
   */
  addListener(
    senderId: number,
    pluginName: string,
    eventName: string,
    subscriptionId: number,
  ): void {
    const registration = this.#plugins.get(pluginName);
    if (registration === undefined) {
      throw new BridgeError('UNKNOWN_PLUGIN', `desktop bridge: no plugin named "${pluginName}".`);
    }
    if (!registration.definition.events.includes(eventName)) {
      throw new BridgeError(
        'UNKNOWN_EVENT',
        `desktop bridge: "${pluginName}" emits no event "${eventName}". ` +
          `It emits: ${registration.definition.events.join(', ') || '(none)'}.`,
      );
    }
    this.#subscriptions.set(`${senderId}:${subscriptionId}`, {
      senderId,
      pluginName,
      eventName,
      subscriptionId,
    });
  }

  /** Drop one subscription. Removing one that is already gone is a no-op. */
  removeListener(senderId: number, subscriptionId: number): void {
    this.#subscriptions.delete(`${senderId}:${subscriptionId}`);
  }

  /**
   * Drop every subscription this renderer holds, optionally for one plugin.
   *
   * The contract's `removeAllListeners()` takes no arguments and means "all of
   * mine, for this plugin". The plugin-less form exists for sender teardown.
   */
  removeAllListeners(senderId: number, pluginName?: string): void {
    for (const [key, subscription] of this.#subscriptions) {
      if (subscription.senderId !== senderId) continue;
      if (pluginName !== undefined && subscription.pluginName !== pluginName) continue;
      this.#subscriptions.delete(key);
    }
  }

  /**
   * Forget a renderer entirely.
   *
   * Called on destroy AND on navigation. `@capawesome/capacitor-electron` only
   * cleans up on destroy, and a reload does not destroy a webContents — so its
   * subscription table grows by one page's worth on every Cmd+R, each entry
   * still counted as a delivery target. Doing it on navigation too is the
   * difference between a bounded table and a leak.
   */
  releaseSender(senderId: number): void {
    this.removeAllListeners(senderId);
  }

  /**
   * Deliver one event to the renderers listening for it.
   *
   * `ownerId` is what makes a stream private. Without it, every `llamaToken` of
   * every window's conversation was delivered to every other window that had
   * ever subscribed — one page's answer appearing, token by token, in another
   * page's turn. Events that genuinely belong to nobody in particular
   * (`llamaThermal` describes the machine, not a conversation) omit it and are
   * broadcast, which is the correct behaviour for them and is why this is a
   * parameter rather than a rule.
   *
   * @param ownerId deliver only to this renderer; omit to broadcast.
   * @returns how many subscriptions it actually reached.
   * @throws NotCloneableError if the payload would not survive the boundary.
   *   Deliberately not swallowed: an event that silently loses half its
   *   payload is the failure this whole file is trying to make impossible.
   */
  notifyListeners(
    pluginName: string,
    eventName: string,
    data: unknown,
    ownerId?: number,
  ): number {
    assertCloneable(data, `${pluginName}.${eventName} event`);
    let delivered = 0;
    for (const [key, subscription] of this.#subscriptions) {
      if (subscription.pluginName !== pluginName || subscription.eventName !== eventName) continue;
      // Checked BEFORE delivery is attempted, so a foreign subscription is
      // skipped rather than probed — a non-owner must not even be able to tell
      // that an event happened by having its delivery callback invoked.
      if (ownerId !== undefined && subscription.senderId !== ownerId) continue;
      const reached = this.#deliver(subscription.senderId, {
        pluginName,
        subscriptionId: subscription.subscriptionId,
        eventName,
        data,
      });
      if (reached) delivered += 1;
      // A renderer that refuses delivery is gone. Pruning here is what keeps
      // the table bounded when a window dies without a destroy notification.
      else this.#subscriptions.delete(key);
    }
    return delivered;
  }

  /** Live subscription count. Exists so a test can assert absence, not presence. */
  subscriptionCount(): number {
    return this.#subscriptions.size;
  }
}
