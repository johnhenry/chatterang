/**
 * Conversation state and the generation loop.
 *
 * This is where a thread becomes an IR request: persona system prompt, lore,
 * history, attachments, sampler, and tools are assembled here and handed to
 * the engine. Everything below this point is provider-agnostic.
 */

import { create } from 'zustand';

import { blobToBase64 } from '@/lib/blobs';
import { db, deleteChat } from '@/db';
import {
  applyVariant,
  currentVariant,
  deriveTitle,
  displaysUnrecorded,
  newId,
  splitThinking,
  REACH_DEVICE,
  REACH_REMOTE,
  type Attachment,
  type Chat,
  type ChatMode,
  type EgressGrant,
  type Message,
  type MessageVariant,
  type ToolInvocation,
} from '@/domain/chat';
import { renderLore, renderSystemPrompt, selectLore } from '@/domain/persona';
import {
  DEFAULT_SAMPLER,
  canChat,
  nonChatRole,
  type SamplerSettings,
} from '@/domain/manifest';
import type { IRMessage, MessageContent } from '@johnhenry/aimatey-types';
import {
  runsOnThisDevice,
  targetFor,
  type EngineTarget,
  type ToolEgressPolicy,
} from '@/ai/engine';
import { markTainted } from '@/ai/taint';
import { toolRegistry } from '@/ai/tools/registry';
import {
  contextBudget,
  estimateConversationTokens,
  fitToContext,
  type FitResult,
} from '@/ai/context';
import { installEgressRevoker, useApp } from '@/state/app';
import { useModels } from '@/state/models';
import { usePersonas } from '@/state/personas';

/**
 * Hard ceiling on turns considered, before token budgeting narrows it further.
 * This is a cheap guard against pathological histories; `fitToContext` does
 * the real work.
 */
const HISTORY_TURNS = 64;

/** What the current thread costs against the model's context window. */
export interface ContextUsage {
  /** Tokens the next prompt is expected to occupy. */
  readonly used: number;
  /** The model's full window. */
  readonly contextLength: number;
  /** History messages dropped to make the prompt fit. */
  readonly dropped: number;
  /** True when even the system prompt and question exceed the window. */
  readonly overflowed: boolean;
  /** True once `used` came from the engine rather than an estimate. */
  readonly measured: boolean;
}

interface ChatState {
  loaded: boolean;
  chats: Chat[];
  activeChatId: string | null;
  messages: Message[];
  generating: boolean;
  /** Live context accounting for the open chat. */
  context: ContextUsage | null;
  /** Controller for the in-flight generation, so it can be stopped. */
  controller: AbortController | null;

  load: () => Promise<void>;
  openChat: (chatId: string) => Promise<void>;
  newChat: (options?: { mode?: ChatMode; personaId?: string | null }) => Promise<string>;
  removeChat: (chatId: string) => Promise<void>;
  renameChat: (chatId: string, title: string) => Promise<void>;
  togglePin: (chatId: string) => Promise<void>;
  updateChat: (chatId: string, patch: Partial<Chat>) => Promise<void>;
  /** Let this conversation send tool output to one connection, until revoked. */
  grantEgress: (chatId: string, connectionId: string) => Promise<void>;
  /**
   * Drop grants for a connection, across every conversation.
   *
   * Called when a connection is removed or switched off, for the same reason
   * `app.removeConnection` already clears `fallbackBackendId`: a permission
   * that outlived the thing it was granted to would silently apply to whatever
   * next claimed that id.
   */
  revokeEgress: (connectionId: string, chatId?: string) => Promise<void>;

  refreshContext: () => void;
  send: (text: string, attachments?: Attachment[]) => Promise<void>;
  stop: () => void;
  regenerate: (messageId: string, overrideModelId?: string) => Promise<void>;
  editMessage: (messageId: string, text: string) => Promise<void>;
  deleteMessage: (messageId: string) => Promise<void>;
  cycleVariant: (messageId: string, direction: 1 | -1) => Promise<void>;
}

