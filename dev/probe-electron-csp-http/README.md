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

A second, independent run (same isolation, ports 12401-12407, `GET /api/version`
only, no preflight) repeated the unset row and both panics, then tried where the
`*` goes:

| `OLLAMA_ORIGINS` | `chatterang-desktop://app` | `chatterang-desktop://app-evil` | `evilchatterang-desktop://app` | `capacitor://localhost` | `capacitor://localhost.evil` | `xcapacitor://localhost` |
|---|---|---|---|---|---|---|
| unset | 403 | 403 | 403 | 403 | 403 | 403 |
| `chatterang-desktop://app*` | 200 | **200** | 403 | 403 | 403 | 403 |
| `*chatterang-desktop://app` | 200 | 403 | **200** | 403 | 403 | 403 |
| `*capacitor://localhost` | 403 | 403 | 403 | 200 | 403 | **200** |
| `*chatterang-desktop://app,*capacitor://localhost` | 200 | 403 | **200** | 200 | 403 | **200** |

Every value in that table started, and `https://localhost` and
`http://localhost:5273` got 200 under each.

What the rows show:

- **An exact origin on a scheme outside that list is refused at startup.**
  `chatterang-desktop://` (desktop) and `capacitor://` (iOS) are both outside
  it. Only a value containing `*` starts. The FAQ's own example is in that form
  (`chrome-extension://*,moz-extension://*,safari-web-extension://*`).
- **Where the `*` sits decides what else gets in.** A trailing `*` matches a
  prefix: `chatterang-desktop://app*` admits `chatterang-desktop://app-evil`
  too. A leading `*` matches a suffix: `*chatterang-desktop://app` refuses
  `app-evil` but admits `evilchatterang-desktop://app`, any origin ending in
  the app's own. The FAQ documents neither position, only the `scheme://*`
  example.
- **The web origins need no setting.** With it unset, `https://localhost` and
  `http://localhost:5273` got 200. The startup log's `server config` line lists
  the defaults: `http://` and `https://` for `localhost`, `127.0.0.1` and
  `0.0.0.0`, each with and without `:*`, plus `app://*`, `file://*`, `tauri://*`,
  `vscode-webview://*` and `vscode-file://*`, which is why `app://-` got 200
  above. A value set in `OLLAMA_ORIGINS` was listed ahead of those defaults, not
  in place of them.

That is the provider's CORS, not this policy, and nothing in the CSP can change
it. It is recorded here, not worked around. LM Studio's CORS setting was not
measured.

## The value the Ollama note shows (#284)

The owner ruled that the Ollama note names `OLLAMA_ORIGINS` and shows the
narrowest value that starts Ollama. The value is derived at runtime from this
app's origin, and shown only where Ollama needs one.
`ollamaOriginsSetting` (`src/ai/providers.ts`) derives it, and the panel passes
`window.location.origin` when the note renders:

- an origin Ollama already allows by default gets no value, and the note asks
  for nothing;
- an `http://` or `https://` origin outside the defaults is its own value, exactly;
- any other scheme gets the origin with `*` inserted right after the scheme's
  colon (`chatterang-desktop:*//app`, the middle form; the fourth run below
  shows why);
- anything that is not exactly a canonical serialized origin (`null`, a path, a
  comma, a `*`, a default port) gets no value, and the note says the app cannot
  tell.

On desktop the note reads:

> Ollama refuses this app until its `OLLAMA_ORIGINS` setting allows it. Add
> `chatterang-desktop:*//app` to that setting. If it already has a value, put a
> comma between them, with no spaces. Restart Ollama for the change to take
> effect.

### Third run: the values the first version printed

The function's first version gave desktop and iOS a leading `*`
(`*chatterang-desktop://app`); review replaced it with the middle form. A third
run measured each value that first version printed. It used the same isolation
as the runs above, plus its own empty `HOME`, on ports 12501-12507. Each case
was checked with `GET /api/version` and the preflight for `POST /api/chat`, and
the two agreed in every cell (200 with 204, 403 with 403). The user's own
`ollama serve` was the only Ollama process before and after.

