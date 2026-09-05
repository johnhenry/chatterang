/**
 * EVERY SENTENCE ON THE MODEL-SELECTION JOURNEY, COLLECTED FROM THE SURFACE
 * THAT SHIPS IT, AND CHECKED AGAINST A MEASUREMENT.
 *
 * `tests/bench-copy.test.ts` established the method and it is a good one: it
 * collects the sentences from the running app rather than grepping source, and
 * checks them against a fact it measures. Its reach was one path — the
 * benchmark refusal — and the rule it enforces ("NAME THE KIND, DO NOT PROMISE
 * THE FEATURE") is stated for every other surface only as a comment.
 *
 * Four rounds of repair produced four false sentences, and every one of them
 * lived in the set no collector reached:
 *
 *   1. the benchmark trio  — "runs on a different engine"          (a RUN claim)
 *   2. the persona hint    — "the active one is used instead"      (a DESTINATION claim)
 *   3. the persona hint    — "nothing to send to"                  (a DESTINATION claim)
 *   4. the onboarding note — "the smallest model available"        (a COMPARATIVE claim)
 *
 * Only the first is a run claim. So a regex list of banned verbs was never
 * going to be enough, and two more families are enforced here:
 *
 *   · DESTINATION. In a privacy-first app the highest-stakes thing the UI says
 *     is where a turn goes. No regex can decide that, so nothing here tries:
 *     each arrangement DISPATCHES A REAL TURN through the real `newChat`,
 *     `resolveTarget` and `send` with a recording engine, and the sentences
 *     that arrangement shows are then judged against the target the app
 *     actually chose. "Stays here" only over a local target; "goes to X" only
 *     where X is the connection that was really handed the turn; "nothing will
 *     be sent" only where the engine was never called.
 *
 *   · MEASURED CLAIMS. A superlative or an existence claim ("the smallest",
 *     "only measures", "nothing installed can") must match an entry in
 *     `MEASURED_CLAIMS`, each of which carries a verifier that is executed
 *     against the catalogue or the store. THE DEFAULT IS REFUSAL: a sentence
 *     that makes such a claim with nothing measuring it fails, and the failure
 *     names the ledger it has to be added to.
 *
 * Underneath both sits the blunt instrument that makes a fifth round expensive:
 * `INVENTORY` pins every collected sentence verbatim. Editing any copy on this
 * journey — or adding a surface to the collector — reddens this file first, in
 * front of the rules, which is the whole point.
 *
 * Nothing here reads source text. Where rendering is what produces the
 * sentence, it is rendered (react-dom + `act`) and read out of the DOM.
 */

import { createElement } from 'react';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { InstalledModel } from '@/db';
import type { Chat, Message, Provenance } from '@/domain/chat';
import type { ModelManifest } from '@/domain/manifest';
import type { Persona } from '@/domain/persona';
import type { ProviderConnection } from '@/ai/providers';
import type { DeviceCapabilities } from '@chatterang/contracts';
import type { ShellStores } from '@/shell/commands';

/* ── The database and the transfer, stubbed at their boundaries ─────── */

const tables = vi.hoisted(() => ({
  models: { put: vi.fn(async () => {}), delete: vi.fn(async () => {}), toArray: async () => [] },
  settings: { get: vi.fn(async () => undefined), put: vi.fn(async () => {}) },
  chats: { put: vi.fn(async () => {}), delete: vi.fn(async () => {}), toArray: async () => [] },
  messages: {
    put: vi.fn(async () => {}),
    delete: vi.fn(async () => {}),
    where: () => ({ equals: () => ({ sortBy: async () => [], toArray: async () => [] }) }),
  },
  personas: { put: vi.fn(async () => {}), delete: vi.fn(async () => {}), toArray: async () => [] },
  benchmarks: {
    put: vi.fn(async () => {}),
    delete: vi.fn(async () => {}),
    clear: vi.fn(async () => {}),
    orderBy: () => ({ reverse: () => ({ toArray: async () => [] }) }),
  },
  connections: { put: vi.fn(async () => {}), delete: vi.fn(async () => {}), toArray: async () => [] },
}));

vi.mock('@/db', () => ({
  db: tables,
  deleteChat: vi.fn(async () => {}),
  readSetting: async (_key: string, fallback: unknown) => fallback,
  writeSetting: vi.fn(async () => {}),
}));

/** Recording, not throwing: reaching the GGUF loader must be visible, not fatal. */
vi.mock('@/plugins/llama-cpp', () => ({
  LlamaCpp: {
    load: vi.fn(async () => ({ handle: 'h1', backend: 'cpu' })),
    benchmark: vi.fn(async () => ({
      backend: 'cpu' as const,
      promptTokensPerSecond: 210.5,
      generateTokensPerSecond: 24.25,
      peakMemoryBytes: 3_000_000_000,
      thermalBefore: { level: 0.2 },
      thermalAfter: { level: 0.4 },
      samples: [24.1],
      repetitions: 1,
    })),
    unload: vi.fn(async () => {}),
  },
}));

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');

const { useApp } = await import('@/state/app');
const { useBench } = await import('@/state/bench');
const { useChats } = await import('@/state/chat');
const { useModels, chatModels } = await import('@/state/models');
const { usePersonas } = await import('@/state/personas');
const { CATALOG, catalogEntry } = await import('@/data/catalog');
const {
  BENCHMARKABLE_ENGINES,
  DEFAULT_SAMPLER,
  canChat,
  formatBytes,
  benchmarkableEngineList,
  nonBenchmarkableReason,
  nonChatRole,
} = await import('@/domain/manifest');
const { recommendModel } = await import('@/domain/onboarding');
const { chatterangCommands, renderTranscript } = await import('@/shell/commands');
const { upgradeVariants } = await import('@/db/variants');
const { ranOnDevice, REACH_DEVICE } = await import('@/domain/chat');

const { ChatScreen, orphanOption, pickerEmptyCopy, refusalCopy, startProse, startStateCopy } =
  await import('@/features/chat/ChatScreen');
const { MessageView } = await import('@/features/chat/MessageView');
const { PersonaEditor } = await import('@/features/personas/PersonaEditor');
const { ModelDetail } = await import('@/features/models/ModelDetail');
const { ModelsScreen } = await import('@/features/models/ModelsScreen');
const { BenchScreen } = await import('@/features/models/BenchScreen');
const { Onboarding, fitNote } = await import('@/features/onboarding/Onboarding');

/* ── The models and the provider, straight from the shipped data ────── */

/** The model in the report: speech in, no chat, and an engine this build lacks. */
const WHISPER = catalogEntry('whisper-tiny-en-onnx')!;
/** A model llama.cpp really does run. */
const QWEN = catalogEntry('qwen3-4b-instruct-q4km')!;
/** A real chat model that is simply not on this device. */
const ABSENT = catalogEntry('llama-3.2-3b-instruct-q4km')!;

function installedRecord(manifest: ModelManifest): InstalledModel {
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

const PROVIDER: ProviderConnection = {
  id: 'conn_openai',
  providerId: 'openai',
  label: 'OpenAI',
  apiKey: 'sk-test',
  baseUrl: 'https://api.openai.com/v1',
  defaultModel: 'gpt-4o-mini',
  enabled: true,
  models: [],
  createdAt: 1,
};

function chatPinnedTo(modelId: string | null): Chat {
  return {
    id: 'chat_1',
    title: 'Yesterday',
    mode: 'chat',
    personaId: null,
    modelId,
    sampler: null,
    tools: [],
    showThinking: false,
    createdAt: 1,
    updatedAt: 1,
    messageCount: 0,
    preview: '',
  };
}

/**
 * A real `DeviceCapabilities`, not a two-field cast.
 *
 * `InstalledView` reads `backends`, `cpuCores` and `chipset`; a partial stub
 * throws inside the render and would have this collector reporting on a screen
 * that never mounted.
 */
function device(totalMemory: number): DeviceCapabilities {
  return {
    totalMemory,
    availableMemory: Math.floor(totalMemory * 0.7),
    backends: ['cpu'],
    preferredBackend: 'cpu',
    cpuCores: 8,
    chipset: 'Tensor G3',
    simulated: false,
    engineVersion: 'llama.cpp b4321',
  };
}

function personaPreferring(preferredModelId: string | undefined): Persona {
  return {
    id: 'p1',
    kind: 'assistant',
    name: 'Helper',
    tagline: '',
    avatarSeed: 'seed',
    description: '',
    tags: [],
    showThinking: false,
    tools: [],
    preferredModelId,
    createdAt: 1,
    updatedAt: 1,
    version: 1,
  };
}

/**
 * The three memory readings the first-run screen is collected at.
 *
 * `0` is the branch `recommendModel`'s own comment calls the emulator case —
 * the device the original report came from, and the branch whose recommendation
 * sentence has already been false once.
 */
const MEMORY_READINGS: readonly number[] = [0, 1024 ** 3, 8 * 1024 ** 3];

/* ── The renderer ───────────────────────────────────────────────────── */

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

function text(node: Element | null | undefined): string {
  return (node?.textContent ?? '').replace(/\s+/g, ' ').trim();
}

async function click(node: Element | null | undefined): Promise<void> {
  expect(node, 'the control this step needs is on screen').toBeTruthy();
  await act(async () => {
    (node as HTMLElement).click();
  });
}

function buttonSaying(label: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll('button')].find((node) => text(node) === label) as
    | HTMLButtonElement
    | undefined;
}

/* ── The shell, driven through its real command table ───────────────── */

function shellStores(): ShellStores {
  return {
    models: () => ({
      activeModelId: useModels.getState().activeModelId,
      install: vi.fn(async () => undefined),
      remove: vi.fn(async () => undefined),
      setActive: vi.fn(async () => undefined),
      installed: Object.fromEntries(
        Object.values(useModels.getState().installed).map((record) => [
          record.id,
          {
            id: record.id,
            state: record.state,
            downloadedBytes: record.downloadedBytes,
            useCount: record.useCount,
            manifest: {
              name: record.manifest.name,
              quantization: record.manifest.quantization,
              capabilities: record.manifest.capabilities,
              contextLength: record.manifest.contextLength,
              sizeBytes: record.manifest.sizeBytes,
              engine: record.manifest.engine,
              license: record.manifest.license,
            },
          },
        ]),
      ),
    }),
    catalog: () => [],
    chats: () => ({
      activeChatId: null,
      list: [],
      messagesFor: async () => [],
      open: async () => undefined,
      create: async () => 'c1',
    }),
    personas: () => [],
    providers: () => ({ list: [], toggle: async () => undefined }),
    device: () => null,
    benchmarks: () => [],
    runBenchmark: vi.fn(async () => undefined),
  };
}

