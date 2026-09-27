/**
 * `Cli`, run for real (#42, #115, #116, #118).
 *
 * WHY THIS LIVES IN `cli/` AND NOT IN `bridge/`. Exactly `net/tunnel-socket.ts`'s
 * own reason (see that file's header): `tests/layering.test.ts`'s "the desktop
 * bridge stays platform-free" guard refuses any Node builtin inside
 * `apps/desktop/src/bridge/`, and this file needs `node:child_process`,
 * `node:fs` and `node:path` for real — it is what CONSTRUCTS the
 * `CliDiscoveryDeps`/`CliSpawnDeps` that `cli-discovery.ts`/`cli-specs.ts`
 * only accept as injected interfaces. `main.ts` imports this file directly,
 * the same way it imports `createTunnelSocketPlugin`.
 *
 * ONE INSTANCE MAY SERVE MANY RENDERERS AND MANY TURNS. `startTurn` and
 * `cancelTurn` are {@link SENDER_SCOPED}, so every turn is stamped with the
 * `ownerId` that started it, `cliData`/`cliExit` only ever reach that one
 * renderer, and `cancelTurn` refuses a turn it does not own rather than
 * silently doing nothing — the same rule `TunnelSocket.connect` follows for a
 * socket, applied here to a spawned process. `discover` carries no state and
 * is not scoped: #116's ruling is that it runs on an explicit "add", not that
 * it needs isolating between windows.
 *
 * DISCOVERY RUNS AGAIN, INSIDE `startTurn`, EVERY TIME. A resolved path is
 * never accepted FROM the renderer — `CliStartTurn` carries a `cliId`, never
 * a `binaryPath` — because trusting a path a page supplied would make
 * `startTurn` a way to run an arbitrary absolute path chosen by whichever
 * renderer can reach this plugin. This is slightly wasteful (the login shell
 * is asked twice for two turns of the same CLI moments apart) and
 * deliberately so.
 *
 * A TURN OUTLIVES NEITHER ITS WINDOW NOR THE APP. `PluginHost` has no
 * teardown hook of its own — every OTHER long-lived thing this app spawns
 * (`WorkBroker`'s local turns, the worker host, the inference fleet) is
 * released by `main.ts` calling into it directly from the SAME renderer
 * teardown and `will-quit` handlers that release everything else, and this
 * is that seam for `Cli`: {@link createCliPlugin} returns its
 * `PluginImplementation` augmented with two methods `main.ts` calls
 * directly, never through `PluginHost.invoke` (they are not in
 * `CLI_METHODS`, so a renderer cannot reach them either) —
 * `releaseRenderer(ownerId)` cancels every turn that window started, and
 * `disposeAll()` cancels every turn there is. Without this, `spawnCliTurn`'s
 * `detached: true` process group — the very thing that lets `cancel()` kill
 * a whole tree — is exactly what lets an orphaned turn survive its window,
 * or the app itself, with nothing left to signal it.
 */

import { spawn as nodeSpawn } from 'node:child_process';
import { access, mkdir, rm, stat } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';

import type { PluginImplementation, PluginMethod } from '../bridge/plugin-host.js';
import { SENDER_SCOPED } from '../bridge/protocol.js';
import type { CliDiscoverResult } from '../bridge/protocol.js';
import {
  discoverCli,
  type CliBinarySpec,
  type CliDiscoveryDeps,
  type CliExecResult,
} from '../bridge/cli-discovery.js';
import { CLI_SPECS, spawnCliBinaryTurn, type CliId } from '../bridge/cli-specs.js';
import type { CliChildProcess, CliSpawnDeps, CliTurnExit, CliTurnHandle } from '../bridge/cli-turns.js';

