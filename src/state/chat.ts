/**
 * Conversation state and the generation loop.
 *
 * This is where a thread becomes an IR request: persona system prompt, lore,
 * history, attachments, sampler, and tools are assembled here and handed to
 * the engine. Everything below this point is provider-agnostic.
 */

import { create } from 'zustand';

import { blobToBase64, deleteBlobs } from '@/lib/blobs';
import { db, deleteChat } from '@/db';
import {
  applyVariant,
  currentVariant,
  deriveTitle,
  displaysUnrecorded,
  holdsGrant,
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
import type {
  DestinationRequest,
  ExecutedTool,
  ToolDestinationPolicy,
} from '@/ai/middleware/tools';
import {
  mayHaveLeft,
  unhandledOutcome,
  unhandledWhy,
  type McpCallReceipt,
  type ToolDestination,
} from '@/domain/mcp';
import { toolRegistry } from '@/ai/tools/registry';
import {
  contextBudget,
  estimateConversationTokens,
  fitToContext,
  type FitResult,
} from '@/ai/context';
import {
  installEgressRevoker,
  installMcpGrantRevoker,
  installMcpToolPruner,
  useApp,
} from '@/state/app';
import { useModels } from '@/state/models';
import { usePersonas } from '@/state/personas';

/**
 * Hard ceiling on turns considered, before token budgeting narrows it further.
 * This is a cheap guard against pathological histories; `fitToContext` does
 * the real work.
 */
const HISTORY_TURNS = 64;

/**
 * The row of the generation running right now, if there is one.
 *
 * A turn's row is written to the database mid-turn once a tool call has handed
 * something to a server (see the `tool` case in `runGeneration`), so a stored
 * row still marked `streaming` is either this one or one whose generation was
 * interrupted — the app was closed or killed while it ran. `openChat` tells
 * the two apart by this.
 */
let livePlaceholderId: string | null = null;

/**
 * The withdrawals of one kind of grant, by the id a grant names: a connection's
 * id (`providerWithdrawals`) or an MCP server record's id (`mcpWithdrawals`).
 *
 * A grant lives in three places besides the table, and none of them can trust
 * the order writes finish in:
 *
 * - AN ANSWER HELD IN MEMORY — the engine's `decided` for a provider, the MCP
 *   policy's `answered` — is taken with `count` and honoured only while that
 *   stands. Switching a connection or server off and on again brings back the
 *   same id, so nothing else says the answer is stale. A revocation counts
 *   once when it STARTS, before it reads or awaits anything, and once more
 *   when it has FINISHED, so an answer taken while one was under way does not
 *   outlive it either.
 * - A GRANT BEING WRITTEN is written with `void` from a policy, and can land
 *   after a revocation that read the chats before it was among them and so
 *   dropped nothing. `grantEgress` and `grantMcpEgress` note it with `write`
 *   first, and withdraw it again when, once their write has settled, a
 *   revocation has started since or is still under way.
 * - A GRANT THE STORE STILL HOLDS may be one a revocation has not reached yet,
 *   or one whose write outlasted a revocation and has not withdrawn itself
 *   yet. `unsettled` says so, and the policies do not answer on it meanwhile —
 *   otherwise the request or call decided in that window went out, and a yes
 *   decided there was held for the rest of the turn.
 *
 * Per id, not per conversation: a revocation scoped to one chat also unsettles
 * other chats' grants for that id while it runs, and makes their held answers
 * ask again, which fails closed.
 */
function withdrawals() {
  const counts = new Map<string, number>();
  const underway = new Map<string, number>();
  const writing = new Map<string, number[]>();
  const count = (id: string): number => counts.get(id) ?? 0;
  const bump = (id: string): void => {
    counts.set(id, count(id) + 1);
  };

  return {
    count,

    /**
     * Start a revocation of `id`. Call it FIRST, before anything is read or
     * awaited; call what it returns once the revocation's writes have settled,
     * however they settled.
     */
    begin(id: string): () => void {
      bump(id);
      underway.set(id, (underway.get(id) ?? 0) + 1);
      return () => {
        bump(id);
        const left = (underway.get(id) ?? 1) - 1;
        if (left > 0) underway.set(id, left);
        else underway.delete(id);
      };
    },

    /**
     * Note a grant for `id` about to be written. `stands` says, once the write
     * has settled, whether the grant may be kept; `done` is called once it has
     * been kept or withdrawn again.
     */
    write(id: string): { stands: () => boolean; done: () => void } {
      const since = count(id);
      writing.set(id, [...(writing.get(id) ?? []), since]);
      return {
        stands: () => !underway.has(id) && count(id) === since,
        done: () => {
          const rest = [...(writing.get(id) ?? [])];
          rest.splice(rest.indexOf(since), 1);
          if (rest.length > 0) writing.set(id, rest);
          else writing.delete(id);
        },
      };
    },

    /** Whether a grant for `id` the store holds may be one that is being withdrawn. */
    unsettled(id: string): boolean {
      return underway.has(id) || (writing.get(id) ?? []).some((since) => since !== count(id));
    },
  };
}

/** Each MCP server's grants' withdrawals, by server id (#6). See `withdrawals`. */
const mcpWithdrawals = withdrawals();

/** Each connection's grants' withdrawals, by connection id. See `withdrawals`. */
const providerWithdrawals = withdrawals();

/**
 * A change to one chat: the fields to set, or a function of the chat AS IT
 * STANDS WHEN THE CHANGE IS WRITTEN that returns them — or `null`, for none.
 *
 * Anything that takes something out of a list, or adds to one, passes a
 * function. A list computed from an earlier read carries back whatever was
 * taken out of it since.
 */
export type ChatPatch = Partial<Chat> | ((chat: Chat) => Partial<Chat> | null);

/**
 * The write each chat is waiting on, by chat id.
 *
 * `updateChat` read the chat, awaited its put, then set the store, and nothing
 * stopped two of those overlapping. Both read the chat before either landed,
 * so the later one wrote back every field of the chat it had read. That lost
 * the other's change, and was worse when the other was a revocation: a rename
 * that ran while a grant was being withdrawn wrote the grant back, into the
 * table and the store. Writes to one chat now run one at a time, each applied
 * to the chat as the write before it left it.
 *
 * NOTHING RUNNING INSIDE A WRITE MAY WAIT ON ANOTHER WRITE TO THE SAME CHAT:
 * that write is queued behind this one, and neither would finish. The
 * post-write re-checks in `grantEgress` and `grantMcpEgress` run after their
 * write has finished for exactly that reason.
 */
const chatWrites = new Map<string, Promise<void>>();

function writeInTurn(chatId: string, write: () => Promise<void>): Promise<void> {
  const before = chatWrites.get(chatId) ?? Promise.resolve();
  const written = before.then(write);
  // What the next write waits on settles either way. A put that failed is
  // reported to its own caller, and must not wedge every later write to the chat.
  const settled = written.catch(() => {});
  chatWrites.set(chatId, settled);
  void settled.then(() => {
    if (chatWrites.get(chatId) === settled) chatWrites.delete(chatId);
  });
  return written;
}

/**
 * Chats whose delete has been asked for in this session, by id.
 *
 * `removeChat` waits its turn in `chatWrites` like any other write, so every
 * write already asked for lands before the delete, and the delete takes it with
 * the chat. What is asked for after is a no-op. A chat write sees that for
 * itself — the chat is no longer in the store when it runs — but a message row
 * names its chat and nothing more, and a turn still running in a deleted
 * conversation, or the recovery of an interrupted row, wrote it straight back
 * into the table: a conversation the person deleted, still on disk. So message
 * rows go through `putMessage`, which asks this.
 *
 * ADDED WHEN THE DELETE IS ASKED FOR, not when it starts, and nothing is SENT
 * for a chat in here either. Deleting a chat stopped only its rows: the turn
 * running in it went on calling MCP servers under an answer given for the
 * conversation, measured through the real engine, and a turn asked for while
 * an earlier write held the delete's place started. So every turn running in
 * it is stopped as the delete is asked for (`liveTurns`), and `runGeneration`
 * starts none in a chat in here, nor hands one to the engine.
 *
 * Taken out again if the delete fails — the chat is still there then, and so
 * should be what is written to it from then on, and what was refused while the
 * delete ran is written then. See `refusedRows`.
 */
const removedChats = new Set<string>();

/**
 * Rows `putMessage` refused while a chat's delete was under way, by chat, the
 * latest version of each row by message id. Present from the moment the delete
 * is asked for until it has landed or failed.
 *
 * A delete can fail — a full disk — and the chat is then still there. Dropping
 * a refused row outright lost it for good: the row recording that a call's
 * arguments went to an MCP server, a finished turn carrying a not-sent record, a
 * regenerated turn holding the generations of the row it replaced (which was
 * deleted). The thread on screen showed them; reopening or exporting the chat
 * showed nothing. So they are kept here, and written if the delete fails.
 */
const refusedRows = new Map<string, Map<string, Message>>();

/** A turn that has been claimed, with the chat it runs in and what stops it. */
interface LiveTurn {
  readonly chatId: string;
  readonly controller: AbortController;
}

/**
 * Every turn claimed and not yet settled. See `claimTurn`.
 *
 * A SET, NOT ONE SLOT. Editing a user message once started a turn without asking
 * whether one was already running, and one slot held the turn started last:
 * deleting the chat the earlier one ran in stopped nothing, and its model went
 * on calling an MCP server under the conversation's earlier yes, measured
 * through the real engine. One turn runs at a time now, and what stops turns —
 * Stop, a chat's delete — still walks every one there is.
 */
const liveTurns = new Set<LiveTurn>();

/** Whether a turn is running, on either sign of one. */
function turnRunning(get: () => ChatState): boolean {
  return get().generating || liveTurns.size > 0;
}

/**
 * Claim the app's one running turn, for `chatId`, or null while a turn is running.
 *
 * ONE TURN AT A TIME, FOR THE WHOLE APP. `generating` is one flag, not one per
 * chat, and the composer offers Stop in whatever chat is open while it is set,
 * so `send` and `regenerate` already refused in every chat while any turn ran.
 * `editMessage` did not ask at all, and `send` asked and then wrote the message
 * and the chat before the turn set the flag, so a second send made meanwhile
 * passed the same check. Two turns ran. Stop aborted the one started last, and
 * that one's end cleared `generating` while the other still streamed, ran tools
 * and handed MCP arguments to servers — with Send on screen where Stop had been.
 *
 * So the question and the claim are ONE STEP, with nothing awaited between them,
 * and `runGeneration` cannot be called without a claimed turn. A claimed turn is
 * in `liveTurns` from here, so Stop and a chat's delete reach it before it has
 * reached the engine, and `runGeneration` hands no stopped turn over.
 */
function claimTurn(
  set: (partial: Partial<ChatState>) => void,
  get: () => ChatState,
  chatId: string,
): LiveTurn | null {
  if (turnRunning(get)) return null;
  const turn: LiveTurn = { chatId, controller: new AbortController() };
  liveTurns.add(turn);
  set({ generating: true, controller: turn.controller });
  return turn;
}

/**
 * Give a claimed turn back once it has settled, however it did. Calling it again
 * does nothing. `generating` goes false only when no turn is left.
 */
function releaseTurn(set: (partial: Partial<ChatState>) => void, turn: LiveTurn): void {
  if (liveTurns.delete(turn) && liveTurns.size === 0) set({ generating: false, controller: null });
}

/**
 * Write a message row, unless its chat's delete has been asked for. See
 * `removedChats`.
 *
 * Refused while the delete is under way, the row is kept in `refusedRows`:
 * `removeChat` writes it if the delete fails.
 *
 * A row refused that way can name attachment payloads nothing else does: the
 * composer writes an image's payload when it is attached, and the delete takes
 * only the payloads the rows it found name. So those go too — once the delete
 * has landed, and only if it did: a chat whose delete failed may still show
 * them.
 */
async function putMessage(message: Message): Promise<void> {
  // Asked in the same step the put is made. A delete asked for after this makes
  // its own write after the put, and the table applies them in that order, so
  // it takes the row with it; one asked for before is seen here.
  if (!removedChats.has(message.chatId)) {
    await db.messages.put(message);
    return;
  }
  const refused = refusedRows.get(message.chatId);
  if (refused) {
    refused.set(message.id, message);
    return;
  }
  // The delete has landed: nothing will write this row, and nothing else names
  // its payloads.
  const payloads = (message.attachments ?? []).map((attachment) => attachment.id);
  if (payloads.length === 0) return;
  await writeInTurn(message.chatId, async () => {
    if (removedChats.has(message.chatId)) await deleteBlobs(payloads);
  });
}

/**
 * Delete a message row. A version of it refused while its chat's delete is under
 * way goes too, or a delete that then failed would write back a row the person
 * had deleted meanwhile. See `refusedRows`.
 */
async function deleteMessageRow(messageId: string): Promise<void> {
  for (const refused of refusedRows.values()) refused.delete(messageId);
  await db.messages.delete(messageId);
}

/**
 * What was withdrawn before the chat list had loaded: connections' and MCP
 * servers' grants, and MCP servers' tools by id prefix.
 *
 * The app is up — Settings included — once the engine is, and the list is read
 * after that (App.tsx). A withdrawal drops grants from the chats in the store,
 * and until the list has landed there are none. So it dropped nothing, the list
 * then brought the grant in from disk, and switching the connection or server
 * back on honoured it without asking. A removed server's tools came back the
 * same way, and their prune is what keeps them from coming on under the next
 * server to take the name (#6). So `load` takes these out of what it read
 * before the store holds any of it, and writes that back.
 */
const beforeTheList = {
  connections: new Set<string>(),
  servers: new Set<string>(),
  toolPrefixes: new Set<string>(),
};

/** A chat read from disk without what was withdrawn before the list loaded, or null when that is nothing. */
function withdrawnBeforeTheList(chat: Chat): Chat | null {
  const grants = chat.egressGrants ?? [];
  const egressGrants = grants.filter((grant) =>
    grant.kind === 'mcp'
      ? !beforeTheList.servers.has(grant.serverId)
      : !beforeTheList.connections.has(grant.connectionId),
  );
  const prefixes = [...beforeTheList.toolPrefixes];
  const tools = chat.tools.filter((id) => !prefixes.some((prefix) => id.startsWith(prefix)));
  if (egressGrants.length === grants.length && tools.length === chat.tools.length) return null;
  return { ...chat, egressGrants, tools };
}

/** The error an interrupted turn is recovered with. */
const INTERRUPTED = 'This reply was interrupted before it finished.';

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
  /**
   * The running turn's controller, or null. NOT WHAT STOPS TURNS: `stop()`
   * aborts every claimed turn, and a chat's delete every one in that chat.
   */
  controller: AbortController | null;

  load: () => Promise<void>;
  openChat: (chatId: string) => Promise<void>;
  newChat: (options?: { mode?: ChatMode; personaId?: string | null }) => Promise<string>;
  removeChat: (chatId: string) => Promise<void>;
  renameChat: (chatId: string, title: string) => Promise<void>;
  togglePin: (chatId: string) => Promise<void>;
  /**
   * Change one chat, after every write to it already under way. A function
   * patch is applied to the chat as that write left it; see `chatWrites`.
   */
  updateChat: (chatId: string, patch: ChatPatch) => Promise<void>;
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
  /**
   * Let this conversation send MCP tool calls' arguments to one server, at one
   * address, until revoked (#6).
   */
  grantMcpEgress: (chatId: string, server: { serverId: string; url: string }) => Promise<void>;
  /** Drop grants for one MCP server, across every conversation, whatever address they named. */
  revokeMcpEgress: (serverId: string, chatId?: string) => Promise<void>;

  refreshContext: () => void;
  send: (text: string, attachments?: Attachment[]) => Promise<void>;
  /** Stop every turn that is running, in whatever chat it runs. See `claimTurn`. */
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
    const stored = await db.chats.orderBy('updatedAt').reverse().toArray();
    // MERGED INTO THE STORE, NOT PUT IN PLACE OF IT. The chat screen is up once
    // the engine is, before this read lands, and ⌘N there starts a chat. A read
    // taken before that chat was written replaced the store without it, and the
    // screen was left on a thread nothing could be sent to. What the store holds
    // was written to the table before it was set, so it is never older than the
    // read; a chat being deleted is left out, or the read would bring it back.
    const held = get().chats;
    const known = new Set(held.map((chat) => chat.id));
    const unseen = stored.filter((chat) => !known.has(chat.id) && !removedChats.has(chat.id));
    // Without what was withdrawn before this could see it, in the store from
    // the first moment it holds these chats. See `beforeTheList`.
    const stripped = unseen.map(withdrawnBeforeTheList);
    beforeTheList.connections.clear();
    beforeTheList.servers.clear();
    beforeTheList.toolPrefixes.clear();
    set({ loaded: true, chats: sortChats([...held, ...unseen.map((chat, at) => stripped[at] ?? chat)]) });
    // And on disk, in each chat's turn.
    await Promise.all(
      stripped.flatMap((chat) =>
        chat
          ? [
              writeInTurn(chat.id, async () => {
                const current = get().chats.find((entry) => entry.id === chat.id);
                if (current) await db.chats.put(current);
              }),
            ]
          : [],
      ),
    );
  },

  async openChat(chatId) {
    const stored = await db.messages.where('chatId').equals(chatId).sortBy('createdAt');
    const messages: Message[] = [];
    for (const row of stored) {
      // A stored row marked streaming whose generation is not running was
      // interrupted. Left alone it would show a caret for ever and refuse to be
      // cycled. It keeps what it had — its text so far and its tool calls,
      // receipts included — and becomes the failed turn it is.
      if (row.streaming && row.id !== livePlaceholderId) {
        const interrupted: Message = { ...row, streaming: false, error: INTERRUPTED };
        await putMessage(interrupted);
        messages.push(interrupted);
      } else {
        messages.push(row);
      }
    }
    // Deleted while its thread was being read: the thread read is from before,
    // and opening it would put a deleted conversation back on screen.
    if (removedChats.has(chatId)) return;
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
      await putMessage(greeting);
      set({ messages: [greeting] });
    }

    return chat.id;
  },

  removeChat(chatId) {
    // IN THE CHAT'S TURN, like every other write to it. Run straight away, the
    // delete was under way while a write queued behind another one ran, found
    // the chat still in the store, and put it back into the table after the
    // delete had taken it out: the chat came back the next time the app loaded.
    // Now what was asked for first lands first and goes with the chat, and what
    // is asked for after finds it gone. See `removedChats`.
    //
    // Marked, and its running turn stopped, NOW — before the delete has its
    // turn. What that turn would send next is sent for a conversation the person
    // has just deleted.
    removedChats.add(chatId);
    if (!refusedRows.has(chatId)) refusedRows.set(chatId, new Map());
    for (const turn of liveTurns) if (turn.chatId === chatId) turn.controller.abort();
    return writeInTurn(chatId, async () => {
      try {
        await deleteChat(chatId);
      } catch (error) {
        // The chat is still there, and so is what the thread on screen shows:
        // the rows refused while this ran are written. Each put is MADE before
        // the mark comes off, so a write to the chat made after that is applied
        // after it, and wins.
        const refused = [...(refusedRows.get(chatId)?.values() ?? [])];
        refusedRows.delete(chatId);
        const writing = refused.map((message) => db.messages.put(message));
        removedChats.delete(chatId);
        await Promise.allSettled(writing);
        throw error;
      }
      // Landed. The rows refused meanwhile are never written, and their payloads
      // are named by nothing else.
      const payloads = [...(refusedRows.get(chatId)?.values() ?? [])].flatMap((message) =>
        (message.attachments ?? []).map((attachment) => attachment.id),
      );
      refusedRows.delete(chatId);
      if (payloads.length > 0) await deleteBlobs(payloads);
      set({
        chats: get().chats.filter((chat) => chat.id !== chatId),
        ...(get().activeChatId === chatId ? { activeChatId: null, messages: [] } : {}),
      });
    });
  },

  async renameChat(chatId, title) {
    await get().updateChat(chatId, { title });
  },

  async togglePin(chatId) {
    await get().updateChat(chatId, (chat) => ({ pinned: !chat.pinned }));
  },

  updateChat(chatId, patch) {
    return writeInTurn(chatId, async () => {
      // Read HERE, once every earlier write to this chat has landed — not when
      // the caller asked. See `chatWrites`.
      const chat = get().chats.find((entry) => entry.id === chatId);
      if (!chat) return;
      const changes = typeof patch === 'function' ? patch(chat) : patch;
      if (!changes) return;
      const updated = { ...chat, ...changes, updatedAt: Date.now() };
      await db.chats.put(updated);
      set({
        chats: sortChats(get().chats.map((entry) => (entry.id === chatId ? updated : entry))),
      });
    });
  },

  async grantEgress(chatId, connectionId) {
    const write = providerWithdrawals.write(connectionId);
    try {
      // A function of the chat as it stands when this is written, so a grant
      // withdrawn meanwhile is not carried back in with the list.
      await get().updateChat(chatId, (chat) =>
        holdsGrant(chat.egressGrants, { kind: 'provider', connectionId })
          ? null
          : { egressGrants: [...(chat.egressGrants ?? []), { connectionId, grantedAt: Date.now() }] },
      );
      // A revocation that started while this was queued or being written read
      // the chat before the grant was in it, and dropped nothing; one still under
      // way finishes after it. Checked after the write has finished, never inside
      // it. See `withdrawals`.
      if (!write.stands()) await get().revokeEgress(connectionId, chatId);
    } finally {
      write.done();
    }
  },

  async revokeEgress(connectionId, chatId) {
    // Counted before anything is read or awaited, so an answer or a write
    // already under way sees it however the rest of this interleaves.
    const finished = providerWithdrawals.begin(connectionId);
    // Until the chat list has loaded there is nothing here to drop it from. See
    // `beforeTheList`.
    if (chatId === undefined && !get().loaded) beforeTheList.connections.add(connectionId);
    try {
      const names = (grant: EgressGrant): boolean =>
        grant.kind !== 'mcp' && grant.connectionId === connectionId;
      const affected = get().chats.filter(
        (chat) => (chatId === undefined || chat.id === chatId) && (chat.egressGrants ?? []).some(names),
      );
      for (const chat of affected) {
        await get().updateChat(chat.id, (current) =>
          (current.egressGrants ?? []).some(names)
            ? { egressGrants: (current.egressGrants ?? []).filter((grant) => !names(grant)) }
            : null,
        );
      }
    } finally {
      finished();
    }
  },

  async grantMcpEgress(chatId, { serverId, url }) {
    const write = mcpWithdrawals.write(serverId);
    try {
      await get().updateChat(chatId, (chat) => {
        if (holdsGrant(chat.egressGrants, { kind: 'mcp', serverId, url })) return null;
        // A grant for this server at an address it no longer has is REPLACED, not
        // kept beside the new one. It covers nothing now, and a list that kept it
        // would read as permission to send wherever the server used to be.
        const egressGrants: EgressGrant[] = [
          ...(chat.egressGrants ?? []).filter(
            (grant) => grant.kind !== 'mcp' || grant.serverId !== serverId,
          ),
          { kind: 'mcp', serverId, url, grantedAt: Date.now() },
        ];
        return { egressGrants };
      });
      // A revocation that started while this was queued or being written read
      // the chat before the grant was in it, and dropped nothing; one still under
      // way finishes after it. Checked after the write has finished, never inside
      // it. See `withdrawals`.
      if (!write.stands()) await get().revokeMcpEgress(serverId, chatId);
    } finally {
      write.done();
    }
  },

  async revokeMcpEgress(serverId, chatId) {
    // Counted before anything is read or awaited, so an answer or a write
    // already under way sees it however the rest of this interleaves.
    const finished = mcpWithdrawals.begin(serverId);
    // Until the chat list has loaded there is nothing here to drop it from. See
    // `beforeTheList`.
    if (chatId === undefined && !get().loaded) beforeTheList.servers.add(serverId);
    try {
      const names = (grant: EgressGrant): boolean => grant.kind === 'mcp' && grant.serverId === serverId;
      const affected = get().chats.filter(
        (chat) => (chatId === undefined || chat.id === chatId) && (chat.egressGrants ?? []).some(names),
      );
      for (const chat of affected) {
        await get().updateChat(chat.id, (current) =>
          (current.egressGrants ?? []).some(names)
            ? { egressGrants: (current.egressGrants ?? []).filter((grant) => !names(grant)) }
            : null,
        );
      }
    } finally {
      finished();
    }
  },

  async send(text, attachments = []) {
    const chatId = get().activeChatId;
    if (!chatId) return;

    const chat = get().chats.find((entry) => entry.id === chatId);
    if (!chat) return;

    // Claimed BEFORE anything is written, in the step that asks. Asked here and
    // set by the turn, a second send made while this one wrote passed the same
    // check. See `claimTurn`.
    const turn = claimTurn(set, get, chatId);
    if (!turn) return;

    try {
      const userMessage: Message = {
        id: newId('msg'),
        chatId,
        role: 'user',
        content: text,
        attachments: attachments.length > 0 ? attachments : undefined,
        createdAt: Date.now(),
      };

      await putMessage(userMessage);
      set({ messages: [...get().messages, userMessage] });

      if (chat.messageCount === 0 || chat.title === 'New chat' || chat.title === 'Task') {
        await get().updateChat(chatId, { title: deriveTitle(text) });
      }
      await get().updateChat(chatId, (current) => ({
        messageCount: current.messageCount + 1,
        preview: text.slice(0, 120),
      }));

      await runGeneration(set, get, { turn });
    } finally {
      releaseTurn(set, turn);
    }
  },

  stop() {
    // EVERY TURN, not the one started last, and one claimed that has not reached
    // the engine yet. See `claimTurn`.
    for (const turn of liveTurns) turn.controller.abort();
  },

  async regenerate(messageId, overrideModelId) {
    const messages = get().messages;
    const index = messages.findIndex((message) => message.id === messageId);
    if (index === -1) return;

    const target = messages[index];
    if (!target || target.role !== 'assistant') return;

    const chatId = get().activeChatId;
    if (!chatId) return;

    // Nothing above waits, so this is the step that asks. See `claimTurn`.
    const turn = claimTurn(set, get, chatId);
    if (!turn) return;

    try {
      // Everything after this assistant turn is discarded; the turn itself is
      // kept so its previous text becomes a variant the user can flip back to.
      //
      // ONLY ONCE A TURN HAS STARTED. They were deleted first, and the turn once
      // `runGeneration` returned, whether or not it had started anything. One that
      // could not start — no model, a chat being deleted — replaced them with
      // nothing: the turn and what came after it were gone from disk and screen,
      // an MCP receipt saying arguments went included.
      const removed = messages.slice(index + 1);
      set({ messages: messages.slice(0, index) });
      const ran = await runGeneration(set, get, {
        turn,
        overrideModelId,
        // Not `target.content`. What is carried forward is the whole generation
        // — where it ran, what tools it used, what it cost — because the text
        // alone is what let the new turn's chip end up over the old turn's
        // words.
        previousVariants: generationsSoFar(target),
        replaceMessageId: target.id,
        // All made in one step. See `beforeEngine`.
        beforeEngine: async () => {
          await Promise.all(removed.map((message) => deleteMessageRow(message.id)));
        },
      });
      if (ran) {
        await deleteMessageRow(target.id);
        return;
      }
      // Nothing started, so nothing was discarded: the thread goes back on screen
      // as it was, if it is still the one open.
      if (get().activeChatId === chatId) set({ messages });
    } finally {
      releaseTurn(set, turn);
    }
  },

  async editMessage(messageId, text) {
    const messages = get().messages;
    const index = messages.findIndex((message) => message.id === messageId);
    if (index === -1) return;

    const message = messages[index];
    if (!message) return;

    // REFUSED WHILE A TURN IS RUNNING, as `send` and `regenerate` are, and whole.
    // It asked nothing: it deleted the rows after the edited message, the running
    // turn's among them, and started a second turn beside the first, which Stop
    // then could not reach. The edit sheet does not offer it meanwhile.
    if (turnRunning(get)) return;

    // Editing a user turn invalidates everything after it, and starts a turn:
    // claimed here, in the same step as the question above. See `claimTurn`.
    const after = messages.slice(index + 1);
    const turn = message.role === 'user' && after.length > 0 ? claimTurn(set, get, message.chatId) : null;

    try {
      const updated = editedVariant(message, text);
      await putMessage(updated);

      if (turn) {
        for (const stale of after) await deleteMessageRow(stale.id);
        // The turn is built from the thread on screen, so only while that is
        // still the conversation that was edited.
        if (get().activeChatId !== turn.chatId) return;
        set({ messages: [...messages.slice(0, index), updated] });
        await runGeneration(set, get, { turn });
        return;
      }

      set({ messages: messages.map((entry) => (entry.id === messageId ? updated : entry)) });
    } finally {
      if (turn) releaseTurn(set, turn);
    }
  },

  async deleteMessage(messageId) {
    await deleteMessageRow(messageId);
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
    await putMessage(updated);
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
 *
 * UNLESS IT RECORDS AN MCP CALL. A generation carrying any MCP receipt — sent,
 * failed or not sent — is kept with no text. A receipt that says bytes may have
 * left is the only record that they did, and regenerating is not a reason to
 * forget that. One that says a call was not sent is kept too, by owner ruling
 * on #92: a stopped or refused turn's earlier version stays in the history with
 * its not-sent records, and the export prints them as a version not shown. For
 * the same reasons a regeneration that failed or was interrupted — a row whose
 * index is past the end of its list, showing a generation whose record was
 * never appended — is appended here when it carries one. Without a receipt it
 * is dropped, as it always was.
 */
function generationsSoFar(target: Message): MessageVariant[] {
  const listed = target.variants;
  const shown = currentVariant(target);
  const offList =
    listed !== undefined &&
    target.variantIndex !== undefined &&
    target.variantIndex >= listed.length;
  const all = listed === undefined ? [shown] : offList && carriesReceipt(shown) ? [...listed, shown] : listed;
  return all.filter((variant) => variant.content.length > 0 || carriesReceipt(variant));
}

/**
 * Does any tool call in this generation record what became of an MCP call?
 *
 * Any outcome counts, `withheld` included, and so does one a later build added
 * (#92, owner ruling that not-sent records survive regeneration). This is not
 * `mayHaveLeft`, which asks whether bytes may have left: that question still
 * decides the mid-turn write in `runGeneration`, and this ruling does not widen
 * it.
 */
function carriesReceipt(variant: MessageVariant): boolean {
  return variant.toolCalls?.some((call) => call.receipt !== undefined) ?? false;
}

/* ── Generation ─────────────────────────────────────────────────────── */

interface RunOptions {
  /**
   * The turn `claimTurn` gave the caller, whose chat this runs in. Given back
   * here once the turn has run, and by the caller however it went.
   */
  turn: LiveTurn;
  overrideModelId?: string;
  /** Complete generations this turn has already had — see `generationsSoFar`. */
  previousVariants?: MessageVariant[];
  replaceMessageId?: string;
  /**
   * Run once nothing more can refuse the turn, in the same step it is handed to
   * the engine. What a regeneration discards goes here, so a turn that never
   * starts discards nothing.
   */
  beforeEngine?: () => Promise<void>;
}

/** Hands one turn to the engine. Resolves true if it did, false if it refused before that. */
async function runGeneration(
  set: (partial: Partial<ChatState>) => void,
  get: () => ChatState,
  options: RunOptions,
): Promise<boolean> {
  const app = useApp.getState();
  const engine = app.engine;
  if (!engine) {
    app.toast('The engine is still starting up.', 'warn');
    return false;
  }

  const { turn } = options;
  const { controller } = turn;
  const chat = get().chats.find((entry) => entry.id === turn.chatId);
  // Nor in a chat whose delete has been asked for: it stays in the store until
  // the delete lands. See `removedChats`.
  if (!chat || removedChats.has(chat.id)) return false;

  const choice = resolveTarget(chat, options.overrideModelId);
  if (choice.kind === 'none') {
    app.toast('Choose a model first — none is installed or connected yet.', 'warn');
    return false;
  }
  if (choice.kind === 'refused') {
    // Refused before anything is spent: no placeholder message, no activity
    // spinner, and no `noteUse` — a turn that never ran is not a use of the
    // model, and counting it would push a speech model up the "recently used"
    // ordering that the pickers sort by.
    app.toast(choice.message, 'warn');
    return false;
  }
  const { target } = choice;

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

  // `generating` has been set since the turn was claimed. See `claimTurn`.
  set({ messages: [...get().messages, placeholder] });
  app.setActivity(runsOnThisDevice(target) ? 'loading' : 'remote');

  const started = performance.now();
  let raw = '';
  let toolCalls: ToolInvocation[] = [];
  let firstDelta = true;
  let handedOver = false;

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

  livePlaceholderId = placeholder.id;

  try {
    // Deleted or stopped while the prompt was being built. A stopped signal is
    // not enough here: the engine does not read it before its first request —
    // measured, a turn stopped while its prompt was built still reached the
    // backend — and can raise a sheet before that. Nothing is handed over, and
    // no reply is left on screen being written.
    if (removedChats.has(chat.id) || controller.signal.aborted) {
      set({ messages: get().messages.filter((message) => message.id !== placeholder.id) });
      return false;
    }
    handedOver = true;
    // Started, not awaited: an await here would let a delete in between the
    // check above and the hand-off below. Its writes are made now, and it is
    // awaited once the stream has ended.
    const discarding = options.beforeEngine?.();
    // Only so a stream that throws first does not leave it unhandled.
    discarding?.catch(() => {});
    const stream = engine.stream({
      messages: built.messages,
      target,
      sampler: resolveSampler(chat, target.modelId),
      toolIds: chat.tools,
      egress: egressPolicy(chat.id, built.derivedReplies),
      mcpEgress: mcpEgressPolicy(chat.id),
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
              // An explicit property, for #259's reason given in `done` below:
              // a spread keeps compiling after the field it copies is deleted.
              receipt: event.tool.receipt,
            },
          ];
          patch((message) => ({ ...message, toolCalls }));

          // A receipt that says bytes may have left the device is written down
          // NOW. A withheld one waits for the turn to end like any other text.
          // Until this, nothing reached the database before the turn ended, and
          // a turn that errored, was stopped or was killed afterwards took the
          // record with it. The row goes in still marked streaming; `openChat`
          // recovers it if this generation never finishes. A call still in
          // flight when the app dies has no record — that write would have to
          // happen before the hand-off, inside the dispatcher.
          //
          // Built from this generation's own state, NOT looked up in
          // `messages`: that list is the thread on screen, and once the user
          // opens another chat mid-turn the running row is not in it — so the
          // lookup found nothing and nothing was written. It is the row `patch`
          // keeps on screen, field for field.
          if (mayHaveLeft(event.tool.receipt)) {
            const split = splitThinking(raw);
            await putMessage({
              ...placeholder,
              content: split.content,
              thinking: split.thinking || undefined,
              toolCalls,
              streaming: true,
            });
            // A regenerated turn's row now holds the generations of the row
            // it replaces, so that row goes now rather than after the turn.
            // Otherwise a kill from here on leaves both, and the reopened
            // thread shows the turn twice.
            if (options.replaceMessageId) await deleteMessageRow(options.replaceMessageId);
          }
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
              /*
               * #259. The engine has produced these since #149 and this
               * projection had no line for them, so #148's stream checksum,
               * #149's fallback warning and #142's codec redactions all
               * computed sentences that stopped here.
               *
               * AN EXPLICIT PROPERTY, NOT A CONDITIONAL SPREAD. The spread
               * form reads better and is type-unsafe: TypeScript does not
               * apply excess-property checking through a spread, so deleting
               * `warnings` from `Provenance` left this compiling while the
               * data still flowed — a type that says the field does not exist
               * over data that has it. Measured: with the spread, removing the
               * field produced zero errors. Written this way it is one.
               *
               * `undefined` rather than an empty array, so a renderer never
               * has to tell `[]` from absent.
               */
              warnings: event.provenance.warnings?.length
                ? event.provenance.warnings
                : undefined,
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
          await putMessage(finished);
          patch(() => finished);
          break;
        }

        case 'error': {
          /*
           * WHATEVER THE USER ALREADY SAW STAYS VISIBLE, with the failure
           * attached. This wrote `content: ''`, which threw away every
           * character that had streamed — and #260's ruling makes a
           * truncated stream an ERROR, so without this the ruling would trade
           * a silent-truncation defect for a lost-text one. #185's Done asks
           * for exactly the opposite.
           *
           * The `catch` below already preserved the row; only this branch
           * wiped it. They agree now.
           */
          const partial = splitThinking(raw);
          const failed: Message = {
            ...placeholder,
            content: partial.content.trim(),
            thinking: partial.thinking || undefined,
            // The calls happened, and a receipt among them says something left.
            // The placeholder has none, so without this line a failed turn
            // erased exactly the record it most needed to keep.
            toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
            streaming: false,
            error: event.message,
          };
          await putMessage(failed);
          patch(() => failed);
          app.toast(event.message, 'crit');
          break;
        }

        default:
          break;
      }
    }
    await discarding;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Generation failed.';
    const failed: Message = {
      ...placeholder,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      streaming: false,
      error: message,
    };
    await putMessage(failed);
    patch(() => failed);
    app.toast(message, 'crit');
  } finally {
    if (livePlaceholderId === placeholder.id) livePlaceholderId = null;
    // `generating` stays set while another turn is still claimed.
    releaseTurn(set, turn);
    if (liveTurns.size === 0) {
      app.setActivity('idle');
      app.setLiveRate(null);
    }

    // A turn never handed to the engine is not a use of the model, nor a reply.
    if (handedOver) {
      if (runsOnThisDevice(target)) void useModels.getState().noteUse(target.modelId);

      const last = get().messages.at(-1);
      await useChats.getState().updateChat(chat.id, (chatNow) => ({
        messageCount: chatNow.messageCount + 1,
        preview: last?.content.slice(0, 120) ?? chatNow.preview,
      }));
    }
  }
  return true;
}

