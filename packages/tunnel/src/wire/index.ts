/**
 * THE WIRE: the frame envelope both halves agree on, and the codec for it.
 *
 * This is the bottom of the package. It imports nothing — not a Node builtin,
 * not a DOM type, not the client half, not the host half — because everything
 * it names becomes a dependency of the phone bundle AND of the listener at the
 * same time.
 *
 * WHY THIS IS NOT IN `packages/contracts`. #155 asks the question directly, and
 * the answer is in the guard: `tests/layering.test.ts` pins contracts as
 * types-only ("nothing to build and nothing to drift"), and a wire format is
 * not only types — it is a format plus the one pair of functions that reads and
 * writes it. Putting `TunnelFrame` in contracts and `encodeFrame` here would
 * split a format from its codec across two packages, which is precisely the
 * drift the contracts guard exists to prevent. So the whole of it lives here,
 * and contracts stays types-only.
 *
 * WHAT THIS DELIBERATELY DOES NOT DECIDE. `kind` is an open `string`, not a
 * union. The frames that exist — pairing, chunk, error, close — are #156's and
 * #157's to name, and the transport underneath is #181's to choose, which is
 * not a decision this file or this agent gets to make. What is fixed here is
 * only the shape of the envelope and the fact that a version travels in it, so
 * that a phone and a desktop on different builds disagree LOUDLY at frame one
 * rather than quietly at chunk four hundred.
 *
 * ── #159 RESOLVED THE ABOVE ───────────────────────────────────────────
 *
 * `kind` is a union now. The transport is a native socket plugin on both
 * platforms (#181) and the frames are JSON text with a transport-owned
 * correlation id (#159), so the two things this file was waiting on have
 * answers.
 *
 * WHY A CORRELATION ID AT ALL. `IRStreamChunk` describes one response and
 * carries `sequence` from `BaseStreamChunk`. A socket carries more than one
 * thing at once — a request going up, chunks coming down, a cancel mid-stream,
 * a heartbeat both ways, and a queued request being drained — and two
 * concurrent turns multiplexed on one `sequence` counter interleave into
 * nonsense. `turn` is that id.
 *
 * WHY NOT `IRMetadata.requestId`. It is documented as "stable across retries
 * and fallbacks for correlation", and a far-side Router retry keeps it BY
 * DESIGN. A value deliberately stable across retries cannot identify a stream.
 * Tempting and wrong, which is why it is written down rather than left for
 * someone to rediscover.
 *
 * WHY THE CHUNK IS A `body` AND NOT THE FRAME. `{ kind: 'chunk', turn, body }`
 * keeps the IR union on the far side of this envelope, so aimatey can add a
 * seventh chunk type without touching the wire. It is also why this file still
 * imports nothing, not even a type: the wire does not know what a chunk IS.
 * Whoever reads `body` applies `@chatterang/tunnel/codec` to it.
 *
 * WHY `kind` AND NOT A ONE-CHARACTER `k`. `apps/server/src/wire.ts` uses `k`
 * and is the precedent for the rest of this shape, but `kind` is already what
 * this envelope ships. Renaming a wire field for terseness is a breaking change
 * across two independently-updated binaries in exchange for three bytes a
 * frame, against payloads where base64 images dominate. Not worth it.
 *
 * ── #7's VOCABULARY: WAITING, PROMPTS, REFUSALS, AND COLLECTING A RESULT ──
 *
 * The owner's rulings on #7 put five things on this wire that the frames above
 * cannot say. Each is here as a frame or a code, and nothing in this file
 * decides the policy behind it — the wait list, the prompt timeout and the
 * held results are the desktop's work broker's (#7, S2 and S8), not the wire's.
 *
 * - `waiting {position}`. One slot, one first-come-first-served wait list, and
 *   whoever waits is told (#169, #7 ruling 3). A silent wait "is
 *   indistinguishable from a hung app".
 * - `prompt` and `answer`, bound to a turn AND to a prompt id (#170). A turn
 *   can raise more than one prompt, so an answer names the prompt it answers:
 *   a late answer to the first must never approve the second. How long a
 *   prompt waits is the broker's named constant; what the wire carries is the
 *   refusal when it runs out, `PROMPT_EXPIRED`, after which that call is
 *   recorded as not sent on both sides and never sent later.
 * - Refusal codes in the `error` frame's vocabulary, as data
 *   ({@link REFUSALS}), so the halves and the app read one table.
 * - `attach` and `ack`, for a result the desktop finished and held while the
 *   phone's socket was gone (#7 ruling 4, #162). `attach` names only a turn:
 *   WHICH DEVICE is asking is the credential that authenticated the socket
 *   (#135), never a field a frame could forge. {@link resolveAttach} is the
 *   rule for looking a held result up.
 * - `HOST_DOES_NOT_RUN_TURNS`, defined here so a host that will not run a
 *   phone's turn has a code the app can render. Which host sends it is not
 *   this file's to say.
 *
 * None of them carries an IR escape hatch, so `FIELD_POLICY` gains no row:
 * every field below is a string, a boolean or a safe integer, checked on the
 * way out as well as on the way in.
 */