export const useChats = create<ChatState>((set, get) => ({
  loaded: false,
  chats: [],
  activeChatId: null,
  messages: [],
  generating: false,
  context: null,
  controller: null,

  async load() {
    const chats = await db.chats.orderBy('updatedAt').reverse().toArray();
    set({ loaded: true, chats: sortChats(chats) });
  },

  async openChat(chatId) {
    const messages = await db.messages.where('chatId').equals(chatId).sortBy('createdAt');
    set({ activeChatId: chatId, messages });
    get().refreshContext();
  },

  /**
   * Re-estimate what the next prompt will cost. Cheap enough to run on every
   * thread change, and it is what drives the context readout in the rail.
   */
  async refreshContext() {
    const chatId = get().activeChatId;
    const chat = chatId ? get().chats.find((entry) => entry.id === chatId) : undefined;
    if (!chat) {
      set({ context: null });
      return;
    }

    const models = useModels.getState();
    const modelId = chat.modelId ?? models.activeModelId;
    const manifest = modelId ? models.installed[modelId]?.manifest : undefined;
    if (!manifest) {
      set({ context: null });
      return;
    }

    const built = await buildMessages(chat, get().messages, 0, modelId as string);
    set({
      context: {
        used: built.fit.estimatedTokens,
        contextLength: manifest.contextLength,
        dropped: built.fit.dropped,
        overflowed: built.fit.overflowed,
        measured: false,
      },
    });
  },

  async newChat(options = {}) {
    const personas = usePersonas.getState();
    const personaId = options.personaId ?? personas.defaultPersonaId;
    const persona = personaId ? personas.byId[personaId] : undefined;
    const settings = useApp.getState().settings;

    const chat: Chat = {
      id: newId('chat'),
      title: options.mode === 'task' ? 'Task' : 'New chat',
      mode: options.mode ?? 'chat',
      personaId: personaId ?? null,
      modelId: persona?.preferredModelId ?? useModels.getState().activeModelId,
      sampler: null,
      // A persona may PREFER tools; it may not grant the sensitive ones. `bash`
      // reaches this app's own data and every MCP tool leaves the sandbox, so
      // those stay a decision the user makes in the tool picker. Round 3
      // verified both supply routes are closed today — MARKETPLACE is a static
      // in-repo array and `fromCharacterCard` never sets `tools` — so this is
      // the guard that keeps a future import route from being a privilege
      // escalation rather than a fix for a live leak.
      tools: unsensitive(persona?.tools),
      showThinking: persona?.showThinking ?? settings.showThinking,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messageCount: 0,
      preview: '',
    };

    await db.chats.put(chat);
    set({ chats: sortChats([chat, ...get().chats]), activeChatId: chat.id, messages: [] });

    // A character's greeting is part of the character, so it is written into
    // the thread rather than generated.
    if (persona?.firstMessage) {
      const greeting: Message = {
        id: newId('msg'),
        chatId: chat.id,
        role: 'assistant',
        content: persona.firstMessage.replaceAll('{{char}}', persona.name).replaceAll('{{user}}', 'you'),
        createdAt: Date.now(),
      };
      await db.messages.put(greeting);
      set({ messages: [greeting] });
    }

    return chat.id;
  },

  async removeChat(chatId) {
    await deleteChat(chatId);
    const chats = get().chats.filter((chat) => chat.id !== chatId);
    set({
      chats,
      ...(get().activeChatId === chatId ? { activeChatId: null, messages: [] } : {}),
    });
  },

  async renameChat(chatId, title) {
    await get().updateChat(chatId, { title });
  },

  async togglePin(chatId) {
    const chat = get().chats.find((entry) => entry.id === chatId);
    if (chat) await get().updateChat(chatId, { pinned: !chat.pinned });
  },

  async updateChat(chatId, patch) {
    const chat = get().chats.find((entry) => entry.id === chatId);
    if (!chat) return;
    const updated = { ...chat, ...patch, updatedAt: Date.now() };
    await db.chats.put(updated);
    set({
      chats: sortChats(get().chats.map((entry) => (entry.id === chatId ? updated : entry))),
    });
  },

  async grantEgress(chatId, connectionId) {
    const chat = get().chats.find((entry) => entry.id === chatId);
    if (!chat) return;
    if (chat.egressGrants?.some((grant) => grant.connectionId === connectionId)) return;
    const egressGrants: EgressGrant[] = [
      ...(chat.egressGrants ?? []),
      { connectionId, grantedAt: Date.now() },
    ];
    await get().updateChat(chatId, { egressGrants });
  },

  async revokeEgress(connectionId, chatId) {
    const affected = get().chats.filter(
      (chat) =>
        (chatId === undefined || chat.id === chatId) &&
        chat.egressGrants?.some((grant) => grant.connectionId === connectionId),
    );
    for (const chat of affected) {
      await get().updateChat(chat.id, {
        egressGrants: (chat.egressGrants ?? []).filter(
          (grant) => grant.connectionId !== connectionId,
        ),
      });
    }
  },

  async send(text, attachments = []) {
    const chatId = get().activeChatId;
    if (!chatId || get().generating) return;

    const chat = get().chats.find((entry) => entry.id === chatId);
    if (!chat) return;

    const userMessage: Message = {
      id: newId('msg'),
      chatId,
      role: 'user',
      content: text,
      attachments: attachments.length > 0 ? attachments : undefined,
      createdAt: Date.now(),
    };

    await db.messages.put(userMessage);
    set({ messages: [...get().messages, userMessage] });

    if (chat.messageCount === 0 || chat.title === 'New chat' || chat.title === 'Task') {
      await get().updateChat(chatId, { title: deriveTitle(text) });
    }
    await get().updateChat(chatId, {
      messageCount: chat.messageCount + 1,
      preview: text.slice(0, 120),
    });

    await runGeneration(set, get, { chatId });
  },

  stop() {
    get().controller?.abort();
  },

  async regenerate(messageId, overrideModelId) {
    if (get().generating) return;

    const messages = get().messages;
    const index = messages.findIndex((message) => message.id === messageId);
    if (index === -1) return;

    const target = messages[index];
    if (!target || target.role !== 'assistant') return;

    // Everything after this assistant turn is discarded; the turn itself is
    // kept so its previous text becomes a variant the user can flip back to.
    const removed = messages.slice(index + 1);
    for (const message of removed) await db.messages.delete(message.id);

    const chatId = get().activeChatId;
    if (!chatId) return;

    set({ messages: messages.slice(0, index) });
    await runGeneration(set, get, {
      chatId,
      overrideModelId,
      // Not `target.content`. What is carried forward is the whole generation
      // — where it ran, what tools it used, what it cost — because the text
      // alone is what let the new turn's chip end up over the old turn's
      // words.
      previousVariants: generationsSoFar(target),
      replaceMessageId: target.id,
    });
    await db.messages.delete(target.id);
  },

  async editMessage(messageId, text) {
    const messages = get().messages;
    const index = messages.findIndex((message) => message.id === messageId);
    if (index === -1) return;

    const message = messages[index];
    if (!message) return;

    const updated = editedVariant(message, text);
    await db.messages.put(updated);

    // Editing a user turn invalidates everything after it.
    const after = messages.slice(index + 1);
    if (message.role === 'user' && after.length > 0) {
      for (const stale of after) await db.messages.delete(stale.id);
      set({ messages: [...messages.slice(0, index), updated] });
      const chatId = get().activeChatId;
      if (chatId) await runGeneration(set, get, { chatId });
      return;
    }

    set({ messages: messages.map((entry) => (entry.id === messageId ? updated : entry)) });
  },

  async deleteMessage(messageId) {
    await db.messages.delete(messageId);
    set({ messages: get().messages.filter((message) => message.id !== messageId) });
  },

  async cycleVariant(messageId, direction) {
    const message = get().messages.find((entry) => entry.id === messageId);
    // A row that is still streaming has no record of its own generation yet —
    // `done` writes one and overwrites the row wholesale — so there is nothing
    // coherent to move between. The arrows are not rendered then either.
    if (!message || message.streaming) return;

    const variants = message.variants;
    if (!variants || variants.length < 2) return;

    // Clamped rather than trusted: while a regenerated turn is in flight its
    // index points one past the end, at the generation being made.
    const current = Math.min(message.variantIndex ?? variants.length - 1, variants.length - 1);
    const next = (current + direction + variants.length) % variants.length;

    // One call, so text and provenance cannot part company here. This is the
    // line the defect was on.
    const updated = applyVariant(message, next);
    await db.messages.put(updated);
    set({ messages: get().messages.map((entry) => (entry.id === messageId ? updated : entry)) });
  },
}));

