/**
 * TAXONOMY FOR A LOCAL AGENT CLI AS A CHAT TARGET (#5, #39, #108, #115).
 *
 * `claude`, `codex` and `gemini`, run as a subprocess on this device, fit
 * none of the four things a `ChatTarget` could already be: not `local` (the
 * reply is not on-device inference — it comes from whatever vendor the CLI is
 * signed in to), not `remote` (there is no provider connection, no base URL,
 * no key this app holds), not `paired` (there is no other device), not
 * `refused`/`none` (a turn does run). `tests/reach.test.ts` already measures
 * `reachOf`'s new `cli` case in detail, alongside the rest of the reach
 * taxonomy it owns; this file is the narrower thing #108's "Done" list asks
 * for on its own — `ProviderKind` gaining a member — plus the guard that a
 * local CLI never becomes benchmarkable, which is #119's explicit warning.
 */

import { describe, expect, it } from 'vitest';

import type { ProviderKind } from '@/ai/providers';
import { BENCHMARKABLE_ENGINES } from '@/domain/manifest';
import type { CliSource } from '@/ui/target';

describe('the provider-catalog kind for a local CLI (#108)', () => {
  it('accepts "local-cli" as a ProviderKind', () => {
    // A type-level assertion has no runtime shape to break by itself, so this
    // pins it the way this codebase pins a literal union elsewhere: a value
    // that only compiles if the member exists, checked by both gates
    // (`npm run typecheck` catches a removed member; this line existing at
    // all is what a reviewer diffs away to confirm the fail-first claim).
    const kind: ProviderKind = 'local-cli';
    expect(kind).toBe('local-cli');
  });
});

describe('a local CLI is never benchmarkable (#119)', () => {
  it('is not among the engines the on-device benchmark harness drives', () => {
    // `canBenchmark` hands a model's `engine` to `LlamaCpp.load`, which is
    // meaningless for a subprocess with no GGUF file. None of the three CLIs'
    // ids can appear in this list without a benchmark harness for them
    // existing first, which is not this pass's work.
    const cliIds = ['claude', 'codex', 'gemini', 'cli', 'local-cli'];
    for (const id of cliIds) {
      expect(BENCHMARKABLE_ENGINES as readonly string[]).not.toContain(id);
    }
  });
});

describe('CliSource, exported for a later persona track (#5) to reference', () => {
  it('is the minimal structural shape reachOf and the picker need', () => {
    const source: CliSource = { id: 'claude', label: 'Claude Code' };
    expect(source.id).toBe('claude');
    expect(source.label).toBe('Claude Code');
  });
});