/**
 * The envelope version, on every frame.
 *
 * A tunnel is the one place in this app where two independently-updated
 * binaries meet: the phone updates through an app store and the desktop
 * through a download, so they are routinely different builds. Version-on-every
 * frame is cheap and makes the mismatch a decode error with a number in it.
 *
 * STILL 1 AFTER #7's FRAMES WERE ADDED, deliberately: no app starts a listener
 * and no build has carried a tunnel to anyone, so there is no deployed version
 * 1 for a new kind to be incompatible with. The first build that ships a
 * tunnel is the one whose frames are version 1.
 */
export const TUNNEL_WIRE_VERSION = 1;

/**
 * The id that ties frames to one turn.
 *
 * Minted by whichever side starts the turn and echoed by the other. Opaque:
 * nothing may parse meaning out of it.
 */
export type TurnId = string;

/**
 * The id that ties an `answer` to the one `prompt` it answers (#170).
 *
 * Minted by the end that runs the turn, unique within that turn. Opaque.
 */
export type PromptId = string;

/**
 * The paired device a socket belongs to: #135's per-device credential id.
 *
 * It comes from the credential that authenticated the socket and is NEVER read
 * out of a frame. A frame is bytes from the network; a device id in one would
 * be a claim nobody verified.
 */
export type DeviceId = string;

/**
 * The largest frame this build will decode.
 *
 * Sized the way `apps/server/src/wire.ts:117` sizes its own: against the one
 * payload that is genuinely large. A turn carries base64 images inline until
 * they move to by-reference, and 8 MiB leaves room for several while refusing
 * anything an order of magnitude past it — so a peer cannot make this process
 * hold a gigabyte by announcing one. Smaller than the server's 32 MiB because
 * model weights do not cross a tunnel; turns do.
 */
export const MAX_FRAME_BYTES = 8 * 1024 * 1024;

/**
 * The longest turn or prompt id this build will read or write.
 *
 * Each end now keeps state keyed by these ids for as long as a tunnel is open
 * (`createTurnLedger` in `stream/`), and the desktop will hold results keyed by
 * them (#7). Without a bound, an id is limited only by {@link MAX_FRAME_BYTES},
 * so one frame could make a key 8 MiB long. 128 characters is more than three
 * times a UUID, and more than five times the `prefix_` plus twelve characters
 * `newId` mints (`src/domain/chat.ts`), so no id scheme this app uses comes
 * near it.
 */
export const MAX_ID_LENGTH = 128;

/**
 * The WebSocket close code a listener refuses a connection with when it is
 * already holding as many tunnels as its caller allowed (#169).
 *
 * In 4000-4999, the range RFC 6455 leaves to applications and `ws` accepts;
 * 4000 plus HTTP's 503, which is what the refusal is. It lives HERE rather than
 * in the host because the client has to recognise it and may not import the
 * host half. Without a number both ends share, a refusal reaches the phone as
 * PEER_GONE — a pulled cable mid-stream, which is neither what happened nor
 * something a screen can explain.
 */
export const TUNNEL_CAP_CLOSE_CODE = 4503;

/**
 * The close code for a PAIRING-ONLY tunnel that tried to carry something other
 * than the pairing exchange, or more of it than a pairing needs (#136). A
 * pairing window that closed is {@link TUNNEL_PAIRING_CLOSED_CLOSE_CODE}.
 *
 * A phone with no device credential reaches the listener only while the
 * desktop is showing a pairing code, and then only for the exchange. 4000 plus
 * HTTP's 403: the connection was let in, and this is not something it may do.
 * Here rather than in the host for the reason {@link TUNNEL_CAP_CLOSE_CODE} is.
 */
export const TUNNEL_PAIRING_ONLY_CLOSE_CODE = 4403;

