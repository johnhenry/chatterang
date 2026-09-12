/**
 * The `bash` tool.
 *
 * Gives the model the same shell the Shell sheet exposes — same commands,
 * same filesystem, same gate. One surface with two front doors, so anything
 * the model can do is something the user can inspect by typing it themselves.
 *
 * THAT SENTENCE WAS AN ASPIRATION FOR ONE RELEASE AND IT SHOULD NOT HAVE
 * BEEN. #246 added granted folders to the Shell sheet and not to this file,
 * so for the length of one pull request the two front doors opened onto
 * different rooms: the person's shell had `/mnt`, the model's did not, and
 * `mount list` — which reads the process-wide grant registry — named the
 * user's real folder in a shell that could not open it. The two are wired
 * from the same place now, and `tests/shell.test.ts` drives this tool rather
 * than a shell built to look like it.
 *
 * The gate is what makes this safe to hand a model: the shell has no network,
 * reaches nothing outside the app EXCEPT a folder the person chose in an
 * operating-system chooser, and refuses every state-changing command until
 * the user confirms it in a sheet they can actually read.
 *
 * "Except a folder the person chose" is the whole of the change, and it is
 * narrow on purpose: no path can be granted from in here, a grant is
 * read-only unless a second dialog said otherwise, and every grant ends when
 * the app closes.
 */

import type { ChatterangTool } from '@/ai/tools/registry';
import { ChatterangShell } from '@/shell';
import { mountHostPort, shellMounts } from '@/shell/real-fs';
import { liveStores } from '@/shell/stores';

export interface BashToolOptions {
  /** Shown to the user when the model asks to change something. */
  confirm(action: string): Promise<boolean>;
}

export function createBashTool(options: BashToolOptions): ChatterangTool {
  let shell: ChatterangShell | null = null;

  return {
    id: 'bash',
    name: 'bash',
    summary: 'Run shell commands in a sandbox over this app’s data',
    sensitive: true,
    description: [
      'Run a shell command in a sandbox. Available: the usual Unix tools (grep, sed, awk, jq,',
      'find, sort, wc, diff, head, tail, cut, tr, base64, sha256sum…) plus Chatterang commands:',
      'model, chat, persona, provider, bench, device, privacy, mount. Run `chatterang` for a',
      'summary of what this shell can currently reach.',
      '',
      'Filesystem: /workspace is writable scratch space; /chats holds every conversation as',
      'Markdown; /models and /personas hold JSON. Everything except /workspace is read-only —',
      'the filesystem refuses the write rather than discarding it, so do not try to record',
      'anything under /chats; it is the app\u2019s own data, not a notebook.',
      '',
      // Stated unconditionally because this string is built once, at
      // registration, and a folder can be granted at any point afterwards.
      // "if any" is the honest form: `chatterang` and `mount list` answer for
      // the moment the command actually runs.
      'A folder the person has granted appears under /mnt/<name>, if any have been. Those are',
      'real files on their device, read-only unless the grant says otherwise. You cannot grant',
      'one: `mount add` opens a chooser only a person can click.',
      '',
      'There is NO network access — curl and wget do not exist. Commands that change app state',
      'require the user to confirm, and they may decline.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'The command line to run, e.g. `grep -ril "budget" /chats`',
        },
      },
      required: ['command'],
    },

    async execute(input, context) {
      const command = String(input.command ?? '').trim();
      if (!command) return { output: 'No command was provided.', isError: true };

      shell ??= new ChatterangShell({
        stores: liveStores(),
        actor: 'model',
        confirm: options.confirm,
        /*
         * THE MODEL'S SHELL GETS THE GRANTED FOLDERS TOO (#246), and it did
         * not until this line existed.
         *
         * #246's argument for doing the mount before the CLI work is one
         * sentence — "it is a shell feature, not a CLI one; the app's own
         * `bash` tool gets it, and any model does" — and this file was not in
         * the pull request that made the claim. Only the human Shell sheet was
         * wired, so `ls /mnt` exited 2 here while `mount list` read the
         * process-wide grant registry and named the user's real folder.
         *
         * A getter, not a snapshot, for the reason `ShellSheet` uses one: this
         * shell is built once and cached for the life of the app, so a folder
         * granted or withdrawn later has to be seen. The shell re-reads it
         * before every command.
         */
        mounts: shellMounts,
        realFs: mountHostPort,
      });

      // Re-project app state so the model sees the conversation it is in.
      await shell.mount().catch(() => undefined);
      const result = await shell.exec(command, context.signal);

      const body = [result.stdout, result.stderr].filter((part) => part.trim()).join('\n').trim();

      return {
        // The exit code is part of the answer: a model that cannot tell
        // success from failure will confidently report the failure as a result.
        output: body || (result.exitCode === 0 ? '(no output)' : `exited ${result.exitCode}`),
        isError: result.exitCode !== 0,
        display: body ? { kind: 'text', value: body } : undefined,
      };
    },
  };
}
