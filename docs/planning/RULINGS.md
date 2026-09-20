# Owner rulings made on 2026-09-14 (binding on every critical-path brief)

These override anything in `critical-path-plan.json` that contradicts them.

## First paired-turn batch
- **Cloud reach (#296):** a phone's turn run by the desktop MAY be diverted to the desktop's own nominated cloud fallback (desktop model failure, heat). The phone is told afterwards, in the reply's label, what answered. The desktop's provider connections and fallback load where phone turns run. Open: whether the phone may pick one of the desktop's cloud models directly. The plan's "never divert a phone turn on the desktop" (S4-U5 no-divert flag, worker boot without provider connections) is OVERTURNED for the desktop side. The phone side is unchanged: a phone's turn to its paired desktop is not diverted by the phone to the phone's own providers (#188).
- **Phone tools (#170):** an allowed bash is the desktop's OWN shell — `/chats`, granted folders, and desktop-changing commands — with every confirm relayed to the phone. "No shell session of its own" means no separate session. MCP tools stay sensitive and still need their grant on the desktop; their send sheets are relayed to the phone. The phone-tools setting must name what bash reaches, plainly.
- **Not-sent records (#170):** kept IN FULL, exact arguments included, on the phone AND on the desktop. Amends #7 ruling 2 for these records. Open: where the desktop keeps them, retention, and deletion (must be covered by the desktop's delete and reset paths).
- **Phone name (#129):** the phone's pairing sheet offers an editable name; the desktop's accept prompt shows it ("Pair with <device name>?"), keeps it in the paired-devices list, and allows renaming. Names with hidden or direction-changing characters are refused (`src/features/pairing/wording.ts`).

Consequence for the inbound privacy copy (#221): it must say a phone's turn can leave the desktop for its nominated cloud provider, can read the desktop's conversations and granted folders through bash when bash is allowed, and that the desktop keeps not-sent records.

## Second batch
- **Show pairing code (#127):** if the tunnel is off, showing a code turns it on (tray icon showing) for as long as the code is shown. No phone pairs before the sheet closes → listening stops again. A phone pairs → the tunnel stays on until the person turns it off.
- **After restart (#158):** the tunnel is OFF at every launch; never remembered, never asked. Only the person (or showing a code) turns it on.
- **Phone credential (#135):** iOS Keychain (this device only) / Android Keystore-backed storage excluded from backups. The web layer holds only a reference (`credentialRef`); the native plugin reads the secret. Never in the app database, never in the shell VFS. Native secure-storage code is on the critical path before phone registration.
- **Desktop not-sent records (#170):** per phone, in the desktop's app data beside the paired-devices records; shown under that phone with a Clear control; deleted when the phone is removed or the desktop's pairing is reset. No time-based expiry.

## Tool-call parsing (stopped-empty-reply branch)
- **Fenced JSON calls:** a fenced JSON block runs as a tool call when its name is a tool the request offered (by id or name). Extra keys such as `"id"` are allowed. The earlier "only tool/name/function/arguments/parameters/input keys" rule is dropped. Ordinary JSON never runs because its name is not an offered tool.
- **The branch keeps iterating** review-and-fix rounds until a round finds nothing medium or higher.

## Tool-call shapes (ruled 2026-09-19, confirming what the branch does)
- **A fenced JSON block with an extra key and no `arguments` key is words, not a call.** "Extra keys are allowed" means keys beside a name AND its arguments, so `{"id": "call_0", "name": "get_datetime"}` does not run, and neither does `{"name": "calculator", "version": "1.0.0"}` when `calculator` is an offered tool. A real no-argument call carries an arguments key.
- **A `[tool name({…})]` repeated in one turn with the same name and arguments is a recount, not a retry.** It is stripped, not run and not recorded, so a model narrating its own call in the app's history form never runs the tool twice. A deliberate retry written that exact way after an error does not run; the same call written with the tool's id still does.

## Earlier today
- A desktop turn holds the work broker's shared slot for the whole turn, tool calls included (#7).
- A reply stopped before its first word is kept, marked "Stopped", and never sent to the model.
- Deleting the chat a draft is written in discards the draft and its images at once; Settings' delete-all empties the composer (in every tab).
- Pairing code: URI cap 296; drop addresses, keep the name; refuse multi-block OAT frames (#127).
