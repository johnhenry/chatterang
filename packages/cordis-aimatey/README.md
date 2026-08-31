# @chatterang/cordis-aimatey

Registers aimatey's `Router` as an LLM provider inside a DeepSeek Harness (DSH)
Cordis tree, so the desktop/server target runs the same inference stack the
mobile app does.

The seam is one-way by construction: this package imports aimatey, never the
reverse, and nothing under `src/` may import this package or any
`@deepseek-ai/*` module. DSH is Node-only and pulls native addons that cannot
load in a mobile webview. `tests/layering.test.ts` enforces it.

## The three decisions a reader has to know about

### 1. It wraps `Router.executeStream`, not `Bridge.chatStream`

`Bridge.chatStream` runs `createToolMiddleware`, which **executes** tool calls
inside aimatey. DSH's `agent-loop` dispatches tools too. Wrapping the Bridge
would put two tool executors on the same stream and run every tool twice — a
correctness bug, not a plumbing preference.

The consequence, stated plainly: **on the DSH path the app's own retry
middleware and tool middleware do not run.** DSH-side behaviour is therefore not
identical to the mobile app's. What still applies is everything the Router owns:
backend selection, the fallback chain, and the circuit breaker.

The plugin also **never calls `router.dispose()`** on unmount. `src/ai/engine.ts`
holds the same `Router` instance and owns its health-check timer.

### 2. Routes are `['aimatey', ...router.listBackends()]`

`aimatey` is a sentinel route meaning *let the Router choose the backend*. Every
other route names one backend, and a named route is **pinned by construction**
(see below), not by preference.

Two consequences:

- **A backend connected after mount is not routable until the plugin remounts.**
  aimatey emits no event on `register`/`unregister`, so there is no push channel
  to follow. Polling `listBackends()` on a timer would make the staleness window
  nondeterministic rather than removing it. `AdapterRegistrationHandle.replace()`
  exists for whoever wants to drive it from a real signal.
- If a backend is literally registered under the name `aimatey`, the sentinel is
  dropped with a warning. `registerAdapter` is all-or-nothing: a duplicate route
  anywhere in the array throws `DUPLICATE_ADAPTER` and nothing registers at all.

### 3. A named route is pinned by CONSTRUCTION, and that costs something

`metadata.custom.backend` is a **preference, not a pin**.
`Router.selectBackend` honours it only while `isBackendAvailable(name)` holds
(aimatey-core `dist/esm/router.js:495`); when the named backend is unhealthy or
its breaker is open, control falls through to *"Final fallback: first available
backend"* (`router.js:537-540`) and **another backend serves the request with no
signal to the caller**. That line is on the primary selection path, so
`fallbackStrategy: 'none'` does not gate it — it only gates
`nextStreamFallbackBackend` (`router.js:1386-1388`). Reproduced under this app's
own Router config: with `openai`'s breaker open, a request pinned to `openai`
was served by `llama-cpp`.

So a named route now does two things:

1. **Refuses up front** with the adapter-minted code `ROUTE_UNAVAILABLE` when
   `getBackendInfo(name)` reports `isHealthy: false` or
   `circuitBreakerState: 'open'` — the same condition aimatey's own
   `isBackendAvailable` reads (`router.js:1651-1655`), including `!== 'open'`
   so a **half-open** (recovering) backend is not spuriously refused. This
   fails before any I/O: no API key is used and no prompt leaves the device on
   a backend the caller did not name.
2. **Streams through a per-request `router.clone(...)` pruned to that one
   backend** (`pinRouter`). Substitution is then structurally impossible — a
   one-backend Router has nothing to substitute — under *any* config the
   adapter is handed. This matters because a pre-flight check alone is blind to
   mid-stream replacement: under aimatey's default
   `fallbackStrategy: 'sequential'`, a backend that is healthy at selection time
   and dies after its `start` chunk is silently replaced, and the adapter does
   not own that setting.

**The behaviour change:** a named route that was previously being served
quietly by a substitute now fails.

