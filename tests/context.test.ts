import { describe, expect, it } from 'vitest';

import type { IRMessage } from '@johnhenry/aimatey-types';
import {
  contextBudget,
  describeUsage,
  estimateConversationTokens,
  estimateMessageTokens,
  estimateTokens,
  fitToContext,
  usageTone,
} from '@/ai/context';

/**
 * Context budgeting decides what the model is allowed to forget. Getting it
 * wrong is invisible at the call site and disastrous in the thread: llama.cpp
 * truncates from the front, so an unbudgeted overflow eats the system prompt
 * and the persona, and the model appears to change personality mid-chat.
 */

const text = (role: IRMessage['role'], content: string): IRMessage => ({ role, content });

function longMessage(role: IRMessage['role'], tokens: number): IRMessage {
  // ~3.3 chars per token, so this lands near the requested size.
  return text(role, 'x'.repeat(tokens * 3));
}

describe('estimateTokens', () => {
  it('is zero for empty input', () => {
    expect(estimateTokens('')).toBe(0);
  });

  it('grows with length', () => {
    expect(estimateTokens('a'.repeat(330))).toBeGreaterThan(estimateTokens('a'.repeat(33)));
  });

  it('over-estimates rather than under-estimates', () => {
    // A pessimistic estimate costs a dropped turn; an optimistic one costs a
    // truncated system prompt. The bias must point the safe way.
    const prose = 'The quick brown fox jumps over the lazy dog. '.repeat(20);
    const realisticTokens = prose.split(/\s+/).filter(Boolean).length; // ~1 token/word
    expect(estimateTokens(prose)).toBeGreaterThanOrEqual(realisticTokens);
  });
});

describe('estimateMessageTokens', () => {
  it('charges per-message template overhead', () => {
    expect(estimateMessageTokens(text('user', ''))).toBeGreaterThan(0);
  });

  it('charges substantially for an image', () => {
    const withImage: IRMessage = {
      role: 'user',
      content: [
        { type: 'text', text: 'what is this' },
        { type: 'image', source: { type: 'base64', mediaType: 'image/png', data: 'AAAA' } },
      ],
    };
    // An image is worth hundreds of tokens once projected; costing it as its
    // base64 length or as zero would blow the budget either way.
    expect(estimateMessageTokens(withImage)).toBeGreaterThan(500);
  });

  it('counts tool calls and results', () => {
    const toolUse: IRMessage = {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 't1', name: 'calculate', input: { expression: '2+2' } }],
    };
    const toolResult: IRMessage = {
      role: 'tool',
      content: [{ type: 'tool_result', toolUseId: 't1', content: '4' }],
    };
    expect(estimateMessageTokens(toolUse)).toBeGreaterThan(4);
    expect(estimateMessageTokens(toolResult)).toBeGreaterThan(0);
  });

  it('sums a conversation', () => {
    const messages = [text('system', 'be terse'), text('user', 'hello')];
    expect(estimateConversationTokens(messages)).toBe(
      messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0),
    );
  });
});

describe('contextBudget', () => {
  it('reserves room for the reply', () => {
    const budget = contextBudget(8192, 1024);
    expect(budget.reserveForResponse).toBe(1024);
    expect(budget.promptBudget).toBe(8192 - 1024);
  });

  it('never reserves more than half the window', () => {
    // A 4k model with maxTokens 8192 would otherwise leave a negative budget.
    const budget = contextBudget(4096, 8192);
    expect(budget.reserveForResponse).toBe(2048);
    expect(budget.promptBudget).toBeGreaterThan(0);
  });

  it('always reserves enough to say something', () => {
    const budget = contextBudget(4096, 1);
    expect(budget.reserveForResponse).toBeGreaterThanOrEqual(128);
  });
});

