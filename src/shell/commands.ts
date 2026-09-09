/**
 * Chatterang's own commands.
 *
 * These are app verbs, not POSIX ones — `model install`, `bench run`,
 * `provider disable`. They are registered into the same shell instance as the
 * bundled Unix commands, so `chatterang model list | grep vision` composes, and so
 * the model and the person driving the app share one audited surface.
 *
 * Two rules hold this together:
 *
 *  1. **Nothing here reaches the network.** Commands read and write local
 *     state. Downloading a model is the one exception and it is explicitly
 *     marked, because a shell that can quietly fetch is a shell that can
 *     quietly exfiltrate.
 *  2. **Anything that changes state is `mutating`.** The model may not run a
 *     mutating command without the user confirming it — see `ShellContext`.
 */

import {
  canBenchmark,
  canChat,
  formatBytes,
  nonBenchmarkableReason,
  nonChatRole,
  type Capability,
} from '@/domain/manifest';
import { deriveTitle, reachKind } from '@/domain/chat';
import type { Reach } from '@/domain/chat';

export interface ShellOutput {
  readonly stdout: string;
  readonly stderr?: string;
  readonly exitCode: number;
}

export interface ShellContext {
  /**
   * Ask the user to approve an action. Returns false when they declined.
   *
   * `network` is declared per *action*, not per command, because a single
   * command spans both: `model use` only touches local state, while `model
   * install` downloads. Gating at command granularity would either prompt for
   * harmless things or wave through egress.
   */
  confirm(action: string, options?: { network?: boolean }): Promise<boolean>;
  /** Who is driving: the person at the keyboard, or the model. */
  readonly actor: 'user' | 'model';
  readonly signal?: AbortSignal;
}

export interface ShellCommand {
  readonly name: string;
  readonly summary: string;
  readonly usage: string;
  /** Changes app state. Requires confirmation when the actor is the model. */
  readonly mutating?: boolean;
  /** Some subcommand can leave the device. Documentation; the gate is per-action. */
  readonly network?: boolean;
  run(args: readonly string[], context: ShellContext): Promise<ShellOutput>;
}

export const ok = (stdout: string): ShellOutput => ({ stdout, exitCode: 0 });
export const fail = (stderr: string, exitCode = 1): ShellOutput => ({
  stdout: '',
  stderr,
  exitCode,
});

/* ── Store access, injected so commands stay testable ────────────────── */

export interface ShellStores {
  models: () => {
    installed: Record<string, ModelRow>;
    activeModelId: string | null;
    install(id: string): Promise<void>;
    remove(id: string): Promise<void>;
    setActive(id: string | null): Promise<void>;
  };
  catalog: () => readonly CatalogRow[];
  chats: () => {
    list: readonly ChatRow[];
    activeChatId: string | null;
    messagesFor(chatId: string): Promise<readonly MessageRow[]>;
    open(chatId: string): Promise<void>;
    create(): Promise<string>;
  };
  personas: () => readonly PersonaRow[];
  providers: () => {
    list: readonly ProviderRow[];
    toggle(id: string, enabled: boolean): Promise<void>;
  };
  device: () => DeviceRow | null;
  benchmarks: () => readonly BenchRow[];
  runBenchmark(modelId: string): Promise<void>;
  /**
   * Connected MCP servers, for `privacy` to name.
   *
   * Optional because it arrived after the interface did and every test builds
   * this object by hand. `privacy` treats its absence as "no servers", which
   * is the same answer an empty array gives — the command must never claim a
   * server does not exist because a caller forgot to wire this up, so the
   * MCP paragraph is printed only when there is a named server to print.
   */
  mcpServers?: () => readonly McpRow[];
}

interface ModelRow {
  id: string;
  state: string;
  downloadedBytes: number;
  useCount: number;
  manifest: {
    name: string;
    quantization: string;
    capabilities: readonly Capability[];
    contextLength: number;
    sizeBytes: number;
    engine: string;
    license: string;
  };
}
interface CatalogRow {
  id: string;
  name: string;
  sizeBytes: number;
  capabilities: readonly Capability[];
  bestFor?: string;
}
interface ChatRow {
  id: string;
  title: string;
  messageCount: number;
  updatedAt: number;
  mode: string;
}
/**
 * One generation of a turn, as much of it as a transcript prints.
 *
 * Structurally a `MessageVariant`, and a `MessageRow` is one of these too, so
 * the row can stand in for its own generation without a conversion.
 */
