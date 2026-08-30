// @vitest-environment node
//
// jsdom installs its own realm, so a `Uint8Array` created by Node fails
// `instanceof Uint8Array` inside it — which breaks `just-bash`'s type dispatch
// when it writes its default filesystem layout. The shell is platform-agnostic
// logic with no DOM dependency, and in the app it runs in a real browser where
// there is only one realm, so the node environment is the representative one.
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ChatterangShell, bundledCommandNames, type ShellStores } from '@/shell';
import { chatterangCommands, renderTranscript, table } from '@/shell/commands';
import { buildVfs, slug } from '@/shell/vfs';

/**
 * The shell is a sandbox with a model on the other end of it, so the tests
 * that matter are the ones about what it *cannot* do: reach the network, run
 * a state-changing command on the model's say-so, or expose a credential.
 */

function stores(overrides: Partial<ShellStores> = {}): ShellStores {
  const install = vi.fn(async () => undefined);
  const remove = vi.fn(async () => undefined);
  const setActive = vi.fn(async () => undefined);
  const toggle = vi.fn(async () => undefined);

  const base: ShellStores = {
    models: () => ({
      activeModelId: 'qwen',
      install,
      remove,
      setActive,
      installed: {
        qwen: {
          id: 'qwen',
          state: 'installed',
          downloadedBytes: 2_497_281_120,
          useCount: 7,
          manifest: {
            name: 'Qwen3 4B Instruct',
            quantization: 'Q4_K_M',
            capabilities: ['text', 'tools'],
            contextLength: 32768,
            sizeBytes: 2_497_281_120,
            engine: 'llama-cpp',
            license: 'Apache-2.0',
          },
        },
      },
    }),
    catalog: () => [
      { id: 'qwen', name: 'Qwen3 4B Instruct', sizeBytes: 2_497_281_120, capabilities: ['text'] },
      {
        id: 'gemma-vision',
        name: 'Gemma 3 4B',
        sizeBytes: 3_341_008_960,
        capabilities: ['text', 'vision'],
        bestFor: 'Questions about photos',
      },
    ],
    chats: () => ({
      activeChatId: 'chat_1',
      list: [
        { id: 'chat_1', title: 'Quantisation notes', messageCount: 2, updatedAt: 0, mode: 'chat' },
        { id: 'chat_2', title: 'Lighthouse story', messageCount: 1, updatedAt: 0, mode: 'chat' },
      ],
      messagesFor: async (chatId) =>
        chatId === 'chat_1'
          ? [
              { role: 'user', content: 'What does quantisation do?', createdAt: 0 },
              {
                role: 'assistant',
                content: 'It trades a little accuracy for a lot of memory.',
                createdAt: 1,
                provenance: { modelName: 'Qwen3 4B', local: true },
              },
            ]
          : [{ role: 'user', content: 'Tell me about the keeper', createdAt: 0 }],
      open: async () => undefined,
      create: async () => 'chat_new',
    }),
    personas: () => [
      { id: 'p1', name: 'Chatterang', kind: 'assistant', tagline: 'A plain assistant', builtin: true },
    ],
    providers: () => ({
      toggle,
      list: [{ id: 'conn_1', label: 'OpenAI', enabled: false, defaultModel: 'gpt-4o-mini' }],
    }),
    device: () => ({
      chipset: 'Apple A18 Pro',
      totalMemory: 8 * 1024 ** 3,
      cpuCores: 6,
      backends: ['cpu', 'gpu-metal'],
      simulated: false,
      engineVersion: 'llama.cpp b4321',
    }),
    benchmarks: () => [
      { modelName: 'Qwen3 4B', generateTokensPerSecond: 28.4, backend: 'gpu-metal', createdAt: 0 },
    ],
    runBenchmark: vi.fn(async () => undefined),
  };

  return { ...base, ...overrides };
}

function shell(actor: 'user' | 'model', confirm = vi.fn(async () => true)): ChatterangShell {
  return new ChatterangShell({ stores: stores(), actor, confirm });
}

/* ── Security: what the shell must not be able to do ─────────────────── */

