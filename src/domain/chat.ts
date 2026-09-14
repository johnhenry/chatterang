/**
 * Conversation model.
 *
 * Messages are stored in a shape close to the aimatey IR so that turning a
 * thread into an `IRChatRequest` is a projection, not a translation. Each
 * assistant message records which backend actually served it — that is what
 * lets a single thread honestly mix local and remote turns (PRD §3.5).
 */

import type { WarningCategory } from '@johnhenry/aimatey-types';

import type { EngineId, SamplerSettings } from './manifest';
import type { McpCallReceipt } from './mcp';

export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

export interface ImageAttachment {
  readonly kind: 'image';
  readonly id: string;
  readonly mediaType: string;
  /**
   * Size of the payload, for labelling. The bytes themselves live in the
   * `blobs` table keyed by this attachment's id — see src/lib/blobs.ts for why
   * they are not inline any more.
   */
  readonly bytes?: number;
  readonly width?: number;
  readonly height?: number;
}

export interface AudioAttachment {
  readonly kind: 'audio';
  readonly id: string;
  readonly mediaType: string;
  /** See ImageAttachment.bytes — the payload lives in the `blobs` table. */
  readonly bytes?: number;
  readonly durationMs?: number;
  readonly transcript?: string;
}

export type Attachment = ImageAttachment | AudioAttachment;

export interface ToolInvocation {
  readonly id: string;
  readonly name: string;
  readonly input: Record<string, unknown>;
  readonly output?: string;
  readonly isError?: boolean;
  readonly durationMs?: number;
  /**
   * Present when this call's arguments were handed to an MCP server. It moves
   * with its generation, as the rest of the invocation does.
   */
  readonly receipt?: McpCallReceipt;
}

/**
 * A device this install has paired with, as it was at the moment of the turn.
 *
 * COPIED IN, NEVER LOOKED UP. `src/domain/` may not import `@/db`, and more to
 * the point a provenance record is permanent while a pairing is not: a
 * transcript from March has to keep rendering after the desktop it names has
 * been unpaired, renamed, or thrown away. A record that stored only an id and
 * resolved the name at render time would go blank exactly when the user most
 * needs to read it.
 *
 * Both fields, because they answer different questions. `name` is the only
 * thing that can be shown to a person — "your desktop" is not a true label
 * when a user has paired three of them — and it is a snapshot, which is the
 * honest thing for it to be: it says what the device was called when the
 * reply came back. `id` is the stable join key, so a later screen can still
 * group turns by device across a rename, and so two desktops that share a
 * name are still two devices.
 */
export interface PairedDevice {
  /** Pairing id. Stable across a rename; not reused after unpairing. */
  readonly id: string;
  /** The device's name AS IT WAS when this turn ran. */
  readonly name: string;
}

/**
 * How far a reply travelled. Three destinations, one value.
 *
 * This replaces `local: boolean`, which had two answers for a question that
 * now has three. A paired desktop is neither: the bytes left this phone, so
 * it is not `local`, and no third party received them, so it is not `remote`
 * in the sense every surface in this app means by that word. A boolean cannot
 * hold that, and the failure mode of making it hold that is not cosmetic —
 * `local: true` for a tunnel removes the egress sheet (#144, #188), and
 * `local: false` raises a third-party consent prompt for the user's own
 * machine.
 *
 * It is a discriminated union rather than a bare string plus an optional
 * device field, for the reason {@link MessageVariant} is a record rather than
 * a string: the invalid state should not be constructible. "Paired, but the
 * app cannot say which device" is exactly as useless as "Remote", and a
 * `reach: 'paired'` with a `pairedDevice` someone forgot to set would render
 * as the label this whole change exists to stop the app printing.
 *
 * NOTHING WRITES `paired` YET. The producer is the tunnel (Track B), and the
 * chip and the copy that render it are #210–#219. What lands here is the shape
 * those tickets consume, so that none of them has to invent a private third
 * value of its own.
 */
/**
 * Where the process that produced the reply was running.
 *
 * Half of {@link Reach}. See there for why this is not one axis.
 */
