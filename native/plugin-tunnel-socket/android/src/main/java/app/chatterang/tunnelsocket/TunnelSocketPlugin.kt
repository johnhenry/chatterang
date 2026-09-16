package app.chatterang.tunnelsocket

import android.util.Base64
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import java.net.URI
import java.security.MessageDigest
import java.security.cert.CertificateException
import java.security.cert.X509Certificate
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import javax.net.ssl.SSLContext
import javax.net.ssl.X509TrustManager
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString.Companion.toByteString

/**
 * Capacitor bridge for the tunnel's native socket plugin, on Android (#181, #295).
 *
 * #181 ruled the tunnel's transport is a native socket plugin, on both mobile
 * platforms, terminating pinned TLS itself: a WebView's `WebSocket` refuses
 * plaintext as mixed content and cannot report a peer certificate either way
 * (#176's measurement). This is OkHttp over a per-connection
 * [X509TrustManager] that checks the SPKI pin DURING the TLS handshake — in
 * `checkServerTrusted`, which OkHttp calls before it writes a single byte of
 * the HTTP upgrade request. Throwing there aborts the handshake outright, so a
 * mismatch never sends the device credential to an impostor. OkHttp and okio
 * add roughly 800 KB to the APK, the cost #181's ruling already named.
 *
 * `X509TrustManager.checkServerTrusted` receiving the CHAIN from the leaf, and
 * `X509Certificate.publicKey.encoded` answering the SubjectPublicKeyInfo DER
 * for a certificate parsed from a chain (the standard providers' contract for
 * `PublicKey.getEncoded()`'s "X.509" format), is what makes this SPKI hash
 * match Node's `X509Certificate.publicKey.export({type:'spki',format:'der'})`
 * byte for byte with no ASN.1 reconstruction — unlike the iOS leg, which has
 * to rebuild that structure from `SecKeyCopyExternalRepresentation`'s raw key
 * bytes. See that file's own note.
 *
 * NOT BUILT OR RUN ON AN EMULATOR OR DEVICE in this change, unlike
 * `LlamaCppPlugin`, whose `native/README.md` records `arm64-v8a`, NDK 27,
 * compiled and running all ten methods. This file has had no Android SDK/NDK
 * toolchain available to it. It follows that plugin's exact `@CapacitorPlugin`
 * boilerplate and reproduces the desktop leg's validated request shape and
 * timing (`apps/desktop/src/net/tunnel-socket.ts`), but its correctness
 * against a real OkHttp handshake — the negative-pin test #295 requires in
 * particular — has not been measured. Verify it on an emulator before it
 * ships.
 */
@CapacitorPlugin(name = "TunnelSocket")
class TunnelSocketPlugin : Plugin() {

    private class Connection(val id: String) {
        lateinit var webSocket: WebSocket
        @Volatile var opened = false
        @Volatile var closed = false
        @Volatile var negotiatedSpkiSha256: String? = null
        @Volatile var failure: String? = null
        @Volatile var httpStatus: Int? = null
    }

    private val connections = ConcurrentHashMap<String, Connection>()

    // ── connect ──────────────────────────────────────────────────────────

    @PluginMethod
    fun connect(call: PluginCall) {
        val urlString = call.getString("url")
        val scheme = urlString?.let { runCatching { URI(it).scheme?.lowercase() }.getOrNull() }
        val host = urlString?.let { runCatching { URI(it).host }.getOrNull() }
        if (urlString == null || (scheme != "ws" && scheme != "wss")) {
            call.reject("TunnelSocket: \"$urlString\" is not a URL.", "OPTIONS_REFUSED")
            return
        }

        val credential = call.getString("credential")
        val credentialRef = call.getString("credentialRef")
        if (credential != null && credentialRef != null) {
            call.reject(
                "TunnelSocket: connect() was given a credential and a credentialRef together.",
                "OPTIONS_REFUSED",
            )
            return
        }

        val presented: String?
        if (credentialRef != null) {
            /*
             * No keystore lookup is wired here. Reading a device credential out
             * of the Android Keystore is #126's own decision and not this
             * plugin's; until it is wired, every `credentialRef` honestly
             * answers CREDENTIAL_MISSING rather than pretending to hold one —
             * the same choice `apps/desktop/src/net/tunnel-socket.ts` makes
             * with no `credentials` store injected.
             */
            call.reject("TunnelSocket: no stored credential is named \"$credentialRef\".", "CREDENTIAL_MISSING")
            return
        } else {
            presented = credential
        }

        val expectedPeerSpki = call.getObject("expectedPeer")?.getString("spkiSha256")
        val safe = scheme == "wss" || (scheme == "ws" && host == "127.0.0.1")
        if (presented != null && !safe) {
            call.reject(
                "TunnelSocket: a device credential goes only over wss://, or ws:// to 127.0.0.1 — not $urlString.",
                "OPTIONS_REFUSED",
            )
            return
        }
        if (presented != null && scheme == "wss" && expectedPeerSpki == null) {
            call.reject("TunnelSocket: a credential over wss: needs an expectedPeer.", "OPTIONS_REFUSED")
            return
        }

        val connectionId = UUID.randomUUID().toString()
        val connection = Connection(connectionId)
        connections[connectionId] = connection

        val clientBuilder = OkHttpClient.Builder()
        if (scheme == "wss") {
            val trustManager = pinningTrustManager(expectedPeerSpki) { spki, mismatched ->
                connection.negotiatedSpkiSha256 = spki
                if (mismatched) connection.failure = "PEER_MISMATCH"
            }
            val sslContext = SSLContext.getInstance("TLS")
            sslContext.init(null, arrayOf(trustManager), null)
            clientBuilder.sslSocketFactory(sslContext.socketFactory, trustManager)
        }
        val client = clientBuilder.build()

        val requestBuilder = Request.Builder().url(urlString)
        if (presented != null) requestBuilder.addHeader("chatterang-device-credential", presented)

        val listener = object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                connection.opened = true
                notifyListeners("tunnelOpen", JSObject().put("connectionId", connectionId))
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                // Base64 of the UTF-8 bytes, never the string itself — this
                // plugin decodes nothing, matching the contract's rule that one
                // WS message (text or binary) is one opaque `frame`.
                val frame = Base64.encodeToString(text.toByteArray(Charsets.UTF_8), Base64.NO_WRAP)
                notifyListeners("tunnelFrame", JSObject().put("connectionId", connectionId).put("frame", frame))
            }

