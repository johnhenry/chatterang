/**
 * The Chatterang shell.
 *
 * A POSIX-ish shell over a virtual filesystem, with Chatterang's own commands
 * registered alongside the bundled Unix ones. Two front doors, one surface:
 * the Shell sheet for the person holding the phone, and a `bash` tool for the
 * model.
 *
 * ## It is a sandbox, and that has to be this file's doing
 *
 * The old version of this comment said there is no real shell in a webview,
 * and that was true — but it was an observation about the runtime, not a
 * guarantee made by this code. On desktop the app runs in Electron, in a
 * process that has a real filesystem and a real socket. Measured in the
 * shipped renderer, `require`, `process`, `Buffer` and `__dirname` are all
 * undefined, and `just-bash` still sees only what it is handed — but that is
 * Electron's `sandbox: true` and `contextIsolation: true` doing the work, in
 * a file this one does not own. A capability the shell lacks by luck is a
 * capability it will have the first time someone changes the luck.
 *
 * So the three things that actually confine this shell are named here, and
 * two of them are now enforced rather than assumed:
 *
 *  1. **The entry point.** `just-bash/browser` ships 79 commands and no class
 *     that can address a real filesystem. `just-bash` — the default entry —
 *     ships 83 — `tar`, `yq`, `xan`, `sqlite3` — plus the CPython the browser
 *     build tells you to go and find, and `ReadWriteFs`, a filesystem rooted
 *     at a real directory. Nothing but an import specifier separated the two,
 *     and `apps/desktop` already bundles files out of `src/` into a Node
 *     process, so the pipe exists and is already used for something else.
 *     {@link assertConfinedBuild} refuses to start a shell whose module can
 *     address a real filesystem, rather than trusting the specifier to stay
 *     put.
 *
 *  2. **No network, as a capability rather than a missing command.**
 *     `just-bash` ships `curl` as opt-in and this never registers it — and
 *     because the `Bash` is constructed with no `network` option, `ctx.fetch`
 *     on the context handed to every custom command is `undefined` too. So
 *     nothing *inside* the shell can open a socket, and
 *     {@link assertConfinedBuild} fails the boot rather than trusting an
 *     import specifier to keep it that way. If network is ever wanted,
 *     `just-bash` offers an origin-and-prefix allow-list with a private-IP
 *     check — that shape, not a switch.
 *
 *     What this paragraph used to imply, and does not say now: that what the
 *     shell reads stays on the device. It did not. `bash` is a tool, a tool's
 *     output is appended to the conversation, and the conversation is sent to
 *     whatever backend serves the *next* turn. Measured on
 *     `ChatterangEngine.stream`: a projected `/chats` transcript arrived
 *     verbatim in the following request — including on a turn the user started
 *     locally, where the local engine failed and the loop diverted to the
 *     nominated fallback, so the remote provider's first and only request
 *     already carried it. The shell has no socket; the tool call that wraps it
 *     hands its stdout to one. Absent `curl` is what stops the shell
 *     exfiltrating by itself. It is not what stops it exfiltrating through the
 *     model. That is (4).
 *
 *  3. **The projection is read-only.** Enforced in `shell/fs.ts`, because it
 *     was not before and four places said it was. Writing into `/chats` lets
 *     a model manufacture the user's own words and quote them back; that is
 *     the model-driven risk that does not need a socket at all. The other half
 *     of that forgery — a turn header inside a message, which needs no write
 *     — is escaped in `renderTranscript`.
 *
 *  4. **Tool output does not leave the device without a grant on this
 *     conversation.** Enforced in `ai/engine.ts`, not here, because the defect
 *     was that `stream` built one message array and handed it to whichever
 *     backend `target` named at that instant — and `target` is reassigned
 *     mid-loop when the device cannot cope, so consent captured when the tool
 *     was enabled could not have covered the destination. A `tool_result` is
 *     therefore withheld from any request to a non-local backend unless this
 *     chat holds an egress grant for that connection, and the model is told
 *     plainly that it was withheld rather than handed a truncation. Read-only
 *     describes what happens to the server's state, not to your data — the
 *     same argument `ai/mcp/tools.ts` already makes about a third party's
 *     tools, applied to our own.
 *
 * That last one is the trade this app exists to make, and it is why it is not
 * configurable from inside the shell: a shell with a filesystem, a model, and
 * a socket at the far end of the model is an exfiltration path whether or not
 * the socket is in this file.
 *
 * What is deliberately allowed, and stays allowed: reading every projection
 * of the user's own data and computing over it with the full Unix set,
 * writing freely in `/workspace`, and asking for a state change — which the
 * user may refuse. `grep -ril "quantisation" /chats` is the point of the
 * whole thing. It costs nothing while the model is on this device, and one
 * explicit grant when it is not.
 *
 * ## The bundle
 *
 * `just-bash` is ~355 kB gzipped — larger than the rest of the app. It is
 * loaded on first use only, so people who never open a shell never pay.
 */

