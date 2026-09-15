/**
 * THE PHONE'S PAIRED-DEVICE TABLE LANDS TESTED AND UNREACHABLE (#133).
 *
 * The owner's #133 ruling lets the table arrive before the pairing controller
 * does, at the next Dexie version after v9, provided nothing can reach it. So
 * what is tested here is less the table than everything around it:
 *
 *   1. It is v10, and v10 adds one table and changes nothing an install
 *      already holds — no index on an existing table, no upgrade function.
 *   2. The row has exactly the ruled fields. Where the phone keeps the
 *      credential secret is NOT ruled (#135), so there is no column for it,
 *      nor for the desktop's digest, a transcript or a model list.
 *   3. `eraseEverything()` takes it with the rest of the database.
 *   4. Nothing in `src/` writes it. This is the real guard: the privacy-copy
 *      biconditional (`tests/privacy-copy.test.ts`) is `panel && mounted &&
 *      table`, and no panel exists, so it passes with or without this table.
 *
 * WHY THE MIGRATION IS NOT DRIVEN THROUGH INDEXEDDB. There is none here: jsdom
 * and Node ship no IndexedDB, and this project has no fake-indexeddb
 * (`tests/variant-provenance.test.ts` says the same). What is asserted instead
 * is exactly what Dexie migrates from. `Version.stores()` merges every
 * version's `storesSource` into a per-version `_cfg.dbschema`
 * (node_modules/dexie/dist/dexie.mjs, `Version.prototype.stores`), and on open
 * Dexie diffs the stored schema against those and runs `_cfg.contentUpgrade`
 * only for versions above the stored one (`if (contentUpgrade &&
 * version._cfg.version > oldVersion)`). A v10 whose dbschema equals v9's for
 * every v9 table, plus one new table, and which has no contentUpgrade, gives
 * Dexie nothing to do to `chats` or `messages` but carry them.
 *
 * Whether `tests/shell.test.ts` keeps the table out of the shell VFS is
 * asserted there, beside the other credential greps.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import type { TableSchema } from 'dexie';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { db, eraseEverything, type PairedDeviceRecord } from '@/db';

interface DexieVersion {
  _cfg: {
    version: number;
    storesSource: Record<string, string | null> | null;
    dbschema: Record<string, TableSchema>;
    contentUpgrade: unknown;
  };
}

const versions = (db as unknown as { _versions: DexieVersion[] })._versions;
const at = (n: number): DexieVersion | undefined => versions.find((version) => version._cfg.version === n);

/** What Dexie compares between two versions of one table: its key and its indexes. */
const shapeOf = (schema: TableSchema | undefined) =>
  schema && { primKey: schema.primKey.src, indexes: schema.indexes.map((index) => index.src) };

const ROOT = process.cwd();
const DB_FILE = 'src/db/index.ts';

/* ── 1. The version ─────────────────────────────────────────────────── */

describe('the paired-device table’s version', () => {
  it('is declared at v10, the next after v9, adding one table and nothing else', () => {
    const v9 = at(9);
    const v10 = at(10);
    expect(v9, 'v9 is gone, so "the next version after v9" means nothing').toBeDefined();
    expect(v10, 'there is no version 10').toBeDefined();

    // Dexie hands a repeated `.version(9)` the SAME Version object and merges
    // the stores into it, so reusing 9 would not show up as a duplicate in
    // `_versions`. It shows up here: v9 would own the table and v10 would not
    // exist, and an install already at v9 would never be given it.
    expect(Object.keys(v9!._cfg.dbschema)).not.toContain('pairedDevices');
    expect(v10!._cfg.storesSource).toEqual({ pairedDevices: 'id, spkiPin' });
  });

  it('carries a v9 install’s chats and messages to v10 untouched', () => {
    const v9 = at(9)!._cfg;
    const v10 = at(10)?._cfg;
    expect(v10, 'there is no version 10').toBeDefined();

    // Positive control: v9 really holds the tables an install cares about, so
    // the comparison below is not over an empty schema.
    expect(shapeOf(v9.dbschema.chats)).toEqual({
      primKey: 'id',
      indexes: ['updatedAt', 'mode', 'personaId', 'pinned'],
    });
    expect(shapeOf(v9.dbschema.messages)).toEqual({
      primKey: 'id',
      indexes: ['chatId', 'createdAt', '[chatId+createdAt]'],
    });

    // Every table v9 has, v10 has with the same key and indexes: Dexie drops
    // or rebuilds nothing on the way up.
    const v9Tables = Object.keys(v9.dbschema).sort();
    expect(Object.keys(v10!.dbschema).sort()).toEqual([...v9Tables, 'pairedDevices'].sort());
    for (const table of v9Tables) {
      expect(shapeOf(v10!.dbschema[table]), `v10 changes the schema of ${table}`).toEqual(shapeOf(v9.dbschema[table]));
    }

    // And v10 rewrites no row. `.upgrade()` is the only way a version touches
    // stored data; Dexie initialises this to null and only `.upgrade()` sets it.
    expect(v10!.contentUpgrade, 'v10 registers an upgrade function, so it rewrites stored rows').toBeNull();
  });
});

/* ── 2. The row ─────────────────────────────────────────────────────── */