export type ReachHost =
  /** A process on this device. */
  | { readonly kind: 'device' }
  /** A process on a device the user paired. */
  | { readonly kind: 'paired'; readonly device: PairedDevice }
  /** A third party's infrastructure. */
  | { readonly kind: 'third-party' };

/**
 * The furthest the bytes travelled. The other half of {@link Reach}.
 *
 * Ordered by distance, and that order is the whole point: `device` is the only
 * value for which nothing left, and `third-party` is the only one where someone
 * other than the user received anything.
 */
export type ReachDestination = 'device' | 'paired' | 'third-party';

/**
 * How far a reply travelled: WHERE IT RAN, and HOW FAR THE BYTES WENT.
 *
 * Two axes, because one is not enough and we know exactly which case proves it
 * (#112). A `claude` or `codex` CLI is a process ON THIS MACHINE, reading this
 * filesystem — and its tokens reach a vendor API. Under the old three-arm
 * union that turn had to be labelled `device` or `remote`, and both are wrong
 * in a way that matters:
 *
 *   labelled `device`  -> no egress sheet for a turn reaching a third party,
 *                         and this app's taint marks ship to a vendor
 *   labelled `remote`  -> correct security, and the app can no longer say the
 *                         thing the user most needs to know: a program on YOUR
 *                         machine, with YOUR filesystem, made that call
 *
 * The old three arms are the diagonal of the pair, and the CLI case is the
 * first off-diagonal one. Keeping them as one axis meant every new destination
 * was another member — a fifth, then a sixth — until the union stopped being
 * legible, which is the accretion #191's ruling warned about.
 *
 * INVALID PAIRS ARE NOT CONSTRUCTIBLE BY THE EXPORTED API. `host` third-party
 * with `reached: 'device'` is nonsense — someone else's machine cannot serve a
 * turn without the bytes leaving. The type does not forbid it; the four
 * constructors below are the only supported way to build one, the same
 * discipline `MessageVariant` uses.
 *
 * NOTHING WRITES `paired` YET. The producer is the tunnel (Track B). What
 * lands here is the shape #210-#219 consume, so none of them invents its own.
 */
export interface Reach {
  readonly host: ReachHost;
  readonly reached: ReachDestination;
}

/** Ran here, and nothing left. */
export const REACH_DEVICE: Reach = Object.freeze({
  host: Object.freeze({ kind: 'device' as const }),
  reached: 'device' as const,
});

/** Ran on a third party's machine, which therefore received the bytes. */
export const REACH_REMOTE: Reach = Object.freeze({
  host: Object.freeze({ kind: 'third-party' as const }),
  reached: 'third-party' as const,
});

/**
 * Ran HERE, and reached a third party anyway (#112).
 *
 * A locally-hosted process with a vendor upstream — an agent CLI signed in to
 * an API. The one combination the old union could not say, and the reason
 * there are two axes.
 */
export const REACH_LOCAL_VIA_THIRD_PARTY: Reach = Object.freeze({
  host: Object.freeze({ kind: 'device' as const }),
  reached: 'third-party' as const,
});

/** Ran on one named paired device, which therefore received the bytes. */
export function reachPaired(device: PairedDevice): Reach {
  return {
    host: { kind: 'paired', device: { id: device.id, name: device.name } },
    reached: 'paired',
  };
}

/**
 * What this app stores and shows when a turn did not go cleanly (#149).
 *
 * MOVED HERE FROM `ai/warnings.ts` BY #259, and the move is the fix rather
 * than tidying. `Provenance` has to carry these to persist them, `Provenance`
 * lives in `domain/`, and `tests/layering.test.ts` forbids `domain/` importing
 * `@/ai` — so while this type lived under `ai/` there was no legal way for a
 * persisted record to hold one. The warnings channel could not reach the
 * database because of where its type was declared.
 *
 * It was always the persisted shape. `ai/warnings.ts` argues it at length:
 * `IRWarning` is defined upstream in `@johnhenry/aimatey-types`, and
 * persisting it verbatim would put a shape this repo does not own into the
 * database where an upstream change becomes a migration. This is the
 * projection that is ours — so `domain/`, with the other persisted shapes, is
 * where it belonged all along.
 *
 * Deliberately small. A warning is read by a person, so it carries the
 * sentence, the machine-readable category behind it, and where it came from.
 */
