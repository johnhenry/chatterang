import Foundation
import llama

/// Thin, opinionated wrapper around llama.cpp.
///
/// Everything here runs on the plugin's serial queue; nothing in this type is
/// thread-safe on its own, and it deliberately does not try to be — one
/// resident model, one queue, one place where the C API is touched.
final class LlamaContext {
    struct LoadOptions {
        let modelPath: String
        let mmprojPath: String?
        let draftModelPath: String?
        let contextLength: Int
        let gpuLayers: Int
        let requestedBackend: String
        let threads: Int
        let useMmap: Bool
        let chatTemplate: String?
        /// The chosen template's control markers, for the load-time match
        /// check. See `recogniseTemplate`.
        let templateMarkers: [String]
    }

    struct Sampler {
        var temperature: Float = 0.7
        var topP: Float = 0.95
        var topK: Int32 = 40
        var minP: Float = 0.05
        var repeatPenalty: Float = 1.1
        var repeatLastN: Int32 = 64
        var frequencyPenalty: Float = 0
        var presencePenalty: Float = 0
        var maxTokens: Int32 = 1024
        var seed: UInt32 = UInt32.max // LLAMA_DEFAULT_SEED
        var stopSequences: [String] = []
        var draftTokens: Int32 = 5

        init(from dictionary: [String: Any]) {
            if let value = dictionary["temperature"] as? Double { temperature = Float(value) }
            if let value = dictionary["topP"] as? Double { topP = Float(value) }
            if let value = dictionary["topK"] as? Int { topK = Int32(value) }
            if let value = dictionary["minP"] as? Double { minP = Float(value) }
            if let value = dictionary["repeatPenalty"] as? Double { repeatPenalty = Float(value) }
            if let value = dictionary["repeatLastN"] as? Int { repeatLastN = Int32(value) }
            if let value = dictionary["frequencyPenalty"] as? Double { frequencyPenalty = Float(value) }
            if let value = dictionary["presencePenalty"] as? Double { presencePenalty = Float(value) }
            if let value = dictionary["maxTokens"] as? Int { maxTokens = Int32(value) }
            if let value = dictionary["seed"] as? Int, value >= 0 { seed = UInt32(value) }
            if let value = dictionary["stopSequences"] as? [String] { stopSequences = value }
            if let value = dictionary["draftTokens"] as? Int { draftTokens = Int32(value) }
        }
    }

    struct Result {
        let text: String
        let promptTokens: Int
        /// Prompt tokens reused from the KV cache instead of re-processed.
        let cachedTokens: Int
        let completionTokens: Int
        let stopReason: String
        let draftAcceptance: Double?
    }

    struct Measurement {
        let promptTokensPerSecond: Double
        let generateTokensPerSecond: Double
    }

    enum EngineError: Error {
        case modelLoadFailed(String)
        case contextCreationFailed
        case outOfMemory
        case visionProjectorFailed(String)

        var userFacingMessage: String {
            switch self {
            case let .modelLoadFailed(path):
                return "The model file could not be opened (\(URL(fileURLWithPath: path).lastPathComponent)). It may be incomplete — try downloading it again."
            case .contextCreationFailed:
                return "There was not enough memory to prepare this model. Close other apps or choose a smaller model."
            case .outOfMemory:
                return "The device ran out of memory while generating."
            case let .visionProjectorFailed(path):
                return "The vision projector could not be loaded (\(URL(fileURLWithPath: path).lastPathComponent)); images will be ignored."
            }
        }
    }

    // MARK: - State

    private var model: OpaquePointer?
    private var context: OpaquePointer?
    private var draftModel: OpaquePointer?
    private var draftContext: OpaquePointer?
    private var vocab: OpaquePointer?
    private var batch: llama_batch
    private let threads: Int32
    /// `free()` is called explicitly by `unload` and again by `deinit`. Without
    /// this, `llama_batch_free` runs twice on the same allocation.
    private var released = false

