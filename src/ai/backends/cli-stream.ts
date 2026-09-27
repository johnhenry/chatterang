/**
 * JSONL FROM A LOCAL AGENT CLI, TRANSLATED TO THE IR (#115, #119, #120).
 *
 * A CLI's stdout is bytes, not lines and not JSON: a chunk from a pipe can
 * split a line in half, and can split a multi-byte UTF-8 codepoint in half
 * while it is at it. {@link createCliLineSplitter} is the byte-level layer
 * that turns that into complete decoded lines, buffering whatever is left
 * over across calls until a newline (`\n`, with an optional preceding `\r`
 * stripped) completes it. It decodes a line only once every one of its bytes
 * has arrived, which is what makes a codepoint split across two `push()`
 * calls a non-issue rather than a `TextDecoder` replacement character.
 *
 * Above that sits one translator PER CLI — {@link createClaudeTranslator},
 * {@link createCodexTranslator} — because the three wire formats agree on
 * almost nothing: `claude` streams token deltas inside `stream_event`
 * envelopes and reports a `result` line; `codex exec --json` reports whole
 * items via `item.completed` and a `turn.completed`/`turn.failed` line.
 * (`gemini`'s translator is NOT built in this pass — see the note at the
 * bottom of this file.)
 *
 * TWO INVARIANTS EVERY TRANSLATOR HOLDS, THE SAME WAY FOR ALL OF THEM:
 *
 *   - `sequence` is assigned BY THE TRANSLATOR, monotonically, starting at 0,
 *     spanning every chunk it emits — never read off the CLI's own line
 *     numbering, which has no such guarantee and is not this app's contract
 *     to keep (`BaseStreamChunk.sequence`'s own doc, `@johnhenry/aimatey-types`).
 *   - EXACTLY ONE terminal chunk (`done` or `error`) is ever produced, across
 *     every `push()` and the one `finish()` call. A CLI whose JSONL contains a
 *     second terminal-shaped line (defensive; not observed) is not honoured a
 *     second time, and a CLI that never produces one — it crashed, it was
 *     killed — gets one synthesized in `finish()`, so a consumer can always
 *     wait for exactly one and never hang or double-terminate a turn.
 *
 * Neither translator imports anything Node-only: they take decoded strings in
 * and IR chunks out, so they can run in the SAME process as whatever reads
 * the CLI's stdout, whether that is Electron main (`apps/desktop`) or a test.
 */

import type { IRStreamChunk } from '@johnhenry/aimatey-types';

