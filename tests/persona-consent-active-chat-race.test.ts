/**
 * THE CONSENT SHEET IS A REAL WAIT ON A REAL PERSON (adversarial review,
 * HIGH, refs #23, #122).
 *
 * `runGeneration`'s checkpoint says, in its own comment, "nothing below
 * waits before that" — and then an `await app.requestApproval(...)` was
 * added below it. Everything that checkpoint verified (this chat still
 * exists, is still the one on screen, has not been stopped) can change
 * while a person is looking at the sheet: they can open a different chat,
 * delete this one, or press Stop. Measured without a re-check: start a send
 * in chat A while its persona's provider needs consent, switch to chat B
 * while the sheet is still up, answer Allow — chat A's reply lands in
 * `messages`, which by then is chat B's live array on screen.
 *
 * Driven with a `requestApproval` stub that genuinely pauses — a promise
 * this file controls the settlement of — so the race is exercised for real,
 * not simulated by calling things in a convenient order.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ApprovalPrompt } from '@/state/app';
import type { ProviderConnection } from '@/ai/providers';
import type { CharacterCardV2 } from '@/domain/persona';

const tables = vi.hoisted(() => ({
  chats: { put: vi.fn(async () => {}), delete: vi.fn(async () => {}), toArray: async () => [] },
  messages: {
    put: vi.fn(async () => {}),
    delete: vi.fn(async () => {}),
    where: () => ({ equals: () => ({ sortBy: async () => [], toArray: async () => [] }) }),
  },
  models: { put: vi.fn(async () => {}), delete: vi.fn(async () => {}), toArray: async () => [] },
  settings: {
    get: vi.fn(async () => undefined),
    put: vi.fn(async () => {}),
    toArray: vi.fn(async (): Promise<{ key: string; value: unknown }[]> => []),
    delete: vi.fn(async () => {}),
  },
  connections: { put: vi.fn(async () => {}), delete: vi.fn(async () => {}), toArray: async () => [] },
  personas: { put: vi.fn(async () => {}), delete: vi.fn(async () => {}), toArray: async () => [] },
}));

vi.mock('@/db', () => ({
  db: tables,
  deleteChat: vi.fn(async () => {}),
  readSetting: async (_key: string, fallback: unknown) => fallback,
  writeSetting: vi.fn(async () => {}),
}));

const { useChats } = await import('@/state/chat');
const { useApp } = await import('@/state/app');
const { useModels } = await import('@/state/models');
const { usePersonas } = await import('@/state/personas');
const { useProviderConsent } = await import('@/state/provider-consent');

const ANTHROPIC: ProviderConnection = {
  id: 'conn_anthropic',
  providerId: 'anthropic',
  label: 'Anthropic',
  apiKey: '',
  baseUrl: '',
  defaultModel: 'claude-haiku',
  enabled: true,
  models: [],
  createdAt: 0,
};

function importedCard(name: string): CharacterCardV2 {
  return {
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: {
      name,
      extensions: {
        chatterang: {
          schemaVersion: 1,
          agentConfig: { provider: { kind: 'remote-connection', connectionId: 'conn_anthropic' } },
        },
      },
    },
  };
}

/** A promise this test controls the settlement of, plus a way to resolve it. */
function gate(): { promise: Promise<boolean>; resolve: (value: boolean) => void } {
  let resolve = (_value: boolean): void => {};
  const promise = new Promise<boolean>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

let seenTargets: Record<string, unknown>[];
let requested: { action: string; prompt?: ApprovalPrompt }[];

function installRecordingEngine(): void {
  seenTargets = [];
  useApp.setState({
    toasts: [],
    engine: {
      async *stream({ target }: { target: Record<string, unknown> }) {
        seenTargets.push({ ...target });
        yield { type: 'done', text: 'ok', provenance: target, stats: { promptTokens: 0, completionTokens: 0 } };
      },
    } as never,
  });
}

/** Pauses genuinely on the FIRST call, recording it; answers every later call immediately with `answer`. */
function pausingApproval(answer: boolean) {
  requested = [];
  const first = gate();
  let calls = 0;
  useApp.setState({
    requestApproval: async (action: string, prompt?: ApprovalPrompt) => {
      requested.push({ action, prompt });
      calls += 1;
      if (calls === 1) return first.promise;
      return answer;
    },
  });
  return { releaseFirst: () => first.resolve(answer) };
}

/**
 * Waits until `requestApproval` has genuinely been reached — the exact
 * moment the reviewer's repro means by "once requestApproval is invoked" —
 * rather than assuming the ordering. `send`/`regenerate`/`editMessage` cross
 * several microtask hops (each mocked `db.*.put` awaited) before reaching
 * the consent block; racing a chat switch against that without waiting is a
 * coin flip on which side of `runGeneration`'s OWN pre-existing
 * `activeChatId` checkpoint (line ~1461, unrelated to this fix) the switch
 * lands on, which would test the wrong thing — that older checkpoint
 * already catches a switch made before the consent block is ever reached.
 */
async function waitForApprovalRequested(): Promise<void> {
  for (let i = 0; i < 1000 && requested.length === 0; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  expect(requested.length, 'requestApproval was never reached').toBeGreaterThan(0);
}

beforeEach(async () => {
  useModels.setState({ activeModelId: null, installed: {} });
  useApp.setState({ connections: [ANTHROPIC] });
  usePersonas.setState({ byId: {}, order: [] } as never);
  useProviderConsent.setState({ granted: {} });
  useChats.setState({ chats: [], messages: [], activeChatId: null } as never);
});

describe('switching chats while the consent sheet is open', () => {
  it('does NOT let chat A’s reply land in chat B’s live messages', async () => {
    const personaId = await usePersonas.getState().importCard(importedCard('A’s Persona'));
    installRecordingEngine();
    const { releaseFirst } = pausingApproval(true);

    await useChats.getState().newChat({ personaId });
    const chatA = useChats.getState().activeChatId!;

    // Starts the send; it will pause inside `requestApproval` before it ever
    // reaches `resolveTarget` — nothing has been sent yet.
    const sendPromise = useChats.getState().send('hello from A');
    await waitForApprovalRequested();

    // The sheet is up. The person looks at a different chat instead of
    // answering it right away.
    await useChats.getState().newChat({});
    const chatB = useChats.getState().activeChatId!;
    expect(chatB).not.toBe(chatA);

    // NOW they answer Allow.
    releaseFirst();
    await sendPromise;

    // Chat A's turn must not have reached the engine at all — activeChatId
    // had already moved on by the time consent was answered.
    expect(seenTargets).toHaveLength(0);

    // And nothing of A's is sitting in B's live array.
    const bMessages = useChats.getState().messages;
    expect(bMessages.some((message) => message.content === 'hello from A')).toBe(false);
    expect(bMessages.some((message) => message.role === 'assistant')).toBe(false);
  });

  it('(paired) answering promptly, with no chat switch, still routes normally', async () => {
    const personaId = await usePersonas.getState().importCard(importedCard('Prompt Persona'));
    installRecordingEngine();
    useApp.setState({ requestApproval: async () => true });

    await useChats.getState().newChat({ personaId });
    await useChats.getState().send('hello');

    expect(seenTargets).toHaveLength(1);
    expect(seenTargets[0]?.backendId).toBe(ANTHROPIC.id);
  });

  it('deleting chat A while its consent sheet is open sends nothing there either', async () => {
    const personaId = await usePersonas.getState().importCard(importedCard('Deleted Persona'));
    installRecordingEngine();
    const { releaseFirst } = pausingApproval(true);

    await useChats.getState().newChat({ personaId });
    const chatA = useChats.getState().activeChatId!;
    const sendPromise = useChats.getState().send('hello');
    await waitForApprovalRequested();

    // `removeChat` aborts every live turn for that chat id, which is what
    // the sheet's own `signal.addEventListener('abort', ...)` (state/app.ts)
    // already takes down on — this is the pre-existing "Stop takes the sheet
    // down" rule (#92, ruling OD7), reused here rather than duplicated.
    useChats.getState().removeChat(chatA);
    releaseFirst();
    await sendPromise;

    expect(seenTargets).toHaveLength(0);
  });
});

describe('regenerate and editMessage go through the same re-check', () => {
  it('regenerate: a chat switch during consent drops the regenerated reply, not into the new chat', async () => {
    const personaId = await usePersonas.getState().importCard(importedCard('Regen Persona'));
    // A first, ordinary turn already on the thread — answered instantly, no
    // consent race — so there is an assistant message to regenerate.
    useApp.setState({ requestApproval: async () => true });
    installRecordingEngine();
    await useChats.getState().newChat({ personaId });
    const chatA = useChats.getState().activeChatId!;
    await useChats.getState().send('first');
    const assistantId = useChats.getState().messages.find((m) => m.role === 'assistant')!.id;

    // Consent revoked, so regenerating asks again — this time paused.
    await useProviderConsent.getState().revoke(personaId, 'conn_anthropic');
    const { releaseFirst } = pausingApproval(true);
    seenTargets = [];
    const regenPromise = useChats.getState().regenerate(assistantId);
    await waitForApprovalRequested();

    await useChats.getState().newChat({});
    const chatB = useChats.getState().activeChatId!;
    expect(chatB).not.toBe(chatA);

    releaseFirst();
    await regenPromise;

    expect(seenTargets).toHaveLength(0);
    expect(useChats.getState().messages.some((m) => m.id === assistantId)).toBe(false);
  });

  it('editMessage: a chat switch during consent drops the re-generated reply, not into the new chat', async () => {
    const personaId = await usePersonas.getState().importCard(importedCard('Edit Persona'));
    useApp.setState({ requestApproval: async () => true });
    installRecordingEngine();
    await useChats.getState().newChat({ personaId });
    const chatA = useChats.getState().activeChatId!;
    await useChats.getState().send('first');
    await useChats.getState().send('second');
    const firstUserId = useChats.getState().messages.find((m) => m.role === 'user')!.id;

    await useProviderConsent.getState().revoke(personaId, 'conn_anthropic');
    const { releaseFirst } = pausingApproval(true);
    seenTargets = [];
    const editPromise = useChats.getState().editMessage(firstUserId, 'first, edited');
    await waitForApprovalRequested();

    await useChats.getState().newChat({});
    const chatB = useChats.getState().activeChatId!;
    expect(chatB).not.toBe(chatA);

    releaseFirst();
    await editPromise;

    expect(seenTargets).toHaveLength(0);
  });
});
