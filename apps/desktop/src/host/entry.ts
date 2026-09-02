/**
 * The inference host: entry point of the utility process.
 *
 * ONE ENTRY POINT, TWO PROCESSES. `main.ts` forks this file twice — once with
 * `llama` and once with `onnx` — and each fork loads exactly one engine,
 * through the DYNAMIC import at the bottom of `main()`. Everything else here
 * (the parent port, the model root, the runtime, the ping) is identical in
 * both, which is why there is one file rather than two.
 *
 * WHY TWO PROCESSES, AND NOT ONE WITH BOTH ENGINES SERVED ON IT.
 * `InferenceSession.run` is a synchronous native call: it holds the event loop
 * of its process for its whole duration. In the single-host arrangement this
 * file used to build, one real whisper-base encoder run at batch 32 blocked
 * for 5506 ms and llama.cpp emitted ZERO tokens inside that interval — its
 * decode frozen, not merely its event delivery. Worse, the supervisor's ping
 * is answered on the same loop, so a long enough run is indistinguishable from
 * a wedged host: with the shipped policy an unbroken block of 11-25 s is
 * condemned, and condemnation kills the process, taking llama.cpp's in-flight
 * generation with it. That was reproduced end to end with the real GGUF and
 * the real whisper encoder.
 *
 * The plugin dimension already gave the two engines LOGICAL isolation —
 * separate in-flight tables, per-engine cancel, per-engine terminal events.
 * The shared process left them PHYSICALLY coupled. Two processes is what
 * severs it. See `onnx-engine.ts` for why a worker thread does not.
 *
 * Everything that touches a native addon lives on this side of the boundary,
 * because a native addon can abort the process it runs in and this is the
 * process we can afford to lose. The supervisor in main turns that loss into
 * exactly one terminal event per in-flight turn and one rejected promise — and
 * now into a loss of ONE engine rather than of both.
 *
 * Nothing here reads an API key, and nothing can. The Router mounted into the
 * Cordis tree is built in `llama-engine.ts` with exactly one backend — local
 * llama.cpp — and zero remote providers. Remote backends and the keys they
 * need stay in the renderer, where they already live. A key therefore has no
 * path into an IPC payload, a host log, or a crash dump on this side, because
 * nothing here ever holds one.
 */

import { createHostRuntime } from '../bridge/host-runtime.js';
import { parseEngineName } from './host-engine.js';
import { hostLink } from './host-link.js';

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

async function main(): Promise<void> {
  /*
   * WHO FORKED US — and it is now two possible answers, not one.
   *
   * Electron's `utilityProcess` sets `process.parentPort`; a headless
   * `child_process.fork` from `apps/server` sets `process.send`. `hostLink`
   * takes whichever is there, unwraps the two different message shapes
   * correctly, and REFUSES a process that has neither — which is still what
   * `node build/host.mjs …` gets, still at exit code 1.
   *
   * Nothing else in this file changed for the headless profile, and that is
   * the finding rather than the diff: the model root already arrives as
   * `argv[2]`, the engine name as `argv[3]`, and neither the runtime nor
   * either engine touches an Electron API.
   */
  const link = hostLink(process as unknown as Parameters<typeof hostLink>[0]);
  // Read BEFORE anything is loaded, so a bad selector is a boot failure rather
  // than a host that has already imported an addon it should not have.
  const engine = parseEngineName(process.argv);
  const root = modelRoot();

  // An orphan holds the GPU and the weights while nothing can reach it. On
  // Electron this never fires (main's death takes the utility process with
  // it); under a Node fork it is the only thing that stops a server crash from
  // leaving two inference hosts behind.
  link.onClose(() => {
    process.exit(0);
  });
  const warn = (message: string): void => console.warn(`[inference-host:${engine}] ${message}`);

  // ONE runtime, any number of plugins on it. Each host puts exactly one
  // plugin on its own, which is the point of the split; the runtime stays
  // generic because nothing about it is per-engine.
  const runtime = createHostRuntime({ link, warn });

  /*
   * DYNAMIC, and load-bearing rather than stylistic.
   *
   * A static `import { LlamaCppNode } from '@chatterang/inference-node'` at
   * the top of this file would run in BOTH processes, and importing
   * node-llama-cpp registers a SIGTERM listener that replaces the OS default
   * action with a JS callback — a callback that cannot run while a
   * synchronous native call holds the loop. The ONNX host would then survive
   * the supervisor's `kill()` until its blocking run returned, which is
   * exactly the preemption the split exists to restore. Measured: 24 ms to
   * exit without node-llama-cpp loaded, 1136 ms after the run completed with
   * it. Every measured benefit of the split except loop isolation disappears
   * if these become static imports, and nothing would fail — which is why
   * `tests/desktop-host-split.test.ts` walks the import graph.
   */
  if (engine === 'llama') {
    const { mountLlamaEngine } = await import('./llama-engine.js');
    const status = await mountLlamaEngine({ runtime, modelRoot: root, warn });
    link.postMessage({ k: 'boot', status });
    return;
  }

  const { mountOnnxEngine } = await import('./onnx-engine.js');
  mountOnnxEngine({ runtime, modelRoot: root });
}

void main().catch((error: unknown) => {
  console.error('[inference-host] failed to start:', error instanceof Error ? error.message : error);
  process.exit(1);
});
