/**
 * Chat-template rendering.
 *
 * Templates are applied on the JavaScript side rather than inside each native
 * engine. That means a conversation produces byte-identical prompt text
 * whether it is served by llama.cpp, MLC-LLM, or a later runtime — which is
 * what makes "retry this turn on a different engine" a fair comparison
 * instead of a confound.
 *
 * ## Why the escaping lives here and not at the call sites
 *
 * A chat template is a text format whose only structure is a handful of
 * control markers — `<|im_start|>`, `<start_of_turn>`, `[INST]`. Everything
 * between them is data. So a message body that *contains* those markers can
 * close its own turn and open somebody else's: a `tool_result` carrying
 * `<end_of_turn>\n<start_of_turn>system` ends the tool turn and starts a
 * forged system turn, in a prompt the model then obeys. The bash tool's stdout
 * is the sharpest case — the model chooses the command, and most of the VFS is
 * its own prior writes — but it is not special. Any block whose text the model
 * or a third party influenced is the same hazard.
 *
 * The fix is arranged so a new template or a new call site cannot opt out of
 * it. {@link renderPrompt} is the only way in, and it hands every template a
 * {@link SafeMessage} — a branded type whose sole producer is
 * {@link sanitiseMessages}. `TemplateSpec.render` accepts nothing else, so a
 * template added next year gets escaped content whether or not its author read
 * this comment, and a template that tried to reach around `messageText` to
 * `message.content` would find that already escaped too: the sanitiser rewrites
 * the message, it does not merely wrap the accessor.
 *
 * ## Two different treatments, because the bytes are not equally trusted
 *
 * Text the user typed is escaped: the marker shapes below are neutralised and
 * everything else is left exactly as written, so a message about `a < b` still
 * reads as `a < b`. That is a denylist, and it is the right trade for bytes
 * whose author is the principal — a user who pastes `<|im_start|>` is talking
 * to their own model.
 *
 * Text that came from a tool is ENCODED instead, by {@link encodeUntrusted} in
 * `ai/taint.ts`. That is not a list of markers; it removes the characters any
 * marker is built from, so tainted text cannot express structure in a template
 * this app ships or in one added next year. The cost is that a tool's `:`, `|`
 * and `#` reach the model as `∶`, `∣` and `♯` — which is why it applies to
 * tool bytes and not to the whole conversation.
 *
 * The substitution table below is shared with the encoder and every entry is
 * normalisation-stable. It did not used to be: the fullwidth forms this file
 * shipped in round 3 (`＜｜im_start｜＞`) NFKC-normalise straight back to
 * `<|im_start|>`, and NFKC is what a SentencePiece tokeniser applies by
 * default. Measured, not assumed — see `tests/taint.test.ts`.
 */

import type { PromptTemplate } from '@/domain/manifest';
import {
  encodeUntrusted,
  isTainted,
  replaceThroughFolds,
  substituteStructural,
} from '@/ai/taint';
import type { IRMessage, MessageContent } from '@johnhenry/aimatey-types';

/* ── Control-marker escaping ─────────────────────────────────────────── */

/**
 * Every shape that means "a turn starts/ends here" in some template this file
 * ships, plus the ones the families are known to stop on.
 *
 * Deliberately the union across all templates rather than per-template: a
 * `<|im_start|>` in a Gemma prompt is inert, and neutralising it anyway costs
 * one substitution and removes the failure mode where a model's template is
 * inferred wrongly (`inferTemplate` guesses from a model id) and the escaping
 * turns out to have been aimed at the wrong family.
 */