/**
 * The close code for a PAIRING-ONLY tunnel whose pairing window has closed
 * (#136): the code it was admitted under expired, was dismissed or replaced, or
 * another connection completed the pairing — or this one did, and its time to
 * receive the credential is over.
 *
 * Its own code, not {@link TUNNEL_PAIRING_ONLY_CLOSE_CODE}: a phone whose code
 * ran out mid-exchange did nothing it may not do, and telling it otherwise
 * sends its user looking for the wrong fault. 4000 plus HTTP's 410 Gone.
 */
export const TUNNEL_PAIRING_CLOSED_CLOSE_CODE = 4410;

/**
 * The request header a paired device presents its credential in (#135, #136).
 *
 * A HEADER, NEVER THE URL. #136's ruling: a credential in a query string lands
 * in request-line logs, proxy logs and history, so the listener refuses a URL
 * that carries one rather than ignoring it. The native socket plugin (#181)
 * sets this header on the phone. Lower case because Node hands header names to
 * the listener lower-cased, and one spelling is one spelling to grep for.
 */
export const TUNNEL_CREDENTIAL_HEADER = 'chatterang-device-credential';

/**
 * A tool's prompt, as the end that runs a turn relays it to the end that asked
 * for it (#170).
 *
 * The desktop's approval sheet (`ApprovalPrompt` in `src/state/app.ts`) minus
 * everything that cannot cross or that the phone cannot honour: no callback,
 * and no `extendedLabel`. A broader yes changes a grant on the desktop, and
 * what a paired phone may grant is the phone policy's to decide (#7 ruling 2),
 * so until it does the answer is yes or no and the phone is never shown a
 * button whose effect nobody has ruled on.
 *
 * `action` is required: it is the one line every prompt has, including the bash
 * confirm, which passes nothing else (`src/shell/register.ts`).
 */
export interface RelayedPrompt {
  readonly action: string;
  readonly title?: string;
  readonly body?: string;
  readonly detail?: readonly string[];
  readonly confirmLabel?: string;
  readonly cancelLabel?: string;
}

/** Frames that belong to one turn, and carry its id. */
export type TurnFrame =
  /** A turn going up. `body` is the request; the codec decides what may cross. */
  | { readonly v: number; readonly kind: 'turn'; readonly turn: TurnId; readonly body: unknown }
  /** One `IRStreamChunk` coming down, as a payload rather than as the frame. */
  | { readonly v: number; readonly kind: 'chunk'; readonly turn: TurnId; readonly body: unknown }
  /** Stop this turn. Mid-stream, which is why it needs the id. */
  | { readonly v: number; readonly kind: 'cancel'; readonly turn: TurnId }
  /**
   * This turn is admitted and waiting for the slot (#169, #7 ruling 3).
   *
   * `position` is its place in the wait list: 1 is next once the slot frees.
   * Sent again whenever it changes, and never once the turn's first chunk has
   * gone — a turn that is streaming is not waiting.
   */
  | {
      readonly v: number;
      readonly kind: 'waiting';
      readonly turn: TurnId;
      readonly body: { readonly position: number };
    }
  /** A tool in this turn needs an answer before its call may go (#170). */
  | {
      readonly v: number;
      readonly kind: 'prompt';
      readonly turn: TurnId;
      readonly prompt: PromptId;
      readonly body: RelayedPrompt;
    }
  /** The answer to one prompt. Only a yes lets that call go. */
  | {
      readonly v: number;
      readonly kind: 'answer';
      readonly turn: TurnId;
      readonly prompt: PromptId;
      readonly body: { readonly approved: boolean };
    }
  /**
   * Collect the result of a turn this device asked for on an earlier socket
   * (#7 ruling 4). What comes back is that turn's held terminal chunk — or, if
   * it is still running, its terminal when it finishes — or `RESULT_UNKNOWN`.
   */
  | { readonly v: number; readonly kind: 'attach'; readonly turn: TurnId }
  /** This turn's terminal chunk arrived whole: whatever holds it may let it go. */
  | { readonly v: number; readonly kind: 'ack'; readonly turn: TurnId };

/**
 * One message of the pairing exchange (#130, #136).
 *
 * THE ONLY FRAME A PAIRING-ONLY TUNNEL MAY CARRY, beside `hello` and `bye`. It
 * exists so that rule has something to name: without a kind of its own, "the
 * pairing exchange and nothing else" is a sentence the listener cannot enforce.
 * `body` is the exchange's step — a CPace message, a confirmation tag, the
 * credential handed over at the end — and, like `chunk`, the wire does not know
 * what one IS. Its shape is the exchange's to define.
 */
export type PairFrame = { readonly v: number; readonly kind: 'pair'; readonly body: unknown };

