# `@chatterang/tunnel`

Transport code for two Chatterangs on one network (epic #153). This package is
the **boundary**; the transport that goes inside it is #156, #157 and #181.

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

## What is deliberately not here

- **A transport.** #181 has not chosen between plaintext LAN with an
  application-layer handshake and a native socket plugin. Both seams
  (`createTunnelClient`, `createTunnelHost`) throw with the ticket number.
- **`TunnelBinding`.** It belongs in `src/host/`, modelled on
  `apps/server/src/binding.ts` — bind address and credentials as one union, so
  the unsafe combination cannot be written down. Its *arms* are #181's decision,
  and arms invented for both options would sanction whichever loses.
- **Frame kinds.** `TunnelFrame['kind']` is an open `string`. The frames are
  #156's and #157's to name.

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
