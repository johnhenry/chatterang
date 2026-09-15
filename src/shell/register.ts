/**
 * Registers the `bash` tool.
 *
 * Kept out of `state/app.ts` deliberately. The shell reads every store, so a
 * store importing the shell back closes a cycle — `app -> shell/tool ->
 * shell/stores -> state/models -> app` — which TypeScript accepts and which
 * fails at runtime with "cannot access before initialization". Calling this
 * from the entry point sidesteps it: by then every module has initialised.
 */

import { toolRegistry } from '@/ai/tools/registry';
import { createBashTool } from '@/shell/tool';
import { useApp } from '@/state/app';

let registered = false;

export function registerShellTool(): void {
  if (registered) return;
  registered = true;

  // Everything the model asks to change stops at a sheet the user reads — and
  // the sheet goes when the turn is stopped, as the tool-output and MCP sheets
  // already do. Without the signal a Stop left it up, and a later yes ran it.
  toolRegistry.register(
    createBashTool({
      confirm: (action, signal) => useApp.getState().requestApproval(action, undefined, signal),
    }),
  );
}
