import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  CliLineOverflowError,
  createCliLineSplitter,
  createClaudeTranslator,
  createCodexTranslator,
} from '@/ai/backends/cli-stream';

/**
 * JSONL -> IRStreamChunk (#115, #119, #120).
 *
 * The fixtures in `tests/fixtures/cli/` were captured from ONE real,
 * non-interactive run of each CLI with the trivial prompt "Reply with the
 * single word: pong" (an empty scratch directory, claude's `--permission-mode
 * plan` and codex's `-s read-only` at capture time — neither is the exact
 * turn argv this app ships; see `apps/desktop/src/bridge/cli-specs.ts`'s
 * `buildCliTurnArgv` for that, and its own doc for exactly what each CLI's
 * flags do and do not close), then trimmed to the lines that matter and
 * redacted: session ids, account
 * identifiers, absolute paths and this machine's own hooks/hooks/skills
 * output are all replaced with placeholders. The SHAPE and ORDER of the real
 * lines are preserved; nothing was invented.
 */

function fixture(name: string): string {
  return readFileSync(resolve(process.cwd(), `tests/fixtures/cli/${name}`), 'utf8');
}

function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

describe('createCliLineSplitter (#120)', () => {
  it('returns one complete line per push when a chunk already ends on a newline', () => {
    const splitter = createCliLineSplitter();
    expect(splitter.push(utf8('{"a":1}\n'))).toEqual(['{"a":1}']);
    expect(splitter.push(utf8('{"a":2}\n'))).toEqual(['{"a":2}']);
  });

  it('buffers a line split across two chunk boundaries', () => {
    const splitter = createCliLineSplitter();
    // The exact defect a byte-level splitter exists to prevent: a pipe chunk
    // boundary landing mid-line must not produce two lines or a parse error.
    expect(splitter.push(utf8('{"a":'))).toEqual([]);
    expect(splitter.push(utf8('1}\n'))).toEqual(['{"a":1}']);
  });

  it('buffers a multi-byte UTF-8 codepoint split across a chunk boundary', () => {
    const splitter = createCliLineSplitter();
    const line = '{"text":"pong 🏓"}\n';
    const bytes = utf8(line);
    // Split inside the 4-byte emoji codepoint, not on a line boundary.
    const emojiStart = bytes.indexOf(0xf0);
    expect(emojiStart).toBeGreaterThan(0);
    const splitPoint = emojiStart + 2;
    const first = splitter.push(bytes.subarray(0, splitPoint));
    expect(first).toEqual([]);
    const second = splitter.push(bytes.subarray(splitPoint));
    expect(second).toEqual(['{"text":"pong 🏓"}']);
  });

  it('strips a trailing \\r so CRLF output splits the same as LF', () => {
    const splitter = createCliLineSplitter();
    expect(splitter.push(utf8('{"a":1}\r\n{"a":2}\r\n'))).toEqual(['{"a":1}', '{"a":2}']);
  });

  it('emits multiple complete lines that arrived in one chunk, in order', () => {
    const splitter = createCliLineSplitter();
    expect(splitter.push(utf8('{"a":1}\n{"a":2}\n{"a":3}\n'))).toEqual([
      '{"a":1}',
      '{"a":2}',
      '{"a":3}',
    ]);
  });

  it('flush returns a final line with no trailing newline, and nothing once drained', () => {
    const splitter = createCliLineSplitter();
    expect(splitter.push(utf8('{"a":1}\n{"tail":true}'))).toEqual(['{"a":1}']);
    expect(splitter.flush()).toEqual(['{"tail":true}']);
    expect(splitter.flush()).toEqual([]);
  });

  it('flush returns nothing when the stream ended cleanly on a newline', () => {
    const splitter = createCliLineSplitter();
    splitter.push(utf8('{"a":1}\n'));
    expect(splitter.flush()).toEqual([]);
  });
});

describe('createCliLineSplitter caps its buffered bytes (#120)', () => {
  it('accepts a line right up to the cap', () => {
    const splitter = createCliLineSplitter(16);
    // 15 bytes buffered, no newline yet -- under the 16-byte cap.
    expect(() => splitter.push(utf8('a'.repeat(15)))).not.toThrow();
  });

  it('throws CliLineOverflowError once the still-undelimited tail exceeds the cap', () => {
    const splitter = createCliLineSplitter(16);
    expect(() => splitter.push(utf8('a'.repeat(17)))).toThrow(CliLineOverflowError);
  });

  it('checks the cap AFTER draining complete lines, not on total bytes ever seen', () => {
    const splitter = createCliLineSplitter(16);
    // Many short, complete lines -- each drained away, so the buffered tail
    // never grows past one line's worth of bytes. Total bytes pushed here
    // (30) exceeds the cap; the buffered TAIL never does.
    for (let i = 0; i < 10; i++) {
      expect(() => splitter.push(utf8('{"a":1}\n'))).not.toThrow();
    }
  });

  it('reports the configured limit in its message', () => {
    const splitter = createCliLineSplitter(16);
    try {
      splitter.push(utf8('a'.repeat(17)));
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(CliLineOverflowError);
      expect((error as Error).message).toContain('16');
    }
  });
});