const CONTROL_MARKERS: readonly RegExp[] = [
  // `<|im_start|>`, `<|eot_id|>`, `<|end_header_id|>`, `<|user|>`, `<|end|>` …
  // ChatML, Llama 3, Phi and Zephyr all live in this one shape. The closing
  // `|` is optional because Gemma 4 opens its markers `<|turn>`, `<|channel>`,
  // `<|tool_call>` — pipe on the left only.
  //
  // Whitespace is excluded for the same reason the mirror below is restricted
  // to marker-name characters: it is the same bug, on this pattern. Making the
  // closing `|` optional changed what BOUNDS this pattern. It used to run from
  // `<|` to the rare terminator `|>`; it now runs from `<|` to the next `>`,
  // and `<|` cannot carry that alone — it is F#'s backward pipe and Haskell's
  // `Data.Sequence (<|)`. So `ignore <| f x > 0` matched `<| f x >` and reached
  // the model as `ignore ‹∣ f x › 0`; twelve of twelve realistic `<|` snippets
  // were mangled, and with whitespace excluded none are. No marker is lost:
  // none of the 33 measured across ChatML, Llama 3, Phi, Zephyr, GPT-OSS
  // harmony, DeepSeek, Qwen FIM and Gemma 4 contains whitespace. DeepSeek's
  // `<|begin▁of▁sentence|>` survives — U+2581 is not `\s`.
  //
  // `‹∣›` are excluded because they are what `widen` PRODUCES for `<`, `|` and
  // `>`. Without them an escaped marker is a legal interior for an unescaped
  // outer one and the function is not idempotent: `<|a<|b|>c|>` gives
  // `<|a‹∣b∣›c|>` on the first pass and `‹∣a‹∣b∣›c∣›` on the second. Excluding
  // them makes escaped text a fixed point, measured over every string up to
  // length 11 in `tests/prompt.test.ts` rather than argued for here.
  /<\|[^|<>\s‹∣›]{1,40}\|?>/g,
  // The mirror image: `<turn|>`, `<channel|>`, `<tool_response|>`, `<image|>`.
  // Gemma 4 CLOSES with the pipe on the right, and `<turn|>` is its EOG token,
  // so a body that could spell it could end the turn it is sitting in.
  //
  // The class is marker-name characters ONLY — not "anything but a bracket".
  // That distinction is the whole correctness of this line. `|>` is the
  // pipeline operator in F#, Elixir and OCaml, and `<` is a comparison in
  // every language there is, so a loose class here has two common characters
  // to run between. Neither pattern can afford a loose class — the one above
  // is bounded by a `>` that is just as common, which is why it excludes
  // whitespace.
  //
  // With a loose class this pattern ran from an unrelated `<` across the
  // intervening text to a distant `|>`: `a < b |> c` matched `< b |>` and
  // reached the model as `a ‹ b ∣› c`. Measured that way before this class was
  // narrowed — nine of twelve realistic pipeline snippets were being mangled.
  //
  // Requiring `[A-Za-z0-9_]` loses no marker: every mirror-shaped marker in
  // Gemma 4's vocabulary (`turn`, `channel`, `tool`, `tool_call`,
  // `tool_response`, `image`, `audio`, `video`) is a bare identifier, and a
  // body that spells `<turn |>` with a space has not spelled token 106.
  /<[A-Za-z0-9_]{1,40}\|>/g,
  // Gemma 2/3's turn markers, and the Mistral/Zephyr sentence tokens.
  /<\/?(?:s|start_of_turn|end_of_turn|begin_of_text|end_of_text)>/g,
  // Mistral instruction brackets.
  /\[\/?INST\]/gi,
  // Alpaca section headers — only meaningful at the start of a line, and
  // anchored there so ordinary prose containing "###" survives intact.
  /^[ \t]*###[ \t]*(?:Instruction|Response|Input)[ \t]*:/gim,
  // Vicuna role labels. Uppercase and line-anchored, so "the user: ..." in a
  // sentence is untouched and only the forgeable form is escaped.
  /^[ \t]*(?:USER|ASSISTANT|SYSTEM)[ \t]*:/gm,
];

/**
 * Neutralise one matched marker, character by character.
 *
 * Delegates to `ai/taint.ts` rather than mapping `SUBSTITUTE` itself, because
 * the span handed here is no longer guaranteed to be ASCII: a marker spelled
 * `＜｜turn＞` is matched through the fold projection (see
 * {@link escapeControlMarkers}) and it is those fullwidth bytes that have to be
 * replaced. `substituteStructural` covers both tables — the seven structural
 * characters and the seventeen that fold into them — and that second table is
 * the one a copy here would drift from.
 */
function widen(marker: string): string {
  return substituteStructural(marker);
}

