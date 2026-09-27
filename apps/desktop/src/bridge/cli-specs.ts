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
import { spawnCliTurn, type CliSpawnDeps, type CliTurnExit, type CliTurnHandle } from './cli-turns.js';

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

/** `gemini -p '' -o stream-json --approval-mode plan` (#115) — see {@link buildCliTurnArgv}. No dedicated auth-status subcommand exists (verified against `gemini --help`). */
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

/**
 * THE EXACT PER-TURN ARGV, WITH NATIVE TOOLS OFF (#115).
 *
 * Before this function existed, "tools disabled" was a claim in a docstring
 * and nowhere else — no code built an argv, so nothing enforced it. This is
 * that code: one argv PER CLI, fixed, verified against a real `--help` on
 * this build machine (`claude` 2.1.263, `codex` 0.144.1, `gemini` 0.46.0,
 * `--help` output only — no prompt was run to verify these combine at
 * runtime; see each `case` below for what is and is not confirmed).
 *
 * `opts` carries nothing per-turn today — deliberately. Every flag here is
 * fixed per CLI, not per message, and the type has no field a message could
 * ever populate. `tests/desktop-cli-turn-argv.test.ts` pins this: the argv
 * for a given `cliId` is IDENTICAL no matter what a turn's message content
 * is, because this function never receives message content in the first
 * place. The field exists only so a later, legitimate PER-TURN need (a model
 * override, an extra `--add-dir`) has somewhere to go without this function
 * growing a second parameter — and whoever adds one is bound by the same
 * test to prove it stays disconnected from message text.
 */
export interface CliTurnArgvOptions {
  // Intentionally empty. See this function's own doc.
}

/**
 * Every CLI's own claim about what argv turns off, and — just as loud —
 * what it does NOT turn off. `claude`'s combination is the strong one #115
 * asked for. `codex`'s is not, and says so rather than pretending: `-s
 * read-only` is a FILESYSTEM policy on the model's shell tool, not a switch
 * that removes the tool or blocks the network calls a shell command can
 * make, and neither `codex --help` nor `codex exec --help` documents a flag
 * that does either. `gemini`'s is a best effort against a `--help` that
 * offers nothing as strong as `claude`'s `--tools ""`.
 */
export function buildCliTurnArgv(cliId: CliId, _opts: CliTurnArgvOptions = {}): readonly string[] {
  switch (cliId) {
    case 'claude':
      return CLAUDE_TURN_ARGV;
    case 'codex':
      return CODEX_TURN_ARGV;
    case 'gemini':
      return GEMINI_TURN_ARGV;
  }
}

export type CliId = 'claude' | 'codex' | 'gemini';

/**
 * `claude`'s STRONG combination — every flag verified against `claude
 * --help` 2.1.263:
 *
 *   `-p --output-format stream-json --verbose --include-partial-messages
 *   --input-format stream-json`
 *       The streaming I/O shape #115 names, and #119's structured input:
 *       the message reaches this process over stdin, in `stream-json`
 *       input format, never as an argv value.
 *   `--tools ""`
 *       "Use "" to disable all tools" — `--help`'s own words. The single
 *       strongest lever available: with no tools declared, there is
 *       nothing left for a permission mode to gate.
 *   `--restricted`
 *       Redundant with `--tools ""` for WHICH tools run (there are none to
 *       remove), but not redundant for what it does alongside that: ignores
 *       user, project and local settings files, so a CLAUDE.md hook or a
 *       settings file this build never wrote cannot reintroduce a tool or a
 *       permission this argv turned off. Also refuses `bypassPermissions`
 *       outright, closing the one mode this argv never asks for anyway.
 *   `--strict-mcp-config --mcp-config '{"mcpServers":{}}'`
 *       "Only use MCP servers from --mcp-config" (`--help`), paired with an
 *       MCP config that names none. The user's own `~/.claude.json`/project
 *       MCP servers — which is what "user-level MCP servers" means here —
 *       are not loaded, full stop, rather than relying on `--strict-mcp-config`
 *       alone with no `--mcp-config` at all (which `--help`'s wording implies
 *       would ALSO be empty, but an explicit empty config says so instead of
 *       implying it).
 *   `--permission-mode plan`
 *       Read-only mode. With no tools to run this is belt-and-braces, not
 *       load-bearing — but it is what #115 named, so it is here.
 *   `--permission-prompts none`
 *       "Anything that would prompt is denied automatically" (`--help`).
 *       This process has no human to answer a prompt; without this, a tool
 *       call that somehow got this far would hang instead of being refused.
 *
 * NEVER: `--dangerously-skip-permissions`, `--allow-dangerously-skip-permissions`.
 */
const CLAUDE_TURN_ARGV: readonly string[] = Object.freeze([
  '-p',
  '--output-format',
  'stream-json',
  '--verbose',
  '--include-partial-messages',
  '--input-format',
  'stream-json',
  '--tools',
  '',
  '--restricted',
  '--strict-mcp-config',
  '--mcp-config',
  '{"mcpServers":{}}',
  '--permission-mode',
  'plan',
  '--permission-prompts',
  'none',
]);

