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
| `plugin-llama-cpp` Android | **yes** — `arm64-v8a`, NDK 27 | **all ten methods**, CPU only |
| `plugin-onnx-runtime` iOS | no | no |
| `plugin-onnx-runtime` Android | no | no |

**Both llama.cpp legs have been built and both answer on a device.** Each
compiles against the same pinned llama.cpp (see "Vendoring" below) — iOS as a
16 MB `llama.framework` embedded in `App.app`, Android as a single
self-contained `libchatterang-llama-cpu.so` per ABI. Neither vendors a line of
llama.cpp into this tree.

## iOS

Runs a real 12B model on the iPhone 17 Pro simulator (iOS 26.5).

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

The Android JNI now has the same guard, which it did not before. Its
`engineVersion` reports a different string on the same pinned tag, which is the
point — it is the binary's own feature flags, not ours:

```
llama.cpp CPU : NEON = 1 | ARM_FMA = 1 | LLAMAFILE = 1 | REPACK = 1 |
[built against b10760]
```

The tag is appended and labelled as intent, never substituted for the
measurement: a library swapped underneath would keep reporting the tag.

## Android

Runs a real 0.5B model on the API 36 emulator (`emulator-5554`, `arm64-v8a`,
`ranchu`, **one core**, 1.93 GiB RAM). Reproduce with:

```sh
./native/plugin-llama-cpp/tools/prove-android.sh /abs/path/to/model.gguf
```

Same shape as the iOS harness — build the web app, append `tools/prove-android.js`
to the built `dist/`, `cap sync`, assemble, install, launch with logcat
attached — plus two things iOS cannot do. It tokenizes the SAME GGUF through
`node-llama-cpp` on the host first and diffs the device's ids against it, and
it exits non-zero if logcat carried a `FATAL EXCEPTION` or if the app is not
running when the harness finishes.

`JAVA_HOME` must be Android Studio's bundled JBR 21. Temurin 26 fails Gradle
with "Unsupported class file major version 70", and JDK 17 fails because
Capacitor pins `sourceCompatibility 21`.

