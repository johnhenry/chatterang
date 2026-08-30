package app.chatterang.llama

/**
 * JNI surface for llama.cpp.
 *
 * Kept deliberately narrow and primitive-typed: every value that crosses this
 * boundary is a `long` handle, a primitive, or a `String`. Passing structured
 * objects through JNI is where this layer usually goes wrong, so results come
 * back as small data classes constructed on the native side.
 *
 * The corresponding C++ lives in `src/main/cpp/llama-jni.cpp`.
 */
object LlamaBridge {

    init {
        // The runtime picks the variant the device can actually use. A
        // Vulkan-linked library on a device without a conformant driver
        // crashes at load, so each backend ships as its own `.so`.
        loadFirstAvailable(
            "chatterang-llama-vulkan",
            "chatterang-llama-opencl",
            "chatterang-llama-cpu",
        )
    }

    private var loadedLibrary: String = ""

    private fun loadFirstAvailable(vararg names: String) {
        for (name in names) {
            try {
                System.loadLibrary(name)
                loadedLibrary = name
                return
            } catch (_: UnsatisfiedLinkError) {
                // Try the next tier down.
            }
        }
        throw UnsatisfiedLinkError(
            "No llama.cpp backend library could be loaded for this device.",
        )
    }

    fun hasVulkan(): Boolean = loadedLibrary.endsWith("vulkan") && nativeHasVulkan()

    fun hasOpenCl(): Boolean = loadedLibrary.endsWith("opencl") && nativeHasOpenCl()

    fun hasHexagon(): Boolean = nativeHasHexagon()

    /** Callback for streaming tokens. Return false to stop generation. */
    interface TokenCallback {
        fun onToken(token: String): Boolean
    }

    class GenerateResult(
        @JvmField val text: String,
        @JvmField val promptTokens: Int,
        /**
         * Prompt tokens served from the KV cache instead of re-processed.
         *
         * The native side keeps the previous prompt's tokens, finds the longest
         * common prefix with the next one, truncates the cache to exactly that
         * length with `llama_memory_seq_rm`, and decodes only the remainder.
         * Without it, prefill cost grows quadratically across a conversation.
         */
        @JvmField val cachedTokens: Int,
        @JvmField val completionTokens: Int,
        @JvmField val stopReason: String,
        /** Negative when speculative decoding was not in use. */
        @JvmField val draftAcceptance: Double,
    )

    class BenchmarkResult(
        @JvmField val promptTokensPerSecond: Double,
        @JvmField val generateTokensPerSecond: Double,
    )

    external fun engineVersion(): String

    /** Returns 0 on failure so the caller can fall back a tier. */
    external fun loadModel(
        modelPath: String,
        mmprojPath: String?,
        draftModelPath: String?,
        contextLength: Int,
        gpuLayers: Int,
        backend: String,
        threads: Int,
        useMmap: Boolean,
    ): Long

    external fun freeModel(handle: Long)

    external fun contextLength(handle: Long): Int

    external fun supportsVision(handle: Long): Boolean

    external fun tokenize(handle: Long, text: String): IntArray

    @Suppress("LongParameterList")
    external fun generate(
        handle: Long,
        prompt: String,
        /** Base64 image payloads, routed through the mtmd projector. */
        images: Array<String>,
        temperature: Float,
        topP: Float,
        topK: Int,
        minP: Float,
        repeatPenalty: Float,
        repeatLastN: Int,
        frequencyPenalty: Float,
        presencePenalty: Float,
        maxTokens: Int,
        seed: Int,
        stopSequences: Array<String>,
        draftTokens: Int,
        callback: TokenCallback,
    ): GenerateResult

    external fun benchmark(handle: Long, promptTokens: Int, generateTokens: Int): BenchmarkResult

    /** Resident set size of this process, in bytes. */
    external fun footprint(): Long

    private external fun nativeHasVulkan(): Boolean
    private external fun nativeHasOpenCl(): Boolean
    private external fun nativeHasHexagon(): Boolean
}