/** Everything one `Cli` plugin instance needs from its host, injected the same way `TunnelSocketPluginOptions` is. */
export interface CliPluginOptions {
  /** Every turn's cwd is `<turnRoot>/<requestId>`, confined to this root. */
  readonly turnRoot: string;
  /** Emit one plugin event, to one window when `ownerId` is given. */
  readonly notify: (eventName: string, data: unknown, ownerId?: number) => void;
  /** Defaults to `process.env`. Separated out so a test can inject a smaller one. */
  readonly parentEnv?: Readonly<Record<string, string | undefined>>;
  /**
   * Defaults to the real login-shell/exec probe this file builds. Overridable
   * so `tests/desktop-cli-plugin.test.ts` can point discovery at a fake CLI
   * script instead of a real `claude`/`codex`/`gemini` -- this pass never
   * runs a real CLI, discovery included.
   */
  readonly discoveryDeps?: CliDiscoveryDeps;
  /** Defaults to the real `node:child_process`/`node:path` wiring this file builds. Overridable for the same reason as `discoveryDeps`. */
  readonly spawnDeps?: CliSpawnDeps;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    throw new Error('Cli: expected an object argument.');
  }
  return value as Record<string, unknown>;
}

function requireString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Cli: expected a non-empty string "${key}".`);
  }
  return value;
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new Error(`Cli: expected "${key}" to be a string when present.`);
  return value;
}

function specFor(cliId: string): CliBinarySpec {
  const spec = CLI_SPECS.find((candidate) => candidate.id === cliId);
  if (spec === undefined) {
    throw new Error(`Cli: "${cliId}" is not one of ${CLI_SPECS.map((s) => s.id).join(', ')}.`);
  }
  return spec;
}

function isKnownCliId(cliId: string): cliId is CliId {
  return CLI_SPECS.some((spec) => spec.id === cliId);
}

/** Resolve `command` the way the user's LOGIN shell would (#116) -- never `process.env.PATH`. */
function resolveBinaryViaLoginShell(command: string): Promise<string | undefined> {
  return new Promise((settle) => {
    if (!/^[a-zA-Z0-9_-]+$/.test(command)) {
      // Every real caller passes a literal from CLI_SPECS ('claude', 'codex',
      // 'gemini'), never anything a renderer chose -- this is a floor under
      // that invariant, not a path a legitimate call is expected to take.
      settle(undefined);
      return;
    }
    const shell = process.env.SHELL ?? '/bin/sh';
    const child = nodeSpawn(shell, ['-lc', `command -v ${command}`], { stdio: ['ignore', 'pipe', 'ignore'] });
    let stdout = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
    child.on('error', () => settle(undefined));
    child.on('close', (code) => {
      const trimmed = stdout.trim();
      settle(code === 0 && trimmed.length > 0 ? trimmed : undefined);
    });
  });
}

async function statBinary(path: string): Promise<{ readonly executable: boolean } | undefined> {
  try {
    const info = await stat(path);
    if (!info.isFile()) return undefined;
  } catch {
    return undefined;
  }
  try {
    await access(path, fsConstants.X_OK);
    return { executable: true };
  } catch {
    return { executable: false };
  }
}

function execBinary(path: string, args: readonly string[]): Promise<CliExecResult> {
  return new Promise((settle) => {
    const child = nodeSpawn(path, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    child.on('error', () => settle({ stdout, stderr, code: -1 }));
    child.on('close', (code) => settle({ stdout, stderr, code: code ?? -1 }));
  });
}

/**
 * The `PluginImplementation` `PluginHost.register(CLI_PLUGIN, …)` takes,
 * plus the two teardown methods `main.ts` calls directly (never through
 * `PluginHost.invoke` -- see this file's header). Both are safe to call when
 * nothing is running: an empty `turns` map makes either one a no-op.
 */
export type CliPluginImplementation = PluginImplementation & {
  /** Cancel every turn `ownerId` started. Called from the same renderer-teardown path `localTurns.releaseRenderer` is. */
  readonly releaseRenderer: (ownerId: number) => void;
  /** Cancel every turn there is, regardless of owner. Called from `app.once('will-quit', ...)`. */
  readonly disposeAll: () => void;
};

/**
 * Build the main-process implementation `PluginHost.register(CLI_PLUGIN, …)` takes.
 */
export function createCliPlugin(options: CliPluginOptions): CliPluginImplementation {
  const parentEnv = options.parentEnv ?? process.env;
  const turns = new Map<string, { readonly ownerId: number; readonly handle: CliTurnHandle }>();

  const discoveryDeps: CliDiscoveryDeps = options.discoveryDeps ?? {
    resolveBinary: resolveBinaryViaLoginShell,
    stat: statBinary,
    exec: execBinary,
  };

  const spawnDeps: CliSpawnDeps = options.spawnDeps ?? {
    path: { resolve, relative, isAbsolute },
    spawn: (binaryPath, args, spawnOptions) =>
      nodeSpawn(binaryPath, args, {
        cwd: spawnOptions.cwd,
        env: spawnOptions.env,
        detached: spawnOptions.detached,
        stdio: ['pipe', 'pipe', 'pipe'],
      }) as unknown as CliChildProcess,
    killProcessGroup: (pid, signal) => {
      process.kill(-pid, signal as NodeJS.Signals);
    },
  };

  async function discover(raw: unknown): Promise<CliDiscoverResult> {
    const cliId = requireString(asRecord(raw), 'cliId');
    return discoverCli(specFor(cliId), discoveryDeps);
  }

  async function startTurn(ownerId: number, raw: unknown): Promise<{ readonly requestId: string }> {
    const record = asRecord(raw);
    const requestId = requireString(record, 'requestId');
    const cliId = requireString(record, 'cliId');
    const stdin = optionalString(record, 'stdin');
    const systemPrompt = optionalString(record, 'systemPrompt');

    if (turns.has(requestId)) throw new Error(`Cli: a turn named "${requestId}" is already running.`);
    if (!isKnownCliId(cliId)) throw new Error(`Cli: "${cliId}" is not one of ${CLI_SPECS.map((s) => s.id).join(', ')}.`);

    // Discovery runs again here, deliberately -- see this file's header.
    const discovery = await discoverCli(specFor(cliId), discoveryDeps);
    if (discovery.status !== 'found') {
      throw new Error(`Cli: cannot start "${cliId}" -- discovery reported "${discovery.status}".`);
    }

    const cwd = join(options.turnRoot, requestId);
    await mkdir(cwd, { recursive: true });

    const handle = spawnCliBinaryTurn(
      cliId,
      {
        binaryPath: discovery.path,
        cwd,
        cwdRoot: options.turnRoot,
        parentEnv,
        stdin,
        systemPrompt,
        onData: (chunk, stream) => options.notify('cliData', { requestId, chunk, stream }, ownerId),
        onExit: (exit: CliTurnExit) => {
          turns.delete(requestId);
          options.notify('cliExit', { requestId, code: exit.code, signal: exit.signal }, ownerId);
          // Best-effort, every time a turn ends however it ends -- a
          // natural exit, a cancel, a releaseRenderer/disposeAll sweep. Never
          // awaited: nothing here is on a path anyone is waiting for, and a
          // scratch directory that fails to delete (a file still open a
          // beat longer on some platform) is not a reason to hold anything up.
          void rm(cwd, { recursive: true, force: true }).catch(() => undefined);
        },
      },
      spawnDeps,
    );

    turns.set(requestId, { ownerId, handle });
    return { requestId };
  }

  function cancelTurn(ownerId: number, raw: unknown): void {
    const requestId = requireString(asRecord(raw), 'requestId');
    const turn = turns.get(requestId);
    // Already ended (or never existed): cancelling it is a no-op, the same
    // contract `spawnCliTurn`'s own `cancel()` keeps.
    if (turn === undefined) return;
    if (turn.ownerId !== ownerId) {
      throw new Error('Cli: refusing to cancel a turn started by a different window.');
    }
    turn.handle.cancel();
  }

  /** Cancel every turn matching `predicate`. Shared by `releaseRenderer` and `disposeAll`. */
  function cancelWhere(predicate: (ownerId: number) => boolean): void {
    for (const turn of turns.values()) {
      if (predicate(turn.ownerId)) turn.handle.cancel();
    }
  }

  function releaseRenderer(ownerId: number): void {
    cancelWhere((candidate) => candidate === ownerId);
  }

  function disposeAll(): void {
    cancelWhere(() => true);
  }

  const implementation: Record<string, PluginMethod> = {
    discover: discover as PluginMethod,
    startTurn: startTurn as PluginMethod,
    cancelTurn: cancelTurn as PluginMethod,
  };
  return Object.assign(implementation, {
    [SENDER_SCOPED]: ['startTurn', 'cancelTurn'],
    releaseRenderer,
    disposeAll,
  }) as unknown as CliPluginImplementation;
}