async function shell(name: string, args: readonly string[]): Promise<string> {
  const command = chatterangCommands(shellStores()).find((entry) => entry.name === name)!;
  const result = await command.run(args, { confirm: vi.fn(async () => true), actor: 'user' });
  return result.exitCode === 0 ? result.stdout : (result.stderr ?? '');
}

/* ══ 1. The arrangements, and what each one really does with a turn ═══ */

/**
 * The state of the app, as the sentences collected in it are entitled to
 * describe it. Every existence claim in `MEASURED_CLAIMS` is checked against
 * this rather than against a constant.
 */
interface Snapshot {
  readonly chatModelIds: readonly string[];
  readonly installedIds: readonly string[];
  readonly enabledProviders: readonly { readonly id: string; readonly label: string }[];
  readonly activeModelId: string | null;
}

/** Where the turn ACTUALLY went, recorded off the engine's own argument. */
interface Dispatch {
  readonly target: {
    readonly backendId: string;
    readonly modelId: string;
    readonly local: boolean;
  } | null;
  readonly assistantTurns: number;
  readonly toasts: readonly string[];
}

interface Arrangement {
  readonly installed: readonly InstalledModel[];
  readonly connections: readonly ProviderConnection[];
  readonly activeModelId?: string | null;
  readonly pinned?: string | null;
  /** When set, the chat is created from this persona instead of pinned by hand. */
  readonly persona?: Persona;
}

function arrange(state: Arrangement): void {
  useModels.setState({
    loaded: true,
    activeModelId: state.activeModelId ?? null,
    progress: {},
    storage: { used: 0, quota: 0 },
    installed: Object.fromEntries(state.installed.map((entry) => [entry.id, entry])),
  });
  usePersonas.setState(
    state.persona
      ? ({ loaded: true, byId: { [state.persona.id]: state.persona } } as never)
      : ({ loaded: true, byId: {} } as never),
  );
  useApp.setState({ connections: [...state.connections], toasts: [], activity: 'idle' });
  useChats.setState({
    loaded: true,
    generating: false,
    controller: null,
    context: null,
    messages: [],
    activeChatId: 'chat_1',
    chats: [chatPinnedTo(state.pinned ?? null)],
  });
}

function snapshot(): Snapshot {
  const models = useModels.getState();
  return {
    chatModelIds: chatModels(models).map((entry) => entry.id),
    installedIds: Object.keys(models.installed),
    enabledProviders: useApp
      .getState()
      .connections.filter((entry) => entry.enabled)
      .map((entry) => ({ id: entry.id, label: entry.label })),
    activeModelId: models.activeModelId,
  };
}

/**
 * Send one real turn in this arrangement and record where it went.
 *
 * The engine is a recorder rather than the shipped one: what is under test is
 * the TARGET the chat path chose, which is an argument to `stream`. Everything
 * upstream of that argument — `newChat`, `resolveTarget`, both refusal guards
 * — is the shipped code.
 */
async function dispatchIn(state: Arrangement): Promise<Dispatch> {
  arrange(state);

  let seen: { backendId: string; modelId: string; local: boolean } | null = null;
  useApp.setState({
    engine: {
      async *stream({ target }: { target: { backendId: string; modelId: string; local: boolean } }) {
        seen = { backendId: target.backendId, modelId: target.modelId, local: target.local };
        yield {
          type: 'done',
          text: 'ok',
          provenance: target,
          stats: { promptTokens: 0, completionTokens: 0 },
        };
      },
    } as never,
  });

  if (state.persona) await useChats.getState().newChat({ personaId: state.persona.id });
  await useChats.getState().send('hello');

  return {
    target: seen,
    assistantTurns: useChats
      .getState()
      .messages.filter((entry) => entry.role === 'assistant' && !entry.error).length,
    toasts: useApp.getState().toasts.map((toast) => toast.message),
  };
}

/* ══ 2. The collector ═════════════════════════════════════════════════ */

/**
 * One sentence, and enough about it to judge it.
 *
 * `about` is set when the sentence's SUBJECT is a model the app refuses. Those
 * are the ones the "name the kind, do not promise the feature" rule governs,
 * and tagging them is what lets the rule reach a catalogue description — a
 * string with no surrounding sentence to identify it — without misfiring on a
 * composite paragraph that merely mentions the model in one clause.
 */
interface Line {
  readonly where: string;
  readonly says: string;
  readonly about?: ModelManifest;
  /** The store this line was read from, for the standing surfaces. */
  readonly snap?: Snapshot;
}

interface Collected {
  readonly lines: readonly Line[];
  readonly snap: Snapshot;
  readonly dispatch: Dispatch;
}

/** Everything the chat journey says in one arrangement, read out of the DOM. */
async function collectChatScreen(state: Arrangement): Promise<Line[]> {
  arrange(state);
  const lines: Line[] = [];
  const refused = state.pinned ? useModels.getState().installed[state.pinned] : undefined;
  const about = refused && !canChat(refused.manifest) ? refused.manifest : undefined;

  await mounted(createElement(ChatScreen), async () => {
    const chip = document.querySelector('.rail__meta.grow .chip');
    lines.push({ where: 'rail.chip', says: text(chip), about });
    const title = chip?.getAttribute('title');
    if (title) lines.push({ where: 'rail.chip[title]', says: title, about });

    const empty = document.querySelector('.empty');
    if (empty) {
      lines.push({ where: 'start.title', says: text(empty.querySelector('.empty__title')) });
      lines.push({ where: 'start.body', says: text(empty.querySelector('.empty__body')), about });
    } else {
      const pad = document.querySelector('.screen__pad');
      lines.push({ where: 'start.title', says: text(pad?.querySelector('h2')) });
      lines.push({ where: 'start.body', says: text(pad?.querySelector('p')) });
    }

    const composer = document.querySelector('.composer__input') as HTMLTextAreaElement | null;
    lines.push({ where: 'composer.placeholder', says: composer?.placeholder ?? '' });

    await click(document.querySelector('[aria-label="Chat settings"]'));
    const select = document.querySelector('#chat-model') as HTMLSelectElement;
    const orphan = [...select.options].find((option) => option.disabled);
    if (orphan) lines.push({ where: 'settings.orphanOption', says: text(orphan), about });
    await click(document.querySelector('.sheet__head button'));

    const choose = buttonSaying('Choose a model');
    if (choose) {
      await click(choose);
      lines.push({
        where: 'picker.empty',
        says: text(document.querySelector('.sheet__body .section__hint')),
      });
    }
  });

  return lines.filter((line) => line.says.length > 0);
}

/** The persona editor, in the arrangement whose dispatch its hint describes. */
async function collectPersonaEditor(preference: string | undefined): Promise<Line[]> {
  const lines: Line[] = [];
  const record = preference ? useModels.getState().installed[preference] : undefined;
  const about = record && !canChat(record.manifest) ? record.manifest : undefined;

  await mounted(
    createElement(PersonaEditor, { persona: personaPreferring(preference), onClose: () => {} }),
    () => {
      const select = document.querySelector('#persona-model') as HTMLSelectElement;
      const stranded = [...select.options].find((option) => option.disabled);
      if (stranded) {
        lines.push({ where: `persona.strandedOption(${preference})`, says: text(stranded), about });
      }
      lines.push({
        where: stranded ? 'persona.hint(stranded)' : 'persona.hint',
        says: text(select.parentElement?.querySelector('.field__hint')),
      });
    },
  );

  return lines;
}

/**
 * The hint the picker shows when the preference is NOT stranded.
 *
 * It is a sentence about what happens when a preference is missing, displayed
 * in a state where it is not — a counterfactual, and the two rounds of false
 * copy both lived in it. So it is collected here and judged against the
 * arrangement whose dispatch it describes, not against the one it is drawn in.
 * Both non-stranded renders must produce the same words; a difference between
 * them would mean the sentence is not the counterfactual it claims to be.
 */
async function collectCounterfactualHint(): Promise<Line[]> {
  const said: string[] = [];
  for (const preference of [undefined, QWEN.id]) {
    const [line] = await collectPersonaEditor(preference);
    expect(line?.where, `the ordinary hint is shown for ${String(preference)}`).toBe('persona.hint');
    said.push(line!.says);
  }
  expect(said[0], 'the ordinary hint does not depend on which valid preference is set').toBe(
    said[1],
  );
  return [{ where: 'persona.hint', says: said[0]! }];
}

/* ══ 3. The arrangements this file collects from ══════════════════════ */

/**
 * Each entry is a state a real user is in, its sentences, and the turn it
 * really dispatches. `refused` is the reported one; `prefers-absent` is the
 * one whose sentence has now been wrong twice.
 */
const ARRANGEMENTS: Record<string, Arrangement> = {
  local: { installed: [installedRecord(QWEN)], connections: [], pinned: QWEN.id },
  refused: {
    installed: [installedRecord(WHISPER)],
    connections: [PROVIDER],
    pinned: WHISPER.id,
  },
  remote: { installed: [], connections: [PROVIDER], pinned: null },
  'nothing-installed': { installed: [], connections: [], pinned: null },
  'only-a-speech-model': { installed: [installedRecord(WHISPER)], connections: [], pinned: null },
  'prefers-absent': {
    installed: [installedRecord(QWEN)],
    connections: [PROVIDER],
    activeModelId: QWEN.id,
    persona: personaPreferring(ABSENT.id),
  },
  'prefers-absent-alone': {
    installed: [installedRecord(QWEN)],
    connections: [{ ...PROVIDER, enabled: false }],
    activeModelId: QWEN.id,
    persona: personaPreferring(ABSENT.id),
  },
  'prefers-a-speech-model': {
    installed: [installedRecord(WHISPER), installedRecord(QWEN)],
    connections: [PROVIDER],
    activeModelId: QWEN.id,
    persona: personaPreferring(WHISPER.id),
  },
};

