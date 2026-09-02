/**
 * Installed-model state: the catalog, downloads, per-model sampler settings,
 * and the storage accounting the Models screen shows.
 */

import { create } from 'zustand';

import { db, type InstalledModel, type InstallState } from '@/db';
import { CATALOG } from '@/data/catalog';
import {
  DEFAULT_SAMPLER,
  canBenchmark,
  canChat,
  nonChatRole,
  type Capability,
  type ModelManifest,
  type SamplerSettings,
} from '@/domain/manifest';
import {
  DownloadCancelled,
  deleteModelFiles,
  downloadModel,
  storageEstimate,
  type DownloadProgress,
} from '@/lib/download';
import { installResolver, useApp } from '@/state/app';

interface ModelState {
  loaded: boolean;
  installed: Record<string, InstalledModel>;
  progress: Record<string, DownloadProgress>;
  storage: { used: number; quota: number };
  /** Model the user has selected for new chats. */
  activeModelId: string | null;

  load: () => Promise<void>;
  install: (manifest: ModelManifest) => Promise<void>;
  cancelInstall: (modelId: string) => void;
  remove: (modelId: string) => Promise<void>;
  setActive: (modelId: string | null) => Promise<void>;
  saveSampler: (modelId: string, sampler: Partial<SamplerSettings>) => Promise<void>;
  saveSystemPrompt: (modelId: string, prompt: string) => Promise<void>;
  noteUse: (modelId: string) => Promise<void>;
  refreshStorage: () => Promise<void>;
}

const controllers = new Map<string, AbortController>();