            override fun onMessage(webSocket: WebSocket, bytes: okio.ByteString) {
                val frame = Base64.encodeToString(bytes.toByteArray(), Base64.NO_WRAP)
                notifyListeners("tunnelFrame", JSObject().put("connectionId", connectionId).put("frame", frame))
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                webSocket.close(code, reason)
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                emitClose(connection, code, reason)
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                // A non-101 answer means the host DID answer the upgrade — a
                // 401, a 503, anything else — and OkHttp reports it here rather
                // than through `onClosed`. `response` is null for everything
                // that happened before any HTTP response, including the pin
                // check above aborting the handshake.
                val status = response?.code
                if (status != null && status != 101) connection.httpStatus = status
                emitClose(connection, 1006, "")
            }
        }

        connection.webSocket = client.newWebSocket(requestBuilder.build(), listener)
        // This client served exactly one socket; let its executor shut down
        // once idle rather than holding a thread pool per connection forever.
        client.dispatcher.executorService.shutdown()

        call.resolve(JSObject().put("connectionId", connectionId))
    }

    // ── send / close / negotiatedPeer ───────────────────────────────────

    @PluginMethod
    fun send(call: PluginCall) {
        val connection = connectionFor(call) ?: return
        val frameBase64 = call.getString("frame")
        if (frameBase64 == null) {
            call.reject("TunnelSocket: send() needs a base64 frame.")
            return
        }
        if (!connection.closed) {
            connection.webSocket.send(Base64.decode(frameBase64, Base64.NO_WRAP).toByteString())
        }
        call.resolve()
    }

    @PluginMethod
    fun close(call: PluginCall) {
        val connection = connectionFor(call) ?: return
        val code = if (call.data.has("code")) call.getInt("code") else 1000
        val reason = call.getString("reason") ?: ""
        // Idempotent: closing an already-closed OkHttp WebSocket is a no-op,
        // and exactly one `tunnelClose` still follows from whichever listener
        // callback already ran.
        connection.webSocket.close(code ?: 1000, reason)
        call.resolve()
    }

    @PluginMethod
    fun negotiatedPeer(call: PluginCall) {
        val connection = connectionFor(call) ?: return
        val spki = connection.negotiatedSpkiSha256
        if (!connection.opened || spki == null) {
            call.reject("TunnelSocket: \"${connection.id}\" is not an open wss: connection.")
            return
        }
        call.resolve(JSObject().put("spkiSha256", spki))
    }

    private fun connectionFor(call: PluginCall): Connection? {
        val connectionId = call.getString("connectionId")
        if (connectionId == null) {
            call.reject("TunnelSocket: this method needs a connectionId.")
            return null
        }
        val connection = connections[connectionId]
        if (connection == null) {
            call.reject("TunnelSocket: no connection \"$connectionId\".")
            return null
        }
        return connection
    }

    private fun emitClose(connection: Connection, code: Int, reason: String) {
        synchronized(connection) {
            if (connection.closed) return
            connection.closed = true
        }
        val payload = JSObject().put("connectionId", connection.id).put("code", code).put("reason", reason)
        connection.httpStatus?.let { payload.put("httpStatus", it) }
        connection.failure?.let { payload.put("failure", it) }
        notifyListeners("tunnelClose", payload)
    }

    /**
     * A trust manager scoped to ONE connection's `expectedPeer`, never a
     * global. `checkServerTrusted` runs inside the TLS handshake, before
     * OkHttp writes the HTTP upgrade request — throwing here is what stops the
     * device credential from ever reaching an impostor's socket.
     *
     * With no `expectedPeer` (a pairing-only connection), any certificate is
     * accepted here — the contract's own rule — and the caller must check
     * `negotiatedPeer()` before trusting anything sent over the connection.
     */
    private fun pinningTrustManager(
        expectedSpkiSha256: String?,
        onNegotiated: (spkiSha256: String, mismatched: Boolean) -> Unit,
    ): X509TrustManager {
        return object : X509TrustManager {
            override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) {}

            override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?) {
                val leaf = chain?.firstOrNull()
                    ?: throw CertificateException("TunnelSocket: no server certificate was presented.")
                val digest = MessageDigest.getInstance("SHA-256").digest(leaf.publicKey.encoded)
                val spkiSha256 = Base64.encodeToString(digest, Base64.NO_WRAP)
                val mismatched = expectedSpkiSha256 != null && expectedSpkiSha256 != spkiSha256
                onNegotiated(spkiSha256, mismatched)
                if (mismatched) {
                    throw CertificateException("TunnelSocket: the peer SPKI does not match expectedPeer.")
                }
            }

            override fun getAcceptedIssuers(): Array<X509Certificate> = arrayOf()
        }
    }
}
