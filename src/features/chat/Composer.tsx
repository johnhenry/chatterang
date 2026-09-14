import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { AttachmentImage } from '@/features/chat/AttachmentImage';

import { Icon } from '@/ui/Icon';
import { putBlob } from '@/lib/blobs';
import { newId, type Attachment } from '@/domain/chat';
import { useApp } from '@/state/app';
import { useModels, modelsWith } from '@/state/models';
import { hasFinePointer } from '@/lib/platform';
import { commandFor, registerCommand } from '@/lib/keys';
import { startDictation, type DictationHandle } from '@/lib/voice';
import { ensureSession, releaseSessions } from '@/lib/voice';

export interface ComposerProps {
  disabled: boolean;
  generating: boolean;
  /** Whether the selected model accepts images. */
  acceptsImages: boolean;
  placeholder: string;
  onSend: (text: string, attachments: Attachment[]) => void;
  onStop: () => void;
}

export function Composer({
  disabled,
  generating,
  acceptsImages,
  placeholder,
  onSend,
  onStop,
}: ComposerProps): ReactNode {
  const [text, setText] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [dictating, setDictating] = useState(false);
  const dictation = useRef<DictationHandle | null>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const toast = useApp((state) => state.toast);

  /*
   * DICTATION DOES NOT SURVIVE THIS COMPONENT, and neither does its model.
   *
   * `ensureSession('stt', …)` opens native graphs in the inference host — 79
   * MB of Whisper encoder and 199 MB of decoder for whisper-base — and NOTHING
   * in `src/` released the `stt` task. `releaseSessions` existed and was called
   * only for `diffusion`, from `src/state/images.ts`. So the first time a user
   * tapped the microphone, a quarter of a gigabyte became resident for the
   * rest of the app's life whether or not they ever dictated again.
   *
   * This unmount is a REAL event, not a theoretical one: `App.tsx` renders
   * `{tab === 'chat' ? <ChatScreen /> : null}`, so every switch to Models,
   * Personas, Studio or Settings unmounts this component. Releasing here is
   * the same policy `images.ts` already applies to diffusion ("free the
   * pipeline immediately rather than waiting for pressure"), and the cost is
   * one reload on the next dictation rather than a permanent resident.
   *
   * The in-flight turn is stopped first. Cancelling a transcription and
   * releasing the session it runs on are different things — the first stops
   * work, the second frees memory — and this component owned both and did
   * neither, so a tab switch mid-dictation left a turn streaming partials at a
   * page that had gone away.
   */
  useEffect(() => {
    return () => {
      dictation.current?.stop();
      dictation.current = null;
      void releaseSessions('stt').catch(() => undefined);
    };
  }, []);

  /*
   * The composer's two commands, published to the dispatch layer.
   *
   * `chat.focusComposer` is the one a window user reaches for blindly and had
   * no way to express before: there was no path from "somewhere else on the
   * page" to this textarea. `chat.send` is registered as well as handled
   * locally, because the local handler answers a KEY PRESS IN THIS FIELD and
   * the registration answers a menu item or an accelerator, which have no
   * focus and no event.
   */
  useEffect(
    () =>
      registerCommand('chat.focusComposer', () => {
        textarea.current?.focus();
      }),
    [],
  );

  // Grow with content up to the max height set in CSS.
  useEffect(() => {
    const element = textarea.current;
    if (!element) return;
    element.style.height = 'auto';
    element.style.height = `${Math.min(element.scrollHeight, window.innerHeight * 0.4)}px`;
  }, [text]);

  const send = useCallback(() => {
    // NOT WHILE A TURN IS RUNNING, and the text stays. Send is not on screen
    // then — Stop is — but Enter in the field and the Send command still came
    // here, handed the text over and cleared the field, and the store refuses a
    // turn while one runs: what was typed was gone.
    if (generating) return;
    const trimmed = text.trim();
    if (!trimmed && attachments.length === 0) return;
    onSend(trimmed, attachments);
    setText('');
    setAttachments([]);
  }, [generating, text, attachments, onSend]);

  useEffect(
    () =>
      registerCommand('chat.send', () => {
        // `false` hands the command back to the dispatcher rather than
        // pretending a disabled composer sent something — nor one that sends
        // nothing while a turn runs.
        if (disabled || generating) return false;
        send();
        return true;
      }),
    [disabled, generating, send],
  );

  const addImages = useCallback(
    async (files: FileList | null) => {
      if (!files) return;
      const added: Attachment[] = [];

      for (const file of Array.from(files).slice(0, 4)) {
        if (!file.type.startsWith('image/')) continue;
        if (file.size > 12 * 1024 * 1024) {
          toast(`${file.name} is too large — images must be under 12 MB.`, 'warn');
          continue;
        }
        // The payload goes to the blob table; the attachment keeps only what
        // is needed to lay it out and label it. A File is already a Blob, so
        // nothing is re-encoded here.
        const id = newId('att');
        await putBlob(id, file);
        added.push({ kind: 'image', id, mediaType: file.type, bytes: file.size });
      }

      if (added.length > 0) setAttachments((current) => [...current, ...added]);
    },
    [toast],
  );

  const toggleDictation = useCallback(async () => {
    if (dictating) {
      dictation.current?.stop();
      dictation.current = null;
      setDictating(false);
      return;
    }

    const speechModel = modelsWith(useModels.getState(), 'audio-in')[0];
    if (!speechModel?.paths.model) {
      toast('Install a speech model in Models to dictate.', 'warn');
      return;
    }

    setDictating(true);
    try {
      const session = await ensureSession('stt', speechModel.paths.model, speechModel.paths);
      dictation.current = await startDictation({
        handle: session.handle,
        onPartial: (partial) => setText(partial),
        onFinal: (final) => {
          if (final) setText(final);
          setDictating(false);
          dictation.current = null;
        },
        onError: (message) => {
          toast(message, 'crit');
          setDictating(false);
          dictation.current = null;
        },
      });
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Dictation failed to start.', 'crit');
      setDictating(false);
    }
  }, [dictating, toast]);

  return (
    <div className="composer">
      {attachments.length > 0 ? (
        <div className="composer__attachments">
          {attachments.map((attachment) =>
            attachment.kind === 'image' ? (
              <div className="attachment" key={attachment.id}>
                <AttachmentImage id={attachment.id} alt="Attachment preview" />
                <button
                  type="button"
                  className="attachment__remove"
                  aria-label="Remove attachment"
                  onClick={() =>
                    setAttachments((current) =>
                      current.filter((entry) => entry.id !== attachment.id),
                    )
                  }
                >
                  ×
                </button>
              </div>
            ) : null,
          )}
        </div>
      ) : null}

      <div className="composer__row">
        {acceptsImages ? (
          <>
            <input
              ref={fileInput}
              type="file"
              accept="image/*"
              multiple
              className="sr-only"
              onChange={(event) => {
                void addImages(event.target.files);
                event.target.value = '';
              }}
            />
            <button
              type="button"
              className="icon-btn composer__btn"
              onClick={() => fileInput.current?.click()}
              aria-label="Attach an image"
              disabled={disabled}
            >
              <Icon name="image" size={19} />
            </button>
          </>
        ) : null}

        <button
          type="button"
          className="icon-btn composer__btn"
          data-active={dictating ? 'true' : undefined}
          onClick={() => void toggleDictation()}
          aria-label={dictating ? 'Stop dictation' : 'Dictate'}
          disabled={disabled}
        >
          <Icon name="mic" size={19} />
        </button>

        <textarea
          ref={textarea}
          className="composer__input"
          rows={1}
          value={text}
          placeholder={placeholder}
          disabled={disabled}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            // The table decides what the key MEANS; this field decides whether
            // it applies. Enter sends on a physical keyboard and inserts a
            // newline on touch, because there is no comfortable way to type
            // Shift+Enter on a phone — while Mod+Enter sends either way, which
            // is what a phone with a Bluetooth keyboard actually needs.
            if (commandFor(event) !== 'chat.send') return;
            if (!event.metaKey && !event.ctrlKey && !hasFinePointer()) return;
            event.preventDefault();
            send();
          }}
          onPaste={(event) => {
            if (!acceptsImages) return;
            const files = event.clipboardData.files;
            if (files.length > 0) {
              event.preventDefault();
              void addImages(files);
            }
          }}
        />

        {generating ? (
          <button
            type="button"
            className="composer__send"
            onClick={onStop}
            aria-label="Stop generating"
            style={{ background: 'var(--surface-3)', color: 'var(--ink)' }}
          >
            <Icon name="stop" size={17} />
          </button>
        ) : (
          <button
            type="button"
            className="composer__send"
            onClick={send}
            disabled={disabled || (!text.trim() && attachments.length === 0)}
            aria-label="Send"
          >
            <Icon name="send" size={19} />
          </button>
        )}
      </div>
    </div>
  );
}

