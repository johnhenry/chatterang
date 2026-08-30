import { describe, expect, it } from 'vitest';

import { deriveTitle, splitThinking } from '@/domain/chat';
import { formatBytes, resolveSourceUrl } from '@/domain/manifest';
import {
  fromCharacterCard,
  renderLore,
  renderSystemPrompt,
  selectLore,
  toCharacterCard,
  type CharacterCardV2,
  type Persona,
} from '@/domain/persona';

describe('splitThinking', () => {
  it('leaves plain text untouched', () => {
    expect(splitThinking('Hello there.')).toEqual({
      content: 'Hello there.',
      thinking: '',
      open: false,
    });
  });

  it('separates a closed reasoning block from the answer', () => {
    const result = splitThinking('<think>Weigh the options.</think>\nThe answer is 42.');
    expect(result.thinking).toBe('Weigh the options.');
    expect(result.content).toBe('The answer is 42.');
    expect(result.open).toBe(false);
  });

  it('reports an unterminated block as still open, so the UI can stream it', () => {
    const result = splitThinking('<think>Still working');
    expect(result.open).toBe(true);
    expect(result.thinking).toBe('Still working');
    expect(result.content).toBe('');
  });

  it('handles several blocks and the alternate tag spellings', () => {
    const result = splitThinking('<reasoning>one</reasoning>A<thinking>two</thinking>B');
    expect(result.thinking).toBe('one\ntwo');
    expect(result.content).toBe('AB');
  });

  it('keeps text that precedes the first block', () => {
    const result = splitThinking('Before <think>mid</think> after');
    expect(result.content).toBe('Before  after');
    expect(result.thinking).toBe('mid');
  });
});

describe('deriveTitle', () => {
  it('collapses whitespace', () => {
    expect(deriveTitle('  hello   world \n')).toBe('hello world');
  });

  it('truncates long prompts with an ellipsis', () => {
    const title = deriveTitle('x'.repeat(80));
    expect(title.length).toBeLessThanOrEqual(42);
    expect(title.endsWith('…')).toBe(true);
  });

  it('falls back for empty input', () => {
    expect(deriveTitle('   ')).toBe('New chat');
  });
});

describe('formatBytes', () => {
  it('formats each magnitude', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(900)).toBe('900 B');
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(2_019_377_696)).toBe('1.9 GB');
  });

  it('respects the digit count', () => {
    expect(formatBytes(6 * 1024 ** 3, 0)).toBe('6 GB');
  });
});

describe('resolveSourceUrl', () => {
  it('builds a Hugging Face resolve URL', () => {
    const url = resolveSourceUrl({ repo: 'org/repo', file: 'model.gguf' });
    expect(url).toBe('https://huggingface.co/org/repo/resolve/main/model.gguf?download=true');
  });

  it('encodes nested companion paths', () => {
    const url = resolveSourceUrl({ repo: 'org/repo', file: 'a.gguf' }, 'onnx/decoder.onnx');
    expect(url).toContain('onnx%2Fdecoder.onnx');
  });

  it('prefers an explicit URL for the primary file only', () => {
    const source = { repo: 'org/repo', file: 'a.gguf', url: 'https://example.com/a.gguf' };
    expect(resolveSourceUrl(source)).toBe('https://example.com/a.gguf');
    expect(resolveSourceUrl(source, 'b.gguf')).toContain('huggingface.co');
  });
});

/* ── Personas ───────────────────────────────────────────────────────── */

