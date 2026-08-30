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

    /// Tokens currently resident in the KV cache, in order. Compared against
    /// the next prompt to find how much prefill can be skipped.
    private var cachedTokens: [llama_token] = []

    private(set) var warnings: [String] = []
    private(set) var activeBackend: String
    private(set) var contextLength: Int
    private(set) var supportsVision: Bool
    private(set) var chatTemplate: String

    static let engineVersion = "llama.cpp \(String(cString: llama_print_system_info()).prefix(0))b-chatterang"

    static var metalAvailable: Bool {
        #if targetEnvironment(simulator)
            return false
        #else
            return true
        #endif
    }

    // MARK: - Lifecycle

    init(options: LoadOptions) throws {
        llama_backend_init()

        threads = Int32(options.threads)
        contextLength = options.contextLength
        chatTemplate = options.chatTemplate ?? "chatml"

        var modelParams = llama_model_default_params()
        // On a phone the choice is between "all layers on the GPU" and "the
        // model does not fit"; partial offload is rarely the right answer.
        let wantsGpu = options.requestedBackend.hasPrefix("gpu") && Self.metalAvailable
        modelParams.n_gpu_layers = wantsGpu ? Int32(options.gpuLayers) : 0
        modelParams.use_mmap = options.useMmap
        modelParams.use_mlock = false

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
            llama_backend_free()
            throw EngineError.modelLoadFailed(options.modelPath)
        }

        vocab = llama_model_get_vocab(model)

        var contextParams = llama_context_default_params()
        contextParams.n_ctx = UInt32(options.contextLength)
        contextParams.n_batch = 512
        contextParams.n_threads = threads
        contextParams.n_threads_batch = threads

        context = llama_init_from_model(model, contextParams)
        guard context != nil else {
            llama_model_free(model)
            llama_backend_free()
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
            draftParams.use_mmap = true
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
    }

    func free() {
        llama_batch_free(batch)
        if let draftContext { llama_free(draftContext) }
        if let draftModel { llama_model_free(draftModel) }
        if let context { llama_free(context) }
        if let model { llama_model_free(model) }
        draftContext = nil
        draftModel = nil
        context = nil
        model = nil
        llama_backend_free()
    }

    deinit { free() }

    // MARK: - Tokenisation

    func tokenize(_ text: String) -> [Int32] {
        guard let vocab else { return [] }
        let utf8Count = text.utf8.count
        let capacity = utf8Count + 8
        var tokens = [llama_token](repeating: 0, count: capacity)

        let count = llama_tokenize(vocab, text, Int32(utf8Count), &tokens, Int32(capacity), true, false)
        guard count > 0 else { return [] }
        return Array(tokens.prefix(Int(count)))
    }

    private func detokenize(_ token: llama_token) -> String {
        guard let vocab else { return "" }
        var buffer = [CChar](repeating: 0, count: 64)
        let length = llama_token_to_piece(vocab, token, &buffer, 64, 0, false)
        guard length > 0 else { return "" }
        return String(decoding: buffer.prefix(Int(length)).map { UInt8(bitPattern: $0) }, as: UTF8.self)
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

        let promptTokens = tokenize(prompt)
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

        let chain = makeSamplerChain(sampler)
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

            let piece = detokenize(token)
            text += piece
            completionTokens += 1
            // The sampled token is now part of the cache's contents, so the
            // next turn's prefix match can include the model's own reply.
            cachedTokens.append(token)
            onToken(piece)

            // Stop sequences are checked on the accumulated text rather than
            // per token, because a sequence can straddle a token boundary.
            if let matched = sampler.stopSequences.first(where: { !$0.isEmpty && text.hasSuffix($0) }) {
                text = String(text.dropLast(matched.count))
                stopReason = "stop-sequence"
                break
            }

            llama_batch_clear(&batch)
            llama_batch_add(&batch, token, cursor, [0], true)
            cursor += 1

            if llama_decode(context, batch) != 0 {
                throw EngineError.outOfMemory
            }

            if completionTokens >= Int(sampler.maxTokens) {
                stopReason = "length"
            }
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

    private func makeSamplerChain(_ sampler: Sampler) -> OpaquePointer {
        var params = llama_sampler_chain_default_params()
        params.no_perf = true
        let chain = llama_sampler_chain_init(params)

        llama_sampler_chain_add(chain, llama_sampler_init_penalties(
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
        let tokens = Array(tokenize(filler).prefix(promptTokens))

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
        let chain = makeSamplerChain(sampler)
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
