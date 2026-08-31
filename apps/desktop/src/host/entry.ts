/**
 * The inference host: entry point of the utility process.
 *
 * Everything that touches a native addon lives on this side of the boundary —
 * `LlamaCppNode`, node-llama-cpp, the GGUF, the GPU — together with the Cordis
 * tree that consumes it. That is the whole point of the process: a native
 * addon can abort the process it runs in, and this is the process we can
 * afford to lose. The supervisor in main turns that loss into exactly one
 * `llamaEnd` per in-flight turn and one rejected `generate` promise.
 *
 * Nothing here reads an API key, and nothing can. The Router mounted into the
 * Cordis tree is built HERE with exactly one backend — local llama.cpp — and
 * zero remote providers. Remote backends and the keys they need stay in the
 * renderer, where they already live. A key therefore has no path into an IPC
 * payload, a host log, or a crash dump on this side, because nothing here ever
 * holds one.
 */

import { Router } from '@johnhenry/aimatey-core';

import { LlamaCppNode } from '@chatterang/inference-node';

import { LLAMA_HOST_POLICY } from '../bridge/call-shape.js';
import { createHostRuntime } from '../bridge/host-runtime.js';
import type { MessageLink } from '../bridge/protocol.js';
import { LLAMA_PLUGIN } from '../bridge/protocol.js';
import { mountDsh } from './dsh.js';
import { modelPathGuard } from './model-paths.js';
import { DesktopLlamaBackend } from './llama-backend.js';

/**
 * Where models live, as main told us.
 *
 * Passed as `argv[2]` by `main.ts` because only main can call
 * `app.getPath('userData')`. There is no fallback ON PURPOSE: a host that
 * cannot tell where the model directory is has no basis for confining anything
 * to it, and quietly picking a directory would be a confinement to the wrong
 * place — which reads as a working guard and is not one.
 */
function modelRoot(): string {
  const root = process.argv[2];
  if (root === undefined || root === '') {
    throw new Error(
      'inference host: no model directory was supplied. main.ts must fork this entry point ' +
        'with the model root as its first argument.',
    );
  }
  return root;
}

/** Electron's utility-process parent port, typed only as much as we use it. */
interface ParentPort {
  postMessage(message: unknown): void;
  on(event: 'message', listener: (event: { data: unknown }) => void): void;
}

function parentPortLink(port: ParentPort): MessageLink {
  return {
    postMessage: (message) => port.postMessage(message),
    onMessage: (listener) => port.on('message', (event) => listener(event.data)),
    // The parent port has no close event worth listening to: if main goes
    // away, this process is killed with it. `onClose` exists for the OTHER
    // end of this link, in the supervisor, which is where a death matters.
    onClose: () => undefined,
  };
}

async function main(): Promise<void> {
  const port = (process as unknown as { parentPort?: ParentPort }).parentPort;
  if (port === undefined) {
    throw new Error(
      'inference host: no parentPort. This entry point only runs inside an Electron utilityProcess.',
    );
  }
  const link = parentPortLink(port);
  const plugin = new LlamaCppNode();

  // ONE runtime, any number of plugins on it. Milestone A3's ONNX engine is a
  // second `runtime.serve(...)` line here with its own definition, its own
  // argument table and its own path guard — and nothing else, which is the
  // point of the generalisation.
  const runtime = createHostRuntime({
    link,
    warn: (message: string) => console.warn(`[inference-host] ${message}`),
  });

  // Serve the plugin FIRST. Inference must work even if the DSH mount below
  // fails; the tree is an additional consumer of this engine, not a
  // prerequisite for it.
  runtime.serve(LLAMA_PLUGIN, plugin, {
    ...LLAMA_HOST_POLICY,
    guard: modelPathGuard(modelRoot()),
  });

  const router = new Router({ routingStrategy: 'explicit', fallbackStrategy: 'none' });
  router.register('llama-cpp-desktop', new DesktopLlamaBackend({ plugin }));

  const mount = await mountDsh({
    router,
    warn: (message) => console.warn(`[inference-host] ${message}`),
  });
  link.postMessage({ k: 'boot', status: mount.status });
}

void main().catch((error: unknown) => {
  console.error('[inference-host] failed to start:', error instanceof Error ? error.message : error);
  process.exit(1);
});
