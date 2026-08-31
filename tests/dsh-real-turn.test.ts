// @vitest-environment node
/**
 * THE TURN NOBODY HAD EVER RUN.
 *
 * Everything else that exercises `AimateyAdapter` feeds it a fixture. The seam
 * suite uses a real `Router` and a real `FunctionBackendAdapter`, which is a
 * genuine improvement, but the tokens are still written by the test. So until
 * this file existed, no byte had ever travelled the whole path:
 *
 *   ctx.llm.stream()            — DSH's LlmRuntime, with the invariant
 *     -> AimateyAdapter.stream  — this repo's adapter
 *     -> Router.executeStream   — aimatey's real Router
 *     -> DesktopLlamaBackend    — the inference host's own aimatey backend
 *     -> LlamaCppNode.generate  — @chatterang/inference-node
 *     -> node-llama-cpp         — the native addon, a GGUF, and a GPU
 *
 * OPT-IN, AND LOUD ABOUT IT. A 6.5 GB GGUF is not on the machine running
 * `npm test`, so the suite below runs only when `CHATTERANG_TEST_MODEL` names
 * one. Skipping is the default and is visible in vitest's own output as
 * "skipped"; what is NOT allowed is the third state this project keeps getting
 * bitten by — a test that reports green without having observed anything. Two
 * things guard that:
 *
 *   - the gate is a pure function, tested unconditionally below, so "unset
 *     means skip" is itself asserted rather than assumed;
 *   - a variable that IS set but names a file that is not there FAILS. A typo
 *     in a path must not read as "no model on this machine".
 *
 * WHAT ONLY A REAL RUN CAN SHOW. The grammar assertions here are deliberately
 * re-implemented rather than delegated to `@deepseek-ai/dsh-llm/invariant`,
 * even though that companion is mounted by the profile and validates the same
 * stream. Two oracles, one of them ours: if the invariant plugin ever silently
 * stops being installed, `auditStream` still fails, and if `auditStream` is
 * wrong the invariant still throws. Neither is a substitute for the other.
 */

import { statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { MessageId } from '@deepseek-ai/dsh-llm';
import type { GenerateOptions, Message, StreamChunk } from '@deepseek-ai/dsh-llm';
import { Router } from '@johnhenry/aimatey-core';

import { ROUTER_SENTINEL } from '@chatterang/cordis-aimatey';
import { LlamaCppNode } from '@chatterang/inference-node';
import { mountDsh } from '@chatterang/desktop/host/dsh';
import type { DshMount } from '@chatterang/desktop/host/dsh';
import { DesktopLlamaBackend } from '@chatterang/desktop/host/llama-backend';

/* ── The gate ─────────────────────────────────────────────────────────── */

/** The environment variable that opts this suite in. */
export const MODEL_ENV = 'CHATTERANG_TEST_MODEL';

/** The aimatey backend name the inference host registers. Same string as `entry.ts`. */
const BACKEND = 'llama-cpp-desktop';

/**
 * The GGUF this run should use, or `undefined` to skip.
 *
 * @param env - the process environment to read.
 * @returns the absolute model path, or `undefined` when the suite must skip.
 * @throws Error when the variable is set but names nothing readable — a typo
 *   must not be indistinguishable from "this machine has no model".
 */
export function resolveTestModel(env: NodeJS.ProcessEnv): string | undefined {
  const raw = env[MODEL_ENV];
  if (raw === undefined) return undefined;
  const path = raw.trim();
  if (path.length === 0) return undefined;
  let size: number;
  try {
    const stat = statSync(path);
    if (!stat.isFile()) throw new Error('not a regular file');
    size = stat.size;
  } catch (cause) {
    throw new Error(
      `${MODEL_ENV} is set to ${JSON.stringify(path)} but that is not a readable file. ` +
        'Unset it to skip this suite; a wrong path must not read as "no model here".',
      { cause },
    );
  }
  if (size === 0) throw new Error(`${MODEL_ENV} names an empty file: ${path}`);
  return path;
}

/* ── Our own copy of the DSH stream grammar ───────────────────────────── */

/** What one drained stream turned out to be. */
interface StreamAudit {
  readonly chunks: readonly StreamChunk[];
  /** Every text-delta concatenated, in arrival order. */
  readonly text: string;
  /** The text each `block-end` reported for its block, concatenated. */
  readonly closedText: string;
  readonly textDeltas: number;
  readonly finishes: number;
  readonly finishKind: string | undefined;
  readonly usageCount: number;
  readonly usage: { inputTokens?: number; outputTokens?: number } | undefined;
  /** Index of the `usage` chunk and of the `finish` chunk, in arrival order. */
  readonly usageAt: number;
  readonly finishAt: number;
  /** Grammar breaches, in the words a reader needs. Empty means legal. */
  readonly violations: readonly string[];
  /** Milliseconds from the call to the first text-delta, and to the finish. */
  readonly ttftMs: number;
  readonly totalMs: number;
}

/**
 * Drain one DSH stream and check its grammar independently of the invariant.
 *
 * @param stream - the stream `ctx.llm.stream()` returned.
 * @param onDelta - called after each text-delta; the abort test uses it.
 * @returns everything observed, including the breaches found.
 */
async function auditStream(
  stream: AsyncIterable<StreamChunk>,
  onDelta?: (index: number) => void,
): Promise<StreamAudit> {
  const started = Date.now();
  const chunks: StreamChunk[] = [];
  const violations: string[] = [];
  const open = new Map<number, string>();
  const closed = new Set<number>();
  let text = '';
  let closedText = '';
  let textDeltas = 0;
  let finishes = 0;
  let finishKind: string | undefined;
  let usageCount = 0;
  let usage: { inputTokens?: number; outputTokens?: number } | undefined;
  let usageAt = -1;
  let finishAt = -1;
  let ttftMs = -1;

  for await (const chunk of stream) {
    const at = chunks.length;
    chunks.push(chunk);
    if (finishes > 0) violations.push(`chunk "${chunk.type}" arrived after the terminal finish`);
    switch (chunk.type) {
      case 'block-start':
        if (open.has(chunk.index) || closed.has(chunk.index)) {
          violations.push(`block-start reused index ${chunk.index}`);
        }
        open.set(chunk.index, chunk.blockType);
        break;
      case 'text-delta':
        if (open.get(chunk.index) !== 'text') {
          violations.push(`text-delta at index ${chunk.index} has no open text block`);
        }
        if (ttftMs < 0) ttftMs = Date.now() - started;
        text += chunk.text;
        textDeltas += 1;
        onDelta?.(textDeltas);
        break;
      case 'tool-call-delta':
        if (open.get(chunk.index) !== 'tool-call') {
          violations.push(`tool-call-delta at index ${chunk.index} has no open tool-call block`);
        }
        break;
      case 'block-end': {
        const blockType = open.get(chunk.index);
        if (blockType === undefined) violations.push(`block-end at index ${chunk.index} closes nothing`);
        if (blockType !== undefined && chunk.block.type !== blockType) {
          violations.push(`block-end at ${chunk.index} closes ${chunk.block.type}, expected ${blockType}`);
        }
        if (chunk.block.type === 'text') closedText += chunk.block.text;
        open.delete(chunk.index);
        closed.add(chunk.index);
        break;
      }
      case 'usage':
        usageCount += 1;
        usageAt = at;
        usage = chunk.usage;
        break;
      case 'finish':
        finishes += 1;
        finishAt = at;
        finishKind = chunk.reason.kind;
        break;
      default:
        break;
    }
  }

  if (finishes !== 1) violations.push(`expected exactly one terminal finish, saw ${finishes}`);
  if (finishes === 1 && chunks.at(-1)?.type !== 'finish') {
    violations.push('the finish chunk was not last');
  }
  if (usageCount > 1) violations.push(`usage appeared ${usageCount} times`);
  if (usageCount === 1 && finishAt >= 0 && usageAt > finishAt) {
    violations.push('usage arrived after the finish');
  }
  if (text !== closedText) {
    violations.push(
      `assembled deltas disagree with the closed blocks: ${JSON.stringify(text)} vs ${JSON.stringify(closedText)}`,
    );
  }

  return {
    chunks,
    text,
    closedText,
    textDeltas,
    finishes,
    finishKind,
    usageCount,
    usage,
    usageAt,
    finishAt,
    violations,
    ttftMs: ttftMs < 0 ? -1 : ttftMs,
    totalMs: Date.now() - started,
  };
}

/** The chunk sequence as a reader can check it against the report. */
function shape(audit: StreamAudit): string {
  const runs: { label: string; count: number }[] = [];
  for (const chunk of audit.chunks) {
    const last = runs.at(-1);
    if (last !== undefined && last.label === chunk.type) last.count += 1;
    else runs.push({ label: chunk.type, count: 1 });
  }
  return runs.map((run) => (run.count === 1 ? run.label : `${run.label} x${run.count}`)).join(' -> ');
}

/**
 * How many completion tokens a turn here is allowed.
 *
 * Small on purpose. This suite is about the PATH, not about what the model has
 * to say, and an unbounded turn on a 12B model costs about eighty seconds —
 * which is how the budget came to be honoured at all: the first real run
 * finished `max-tokens` at 1024 on a request that had asked for far fewer,
 * because `DesktopLlamaBackend` was dropping the sampler.
 */
const BUDGET = 48;

/** The terminal kinds a bounded, uncancelled turn may legally end on. */
const TERMINALS = ['stop', 'max-tokens'] as const;

/** Print what a run actually observed, so a report can quote it. */
function report(label: string, audit: StreamAudit): void {
  console.log(
    `[real turn / ${label}] shape: ${shape(audit)}\n` +
      `[real turn / ${label}] deltas=${audit.textDeltas} ttft=${audit.ttftMs}ms total=${audit.totalMs}ms ` +
      `usage=${JSON.stringify(audit.usage)} finish=${String(audit.finishKind)}\n` +
      `[real turn / ${label}] text: ${JSON.stringify(audit.text)}`,
  );
}

const userMessage = (text: string): Message => ({
  id: MessageId('u1'),
  role: 'user',
  content: [{ type: 'text', text }],
  source: { kind: 'user' },
});

/* ── The gate, tested unconditionally ─────────────────────────────────── */

describe('the opt-in gate', () => {
  it('skips when the variable is unset or blank', () => {
    expect(resolveTestModel({})).toBeUndefined();
    expect(resolveTestModel({ [MODEL_ENV]: '' })).toBeUndefined();
    expect(resolveTestModel({ [MODEL_ENV]: '   ' })).toBeUndefined();
  });

  it('FAILS when the variable names a file that is not there', () => {
    // The state this project keeps producing by accident: a harness that
    // reports success because its observation channel was dead. A typo'd path
    // must not read as "this machine has no model".
    expect(() => resolveTestModel({ [MODEL_ENV]: '/nope/not-a-model.gguf' })).toThrow(
      /not a readable file/,
    );
    expect(() => resolveTestModel({ [MODEL_ENV]: '/tmp' })).toThrow(/not a readable file/);
  });

  it('returns the path when it names a real file', () => {
    const self = fileURLToPath(import.meta.url);
    expect(resolveTestModel({ [MODEL_ENV]: self })).toBe(self);
  });
});

/* ── The real turn ────────────────────────────────────────────────────── */

const MODEL = resolveTestModel(process.env);

describe.runIf(MODEL !== undefined)(
  `a real turn: ctx.llm.stream -> AimateyAdapter -> Router -> LlamaCppNode -> ${String(MODEL)}`,
  () => {
    const modelPath = MODEL as string;
    let plugin: LlamaCppNode;
    let mount: DshMount;
    const warnings: string[] = [];
    /** Raw engine events, counted beside the DSH stream they should explain. */
    const engineTokens = new Map<string, number>();
    let engineEnds = 0;

    beforeAll(async () => {
      plugin = new LlamaCppNode();
      await plugin.addListener('llamaToken', (event) => {
        engineTokens.set(event.requestId, (engineTokens.get(event.requestId) ?? 0) + 1);
      });
      await plugin.addListener('llamaEnd', () => {
        engineEnds += 1;
      });

      // Exactly the Router `apps/desktop/src/host/entry.ts` builds: one local
      // backend, no remote provider, so no API key exists on this side to leak.
      const router = new Router({ routingStrategy: 'explicit', fallbackStrategy: 'none' });
      router.register(BACKEND, new DesktopLlamaBackend({ plugin }));

      // The production boot path, not a hand-rolled tree: `mountDsh` applies
      // PROFILE_ROWS and runs `assertBoot`.
      mount = await mountDsh({ router, warn: (message) => warnings.push(message) });
    }, 600_000);

    afterAll(async () => {
      await plugin?.dispose();
    }, 120_000);

    it('booted the shipped profile against the real engine', async () => {
      expect(mount.status.mounted).toBe(true);
      expect(mount.status.error).toBeUndefined();
      expect(mount.listProviders()).toEqual([ROUTER_SENTINEL, BACKEND]);
      // Nothing here is synthesised: the web shim reports `simulated: true`,
      // and that flag is the difference between this suite and every other one.
      const capabilities = await plugin.getCapabilities();
      expect(capabilities.simulated).toBe(false);
    }, 120_000);

    it('streams a real completion on the pinned route, in a legal order', async () => {
      const options: GenerateOptions = {
        provider: BACKEND,
        model: modelPath,
        messages: [userMessage('Reply with exactly one short sentence: what colour is a ripe banana?')],
        maxTokens: BUDGET,
      };
      const before = engineEnds;
      const audit = await auditStream(mount.ctx.llm.stream(options));

      report('pinned', audit);

      expect(audit.violations).toEqual([]);
      expect(audit.finishes).toBe(1);
      // NOT asserted: *which* legal terminal. `stop` and `max-tokens` are both
      // correct outcomes for a bounded turn, and which one a real model reaches
      // is the model's business. Pinning it made this suite fail on a run whose
      // stream was perfectly legal — that is a flaky assertion, not a finding.
      expect(TERMINALS).toContain(audit.finishKind);
      // Real tokens, not a single synthesized blob: a streaming engine emits
      // many deltas, and the assembled text is what a reader would have seen.
      expect(audit.textDeltas).toBeGreaterThan(1);
      expect(audit.text.length).toBeGreaterThan(0);
      expect(audit.text).toBe(audit.closedText);
      // Usage exactly once, and BEFORE the finish — DSH forbids anything after
      // it, and aimatey hangs usage off its terminal `done` chunk, so this
      // ordering is synthesized by `chunks.ts` and is not free.
      expect(audit.usageCount).toBe(1);
      expect(audit.usageAt).toBeLessThan(audit.finishAt);
      expect(audit.usage?.inputTokens ?? 0).toBeGreaterThan(0);
      expect(audit.usage?.outputTokens ?? 0).toBeGreaterThan(0);
      // The budget reached the engine. Before `DesktopLlamaBackend#sampler`
      // existed this was 1024 on every turn, whatever the caller asked for.
      expect(audit.usage?.outputTokens ?? 0).toBeLessThanOrEqual(BUDGET);
      // The engine's own terminal event fired exactly once for this turn.
      expect(engineEnds).toBe(before + 1);
      // Every DSH text-delta is one llama.cpp token event: the deltas came
      // from the addon, not from anything in this repo.
      const tokens = [...engineTokens.values()].reduce((sum, n) => sum + n, 0);
      expect(tokens).toBeGreaterThanOrEqual(audit.textDeltas);
    }, 600_000);

    it('streams the same way on the router-choose route, which is a separate branch', async () => {
      // `AimateyAdapter.stream` has two bodies. The pinned one clones and prunes
      // the Router; the sentinel one streams through it untouched. A suite that
      // only ever runs one leaves the other unproven against a real engine.
      const before = engineEnds;
      const audit = await auditStream(
        mount.ctx.llm.stream({
          provider: ROUTER_SENTINEL,
          model: modelPath,
          messages: [userMessage('Reply with exactly one short sentence: what colour is the sky at noon?')],
          maxTokens: BUDGET,
        }),
      );

      report('sentinel', audit);

      expect(audit.violations).toEqual([]);
      expect(TERMINALS).toContain(audit.finishKind);
      expect(audit.textDeltas).toBeGreaterThan(1);
      expect(audit.usageCount).toBe(1);
      expect(audit.usage?.outputTokens ?? 0).toBeLessThanOrEqual(BUDGET);
      expect(engineEnds).toBe(before + 1);
    }, 600_000);

    it('ends a real turn that is aborted mid-stream in exactly one terminal finish', async () => {
      // The terminal-event rule under the condition that has no chunk at all to
      // carry it: aimatey's Router breaks out of its loop on abort and returns
      // with no `done` and no `error`, so the finish below is synthesized from
      // the signal alone.
      const controller = new AbortController();
      const before = engineEnds;
      const audit = await auditStream(
        mount.ctx.llm.stream({
          provider: BACKEND,
          model: modelPath,
          messages: [userMessage('Count slowly from one to two hundred, one number per line.')],
          maxTokens: BUDGET,
          signal: controller.signal,
        }),
        (delta) => {
          if (delta === 3) controller.abort();
        },
      );

      report('abort', audit);

      expect(audit.violations).toEqual([]);
      expect(audit.finishes).toBe(1);
      expect(audit.finishKind).toBe('aborted');
      // It really was cut short: the turn is budgeted at BUDGET tokens and the
      // abort landed on the third delta.
      expect(audit.textDeltas).toBeLessThan(BUDGET);
      // And the engine settled its own turn exactly once, as `generate` must.
      expect(engineEnds).toBe(before + 1);
    }, 600_000);
  },
);
