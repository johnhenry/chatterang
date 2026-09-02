import { useState, type ReactNode } from 'react';
import { useShallow } from 'zustand/react/shallow';

import { Icon } from '@/ui/Icon';
import { Segmented, Sheet } from '@/ui/primitives';
import type { CharacterBook, LoreEntry, Persona, PersonaDraft } from '@/domain/persona';
import { newId } from '@/domain/chat';
import { useModels, installedModels } from '@/state/models';
import { usePersonas } from '@/state/personas';
import { toolRegistry } from '@/ai/tools/registry';
import { Avatar } from '@/features/personas/Avatar';

/**
 * Persona editor (PRD §3.2).
 *
 * Two modes over one schema. An assistant needs a job description and a model;
 * a character needs a voice, a setting, and lore. Showing every field to both
 * would make each one twice as hard to write, so the editor changes shape.
 */
export function PersonaEditor({
  persona,
  onClose,
}: {
  persona: Persona | null;
  onClose: () => void;
}): ReactNode {
  const models = useModels(useShallow(installedModels));

  const [draft, setDraft] = useState<PersonaDraft>(
    persona ?? {
      kind: 'assistant',
      name: '',
      tagline: '',
      avatarSeed: newId('seed'),
      description: '',
      tags: [],
      showThinking: false,
      tools: [],
    },
  );

  const set = <K extends keyof PersonaDraft>(key: K, value: PersonaDraft[K]): void => {
    setDraft((current) => ({ ...current, [key]: value }));
  };

  const isCharacter = draft.kind === 'character';
  const canSave = draft.name.trim().length > 0;

  return (
    <Sheet
      open
      title={persona ? `Edit ${persona.name}` : 'New persona'}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn--secondary grow" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn--primary grow"
            disabled={!canSave}
            onClick={() => {
              void usePersonas.getState().save(draft);
              onClose();
            }}
          >
            Save
          </button>
        </>
      }
    >
      <Segmented
        label="Persona kind"
        value={draft.kind}
        onChange={(kind) => set('kind', kind)}
        options={[
          { value: 'assistant', label: 'Assistant' },
          { value: 'character', label: 'Character' },
        ]}
      />
      <p className="section__hint">
        {isCharacter
          ? 'A character has a voice and a world. Fields here map onto the Character Card v2 format, so cards import and export cleanly.'
          : 'An assistant has a job. Give it a clear instruction and, if it matters, a model that suits the work.'}
      </p>

      <div className="row" style={{ gap: 'var(--s-3)' }}>
        <Avatar
          persona={{ ...draft, id: 'preview', createdAt: 0, updatedAt: 0, version: 1 } as Persona}
          size={52}
        />
        <div className="stack grow" style={{ gap: 'var(--s-2)' }}>
          <input
            className="input"
            placeholder="Name"
            value={draft.name}
            onChange={(event) => set('name', event.target.value)}
          />
          <input
            className="input"
            placeholder="One-line summary"
            value={draft.tagline}
            onChange={(event) => set('tagline', event.target.value)}
          />
        </div>
      </div>

      <div className="field">
        <label className="field__label" htmlFor="persona-description">
          {isCharacter ? 'Who they are' : 'What it does'}
        </label>
        <textarea
          id="persona-description"
          className="textarea"
          rows={4}
          placeholder={
            isCharacter
              ? 'Appearance, history, mannerisms — what someone meeting them would notice.'
              : 'The kind of work this assistant handles.'
          }
          value={draft.description}
          onChange={(event) => set('description', event.target.value)}
        />
      </div>

      <div className="field">
        <label className="field__label" htmlFor="persona-system">
          System prompt
        </label>
        <textarea
          id="persona-system"
          className="textarea"
          rows={4}
          placeholder={
            isCharacter
              ? 'Leave blank to use a sensible default for staying in character.'
              : 'Direct instructions. Say what to do, and what not to do.'
          }
          value={draft.systemPrompt ?? ''}
          onChange={(event) => set('systemPrompt', event.target.value)}
          style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--t-sm)' }}
        />
        <span className="field__hint">
          Use {'{{char}}'} and {'{{user}}'} to refer to the persona and the person talking to it.
        </span>
      </div>

      {isCharacter ? (
        <>
          <div className="field">
            <label className="field__label" htmlFor="persona-personality">
              Personality
            </label>
            <textarea
              id="persona-personality"
              className="textarea"
              rows={3}
              value={draft.personality ?? ''}
              onChange={(event) => set('personality', event.target.value)}
            />
          </div>

          <div className="field">
            <label className="field__label" htmlFor="persona-scenario">
              Scenario
            </label>
            <textarea
              id="persona-scenario"
              className="textarea"
              rows={2}
              placeholder="Where and when the conversation is happening."
              value={draft.scenario ?? ''}
              onChange={(event) => set('scenario', event.target.value)}
            />
          </div>

          <div className="field">
            <label className="field__label" htmlFor="persona-first">
              Opening line
            </label>
            <textarea
              id="persona-first"
              className="textarea"
              rows={3}
              placeholder="What they say first, before the model generates anything."
              value={draft.firstMessage ?? ''}
              onChange={(event) => set('firstMessage', event.target.value)}
            />
          </div>

          <div className="field">
            <label className="field__label" htmlFor="persona-examples">
              Example dialogue
            </label>
            <textarea
              id="persona-examples"
              className="textarea"
              rows={4}
              placeholder={'{{user}}: …\n{{char}}: …'}
              value={draft.exampleDialogue ?? ''}
              onChange={(event) => set('exampleDialogue', event.target.value)}
            />
            <span className="field__hint">
              A couple of exchanges does more for the voice than paragraphs of description.
            </span>
          </div>

          <LoreEditor
            book={draft.characterBook}
            onChange={(characterBook) => set('characterBook', characterBook)}
          />
        </>
      ) : (
        <>
          <div className="field">
            <label className="field__label" htmlFor="persona-model">
              Preferred model
            </label>
            <select
              id="persona-model"
              className="select"
              value={draft.preferredModelId ?? ''}
              onChange={(event) => set('preferredModelId', event.target.value || undefined)}
            >
              <option value="">Whatever is active</option>
              {models.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.manifest.name}
                </option>
              ))}
            </select>
            <span className="field__hint">
              Used when a chat starts with this persona. If the model is not installed, the active
              one is used instead.
            </span>
          </div>

          <div className="section">
            <div className="section__head">
              <h2>Tools</h2>
            </div>
            <div className="row" style={{ gap: 'var(--s-2)', flexWrap: 'wrap' }}>
              {toolRegistry.list().map((tool) => {
                const enabled = draft.tools?.includes(tool.id) ?? false;
                return (
                  <button
                    key={tool.id}
                    type="button"
                    className="chip chip--button"
                    aria-pressed={enabled}
                    title={
                      tool.sensitive
                        ? `${tool.summary} — asked for per chat, not pre-enabled here`
                        : tool.summary
                    }
                    onClick={() =>
                      set(
                        'tools',
                        enabled
                          ? (draft.tools ?? []).filter((id) => id !== tool.id)
                          : [...(draft.tools ?? []), tool.id],
                      )
                    }
                  >
                    <Icon name="tool" size={11} />
                    {tool.name}
                    {tool.sensitive ? ' *' : ''}
                  </button>
                );
              })}
            </div>
            <span className="field__hint">
              A persona chooses which tools a new chat <em>starts</em> with. Tools marked * reach
              this app’s own data or leave its sandbox, so a persona cannot switch them on for you
              — you turn those on yourself, per chat, in the tool picker.
            </span>
          </div>
        </>
      )}

      <div className="field">
        <label className="field__label" htmlFor="persona-post">
          Final instruction
        </label>
        <textarea
          id="persona-post"
          className="textarea"
          rows={2}
          placeholder="Added right before the model replies — useful for rules it keeps forgetting."
          value={draft.postHistoryInstructions ?? ''}
          onChange={(event) => set('postHistoryInstructions', event.target.value)}
        />
      </div>
    </Sheet>
  );
}

