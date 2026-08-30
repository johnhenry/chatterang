import Capacitor
import Foundation

/// Capacitor bridge for ONNX Runtime (PRD §5, Phase 1).
///
/// Deliberately a separate plugin from llama.cpp. The diffusion pipeline's
/// peak memory is comparable to a whole language model, so it gets its own
/// sessions, its own queue, and a lifecycle the app can end the moment
/// generation finishes (PRD §6).
@objc(OnnxRuntimePlugin)
public class OnnxRuntimePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "OnnxRuntimePlugin"
    public let jsName = "OnnxRuntime"

    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getExecutionProviders", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "createSession", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "releaseSession", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "releaseTask", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "transcribe", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "synthesize", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "diffuse", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "cancel", returnType: CAPPluginReturnPromise),
    ]

    /// Speech and diffusion get separate queues so a long image generation
    /// cannot block dictation, which the user expects to be immediate.
    private let speechQueue = DispatchQueue(label: "app.chatterang.onnx.speech", qos: .userInitiated)
    private let diffusionQueue = DispatchQueue(label: "app.chatterang.onnx.diffusion", qos: .utility)

    private var sessions: [String: OnnxSession] = [:]
    private var cancelled = Set<String>()
    private let lock = NSLock()

    override public func load() {
        // Memory-pressure warnings are the one signal that reliably precedes a
        // jetsam kill, so diffusion sessions are dropped immediately rather
        // than waiting to be terminated mid-generation.
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(handleMemoryWarning),
            name: UIApplication.didReceiveMemoryWarningNotification,
            object: nil
        )
    }

    @objc private func handleMemoryWarning() {
        lock.lock()
        let diffusionHandles = sessions.filter { $0.value.task == "diffusion" }.map(\.key)
        for handle in diffusionHandles { sessions.removeValue(forKey: handle) }
        lock.unlock()
    }

    // MARK: - Providers

    @objc func getExecutionProviders(_ call: CAPPluginCall) {
        var providers = ["cpu", "xnnpack"]
        if OnnxSession.coreMLAvailable { providers.insert("coreml", at: 0) }

        call.resolve([
            "providers": providers,
            "preferred": providers.first ?? "cpu",
            "simulated": false,
        ])
    }

    // MARK: - Sessions

    @objc func createSession(_ call: CAPPluginCall) {
        guard
            let task = call.getString("task"),
            let modelPath = call.getString("modelPath")
        else {
            call.reject("task and modelPath are required.")
            return
        }

        let companions = (call.getObject("companions") ?? [:]).compactMapValues { $0 as? String }
        let provider = call.getString("executionProvider")
            ?? (OnnxSession.coreMLAvailable ? "coreml" : "xnnpack")

        let queue = task == "diffusion" ? diffusionQueue : speechQueue

        queue.async { [weak self] in
            guard let self else { return }
            let started = Date()

            do {
                let session = try OnnxSession(
                    task: task,
                    modelPath: Self.filePath(from: modelPath),
                    companions: companions.mapValues(Self.filePath(from:)),
                    executionProvider: provider,
                    threads: call.getInt("threads") ?? max(2, ProcessInfo.processInfo.processorCount - 2)
                )

                let handle = UUID().uuidString
                self.lock.lock()
                self.sessions[handle] = session
                self.lock.unlock()

                call.resolve([
                    "handle": handle,
                    "task": task,
                    "executionProvider": session.activeProvider,
                    "loadMs": Int(Date().timeIntervalSince(started) * 1000),
                    "warnings": session.warnings,
                ])
            } catch {
                call.reject(error.localizedDescription, nil, error)
            }
        }
    }

    @objc func releaseSession(_ call: CAPPluginCall) {
        guard let handle = call.getString("handle") else {
            call.reject("A handle is required.")
            return
        }
        lock.lock()
        sessions.removeValue(forKey: handle)
        lock.unlock()
        call.resolve()
    }

    @objc func releaseTask(_ call: CAPPluginCall) {
        guard let task = call.getString("task") else {
            call.reject("A task is required.")
            return
        }
        lock.lock()
        for (handle, session) in sessions where session.task == task {
            sessions.removeValue(forKey: handle)
        }
        lock.unlock()
        call.resolve()
    }

    // MARK: - Speech to text

    @objc func transcribe(_ call: CAPPluginCall) {
        guard
            let requestId = call.getString("requestId"),
            let audioBase64 = call.getString("audio"),
            let audio = Data(base64Encoded: audioBase64)
        else {
            call.reject("requestId and base64 audio are required.")
            return
        }

        withSession(call, on: speechQueue) { [weak self] session in
            let started = Date()
            let streamPartials = call.getBool("streamPartials") ?? false

            do {
                let transcript = try session.transcribe(
                    audio: audio,
                    language: call.getString("language"),
                    onPartial: { partial in
                        guard streamPartials else { return }
                        self?.notifyListeners("onnxPartial", data: [
                            "requestId": requestId,
                            "text": partial,
                        ])
                    },
                    shouldStop: { self?.isCancelled(requestId) ?? true }
                )

                call.resolve([
                    "requestId": requestId,
                    "text": transcript.text,
                    "language": transcript.language,
                    "durationMs": Int(Date().timeIntervalSince(started) * 1000),
                    "segments": transcript.segments.map {
                        ["start": $0.start, "end": $0.end, "text": $0.text]
                    },
                ])
            } catch {
                call.reject(error.localizedDescription, nil, error)
            }
        }
    }

    // MARK: - Text to speech

    @objc func synthesize(_ call: CAPPluginCall) {
        guard
            let requestId = call.getString("requestId"),
            let text = call.getString("text")
        else {
            call.reject("requestId and text are required.")
            return
        }

        withSession(call, on: speechQueue) { session in
            let started = Date()
            do {
                let audio = try session.synthesize(
                    text: text,
                    voice: call.getString("voice"),
                    rate: Float(call.getDouble("rate") ?? 1.0),
                    pitch: Float(call.getDouble("pitch") ?? 1.0)
                )

                call.resolve([
                    "requestId": requestId,
                    "audio": audio.wav.base64EncodedString(),
                    "mediaType": "audio/wav",
                    "sampleRate": audio.sampleRate,
                    "durationMs": Int(Date().timeIntervalSince(started) * 1000),
                ])
            } catch {
                call.reject(error.localizedDescription, nil, error)
            }
        }
    }

    // MARK: - Image generation

    @objc func diffuse(_ call: CAPPluginCall) {
        guard
            let requestId = call.getString("requestId"),
            let prompt = call.getString("prompt")
        else {
            call.reject("requestId and prompt are required.")
            return
        }

        withSession(call, on: diffusionQueue) { [weak self] session in
            let started = Date()
            let steps = call.getInt("steps") ?? 4
            let seed = call.getInt("seed").map(UInt64.init) ?? UInt64.random(in: 0 ..< UInt64.max)

            do {
                let image = try session.diffuse(
                    prompt: prompt,
                    negativePrompt: call.getString("negativePrompt"),
                    steps: steps,
                    guidanceScale: Float(call.getDouble("guidanceScale") ?? 1.0),
                    width: call.getInt("width") ?? 512,
                    height: call.getInt("height") ?? 512,
                    seed: seed,
                    onStep: { step, preview in
                        var payload: [String: Any] = [
                            "requestId": requestId,
                            "step": step,
                            "totalSteps": steps,
                        ]
                        if let preview { payload["preview"] = preview.base64EncodedString() }
                        self?.notifyListeners("onnxProgress", data: payload)
                    },
                    shouldStop: { self?.isCancelled(requestId) ?? true }
                )

                call.resolve([
                    "requestId": requestId,
                    "image": image.png.base64EncodedString(),
                    "mediaType": "image/png",
                    "width": image.width,
                    "height": image.height,
                    "steps": steps,
                    "seed": Int(seed),
                    "durationMs": Int(Date().timeIntervalSince(started) * 1000),
                    "peakMemoryBytes": image.peakMemoryBytes,
                ])
            } catch {
                call.reject(error.localizedDescription, nil, error)
            }
        }
    }

    @objc func cancel(_ call: CAPPluginCall) {
        guard let requestId = call.getString("requestId") else {
            call.reject("A requestId is required.")
            return
        }
        lock.lock()
        cancelled.insert(requestId)
        lock.unlock()
        call.resolve()
    }

    // MARK: - Helpers

    private func isCancelled(_ requestId: String) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        return cancelled.contains(requestId)
    }

    private func withSession(
        _ call: CAPPluginCall,
        on queue: DispatchQueue,
        _ body: @escaping (OnnxSession) -> Void
    ) {
        guard let handle = call.getString("handle") else {
            call.reject("A handle is required.")
            return
        }

        lock.lock()
        let session = sessions[handle]
        if let requestId = call.getString("requestId") { cancelled.remove(requestId) }
        lock.unlock()

        guard let session else {
            call.reject("That session is no longer loaded. It may have been released under memory pressure.")
            return
        }

        queue.async { body(session) }
    }

    private static func filePath(from value: String) -> String {
        if value.hasPrefix("file://"), let url = URL(string: value) { return url.path }
        return value
    }
}