/**
 * Rewrite a message's text, keeping the row and its variant list in agreement.
 *
 * The third writer of `content`, and the last one that could put the row out
 * of step with `variants[variantIndex]`. Today only user turns reach it — the
 * edit button is rendered on the user branch alone — and a user turn has no
 * variants, so this is the guard rather than a behaviour anyone sees.
 *
 * When there IS a list, the edited text replaces the generation on display and
 * that generation becomes `unrecorded`, because it is no longer a generation:
 * a model did not write these words, so no model may be named beside them and
 * no tok/s claimed for them. The turn then counts as tool-derived for taint,
 * which is the right way round — the text it was edited from may have been.
 */
function editedVariant(message: Message, text: string): Message {
  const index = message.variantIndex;
  const variants = message.variants;
  if (!variants || index === undefined || !variants[index]) {
    return { ...message, content: text };
  }
  return applyVariant(
    {
      ...message,
      variants: variants.map((variant, at) =>
        at === index ? { content: text, unrecorded: true } : variant,
      ),
    },
    index,
  );
}

/**
 * Every generation this turn has had, oldest first.
 *
 * A row that has already been regenerated carries the complete list — the one
 * on display is in it — so there is nothing to append. A row that has not is
 * its own only generation. Empty text is dropped: a turn that failed before it
 * wrote anything is not a version anyone can flip back to.
 */
