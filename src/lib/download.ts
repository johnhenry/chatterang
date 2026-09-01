/**
 * Model download manager.
 *
 * Models are large — often gigabytes — so downloads are STREAMED TO THE SINK
 * as they arrive, never buffered whole, and written to app-private storage. On
 * the web they go to the Origin Private File System, which gives the same
 * "sandboxed, not in the user's photo roll" property; on a packaged platform
 * they go to a real directory the inference host can open.
 *
 * THE ONE PROPERTY THIS FILE EXISTS TO HOLD:
 *
 *   Nothing reaches the sink until the transfer has been identified as the
 *   file that was asked for, and nothing is recorded as installed until the
 *   sink holds exactly that file.
 *
 * THREE ROUNDS OF REVIEW EACH ADDED A CHECK FOR ONE HALF OF THAT SENTENCE,
 * and each round found a path around the previous one — a content-type
 * refusal, a document probe, GGUF magic, a per-response declared length, a
 * final written-versus-declared comparison. All correct; none of them
 * structural. The last one found: the probe refused to run once `written > 0`
 * and the failure arm of the read loop flushed what it was holding BEFORE
 * anything had identified it, so a connection dying inside the first sixteen
 * bytes put an unidentified prefix on disk and every later attempt inherited
 * "already identified" from it.
 *
 * SO IT IS NO LONGER A CHECK. `Intake` below owns the sink — nothing else in
 * this file holds one — and holds unidentified bytes in a queue that has no
 * path to it. The only code that empties that queue either identifies what is
 * in it and moves it to the outgoing queue, or DROPS it. "Wrote an
 * unidentified byte" is not a check a future edit can route around; there is
 * no expression in this file that performs it. The same object owns the byte
 * count and the length the server stated, and it is the only thing that can
 * produce the path a download is recorded under — `commit()`, which hands one
 * back only when those two numbers agree.
 *
 * RESUME, AND WHAT MAKES A CONTINUATION BELIEVABLE. Within one download, a
 * transfer that dies mid-stream is resumed with a `Range` request — and the
 * range asked for starts `OVERLAP_BYTES` BEFORE the end of what is on disk,
 * so the server re-sends bytes this code already has. They are compared
 * against the tail the sink was handed, byte for byte, and not one new byte
 * is queued until they match. A body that does not overlap what it claims to
 * continue is dropped and the file is fetched again from zero. That is what a
 * continuation is identified BY, and it is the same mechanism as the magic
 * check on the head: a byte reaches the sink only after something proved it
 * belongs to the file already being written.
 *
 * `If-Range` is still sent, and a server offering neither `ETag` nor
 * `Last-Modified` gets no `Range` request at all — but the guarantee does not
 * rest on the server honouring it. A server that ignores `If-Range` answers a
 * resume across a republish with a splice: the head of one build and the tail
 * of another, valid magic, exactly the right length, garbage inside. The
 * overlap is what notices that. What the overlap CANNOT notice is a
 * republished file that is byte-identical across the sixty-four bytes at that
 * one offset; there is no checksum in the catalogue, and that residue is
 * stated here rather than described away.
 *
 * Resume does NOT survive the app being closed: nothing persists a partial
 * byte count, the validator, or the tail a continuation would be checked
 * against.
 *
 * THIS PARAGRAPH HAS BEEN WRONG THREE TIMES, in narrowing ways, which is why
 * the version above describes a mechanism rather than a promise. Version one
 * claimed downloads were "resumable where the server allows it" while the
 * file contained no `Range` header, no `206` handling and no `Accept-Ranges`
 * check anywhere. Version two claimed the resume was "guarded by `If-Range`
 * against the file changing underneath it. That is the whole claim." — while
 * the code sent `If-Range` only `if (state.validator)` and resumed UNGUARDED
 * otherwise. Version three fixed that and claimed "NO VALIDATOR, NO RESUME.
 * THIS IS THE WHOLE GUARD.", which was false in the remaining direction: a
 * validator the SERVER ignores guards nothing, and nothing downstream caught
 * the splice. That sentence is deleted rather than narrowed a fourth time.
 *
 * WHAT IS CHECKED WHEN THE BYTES STOP — AND WHAT IS NOT.
 *
 * Any 200 used to be installed AS THE MODEL. An HTML "please log in" page, a
 * transfer cut short by a proxy, a CDN error document: all were written to the
 * sink, recorded as an installed model, and surfaced days later as a GGUF
 * format error pointing nowhere near the cause. What is checked now, and each
 * one against something the SERVER said rather than something this app
 * assumed:
 *
 *   CONTENT-TYPE  `text/html` is refused outright, before the body is read.
 *                 No model file is a web page, and the CDN interstitial is
 *                 the common case.
 *   THE FIRST BYTES  A body that opens `<!DOCTYPE`/`<html`/`<?xml` is a
 *                 document, whatever the content-type claimed. And where the
 *                 manifest names a format with documented magic — GGUF — the
 *                 file must start with it. This is the check that turns "the
 *                 engine says bad GGUF" into "the server sent a web page".
 *   THE OVERLAP   A continuation must re-deliver the last bytes on disk and
 *                 match them, as above.
 *   ONE SIZE      The size of the file is taken from the first response that
 *                 states one and is never restated. A later response that
 *                 contradicts it is not a continuation of this file: the sink
 *                 is emptied and the download starts again. A server cannot
 *                 shrink the target to match a truncated delivery.
 *   COMPLETENESS  The loop does not end because a response ended. It ends
 *                 when the sink holds `declared` bytes — so a server that
 *                 caps every response at a megabyte is resumed until the file
 *                 is whole, or runs out of attempts, and never resolves with
 *                 a fraction of it. `commit()` asserts the same thing at the
 *                 only point where a path is produced.
 *
 * WHICH HALF OF THE LENGTH CHECK CAN FIRE, MEASURED RATHER THAN ASSUMED. Both
 * were driven against a real `node:http` server before this was written:
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
 * What is left, and what the per-response check therefore exists for, is
 * `content-range`, which no client validates against the body: a `206`
 * declaring `bytes 0-99/1000` and delivering 100 bytes arrives CLEAN and
 * complete (MEASURED), and a `206` declaring `bytes 0-99/100` under
 * `content-length: 500` delivers 500 bytes for a 100-byte file. Those are the
 * two the code below actually stops.
 *
 * NOT CHECKED, deliberately and stated so nobody assumes otherwise:
 *
 *   There is NO CHECKSUM. The catalogue carries no digest, so a server that
 *   delivers exactly as many bytes as it promised, starting with the right
 *   magic and continuing from the right ones, is believed.
 *
 *   A server that declares NO length at all — chunked, no `content-length`,
 *   no `content-range` — leaves nothing to compare against, and that transfer
 *   is accepted when its body ends cleanly. Hugging Face always declares one.
 *
 *   `manifest.sizeBytes` IS NOT THE CHECK, and cannot be. It is the sum over
 *   every file in the download (`2_489_757_856 + 851_251_104` in the
 *   catalogue) and in one entry a round estimate (`2_600_000_000`). Compared
 *   against a single file it would fail every vision model, and rounded it
 *   would fail SD-Turbo. It is a PROGRESS HINT — a number to draw a bar
 *   against until the server states a real one — and it is passed under that
 *   name. It never reaches the `Intake`.
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
import { capabilities, unreachable } from '@/lib/platform';

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

/**
 * A continuation that does not continue what is on disk.
 *
 * The server answered a resume with bytes that disagree with the ones the
 * sink was already handed at that offset — a republished file behind a `Range`
 * request the server did not check `If-Range` against, which is the splice
 * with the right magic and the right length. `transfer` answers it by
 * truncating and fetching the file again from zero.
 *
 * A `DownloadRefused` on purpose: if a future edit ever lets one escape the
 * one place that handles it, the download FAILS rather than being retried
 * into the sink. Nothing that is not a whole file gets installed by default.
 */