describe('fitToContext', () => {
  const budget = contextBudget(2000, 500); // promptBudget = 1500

  it('keeps everything when it fits', () => {
    const messages = [text('system', 'be terse'), text('user', 'hi')];
    const fit = fitToContext(messages, budget);
    expect(fit.messages).toHaveLength(2);
    expect(fit.dropped).toBe(0);
    expect(fit.overflowed).toBe(false);
  });

  it('NEVER drops a system message — this is the whole point', () => {
    const messages = [
      text('system', 'You are Vess, a cartographer.'),
      ...Array.from({ length: 20 }, (_, i) => longMessage(i % 2 ? 'assistant' : 'user', 200)),
      text('user', 'and the channel depth?'),
    ];

    const fit = fitToContext(messages, budget);
    expect(fit.dropped).toBeGreaterThan(0);
    expect(fit.messages[0]).toEqual(messages[0]);
    expect(fit.messages.filter((m) => m.role === 'system')).toHaveLength(1);
  });

  it('never drops the final user message — it is the question', () => {
    const messages = [
      ...Array.from({ length: 20 }, (_, i) => longMessage(i % 2 ? 'assistant' : 'user', 200)),
      text('user', 'the actual question'),
    ];
    const fit = fitToContext(messages, budget);
    expect(fit.messages.at(-1)).toEqual(messages.at(-1));
  });

  it('drops oldest history first', () => {
    const messages = [
      text('system', 'sys'),
      text('user', 'OLDEST'),
      ...Array.from({ length: 12 }, () => longMessage('assistant', 150)),
      text('user', 'newest question'),
    ];
    const fit = fitToContext(messages, budget);
    expect(fit.dropped).toBeGreaterThan(0);
    expect(fit.messages.some((m) => m.content === 'OLDEST')).toBe(false);
  });

  it('preserves message order', () => {
    const messages = [
      text('system', 'sys'),
      ...Array.from({ length: 10 }, (_, i) => text('user', `turn ${i}`)),
      text('user', 'final'),
    ];
    const fit = fitToContext(messages, budget);
    const indices = fit.messages.map((m) => messages.indexOf(m));
    expect(indices).toEqual([...indices].sort((a, b) => a - b));
  });

  it('does not orphan a tool result from the call that produced it', () => {
    // An orphaned tool_result referencing an absent tool_use confuses every
    // model that supports tools.
    const messages: IRMessage[] = [
      text('system', 'sys'),
      ...Array.from({ length: 8 }, () => longMessage('assistant', 150)),
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'calc', input: {} }] },
      { role: 'tool', content: [{ type: 'tool_result', toolUseId: 't1', content: '4' }] },
      text('user', 'thanks'),
    ];

    const fit = fitToContext(messages, budget);
    const hasResult = fit.messages.some((m) => m.role === 'tool');
    const hasCall = fit.messages.some(
      (m) => Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_use'),
    );
    expect(hasResult).toBe(hasCall);
  });

  it('reports overflow instead of silently sending an impossible prompt', () => {
    const messages = [longMessage('system', 5000), text('user', 'hi')];
    const fit = fitToContext(messages, budget);
    expect(fit.overflowed).toBe(true);
    // Still returns the pinned messages — refusing outright would be worse.
    expect(fit.messages.length).toBeGreaterThan(0);
  });

  it('stays within budget when it does not overflow', () => {
    const messages = [
      text('system', 'sys'),
      ...Array.from({ length: 30 }, () => longMessage('user', 120)),
      text('user', 'final'),
    ];
    const fit = fitToContext(messages, budget);
    expect(fit.overflowed).toBe(false);
    expect(fit.estimatedTokens).toBeLessThanOrEqual(budget.promptBudget);
  });

  it('accounts for images when deciding what fits', () => {
    const withImages: IRMessage[] = Array.from({ length: 4 }, () => ({
      role: 'user' as const,
      content: [
        { type: 'text' as const, text: 'look' },
        {
          type: 'image' as const,
          source: { type: 'base64' as const, mediaType: 'image/png', data: 'A' },
        },
      ],
    }));

    const fit = fitToContext([text('system', 'sys'), ...withImages, text('user', 'q')], budget);
    // Four images at ~800 tokens each cannot fit a 1500-token budget.
    expect(fit.dropped).toBeGreaterThan(0);
  });

  it('handles an empty conversation', () => {
    const fit = fitToContext([], budget);
    expect(fit.messages).toEqual([]);
    expect(fit.overflowed).toBe(false);
  });
});

describe('usage reporting', () => {
  it('describes usage as used / total with a percentage', () => {
    expect(describeUsage(2048, 8192)).toBe('2,048 / 8,192 (25%)');
  });

  it('escalates tone as the window fills', () => {
    expect(usageTone(1000, 8192)).toBe('ember');
    expect(usageTone(6000, 8192)).toBe('warn');
    expect(usageTone(7800, 8192)).toBe('crit');
  });

  it('does not divide by zero on an unknown window', () => {
    expect(usageTone(100, 0)).toBe('ember');
    expect(describeUsage(100, 0)).toContain('0%');
  });
});