describe('sandbox boundaries', () => {
  it('does not provide curl — network access is not registered', async () => {
    const names = await bundledCommandNames();
    // `just-bash` ships curl as opt-in. Registering it would complete the
    // filesystem + model + network triangle this app exists to avoid.
    expect(names).not.toContain('curl');

    const result = await shell('user').exec('curl https://example.com');
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/not found/i);
  });

  it('never mounts provider API keys', async () => {
    const files = await buildVfs(stores());
    const dump = JSON.stringify(files);
    // A model with filesystem access must not be one `cat` away from a credential.
    expect(dump).not.toMatch(/apiKey|api_key|sk-|Bearer/i);
  });

  it('mounts only app data, nothing resembling a device path', async () => {
    const paths = Object.keys(await buildVfs(stores()));
    for (const path of paths) {
      expect(path).toMatch(/^\/(workspace|chats|models|personas|README\.md|device\.json)/);
    }
  });

  it('reports the sandbox honestly in its own help', async () => {
    const result = await shell('user').exec('chatterang');
    expect(result.stdout).toContain('sandbox, not your device');
    expect(result.stdout).toContain('Network access is not available');
  });
});

describe('the confirmation gate', () => {
  it('asks before the MODEL changes state', async () => {
    const confirm = vi.fn(async () => true);
    const result = await shell('model', confirm).exec('model use qwen');

    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('switch the active model'));
    expect(result.exitCode).toBe(0);
  });

  it('refuses when the user declines the model’s request', async () => {
    const confirm = vi.fn(async () => false);
    const result = await shell('model', confirm).exec('model remove qwen');

    expect(result.exitCode).toBe(130);
    expect(result.stderr).toContain('cancelled');
  });

  it('does NOT interrupt a person for a local state change they typed themselves', async () => {
    const confirm = vi.fn(async () => true);
    const result = await shell('user', confirm).exec('model use qwen');

    expect(confirm).not.toHaveBeenCalled();
    expect(result.exitCode).toBe(0);
  });

  it('asks even a person before anything leaves the device', async () => {
    const confirm = vi.fn(async () => true);
    await shell('user', confirm).exec('model install gemma-vision');
    // `model` is marked `network` because installing downloads from Hugging Face.
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('Hugging Face'));
  });

  it('asks before enabling a provider, and says what that means', async () => {
    const confirm = vi.fn(async () => true);
    await shell('model', confirm).exec('provider enable conn_1');
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('leave this device'));
  });
});

/* ── The commands themselves ─────────────────────────────────────────── */

describe('chatterang commands', () => {
  let sh: ChatterangShell;
  beforeEach(() => {
    sh = shell('user');
  });

  it('lists installed models and marks the active one', async () => {
    const result = await sh.exec('model list');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Qwen3 4B Instruct');
    expect(result.stdout).toContain('← active');
  });

  it('lists the catalog with --all', async () => {
    const result = await sh.exec('model list --all');
    expect(result.stdout).toContain('gemma-vision');
    expect(result.stdout).toContain('available');
  });

  it('reports a useful error for an unknown model', async () => {
    const result = await sh.exec('model info nope');
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('nope');
  });

  it('reports usage for an unknown subcommand', async () => {
    const result = await sh.exec('model frobnicate');
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('usage:');
  });

  it('exports a conversation as Markdown with provenance intact', async () => {
    const result = await sh.exec('chat export chat_1');
    expect(result.stdout).toContain('# Quantisation notes');
    expect(result.stdout).toContain('(on device)');
    expect(result.stdout).toContain('trades a little accuracy');
  });

  it('answers what leaves the device', async () => {
    const result = await sh.exec('privacy');
    expect(result.stdout).toContain('no remote providers are enabled');
    expect(result.stdout).toContain('Stays on this device');
  });

  it('reports device capability', async () => {
    const result = await sh.exec('device');
    expect(result.stdout).toContain('Apple A18 Pro');
    expect(result.stdout).toContain('gpu-metal');
  });
});

/* ── The point of the whole thing: composition ───────────────────────── */

