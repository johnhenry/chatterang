/**
 * Model download manager.
 *
 * Models are large — often gigabytes — so downloads are STREAMED TO THE SINK
 * as they arrive, never buffered whole, and written to app-private storage. On
 * the web they go to the Origin Private File System, which gives the same
 * "sandboxed, not in the user's photo roll" property; on a packaged platform
 * they go to a real directory the inference host can open.
 *
 * RESUME, STATED PRECISELY, ON THE THIRD ATTEMPT AT SAYING IT. Within one
 * download, a transfer that dies mid-stream is resumed with a `Range` request
 * from the byte count already written — AND ONLY WHEN the first response
 * carried an `ETag` or a `Last-Modified` to hand back as `If-Range`. A server
 * that offers neither gives us nothing to detect a republish with, so there is
 * no resume at all: the sink is truncated and the file is fetched again from
 * zero. It does NOT survive the app being closed either; nothing persists a
 * partial byte count.
 *
 * THAT REFUSAL IS THE POINT, not a limitation to work around. Splicing the
 * head of one build onto the tail of another is the one corruption nothing
 * downstream catches: the magic check below passes, because the prefix really
 * IS a valid GGUF header, and the engine fails much later with an error that
 * names the model rather than the download. Re-fetching costs bandwidth
 * against a rare kind of server. Guessing costs a corrupt model that looks
 * installed.
 *
 * This paragraph has now been wrong twice, which is why it is written this
 * carefully. Version one claimed downloads were "resumable where the server
 * allows it" while the file contained no `Range` header, no `206` handling and
 * no `Accept-Ranges` check anywhere. Version two claimed resume was "guarded
 * by `If-Range` against the file changing underneath it. That is the whole
 * claim." — while the code sent `If-Range` only `if (state.validator)` and
 * resumed UNGUARDED when the server had sent no validator, which is precisely
 * the splice the sentence promised to prevent. A narrower false claim is still
 * a false claim.
 *
 * WHAT IS CHECKED WHEN THE BYTES STOP — AND WHAT IS NOT.
 *
 * Any 200 used to be installed AS THE MODEL. An HTML "please log in" page, a
 * transfer cut short by a proxy, a CDN error document: all were written to the
 * sink, recorded as an installed model, and surfaced days later as a GGUF
 * format error pointing nowhere near the cause. Three things are checked now,
 * and each one is checked against something the SERVER said rather than
 * something this app assumed:
 *
 *   CONTENT-TYPE  `text/html` is refused outright. No model file is a web
 *                 page, and the CDN interstitial is the common case.
 *   THE FIRST BYTES  A body that opens `<!DOCTYPE`/`<html`/`<?xml` is a
 *                 document, whatever the content-type claimed. And where the
 *                 manifest names a format with documented magic — GGUF — the
 *                 file must start with it. This is the check that turns "the
 *                 engine says bad GGUF" into "the server sent a web page".
 *   LENGTH        What arrived must equal what the response declared. Short
 *                 is a truncated transfer and is retried from the offset
 *                 reached; longer is refused, because no `Range` request can
 *                 un-write bytes already in the sink.
 *
 * THE LENGTH CHECK, MEASURED RATHER THAN ASSUMED. Which half of it can fire
 * depends on what the HTTP client does first, so both were driven against a
 * real `node:http` server before this was written:
 *
 *   body SHORTER than `content-length`   the client rejects the stream itself.
 *     MEASURED: `TypeError: terminated`, cause `UND_ERR_RES_CONTENT_LENGTH_MISMATCH`
 *     (undici); Chromium reports `net::ERR_CONTENT_LENGTH_MISMATCH` the same
 *     way. So this arrives as a retryable transport failure and the check here
 *     is a BACKSTOP for a client that is more forgiving, not the thing that
 *     catches it.
 *   body LONGER than `content-length`    the client truncates to the declared
 *     length. MEASURED: 500 bytes sent under `content-length: 100`, 100
 *     delivered. It cannot over-write the sink through this door.
 *
 * What is left, and what the check therefore exists for, is `content-range`,
 * which no client validates against the body: a `206` declaring
 * `bytes 0-99/1000` and delivering 100 bytes arrives CLEAN and complete
 * (MEASURED), and a `206` declaring `bytes 0-99/100` under `content-length:
 * 500` delivers 500 bytes for a 100-byte file. Those are the two the code
 * below actually stops.
 *
 * NOT CHECKED, deliberately and stated so nobody assumes otherwise:
 *
 *   There is NO CHECKSUM. The catalogue carries no digest, so a server that
 *   delivers exactly as many bytes as it promised, starting with the right
 *   magic, is believed.
 *
 *   A server that declares NO length at all — chunked, no `content-length`,
 *   no `content-range` — leaves nothing to compare against, and that transfer
 *   is accepted on the magic alone. Hugging Face always declares one.
 *
 *   `manifest.sizeBytes` IS NOT THE CHECK, and cannot be. It is the sum over
 *   every file in the download (`2_489_757_856 + 851_251_104` in the
 *   catalogue) and in one entry a round estimate (`2_600_000_000`). Compared
 *   against a single file it would fail every vision model, and rounded it
 *   would fail SD-Turbo. It is a PROGRESS HINT — a number to draw a bar
 *   against until the server states a real one — and it is passed under that
 *   name.
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

/**
 * The server answered, and what it sent is not the file.
 *
 * NEVER RETRIED. A 404, a gated repo, an HTML interstitial, a body longer than
 * the length it declared: asking again produces the same answer, and the point
 * of the class is that `isRetryable` cannot accidentally treat one of these as
 * a flaky connection. The message is the one the user sees, so each throw site
 * says what the server did rather than which check fired.
 */