**The cost, measured:** failures on the pinned path never reach the *app*
router's circuit breaker. Five failing pinned requests left the app router at
`circuitBreakerState: 'closed'`, `consecutiveFailures: 0`, `totalRequests: 0`,
where five direct ones opened it after three. There is no public API to record
a failure back onto a `Router`, so this is written down rather than
half-fixed. It is bounded on both sides: `providerRetryPolicy` is already
`maxRetries: 0`, so DSH cannot hammer a dead backend, and the pre-flight still
reads the **app** router's verdict, so the app's own traffic keeps gating the
DSH path. The clone itself is cheap (1000 clone+prune cycles ≈ 1.3 ms) and is
built per request, never cached by name — `connectProvider` calls
`Router.replace` on API-key rotation, and a name-keyed cache would keep
streaming through the pre-rotation adapter.

## Why the boot assertion exists

Cordis parks a plugin whose `inject` is unsatisfied in `PENDING`, and `await
fiber` **resolves**. A tree missing the `@deepseek-ai/dsh-llm` row boots green,
reports no failure, and simply has no model provider. Verified directly:
mounting this plugin before `LlmRuntime` gives a clean resolution with
`fiber.state === 0` and `ctx.get('llm') === undefined`.

`assertBoot(ctx, { services, routes, entries })` therefore checks three things
Cordis will not:

1. every named service is present and ACTIVE (`ctx.get(name) !== undefined` —
   strict mode already encodes ACTIVE);
2. every route you shipped is actually registered on `llm`;
3. every profile row you mounted is in `FiberState.ACTIVE`.

Layer 3 is the one the other two are structurally blind to. `llm-invariant`
provides no service and claims no provider route, so a boot in which it never
activates has every service present, every route registered, and the DSH stream
grammar simply unenforced. The reachable version of that: a row whose `inject`
is unsatisfied at mount is PARKED — `await` on its fiber resolves, so
`applyProfile` returns normally — and its `apply` runs later, when the service
arrives. A throw at *that* point has no caller left to reject, and the fiber
goes FAILED in silence. Row order is documented as carrying no load semantics,
so reordering the profile is a legal edit that can produce exactly this.

The walk was previously called impossible here, on the grounds that it needed a
loader's entry list and no loader is installed. It does not. `ctx.plugin()`
returns `Fiber & PromiseLike<Fiber>` (cordis `registry.d.ts:198`) and a fiber
knows its own state; `applyProfile` now hands those fibers back as
`MountedEntry[]` instead of awaiting them for their timing and dropping them.

`FiberState` is a `const enum` with no runtime export — importing it and reading
a member yields `undefined` — so `FIBER_ACTIVE` is a literal, and the test suite
reads the ordinals back off real fibers in known states rather than trusting the
literal to have been copied correctly.

`BootReport.notChecked` still says what was **not** checked: with no entries
supplied, that no fiber state was read at all; with entries, that the walk covers
exactly the rows it was handed and Cordis offers no enumeration of the rest.

That field used to be called `treeAssertion`, which read as the *result of* a
third layer while every value it could hold described a layer that never ran.
The layer is now real, and `notChecked` describes only the remainder.

## `@deepseek-ai/dsh-llm` is not a DeepSeek provider

It **is** the `llm` service — `LlmRuntime extends Service`, `super(ctx, 'llm')` —
an adapter registry with no provider of its own. DeepSeek's provider code lives
in `dsh-llm-deepseek` and `dsh-llm-pi-ai`, which is why the narrowed profile
drops those and keeps this. Six rows of `dsh-base` declare `inject: ['llm']`
and go dark without it: `session-title-llm`, `llm-pi-ai`, `compaction-basic`,
`session-checkpoint-policy`, `agent-loop` and `llm-deepseek`.

The class is `LlmRuntime`. There is no `LlmService` symbol; importing one fails
at runtime.

## The profile

`src/profile.ts` is the source of truth; `cordis.patch.yml` is generated from it
and checked by the test suite. **The YAML is not a boot input and nothing reads
it at runtime** — its own header says so, and a test asserts that no shipped
source file so much as names it. A DSH patch file is consumed by
`@deepseek-ai/cordis-plugin-loader`, which this repo does not install (`npm ls`
reports it empty) and which `@deepseek-ai/cordis` 4.0.2 does not provide; the
only YAML parser present is transitive (`yaml@2.9.0`, via vite and just-bash).

