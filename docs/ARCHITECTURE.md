# Architecture

## The one decision everything else follows from

Every inference target — a 3B GGUF model running on the phone's GPU, Chrome's
built-in model, a language model on your laptop over Ollama, or a frontier
model in a data centre — is an aimatey `BackendAdapter`. Nothing above that
interface knows which is which, except where the difference is something the
user should see.

That is not an abstraction for its own sake. It is what makes the engine
rollout in the PRD (§4) additive:

```ts
// Phase 1
router.register('llama-cpp', new LlamaCppBackendAdapter({ resolver }));

// Phase 2 — the entire integration surface
router.register('mlc-llm', new MlcLlmBackendAdapter({ resolver }));
```

Plus one manifest field: `engine: 'mlc-llm'`. No UI code changes. No call site
changes. Phase 5's deprecation review is `router.unregister(id)` and deleting
one file.

The corresponding claim is testable, and is tested: `tests/adapter.test.ts`
exercises the llama.cpp adapter through an aimatey `Router` and asserts that
registration, execution, and removal all work without any application code
being involved.

## Layers

```
features/          screens. Know about stores. Do not know about IR.
   │
state/             zustand. Owns persistence and the generation loop.
   │
ai/engine.ts       ChatterangEngine: builds the Bridge + Router + middleware,
   │               and translates IR stream chunks into UI events.
   │
@johnhenry/aimatey Bridge → middleware stack → Router → BackendAdapter
   │
ai/backends/       adapters that wrap Capacitor plugins
   │
plugins/           Capacitor plugin definitions + web implementations
   │
native/            Swift / Kotlin
```

Each layer only knows the one below it. The clearest evidence is that
`features/` never imports anything from `@johnhenry/aimatey-types`: the IR
discriminated union stops at `ChatterangEngine`, which yields a small
UI-shaped event type instead.

## The generation path

A message travels through eight steps, and it is worth being able to name all
of them when something goes wrong:

1. **`useChats.send`** writes the user message and calls `runGeneration`.
2. **`resolveTarget`** decides which backend and model serve this turn — the
   chat's model, then the globally active one, then the first enabled remote
   connection. This mirrors what the UI shows, deliberately: a composer that is
   enabled when the engine would refuse, or vice versa, is a bug.
3. **`buildMessages`** assembles the IR messages: the model's saved system
   prompt, the persona's rendered prompt, matched lore, the last 24 turns with
   their image attachments, and any post-history instruction.
