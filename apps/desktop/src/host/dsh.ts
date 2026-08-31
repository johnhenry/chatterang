/**
 * The caller milestone A4 lacked.
 *
 * `packages/cordis-aimatey` has worked and been tested since A4, but nothing
 * mounted it. This file mounts it: it builds a Cordis tree by hand, applies the
 * narrowed profile, and — critically — ASSERTS the result, because a Cordis
 * tree that failed to come up looks exactly like one that did.
 *
 * WHERE THIS RUNS, AND WHY NOT IN MAIN. The task asked for DSH in the Electron
 * main process. The gates point somewhere else and this follows them, so it is
 * said plainly: **this is mounted in the inference utility process, not in
 * main.** The reason is not DSH — the eight installed `@deepseek-ai/*`
 * packages are pure JS, no koffi, no node-pty, and would be perfectly happy in
 * main. The reason is what DSH has to sit next to. The `llm` adapter this tree
 * registers routes through aimatey into `LlamaCppNode`, which calls a native
 * addon; a malformed GGUF or a VRAM OOM inside that addon can abort its
 * process. In main that is the entire app — every window, no error, and no
 * terminal event even conceivable because there is nobody left to send one. In
 * the utility process it is a recoverable turn failure the supervisor converts
 * into exactly one `llamaEnd`. Splitting DSH from the adapter it exists to
 * serve would buy nothing and cost a third boundary.
 *
 * `runProfile()` is NEVER called, and could not be: `@deepseek-ai/dsh` is not
 * installed. It writes to the profile dir on boot, installs SIGTERM/SIGINT
 * handlers, and installs an `unhandledRejection` handler that calls
 * `process.exit(1)` — which in a long-lived desktop process is an app that
 * dies on any stray rejection.
 */

import { Context } from '@deepseek-ai/cordis';
import type { Plugin } from '@deepseek-ai/cordis';
import InvariantRegistry from '@deepseek-ai/dsh-invariants';
import LlmRuntime from '@deepseek-ai/dsh-llm';
import * as llmInvariant from '@deepseek-ai/dsh-llm/invariant';

import {
  PROFILE_ROWS,
  aimateyRouterPlugin,
  applyProfile,
  assertBoot,
  routesFor,
} from '@chatterang/cordis-aimatey';
import type { AimateyRouter, ProfileRow } from '@chatterang/cordis-aimatey';

import type { DshStatus } from '../bridge/protocol.js';

export interface MountDshOptions {
  /** The live Router the tree exposes as an LLM provider. */
  readonly router: AimateyRouter;
  /**
   * Rows to mount. Defaults to the whole narrowed profile.
   *
   * Overridable so a test can inject the absence the assertion exists to
   * catch: drop the `llm` row and `assertBoot` must throw. Without that
   * injection the assertion is decorative — an unsatisfied Cordis `inject`
   * parks its fiber PENDING and `await fiber` RESOLVES, so a boot with a
   * missing row is green.
   */
  readonly rows?: readonly ProfileRow[];
  /** Where the mount reports non-fatal notes. */
  readonly warn?: (message: string) => void;
}

export interface DshMount {
  readonly ctx: Context;
  readonly status: DshStatus;
  /** Provider routes registered on the `llm` service right now. */
  listProviders(): string[];
}

/** Row name -> the plugin to mount for it, on this target. */
function profileModules(router: AimateyRouter): Map<string, Plugin> {
  return new Map<string, Plugin>([
    // dsh-llm IS the `llm` service — an adapter registry — not a DeepSeek
    // provider. The provider code lives in dsh-llm-deepseek, which this target
    // deliberately excludes.
    ['@deepseek-ai/dsh-llm', LlmRuntime as unknown as Plugin],
    ['@deepseek-ai/dsh-invariants', InvariantRegistry as unknown as Plugin],
    ['@deepseek-ai/dsh-llm/invariant', llmInvariant as unknown as Plugin],
    [
      '@chatterang/cordis-aimatey',
      // The row carries no config, so the router is closed over here rather
      // than travelling through the profile as data. It is a live object; it
      // could not be profile data even if the row had a slot for it.
      {
        ...aimateyRouterPlugin,
        apply: (inner: Context) => aimateyRouterPlugin.apply(inner, { router }),
      },
    ],
  ]);
}

/**
 * Build the tree, mount the profile, and assert it actually came up.
 *
 * A failed assertion is REPORTED, not thrown. llama.cpp inference must keep
 * working when the DSH tree does not — the desktop shell's first job is to run
 * a model — so the failure surfaces through `DshHost.getStatus()` where a
 * human can see it, rather than taking the app down or being swallowed.
 *
 * @param options - the router to expose, and optionally a narrowed row set.
 * @returns the context, the status, and a live provider listing.
 */
export async function mountDsh(options: MountDshOptions): Promise<DshMount> {
  const { router } = options;
  const rows = options.rows ?? PROFILE_ROWS;
  const warn = options.warn ?? ((): void => undefined);

  const ctx = new Context();
  await applyProfile(ctx, profileModules(router), rows);
  // Fibers parked waiting on a service activate on a macrotask once it
  // appears. Asserting before that runs would fail a tree that is fine.
  await new Promise((done) => setTimeout(done, 0));

  const listProviders = (): string[] => {
    const llm = ctx.get('llm') as { listProviders(): { id: string }[] } | undefined;
    return llm === undefined ? [] : llm.listProviders().map((provider) => provider.id);
  };

  try {
    const report = assertBoot(ctx, {
      services: ['llm', 'invariants'],
      routes: routesFor(router, warn),
    });
    return {
      ctx,
      listProviders,
      status: {
        mounted: true,
        services: report.services,
        routes: report.routes,
        treeAssertion: report.treeAssertion,
      },
    };
  } catch (error) {
    return {
      ctx,
      listProviders,
      status: {
        mounted: false,
        services: [],
        routes: [],
        treeAssertion: 'not reached: the boot assertion failed first',
        error: error instanceof Error ? error.message : String(error),
      },
    };
  }
}