/**
 * `codex`'s BEST AVAILABLE combination, and the RESIDUAL CAPABILITY it keeps
 * that this build cannot document a flag to close.
 *
 * `exec --json`
 *     Non-interactive JSONL streaming (#115).
 * `-s read-only`
 *     A SANDBOX POLICY on "commands the model generates" (`codex exec
 *     --help`'s own words), and every one of its three named values
 *     (`read-only`, `workspace-write`, `danger-full-access`) is spelled as a
 *     FILESYSTEM permission level. It is not, and does not claim to be, a
 *     switch that removes the shell-command tool: the model can still ask to
 *     run a command, and the sandbox answers by confining what that command
 *     can WRITE, not whether it runs.
 * `--ignore-user-config`
 *     "Do not load $CODEX_HOME/config.toml" (`codex exec --help`) — which is
 *     where a user's own MCP servers are configured, so this is the closest
 *     `codex` has to `claude`'s `--strict-mcp-config`: no user-level MCP
 *     server for this turn.
 * `--skip-git-repo-check`
 *     Bypasses codex's "not inside a trusted directory" refusal — a
 *     confirmation gate about the WORKING DIRECTORY's trust status, measured
 *     directly (`codex exec` refuses to run at all without it, or a trusted
 *     project entry, outside a git repo). This is not a sandbox or tool
 *     setting; it exists because a confined scratch directory this app
 *     controls is never going to be a git repo or a project the user
 *     manually marked trusted, and there is no human here to answer the
 *     confirmation codex would otherwise print.
 *
 * NEVER: `--dangerously-bypass-approvals-and-sandbox`, `--dangerously-bypass-hook-trust`, `--search`
 * (web search is opt-in per `codex --help`; simply never passing it keeps it off).
 *
 * WHAT THIS DOES NOT CLOSE, STATED PLAINLY RATHER THAN IMPLIED: neither
 * `codex --help` nor `codex exec --help` documents ANY flag that disables
 * the shell-command tool itself, or that denies network access from a
 * command the sandbox does allow to run. `-s read-only`'s own three possible
 * values are all filesystem levels; none of them, and no other flag or `-c`
 * key shown in `--help`, mentions network at all. So `codex` — unlike
 * `claude` — CANNOT be given an argv that guarantees "no shell, no network"
 * from this app's own flags. This is not a gap this build papers over: the
 * owner has been told directly (see this ticket's report) and gets to decide
 * whether `codex` ships as a source at all before tools are ever admitted as
 * their own later unit.
 */
const CODEX_TURN_ARGV: readonly string[] = Object.freeze([
  'exec',
  '--json',
  '-s',
  'read-only',
  '--ignore-user-config',
  '--skip-git-repo-check',
]);

/**
 * `gemini`'s BEST-EFFORT combination against a `--help` that offers nothing
 * as strong as `claude`'s `--tools ""`.
 *
 * `-p ''`
 *     `--help`: "-p, --prompt ... Run in non-interactive (headless) mode
 *     with the given prompt. Appended to input on stdin (if any)." An empty
 *     value still selects non-interactive mode (per that same text), and the
 *     ACTUAL message — never a value in this argv — is what "appended to
 *     input on stdin" then supplies. UNVERIFIED AT RUNTIME: no prompt was
 *     run this pass (only `--help`), so this reading of "appended... if
 *     any" is inferred from the `--help` text, not measured.
 * `-o stream-json`
 *     The streaming JSONL shape #115 names.
 * `--approval-mode plan`
 *     `--help`'s own words: "plan (read-only mode)". The strongest tool
 *     posture `--help` documents for `gemini` — there is no `--tools ""`
 *     equivalent.
 *
 * NEVER: `-y`/`--yolo` (auto-approves every tool), `--allowed-tools` (deprecated
 * per `--help`, and an ALLOW list is the wrong shape for a source whose default
 * should be nothing running).
 *
 * WHAT THIS DOES NOT CLOSE: `-e`/`--extensions` defaults to "all extensions"
 * per `--help` ("If not provided, all extensions are used"), and `--help`
 * documents no syntax for naming zero. Guessing at one — a bare `--extensions`,
 * `--extensions ''` — risks either a parse error or, worse, appearing to
 * exclude extensions while actually doing nothing, which is a worse failure
 * mode than an argv that plainly does not try. Same for
 * `--allowed-mcp-server-names`: an empty-list syntax is not documented, so
 * none is guessed here. Both are real residual gaps, alongside `plan`
 * mode's own scope (read-only, not necessarily "no tool calls at all") —
 * named for the owner's decision, not silently accepted.
 */
const GEMINI_TURN_ARGV: readonly string[] = Object.freeze(['-p', '', '-o', 'stream-json', '--approval-mode', 'plan']);

/**
 * Spawn one turn for a KNOWN CLI, with NO WAY to pass a free-form argv in —
 * the whole point of this function existing beside {@link spawnCliTurn}.
 * `spawnCliTurn` stays generic (and stays tested against a fake CLI SCRIPT,
 * which is not one of the three real CLIs and has no business going through
 * {@link buildCliTurnArgv}); THIS function is what a real caller — the
 * PluginHost handler this ships with later — is meant to use instead, and
 * its options type has no `args` field at all. There is nothing to wire
 * "no free-form args from the renderer" against here: the type does not
 * offer the door.
 */
export function spawnCliBinaryTurn(
  cliId: CliId,
  options: {
    readonly binaryPath: string;
    readonly cwd: string;
    readonly cwdRoot: string;
    readonly parentEnv: Readonly<Record<string, string | undefined>>;
    readonly stdin?: string;
    readonly onData: (chunk: Uint8Array, stream: 'stdout' | 'stderr') => void;
    readonly onExit: (exit: CliTurnExit) => void;
  },
  deps: CliSpawnDeps,
): CliTurnHandle {
  return spawnCliTurn(
    {
      binaryPath: options.binaryPath,
      args: buildCliTurnArgv(cliId),
      cwd: options.cwd,
      cwdRoot: options.cwdRoot,
      parentEnv: options.parentEnv,
      stdin: options.stdin,
      onData: options.onData,
      onExit: options.onExit,
    },
    deps,
  );
}
