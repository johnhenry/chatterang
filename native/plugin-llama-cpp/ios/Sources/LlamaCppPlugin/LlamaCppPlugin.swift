import Capacitor
import Foundation

/// Capacitor bridge for the llama.cpp engine (PRD §5, Phase 1).
///
/// The plugin class does bridging only: argument decoding, dispatch onto the
/// inference queue, and event emission. Everything that touches llama.cpp
/// lives in `LlamaContext`, so the two can be tested and reasoned about
/// separately.
@objc(LlamaCppPlugin)
public class LlamaCppPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "LlamaCppPlugin"
    public let jsName = "LlamaCpp"

    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getCapabilities", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getThermalState", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "load", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "unload", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "listLoaded", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "generate", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "cancel", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "tokenize", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "countTokens", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "benchmark", returnType: CAPPluginReturnPromise),
    ]

    /// Serial queue: llama.cpp contexts are not safe to use concurrently, and
    /// serialising here is simpler and more predictable than locking inside
    /// the engine wrapper.
    private let queue = DispatchQueue(label: "app.chatterang.llama", qos: .userInitiated)

    private var contexts: [String: LlamaContext] = [:]
    private var cancelled = Set<String>()
    private let stateLock = NSLock()

    private var thermalObserver: NSObjectProtocol?

    override public func load() {
        // Thermal state is a first-class signal for this app: it drives the
        // rail, and it decides whether a request falls back to a remote
        // provider. Pushing changes rather than polling keeps that honest.
        thermalObserver = NotificationCenter.default.addObserver(
            forName: ProcessInfo.thermalStateDidChangeNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            guard let self else { return }
            self.notifyListeners("llamaThermal", data: Self.thermalPayload())
        }
    }

    deinit {
        if let thermalObserver {
            NotificationCenter.default.removeObserver(thermalObserver)
        }
    }

    // MARK: - Capabilities

    @objc func getCapabilities(_ call: CAPPluginCall) {
        let info = ProcessInfo.processInfo
        var backends = ["cpu"]

        // Metal is available on every device this app supports, but the check
        // is kept rather than assumed: a simulator has no usable GPU.
        if LlamaContext.metalAvailable {
            backends.append("gpu-metal")
        }

        call.resolve([
            "totalMemory": info.physicalMemory,
            "availableMemory": LlamaContext.availableMemory(),
            "backends": backends,
            "preferredBackend": backends.contains("gpu-metal") ? "gpu-metal" : "cpu",
            "cpuCores": info.processorCount,
            "chipset": Self.chipset(),
            "simulated": false,
            "engineVersion": LlamaContext.engineVersion,
        ])
    }

    @objc func getThermalState(_ call: CAPPluginCall) {
        call.resolve(Self.thermalPayload())
    }

    private static func thermalPayload() -> [String: Any] {
        let state = ProcessInfo.processInfo.thermalState
        let level: Double
        let name: String

        switch state {
        case .nominal: level = 0.15; name = "nominal"
        case .fair: level = 0.45; name = "fair"
        case .serious: level = 0.75; name = "serious"
        case .critical: level = 0.95; name = "critical"
        @unknown default: level = 0.15; name = "nominal"
        }

        return [
            "level": level,
            "state": name,
            // `serious` is the point at which iOS is already reducing clocks,
            // so that is where the app should consider itself throttled.
            "throttled": state == .serious || state == .critical,
        ]
    }

    private static func chipset() -> String {
        var systemInfo = utsname()
        uname(&systemInfo)
        let identifier = withUnsafePointer(to: &systemInfo.machine) { pointer in
            pointer.withMemoryRebound(to: CChar.self, capacity: 1) { String(validatingUTF8: $0) ?? "" }
        }
        return identifier.isEmpty ? "Apple silicon" : identifier
    }

    // MARK: - Lifecycle

    @objc func load(_ call: CAPPluginCall) {
        guard let modelPath = call.getString("modelPath") else {
            call.reject("A model path is required.")
            return
        }

        let options = LlamaContext.LoadOptions(
            modelPath: Self.filePath(from: modelPath),
            mmprojPath: call.getString("mmprojPath").map(Self.filePath(from:)),
            draftModelPath: call.getString("draftModelPath").map(Self.filePath(from:)),
            contextLength: call.getInt("contextLength") ?? 4096,
            gpuLayers: call.getInt("gpuLayers") ?? -1,
            requestedBackend: call.getString("backend") ?? "gpu-metal",
            threads: call.getInt("threads") ?? max(2, ProcessInfo.processInfo.processorCount - 2),
            useMmap: call.getBool("useMmap") ?? true,
            chatTemplate: call.getString("chatTemplate")
        )

        queue.async { [weak self] in
            guard let self else { return }
            do {
                let started = Date()
                let context = try LlamaContext(options: options)
                let handle = UUID().uuidString

                self.stateLock.lock()
                self.contexts[handle] = context
                self.stateLock.unlock()

                call.resolve([
                    "handle": handle,
                    "backend": context.activeBackend,
                    "contextLength": context.contextLength,
                    "loadMs": Int(Date().timeIntervalSince(started) * 1000),
                    "warnings": context.warnings,
                    "supportsVision": context.supportsVision,
                    "chatTemplate": context.chatTemplate,
                ])
            } catch {
                call.reject(Self.describe(error), nil, error)
            }
        }
    }

    @objc func unload(_ call: CAPPluginCall) {
        guard let handle = call.getString("handle") else {
            call.reject("A handle is required.")
            return
        }

        queue.async { [weak self] in
            guard let self else { return }
            self.stateLock.lock()
            let context = self.contexts.removeValue(forKey: handle)
            self.stateLock.unlock()
            context?.free()
            call.resolve()
        }
    }

    @objc func listLoaded(_ call: CAPPluginCall) {
        stateLock.lock()
        let handles = Array(contexts.keys)
        stateLock.unlock()
        call.resolve(["handles": handles])
    }

    // MARK: - Generation

    @objc func generate(_ call: CAPPluginCall) {
        guard
            let handle = call.getString("handle"),
            let prompt = call.getString("prompt"),
            let requestId = call.getString("requestId")
        else {
            call.reject("handle, prompt, and requestId are required.")
            return
        }

        let sampler = LlamaContext.Sampler(from: call.getObject("sampler") ?? [:])
        let images = (call.getArray("images") as? [[String: Any]] ?? []).compactMap { entry -> Data? in
            guard let base64 = entry["data"] as? String else { return nil }
            return Data(base64Encoded: base64)
        }

        stateLock.lock()
        cancelled.remove(requestId)
        let context = contexts[handle]
        stateLock.unlock()

        guard let context else {
            call.reject("No model is loaded for that handle.")
            return
        }

        queue.async { [weak self] in
            guard let self else { return }

            var index = 0
            let started = Date()
            var firstTokenAt: Date?

            do {
                let result = try context.generate(
                    prompt: prompt,
                    images: images,
                    sampler: sampler,
                    shouldStop: { [weak self] in
                        guard let self else { return true }
                        self.stateLock.lock()
                        defer { self.stateLock.unlock() }
                        return self.cancelled.contains(requestId)
                    },
                    onToken: { [weak self] token in
                        if firstTokenAt == nil { firstTokenAt = Date() }
                        self?.notifyListeners("llamaToken", data: [
                            "requestId": requestId,
                            "token": token,
                            "index": index,
                        ])
                        index += 1
                    }
                )

                let totalMs = max(1, Int(Date().timeIntervalSince(started) * 1000))
                let ttftMs = firstTokenAt.map { Int($0.timeIntervalSince(started) * 1000) } ?? totalMs

                var payload: [String: Any] = [
                    "requestId": requestId,
                    "text": result.text,
                    "promptTokens": result.promptTokens,
                    "completionTokens": result.completionTokens,
                    "ttftMs": ttftMs,
                    "totalMs": totalMs,
                    "tokensPerSecond": Double(result.completionTokens) / (Double(totalMs) / 1000.0),
                    "stopReason": result.stopReason,
                    "peakMemoryBytes": LlamaContext.footprint(),
                ]
                if let acceptance = result.draftAcceptance {
                    payload["draftAcceptance"] = acceptance
                }

                self.notifyListeners("llamaEnd", data: payload)
                call.resolve(payload)
            } catch {
                let message = Self.describe(error)
                self.notifyListeners("llamaEnd", data: [
                    "requestId": requestId,
                    "text": "",
                    "promptTokens": 0,
                    "completionTokens": 0,
                    "ttftMs": 0,
                    "totalMs": 0,
                    "tokensPerSecond": 0,
                    "stopReason": "error",
                    "error": message,
                ])
                call.reject(message, nil, error)
            }
        }
    }

    @objc func cancel(_ call: CAPPluginCall) {
        guard let requestId = call.getString("requestId") else {
            call.reject("A requestId is required.")
            return
        }
        stateLock.lock()
        cancelled.insert(requestId)
        stateLock.unlock()
        call.resolve()
    }

    // MARK: - Tokenisation

    @objc func tokenize(_ call: CAPPluginCall) {
        withContext(call) { context in
            let tokens = context.tokenize(call.getString("text") ?? "")
            call.resolve(["tokens": tokens])
        }
    }

    @objc func countTokens(_ call: CAPPluginCall) {
        withContext(call) { context in
            call.resolve(["count": context.tokenize(call.getString("text") ?? "").count])
        }
    }

    // MARK: - Benchmark

    @objc func benchmark(_ call: CAPPluginCall) {
        withContext(call) { context in
            let promptTokens = call.getInt("promptTokens") ?? 512
            let generateTokens = call.getInt("generateTokens") ?? 128
            let repetitions = max(1, call.getInt("repetitions") ?? 3)

            let before = Self.thermalPayload()
            var decodeSamples: [Double] = []
            var prefillSamples: [Double] = []

            do {
                for _ in 0 ..< repetitions {
                    let measurement = try context.measure(
                        promptTokens: promptTokens,
                        generateTokens: generateTokens
                    )
                    prefillSamples.append(measurement.promptTokensPerSecond)
                    decodeSamples.append(measurement.generateTokensPerSecond)
                }
            } catch {
                call.reject(Self.describe(error), nil, error)
                return
            }

            call.resolve([
                "promptTokensPerSecond": prefillSamples.reduce(0, +) / Double(prefillSamples.count),
                "generateTokensPerSecond": decodeSamples.reduce(0, +) / Double(decodeSamples.count),
                "peakMemoryBytes": LlamaContext.footprint(),
                "thermalBefore": before,
                "thermalAfter": Self.thermalPayload(),
                "backend": context.activeBackend,
                "repetitions": repetitions,
                "samples": decodeSamples,
            ])
        }
    }

    // MARK: - Helpers

    private func withContext(_ call: CAPPluginCall, _ body: @escaping (LlamaContext) -> Void) {
        guard let handle = call.getString("handle") else {
            call.reject("A handle is required.")
            return
        }

        stateLock.lock()
        let context = contexts[handle]
        stateLock.unlock()

        guard let context else {
            call.reject("No model is loaded for that handle.")
            return
        }

        queue.async { body(context) }
    }

    /// The web layer stores paths as `file://` URIs from `Filesystem.getUri`.
    private static func filePath(from value: String) -> String {
        if value.hasPrefix("file://"), let url = URL(string: value) {
            return url.path
        }
        return value
    }

    private static func describe(_ error: Error) -> String {
        if let engineError = error as? LlamaContext.EngineError {
            return engineError.userFacingMessage
        }
        return error.localizedDescription
    }
}