/** Frames about the connection rather than about a turn. */
export type ControlFrame =
  /**
   * First frame, both directions. `protocol` is checked and a mismatch is a
   * refusal with a number in it — see {@link TUNNEL_WIRE_VERSION}.
   */
  | {
      readonly v: number;
      readonly kind: 'hello';
      readonly body: { readonly protocol: number; readonly build?: string };
    }
  | { readonly v: number; readonly kind: 'ping' }
  | { readonly v: number; readonly kind: 'pong' }
  /** Going away on purpose, so the far side can tell it from a dropped link. */
  | { readonly v: number; readonly kind: 'bye'; readonly body?: { readonly reason?: string } }
  /**
   * A TRANSPORT-level failure, or a refusal (see {@link REFUSALS}).
   *
   * Deliberately distinct from `StreamErrorChunk`, which is a model-level error
   * the far side produced and which travels inside a `chunk` frame. Collapsing
   * the two is exactly how a transport failure gets reported to the user as a
   * model failure — the defect #148 was ruled on. `turn` is present when the
   * failure belongs to one, and `prompt` when it belongs to one of that turn's
   * prompts; a `prompt` without a `turn` is refused.
   */
  | {
      readonly v: number;
      readonly kind: 'error';
      readonly turn?: TurnId;
      readonly prompt?: PromptId;
      readonly body: { readonly code: string; readonly message: string };
    };

/** One frame on the tunnel. */
export type TunnelFrame = TurnFrame | ControlFrame | PairFrame;

/** Every `kind` this build knows, for validation and for exhaustive tests. */
export const FRAME_KINDS = [
  'turn',
  'chunk',
  'cancel',
  'waiting',
  'prompt',
  'answer',
  'attach',
  'ack',
  'hello',
  'ping',
  'pong',
  'bye',
  'error',
  'pair',
] as const;

export type FrameKind = (typeof FRAME_KINDS)[number];

/** The kinds that belong to a turn and must carry its id. */
export type TurnScopedKind = TurnFrame['kind'];

/**
 * The kinds that must carry a {@link TurnId}.
 *
 * A type predicate rather than a `Set.has` call, because `has` returns a
 * boolean and narrows nothing — the decoder below would then be building a
 * union member from a `kind` the compiler still believes could be `ping`.
 */
export function isTurnScoped(kind: FrameKind): kind is TurnScopedKind {
  return (
    kind === 'turn' ||
    kind === 'chunk' ||
    kind === 'cancel' ||
    kind === 'waiting' ||
    kind === 'prompt' ||
    kind === 'answer' ||
    kind === 'attach' ||
    kind === 'ack'
  );
}

/**
 * What a refusal means to the end that receives it, as one table (#7).
 *
 * - `kind` is what an app renders: busy, quitting, suspended and refused are
 *   four different sentences, and "the connection closed" is none of them.
 * - `scope` is what the `error` frame must name: a `turn`, a turn AND a
 *   `prompt`, either a turn or nothing (a refusal of the whole connection), or
 *   anything. The decoder enforces it, so a refusal cannot arrive attached to
 *   the wrong thing.
 * - `endsTurn` is whether the turn it names is over. A refusal that names no
 *   turn and ends turns ends every turn its sender was running on the tunnel.
 */
export type RefusalKind =
  /** `WAIT_LIST_FULL`: nothing ran, and the host may take it later. */
  | 'busy'
  /** `DESKTOP_QUITTING`: the desktop is quitting or its tunnel was switched off. */
  | 'quitting'
  /** `HOST_SUSPENDED`: the host is going to sleep and does not keep itself awake (#7 ruling 7). */
  | 'suspended'
  /** `HOST_DOES_NOT_RUN_TURNS`: this host does not run a paired device's turns. */
  | 'refused'
  /** `PROMPT_EXPIRED`: that call was refused and recorded as not sent; the turn goes on (#170). */
  | 'prompt-expired'
  /** `RESULT_UNKNOWN`: nothing is held for this device under that turn. */
  | 'result-unknown'
  /** `FRAME_UNEXPECTED`: the far side dropped one of this end's frames unread. */
  | 'unexpected'
  /** A code this build does not know. Read as a failure, never as success. */
  | 'unrecognised';

export type RefusalScope = 'turn' | 'turn-or-connection' | 'prompt' | 'any';

export interface Refusal {
  readonly kind: RefusalKind;
  readonly scope: RefusalScope;
  readonly endsTurn: boolean;
}

