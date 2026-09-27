/**
 * README.md's Privacy list, held true for the one-time consent gate on an
 * imported/marketplace persona's remote provider (#23, #122).
 *
 * `tests/privacy-copy.test.ts` already holds README's item 2 ("Messages to a
 * remote provider") to the `privacy` command's own account of which
 * connections and servers are live; this file is narrower and does not
 * duplicate that — it is about the sentence ADDED to that item describing WHO
 * has to ask before a remote route opens: a self-authored persona does not,
 * an imported or marketplace one does, once, and can be revoked. That
 * distinction lives in `state/chat.ts` and `state/personas.ts`'s `origin`
 * handling, not in the `privacy` command (which reports connections, not
 * personas), so it is checked here against those source files directly,
 * following the same "read the shipped words" discipline the larger file
 * uses (`shipped()`/`collapsed()`, reimplemented locally rather than
 * imported from that file, since neither is exported from it).
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function collapsed(source: string): string {
  return source.replace(/\s+/g, ' ');
}

function shipped(path: string): string {
  return collapsed(readFileSync(resolve(process.cwd(), 'src', path), 'utf8'));
}

const README = readFileSync(resolve(process.cwd(), 'README.md'), 'utf8');
const privacySection = collapsed(README.slice(README.indexOf('## Privacy'), README.indexOf('## Licence')));

describe('README’s added sentence on persona-driven remote routing', () => {
  it('is present, under item 2, naming both the silent and the asking case', () => {
    expect(privacySection).toMatch(
      /A persona you wrote yourself can prefer a connection you have set up without asking again/,
    );
    expect(privacySection).toMatch(
      /A persona imported from a file or acquired from the marketplace asks once/,
    );
  });

  it('says declining falls back the same way a missing preference does — not a dead end', () => {
    expect(privacySection).toMatch(/declining sends nothing to it/i);
    expect(privacySection).toMatch(/falls back the same way it would with no preference at all/i);
  });

  it('says the allowance can be revoked, and from where', () => {
    expect(privacySection).toMatch(/revoked from the persona's own editor/i);
  });

  it('does not claim this list is exhaustive, per the file’s own rule', () => {
    expect(privacySection).not.toMatch(/only a persona/i);
    expect(privacySection).not.toMatch(/nothing else (asks|leaves)/i);
  });
});

describe('the README sentence is true of the shipped code', () => {
  it('a self-authored persona really does route without asking — routesProviderSilently', () => {
    const source = shipped('state/chat.ts');
    expect(source).toMatch(/routesProviderSilently[\s\S]{0,400}?origin === 'authored' \|\| origin === 'builtin'/);
  });

  it('an imported or marketplace persona really is asked, once, before anything routes', () => {
    const source = shipped('state/chat.ts');
    // The interactive ask, in runGeneration, gated on providerConsentPending.
    expect(source).toContain('providerConsentPending(persona, app.connections)');
    expect(source).toContain("confirmLabel: 'Allow'");
    expect(source).toContain("cancelLabel: 'Not now'");
  });

  it('declining really does fall back rather than dead-end — resolvePersonaProvider returns {}', () => {
    const source = shipped('state/chat.ts');
    expect(source).toMatch(/ungranted consent gives[\s\S]{0,50}?`\{\}`/i);
  });

  it('the allowance really is revocable, from the persona editor’s own "Allowed destinations"', () => {
    const editor = shipped('features/personas/PersonaEditor.tsx');
    expect(editor).toContain('Allowed destinations');
    expect(editor).toContain('useProviderConsent.getState().revoke(persona.id, grant.destination)');
  });
});
