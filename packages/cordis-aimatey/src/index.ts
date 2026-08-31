/**
 * aimatey's Router, registered as a provider inside a DeepSeek Harness tree.
 *
 * The direction matters: this package imports aimatey, never the reverse, and
 * nothing under `src/` may import this one. DSH is Node-only and pulls native
 * addons (koffi, node-pty) that cannot load in a mobile webview at all —
 * `tests/layering.test.ts` enforces the seam.
 *
 * The shape below was proven against the real packages rather than inferred.
 * `@deepseek-ai/dsh-llm` *is* the `llm` service — an adapter registry — not a
 * DeepSeek provider; that code lives in `dsh-llm-deepseek`. Omitting the row
 * disables five others including `agent-loop`, and the failure is silent:
 * Cordis parks an unsatisfied `inject` as PENDING, so `await fiber` resolves
 * and boot reports green with the services simply absent. Hence `inject`
 * below, and hence the boot assertion this package still owes.
 */

export const PLUGIN_NAME = 'aimatey-router';

/** Services this plugin cannot run without. See the note above on silence. */
export const REQUIRED_SERVICES = ['llm'] as const;
