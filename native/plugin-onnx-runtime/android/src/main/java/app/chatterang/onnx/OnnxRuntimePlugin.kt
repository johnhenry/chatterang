package app.chatterang.onnx

import android.app.ActivityManager
import android.content.ComponentCallbacks2
import android.content.Context
import android.util.Base64
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import kotlin.math.max

/**
 * Capacitor bridge for ONNX Runtime on Android (PRD §5, Phase 1).
 *
 * Mirrors the iOS plugin. Speech and diffusion run on separate executors so a
 * long image generation cannot block dictation, which the user expects to
 * respond immediately.
 */
@CapacitorPlugin(name = "OnnxRuntime")
class OnnxRuntimePlugin : Plugin(), ComponentCallbacks2 {

    private val speechExecutor = Executors.newSingleThreadExecutor { Thread(it, "chatterang-onnx-speech") }
    private val diffusionExecutor = Executors.newSingleThreadExecutor { Thread(it, "chatterang-onnx-diffusion") }

    private val sessions = ConcurrentHashMap<String, OnnxSession>()
    private val cancelled = java.util.Collections.synchronizedSet(mutableSetOf<String>())

    override fun load() {
        context.registerComponentCallbacks(this)
    }

    override fun handleOnDestroy() {
        context.unregisterComponentCallbacks(this)
        sessions.values.forEach { it.close() }
        sessions.clear()
        speechExecutor.shutdown()
        diffusionExecutor.shutdown()
    }

    /**
     * Diffusion sessions are dropped as soon as the system asks for memory.
     * Holding a UNet resident through a trim request is the fastest way to be
     * killed mid-generation.
     */
    override fun onTrimMemory(level: Int) {
        if (level < ComponentCallbacks2.TRIM_MEMORY_RUNNING_LOW) return
        sessions.entries.removeAll { (_, session) ->
            if (session.task == "diffusion") {
                session.close()
                true
            } else {
                false
            }
        }
    }

    override fun onLowMemory() = onTrimMemory(ComponentCallbacks2.TRIM_MEMORY_COMPLETE)

    override fun onConfigurationChanged(newConfig: android.content.res.Configuration) = Unit

    // ── Providers ───────────────────────────────────────────────────────

    @PluginMethod
    fun getExecutionProviders(call: PluginCall) {
        val providers = JSArray().apply {
            if (OnnxSession.nnapiAvailable(context)) put("nnapi")
            put("xnnpack")
            put("cpu")
        }

        call.resolve(
            JSObject()
                .put("providers", providers)
                .put("preferred", providers.getString(0))
                .put("simulated", false),
        )
    }

    // ── Sessions ────────────────────────────────────────────────────────

    @PluginMethod
    fun createSession(call: PluginCall) {
        val task = call.getString("task")
        val modelPath = call.getString("modelPath")

        if (task == null || modelPath == null) {
            call.reject("task and modelPath are required.")
            return
        }

        // A diffusion session on a low-RAM device is a guaranteed kill; refuse
        // it here rather than allocating and being terminated (PRD §6).
        val activityManager = context.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
        if (task == "diffusion" && activityManager.isLowRamDevice) {
            call.reject("This device does not have enough memory for image generation.")
            return
        }

        val executor = if (task == "diffusion") diffusionExecutor else speechExecutor

        executor.execute {
            val started = System.currentTimeMillis()
            try {
                val companions = call.getObject("companions")?.let { obj ->
                    obj.keys().asSequence().associateWith { key -> stripFileScheme(obj.getString(key) ?: "") }
                } ?: emptyMap()

                val session = OnnxSession.create(
                    context = context,
                    task = task,
                    modelPath = stripFileScheme(modelPath),
                    companions = companions,
                    executionProvider = call.getString("executionProvider"),
                    threads = call.getInt("threads")
                        ?: max(2, Runtime.getRuntime().availableProcessors() - 2),
                )

                val handle = UUID.randomUUID().toString()
                sessions[handle] = session

                call.resolve(
                    JSObject()
                        .put("handle", handle)
                        .put("task", task)
                        .put("executionProvider", session.activeProvider)
                        .put("loadMs", System.currentTimeMillis() - started)
                        .put("warnings", JSArray(session.warnings)),
                )
            } catch (error: Throwable) {
                call.reject(error.message ?: "The model could not be loaded.", error)
            }
        }
    }

    @PluginMethod
    fun releaseSession(call: PluginCall) {
        call.getString("handle")?.let { sessions.remove(it)?.close() }
        call.resolve()
    }

    @PluginMethod
    fun releaseTask(call: PluginCall) {
        val task = call.getString("task")
        sessions.entries.removeAll { (_, session) ->
            if (session.task == task) {
                session.close()
                true
            } else {
                false
            }
        }
        call.resolve()
    }

    // ── Speech to text ──────────────────────────────────────────────────

