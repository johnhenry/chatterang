/**
 * Taint: what came from a tool, and what may be done with it.
 *
 * Two properties live here, and they are deliberately about BYTES rather than
 * about the block that happens to be carrying them.
 *
 * ## A. Tainted bytes cannot become control tokens
 *
 * The previous round escaped *markers* — a list of regexes for `<|im_start|>`,
 * `<start_of_turn>`, `[INST]` and friends. That is a denylist, and it is
 * incomplete by construction: a marker nobody wrote down, a marker split
 * across two tool results and reassembled in the prompt, a spelling the
 * tokeniser resolves and a string comparison does not.
 *
 * {@link encodeUntrusted} is not a denylist. It does not look for markers at
 * all. It removes, from the text, every character out of which any of this
 * app's turn markers is built:
 *
 *     <   >   |   [   ]   #   :
 *
 * replacing each with a visually similar character that is not one. Text that
 * contains none of those seven characters cannot spell `<|im_start|>`, or
 * `[INST]`, or `### Instruction:`, or `USER:`, or any arrangement of them —
 * and it cannot spell a marker invented next year either, provided that marker
 * is built from punctuation, which every marker in every family here is.
 *
 * The claim is closed by a test rather than by this paragraph.
 * `tests/taint.test.ts` extracts each shipped template's structure
 * mechanically (render it with empty bodies; what remains is structure) and
 * asserts that every non-whitespace run of it contains at least one character
 * from {@link STRUCTURAL}. A template added next year is covered on the day it
 * lands, and a template whose delimiter is *alphanumeric only* — a bare
 * `ASSISTANT` on its own line, say — fails that test loudly instead of
 * silently being forgeable. That is the gap, and it is a guarded one.
 *
 * ### The normalisation hole this also closes
 *
 * The round-3 escape substituted FULLWIDTH forms: `<` became `＜` (U+FF1C).
 * Measured: `'＜｜im_start｜＞'.normalize('NFKC') === '<|im_start|>'`. Every
 * fullwidth form has a compatibility decomposition straight back to its ASCII
 * original, and NFKC is exactly what a SentencePiece tokeniser configured with
 * `nmt_nfkc` — the default — applies before it looks anything up. So the
 * escape was undone by the very component it was aimed at.
 *
 * The substitutes here are all normalisation-stable under NFC, NFD, NFKC and
 * NFKD, and the encoder additionally rewrites the seventeen code points that
 * *fold into* a structural character (`＜`, `﹤`, `⩴`, …). Both facts are
 * asserted by scanning the whole of Unicode in the test, not asserted here.
 *
 * ## B. Tainted bytes cannot reach a non-local backend without a grant
 *
 * The previous round withheld blocks of type `tool_result`. So a model that
 * read a secret with one tool and pasted it into the ARGUMENTS of a second
 * tool call had moved the same bytes into a block type the rule did not cover.
 *
 * Taint here is a property of the MESSAGE, and it propagates forward in time:
 * once any tool has produced output in a turn, everything the model composes
 * afterwards is tainted, whatever block it lands in — a `tool_use` argument, a
 * text block quoting the output, a follow-up call's name. The engine marks;
 * {@link clearForDestination} is the only thing that can produce the
 * {@link ClearedMessage} array the engine is allowed to build a request from.
 * A call site that forgets the gate does not compile.
 *
 * ## What round four corrected, and why it is written down here
 *
 * The three paragraphs above were true of the code that introduced them and
 * still let three things through, each found by attacking the code rather than
 * by reading it. All three are the same mistake in different clothes — a rule
 * that SUBTRACTS the field known to hold the bytes and copies the rest:
 *
 * 1. `sanitiseMessages` exempted values under keys named `type` and `data`
 *    from encoding, to avoid rewriting image base64. A model names its own
 *    tool arguments, so naming one `data` put an unencoded `<|im_start|>` in
 *    the prompt. The exemption is gone; {@link encodeUntrusted} returns its
 *    input untouched when there is nothing to encode, which is what base64
 *    needed and what a key name was standing in for.
 * 2. {@link clearForDestination} withheld a `tool_use` by emptying `input` and
 *    spreading the rest — including `name`, which `findToolCalls` reads out of
 *    the model's own text. Naming a tool after the secret walked it out. Every
 *    withheld block is now REBUILT from named fields; the name survives only if
 *    the request declared it, and ids are renamed outright.
 * 3. The mark was stripped for every destination, including on-device ones —
 *    but the local prompt renderer sits behind this gate, so `isTainted()` was
 *    false everywhere it mattered and property A quietly fell back to round 3's
 *    marker denylist for any carrier without a block-type floor. See
 *    {@link ClearOptions.local}.
 *
 * The lesson is worth more than the three fixes: prefer constructions that
 * enumerate what is ALLOWED out. Every defect in this milestone has been a list
 * of what was not.
 */

