# probe-electron-utility-process — what posting to a dead inference host does

Run (from the repo root):

```bash
node dev/probe-electron-utility-process/run.cjs                       # every scenario, one Electron each
node dev/probe-electron-utility-process/run.cjs --match=inside --repeat=10
node_modules/.bin/electron dev/probe-electron-utility-process/main.cjs \
  --only='kill, post same tick' -ApplePersistenceIgnoreState YES     # one scenario, directly
```

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
| V8 heap-limit fatal error, WITH an error listener | survived | never | 6670 / 429 | none (exit code 5) | nothing |
| V8 heap-limit fatal error, NO error listener (as main.ts) | survived | never | 4413 / 434 | none (exit code 5) | nothing |

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
- **The shipped code does not post there today, by ordering, not by design.**
  `#onClose` latches `#closed` and drops `#handle` before anything it calls
  could post, and `main.ts` registered no other `'exit'` listener that posts.
  So this is a native crash one listener or one reordering away, not one
  observed in the app.
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
- **A V8 heap-limit fatal error emitted no `'error'` event.** It exited with
  code 5, with and without a listener, so a missing `'error'` listener in
  `main.ts` did not surface as an uncaught exception here. The documented
  `FatalError` path itself was not reached. This probe did not measure whether
  an unlistened `'error'` would escape.

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
- **`app.on('child-process-gone')` is not a substitute for `'exit'`** for this
  purpose. The probe records it, but the supervisor's contract is the
  `UtilityProcess` `'exit'`.
