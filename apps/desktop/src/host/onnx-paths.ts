/**
 * The model directory, and the rule that no ONNX graph is loaded from outside it.
 *
 * DEFECT [8], REOPENED UNDER A NEW METHOD NAME. `model-paths.ts` confines
 * `LlamaCpp.load`'s three path fields; `OnnxRuntime.createSession` is the ONNX
 * method that opens caller-named files, and without this it is the same
 * arbitrary-path filesystem oracle: `{modelPath:'/etc/hosts'}` reaches
 * onnxruntime's loader, and its failure message quotes what it found.
 *
 * ITS OWN MODULE, and not part of `entry.ts`, for the reason recorded in its
 * sibling: `entry.ts` is an entry point that runs `main()` at module scope and
 * calls `process.exit(1)`, so importing it from a test takes the runner down.
 *
 * WHY IT IS NOT A COPY OF `modelPathGuard`. `OnnxSessionOptions` does not have
 * a fixed list of path fields. It has ONE (`modelPath`) plus `companions`, a
 * `Record<string, string>` whose keys are role names — `encoder`, `decoder`,
 * `tokenizer`, `vocoder`, `vae` — that this code does not and should not
 * enumerate. Every value in that record is a path the loader will open, so
 * every value is confined, whatever it is called. A fixed-field guard would
 * have confined `modelPath` and waved the companions through, which is the
 * more useful half of the oracle.
 */

import type { CallGuard } from '../bridge/host-runtime.js';
import { confineModelPath } from '../security.js';

/**
 * Confine `modelPath` and every companion to the app's model directory.
 *
 * The refusal names the field and states the rule, and deliberately does NOT
 * echo the path back. Reflecting a caller-supplied path is a small thing, but
 * the caller here is a web page and the reflection would be one more piece of
 * the filesystem confirmed back to it.
 *
 * `modelPath` may be a DIRECTORY — a Whisper pipeline is a folder of files —
 * and `confineModelPath` allows that: it requires the result to be strictly
 * inside the root, which a subdirectory is.
 */
export function onnxPathGuard(modelRoot: string): CallGuard {
  return (method, args) => {
    if (method !== 'createSession') return args;
    const options = args[0] as Record<string, unknown>;

    const modelPath = options['modelPath'];
    const resolved =
      typeof modelPath === 'string' ? confineModelPath(modelRoot, modelPath) : null;
    if (resolved === null) {
      throw new Error(
        'inference host: "modelPath" must name a file or folder inside the application\'s ' +
          'model folder. Models are loaded from app storage only.',
      );
    }

    const confined: Record<string, unknown> = { ...options, modelPath: resolved };

    const companions = options['companions'];
    if (companions !== undefined) {
      if (typeof companions !== 'object' || companions === null || Array.isArray(companions)) {
        throw new Error(
          'inference host: "companions" must be an object of role -> path, if it is present.',
        );
      }
      const safe: Record<string, string> = {};
      for (const [role, value] of Object.entries(companions as Record<string, unknown>)) {
        const path = typeof value === 'string' ? confineModelPath(modelRoot, value) : null;
        if (path === null) {
          throw new Error(
            `inference host: the "${role}" companion must name a file inside the application's ` +
              'model folder. Models are loaded from app storage only.',
          );
        }
        safe[role] = path;
      }
      confined['companions'] = safe;
    }

    return [confined, ...args.slice(1)];
  };
}