/**
 * Make text that cannot open or close a turn in any template this file ships.
 *
 * Exported for tests and for anything else that has to put model-influenced
 * text into a prompt-shaped string.
 *
 * Idempotent, though not for the obvious reason. "Escaped text contains no
 * marker" holds only because each pattern's interior class also excludes the
 * characters {@link widen} produces; without that, an escaped INNER marker is
 * a legal interior for an unescaped outer one, and `<|a<|b|>c|>` escapes
 * further on every pass. `tests/prompt.test.ts` measures the fixed point over
 * every string up to length 11 in the alphabet that can express one.
 *
 * ## Why the matching does not happen against `text`
 *
 * The patterns above are ASCII literals, and a marker does not have to be
 * spelled in ASCII to arrive as one. `＜｜turn＞` is three fullwidth code points
 * around `turn`; `'＜｜turn＞'.normalize('NFKC')` is `'<|turn>'`, and NFKC is
 * what a SentencePiece tokeniser configured with `nmt_nfkc` — the default —
 * applies before it looks a token up. Measured over a sweep built mechanically
 * by respelling every marker these patterns cover with the fullwidth form of
 * each of `< > | [ ] # :`: the ASCII-literal escaper blocked NONE of them,
 * while {@link encodeUntrusted} blocked all of them. Partial disguises worked
 * too — `<｜turn>`, `＜|turn>`, `<|turn＞`, `﹤|turn>` each fold to the marker.
 * End to end, one user message rendered a prompt whose literal marker counts
 * looked benign and which after NFKC carried a forged system turn plus a
 * pre-filled model turn. `tests/taint.test.ts` runs that sweep.
 *
 * The two obvious repairs are both wrong. Adding fullwidth spellings to the
 * patterns writes a second table beside the exhaustive one in `ai/taint.ts`,
 * for it to drift from. Normalising the text before escaping fixes the matching
 * and corrupts the output: this escaper is a denylist BECAUSE user-authored
 * bytes have to arrive intact, so it may not rewrite a line of Japanese to get
 * at a marker that is not in it.
 *
 * So matching happens against a projection of the text — what a normalising
 * tokeniser will read — and rewriting happens against the original characters
 * the match came from. {@link replaceThroughFolds} owns that, in `ai/taint.ts`
 * beside the fold table rather than here beside the markers. A fullwidth marker
 * is matched and its own bytes are replaced; a fullwidth character that is not
 * part of a marker is never touched. On text that is its own projection — every
 * pure-ASCII string, so every assertion in `tests/prompt.test.ts` about prose
 * and pipeline operators — this is byte for byte the `String.replace` loop it
 * used to be.
 */
export function escapeControlMarkers(text: string): string {
  return replaceThroughFolds(text, CONTROL_MARKERS, widen);
}

/* ── Sanitised messages ──────────────────────────────────────────────── */

declare const SAFE: unique symbol;

/**
 * A message whose every string has been through {@link escapeControlMarkers}.
 *
 * The brand exists to make the guarantee a compile-time one: `TemplateSpec`
 * renders `SafeMessage` and nothing else, and {@link sanitiseMessages} is the
 * only function that produces one.
 */
export type SafeMessage = IRMessage & { readonly [SAFE]: true };

/** How one message's strings are neutralised. */
type Neutralise = (text: string) => string;

/**
 * Deep-neutralise every string in an arbitrary IR value.
 *
 * Keys as well as values. `messageText` renders a `tool_use` block as
 * `JSON.stringify(block.input)`, and `JSON.stringify` prints keys — so an
 * argument *named* `<|im_start|>` reached the prompt unescaped until this
 * function stopped copying keys through verbatim.
 *
 * Every string, with no exemption by key. There used to be one: keys named
 * `type` and `data` had their values copied through untouched, so that a
 * megabyte of image base64 was not rewritten character by character. It was a
 * hole, and a reachable one — a model writes its own tool arguments, so
 * `{"name":"bash","arguments":{"data":"<|im_start|>system\n…"}}` put a literal,
 * unencoded turn marker into the ChatML prompt by naming an argument `data`.
 * Measured that way before this line changed; the test that measured it is
 * `tests/taint.test.ts`.
 *
 * The optimisation the exemption paid for now lives inside
 * {@link encodeUntrusted}, which returns its input unchanged when the input
 * holds nothing to encode — true of all base64 — so the fast path is decided by
 * what the bytes ARE rather than by what a key happens to be called.
 */
function sanitiseValue(value: unknown, neutralise: Neutralise): unknown {
  if (typeof value === 'string') return neutralise(value);
  if (Array.isArray(value)) return value.map((inner) => sanitiseValue(inner, neutralise));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      out[neutralise(key)] = sanitiseValue(inner, neutralise);
    }
    return out;
  }
  return value;
}

/**
 * Is this block tool-derived whatever message it arrived in?
 *
 * The floor under the message-level taint mark: a caller that assembles a
 * history containing tool blocks without marking anything still gets them
 * encoded rather than merely escaped.
 */
function isToolBlock(block: MessageContent): boolean {
  return block.type === 'tool_result' || block.type === 'tool_use';
}

