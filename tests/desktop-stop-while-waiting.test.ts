import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { GenerateOptions, GenerationEndEvent } from '@chatterang/contracts';
import {
  HostFleet,
  LLAMA_ENGINE,
  LLAMA_PLUGIN,
  LOCAL_TURNS_PLUGIN,
  PluginHost,
  WorkBroker,
  admitLocalTurns,
  localTurnNotices,
  withTurnProgress,
} from '@chatterang/desktop/bridge';
import type {
  HostCall,
  HostMessage,
  NotifyListeners,
  Owner,
  SupervisorTimers,
  UnitEnd,
} from '@chatterang/desktop/bridge';

/**
 * STOP AND THE SHARED SLOT, FROM THE COMPOSER TO THE HOST (#7, #305).
 *
 * #305 made Stop end every running turn and refused a second turn while one
 * runs. #7's shared admission made a desktop turn wait for the slot it shares
 * with a paired phone. Each has its own tests; this file drives the two
 * together, because a turn WAITING for the slot is a running turn to the chat
 * store and no turn at all to the host:
 *
 *   - Stop pressed while it waits takes it out of the wait list, settles it as
 *     stopped, never starts it later, and leaves nothing that holds the
 *     window's next turn back;
 *   - Stop pressed while the page is still subscribing to hear it wait sends
 *     no generate at all;
 *   - a second turn the store refuses neither takes the slot nor queues for it;
 *   - and the rail hears nothing about a stopped turn's place in line, but
 *     still hears its start, which is what takes "Waiting" off the rail.
 *
 * Every layer between them is production code: the real chat store and
 * `ChatterangEngine` with its `LlamaCppBackendAdapter`, over a `LlamaCpp` that
 * is the real `PluginHost` as window 1 would reach it, with the real
 * `admitLocalTurns`, `WorkBroker`, `HostFleet` and `Supervisor` behind it. Only
 * the llama host answers on command, the clock is the test's, and the
 * database is held in memory at the table boundary. A phone's unit is admitted
 * to the broker directly: no listener exists (#169), and none is started.
 */

type Row = { id: string; chatId?: string; createdAt?: number };

const fake = vi.hoisted(() => {
  const chats = new Map<string, Row>();
  const messages = new Map<string, Row>();
  const clone = <T>(value: T): T => structuredClone(value);
  const threadOf = (chatId: string): Row[] =>
    [...messages.values()]
      .filter((row) => row.chatId === chatId)
      .map(clone)
      .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
  const db = {
    chats: {
      put: vi.fn(async (chat: Row) => void chats.set(chat.id, clone(chat))),
      delete: vi.fn(async (id: string) => void chats.delete(id)),
      orderBy: () => ({ reverse: () => ({ toArray: async () => [...chats.values()].map(clone) }) }),
    },
    messages: {
      put: vi.fn(async (message: Row) => void messages.set(message.id, clone(message))),
      delete: vi.fn(async (id: string) => void messages.delete(id)),
      where: () => ({
        equals: (chatId: string) => ({ sortBy: async () => threadOf(chatId), toArray: async () => threadOf(chatId) }),
      }),
    },
    blobs: { get: async () => undefined, bulkDelete: vi.fn(async () => {}) },
    models: { put: vi.fn(async () => {}), delete: vi.fn(async () => {}), toArray: async () => [] },
    settings: { get: vi.fn(async () => undefined), put: vi.fn(async () => {}) },
    connections: { put: vi.fn(async () => {}), delete: vi.fn(async () => {}), toArray: async () => [] },
  };
  return {
    db,
    chats,
    messages,
    reset: (): void => {
      chats.clear();
      messages.clear();
    },
  };
});

vi.mock('@/db', () => ({
  db: fake.db,
  deleteChat: vi.fn(async () => {}),
  readSetting: async (_key: string, fallback: unknown) => fallback,
  writeSetting: vi.fn(async () => {}),
}));

/** The `LlamaCpp` the page calls: whatever the test wired, method by method. */
const plugin = vi.hoisted(() => ({
  current: null as Record<string, (...args: never[]) => unknown> | null,
}));

vi.mock('@/plugins/llama-cpp', () => ({
  LlamaCpp: new Proxy(
    {},
    {
      get: (_target, name) => {
        if (typeof name !== 'string' || name === 'then') return undefined;
        return (...args: never[]) => {
          const method = plugin.current?.[name];
          if (method === undefined) return Promise.reject(new Error(`LlamaCpp.${name} is not wired here.`));
          return method(...args);
        };
      },
    },
  ),
}));