import type { IRMessage, MessageContent } from '@johnhenry/aimatey-types';

/* ── A. The structural alphabet ──────────────────────────────────────── */

/**
 * Every character out of which a turn marker in this app is built.
 *
 * Not a guess: `tests/taint.test.ts` derives each template's structure by
 * rendering it with empty message bodies and asserts that every non-whitespace
 * run of what remains contains at least one of these. Adding a template that
 * needs another character fails that test.
 */
export const STRUCTURAL: readonly string[] = ['<', '>', '|', '[', ']', '#', ':'];

/**
 * What each structural character becomes.
 *
 * Chosen for two properties, both verified by test: each reads as the
 * character it replaces, and each is a fixed point of all four Unicode
 * normalisation forms — so no downstream normaliser can turn it back.
 */
export const SUBSTITUTE: Readonly<Record<string, string>> = {
  '<': '‹', // ‹ SINGLE LEFT-POINTING ANGLE QUOTATION MARK
  '>': '›', // › SINGLE RIGHT-POINTING ANGLE QUOTATION MARK
  '|': '∣', // ∣ DIVIDES
  '[': '⁅', // ⁅ LEFT SQUARE BRACKET WITH QUILL
  ']': '⁆', // ⁆ RIGHT SQUARE BRACKET WITH QUILL
  '#': '♯', // ♯ MUSIC SHARP SIGN
  ':': '∶', // ∶ RATIO
};

/**
 * Code points that are not structural but decompose into something that is.
 *
 * The list is exhaustive over all of Unicode. It is written out rather than
 * computed at import time because deriving it costs a scan of 1.1M code
 * points; the test performs exactly that scan and fails if this list has
 * drifted from it — which is also what would catch a future Unicode revision
 * adding an eighteenth.
 */
const FOLDS_INTO_STRUCTURE: readonly number[] = [
  0x226e, 0x226f, 0x2a74, 0xfe13, 0xfe47, 0xfe48, 0xfe55, 0xfe5f, 0xfe64, 0xfe65, 0xff03, 0xff1a,
  0xff1c, 0xff1e, 0xff3b, 0xff3d, 0xff5c,
];

/**
 * Each folding code point mapped to its already-substituted form.
 *
 * Derived rather than typed out: decompose it (NFKD, because `≮` folds only
 * under the canonical form) and substitute each structural character in the
 * result. `＜` becomes `‹`; `⩴` becomes `∶∶=`.
 */
const FOLDED: ReadonlyMap<string, string> = new Map(
  FOLDS_INTO_STRUCTURE.map((cp) => {
    const character = String.fromCodePoint(cp);
    const encoded = Array.from(character.normalize('NFKD'), (ch) => SUBSTITUTE[ch] ?? ch).join('');
    return [character, encoded];
  }),
);

/** Whitespace a reader needs and no template treats as a role boundary. */
const KEPT_CONTROLS = new Set(['\n', '\t', '\r']);

/** `\u{…}` escape for one code point, safe inside a regex character class. */
const classEscape = (codePoint: number): string => `\\u{${codePoint.toString(16)}}`;

/**
 * One invisible character that {@link encodeUntrusted} drops.
 *
 * Written once and shared by every regex here that needs it, because two
 * spellings of "invisible except the three we keep" is two things to keep in
 * agreement for no benefit.
 */
const NON_KEPT_INVISIBLE = `(?![${[...KEPT_CONTROLS]
  .map((character) => classEscape(character.codePointAt(0) ?? 0))
  .join('')}])[\\p{Cc}\\p{Cf}]`;

