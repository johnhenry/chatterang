/**
 * Model download manager.
 *
 * Models are large — often gigabytes — so downloads are STREAMED TO THE SINK
 * as they arrive, never buffered whole, and written to app-private storage. On
 * the web they go to the Origin Private File System, which gives the same
 * "sandboxed, not in the user's photo roll" property; on a packaged platform
 * they go to a real directory the inference host can open.
 *
 * RESUME, STATED PRECISELY. Within one download, a transfer that dies
 * mid-stream is resumed with a `Range` request from the byte count already
 * written, guarded by `If-Range` against the file changing underneath it. That
 * is the whole claim. It does NOT survive the app being closed: nothing
 * persists a partial byte count, and resuming from a remembered offset without
 * a remembered validator is how two different builds of a file get spliced
 * into one corrupt GGUF. The previous version of this docstring claimed
 * downloads were "resumable where the server allows it" while the file
 * contained no `Range` header, no `206` handling and no `Accept-Ranges` check
 * anywhere — a false claim is worse than an absent feature, so this one is
 * written to match the code below and no further.
 *
 * WHY THIS FILE ASKS `capabilities()` AND NEVER A PLUGIN. The sink is the one
 * capability that must not be discovered at runtime:
 * `Capacitor.isPluginAvailable('Filesystem')` answers TRUE on plain web,
 * because `@capacitor/filesystem` ships a web implementation that silently
 * succeeds into IndexedDB. Asking it would look like a principled capability
 * query and would quietly reinstate the bug where models were written
 * somewhere the engine could never read them. See `lib/platform.ts`.
 */

import { Directory, Filesystem } from '@capacitor/filesystem';

import type { CompanionRole, ModelManifest } from '@/domain/manifest';
import { resolveSourceUrl } from '@/domain/manifest';
import { capabilities } from '@/lib/platform';

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

/**
 * How much arrives before it is handed to the sink.
 *
 * This number is the ONLY thing bounding renderer memory during a download, so
 * it is a memory decision rather than a throughput one. The old code pushed
 * every chunk into an array and built one `Blob` at the end: MEASURED in an
 * Electron renderer, 1 GiB of chunks took RSS from 88 MB to 1133 MB, and the
 * `new Blob(chunks)` took it to 2189 MB — 2.1x the payload, because the array
 * is still referenced while the copy exists. Extrapolated, the 6.5 GB model in
 * the catalogue is ~13.8 GB of renderer RSS.
 *
 * 3 MiB rather than 4: a multiple of 3 encodes to base64 with no padding at
 * all, and it keeps every on-disk offset a whole number of flushes, which
 * makes the resume arithmetic trivial to audit. Peak is now ~10 MB whatever
 * the model size (3 MiB of bytes, a ~4.2 MB base64 string in UTF-16, and the
 * structured-clone copy the bridge makes) — and it does not grow with the file.
 *
 * Do not raise this to cut the IPC round-trip count without re-measuring RSS.
 */
const FLUSH_BYTES = 3 * 1024 * 1024;

/**
 * Consecutive failed attempts tolerated before a transfer gives up.
 *
 * Reset by progress: an attempt that wrote bytes earns the budget back, so a
 * flaky connection makes headway instead of burning three tries near the end
 * of a 6 GB file. `TOTAL_ATTEMPTS` bounds what that refund makes possible — a
 * server that sends a kilobyte and hangs up, every time. MEASURED with the
 * ceiling removed: the download did not fail, it ground through thousands of
 * 1 KiB attempts and eventually SUCCEEDED, which as a user experience is a
 * progress bar crawling for hours. Forty attempts is a limp, not a crawl.
 */
const CONSECUTIVE_ATTEMPTS = 3;
const TOTAL_ATTEMPTS = 40;

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

/* ── The sink ───────────────────────────────────────────────────────── */

/**
 * Somewhere gigabytes go, one flush at a time.
 *
 * Two implementations, one shape. The platform difference is the API, not the
 * capability — both sinks take incremental writes and both can be reset to
 * empty — which is exactly why `capabilities()` answers with WHICH SINK rather
 * than with a platform name.
 */
