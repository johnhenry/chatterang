/**
 * THE THREE REAL `CliBinarySpec`s (#115, #116), verified against real
 * `--help` output and one real run of each binary on the build machine —
 * `claude` 2.1.263, `codex` (codex-cli) 0.144.1, `gemini` (gemini-cli) 0.46.0.
 * `discoverCli` (`cli-discovery.ts`) is generic over a spec; this file is
 * where the three CLIs actually named in #115 become one.
 *
 * VERSION PARSING, per CLI's real `--version` output:
 *   - `claude --version` -> `2.1.263 (Claude Code)`
 *   - `codex --version`  -> `codex-cli 0.144.1`
 *   - `gemini --version` -> `0.46.0`
 * All three start with, or contain, a bare `MAJOR.MINOR.PATCH`, so one regex
 * covers all three rather than three bespoke parsers.
 *
 * SIGN-IN CHECKS, decided per CLI because the three `--help` outputs do not
 * agree on whether one even exists:
 *
 *   - `claude auth status --json` exists (`claude auth --help` lists it) and
 *     answers structured JSON — real output on a signed-in machine:
 *     `{"loggedIn":true,"authMethod":"claude.ai",...}`. This is the CLEAN
 *     case #115 anticipated: a dedicated, machine-readable status command.
 *   - `codex login status` exists (`codex login --help` lists it) but is
 *     TEXT, not JSON — real output: `Logged in using ChatGPT`. There is no
 *     `--json` on this subcommand (checked against `--help`), so the check is
 *     textual: exit 0 and a stdout that does not start with "Not logged in"
 *     (Codex's own phrasing for the signed-out case, per its `login`/`logout`
 *     command names and help text; not independently verified against a
 *     signed-out machine in this pass — logging this machine out to check
 *     would be a destructive experiment on a real account, which is exactly
 *     what discovery must never do as a side effect of itself).
 *   - `gemini --help` has NO `auth`/`login` subcommand at all — this repo
 *     searched its full command list and found none. `gemini`'s CLI IS its
 *     own login surface (an interactive `/auth` flow, not a scriptable
 *     status command), so `signedInArgs` reuses `versionArgs` (the shared-
 *     array optimisation `cli-discovery.ts` documents) and `isSignedIn`
 *     answers `true` whenever the version run itself succeeded. A
 *     credential problem `gemini` cannot report through `--version` — this
 *     build's own `gemini` needs `GEMINI_API_KEY` for its configured auth
 *     mode and has none in a from-scratch shell — surfaces at the FIRST
 *     TURN instead, as a turn-time error, not a discovery-time one. That is
 *     a real gap, not a design choice pretending otherwise, and it is the
 *     reason `gemini`'s stream translator is not built in this pass either
 *     (`src/ai/backends/cli-stream.ts`'s closing comment).
 */

import type { CliBinarySpec, CliExecResult } from './cli-discovery.js';

const SEMVER = /(\d+\.\d+\.\d+)/;

function parseSemver(result: CliExecResult): string | undefined {
  return SEMVER.exec(result.stdout)?.[1];
}

/** `claude -p --output-format stream-json --verbose --include-partial-messages --input-format stream-json` (#115). */
export const CLAUDE_SPEC: CliBinarySpec = {
  id: 'claude',
  command: 'claude',
  versionArgs: ['--version'],
  parseVersion: parseSemver,
  signedInArgs: ['auth', 'status', '--json'],
  isSignedIn: (result) => {
    if (result.code !== 0) return false;
    try {
      const parsed: unknown = JSON.parse(result.stdout);
      return typeof parsed === 'object' && parsed !== null && (parsed as { loggedIn?: unknown }).loggedIn === true;
    } catch {
      return false;
    }
  },
};

/** `codex exec --json` (#115), sandboxed read-only. */
export const CODEX_SPEC: CliBinarySpec = {
  id: 'codex',
  command: 'codex',
  versionArgs: ['--version'],
  parseVersion: parseSemver,
  signedInArgs: ['login', 'status'],
  isSignedIn: (result) => result.code === 0 && !/^\s*not logged in/i.test(result.stdout),
};

/** `gemini -p ... --output-format stream-json` (#115). No dedicated auth-status subcommand exists (verified against `gemini --help`). */
const GEMINI_VERSION_ARGS = ['--version'];
export const GEMINI_SPEC: CliBinarySpec = {
  id: 'gemini',
  command: 'gemini',
  versionArgs: GEMINI_VERSION_ARGS,
  parseVersion: parseSemver,
  signedInArgs: GEMINI_VERSION_ARGS,
  isSignedIn: (result) => result.code === 0,
};

/** All three, in the order #115 lists them. */
export const CLI_SPECS: readonly CliBinarySpec[] = [CLAUDE_SPEC, CODEX_SPEC, GEMINI_SPEC];