/**
 * Does this string contain anything {@link encodeUntrusted} would change?
 *
 * Derived from the same three data sources the encoder branches on — the
 * structural alphabet, the folding code points, and the invisibles minus the
 * kept whitespace — so it cannot drift out of agreement with the encoder. That
 * agreement is asserted directly over a Unicode sweep in `tests/taint.test.ts`
 * rather than argued for here.
 *
 * It exists because the encoder now runs over EVERY string in a tainted
 * message, including a megabyte of image base64. Base64 contains none of these
 * characters, so the scan answers "no" and the original string is returned
 * without a single allocation. That is what let the previous key-name
 * exemption — which was a hole, not an optimisation — be deleted.
 */
const ACTIONABLE = new RegExp(
  [
    `[${STRUCTURAL.map((character) => classEscape(character.codePointAt(0) ?? 0)).join('')}]`,
    `[${FOLDS_INTO_STRUCTURE.map(classEscape).join('')}]`,
    NON_KEPT_INVISIBLE,
  ].join('|'),
  'u',
);

/**
 * Invisible characters: C0/C1 controls and Unicode format characters.
 *
 * Dropped rather than substituted. A bidi override or a zero-width joiner
 * makes what a human reviewer reads differ from what the tokeniser reads,
 * which is the same class of defect as a forged marker and has no legitimate
 * use in tool output.
 */
const INVISIBLE = /[\p{Cc}\p{Cf}]/u;

/**
 * Make text that cannot express structure in any template this app ships.
 *
 * Idempotent — the output contains nothing the encoder acts on — and total: it
 * never throws and never drops a visible character, so the model still reads
 * what the tool printed.
 */
export function encodeUntrusted(text: string): string {
  if (!ACTIONABLE.test(text)) return text;

  let out = '';
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;

    // Fast path: printable ASCII that is not structural, which is most of it.
    if (code >= 0x20 && code < 0x7f) {
      out += SUBSTITUTE[character] ?? character;
      continue;
    }

    if (KEPT_CONTROLS.has(character)) {
      out += character;
      continue;
    }

    const folded = FOLDED.get(character);
    if (folded !== undefined) {
      out += folded;
      continue;
    }

    if (INVISIBLE.test(character)) continue;

    out += character;
  }
  return out;
}

/**
 * Neutralise one string's structural characters, and the look-alikes that fold
 * into them, character by character.
 *
 * This is the substitution half of {@link encodeUntrusted} without the
 * invisible-dropping half, exported because the marker escaper in `ai/prompt.ts`
 * needs exactly it: a denylist may only rewrite the span it matched, but every
 * character in that span that could BECOME structure has to go, not merely the
 * ASCII ones.
 *
 * Its sufficiency rests on {@link FOLDS_INTO_STRUCTURE} being exhaustive over
 * Unicode — a character absent from both tables cannot produce a structural
 * character under any normalisation form, which is the property
 * `tests/taint.test.ts` scans all 1.1M code points to assert. That is why this
 * function lives here beside the tables and not next to the markers.
 */
export function substituteStructural(text: string): string {
  let out = '';
  for (const character of text) {
    out += SUBSTITUTE[character] ?? FOLDED.get(character) ?? character;
  }
  return out;
}

/**
 * Printable ASCII plus the whitespace no projection would touch.
 *
 * Text made only of these is its own projection, which is the case that has to
 * stay free: `escapeControlMarkers` runs over every string of every untainted
 * message, base64 image payloads included.
 */
const FLAT_ASCII = /[^\x20-\x7e\n\t\r]/;

/** Invisibles a normalising tokeniser strips, excluding the three kept ones. */
const HIDDEN = new RegExp(NON_KEPT_INVISIBLE, 'u');

/**
 * The text as a NORMALISING TOKENISER will read it, with a map back to here.
 *
 * `sourceStart[i]` and `sourceEnd[i]` bracket, in the ORIGINAL string, the
 * character that produced projected code unit `i`. That is the whole point:
 * matching happens against the projection, and rewriting happens against the
 * original, so nothing is ever normalised into the output.
 */
interface Projection {
  readonly text: string;
  readonly sourceStart: readonly number[];
  readonly sourceEnd: readonly number[];
}