export interface TurnWarning {
  readonly category: WarningCategory;
  readonly severity: 'info' | 'warning' | 'error';
  /** Written for the user, not for a log. */
  readonly message: string;
  /** Backend or component that produced the condition, when known. */
  readonly source?: string;
}

/** Where a message was produced. Drives the local/remote colour split. */
export interface Provenance {
  /** aimatey backend-adapter id that served the request. */
  readonly backendId: string;
  readonly engine: EngineId;
  readonly modelId: string;
  readonly modelName: string;
  /**
   * How far this reply travelled. Was `local: boolean`; the Dexie v6 upgrade
   * (`src/db/reach.ts`) rewrites stored rows.
   */
  readonly reach: Reach;
  /** Set when the router fell back from another backend. */
  readonly fallbackFrom?: string;
  readonly fallbackReason?: string;
  /**
   * Whether this reply's request carried tool output off the device.
   *
   * Absent when there was no tool output in play. A remote message that
   * carried the contents of your conversations is materially different from
   * one that carried only the words you typed, and the chip alone cannot say
   * which it was.
   */
  readonly toolEgress?: 'granted' | 'withheld';
  /**
   * Sentences about how this turn went wrong, when it did (#149, #259).
   *
   * THE FIELD #259 EXISTS TO ADD. The engine has produced these since #149 and
   * nothing below it read them: `src/state/chat.ts` builds this record field by
   * field and there was no field to build. So #148's stream checksum, #149's
   * fallback warning and #142's codec redactions all computed sentences that
   * terminated at `ProvenanceSnapshot` — a channel with a writer that runs and
   * no reader, which is the exact defect #149 was filed to fix, one layer up.
   *
   * Optional and omitted rather than empty: a renderer that shows a warnings
   * chip should not have to distinguish `[]` from absent, and every row written
   * before v8 has neither.
   */
  readonly warnings?: readonly TurnWarning[];
}

/* ── Reading a reach ────────────────────────────────────────────────── */

/**
 * The four answers a reader can get, including the one the type says is
 * impossible.
 *
 * `unknown` is not a member of {@link Reach} and cannot be written. It is what
 * a reader gets from a row that reached it without the v6 upgrade having run —
 * a database restored from a backup, an import from another install, a row
 * hand-written by a future writer that forgot the field. The alternative to
 * naming that case is `provenance.reach.kind` throwing inside a renderer,
 * which takes the whole thread down rather than one label with it.
 *
 * A reader that must NAME the destination should switch on this and print
 * nothing for `unknown`, which is what the app already does with an absent
 * `provenance` (see {@link MessageVariant.provenance}).
 */
export type ReachKind = 'device' | 'paired' | 'remote' | 'unknown';

/** What kind of reach a record carries, tolerating a row that has none. */
export function reachKind(provenance: { readonly reach?: Reach } | undefined): ReachKind {
  /*
   * Since #112 this projects the two axes back onto the three names the
   * surfaces still speak. It is DESTINATION, not host: every existing caller
   * asks this to decide what a reply is labelled, and what a reader is owed is
   * where their words went, not which process typed them.
   *
   * That is exactly why the CLI case needs more than this function: it reports
   * `remote` for a turn that ran here, which is true about the bytes and
   * silent about the machine. The chip that says both is #210/#211's, and it
   * reads `reach` rather than this.
   */
  const reached = provenance?.reach?.reached;
  if (reached === 'device' || reached === 'paired') return reached;
  return reached === 'third-party' ? 'remote' : 'unknown';
}

/**
 * Did this reply run on THIS device?
 *
 * Reads the HOST axis, and since #112 that is not the same question as
 * "nothing left". A local agent CLI runs here and reaches a vendor API: this
 * answers `true` for it, {@link leftThisDevice} answers `true` as well, and
 * both are correct. Deriving this from `reachKind` — which reports the
 * destination — made it answer `false` for a process that is demonstrably
 * here, which is one of the two wrong answers #112 was filed about.
 *
 * Unknown answers `false`: a row whose reach was never written down has not
 * been shown to have stayed here.
 */
