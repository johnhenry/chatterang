import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { mkdir as realMkdir, rm as realRm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { CLI_PLUGIN, PluginHost } from '@chatterang/desktop/bridge';
import type { CliChildProcess, CliDiscoveryDeps, CliSpawnDeps } from '@chatterang/desktop/bridge';
import { createCliPlugin } from '../apps/desktop/src/cli/cli-plugin.js';
import type { CliPluginFsOps } from '../apps/desktop/src/cli/cli-plugin.js';

/**
 * `Cli`, THROUGH A REAL `PluginHost` (#42, #115, #116, #118) — the same shape
 * `tests/pairing-desktop-socket.test.ts` drives `TunnelSocket` through: every
 * method via `PluginHost.invoke` (so a call is stamped with its sender and
 * checked for cloneability the same way a real renderer's would be), every
 * event via `PluginHost.addListener`/`notifyListeners`, cloned on delivery.
 *
 * NEVER A REAL CLI. `createCliPlugin`'s `discoveryDeps`/`spawnDeps` are
 * overridden to point at `tests/fixtures/cli/fake-cli-*.mjs` — the same fake
 * scripts `tests/desktop-cli-turns.test.ts` already spawns directly. Here
 * they are reached the long way: `discover`/`startTurn` -> `spawnCliBinaryTurn`
 * -> the fake script, so the real `PluginHost` registration, sender-scoping
 * and event delivery are what is being measured, not the spawn mechanics
 * (already covered).
 */

const FIXTURES = resolve(process.cwd(), 'tests/fixtures/cli');
const REPLAY_SCRIPT = join(FIXTURES, 'fake-cli-replay.mjs');
const HANG_SCRIPT = join(FIXTURES, 'fake-cli-hang.mjs');

const OWNER = 7;
const OTHER_OWNER = 8;

let turnRoot: string;
afterEach(() => {
  if (turnRoot) rmSync(turnRoot, { recursive: true, force: true });
});

function freshTurnRoot(): string {
  turnRoot = mkdtempSync(join(tmpdir(), 'chatterang-cli-plugin-'));
  return turnRoot;
}

/** Resolves 'claude' to a fake script; answers claude's real discovery checks with fixed, fake data. */
function fakeDiscoveryDeps(scriptPath: string): CliDiscoveryDeps {
  return {
    resolveBinary: async (command) => (command === 'claude' ? scriptPath : undefined),
    stat: async () => ({ executable: true }),
    exec: async (_path, args) =>
      args[0] === 'auth'
        ? { stdout: '{"loggedIn":true}', stderr: '', code: 0 }
        : { stdout: '2.1.263 (Claude Code)', stderr: '', code: 0 },
  };
}

/** Real node:child_process, real node:path -- safe here because the target is always a fake script, never a real CLI. */
const REAL_SPAWN_DEPS: CliSpawnDeps = {
  path: { resolve, relative, isAbsolute },
  spawn: (binaryPath, args, options) =>
    spawn(binaryPath, args, {
      cwd: options.cwd,
      env: options.env,
      detached: options.detached,
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as unknown as CliChildProcess,
  killProcessGroup: (pid, signal) => {
    process.kill(-pid, signal as NodeJS.Signals);
  },
};

/** One PluginHost, one Cli registration, and a tiny renderer-shaped driver over it -- mirrors `desktopSocket()` in tests/pairing-desktop-socket.test.ts. */
function stand(
  scriptPath: string,
  overrides: { discoveryDeps?: CliDiscoveryDeps; fsOps?: CliPluginFsOps } = {},
) {
  const subscribers = new Map<string, (event: unknown) => void>();
  const host = new PluginHost((senderId, payload) => {
    const key = `${senderId}:${payload.subscriptionId}`;
    const listener = subscribers.get(key);
    if (listener === undefined) return false;
    listener(structuredClone(payload.data));
    return true;
  });
  const root = freshTurnRoot();
  const cliPlugin = createCliPlugin({
    turnRoot: root,
    notify: (eventName, data, ownerId) => host.notifyListeners(CLI_PLUGIN.name, eventName, data, ownerId),
    discoveryDeps: overrides.discoveryDeps ?? fakeDiscoveryDeps(scriptPath),
    spawnDeps: REAL_SPAWN_DEPS,
    ...(overrides.fsOps !== undefined ? { fsOps: overrides.fsOps } : {}),
  });
  host.register(CLI_PLUGIN, cliPlugin);

  let nextSubscription = 0;
  const listen = (ownerId: number, eventName: string, listener: (event: unknown) => void): void => {
    nextSubscription += 1;
    host.addListener(ownerId, CLI_PLUGIN.name, eventName, nextSubscription);
    subscribers.set(`${ownerId}:${nextSubscription}`, listener);
  };

  // The two teardown methods `main.ts` calls DIRECTLY on the object
  // `createCliPlugin` returns -- never through `host.invoke`, since they are
  // not in `CLI_PLUGIN.methods` and a renderer has no way to reach them.
  return { host, listen, cliPlugin, root };
}

describe('discover, through PluginHost (#116: explicit add, never ambient)', () => {
  it('reports found for the fake script standing in for claude', async () => {
    const { host } = stand(REPLAY_SCRIPT);
    const result = await host.invoke(OWNER, CLI_PLUGIN.name, 'discover', [{ cliId: 'claude' }]);
    expect(result).toEqual({ status: 'found', id: 'claude', path: REPLAY_SCRIPT, version: '2.1.263' });
  });

  it('reports not-found for a CLI discovery was not told to resolve', async () => {
    const { host } = stand(REPLAY_SCRIPT);
    const result = await host.invoke(OWNER, CLI_PLUGIN.name, 'discover', [{ cliId: 'codex' }]);
    expect(result).toEqual({ status: 'not-found', id: 'codex' });
  });
});

describe('startTurn streams a real turn through a real PluginHost, cliExit is the one terminal (#118, #120)', () => {
  it('delivers cliData chunks and one cliExit to the owner that started the turn', async () => {
    const { host, listen } = stand(REPLAY_SCRIPT);
    const chunks: { readonly stream: string; readonly chunk: Uint8Array }[] = [];
    const exits: unknown[] = [];

    await new Promise<void>((resolveDone) => {
      listen(OWNER, 'cliData', (event) => {
        chunks.push(event as { readonly stream: string; readonly chunk: Uint8Array });
      });
      listen(OWNER, 'cliExit', (event) => {
        exits.push(event);
        resolveDone();
      });
      void host.invoke(OWNER, CLI_PLUGIN.name, 'startTurn', [
        { requestId: 'req-1', cliId: 'claude', stdin: '{"type":"user","message":{"role":"user","content":"hi"}}\n' },
      ]);
    });

    expect(exits).toHaveLength(1);
    expect(exits[0]).toMatchObject({ requestId: 'req-1', code: 0, signal: null });
    const stdout = chunks.filter((c) => c.stream === 'stdout').map((c) => c.chunk);
    const decoded = stdout.map((chunk) => new TextDecoder().decode(chunk)).join('');
    expect(decoded.length).toBeGreaterThan(0);
    expect(decoded).toContain('"type":"result"');
  });

  it('never delivers a cliData/cliExit event to a window that did not start the turn', async () => {
    const { host, listen } = stand(REPLAY_SCRIPT);
    const ownerEvents: string[] = [];
    const otherEvents: string[] = [];

    await new Promise<void>((resolveDone) => {
      listen(OWNER, 'cliExit', () => {
        ownerEvents.push('cliExit');
        resolveDone();
      });
      listen(OTHER_OWNER, 'cliData', () => otherEvents.push('cliData'));
      listen(OTHER_OWNER, 'cliExit', () => otherEvents.push('cliExit'));
      void host.invoke(OWNER, CLI_PLUGIN.name, 'startTurn', [{ requestId: 'req-2', cliId: 'claude' }]);
    });

    expect(ownerEvents).toEqual(['cliExit']);
    expect(otherEvents).toEqual([]);
  });
});

describe('cancelTurn, through PluginHost, kills the whole process group (#115, #118)', () => {
  it('terminates the process and delivers exactly one cliExit with a SIGTERM signal', async () => {
    const { host, listen } = stand(HANG_SCRIPT);
    let pid: number | undefined;
    let grandchildPid: number | undefined;
    const exits: unknown[] = [];

    await new Promise<void>((resolveStarted) => {
      listen(OWNER, 'cliData', (event) => {
        const { stream, chunk } = event as { readonly stream: string; readonly chunk: Uint8Array };
        if (stream !== 'stderr') return;
        const text = new TextDecoder().decode(chunk);
        if (!text.includes('grandchildPid')) return;
        const parsed = JSON.parse(text.trim()) as { pid: number; grandchildPid: number };
        pid = parsed.pid;
        grandchildPid = parsed.grandchildPid;
        resolveStarted();
      });
      void host.invoke(OWNER, CLI_PLUGIN.name, 'startTurn', [{ requestId: 'req-3', cliId: 'claude' }]);
    });

    listen(OWNER, 'cliExit', (event) => exits.push(event));
    await host.invoke(OWNER, CLI_PLUGIN.name, 'cancelTurn', [{ requestId: 'req-3' }]);

    const isAlive = (checkPid: number): boolean => {
      try {
        process.kill(checkPid, 0);
        return true;
      } catch {
        return false;
      }
    };
    const deadline = Date.now() + 5000;
    while ((isAlive(pid!) || isAlive(grandchildPid!)) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }

    expect(isAlive(pid!)).toBe(false);
    expect(isAlive(grandchildPid!)).toBe(false);
    expect(exits).toHaveLength(1);
    expect(exits[0]).toMatchObject({ requestId: 'req-3', signal: 'SIGTERM' });
  }, 10000);

  it('refuses to cancel a turn a different window started', async () => {
    const { host, listen } = stand(HANG_SCRIPT);
    await new Promise<void>((resolveStarted) => {
      listen(OWNER, 'cliData', (event) => {
        const { stream, chunk } = event as { readonly stream: string; readonly chunk: Uint8Array };
        if (stream === 'stderr' && new TextDecoder().decode(chunk).includes('grandchildPid')) resolveStarted();
      });
      void host.invoke(OWNER, CLI_PLUGIN.name, 'startTurn', [{ requestId: 'req-4', cliId: 'claude' }]);
    });

    await expect(host.invoke(OTHER_OWNER, CLI_PLUGIN.name, 'cancelTurn', [{ requestId: 'req-4' }])).rejects.toThrow(
      /different window/,
    );
    // Clean up for real, as OWNER, so the test does not leak a hung process.
    await host.invoke(OWNER, CLI_PLUGIN.name, 'cancelTurn', [{ requestId: 'req-4' }]);
  });

  it('is a no-op, not a throw, when the turn already ended', async () => {
    const { host, listen } = stand(REPLAY_SCRIPT);
    await new Promise<void>((resolveDone) => {
      listen(OWNER, 'cliExit', () => resolveDone());
      void host.invoke(OWNER, CLI_PLUGIN.name, 'startTurn', [{ requestId: 'req-5', cliId: 'claude' }]);
    });
    await expect(host.invoke(OWNER, CLI_PLUGIN.name, 'cancelTurn', [{ requestId: 'req-5' }])).resolves.toBeUndefined();
  });
});

describe('releaseRenderer/disposeAll -- the teardown methods main.ts calls directly, never through PluginHost (#42, #115)', () => {
  async function startHungTurn(
    stood: ReturnType<typeof stand>,
    requestId: string,
    ownerId: number,
  ): Promise<{ pid: number; grandchildPid: number }> {
    return new Promise((resolveStarted) => {
      stood.listen(ownerId, 'cliData', (event) => {
        const { stream, chunk } = event as { readonly stream: string; readonly chunk: Uint8Array };
        if (stream !== 'stderr') return;
        const text = new TextDecoder().decode(chunk);
        if (!text.includes('grandchildPid')) return;
        resolveStarted(JSON.parse(text.trim()) as { pid: number; grandchildPid: number });
      });
      void stood.host.invoke(ownerId, CLI_PLUGIN.name, 'startTurn', [{ requestId, cliId: 'claude' }]);
    });
  }

  function isAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  async function waitUntilDead(...pids: readonly number[]): Promise<void> {
    const deadline = Date.now() + 5000;
    while (pids.some((pid) => isAlive(pid)) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  it('releaseRenderer kills every turn a window owns -- process group, grandchild too -- and turns owned by another window survive', async () => {
    const stood = stand(HANG_SCRIPT);
    const mine = await startHungTurn(stood, 'req-owned', OWNER);
    const theirs = await startHungTurn(stood, 'req-other', OTHER_OWNER);
    const myExits: unknown[] = [];
    stood.listen(OWNER, 'cliExit', (event) => myExits.push(event));

    stood.cliPlugin.releaseRenderer(OWNER);
    await waitUntilDead(mine.pid, mine.grandchildPid);

    expect(isAlive(mine.pid)).toBe(false);
    expect(isAlive(mine.grandchildPid)).toBe(false);
    // Exactly one cliExit for the released turn -- the coordinator's "going
    // nowhere" case is exercised by NOT keeping a listener at all for
    // OTHER_OWNER below; this listener exists only to prove releaseRenderer
    // produces exactly one terminal event, not zero and not two.
    expect(myExits).toHaveLength(1);
    expect(myExits[0]).toMatchObject({ requestId: 'req-owned', signal: 'SIGTERM' });

    // The other window's turn is untouched by releasing THIS window.
    expect(isAlive(theirs.pid)).toBe(true);
    expect(isAlive(theirs.grandchildPid)).toBe(true);

    // Clean up for real, so this test does not leak a hung process.
    stood.cliPlugin.disposeAll();
    await waitUntilDead(theirs.pid, theirs.grandchildPid);
  }, 15000);

  it('releaseRenderer emits its one cliExit even when nothing is listening for it any more (the window is already gone)', async () => {
    const stood = stand(HANG_SCRIPT);
    const mine = await startHungTurn(stood, 'req-gone', OWNER);
    // No listener kept -- simulates the window having already been torn
    // down. `PluginHost.notifyListeners` finding no subscriber is not an
    // error (core PluginHost behaviour, exercised elsewhere); the claim
    // here is narrower: releaseRenderer still reaches the process itself.
    stood.cliPlugin.releaseRenderer(OWNER);
    await waitUntilDead(mine.pid, mine.grandchildPid);
    expect(isAlive(mine.pid)).toBe(false);
    expect(isAlive(mine.grandchildPid)).toBe(false);
  }, 10000);

  it('disposeAll kills every turn regardless of owner', async () => {
    const stood = stand(HANG_SCRIPT);
    const a = await startHungTurn(stood, 'req-a', OWNER);
    const b = await startHungTurn(stood, 'req-b', OTHER_OWNER);

    stood.cliPlugin.disposeAll();
    await waitUntilDead(a.pid, a.grandchildPid, b.pid, b.grandchildPid);

    expect(isAlive(a.pid)).toBe(false);
    expect(isAlive(a.grandchildPid)).toBe(false);
    expect(isAlive(b.pid)).toBe(false);
    expect(isAlive(b.grandchildPid)).toBe(false);
  }, 15000);

  it('both methods are no-ops, not throws, when nothing is running', () => {
    const stood = stand(REPLAY_SCRIPT);
    expect(() => stood.cliPlugin.releaseRenderer(OWNER)).not.toThrow();
    expect(() => stood.cliPlugin.disposeAll()).not.toThrow();
  });
});

describe('a turn cleans up its own scratch cwd (#120: LOW)', () => {
  it('removes <turnRoot>/<requestId> once the turn ends naturally', async () => {
    const stood = stand(REPLAY_SCRIPT);
    let turnCwd: string | undefined;
    await new Promise<void>((resolveDone) => {
      stood.listen(OWNER, 'cliData', (event) => {
        const { stream, chunk } = event as { readonly stream: string; readonly chunk: Uint8Array };
        if (stream !== 'stderr') return;
        const text = new TextDecoder().decode(chunk);
        const parsed = JSON.parse(text.trim()) as { cwd?: string };
        if (parsed.cwd !== undefined) turnCwd = parsed.cwd;
      });
      stood.listen(OWNER, 'cliExit', () => resolveDone());
      void stood.host.invoke(OWNER, CLI_PLUGIN.name, 'startTurn', [{ requestId: 'req-cleanup', cliId: 'claude' }]);
    });

    expect(turnCwd).toBeDefined();
    // Give the fire-and-forget rm() a moment: it runs from inside the same
    // onExit handler that already fired cliExit, but is never awaited by it.
    const deadline = Date.now() + 2000;
    while (existsSync(turnCwd!) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(existsSync(turnCwd!)).toBe(false);
  });

  it('removes the scratch cwd when the turn is cancelled via releaseRenderer/disposeAll too', async () => {
    const stood = stand(HANG_SCRIPT);
    let turnCwd: string | undefined;
    await new Promise<void>((resolveStarted) => {
      stood.listen(OWNER, 'cliData', (event) => {
        const { stream, chunk } = event as { readonly stream: string; readonly chunk: Uint8Array };
        if (stream !== 'stderr') return;
        const text = new TextDecoder().decode(chunk);
        const parsed = JSON.parse(text.trim()) as { grandchildPid?: number };
        if (parsed.grandchildPid !== undefined) resolveStarted();
      });
      void stood.host.invoke(OWNER, CLI_PLUGIN.name, 'startTurn', [{ requestId: 'req-cleanup-2', cliId: 'claude' }]);
    });
    turnCwd = join(turnRoot, 'req-cleanup-2');
    expect(existsSync(turnCwd)).toBe(true);

    stood.cliPlugin.disposeAll();

    const deadline = Date.now() + 5000;
    while (existsSync(turnCwd) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(existsSync(turnCwd)).toBe(false);
  }, 10000);
});

/** A `CliDiscoveryDeps` whose `resolveBinary` suspends until `release()` is called -- lets a test land a release exactly inside `startTurn`'s discovery `await`. */
function gatedDiscoveryDeps(scriptPath: string): { deps: CliDiscoveryDeps; release: () => void } {
  let releaseFn: (() => void) | undefined;
  const gate = new Promise<void>((resolveGate) => {
    releaseFn = resolveGate;
  });
  const deps: CliDiscoveryDeps = {
    resolveBinary: async (command) => {
      await gate;
      return command === 'claude' ? scriptPath : undefined;
    },
    stat: async () => ({ executable: true }),
    exec: async (_path, args) =>
      args[0] === 'auth'
        ? { stdout: '{"loggedIn":true}', stderr: '', code: 0 }
        : { stdout: '2.1.263 (Claude Code)', stderr: '', code: 0 },
  };
  return { deps, release: () => releaseFn?.() };
}

/** A `CliPluginFsOps` whose `mkdir` suspends until `release()` is called -- lets a test land a release exactly inside `startTurn`'s `mkdir` `await`. */
function gatedFsOps(): { fsOps: CliPluginFsOps; release: () => void } {
  let releaseFn: (() => void) | undefined;
  const gate = new Promise<void>((resolveGate) => {
    releaseFn = resolveGate;
  });
  const fsOps: CliPluginFsOps = {
    mkdir: async (path) => {
      await gate;
      await realMkdir(path, { recursive: true });
    },
    rm: async (path) => {
      await realRm(path, { recursive: true, force: true });
    },
  };
  return { fsOps, release: () => releaseFn?.() };
}

describe('the orphan race: releasing WHILE startTurn is still suspended at an await (#42, #115)', () => {
  it('release during discovery -> never spawns', async () => {
    const { deps, release } = gatedDiscoveryDeps(REPLAY_SCRIPT);
    const stood = stand(REPLAY_SCRIPT, { discoveryDeps: deps });

    const startPromise = stood.host.invoke(OWNER, CLI_PLUGIN.name, 'startTurn', [
      { requestId: 'req-race-discovery', cliId: 'claude' },
    ]);
    // Give the event loop a turn so `startTurn` actually reaches and
    // suspends at `await discoverCli(...)` before releasing the renderer.
    await new Promise((r) => setTimeout(r, 10));
    stood.cliPlugin.releaseRenderer(OWNER);
    release(); // let discovery resolve now that the release has landed

    await expect(startPromise).rejects.toThrow(/released before it finished starting/);
    // No process was ever spawned -- no scratch cwd exists for this turn.
    expect(existsSync(join(stood.root, 'req-race-discovery'))).toBe(false);
  });

  it('release during mkdir -> never spawns, and the scratch cwd it created is removed', async () => {
    const { fsOps, release } = gatedFsOps();
    const stood = stand(REPLAY_SCRIPT, { fsOps });

    const startPromise = stood.host.invoke(OWNER, CLI_PLUGIN.name, 'startTurn', [
      { requestId: 'req-race-mkdir', cliId: 'claude' },
    ]);
    await new Promise((r) => setTimeout(r, 10));
    stood.cliPlugin.releaseRenderer(OWNER);
    release(); // let mkdir actually run and resolve now

    await expect(startPromise).rejects.toThrow(/released before it finished starting/);
    // mkdir DID run (the directory was briefly real) but the abort path
    // removed it -- eventually consistent, since the removal is itself async.
    const deadline = Date.now() + 5000;
    const cwd = join(stood.root, 'req-race-mkdir');
    while (existsSync(cwd) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(existsSync(cwd)).toBe(false);
  });

  it('disposeAll during start -> never spawns, and every LATER startTurn is refused too', async () => {
    const { deps, release } = gatedDiscoveryDeps(REPLAY_SCRIPT);
    const stood = stand(REPLAY_SCRIPT, { discoveryDeps: deps });

    const startPromise = stood.host.invoke(OWNER, CLI_PLUGIN.name, 'startTurn', [
      { requestId: 'req-race-dispose', cliId: 'claude' },
    ]);
    await new Promise((r) => setTimeout(r, 10));
    stood.cliPlugin.disposeAll();
    release();

    await expect(startPromise).rejects.toThrow(/released before it finished starting/);
    expect(existsSync(join(stood.root, 'req-race-dispose'))).toBe(false);

    // A later startTurn -- a brand new request, discovery not even gated
    // this time -- is refused outright, because disposeAll's effect persists.
    await expect(
      stood.host.invoke(OWNER, CLI_PLUGIN.name, 'startTurn', [{ requestId: 'req-after-dispose', cliId: 'claude' }]),
    ).rejects.toThrow(/shutting down/);
  });
});

describe("requestId is validated BEFORE any filesystem call, not merely checked non-empty (#120, predates round 2)", () => {
  it('rejects a traversal id and creates no directory anywhere, including outside turnRoot', async () => {
    const stood = stand(REPLAY_SCRIPT);
    const before = readdirSync(dirname(stood.root));

    await expect(
      stood.host.invoke(OWNER, CLI_PLUGIN.name, 'startTurn', [
        { requestId: '../outside-marker', cliId: 'claude' },
      ]),
    ).rejects.toThrow(/requestId/);

    // Nothing was created inside turnRoot...
    expect(existsSync(join(stood.root, '..', 'outside-marker'))).toBe(false);
    // ...and nothing new appeared in turnRoot's OWN parent directory either
    // -- the traversal target this exact id was designed to escape to.
    const after = readdirSync(dirname(stood.root));
    expect(after.sort()).toEqual(before.sort());
  });

  it('rejects every other shape --help never intended a requestId to have', async () => {
    const stood = stand(REPLAY_SCRIPT);
    for (const badId of ['', 'has spaces', 'slash/inside', 'a'.repeat(129), '..', '.']) {
      await expect(
        stood.host.invoke(OWNER, CLI_PLUGIN.name, 'startTurn', [{ requestId: badId, cliId: 'claude' }]),
      ).rejects.toThrow();
    }
  });

  it('accepts the ordinary shape every other test in this file already relies on', async () => {
    const stood = stand(REPLAY_SCRIPT);
    await expect(
      stood.host.invoke(OWNER, CLI_PLUGIN.name, 'startTurn', [{ requestId: 'req-ordinary-1', cliId: 'claude' }]),
    ).resolves.toEqual({ requestId: 'req-ordinary-1' });
  });
});
