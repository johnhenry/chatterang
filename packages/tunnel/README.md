# `@chatterang/tunnel`

Transport code for two Chatterangs on one network (epic #153). This package is
the **boundary**; the transport that goes inside it is a **native socket
plugin on iOS and Android, and a real Node implementation for the Electron
desktop client** (#181, ruled 2026-09-11; #295 built it — the plugin's
contract, iOS, Android, the web refusal, and the desktop's own leg). Rung 0
over loopback `ws://` — `createTunnelClient`, `createTunnelHost` and
`createTunnelListener` speaking the real wire format through the credential
gate — was built by #156 (client) and #157/#158 (listener), and is still what
every transport, including the real plugin, runs its protocol over.

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
That per-tunnel close is what revocation uses; see "Who gets in".

`maxTunnels` is required and has no default, because how many tunnels an app
holds is that app's decision rather than this package's. A connection past the
cap is closed with `TUNNEL_CAP_CLOSE_CODE` before any greeting is sent. The
code lives in `wire/` so the client can name it, and `createTunnelClient`
reports it as `TUNNEL_FULL` rather than `PEER_GONE`. A slot frees when a socket
closes, not when its tunnel is classified: a peer that said `bye` and kept its
socket open still holds a connection.

#169's items were recommendations. Two are built here: several concurrent
connections, and a cap enforced at accept time. The third, replacing a device's
stale socket with its new one, is now the owner's ruling on #7 (ruling 4). It is
not built. It needed device identity, which now exists (a tunnel's
`admission.deviceId`), so it is buildable; nobody has built it.

`createTunnelHost` is rung 0's single tunnel on top of the listener: capped at
one, and it stops accepting once that tunnel ends. A late peer is refused at
connect, and a peer already mid-request is dropped at its upgrade, rather than
either handshaking onto a tunnel that is already over. The check is at the
upgrade because `server.close()` alone lets a connection that is already inside
a request finish upgrading.

## Who gets in

`createTunnelListener` and `createTunnelHost` take a `TunnelBinding` (#135,
#158). It is its own union and **not** a third arm of `ServerBinding`: #135's
ruling is explicit that a third arm puts an arm-dependent branch back into
`checkToken`'s gate 1, and the operator token and the cookie helpers stay out
of the tunnel. It has a loopback arm with no host field, and a TLS arm with any
address and `TlsMaterial`, which the tunnel's own key and certificate make (see
"The TLS identity"). The only things shared with
`apps/server/src/binding.ts` are `LOOPBACK_HOST` and the `TlsMaterial` brand.
They live in `src/host/tls.ts`, a file that imports nothing, and the server
re-exports them: two copies of a `unique symbol` brand would be two
incompatible types.

**Both arms require a `TunnelGate`**, the loopback arm included. This is the
fail-closed reading of the rulings. Tailscale Serve, which #154's re-scope
recommends as the remote path (#124 records it, awaiting its own ruling),
forwards an HTTPS name to a loopback port. And a stranger's process on this
machine is not the operator; `apps/server/src/binding.ts` measured that.
Rung 0 goes through the same gate; there is no ungated door.

At the HTTP upgrade, before `ws` writes a byte:

1. **The URL carries nothing.** Any request-target but `/` gets 400. That
   includes a credential in the query, which is refused rather than ignored,
   even beside a valid header (#136).
2. **A `chatterang-device-credential` header is final** (`TUNNEL_CREDENTIAL_HEADER`).
   Malformed, unknown, wrong or revoked credentials all get 401, with no reason
   given, and none falls through to pairing. A registry that cannot be read
   gets 503.
3. **No credential:** the connection is admitted only while a pairing window is
   `issued`, and only as a *pairing tunnel* (#136). It may carry `hello`,
   `pair` and `bye` in either direction, and anything else closes it with
   `TUNNEL_PAIRING_ONLY_CLOSE_CODE` (4403), which the client reports as
   `PAIRING_ONLY`. A pairing tunnel is never promoted: a phone that finishes
   pairing reconnects with its credential. With no window open, the connection
   gets 401. `createTunnelHost` (rung 0) admits no pairing tunnel at all.

What changed while the gate was deciding is asked again in the turn that
admits. `listener.close()` destroys an upgrade the gate has not finished with.

**A pairing tunnel ends with its code**, whether or not it is sending
anything. It closes with `TUNNEL_PAIRING_CLOSED_CLOSE_CODE` (4410), which the
client reports as `PAIRING_WINDOW_CLOSED`:

- **The window closing ends it in that turn.** That covers a code dismissed or
  replaced, a spent attempt budget, or a claim. The window tells the listener
  through `PairingWindow.onClose`.
- **Expiry is evaluated, not scheduled** (`pairing/window.ts`). The listener
  asks on a timer at the deadline, at every upgrade, and whenever a frame
  moves. A timer that fires late, on a machine that slept, closes late; the
  latched window decides.
- **A claim is attributed.** The caller claims through the tunnel,
  `admission.claim(secret)`. That tunnel keeps its channel for
  `PAIRING_HANDOVER_MS` (10 s) to receive its credential, and every other
  pairing tunnel under the window ends at once. A window claimed directly,
  with no tunnel to attribute it to, ends every pairing tunnel under it.

What a pairing tunnel can hold is bounded, one named constant per limit
(#169):

- `MAX_PAIRING_TUNNELS` (2) is its own cap. Pairing tunnels never count
  against `maxTunnels`, so a stranger on the LAN cannot keep a paired phone out
  by holding slots.
- `MAX_PAIRING_FRAME_BYTES` (16 KiB) is enforced by `ws` before it buffers a
  message. A device's limit is the codec's `MAX_FRAME_BYTES`, where `ws`'s
  default was 100 MiB.
- `MAX_PAIRING_BACKLOG` (16) caps unread frames. Past it the tunnel closes
  with 4403.

**The credential** (#135) comes from `createDeviceCredentials(store)`:

- `mint(window, now)` mints only for a `claimed` pairing window that
  `openWindow` made (`PairingWindow` is branded, and `isOpenedWindow` checks
  the same at runtime), once per window. The credential is
  `<deviceId>.<secret>`, 16 and 32 random bytes, base64url, and it is returned
  once.
- The store keeps SHA-256 of it, keyed by device id. That is enough for a
  256-bit random secret, where a password would need a slow KDF.
- The comparison is `timingSafeEqual` over the two digests.
- `revoke(deviceId)` refuses the device at once. In the same turn it drops
  every frame each of the device's tunnels had queued and stops reading from
  them. It then closes every one of those tunnels with `bye` reason `revoked`.
  Finally it writes a zero-byte tombstone over the digest and deletes it. If
  the delete fails, the rejection is rethrown and the device stays refused,
  including by a registry opened over the same store after a restart.
- `CredentialStore` is an interface. `createMemoryCredentialStore` forgets
  everything on exit.

Rung 0's test credential is minted exactly that way.
`createTunnelClient({ url, credential })` sends it in the header, and only over
`wss:` or `ws://127.0.0.1`. That check runs before any transport is made, so it
covers every transport, and it covers `credentialRef` (a name the transport's
own store keeps the secret under) as well. Node's WebSocket can send a header; a
webview's cannot, and throws rather than connecting without it.

The phone's transport is #181's plugin, and the client takes it as an option:
`createTunnelClient({ url, credential, transport })`. A `TunnelTransport` is
bytes in, bytes out, and exactly one close, with the upgrade's HTTP status when
the host answered one. The gate, the sequence checks, `bye` and the close-code
faults run over it unchanged. The plugin's contract is
`@chatterang/contracts/tunnel-socket`; the adapter from it is passed in, never
imported by `client/`. A connection that closes before it opens rejects with a
`TunnelConnectError`: `CREDENTIAL_REFUSED` (401 with a credential),
`PAIRING_NOT_OPEN` (401 without one), `HOST_COULD_NOT_CHECK` (503),
`UPGRADE_REFUSED` (any other status) or `UNREACHABLE`. A transport that stopped
before any host could answer says why, and that reads first: `PEER_MISMATCH`
(the handshake showed a key other than the paired desktop's, and nothing was
sent), `CREDENTIAL_MISSING` (the stored credential a `credentialRef` names is
gone) or `TRANSPORT_FAILED` (it would not start). A socket plugin's rejected
`connect` is still the transport's one close; its adapter reports it with that
failure. The `WebSocket` default can only say `UNREACHABLE`, because a WHATWG
socket hides the status.

## The TLS identity (#179, #180)

`src/host/identity.ts` makes the key a paired client pins and the certificates
that carry it; `src/host/identity-store.ts` keeps the key on disk for both apps.
Neither binds anything. Each app has a loader over the store
(`apps/desktop/src/tunnel-identity.ts`, `apps/server/src/tunnel-identity.ts`),
and nothing calls either loader yet.

What they make is what the TLS arm of `TunnelBinding` serves (see "Who gets
in"): `asTlsMaterial(tunnelKeyPkcs8Pem(key), certificate.certPem)`. The
material carries no pin of its own; the pin is `key.pin`, and a certificate
re-issued from the same key serves the same one.

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
  directory. A wider mode, a symlink, a FIFO, another owner, or a malformed or
  tampered file is refused — never tightened and never replaced.
- **Access control lists are read where mode bits do not cover them.** On Linux
  a POSIX ACL cannot grant past the group bits (they are its mask), so the mode
  check is the whole answer. On macOS an ACL is independent of the mode, so the
  store reads it with `/bin/ls -lde`: an allow entry on the key or its directory,
  or an entry on the data directory that grants more than reading (inheritance
  included), is refused, as is a listing it cannot read. Every other platform,
  Windows included, is refused until someone teaches the store its permissions.
- **Sealed exactly where sealing is real.** The desktop asks only after
  Electron's `ready` (checked, not assumed), and seals with `safeStorage` when it
  can encrypt — on Linux only into a named secret store, since `basic_text` is a
  hard-coded password. The file must match the process: a sealed key with nothing
  to unseal it, and a plain key where sealing is available, are both refused; a
  plain key is never re-sealed in place, which would keep a planted one.
- **Durable before it is reported.** The key is written under a private
  `O_EXCL` name, checked, synced, hard-linked into place, and the directory is
  synced before `created: true` is returned.

## #7's vocabulary: waiting, prompts, refusals, and collecting a result

The owner's rulings on #7 need five things the original frames could not say.
They are on the wire now, in `wire/`:

| Frame or code | Direction (per turn) | What it says |
|---|---|---|
| `waiting {position}` | runner → asker | Admitted, waiting for the one slot; 1 is next (#169, ruling 3). |
| `prompt` (turn, prompt id, sheet) | runner → asker | A tool needs an answer before its call may go (#170). |
| `answer` (turn, prompt id, yes/no) | asker → runner | The answer to that one prompt. |
| `attach` (turn) | asker → runner | Collect a result held while this device's socket was gone (ruling 4). |
| `ack` (turn) | asker → runner | That turn's terminal arrived whole; whatever holds it may let it go. |
| `error` codes in `REFUSALS` | runner → asker | `WAIT_LIST_FULL`, `DESKTOP_QUITTING`, `HOST_SUSPENDED`, `HOST_DOES_NOT_RUN_TURNS`, `TOOL_LOOP_UNSUPPORTED` (#152, below), `PROMPT_EXPIRED`, `RESULT_UNKNOWN`. |
| `error` `FRAME_UNEXPECTED` | either | One of your frames was dropped unread. Changes no turn and no prompt. |

Roles are per turn. The end that sends a turn's `turn`, or its `attach`, asks
for it; the other end runs it. Under #7 the phone asks and the desktop runs, but
the wire does not say which device is which.

### #152: who runs the tool loop

Every `turn` frame says who runs the tools the model calls, in a named
`toolLoop` field on the frame (never `metadata.custom`, #141):

- `requester`: the device that asked runs them. The host serves inference only,
  and its reply ends at the model's tool calls.
- `host`: the host runs the tools its policy allows (#170).

A writer must say one of the two, and `encodeFrame` refuses a `turn` that does
not. `decodeFrame` does not refuse a missing or unknown value: a decode error
closes the tunnel, and the host could then never send its refusal. So the value
arrives as it was sent. `toolLoopOf` is the one reader, and it answers `null` for
anything but the two values. A host refuses a loop it does not run, and `null`,
with `TOOL_LOOP_UNSUPPORTED`. That refusal names one turn and is sent before the
turn starts, so the device may ask again with the other loop.

- **Every field is checked both ways.** `encodeFrame` runs the decoder's own
  per-arm rules on the frame it writes. A position JSON would turn into `null`,
  or a prompt field this build does not know, is refused at the send. Coming in,
  an unknown prompt field is dropped, so a newer desktop's sheet shows up on an
  older phone as a narrower yes. Turn and prompt ids are capped at
  `MAX_ID_LENGTH` (128 characters), because both ends now keep state keyed by
  them.
- **Every frame is checked against its turn's state.** `createProtocolGate` in
  `stream/` runs on both halves.
  - It refuses a `waiting` once the turn has started, which a prompt or a chunk
    does.
  - It refuses an `answer` to a prompt that is not open, including one that
    already got `PROMPT_EXPIRED`.
  - After the asker's `cancel`, it refuses an `answer`, a `prompt`, a `waiting`
    and a second `cancel` for that turn (#170). The runner still finishes it.
  - It refuses an `ack` before a terminal chunk, or a second `ack`.
  - It refuses a second `attach` for a turn on the same socket.
  - A turn that arrived by `attach` may be sent only its terminal chunk.
  - It refuses a refusal of a turn that is already over, so an app is handed
    one terminal per turn.
  - It refuses `WAIT_LIST_FULL`, `HOST_DOES_NOT_RUN_TURNS` and
    `TOOL_LOOP_UNSUPPORTED` once a turn has started, because each says nothing
    ran. It refuses `RESULT_UNKNOWN` for a
    turn that did not come by `attach`, and any code in `REFUSALS` other than
    `FRAME_UNEXPECTED` from the end that asked for the turn.

  A frame from the peer that breaks one of these is dropped unread and answered
  `FRAME_UNEXPECTED`, and the tunnel stays open. The exception is a refusal of a
  turn that is already over, which is dropped and not answered: two refusals of
  one turn crossing on the wire look exactly like that. A frame this end tries
  to send in the wrong state throws `TunnelProtocolError`.
- **Memory per tunnel is bounded.** A tunnel holds at most `MAX_OPEN_TURNS` (64)
  open turns for each end that asks; past that, a peer's `turn`, `attach` or
  unasked-for `chunk` is refused and not recorded, and this end's own throws.
  It remembers the last `MAX_ENDED_TURNS_REMEMBERED` (64) ended turns, and
  forgets a result that is still waiting for its `ack` last.
- **A refusal of every turn is final for the tunnel.** An `error` that names no
  turn, with a code that ends turns, ends every turn its sender runs. The end
  that receives it may ask for nothing more on that tunnel, and a `turn` or
  `attach` that crossed it on the wire is answered with the same code and never
  read, so both ends agree the turn never ran. A host that means to take turns
  on the same tunnel again, after a suspend for example, refuses its running
  turns one at a time instead.
- **One sequence count per turn, not per tunnel.** A second turn on the same
  socket numbers its reply from 0, as an IR stream does. The guard used to read
  that as a repeat. An `attach` resumes a turn's count at the held terminal's
  own number.
- **`resolveAttach` is the rule for collecting.** The device is whatever
  credential authenticated the socket (#135), never a field in the frame.
  Another device's held result, an expired one and one that was never held all
  get the same answer, `RESULT_UNKNOWN`.
- **The client reads each frame for an app.** `classifyFrame` returns
  `waiting`, `prompt`, `streaming`, `completed`, `failed` or `refused`. A
  refusal says which kind it is (busy, quitting, suspended, refused, …) and
  whether it ends the turn. A code this build does not know is `unrecognised`
  and ends the turn: it is a failure, never a success.

One exception is carried for now: a `chunk` for a turn this tunnel has no record
of is still read, and makes the receiver that turn's asker. Rung 0 streams
through a greeting nobody asked for, and #156's and #158's tests stream up the
wire the same way. Such a turn can never receive a `waiting` or a `prompt`, and
it counts against `MAX_OPEN_TURNS` like any other, so a peer cannot open them
without bound.

## What is deliberately not here

- **A production transport now exists** (#295): `packages/contracts/src/tunnel-socket.ts`
  declares the plugin's whole contract (`connect`, `send`, `close`,
  `negotiatedPeer`, and the three events); `native/plugin-tunnel-socket/`
  carries the iOS (`URLSessionWebSocketTask`, the pin checked in
  `didReceive challenge`) and Android (OkHttp, a per-connection
  `X509TrustManager`) implementations; `src/plugins/tunnel-socket/web.ts`
  refuses, honestly, because a browser cannot see a peer certificate;
  `apps/desktop/src/net/tunnel-socket.ts` is the Electron desktop's OWN client
  leg, run in Node in the main process, for the same reason a phone needs one —
  the owner's ruling on #295 makes the desktop a tunnel client too, not only a
  host. `src/lib/tunnel-socket-transport.ts` is the adapter from any of these to
  `createTunnelClient`'s `TunnelTransportFactory`. **The iOS and Android native
  sources have not been compiled or run** — no Xcode or Android SDK toolchain
  built them; verify them, the negative-pin test in particular, on a simulator
  and an emulator before they ship. Nothing yet calls this adapter from
  `src/ai/backends/tunnel.ts` — wiring pairing, credential storage and this
  transport together into a real `TunnelBackendAdapter` is separate work.
- **Rung 0** (#156, #157, #158) is what every transport above, including the
  real plugin, runs its protocol over: `createTunnelClient`, `createTunnelHost`
  and `createTunnelListener` speak the real wire format through the credential
  gate. **No app starts a listener** (#158). A listener that carries turns
  waits on #7, per #169's ruling.
- **Where the paired-device registry persists** (#133). `CredentialStore` is
  the seam. The only implementation forgets every phone when the process ends.
- **Handing the identity to a listener.** `identity.ts` makes the key and its
  certificates, `identity-store.ts` keeps the key, and the TLS arm accepts what
  they make. Both apps have a key loader (`apps/*/src/tunnel-identity.ts`) and
  nothing calls either; no app issues a certificate or passes one to a
  binding. Still open: key lifetime and rotation, how long a certificate lasts
  (`validDays` has no default), and whether the phone checks names or only the
  SPKI pin (#179, #180, #295).
- **The pairing exchange itself.** The wire has a `pair` frame and the listener
  confines a pairing tunnel to it. The steps it carries are not defined here:
  the CPace messages, confirmation, and handing the minted credential to the
  phone under the session key.
- **The rest of what revocation owes.** A revoked tunnel's unread frames are
  dropped, but purging a revoked device's queued *turns* (#196) needs the turn
  queue, which waits on #7. On the headless server, revoking the operator
  token must invalidate every credential minted under it (#135), and nothing
  ties the two together yet.
- **What a tunnelled turn may use** (#170), and the surface declaration
  asserted before binding. The frames a relayed prompt travels in are on the
  wire (see #7's vocabulary above); the turn runner that relays one is not.
- **Frame kinds.** `TunnelFrame['kind']` became a union in #159. `pair` joined
  it for #136's gate.
- **#7's policy.** The wire says a turn is waiting, a prompt expired, or the
  host is quitting or suspended. It does not decide any of those. None of the
  following exists yet:
  - the wait list and its limits;
  - the prompt timeout;
  - the held results and their time and count bounds;
  - replacing a device's stale socket;
  - settling turns on quit and on suspend.

  They all belong to the desktop's work broker (#7). The package sends two
  refusals by itself: `FRAME_UNEXPECTED` for a frame outside its turn's state,
  and the repeat of a refusal of every turn for a `turn` or `attach` that
  crossed it. Every other code is the app's to send, and no app sends one yet.
  `HOST_DOES_NOT_RUN_TURNS` is defined for the headless server (#7's eighth
  ruling), and nothing here sends it.

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
