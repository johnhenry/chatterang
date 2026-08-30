/**
 * The Chatterang shell.
 *
 * A POSIX-ish shell over a virtual filesystem, with Chatterang's own commands
 * registered alongside the bundled Unix ones. Two front doors, one surface:
 * the Shell sheet for the person holding the phone, and a `bash` tool for the
 * model.
 *
 * ## It is a sandbox, not the device
 *
 * There is no real shell in a webview, and this deliberately does not pretend
 * otherwise. The filesystem is synthetic: a writable `/workspace`, plus
 * read-only views of the app's own data. Nothing here can read your photos,
 * your keychain, or another app's files, because none of that is mounted.
 *
 * ## Network is off
 *
 * `just-bash` ships `curl` as an opt-in command and this never registers it.
 * A shell with a filesystem, a model, and network access is an exfiltration
 * path; without the third leg it is a workspace. That is the trade this app
 * exists to make, so it is not configurable from inside the shell.
 *
 * ## The bundle
 *
 * `just-bash` is ~355 kB gzipped — larger than the rest of the app. It is
 * loaded on first use only, so people who never open a shell never pay.
 */

import type { ShellCommand, ShellContext, ShellOutput, ShellStores } from '@/shell/commands';
import { chatterangCommands, table } from '@/shell/commands';
import { buildVfs, type VfsSnapshot } from '@/shell/vfs';

export type { ShellCommand, ShellContext, ShellOutput, ShellStores } from '@/shell/commands';

export interface ShellResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  /** Wall-clock duration, shown in the prompt line. */
  readonly durationMs: number;
}

export interface ShellOptions {
  stores: ShellStores;
  /** Who is driving. The model may not run mutating commands unconfirmed. */
  actor: 'user' | 'model';
  confirm(action: string): Promise<boolean>;
}

/**
 * Minimal structural view of the parts of `just-bash` this uses.
 *
 * Declared here rather than imported so the type graph does not depend on a
 * lazily-loaded module, and so an upstream API change surfaces as a single
 * compile error in this file.
 */
interface BashInstance {
  readonly fs: unknown;
  exec(
    commandLine: string,
    options?: Record<string, unknown>,
  ): Promise<{ stdout?: string; stderr?: string; exitCode?: number }>;
  writeFile(path: string, content: string): Promise<void>;
  readFile(path: string): Promise<string>;
}

interface JustBashModule {
  Bash: new (options: {
    fs?: unknown;
    customCommands?: unknown[];
    /** Starting directory. Defaults to /home/user, which this VFS does not mount. */
    cwd?: string;
  }) => BashInstance;
  InMemoryFs: new () => unknown;
  defineCommand: (
    name: string,
    execute: (
      args: string[],
      ctx: unknown,
    ) => Promise<{ stdout: string; stderr: string; exitCode: number }>,
  ) => unknown;
  getCommandNames: () => string[];
}

let modulePromise: Promise<JustBashModule> | null = null;

/** Load `just-bash` once, on first use. */
function loadJustBash(): Promise<JustBashModule> {
  modulePromise ??= import('just-bash/browser') as unknown as Promise<JustBashModule>;
  return modulePromise;
}

export class ChatterangShell {
  #options: ShellOptions;
  #bash: BashInstance | null = null;
  #commands: ShellCommand[];
  #starting: Promise<void> | null = null;

  constructor(options: ShellOptions) {
    this.#options = options;
    this.#commands = [...chatterangCommands(options.stores), this.#helpCommand()];
  }

  /** Command names Chatterang adds on top of the bundled Unix set. */
  get appCommands(): readonly ShellCommand[] {
    return this.#commands;
  }

  async ready(): Promise<void> {
    this.#starting ??= this.#start();
    return this.#starting;
  }

  async #start(): Promise<void> {
    const { Bash, InMemoryFs, defineCommand } = await loadJustBash();