| page origin | platform | first version printed | unset | under the printed value |
|---|---|---|---|---|
| `chatterang-desktop://app` | desktop | `*chatterang-desktop://app` | 403 | 200 |
| `capacitor://localhost` | iOS | `*capacitor://localhost` | 403 | 200 |
| `https://localhost` | Android | nothing | 200 | |
| `http://localhost:5273` | web dev | nothing | 200 | |
| `http://192.168.1.10:5273` | web, served on a LAN address | `http://192.168.1.10:5273` | 403 | 200 |
| `http://[::1]:5273` | web, served on IPv6 loopback | `http://[::1]:5273` | 403 | 200 |
| `null` | opaque | nothing (cannot tell) | 403 | |

What else each printed value lets in:

| `OLLAMA_ORIGINS` | also 200 | 403 |
|---|---|---|
| `*chatterang-desktop://app` | `xchatterang-desktop://app` | `chatterang-desktop://app-evil`, `chatterang-desktop://evil`, `capacitor://localhost`, `https://evil.example`, `http://192.168.1.10:5273` |
| `*capacitor://localhost` | `xcapacitor://localhost` | `capacitor://localhost.evil`, `chatterang-desktop://app`, `https://evil.example` |
| `http://192.168.1.10:5273` | nothing | `http://192.168.1.10:5274`, `http://192.168.1.10:52730`, `https://192.168.1.10:5273`, `http://192.168.1.10`, `http://192.168.1.100:5273`, `http://x192.168.1.10:5273`, `chatterang-desktop://app` |
| `http://[::1]:5273` | nothing | `http://[::1]:5274` |
| `http://192.168.1.10:5273,*chatterang-desktop://app` | both entries' origins, and `xchatterang-desktop://app` | the same refusals |

- Under every value, the defaults still answered 200: `https://localhost`,
  `http://localhost:5273`, `http://127.0.0.1`, `https://0.0.0.0:8443`, `app://-`,
  `tauri://localhost`, `vscode-webview://abc` and the string `file://`. Each
  `server config` line listed the value ahead of the unchanged defaults. That is
  why the note says to add the value to anything already set. The two-entry row
  shows a comma-joined value, with no space, keeps both.
- `chatterang-desktop://app`, set exactly, was run once more: it panicked with
  the same message and exited 2 without listening.
- `http://localhost.evil.example` and `https://evil.example` were 403 under
  every value.
- `*chatterang-desktop://app` also admits any origin that merely ends with the
  app's own, such as `xchatterang-desktop://app`. This run took the leading
  form for the narrowest value that starts, because only the leading and
  trailing positions had been tried. The fourth run shows it is not.
- A browser page at a `file:` URL sends `Origin: null`, whatever its
  `location.origin` says, so the function gives no value for `file://` even
  though that string matched a default.
- Where the function says no value is needed, and where the note prints one,
  was only measured for the origins above on Ollama 0.34.0. The default list is
  copied from that version's `server config` line, and its literals are in the
  bundled binary. Ollama's FAQ, read through Context7, names only `127.0.0.1`
  and `0.0.0.0`. A different Ollama version could have different defaults.

### Fourth run: the middle form, and how the value is added

Review found two things. The leading form was not the narrowest value that
starts. And "with a comma between it and anything already there" let a user
break the setting. A fourth run used the same isolation: a throwaway
`ollama serve` 0.34.0 per value, each with its own empty `HOME` and
`OLLAMA_MODELS`, on loopback ports 12701-12717. Each cell was checked with
`GET /api/version` and the preflight for `POST /api/chat`, and the two agreed in
every cell (200 with 204, 403 with 403). The user's own `ollama serve` was the
only Ollama process before and after.

