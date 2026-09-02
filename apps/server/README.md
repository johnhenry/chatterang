# chatterang server (milestone A9)

The headless profile: the built web bundle, self-hosted, in front of the same
inference hosts the Electron shell runs — and nothing else.

```
npm run server:build                         # build:web, desktop:build, bundle server.mjs
npm run server:start -- --root ~/.chatterang # 127.0.0.1:8973; prints a one-time URL
```

`--root` has no default. It is where the model directory, the cache and the
operator token live, and a server that guessed it would confine downloads to one
directory while the inference host opened another. `--bundle` and `--hosts`
default to `dist/` and `apps/desktop/build/host.mjs` relative to the working
directory, and the server refuses to start if either is missing.

## Four processes

```
browser    the existing src/ bundle, unchanged, in an ordinary tab
    |      http — POST /__chatterang/rpc, GET /__chatterang/events (SSE)
server     PluginHost, HostFleet, the asset routes, the auth gate
    |      one child_process.fork per engine, V8 structured clone over IPC
host llama LlamaCppNode + node-llama-cpp + the Cordis/DSH tree
host onnx  OnnxRuntimeNode + onnxruntime-node
```

`apps/desktop/src/host/entry.ts` runs unchanged in both shells. It needed one
edit for this milestone — `host-link.ts`, which accepts a Node fork's IPC
channel as well as Electron's `parentPort` — and nothing else in the host path
knew it was inside Electron.

## Where it may listen

Binding beyond loopback without authentication is not discouraged, it is
**inexpressible**: the address and the credentials are one value.

```ts
{ kind: 'loopback',      port, token }             // no host field at all
{ kind: 'authenticated', host, port, token, tls }  // both required, both branded
```

So `--host 0.0.0.0` with no certificate is a boot failure naming what is
missing, and there is no flag that turns authentication off. `AuthToken` and
`TlsMaterial` are branded with symbols `binding.ts` does not export, so neither
can be written as a literal — `tests/server-binding.test.ts` pins that with
`@ts-expect-error`, which `npm run typecheck` re-verifies on every build.

The token is 256 bits, generated on first start, written `0600` to
`<root>/server-token`, printed once, and delivered as a one-time `?token=` that
sets an `HttpOnly; SameSite=Strict` cookie (plus `Secure` on the TLS arm) and
redirects to a clean URL. **Both arms require it, on every route** — the
document, the assets, the bootstrap script, the event stream and the RPC route.

Loopback used to have no token, on the reasoning that the origin check and the
custom-header CSRF rule made it "not anonymous". Both are true and both defend
against the wrong thing: they stop a *web page* in the operator's browser, and
every one of them is enforced by the browser rather than by this process. `curl`
sends no `Origin`, sets any header it likes, and opens the event stream to be
handed a session id. Measured, on 127.0.0.1 with no token, in two requests:
`Filesystem.writeFile` answered `{"ok":true}` for arbitrary bytes inside the
data root, and `Filesystem.rmdir({path:'models',recursive:true})` answered
`{"ok":true}` for the model directory. A process the operator did not start is
not the operator. `tests/server-auth.test.ts` drives every route on both arms
over a real socket.

## What is off, and how

The reachable surface is the manifest: `LlamaCpp`, `OnnxRuntime`, `Filesystem`,
`DshHost`. `PluginHost` refuses a plugin name it does not hold before touching
any implementation, so the shell, its `bash` tool, the MCP registry, the stores,
the leaderboard upload and billing are not "disabled" — they have no row.

That list lives in `src/surface.ts`, with the nine off surfaces written down
beside it, and `startServer` runs `assertServerSurface` on the manifest before
it binds a port: a fifth plugin registered by any path is a boot failure naming
it. It moved there because the registration used to be inline in `main.ts`,
which no test can execute — so adding a fifth left the suite green.
`tests/server-surface.test.ts` drives the real registration over a real socket.

A `uri` this server hands back is the name the loader knows a model by —
`<engine>/<id>`, relative to the model root — not the server's absolute path.
The failure paths never echoed a path; the success paths did.

The server owns no user data. Chats, personas, provider connections, API keys
and egress grants live in the connecting browser's IndexedDB exactly as they do
on the web target; two browsers are two independent users who happen to share a
GPU. The one shared resource is the model directory, and every authenticated
peer can add to it and remove from it — a shared machine behaving like one.

## The served document

The bundle is served with the desktop's CSP as a response header, minus its two
font origins, and the `<link>` elements that reach Google Fonts are removed as
the HTML is served. A self-hosted privacy-first deployment that phones a third
party on cold start is the one deployment that cannot afford to. The cost is the
system font stack; self-hosting the two families removes it (see the three steps
in `apps/desktop/src/security.ts`).

The bootstrap script is injected **before** the app's module script, because
`@capacitor/core` reads its globals once, while the bundle is evaluating. Seed
them late and `registerPlugin` resolves to `src/plugins/llama-cpp/web.ts`, the
development shim that synthesises prose and reports `simulated: true` — a server
that looks like it works. `tests/server-bootstrap.test.ts` drives the real
`@capacitor/core` and asserts `simulated === false`; removing the header seeding
makes it read `true`.