    /// Bytes of a multi-byte UTF-8 sequence that arrived split across tokens.
    /// See `decode(_:)`.
    private var pendingBytes: [UInt8] = []

    /// Tokens currently resident in the KV cache, in order. Compared against
    /// the next prompt to find how much prefill can be skipped.
    private var cachedTokens: [llama_token] = []

    private(set) var warnings: [String] = []
    private(set) var activeBackend: String
    private(set) var contextLength: Int
    private(set) var supportsVision: Bool
    private(set) var chatTemplate: String

    /// The llama.cpp tag `tools/build-llama-xcframework.sh` pins. This is a
    /// SOURCE CONSTANT: it records what we intended to build against, not what
    /// actually loaded. On its own it proves nothing — a plugin that linked no
    /// engine at all would report it just as confidently.
    static let pinnedTag = "b10760"

    /// Engine identity, and the only field in `getCapabilities` that can serve
    /// as evidence the real engine is present.
    ///
    /// `simulated: false` cannot do that job — it is a boolean an implementation
    /// sets, and a stub returning a plausible struct sets it the same way. Nor
    /// can `chipset`, `cpuCores` or `totalMemory`: on a simulator those are the
    /// host Mac's values, not a phone's.
    ///
    /// `llama_print_system_info()` is different in kind. It is produced by the
    /// engine, it enumerates the feature flags the binary was actually compiled
    /// with (NEON, ARM_FMA, ACCELERATE, METAL...), and reaching it at all
    /// requires the framework to have linked and loaded.
    ///
    /// This line previously read `.prefix(0)` — which is the empty string, so
    /// the whole field collapsed to the compile-time constant
    /// "llama.cpp b-chatterang" and was indistinguishable from a stub's output.
    static let engineVersion: String = {
        let reported = String(cString: llama_print_system_info())
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return "llama.cpp \(pinnedTag) | \(reported)"
    }()

    static var metalAvailable: Bool {
        #if targetEnvironment(simulator)
            return false
        #else
            return true
        #endif
    }

    // MARK: - Lifecycle

    /// `llama_backend_init()` / `llama_backend_free()` are PROCESS-GLOBAL: they
    /// set up and tear down the ggml backend registry shared by every model in
    /// the process, and neither is reference-counted.
    ///
    /// So this is initialised exactly once, lazily, and is never freed. The
    /// previous shape — init per context, free in `free()` — meant unloading
    /// one handle tore the backend out from under every other one that was
    /// still loaded. `packages/inference-node` has the right shape and is worth
    /// copying: it disposes sequence → context → model per handle and touches
    /// nothing global until the whole plugin is disposed.
    ///
    /// Not freeing at all is the correct trade here. The backend registry is a
    /// fixed, small allocation, the plugin lives as long as the app does, and
    /// iOS reclaims it at exit — whereas a global teardown reachable from a
    /// per-handle call is a use-after-free waiting for a second handle.
    private static let backendReady: Void = {
        llama_backend_init()
    }()

