/**
 * The `bash` tool.
 *
 * Gives the model the same shell the Shell sheet exposes — same commands,
 * same filesystem, same gate. One surface with two front doors, so anything
 * the model can do is something the user can inspect by typing it themselves.
 *
 * The gate is what makes this safe to hand a model: the shell has no network,
 * mounts nothing outside the app, and refuses every state-changing command
 * until the user confirms it in a sheet they can actually read.
 */

import type { ChatterangTool } from '@/ai/tools/registry';
import { ChatterangShell } from '@/shell';
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
      'model, chat, persona, provider, bench, device, privacy. Run `chatterang` for a summary.',
      '',
      'Filesystem: /workspace is writable scratch space; /chats holds every conversation as',
      'Markdown; /models and /personas hold JSON. Everything except /workspace is read-only —',
      'the filesystem refuses the write rather than discarding it, so do not try to record',
      'anything under /chats; it is the app\u2019s own data, not a notebook.',
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