const { useChats } = await import('@/state/chat');
const { useModels } = await import('@/state/models');
const { useApp } = await import('@/state/app');
const { catalogEntry } = await import('@/data/catalog');
const { DEFAULT_SAMPLER } = await import('@/domain/manifest');
const { ChatterangEngine } = await import('@/ai/engine');
const { probeResolver } = await import('./support/egress-probe');
const { toolRegistry } = await import('@/ai/tools/registry');

type Chat = import('@/domain/chat').Chat;
type Message = import('@/domain/chat').Message;

const QWEN = catalogEntry('qwen3-4b-instruct-q4km')!;
/** The desktop window this page is, as main keys it. */
const WINDOW = 1;
const OWNER: Owner = { kind: 'window', id: WINDOW };
/** The paired phone whose units are admitted straight to the broker. */
const PHONE: Owner = { kind: 'device', id: 'phone' };

/* ── Waiting ─────────────────────────────────────────────────────────── */

const macrotask = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
const settle = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 5));
};

async function until(condition: () => boolean): Promise<void> {
  for (let tries = 0; tries < 400; tries += 1) {
    if (condition()) return;
    await macrotask();
  }
  throw new Error('the condition never held');
}

function held(): { promise: Promise<void>; release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

/* ── Main, with a llama host that answers on command ─────────────────── */

function manualClock(): SupervisorTimers {
  return { now: () => 0, every: () => () => undefined, after: () => () => undefined };
}

function endOf(requestId: string, stopReason: GenerationEndEvent['stopReason'] = 'stop'): GenerationEndEvent {
  return {
    requestId,
    text: stopReason === 'stop' ? 'the answer' : '',
    promptTokens: 1,
    cachedTokens: 0,
    completionTokens: 1,
    ttftMs: 1,
    totalMs: 1,
    tokensPerSecond: 1,
    stopReason,
  };
}

function desktop() {
  const posted: HostMessage[] = [];
  const hostListeners: ((message: unknown) => void)[] = [];
  const hostSend = (message: HostMessage): void => {
    for (const listener of hostListeners) listener(message);
  };

  /** The page's listeners, by the subscription id it chose. */
  const pageListeners = new Map<number, (event: unknown) => void>();
  /** While `held`, `llamaWaiting` events main sent are still on their way to the page. */
  const waitingInFlight = { held: false, pending: [] as (() => void)[] };
  const pluginHost = new PluginHost((senderId, payload) => {
    const listener = senderId === WINDOW ? pageListeners.get(payload.subscriptionId) : undefined;
    if (listener === undefined) return false;
    // An IPC message: cloned, and delivered after the send returns.
    const data = structuredClone(payload.data);
    if (waitingInFlight.held && payload.eventName === 'llamaWaiting') {
      waitingInFlight.pending.push(() => listener(data));
      return true;
    }
    queueMicrotask(() => listener(data));
    return true;
  });
  const notify: NotifyListeners = (pluginName, eventName, data, ownerId) =>
    pluginHost.notifyListeners(pluginName, eventName, data, ownerId);

  // The construction order of main.ts. The broker's notifier is main's, seen
  // on the way through so a test can count the ends the broker decided.
  const notices = localTurnNotices(notify);
  const windowTerminals: { unitId: string; end: UnitEnd }[] = [];
  const broker = new WorkBroker({
    notifyWindow: (windowId, notice) => {
      if (notice.kind === 'terminal') windowTerminals.push({ unitId: notice.terminal.unitId, end: notice.terminal.end });
      return notices(windowId, notice);
    },
    timers: manualClock(),
  });
  const fleet = new HostFleet({
    spawn: () => ({
      link: {
        postMessage: (raw) => {
          const message = raw as HostMessage;
          posted.push(message);
          if (message.k === 'ping') hostSend({ k: 'pong', id: message.id });
          if (message.k === 'call' && message.method !== 'generate') {
            hostSend({ k: 'ret', id: message.id, ok: true, data: null });
          }
        },
        onMessage: (listener) => hostListeners.push(listener),
        onClose: () => undefined,
      },
      kill: () => undefined,
    }),
    notify: withTurnProgress(broker, notify),
    entries: [{ engine: LLAMA_ENGINE, host: 'llama' }],
    warn: () => undefined,
    timers: manualClock(),
  });
  const localTurns = admitLocalTurns({ broker, facade: fleet.plugin(LLAMA_PLUGIN.name), fleet, notices, notify });
  pluginHost.register(LOCAL_TURNS_PLUGIN, localTurns.plugin);

  const hostCalls = (method: string): HostCall[] =>
    posted.filter((message): message is HostCall => message.k === 'call' && message.method === method);
  const generateCalls = (): HostCall[] => hostCalls('generate');
  /** Host calls already answered, so each decode of a turn is answered by its own call. */
  const answered = new Set<number>();
  const unanswered = (requestId: string): HostCall | undefined =>
    generateCalls().find(
      (entry) => (entry.args[0] as GenerateOptions).requestId === requestId && !answered.has(entry.id),
    );

  const state = {
    broker,
    localTurns,
    /** requestIds this page asked main to generate, in order, once per decode. */
    asked: [] as string[],
    /** What the page sent with each generate, in order. */
    pageOptions: [] as unknown[],
    /** requestIds this page ended its turn for, in order. */
    ended: [] as string[],
    /** Set once the window is gone: nothing the page calls reaches main. */
    gone: false,
    /** Set `held` to keep `llamaWaiting` events on their way to the page; deliver `pending` to let them arrive. */
    waitingInFlight,
    /** Set to hold the page's `llamaWaiting` subscription open. */
    holdWaiting: null as Promise<void> | null,
    subscribingToWaiting: false,
    /** requestIds the llama host itself was asked to generate, in order, once per decode. */
    generated: (): string[] => generateCalls().map((call) => (call.args[0] as GenerateOptions).requestId),
    /** requestIds the llama host was asked to cancel, in order. */
    cancelledOnHost: (): string[] => hostCalls('cancel').map((call) => (call.args[0] as { requestId: string }).requestId),
    /** How many benchmarks reached the llama host. */
    benchmarksOnHost: (): number => hostCalls('benchmark').length,
    /** Every end the broker decided for one of this window's units, in order. */
    terminals: (unitId: string): UnitEnd[] =>
      windowTerminals.filter((terminal) => terminal.unitId === unitId).map((terminal) => terminal.end),
    /** A benchmark from this window, as the Benchmarks screen asks for one. */
    benchmark: (): Promise<unknown> => pluginHost.invoke(WINDOW, LLAMA_PLUGIN.name, 'benchmark', [{ handle: 'h1' }]),
    /** An end for this window's turn that main receives, whoever sent it. */
    lateEnd: (requestId: string): Promise<unknown> =>
      pluginHost.invoke(WINDOW, LLAMA_PLUGIN.name, 'endTurn', [{ requestId }]),
    /**
     * The host ends a turn's oldest unanswered decode the way LlamaCppNode does:
     * what it said, its event, then its return.
     */
    finish(requestId: string, text?: string, stopReason: GenerationEndEvent['stopReason'] = 'stop'): void {
      const call = unanswered(requestId);
      if (call === undefined) return;
      answered.add(call.id);
      if (text !== undefined) {
        hostSend({ k: 'ev', plugin: LLAMA_PLUGIN.name, name: 'llamaToken', data: { requestId, token: text, index: 0 } });
      }
      hostSend({ k: 'ev', plugin: LLAMA_PLUGIN.name, name: 'llamaEnd', data: endOf(requestId, stopReason) });
      hostSend({ k: 'ret', id: call.id, ok: true, data: endOf(requestId, stopReason) });
    },
    /** The host refuses a turn's oldest unanswered decode. */
    fail(requestId: string, message: string): void {
      const call = unanswered(requestId);
      if (call === undefined) return;
      answered.add(call.id);
      hostSend({ k: 'ret', id: call.id, ok: false, error: { message } });
    },
    /** A paired phone's unit holding or waiting for the slot, admitted straight to the broker. */
    phoneTurn(unitId: string): { resolve: () => void; readonly starts: number } {
      let resolve: () => void = () => undefined;
      let starts = 0;
      const admission = broker.admit({
        owner: PHONE,
        unitId,
        executor: 'worker',
        start: () => {
          starts += 1;
          return new Promise<unknown>((done) => {
            resolve = () => done('the phone’s answer');
          });
        },
      });
      if (!admission.admitted) throw new Error(`phone unit refused: ${admission.refusal}`);
      return {
        resolve: () => resolve(),
        get starts() {
          return starts;
        },
      };
    },
  };

  let subscriptionId = 1;
  plugin.current = {
    load: async () => ({
      handle: 'h1',
      backend: 'cpu',
      contextLength: 4096,
      loadMs: 1,
      warnings: [],
      supportsVision: false,
      chatTemplate: 'chatml',
    }),
    unload: async () => undefined,
    generate: (options: GenerateOptions) => {
      if (state.gone) return Promise.reject(new Error('The window is gone.'));
      state.asked.push(options.requestId);
      state.pageOptions.push(structuredClone(options));
      return pluginHost.invoke(WINDOW, LLAMA_PLUGIN.name, 'generate', [options]);
    },
    cancel: (options: { requestId: string }) =>
      state.gone
        ? Promise.reject(new Error('The window is gone.'))
        : pluginHost.invoke(WINDOW, LLAMA_PLUGIN.name, 'cancel', [options]),
    endTurn: (options: { requestId: string }) => {
      if (state.gone) return Promise.reject(new Error('The window is gone.'));
      state.ended.push(options.requestId);
      return pluginHost.invoke(WINDOW, LLAMA_PLUGIN.name, 'endTurn', [options]);
    },
    addListener: async (eventName: string, listener: (event: unknown) => void) => {
      if (eventName === 'llamaWaiting' && state.holdWaiting !== null) {
        state.subscribingToWaiting = true;
        await state.holdWaiting;
      }
      const id = subscriptionId++;
      pluginHost.addListener(WINDOW, LLAMA_PLUGIN.name, eventName, id);
      pageListeners.set(id, listener);
      return {
        remove: async () => {
          pluginHost.removeListener(WINDOW, id);
          pageListeners.delete(id);
        },
      };
    },
  } as unknown as Record<string, (...args: never[]) => unknown>;

  return state;
}

/* ── The page ─────────────────────────────────────────────────────────── */

function chat(id: string, tools: readonly string[] = []): Chat {
  return {
    id,
    title: id,
    mode: 'chat',
    personaId: null,
    modelId: QWEN.id,
    sampler: null,
    tools: [...tools],
    showThinking: false,
    createdAt: 1,
    updatedAt: 1,
    messageCount: 2,
    preview: '',
  };
}

/** Chats in the store and the table, each with one exchange on disk; the first is open. */
function given(...ids: string[]): void {
  givenWithTools([], ...ids);
}

/** As `given`, with these tools enabled in every chat. */
function givenWithTools(tools: readonly string[], ...ids: string[]): void {
  const threadOf = (id: string): Message[] => [
    { id: `${id}_user`, chatId: id, role: 'user', content: 'hello', createdAt: 1 },
    { id: `${id}_reply`, chatId: id, role: 'assistant', content: 'Hi.', createdAt: 2 },
  ];
  for (const id of ids) {
    fake.chats.set(id, structuredClone(chat(id, tools)));
    for (const row of threadOf(id)) fake.messages.set(row.id, structuredClone(row));
  }
  useChats.setState({
    loaded: true,
    chats: ids.map((id) => chat(id, tools)),
    activeChatId: ids[0] ?? null,
    messages: ids[0] === undefined ? [] : threadOf(ids[0]),
    generating: false,
    context: null,
  });
}

/** Every position the page heard, and whether Stop had been pressed by then. */
let heard: { requestId: string; position: number; afterStop: boolean }[] = [];
let stopped = false;

function stop(): void {
  stopped = true;
  useChats.getState().stop();
}

let main: ReturnType<typeof desktop>;

beforeEach(() => {
  fake.reset();
  heard = [];
  stopped = false;
  main = desktop();
  useModels.setState({
    loaded: true,
    activeModelId: QWEN.id,
    progress: {},
    storage: { used: 0, quota: 0 },
    installed: {
      [QWEN.id]: {
        id: QWEN.id,
        manifest: QWEN,
        state: 'installed',
        downloadedBytes: QWEN.sizeBytes,
        paths: { model: `/dev/${QWEN.id}` },
        sampler: { ...DEFAULT_SAMPLER },
        systemPrompt: '',
        installedAt: 1,
        lastUsedAt: null,
        useCount: 0,
      },
    },
  });
  const engine = new ChatterangEngine({
    resolver: probeResolver,
    fallbackBackendId: null,
    onWaiting: (event) => {
      heard.push({ ...event, afterStop: stopped });
      // The line `useApp.initialize` builds the engine with.
      useApp.getState().setTurnWaiting(event.position > 0 ? event.position : null);
    },
  });
  useApp.setState({ toasts: [], approvals: [], connections: [], turnWaiting: null, engine: engine as never });
});

/** Let whatever a failed assertion left running end, so no turn outlives its test. */
async function drainAll(phones: { resolve: () => void }[], turns: Promise<unknown>[]): Promise<void> {
  useChats.getState().stop();
  for (const phone of phones) phone.resolve();
  let settled = false;
  void Promise.allSettled(turns).then(() => {
    settled = true;
  });
  for (let rounds = 0; rounds < 100 && !settled; rounds += 1) {
    await settle();
    for (const requestId of main.generated()) main.finish(requestId);
  }
  await Promise.allSettled(turns);
}

describe('Stop and the shared slot (#7, #305)', () => {
  it('a turn waiting for the slot when Stop is pressed leaves the wait list, settles as stopped, never starts, and holds nothing back', async () => {
    given('stop_waiting', 'stop_waiting_next');
    const phone = main.phoneTurn('phone-1');
    const sending = useChats.getState().send('a question');
    let next: Promise<void> = Promise.resolve();
    try {
      await until(() => useApp.getState().turnWaiting === 1);
      const waiting = main.asked[0]!;
      expect(main.broker.positionOf(OWNER, waiting), 'waiting behind the phone').toBe(1);

      stop();
      await sending;

      // It left the wait list, and the chat treats it as a stopped turn.
      expect(main.broker.positionOf(OWNER, waiting), 'still in the broker').toBeUndefined();
      expect(main.broker.waitingCount).toBe(0);
      expect(useChats.getState().generating, 'a turn still running in the store').toBe(false);
      expect(useChats.getState().messages.filter((message) => message.streaming)).toEqual([]);
      expect(useApp.getState().turnWaiting, 'the rail still says waiting').toBeNull();

      // The slot frees, and the stopped turn never starts.
      phone.resolve();
      await settle();
      expect(main.generated(), 'generations the host was asked for').toEqual([]);
      expect(main.broker.slotCount).toBe(0);

      // It is not counted against the window: the next turn is first in line
      // and starts at once. Sent from another chat, because a turn stopped
      // before its first token leaves an empty reply in its own thread, which
      // the next request from that thread is refused for ("Message content
      // cannot be empty string"); that predates #7 and is not what is measured.
      await useChats.getState().openChat('stop_waiting_next');
      next = useChats.getState().send('another question');
      await until(() => main.generated().length === 1).catch(() => {
        throw new Error(
          `the next turn never reached the host: ${JSON.stringify({
            asked: main.asked,
            waiting: main.broker.waitingCount,
            slot: main.broker.slotCount,
            generating: useChats.getState().generating,
            toasts: useApp.getState().toasts.map((toast) => toast.message),
          })}`,
        );
      });
      expect(main.generated()).toEqual([main.asked[1]]);
      expect(main.broker.waitingCount).toBe(0);
      main.finish(main.asked[1]!);
      await next;

      expect(
        heard.filter((entry) => entry.requestId === waiting && entry.afterStop),
        'positions heard for the stopped turn after Stop',
      ).toEqual([]);
    } finally {
      await drainAll([phone], [sending, next]);
    }
    expect(useChats.getState().generating).toBe(false);
  });

  it('a turn stopped while the page is still subscribing to hear it wait sends no generate, and nothing starts later', async () => {
    given('stop_subscribing');
    const phone = main.phoneTurn('phone-2');
    const subscription = held();
    main.holdWaiting = subscription.promise;
    const sending = useChats.getState().send('a question');
    try {
      await until(() => main.subscribingToWaiting);
      stop();
      subscription.release();
      await until(() => main.asked.length > 0 || !useChats.getState().generating);
      await settle();

      expect(main.asked, 'generations asked of main after Stop').toEqual([]);
      expect(main.broker.waitingCount).toBe(0);
      phone.resolve();
      await settle();
      expect(main.generated()).toEqual([]);
      await sending;
      expect(useChats.getState().generating).toBe(false);
    } finally {
      subscription.release();
      await drainAll([phone], [sending]);
    }
  });

  it('a turn stopped after main started it, but before the page heard it start, takes "Waiting" off the rail when that start arrives', async () => {
    // A stopped turn can start in main before its cancel reaches main. Main
    // sends the page its start (position 0) and the host its generate; the
    // cancel then goes to the host, which decodes until it honours it.
    // FAULT INJECTED: dropping every `llamaWaiting` event after Stop, the start
    // included, left the rail saying "Waiting" until the stopped turn settled
    // ("the rail while the host stops the stopped turn: expected 1 to be null").
    given('stop_starting');
    const phone = main.phoneTurn('phone-4');
    const sending = useChats.getState().send('a question');
    try {
      await until(() => useApp.getState().turnWaiting === 1);
      const turn = main.asked[0]!;

      // The phone's turn ends and main starts this one. Its start is still on
      // its way to the page when Stop is pressed.
      main.waitingInFlight.held = true;
      phone.resolve();
      await until(() => main.generated().length === 1);
      stop();
      await until(() => main.cancelledOnHost().includes(turn));
      for (const deliver of main.waitingInFlight.pending.splice(0)) deliver();
      await settle();

      expect(useChats.getState().generating, 'the stopped turn is still settling').toBe(true);
      expect(useApp.getState().turnWaiting, 'the rail while the host stops the stopped turn').toBeNull();
      expect(
        heard.filter((entry) => entry.requestId === turn && entry.afterStop),
        'what the page heard about the stopped turn after Stop',
      ).toEqual([{ requestId: turn, position: 0, afterStop: true }]);

      main.finish(turn, undefined, 'cancelled');
      await sending;
      expect(useChats.getState().generating).toBe(false);
      expect(useApp.getState().turnWaiting).toBeNull();
    } finally {
      main.waitingInFlight.held = false;
      for (const deliver of main.waitingInFlight.pending.splice(0)) deliver();
      await drainAll([phone], [sending]);
    }
  });

  it('a second turn the store refuses neither takes the slot nor queues for it, whether the first waits or runs', async () => {
    given('second_turn');
    const phone = main.phoneTurn('phone-3');
    const sending = useChats.getState().send('a question');
    try {
      await until(() => main.broker.waitingCount === 1);

      // While the first waits.
      await useChats.getState().send('a second question');
      await useChats.getState().editMessage('second_turn_user', 'hello again');
      expect(main.asked, 'generations asked of main').toHaveLength(1);
      expect(main.broker.waitingCount, 'units waiting').toBe(1);
      expect(main.broker.slotCount, 'the phone alone holds the slot').toBe(1);

      // While the first runs.
      phone.resolve();
      await until(() => main.generated().length === 1);
      await useChats.getState().send('a third question');
      expect(main.asked).toHaveLength(1);
      expect(main.broker.slotCount).toBe(1);
      expect(main.broker.waitingCount).toBe(0);

      main.finish(main.asked[0]!);
      await sending;
      expect(main.broker.slotCount).toBe(0);
    } finally {
      await drainAll([phone], [sending]);
    }
  });
});

/* ── The whole turn holds the slot (#7, owner ruling) ────────────────── */

/** A local tool that runs until the test lets it return, or the turn is stopped. */
function slowTool(id: string) {
  let release: () => void = () => undefined;
  let calls = 0;
  const tool = {
    id,
    name: id,
    description: 'Runs until the test lets it return, or the turn is stopped.',
    summary: 'probe',
    parameters: { type: 'object' as const, properties: {} },
    execute: async (_input: Record<string, unknown>, context: { readonly signal?: AbortSignal }) => {
      calls += 1;
      await new Promise<void>((resolve) => {
        release = resolve;
        context.signal?.addEventListener('abort', () => resolve(), { once: true });
      });
      return { output: 'what the tool found' };
    },
  };
  return {
    tool,
    /** What the model says to call it. */
    call: `<tool_call>{"name":"${id}","arguments":{}}</tool_call>`,
    get calls(): number {
      return calls;
    },
    release: (): void => release(),
  };
}

type SlowTool = ReturnType<typeof slowTool>;

/**
 * A desktop turn in `chatId` that has decoded once, asked for `tool`, and is
 * running it: between two decodes of one turn.
 */
async function inItsToolCall(chatId: string, tool: SlowTool): Promise<{ sending: Promise<void>; turn: string }> {
  givenWithTools([tool.tool.id], chatId);
  const sending = useChats.getState().send('look it up');
  await until(() => main.generated().length === 1);
  const turn = main.asked[0]!;
  main.finish(turn, tool.call);
  await until(() => tool.calls === 1);
  return { sending, turn };
}

/** Undone after each test. */
let cleanups: (() => void)[] = [];

describe('a desktop turn holds the one slot for the whole turn, its tool calls included (#7)', () => {
  /*
   * OWNER RULING ON #7: a desktop turn keeps the WorkBroker's one slot from its
   * first decode until the turn settles (finished, failed, stopped, or
   * refused), tool calls included, and a phone turn waits for the whole desktop
   * turn. #169's "one turn at a time" is one turn, not one decode.
   */
  let tool: SlowTool;
  let sending: Promise<void>;
  let phones: { resolve: () => void }[];

  beforeEach(() => {
    tool = slowTool('look_up');
    toolRegistry.register(tool.tool);
    sending = Promise.resolve();
    phones = [];
    cleanups = [];
  });

  async function cleanUp(): Promise<void> {
    for (const cleanup of cleanups) cleanup();
    tool.release();
    await drainAll(phones, [sending]);
    toolRegistry.unregister(tool.tool.id);
  }

  it('a phone turn queued while the desktop turn runs its tool waits for the whole turn, and the turn’s next decode neither waits nor is told it waits', async () => {
    try {
      const started = await inItsToolCall('whole_turn', tool);
      sending = started.sending;
      const { turn } = started;
      const phone = main.phoneTurn('phone-q');
      phones.push(phone);
      expect(main.broker.positionOf(PHONE, 'phone-q'), 'the phone waits behind the desktop turn').toBe(1);

      tool.release();
      await until(() => main.generated().length === 2 || phone.starts > 0);
      expect(phone.starts, 'a phone turn ran between two decodes of one desktop turn').toBe(0);
      expect(main.generated(), 'the turn’s second decode reached the host at once').toEqual([turn, turn]);
      expect(main.broker.waitingCount).toBe(1);
      main.finish(turn, 'the answer');
      await sending;
      await settle();

      expect(heard.filter((entry) => entry.requestId === turn), 'waiting heard for the desktop turn').toEqual([]);
      expect(main.pageOptions.map((options) => (options as { wholeTurn?: unknown }).wholeTurn)).toEqual([true, true]);
      expect(main.ended, 'turns the page ended').toEqual([turn]);
      expect(main.terminals(turn)).toEqual(['COMPLETED']);
      expect(phone.starts, 'the phone started once the desktop turn was over').toBe(1);
      expect(main.broker.slotCount).toBe(1);
      expect(useChats.getState().messages.at(-1)).toMatchObject({ role: 'assistant', content: 'the answer' });
      expect(useChats.getState().generating).toBe(false);
    } finally {
      await cleanUp();
    }
  });

  const SETTLES: readonly {
    readonly name: string;
    /** Decodes the host is asked for in all. */
    readonly decodes: number;
    readonly settle: (turn: string) => Promise<void>;
  }[] = [
    {
      name: 'finishes',
      decodes: 2,
      settle: async (turn) => {
        tool.release();
        await until(() => main.generated().length === 2);
        main.finish(turn, 'the answer');
      },
    },
    {
      name: 'fails in the decode after its tool call',
      decodes: 2,
      settle: async (turn) => {
        tool.release();
        await until(() => main.generated().length === 2);
        main.fail(turn, 'The model stopped answering.');
      },
    },
    {
      name: 'fails while its tool call is being recorded',
      decodes: 1,
      settle: async () => {
        // The page's own handling of the tool's record throws, after the tool
        // has run and before the next decode: the turn fails in its tool phase.
        let thrown = false;
        cleanups.push(
          useChats.subscribe((state) => {
            if (thrown || !state.messages.some((message) => (message.toolCalls?.length ?? 0) > 0)) return;
            thrown = true;
            throw new Error('The thread could not be updated.');
          }),
        );
        tool.release();
      },
    },
    {
      name: 'is stopped during its tool call',
      decodes: 1,
      settle: async () => {
        stop();
      },
    },
    {
      name: 'is stopped during its second decode',
      decodes: 2,
      settle: async (turn) => {
        tool.release();
        await until(() => main.generated().length === 2);
        stop();
        await until(() => main.cancelledOnHost().includes(turn));
        main.finish(turn, undefined, 'cancelled');
      },
    },
  ];

  it.each(SETTLES.map((path) => [path.name, path] as const))(
    'a desktop turn that %s gives the slot back once, and not before it has settled',
    async (_name, { decodes, settle: settleTurn }) => {
      try {
        const started = await inItsToolCall('settles', tool);
        sending = started.sending;
        const { turn } = started;
        const phone = main.phoneTurn('phone-q');
        phones.push(phone);
        expect(main.broker.positionOf(PHONE, 'phone-q'), 'the phone waits behind the desktop turn').toBe(1);

        await settleTurn(turn);
        await sending;
        await settle();

        expect(useChats.getState().generating, 'a turn still running in the store').toBe(false);
        expect(main.generated(), 'decodes the host was asked for').toHaveLength(decodes);
        expect(main.ended, 'turns the page ended').toEqual([turn]);
        expect(main.terminals(turn), 'ends the broker decided for the desktop turn').toHaveLength(1);
        expect(main.broker.positionOf(OWNER, turn)).toBeUndefined();
        expect(phone.starts, 'the phone started once the desktop turn was over').toBe(1);

        // Given back once: a late end for the turn leaves the phone holding the
        // slot, with nothing waiting.
        await main.lateEnd(turn);
        expect(main.broker.isRunning(PHONE, 'phone-q')).toBe(true);
        expect(main.broker.slotCount).toBe(1);
        expect(main.broker.waitingCount).toBe(0);
      } finally {
        await cleanUp();
      }
    },
  );

  it('a desktop turn stopped while its first decode still waits never takes the slot, and its end gives nothing back', async () => {
    try {
      given('stopped_waiting');
      const phone = main.phoneTurn('phone-first');
      phones.push(phone);
      sending = useChats.getState().send('a question');
      await until(() => main.broker.waitingCount === 1);
      const turn = main.asked[0]!;

      stop();
      await sending;
      await settle();
      expect(main.terminals(turn)).toEqual(['CANCELLED']);
      expect(main.ended, 'turns the page ended').toEqual([turn]);
      expect(main.broker.isRunning(PHONE, 'phone-first')).toBe(true);
      expect(main.broker.slotCount).toBe(1);

      phone.resolve();
      await settle();
      expect(main.broker.slotCount).toBe(0);
      expect(main.generated()).toEqual([]);
    } finally {
      await cleanUp();
    }
  });

  it('a desktop turn whose window goes away during its tool call gives the slot back at once, and never decodes again', async () => {
    try {
      const started = await inItsToolCall('window_gone', tool);
      sending = started.sending;
      const { turn } = started;
      const phone = main.phoneTurn('phone-q');
      phones.push(phone);
      expect(main.broker.positionOf(PHONE, 'phone-q'), 'the phone waits behind the desktop turn').toBe(1);

      main.gone = true;
      main.localTurns.releaseRenderer(WINDOW, 'The window was closed.');
      await settle();
      expect(phone.starts, 'the phone waited for a window that is gone').toBe(1);
      expect(main.broker.positionOf(OWNER, turn)).toBeUndefined();

      tool.release();
      await sending;
      expect(main.generated()).toHaveLength(1);
      expect(main.broker.isRunning(PHONE, 'phone-q')).toBe(true);
      expect(main.broker.slotCount).toBe(1);
      expect(main.broker.waitingCount).toBe(0);
    } finally {
      await cleanUp();
    }
  });

  it('a second turn the store refuses while the desktop turn runs its tool neither takes the slot, nor queues for it, nor ends the turn holding it', async () => {
    try {
      const started = await inItsToolCall('refused_second', tool);
      sending = started.sending;
      const { turn } = started;
      const phone = main.phoneTurn('phone-q');
      phones.push(phone);
      expect(main.broker.positionOf(PHONE, 'phone-q'), 'the phone waits behind the desktop turn').toBe(1);

      await useChats.getState().send('a second question');
      await useChats.getState().editMessage('refused_second_user', 'hello again');
      expect(main.asked, 'generations asked of main').toHaveLength(1);
      expect(main.ended, 'turns the page ended').toEqual([]);
      expect(main.broker.waitingCount, 'units waiting').toBe(1);
      expect(main.broker.isRunning(OWNER, turn)).toBe(true);
      expect(main.broker.positionOf(PHONE, 'phone-q')).toBe(1);

      tool.release();
      await until(() => main.generated().length === 2);
      expect(phone.starts).toBe(0);
      main.finish(turn, 'the answer');
      await sending;
      await settle();
      expect(phone.starts).toBe(1);
    } finally {
      await cleanUp();
    }
  });

  it('a benchmark asked for while the desktop turn runs its tool is refused as busy, and runs once the turn is over', async () => {
    try {
      const started = await inItsToolCall('bench_between', tool);
      sending = started.sending;
      const { turn } = started;

      const refused = main.benchmark();
      void refused.catch(() => undefined);
      await settle();
      expect(main.benchmarksOnHost(), 'a benchmark reached the host between two decodes of a desktop turn').toBe(0);
      await expect(refused).rejects.toMatchObject({ code: 'SLOT_BUSY' });

      tool.release();
      await until(() => main.generated().length === 2);
      main.finish(turn, 'the answer');
      await sending;
      await settle();
      await expect(main.benchmark()).resolves.toBeNull();
      expect(main.benchmarksOnHost()).toBe(1);
    } finally {
      await cleanUp();
    }
  });
});