import type { ShellCommand, ShellContext, ShellOutput, ShellStores } from '@/shell/commands';
import { chatterangCommands, table } from '@/shell/commands';
import { guardProjection, type GuardedFs } from '@/shell/fs';
import {
  MOUNT_ROOT,
  mountReal,
  resolveGrant,
  type MountGrant,
  type RealFsPort,
  type ResolvedMount,
} from '@/shell/mount';
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
  /**
   * Real folders the user has granted, mounted under `/mnt` (#246).
   *
   * Absent or empty means the shell reaches nothing outside the app, which is
   * what it did before this existed and what it still does until somebody
   * picks a folder. `mountReal` returns the filesystem untouched for a fixed
   * empty list, so an ungranted shell is not merely equivalent to the old one
   * — it is the same object graph.
   *
   * THE FUNCTION FORM IS WHAT MAKES REVOKING WORK. Grants change while the
   * shell is open: `mount add` and `mount rm` are commands typed INTO it. A
   * captured array would mean a folder the user withdrew stayed mounted until
   * the component remounted, which is the wrong answer to give someone who
   * has just said to stop. The getter is re-read before every command.
   */
  mounts?: readonly MountGrant[] | (() => readonly MountGrant[]);
  /**
   * How to reach a real filesystem. Required only if `mounts` is non-empty.
   *
   * Injected rather than imported because `src/` may not name a Node builtin,
   * and because the same port is Capacitor's interface on iOS and Android —
   * so this file never learns which platform it is on.
   */
  realFs?: RealFsPort;
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
  InMemoryFs: new () => object;
  defineCommand: (
    name: string,
    execute: (
      args: string[],
      ctx: unknown,
    ) => Promise<{ stdout: string; stderr: string; exitCode: number }>,
  ) => unknown;
  getCommandNames: () => string[];
  /** Commands that can leave the device. Registered only with a `network` option. */
  getNetworkCommandNames?: () => string[];
  /** Present only in the Node entry point: a filesystem rooted at a real directory. */
  ReadWriteFs?: unknown;
}

let modulePromise: Promise<JustBashModule> | null = null;

/** Load `just-bash` once, on first use. */
function loadJustBash(): Promise<JustBashModule> {
  modulePromise ??= import('just-bash/browser') as unknown as Promise<JustBashModule>;
  return modulePromise;
}

/**
 * Are these the same grants, by value?
 *
 * Field by field rather than a JSON round trip, because the three fields ARE
 * the grant and a fourth added later should fail this comparison loudly rather
 * than be silently included by a stringifier — a `revokedAt` that compared
 * equal would be a withdrawn folder that stayed mounted.
 */
