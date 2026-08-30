# Chatterang

An on-device AI super app. Language, vision, speech, and image models run on
the phone; nothing leaves it unless you explicitly connect a remote provider,
and when a reply does come from one, the app says so in the thread.

Built with Capacitor. The application layer is TypeScript; inference runs
through native plugins wrapping llama.cpp and ONNX Runtime, and every engine —
local or remote — is reached through the same
[`@johnhenry/aimatey`](https://github.com/johnhenry/ai.matey) adapter contract.

```bash
npm install
npm run dev        # http://localhost:5273
npm run verify     # typecheck + tests + production build
```

The browser has no inference engine, so `npm run dev` runs a clearly-labelled
development shim. Every screen works; the replies are synthesised, and the app
says so in a banner rather than letting a preview pass for a real model.

---

## What it does

| | |
| --- | --- |
| **Chat** | GGUF models via llama.cpp with CPU → GPU → NPU fallback, per-model sampler settings, speculative decoding, message editing and regeneration, markdown with highlighted code, one-off "task" chats that keep no history |
| **Personas** | One schema spanning assistant-style "Pals" and Character Card v2 — system prompts, scenarios, opening lines, example dialogue, and keyword-triggered lore. Cards import and export losslessly |
| **Marketplace** | Free and paid personas through App Store / Play Billing, scoped to digital persona content. Every persona's full instructions are visible before purchase |
| **Voice** | Two text-to-speech strategies you pick between — the built-in OS voice (no download, instant) or a downloaded neural voice (identical on every device) — plus on-device dictation |
| **Vision** | Ask questions about photos and screenshots using a local vision model, via llama.cpp's `mtmd` projector |
| **Thinking** | Reasoning traces rendered distinctly from the answer, collapsed by default |
| **Studio** | On-device image generation in an isolated ONNX session, gated behind a device memory floor |
| **Remote** | Fourteen provider families through aimatey adapters — Ollama, LM Studio, any OpenAI-compatible endpoint, OpenAI, Anthropic, Gemini, OpenRouter, and more. Local and remote turns mix in one thread |
| **Fallback** | When the device is too hot or too low on memory, a nominated remote provider can serve that turn instead of failing — off unless you choose one, and always labelled |
| **Benchmarks** | Prompt and generation throughput, peak memory, thermal drift. Local by default; publishing a run shows the exact JSON payload first |
| **Shell** | A sandbox over the app's own data with 79 Unix tools plus Chatterang's own verbs — `model`, `chat`, `provider`, `bench`. `grep -ril "budget" /chats` searches every conversation. No network, and the model reaches the same commands through a gated `bash` tool |

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│  React + TypeScript                                          │
│  Chat · Personas · Models · Studio · Benchmarks · Settings   │
└───────────────────────────┬──────────────────────────────────┘
                            │  ChatterangEngine  (src/ai/engine.ts)
┌───────────────────────────▼──────────────────────────────────┐
│  @johnhenry/aimatey                                          │
│  Bridge → Router → middleware → BackendAdapter               │
│                                                              │
│  middleware:  resilience (device pressure) · retry · tools   │
│  backends:    llama-cpp · chrome-ai · litert-lm · <remote>   │
└───────────────────────────┬──────────────────────────────────┘
                            │  Capacitor plugin bridge
┌───────────────────────────▼──────────────────────────────────┐
│  Native (Swift / Kotlin)                                     │
│  plugin-llama-cpp          plugin-onnx-runtime               │
│  text · vision · draft     STT · TTS · diffusion             │
└──────────────────────────────────────────────────────────────┘
```

The seam that matters is `BackendAdapter`. The llama.cpp Capacitor plugin is
wrapped as one ([`src/ai/backends/llama-cpp.ts`](src/ai/backends/llama-cpp.ts)),
so the router, the middleware stack, and every UI call site treat on-device
inference exactly as they treat OpenAI. Adding MLC-LLM in Phase 2 means writing
a sibling of that one file and adding a manifest field — nothing above it
changes.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full picture, and
[native/README.md](native/README.md) for what the native layer still needs.

## Layout

```
src/
  ai/            aimatey integration — engine, adapters, middleware, tools
  plugins/       Capacitor plugin definitions + web implementations
  domain/        manifest, persona, chat schemas — the contracts
  state/         zustand stores
  features/      one directory per screen
  ui/            design system components
  styles/        design tokens, base, components
  shell/         sandboxed shell, app commands, virtual filesystem
  data/          model catalog, built-in personas, marketplace
native/          Swift and Kotlin plugin sources
docs/            architecture, model manifest, licensing
tests/           197 tests over the logic that matters
```

## Building for a device

```bash
npx cap add ios          # or: npx cap add android
npm run ios              # builds the web layer, syncs, opens Xcode
```

The native plugins are not yet compiled — see
[native/README.md](native/README.md). Until they are, a device build runs the
same development shim the browser does, and says so.

## Privacy

Three things leave the device, and only these:

1. **Model downloads** from Hugging Face, when you ask for one.
2. **Messages to a remote provider**, if you connect one. Each provider states
   plainly what connecting it means, self-hosted endpoints are grouped
   separately from cloud ones, and every remote reply is marked in the thread.
3. **Benchmark runs you publish**, if you turn that on. It is off by default,
   each run is confirmed individually, and the consent sheet shows the literal
   JSON — which contains no install id, device serial, account, or
   conversation content, and truncates the date to the day.

Conversations, personas, images, and settings are stored in IndexedDB and
app-private files. Settings offers both "delete all conversations" and "erase
everything".

## Licence

Apache-2.0. Every dependency is MIT or Apache-2.0; see
[docs/LICENSING.md](docs/LICENSING.md), which also records why the remote
provider layer is built on aimatey rather than adapted from an existing
AGPL-licensed app. Model weights carry their own licences, shown on each
model's page before download.
