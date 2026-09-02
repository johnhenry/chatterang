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
 *
 * ## Why nothing here throws during class initialisation
 *
 * This used to load the backend from an `init {}` block and throw
 * `UnsatisfiedLinkError` when none of the variants was present. Because this is
 * a Kotlin `object`, the first touch of any member runs `<clinit>`, so the very
 * first `getCapabilities` call threw — and killed the app:
 *
 *     FATAL EXCEPTION: CapacitorPlugins
 *     Caused by: java.lang.UnsatisfiedLinkError: No llama.cpp backend library
 *       at app.chatterang.llama.LlamaBridge.loadFirstAvailable(LlamaBridge.kt:38)
 *       at app.chatterang.llama.LlamaBridge.<clinit>(LlamaBridge.kt:19)
 *       at app.chatterang.llama.LlamaCppPlugin.getCapabilities(LlamaCppPlugin.kt:56)
 *
 * Nothing above rescues it. `Bridge.callPluginMethod` runs the plugin method
 * inside a `Runnable` on the `CapacitorPlugins` handler thread and its handler
 * is `catch (Exception ex) { ...; throw new RuntimeException(ex); }` — so
 * ANYTHING that escapes a `@PluginMethod`, `Error` or `Exception`, comes back
 * out as an uncaught `RuntimeException` on a `Handler` thread. That is a
 * process kill, not a rejected promise. The rule this file and
 * `LlamaCppPlugin.kt` follow from that is: a plugin method never lets anything
 * escape, and initialisation never throws.
 *
 * A device that cannot run this engine — an unsupported ABI, a build shipped
 * without the native library, a stripped APK — is a device the app should
 * REFUSE on, honestly and per call. It is not a device the app should die on.
 * So the load result is recorded as data, `loadFailure` is the single place
 * that says why, and every caller is expected to check `isAvailable` first.
 *
 * Checking is not optional politeness: with no library loaded, calling any
 * `external fun` below still throws `UnsatisfiedLinkError` at the call site.
 * The gate is what turns that into a message a person can read.
 */
object LlamaBridge {

    private var loadedLibrary: String = ""

    /**
     * Why the engine is unusable, or `null` when it loaded.
     *
     * User-facing: it is handed to `PluginCall.reject` verbatim.
     */
    val loadFailure: String?

    val isAvailable: Boolean get() = loadFailure == null

    /** Which `.so` actually loaded. Empty when none did. */
    val backendLibrary: String get() = loadedLibrary

    init {
        // The runtime picks the variant the device can actually use. A
        // Vulkan-linked library on a device without a conformant driver
        // crashes at load, so each backend ships as its own `.so`.
        //
        // Only the CPU variant is currently built — see `src/main/cpp/
        // CMakeLists.txt`. The other two names stay in the list so that adding
        // a variant is a build-system change alone, and so a device that has
        // one uses it.
        loadFailure = loadFirstAvailable(
            "chatterang-llama-vulkan",
            "chatterang-llama-opencl",
            "chatterang-llama-cpu",
        )
    }

    /** Returns null on success, or a user-facing reason on failure. */
    private fun loadFirstAvailable(vararg names: String): String? {
        val reasons = mutableListOf<String>()
        for (name in names) {
            try {
                System.loadLibrary(name)
                loadedLibrary = name
                return null
            } catch (error: UnsatisfiedLinkError) {
                // Try the next tier down.
                reasons.add("$name: ${error.message ?: "not present"}")
            } catch (error: SecurityException) {
                reasons.add("$name: ${error.message ?: "blocked"}")
            }
        }
        return "On-device inference is not available on this device: no " +
            "llama.cpp backend library could be loaded. Tried " +
            names.joinToString(", ") + ". (" + reasons.joinToString("; ") + ")"
    }

    /**
     * Whether a CPU backend is REGISTERED, asked of ggml like the other three.
     *
     * No `loadedLibrary` suffix test, unlike the two below: every variant links
     * the CPU backend, so the question is only whether the engine came up.
     */
    fun hasCpu(): Boolean = isAvailable && nativeHasCpu()

    fun hasVulkan(): Boolean =
        isAvailable && loadedLibrary.endsWith("vulkan") && nativeHasVulkan()

    fun hasOpenCl(): Boolean =
        isAvailable && loadedLibrary.endsWith("opencl") && nativeHasOpenCl()

    fun hasHexagon(): Boolean = isAvailable && nativeHasHexagon()

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

    /**
     * Chat-template NAME sniffed from the GGUF's own metadata, or `""` when
     * the file carries none this build recognises.
     *
     * The GGUF knows; the caller only guessed from a model id. This mirrors
     * `LlamaContext.templateName(of:)` on iOS, and it is why `LoadResult`'s
     * `chatTemplate` can be documented as "resolved from the GGUF metadata"
     * rather than "echoed back".
     */
    external fun chatTemplate(handle: Long): String

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

    /**
     * The largest resident set this process has been OBSERVED holding, bytes.
     *
     * A running maximum of `VmHWM`, the kernel's own high-water mark — not the
     * current resident size, which is what this read before and which falls
     * the moment a model is unloaded. The maximum is ours to keep because
     * Android resets `VmHWM` underneath us; three resets were measured inside
     * a single `prove-android.sh` run. Process-wide (the WebView is in there
     * too) and process-lifetime, so it is an upper bound on any one request
     * rather than that request's own peak. See `peakFootprint` in
     * `llama-jni.cpp` for the measurements.
     */
    external fun peakFootprint(): Long

    private external fun nativeHasCpu(): Boolean
    private external fun nativeHasVulkan(): Boolean
    private external fun nativeHasOpenCl(): Boolean
    private external fun nativeHasHexagon(): Boolean
}