export function ranOnDevice(provenance: { readonly reach?: Reach } | undefined): boolean {
  return provenance?.reach?.host.kind === 'device';
}

/**
 * Did the bytes leave this device?
 *
 * True for `paired` as well as `remote` — a tunnelled turn crossed the network
 * even though nobody else read it, and every question about egress, consent
 * and grants is about that crossing rather than about who was at the far end.
 * Unknown answers `true`, which is the direction unknown has to fail in here.
 */
export function leftThisDevice(provenance: { readonly reach?: Reach } | undefined): boolean {
  // The DESTINATION axis. Unchanged in meaning: it was already the question
  // about where the bytes went, and `reachKind` still projects that.
  return reachKind(provenance) !== 'device';
}

/**
 * Did a third party serve this reply?
 *
 * The question that gates anything a provider must never see — this app's own
 * bookkeeping marks, for instance (`src/ai/taint.ts`). `paired` answers
 * `false`, because the far end is the user's own machine running this same
 * code. Unknown answers `true`: failing to strip is a leak, and failing to
 * mark is only a missing chip.
 *
 * Both this and {@link leftThisDevice} answer `true` for unknown, so no
 * caller can use the pair to derive a confident label out of a row that has
 * none. Labelling goes through {@link reachKind}.
 *
 * The DESTINATION axis, like {@link leftThisDevice}. A locally-hosted process
 * with a vendor upstream answers `true` here and `true` to
 * {@link ranOnDevice} — which is the pair of answers the old single axis could
 * not give, and the reason the taint mark is now stripped for a CLI turn that
 * would previously have kept it.
 */
export function reachedThirdParty(provenance: { readonly reach?: Reach } | undefined): boolean {
  const kind = reachKind(provenance);
  return kind === 'remote' || kind === 'unknown';
}

/** The paired device a reply ran on, or undefined if it was not a paired one. */
export function pairedDevice(
  provenance: { readonly reach?: Reach } | undefined,
): PairedDevice | undefined {
  const host = provenance?.reach?.host;
  // The HOST, not the destination: this answers "which machine ran it".
  return host?.kind === 'paired' ? host.device : undefined;
}

export interface GenerationStats {
  readonly promptTokens?: number;
  /** Prompt tokens served from the KV cache instead of re-processed. */
  readonly cachedTokens?: number;
  readonly completionTokens?: number;
  /** Time from send to first token. */
  readonly ttftMs?: number;
  readonly totalMs?: number;
  readonly tokensPerSecond?: number;
  /** Fraction of draft tokens accepted, when speculative decoding was on. */
  readonly draftAcceptance?: number;
  readonly computeBackend?: string;
  readonly peakMemoryBytes?: number;
}

/**
 * One generation of an assistant turn.
 *
 * This used to be a bare string, and that is the whole defect: `regenerate`
 * carried the previous TEXT forward and `cycleVariant` swapped the TEXT back,
 * while `provenance` — the chip, the model name, the local/remote split — sat
 * on the row and never moved. So a reply that came back from a provider was
 * rendered under the ember flame, this app's own mark for a turn that ran on
 * the device, and written into the exported transcript as "(on device)".
 *
 * The fix is not a check at the two call sites. It is that a generation and
 * where it came from are one value, so there is no longer a way to move one
 * without the other. Everything a turn is judged by travels in here:
 * `provenance` for where it ran, `toolCalls` for what it read (which is what
 * taint is derived from), `stats` for what it cost, `thinking` for the trace.
 */
