import { describe, expect, it } from 'vitest';

import {
  discoverCli,
  type CliBinarySpec,
  type CliDiscoveryDeps,
  type CliExecResult,
} from '@chatterang/desktop/bridge';

/**
 * FINDING A LOCAL AGENT CLI (#116), MEASURED WITH A FAKE SHELL AND A FAKE
 * FILESYSTEM — never the real ones, per #116's own ruling that even the
 * probe is an accepted risk to be taken sparingly, not something to exercise
 * on every test run.
 *
 * The four failure states, plus the success state, are exactly the five
 * `CliDiscovery` can be. Each `it` below drives `discoverCli` to exactly one
 * of them and nothing else, so a mutation that collapses two states into one
 * fails a named test rather than a generic "discovery changed" assertion.
 */

const OK: CliExecResult = { stdout: '', stderr: '', code: 0 };

function claudeSpec(overrides: Partial<CliBinarySpec> = {}): CliBinarySpec {
  return {
    id: 'claude',
    command: 'claude',
    versionArgs: ['--version'],
    parseVersion: (result) => /^(\d+\.\d+\.\d+)/.exec(result.stdout)?.[1],
    signedInArgs: ['--version'],
    isSignedIn: (result) => result.code === 0,
    ...overrides,
  };
}

describe('discoverCli (#116)', () => {
  it('reports not-found when the login shell resolves nothing', async () => {
    const deps: CliDiscoveryDeps = {
      resolveBinary: async () => undefined,
      stat: async () => {
        throw new Error('must not be called once resolution failed');
      },
      exec: async () => {
        throw new Error('must not be called once resolution failed');
      },
    };
    await expect(discoverCli(claudeSpec(), deps)).resolves.toEqual({
      status: 'not-found',
      id: 'claude',
    });
  });

  it('reports not-executable for a resolved path with no execute bit, without running it', async () => {
    let exec = 0;
    const deps: CliDiscoveryDeps = {
      resolveBinary: async () => '/opt/homebrew/bin/claude',
      stat: async () => ({ executable: false }),
      exec: async () => {
        exec += 1;
        return OK;
      },
    };
    await expect(discoverCli(claudeSpec(), deps)).resolves.toEqual({
      status: 'not-executable',
      id: 'claude',
      path: '/opt/homebrew/bin/claude',
    });
    expect(exec).toBe(0);
  });

  it('reports not-executable when the resolved path no longer exists (stat returns undefined)', async () => {
    const deps: CliDiscoveryDeps = {
      resolveBinary: async () => '/opt/homebrew/bin/claude',
      stat: async () => undefined,
      exec: async () => OK,
    };
    await expect(discoverCli(claudeSpec(), deps)).resolves.toEqual({
      status: 'not-executable',
      id: 'claude',
      path: '/opt/homebrew/bin/claude',
    });
  });

  it('reports version-unreadable when the version run cannot be parsed, without checking sign-in', async () => {
    let signInChecked = false;
    const spec = claudeSpec({
      isSignedIn: () => {
        signInChecked = true;
        return true;
      },
    });
    const deps: CliDiscoveryDeps = {
      resolveBinary: async () => '/opt/homebrew/bin/claude',
      stat: async () => ({ executable: true }),
      exec: async () => ({ stdout: 'unexpected garbage', stderr: '', code: 0 }),
    };
    await expect(discoverCli(spec, deps)).resolves.toEqual({
      status: 'version-unreadable',
      id: 'claude',
      path: '/opt/homebrew/bin/claude',
    });
    expect(signInChecked).toBe(false);
  });

  it('reports not-signed-in with the version already captured', async () => {
    const deps: CliDiscoveryDeps = {
      resolveBinary: async () => '/opt/homebrew/bin/claude',
      stat: async () => ({ executable: true }),
      exec: async () => ({ stdout: '2.1.0 (Claude Code)', stderr: 'not logged in', code: 1 }),
    };
    await expect(discoverCli(claudeSpec(), deps)).resolves.toEqual({
      status: 'not-signed-in',
      id: 'claude',
      path: '/opt/homebrew/bin/claude',
      version: '2.1.0',
    });
  });

  it('reports found with the resolved path and version when every check passes', async () => {
    const deps: CliDiscoveryDeps = {
      resolveBinary: async () => '/opt/homebrew/bin/claude',
      stat: async () => ({ executable: true }),
      exec: async () => ({ stdout: '2.1.0 (Claude Code)', stderr: '', code: 0 }),
    };
    await expect(discoverCli(claudeSpec(), deps)).resolves.toEqual({
      status: 'found',
      id: 'claude',
      path: '/opt/homebrew/bin/claude',
      version: '2.1.0',
    });
  });

  it('runs a second probe when signedInArgs is a different invocation from versionArgs', async () => {
    const execCalls: (readonly string[])[] = [];
    const spec = claudeSpec({
      parseVersion: () => '9.9.9',
      signedInArgs: ['whoami'],
      isSignedIn: (result) => result.code === 0,
    });
    const deps: CliDiscoveryDeps = {
      resolveBinary: async () => '/opt/homebrew/bin/claude',
      stat: async () => ({ executable: true }),
      exec: async (_path, args) => {
        execCalls.push(args);
        return args[0] === 'whoami' ? { stdout: 'me', stderr: '', code: 0 } : OK;
      },
    };
    const result = await discoverCli(spec, deps);
    expect(result).toEqual({
      status: 'found',
      id: 'claude',
      path: '/opt/homebrew/bin/claude',
      version: '9.9.9',
    });
    expect(execCalls).toEqual([['--version'], ['whoami']]);
  });

  it('skips the second probe when a spec deliberately shares one array for both', async () => {
    // A CLI whose version run and sign-in check are the same invocation (the
    // common case #115 names for `claude`/`gemini`) can say so by passing the
    // SAME array to both fields, and `discoverCli` then runs it once.
    const sharedArgs = ['--version'];
    const execCalls: (readonly string[])[] = [];
    const spec = claudeSpec({
      parseVersion: () => '2.1.0',
      versionArgs: sharedArgs,
      signedInArgs: sharedArgs,
      isSignedIn: () => true,
    });
    const deps: CliDiscoveryDeps = {
      resolveBinary: async () => '/opt/homebrew/bin/claude',
      stat: async () => ({ executable: true }),
      exec: async (_path, args) => {
        execCalls.push(args);
        return OK;
      },
    };
    const result = await discoverCli(spec, deps);
    expect(result).toEqual({
      status: 'found',
      id: 'claude',
      path: '/opt/homebrew/bin/claude',
      version: '2.1.0',
    });
    expect(execCalls).toEqual([['--version']]);
  });
});
