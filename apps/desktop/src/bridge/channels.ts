/**
 * Every IPC channel name the renderer can reach, and the proof that the set is
 * closed.
 *
 * The rule this file exists to enforce: **a page-supplied string never becomes
 * a channel name.** The renderer bridge derives its channels from the boot
 * manifest and refuses anything else; a plugin name or method name it has not
 * been told about is rejected before a channel string is built at all.
 *
 * The naming scheme is also deliberately segmented rather than flat.
 * `@capawesome/capacitor-electron` builds method channels as
 * `capacitor:<plugin>:<method>` and its listener channel as
 * `capacitor:<plugin>:addListener` — the same string when a plugin declares a
 * method called `addListener`, which registers two handlers on one channel and
 * throws at boot. Here every method channel starts `chatterang:call:` and every
 * listener channel starts `chatterang:listener:`, so the two namespaces are
 * disjoint by construction whatever a plugin declares. `tests/desktop-bridge.
 * test.ts` asserts that with a plugin whose methods are literally named
 * `addListener` and `removeAllListeners`.
 */

import type { BootManifest, PluginDefinition } from './protocol.js';

/** Renderer -> main, once, at preload time. Answers with the boot manifest. */
export const BOOTSTRAP_CHANNEL = 'chatterang:bootstrap';

/** Main -> renderer. Carries every plugin event. */
export const EVENT_CHANNEL = 'chatterang:event';

/**
 * Main -> renderer. Carries a menu accelerator's command id, and nothing else.
 *
 * INBOUND ONLY, like `EVENT_CHANNEL`, and for a sharper reason. This is the
 * external door into the app's command dispatcher, so a renderer that could
 * SEND on it would be able to drive the app from the page — which is precisely
 * the property the main-world `__chatterangCommand` global had and the reason
 * it was removed. `allowedChannels` therefore omits it, and the preload
 * exposes only a subscription: the page can ask to be told, never to tell.
 */
export const COMMAND_CHANNEL = 'chatterang:command';

/** Renderer -> main. Subscription lifecycle, plugin named in the payload. */
export const LISTENER_ADD_CHANNEL = 'chatterang:listener:add';
export const LISTENER_REMOVE_CHANNEL = 'chatterang:listener:remove';
export const LISTENER_REMOVE_ALL_CHANNEL = 'chatterang:listener:remove-all';

/** The channel one plugin method is invoked on. */
export function methodChannel(plugin: string, method: string): string {
  return `chatterang:call:${plugin}:${method}`;
}

/**
 * Every channel a renderer may legitimately name, given this manifest.
 *
 * `EVENT_CHANNEL` and `COMMAND_CHANNEL` are not in the set: both are inbound
 * only, and a renderer has no business sending on either.
 */
export function allowedChannels(manifest: BootManifest): ReadonlySet<string> {
  const channels = new Set<string>([
    BOOTSTRAP_CHANNEL,
    LISTENER_ADD_CHANNEL,
    LISTENER_REMOVE_CHANNEL,
    LISTENER_REMOVE_ALL_CHANNEL,
  ]);
  for (const plugin of manifest.plugins) {
    for (const method of plugin.methods) channels.add(methodChannel(plugin.name, method));
  }
  return channels;
}

/**
 * Channel names that collide, given this manifest.
 *
 * Empty is the only acceptable answer. `PluginHost` calls this at registration
 * so a collision is a loud startup failure rather than a listener that
 * silently stops working — the failure mode a flat namespace produces when the
 * runtime replaces a handler instead of throwing.
 */
export function channelCollisions(plugins: readonly PluginDefinition[]): string[] {
  const seen = new Set<string>([
    BOOTSTRAP_CHANNEL,
    EVENT_CHANNEL,
    COMMAND_CHANNEL,
    LISTENER_ADD_CHANNEL,
    LISTENER_REMOVE_CHANNEL,
    LISTENER_REMOVE_ALL_CHANNEL,
  ]);
  const collisions: string[] = [];
  for (const plugin of plugins) {
    for (const method of plugin.methods) {
      const channel = methodChannel(plugin.name, method);
      if (seen.has(channel)) collisions.push(channel);
      seen.add(channel);
    }
  }
  return collisions;
}