interface TranscriptGeneration {
  content: string;
  provenance?: { modelName: string; reach?: Reach };
}
interface MessageRow extends TranscriptGeneration {
  role: string;
  createdAt: number;
  /** Every generation of this turn, including the one on display. */
  variants?: readonly TranscriptGeneration[];
  variantIndex?: number;
  streaming?: boolean;
}
interface PersonaRow {
  id: string;
  name: string;
  kind: string;
  tagline: string;
  builtin?: boolean;
}
interface ProviderRow {
  id: string;
  label: string;
  enabled: boolean;
  defaultModel: string;
}
interface DeviceRow {
  chipset: string;
  totalMemory: number;
  cpuCores: number;
  backends: readonly string[];
  simulated: boolean;
  engineVersion: string;
}
interface BenchRow {
  modelName: string;
  generateTokensPerSecond: number;
  backend: string;
  createdAt: number;
}
interface McpRow {
  name: string;
  /** Where a call to this server's tools actually goes. */
  host: string;
  enabled: boolean;
}

/* ── Formatting helpers ──────────────────────────────────────────────── */

/** Fixed-width columns, so shell output stays greppable and scannable. */
export function table(rows: readonly (readonly string[])[]): string {
  if (rows.length === 0) return '';
  const widths = rows[0]!.map((_, column) =>
    Math.max(...rows.map((row) => (row[column] ?? '').length)),
  );
  return rows
    .map((row) =>
      row
        .map((cell, column) => (column === row.length - 1 ? cell : cell.padEnd(widths[column]!)))
        .join('  ')
        .trimEnd(),
    )
    .join('\n');
}

/* ── The commands ────────────────────────────────────────────────────── */

