# probe-electron-csp-http — which layer refuses a plain-http model server

Run:

```bash
node_modules/.bin/electron dev/probe-electron-csp-http/main.cjs
```

The probe imports `CSP_PRODUCTION` from `apps/desktop/src/security.ts` and
`installPermissionHandlers` from `apps/desktop/src/permissions.ts`, the same way
`dev/probe-electron-permissions` does, so it measures the code that ships. The
one copied string is the policy as it was before #284, kept verbatim because
that is the "before" being measured.

It does not touch the clipboard. For the few seconds it runs, it binds an http
server to `0.0.0.0` on a random port that answers `pong`, so anyone on the same
network can reach that port while it runs.

## Why it exists

Ollama, LM Studio and the custom OpenAI-compatible endpoint all default to plain
http, and the provider adapters run in the renderer. The owner ruled on #284 to
admit the whole `http:` scheme in `connect-src`, not only loopback, so that
providers elsewhere on the network are reachable too.

The CSP is only one thing that could refuse those requests. Two others could
refuse them no matter what the policy says:

- **Mixed content.** The app scheme is registered `secure: true`, and Chromium
  blocks insecure subresources from a secure page. Loopback is exempt as
  potentially trustworthy. A LAN address is not.
- **The permission handler.** The shipped handler denies everything except
  clipboard write, so it would deny a Local Network Access request if Chromium
  raised one.

Each page is on the real `chatterang-desktop://app` scheme, registered with the
same privileges as `main.ts`, and focused. It fetches the same server at every
target under the old policy, the new `CSP_PRODUCTION`, and no CSP. The server
sends permissive CORS headers and answers preflights, so CORS is not a variable.
Each result is classified as:

- **success**: the body came back.
- **refused by CSP**: the page saw a `securitypolicyviolation` for `connect-src`.
- **refused as mixed content**: `webContents` logged a `Mixed Content` console
  message.
- **other error**: anything else.

The probe also records whether the request reached the server, and the `Origin`
the server received.

The LAN targets come from `os.networkInterfaces()`, one per non-internal IPv4
address. The table names each address by its class, not its value.

## Measured: Electron 44.0.0, Chrome 152.0.7977.54, Node 24.18.1, macOS

Shipped permission handler:

| target | old policy (`https: wss:`) | new `CSP_PRODUCTION` | no CSP |
|---|---|---|---|
| `http://127.0.0.1` | refused by CSP | success | success |
| `http://localhost` | refused by CSP | success | success |
| en0, RFC 1918 private (192.168/16) | refused by CSP | success | success |
| utun4, CGNAT (100.64/10) | refused by CSP | success | success |

No permission handler (the control for the handler) gave the same twelve
results. The shipped handler received no permission request of any kind during
any fetch. It was consulted for permission checks, and denied every one: on each
of the three pages, `media` twice and `geolocation`, `web-app-installation` and
`background-sync` once each, fifteen in all. None concerns the network, and the
no-handler session, which installs no check handler and grants every request,
gave the same verdicts. A future Chromium that adds a local-network permission
check would appear in the same `PROBE_PERMISSIONS` line, so read that line, not
only the table.

The control for the detector: the same fetches from a page whose URL is
genuinely `https:`, with no CSP. The session intercepts that host, so nothing
leaves the machine.

| target | `https:` page, no CSP |
|---|---|
| `http://127.0.0.1` | success |
| `http://localhost` | success |
| en0, RFC 1918 private | **refused as mixed content** |
| utun4, CGNAT | **refused as mixed content** |

Every successful request reached the server with
`Origin: chatterang-desktop://app`. The `https:` control's requests carried
`https://mixed-control.invalid`.

## What it decided

- **The refusal was the CSP's alone, and `http:` reaches LAN hosts too.** Under
  the new policy all four targets work, and no CSP gives the same result. The
  mixed-content block never fired on the app scheme, and the `https:` control
  shows the probe sees that block when it happens. On this Electron and Chromium
  build, a `secure: true` custom scheme does not trigger Chromium's
  mixed-content rule. So the owner's choice of all of `http:` delivers what it
  was for, without a second design such as a main-process fetch. This is a
  measurement of one Chromium version, not a documented guarantee. A Chromium
  upgrade that starts treating privileged secure schemes like `https:` would
  turn the LAN rows into mixed-content refusals, and rerunning this probe is how
  that would be noticed.
