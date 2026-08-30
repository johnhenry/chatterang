/**
 * Moved to `@chatterang/contracts`.
 *
 * The contract has three implementations — the web shim beside this file, the
 * iOS/Android bridges in `native/`, and the Node backend in
 * `packages/inference-node`. A contract with three implementations should not
 * live inside one of them.
 *
 * Re-exported here so the shim and the plugin registration keep their imports.
 */
export type * from '@chatterang/contracts/llama-cpp';