interface Sink {
  /** Append bytes. Called once per flush, in order. */
  write(bytes: Uint8Array): Promise<void>;
  /** Truncate back to empty, for a server that refused to resume. */
  reset(): Promise<void>;
  /** Flush and release. The path the app stores for this file. */
  close(): Promise<string>;
}

async function openSink(directory: string, filename: string): Promise<Sink> {
  return capabilities().modelStore === 'filesystem'
    ? openFilesystemSink(directory, filename)
    : openOpfsSink(directory, filename);
}

async function openFilesystemSink(directory: string, filename: string): Promise<Sink> {
  await Filesystem.mkdir({
    path: directory,
    directory: Directory.Data,
    recursive: true,
  }).catch(() => undefined);

  const path = `${directory}/${filename}`;
  // Create-and-TRUNCATE. The desktop plugin documents this as contract: opened
  // for append instead, a second download of the same model would silently
  // produce a double-length file that fails GGUF magic at load — a failure
  // that reads as a bad model rather than a bad write.
  const truncate = async (): Promise<void> => {
    await Filesystem.writeFile({ path, directory: Directory.Data, data: '' });
  };
  await truncate();

  return {
    // Capacitor's bridge is base64-only, so bytes cross it as text. Each
    // append is decoded independently on the far side, so a flush needs no
    // particular alignment — padding lands inside its own call.
    write: async (bytes) => {
      await Filesystem.appendFile({ path, directory: Directory.Data, data: toBase64(bytes) });
    },
    reset: truncate,
    close: async () => {
      const uri = await Filesystem.getUri({ path, directory: Directory.Data });
      return uri.uri;
    },
  };
}

async function openOpfsSink(directory: string, filename: string): Promise<Sink> {
  const handle = await opfsDirectory(directory);
  const fileHandle = await handle.getFileHandle(filename, { create: true });
  // `createWritable()` truncates by default, which is the create-and-truncate
  // the filesystem sink does explicitly.
  let writable = await fileHandle.createWritable();

  return {
    write: async (bytes) => {
      // The stream IS the buffer here: one `write` per flush replaces the
      // single `write(blob)` that used to hold the whole model in memory.
      //
      // The cast is a TYPE artefact, not a runtime one: `lib.dom` narrows this
      // parameter to a view over `ArrayBuffer`, while a chunk handed back by a
      // stream reader is typed over `ArrayBufferLike` (which admits
      // `SharedArrayBuffer`). Copying the block to satisfy that would allocate
      // a second 3 MiB per flush for nothing.
      await writable.write(bytes as unknown as FileSystemWriteChunkType);
    },
    reset: async () => {
      await writable.close().catch(() => undefined);
      writable = await fileHandle.createWritable();
    },
    close: async () => {
      await writable.close();
      return `opfs://${directory}/${filename}`;
    },
  };
}

/* ── Public API ─────────────────────────────────────────────────────── */

export interface DownloadOptions {
  manifest: ModelManifest;
  /** Hugging Face token, required for gated repositories. */
  hfToken?: string;
  signal?: AbortSignal;
  onProgress?: (progress: DownloadProgress) => void;
  /** Pause before a resume attempt. Exposed so tests do not sleep. */
  retryDelayMs?: number;
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
      retryDelayMs: options.retryDelayMs,
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
  retryDelayMs?: number;
  onProgress: (received: number, total: number, bytesPerSecond: number) => void;
}

/** What one HTTP attempt did. */
type Attempt = 'done' | 'restart';

interface TransferState {
  /** Bytes confirmed written to the sink. The resume offset. */
  written: number;
  /** Best known total, from `content-length`, `content-range`, or the manifest. */
  total: number;
  /** `ETag`/`Last-Modified` from the first response, for `If-Range`. */
  validator: string | null;
  rate: number;
}

