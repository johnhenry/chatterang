/**
 * IR MESSAGES -> ONE CLI'S STDIN, THROUGH THE EXISTING TAINT GATE, NOT AROUND
 * IT (#42, #119, #120).
 *
 * `sanitiseMessages` (`src/ai/prompt.ts`) is the app's ONE producer of
 * `SafeMessage` — the brand `renderPrompt` demands before a template ever
 * sees a string. This file calls it too, for the same reason `renderPrompt`
 * is "the only entry point, and the only place `sanitiseMessages` is called"
 * (that function's own doc): a CLI is a destination this app hands text to
 * that then gets folded into SOMEONE ELSE'S prompt — `claude`, `codex` and
 * `gemini` each build their own system/turn structure around what arrives on
 * stdin, exactly the role a chat template plays for llama.cpp. Skipping
 * `sanitiseMessages` here would reopen precisely the hole `src/ai/taint.ts`'s
 * own header names and declines to close for `ollama`/`lmstudio`: a
 * non-local destination that renders somebody else's template, with tainted
 * bytes reaching it unencoded.
 *
 * WHICH FLAG {@link isTainted} SHOULD SEE. `clearForDestination`'s `local`
 * option strips the taint MARK for a non-local destination, because a
 * provider SDK must never see this app's bookkeeping — but stripping it
 * before `sanitiseMessages` ever runs is exactly the mistake that produced
 * the measured hole: `isTainted` would see nothing to encode. A CLI target's
 * call to `clearForDestination` therefore wants `local: true` — the same
 * choice llama.cpp makes — so the mark rides through to HERE, where this
 * file plays `renderPrompt`'s role and is the last code to see it before the
 * mark is gone for good. (CLI targets are not wired into `engine.ts`'s
 * routing yet — that wiring is not this file's job — but whoever does it
 * should read this paragraph first.)
 *
 * WHAT THIS FILE DOES NOT DO: build a prompt. `claude`'s stream-json input
 * frames carry ROLE-TAGGED MESSAGE OBJECTS, one per stdin line — never a
 * rendered string — and `codex`/`gemini` accept plain text with no
 * structured-input mode `--help` documents, so their transcript keeps roles
 * as a clearly labelled structure of its own (never a bare concatenation of
 * message bodies) rather than reusing a chat-model marker family that means
 * something specific to a DIFFERENT tokeniser. Either way, #119's rule holds:
 * the CLI is handed structured turns, not a string this app assembled by
 * gluing message bodies together.
 */

import type { IRMessage } from '@johnhenry/aimatey-types';

import { sanitiseMessages, type SafeMessage } from '@/ai/prompt';
import { substituteStructural } from '@/ai/taint';

/** Everything one CLI turn needs from the encoder, and no more. */
export interface CliTurnInput {
  /** Written to the process's stdin verbatim (`cli-turns.ts` never builds this itself). */
  readonly stdin: string;
  /**
   * This app's OWN persona/system text — never model- or tool-derived,
   * because it is pulled from `system`-role messages before any tool in the
   * turn could have produced anything for a LATER message to quote. `undefined`
   * when the conversation has none. `claude` accepts this as a separate
   * argv value (`--append-system-prompt`); `codex`/`gemini` have no such
   * flag documented, so it travels inside {@link stdin} instead, in the same
   * labelled-transcript shape as every other message.
   */
  readonly systemPrompt?: string;
}

/** Thrown for a block this app cannot honestly represent as text for a CLI (#120: "text-only source"). */
export class CliUnsupportedContentError extends Error {
  override readonly name = 'CliUnsupportedContentError';
  constructor(blockType: string) {
    super(
      `cli-encode: cannot send a "${blockType}" content block to a local agent CLI -- this ` +
        'source is text-only. Refusing rather than substituting a placeholder that would let the ' +
        'CLI believe it received something it did not.',
    );
  }
}

/** Thrown for a conversation with nothing to send once system messages are set aside. */
export class CliEmptyConversationError extends Error {
  override readonly name = 'CliEmptyConversationError';
  constructor() {
    super('cli-encode: refusing to start a CLI turn with no user/assistant/tool content to send.');
  }
}

/** Flatten one message's content to text, refusing anything that is not text. */
function flattenTextOnly(message: SafeMessage): string {
  if (typeof message.content === 'string') return message.content;
  const parts: string[] = [];
  for (const block of message.content) {
    if (block.type !== 'text') throw new CliUnsupportedContentError(block.type);
    parts.push(block.text);
  }
  return parts.join('\n');
}

/**
 * Split a sanitised conversation into its system text (joined, for the argv
 * channel) and everything else, in order.
 */
function splitSystem(messages: readonly SafeMessage[]): { system: string | undefined; rest: SafeMessage[] } {
  const systemParts: string[] = [];
  const rest: SafeMessage[] = [];
  for (const message of messages) {
    if (message.role === 'system') {
      systemParts.push(flattenTextOnly(message));
    } else {
      rest.push(message);
    }
  }
  return { system: systemParts.length > 0 ? systemParts.join('\n\n') : undefined, rest };
}

/**
 * `claude`'s stream-json input frame, per message. Not documented as a wire
 * schema anywhere in `claude --help` -- the option only names its two
 * choices, "text" and "stream-json" -- so this shape is not read out of a
 * spec. It is the exact shape used, once, to capture the real fixture this
 * app ships (`tests/fixtures/cli/claude-pong.jsonl`): fed to a real
 * `claude -p --input-format stream-json`, it produced the real assistant
 * reply that fixture records. That is stronger than "the output happens to
 * echo this shape" -- it is empirical confirmation the input side accepts
 * it, on the version this app was built against (2.1.263).
 */