    init(options: LoadOptions) throws {
        _ = Self.backendReady

        threads = Int32(options.threads)
        contextLength = options.contextLength
        // Provisional; replaced below once the model's own metadata is
        // readable, which needs the model loaded.
        chatTemplate = options.chatTemplate ?? "unknown"

        var modelParams = llama_model_default_params()
        // On a phone the choice is between "all layers on the GPU" and "the
        // model does not fit"; partial offload is rarely the right answer.
        let wantsGpu = options.requestedBackend.hasPrefix("gpu") && Self.metalAvailable
        modelParams.n_gpu_layers = wantsGpu ? Int32(options.gpuLayers) : 0
        // API drift, b10760: `use_mmap`/`use_mlock` were replaced by a single
        // `load_mode` enum. `.NONE` is the honest translation of the old
        // `use_mmap = false, use_mlock = false` pair — not `.AUTO`, which would
        // let llama.cpp re-enable mmap behind a caller that asked for it off.
        modelParams.load_mode = options.useMmap ? LLAMA_LOAD_MODE_MMAP : LLAMA_LOAD_MODE_NONE

        model = llama_model_load_from_file(options.modelPath, modelParams)

        if model == nil, wantsGpu {
            // Hardware-tiered fallback (PRD §3.1): GPU → CPU rather than
            // failing outright.
            warnings.append("The GPU could not load this model, so it is running on the CPU. Expect it to be slower.")
            modelParams.n_gpu_layers = 0
            model = llama_model_load_from_file(options.modelPath, modelParams)
            activeBackend = "cpu"
        } else {
            activeBackend = wantsGpu ? "gpu-metal" : "cpu"
        }

        guard let model else {
            throw EngineError.modelLoadFailed(options.modelPath)
        }

        vocab = llama_model_get_vocab(model)

        // The GGUF's own template, when it carries one, beats the caller's
        // guess — the caller chose by model id, the file knows. llama.cpp
        // returns the raw Jinja body rather than a name, so the name is
        // sniffed from its markers; that is a heuristic and falls back to what
        // the caller asked for.
        chatTemplate = Self.templateName(of: model) ?? options.chatTemplate ?? "unknown"

        var contextParams = llama_context_default_params()
        contextParams.n_ctx = UInt32(options.contextLength)
        contextParams.n_batch = 512
        contextParams.n_threads = threads
        contextParams.n_threads_batch = threads

        context = llama_init_from_model(model, contextParams)
        guard context != nil else {
            llama_model_free(model)
            self.model = nil
            throw EngineError.contextCreationFailed
        }

        // A shorter context is better than no model at all, so the caller is
        // told rather than left guessing when the request is trimmed.
        let actual = Int(llama_n_ctx(context))
        if actual < options.contextLength {
            warnings.append("The context was reduced to \(actual) tokens to fit in memory.")
            contextLength = actual
        }

        batch = llama_batch_init(512, 0, 1)

        supportsVision = false
        if let mmprojPath = options.mmprojPath {
            // The multimodal projector is loaded through llama.cpp's `mtmd`
            // helper; a failure here degrades to text-only rather than
            // aborting the load.
            supportsVision = Self.loadProjector(path: mmprojPath, model: model)
            if !supportsVision {
                warnings.append(EngineError.visionProjectorFailed(mmprojPath).userFacingMessage)
            }
        }

        if let draftPath = options.draftModelPath {
            var draftParams = llama_model_default_params()
            draftParams.n_gpu_layers = modelParams.n_gpu_layers
            draftParams.load_mode = LLAMA_LOAD_MODE_MMAP
            draftModel = llama_model_load_from_file(draftPath, draftParams)

            if let draftModel {
                var draftContextParams = llama_context_default_params()
                draftContextParams.n_ctx = UInt32(contextLength)
                draftContextParams.n_threads = threads
                draftContext = llama_init_from_model(draftModel, draftContextParams)
            }

            if draftContext == nil {
                warnings.append("The draft model could not be loaded, so speculative decoding is off.")
            }
        }

        // Does the chosen template's vocabulary actually exist in this model?
        //
        // A control marker the model knows tokenizes to exactly one token. If
        // NOT ONE of the template's markers does, the template belongs to a
        // different model family and every turn is rendered in a language this
        // model cannot read — the symptom is incoherent output, which reads as
        // a broken model rather than a wrong template.
        //
        // A warning, not a refusal, matching `packages/inference-node`: some
        // templates legitimately use plain-text markers, and one wrong guess
        // should not make a model unloadable.
        let markers = options.templateMarkers.filter { !$0.isEmpty }
        if !markers.isEmpty {
            let recognised = markers.filter {
                tokenize($0, addSpecial: false, parseSpecial: true).count == 1
            }
            if recognised.isEmpty {
                warnings.append(
                    "The \"\(options.chatTemplate ?? chatTemplate)\" chat template does not match this "
                        + "model: none of its markers (\(markers.joined(separator: ", "))) exist in its "
                        + "vocabulary, so they will be sent as ordinary text. Expect incoherent output "
                        + "until the template is changed."
                )
            }
        }
    }