describe('createClaudeTranslator, replayed over the real fixture (#115)', () => {
  it('produces exactly one start, the streamed text deltas, and one terminal done chunk', () => {
    const translator = createClaudeTranslator('req_1');
    const lines = fixture('claude-pong.jsonl').split('\n').filter((line) => line.length > 0);
    const chunks = lines.flatMap((line) => translator.push(line));

    expect(chunks.filter((chunk) => chunk.type === 'start')).toHaveLength(1);
    expect(chunks.filter((chunk) => chunk.type === 'content').map((chunk) => (chunk as { delta: string }).delta)).toEqual(
      ['p', 'ong'],
    );
    const terminal = chunks.filter((chunk) => chunk.type === 'done' || chunk.type === 'error');
    expect(terminal).toHaveLength(1);
    expect(terminal[0]).toMatchObject({ type: 'done', finishReason: 'stop' });
  });

  it('assigns a monotonic, gap-free sequence across every chunk it emits', () => {
    const translator = createClaudeTranslator('req_1');
    const lines = fixture('claude-pong.jsonl').split('\n').filter((line) => line.length > 0);
    const chunks = lines.flatMap((line) => translator.push(line));
    expect(chunks.map((chunk) => chunk.sequence)).toEqual(chunks.map((_, index) => index));
  });

  it('never produces a second terminal chunk, even if a line pathologically repeats "result"', () => {
    const translator = createClaudeTranslator('req_1');
    const resultLine = JSON.stringify({ type: 'result', is_error: false, result: 'pong', usage: {} });
    const first = translator.push(resultLine);
    const second = translator.push(resultLine);
    expect(first).toHaveLength(1);
    expect(second).toEqual([]);
  });

  it('ignores a line it cannot parse rather than throwing or emitting content', () => {
    const translator = createClaudeTranslator('req_1');
    expect(() => translator.push('not json at all')).not.toThrow();
    expect(translator.push('not json at all')).toEqual([]);
  });

  it('finish() synthesizes exactly one error chunk when the process exits with no terminal line', () => {
    const translator = createClaudeTranslator('req_1');
    translator.push(JSON.stringify({ type: 'stream_event', event: { type: 'message_start' } }));
    const onExit = translator.finish({ code: 1, signal: null });
    expect(onExit).toHaveLength(1);
    expect(onExit[0]?.type).toBe('error');
    // finish() called again (a caller mistake) must not double the terminal.
    expect(translator.finish({ code: 1, signal: null })).toEqual([]);
  });

  it('finish() adds nothing once a real terminal chunk already arrived', () => {
    const translator = createClaudeTranslator('req_1');
    const lines = fixture('claude-pong.jsonl').split('\n').filter((line) => line.length > 0);
    for (const line of lines) translator.push(line);
    expect(translator.finish({ code: 0, signal: null })).toEqual([]);
  });
});

describe('createCodexTranslator, replayed over the real fixture (#115)', () => {
  it('produces one start, one content chunk with the full item text, and one terminal done chunk', () => {
    const translator = createCodexTranslator('req_2');
    const lines = fixture('codex-pong.jsonl').split('\n').filter((line) => line.length > 0);
    const chunks = lines.flatMap((line) => translator.push(line));

    expect(chunks.filter((chunk) => chunk.type === 'start')).toHaveLength(1);
    const content = chunks.filter((chunk) => chunk.type === 'content');
    expect(content).toHaveLength(1);
    expect((content[0] as { delta: string }).delta).toBe('pong');
    const terminal = chunks.filter((chunk) => chunk.type === 'done' || chunk.type === 'error');
    expect(terminal).toHaveLength(1);
    expect(terminal[0]).toMatchObject({ type: 'done', finishReason: 'stop' });
  });

  it('assigns a monotonic, gap-free sequence across every chunk it emits', () => {
    const translator = createCodexTranslator('req_2');
    const lines = fixture('codex-pong.jsonl').split('\n').filter((line) => line.length > 0);
    const chunks = lines.flatMap((line) => translator.push(line));
    expect(chunks.map((chunk) => chunk.sequence)).toEqual(chunks.map((_, index) => index));
  });

  it('turns turn.failed into a terminal error chunk, not a done chunk', () => {
    const translator = createCodexTranslator('req_2');
    translator.push(JSON.stringify({ type: 'thread.started', thread_id: 't' }));
    const result = translator.push(
      JSON.stringify({ type: 'turn.failed', error: { message: 'sandbox denied the request' } }),
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ type: 'error', error: { message: 'sandbox denied the request' } });
  });

  it('does not translate a tool-shaped item, whether or not the CLI actually ran one (#115)', () => {
    const translator = createCodexTranslator('req_2');
    const result = translator.push(
      JSON.stringify({ item: { type: 'command_execution', command: 'ls' }, type: 'item.completed' }),
    );
    expect(result).toEqual([]);
  });

  it('finish() synthesizes exactly one error chunk on an abrupt exit', () => {
    const translator = createCodexTranslator('req_2');
    translator.push(JSON.stringify({ type: 'thread.started', thread_id: 't' }));
    const onExit = translator.finish({ code: null, signal: 'SIGKILL' });
    expect(onExit).toHaveLength(1);
    expect(onExit[0]?.type).toBe('error');
    expect((onExit[0] as { error: { message: string } } | undefined)?.error.message).toContain('SIGKILL');
  });
});
