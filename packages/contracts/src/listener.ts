/**
 * The handle returned by an `addListener` call.
 *
 * Declared here rather than imported from Capacitor so the contracts package
 * depends on none of its own implementations. It is structurally identical to
 * that framework's `PluginListenerHandle`, so the two are mutually assignable
 * and the Capacitor side needs no change — but a Node implementation no longer
 * has to install a mobile framework to describe an event subscription.
 */
export interface ListenerHandle {
  remove(): Promise<void>;
}