    /// Releases this handle's resources. Idempotent: `unload` calls it and then
    /// `deinit` calls it again on the same instance, which without the guard
    /// double-frees `batch`.
    ///
    /// Innermost first, and nothing process-global — see `backendReady`.
    func free() {
        guard !released else { return }
        released = true

        llama_batch_free(batch)
        if let draftContext { llama_free(draftContext) }
        if let draftModel { llama_model_free(draftModel) }
        if let context { llama_free(context) }
        if let model { llama_model_free(model) }
        draftContext = nil
        draftModel = nil
        context = nil
        model = nil
        vocab = nil
    }

    deinit { free() }

    // MARK: - Tokenisation

    /// - Parameters:
    ///   - addSpecial: let the vocabulary prepend its BOS token.
    ///   - parseSpecial: read `<start_of_turn>` and friends as the control
    ///     tokens they are, rather than as their literal characters.
    ///
    /// `parseSpecial` is the load-bearing one, and it used to be `false` here
    /// while the Node implementation passes `true`
    /// (`model.tokenize(prompt, true)` at `packages/inference-node/src/llama-cpp.ts:573`).
    /// The prompt arrives from `src/ai/prompt.ts` already rendered by the app's
    /// own template, so with `false` every `<start_of_turn>` reached the model
    /// as ordinary text — the exact failure the `templateMarkers` check exists
    /// to warn about, except self-inflicted and unwarnable.
    func tokenize(_ text: String, addSpecial: Bool, parseSpecial: Bool) -> [Int32] {
        guard let vocab, !text.isEmpty else { return [] }
        let utf8Count = text.utf8.count
        // One token per byte is the floor; the slack covers BOS/EOS.
        let capacity = utf8Count + 8
        var tokens = [llama_token](repeating: 0, count: capacity)

        let count = llama_tokenize(
            vocab, text, Int32(utf8Count), &tokens, Int32(capacity), addSpecial, parseSpecial
        )
        guard count > 0 else { return [] }
        return Array(tokens.prefix(Int(count)))
    }

    /// Raw bytes of one token. Deliberately NOT a `String`: see `decode`.
    private func bytes(of token: llama_token) -> [UInt8] {
        guard let vocab else { return [] }
        var buffer = [CChar](repeating: 0, count: 64)
        var length = llama_token_to_piece(vocab, token, &buffer, Int32(buffer.count), 0, false)
        if length < 0 {
            // Negative is "buffer too small, and this is how much you need".
            // Dropping it (the old `guard length > 0`) silently swallowed any
            // token longer than 63 bytes.
            buffer = [CChar](repeating: 0, count: Int(-length))
            length = llama_token_to_piece(vocab, token, &buffer, Int32(buffer.count), 0, false)
        }
        guard length > 0 else { return [] }
        return buffer.prefix(Int(length)).map { UInt8(bitPattern: $0) }
    }

