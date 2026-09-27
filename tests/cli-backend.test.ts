import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';
import type { IRChatRequest, IRMessage, IRStreamChunk } from '@johnhenry/aimatey-types';

import { CliBackendAdapter, isSupportedCliId, type CliBridgeExit, type CliBridgeHandle, type CliTurnBridge } from '@/ai/backends/cli';
import type { CliTurnInput } from '@/ai/backends/cli-encode';

/**
 * CliBackendAdapter (#42, #115, #119), driven by a FAKE `CliTurnBridge` that
 * never spawns anything — `tests/desktop-cli-turns.test.ts` already covers
 * the real spawn plugin against a fake CLI SCRIPT; this file covers the
 * renderer-side adapter's own contract: structured input in, an `IRChatStream`
 * out, cancellation wired to the bridge's `cancel()`.
 */

function fixture(name: string): string {
  return readFileSync(resolve(process.cwd(), `tests/fixtures/cli/${name}`), 'utf8');
}

/** A bridge whose `start()` replays one fixture's bytes, split into arbitrary chunks, then exits. */
function fakeBridge(fixtureName: string, chunkSize: number, exit: CliBridgeExit = { code: 0, signal: null }) {
  const startCalls: ({ cliId: string } & CliTurnInput)[] = [];
  let cancelled = false;

  const bridge: CliTurnBridge = {
    start(options) {
      startCalls.push(options);
      const bytes = new TextEncoder().encode(fixture(fixtureName));
      let dataListener: ((chunk: Uint8Array, stream: 'stdout' | 'stderr') => void) | undefined;
      let exitListener: ((exit: CliBridgeExit) => void) | undefined;

      const handle: CliBridgeHandle = {
        onData(listener) {
          dataListener = listener;
        },
        onExit(listener) {
          exitListener = listener;
        },
        cancel() {
          cancelled = true;
        },
      };

      // Deliver asynchronously, in chunks, so the adapter's queue/wake logic
      // is exercised the way it would be against a real process's stdout.
      queueMicrotask(async () => {
        for (let offset = 0; offset < bytes.length; offset += chunkSize) {
          dataListener?.(bytes.subarray(offset, offset + chunkSize), 'stdout');
          await Promise.resolve();
        }
        exitListener?.(exit);
      });

      return handle;
    },
  };

  return { bridge, startCalls, isCancelled: () => cancelled };
}

function request(messages: readonly IRMessage[]): IRChatRequest {
  return { messages, metadata: { requestId: 'req_test', timestamp: 0 } };
}

describe('isSupportedCliId', () => {
  it('accepts claude and codex, and nothing else yet (#115)', () => {
    expect(isSupportedCliId('claude')).toBe(true);
    expect(isSupportedCliId('codex')).toBe(true);
    expect(isSupportedCliId('gemini')).toBe(false);
  });
});

describe('CliBackendAdapter.fromIR (#119)', () => {
  it('delegates to encodeCliTurnInput -- structured turns, never a concatenated string', () => {
    const { bridge } = fakeBridge('claude-pong.jsonl', 64);
    const adapter = new CliBackendAdapter('claude', bridge);
    const messages: readonly IRMessage[] = [
      { role: 'system', content: 'be terse' },
      { role: 'user', content: 'Reply with the single word: pong' },
    ];
    expect(adapter.fromIR(request(messages))).toEqual({
      stdin: '{"type":"user","message":{"role":"user","content":"Reply with the single word: pong"}}\n',
      systemPrompt: 'be terse',
    });
  });

  it('carries a persona/system prompt starting with "--" as a plain string field, not as argv', () => {
    // This app's own persona text, authored ahead of time -- not model or
    // tool output. `encodeCliTurnInput` puts it in `systemPrompt`, a single
    // opaque string; `CliTurnBridge.start`'s type has no `args`/argv field
    // at all for it to hide inside. Whether the flag it eventually becomes
    // (`--append-system-prompt`, on the far side) stays safe with a value
    // that starts with `--` is `tests/desktop-cli-turn-argv.test.ts`'s claim,
    // not this file's -- this test only pins that the value reaches here
    // completely unmodified, as data, never re-parsed as a flag along the way.
    const { bridge } = fakeBridge('claude-pong.jsonl', 64);
    const adapter = new CliBackendAdapter('claude', bridge);
    const persona = '--dangerously-skip-permissions';
    const result = adapter.fromIR(request([{ role: 'system', content: persona }, { role: 'user', content: 'hi' }]));
    expect(result.systemPrompt).toBe(persona);
  });
});

