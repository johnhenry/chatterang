# Next steps: the first honest paired turn

Where the device-connection work (#7 and the tracks under it) stands, what is
paused, and what comes next.

- **Written:** 2026-09-15, with `main` at `4b62928` (#328).
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

Merged between #300 and #328, grouped by what they give the goal.

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
  across lives. `main.ts` does not wire it yet.
- #328: Electron 44 probes for the hidden worker, window lifecycle and reload
  order (`docs/BACKGROUND-WORK-MEASUREMENTS.md`).
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

## Paused branches

Work was paused on 2026-09-15. Nothing below is merged. Each branch's tests
passed typecheck and the full suite at its head unless noted.

| Branch | Head | State | Before it can merge |
|---|---|---|---|
| `test-pairing-entry-load-proof` | `77139d6` | Done: built, reviewed, finished. The lazy sheet is waited on by its import and a 15 s time bound instead of 50 settle rounds. Before the change, 8 of 12 runs failed under load; after it, 12 of 12 passed. | Rebase and merge. |
| `stopped-empty-reply` | `c3d80be` | 28 commits, rebased onto `91df1f6`, fenced-call ruling applied. Round 1 of the next review found four medium problems, not yet fixed (below). | Fix those four, then keep review rounds going until one finds nothing medium or higher. Then rebase and merge. |
| `fix-313-reload-gap` | `28e71c3` | Built: a whole turn the old document opens after a reload starts is ended when the new document commits. | Adversarial review, fixes, PR text. |
| `pairing-negotiated-spki` | `8a5fae9` | Built and reviewed, with low findings only: a pairing connection is bound to the certificate that connection negotiated (#295 U6). | PR text, then merge. |
| `server-privacy-pins` | `290ca03` | Built: the server's "owns no user data" sentences are pinned beside their measurements (#249). The review found one medium problem: the forcing test misses a registry written the way `apps/server` already stores files. | Fix that, then PR text. |
| `bn7-device-registry` | none | The build was stopped before its first commit. The branch name points at `91df1f6`, with nothing on it. | Restart from the brief (the registry file, below). |

The four open findings on `stopped-empty-reply`:

1. A JSON record whose `"name"` equals an offered tool's id runs as a call and
   is stripped.
2. A follow-up that recounts its own call in the app's `[tool name({…})]` form
   runs the tool again.
3. A real `<tool_call>` does not run when words before it, in reasoning or
   prose, name `<tool_call>`.
4. A stopped turn does not cut a tag call whose body is single-quoted, has
   unquoted keys, or is an array.

## The build order

Each unit is built with failing tests first, reviewed adversarially, and merged
on its own. A unit waits only on the units and decisions named after it. Units
in the same wave can be built in parallel once their inputs are merged.

### Wave 1: finish what is paused, and the unblocked substrate

- **Merge the paused branches** above, in this order:
  1. `test-pairing-entry-load-proof`
  2. `pairing-negotiated-spki`
  3. `server-privacy-pins`
  4. `fix-313-reload-gap`
  5. `stopped-empty-reply`
- **Paired-device registry file** (#133, #135, #179). One file in the host
  package, shared by the desktop and the server, holding verification data
  only. Its requirements:
  - atomic replace with a rename-fault test;
  - a Windows user-only file;
  - on a changed pin, clear the file with `binding-changed`;
  - refuse a protection mismatch only when the pin matches;
  - removal and reset as explicit operations that the not-sent store (wave 3)
    can hook into.
- **Tunnel socket registration in `src/`** (#295 U2). Register the plugin, add
  a web shim that refuses, and adapt the plugin to the client transport.
- **Sleep clock.** Waits on the owner's sleep measurement (see "Owner actions").
  Until then, the recorded fallback stands: a suspend longer than the ping or
  idle budgets reloads the host.

### Wave 2: pairing and the turn runner

- **Pairing exchange** (#135, #129, #130, #136). Pair frames carry the desktop's
  accept before any credential is minted, and the phone's offered name. Waits on
  the registry.
- **Tunnel surface declaration** (#170). It is asserted before the listener
  binds, and it is a required option of the listener. Waits on the registry.
- **Turn runner core** (S4, #296). A decoded snapshot comes in and frames go
  out, with no chat row, through `engine.stream` only, and the tool-loop owner
  is honoured.
  - Per the cloud-reach ruling, the desktop's fallback applies. The reply's
    provenance must carry any diverted reach back to the phone.
  - Waits on `stopped-empty-reply` merging, since both change `src/ai/engine.ts`.
- **Provenance carries reach end to end** (S10 U1). Waits on
  `stopped-empty-reply`, since both change `src/state/chat.ts`.
- **Phone renders relayed prompts, waiting and refusals** (S10 U8).
  `HOST_DOES_NOT_RUN_TURNS` reads "this server doesn't run phone turns yet".
- **Phone secure credential storage** (native; new from the #135 ruling). iOS
  Keychain (this device only) and Android Keystore (excluded from backups),
  reached through `credentialRef`. Compile Swift and Kotlin explicitly, under a
  timeout.

### Wave 3: policy, controllers and the first native plugin

- **Phone policy and relay hook** (S4 U2). A phone turn uses the desktop's own
  bash, with every confirm relayed. MCP needs the desktop grant plus a relayed
  answer. Refused calls are recorded in full on both sides.
- **Desktop not-sent store** (new from the #170 ruling). Per phone, beside the
  registry, with a Clear control, and deleted with the phone or on reset.
- **Tunnel-to-broker controller** (S7b). Device attach and detach, bounded stop
  and quit, and inbound `attach` answered from held results, or with
  `RESULT_UNKNOWN`.
- **Desktop pairing host controller in main.** Showing a code mints the payload
  through `fitPairingPayload` and turns the tunnel on while the code is shown.
  One window at a time, an accept prompt with the phone's name, and a mint
  through the registry. `tests/desktop-security.test.ts` must be narrowed so
  `main.ts` can import the host's address enumeration.
- **Far-side provenance** (S10 U4). What the desktop reports only ever widens
  reach, and a desktop-side cloud divert shows as third-party.
- **Paired chip and palette** (S10 U5; #210, #213, #219).
- **Android socket plugin** (#295 U5). OkHttp with a pin-checking trust manager,
  compiled and run on an emulator that reaches the desktop at `10.0.2.2`.

### Wave 4: assemble

- **Worker window** (S5c with S4 U4):
  - a worker entry that never imports `App` or `initialize()`;
  - a worker preload over a `MessagePort`, with per-unit resets;
  - `main.ts` passing `hostedUnitOf` and `condemnExecutor`, and loading the
    worker's provider connections (cloud-reach ruling).
- **Revocation composition:** credentials, the broker and the registry, in one
  path.
- **Phone registration** (S10 U7). Tunnel backends are never fallback-eligible,
  credentials live in the keychain, and revocation removes the row and the
  router backend (#131).
- **Rail, picker and target agree on the paired arm** (S10 U6; #212).
- **Desktop "Show pairing code" sheet** and the paired-devices panel.
- **Phone attach and ack after a dropped socket** (S10 U9).
- **iOS socket plugin** (#295 U4). Compiled, run on a simulator, and measured on
  hardware for the Local Network prompt.

### Wave 5: turn it on, and the rung

- **Listener start path with the inbound privacy copy, in one change** (S7c,
  S9b; #221, #217):
  - the first desktop `createTunnelListener(` call, only on the explicit toggle,
    off at every launch;
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
- The desktop as a pinned tunnel client (#295 U3).
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
| May the phone pick one of the desktop's connected cloud models directly (not only through fallback)? | Turn runner target resolution | Not in v1. |
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

- #313: a reloaded window's old page can open a whole desktop turn that holds
  the shared slot. The `fix-313-reload-gap` branch addresses it.
- #315: a refused switch-on of a connection or MCP server is silent.
- #316: a paste reaches the disabled composer of a chat being deleted.
- #317: after two quick deletes no chat opens, and Send clears the text without
  sending.
- #318: a switch-on during a switch-off's pending write keeps a grant.

Found in review, not yet filed:

- In a chat with tools, a stopped turn that was writing a fenced-JSON tool call
  keeps half the call and sends it back to the model.
- A turn's finish sets the chat-list preview from whichever chat is open, not
  from the chat the turn ran in.
- `tests/pairing-entry-available.test.tsx` cannot catch an entry that opens its
  sheet on mount without a press. This predates the load-proof change.

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
  fixed number of rounds (#297, #299). Under load, `layout-engine`,
  `egress-grants`, `desktop-host-process` and `pairing-entry-available` have
  failed before; re-run a failure alone before calling it a defect.
- **Git hygiene.** Never `git stash` (worktrees share one stash stack). Commit
  explicit paths. Never put a closing keyword next to an issue number that
  should stay open; write "refs #N".
- **Native code** is compiled explicitly, because the repo's native checks are
  source greps.
