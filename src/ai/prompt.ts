/**
 * Chat-template rendering.
 *
 * Templates are applied on the JavaScript side rather than inside each native
 * engine. That means a conversation produces byte-identical prompt text
 * whether it is served by llama.cpp, MLC-LLM, or a later runtime — which is
 * what makes "retry this turn on a different engine" a fair comparison
 * instead of a confound.
 */

import type { PromptTemplate } from '@/domain/manifest';
import type { IRMessage } from '@johnhenry/aimatey-types';

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
  render(messages: readonly IRMessage[]): string;
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

export function renderPrompt(template: PromptTemplate, messages: readonly IRMessage[]): string {
  return (TEMPLATES[template] ?? chatml).render(messages);
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