/* ── Tool-output egress ──────────────────────────────────────────────── */

/**
 * The tool-output sheet's body: where the output going with this request came
 * from, then what sending it means.
 *
 * It used to say every tool "read from this app’s own data", which was true
 * while every tool ran here. An MCP tool's output comes back from someone
 * else's server and is marked tainted like any other (src/ai/engine.ts), so a
 * remote model raises this sheet over it — and the sheet said it was ours.
 *
 * TWO SOURCES, because the sheet is raised on two kinds of turn. `tools` are
 * the calls made in this turn, which the engine hands over. `earlier` are the
 * replies from previous turns that were written from tool output: the history
 * carries them marked tainted (`buildMessages`), so every later turn raises
 * this sheet before any tool has run, with `tools` empty. Attributing `tools`
 * alone fell back to "A tool read from this app’s own data" over a reply
 * written from what a server returned — on every turn after the call.
 *
 * This turn's calls are attributed by the receipt's OUTCOME, not by whether
 * there is one. A call that failed was handed to the server, and what came
 * back into the thread is this app's framing around an error message that the
 * server may itself have written (mcp-query passes a JSON-RPC error's text
 * through). So the sheet says the call did not complete on that host: neither
 * that the server returned it, nor that it is this app's own.
 *
 * An EARLIER call with no receipt is not called this app's own either. A row
 * stored before receipts existed looks exactly like a local tool's, so only a
 * receipt can name an origin, and without one the sheet names none.
 *
 * Exported so the attribution is measured against real tool records rather
 * than a copy of the string.
 */