/**
 * `undefined` when the text is its own projection, which is most text.
 *
 * Two rejections before any per-character work, because this runs over every
 * string of every untainted message. The first covers printable ASCII — base64
 * image payloads, code, English prose. The second covers text that is
 * non-ASCII but already flat: a native `normalize` pass answers for CJK,
 * Cyrillic and Greek in one go, and only text that genuinely decomposes or
 * hides something reaches the loop.
 */
function project(text: string): Projection | undefined {
  if (!FLAT_ASCII.test(text)) return undefined;
  if (text.normalize('NFKD') === text && !HIDDEN.test(text)) return undefined;

  let out = '';
  const sourceStart: number[] = [];
  const sourceEnd: number[] = [];
  for (let index = 0; index < text.length; ) {
    const character = String.fromCodePoint(text.codePointAt(index) ?? 0);
    const next = index + character.length;

    // Kept whitespace first: `\r` and `\n` are Cc, and the line-anchored
    // markers need them where they are.
    if (!KEPT_CONTROLS.has(character) && INVISIBLE.test(character)) {
      index = next;
      continue;
    }

    // Per code point rather than over the whole string, because a whole-string
    // decomposition may reorder combining marks and that would break the index
    // map for no gain: a fold that spans two code points is not a thing.
    const code = character.codePointAt(0) ?? 0;
    const folded = code < 0x80 ? character : character.normalize('NFKD');
    // Pushed per code UNIT, because that is what a regex match index counts.
    for (let unit = 0; unit < folded.length; unit += 1) {
      sourceStart.push(index);
      sourceEnd.push(next);
    }
    out += folded;
    index = next;
  }
  return { text: out, sourceStart, sourceEnd };
}

/**
 * Apply a denylist pattern to what a tokeniser would read, and rewrite what is
 * actually there.
 *
 * The escaper in `ai/prompt.ts` is a denylist of ASCII marker shapes, and it
 * has to stay one: its input is text the USER wrote, which must arrive at the
 * model byte for byte apart from the marker shapes themselves. So it cannot do
 * what {@link encodeUntrusted} does, and it cannot normalise its input either —
 * that would rewrite every piece of legitimate CJK and fullwidth text in the
 * conversation.
 *
 * What it can do is match somewhere else. This projects the text into the form
 * a `nmt_nfkc` SentencePiece tokeniser will read — compatibility folds
 * resolved, invisibles gone — runs the pattern there, maps each match back to
 * the characters it came from, and hands those ORIGINAL characters to
 * `neutralise`. `＜｜turn＞` matches `<\|…>`; the bytes rewritten are the
 * fullwidth ones; nothing else in the string is touched.
 *
 * Every pattern must be global, and the result is exactly
 * `patterns.reduce((t, p) => t.replace(p, neutralise), text)` whenever the text
 * is its own projection — which is every pure-ASCII string, so the behaviour
 * the caller had before folding was considered is unchanged rather than
 * approximated.
 *
 * The patterns arrive as a list rather than one at a time so that the
 * projection is built once for the whole pass and rebuilt only after a pattern
 * actually changed something — which, for the escaper's six, is almost never.
 */
export function replaceThroughFolds(
  text: string,
  patterns: readonly RegExp[],
  neutralise: (matched: string) => string,
): string {
  let out = text;
  let projection = project(out);
  for (const pattern of patterns) {
    const next =
      projection === undefined
        ? out.replace(pattern, neutralise)
        : replaceOne(out, projection, pattern, neutralise);
    if (next === out) continue;
    out = next;
    projection = project(out);
  }
  return out;
}

function replaceOne(
  text: string,
  projection: Projection,
  pattern: RegExp,
  neutralise: (matched: string) => string,
): string {
  let out = '';
  let cursor = 0;
  for (const match of projection.text.matchAll(pattern)) {
    const length = match[0].length;
    if (length === 0) continue;
    const index = match.index ?? 0;
    // The whole span of every ORIGINAL character the match touched, so a
    // character that projected to several units is rewritten once and whole.
    const from = projection.sourceStart[index] ?? text.length;
    const to = projection.sourceEnd[index + length - 1] ?? text.length;
    if (from < cursor) continue;
    out += text.slice(cursor, from) + neutralise(text.slice(from, to));
    cursor = to;
  }
  return cursor === 0 ? text : out + text.slice(cursor);
}