async function collect(name: keyof typeof ARRANGEMENTS): Promise<Collected> {
  const state = ARRANGEMENTS[name]!;
  const dispatch = await dispatchIn(state);

  arrange(state);
  const snap = snapshot();
  const lines: Line[] = [];

  if (state.persona) {
    // The hint under the persona's picker is a claim about what happens when a
    // chat STARTS from this persona — which is exactly the turn just measured.
    lines.push(...(await collectPersonaEditor(state.persona.preferredModelId)));
    lines.push(...(await collectCounterfactualHint()));
  } else {
    lines.push(...(await collectChatScreen(state)));
    if (dispatch.toasts.length > 0) {
      const pinned = state.pinned ? useModels.getState().installed[state.pinned] : undefined;
      lines.push({
        where: 'send.toast',
        says: dispatch.toasts.join(' '),
        about: pinned && !canChat(pinned.manifest) ? pinned.manifest : undefined,
      });
    }
  }

  return { lines, snap, dispatch };
}

/**
 * The sentences that do not depend on which chat is open.
 *
 * They are still collected from the surface that ships them — the real store's
 * toast, the rendered sheet, the real shell's stderr, the rendered browse card
 * — and they are still checked, by the rules that do not need a dispatch.
 */
async function collectStandingSurfaces(): Promise<Line[]> {
  const raw: Line[] = [];
  /* Each line carries the store it was read from, so an existence claim
     ("None of the installed models…") is checked against that state and not
     against whatever the next surface arranged. */
  const lines = {
    push: (...entries: Line[]) => raw.push(...entries.map((e) => ({ ...e, snap: snapshot() }))),
  };
  arrange({ installed: [installedRecord(WHISPER), installedRecord(QWEN)], connections: [] });

  // The engine's own refusal, from the store that would have sent the turn.
  useApp.setState({ toasts: [] });
  await useModels.getState().setActive(WHISPER.id);
  lines.push({
    where: 'models.setActive.toast',
    says: useApp.getState().toasts.map((toast) => toast.message).join(' '),
    about: WHISPER,
  });

  // The benchmark path, which is where this method started.
  useBench.setState({ runs: [], running: null, publishing: null });
  useApp.setState({ toasts: [] });
  await useBench.getState().run(WHISPER.id);
  lines.push({
    where: 'bench.toast',
    says: useApp.getState().toasts.map((toast) => toast.message).join(' '),
    about: WHISPER,
  });
  lines.push({ where: 'bench.reason', says: nonBenchmarkableReason(WHISPER), about: WHISPER });

  arrange({ installed: [installedRecord(WHISPER)], connections: [] });
  await mounted(createElement(BenchScreen), () => {
    const hint = [...document.querySelectorAll('span.list__sub')].find((node) =>
      text(node).includes('can be benchmarked'),
    );
    lines.push({ where: 'bench.hint', says: text(hint), about: WHISPER });
  });

  // The shell's two refusals.
  arrange({ installed: [installedRecord(WHISPER), installedRecord(QWEN)], connections: [] });
  lines.push({ where: 'shell.model-use', says: await shell('model', ['use', WHISPER.id]), about: WHISPER });
  lines.push({ where: 'shell.bench-run', says: await shell('bench', ['run', WHISPER.id]), about: WHISPER });

  // The model sheet for the reported user's only model.
  await mounted(createElement(ModelDetail, { modelId: WHISPER.id, onClose: () => {} }), () => {
    lines.push({
      where: 'modelDetail.hint',
      says: text(document.querySelector('.sheet__body p')),
      about: WHISPER,
    });
    lines.push({
      where: 'modelDetail.foot',
      says: text(document.querySelector('.sheet__foot')).replace(/Done$/, '').trim(),
      about: WHISPER,
    });
  });

  // First run, at three memory readings — including the emulator case, which
  // is the device the original report came from.
  for (const memory of MEMORY_READINGS) {
    useApp.setState({ device: memory > 0 ? device(memory) : null });
    await mounted(createElement(Onboarding, { open: true, onClose: () => {} }), () => {
      const heads = [...document.querySelectorAll('.section__head')];
      const start = heads.find((node) => text(node).startsWith('Start with'));
      lines.push({
        where: `onboarding.recommendation(${formatBytes(memory, 0)})`,
        says: text(start?.parentElement?.querySelector('.section__hint')),
      });
    });
  }
  /*
   * THE TWO PARAGRAPHS THIS COLLECTOR COULD NOT SEE.
   *
   * Only the recommendation hint above was collected from this screen, and it
   * is the one paragraph on it that says nothing about where a turn goes. The
   * other two are the app's central promise, made on the first screen every
   * user sees — and one of them shipped the sentence this round exists to
   * repair. A collector that reaches a screen but not the sentence on it that
   * matters most is worse than one that does not reach the screen at all: it
   * reads like coverage.
   *
   * Read at a memory reading that produces a recommendation, so the screen is
   * the whole screen rather than the degenerate one with no download offered.
   */
  useApp.setState({ device: device(8 * 1024 ** 3) });
  await mounted(createElement(Onboarding, { open: true, onClose: () => {} }), () => {
    // A direct child of the sheet body: the paragraph above the first section.
    lines.push({
      where: 'onboarding.privacy',
      says: text(document.querySelector('.sheet__body > p.section__hint')),
    });
    const alternative = [...document.querySelectorAll('.sheet__body .section')].find((node) =>
      text(node.querySelector('.section__head')).startsWith('Not ready to download?'),
    );
    expect(alternative, 'the download-nothing alternative is on the screen').toBeTruthy();
    lines.push({
      where: 'onboarding.remoteAlternative',
      says: text(alternative!.querySelector('.section__hint')),
    });
  });
  useApp.setState({ device: null });

  /*
   * The browse card of every model this app will refuse for a chat.
   *
   * This is the screen where the download decision is made, and it is the one
   * place `manifest.description` is rendered for a model that cannot chat —
   * `ModelDetail` deliberately suppresses it and says so in a comment that
   * calls the catalogue copy "the real fix". Two sentences are read off it: the
   * description, and the fit chip, which is composed from this device's memory
   * against the model's own minimum.
   *
   * The device is given 1.5 GB so every one of the three lands on the `tight`
   * or `too big` branch rather than on no chip at all — a reading that renders
   * nothing is a surface this collector would be pretending to reach.
   */
  useApp.setState({ device: device(1_500_000_000) });
  await mounted(createElement(ModelsScreen), async () => {
    await click(buttonSaying('Browse'));
    const cards = [...document.querySelectorAll('.card--local')];
    for (const manifest of CATALOG.filter((entry) => !canChat(entry))) {
      const card = cards.find((node) => text(node.querySelector('.card__title')) === manifest.name);
      expect(card, `${manifest.id} has a browse card`).toBeTruthy();
      lines.push({
        where: `catalogue.description(${manifest.id})`,
        says: text(card!.querySelector('p')),
        about: manifest,
      });
      lines.push({
        where: `browse.fitChip(${manifest.id})`,
        says: text(card!.querySelector('.chip--warn, .chip--crit')),
        about: manifest,
      });
    }
  });
  useApp.setState({ device: null });

  return raw;
}

beforeEach(() => {
  vi.clearAllMocks();
  useApp.setState({ toasts: [], activity: 'idle', device: null });
  useBench.setState({ runs: [], running: null, publishing: null });
});

/* ══ 4. The inventory, pinned ═════════════════════════════════════════ */

/**
 * Every sentence, verbatim.
 *
 * This is the blunt half of the file and it is deliberate: a new sentence
 * anywhere on this journey, or a surface added to the collector, fails HERE —
 * next to the rules below, which is where the author needs to be standing.
 */
/** The sentence under a stranded preference, and the one under a valid one. */
const STRANDED_HINT =
  'This persona still points at the model above, and every new chat it starts inherits it. Pick one from the list to fix that, then save.';
const COUNTERFACTUAL_HINT =
  'Used when a chat starts with this persona. A preference that is not installed does not fall back to the active model — the turn goes to the first provider you have enabled instead, and is refused if you have none.';

