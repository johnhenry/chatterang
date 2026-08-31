# chatterang desktop (milestone A5)

The Electron shell. **This is the first platform on which Chatterang inference
actually runs**: there are no `ios/` or `android/` directories, the native
bridges have never been compiled, and mobile runs entirely on web shims. So
this is not a port of working code — it is the reference the native bridges
will later be written against.

```
npm run desktop:sync     # build:web, copy dist -> app/, bundle main/preload/host
npm run desktop:start    # launch
npm run desktop:dev      # against the vite dev server on :5273, with HMR
```

`npm install` in this repo runs under npm's allow-scripts policy, which blocks
Electron's postinstall — so `node_modules/electron` has the types and the CLI
but no binary. Approve it (`npm approve-scripts electron`) or point
`ELECTRON_OVERRIDE_DIST_PATH` at a dist you already have. Nothing else in the
build needs a blocked script; esbuild's JS API works without its own
postinstall.

## Three processes, two boundaries

```
renderer   the existing src/ bundle, unchanged, sandboxed
    |      boundary 1 — the plugin bridge, allowlisted channels
main       PluginHost, Supervisor, the window, the app: protocol handler
    |      boundary 2 — a utilityProcess message port
host       LlamaCppNode + node-llama-cpp + the Cordis/DSH tree
```

Everything with logic in it is in `src/bridge/`, which imports **no Electron
and no Node builtin** — `tests/layering.test.ts` makes that a rule. `main.ts`,
`preload.ts` and `host/entry.ts` are adapters that turn Electron's objects into
three narrow interfaces and add nothing else. That is what lets
`tests/desktop-bridge.test.ts` drive the real bridge, the real supervisor and
the real `LlamaCppNode` across a pair of ports with genuine structured-clone
semantics, and fault-inject a host crash mid-token.

## Where this deviates from the plan, and why

**The bridge is ours; `@capawesome/capacitor-electron` is not used.** The plan
called for it. Two things pushed the other way. Its CLI hardcodes
`<repo>/electron` as the platform directory, which contradicts building under
`apps/desktop`. And its channel scheme builds method channels as
`capacitor:<plugin>:<method>` and its listener channel as
`capacitor:<plugin>:addListener` — the same string when a plugin declares a
method named `addListener`. Writing the ~600 lines here instead makes the two
namespaces disjoint by construction and, more importantly, makes the whole
boundary unit-testable. `src/` still needs **zero changes** to route to it,
because `capacitor-shim.ts` seeds the two globals the real `@capacitor/core`
reads at load, so `registerPlugin('LlamaCpp', …)` resolves here on its own.

**DSH runs in the inference process, not in main.** The task asked for main.
The gates point here and `src/host/dsh.ts` argues it at length; the short
version is that DSH itself would be fine in main — the eight installed
`@deepseek-ai/*` packages are pure JS, no koffi, no node-pty — but the `llm`
adapter it registers routes into a native addon that can abort its process. In
main that is the whole app, with no error and no terminal event conceivable. In
the utility process it is a recoverable turn failure the supervisor converts
into exactly one `llamaEnd`. `runProfile()` is never called, and could not be:
`@deepseek-ai/dsh` is not installed.

**The `generate` promise is the terminal authority; `llamaEnd` is advisory.**
The plan framed a dropped `llamaEnd` as hanging the UI. `src/ai/backends/
llama-cpp.ts` subscribes only to `llamaToken` and terminates on the `generate`
promise; nothing in `src/` consumes `llamaEnd` at all. That is also the right
thing to depend on across IPC — an invoke settles once by construction and
cannot be lost to a `removeAllListeners()` or a subscription race. The bridge
guarantees both anyway: exactly one settlement, and exactly one `llamaEnd`.

## Known limits

- `Supervisor.releaseRenderer` cancels **every** in-flight generation, not only
  the departing renderer's, because `PluginHost` does not pass the invoking
  sender down to a plugin implementation. Correct for one window; wrong the day
  a second opens.
- `DesktopLlamaBackend` resolves a model id as an absolute GGUF path. The
  renderer owns the catalogue; the host has no view of it.
- A5 mounts the DSH tree, asserts it, and exposes its status. It routes no chat
  traffic through it — the renderer's own Router already serves chat.
- Packaging is not done. `electron-builder` will need `asarUnpack` for
  `**/*.node`: `llama-addon.node` cannot be `dlopen`'d from inside an asar, and
  that will not reproduce under `electron .` — only in a packaged build.
