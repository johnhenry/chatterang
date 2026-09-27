/**
 * SPAWNING A LOCAL AGENT CLI (#42, #113, #115).
 *
 * The thing #42 is the admission price for: `claude`/`codex`/`gemini` are a
 * subprocess on THIS device that makes a network call to a vendor. Everything
 * in this file exists to keep that subprocess honest.
 *
 * EVERY SIDE EFFECT IS INJECTED, THE SAME WAY `cli-discovery.ts` IS. No
 * `node:child_process`, no `node:path`, no `process.kill` in this file —
 * `tests/layering.test.ts`'s "the desktop bridge stays platform-free" guard
 * bans a Node builtin from anything under `apps/desktop/src/bridge/`
 * directly, precisely so that directory stays testable without launching
 * Electron (`bridge/index.ts`'s own header says so). The real
 * `node:child_process`/`node:path` calls this needs live in
 * `apps/desktop/src/main.ts` (or a sibling that constructs
 * {@link CliSpawnDeps} once), the same seam `preload.ts` is for `electron`.
 *
 * FOUR GUARANTEES, each with the ruling that demands it:
 *
 *   - SPAWNED BY ABSOLUTE PATH ONLY (#116). `discoverCli` resolves one before
 *     this is ever called; `spawnCliTurn` refuses a relative path outright
 *     rather than falling back to shell `PATH` resolution, which is the exact
 *     ambient-environment failure #116 exists to avoid.
 *   - AN ENV ALLOWLIST, NOT THE PARENT ENVIRONMENT (#113). `buildCliEnv`
 *     starts from nothing and adds back only `PATH`, `HOME`, and whatever a
 *     caller names as "what this CLI needs to find its own login" — never a
 *     spread of `process.env`, which would hand every API key this Electron
 *     process happens to have loaded to a subprocess that reaches a vendor.
 *   - CWD CONFINEMENT (#115). `confineCwd` resolves the requested working
 *     directory against a root the caller names and refuses anything that
 *     would land outside it, the same shape as `confineModelPath` elsewhere
 *     in this app (`apps/server/src/surface.ts`'s doc references it) —
 *     through `deps.resolvePath`/`deps.relativePath`/`deps.isAbsolutePath`
 *     rather than `node:path` directly.
 *   - CANCEL KILLS THE PROCESS GROUP, NOT JUST THE IMMEDIATE CHILD (#115). All
 *     three CLIs are themselves capable of spawning further processes — a
 *     shell command, for `claude` and `codex`. `buildCliTurnArgv`
 *     (`cli-specs.ts`) gives `claude` a turn argv with no tools declared at
 *     all (`--tools ""`), so nothing is there to spawn one; `codex`'s own
 *     `--help` documents no flag that removes its shell-command tool, only
 *     a filesystem sandbox policy on what a command it does run may write —
 *     see `cli-specs.ts`'s `CODEX_TURN_ARGV` doc for exactly what that does
 *     and does not close. Either way, `cancel()` has to reach the whole
 *     process tree, not assume there is only one process in it. The real
 *     `deps.spawn` is expected to pass `detached: true` (its own POSIX
 *     process group, pgid === pid), and `cancel()` calls
 *     `deps.killProcessGroup`, whose real implementation signals `-pid`:
 *     the whole group, not one process in it.
 *
 * NOT HERE, DELIBERATELY: turning IR chunks. That is
 * `src/ai/backends/cli-stream.ts`'s job, and it runs in the RENDERER, not
 * here — `tests/layering.test.ts`'s shell-app guard separately bans `src/`
 * from ever importing `@chatterang/desktop` in any form, so this file
 * couldn't hand the translators anything even if it wanted to. What crosses
 * the boundary is raw stdout bytes (`onData`) and one exit description
 * (`onExit`); the renderer-side adapter (`src/ai/backends/cli.ts`) does the
 * decoding and translating on its own side, the same way
 * `apps/desktop/src/peer-turn-preload.ts` hands `src/peer-turn-worker.ts`
 * frames rather than parsed IR.
 *
 * STRUCTURED INPUT (#119) IS THE CALLER'S JOB, NOT THIS FILE'S. `spawnCliTurn`
 * takes `stdin` as an already-encoded string (or nothing) and `args` as an
 * already-built argv. It does not render a prompt, structured or otherwise —
 * doing that here would make this the second place (after `src/ai/prompt.ts`)
 * that turns messages into CLI input, and the two would drift.
 *
 * WHY THIS IS NOT YET A `PluginHost` PLUGIN LIKE `LOCAL_TURNS_PLUGIN`. That
 * registration needs a `PluginDefinition` in `protocol.ts`, an event channel
 * for streaming `onData` to a renderer, and `main.ts` wiring — the same shape
 * `local-turns.ts` has, built up over several tickets (#7's six rulings). This
 * pass builds the spawn logic itself, tested directly against a real fake CLI
 * script (never the real CLIs — `tests/desktop-cli-turns.test.ts`, which
 * supplies REAL `node:child_process`/`node:path` as this file's injected
 * deps, since the test itself is not under the bridge-directory ban), and
 * leaves the PluginHost registration, `main.ts` wiring and the real
 * `CliSpawnDeps` construction as the next piece of work, named rather than
 * silently missing.
 */

/** #113's whole allowlist, before any CLI-specific extra is added. */
export const CLI_ENV_ALLOWLIST: readonly string[] = ['PATH', 'HOME'];

/**
 * Build a child's environment as an ALLOWLIST projection of `parentEnv`,
 * never a copy of it. `extra` is for "what this CLI needs to find its own
 * login" (#113) — e.g. a CLI whose auth genuinely requires an env var beyond
 * `HOME` names it here, explicitly, rather than this function widening its
 * own default.
 */