Measured against `Qwen2.5-0.5B-Instruct-Q4_K_M.gguf` (398 MB, `qwen2` arch,
`chatml` sniffed from the GGUF's own template), CPU, 1024-token context:

| | |
| --- | --- |
| load | 0.9 s, mmap |
| decode | 0.31 tok/s (`benchmark`), 0.087 tok/s end-to-end on a 2-token answer |
| prefill | 1.37 tok/s |
| resident | 670 MB peak footprint |
| cache reuse | 20 of 21 prompt tokens on an identical re-ask |

Those throughput numbers are a **one-core emulator's** and say nothing about a
phone.

### What "runs" means here, and what it does not

Same standard as iOS. Three things in that run cannot be produced by anything
but a loaded llama.cpp holding this file:

1. **Vocabulary, checked against a second implementation.** All six reference
   strings tokenize to ids identical to `packages/inference-node`'s — 6/6, zero
   mismatches — including `héllo 🌊 漢字` as ten ids, which is the UTF-16
   round trip in `llama-jni.cpp` rather than `NewStringUTF`'s modified UTF-8.
   Both ChatML markers come back as the single control tokens 151644 and
   151645; with `parse_special` off they would not.
2. **An answer.** Asked the capital of Australia through the model's own
   markers it replies `Canberra` and stops on EOG in 2 completion tokens.
   Asked through Gemma's markers it rambles to the length cap. Uppercasing the
   C++ `decode_piece` return made the device answer `CANBERRA`; reverting
   restored it — so the text is coming through that function and not from
   anywhere else.
3. **Sampling.** Two seeds at the same temperature give two different
   sentences.

Not exercised, and not claimed:

- **Any GPU or NPU.** `-DGGML_VULKAN=ON` does not configure against this NDK
  (missing SPIRV-Headers, no `glslangValidator`), so only
  `chatterang-llama-cpu` is built. `backends` is `["cpu"]` — measured, not
  asserted: `nativeHasVulkan` and friends ask the ggml backend registry.
- **A phone.** `chipset` reads `ranchu`, `cpuCores` 1. See above.
- **Vision and speculative decoding.** `LLAMA_BUILD_MTMD` is OFF and no draft
  path exists. `load` warns when either is requested rather than dropping it
  silently.
- **Any ABI but `arm64-v8a`.**

### Refusing instead of dying

A device that cannot run this engine must be REFUSED on, per call, not died
on. Capacitor makes that harder than it sounds: `Bridge.callPluginMethod`
(Bridge.java:839-851) runs the method inside a `Runnable` whose handler is
`catch (Exception ex) { throw new RuntimeException(ex); }`, and
`PluginHandle.invoke` (:138) calls reflectively — so an `Error` comes back
wrapped in an `InvocationTargetException`, which IS an `Exception`, is caught,
and is rethrown uncaught on a `HandlerThread`. That is a process kill, not a
rejected promise.

Three distinct failures reach that, and all three are now closed. Only the
first was known before this milestone:

1. **No library at all.** `LlamaBridge` used to `System.loadLibrary` from an
   `init {}` block and throw. Because it is a Kotlin `object`, the first touch
   of any member ran `<clinit>`, so the first `getCapabilities` killed the app.
   Fixed in f5c7c24: the load result is data (`loadFailure`), and nothing in
   that file throws.
2. **A library that loads but is missing a symbol.** `loadFailure` answers only
   "did any `.so` dlopen", and a null answer is not a promise that the library
   is complete. `getCapabilities` was the one plugin method calling into native
   on Capacitor's own thread with nothing around it. Measured by renaming
   `Java_app_chatterang_llama_LlamaBridge_engineVersion` in `llama-jni.cpp`:
   the `.so` still built, still loaded, every gate passed, and

   ```
   FATAL EXCEPTION: CapacitorPlugins
   Caused by: java.lang.UnsatisfiedLinkError: No implementation found for
     java.lang.String app.chatterang.llama.LlamaBridge.engineVersion()
     at app.chatterang.llama.LlamaCppPlugin.getCapabilities(LlamaCppPlugin.kt:86)
   ```

   with `prove-android.sh` exiting 1, zero `[PROVE]` lines and no pid. The
   identical injection now exits 0 with the app alive and `getCapabilities`
   refusing with `ENGINE_UNAVAILABLE`. `handleOnDestroy` had the same shape
   with no `PluginCall` to reject to and is guarded too.
3. **A by-name lookup failing inside the JNI.** One layer below the other two,
   found by the R8 experiment below rather than reasoned about: a failed
   `FindClass` / `GetMethodID` leaves a pending exception, and the next JNI
   call with one pending is `JNI DETECTED ERROR IN APPLICATION` — SIGABRT, no
   Java stack, nothing to catch. `llama-jni.cpp`'s `missing()` clears it and
   throws a readable `IllegalStateException` instead.

`tests/native-registration.test.ts` fences the Kotlin and the JNI against every
one of these, and each fence was fault-injected before being believed.

### Minification will break the JNI unless the keep rules ship

`llama-jni.cpp` resolves Java by NAME at runtime — `FindClass` for
`LlamaBridge$GenerateResult` and `$BenchmarkResult`, `GetMethodID` for
`onToken`, and every exported symbol embeds the class and method name it
implements. R8 renames all of that, and the failure is silent: everything
compiles, the library loads, and `FindClass` returns null.

The rules cannot live in `android/app/proguard-rules.pro` — that tree is
generated and gitignored, so `cap sync` erases it. They ship as
`consumerProguardFiles` from the plugin module instead
(`native/plugin-llama-cpp/android/proguard-rules.pro`), which is the mechanism
`@capacitor/android` uses for its own reflective plugin discovery.

Verified rather than assumed, because the generated app sets
`minifyEnabled false` and nothing had ever exercised it. `minifyEnabled true`
was set on the debug build type and the harness re-run three times against a
genuinely minified APK — R8 emitted a 5.4 MB `mapping.txt` each time:

| | result |
| --- | --- |
| rules present | full pass. `LlamaBridge` and both result classes appear in `mapping.txt` mapping to themselves |
| rules emptied | **process abort.** `Fatal signal 6 (SIGABRT)`, no pid afterwards |
| rules emptied, JNI guarded | clean refusal naming the missing symbol, one terminal event, app alive |

The middle row is the interesting one, and not for the reason expected. AGP's
default `proguard-android.txt` already carries
`-keepclasseswithmembernames,includedescriptorclasses class * { native <methods>; }`,
which keeps `LlamaBridge` AND — through `includedescriptorclasses` — the names
of `GenerateResult`, `BenchmarkResult` and `TokenCallback`, because all three
appear in a native method's descriptor. So `getCapabilities`, `load` and
`tokenize` all still worked. What it does **not** keep is a member of a
descriptor class, so `TokenCallback.onToken` was renamed, `GetMethodID`
returned null, and:

```
Abort message: 'JNI DETECTED ERROR IN APPLICATION: JNI GetStringLength called
  with pending exception java.lang.NoSuchMethodError: no non-static method
  "…LlamaCppPlugin$generate$1$result$2;.onToken(Ljava/lang/String;)Z"'
Fatal signal 6 (SIGABRT), code -1 (SI_QUEUE) in tid 11312 (chatterang-llam)
```

That is the point in `llama-jni.cpp`'s `missing()`: `FindClass` and
`GetMethodID` do not merely return null, they leave a PENDING EXCEPTION, and
the next JNI call with one pending is a fatal JNI error. The old code tested
two of the four lookups for null and did not test `on_token` at all. It now
clears the exception and throws a readable one, which is why the third row
refuses instead of aborting — a broken build should be diagnosable, not a
crash with no message.

## Vendoring

llama.cpp is **neither committed nor submoduled**, on either platform.
`plugin-llama-cpp/tools/fetch-llama-cpp.sh` clones a pinned tag into a
gitignored `.cache/`, and both legs build from that one clone.

**Android** points CMake at it and links `llama` and `ggml` statically into a
single `libchatterang-llama-cpu.so`. `android/build.gradle` reads the tag out
of the fetch script rather than repeating it, because two copies of a version
number drift and the failure that produces is a link error against the wrong
`llama.h` much later. `tests/native-registration.test.ts` refuses to let any
`.c/.cpp/.h/.hpp/.metal` file become tracked under `native/` except the one JNI
shim we wrote, so a stray `git add` of the clone is caught.

**iOS** uses `plugin-llama-cpp/tools/build-llama-xcframework.sh`, which builds
the XCFramework that `Package.swift`'s `llama` binaryTarget points at:

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

**Android** — steps 1, 2 and 5 are done.

1. ~~Build `llama-jni.cpp` against llama.cpp.~~ Done, and NOT by vendoring:
   the earlier plan here said "vendor llama.cpp under `android/src/main/cpp/`",
   which the shipped `CMakeLists.txt` deliberately does not do. It takes the
   same pinned `.cache/` clone iOS uses (see "Vendoring") and links `llama` and
   `ggml` statically into one `.so`, so this tree carries a pin rather than
   168 MB of someone else's source.
2. ~~Target `arm64-v8a` only.~~ Done — `abiFilters` in `android/build.gradle`.
   Every device this app targets runs it, the Apple-silicon emulator runs it,
   and `armeabi-v7a` is 32-bit, where a 6 GB mmap cannot fit in the address
   space at all. Adding an ABI is a line there, not a redesign.
3. **Only the CPU variant is built.** `LlamaBridge` names three and tries
   vulkan → opencl → cpu, which is the right runtime shape — a Vulkan-linked
   library on a device with a non-conformant driver crashes at `dlopen`, so
   each backend has to be its own file. But `-DGGML_VULKAN=ON` does not
   configure against this NDK: `Could not find a package configuration file
   provided by "SPIRV-Headers"`, and `glslangValidator` is not on PATH. That is
   a dependency chain (SPIRV-Headers, SPIRV-Tools, glslang) nobody has priced.
   Until one GPU variant actually builds, Play Feature Delivery for the GPU
   variants (the old item 3 here) has nothing to deliver and is not a task.
4. `android:largeHeap="true"` on the application element, and confirm
   `ActivityManager.isLowRamDevice()` gates the larger catalog entries.
5. ~~A plugin method that kills the app instead of refusing.~~ Fixed, for both
   failure modes; see "Refusing instead of dying" above.
6. **R8.** The keep rules ship from the module and a minified build passes the
   full harness — but nothing in CI runs minified, because the generated
   `android/app/build.gradle` sets `minifyEnabled false` and that file cannot
   be edited durably. What protects the rules day to day is
   `tests/native-registration.test.ts`, which extracts every `FindClass` and
   `GetMethodID` string out of `llama-jni.cpp` and fails if any of them has no
   keep rule — so a new runtime lookup added without one goes red.

   The rules are load-bearing, not decorative — emptying them and rebuilding
   aborted the process. The A/B is under "Minification" above.

   What is still NOT covered: `shrinkResources`, the R8 *optimize* config
   (`proguard-android-optimize.txt`, which drops `-dontoptimize`), and a real
   `release` build, which needs a signing identity. All three were out of reach
   here; the debug build type was minified instead.

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
  with no way back. The unknown-handle guard was exactly that path on BOTH
  platforms; `prove-ios.sh` and `prove-android.sh` each assert the count on
  every request, and reintroducing the old guard makes it report 0 and exit 1.
- **`getCapabilities().simulated` is the truth**, not a guess. If a real engine
  is not running, it must say so.
