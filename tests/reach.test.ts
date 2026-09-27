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

import { REACH_DEVICE, REACH_LOCAL_VIA_THIRD_PARTY, REACH_REMOTE, leftThisDevice, pairedDevice, ranOnDevice, reachKind, reachPaired, reachedThirdParty, type Provenance } from '@/domain/chat';
import { db, upgradeMessageReachAxes, upgradeReach, upgradeReachValue } from '@/db';
import { reachOf } from '@/ui/target';
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
      (REACH_DEVICE as { reached: string }).reached = 'third-party';
    }).toThrow(TypeError);
    // The nested host too — freezing only the outer object would leave every
    // on-device turn one assignment away from claiming it ran elsewhere.
    expect(Object.isFrozen(REACH_DEVICE.host)).toBe(true);
    expect(() => {
      (REACH_DEVICE.host as { kind: string }).kind = 'third-party';
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
const v7 = versions.find((version) => version._cfg?.version === 7)?._cfg?.contentUpgrade;

describe('the versions these migrations claim', () => {
  it('are 6, 7, 8, 9, 10 and 11, each declared once, in order, with 11 the highest', () => {
    /*
     * Two `.version(n)` calls sharing an n is worse than the bug being fixed:
     * Dexie keeps the last and the other migration silently never runs.
     *
     * This is not hypothetical here. #133 (a paired-device table) and #195 (a
     * durable queue) BOTH describe themselves as version 7 in their own
     * bodies, written before either was built. This assertion is what stops
     * the second one to land from erasing the first.
     *
     * IT ALREADY WORKED ONCE: #259's v8 landed while this said 7, and the
     * suite failed rather than the number being collided into. Updating the
     * bound is the intended cost of adding a version — a guard that had to be
     * edited is a guard that was read.
     *
     * #133's paired-device table is v10 (`tests/db-paired-devices.test.ts`).
     * This comment used to say "#195 takes 11" — written before either #195
     * or #23/#122 (configurable personas) had landed. #23/#122's
     * `Persona.agentConfig` took v11 instead, on an explicit owner ruling
     * dated 2026-09-27 that named that version for it
     * (`tests/db-persona-agent-config.test.ts`).
     * Whichever of #195 and anything else still unbuilt lands next must
     * re-read this note, as v7's did, and take v12 — this bound is exactly
     * what stops it from silently reusing 11 instead. Uniqueness alone does
     * not catch a reused number: Dexie hands a second `.version(n)` the same
     * Version object and merges into it, so `_versions` stays unique. The
     * highest bound is what catches that.
     */
    const declared = versions.map((version) => Number(version._cfg?.version));

    expect(declared).toContain(6);
    expect(declared).toContain(7);
    expect(declared).toContain(8);
    expect(declared).toContain(9);
    expect(declared).toContain(10);
    expect(declared).toContain(11);
    expect(new Set(declared).size).toBe(declared.length);
    expect(Math.max(...declared)).toBe(11);
    expect([...declared]).toEqual([...declared].sort((a, b) => a - b));
  });

  it('are wired to their upgrades, not merely declared', () => {
    // A `.version(n)` with no `.upgrade()` bumps the schema and converts
    // nothing, which reads in review as a migration and is not one.
    expect(typeof v6).toBe('function');
    expect(typeof v7).toBe('function');
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

/* ── What a turn handed to a server, in the transcript (#92) ──────────── */

describe('the receipts a turn kept, in the transcript', () => {
  const call = (host: string) => ({
    id: `call_${host}`,
    name: 'x.search',
    input: { q: 'q' },
    receipt: {
      outcome: 'sent' as const,
      serverId: 'mcp_x',
      serverName: 'x',
      host,
      toolName: 'x.search',
      bytes: 12,
      at: Date.UTC(2026, 8, 2),
    },
  });
  const line = (host: string) =>
    `- x.search sent 12 bytes of arguments to ${host} (x) at 2026-09-02 00:00:00 UTC`;

  it('prints the displayed generation’s receipt once, though the row mirrors it', () => {
    // `applyVariant` projects the displayed record onto the row, so its calls
    // are on both. Reading both would print this call twice.
    const displayed = { content: 'SECOND', provenance: ON_DEVICE, toolCalls: [call('a.example')] };
    const transcript = renderTranscript(
      { title: 'T', updatedAt: 0 },
      [
        {
          role: 'assistant',
          createdAt: 1,
          ...displayed,
          variants: [{ content: 'FIRST', provenance: FROM_PROVIDER }, displayed],
          variantIndex: 1,
        },
      ] as unknown as Parameters<typeof renderTranscript>[1],
    );

    expect(transcript.split('a.example').length - 1).toBe(1);
    expect(transcript).toContain(`${line('a.example')}.\n`);
    expect(transcript).not.toContain('not shown');
  });

  it('prints a failed regeneration’s own receipt beside the ones its list kept', () => {
    // A regeneration that failed never appended its record, so its index is
    // past the end and the row is the only place its call is written.
    const transcript = renderTranscript(
      { title: 'T', updatedAt: 0 },
      [
        {
          role: 'assistant',
          createdAt: 1,
          content: '',
          error: 'The connection dropped.',
          toolCalls: [call('b.example')],
          variants: [{ content: 'FIRST', provenance: FROM_PROVIDER, toolCalls: [call('a.example')] }],
          variantIndex: 1,
        },
      ] as unknown as Parameters<typeof renderTranscript>[1],
    );

    expect(transcript).toContain(
      `${line('b.example')}.\n${line('a.example')} (from a version of this reply not shown).\n`,
    );
  });

  it('prints a call that was not allowed as not sent, beside one that was sent', () => {
    const withheld = call('b.example');
    const transcript = renderTranscript(
      { title: 'T', updatedAt: 0 },
      [
        {
          role: 'assistant',
          createdAt: 1,
          content: 'ok',
          toolCalls: [call('a.example'), { ...withheld, receipt: { ...withheld.receipt, outcome: 'withheld', why: 'not-allowed' } }],
        },
      ] as unknown as Parameters<typeof renderTranscript>[1],
    );

    expect(transcript).toContain(
      `${line('a.example')}.\n- x.search was not sent to b.example (x) at 2026-09-02 00:00:00 UTC — it was not allowed.\n`,
    );
    expect(transcript).not.toContain('sent 12 bytes of arguments to b.example');
  });

  it('prints a destructive call that was declined as not sent, and says which question stopped it', () => {
    const declined = call('b.example');
    const transcript = renderTranscript(
      { title: 'T', updatedAt: 0 },
      [
        {
          role: 'assistant',
          createdAt: 1,
          content: 'ok',
          toolCalls: [{ ...declined, receipt: { ...declined.receipt, outcome: 'withheld', why: 'declined' } }],
        },
      ] as unknown as Parameters<typeof renderTranscript>[1],
    );

    expect(transcript).toContain(
      '- x.search was not sent to b.example (x) at 2026-09-02 00:00:00 UTC — it could change data there, and was declined.\n',
    );
    expect(transcript).not.toContain('it was not allowed');
  });

  it('prints a reason a later build added as not sent, with the reason as stored', () => {
    const later = call('b.example');
    const transcript = renderTranscript(
      { title: 'T', updatedAt: 0 },
      [
        {
          role: 'assistant',
          createdAt: 1,
          content: 'ok',
          toolCalls: [{ ...later, receipt: { ...later.receipt, outcome: 'withheld', why: 'held-by-policy' } }],
        },
      ] as unknown as Parameters<typeof renderTranscript>[1],
    );

    expect(transcript).toContain(
      '- x.search was not sent to b.example (x) at 2026-09-02 00:00:00 UTC — held-by-policy.\n',
    );
  });

  it('prints a call whose server changed as not sent, and says that was why', () => {
    const changed = call('b.example');
    const transcript = renderTranscript(
      { title: 'T', updatedAt: 0 },
      [
        {
          role: 'assistant',
          createdAt: 1,
          content: 'ok',
          toolCalls: [{ ...changed, receipt: { ...changed.receipt, outcome: 'withheld', why: 'server-changed' } }],
        },
      ] as unknown as Parameters<typeof renderTranscript>[1],
    );

    expect(transcript).toContain(
      '- x.search was not sent to b.example (x) at 2026-09-02 00:00:00 UTC — the server changed before it went.\n',
    );
    expect(transcript).not.toMatch(/was not allowed|was declined/);
  });

  it('prints a call held back by Stop as not sent, and says the reply was stopped', () => {
    const stopped = call('b.example');
    const transcript = renderTranscript(
      { title: 'T', updatedAt: 0 },
      [
        {
          role: 'assistant',
          createdAt: 1,
          content: 'ok',
          toolCalls: [{ ...stopped, receipt: { ...stopped.receipt, outcome: 'withheld', why: 'stopped' } }],
        },
      ] as unknown as Parameters<typeof renderTranscript>[1],
    );

    expect(transcript).toContain(
      '- x.search was not sent to b.example (x) at 2026-09-02 00:00:00 UTC — the reply was stopped before it went.\n',
    );
  });

  it('still exports when a stored receipt’s time cannot be read', () => {
    // `toISOString` throws on an invalid date. One bad row must cost its own
    // timestamp, not the whole file and every `/chats/*.md` beside it.
    const broken = call('c.example');
    const transcript = renderTranscript(
      { title: 'T', updatedAt: 0 },
      [
        {
          role: 'assistant',
          createdAt: 1,
          content: 'ok',
          toolCalls: [{ ...broken, receipt: { ...broken.receipt, at: Number.NaN } }],
        },
      ] as unknown as Parameters<typeof renderTranscript>[1],
    );
    expect(transcript).toContain(
      '- x.search sent 12 bytes of arguments to c.example (x) at an unrecorded time.',
    );
  });
});

/* ── 4. v7: one axis becomes two ─────────────────────────────────────── */

describe('the two axes', () => {
  it('says the thing one axis could not: ran here, reached a third party', () => {
    /*
     * #112, and the whole reason for the reshape. A `claude` CLI is a process
     * on this machine whose tokens reach a vendor API. Under three arms it had
     * to be `device` or `remote`, and both got something wrong that mattered.
     */
    expect(REACH_LOCAL_VIA_THIRD_PARTY.host.kind).toBe('device');
    expect(REACH_LOCAL_VIA_THIRD_PARTY.reached).toBe('third-party');

    // And the projections now answer correctly, which is the point — under
    // `device` the first two were wrong, under `remote` the first one was.
    const cli = { reach: REACH_LOCAL_VIA_THIRD_PARTY };
    expect(ranOnDevice(cli)).toBe(true);
    expect(reachKind(cli)).toBe('remote');
  });

  it('keeps the old three as the diagonal', () => {
    // Nothing about the existing destinations changed meaning; they are the
    // cases where the two axes happen to agree.
    expect(REACH_DEVICE).toMatchObject({ host: { kind: 'device' }, reached: 'device' });
    expect(REACH_REMOTE).toMatchObject({ host: { kind: 'third-party' }, reached: 'third-party' });
    expect(reachPaired({ id: 'p1', name: 'Studio' })).toMatchObject({
      host: { kind: 'paired' },
      reached: 'paired',
    });
  });

  it('reports the destination, not the host, as the label', () => {
    // `reachKind` decides what a reply is CALLED, and what a reader is owed is
    // where their words went — not which process typed them.
    expect(reachKind({ reach: REACH_LOCAL_VIA_THIRD_PARTY })).toBe('remote');
    expect(pairedDevice({ reach: REACH_LOCAL_VIA_THIRD_PARTY })).toBeUndefined();
  });
});

describe('the v7 conversion', () => {
  it('converts each old arm losslessly', () => {
    expect(upgradeReachValue({ kind: 'device' })).toEqual(REACH_DEVICE);
    expect(upgradeReachValue({ kind: 'remote' })).toEqual(REACH_REMOTE);
    expect(upgradeReachValue({ kind: 'paired', device: { id: 'p1', name: 'Studio' } })).toEqual(
      reachPaired({ id: 'p1', name: 'Studio' }),
    );
  });

  it('leaves an already-converted reach alone, so a replay changes nothing', () => {
    // Dexie can replay an upgrade. Returning undefined here is what makes that
    // safe — a second run must not re-derive from a shape it already wrote.
    expect(upgradeReachValue(REACH_DEVICE)).toBeUndefined();
    expect(upgradeReachValue(REACH_LOCAL_VIA_THIRD_PARTY)).toBeUndefined();
  });

  it('prefers an existing two-axis reach over a stale one-axis kind beside it', () => {
    /*
     * The case that makes the `reached` check load-bearing rather than
     * decorative: a row carrying BOTH shapes. A clean v7 value has no `kind`
     * and would fall through the switch to `undefined` anyway — but a row
     * half-written, or written by a build mid-transition, can have both, and
     * then `kind` would win and overwrite a CORRECT two-axis value with one
     * derived from a stale single axis.
     *
     * `{ kind: 'device' }` next to `reached: 'third-party'` is exactly the CLI
     * case being downgraded back to the wrong label this whole change exists
     * to fix.
     */
    const both = { ...REACH_LOCAL_VIA_THIRD_PARTY, kind: 'device' };
    expect(upgradeReachValue(both)).toBeUndefined();
  });

  it('refuses a paired row whose device it cannot read', () => {
    // "Paired, but the app cannot say which device" is the invalid state
    // Reach's own comment says must not be constructible.
    expect(upgradeReachValue({ kind: 'paired' })).toBeUndefined();
    expect(upgradeReachValue({ kind: 'paired', device: { id: 'p1' } })).toBeUndefined();
  });

  it('refuses a shape it does not recognise rather than guessing', () => {
    for (const bad of [undefined, null, 42, 'device', {}, { kind: 'elsewhere' }]) {
      expect(upgradeReachValue(bad), JSON.stringify(bad)).toBeUndefined();
    }
  });

  it('rewrites a row and its variants together', () => {
    // A reader that found one shape on the row and another on a variant would
    // render two different labels for one message.
    const row = {
      provenance: { backendId: 'llama-cpp', reach: { kind: 'device' } },
      variants: [{ provenance: { backendId: 'conn_1', reach: { kind: 'remote' } } }],
    };
    const upgraded = upgradeMessageReachAxes(row as never);
    expect(upgraded.provenance?.reach).toEqual(REACH_DEVICE);
    expect((upgraded.variants?.[0] as { provenance?: { reach?: unknown } })?.provenance?.reach).toEqual(
      REACH_REMOTE,
    );
  });

  it('drops a provenance whose reach it cannot read, rather than inventing one', () => {
    // The rule inherited from v4 and v6: a generation whose origin was not
    // recorded gets NO label rather than a plausible one.
    const upgraded = upgradeMessageReachAxes({
      provenance: { backendId: 'x', reach: { kind: 'elsewhere' } },
    } as never);
    expect(upgraded.dropProvenance).toBe(true);
    expect(upgraded.provenance).toBeUndefined();
  });
});

/* ── 5. #191: the picker and the provenance share one vocabulary ──────── */

describe('what a chat target will produce', () => {
  const model = {
    id: 'qwen',
    state: 'installed' as const,
    manifest: { name: 'Qwen3 4B', capabilities: ['text'] },
  };

  it('maps every target that runs to the reach it will be labelled with', () => {
    // The point of `reachOf`: the picker groups by the same value the reply is
    // labelled with, so "what the user chose between" and "what came back"
    // cannot drift into two taxonomies of one thing.
    expect(reachOf({ kind: 'local', model } as never)).toEqual(REACH_DEVICE);
    expect(reachOf({ kind: 'remote', provider: { id: 'c1', enabled: true } } as never)).toEqual(
      REACH_REMOTE,
    );
    expect(reachOf({ kind: 'paired', device: { id: 'p1', name: 'Studio' } })).toEqual(
      reachPaired({ id: 'p1', name: 'Studio' }),
    );
  });

  it('produces nothing for the targets where no turn runs', () => {
    // `refused` and `none` are not destinations; giving them one would put a
    // label on a reply that never came back.
    expect(reachOf({ kind: 'refused', model } as never)).toBeUndefined();
    expect(reachOf({ kind: 'none' })).toBeUndefined();
  });

  it('gives paired its own group rather than folding it into an existing label', () => {
    // #191's whole argument: filing a paired desktop under either existing
    // label makes that label false for at least one row in the list.
    const paired = reachOf({ kind: 'paired', device: { id: 'p1', name: 'Studio' } })!;
    expect(reachKind({ reach: paired })).toBe('paired');
    expect(reachKind({ reach: REACH_DEVICE })).toBe('device');
    expect(reachKind({ reach: REACH_REMOTE })).toBe('remote');
  });
});