/**
 * The one producer of {@link SafeMessage}.
 *
 * Works over the whole value generically rather than block type by block type,
 * so a content block added to the IR later is covered on the day it lands
 * instead of on the day somebody remembers this file.
 */
export function sanitiseMessages(messages: readonly IRMessage[]): readonly SafeMessage[] {
  return messages.map((message) => {
    const tainted = isTainted(message);
    const neutralise: Neutralise = tainted ? encodeUntrusted : escapeControlMarkers;

    const content =
      typeof message.content === 'string'
        ? neutralise(message.content)
        : (message.content.map((block) =>
            sanitiseValue(block, tainted || isToolBlock(block) ? encodeUntrusted : neutralise),
          ) as MessageContent[]);

    return {
      ...message,
      role: encodeUntrusted(message.role) as IRMessage['role'],
      content,
    } as SafeMessage;
  });
}

/** Flatten IR content blocks down to the text a text-only template can use. */
export function messageText(message: IRMessage): string {
  if (typeof message.content === 'string') return message.content;
  return message.content
    .map((block) => {
      switch (block.type) {
        case 'text':
          return block.text;
        case 'image':
          return '[image]';
        case 'audio':
          return block.transcript ? `[audio: ${block.transcript}]` : '[audio]';
        case 'document':
          return `[document${block.filename ? `: ${block.filename}` : ''}]`;
        case 'video':
          return '[video]';
        case 'tool_use':
          return `[tool ${block.name}(${JSON.stringify(block.input)})]`;
        case 'tool_result':
          return typeof block.content === 'string'
            ? block.content
            : block.content.map((part) => part.text).join('');
        default:
          return '';
      }
    })
    .filter(Boolean)
    .join('\n');
}

interface TemplateSpec {
  readonly label: string;
  /**
   * Renders sanitised messages only. The parameter type is the enforcement:
   * a template cannot be handed raw content, because `renderPrompt` is the
   * only caller and it has nothing else to hand.
   */
  render(messages: readonly SafeMessage[]): string;
  readonly stopSequences: readonly string[];
}

const chatml: TemplateSpec = {
  label: 'ChatML',
  stopSequences: ['<|im_end|>', '<|im_start|>'],
  render(messages) {
    const parts = messages.map(
      (message) => `<|im_start|>${message.role}\n${messageText(message)}<|im_end|>`,
    );
    return `${parts.join('\n')}\n<|im_start|>assistant\n`;
  },
};

const llama3: TemplateSpec = {
  label: 'Llama 3',
  stopSequences: ['<|eot_id|>', '<|end_of_text|>'],
  render(messages) {
    const parts = messages.map(
      (message) =>
        `<|start_header_id|>${message.role}<|end_header_id|>\n\n${messageText(message)}<|eot_id|>`,
    );
    return `<|begin_of_text|>${parts.join('')}<|start_header_id|>assistant<|end_header_id|>\n\n`;
  },
};

const gemma: TemplateSpec = {
  label: 'Gemma',
  stopSequences: ['<end_of_turn>'],
  render(messages) {
    // Gemma has no system role; system content is folded into the first turn.
    const system = messages
      .filter((message) => message.role === 'system')
      .map(messageText)
      .join('\n\n');
    const turns = messages.filter((message) => message.role !== 'system');

    const parts = turns.map((message, index) => {
      const role = message.role === 'assistant' ? 'model' : 'user';
      const body =
        index === 0 && system ? `${system}\n\n${messageText(message)}` : messageText(message);
      return `<start_of_turn>${role}\n${body}<end_of_turn>`;
    });
    return `${parts.join('\n')}\n<start_of_turn>model\n`;
  },
};

