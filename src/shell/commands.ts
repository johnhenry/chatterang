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
import type { Reach, ToolInvocation } from '@/domain/chat';
import { unhandledOutcome, unhandledWhy, type McpCallReceipt } from '@/domain/mcp';

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
  /**
   * The folders THIS shell actually mounted — not the folders the user has
   * granted somewhere in the process (#246).
   *
   * The two differ, and the difference was a disclosure. `ShellStores.mounts`
   * is the process-wide grant registry; a shell that was never handed
   * `mounts`/`realFs` still reads it, so `mount list` named a real folder in a
   * shell where `ls /mnt` exits 2. A command that describes what the shell can
   * reach has to ask the shell, and this is how.
   *
   * Defaults to empty when a caller does not supply it, which is the same
   * answer a shell with no mounts gives — never "we could not tell".
   */
  readonly mounts?: readonly MountedFolder[];
}

/** One folder a shell has actually resolved and routed. */
export interface MountedFolder {
  readonly name: string;
  readonly writable: boolean;
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
  /**
   * Folders the user granted, and how to grant or withdraw one (#246).
   *
   * Optional for the same reason `mcpServers` is: it arrived after the
   * interface, and every test builds this object by hand. Its absence means
   * NO FOLDERS ARE GRANTED — never "we could not tell", because the `mount`
   * command's whole job is to say what the shell can reach and an unwired
   * caller must not turn that into a claim about the disk.
   */
  mounts?: () => MountStore;
}

/** What `mount` needs. The shell's own grants live behind `src/shell/real-fs.ts`. */
export interface MountStore {
  readonly list: readonly MountRow[];
  /**
   * Can a folder be granted on this platform at all?
   *
   * Separate from an empty `list`, and the difference is the whole message:
   * "no folders granted" invites the user to grant one, and on a platform with
   * no chooser that invitation leads to a picker that never opens.
   */
  readonly canGrant: boolean;
  /** Opens the OS chooser. `null` when the user declined or cannot be asked. */
  grant(writable: boolean): Promise<MountRow | null>;
  revoke(id: string): Promise<boolean>;
}