export function chatterangCommands(stores: ShellStores): ShellCommand[] {
  const model: ShellCommand = {
    name: 'model',
    summary: 'List, install, remove, and select models',
    usage: 'model list [--all] | model info <id> | model use <id> | model install <id> | model remove <id>',
    mutating: true,
    network: true,
    async run(args, context) {
      const [sub, id] = args;
      const store = stores.models();

      switch (sub ?? 'list') {
        case 'list': {
          const showAll = args.includes('--all');
          const installed = Object.values(store.installed).filter((m) => m.state === 'installed');

          if (!showAll) {
            if (installed.length === 0) return ok('No models installed. `model list --all` to browse.');
            /*
             * ENGINE and CHAT are here because two refusals point at this
             * command. `model use` and `bench run` both end "Try: model list",
             * and the table they sent people to printed ID, NAME, SIZE, CTX
             * and USES — not one of which answers "why was mine refused, and
             * which of these would not be". A whisper-only user ran it, saw
             * their one row, and learned nothing. A refusal whose next step
             * cannot answer the question is the original bug wearing a
             * politer sentence.
             *
             * CHAT is `canChat`, the same predicate that did the refusing, so
             * the column cannot drift from the rule. ENGINE is the raw id
             * because that is what `bench run` names and what the model sheet
             * prints, and because `model list | grep llama-cpp` is the whole
             * point of putting app verbs in a shell.
             */
            return ok(
              table([
                ['ID', 'NAME', 'SIZE', 'CTX', 'USES', 'ENGINE', 'CHAT', ''],
                ...installed.map((m) => [
                  m.id,
                  m.manifest.name,
                  formatBytes(m.downloadedBytes),
                  String(m.manifest.contextLength),
                  String(m.useCount),
                  m.manifest.engine,
                  canChat(m.manifest) ? 'yes' : 'no',
                  m.id === store.activeModelId ? '← active' : '',
                ]),
              ]),
            );
          }

          return ok(
            table([
              ['ID', 'NAME', 'SIZE', 'STATE', 'FOR'],
              ...stores.catalog().map((c) => [
                c.id,
                c.name,
                formatBytes(c.sizeBytes),
                store.installed[c.id]?.state ?? 'available',
                c.bestFor ?? '',
              ]),
            ]),
          );
        }

        case 'info': {
          if (!id) return fail('usage: model info <id>');
          const found = store.installed[id];
          if (!found) return fail(`no installed model "${id}"`);
          const m = found.manifest;
          return ok(
            table([
              ['name', m.name],
              ['engine', m.engine],
              ['quantization', m.quantization],
              ['capabilities', m.capabilities.join(', ')],
              ['context', String(m.contextLength)],
              ['on disk', formatBytes(found.downloadedBytes)],
              ['licence', m.license],
              ['uses', String(found.useCount)],
            ]),
          );
        }

        case 'use': {
          if (!id) return fail('usage: model use <id>');
          const record = store.installed[id];
          if (record?.state !== 'installed') return fail(`"${id}" is not installed`);

          // The shell types an id rather than picking from a list, so it is the
          // one selection door a filtered picker cannot close. Refuse with a
          // non-zero status: a script that switches models and carries on
          // should stop here, not discover the problem in the reply.
          if (!canChat(record.manifest)) {
            // The next step has to answer the question the refusal raises, or
            // it is decoration: `model list` carries a CHAT column for exactly
            // this sentence to point at.
            return fail(
              `"${id}" ${nonChatRole(record.manifest)} — it cannot answer a chat. ` +
                `Try: model list — the CHAT column marks the ones that can.`,
            );
          }

          if (!(await context.confirm(`switch the active model to ${id}`))) {
            return fail('cancelled', 130);
          }
          await store.setActive(id);
          return ok(`active model is now ${id}`);
        }

        case 'install': {
          if (!id) return fail('usage: model install <id>');
          if (!stores.catalog().some((c) => c.id === id)) return fail(`no catalog model "${id}"`);
          // Downloading is the one thing here that touches the network, so
          // this action is gated for everyone, including a person who typed it.
          if (
            !(await context.confirm(`download ${id} from Hugging Face`, { network: true }))
          ) {
            return fail('cancelled', 130);
          }
          await store.install(id);
          return ok(`installing ${id} — watch progress in Models`);
        }

        case 'remove': {
          if (!id) return fail('usage: model remove <id>');
          if (!store.installed[id]) return fail(`no installed model "${id}"`);
          if (!(await context.confirm(`delete ${id} from this device`))) {
            return fail('cancelled', 130);
          }
          await store.remove(id);
          return ok(`removed ${id}`);
        }

        default:
          return fail(`model: unknown subcommand "${sub}"\nusage: ${this.usage}`);
      }
    },
  };

  const chat: ShellCommand = {
    name: 'chat',
    summary: 'List, open, and export conversations',
    usage: 'chat list | chat open <id> | chat new | chat export <id>',
    mutating: true,
    async run(args, context) {
      const [sub, id] = args;
      const store = stores.chats();

      switch (sub ?? 'list') {
        case 'list':
          if (store.list.length === 0) return ok('No conversations yet.');
          return ok(
            table([
              ['ID', 'MESSAGES', 'UPDATED', 'TITLE', ''],
              ...store.list.map((c) => [
                c.id,
                String(c.messageCount),
                new Date(c.updatedAt).toISOString().slice(0, 10),
                c.title,
                c.id === store.activeChatId ? '← open' : '',
              ]),
            ]),
          );

        case 'open': {
          if (!id) return fail('usage: chat open <id>');
          if (!store.list.some((c) => c.id === id)) return fail(`no chat "${id}"`);
          // This was the one mutating branch with no gate, on a command
          // declared `mutating: true` — so the rule at the top of this file
          // was false as written. The blast radius is small: it navigates the
          // app. That is also exactly the problem. A model that can change
          // what is on the user's screen without an interruption can change
          // what the user is looking at while they answer the next prompt.
          if (!(await context.confirm(`open the conversation ${id}`))) {
            return fail('cancelled', 130);
          }
          await store.open(id);
          return ok(`opened ${id}`);
        }

        case 'new': {
          if (!(await context.confirm('start a new conversation'))) return fail('cancelled', 130);
          return ok(`created ${await store.create()}`);
        }

        case 'export': {
          if (!id) return fail('usage: chat export <id>');
          const found = store.list.find((c) => c.id === id);
          if (!found) return fail(`no chat "${id}"`);
          return ok(renderTranscript(found, await store.messagesFor(id)));
        }

        default:
          return fail(`chat: unknown subcommand "${sub}"\nusage: ${this.usage}`);
      }
    },
  };

  const persona: ShellCommand = {
    name: 'persona',
    summary: 'List personas',
    usage: 'persona list',
    async run() {
      const all = stores.personas();
      if (all.length === 0) return ok('No personas.');
      return ok(
        table([
          ['ID', 'KIND', 'NAME', 'TAGLINE'],
          ...all.map((p) => [p.id, p.kind, p.name, p.tagline]),
        ]),
      );
    },
  };

  const provider: ShellCommand = {
    name: 'provider',
    summary: 'Inspect and toggle remote providers',
    usage: 'provider list | provider enable <id> | provider disable <id>',
    mutating: true,
    async run(args, context) {
      const [sub, id] = args;
      const store = stores.providers();

      switch (sub ?? 'list') {
        case 'list':
          if (store.list.length === 0) {
            return ok('No remote providers connected. Everything runs on this device.');
          }
          return ok(
            table([
              ['ID', 'LABEL', 'MODEL', 'STATE'],
              ...store.list.map((p) => [p.id, p.label, p.defaultModel, p.enabled ? 'on' : 'off']),
            ]),
          );

        case 'enable':
        case 'disable': {
          if (!id) return fail(`usage: provider ${sub} <id>`);
          if (!store.list.some((p) => p.id === id)) return fail(`no provider "${id}"`);
          const enabling = sub === 'enable';
          // Enabling a provider means conversations can leave the device.
          if (
            !(await context.confirm(
              enabling
                ? `enable ${id} — messages sent to it will leave this device`
                : `disable ${id}`,
              // Turning egress on is a decision worth interrupting anyone for;
              // turning it off is not.
              { network: enabling },
            ))
          ) {
            return fail('cancelled', 130);
          }
          await store.toggle(id, enabling);
          return ok(`${id} ${enabling ? 'enabled' : 'disabled'}`);
        }

        default:
          return fail(`provider: unknown subcommand "${sub}"\nusage: ${this.usage}`);
      }
    },
  };

  const bench: ShellCommand = {
    name: 'bench',
    summary: 'Run and read on-device benchmarks',
    usage: 'bench list | bench run <model-id>',
    mutating: true,
    async run(args, context) {
      const [sub, id] = args;

      switch (sub ?? 'list') {
        case 'list': {
          const runs = stores.benchmarks();
          if (runs.length === 0) return ok('No benchmark runs yet.');
          return ok(
            table([
              ['MODEL', 'TOK/S', 'BACKEND', 'WHEN'],
              ...runs.map((r) => [
                r.modelName,
                r.generateTokensPerSecond.toFixed(1),
                r.backend,
                new Date(r.createdAt).toISOString().slice(0, 10),
              ]),
            ]),
          );
        }

        case 'run': {
          if (!id) return fail('usage: bench run <model-id>');
          const record = stores.models().installed[id];
          if (record?.state !== 'installed') {
            return fail(`"${id}" is not installed`);
          }

          // The same door `model use` needed: the shell types an id, so the
          // filtered picker in Benchmarks cannot close it. The benchmark is a
          // llama.cpp harness — handing it an ONNX model's path fails inside a
          // native plugin — so refuse with a non-zero status, before the
          // confirmation prompt: there is nothing here worth warming the
          // device to ask about.
          if (!canBenchmark(record.manifest)) {
            // Same rule as `model use` above: the command this points at prints
            // an ENGINE column, so the reason and the next step are made of the
            // same fact.
            return fail(
              `"${id}" ${nonBenchmarkableReason(record.manifest)} — it cannot be benchmarked. ` +
                `Try: model list — the ENGINE column.`,
            );
          }

          if (!(await context.confirm(`benchmark ${id} — this will warm the device`))) {
            return fail('cancelled', 130);
          }
          await stores.runBenchmark(id);
          return ok(`benchmarked ${id} — see Models › Benchmarks`);
        }

        default:
          return fail(`bench: unknown subcommand "${sub}"\nusage: ${this.usage}`);
      }
    },
  };

  const device: ShellCommand = {
    name: 'device',
    summary: 'What this device can run',
    usage: 'device',
    async run() {
      const info = stores.device();
      if (!info) return fail('device capabilities are not available yet');
      return ok(
        table([
          ['chipset', info.chipset],
          ['memory', formatBytes(info.totalMemory, 0)],
          ['cores', String(info.cpuCores)],
          ['backends', info.backends.join(', ')],
          ['engine', info.engineVersion],
          ['simulated', info.simulated ? 'yes — responses are synthesised' : 'no'],
        ]),
      );
    },
  };

  /**
   * What leaves this device.
   *
   * This command is what a privacy-conscious person runs to check, so it is
   * the one place that must not be reassuring by omission — and, after a
   * review found every sentence it printed false, the one place that must not
   * be reassuring by wording either. The rule for this copy: a line is a
   * measurement, or it does not ship. Where the measurement is unflattering
   * the unflattering line ships, because a false answer to someone actively
   * checking is worse than no answer.
   *
   * What was deleted rather than narrowed again, and why:
   *
   *   - "nothing else: no remote providers are enabled". A completeness
   *     claim, printed in exactly the configuration where it is false: an
   *     MCP tool sends its arguments to its own server from a chat with no
   *     provider in it at all. There is no completeness claim here now.
   *
   *   - "withholds it … if the reply diverted to a fallback". `stream()`
   *     tests `egress.isGranted` BEFORE it tests for a fallback, so a
   *     conversation grant covers the diverted turn too; only an ungranted
   *     fallback withholds. Measured at the adapter: the diverted request
   *     carried the tool output. The rule the code follows is stated below
   *     instead of the rule we meant to write.
   *
   *   - "that reply in every later turn". The taint mark is derived from
   *     `Message.toolCalls`, and `regenerate` moves the old text into
   *     `variants` on a row whose `toolCalls` belong to the new turn.
   *     Measured after `cycleVariant`: the history is unmarked and the bytes
   *     reach a remote adapter with no sheet. That is a defect in the code,
   *     not in the sentence, so the sentence says it plainly and the defect
   *     stays on the list.
   */
  const privacy: ShellCommand = {
    name: 'privacy',
    summary: 'What leaves this device',
    usage: 'privacy',
    async run() {
      const enabled = stores.providers().list.filter((p) => p.enabled);
      const servers = (stores.mcpServers?.() ?? []).filter((s) => s.enabled);

      return ok(
        [
          'Leaves this device:',
          '  - what you type into the model search, and the model files you',
          '    download, to huggingface.co',
          enabled.length > 0
            ? `  - messages you send to: ${enabled.map((p) => p.label).join(', ')}`
            : '  - no provider is enabled, so nothing you type is sent to one',
          // Printed only when there is a server to name. An unconditional
          // paragraph about MCP would be describing something that is not
          // happening; a named server is a fact the user can check.
          ...(servers.length > 0
            ? [
                '  - the arguments of an MCP tool, to the server that tool comes',
                `    from: ${servers.map((s) => `${s.name} (${s.host})`).join(', ')}.`,
                '    That tool runs there, not here, and nothing is asked before',
                '    its arguments go — enabling the tool for a chat is the whole',
                '    of the consent. A call the server itself calls destructive',
                '    does ask, but about changing data there, not about what',
                '    leaves. The arguments are whatever the model wrote from the',
                '    conversation.',
              ]
            : []),
          '  - tool output, when a tool runs in a chat served by a remote model:',
          '    what the tool read, which for `bash` is this app’s own data —',
          '    /chats, /models, /personas. The app asks before it does, and',
          '    withholds it if you decline. “Send for this conversation” is the',
          '    answer that stops the asking; “Send this turn” is asked again on',
          '    the next turn. Every grant is dropped when the provider it named',
          '    is removed or switched off — `provider disable <id>`.',
          '  - anything DERIVED from that output, under the same grant: a later',
          '    tool call’s arguments OR ITS NAME, and a reply the model wrote',
          '    while the tool was running. Moving it into a different block,',
          '    field or argument does not get it out; a withheld call is rebuilt',
          '    from the app’s own strings rather than emptied of the ones we',
          '    thought to empty.',
          '  - a benchmark run, if you turn leaderboard publishing on and',
          '    publish one. The exact payload is shown before it is sent.',
          '',
          'Two things reach further than they read:',
          '  - a grant covers the conversation, so it also covers a turn this',
          '    device could not finish and diverted to your fallback provider.',
          '    You are not asked again at the moment it diverts.',
          '  - flipping between regenerated answers moves the older text out of',
          '    the turn whose tool produced it. From then on it is sent as',
          '    ordinary text: nothing withheld, nothing asked.',
          '',
          'Stays on this device:',
          '  - conversations, personas, generated images, settings and benchmark',
          '    runs are stored here and nowhere else. There is no account and',
          '    nothing syncs. What can leave a conversation is the list above.',
          '  - platform backup is off, which is what makes the line above true.',
          '    Android auto-backup and phone-to-phone transfer are both',
          '    disabled; on iOS the WebView store is marked excluded from',
          '    iCloud and iTunes backup. A new phone does not inherit your',
          '    chats. That is the cost, and it is the point.',
        ].join('\n'),
      );
    },
  };

  return [model, chat, persona, provider, bench, device, privacy];
}

