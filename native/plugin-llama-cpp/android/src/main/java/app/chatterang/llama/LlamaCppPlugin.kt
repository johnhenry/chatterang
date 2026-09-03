package app.chatterang.llama

import android.app.ActivityManager
import android.content.Context
import android.os.Build
import android.os.PowerManager
import android.util.Log
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
import java.util.concurrent.RejectedExecutionException
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

    /**
     * The only plugin method that reaches the native library on Capacitor's
     * own handler thread, which is why its body is wrapped and the others'
     * are not.
     *
     * `LlamaBridge.loadFailure` answers ONE question — did any `.so` load —
     * and a null answer is not a promise that the library is complete. A
     * library that dlopens but is missing a symbol passes every gate here and
     * then throws `UnsatisfiedLinkError` at the call site. Measured, by
     * renaming `Java_app_chatterang_llama_LlamaBridge_engineVersion` in
     * `llama-jni.cpp` and rebuilding: the `.so` still built, still loaded,
     * `loadFailure` was still null, and the first `getCapabilities` killed the
     * app —
     *
     *     FATAL EXCEPTION: CapacitorPlugins
     *     Caused by: java.lang.UnsatisfiedLinkError: No implementation found
     *       for java.lang.String app.chatterang.llama.LlamaBridge.engineVersion()
     *       at app.chatterang.llama.LlamaCppPlugin.getCapabilities(LlamaCppPlugin.kt:86)
     *
     * — with `prove-android.sh` reporting zero `[PROVE]` lines and no pid.
     * The nine other methods survive the same injection already: five reach
     * native only inside `executor.execute { rejectOnThrow(call) { … } }`,
     * `generate` has its own `catch (Throwable)`, and three touch no native
     * at all. This one was the documented exception to the rule in
     * `LlamaBridge`'s header; now it is not.
     */
    @PluginMethod
    fun getCapabilities(call: PluginCall) {
        rejectOnThrow(call) {
            // Refuse honestly rather than describe an engine that is not
            // there. Every caller of this method in the web layer already
            // treats a rejection as "no on-device inference here"
            // (`src/state/app.ts`, `src/ai/middleware/resilience.ts`,
            // `LlamaCppBackend.healthCheck`), so refusing degrades the app
            // instead of killing it.
            //
            // Inside the guard, not before it: `LlamaBridge` is an `object`,
            // so this read is what runs its `<clinit>` — and a `<clinit>`
            // that threw is the exact crash f5c7c24 fixed.
            val unavailable = LlamaBridge.loadFailure
            if (unavailable != null) {
                call.reject(unavailable, ENGINE_UNAVAILABLE)
                return@rejectOnThrow
            }

            val activityManager =
                context.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
            val memoryInfo = ActivityManager.MemoryInfo().also { activityManager.getMemoryInfo(it) }

            val backends = JSArray(availableBackends())

            // Preferred backend follows the tier order in the PRD: NPU, then
            // GPU, then CPU. The engine still falls back at load time if the
            // chosen backend refuses the model.
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
    }

    /**
     * Guarded despite the one-line body, because the body is not where it
     * dies: `thermalPayload` runs `getSystemService(POWER_SERVICE)` through
     * a Kotlin non-null cast on Capacitor's own handler thread, and that
     * platform call returns null on a stripped or vendor ROM. Measured,
     * after a fully successful `getCapabilities` —
     *
     *     FATAL EXCEPTION: CapacitorPlugins
     *     Caused by: java.lang.NullPointerException: null cannot be cast to
     *       non-null type android.os.PowerManager
     *       at LlamaCppPlugin.thermalPayload(LlamaCppPlugin.kt:132)
     *
     * — the engine up, the plugin killing the app anyway.
     */
    @PluginMethod
    fun getThermalState(call: PluginCall) {
        rejectOnThrow(call) { call.resolve(thermalPayload()) }
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

        // The STATUS is measured. The FLOAT IS NOT.
        //
        // `level` is a fixed presentation mapping of a seven-value OS ordinal
        // onto the contract's 0..1, chosen to land on the same scale points
        // iOS's four-value `ProcessInfo.thermalState` uses so the two
        // platforms drive the same UI. There is no temperature behind 0.88;
        // it is "between severe and critical" written as a number because the
        // contract asks for one. Read it as an ordinal, never as a physical
        // quantity, and never diff two of them for a rate.
        //
        // What it must stay is faithful to the ordinal it came from: one
        // distinct, strictly increasing value per status, which is what the
        // guard in `tests/native-registration.test.ts` holds it to. Collapsing
        // it to a constant would be the invented-value failure this comment
        // exists to prevent.
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

        // The submit is inside the guard, not outside it:
        // `executor.execute` throws `RejectedExecutionException` on the
        // CALLING thread once the executor is shut down, and the
        // `rejectOnThrow` inside the runnable is on the wrong side of a
        // throw that happens before the runnable ever runs.
        rejectOnThrow(call) {
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
    }

    @PluginMethod
    fun unload(call: PluginCall) {
        val id = call.getString("handle")
        if (id == null) {
            call.reject("A handle is required.")
            return
        }

        rejectOnThrow(call) {
            executor.execute {
                rejectOnThrow(call) {
                    contexts.remove(id)?.let { LlamaBridge.freeModel(it) }
                    contextInfo.remove(id)
                    call.resolve()
                }
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

        // Guarded for the same reason as `rejectIfUnavailable`, and refusing
        // rather than rejecting for the reason above: this is the caller
        // thread, and a `<clinit>` failure here would take the process AND
        // leave the stream without its terminal event.
        val unavailable = try {
            LlamaBridge.loadFailure
        } catch (error: Throwable) {
            refuse(describe(error))
            return
        }
        if (unavailable != null) {
            refuse(unavailable)
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

        /*
         * The submit is guarded too, and it REFUSES rather than rejects.
         *
         * `executor.execute` throws `RejectedExecutionException` on THIS
         * thread — Capacitor's — once the executor is shut down, and that
         * throw is downstream of every refusal above: unguarded it takes
         * the process and the stream's terminal event with it. A plain
         * `call.reject` here would trade the crash for a turn that hangs
         * forever, because the adapter resolves its stream on `llamaEnd`.
         * `refuse` is the only exit that still emits exactly one.
         */
        try {
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

                    // DECODE throughput, over the decode window alone.
                    //
                    // This was `completionTokens * 1000.0 / totalMs` — every token
                    // divided by the whole wall clock, prefill included.
                    //
                    // Measured on emulator-5554 with the old formula: a 2-token
                    // answer with ttft 69273 ms inside a 83266 ms total reported
                    // 0.0240 tok/s, where the 13993 ms decode window that produced
                    // the second token is 0.0715 — 3.0x, from the divisor alone.
                    // The verify phase measured the same shape against the other
                    // reading: 0.0867 tok/s from `generate` beside 0.3051 tok/s of
                    // decode from `benchmark`, same model, same run.
                    //
                    // Both numbers reach the UI as "tok/s" — the chat rail's
                    // readout and the bench screen's "Generation" stat — so the
                    // disagreement reads as a regression in the engine.
                    //
                    // The first token is produced BY prefill and arrives at
                    // `ttftMs`, so the decode window is what follows it and
                    // carries `completionTokens - 1` tokens. Below two completion
                    // tokens there is no decode window at all, and 0.0 says so
                    // rather than inventing a rate from one prefill.
                    val decodeMs = max(1L, totalMs - ttftMs)
                    val decodedTokens = result.completionTokens - 1
                    val tokensPerSecond =
                        if (decodedTokens > 0) decodedTokens * 1000.0 / decodeMs else 0.0

                    val payload = JSObject()
                        .put("requestId", requestId)
                        .put("text", result.text)
                        .put("promptTokens", result.promptTokens)
                        .put("cachedTokens", result.cachedTokens)
                        .put("completionTokens", result.completionTokens)
                        .put("ttftMs", ttftMs)
                        .put("totalMs", totalMs)
                        .put("tokensPerSecond", tokensPerSecond)
                        .put(
                            "stopReason",
                            if (cancelled.contains(requestId)) "cancelled" else result.stopReason,
                        )
                        .put("peakMemoryBytes", LlamaBridge.peakFootprint())

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
        } catch (error: Throwable) {
            refuse(describe(error))
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
                    .put("peakMemoryBytes", LlamaBridge.peakFootprint())
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
        rejectOnThrow(call) {
            executor.execute { rejectOnThrow(call) { body(handle) } }
        }
    }

    /**
     * Turns anything thrown into a rejection, on the worker thread and on
     * Capacitor's own.
     *
     * Two failures at once without it on the worker: the call never settles,
     * so the promise in the web layer hangs forever; and the exception escapes
     * a plain `Executor` worker, which kills the single thread every later
     * call is queued on. On the Capacitor handler thread the cost is higher
     * still — `Bridge.callPluginMethod` rethrows as an uncaught
     * `RuntimeException` and the process dies.
     *
     * `Throwable`, not `Exception`, deliberately: the failures worth catching
     * here are `Error`s. See `rejectThrown`.
     *
     * `inline` so `return@execute` inside `body` still means what it reads as.
     */
    private inline fun rejectOnThrow(call: PluginCall, body: () -> Unit) {
        try {
            body()
        } catch (error: Throwable) {
            rejectThrown(call, error)
        }
    }

    /**
     * Rejects with the honest cause, and names a broken native surface as one.
     *
     * `LinkageError` is the family that means the `.so` and the `external fun`
     * declarations in `LlamaBridge` disagree: `UnsatisfiedLinkError` for a
     * missing JNI symbol, `NoSuchMethodError` / `NoSuchFieldError` for a Java
     * member the C++ looks up by name and no longer finds,
     * `ExceptionInInitializerError` for a class that failed to initialise. It
     * is exactly as fatal to this engine as "no library loaded at all" and
     * gets the same code, so the web layer's existing `ENGINE_UNAVAILABLE`
     * handling covers it without a new branch.
     *
     * `error as? Exception` is null for every `Error`, which is why the raw
     * text is folded into the message rather than left to the cause slot.
     */
    private fun rejectThrown(call: PluginCall, error: Throwable) {
        if (error is LinkageError) {
            call.reject(describe(error), ENGINE_UNAVAILABLE)
            return
        }
        call.reject(describe(error), error as? Exception)
    }

    /** The user-facing sentence for a thrown failure. See `rejectThrown`. */
    private fun describe(error: Throwable): String =
        if (error is LinkageError) {
            "On-device inference is not available on this device: the llama.cpp backend " +
                "library loaded, but this app could not call into it. (" +
                (error.message ?: error.javaClass.name) + ")"
        } else {
            error.message ?: "The engine call failed."
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
     * Asked of the engine, not asserted: every entry queries the ggml backend
     * registry, so this list shrinks and grows with what was actually linked
     * in. `cpu` used to be an unconditional `add("cpu")` — the one element a
     * stub and a working engine produced identically, and so the one element
     * that said nothing. It is a registry question now like the rest.
     *
     * An empty list is therefore possible, and it means what it says: the
     * engine registered no backend at all.
     */
    private fun availableBackends(): List<String> = buildList {
        if (LlamaBridge.hasCpu()) add("cpu")
        if (LlamaBridge.hasOpenCl()) add("gpu-opencl")
        if (LlamaBridge.hasVulkan()) add("gpu-vulkan")
        if (LlamaBridge.hasHexagon()) add("npu-hexagon")
    }

    private fun rejectIfUnavailable(call: PluginCall): Boolean {
        // The `try` is around the READ, because reading it is what runs
        // `LlamaBridge`'s `<clinit>`. This runs on Capacitor's handler thread
        // — `load` and `withHandle` both call it before handing off to the
        // executor — so an `Error` escaping here is a process kill, which is
        // the crash f5c7c24 fixed. The init block does not throw today; this
        // is what stops a future one from being fatal again.
        val reason = try {
            LlamaBridge.loadFailure
        } catch (error: Throwable) {
            rejectThrown(call, error)
            return true
        } ?: return false
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

        /** Matches the JNI's `LOG_TAG`, so one logcat filter shows both sides. */
        const val TAG = "chatterang-llama"
    }

    /**
     * Frees every loaded context without letting the teardown kill the app.
     *
     * Two escape routes here, and neither has a `PluginCall` to reject to.
     *
     * `LlamaBridge.freeModel` is a native call like any other, so the
     * broken-symbol failure `getCapabilities` documents reaches it too — and
     * an exception that escapes a plain `Executor`'s runnable goes to the
     * thread's default uncaught handler, which is a process kill. Dying while
     * being destroyed still shows the user a crash dialog.
     *
     * And `executor.execute` on an executor that has already been shut down
     * throws `RejectedExecutionException` — on the MAIN thread, inside
     * `onDestroy`. Capacitor calls `handleOnDestroy` once per plugin
     * lifecycle, but an activity recreated after a configuration change or a
     * process-death restore does not owe us only-once.
     *
     * So both are swallowed on purpose, and the swallow is logged rather than
     * silent. Nothing is left to tell: the app is going away, and a handle
     * leaked out of a dying process costs nothing. `contexts` is still cleared
     * in a `finally` so a failed free cannot leave a stale handle behind for a
     * plugin instance that outlives it.
     */
    override fun handleOnDestroy() {
        try {
            executor.execute {
                try {
                    contexts.values.forEach { LlamaBridge.freeModel(it) }
                } catch (error: Throwable) {
                    Log.w(TAG, "A llama.cpp context could not be freed during teardown.", error)
                } finally {
                    contexts.clear()
                    contextInfo.clear()
                }
            }
        } catch (error: RejectedExecutionException) {
            Log.w(TAG, "The engine executor was already shut down at teardown.", error)
        } finally {
            executor.shutdown()
        }
    }
}
