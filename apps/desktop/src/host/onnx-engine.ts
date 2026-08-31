/**
 * The ONNX Runtime inference host, and nothing else.
 *
 * WHY THIS IS A SECOND PROCESS RATHER THAN A SECOND `serve()` LINE.
 * `InferenceSession.run` is a SYNCHRONOUS native call behind a `setImmediate`:
 * it holds the event loop of whatever process it runs in for its whole
 * duration. Measured in this repo, with llama.cpp streaming in the same
 * process: one real whisper-base encoder run at batch 32 blocked for 5506 ms,
 * and strictly inside that interval llama.cpp produced 0 tokens (about 73 lost
 * at the baseline rate of ~13 tok/s) and the host's own 100 ms heartbeat
 * ticked twice. The decode was frozen, not merely its event delivery.
 *
 * That is a stall. What made it a FAILURE is the supervisor: pings are
 * answered on the same loop, so a long enough run looks exactly like a wedged
 * host. With the shipped policy (`pingIntervalMs` 15 s, `pingTimeoutMs` 10 s)
 * an unbroken block of 11-25 s is condemned — measured at the supervisor level
 * against the real `DEFAULT_POLICY` — and condemnation kills the process,
 * which destroys llama.cpp's in-flight generation with a synthesised terminal
 * event and `HANDLE_LOST`. Reproduced end to end with the real GGUF, the real
 * whisper encoder and the ping scaled down: a real llama.cpp generation was
 * destroyed by an ONNX run in the same process.
 *
 * Whisper-base cannot currently reach that — `whisper.ts` runs one batch-1
 * encoder pass (~132 ms) per 30-second window and one decoder step per token,
 * returning to the loop between each, so the ping is always answered. The
 * exposure is per single `run()`, not per pipeline, and it becomes reachable
 * the moment one run exceeds the timeout. A diffusion UNet step is one
 * uninterruptible `run()`.
 *
 * Splitting the process is the only thing that severs the coupling. A worker
 * thread gives back the event loop and nothing else: `OnnxRuntimeNode.cancel`
 * sets a flag checked BETWEEN runs, so worker cancellation granularity is one
 * native run — identical to today — `Worker.terminate()` mid-run aborts the
 * whole process, and the main thread would keep answering pings on behalf of a
 * worker that is stuck forever, removing the only detector there is.
 *
 * NOTHING FROM `@chatterang/inference-node` MAY BE IMPORTED HERE, statically
 * or otherwise. See `llama-engine.ts` for the measurement; the short version
 * is that node-llama-cpp's SIGTERM listener is what stops a blocked host from
 * being preempted, and an ONNX-only host without it dies to SIGTERM mid-run in
 * 24 ms. `tests/desktop-host-split.test.ts` walks this file's static import
 * graph and fails if that ever changes.
 */

import { OnnxRuntimeNode } from '@chatterang/onnx-node';

import { ONNX_HOST_POLICY } from '../bridge/onnx-call-shape.js';
import { ONNX_PLUGIN } from '../bridge/protocol.js';
import type { MountEngineOptions } from './host-engine.js';
import { onnxPathGuard } from './onnx-paths.js';

/**
 * Serve ONNX Runtime on this host.
 *
 * No Cordis tree and no DSH boot report: the tree exists to serve the `llm`
 * adapter, which routes into llama.cpp, and it lives in that host.
 */
export function mountOnnxEngine(options: Omit<MountEngineOptions, 'warn'>): void {
  const { runtime, modelRoot } = options;
  runtime.serve(ONNX_PLUGIN, new OnnxRuntimeNode(), {
    ...ONNX_HOST_POLICY,
    guard: onnxPathGuard(modelRoot),
  });
}
