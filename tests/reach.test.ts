/**
 * A REPLY NOW HAS THREE DESTINATIONS AND THE RECORD HAS ONE FIELD FOR THEM.
 *
 * `Provenance.local` was a boolean, and the app grew a third place a turn can
 * be served: a desktop the user paired. It is not `local` — the bytes left
 * this phone — and it is not `remote` in the sense the chip, the exported
 * transcript and the egress sheet all mean by that word, because no third
 * party received them. A boolean cannot hold that, and neither of its answers
 * is harmless: `true` removes the consent sheet for bytes that cross a
 * network (#144, #188), `false` raises a third-party prompt for the user's own
 * machine and, on failure, sends the conversation to a cloud provider.
 *
 * So the record carries `reach`, a three-armed union, and this file measures
 * the three things that decision has to be true of:
 *
 *   1. THE TYPE ANSWERS BOTH QUESTIONS SEPARATELY. "Did the bytes leave this
 *      device" and "did a third party serve this" are different questions with
 *      different answers for a paired desktop, which is precisely what one
 *      boolean could not express.
 *   2. THE MIGRATION REACHES EVERY STORED ROW, and invents nothing while it is
 *      there. It is driven through the hook `src/db/index.ts` really registers,
 *      pulled off the real Dexie instance, over rows in the shape v5 wrote.
 *   3. THE READERS GET THE RIGHT ANSWER OUT OF A MIGRATED ROW, measured by
 *      rendering a real transcript rather than by asserting a field changed.
 *
 * Nothing in the shipped app can produce a `paired` reach yet — the tunnel is
 * Track B and the chip that names it is #210–#219. The paired arm is exercised
 * here by hand, because the whole point of landing the type first is that the
 * tickets which consume it do not each invent a third value of their own.
 */

import { describe, expect, it } from 'vitest';

import {
  REACH_DEVICE,
  REACH_REMOTE,
  leftThisDevice,
  pairedDevice,
  ranOnDevice,
  reachKind,
  reachPaired,
  reachedThirdParty,
  type Provenance,
} from '@/domain/chat';
import { db, upgradeReach } from '@/db';
import { renderTranscript } from '@/shell/commands';

/* ── Fixtures ───────────────────────────────────────────────────────── */

const STUDIO = { id: 'pair_7f3a', name: "John's Studio" };

const ON_DEVICE: Provenance = {
  backendId: 'llama-cpp',
  engine: 'llama-cpp',
  modelId: 'qwen3-4b-instruct-q4km',
  modelName: 'Qwen3 4B Instruct',
  reach: REACH_DEVICE,
};

const FROM_PROVIDER: Provenance = {
  backendId: 'conn_openai',
  engine: 'remote',
  modelId: 'gpt-4o-mini',
  modelName: 'OpenAI · gpt-4o-mini',
  reach: REACH_REMOTE,
};

const FROM_STUDIO: Provenance = {
  backendId: 'tunnel_1',
  engine: 'remote',
  modelId: 'qwen3-32b',
  modelName: 'Qwen3 32B',
  reach: reachPaired(STUDIO),
};

/** A row exactly as v5 wrote it: `local`, no `reach`. */
function v5Row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'msg_1',
    chatId: 'c1',
    role: 'assistant',
    content: 'It trades a little accuracy for a lot of memory.',
    createdAt: 1,
    provenance: {
      backendId: 'llama-cpp',
      engine: 'llama-cpp',
      modelId: 'qwen3-4b-instruct-q4km',
      modelName: 'Qwen3 4B Instruct',
      local: true,
    },
    ...overrides,
  };
}

/* ── 1. The type answers both questions, separately ─────────────────── */

