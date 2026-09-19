/**
 * A VARIANT MUST CARRY WHERE IT CAME FROM.
 *
 * The measurement this file exists for, taken through the real store and the
 * real `MessageView` — pick a local model, press Regenerate, press `‹`:
 *
 *     turn 1 = REMOTE ANSWER   | provenance.local = false
 *     after regenerate         = LOCAL ANSWER | variants = ["REMOTE ANSWER"]
 *     DOM  = Qwen3 1.7B · On device · REMOTE ANSWER · 1/2
 *
 * The reply that came back from a provider is rendered under the ember flame,
 * this app's own mark for a turn that ran on the device. `MessageView` reads
 * the chip off the ROW's `provenance`; `cycleVariant` swaps `content` and
 * leaves `provenance` where it was; `regenerate` carries forward TEXT ONLY.
 * So the two come from different turns, and three surfaces state as a
 * universal claim that they do not.
 *
 * The second half of the file is the same defect one field over. Taint is
 * derived from `Message.toolCalls`, and `regenerate` moves tool-derived TEXT
 * onto a row whose `toolCalls` belong to the new turn — so after
 * `cycleVariant` the history is unmarked and the bytes reach a remote adapter
 * with no sheet.
 *
 * Everything here drives the shipped methods and reads the real DOM. A source
 * check would pass against a component rendering a different branch.
 */

import { createElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { stage } from './support/stage';

import type { InstalledModel } from '@/db';
import type { Message, Provenance, ToolInvocation } from '@/domain/chat';
import type { McpCallReceipt } from '@/domain/mcp';
import type { ToolEgressPolicy } from '@/ai/engine';
import type { DestinationRequest, ToolDestinationPolicy } from '@/ai/middleware/tools';
import type { ApprovalPrompt } from '@/state/app';

/* ── The database, stubbed at the table boundary ────────────────────── */

const tables = vi.hoisted(() => ({
  models: { put: vi.fn(async () => {}), delete: vi.fn(async () => {}), toArray: async () => [] },
  settings: { get: vi.fn(async () => undefined), put: vi.fn(async () => {}) },
  chats: { put: vi.fn(async () => {}), delete: vi.fn(async () => {}), toArray: async () => [] },
  messages: {
    put: vi.fn(async () => {}),
    delete: vi.fn(async () => {}),
    where: () => ({ equals: () => ({ sortBy: async () => [], toArray: async () => [] }) }),
  },
  connections: { put: vi.fn(async () => {}), delete: vi.fn(async () => {}), toArray: async () => [] },
}));

vi.mock('@/db', () => ({
  db: tables,
  deleteChat: vi.fn(async () => {}),
  readSetting: async (_key: string, fallback: unknown) => fallback,
  writeSetting: vi.fn(async () => {}),
}));

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');

const { useChats, buildMessages, mcpSendSheet } = await import('@/state/chat');
const { useModels } = await import('@/state/models');
const { useApp, revokeMcpGrantsFor } = await import('@/state/app');
const { catalogEntry } = await import('@/data/catalog');
const { DEFAULT_SAMPLER } = await import('@/domain/manifest');
const { MessageView } = await import('@/features/chat/MessageView');
const { renderTranscript } = await import('@/shell/commands');
const { isTainted } = await import('@/ai/taint');
const { upgradeVariants } = await import('@/db/variants');
const { ranOnDevice, reachKind, REACH_DEVICE, REACH_REMOTE } = await import('@/domain/chat');

/** A model that can really hold a conversation. */
const QWEN = catalogEntry('qwen3-4b-instruct-q4km')!;

function installedRecord(manifest: typeof QWEN): InstalledModel {
  return {
    id: manifest.id,
    manifest,
    state: 'installed',
    downloadedBytes: manifest.sizeBytes,
    paths: { model: `/dev/${manifest.id}` },
    sampler: { ...DEFAULT_SAMPLER },
    systemPrompt: '',
    installedAt: 1,
    lastUsedAt: null,
    useCount: 0,
  };
}

/* ── The two turns, scripted ─────────────────────────────────────────── */

const REMOTE: Provenance = {
  backendId: 'conn_openai',
  engine: 'remote',
  modelId: 'gpt-4o-mini',
  modelName: 'OpenAI · gpt-4o-mini',
  reach: REACH_REMOTE,
};

const ON_DEVICE: Provenance = {
  backendId: 'llama-cpp',
  engine: 'llama-cpp',
  modelId: QWEN.id,
  modelName: 'Qwen3 4B Instruct',
  reach: REACH_DEVICE,
};

/**
 * The snapshot the real engine would emit for a stored record.
 *
 * The engine reports BOTH a boolean (`ProvenanceSnapshot.local`, pinned by
 * `tests/engine.test.ts`) and the real `reach` itself (#42, #112 — added
 * because `local` alone cannot tell `REACH_DEVICE` apart from
 * `REACH_LOCAL_VIA_THIRD_PARTY`; both run "here"). The fixtures below are
 * written as the record the app STORES, so this converts one back into the
 * shape the engine hands over — recomputing `local` rather than trusting the
 * fixture's, so a store that simply copied `event.provenance` still has
 * something of its own to derive.
 */
function snapshotOf(provenance: Provenance): Record<string, unknown> {
  return { ...provenance, local: ranOnDevice(provenance) };
}

interface Turn {
  readonly text: string;
  readonly provenance: Provenance;
  readonly tool?: ToolInvocation;
  /**
   * Stream the text as deltas and then FAIL, instead of finishing (#260).
   *
   * What a socket cut mid-reply looks like to the store. The engine now turns
   * a stream with no terminal chunk into an error event, so this is the shape
   * the store has to handle without throwing away what the user already read.
   */
  readonly failWith?: string;
  /**
   * Raise the tool-output sheet first, with no tools, as the real engine does
   * on a turn whose HISTORY carries tool-derived text.
   */
  readonly asksEgress?: boolean;
  /** Hold the turn open BEFORE its tool event until this settles. */
  readonly beforeTool?: Promise<void>;
  /** Called once the store has finished handling the tool event. */
  readonly onToolHandled?: () => void;
  /** Hold the turn open after its tool event until this settles. */
  readonly hang?: Promise<void>;
  /** Throw after the tool event instead of finishing — the store's `catch`. */
  readonly throwWith?: string;
  /** Ask the MCP policy the store handed over, as the dispatcher does before a call. */
  readonly asksMcp?: DestinationRequest;
  /** Run once `asksMcp` is answered, still inside the turn, with the policy it was asked through. */
  readonly thenMcp?: (policy: ToolDestinationPolicy) => Promise<void>;
}

/** Turns the fake engine hands back, in order. */
let script: Turn[] = [];

/** What each `asksMcp` turn got back, and whether the policy then held a grant. */
let mcpAnswers: { decision?: string; granted?: boolean }[] = [];

/**
 * The engine, replaced by a recorder.
 *
 * What is under test is what the STORE does with a finished turn, so the
 * generation itself is scripted: the real engine would try to open a GGUF that
 * is not there, and could not be made to answer remotely and then locally.
 */
function scriptedEngine(): unknown {
  return {
    async *stream(request: {
      readonly egress?: ToolEgressPolicy;
      readonly mcpEgress?: ToolDestinationPolicy;
      readonly signal?: AbortSignal;
    }) {
      const turn = script.shift();
      if (!turn) throw new Error('the script ran out of turns');
      if (turn.asksMcp) {
        // What `runToolCalls` does with the policy: ask, with the turn's
        // signal, and hand a conversation answer back to be kept.
        const policy = request.mcpEgress;
        const decision = await policy?.request?.(turn.asksMcp, request.signal);
        if (decision === 'conversation') policy?.onGranted?.(turn.asksMcp.destination);
        mcpAnswers.push({ decision, granted: policy?.isGranted(turn.asksMcp.destination) });
        if (policy && turn.thenMcp) await turn.thenMcp(policy);
      }
      if (turn.asksEgress) {
        await request.egress?.request?.({
          backendId: 'conn_openai',
          modelName: 'gpt-4o-mini',
          tools: [],
          characters: 42,
        });
      }
      if (turn.beforeTool) await turn.beforeTool;
      if (turn.tool) {
        yield { type: 'tool', tool: turn.tool };
        // A generator resumes only when its consumer asks for the next event,
        // which the store does once its `tool` case has run to the end.
        turn.onToolHandled?.();
      }
      if (turn.hang) await turn.hang;
      if (turn.throwWith !== undefined) throw new Error(turn.throwWith);
      if (turn.failWith !== undefined) {
        // Deltas first, exactly as a real turn does, THEN the failure — so the
        // row has streamed content at the moment the error arrives.
        yield { type: 'delta', text: turn.text };
        yield { type: 'error', message: turn.failWith };
        return;
      }
      yield {
        type: 'done',
        text: turn.text,
        provenance: snapshotOf(turn.provenance),
        stats: { promptTokens: 8, completionTokens: 4 },
      };
    },
  };
}

const CHAT = {
  id: 'c1',
  title: 'New chat',
  mode: 'chat' as const,
  personaId: null,
  modelId: QWEN.id,
  sampler: null,
  tools: [],
  showThinking: false,
  createdAt: 1,
  updatedAt: 1,
  messageCount: 0,
  preview: '',
};

beforeEach(() => {
  vi.clearAllMocks();
  script = [];

  useModels.setState({
    loaded: true,
    activeModelId: QWEN.id,
    progress: {},
    storage: { used: 0, quota: 0 },
    installed: { [QWEN.id]: installedRecord(QWEN) },
  });

  useApp.setState({
    toasts: [],
    connections: [],
    engine: scriptedEngine() as never,
    // Markdown is lazy-loaded; the plain branch is what the assertions read.
    settings: { ...useApp.getState().settings, renderMarkdown: false },
  });

  useChats.setState({
    loaded: true,
    generating: false,
    controller: null,
    context: null,
    messages: [],
    activeChatId: 'c1',
    chats: [{ ...CHAT }],
  });
});

/** The assistant row currently in the store. */
function assistantRow(): Message {
  const row = useChats.getState().messages.find((entry) => entry.role === 'assistant');
  expect(row, 'there is an assistant turn').toBeDefined();
  return row!;
}

/* ── Rendering ───────────────────────────────────────────────────────── */

/** Mount into a throwaway host, run `body`, then tear it down. */
async function mounted(
  element: ReturnType<typeof createElement>,
  body: () => Promise<void> | void,
): Promise<void> {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => {
      root.render(element);
    });
    await body();
  } finally {
    await act(async () => {
      root.unmount();
    });
    host.remove();
  }
}