export function toolOutputSheetBody(
  tools: readonly ExecutedTool[],
  earlier: readonly DerivedReply[],
  modelName: string,
  characters: number,
): string {
  const sentences: string[] = [];

  // Grouped by origin, so several local tools still read as one clause and
  // each server gets its own.
  const byOrigin = new Map<string, string[]>();
  for (const tool of tools) {
    const [name, origin] = originOf(tool);
    const names = byOrigin.get(origin) ?? [];
    if (!names.includes(name)) names.push(name);
    byOrigin.set(origin, names);
  }
  if (byOrigin.size > 0) {
    sentences.push([...byOrigin].map(([origin, names]) => `${names.join(', ')} ${origin}`).join('; '));
  }

  if (earlier.length > 0) {
    const bySource = new Map<string, { receipt: McpCallReceipt; names: string[] }>();
    for (const call of earlier.flatMap((reply) => reply.toolCalls)) {
      const receipt = call.receipt;
      if (receipt === undefined) continue;
      const key = `${receipt.outcome} ${receipt.host}`;
      const source = bySource.get(key) ?? { receipt, names: [] };
      if (!source.names.includes(receipt.toolName)) source.names.push(receipt.toolName);
      bySource.set(key, source);
    }
    const sources = [...bySource.values()].map(({ receipt, names }) =>
      earlierSourceOf(receipt, names.join(', ')),
    );
    sentences.push(
      'Earlier replies in this conversation drew on tool output' +
        (sources.length > 0 ? `, including ${sources.join('; ')}` : ''),
    );
  }

  // The engine asks only over tainted content, and both kinds are above, so
  // this is a floor that claims no origin rather than a sentence anyone should
  // normally read.
  if (sentences.length === 0) sentences.push('This request carries tool output');

  return (
    `${sentences.join('. ')}. ` +
    `To answer, ${modelName} has to see it. ` +
    `${characters.toLocaleString()} characters — this is not a message you typed.`
  );
}

