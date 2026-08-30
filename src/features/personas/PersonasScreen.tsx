import { useRef, useState, type ReactNode } from 'react';
import { useShallow } from 'zustand/react/shallow';

import { Icon } from '@/ui/Icon';
import { Rail } from '@/ui/Rail';
import { Confirm, Segmented, Sheet } from '@/ui/primitives';
import type { CharacterCardV2, Persona } from '@/domain/persona';
import { useApp } from '@/state/app';
import { useChats } from '@/state/chat';
import { usePersonas, personaList } from '@/state/personas';

import { PersonaEditor } from '@/features/personas/PersonaEditor';
import { Marketplace } from '@/features/personas/Marketplace';
import { Avatar } from '@/features/personas/Avatar';

type View = 'mine' | 'market';

export function PersonasScreen({ onOpenChat }: { onOpenChat: () => void }): ReactNode {
  const [view, setView] = useState<View>('mine');
  const [editing, setEditing] = useState<Persona | 'new' | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<Persona | null>(null);
  const [detail, setDetail] = useState<Persona | null>(null);

  const personas = usePersonas(useShallow(personaList));
  const defaultPersonaId = usePersonas((state) => state.defaultPersonaId);
  const fileInput = useRef<HTMLInputElement>(null);
  const toast = useApp((state) => state.toast);

  const importCard = async (file: File | undefined): Promise<void> => {
    if (!file) return;
    try {
      const card = JSON.parse(await file.text()) as CharacterCardV2;
      if (card.spec !== 'chara_card_v2') {
        toast('That file is not a Character Card v2.', 'warn');
        return;
      }
      await usePersonas.getState().importCard(card);
    } catch {
      toast('That file could not be read as a character card.', 'crit');
    }
  };

  return (
    <>
      <Rail
        title="Personas"
        actions={
          <>
            <input
              ref={fileInput}
              type="file"
              accept="application/json,.json"
              className="sr-only"
              onChange={(event) => {
                void importCard(event.target.files?.[0]);
                event.target.value = '';
              }}
            />
            <button
              type="button"
              className="icon-btn"
              onClick={() => fileInput.current?.click()}
              aria-label="Import character card"
            >
              <Icon name="download" size={18} />
            </button>
            <button
              type="button"
              className="icon-btn"
              onClick={() => setEditing('new')}
              aria-label="New persona"
            >
              <Icon name="plus" size={18} />
            </button>
          </>
        }
      />

      <main className="app__body">
        <div className="screen__scroll">
          <div className="screen__pad">
            <Segmented
              label="Persona view"
              value={view}
              onChange={setView}
              options={[
                { value: 'mine', label: 'Mine' },
                { value: 'market', label: 'Marketplace' },
              ]}
            />

            {view === 'market' ? (
              <Marketplace />
            ) : (
              <div className="section">
                {personas.map((persona) => (
                  <div
                    key={persona.id}
                    className={`card ${persona.kind === 'character' ? 'card--remote' : 'card--local'}`}
                  >
                    <div className="row" style={{ gap: 'var(--s-3)', alignItems: 'flex-start' }}>
                      <Avatar persona={persona} size={42} />
                      <div className="list__main">
                        <span className="card__title">
                          {persona.name}
                          {defaultPersonaId === persona.id ? (
                            <span className="chip chip--local" style={{ marginLeft: 8 }}>
                              Default
                            </span>
                          ) : null}
                        </span>
                        <span className="list__sub">{persona.tagline}</span>
                      </div>
                      <span className="chip">
                        {persona.kind === 'character' ? 'Character' : 'Assistant'}
                      </span>
                    </div>

                    <div className="row" style={{ gap: 'var(--s-2)', flexWrap: 'wrap' }}>
                      <button
                        type="button"
                        className="btn btn--primary btn--sm"
                        onClick={() => {
                          void useChats.getState().newChat({ personaId: persona.id });
                          onOpenChat();
                        }}
                      >
                        <Icon name="chat" size={14} />
                        Chat
                      </button>
                      <button
                        type="button"
                        className="btn btn--secondary btn--sm"
                        onClick={() => setDetail(persona)}
                      >
                        Details
                      </button>
                      <button
                        type="button"
                        className="btn btn--ghost btn--sm"
                        onClick={() =>
                          persona.builtin
                            ? void usePersonas.getState().duplicate(persona.id)
                            : setEditing(persona)
                        }
                      >
                        <Icon name={persona.builtin ? 'copy' : 'edit'} size={14} />
                        {persona.builtin ? 'Duplicate' : 'Edit'}
                      </button>
                      {!persona.builtin ? (
                        <button
                          type="button"
                          className="icon-btn"
                          aria-label={`Delete ${persona.name}`}
                          onClick={() => setConfirmDelete(persona)}
                        >
                          <Icon name="trash" size={15} />
                        </button>
                      ) : null}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </main>

      {editing ? (
        <PersonaEditor
          persona={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
        />
      ) : null}

      <PersonaDetailSheet persona={detail} onClose={() => setDetail(null)} />

      <Confirm
        open={confirmDelete !== null}
        title={`Delete ${confirmDelete?.name ?? 'this persona'}?`}
        body="Chats that used this persona keep their messages, but lose its instructions."
        confirmLabel="Delete"
        destructive
        onCancel={() => setConfirmDelete(null)}
        onConfirm={() => {
          if (confirmDelete) void usePersonas.getState().remove(confirmDelete.id);
          setConfirmDelete(null);
        }}
      />
    </>
  );
}

function PersonaDetailSheet({
  persona,
  onClose,
}: {
  persona: Persona | null;
  onClose: () => void;
}): ReactNode {
  const defaultPersonaId = usePersonas((state) => state.defaultPersonaId);
  const toast = useApp((state) => state.toast);

  if (!persona) return null;

  const exportCard = (): void => {
    const card = usePersonas.getState().exportCard(persona.id);
    if (!card) return;

    const blob = new Blob([JSON.stringify(card, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${persona.name.replaceAll(/[^\w-]+/g, '_')}.card.json`;
    anchor.click();
    URL.revokeObjectURL(url);
    toast('Character card exported.', 'good');
  };

  return (
    <Sheet
      open
      title={persona.name}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn--secondary grow" onClick={exportCard}>
            Export card
          </button>
          <button
            type="button"
            className="btn btn--primary grow"
            disabled={defaultPersonaId === persona.id}
            onClick={() => void usePersonas.getState().setDefault(persona.id)}
          >
            {defaultPersonaId === persona.id ? 'Default persona' : 'Make default'}
          </button>
        </>
      }
    >
      <div className="row" style={{ gap: 'var(--s-3)' }}>
        <Avatar persona={persona} size={56} />
        <div className="list__main">
          <span className="list__title">{persona.tagline}</span>
          <span className="list__sub">
            {persona.creator ? `by ${persona.creator} · ` : ''}version {persona.version}
          </span>
        </div>
      </div>

      <Field label="Description" value={persona.description} />
      {persona.personality ? <Field label="Personality" value={persona.personality} /> : null}
      {persona.scenario ? <Field label="Scenario" value={persona.scenario} /> : null}
      {persona.systemPrompt ? (
        <Field label="System prompt" value={persona.systemPrompt} mono />
      ) : null}
      {persona.firstMessage ? <Field label="Opening line" value={persona.firstMessage} /> : null}

      {persona.characterBook?.entries.length ? (
        <div className="section">
          <div className="section__head">
            <h2>Lore</h2>
          </div>
          <p className="section__hint">
            These are added to the prompt only when their keywords appear in the recent
            conversation.
          </p>
          <div className="card card--flush">
            <div className="list">
              {persona.characterBook.entries.map((entry) => (
                <div key={entry.id} className="list__item">
                  <div className="list__main">
                    <span className="list__title">
                      {entry.constant ? 'Always' : entry.keys.join(', ')}
                    </span>
                    <span className="list__sub">{entry.content}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      ) : null}

      {persona.tools?.length ? (
        <div className="row" style={{ gap: 'var(--s-2)', flexWrap: 'wrap' }}>
          {persona.tools.map((tool) => (
            <span key={tool} className="chip">
              <Icon name="tool" size={11} />
              {tool}
            </span>
          ))}
        </div>
      ) : null}
    </Sheet>
  );
}

function Field({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}): ReactNode {
  return (
    <div className="field">
      <span className="field__label">{label}</span>
      <p
        style={{
          fontSize: 'var(--t-sm)',
          color: 'var(--ink-2)',
          whiteSpace: 'pre-wrap',
          fontFamily: mono ? 'var(--font-mono)' : undefined,
          lineHeight: 'var(--lh-body)',
        }}
      >
        {value}
      </p>
    </div>
  );
}