export const useModels = create<ModelState>((set, get) => ({
  loaded: false,
  installed: {},
  progress: {},
  storage: { used: 0, quota: 0 },
  activeModelId: null,

  async load() {
    const rows = await db.models.toArray();
    const installed: Record<string, InstalledModel> = {};
    for (const row of rows) installed[row.id] = row;

    const stored =
      (await db.settings.get('activeModelId'))?.value as string | undefined ?? null;

    // A build before the selection rule existed could persist a speech model
    // here, and this read puts it straight back into service without passing
    // `setActive`. Drop it rather than carry somebody's broken chat across an
    // upgrade; an unknown id is left alone, since it is only a model that has
    // not been re-installed yet — `install()` re-runs this check when it comes
    // back, which is the half this read cannot cover.
    const storedManifest = stored ? installed[stored]?.manifest : undefined;
    const activeModelId = storedManifest && !canChat(storedManifest) ? null : stored;

    set({
      loaded: true,
      installed,
      activeModelId,
      storage: await storageEstimate(downloadedBytes(installed)),
    });

    /*
     * AND WRITE THE DECISION DOWN.
     *
     * Rejecting the id in memory alone leaves IndexedDB holding a value the
     * app has already ruled invalid: every boot reads the speech model back,
     * re-derives the same null, and the row outlives the reasoning. Benign
     * while this store is the only reader, which is why it is easy to leave —
     * but "the database disagrees with the app about what is valid" is the
     * kind of state the next reader of that row inherits silently.
     *
     * Guarded on an actual change so the ordinary boot — a stored id that is
     * fine, or no stored id at all — does not write on every load.
     */
    if (activeModelId !== stored) {
      await db.settings.put({ key: 'activeModelId', value: activeModelId });
    }
  },

  async install(manifest) {
    const { toast, settings } = useApp.getState();

    const existing = get().installed[manifest.id];
    if (existing?.state === 'installed') return;

    const controller = new AbortController();
    controllers.set(manifest.id, controller);

    const record: InstalledModel = {
      id: manifest.id,
      manifest,
      state: 'downloading',
      downloadedBytes: 0,
      paths: {},
      sampler: { ...DEFAULT_SAMPLER, ...manifest.defaultSampler },
      systemPrompt: '',
      installedAt: null,
      lastUsedAt: null,
      useCount: 0,
    };

    await persist(record, set, get);

    try {
      const result = await downloadModel({
        manifest,
        hfToken: settings.hfToken || undefined,
        signal: controller.signal,
        onProgress: (progress) =>
          set((state) => ({ progress: { ...state.progress, [manifest.id]: progress } })),
      });

      await persist(
        {
          ...record,
          state: 'installed',
          paths: result.paths,
          downloadedBytes: result.totalBytes,
          installedAt: Date.now(),
        },
        set,
        get,
      );

      toast(`${manifest.name} is ready.`, 'good');

      /*
       * THE OTHER HALF OF `load()`'s MIGRATION.
       *
       * `load()` deliberately leaves an id it does not recognise alone, since
       * an unknown id is a model that has merely not been re-installed. That
       * is right, and it leaves a gap: the id is only unrecognised BECAUSE
       * the model was absent, so the capability check never ran. Re-install
       * that model and the record appears with the stale id already active —
       * and nothing re-checks it, because the branch below only fires when
       * there is no active model at all.
       *
       * This is the moment the manifest becomes knowable, so it is the moment
       * to judge it. Going through `setActive(null)` rather than `set` keeps
       * the persisted row in step, which is the whole point of the write in
       * `load()`.
       */
      if (get().activeModelId === manifest.id && !canChat(manifest)) {
        await get().setActive(null);
      }

      // First installed model becomes the active one, so a new user can chat
      // immediately rather than hunting for a picker.
      if (!get().activeModelId && canChat(manifest)) {
        await get().setActive(manifest.id);
      }
    } catch (error) {
      if (error instanceof DownloadCancelled) {
        /*
         * CANCEL CLEANS UP, IN THIS ORDER.
         *
         * The partial file first, the record second. `remove()` returns early
         * on `if (!record) return`, so a record deleted before its files
         * makes the directory unreachable from the UI forever — and a
         * cancelled multi-file model can already have a completed companion
         * on disk: every vision model in the catalogue has one, and the
         * cancel can land during the second file.
         *
         * This path did not run at all until the abort handling in
         * `lib/download.ts` was fixed. An aborted fetch REJECTS the pending
         * `reader.read()`; it does not return `{done:true}`, so the post-read
         * `signal.aborted` check the downloader used to rely on was
         * unreachable. Cancelling therefore fell into the `else` arm below:
         * the record was persisted `state:'failed'` and the user got a red
         * toast reading "BodyStreamBuffer was aborted".
         */
        await deleteModelFiles(manifest);
        await db.models.delete(manifest.id);
        set((state) => {
          const installed = { ...state.installed };
          delete installed[manifest.id];
          return { installed };
        });
        toast(`${manifest.name} download cancelled.`, 'info');
      } else {
        const message = error instanceof Error ? error.message : 'Download failed.';
        await persist({ ...record, state: 'failed', error: message }, set, get);
        toast(message, 'crit');
      }
    } finally {
      controllers.delete(manifest.id);
      set((state) => {
        const progress = { ...state.progress };
        delete progress[manifest.id];
        return { progress };
      });
      void get().refreshStorage();
    }
  },

  /**
   * Abort the transfer. The cleanup happens where the download unwinds.
   *
   * Deliberately not `async`: the caller is a click handler, and the work
   * that follows — deleting the partial file, dropping the record — belongs to
   * `install()`'s own unwinding, where the manifest and the record are already
   * in hand. Aborting a controller that has already been retired is a no-op.
   */
  cancelInstall(modelId) {
    controllers.get(modelId)?.abort();
  },

  async remove(modelId) {
    const record = get().installed[modelId];
    if (!record) return;

    await deleteModelFiles(record.manifest);
    await db.models.delete(modelId);

    set((state) => {
      const installed = { ...state.installed };
      delete installed[modelId];
      return { installed };
    });

    if (get().activeModelId === modelId) {
      const next = Object.values(get().installed).find(
        (entry) => entry.state === 'installed' && canChat(entry.manifest),
      );
      await get().setActive(next?.id ?? null);
    }

    useApp.getState().toast(`${record.manifest.name} removed.`, 'info');
    void get().refreshStorage();
  },

  /**
   * Choose the model for new chats.
   *
   * THE REFUSAL, AT THE POINT SOMEBODY CAN ACT ON IT. A user picked "Whisper
   * Tiny" here, sent a message, and was told `Requested backend 'onnx-runtime'
   * is not registered. Registered backends: llama-cpp` — aimatey's sentence,
   * four layers away, about a router registration table. It is true, it failed
   * closed, and it is unusable: it names neither the model they picked nor
   * anything they could do next.
   *
   * The pickers no longer offer a model that cannot chat (`chatModels` below),
   * so in the app this branch is unreachable. It is kept because `setActive`
   * also takes ids that never passed through a picker: `model use <id>` in the
   * shell types one, and `load()` reads one back from IndexedDB that an older
   * build persisted. Those are exactly the cases a rendering change cannot fix.
   */
  async setActive(modelId) {
    if (modelId) {
      const manifest = get().installed[modelId]?.manifest;
      if (manifest && !canChat(manifest)) {
        useApp
          .getState()
          .toast(
            `${manifest.name} ${nonChatRole(manifest)} — it cannot answer a chat. ` +
              `Pick a model that writes text.`,
            'warn',
          );
        return;
      }
    }

    set({ activeModelId: modelId });
    await db.settings.put({ key: 'activeModelId', value: modelId });
  },

  async saveSampler(modelId, sampler) {
    const record = get().installed[modelId];
    if (!record) return;
    await persist({ ...record, sampler: { ...record.sampler, ...sampler } }, set, get);
  },

  async saveSystemPrompt(modelId, systemPrompt) {
    const record = get().installed[modelId];
    if (!record) return;
    await persist({ ...record, systemPrompt }, set, get);
  },

  async noteUse(modelId) {
    const record = get().installed[modelId];
    if (!record) return;
    await persist(
      { ...record, lastUsedAt: Date.now(), useCount: record.useCount + 1 },
      set,
      get,
    );
  },

  async refreshStorage() {
    set({ storage: await storageEstimate(downloadedBytes(get().installed)) });
  },
}));

