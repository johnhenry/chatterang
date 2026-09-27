/**
 * `Cli`'s Capacitor-facing contract (#42, #115, #116, #118).
 *
 * NOT re-exported from `@chatterang/contracts`, unlike every sibling in
 * `src/plugins/`. Those contracts have (or are meant to grow) more than one
 * real implementation on more than one platform; `Cli` has exactly one —
 * `apps/desktop/src/cli/cli-plugin.ts` — and #115's own ruling is desktop
 * only, so there is no second platform pulling this type toward a shared
 * package yet. Moving it there is a mechanical change to make WHEN a second
 * implementation exists, not before.
 *
 * Structurally mirrors `apps/desktop/src/bridge/protocol.ts`'s
 * `CliStartTurn`/`CliCancelTurn`/`CliDataEvent`/`CliExitEvent`/
 * `CliDiscoverRequest`/`CliDiscoverResult` — deliberately DUPLICATED rather
 * than imported: `tests/layering.test.ts`'s shell-app guard bans `src/` from
 * ever naming `@chatterang/desktop`, in any form.
 */

import type { PluginListenerHandle } from '@capacitor/core';

export interface CliDiscoverRequest {
  readonly cliId: string;
}

/** Mirrors `apps/desktop/src/bridge/cli-discovery.ts`'s `CliDiscovery` verbatim. */
export type CliDiscoverResult =
  | { readonly status: 'not-found'; readonly id: string }
  | { readonly status: 'not-executable'; readonly id: string; readonly path: string }
  | { readonly status: 'version-unreadable'; readonly id: string; readonly path: string }
  | { readonly status: 'not-signed-in'; readonly id: string; readonly path: string; readonly version: string }
  | { readonly status: 'found'; readonly id: string; readonly path: string; readonly version: string };

export interface CliStartTurnRequest {
  readonly requestId: string;
  readonly cliId: string;
  readonly stdin?: string;
  readonly systemPrompt?: string;
}

export interface CliCancelTurnRequest {
  readonly requestId: string;
}

export interface CliDataEvent {
  readonly requestId: string;
  readonly chunk: Uint8Array;
  readonly stream: 'stdout' | 'stderr';
}

export interface CliExitEvent {
  readonly requestId: string;
  readonly code: number | null;
  readonly signal: string | null;
}

export interface CliPlugin {
  /** #116: explicit add, never ambient. */
  discover(request: CliDiscoverRequest): Promise<CliDiscoverResult>;
  startTurn(request: CliStartTurnRequest): Promise<{ readonly requestId: string }>;
  cancelTurn(request: CliCancelTurnRequest): Promise<void>;
  addListener(eventName: 'cliData', listener: (event: CliDataEvent) => void): Promise<PluginListenerHandle>;
  addListener(eventName: 'cliExit', listener: (event: CliExitEvent) => void): Promise<PluginListenerHandle>;
}
