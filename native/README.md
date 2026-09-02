# Native plugin layer

Two Capacitor plugins back the Phase 1 engine set (PRD §4, §5):

| Plugin | Engine | Serves |
| --- | --- | --- |
| `plugin-llama-cpp` | llama.cpp | Text chat, vision (`mtmd`), speculative decoding, tool calling, benchmarking |
| `plugin-onnx-runtime` | ONNX Runtime | Speech-to-text, neural text-to-speech, image generation |

They are deliberately separate. Diffusion's memory profile must not be able to
evict or fragment the language model's allocations, and keeping them in
different plugins — with different sessions and different lifecycles — is what
makes that enforceable rather than aspirational (PRD §6).

## Status

The TypeScript definitions, the web implementations, and the aimatey backend
adapters in `src/` are complete and covered by tests. The Swift and Kotlin
sources here are the bridge layer: argument decoding, threading, event
emission, error mapping, and the engine wrapper.

| | compiled? | runs? |
| --- | --- | --- |
| `plugin-llama-cpp` iOS | **yes** — simulator, `arm64_x86_64` | **all ten methods**, CPU only |
| `plugin-llama-cpp` Android | no | no |
| `plugin-onnx-runtime` iOS | no | no |
| `plugin-onnx-runtime` Android | no | no |

**iOS llama.cpp is the only leg that has ever been built.** It compiles against
a pinned llama.cpp (see "Vendoring" below), links, embeds a 16 MB
`llama.framework` into `App.app`, and runs a real 12B model on the iPhone 17
Pro simulator (iOS 26.5).

Reproduce with:

```sh
./native/plugin-llama-cpp/tools/prove-ios.sh /abs/path/to/model.gguf
```

That builds the web app, appends `tools/prove-ios.js` to the built `dist/`
(gitignored, so it never reaches a normal build), syncs, installs, launches
with the console attached, and exits non-zero unless every step passed and
every `generate` emitted exactly one `llamaEnd`.

Measured against `gemma-4-12B-it-QAT-Q4_0.gguf` (6.5 GB, `gemma4` arch, 48
layers, 262144-token vocabulary), CPU, 1024-token context:

| | |
| --- | --- |
| load | 3.0 s warm / 28.9 s cold, mmap |
| decode | ~2.6 tok/s (`benchmark`), 0.57 tok/s end-to-end on a 6-token answer |
| prefill | ~2.6 tok/s |
| resident | 7.6 GB peak footprint |

### What "runs" means here, and what it does not

The proof is not "no error was thrown". Three things in that run cannot be
produced by anything but a loaded llama.cpp holding this file:

1. **Vocabulary.** `tokenize("<|turn>")` returns `[105]` and
   `tokenize("<turn|>")` returns `[106]` — single control tokens whose ids the
   Swift has no way to know, and which match the `EOG token = 106 '<turn|>'`
   llama.cpp itself printed while loading. The same call on
   `"<start_of_turn>"` returns seven ordinary text tokens, because that marker
   is simply not in this model's vocabulary.
2. **An answer.** Asked the capital of Australia through the turn markers the
   model's own GGUF chat template uses, it replies `Canberra` and stops on
   EOG. Asked the identical question through Gemma 2/3's markers it replies
   `"Australia's capital city of Australia's capital city of"` — and `load`
   had already warned that those markers were absent. Same build, same model,
   same seed; only the template differs.
3. **Sampling.** Two seeds at temperature 1.4 give two different sentences.
   That is the first execution the b10760 sampler-chain drift fixes have ever
   had.

Not exercised, and not claimed:

- **Metal / any GPU.** `metalAvailable` is hardcoded false under
  `targetEnvironment(simulator)`, so `backends` is `["cpu"]` and the GPU→CPU
  fallback warning path is still untested. A signing identity and a device are
  the only way to change that.
- **A phone.** `chipset` reads `"arm64"`, `cpuCores` 10 and `totalMemory` 32 GB
  — the host Mac's, not a device's. The throughput figures above are a
  simulator's and say nothing about an A19.
- **Vision.** `MultimodalBridge` is still a refusal (see below), so
  `supportsVision` is false and the image path throws.
- **Speculative decoding.** No draft model was supplied, so `draftAcceptance`
  is absent and `lastDraftAcceptance` remains a stub returning 0.
- **Thermal throttling.** The simulator reported `nominal` throughout.

Everything else still runs against the web implementations, which report
`simulated: true`.

