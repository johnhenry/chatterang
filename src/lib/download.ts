/**
 * Model download manager.
 *
 * Models are large — often gigabytes — so downloads are streamed, resumable
 * where the server allows it, and written to app-private storage. On the web
 * they go to the Origin Private File System, which gives the same
 * "sandboxed, not in the user's photo roll" property.
 */

import { Capacitor } from '@capacitor/core';
import { Directory, Filesystem } from '@capacitor/filesystem';

import type { CompanionRole, ModelManifest } from '@/domain/manifest';
import { resolveSourceUrl } from '@/domain/manifest';

export interface DownloadProgress {
  modelId: string;
  /** File currently being fetched. */
  file: string;
  receivedBytes: number;
  totalBytes: number;
  /** Bytes per second over the last window. */
  bytesPerSecond: number;
  /** Seconds remaining, or null when the total is unknown. */
  etaSeconds: number | null;
}

export interface DownloadResult {
  /** Absolute paths keyed by role: `model`, `mmproj`, `tokenizer`, … */
  paths: Record<string, string>;
  totalBytes: number;
}

export class DownloadCancelled extends Error {
  constructor() {
    super('Download cancelled.');
    this.name = 'DownloadCancelled';
  }
}

const MODEL_DIR = 'models';

function isNative(): boolean {
  return Capacitor.isNativePlatform();
}

/** Per-engine subdirectory, so eviction can reason about one engine at a time. */
function modelDirectory(manifest: ModelManifest): string {
  return `${MODEL_DIR}/${manifest.engine}/${manifest.id}`;
}

function safeName(file: string): string {
  return file.replaceAll('/', '__');
}

/* ── Web storage (OPFS) ─────────────────────────────────────────────── */

async function opfsRoot(): Promise<FileSystemDirectoryHandle> {
  const storage = navigator.storage as StorageManager & {
    getDirectory?: () => Promise<FileSystemDirectoryHandle>;
  };
  if (!storage.getDirectory) {
    throw new Error('This browser cannot store model files locally.');
  }
  return storage.getDirectory();
}

async function opfsDirectory(path: string): Promise<FileSystemDirectoryHandle> {
  let handle = await opfsRoot();
  for (const segment of path.split('/').filter(Boolean)) {
    handle = await handle.getDirectoryHandle(segment, { create: true });
  }
  return handle;
}

/* ── Public API ─────────────────────────────────────────────────────── */

export interface DownloadOptions {
  manifest: ModelManifest;
  /** Hugging Face token, required for gated repositories. */
  hfToken?: string;
  signal?: AbortSignal;
  onProgress?: (progress: DownloadProgress) => void;
}

export async function downloadModel(options: DownloadOptions): Promise<DownloadResult> {
  const { manifest } = options;
  const directory = modelDirectory(manifest);
  const paths: Record<string, string> = {};

  const files: { file: string; role: 'model' | CompanionRole }[] = [
    { file: manifest.source.file, role: 'model' },
    ...(manifest.source.companions ?? []).map((companion) => ({
      file: companion.file,
      role: companion.role,
    })),
  ];

  let totalBytes = 0;

  for (const entry of files) {
    const url = resolveSourceUrl(manifest.source, entry.file);
    const written = await fetchToStorage({
      url,
      directory,
      filename: safeName(entry.file),
      hfToken: manifest.source.gated ? options.hfToken : undefined,
      signal: options.signal,
      expectedBytes: entry.role === 'model' ? manifest.sizeBytes : 0,
      onProgress: (received, total, rate) =>
        options.onProgress?.({
          modelId: manifest.id,
          file: entry.file,
          receivedBytes: received,
          totalBytes: total,
          bytesPerSecond: rate,
          etaSeconds: total > 0 && rate > 0 ? Math.round((total - received) / rate) : null,
        }),
    });

    paths[entry.role] = written.path;
    totalBytes += written.bytes;
  }

  return { paths, totalBytes };
}

