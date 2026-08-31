/**
 * The llama.cpp inference host, and everything only it may load.
 *
 * ITS OWN MODULE BECAUSE IT IS ITS OWN PROCESS. `entry.ts` reaches this file
 * through a DYNAMIC import chosen by `argv[3]`, which is what keeps
 * node-llama-cpp — and the Cordis tree, and the eight `@deepseek-ai/*`
 * packages — out of the ONNX host's address space entirely. That is not
 * tidiness. Importing node-llama-cpp registers a SIGTERM and a SIGINT listener
 * on the process, and a JS signal listener REPLACES the OS default action: it
 * cannot run while a synchronous native call holds the loop, so a host that
 * has loaded it survives `kill()` until that call returns. Measured, same
 * child, SIGTERM one second into a two-second ONNX run: onnxruntime alone
 * exited after 24 ms; onnxruntime with node-llama-cpp imported completed the
 * whole 2112 ms run and exited 1136 ms after the signal. Electron's
 * `utilityProcess.kill()` is SIGTERM with no signal parameter.
 *
 * So an ONNX-only host can actually be preempted mid-run and this one cannot,
 * and the difference is exactly this import. `tests/desktop-host-split.test.ts`
 * walks the static import graph of `onnx-engine.ts` and fails if
 * node-llama-cpp ever reappears in it, because the way this guarantee gets
 * lost is one `import` added for convenience with the whole suite green.
 *
 * THE DSH TREE MOUNTS HERE, and only here. It exists to serve the `llm`
 * adapter, which routes into `LlamaCppNode`; mounting it beside an engine it
 * has no route to would cost a second Cordis tree and buy nothing.
 */

import { Router } from '@johnhenry/aimatey-core';

import { LlamaCppNode } from '@chatterang/inference-node';

import { LLAMA_HOST_POLICY } from '../bridge/call-shape.js';
import type { DshStatus } from '../bridge/protocol.js';
import { LLAMA_PLUGIN } from '../bridge/protocol.js';
import { mountDsh } from './dsh.js';
import type { MountEngineOptions } from './host-engine.js';
import { modelPathGuard } from './model-paths.js';
import { DesktopLlamaBackend } from './llama-backend.js';

/**
 * Serve llama.cpp on this host, then mount the Cordis tree over it.
 *
 * The plugin is served FIRST. Inference must work even if the mount below
 * fails; the tree is an additional consumer of the engine, not a prerequisite
 * for it.
 *
 * @returns the DSH boot report, for `entry.ts` to post to main.
 */
export async function mountLlamaEngine(options: MountEngineOptions): Promise<DshStatus> {
  const { runtime, modelRoot, warn } = options;
  const plugin = new LlamaCppNode();

  runtime.serve(LLAMA_PLUGIN, plugin, {
    ...LLAMA_HOST_POLICY,
    guard: modelPathGuard(modelRoot),
  });

  const router = new Router({ routingStrategy: 'explicit', fallbackStrategy: 'none' });
  router.register('llama-cpp-desktop', new DesktopLlamaBackend({ plugin }));

  const mount = await mountDsh({ router, warn });
  return mount.status;
}