export interface MountRow {
  readonly id: string;
  readonly name: string;
  readonly root: string;
  readonly writable: boolean;
  readonly grantedAt: number;
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
  /** Only their receipts are printed: see `receiptLines`. */
  toolCalls?: readonly ToolInvocation[];
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
    async run(_args, context) {
      const enabled = stores.providers().list.filter((p) => p.enabled);
      const servers = (stores.mcpServers?.() ?? []).filter((s) => s.enabled);
      /*
       * WHAT THIS SHELL MOUNTED, not what the process has been granted, and
       * for two reasons that are both bugs this command had.
       *
       * A shell with no filesystem wiring still reads `stores.mounts`, so this
       * used to tell a model that tool output includes a folder the shell
       * cannot open — a false sentence in the one command whose entire purpose
       * is not to shade the truth.
       *
       * And it printed the folder's ABSOLUTE HOST PATH, twice, to whoever ran
       * it. `mount.ts` keeps that path out of `realpath` and out of every
       * error message precisely so the folder's location on disk does not
       * leak; the honesty command was the one place it did. The person is told
       * where their folder is, because they chose it. The model is told which
       * mount point, which is what governs the bytes.
       */
      const mountedHere = new Set((context.mounts ?? []).map((entry) => entry.name));
      const granted = (stores.mounts?.().list ?? []).filter((row) => mountedHere.has(row.name));
      const writable = granted.filter((row) => row.writable);
      const nameFolder = (row: MountRow): string =>
        context.actor === 'user' ? row.root : `/mnt/${row.name}`;

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
                '    That tool runs there, not here. Its arguments do not go until',
                '    you allow that server in this conversation — for the calls on',
                '    screen, or for the whole conversation — and the sheet names the',
                '    server, its host and how many bytes would be sent. A server on',
                '    localhost is asked about the same way. Every grant to a server',
                '    is dropped when it is removed or switched off. A call the server',
                '    itself calls destructive is then asked about separately, about',
                '    changing data there. The arguments are whatever the model wrote',
                '    from the conversation. Each call handed to a server is recorded',
                '    in the thread and in an exported transcript: the server, its',
                '    host, when, and how many bytes of arguments.',
              ]
            : []),
          '  - tool output, when a tool runs in a chat served by a remote model:',
          // WAS "this app's own data — /chats, /models, /personas", full stop,
          // and #246 made that false the moment anyone grants a folder. The
          // granted case is printed only when a folder IS granted, and names
          // it: an unconditional paragraph about folders would describe
          // something that is not happening, and the ungranted sentence is
          // still exactly true for every shell that has not been given one.
          granted.length > 0
            ? '    what the tool read — this app’s own data (/chats, /models,'
            : '    what the tool read, which for `bash` is this app’s own data —',
          granted.length > 0
            ? `    /personas) AND anything it read in ${granted
                .map((row) => `/mnt/${row.name}`)
                .join(', ')}${
                context.actor === 'user'
                  ? `, which is ${granted.map((row) => row.root).join(', ')}.`
                  : ', which are folders the person granted.'
              }`
            : '    /chats, /models, /personas. The app asks before it does, and',
          ...(granted.length > 0
            ? ['    The app asks before it does, and']
            : []),
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
          // A READ grant changes what leaves; a WRITE grant changes what can
          // be CHANGED, which nothing else in this command describes because
          // until #246 the shell could not alter anything outside the app.
          // Named separately rather than folded into the line above: they are
          // different harms and a person deciding whether to keep a grant is
          // weighing them separately.
          ...(writable.length > 0
            ? [
                '',
                'Can be changed on this device:',
                `  - files in ${writable.map(nameFolder).join(', ')}. You granted`,
                '    write access to that folder, so the shell — and a model driving',
                '    it — can create, edit and delete files there. `mount rm <name>`',
                '    withdraws it; closing the app withdraws every grant.',
              ]
            : []),
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

  /**
   * `mount` — the folders this shell can reach, and who said so (#246).
   *
   * THE COMMAND IS THE REVOCATION UI. The issue asks for grants "listed
   * somewhere the user can see and revoke", and the shell is where a person
   * is standing when they care: they are looking at `/mnt/notes` in `ls`
   * output and want to know what it is and how to make it stop. A settings
   * pane the folder does not appear in until you go looking for it answers a
   * question nobody asked there.
   *
   * `mutating: true` so the MODEL cannot grant or withdraw a folder without
   * the user seeing the sheet. Two gates then stand in front of `mount add`
   * when a model runs it — the approval sheet, and the OS chooser itself,
   * which no amount of prompt injection can click.
   *
   * ADDING IS GATED EVEN FOR THE USER. `#invoke` waives confirmation for a
   * person typing a local state change, which is right for `provider disable`
   * and wrong here only in the sense that the chooser asks anyway; the real
   * consent is the modal, and it is not skippable by anyone.
   *
   * ## `mount list` shows the FOLDER column to a person and not to a model
   *
   * THE COMMENT THAT USED TO BE HERE WAS MEASURABLY FALSE. It said `mount
   * list` needs no gate "because reading which folders are already granted
   * tells the model nothing it could not learn by running `ls /mnt`". In the
   * only shell a model drives, `ls /mnt` exited 2 — `createBashTool` built its
   * shell without `mounts` or `realFs`, so the grant was in the registry this
   * command reads and nowhere in the filesystem. A model got the user's
   * absolute host path, unconfirmed, for a folder it could not open; and
   * `privacy`, the app's own honesty command, printed it twice.
   *
   * Two rules now, because that was two bugs:
   *
   *   1. This command describes what THIS shell mounted — `context.mounts` —
   *      not what the process has been granted. A folder the shell cannot
   *      reach is shown as not mounted rather than silently listed as if it
   *      were.
   *   2. The real path on disk is shown to the PERSON and not to the model,
   *      which is the rule `mount.ts` already follows everywhere else: its
   *      `realpath` answers with the virtual path, and `MountEscapeError`
   *      keeps the host path out of its message, both so the folder's location
   *      does not leak. A table that prints it is the same leak with a header.
   *
   * The model still sees the mount point, the access and when it was granted.
   * That is everything it needs to use the folder and nothing it could not
   * work out from `ls /mnt`.
   */
  const mount: ShellCommand = {
    name: 'mount',
    summary: 'Folders you granted this shell, and how to withdraw them',
    usage: 'mount list | mount add [--write] | mount rm <name>',
    mutating: true,
    async run(args, context) {
      const store = stores.mounts?.();
      const [sub, ...rest] = args;

      switch (sub ?? 'list') {
        case 'list': {
          if (!store || store.list.length === 0) {
            return ok(
              [
                'No folders are granted. Everything the shell can see is inside this app.',
                store?.canGrant === true
                  ? 'Run `mount add` to grant one — it opens a folder chooser.'
                  : 'This platform cannot grant folders; nothing outside the app is reachable here.',
              ].join('\n'),
            );
          }
          // The real path is the person's to see. See the block comment above
          // `mount` for why the model is shown the mount point instead.
          const showFolder = context.actor === 'user';
          const mountedHere = new Set((context.mounts ?? []).map((entry) => entry.name));
          return ok(
            [
              table([
                ['MOUNT', 'ACCESS', 'GRANTED', ...(showFolder ? ['FOLDER'] : [])],
                ...store.list.map((row) => [
                  `/mnt/${row.name}`,
                  // What the shell can DO here, not what was granted somewhere
                  // else: a grant this shell never resolved is reachable for
                  // nothing, and calling it "read-only" would overstate it.
                  mountedHere.has(row.name)
                    ? row.writable
                      ? 'read+write'
                      : 'read-only'
                    : 'not mounted here',
                  new Date(row.grantedAt).toISOString().slice(0, 16).replace('T', ' '),
                  ...(showFolder ? [row.root] : []),
                ]),
              ]),
              '',
              'Withdraw one with `mount rm <name>`. Grants end when the app closes.',
              ...(showFolder
                ? []
                : ['Where each folder lives on disk is not shown here; ask the person.']),
            ].join('\n'),
          );
        }

        case 'add': {
          if (!store) return fail('mount: granting folders is not wired up in this build');
          if (!store.canGrant) {
            return fail(
              'mount: this platform cannot grant a folder. A grant needs a chooser the ' +
                'person is sitting in front of, and there is none here.',
            );
          }
          const writable = rest.includes('--write');
          const unknown = rest.find((arg) => arg !== '--write');
          if (unknown !== undefined) return fail(`mount: unknown option "${unknown}"`);

          if (
            !(await context.confirm(
              writable
                ? 'open a folder chooser, to grant read AND WRITE access to a folder on this device'
                : 'open a folder chooser, to grant read access to a folder on this device',
            ))
          ) {
            return fail('cancelled', 130);
          }

          const granted = await store.grant(writable);
          if (granted === null) return ok('No folder was granted.');
          // What was AGREED, not what was asked: the host asks about writing
          // separately and defaults to no, so a `--write` request can come
          // back read-only and the user must be told which one they have.
          return ok(
            `/mnt/${granted.name} → ${granted.root}\n` +
              `${granted.writable ? 'Read and write.' : 'Read-only.'}` +
              (writable && !granted.writable ? ' Write access was not granted.' : ''),
          );
        }

        case 'rm': {
          const name = rest[0];
          if (!name) return fail(`usage: ${this.usage}`);
          const row = store?.list.find((entry) => entry.name === name.replace(/^\/mnt\//, ''));
          if (!row) return fail(`mount: no folder is granted as "${name}"`);
          if (!(await context.confirm(`withdraw access to ${row.root}`))) {
            return fail('cancelled', 130);
          }
          // The store's answer, not an assumption: a grant already withdrawn
          // elsewhere reports honestly rather than claiming this call did it.
          const revoked = await store!.revoke(row.id);
          return revoked
            ? ok(`/mnt/${row.name} is no longer mounted.`)
            : fail(`mount: "${row.name}" was already withdrawn`);
        }

        default:
          return fail(`mount: unknown subcommand "${sub}"\nusage: ${this.usage}`);
      }
    },
  };

  return [model, chat, persona, provider, bench, device, privacy, mount];
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

    // EGRESS IS A FACT ABOUT THE CONVERSATION, NOT ABOUT WHICH VERSION IS ON
    // SCREEN (#92). The heading and the text describe the displayed generation;
    // what a hidden one sent is printed too, marked as not the reply above. A
    // transcript that dropped it would say less left than did.
    const egress = receiptLines(message, shown === record);
    if (egress.length > 0) lines.push(...egress.map((line) => escapeTranscriptBody(line)), '');
  }

  return lines.join('\n');
}

