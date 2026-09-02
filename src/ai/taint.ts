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
  if (record.input !== undefined) return JSON.stringify(record.input).length;
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
}

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
  return messages.map((message) => {
    const tainted = isTainted(message);
    const metadata = stripMark(message.metadata);
    const base = metadata === undefined ? omitMetadata(message) : { ...message, metadata };

    if (options.allowed) return base as ClearedMessage;

    if (typeof message.content === 'string') {
      if (!tainted) return base as ClearedMessage;
      return { ...base, content: options.note(message.content.length) } as ClearedMessage;
    }

    if (!Array.isArray(message.content)) return base as ClearedMessage;
    if (!tainted && !message.content.some(isToolBlock)) return base as ClearedMessage;

    return {
      ...base,
      content: message.content.map((block) =>
        tainted || isToolBlock(block) ? withhold(block, options.note) : block,
      ),
    } as unknown as ClearedMessage;
  });
}

/**
 * One block, emptied of the bytes but not of its shape.
 *
 * Every branch is deliberate. A `tool_use` keeps its id and its name — the
 * name is the app's own string, and the id is what pairs it with its result —
 * but loses every argument, because an argument is exactly where the measured
 * copy-through landed. A media block becomes text, because a tainted image is
 * a tainted image and there is no partial version of it.
 */
function withhold(block: MessageContent, note: (characters: number) => string): MessageContent {
  const record = block as unknown as Record<string, unknown>;
  const characters = blockCharacters(block);

  if (block.type === 'tool_result') {
    return { ...block, content: note(characters) } as MessageContent;
  }
  if (block.type === 'tool_use') {
    return { ...block, input: { withheld: note(characters) } } as MessageContent;
  }
  if (block.type === 'text') {
    return { ...block, text: note(characters) } as MessageContent;
  }
  void record;
  return { type: 'text', text: note(characters) } as MessageContent;
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