/** A tool's name as the sheet prints it, and the clause saying where its output came from. */
function originOf(tool: ExecutedTool): [name: string, origin: string] {
  const receipt = tool.receipt;
  if (receipt === undefined) return [tool.name, 'read from this app’s own data'];
  switch (receipt.outcome) {
    case 'sent':
      return [receipt.toolName, `returned this from ${receipt.host}`];
    case 'failed':
      return [receipt.toolName, `did not complete on ${receipt.host}`];
    case 'withheld':
      // Nothing went, so nothing came back: the output is this app's refusal,
      // whatever held the call back. A reason added later has to say whether
      // that is still so before this compiles.
      switch (receipt.why) {
        case 'not-allowed':
        case 'declined':
        case 'server-changed':
        case 'stopped':
          return [receipt.toolName, `was not sent to ${receipt.host}; this app wrote its reply`];
        default:
          // Not sent; whose words came back is not this build's to say.
          return [receipt.toolName, `was not sent to ${receipt.host} (${unhandledWhy(receipt.why)})`];
      }
    default:
      // A new outcome has to say where its output came from before this compiles.
      return [tool.name, unhandledOutcome(receipt)];
  }
}

/** An earlier call's server as the sheet names it, which only its receipt can. */
function earlierSourceOf(receipt: McpCallReceipt, names: string): string {
  switch (receipt.outcome) {
    case 'sent':
      return `what ${names} returned from ${receipt.host}`;
    case 'failed':
      return `${names}, which did not complete on ${receipt.host}`;
    case 'withheld':
      switch (receipt.why) {
        case 'not-allowed':
        case 'declined':
        case 'server-changed':
        case 'stopped':
          return `${names}, which was not sent to ${receipt.host}`;
        default:
          return `${names}, which was not sent to ${receipt.host} (${unhandledWhy(receipt.why)})`;
      }
    default:
      return unhandledOutcome(receipt);
  }
}