    // `just-bash` hands a command its argv and expects stdout/stderr and an
    // exit code back — the same contract as a real binary, which is why pipes
    // and `&&` work on Chatterang's commands exactly as they do on `grep`.
    const customCommands = this.#commands.map((command) =>
      defineCommand(command.name, async (args) => {
        const result = await this.#invoke(command, args);
        return {
          stdout: result.stdout,
          stderr: result.stderr ?? '',
          exitCode: result.exitCode,
        };
      }),
    );

    // `cwd: '/'` is not cosmetic. just-bash defaults to /home/user, which this
    // VFS never mounts — so a bare `ls` returned empty with exit 0, which the
    // renderer prints as a green "ok", and `cat README.md` failed although
    // /README.md exists. The first thing anyone types in a shell is `ls`, and
    // it reported success while showing nothing. The mounts are all at root
    // and the help text advertises /chats, /models and /personas, so root is
    // where the prompt belongs.
    const bash = new Bash({ fs: new InMemoryFs(), customCommands, cwd: '/' });

    this.#bash = bash;
    await this.mount();
  }

  /**
   * Project app state into the filesystem.
   *
   * This is what makes the shell more than a toy: `grep -ril "quantisation"
   * /chats` searches every conversation, which the chat list cannot do.
   */
  async mount(snapshot?: VfsSnapshot): Promise<void> {
    if (!this.#bash) return;
    const files = snapshot ?? (await buildVfs(this.#options.stores));
    for (const [path, content] of Object.entries(files)) {
      await this.#bash.writeFile(path, content);
    }
  }

  async exec(commandLine: string, signal?: AbortSignal): Promise<ShellResult> {
    const started = performance.now();
    await this.ready();

    if (!this.#bash) {
      return { stdout: '', stderr: 'shell failed to start', exitCode: 1, durationMs: 0 };
    }

    try {
      const result = await this.#bash.exec(commandLine, { signal });
      return {
        stdout: String(result.stdout ?? ''),
        stderr: String(result.stderr ?? ''),
        exitCode: result.exitCode ?? 0,
        durationMs: Math.round(performance.now() - started),
      };
    } catch (error) {
      return {
        stdout: '',
        stderr: error instanceof Error ? error.message : String(error),
        exitCode: 1,
        durationMs: Math.round(performance.now() - started),
      };
    }
  }

  /**
   * Run one Chatterang command with the gate applied.
   *
   * The gate is the whole security model: a command that changes state, or
   * that touches the network, has to be confirmed. When the model is driving,
   * that confirmation is a sheet the user actually sees.
   */
  async #invoke(command: ShellCommand, args: readonly string[]): Promise<ShellOutput> {
    const context: ShellContext = {
      actor: this.#options.actor,
      confirm: async (action, options) => {
        // A person typing a command has already expressed intent for local
        // state changes; only egress is worth interrupting them for. The
        // model has expressed nothing, so everything it asks for is gated.
        if (this.#options.actor === 'user' && !options?.network) return true;
        return this.#options.confirm(action);
      },
    };

    try {
      return await command.run(args, context);
    } catch (error) {
      return {
        stdout: '',
        stderr: error instanceof Error ? error.message : String(error),
        exitCode: 1,
      };
    }
  }

  #helpCommand(): ShellCommand {
    return {
      name: 'chatterang',
      summary: 'Chatterang commands and what the shell can reach',
      usage: 'chatterang',
      run: async () =>
        ({
          exitCode: 0,
          stdout: [
            'Chatterang shell — a sandbox, not your device.',
            '',
            'App commands:',
            table(this.#commands.map((c) => [`  ${c.name}`, c.summary])),
            '',
            'Filesystem:',
            '  /workspace   scratch space, yours to write in',
            '  /chats       conversations as Markdown, read-only',
            '  /models      installed model manifests, read-only',
            '  /personas    personas as JSON, read-only',
            '',
            'Standard tools are available: grep, sed, awk, jq, find, sort, wc, diff …',
            'Network access is not available, by design.',
          ].join('\n'),
        }) satisfies ShellOutput,
    };
  }
}

/** Names of the Unix commands the bundled shell provides. */
export async function bundledCommandNames(): Promise<string[]> {
  const { getCommandNames } = await loadJustBash();
  return getCommandNames();
}
