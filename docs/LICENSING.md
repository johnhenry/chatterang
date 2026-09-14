# Licensing

Chatterang is Apache-2.0. Everything it depends on is MIT or Apache-2.0.

## Why the remote provider layer is built on aimatey

The PRD (§5, §6) identifies a specific risk: the app's remote-provider feature
set closely matches ChatterUI's, and ChatterUI is AGPL-3.0. Adapting its source
would put this entire codebase under AGPL.

Every remote provider here is instead an
[`@johnhenry/aimatey-backend`](https://www.npmjs.com/package/@johnhenry/aimatey-backend)
adapter, loaded on demand from a per-provider subpath. `src/ai/providers.ts`
contains a catalog — id, label, what connecting means, which fields are needed
— and a `load()` that dynamically imports the adapter. There is no HTTP code,
no request signing, and no response parsing for any provider anywhere in this
repository.

UI behaviours that resemble prior art were reimplemented from published format
descriptions and observable behaviour:

- **Character Card v2** is implemented against the published spec fields
  (`description`, `personality`, `scenario`, `first_mes`, `mes_example`,
  `system_prompt`, `post_history_instructions`, `alternate_greetings`,
  `character_book`). See `src/domain/persona.ts`.
- **Sampler settings, lore books, and the OS-voice TTS strategy** are
  general patterns, implemented here from their described behaviour.

No source was copied from any AGPL-licensed project.

## Dependency licences

| Package | Licence | Why |
| --- | --- | --- |
| `@johnhenry/aimatey-*` | MIT | Router, adapters, middleware, IR types |
| `@capacitor/*` | MIT | Native bridge |
| `react`, `react-dom` | MIT | UI |
| `zustand` | MIT | State |
| `dexie` | Apache-2.0 | IndexedDB |
| `react-markdown`, `remark-gfm`, `rehype-highlight` | MIT | Reply rendering |
| `vite`, `vitest`, `typescript` | MIT / Apache-2.0 | Build and test |
| `@peculiar/x509` | MIT | The tunnel's self-signed certificate (#179); desktop and server only |
| `reflect-metadata` | Apache-2.0 | The polyfill `@peculiar/x509` requires; loaded with it |

Verified against each package's published `LICENSE` file. The aimatey packages
are pinned to exact versions rather than ranges, per the PRD's treatment of
them as an in-house dependency (§6).

### One dependency note worth recording

`@johnhenry/aimatey-middleware`'s package entry point pulls in its caching
module, which imports Node's `crypto` by the bare specifier `'crypto'` rather
than `'node:crypto'`. In a webview that resolves to nothing and the module is
externalised. Chatterang therefore imports middleware from subpaths
(`@johnhenry/aimatey-middleware/retry`, `/logging`) rather than the barrel.
Worth fixing upstream, since the app owns that package.

### The tunnel's certificate library, and what it brings with it

#179 rules that the desktop's tunnel certificate is made by a maintained X.509
library, pinned. `@peculiar/x509@2.1.0` and `reflect-metadata@0.2.2` are
dependencies of `packages/tunnel` and imported only by its `host` half, which
`src/` may not import; the root manifest does not declare them, so the
`src/ imports only what this app declares` guard refuses them in the app bundle.

The table above is direct dependencies. These two bring, transitively: the
`@peculiar/asn1-*` schemas, `@peculiar/utils`, `pvtsutils`, `pvutils` and
`tsyringe` (all MIT), `asn1js` (**BSD-3-Clause**) and `tslib` (**0BSD**). Both
are permissive and compatible with Apache-2.0, and the lockfile already carried
BSD-3-Clause and 0BSD packages before this one.

Not chosen, with the reason: `node-forge` is BSD-3-Clause OR GPL-2.0 and makes
RSA certificates only; `jsrsasign` is marked unmaintained on npm; `pkijs` is
BSD-3-Clause as a direct dependency; `@fidm/x509` parses and does not create,
and was last published in 2022; `selfsigned` wraps `@peculiar/x509` 1.x and
adds `pkijs`, for nothing the tunnel needs.

## Native engine licences

| Engine | Licence | Phase |
| --- | --- | --- |
| llama.cpp | MIT | 1 |
| ONNX Runtime | MIT | 1 |
| MLC-LLM | Apache-2.0 | 2 (pending benchmark) |
| Cactus | **Non-standard** | 3 — blocked on legal review |
| ExecuTorch | BSD-3-Clause | 4 |

Cactus does not carry a standard OSI licence. Per the PRD (§4, §6), Phase 3 does
not begin until that review clears.

## Model weights

Model licences are the publisher's, not this app's, and vary widely — the
catalog spans Apache-2.0, MIT, the Llama 3.2 Community License, the Gemma Terms
of Use, and Stability's non-commercial research licence.

Each manifest carries its `license` field verbatim, and the model detail sheet
shows it before download alongside a link to the source repository. Gated
repositories are labelled as such and require the user's own Hugging Face token,
which is stored on the device and sent only to `huggingface.co`.

Commercial use of a model is the user's decision to make with the information in
front of them, which is why it is shown before the download button rather than
after it.