function sameGrants(a: readonly MountGrant[], b: readonly MountGrant[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((grant, index) => {
    const other = b[index]!;
    return (
      grant.name === other.name && grant.root === other.root && grant.writable === other.writable
    );
  });
}

/** The two methods the shell calls on the raw in-memory tree itself. */
interface InnerTree {
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>;
}

export class ChatterangShell {
  #options: ShellOptions;
  #bash: BashInstance | null = null;
  #fs: GuardedFs | null = null;
  /** Paths the last mount projected, so a stale one can be removed rather than left. */
  #projected = new Set<string>();
  #commands: ShellCommand[];
  #starting: Promise<void> | null = null;
  /**
   * The live mount table the filesystem proxy reads, and the grants it came
   * from — kept together so `#refreshMounts` can tell "nothing changed" from
   * "changed back", and skip the resolution round-trip for the common case.
   */
  #mounts: readonly ResolvedMount[] = [];
  #resolvedFrom: readonly MountGrant[] = [];
  /**
   * The in-memory filesystem, held BELOW the mount and the guard.
   *
   * `/mnt` and each `/mnt/<name>` have to exist as ordinary directories in
   * the virtual tree, or the mount point has no parent: `cd /mnt/notes`
   * answered "No such file or directory" while `ls /mnt/notes` worked,
   * because the mount claims `/mnt/notes` and deeper and nothing at all
   * claims `/mnt`. They are created here, below both decorators, so creating
   * them is not itself a write anything could intercept or route.
   */
  #inner: InnerTree | null = null;

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
    const module = await loadJustBash();
    assertConfinedBuild(module);
    const { Bash, InMemoryFs, defineCommand } = module;

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
    //
    // The projection guard goes between the shell and its filesystem rather
    // than inside any command, so it holds for every route into the FS — a
    // redirection, `cp`, `mv`, a symlink whose parent points somewhere else,
    // and any command a future version of this file registers.
    /*
     * Order is load-bearing: the mount goes BELOW the projection guard.
     *
     * `guardProjection` resolves a write's parent through `realpath` before
     * deciding whether it is projected. Above the mount, that call would ask
     * the in-memory filesystem about a path that lives on disk and be told
     * about nothing. Below it, the guard's own resolution flows through the
     * mount and is answered by the real filesystem — so a symlink under a
     * granted folder cannot be used to reach a projected path either.
     */
    const inner = new InMemoryFs();
    this.#inner = inner as unknown as InnerTree;
    await this.#refreshMounts();
    // The SUPPLIER form, not the resolved array: `#mounts` is replaced when a
    // grant is added or withdrawn, and the proxy must be reading the table the
    // user last agreed to rather than the one that existed at startup.
    const mounted = mountReal(inner, () => this.#mounts);
    const guarded = guardProjection(mounted);
    const bash = new Bash({ fs: guarded.fs, customCommands, cwd: '/' });

    this.#fs = guarded;
    this.#bash = bash;
    await this.#project();
  }

  /**
   * The `/mnt` lines of `help`, or nothing when no folder is granted.
   *
   * Absent rather than "none granted": a shell with no mounts is the shell
   * this app has always had, and advertising a capability that is not there
   * invites the model to try it and read a refusal.
   */
  #mountHelp(): readonly string[] {
    const grants = this.#grants();
    if (grants.length === 0) return [];
    return [
      '',
      'Granted folders (real, on this device):',
      ...grants.map(
        (grant) =>
          `  /mnt/${grant.name}`.padEnd(15) +
          `${grant.writable ? 'read and write' : 'read-only'} — you granted this folder`,
      ),
      'Nothing outside a granted folder is reachable, including through a symlink.',
    ];
  }

  /**
   * Resolve every grant once, at start.
   *
   * A grant whose root does not resolve — deleted, renamed, permission gone,
   * or not a directory — is dropped rather than mounted against the string it
   * was granted by. Mounting it anyway would make every later containment
   * decision for that folder a comparison against a path the kernel does not
   * agree exists.
   */
  async #resolveMounts(): Promise<readonly ResolvedMount[]> {
    const grants = this.#grants();
    const port = this.#options.realFs;
    if (grants.length === 0 || !port) return [];
    const resolved = await Promise.all(grants.map((grant) => resolveGrant(grant, port)));
    return resolved.filter((mount): mount is ResolvedMount => mount !== null);
  }

  /** The grants as they are RIGHT NOW. See `ShellOptions.mounts`. */
  #grants(): readonly MountGrant[] {
    const mounts = this.#options.mounts;
    return (typeof mounts === 'function' ? mounts() : mounts) ?? [];
  }

  /**
   * Re-resolve the mount table if, and only if, the grants changed.
   *
   * Called before every command, so it has to be cheap when nothing happened
   * — which is almost always. The comparison is on the grant VALUES rather
   * than array identity: a caller reading from React state hands back a new
   * array on every render, and re-`realpath`ing three folders per keystroke
   * to discover they are the same three is a round trip per command for
   * nothing.
   *
   * REVOKING TAKES EFFECT HERE, and that is the reason this is not merely an
   * optimisation with a cache. `resolveGrant` re-resolves the root, so a
   * folder that has been deleted, renamed, or had its permissions withdrawn
   * since it was granted drops out of the table rather than staying mounted
   * against a path that no longer means anything.
   */
  async #refreshMounts(): Promise<void> {
    const grants = this.#grants();
    if (sameGrants(grants, this.#resolvedFrom)) return;
    this.#resolvedFrom = grants;
    const previous = this.#mounts;
    this.#mounts = await this.#resolveMounts();
    await this.#reconcileMountPoints(previous);
  }

  /**
   * Make each `/mnt/<name>` exist as a directory in the virtual tree, and
   * remove the ones that no longer should.
   *
   * A MOUNT POINT NEEDS A PARENT. `mountFor` claims `/mnt/notes` and
   * everything under it, and nothing claims `/mnt` — so with no directory
   * there, `cd /mnt/notes` failed with "No such file or directory" while `ls
   * /mnt/notes` worked, because they ask different questions about the path
   * above. These are created on the raw in-memory filesystem, BELOW the mount
   * and below the projection guard, for the same reason `project` writes
   * there: a directory the shell can see but not reach around.
   *
   * `/mnt` is created only when something is granted. An empty `/mnt` sitting
   * in every shell would advertise a capability that is not there, which is
   * the argument `#mountHelp` already makes about the help text.
   */
  async #reconcileMountPoints(previous: readonly ResolvedMount[]): Promise<void> {
    const inner = this.#inner;
    if (!inner) return;
    const current = this.#mounts;

    for (const stale of previous) {
      if (current.some((mount) => mount.virtualRoot === stale.virtualRoot)) continue;
      // A withdrawn grant leaves no trace: a leftover empty directory reads
      // as a folder that is still granted and merely empty.
      await inner.rm(stale.virtualRoot, { recursive: true, force: true }).catch(() => undefined);
    }
    if (current.length === 0) {
      if (previous.length > 0) {
        await inner.rm(MOUNT_ROOT, { recursive: true, force: true }).catch(() => undefined);
      }
      return;
    }
    for (const mount of current) {
      await inner.mkdir(mount.virtualRoot, { recursive: true }).catch(() => undefined);
    }
  }

  /**
   * Project app state into the filesystem.
   *
   * This is what makes the shell more than a toy: `grep -ril "quantisation"
   * /chats` searches every conversation, which the chat list cannot do.
   */
  async mount(snapshot?: VfsSnapshot): Promise<void> {
    // Starting the shell mounts, so a mount before it has started used to be
    // a silent no-op that dropped the snapshot it was handed.
    await this.ready();
    await this.#project(snapshot);
  }

  async #project(snapshot?: VfsSnapshot): Promise<void> {
    const fs = this.#fs;
    if (!fs) return;
    const files = snapshot ?? (await buildVfs(this.#options.stores));

    // Rebuild, do not overlay. A mount that only ever wrote left deleted
    // chats visible and renamed ones duplicated, and it was the reason a file
    // written into `/chats` used to outlive every remount — `createBashTool`
    // mounts before every single command, so "until the next mount" was never
    // a bound on anything.
    for (const path of this.#projected) {
      if (!(path in files)) await fs.unproject(path);
    }
    for (const [path, content] of Object.entries(files)) {
      await fs.project(path, content);
    }
    this.#projected = new Set(Object.keys(files));
  }

  async exec(commandLine: string, signal?: AbortSignal): Promise<ShellResult> {
    const started = performance.now();
    await this.ready();
    // Before the command, not after: a folder granted or withdrawn by the
    // PREVIOUS command is in force for this one, which is what anyone who
    // just typed `mount rm notes` expects of the next thing they type.
    await this.#refreshMounts();

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
      // What THIS shell resolved, not what the process has been granted. A
      // command describing what the shell can reach must not read the grant
      // registry, which knows nothing about whether this shell was wired to a
      // filesystem at all.
      mounts: this.#mounts.map((mount) => ({ name: mount.name, writable: mount.writable })),
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
            /*
             * ONE COMMAND MUST NOT CONTRADICT ITSELF. With a folder granted,
             * this line said "a sandbox, not your device" twenty lines above
             * "Granted folders (real, on this device)". The test that pins the
             * first sentence — 'reports the sandbox honestly in its own help'
             * — builds a shell with no mounts, so it could never see the case
             * where its own subject is false.
             *
             * The sandbox sentence is still true of everything the shell
             * reaches by default, so it stays for a shell with no grants
             * rather than being softened for every shell to cover a case most
             * of them are not in.
             */
            this.#grants().length === 0
              ? 'Chatterang shell — a sandbox, not your device.'
              : 'Chatterang shell — a sandbox, plus the folders you granted it.',
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
            'Everything outside /workspace is read-only: the filesystem refuses',
            'the write, so nothing here can invent a conversation and quote it back.',
            ...(this.#mountHelp()),
            '',
            'Standard tools are available: grep, sed, awk, jq, find, sort, wc, diff …',
            'Network access is not available, by design.',
            '',
            'What you read here goes to the model. If the model is remote, that is',
            'off this device — the app asks once per conversation before it does.',
            'Run `privacy` for the full list of what leaves.',
          ].join('\n'),
        }) satisfies ShellOutput,
    };
  }
}