/**
 * One line per MCP call a turn recorded — handed to a server, or withheld from
 * one — for every generation the turn kept.
 *
 * EVERY GENERATION ONCE. When the displayed generation is a record in
 * `variants`, the row's own fields are its projection (`applyVariant`), so the
 * list alone is every generation and reading the row as well would print the
 * displayed calls twice. Otherwise the row is a generation the list does not
 * hold — a turn never regenerated, or a regeneration that failed or was
 * interrupted, whose index points past the end — and it is read beside the list.
 *
 * Escaped by the caller like any body text: a tool name is chosen by the server.
 */
function receiptLines(message: MessageRow, displayedIsListed: boolean): string[] {
  const variants = message.variants ?? [];
  const generations: { generation: TranscriptGeneration; displayed: boolean }[] = displayedIsListed
    ? variants.map((generation, index) => ({ generation, displayed: index === message.variantIndex }))
    : [
        { generation: message, displayed: true },
        ...variants.map((generation) => ({ generation, displayed: false })),
      ];
  const ordered = [
    ...generations.filter((entry) => entry.displayed),
    ...generations.filter((entry) => !entry.displayed),
  ];

  return ordered.flatMap(({ generation, displayed }) =>
    // `?.` for the same reason `shown` checks `content`: through v3 a variant
    // was a bare string, and it has no calls to print.
    (generation?.toolCalls ?? []).flatMap((call) =>
      call.receipt
        ? [
            `- ${receiptClause(call.receipt)}${displayed ? '' : ' (from a version of this reply not shown)'}.`,
          ]
        : [],
    ),
  );
}

