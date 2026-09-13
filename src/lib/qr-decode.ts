/**
 * Decode a pairing code from one camera frame (#128).
 *
 * ## Why a bundled decoder exists at all
 *
 * `BarcodeDetector` is ABSENT on iOS at every origin measured — WKWebView at
 * `capacitor://localhost`, WKWebView at `http://localhost`, and mobile Safari
 * (`dev/probe-128/`). No origin change, no plist key and no Capacitor setting
 * produces one, so iOS has no native decoder to reach for. Android's WebView
 * does have it, but #223 records that the WebView is a separately-updatable
 * APK and `minSdkVersion 24` does not bound its version — so the same bundled
 * decoder is Android's floor guarantee as well as iOS's only route.
 *
 * ## Why jsQR, and not the faster options
 *
 * THE CONTENT-SECURITY-POLICY DECIDES THIS, and it was measured rather than
 * reasoned about. Serving a page under this repo's verbatim `SERVED_CSP`
 * (`apps/server/src/policy.ts`) in a real browser:
 *
 *     WASM instantiate : BLOCKED — CompileError, "violates the following
 *                        Content Security Policy directive"
 *     blob: Worker     : BLOCKED — and the error event carries NO message,
 *                        so it fails silently in product terms
 *
 * and the paired control, the same page under the only policy in force at
 * `capacitor://localhost` (`index.html`'s `img-src`-only meta tag), allows
 * both. So a WASM decoder or a worker-based one works on the phone and breaks
 * on desktop and server.
 *
 * Admitting either means editing `CSP_PRODUCTION` and `SERVED_CSP` in lockstep
 * — `tests/server-policy.test.ts` diffs them directive-by-directive and permits
 * only the two font origins — and the WASM case also rewrites
 * `tests/desktop-security.test.ts`, which pins `script-src` to exactly
 * `["'self'"]`. Those tests exist so that weakening cannot happen quietly, and
 * a pairing screen is not a good enough reason to spend them. jsQR asks for
 * nothing: no WebAssembly, no Worker, no Blob, no fetch, no eval.
 *
 * ## Why it is imported lazily
 *
 * jsQR is 47 KB minified and gzipped, and 54.7% of its raw bytes are a
 * Shift-JIS Kanji table that a six-digit pairing code will never reach. It is
 * a UMD with no `module` entry and no `sideEffects` field, so bundlers
 * tree-shake nothing out of it — measured at 47,098 bundled against 46,778
 * minify-only. A dynamic `import()` keeps all of it out of the initial bundle
 * and off the device of every user who never pairs.
 *
 * Stripping that table is a real 4.3x saving and is deliberately NOT done
 * here: it means owning a fork of a decoder that has not been published since
 * 2021, and that is a separate decision with its own measurement, not
 * something to smuggle into a feature.
 *
 * ## The frame is borrowed, never kept
 *
 * #128 requires that a scan never persists a frame — "frames never touch the
 * blob store and never reach a model" — and the camera usage string promises
 * it to the user in an OS dialog. This module takes the pixels as an argument
 * and returns a string. It holds no module-level state, opens no store, and
 * has nothing to persist WITH, which is a stronger guarantee than a rule
 * somebody has to follow.
 */

/** Exactly the three fields `ImageData` carries, and what `getUserMedia` yields. */
export interface QrFrame {
  readonly data: Uint8ClampedArray;
  readonly width: number;
  readonly height: number;
}

/**
 * The platform decoder, when the platform has one.
 *
 * Declared structurally rather than imported: `BarcodeDetector` is absent from
 * TypeScript's DOM lib and absent from iOS entirely, so a global declaration
 * would assert it exists on a platform where reaching for it is the bug.
 */
interface NativeDetector {
  detect(source: ImageData): Promise<readonly { readonly rawValue: string }[]>;
}
type DetectorCtor = new (options?: { formats?: readonly string[] }) => NativeDetector;

function nativeDetector(): DetectorCtor | null {
  const ctor = (globalThis as { BarcodeDetector?: DetectorCtor }).BarcodeDetector;
  return typeof ctor === 'function' ? ctor : null;
}

/** Is a platform decoder available here? Exported so the UI can say which ran. */
export function hasNativeDetector(): boolean {
  return nativeDetector() !== null;
}

/**
 * Read a QR payload out of one frame, or null if the frame has none.
 *
 * Null is the ORDINARY case, not an error: most frames in a scan loop contain
 * no code at all, and a decoder that threw on them would make the loop's happy
 * path an exception handler. A genuine fault — a decoder that will not load —
 * still throws.
 */
export async function decodeFrame(frame: QrFrame): Promise<string | null> {
  const Native = nativeDetector();
  if (Native !== null) {
    try {
      const found = await new Native({ formats: ['qr_code'] }).detect(
        // `ImageData` is what the platform decoder wants and what the caller
        // already has; constructing one here would copy the pixels again.
        frame as unknown as ImageData,
      );
      const first = found[0];
      if (first !== undefined) return first.rawValue;
      return null;
    } catch {
      /*
       * FALL THROUGH TO jsQR RATHER THAN FAIL. `BarcodeDetector` exists on
       * some Android WebViews that then reject `detect` for formats they do
       * not actually support, and a scanner that gave up there would be broken
       * on precisely the devices #223 is about. The bundled decoder is already
       * paid for; using it is free.
       */
    }
  }

  const { default: jsQR } = await import('jsqr');
  const result = jsQR(frame.data, frame.width, frame.height);
  return result === null ? null : result.data;
}