/**
 * Gemma 4 — a different marker family from Gemma 2/3, not a newer dialect.
 *
 * Read out of `gemma-4-12B-it-QAT-Q4_0.gguf` (`general.architecture =
 * "gemma4"`), both its `tokenizer.chat_template` and its 262144-entry
 * `tokenizer.ggml.tokens`, rather than guessed from the family name:
 *
 * - `<|turn>` is token 105 and `<turn|>` is token 106; `<turn|>` is the EOG.
 * - `<start_of_turn>` and `<end_of_turn>` are NOT IN THE VOCABULARY AT ALL —
 *   `tokens.indexOf` returns -1 for both, so the {@link gemma} spec's markers
 *   reach this model as seven ordinary text tokens each. That is not a
 *   near-miss that degrades politely; the measured answer to "What is the
 *   capital city of Australia?" was "Australia's capital city of Australia's
 *   capital city of" with the Gemma 2/3 markers and "Canberra" with these.
 *
 * The newline after each marker is ordinary text — `<|turn>model\n` and
 * `<turn|>\n` are not themselves single tokens, only the bracketed parts are —
 * so the turns concatenate with no separator rather than joining on `\n`.
 *
 * ## Gemma 4 HAS a system turn, and this is the one place it diverges from Gemma
 *
 * {@link gemma} folds system content into the first user turn because Gemma 2/3
 * has no system role. Gemma 4 does: its canonical template emits a literal
 * `<|turn>system\n` block. Copying the fold would have been the safe-looking
 * choice and the wrong one. As in the canonical template the system content is
 * hoisted to a single leading turn, so two system messages cannot produce two
 * system blocks in the middle of a conversation.
 *
 * ## Why the prompt ends in an opened-and-closed thought channel
 *
 * The canonical template's `add_generation_prompt` branch emits `<|turn>model\n`
 * and then, when `enable_thinking` is false — which is its default —
 * `<|channel>thought\n<channel|>`. That is an EMPTY thought channel, opened and
 * immediately closed: it tells the model its thinking is already done.
 *
 * It belongs in the rendered prompt, not in a runtime flag, for three reasons.
 * Templates are applied here and nowhere else (see this file's header), so no
 * other layer could add it. This app has no thinking toggle to read. And
 * `splitThinking` in `domain/chat.ts` recognises `<think>`/`<thinking>`/
 * `<reasoning>` and NOT `<|channel>`, so a model left free to open its own
 * thought channel would have its reasoning rendered to the user as the answer.
 * If a thinking toggle is ever added, this is the line it has to reach — and
 * enabling thinking also means emitting `<|think|>\n` at the top of the system
 * turn, which is why the toggle is a spec-shape change rather than a flag here.
 *
 * No BOS: `tokenizer.ggml.add_bos_token` is true and the engines tokenize the
 * rendered prompt with `addSpecial: true`, so the vocabulary prepends its own.
 */
const gemma4: TemplateSpec = {
  label: 'Gemma 4',
  // Both are single tokens (106 and 105), which also makes them usable as the
  // `templateMarkers` vocabulary probe the engines run at load time.
  stopSequences: ['<turn|>', '<|turn>'],
  render(messages) {
    const system = messages
      .filter((message) => message.role === 'system')
      .map(messageText)
      .join('\n\n');
    const turns = messages.filter((message) => message.role !== 'system');

    let output = system ? `<|turn>system\n${system}<turn|>\n` : '';
    for (const message of turns) {
      // Only these three role names are ever emitted. The canonical template
      // wraps tool output in `<|tool_response>` blocks inside the model turn,
      // machinery a text-only renderer does not model, so tool content folds
      // into a user turn — the same conservative choice `gemma` makes.
      const role = message.role === 'assistant' ? 'model' : 'user';
      output += `<|turn>${role}\n${messageText(message)}<turn|>\n`;
    }
    return `${output}<|turn>model\n<|channel>thought\n<channel|>`;
  },
};

const mistral: TemplateSpec = {
  label: 'Mistral',
  stopSequences: ['</s>', '[INST]'],
  render(messages) {
    const system = messages
      .filter((message) => message.role === 'system')
      .map(messageText)
      .join('\n\n');
    const turns = messages.filter((message) => message.role !== 'system');

    let output = '<s>';
    let pendingSystem = system;
    for (const message of turns) {
      if (message.role === 'user') {
        const body = pendingSystem ? `${pendingSystem}\n\n${messageText(message)}` : messageText(message);
        pendingSystem = '';
        output += `[INST] ${body} [/INST]`;
      } else {
        output += ` ${messageText(message)}</s>`;
      }
    }
    return output;
  },
};

const phi: TemplateSpec = {
  label: 'Phi',
  stopSequences: ['<|end|>', '<|user|>'],
  render(messages) {
    const parts = messages.map(
      (message) => `<|${message.role}|>\n${messageText(message)}<|end|>`,
    );
    return `${parts.join('\n')}\n<|assistant|>\n`;
  },
};

const zephyr: TemplateSpec = {
  label: 'Zephyr',
  stopSequences: ['</s>'],
  render(messages) {
    const parts = messages.map((message) => `<|${message.role}|>\n${messageText(message)}</s>`);
    return `${parts.join('\n')}\n<|assistant|>\n`;
  },
};

