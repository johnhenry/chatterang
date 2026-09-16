import Capacitor
import CommonCrypto
import Foundation

/// Capacitor bridge for the tunnel's native socket plugin, on iOS (#181, #295).
///
/// #181 ruled the tunnel's transport is a native socket plugin, on both mobile
/// platforms, terminating pinned TLS itself: a WebView's `WebSocket` cannot
/// report the peer certificate a pin has to be checked against. This is a
/// `URLSessionWebSocketTask` over `URLSession`, with the pin checked in
/// `urlSession(_:didReceive:completionHandler:)` — BEFORE the TLS handshake
/// is allowed to complete, and therefore before the upgrade request (and the
/// device credential in its header) is ever written. A mismatch cancels the
/// challenge outright; nothing is sent to an impostor.
///
/// NOT BUILT OR RUN ON A SIMULATOR OR DEVICE in this change. Unlike
/// `LlamaCppPlugin`, whose `native/README.md` records it compiled and ran ten
/// methods on an iPhone 17 Pro simulator, this file has had no Xcode toolchain
/// available to it. It follows that plugin's exact Capacitor boilerplate
/// (`CAPPlugin`, `CAPBridgedPlugin`, `pluginMethods`) and reproduces
/// `apps/desktop/src/net/tunnel-socket.ts`'s validated request shape and
/// timing so the three implementations stay in lockstep, but its correctness
/// against a real `URLSession` handshake has not been measured. Verify it —
/// including the negative-pin test #295 requires — on a simulator before it
/// ships. See `EC_P256_SPKI_PREFIX` below for the one place most likely to
/// need a fix on first run.
@objc(TunnelSocketPlugin)
public class TunnelSocketPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "TunnelSocketPlugin"
    public let jsName = "TunnelSocket"

    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "connect", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "send", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "close", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "negotiatedPeer", returnType: CAPPluginReturnPromise),
    ]

    private let stateLock = NSLock()
    private var connections: [String: Connection] = [:]

    // MARK: - connect

    @objc func connect(_ call: CAPPluginCall) {
        guard let urlString = call.getString("url"), let url = URL(string: urlString), let scheme = url.scheme?.lowercased() else {
            call.reject("TunnelSocket: connect() needs a string url.", "OPTIONS_REFUSED")
            return
        }

        let credential = call.getString("credential")
        let credentialRef = call.getString("credentialRef")
        if credential != nil && credentialRef != nil {
            call.reject("TunnelSocket: connect() was given a credential and a credentialRef together.", "OPTIONS_REFUSED")
            return
        }

        var presented = credential
        if let ref = credentialRef {
            // No keychain lookup is wired here. Reading a device credential out
            // of `kSecAttrAccessibleWhenUnlockedThisDeviceOnly` is #126's own
            // decision and not this plugin's; until it is wired, every
            // `credentialRef` honestly answers CREDENTIAL_MISSING rather than
            // pretending to hold one (mirrors the desktop's `CredentialRefStore`).
            call.reject("TunnelSocket: no stored credential is named \"\(ref)\".", "CREDENTIAL_MISSING")
            return
        }

        let expectedPeerSpki = (call.getObject("expectedPeer"))?["spkiSha256"] as? String
        let safe = scheme == "wss" || (scheme == "ws" && url.host == "127.0.0.1")
        if presented != nil && !safe {
            call.reject(
                "TunnelSocket: a device credential goes only over wss://, or ws:// to 127.0.0.1 — not \(urlString).",
                "OPTIONS_REFUSED"
            )
            return
        }
        if presented != nil && scheme == "wss" && expectedPeerSpki == nil {
            call.reject("TunnelSocket: a credential over wss: needs an expectedPeer.", "OPTIONS_REFUSED")
            return
        }

        let connectionId = UUID().uuidString
        let connection = Connection(connectionId: connectionId, expectedPeerSpkiSha256: expectedPeerSpki) { [weak self] name, data in
            self?.notifyListeners(name, data: data)
        }

        var request = URLRequest(url: url)
        if let presented {
            request.setValue(presented, forHTTPHeaderField: "chatterang-device-credential")
        }
        let session = URLSession(configuration: .ephemeral, delegate: connection, delegateQueue: nil)
        let task = session.webSocketTask(with: request)
        connection.attach(session: session, task: task)

        stateLock.lock()
        connections[connectionId] = connection
        stateLock.unlock()

        task.resume()
        call.resolve(["connectionId": connectionId])
    }

    // MARK: - send / close / negotiatedPeer

    @objc func send(_ call: CAPPluginCall) {
        guard let connection = connection(for: call) else { return }
        guard let frameBase64 = call.getString("frame"), let data = Data(base64Encoded: frameBase64) else {
            call.reject("TunnelSocket: send() needs a base64 frame.")
            return
        }
        // "resolves and writes nothing" to a connection already closed — the
        // contract's own rule; `task.state` covers a task the delegate has not
        // yet been told about closing.
        guard connection.task?.state == .running else {
            call.resolve()
            return
        }
        connection.task?.send(.data(data)) { error in
            if let error {
                call.reject("TunnelSocket: send failed: \(error.localizedDescription)")
            } else {
                call.resolve()
            }
        }
    }

    @objc func close(_ call: CAPPluginCall) {
        guard let connection = connection(for: call) else { return }
        let code = call.getInt("code")
        let reason = call.getString("reason")
        let closeCode = code.flatMap { URLSessionWebSocketTask.CloseCode(rawValue: $0) } ?? .normalClosure
        // Idempotent: `cancel(with:reason:)` on an already-finished task is a
        // safe no-op, and exactly one `tunnelClose` still follows from the
        // delegate callback that already ran.
        connection.task?.cancel(with: closeCode, reason: reason?.data(using: .utf8))
        call.resolve()
    }

    @objc func negotiatedPeer(_ call: CAPPluginCall) {
        guard let connectionId = call.getString("connectionId") else {
            call.reject("TunnelSocket: negotiatedPeer() needs a connectionId.")
            return
        }
        stateLock.lock()
        let connection = connections[connectionId]
        stateLock.unlock()
        guard let connection, connection.opened, let spki = connection.negotiatedSpkiSha256 else {
            call.reject("TunnelSocket: \"\(connectionId)\" is not an open wss: connection.")
            return
        }
        call.resolve(["spkiSha256": spki])
    }

    private func connection(for call: CAPPluginCall) -> Connection? {
        guard let connectionId = call.getString("connectionId") else {
            call.reject("TunnelSocket: this method needs a connectionId.")
            return nil
        }
        stateLock.lock()
        let connection = connections[connectionId]
        stateLock.unlock()
        guard let connection else {
            call.reject("TunnelSocket: no connection \"\(connectionId)\".")
            return nil
        }
        return connection
    }

    /// One open (or opening) connection: the socket, the pin it is checked
    /// against, and what the handshake negotiated.
    ///
    /// A CLASS, NOT A STRUCT, because `URLSessionWebSocketDelegate`'s methods
    /// need a stable identity to update in place from a background queue.
    fileprivate final class Connection: NSObject, URLSessionWebSocketDelegate, URLSessionDelegate {
        let connectionId: String
        private let expectedPeerSpkiSha256: String?
        private let notify: (String, [String: Any]) -> Void

        private(set) var opened = false
        private(set) var negotiatedSpkiSha256: String?
        private var failure: String?
        private var httpStatus: Int?
        private var closed = false
        private let lock = NSLock()

        var task: URLSessionWebSocketTask?
        private var session: URLSession?

        init(connectionId: String, expectedPeerSpkiSha256: String?, notify: @escaping (String, [String: Any]) -> Void) {
            self.connectionId = connectionId
            self.expectedPeerSpkiSha256 = expectedPeerSpkiSha256
            self.notify = notify
        }

        func attach(session: URLSession, task: URLSessionWebSocketTask) {
            self.session = session
            self.task = task
        }

        // MARK: URLSessionDelegate — the pin, before the handshake completes.

        /// Runs for the server-trust challenge on THIS connection's own TLS
        /// handshake, before `URLSessionWebSocketTask` writes its upgrade
        /// request. `PEER_MISMATCH` here means the request — and the
        /// credential header on it — is never sent, matching #181's
        /// negative-pin requirement and the contract's
        /// `TunnelConnectOptions` doc.
        func urlSession(
            _ session: URLSession,
            didReceive challenge: URLAuthenticationChallenge,
            completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
        ) {
            guard
                challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
                let serverTrust = challenge.protectionSpace.serverTrust
            else {
                completionHandler(.performDefaultHandling, nil)
                return
            }

            guard let spkiSha256 = Self.spkiSha256(of: serverTrust) else {
                // The certificate's public key could not be read at all —
                // refuse rather than accept an unverifiable peer.
                lock.lock(); failure = "PEER_MISMATCH"; lock.unlock()
                completionHandler(.cancelAuthenticationChallenge, nil)
                return
            }

            lock.lock()
            negotiatedSpkiSha256 = spkiSha256
            lock.unlock()

            if let expected = expectedPeerSpkiSha256, expected != spkiSha256 {
                lock.lock(); failure = "PEER_MISMATCH"; lock.unlock()
                completionHandler(.cancelAuthenticationChallenge, nil)
                return
            }

            // The pin (or its absence, for a pairing-only connection) is the
            // whole trust decision; the system CA list is not consulted.
            completionHandler(.useCredential, URLCredential(trust: serverTrust))
        }

        // MARK: URLSessionWebSocketDelegate

        func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol protocol: String?) {
            lock.lock(); opened = true; lock.unlock()
            notify("tunnelOpen", ["connectionId": connectionId])
            listen()
        }

        func urlSession(
            _ session: URLSession,
            webSocketTask: URLSessionWebSocketTask,
            didCloseWith closeCode: URLSessionWebSocketTask.CloseCode,
            reason: Data?
        ) {
            emitClose(code: closeCode.rawValue, reason: reason.flatMap { String(data: $0, encoding: .utf8) } ?? "")
        }

        /// The handshake itself can fail with no `didCloseWith` at all — a
        /// connection refused, a DNS failure, or this delegate's own
        /// `cancelAuthenticationChallenge` above. That is still the
        /// connection's one terminal.
        func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
            guard task === self.task else { return }
            lock.lock()
            let alreadyClosed = closed
            lock.unlock()
            if alreadyClosed { return }
            if error != nil || !opened {
                emitClose(code: 1006, reason: "")
            }
        }

        private func emitClose(code: Int, reason: String) {
            lock.lock()
            if closed { lock.unlock(); return }
            closed = true
            let currentFailure = failure
            let currentStatus = httpStatus
            lock.unlock()

            var payload: [String: Any] = ["connectionId": connectionId, "code": code, "reason": reason]
            if let currentStatus { payload["httpStatus"] = currentStatus }
            if let currentFailure { payload["failure"] = currentFailure }
            notify("tunnelClose", payload)
        }

        private func listen() {
            task?.receive { [weak self] result in
                guard let self else { return }
                switch result {
                case .failure:
                    // The close/complete delegate methods report the terminal;
                    // this file decodes and reports nothing about the failure
                    // itself, matching every other transport's rule of one
                    // terminal only.
                    return
                case .success(let message):
                    let frame: String
                    switch message {
                    case .data(let data):
                        frame = data.base64EncodedString()
                    case .string(let text):
                        // A Capacitor bridge's payload is JSON either way; this
                        // plugin never decodes a frame as text, matching the
                        // contract's "frames cross as base64 of the exact
                        // bytes" rule — a text WS message is base64 of its
                        // UTF-8 bytes, not passed through as a JS string.
                        frame = Data(text.utf8).base64EncodedString()
                    @unknown default:
                        frame = ""
                    }
                    self.notify("tunnelFrame", ["connectionId": self.connectionId, "frame": frame])
                    self.listen()
                }
            }
        }

        /// SHA-256 of the peer certificate's SubjectPublicKeyInfo (DER), base64
        /// — the exact value `packages/tunnel/src/host/identity.ts`'s
        /// `TunnelPin.spkiSha256` is, and what
        /// `apps/desktop/src/net/tunnel-socket.ts` computes with Node's
        /// `X509Certificate` on the desktop leg of this same plugin.
        ///
        /// NEEDS VERIFICATION ON A REAL HANDSHAKE. `SecKeyCopyExternalRepresentation`
        /// returns the RAW key (an EC point, `0x04 || X || Y` for an
        /// uncompressed P-256 key — 65 bytes), not the ASN.1
        /// `SubjectPublicKeyInfo` a Node `X509Certificate.publicKey.export({type:
        /// 'spki', format: 'der'})` produces. `EC_P256_SPKI_PREFIX` is the fixed
        /// 26-byte DER header (`id-ecPublicKey` + the `prime256v1` OID) every
        /// pinning library that predates a friendlier API prepends for exactly
        /// this reason; `generateTunnelKey()` only ever issues P-256 keys today,
        /// so this covers every certificate this app mints. It does not cover a
        /// future non-P-256 tunnel certificate, which would need a new prefix
        /// entry here — the same limitation the comment on that function names.
        private static func spkiSha256(of trust: SecTrust) -> String? {
            guard let key = SecTrustCopyKey(trust) else { return nil }
            var error: Unmanaged<CFError>?
            guard let raw = SecKeyCopyExternalRepresentation(key, &error) as Data? else { return nil }
            guard raw.count == 65, raw.first == 0x04 else {
                // Not an uncompressed P-256 point — refuse rather than hash
                // something that is not comparable to the pin's own encoding.
                return nil
            }
            var der = Data(EC_P256_SPKI_PREFIX)
            der.append(raw)
            var digest = [UInt8](repeating: 0, count: Int(CC_SHA256_DIGEST_LENGTH))
            der.withUnsafeBytes { buffer in
                _ = CC_SHA256(buffer.baseAddress, CC_LONG(der.count), &digest)
            }
            return Data(digest).base64EncodedString()
        }

        /// DER prefix for `SEQUENCE { SEQUENCE { id-ecPublicKey, prime256v1 }, BIT STRING <65 raw bytes> }`,
        /// up to and including the BIT STRING's own tag, length and leading
        /// zero-padding byte. Appending the 65-byte raw EC point completes a
        /// standard X.509 `SubjectPublicKeyInfo` for a P-256 key.
        private static let EC_P256_SPKI_PREFIX: [UInt8] = [
            0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01,
            0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, 0x03, 0x42, 0x00,
        ]
    }
}