/**
 * The consent side of the engine's rule, in the app's own voice.
 *
 * Read live from the store rather than captured when the turn started: a grant
 * made in the sheet has to be visible to the check that raised it, and the
 * chat record may have moved on by then. `earlier` is the exception, fixed for
 * the turn, because it describes the history this turn's prompt was built from.
 */
function egressPolicy(chatId: string, earlier: readonly DerivedReply[]): ToolEgressPolicy {
  const grantsFor = (): readonly EgressGrant[] =>
    useChats.getState().chats.find((entry) => entry.id === chatId)?.egressGrants ?? [];

  return {
    // Not while a grant for this connection may be one being withdrawn: the
    // store holds it until the revocation's write lands. See `withdrawals`.
    isGranted: (backendId) =>
      !providerWithdrawals.unsettled(backendId) &&
      holdsGrant(grantsFor(), { kind: 'provider', connectionId: backendId }),

    onGranted: (backendId) => {
      void useChats.getState().grantEgress(chatId, backendId);
    },

    // What ends the answer the engine holds for the rest of the turn, once the
    // connection it names is removed or switched off. See `withdrawals`.
    revocations: (backendId) => providerWithdrawals.count(backendId),

    async request({ backendId, modelName, tools, characters }) {
      const app = useApp.getState();
      const label =
        app.connections.find((connection) => connection.id === backendId)?.label ?? backendId;

      // Named, counted, and attributed. "The request contains a tool message"
      // is not a thing anybody can decide about; "`bash` read 3 files from this
      // app's own data" is.
      let extended = false;
      const allowed = await app.requestApproval(`send tool output to ${label}`, {
        title: `Send tool output to ${label}?`,
        body: toolOutputSheetBody(tools, earlier, modelName, characters),
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

/** The MCP send sheet, as `requestApproval` takes it. */
export interface McpSendSheet {
  readonly action: string;
  readonly title: string;
  readonly body: string;
  readonly detail: readonly string[];
  readonly confirmLabel: string;
  readonly extendedLabel: string;
  readonly cancelLabel: string;
}

/**
 * What a person is shown before an MCP call's arguments leave (#6).
 *
 * The tools, the server, its host and the bytes, and then each call's
 * arguments as the model wrote them, cut short and labelled as the model's.
 * The arguments are the one thing a person can actually judge, and a detail
 * line is rendered as text, so what the model wrote cannot become markup;
 * the label is there because it can still be persuasive.
 *
 * The plain yes covers exactly the calls listed and says so. The broader yes
 * names the host, because it covers every call to that server from here on.
 *
 * Exported so the sheet is measured against a request the real dispatcher
 * built, rather than a copy of these strings.
 */
export function mcpSendSheet({ destination, calls }: DestinationRequest): McpSendSheet {
  const { host, serverName } = destination;
  const names = [...new Set(calls.map((call) => call.toolName))].join(', ');
  const bytes = calls.reduce((total, call) => total + call.bytes, 0);
  const one = calls.length === 1;
  const confirmLabel = one ? 'Send this call' : 'Send these calls';

  return {
    action: `send tool arguments to ${host}`,
    title: `Send to ${host}?`,
    body:
      `${names} on ${serverName} would send ${bytes} bytes of arguments to ${host}` +
      (one ? '. ' : `, in ${calls.length} calls. `) +
      'The model wrote them from this conversation, and they do not leave this device unless you allow it. ' +
      `“${confirmLabel}” covers only ${one ? 'the call' : 'the calls'} listed here; a later call asks again.`,
    detail: calls.map(
      (call) => `${call.toolName} · ${call.bytes} bytes · written by the model: ${call.preview}`,
    ),
    confirmLabel,
    extendedLabel: `Send to ${host} for this conversation`,
    cancelLabel: 'Don’t send',
  };
}

/**
 * The MCP half of the consent, in the app's own voice (#6).
 *
 * Read live from the store, as `egressPolicy` is. `answered` holds a
 * conversation answer given during this turn until its write lands: the grant
 * is persisted with `void`, and a model that calls the same server again at
 * once must not be asked what the person has just answered for the whole
 * conversation. A changed address is a different key. An answer is held with
 * the server's revocation count when it was given, and honoured only while that
 * count stands: switching a server off and on again brings back the same record
 * at the same address, so the live check in `state/mcp.ts` cannot be what ends
 * it. The count is the one from BEFORE the sheet was raised: an answer given
 * while the server's grants were being withdrawn covers the calls it listed,
 * and nothing of it is kept. See `withdrawals`.
 */
function mcpEgressPolicy(chatId: string): ToolDestinationPolicy {
  const grantsFor = (): readonly EgressGrant[] =>
    useChats.getState().chats.find((entry) => entry.id === chatId)?.egressGrants ?? [];
  const answered = new Map<string, number>();
  const askedAt = new Map<string, number>();
  const keyOf = (destination: ToolDestination): string => `${destination.serverId} ${destination.url}`;

  return {
    // Not while a grant for this server may be one being withdrawn: the store
    // holds it until the revocation's write lands, and the dispatcher reads a
    // held grant again just before each call.
    isGranted: (destination) =>
      !mcpWithdrawals.unsettled(destination.serverId) &&
      (answered.get(keyOf(destination)) === mcpWithdrawals.count(destination.serverId) ||
        holdsGrant(grantsFor(), {
          kind: 'mcp',
          serverId: destination.serverId,
          url: destination.url,
        })),

    onGranted: (destination) => {
      const key = keyOf(destination);
      const since = askedAt.get(key);
      askedAt.delete(key);
      // Nobody was asked, or the server's grants were withdrawn while they were.
      if (since === undefined || since !== mcpWithdrawals.count(destination.serverId)) return;
      answered.set(key, since);
      void useChats
        .getState()
        .grantMcpEgress(chatId, { serverId: destination.serverId, url: destination.url });
    },

    async request(asked, signal) {
      askedAt.set(keyOf(asked.destination), mcpWithdrawals.count(asked.destination.serverId));
      const { action, ...prompt } = mcpSendSheet(asked);
      let extended = false;
      // The turn's signal goes with the sheet, so Stop takes it down. The no
      // that follows is read as stopped by the dispatcher, not as a refusal.
      const allowed = await useApp.getState().requestApproval(
        action,
        {
          ...prompt,
          onExtended: () => {
            extended = true;
          },
        },
        signal,
      );
      if (!allowed) return 'deny';
      return extended ? 'conversation' : 'calls';
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
  /**
   * The earlier replies this prompt carries marked tool-derived, in order. The
   * engine raises the tool-output sheet over them on every later turn, and it
   * knows only the tools that ran in THIS one — so what the sheet can say about
   * the rest comes from here. A reply the fit dropped is not going, and is not
   * listed.
   */
  readonly derivedReplies: readonly DerivedReply[];
}

/**
 * One earlier reply written while tools ran, and the calls its generation
 * made. Empty for a generation whose tool use was never recorded.
 */
export interface DerivedReply {
  readonly toolCalls: readonly ToolInvocation[];
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
  // Each tainted reply's calls, by the object pushed for it, so the replies that
  // survive the fit below can be told from the ones it dropped.
  const derivedFrom = new Map<IRMessage, readonly ToolInvocation[]>();

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
    const carry = (built: IRMessage): IRMessage => {
      if (!derived) return built;
      const marked = markTainted(built);
      derivedFrom.set(marked, message.toolCalls ?? []);
      return marked;
    };

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

  const repliesIn = (sent: readonly IRMessage[]): DerivedReply[] =>
    sent.flatMap((built) => {
      const toolCalls = derivedFrom.get(built);
      return toolCalls ? [{ toolCalls }] : [];
    });

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
      derivedReplies: repliesIn(result),
    };
  }

  const sampler = resolveSampler(chat, modelId);
  const fit = fitToContext(result, contextBudget(manifest.contextLength, sampler.maxTokens));
  return { messages: fit.messages, fit, derivedReplies: repliesIn(fit.messages) };
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

// And for an MCP server removed or switched off, by the server record's id.
installMcpGrantRevoker(async (serverId) => {
  await useChats.getState().revokeMcpEgress(serverId);
});

// Registered at module load for the same reason. An MCP tool id is
// `mcp:<server name>.<tool>` (src/ai/mcp/tools.ts), so a server's tools are
// exactly the ids under that prefix. THE TRAILING DOT IS LOAD-BEARING: without
// it, removing `notes` would also switch off `notesbook.search`. A dotted
// server name still over-prunes (`a` takes `a.b.search`), which fails closed.
installMcpToolPruner(async (serverName) => {
  const prefix = `mcp:${serverName}.`;
  // Until the chat list has loaded there is nothing here to prune. See
  // `beforeTheList`.
  if (!useChats.getState().loaded) beforeTheList.toolPrefixes.add(prefix);
  for (const chat of useChats.getState().chats) {
    if (!chat.tools.some((id) => id.startsWith(prefix))) continue;
    // A function of the chat as it stands when written, for the reason the
    // grant writes are: a list read before another write landed would put back
    // whatever that write changed.
    await useChats.getState().updateChat(chat.id, (current) =>
      current.tools.some((id) => id.startsWith(prefix))
        ? { tools: current.tools.filter((id) => !id.startsWith(prefix)) }
        : null,
    );
  }
});
