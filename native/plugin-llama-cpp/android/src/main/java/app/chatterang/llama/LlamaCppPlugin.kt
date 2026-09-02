package app.chatterang.llama

import android.app.ActivityManager
import android.content.Context
import android.os.Build
import android.os.PowerManager
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import java.io.File
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import kotlin.math.max

/**
 * Capacitor bridge for the llama.cpp engine on Android (PRD §5, Phase 1).
 *
 * Mirrors the iOS plugin exactly, because the whole architecture depends on
 * one adapter above it seeing identical behaviour from both platforms.
 */
@CapacitorPlugin(name = "LlamaCpp")
class LlamaCppPlugin : Plugin() {

    /**
     * Single-threaded: llama.cpp contexts are not safe to use concurrently,
     * and serialising here is simpler than locking inside the JNI layer.
     */
    private val executor = Executors.newSingleThreadExecutor { runnable ->
        Thread(runnable, "chatterang-llama").apply { priority = Thread.MAX_PRIORITY }
    }

    private val contexts = ConcurrentHashMap<String, Long>()
    private val contextInfo = ConcurrentHashMap<String, LoadedInfo>()
    private val cancelled = java.util.Collections.synchronizedSet(mutableSetOf<String>())

    private data class LoadedInfo(
        val backend: String,
        val contextLength: Int,
        val supportsVision: Boolean,
        val chatTemplate: String,
    )

    // ── Capabilities ────────────────────────────────────────────────────

    @PluginMethod
    fun getCapabilities(call: PluginCall) {
        // Refuse honestly rather than describe an engine that is not there.
        // Every caller of this method in the web layer already treats a
        // rejection as "no on-device inference here" (`src/state/app.ts`,
        // `src/ai/middleware/resilience.ts`, `LlamaCppBackend.healthCheck`),
        // so refusing degrades the app instead of killing it.
        val unavailable = LlamaBridge.loadFailure
        if (unavailable != null) {
            call.reject(unavailable, ENGINE_UNAVAILABLE)
            return
        }

        val activityManager = context.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
        val memoryInfo = ActivityManager.MemoryInfo().also { activityManager.getMemoryInfo(it) }

        val backends = JSArray(availableBackends())

        // Preferred backend follows the tier order in the PRD: NPU, then GPU,
        // then CPU. The engine still falls back at load time if the chosen
        // backend refuses the model.
        val preferred = when {
            LlamaBridge.hasHexagon() -> "npu-hexagon"
            LlamaBridge.hasVulkan() -> "gpu-vulkan"
            LlamaBridge.hasOpenCl() -> "gpu-opencl"
            else -> "cpu"
        }

        call.resolve(
            JSObject()
                .put("totalMemory", memoryInfo.totalMem)
                .put("availableMemory", memoryInfo.availMem)
                .put("backends", backends)
                .put("preferredBackend", preferred)
                .put("cpuCores", Runtime.getRuntime().availableProcessors())
                .put("chipset", chipset())
                .put("simulated", false)
                .put("engineVersion", LlamaBridge.engineVersion()),
        )
    }

    @PluginMethod
    fun getThermalState(call: PluginCall) {
        call.resolve(thermalPayload())
    }

    private fun thermalPayload(): JSObject {
        val power = context.getSystemService(Context.POWER_SERVICE) as PowerManager

        // `currentThermalStatus` needs API 29; below that the app assumes
        // nominal rather than guessing from CPU temperature files, which vary
        // wildly between vendors and are frequently wrong.
        val status = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            power.currentThermalStatus
        } else {
            PowerManager.THERMAL_STATUS_NONE
        }

        val (level, name) = when (status) {
            PowerManager.THERMAL_STATUS_NONE -> 0.10 to "nominal"
            PowerManager.THERMAL_STATUS_LIGHT -> 0.30 to "nominal"
            PowerManager.THERMAL_STATUS_MODERATE -> 0.50 to "fair"
            PowerManager.THERMAL_STATUS_SEVERE -> 0.75 to "serious"
            PowerManager.THERMAL_STATUS_CRITICAL -> 0.88 to "serious"
            else -> 0.97 to "critical"
        }