/**
 * A receipt as the transcript prints it. The thread's sentence, with the tool
 * named, because the export prints no tool blocks for it to sit under.
 */
function receiptClause(receipt: McpCallReceipt): string {
  const where = `${receipt.host} (${receipt.serverName})`;
  const when = transcriptTime(receipt.at);
  switch (receipt.outcome) {
    case 'sent':
      return `${receipt.toolName} sent ${receipt.bytes} bytes of arguments to ${where} at ${when}`;
    case 'failed':
      return `${receipt.toolName} tried to send ${receipt.bytes} bytes of arguments to ${where} at ${when} — the call failed, so they may or may not have arrived`;
    case 'withheld':
      // What held it back, as the thread says it.
      switch (receipt.why) {
        case 'not-allowed':
          return `${receipt.toolName} was not sent to ${where} at ${when} — it was not allowed`;
        case 'declined':
          return `${receipt.toolName} was not sent to ${where} at ${when} — it could change data there, and was declined`;
        case 'server-changed':
          return `${receipt.toolName} was not sent to ${where} at ${when} — the server changed before it went`;
        case 'stopped':
          return `${receipt.toolName} was not sent to ${where} at ${when} — the reply was stopped before it went`;
        default:
          return `${receipt.toolName} was not sent to ${where} at ${when} — ${unhandledWhy(receipt.why)}`;
      }
    default:
      // A new outcome has to say what it means here before this compiles.
      return unhandledOutcome(receipt);
  }
}

/**
 * UTC to the second: a file is read in whatever timezone it is opened in.
 * `toISOString` throws on an invalid date, and one bad row must not take the
 * whole export down with it.
 */
function transcriptTime(at: number): string {
  const date = new Date(at);
  return Number.isNaN(date.getTime())
    ? 'an unrecorded time'
    : `${date.toISOString().slice(0, 19).replace('T', ' ')} UTC`;
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
