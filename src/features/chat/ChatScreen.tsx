import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useShallow } from 'zustand/react/shallow';

import { Icon } from '@/ui/Icon';
import { Rail } from '@/ui/Rail';
import { chatTarget, type ChatTarget, type Providerish } from '@/ui/target';
import { Confirm, Empty, Sheet } from '@/ui/primitives';
import { useApp } from '@/state/app';
import { useChats } from '@/state/chat';
import { useModels, chatModels, installedModels } from '@/state/models';
import { usePersonas, personaList } from '@/state/personas';
import { toolRegistry } from '@/ai/tools/registry';
import { canChat, nonChatRole } from '@/domain/manifest';
import type { InstalledModel } from '@/db';
import type { Attachment, Chat, Message } from '@/domain/chat';

import { Composer } from '@/features/chat/Composer';
import { MessageView } from '@/features/chat/MessageView';
import { SamplerPanel } from '@/features/chat/SamplerPanel';
import { exportConversation } from '@/lib/export';
import { registerCommand } from '@/lib/keys';

export function ChatScreen(): ReactNode {
  const chats = useChats((state) => state.chats);
  const activeChatId = useChats((state) => state.activeChatId);
  const messages = useChats((state) => state.messages);
  const generating = useChats((state) => state.generating);

  const [drawer, setDrawer] = useState<'none' | 'chats' | 'settings' | 'model'>('none');
  const [editing, setEditing] = useState<Message | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const installed = useModels((state) => state.installed);
  const modelsLoaded = useModels((state) => state.loaded);
  const activeModelId = useModels((state) => state.activeModelId);
  const chatsLoaded = useChats((state) => state.loaded);
  const settings = useApp((state) => state.settings);
  const connections = useApp((state) => state.connections);

  const chat = chats.find((entry) => entry.id === activeChatId) ?? null;
  const scroller = useRef<HTMLDivElement>(null);
  const pinnedToBottom = useRef(true);

  // Open the most recent chat, or start one. Gated on both stores having
  // loaded: starting a chat before the model store is ready would create it
  // with no model attached, and would also hide the user's existing chats.
  useEffect(() => {
    if (activeChatId || !chatsLoaded || !modelsLoaded) return;
    void (async () => {
      const store = useChats.getState();
      const first = store.chats[0];
      if (first) await store.openChat(first.id);
      else await store.newChat();
    })();
  }, [activeChatId, chatsLoaded, modelsLoaded]);

  // Keep the context readout honest as the thread, model, or persona changes.
  // Cheap (a character-count estimate), and it is the only thing that warns
  // before a long conversation starts silently losing its system prompt.
  useEffect(() => {
    if (!chatsLoaded || !modelsLoaded) return;
    useChats.getState().refreshContext();
  }, [chatsLoaded, modelsLoaded, activeChatId, messages.length, chat?.modelId, chat?.personaId]);

  // Follow the stream, but stop following the moment the user scrolls up.
  useEffect(() => {
    if (!pinnedToBottom.current) return;
    const element = scroller.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [messages]);

  const onScroll = useCallback(() => {
    const element = scroller.current;
    if (!element) return;
    const distance = element.scrollHeight - element.scrollTop - element.clientHeight;
    pinnedToBottom.current = distance < 80;
  }, []);

  // Mirror the engine's own resolution order: the chat's model, then the
  // globally active one. Anything else and the composer disables itself while
  // the engine would happily have generated.
  const effectiveModelId = chat?.modelId ?? activeModelId;
  const target = chatTarget(effectiveModelId, installed, connections);
  // The same selector the picker uses, so the two sentences a whisper-only
  // user meets — this screen's and the sheet's — name their models in one
  // order rather than two.
  const nonChat = useModels(useShallow(nonChatInstalled));
  const acceptsImages =
    target.kind === 'local' && target.model.manifest.capabilities.includes('vision');
  const hasTarget = target.kind === 'local' || target.kind === 'remote';

  const send = useCallback((text: string, attachments: Attachment[]) => {
    pinnedToBottom.current = true;
    void useChats.getState().send(text, attachments);
  }, []);

  const showThinking = chat?.showThinking ?? settings.showThinking;

  /*
   * The screen's three commands.
   *
   * Registered here rather than bound to a button, because a menu accelerator
   * and a key press must reach the same code and neither of them has a button
   * to click. `chat.next`/`chat.previous` walk `chats`, which is the same
   * order the session column renders — so "next" means the row below the one
   * highlighted, which is the only definition a user can predict.
   */
  useEffect(
    () =>
      registerCommand('chat.new', () => {
        void useChats.getState().newChat();
      }),
    [],
  );

  useEffect(() => {
    const step = (delta: number) => (): boolean => {
      const store = useChats.getState();
      const at = store.chats.findIndex((entry) => entry.id === store.activeChatId);
      if (at < 0) return false;
      const target = store.chats[at + delta];
      // No wrap: at either end the command declines rather than teleporting
      // from the newest chat to the oldest, which is disorienting on a list
      // whose length the user cannot see.
      if (!target) return false;
      void store.openChat(target.id);
      return true;
    };
    const offNext = registerCommand('chat.next', step(1));
    const offPrevious = registerCommand('chat.previous', step(-1));
    return () => {
      offNext();
      offPrevious();
    };
  }, []);

  return (
    <>
      <Rail
        title={chat?.title ?? 'Chatterang'}
        actions={
          <>
            <button
              type="button"
              className="icon-btn chat__history-toggle"
              onClick={() => setDrawer('chats')}
              aria-label="All chats"
            >
              <Icon name="more" size={18} />
            </button>
            <button
              type="button"
              className="icon-btn"
              onClick={() => setDrawer('settings')}
              aria-label="Chat settings"
            >
              <Icon name="sliders" size={18} />
            </button>
            <button
              type="button"
              className="icon-btn"
              onClick={() => void useChats.getState().newChat()}
              aria-label="New chat"
            >
              <Icon name="plus" size={18} />
            </button>
          </>
        }
      />

      <main className="app__body app__body--split">
        {/*
          The session list, as a COLUMN. Always mounted; `display: none` below
          the workbench tier, where ChatListSheet is the container instead.
          Which container the list is in is a viewport question, so CSS answers
          it — there is no width in this file and no resize listener anywhere.
        */}
        <aside className="history" aria-label="Chats">
          <div className="history__head">
            <span className="history__title">Chats</span>
            <button
              type="button"
              className="icon-btn"
              onClick={() => void useChats.getState().newChat({ mode: 'task' })}
              aria-label="New task"
              title="New task"
            >
              <Icon name="tool" size={16} />
            </button>
            <button
              type="button"
              className="icon-btn"
              onClick={() => void useChats.getState().newChat()}
              aria-label="New chat"
              title="New chat"
            >
              <Icon name="plus" size={16} />
            </button>
          </div>
          <div className="history__body">
            <ChatList onPick={() => undefined} onDelete={setConfirmDelete} />
          </div>
        </aside>

        <div className="chat__main">
          {messages.length === 0 ? (
            <StartState
              target={target}
              nonChat={nonChat}
              onPickModel={() => setDrawer('model')}
            />
          ) : (
            <div className="screen__scroll" ref={scroller} onScroll={onScroll}>
              <div className="thread">
                {messages.map((message) => (
                  <MessageView
                    key={message.id}
                    message={message}
                    showThinking={showThinking}
                    onRegenerate={(id) => void useChats.getState().regenerate(id)}
                    onEdit={setEditing}
                  />
                ))}
              </div>
            </div>
          )}

          <Composer
            disabled={!hasTarget}
            generating={generating}
            acceptsImages={acceptsImages}
            /*
             * THE FIRST-RUN STRING HAS TO FIT THE FIRST-RUN SCREEN.
             *
             * It was "Install a model or connect a provider first" — 265px of
             * text measured in Archivo at --t-control, in a field that offers
             * 245px at 390px of viewport. A placeholder that does not fit does
             * not ellipsize: it wraps, and the composer's field is 38px tall
             * with a 21.6px line box, so the second line was cut in half. The
             * only sentence in the app that a brand-new user is guaranteed to
             * read was the one that was clipped.
             *
             * The replacement is 33 characters and measures 208px in Archivo
             * and 218px in the fallback face — both inside 245 with room for a
             * wider face than either. tests/layout-engine.test.ts measures it
             * at 390px rather than trusting this note.
             */
            placeholder={
              hasTarget
                ? chat?.mode === 'task'
                  ? 'Describe the one-off task…'
                  : 'Message'
                : target.kind === 'refused'
                  ? // 29 characters, shorter than the string measured above and
                    // shown in the same field at the same width — to a user who
                    // is being told why the composer will not take their turn.
                    'Pick a model that writes text'
                  : 'Install a model or add a provider'
            }
            onSend={send}
            onStop={() => useChats.getState().stop()}
          />
        </div>
      </main>

      <ChatListSheet
        open={drawer === 'chats'}
        onClose={() => setDrawer('none')}
        onDelete={setConfirmDelete}
      />

      <ChatSettingsSheet
        open={drawer === 'settings'}
        chat={chat}
        onClose={() => setDrawer('none')}
      />

      <ModelPickerSheet open={drawer === 'model'} chat={chat} onClose={() => setDrawer('none')} />

      <EditSheet message={editing} onClose={() => setEditing(null)} />

      <Confirm
        open={confirmDelete !== null}
        title="Delete this chat?"
        body="The conversation and every message in it will be removed from this device. This cannot be undone."
        confirmLabel="Delete"
        destructive
        onCancel={() => setConfirmDelete(null)}
        onConfirm={() => {
          if (confirmDelete) void useChats.getState().removeChat(confirmDelete);
          setConfirmDelete(null);
        }}
      />
    </>
  );
}

/* ── Where this chat's next turn would actually go ──────────────────── */

/*
 * `chatTarget` moved to `@/ui/target` so the rail can ask the same question
 * with the same answer — it was resolving `chat?.modelId ?? activeModelId` and
 * `installed[modelId]` itself, with no capability check, and painting a chat
 * pinned to Whisper as a loaded local model directly above this screen saying
 * nothing is loaded. It is re-exported here because this is where every caller
 * and every test already reaches for it.
 */
export { chatTarget };
export type { ChatTarget, Providerish };

/**
 * The two sentences above an armed composer — and they are two, not one.
 *
 * "Everything here stays here. The model is running on this device." was
 * printed whenever anything at all was plugged in, INCLUDING when the only
 * thing plugged in was a remote provider and nothing local was installed. The
 * app's central claim is that you are told when a turn leaves the device, and
 * this was the screen that said the opposite in the configuration where it
 * mattered most.
 *
 * The local half also stopped claiming that a model "is running": nothing is
 * loaded until the first turn. What is true, and what the user needs, is where
 * it will run.
 *
 * THE REMOTE HALF NO LONGER SAYS ANYTHING ABOUT THE RECORD. It read "No model
 * on this device is selected", and `remote` does not mean that: `chatTarget`
 * returns `remote` whenever the pinned id has no INSTALLED record, which
 * includes a model that is pinned and still downloading, and an id from a
 * build that had it. Measured on `chat.modelId = 'llama-3.2-3b-instruct-q4km'`
 * in state `downloading`, this screen said nothing was selected while the
 * settings sheet two taps away named that exact model as the pin — the same
 * component contradicting itself about the same record. What IS true in every
 * `remote` case, and is the half the user actually needs, is that no model on
 * this device will answer it.
 *
 * THE MARKING CLAIM, WHICH BOTH BRANCHES MAKE, IS NOW ONE CLAUSE AND IT IS
 * SCOPED. It read "when a reply does come from one, it is marked" here and
 * "Every reply that comes back from a provider is marked as one" four lines
 * down — the same fact in two wordings, which is how the last three false
 * sentences on this journey got written. Both were also UNIVERSAL, and one
 * kind of reply falsifies a universal: a generation the v4 upgrade recovered
 * from a chat an older build saved. That build stored variants as bare
 * strings, so the origin of that text was never written down; it comes back
 * `unrecorded` and `MessageView` renders it with no chip rather than with the
 * row's — an invented label is the defect the variant record exists to
 * prevent. Measured through the real thread in
 * `tests/selection-copy.test.ts`: after `regenerate` and `‹`, a remote
 * generation reads `Remote`, and a recovered one reads the empty string.
 *
 * So the clause says FROM NOW ON — of every reply this build records, which
 * is what the code guarantees, and which is also the whole of what a user
 * starting a chat is about to do. The mark then follows that generation's own
 * text through regenerate, cycle and export, because it travels inside
 * `MessageVariant` rather than on the row.
 *
 * `Onboarding` states it in exactly these words, in both of its paragraphs,
 * and `tests/selection-copy.test.ts` refuses any collected sentence that
 * marks a reply in words its ledger does not carry.
 */
export function startProse(target: ChatTarget): { heading: string; body: string } | null {
  if (target.kind === 'local') {
    return {
      heading: 'Everything here stays here.',
      body:
        `${target.model.manifest.name} answers on this device. Nothing you type is sent ` +
        'anywhere unless you explicitly connect a remote provider — and from now on, every ' +
        'reply that comes back from a provider is marked Remote in the thread.',
    };
  }
  if (target.kind === 'remote') {
    return {
      heading: 'This chat leaves the device.',
      body:
        `No model on this device will answer it, so turns in this chat go to ${target.provider.label}. ` +
        'What you type, and anything a tool reads for the model, goes with them. From now on, ' +
        'every reply that comes back from a provider is marked Remote in the thread.',
    };
  }
  return null;
}

/**
 * A chat pinned to a model that cannot answer it.
 *
 * Names the model and what kind of model it is, in the same vocabulary as the
 * engine's own refusal — this is the sentence that has to arrive BEFORE the
 * message is typed rather than as a toast after it is sent.
 */
export function refusalCopy(model: InstalledModel): { title: string; body: string } {
  return {
    title: 'This chat cannot answer',
    body:
      `It is set to ${model.manifest.name}, which ${nonChatRole(model.manifest)} — nothing is ` +
      'loaded and nothing will be sent. Choose a model that writes text and the conversation ' +
      'is kept.',
  };
}

/**
 * The pin a shortened list can no longer show, and what to call it.
 *
 * `null` when the persisted value is one of the options actually rendered —
 * an installed chat model, or an enabled connection. Otherwise the record
 * says something the list cannot, and the control has to say it anyway.
 *
 * Every branch names a DIFFERENT reason, because "Choose…" was one label for
 * four situations and a user cannot act on any of them:
 *
 *  - installed and not a chat model (the reported case: Whisper),
 *  - installed but not finished downloading, so there is no file yet,
 *  - a provider that has since been switched off,
 *  - and an id nothing on this device knows, which is the one case where the
 *    honest label is the id itself: it is the only fact left.
 */
export function orphanOption(
  modelId: string | null,
  offered: readonly InstalledModel[],
  pinned: InstalledModel | undefined,
  connections: readonly Providerish[],
): { value: string; label: string } | null {
  if (!modelId) return null;
  if (offered.some((entry) => entry.id === modelId)) return null;
  if (connections.some((entry) => entry.enabled && entry.id === modelId)) return null;

  if (pinned) {
    const label =
      pinned.state === 'installed'
        ? `${pinned.manifest.name} ${nonChatRole(pinned.manifest)}`
        : `${pinned.manifest.name} — not finished downloading`;
    return { value: modelId, label };
  }

  const provider = connections.find((entry) => entry.id === modelId);
  if (provider) return { value: modelId, label: `${provider.label} — switched off` };

  return { value: modelId, label: `${modelId} — not on this device` };
}

/* ── "You have no chat model" — said without calling the user empty ─── */

/**
 * The models installed that cannot answer a chat.
 *
 * The selection fix swapped both pickers from `installedModels` to
 * `chatModels`, which is right — and it silently changed what an empty list
 * MEANS. It used to mean "you have downloaded nothing". It now also means "you
 * have downloaded something, and none of it can chat", and the two need
 * different sentences: the whisper-only user in the bug report has a model, was
 * told they had none, and would have gone and downloaded Whisper again.
 *
 * `ModelState` is not exported, so the selector's parameter is taken from the
 * selector it delegates to rather than by widening another agent's module.
 */
type ModelStore = Parameters<typeof installedModels>[0];

export function nonChatInstalled(state: ModelStore): InstalledModel[] {
  return installedModels(state).filter((entry) => !canChat(entry.manifest));
}

/** How many non-chat models to name before the sentence stops being readable. */
const NAMED = 2;

/**
 * "Whisper Tiny (English) is a speech-to-text model", for as many as fit.
 *
 * Naming them is the whole point: the user is being told that what they have
 * is not what they need, and a sentence that does not say what they have is
 * the same unactionable refusal as `Requested backend 'onnx-runtime' is not
 * registered`, one layer up.
 */
function rolesOf(models: readonly InstalledModel[]): string {
  const named = models
    .slice(0, NAMED)
    .map((entry) => `${entry.manifest.name} ${nonChatRole(entry.manifest)}`)
    .join('; ');
  const rest = models.length - NAMED;
  return rest > 0 ? `${named}, and ${rest} more like them` : named;
}

/** The model picker's empty state. `nonChat` is everything installed that can't chat. */
export function pickerEmptyCopy(nonChat: readonly InstalledModel[]): string {
  if (nonChat.length === 0) {
    return 'Nothing is installed yet. Open Models to download one — the smallest is under a gigabyte.';
  }
  return `Nothing installed can answer a chat: ${rolesOf(nonChat)}. Open Models to download a chat model — the smallest is under a gigabyte.`;
}

/**
 * The first thing a chat with nowhere to send a turn says.
 *
 * `load()` now nulls a persisted `activeModelId` that cannot chat, so the
 * whisper-only user is newly routed HERE on the upgrade that fixes their bug —
 * which makes "Download a model in Models" the second sentence in a row that
 * ignores the model they already downloaded.
 */
export function startStateCopy(nonChat: readonly InstalledModel[]): {
  title: string;
  body: string;
} {
  if (nonChat.length === 0) {
    return {
      title: 'Nothing to talk to yet',
      body: 'Download a model in Models, or connect a provider in Settings. Downloaded models run entirely on this device.',
    };
  }
  /*
   * WHY THIS BRANCH DOES NOT SAY "Downloaded models run entirely on this
   * device."
   *
   * It is the sentence the first branch ends on, and it was copied here. In
   * the first branch it follows "Download a model in Models" and is a promise
   * about a download the user has not made yet. Here it lands one sentence
   * after NAMING A MODEL THE USER ALREADY HAS — and on the platform the bug
   * was reported from, that model runs nowhere:
   * `@chatterang/plugin-onnx-runtime` is in none of package.json,
   * android/app/src/main/assets/capacitor.plugins.json,
   * android/capacitor.settings.gradle or ios/App/CapApp-SPM/Package.swift,
   * while `plugin-llama-cpp` is in all four. So "downloaded models run here"
   * told the whisper-only Android user that the thing they downloaded is
   * running on their phone, in the same paragraph that told them it cannot
   * chat. It is the same class of overclaim `nonChatRole` was written to
   * avoid.
   *
   * The promise is kept, narrowed to what it is true of: every chat-capable
   * entry in the catalogue is `llama-cpp`, whose plugin IS registered on all
   * four platforms, so the model this sentence is recommending really does
   * run here. What the user is holding gets no claim at all.
   */
  return {
    title: 'Nothing here can hold a conversation',
    body: `${rolesOf(nonChat)}. Download a chat model in Models, or connect a provider in Settings. A chat model downloaded there runs entirely on this device; a provider does not.`,
  };
}

/* ── Start state ────────────────────────────────────────────────────── */

function StartState({
  target,
  nonChat,
  onPickModel,
}: {
  target: ChatTarget;
  nonChat: readonly InstalledModel[];
  onPickModel: () => void;
}): ReactNode {
  const prose = startProse(target);

  if (!prose) {
    // Two dead ends, and they are not the same dead end: nothing is plugged
    // in at all, or this chat is pinned to something that cannot answer.
    const { title, body } =
      target.kind === 'refused' ? refusalCopy(target.model) : startStateCopy(nonChat);
    return (
      <Empty
        icon="flame"
        title={title}
        body={body}
        action={{ label: 'Choose a model', onClick: onPickModel }}
      />
    );
  }

  return (
    <div className="screen__scroll">
      <div className="screen__pad" style={{ paddingTop: 'var(--s-7)' }}>
        <div style={{ color: 'var(--ember)' }}>
          <Icon name={target.kind === 'remote' ? 'cloud' : 'flame'} size={30} />
        </div>
        <div className="stack" style={{ gap: 'var(--s-2)' }}>
          <h2 style={{ fontSize: 'var(--t-xl)', fontVariationSettings: "'wdth' 112" }}>
            {prose.heading}
          </h2>
          <p style={{ color: 'var(--ink-2)', maxWidth: '46ch' }}>{prose.body}</p>
        </div>
      </div>
    </div>
  );
}

/* ── Chat list ──────────────────────────────────────────────────────── */

/**
 * The session list itself — search box, rows, pin and delete.
 *
 * ONE component in TWO containers, which is the whole reason this was pulled
 * out of the sheet. Below the workbench tier it is the body of
 * ChatListSheet; at and above it, it is the body of the `.history` column.
 * A sibling implementation would have been the alternative and would have
 * meant two search boxes, two filters, and two definitions of what "selected"
 * looks like — the second of which is always the one that drifts.
 *
 * `onPick` is what the container does AFTER a row is opened: the sheet closes
 * itself, the column does nothing, because it is not in the way.
 */
function ChatList({
  onPick,
  onDelete,
}: {
  onPick: () => void;
  onDelete: (chatId: string) => void;
}): ReactNode {
  const chats = useChats((state) => state.chats);
  const activeChatId = useChats((state) => state.activeChatId);
  const [query, setQuery] = useState('');

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return chats;
    return chats.filter(
      (chat) =>
        chat.title.toLowerCase().includes(needle) || chat.preview.toLowerCase().includes(needle),
    );
  }, [chats, query]);

  return (
    <>
      <input
        className="input"
        placeholder="Search chats"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />

      {filtered.length === 0 ? (
        <p className="section__hint">No chats match that.</p>
      ) : (
        <div className="card card--flush">
          <div className="list">
            {filtered.map((chat) => (
              <div
                key={chat.id}
                className="list__item"
                aria-selected={chat.id === activeChatId}
                data-interactive="true"
              >
                <button
                  type="button"
                  className="list__main"
                  style={{ background: 'none', textAlign: 'left' }}
                  onClick={() => {
                    void useChats.getState().openChat(chat.id);
                    onPick();
                  }}
                >
                  <span className="list__title truncate">
                    {chat.pinned ? '★ ' : ''}
                    {chat.title}
                  </span>
                  <span className="list__sub truncate">
                    {chat.mode === 'task' ? 'Task · ' : ''}
                    {chat.messageCount} message{chat.messageCount === 1 ? '' : 's'}
                    {chat.preview ? ` · ${chat.preview}` : ''}
                  </span>
                </button>
                <button
                  type="button"
                  className="icon-btn"
                  onClick={() => void useChats.getState().togglePin(chat.id)}
                  aria-label={chat.pinned ? 'Unpin' : 'Pin'}
                  data-active={chat.pinned ? 'true' : undefined}
                >
                  <Icon name="pin" size={15} />
                </button>
                <button
                  type="button"
                  className="icon-btn"
                  onClick={() => onDelete(chat.id)}
                  aria-label={`Delete ${chat.title}`}
                >
                  <Icon name="trash" size={15} />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}

/** The narrow-width container for {@link ChatList}: a modal over the thread. */
function ChatListSheet({
  open,
  onClose,
  onDelete,
}: {
  open: boolean;
  onClose: () => void;
  onDelete: (chatId: string) => void;
}): ReactNode {
  return (
    <Sheet
      open={open}
      title="Chats"
      onClose={onClose}
      footer={
        <>
          <button
            type="button"
            className="btn btn--secondary grow"
            onClick={() => {
              void useChats.getState().newChat({ mode: 'task' });
              onClose();
            }}
          >
            New task
          </button>
          <button
            type="button"
            className="btn btn--primary grow"
            onClick={() => {
              void useChats.getState().newChat();
              onClose();
            }}
          >
            <Icon name="plus" size={15} />
            New chat
          </button>
        </>
      }
    >
      <ChatList onPick={onClose} onDelete={onDelete} />
    </Sheet>
  );
}

/* ── Chat settings ──────────────────────────────────────────────────── */

function ChatSettingsSheet({
  open,
  chat,
  onClose,
}: {
  open: boolean;
  chat: Chat | null;
  onClose: () => void;
}): ReactNode {
  const personas = usePersonas(useShallow(personaList));
  const models = useModels(useShallow(chatModels));
  // The pinned record itself, by id — NOT the whole installed map. The list a
  // user picks from stays `chatModels`; this is one lookup, so the control can
  // name a value that list has dropped.
  const pinned = useModels((state) => (chat?.modelId ? state.installed[chat.modelId] : undefined));
  const connections = useApp((state) => state.connections);
  const update = useChats((state) => state.updateChat);
  const toast = useApp((state) => state.toast);
  const [exporting, setExporting] = useState(false);

  // Declared before the early return so the hook order is stable; `chat` is
  // re-checked inside.
  const runExport = useCallback(async () => {
    if (!chat) return;
    setExporting(true);
    try {
      const outcome = await exportConversation(chat);
      // A dismissed share sheet is not a failure — the user changed their mind.
      if (outcome === 'downloaded') toast('Conversation exported.');
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Export failed.', 'warn');
    } finally {
      setExporting(false);
    }
  }, [chat, toast]);

  if (!chat) return null;

  const orphan = orphanOption(chat.modelId, models, pinned, connections);

  return (
    <Sheet open={open} title="This chat" onClose={onClose}>
      <div className="field">
        <label className="field__label" htmlFor="chat-persona">
          Persona
        </label>
        <select
          id="chat-persona"
          className="select"
          value={chat.personaId ?? ''}
          onChange={(event) =>
            void update(chat.id, { personaId: event.target.value || null })
          }
        >
          <option value="">None</option>
          {personas.map((persona) => (
            <option key={persona.id} value={persona.id}>
              {persona.name} — {persona.tagline}
            </option>
          ))}
        </select>
      </div>

      <div className="field">
        <label className="field__label" htmlFor="chat-model">
          Model
        </label>
        <select
          id="chat-model"
          className="select"
          value={chat.modelId ?? ''}
          onChange={(event) => void update(chat.id, { modelId: event.target.value || null })}
        >
          {/*
            THE OPTION THAT KEEPS THE CONTROL HONEST.

            This select is controlled on `chat.modelId`, and its options are
            now `chatModels` — a strictly shorter list than the one that could
            have been persisted here. A chat pinned to `whisper-tiny-en-onnx`
            has a value that matches no option, so the browser falls back to
            the first one and the control reads "Choose…" for a chat that IS
            pinned: the record says Whisper, the screen says nothing, and the
            user's next move is to wonder why an unpinned chat keeps refusing.

            The option is disabled, so it states the pin without offering it
            back. Nulling the field on open was the alternative and it is
            worse in the one way that matters: it edits the user's data to
            make a widget consistent, silently, on a sheet they may only have
            opened to read. This shows the record and leaves it alone —
            picking anything else replaces it, which is the fix either way.
          */}
          {orphan ? (
            <option value={orphan.value} disabled>
              {orphan.label}
            </option>
          ) : null}
          <option value="">Choose…</option>
          {models.length > 0 ? (
            <optgroup label="On this device">
              {models.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.manifest.name}
                </option>
              ))}
            </optgroup>
          ) : null}
          {connections.filter((connection) => connection.enabled).length > 0 ? (
            <optgroup label="Remote — leaves this device">
              {connections
                .filter((connection) => connection.enabled)
                .map((connection) => (
                  <option key={connection.id} value={connection.id}>
                    {connection.label}
                  </option>
                ))}
            </optgroup>
          ) : null}
        </select>
      </div>

      <div className="section">
        <div className="section__head">
          <h2>Tools</h2>
        </div>
        {/* This line has been wrong twice, each time by generalising over a
            list it does not control. "Tools run on this device and cannot
            reach the network" was false for every MCP tool in the unfiltered
            `toolRegistry.list()` below. Its replacement led with "Tools run on
            this device" and then "the app asks first", and both halves were
            measured false: an MCP tool executes on its server, and calling one
            sent the model's arguments there with no sheet at all. So the
            sentence is split by where the tool actually runs. The MCP half
            said nothing was asked until #6 made a grant the thing a call waits
            on; it now says what is asked, and in which order. */}
        <p className="section__hint">
          A tool from an MCP server runs on that server: calling one sends its arguments there
          once you allow that server, and a call the server calls destructive also asks about
          changing data there. Every other tool runs on this device; what it reads goes to the
          model, and off this device with it when the model is remote — that one the app asks
          about, every turn until you answer for the whole conversation.
        </p>
        <div className="row" style={{ gap: 'var(--s-2)', flexWrap: 'wrap' }}>
          {toolRegistry.list().map((tool) => {
            const enabled = chat.tools.includes(tool.id);
            return (
              <button
                key={tool.id}
                type="button"
                className="chip chip--button"
                aria-pressed={enabled}
                onClick={() =>
                  // ONE ID, IN THE LIST AS IT STANDS WHEN THIS IS WRITTEN — never
                  // the list this sheet rendered. Removing an MCP server prunes
                  // its tools from every chat, and a whole list built from a
                  // render older than the prune wrote the pruned tool back on,
                  // unasked (#6). And the way the chip SHOWED it: pressing a chip
                  // that was on turns it off, so it never adds a tool the list no
                  // longer holds. See `ChatPatch`.
                  void update(chat.id, (current) => {
                    const holds = current.tools.includes(tool.id);
                    if (enabled) {
                      return holds ? { tools: current.tools.filter((id) => id !== tool.id) } : null;
                    }
                    return holds ? null : { tools: [...current.tools, tool.id] };
                  })
                }
                title={tool.summary}
              >
                <Icon name="tool" size={11} />
                {tool.name}
              </button>
            );
          })}
        </div>
      </div>

      <div className="card card--quiet">
        <div className="row" style={{ gap: 'var(--s-3)' }}>
          <div className="list__main">
            <span className="list__title">Show reasoning</span>
            <span className="list__sub">
              Display the model’s working when it produces one.
            </span>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={chat.showThinking}
            aria-label="Show reasoning"
            className="switch"
            onClick={() =>
              void update(chat.id, (current) => ({ showThinking: !current.showThinking }))
            }
          />
        </div>
      </div>

      <SamplerPanel chat={chat} />

      <div className="section">
        <div className="section__head">
          <h2>Export</h2>
        </div>
        <p className="section__hint">
          Markdown, including which turns ran on this device and which went to a provider — a
          transcript that hid that would undo the point of marking it.
        </p>
        <button
          type="button"
          className="btn btn--secondary btn--block"
          disabled={exporting}
          onClick={() => void runExport()}
        >
          <Icon name="download" size={16} />
          {exporting ? 'Preparing…' : 'Export conversation'}
        </button>
      </div>
    </Sheet>
  );
}

/* ── Model picker ───────────────────────────────────────────────────── */

function ModelPickerSheet({
  open,
  chat,
  onClose,
}: {
  open: boolean;
  chat: Chat | null;
  onClose: () => void;
}): ReactNode {
  const models = useModels(useShallow(chatModels));
  const nonChat = useModels(useShallow(nonChatInstalled));

  return (
    <Sheet open={open} title="Choose a model" onClose={onClose}>
      {models.length === 0 ? (
        <p className="section__hint">{pickerEmptyCopy(nonChat)}</p>
      ) : (
        <div className="card card--flush">
          <div className="list">
            {models.map((entry) => (
              <button
                key={entry.id}
                type="button"
                className="list__item"
                data-interactive="true"
                aria-selected={chat?.modelId === entry.id}
                onClick={() => {
                  if (chat) void useChats.getState().updateChat(chat.id, { modelId: entry.id });
                  void useModels.getState().setActive(entry.id);
                  onClose();
                }}
              >
                <div className="list__main">
                  <span className="list__title">{entry.manifest.name}</span>
                  <span className="list__sub">{entry.manifest.bestFor}</span>
                </div>
                <span className="chip chip--local">{entry.manifest.quantization}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </Sheet>
  );
}

/* ── Edit a sent message ────────────────────────────────────────────── */

function EditSheet({
  message,
  onClose,
}: {
  message: Message | null;
  onClose: () => void;
}): ReactNode {
  const [text, setText] = useState('');

  useEffect(() => {
    setText(message?.content ?? '');
  }, [message]);

  if (!message) return null;

  return (
    <Sheet
      open
      title="Edit message"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn--secondary grow" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn--primary grow"
            onClick={() => {
              void useChats.getState().editMessage(message.id, text);
              onClose();
            }}
          >
            Save and regenerate
          </button>
        </>
      }
    >
      <p className="section__hint">
        Editing this message discards everything after it and generates a fresh reply.
      </p>
      <textarea
        className="textarea"
        value={text}
        onChange={(event) => setText(event.target.value)}
        rows={8}
      />
    </Sheet>
  );
}