export function buildCliEnv(
  parentEnv: Readonly<Record<string, string | undefined>>,
  extra: readonly string[] = [],
): Record<string, string> {
  const allow = new Set([...CLI_ENV_ALLOWLIST, ...extra]);
  const env: Record<string, string> = {};
  for (const key of allow) {
    const value = parentEnv[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

/** The three `node:path` operations this file needs, injected rather than imported. */
export interface CliPathOps {
  readonly resolve: (...segments: string[]) => string;
  readonly relative: (from: string, to: string) => string;
  readonly isAbsolute: (candidate: string) => boolean;
}

/**
 * Resolve `requested` against `root` and refuse anything that would land
 * outside it — the same shape as `confineModelPath` (`apps/server/src`):
 * resolve, then a `relative()` check that a `..` escape or an absolute path
 * outside `root` cannot pass.
 *
 * @throws Error naming both the requested path and the root it was checked against.
 */
export function confineCwd(path: CliPathOps, root: string, requested: string): string {
  const resolvedRoot = path.resolve(root);
  const candidate = path.isAbsolute(requested) ? requested : path.resolve(resolvedRoot, requested);
  const rel = path.relative(resolvedRoot, candidate);
  if (rel !== '' && (rel.startsWith('..') || path.isAbsolute(rel))) {
    throw new Error(
      `cli-turns: cwd "${requested}" resolves outside the confined root "${resolvedRoot}".`,
    );
  }
  return candidate;
}

/** How the process ended. `signal` is set when `cancel()` (or anything else) killed it. */
export interface CliTurnExit {
  readonly code: number | null;
  readonly signal: string | null;
}

/** The structural slice of Node's `ChildProcess` this file actually uses. */
export interface CliChildProcess {
  readonly pid: number | undefined;
  readonly stdout: { on(event: 'data', listener: (chunk: Buffer) => void): void };
  readonly stderr: { on(event: 'data', listener: (chunk: Buffer) => void): void };
  readonly stdin: { write(data: string): void; end(): void };
  on(event: 'error', listener: (error: Error) => void): void;
  on(event: 'close', listener: (code: number | null, signal: string | null) => void): void;
}

/** Every side effect `spawnCliTurn` needs, injected — see this file's header. */
export interface CliSpawnDeps {
  readonly path: CliPathOps;
  readonly spawn: (
    binaryPath: string,
    args: readonly string[],
    options: { readonly cwd: string; readonly env: Readonly<Record<string, string>>; readonly detached: boolean },
  ) => CliChildProcess;
  /** The real implementation signals `-pid` on POSIX: the whole process group. */
  readonly killProcessGroup: (pid: number, signal: string) => void;
}

export interface CliTurnOptions {
  /** Must be absolute — `discoverCli`'s `found.path` (#116). */
  readonly binaryPath: string;
  readonly args: readonly string[];
  /** Checked with {@link confineCwd} against `cwdRoot`. */
  readonly cwd: string;
  readonly cwdRoot: string;
  /** Usually `process.env`, passed explicitly so this function never reads the ambient environment itself. */
  readonly parentEnv: Readonly<Record<string, string | undefined>>;
  readonly extraEnvKeys?: readonly string[];
  /** Already-encoded structured input (#119) — this module writes it verbatim and builds none of it. */
  readonly stdin?: string;
  readonly onData: (chunk: Uint8Array, stream: 'stdout' | 'stderr') => void;
  /** Called EXACTLY ONCE per turn, whether the process exited cleanly, was killed, or never started. */
  readonly onExit: (exit: CliTurnExit) => void;
}

export interface CliTurnHandle {
  /** Kill the whole process group (#115). A no-op if the process has already exited. */
  cancel(): void;
}

/**
 * Spawn one CLI turn. `onExit` fires exactly once — a `close` after an
 * `error` (or the reverse) is not a second exit, it is the same exit
 * reported by a second event, and the second report is dropped.
 */
export function spawnCliTurn(options: CliTurnOptions, deps: CliSpawnDeps): CliTurnHandle {
  if (!deps.path.isAbsolute(options.binaryPath)) {
    throw new Error(
      `cli-turns: refusing to spawn a non-absolute path ("${options.binaryPath}"). ` +
        '#116 resolves an absolute path before this is ever called; a relative one here ' +
        "would fall back to this process's own PATH resolution, which is the failure #116 exists to avoid.",
    );
  }

  const cwd = confineCwd(deps.path, options.cwdRoot, options.cwd);
  const env = buildCliEnv(options.parentEnv, options.extraEnvKeys);

  let exited = false;
  const settleExit = (exit: CliTurnExit): void => {
    if (exited) return;
    exited = true;
    options.onExit(exit);
  };

  const child = deps.spawn(options.binaryPath, options.args, {
    cwd,
    env,
    // The real deps.spawn is expected to pass this through as its own POSIX
    // process group (pgid === pid), so cancel() can signal the whole group.
    detached: true,
  });

  child.stdout.on('data', (chunk: Buffer) => options.onData(new Uint8Array(chunk), 'stdout'));
  child.stderr.on('data', (chunk: Buffer) => options.onData(new Uint8Array(chunk), 'stderr'));
  // A spawn that never started (ENOENT, EACCES) still gets exactly one exit.
  child.on('error', () => settleExit({ code: null, signal: null }));
  child.on('close', (code, signal) => settleExit({ code, signal }));

  if (options.stdin !== undefined) child.stdin.write(options.stdin);
  child.stdin.end();

  return {
    cancel(): void {
      if (child.pid === undefined) return;
      try {
        deps.killProcessGroup(child.pid, 'SIGTERM');
      } catch {
        // Already exited. There is nothing left to cancel.
      }
    },
  };
}
