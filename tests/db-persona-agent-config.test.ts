/**
 * `Persona.agentConfig`'s Dexie bump (#23, #122, owner ruling 2026-09-27: v10 -> v11,
 * additive, no upgrade function).
 *
 * As `tests/db-paired-devices.test.ts` explains for v10: this project has no
 * fake-indexeddb, so what is asserted is exactly what Dexie migrates from —
 * `Version.stores()`'s per-version `dbschema`, and whether `contentUpgrade`
 * is set. A v11 whose `personas` schema equals v10's, with no
 * `contentUpgrade`, gives Dexie nothing to do to a stored persona row but
 * carry it forward untouched, which is what "reads back unchanged with
 * agentConfig undefined" means for a table with no fake-indexeddb backing it.
 */

import type { TableSchema } from 'dexie';
import { describe, expect, it } from 'vitest';

import { db } from '@/db';
import type { Persona } from '@/domain/persona';

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

const shapeOf = (schema: TableSchema | undefined) =>
  schema && { primKey: schema.primKey.src, indexes: schema.indexes.map((index) => index.src) };

describe('the agentConfig bump’s version', () => {
  it('is declared at v11, the next after v10, changing no index', () => {
    const v10 = at(10);
    const v11 = at(11);
    expect(v10, 'v10 is gone, so "the next version after v10" means nothing').toBeDefined();
    expect(v11, 'there is no version 11').toBeDefined();
    expect(v11!._cfg.storesSource).toEqual({ personas: 'id, name, kind, updatedAt, builtin' });
  });

  it('carries a v10 install’s personas (and every other table) forward untouched', () => {
    const v10 = at(10)!._cfg;
    const v11 = at(11)?._cfg;
    expect(v11, 'there is no version 11').toBeDefined();

    // Positive control: v10 really holds a personas schema, so the
    // comparison below is not over an empty one.
    expect(shapeOf(v10.dbschema.personas)).toEqual({
      primKey: 'id',
      indexes: ['name', 'kind', 'updatedAt', 'builtin'],
    });

    // Every table v10 has, v11 has with the same key and indexes — including
    // `personas` itself, which is only RESTATED (as v4 restates `messages`),
    // not given a new index for `agentConfig`.
    const v10Tables = Object.keys(v10.dbschema).sort();
    expect(Object.keys(v11!.dbschema).sort()).toEqual(v10Tables);
    for (const table of v10Tables) {
      expect(shapeOf(v11!.dbschema[table]), `v11 changes the schema of ${table}`).toEqual(
        shapeOf(v10.dbschema[table]),
      );
    }

    // And v11 rewrites no row: Dexie sets `contentUpgrade` only from
    // `.upgrade()`, which this version does not call.
    expect(v11!.contentUpgrade, 'v11 registers an upgrade function, so it rewrites stored rows').toBeNull();
  });
});

describe('a v10-shaped persona row', () => {
  it('reads back unchanged, with agentConfig undefined', () => {
    // Exactly the shape a persona written before this field existed has: no
    // `agentConfig` key at all, not even `undefined` written explicitly.
    const v10Row = {
      id: 'p1',
      kind: 'assistant',
      name: 'Aide',
      tagline: '',
      avatarSeed: 'aide',
      description: 'Helps.',
      version: 1,
      tags: [],
      createdAt: 0,
      updatedAt: 0,
    };

    // Widening `Persona` to require nothing new is what makes this legal:
    // a v10 row satisfies the v11 type without being touched.
    const asPersona = v10Row as Persona;
    expect(asPersona.agentConfig).toBeUndefined();
    expect('agentConfig' in v10Row).toBe(false);
  });
});