/**
 * What this app knows it put on disk.
 *
 * The only honest "used" figure on a packaged platform: `estimate()` describes
 * the browser's storage bucket, and on iOS, Android and the desktop shell the
 * models are not in it. `@capacitor/filesystem` offers no free-space call and
 * the desktop shell refuses `stat` by name, so the records are the source.
 * Only INSTALLED models count — a failed or in-flight record has no complete
 * file behind it.
 */
function downloadedBytes(installed: Record<string, InstalledModel>): number {
  return Object.values(installed).reduce(
    (total, record) => total + (record.state === 'installed' ? record.downloadedBytes : 0),
    0,
  );
}

async function persist(
  record: InstalledModel,
  set: (partial: Partial<ModelState> | ((state: ModelState) => Partial<ModelState>)) => void,
  _get: () => ModelState,
): Promise<void> {
  await db.models.put(record);
  set((state) => ({ installed: { ...state.installed, [record.id]: record } }));
}

/* ── Selectors ──────────────────────────────────────────────────────── */

export function installedModels(state: ModelState): InstalledModel[] {
  return Object.values(state.installed)
    .filter((model) => model.state === 'installed')
    .sort((a, b) => (b.lastUsedAt ?? b.installedAt ?? 0) - (a.lastUsedAt ?? a.installedAt ?? 0));
}

export function modelsWith(state: ModelState, capability: Capability): InstalledModel[] {
  return installedModels(state).filter((model) =>
    model.manifest.capabilities.includes(capability),
  );
}

/**
 * The models that can be chosen for a chat.
 *
 * Every OTHER consumer surface already filters by what it needs — the voice
 * picker asks for `audio-out`, dictation for `audio-in`, the studio for
 * `image-out`, the draft picker for `draft`. Chat was the one surface that
 * asked for "everything installed" and then discovered four layers later that
 * it had been handed a text-to-speech voice.
 *
 * Using this instead of `installedModels` is the real fix: a model that cannot
 * answer is not refused, it is never offered, so the refusal below it is a
 * backstop rather than the user's first encounter with the rule.
 */
export function chatModels(state: ModelState): InstalledModel[] {
  return installedModels(state).filter((model) => canChat(model.manifest));
}

/**
 * The models the on-device benchmark can actually measure.
 *
 * The sibling of `chatModels`, and needed for the same reason: the benchmark
 * picker asked for "everything installed" and then handed a `.onnx` path to
 * the llama.cpp loader. Note it filters on ENGINE, not capability — see
 * `canBenchmark`; a vision model llama.cpp can load belongs in this list and a
 * text model on another runtime does not.
 */
export function benchmarkModels(state: ModelState): InstalledModel[] {
  return installedModels(state).filter((model) => canBenchmark(model.manifest));
}

export function installStateOf(state: ModelState, modelId: string): InstallState {
  return state.installed[modelId]?.state ?? 'available';
}

/** Catalog entries not yet installed, largest-first within each capability. */
export function availableCatalog(state: ModelState): ModelManifest[] {
  return CATALOG.filter((manifest) => state.installed[manifest.id]?.state !== 'installed');
}

/**
 * Wire the model store into the engine's resolver. Called once at startup so
 * the llama.cpp adapter can turn a model id into a path and sampler without
 * importing the store (which would make the adapter untestable).
 */
installResolver({
  getManifest: (id) => useModels.getState().installed[id]?.manifest ?? null,
  getPath: (id, role = 'model') => useModels.getState().installed[id]?.paths[role] ?? null,
  getSampler: (id) => useModels.getState().installed[id]?.sampler ?? DEFAULT_SAMPLER,
});