/** A line-buffered byte stream, decoded only once a full line has arrived. */
export interface CliLineSplitter {
  /** Feed the next chunk of raw stdout bytes; returns every complete line it now contains. */
  push(chunk: Uint8Array): readonly string[];
  /**
   * Called once, when the stream ends (stdout closed). Returns the final
   * buffered line if the CLI's own output did not end in a trailing
   * newline — never invented content, just whatever bytes were still
   * waiting to be decoded.
   */
  flush(): readonly string[];
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

const NEWLINE = 0x0a;
const CARRIAGE_RETURN = 0x0d;

/**
 * A GENEROUS, NOT TIGHT, CAP (#120). `createCliLineSplitter` buffers bytes
 * with no newline in them yet — a real JSONL line from any of these three
 * CLIs is at most a few KB, so this is not sized to real traffic; it is
 * sized so that a CLI that stops emitting newlines (a bug, a hang, a
 * malicious binary someone pointed #116's override at) cannot make this
 * process hold an unbounded buffer for the lifetime of a turn.
 */
export const CLI_LINE_SPLITTER_MAX_BUFFERED_BYTES = 8 * 1024 * 1024;

/**
 * Thrown by {@link CliLineSplitter.push} when the buffered, still-undelimited
 * tail exceeds the splitter's cap. The caller's job — `src/ai/backends/cli.ts`'s
 * `executeStream` — is to end the turn with exactly one `error` terminal
 * chunk, the same as any other translator-level failure, never to let this
 * propagate as an unhandled rejection.
 */
export class CliLineOverflowError extends Error {
  override readonly name = 'CliLineOverflowError';
  constructor(maxBufferedBytes: number) {
    super(
      `cli-stream: buffered more than ${maxBufferedBytes} bytes with no newline. ` +
        'Refusing to keep growing an unbounded line.',
    );
  }
}

/**
 * Byte-level line splitter (#120): buffers across `push()` calls, decodes
 * only complete lines, and refuses to buffer past `maxBufferedBytes` of
 * still-undelimited tail (see {@link CLI_LINE_SPLITTER_MAX_BUFFERED_BYTES}).
 */
export function createCliLineSplitter(
  maxBufferedBytes: number = CLI_LINE_SPLITTER_MAX_BUFFERED_BYTES,
): CliLineSplitter {
  let buffered: Uint8Array = new Uint8Array(0);
  const decoder = new TextDecoder('utf-8');

  function drain(): string[] {
    const lines: string[] = [];
    for (;;) {
      const newlineIndex = buffered.indexOf(NEWLINE);
      if (newlineIndex === -1) break;
      const end = newlineIndex > 0 && buffered[newlineIndex - 1] === CARRIAGE_RETURN
        ? newlineIndex - 1
        : newlineIndex;
      lines.push(decoder.decode(buffered.subarray(0, end)));
      buffered = buffered.subarray(newlineIndex + 1);
    }
    return lines;
  }

  return {
    push(chunk) {
      buffered = concatBytes(buffered, chunk);
      const lines = drain();
      // Checked AFTER draining every complete line out: the cap is about one
      // line that never ends, not about total throughput across many lines.
      if (buffered.length > maxBufferedBytes) {
        throw new CliLineOverflowError(maxBufferedBytes);
      }
      return lines;
    },
    flush() {
      if (buffered.length === 0) return [];
      const last = decoder.decode(buffered);
      buffered = new Uint8Array(0);
      return last === '' ? [] : [last];
    },
  };
}

/** How a CLI's process ended, for `finish()` to describe if no terminal chunk arrived first. */
export interface CliExit {
  readonly code: number | null;
  readonly signal: string | null;
}

/** One translator, stateful across the lines of exactly one turn. */
export interface CliStreamTranslator {
  readonly cliId: string;
  /** Feed one decoded JSONL line (never a raw byte chunk — that is `CliLineSplitter`'s job). */
  push(line: string): readonly IRStreamChunk[];
  /** Call exactly once, after the process exits, whether or not a terminal chunk was already seen. */
  finish(exit: CliExit): readonly IRStreamChunk[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function numberField(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** Shared machinery every per-CLI translator needs: a sequence counter and a one-shot terminal gate. */
function createTranslatorState() {
  let sequence = 0;
  let terminalEmitted = false;
  return {
    next: (): number => sequence++,
    /** Wraps a terminal chunk so a second one — from the CLI, or from `finish()` — is dropped. */
    terminal: (chunk: IRStreamChunk): readonly IRStreamChunk[] => {
      if (terminalEmitted) return [];
      terminalEmitted = true;
      return [chunk];
    },
    hasTerminal: (): boolean => terminalEmitted,
  };
}

function exitDescription(cliId: string, exit: CliExit): string {
  const code = exit.code === null ? 'no exit code' : `exit code ${exit.code}`;
  const signal = exit.signal ? `, signal ${exit.signal}` : '';
  return `${cliId} exited before completing its reply (${code}${signal})`;
}

/**
 * `claude -p --output-format stream-json --verbose --include-partial-messages
 * --input-format stream-json` (#115, verified against `claude --help` 2.1.263
 * and one real "Reply with the single word: pong" run —
 * `tests/fixtures/cli/claude-pong.jsonl`, redacted).
 *
 * Lines this translator acts on:
 *   - `{"type":"stream_event","event":{"type":"message_start",...}}` -> `start`
 *   - `{"type":"stream_event","event":{"type":"content_block_delta",
 *      "delta":{"type":"text_delta","text":"..."}}}` -> `content`
 *   - `{"type":"result",...}` -> the terminal chunk: `done` unless
 *     `is_error`, in which case `error`.
 * Every other line — the `system` lines this user's own hooks and skills
 * inject, `stream_event` subtypes this translator does not need
 * (`content_block_start/stop`, `message_delta`, `message_stop`),
 * `rate_limit_event` — is not content and not an error; it is simply not
 * translated, and `push` returns `[]` for it.
 */
export function createClaudeTranslator(requestId: string): CliStreamTranslator {
  const state = createTranslatorState();

  return {
    cliId: 'claude',
    push(line) {
      if (line.trim() === '') return [];
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        // A line this app cannot parse is not content and not this app's
        // crash to have (#120): a malformed line must not become a chunk
        // that looks like a reply.
        return [];
      }
      if (!isRecord(parsed)) return [];

      if (parsed.type === 'stream_event' && isRecord(parsed.event)) {
        const event = parsed.event;
        if (event.type === 'message_start') {
          return [
            { type: 'start', sequence: state.next(), metadata: { requestId, timestamp: Date.now() } },
          ];
        }
        if (
          event.type === 'content_block_delta' &&
          isRecord(event.delta) &&
          event.delta.type === 'text_delta' &&
          typeof event.delta.text === 'string'
        ) {
          return [{ type: 'content', sequence: state.next(), delta: event.delta.text }];
        }
        return [];
      }

      if (parsed.type === 'result') {
        if (parsed.is_error === true) {
          return state.terminal({
            type: 'error',
            sequence: state.next(),
            error: {
              code: 'cli_error',
              message: typeof parsed.result === 'string' ? parsed.result : 'claude reported an error',
            },
          });
        }
        const usage = isRecord(parsed.usage) ? parsed.usage : undefined;
        const promptTokens = usage ? numberField(usage.input_tokens) : 0;
        const completionTokens = usage ? numberField(usage.output_tokens) : 0;
        return state.terminal({
          type: 'done',
          sequence: state.next(),
          finishReason: 'stop',
          usage: usage ? { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens } : undefined,
        });
      }

      return [];
    },
    finish(exit) {
      if (state.hasTerminal()) return [];
      return state.terminal({
        type: 'error',
        sequence: state.next(),
        error: { code: 'cli_exit', message: exitDescription('claude', exit) },
      });
    },
  };
}

/**
 * `codex exec --json` (#115, verified against `codex exec --help` 0.144.1 and
 * one real "Reply with the single word: pong" run —
 * `tests/fixtures/cli/codex-pong.jsonl`, redacted). Sandbox: `-s read-only`
 * (#115's "codex sandbox read-only").
 *
 * Unlike `claude`, this run produced no per-token deltas: `item.completed`
 * carries the WHOLE item text at once. That is not this translator inventing
 * a coarser granularity — it is what the CLI actually sent — so one
 * `item.completed` with `item.type: "agent_message"` becomes one `content`
 * chunk carrying the full text as its `delta`. A tool-shaped item
 * (`command_execution`, etc.) is not translated: this app never asked for
 * one to run, and a translator that rendered one as text would be showing
 * the user something outside that ask. This is NOT the same claim as "codex
 * cannot run one" — it demonstrably can (the owner-approved probe in
 * `apps/desktop/src/bridge/cli-specs.ts`'s `CODEX_TURN_ARGV` doc measured
 * it invoking `/bin/zsh`, confined by `-s read-only` to no writes and no
 * network). If one ever appears in a real stream, this translator silently
 * drops it rather than rendering it, which is a translator-level
 * containment, not a claim that the CLI never ran it.
 *
 * Lines this translator acts on:
 *   - `{"type":"thread.started",...}` -> `start`
 *   - `{"type":"item.completed","item":{"type":"agent_message","text":"..."}}` -> `content`
 *   - `{"type":"turn.completed",...}` -> `done`
 *   - `{"type":"turn.failed","error":{...}}` -> `error`
 */
export function createCodexTranslator(requestId: string): CliStreamTranslator {
  const state = createTranslatorState();

  return {
    cliId: 'codex',
    push(line) {
      if (line.trim() === '') return [];
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        return [];
      }
      if (!isRecord(parsed)) return [];

      if (parsed.type === 'thread.started') {
        return [
          { type: 'start', sequence: state.next(), metadata: { requestId, timestamp: Date.now() } },
        ];
      }

      if (parsed.type === 'item.completed' && isRecord(parsed.item)) {
        const item = parsed.item;
        if (item.type === 'agent_message' && typeof item.text === 'string') {
          return [{ type: 'content', sequence: state.next(), delta: item.text }];
        }
        return [];
      }

      if (parsed.type === 'turn.completed') {
        const usage = isRecord(parsed.usage) ? parsed.usage : undefined;
        const promptTokens = usage ? numberField(usage.input_tokens) : 0;
        const completionTokens = usage ? numberField(usage.output_tokens) : 0;
        return state.terminal({
          type: 'done',
          sequence: state.next(),
          finishReason: 'stop',
          usage: usage ? { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens } : undefined,
        });
      }

      if (parsed.type === 'turn.failed') {
        const error = isRecord(parsed.error) ? parsed.error : undefined;
        const message = error && typeof error.message === 'string' ? error.message : 'codex reported a failed turn';
        return state.terminal({
          type: 'error',
          sequence: state.next(),
          error: { code: 'cli_error', message },
        });
      }

      // `turn.started`, the bare `{"type":"error",...}` codex also emits
      // ahead of `turn.failed`, and anything this build does not name yet.
      return [];
    },
    finish(exit) {
      if (state.hasTerminal()) return [];
      return state.terminal({
        type: 'error',
        sequence: state.next(),
        error: { code: 'cli_exit', message: exitDescription('codex', exit) },
      });
    },
  };
}

/*
 * `gemini`'s translator is DELIBERATELY NOT in this file yet.
 *
 * #115 names `gemini -p ... --output-format stream-json` and this pass
 * verified those flags exist against a real `gemini --help` (0.46.0). What it
 * could not do is capture a real fixture: this machine's `gemini` is
 * configured (`~/.gemini/settings.json`, `security.auth.selectedType:
 * "gemini-api-key"`) to require `GEMINI_API_KEY`, which is not present in
 * this session's environment, and reading it from the user's own credential
 * store to work around that is exactly the action this app's own safety
 * rules — and the sandbox's own credential-exploration guard — refuse. No
 * fixture, real or invented, is committed for a wire format this pass never
 * observed: encoding a guess here would ship a translator this app has never
 * actually seen a `gemini` process produce.
 */
