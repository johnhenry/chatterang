# Background work (#7): what build slice S1 measured

The #7 decision draft rests on four measurements it had not made. This note
records what was measured, how, and what stays unmeasured. Nothing described
here changes shipped behaviour.

- **Measured on:** 2026-09-14, at `802778d`, on macOS (Darwin 25.5.0).
- **Tests:** `tests/desktop-background-measurements.test.ts`, plus one block in
  `tests/layering.test.ts` ("the hidden worker’s call path, measured against the
  layers"). If one of those tests changes, the matching section below is stale.
- **Labels:** a sentence marked **INFERENCE** was read from source or docs and
  not run. A sentence marked **NOT MEASURED** says why.

## 1. The Supervisor across a sleep

`systemTimers().now` is `Date.now()` (`apps/desktop/src/bridge/supervisor.ts:437`).
That is wall-clock time, so it counts time spent suspended. The tick is an
interval, so the first tick after a wake sees the whole suspended span at once.
The tests model that tick as one clock jump, using the shipped `DEFAULT_POLICY`.

| Outstanding at suspend | Suspend length | What the Supervisor does today |
|---|---|---|
| A turn with a token just before, and a ping not yet answered | 8 h | The turn's promise rejects `HOST_TIMEOUT`. The host is then **condemned and killed** in the same tick, and a replacement is spawned. The pong it was about to send is dropped. Exactly one `llamaEnd` reaches the window, but its `error` names the host as dead ("no answer to a liveness ping in …ms"), not the turn as slow. |
| A ping not yet answered | `pingTimeoutMs − 1` (9.999 s) | Host kept; the late pong is accepted. |
| A ping not yet answered | `pingTimeoutMs` (10 s) | Host condemned. |
| A turn, with pings answered promptly | `generateIdleTimeoutMs − 1` after its last token | Turn survives. |
| A turn, with pings answered promptly | `generateIdleTimeoutMs + 1` after its last token | Turn rejects `HOST_TIMEOUT` with one `llamaEnd`; the host is kept. |

What this means:

- "Every generation ends exactly once" holds across a sleep.
- A healthy llama host is torn down, and its model has to be reloaded, on any
  wake where the suspend lasted at least 10 s and caught a ping in flight.
- Any turn is timed out by any suspend longer than 120 s after its last token.

Mutation checks:

- Removing the ping budget check in `#pingTick` fails two of these tests.
- Removing the deadline sweep in `#tick` fails the turn tests.

## 2. Monotonic clocks across a suspend

### macOS: measured

The clocks were read back to back from Python, around a child process:

- `CLOCK_UPTIME_RAW` (`mach_absolute_time`), which excludes sleep.
- `CLOCK_MONOTONIC_RAW` (`mach_continuous_time`), which includes sleep.
- `process.hrtime.bigint()`, printed by the child.

The machine had slept 4140.4 s since boot, the difference between the two
kernel clocks. The scripts are not committed; the numbers are:

| Runtime | libuv | hrtime − `CLOCK_MONOTONIC_RAW` | hrtime − `CLOCK_UPTIME_RAW` |
|---|---|---|---|
| Node 24.18.0 | 1.52.1 | 0.05 s | 4140.5 s |
| Electron 44.0.0 run as Node (Node 24.18.1) | 1.52.1 | 0.26 s | 4140.7 s |

The small residual is the child's start-up time.

**On macOS, `process.hrtime` counts time the machine spent asleep**, in plain
Node and in the Node inside Electron 44.

- `performance.now()` was not compared against the kernel clocks.
- libuv's loop time, which drives `setInterval`, was not compared either.
  **INFERENCE:** both use the same `uv_hrtime` source.

### Linux and Windows: not measured

No Linux or Windows machine was available.

What the docs say, via ctx7:

- libuv (`/libuv/libuv`): `uv_hrtime` is "relative to an arbitrary time in the
  past", "not related to the time of day and therefore not subject to clock
  drift". `uv_now` "increases monotonically".
- Node (`/nodejs/node`) repeats this for `process.hrtime`.

Neither says whether suspended time is counted, on any OS.

- **INFERENCE (Linux):** libuv reads `CLOCK_MONOTONIC`, which does not count
  suspend (`CLOCK_BOOTTIME` does).
- **UNVERIFIED (Windows):** libuv reads `QueryPerformanceCounter`. Whether that
  advances across sleep was not established.

### Consequence for S7

`Date.now()` includes suspended time on every OS. That is what the Supervisor
reads today.

The draft's second step was to inject "a clock that does not count suspended
time" through `HostFleetOptions.timers`. **No such clock is available from
JavaScript on macOS.** `hrtime` counts sleep there, as measured above.

An option that does not edit `supervisor.ts`:

- Inject a `now()` that subtracts suspended intervals, observed through
  Electron's `powerMonitor`.
- ctx7 (`/electron/electron`) confirms `suspend` ("Emitted when the system is
  suspending") and `resume` ("Emitted when system is resuming").

**NOT MEASURED:** whether a tick can run after a wake before `resume` is
delivered. If it can, the subtraction arrives one tick late and the misfire in
section 1 still happens. That ordering needs a real suspend before S7 relies on
it. BN3 wrote the probe for it, which the owner runs by hand (section 5.4).

## 3. Two concurrent `generate` calls on one loaded llama handle

### Native llama.cpp: not measured

It needs a GGUF model file.

- CI has none, and the suite does not download one. The header of
  `tests/inference-node.test.ts` gives this reason for every llama test.
- A run on a developer machine with a model would not be repeatable in CI, so
  none was made.

### Plugin layer: measured

`LlamaCppNode` was driven over an engine double that records what its one
sequence is asked to do:

- A second `generate` on a handle that is still decoding is **neither refused
  nor queued**.
- Both turns ran `evaluate` on the handle's one sequence at the same time
  (maximum 2 at once).
- The second turn's prefix alignment (`adaptStateToTokens`) ran while the first
  was mid-decode, and erased context the first had written.
  - The erasing is the double's, modelled on node-llama-cpp's `allowShift: false`
    path.
  - That the plugin makes the call mid-decode is measured.
- Each turn still got exactly one `llamaEnd`.

Mutation check: making `generate` refuse a busy handle fails the test.

### node-llama-cpp 3.20.0: read, not run (INFERENCE)

- `LlamaContextSequence._evaluate` acquires the sequence's `evaluate` lock for
  one decode step and releases it before yielding the token
  (`dist/evaluator/LlamaContext/LlamaContext.js:1499-1501`, `:1554`).
- `adaptStateToTokens` erases token ranges through `_eraseContextTokenRanges`
  (`:943-953`). That takes the context's `context` lock (`:1000`), not the
  sequence's `evaluate` lock, and removes KV cells directly.
- So a second turn's alignment can run between two decode steps of the first,
  on the same KV sequence. Two turns on one handle are not two queued turns.

### Consequence

- Nothing between the bridge and the native sequence serialises turns.
- `MAX_CONCURRENT_TURNS = 1` has to be enforced above the Supervisor, for the
  desktop user's own turns as well as a phone's (ruling 3).
- The broker's slot stays held until a turn's work has actually returned, not
  merely until its terminal is decided.

## 4. The worker's call path

This asks whether an unchanged `Supervisor` can supervise a hidden worker window
that runs a phone's turn (ruling 1), and which layers the call path crosses.

### Static result, in `tests/layering.test.ts`

The host envelope's runtime (`bridge/host-runtime.ts`) reaches only:

- `bridge/clone.ts`
- `bridge/protocol.ts`
- the package `@chatterang/contracts`

It passes the bridge guard (no Electron, no Node builtin) and `DESKTOP_LAYER_BAN`.

`src/` may not import `@chatterang/desktop` at all (the shell-app guard in the
same file). A turn runner written in `src/` therefore cannot construct a
`HostRuntime`. The preload is the desktop-layer file that already carries bridge
code into a renderer: it imports `./bridge/capacitor-shim.js`,
`./bridge/renderer.js` and `electron`, and nothing else. Nothing in `src/` names
the runtime today.

### Dynamic result, in `tests/desktop-background-measurements.test.ts`

An unchanged `Supervisor` and a `HostRuntime` were connected over a real
`MessageChannel`, using Node's ports:

- A turn runs end to end, with its one `llamaEnd`.
- Closing the worker's end mid-turn is seen as loss through the port's own
  `close` event: one synthesised `llamaEnd`, and `HANDLE_LOST`.
- Mutation check: making the Supervisor ignore the link's close fails that test.

### Electron, via ctx7 (`/electron/electron`)

- A `MessagePortMain` reaches a renderer only through `webContents.postMessage`
  or `frame.postMessage`. It arrives as a DOM `MessagePort` on `event.ports` in
  `ipcRenderer.on`. `send` and `invoke` cannot transfer ports.
- `MessagePortMain` emits `close` "when the remote end ... becomes disconnected".
- The preload's IPC adapter has no `postMessage` or ports path today
  (`apps/desktop/src/preload.ts:33-41`). Adding one is new preload surface.

### What follows

- **Host envelope over a `MessagePort`:** an unchanged `Supervisor` can serve it.
  The runtime would live in the preload bundle, with the `src/` turn runner
  reached from there.
- **Invoke-pull, where the worker pulls work and reports by invoke:** a
  `Supervisor` cannot serve it. A `HostHandle` is `{ link: MessageLink, kill }`
  (`bridge/protocol.ts`), and a pull path has no link. The broker carries its
  own settle discipline for that case.
- Whether a renderer that crashes, or is destroyed, disconnects its end of the
  port so that `MessagePortMain` emits `close` was not measured in S1. BN3
  measured it in a real window: it does, in every case run (section 5.2).

## Not measured in S1

S1 left these because they need a real Electron window. BN3 measured both, in
section 5:

- Stream pacing, memory use, and ping latency for a hidden window with
  `backgroundThrottling: false`, including under a blocking tool call (5.3).
- Whether `window-all-closed` fires while a hidden window exists (5.1).

## 5. A hidden worker in a real Electron 44 (BN3)

Build unit BN3 ran real Electron probes for the behaviour the worker host (S5),
the power clock, the #313 fix and S7c rest on. Nothing under `apps/*/src` or
`src/` changed.

- **Measured on:** 2026-09-14, 23:01 to 23:12 PDT (smoke runs from 22:54), at
  `0a9ee3f`, with the probes committed in this change. The `worker:` scenarios ran the WorkerHost as
  it stands on the `bn4-worker-host` branch at `a41e1ce`, not yet on main.
- **Machine:** macOS 26.5.2 (Darwin 25.5.0), Mac16,1, arm64, 10 cores, 32 GB.
- **Electron:** 44.0.0 (Chrome 152.0.7977.54, Node 24.18.1), as pinned in
  `apps/desktop/package.json`.
- **Load:** the machine was shared with other work. Each run records its load
  average, and the 1-minute figure is given with each result below.
- **Probes:** `dev/probe-electron-hidden-worker/` (items 1, 2, 3, 4, 6) and
  `dev/probe-electron-reload-order/` (item 5). Each has a README saying how to
  run it. `run.cjs` runs one Electron per scenario and exits non-zero on any
  failed step.
- **Loopback:** the probes open no socket. Every scenario checked, with `lsof`
  over every Electron process, that no socket was bound to anything but
  127.0.0.1. No socket was bound at all in any check.
- **Windows:** every probe window is hidden. The one visible window
  (section 5.1) is shown with `showInactive`, cannot take focus, and belongs to
  an app with the `accessory` activation policy.
- **Labels:** as in sections 1 to 4, **INFERENCE** marks what was read and not
  run, and **NOT MEASURED** says why.

### 5.1 `window-all-closed` with a hidden window

Each scenario ran 3 times, each in its own Electron, with 1-minute load 6.3 to
8.1. A visible window was shown inactive, beside a `show: false` window.

| Scenario | `window-all-closed` |
|---|---|
| Visible window closed while the hidden one exists | **not emitted** (3 of 3); one window left |
| ...then the hidden one `destroy()`ed | emitted at once (3 of 3) |
| ...or the hidden one `close()`d instead | emitted at once (3 of 3) |
| Visible window `destroy()`ed, then the hidden one `destroy()`ed | not emitted at the first, emitted at the second (3 of 3) |
| Only a hidden window, `destroy()`ed | emitted (3 of 3) |
| Last visible window closed (emitted), then a hidden window built and destroyed | emitted a **second** time when the hidden one went (3 of 3) |
| No `window-all-closed` listener: visible window closed while the hidden one exists | the app kept running (3 of 3) |
| ...then the hidden one destroyed | `before-quit`, `will-quit`, `quit`: **the app quit, on macOS** (3 of 3) |

So `window-all-closed` means "Electron's window list is empty", and a hidden
window is in that list. Electron's docs say "Emitted when all windows have been
closed" (`electron.d.ts`), with no word on visibility.

**NOT MEASURED:** Linux and Windows; no such machine was reachable.
**INFERENCE:** the same, because the event follows the window list and its docs
name no platform.

Consequences:

- **S7c.** `window-all-closed` cannot mean "the person closed their last window"
  once a worker can exist.
  - While a worker lives, closing the last visible window emits nothing.
  - The event comes later, when the worker is retired (`WORKER_IDLE_MS`, two
    minutes, `worker-host.ts:92` at `a41e1ce`) or lost.
  - A worker built after the last window closed brings a second event when it
    goes.
  - S7c has to count visible, non-worker windows itself, on each window's
    `closed`.
- **main.ts today** (`apps/desktop/src/main.ts:752-754`) quits on non-darwin
  inside `window-all-closed`. The plan records that this contradicts #7 ruling 6.
  With a worker, and assuming Linux and Windows behave as macOS did:
  - the app would stay open after the person closed their last window;
  - it would then quit up to two minutes later, on the worker's idle retire;
  - a phone turn served while no window is open would quit the app when its
    worker was retired or lost.
- **The listener must stay.** With none registered, Electron quit when the
  hidden window was destroyed, on macOS too. Removing the listener is not a way
  to keep the app alive for a phone.
- **WorkerHost (S5).** A worker's retire or kill is also an app-lifecycle event.
  S5 must not ship before S7c decides what an empty window list does, or it
  inherits the quit above on Linux and Windows.
- **Power clock, #313:** none.

### 5.2 `MessagePortMain` `close` when the worker's renderer goes

A hidden, sandboxed, context-isolated window with `backgroundThrottling: false`
held its end of a `MessageChannelMain` in the page. Each trigger ran 3 times,
each in its own Electron, with 1-minute load 4.8 to 8.0. Times are milliseconds
after the trigger call returned, the median of 3. The three runs agree within
±1 ms, except the first `reload()`, whose events all came 1.4 to 2.8 ms later.

| Trigger | Main's port `close` | Order |
|---|---|---|
| `webContents.forcefullyCrashRenderer()` | 3 of 3, 0.3 ms | port `close` 0.3, then `render-process-gone` (`killed`) 4.9 |
| `SIGKILL` to the renderer process | 3 of 3, 0.3 ms | port `close` 0.3, then `render-process-gone` (`killed`) 4.5 |
| `win.destroy()` | 3 of 3, 5.9 ms | window `closed` 0.2, `webContents` `destroyed` 4.2, port `close` 5.9 |
| `win.close()` | 3 of 3, 5.4 ms | `destroyed` 1.0, window `closed` 1.2, port `close` 5.4 |
| `webContents.reload()` | 3 of 3, 2.5 ms | `did-start-navigation` 0.9, port `close` 2.5, `did-navigate` 3.3, `dom-ready`, `did-finish-load` |
| `loadURL` of another page, same origin | 3 of 3, 2.5 ms | `did-start-navigation` 0.8, port `close` 2.5, `did-navigate` 3.3 |
| `win.destroy()` while the page is in a 4 s busy loop | 3 of 3 | `closed`, `destroyed` 1.8 later, port `close` 3.7 after `closed` |
| `forcefullyCrashRenderer()` while the page is in a 4 s busy loop | 3 of 3 | port `close` at once, `render-process-gone` 4.5 to 5.6 later |
| The page closes its own port (control) | 3 of 3, 0.2 ms | port `close` only |

In every run, a `postMessage` to main's port 3 s after its `close` returned
without throwing. Each run had exactly one renderer process (`Tab`).

Consequences:

- **WorkerHost (S5).**
  - The port's `close` is a loss signal for every way a worker's renderer went
    that was run: crash, kill, destroy, close, reload, navigation, and a
    renderer blocked in a loop. So the `Supervisor`'s close path (`HANDLE_LOST`)
    fires for each, without the ping.
  - On a crash or a kill, `close` came about 4.5 ms before
    `render-process-gone`. A `render-process-gone` hook on the worker window
    would add no earlier signal.
  - On `destroy()`, the path a condemn takes, `close` comes about 2 ms after
    `destroyed`, including while the page is blocked. A kill that waits for
    `close` waits milliseconds, not a ping budget.
  - **A worker window that reloads or navigates loses its port.** It closed
    between `did-start-navigation` and `did-navigate`, and the new document gets
    no port. S5 has to treat any worker navigation as the end of that life.
    Nothing today stops a reload. `main.ts`'s navigation lock is
    `will-navigate`, which `webContents.reload()` does not emit, and which
    passes a same-origin `location.reload()` (section 5.5).
  - A dead worker is never found through a throwing post. `postMessage` to a
    closed `MessagePortMain` did not throw, so `Supervisor#post`'s "a port that
    throws is gone" path is not how a worker's loss is seen.
- **#313.** On a reload, the old document's port closed about 1.7 ms after
  `did-start-navigation` and before the new document committed. That fits
  section 5.5.
- **Power clock, S7c:** none.

### 5.3 The hidden worker: pacing, memory, ping round trips, and blocks

**The rig: real code on both sides of the port.** Nothing in the path is a
copy of the bridge code.

- Main runs `createWorkerHost` from `worker-host.ts` at `a41e1ce`, with its
  default policy. Each worker life gets the real `Supervisor`.
- A double broker records `progress` and `workerLost`.
- `spawnWorker` builds a hidden, sandboxed, context-isolated window and a
  `MessageChannelMain`. It returns the window's real `webContents.id`, and a
  kill that calls `win.destroy()`.
- The page runs the real `HostRuntime` in its main world, from the same commit
  with types stripped, answering pings on the page's thread.
- A double turn runner serves `PEER_TURN_PLUGIN`, like the test's `FakeWorker`.

#### Pacing, memory and ping round trips

One run per setting. 1-minute load was 5.9 to 6.1 with `backgroundThrottling:
false`, and 6.1 to 4.4 with `true`. Figures are p50 / p95 / max.

| | `backgroundThrottling: false` | `backgroundThrottling: true` |
|---|---|---|
| Page's `document.visibilityState` / `hidden` | `visible` / false | `visible` / false |
| Frames paced by the page's `setTimeout(20)`, for 10 s | 459 | 457 |
| ...interval between arrivals in main, ms | 22.0 / 22.1 / 22.6 | 22.1 / 22.3 / 22.6 |
| Frames paced by main, one per token message at 20 ms | 500 of 500 | 500 of 500 |
| ...token posted to frame back in main, ms | 0.06 / 0.14 / 0.33 | 0.29 / 0.59 / 1.38 |
| ...interval between arrivals in main, ms | 21.8 / 22.2 / 22.9 | 22.1 / 22.5 / 23.3 |
| Ping to the page's `HostRuntime`, idle (100 at 50 ms), ms | 0.07 / 0.14 / 0.16 | 0.38 / 0.55 / 0.61 |
| ...while relaying 50 tokens a second (50 at 100 ms), ms | 0.05 / 0.08 / 0.13 | 0.23 / 0.40 / 0.61 |
| Pings unanswered | 0 | 0 |

Working set from `app.getAppMetrics()`, with `backgroundThrottling: false`. The
`true` run was within 0.5 MB of each figure.

| | Worker renderer (`Tab`) | Browser (main) | GPU | Every Electron process |
|---|---|---|---|---|
| Before any worker | - | 156.4 MB | - | 156.4 MB (Browser only) |
| Worker live, after the timer unit | 90.8 MB | 188.6 MB | 68.1 MB | 395.3 MB (Browser, GPU, Utility, Tab) |
| After the relayed unit | 93.1 MB | 189.8 MB | 68.2 MB | 398.8 MB |

What these show:

- **A never-shown window is not a background page.**
  - The `show: false` page reported itself `visible`.
  - With `backgroundThrottling: true`, its 20 ms timers ran exactly as with
    `false`.
  - The installed `electron.d.ts` explains why. `paintWhenInitiallyHidden`,
    which defaults to `true`, is "Whether the renderer should be active when
    `show` is `false`". It adds: "In order for `document.visibilityState` to
    work correctly on first load with `show: false` you should set this to
    `false`". The probe left the default.
  - The intervals were 22 ms, not 20, in both settings, under a load near 6.
  - The token-to-frame and ping medians were a few tenths of a millisecond
    higher in the `true` run. With one run each, that is not separable from
    load.
- **Ping round trips are not the limit.** The `HostRuntime` answered on the
  page's thread in 0.61 ms or less, idle or relaying, against the `Supervisor`'s
  10 s `pingTimeoutMs`. Only a blocked thread gets near the budget.
- **The first worker is expensive when it is the first window.** It brought up a
  GPU process and a network `Utility` process with it, about 240 MB in all.
- **Two `Supervisor` warnings closed every run that ended by the probe's own
  `dispose`:** "ended a generation that is not in flight" and "answered call
  N, which is not in flight". In the block runs that kept the worker, they came
  1.5 to 9.5 ms after that dispose killed it. Warnings on a loss are in the
  blocks table below.

**NOT MEASURED:**

- a window shown and then hidden with `hide()`;
- `paintWhenInitiallyHidden: false`;
- runs longer than 10 s;
- the app's real page. This probe page is a few kilobytes, so the app's worker
  renderer will be larger by an unmeasured amount;
- the marginal cost of a worker when a visible window already has the GPU and
  utility processes running. **INFERENCE:** close to the renderer plus the
  browser's growth, about 125 MB here.

Consequences:

- **WorkerHost (S5).**
  - Pacing and ping latency need nothing from S5 for a window that is never
    shown. `backgroundThrottling: false` changed nothing measurable here, and
    costs nothing.
  - If S5 ever shows and hides a worker, throttling is unmeasured.
  - A worker is about 90 MB of renderer for a trivial page. Built and retired
    on demand (`WORKER_IDLE_MS`), that is the cost the two-minute idle retire
    buys back.
- **Power clock, #313, S7c:** none.

#### Blocks of the worker page's thread against the ping budget

Each block ran twice, each in its own Electron, with 1-minute load 1.7 to 4.4.

**The setup.**

- The WorkerHost ran its default policy: `tickMs` 1000, `pingIntervalMs`
  15000, `pingTimeoutMs` 10000, and `PEER_TURN_IDLE_TIMEOUT_MS` infinite. The
  probe read these back from the loaded modules.
- One unit was running and holding.
- The page was armed to block its main thread in a busy loop at the
  `Supervisor`'s next ping. That thread runs the `HostRuntime` and would run a
  turn's tool loop.
- **"As a ping arrives"** blocks before answering, so the pong waits out the
  block. **"After a pong"** answers first, so the next ping is the first to
  wait.
- The first ping of each worker life went out 15.0 s after the spawn (15005 to
  15012 ms).

Times are milliseconds from the block's start. Where two runs differ, both are
given.

| Block | Starts | Outcome, both runs | Pings | Worker killed | Unit's terminal | `broker.workerLost` |
|---|---|---|---|---|---|---|
| 5 s | as a ping arrives | **kept** | pong at 4999.6 / 4999.8, when the block ended; next ping answered in 0.6 ms | - | the worker's own end | - |
| 5 s | after a pong | **kept** | next ping at 15013 / 15010, answered in 0.2 to 0.6 ms | - | the worker's own end | - |
| 15 s | as a ping arrives | **lost at 10 s** | never answered | 10008.9 / 10006.5 | `HANDLE_LOST`, 1.5 to 1.6 ms after the kill | once, `worker`, with the terminal |
| 15 s | after a pong | **kept** | next ping at 15012 / 15015, after the block ended at 15000 / 14998, answered in under 1 ms | - | the worker's own end | - |
| 30 s | as a ping arrives | **lost at 10 s** | never answered | 10004.9 / 10008.3 | `HANDLE_LOST`, 1.5 to 1.6 ms after the kill | once |
| 30 s | after a pong | **lost at 25 s** | next ping at 15011 / 15009, never answered | 25015.5 / 25016.4 | `HANDLE_LOST`, 1.6 to 1.8 ms after the kill | once |

**On every loss (6 of 6):**

- The kill (`win.destroy()`) came first.
- The unit's terminal came about 1.5 ms later.
- The port's `close` came 2.9 to 3.9 ms after the kill.
- `workerLost('worker')` was called exactly once.
- The WorkerHost logged one `Supervisor` warning, "inference host ended a
  generation that is not in flight", 1.5 to 1.8 ms after the kill. It passed on
  no reason naming the ping.
- **INFERENCE:** the warning is the `Supervisor`'s own synthesised end for the
  start call, arriving after the WorkerHost had settled the unit. `worker-host.ts`
  disposes the `Supervisor` "After the terminal, so the end the Supervisor
  synthesises reaches nothing". The warning text is `supervisor.ts`'s.

**What this measures.** With the shipped policy, an unbroken block of a worker
page's thread is ended at 10 s (`pingTimeoutMs`) when a ping is already in
flight as it starts. When it starts just after a pong, it is ended at 25 s
(`pingIntervalMs + pingTimeoutMs`). 5 s was kept in both phases, and 15 s only
in the second.

**INFERENCE, from `supervisor.ts:1197-1211`:**

- the ping goes out at the first 1 s tick at least 15 s after the last pong;
- the loss is declared at the first tick at least 10 s after the ping;
- so each bound can stretch by up to one tick.

A block shorter than 10 s is never ended by the ping.

Consequences:

- **WorkerHost (S5).**
  - **The "25 s ping budget" is the best case, not the budget.**
    - A block that starts while a ping is in flight is killed at 10 s.
    - Nothing in the worker controls the phase.
    - So a turn runner must not hold the worker page's thread for 10 s or more.
  - Such a hold ends the running unit (`HANDLE_LOST` through `workerLost`, so
    `WORKER_LOST` to the broker). The worker is rebuilt on the next unit, and
    one loss counts against the restart budget.
  - Work that can take that long (a large synchronous parse, a synchronous WASM
    call, a tokenizer) has to yield or move off that thread. **INFERENCE:** an
    awaited IPC call to main, such as a tool, does not block the thread.
  - The loss path otherwise worked as `worker-host.ts` describes. The unit ended
    at the kill, not at the port's later `close`, and `workerLost` was said once.
  - The one warning per loss is log noise that names no cause. BN4 may want the
    loss reason in it.
- **Power clock.** These are the same thresholds a suspend's clock jump meets
  (section 1): 10 s if a ping is in flight, otherwise 15 s plus 10 s.
  **INFERENCE:** a worker kept across a sleep of more than 10 s with a ping in
  flight is killed on the first tick after the wake, unless the clock subtracts
  the sleep before that tick (5.4).
- **#313, S7c:** none.

### 5.4 A timer tick against `powerMonitor` `resume`, across a real suspend

**NOT MEASURED — OWNER RUN NEEDED.**

An agent cannot run this unattended. A suspend needs a person to wake the
machine, three times. BN3 was not permitted to suspend the machine, and did not.

`dev/probe-electron-hidden-worker/sleep-order.cjs` is the probe, for the owner
to run by hand.

- It never suspends, locks or keeps the machine awake.
- It logs a 1000 ms `setInterval` (the `Supervisor`'s `tickMs`), a 50 ms
  `setInterval`, and `powerMonitor` `suspend`, `resume`, `lock-screen`,
  `unlock-screen` and `shutdown`.
- Each record carries `Date.now()`, `process.hrtime` and `performance.now()`,
  read back to back.
- Lines are written in the order main ran the callbacks, which is the question.

**To run.** From the repo root:

```bash
node_modules/.bin/electron dev/probe-electron-hidden-worker/sleep-order.cjs --out=/tmp/sleep-order.jsonl
```

1. Leave it running. It opens no window.
2. Sleep the machine (Apple menu > Sleep, or close the lid), for at least 60 s.
3. Wake it, and wait at least 20 s.
4. Do steps 2 and 3 three times.

It stops 20 s after the third wake, or on Ctrl+C, and prints its report. To read
a recording again:

```bash
node dev/probe-electron-hidden-worker/sleep-order.cjs --report=/tmp/sleep-order.jsonl
```

**To read.** There is one row per cycle.

- **First late 1 s tick:** the first tick after `suspend` whose wall gap exceeds
  3 s, and whether it ran **BEFORE** or after `resume`.
- **Asleep:** the `suspend`-to-`resume` gap on each of the three clocks. A clock
  whose gap is much shorter than the wall gap does not count sleep.
- **Ticks between suspend and resume:** ticks main ran while suspended, such as
  dark wakes.
- **The last two lines:** "a 1 s tick ran before 'resume' in N of M". That count
  is the result.

The exit code is 0 only when three complete cycles were recorded. The dev/
README has the full column list.

What was checked without a suspend: the report, over a hand-built three-cycle
recording (it classified each cycle as built), and the recorder, started and
stopped by `SIGTERM` (it wrote its records and reported 0 cycles, exit 2). That
shows the script works. It is not the result.

Consequences, by outcome:

- **Power clock (wave 1).**
  - **If any cycle shows a tick before `resume`:** a clock that subtracts
    suspended time when `powerMonitor` reports it is a tick late on that wake.
    The tick sees the whole jump first, and section 1's misfire happens anyway.
    The clock would then have to treat a tick whose wall gap is far past
    `tickMs` as a suspend by itself.
  - **If none does:** subtracting on `resume` was on time for those wakes. Three
    cycles cannot show it never fails.
  - **Until the owner runs it:** the wave-1 sleep clock waits on this result, or
    ships the fallback the plan records (critic correction for BN3).
  - The same recording shows whether `performance.now()` counts sleep on macOS.
    Section 2 measured that only for `process.hrtime`.
- **WorkerHost (S5).**
  - **INFERENCE, from `worker-host.ts` at `a41e1ce`:** each worker life's
    `Supervisor` runs on `systemTimers()` (`Date.now()`, `worker-host.ts:273`).
    Nothing retires a worker on `suspend`.
  - #323 ends the running unit `HOST_SUSPENDED`. A worker kept across a sleep
    with a ping in flight is still condemned on wake (section 1). That costs a
    rebuilt worker, not a turn, and counts one loss against the restart budget
    (`maxRestarts` 5 in 60 s).
  - Whether the tick or `resume` comes first decides whether a suspend hook in
    S5 could retire the worker before that tick.
- **#313, S7c:** none.

### 5.5 The main-frame navigation order, and the old document's last call (#313)

`dev/probe-electron-reload-order/` loads a page into a hidden window with
`backgroundThrottling: false`, served by `protocol.handle` as the app serves
`chatterang-desktop://`. The page calls `ipcRenderer.invoke` with its own
document id:

- once at start;
- on a 1 ms interval;
- from `beforeunload`, `pagehide`, `unload` and `visibilitychange`.

Each trigger ran five navigations, with the new document's response held back 0
or 500 ms, in its own Electron, with 1-minute load 5.3 to 7.5.

Event names were checked first against Electron's docs: ctx7 `/electron/electron`
and the installed `electron.d.ts`.

- `did-start-navigation`: "Emitted when any frame (including main) starts
  navigating".
- `did-frame-navigate`: "Emitted when any frame navigation is done".
- `did-navigate`: "Emitted when a main frame navigation is done".

Neither doc says "commit". So the probe measured commit directly: the main
frame's `frameToken` changed at `did-frame-navigate`.

**Order, 40 of 40:**

- `webContents.reload()` and `webContents.loadURL()` of the same URL:
  `did-start-loading` > `did-start-navigation` > `did-frame-navigate` >
  `did-navigate` > `dom-ready` > `did-frame-finish-load` > `did-finish-load`.
- `location.reload()` and `location.href =` run in the page: the same, with
  `will-frame-navigate` > `will-navigate` between `did-start-navigation` and
  `did-frame-navigate`.

A main-initiated `reload()` or `loadURL()` emitted no `will-navigate`.
`did-navigate` followed `did-frame-navigate` within 0.1 ms. The document request
reached the protocol handler 0.3 to 2.6 ms after `did-start-navigation`.

Milliseconds are median (range) over five navigations. "dsn" is
`did-start-navigation`; "commit" is `did-frame-navigate` for the main frame.

| Trigger | Hold | Commit after dsn | Old doc's last call after dsn | Old doc's calls after dsn | Old doc's calls after commit | Old doc's last call before commit | New doc's first call after commit |
|---|---|---|---|---|---|---|---|
| `webContents.reload()` | 0 | 2.1 (1.9–2.3) | 1.3 (1.2–1.4) | 4 (3–4) | **0** | 0.8 (0.7–0.9) | 1.1 (1.1–1.4) |
| `webContents.reload()` | 500 | 503.4 (502.4–504.5) | 502.5 (501.6–502.8) | 129 (129–130) | **0** | 0.9 (0.8–1.9) | 1.1 (1.0–1.2) |
| `location.reload()` | 0 | 2.6 (2.3–8.3) | 1.8 (1.6–5.4) | 4 (4–5) | **0** | 0.8 (0.7–3.0) | 1.2 (0.9–4.0) |
| `location.reload()` | 500 | 506.8 (505.7–510.5) | 505.4 (504.5–507.5) | 130 (130–131) | **0** | 1.4 (1.1–3.3) | 2.1 (1.4–4.2) |
| `loadURL`, same URL | 0 | 6.3 (4.0–6.9) | 3.7 (2.8–4.5) | 4 (4–5) | **0** | 2.4 (0.9–2.5) | 3.5 (1.1–3.8) |
| `loadURL`, same URL | 500 | 508.8 (507.5–509.7) | 505.7 (504.9–506.6) | 130 (130–130) | **0** | 2.9 (2.7–3.4) | 3.7 (3.2–4.2) |
| `location.href =` another doc | 0 | 7.4 (2.8–9.2) | 4.8 (2.0–6.6) | 5 (4–5) | **0** | 2.6 (0.8–3.3) | 3.1 (1.1–3.8) |
| `location.href =` another doc | 500 | 508.4 (504.7–510.8) | 505.3 (503.8–507.8) | 130 (130–131) | **0** | 2.2 (0.9–3.1) | 2.2 (1.1–3.6) |

**What the old document sent, 40 of 40:**

- Its `beforeunload` call arrived before `did-start-navigation`.
- After `did-start-navigation` came interval calls, then `pagehide`,
  `visibilitychange:hidden` and `unload`.
- Its last call was always `unload`.

**`event.senderFrame`, read when each call arrived, 40 of 40:**

- It was never null for an old document's call.
- Its `frameToken` and `routingId` differed between the old and the new
  document, in the same renderer process.
- `webContents.mainFrame` changed identity at `did-frame-navigate`.

**NOT MEASURED:**

- a visible window;
- the app's own page and Vite dev server;
- a navigation that changes renderer process;
- Linux and Windows.

A call Chromium dropped rather than delivered cannot be seen by this probe. Every
old document here sent calls until its `unload`.

Consequences:

- **#313, the gap: measured.** The old document keeps running, and keeps
  reaching `ipcMain.handle`, from `did-start-navigation` until just before the
  new document commits. That is where `main.ts:717-721` tears a window's turns
  down today.
  - Its calls stop 0.7 to 3.4 ms before the commit.
  - The gap is as long as the new document's response takes: about 2 to 9 ms
    here with no hold, and 500 ms of calls, 129 to 131 of them, with a 500 ms
    hold.
  - A first decode of a brand-new turn sent in that gap is admitted after the
    teardown, as the issue says.
  - The old document's `pagehide` and `unload` handlers also run inside the
    gap.
- **#313, direction 1 (a second teardown when the new document commits):**
  sound on this evidence.
  - No old-document call arrived after `did-frame-navigate` in 40 of 40, across
    all four triggers and both holds.
  - The new document's first call came 0.9 ms or more after it.
  - A teardown on the main frame's `did-frame-navigate`, or on `did-navigate`
    0.1 ms later, falls between the two.
- **#313, direction 2 (a per-document id):** main already has one without the
  renderer's help.
  - `event.senderFrame.frameToken` (with `processId`) differed between old and
    new documents in 40 of 40, and the main frame's token changed at commit.
  - A handler can refuse a call whose `senderFrame` is not the current
    `webContents.mainFrame`.
  - **INFERENCE:** that holds when Chromium gives every cross-document
    navigation a new frame host, as it did here within one process. A
    process-changing navigation was not run.
- **S7c:** none.
- **Aside, for `main.ts`'s navigation lock (no unit).** `will-navigate` does not
  fire for a main-initiated `reload()` or `loadURL()`, so the lock does not see
  them. That is harmless for same-origin reloads.
- **WorkerHost (S5).** A worker window's navigation closes its port (5.2). This
  order says when: before `did-navigate`.
- **Power clock:** none.

### 5.6 Tray icon visibility

**macOS, measured once (1-minute load 6.0).**

- A `Tray` with a 16×16 grey bitmap had `getBounds()` `{ x: 1326, y: 0, width:
  18, height: 39 }` after 1 s.
- That lies on the one display (1800×1169, internal), inside the 39-pixel row
  above its work area: the menu bar.
- Nobody looked at the screen. On-screen bounds are not proof a person can see
  the icon, and a crowded menu bar or a notch hiding status items was not
  examined.

**Linux (GNOME, KDE) and Windows: NOT MEASURED.** No Linux desktop session and
no Windows machine was reachable. Docker and OrbStack are installed, but neither
gives a desktop with a tray host, and neither was tried.

Consequences:

- **S7c.** Only macOS is measured, and only to "the item gets bounds in the menu
  bar". On Linux and Windows, S7c cannot rest on the tray as the only way back to
  an app whose last window is closed until someone checks there.
- **WorkerHost, power clock, #313:** none.
