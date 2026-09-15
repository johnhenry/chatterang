# probe-electron-hidden-worker: a hidden worker window in a real Electron 44

Not shipped. Measurements only. The results, and what each decides for the
WorkerHost (S5), the power clock, #313 and S7c, are in
`docs/BACKGROUND-WORK-MEASUREMENTS.md` section 5.

## Run

From the repo root:

```bash
node dev/probe-electron-hidden-worker/run.cjs --match='wac: ' --repeat=3      # window-all-closed
node dev/probe-electron-hidden-worker/run.cjs --match='port: ' --repeat=3     # MessagePortMain 'close'
node dev/probe-electron-hidden-worker/run.cjs --match='tray: '                # macOS status item bounds
node dev/probe-electron-hidden-worker/run.cjs --match='worker: ' --bridge-ref=<commit with worker-host.ts>
node dev/probe-electron-hidden-worker/run.cjs --out=/tmp/bn3.json            # everything
node_modules/.bin/electron dev/probe-electron-hidden-worker/main.cjs \
  --only='port: reload (webContents.reload)' -ApplePersistenceIgnoreState YES  # one scenario, directly
```

`run.cjs` starts one Electron per scenario (`--repeat=N` for more), gives each a
temporary root it removes afterwards, SIGKILLs one still running at `--limit`
(default 180 s), writes every report to `--out`, and exits non-zero unless every
scenario reported ok. `--probe=<main.cjs>` runs another probe's scenarios the
same way (`dev/probe-electron-reload-order` uses it).

The `worker:` scenarios run the REAL bridge code. `lib.cjs` takes
`apps/desktop/src/bridge/{worker-host,supervisor,protocol,clone,host-runtime}.ts`
from the working tree, or from `--bridge-ref=<commit>` through `git show`,
strips their types with the Node inside Electron (`module.stripTypeScriptTypes`),
and writes them under the temporary root. Main imports `worker-host` and
`supervisor` from there; the worker page loads `host-runtime` and `protocol`
from there. Their runtime imports are closed over those five files; every other
import is `import type`. Until `worker-host.ts` is on main, `--bridge-ref` is
required for the `worker:` scenarios; the others run on either.

## What each scenario does

- **`wac:`** Opens a visible window (shown with `showInactive`, not focusable,
  small, faint) and a `show: false` window, closes or destroys them in the order
  the name says, and records `window-all-closed`, `before-quit`, `will-quit` and
  `quit` with the window count at each step. The `NO listener` scenario
  registers no `window-all-closed` listener, as Electron's default quit applies.
- **`port:`** Opens a hidden worker window (sandboxed, context-isolated,
  `backgroundThrottling: false`), hands its page a `MessageChannelMain` port
  through the preload, then does what the name says. It records main's port
  `close` against `render-process-gone`, `destroyed`, `closed` and the
  navigation events, for 3 s after the trigger.
- **`worker: pacing, memory and ping round trips`** Builds the real
  `createWorkerHost` over hidden windows it spawns on demand, with a broker
  double that records `progress` and `workerLost`. It runs one unit whose frames
  the page paces with a 20 ms timer (up to 500 frames or 10 s), then 100 probe
  pings at 50 ms straight to the page's `HostRuntime`, then one unit whose frames
  main paces with 500 token messages at 20 ms while 50 probe pings at 100 ms run
  through the same port. It reads `app.getAppMetrics()` working-set sizes before
  the worker, after each unit, and the page's `document.visibilityState`. It runs
  once with `backgroundThrottling: false` and once with `true`.
- **`worker: block N s <phase>`** Builds the real WorkerHost with its default
  policy, starts a unit that holds, and arms the page to block its main thread
  (the thread the host runtime answers pings on, and a turn runner's tool loop
  runs on) for 5, 15 or 30 s at the Supervisor's next liveness ping.
  `before-pong` blocks as that ping arrives, so its pong waits for the whole
  block. `after-pong` answers the ping, then blocks, so the next ping is the
  first to wait. It records the pings and pongs, the unit's terminal, the
  Supervisor's warnings, `workerLost` calls, the kill, and whether a surviving
  worker answers the next ping.
- **`tray:`** On macOS only: a `Tray` with a 16×16 grey bitmap, its
  `getBounds()` after 1 s, and whether those bounds lie on a display.