const INVENTORY: Record<string, Record<string, string>> = {
  local: {
    'rail.chip': 'Qwen3 4B Instruct',
    'start.title': 'Everything here stays here.',
    'start.body':
      'Qwen3 4B Instruct answers on this device. Nothing you type is sent anywhere unless you explicitly connect a remote provider — and from now on, every reply that comes back from a provider is marked Remote in the thread.',
    'composer.placeholder': 'Message',
  },
  refused: {
    'rail.chip': 'Whisper Tiny (English) cannot answer a chat',
    'rail.chip[title]':
      'This chat is pinned to a model that cannot write text, so no turn will be sent.',
    'start.title': 'This chat cannot answer',
    'start.body':
      'It is set to Whisper Tiny (English), which is a speech-to-text model — nothing is loaded and nothing will be sent. Choose a model that writes text and the conversation is kept.',
    'composer.placeholder': 'Pick a model that writes text',
    'settings.orphanOption': 'Whisper Tiny (English) is a speech-to-text model',
    'picker.empty':
      'Nothing installed can answer a chat: Whisper Tiny (English) is a speech-to-text model. Open Models to download a chat model — the smallest is under a gigabyte.',
    'send.toast':
      'Whisper Tiny (English) is a speech-to-text model — it cannot answer a chat. Choose a model that writes text, then send this again.',
  },
  remote: {
    'rail.chip': 'No local model',
    'start.title': 'This chat leaves the device.',
    'start.body':
      'No model on this device will answer it, so turns in this chat go to OpenAI. What you type, and anything a tool reads for the model, goes with them. From now on, every reply that comes back from a provider is marked Remote in the thread.',
    'composer.placeholder': 'Message',
  },
  'nothing-installed': {
    'rail.chip': 'No local model',
    'start.title': 'Nothing to talk to yet',
    'start.body':
      'Download a model in Models, or connect a provider in Settings. Downloaded models run entirely on this device.',
    'composer.placeholder': 'Install a model or add a provider',
    'picker.empty':
      'Nothing is installed yet. Open Models to download one — the smallest is under a gigabyte.',
    'send.toast': 'Choose a model first — none is installed or connected yet.',
  },
  'only-a-speech-model': {
    'rail.chip': 'No local model',
    'start.title': 'Nothing here can hold a conversation',
    'start.body':
      'Whisper Tiny (English) is a speech-to-text model. Download a chat model in Models, or connect a provider in Settings. A chat model downloaded there runs entirely on this device; a provider does not.',
    'composer.placeholder': 'Install a model or add a provider',
    'picker.empty':
      'Nothing installed can answer a chat: Whisper Tiny (English) is a speech-to-text model. Open Models to download a chat model — the smallest is under a gigabyte.',
    'send.toast': 'Choose a model first — none is installed or connected yet.',
  },
  'prefers-absent': {
    'persona.strandedOption(llama-3.2-3b-instruct-q4km)': 'Llama 3.2 3B Instruct — not installed',
    'persona.hint(stranded)': STRANDED_HINT,
    'persona.hint': COUNTERFACTUAL_HINT,
  },
  'prefers-absent-alone': {
    'persona.strandedOption(llama-3.2-3b-instruct-q4km)': 'Llama 3.2 3B Instruct — not installed',
    'persona.hint(stranded)': STRANDED_HINT,
    'persona.hint': COUNTERFACTUAL_HINT,
  },
  'prefers-a-speech-model': {
    'persona.strandedOption(whisper-tiny-en-onnx)': 'Whisper Tiny (English) is a speech-to-text model',
    'persona.hint(stranded)': STRANDED_HINT,
    'persona.hint': COUNTERFACTUAL_HINT,
  },
};

const STANDING_INVENTORY: Record<string, string> = {
  'models.setActive.toast':
    'Whisper Tiny (English) is a speech-to-text model — it cannot answer a chat. Pick a model that writes text.',
  'bench.toast':
    'Whisper Tiny (English) cannot be benchmarked — the benchmark only measures llama-cpp models. The Benchmarks screen lists the ones this device can measure.',
  'bench.reason': 'is built for onnx-runtime, and the benchmark only measures llama-cpp models',
  'bench.hint':
    'None of the installed models can be benchmarked. The benchmark only measures llama-cpp models — the Engine row in a model’s own sheet says which engine it is built for.',
  'shell.model-use':
    '"whisper-tiny-en-onnx" is a speech-to-text model — it cannot answer a chat. Try: model list — the CHAT column marks the ones that can.',
  'shell.bench-run':
    '"whisper-tiny-en-onnx" is built for onnx-runtime, and the benchmark only measures llama-cpp models — it cannot be benchmarked. Try: model list — the ENGINE column.',
  'modelDetail.hint':
    'Whisper Tiny (English) is a speech-to-text model. It cannot answer a chat — open Models › Browse and use the Text filter to list the ones that can.',
  'modelDetail.foot': 'Not a chat model',
  'onboarding.recommendation(0 B)':
    'Speeding up a larger Qwen model. This device has not reported how much memory it has, so this is the cautious guess rather than a measured fit. Nothing in the catalogue that can hold a conversation is smaller. It downloads once and then works offline.',
  'onboarding.recommendation(1 GB)':
    'Quick image descriptions on any device. It needs 1 GB and this device has 1 GB, so it will run, slowly. It downloads once and then works offline.',
  'onboarding.recommendation(8 GB)':
    'Questions about photos and screenshots. Comfortable on Tensor G3. It downloads once and then works offline.',
  'onboarding.privacy':
    'Chatterang runs language models on this device: conversations, personas and settings are stored here, with no account and nothing syncing. Some things do leave — a model download comes from huggingface.co, and a remote provider you connect gets what you send it. From now on, every reply that comes back from a provider is marked Remote in the thread. For the rest, Settings › Shell has a privacy command.',
  'onboarding.remoteAlternative':
    'Connect a remote provider in Settings and use Chatterang straight away. What you send goes to that provider, and from now on every reply that comes back from a provider is marked Remote in the thread.',
  'catalogue.description(whisper-tiny-en-onnx)':
    'Turns speech into text on the device. Fast enough to keep up with normal dictation, and the audio never leaves your phone.',
  'catalogue.description(piper-en-us-amy-medium)':
    'A neural voice that sounds the same on every device, unlike the built-in OS voices which vary by phone.',
  'catalogue.description(sd-turbo-onnx)':
    'Generates a picture in one to four steps rather than the usual twenty-plus. Runs in its own isolated process so it cannot disturb a loaded language model.',
  'browse.fitChip(whisper-tiny-en-onnx)': 'Will run, but slowly — 2 GB is recommended',
  'browse.fitChip(piper-en-us-amy-medium)': 'Will run, but slowly — 2 GB is recommended',
  'browse.fitChip(sd-turbo-onnx)': 'Needs 6 GB of memory — more than this device has',
};

describe('every sentence on the model-selection journey', () => {
  for (const name of Object.keys(ARRANGEMENTS)) {
    it(`is collected, verbatim, from the surface that ships it — ${name}`, async () => {
      const { lines } = await collect(name);
      expect(Object.fromEntries(lines.map((line) => [line.where, line.says]))).toEqual(
        INVENTORY[name],
      );
    });
  }

  it('is collected from the standing surfaces too', async () => {
    const lines = await collectStandingSurfaces();
    expect(Object.fromEntries(lines.map((line) => [line.where, line.says]))).toEqual(
      STANDING_INVENTORY,
    );
  });
});

/* ══ 5. Collected once, judged by every rule below ════════════════════ */

interface Journey {
  readonly arrangements: Record<string, Collected>;
  readonly standing: readonly Line[];
}

let journey: Journey | null = null;

/**
 * The whole journey, collected once.
 *
 * Every rule below reads this rather than re-rendering, so a sentence cannot
 * be governed by one rule and not another: the set of sentences IS the set the
 * inventory above pins.
 */
async function walk(): Promise<Journey> {
  if (journey) return journey;
  const arrangements: Record<string, Collected> = {};
  for (const name of Object.keys(ARRANGEMENTS)) arrangements[name] = await collect(name);
  journey = { arrangements, standing: await collectStandingSurfaces() };
  return journey;
}

/* ══ 6. WHERE THE TURN GOES — the clause the rule did not have ════════ */

/**
 * A claim a sentence can make about the destination of a turn, and the
 * measurement that settles it.
 *
 * `verdict` is three-valued on purpose. `'n/a'` exists for exactly one shape
 * of sentence — one that names a route AND names the branch where that route
 * is not taken ("…goes to the first provider you have enabled instead, and is
 * refused if you have none") — because such a sentence is shown in both
 * arrangements and is true in both. Every other combination is judged, and the
 * three dangerous directions are judged strictly:
 *
 *   · saying a turn stays here where it measurably left,
 *   · saying nothing is sent where a turn measurably went,
 *   · naming a destination the turn measurably did not take.
 *
 * Those are the errors this app's privacy story cannot survive, and two of the
 * four historical false sentences were the second one.
 */
type Verdict = 'true' | 'false' | 'n/a';

interface DestinationClaim {
  readonly id: string;
  readonly asserts: RegExp;
  readonly verdict: (sentence: string, dispatch: Dispatch, snap: Snapshot) => Verdict;
}

/** A sentence that names its own exception is allowed to describe both branches. */
const NAMES_THE_REFUSAL_BRANCH = /\bis refused\b|\bif you have none\b|\bno provider\b/i;

const DESTINATION_CLAIMS: readonly DestinationClaim[] = [
  {
    id: 'this turn stays on this device',
    asserts: /\bstays here\b|\banswers on this device\b|\bruns on this device\b|\bis running (locally|on this device)\b/i,
    verdict: (_sentence, dispatch) => (dispatch.target?.local === true ? 'true' : 'false'),
  },
  {
    id: 'this turn goes to a provider',
    asserts: /\bleaves the device\b|\bturns in this chat go to\b|\bthe turn goes to\b|\bgoes with them\b/i,
    verdict: (sentence, dispatch) => {
      if (dispatch.target) return dispatch.target.local ? 'false' : 'true';
      // Nothing was sent. Only a sentence that says so itself may still name
      // the route it would otherwise have taken.
      return NAMES_THE_REFUSAL_BRANCH.test(sentence) ? 'n/a' : 'false';
    },
  },
  {
    id: 'nothing is sent at all',
    asserts: /\bnothing (will be|is) sent\b|\bnothing to send\b|\bnowhere to send\b|\bno turn will be sent\b|\bdoes not send\b/i,
    verdict: (_sentence, dispatch) => (dispatch.target === null ? 'true' : 'false'),
  },
  {
    id: 'the active model answers instead',
    asserts: /\bfalls back to the active\b|\buses the active\b|\bthe active (one|model) is used instead\b/i,
    verdict: (_sentence, dispatch, snap) =>
      dispatch.target !== null &&
      dispatch.target.local &&
      dispatch.target.modelId === snap.activeModelId
        ? 'true'
        : 'false',
  },
];

