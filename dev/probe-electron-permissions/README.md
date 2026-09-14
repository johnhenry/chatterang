# probe-electron-permissions — what the desktop's permission handler actually does

Run:

```bash
node_modules/.bin/electron dev/probe-electron-permissions/main.cjs
```

The probe imports `installPermissionHandlers` straight from
`apps/desktop/src/permissions.ts`. Electron 44 embeds Node 24 with TypeScript
type stripping, so it measures the code that ships rather than a copy of its
rules. A small resolve hook maps the repo's `./x.js` import spellings to `./x.ts`.

**It writes to your system clipboard.** The copy test needs a real write. The
probe saves the clipboard's text and writes it back afterwards. Anything that is
not text (an image, rich text) is not restored, so run it with an empty or
text-only clipboard.

## Why it exists

Electron approves every permission request automatically when no handler is
installed, and until this change the desktop shell installed none. This probe
proves both halves of that sentence rather than citing them: the control session
is Electron with no handler, and the other session is the shipped policy.

Each page is loaded on the real `chatterang-desktop://app` scheme (registered
with the same privileges as `main.ts`), focused, and driven with a simulated user
gesture. One page carries the production CSP and one does not, so a CSP block is
never mistaken for a permission denial.

## Measured — Electron 44.0.0, Chrome 152, Node 24.18.1

| | shipped policy | Electron default (no handler) |
|---|---|---|
| `navigator.clipboard.writeText` | works | — |
| `navigator.clipboard.readText` | denied | **granted** |
| `Notification.requestPermission()` | denied | **granted** |
| `getUserMedia({ video: true })` | denied | not run |
| `geolocation.getCurrentPosition` | denied | not run |
| scripted `sandbox` iframe: clipboard write, camera | denied, denied | — |
| `fetch` to `http://127.0.0.1` | never reaches the handler | — |

Camera and location are not run in the control session on purpose: granting them
without a handler would raise real macOS system prompts.

## What each result decided

- **`clipboard-sanitized-write` is the one grant, and it is load-bearing.** An
  earlier run with a deny-all handler made `writeText` fail with
  `NotAllowedError`. That would have broken every copy button in the app.
- **Local Network Access cannot break a self-hosted provider.** The loopback
  `fetch` never reached the handler under any policy. It was blocked on the CSP
  page, which is the CSP's doing, not the handler's (a separate issue).
- **Permission checks can arrive with an empty origin.** `media`, `geolocation`
  and `web-app-installation` checks came with no `requestingUrl` and an empty
  `requestingOrigin`, before the page's URL existed. `permissionRequestUrl` in
  `security.ts` handles that, for the main frame only.
- **A hidden window can be focused.** Chromium refuses clipboard access to an
  unfocused document before asking any handler. `webContents.focus()` makes the
  copy test real (`hasFocus: true`).

## Gotchas found while building it

- Without a `window-all-closed` listener, Electron **quits** when the last window
  closes, on every platform. Destroying the first probe window aborted the next
  page load with `ERR_FAILED`.
- Electron 44's clipboard API is **asynchronous**: `readText()` and `writeText()`
  return promises, and `readHTML`, `readImage` and `availableFormats` are gone.
