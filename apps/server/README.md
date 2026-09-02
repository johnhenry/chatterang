# chatterang server (milestone A9)

The headless profile: the built web bundle, self-hosted, in front of the same
inference hosts the Electron shell runs — and nothing else.

```
npm run server:build                         # build:web, desktop:build, bundle server.mjs
npm run server:start -- --root ~/.chatterang # 127.0.0.1:8973, no token needed
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
{ kind: 'loopback',      port }                    // no host field at all
{ kind: 'authenticated', host, port, token, tls }  // both required, both branded
```

So `--host 0.0.0.0` with no certificate is a boot failure naming what is
missing, and there is no flag that turns authentication off. `AuthToken` and
`TlsMaterial` are branded with symbols `binding.ts` does not export, so neither
can be written as a literal — `tests/server-binding.test.ts` pins that with
`@ts-expect-error`, which `npm run typecheck` re-verifies on every build.

The token is 256 bits, generated on first start, written `0600` to
`<root>/server-token`, printed once, and delivered as a one-time `?token=` that
sets an `HttpOnly; Secure; SameSite=Strict` cookie and redirects to a clean URL.

Loopback with no token is still not "anonymous": every API route requires a
session id that only the event stream hands out, and it is sent in a custom
header — which forces a CORS preflight this server never grants. That is what
stops any page in the operator's browser from driving `127.0.0.1`.

## What is off, and how

The reachable surface is the manifest: `LlamaCpp`, `OnnxRuntime`, `Filesystem`,
`DshHost`. `PluginHost` refuses a plugin name it does not hold before touching
any implementation, so the shell, its `bash` tool, the MCP registry, the stores,
the leaderboard upload and billing are not "disabled" — they have no row.
`tests/server.test.ts` asserts that list over a real socket.

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
