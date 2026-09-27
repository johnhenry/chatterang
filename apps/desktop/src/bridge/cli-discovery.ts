/**
 * FINDING A LOCAL AGENT CLI, WITHOUT GUESSING AND WITHOUT SCANNING (#116).
 *
 * There is no probe of the host machine anywhere else in this repo. The
 * naive version — run `claude --version` and parse it — is itself an
 * arbitrary process execution against a `PATH` this app does not control,
 * and on macOS a GUI-launched Electron process does not even inherit the
 * user's login-shell `PATH`: a `claude` installed by nvm, homebrew or mise is
 * usually not found by the process's own environment, for exactly the people
 * most likely to have it installed.
 *
 * The owner's ruling on #116 is followed exactly:
 *
 *   - Resolve an ABSOLUTE PATH via the login shell — not shell `PATH`
 *     resolution at spawn time — and report it, so the user can see which
 *     binary was found.
 *   - Read a VERSION and record it; a version this app has no fixtures for
 *     is a warning, never silently trusted (`tests/fixtures/cli/` decides
 *     the range, not this module).
 *   - Distinguish all FOUR failure states, because each wants a different
 *     user action: not found; found but not executable; found but the
 *     version could not be read; found but not signed in.
 *   - Run only on an explicit user action (the caller's job — this module
 *     has no timer, no watcher, nothing ambient).
 *
 * Every side effect — resolving the path, checking it, running it — is
 * INJECTED, never imported (`node:child_process`/`node:fs` do not appear in
 * this file). That is what makes `discoverCli` testable with a fake shell and
 * a fake filesystem rather than the real one, and it is also what keeps this
 * out of `src/`: `tests/layering.test.ts` bans a Node-only dependency reached
 * from `src/`, and this module is Electron-main-only by construction (#116,
 * #115 — "Desktop (apps/desktop) only").
 */

/** One command run and its raw result. Never a prompt, never generated text. */
export interface CliExecResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
}

/**
 * The three effects `discoverCli` needs from the outside world, and nothing
 * else — no path joining, no `process.env`, no default shell. The caller
 * (apps/desktop's real implementation) supplies the login-shell probe; tests
 * supply a fake.
 */
export interface CliDiscoveryDeps {
  /**
   * Resolve `command` to an absolute path the way the user's LOGIN shell
   * would (`$SHELL -lc 'command -v <command>'` or equivalent) — deliberately
   * not `process.env.PATH`, which is Electron's ambient environment, not the
   * user's. Returns `undefined` when the shell reports nothing.
   */
  readonly resolveBinary: (command: string) => Promise<string | undefined>;
  /**
   * Stat the resolved path. `undefined` when the path no longer exists (the
   * shell can report a path that was removed a moment later); otherwise
   * whether the file is executable by this user.
   */
  readonly stat: (path: string) => Promise<{ readonly executable: boolean } | undefined>;
  /** Run `path` with `args` and capture the result. Never throws on a non-zero exit. */
  readonly exec: (path: string, args: readonly string[]) => Promise<CliExecResult>;
}

/**
 * Everything specific to one CLI: which command names it, how to read a
 * version out of a run, and how to tell a signed-in run from a signed-out
 * one. `versionArgs` and `signedInArgs` are usually the same invocation
 * (`--version` for `claude`/`gemini`; `codex --version` too, per #115's
 * `--help`-verified flags) — kept as two fields because a future CLI may need
 * a second call to tell the two apart, and this module should not have to
 * change shape to grow one.
 */
export interface CliBinarySpec {
  readonly id: string;
  readonly command: string;
  readonly versionArgs: readonly string[];
  /** `undefined` means the run's output did not contain a version this can read. */
  readonly parseVersion: (result: CliExecResult) => string | undefined;
  readonly signedInArgs: readonly string[];
  readonly isSignedIn: (result: CliExecResult) => boolean;
}

/** The four failure states #116 names, plus the one success state. */
export type CliDiscovery =
  | { readonly status: 'not-found'; readonly id: string }
  | { readonly status: 'not-executable'; readonly id: string; readonly path: string }
  | { readonly status: 'version-unreadable'; readonly id: string; readonly path: string }
  | {
      readonly status: 'not-signed-in';
      readonly id: string;
      readonly path: string;
      readonly version: string;
    }
  | { readonly status: 'found'; readonly id: string; readonly path: string; readonly version: string };

/**
 * Resolve, check and probe one CLI, in that order, stopping at the first
 * question that has no good answer.
 *
 * The order matters: a path that does not exist is `not-found`, never
 * `not-executable` (an executability check on a path that failed to resolve
 * would be answering a question that was not asked); a version that cannot
 * be read is reported before a sign-in check runs, because a CLI whose
 * output this app cannot parse should not also be asked whether a
 * SEPARATE run signed in — that would blame the wrong thing.
 */
export async function discoverCli(
  spec: CliBinarySpec,
  deps: CliDiscoveryDeps,
): Promise<CliDiscovery> {
  const path = await deps.resolveBinary(spec.command);
  if (path === undefined) return { status: 'not-found', id: spec.id };

  const stat = await deps.stat(path);
  if (stat === undefined || !stat.executable) {
    return { status: 'not-executable', id: spec.id, path };
  }

  const versionRun = await deps.exec(path, spec.versionArgs);
  const version = spec.parseVersion(versionRun);
  if (version === undefined) {
    return { status: 'version-unreadable', id: spec.id, path };
  }

  const signInRun =
    spec.signedInArgs === spec.versionArgs ? versionRun : await deps.exec(path, spec.signedInArgs);
  if (!spec.isSignedIn(signInRun)) {
    return { status: 'not-signed-in', id: spec.id, path, version };
  }

  return { status: 'found', id: spec.id, path, version };
}