describe('what the copy claims about where a turn goes, against where it went', () => {
  it('dispatches a real turn in every arrangement, and records the target', async () => {
    const { arrangements } = await walk();

    // The measurement the sentences are judged against, stated once so a
    // change in the chat path fails HERE rather than silently re-basing every
    // rule below onto a new answer.
    expect(
      Object.fromEntries(
        Object.entries(arrangements).map(([name, collected]) => [name, collected.dispatch.target]),
      ),
    ).toEqual({
      local: { backendId: 'llama-cpp', modelId: QWEN.id, local: true },
      refused: null,
      remote: { backendId: PROVIDER.id, modelId: PROVIDER.defaultModel, local: false },
      'nothing-installed': null,
      'only-a-speech-model': null,
      'prefers-absent': { backendId: PROVIDER.id, modelId: PROVIDER.defaultModel, local: false },
      'prefers-absent-alone': null,
      'prefers-a-speech-model': null,
    });

    // The two that matter most, said plainly: a chat pinned to a model that
    // cannot answer does NOT divert to the provider that is switched on.
    expect(arrangements.refused!.snap.enabledProviders).toHaveLength(1);
    expect(arrangements['prefers-a-speech-model']!.snap.enabledProviders).toHaveLength(1);
  });

  it('never says a turn stays, leaves, or is withheld against the measurement', async () => {
    const { arrangements } = await walk();
    let judged = 0;

    for (const [name, { lines, dispatch, snap }] of Object.entries(arrangements)) {
      for (const line of lines) {
        for (const claim of DESTINATION_CLAIMS) {
          if (!claim.asserts.test(line.says)) continue;
          judged += 1;
          const verdict = claim.verdict(line.says, dispatch, snap);
          expect(
            { claim: claim.id, at: `${name}/${line.where}`, verdict },
            `“${line.says}” claims ${claim.id}; the turn actually went to ${JSON.stringify(dispatch.target)}`,
          ).toEqual({ claim: claim.id, at: `${name}/${line.where}`, verdict: expect.not.stringMatching(/^false$/) });
        }
      }
    }

    // A rule that matched nothing is a rule that is not running.
    expect(judged, 'the destination rules reached the copy at all').toBeGreaterThan(6);
  });

  it('names the provider only where the provider really was handed the turn', async () => {
    const { arrangements } = await walk();

    for (const [name, { lines, dispatch, snap }] of Object.entries(arrangements)) {
      for (const provider of snap.enabledProviders) {
        for (const line of lines) {
          if (!line.says.includes(provider.label)) continue;
          expect(
            { at: `${name}/${line.where}`, went: dispatch.target?.backendId ?? null },
            `“${line.says}” names ${provider.label}`,
          ).toEqual({ at: `${name}/${line.where}`, went: provider.id });
        }
      }
    }

    // And the converse: where a turn did leave, the screen says which provider
    // took it. A remote target the copy does not name is the failure this rule
    // exists for, in the direction a ban cannot catch.
    const remote = arrangements.remote!;
    expect(remote.dispatch.target?.local).toBe(false);
    expect(remote.lines.some((line) => line.says.includes(PROVIDER.label))).toBe(true);
  });
});

/* ══ 7. NAME THE KIND, DO NOT PROMISE THE FEATURE ═════════════════════ */

/**
 * What a sentence whose SUBJECT is a model this build refuses may not claim.
 *
 * The first three are the words that shipped on the benchmark path. The rest
 * are the same rule pointed at the other half of the promise: not "it runs"
 * but "it runs HERE" — a device-retention claim about a model that, on the
 * platform the report came from, executes nowhere.
 */
const CLAIMS_ABOUT_A_REFUSED_MODEL: readonly RegExp[] = [
  /\bruns?\b/i,
  /\brunning\b/i,
  /\bwill run\b/i,
  /\bdifferent engine\b/i,
  /\bon (this|the) device\b/i,
  /\bon your phone\b/i,
  /\bnever leaves\b/i,
  /\boffline\b/i,
  /\blocally\b/i,
];

/**
 * SENTENCES THAT BREAK THE RULE AND ARE STILL SHIPPING.
 *
 * THIS IS A DEFECT RECORD, NOT AN EXEMPTION. Widening the collector to the
 * browse card — the screen where the download decision is actually made — found
 * four live sentences that the rule above rejects, in two files this change is
 * not allowed to touch. They are quoted here by surface, and the test below
 * asserts each one STILL breaks the rule, so repairing any of them reddens this
 * list and forces the entry out. The count is pinned, so a fifth cannot join
 * quietly: adding one costs the same argument as shipping it.
 *
 * All four are about models whose engine is `onnx-runtime`, which
 * `tests/bench-copy.test.ts` measures to be registered in NONE of this build's
 * four native manifests — so on the platform the original report came from,
 * these models execute nowhere.
 *
 *   · `src/data/catalog.ts` — "Turns speech into text on the device… the audio
 *     never leaves your phone" and "Runs in its own isolated process". These are
 *     the same claim the benchmark copy was repaired for, one screen earlier in
 *     the same journey. `ModelDetail` already refuses to render the description
 *     for a model that cannot chat, and its comment says why: "the catalogue
 *     copy itself is the real fix". The browse card still renders it.
 *   · `src/features/models/ModelsScreen.tsx` — `CatalogCard`'s fit chip says
 *     "Will run, but slowly" from memory arithmetic alone, with no check on
 *     whether the engine that would run it exists. SD-Turbo's chip escapes only
 *     because 6 GB of memory is more than the device has, which is luck rather
 *     than a rule.
 */
const UNFIXED_CATALOGUE_CLAIMS: readonly string[] = [
  'catalogue.description(whisper-tiny-en-onnx)',
  'catalogue.description(sd-turbo-onnx)',
  'browse.fitChip(whisper-tiny-en-onnx)',
  'browse.fitChip(piper-en-us-amy-medium)',
];

describe('sentences about a model this build will refuse', () => {
  it('promise nothing about what it does, where it runs, or what stays here', async () => {
    const { arrangements, standing } = await walk();
    const lines = [
      ...Object.values(arrangements).flatMap((collected) => collected.lines),
      ...standing,
    ].filter((line) => line.about !== undefined);

    expect(lines.length, 'the rule reaches sentences at all').toBeGreaterThan(10);

    for (const line of lines) {
      if (UNFIXED_CATALOGUE_CLAIMS.includes(line.where)) continue;
      for (const banned of CLAIMS_ABOUT_A_REFUSED_MODEL) {
        expect(
          { at: line.where, claims: banned.test(line.says) },
          `“${line.says}” is about ${line.about!.id}, which this build cannot run`,
        ).toEqual({ at: line.where, claims: false });
      }
    }
  });

  it('names the kind instead, in one vocabulary, everywhere it says anything', async () => {
    const { arrangements, standing } = await walk();
    const lines = [
      ...Object.values(arrangements).flatMap((collected) => collected.lines),
      ...standing,
    ].filter((line) => line.about !== undefined);

    for (const line of lines) {
      const role = nonChatRole(line.about!);
      if (!line.says.includes(role)) continue;
      /*
       * `nonChatRole` returns a PREDICATE, so whatever precedes it has to be
       * its subject. Three forms are in use and all three are grammatical: the
       * model's name (the pickers and the chip), its id in quotes (the shell,
       * where the user typed an id), and a relative clause back to the name
       * (`refusalCopy`). What is NOT allowed is the em dash that appeared in
       * `strandedLabel` — "Whisper Tiny (English) — is a speech-to-text model"
       * — which is the drift that already happened once, in the same field a
       * previous round was repairing.
       */
      const before = line.says.slice(0, line.says.indexOf(role));
      const subject = [`${line.about!.name} `, `"${line.about!.id}" `, 'which '];
      expect(
        { at: line.where, ends: subject.some((form) => before.endsWith(form)) },
        `“${line.says}” must put a subject, not punctuation, in front of “${role}”`,
      ).toEqual({ at: line.where, ends: true });
      expect(line.says, `${line.where} names the record it is talking about`).toContain(
        line.about!.name.length > 0 && before.includes(line.about!.name)
          ? line.about!.name
          : line.about!.id,
      );
    }
  });

  it('still breaks the rule in exactly the four places nobody has fixed yet', async () => {
    const { standing } = await walk();

    for (const where of UNFIXED_CATALOGUE_CLAIMS) {
      const line = standing.find((entry) => entry.where === where);
      expect(line, `${where} is still collected`).toBeTruthy();
      expect(
        CLAIMS_ABOUT_A_REFUSED_MODEL.some((banned) => banned.test(line!.says)),
        `${where} was fixed — delete it from UNFIXED_CATALOGUE_CLAIMS`,
      ).toBe(true);
    }
    // Pinned: a fifth quarantined sentence has to be added deliberately, here,
    // with the same argument a shipped false sentence would need.
    expect(UNFIXED_CATALOGUE_CLAIMS).toHaveLength(4);
  });
});

/* ══ 8. Claims that name a quantity, and the measurements behind them ══ */

/**
 * The fourth false sentence was not a run claim and not a destination claim.
 *
 * "This is the smallest model available — it will be slow on this device, but
 * it will run" was three claims about MEASURABLE FACTS, all three wrong at
 * once, on the first screen of the journey. Nothing in the app compared the
 * pick to the catalogue; the sentence simply asserted the comparison.
 *
 * So a superlative or an existence claim anywhere on this journey must match
 * an entry here, and the entry's verifier is executed against the catalogue,
 * the domain rules, or the store the sentence was read from. THE DEFAULT IS
 * REFUSAL: a sentence that makes such a claim and matches no entry fails, and
 * the failure says so. Writing a new one is meant to cost the author a
 * measurement.
 */
const MAKES_A_MEASURABLE_CLAIM =
  /\b(smallest|largest|biggest|smaller|larger|fastest|slowest|only|none|nothing)\b/i;

interface Facts {
  readonly smallestChatModel: ModelManifest;
  /** Measured, not assumed: with no provider enabled, was the turn withheld? */
  readonly withheldWithNoProvider: boolean;
  /**
   * What the shipped `privacy` command prints in the configuration the first
   * screen describes. The welcome paragraph and that command are two surfaces
   * making one claim about storage, and the whole reason this file exists is
   * that two surfaces stating one fact separately is how the false ones got
   * written — so the screen's claim is checked against the command's.
   */
  readonly privacySays: string;
  /** `model list`, for the sentence that says its CHAT column marks a kind. */
  readonly modelList: string;
}

interface ClaimContext {
  readonly line: Line;
  readonly snap: Snapshot;
  readonly dispatch: Dispatch | null;
  readonly facts: Facts;
}

interface MeasuredClaim {
  readonly id: string;
  readonly matches: RegExp;
  readonly holds: (ctx: ClaimContext) => boolean;
}

/** Which device reading each first-run sentence was collected at. */
const READING_FOR: Record<string, number> = Object.fromEntries(
  MEMORY_READINGS.map((memory) => [`onboarding.recommendation(${formatBytes(memory, 0)})`, memory]),
);