describe('a reach is three answers where a boolean had two', () => {
  it('says a paired desktop left the device without a third party seeing it', () => {
    // THE CLAIM OF THE WHOLE TICKET. These two questions had one answer
    // between them and now have two, and it is the paired row that separates
    // them: the bytes crossed a network (so it needs a grant, and the chip
    // must not show the on-device flame) while nobody but the user's own
    // machine read them (so this app's bookkeeping need not be stripped and no
    // third-party consent sheet is owed).
    expect(leftThisDevice(FROM_STUDIO)).toBe(true);
    expect(reachedThirdParty(FROM_STUDIO)).toBe(false);
    expect(ranOnDevice(FROM_STUDIO)).toBe(false);

    // The other two arms answer the two questions the same way as each other,
    // which is why one boolean was ever enough for them.
    expect([
      ranOnDevice(ON_DEVICE),
      leftThisDevice(ON_DEVICE),
      reachedThirdParty(ON_DEVICE),
    ]).toEqual([true, false, false]);
    expect([
      ranOnDevice(FROM_PROVIDER),
      leftThisDevice(FROM_PROVIDER),
      reachedThirdParty(FROM_PROVIDER),
    ]).toEqual([false, true, true]);
  });

  it('names which desktop, because a user may have paired several', () => {
    const laptop = reachPaired({ id: 'pair_0091', name: "John's Studio" });

    expect(pairedDevice(FROM_STUDIO)).toEqual(STUDIO);
    // Two devices the user gave the same name are still two devices: the id is
    // what a later screen groups by, the name is only what it can print.
    expect(pairedDevice({ reach: laptop })?.id).not.toBe(STUDIO.id);
    expect(pairedDevice(ON_DEVICE)).toBeUndefined();
    expect(pairedDevice(FROM_PROVIDER)).toBeUndefined();
  });

  it('copies the device in rather than referring to it', () => {
    // `src/domain` may not import `@/db`, and a pairing outlives nothing: a
    // transcript from March has to render after the desktop it names has been
    // unpaired and forgotten. So the record holds the name it had at the time,
    // and a later rename cannot reach back into it.
    const device = { id: 'pair_7f3a', name: "John's Studio" };
    const reach = reachPaired(device);
    device.name = 'Renamed after the fact';

    expect(pairedDevice({ reach })?.name).toBe("John's Studio");
  });

  it('fails closed on a row whose reach was never recorded', () => {
    // Not constructible through the type, and not writable by this build. It
    // is what a reader gets from a database restored from a backup taken
    // before v6, or an import from another install. Both egress questions
    // answer "assume it left", so no caller can derive a confident label out
    // of a row that has none — and `reachKind` names the case so a renderer
    // can print nothing instead of guessing.
    const unmigrated = { modelName: 'Qwen3 4B Instruct' } as unknown as Provenance;

    expect(reachKind(unmigrated)).toBe('unknown');
    expect(ranOnDevice(unmigrated)).toBe(false);
    expect(leftThisDevice(unmigrated)).toBe(true);
    expect(reachedThirdParty(unmigrated)).toBe(true);

    // Absent entirely — a variant recovered by the v4 upgrade — reads the same.
    expect(reachKind(undefined)).toBe('unknown');
    expect(leftThisDevice(undefined)).toBe(true);
  });

  it('shares the two constant reaches without letting a reader edit them', () => {
    // Every device row points at ONE object. Frozen, so a reader that assigns
    // through it cannot relabel every on-device turn in the database at once.
    expect(Object.isFrozen(REACH_DEVICE)).toBe(true);
    expect(Object.isFrozen(REACH_REMOTE)).toBe(true);

    expect(() => {
      (REACH_DEVICE as { kind: string }).kind = 'remote';
    }).toThrow(TypeError);
    expect(reachKind(ON_DEVICE)).toBe('device');
  });
});

/* ── 2. The migration ───────────────────────────────────────────────── */