    /// Token bytes → text, holding back a trailing partial UTF-8 sequence.
    ///
    /// A token is a byte sequence, not a character: BPE splits "é" (or an
    /// emoji, or any CJK glyph) across two or three tokens. Decoding each
    /// token independently — which is what the old `detokenize` did — turns
    /// every one of those into U+FFFD, so the stream the user watches is
    /// corrupt even though the final text would not be.
    ///
    /// So incomplete trailing bytes are carried into the next call. `flush()`
    /// drains whatever is left when generation ends.
    private func decode(_ bytes: [UInt8]) -> String {
        pendingBytes.append(contentsOf: bytes)

        // Walk back at most 3 bytes looking for the start of a sequence that
        // is not yet complete; UTF-8 continuation bytes are 0b10xxxxxx.
        var boundary = pendingBytes.count
        var back = 0
        while back < 4, boundary > 0 {
            let lead = pendingBytes[boundary - 1]
            if lead & 0b1100_0000 == 0b1000_0000 {
                // Continuation byte: keep walking back to its lead byte.
                boundary -= 1
                back += 1
                continue
            }
            let expected: Int
            if lead & 0b1000_0000 == 0 { expected = 1 }
            else if lead & 0b1110_0000 == 0b1100_0000 { expected = 2 }
            else if lead & 0b1111_0000 == 0b1110_0000 { expected = 3 }
            else if lead & 0b1111_1000 == 0b1111_0000 { expected = 4 }
            else { expected = 1 } // Invalid lead; let the decoder replace it.

            if boundary - 1 + expected > pendingBytes.count {
                // The last sequence is short. Emit everything before it.
                boundary -= 1
            } else {
                boundary = pendingBytes.count
            }
            break
        }

        guard boundary > 0 else { return "" }
        let ready = pendingBytes.prefix(boundary)
        pendingBytes.removeFirst(boundary)
        return String(decoding: ready, as: UTF8.self)
    }

    /// Emits any bytes still held back. Non-empty only when generation stopped
    /// mid-character, in which case the replacement character is the honest
    /// rendering of bytes the model never finished.
    private func flushDecoder() -> String {
        guard !pendingBytes.isEmpty else { return "" }
        let remainder = pendingBytes
        pendingBytes = []
        return String(decoding: remainder, as: UTF8.self)
    }

    // MARK: - Generation