### What `getCapabilities` proves, and what it does not

`simulated: false` is **not** evidence that a native engine loaded. It is a
field an implementation sets; a plugin that linked no library and returned a
plausible struct would set it identically. On a simulator `chipset`,
`cpuCores` and `totalMemory` are no better — they are the host Mac's values
(measured: `"arm64"`, 10 cores, 32 GB).

The one field that can carry evidence is `engineVersion`, because it embeds
`llama_print_system_info()` — a string the engine produces, listing the flags
its binary was actually compiled with. Measured on the simulator:

```
llama.cpp b10760 | MTL : EMBED_LIBRARY = 1 | CPU : NEON = 1 | ARM_FMA = 1 |
FP16_VA = 1 | DOTPROD = 1 | LLAMAFILE = 1 | ACCELERATE = 1 | REPACK = 1 |
```

`tests/native-registration.test.ts` guards the line that produces it. It had
shipped as `.prefix(0)` — the empty string — which collapsed the whole field to
a compile-time constant.

## Vendoring

llama.cpp is **neither committed nor submoduled**.
`plugin-llama-cpp/tools/build-llama-xcframework.sh` clones a pinned tag into a
gitignored `.cache/` and builds the XCFramework that `Package.swift`'s `llama`
binaryTarget points at:

```sh
./native/plugin-llama-cpp/tools/build-llama-xcframework.sh            # ios-sim
./native/plugin-llama-cpp/tools/build-llama-xcframework.sh ios-sim ios-device
```

Roughly 90 s and 1.8 GB of scratch per slice. The tag lives in one line at the
top of that script, and the script refuses to build if the cache sits at a
different revision.

The published `llama-<tag>-xcframework.zip` release asset would make this a
one-line `.binaryTarget(url:checksum:)` with no script at all — but its
`Info.plist` lists only `macos-arm64_x86_64` and `ios-arm64`. **There is no
simulator slice**, and `.binaryTarget(url:)` cannot be mixed per-slice, so the
only target provable on a machine without a signing identity is the one the
prebuilt does not ship.

## Registration is packaging, not code

A plugin class compiled into the app is **not** a registered plugin. Capacitor
discovers plugins from packages: `plugin-llama-cpp/package.json` carries a
`capacitor` key, the root `package.json` depends on it by path, and
`Package.swift` names its library product exactly as the CLI derives it from
the npm name (`@chatterang/plugin-llama-cpp` → `ChatterangPluginLlamaCpp`).

Measured by deleting that `capacitor` key: `cap sync` silently found 6 plugins
instead of 7, `llama.framework` left the bundle, and
`LlamaCpp.getCapabilities()` threw `Unimplemented` — it did **not** fall back to
the web shim, because `@capacitor/core` reaches its `web` implementation only
on the `web` platform or a registered custom platform. `src/state/app.ts`
catches that with `.catch(() => null)`, so the app carried on with
`device: null`: no banner, no warning, just a quietly smaller model catalog.

Note that none of this may live inside `ios/` or `android/` — both are
gitignored generated trees, so an edit there is lost on a fresh clone. The
documented "set `customClass` on Main.storyboard" trick is also stale for
Capacitor 8: the generated `SceneDelegate.swift` hardcodes
`window?.rootViewController = CAPBridgeViewController()`, so the storyboard's
view controller is never instantiated.

## What remains, per plugin

### `plugin-llama-cpp`

**iOS** — steps 1 and 2 are done.

1. ~~Add llama.cpp as an XCFramework dependency.~~ Done: a `.binaryTarget`
   built by `tools/build-llama-xcframework.sh`. No bridging header was needed —
   llama.cpp's own module map declares `framework module llama`, so
   `import llama` in `LlamaContext.swift` resolves verbatim.
2. ~~Make the plugin discoverable.~~ Done; see "Registration is packaging" above.
3. Implement `MultimodalBridge` against `mtmd`. **Currently a refusal stub**:
   `load` returns false and `evaluate` throws, so `supportsVision` reports
   false and the existing warning path degrades to text-only. The symbols are
   available — the pinned XCFramework ships `mtmd.h` and `mtmd-helper.h` and
   exports the mtmd set — so what is missing is only our own bridge. (A2's
   finding that "vision has no implementation path" is true for Node, whose
   node-llama-cpp has no `mtmd` binding; it is not true on iOS.)
