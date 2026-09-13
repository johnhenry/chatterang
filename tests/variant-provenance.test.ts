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

import type { InstalledModel } from '@/db';
import type { Message, Provenance, ToolInvocation } from '@/domain/chat';

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

const { useChats, buildMessages } = await import('@/state/chat');
const { useModels } = await import('@/state/models');
const { useApp } = await import('@/state/app');
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
 * The ENGINE still reports a boolean — `ProvenanceSnapshot.local`, which #188
 * owns — and `state/chat.ts` is where it becomes a `Reach`. The fixtures below
 * are written as the record the app STORES, so this converts one back into the
 * shape the engine hands over, `reach` and all removed. Passing the record
 * through unchanged would let a store that simply copied `event.provenance`
 * pass a test about deriving it.
 */
function snapshotOf(provenance: Provenance): Record<string, unknown> {
  const { reach: _derived, ...rest } = provenance;
  return { ...rest, local: ranOnDevice(provenance) };
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
}

/** Turns the fake engine hands back, in order. */
let script: Turn[] = [];

/**
 * The engine, replaced by a recorder.
 *
 * What is under test is what the STORE does with a finished turn, so the
 * generation itself is scripted: the real engine would try to open a GGUF that
 * is not there, and could not be made to answer remotely and then locally.
 */
function scriptedEngine(): unknown {
  return {
    async *stream() {
      const turn = script.shift();
      if (!turn) throw new Error('the script ran out of turns');
      if (turn.tool) yield { type: 'tool', tool: turn.tool };
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
