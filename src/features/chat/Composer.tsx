import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

import { Icon } from '@/ui/Icon';
import { newId, type Attachment } from '@/domain/chat';
import { useApp } from '@/state/app';
import { useModels, modelsWith } from '@/state/models';
import { startDictation, type DictationHandle } from '@/lib/voice';
import { ensureSession } from '@/lib/voice';

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

  // Grow with content up to the max height set in CSS.
  useEffect(() => {
    const element = textarea.current;
    if (!element) return;
    element.style.height = 'auto';
    element.style.height = `${Math.min(element.scrollHeight, window.innerHeight * 0.4)}px`;
  }, [text]);

  const send = useCallback(() => {
    const trimmed = text.trim();
    if (!trimmed && attachments.length === 0) return;
    onSend(trimmed, attachments);
    setText('');
    setAttachments([]);
  }, [text, attachments, onSend]);

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
        added.push({
          kind: 'image',
          id: newId('att'),
          mediaType: file.type,
          data: await toBase64(file),
        });
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
                <img
                  src={`data:${attachment.mediaType};base64,${attachment.data}`}
                  alt="Attachment preview"
                />
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
              className="icon-btn"
              style={{ width: 40, height: 40 }}
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
          className="icon-btn"
          style={{ width: 40, height: 40 }}
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
            // Enter sends on a physical keyboard; on touch it inserts a
            // newline, because there is no comfortable way to type Shift+Enter
            // on a phone.
            if (event.key === 'Enter' && !event.shiftKey && matchMedia('(pointer: fine)').matches) {
              event.preventDefault();
              send();
            }
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

async function toBase64(file: File): Promise<string> {
  const buffer = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < buffer.length; i += CHUNK) {
    binary += String.fromCharCode(...buffer.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}