describe('CliBackendAdapter.executeStream, over a fake bridge replaying a real fixture', () => {
  it('streams the claude fixture through to IRStreamChunk, chunked at an arbitrary byte boundary', async () => {
    const { bridge, startCalls } = fakeBridge('claude-pong.jsonl', 17); // 17: deliberately not aligned to any line
    const adapter = new CliBackendAdapter('claude', bridge);
    const messages: readonly IRMessage[] = [{ role: 'user', content: 'Reply with the single word: pong' }];

    const chunks: IRStreamChunk[] = [];
    for await (const chunk of adapter.executeStream(request(messages))) chunks.push(chunk);

    expect(startCalls).toEqual([
      {
        cliId: 'claude',
        stdin: '{"type":"user","message":{"role":"user","content":"Reply with the single word: pong"}}\n',
        systemPrompt: undefined,
      },
    ]);
    expect(chunks.filter((c) => c.type === 'start')).toHaveLength(1);
    expect(chunks.filter((c) => c.type === 'content').map((c) => (c as { delta: string }).delta)).toEqual([
      'p',
      'ong',
    ]);
    const terminal = chunks.filter((c) => c.type === 'done' || c.type === 'error');
    expect(terminal).toHaveLength(1);
    expect(terminal[0]).toMatchObject({ type: 'done' });
    // The adapter assigns none of these itself -- they come straight from
    // the translator, and are still monotonic end to end.
    expect(chunks.map((c) => c.sequence)).toEqual(chunks.map((_, i) => i));
  });

  it('streams the codex fixture the same way', async () => {
    const { bridge } = fakeBridge('codex-pong.jsonl', 23);
    const adapter = new CliBackendAdapter('codex', bridge);
    const messages: readonly IRMessage[] = [{ role: 'user', content: 'Reply with the single word: pong' }];

    const chunks: IRStreamChunk[] = [];
    for await (const chunk of adapter.executeStream(request(messages))) chunks.push(chunk);

    expect(chunks.filter((c) => c.type === 'content').map((c) => (c as { delta: string }).delta)).toEqual([
      'pong',
    ]);
    expect(chunks.filter((c) => c.type === 'done' || c.type === 'error')).toHaveLength(1);
  });

  it('execute() collects the stream into one IRChatResponse', async () => {
    const { bridge } = fakeBridge('codex-pong.jsonl', 100);
    const adapter = new CliBackendAdapter('codex', bridge);
    const response = await adapter.execute(request([{ role: 'user', content: 'ping' }]));
    expect(response.message).toEqual({ role: 'assistant', content: 'pong' });
    expect(response.finishReason).toBe('stop');
  });

  it('cancels the bridge when the caller aborts, and still ends the stream (via the exit it forces)', async () => {
    const { bridge, isCancelled } = fakeBridge('claude-pong.jsonl', 4, { code: null, signal: 'SIGTERM' });
    const adapter = new CliBackendAdapter('claude', bridge);
    const controller = new AbortController();

    const chunks: IRStreamChunk[] = [];
    const stream = adapter.executeStream(request([{ role: 'user', content: 'ping' }]), controller.signal);
    // The generator body -- and so the abort-listener registration -- does
    // not run until the first pull, so abort after that rather than before it.
    const first = await stream.next();
    if (!first.done) chunks.push(first.value);
    controller.abort();
    for await (const chunk of stream) chunks.push(chunk);

    expect(isCancelled()).toBe(true);
    // The fixture still finishes replaying in this fake (a real cancel would
    // stop the process before all of it arrived); what this asserts is that
    // an abort reaches the bridge's cancel(), which is this adapter's job.
  });
});

describe('CliBackendAdapter ends a turn on a line-splitter overflow (#120)', () => {
  it('emits exactly one error terminal chunk and cancels the bridge, without waiting for onExit', async () => {
    let cancelled = false;
    let exitListener: ((exit: CliBridgeExit) => void) | undefined;

    const bridge: CliTurnBridge = {
      start() {
        return {
          onData(listener) {
            // One huge line with no newline at all -- well past
            // CLI_LINE_SPLITTER_MAX_BUFFERED_BYTES (8 MiB) -- delivered as
            // one chunk, which is enough to trip the cap on its own.
            queueMicrotask(() => listener(new Uint8Array(9 * 1024 * 1024).fill(65), 'stdout'));
          },
          onExit(listener) {
            exitListener = listener;
            // Deliberately never actually called from this test: the
            // overflow must end the turn WITHOUT waiting for it.
          },
          cancel() {
            cancelled = true;
          },
        };
      },
    };

    const adapter = new CliBackendAdapter('claude', bridge);
    const chunks: IRStreamChunk[] = [];
    for await (const chunk of adapter.executeStream(request([{ role: 'user', content: 'ping' }]))) {
      chunks.push(chunk);
    }

    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({ type: 'error', error: { code: 'cli_line_overflow' } });
    expect(cancelled).toBe(true);
    // Confirms the "without waiting for onExit" half of this test's claim --
    // the stream already ended above despite this never firing.
    expect(exitListener).toBeDefined();
  });
});

describe('a CLI backend has no tool support yet, and reaches for none (#42)', () => {
  it('declares metadata.capabilities.tools false', () => {
    const { bridge } = fakeBridge('claude-pong.jsonl', 64);
    const adapter = new CliBackendAdapter('claude', bridge);
    expect(adapter.metadata.capabilities.tools).toBe(false);
  });

  it('never carries a tool definition into bridge.start, even when the IR request carries one', async () => {
    const { bridge, startCalls } = fakeBridge('claude-pong.jsonl', 64);
    const adapter = new CliBackendAdapter('claude', bridge);

    // The shape the engine's own `#toIR` (`src/ai/engine.ts`) would attach
    // when a chat has tools enabled -- built here directly, so this test
    // does not depend on the engine actually refusing to attach one, only
    // on what happens if it did (defence in depth: `fromIR` below reads only
    // `request.messages`, so this can never leak regardless).
    const withTools: IRChatRequest = {
      messages: [{ role: 'user', content: 'Reply with the single word: pong' }],
      tools: [
        { name: 'calculate', description: 'Evaluate an arithmetic expression.', parameters: {} },
      ],
      toolChoice: 'auto',
      metadata: { requestId: 'req_test', timestamp: 0 },
    } as IRChatRequest;

    for await (const _chunk of adapter.executeStream(withTools)) {
      // Draining is the point -- what is asserted is what `bridge.start` saw.
    }

    expect(startCalls).toHaveLength(1);
    const sent = startCalls[0]!;
    expect(Object.keys(sent).sort()).toEqual(['cliId', 'stdin', 'systemPrompt'].filter((key) => key in sent).sort());
    expect(sent).not.toHaveProperty('tools');
    expect(sent).not.toHaveProperty('toolChoice');
    // Nothing about the tool the request carried appears anywhere in what
    // was actually handed to the bridge.
    expect(JSON.stringify(sent)).not.toContain('calculate');
  });
});