/**
 * Every refusal code this build defines. Policy as data, for the reason
 * `FIELD_POLICY` in `codec/` is: a code added as a branch somewhere is a code
 * one of the two halves does not know about.
 *
 * `FRAME_UNEXPECTED` is what an end answers a frame with when that frame is
 * outside its turn's state — a `waiting` for a turn nobody asked for, an
 * `answer` to a prompt that already expired, a second `attach`. The frame is
 * dropped unread and the turn it names goes on; see `createTurnLedger`.
 *
 * `RESULT_UNKNOWN` is ONE answer for four situations on purpose: nothing was
 * ever held, it expired, it was already acknowledged, or it belongs to another
 * device. Telling those apart would let one paired device find out which turn
 * ids another has used, the way a cancel from anyone but the owner looks the
 * same as "not running" in `apps/desktop/src/bridge/supervisor.ts`.
 */
export const REFUSALS = Object.freeze({
  WAIT_LIST_FULL: Object.freeze({ kind: 'busy', scope: 'turn', endsTurn: true }),
  DESKTOP_QUITTING: Object.freeze({ kind: 'quitting', scope: 'turn-or-connection', endsTurn: true }),
  HOST_SUSPENDED: Object.freeze({ kind: 'suspended', scope: 'turn-or-connection', endsTurn: true }),
  HOST_DOES_NOT_RUN_TURNS: Object.freeze({
    kind: 'refused',
    scope: 'turn-or-connection',
    endsTurn: true,
  }),
  PROMPT_EXPIRED: Object.freeze({ kind: 'prompt-expired', scope: 'prompt', endsTurn: false }),
  RESULT_UNKNOWN: Object.freeze({ kind: 'result-unknown', scope: 'turn', endsTurn: true }),
  FRAME_UNEXPECTED: Object.freeze({ kind: 'unexpected', scope: 'any', endsTurn: false }),
} as const satisfies Readonly<Record<string, Refusal>>);

export type RefusalCode = keyof typeof REFUSALS;

/**
 * What a code this build does not know is read as: a failure that ends the turn.
 *
 * FAILS CLOSED. A newer peer's refusal read as anything else would leave a
 * phone showing a turn as still running that the far side has already given
 * up on — or, worse, one rendered as finished.
 */
export const UNRECOGNISED_REFUSAL: Refusal = Object.freeze({
  kind: 'unrecognised',
  scope: 'any',
  endsTurn: true,
});

/**
 * The refusal a code names. `Object.hasOwn`, not `in`: `'toString' in REFUSALS`
 * is true, and a peer that sent `toString` as a code would otherwise be read
 * as a function.
 */
export function refusalOf(code: string): Refusal {
  return Object.hasOwn(REFUSALS, code) ? REFUSALS[code as RefusalCode] : UNRECOGNISED_REFUSAL;
}

/**
 * A result a host is holding for a device, as far as the attach rule needs it.
 * Whatever holds results (#7, S8) may keep more; this is the part the rule reads.
 */
export interface HeldResult {
  readonly device: DeviceId;
  readonly turn: TurnId;
}

export type AttachAnswer<H extends HeldResult> =
  | { readonly ok: true; readonly held: H }
  | { readonly ok: false; readonly code: 'RESULT_UNKNOWN' };

/**
 * THE ATTACH RULE (#7 ruling 4): which held result an `attach` collects.
 *
 * - `device` is the credential that authenticated the socket the `attach`
 *   arrived on (#135), never anything in the frame.
 * - A held result is collected only by the device it was held for. Another
 *   device's result under the same turn id is `RESULT_UNKNOWN`, exactly as if
 *   nothing were held — see {@link REFUSALS} on why the answers are one.
 * - An unauthenticated socket (an empty device) collects nothing.
 * - Two held results for one device and turn is the holder's bug, and neither
 *   is delivered: handing over one of two would be guessing which reply is
 *   this turn's.
 *
 * A SECOND `attach` for the same turn on the same socket never reaches this
 * function: each end refuses it as `FRAME_UNEXPECTED` before it is read (see
 * `createTurnLedger`). An `attach` on a NEW socket is not a duplicate — it is
 * how a reconnecting device collects — and replacing that device's stale socket
 * with the new one is the holder's work, not the wire's.
 */
export function resolveAttach<H extends HeldResult>(
  held: Iterable<H>,
  device: DeviceId,
  turn: TurnId,
): AttachAnswer<H> {
  if (typeof device !== 'string' || device === '') return { ok: false, code: 'RESULT_UNKNOWN' };
  let found: H | null = null;
  for (const entry of held) {
    if (entry.device !== device || entry.turn !== turn) continue;
    if (found) return { ok: false, code: 'RESULT_UNKNOWN' };
    found = entry;
  }
  return found ? { ok: true, held: found } : { ok: false, code: 'RESULT_UNKNOWN' };
}