interface FetchOptions {
  url: string;
  directory: string;
  filename: string;
  hfToken?: string;
  signal?: AbortSignal;
  expectedBytes: number;
  onProgress: (received: number, total: number, bytesPerSecond: number) => void;
}

async function fetchToStorage(options: FetchOptions): Promise<{ path: string; bytes: number }> {
  const headers: Record<string, string> = {};
  if (options.hfToken) headers.Authorization = `Bearer ${options.hfToken}`;

  const response = await fetch(options.url, { headers, signal: options.signal });

  if (response.status === 401 || response.status === 403) {
    throw new Error(
      'This model is gated. Accept its licence on Hugging Face and add an access token in Settings.',
    );
  }
  if (!response.ok) {
    throw new Error(`Download failed (${response.status}). Check your connection and try again.`);
  }
  if (!response.body) {
    throw new Error('The server sent no data.');
  }

  const declared = Number(response.headers.get('content-length') ?? 0);
  const total = declared || options.expectedBytes;

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  let windowStart = performance.now();
  let windowBytes = 0;
  let rate = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (options.signal?.aborted) {
      await reader.cancel().catch(() => undefined);
      throw new DownloadCancelled();
    }
    if (!value) continue;

    chunks.push(value);
    received += value.byteLength;
    windowBytes += value.byteLength;

    const elapsed = performance.now() - windowStart;
    if (elapsed >= 500) {
      rate = (windowBytes / elapsed) * 1000;
      windowStart = performance.now();
      windowBytes = 0;
      options.onProgress(received, total, rate);
    }
  }

  options.onProgress(received, total || received, rate);

  const blob = new Blob(chunks as BlobPart[]);
  const path = await writeFile(options.directory, options.filename, blob);
  return { path, bytes: received };
}

async function writeFile(directory: string, filename: string, blob: Blob): Promise<string> {
  if (isNative()) {
    await Filesystem.mkdir({
      path: directory,
      directory: Directory.Data,
      recursive: true,
    }).catch(() => undefined);

    // Capacitor's bridge is base64-only, so large files are written in slices
    // to avoid materialising a multi-gigabyte string.
    const path = `${directory}/${filename}`;
    await Filesystem.writeFile({ path, directory: Directory.Data, data: '' });

    const CHUNK = 4 * 1024 * 1024;
    for (let offset = 0; offset < blob.size; offset += CHUNK) {
      const slice = blob.slice(offset, offset + CHUNK);
      await Filesystem.appendFile({
        path,
        directory: Directory.Data,
        data: await toBase64(slice),
      });
    }

    const uri = await Filesystem.getUri({ path, directory: Directory.Data });
    return uri.uri;
  }

  const handle = await opfsDirectory(directory);
  const fileHandle = await handle.getFileHandle(filename, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(blob);
  await writable.close();
  return `opfs://${directory}/${filename}`;
}

async function toBase64(blob: Blob): Promise<string> {
  const buffer = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < buffer.length; i += CHUNK) {
    binary += String.fromCharCode(...buffer.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export async function deleteModelFiles(manifest: ModelManifest): Promise<void> {
  const directory = modelDirectory(manifest);
  if (isNative()) {
    await Filesystem.rmdir({
      path: directory,
      directory: Directory.Data,
      recursive: true,
    }).catch(() => undefined);
    return;
  }

  try {
    const parent = await opfsDirectory(`${MODEL_DIR}/${manifest.engine}`);
    await parent.removeEntry(manifest.id, { recursive: true });
  } catch {
    // Already gone.
  }
}

/** Bytes currently used by downloaded models, and what the device can spare. */
export async function storageEstimate(): Promise<{ used: number; quota: number }> {
  if (navigator.storage?.estimate) {
    const estimate = await navigator.storage.estimate();
    return { used: estimate.usage ?? 0, quota: estimate.quota ?? 0 };
  }
  return { used: 0, quota: 0 };
}
