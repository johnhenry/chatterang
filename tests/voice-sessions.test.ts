/**
 * THE SESSIONS `src/` OPENED AND NEVER GAVE BACK.
 *
 * `OnnxRuntime.createSession` opens native graphs in the inference host — 79 MB
 * of Whisper encoder and 199 MB of decoder for whisper-base, and diffusion is
 * larger. They stay open until something names their handle. `releaseSessions`
 * existed for exactly one caller: `src/state/images.ts` frees `diffusion` in a
 * `finally` after every image. NOTHING in `src/` released `stt`.
 *
 * So the first tap of the microphone made a quarter of a gigabyte resident for
 * the rest of the app's life, and switching speech models made it two — the
 * cache is keyed by `task:modelPath`, so a second path was a second entry and
 * the first was stranded with no code path left that could name it.
 *
 * Neither was visible anywhere: no test covered `src/lib/voice.ts`'s session
 * map at all, and both leaks are silent by construction. The app keeps
 * working. It just never gives the memory back.
 *
 * This file drives the REAL `ensureSession`/`releaseSessions` against a fake
 * plugin, and mounts the REAL `Composer` to check that the release is actually
 * wired to something that happens. Correct code in `src/` that nothing calls
 * is a shape this repo has shipped before.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** Every call the plugin layer received, in order. */
interface PluginLog {
  readonly calls: { method: string; args: unknown }[];
  reset(): void;
}

const log: PluginLog = {
  calls: [],
  reset() {
    log.calls.length = 0;
  },
};

let handleCounter = 0;

vi.mock('@/plugins/onnx-runtime', () => ({
  OnnxRuntime: {
    createSession: async (options: { task: string; modelPath: string }) => {
      log.calls.push({ method: 'createSession', args: options });
      handleCounter += 1;
      return {
        handle: `sess-${handleCounter}`,
        task: options.task,
        provider: 'cpu',
        warnings: [],
      };
    },
    releaseSession: async (options: unknown) => {
      log.calls.push({ method: 'releaseSession', args: options });
    },
    releaseTask: async (options: unknown) => {
      log.calls.push({ method: 'releaseTask', args: options });
    },
    transcribe: async () => ({ text: '', language: 'en', durationMs: 0, segments: [] }),
    cancel: async () => undefined,
    addListener: async () => ({ remove: async () => undefined }),
  },
}));

const methods = (): string[] => log.calls.map((call) => call.method);

beforeEach(() => {
  log.reset();
  handleCounter = 0;
  vi.resetModules();
});

