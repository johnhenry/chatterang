import Foundation
import llama

/// Vision (`mtmd`) bridge — **not implemented, and it says so.**
///
/// `LlamaContext` calls into this type for projector loading and image
/// evaluation. The symbols and headers it would need are present: the pinned
/// XCFramework ships `mtmd.h` and `mtmd-helper.h` and exports the mtmd symbol
/// set. What is absent is this file's real body.
///
/// It refuses rather than guessing, for the reason `host/entry.ts` refuses to
/// run without a model root. The alternative shapes were both worse:
///
///   - Returning `true` from `load` would make `supportsVision` report a
///     capability that does not exist, and the failure would surface later as
///     garbage output rather than here as a message.
///   - Deleting the call sites would remove the seam, and the seam is the part
///     worth keeping — `LlamaContext` already degrades to text-only when this
///     reports failure, and appends the projector warning to `warnings`, which
///     the UI shows verbatim.
///
/// So `load` returns false (text-only, with a warning the user sees) and
/// `evaluate` throws (an image was actually supplied, which is not recoverable
/// by ignoring it).
enum MultimodalBridgeError: LocalizedError {
    case notImplemented

    var errorDescription: String? {
        "This build cannot read images. It was compiled without the multimodal bridge, so the model is running in text-only mode."
    }
}

final class MultimodalBridge {
    static let shared = MultimodalBridge()

    private init() {}

    /// Always false. See the type's documentation — this is a refusal, not a
    /// load failure, and `LlamaContext` turns it into a user-visible warning.
    func load(projectorPath: String, model: OpaquePointer) -> Bool {
        false
    }

    /// Always throws. Reaching this means an image was supplied to a build that
    /// cannot evaluate one; silently dropping it would answer about an image
    /// the model never saw.
    func evaluate(images: [Data], context: OpaquePointer) throws {
        throw MultimodalBridgeError.notImplemented
    }
}
