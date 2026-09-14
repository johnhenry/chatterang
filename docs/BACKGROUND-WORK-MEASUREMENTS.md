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
it.

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
- **NOT MEASURED:** whether a renderer that crashes, or is destroyed,
  disconnects its end of the port so that `MessagePortMain` emits `close`. That
  needs a real window and belongs to the worker host (S5).

## Not measured in this slice

These need a real Electron window, so they belong with the worker host (S5) and
the lifecycle wiring (S7):

- Stream pacing, memory use, and ping latency for a hidden window with
  `backgroundThrottling: false`, including under a blocking tool call.
- Whether `window-all-closed` fires while a hidden window exists.
