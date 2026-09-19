# Next steps: the first honest paired turn

Where the device-connection work (#7 and the tracks under it) stands, what is
in progress, and what comes next.

- **Written:** 2026-09-15, with `main` at `4b62928` (#328).
- **Updated:** 2026-09-19, with `main` at `12c9ff1` (#344).
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

Merged between #300 and #344, grouped by what they give the goal.

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
    has been compiled or run (#342).
  - `src/ai/backends/tunnel.ts` does not use the transport yet.

**Pairing**

- #303: the pairing code is one OAT QR frame carrying the whole URI.
- #309: every code fits QR version 13 (URI cap 296). Addresses give way before
  the device name, and the phone refuses a frame claiming more than one block.
- #336 (#295 U6): a pairing connection is bound to the certificate that
  connection negotiated. `openBoundPairingConnection` in `src/lib/pairing.ts`
  asks the socket for `negotiatedPeer` only after its `tunnelOpen`, and an
  answer with no certificate is refused as `bad-negotiated-spki`.
  - `tests/pairing-desktop-socket.test.ts` runs it over #332's desktop leg,
    registered in a real `PluginHost`, against a real TLS listener. The right
    pin is admitted. A wrong pin closes with `PEER_MISMATCH` before any upgrade
    is written. With no pairing window open, the listener answers 401.
  - Nothing calls it yet: the CPace exchange is not defined, and
    `pairingController()` still returns `UNAVAILABLE_PAIRING`.
  - Not exercised: the last hop to a page (`createRendererBridge` and the
    Capacitor shim), and iOS and Android, which have not run this path (#342).

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
  otherwise kept for as long as main ran. #344 (under "Tests") guards both call
  sites.
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
  - Under load the old wait does fail, the way the original report did: 1 of 12
    runs when re-measured for the PR, while the new one passed 12 of 12. How
    often is not settled. The builder's earlier 8 of 12 was not reproduced, and
    a later triage saw main's file pass 5 of 5.
- #343 (refs #249): the server's "owns no user data" sentences are pinned in
  `tests/privacy-copy.test.ts`, in the same tests as the measurements that make
  them true.
  - A paired-device registry in `apps/server`, or one that `apps/server` hands
    `--root` or its file system to, fails those tests by name. Measurement (iii)
    is an exact inventory of every place `apps/server` hands a location to write
    to code outside itself.
  - The scan is lexical and does not follow data flow. It does not see a path
    renamed on the way (`options.directory`), a registry reached through a
    wrapper, `import()` or `require()`, or one kept by another process.
- #344 (refs #313): `tests/desktop-security.test.ts` fails a named test when
  `main.ts`'s `did-navigate` → `closeReloadGap` line, or the `forgetWindow`
  call in its `destroyed` teardown, is deleted, commented out or moved. Guard
  [6] now reads `main.ts` with comments stripped as well, so a commented-out
  `destroyed` registration fails it.
  - Left: the other guards in that block still read the raw text, and
    `senders.delete(id)` in the same teardown is not tested.

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
| Stopped reply | A reply stopped before its first word is kept, marked "Stopped", and never sent to the model. | #7; built on `stopped-empty-reply`, not merged |
| Fenced tool calls | A fenced JSON block runs as a call when its name is a tool the request offered; extra keys such as `"id"` are allowed. | Ruled on `stopped-empty-reply`, not merged. The branch reads "extra keys" as keys beside a name and its arguments; the owner has yet to confirm that (see "Decisions still needed"). |

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
  tools and relayed confirms remain to be built (wave 3; #339). The phone side
  is unbuilt too: it always sends `'requester'` and refuses every relayed prompt
  itself.
- **Cloud reach is not built.** A phone's turn never reaches the desktop's
  nominated fallback, and #334 clears the request as local because, as built,
  the reply never leaves the machine. Following the fallback, and carrying the
  reach back to the phone, remain to be built (wave 2; #340). No wire frame
  carries a reach yet, so the phone's label comes from its own choice of target
  (#213). The worker already loads the desktop's provider connections through
  `initialize()`, as a snapshot taken when it boots; nothing on the phone-turn
  path uses them.
- **The desktop's not-sent store** does not exist yet, and on `main` neither
  does the persisted paired-devices record it is to sit beside: the host's
  credential store forgets every device when the process ends (#133). The
  registry that keeps them is built on `device-registry` and not merged yet
  (wave 1). No tool runs on the desktop for a phone, so there is nothing to
  record yet (#339).
- #334's code comments call #170's tool question open. The #170 rulings above
  answer it.

## Branches in progress

On 2026-09-18 and 2026-09-19 a workflow finished these four branches one at a
time, in this order. Three merged, each rebased onto the newest `main` and
checked again before its PR opened, and none of their PRs closed an issue.
`stopped-empty-reply` did not merge.

### 1. `pairing-negotiated-spki`

A pairing connection is bound to the certificate that connection negotiated
(#295 U6). #295 itself is no longer open; #332 completed it, and what it left
unbuilt is tracked in #342. Built and reviewed before the pause at `8a5fae9`,
with low findings only.

**State: merged as #336 (`f59fde2`).** The rebase onto `3e72abb` was clean.
The run also:

- corrected the three sentences on the branch that #332 made false;
- made a `negotiatedPeer` answer of `undefined`, `null`, `{}` or a bare string
  fail as `bad-negotiated-spki` and close the connection, where `undefined` and
  `null` had thrown a `TypeError`;
- made the lazy-load guard in `tests/pairing-seam.test.ts` count every static
  import form with either quote, so a side-effect import or a re-export of the
  binding half fails it;
- added `tests/pairing-desktop-socket.test.ts` (under "What is on main").

It did not wire the controller. One problem it found in #332's desktop leg, by
reading only, is under "Found in review, not yet filed".

### 2. `server-privacy-pins`

The server's "owns no user data" sentences are pinned beside the measurements
that make them true, so a paired-device registry in `apps/server` fails their
tests (#249). Built before the pause at `290ca03`. Its review found one medium
problem: the forcing test missed a registry written the way `apps/server`
already stores files.

**State: merged as #343 (`58cdaf3`).** The run reproduced the gap on `3e72abb`
with two temporary files: a registry store in the host package, and a file in
`apps/server` handing it `options.root` and `fs` the way `tunnel-identity.ts`
hands them to the key store. Typecheck and every pin stayed green. Measurement
(iii) closes that gap: with it, the same two files fail both pins, and the
failure names the hand-off. The temporary files were then removed.

### 3. `test-313-teardown-coverage`

A guard that fails if `main.ts`'s reload-gap wiring is removed (refs #313).
#330 was merged, but a full-suite mutation that deleted its `did-navigate` →
`closeReloadGap` line in `apps/desktop/src/main.ts` left every test green:
`tests/desktop-local-turns.test.ts` calls `closeReloadGap` and `forgetWindow`
directly, and no test read the wiring. New in this run; it replaced
`fix-313-reload-gap` (below).

**State: merged as #344 (`12c9ff1`).** Test-only, in
`tests/desktop-security.test.ts` (under "What is on main"). No production code
changed.

### 4. `stopped-empty-reply`

A reply stopped before its first word stays in the thread marked "Stopped" and
is never sent to the model, and tool-call markup is read and stripped so that a
stored or resent reply carries none of a call's arguments. It applies the
stopped-reply and fenced-call rulings above. Before the pause it was 28 commits,
its head was `c3d80be`, on `91df1f6`, and the review round before the pause
(round 5 in the branch's own count) found four medium problems.

**State: not merged, and no PR is open.** The branch is local and unpushed, at
`8583ced`: 57 commits on `12c9ff1`. The run reports both gates exiting 0 there.
The run:

1. rebased it onto `12c9ff1`, keeping both sides of the one conflict in
   `src/ai/engine.ts`, and passed the request's offered tool names at the call
   site #331 added, which typecheck had refused (`7c52ec2`);
2. fixed the four open findings (`80fc972`, `4c261bf`, `4077c43`, `b612f27`):
   a JSON record whose `"name"` was an offered tool's id ran; a follow-up that
   recounted its call in the app's `[tool name({…})]` form ran it again; a real
   `<tool_call>` did not run after words naming the tag; and a stopped turn did
   not cut a single-quoted, unquoted-key or array call body;
3. ran four review rounds (6 to 9 in the branch's count). Every one found
   medium problems, 7, 5, 5 and 3 of them, each reproduced by a test, and each
   round's were fixed before the next.

What is left before it merges:

- **Review round 10**, on `8583ced`. No round has reviewed round 9's three
  fixes (`390374a`, `8fcc04b`, `8583ced`). The owner's ruling is to keep
  running rounds until one finds nothing medium or higher.
- **The owner's word** on the two choices the branch made (under "Decisions
  still needed").
- **Then** a rebase onto the newest `main`, both gates, CI, and a squash merge.
  The rebased commits from `0b5675d` to `03effba` do not typecheck on their
  own: #331's call site has no offered names until `7c52ec2`. Only the tip
  passes, so bisecting inside that range stops on TS2554.

Its PR description, drafted with the branch, lists the low findings still open
and the limits it accepts.

The turn runner's next step and the provenance work wait on this branch
(wave 2).

### Not in the workflow

- `fix-313-reload-gap` (`28e71c3`): dropped, superseded by #330, which repaired
  the reload gap (refs #313) on main. The one piece worth keeping, a guard on
  main's wiring, merged as #344.
- `test-pairing-entry-load-proof`: merged as #335.
- `device-registry` (`5064f97`, two commits on `3e72abb`): the paired-device
  registry (wave 1). Finished, reviewed and green, and not merged as this is
  written; it is to be merged next. It replaces `bn7-device-registry`, which
  never got a commit.

## The build order

Each unit is built with failing tests first, reviewed adversarially, and merged
on its own. A unit waits only on the units and decisions named after it. Units
in the same wave can be built in parallel once their inputs are merged.

### Wave 1: finish what is in progress, and the unblocked substrate

- **Finish `stopped-empty-reply`** (above): review round 10 on `8583ced`, the
  owner's word on its two choices, then rebase, gates, CI and merge. Of the
  four branches the last run finished, it is the only one not merged.
- **Paired-device registry file** (#133, #135, #179). Built on
  `device-registry`, finished, reviewed and green at `5064f97`, and not merged
  as this is written; it is to be merged next, rebased onto the newest `main`
  and checked again first. `openDeviceRegistry`
  (`packages/tunnel/src/host/device-registry.ts`) keeps one owner-only file
  beside the tunnel key, sealed where the key is sealed, holding verification
  data only. The host package is shared by the desktop and the server, and
  nothing in `src/`, `apps/desktop/src` or `apps/server/src` calls it yet. It
  meets the requirements the plan set:
  - atomic replace, with rename-fault tests. A copy an unfinished write left
    behind is removed at the next open and after every change, so a revoke or
    a reset leaves no file naming the phone;
  - a Windows user-only file, refused rather than tightened;
  - on a changed pin, the file is cleared with `binding-changed`;
  - a protection mismatch is refused only when the binding matches;
  - removal and reset are explicit operations, and `watchRemovals` is the hook
    for the not-sent store (wave 3).

  Its known limits: nothing protects against an old sealed file written back
  over the current one (a rollback), and two registries opened over one file
  in one process drop each other's pairings.
- **Sleep clock.** Waits on the owner's sleep measurement (see "Owner actions").
  Until then, the recorded fallback stands: a suspend longer than the ping or
  idle budgets reloads the host.

### Wave 2: pairing and the turn runner

- **Pairing exchange** (#135, #129, #130, #136). Pair frames carry the desktop's
  accept before any credential is minted, and the phone's offered name. #336
  built the binding it runs over (`openBoundPairingConnection`); the CPace
  exchange itself is not defined yet. Waits on the registry.
- **Tunnel surface declaration** (#170). It is asserted before the listener
  binds, and it is a required option of the listener. Waits on the registry.
- **Turn runner: the desktop's fallback** (S4; #340, refs #296). #334 built the core:
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
    It has not merged; round 10 of its review is next (wave 1).
- **Provenance carries reach end to end** (S10 U1). Waits on
  `stopped-empty-reply` merging, since both change `src/state/chat.ts`.
- **Phone renders relayed prompts, waiting and refusals** (S10 U8). #334's
  desktop already sends `waiting` and the refusals, including
  `TOOL_LOOP_UNSUPPORTED`. `HOST_DOES_NOT_RUN_TURNS` reads "this server doesn't
  run phone turns yet".
- **Phone secure credential storage** (native; new from the #135 ruling). iOS
  Keychain (this device only) and Android Keystore (excluded from backups),
  reached through `credentialRef`. Compile Swift and Kotlin explicitly, under a
  timeout.

### Wave 3: policy, controllers and the first native plugin

- **Phone policy and relay hook** (S4 U2; #339). A phone turn uses the desktop's own
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
  negative-pin test (#342).

### Wave 4: assemble

- **Worker window** (S5c with S4 U4). Mostly built by #334:
  - a hidden `BrowserWindow` (`apps/desktop/src/bridge/peer-turn-window.ts`);
  - a preload over a `MessageChannelMain` port
    (`apps/desktop/src/peer-turn-preload.ts`);
  - `main.ts` passing `hostedUnitOf` and `condemnExecutor`;
  - the worker's provider connections, loaded by `initialize()`.

  What #334 does not do (#341): the hidden window loads the whole bundle, so
  `src/main.tsx` mounts `App` there. Mounting it reads every desktop chat,
  rewrites stale grants, runs the blob sweep, connects every enabled MCP server,
  and opens or creates a chat; `initialize()` connects the desktop's providers.
  Nothing resets the page between phone turns. None of this is reachable yet,
  because no listener starts. The planning pass recommended a worker-only entry
  that never mounts `App`, with per-unit resets; that is what is left of this
  unit.
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
  point. Tracked in #342.

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
  corrected "owns no user data" sentence with the registry (#249, #252). Since
  #343, a registry that `apps/server` keeps or hands `--root` to fails the
  pinned sentences, so the corrected sentence has to land in the same change.
- The desktop as a pinned tunnel client (#295 U3). #332 built and registered
  the desktop's socket leg (`apps/desktop/src/net/tunnel-socket.ts`); nothing
  uses it yet.
- Swap the OAT stand-in modules for `@johnhenry/oat-qr-fountain` 0.1.1 subpath
  imports once it is published, before the phone availability flip.
- Paired-devices panel: rename, reset key, last seen.

## Decisions still needed

Each row is a decision that belongs to the owner, with the recommendation from
the planning pass, or, for the last three rows, from the `stopped-empty-reply`
branch that raised them. Where a ruling above already answers part of a
question, only the open part is listed.

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
| A fenced call to a tool that takes no arguments, written with another key and no arguments key (`{"id": "call_0", "name": "get_datetime"}`): a call, or words? | Merging `stopped-empty-reply` | Words, as the branch has it, so that a record such as `{"name": "calculator", "version": "1.0.0"}` does not run. This reads the fenced-call ruling's "extra keys" as keys beside a name and its arguments. |
| A `[tool name({…})]` call that repeats a call from earlier in the same turn, with the same name and arguments: a recount, or a retry? | Merging `stopped-empty-reply` | A recount, as the branch has it: stripped, not run and not recorded. A retry written that way after an error then does not run; the same call written with the tool's id in place of its name still does. |
| A complete call in a local round that died before the cloud fallback finished the turn: record it as `reply-failed`? Recording it would count it as tool output when the cloud's calls are checked for taint. | Nothing; a low finding the branch leaves open | None yet. The branch strips the call from the words it now keeps and records nothing; main dropped that round's words, the call with them. |

#334 settled none of the device-connection rows. Its runner resolves no
target: it runs every phone turn on the desktop's llama.cpp adapter.

## Owner actions outside the code

- **Run the sleep probe.** `dev/probe-electron-hidden-worker/sleep-order.cjs`
  records timer ticks and `powerMonitor` suspend and resume. Sleep and wake the
  machine three times; section 5.4 of `docs/BACKGROUND-WORK-MEASUREMENTS.md`
  says how to read the result. The sleep clock waits on it.
- **Publish `@johnhenry/oat-qr-fountain` 0.1.1**, with the subpath entrypoints
  and the block-count bound.
- **Rule on `stopped-empty-reply`'s two choices** (under "Decisions still
  needed") before it merges.
- **Approve the inbound privacy sentences** in the wave 5 PR.
- **Hardware measurements before release:** the iOS Local Network prompt, and
  the tray on Linux and Windows.

## Follow-up issues

Filed during this work and not on the critical path:

- #313: a reloaded window's old page could open a whole desktop turn that held
  the shared slot. #330 fixed it, and #344 guards its wiring in `main.ts`.
- #315, #316, #317 and #318: #333 closed all four (above). An issue sweep
  checked each against `3e72abb` and left the evidence as a comment on each.
- #337: a turn that finishes while another chat is open takes that chat's last
  message as its own chat's preview. `stopped-empty-reply` lists the same
  lookup as predating it.
- #338: `tests/pairing-entry-available.test.tsx` stays green when the entry
  opens its sheet on mount without a press. This predates #335, which lists it
  under its known limits.
- #339: a phone's turn runs no desktop tool and relays no confirm, though #170
  ruled it may (wave 3).
- #340: a phone's turn never follows the desktop's cloud fallback, though #296
  ruled it may (wave 2).
- #341: the hidden worker mounts the whole app, runs its launch work, and is
  not reset between phone turns (wave 4).
- #342: the native socket plugin's iOS and Android legs have not been built or
  run (waves 3 and 4).

Found in review, not yet filed:

- In a chat with tools, a stopped turn that was writing a fenced-JSON tool call
  keeps half the call and sends it back to the model. `stopped-empty-reply` does
  not change this, and lists it among the limits it accepts: nothing tells an
  unfinished fenced call from the start of a JSON example.
- Found by reading #332's desktop leg, not run (#336 lists it under its known
  limits): `apps/desktop/src/net/tunnel-socket.ts` removes a connection from its
  map when the socket closes, so after `tunnelClose`, `send()` and `close()` on
  that handle reject with "no connection". The client's transport contract
  (`packages/tunnel/src/client/index.ts`) says a `send` after the connection has
  closed writes nothing and `close` is idempotent.
  `src/lib/tunnel-socket-transport.ts` calls both with `void`, so this could
  surface as an unhandled rejection. `openBoundPairingConnection` is not
  affected. The iOS and Android sources never remove a connection from their
  maps.

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