describe('the v6 decision', () => {
  it('reads the two things a shipped build could have written', () => {
    const device = upgradeReach({ provenance: { modelName: 'Q', local: true } })!;
    const remote = upgradeReach({ provenance: { modelName: 'G', local: false } })!;

    expect(reachKind(device.provenance)).toBe('device');
    expect(reachKind(remote.provenance)).toBe('remote');
    // The old key is GONE, not left beside the new one: a row carrying both is
    // a row a reader can still get a two-way answer out of.
    expect(device.provenance).not.toHaveProperty('local');
    expect(remote.provenance).not.toHaveProperty('local');
    // And everything else on the record survives the rewrite.
    expect(device.provenance?.modelName).toBe('Q');
  });

  it('never writes a paired reach, because no stored row is one', () => {
    // No build that wrote these rows could tunnel a turn, so "paired" here
    // would be an invention — the exact failure the v4 upgrade refused to
    // make one field over.
    const kinds = [true, false].map(
      (local) => reachKind(upgradeReach({ provenance: { modelName: 'Q', local } })!.provenance),
    );
    expect(kinds).not.toContain('paired');
  });

  it('upgrades every generation of a turn, not just the one on display', () => {
    const upgraded = upgradeReach({
      provenance: { modelName: 'Q', local: true },
      variants: [
        { content: 'REMOTE ANSWER', provenance: { modelName: 'G', local: false } },
        { content: 'LOCAL ANSWER', provenance: { modelName: 'Q', local: true } },
      ],
    })!;

    expect(upgraded.variants?.map((variant) => reachKind(variant.provenance))).toEqual([
      'remote',
      'device',
    ]);
    expect(upgraded.variants?.map((variant) => variant.content)).toEqual([
      'REMOTE ANSWER',
      'LOCAL ANSWER',
    ]);
  });

  it('drops a provenance that says nothing about where it ran', () => {
    // A record with neither a reach nor a boolean does not name a
    // destination, and "remote" would be a guess dressed as a safe default.
    // The app already renders an absent provenance as absent, so this hands it
    // that case honestly.
    const upgraded = upgradeReach({
      provenance: { modelName: 'Q' },
      variants: [{ content: 'text', provenance: { modelName: 'Q' } }],
    })!;

    expect(upgraded.dropProvenance).toBe(true);
    expect(upgraded.provenance).toBeUndefined();
    // On a variant the same absence has a name, and it is the one the v4
    // upgrade introduced: it renders no chip AND counts as tool-derived, so
    // unknown fails closed for egress while it fails silent for labelling.
    expect(upgraded.variants?.[0]?.provenance).toBeUndefined();
    expect(upgraded.variants?.[0]?.unrecorded).toBe(true);
  });

  it('leaves alone the rows it has nothing to say about', () => {
    expect(upgradeReach({})).toBeNull();
    expect(upgradeReach({ variants: [{ content: 'recovered', unrecorded: true }] })).toBeNull();
    // Written by this build: already a reach, and re-running must not touch it.
    expect(upgradeReach({ provenance: ON_DEVICE })).toBeNull();
  });

  it('does not re-derive a reach it already carries', () => {
    // Dexie can replay an upgrade, and a future writer may leave a `local`
    // behind out of habit. A paired row rewritten from a stale boolean would
    // become "remote" — the app telling the user a third party served a turn
    // that never left their house.
    const stale = { ...FROM_STUDIO, local: false } as unknown;

    expect(upgradeReach({ provenance: stale })).toBeNull();
    expect(upgradeReach({ variants: [{ content: 'a', provenance: stale }] })).toBeNull();
  });
});

/* ── 3. The hook the app really registers ───────────────────────────── */

interface DexieVersion {
  _cfg?: { version?: number; contentUpgrade?: (tx: unknown) => unknown | Promise<unknown> };
}

const versions = (db as unknown as { _versions: DexieVersion[] })._versions;

function fakeTx(rows: Record<string, unknown>[]): unknown {
  return {
    table(name: string) {
      if (name !== 'messages') throw new Error(`the upgrade touched an unexpected table: ${name}`);
      return {
        toCollection: () => ({
          // Dexie hands the callback the stored object and writes back what
          // the callback left behind — including keys it deleted.
          modify: async (apply: (row: Record<string, unknown>) => void) => {
            for (const row of rows) apply(row);
            return rows.length;
          },
        }),
      };
    },
  };
}

const v6 = versions.find((version) => version._cfg?.version === 6)?._cfg?.contentUpgrade;

describe('the version this migration claims', () => {
  it('is 6, declared once, and the highest', () => {
    // Two `.version(n)` calls sharing an n is worse than the bug being fixed:
    // Dexie keeps the last and the other migration silently never runs.
    // Parallel work on this file is exactly how that happens.
    const declared = versions.map((version) => Number(version._cfg?.version));

    expect(declared).toContain(6);
    expect(new Set(declared).size).toBe(declared.length);
    expect(Math.max(...declared)).toBe(6);
    expect([...declared]).toEqual([...declared].sort((a, b) => a - b));
  });

  it('is wired to the upgrade, not merely declared', () => {
    expect(typeof v6).toBe('function');
  });
});