/** Raised when bytes on the wire are not a frame this build can read. */
export class TunnelWireError extends Error {
  override readonly name = 'TunnelWireError';
}

const TEXT = { encode: new TextEncoder(), decode: new TextDecoder('utf-8', { fatal: true }) };

/**
 * Which way a frame is being read.
 *
 * `decode` is bytes from a peer: a field this build does not know is dropped,
 * as a `ping` given a body is. `encode` is a frame this end is about to write,
 * and for #7's frames a field that is not part of the frame is REFUSED rather
 * than dropped — the codec's asymmetry (`codec/`): what we write and would lose
 * on the way is our bug, and a relayed prompt that silently lost a field would
 * show the phone a different sheet from the one the desktop meant.
 */
type Reading = 'decode' | 'encode';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** An id, or a thrown refusal naming which id and which frame. */
function readId(value: unknown, what: 'turn' | 'prompt', kind: FrameKind): string {
  if (typeof value !== 'string' || value === '') {
    throw new TunnelWireError(`${kind} frame has no ${what} id`);
  }
  if (value.length > MAX_ID_LENGTH) {
    throw new TunnelWireError(
      `${kind} frame's ${what} id is ${String(value.length)} characters, over the ${String(MAX_ID_LENGTH)} limit`,
    );
  }
  return value;
}

/** For a frame this end writes: nothing beyond the named fields. */
function onlyKeys(
  record: Record<string, unknown>,
  allowed: readonly string[],
  where: string,
  reading: Reading,
): void {
  if (reading !== 'encode') return;
  const extra = Reflect.ownKeys(record).filter(
    (key) => typeof key !== 'string' || !allowed.includes(key),
  );
  if (extra.length > 0) {
    throw new TunnelWireError(
      `${where} carries ${extra.map((key) => String(key)).join(', ')}, which is not part of it and would not arrive as written`,
    );
  }
}

const PROMPT_TEXT_FIELDS = ['title', 'body', 'confirmLabel', 'cancelLabel'] as const;
const PROMPT_FIELDS = ['action', ...PROMPT_TEXT_FIELDS, 'detail'] as const;

function readPrompt(value: unknown, reading: Reading): RelayedPrompt {
  if (!isRecord(value)) throw new TunnelWireError('prompt frame has no body');
  onlyKeys(value, PROMPT_FIELDS, 'prompt body', reading);
  const action = value.action;
  if (typeof action !== 'string' || action === '') {
    throw new TunnelWireError('prompt frame has no action');
  }
  const prompt: { -readonly [K in keyof RelayedPrompt]: RelayedPrompt[K] } = { action };
  for (const field of PROMPT_TEXT_FIELDS) {
    const text = value[field];
    if (text === undefined) continue;
    if (typeof text !== 'string') throw new TunnelWireError(`prompt frame's ${field} is not a string`);
    prompt[field] = text;
  }
  const detail = value.detail;
  if (detail !== undefined) {
    if (!Array.isArray(detail)) throw new TunnelWireError("prompt frame's detail is not a list");
    const lines: string[] = [];
    // Indexed, not `every`: `every` skips the holes of a sparse array, and a
    // hole is a line JSON would write as `null`.
    for (let index = 0; index < detail.length; index += 1) {
      const line: unknown = detail[index];
      if (typeof line !== 'string') {
        throw new TunnelWireError(`prompt frame's detail line ${String(index)} is not a string`);
      }
      lines.push(line);
    }
    prompt.detail = lines;
  }
  return prompt;
}

/**
 * The per-arm check both {@link decodeFrame} and {@link encodeFrame} run.
 *
 * ONE VALIDATOR, BOTH DIRECTIONS. A frame this end writes is checked against
 * the same rules the far end will decode it with, so a field JSON would change
 * — a `NaN` position that arrives as `null`, a `detail` line that is a number —
 * is refused here, at the send, rather than at the far end as an invalid frame
 * that closes the tunnel.
 */
