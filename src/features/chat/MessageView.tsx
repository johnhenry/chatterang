import { Suspense, lazy, useState, type ReactNode } from 'react';
import { AttachmentImage } from '@/features/chat/AttachmentImage';

import { Icon } from '@/ui/Icon';
import { CopyButton } from '@/ui/primitives';
import { frameDocument } from '@/ui/frame';
import type { Message, ToolInvocation } from '@/domain/chat';
import { useApp } from '@/state/app';
import { useChats } from '@/state/chat';
import { speak, stopSpeaking } from '@/lib/voice';

// Syntax highlighting is a large dependency and is not needed to paint the
// first frame, so it loads with the first rendered reply instead.
const Markdown = lazy(() =>
  import('@/ui/Markdown').then((module) => ({ default: module.Markdown })),
);

export interface MessageViewProps {
  message: Message;
  showThinking: boolean;
  onRegenerate: (messageId: string) => void;
  onEdit: (message: Message) => void;
}

export function MessageView({
  message,
  showThinking,
  onRegenerate,
  onEdit,
}: MessageViewProps): ReactNode {
  const settings = useApp((state) => state.settings);
  const deleteMessage = useChats((state) => state.deleteMessage);
  const cycleVariant = useChats((state) => state.cycleVariant);
  const [speaking, setSpeaking] = useState(false);

  if (message.role === 'user') {
    return (
      <article className="msg msg--user">
        {message.attachments?.length ? (
          <div className="composer__attachments" style={{ justifyContent: 'flex-end' }}>
            {message.attachments.map((attachment) =>
              attachment.kind === 'image' ? (
                <div className="attachment" key={attachment.id}>
                  <AttachmentImage id={attachment.id} alt="Attachment" />
                </div>
              ) : null,
            )}
          </div>
        ) : null}
        <div className="msg__bubble">{message.content}</div>
        <div className="msg__foot">
          <CopyButton text={message.content} />
          <button
            type="button"
            className="icon-btn"
            onClick={() => onEdit(message)}
            aria-label="Edit and resend"
          >
            <Icon name="edit" size={15} />
          </button>
        </div>
      </article>
    );
  }

  const variants = message.variants ?? [];
  const totalVariants = variants.length + (variants.length > 0 ? 1 : 0);

  const toggleSpeech = (): void => {
    if (speaking) {
      stopSpeaking();
      setSpeaking(false);
      return;
    }
    setSpeaking(true);
    void speak({
      text: message.content,
      strategy: settings.voiceMode === 'neural' ? 'neural' : 'os',
      voiceId: settings.voiceId || undefined,
      rate: settings.speechRate,
    }).finally(() => setSpeaking(false));
  };

  return (
    <article className="msg msg--assistant">
      <div className="msg__head">
        <span className="msg__who">
          {message.provenance?.modelName ?? (message.streaming ? 'Thinking' : 'Assistant')}
        </span>
        {message.provenance ? (
          <span className={`chip ${message.provenance.local ? 'chip--local' : 'chip--remote'}`}>
            <Icon name={message.provenance.local ? 'flame' : 'cloud'} size={10} />
            {message.provenance.local ? 'On device' : 'Remote'}
          </span>
        ) : null}
        {/* The chip says where the reply was made. This says what went with
            the request — a remote turn that carried the contents of your
            conversations is a different event from one that carried only the
            words you typed, and "Remote" alone cannot tell them apart. */}
        {message.provenance?.toolEgress ? (
          <span
            className={`chip ${message.provenance.toolEgress === 'granted' ? 'chip--remote' : 'chip--local'}`}
            title={
              message.provenance.toolEgress === 'granted'
                ? `Tool output from ${(message.toolCalls ?? []).map((tool) => tool.name).join(', ') || 'a tool'} was sent to ${message.provenance.modelName}, because you allowed it for this conversation. Expand the tool block below to see exactly what.`
                : 'Tool output stayed on this device. The model answered without it, and was told so.'
            }
          >
            <Icon name="tool" size={10} />
            {message.provenance.toolEgress === 'granted'
              ? `carried ${message.toolCalls?.length ?? 1} tool result${(message.toolCalls?.length ?? 1) === 1 ? '' : 's'}`
              : 'tool output withheld'}
          </span>
        ) : null}
        {message.stats?.tokensPerSecond ? (
          <span className="readout">{message.stats.tokensPerSecond.toFixed(1)} tok/s</span>
        ) : null}

        {/* How much prefill the KV cache saved on this turn. Worth showing:
            it is the difference between a long conversation staying responsive
            and degrading with every message. */}
        {message.stats?.cachedTokens && message.stats.promptTokens ? (
          <span
            className="readout"
            title={`${message.stats.cachedTokens.toLocaleString()} of ${message.stats.promptTokens.toLocaleString()} prompt tokens were reused from the cache instead of re-processed.`}
          >
            {Math.round((message.stats.cachedTokens / message.stats.promptTokens) * 100)}% cached
          </span>
        ) : null}

        {/* Speculative decoding: how many tokens the small draft model
            proposed that the large one accepted. The native layer has reported
            this since the llama.cpp plugin landed and nothing has ever shown
            it. It is the one number that says whether speculation is paying
            for itself — a low rate means the draft model is being run for
            nothing, and the fix is to turn it off or pick a closer draft. */}
        {typeof message.stats?.draftAcceptance === 'number' ? (
          <span
            className="readout"
            title={`${Math.round(message.stats.draftAcceptance * 100)}% of tokens proposed by the draft model were accepted. Below roughly 60% speculative decoding usually costs more than it saves.`}
          >
            {Math.round(message.stats.draftAcceptance * 100)}% draft
          </span>
        ) : null}
      </div>

      {message.provenance?.fallbackFrom ? (
        <div className="chip chip--warn" style={{ alignSelf: 'flex-start', whiteSpace: 'normal' }}>
          <Icon name="alert" size={11} />
          Generated remotely — the device could not run this turn locally
          {/* The divert picks the destination, so no sheet could have asked
              about it in time. The rule is applied instead of asked, and the
              chip has to say so or the user learns it the hard way. */}
          {message.provenance.toolEgress === 'withheld' ? '. Tool output was not sent' : ''}
        </div>
      ) : null}

      {message.thinking && showThinking ? <Thinking text={message.thinking} /> : null}

      {message.toolCalls?.length ? (
        <div className="stack" style={{ gap: 'var(--s-2)' }}>
          {message.toolCalls.map((tool) => (
            <ToolCall key={tool.id} tool={tool} />
          ))}
        </div>
      ) : null}

      {message.error ? (
        <div className="card card--quiet" style={{ borderLeft: '3px solid var(--crit)' }}>
          <span className="label" style={{ color: 'var(--crit)' }}>
            Could not finish
          </span>
          <p style={{ fontSize: 'var(--t-sm)', color: 'var(--ink-2)' }}>{message.error}</p>
          <button
            type="button"
            className="btn btn--secondary btn--sm"
            style={{ alignSelf: 'flex-start' }}
            onClick={() => onRegenerate(message.id)}
          >
            <Icon name="refresh" size={14} />
            Try again
          </button>
        </div>
      ) : (
        <div className="msg__body">
          {settings.renderMarkdown ? (
            <Suspense fallback={<div style={{ whiteSpace: 'pre-wrap' }}>{message.content}</div>}>
              <Markdown text={message.content} />
            </Suspense>
          ) : (
            <div style={{ whiteSpace: 'pre-wrap' }}>{message.content}</div>
          )}
          {message.streaming ? <span className="caret" aria-hidden="true" /> : null}
        </div>
      )}

      {!message.streaming && !message.error ? (
        <div className="msg__foot">
          <CopyButton text={message.content} />
          <button
            type="button"
            className="icon-btn"
            data-active={speaking ? 'true' : undefined}
            onClick={toggleSpeech}
            aria-label={speaking ? 'Stop reading aloud' : 'Read aloud'}
          >
            <Icon name="speaker" size={15} />
          </button>
          <button
            type="button"
            className="icon-btn"
            onClick={() => onRegenerate(message.id)}
            aria-label="Regenerate"
          >
            <Icon name="refresh" size={15} />
          </button>
          <button
            type="button"
            className="icon-btn"
            onClick={() => void deleteMessage(message.id)}
            aria-label="Delete message"
          >
            <Icon name="trash" size={15} />
          </button>

          {totalVariants > 1 ? (
            <span className="row" style={{ gap: 2, marginLeft: 'var(--s-2)' }}>
              <button
                type="button"
                className="icon-btn"
                style={{ width: 24, height: 24 }}
                onClick={() => void cycleVariant(message.id, -1)}
                aria-label="Previous version"
              >
                <Icon name="chevron-left" size={13} />
              </button>
              <span className="readout">
                {(message.variantIndex ?? totalVariants - 1) + 1}/{totalVariants}
              </span>
              <button
                type="button"
                className="icon-btn"
                style={{ width: 24, height: 24 }}
                onClick={() => void cycleVariant(message.id, 1)}
                aria-label="Next version"
              >
                <Icon name="chevron-right" size={13} />
              </button>
            </span>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

function Thinking({ text }: { text: string }): ReactNode {
  const [open, setOpen] = useState(false);
  const lines = text.split('\n').filter(Boolean).length;

  return (
    <div>
      <button
        type="button"
        className="thinking__toggle"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
      >
        <Icon name="brain" size={13} />
        Reasoning · {lines} line{lines === 1 ? '' : 's'}
        <Icon name={open ? 'chevron-down' : 'chevron-right'} size={13} />
      </button>
      {open ? <div className="thinking">{text}</div> : null}
    </div>
  );
}

function ToolCall({ tool }: { tool: ToolInvocation }): ReactNode {
  const [open, setOpen] = useState(false);
  const html = tool.name === 'render_html' ? String(tool.input.html ?? '') : '';

  return (
    <div className="tool">
      <button
        type="button"
        className="tool__head"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
      >
        <Icon name="tool" size={13} />
        <span className="tool__name">{tool.name}</span>
        <span className="grow truncate" style={{ opacity: 0.75 }}>
          {tool.isError ? 'failed' : (tool.output ?? '').slice(0, 60)}
        </span>
        {tool.durationMs !== undefined ? (
          <span className="readout">{tool.durationMs}ms</span>
        ) : null}
        <Icon name={open ? 'chevron-down' : 'chevron-right'} size={13} />
      </button>

      {open ? (
        <div className="tool__body">
          <div style={{ color: 'var(--ink-3)' }}>{JSON.stringify(tool.input, null, 2)}</div>
          <div style={{ marginTop: 8, color: tool.isError ? 'var(--crit)' : 'var(--ink)' }}>
            {tool.output}
          </div>
        </div>
      ) : null}

      {html ? (
        <iframe
          className="tool__frame"
          title={`Output of ${tool.name}`}
          // `sandbox=""` is every restriction the flag list can lift: no
          // scripts, an opaque origin, no forms, no popups, no top-level
          // navigation. What it does NOT do is stop the document fetching what
          // its markup names — an `<img>` or a `<link>` in the model's fragment
          // is a request. That is `frameDocument`'s job, and the two are named
          // separately here because they stop different things.
          sandbox=""
          srcDoc={frameDocument(html)}
          height={Number(tool.input.height ?? 260)}
        />
      ) : null}
    </div>
  );
}
