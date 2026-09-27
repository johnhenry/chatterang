/**
 * `CliTurnBridge`, OVER THE REAL `Cli` PLUGIN (#42, #115, #118).
 *
 * `src/ai/backends/cli.ts`'s `CliBackendAdapter` is driven by an injected
 * `CliTurnBridge` and spawns nothing itself — this file is the ONE real
 * implementation of that interface, built over `src/plugins/cli`'s
 * registered Capacitor plugin, the same generic `registerPlugin`/
 * `addListener` surface every other plugin in `src/` uses (`LlamaCpp`,
 * `TunnelSocket`, ...). No bespoke `window` global, no import of
 * `@chatterang/desktop` — the layering guard bans the latter outright, and
 * the former is unnecessary: `Cli`'s events already reach here through the
 * SAME manifest-driven channel every other plugin's do.
 *
 * WHY `start()` STAYS SYNCHRONOUS OVER AN ASYNC PLUGIN. `CliTurnBridge.start`
 * returns a handle immediately (`cli.ts`'s executeStream calls
 * `handle.onData(...)`/`handle.onExit(...)` right after, with no `await`
 * between); `Cli.addListener`/`Cli.startTurn` are Capacitor calls and are
 * always async — a same-process function call that only ever resolves after
 * at least one microtask. Subscribing BEFORE calling `startTurn` (both
 * awaited, in order, inside a detached promise chain started from `start()`)
 * is therefore race-free: nothing the plugin emits can arrive before this
 * file's own synchronous return has already stored the caller's listeners in
 * a closure.
 */

import type { CliBridgeExit, CliBridgeHandle, CliTurnBridge } from './cli';
import type { CliDataEvent, CliExitEvent, CliPlugin } from '@/plugins/cli';

function freshRequestId(cliId: string): string {
  return `${cliId}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Build a `CliTurnBridge` over a `CliPlugin` — the real registered one in production, a fake in tests. */
export function createCliTurnBridge(plugin: CliPlugin): CliTurnBridge {
  return {
    start(options) {
      const requestId = freshRequestId(options.cliId);
      let dataListener: ((chunk: Uint8Array, stream: 'stdout' | 'stderr') => void) | undefined;
      let exitListener: ((exit: CliBridgeExit) => void) | undefined;
      let cancelled = false;

      const subscriptions = Promise.all([
        plugin.addListener('cliData', (event: CliDataEvent) => {
          if (event.requestId !== requestId) return;
          dataListener?.(event.chunk, event.stream);
        }),
        plugin.addListener('cliExit', (event: CliExitEvent) => {
          if (event.requestId !== requestId) return;
          exitListener?.({ code: event.code, signal: event.signal });
        }),
      ]);

      void subscriptions
        .then(() => {
          // Cancelled before the subscriptions this needs even finished --
          // never start a turn nobody can hear the end of.
          if (cancelled) return undefined;
          return plugin.startTurn({
            requestId,
            cliId: options.cliId,
            stdin: options.stdin,
            systemPrompt: options.systemPrompt,
          });
        })
        .catch(() => {
          // A discovery refusal, a spawn failure reported as a rejection --
          // either way, the turn has one end and this is it.
          exitListener?.({ code: null, signal: null });
        });

      const handle: CliBridgeHandle = {
        onData(listener) {
          dataListener = listener;
        },
        onExit(listener) {
          exitListener = listener;
        },
        cancel() {
          cancelled = true;
          void plugin.cancelTurn({ requestId }).catch(() => undefined);
          void subscriptions.then(([dataHandle, exitHandle]) => {
            void dataHandle.remove();
            void exitHandle.remove();
          });
        },
      };
      return handle;
    },
  };
}