4. ~~Everything past `getCapabilities`.~~ Done. All ten methods run; see
   "What runs means here" above. The three b10760 API drifts are now
   semantically verified as well as compiled — `load_mode` replacing
   `use_mmap`/`use_mlock` (a 6.5 GB model mmaps and loads),
   `llama_vocab_n_tokens(vocab)` leading `llama_sampler_init_penalties` (the
   chain samples across a 262144-token vocabulary without going out of
   bounds), and the sampler chain as `UnsafeMutablePointer<llama_sampler>`.
5. Metal. `LlamaContext.metalAvailable` is hardcoded false under
   `targetEnvironment(simulator)`, so the GPU tier, the GPU→CPU fallback
   warning, and `gpu-metal` as an `activeBackend` are untested and untestable
   without a signing identity and a device.
6. ~~`LlamaContext.free()` calls the process-global `llama_backend_free()`.~~
   Fixed. `llama_backend_init()` now runs once per process behind a `static
   let` and is never freed; `free()` releases only this handle's own draft
   context, draft model, context, model and batch, and is idempotent because
   `deinit` calls it after `unload` already has. Proven by loading two handles,
   unloading the first, and generating on the second.
7. Set `NSSupportsBackgroundExecution` only if long generations should survive
   backgrounding; by default they do not, and the app cancels cleanly.
8. **`src/ai/prompt.ts` has no `gemma4` template.** Its `gemma` entry emits
   `<start_of_turn>` / `<end_of_turn>`, which Gemma 4 does not use — the
   canonical template in the GGUF opens `<|turn>role` and closes `<turn|>`,
   and adds a `<|channel>thought` preamble. `inferTemplate` maps any id
   containing "gemma" to that entry, so a Gemma 4 model in the catalogue gets
   the wrong markers and answers noise. The engine now warns at load; the
   template itself is a web-layer fix and is NOT done.
9. Speculative decoding reports nothing real. `lastDraftAcceptance` is a stored
   `0` that no code writes, so `draftAcceptance` would be `0` rather than a
   measurement whenever a draft model loads. `packages/inference-node` derives
   it from `sequence.tokenPredictions`; there is no equivalent here yet.

**Android**

1. Vendor llama.cpp under `android/src/main/cpp/` and build three variants of
   `llama-jni.cpp` — `chatterang-llama-cpu`, `chatterang-llama-opencl`, and
   `chatterang-llama-vulkan`. `LlamaBridge` loads the best one that links.
2. Target `arm64-v8a` only. Shipping `armeabi-v7a` doubles the binary for
   devices that cannot run a 3B model usefully anyway.
3. Use Play Feature Delivery so the GPU variants are downloaded on demand
   rather than bundled for every device (PRD §6, binary size).
4. `android:largeHeap="true"` on the application element, and confirm
   `ActivityManager.isLowRamDevice()` gates the larger catalog entries.

### `plugin-onnx-runtime`

1. Add `onnxruntime-mobile` (iOS) / `onnxruntime-android`, with the
   CoreML and NNAPI execution providers enabled.
2. Whisper: encoder + decoder-with-past session pair, greedy decoding, 30 s
   windows with a 5 s overlap.
3. Piper-class TTS: single session, phonemised input, WAV output at the
   voice's native sample rate.
4. Diffusion: text encoder → UNet loop → VAE decoder, each as its own session,
   all released as soon as generation ends. Emit `onnxProgress` per step, and
   a latent preview every fourth step where memory allows.

## The contract

Both native implementations must satisfy the TypeScript definitions in
`src/plugins/*/definitions.ts` exactly. Those definitions are the contract the
aimatey backend adapters are written against, and the adapter tests in
`tests/adapter.test.ts` run against the web implementation of the same
contract — so a native implementation that matches the definitions inherits
that coverage.

Three behaviours matter more than the rest, because the application layer
depends on them:

- **`load` never throws for a recoverable problem.** It falls back down the
  compute tier and reports what happened in `warnings`. The UI shows those
  warnings verbatim.
- **`generate` always emits a terminal `llamaEnd` event**, including on error
  and on cancel — exactly one, never zero and never two. The adapter's
  streaming loop waits on it, so a path that returns without one hangs the UI
  with no way back. On iOS the unknown-handle guard was exactly that path;
  `tools/prove-ios.sh` asserts the count on every request, and reintroducing
  the old guard makes it report 0 and exit 1.
- **`getCapabilities().simulated` is the truth**, not a guess. If a real engine
  is not running, it must say so.