describe('composition with the bundled Unix tools', () => {
  it('pipes an app command into grep', async () => {
    const result = await shell('user').exec('model list --all | grep vision');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('gemma-vision');
    expect(result.stdout).not.toContain('Qwen3');
  });

  it('searches every conversation body — which the chat list cannot do', async () => {
    const result = await shell('user').exec('grep -ril "quantisation" /chats');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('quantisation-notes.md');
    expect(result.stdout).not.toContain('lighthouse');
  });

  it('reads mounted model manifests with jq', async () => {
    const result = await shell('user').exec('jq -r ".capabilities[]" /models/qwen.json');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('tools');
  });

  it('supports redirection into the writable workspace', async () => {
    const sh = shell('user');
    const write = await sh.exec('model list > /workspace/models.txt');
    expect(write.exitCode).toBe(0);
    const read = await sh.exec('cat /workspace/models.txt');
    expect(read.stdout).toContain('Qwen3 4B Instruct');
  });

  it('chains with && so failures stop the pipeline', async () => {
    const result = await shell('user').exec('model info nope && echo SHOULD-NOT-APPEAR');
    expect(result.stdout).not.toContain('SHOULD-NOT-APPEAR');
  });

  it('reports a non-zero exit code for an unknown command', async () => {
    const result = await shell('user').exec('definitelynotacommand');
    expect(result.exitCode).not.toBe(0);
  });
});

/* ── Helpers ─────────────────────────────────────────────────────────── */

describe('vfs', () => {
  it('slugs titles into predictable filenames', () => {
    expect(slug('Quantisation notes!', 'x')).toBe('quantisation-notes');
    expect(slug('   ', 'fallback')).toBe('fallback');
    expect(slug('a'.repeat(80), 'x').length).toBeLessThanOrEqual(48);
  });

  it('disambiguates chats that share a title', async () => {
    const duplicated = stores({
      chats: () => ({
        activeChatId: null,
        list: [
          { id: 'chat_aaaaaa', title: 'Same', messageCount: 0, updatedAt: 0, mode: 'chat' },
          { id: 'chat_bbbbbb', title: 'Same', messageCount: 0, updatedAt: 0, mode: 'chat' },
        ],
        messagesFor: async () => [],
        open: async () => undefined,
        create: async () => 'x',
      }),
    });

    const paths = Object.keys(await buildVfs(duplicated)).filter((p) => p.startsWith('/chats/'));
    expect(paths).toHaveLength(2);
    expect(new Set(paths).size).toBe(2);
  });

  it('survives a conversation that cannot be read', async () => {
    const broken = stores({
      chats: () => ({
        activeChatId: null,
        list: [{ id: 'c', title: 'Broken', messageCount: 1, updatedAt: 0, mode: 'chat' }],
        messagesFor: async () => {
          throw new Error('db is gone');
        },
        open: async () => undefined,
        create: async () => 'x',
      }),
    });

    const files = await buildVfs(broken);
    expect(files['/chats/broken.md']).toContain('could not be read');
  });
});

describe('table', () => {
  it('aligns columns and trims the trailing one', () => {
    const output = table([
      ['a', 'bbb'],
      ['cccc', 'd'],
    ]);
    expect(output.split('\n')[0]).toBe('a     bbb');
    expect(output.split('\n')[1]).toBe('cccc  d');
  });

  it('is empty for no rows', () => {
    expect(table([])).toBe('');
  });
});

describe('renderTranscript', () => {
  it('marks remote turns distinctly from local ones', () => {
    const output = renderTranscript({ title: 'T', updatedAt: 0 }, [
      { role: 'user', content: 'q', createdAt: 0 },
      {
        role: 'assistant',
        content: 'a',
        createdAt: 1,
        provenance: { modelName: 'GPT', local: false },
      },
    ]);
    expect(output).toContain('## GPT (remote)');
  });
});

describe('command registry', () => {
  it('marks every state-changing command as mutating', () => {
    const commands = chatterangCommands(stores());
    for (const name of ['model', 'chat', 'provider', 'bench']) {
      expect(commands.find((c) => c.name === name)?.mutating).toBe(true);
    }
  });

  it('leaves read-only commands ungated', () => {
    const commands = chatterangCommands(stores());
    expect(commands.find((c) => c.name === 'persona')?.mutating).toBeFalsy();
    expect(commands.find((c) => c.name === 'privacy')?.mutating).toBeFalsy();
  });
});
