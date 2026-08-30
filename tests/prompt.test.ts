import { describe, expect, it } from 'vitest';

import type { IRMessage } from '@johnhenry/aimatey-types';
import {
  inferTemplate,
  messageText,
  renderPrompt,
  templateLabel,
  templateStopSequences,
} from '@/ai/prompt';

const conversation: IRMessage[] = [
  { role: 'system', content: 'You are terse.' },
  { role: 'user', content: 'Hello' },
  { role: 'assistant', content: 'Hi.' },
  { role: 'user', content: 'Again' },
];

describe('messageText', () => {
  it('passes through plain string content', () => {
    expect(messageText({ role: 'user', content: 'plain' })).toBe('plain');
  });

  it('flattens content blocks into text a text-only template can use', () => {
    const text = messageText({
      role: 'user',
      content: [
        { type: 'text', text: 'Look at this' },
        { type: 'image', source: { type: 'url', url: 'https://example.com/a.jpg' } },
      ],
    });
    expect(text).toBe('Look at this\n[image]');
  });

  it('prefers an audio transcript when one exists', () => {
    const text = messageText({
      role: 'user',
      content: [
        {
          type: 'audio',
          source: { type: 'url', url: 'https://example.com/a.mp3' },
          transcript: 'spoken words',
        },
      ],
    });
    expect(text).toBe('[audio: spoken words]');
  });

  it('renders tool results as their content', () => {
    const text = messageText({
      role: 'tool',
      content: [{ type: 'tool_result', toolUseId: 'x', content: '144' }],
    });
    expect(text).toBe('144');
  });
});

describe('renderPrompt', () => {
  it('renders ChatML with a trailing assistant turn', () => {
    const prompt = renderPrompt('chatml', conversation);
    expect(prompt).toContain('<|im_start|>system\nYou are terse.<|im_end|>');
    expect(prompt.endsWith('<|im_start|>assistant\n')).toBe(true);
  });

  it('renders Llama 3 header blocks', () => {
    const prompt = renderPrompt('llama3', conversation);
    expect(prompt.startsWith('<|begin_of_text|>')).toBe(true);
    expect(prompt).toContain('<|start_header_id|>user<|end_header_id|>');
    expect(prompt.endsWith('<|start_header_id|>assistant<|end_header_id|>\n\n')).toBe(true);
  });

  it('folds the system message into the first user turn for Gemma', () => {
    const prompt = renderPrompt('gemma', conversation);
    // Gemma has no system role, so the instruction must survive elsewhere.
    expect(prompt).toContain('You are terse.');
    expect(prompt).not.toContain('<start_of_turn>system');
    expect(prompt).toContain('<start_of_turn>model');
  });

  it('maps assistant to "model" for Gemma', () => {
    const prompt = renderPrompt('gemma', conversation);
    expect(prompt).toContain('<start_of_turn>model\nHi.<end_of_turn>');
  });

  it('wraps user turns in [INST] for Mistral and folds the system prompt in once', () => {
    const prompt = renderPrompt('mistral', conversation);
    expect(prompt.startsWith('<s>[INST] You are terse.')).toBe(true);
    expect(prompt.match(/You are terse\./g)).toHaveLength(1);
    expect(prompt).toContain('[INST] Again [/INST]');
  });

  it('treats Qwen as ChatML', () => {
    expect(renderPrompt('qwen', conversation)).toBe(renderPrompt('chatml', conversation));
  });

  it('falls back to ChatML for an unknown template', () => {
    const prompt = renderPrompt('nonsense' as never, conversation);
    expect(prompt).toContain('<|im_start|>');
  });

  it('renders every declared template without throwing', () => {
    for (const template of [
      'chatml',
      'llama3',
      'gemma',
      'mistral',
      'phi',
      'qwen',
      'zephyr',
      'vicuna',
      'alpaca',
      'raw',
    ] as const) {
      expect(renderPrompt(template, conversation).length).toBeGreaterThan(0);
      expect(templateLabel(template).length).toBeGreaterThan(0);
    }
  });

  it('keeps images out of the text prompt but preserves the surrounding words', () => {
    const prompt = renderPrompt('chatml', [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'What is here?' },
          { type: 'image', source: { type: 'base64', mediaType: 'image/png', data: 'AAA' } },
        ],
      },
    ]);
    expect(prompt).toContain('What is here?');
    expect(prompt).not.toContain('AAA');
  });
});

describe('templateStopSequences', () => {
  it('supplies the end tokens each family needs', () => {
    expect(templateStopSequences('chatml')).toContain('<|im_end|>');
    expect(templateStopSequences('llama3')).toContain('<|eot_id|>');
    expect(templateStopSequences('gemma')).toContain('<end_of_turn>');
    expect(templateStopSequences('raw')).toEqual([]);
  });
});

describe('inferTemplate', () => {
  it('recognises the common families from a model id', () => {
    expect(inferTemplate('bartowski/Llama-3.2-3B-Instruct-GGUF')).toBe('llama3');
    expect(inferTemplate('ggml-org/gemma-3-4b-it-GGUF')).toBe('gemma');
    expect(inferTemplate('unsloth/Qwen3-4B-Instruct')).toBe('qwen');
    expect(inferTemplate('TheBloke/Mixtral-8x7B')).toBe('mistral');
    expect(inferTemplate('bartowski/Phi-3.5-mini')).toBe('phi');
  });

  it('defaults to ChatML for anything unfamiliar', () => {
    expect(inferTemplate('somebody/unknown-model')).toBe('chatml');
  });
});
