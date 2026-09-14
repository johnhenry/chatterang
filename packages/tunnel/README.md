# `@chatterang/tunnel`

Transport code for two Chatterangs on one network (epic #153). This package is
the **boundary**; the transport that goes inside it is a **native socket
plugin on both platforms** (#181, ruled 2026-09-11), built by #156 (client)
and #157/#158 (listener).

## The split, and why it is one package with three entry points

#155 left this open: two entry points, or two packages (`tunnel-client`,
`tunnel-host`)? Two packages make the ban a package-name ban, which the guard in
`tests/layering.test.ts` already knows how to write. **One package won**, for a
reason the guard turned out to settle rather than complicate.

The thing worth sharing is the wire format. Two packages means the wire types
live in one of them and the other depends on it — so the client package becomes
a dependency of the host package, or a third package appears anyway and the
"two packages" answer was three. And a package-name ban is *not* actually the
stronger guard here: the dangerous edge is not `src/` naming the host package,
it is **the client half importing the host half internally**, which a
package-name ban never sees, because the specifier `src/` writes is the allowed
one. That guard has to be written either way. Once it is written, one package
with explicit entry points is strictly less machinery for the same rule.

```
src/wire/    ← imports NOTHING. Frame envelope + codec. Importable from src/.
src/client/  ← web globals only (WebSocket, crypto.subtle, TextEncoder).
               Imports wire. Importable from src/.
src/host/    ← node:net and friends. Imports wire. BANNED from src/.
```

Direction is one-way and asserted: `client → wire`, `host → wire`, and nothing
else. In particular `client` may not reach into `host`, because that would put
`node:net` in the phone bundle through an import `src/` is allowed to write.

There is **no `.` export**. A bare `@chatterang/tunnel` has nothing to resolve
to, and it is banned from `src/` anyway — the day someone adds a `.` that
re-exports both halves is the day the boundary quietly stops existing, so
`tests/layering.test.ts` asserts the absence of that key directly.

## Where the frame type lives

Here, not in `packages/contracts`. #155 asked; the answer is that contracts is
pinned types-only by its own guard ("nothing to build and nothing to drift"),
and a wire format is a format *plus* the pair of functions that reads and writes
it. Splitting `TunnelFrame` from `encodeFrame` across two packages is exactly
the drift the contracts guard exists to prevent.

## One listener, many tunnels

`createTunnelListener` is the long-lived half (#158): it binds once and hands
out a `Tunnel` per connection. Each tunnel owns its inbox, its sequence guard,
its `ended` latch and its socket, so two peers' frames never interleave into
one stream, and closing one tunnel leaves the others and the listener running.
That per-tunnel close is the primitive #135's revocation needs; revocation
itself is not here.

`maxTunnels` is required and has no default, because how many tunnels an app
holds is that app's decision rather than this package's. A connection past the
cap is closed with `TUNNEL_CAP_CLOSE_CODE` before any greeting is sent. The
code lives in `wire/` so the client can name it, and `createTunnelClient`
reports it as `TUNNEL_FULL` rather than `PEER_GONE`. A slot frees when a socket
closes, not when its tunnel is classified: a peer that said `bye` and kept its
socket open still holds a connection.

#169's items are recommendations, not rulings. Two are built here: several
concurrent connections, and a cap enforced at accept time. The third, replacing
a device's stale socket with its new one, is deferred because it needs device
identity (#135), and none exists yet.

`createTunnelHost` is rung 0's single tunnel on top of the listener: capped at
one, and it stops accepting once that tunnel ends. A late peer is refused at
connect, and a peer already mid-request is dropped at its upgrade, rather than
either handshaking onto a tunnel that is already over. The check is at the
upgrade because `server.close()` alone lets a connection that is already inside
a request finish upgrading.

## The TLS identity (#179, #180)

`src/host/identity.ts` makes the key a paired client pins and the certificates
that carry it; `src/host/identity-store.ts` keeps the key on disk for both apps.
Neither binds anything, and neither is called by an app yet.

- **The pin is the key, not the certificate.** `TunnelPin` is the SHA-256 of the
  DER SubjectPublicKeyInfo, as 32 bytes (`NegotiatedPeer.spki`) and as padded
  base64 (`NegotiatedPeerCertificate.spkiSha256`). Re-issuing a certificate
  reuses the stored key, so the pin does not change.
- **EC P-256.** Ed25519 fails the TLS handshake under Electron 44's BoringSSL.
- **Names are a parameter, none by default** (#180, #295).
- **`validDays` has no default**: certificate lifetime is part of the open
  lifetime question.
- **Key rotation is not implemented.** A new key is a new pin, so it is a loud
  re-pair of every device; nothing here makes a key except when none exists.
- **Owner-only or refused.** `<data>/tunnel-identity/key` is 0600 in a 0700
  directory, sealed with `safeStorage` on the desktop where it can encrypt. A
  wider mode, a symlink, another owner, a malformed or tampered file, or a sealed
  file with nothing to unseal it is refused — never tightened and never replaced.
  Windows is refused until its ACL story is decided.

## What is deliberately not here

- **A production transport.** #181 chose a native socket plugin on both
  platforms, and that plugin is not built. What exists is rung 0 (#156):
  `createTunnelClient`, `createTunnelHost` and `createTunnelListener` speak the
  real wire format over loopback `ws://`, with no TLS and no credential, and no
  app starts a listener.
- **`TunnelBinding`.** It belongs in `src/host/`, modelled on
  `apps/server/src/binding.ts` — bind address and credentials as one union, so
  the unsafe combination cannot be written down. There is one arm to write now;
  writing it is #157/#158's job. It must be its own union and **not** a third
  arm of `ServerBinding`: #135's ruling is explicit that a third arm puts an
  arm-dependent branch back into `checkToken`'s gate 1, whose absence is that
  file's documented strength.
- **Frame kinds.** `TunnelFrame['kind']` became a union in #159.

### Why plaintext `ws://` lost

Recorded because a rejected option nobody wrote down is one somebody
re-proposes. `network_security_config.xml` is static, baked at build time, and
the desktop's LAN IP is not knowable when the APK is built — so the narrow
Android exception degrades to a global `cleartextTrafficPermitted="true"`. The
hostname that would have rescued it, an mDNS name resolving inside a WebView,
has never been measured. Two transports lost on its own warning: two threat
models, two negative tests, two failure classifications for #186's adapter.

The chosen option's cost, stated in the ruling rather than discovered later:
~800 KB of OkHttp + okio on Android, a bridge crossing per frame, a new
registered surface that inherits #170's `assertServerSurface` question, and the
deletion of the plan's "no plugin" promise. The QR carries a certificate
fingerprint rather than a key-agreement public key.

## The guard

`tests/layering.test.ts`, in the `the tunnel package` block, and in
`DESKTOP_LAYER_BAN` at the top of that file. It asserts, against these real
files rather than a copy:

- `wire/` imports nothing at all;
- `client/` imports no `node:` builtin, no `electron`, no `@capacitor/`, nothing
  from `src/`, and nothing from `host/`;
- `host/` **does** name a Node builtin — a ban on a half that never touched Node
  would be decorative, so the non-vacuity is asserted too;
- `@chatterang/tunnel` and `@chatterang/tunnel/host` are banned from `src/` by
  all four import forms, while `@chatterang/tunnel/client` and
  `@chatterang/tunnel/wire` are not;
- `package.json` here has no `.` export, and the root `tsconfig.json` maps the
  three entries with no wildcard that would let `@chatterang/tunnel/host`
  resolve through the back door.