function persona(overrides: Partial<Persona> = {}): Persona {
  return {
    id: 'p1',
    kind: 'character',
    name: 'Vess',
    tagline: 'A cartographer',
    avatarSeed: 'vess',
    description: '{{char}} draws coastlines for {{user}}.',
    version: 1,
    tags: [],
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

describe('renderSystemPrompt', () => {
  it('substitutes the character and user placeholders', () => {
    const output = renderSystemPrompt(persona(), 'Ada');
    expect(output).toContain('Vess draws coastlines for Ada.');
    expect(output).not.toContain('{{char}}');
  });

  it('supplies a stay-in-character instruction when none is given', () => {
    expect(renderSystemPrompt(persona())).toContain('Stay in character');
  });

  it('uses an explicit system prompt in place of the default', () => {
    const output = renderSystemPrompt(persona({ systemPrompt: 'Be terse.' }));
    expect(output).toContain('Be terse.');
    expect(output).not.toContain('Stay in character');
  });

  it('adds no character framing for assistant personas', () => {
    const output = renderSystemPrompt(persona({ kind: 'assistant', description: 'Edits text.' }));
    expect(output).toBe('Edits text.');
  });
});

describe('selectLore', () => {
  const book = {
    entries: [
      { id: 'a', keys: ['shelf'], content: 'The Shelf is shallow.', enabled: true, priority: 5 },
      { id: 'b', keys: [], content: 'Always true.', constant: true, enabled: true, priority: 9 },
      { id: 'c', keys: ['pell'], content: 'Pell sells rope.', enabled: false, priority: 1 },
      { id: 'd', keys: ['HARBOUR'], content: 'Case sensitive.', enabled: true, caseSensitive: true },
    ],
  };

  it('always includes constant entries', () => {
    expect(selectLore(book, 'nothing relevant').map((entry) => entry.id)).toEqual(['b']);
  });

  it('includes entries whose keys appear, case-insensitively by default', () => {
    const ids = selectLore(book, 'tell me about the SHELF').map((entry) => entry.id);
    expect(ids).toContain('a');
  });

  it('skips disabled entries even when their key matches', () => {
    expect(selectLore(book, 'pell').map((entry) => entry.id)).not.toContain('c');
  });

  it('honours case sensitivity when asked for', () => {
    expect(selectLore(book, 'harbour').map((entry) => entry.id)).not.toContain('d');
    expect(selectLore(book, 'HARBOUR').map((entry) => entry.id)).toContain('d');
  });

  it('orders by priority and stops at the budget', () => {
    const selected = selectLore(book, 'shelf', 15);
    expect(selected.map((entry) => entry.id)).toEqual(['b']);
  });

  it('returns nothing when there is no book', () => {
    expect(selectLore(undefined, 'anything')).toEqual([]);
  });
});

describe('renderLore', () => {
  it('is empty for no entries', () => {
    expect(renderLore([])).toBe('');
  });

  it('joins entries under a heading', () => {
    const output = renderLore([
      { id: 'a', keys: [], content: 'One.', enabled: true },
      { id: 'b', keys: [], content: 'Two.', enabled: true },
    ]);
    expect(output).toBe('## Relevant background\nOne.\n\nTwo.');
  });
});

describe('Character Card v2 interchange', () => {
  const card: CharacterCardV2 = {
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: {
      name: 'Ansel',
      description: 'A lighthouse keeper.',
      personality: 'Unhurried.',
      first_mes: 'The beam sweeps.',
      alternate_greetings: ['Another opening.'],
      tags: ['roleplay'],
      creator: 'Marren',
      character_book: {
        entries: [
          { keys: ['light'], content: 'A Fresnel lens.', insertion_order: 3, enabled: true },
        ],
      },
    },
  };

  it('imports every field it is given', () => {
    const draft = fromCharacterCard(card);
    expect(draft.name).toBe('Ansel');
    expect(draft.kind).toBe('character');
    expect(draft.firstMessage).toBe('The beam sweeps.');
    expect(draft.alternateGreetings).toEqual(['Another opening.']);
    expect(draft.characterBook?.entries[0]?.priority).toBe(3);
    expect(draft.creator).toBe('Marren');
  });

  it('survives a round trip', () => {
    const draft = fromCharacterCard(card);
    const restored = toCharacterCard({
      ...draft,
      id: 'x',
      version: 1,
      createdAt: 0,
      updatedAt: 0,
    } as Persona);

    expect(restored.data.name).toBe(card.data.name);
    expect(restored.data.first_mes).toBe(card.data.first_mes);
    expect(restored.data.character_book?.entries?.[0]?.keys).toEqual(['light']);
  });

  it('tolerates an almost-empty card', () => {
    const draft = fromCharacterCard({ spec: 'chara_card_v2', spec_version: '2.0', data: {} });
    expect(draft.name).toBe('Unnamed character');
    expect(draft.characterBook).toBeUndefined();
  });
});