    @PluginMethod
    fun transcribe(call: PluginCall) {
        val requestId = call.getString("requestId")
        val audioBase64 = call.getString("audio")

        if (requestId == null || audioBase64 == null) {
            call.reject("requestId and audio are required.")
            return
        }

        withSession(call, speechExecutor) { session ->
            val started = System.currentTimeMillis()
            val streamPartials = call.getBoolean("streamPartials") ?: false

            val transcript = session.transcribe(
                audio = Base64.decode(audioBase64, Base64.DEFAULT),
                language = call.getString("language"),
                onPartial = { partial ->
                    if (streamPartials) {
                        notifyListeners(
                            "onnxPartial",
                            JSObject().put("requestId", requestId).put("text", partial),
                        )
                    }
                },
                shouldStop = { cancelled.contains(requestId) },
            )

            val segments = JSArray()
            transcript.segments.forEach {
                segments.put(
                    JSObject().put("start", it.start).put("end", it.end).put("text", it.text),
                )
            }

            call.resolve(
                JSObject()
                    .put("requestId", requestId)
                    .put("text", transcript.text)
                    .put("language", transcript.language)
                    .put("durationMs", System.currentTimeMillis() - started)
                    .put("segments", segments),
            )
        }
    }

    // ── Text to speech ──────────────────────────────────────────────────

    @PluginMethod
    fun synthesize(call: PluginCall) {
        val requestId = call.getString("requestId")
        val text = call.getString("text")

        if (requestId == null || text == null) {
            call.reject("requestId and text are required.")
            return
        }

        withSession(call, speechExecutor) { session ->
            val started = System.currentTimeMillis()
            val audio = session.synthesize(
                text = text,
                voice = call.getString("voice"),
                rate = call.getDouble("rate")?.toFloat() ?: 1f,
                pitch = call.getDouble("pitch")?.toFloat() ?: 1f,
            )

            call.resolve(
                JSObject()
                    .put("requestId", requestId)
                    .put("audio", Base64.encodeToString(audio.wav, Base64.NO_WRAP))
                    .put("mediaType", "audio/wav")
                    .put("sampleRate", audio.sampleRate)
                    .put("durationMs", System.currentTimeMillis() - started),
            )
        }
    }

    // ── Image generation ────────────────────────────────────────────────

    @PluginMethod
    fun diffuse(call: PluginCall) {
        val requestId = call.getString("requestId")
        val prompt = call.getString("prompt")

        if (requestId == null || prompt == null) {
            call.reject("requestId and prompt are required.")
            return
        }

        withSession(call, diffusionExecutor) { session ->
            val started = System.currentTimeMillis()
            val steps = call.getInt("steps") ?: 4
            val seed = call.getInt("seed")?.toLong() ?: kotlin.random.Random.nextLong(0, Long.MAX_VALUE)

            val image = session.diffuse(
                prompt = prompt,
                negativePrompt = call.getString("negativePrompt"),
                steps = steps,
                guidanceScale = call.getDouble("guidanceScale")?.toFloat() ?: 1f,
                width = call.getInt("width") ?: 512,
                height = call.getInt("height") ?: 512,
                seed = seed,
                onStep = { step, preview ->
                    val payload = JSObject()
                        .put("requestId", requestId)
                        .put("step", step)
                        .put("totalSteps", steps)
                    if (preview != null) {
                        payload.put("preview", Base64.encodeToString(preview, Base64.NO_WRAP))
                    }
                    notifyListeners("onnxProgress", payload)
                },
                shouldStop = { cancelled.contains(requestId) },
            )

            call.resolve(
                JSObject()
                    .put("requestId", requestId)
                    .put("image", Base64.encodeToString(image.png, Base64.NO_WRAP))
                    .put("mediaType", "image/png")
                    .put("width", image.width)
                    .put("height", image.height)
                    .put("steps", steps)
                    .put("seed", seed)
                    .put("durationMs", System.currentTimeMillis() - started)
                    .put("peakMemoryBytes", image.peakMemoryBytes),
            )
        }
    }

    @PluginMethod
    fun cancel(call: PluginCall) {
        call.getString("requestId")?.let { cancelled.add(it) }
        call.resolve()
    }

    // ── Helpers ─────────────────────────────────────────────────────────

    private fun withSession(
        call: PluginCall,
        executor: java.util.concurrent.ExecutorService,
        body: (OnnxSession) -> Unit,
    ) {
        val session = call.getString("handle")?.let { sessions[it] }
        if (session == null) {
            call.reject(
                "That session is no longer loaded. It may have been released under memory pressure.",
            )
            return
        }

        call.getString("requestId")?.let { cancelled.remove(it) }

        executor.execute {
            try {
                body(session)
            } catch (error: Throwable) {
                call.reject(error.message ?: "The operation failed.", error)
            } finally {
                call.getString("requestId")?.let { cancelled.remove(it) }
            }
        }
    }

    private fun stripFileScheme(value: String): String =
        if (value.startsWith("file://")) value.removePrefix("file://") else value
}
