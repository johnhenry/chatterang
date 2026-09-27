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
 *
 * THE RELEASE ITSELF HAD A RACE, AND `TrackedTurn.cancelled` IS THE FIX.
 * `startTurn` is `async`: between recording that a turn exists and the
 * process actually being spawned, it suspends at `await discoverCli(...)`
 * and `await mkdir(...)`. A `releaseRenderer`/`disposeAll` arriving in that
 * window used to find nothing to cancel — the turn was not in `turns` yet —
 * and `startTurn` would go on to spawn a process for a window (or an app)
 * that had already gone. Reproduced. The fix records a `TrackedTurn` with
 * `handle: undefined` SYNCHRONOUSLY, before the first `await`; a release
 * that arrives while it is pending sets `cancelled` (there is no handle yet
 * to call `cancel()` on); `startTurn` checks `cancelled` (and the plugin's
 * own `disposing` flag) after every `await` and aborts — never spawns,
 * removes the scratch cwd if one was already created, and rejects its own
 * promise rather than emit a `cliExit` for a process that never existed.
 * `disposeAll` additionally sets `disposing` for good: once the app is
 * quitting there is no scenario where a NEW turn should be allowed to
 * start, pending or not.
 *
 * `requestId` IS VALIDATED TWICE, ON PURPOSE. It becomes a directory name
 * (`<turnRoot>/<requestId>`) before anything else happens to it, and a
 * renderer chooses it — `requireRequestId`'s `/^[A-Za-z0-9_-]{1,128}$/`
 * check, at the IPC boundary, is the first gate a value like
 * `../outside-marker` fails outright, on the `.`/`/` alone; `confineCwd`
 * (`cli-turns.ts`, the same function `spawnCliTurn` itself uses) is the
 * second, independent check on the SAME value, computed before the one
 * filesystem call (`mkdir`) that follows it. Neither is a substitute for
 * the other: the pattern is about what a directory NAME may contain, and
 * `confineCwd` is about where the resulting path may resolve to — two
 * different questions that happen to agree here, and might not for a
 * pattern chosen less conservatively later.
 */

import { spawn as nodeSpawn } from 'node:child_process';
import { access, mkdir, rm, stat } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';

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
import { confineCwd } from '../bridge/cli-turns.js';
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
  /**
   * Defaults to real `node:fs/promises` `mkdir`/`rm`. Overridable so a test
   * can gate the scratch-cwd step the same way `discoveryDeps` lets it gate
   * discovery -- `tests/desktop-cli-plugin.test.ts`'s orphan-race cases
   * (#42, #115) need to land a `releaseRenderer`/`disposeAll` call exactly
   * inside this `await`, which real `mkdir`'s own speed makes otherwise
   * impractical to hit deterministically.
   */
  readonly fsOps?: CliPluginFsOps;
}

