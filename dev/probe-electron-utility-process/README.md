# probe-electron-utility-process — what posting to a dead inference host does

Run (from the repo root):

```bash
node dev/probe-electron-utility-process/run.cjs                       # every scenario, one Electron each
node dev/probe-electron-utility-process/run.cjs --match=inside --repeat=10
node dev/probe-electron-utility-process/run.cjs --match='V8 API fatal error' --repeat=10
node dev/probe-electron-utility-process/run.cjs --match='NO error listener (as main.ts on main)' \
  --bare --limit=15000                                                # Electron's own exception handler
node_modules/.bin/electron dev/probe-electron-utility-process/main.cjs \
  --only='kill, post same tick' -ApplePersistenceIgnoreState YES     # one scenario, directly
```

`--bare` installs no `uncaughtException` listener in main, so Electron's
default handler deals with anything that escapes, as it would in the app.
Without it, the probe installs one to record what escapes. `--limit=MS` sets
how long a stalled run gets before `run.cjs` samples it with macOS `sample`,
names the blocking frames it finds, and SIGKILLs it.

The FatalError scenarios compile `fatal-api.c` with the system `cc` into a
temporary directory, so they need a C compiler (Xcode's command line tools on
macOS). No binary is committed.

`main.cjs` forks `child.cjs` the way `apps/desktop/src/main.ts` forks the
inference host: `utilityProcess.fork`, the same two argv entries, a
`serviceName`, `stdio: 'pipe'`. It posts the supervisor's own envelopes
(`{ k: 'call', id, plugin, method, args }` and `{ k: 'ping', id }`) at each
point around the child's death. For every post it records whether it threw and
whether `'exit'` had been emitted yet. It also records every event the
`UtilityProcess` emitted, every `app` `'child-process-gone'`, every
`uncaughtException` and `unhandledRejection` in main, and whether main is
still running JavaScript two seconds after the last death.

`run.cjs` runs each scenario in its own Electron main. Several scenarios kill
main, and a single-process run would end at the first one.

## Why it exists