export interface MessageVariant {
  readonly content: string;
  readonly thinking?: string;
  readonly toolCalls?: readonly ToolInvocation[];
  /**
   * Where this generation ran.
   *
   * Absent means UNKNOWN — never "on device". A generation recovered from a
   * build that stored variants as bare strings has no recorded origin, and the
   * plausible guess (the row's own provenance) is precisely the confident
   * falsehood this record exists to prevent. {@link MessageVariant.unrecorded}
   * says which kind of absence this is.
   */
  readonly provenance?: Provenance;
  readonly stats?: GenerationStats;
  /**
   * Set on text whose origin is not a recorded generation: one recovered by
   * the v4 upgrade from a bare `string` variant, or one a person has edited by
   * hand, so that no model can honestly be named beside it.
   *
   * It renders as no chip and no model name, which is what the UI already does
   * for a message with no provenance, and it counts as tool-derived for taint:
   * its tool use cannot be shown either, and unknown has to fail closed in
   * that direction while it fails silent in the other.
   */
  readonly unrecorded?: true;
}

export interface Message {
  readonly id: string;
  readonly chatId: string;
  readonly role: MessageRole;
  content: string;
  /** Reasoning trace, kept separate so it can be collapsed or hidden. */
  thinking?: string;
  readonly attachments?: readonly Attachment[];
  readonly toolCalls?: readonly ToolInvocation[];
  readonly provenance?: Provenance;
  readonly stats?: GenerationStats;
  readonly createdAt: number;
  /** Set while a message is still being generated. */
  streaming?: boolean;
  /** Set when generation failed; content holds the user-facing explanation. */
  error?: string;
  /**
   * Every generation of this turn, oldest last-but-one, newest last —
   * INCLUDING the one currently projected onto the fields above.
   *
   * The list used to hold only the generations that were NOT on display, with
   * the row itself standing in for the current one. That cost a second defect
   * as well as the provenance one: `cycleVariant` overwrote `content` in
   * place, so the row's own newest text was gone the moment you looked at an
   * older one and could not be got back. Holding every generation as data
   * makes the row a projection of `variants[variantIndex]` rather than a
   * participant, so there is nothing left to overwrite.
   *
   * Absent on a turn that has never been regenerated: one generation needs no
   * list, and the row alone is not ambiguous.
   */
  readonly variants?: readonly MessageVariant[];
  /** Which of {@link variants} the fields above are showing. */
  variantIndex?: number;
}

export type ChatMode = 'chat' | 'task';

/**
 * One conversation's permission to send something to one destination.
 *
 * TWO KINDS, AND NEITHER ANSWERS FOR THE OTHER. A provider grant lets tool
 * output go to one connection; it has no `kind`, which is also every row stored
 * before MCP grants existed, so those rows need no migration. An MCP grant lets
 * tool-call arguments go to one server record AT ONE ADDRESS (#6): the name is
 * what a same-name successor shares, and a record whose URL changed is
 * somewhere else. Each kind carries only its own key, so a check written for
 * one cannot compile against the other; read them through {@link holdsGrant}.
 */
export type EgressGrant = ProviderGrant | McpGrant;

export interface ProviderGrant {
  readonly kind?: undefined;
  /** Router/connection id, not the provider family — the key the engine gates on. */
  readonly connectionId: string;
  readonly grantedAt: number;
}

export interface McpGrant {
  readonly kind: 'mcp';
  /** `McpServerConfig.id` — never the server's name. */
  readonly serverId: string;
  readonly url: string;
  readonly grantedAt: number;
}

/** What a grant check is about. */
export type GrantSubject =
  | { readonly kind: 'provider'; readonly connectionId: string }
  | { readonly kind: 'mcp'; readonly serverId: string; readonly url: string };

/**
 * Does this conversation hold a grant for exactly this subject?
 *
 * The kind is checked as well as the key, so a row that somehow carries both
 * kinds' fields still answers for one of them only.
 */
export function holdsGrant(
  grants: readonly EgressGrant[] | undefined,
  subject: GrantSubject,
): boolean {
  return (grants ?? []).some((grant) =>
    subject.kind === 'mcp'
      ? grant.kind === 'mcp' && grant.serverId === subject.serverId && grant.url === subject.url
      : grant.kind !== 'mcp' && grant.connectionId === subject.connectionId,
  );
}