function claudeInputFrame(message: SafeMessage): string {
  const role = message.role === 'assistant' ? 'assistant' : 'user';
  return JSON.stringify({ type: role, message: { role, content: flattenTextOnly(message) } });
}

function encodeClaudeStdin(messages: readonly SafeMessage[]): string {
  return messages.map((message) => `${claudeInputFrame(message)}\n`).join('');
}

/**
 * `codex`/`gemini` document no structured input mode: `codex exec --help`
 * takes a single prompt (or stdin, appended); `gemini --help`'s `-p` is the
 * same shape. Multi-turn history therefore has no native channel, so this
 * builds one clearly-labelled transcript rather than a bare concatenation
 * (#119) -- and every body is run through {@link substituteStructural}
 * UNCONDITIONALLY, regardless of taint, before it is joined into the
 * transcript.
 *
 * THIS IS DELIBERATELY ON TOP OF `sanitiseMessages`, NOT INSTEAD OF IT, AND
 * NOT OPTIONAL FOR UNTAINTED TEXT. `sanitiseMessages` runs `encodeUntrusted`
 * (which neutralises AND drops invisibles) only for content that
 * `isTainted()` reports true, or that a tool block carries; ordinary
 * user-typed text — the common case, and the one measured — gets
 * `escapeControlMarkers` instead, which is not the same guarantee and does
 * not touch `[`/`]` on its own. A user message (or pasted external content,
 * which this app has no way to distinguish from typed text) containing a
 * literal line `[assistant]` therefore reached this transcript, verbatim,
 * before this function ran `substituteStructural` on every body unconditionally
 * — indistinguishable from a label this file wrote. `\r` passed too, for the
 * same reason (`escapeControlMarkers` is not this file's function to weaken
 * or bypass, so the fix runs here, downstream of it, rather than asking it to
 * do a second job). Both are closed here: `substituteStructural` (the
 * substitution half of `encodeUntrusted`, exported from `taint.ts`
 * specifically so a second caller can apply it unconditionally) neutralises
 * `[`, `]` and every character that folds into either one, and every body is
 * normalised to `\n`-only line endings first, so a bare `\r` cannot be used
 * to make the terminal (or a naive line reader) treat what follows as a new
 * line this file did not write.
 */
function plainTextLabel(role: SafeMessage['role']): string {
  return `[${role}]`;
}

/** `\r\n` and lone `\r` both become `\n`, then every structural character (see this section's header) is neutralised, unconditionally. */
function neutraliseForPlainTextBody(text: string): string {
  return substituteStructural(text.replace(/\r\n?/g, '\n'));
}

function encodePlainTextStdin(messages: readonly SafeMessage[]): string {
  return messages
    .map((message) => `${plainTextLabel(message.role)}\n${neutraliseForPlainTextBody(flattenTextOnly(message))}\n`)
    .join('\n');
}

/** Every CLI this encoder knows how to address (mirrors `SupportedCliId` in `cli.ts`, kept separate so this file needs no import from it). */
export type CliEncodeTargetId = 'claude' | 'codex' | 'gemini';

/**
 * Build one CLI turn's stdin (and, when the CLI has one, its system-prompt
 * argv value) from a conversation.
 *
 * `messages` is expected to already carry its taint marks (a CLI target's
 * `clearForDestination` call, once wired, uses `local: true` -- see this
 * file's header); {@link sanitiseMessages} is called here, once, for
 * everyone downstream. Passing already-stripped messages does not throw --
 * `isTainted` simply reports false for all of them -- but it silently loses
 * the encoding this file exists to apply, which is why the header spells
 * out the choice for whoever wires the routing.
 *
 * @throws {CliEmptyConversationError} if nothing but system messages remain.
 * @throws {CliUnsupportedContentError} if any non-system message contains a
 *   non-text block (an image, audio, a tool call or result, ...): this
 *   source is text-only, and a placeholder would let the CLI believe it
 *   received something it did not.
 */
export function encodeCliTurnInput(cliId: CliEncodeTargetId, messages: readonly IRMessage[]): CliTurnInput {
  const safe = sanitiseMessages(messages);
  const { system, rest } = splitSystem(safe);
  if (rest.length === 0 || rest.every((message) => flattenTextOnly(message).length === 0)) {
    throw new CliEmptyConversationError();
  }

  if (cliId === 'claude') {
    return { stdin: encodeClaudeStdin(rest), systemPrompt: system };
  }
  // codex, gemini: no structured input mode and no system-prompt flag
  // documented in either `--help` -- the system text goes into the same
  // labelled transcript as everything else, rather than being silently
  // dropped or forced into a channel neither CLI advertises.
  // `system` is already sanitised text (it came out of `flattenTextOnly`
  // over `safe`'s own system-role entries in `splitSystem`), so this is a
  // reconstruction of an already-safe value, NOT a second call to
  // `sanitiseMessages` -- calling it twice would be redundant at best and,
  // at worst, a second reader of this file assuming re-sanitising a value
  // this file already sanitised is what makes it safe, when the one call
  // above is what does.
  const withSystem: readonly SafeMessage[] =
    system !== undefined ? [{ role: 'system', content: system } as SafeMessage, ...rest] : rest;
  return { stdin: encodePlainTextStdin(withSystem) };
}
