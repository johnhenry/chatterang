import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { CLI_ENV_ALLOWLIST, buildCliEnv, confineCwd, spawnCliTurn } from '@chatterang/desktop/bridge';
import type { CliChildProcess, CliSpawnDeps, CliTurnExit } from '@chatterang/desktop/bridge';

/**
 * spawnCliTurn (#42, #113, #115), exercised against a FAKE node CLI script
 * (`tests/fixtures/cli/fake-cli-*.mjs`) — never one of the real CLIs. Every
 * `it` here maps onto one of the four guarantees `cli-turns.ts`'s header
 * names.
 *
 * `cli-turns.ts` takes every Node effect as an injected {@link CliSpawnDeps}
 * (`tests/layering.test.ts`'s "the desktop bridge stays platform-free" guard
 * bans `node:child_process`/`node:path` from that file directly) — this test
 * file is where the REAL ones are built and handed in, the same role
 * `apps/desktop/src/main.ts` will eventually have in production.
 */

const FIXTURES = resolve(process.cwd(), 'tests/fixtures/cli');
const REPLAY_SCRIPT = join(FIXTURES, 'fake-cli-replay.mjs');
const HANG_SCRIPT = join(FIXTURES, 'fake-cli-hang.mjs');
const NODE = process.execPath; // absolute, per #116 — never a bare 'node'