export interface Chat {
  readonly id: string;
  title: string;
  readonly mode: ChatMode;
  personaId: string | null;
  modelId: string | null;
  /** Per-chat sampler overrides on top of the model defaults. */
  sampler: Partial<SamplerSettings> | null;
  /** Tool ids enabled for this chat. */
  tools: string[];
  /**
   * Destinations this conversation has agreed may receive tool output.
   *
   * Per conversation and per connection, because neither alone is the decision
   * the user made: enabling `bash` says nothing about where its output goes,
   * and connecting a provider says nothing about which of your conversations
   * it may read. Absent on chats created before the grant existed, which reads
   * as "no grants" — the safe way round.
   */
  egressGrants?: EgressGrant[];
  showThinking: boolean;
  readonly createdAt: number;
  updatedAt: number;
  pinned?: boolean;
  /** Cached count so the chat list does not have to load messages. */
  messageCount: number;
  /** Cached preview line for the chat list. */
  preview: string;
}

/* ── Variants ───────────────────────────────────────────────────────── */

/**
 * The row's currently displayed generation, read back as a record.
 *
 * Used when a turn that has never been regenerated becomes the first entry of
 * its own list. Everything {@link applyVariant} writes, this reads.
 */
export function currentVariant(message: Message): MessageVariant {
  return {
    content: message.content,
    thinking: message.thinking,
    toolCalls: message.toolCalls,
    provenance: message.provenance,
    stats: message.stats,
  };
}

/**
 * Project one generation onto the row that displays it.
 *
 * Every field is written, including the ones that are absent on the incoming
 * variant — that is the point. A partial projection is how the old code left
 * `provenance` behind while `content` moved, and `undefined` here means the
 * chip, the model name, the tool blocks and the tok/s readout all disappear
 * together rather than describing a turn that is no longer on screen.
 */
export function applyVariant(message: Message, index: number): Message {
  const variant = message.variants?.[index];
  if (!variant) return message;
  return {
    ...message,
    content: variant.content,
    thinking: variant.thinking,
    toolCalls: variant.toolCalls,
    provenance: variant.provenance,
    stats: variant.stats,
    variantIndex: index,
  };
}

/**
 * Is the generation on display one whose origin was never written down?
 *
 * Read by the taint derivation, which cannot see a `toolCalls` list that was
 * never recorded and must therefore treat the turn as tool-derived.
 */
export function displaysUnrecorded(message: Message): boolean {
  const index = message.variantIndex;
  if (index === undefined) return false;
  return message.variants?.[index]?.unrecorded === true;
}

export function newId(prefix: string): string {
  const random =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID().replaceAll('-', '').slice(0, 12)
      : Math.random().toString(36).slice(2, 14);
  return `${prefix}_${random}`;
}

/** Derive a chat title from its first user message. */
export function deriveTitle(text: string): string {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  if (!cleaned) return 'New chat';
  return cleaned.length > 42 ? `${cleaned.slice(0, 41).trimEnd()}…` : cleaned;
}

/**
 * Split a raw model response into visible answer and reasoning trace.
 * Handles the `<think>` convention used by reasoning-tuned open models, and
 * returns partial reasoning while a block is still open so the UI can render
 * the trace live (PRD §3.4 — Thinking Mode).
 */
export function splitThinking(raw: string): { content: string; thinking: string; open: boolean } {
  const OPEN = /<(think|thinking|reasoning)>/i;
  const CLOSE = /<\/(think|thinking|reasoning)>/i;

  const openMatch = OPEN.exec(raw);
  if (!openMatch) return { content: raw, thinking: '', open: false };

  const before = raw.slice(0, openMatch.index);
  const rest = raw.slice(openMatch.index + openMatch[0].length);

  const closeMatch = CLOSE.exec(rest);
  if (!closeMatch) {
    // Block still open — everything after the tag is reasoning so far.
    return { content: before, thinking: rest, open: true };
  }

  const thinking = rest.slice(0, closeMatch.index);
  const after = rest.slice(closeMatch.index + closeMatch[0].length);
  const tail = splitThinking(after);
  return {
    content: (before + tail.content).replace(/^\n+/, ''),
    thinking: (thinking + (tail.thinking ? `\n${tail.thinking}` : '')).trim(),
    open: tail.open,
  };
}