## Loopback

The probe opens no socket. Every scenario runs `lsof` over every process
`app.getAppMetrics()` lists, once its windows are up and at the end, and fails
unless every listening TCP socket and every UDP socket is bound to 127.0.0.1.
`lib.cjs` also makes `net.Server#listen` and `dgram.Socket#bind` throw inside
main for any other address. (The privacy-copy listening inventory scans only
`apps/*/src` and `packages/*/src`, so nothing under `dev/` is counted there.)

## Item 4: the sleep ordering, run by the owner

An agent cannot run this: a suspend needs a person to wake the machine.
`sleep-order.cjs` never suspends, locks or keeps the machine awake.

1. From the repo root, in a terminal, start the recorder and leave it running:

   ```bash
   node_modules/.bin/electron dev/probe-electron-hidden-worker/sleep-order.cjs --out=/tmp/sleep-order.jsonl
   ```

   It opens no window. It prints the file it records to.
2. Put the machine to sleep yourself: Apple menu > Sleep, or close the lid.
3. Leave it asleep at least 60 seconds. Wake it. Wait at least 20 seconds.
4. Repeat steps 2 and 3 until you have done three cycles. The recorder stops by
   itself 20 s after the third wake (or press Ctrl+C) and prints its report.

Read a recording again at any time, with plain Node:

```bash
node dev/probe-electron-hidden-worker/sleep-order.cjs --report=/tmp/sleep-order.jsonl
```

The report has one row per suspend/resume cycle:

| column | meaning |
|---|---|
| suspend seen | whether `powerMonitor` delivered `suspend` before the `resume` |
| asleep (wall / hr / perf, s) | the gap between the `suspend` and `resume` records on `Date.now()`, `process.hrtime` and `performance.now()`. A small hr or perf gap beside a long wall gap means that clock does not count sleep |
| ticks between suspend and resume | 1 s interval ticks main ran after `suspend` and before `resume` (dark wakes show up here) |
| first late 1 s tick | the first tick of the 1000 ms interval (the Supervisor's `tickMs`) whose wall gap exceeds 3 s, and whether main ran it **BEFORE** or after `resume` |
| first late 50 ms tick | the same for a 50 ms interval (late means a wall gap over 500 ms) |

The last lines count the cycles where a tick ran **BEFORE** `resume`. That count
is the answer to item 4. A tick that ran before `resume` is a tick in which the
clock has already jumped and `powerMonitor` has not yet said the machine slept.
The exit code is 0 when at least three complete cycles were found, and 2
otherwise.

Please send the `.jsonl` file, or the report's table and last two lines. The file
holds clock readings, event names, the Electron version, the OS release and the
load average; nothing else.

## Gotchas found while building it

- The worker page's module scripts are served over the probe's own scheme,
  registered `standard`, `secure` and `corsEnabled` before `app` is ready. A
  registration without those was not tried.
- The worker page cannot import a name the bridge on main does not export yet
  (`PEER_TURN_PLUGIN` before BN4). The first run did, and the failed module
  import left the page silent: it never said hello. The page now falls back to
  the same names for the non-`worker:` scenarios, and `main.cjs` prints a
  worker page's console errors as `PROBE_CONSOLE`.
- The preload holds the transferred port until the page asks for it
  (`probe-want-port`). That way neither side depends on loading before the
  other.
- A `show: false` window's page reports `document.visibilityState` `visible`
  (section 5.3). Do not expect it to behave as a background tab.
- Two `Supervisor` warnings ("ended a generation that is not in flight",
  "answered call N, which is not in flight") appear at the end of a `worker:`
  run that kept its worker. They are messages that reached the host after the
  probe disposed it. A run that lost its worker logs one, "ended a generation
  that is not in flight", at the loss itself (doc section 5.3).
- The WorkerHost does not pass the `Supervisor`'s loss reason to `warn`. A block
  scenario therefore reads a loss from what happened: a kill, then a
  `HANDLE_LOST` terminal before the block finished (`lostWhileBlocked`).
- A `SIGTERM` to Electron logs "Network service crashed" and "GPU process exited
  unexpectedly". That is Chromium's teardown, not a result.