    func generate(
        prompt: String,
        images: [Data],
        sampler: Sampler,
        shouldStop: () -> Bool,
        onToken: (String) -> Void
    ) throws -> Result {
        guard let context, let vocab else { throw EngineError.contextCreationFailed }

        // `parseSpecial: true` because the prompt is already rendered by the
        // app's template and its control markers must become control tokens.
        // `addSpecial: true` lets the vocabulary prepend its own BOS: none of
        // the templates in `src/ai/prompt.ts` emit one, and a Gemma-family
        // model that never sees BOS degrades quietly.
        let promptTokens = tokenize(prompt, addSpecial: true, parseSpecial: true)
        // Each generation decodes its own stream; nothing may carry over from
        // the last one's trailing bytes.
        pendingBytes = []
        guard !promptTokens.isEmpty else {
            return Result(text: "", promptTokens: 0, cachedTokens: 0, completionTokens: 0, stopReason: "stop", draftAcceptance: nil)
        }

        let memory = llama_get_memory(context)

        // Reuse the KV cache across turns.
        //
        // A conversation's prompt grows by append: turn N's prompt is turn
        // N-1's prompt plus two more messages. Re-processing the shared prefix
        // every turn makes prefill grow quadratically over a conversation —
        // it is the single largest avoidable cost here.
        //
        // The correctness condition is that the cache must be truncated to
        // *exactly* the matching prefix. Keeping one token too many produces
        // subtly wrong output, which is far worse than being slow, so the
        // shared length is computed by direct comparison and the remainder is
        // dropped before anything new is decoded.
        var reused = commonPrefixLength(cachedTokens, promptTokens)

        // Never reuse the entire prompt: at least one token must be decoded to
        // produce logits to sample from.
        if reused == promptTokens.count { reused -= 1 }

        // An image is evaluated into the cache as opaque embeddings that the
        // token comparison cannot see, so a prompt carrying images starts
        // clean rather than risk reusing a prefix whose image content differs.
        if !images.isEmpty { reused = 0 }

        if reused > 0 {
            // Drop everything after the shared prefix.
            llama_memory_seq_rm(memory, 0, Int32(reused), -1)
        } else {
            llama_memory_clear(memory, true)
        }

        if !images.isEmpty && supportsVision {
            try Self.evaluateImages(images, context: context)
        }

        // Prefill only what the cache does not already hold.
        var cursor = Int32(reused)
        if reused < promptTokens.count {
            for chunk in stride(from: reused, to: promptTokens.count, by: 512) {
                let end = min(chunk + 512, promptTokens.count)
                llama_batch_clear(&batch)
                for index in chunk ..< end {
                    llama_batch_add(&batch, promptTokens[index], cursor, [0], index == promptTokens.count - 1)
                    cursor += 1
                }
                if llama_decode(context, batch) != 0 {
                    // A failed decode leaves the cache in an unknown state.
                    // Forget it rather than reuse something inconsistent.
                    cachedTokens = []
                    llama_memory_clear(memory, true)
                    throw EngineError.outOfMemory
                }
            }
        }

        cachedTokens = promptTokens

        let chain = try makeSamplerChain(sampler)
        defer { llama_sampler_free(chain) }

        var text = ""
        var completionTokens = 0
        var stopReason = "stop"

        while completionTokens < Int(sampler.maxTokens) {
            if shouldStop() {
                stopReason = "cancelled"
                break
            }

            let token = llama_sampler_sample(chain, context, -1)
            if llama_vocab_is_eog(vocab, token) {
                stopReason = "stop"
                break
            }

            llama_sampler_accept(chain, token)

            let chunk = decode(bytes(of: token))
            text += chunk
            completionTokens += 1
            // The sampled token is now part of the cache's contents, so the
            // next turn's prefix match can include the model's own reply.
            cachedTokens.append(token)
            // A token whose bytes are still being held back for the next one
            // produces no text; emitting an empty event would make `index`
            // count steps rather than pieces.
            if !chunk.isEmpty { onToken(chunk) }

            // Stop sequences are checked on the accumulated text rather than
            // per token, because a sequence can straddle a token boundary.
            if let matched = sampler.stopSequences.first(where: { !$0.isEmpty && text.hasSuffix($0) }) {
                text = String(text.dropLast(matched.count))
                stopReason = "stop-sequence"
                break
            }

            // Checked BEFORE the next decode: reaching the cap means no further
            // token will be sampled, so evaluating this one is work whose
            // result is thrown away. The old placement ran it every time.
            if completionTokens >= Int(sampler.maxTokens) {
                stopReason = "length"
                break
            }

            llama_batch_clear(&batch)
            llama_batch_add(&batch, token, cursor, [0], true)
            cursor += 1

            if llama_decode(context, batch) != 0 {
                throw EngineError.outOfMemory
            }
        }

        // Bytes of a character the model stopped in the middle of.
        let tail = flushDecoder()
        if !tail.isEmpty {
            text += tail
            onToken(tail)
        }

        return Result(
            text: text,
            promptTokens: promptTokens.count,
            cachedTokens: reused,
            completionTokens: completionTokens,
            stopReason: stopReason,
            draftAcceptance: draftContext != nil ? lastDraftAcceptance : nil
        )
    }

    private var lastDraftAcceptance: Double = 0