const vicuna: TemplateSpec = {
  label: 'Vicuna',
  stopSequences: ['USER:', '</s>'],
  render(messages) {
    const parts = messages.map((message) => {
      if (message.role === 'system') return messageText(message);
      const label = message.role === 'assistant' ? 'ASSISTANT' : 'USER';
      return `${label}: ${messageText(message)}`;
    });
    return `${parts.join('\n')}\nASSISTANT:`;
  },
};

const alpaca: TemplateSpec = {
  label: 'Alpaca',
  stopSequences: ['### Instruction:'],
  render(messages) {
    const parts = messages.map((message) => {
      if (message.role === 'system') return messageText(message);
      const label = message.role === 'assistant' ? '### Response:' : '### Instruction:';
      return `${label}\n${messageText(message)}`;
    });
    return `${parts.join('\n\n')}\n\n### Response:\n`;
  },
};

const raw: TemplateSpec = {
  label: 'Raw',
  stopSequences: [],
  render(messages) {
    return messages.map(messageText).join('\n\n');
  },
};

const TEMPLATES: Record<PromptTemplate, TemplateSpec> = {
  chatml,
  llama3,
  gemma,
  gemma4,
  mistral,
  phi,
  qwen: chatml, // Qwen ships ChatML
  zephyr,
  vicuna,
  alpaca,
  raw,
};

/**
 * Render a conversation as prompt text for one template family.
 *
 * The only entry point, and the only place {@link sanitiseMessages} is called
 * — which is what makes the escaping a property of the renderer rather than a
 * rule every call site has to remember. Both call sites in the app (the
 * llama.cpp browser adapter and the desktop host's bundled copy) come through
 * here.
 */
export function renderPrompt(template: PromptTemplate, messages: readonly IRMessage[]): string {
  return (TEMPLATES[template] ?? chatml).render(sanitiseMessages(messages));
}

/** Every template family this app can render. Exported so a test can enumerate. */
export const TEMPLATE_IDS = Object.keys(TEMPLATES) as readonly PromptTemplate[];

/**
 * What one template contributes to a prompt when every message body is empty.
 *
 * In other words: its structure, extracted mechanically instead of restated in
 * a test fixture. Whatever this returns is exactly the text a hostile body
 * would have to be able to spell in order to forge a turn — which is what
 * `tests/taint.test.ts` checks the encoder against, for every template in
 * {@link TEMPLATE_IDS} including ones added after this comment.
 */
export function templateStructure(template: PromptTemplate): string {
  const probe = (['system', 'user', 'assistant', 'tool'] as const).map(
    (role) => ({ role, content: '' }) as unknown as SafeMessage,
  );
  return (TEMPLATES[template] ?? chatml).render(probe);
}

export function templateStopSequences(template: PromptTemplate): readonly string[] {
  return (TEMPLATES[template] ?? chatml).stopSequences;
}

export function templateLabel(template: PromptTemplate): string {
  return (TEMPLATES[template] ?? chatml).label;
}

/** Guess a template from a model id when the manifest does not state one. */
export function inferTemplate(modelId: string): PromptTemplate {
  const id = modelId.toLowerCase();
  if (id.includes('llama-3') || id.includes('llama3')) return 'llama3';
  /*
   * Gemma 4 before Gemma, because `includes('gemma')` matches both.
   *
   * This is a guess from a string, as the doc comment above admits, so it is
   * written to fail towards `gemma` — the wrong-but-old answer — rather than
   * towards `gemma4`. Two lookarounds do that work:
   *
   * - a digit after the 4 means the 4 was the first digit of a size, so
   *   `gemma-44b` stays `gemma`;
   * - a `b` after the 4 means the 4 WAS the size, so `gemma-4b` stays `gemma`.
   *
   * And requiring the 4 to sit immediately after `gemma` plus at most one
   * separator is what keeps `gemma-3-4b-it-q4km` — the id the shipping
   * catalogue entry uses, which contains three 4s — on `gemma`: its 4s are
   * preceded by `3-`, `b-it-q` and `m`, never by `gemma`.
   *
   * Matches: `gemma-4-12b-it-qat`, `gemma4-12b`, `google/gemma-4`, `gemma_4`.
   */
  if (/gemma[-_. ]?4(?![0-9b])/.test(id)) return 'gemma4';
  if (id.includes('gemma')) return 'gemma';
  if (id.includes('qwen')) return 'qwen';
  if (id.includes('mistral') || id.includes('mixtral')) return 'mistral';
  if (id.includes('phi')) return 'phi';
  if (id.includes('zephyr')) return 'zephyr';
  if (id.includes('vicuna')) return 'vicuna';
  return 'chatml';
}
