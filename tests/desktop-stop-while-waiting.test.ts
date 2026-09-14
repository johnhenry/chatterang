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
import type { HostCall, HostMessage, NotifyListeners, Owner, SupervisorTimers } from '@chatterang/desktop/bridge';

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
 *   - and the rail hears nothing about a stopped turn's place in line.
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

type Chat = import('@/domain/chat').Chat;
type Message = import('@/domain/chat').Message;

const QWEN = catalogEntry('qwen3-4b-instruct-q4km')!;
/** The desktop window this page is, as main keys it. */
const WINDOW = 1;
const OWNER: Owner = { kind: 'window', id: WINDOW };

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

function endOf(requestId: string): GenerationEndEvent {
  return {
    requestId,
    text: 'the answer',
    promptTokens: 1,
    cachedTokens: 0,
    completionTokens: 1,
    ttftMs: 1,
    totalMs: 1,
    tokensPerSecond: 1,
    stopReason: 'stop',
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
  const pluginHost = new PluginHost((senderId, payload) => {
    const listener = senderId === WINDOW ? pageListeners.get(payload.subscriptionId) : undefined;
    if (listener === undefined) return false;
    // An IPC message: cloned, and delivered after the send returns.
    const data = structuredClone(payload.data);
    queueMicrotask(() => listener(data));
    return true;
  });
  const notify: NotifyListeners = (pluginName, eventName, data, ownerId) =>
    pluginHost.notifyListeners(pluginName, eventName, data, ownerId);

  // The construction order of main.ts.
  const notices = localTurnNotices(notify);
  const broker = new WorkBroker({ notifyWindow: notices, timers: manualClock() });
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

  const generateCalls = (): HostCall[] =>
    posted.filter((message): message is HostCall => message.k === 'call' && message.method === 'generate');

  const state = {
    broker,
    /** requestIds this page asked main to generate, in order. */
    asked: [] as string[],
    /** Set to hold the page's `llamaWaiting` subscription open. */
    holdWaiting: null as Promise<void> | null,
    subscribingToWaiting: false,
    /** requestIds the llama host itself was asked to generate, in order. */
    generated: (): string[] => generateCalls().map((call) => (call.args[0] as GenerateOptions).requestId),
    finished: new Set<string>(),
    /** The host ends a generation the way LlamaCppNode does: its event, then its return. */
    finish(requestId: string): void {
      const call = generateCalls().find((entry) => (entry.args[0] as GenerateOptions).requestId === requestId);
      if (call === undefined || state.finished.has(requestId)) return;
      state.finished.add(requestId);
      hostSend({ k: 'ev', plugin: LLAMA_PLUGIN.name, name: 'llamaEnd', data: endOf(requestId) });
      hostSend({ k: 'ret', id: call.id, ok: true, data: endOf(requestId) });
    },
    /** A paired phone's unit holding or waiting for the slot, admitted straight to the broker. */
    phoneTurn(unitId: string): { resolve: () => void } {
      let resolve: () => void = () => undefined;
      const admission = broker.admit({
        owner: { kind: 'device', id: 'phone' },
        unitId,
        executor: 'worker',
        start: () =>
          new Promise<unknown>((done) => {
            resolve = () => done('the phone’s answer');
          }),
      });
      if (!admission.admitted) throw new Error(`phone unit refused: ${admission.refusal}`);
      return { resolve: () => resolve() };
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
      state.asked.push(options.requestId);
      return pluginHost.invoke(WINDOW, LLAMA_PLUGIN.name, 'generate', [options]);
    },
    cancel: (options: { requestId: string }) => pluginHost.invoke(WINDOW, LLAMA_PLUGIN.name, 'cancel', [options]),
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

function chat(id: string): Chat {
  return {
    id,
    title: id,
    mode: 'chat',
    personaId: null,
    modelId: QWEN.id,
    sampler: null,
    tools: [],
    showThinking: false,
    createdAt: 1,
    updatedAt: 1,
    messageCount: 2,
    preview: '',
  };
}

/** Chats in the store and the table, each with one exchange on disk; the first is open. */
function given(...ids: string[]): void {
  const threadOf = (id: string): Message[] => [
    { id: `${id}_user`, chatId: id, role: 'user', content: 'hello', createdAt: 1 },
    { id: `${id}_reply`, chatId: id, role: 'assistant', content: 'Hi.', createdAt: 2 },
  ];
  for (const id of ids) {
    fake.chats.set(id, structuredClone(chat(id)));
    for (const row of threadOf(id)) fake.messages.set(row.id, structuredClone(row));
  }
  useChats.setState({
    loaded: true,
    chats: ids.map(chat),
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