    // API drift, b10760: `struct llama_sampler` is a complete type in llama.h,
    // so Swift imports `llama_sampler *` as `UnsafeMutablePointer<llama_sampler>`,
    // not as `OpaquePointer`. Model and context pointers remain opaque; only
    // the sampler chain changed.
    //
    // It throws rather than force-unwrapping: `llama_sampler_chain_init`
    // returns a nullable pointer, and the only realistic null is an allocation
    // failure. Passing that null on to `llama_sampler_sample` would dereference
    // it inside C — a crash with no message — where throwing surfaces the same
    // condition as the recoverable out-of-memory the callers already handle.
    private func makeSamplerChain(_ sampler: Sampler) throws -> UnsafeMutablePointer<llama_sampler> {
        var params = llama_sampler_chain_default_params()
        params.no_perf = true
        guard let chain = llama_sampler_chain_init(params) else {
            throw EngineError.outOfMemory
        }

        // API drift, b10760: `llama_sampler_init_penalties` grew a leading
        // `int32_t n_vocab`. NOTE: this argument has never been exercised by a
        // real load — `getCapabilities` does not reach here.
        llama_sampler_chain_add(chain, llama_sampler_init_penalties(
            llama_vocab_n_tokens(vocab),
            sampler.repeatLastN,
            sampler.repeatPenalty,
            sampler.frequencyPenalty,
            sampler.presencePenalty
        ))
        llama_sampler_chain_add(chain, llama_sampler_init_top_k(sampler.topK))
        llama_sampler_chain_add(chain, llama_sampler_init_top_p(sampler.topP, 1))
        llama_sampler_chain_add(chain, llama_sampler_init_min_p(sampler.minP, 1))
        llama_sampler_chain_add(chain, llama_sampler_init_temp(sampler.temperature))
        llama_sampler_chain_add(chain, llama_sampler_init_dist(sampler.seed))

        return chain
    }

    // MARK: - Benchmark

    func measure(promptTokens: Int, generateTokens: Int) throws -> Measurement {
        guard let context else { throw EngineError.contextCreationFailed }

        // Benchmarks measure cold prefill. A warm cache would report a
        // throughput this device cannot actually sustain on a fresh prompt.
        llama_memory_clear(llama_get_memory(context), true)
        cachedTokens = []

        // A synthetic prompt of the requested length: the point is to measure
        // this device, not this prompt.
        let filler = String(repeating: "the quick brown fox jumps over the lazy dog. ", count: max(1, promptTokens / 9))
        // Plain filler text: no BOS, no control markers to parse. Matches
        // `packages/inference-node`'s `model.tokenize(filler, false)`.
        let tokens = Array(
            tokenize(filler, addSpecial: false, parseSpecial: false).prefix(max(2, promptTokens))
        )

        let prefillStart = Date()
        var cursor: Int32 = 0
        for chunk in stride(from: 0, to: tokens.count, by: 512) {
            let end = min(chunk + 512, tokens.count)
            llama_batch_clear(&batch)
            for index in chunk ..< end {
                llama_batch_add(&batch, tokens[index], cursor, [0], index == tokens.count - 1)
                cursor += 1
            }
            if llama_decode(context, batch) != 0 { throw EngineError.outOfMemory }
        }
        let prefillSeconds = max(0.001, Date().timeIntervalSince(prefillStart))

        var sampler = Sampler(from: [:])
        sampler.maxTokens = Int32(generateTokens)
        let chain = try makeSamplerChain(sampler)
        defer { llama_sampler_free(chain) }

        let decodeStart = Date()
        var produced = 0
        while produced < generateTokens {
            let token = llama_sampler_sample(chain, context, -1)
            llama_sampler_accept(chain, token)
            llama_batch_clear(&batch)
            llama_batch_add(&batch, token, cursor, [0], true)
            cursor += 1
            if llama_decode(context, batch) != 0 { break }
            produced += 1
        }
        let decodeSeconds = max(0.001, Date().timeIntervalSince(decodeStart))

        return Measurement(
            promptTokensPerSecond: Double(tokens.count) / prefillSeconds,
            generateTokensPerSecond: Double(produced) / decodeSeconds
        )
    }

