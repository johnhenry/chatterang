/**
 * Image generation state (PRD §3.4).
 *
 * The diffusion pipeline runs in its own ONNX session, and that session is
 * released the moment generation finishes. Holding a diffusion pipeline
 * resident alongside a loaded language model is the fastest way to get an
 * out-of-memory kill on a mid-range phone (PRD §6).
 */

import { create } from 'zustand';

import { db, type GeneratedImage } from '@/db';
import { OnnxRuntime } from '@/plugins/onnx-runtime';
import { newId } from '@/domain/chat';
import { IMAGE_GEN_RAM_FLOOR } from '@/data/catalog';
import { ensureSession, releaseSessions } from '@/lib/voice';
import { useApp } from '@/state/app';
import { useModels } from '@/state/models';

export interface DiffusionProgress {
  step: number;
  totalSteps: number;
  preview?: string;
}

interface ImageState {
  images: GeneratedImage[];
  generating: boolean;
  progress: DiffusionProgress | null;
  requestId: string | null;

  load: () => Promise<void>;
  generate: (options: {
    prompt: string;
    negativePrompt?: string;
    steps?: number;
    guidanceScale?: number;
    size?: number;
    seed?: number | null;
    modelId: string;
  }) => Promise<void>;
  cancel: () => void;
  remove: (id: string) => Promise<void>;
}

export const useImages = create<ImageState>((set, get) => ({
  images: [],
  generating: false,
  progress: null,
  requestId: null,

  async load() {
    set({ images: await db.images.orderBy('createdAt').reverse().toArray() });
  },

  async generate(options) {
    if (get().generating) return;

    const app = useApp.getState();
    const models = useModels.getState();

    const totalMemory = app.device?.totalMemory ?? 0;
    if (totalMemory > 0 && totalMemory < IMAGE_GEN_RAM_FLOOR) {
      app.toast(
        'This device does not have enough memory to generate images safely.',
        'warn',
      );
      return;
    }

    const record = models.installed[options.modelId];
    if (!record || record.state !== 'installed') {
      app.toast('Install an image model first.', 'warn');
      return;
    }

    const modelPath = record.paths.model;
    if (!modelPath) {
      app.toast('That model’s files are missing.', 'crit');
      return;
    }

    const requestId = newId('img');
    set({ generating: true, progress: { step: 0, totalSteps: options.steps ?? 4 }, requestId });
    app.setActivity('running');

    const listener = await OnnxRuntime.addListener('onnxProgress', (event) => {
      if (event.requestId !== requestId) return;
      set({
        progress: { step: event.step, totalSteps: event.totalSteps, preview: event.preview },
      });
    });

    try {
      const session = await ensureSession('diffusion', modelPath, record.paths);

      const result = await OnnxRuntime.diffuse({
        handle: session.handle,
        prompt: options.prompt,
        negativePrompt: options.negativePrompt,
        steps: options.steps ?? 4,
        guidanceScale: options.guidanceScale ?? 1,
        width: options.size ?? 512,
        height: options.size ?? 512,
        seed: options.seed ?? null,
        requestId,
      });

      const image: GeneratedImage = {
        id: newId('image'),
        prompt: options.prompt,
        negativePrompt: options.negativePrompt ?? '',
        data: result.image,
        mediaType: result.mediaType,
        width: result.width,
        height: result.height,
        steps: result.steps,
        seed: result.seed,
        modelId: options.modelId,
        durationMs: result.durationMs,
        createdAt: Date.now(),
      };

      await db.images.put(image);
      set({ images: [image, ...get().images] });
    } catch (error) {
      app.toast(error instanceof Error ? error.message : 'Image generation failed.', 'crit');
    } finally {
      await listener.remove().catch(() => undefined);
      // Free the pipeline immediately rather than waiting for pressure.
      await releaseSessions('diffusion').catch(() => undefined);
      set({ generating: false, progress: null, requestId: null });
      app.setActivity('idle');
    }
  },

  cancel() {
    const requestId = get().requestId;
    if (requestId) void OnnxRuntime.cancel({ requestId });
  },

  async remove(id) {
    await db.images.delete(id);
    set({ images: get().images.filter((image) => image.id !== id) });
  },
}));