function readFrame(frame: Record<string, unknown>, reading: Reading): TunnelFrame {
  if (frame.v !== TUNNEL_WIRE_VERSION) {
    throw new TunnelWireError(
      `frame version ${String(frame.v)} is not ${String(TUNNEL_WIRE_VERSION)}`,
    );
  }

  const kind = frame.kind;
  if (typeof kind !== 'string' || !FRAME_KINDS.includes(kind as FrameKind)) {
    // Naming what arrived, because the common cause is a peer on a build that
    // knows a kind this one does not — and the number alone does not say which.
    throw new TunnelWireError(`unknown frame kind ${JSON.stringify(kind)}`);
  }
  const k = kind as FrameKind;
  const v = TUNNEL_WIRE_VERSION;

  /*
   * Per-arm validation, not a cast.
   *
   * The previous version checked `kind` was a non-empty string and returned
   * `body` unexamined, which is fine for an open envelope and wrong for a
   * union: downstream code that switches on `kind` would then be trusting a
   * shape nothing checked. Bytes here have been on a network and are from
   * another build.
   */
  if (isTurnScoped(k)) {
    const turn = readId(frame.turn, 'turn', k);
    switch (k) {
      case 'cancel':
        return { v, kind: k, turn };
      case 'turn':
      case 'chunk':
        return { v, kind: k, turn, body: frame.body };
      case 'attach':
      case 'ack':
        onlyKeys(frame, ['v', 'kind', 'turn'], `${k} frame`, reading);
        return { v, kind: k, turn };
      case 'waiting': {
        onlyKeys(frame, ['v', 'kind', 'turn', 'body'], 'waiting frame', reading);
        const body = frame.body;
        if (!isRecord(body)) throw new TunnelWireError('waiting frame has no body');
        onlyKeys(body, ['position'], 'waiting body', reading);
        const position = body.position;
        // A safe integer, because past 2^53 JSON silently rounds it; at least
        // 1, because 0 is "running", which a waiting frame is not.
        if (typeof position !== 'number' || !Number.isSafeInteger(position) || position < 1) {
          throw new TunnelWireError(
            `waiting frame's position ${JSON.stringify(position) ?? String(position)} is not a whole number from 1`,
          );
        }
        return { v, kind: k, turn, body: { position } };
      }
      case 'prompt': {
        onlyKeys(frame, ['v', 'kind', 'turn', 'prompt', 'body'], 'prompt frame', reading);
        const prompt = readId(frame.prompt, 'prompt', k);
        return { v, kind: k, turn, prompt, body: readPrompt(frame.body, reading) };
      }
      case 'answer': {
        onlyKeys(frame, ['v', 'kind', 'turn', 'prompt', 'body'], 'answer frame', reading);
        const prompt = readId(frame.prompt, 'prompt', k);
        const body = frame.body;
        if (!isRecord(body)) throw new TunnelWireError('answer frame has no body');
        onlyKeys(body, ['approved'], 'answer body', reading);
        // A boolean, not truthiness: `"no"` is truthy, and a yes is the one
        // answer that lets a call leave.
        if (typeof body.approved !== 'boolean') {
          throw new TunnelWireError('answer frame has no yes or no');
        }
        return { v, kind: k, turn, prompt, body: { approved: body.approved } };
      }
    }
  }

  if (k === 'hello') {
    const body = frame.body;
    if (typeof body !== 'object' || body === null) {
      throw new TunnelWireError('hello frame has no body');
    }
    const { protocol, build } = body as Record<string, unknown>;
    if (typeof protocol !== 'number' || !Number.isInteger(protocol)) {
      throw new TunnelWireError('hello frame has no protocol number');
    }
    return {
      v,
      kind: 'hello',
      body: typeof build === 'string' ? { protocol, build } : { protocol },
    };
  }

  if (k === 'error') {
    const body = frame.body;
    if (typeof body !== 'object' || body === null) {
      throw new TunnelWireError('error frame has no body');
    }
    const { code, message } = body as Record<string, unknown>;
    if (typeof code !== 'string' || typeof message !== 'string') {
      throw new TunnelWireError('error frame has no code and message');
    }
    /*
     * PRESENT MEANS VALID. An id that is there but malformed used to be dropped
     * quietly, which turned a refusal of one turn into a refusal that named
     * none — and a refusal naming no turn ends every turn its sender runs.
     */
    const turn = frame.turn === undefined ? undefined : readId(frame.turn, 'turn', k);
    const prompt = frame.prompt === undefined ? undefined : readId(frame.prompt, 'prompt', k);
    if (prompt !== undefined && turn === undefined) {
      throw new TunnelWireError('error frame names a prompt but no turn');
    }
    // A code this build defines is held to its scope. One it does not know is
    // carried as it came, and read as a failure (see UNRECOGNISED_REFUSAL).
    if (Object.hasOwn(REFUSALS, code)) {
      const { scope } = REFUSALS[code as RefusalCode];
      if ((scope === 'turn' || scope === 'prompt') && turn === undefined) {
        throw new TunnelWireError(`${code} must name the turn it refuses`);
      }
      if (scope === 'prompt' && prompt === undefined) {
        throw new TunnelWireError(`${code} must name the prompt it refuses`);
      }
      if ((scope === 'turn' || scope === 'turn-or-connection') && prompt !== undefined) {
        throw new TunnelWireError(`${code} refuses a turn, not a prompt`);
      }
    }
    return {
      v,
      kind: 'error',
      ...(turn === undefined ? {} : { turn }),
      ...(prompt === undefined ? {} : { prompt }),
      body: { code, message },
    };
  }

  if (k === 'pair') {
    // Carried, not interpreted: see `PairFrame`. Required, because a pairing
    // step with nothing in it is not a step.
    if (!('body' in frame)) throw new TunnelWireError('pair frame has no body');
    return { v, kind: 'pair', body: frame.body };
  }

  if (k === 'bye') {
    const body = frame.body;
    const reason =
      typeof body === 'object' && body !== null
        ? (body as Record<string, unknown>).reason
        : undefined;
    return typeof reason === 'string' ? { v, kind: 'bye', body: { reason } } : { v, kind: 'bye' };
  }

  // ping and pong carry nothing, and must not be given anything on the way out.
  return { v, kind: k };
}