export class DownloadRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DownloadRefused';
  }
}

/**
 * The body stopped short of the length the server declared.
 *
 * RETRYABLE, and the only new error that is: a proxy cutting a transfer short
 * is indistinguishable from a dropped socket except that `fetch` resolves the
 * stream cleanly instead of rejecting it. Before this existed, that difference
 * decided whether the model was retried or INSTALLED — a body truncated with a
 * clean end-of-stream was written to the sink and recorded as complete.
 */
class IncompleteTransfer extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IncompleteTransfer';
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

/**
 * How many leading bytes are held back to identify what arrived.
 *
 * Sixteen, which is more than any magic here needs and enough to recognise a
 * document opening. It is a peek, not a buffer: the bytes stay in the pending
 * queue and are flushed with everything else, so this costs nothing against
 * the memory bound `FLUSH_BYTES` sets.
 */
const PROBE_BYTES = 16;

/**
 * The first bytes of a file, by format, where the format documents them.
 *
 * GGUF's spec fixes the first four bytes as `GGUF`. ONNX is protobuf with no
 * required leading tag, so there is nothing honest to assert about it and it is
 * absent rather than guessed at — a magic check that is wrong on a real file is
 * worse than no magic check, because it refuses a model that works.
 */
const FORMAT_MAGIC: Readonly<Record<string, string>> = Object.freeze({
  gguf: 'GGUF',
});

/**
 * How a document announces itself, whatever the content-type claimed.
 *
 * The CDN case that motivated all of this answers 200 with `content-type:
 * text/html`, so the header check catches it — but the same interstitial
 * served as `application/octet-stream` would sail past a header check and past
 * a length check, because its `content-length` is honest about the HTML. These
 * openings are what is left to recognise it by.
 */
const DOCUMENT_OPENINGS = ['<!doctype', '<html', '<?xml', '<!--'];

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
      // A HINT, not an expectation. `sizeBytes` is the sum over every file in
      // the download and is a round estimate for at least one entry, so it can
      // draw a progress bar and nothing else. Completeness is checked against
      // what the SERVER declares, per file. See the header.
      progressHint: entry.role === 'model' ? manifest.sizeBytes : 0,
      // Only the model file has a format in the manifest; a companion is a
      // tokenizer, an mmproj or a vae, and the manifest does not type them.
      magic: entry.role === 'model' ? FORMAT_MAGIC[manifest.format] : undefined,
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
  /**
   * A number to draw a progress bar against before the server states a real
   * one. NEVER a completeness check — see the header for why `sizeBytes`
   * cannot be one.
   */
  progressHint: number;
  /** ASCII the file must begin with, where the format documents it. */
  magic?: string;
  retryDelayMs?: number;
  onProgress: (received: number, total: number, bytesPerSecond: number) => void;
}

/** What one HTTP attempt did. */
type Attempt = 'done' | 'restart';

