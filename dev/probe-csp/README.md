# probe-csp — what the app's own CSP forbids

Run: `node dev/probe-csp/serve.mjs`, then open `http://127.0.0.1:8931/` and
`http://127.0.0.1:8931/mobile`.

This settles the question that chose the QR decoder in #128, and it is here so
the answer can be re-checked rather than believed.

`/` serves a page under the **verbatim `SERVED_CSP`** from
`apps/server/src/policy.ts` as it stood when this was measured. It is kept as
that copy on purpose. #284 has since added `http:` to `connect-src`. By the CSP
spec, `connect-src` governs neither WebAssembly compilation nor worker creation,
so the change should not affect what this table measures. The probe has not been
rerun under the new policy. `/mobile` serves the same page under the only
policy in force at `capacitor://localhost` — `index.html`'s `img-src`-only
meta tag. The page tries two things a QR decoder might need and reports what
happened.

Measured 2026-09-13, Chromium 152:

| | `SERVED_CSP` (`/`) | mobile meta CSP (`/mobile`) |
|---|---|---|
| `WebAssembly.instantiate` | **BLOCKED** — `CompileError` | ALLOWED |
| `blob:` Worker | **BLOCKED** — *and the error event carries no message* | ALLOWED |

Two consequences, and the second is the one that bites.

A WASM or worker-based decoder **works on the phone and breaks on desktop and
server** — the two targets that display a pairing code rather than scan one,
which is precisely how such a break reaches users unnoticed.

And the blob-worker failure is **silent**: the `error` event has no message, so
a scanner that used one would simply never decode, with nothing in the console
naming the cause.

The `/mobile` route is the paired control. Without it, a probe that reported
BLOCKED for everything would be indistinguishable from a probe that was simply
broken.