const MEASURED_CLAIMS: readonly MeasuredClaim[] = [
  {
    id: 'nothing you type is sent anywhere (unless a provider is connected)',
    matches: /Nothing you type is sent anywhere unless you explicitly connect a remote provider/,
    holds: ({ dispatch, snap }) =>
      dispatch?.target?.local === true && snap.enabledProviders.length === 0,
  },
  {
    id: 'there is no account and nothing syncs',
    // The welcome screen's storage claim, checked against the command whose
    // copy `tests/privacy-copy.test.ts` already governs. Neither surface is
    // allowed to be the only one saying it.
    matches: /with no account and nothing syncing/,
    holds: ({ facts }) =>
      facts.privacySays.includes('There is no account and') &&
      facts.privacySays.includes('nothing syncs.') &&
      facts.privacySays.includes('are stored here and nowhere else'),
  },
  {
    id: 'nothing is loaded and nothing will be sent',
    matches: /nothing is loaded and nothing will be sent/,
    holds: ({ dispatch }) => dispatch?.target === null,
  },
  {
    id: 'nothing installed can answer a chat',
    matches: /^Nothing installed can answer a chat:/,
    holds: ({ snap }) => snap.chatModelIds.length === 0 && snap.installedIds.length > 0,
  },
  {
    id: 'nothing here can hold a conversation',
    matches: /^Nothing here can hold a conversation$/,
    holds: ({ snap }) => snap.chatModelIds.length === 0 && snap.installedIds.length > 0,
  },
  {
    id: 'nothing is installed yet',
    matches: /^Nothing (is installed yet|to talk to yet)/,
    holds: ({ snap }) => snap.installedIds.length === 0,
  },
  {
    id: 'the smallest chat model is under a gigabyte',
    matches: /the smallest is under a gigabyte/,
    holds: ({ facts }) => facts.smallestChatModel.sizeBytes < 1024 ** 3,
  },
  {
    id: 'none is installed or connected',
    matches: /none is installed or connected yet/,
    holds: ({ snap }) => snap.chatModelIds.length === 0 && snap.enabledProviders.length === 0,
  },
  {
    id: 'the turn is refused when no provider is enabled',
    matches: /is refused if you have none/,
    holds: ({ facts }) => facts.withheldWithNoProvider,
  },
  {
    id: 'the benchmark only measures the engines it has a harness for',
    matches: /the benchmark only measures ([a-z0-9- ]+?) models/,
    holds: ({ line }) =>
      new RegExp(`the benchmark only measures ${benchmarkableEngineList()} models`).test(line.says),
  },
  {
    id: 'none of the installed models can be benchmarked',
    matches: /^None of the installed models can be benchmarked\./,
    holds: ({ snap }) =>
      snap.installedIds.length > 0 &&
      snap.installedIds.every((id) => {
        const manifest = catalogEntry(id);
        return manifest !== undefined && !BENCHMARKABLE_ENGINES.includes(manifest.engine);
      }),
  },
  {
    id: 'nothing in the catalogue that can chat is smaller than the recommendation',
    matches: /Nothing in the catalogue that can hold a conversation is smaller\./,
    holds: ({ line, facts }) => {
      const memory = READING_FOR[line.where];
      if (memory === undefined) return false;
      const pick = recommendModel(CATALOG, memory > 0 ? memory : undefined);
      return pick?.manifest.id === facts.smallestChatModel.id;
    },
  },
];

async function facts(): Promise<Facts> {
  const { arrangements } = await walk();
  const smallestChatModel = CATALOG.filter(canChat).reduce((best, entry) =>
    entry.sizeBytes < best.sizeBytes ? entry : best,
  );
  arrange({ installed: [installedRecord(WHISPER), installedRecord(QWEN)], connections: [] });
  return {
    smallestChatModel,
    withheldWithNoProvider: arrangements['prefers-absent-alone']!.dispatch.target === null,
    privacySays: await shell('privacy', []),
    modelList: await shell('model', ['list']),
  };
}

describe('claims about how many, how small, or whether there are any', () => {
  it('are each backed by a verifier that runs, and no sentence makes one without', async () => {
    const { arrangements, standing } = await walk();
    const measured = await facts();
    const seen = new Set<string>();
    let judged = 0;

    const everywhere: { line: Line; snap: Snapshot; dispatch: Dispatch | null }[] = [
      ...Object.values(arrangements).flatMap((collected) =>
        collected.lines.map((line) => ({ line, snap: collected.snap, dispatch: collected.dispatch })),
      ),
      ...standing.map((line) => ({ line, snap: line.snap!, dispatch: null })),
    ];

    for (const { line, snap, dispatch } of everywhere) {
      if (!MAKES_A_MEASURABLE_CLAIM.test(line.says)) continue;
      const claims = MEASURED_CLAIMS.filter((claim) => claim.matches.test(line.says));
      expect(
        { at: line.where, measured: claims.length > 0 },
        `“${line.says}” makes a claim about a quantity. Add it to MEASURED_CLAIMS with the measurement that settles it.`,
      ).toEqual({ at: line.where, measured: true });

      for (const claim of claims) {
        judged += 1;
        seen.add(claim.id);
        expect(
          { at: line.where, claim: claim.id, holds: claim.holds({ line, snap, dispatch, facts: measured }) },
          `“${line.says}” — the measurement does not support it`,
        ).toEqual({ at: line.where, claim: claim.id, holds: true });
      }
    }

    expect(judged, 'the ledger reached the copy at all').toBeGreaterThan(12);
    // Every entry earns its place: a verifier for a sentence that no longer
    // ships is a rule nobody is running.
    expect([...seen].sort()).toEqual(MEASURED_CLAIMS.map((claim) => claim.id).sort());
  });
});

/* ══ 8b. THE MARK ON A REPLY, MEASURED BY DRIVING A REAL THREAD ═══════ */

/**
 * THE BLIND SPOT THAT LET THE FIFTH FALSE SENTENCE SHIP.
 *
 * Two rule families ran over this journey and neither could see this one.
 * `DESTINATION_CLAIMS` judges where a turn GOES, against a real dispatch;
 * `MEASURED_CLAIMS` judges quantities. Nothing matched /marked|labelled/, and
 * the highest-stakes sentence in the app is not about where a turn goes but
 * about whether you are TOLD where it went. Four surfaces made that claim —
 * two of them on this journey, and the welcome screen's paragraph was not even
 * collected — and all four were false at once:
 *
 *     turn 1 = REMOTE ANSWER   | provenance.local = false
 *     regenerate on the device | variants = ["REMOTE ANSWER"]
 *     press ‹                  | DOM: Qwen3 · On device · REMOTE ANSWER
 *
 * `MessageView` read the chip off the ROW while `cycleVariant` moved only the
 * TEXT, so a reply that came back from a provider was rendered under the ember
 * flame — this app's own mark for a turn that ran here — and exported as
 * "(on device)". A regex ban could not have caught it and a source read could
 * not either: the sentence was fine, the render was fine, and only the two
 * together were wrong.
 *
 * So the measurement is the whole path, driven: the shipped `send`, the
 * shipped `regenerate`, the shipped `cycleVariant`, the real `MessageView`,
 * the real `‹` button, and the chip read out of the DOM. The provenance the
 * engine reports is built from the TARGET the store handed it, so what is
 * being measured is the app's own routing decision arriving back as a label,
 * not a fixture asserting itself.
 *
 * Four readings, and the sentences are judged against all four:
 *
 *   · a reply that arrives from the provider           → "Remote"
 *   · a reply that arrives from the device             → "On device"
 *   · the same provider reply, flipped back to after a
 *     regenerate on the device                         → "Remote"
 *   · a generation the v4 upgrade recovered from a
 *     chat an older build saved                        → "" (no chip)
 *
 * THE LAST ONE IS WHY THE COPY SAYS "FROM NOW ON". An older build stored a
 * variant as a bare string, so that text's origin was never written down, and
 * `upgradeVariants` refuses to lend it the row's — an invented label is the
 * defect, not the cure. It renders unlabelled. A sentence claiming that EVERY
 * reply a thread can show is marked is therefore false, and the rule below
 * fails any marking sentence that does not carry the scope.
 */

/** The chat that can go either way: a model on the device, a provider connected. */
const EITHER_WAY = { installed: [installedRecord(QWEN)], connections: [PROVIDER] } as const;

/**
 * The engine as a mirror: it reports back the target the store chose.
 *
 * Nothing about the origin is scripted, which is the point — a fixture that
 * asserted `local: false` would be measuring itself. `resolveTarget` picks the
 * backend, `runGeneration` hands it over, and the label under test is that
 * decision coming back through `provenance`.
 */
function markingEngine(): unknown {
  return {
    async *stream({ target }: { target: { backendId: string; modelId: string; local: boolean } }) {
      yield {
        type: 'done',
        text: target.local ? 'ANSWERED HERE' : 'ANSWERED THERE',
        provenance: {
          backendId: target.backendId,
          engine: target.local ? QWEN.engine : 'remote',
          modelId: target.modelId,
          modelName: target.local ? QWEN.name : `${PROVIDER.label} · ${target.modelId}`,
          local: target.local,
        },
        stats: { promptTokens: 8, completionTokens: 4 },
      };
    },
  };
}

/** The assistant turn, rendered from the store so a click re-renders the write. */
function LiveAssistant(): ReturnType<typeof createElement> {
  const message = useChats((state) => state.messages.find((entry) => entry.role === 'assistant'))!;
  return createElement(MessageView, {
    message,
    showThinking: false,
    onRegenerate: () => {},
    onEdit: () => {},
  });
}

function assistantRow(): Message {
  const row = useChats.getState().messages.find((entry) => entry.role === 'assistant');
  expect(row, 'the turn produced an assistant row').toBeDefined();
  return row!;
}

/** What the chip beside the model's name says — "On device", "Remote", or nothing. */
function chipSays(): string {
  return text(document.querySelector('.msg__head .chip'));
}

function bodySays(): string {
  return text(document.querySelector('.msg__body'));
}