function LoreEditor({
  book,
  onChange,
}: {
  book: CharacterBook | undefined;
  onChange: (book: CharacterBook) => void;
}): ReactNode {
  const entries = book?.entries ?? [];

  const update = (next: LoreEntry[]): void => {
    onChange({ ...book, entries: next });
  };

  return (
    <div className="section">
      <div className="section__head">
        <h2 className="grow">Lore</h2>
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          onClick={() =>
            update([
              ...entries,
              { id: newId('lore'), keys: [], content: '', enabled: true, priority: 0 },
            ])
          }
        >
          <Icon name="plus" size={13} />
          Add
        </button>
      </div>
      <p className="section__hint">
        Background that is only added to the prompt when its keywords come up. Keeps long histories
        out of every single request.
      </p>

      {entries.map((entry, index) => (
        <div key={entry.id} className="card card--quiet">
          <div className="row" style={{ gap: 'var(--s-2)' }}>
            <input
              className="input grow"
              placeholder="Keywords, comma-separated"
              value={entry.keys.join(', ')}
              onChange={(event) =>
                update(
                  entries.map((candidate, i) =>
                    i === index
                      ? {
                          ...candidate,
                          keys: event.target.value
                            .split(',')
                            .map((key) => key.trim())
                            .filter(Boolean),
                        }
                      : candidate,
                  ),
                )
              }
            />
            <button
              type="button"
              className="chip chip--button"
              aria-pressed={entry.constant ?? false}
              title="Always include this entry"
              onClick={() =>
                update(
                  entries.map((candidate, i) =>
                    i === index ? { ...candidate, constant: !candidate.constant } : candidate,
                  ),
                )
              }
            >
              Always
            </button>
            <button
              type="button"
              className="icon-btn"
              aria-label="Remove lore entry"
              onClick={() => update(entries.filter((_, i) => i !== index))}
            >
              <Icon name="trash" size={15} />
            </button>
          </div>
          <textarea
            className="textarea"
            rows={2}
            placeholder="What the model should know when those keywords appear."
            value={entry.content}
            onChange={(event) =>
              update(
                entries.map((candidate, i) =>
                  i === index ? { ...candidate, content: event.target.value } : candidate,
                ),
              )
            }
          />
        </div>
      ))}
    </div>
  );
}