async function fetchToStorage(options: FetchOptions): Promise<{ path: string; bytes: number }> {
  const sink = await openSink(options.directory, options.filename);
  const state: TransferState = {
    written: 0,
    total: options.expectedBytes,
    validator: null,
    rate: 0,
  };

  let consecutive = 0;
  let attempts = 0;

  try {
    for (;;) {
      throwIfCancelled(options.signal);
      attempts += 1;
      const before = state.written;
      try {
        if ((await transfer(options, sink, state)) === 'done') break;
        // A restart is not a failure — the server declined to resume and sent
        // the whole file, which the sink has been reset for.
        consecutive = 0;
        continue;
      } catch (error) {
        throwIfCancelled(options.signal);
        if (!isRetryable(error)) throw error;
        consecutive = state.written > before ? 0 : consecutive + 1;
        if (consecutive >= CONSECUTIVE_ATTEMPTS || attempts >= TOTAL_ATTEMPTS) throw error;
        await pause(options.retryDelayMs ?? 1000, options.signal);
      }
    }

    options.onProgress(state.written, state.total || state.written, state.rate);
    const path = await sink.close();
    return { path, bytes: state.written };
  } catch (error) {
    // The sink holds an OS handle; leaving it open would leak it and, on OPFS,
    // leave the file locked against the retry the user is about to press.
    await sink.close().catch(() => undefined);
    throw error;
  }
}

/**
 * One HTTP request, streamed into the sink.
 *
 * Mutates `state` as it goes, so a failure half way through leaves behind the
 * byte count the next attempt resumes from.
 */
async function transfer(
  options: FetchOptions,
  sink: Sink,
  state: TransferState,
): Promise<Attempt> {
  const headers: Record<string, string> = {};
  if (options.hfToken) headers.Authorization = `Bearer ${options.hfToken}`;

  const resuming = state.written > 0;
  if (resuming) {
    headers.Range = `bytes=${state.written}-`;
    // Without this, a file republished mid-download splices two different
    // builds into one file that fails at load rather than at download.
    if (state.validator) headers['If-Range'] = state.validator;
  }

  const response = await fetch(options.url, { headers, signal: options.signal });

  if (response.status === 401 || response.status === 403) {
    throw new Error(
      'This model is gated. Accept its licence on Hugging Face and add an access token in Settings.',
    );
  }
  if (response.status === 416) {
    // The range we asked for is not satisfiable — the file shrank, or was
    // replaced by a shorter one. Start again rather than keep a prefix of
    // something that no longer exists.
    await response.body?.cancel().catch(() => undefined);
    await restart(sink, state);
    return 'restart';
  }
  if (!response.ok) {
    throw new Error(`Download failed (${response.status}). Check your connection and try again.`);
  }
  if (!response.body) {
    throw new Error('The server sent no data.');
  }

  if (!state.validator) {
    state.validator = response.headers.get('etag') ?? response.headers.get('last-modified');
  }

  if (resuming) {
    const range = parseContentRange(response.headers.get('content-range'));
    if (response.status !== 206 || range === null || range.start !== state.written) {
      // Either the server ignored `Range` (200 with the whole body), or
      // `If-Range` failed and it sent the whole current file, or it answered a
      // range we did not ask for. In every case what is on disk is a prefix of
      // a file we can no longer vouch for.
      await restart(sink, state);
      return await consume(options, sink, state, response);
    }
    if (range.total > 0) state.total = range.total;
  } else {
    const declared = Number(response.headers.get('content-length') ?? 0);
    if (declared > 0) state.total = declared;
    else if (state.total === 0) state.total = options.expectedBytes;
  }

  return await consume(options, sink, state, response);
}

/** Reset both the sink and the bookkeeping that describes it. */
async function restart(sink: Sink, state: TransferState): Promise<void> {
  await sink.reset();
  state.written = 0;
  state.validator = null;
}

/**
 * Drain the body into the sink, a flush at a time.
 *
 * `pending` never holds more than one flush, and the references are dropped as
 * soon as the write is awaited — that is the entire memory story.
 */