/**
 * Refuse to start on a build that can reach further than this one.
 *
 * Measured, not assumed: `just-bash/browser` exports no `ReadWriteFs` and
 * registers 79 commands; the default `just-bash` entry exports `ReadWriteFs`
 * — a filesystem rooted at a real directory — and registers 83, the extra
 * four being `tar`, `yq`, `xan` and `sqlite3`. `getNetworkCommandNames()`
 * returns `["curl"]` on both, and `getCommandNames()` contains it on neither,
 * which is what "curl is opt-in" means in practice.
 *
 * So the check is not a style rule about import specifiers. It is the one
 * place that notices if the shell is ever handed a module that can address a
 * disk or dial out, and it fails loudly at boot instead of quietly at the
 * moment a prompt-injected model finds it.
 */
export function assertConfinedBuild(module: {
  getCommandNames: () => string[];
  getNetworkCommandNames?: () => string[];
  ReadWriteFs?: unknown;
}): void {
  if (module.ReadWriteFs !== undefined) {
    throw new Error(
      'shell: refusing to start — this just-bash build exports ReadWriteFs, ' +
        'which addresses a real filesystem. The shell requires the browser entry point.',
    );
  }

  const registered = new Set(module.getCommandNames());
  const networked = (module.getNetworkCommandNames?.() ?? []).filter((name) =>
    registered.has(name),
  );
  if (networked.length > 0) {
    throw new Error(
      `shell: refusing to start — network commands are registered (${networked.join(', ')}). ` +
        'A shell with this filesystem and a socket is an exfiltration path.',
    );
  }
}

/** Names of the Unix commands the bundled shell provides. */
export async function bundledCommandNames(): Promise<string[]> {
  const { getCommandNames } = await loadJustBash();
  return getCommandNames();
}
