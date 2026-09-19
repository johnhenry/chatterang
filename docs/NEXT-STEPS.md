# Next steps: the first honest paired turn

Where the device-connection work (#7 and the tracks under it) stands, what is
in progress, and what comes next.

- **Written:** 2026-09-15, with `main` at `4b62928` (#328).
- **Updated:** 2026-09-18, with `main` at `3e72abb` (#335).
- **Scope:** the path from today's code to the first turn a phone runs on the
  user's own desktop. Anything on that path is listed here; everything else is
  in the issues.
- **Staleness:** this file describes a moment. When a unit below merges, the
  issue or PR it names is the source of truth, not this list.

## The goal

The first honest paired turn is one end-to-end test that passes against real
code:

1. An Android emulator pairs with the desktop by scanning its QR code, and the
   desktop asks "Pair with <device name>?" before it trusts the phone.
2. The phone sends a turn. The desktop runs it in its hidden worker, on the
   desktop's own model.
3. The phone's chip names the desktop as what answered.
4. A tool confirm relayed to the phone and answered "no" leaves a not-sent
   record on both sides.
5. A socket cut mid-turn is recovered by `attach`, with exactly one terminal.

Everything below is ordered by what that test needs.

## What is on main

Merged between #300 and #335, grouped by what they give the goal.

**Desktop identity and the tunnel**

- #302, #307: the desktop's TLS identity. A P-256 key kept owner-only (sealed
  with DPAPI on Windows), an SPKI pin, and certificates re-issued from the same
  key.
- #304: `TunnelBinding`, with a credential gate on both arms, per-device
  credentials stored as hashes, and pairing accepted only while a code is shown.
- #308: #7's wire vocabulary: `waiting`, `prompt`/`answer`, refusal codes
  (including `HOST_DOES_NOT_RUN_TURNS`), `attach`/`ack`, and `MAX_OPEN_TURNS`.
- #322: a turn says who runs its tool loop (`toolLoop: 'requester' | 'host'`),
  and a host refuses one it does not run with `TOOL_LOOP_UNSUPPORTED` (#152).
- #324: one address enumeration in the tunnel host. An `--advertise` value a
  pairing code cannot carry refuses to start.
- #326: the tunnel client runs over a transport it is handed; the socket
  plugin's whole contract is declared, including `credentialRef` and
  `expectedPeer` (#295).
- #332 (#295): the native socket plugin, with real TLS on iOS, Android and the
  Electron desktop, and a browser that refuses before it dials
  (`src/plugins/tunnel-socket/web.ts`). It adds `native/plugin-tunnel-socket/`,
  the desktop's leg in `apps/desktop/src/net/tunnel-socket.ts`, the
  registration in `src/plugins/tunnel-socket/*`, and
  `src/lib/tunnel-socket-transport.ts`, which adapts any socket plugin to the
  client's transport.
  - The desktop's leg checks the pin before it writes the upgrade request or
    the credential, tested against a real listener.
  - The iOS and Android sources check it during the TLS handshake, but neither
    has been compiled or run.
  - `src/ai/backends/tunnel.ts` does not use the transport yet.

**Pairing codes**

- #303: the pairing code is one OAT QR frame carrying the whole URI.
- #309: every code fits QR version 13 (URI cap 296). Addresses give way before
  the device name, and the phone refuses a frame claiming more than one block.

**Desktop substrate (#7)**

- #310 (S1): measurements of the Supervisor across sleep, two generates on one
  llama handle, and a hidden worker's call path.
- #311 (S2): the work broker. One slot shared by local and phone work, one wait
  list, held results, one settle, and a window's slot kept between steps.
- #312 (S6): the desktop's own turns and benchmarks take the broker's slot. A
  desktop turn holds it for the whole turn, tool calls included.
- #323: sleep ends every generation `HOST_SUSPENDED`; wake admits again. Nothing
  keeps the computer awake.
- #325: the hidden worker host. It is built when the first phone unit runs,
  destroyed when idle, with one Supervisor per worker life and a restart cap
  across lives. Since #334, `main.ts` builds it, the broker's
  `condemnExecutor` calls it, and local turns know its units through
  `hostedUnitOf`. Nothing in `main.ts` calls its `run` yet, because no
  listener runs.
- #328: Electron 44 probes for the hidden worker, window lifecycle and reload
  order (`docs/BACKGROUND-WORK-MEASUREMENTS.md`).
- #330 (#313): a reload's old document can no longer open a whole turn that
  holds the shared slot. `LocalTurns.closeReloadGap`, wired to `did-navigate`
  in `main.ts`, is a second teardown when the new document commits, and ends
  whatever whole turn the window still holds. `forgetWindow`, called after a
  window's `destroyed`, drops the requestIds its teardowns ended, which were
  otherwise kept for as long as main ran.
- #334 (#296): a phone's turn arriving over the tunnel runs on a real hidden
  worker and streams back.
  - `apps/desktop/src/bridge/peer-turns.ts` refuses any turn but
    `toolLoop: 'requester'` with `TOOL_LOOP_UNSUPPORTED`, re-runs the clearing
    gate (#145), drops `metadata.custom` (#141), admits the turn to the broker,
    and relays the worker's frames and its one terminal.
  - The worker page, `src/peer-turn-worker.ts`, loads in a hidden window built
    by `apps/desktop/src/bridge/peer-turn-window.ts`, and runs the request on
    `engine.llama.executeStream()`.
  - `wirePeerTunnels` is not called from `main.ts` yet.
  - What this means for the owner's rulings is under the rulings table.
- #300, #306: an exited or crashed inference host settles as `HANDLE_LOST`
  instead of crashing or blocking main.

**Phone side**

- #320: the paired-device table at Dexie v10, with no credential column and no
  reader or writer in `src/` yet.
- #327: a paired device is an aimatey backend (`tunnel:<deviceId>`). Every turn
  to it ends in exactly one terminal, and a busy, quitting, sleeping or
  unreachable desktop does not pause it.
- #319: a turn tunnelled to a paired device is never diverted by the phone.

**Turns and chats**

- #305: Stop ends every running turn, and no second turn starts while one runs.
- #321: Stop takes a bash confirm sheet down and answers it no (#293 item 4).
- #301: `complete()` never diverts a turn to the fallback.
- #314: an image never sent does not stay on the device; a grant left on disk
  by a killed withdrawal does not come back; deleting a chat, or every
  conversation, discards the draft.
- #331 (#293): a tool call Stop caught mid-stream, or written past the
  tool-round limit, is recorded as not sent (why `stopped` or `round-limit`),
  and a refusal nobody could be asked about is recorded `unattended` rather
  than `not-allowed`.
- #333 (#315, #316, #317, #318):
  - a paste into a disabled composer is ignored;
  - the chat opened after a delete skips one that is itself mid-delete, and the
    composer is inert with no chat open;
  - switching a connection or MCP server on and off queues by id
    (`serializedByKey` in `src/lib/serialize.ts`), so a switch-on during a
    switch-off's write no longer keeps a grant;
  - a refused switch-on shows a toast, and the switch is disabled while it is
    pending.

**Tests**

- #335: `tests/pairing-entry-available.test.tsx` waits for the pairing sheet's
  import and a 15 s time bound, not 50 rounds of `settle()`.
  - With the import delayed 300 ms, the old wait failed 5 of 5 runs and the new
    one passed 5 of 5.
  - How often the old wait failed under load is not settled: 8 of 12 runs for
    the builder, 1 of 12 when re-measured for the PR, and none in a later
    triage, where main's file passed 5 of 5 and the first press used 17 of the
    50 rounds.

## Owner rulings that bind the remaining work

All eight #7 questions were ruled earlier; see the ruling comments on #7. These
later rulings change the plan, and each has a comment on its issue.

| Topic | Ruling | Where |
|---|---|---|
| Shared slot | A desktop turn holds the work broker's slot for the whole turn, tool calls included. | #7 |
| Cloud reach | A phone's turn run by the desktop may follow the desktop's own nominated cloud fallback; the phone is told what answered. | #296 |
| Phone tools | An allowed bash is the desktop's own shell (`/chats`, granted folders, desktop-changing commands). Every confirm is relayed to the phone. MCP tools still need their desktop grant. | #170 |
| Not-sent records | Kept in full, arguments included, on the phone and on the desktop. This amends #7 ruling 2 for these records. | #170, #7 |
| Desktop's not-sent store | Kept per phone beside the paired-devices records, with a Clear control, and deleted when that phone is removed or pairing is reset. | #170 |
| Phone name | The phone offers a name the person can edit. The desktop shows it, keeps it and lets the person rename it. Hidden or direction-changing characters are refused. | #129 |
| Show pairing code | Showing a code turns the tunnel on while the code is shown. It stays on only if a phone pairs. | #127 |
| After restart | The tunnel is off at every launch. | #158 |
| Phone credential | The iOS Keychain (this device only) or Android Keystore (excluded from backups). The web layer holds only a reference. | #135 |
| Stopped reply | A reply stopped before its first word is kept, marked "Stopped", and never sent to the model. | #7 (in flight) |
| Fenced tool calls | A fenced JSON block runs as a call when its name is a tool the request offered; extra keys such as `"id"` are allowed. | stopped-empty-reply branch |

Three things the earlier plan assumed are now false:

- The engine does not need a per-request "never divert" flag for phone turns.
- The worker does not boot without provider connections.
- The desktop does not hold not-sent records only in memory.

**What #334 builds of these rulings.** #334 serves inference only. It runs a
phone's turn only when the phone keeps the tool loop, and runs it on the
desktop's llama.cpp adapter, without the tool middleware and outside
`engine.stream()`. So:

- **Phone tools are not built.** No tool runs on the desktop for a phone, and
  no confirm is relayed: #334's handler can send a broker `prompt` notice as a
  `prompt` frame and hand an `answer` back, but nothing raises one. Host-run
  tools and relayed confirms remain to be built (wave 3).
- **Cloud reach is not built.** A phone's turn never reaches the desktop's
  nominated fallback, and #334 clears the request as local because, as built,
  the reply never leaves the machine. Following the fallback, and carrying the
  reach back to the phone, remain to be built (wave 2).
- **The desktop's not-sent store** has nothing to hold yet, because no tool
  runs there for a phone.
- #334's code comments call #170's tool question open. The #170 rulings above
  answer it.

## Branches in progress

On 2026-09-18 a workflow is finishing these four branches one at a time, in
this order. None is merged as this is written, and how each ends is not known
yet. Each is rebased onto the newest `main` and checked again before its PR
opens.

### 1. `pairing-negotiated-spki`

A pairing connection is bound to the certificate that connection negotiated
(#295 U6). #295 itself is no longer open; #332 completed it. Built and reviewed
before the pause at `8a5fae9`, with low findings only.

**State: in progress.** This run rebases it onto `3e72abb` and corrects three
sentences on the branch that #332 made false.

<!-- OUTCOME: pairing-negotiated-spki -->

### 2. `server-privacy-pins`

The server's "owns no user data" sentences are pinned beside the measurements
that make them true, so a paired-device registry in `apps/server` fails their
tests (#249). Built before the pause at `290ca03`. Its review found one medium
problem: the forcing test misses a registry written the way `apps/server`
already stores files.

**State: in progress.** This run rebases it and makes the pins catch a
registry written through the server's own file-storage path, which a
reproduction showed they miss.

<!-- OUTCOME: server-privacy-pins -->

### 3. `test-313-teardown-coverage`

A guard that fails if `main.ts`'s reload-gap wiring is removed (refs #313).
#330 is merged, but a full-suite mutation that deleted its `did-navigate` →
`closeReloadGap` line in `apps/desktop/src/main.ts` left every test green:
`tests/desktop-local-turns.test.ts` calls `closeReloadGap` and `forgetWindow`
directly, and no test reads the wiring. New in this run; it replaces
`fix-313-reload-gap` (below).

**State: in progress**, being built.

<!-- OUTCOME: test-313-teardown-coverage -->

### 4. `stopped-empty-reply`

28 commits. A reply stopped before its first word stays in the thread marked
"Stopped" and is never sent to the model, and tool-call markup is read and
stripped so that a stored or resent reply carries none of a call's arguments.
It applies the stopped-reply and fenced-call rulings above. Before the pause
its head was `c3d80be`, on `91df1f6`, and round 1 of the next review found four
medium problems (below).

**State: in progress.** This run:

1. rebases it onto the newest `main`, with one conflict in `src/ai/engine.ts`
   and a type error at a call site #331 added;
2. addresses the four open findings below;
3. then runs review rounds until one finds nothing medium or higher, up to
   four. It merges only if one does.

<!-- OUTCOME: stopped-empty-reply -->

The four open findings:

1. A JSON record whose `"name"` equals an offered tool's id runs as a call and
   is stripped.
2. A follow-up that recounts its own call in the app's `[tool name({…})]` form
   runs the tool again.
3. A real `<tool_call>` does not run when words before it, in reasoning or
   prose, name `<tool_call>`.
4. A stopped turn does not cut a tag call whose body is single-quoted, has
   unquoted keys, or is an array.

The turn runner's next step and the provenance work wait on this branch
(wave 2).

### Not in the workflow

- `fix-313-reload-gap` (`28e71c3`): dropped, superseded by #330. The one piece
  worth keeping, a guard on main's wiring, is `test-313-teardown-coverage`
  above.
- `test-pairing-entry-load-proof`: merged as #335.
- `bn7-device-registry`: not started. The build was stopped before its first
  commit, and the branch name points at `91df1f6` with nothing on it. Restart
  from the brief (the registry file, wave 1).

## The build order

Each unit is built with failing tests first, reviewed adversarially, and merged
on its own. A unit waits only on the units and decisions named after it. Units
in the same wave can be built in parallel once their inputs are merged.

### Wave 1: finish what is in progress, and the unblocked substrate

- **Finish the branches in progress**, in the order listed above.
- **Paired-device registry file** (#133, #135, #179). One file in the host
  package, shared by the desktop and the server, holding verification data
  only. Its requirements:
  - atomic replace with a rename-fault test;
  - a Windows user-only file;
  - on a changed pin, clear the file with `binding-changed`;
  - refuse a protection mismatch only when the pin matches;
  - removal and reset as explicit operations that the not-sent store (wave 3)
    can hook into.
- **Sleep clock.** Waits on the owner's sleep measurement (see "Owner actions").
  Until then, the recorded fallback stands: a suspend longer than the ping or
  idle budgets reloads the host.

### Wave 2: pairing and the turn runner

- **Pairing exchange** (#135, #129, #130, #136). Pair frames carry the desktop's
  accept before any credential is minted, and the phone's offered name. Waits on
  the registry.
- **Tunnel surface declaration** (#170). It is asserted before the listener
  binds, and it is a required option of the listener. Waits on the registry.
- **Turn runner: the desktop's fallback** (S4, refs #296). #334 built the core:
  a decoded turn comes in and frames go out, with no chat row, and the
  tool-loop owner is honoured by refusing `'host'`. It runs the request on
  `engine.llama.executeStream()`, so the desktop's fallback never applies. What
  is left, per the cloud-reach ruling:
  - run a phone's turn where the divert sites in `engine.stream()` are live,
    still without running the desktop's tools under `'requester'`;
  - carry any diverted reach back to the phone in the reply's provenance;
  - clear the request for where it goes. `prepareRequest` in
    `apps/desktop/src/bridge/peer-turns.ts` clears it as local because the
    reply never leaves the machine, which stops being true once it can divert.
  - Waits on `stopped-empty-reply` merging, since both change `src/ai/engine.ts`.
- **Provenance carries reach end to end** (S10 U1). Waits on
  `stopped-empty-reply`, since both change `src/state/chat.ts`.
- **Phone renders relayed prompts, waiting and refusals** (S10 U8). #334's
  desktop already sends `waiting` and the refusals, including
  `TOOL_LOOP_UNSUPPORTED`. `HOST_DOES_NOT_RUN_TURNS` reads "this server doesn't
  run phone turns yet".
- **Phone secure credential storage** (native; new from the #135 ruling). iOS
  Keychain (this device only) and Android Keystore (excluded from backups),
  reached through `credentialRef`. Compile Swift and Kotlin explicitly, under a
  timeout.

### Wave 3: policy, controllers and the first native plugin

- **Phone policy and relay hook** (S4 U2). A phone turn uses the desktop's own
  bash, with every confirm relayed. MCP needs the desktop grant plus a relayed
  answer. Refused calls are recorded in full on both sides.
  - This is the `toolLoop: 'host'` path, built on both sides (#152's ruling).
    Today the phone always sends `'requester'` (`src/ai/backends/tunnel.ts`),
    and #334 refuses `'host'`.
  - #334's handler already turns a broker `prompt` notice into a `prompt` frame
    and hands an `answer` to the broker. Nothing raises a prompt yet.
- **Desktop not-sent store** (new from the #170 ruling). Per phone, beside the
  registry, with a Clear control, and deleted with the phone or on reset.
- **Tunnel-to-broker controller** (S7b). #334's `wireDeviceTunnel` does most of
  it: device attach and detach, `cancel`, `ack`, and an inbound `attach`
  answered from held results or with `RESULT_UNKNOWN`. Left: the bounded stop
  and quit the plan asked for, which #334 does not claim, and calling
  `wirePeerTunnels` from the listener's start path (wave 5).
- **Desktop pairing host controller in main.** Showing a code mints the payload
  through `fitPairingPayload` and turns the tunnel on while the code is shown.
  One window at a time, an accept prompt with the phone's name, and a mint
  through the registry. `tests/desktop-security.test.ts` must be narrowed so
  `main.ts` can import the host's address enumeration.
- **Far-side provenance** (S10 U4). What the desktop reports only ever widens
  reach, and a desktop-side cloud divert shows as third-party.
- **Paired chip and palette** (S10 U5; #210, #213, #219).
- **Android socket plugin** (#295 U5). #332 wrote it: OkHttp, with a trust
  manager that checks the pin in `checkServerTrusted`. Left: compile it and run
  it on an emulator that reaches the desktop at `10.0.2.2`, with the
  negative-pin test.

### Wave 4: assemble

- **Worker window** (S5c with S4 U4). Mostly built by #334:
  - a hidden `BrowserWindow` (`apps/desktop/src/bridge/peer-turn-window.ts`);
  - a preload over a `MessageChannelMain` port
    (`apps/desktop/src/peer-turn-preload.ts`);
  - `main.ts` passing `hostedUnitOf` and `condemnExecutor`;
  - the worker's provider connections, loaded by `initialize()`.

  It differs from the plan. The plan's worker entry never imported `App` or
  `initialize()`, and its preload reset per unit. #334's hidden window loads
  the whole bundle, so `src/main.tsx` renders `App` there too, the worker runs
  `initialize()`, and nothing resets the page between units. Check before the
  rung whether that matters; if it does, a worker-only entry is what is left of
  this unit.
- **Revocation composition:** credentials, the broker and the registry, in one
  path.
- **Phone registration** (S10 U7). Tunnel backends are never fallback-eligible,
  credentials live in the keychain, and revocation removes the row and the
  router backend (#131). `src/ai/backends/tunnel.ts` runs over #332's
  `src/lib/tunnel-socket-transport.ts`, which nothing uses yet.
- **Rail, picker and target agree on the paired arm** (S10 U6; #212).
- **Desktop "Show pairing code" sheet** and the paired-devices panel.
- **Phone attach and ack after a dropped socket** (S10 U9).
- **iOS socket plugin** (#295 U4). #332 wrote it: `URLSessionWebSocketTask`,
  with the pin checked in the TLS challenge before the handshake completes.
  Left: compile it, run it on a simulator with the negative-pin test, and
  measure the Local Network prompt on hardware. #332 names its riskiest spot:
  rebuilding the SPKI DER from `SecKeyCopyExternalRepresentation`'s raw EC
  point.

### Wave 5: turn it on, and the rung

- **Listener start path with the inbound privacy copy, in one change** (S7c,
  S9b; #221, #217):
  - the first desktop `createTunnelListener(` call, only on the explicit toggle,
    off at every launch;
  - the listener's tunnels handed to #334's `wirePeerTunnels`;
  - the #170 assertion before bind;
  - the tray on every OS;
  - `before-quit` (broker quit, then a bounded listener close);
  - `window-all-closed` counting only visible, non-worker windows. The probes
    showed a hidden worker holds it back.
  - The privacy guard fails any desktop listener until the copy lands with it.
- **Phone availability flip.** The pairing controller, the panel, the table and
  the #221 copy change together.
- **The end-to-end rung** on an Android emulator against the real desktop (see
  "The goal"). This is the first honest paired turn.

### After the rung

- Server: turn refusal per frame, its own tunnel start path and port, and the
  corrected "owns no user data" sentence with the registry (#249, #252).
- The desktop as a pinned tunnel client (#295 U3). #332 built and registered
  the desktop's socket leg (`apps/desktop/src/net/tunnel-socket.ts`); nothing
  uses it yet.
- Swap the OAT stand-in modules for `@johnhenry/oat-qr-fountain` 0.1.1 subpath
  imports once it is published, before the phone availability flip.
- Paired-devices panel: rename, reset key, last seen.

## Decisions still needed

Each row is a decision that belongs to the owner, with the recommendation from
the planning pass. Where a ruling above already answers part of a question, only
the open part is listed.

| Decision | Blocks | Recommendation |
|---|---|---|
| The exact inbound privacy sentences (#221, #217), including that a phone's turn can reach the desktop's cloud fallback, read the desktop's conversations through bash, and leave not-sent records on the desktop. | Wave 5 listener start | Draft them against the measured rung and approve them in that PR. |
| May the phone pick one of the desktop's connected cloud models directly (not only through fallback)? | Turn runner (wave 2) | Not in v1. |
| How the privacy-copy pairing checks distinguish a phone that pairs as a client from a desktop that hosts pairing (#124 D8). | Desktop pairing sheet, panel | Two capability rows, with the copy pinned verbatim. |
| Does the desktop sheet show the QR code and the typed code at once, or one at a time? | Desktop pairing sheet | QR by default, with a switch that replaces the window. |
| When a code expires, draw a new one or ask? | Desktop pairing sheet | Ask, with one-click "Show a new code". |
| Revocation confirmations and the after-pairing screens on each side. | Paired-devices panel | Pin them in `tests/privacy-copy.test.ts`, reusing the attributed-name rule. |
| The desktop's own name in the pairing payload. | Pairing host | The OS computer name, editable. |
| What a Linux desktop does when a tray icon cannot be shown with the tunnel on (not measured). | Wave 5 tray | Measure on GNOME, KDE and Windows first. Where it cannot be shown, the last window closing turns the tunnel off. |
| The iOS Local Network purpose string. | iOS plugin shipping | Follow the camera-string precedent, pinned beside it. |
| Server: a separate tunnel port from the bridge's 8973; switching it on from the command line; the corrected sentence once a registry exists (#249). | Server tunnel start | A separate port and flag; a command-line switch in v1; the enumerated, checkable sentence form. |
| Does the paired chip show the served model as well as the machine name? Does the rail gain a paired state? | Chip and rail | Machine name in the chip, and the model in the model slot; add a "paired" rail state. |
| Does the taint mark survive to a paired desktop? | Tunnel adapter | Keep stripping it in v1. |
| How a chat pins a paired device's model. | Rail and registration | A structured field, not an overloaded `modelId`. |

#334 settled none of these. Its runner resolves no target: it runs every phone
turn on the desktop's llama.cpp adapter.

## Owner actions outside the code

- **Run the sleep probe.** `dev/probe-electron-hidden-worker/sleep-order.cjs`
  records timer ticks and `powerMonitor` suspend and resume. Sleep and wake the
  machine three times; section 5.4 of `docs/BACKGROUND-WORK-MEASUREMENTS.md`
  says how to read the result. The sleep clock waits on it.
- **Publish `@johnhenry/oat-qr-fountain` 0.1.1**, with the subpath entrypoints
  and the block-count bound.
- **Approve the inbound privacy sentences** in the wave 5 PR.
- **Hardware measurements before release:** the iOS Local Network prompt, and
  the tray on Linux and Windows.

## Follow-up issues

Filed during this work and not on the critical path:

- #313: a reloaded window's old page could open a whole desktop turn that held
  the shared slot. #330 repaired it; `test-313-teardown-coverage` (above)
  guards its wiring in `main.ts`.
- #315, #316, #317 and #318: all four are done by #333 (above).

Found in review, not yet filed:

- In a chat with tools, a stopped turn that was writing a fenced-JSON tool call
  keeps half the call and sends it back to the model.
- A turn's finish sets the chat-list preview from whichever chat is open, not
  from the chat the turn ran in.
- `tests/pairing-entry-available.test.tsx` cannot catch an entry that opens its
  sheet on mount without a press. This predates the load-proof change, and
  #335 lists it under its known limits.

## How work is verified here

The same bar applied to everything merged above:

- **Fail first.** Every guarantee has a test that fails on `main` before the
  change, recorded in the PR.
- **Mutation checks.** Each guarantee is removed, one at a time, and a named test
  must fail; then the file is restored.
- **Both gates.** `npm run typecheck` (`tsc -b`) and `npx vitest run` both exit
  0, with each exit code read directly rather than through a pipeline. Vitest
  passing says nothing about `tsc`.
- **Adversarial review.** Independent reviewers try to break each change, and a
  finding counts only if a test reproduces it. Medium and higher is fixed before
  merge; lower goes in the PR's known limits or an issue.
- **One at a time.** Each branch is rebased onto the newest `main` and checked
  again before its PR opens, and CI must pass before it merges. Stacked
  branches are replayed with `--onto` after the branch below them merges.
- **Load-sensitive tests** wait on the event they mean, bounded in time, never a
  fixed number of rounds (#297, #299, #335). Under load, `layout-engine`,
  `egress-grants`, `desktop-host-process` and `pairing-entry-available` have
  failed before; re-run a failure alone before calling it a defect.
- **Git hygiene.** Never `git stash` (worktrees share one stash stack). Commit
  explicit paths. Never put a closing keyword next to an issue number that
  should stay open; write "refs #N".
- **Native code** is compiled explicitly, because the repo's native checks are
  source greps.
