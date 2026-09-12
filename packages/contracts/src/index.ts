/**
 * The contracts every inference implementation satisfies.
 *
 * These are deliberately free of Capacitor, Node and DOM types. Three
 * implementations exist or are planned against them:
 *
 *   - the web shim, in `src/plugins/<name>/web.ts`
 *   - the native bridges, in `native/`
 *   - the Node backend, in `packages/inference-node` (in progress)
 *
 * They were extracted from the plugin `definitions.ts` files unchanged, except
 * that Capacitor's `PluginListenerHandle` became a locally declared
 * `ListenerHandle`. The point of the move is that a contract with three
 * implementations should not live inside one of them.
 */

export type * from './llama-cpp.js';
export type * from './mount-host.js';
export type * from './onnx-runtime.js';
export type * from './listener.js';