- **The served deployment's TLS arm keeps its mixed-content limit.** A page
  served over `https:` is refused plain http to non-loopback addresses whatever
  `SERVED_CSP` says. There, the widening reaches loopback providers only. That
  result comes from the Chromium control above. Firefox and Safari were not
  run.
- **The permission handler is not in the way.** No Local Network Access request
  reached it.

## What still refuses, and is not ours: Ollama's own origin check

Every request carries `Origin: chatterang-desktop://app`. Ollama's FAQ ("Web
Origins", read through Context7) says it allows cross-origin requests from
`127.0.0.1` and `0.0.0.0` by default, and that any other origin must be added to
`OLLAMA_ORIGINS`.

Measured against a local Ollama 0.34.0 (the server bundled in `Ollama.app`,
with no `OLLAMA_ORIGINS` in its process environment or in `launchctl`),
`GET /api/version` over loopback returned:

| `Origin` sent | status |
|---|---|
| `chatterang-desktop://app` | **403** (preflight for `POST /api/chat`: **403**) |
| `app://-` | 200 |
| `http://127.0.0.1` | 200 |
| `http://localhost:5273` | 200 |
| `https://evil.example` | 403 |
| none | 200 |

So a stock Ollama refuses the desktop app's origin until `OLLAMA_ORIGINS` admits
it. This README used to suggest "something like
`OLLAMA_ORIGINS=chatterang-desktop://app`". Measured, that value stops Ollama
from starting at all.

The measurement used a throwaway `ollama serve` (0.34.0, on its own loopback
`OLLAMA_HOST` port with its own empty `OLLAMA_MODELS`, so the app's server was
not touched), started once per value. In every row the preflight for
`POST /api/chat` agreed with `GET /api/version` (403 with 403, 200 with 204):

| `OLLAMA_ORIGINS` | server | `chatterang-desktop://app` | `chatterang-desktop://app-evil` | `capacitor://localhost` |
|---|---|---|---|---|
| unset | starts | 403 | not asked | 403 |
| `chatterang-desktop://app` | **panics before listening** | | | |
| `capacitor://localhost` | **panics before listening** | | | |
| `http://localhost:5273` | starts | 403 | 403 | 403 |
| `chatterang-desktop://app*` | starts | 200 | **200** | 403 |
| `chatterang-desktop://*` | starts | 200 | 200 | 403 |
| `capacitor://*` | starts | 403 | 403 | 200 |

Both panics printed:

    panic: bad origin: origins must contain '*' or include http://,https://,chrome-extension://,safari-extension://,moz-extension://,ms-browser-extension://

What the rows show:

- **An exact origin on a scheme outside that list is refused at startup.**
  `chatterang-desktop://` (desktop) and `capacitor://` (iOS) are both outside
  it. Only a value containing `*` starts. The FAQ's own example is in that form
  (`chrome-extension://*,moz-extension://*,safari-web-extension://*`).
- **`*` matches as a prefix.** `chatterang-desktop://app*` admits
  `chatterang-desktop://app-evil` too.
- **The web origins need no setting.** With it unset, `https://localhost` and
  `http://localhost:5273` got 200. The startup log's `server config` line lists
  the defaults: `http://` and `https://` for `localhost`, `127.0.0.1` and
  `0.0.0.0`, each with and without `:*`, plus `app://*`, `file://*`, `tauri://*`,
  `vscode-webview://*` and `vscode-file://*`, which is why `app://-` got 200
  above. A value set in `OLLAMA_ORIGINS` was listed ahead of those defaults, not
  in place of them.

That is the provider's CORS, not this policy, and nothing in the CSP can change
it. It is recorded here, not worked around. Which value the app's own copy
should name is the owner's call (#284). LM Studio's CORS setting was not
measured.
