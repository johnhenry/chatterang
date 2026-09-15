// @vitest-environment node
//
// The node environment for the reason `tests/shell.test.ts` gives: jsdom's
// realm breaks `just-bash`'s `instanceof Uint8Array` dispatch, and the shell
// runs in a single-realm renderer in the app.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { toolRegistry, type ChatterangTool, type ToolResult } from '@/ai/tools/registry';
import { ChatterangShell } from '@/shell';
import { registerShellTool } from '@/shell/register';
import { liveStores } from '@/shell/stores';
import { useApp } from '@/state/app';
import { useModels } from '@/state/models';

/**
 * STOP TAKES THE BASH SHEET DOWN TOO (#293 item 4, refs #92 and #170).
 *
 * `requestApproval` already dismisses a sheet when the turn that asked for it
 * is stopped, and the tool-output and MCP sheets hand it the turn's signal.
 * The bash tool's confirm did not: `register.ts` called
 * `requestApproval(action)` with no signal, `BashToolOptions.confirm` had no
 * parameter to carry one, and `ChatterangShell#invoke` never read the signal
 * `just-bash` hands every custom command. So a model-driven `model remove`
 * left its sheet on screen after Stop, the tool call could not end until
 * someone answered it, and a yes given to that orphaned question deleted the
 * model for a turn that no longer existed.
 *
 * Everything below is driven through the seams the app uses: the tool is the
 * one `registerShellTool` puts in the registry, the sheet is the real `useApp`
 * approval queue, and the mutation is the real `useModels.remove` replaced by
 * a spy. Nothing is mocked between the signal and the sheet.
 */

const INSTALLED = {
  qwen: installed('qwen', 'Qwen3 4B Instruct'),
  gemma: installed('gemma', 'Gemma 3 4B'),
};

function installed(id: string, name: string) {
  return {
    id,
    state: 'installed',
    downloadedBytes: 1_000,
    useCount: 0,
    manifest: {
      id,
      name,
      quantization: 'Q4_K_M',
      capabilities: ['text'],
      contextLength: 4096,
      sizeBytes: 1_000,
      engine: 'llama-cpp',
      license: 'Apache-2.0',
    },
  };
}

const remove = vi.fn(async (_modelId: string) => undefined);
let tool: ChatterangTool;

function run(command: string, signal?: AbortSignal): Promise<ToolResult> {
  return tool.execute({ command }, { signal, now: () => new Date(0) });
}