| `OLLAMA_ORIGINS` | server | 200, besides the defaults | 403 |
|---|---|---|---|
| unset | starts | nothing (`vscode-file://vscode-app` is a default and got 200) | `chatterang-desktop://app`, `capacitor://localhost`, `http://192.168.1.10:5273`, `chrome-extension://abcdef`, `httpx://host` |
| `chatterang-desktop:*//app` | starts | `chatterang-desktop://app`, and the string `chatterang-desktop:x//app`, which no browser sends as an origin | `xchatterang-desktop://app`, `evil.chatterang-desktop://app`, `chatterang-desktop://app-evil`, `chatterang-desktop://evil`, `chatterang-desktop://app:1`, `chatterang-desktop://x.app`, `chatterang-desktop-x://app`, `capacitor://localhost` |
| `capacitor:*//localhost` | starts | `capacitor://localhost` | `xcapacitor://localhost`, `capacitor://localhost.evil`, `capacitor://evil`, `capacitor://localhost:1`, `capacitor://x.localhost`, `chatterang-desktop://app` |
| `*chatterang-desktop://app` (the first version's) | starts | `chatterang-desktop://app`, **`xchatterang-desktop://app`**, **`evil.chatterang-desktop://app`** | `chatterang-desktop://app-evil`, `chatterang-desktop://evil` |
| `http://192.168.1.10:5273` | starts | that origin | `http://192.168.1.10:5274` |
| `chrome-extension://abcdef` | starts | that origin | `xchrome-extension://abcdef`, `chrome-extension://abcdefg` |
| `chrome-extension:*//abcdef` | starts | that origin | the same two |
| `x-custom+scheme.v2:*//host:8080` | starts | that origin | `x-custom+scheme.v2://host:8081`, `xx-custom+scheme.v2://host:8080` |
| `httpx://host` | **panics before listening**, exit 2 | | |
| `httpx:*//host` | starts | `httpx://host` | `xhttpx://host` |

Under every value that started, the defaults still answered 200:
`http://127.0.0.1`, `https://localhost`, `http://localhost:5273`, `app://-`,
`tauri://localhost` and `vscode-file://vscode-app`.

How the value joins a setting that already has one:

| `OLLAMA_ORIGINS` | server | result |
|---|---|---|
| `http://example.test,chatterang-desktop:*//app` | starts | both origins 200 |
| `chatterang-desktop:*//app,http://192.168.1.10:5273` | starts | both origins 200 |
| `http://example.test, chatterang-desktop:*//app` (space after the comma) | starts | `http://example.test` 200, **`chatterang-desktop://app` 403** |
| `http://example.test, *chatterang-desktop://app` (space after the comma) | starts | `http://example.test` 200, **`chatterang-desktop://app` 403** |
| `*capacitor://localhost, http://192.168.1.10:5273` (space before `http://`) | **panics before listening**, exit 2 | |
| `,chatterang-desktop:*//app` (nothing before the comma) | **panics before listening**, exit 2 | |
| `chatterang-desktop:*//app,` (nothing after the comma) | **panics before listening**, exit 2 | |

Ollama splits the setting on commas and keeps the spaces. The `server config`
line printed the entry after `, ` with its leading space, and an entry that
starts with a space never matches a browser's origin. An entry starting
` http://` no longer starts with `http://`, and an empty entry has no `*`, so
both fail the startup check and Ollama panics with the message above.

What the rows show:

- **The middle form is the narrowest value that starts.** The origin has to
  start with `chatterang-desktop:` and end with `//app`. A host cannot contain
  `/`, so of the origins a browser sends only `chatterang-desktop://app`
  matches, and every look-alike measured was refused. The leading form admitted
  `xchatterang-desktop://app` and `evil.chatterang-desktop://app`, the trailing
  form admits `chatterang-desktop://app-evil`, and an exact value does not
  start. So the note shows `chatterang-desktop:*//app` on desktop and
  `capacitor:*//localhost` on iOS.
- **Extension schemes.** An exact `chrome-extension://abcdef` starts, as the
  panic message's scheme list says, and so does the middle form. Each admitted
  only that origin, so the function uses the middle form for every scheme
  outside http(s). No shipped build runs at an extension origin.
- **How the value is added.** A space after the comma silently leaves the new
  entry unmatched. A space before `http://`, or a comma with nothing on one
  side, stops Ollama from starting. So the note says to put a comma between the
  values only if the setting already has one, and to use no spaces.

Residuals:

- **Desktop.** The value admits exactly `chatterang-desktop://app`. Ollama
  cannot tell this app from another program that registers the same
  `chatterang-desktop` scheme and sends that same origin. CORS never constrains
  a client that is not a browser in the first place.
- **iOS.** `capacitor.config.ts` sets no `server.iosScheme` or
  `server.hostname`. Capacitor's documentation, read through Context7, says an
  iOS app is served from `capacitor://localhost` by default. So every Capacitor
  iOS app that keeps those defaults sends the same origin as this one.
  `capacitor:*//localhost`, like any value that admits this app there, admits
  all of them wherever they can reach the server. Only a distinct `iosScheme` or
  `hostname` would change that, and that is out of scope here.
- **Shells.** The value contains `*`. Typed unquoted as a command argument in
  zsh, macOS's default shell, it stops the command with "no matches found".
  Measured: `zsh -c 'print -r -- chatterang-desktop:*//app'` and the same with
  `*chatterang-desktop://app` both printed that and exited 1. The note does not
  mention quoting.