function generationsSoFar(target: Message): MessageVariant[] {
  const all = target.variants ?? [currentVariant(target)];
  return all.filter((variant) => variant.content.length > 0);
}

/* ── Generation ─────────────────────────────────────────────────────── */

interface RunOptions {
  chatId: string;
  overrideModelId?: string;
  /** Complete generations this turn has already had — see `generationsSoFar`. */
  previousVariants?: MessageVariant[];
  replaceMessageId?: string;
}

async function runGeneration(
  set: (partial: Partial<ChatState>) => void,
  get: () => ChatState,
  options: RunOptions,
): Promise<void> {
  const app = useApp.getState();
  const engine = app.engine;
  if (!engine) {
    app.toast('The engine is still starting up.', 'warn');
    return;
  }

  const chat = get().chats.find((entry) => entry.id === options.chatId);
  if (!chat) return;

  const choice = resolveTarget(chat, options.overrideModelId);
  if (choice.kind === 'none') {
    app.toast('Choose a model first — none is installed or connected yet.', 'warn');
    return;
  }
  if (choice.kind === 'refused') {
    // Refused before anything is spent: no placeholder message, no activity
    // spinner, and no `noteUse` — a turn that never ran is not a use of the
    // model, and counting it would push a speech model up the "recently used"
    // ordering that the pickers sort by.
    app.toast(choice.message, 'warn');
    return;
  }
  const { target } = choice;

  const controller = new AbortController();
  const placeholder: Message = {
    id: newId('msg'),
    chatId: chat.id,
    role: 'assistant',
    content: '',
    createdAt: Date.now(),
    streaming: true,
    variants: options.previousVariants,
    // One past the end while this generation is being made: the row IS the
    // generation, and its record is appended by `done`.
    variantIndex: options.previousVariants?.length,
  };

  set({ generating: true, controller, messages: [...get().messages, placeholder] });
  app.setActivity(runsOnThisDevice(target) ? 'loading' : 'remote');

  const started = performance.now();
  let raw = '';
  let toolCalls: ToolInvocation[] = [];
  let firstDelta = true;

  const patch = (updater: (message: Message) => Message): void => {
    set({
      messages: get().messages.map((message) =>
        message.id === placeholder.id ? updater(message) : message,
      ),
    });
  };

  const built = await buildMessages(
    chat,
    get().messages,
    options.previousVariants ? 1 : 0,
    target.modelId,
  );

  // Tell the user what had to go, rather than letting the model quietly
  // forget the start of the conversation.
  if (built.fit.overflowed) {
    app.toast(
      'This message alone fills the model’s context. Shorten it, or switch to a model with a larger window.',
      'warn',
    );
  } else if (built.fit.dropped > 0) {
    app.toast(
      `${built.fit.dropped} older message${built.fit.dropped === 1 ? '' : 's'} dropped to fit the context window.`,
      'info',
    );
  }

  set({
    context: {
      used: built.fit.estimatedTokens,
      contextLength: contextLengthOf(target.modelId),
      dropped: built.fit.dropped,
      overflowed: built.fit.overflowed,
      measured: false,
    },
  });

  try {
    const stream = engine.stream({
      messages: built.messages,
      target,
      sampler: resolveSampler(chat, target.modelId),
      toolIds: chat.tools,
      egress: egressPolicy(chat.id),
      signal: controller.signal,
    });

    for await (const event of stream) {
      switch (event.type) {
        case 'delta': {
          if (firstDelta) {
            firstDelta = false;
            app.setActivity(runsOnThisDevice(target) ? 'running' : 'remote');
          }
          raw += event.text;
          const split = splitThinking(raw);
          patch((message) => ({
            ...message,
            content: split.content,
            thinking: split.thinking || undefined,
          }));

          const elapsed = performance.now() - started;
          if (elapsed > 400) {
            app.setLiveRate(Number(((raw.length / 3.6 / elapsed) * 1000).toFixed(1)));
          }
          break;
        }

        case 'tool': {
          toolCalls = [
            ...toolCalls,
            {
              id: event.tool.id,
              name: event.tool.name,
              input: event.tool.input,
              output: event.tool.output,
              isError: event.tool.isError,
              durationMs: event.tool.durationMs,
            },
          ];
          patch((message) => ({ ...message, toolCalls }));
          break;
        }

        case 'fallback':
          app.setActivity('remote');
          break;

        case 'done': {
          // The engine knows the true prompt token count; prefer it over the
          // estimate the moment it is available.
          if (event.stats.promptTokens) {
            set({
              context: {
                used: event.stats.promptTokens,
                contextLength: contextLengthOf(target.modelId),
                dropped: built.fit.dropped,
                overflowed: built.fit.overflowed,
                measured: true,
              },
            });
          }

          const split = splitThinking(event.text || raw);
          // The generation is assembled as ONE value and then projected onto
          // the row, so the row cannot end up holding half of it.
          const own: MessageVariant = {
            content: split.content.trim(),
            thinking: split.thinking || undefined,
            toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
            provenance: {
              backendId: event.provenance.backendId,
              engine: event.provenance.engine,
              modelId: event.provenance.modelId,
              modelName: event.provenance.modelName,
              // The engine still reports a boolean: `EngineTarget.local` gates
              // the fallback and the egress sheet, and widening it is #188's
              // and #144's, not this record's. So this is the one place the
              // boolean becomes a `Reach`, and today it can only produce two
              // of the three — nothing registers a paired target yet. When one
              // does, the snapshot gains the device and this line reads it;
              // until then the third value exists in the type and in the
              // migration, and no runtime path reaches it.
              reach: event.provenance.local ? REACH_DEVICE : REACH_REMOTE,
              fallbackFrom: event.provenance.fallbackFrom,
              fallbackReason: event.provenance.fallbackReason,
              toolEgress: event.provenance.toolEgress,
            },
            stats: event.stats,
          };
          // A first generation needs no list; a regenerated one appends itself
          // to the generations it was asked to replace.
          const variants = options.previousVariants
            ? [...options.previousVariants, own]
            : undefined;
          const finished: Message = {
            ...placeholder,
            content: own.content,
            thinking: own.thinking,
            toolCalls: own.toolCalls,
            provenance: own.provenance,
            stats: own.stats,
            streaming: false,
            variants,
            variantIndex: variants ? variants.length - 1 : undefined,
          };
          await db.messages.put(finished);
          patch(() => finished);
          break;
        }

        case 'error': {
          const failed: Message = {
            ...placeholder,
            content: '',
            streaming: false,
            error: event.message,
          };
          await db.messages.put(failed);
          patch(() => failed);
          app.toast(event.message, 'crit');
          break;
        }

        default:
          break;
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Generation failed.';
    const failed: Message = { ...placeholder, streaming: false, error: message };
    await db.messages.put(failed);
    patch(() => failed);
    app.toast(message, 'crit');
  } finally {
    set({ generating: false, controller: null });
    app.setActivity('idle');
    app.setLiveRate(null);

    if (runsOnThisDevice(target)) void useModels.getState().noteUse(target.modelId);

    const chatNow = get().chats.find((entry) => entry.id === chat.id);
    if (chatNow) {
      const last = get().messages.at(-1);
      await useChats.getState().updateChat(chat.id, {
        messageCount: chatNow.messageCount + 1,
        preview: last?.content.slice(0, 120) ?? chatNow.preview,
      });
    }
  }
}

/* ── Tool-output egress ──────────────────────────────────────────────── */

/**
 * The consent side of the engine's rule, in the app's own voice.
 *
 * Read live from the store rather than captured when the turn started: a grant
 * made in the sheet has to be visible to the check that raised it, and the
 * chat record may have moved on by then.
 */
function egressPolicy(chatId: string): ToolEgressPolicy {
  const grantsFor = (): readonly EgressGrant[] =>
    useChats.getState().chats.find((entry) => entry.id === chatId)?.egressGrants ?? [];

  return {
    isGranted: (backendId) => grantsFor().some((grant) => grant.connectionId === backendId),

    onGranted: (backendId) => {
      void useChats.getState().grantEgress(chatId, backendId);
    },

    async request({ backendId, modelName, tools, characters }) {
      const app = useApp.getState();
      const label =
        app.connections.find((connection) => connection.id === backendId)?.label ?? backendId;
      const names = [...new Set(tools.map((tool) => tool.name))];

      // Named, counted, and attributed. "The request contains a tool message"
      // is not a thing anybody can decide about; "`bash` read 3 files from this
      // app's own data" is.
      let extended = false;
      const allowed = await app.requestApproval(`send tool output to ${label}`, {
        title: `Send tool output to ${label}?`,
        body:
          `${names.join(', ') || 'A tool'} read from this app’s own data. ` +
          `To answer, ${modelName} has to see it. ` +
          `${characters.toLocaleString()} characters — this is not a message you typed.`,
        detail: tools.slice(0, 4).map((tool) => `${tool.name} · ${tool.output.length} chars`),
        confirmLabel: 'Send this turn',
        extendedLabel: 'Send for this conversation',
        cancelLabel: 'Don’t send',
        onExtended: () => {
          extended = true;
        },
      });

      if (!allowed) return 'deny';
      return extended ? 'conversation' : 'turn';
    },
  };
}

/**
 * What `resolveTarget` concluded.
 *
 * "No target" and "that model cannot do this" are different answers and used to
 * share a `null`. Collapsing them meant the only thing the caller could say was
 * "none is installed or connected yet" — which is false when a model IS
 * installed and simply cannot write, so the code instead said nothing and let
 * the request reach the router. Naming the refusal is what lets it be spoken.
 */
type TargetChoice =
  | { readonly kind: 'target'; readonly target: EngineTarget }
  | { readonly kind: 'refused'; readonly message: string }
  | { readonly kind: 'none' };

/** Decide which backend and model serve this chat. */
function resolveTarget(chat: Chat, overrideModelId?: string): TargetChoice {
  const models = useModels.getState();
  const app = useApp.getState();
  const modelId = overrideModelId ?? chat.modelId ?? models.activeModelId;

  if (modelId) {
    const installed = models.installed[modelId];
    if (installed?.state === 'installed') {
      const { manifest } = installed;

      /*
       * THE BACKSTOP, AND WHY IT IS NOT REDUNDANT.
       *
       * The pickers no longer offer a model that cannot chat, so nobody should
       * reach this. Three things still can. `chat.modelId` is persisted per
       * conversation and a chat created by an older build keeps its choice; a
       * persona's `preferredModelId` is persisted the same way and is copied
       * into new chats at `newChat`; and `regenerate` passes an
       * `overrideModelId` straight through. None of those pass a picker.
       *
       * It matters that the refusal happens HERE and not one layer down. The
       * engine treats a local failure as grounds to divert to the configured
       * cloud provider — measured: a registration error is classified
       * `engine-error`, and the turn is re-run against the remote, so the
       * user's message leaves the device and a cloud answer comes back over a
       * model they picked precisely because it was local. Refusing before the
       * engine is called means there is no failure to divert.
       */
      if (!canChat(manifest)) {
        return {
          kind: 'refused',
          message:
            `${manifest.name} ${nonChatRole(manifest)} — it cannot answer a chat. ` +
            `Choose a model that writes text, then send this again.`,
        };
      }

      return { kind: 'target', target: targetFor(manifest.engine, modelId, manifest.name) };
    }
  }

  // Fall back to the first enabled remote connection, if any.
  const connection = app.connections.find((entry) => entry.enabled);
  if (connection) {
    return {
      kind: 'target',
      target: {
        backendId: connection.id,
        engine: 'remote',
        modelId: connection.defaultModel,
        modelName: `${connection.label} · ${connection.defaultModel}`,
        reach: REACH_REMOTE,
      },
    };
  }

  return { kind: 'none' };
}

/** The model's context window, or a conservative default when unknown. */
function contextLengthOf(modelId: string): number {
  return useModels.getState().installed[modelId]?.manifest.contextLength ?? 4096;
}

function resolveSampler(chat: Chat, modelId: string): SamplerSettings {
  const models = useModels.getState();
  const personas = usePersonas.getState();
  const saved = models.installed[modelId]?.sampler ?? DEFAULT_SAMPLER;
  const persona = chat.personaId ? personas.byId[chat.personaId] : undefined;
  return { ...saved, ...persona?.sampler, ...chat.sampler };
}

export interface BuiltPrompt {
  readonly messages: IRMessage[];
  readonly fit: FitResult;
}

/**
 * Assemble the IR messages for this turn: system prompt, matched lore, the
 * recent history, and any post-history instruction the persona defines — then
 * trim the result to fit the model's context window.
 *
 * Exported so a test can drive the real thing: the taint a turn carries
 * forward between turns is decided here, and a test that rebuilt this history
 * itself would be testing its own copy.
 *
 * Trimming here rather than letting the engine truncate is the whole point:
 * llama.cpp drops from the front, which takes the system prompt and the
 * persona with it. `fitToContext` drops old turns instead and reports how
 * many, so the thread can say so.
 */
export async function buildMessages(
  chat: Chat,
  messages: Message[],
  dropTail: number,
  modelId: string,
): Promise<BuiltPrompt> {
  const personas = usePersonas.getState();
  const models = useModels.getState();
  const persona = chat.personaId ? personas.byId[chat.personaId] : undefined;

  const history = messages
    .filter((message) => !message.streaming && !message.error)
    .slice(0, messages.length - dropTail)
    .slice(-HISTORY_TURNS);

  const result: IRMessage[] = [];

  const systemParts: string[] = [];
  const modelPrompt = chat.modelId ? models.installed[chat.modelId]?.systemPrompt : '';
  if (modelPrompt?.trim()) systemParts.push(modelPrompt.trim());
  if (persona) systemParts.push(renderSystemPrompt(persona));

  if (persona?.characterBook) {
    const recent = history
      .slice(-6)
      .map((message) => message.content)
      .join('\n');
    const lore = renderLore(
      selectLore(persona.characterBook, recent, persona.characterBook.tokenBudget ?? 2000),
    );
    if (lore) systemParts.push(lore);
  }

  if (systemParts.length > 0) {
    result.push({ role: 'system', content: systemParts.join('\n\n') });
  }

  for (const message of history) {
    if (message.role === 'system') continue;

    // A reply the model wrote WHILE a tool was running is derived from that
    // tool's output whether or not it quotes it verbatim, so it carries the
    // mark forward into every later turn. Without this, the leak survives a
    // turn boundary: run `bash` locally, let the model summarise /chats in
    // its visible answer, then switch to a remote model — by then there is no
    // tool_result block anywhere in the history and the summary goes out
    // unremarked.
    //
    // `toolCalls` is read off the ROW, and the row is a projection of the
    // generation on display — `applyVariant` moves the tool list with the text
    // it belongs to. Before variants carried their own, `regenerate` moved
    // tool-derived TEXT onto a row whose `toolCalls` belonged to the new turn,
    // so cycling back to the old text produced an unmarked history and the
    // bytes reached a remote adapter with no sheet. That is the A8 residual,
    // and it is closed by the projection rather than by a rule here.
    //
    // `displaysUnrecorded` is the one thing the projection cannot supply: a
    // generation recovered from a build that stored variants as bare strings
    // has no tool list to move, and an absent list must not read as "no tools
    // ran". Unknown fails closed here, and silent — no chip — where it is only
    // a label.
    const derived =
      message.role === 'assistant' &&
      ((message.toolCalls?.length ?? 0) > 0 || displaysUnrecorded(message));
    const carry = (built: IRMessage): IRMessage => (derived ? markTainted(built) : built);

    const images = (message.attachments ?? []).filter(
      (attachment): attachment is Extract<Attachment, { kind: 'image' }> =>
        attachment.kind === 'image',
    );

    if (images.length === 0) {
      result.push(
        carry({ role: message.role === 'tool' ? 'user' : message.role, content: message.content }),
      );
      continue;
    }

    // Base64 is produced here, for the turns actually being sent — not held in
    // every message row. An attachment whose payload has been deleted is
    // dropped rather than sent as a dangling reference.
    const encoded = await Promise.all(
      images.map(async (image) => ({ image, data: await blobToBase64(image.id) })),
    );

    const content: MessageContent[] = [
      { type: 'text', text: message.content },
      ...encoded
        .filter((entry): entry is { image: (typeof images)[number]; data: string } =>
          typeof entry.data === 'string',
        )
        .map(
          ({ image, data }): MessageContent => ({
            type: 'image',
            source: { type: 'base64', mediaType: image.mediaType, data },
          }),
        ),
    ];
    result.push(carry({ role: 'user', content }));
  }

  if (persona?.postHistoryInstructions?.trim()) {
    result.push({
      role: 'system',
      content: persona.postHistoryInstructions
        .replaceAll('{{char}}', persona.name)
        .replaceAll('{{user}}', 'the user')
        .trim(),
    });
  }

  const manifest = models.installed[modelId]?.manifest;
  if (!manifest) {
    return {
      messages: result,
      fit: {
        messages: result,
        estimatedTokens: estimateConversationTokens(result),
        dropped: 0,
        overflowed: false,
      },
    };
  }

  const sampler = resolveSampler(chat, modelId);
  const fit = fitToContext(result, contextBudget(manifest.contextLength, sampler.maxTokens));
  return { messages: fit.messages, fit };
}

/**
 * The tools a persona is allowed to pre-enable.
 *
 * Sensitive tools are dropped rather than the whole list being refused: a
 * persona that wants `calculator` and `bash` gets `calculator`, and the user
 * can still switch `bash` on themselves in the picker, having been asked.
 */
export function unsensitive(tools: readonly string[] | undefined): string[] {
  if (!tools?.length) return [];
  return tools.filter((id) => {
    const tool = toolRegistry.get(id) ?? toolRegistry.getByName(id);
    return tool !== undefined && !tool.sensitive;
  });
}

function sortChats(chats: Chat[]): Chat[] {
  return [...chats].sort((a, b) => {
    if (Boolean(a.pinned) !== Boolean(b.pinned)) return a.pinned ? -1 : 1;
    return b.updatedAt - a.updatedAt;
  });
}

// Registered at module load, so a connection removed anywhere in the app drops
// the grants that named it without this store having to be open.
installEgressRevoker(async (connectionId) => {
  await useChats.getState().revokeEgress(connectionId);
});
