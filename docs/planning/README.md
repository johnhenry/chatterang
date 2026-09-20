# Planning context for the device-connection work

Four artifacts that drove the #7 device-connection work between 2026-09-14 and
2026-09-19. They lived only on the machine the work was driven from, so they are
copied here unedited, byte for byte, before that machine is left behind.

**These are a planning pass, not a specification.** They were produced by
read-only agent passes over the code and the issues — a survey of what existed,
a recommendation of what to build next, and a critic's corrections to that
recommendation. Nothing in them was ratified by being written down. Where a
sentence reads like a requirement, its authority is whatever issue comment or
merged test it cites, not the file. The exception is `RULINGS.md`, which records
owner decisions; see below for which of those are recorded anywhere else.

**`docs/NEXT-STEPS.md` supersedes these files wherever they disagree.** It was
written 2026-09-15 and updated 2026-09-19, is the only one of the five kept
current, and already carries the goal, what is on main, the rulings, the
branches, the build order and the open decisions. These four are the working-out
behind it: the per-unit briefs, file lists, line numbers and measurements that
`NEXT-STEPS.md` summarises in a line. Read them when you need to know *why* a
unit is shaped the way it is, or what a brief's acceptance criteria were. One
documented exception to the precedence rule is at the end of this file.

## The files