`main.ts` passed `child.postMessage(message)` straight to the supervisor, with
no error handling. A builder had found that Node's `ChildProcess.send` to a
killed child fails with EPIPE, and without a callback that becomes an
uncaught exception (#294, test harness only). Nobody had checked what
Electron's `UtilityProcess.postMessage` does in the same situation.

Electron's documentation (read through ctx7) does not say:

- `child.postMessage(message, [transfer])` — "Send a message to the child
  process". Nothing about a child that has exited.
- `'exit'` — "Emitted after the child process ends", with the exit code.
- `child.kill()` — "Terminates the process gracefully. On POSIX, it uses
  SIGTERM but will ensure the process is reaped on exit." Returns a boolean.
- `'error'` (experimental) — type `FatalError`, "Emitted when the child process
  needs to terminate due to non continuable error from V8". `'exit'` still
  follows.

## Measured — Electron 44.0.0, Chrome 152.0.7977.54, Node 24.18.1, darwin-arm64

One run of every scenario (`run.cjs`). "Posts before / after exit" counts posts
made before and after the probe's first `'exit'` listener ran.

| scenario | main process | postMessage threw | posts before / after exit | error events | escaped into main |
|---|---|---|---|---|---|
| kill, post same tick | survived | never | 2 / 1 | none | nothing |
| kill, post after microtask | survived | never | 1 / 0 | none | nothing |
| kill, post after macrotasks | survived | never | 1 / 2 | none | nothing |
| kill, exit handler that posts nothing (control) | survived | never | 0 / 0 | none | nothing |
| kill, post inside exit handler | survived (a race: see rates) | never | 0 / 1 | none | nothing |
| kill, post in a microtask queued by the exit handler | survived | never | 0 / 1 | none | nothing |
| kill, post in setImmediate queued by the exit handler | survived | never | 0 / 1 | none | nothing |
| kill, post in setTimeout 0 queued by the exit handler | survived | never | 0 / 1 | none | nothing |
| kill, kill() again inside exit handler | survived | never (kill returned false) | 0 / 0 | none | nothing |
| child exits on its own, post inside exit handler | survived | never | 1 / 1 | none | nothing |
| child crashes (abort), post inside exit handler | **killed by SIGSEGV** | (no report) | - | - | - |
| SIGKILL from outside, post inside exit handler | **killed by SIGSEGV** | (no report) | - | - | - |
| kill, post long after exit (+0, +100 ms, +1100 ms, after a second kill) | survived | never | 0 / 4 | none | nothing |
| child exits on its own (process.exit), burst across the exit | survived | never | 2 / 166 | none | nothing |
| child aborts (process.abort), burst across the exit | survived | never | 3 / 171 | none | nothing |
| child throws unhandled, burst across the exit | survived | never | 5 / 165 | none | nothing |
| SIGKILL from outside, dead before reaped, burst | survived | never | 2 / 170 | none | nothing |
| kill, 1000 posts same tick, then burst | survived | never | 1001 / 170 | none | nothing |
| kill, 20 x 5 MB posts across exit | survived | never | 2 / 23 | none | nothing |
| wedged child, kill() (the condemn path) | survived | never | 4 / 168 | none | nothing |
| V8 heap-limit out of memory, WITH an error listener | survived | never | 6670 / 429 | none (exit code 5) | nothing |
| V8 heap-limit out of memory, NO error listener | survived | never | 4413 / 434 | none (exit code 5) | nothing |

The `FatalError` scenarios have their own section below.

Every exit-handler scenario ten more times (`run.cjs --match='exit handler'
--repeat=10`), each in a fresh Electron:

| scenario (x10) | main survived | main died | how it died |
|---|---|---|---|
| kill, exit handler that posts nothing (control) | 10 | 0 | - |
| kill, post inside exit handler | 0 | 10 | killed by SIGSEGV |
| kill, post in a microtask queued by the exit handler | 10 | 0 | - |
| kill, post in setImmediate queued by the exit handler | 10 | 0 | - |
| kill, post in setTimeout 0 queued by the exit handler | 10 | 0 | - |
| kill, kill() again inside exit handler | 10 | 0 | - |
| child exits on its own, post inside exit handler | 10 | 0 | - |
| child crashes (abort), post inside exit handler | 0 | 10 | killed by SIGSEGV |
| SIGKILL from outside, post inside exit handler | 0 | 10 | killed by SIGSEGV |
| SIGKILL from outside, exit handler that posts nothing (control) | 10 | 0 | - |
| SIGKILL from outside, post in a microtask queued by the exit handler | 10 | 0 | - |
| SIGKILL from outside, post in setImmediate queued by the exit handler | 10 | 0 | - |

The recorder wraps `child.emit` to log event names, so the four "post inside
exit handler" scenarios were also run three times each with `--no-wrap`. That
uses plain listeners and no wrapper. The results were the same: SIGSEGV 3 of 3
after `kill()`, after an abort and after a SIGKILL, and survived 3 of 3 after
`process.exit`.

Counted over every run of these scenarios while the probe was being built,
including the single runs above and the `--no-wrap` runs, a post from inside
the exit handler killed main in 16 of 16 runs after an abort, 16 of 16 after
an outside SIGKILL, and 15 of 17 after `child.kill()`. The two survivors were
single runs. After `process.exit` it survived 16 of 16. The controls, whose
handlers post nothing, survived every time, so the post is what crashes main.

Every post that returned, returned `undefined`. No `uncaughtException` or
`unhandledRejection` fired in main in any scenario.

The SIGSEGV is in the main process, on `CrBrowserMain`: `EXC_BAD_ACCESS
(SIGSEGV) KERN_INVALID_ADDRESS at 0x00000000000000f8`. The faulting frame is
native code called from JavaScript, under `node::InternalMakeCallback`, which
is how the `'exit'` event reaches JavaScript. Symbol names in the release
binary's crash report are nearest-export guesses and say nothing more
specific. Three reports, from two runs, have the same address and shape.
The crash is reported upstream as electron/electron#53923.

## What each result decided

- **There is nothing for a try/catch to catch.** `postMessage` never threw:
  not in the same tick as `kill()`, not to a SIGKILLed child that had not been
  reaped, not in bursts of 1000 or of 5 MB messages, and not long after exit.
  A post that does not crash is dropped silently.
- **The one post that kills main is a post from inside the `'exit'` dispatch.**
  For a child that aborted or was SIGKILLed it did so on every run. After
  `child.kill()` it is a race. A child that called `process.exit` did not
  crash it in any run. That dispatch is exactly where `Supervisor#onClose`
  runs, because `main.ts` hands the supervisor the child's `'exit'` as its
  `onClose`.
- **The shipped code does not post there today, by accident, not by design.**
  `#onClose` latches `#closed` first, so a new call is refused. But it drops
  `#handle` last, in `#retire`, after it has delivered each turn's synthesised
  end through `notify`, synchronously. `releaseRenderer` and `#tick`'s cancel
  post through `#post`, which checks `#handle` and not `#closed`. So a
  `notify` listener that called `releaseRenderer` would post from inside the
  dispatch. None does only because `main.ts`'s `notify` sends to a renderer and
  calls nothing back, and `main.ts` registered no other `'exit'` listener that
  posts. So this is a native crash one callback or one listener away, not one
  observed in the app. `tests/desktop-utility-host.test.ts` drives that
  callback against the real `Supervisor` and shows the post it makes.
- **So the post moved into `apps/desktop/src/utility-host.ts`.** Its first
  `'exit'` listener, registered in the same turn as the fork, marks the child
  exited. Every post after that throws instead of reaching Electron.
  `Supervisor#post` already turns a throwing link into `#onClose`, which
  rejects every pending call with `HANDLE_LOST`.
  `tests/desktop-utility-host.test.ts` drives it over a fake process built from
  this table and pins `main.ts` to it.
- **A post dropped before `'exit'` is still settled.** The adapter cannot see
  a death Electron has not reported. A call posted into that gap stays pending
  until `'exit'` arrives and `#onClose` rejects it with `HANDLE_LOST`. If
  `'exit'` never came, the liveness ping would condemn the host within
  `pingIntervalMs + pingTimeoutMs`. Both paths are tested against the real
  `Supervisor`.
- **A V8 heap-limit out-of-memory emits no `'error'` event.** It exited with
  code 5, with and without a listener. That is not the `FatalError` path, as
  the next section shows. An error that does take that path emits `'error'`,
  and with no listener it escapes into main.

## A V8 fatal error: `UtilityProcess` `'error'` (`FatalError`)

### What emits it, from Electron 44.0.0's source

- The utility process installs `V8FatalErrorCallback` as V8's fatal error
  handler (`shell/services/node/node_service.cc`, `SetFatalErrorHandler`,
  overriding the handler `NodeBindings` set). The callback builds a Node
  diagnostic report, sends `OnV8FatalError(location, report)` to main, and then
  writes through a null pointer to crash the child.
- In main, `UtilityProcessWrapper::OnV8FatalError` calls
  `EmitWithoutEvent("error", "FatalError", location, report)`
  (`shell/browser/api/electron_api_utility_process.cc`).
- `ForkUtilityProcess` (`lib/browser/api/utility-process.ts`) extends Node's
  `EventEmitter`. It replaces the native handle's `emit`, special-cases
  `'exit'`, `'stdout'` and `'stderr'`, and forwards everything else, `'error'`
  included, to `this.emit(channel, ...args)`. So `'error'` is a plain
  `EventEmitter` `'error'` in main. With no listener, `EventEmitter#emit`
  throws `ERR_UNHANDLED_ERROR`, from inside a native callback.
- Electron's main-process bootstrap (`lib/browser/init.ts`) installs a default
  `uncaughtException` listener. If no one else has installed one, it shows
  `dialog.showErrorBox('A JavaScript error occurred in the main process', …)`.
  `main.ts` installs none.

A heap-limit out-of-memory does not reach that handler: Node installs its own
OOM handler, and the child exits with code 5. What does reach it is an error V8
reports through the fatal error handler, such as a failed API check.
`fatal-api.c` makes one: `v8::api_internal::ToLocalEmpty()`, the check behind
`MaybeLocal<T>::ToLocalChecked()` on an empty handle, which Electron Framework
exports. `child.cjs` loads it with `process.dlopen` when asked for
`v8ApiFatal`.

### Measured — Electron 44.0.0, Chrome 152.0.7977.54, Node 24.18.1, darwin-arm64

One run of each scenario, then ten more of each (`--repeat=10`), each in a
fresh Electron. The `--bare` rows are separate runs. "Error to exit" is the gap
between main seeing `'error'` and seeing `'exit'`.

| scenario | runs | `'error'` emitted | child exit code | error to exit | main process | escaped into main |
|---|---|---|---|---|---|---|
| WITH an error listener | 11 | 11 | 11 (SIGSEGV) | 0–1 ms | survived 11 | nothing |
| NO error listener, probe records exceptions | 11 | 11 | 11 | 0–3 ms | survived 11 | `uncaughtException` `ERR_UNHANDLED_ERROR` "Unhandled error. ('FatalError')", 11 of 11 |
| NO error listener, `--bare` (Electron's default handler, as `main.ts` on main) | 3 | - | - | - | **blocked 3 of 3** in the error box, sampled in `runModal` / `NSAlert`; its `'exit'` step had not run when the runner SIGKILLed it at 15–20 s, with the box still up | (to the error box) |
| the same, rerun during review, with the box closed while main waited | 2 | - | - | 3562 ms in one run | blocked until the box closed (in the other run sampled in `runModal` / `NSAlert` at 2.5, 6 and 12 s, its `'exit'` step logged at 17774 ms into the run); then `'exit'` was delivered and main exited 0, 2 of 2 | (to the error box) |
| WITH an error listener, `--bare` (control) | 3 | 3 | 11 | - | survived 3 | nothing |
| post inside the error listener | 11 | 11 | 11 | 1–2 ms | survived 11; the post returned `undefined` | nothing |
| `kill()` inside the error listener | 11 | 11 | 0 | 0–1 ms | survived 11; `kill()` returned `true` 11 of 11 | nothing |

The location was `v8::ToLocalChecked` every time. The report was about 117 KB
of JSON with the top-level keys `header`, `javascriptStack`, `javascriptHeap`,
`nativeStack`, `resourceUsage`, `uvthreadResourceUsage`, `libuv`, `workers`,
`environmentVariables`, `userLimits` and `sharedObjects`. The probe records
those key names and the size, never the values. A child killed from inside the
listener exited with code 0 because Electron reports a killed child's SIGTERM
as 0.

### What each result decided

- **An unlistened `'error'` does escape into main.** It is an `EventEmitter`
  `'error'`, and it threw `ERR_UNHANDLED_ERROR` into main's `uncaughtException`
  in every run. With no handler of the app's own, as in `main.ts`, Electron's
  default handler opened a modal error box, and main's JavaScript stopped
  inside it until the box was closed. In the three runs the runner killed, 15
  to 20 seconds in, `'exit'` had still not been delivered. In the two runs
  where the box was closed first, `'exit'` was delivered once it closed, and
  main went on to exit 0. So the stall lasts as long as the box stays up, and
  for that long the supervisor does not learn the host is gone and every
  pending call waits on someone closing a box. What the app does after that
  was not measured.
- **The control shows the listener is the whole difference.** The same `--bare`
  run with an `'error'` listener survived 3 of 3.
- **So `apps/desktop/src/utility-host.ts` listens for `'error'`.** It does so
  first, in the same turn as the fork, with `on` and not `once`. The listener
  marks the child exited, the same latch `'exit'` sets, so no post reaches
  Electron after it. It reports the close to every `onClose` listener at once,
  so pending calls settle as `HANDLE_LOST` without waiting for `'exit'`, and
  the `'exit'` that follows is not reported as a second loss. It reads none of
  the arguments: the report carries the child's environment variables and
  command line.
- **`kill()` stays live until `'exit'`.** `Supervisor#retire` kills the host it
  gives up on, from inside that dispatch, and `kill()` inside the `'error'`
  listener survived 11 of 11. A process that reported a fatal error and never
  exited is terminated, not left running beside its replacement.
- **The listener stays for the life of the process, `'exit'` included.** No
  run saw `'error'` after `'exit'`, but Electron 44's source does not rule it
  out: `OnV8FatalError` does not check whether the process has already
  terminated, and `ForkUtilityProcess`'s `emit` still forwards `'error'` after
  its `'exit'` branch has dropped the native handle. An `'error'` that found
  the listener gone would throw into main. The adapter's tests include that
  order.
- **A post inside the `'error'` dispatch did not crash main (11 of 11)**, unlike
  one inside `'exit'`. The adapter refuses it anyway: the child is about to
  crash, and the post could go nowhere.
- **Not shown here:** other platforms; other Electron versions; and whether
  every kind of V8 fatal error takes this path. A Node `CHECK` or
  `process.abort()` does not: the abort scenarios above emitted no `'error'`.

## Gotchas found while building it

- **After a crash, macOS blocks the next launch in an invisible alert.** Once a
  scenario had crashed Electron, the next launch of the same app
  (`com.github.Electron`) sat in `NSPersistentUIRestorer
  promptToIgnorePersistentStateWithCrashHistory` → `NSAlert runModal`, sampled
  on the stalled process. It offers to reopen windows. With the dock icon
  hidden nobody sees it, so main waits forever, and later scenarios "stalled"
  for no reason in the API. `-ApplePersistenceIgnoreState YES` skips it for
  that one launch, and `run.cjs` passes it. It applies to every Electron on the
  machine with that bundle id, including other checkouts' test runs.
- **Node writes `console.log` to a pipe asynchronously on macOS.** A process
  the runner had to SIGKILL lost its last lines, which were the ones saying
  where it stopped. `main.cjs` writes with `fs.writeSync`.
- **Every Electron without its own userData shares one directory**
  (`~/Library/Application Support/Electron`). The probe sets a temporary one.
- **A probe cannot reliably clean up after itself.** A scenario the runner
  SIGKILLs never reaches its clean-up, which left compiled `fatal-api.node`
  copies, model roots and userData directories in the temp directory. Chromium
  also writes into userData as it quits, after the clean-up has removed it, so
  clean runs left an empty userData directory. `run.cjs` makes one temporary
  root per launch, passes it as `--temp-root`, removes it once the process has
  closed, killed or not, and removes it on SIGINT or SIGTERM too. `main.cjs`
  writes everything under it. A direct `electron main.cjs` run makes its own
  root and removes it on a clean exit only.
- **`app.on('child-process-gone')` is not a substitute for `'exit'`** for this
  purpose. The probe records it, but the supervisor's contract is the
  `UtilityProcess` `'exit'`.
- **A `--bare` run whose exception escapes puts an error box on screen.** It
  is Electron's default `uncaughtException` handler, and it blocks main until
  someone closes it or the runner kills it. A release build's `sample` shows `runModal` and
  `NSAlert`, not `ShowErrorBox`, because that symbol is not exported.
- **A heap-limit out-of-memory is not a `FatalError`.** Shrinking
  `--max-old-space-size` ends the child through Node's OOM handler, with exit
  code 5 and no `'error'`. Reaching `'error'` takes an error V8 reports through
  its fatal error handler. `fatal-api.c` uses a failed API check.
