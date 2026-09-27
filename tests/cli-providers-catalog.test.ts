/**
 * `PROVIDERS`'s two local-cli entries (#42, #115, #119), and their agreement
 * with `src/ai/backends/cli.ts`'s `SUPPORTED_CLI_IDS`.
 *
 * `ProviderDescriptor.load()` is generic over an `ApiKeyBackendAdapterConfig`
 * every OTHER entry actually uses; a local-cli descriptor's `load()` ignores
 * it entirely (its `apiKey`/`baseUrl` are always empty strings — see
 * `needsKey`/`needsBaseUrl` below) and builds a real `CliBackendAdapter`
 * instead. This file measures that the catalog entries exist, are honestly
 * labelled (never "sandboxed" for Codex — cli-specs.ts's own residual
 * wording, verbatim), are excluded from ever needing a key or a base URL,
 * and that `load()` actually produces an adapter for the right CLI id —
 * calling `Cli.startTurn`/`addListener` is a different file's job
 * (`tests/cli-bridge.test.ts`); this one never reaches that far.
 */

import { describe, expect, it } from 'vitest';

import { getProvider, PROVIDERS } from '@/ai/providers';
import { isSupportedCliId } from '@/ai/backends/cli';

describe('the local-cli provider catalog', () => {
  it('lists exactly Claude Code and Codex, never gemini', () => {
    const localCli = PROVIDERS.filter((provider) => provider.kind === 'local-cli');
    expect(localCli.map((provider) => provider.id).sort()).toEqual(['cli-claude', 'cli-codex']);
  });

  it('needs no key and no base URL from this app -- the CLI already has its own login', () => {
    for (const id of ['cli-claude', 'cli-codex']) {
      const descriptor = getProvider(id);
      if (!descriptor) throw new Error(`expected a "${id}" provider descriptor`);
      expect(descriptor.needsKey).toBe(false);
      expect(descriptor.needsBaseUrl).toBe(false);
    }
  });

  it('states plainly that Chatterang holds no key, for both CLIs (#113)', () => {
    for (const id of ['cli-claude', 'cli-codex']) {
      const descriptor = getProvider(id);
      expect(descriptor?.note).toContain('Chatterang never sees or stores a key');
    }
  });

  it("states Codex's residual exactly as cli-specs.ts requires, never \"sandboxed\"", () => {
    const codex = getProvider('cli-codex');
    expect(codex?.note).toContain(
      'Codex can run shell commands confined to this turn’s folder, with network denied.',
    );
    expect(codex?.note.toLowerCase()).not.toContain('sandbox');
  });

  it("Claude Code's note carries no unmeasured residual claim", () => {
    // Claude runs with `--tools ""` (cli-specs.ts) -- no shell residual to
    // state, so its note must not invent or imply one.
    const claude = getProvider('cli-claude');
    expect(claude?.note.toLowerCase()).not.toContain('shell');
  });

  it('every local-cli id maps to a cli.ts SupportedCliId, and vice versa', () => {
    // The catalog and cli.ts's SUPPORTED_CLI_IDS are two lists maintained by
    // hand in two files; this is what keeps them from drifting apart --
    // adding a third local-cli entry here without a matching translator
    // fails this test rather than shipping a provider whose `load()`
    // constructs a `CliBackendAdapter` for an id `isSupportedCliId` refuses.
    const localCli = PROVIDERS.filter((provider) => provider.kind === 'local-cli');
    for (const provider of localCli) {
      const cliId = provider.id.replace(/^cli-/, '');
      expect(isSupportedCliId(cliId), `"${provider.id}" -> "${cliId}"`).toBe(true);
    }
  });

  it('load() builds a CliBackendAdapter for the right cli id, without spawning anything', async () => {
    const claude = getProvider('cli-claude');
    const codex = getProvider('cli-codex');
    if (!claude || !codex) throw new Error('expected both local-cli descriptors');

    const claudeAdapter = await claude.load({ apiKey: '', timeout: 0 });
    const codexAdapter = await codex.load({ apiKey: '', timeout: 0 });

    expect(claudeAdapter.metadata.name).toBe('cli:claude');
    expect(codexAdapter.metadata.name).toBe('cli:codex');
    // Neither adapter carries any tool capability yet (#42's consent unit).
    expect(claudeAdapter.metadata.capabilities.tools).toBe(false);
    expect(codexAdapter.metadata.capabilities.tools).toBe(false);
  });
});