| File | Written | Against `main` at |
|---|---|---|
| [`epic7-synthesis.json`](epic7-synthesis.json) | 2026-09-14 | [`476c5cd`](https://github.com/johnhenry/chatterang/commit/476c5cd) (#299) |
| [`critical-path-plan.json`](critical-path-plan.json) | 2026-09-14 | [`88d7c78`](https://github.com/johnhenry/chatterang/commit/88d7c78) (#312) |
| [`track-maps.json`](track-maps.json) | 2026-09-15 | [`88d7c78`](https://github.com/johnhenry/chatterang/commit/88d7c78) (#312) |
| [`RULINGS.md`](RULINGS.md) | 2026-09-14 → 2026-09-19 | n/a — decisions, not a code survey |

`88d7c78` is 22 commits behind the `main` this directory was added to. Read every
"today", "currently" and "does not exist yet" in these files against that commit.

### `epic7-synthesis.json`

The #7 decision draft. Four keys:

- `decisionDraft` — the long-form argument for where work that outlives a window
  runs, and what the phone does instead. Its own header marks it a draft for the
  owner and a recommendation, not a ruling. It was read at `476c5cd` on the
  branch `complete-path-no-cloud-divert`, which no longer exists; the commit is
  on `main`.
- `minimumSubstrateForFirstPairedTurn` — the smallest set of pieces the first
  paired turn needs, on top of #158's existing gate.
- `buildSlices` — S1 through S12, each with scope, dependencies, size and the
  decisions blocking it. The S-numbers used throughout the other two files and
  throughout `NEXT-STEPS.md` are these.
- `ownerQuestions` — Q1 through Q8 (turn runner, tool policy, shared slot,
  socket drop, durability, window close, sleep, server turns), each with options
  and a recommendation. All eight were ruled; the rulings are the #7 comments
  linked below, and `RULINGS.md` plus `NEXT-STEPS.md` carry the answers. Note
  that despite the branch name it was read on, this draft does **not** recommend
  refusing a cloud fallback for a phone's turn — it records that "#296's
  fallback question stays open". The plan, written later, is the file that
  recommended "never"; see "Known stale".

### `critical-path-plan.json`

The build plan. Two keys:

- `plan.buildNow` — twelve units, BN1 through BN12, each with a full brief:
  why, scope, acceptance, the files it touches, the issues it refs, what it
  conflicts with, and whether it needs native code compiled.
- `plan.waves` — five waves ordering those units and the ones after them.
- `plan.ownerQuestions` — four questions the plan could not answer (Cloud
  reach, Phone tools, Not-sent log, Phone name). All four were ruled on
  2026-09-14; see `RULINGS.md`.
- `plan.stepsRemaining`, `plan.notes` — fourteen steps and nine notes.
- `critic.corrections` — 27 corrections from a second pass that read the code
  the briefs cite. Several find the brief simply wrong (BN1's signal path, BN4's
  return type, BN5's scope, BN7's atomic write, BN12's anchored regex). **Read a
  brief and its corrections together, never the brief alone.**

### `track-maps.json`

Six per-track maps, each with `track`, `state`, `ruled`, `openDecisions`,
`buildUnits` and `risks`. The `state` field is the valuable part: a measured
survey of what each track's code actually did at `88d7c78`, with file and line
citations. The tracks are:

0. #295 — the native socket plugin, with iOS, Android and Electron clients.
1. Desktop pairing screen (#127), paired-device records (#133), credential
   lifecycle and revocation UI (#134/#135, #131, #137), #304's window gate.
2. #170 surface declaration; S11 server turn refusal; #252 advertise address;
   #249 server statelessness.
3. S5 worker host + S7 desktop lifecycle and listener wiring (+#313) + S9
   inbound privacy copy.
4. S10 phone side (#184, #185, #188, #189) and honest display (#213 and on).
5. S4 — a turn runner that needs no chat row, with the relay hook (#296, #152,
   #292, #196).

### `RULINGS.md`

Every owner ruling made on 2026-09-14, 2026-09-15 and 2026-09-19, consolidated.
It is named for the first of those dates only; it covers all three. It binds
every brief in the other files and overrides anything in them that contradicts
it.

Each section, and where else the ruling is recorded:

| Section in `RULINGS.md` | Ruled | Also recorded as |
|---|---|---|
| Cloud reach (#296) | 2026-09-14 | [#296 comment](https://github.com/johnhenry/chatterang/issues/296#issuecomment-5674347918) |
| Phone tools (#170), Not-sent records (#170) | 2026-09-14 | [#170 comment](https://github.com/johnhenry/chatterang/issues/170#issuecomment-5674348063) |
| Phone name (#129) | 2026-09-14 | [#129 comment](https://github.com/johnhenry/chatterang/issues/129#issuecomment-5674348210) |
| — the four above, rolled up | 2026-09-14 | [#7 comment](https://github.com/johnhenry/chatterang/issues/7#issuecomment-5674348336) |
| Show pairing code (#127) | 2026-09-15 | [#127 comment](https://github.com/johnhenry/chatterang/issues/127#issuecomment-5683675317) |
| After restart (#158) | 2026-09-15 | [#158 comment](https://github.com/johnhenry/chatterang/issues/158#issuecomment-5683675657) |
| Phone credential (#135) | 2026-09-15 | [#135 comment](https://github.com/johnhenry/chatterang/issues/135#issuecomment-5683676013) |
| Desktop not-sent records (#170) | 2026-09-15 | [#170 comment](https://github.com/johnhenry/chatterang/issues/170#issuecomment-5683676425) |
| — the four above, rolled up | 2026-09-15 | [#7 comment](https://github.com/johnhenry/chatterang/issues/7#issuecomment-5683676780) |
| "Earlier today": the broker's shared slot (#7) | 2026-09-14 | [#7 comment](https://github.com/johnhenry/chatterang/issues/7#issuecomment-5671385506) |
| "Earlier today": pairing code URI cap, addresses, multi-block OAT (#127) | 2026-09-14 | [#127 comment](https://github.com/johnhenry/chatterang/issues/127#issuecomment-5670808085) |
| "Earlier today": stopped reply; draft discarded with its chat | 2026-09-14 | **this file only** |
| Tool-call parsing (`stopped-empty-reply`) | 2026-09-14 | **this file only** |
| Tool-call shapes | 2026-09-19 | **this file only** — see below |

The two dates in `RULINGS.md` are local (UTC-7); the linked comments show UTC,
so the 2026-09-14 batch is timestamped `2026-09-15T03:36Z` and the 2026-09-15
batch `2026-09-15T16:07Z`.

## Known stale

Verified against `main` at `15749cb`, the commit this directory was added to.

- **All three JSON files predate everything merged after `88d7c78`** — PRs #314
  through #345, 22 commits. Every survey sentence in them is a statement about
  `88d7c78`.
- **"Never divert a phone turn on the desktop" is overturned.**
  `critical-path-plan.json`'s wave 1 carries "S4-U5 Engine per-request no-divert
  flag", and its `Cloud reach` owner question recommends "Never: desktop models
  only, no fallback". The #296 ruling reversed this for the desktop side: a
  phone's turn run by the desktop may follow the desktop's own nominated cloud
  fallback, and the reply's label says what answered. `RULINGS.md` says so in
  its own words, marking the plan OVERTURNED. The phone side is unchanged
  (#188). Track map 5's "U5 Engine refuses to divert" is stale for the same
  reason. `epic7-synthesis.json` is not affected: it left the question open.
- **The whole of track map 0 (#295) has landed, at different paths.** U1 by
  [#326](https://github.com/johnhenry/chatterang/pull/326), U2–U5 by
  [#332](https://github.com/johnhenry/chatterang/pull/332), U6 by
  [#336](https://github.com/johnhenry/chatterang/pull/336). The map's file lists
  are wrong about where: the Electron client is `apps/desktop/src/net/tunnel-socket.ts`,
  not `packages/tunnel/src/node-client/`; the transport adapter is
  `src/lib/tunnel-socket-transport.ts`, not `src/plugins/tunnel-socket/transport.ts`;
  the Kotlin package is `app.chatterang.tunnelsocket`, not `app.chatterang.tunnel`.
  The map's `nativeCompileNeeded: true` on U4 and U5 is a separate question from
  whether the source exists: `docs/NEXT-STEPS.md` records that neither the iOS
  nor the Android source has been compiled or run (#342).
- **Eleven of the twelve `buildNow` units have merged**, several under names the
  briefs do not use: BN1 as #321, BN2 as #322, BN3 as #328, BN4 as #325, BN5 as
  #323, BN6 as #324, BN7 as #345, BN9 as #326, BN10 as #327, BN11 (S10 U2) as
  [#319](https://github.com/johnhenry/chatterang/pull/319) rather than as the new
  `tests/paired-no-divert.test.ts` the brief names, and BN12 as #320. **BN8**,
  the pairing exchange over pair frames with the desktop's accept before any
  credential is minted, has not: `packages/tunnel/src/pairing/` still holds only
  `index.ts`, `typed.ts` and `window.ts`. `docs/NEXT-STEPS.md`'s "What is on
  main" is the current list; this one is a pointer, not a ledger.
- **`RULINGS.md`'s tool-call sections describe a branch that has not merged.**
  `stopped-empty-reply` exists on `origin` and is not on `main`; `37040cc`, cited
  by the plan and the track maps as the stopped-reply commit, is not an ancestor
  of `main`.

### The one place `NEXT-STEPS.md` does not supersede

`RULINGS.md`'s last section, **"Tool-call shapes (ruled 2026-09-19)"**, is newer
than `docs/NEXT-STEPS.md`. `NEXT-STEPS.md` merged 2026-09-19 at 06:43 local;
this file was last written the same day at 15:25 local. Those two rulings answer
exactly two rows that `NEXT-STEPS.md` still lists under "Decisions still needed"
— the no-arguments fenced call, and the repeated `[tool name({…})]` — and they
rule both the way the branch already has them, which is also what `NEXT-STEPS.md`
recommends. So nothing contradicts; `NEXT-STEPS.md` is simply one revision
behind on two rows.

**Those two rulings are recorded here and nowhere else.** They are not a comment
on #7 or on any other issue: #7 carries seven comments, the most recent dated
2026-09-15, and the only issue comments made in this repository since 2026-09-16
are four notes on #315–#318 about #333. Two owner actions follow, and neither
has been taken:

1. Post them as a comment on #7, so they live where every other ruling lives.
2. Strike the two rows from `NEXT-STEPS.md`'s "Decisions still needed", and the
   "Rule on `stopped-empty-reply`'s two choices" item from its "Owner actions
   outside the code".

## Reading notes

- Nothing here is loaded by the app, the build or the tests. `tsconfig.json`'s
  `include` does not list `docs`, and no test walks this directory: the roots in
  `tests/bundle.test.ts` and the `apps/*/src` and `packages/*/src` derivation in
  `tests/support/source-scan.ts` both stop short of it.
- `track-maps.json` names the checkout it was written from as an absolute path
  on the author's machine, three times. It is left as written.
- The PR bodies for the branches these plans produced are not copied here. Their
  text is on the merged PRs, which is a better home for it.
