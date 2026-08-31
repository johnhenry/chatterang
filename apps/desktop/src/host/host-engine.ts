/**
 * Which engine an inference host is, and what mounting one takes.
 *
 * DELIBERATELY IMPORTS NEITHER ENGINE, not even for a type. `onnx-engine.ts`
 * and `llama-engine.ts` both need this shape, and if it lived in one of them
 * the other would have a static import edge to it — and `import type` is not
 * a defence, because the guard that matters here is a source-level import
 * graph, and the next author to need a value rather than a type would simply
 * drop the `type` keyword. A shared type lives where neither side can drag the
 * other in.
 *
 * ONE bundled entry point (`build/host.mjs`), forked twice with different
 * arguments. This module is the argument, and it is its own file for the
 * reason its two siblings are: `entry.ts` runs `main()` at module scope and
 * calls `process.exit(1)`, so importing it from a test takes the runner down,
 * and a selector parsed inline there would be unreachable by any assertion.
 *
 * NO DEFAULT, deliberately, and the same argument as `modelRoot`'s: a host
 * that cannot tell which engine it is would guess, and a guess that lands on
 * `llama` gives every ONNX host a node-llama-cpp import — which is the exact
 * thing the split exists to prevent, arriving silently and looking like it
 * worked. A wiring mistake has to be a boot failure.
 */

import type { HostRuntime } from '../bridge/host-runtime.js';

/** The engines that can be served, one process each. */
export const HOST_ENGINE_NAMES = Object.freeze(['llama', 'onnx'] as const);

export type HostEngineName = (typeof HOST_ENGINE_NAMES)[number];

/**
 * Read the engine selector out of a host process's `argv`.
 *
 * `argv[2]` is the model root and `argv[3]` is this, matching the order
 * `main.ts` forks with.
 *
 * @throws Error naming what was passed and what is accepted.
 */
export function parseEngineName(argv: readonly string[]): HostEngineName {
  const value = argv[3];
  if (value === undefined || value === '') {
    throw new Error(
      'inference host: no engine was named. main.ts must fork this entry point with the ' +
        `model root as its first argument and one of ${HOST_ENGINE_NAMES.join(', ')} as its ` +
        'second. A host that guesses which engine it is loads the wrong native addon.',
    );
  }
  if (!(HOST_ENGINE_NAMES as readonly string[]).includes(value)) {
    throw new Error(
      `inference host: "${value}" is not an engine this build serves. It serves: ` +
        `${HOST_ENGINE_NAMES.join(', ')}.`,
    );
  }
  return value as HostEngineName;
}

/** What either engine's mount function is handed. */
export interface MountEngineOptions {
  readonly runtime: HostRuntime;
  /** The directory every model path is confined to, as main told us. */
  readonly modelRoot: string;
  /** Where anomalies go. Never a prompt, never generated text. */
  readonly warn: (message: string) => void;
}