const REAL_DEPS: CliSpawnDeps = {
  path: { resolve, relative, isAbsolute },
  spawn: (binaryPath, args, options) =>
    spawn(binaryPath, args, {
      cwd: options.cwd,
      env: options.env,
      detached: options.detached,
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as unknown as CliChildProcess,
  killProcessGroup: (pid, signal) => {
    // Negative pid: the whole POSIX process group, not just `pid` itself.
    process.kill(-pid, signal as NodeJS.Signals);
  },
};

let workRoot: string;

afterEach(() => {
  if (workRoot) rmSync(workRoot, { recursive: true, force: true });
});

function freshCwd(): string {
  workRoot = mkdtempSync(join(tmpdir(), 'chatterang-cli-turn-'));
  return workRoot;
}

describe('buildCliEnv (#113)', () => {
  it('carries over only PATH and HOME from the parent environment by default', () => {
    const env = buildCliEnv({ PATH: '/usr/bin', HOME: '/Users/x', ANTHROPIC_API_KEY: 'sk-secret', OTHER: 'y' });
    expect(env).toEqual({ PATH: '/usr/bin', HOME: '/Users/x' });
  });

  it('never widens its own default allowlist as a side effect of being called', () => {
    buildCliEnv({ PATH: '/a', HOME: '/b', SNEAKY: 'x' }, ['SNEAKY']);
    expect(CLI_ENV_ALLOWLIST).toEqual(['PATH', 'HOME']);
  });

  it('adds an explicit extra key when named, and only that key', () => {
    const env = buildCliEnv({ PATH: '/usr/bin', HOME: '/h', GEMINI_API_KEY: 'k', OTHER: 'z' }, ['GEMINI_API_KEY']);
    expect(env).toEqual({ PATH: '/usr/bin', HOME: '/h', GEMINI_API_KEY: 'k' });
  });

  it('omits an allowlisted key the parent never set, rather than writing it as undefined', () => {
    const env = buildCliEnv({ PATH: '/usr/bin' });
    expect(env).toEqual({ PATH: '/usr/bin' });
    expect('HOME' in env).toBe(false);
  });
});

describe('confineCwd (#115)', () => {
  const path = REAL_DEPS.path;

  it('resolves a cwd inside the root', () => {
    expect(confineCwd(path, '/root', 'sub/dir')).toBe(resolve('/root/sub/dir'));
  });

  it('refuses a relative escape', () => {
    expect(() => confineCwd(path, '/root', '../elsewhere')).toThrow(/outside the confined root/);
  });

  it('refuses an absolute path outside the root even with no relative syntax', () => {
    expect(() => confineCwd(path, '/root', '/etc')).toThrow(/outside the confined root/);
  });

  it('accepts the root itself', () => {
    expect(confineCwd(path, '/root', '/root')).toBe(resolve('/root'));
  });
});

describe('spawnCliTurn refuses a relative binary path (#116)', () => {
  it('throws before spawning anything', () => {
    expect(() =>
      spawnCliTurn(
        {
          binaryPath: 'claude',
          args: [],
          cwd: '.',
          cwdRoot: '.',
          parentEnv: process.env,
          onData: () => {
            throw new Error('must not spawn');
          },
          onExit: () => {
            throw new Error('must not spawn');
          },
        },
        REAL_DEPS,
      ),
    ).toThrow(/absolute path/);
  });
});

describe('spawnCliTurn against a fake CLI that replays a fixture (#115, #120)', () => {
  it('relays the fixture bytes via onData and reports exactly one clean exit', async () => {
    const cwd = freshCwd();
    const chunks: Uint8Array[] = [];
    const exits: CliTurnExit[] = [];

    await new Promise<void>((resolveDone) => {
      spawnCliTurn(
        {
          binaryPath: NODE,
          args: [REPLAY_SCRIPT, 'claude-pong.jsonl'],
          cwd,
          cwdRoot: cwd,
          parentEnv: process.env,
          onData: (chunk, stream) => {
            if (stream === 'stdout') chunks.push(chunk);
          },
          onExit: (exit) => {
            exits.push(exit);
            resolveDone();
          },
        },
        REAL_DEPS,
      );
    });

    expect(exits).toHaveLength(1);
    expect(exits[0]).toEqual({ code: 0, signal: null });
    const decoded = chunks.map((chunk) => new TextDecoder().decode(chunk)).join('');
    const real = readFileSync(join(FIXTURES, 'claude-pong.jsonl'), 'utf8');
    expect(decoded).toBe(real);
  });

  it("confines the child's cwd to the directory this turn was given", async () => {
    const cwd = freshCwd();
    let stderrText = '';

    await new Promise<void>((resolveDone) => {
      spawnCliTurn(
        {
          binaryPath: NODE,
          args: [REPLAY_SCRIPT, 'claude-pong.jsonl'],
          cwd,
          cwdRoot: cwd,
          parentEnv: process.env,
          onData: (chunk, stream) => {
            if (stream === 'stderr') stderrText += new TextDecoder().decode(chunk);
          },
          onExit: () => resolveDone(),
        },
        REAL_DEPS,
      );
    });

    const reported = JSON.parse(stderrText.trim().split('\n')[0] ?? '{}') as { cwd: string };
    // realpath, not plain resolve: macOS's /var is itself a symlink to
    // /private/var, and process.cwd() in the child reports the resolved
    // form, which is a filesystem quirk, not something confineCwd controls.
    expect(reported.cwd).toBe(realpathSync(resolve(cwd)));
  });

  it('gives the child only the allowlisted env vars, never this process’s full environment', async () => {
    const cwd = freshCwd();
    let stderrText = '';

    await new Promise<void>((resolveDone) => {
      spawnCliTurn(
        {
          binaryPath: NODE,
          args: [REPLAY_SCRIPT, 'claude-pong.jsonl'],
          cwd,
          cwdRoot: cwd,
          parentEnv: { ...process.env, TOTALLY_UNRELATED_SECRET: 'sk-should-not-appear' },
          onData: (chunk, stream) => {
            if (stream === 'stderr') stderrText += new TextDecoder().decode(chunk);
          },
          onExit: () => resolveDone(),
        },
        REAL_DEPS,
      );
    });

    const reported = JSON.parse(stderrText.trim().split('\n')[0] ?? '{}') as { envKeys: string[] };
    // The one assertion this test exists for: a var this call never
    // allowlisted, and that only `process.env`'s spread would have carried
    // over, must not reach the child.
    expect(reported.envKeys).not.toContain('TOTALLY_UNRELATED_SECRET');
    // Every var THIS APP is responsible for choosing is allowlisted. A macOS
    // child process also carries a small number of vars the OS/dyld injects
    // itself (e.g. `__CF_USER_TEXT_ENCODING`) regardless of what `env:` names
    // — that is a platform fact `buildCliEnv` has no control over, not a
    // second door this test is checking for.
    expect(reported.envKeys).toContain('PATH');
    expect(reported.envKeys).not.toContain('ANTHROPIC_API_KEY');
    expect(reported.envKeys).not.toContain('OPENAI_API_KEY');
  });

  it('writes structured stdin verbatim, building none of it itself', async () => {
    const cwd = freshCwd();
    const written = '{"type":"user","message":{"role":"user","content":"hi"}}\n';
    let stdoutText = '';

    // A script that echoes stdin back, to prove what was written arrives
    // byte-for-byte and nothing else is prepended.
    const echoScript = join(cwd, 'echo-stdin.mjs');
    writeFileSync(echoScript, "process.stdin.on('data', (c) => process.stdout.write(c));\n");

    await new Promise<void>((resolveDone) => {
      spawnCliTurn(
        {
          binaryPath: NODE,
          args: [echoScript],
          cwd,
          cwdRoot: cwd,
          parentEnv: process.env,
          stdin: written,
          onData: (chunk, stream) => {
            if (stream === 'stdout') stdoutText += new TextDecoder().decode(chunk);
          },
          onExit: () => resolveDone(),
        },
        REAL_DEPS,
      );
    });

    expect(stdoutText).toBe(written);
  });
});

describe('spawnCliTurn calls onExit exactly once (#120)', () => {
  it('reports exactly one exit for a binary that does not exist (ENOENT)', async () => {
    const cwd = freshCwd();
    const exits: CliTurnExit[] = [];

    await new Promise<void>((resolveDone) => {
      spawnCliTurn(
        {
          binaryPath: '/absolutely/does/not/exist/claude',
          args: [],
          cwd,
          cwdRoot: cwd,
          parentEnv: process.env,
          onData: () => {},
          onExit: (exit) => {
            exits.push(exit);
            resolveDone();
          },
        },
        REAL_DEPS,
      );
      // Node's 'error' and 'close' can both fire for a spawn that never
      // started; give the second event a chance to arrive before asserting.
      setTimeout(resolveDone, 300);
    });

    expect(exits).toHaveLength(1);
  });
});

describe('spawnCliTurn.cancel() kills the whole process group (#115)', () => {
  it('terminates both the immediate child and its own grandchild', async () => {
    const cwd = freshCwd();
    let stderrText = '';
    let exit: CliTurnExit | undefined;

    const handle = await new Promise<ReturnType<typeof spawnCliTurn>>((resolveHandle) => {
      const h = spawnCliTurn(
        {
          binaryPath: NODE,
          args: [HANG_SCRIPT],
          cwd,
          cwdRoot: cwd,
          parentEnv: process.env,
          onData: (chunk, stream) => {
            if (stream === 'stderr') {
              stderrText += new TextDecoder().decode(chunk);
              if (stderrText.includes('grandchildPid')) resolveHandle(h);
            }
          },
          onExit: (e) => {
            exit = e;
          },
        },
        REAL_DEPS,
      );
    });

    const { pid, grandchildPid } = JSON.parse(stderrText.trim().split('\n')[0] ?? '{}') as {
      pid: number;
      grandchildPid: number;
    };

    handle.cancel();

    // Poll until the OS confirms both pids are gone (bounded, not a fixed sleep count).
    const deadline = Date.now() + 5000;
    const isAlive = (checkPid: number): boolean => {
      try {
        process.kill(checkPid, 0);
        return true;
      } catch {
        return false;
      }
    };
    while ((isAlive(pid) || isAlive(grandchildPid)) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }

    expect(isAlive(pid)).toBe(false);
    expect(isAlive(grandchildPid)).toBe(false);
    expect(exit?.signal).toBe('SIGTERM');
  }, 10000);

  it('is a no-op, not a throw, when called after the process already exited', async () => {
    const cwd = freshCwd();
    const handle = await new Promise<ReturnType<typeof spawnCliTurn>>((resolveHandle) => {
      const h = spawnCliTurn(
        {
          binaryPath: NODE,
          args: [REPLAY_SCRIPT, 'claude-pong.jsonl'],
          cwd,
          cwdRoot: cwd,
          parentEnv: process.env,
          onData: () => {},
          onExit: () => resolveHandle(h),
        },
        REAL_DEPS,
      );
    });
    expect(() => handle.cancel()).not.toThrow();
  });
});
