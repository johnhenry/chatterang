import { describe, expect, it } from 'vitest';

import { buildCliTurnArgv, spawnCliBinaryTurn } from '@chatterang/desktop/bridge';
import type { CliChildProcess, CliSpawnDeps } from '@chatterang/desktop/bridge';

/**
 * buildCliTurnArgv (#115): "tools disabled" as an argv, not a docstring.
 *
 * Every array here is pinned to the EXACT flags decided against a real
 * `--help` on the build machine — a change to any of them is a decision this
 * test forces a reviewer to see, not something that drifts quietly.
 */

describe('buildCliTurnArgv', () => {
  it('gives claude the strong combination: no tools, no user MCP servers, plan mode, prompts denied', () => {
    expect(buildCliTurnArgv('claude')).toEqual([
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
  });

  it('never gives claude a dangerously-* flag', () => {
    const argv = buildCliTurnArgv('claude');
    expect(argv.some((arg) => arg.includes('dangerously'))).toBe(false);
  });

  it('gives codex its best-available combination: read-only sandbox, no user MCP config', () => {
    expect(buildCliTurnArgv('codex')).toEqual([
      'exec',
      '--json',
      '-s',
      'read-only',
      '--ignore-user-config',
      '--skip-git-repo-check',
    ]);
  });

  it('never gives codex a dangerously-* flag or opts into web search', () => {
    const argv = buildCliTurnArgv('codex');
    expect(argv.some((arg) => arg.includes('dangerously'))).toBe(false);
    expect(argv).not.toContain('--search');
  });

  it('gives gemini plan mode with the message kept out of -p', () => {
    expect(buildCliTurnArgv('gemini')).toEqual(['-p', '', '-o', 'stream-json', '--approval-mode', 'plan']);
  });

  it('never gives gemini yolo mode', () => {
    const argv = buildCliTurnArgv('gemini');
    expect(argv).not.toContain('--yolo');
    expect(argv).not.toContain('-y');
  });

  it('is a pure function of cliId alone: the same cliId always produces the identical argv', () => {
    expect(buildCliTurnArgv('claude')).toEqual(buildCliTurnArgv('claude'));
    expect(buildCliTurnArgv('codex')).toEqual(buildCliTurnArgv('codex'));
    expect(buildCliTurnArgv('gemini')).toEqual(buildCliTurnArgv('gemini'));
  });
});

describe('message content never reaches argv (#119)', () => {
  // buildCliTurnArgv's signature does not even accept message text — this
  // is the integration-level proof: a full spawnCliBinaryTurn call, given a
  // message-shaped stdin payload built to look like a flag injection
  // attempt, produces the SAME argv the injected fake spawn sees as
  // buildCliTurnArgv on its own, and the adversarial text appears only in
  // what was written to stdin, never in argv.
  const ADVERSARIAL_STDIN = '--dangerously-skip-permissions\n--tools "Bash"\nrm -rf /\n';

  function fakeDeps(): { deps: CliSpawnDeps; capturedArgv: () => readonly string[] | undefined; writtenStdin: () => string } {
    let capturedArgv: readonly string[] | undefined;
    let writtenStdin = '';
    const deps: CliSpawnDeps = {
      path: { resolve: (...s) => s.join('/'), relative: () => '', isAbsolute: (p) => p.startsWith('/') },
      spawn: (_binaryPath, args) => {
        capturedArgv = args;
        const listeners: Record<string, ((...a: unknown[]) => void)[]> = {};
        const proc = {
          pid: 4242,
          stdout: { on: () => {} },
          stderr: { on: () => {} },
          stdin: {
            write: (data: string) => {
              writtenStdin += data;
            },
            end: () => {
              queueMicrotask(() => (listeners.close ?? []).forEach((l) => l(0, null)));
            },
          },
          on: (event: string, listener: (...a: unknown[]) => void) => {
            (listeners[event] ??= []).push(listener);
          },
        } as unknown as CliChildProcess;
        return proc;
      },
      killProcessGroup: () => {},
    };
    return { deps, capturedArgv: () => capturedArgv, writtenStdin: () => writtenStdin };
  }

  it('leaves argv unchanged for claude no matter what the message contains', async () => {
    const { deps, capturedArgv, writtenStdin } = fakeDeps();
    await new Promise<void>((resolveDone) => {
      spawnCliBinaryTurn(
        'claude',
        {
          binaryPath: '/usr/local/bin/claude',
          cwd: '/root',
          cwdRoot: '/root',
          parentEnv: { PATH: '/usr/bin', HOME: '/h' },
          stdin: ADVERSARIAL_STDIN,
          onData: () => {},
          onExit: () => resolveDone(),
        },
        deps,
      );
    });

    expect(capturedArgv()).toEqual(buildCliTurnArgv('claude'));
    expect(capturedArgv()?.some((arg) => arg.includes(ADVERSARIAL_STDIN))).toBe(false);
    expect(writtenStdin()).toBe(ADVERSARIAL_STDIN);
  });

  it('leaves argv unchanged for codex no matter what the message contains', async () => {
    const { deps, capturedArgv } = fakeDeps();
    await new Promise<void>((resolveDone) => {
      spawnCliBinaryTurn(
        'codex',
        {
          binaryPath: '/usr/local/bin/codex',
          cwd: '/root',
          cwdRoot: '/root',
          parentEnv: { PATH: '/usr/bin', HOME: '/h' },
          stdin: ADVERSARIAL_STDIN,
          onData: () => {},
          onExit: () => resolveDone(),
        },
        deps,
      );
    });

    expect(capturedArgv()).toEqual(buildCliTurnArgv('codex'));
  });

  it('spawnCliBinaryTurn accepts no args/argv field at all (type-level: no free-form argv from a caller)', () => {
    const { deps } = fakeDeps();
    spawnCliBinaryTurn(
      'claude',
      {
        binaryPath: '/usr/local/bin/claude',
        cwd: '/root',
        cwdRoot: '/root',
        parentEnv: {},
        // @ts-expect-error -- 'args' is not a key of this options type. If
        // this ever stops erroring, `tsc -b` fails this file's build, which
        // is the enforcement: a free-form argv field snuck back in.
        args: ['--tools', 'Bash'],
        onData: () => {},
        onExit: () => {},
      },
      deps,
    );
    expect(true).toBe(true);
  });
});