/**
 * Does this text still contain anything a template could read as structure?
 *
 * Checks the four normalisation forms as well as the literal bytes, because
 * "inert until something calls NFKC on it" is not inert. Exported for tests
 * and for anything that wants to assert rather than assume.
 */
export function isStructurallyInert(text: string): boolean {
  for (const form of ['NFC', 'NFD', 'NFKC', 'NFKD'] as const) {
    const normalised = text.normalize(form);
    for (const character of normalised) {
      if (STRUCTURAL.includes(character)) return false;
      if (KEPT_CONTROLS.has(character)) continue;
      if (INVISIBLE.test(character)) return false;
    }
  }
  return true;
}

/* ── B. Taint on messages ────────────────────────────────────────────── */

/**
 * Where the mark lives.
 *
 * `IRMessage.metadata` is documented by aimatey as "stored but not processed
 * by IR", which is exactly the contract a mark needs: it survives the message
 * being copied around this app, and {@link clearForDestination} removes it
 * before the message can reach a provider SDK.
 */
const TAINT_KEY = 'chatterangTaint';

/** Marked-up message. The mark is data, so it survives `structuredClone`. */
export function markTainted(message: IRMessage): IRMessage {
  if (isTainted(message)) return message;
  return { ...message, metadata: { ...message.metadata, [TAINT_KEY]: true } };
}

export function isTainted(message: IRMessage): boolean {
  return message.metadata?.[TAINT_KEY] === true;
}

/**
 * Block types that are tool-derived whatever message they arrive in.
 *
 * The floor under the message mark: a caller that assembles a history
 * containing tool results without marking anything still gets them withheld.
 */
function isToolBlock(block: MessageContent): boolean {
  return block.type === 'tool_result' || block.type === 'tool_use';
}

/** Is any of this tainted — by the mark, or by carrying a tool block? */
export function carriesTaint(messages: readonly IRMessage[]): boolean {
  return messages.some(
    (message) =>
      isTainted(message) || (Array.isArray(message.content) && message.content.some(isToolBlock)),
  );
}

/** Characters of tainted text an outgoing request would carry. */
export function taintedCharacters(messages: readonly IRMessage[]): number {
  let total = 0;
  for (const message of messages) {
    const tainted = isTainted(message);
    if (typeof message.content === 'string') {
      if (tainted) total += message.content.length;
      continue;
    }
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (!tainted && !isToolBlock(block)) continue;
      total += blockCharacters(block);
    }
  }
  return total;
}

function blockCharacters(block: MessageContent): number {
  const record = block as unknown as Record<string, unknown>;
  const content = record.content;
  if (typeof content === 'string') return content.length;
  if (Array.isArray(content)) {
    return content.reduce(
      (sum: number, part) => sum + String((part as { text?: string }).text ?? '').length,
      0,
    );
  }
  if (block.type === 'text') return block.text.length;
  if (record.input !== undefined) {
    // The name counts. It is a field the model writes, so it is a field that
    // can carry the bytes, and a receipt that said "2 characters" while a
    // thirty-five-character secret sat in the name would be the same kind of
    // false-but-reassuring string as the `privacy` command used to print.
    return JSON.stringify(record.input).length + String(record.name ?? '').length;
  }
  return 0;
}

/* ── The gate ────────────────────────────────────────────────────────── */

declare const CLEARED: unique symbol;

/**
 * A message that has been through the egress gate for a specific destination.
 *
 * The brand is the enforcement, in the same shape as `SafeMessage` in
 * `prompt.ts`: `ChatterangEngine#toIR` accepts nothing else, and
 * {@link clearForDestination} is the only producer. A path that assembles an
 * outgoing request without deciding about taint does not typecheck — which is
 * how `complete()` turned out to have been sending unchecked, since it built
 * its IR request straight from `request.messages`.
 */
export type ClearedMessage = IRMessage & { readonly [CLEARED]: true };