async function consume(
  options: FetchOptions,
  sink: Sink,
  state: TransferState,
  response: Response,
): Promise<Attempt> {
  const reader = response.body!.getReader();
  const pending: Uint8Array[] = [];
  let pendingBytes = 0;
  let windowStart = performance.now();
  let windowBytes = 0;

  /**
   * Hand the sink exactly `bytes`, or everything held if `bytes` is Infinity.
   *
   * EXACTLY, because the block size is the memory bound and a bound the
   * NETWORK gets to choose is not a bound. Chunk sizes from `fetch` are not
   * 64 KiB just because that is what the socket read: MEASURED against a local
   * server, undici coalesced them into blocks that overshot the flush
   * threshold enough to turn four appends into three. Taking a fixed block and
   * keeping the remainder makes the write size a property of this file.
   */
  const flush = async (bytes: number): Promise<void> => {
    const size = Math.min(bytes, pendingBytes);
    if (size === 0) return;
    const block = take(pending, size);
    pendingBytes -= size;
    await sink.write(block);
    state.written += size;
  };

  try {
    for (;;) {
      // An ABORTED FETCH REJECTS HERE — it does not return `{done:true}`.
      // MEASURED: `AbortError: This operation was aborted` (undici) and
      // `AbortError: BodyStreamBuffer was aborted` (Chromium). The old code
      // tested `signal.aborted` AFTER this line, which is unreachable on the
      // real path: cancelling produced a `state:'failed'` record and a red
      // toast reading "BodyStreamBuffer was aborted" instead of a cancellation.
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;

      pending.push(value);
      pendingBytes += value.byteLength;
      while (pendingBytes >= FLUSH_BYTES) await flush(FLUSH_BYTES);

      windowBytes += value.byteLength;
      const elapsed = performance.now() - windowStart;
      if (elapsed >= 500) {
        state.rate = (windowBytes / elapsed) * 1000;
        windowStart = performance.now();
        windowBytes = 0;
        // Reported from the wire, not from the sink, so the number moves
        // between flushes.
        options.onProgress(state.written + pendingBytes, state.total, state.rate);
      }
    }
    await flush(Infinity);
  } catch (error) {
    // Whatever arrived before the failure is already on disk and counted, so
    // the retry resumes from there rather than from zero.
    await flush(Infinity).catch(() => undefined);
    await reader.cancel().catch(() => undefined);
    throw error;
  }

  return 'done';
}

/**
 * Remove exactly `bytes` from the front of `parts` and return them as one
 * block, splitting a chunk if the boundary falls inside it.
 */
function take(parts: Uint8Array[], bytes: number): Uint8Array {
  if (parts.length > 0 && parts[0]!.byteLength === bytes) return parts.shift()!;

  const out = new Uint8Array(bytes);
  let at = 0;
  while (at < bytes) {
    const part = parts[0]!;
    const room = bytes - at;
    if (part.byteLength <= room) {
      out.set(part, at);
      at += part.byteLength;
      parts.shift();
    } else {
      out.set(part.subarray(0, room), at);
      parts[0] = part.subarray(room);
      at += room;
    }
  }
  return out;
}

/** `bytes 1048576-1048591/436806912` -> `{start, total}`. */
function parseContentRange(header: string | null): { start: number; total: number } | null {
  const match = /^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec((header ?? '').trim());
  if (!match) return null;
  return { start: Number(match[1]), total: match[3] === '*' ? 0 : Number(match[3]) };
}

/**
 * Is this worth another attempt?
 *
 * A dropped connection is; a 404, a gated repo, a full disk and a refused path
 * are not — retrying those just repeats the same answer three times before
 * showing the user the same message anyway. `fetch` reports a transport
 * failure as a bare `TypeError`, and a stream that dies mid-body surfaces as a
 * `TypeError` or a `DOMException` from the reader.
 */
function isRetryable(error: unknown): boolean {
  if (error instanceof DownloadCancelled) return false;
  if (error instanceof TypeError) return true;
  const name = (error as { name?: unknown }).name;
  return name === 'NetworkError' || name === 'TimeoutError';
}

function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new DownloadCancelled();
}

async function pause(ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (ms <= 0) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(finish, ms);
    function finish(): void {
      clearTimeout(timer);
      signal?.removeEventListener('abort', finish);
      resolve();
    }
    signal?.addEventListener('abort', finish, { once: true });
  });
  throwIfCancelled(signal);
}

/**
 * Bytes to standard padded base64, without materialising a second copy of the
 * whole model.
 *
 * `String.fromCharCode(...chunk)` is spread, so the chunk has to stay well
 * under the argument limit; 0x8000 has been safe everywhere this ships.
 */
function toBase64(bytes: Uint8Array): string {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export async function deleteModelFiles(manifest: ModelManifest): Promise<void> {
  const directory = modelDirectory(manifest);
  if (capabilities().modelStore === 'filesystem') {
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
