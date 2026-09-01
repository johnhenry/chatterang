import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useShallow } from 'zustand/react/shallow';

import { Icon } from '@/ui/Icon';
import { Rail } from '@/ui/Rail';
import { Confirm, Empty, Sheet } from '@/ui/primitives';
import { useApp } from '@/state/app';
import { useChats } from '@/state/chat';
import { useModels, installedModels } from '@/state/models';
import { usePersonas, personaList } from '@/state/personas';
import { toolRegistry } from '@/ai/tools/registry';
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
  const model = effectiveModelId ? installed[effectiveModelId] : undefined;
  const acceptsImages = Boolean(model?.manifest.capabilities.includes('vision'));
  const hasTarget =
    model?.state === 'installed' || connections.some((connection) => connection.enabled);

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
            <StartState hasTarget={hasTarget} onPickModel={() => setDrawer('model')} />
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

/* ── Start state ────────────────────────────────────────────────────── */

function StartState({
  hasTarget,
  onPickModel,
}: {
  hasTarget: boolean;
  onPickModel: () => void;
}): ReactNode {
  if (!hasTarget) {
    return (
      <Empty
        icon="flame"
        title="Nothing to talk to yet"
        body="Download a model in Models, or connect a provider in Settings. Downloaded models run entirely on this device."
        action={{ label: 'Choose a model', onClick: onPickModel }}
      />
    );
  }

  return (
    <div className="screen__scroll">
      <div className="screen__pad" style={{ paddingTop: 'var(--s-7)' }}>
        <div style={{ color: 'var(--ember)' }}>
          <Icon name="flame" size={30} />
        </div>
        <div className="stack" style={{ gap: 'var(--s-2)' }}>
          <h2 style={{ fontSize: 'var(--t-xl)', fontVariationSettings: "'wdth' 112" }}>
            Everything here stays here.
          </h2>
          <p style={{ color: 'var(--ink-2)', maxWidth: '46ch' }}>
            The model is running on this device. Nothing you type is sent anywhere unless you
            explicitly connect a remote provider — and when a reply does come from one, it is
            marked.
          </p>
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
  const models = useModels(useShallow(installedModels));
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
        <p className="section__hint">
          Tools run on this device and cannot reach the network.
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
                  void update(chat.id, {
                    tools: enabled
                      ? chat.tools.filter((id) => id !== tool.id)
                      : [...chat.tools, tool.id],
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
            onClick={() => void update(chat.id, { showThinking: !chat.showThinking })}
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
  const models = useModels(useShallow(installedModels));

  return (
    <Sheet open={open} title="Choose a model" onClose={onClose}>
      {models.length === 0 ? (
        <p className="section__hint">
          Nothing is installed yet. Open Models to download one — the smallest is under a gigabyte.
        </p>
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