/**
 * A frame, as bytes — or a thrown {@link TunnelWireError} if it is not one the
 * far end could read back as written.
 *
 * `TextEncoder` rather than `Buffer`: this runs on the phone as well as on the
 * desktop, and `Buffer` is the Node half of a boundary this package exists to
 * keep. The same reason there is no `JSON.stringify` shortcut taken over a
 * `Uint8Array` return — the caller on either side hands bytes to a socket.
 *
 * WHAT IS WRITTEN IS THE CHECKED FRAME, not the object handed in. A field the
 * frame does not have never reaches the socket; for #7's frames it is refused
 * rather than dropped (see `Reading`). A `turn` or `chunk` body is still
 * written as given: what may cross inside one is the codec's to decide.
 */
export function encodeFrame(frame: TunnelFrame): Uint8Array {
  const checked = readFrame({ ...frame, v: TUNNEL_WIRE_VERSION }, 'encode');
  return TEXT.encode.encode(JSON.stringify(checked));
}

/**
 * Bytes, as a frame — or a thrown {@link TunnelWireError}.
 *
 * Throwing rather than returning a partial frame is the point. A tunnel peer is
 * not this process and is not this build; bytes arriving here have been on a
 * network and may be from anything. Every field is checked before the value
 * escapes this function, so nothing downstream has to ask whether `kind` is
 * really a string.
 */
export function decodeFrame(bytes: Uint8Array): TunnelFrame {
  // Size first, before parsing. A peer that announces 900 MiB should not get
  // this process to allocate it in order to find out the frame was invalid.
  if (bytes.byteLength > MAX_FRAME_BYTES) {
    throw new TunnelWireError(
      `frame is ${String(bytes.byteLength)} bytes, over the ${String(MAX_FRAME_BYTES)} limit`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(TEXT.decode.decode(bytes));
  } catch (cause) {
    throw new TunnelWireError('frame is not UTF-8 JSON', { cause });
  }
  if (!isRecord(parsed)) {
    throw new TunnelWireError('frame is not an object');
  }
  return readFrame(parsed, 'decode');
}

/**
 * Is a peer's `hello` one this build can talk to? (#159)
 *
 * Separate from {@link decodeFrame} because they answer different questions: a
 * frame can be perfectly well-formed and still come from a build this one
 * cannot speak to. Both sides call this, and a refusal is an `error` frame with
 * a number in it rather than a dropped connection — a phone and a desktop will
 * be on different app versions constantly, and "it just stopped working" is the
 * outcome this exists to prevent.
 */
export function checkPeerProtocol(protocol: number): { ok: true } | { ok: false; reason: string } {
  if (protocol === TUNNEL_WIRE_VERSION) return { ok: true };
  return {
    ok: false,
    reason:
      protocol > TUNNEL_WIRE_VERSION
        ? `the other device speaks tunnel protocol ${String(protocol)}; this one speaks ${String(TUNNEL_WIRE_VERSION)}. Update this app.`
        : `the other device speaks tunnel protocol ${String(protocol)}; this one speaks ${String(TUNNEL_WIRE_VERSION)}. Update the other device.`,
  };
}
