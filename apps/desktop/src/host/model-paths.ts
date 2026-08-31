/**
 * The model directory, and the rule that nothing is loaded from outside it.
 *
 * Its own module rather than part of `entry.ts` for a reason that has bitten
 * once already: `entry.ts` is an ENTRY POINT. It runs `main()` at module scope
 * and calls `process.exit(1)` when there is no parent port, so importing it
 * from a test takes the test runner down. Policy that needs testing cannot live
 * next to a side effect like that.
 *
 * This file may import `node:path` (through `security.ts`) because it runs in
 * the inference utility process, not in `bridge/`.
 */

import type { CallGuard } from '../bridge/host-runtime.js';
import { confineModelPath } from '../security.js';
import { confineRealPath } from './real-path.js';

/** Every `LoadOptions` field that names a file on disk. */
const PATH_FIELDS = ['modelPath', 'mmprojPath', 'draftModelPath'] as const;

/**
 * Confine every path `load` names to the app's model directory.
 *
 * DEFECT [8]: without this, `LlamaCpp.load` was an arbitrary-path filesystem
 * oracle. From the live page, `{modelPath:'/etc/hosts'}` came back with the
 * literal first bytes of that file quoted in the engine's error message. Three
 * fields, not one — `mmprojPath` and `draftModelPath` reach the same loader.
 *
 * The refusal message names the field and says the rule, and deliberately does
 * NOT echo the path back. Reflecting a caller-supplied path is a small thing,
 * but the caller here is a web page and the reflection would be one more piece
 * of the filesystem confirmed back to it.
 *
 * WHY IT IS BUILT HERE: `bridge/` may not import `node:path` (the layering
 * guard, and the reason the bridge is testable at all), and only this process
 * knows where the model directory is. The decision itself is
 * `security.ts:confineModelPath`, which is pure and tested.
 */
export function modelPathGuard(modelRoot: string): CallGuard {
  return (method, args) => {
    if (method !== 'load') return args;
    const options = args[0] as Record<string, unknown>;
    const confined: Record<string, unknown> = { ...options };
    for (const field of PATH_FIELDS) {
      const value = options[field];
      // Only `modelPath` is required; the other two are absent far more often
      // than they are present, and absent is not a violation.
      if (value === undefined) continue;
      const lexical = typeof value === 'string' ? confineModelPath(modelRoot, value) : null;
      // Then the filesystem's answer, not just the string's: a symlink inside
      // the model folder passes the lexical gate and opens whatever it points
      // at. See host/real-path.ts.
      const resolved = lexical === null ? null : confineRealPath(modelRoot, lexical);
      if (resolved === null) {
        throw new Error(
          `inference host: "${field}" must name a file inside the application's model folder. ` +
            'Models are loaded from app storage only.',
        );
      }
      confined[field] = resolved;
    }
    return [confined, ...args.slice(1)];
  };
}
