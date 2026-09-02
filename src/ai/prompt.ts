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
 * The escape is a codepoint substitution, not a deletion — `<|im_start|>`
 * becomes `＜｜im_start｜＞`. A reader still sees what the tool printed; a
 * tokeniser can no longer see a special token, because none of the fullwidth
 * forms appear in any of these vocabularies.
 */

import type { PromptTemplate } from '@/domain/manifest';
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
  // ChatML, Llama 3, Phi and Zephyr all live in this one shape.
  /<\|[^|<>\n]{1,40}\|>/g,
  // Gemma's turn markers, and the Mistral/Zephyr sentence tokens.
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
 * Fullwidth counterparts. Chosen because they read identically to a human and
 * tokenise as ordinary text: no BPE vocabulary in this catalogue maps a
 * fullwidth run onto a special token.
 */
const FULLWIDTH: Readonly<Record<string, string>> = {
  '<': '＜',
  '>': '＞',
  '|': '｜',
  '[': '［',
  ']': '］',
  '#': '＃',
  ':': '：',
};

/** Neutralise one matched marker, character by character. */
function widen(marker: string): string {
  return Array.from(marker, (character) => FULLWIDTH[character] ?? character).join('');
}

/**
 * Make text that cannot open or close a turn in any template this file ships.
 *
 * Exported for tests and for anything else that has to put model-influenced
 * text into a prompt-shaped string. Idempotent: escaped text contains no
 * marker, so a second pass is a no-op.
 */
export function escapeControlMarkers(text: string): string {
  let out = text;
  for (const pattern of CONTROL_MARKERS) out = out.replace(pattern, widen);
  return out;
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

/** Structural keys that are never rendered as prose, and large opaque blobs. */
const NOT_TEXT = new Set(['type', 'data']);

/** Deep-escape every string in an arbitrary IR value. */
function sanitiseValue(value: unknown): unknown {
  if (typeof value === 'string') return escapeControlMarkers(value);
  if (Array.isArray(value)) return value.map(sanitiseValue);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      out[key] = NOT_TEXT.has(key) ? inner : sanitiseValue(inner);
    }
    return out;
  }
  return value;
}

/**
 * The one producer of {@link SafeMessage}.
 *
 * Escapes generically rather than block type by block type, so a content block
 * added to the IR later is covered on the day it lands instead of on the day
 * somebody remembers this file.
 */
export function sanitiseMessages(messages: readonly IRMessage[]): readonly SafeMessage[] {
  return messages.map((message) => {
    const content =
      typeof message.content === 'string'
        ? escapeControlMarkers(message.content)
        : (sanitiseValue(message.content) as MessageContent[]);
    return {
      ...message,
      role: escapeControlMarkers(message.role) as IRMessage['role'],
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
  if (id.includes('gemma')) return 'gemma';
  if (id.includes('qwen')) return 'qwen';
  if (id.includes('mistral') || id.includes('mixtral')) return 'mistral';
  if (id.includes('phi')) return 'phi';
  if (id.includes('zephyr')) return 'zephyr';
  if (id.includes('vicuna')) return 'vicuna';
  return 'chatml';
}