4. **`ChatterangEngine.stream`** builds the `IRChatRequest`, putting the backend id
   in `metadata.custom.backend` — which is where aimatey's Router reads its
   explicit routing decision from. Note that `RequestOptions.backend` looks
   like the right channel for this and is inert
   ([ai.matey#47](https://github.com/johnhenry/ai.matey/issues/47)).
5. **`ChatterangEngine` runs the chain itself**: device-pressure pre-flight,
   generation, then the tool loop. It does *not* rely on the Bridge's
   middleware stack — see below.
6. **The Router** selects the backend and calls `executeStream`.
7. **`LlamaCppBackendAdapter`** loads the model if needed, renders the prompt
   with the manifest's chat template, and bridges the plugin's `llamaToken`
   events into an `IRChatStream`.
8. **`runGeneration`** consumes the events, splits reasoning from answer as it
   streams, and writes the finished message with its provenance and stats.

## Where the seams are, and why

**Prompt templates are applied in TypeScript, not in the engine.**
`src/ai/prompt.ts` renders ChatML, Llama 3, Gemma, Mistral, Phi, Zephyr,
Vicuna, and Alpaca. This means the same conversation produces byte-identical
prompt text on every engine — which is what makes "retry this turn on a
different model" a fair comparison rather than a confound. It also means a new
runtime does not have to reimplement template handling to be correct.

**Tool calling is middleware, not adapter behaviour.** Small local models emit
tool calls as text far more often than as structured blocks, in at least three
different shapes. `src/ai/middleware/tools.ts` accepts all of them plus the
structured form, which is the difference between tool calling working
on-device and only working when you pay for a remote provider.

**…but the streaming path drives that middleware itself.** aimatey's
`Bridge.use()` middleware is silently skipped for streamed requests
([ai.matey#46](https://github.com/johnhenry/ai.matey/issues/46)), and every
turn in this app streams. `ChatterangEngine.stream` therefore calls
`checkDevicePressure()` and `runToolCalls()` directly rather than registering
them on the Bridge. The middleware forms are kept — `complete()` still goes
through the Bridge, and they stay the correct shape for when the upstream bug
is fixed — but the streaming path does not depend on them.

This is also the right shape regardless: a tool call cannot be executed
mid-stream, because its arguments are not complete until the turn ends. The
loop is generate → find calls → run them → generate again, bounded at four
round trips.

**Device pressure is middleware too.** `src/ai/middleware/resilience.ts` checks
thermal state and free memory before a local generation, and catches engine
failures after. When it diverts, it rewrites the request for the new backend
(the local model id means nothing to OpenAI), records the reason in response
metadata, and the thread shows a labelled notice. It never diverts unless the
user has nominated a fallback backend — sending a conversation off-device is a
consent decision, not an error-handling detail.

**The context window is budgeted before the request leaves.** `src/ai/context.ts`
estimates the prompt and trims it to fit. This is not an optimisation — it is
correctness. llama.cpp truncates from the *front*, so an unbudgeted overflow
eats the system prompt and the persona, and the model appears to change
personality mid-conversation. `fitToContext` pins every system message and the
final user question, drops history oldest-first, and keeps a tool result with
the call that produced it. What it dropped is reported, shown in the rail, and
surfaced as a toast.

Estimation rather than tokenisation, deliberately: the exact count is only
knowable from a loaded model (`countTokens`), which is async and needs the
model resident — neither is available while assembling a request. So the
estimate decides what fits, is biased pessimistic, and the rail switches to the
engine's real `promptTokens` (dropping the `~`) once a turn completes.

**The KV cache is reused across turns.** A conversation's prompt grows by
append, so re-processing the shared prefix every turn makes prefill grow
quadratically. `LlamaContext` keeps the previous prompt's tokens, finds the
longest common prefix, truncates the cache to exactly that length with
`llama_memory_seq_rm`, and decodes only the remainder. Exactness is the
correctness condition — one token too many produces subtly wrong output, which
is far worse than being slow — so a failed decode drops the cache entirely
rather than reusing something inconsistent, and prompts carrying images start
clean because the token comparison cannot see image embeddings. The saving is
reported as `cachedTokens` and shown per message.

**The model resolver is injected.** `LlamaCppBackendAdapter` takes a
`LlamaModelResolver` rather than importing the model store. The adapter stays
unit-testable, and the store wiring happens once in `state/models.ts`.

## The shell

`src/shell/` is a POSIX-ish shell over a virtual filesystem, with Chatterang's own
verbs registered alongside the bundled Unix commands. Two front doors, one
surface: a sheet in Settings, and a `bash` tool the model can call. That is
deliberate — anything the model can do, the user can reproduce by typing it.

Three properties make it safe to hand to a model:

- **It is a sandbox, not the device.** There is no real shell in a webview,
  and this does not pretend otherwise. The filesystem is a projection of the
  app's own data: a writable `/workspace`, plus read-only `/chats`, `/models`
  and `/personas`. Provider API keys are deliberately *not* projected — a model
  with filesystem access must not be one `cat` away from a credential.
- **No network.** `just-bash` ships `curl` as an opt-in command and this never
  registers it. Filesystem + model + network is an exfiltration path; without
  the third leg it is a workspace.
- **A per-action gate.** State-changing actions require confirmation when the
  model is driving, and network egress requires it from anyone. The gate is
  per *action*, not per command, because `model use` is local while `model
  install` downloads — gating at command granularity would either nag about
  harmless things or wave through egress.

`just-bash` is ~355 kB gzipped, larger than the rest of the app, so it is
dynamically imported on first use and lands in its own chunk.

A side effect worth noting: mounting conversations as Markdown gives full-text
search across every chat, which the chat list — matching only title and
preview — cannot do.

## State

Five zustand stores, each owning one table and one concern:

| Store | Owns |
| --- | --- |
| `app` | settings, device capabilities, thermal readings, provider connections, toasts, and the single `ChatterangEngine` |
| `models` | installed models, downloads, per-model samplers, storage accounting |
| `chats` | chats, messages, and the generation loop |
| `personas` | built-ins, user personas, marketplace entitlements |
| `bench` / `images` | benchmark runs and generated images |

Persistence is Dexie over IndexedDB. Model files are not in IndexedDB — they
go to app-private storage via Capacitor Filesystem on device, and to the Origin
Private File System on the web, which gives the same "sandboxed, not in the
photo roll" property.

### Import direction

`tests/layering.test.ts` enforces it, including full cycle detection over the
`@/` graph. This is not theoretical: `state/app` importing the shell tool
closed a cycle (`app → shell/tool → shell/stores → state/models → app`) that
typechecked perfectly and produced a blank page at startup, with an error
message nowhere near the import that caused it. The shell is registered from
`main.tsx` for that reason.

### One thing to know about zustand here

Selectors that derive arrays (`installedModels`, `personaList`, anything with a
`.filter`) must be wrapped in `useShallow`. zustand v5 compares with
`Object.is`, so a selector returning a fresh array every render is an infinite
loop. Every such call site in `features/` is wrapped; if you add one, wrap it.

## Design system

`src/styles/` is the only place colours, radii, and type sizes are defined.
Feature code composes classes from `components.css` rather than inventing
values, which is what keeps both themes in sync.

The palette carries information rather than decoration. **Ember** means work
happening on this device; **slate** means work leaving it. A message's chip, a
card's left rule, and the thermal strip under the rail all use that split, so a
glance tells you whether a turn left your phone. Semantic colours (good, warn,
critical) are separate from both.

The instrument rail is the app's signature element and is load-bearing: in an
app whose whole claim is "this runs on your device", the user is entitled to
watch that claim being kept — which model is resident, which compute backend it
landed on, and how fast tokens are actually arriving.

## Testing

122 tests, over the logic where a bug would be silent:

- **`domain.test.ts`** — reasoning extraction, lore selection, Character Card
  round-trips, byte formatting.
- **`prompt.test.ts`** — every chat template, including Gemma's missing system
  role and Mistral's single system fold-in.
- **`tools.test.ts`** — the expression parser (including that it refuses
  non-arithmetic input rather than silently returning a number), and all three
  textual tool-call shapes.
- **`middleware.test.ts`** — the tool loop against a mock backend, and the
  fallback path including its consent requirement and request retargeting.
- **`adapter.test.ts`** — the llama.cpp adapter end to end against the web
  plugin implementation, and through a real aimatey `Router`.
- **`engine.test.ts`** — `ChatterangEngine.stream` end to end: tools running on a
  *streamed* turn, fallback diversion, the loop bound, and abort handling.
  This file exists because the middleware unit tests passed while the wiring
  was broken; anything that must happen on a streamed turn is asserted here,
  through the real engine, rather than against a middleware function in
  isolation.
- **`privacy.test.ts`** — asserts the product's promises: that the leaderboard
  payload carries no identifier, that every cloud provider's note says data
  leaves the device, that vision models ship their projector.

The last file is the one to keep. A privacy-first app whose telemetry quietly
gains a device identifier has failed even if every other test passes.