/** Real-time poll, for the parts that load a module or build a filesystem. */
async function until(predicate: () => boolean, what: string, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** A promise that rejects instead of hanging the file, so a red test stays red rather than stalled. */
function bounded<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${what} never settled`)), ms)),
  ]);
}

const sheets = () => useApp.getState().approvals;

describe('Stop and the bash tool’s confirm sheet', () => {
  beforeAll(() => {
    registerShellTool();
    const registered = toolRegistry.get('bash');
    if (!registered) throw new Error('registerShellTool did not register bash');
    tool = registered;
  });

  beforeEach(() => {
    remove.mockClear();
    useApp.setState({ approvals: [] });
    useModels.setState({ installed: INSTALLED as never, activeModelId: null, remove });
  });

  afterEach(() => {
    vi.useRealTimers();
    // Do not let a sheet a red test left behind answer into the next test.
    for (const sheet of sheets()) useApp.getState().answerApproval(sheet.id, false);
  });

  it('takes the sheet down within one microtask of Stop', async () => {
    const stop = new AbortController();
    const call = run('model remove qwen', stop.signal);
    await until(() => sheets().length === 1, 'the delete sheet');
    expect(sheets()[0]!.action).toBe('delete qwen from this device');

    stop.abort();
    await Promise.resolve();

    expect(sheets(), 'a stopped turn’s sheet is still on screen').toEqual([]);
    await bounded(call, 2_000, 'the stopped call').catch(() => undefined);
  });

  it('ends the tool call within 100 ms of fake time after Stop, refused', async () => {
    const stop = new AbortController();
    const call = run('model remove qwen', stop.signal);
    await until(() => sheets().length === 1, 'the delete sheet');

    // Fake time only from here: the shell is already started, so nothing
    // below waits on a module load or a filesystem build.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    let settled: ToolResult | undefined;
    void call.then((result) => {
      settled = result;
    });

    stop.abort();
    await vi.advanceTimersByTimeAsync(100);

    expect(settled, 'the tool call is still waiting on a sheet nobody can answer').toBeDefined();
    expect(settled!.isError).toBe(true);
    expect(remove).not.toHaveBeenCalled();
  });

  it('runs nothing when the removed sheet is answered yes afterwards', async () => {
    const stop = new AbortController();
    const call = run('model remove qwen', stop.signal);
    await until(() => sheets().length === 1, 'the delete sheet');
    const sheet = sheets()[0]!;

    stop.abort();
    await Promise.resolve();
    // Both ways a late yes could arrive: the sheet's own resolver, held by a
    // component that rendered it, and the store's answer by id.
    sheet.resolve(true);
    useApp.getState().answerApproval(sheet.id, true);

    const result = await bounded(call, 2_000, 'the stopped call');
    expect(remove, 'a yes to a stopped turn deleted the model').not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
  });

  it('takes down only the stopped call’s sheet when two calls share the cached shell', async () => {
    // The model's shell is built once and cached for the life of the app, so
    // a signal kept on the instance would be the most recent call's, not the
    // one that asked.
    const first = new AbortController();
    const second = new AbortController();
    const removingQwen = run('model remove qwen', first.signal);
    const removingGemma = run('model remove gemma', second.signal);
    await until(() => sheets().length === 2, 'both delete sheets');

    first.abort();
    await Promise.resolve();

    expect(sheets().map((sheet) => sheet.action)).toEqual(['delete gemma from this device']);

    useApp.getState().answerApproval(sheets()[0]!.id, true);
    const [stopped, answered] = await bounded(
      Promise.all([removingQwen, removingGemma]),
      2_000,
      'the two calls',
    );
    expect(stopped.isError).toBe(true);
    expect(answered.output).toBe('removed gemma');
    expect(remove).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledWith('gemma');
  });

  it('hands the model shell’s confirm the signal of the command that asked', async () => {
    // One layer down from the registry: the shell itself, so a dropped
    // signal in `#start` or `#invoke` is named here rather than only
    // observed as a sheet that stayed up.
    //
    // Not an identity check: `just-bash` gives a command a signal DERIVED from
    // the one handed to `exec` (it aborts with it, and again when the command
    // line ends), so what matters is that Stop reaches the confirm.
    let seen: AbortSignal | undefined;
    let abortedWhenAsked: boolean | undefined;
    const confirm = vi.fn(
      (_action: string, signal?: AbortSignal) =>
        new Promise<boolean>((resolve) => {
          seen = signal;
          abortedWhenAsked = signal?.aborted;
          signal?.addEventListener('abort', () => resolve(false), { once: true });
        }),
    );
    const shell = new ChatterangShell({ stores: liveStores(), actor: 'model', confirm });
    const stop = new AbortController();

    const running = shell.exec('model remove qwen', stop.signal);
    await until(() => confirm.mock.calls.length === 1, 'the confirm');

    expect(seen, 'the confirm was asked with no signal').toBeDefined();
    expect(abortedWhenAsked).toBe(false);

    stop.abort();
    const result = await bounded(running, 2_000, 'the stopped exec');

    expect(seen!.aborted, 'Stop did not reach the confirm').toBe(true);
    // just-bash reports a command line stopped mid-command as 124, not the
    // command's own 130; either way it did not succeed.
    expect(result.exitCode).not.toBe(0);
    expect(remove).not.toHaveBeenCalled();
  });

  describe('controls — these hold on main as well', () => {
    it('runs the removal once when the sheet is answered yes and nobody stops', async () => {
      const call = run('model remove qwen', new AbortController().signal);
      await until(() => sheets().length === 1, 'the delete sheet');

      useApp.getState().answerApproval(sheets()[0]!.id, true);

      const result = await bounded(call, 2_000, 'the answered call');
      expect(result.output).toBe('removed qwen');
      expect(result.isError).toBe(false);
      expect(remove).toHaveBeenCalledTimes(1);
      expect(remove).toHaveBeenCalledWith('qwen');
    });

    it('still waives the confirm for a person typing a local change', async () => {
      const confirm = vi.fn(async () => false);
      const shell = new ChatterangShell({ stores: liveStores(), actor: 'user', confirm });

      const result = await shell.exec('model remove qwen', new AbortController().signal);

      expect(result.stdout).toContain('removed qwen');
      expect(confirm).not.toHaveBeenCalled();
      expect(remove).toHaveBeenCalledWith('qwen');
    });
  });
});