class Spliced extends DownloadRefused {
  constructor(message: string) {
    super(message);
    this.name = 'Spliced';
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
 * How many leading bytes are HELD BACK — not peeked at — to identify what
 * arrived.
 *
 * Sixteen, which is more than any magic here needs and enough to recognise a
 * document opening. It was a peek in the previous round: the bytes sat in the
 * outgoing queue while a boolean recorded whether anyone had looked, and the
 * failure arm flushed the queue without asking. They are now in a queue the
 * sink cannot be reached from, which costs the same sixteen bytes and removes
 * the path. Nothing here grows with the file, so the memory bound is still
 * the one `FLUSH_BYTES` sets.
 */
const PROBE_BYTES = 16;

/**
 * How much of what is already on disk a resume asks for AGAIN.
 *
 * The last sixty-four bytes handed to the sink are re-requested and compared,
 * byte for byte, before a continuation is allowed to add anything — the only
 * thing in this file that can tell a genuine continuation from the tail of a
 * DIFFERENT build of the same model, which otherwise arrives with the right
 * magic (it is not at the head), the right length, and nothing wrong with it
 * anywhere a length or a format check can see.
 *
 * Sixty-four, because it is small enough to cost nothing on a resume — one
 * extra flush's worth of comparison, never a re-download — and wide enough
 * that two different builds agreeing across it is not a thing that happens to
 * compressed weights. It is not a proof: a republished file identical at that
 * offset passes, and the header says so.
 */
const OVERLAP_BYTES = 64;

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

/**
 * EXHAUSTIVE, NOT A TERNARY.
 *
 * This was `modelStore === 'filesystem' ? fs : opfs`, which means every value
 * that is not `'filesystem'` gets the WEB sink. That is how model weights
 * reached IndexedDB in the first place, and a row added to the capability
 * table without an arm here would have done it again — silently, on the one
 * platform nobody was testing. A fifth `ModelStore` is now a build failure on
 * this line.
 */
async function openSink(directory: string, filename: string): Promise<Sink> {
  const store = capabilities().modelStore;
  switch (store) {
    case 'filesystem':
      return openFilesystemSink(directory, filename);
    case 'opfs':
      return openOpfsSink(directory, filename);
    default:
      return unreachable(store, 'model store');
  }
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

/** What one HTTP attempt did with the body it was handed. */
type Attempt = 'ended' | 'restart';

/**
 * Everything about a transfer that is NOT about the bytes on disk.
 *
 * The byte count, the length the server stated and whether the file has been
 * identified are deliberately NOT here: those three decide whether a download
 * becomes an installed model, and they live inside the `Intake`, where the
 * only code that can move them is the code that writes.
 */
interface TransferState {
  /** Best known total FOR THE PROGRESS BAR. May be the manifest's guess. */
  total: number;
  /**
   * `ETag`/`Last-Modified` from the response THE BYTES ON DISK CAME FROM.
   *
   * Overwritten by every response that starts the file from zero and left
   * alone by a continuation, so it always describes the sink's current
   * contents rather than some earlier response's. A resume is only ever
   * attempted when this is non-null.
   */
  validator: string | null;
  rate: number;
}

/* ── The intake: one place that decides, one place that writes ───────── */

/**
 * THE ONLY THING IN THIS FILE THAT CAN PUT A BYTE IN A SINK.
 *
 * `fetchToStorage` opens the sink and hands it here; nothing else keeps a
 * reference, and no method returns one. That is the first half of the
 * structure. The second half is that the bytes on their way to it are held in
 * TWO queues:
 *
 *   `held`   arrived, NOT identified. Nothing drains this to the sink. The
 *            only code that empties it is `identify()`, which throws or moves
 *            it to `queue`, and `abandon()`, which drops it on the floor.
 *   `queue`  identified, on its way out. `flush()` — the one method that
 *            calls `sink.write` — reads this queue and no other.
 *
 * So "an unidentified byte reached the sink" is not a check that a later edit
 * can bypass by adding a path: there is no path. The catch arm of the read
 * loop calls `abandon()`, and `abandon()` cannot write `held` even though it
 * flushes — it does not have a route from one queue to the other. That is the
 * exact bug it replaces: `flush(Infinity)` in the failure arm used to write
 * bytes that `identify()` had never seen, because `identify()` was gated on a
 * counter and the flush ran first.
 *
 * A CONTINUATION IS IDENTIFIED TOO, just not by its opening — those bytes are
 * in the middle of a model. `expectContinuation()` puts the intake in
 * `stitch`, where the response must re-deliver the last `OVERLAP_BYTES` the
 * sink was given and match them byte for byte before anything new is queued.
 * A resume across a republished file — the splice that has the right magic
 * and the right length and is wrong inside — dies there.
 *
 * And the file's SIZE lives here rather than beside the loop, because
 * `commit()` is the only method that produces a path, and it produces one
 * only when the sink holds exactly the number of bytes the server stated.
 */
class Intake {
  /** Arrived, not identified. NO METHOD MOVES THIS TO THE SINK. */
  private held: Uint8Array[] = [];
  private heldBytes = 0;

  /** Identified, on the way out. The only queue `flush` can see. */
  private queue: Uint8Array[] = [];
  private queuedBytes = 0;

  private phase: 'head' | 'stitch' | 'open' = 'head';

  /** What a continuation has to re-deliver before it is believed. */
  private expected: Uint8Array = new Uint8Array(0);
  private matched = 0;

  private writtenBytes = 0;
  private declaredBytes: number | null = null;
  /** The last `OVERLAP_BYTES` the sink was handed. */
  private tail: Uint8Array = new Uint8Array(0);

  constructor(
    private readonly sink: Sink,
    /** ASCII the file must begin with, where the format documents it. */
    private readonly magic: string | undefined,
  ) {}

  /** Bytes the sink holds. The offset a resume continues from. */
  get written(): number {
    return this.writtenBytes;
  }

  /** The size of the whole file AS THE SERVER STATED IT, or null. */
  get declared(): number | null {
    return this.declaredBytes;
  }

  /** Everything accounted for, flushed or not. For the progress bar only. */
  get received(): number {
    return this.writtenBytes + this.queuedBytes + this.heldBytes;
  }

  /**
   * Does the sink hold exactly the file the server described?
   *
   * The loop breaks on this and `commit()` refuses without it — one
   * predicate, so "finished" and "installable" cannot drift apart.
   */
  get satisfied(): boolean {
    if (this.writtenBytes === 0) return false;
    return this.declaredBytes === null || this.writtenBytes === this.declaredBytes;
  }

  /** Why it is not satisfied, in the sentence the user reads. */
  shortfall(): string {
    if (this.writtenBytes === 0) {
      return 'The server sent an empty file. Nothing was installed.';
    }
    return `The download ended with ${this.writtenBytes} bytes where the server said ${this.declaredBytes}. Nothing was installed.`;
  }

  /**
   * State the size of the file. ONLY LEGAL ON AN EMPTY SINK.
   *
   * A size that could be restated mid-download is a size a server can shrink
   * to match a body it truncated, and the completeness check would then agree
   * with it. Restating one is a bug in this file, not a bad server, so it
   * throws rather than refusing the download.
   */
  declare(bytes: number | null): void {
    if (this.writtenBytes !== 0) {
      throw new Error('the size of a file already being written cannot be restated');
    }
    this.declaredBytes = bytes;
  }

  /** Is `bytes` the size this file has already been said to be? */
  agrees(bytes: number | null): boolean {
    return bytes === null || this.declaredBytes === null || bytes === this.declaredBytes;
  }

  /** Where a resume must start, so the sink's last bytes come back for checking. */
  resumeFrom(): number {
    return this.writtenBytes - this.tail.byteLength;
  }

  /**
   * The next bytes are the WHOLE FILE, to be identified by their opening.
   *
   * Only legal on an empty sink: appending a whole body to a partial one is
   * the corruption the `restart` arms exist to prevent, and this is where
   * that is unrepresentable rather than remembered.
   */
  expectWholeFile(): void {
    if (this.writtenBytes !== 0) {
      throw new Error('a whole file cannot be written onto a partial one');
    }
    this.phase = 'head';
    this.held = [];
    this.heldBytes = 0;
  }

  /** The next bytes CONTINUE what is on disk, and have to prove it. */
  expectContinuation(): void {
    this.phase = 'stitch';
    this.expected = this.tail;
    this.matched = 0;
    this.held = [];
    this.heldBytes = 0;
  }

  /** Take one chunk off the wire. Throws rather than admit a wrong byte. */
  async accept(chunk: Uint8Array): Promise<void> {
    let bytes = chunk;
    if (this.phase === 'stitch') bytes = this.overlap(bytes);
    if (bytes.byteLength === 0) return;

    if (this.phase === 'head') {
      this.held.push(bytes);
      this.heldBytes += bytes.byteLength;
      // Not enough to decide on yet, and nothing decides without enough.
      if (this.heldBytes < PROBE_BYTES) return;
      this.identify();
    } else {
      this.queue.push(bytes);
      this.queuedBytes += bytes.byteLength;
    }

    while (this.queuedBytes >= FLUSH_BYTES) await this.flush(FLUSH_BYTES);
  }

  /**
   * The body ended cleanly: what is held is all there will ever be.
   *
   * A body shorter than the probe window still gets a verdict here — without
   * that, a two-byte 200 was identified by nothing and installed.
   */
  async end(): Promise<void> {
    if (this.phase === 'head') this.identify();
    await this.flush(Infinity);
  }

  /**
   * The transfer failed part way through.
   *
   * Identified bytes are kept — that is what the next attempt resumes from —
   * and unidentified ones are DROPPED, so the next attempt starts from zero
   * and identifies the file properly instead of inheriting a verdict that was
   * never reached.
   */
  async abandon(): Promise<void> {
    this.held = [];
    this.heldBytes = 0;
    await this.flush(Infinity);
  }

  /** Truncate to empty and forget everything said about what was in it. */
  async reset(): Promise<void> {
    await this.sink.reset();
    this.held = [];
    this.heldBytes = 0;
    this.queue = [];
    this.queuedBytes = 0;
    this.writtenBytes = 0;
    this.declaredBytes = null;
    this.tail = new Uint8Array(0);
    this.phase = 'head';
  }

  /**
   * Close the sink and hand back the path — THE ONLY WAY TO GET ONE.
   *
   * There is no other method that returns a path and no accessor for the
   * sink, so "recorded as installed without being complete" has nowhere to
   * happen: the caller cannot name the file it would record.
   *
   * The refusal here cannot be reached by any server WHILE THE LOOP IS
   * CORRECT: the loop breaks on the same `satisfied`, so deleting this line
   * fails no fault-server test (revert-checked; it is pinned by a shape
   * assertion in the test file instead, which says so in as many words).
   *
   * It is not decoration. MEASURED: with the loop's exit reduced back to
   * `if (outcome === 'ended') break`, a server capping every response at a
   * megabyte stopped after the first one and THIS line refused it — "The
   * download ended with 1048576 bytes where the server said 9449529" —
   * instead of installing a ninth of a model. One predicate, consulted where
   * the loop ends and again where the path is produced, is what makes a
   * mistake in one of them an error message rather than a corrupt install.
   */
  async commit(): Promise<{ path: string; bytes: number }> {
    if (!this.satisfied) throw new DownloadRefused(this.shortfall());
    const path = await this.sink.close();
    return { path, bytes: this.writtenBytes };
  }

  /** Release the OS handle without producing a path. */
  async abort(): Promise<void> {
    await this.sink.close().catch(() => undefined);
  }

  /**
   * Compare a continuation against the tail it claims to follow.
   *
   * Returns whatever is left of the chunk once the overlap is accounted for.
   * The overlap itself is NOT written again — the sink already has those
   * bytes — so this is the one place bytes are dropped on purpose.
   */
  private overlap(chunk: Uint8Array): Uint8Array {
    const want = this.expected.byteLength - this.matched;
    const have = Math.min(want, chunk.byteLength);
    for (let at = 0; at < have; at += 1) {
      if (chunk[at] !== this.expected[this.matched + at]) {
        throw new Spliced(
          'The server continued this download with bytes that do not follow on from what it had already sent. The file may have been replaced mid-download.',
        );
      }
    }
    this.matched += have;
    if (this.matched === this.expected.byteLength) this.phase = 'open';
    return chunk.subarray(have);
  }

  /**
   * Decide what arrived, from its opening bytes, and release them.
   *
   * The `held` queue is emptied INTO `queue` here and nowhere else. Throwing
   * leaves it held and unwritten, and `abandon()` drops it.
   */
  private identify(): void {
    const head = ascii(peek(this.held, Math.min(this.heldBytes, PROBE_BYTES)));
    const lower = head.toLowerCase();
    if (DOCUMENT_OPENINGS.some((opening) => lower.startsWith(opening))) {
      throw new DownloadRefused(
        'The server returned a web page instead of the model file. The link may have expired, or the repository may need a token.',
      );
    }
    if (this.magic !== undefined && !head.startsWith(this.magic)) {
      throw new DownloadRefused(
        `The file the server sent is not a ${this.magic} model. Nothing was installed.`,
      );
    }
    this.phase = 'open';
    for (const part of this.held) this.queue.push(part);
    this.queuedBytes += this.heldBytes;
    this.held = [];
    this.heldBytes = 0;
  }

  /**
   * Hand the sink exactly `bytes`, or everything queued if `bytes` is
   * Infinity. THE ONLY CALL TO `sink.write` IN THIS FILE.
   *
   * EXACTLY, because the block size is the memory bound and a bound the
   * NETWORK gets to choose is not a bound. Chunk sizes from `fetch` are not
   * 64 KiB just because that is what the socket read: MEASURED against a local
   * server, undici coalesced them into blocks that overshot the flush
   * threshold enough to turn four appends into three. Taking a fixed block and
   * keeping the remainder makes the write size a property of this file.
   */
  private async flush(bytes: number): Promise<void> {
    const size = Math.min(bytes, this.queuedBytes);
    if (size === 0) return;
    const block = take(this.queue, size);
    this.queuedBytes -= size;
    await this.sink.write(block);
    this.writtenBytes += size;
    this.tail = keepTail(this.tail, block);
  }
}

/** The last `OVERLAP_BYTES` of `tail` followed by `block`, copied out. */
function keepTail(tail: Uint8Array, block: Uint8Array): Uint8Array {
  if (block.byteLength >= OVERLAP_BYTES) {
    return block.slice(block.byteLength - OVERLAP_BYTES);
  }
  const keep = Math.min(tail.byteLength, OVERLAP_BYTES - block.byteLength);
  const out = new Uint8Array(keep + block.byteLength);
  out.set(tail.subarray(tail.byteLength - keep), 0);
  out.set(block, keep);
  return out;
}

async function fetchToStorage(options: FetchOptions): Promise<{ path: string; bytes: number }> {
  const intake = new Intake(await openSink(options.directory, options.filename), options.magic);
  const state: TransferState = {
    total: options.progressHint,
    validator: null,
    rate: 0,
  };

  let consecutive = 0;
  let attempts = 0;

  /**
   * Score one attempt and say whether the budget is gone.
   *
   * Progress refunds it: an attempt that moved bytes earns the budget back,
   * so a flaky connection makes headway instead of burning three tries near
   * the end of a 6 GB file. `TOTAL_ATTEMPTS` bounds what that refund makes
   * possible — a server that sends a kilobyte and hangs up, every time.
   */
  const spent = (before: number): boolean => {
    consecutive = intake.written > before ? 0 : consecutive + 1;
    return consecutive >= CONSECUTIVE_ATTEMPTS || attempts >= TOTAL_ATTEMPTS;
  };

  try {
    for (;;) {
      throwIfCancelled(options.signal);
      attempts += 1;
      const before = intake.written;

      let outcome: Attempt;
      try {
        outcome = await transfer(options, intake, state);
      } catch (error) {
        throwIfCancelled(options.signal);
        if (!isRetryable(error)) throw error;
        if (spent(before)) throw error;
        await pause(options.retryDelayMs ?? 1000, options.signal);
        continue;
      }

      /*
       * THE LOOP DOES NOT END BECAUSE A RESPONSE ENDED.
       *
       * It ends when the sink holds the file. A server that answers every
       * request with at most a megabyte — honest `content-range`, clean end
       * of body, nothing to complain about per response — used to break this
       * loop on the first one and install a megabyte AS THE MODEL. There is
       * no per-response check that catches that, because no response
       * misbehaves; only the whole download does. So the exit condition is
       * the whole download's: `satisfied`, the same predicate `commit()`
       * refuses without.
       */
      if (outcome === 'ended' && intake.satisfied) break;

      const progressed = intake.written > before;
      if (spent(before)) {
        /*
         * A RESTART IS NOT A FAILURE, BUT IT IS NOT FREE EITHER.
         *
         * This arm used to be `consecutive = 0; continue;` — no budget, no
         * backoff, no ceiling. A server that answers 416 to EVERY request
         * (including the one with no `Range` header, which the restart just
         * made it) sent this loop round forever.
         */
        throw new DownloadRefused(
          outcome === 'restart'
            ? 'The server kept restarting this download instead of continuing it. Try again later.'
            : intake.shortfall(),
        );
      }
      // A response that ended short but MOVED is a transfer in progress, not
      // a server to back off from; only a stalled one is slept on.
      if (progressed) continue;
      await pause(options.retryDelayMs ?? 1000, options.signal);
    }

    options.onProgress(intake.written, state.total || intake.written, state.rate);
    return await intake.commit();
  } catch (error) {
    // The sink holds an OS handle; leaving it open would leak it and, on OPFS,
    // leave the file locked against the retry the user is about to press.
    await intake.abort();
    throw error;
  }
}

/**
 * One HTTP request, streamed into the intake.
 *
 * Every path through this function does exactly one of three things with the
 * body: cancels it unread, hands it to `consume` after telling the intake
 * WHICH KIND of bytes to expect, or throws. There is no fourth.
 */
async function transfer(
  options: FetchOptions,
  intake: Intake,
  state: TransferState,
): Promise<Attempt> {
  const headers: Record<string, string> = {};
  if (options.hfToken) headers.Authorization = `Bearer ${options.hfToken}`;

  /*
   * NO VALIDATOR, NO RESUME.
   *
   * `If-Range` is what lets a server notice that the file has been
   * republished since the prefix on disk was fetched and answer 200 with the
   * whole new body instead of a tail that does not belong to it. `ETag` and
   * `Last-Modified` are both OPTIONAL, so a server can leave nothing to send
   * — and this code used to send the `Range` anyway. Dropping what is on disk
   * and re-fetching costs bandwidth against a rare kind of server.
   *
   * It is not the whole guard, and the docstring above no longer says it is:
   * a server can ignore `If-Range` as easily as it can omit an `ETag`. What
   * catches THAT is the overlap the request below asks for.
   */
  if (intake.written > 0 && state.validator === null) await intake.reset();

  const resumeAt = intake.written > 0 ? intake.resumeFrom() : null;
  if (resumeAt !== null) {
    headers.Range = `bytes=${resumeAt}-`;
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
    await discard(response);
    await intake.reset();
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
    await discard(response);
    // The declared type is IN THE MESSAGE, and not for decoration. Without it
    // this refusal and the first-bytes one read identically, and a
    // revert-check could not tell which had fired — measured: deleting this
    // whole block left the suite green, because the probe caught the same page
    // and said the same sentence. It also happens to be the single most useful
    // fact in a bug report about a download that will not start.
    throw new DownloadRefused(
      `The server returned a web page (${contentType.split(';')[0]!.trim()}) instead of the model file. The link may have expired, or the repository may need a token.`,
    );
  }

  const range = parseContentRange(response.headers.get('content-range'));
  /**
   * The size of the WHOLE FILE as this response states it, or null.
   *
   * On a 206 that is the `/total` of the `content-range` — on the first
   * response as much as on a resumed one. It used to be parsed and thrown
   * away unless we were resuming, so a single unsolicited `206 bytes
   * 0-99/1000` carrying 100 bytes installed a fragment as the whole file:
   * `content-length` honestly described the fragment, and nothing else was
   * consulted.
   */
  const stated =
    response.status === 206
      ? range !== null && range.total > 0
        ? range.total
        : null
      : declaredLength(response);

  if (resumeAt !== null && response.status === 206) {
    /*
     * A 206 ANSWERING A RANGE NOBODY ASKED FOR, or describing a different
     * file than the one being downloaded.
     *
     * A range that starts elsewhere used to fall in with the 200 case and its
     * body was consumed AS THE WHOLE FILE — a slice from the middle of a
     * model, written from offset zero, with a `content-length` that honestly
     * describes the slice so every length check agrees. And a `/total` that
     * disagrees with the size already stated describes some other file: a
     * smaller one lets a server shrink the target to match a truncation, a
     * larger one is a republish. Neither is a continuation of this download.
     */
    if (range === null || range.start !== resumeAt || !intake.agrees(stated)) {
      await discard(response);
      await intake.reset();
      return 'restart';
    }
    if (stated !== null) state.total = stated;
    intake.expectContinuation();
    /*
     * WHAT THIS RESPONSE PROMISED, AND ONLY THAT.
     *
     * The extent of its own `content-range` — not "the rest of the file",
     * which is the DOWNLOAD's business and is settled by `satisfied` in the
     * loop. Holding one response to the whole remainder collapses the two
     * questions into one number, and then a server that answers honestly with
     * a megabyte at a time looks like a broken response instead of a short
     * download. Answering them separately is what lets this file resume such
     * a server to the end and still refuse a fraction of it.
     */
    const mustDeliver = range.end - range.start + 1;
    try {
      return await consume(options, intake, state, response, mustDeliver);
    } catch (error) {
      // The overlap did not match: these bytes are not this file's. Nothing
      // of them was written — the intake queues nothing until the overlap is
      // through — so this drops the prefix and starts the download again
      // rather than keeping a head that a later tail will not fit.
      if (!(error instanceof Spliced)) throw error;
      await intake.reset();
      return 'restart';
    }
  }

  if (resumeAt !== null) {
    // The server ignored `Range`, or `If-Range` failed and it sent the whole
    // CURRENT file. Either way the prefix on disk belongs to a file we can no
    // longer vouch for, and the body in hand is a complete one.
    await intake.reset();
  } else if (response.status === 206 && (range === null || range.start !== 0)) {
    /*
     * A 206 TO A REQUEST THAT CARRIED NO RANGE.
     *
     * RFC 9110 makes 206 an answer to a range request, so an unsolicited one
     * is a broken server — and its body is a FRAGMENT that this code would
     * otherwise write from offset zero and call the file. A `content-range`
     * starting at 0 is harmless (it is the whole file with extra ceremony);
     * anything else is a slice of a model presented as the model.
     */
    await discard(response);
    throw new DownloadRefused(
      'The server answered with part of the file when the whole one was asked for. Nothing was installed.',
    );
  }

  /*
   * FROM ZERO. The validator is taken from THIS response, because these are
   * the bytes that will be on disk — a resume must be checked against the
   * response its prefix came from, not against whichever one answered first.
   */
  state.validator = response.headers.get('etag') ?? response.headers.get('last-modified');
  intake.declare(stated);
  state.total = stated ?? (state.total || options.progressHint);
  intake.expectWholeFile();
  // Again: what THIS response promised. A 206 starting at zero promises its
  // own extent, which is not necessarily the file — see above.
  return await consume(
    options,
    intake,
    state,
    response,
    range !== null && response.status === 206 ? range.end - range.start + 1 : stated,
  );
}

/** Read a body nobody is going to keep, so the socket can be reused. */
async function discard(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

/** `content-length`, or null when the server declared none. */
function declaredLength(response: Response): number | null {
  const header = response.headers.get('content-length');
  if (header === null) return null;
  const value = Number(header);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * Drain the body into the intake.
 *
 * This function does not know how to write to a sink and cannot be made to:
 * it hands chunks to `accept` and asks for the tally afterwards.
 */
async function consume(
  options: FetchOptions,
  intake: Intake,
  state: TransferState,
  response: Response,
  mustDeliver: number | null,
): Promise<Attempt> {
  const reader = response.body!.getReader();
  let received = 0;
  let windowStart = performance.now();
  let windowBytes = 0;

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

      received += value.byteLength;
      await intake.accept(value);

      windowBytes += value.byteLength;
      const elapsed = performance.now() - windowStart;
      if (elapsed >= 500) {
        state.rate = (windowBytes / elapsed) * 1000;
        windowStart = performance.now();
        windowBytes = 0;
        // Reported from the wire, not from the sink, so the number moves
        // between flushes.
        options.onProgress(intake.received, state.total, state.rate);
      }
    }
    // End of body: whatever is held is the whole of what arrived, however
    // short, and it still has to be identified before it counts.
    await intake.end();
  } catch (error) {
    // Whatever was IDENTIFIED before the failure is kept and counted, so the
    // retry resumes from there. Whatever was not is dropped — `abandon()` has
    // no route from the held queue to the sink, which is the difference
    // between this and the `flush(Infinity)` that used to be here.
    await intake.abandon().catch(() => undefined);
    await reader.cancel().catch(() => undefined);
    throw error;
  }

  /*
   * WHAT ARRIVED VERSUS WHAT WAS PROMISED, FOR THIS RESPONSE.
   *
   * Counted on the WIRE rather than at the sink: a continuation re-sends the
   * overlap, which the sink already has and does not write again, and a
   * response is answerable for the bytes it sent.
   *
   * `fetch` resolves the stream cleanly when a proxy ends a body early with a
   * `content-length` still claiming more, so "the loop finished" is not "the
   * file is here". SHORT is retryable — it is a truncated transfer, and the
   * resume above is exactly the machinery for it. LONGER is refused outright:
   * the extra bytes are already in the sink, no `Range` request can un-write
   * them, and a server sending more than it declared is not one to take a
   * second answer from.
   */
  if (mustDeliver !== null && received !== mustDeliver) {
    if (received > mustDeliver) {
      throw new DownloadRefused(
        `The server sent ${received} bytes where it declared ${mustDeliver}. Nothing was installed.`,
      );
    }
    throw new IncompleteTransfer(
      `The transfer ended after ${received} of ${mustDeliver} bytes.`,
    );
  }

  return 'ended';
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
 * sink. Identification must not consume what it looks at — those bytes are the
 * start of the file, and they are still in the queue that has no route to the
 * sink until the verdict releases them.
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

/**
 * `bytes 1048576-1048591/436806912` -> `{start, end, total}`.
 *
 * All three matter and they answer different questions. `start` says whether
 * this is the part that was asked for, `end` says how much THIS RESPONSE
 * promises, and `total` says how big the file is. Conflating the last two is
 * how a server that answers every request with an honest megabyte of a nine
 * megabyte model got its first megabyte installed as the whole thing.
 */
function parseContentRange(
  header: string | null,
): { start: number; end: number; total: number } | null {
  const match = /^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec((header ?? '').trim());
  if (!match) return null;
  return {
    start: Number(match[1]),
    end: Number(match[2]),
    total: match[3] === '*' ? 0 : Number(match[3]),
  };
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

/** The other half of the same dispatch, and exhaustive for the same reason. */
export async function deleteModelFiles(manifest: ModelManifest): Promise<void> {
  const directory = modelDirectory(manifest);
  const store = capabilities().modelStore;
  switch (store) {
    case 'filesystem':
      await Filesystem.rmdir({
        path: directory,
        directory: Directory.Data,
        recursive: true,
      }).catch(() => undefined);
      return;
    case 'opfs':
      try {
        const parent = await opfsDirectory(`${MODEL_DIR}/${manifest.engine}`);
        await parent.removeEntry(manifest.id, { recursive: true });
      } catch {
        // Already gone.
      }
      return;
    default:
      return unreachable(store, 'model store');
  }
}

/**
 * Bytes used by downloaded models, and what the device can spare.
 *
 * THE FIFTH PLATFORM-BLIND SITE. This called `navigator.storage.estimate()`
 * unconditionally, and the layering guard could not see it because it names no
 * platform. `estimate()` describes the ORIGIN'S QUOTA — the browser's storage
 * bucket — which on the web is exactly where OPFS models live and on every
 * packaged platform is somewhere the models are NOT. In a WKWebView or an
 * Android WebView it reports the webview's own allowance while gigabytes of
 * weights sit in `Directory.Data` outside it, so the meter read a number that
 * had nothing to do with the models it was labelled for. Three platforms out
 * of four.
 *
 * `knownBytes` is what the caller already knows it downloaded, and on a real
 * filesystem it is the ONLY honest number available: `@capacitor/filesystem`
 * exposes no free-space call, and the desktop shell REFUSES `stat` by name
 * (`FILESYSTEM_REFUSED` in `apps/desktop/src/fs/filesystem.ts`). A quota of 0
 * means "not known" and the UI shows a plain figure instead of a meter with a
 * fabricated denominator — a bar against a made-up maximum is worse than no
 * bar.
 */
export async function storageEstimate(
  knownBytes: number,
): Promise<{ used: number; quota: number }> {
  const store = capabilities().modelStore;
  switch (store) {
    case 'opfs': {
      // The browser's bucket IS where OPFS models are, so its numbers are the
      // right ones — including other origins' overhead, which is real too.
      if (!navigator.storage?.estimate) return { used: knownBytes, quota: 0 };
      const estimate = await navigator.storage.estimate();
      return { used: estimate.usage ?? knownBytes, quota: estimate.quota ?? 0 };
    }
    case 'filesystem':
      return { used: knownBytes, quota: 0 };
    default:
      return unreachable(store, 'model store');
  }
}
