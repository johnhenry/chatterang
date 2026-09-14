// @vitest-environment node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { codeOf, repoPath, sourceFiles, workspaceSourceRoots } from './support/source-scan';

/**
 * #179: the X.509 library reaches the desktop and the server, and nothing else.
 *
 * ITS OWN FILE, AND THE RUNTIME CHECK FIRST IN IT. `Reflect.getMetadata` is a
 * global, and vitest gives each test file its own worker: this is the one place
 * a process has imported the host entry and not yet issued a certificate, so it
 * is the one place "importing the host patches no global" can be observed rather
 * than inferred from reading one file.
 */

/** Every package the library is, or brings, that a bundle could pick up by name. */
const LIBRARY = /^(?:@peculiar\/|reflect-metadata$|tsyringe$|asn1js$|pvtsutils$|pvutils$)/;
const SCANNED = /\.(?:[cm]?[jt]s|[jt]sx)$/;

/**
 * Every specifier in `code`, with the door it came through. `typeof import('x')`
 * is a type query, erased before anything runs, and is told apart from a
 * dynamic import so the host's one type reference is not read as a load.
 */
function importsOf(code: string): { form: 'static' | 'dynamic' | 'type'; specifier: string }[] {
  return [...code.matchAll(/\b(typeof\s+)?(from|import|require)\s*(\()?\s*['"`]([^'"`]+)['"`]/g)].map((match) => ({
    form: match[1] !== undefined ? 'type' : match[2] === 'import' && match[3] === '(' ? 'dynamic' : 'static',
    specifier: match[4] ?? '',
  }));
}

describe('the host entry loads the library only when a certificate is issued', () => {
  it('importing the host and both app adapters patches no global, and the first issue does', async () => {
    const reflect = Reflect as { getMetadata?: unknown };
    expect(typeof reflect.getMetadata, 'something loaded the polyfill before this file ran').toBe('undefined');

    const host = await import('@chatterang/tunnel/host');
    await import('@chatterang/desktop/tunnel-identity');
    await import('@chatterang/server/tunnel-identity');
    expect(typeof reflect.getMetadata, 'importing the host loaded reflect-metadata').toBe('undefined');

    // The control: the check can see the polyfill once it is really loaded.
    await host.issueTunnelCertificate(host.generateTunnelKey(), { validDays: 1 });
    expect(typeof reflect.getMetadata).toBe('function');
  });

  it('names the library only in identity.ts, and only through a dynamic import', () => {
    const host = sourceFiles(resolve(process.cwd(), 'packages/tunnel/src/host'), SCANNED);
    expect(host.length).toBeGreaterThan(1);
    const naming = host
      .map((file) => ({ file: repoPath(file), imports: importsOf(codeOf(readFileSync(file, 'utf8'))) }))
      .map(({ file, imports }) => ({ file, imports: imports.filter(({ specifier }) => LIBRARY.test(specifier)) }))
      .filter(({ imports }) => imports.length > 0);
    expect(naming.map(({ file }) => file)).toEqual(['packages/tunnel/src/host/identity.ts']);
    expect(naming[0]!.imports).toEqual([
      { form: 'type', specifier: '@peculiar/x509' },
      { form: 'dynamic', specifier: 'reflect-metadata' },
      { form: 'dynamic', specifier: '@peculiar/x509' },
    ]);

    // The reader tells the doors apart.
    expect(importsOf("import 'reflect-metadata';")).toEqual([{ form: 'static', specifier: 'reflect-metadata' }]);
    expect(importsOf("import * as x509 from '@peculiar/x509';")).toEqual([{ form: 'static', specifier: '@peculiar/x509' }]);
    expect(importsOf("export { X509Certificate } from '@peculiar/x509';")).toEqual([{ form: 'static', specifier: '@peculiar/x509' }]);
    expect(importsOf("const t = require('tsyringe');")).toEqual([{ form: 'static', specifier: 'tsyringe' }]);
    expect(importsOf("await import('@peculiar/x509')")).toEqual([{ form: 'dynamic', specifier: '@peculiar/x509' }]);
    expect(importsOf("type X = typeof import('@peculiar/x509');")).toEqual([{ form: 'type', specifier: '@peculiar/x509' }]);
  });
});

describe('the library never reaches the app bundle, by any importable path', () => {
  it('is pinned in packages/tunnel and undeclared at the root', () => {
    const manifest = (path: string) =>
      JSON.parse(readFileSync(resolve(process.cwd(), path), 'utf8')) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
    const root = manifest('package.json');
    const tunnel = manifest('packages/tunnel/package.json');
    // Undeclared at the root is what makes `tests/layering.test.ts`'s derived
    // rule ("src/ imports only what this app declares") refuse them in `src/`.
    for (const name of ['@peculiar/x509', 'reflect-metadata']) {
      expect(root.dependencies?.[name], name).toBeUndefined();
      expect(root.devDependencies?.[name], name).toBeUndefined();
    }
    // Exact versions, per the ruling.
    expect(tunnel.dependencies?.['@peculiar/x509']).toBe('2.1.0');
    expect(tunnel.dependencies?.['reflect-metadata']).toBe('0.2.2');
  });

  it('is named by no file outside the tunnel host and the two app adapters that call it', () => {
    /*
     * THE GAP A ROOT-MANIFEST RULE LEAVES. `src/` naming the library is refused
     * by `layering.test.ts`, because the root does not declare it. But `src/`
     * may import `@chatterang/tunnel/client` — and that half's rule bans Node
     * builtins, Electron and Capacitor, not packages, so `import '@peculiar/x509'`
     * in `packages/tunnel/src/client/index.ts` passed every guard (measured).
     * `binding/`, `pairing/`, `pake/` and `stream/` are allowlists and would have
     * caught it; `client/` and `codec/` would not.
     *
     * So this reads every source file that could end up in a bundle by being
     * imported — `src/`, every package, every half of `packages/tunnel` but
     * `host/`, and every app but the two main processes — and requires that
     * none names the library or anything it brings. Derived from the
     * directories, so a new package is covered the day it exists.
     */
    const excluded = ['packages/tunnel/src/host/', 'apps/desktop/src/', 'apps/server/src/'];
    const files = [resolve(process.cwd(), 'src'), ...workspaceSourceRoots()]
      .flatMap((root) => sourceFiles(root, SCANNED))
      .filter((file) => !excluded.some((prefix) => repoPath(file).startsWith(prefix)));
    const scanned = new Set(files.map((file) => repoPath(file).split('/').slice(0, 4).join('/')));
    for (const half of ['client', 'codec', 'wire', 'pairing', 'pake', 'stream', 'binding']) {
      expect(scanned, `packages/tunnel/src/${half} was not read`).toContain(`packages/tunnel/src/${half}`);
    }
    expect(files.some((file) => repoPath(file).startsWith('src/'))).toBe(true);

    const offenders = files.flatMap((file) =>
      importsOf(codeOf(readFileSync(file, 'utf8')))
        .filter(({ specifier }) => LIBRARY.test(specifier))
        .map(({ specifier }) => `${repoPath(file)} -> ${specifier}`),
    );
    expect(offenders).toEqual([]);

    // The ban can fire: the one file that does name the library is found by it.
    const identity = readFileSync(resolve(process.cwd(), 'packages/tunnel/src/host/identity.ts'), 'utf8');
    expect(importsOf(codeOf(identity)).filter(({ specifier }) => LIBRARY.test(specifier)).length).toBe(3);
    for (const name of ['@peculiar/asn1-x509', 'tsyringe', 'asn1js', 'pvtsutils', 'pvutils']) {
      expect(LIBRARY.test(name), name).toBe(true);
    }
    expect(LIBRARY.test('reflect-metadata-lite')).toBe(false);
  });
});