/** The two filesystem operations `startTurn`'s scratch cwd needs. */
export interface CliPluginFsOps {
  readonly mkdir: (path: string) => Promise<void>;
  readonly rm: (path: string) => Promise<void>;
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

/**
 * `requestId` becomes a directory NAME (`<turnRoot>/<requestId>`) before
 * anything else happens to it, so it is validated as one here, at the IPC
 * boundary, before `startTurn`/`cancelTurn` do anything with it -- not
 * merely checked non-empty. `../outside-marker` (the measured escape) fails
 * this on the `.` and `/` alone; `confineCwd` (below) is the second,
 * independent check on the same value, not a substitute for this one.
 */
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

function requireRequestId(record: Record<string, unknown>): string {
  const requestId = requireString(record, 'requestId');
  if (!REQUEST_ID_PATTERN.test(requestId)) {
    throw new Error(`Cli: "requestId" must match ${REQUEST_ID_PATTERN.source} (got "${requestId}").`);
  }
  return requestId;
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
/**
 * One tracked turn, from the moment `startTurn` accepts it. `handle` is
 * `undefined` for exactly as long as the turn is PENDING -- recorded, but
 * not yet spawned, because `discoverCli`/`mkdir` have not resolved. A
 * pending turn has nothing a `cancel()` call could reach yet, so
 * `cancelled` is where `releaseRenderer`/`disposeAll`/`cancelTurn` leave
 * their mark instead: `startTurn` checks it after every `await` and aborts,
 * cleanly, rather than spawning a process nothing is left to signal.
 */
interface TrackedTurn {
  readonly ownerId: number;
  handle?: CliTurnHandle;
  cancelled: boolean;
}

export function createCliPlugin(options: CliPluginOptions): CliPluginImplementation {
  const parentEnv = options.parentEnv ?? process.env;
  const turns = new Map<string, TrackedTurn>();
  // Set once, by `disposeAll`, and never cleared: the app is quitting, and
  // there is no scenario where it un-quits and needs a new CLI turn.
  let disposing = false;

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

  const fsOps: CliPluginFsOps = options.fsOps ?? {
    mkdir: async (path) => {
      await mkdir(path, { recursive: true });
    },
    rm: async (path) => {
      await rm(path, { recursive: true, force: true });
    },
  };

  async function discover(raw: unknown): Promise<CliDiscoverResult> {
    const cliId = requireString(asRecord(raw), 'cliId');
    return discoverCli(specFor(cliId), discoveryDeps);
  }

  /**
   * Abort a PENDING turn cleanly: never spawned, its scratch directory (if
   * one was already created) removed, and the caller's `startTurn` promise
   * REJECTED -- chosen over a synthesised `cliExit` because no process ever
   * existed for one to describe the end of. `cli-bridge.ts`'s renderer-side
   * adapter already treats a rejected `startTurn` as the turn's one end
   * (`.catch(() => exitListener?.({code: null, signal: null}))`), so the
   * caller still gets exactly one terminal signal -- just not this plugin's
   * own `cliExit` event, which would otherwise have no process behind it.
   */
  async function abortPending(requestId: string, cwdIfCreated: string | undefined): Promise<never> {
    turns.delete(requestId);
    if (cwdIfCreated !== undefined) {
      await fsOps.rm(cwdIfCreated).catch(() => undefined);
    }
    throw new Error(`Cli: turn "${requestId}" was released before it finished starting.`);
  }

  async function startTurn(ownerId: number, raw: unknown): Promise<{ readonly requestId: string }> {
    if (disposing) throw new Error('Cli: refusing to start a new turn -- shutting down.');

    const record = asRecord(raw);
    const requestId = requireRequestId(record);
    const cliId = requireString(record, 'cliId');
    const stdin = optionalString(record, 'stdin');
    const systemPrompt = optionalString(record, 'systemPrompt');

    if (turns.has(requestId)) throw new Error(`Cli: a turn named "${requestId}" is already running.`);
    if (!isKnownCliId(cliId)) throw new Error(`Cli: "${cliId}" is not one of ${CLI_SPECS.map((s) => s.id).join(', ')}.`);

    // Recorded SYNCHRONOUSLY, before the first `await` below -- this is the
    // fix for the orphan race: `releaseRenderer`/`disposeAll`/`cancelTurn`
    // running while this function is suspended at an `await` can find this
    // entry and mark it `cancelled`, which the checks after each `await`
    // below then act on.
    const pending: TrackedTurn = { ownerId, cancelled: false };
    turns.set(requestId, pending);

    // Discovery runs again here, deliberately -- see this file's header.
    const discovery = await discoverCli(specFor(cliId), discoveryDeps);
    if (pending.cancelled || disposing) return abortPending(requestId, undefined);
    if (discovery.status !== 'found') {
      turns.delete(requestId);
      throw new Error(`Cli: cannot start "${cliId}" -- discovery reported "${discovery.status}".`);
    }

    // Confined the same way `spawnCliTurn` itself confines it (this is a
    // SECOND, independent check -- `requireRequestId` above is the first)
    // and computed before the one filesystem call that follows it.
    const cwd = confineCwd(spawnDeps.path, options.turnRoot, requestId);
    await fsOps.mkdir(cwd);
    if (pending.cancelled || disposing) return abortPending(requestId, cwd);

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
          void fsOps.rm(cwd).catch(() => undefined);
        },
      },
      spawnDeps,
    );

    pending.handle = handle;
    return { requestId };
  }

  function cancelTurn(ownerId: number, raw: unknown): void {
    const requestId = requireRequestId(asRecord(raw));
    const turn = turns.get(requestId);
    // Already ended (or never existed): cancelling it is a no-op, the same
    // contract `spawnCliTurn`'s own `cancel()` keeps.
    if (turn === undefined) return;
    if (turn.ownerId !== ownerId) {
      throw new Error('Cli: refusing to cancel a turn started by a different window.');
    }
    if (turn.handle !== undefined) turn.handle.cancel();
    else turn.cancelled = true;
  }

  /** Cancel (or mark cancelled, if still pending) every turn matching `predicate`. Shared by `releaseRenderer` and `disposeAll`. */
  function cancelWhere(predicate: (ownerId: number) => boolean): void {
    for (const turn of turns.values()) {
      if (!predicate(turn.ownerId)) continue;
      if (turn.handle !== undefined) turn.handle.cancel();
      else turn.cancelled = true;
    }
  }

  function releaseRenderer(ownerId: number): void {
    cancelWhere((candidate) => candidate === ownerId);
  }

  function disposeAll(): void {
    disposing = true;
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