export interface ClearOptions {
  /** False withholds every tainted byte; true only strips the marks. */
  readonly allowed: boolean;
  /** What the model is told in place of what was withheld. */
  readonly note: (characters: number) => string;
  /**
   * The tool names this request declares — the app's own strings.
   *
   * A withheld `tool_use` keeps its name only if it is in here. That is not
   * politeness: `findToolCalls` reads the name out of the model's own text
   * (`{"name":"…","arguments":{}}`), so the name is a model-controlled field,
   * and a withheld block that spread `...block` carried it out verbatim. The
   * measured attack was to read a secret with one tool and then emit a second
   * call whose NAME was the secret — the round-3 defect one field further
   * over. Omitting this set withholds every name, which is the safe default.
   */
  readonly declaredToolNames?: ReadonlySet<string>;
  /**
   * Is the destination an on-device engine?
   *
   * This decides whether the taint MARK is stripped, and it exists because
   * stripping it unconditionally silently disarmed property A.
   *
   * The mark is stripped so it cannot reach a provider SDK. But the local
   * prompt renderer sits BEHIND this gate too — `renderPrompt` runs inside the
   * llama.cpp adapter, downstream of `#toIR` — so an unconditional strip meant
   * `sanitiseMessages` never once saw `isTainted() === true` in the running
   * app. Encoding still happened for `tool_use`/`tool_result` blocks, which
   * have a block-type floor under them, and did NOT happen for the carrier the
   * mark exists to cover: an ordinary text message that a previous turn's tool
   * output is derived from. Measured — a reply quoting `<<SYS>>` came back
   * through into the local ChatML prompt with only round 3's marker denylist
   * between it and the tokeniser, which is exactly the denylist this round was
   * meant to stop depending on.
   *
   * So: local keeps the mark, and `renderPrompt` encodes. Non-local strips it,
   * because this app's bookkeeping must never reach a provider SDK. Omitting
   * the flag strips, which keeps the provider-facing default.
   *
   * What this comment used to claim next — that a non-local destination
   * "renders no template at all — its structure is JSON, not markers, so there
   * is nothing there for a marker to forge" — is not true, and it was
   * justifying the strip with it. `local` is `isLocalEngine(engine)`, and
   * `ollama` and `lmstudio` are `self-hosted` providers whose engine is
   * `remote`: non-local by this flag, and servers that apply the model's own
   * chat template to the JSON they are handed. Nothing encodes on that path —
   * `renderPrompt`/`sanitiseMessages` run only inside the llama.cpp adapter —
   * so a marker in tool output reaches a renderer, just not this app's.
   * Measured through `clearForDestination` with `local: false`: the body still
   * contained `<|im_start|>` verbatim, where the same bytes through
   * `renderPrompt` came out substituted.
   *
   * That is a hole in the code, not in the sentence, and it is not closed
   * here. The flag's job is the mark; encoding for a destination that renders
   * somebody else's template is a separate piece of work. This comment says so
   * rather than explaining why it does not need doing.
   *
   * ## A paired desktop (#208)
   *
   * This flag is *not* "did the bytes stay on this device". Since #208 the
   * caller computes it with `keepsTaintMark()` in `src/ai/engine.ts`, which is
   * deliberately a different question from `leavesThisDevice()` -- the one
   * that gates the egress sheet.
   *
   * They diverge for exactly one destination. A third-party provider has no
   * idea what `chatterangTaint` means, so carrying it there leaks this app's
   * bookkeeping for no benefit: strip it. A paired desktop is the same
   * application on another machine -- it runs `renderPrompt` itself, so it is
   * the one non-local destination that could *act* on the mark, and where
   * keeping it may close the hole described above rather than widen it.
   *
   * It is stripped for a paired desktop today, because nothing writes a
   * `paired` reach yet and a flag whose only reader does not exist is a flag
   * that will be wrong by the time one does. Whoever writes the tunnel adapter
   * makes that call, in `keepsTaintMark()`, with this paragraph as the
   * argument. Note the asymmetry if you change it: keeping the mark is only
   * safe because the far side is trusted to honour it, which is a claim about
   * the pairing, not about the mark.
   */
  readonly local?: boolean;
}

/** The name a withheld call gets when its own is not one the app declared. */
export const WITHHELD_TOOL_NAME = 'withheld_tool';

/**
 * Strip the taint marks, and — when the destination has no grant — the tainted
 * bytes with them.
 *
 * Withholding rewrites blocks rather than dropping messages. A model handed an
 * empty tool result concludes the command failed and runs it again; a model
 * told plainly what happened can say so. The `tool_use`/`tool_result` pairing
 * is preserved for the same reason: several providers reject a result whose
 * call is missing.
 */
