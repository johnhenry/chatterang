# Model manifest

A manifest declares everything the app needs to decide whether a model can run
on this device, which engine should run it, and what it is capable of. The
schema lives in [`src/domain/manifest.ts`](../src/domain/manifest.ts) and is the
contract between the catalog, the download manager, and the engine layer.

```jsonc
{
  "id": "qwen3-4b-instruct-q4km",
  "name": "Qwen3 4B Instruct",
  "author": "Alibaba Qwen",
  "description": "Strong reasoning and code for its size, with reliable tool calling.",

  // The aimatey backend-adapter id. This is the whole integration point for a
  // new runtime: register an adapter under this name and models can name it.
  "engine": "llama-cpp",
  "format": "gguf",
  "quantization": "Q4_K_M",
  "capabilities": ["text", "tools", "thinking"],

  "sizeBytes": 2497281120,
  "minRAM": 4294967296,          // below this, loading is killed by the OS
  "recommendedRAM": 8589934592,  // below this, it runs but slowly — warn
  "recommendedBackend": "gpu-metal",

  "contextLength": 32768,
  "parameterCount": "4B",
  "license": "Apache-2.0",

  "source": {
    "repo": "unsloth/Qwen3-4B-Instruct-2507-GGUF",
    "file": "Qwen3-4B-Instruct-2507-Q4_K_M.gguf",
    "gated": false,
    "companions": [{ "file": "mmproj-model-f16.gguf", "role": "mmproj" }]
  },

  "promptTemplate": "qwen",
  "defaultSampler": { "temperature": 0.7, "topP": 0.8, "topK": 20, "minP": 0 },
  "draftModels": ["qwen2.5-0.5b-instruct-q4km"],
  "bestFor": "Reasoning, code, and tool use"
}
```

## Fields that carry weight

**`engine`** is an aimatey backend-adapter id, not a free-form label. If no
adapter is registered under that name, the model cannot be served — which is
the intended failure, and it is a legible one.

**`minRAM` and `recommendedRAM` are different questions.** Below `minRAM` the
Models screen refuses the download outright and says why; between the two it
downloads with a warning. Both are checked against the device's *total* memory
rather than free memory, because free memory at browse time says nothing about
free memory at load time.

**`capabilities`** drives more than badges. `vision` enables the composer's
image button, `audio-in` populates the dictation model list, `audio-out` the
neural voice list, `image-out` the Studio screen, and `draft` the speculative
decoding picker. A capability the engine cannot actually serve is a bug — the
test suite asserts that vision models ship an `mmproj` companion and that
image models route to `onnx-runtime`.

**`companions`** are fetched alongside the main file with the same progress
accounting. Roles: `mmproj` (vision projector), `tokenizer`, `vocoder`, `vae`,
`text-encoder`, `config`.

**`promptTemplate`** is applied in TypeScript before the prompt reaches any
engine, so the same conversation renders identically everywhere. When it is
absent, `inferTemplate()` guesses from the model id — reliable enough for the
common families, and the reason a manifest should state it explicitly.

## Where manifests come from

1. **The curated catalog** (`src/data/catalog.ts`) — hand-written, with real
   file names and real sizes taken from the Hub, so the storage and memory
   arithmetic on the Models screen is truthful before anything is downloaded.
2. **The Hugging Face browser** — builds a manifest from a repo's file listing.
   Sizes come from `HEAD` requests (`x-linked-size`), memory requirements are
   estimated at 1.4× and 2× file size, and the template is inferred from the
   repo id. Less precise than a curated entry, which is why the catalog exists.

## Adding an engine

1. Write the adapter: `src/ai/backends/<engine>.ts`, implementing aimatey's
   `BackendAdapter`. `llama-cpp.ts` is the reference.
2. Register it in `ChatterangEngine`'s constructor, ideally behind a device
   capability check.
3. Add the id to `ENGINE_IDS`, `LOCAL_ENGINES`, and `ENGINE_PHASE` in
   `manifest.ts`.
4. Add catalog entries naming it.

Steps 1 and 3 are the real work. Nothing in `features/` is touched.
