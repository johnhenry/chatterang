import { Suspense, lazy, useState, type ReactNode } from 'react';
import { AttachmentImage } from '@/features/chat/AttachmentImage';

import { Icon } from '@/ui/Icon';
import { CopyButton } from '@/ui/primitives';
import { frameDocument } from '@/ui/frame';
import type { Message, MessageVariant, ToolInvocation } from '@/domain/chat';
import { currentVariant, ranOnDevice, ranThroughLocalCli, showsStopped } from '@/domain/chat';
import { mayHaveLeft, unhandledOutcome, unhandledWhy, type McpCallReceipt } from '@/domain/mcp';
import { useApp } from '@/state/app';
import { useChats } from '@/state/chat';
import { speak, stopSpeaking } from '@/lib/voice';
import { describeFallback, type FallbackReason } from '@/ai/middleware/resilience';

/**
 * What the divert chip says.
 *
 * `provenance.fallbackReason` has been written end to end since the resilience
 * middleware landed -- `ai/engine.ts` sets it, `state/chat.ts` copies it onto
 * the stored variant, `domain/chat.ts` declares it -- and nothing read it.
 * Every divert rendered the same sentence, "the device could not run this turn
 * locally", which for a thermal divert is false in both halves: the device
 * could have run it, and was too hot to be asked to. A memory divert, a
 * timeout and a missing model were equally indistinguishable.
 *
 * `describeFallback` already writes an accurate sentence per reason and was
 * consumed only by the middleware that produced it. This is its missing
 * reader.
 *
 * The stored reason is typed `string` rather than `FallbackReason`, and is
 * treated that way here on purpose: rows written before the field existed
 * carry nothing, and a row written by a later build could carry a reason this
 * one has never heard of. Both take the general sentence, which says only the
 * part that is true of every divert -- that the turn did not run here.
 */
const DESCRIBED_REASONS: ReadonlySet<string> = new Set<FallbackReason>([
  'thermal',
  'memory',
  'engine-error',
  'model-missing',
  'timeout',
]);

