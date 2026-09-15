# probe-electron-reload-order: when a reloading window's old page can still call main (#313)

Not shipped. Measurements only. The results, and what they decide, are in
`docs/BACKGROUND-WORK-MEASUREMENTS.md` section 5.5.

## Run

From the repo root:

```bash
node dev/probe-electron-hidden-worker/run.cjs --probe=dev/probe-electron-reload-order/main.cjs \
  --out=/tmp/reload-order.json                                       # every scenario, one Electron each
node dev/probe-electron-hidden-worker/run.cjs --probe=dev/probe-electron-reload-order/main.cjs \
  --match='document held 500 ms'
node_modules/.bin/electron dev/probe-electron-reload-order/main.cjs \
  --only='reload: webContents.reload(), document held 0 ms' -ApplePersistenceIgnoreState YES
```

The runner is the hidden-worker probe's (`run.cjs`); it starts one Electron per
scenario, gives each a temporary root it removes afterwards, and exits non-zero
unless every scenario reported ok. `--reps=N` (passed to `main.cjs` directly)
changes the five navigations per scenario.

## What it does

`main.cjs` serves a page over a custom scheme with `protocol.handle`, as
`apps/desktop/src/main.ts` serves `chatterang-desktop://`, into a hidden,
sandboxed, context-isolated window with `backgroundThrottling: false` (so the
page's 1 ms interval is not throttled to once a second). The preload exposes one
`ipcRenderer.invoke`. The page (`page.js`) picks a random document id and calls
main with it once at start, on every tick of a 1 ms interval, and from
`beforeunload`, `pagehide`, `unload` and `visibilitychange`.

Each scenario navigates the window five times one way:

- `webContents.reload()`
- `location.reload()` run in the page
- `webContents.loadURL()` with the same URL
- `location.href =` another document on the same origin

with the new document's response held back by the protocol handler for 0 or
500 ms. For each navigation it records every `webContents` navigation event,
when the document request reached the handler, every invoke by document id, and
`event.senderFrame`'s `frameToken`, `processId` and `routingId` read when the
invoke arrived. It reports, per navigation and summarised:

- the event order from the trigger to `did-finish-load`;
- how long after `did-start-navigation` the old document's calls kept arriving,
  which kinds they were, and how many arrived after the new document committed
  (`did-frame-navigate` for the main frame, then `did-navigate`);
- how long after the commit the new document's first call arrived;
- whether the old and new documents' `senderFrame` identities differ, and the
  main frame's identity at `did-start-navigation` and at `did-frame-navigate`;
- whether the old document's frame was `webContents.mainFrame` at each of those
  two events;
- `arrivalMainFrameCheck`: for each invoke, whether `event.senderFrame` was
  `event.sender.mainFrame` (same `frameToken` and `processId`) when the call
  arrived, counted for the old document after `did-start-navigation`, after the
  commit, and for the new document. `wouldRefuse` is how many calls a handler
  refusing any call whose frame is not the current main frame would have
  refused.

A payload carries a document id, a sequence number, an event kind and a clock
reading. Nothing else.

## Loopback

The probe opens no socket. After the window loads and at the end, it runs `lsof`
over every process `app.getAppMetrics()` lists and fails unless every listening
TCP socket and every UDP socket is bound to 127.0.0.1 (none was, in every run).
`lib.cjs` also makes `net.Server#listen` and `dgram.Socket#bind` throw for any
other address inside main.

## Limits

- One machine, one OS (macOS), one Electron (44.0.0). Linux and Windows were not
  run.
- The window is hidden. A visible window was not run.
- The page is a few lines, served with no network. The app's Vite dev server
  (`http://localhost`) and its real bundle were not run, so a slower document
  response is modelled only by the 500 ms hold.
- An invoke is recorded when main's handler runs. Calls the old document
  started but Chromium dropped are invisible here by construction.