/**
 * Neutralise anything in a message body that could pass for a turn header.
 *
 * The transcript's only structure is `## Speaker`, so a message whose body
 * contains that shape manufactures a turn — the model writes `## You` followed
 * by words the user never said, and from then on the line appears in
 * `/chats/*.md`, in `chat export`, and in the file the user downloads. Closing
 * the filesystem route into `/chats` did not close this one: the message route
 * needs no write at all.
 *
 * A backslash is the Markdown escape, so `\## You` renders as the literal text
 * and greps the same. Only levels 1 and 2 are escaped — the two this renderer
 * actually emits — so a `### Notes` heading the user wrote survives.
 */
function escapeTranscriptBody(text: string): string {
  return text.replace(/^([ \t]{0,3})(#{1,2})(?=[ \t]|$)/gm, '$1\\$2');
}

/** Render a conversation as Markdown — used by `chat export` and the VFS. */
export function renderTranscript(
  chat: { title: string; updatedAt: number },
  messages: readonly MessageRow[],
): string {
  const lines = [
    `# ${escapeTranscriptBody(chat.title || deriveTitle(''))}`,
    '',
    `_${messages.length} messages · last updated ${new Date(chat.updatedAt).toISOString().slice(0, 10)}_`,
    '',
  ];

  for (const message of messages) {
    // THE HEADING DESCRIBES THE TEXT UNDER IT, AND THEY COME FROM ONE VALUE.
    //
    // Both used to be read off the row, which was only correct while the row
    // agreed with itself. It did not: flipping between regenerated answers
    // moved `content` and left `provenance` behind, so this renderer wrote
    // "## Qwen3 1.7B (on device)" over a reply that came back from OpenAI —
    // into `chat export`, into `/chats/*.md`, and into the file the user
    // downloads. Printing the displayed generation prints one turn.
    // `typeof content === 'string'` is a runtime check, not a type one: this
    // list held bare strings through v3, and a row that reached here without
    // the v4 upgrade would otherwise print an empty turn. Falling back to the
    // row prints the words.
    const record =
      message.variantIndex !== undefined && !message.streaming
        ? message.variants?.[message.variantIndex]
        : undefined;
    const shown = typeof record?.content === 'string' ? record : message;

    const who =
      message.role === 'user'
        ? 'You'
        : (shown.provenance?.modelName ?? (message.role === 'assistant' ? 'Assistant' : message.role));
    // Provenance is preserved in the export: a transcript that hides which
    // turns left the device would undo the point of marking them. Absent is
    // printed as absent — a generation recovered from a build that stored
    // variants as bare strings has no recorded origin, and neither label is
    // true of it, so it gets a bare name rather than a guess.
    const where = transcriptWhere(shown.provenance);
    lines.push(
      `## ${escapeTranscriptBody(who)}${where}`,
      '',
      escapeTranscriptBody(shown.content.trim()),
      '',
    );
  }

  return lines.join('\n');
}

/**
 * The parenthetical after the model name in an exported transcript.
 *
 * Three destinations, two phrases — the same coarsening the chip makes, and
 * for the same reason: the words that tell a paired desktop apart from a
 * provider are #210–#219's, and nothing writes a `paired` reach yet. A turn
 * that ran on one would be printed "(remote)", which overstates where it went
 * rather than hiding it.
 *
 * A reach nothing recorded prints NOTHING, which is what an absent provenance
 * already did: neither phrase is true of a generation whose origin was never
 * written down, and this file is read by someone checking whether their
 * conversation left the device.
 */
function transcriptWhere(provenance: TranscriptGeneration['provenance']): string {
  switch (reachKind(provenance)) {
    case 'device':
      return ' (on device)';
    case 'paired':
    case 'remote':
      return ' (remote)';
    case 'unknown':
      return '';
  }
}