/**
 * The assistant turn, rendered from the store rather than from a snapshot —
 * so pressing `‹` re-renders what `cycleVariant` actually wrote.
 */
function LiveMessage(): ReturnType<typeof createElement> {
  const message = useChats((state) => state.messages.find((entry) => entry.role === 'assistant'))!;
  return createElement(MessageView, {
    message,
    showThinking: false,
    onRegenerate: () => {},
    onEdit: () => {},
  });
}

function byLabel(label: string): HTMLElement {
  const found = document.querySelector(`[aria-label="${label}"]`);
  expect(found, `“${label}” is on screen`).not.toBeNull();
  return found as HTMLElement;
}

/** What the head chip says: "On device" or "Remote". */
function chipText(): string {
  const chip = document.querySelector('.msg__head .chip');
  return chip?.textContent?.trim() ?? '';
}

/** The reply body as a reader sees it. */
function bodyText(): string {
  return document.querySelector('.msg__body')?.textContent?.trim() ?? '';
}

/** The "1/2" between the two arrows. */
function counterText(): string {
  return document.querySelector('.msg__foot .readout')?.textContent?.trim() ?? '';
}

/* ── The measurement ─────────────────────────────────────────────────── */

/** Answer once remotely, then regenerate on the device. */
async function remoteThenLocal(tool?: ToolInvocation): Promise<void> {
  script = [
    { text: 'REMOTE ANSWER', provenance: REMOTE, tool },
    { text: 'LOCAL ANSWER', provenance: ON_DEVICE },
  ];
  await useChats.getState().send('hello');
  await useChats.getState().regenerate(assistantRow().id);
}