describe('a paired-device row', () => {
  /** The member names of an interface in `src/db/index.ts`, read by the TypeScript parser. */
  const membersOf = (name: string): readonly string[] => {
    const tree = ts.createSourceFile(DB_FILE, readFileSync(resolve(ROOT, DB_FILE), 'utf8'), ts.ScriptTarget.Latest, true);
    const found = tree.statements.find(
      (statement): statement is ts.InterfaceDeclaration =>
        ts.isInterfaceDeclaration(statement) && statement.name.text === name,
    );
    return found ? found.members.map((member) => member.name?.getText(tree) ?? '') : [];
  };

  it('holds exactly the ruled fields: no credential, digest, transcript or model list', () => {
    // Positive control: the reader sees the interface it is pointed at.
    expect(membersOf('StoredBlob')).toEqual(['id', 'mediaType', 'data', 'bytes', 'createdAt']);

    // Exact, not "does not contain credential": a `secret`, a `token`, a
    // `digest` or a cached `models` list is the same mistake under another
    // name, and each has to be argued for rather than slipped in (#133, #135).
    expect(membersOf('PairedDeviceRecord')).toEqual([
      'id',
      'spkiPin',
      'hostKind',
      'name',
      'addresses',
      'port',
      'pairedAt',
      'capabilities',
    ]);
  });

  it('is keyed by the id the desktop mints, and indexed by the pin it was shown', () => {
    const schema = at(10)?._cfg.dbschema.pairedDevices;
    expect(shapeOf(schema)).toEqual({ primKey: 'id', indexes: ['spkiPin'] });
  });

  it('type-checks as the ruled shape, and refuses a credential', () => {
    const row: PairedDeviceRecord = {
      // 16 bytes of base64url, the `<deviceId>` half of `<deviceId>.<secret>`
      // (packages/tunnel/src/host/credential.ts).
      id: 'AAECAwQFBgcICQoLDA0ODw',
      spkiPin: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=',
      hostKind: 'desktop',
      name: "John's Studio",
      addresses: ['192.168.1.4'],
      port: 8973,
      pairedAt: 0,
      capabilities: ['inference'],
    };
    // `tsc` reads this line: the day the record grows a `credential`, the
    // directive is unused and the typecheck fails.
    // @ts-expect-error -- the phone's credential secret has no column here (#135).
    const withSecret: PairedDeviceRecord = { ...row, credential: `${row.id}.secret` };
    expect(withSecret.id).toBe(row.id);
  });
});

/* ── 3. Erasure ─────────────────────────────────────────────────────── */

describe('eraseEverything', () => {
  afterEach(() => vi.restoreAllMocks());

  it('takes paired devices with it, by deleting the database they are in', async () => {
    // Holds by construction today — `db.delete(); db.open()` — so this is a
    // guard against a later "erase" that clears a list of tables and forgets
    // this one, not a test that failed first.
    expect(db.tables.map((table) => table.name)).toContain('pairedDevices');

    const deleted = vi.spyOn(db, 'delete').mockResolvedValue(undefined);
    const opened = vi.spyOn(db, 'open').mockResolvedValue(db);
    await eraseEverything();

    expect(deleted).toHaveBeenCalledTimes(1);
    expect(opened).toHaveBeenCalledTimes(1);
    expect(deleted.mock.invocationCallOrder[0]).toBeLessThan(opened.mock.invocationCallOrder[0]!);
  });
});

/* ── 4. Nothing writes it ───────────────────────────────────────────── */

describe('the paired-device table in src/', () => {
  const sourceFiles = (dir: string): string[] =>
    readdirSync(dir).flatMap((entry) => {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) return sourceFiles(path);
      return /\.(ts|tsx)$/.test(entry) ? [path] : [];
    });

  /**
   * Every place a source NAMES the table in code: an identifier, or a string
   * or template literal containing `pairedDevices`. Parsed, so comments —
   * which say "paired" about this table a great deal — never count.
   */
  const namings = (file: string, text: string): string[] => {
    const tree = ts.createSourceFile(
      file,
      text,
      ts.ScriptTarget.Latest,
      true,
      file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const hits: string[] = [];
    const visit = (node: ts.Node): void => {
      const named =
        (ts.isIdentifier(node) && node.text === 'pairedDevices') ||
        ((ts.isStringLiteralLike(node) || ts.isTemplateLiteralToken(node)) && node.text.includes('pairedDevices'));
      if (named) hits.push(`${file}: ${ts.SyntaxKind[node.parent.kind]}`);
      ts.forEachChild(node, visit);
    };
    visit(tree);
    return hits;
  };

  it('is named only where it is declared, so no production code writes it', () => {
    const files = sourceFiles(resolve(ROOT, 'src'));
    // Positive control: the walker reached the tree and the file that declares it.
    expect(files.length).toBeGreaterThan(100);
    expect(files.map((file) => relative(ROOT, file))).toContain(DB_FILE);

    const found = files.flatMap((file) => namings(relative(ROOT, file), readFileSync(file, 'utf8')));

    // The class field and the `.stores({ pairedDevices: … })` key. Anything
    // more is a reader or a writer, and neither may land before the pairing
    // controller does (#133 ruling): a `put` here is a pairing nobody can see.
    expect(found).toEqual([`${DB_FILE}: PropertyDeclaration`, `${DB_FILE}: PropertyAssignment`]);
  });

  it('the reader sees a writer when there is one', () => {
    // Positive control for the matcher above, on the forms a writer takes.
    const writers = [
      'await db.pairedDevices.put(row);',
      'await db.pairedDevices.add(row);',
      "await tx.table('pairedDevices').bulkPut(rows);",
      'await db[`pairedDevices`].update(id, patch);',
    ];
    for (const writer of writers) expect(namings('src/x.ts', writer), writer).not.toEqual([]);
    // And not on prose about it.
    expect(namings('src/x.ts', '// db.pairedDevices.put(row) once the controller lands\nconst x = 1;')).toEqual([]);
  });
});