interface TransferState {
  /** Bytes confirmed written to the sink. The resume offset. */
  written: number;
  /** Best known total FOR THE PROGRESS BAR. May be the manifest's guess. */
  total: number;
  /**
   * The full size of this file AS THE SERVER STATED IT — `content-length` on a
   * fresh 200, or the `/total` of a `content-range` on a 206. Null when the
   * server declared nothing.
   *
   * Kept apart from `total` on purpose. `total` is allowed to be a guess
   * because it only draws a bar; this one decides whether a download is
   * INSTALLED, so it must never be contaminated by the manifest.
   */
  declared: number | null;
  /** `ETag`/`Last-Modified` from the first response, for `If-Range`. */
  validator: string | null;
  rate: number;
  /** Have the first bytes of the current file been identified yet? */
  probed: boolean;
}

async function fetchToStorage(options: FetchOptions): Promise<{ path: string; bytes: number }> {
  const sink = await openSink(options.directory, options.filename);
  const state: TransferState = {
    written: 0,
    total: options.progressHint,
    declared: null,
    validator: null,
    rate: 0,
    probed: false,
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

        /*
         * A RESTART IS NOT A FAILURE, BUT IT IS NOT FREE EITHER.
         *
         * This arm used to be `consecutive = 0; continue;` — no budget, no
         * backoff, no ceiling. A server that answers 416 to EVERY request
         * (including the one with no `Range` header, which the restart just
         * made it) sends this loop round forever: `restart()` puts `written`
         * back to zero, the next request therefore carries no range, and the
         * next 416 restarts it again. `attempts` was being incremented at the
         * top of the loop and never read on this path.
         *
         * So a restart is now scored exactly like a failed attempt: it earns
         * the budget back only if it actually moved bytes, it is capped by
         * both ceilings, and it sleeps before trying again. A server that will
         * not cooperate is a bounded wait ending in an error, not a spinner.
         */
        consecutive = state.written > before ? 0 : consecutive + 1;
        if (consecutive >= CONSECUTIVE_ATTEMPTS || attempts >= TOTAL_ATTEMPTS) {
          throw new DownloadRefused(
            'The server kept restarting this download instead of continuing it. Try again later.',
          );
        }
        await pause(options.retryDelayMs ?? 1000, options.signal);
        continue;
      } catch (error) {
        throwIfCancelled(options.signal);
        if (!isRetryable(error)) throw error;
        consecutive = state.written > before ? 0 : consecutive + 1;
        if (consecutive >= CONSECUTIVE_ATTEMPTS || attempts >= TOTAL_ATTEMPTS) throw error;
        await pause(options.retryDelayMs ?? 1000, options.signal);
      }
    }

    /*
     * THE CHECK THAT DECIDES WHETHER THIS IS A MODEL.
     *
     * Everything above can succeed on a body that is not the file: the length
     * check inside `consume` covers one RESPONSE, and a download made of a
     * restart plus a resume is more than one. This is the invariant stated
     * once, at the only point where it is finally knowable — and it is stated
     * against `declared`, which only ever comes from the server, never from
     * `progressHint`.
     */
    if (state.declared !== null && state.written !== state.declared) {
      throw new DownloadRefused(
        `The download ended with ${state.written} bytes where the server said ${state.declared}. Nothing was installed.`,
      );
    }
    if (state.written === 0) {
      throw new DownloadRefused('The server sent an empty file. Nothing was installed.');
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

  /*
   * NO VALIDATOR, NO RESUME. THIS IS THE WHOLE GUARD.
   *
   * `If-Range` is what makes a resume safe: the server compares it and, if the
   * file has been republished, answers 200 with the whole new body instead of
   * splicing a new tail onto our old head. `ETag` and `Last-Modified` are both
   * OPTIONAL, so a server can leave us with nothing to send — and this code
   * used to send the `Range` anyway, under a docstring claiming the resume was
   * guarded. An unguarded resume across a republish is a file whose first
   * megabytes come from one build and whose rest comes from another: valid
   * GGUF magic, valid length, and garbage inside.
   *
   * Dropping what is on disk and re-fetching costs bandwidth against a rare
   * kind of server. It is the only alternative that cannot produce that file.
   */
  if (state.written > 0 && state.validator === null) await restart(sink, state);

  const resuming = state.written > 0;
  if (resuming) {
    headers.Range = `bytes=${state.written}-`;
    headers['If-Range'] = state.validator!;
  }

  const response = await fetch(options.url, { headers, signal: options.signal });

  if (response.status === 401 || response.status === 403) {
    throw new DownloadRefused(
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
    throw new DownloadRefused(
      `Download failed (${response.status}). Check your connection and try again.`,
    );
  }
  if (!response.body) {
    throw new DownloadRefused('The server sent no data.');
  }

  /*
   * A WEB PAGE IS NEVER A MODEL.
   *
   * The CDN interstitial — "please log in", a rate-limit notice, a 200-dressed
   * error document — is the case that made this whole section necessary: it
   * arrives as a perfectly well-formed 200 with an honest `content-length`,
   * and every check that existed before waved it through and INSTALLED it.
   */
  const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
  if (/^\s*(text\/html|application\/xhtml\+xml)\b/.test(contentType)) {
    await response.body.cancel().catch(() => undefined);
    // The declared type is IN THE MESSAGE, and not for decoration. Without it
    // this refusal and the first-bytes one below read identically, and a
    // revert-check could not tell which had fired — measured: deleting this
    // whole block left the suite green, because the probe caught the same page
    // and said the same sentence. It also happens to be the single most useful
    // fact in a bug report about a download that will not start.
    throw new DownloadRefused(
      `The server returned a web page (${contentType.split(';')[0]!.trim()}) instead of the model file. The link may have expired, or the repository may need a token.`,
    );
  }

  if (!state.validator) {
    state.validator = response.headers.get('etag') ?? response.headers.get('last-modified');
  }

  /** How many bytes THIS response promised to deliver, if it said. */
  let mustDeliver: number | null = null;

  if (!resuming && response.status === 206) {
    /*
     * A 206 TO A REQUEST THAT CARRIED NO RANGE.
     *
     * RFC 9110 makes 206 an answer to a range request, so an unsolicited one
     * is a broken server — and its body is a FRAGMENT that this code would
     * otherwise write from offset zero and call the file. A `content-range`
     * starting at 0 is harmless (it is the whole file with extra ceremony);
     * anything else is a slice of a model presented as the model.
     */
    const range = parseContentRange(response.headers.get('content-range'));
    if (range !== null && range.start !== 0) {
      await response.body.cancel().catch(() => undefined);
      throw new DownloadRefused(
        'The server answered with part of the file when the whole one was asked for. Nothing was installed.',
      );
    }
  }

  if (resuming) {
    if (response.status !== 206) {
      // The server ignored `Range`, or `If-Range` failed and it sent the whole
      // CURRENT file. Either way the prefix on disk belongs to a file we can
      // no longer vouch for, and the body in hand is a complete one.
      await restart(sink, state);
      state.declared = declaredLength(response);
      state.total = state.declared ?? state.total;
      return await consume(options, sink, state, response, state.declared);
    }

    const range = parseContentRange(response.headers.get('content-range'));
    if (range === null || range.start !== state.written) {
      /*
       * A 206 ANSWERING A RANGE NOBODY ASKED FOR.
       *
       * This used to fall in with the 200 case and its body was consumed AS
       * THE WHOLE FILE — a slice from the middle of a model, written from
       * offset zero, with a `content-length` that honestly describes the slice
       * so every length check agrees. For a GGUF the magic probe catches it;
       * for a companion, which has no magic, nothing did.
       *
       * A slice of unknown provenance is not a file. Drop it, truncate, and
       * let the bounded restart arm decide whether to try again.
       */
      await response.body.cancel().catch(() => undefined);
      await restart(sink, state);
      return 'restart';
    }

    if (range.total > 0) {
      state.total = range.total;
      state.declared = range.total;
      // The rest of the file, which is what `bytes=N-` asked for. A server
      // that answers with less is not wrong — it is a short attempt, and the
      // loop resumes from wherever it stopped.
      mustDeliver = range.total - range.start;
    }
  } else {
    state.declared = declaredLength(response);
    mustDeliver = state.declared;
    if (state.declared !== null) state.total = state.declared;
    else if (state.total === 0) state.total = options.progressHint;
  }

  return await consume(options, sink, state, response, mustDeliver);
}

/** `content-length`, or null when the server declared none. */
function declaredLength(response: Response): number | null {
  const header = response.headers.get('content-length');
  if (header === null) return null;
  const value = Number(header);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

/** Reset both the sink and the bookkeeping that describes it. */
async function restart(sink: Sink, state: TransferState): Promise<void> {
  await sink.reset();
  state.written = 0;
  state.validator = null;
  state.declared = null;
  // The file being fetched may be a different file now, so its first bytes
  // have to be identified again rather than inherited from the one discarded.
  state.probed = false;
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
  mustDeliver: number | null,
): Promise<Attempt> {
  const reader = response.body!.getReader();
  const pending: Uint8Array[] = [];
  let pendingBytes = 0;
  let windowStart = performance.now();
  let windowBytes = 0;
  const startedAt = state.written;

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

  /**
   * Identify the file from its opening bytes, once, before any of it is kept.
   *
   * Held in `pending` rather than copied out: this is a peek at bytes that are
   * on their way to the sink anyway, so it adds nothing to the memory bound.
   * It runs only while `written` is still zero — after the first flush the
   * head is on disk and no longer available, and after a successful 206 the
   * head was identified on the attempt that fetched it.
   */
  const identify = (atEnd: boolean): void => {
    if (state.probed || state.written > 0) return;
    /*
     * Wait for enough bytes to decide — UNLESS the body has ended, in which
     * case these are all the bytes there will ever be.
     *
     * Without that second clause a body SHORTER than the probe window never
     * got a verdict at all: `identify()` returned early every time round the
     * loop and again after it, and a two-byte 200 was written to the sink and
     * RESOLVED as an installed model. Caught by the fault server, not by
     * reading the code.
     */
    if (!atEnd && pendingBytes < PROBE_BYTES) return;
    state.probed = true;
    const head = ascii(peek(pending, Math.min(pendingBytes, PROBE_BYTES)));
    const lower = head.toLowerCase();
    if (DOCUMENT_OPENINGS.some((opening) => lower.startsWith(opening))) {
      throw new DownloadRefused(
        'The server returned a web page instead of the model file. The link may have expired, or the repository may need a token.',
      );
    }
    if (options.magic && !head.startsWith(options.magic)) {
      throw new DownloadRefused(
        `The file the server sent is not a ${options.magic} model. Nothing was installed.`,
      );
    }
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
      identify(false);
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
    // End of body: whatever is held is the whole file, however short.
    identify(true);
    await flush(Infinity);
  } catch (error) {
    // Whatever arrived before the failure is already on disk and counted, so
    // the retry resumes from there rather than from zero.
    await flush(Infinity).catch(() => undefined);
    await reader.cancel().catch(() => undefined);
    throw error;
  }

  /*
   * WHAT ARRIVED VERSUS WHAT WAS PROMISED, FOR THIS RESPONSE.
   *
   * `fetch` resolves the stream cleanly when a proxy ends a body early with a
   * `content-length` still claiming more, so "the loop finished" is not
   * "the file is here". Nothing compared the two before, and the short body
   * was written to the sink and recorded as an installed model.
   *
   * SHORT is retryable — it is a truncated transfer, and the resume above is
   * exactly the machinery for it. LONGER is refused outright: the extra bytes
   * are already in the sink, no `Range` request can un-write them, and a
   * server sending more than it declared is not one to take a second answer
   * from.
   */
  const delivered = state.written - startedAt;
  if (mustDeliver !== null && delivered !== mustDeliver) {
    if (delivered > mustDeliver) {
      throw new DownloadRefused(
        `The server sent ${delivered} bytes where it declared ${mustDeliver}. Nothing was installed.`,
      );
    }
    throw new IncompleteTransfer(
      `The transfer ended after ${delivered} of ${mustDeliver} bytes.`,
    );
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

/**
 * The first `bytes` of `parts`, WITHOUT removing them.
 *
 * `take` is destructive because the block it returns is handed straight to the
 * sink. The probe must not consume what it looks at — those bytes are part of
 * the file.
 */
function peek(parts: Uint8Array[], bytes: number): Uint8Array {
  const out = new Uint8Array(bytes);
  let at = 0;
  for (const part of parts) {
    if (at >= bytes) break;
    const room = bytes - at;
    out.set(part.byteLength <= room ? part : part.subarray(0, room), at);
    at += Math.min(part.byteLength, room);
  }
  return out.subarray(0, at);
}

/** Latin-1 bytes as a string, for comparing a magic or a document opening. */
function ascii(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += String.fromCharCode(byte);
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
  // Stated BEFORE the TypeError arm and before the name check, so a refusal
  // can never be reclassified as a flaky connection by a later clause.
  if (error instanceof DownloadRefused) return false;
  // A body cut short with a clean end-of-stream. Indistinguishable from a
  // dropped socket except that `fetch` did not reject, which is exactly why it
  // needs naming: before this class existed, that difference decided whether
  // the model was retried or installed.
  if (error instanceof IncompleteTransfer) return true;
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