describe('a variant carries where it came from', () => {
  it('the state pairs each generation with its own provenance', async () => {
    await remoteThenLocal();

    const row = assistantRow();
    expect(row.content).toBe('LOCAL ANSWER');
    expect(ranOnDevice(row.provenance)).toBe(true);

    await useChats.getState().cycleVariant(row.id, -1);

    const cycled = assistantRow();
    expect(cycled.content, 'the older generation is on display').toBe('REMOTE ANSWER');
    expect(
      ranOnDevice(cycled.provenance),
      'the reply that came back from a provider is not marked as on-device',
    ).toBe(false);
    expect(cycled.provenance?.modelName).toBe(REMOTE.modelName);
  });

  it('the thread marks the displayed reply, not the one it replaced', async () => {
    await remoteThenLocal();

    await mounted(createElement(LiveMessage), async () => {
      expect(bodyText()).toContain('LOCAL ANSWER');
      expect(chipText()).toContain('On device');
      expect(counterText(), 'both generations are counted').toBe('2/2');

      await act(async () => {
        byLabel('Previous version').click();
      });

      expect(bodyText(), 'the older generation is on screen').toContain('REMOTE ANSWER');
      expect(chipText(), 'and it is labelled as what it is').toContain('Remote');
      expect(
        document.querySelector('.msg__who')?.textContent,
        'under the name of the model that really answered',
      ).toBe(REMOTE.modelName);
      expect(counterText(), 'and neither generation was consumed').toBe('1/2');
    });
  });

  it('the transcript says where the reply on display came from', async () => {
    await remoteThenLocal();
    await useChats.getState().cycleVariant(assistantRow().id, -1);

    const transcript = renderTranscript(
      useChats.getState().chats[0]!,
      useChats.getState().messages,
    );
    expect(transcript).toContain('REMOTE ANSWER');
    expect(transcript, 'a remote reply is not written down as an on-device one').not.toMatch(
      /## .*\(on device\)\n\nREMOTE ANSWER/,
    );
    expect(transcript).toMatch(/## .*\(remote\)\n\nREMOTE ANSWER/);
  });
});

/* ── The twin: taint follows the same swap ───────────────────────────── */

const TOOL: ToolInvocation = {
  id: 'call_1',
  name: 'bash',
  input: { command: 'ls /chats' },
  output: 'chat_1 — Bank details',
};

describe('taint follows the generation, not the row', () => {
  it('a tool-derived generation stays marked after it is cycled back to', async () => {
    await remoteThenLocal(TOOL);

    const row = assistantRow();
    expect(row.content).toBe('LOCAL ANSWER');
    expect(row.toolCalls, 'the new turn ran no tool').toBeUndefined();

    await useChats.getState().cycleVariant(row.id, -1);
    expect(assistantRow().content).toBe('REMOTE ANSWER');

    const built = await buildMessages(
      useChats.getState().chats[0]!,
      useChats.getState().messages,
      0,
      QWEN.id,
    );
    const reply = built.messages.find(
      (entry) => entry.role === 'assistant' && String(entry.content).includes('REMOTE ANSWER'),
    );
    expect(reply, 'the reply is in the history').toBeDefined();
    expect(
      isTainted(reply!),
      'a reply the model wrote while a tool was running is still tool-derived after a cycle',
    ).toBe(true);
  });
});

/* ── Neither generation is lost ──────────────────────────────────────── */

/**
 * The second defect the string list forced, and the reason `variants` now
 * holds EVERY generation rather than only the ones not on display.
 *
 * The row used to stand in for its own generation, and `cycleVariant`
 * overwrote `content` in place to show an older one — so the newest text was
 * gone the moment you looked away from it. Measured on the old code:
 * `variants ["REMOTE"]`, `content "LOCAL"`, press `‹` then `›` and both the
 * row and the list said "REMOTE".
 */
describe('cycling does not consume a generation', () => {
  it('goes there and back', async () => {
    await remoteThenLocal();
    const id = assistantRow().id;

    await useChats.getState().cycleVariant(id, -1);
    expect(assistantRow().content).toBe('REMOTE ANSWER');

    await useChats.getState().cycleVariant(id, 1);
    expect(assistantRow().content, 'the newest generation is still there').toBe('LOCAL ANSWER');
    expect(ranOnDevice(assistantRow().provenance)).toBe(true);

    expect(assistantRow().variants?.map((variant) => variant.content)).toEqual([
      'REMOTE ANSWER',
      'LOCAL ANSWER',
    ]);
  });

  it('a second regenerate keeps all three, each with its own origin', async () => {
    await remoteThenLocal();
    script = [{ text: 'THIRD ANSWER', provenance: REMOTE }];
    await useChats.getState().regenerate(assistantRow().id);

    const row = assistantRow();
    expect(row.variants?.map((variant) => variant.content)).toEqual([
      'REMOTE ANSWER',
      'LOCAL ANSWER',
      'THIRD ANSWER',
    ]);
    expect(row.variants?.map((variant) => reachKind(variant.provenance))).toEqual([
      'remote',
      'device',
      'remote',
    ]);
    expect(row.variantIndex).toBe(2);
  });
});

/* ── What a chat saved by today's build becomes ─────────────────────── */

/**
 * The upgrade decides, and the decision is tested here rather than through
 * IndexedDB: `version(4).upgrade` is a loop around `upgradeVariants` and
 * nothing else, and there is no fake-indexeddb in this project to drive the
 * real one with.
 *
 * The rule under test is that the upgrade never invents an origin. An old
 * string variant records none, so it comes back `unrecorded` — no chip, no
 * model name — and the row's own fields are attached to the row's own text
 * only when that text can be shown to be the generation they describe.
 */
describe('a chat saved by today’s build', () => {
  it('recovers old variants with no origin rather than a borrowed one', () => {
    const upgraded = upgradeVariants({
      content: 'LOCAL ANSWER',
      variants: ['REMOTE ANSWER'],
      variantIndex: 1,
      provenance: ON_DEVICE,
      stats: { promptTokens: 8 },
    });

    expect(upgraded).not.toBeNull();
    expect(upgraded!.variants).toEqual([
      { content: 'REMOTE ANSWER', unrecorded: true },
      {
        content: 'LOCAL ANSWER',
        thinking: undefined,
        toolCalls: undefined,
        provenance: ON_DEVICE,
        stats: { promptTokens: 8 },
      },
    ]);
    expect(upgraded!.variantIndex).toBe(1);
    expect(upgraded!.detach).toBe(false);
    // The recovered one carries NO provenance — not the row's.
    expect(upgraded!.variants[0]!.provenance).toBeUndefined();
  });

  it('detaches the row’s provenance from text it cannot be shown to describe', () => {
    // A row the old `cycleVariant` had already been through: `content` is a
    // copy of an older variant and the newest text is gone.
    const upgraded = upgradeVariants({
      content: 'REMOTE ANSWER',
      variants: ['REMOTE ANSWER'],
      variantIndex: 0,
      provenance: ON_DEVICE,
      stats: { promptTokens: 8 },
      toolCalls: [TOOL],
    });

    expect(upgraded!.variants).toEqual([{ content: 'REMOTE ANSWER', unrecorded: true }]);
    expect(upgraded!.variantIndex).toBe(0);
    expect(
      upgraded!.detach,
      'the on-device label does not follow text that came from somewhere else',
    ).toBe(true);
  });

  it('treats a row cycled all the way round as unattributable too', () => {
    // `variantIndex` is back past the end, so index alone says "its own" —
    // but the text duplicates a variant, which is what a cycled row looks like
    // and the only signal there is.
    const upgraded = upgradeVariants({
      content: 'REMOTE ANSWER',
      variants: ['REMOTE ANSWER'],
      variantIndex: 1,
      provenance: ON_DEVICE,
    });
    expect(upgraded!.detach).toBe(true);
    expect(upgraded!.variants.every((variant) => variant.unrecorded)).toBe(true);
  });

  it('leaves rows it has nothing to say about alone', () => {
    expect(upgradeVariants({ content: 'one turn' })).toBeNull();
    expect(upgradeVariants({ content: 'one turn', variants: [] })).toBeNull();
    // Idempotent: a row already in the new shape is never rewritten, so a
    // re-run cannot overwrite a provenance that WAS recorded.
    expect(
      upgradeVariants({
        content: 'LOCAL ANSWER',
        variants: [{ content: 'REMOTE ANSWER', provenance: REMOTE }],
        variantIndex: 0,
      }),
    ).toBeNull();
  });
});

/* ── Unknown renders as unknown, and fails closed for taint ──────────── */

/** Put an upgraded legacy row into the store, showing its recovered variant. */
function migratedRow(): Message {
  const upgraded = upgradeVariants({
    content: 'LOCAL ANSWER',
    variants: ['REMOTE ANSWER'],
    variantIndex: 1,
    provenance: ON_DEVICE,
  })!;
  const row: Message = {
    id: 'msg_legacy',
    chatId: 'c1',
    role: 'assistant',
    content: 'LOCAL ANSWER',
    provenance: ON_DEVICE,
    createdAt: 2,
    variants: upgraded.variants,
    variantIndex: upgraded.variantIndex,
  };
  useChats.setState({
    messages: [
      { id: 'msg_u', chatId: 'c1', role: 'user', content: 'hello', createdAt: 1 },
      row,
    ],
  });
  return row;
}

describe('a generation whose origin was never written down', () => {
  it('is shown with no chip rather than a guessed one', async () => {
    const row = migratedRow();
    await useChats.getState().cycleVariant(row.id, -1);

    expect(assistantRow().content).toBe('REMOTE ANSWER');
    expect(assistantRow().provenance, 'nothing was invented').toBeUndefined();

    await mounted(createElement(LiveMessage), () => {
      expect(bodyText()).toContain('REMOTE ANSWER');
      expect(chipText(), 'no chip claims to know where this ran').toBe('');
      expect(document.querySelector('.msg__who')?.textContent).toBe('Assistant');
    });
  });

  it('counts as tool-derived, because its tool use is unknown too', async () => {
    const row = migratedRow();
    await useChats.getState().cycleVariant(row.id, -1);

    const built = await buildMessages(
      useChats.getState().chats[0]!,
      useChats.getState().messages,
      0,
      QWEN.id,
    );
    const reply = built.messages.find((entry) => entry.role === 'assistant');
    expect(isTainted(reply!), 'unknown fails closed for egress').toBe(true);
  });

  it('leaves a recorded generation untainted when no tool ran', async () => {
    await remoteThenLocal();
    const built = await buildMessages(
      useChats.getState().chats[0]!,
      useChats.getState().messages,
      0,
      QWEN.id,
    );
    const reply = built.messages.find((entry) => entry.role === 'assistant');
    expect(isTainted(reply!), 'a turn known to have run no tool is not marked').toBe(false);
  });
});

/* ── The third writer of `content` ───────────────────────────────────── */

/**
 * `editMessage` is the last place that could put the row out of step with its
 * list. It is not reachable for an assistant turn today — the edit button is
 * rendered on the user branch alone — so this is the guard, tested where the
 * UI cannot yet take it.
 */
describe('editing a turn that has generations', () => {
  it('does not leave a model’s name beside words it did not write', async () => {
    await remoteThenLocal();
    const id = assistantRow().id;

    await useChats.getState().editMessage(id, 'WORDS I TYPED');

    const row = assistantRow();
    expect(row.content).toBe('WORDS I TYPED');
    expect(row.provenance, 'no model is named beside hand-written text').toBeUndefined();
    expect(row.stats, 'and nothing claims a speed for it').toBeUndefined();
    // The generation it replaced is gone; the other one is untouched.
    expect(row.variants?.map((variant) => variant.content)).toEqual([
      'REMOTE ANSWER',
      'WORDS I TYPED',
    ]);
    expect(reachKind(row.variants?.[0]?.provenance)).toBe('remote');

    // The row still projects its own list, which is the invariant at stake.
    expect(row.variants?.[row.variantIndex!]?.content).toBe(row.content);
  });

  it('leaves a plain user turn exactly as it was', async () => {
    await useChats.setState({
      messages: [{ id: 'msg_u', chatId: 'c1', role: 'user', content: 'hello', createdAt: 1 }],
    });
    await useChats.getState().editMessage('msg_u', 'hello again');
    const row = useChats.getState().messages[0]!;
    expect(row.content).toBe('hello again');
    expect(row.variants).toBeUndefined();
  });
});

describe('the projection below the engine loses nothing (#259)', () => {
  /**
   * THE ROOT CAUSE, AND THE RIGHT HOME FOR IT.
   *
   * `src/state/chat.ts`'s `done` handler builds `Provenance` field by field.
   * That is a projection a human maintains, and it silently drops whatever the
   * snapshot gains — `warnings` was the second field it dropped, and the loss
   * was invisible because an absent field looks exactly like a field that is
   * legitimately absent.
   *
   * The first version of this guard compared two hand-written samples and was
   * DECORATION: deleting the copy in the store left it green. Caught by
   * mutation, which is the only reason it is not still here. So this drives the
   * real store through the real `done` path and derives what was projected from
   * what actually came out.
   */
  const FULL: Provenance = {
    backendId: 'backend-x',
    engine: 'llama-cpp',
    modelId: QWEN.id,
    modelName: QWEN.name,
    reach: REACH_DEVICE,
    fallbackFrom: 'other-backend',
    fallbackReason: 'thermal',
    toolEgress: 'granted',
    warnings: [
      {
        category: 'transport-degraded',
        severity: 'warning',
        message: 'This reply arrived incomplete: 15 characters did not reach this device.',
        source: 'stream',
      },
    ],
  };

  it('carries a warning from the engine all the way onto the stored row', async () => {
    script = [{ text: 'ANSWER', provenance: FULL }];
    await useChats.getState().send('hello');

    const stored = assistantRow().provenance;
    expect(stored?.warnings).toHaveLength(1);
    expect(stored?.warnings?.[0]?.message).toContain('did not reach this device');
    expect(stored?.warnings?.[0]?.category).toBe('transport-degraded');
  });

  it('projects EVERY field the snapshot carried, or transforms it under a known name', async () => {
    /*
     * The total check, DERIVED rather than declared against a twin I also
     * wrote. `snapshotOf` strips `reach` and adds `local`, so every remaining
     * snapshot key must appear on the stored record, and `local` must have
     * become `reach`. A field added to the snapshot and not projected fails
     * here — which is the failure mode that let `warnings` go missing.
     */
    script = [{ text: 'ANSWER', provenance: FULL }];
    await useChats.getState().send('hello');

    const snapshot = snapshotOf(FULL);
    const stored = assistantRow().provenance as unknown as Record<string, unknown>;

    const missing = Object.keys(snapshot)
      .filter((key) => key !== 'local')
      .filter((key) => stored[key] === undefined);
    expect(missing, 'snapshot fields the store did not project').toEqual([]);

    expect(stored['local']).toBeUndefined();
    expect(stored['reach']).toBeDefined();
  });

  it('does not store an empty warnings array', async () => {
    script = [{ text: 'ANSWER', provenance: { ...FULL, warnings: [] } }];
    await useChats.getState().send('hello');
    expect(assistantRow().provenance?.warnings).toBeUndefined();
  });
});

const FULL_FOR_FAILURE: Provenance = {
  backendId: 'b',
  engine: 'llama-cpp',
  modelId: QWEN.id,
  modelName: QWEN.name,
  reach: REACH_DEVICE,
};

describe('a failed turn keeps what the user already saw (#260, #185)', () => {
  it('leaves the streamed text on the row, with the error attached', async () => {
    /*
     * `src/state/chat.ts`'s error branch wrote `content: ''`, throwing away
     * every character that had streamed. That was survivable while a truncated
     * stream was silently accepted; #260 makes it an ERROR, so without this the
     * ruling would trade a silent-truncation defect for a lost-text one —
     * exactly what #185's Done asks not to happen.
     *
     * Note the `catch` block one level down ALREADY preserved the row. Only
     * this branch wiped it, so the two disagreed about the same outcome.
     */
    script = [
      {
        text: 'half a repl',
        provenance: FULL_FOR_FAILURE,
        failWith: 'This reply ended before it was complete.',
      },
    ];
    await useChats.getState().send('hello');

    const row = assistantRow();
    expect(row.content).toBe('half a repl');
    expect(row.error).toContain('ended before it was complete');
    expect(row.streaming).toBe(false);
  });

  it('a turn that finishes is unaffected — the paired control', async () => {
    // Without this, the test above passes on a store that never clears
    // anything, including on turns that genuinely produced nothing.
    script = [{ text: 'a whole reply', provenance: FULL_FOR_FAILURE }];
    await useChats.getState().send('hello');
    expect(assistantRow().content).toBe('a whole reply');
    expect(assistantRow().error).toBeUndefined();
  });
});

/* ── A receipt outlives the turn it was taken in ─────────────────────── */

const RECEIPT: McpCallReceipt = {
  outcome: 'sent',
  serverId: 'mcp_notes',
  serverName: 'notes',
  host: 'notes.example',
  toolName: 'notes.search',
  bytes: 22,
  at: 1_700_000_000_000,
};

const SENT: ToolInvocation = {
  id: 'call_mcp',
  name: 'notes.search',
  input: { q: 'bank details' },
  output: 'found',
  receipt: RECEIPT,
};

/** Every row the store handed to the database, in order. */
function storedRows(): Message[] {
  return (tables.messages.put.mock.calls as unknown as [Message][]).map(([row]) => row);
}

/**
 * Yield to the event loop until `condition` holds, or fail.
 *
 * Bounded by turns of the event loop, not by time, so a loaded runner makes it
 * slower and never makes it fail. Where the thing waited for has a moment of
 * its own — a turn's `onToolHandled`, a store change — a test awaits that.
 */
async function until(condition: () => boolean): Promise<void> {
  for (let tries = 0; tries < 200; tries += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('the condition never held');
}

/** Resolves once `holds()` is true: at once if it already is, otherwise on the store change that makes it so. */
function whenStore(
  what: string,
  store: { subscribe: (listener: () => void) => () => void },
  holds: () => boolean,
): Promise<void> {
  if (holds()) return Promise.resolve();
  return stage(
    what,
    new Promise<void>((resolve) => {
      const unsubscribe = store.subscribe(() => {
        if (!holds()) return;
        unsubscribe();
        resolve();
      });
    }),
  );
}

/** The store has finished with a held-open turn's tool event, including every write it makes for it. */
const toolHandled = (handled: { hang: Promise<void> }): Promise<void> =>
  stage('the store to finish with the tool event', handled.hang);

/** A turn that stays open after its tool event until `release` is called. */
function heldOpen(): { hang: Promise<void>; release: () => void } {
  let release!: () => void;
  const hang = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { hang, release };
}

/** Serve `rows` as the stored thread while `body` runs. */
async function withStoredRows(rows: Message[], body: () => Promise<void>): Promise<void> {
  const messages = tables.messages as { where: unknown };
  const original = messages.where;
  messages.where = () => ({ equals: () => ({ sortBy: async () => rows, toArray: async () => rows }) });
  try {
    await body();
  } finally {
    messages.where = original;
  }
}

const USER: Message = { id: 'msg_u', chatId: 'c1', role: 'user', content: 'hello', createdAt: 1 };

/**
 * #92's record is only a record if it is still there after something goes
 * wrong. Until this, nothing reached the database before a turn ended, and the
 * error and catch rows were built from a placeholder that had no tool calls —
 * so a call that left the device and was followed by a failure left no trace.
 */
describe('an MCP receipt survives the turn it was taken in (#92)', () => {
  it('is on the stored row when the turn finishes', async () => {
    script = [{ text: 'Found it.', provenance: ON_DEVICE, tool: SENT }];
    await useChats.getState().send('hello');

    const finished = storedRows().filter((row) => row.role === 'assistant' && !row.streaming).at(-1);
    expect(finished?.toolCalls?.[0]?.receipt).toEqual(RECEIPT);
  });

  it('is on the stored row when the turn ends in an error', async () => {
    script = [
      {
        text: 'Found',
        provenance: ON_DEVICE,
        tool: SENT,
        failWith: 'This reply ended before it was complete.',
      },
    ];
    await useChats.getState().send('hello');

    const failed = storedRows().filter((row) => row.error !== undefined).at(-1);
    expect(failed, 'the failure was stored').toBeDefined();
    expect(failed?.toolCalls?.[0]?.receipt).toEqual(RECEIPT);
  });

  it('is on the stored row when the stream throws', async () => {
    script = [{ text: '', provenance: ON_DEVICE, tool: SENT, throwWith: 'the adapter fell over' }];
    await useChats.getState().send('hello');

    const failed = storedRows().filter((row) => row.error === 'the adapter fell over').at(-1);
    expect(failed, 'the failure was stored').toBeDefined();
    expect(failed?.toolCalls?.[0]?.receipt).toEqual(RECEIPT);
  });

  it('is written down while the turn is still running', async () => {
    // The kill, measured the only way a test can: the turn cannot end while the
    // assertion runs, so anything that waits for `done` or `error` to write has
    // written nothing yet.
    const handled = heldOpen();
    const turn = heldOpen();
    script = [{ text: 'Found it.', provenance: ON_DEVICE, tool: SENT, onToolHandled: handled.release, hang: turn.hang }];
    const sending = useChats.getState().send('hello');
    try {
      // The store has finished with the tool event; the turn is still held open.
      await toolHandled(handled);
      expect(useChats.getState().generating, 'the turn is still in flight').toBe(true);
      const inFlight = storedRows().find((row) => row.streaming === true);
      expect(inFlight?.toolCalls?.[0]?.receipt).toEqual(RECEIPT);
    } finally {
      turn.release();
      await sending;
    }
  });

  it('is written down while the turn is running even when another chat is open', async () => {
    // The store's `messages` is the thread ON SCREEN. Open another chat while
    // the model works and the running row is no longer in that list, so a
    // mid-turn write that looked the row up there wrote nothing — and a kill
    // before `done` lost the record. The test above is the paired control: the
    // same turn, with the user still looking at it.
    const beforeTool = heldOpen();
    const handled = heldOpen();
    const turn = heldOpen();
    script = [
      {
        text: 'Found it.',
        provenance: ON_DEVICE,
        tool: SENT,
        beforeTool: beforeTool.hang,
        onToolHandled: handled.release,
        hang: turn.hang,
      },
    ];
    const sending = useChats.getState().send('hello');
    try {
      await until(() => script.length === 0);
      await useChats.getState().openChat('c2');
      expect(useChats.getState().messages, 'the running row is off screen').toEqual([]);

      beforeTool.release();
      await toolHandled(handled);

      expect(useChats.getState().generating, 'the turn is still in flight').toBe(true);
      const inFlight = storedRows().find((row) => row.streaming === true);
      expect(inFlight?.chatId).toBe('c1');
      expect(inFlight?.toolCalls?.[0]?.receipt, 'the receipt reached the database mid-turn').toEqual(
        RECEIPT,
      );
    } finally {
      beforeTool.release();
      turn.release();
      await sending;
    }
  });

  it('comes back from an interrupted turn as a failed one, receipt intact', async () => {
    const stale: Message = {
      id: 'msg_stale',
      chatId: 'c1',
      role: 'assistant',
      content: 'Looking that up',
      createdAt: 2,
      streaming: true,
      toolCalls: [SENT],
    };
    await withStoredRows([USER, stale], () => useChats.getState().openChat('c1'));

    const row = assistantRow();
    expect(row.streaming).toBe(false);
    expect(row.error).toBe('This reply was interrupted before it finished.');
    expect(row.content, 'what had streamed is kept').toBe('Looking that up');
    expect(row.toolCalls?.[0]?.receipt).toEqual(RECEIPT);
    // Stored that way too, so it is not an interrupted row the next time.
    expect(storedRows()).toContainEqual(
      expect.objectContaining({ id: 'msg_stale', streaming: false }),
    );
  });

  it('leaves the running generation’s own row streaming', async () => {
    const handled = heldOpen();
    const turn = heldOpen();
    script = [{ text: 'Found it.', provenance: ON_DEVICE, tool: SENT, onToolHandled: handled.release, hang: turn.hang }];
    const sending = useChats.getState().send('hello');
    try {
      await toolHandled(handled);
      const live = storedRows().find((row) => row.streaming === true)!;
      expect(live, 'the running row was written mid-turn').toBeDefined();
      const stale: Message = { ...live, id: 'msg_stale', createdAt: live.createdAt + 1 };
      tables.messages.put.mockClear();

      await withStoredRows([USER, live, stale], () => useChats.getState().openChat('c1'));

      const rows = useChats.getState().messages;
      expect(rows.find((row) => row.id === live.id)?.streaming, 'the live row').toBe(true);
      expect(rows.find((row) => row.id === live.id)?.error).toBeUndefined();
      expect(rows.find((row) => row.id === 'msg_stale')?.error).toBe(
        'This reply was interrupted before it finished.',
      );
      expect(storedRows().map((row) => row.id)).toEqual(['msg_stale']);
    } finally {
      turn.release();
      await sending;
    }
  });

  it('recovers a row whose generation has ended, even one this session ran', async () => {
    // The finished row's own write can fail — a full disk, a closed database —
    // and leave the mid-turn copy as the stored one. Once the turn is over that
    // row is not live, whichever session wrote it, and must not stay streaming.
    script = [{ text: 'Found it.', provenance: ON_DEVICE, tool: SENT }];
    await useChats.getState().send('hello');
    expect(useChats.getState().generating).toBe(false);

    const leftBehind = storedRows().find((row) => row.streaming === true);
    expect(leftBehind, 'the turn wrote a mid-turn row').toBeDefined();
    await withStoredRows([USER, leftBehind!], () => useChats.getState().openChat('c1'));

    expect(assistantRow().streaming).toBe(false);
    expect(assistantRow().error).toBe('This reply was interrupted before it finished.');
  });

  it('is kept when a turn that sent something and wrote nothing is regenerated', async () => {
    useChats.setState({
      messages: [
        USER,
        { id: 'msg_a', chatId: 'c1', role: 'assistant', content: '', createdAt: 2, toolCalls: [SENT], provenance: ON_DEVICE },
      ],
    });
    script = [{ text: 'NEW ANSWER', provenance: ON_DEVICE }];
    await useChats.getState().regenerate('msg_a');

    const row = assistantRow();
    expect(row.variants?.map((variant) => variant.content)).toEqual(['', 'NEW ANSWER']);
    expect(row.variants?.[0]?.toolCalls?.[0]?.receipt).toEqual(RECEIPT);
  });

  it('is the receipt keeping it: the same empty turn without one is dropped, as before', async () => {
    // Driven through `send`, as the not-sent cases below are. The store writes
    // `receipt` onto every tool call it records, so a call to a tool that runs
    // on this device carries the key with nothing in it: a check for the key
    // rather than for a receipt would keep this version, and a row seeded
    // without the key could not tell.
    script = [
      { text: '', provenance: ON_DEVICE, tool: TOOL },
      { text: 'NEW ANSWER', provenance: ON_DEVICE },
    ];
    await useChats.getState().send('hello');
    const first = assistantRow();
    expect(first.content).toBe('');
    expect(first.toolCalls?.map((call) => 'receipt' in call), 'the store wrote the key, empty').toEqual([true]);
    expect(first.toolCalls?.[0]?.receipt).toBeUndefined();
    await useChats.getState().regenerate(first.id);

    expect(assistantRow().variants?.map((variant) => variant.content)).toEqual(['NEW ANSWER']);
  });

  it('is kept when a turn whose call failed after it was handed over is regenerated', async () => {
    // A failed call may have delivered its arguments before it failed, so its
    // record is kept for the same reason a sent one is.
    const failed: ToolInvocation = { ...SENT, isError: true, receipt: { ...RECEIPT, outcome: 'failed' } };
    useChats.setState({
      messages: [
        USER,
        { id: 'msg_a', chatId: 'c1', role: 'assistant', content: '', createdAt: 2, toolCalls: [failed], provenance: ON_DEVICE },
      ],
    });
    script = [{ text: 'NEW ANSWER', provenance: ON_DEVICE }];
    await useChats.getState().regenerate('msg_a');

    const row = assistantRow();
    expect(row.variants?.map((variant) => variant.content)).toEqual(['', 'NEW ANSWER']);
    expect(row.variants?.[0]?.toolCalls?.[0]?.receipt?.outcome).toBe('failed');
  });

  /*
   * NOT-SENT RECORDS SURVIVE REGENERATION (#92, owner ruling). The
   * recommendation was to drop a version whose only records say "not sent"
   * like any empty reply, since nothing left the device; the owner chose to
   * keep it. The export prints its records as belonging to a version not
   * shown — the treatment a version that did send already gets — and once.
   */
  it.each([
    ['not-allowed', 'it was not allowed'],
    ['unattended', 'this conversation had not allowed that server, and nobody was there to be asked'],
    ['declined', 'it could change data there, and was declined'],
    ['server-changed', 'the server changed before it went'],
    ['stopped', 'the reply was stopped before it went'],
    ['round-limit', 'the turn had already used every tool round it was allowed'],
    ['reply-failed', 'the reply failed before it went'],
  ] as const)('is kept when a turn whose only record says a call was not sent (%s) is regenerated', async (why, reason) => {
    const withheld: ToolInvocation = { ...SENT, isError: true, receipt: { ...RECEIPT, outcome: 'withheld', why } };
    // A turn that wrote nothing but the record, as a stopped or refused one does.
    script = [
      { text: '', provenance: ON_DEVICE, tool: withheld },
      { text: 'NEW ANSWER', provenance: ON_DEVICE },
    ];
    await useChats.getState().send('hello');
    expect(assistantRow().content).toBe('');
    await useChats.getState().regenerate(assistantRow().id);

    const row = assistantRow();
    expect(row.variants?.map((variant) => variant.content)).toEqual(['', 'NEW ANSWER']);
    expect(row.variantIndex).toBe(1);
    expect(row.variants?.[0]?.toolCalls?.[0]?.receipt).toEqual(withheld.receipt);

    const transcript = renderTranscript(useChats.getState().chats[0]!, useChats.getState().messages);
    expect(transcript).toContain(
      `\n- notes.search was not sent to notes.example (notes) at 2023-11-14 22:13:20 UTC — ${reason} (from a version of this reply not shown).\n`,
    );
    expect(transcript.split('notes.example').length - 1, 'printed once').toBe(1);
  });

  it('is kept when a failed regeneration whose only record says a call was not sent is regenerated again', async () => {
    // The row shows a generation that was never appended to its list, as in
    // "is kept when a regeneration that failed after sending is regenerated again".
    const withheld: ToolInvocation = { ...SENT, isError: true, receipt: { ...RECEIPT, outcome: 'withheld', why: 'stopped' } };
    useChats.setState({
      messages: [
        USER,
        {
          id: 'msg_a',
          chatId: 'c1',
          role: 'assistant',
          content: '',
          createdAt: 2,
          toolCalls: [withheld],
          error: 'This reply ended before it was complete.',
          variants: [{ content: 'FIRST ANSWER', provenance: REMOTE }],
          variantIndex: 1,
        },
      ],
    });
    script = [{ text: 'NEW ANSWER', provenance: ON_DEVICE }];
    await useChats.getState().regenerate('msg_a');

    const row = assistantRow();
    expect(row.variants?.map((variant) => variant.content)).toEqual(['FIRST ANSWER', '', 'NEW ANSWER']);
    expect(row.variants?.[1]?.toolCalls?.[0]?.receipt).toEqual(withheld.receipt);

    const transcript = renderTranscript(useChats.getState().chats[0]!, useChats.getState().messages);
    expect(transcript).toContain(
      '\n- notes.search was not sent to notes.example (notes) at 2023-11-14 22:13:20 UTC — the reply was stopped before it went (from a version of this reply not shown).\n',
    );
    expect(transcript.split('notes.example').length - 1, 'printed once').toBe(1);
  });

  it('is not written down mid-turn when it records a call that was not sent', async () => {
    // The paired control is "is written down while the turn is still running":
    // the same held-open turn, with a receipt that says something left. The
    // ruling that keeps a not-sent record through regeneration does not move it
    // into this write: it is kept with the row the turn ends on.
    const handled = heldOpen();
    const turn = heldOpen();
    const withheld: ToolInvocation = { ...SENT, receipt: { ...RECEIPT, outcome: 'withheld', why: 'not-allowed' } };
    script = [
      { text: 'Could not file it.', provenance: ON_DEVICE, tool: withheld, onToolHandled: handled.release, hang: turn.hang },
    ];
    const sending = useChats.getState().send('hello');
    try {
      // Not a window of ticks: the store has finished with the tool event, so
      // any write it makes for that event has been made, and the turn is still
      // held open.
      await toolHandled(handled);
      expect(
        useChats.getState().messages.some((row) => row.role === 'assistant' && (row.toolCalls?.length ?? 0) > 0),
        'the tool event reached the row',
      ).toBe(true);
      expect(useChats.getState().generating, 'the turn is still in flight').toBe(true);
      expect(storedRows().some((row) => row.streaming === true)).toBe(false);
    } finally {
      turn.release();
      await sending;
    }
    // It is kept with the finished turn, like the rest of the generation.
    const finished = storedRows().filter((row) => row.role === 'assistant' && !row.streaming).at(-1);
    expect(finished?.toolCalls?.[0]?.receipt?.outcome).toBe('withheld');
  });

  it('is kept when a regeneration that failed after sending is regenerated again', async () => {
    // The row shows a generation that was never appended to its list: its
    // index is one past the end, where the failed regeneration was being made.
    useChats.setState({
      messages: [
        USER,
        {
          id: 'msg_a',
          chatId: 'c1',
          role: 'assistant',
          content: '',
          createdAt: 2,
          toolCalls: [SENT],
          error: 'This reply ended before it was complete.',
          variants: [{ content: 'FIRST ANSWER', provenance: REMOTE }],
          variantIndex: 1,
        },
      ],
    });
    script = [{ text: 'NEW ANSWER', provenance: ON_DEVICE }];
    await useChats.getState().regenerate('msg_a');

    const row = assistantRow();
    expect(row.variants?.map((variant) => variant.content)).toEqual(['FIRST ANSWER', '', 'NEW ANSWER']);
    expect(row.variants?.[1]?.toolCalls?.[0]?.receipt).toEqual(RECEIPT);
  });

  it('is the receipt keeping that one too: a failed regeneration without one is dropped, as before', async () => {
    useChats.setState({
      messages: [
        USER,
        {
          id: 'msg_a',
          chatId: 'c1',
          role: 'assistant',
          content: 'half a repl',
          createdAt: 2,
          // The key present and empty, as the store writes it for a local tool.
          toolCalls: [{ ...TOOL, receipt: undefined }],
          error: 'This reply ended before it was complete.',
          variants: [{ content: 'FIRST ANSWER', provenance: REMOTE }],
          variantIndex: 1,
        },
      ],
    });
    script = [{ text: 'NEW ANSWER', provenance: ON_DEVICE }];
    await useChats.getState().regenerate('msg_a');

    expect(assistantRow().variants?.map((variant) => variant.content)).toEqual([
      'FIRST ANSWER',
      'NEW ANSWER',
    ]);
  });

  it.each(['no model to run it on', 'a chat whose delete has been asked for'] as const)(
    'is kept, with the turns after it, when a regeneration cannot start: %s',
    async (why) => {
      // Regenerate took the turn and every later one off the screen, deleted the
      // later rows, and deleted the turn itself once `runGeneration` returned —
      // whether or not a turn had started. One that could not start replaced it
      // with nothing: the record that a call's arguments went was gone from disk
      // and screen.
      // A chat of its own: the store remembers a chat whose delete was asked
      // for as long as it runs, and every other test here writes to `c1`.
      const chatId = why === 'no model to run it on' ? 'c_regen_no_model' : 'c_regen_deleting';
      const thread: Message[] = [
        { ...USER, chatId },
        { id: 'msg_a', chatId, role: 'assistant', content: 'Filed.', createdAt: 2, toolCalls: [SENT], provenance: ON_DEVICE },
        { id: 'msg_q2', chatId, role: 'user', content: 'and again?', createdAt: 3 },
        { id: 'msg_b', chatId, role: 'assistant', content: 'Again.', createdAt: 4, provenance: ON_DEVICE },
      ];
      useChats.setState({ activeChatId: chatId, messages: thread, chats: [{ ...CHAT, id: chatId }] });
      if (why === 'no model to run it on') {
        useChats.setState({ chats: [{ ...CHAT, id: chatId, modelId: null }] });
        useModels.setState({ activeModelId: null, installed: {} });
      } else {
        // A delete that never lands, so the chat stays in the store, marked.
        const { deleteChat } = await import('@/db');
        vi.mocked(deleteChat).mockImplementationOnce(() => new Promise<void>(() => {}));
        void useChats.getState().removeChat(chatId);
      }
      script = [{ text: 'NEW ANSWER', provenance: ON_DEVICE }];

      await useChats.getState().regenerate('msg_a');

      if (why === 'no model to run it on') {
        expect(useApp.getState().toasts.map((toast) => toast.message)).toContain(
          'Choose a model first — none is installed or connected yet.',
        );
      }
      expect(script, 'no turn ran').toHaveLength(1);
      expect(tables.messages.delete, 'nothing is deleted').not.toHaveBeenCalled();
      expect(useChats.getState().messages, 'and the thread on screen is as it was').toEqual(thread);
    },
  );

  it('takes the row a regeneration replaces out of the database once the new row holds it', async () => {
    // Otherwise a kill after the new row is written leaves both, and the
    // reopened thread shows the turn twice.
    const turn = heldOpen();
    useChats.setState({
      messages: [
        USER,
        { id: 'msg_old', chatId: 'c1', role: 'assistant', content: 'OLD ANSWER', createdAt: 2, provenance: ON_DEVICE },
      ],
    });
    const handled = heldOpen();
    script = [{ text: 'NEW ANSWER', provenance: ON_DEVICE, tool: SENT, onToolHandled: handled.release, hang: turn.hang }];
    const regenerating = useChats.getState().regenerate('msg_old');
    try {
      await toolHandled(handled);
      const inFlight = storedRows().find((row) => row.streaming === true);
      expect(inFlight?.variants?.map((variant) => variant.content)).toEqual(['OLD ANSWER']);
      expect(tables.messages.delete).toHaveBeenCalledWith('msg_old');
    } finally {
      turn.release();
      await regenerating;
    }
  });

  it('keeps that row while nothing has been written in its place', async () => {
    // The control: with no receipt nothing is written mid-turn, so the old row
    // is the only copy until the turn ends, and it is deleted only then.
    const turn = heldOpen();
    useChats.setState({
      messages: [
        USER,
        { id: 'msg_old', chatId: 'c1', role: 'assistant', content: 'OLD ANSWER', createdAt: 2, provenance: ON_DEVICE },
      ],
    });
    const handled = heldOpen();
    script = [{ text: 'NEW ANSWER', provenance: ON_DEVICE, tool: TOOL, onToolHandled: handled.release, hang: turn.hang }];
    const regenerating = useChats.getState().regenerate('msg_old');
    try {
      // The store has finished with the tool event, as above.
      await toolHandled(handled);
      expect(assistantRow().toolCalls?.length ?? 0, 'the tool event reached the row').toBeGreaterThan(0);
      expect(tables.messages.delete).not.toHaveBeenCalledWith('msg_old');
    } finally {
      turn.release();
      await regenerating;
    }
    expect(tables.messages.delete).toHaveBeenCalledWith('msg_old');
  });
});

/* ── The tool-output sheet, a turn later ─────────────────────────────── */

describe('the tool-output sheet over an earlier reply', () => {
  const EARLIER: Message = {
    id: 'msg_a',
    chatId: 'c1',
    role: 'assistant',
    content: 'Your notes say you owe Sam.',
    createdAt: 2,
    toolCalls: [SENT],
    provenance: REMOTE,
  };

  it('names the server that reply drew on, through the store’s own policy', async () => {
    // The engine asks with this turn's tools, which on a later turn are none,
    // so whatever the sheet says about the history the store has to supply.
    const shown: (string | undefined)[] = [];
    const original = useApp.getState().requestApproval;
    useApp.setState({
      requestApproval: async (_action: string, prompt?: { readonly body?: string }) => {
        shown.push(prompt?.body);
        return false;
      },
    });
    try {
      useChats.setState({ messages: [USER, EARLIER] });
      script = [{ text: 'Sure.', provenance: ON_DEVICE, asksEgress: true }];
      await useChats.getState().send('and then?');
    } finally {
      useApp.setState({ requestApproval: original });
    }

    expect(shown).toHaveLength(1);
    expect(shown[0]).toContain('what notes.search returned from notes.example');
    expect(shown[0]).not.toContain('own data');
  });

  it('names only earlier replies still in the prompt', async () => {
    // Longer than the smallest prompt budget `contextBudget` allows (256
    // tokens), so a small window really has to drop it.
    const chat = useChats.getState().chats[0]!;
    const long: Message = { ...EARLIER, content: 'Your notes say you owe Sam. '.repeat(200) };
    const rows: Message[] = [USER, long, { ...USER, id: 'msg_u2', content: 'and then?', createdAt: 3 }];

    const whole = await buildMessages(chat, rows, 0, QWEN.id);
    expect(whole.derivedReplies.map((reply) => reply.toolCalls[0]?.receipt?.host)).toEqual([
      'notes.example',
    ]);

    // A window too small for it: the reply is dropped from the prompt, so it is
    // not going, and the sheet has no business naming where it came from.
    useModels.setState({ installed: { [QWEN.id]: installedRecord({ ...QWEN, contextLength: 64 }) } });
    const trimmed = await buildMessages(chat, rows, 0, QWEN.id);
    expect(trimmed.messages.some((message) => message.role === 'assistant'), 'the reply was dropped').toBe(
      false,
    );
    expect(trimmed.derivedReplies).toEqual([]);
  });
});

/* ── The MCP send sheet, through the store (#6) ───────────────────────── */

describe('the MCP send sheet, through the store’s own policy', () => {
  const ASK: DestinationRequest = {
    destination: {
      kind: 'mcp',
      serverId: 'mcp_notes',
      serverName: 'notes',
      host: 'notes.example',
      url: 'https://notes.example/mcp',
    },
    calls: [{ toolName: 'notes.note', bytes: 30, preview: '{"text":"a note"}' }],
  };

  /** Send one turn whose engine asks the MCP policy, and answer the sheet as told. */
  async function answering(
    answer: 'no' | 'yes' | 'conversation',
    thenMcp?: Turn['thenMcp'],
  ): Promise<(ApprovalPrompt | undefined)[]> {
    const prompts: (ApprovalPrompt | undefined)[] = [];
    const original = useApp.getState().requestApproval;
    useApp.setState({
      requestApproval: async (_action: string, prompt?: ApprovalPrompt) => {
        prompts.push(prompt);
        if (answer === 'conversation') prompt?.onExtended?.();
        return answer !== 'no';
      },
    });
    mcpAnswers = [];
    try {
      script = [{ text: 'Filed.', provenance: ON_DEVICE, asksMcp: ASK, thenMcp }];
      await useChats.getState().send('file it');
    } finally {
      useApp.setState({ requestApproval: original });
    }
    return prompts;
  }

  const grants = () => useChats.getState().chats.find((chat) => chat.id === 'c1')?.egressGrants ?? [];

  /**
   * Every MCP grant the store starts from here on, so a test can wait for each
   * to settle — its post-write re-check included — before it says what was
   * kept. The policy writes a grant with `void`, so nothing else holds that
   * promise, and a macrotask only covers a grant that happens to land within one.
   */
  function recordingGrantWrites() {
    const original = useChats.getState().grantMcpEgress;
    const started: Promise<void>[] = [];
    useChats.setState({
      grantMcpEgress: (chatId, server) => {
        const granting = original(chatId, server);
        started.push(granting);
        return granting;
      },
    });
    return {
      /** Every grant started so far has settled, and any started while waiting. */
      settled: (): Promise<void> =>
        stage(
          'every MCP grant started here to settle',
          (async () => {
            for (let seen = -1; seen !== started.length; ) {
              seen = started.length;
              await Promise.all(started);
            }
          })(),
        ),
      restore: () => useChats.setState({ grantMcpEgress: original }),
    };
  }

  /**
   * Hold open every write of a chat that carries a grant, until released.
   *
   * Without it, whether a grant's write has landed by the next line depends on
   * how many microtasks that line happens to wait, and a test of what the
   * policy remembers could pass on the stored grant instead.
   */
  function holdingGrantWrites(): { release: () => void; restore: () => void } {
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    tables.chats.put.mockImplementation((async (chat: { egressGrants?: readonly unknown[] }) => {
      if (chat.egressGrants?.length) await held;
    }) as never);
    return {
      release: () => release(),
      restore: () => {
        release();
        tables.chats.put.mockImplementation(async () => {});
      },
    };
  }

  it('is taken down when the turn is stopped, and the turn ends', async () => {
    // The real queue and the real policy: nothing here replaces `requestApproval`.
    useApp.setState({ approvals: [] });
    mcpAnswers = [];
    script = [{ text: 'Filed.', provenance: ON_DEVICE, asksMcp: ASK }];
    const sending = useChats.getState().send('file it');
    await whenStore('the send sheet to be raised', useApp, () => useApp.getState().approvals.length > 0);
    expect(useApp.getState().approvals).toHaveLength(1);
    expect(useApp.getState().approvals[0]?.title).toBe(mcpSendSheet(ASK).title);

    useChats.getState().stop();

    await whenStore('Stop to take the sheet down', useApp, () => useApp.getState().approvals.length === 0);
    await sending;
    // Stop's no is the policy's answer; the dispatcher reads it off the signal.
    expect(mcpAnswers).toEqual([{ decision: 'deny', granted: false }]);
    expect(grants()).toEqual([]);
  });

  it('dismisses only the stopped turn’s sheet, raises none once stopped, and lets an earlier answer stand', async () => {
    useApp.setState({ approvals: [] });
    const actions = () => useApp.getState().approvals.map((entry) => entry.action);
    const other = new AbortController();
    const stopping = new AbortController();
    const theirs = useApp.getState().requestApproval('from another turn', undefined, other.signal);
    const ours = useApp.getState().requestApproval('from this turn', undefined, stopping.signal);
    expect(actions()).toEqual(['from another turn', 'from this turn']);

    stopping.abort();
    await expect(ours).resolves.toBe(false);
    expect(actions(), 'another turn’s sheet stays').toEqual(['from another turn']);

    const late = useApp.getState().requestApproval('after Stop', undefined, stopping.signal);
    expect(actions(), 'a stopped turn raises nothing').toEqual(['from another turn']);
    await expect(late).resolves.toBe(false);

    useApp.getState().answerApproval(useApp.getState().approvals[0]!.id, true);
    await expect(theirs).resolves.toBe(true);
    other.abort();
    expect(useApp.getState().approvals).toEqual([]);
  });

  it('raises the sheet `mcpSendSheet` builds, and a no sends nothing and keeps nothing', async () => {
    const prompts = await answering('no');

    expect(prompts).toHaveLength(1);
    const { action: _action, ...sheet } = mcpSendSheet(ASK);
    expect(prompts[0]).toMatchObject(sheet);
    expect(mcpAnswers).toEqual([{ decision: 'deny', granted: false }]);
    expect(grants()).toEqual([]);
  });

  it('keeps a conversation answer for this chat and this server, and honours it at once', async () => {
    const writes = recordingGrantWrites();
    try {
      await answering('conversation');
      // Held before the write lands, so a call made straight after is not asked again.
      expect(mcpAnswers).toEqual([{ decision: 'conversation', granted: true }]);
      await writes.settled();
    } finally {
      writes.restore();
    }

    expect(grants()).toEqual([
      { kind: 'mcp', serverId: 'mcp_notes', url: 'https://notes.example/mcp', grantedAt: expect.any(Number) },
    ]);
  });

  it('stops honouring a conversation answer once the server’s grants are withdrawn, within the same turn', async () => {
    // A local model can loop over tool batches for a long time. Switching the
    // server off and back on in Settings drops the stored grant, and brings
    // the same record back at the same address — so the live check in
    // `state/mcp.ts` passes again. What the policy remembered of the answer
    // must not outlast that, or the privacy command's "Every grant to a server
    // is dropped when it is removed or switched off" is false until the turn ends.
    const granted: boolean[] = [];
    const write = holdingGrantWrites();
    try {
      await answering('conversation', async (policy) => {
        // Still being written, so what answers here is the policy's own memory
        // of the answer. Another server's revocation is not this one's.
        await revokeMcpGrantsFor('mcp_other');
        granted.push(policy.isGranted(ASK.destination));

        write.release();
        await whenStore('the store to hold the grant', useChats, () => grants().length > 0);
        expect(grants()).toHaveLength(1);
        // What `useMcp.toggle('mcp_notes', false)` and `remove` call.
        await revokeMcpGrantsFor('mcp_notes');
        granted.push(policy.isGranted(ASK.destination));
      });
    } finally {
      write.restore();
    }

    expect(mcpAnswers).toEqual([{ decision: 'conversation', granted: true }]);
    expect(granted).toEqual([true, false]);
    expect(grants()).toEqual([]);
  });

  it('keeps nothing of a conversation answer withdrawn before its write landed', async () => {
    // The revocation runs while the grant is still being written, so it finds
    // nothing stored to drop; the write then lands after it.
    const granted: boolean[] = [];
    const writes = recordingGrantWrites();
    const write = holdingGrantWrites();
    try {
      await answering('conversation', async (policy) => {
        await revokeMcpGrantsFor('mcp_notes');
        granted.push(policy.isGranted(ASK.destination));
        write.release();
      });
      // The grant landed after the revocation. It has settled, and withdrawn
      // itself, before anything is said about what was kept.
      await writes.settled();
    } finally {
      write.restore();
      writes.restore();
    }

    expect(granted).toEqual([false]);
    expect(grants()).toEqual([]);
  });

  it('does not keep a plain yes: it covered the calls on the sheet', async () => {
    await answering('yes');

    expect(mcpAnswers).toEqual([{ decision: 'calls', granted: false }]);
    expect(grants()).toEqual([]);
  });

  const NOTES_GRANT = { kind: 'mcp' as const, serverId: 'mcp_notes', url: 'https://notes.example/mcp', grantedAt: 1 };
  const OTHER = {
    kind: 'mcp' as const,
    serverId: 'mcp_other',
    serverName: 'other',
    host: 'other.example',
    url: 'https://other.example/mcp',
  };
  const OTHER_GRANT = { kind: 'mcp' as const, serverId: OTHER.serverId, url: OTHER.url, grantedAt: 1 };
  const holdsNotes = (): boolean => grants().some((grant) => grant.kind === 'mcp' && grant.serverId === 'mcp_notes');

  /** Every chat write held open until `release`, counting those started. */
  function holdingEveryChatWrite() {
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started = 0;
    const arrivals: { count: number; arrived: () => void }[] = [];
    tables.chats.put.mockImplementation((async () => {
      started += 1;
      for (let at = arrivals.length - 1; at >= 0; at -= 1) {
        if (arrivals[at]!.count <= started) arrivals.splice(at, 1)[0]!.arrived();
      }
      await held;
    }) as never);
    return {
      started: () => started,
      /** Resolves once `count` writes have started: at once, if they have. */
      startedAt: (count: number): Promise<void> =>
        started >= count
          ? Promise.resolve()
          : stage(
              `${count} chat write(s) to start`,
              new Promise<void>((arrived) => arrivals.push({ count, arrived })),
            ),
      release: () => release(),
      restore: () => {
        release();
        tables.chats.put.mockImplementation(async () => {});
      },
    };
  }

  it('keeps nothing of a conversation answer given while the server was being switched off', async () => {
    // The sheet was up when the server's grants were withdrawn. The answer is
    // about a server the person has since switched off: the calls on the sheet
    // are what it covered, and nothing of it is kept — neither the policy's
    // memory of it for the rest of the turn, nor a grant that would come back
    // into force when the server is switched on again.
    const original = useApp.getState().requestApproval;
    useApp.setState({
      requestApproval: async (_action: string, prompt?: ApprovalPrompt) => {
        await revokeMcpGrantsFor('mcp_notes');
        prompt?.onExtended?.();
        return true;
      },
    });
    mcpAnswers = [];
    const writes = recordingGrantWrites();
    try {
      script = [{ text: 'Filed.', provenance: ON_DEVICE, asksMcp: ASK }];
      await useChats.getState().send('file it');
      // Any grant the policy started has settled before anything is said about it.
      await writes.settled();
    } finally {
      useApp.setState({ requestApproval: original });
      writes.restore();
    }

    expect(mcpAnswers).toEqual([{ decision: 'conversation', granted: false }]);
    expect(grants()).toEqual([]);
    const written = tables.chats.put.mock.calls as unknown as [{ egressGrants?: readonly unknown[] }][];
    expect(written.some(([chat]) => Boolean(chat.egressGrants?.length)), 'no grant was ever written').toBe(false);
  });

  it('does not answer for a held grant while its revocation is still being written', async () => {
    // The store holds the grant until the revocation's write has landed. A call
    // checked in that window — the dispatcher reads a held grant again before
    // each call — must not go on it. Another server's grant is not this one's.
    useChats.setState({ chats: [{ ...CHAT, egressGrants: [NOTES_GRANT, OTHER_GRANT] }] });
    const seen: { notes: boolean; other: boolean; stored: boolean }[] = [];
    let write: ReturnType<typeof holdingEveryChatWrite> | undefined;
    try {
      await answering('no', async (policy) => {
        write = holdingEveryChatWrite();
        const revoking = revokeMcpGrantsFor('mcp_notes');
        await write!.startedAt(1);
        expect(write!.started()).toBe(1);
        seen.push({ notes: policy.isGranted(ASK.destination), other: policy.isGranted(OTHER), stored: holdsNotes() });
        write.release();
        await revoking;
        seen.push({ notes: policy.isGranted(ASK.destination), other: policy.isGranted(OTHER), stored: holdsNotes() });
        write.restore();
      });
    } finally {
      write?.restore();
    }

    expect(seen).toEqual([
      { notes: false, other: true, stored: true },
      { notes: false, other: true, stored: false },
    ]);
  });

  it('does not answer for a grant whose write outlasted a revocation, before it withdraws itself', async () => {
    // A revocation that starts and ends while a grant is still being written
    // reads the chat before the grant is in it, and has nothing to drop. The
    // grant then lands in the store, and withdraws itself only once its write
    // has settled. In between, it is in the store and must not answer.
    const seen: boolean[] = [];
    let write: ReturnType<typeof holdingEveryChatWrite> | undefined;
    let unsubscribe = () => {};
    try {
      await answering('no', async (policy) => {
        write = holdingEveryChatWrite();
        const granting = useChats.getState().grantMcpEgress('c1', { serverId: 'mcp_notes', url: ASK.destination.url });
        await write!.startedAt(1);
        expect(write!.started()).toBe(1);
        await useChats.getState().revokeMcpEgress('mcp_notes');
        unsubscribe = useChats.subscribe(() => {
          if (holdsNotes()) seen.push(policy.isGranted(ASK.destination));
        });
        write.restore();
        await granting;
        unsubscribe();
      });
    } finally {
      unsubscribe();
      write?.restore();
    }

    expect(seen.length, 'the store held the grant for a moment').toBeGreaterThan(0);
    expect(seen).not.toContain(true);
    expect(grants()).toEqual([]);
  });
});