So the shipped tree does come from the profile — from `PROFILE_ROWS`, which
`applyProfile()` mounts row by row on a tree built with `ctx.plugin()`, and
which `apps/desktop/src/host/dsh.ts` then asserts. What it does not come from is
the YAML. Deleting that file changes no runtime behaviour; it fails exactly one
test.

Deliberately excluded, with reasons recorded in `EXCLUDED_ROWS`:
`dsh-llm-deepseek`, `dsh-llm-pi-ai`, `dsh-web-search-deepseek`,
`dsh-session-telemetry-otel` (which defaults to a DeepSeek-hosted OTLP
endpoint), and `dsh-sandbox-policy` — `dsh-sdk-minimal`'s
`mode: danger-full-access` is a worked example of the patch format, not a policy
to inherit.

`llm-invariant` is mounted **on purpose**. It is the only machine oracle for the
stream grammar, and its own `inject: ['invariants']` means Cordis parks it
PENDING and boots green if `dsh-invariants` is absent.

## Known losses

These are asymmetries between the two vocabularies, not bugs to work around.

| What | Direction | What happens |
| --- | --- | --- |
| Reasoning / thinking content | both | aimatey's IR has no reasoning channel at all. `resolveModel` returns no `reasoning` block, so a caller passing `reasoningEffort` is refused with `UNSUPPORTED_REASONING_EFFORT` before any provider I/O. Inbound `ReasoningBlock`s are dropped with a debug-level count. No `reasoning-delta` is ever emitted, and `<think>` tags are **not** synthesised into one. |
| Abort | aimatey → DSH | An aborted `Router` stream emits no terminal chunk: it breaks out of its loop, counts a success, and returns. The adapter synthesises the terminal from the signal it owns. |
| Cache-token accounting | aimatey → DSH | `IRUsage.promptTokens` is an inclusive prompt count; DSH's `inputTokens` is documented as **uncached** input. It is passed through unchanged, so for a cache-reporting provider `inputTokens` overstates uncached input. `cacheReadTokens`, `cacheWriteTokens` and `reasoningTokens` are left `undefined` — "not measured", not "measured, and zero". |
| `IRWarning` | aimatey → DSH | DSH has no warning carrier anywhere. Every warning is logged as `aimatey <category>/<severity>: <message>`. A `model-substituted` warning is emitted but **cannot** be reported through `resolveModel`, whose contract forces `id` to equal the requested string. |
| Images and other modalities | both | `resolveModel` declares `inputModalities: ['text']`, an explicit **negative** capability. DSH rewrites image blocks to placeholder text before this adapter is called. Omitting the field would mean "unknown", which disables that projection. |
| `Message.id` / `Message.source` | DSH → aimatey | Dropped. `IRMessage.metadata` would look authoritative and never be read back. |
| Backend metadata | aimatey → DSH | `tokensPerSecond`, `ttftMs`, `computeBackend`, `cachedTokens` are logged at debug level; DSH's `StreamChunk` union has no carrier. |
| `replayState` | aimatey → DSH | Never emitted. Absent is the correct representation of "this adapter has no replay fidelity". |

## `attributionHeaders()` — what this package does *not* claim

dsh-llm's `LlmAdapter` docblock requires every provider HTTP request to carry
`attributionHeaders()`. **This package does not satisfy that, and does not claim
to.** It issues no HTTP of its own; the aimatey `BackendAdapter`s do, and their
only header seam is `BackendAdapterConfig.headers` at construction time in
`src/ai/providers.ts` (spread last in `getHeaders()`, so it wins).

So: whoever **constructs** the Router for the DSH target owns merging
`attributionHeaders()` into each `BackendAdapterConfig`. Note also that
`user-agent` is settable on Node but is a forbidden header name in browser
`fetch`, so no web-target compliance claim can be made honestly either way.

Nothing in dsh-llm enforces this at runtime — `attribution.js` is a pure helper
with zero call sites in `LlmRuntime` or `lib/invariant.js`; the only callers in
the whole tree are the two shipped provider adapters. The risk is a false claim,
not a broken boot.
