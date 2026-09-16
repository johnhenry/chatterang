/**
 * S4: the hidden worker's turn runner — the far side of `WorkerHost.run()`
 * (`apps/desktop/src/bridge/worker-host.ts`) and the piece #296 names as
 * "runs the turn on the desktop's engine".
 *
 * WHERE THIS RUNS. A separate, on-demand, invisible `BrowserWindow` that main
 * builds when a paired phone's turn needs to run (owner ruling on #7: "a turn
 * from a paired phone runs in a hidden worker window... not the user's own
 * window... not the llama utility host. Only a renderer has the engine,
 * tools, models and grants"). That window loads THIS SAME app bundle — the
 * one this file lives in — with `?peerTurnWorker=1` on the URL, so
 * `src/main.tsx` knows to start this module instead of doing nothing extra.
 * Everything else about the window's boot is the ordinary one: the same
 * `useApp.getState().initialize()` that builds the real `ChatterangEngine`
 * for the user's own turns builds it here too, with the same resolver, the
 * same connected providers, the same settings. That is the point of loading
 * the real bundle rather than inventing a second, narrower one: a phone's
 * turn runs on the exact engine instance a local turn would.
 *
 * WHAT THIS FILE DOES NOT DO. It does not run a tool loop. The wire's own
 * contract for `toolLoop: 'requester'` — the only value the real client ever
 * sends (`src/ai/backends/tunnel.ts`: "THE TOOL LOOP STAYS ON THIS PHONE") —
 * is "the host serves inference only, and its reply ends at the model's tool
 * calls" (`packages/tunnel/src/wire/index.ts`). So this calls
 * `engine.llama.executeStream()` directly: the same `LlamaCppBackendAdapter`
 * instance the full engine uses for actual model inference, without the tool
 * middleware wrapped around it in `ChatterangEngine#turn`. A model's tool
 * calls stream back as ordinary `tool_use` chunks, unexecuted, for the phone
 * to run and continue. Running the desktop's OWN tools for a phone's turn
 * (`toolLoop: 'host'`) is #170's open surface question and is refused before
 * a turn ever reaches this file — see `apps/desktop/src/bridge/peer-turns.ts`.
 * It also does not re-run the clearing gate (#145) or sanitise
 * `metadata.custom` (#141): that main-process handler does both before
 * handing a turn to the worker, so the body this file reads has already been
 * decided about.
 *
 * WHY THIS NEVER IMPORTS `@chatterang/desktop`. `tests/layering.test.ts`'s
 * shell-app guard bans that specifier from `src/` outright, by name, static
 * or dynamic — the mobile bundle must never be able to resolve
 * `createHostRuntime` or Electron, and a regex that only checked static
 * imports would miss a dynamic one carrying the same string. So the host-link
 * protocol (`HostRuntime`, `PEER_TURN_PLUGIN`) is served from
 * `apps/desktop/src/peer-turn-preload.ts` instead — a file that, unlike this
 * one, is never bundled for mobile — and this file talks to it across
 * `contextBridge` through one flat global, `window.__peerTurn`: `
 * registerRunner(...)`, called once this page's engine is ready, and `
 * emitFrame(...)`, called once per streamed chunk. See that preload's header
 * for the whole shape and why it stops at one level of nesting.
 */

import type { IRChatRequest, IRStreamChunk } from '@johnhenry/aimatey-types';
import { decodeFrame, encodeFrame, type TunnelFrame } from '@chatterang/tunnel/wire';
import { assertSendable } from '@chatterang/tunnel/stream';

import { useApp } from '@/state/app';
import type { ChatterangEngine } from '@/ai/engine';

/** The flat, `contextBridge`-safe surface `peer-turn-preload.ts` exposes. */
interface PeerTurnBridge {
  registerRunner(runner: {
    runPeerTurn(payload: { requestId: string; frame: Uint8Array }): Promise<{ requestId: string; frame: Uint8Array }>;
    cancelPeerTurn(payload: { requestId: string }): Promise<void>;
  }): void;
  emitFrame(requestId: string, frame: Uint8Array): void;
}

declare global {
  interface Window {
    __peerTurn?: PeerTurnBridge;
  }
}

/** Is this page loaded as a hidden peer-turn worker rather than a normal window? */
export function isPeerTurnWorker(search: string = window.location.search): boolean {
  return new URLSearchParams(search).get('peerTurnWorker') === '1';
}