describe('one session per task, not one per path ever opened', () => {
  it('opens once and reuses it — the control for every release below', async () => {
    // If `ensureSession` opened a fresh session every time, the "released
    // exactly once" assertions below would all pass for the wrong reason.
    const { ensureSession } = await import('@/lib/voice');
    const first = await ensureSession('stt', '/models/whisper-base');
    const second = await ensureSession('stt', '/models/whisper-base');

    expect(second).toBe(first);
    expect(methods()).toEqual(['createSession']);
  });

  it('releases the previous speech model BEFORE opening the next one', async () => {
    /*
     * THE STRANDING. FAULT INJECTED: deleting the eviction from
     * `ensureSession` —
     *
     *   if ([...sessions.keys()].some((open) => open.startsWith(`${task}:`))) {
     *     await releaseSessions(task);
     *   }
     *
     * — fails this at `methods()` (`['createSession', 'createSession']` for
     * the three-call sequence). That deletion is otherwise invisible: both
     * sessions work, the app behaves identically, and the first model's two
     * native graphs simply never come back.
     *
     * BEFORE rather than after, and the ORDER is asserted: holding two Whisper
     * pipelines at once is the double occupancy this exists to avoid, and on
     * this engine that is hundreds of megabytes.
     */
    const { ensureSession } = await import('@/lib/voice');
    await ensureSession('stt', '/models/whisper-base');
    log.reset();

    await ensureSession('stt', '/models/whisper-small');

    expect(methods()).toEqual(['releaseTask', 'createSession']);
    expect(log.calls[0]?.args).toEqual({ task: 'stt' });
    expect(log.calls[1]?.args).toMatchObject({ modelPath: '/models/whisper-small' });
  });

  it('does not evict a different task, which is a different pipeline entirely', async () => {
    // The mirror. `releaseTask` frees every session of a task in the host, so
    // an eviction that ignored the task name would unload the diffusion
    // pipeline the moment the user touched the microphone.
    const { ensureSession } = await import('@/lib/voice');
    await ensureSession('diffusion', '/models/sd-turbo');
    log.reset();

    await ensureSession('stt', '/models/whisper-base');
    expect(methods()).toEqual(['createSession']);

    // …and the diffusion session is still the same object, not reopened.
    log.reset();
    await ensureSession('diffusion', '/models/sd-turbo');
    expect(methods()).toEqual([]);
  });

  it('forgets a task it released, so the next call really opens a session', async () => {
    // A map that kept the entry would hand back a handle the host has already
    // freed — every later transcription failing against a dead session, which
    // is worse than the leak.
    const { ensureSession, releaseSessions } = await import('@/lib/voice');
    await ensureSession('stt', '/models/whisper-base');
    await releaseSessions('stt');
    log.reset();

    await ensureSession('stt', '/models/whisper-base');
    expect(methods()).toEqual(['createSession']);
  });

  it('releases only the named task', async () => {
    const { ensureSession, releaseSessions } = await import('@/lib/voice');
    await ensureSession('stt', '/models/whisper-base');
    await ensureSession('diffusion', '/models/sd-turbo');
    log.reset();

    await releaseSessions('stt');
    expect(log.calls).toEqual([{ method: 'releaseTask', args: { task: 'stt' } }]);

    // The diffusion session survived: asking for it again opens nothing.
    log.reset();
    await ensureSession('diffusion', '/models/sd-turbo');
    expect(methods()).toEqual([]);
  });

  it('clears the map even when the host refuses the release', async () => {
    // A handle whose release rejected is not worth retrying — the host is the
    // only thing that can still name it — and keeping it would make the next
    // `ensureSession` hand back a session that may already be gone.
    const { ensureSession, releaseSessions } = await import('@/lib/voice');
    const { OnnxRuntime } = await import('@/plugins/onnx-runtime');
    await ensureSession('stt', '/models/whisper-base');

    const releaseTask = OnnxRuntime.releaseTask;
    (OnnxRuntime as { releaseTask: unknown }).releaseTask = async (): Promise<void> => {
      throw new Error('the host went away');
    };
    await expect(releaseSessions('stt')).rejects.toThrow(/went away/);
    (OnnxRuntime as { releaseTask: unknown }).releaseTask = releaseTask;

    log.reset();
    await ensureSession('stt', '/models/whisper-base');
    expect(methods()).toEqual(['createSession']);
  });
});

/* ── And something has to CALL it ─────────────────────────────────────── */

describe('the Composer gives the speech model back when it goes away', () => {
  let container: HTMLDivElement | null = null;

  afterEach(() => {
    container?.remove();
    container = null;
  });

  it('releases the stt task on unmount, and stops the turn first', async () => {
    /*
     * THE OTHER HALF, AND THE ONE THAT MAKES THE FIRST HALF MATTER. A correct
     * `releaseSessions` that nothing invokes is the exact shape this repo has
     * shipped before — right code in `src/`, dead in the running app.
     *
     * The unmount is a REAL event: `App.tsx` renders
     * `{tab === 'chat' ? <ChatScreen /> : null}`, so every switch to Models,
     * Personas, Studio or Settings unmounts this component. That is why the
     * release is here rather than in `startDictation`'s `finally`, which would
     * throw away the warm model between two sentences.
     *
     * FAULT INJECTED: deleting the cleanup `useEffect` from `Composer.tsx`
     * fails this at `methods()` (`[]` for `['releaseTask']`). Nothing else in
     * the suite notices — there was no test of this component at all.
     *
     * The REAL component is mounted, not a copy of its effect. An assertion
     * against a restatement of the cleanup would pass whatever `Composer.tsx`
     * actually does.
     */
    const { act, createElement } = await import('react');
    const { createRoot } = await import('react-dom/client');
    const { Composer } = await import('@/features/chat/Composer');
    const { ensureSession } = await import('@/lib/voice');

    // A session the window owns, exactly as `toggleDictation` would open it.
    await ensureSession('stt', '/models/whisper-base');
    log.reset();

    container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      // `createElement`, not `Composer(props)`: calling the function directly
      // runs its hooks outside the renderer, which is a different thing that
      // happens to look like rendering and never fires an effect cleanup.
      root.render(
        createElement(Composer, {
          disabled: false,
          generating: false,
          acceptsImages: false,
          placeholder: 'Message',
          onSend: () => undefined,
          onStop: () => undefined,
        }),
      );
    });
    // CONTROL: mounting opens nothing. If it did, the release below would be
    // freeing something this test created rather than something a user did.
    expect(methods()).toEqual([]);

    await act(async () => {
      root.unmount();
    });

    expect(methods()).toEqual(['releaseTask']);
    expect(log.calls[0]?.args).toEqual({ task: 'stt' });
  });
});