describe('an install upgraded from v5', () => {
  it('rewrites the row in place, boolean gone, reach in its stead', async () => {
    const rows = [
      { id: 'msg_u', chatId: 'c1', role: 'user', content: 'hello', createdAt: 0 },
      v5Row(),
      v5Row({
        id: 'msg_2',
        provenance: { modelName: 'OpenAI · gpt-4o-mini', local: false },
        variants: [
          {
            content: 'REMOTE ANSWER',
            provenance: { modelName: 'OpenAI · gpt-4o-mini', local: false },
          },
        ],
        variantIndex: 0,
      }),
    ];

    await (v6 as (tx: unknown) => Promise<unknown>)(fakeTx(rows));

    expect(reachKind(rows[1]!.provenance as Provenance)).toBe('device');
    expect(rows[1]!.provenance).not.toHaveProperty('local');
    expect(reachKind(rows[2]!.provenance as Provenance)).toBe('remote');
    const variants = rows[2]!.variants as { provenance?: Provenance }[];
    expect(reachKind(variants[0]?.provenance)).toBe('remote');
    // The user's row has no provenance and must not grow one.
    expect(rows[0]).not.toHaveProperty('provenance');
  });

  it('deletes the key of a provenance it cannot read, and keeps the rest of the turn', async () => {
    const rows = [
      v5Row({
        provenance: { modelName: 'Qwen3 4B Instruct' },
        stats: { completionTokens: 4 },
        toolCalls: [{ id: 'call_1', name: 'bash', input: {} }],
      }),
    ];

    await (v6 as (tx: unknown) => Promise<unknown>)(fakeTx(rows));

    // Deleted, not set to undefined: a row this build would write has no key.
    expect('provenance' in rows[0]!).toBe(false);
    // Unlike the v4 upgrade, this one moves no text between generations, so
    // the stats and the tool calls still describe the words beside them.
    expect(rows[0]!.stats).toEqual({ completionTokens: 4 });
    expect(rows[0]!.toolCalls).toHaveLength(1);
  });

  it('can be run twice, because Dexie may replay it', async () => {
    const rows = [v5Row()];
    const run = v6 as (tx: unknown) => Promise<unknown>;

    await run(fakeTx(rows));
    const once = JSON.parse(JSON.stringify(rows[0]));
    await run(fakeTx(rows));

    expect(rows[0]).toEqual(once);
  });
});

/* ── 4. What the readers make of a migrated row ─────────────────────── */

describe('a conversation saved by yesterday’s build', () => {
  it('still says where each turn ran, in the file the user downloads', async () => {
    const rows = [
      { id: 'u', chatId: 'c1', role: 'user', content: 'q', createdAt: 0 },
      v5Row({ id: 'a1', content: 'ANSWERED HERE' }),
      v5Row({
        id: 'a2',
        content: 'ANSWERED THERE',
        provenance: { modelName: 'OpenAI · gpt-4o-mini', local: false },
      }),
      // A generation the v4 upgrade recovered: no origin was ever written for
      // it, and v6 must not supply one.
      v5Row({ id: 'a3', content: 'RECOVERED', provenance: undefined }),
    ];
    delete rows[3]!.provenance;

    await (v6 as (tx: unknown) => Promise<unknown>)(fakeTx(rows));

    const transcript = renderTranscript(
      { title: 'T', updatedAt: 0 },
      rows as unknown as Parameters<typeof renderTranscript>[1],
    );

    expect(transcript).toContain('## Qwen3 4B Instruct (on device)');
    expect(transcript).toContain('## OpenAI · gpt-4o-mini (remote)');
    // Absent stays absent: a bare name, and neither phrase claimed of it.
    expect(transcript).toContain('## Assistant\n');
    expect(transcript).not.toContain('## Assistant (');
  });

  it('prints nothing rather than a phrase for a reach it cannot read', () => {
    // The row v6 never reached — a database restored from an old backup. It
    // used to be labelled "(remote)" by the boolean's `false` branch, which
    // was a claim about a turn nobody recorded.
    const unmigrated = [
      {
        role: 'assistant',
        content: 'a',
        createdAt: 1,
        provenance: { modelName: 'Qwen3 4B Instruct' },
      },
    ];

    const transcript = renderTranscript(
      { title: 'T', updatedAt: 0 },
      unmigrated as unknown as Parameters<typeof renderTranscript>[1],
    );

    expect(transcript).toContain('## Qwen3 4B Instruct\n');
    expect(transcript).not.toContain('(remote)');
    expect(transcript).not.toContain('(on device)');
  });

  it('renders a paired turn as remote until the chip that names it lands', () => {
    // Deliberate, and pinned so #210–#219 has to change it knowingly: two
    // phrases for three destinations coarsens `paired` into `remote`, which
    // overstates where the reply went rather than hiding that it went
    // anywhere. Nothing in the app can produce this row yet.
    const paired = [
      { role: 'assistant', content: 'a', createdAt: 1, provenance: FROM_STUDIO },
    ];

    expect(
      renderTranscript(
        { title: 'T', updatedAt: 0 },
        paired as unknown as Parameters<typeof renderTranscript>[1],
      ),
    ).toContain('## Qwen3 32B (remote)');
  });
});
