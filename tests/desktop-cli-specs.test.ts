import { describe, expect, it } from 'vitest';

import { CLAUDE_SPEC, CLI_SPECS, CODEX_SPEC, GEMINI_SPEC, discoverCli } from '@chatterang/desktop/bridge';
import type { CliDiscoveryDeps, CliExecResult } from '@chatterang/desktop/bridge';

/**
 * THE THREE REAL CliBinarySpecs (#115, #116), exercised with the REAL text
 * each CLI printed on the build machine — captured for `--version` and the
 * sign-in check this file's header comment explains per CLI — never with a
 * live CLI process. `tests/desktop-cli-discovery.test.ts` already covers
 * `discoverCli`'s own state machine with a synthetic spec; this file is
 * narrower: does each REAL spec's `parseVersion`/`isSignedIn` read the REAL
 * strings correctly.
 */

function ok(stdout: string): CliExecResult {
  return { stdout, stderr: '', code: 0 };
}

describe('CLI_SPECS (#115)', () => {
  it('names exactly claude, codex and gemini, in that order', () => {
    expect(CLI_SPECS.map((spec) => spec.id)).toEqual(['claude', 'codex', 'gemini']);
  });
});

describe('CLAUDE_SPEC', () => {
  it('parses the real `claude --version` string', () => {
    expect(CLAUDE_SPEC.parseVersion(ok('2.1.263 (Claude Code)'))).toBe('2.1.263');
  });

  it('reads a real `claude auth status --json` signed-in reply', () => {
    const result = ok('{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty"}');
    expect(CLAUDE_SPEC.isSignedIn(result)).toBe(true);
  });

  it('treats loggedIn:false as signed out', () => {
    expect(CLAUDE_SPEC.isSignedIn(ok('{"loggedIn":false}'))).toBe(false);
  });

  it('treats a non-zero exit or unparsable JSON as signed out, not a throw', () => {
    expect(CLAUDE_SPEC.isSignedIn({ stdout: '', stderr: 'boom', code: 1 })).toBe(false);
    expect(() => CLAUDE_SPEC.isSignedIn(ok('not json'))).not.toThrow();
    expect(CLAUDE_SPEC.isSignedIn(ok('not json'))).toBe(false);
  });
});

describe('CODEX_SPEC', () => {
  it('parses the real `codex --version` string', () => {
    expect(CODEX_SPEC.parseVersion(ok('codex-cli 0.144.1'))).toBe('0.144.1');
  });

  it('reads a real `codex login status` signed-in reply', () => {
    expect(CODEX_SPEC.isSignedIn(ok('Logged in using ChatGPT'))).toBe(true);
  });

  it('treats the documented signed-out phrasing as signed out', () => {
    expect(CODEX_SPEC.isSignedIn(ok('Not logged in'))).toBe(false);
  });
});

describe('GEMINI_SPEC', () => {
  it('parses the real `gemini --version` string', () => {
    expect(GEMINI_SPEC.parseVersion(ok('0.46.0'))).toBe('0.46.0');
  });

  it('shares one array between versionArgs and signedInArgs (no dedicated auth-status subcommand)', () => {
    // Verified against `gemini --help`: no auth/login subcommand exists.
    // `discoverCli` reads this shared reference to skip a second process.
    expect(GEMINI_SPEC.signedInArgs).toBe(GEMINI_SPEC.versionArgs);
  });

  it('treats a successful version run as signed in, and a failed one as not', () => {
    expect(GEMINI_SPEC.isSignedIn(ok('0.46.0'))).toBe(true);
    expect(GEMINI_SPEC.isSignedIn({ stdout: '', stderr: 'GEMINI_API_KEY is required', code: 1 })).toBe(false);
  });
});

describe('discoverCli driven by the real specs, with a fake shell/fs (#116)', () => {
  it('reports found for claude given its real version and auth-status text', async () => {
    const deps: CliDiscoveryDeps = {
      resolveBinary: async () => '/opt/homebrew/bin/claude',
      stat: async () => ({ executable: true }),
      exec: async (_path, args) =>
        args[0] === 'auth'
          ? ok('{"loggedIn":true}')
          : ok('2.1.263 (Claude Code)'),
    };
    await expect(discoverCli(CLAUDE_SPEC, deps)).resolves.toEqual({
      status: 'found',
      id: 'claude',
      path: '/opt/homebrew/bin/claude',
      version: '2.1.263',
    });
  });

  it('reports not-signed-in for codex given its real signed-out phrasing', async () => {
    const deps: CliDiscoveryDeps = {
      resolveBinary: async () => '/usr/local/bin/codex',
      stat: async () => ({ executable: true }),
      exec: async (_path, args) =>
        args[0] === 'login' ? ok('Not logged in') : ok('codex-cli 0.144.1'),
    };
    await expect(discoverCli(CODEX_SPEC, deps)).resolves.toEqual({
      status: 'not-signed-in',
      id: 'codex',
      path: '/usr/local/bin/codex',
      version: '0.144.1',
    });
  });
});