    /// A template NAME sniffed from the GGUF's embedded Jinja body.
    ///
    /// `llama_model_chat_template` hands back the template source, not a name,
    /// and the contract's `chatTemplate` field is a name — so this matches on
    /// the control markers that identify a family. It is a heuristic and says
    /// nothing when it does not recognise one, which is why the caller's own
    /// value remains the fallback.
    ///
    /// (`packages/inference-node` gets a name for free from
    /// node-llama-cpp's `model.chatTemplateName`, which does the same kind of
    /// match against a larger table.)
    private static func templateName(of model: OpaquePointer) -> String? {
        guard let raw = llama_model_chat_template(model, nil) else { return nil }
        let body = String(cString: raw)
        guard !body.isEmpty else { return nil }

        // Order matters: the more specific marker first. Gemma 4's canonical
        // template uses `<|turn>role` / `<turn|>`, NOT Gemma 2/3's
        // `<start_of_turn>` / `<end_of_turn>` — measured on
        // gemma-4-12B-it-QAT, whose vocabulary has no `<start_of_turn>` at all.
        let families: [(String, String)] = [
            ("<|turn>", "gemma4"),
            ("<start_of_turn>", "gemma"),
            ("<|im_start|>", "chatml"),
            ("<|start_header_id|>", "llama3"),
            ("[INST]", "mistral"),
            ("<|user|>", "zephyr"),
            ("<|User|>", "deepseek"),
        ]
        for (marker, name) in families where body.contains(marker) {
            return name
        }
        return nil
    }

    /// Length of the longest common prefix of two token sequences.
    private func commonPrefixLength(_ a: [llama_token], _ b: [llama_token]) -> Int {
        var index = 0
        let limit = min(a.count, b.count)
        while index < limit && a[index] == b[index] { index += 1 }
        return index
    }

    // MARK: - Memory

    static func availableMemory() -> UInt64 {
        var info = mach_task_basic_info()
        var count = mach_msg_type_number_t(MemoryLayout<mach_task_basic_info>.size) / 4

        let result = withUnsafeMutablePointer(to: &info) { pointer in
            pointer.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
                task_info(mach_task_self_, task_flavor_t(MACH_TASK_BASIC_INFO), $0, &count)
            }
        }

        let physical = ProcessInfo.processInfo.physicalMemory
        guard result == KERN_SUCCESS else { return physical / 2 }

        // iOS terminates an app well before it reaches physical memory; the
        // practical ceiling is closer to 55% on most devices.
        let ceiling = UInt64(Double(physical) * 0.55)
        return ceiling > info.resident_size ? ceiling - info.resident_size : 0
    }

    static func footprint() -> UInt64 {
        var info = task_vm_info_data_t()
        var count = mach_msg_type_number_t(MemoryLayout<task_vm_info_data_t>.size) / 4

        let result = withUnsafeMutablePointer(to: &info) { pointer in
            pointer.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
                task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), $0, &count)
            }
        }
        return result == KERN_SUCCESS ? UInt64(info.phys_footprint) : 0
    }

    // MARK: - Multimodal

    /// Loads the `mtmd` projector. Implemented in the multimodal bridge so
    /// this file stays free of the mtmd headers when vision is not compiled in.
    private static func loadProjector(path: String, model: OpaquePointer) -> Bool {
        MultimodalBridge.shared.load(projectorPath: path, model: model)
    }

    private static func evaluateImages(_ images: [Data], context: OpaquePointer) throws {
        try MultimodalBridge.shared.evaluate(images: images, context: context)
    }
}

// MARK: - Batch helpers

private func llama_batch_clear(_ batch: inout llama_batch) {
    batch.n_tokens = 0
}

private func llama_batch_add(
    _ batch: inout llama_batch,
    _ token: llama_token,
    _ position: llama_pos,
    _ sequenceIds: [llama_seq_id],
    _ wantsLogits: Bool
) {
    let index = Int(batch.n_tokens)
    batch.token[index] = token
    batch.pos[index] = position
    batch.n_seq_id[index] = Int32(sequenceIds.count)
    for (offset, sequenceId) in sequenceIds.enumerated() {
        batch.seq_id[index]![offset] = sequenceId
    }
    batch.logits[index] = wantsLogits ? 1 : 0
    batch.n_tokens += 1
}