/** The real engine, built the same way a local turn's is. Idempotent to call again. */
async function readyEngine(): Promise<ChatterangEngine> {
  await useApp.getState().initialize();
  const engine = useApp.getState().engine;
  if (engine === null) {
    throw new Error('peer-turn-worker: the app engine did not initialize.');
  }
  return engine;
}

function chunkFrame(turn: string, body: IRStreamChunk): TunnelFrame {
  return { v: 1, kind: 'chunk', turn, body };
}

/**
 * Run one decoded `turn` frame's request against the real engine's llama.cpp
 * adapter, calling `onChunk` with each ENCODED `chunk` frame as it streams,
 * and resolving with the encoded terminal chunk (the same bytes already
 * given to the last `onChunk` call for the terminal).
 *
 * Never rejects for a request failure or a cancellation: both become a
 * terminal `error` chunk, which — unlike `done` — carries no obligation to
 * assemble a `message` (#260's obligation exempts it), so a stream that
 * failed before or during assembling one still ends cleanly on the wire.
 * Only a frame this file cannot even read as a `turn` (a bug upstream of it,
 * since `apps/desktop/src/bridge/peer-turns.ts` re-encodes what it already
 * validated) rejects — there is no turn id to answer on.
 */
export async function runPeerTurn(
  encodedTurn: Uint8Array,
  signal: AbortSignal,
  onChunk: (encodedChunk: Uint8Array) => void,
): Promise<Uint8Array> {
  const decoded = decodeFrame(encodedTurn);
  if (decoded.kind !== 'turn') {
    throw new Error(`peer-turn-worker: expected a turn frame, got "${decoded.kind}".`);
  }
  const turnId = decoded.turn;
  const request = decoded.body as IRChatRequest;

  let sequence = 0;
  try {
    const engine = await readyEngine();
    for await (const chunk of engine.llama.executeStream(request, signal)) {
      sequence = chunk.sequence + 1;
      const frame = chunkFrame(turnId, chunk);
      if (chunk.type === 'done' || chunk.type === 'error') {
        // #260's obligation, checked here rather than trusted: a `done`
        // without `message` is refused (throws), landing in the catch below
        // as a clean `error` terminal instead of a stream nothing can verify.
        assertSendable(frame);
        const bytes = encodeFrame(frame);
        onChunk(bytes);
        return bytes;
      }
      onChunk(encodeFrame(frame));
    }
  } catch (error) {
    const code = signal.aborted ? 'CANCELLED' : 'PEER_TURN_FAILED';
    const message = signal.aborted
      ? 'The turn was cancelled.'
      : error instanceof Error
        ? error.message
        : 'The turn failed.';
    const bytes = encodeFrame(chunkFrame(turnId, { type: 'error', sequence, error: { code, message } }));
    onChunk(bytes);
    return bytes;
  }

  /*
   * The stream ended without a `done` or `error` chunk: never a `generate`
   * call, only when this is cancelled before it starts (a turn stopped while
   * still subscribing, `src/ai/backends/llama-cpp.ts`'s "STOPPED WHILE
   * SUBSCRIBING" branch — nothing is asked for, and nothing is yielded).
   * `CANCELLED` names that; anything else here is an adapter bug this file
   * did not throw for, and a phone should still not be left waiting on it.
   */
  const bytes = encodeFrame(
    chunkFrame(turnId, {
      type: 'error',
      sequence,
      error: signal.aborted
        ? { code: 'CANCELLED', message: 'The turn was cancelled before it started.' }
        : { code: 'PEER_TURN_FAILED', message: 'The turn ended without a result.' },
    }),
  );
  onChunk(bytes);
  return bytes;
}

/**
 * Register this page's runner with the preload, once. Resolves once
 * registered; runs until the page is torn down.
 */
export function startPeerTurnWorker(): void {
  const bridge = window.__peerTurn;
  if (bridge === undefined) {
    throw new Error('peer-turn-worker: window.__peerTurn is missing; the preload did not run.');
  }

  const controllers = new Map<string, AbortController>();

  bridge.registerRunner({
    runPeerTurn: async (payload) => {
      const controller = new AbortController();
      controllers.set(payload.requestId, controller);
      try {
        const frame = await runPeerTurn(payload.frame, controller.signal, (encodedChunk) => {
          bridge.emitFrame(payload.requestId, encodedChunk);
        });
        return { requestId: payload.requestId, frame };
      } finally {
        controllers.delete(payload.requestId);
      }
    },
    cancelPeerTurn: async (payload) => {
      controllers.get(payload.requestId)?.abort();
    },
  });
}