export function clearForDestination(
  messages: readonly IRMessage[],
  options: ClearOptions,
): ClearedMessage[] {
  // One renaming map for the whole array, so a `tool_result` and the
  // `tool_use` it answers still agree after both have been rewritten.
  const renamed = new Map<string, string>();
  const idFor = (id: unknown): string => {
    const key = typeof id === 'string' ? id : String(id);
    const existing = renamed.get(key);
    if (existing !== undefined) return existing;
    const fresh = `withheld_call_${renamed.size}`;
    renamed.set(key, fresh);
    return fresh;
  };

  return messages.map((message) => {
    const tainted = isTainted(message);
    // On-device: the mark rides through, because the thing that consumes it —
    // `sanitiseMessages`, inside the local prompt renderer — is downstream of
    // this gate. Off-device: it is stripped, because a provider must never see
    // this app's bookkeeping.
    const metadata = options.local === true ? message.metadata : stripMark(message.metadata);
    const base = metadata === undefined ? omitMetadata(message) : { ...message, metadata };

    if (options.allowed) return base as ClearedMessage;

    if (typeof message.content === 'string') {
      if (!tainted) return base as ClearedMessage;
      // Rebuilt, not spread: a withheld message keeps its role and nothing
      // else, so a field added to `IRMessage` later cannot become a carrier
      // by default.
      return { role: message.role, content: options.note(message.content.length) } as ClearedMessage;
    }

    if (!Array.isArray(message.content)) return base as ClearedMessage;
    if (!tainted && !message.content.some(isToolBlock)) return base as ClearedMessage;

    return {
      role: message.role,
      content: message.content.map((block) =>
        tainted || isToolBlock(block) ? withhold(block, options, idFor) : block,
      ),
    } as unknown as ClearedMessage;
  });
}

/**
 * One block, rebuilt from a closed set of fields.
 *
 * The shape of the previous version was `{ ...block, content: note }` — subtract
 * the field known to hold the bytes, keep everything else. That is the same
 * denylist mistake as the marker escaper, and it leaked for the same reason:
 * something else was holding the bytes. Measured at the `BackendAdapter`
 * boundary, with no grant, every other field withheld — the secret rode out in
 * `tool_use.name`, which `findToolCalls` copies straight from the model's text
 * and which the old comment here wrongly called "the app's own string".
 *
 * So nothing is spread. Each branch NAMES the fields it emits:
 *
 * - `toolUseId` / `id` are renamed to an app-generated `withheld_call_N`. They
 *   only ever need to agree with each other inside one request, so renaming
 *   them costs nothing and closes the id as a channel outright — including for
 *   a provider-native block whose id this app did not choose.
 * - `name` survives only if the request declared it. The set is finite, it is
 *   the app's, and a name outside it is by definition not a tool that ran.
 * - Everything else becomes the note, including media: a tainted image is a
 *   tainted image and there is no partial version of it.
 */
function withhold(
  block: MessageContent,
  options: ClearOptions,
  idFor: (id: unknown) => string,
): MessageContent {
  const record = block as unknown as Record<string, unknown>;
  const note = options.note(blockCharacters(block));

  if (block.type === 'tool_result') {
    return {
      type: 'tool_result',
      toolUseId: idFor(record.toolUseId),
      content: note,
      isError: record.isError === true,
    } as unknown as MessageContent;
  }

  if (block.type === 'tool_use') {
    const name = record.name;
    const declared = typeof name === 'string' && options.declaredToolNames?.has(name) === true;
    return {
      type: 'tool_use',
      id: idFor(record.id),
      name: declared ? (name as string) : WITHHELD_TOOL_NAME,
      input: { withheld: note },
    } as unknown as MessageContent;
  }

  return { type: 'text', text: note } as MessageContent;
}

function stripMark(
  metadata: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!metadata || !(TAINT_KEY in metadata)) return metadata;
  const rest = { ...metadata };
  delete rest[TAINT_KEY];
  return Object.keys(rest).length > 0 ? rest : undefined;
}

function omitMetadata(message: IRMessage): IRMessage {
  if (message.metadata === undefined) return message;
  const { metadata: _drop, ...rest } = message;
  return rest as IRMessage;
}
