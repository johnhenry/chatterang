/**
 * THE CHIP AND THE TRANSCRIPT FOLLOW THE TEXT.
 *
 * `tests/variant-provenance.test.ts` pins the STATE: a generation and where it
 * came from are one record, and the two methods that move text move the record.
 * This file pins the two RENDERERS on the other side of that record, because
 * the state being right is not the same claim as the surfaces reading it.
 *
 *   - `MessageView` used to read the chip, the model name, the tok/s readout
 *     and the tool-egress chip off the ROW's fields while the body came from
 *     the displayed generation. When those disagreed, a reply that came back
 *     from a provider was rendered under the ember flame — this app's own mark
 *     for a turn that ran on the device.
 *   - `renderTranscript` did the same one file over, and wrote it down:
 *     "## Qwen3 4B Instruct (on device)" with an OpenAI reply underneath, into
 *     `chat export`, into `/chats/*.md`, and into the file the user downloads.
 *
 * Both now project ONE generation record. The last test in each half proves
 * that literally, by handing the renderers a row whose own fields disagree
 * with the generation it is displaying — the shape a future writer that
 * forgets `applyVariant` would produce — and showing that what is rendered is
 * the generation, not the row. Everything else drives the shipped `send`,
 * `regenerate` and `cycleVariant` and reads the real DOM.
 */

import { createElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { InstalledModel } from '@/db';
import type { Chat, Message, Provenance, ToolInvocation } from '@/domain/chat';

/* ── The database, stubbed at the table boundary ────────────────────── */

/**
 * `rows` is what `buildTranscript` will read back. The export path goes
 * through `db.messages`, not through the store, so proving the exported file
 * means putting the rows the store wrote where the exporter looks for them.
 */
const tables = vi.hoisted(() => ({
  rows: [] as unknown[],
  models: { put: vi.fn(async () => {}), delete: vi.fn(async () => {}), toArray: async () => [] },
  settings: { get: vi.fn(async () => undefined), put: vi.fn(async () => {}) },
  chats: { put: vi.fn(async () => {}), delete: vi.fn(async () => {}), toArray: async () => [] },
  messages: {
    put: vi.fn(async () => {}),
    delete: vi.fn(async () => {}),
    where: () => ({
      equals: () => ({
        sortBy: async () => tables.rows,
        toArray: async () => tables.rows,
      }),
    }),
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

const { useChats } = await import('@/state/chat');
const { useModels } = await import('@/state/models');
const { useApp } = await import('@/state/app');
const { catalogEntry } = await import('@/data/catalog');
const { DEFAULT_SAMPLER } = await import('@/domain/manifest');
const { MessageView } = await import('@/features/chat/MessageView');
const { renderTranscript } = await import('@/shell/commands');
const { buildTranscript } = await import('@/lib/export');

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

/* ── Two places a turn can run ───────────────────────────────────────── */

const REMOTE: Provenance = {
  backendId: 'conn_openai',
  engine: 'remote',
  modelId: 'gpt-4o-mini',
  modelName: 'OpenAI · gpt-4o-mini',
  local: false,
};

const ON_DEVICE: Provenance = {
  backendId: 'llama-cpp',
  engine: 'llama-cpp',
  modelId: QWEN.id,
  modelName: 'Qwen3 4B Instruct',
  local: true,
};

const TOOL: ToolInvocation = {
  id: 'call_1',
  name: 'bash',
  input: { command: 'ls /chats' },
  output: 'chat_1 — Bank details',
};

interface Turn {
  readonly text: string;
  readonly provenance: Provenance;
  readonly tool?: ToolInvocation;
  readonly stats?: Record<string, number>;
}

let script: Turn[] = [];

/** The engine, scripted: what is under test is what the renderers do after. */
function scriptedEngine(): unknown {
  return {
    async *stream() {
      const turn = script.shift();
      if (!turn) throw new Error('the script ran out of turns');
      if (turn.tool) yield { type: 'tool', tool: turn.tool };
      yield {
        type: 'done',
        text: turn.text,
        provenance: turn.provenance,
        stats: turn.stats ?? { promptTokens: 8, completionTokens: 4 },
      };
    },
  };
}

const CHAT: Chat = {
  id: 'c1',
  title: 'New chat',
  mode: 'chat',
  personaId: null,
  modelId: QWEN.id,
  sampler: null,
  tools: [],
  showThinking: false,
  createdAt: 1,
  updatedAt: Date.parse('2026-09-02T00:00:00Z'),
  messageCount: 0,
  preview: '',
};

beforeEach(() => {
  vi.clearAllMocks();
  script = [];
  tables.rows = [];

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

/* ── Rendering ───────────────────────────────────────────────────────── */

function assistantRow(): Message {
  const row = useChats.getState().messages.find((entry) => entry.role === 'assistant');
  expect(row, 'there is an assistant turn').toBeDefined();
  return row!;
}

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

/** The assistant turn, re-rendered from the store on every change. */
function LiveMessage(): ReturnType<typeof createElement> {
  const message = useChats((state) => state.messages.find((entry) => entry.role === 'assistant'))!;
  return createElement(MessageView, {
    message,
    showThinking: true,
    onRegenerate: () => {},
    onEdit: () => {},
  });
}

/** One message rendered exactly as given — used for rows the store cannot make. */
function fixedMessage(message: Message): ReturnType<typeof createElement> {
  return createElement(MessageView, {
    message,
    showThinking: true,
    onRegenerate: () => {},
    onEdit: () => {},
  });
}

function byLabel(label: string): HTMLElement {
  const found = document.querySelector(`[aria-label="${label}"]`);
  expect(found, `“${label}” is on screen`).not.toBeNull();
  return found as HTMLElement;
}

const head = (): string => document.querySelector('.msg__head')?.textContent?.trim() ?? '';
const who = (): string => document.querySelector('.msg__who')?.textContent?.trim() ?? '';
const chips = (): string[] =>
  [...document.querySelectorAll('.msg__head .chip')].map((chip) => chip.textContent?.trim() ?? '');
const chipClasses = (): string[] =>
  [...document.querySelectorAll('.msg__head .chip')].map((chip) => chip.className);
const egressTitle = (): string =>
  document.querySelector('.msg__head .chip[title]')?.getAttribute('title') ?? '';
const bodyText = (): string => document.querySelector('.msg__body')?.textContent?.trim() ?? '';
const counter = (): string =>
  document.querySelector('.msg__foot .readout')?.textContent?.trim() ?? '';
const toolNames = (): string[] =>
  [...document.querySelectorAll('.tool__name')].map((node) => node.textContent ?? '');

/** Answer once remotely, then regenerate on the device. */
async function remoteThenLocal(tool?: ToolInvocation): Promise<void> {
  script = [
    { text: 'REMOTE ANSWER', provenance: tool ? { ...REMOTE, toolEgress: 'granted' } : REMOTE, tool },
    { text: 'LOCAL ANSWER', provenance: ON_DEVICE },
  ];
  await useChats.getState().send('hello');
  await useChats.getState().regenerate(assistantRow().id);
}

/* ── The chip ────────────────────────────────────────────────────────── */

describe('the chip is the displayed generation’s, not the row’s', () => {
  it('marks a remote reply Remote through a whole cycle, and back', async () => {
    await remoteThenLocal();

    await mounted(createElement(LiveMessage), async () => {
      expect(bodyText()).toBe('LOCAL ANSWER');
      expect(chips()).toEqual(['On device']);
      expect(chipClasses()).toEqual(['chip chip--local']);
      expect(who()).toBe(ON_DEVICE.modelName);
      expect(counter()).toBe('2/2');

      await act(async () => {
        byLabel('Previous version').click();
      });

      // The measurement the judge took: this used to read "On device".
      expect(bodyText()).toBe('REMOTE ANSWER');
      expect(chips(), 'the reply from a provider is not under the ember flame').toEqual(['Remote']);
      expect(chipClasses()).toEqual(['chip chip--remote']);
      expect(who()).toBe(REMOTE.modelName);
      expect(counter()).toBe('1/2');

      await act(async () => {
        byLabel('Next version').click();
      });

      expect(bodyText()).toBe('LOCAL ANSWER');
      expect(chips(), 'and the on-device reply is still on-device').toEqual(['On device']);
      expect(who()).toBe(ON_DEVICE.modelName);
    });
  });

  it('moves the record of consent with the turn it was given for', async () => {
    // The tool-egress chip is a per-message record of a decision the user made
    // once: output from `bash` may go to this provider. It has to describe the
    // generation on screen — leaving "carried 1 tool result" over a local reply
    // that sent nothing is a false accusation, and dropping it from the remote
    // reply that DID send is the more dangerous half.
    await remoteThenLocal(TOOL);

    await mounted(createElement(LiveMessage), async () => {
      expect(bodyText()).toBe('LOCAL ANSWER');
      expect(chips(), 'the local turn ran no tool and sent nothing').toEqual(['On device']);
      expect(egressTitle()).toBe('');
      expect(toolNames()).toEqual([]);

      await act(async () => {
        byLabel('Previous version').click();
      });

      expect(chips()).toEqual(['Remote', 'carried 1 tool result']);
      expect(egressTitle()).toBe(
        'Tool output from bash was sent to OpenAI · gpt-4o-mini, because you allowed it for this conversation. Expand the tool block below to see exactly what.',
      );
      expect(toolNames(), 'and the block the tooltip points at is there too').toEqual(['bash']);

      await act(async () => {
        byLabel('Next version').click();
      });

      expect(chips(), 'the consent chip does not follow you to the turn it is not about').toEqual([
        'On device',
      ]);
      expect(toolNames()).toEqual([]);
    });
  });

  it('says nothing at all about a generation whose origin was never recorded', async () => {
    // What the v4 upgrade recovers from a chat saved by today's build: text,
    // and no record of where it ran. Absent must render as absent — the
    // plausible guess is the falsehood this whole change exists to prevent.
    await mounted(
      fixedMessage({
        id: 'm1',
        chatId: 'c1',
        role: 'assistant',
        content: 'RECOVERED ANSWER',
        createdAt: 1,
        variants: [
          { content: 'RECOVERED ANSWER', unrecorded: true },
          { content: 'LOCAL ANSWER', provenance: ON_DEVICE, stats: { tokensPerSecond: 42 } },
        ],
        variantIndex: 0,
      }),
      () => {
        expect(bodyText()).toBe('RECOVERED ANSWER');
        expect(chips(), 'no chip is invented').toEqual([]);
        expect(who(), 'and no model is named beside words it may not have written').toBe(
          'Assistant',
        );
        expect(head(), 'nor is the neighbouring generation’s speed claimed for it').toBe(
          'Assistant',
        );
        expect(counter()).toBe('1/2');
      },
    );
  });

  it('describes the generation being made while it is still streaming', async () => {
    // A regenerated turn in flight: its record has not been appended yet and
    // `variantIndex` points one past the end, at the row itself.
    await mounted(
      fixedMessage({
        id: 'm1',
        chatId: 'c1',
        role: 'assistant',
        content: 'HALF AN ANS',
        createdAt: 1,
        streaming: true,
        provenance: REMOTE,
        variants: [{ content: 'LOCAL ANSWER', provenance: ON_DEVICE }],
        variantIndex: 1,
      }),
      () => {
        expect(bodyText()).toBe('HALF AN ANS');
        expect(chips(), 'the turn being made now is the one described').toEqual(['Remote']);
        expect(who()).toBe(REMOTE.modelName);
        expect(document.querySelector('.msg__foot'), 'and nothing is cyclable mid-flight').toBeNull();
      },
    );
  });

  it('still shows the reply if a row arrives without the v4 upgrade', async () => {
    // Through v3 this list held bare strings. The Dexie upgrade that rewrites
    // them is the one part of this change that has never been executed —
    // there is no IndexedDB here to run it in — so the renderer does not
    // assume it did. An empty message would be a worse failure than the
    // mislabelled chip this whole change is about.
    await mounted(
      fixedMessage({
        id: 'm1',
        chatId: 'c1',
        role: 'assistant',
        content: 'LOCAL ANSWER',
        provenance: ON_DEVICE,
        createdAt: 1,
        variants: ['REMOTE ANSWER'] as unknown as Message['variants'],
        variantIndex: 0,
      }),
      () => {
        expect(bodyText(), 'the words are on screen').toBe('LOCAL ANSWER');
        expect(chips()).toEqual(['On device']);
      },
    );

    const transcript = renderTranscript({ title: 'T', updatedAt: 0 }, [
      {
        role: 'assistant',
        content: 'LOCAL ANSWER',
        provenance: ON_DEVICE,
        createdAt: 1,
        variants: ['REMOTE ANSWER'] as unknown as { content: string }[],
        variantIndex: 0,
      },
    ]);
    expect(transcript).toContain('## Qwen3 4B Instruct (on device)\n\nLOCAL ANSWER');
  });

  it('follows the generation even when the row disagrees with it', async () => {
    // The shape a writer that forgot `applyVariant` would leave behind. The
    // renderer no longer has an opinion of its own to be wrong with.
    await mounted(
      fixedMessage({
        id: 'm1',
        chatId: 'c1',
        role: 'assistant',
        content: 'LOCAL ANSWER',
        provenance: ON_DEVICE,
        stats: { tokensPerSecond: 42 },
        toolCalls: [TOOL],
        createdAt: 1,
        variants: [
          { content: 'REMOTE ANSWER', provenance: REMOTE },
          { content: 'LOCAL ANSWER', provenance: ON_DEVICE },
        ],
        variantIndex: 0,
      }),
      () => {
        expect(bodyText()).toBe('REMOTE ANSWER');
        expect(chips()).toEqual(['Remote']);
        expect(who()).toBe(REMOTE.modelName);
        expect(head(), 'the row’s speed readout is not borrowed either').not.toContain('42.0 tok/s');
        expect(toolNames(), 'nor the row’s tool block').toEqual([]);
      },
    );
  });
});

/* ── The transcript ──────────────────────────────────────────────────── */

describe('the transcript writes down the reply it is printing', () => {
  it('names the model that produced the text under the heading', async () => {
    await remoteThenLocal();
    await useChats.getState().cycleVariant(assistantRow().id, -1);

    const transcript = renderTranscript(
      useChats.getState().chats[0]!,
      useChats.getState().messages,
    );

    expect(transcript).toContain('## OpenAI · gpt-4o-mini (remote)\n\nREMOTE ANSWER');
    expect(transcript, 'the local model does not sign a remote reply').not.toContain(
      'Qwen3 4B Instruct',
    );
    expect(transcript).not.toMatch(/\(on device\)\n\nREMOTE ANSWER/);
  });

  it('leaves the heading bare when the origin was never recorded', () => {
    const transcript = renderTranscript({ title: 'T', updatedAt: 0 }, [
      {
        role: 'assistant',
        content: 'RECOVERED ANSWER',
        createdAt: 1,
        variants: [{ content: 'RECOVERED ANSWER' }, { content: 'LOCAL', provenance: ON_DEVICE }],
        variantIndex: 0,
      },
    ]);

    expect(transcript).toContain('## Assistant\n\nRECOVERED ANSWER');
    expect(transcript).not.toContain('(on device)');
    expect(transcript).not.toContain('(remote)');
  });

  it('follows the generation even when the row disagrees with it', () => {
    const transcript = renderTranscript({ title: 'T', updatedAt: 0 }, [
      {
        role: 'assistant',
        content: 'LOCAL ANSWER',
        provenance: ON_DEVICE,
        createdAt: 1,
        variants: [
          { content: 'REMOTE ANSWER', provenance: REMOTE },
          { content: 'LOCAL ANSWER', provenance: ON_DEVICE },
        ],
        variantIndex: 0,
      },
    ]);

    expect(transcript).toContain('## OpenAI · gpt-4o-mini (remote)\n\nREMOTE ANSWER');
    expect(transcript).not.toContain('LOCAL ANSWER');
  });

  it('is what the exported file actually contains', async () => {
    // Not `renderTranscript` again: `buildTranscript` is the function the
    // download button reaches, and it reads the rows back out of `db.messages`
    // — which is where `cycleVariant` wrote the projection.
    await remoteThenLocal();
    await useChats.getState().cycleVariant(assistantRow().id, -1);
    tables.rows = useChats.getState().messages;

    // Pinned rather than `Date.now()`: the header stamps
    // `new Date(chat.updatedAt).toISOString().slice(0, 10)`, so a live clock
    // makes this assertion pass only on the day it was written. It did exactly
    // that — green on the 2nd, red on the 3rd. `Date.UTC` keeps it stable in
    // every timezone, unlike a local-midnight epoch.
    const file = await buildTranscript({
      ...useChats.getState().chats[0]!,
      updatedAt: Date.UTC(2026, 8, 2),
    });

    expect(file).toBe(
      [
        '# hello',
        '',
        '_2 messages · last updated 2026-09-02_',
        '',
        '## You',
        '',
        'hello',
        '',
        '## OpenAI · gpt-4o-mini (remote)',
        '',
        'REMOTE ANSWER',
        '',
      ].join('\n'),
    );
  });
});