/** Put the store in a chat that will route to `pinned`, with the mirror engine. */
function armed(pinned: string): void {
  arrange({ ...EITHER_WAY, pinned });
  useApp.setState({
    engine: markingEngine() as never,
    // Markdown is lazily imported; the plain branch is the one read here.
    settings: { ...useApp.getState().settings, renderMarkdown: false },
  });
}

interface Marks {
  readonly arrivedFromProvider: string;
  readonly arrivedOnDevice: string;
  readonly regeneratedOnDevice: string;
  readonly flippedBackToTheProvider: string;
  readonly bodyFlippedBack: string;
  /** The `## Heading` the transcript gives the generation on display. */
  readonly transcriptFlippedBack: string;
  readonly originNeverRecorded: string;
  readonly bodyOriginNeverRecorded: string;
}

let marks: Marks | null = null;

async function measureTheMark(): Promise<Marks> {
  if (marks) return marks;

  /* 1. A reply that arrives from the provider, in a chat pinned to it. */
  armed(PROVIDER.id);
  await useChats.getState().send('hello');
  expect(
    ranOnDevice(assistantRow().provenance),
    'the turn really did leave the device',
  ).toBe(false);
  let arrivedFromProvider = '';
  await mounted(createElement(LiveAssistant), () => {
    arrivedFromProvider = chipSays();
  });

  /* 2. Regenerate the same turn on the device, then flip back to the first. */
  await useChats.getState().regenerate(assistantRow().id, QWEN.id);
  expect(ranOnDevice(assistantRow().provenance), 'the replacement ran here').toBe(true);

  let regeneratedOnDevice = '';
  let flippedBackToTheProvider = '';
  let bodyFlippedBack = '';
  await mounted(createElement(LiveAssistant), async () => {
    regeneratedOnDevice = chipSays();
    await click(document.querySelector('[aria-label="Previous version"]'));
    flippedBackToTheProvider = chipSays();
    bodyFlippedBack = bodySays();
  });

  // The file the user downloads is rendered from the same rows.
  const transcript = renderTranscript(
    useChats.getState().chats[0]!,
    useChats.getState().messages,
  );
  const heading = /^## (.+)$\n\nANSWERED THERE$/m.exec(transcript);
  expect(heading, 'the provider reply is in the transcript').not.toBeNull();

  /* 3. A reply that arrives from the device, in a chat pinned to the model. */
  armed(QWEN.id);
  await useChats.getState().send('hello');
  expect(ranOnDevice(assistantRow().provenance), 'this one stayed here').toBe(true);
  let arrivedOnDevice = '';
  await mounted(createElement(LiveAssistant), () => {
    arrivedOnDevice = chipSays();
  });

  /* 4. A generation recovered from a chat an older build saved. */
  armed(QWEN.id);
  const onDevice: Provenance = {
    backendId: 'llama-cpp',
    engine: QWEN.engine,
    modelId: QWEN.id,
    modelName: QWEN.name,
    reach: REACH_DEVICE,
  };
  // The exact row shape v3 wrote: the TEXT of the older generation, and the
  // newer generation's provenance on the row describing neither of them once
  // the two are separated.
  const upgraded = upgradeVariants({
    content: 'ANSWERED HERE',
    variants: ['ANSWERED THERE'],
    variantIndex: 1,
    provenance: onDevice,
  })!;
  expect(upgraded.variants[0]!.provenance, 'the upgrade invented no origin').toBeUndefined();
  const legacy: Message = {
    id: 'msg_legacy',
    chatId: 'chat_1',
    role: 'assistant',
    content: 'ANSWERED HERE',
    provenance: onDevice,
    createdAt: 2,
    variants: upgraded.variants,
    variantIndex: upgraded.variantIndex,
  };
  useChats.setState({
    messages: [
      { id: 'msg_u', chatId: 'chat_1', role: 'user', content: 'hello', createdAt: 1 },
      legacy,
    ],
  });
  await useChats.getState().cycleVariant(legacy.id, -1);

  let originNeverRecorded = '';
  let bodyOriginNeverRecorded = '';
  await mounted(createElement(LiveAssistant), () => {
    originNeverRecorded = chipSays();
    bodyOriginNeverRecorded = bodySays();
  });

  marks = {
    arrivedFromProvider,
    arrivedOnDevice,
    regeneratedOnDevice,
    flippedBackToTheProvider,
    bodyFlippedBack,
    transcriptFlippedBack: heading![1]!,
    originNeverRecorded,
    bodyOriginNeverRecorded,
  };
  return marks;
}

/**
 * A claim a sentence can make about MARKING, and what settles it.
 *
 * Same shape and same default as `MEASURED_CLAIMS`, for the same reason: a
 * sentence that says a reply is marked, with nothing measuring the mark, FAILS
 * and the failure names this ledger. That default is the whole value — the
 * sentence that shipped was one nobody had written a rule for.
 */
interface MarkingClaim {
  readonly id: string;
  readonly matches: RegExp;
  readonly holds: (ctx: { line: Line; marks: Marks; facts: Facts }) => boolean;
}

/**
 * What counts as a marking claim.
 *
 * Deliberately wider than the sentences this change wrote: any collected line
 * that says something is marked, labelled or flagged has to be settled by an
 * entry below. That is what makes the ledger a rule rather than a list — the
 * shell's "the CHAT column marks the ones that can" is caught by it too, and
 * had to be measured to get past it.
 */
const MAKES_A_MARKING_CLAIM = /\bmark(s|ed|ing)?\b|\blabell?(s|ed)?\b|\bflagg?(s|ed)?\b/i;

/** The one wording every surface on this journey uses for the one fact. */
const THE_MARKING_CLAUSE = 'every reply that comes back from a provider is marked Remote in the thread';

const MARKING_CLAIMS: readonly MarkingClaim[] = [
  {
    id: 'the mark is on the generation on display, not on the one it replaced',
    matches: /\bmarked Remote in the thread\b/,
    holds: ({ marks: m }) =>
      m.arrivedFromProvider === 'Remote' &&
      m.arrivedOnDevice === 'On device' &&
      m.regeneratedOnDevice === 'On device' &&
      // The reading this whole round exists for.
      m.flippedBackToTheProvider === 'Remote' &&
      m.bodyFlippedBack.includes('ANSWERED THERE') &&
      // And the transcript agrees with the screen, because the export is read
      // by someone who was not there when the chip was on it.
      m.transcriptFlippedBack.includes('(remote)'),
  },
  {
    id: 'the claim is scoped, because a generation with no recorded origin carries no mark',
    matches: /\bmarked Remote in the thread\b/,
    holds: ({ line, marks: m }) => {
      // Unlabelled rather than mislabelled — the upgrade will not lend the
      // row's provenance to text that did not come with any.
      if (m.originNeverRecorded !== '') return false;
      if (!m.bodyOriginNeverRecorded.includes('ANSWERED THERE')) return false;
      // So a sentence that marks a reply must say WHICH replies it speaks for.
      return /\bfrom now on\b/i.test(line.says);
    },
  },
  {
    id: 'every surface marks a reply in the same words',
    matches: /\bmarked Remote in the thread\b/,
    holds: ({ line }) => line.says.includes(THE_MARKING_CLAUSE),
  },
  {
    id: 'the CHAT column marks the models that can answer a chat',
    matches: /the CHAT column marks the ones that can/,
    holds: ({ facts }) => {
      const rows = facts.modelList.split('\n');
      const header = rows.find((row) => /\bCHAT\b/.test(row));
      if (!header) return false;
      const column = header.indexOf('CHAT');
      const cell = (id: string): string =>
        (rows.find((row) => row.startsWith(id)) ?? '').slice(column).trim().split(/\s+/)[0] ?? '';
      // Whichever glyphs it uses, the two kinds must not read the same.
      return cell(QWEN.id) !== '' && cell(QWEN.id) !== cell(WHISPER.id);
    },
  },
];

describe('the mark on a reply, measured by driving a real thread', () => {
  it('follows the generation on display through regenerate, cycle and export', async () => {
    const m = await measureTheMark();
    expect(m).toEqual({
      arrivedFromProvider: 'Remote',
      arrivedOnDevice: 'On device',
      regeneratedOnDevice: 'On device',
      flippedBackToTheProvider: 'Remote',
      bodyFlippedBack: 'ANSWERED THERE',
      transcriptFlippedBack: `${PROVIDER.label} · ${PROVIDER.defaultModel} (remote)`,
      // The one gap the copy is scoped around, stated as a measurement rather
      // than as a comment: no chip, and no model name borrowed from the row.
      originNeverRecorded: '',
      bodyOriginNeverRecorded: 'ANSWERED THERE',
    });
  });

  it('is claimed by no sentence that this file cannot settle', async () => {
    const { arrangements, standing } = await walk();
    const m = await measureTheMark();
    const measured = await facts();
    const seen = new Set<string>();
    let judged = 0;

    const everywhere = [
      ...Object.values(arrangements).flatMap((collected) => collected.lines),
      ...standing,
    ];

    for (const line of everywhere) {
      if (!MAKES_A_MARKING_CLAIM.test(line.says)) continue;
      const claims = MARKING_CLAIMS.filter((claim) => claim.matches.test(line.says));
      expect(
        { at: line.where, measured: claims.length > 0 },
        `“${line.says}” says something is marked. Add it to MARKING_CLAIMS with the measurement that settles it.`,
      ).toEqual({ at: line.where, measured: true });

      for (const claim of claims) {
        judged += 1;
        seen.add(claim.id);
        expect(
          { at: line.where, claim: claim.id, holds: claim.holds({ line, marks: m, facts: measured }) },
          `“${line.says}” — the measurement does not support it`,
        ).toEqual({ at: line.where, claim: claim.id, holds: true });
      }
    }

    // The four surfaces that say it, times the three rules that judge them,
    // plus the shell's own use of the word. A rule that reached nothing, or a
    // surface that quietly stopped saying it, fails here.
    expect(judged, 'the marking ledger reached the copy at all').toBeGreaterThan(12);
    expect([...seen].sort()).toEqual(MARKING_CLAIMS.map((claim) => claim.id).sort());
  });

  /**
   * A FIFTH SURFACE SAYS IT AND THIS FILE DOES NOT REACH IT.
   *
   * `src/features/settings/SettingsScreen.tsx` ships "every reply that came
   * from one is marked in the thread" — the same fact, a sixth wording, and
   * unscoped. It is not on the model-selection journey and is not this
   * change's file, so it is not collected here; the assertion below names
   * exactly what IS collected rather than implying the set is complete. When
   * that sentence is brought into line, add the settings sheet to
   * `collectStandingSurfaces` and this list grows by one — which is the point
   * of pinning the list rather than a count.
   */
  it('is said in one wording by every surface this file collects', async () => {
    const { arrangements, standing } = await walk();
    const said = [
      ...Object.values(arrangements).flatMap((collected) => collected.lines),
      ...standing,
    ].filter((line) => line.says.includes(THE_MARKING_CLAUSE));

    // Both branches of `startProse`, and both paragraphs of the welcome
    // screen — the four this file reaches. Three rounds of this repair
    // produced three false sentences, and every one came from two surfaces
    // stating one fact separately.
    expect(said.map((line) => line.where).sort()).toEqual([
      'onboarding.privacy',
      'onboarding.remoteAlternative',
      'start.body',
      'start.body',
    ]);
  });
});