        return JSObject()
            .put("level", level)
            .put("state", name)
            .put("throttled", status >= PowerManager.THERMAL_STATUS_SEVERE)
    }

    // ── Lifecycle ───────────────────────────────────────────────────────

    @PluginMethod
    fun load(call: PluginCall) {
        if (rejectIfUnavailable(call)) return

        val modelPath = call.getString("modelPath")
        if (modelPath.isNullOrBlank()) {
            call.reject("A model path is required.")
            return
        }

        executor.execute {
            rejectOnThrow(call) {
                val started = System.currentTimeMillis()
                val warnings = JSArray()

                val file = File(stripFileScheme(modelPath))
                if (!file.exists()) {
                    call.reject("The model file is missing. Try downloading it again.")
                    return@execute
                }

                val contextLength = call.getInt("contextLength") ?: 4096
                val threads = call.getInt("threads")
                    ?: max(2, Runtime.getRuntime().availableProcessors() - 2)

                /*
                 * Clamp the request to what this build actually has, and say
                 * so — rather than attempting a GPU load that cannot succeed
                 * and then reporting "the GPU could not load this model",
                 * which names the wrong cause. Only the CPU variant is built
                 * (`src/main/cpp/CMakeLists.txt` says why), so on this build
                 * `available` is `[cpu]` and every request lands here.
                 */
                val requested = call.getString("backend") ?: "gpu-vulkan"
                val available = availableBackends()
                var backend = requested
                if (requested !in available) {
                    warnings.put(
                        "This build has no $requested backend, so the model is running on the " +
                            "CPU. Expect it to be slower.",
                    )
                    backend = "cpu"
                }

                // Neither is compiled in — `LLAMA_BUILD_MTMD` is OFF and no
                // draft path exists — and the native side ignores both. A
                // caller that asked for them is told, because a silently
                // dropped capability reads as a broken model.
                if (!call.getString("mmprojPath").isNullOrBlank()) {
                    warnings.put(
                        "This build has no vision support, so any images in this conversation " +
                            "will be ignored.",
                    )
                }
                if (!call.getString("draftModelPath").isNullOrBlank()) {
                    warnings.put(
                        "This build has no speculative decoding, so the draft model is unused.",
                    )
                }

                var handle = LlamaBridge.loadModel(
                    file.absolutePath,
                    call.getString("mmprojPath")?.let { stripFileScheme(it) },
                    call.getString("draftModelPath")?.let { stripFileScheme(it) },
                    contextLength,
                    call.getInt("gpuLayers") ?: -1,
                    backend,
                    threads,
                    call.getBoolean("useMmap") ?: true,
                )

                // Hardware-tiered fallback (PRD §3.1): a GPU that refuses the
                // model degrades to CPU rather than failing outright. Reached
                // only when a GPU backend is actually compiled in — otherwise
                // the clamp above already chose CPU, and retrying CPU after
                // CPU would just fail twice and blame the GPU for it.
                if (handle == 0L && backend != "cpu") {
                    warnings.put(
                        "The GPU could not load this model, so it is running on the CPU. Expect it to be slower.",
                    )
                    backend = "cpu"
                    handle = LlamaBridge.loadModel(
                        file.absolutePath,
                        call.getString("mmprojPath")?.let { stripFileScheme(it) },
                        null,
                        contextLength,
                        0,
                        backend,
                        threads,
                        call.getBoolean("useMmap") ?: true,
                    )
                }

                if (handle == 0L) {
                    call.reject(
                        "This model could not be loaded. It may be incomplete, or too large for this device.",
                    )
                    return@execute
                }

                val id = UUID.randomUUID().toString()
                val actualContext = LlamaBridge.contextLength(handle)
                if (actualContext < contextLength) {
                    warnings.put("The context was reduced to $actualContext tokens to fit in memory.")
                }

                /*
                 * The GGUF's own template beats the caller's guess: the caller
                 * chose by model id, the file knows. llama.cpp hands back the
                 * raw Jinja body rather than a name, so the native side sniffs
                 * the family from its markers — a heuristic, which is why it
                 * returns "" when it recognises nothing and the caller's value
                 * remains the fallback.
                 */
                val sniffed = LlamaBridge.chatTemplate(handle).ifBlank { null }
                val info = LoadedInfo(
                    backend = backend,
                    contextLength = actualContext,
                    supportsVision = LlamaBridge.supportsVision(handle),
                    chatTemplate = sniffed ?: call.getString("chatTemplate") ?: "chatml",
                )

                /*
                 * Does the chosen template's vocabulary actually exist in this
                 * model?
                 *
                 * A control marker the model knows tokenizes to exactly ONE
                 * token. If not one of the template's markers does, the
                 * template belongs to a different model family and every turn
                 * is rendered in a language this model cannot read — the
                 * symptom is incoherent output, which reads as a broken model
                 * rather than a wrong template.
                 *
                 * A warning, not a refusal, matching `packages/inference-node`
                 * and iOS: some templates legitimately use plain-text markers,
                 * and one wrong guess should not make a model unloadable.
                 */
                val markers = call.getArray("templateMarkers")
                    ?.toList<String>()
                    ?.filter { it.isNotEmpty() }
                    ?: emptyList()
                if (markers.isNotEmpty() &&
                    markers.none { LlamaBridge.tokenize(handle, it).size == 1 }
                ) {
                    warnings.put(
                        "The \"${info.chatTemplate}\" chat template does not match this model: " +
                            "none of its markers (${markers.joinToString(", ")}) exist in its " +
                            "vocabulary, so they will be sent as ordinary text. Expect incoherent " +
                            "output until the template is changed.",
                    )
                }

                contexts[id] = handle
                contextInfo[id] = info

                call.resolve(
                    JSObject()
                        .put("handle", id)
                        .put("backend", info.backend)
                        .put("contextLength", info.contextLength)
                        .put("loadMs", System.currentTimeMillis() - started)
                        .put("warnings", warnings)
                        .put("supportsVision", info.supportsVision)
                        .put("chatTemplate", info.chatTemplate),
                )
            }
        }
    }

    @PluginMethod
    fun unload(call: PluginCall) {
        val id = call.getString("handle")
        if (id == null) {
            call.reject("A handle is required.")
            return
        }

        executor.execute {
            rejectOnThrow(call) {
                contexts.remove(id)?.let { LlamaBridge.freeModel(it) }
                contextInfo.remove(id)
                call.resolve()
            }
        }
    }

    @PluginMethod
    fun listLoaded(call: PluginCall) {
        call.resolve(JSObject().put("handles", JSArray(contexts.keys.toList())))
    }

    // ── Generation ──────────────────────────────────────────────────────

    @PluginMethod
    fun generate(call: PluginCall) {
        val requestId = call.getString("requestId")
        if (requestId == null) {
            // No requestId means no stream anyone could be listening to, so a
            // plain rejection is the whole of the contract here.
            call.reject("handle, prompt, and requestId are required.")
            return
        }

        /*
         * From here on a `requestId` exists, so EVERY exit owes it exactly one
         * `llamaEnd` — including the early refusals.
         *
         * This is where the rule is easiest to break and hardest to see. The
         * adapter in `src/ai/backends/llama-cpp.ts` resolves its stream on the
         * terminal event, so a rejection without one leaves the turn pending
         * forever: the promise rejects, the stream never ends, and the UI sits
         * on a spinner. `prove-android.sh` counts the events per requestId
         * precisely because the failure is invisible from the inside — it
         * caught this exact path returning zero.
         */
        fun refuse(message: String) {
            val payload = JSObject()
                .put("requestId", requestId)
                .put("text", "")
                .put("stopReason", "error")
                .put("error", message)
            notifyListeners("llamaEnd", payload)
            call.reject(message, payload)
        }

        LlamaBridge.loadFailure?.let {
            refuse(it)
            return
        }

        val id = call.getString("handle")
        val prompt = call.getString("prompt")
        if (id == null || prompt == null) {
            refuse("handle, prompt, and requestId are required.")
            return
        }

        val handle = contexts[id]
        if (handle == null) {
            refuse("No model is loaded for that handle.")
            return
        }

        val sampler = call.getObject("sampler") ?: JSObject()
        val images = call.getArray("images")?.toList<JSObject>()?.mapNotNull {
            it.getString("data")
        } ?: emptyList()

        cancelled.remove(requestId)

        executor.execute {
            val started = System.currentTimeMillis()
            var firstTokenAt = 0L
            var index = 0
            val text = StringBuilder()

            /*
             * EXACTLY ONE terminal event per request, on success, error and
             * cancel alike — the rule `packages/inference-node` and the iOS
             * plugin both enforce, because the web adapter
             * (`src/ai/backends/llama-cpp.ts`) resolves its stream on
             * `llamaEnd` and a second one settles an already-settled turn
             * while a missing one hangs it forever.
             *
             * `settled` makes `finish` idempotent, and `finish` is called from
             * the success path, from the catch, and once more from `finally`
             * as a backstop — so a future edit that adds a fourth exit cannot
             * quietly break the guarantee. It mirrors
             * `LlamaCppPlugin.swift`'s `finish`/`defer` pair exactly.
             */
            var settled = false
            fun finish(payload: JSObject): JSObject {
                if (!settled) {
                    settled = true
                    notifyListeners("llamaEnd", payload)
                }
                return payload
            }

            try {
                val result = LlamaBridge.generate(
                    handle,
                    prompt,
                    images.toTypedArray(),
                    sampler.optDouble("temperature", 0.7).toFloat(),
                    sampler.optDouble("topP", 0.95).toFloat(),
                    sampler.optInt("topK", 40),
                    sampler.optDouble("minP", 0.05).toFloat(),
                    sampler.optDouble("repeatPenalty", 1.1).toFloat(),
                    sampler.optInt("repeatLastN", 64),
                    sampler.optDouble("frequencyPenalty", 0.0).toFloat(),
                    sampler.optDouble("presencePenalty", 0.0).toFloat(),
                    sampler.optInt("maxTokens", 1024),
                    sampler.optInt("seed", -1),
                    sampler.optJSONArray("stopSequences")?.let { array ->
                        Array(array.length()) { array.getString(it) }
                    } ?: emptyArray(),
                    sampler.optInt("draftTokens", 5),
                    object : LlamaBridge.TokenCallback {
                        override fun onToken(token: String): Boolean {
                            if (firstTokenAt == 0L) firstTokenAt = System.currentTimeMillis()
                            text.append(token)
                            notifyListeners(
                                "llamaToken",
                                JSObject()
                                    .put("requestId", requestId)
                                    .put("token", token)
                                    .put("index", index++),
                            )
                            // Returning false asks the native loop to stop —
                            // cheaper than polling a flag from C++.
                            return !cancelled.contains(requestId)
                        }
                    },
                )

                val totalMs = max(1L, System.currentTimeMillis() - started)
                val ttftMs = if (firstTokenAt > 0) firstTokenAt - started else totalMs

                val payload = JSObject()
                    .put("requestId", requestId)
                    .put("text", result.text)
                    .put("promptTokens", result.promptTokens)
                    .put("cachedTokens", result.cachedTokens)
                    .put("completionTokens", result.completionTokens)
                    .put("ttftMs", ttftMs)
                    .put("totalMs", totalMs)
                    .put("tokensPerSecond", result.completionTokens * 1000.0 / totalMs)
                    .put(
                        "stopReason",
                        if (cancelled.contains(requestId)) "cancelled" else result.stopReason,
                    )
                    .put("peakMemoryBytes", LlamaBridge.footprint())

                if (result.draftAcceptance >= 0) {
                    payload.put("draftAcceptance", result.draftAcceptance)
                }

                call.resolve(finish(payload))
            } catch (error: Throwable) {
                // Throwable, not Exception: an `UnsatisfiedLinkError` or an
                // `OutOfMemoryError` from the JNI layer is exactly the case
                // that must become a rejection rather than a dead thread.
                val message = error.message ?: "Generation failed."
                val payload = finish(
                    JSObject()
                        .put("requestId", requestId)
                        .put("text", text.toString())
                        .put("stopReason", "error")
                        .put("error", message),
                )
                // `PluginCall.reject` has no `Throwable` overload — only
                // (String), (String, String), (String, Exception),
                // (String, JSObject) and wider. Passing a `Throwable` here did
                // not compile, which is why this file had never been built.
                call.reject(message, null, error as? Exception, payload)
            } finally {
                // Backstop. A no-op on both paths above, and the reason a new
                // early return cannot break the terminal-event rule by
                // accident.
                finish(
                    JSObject()
                        .put("requestId", requestId)
                        .put("text", text.toString())
                        .put("stopReason", "error")
                        .put("error", "Generation ended without reporting a result."),
                )
                cancelled.remove(requestId)
            }
        }
    }

    @PluginMethod
    fun cancel(call: PluginCall) {
        val requestId = call.getString("requestId")
        if (requestId == null) {
            call.reject("A requestId is required.")
            return
        }
        cancelled.add(requestId)
        call.resolve()
    }

    // ── Tokenisation ────────────────────────────────────────────────────

    @PluginMethod
    fun tokenize(call: PluginCall) {
        withHandle(call) { handle ->
            val tokens = LlamaBridge.tokenize(handle, call.getString("text") ?: "")
            call.resolve(JSObject().put("tokens", JSArray(tokens.toList())))
        }
    }

    @PluginMethod
    fun countTokens(call: PluginCall) {
        withHandle(call) { handle ->
            call.resolve(
                JSObject().put("count", LlamaBridge.tokenize(handle, call.getString("text") ?: "").size),
            )
        }
    }

    // ── Benchmark ───────────────────────────────────────────────────────

    @PluginMethod
    fun benchmark(call: PluginCall) {
        withHandle(call) { handle ->
            val promptTokens = call.getInt("promptTokens") ?: 512
            val generateTokens = call.getInt("generateTokens") ?: 128
            val repetitions = max(1, call.getInt("repetitions") ?: 3)

            val before = thermalPayload()
            val prefill = mutableListOf<Double>()
            val decode = mutableListOf<Double>()

            repeat(repetitions) {
                val measurement = LlamaBridge.benchmark(handle, promptTokens, generateTokens)
                prefill.add(measurement.promptTokensPerSecond)
                decode.add(measurement.generateTokensPerSecond)
            }

            val id = call.getString("handle")
            call.resolve(
                JSObject()
                    .put("promptTokensPerSecond", prefill.average())
                    .put("generateTokensPerSecond", decode.average())
                    .put("peakMemoryBytes", LlamaBridge.footprint())
                    .put("thermalBefore", before)
                    .put("thermalAfter", thermalPayload())
                    .put("backend", contextInfo[id]?.backend ?: "cpu")
                    .put("repetitions", repetitions)
                    .put("samples", JSArray(decode)),
            )
        }
    }

    // ── Helpers ─────────────────────────────────────────────────────────

    private fun withHandle(call: PluginCall, body: (Long) -> Unit) {
        if (rejectIfUnavailable(call)) return

        val handle = call.getString("handle")?.let { contexts[it] }
        if (handle == null) {
            call.reject("No model is loaded for that handle.")
            return
        }
        executor.execute { rejectOnThrow(call) { body(handle) } }
    }

    /**
     * Turns anything thrown on the worker thread into a rejection.
     *
     * Two failures at once without it: the call never settles, so the promise
     * in the web layer hangs forever; and the exception escapes a plain
     * `Executor` worker, which kills the single thread every later call is
     * queued on.
     *
     * `inline` so `return@execute` inside `body` still means what it reads as.
     */
    private inline fun rejectOnThrow(call: PluginCall, body: () -> Unit) {
        try {
            body()
        } catch (error: Throwable) {
            call.reject(error.message ?: "The engine call failed.", error as? Exception)
        }
    }

    /**
     * Rejects with the honest reason when there is no engine, and reports
     * whether it did.
     *
     * Every method that reaches `LlamaBridge`'s `external fun`s goes through
     * this or through `getCapabilities`' own check. Without a gate the call
     * still fails — `System.loadLibrary` never ran, so the method has no
     * implementation — but it fails as an `UnsatisfiedLinkError`, which
     * Capacitor turns into a process kill (see `LlamaBridge`'s header).
     */
    /**
     * Backends this build was compiled with AND this device supports.
     *
     * Asked of the engine, not asserted: `nativeHasVulkan` and friends query
     * the ggml backend registry, so this list shrinks and grows with what was
     * actually linked in.
     */
    private fun availableBackends(): List<String> = buildList {
        add("cpu")
        if (LlamaBridge.hasOpenCl()) add("gpu-opencl")
        if (LlamaBridge.hasVulkan()) add("gpu-vulkan")
        if (LlamaBridge.hasHexagon()) add("npu-hexagon")
    }

    private fun rejectIfUnavailable(call: PluginCall): Boolean {
        val reason = LlamaBridge.loadFailure ?: return false
        call.reject(reason, ENGINE_UNAVAILABLE)
        return true
    }

    /**
     * `Build.SOC_MODEL` is API 31. Capacitor's `minSdkVersion` is 24, so
     * touching it unguarded is a `NoSuchFieldError` on anything older — and by
     * the rule in `LlamaBridge`'s header, an `Error` out of a plugin method is
     * a process kill. `Build.HARDWARE` has existed since API 1 and is the
     * honest answer when the SoC name is not available.
     */
    private fun chipset(): String {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            val soc = Build.SOC_MODEL
            if (soc != Build.UNKNOWN) return soc
        }
        return Build.HARDWARE
    }

    /** The web layer stores paths as `file://` URIs from `Filesystem.getUri`. */
    private fun stripFileScheme(value: String): String =
        if (value.startsWith("file://")) value.removePrefix("file://") else value

    private companion object {
        /** Error code the web layer can match on, distinct from a load failure. */
        const val ENGINE_UNAVAILABLE = "ENGINE_UNAVAILABLE"
    }

    override fun handleOnDestroy() {
        executor.execute {
            contexts.values.forEach { LlamaBridge.freeModel(it) }
            contexts.clear()
            contextInfo.clear()
        }
        executor.shutdown()
    }
}
