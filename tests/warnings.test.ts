import { describe, expect, it } from 'vitest';

import { fallbackWarning, mergeWarnings, projectWarning, warningsOf } from '@/ai/warnings';
import { streamIntegrityWarning } from '@/ai/engine';

/**
 * #149. The engine's coverage of this channel drives a real degraded turn and
 * finds the warning at the far end, which is the assertion that matters. These
 * cover the parts that turn has no way to reach: the dedup, which only fires on
 * the non-streaming path where both sources describe the same divert, and the
 * projection's field selection.
 */
describe('turn warnings', () => {
  it('drops the upstream fields a person is never shown', () => {
    const projected = projectWarning({
      category: 'parameter-clamped',
      severity: 'info',
      message: 'temperature was clamped to 1',
      field: 'temperature',
      originalValue: 2.5,
      transformedValue: 1,
      source: 'openai-backend',
    });

    expect(projected).toEqual({
      category: 'parameter-clamped',
      severity: 'info',
      message: 'temperature was clamped to 1',
      source: 'openai-backend',
    });
    // Specifically these: they describe parameter translation, not something
    // to tell a user, and persisting them puts upstream shape in our database.
    expect(projected).not.toHaveProperty('field');
    expect(projected).not.toHaveProperty('originalValue');
    expect(projected).not.toHaveProperty('transformedValue');
  });

  it('omits source rather than writing undefined into it', () => {
    const projected = projectWarning({
      category: 'transport-degraded',
      severity: 'warning',
      message: 'the link reconnected mid-response',
    });
    expect('source' in projected).toBe(false);
  });

  it('treats an absent warnings array as no warnings', () => {
    // Most backends never set the field at all, so this is the common path.
    expect(warningsOf(undefined)).toEqual([]);
  });

  it('says nothing for a turn that did not fall back', () => {
    expect(fallbackWarning('none', 'scripted')).toBeNull();
  });

  it('collapses the same condition reported by both sources', () => {
    /*
     * The non-streaming path can produce one divert twice: the resilience
     * middleware writes it into metadata.warnings, and the engine converts its
     * own FallbackEvent for the same divert. Telling the user the same sentence
     * twice reads as two problems.
     */
    const fromMetadata = warningsOf([
      {
        category: 'model-substituted',
        severity: 'warning',
        message: 'Your device is running hot, so this reply was generated remotely.',
        source: 'llama-cpp',
      },
    ]);
    const fromEngine = fallbackWarning('thermal', 'llama-cpp');
    expect(fromEngine).not.toBeNull();

    const merged = mergeWarnings(fromMetadata, [fromEngine!]);
    expect(merged).toHaveLength(1);

    // The control: two genuinely different conditions both survive, so the
    // dedup is not just collapsing everything to one.
    const other = fallbackWarning('memory', 'llama-cpp');
    expect(mergeWarnings(fromMetadata, [other!])).toHaveLength(2);
  });

  it('does not collapse two warnings that differ only by source', () => {
    // Same sentence from two backends is two facts, not one.
    const a = fallbackWarning('thermal', 'llama-cpp');
    const b = fallbackWarning('thermal', 'onnx');
    expect(mergeWarnings([a!], [b!])).toHaveLength(2);
  });
});

/* ── #148: done.message as a checksum on delta accumulation ──────────── */

describe('stream integrity', () => {
  it('says nothing when there is no assembled message to compare against', () => {
    // `message` is optional and most in-process turns omit it, so this is the
    // common path — it must not warn.
    expect(streamIntegrityWarning('hello', undefined)).toBeNull();
  });

  it('says nothing when the two accumulations agree', () => {
    expect(
      streamIntegrityWarning('hello world', { role: 'assistant', content: 'hello world' }),
    ).toBeNull();
  });

  it('reports a DROPPED frame as transport, with the shortfall', () => {
    const warning = streamIntegrityWarning('hello ', {
      role: 'assistant',
      content: 'hello world',
    });
    expect(warning).toMatchObject({ category: 'transport-degraded', source: 'stream' });
    // The number matters: 'something went wrong' is not actionable.
    expect(warning?.message).toContain('5 characters');
    // And it must not read as the model's fault, which is the defect.
    expect(warning?.message).not.toMatch(/model/i);
  });

  it('reports a REORDERED stream differently from a truncated one', () => {
    // Same length, different order — the case that renders as a scrambled
    // reply and currently reads to the user as the model failing.
    const warning = streamIntegrityWarning('world hello', {
      role: 'assistant',
      content: 'hello world',
    });
    expect(warning?.category).toBe('transport-degraded');
    expect(warning?.message).toMatch(/order/i);
    expect(warning?.message).not.toContain('characters did not reach');
  });

  it('does not compare against placeholders for non-text blocks', () => {
    /*
     * The trap this avoids: `messageText` in src/ai/prompt.ts renders an image
     * as `[image]` and a tool call as `[tool name({...})]`, because it builds a
     * prompt. Comparing THAT against a delta stream would report a mismatch on
     * every reply containing anything but plain text.
     */
    const warning = streamIntegrityWarning('Here you go.', {
      role: 'assistant',
      content: [
        { type: 'text', text: 'Here you go.' },
        { type: 'tool_use', id: 't1', name: 'search', input: { q: 'x' } },
      ],
    });
    expect(warning).toBeNull();
  });

  it('says nothing when the far side sent no text at all', () => {
    // A reply that is entirely tool calls has an empty assembled text. That is
    // not a report that nothing arrived, and warning here would fire on every
    // such turn.
    expect(
      streamIntegrityWarning('', {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 't1', name: 'search', input: {} }],
      }),
    ).toBeNull();
  });
});