function fallbackSentence(reason: string | undefined): string {
  if (reason !== undefined && DESCRIBED_REASONS.has(reason)) {
    return describeFallback(reason as FallbackReason);
  }
  return 'Generated remotely rather than on this device';
}

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

  // `variants` holds every generation of this turn INCLUDING the one on
  // screen, so the count is the length — not the length plus the row, which is
  // what it was when the row stood in for its own generation. The `max` covers
  // the moment a regenerated turn is still streaming: its record has not been
  // appended yet, and its index points one past the end at itself.
  const variants = message.variants ?? [];
  const totalVariants = Math.max(variants.length, (message.variantIndex ?? 0) + 1);

  // THE ONE GENERATION THIS VIEW IS DESCRIBING.
  //
  // Everything below reads `shown` and nothing reads the row, because the two
  // used to disagree and the disagreement was the defect: the text came from
  // `variants[variantIndex]` and the chip came from `message.provenance`, so a
  // reply that came back from a provider was rendered under the ember flame —
  // this app's own mark for a turn that ran on the device. `applyVariant` now
  // keeps the row in step, but a renderer that reads the row is trusting three
  // writers to remember; one that reads the record cannot be wrong about which
  // generation it is labelling.
  //
  // The row IS the record in exactly two cases, and `currentVariant` covers
  // both: a turn that has never been regenerated has no list, and a
  // regenerated turn that is still streaming has an index one past the end of
  // the list, pointing at the generation being made on the row right now.
  //
  // The `content` test is a runtime one, not a type one. Through v3 this list
  // held bare strings, and the Dexie v4 upgrade that rewrites them is the one
  // piece of this change that has never been executed — there is no
  // IndexedDB under the test environment to run it in. If a row ever reaches
  // here unupgraded, falling back to the row shows the reply; trusting the
  // type would render an empty message, which is a worse failure than the one
  // being fixed. It costs one comparison per assistant turn.
  const record =
    !message.streaming && message.variantIndex !== undefined
      ? variants[message.variantIndex]
      : undefined;
  const shown: MessageVariant =
    typeof record?.content === 'string' ? record : currentVariant(message);

  // Absent provenance means UNKNOWN, and unknown is rendered as unknown: no
  // chip, no model name, no borrowed label from a neighbouring generation. A
  // variant recovered by the v4 upgrade from a bare string is the case that
  // reaches this — its origin was never written down, and the plausible guess
  // is precisely the confident falsehood the record exists to prevent.
  const provenance = shown.provenance;
  const toolCalls = shown.toolCalls;

  // A reply stopped before its first word (owner ruling): kept in the thread,
  // with any receipts it carries above, and said to be stopped rather than left
  // as an empty body. Read off `shown`, so flipping to such a generation says so
  // and flipping away does not. There is nothing in it to copy or read aloud.
  const stoppedEarly = !message.streaming && !message.error && showsStopped(shown);

  const toggleSpeech = (): void => {
    if (speaking) {
      stopSpeaking();
      setSpeaking(false);
      return;
    }
    setSpeaking(true);
    void speak({
      text: shown.content,
      strategy: settings.voiceMode === 'neural' ? 'neural' : 'os',
      voiceId: settings.voiceId || undefined,
      rate: settings.speechRate,
    }).finally(() => setSpeaking(false));
  };

  return (
    <article className="msg msg--assistant">
      <div className="msg__head">
        <span className="msg__who">
          {provenance?.modelName ?? (message.streaming ? 'Thinking' : 'Assistant')}
        </span>
        {/* Two labels for a three-valued fact, deliberately, for now.
            `ranOnDevice` is the narrow question — did this run HERE — so a
            reply that travelled is never shown under the ember flame, which
            is the defect this chip has been fixed for twice. A `paired` reach
            therefore falls in with `remote`: coarse, and wrong only in the
            safe direction, since it overstates the egress rather than hiding
            it. Nothing can produce one yet (`state/chat.ts` writes two of the
            three), and the chip that tells a paired desktop apart from a
            provider is #210–#219, which owns the copy. */}
        {provenance ? (
          ranThroughLocalCli(provenance) ? (
            // #42, #112: a local agent CLI ran HERE and still reached a
            // third party under the user's own CLI login -- checked BEFORE
            // `ranOnDevice` below, which would otherwise say "On device" for
            // this exact shape (`reach.host.kind` really is `'device'`) and
            // hide the vendor it actually reached.
            <span
              className="chip chip--remote"
              title={`Ran through the local CLI, and reached ${provenance.modelName} there -- never only on this device.`}
            >
              <Icon name="cloud" size={10} />
              Local CLI, reached its vendor
            </span>
          ) : (
            <span className={`chip ${ranOnDevice(provenance) ? 'chip--local' : 'chip--remote'}`}>
              <Icon name={ranOnDevice(provenance) ? 'flame' : 'cloud'} size={10} />
              {ranOnDevice(provenance) ? 'On device' : 'Remote'}
            </span>
          )
        ) : null}
        {/* The chip says where the reply was made. This says what went with
            the request — a remote turn that carried the contents of your
            conversations is a different event from one that carried only the
            words you typed, and "Remote" alone cannot tell them apart.

            It is a per-message record of a consent decision, so it has to
            follow the generation that decision was made for. Both halves are
            read off `shown`: the grant from that generation's `toolEgress`,
            the tool names from that generation's `toolCalls`. Flipping to a
            local answer that sent nothing must not leave "carried 1 tool
            result" standing over it, and flipping back must bring it back. */}
        {provenance?.toolEgress ? (
          <span
            className={`chip ${provenance.toolEgress === 'granted' ? 'chip--remote' : 'chip--local'}`}
            title={
              provenance.toolEgress === 'granted'
                ? `Tool output from ${(toolCalls ?? []).map((tool) => tool.name).join(', ') || 'a tool'} was sent to ${provenance.modelName}, because you allowed it for this conversation. Expand the tool block below to see exactly what.`
                : 'Tool output stayed on this device. The model answered without it, and was told so.'
            }
          >
            <Icon name="tool" size={10} />
            {provenance.toolEgress === 'granted'
              ? `carried ${toolCalls?.length ?? 1} tool result${(toolCalls?.length ?? 1) === 1 ? '' : 's'}`
              : 'tool output withheld'}
          </span>
        ) : null}
        {shown.stats?.tokensPerSecond ? (
          <span className="readout">{shown.stats.tokensPerSecond.toFixed(1)} tok/s</span>
        ) : null}

        {/* How much prefill the KV cache saved on this turn. Worth showing:
            it is the difference between a long conversation staying responsive
            and degrading with every message. */}
        {shown.stats?.cachedTokens && shown.stats.promptTokens ? (
          <span
            className="readout"
            title={`${shown.stats.cachedTokens.toLocaleString()} of ${shown.stats.promptTokens.toLocaleString()} prompt tokens were reused from the cache instead of re-processed.`}
          >
            {Math.round((shown.stats.cachedTokens / shown.stats.promptTokens) * 100)}% cached
          </span>
        ) : null}

        {/* Speculative decoding: how many tokens the small draft model
            proposed that the large one accepted. The native layer has reported
            this since the llama.cpp plugin landed and nothing has ever shown
            it. It is the one number that says whether speculation is paying
            for itself — a low rate means the draft model is being run for
            nothing, and the fix is to turn it off or pick a closer draft. */}
        {typeof shown.stats?.draftAcceptance === 'number' ? (
          <span
            className="readout"
            title={`${Math.round(shown.stats.draftAcceptance * 100)}% of tokens proposed by the draft model were accepted. Below roughly 60% speculative decoding usually costs more than it saves.`}
          >
            {Math.round(shown.stats.draftAcceptance * 100)}% draft
          </span>
        ) : null}
      </div>

      {provenance?.fallbackFrom ? (
        <div className="chip chip--warn" style={{ alignSelf: 'flex-start', whiteSpace: 'normal' }}>
          <Icon name="alert" size={11} />
          {fallbackSentence(provenance.fallbackReason)}
          {/* The divert picks the destination, so no sheet could have asked
              about it in time. The rule is applied instead of asked, and the
              chip has to say so or the user learns it the hard way. */}
          {provenance.toolEgress === 'withheld' ? '. Tool output was not sent' : ''}
        </div>
      ) : null}

      {shown.thinking && showThinking ? <Thinking text={shown.thinking} /> : null}

      {toolCalls?.length ? (
        <div className="stack" style={{ gap: 'var(--s-2)' }}>
          {toolCalls.map((tool) => (
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
      ) : stoppedEarly ? (
        <div className="msg__body">
          {/* The label is the word a person sees; the rest is for a screen
              reader, which would otherwise hear "Stopped" attached to nothing. */}
          <p className="msg__stopped" style={{ margin: 0 }}>
            <span className="label">Stopped</span>
            <span className="sr-only"> before its first word</span>
          </p>
        </div>
      ) : (
        <div className="msg__body">
          {settings.renderMarkdown ? (
            <Suspense fallback={<div style={{ whiteSpace: 'pre-wrap' }}>{shown.content}</div>}>
              <Markdown text={shown.content} />
            </Suspense>
          ) : (
            <div style={{ whiteSpace: 'pre-wrap' }}>{shown.content}</div>
          )}
          {message.streaming ? <span className="caret" aria-hidden="true" /> : null}
        </div>
      )}

      {!message.streaming && !message.error ? (
        <div className="msg__foot">
          {stoppedEarly ? null : (
            <>
              <CopyButton text={shown.content} />
              <button
                type="button"
                className="icon-btn"
                data-active={speaking ? 'true' : undefined}
                onClick={toggleSpeech}
                aria-label={speaking ? 'Stop reading aloud' : 'Read aloud'}
              >
                <Icon name="speaker" size={15} />
              </button>
            </>
          )}
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

/**
 * What the thread says about a call whose arguments were handed to an MCP
 * server (#92).
 *
 * "Arguments", not bytes on the wire: the count is the UTF-8 length of what the
 * model composed, and the request envelope and bearer header around it are not
 * in it (`domain/mcp.ts`). A failed call is described as neither sent nor not
 * sent — it may have failed before the server read it or after — because
 * calling it not sent would be wrong in the flattering direction. A withheld
 * call is the one that is not sent, and says so without claiming where the
 * arguments are now: a remote model wrote them, so they were never only here.
 * It also says what held it back, because "not allowed" and "declined when
 * asked about changing data" are different answers to different questions.
 *
 * Exhaustive switches, so an outcome or a reason added later cannot compile
 * unrendered.
 */
function receiptSentence(receipt: McpCallReceipt): string {
  const where = `${receipt.host} (${receipt.serverName})`;
  const when = new Date(receipt.at).toLocaleString();
  switch (receipt.outcome) {
    case 'sent':
      return `Sent ${receipt.bytes} bytes of arguments to ${where} at ${when}.`;
    case 'failed':
      return `Tried to send ${receipt.bytes} bytes of arguments to ${where} at ${when} — the call failed, so they may or may not have arrived.`;
    case 'withheld':
      switch (receipt.why) {
        case 'not-allowed':
          return `Not sent to ${where} — it was not allowed.`;
        case 'unattended':
          return `Not sent to ${where} — this conversation had not allowed that server, and nobody was there to be asked.`;
        case 'declined':
          return `Not sent to ${where} — it could change data there, and was declined.`;
        case 'server-changed':
          return `Not sent to ${where} — the server changed before it went.`;
        case 'stopped':
          return `Not sent to ${where} — the reply was stopped before it went.`;
        case 'round-limit':
          return `Not sent to ${where} — the turn had already used every tool round it was allowed.`;
        default:
          return `Not sent to ${where} — ${unhandledWhy(receipt.why)}.`;
      }
    default:
      return unhandledOutcome(receipt);
  }
}

function ToolCall({ tool }: { tool: ToolInvocation }): ReactNode {
  const [open, setOpen] = useState(false);
  const html = tool.name === 'render_html' ? String(tool.input.html ?? '') : '';
  // Off the invocation `shown` handed down, never off the row: the record of
  // what left moves with its generation, as the chips in the head do.
  const receipt = tool.receipt;

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
        {receipt ? (
          // Styled as leaving only when something may have: a withheld call
          // names where it was bound, in the neutral chip.
          <span className={mayHaveLeft(receipt) ? 'chip chip--remote' : 'chip'}>
            <Icon name="cloud" size={10} />
            {receipt.host}
          </span>
        ) : null}
        <span className="grow truncate" style={{ opacity: 0.75 }}>
          {receipt?.outcome === 'withheld'
            ? 'not sent'
            : tool.isError
              ? 'failed'
              : (tool.output ?? '').slice(0, 60)}
        </span>
        {tool.durationMs !== undefined ? (
          <span className="readout">{tool.durationMs}ms</span>
        ) : null}
        <Icon name={open ? 'chevron-down' : 'chevron-right'} size={13} />
      </button>

      {/* Outside the collapsible body: #92 asks for this at the weight of the
          chip that says which backend produced a reply, which is never
          folded away. */}
      {receipt ? <p className="tool__receipt">{receiptSentence(receipt)}</p> : null}

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
