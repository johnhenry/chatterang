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
emission, error mapping, and the engine wrapper. They have **not been compiled
in this repository**, because doing so requires vendoring and cross-compiling
llama.cpp and ONNX Runtime for four ABIs — a build step, not a code step.

Everything above the bridge runs today against the web implementations, so the
whole application is exercisable before the native build exists. The web
implementation reports `simulated: true`, and the app says so in a banner
rather than letting a preview pass for a real engine.

## What remains, per plugin

### `plugin-llama-cpp`

**iOS**

1. Add [llama.cpp](https://github.com/ggml-org/llama.cpp) as a Swift package or
   XCFramework dependency, built with `LLAMA_METAL=1`.
2. Add the Objective-C bridging header exporting `llama.h` and `mtmd.h`.
3. Implement `MultimodalBridge` against `mtmd` — `LlamaContext` calls into it
   for projector loading and image evaluation, and degrades to text-only when
   it reports failure.
4. Set `NSSupportsBackgroundExecution` only if long generations should survive
   backgrounding; by default they do not, and the app cancels cleanly.

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
- **`generate` always emits a terminal `llamaEnd` event**, including on error.
  The adapter's streaming loop waits on it.
- **`getCapabilities().simulated` is the truth**, not a guess. If a real engine
  is not running, it must say so.
