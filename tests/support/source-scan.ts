/**
 * Reading source as CODE, for the guards that ask what a file does rather than
 * what its comments say about it.
 *
 * Two suites drive these — `layering.test.ts` for which module may import
 * which, `privacy-copy.test.ts` for which code may open a listening socket —
 * and they must drive the SAME ones. `layering.test.ts` carries the scar from
 * the alternative: a guard whose form tests asserted against a byte-identical
 * second copy of the thing under test, so weakening the real one left every
 * test green. A stripper that one suite fixed and the other did not would be
 * that failure again, one directory over.
 *
 * Moved here verbatim from `layering.test.ts`, where they were module-local.
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

/**
 * Every module specifier a file names, by any of the four doors.
 *
 *   `import x from 'y'` / `export … from 'y'`   — the `from` form
 *   `import 'y'`                                 — a side-effect import, no `from`
 *   `import('y')`                                — dynamic
 *   `require('y')`                               — CommonJS
 *
 * ONE constant, used by every guard, because the recurring failure in
 * `layering.test.ts` has been a matcher that only recognised the form it was
 * written against. That happened twice. `require(...)` was the door all three
 * guards were still blind to: `const { app } = require('electron')` typechecks
 * under `allowJs`/`@ts-expect-error`, bundles, and matched nothing.
 *
 * A single shared constant also means the next door only has to be added once,
 * rather than to three regexes that have already drifted apart before.
 *
 * Note this is a lexical scan, not a parse: it will also match the text inside
 * a string or a comment. That is why the guards test the captured SPECIFIER
 * against an allowlist-shaped pattern rather than searching the raw source —
 * `packages/contracts/src/listener.ts` names `@capacitor/core` in a comment
 * explaining why it does not import it, and a text search flagged that.
 *
 * Widened twice after revert-checks found doors standing open. A template
 * literal (`require(\`electron\`)`) and a comment between the callee and its
 * paren (`require /* x *\/ ('electron')`) both slipped a matcher that handled
 * only straight quotes and adjacent parens.
 */
export const COMMENT = String.raw`(?:\s|/\*[\s\S]*?\*/)*`;
export const SPECIFIER = new RegExp(
  String.raw`(?:from|import|require)${COMMENT}\(?${COMMENT}['"\`]([^'"\`]+)['"\`]`,
  'g',
);

/**
 * Source with comments removed, and with strings left intact.
 *
 * It was written for the platform-seam rule in `layering.test.ts`; the tunnel
 * block there uses it for a sharper reason, and the listen inventory in
 * `privacy-copy.test.ts` for the same one.
 *
 * The guards that scan for BANNED specifiers can afford to read raw source:
 * they test the captured specifier against a ban, so a package name mentioned
 * in prose is not a match unless the prose also spells a whole import. A guard
 * that asserts a file imports NOTHING has no such luck — every sentence in a
 * comment is a candidate, and `packages/tunnel/src/wire/index.ts` is a file
 * whose comments necessarily discuss imports. Stripping comments first is what
 * makes "imports nothing at all" a rule about code.
 *
 * Strings are kept rather than stripped, so a specifier smuggled into an
 * `eval`-shaped string still counts.
 */
export function codeOf(source: string): string {
  let out = '';
  let i = 0;
  while (i < source.length) {
    const two = source.slice(i, i + 2);
    if (two === '//') {
      const end = source.indexOf('\n', i);
      i = end === -1 ? source.length : end;
      continue;
    }
    if (two === '/*') {
      const end = source.indexOf('*/', i + 2);
      i = end === -1 ? source.length : end + 2;
      continue;
    }
    const ch = source[i]!;
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      out += ch;
      i += 1;
      while (i < source.length) {
        const c = source[i]!;
        out += c;
        i += 1;
        if (c === '\\') {
          out += source[i] ?? '';
          i += 1;
          continue;
        }
        if (c === quote) break;
      }
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/**
 * Every file under `dir` whose name matches `extension`, recursively.
 *
 * The default is the `.ts`/`.tsx` pair `layering.test.ts` has always walked.
 * The listen inventory passes a wider one, because a socket opened from an
 * `.mjs` file is still a socket.
 */
export function sourceFiles(dir: string, extension: RegExp = /\.tsx?$/): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full, extension));
    else if (extension.test(entry)) out.push(full);
  }
  return out;
}

/**
 * Every `apps/<name>/src` and `packages/<name>/src` that exists.
 *
 * Derived from the directories rather than listed, so a new app or package is
 * read the day it is created. A list here would be the entry nobody thought to
 * add — the failure mode of a denylist, which `layering.test.ts` records.
 */
export function workspaceSourceRoots(): string[] {
  return ['apps', 'packages'].flatMap((group) => {
    const dir = resolve(process.cwd(), group);
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .map((name) => join(dir, name, 'src'))
      .filter((src) => existsSync(src) && statSync(src).isDirectory());
  });
}

/** A path as a failure message should print it: from the repo root, forward slashes. */
export function repoPath(file: string): string {
  return relative(process.cwd(), file).replaceAll('\\', '/');
}
