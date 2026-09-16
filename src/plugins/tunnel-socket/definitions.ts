/**
 * The contract lives in `@chatterang/contracts` (#295, refs #181, #256).
 *
 * Same reason as `llama-cpp/definitions.ts`, `mount-host/definitions.ts` and
 * `onnx-runtime/definitions.ts`: this contract has more than one
 * implementation — the web refusal beside this file, the iOS and Android
 * native bridges in `native/plugin-tunnel-socket/`, and the desktop's own
 * Node implementation registered through `apps/desktop/src/bridge/`. A
 * contract with several implementations should not live inside one of them.
 *
 * Re-exported here so the plugin registration below keeps its import local.
 */
export type * from '@chatterang/contracts/tunnel-socket';