/* ══ 9. One rule, four authors ════════════════════════════════════════ */

/**
 * The vocabulary was arrived at by luck, and two collisions survived it: the
 * option that names a stranded pin was `disabled` in one control and not the
 * other, and the role clause was composed with an em dash in one place and
 * without it everywhere else. Both are pinned here, in one test, across both
 * controls, so the next divergence fails rather than shipping.
 */
describe('the same rule, applied the same way by every surface', () => {
  it('states a stranded pin in both pickers, and offers it back in neither', async () => {
    for (const pinned of [WHISPER, ABSENT]) {
      const installed =
        pinned === WHISPER
          ? [installedRecord(WHISPER), installedRecord(QWEN)]
          : [installedRecord(QWEN)];

      arrange({ installed, connections: [], pinned: pinned.id });
      const chat: { label: string; disabled: boolean; selected: boolean }[] = [];
      await mounted(createElement(ChatScreen), async () => {
        await click(document.querySelector('[aria-label="Chat settings"]'));
        const select = document.querySelector('#chat-model') as HTMLSelectElement;
        const option = select.selectedOptions[0]!;
        chat.push({ label: text(option), disabled: option.disabled, selected: option.selected });
        expect(select.value, 'the control agrees with the record').toBe(pinned.id);
      });

      arrange({ installed, connections: [] });
      const persona: { label: string; disabled: boolean; selected: boolean }[] = [];
      await mounted(
        createElement(PersonaEditor, { persona: personaPreferring(pinned.id), onClose: () => {} }),
        () => {
          const select = document.querySelector('#persona-model') as HTMLSelectElement;
          const option = select.options[select.selectedIndex]!;
          persona.push({ label: text(option), disabled: option.disabled, selected: option.selected });
          expect(select.value, 'the control agrees with the record').toBe(pinned.id);
        },
      );

      // Selectedness and selectability are different things, and BOTH controls
      // have to make that distinction the same way: the record is displayed,
      // and cannot be chosen again from the sheet that just refused it.
      for (const [control, [read]] of [
        ['chat settings', chat],
        ['persona editor', persona],
      ] as const) {
        expect({ control, pin: pinned.id, ...read! }).toEqual({
          control,
          pin: pinned.id,
          label: read!.label,
          disabled: true,
          selected: true,
        });
        // Both controls identify the record. WHICH identifier they reach for
        // is where they still differ — pinned in the next test rather than
        // waved through here.
        expect(
          read!.label.includes(pinned.name) || read!.label.includes(pinned.id),
          `${control} names the record`,
        ).toBe(true);
      }

      // And when the reason is the role, both say it in the same words.
      if (!canChat(pinned)) {
        expect(chat[0]!.label).toBe(persona[0]!.label);
        expect(chat[0]!.label).toBe(`${pinned.name} ${nonChatRole(pinned)}`);
      }
    }
  });

  /**
   * THE DIVERGENCE THAT IS LEFT, WRITTEN DOWN RATHER THAN ASSERTED AWAY.
   *
   * For a chat model that is in the catalogue and simply not downloaded, the
   * two controls name the same record differently: `orphanOption`'s last
   * branch prints the raw id, on the argument that "it is the only fact left",
   * while `strandedLabel` falls back through `catalogEntry(modelId)?.name` and
   * prints the human name. For an id from a build that had it, the id really
   * is all there is and the two agree; for a catalogue entry the chat sheet is
   * strictly less informative than the persona sheet about the same pin.
   *
   * Neither sentence is false, so this test states what each says instead of
   * failing one of them. It is pinned so the difference cannot widen quietly,
   * and it is a handoff: `orphanOption` lives in a file this change may not
   * touch, and consulting the catalogue there would make the two agree.
   */
  it('differs, still, in which identifier each control reaches for', async () => {
    arrange({ installed: [installedRecord(QWEN)], connections: [], pinned: ABSENT.id });
    let fromChat = '';
    await mounted(createElement(ChatScreen), async () => {
      await click(document.querySelector('[aria-label="Chat settings"]'));
      fromChat = text((document.querySelector('#chat-model') as HTMLSelectElement).selectedOptions[0]);
    });

    arrange({ installed: [installedRecord(QWEN)], connections: [] });
    let fromPersona = '';
    await mounted(
      createElement(PersonaEditor, { persona: personaPreferring(ABSENT.id), onClose: () => {} }),
      () => {
        const select = document.querySelector('#persona-model') as HTMLSelectElement;
        fromPersona = text(select.options[select.selectedIndex]);
      },
    );

    expect({ fromChat, fromPersona }).toEqual({
      fromChat: `${ABSENT.id} — not on this device`,
      fromPersona: `${ABSENT.name} — not installed`,
    });
    // What they must NOT do is disagree about the record itself.
    expect(catalogEntry(ABSENT.id)?.name).toBe(ABSENT.name);
  });

  it('uses one clause for the chat refusal on every surface that states it', async () => {
    const { arrangements, standing } = await walk();
    const said = [...arrangements.refused!.lines, ...standing];

    for (const where of [
      'rail.chip',
      'send.toast',
      'models.setActive.toast',
      'shell.model-use',
      'modelDetail.hint',
    ]) {
      const line = said.find((entry) => entry.where === where);
      expect(line, `${where} is collected`).toBeTruthy();
      expect(line!.says, `${where} borrows the engine's own words`).toContain(
        'cannot answer a chat',
      );
    }
  });

  it('recommends only a model that can chat, and measures every clause it adds', async () => {
    const measured = await facts();

    for (const memory of MEMORY_READINGS) {
      const pick = recommendModel(CATALOG, memory > 0 ? memory : undefined)!;
      const note = fitNote(pick, CATALOG, memory > 0 ? device(memory) : null);

      expect(canChat(pick.manifest), `${formatBytes(memory, 0)} is offered a chat model`).toBe(true);

      // The floor clause appears when, and only when, it is true. The sentence
      // it replaced asserted this comparison without making it.
      expect(
        { memory, says: note.includes('is smaller') },
        `the floor clause must track the catalogue, not the copy`,
      ).toEqual({ memory, says: pick.manifest.id === measured.smallestChatModel.id });

      // And the arithmetic in the tight branch is the device's, not a guess.
      if (memory > 0 && pick.fit === 'tight') {
        expect(note).toContain(`It needs ${formatBytes(pick.manifest.minRAM, 0)}`);
        expect(note).toContain(`this device has ${formatBytes(memory, 0)}`);
        expect(note.includes('it will run')).toBe(memory >= pick.manifest.minRAM);
      }
    }
  });
});

/* ══ 10. The collector reaches every author of a sentence ═════════════ */

/**
 * The reason the rule kept being broken is that the collector reached one path
 * out of eleven. This asserts the reach directly: every function that composes
 * a sentence on this journey has its output somewhere in what was collected —
 * so deleting a surface from the collector, or routing a screen through a new
 * copy function, fails here rather than quietly narrowing the rules again.
 */
describe('the reach of the collector', () => {
  it('has collected the output of every copy function on the journey', async () => {
    const { arrangements, standing } = await walk();
    const everything = [
      ...Object.values(arrangements).flatMap((collected) => collected.lines),
      ...standing,
    ].map((line) => line.says);

    const whisper = installedRecord(WHISPER);
    const absent = { ...installedRecord(ABSENT), state: 'downloading' as const };

    const authored: Record<string, string> = {
      refusalCopy: refusalCopy(whisper).body,
      'startProse(local)': startProse({ kind: 'local', model: installedRecord(QWEN) })!.body,
      'startProse(remote)': startProse({ kind: 'remote', provider: PROVIDER })!.body,
      'startStateCopy(nothing)': startStateCopy([]).body,
      'startStateCopy(non-chat)': startStateCopy([whisper]).body,
      'pickerEmptyCopy(nothing)': pickerEmptyCopy([]),
      'pickerEmptyCopy(non-chat)': pickerEmptyCopy([whisper]),
      orphanOption: orphanOption(WHISPER.id, [], whisper, [])!.label,
      nonBenchmarkableReason: nonBenchmarkableReason(WHISPER),
      nonChatRole: nonChatRole(WHISPER),
    };

    for (const [author, sentence] of Object.entries(authored)) {
      expect(
        { author, reached: everything.some((said) => said.includes(sentence)) },
        `${author} composes a sentence this file never collected`,
      ).toEqual({ author, reached: true });
    }

    // `strandedLabel` is not exported, which is why it is only ever reached by
    // rendering — and why the em-dash drift in it survived a green suite.
    expect(everything).toContain(`${WHISPER.name} ${nonChatRole(WHISPER)}`);
    expect(everything.some((said) => said.includes(`${ABSENT.name} — not installed`))).toBe(true);
    expect(orphanOption(ABSENT.id, [], absent, [])!.label).toBe(
      `${ABSENT.name} — not finished downloading`,
    );
  });
});
