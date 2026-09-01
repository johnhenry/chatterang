/**
 * The model downloader, driven end to end against a real HTTP server and the
 * REAL desktop filesystem plugin.
 *
 * WHY THIS FILE EXISTS AT ALL. There was no `tests/download.test.ts`. The one
 * module that writes multi-gigabyte files, chooses a platform branch, and
 * handles cancellation had no test of any kind, and all three were broken:
 *
 *   - it buffered the ENTIRE model in renderer memory before writing a byte
 *     (measured: 2.1x the payload in RSS, ~13.8 GB for the 6.5 GB model),
 *   - `cancelInstall` aborted the fetch and left the partial file on disk with
 *     a `state:'failed'` record and a red toast reading "BodyStreamBuffer was
 *     aborted", because the abort path it relied on is unreachable,
 *   - and its docstring claimed downloads were "resumable where the server
 *     allows it" while the file contained no `Range` header at all.
 *
 * WHAT IS REAL HERE, AND WHY IT HAS TO BE. Nothing about the write path is
 * simulated: `@capacitor/filesystem` is routed to `createFilesystemPlugin`
 * from `apps/desktop`, against a real temporary directory, so every assertion
 * about bytes on disk is an assertion about the code that will run in the
 * shell — including its base64 validator, which is the piece this repo has
 * already been burned by. That validator passed every unit test it had and
 * threw `RangeError` on the size the app actually sends, because every unit
 * test used a short string. So the payload here is MEGABYTES, chunked the way
 * a network chunks one, and the base64 the downloader emits is handed to the
 * real validator at the real flush size.
 *
 * The server is a real `node:http` server and the client is the real `fetch`,
 * so `Range`, `206`, `If-Range`, `416` and a socket destroyed mid-body are the
 * genuine article rather than a mock's idea of them.
 *
 * FAULTS INJECTED, one at a time, each reverted after — every one produced a
 * non-zero exit, and the observed failure is recorded beside the test it broke.
 * See the commit message for the full list.
 */

import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PluginImplementation } from '@chatterang/desktop/bridge';
import { createFilesystemPlugin } from '@chatterang/desktop/fs/filesystem';

import type { ModelManifest } from '@/domain/manifest';

/* ── The platform, and the bridge under it ───────────────────────────── */

const platform = vi.hoisted(() => ({ id: 'electron' }));

vi.mock('@capacitor/core', async (importActual) => {
  const actual = await importActual<typeof import('@capacitor/core')>();
  return {
    ...actual,
    Capacitor: {
      ...actual.Capacitor,
      getPlatform: () => platform.id,
      isNativePlatform: () => platform.id !== 'web',
    },
  };
});

/**
 * `@capacitor/filesystem`, wired to the desktop implementation.
 *
 * This is what the bridge does in the shell: the renderer's `Filesystem.*`
 * call becomes one options object crossing to a plugin method in main. The
 * enums come from the real package, so `Directory.Data` is whatever the
 * package says it is rather than what this test assumes.
 */
const bridge = vi.hoisted(() => ({
  plugin: null as unknown as PluginImplementation | null,
  calls: [] as { method: string; dataLength: number }[],
  events: [] as string[],
}));

vi.mock('@capacitor/filesystem', async (importActual) => {
  const actual = await importActual<typeof import('@capacitor/filesystem')>();
  const Filesystem = new Proxy(
    {},
    {
      get:
        (_target, method: string) =>
        async (options: Record<string, unknown> = {}): Promise<unknown> => {
          const data = options['data'];
          bridge.calls.push({
            method,
            dataLength: typeof data === 'string' ? data.length : -1,
          });
          bridge.events.push(`fs:${method}`);
          if (!bridge.plugin) throw new Error('no filesystem on this platform');
          const impl = bridge.plugin[method];
          if (!impl) throw new Error(`desktop filesystem has no "${method}"`);
          return impl(options);
        },
    },
  );
  return { ...actual, Filesystem };
});

/* ── The store's dependencies ────────────────────────────────────────── */

const store = vi.hoisted(() => ({
  rows: new Map<string, unknown>(),
  settings: new Map<string, unknown>(),
  toasts: [] as { message: string; tone: string | undefined }[],
}));

vi.mock('@/db', () => ({
  db: {
    models: {
      toArray: async () => [...store.rows.values()],
      put: async (row: { id: string }) => {
        store.rows.set(row.id, row);
      },
      delete: async (id: string) => {
        bridge.events.push('db:delete');
        store.rows.delete(id);
      },
    },
    settings: {
      get: async (key: string) => store.settings.get(key),
      put: async (row: { key: string }) => {
        store.settings.set(row.key, row);
      },
    },
  },
}));

vi.mock('@/state/app', () => ({
  installResolver: () => undefined,
  useApp: {
    getState: () => ({
      toast: (message: string, tone?: string) => store.toasts.push({ message, tone }),
      settings: { hfToken: '' },
    }),
  },
}));

const { DownloadCancelled, deleteModelFiles, downloadModel, storageEstimate } =
  await import('@/lib/download');
const { useModels } = await import('@/state/models');

/* ── An in-memory OPFS, for the web row ──────────────────────────────── */

interface FakeDir {
  dirs: Map<string, FakeDir>;
  files: Map<string, Uint8Array>;
}

function makeOpfs(): { root: FakeDir; install: () => void } {
  const root: FakeDir = { dirs: new Map(), files: new Map() };

  const handleFor = (dir: FakeDir): FileSystemDirectoryHandle =>
    ({
      async getDirectoryHandle(name: string, options?: { create?: boolean }) {
        let child = dir.dirs.get(name);
        if (!child) {
          if (!options?.create) throw new Error('NotFoundError');
          child = { dirs: new Map(), files: new Map() };
          dir.dirs.set(name, child);
        }
        return handleFor(child);
      },
      async getFileHandle(name: string, options?: { create?: boolean }) {
        if (!dir.files.has(name)) {
          if (!options?.create) throw new Error('NotFoundError');
          dir.files.set(name, new Uint8Array(0));
        }
        return {
          async createWritable() {
            // `createWritable()` truncates by default — the behaviour the
            // reset path depends on.
            dir.files.set(name, new Uint8Array(0));
            return {
              async write(chunk: Uint8Array) {
                const before = dir.files.get(name)!;
                const next = new Uint8Array(before.byteLength + chunk.byteLength);
                next.set(before, 0);
                next.set(chunk, before.byteLength);
                dir.files.set(name, next);
              },
              async close() {},
            };
          },
        };
      },
      async removeEntry(name: string) {
        if (!dir.dirs.delete(name) && !dir.files.delete(name)) throw new Error('NotFoundError');
      },
    }) as unknown as FileSystemDirectoryHandle;

  return {
    root,
    install: () => {
      Object.defineProperty(navigator, 'storage', {
        value: { getDirectory: async () => handleFor(root) },
        configurable: true,
      });
    },
  };
}

/* ── A real HTTP server that can misbehave on purpose ────────────────── */

interface Recorded {
  range: string | undefined;
  ifRange: string | undefined;
  authorization: string | undefined;
}

interface ServerPlan {
  body: Buffer;
  /** A body that changes between attempts — a file republished mid-download. */
  bodyAt?: (attempt: number) => Buffer;
  etag?: string;
  /** A validator that CHANGES between attempts — a file republished mid-download. */
  etagAt?: (attempt: number) => string;
  /** The other validator. `If-Range` accepts either, so both are exercised. */
  lastModified?: string;
  /** Bytes to send before destroying the socket, per 0-based request index. */
  dropAfter?: (attempt: number) => number | null;
  /** Answer a `Range` request with the whole body and a 200. */
  ignoreRange?: boolean;
  /** Answer every request with this status and no body. */
  status?: number;
  /** Resolved once the first chunk of the first response has been written. */
  onFirstChunk?: () => void;
  /** Bytes to send before waiting on `gate`. */
  gateAfter?: number;
  /** Awaited mid-body, so the response can be held open on purpose. */
  gate?: Promise<void>;

  /* ── Ways to misbehave ─────────────────────────────────────────────── */

  /**
   * Answer with this instead of the model — a CDN interstitial, an error
   * document, a "please log in" page. A well-formed 200 with an honest
   * `content-length`, which is what makes it dangerous.
   */
  instead?: { body: Buffer; contentType?: string };
  /**
   * 416 to EVERY request, including one carrying no `Range` at all.
   *
   * This is the infinite-restart case and it is not hypothetical arithmetic:
   * the 416 arm truncates the sink and puts `written` back to zero, so the
   * next request carries no range, so the next answer is another 416.
   */
  always416?: boolean;
  /**
   * Add this to the declared `content-length`, so the header lies.
   *
   * The socket is DESTROYED after the short body rather than left open.
   * MEASURED with `res.end()` instead: Node holds the connection waiting for
   * the bytes it promised and the client gives up after its own timeout — six
   * seconds per attempt, so a forty-attempt ceiling takes four minutes to
   * prove. A truncating proxy closes; this models that.
   */
  lengthDelta?: number;
  /**
   * Add this to the `/total` of a `content-range`. Negative makes the response
   * deliver MORE than the file it claims to be part of — the one over-delivery
   * an HTTP client does not clamp, because no client validates a body against
   * `content-range`.
   */
  rangeTotalDelta?: number;
  /**
   * Answer with a 206 whose `content-range` starts 4 KiB from where it should,
   * while the body is still the slice actually asked for. Attempt-aware, so a
   * server can behave until the resume and then not.
   */
  mismatchRange?: (attempt: number) => boolean;
  /**
   * Answer a resume with `content-range: bytes N-M/*` — a range whose TOTAL is
   * unknown — and serve exactly this many bytes, ending cleanly.
   *
   * A perfectly legal response, and the blind spot the per-response length
   * check has: the response keeps every promise it made, and only the
   * DOWNLOAD is short. What answers it is the size the FIRST response stated,
   * which the intake holds and the loop will not stop short of.
   */
  starRange?: (attempt: number) => number | null;
  /**
   * Answer EVERY request — ranged or not — with a 206 carrying at most this
   * many bytes and an honest `content-range`.
   *
   * The truncation that no per-response check can see: every response is
   * well-formed, ends cleanly, and delivers exactly what its own headers
   * promise. Only the download as a whole is a fraction of the file.
   */
  capBytes?: number;
  /**
   * Append this many bytes to a ranged response and declare them in
   * `content-length`, leaving `content-range` honest.
   *
   * The over-delivery no client clamps: undici truncates a body longer than
   * `content-length`, so the only way to get more bytes into the sink than
   * the file has room for is to declare them and contradict `content-range`.
   */
  overDeliver?: number;
  /**
   * Write the FIRST KILOBYTE of each body in pieces this size.
   *
   * A connection can only die inside the probe window if the server writes
   * inside it, and 64 KiB chunks step straight over sixteen bytes. Only the
   * first kilobyte is written this finely: a whole 9 MB model at one byte per
   * event-loop turn is a test that never finishes (MEASURED — it did not).
   */
  chunkBytes?: number;
}

interface Harness {
  url: string;
  requests: Recorded[];
  close: () => Promise<void>;
}

const CHUNK = 64 * 1024;

async function serve(plan: ServerPlan): Promise<Harness> {
  const requests: Recorded[] = [];
  let attempt = -1;

  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    attempt += 1;
    const index = attempt;
    requests.push({
      range: req.headers.range,
      ifRange: req.headers['if-range'] as string | undefined,
      authorization: req.headers.authorization,
    });

    if (plan.status && plan.status >= 400) {
      res.writeHead(plan.status);
      res.end();
      return;
    }

    if (plan.always416) {
      res.writeHead(416, { 'content-range': `bytes */${plan.body.length}` });
      res.end();
      return;
    }

    if (plan.instead) {
      res.writeHead(200, {
        'content-length': String(plan.instead.body.length),
        'content-type': plan.instead.contentType ?? 'application/octet-stream',
      });
      res.end(plan.instead.body);
      return;
    }

    const body = plan.bodyAt?.(index) ?? plan.body;
    const etag = plan.etagAt?.(index) ?? plan.etag;
    const rangeHeader = plan.ignoreRange ? undefined : req.headers.range;
    const match = /^bytes=(\d+)-$/.exec(rangeHeader ?? '');
    let start = 0;
    if (match) {
      start = Number(match[1]);
      if (start >= body.length) {
        res.writeHead(416, { 'content-range': `bytes */${body.length}` });
        res.end();
        return;
      }
    }

    /*
     * A SERVER THAT CAPS EVERY RESPONSE, and is honest about it.
     *
     * `content-range: bytes START-(START+CAP-1)/TOTAL` with a `content-length`
     * that matches, ending cleanly. Every per-response check agrees with it —
     * because the response is not the thing that is wrong. Only the DOWNLOAD
     * is short, and only something that looks at the whole download can say
     * so. Answered to a request with no `Range` as well, which is legal for a
     * 206 starting at zero and is how the first megabyte arrives.
     */
    if (plan.capBytes !== undefined) {
      const part = body.subarray(start, start + plan.capBytes);
      const total = body.length + (plan.rangeTotalDelta ?? 0);
      res.writeHead(206, {
        'content-length': String(part.length),
        'accept-ranges': 'bytes',
        'content-type': 'application/octet-stream',
        'content-range': `bytes ${start}-${start + part.length - 1}/${total}`,
        ...(etag ? { etag } : {}),
      });
      res.end(part);
      return;
    }

    const slice = body.subarray(start);
    /** The body actually written, which is not always the slice asked for. */
    const outgoing =
      match && plan.overDeliver
        ? Buffer.concat([slice, Buffer.alloc(plan.overDeliver, 7)])
        : slice;
    const headers: Record<string, string> = {
      'content-length': String(outgoing.length + (plan.lengthDelta ?? 0)),
      'accept-ranges': 'bytes',
      'content-type': 'application/octet-stream',
    };
    if (etag) headers.etag = etag;
    if (plan.lastModified) headers['last-modified'] = plan.lastModified;
    const starBytes = match ? (plan.starRange?.(index) ?? null) : null;
    if (starBytes !== null) {
      const part = slice.subarray(0, starBytes);
      res.writeHead(206, {
        'content-length': String(part.length),
        'accept-ranges': 'bytes',
        'content-type': 'application/octet-stream',
        'content-range': `bytes ${start}-${start + part.length - 1}/*`,
        ...(etag ? { etag } : {}),
      });
      res.end(part);
      return;
    }

    const mismatched = plan.mismatchRange?.(index) ?? false;
    if (match || mismatched) {
      const total = body.length + (plan.rangeTotalDelta ?? 0);
      // 4 KiB off: a range nobody asked for, with the body of the one they did.
      const from = mismatched ? start + 4096 : start;
      headers['content-range'] = `bytes ${from}-${body.length - 1}/${total}`;
      res.writeHead(206, headers);
    } else {
      res.writeHead(200, headers);
    }

    const limit = plan.dropAfter?.(index) ?? null;
    const chunk = plan.chunkBytes ?? CHUNK;
    let sent = 0;
    let first = true;
    let gated = false;
    for (let at = 0; at < outgoing.length; at += at < 1024 ? chunk : CHUNK) {
      if (limit !== null && sent >= limit) {
        // A connection that dies mid-body: no FIN, no trailer, exactly what a
        // dropped Wi-Fi link looks like to `fetch`.
        res.destroy();
        return;
      }
      const piece = outgoing.subarray(at, at + (at < 1024 ? chunk : CHUNK));
      res.write(piece);
      sent += piece.length;
      if (first) {
        first = false;
        plan.onFirstChunk?.();
      }
      if (!gated && plan.gate && sent >= (plan.gateAfter ?? 0)) {
        gated = true;
        await plan.gate;
      }
      // Yield, so the client reads while the server writes rather than
      // receiving one buffered blob at the end.
      await new Promise((resolve) => setImmediate(resolve));
    }
    if (plan.lengthDelta) {
      res.destroy();
      return;
    }
    res.end();
  };

  const server: Server = createServer((req, res) => {
    void handler(req, res).catch(() => res.destroy());
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };

  return {
    url: `http://127.0.0.1:${port}/model.gguf`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

/* ── Fixture ─────────────────────────────────────────────────────────── */

const FLUSH = 3 * 1024 * 1024;
/** Three whole flushes and a partial tail — the shape a real file has. */
const PAYLOAD_BYTES = 3 * FLUSH + 12_345;
/**
 * `CONSECUTIVE_ATTEMPTS` from `lib/download.ts`, as a request count.
 *
 * Named here rather than written as a bare `3`, because these assertions exist
 * to prove a loop TERMINATES: a ceiling nobody can trace back to the constant
 * it mirrors is a ceiling that drifts.
 */
const CONSECUTIVE_CEILING = 3;

let base: string;
let dataRoot: string;
let payload: Buffer;
let servers: Harness[];

function manifest(overrides: Partial<ModelManifest> = {}): ModelManifest {
  return {
    id: 'test-model',
    name: 'Test Model',
    author: 'test',
    description: 'a model',
    engine: 'llama-cpp',
    format: 'gguf',
    quantization: 'Q4_K_M',
    capabilities: ['text'],
    sizeBytes: PAYLOAD_BYTES,
    minRAM: 1,
    recommendedRAM: 1,
    recommendedBackend: 'cpu',
    contextLength: 4096,
    license: 'Apache-2.0',
    source: { repo: 'test/repo', file: 'model.gguf', url: 'http://127.0.0.1:0/model.gguf' },
    ...overrides,
  } as ModelManifest;
}

function withUrl(url: string, overrides: Partial<ModelManifest> = {}): ModelManifest {
  const m = manifest(overrides);
  return { ...m, source: { ...m.source, url } };
}

const modelPath = (m: ModelManifest, file = 'model.gguf'): string =>
  join(dataRoot, 'models', m.engine, m.id, file);

const sha = (bytes: Uint8Array | Buffer): string =>
  createHash('sha256').update(Buffer.from(bytes)).digest('hex');

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'chatterang-dl-')));
  dataRoot = join(base, 'data');
  mkdirSync(join(dataRoot, 'models'), { recursive: true });
  bridge.plugin = createFilesystemPlugin({ roots: new Map([['DATA', dataRoot]]) });
  bridge.calls = [];
  bridge.events = [];
  store.rows.clear();
  store.settings.clear();
  store.toasts = [];
  platform.id = 'electron';
  // A GGUF FILE, not just bytes of the right length. The downloader now
  // identifies what arrived from its first four bytes — that is how a CDN
  // interstitial is caught at download time instead of surfacing days later as
  // "bad GGUF" — so a fixture of pure noise would be refused, correctly.
  payload = Buffer.concat([Buffer.from('GGUF', 'latin1'), randomBytes(PAYLOAD_BYTES - 4)]);
  servers = [];
  useModels.setState({ installed: {}, progress: {}, activeModelId: null });
});

afterEach(async () => {
  for (const server of servers) await server.close();
  rmSync(base, { recursive: true, force: true });
});

async function start(plan: Partial<ServerPlan> & { body?: Buffer } = {}): Promise<Harness> {
  const harness = await serve({ body: payload, etag: '"v1"', ...plan });
  servers.push(harness);
  return harness;
}

/* ── Streaming ───────────────────────────────────────────────────────── */

describe('a model is streamed to disk, not assembled in memory first', () => {
  it('writes the exact bytes the server sent, through the real desktop plugin', async () => {
    // FAULT INJECTED: the flush writes `take(...).subarray(0, -1)`, one byte
    // short per block. Observed: 9,449,525 bytes on disk instead of 9,449,529,
    // exit 1. The comparison is on CONTENT as well as length, so a reordering
    // that preserved the size would fail it too.
    const server = await start();
    const result = await downloadModel({ manifest: withUrl(server.url), retryDelayMs: 0 });

    const written = readFileSync(modelPath(withUrl(server.url)));
    expect(written.length).toBe(PAYLOAD_BYTES);
    expect(sha(written)).toBe(sha(payload));
    expect(result.totalBytes).toBe(PAYLOAD_BYTES);
    // `getUri` answers a bare absolute path on desktop, and that is the string
    // the store hands the inference host.
    expect(result.paths.model).toBe(modelPath(withUrl(server.url)));
  });

  it('hands the sink bounded blocks — never the whole model', async () => {
    /*
     * THE ASSERTION THE OLD CODE COULD NOT PASS. It pushed every chunk into an
     * array and called `writeFile` once with a Blob of the lot, so the peak was
     * the file size (measured at 2.1x in an Electron renderer). Now the largest
     * thing that crosses the bridge is one flush.
     *
     * FAULT INJECTED: `FLUSH_BYTES` raised to 64 MiB, past the payload size.
     * Observed: ONE `appendFile` instead of four — the whole model in a single
     * base64 string, which is the old behaviour with extra steps. Exit 1.
     */
    const server = await start();
    await downloadModel({ manifest: withUrl(server.url), retryDelayMs: 0 });

    const appends = bridge.calls.filter((call) => call.method === 'appendFile');
    expect(appends).toHaveLength(4); // three whole flushes and the tail

    // 3 MiB of bytes is exactly 4 MiB of base64, with no padding: 3 divides
    // the flush size, which is why that number was chosen.
    const biggest = Math.max(...appends.map((call) => call.dataLength));
    expect(biggest).toBe(4 * 1024 * 1024);
    expect(biggest).toBeLessThan(PAYLOAD_BYTES);

    // And every one of them is base64 the desktop validator accepts: it
    // rejects anything whose length is not a multiple of four, and it is the
    // piece that has already shipped a critical bug by only ever being tested
    // on short strings.
    for (const call of appends) expect(call.dataLength % 4).toBe(0);
  });

  it('writes while the response is still open, rather than at the end', async () => {
    /*
     * "Bounded blocks" alone does not prove streaming: code that buffered the
     * whole model and then wrote it out in 3 MiB pieces at the end would pass
     * the test above. This one HOLDS THE RESPONSE OPEN after one flush's worth
     * of body, so a write can only be observed if it happened DURING the
     * transfer.
     *
     * FAULT INJECTED: the in-loop `while (this.queuedBytes >= FLUSH_BYTES)`
     * flush removed from `Intake.accept`, leaving only the flush in `end()`.
     * Observed: no append in three seconds, the race resolved
     * 'nothing-written-in-3s', exit 1.
     */
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const server = await start({ gate, gateAfter: FLUSH + CHUNK });
    const pending = downloadModel({ manifest: withUrl(server.url), retryDelayMs: 0 });

    try {
      const outcome = await Promise.race([
        (async () => {
          for (;;) {
            if (bridge.calls.some((call) => call.method === 'appendFile')) {
              return 'wrote-during-transfer';
            }
            await new Promise((resolve) => setTimeout(resolve, 5));
          }
        })(),
        new Promise((resolve) => setTimeout(() => resolve('nothing-written-in-3s'), 3000)),
      ]);
      expect(outcome).toBe('wrote-during-transfer');
    } finally {
      release();
      await pending;
    }
  });
});

/* ── Cancellation ────────────────────────────────────────────────────── */

describe('cancelling a download', () => {
  it('rejects with DownloadCancelled, not with the abort error', async () => {
    /*
     * THE BUG THE USER HIT. An aborted fetch REJECTS the pending
     * `reader.read()`; it does not return `{done:true}`. MEASURED against a
     * local server before this was written: `AbortError: This operation was
     * aborted`. The downloader's `if (options.signal?.aborted)` sat AFTER that
     * read, so it never ran, `DownloadCancelled` was never thrown, and the
     * store took the failure arm instead.
     *
     * FAULT INJECTED: `throwIfCancelled` removed from the retry loop's catch,
     * restoring the old post-read check. Observed: the download rejected with
     * a `DOMException` — `AbortError: This operation was aborted` — instead of
     * `DownloadCancelled`, which is precisely the error the user saw in a red
     * toast. Exit 1.
     */
    const controller = new AbortController();
    const server = await start({ onFirstChunk: () => controller.abort() });

    await expect(
      downloadModel({ manifest: withUrl(server.url), signal: controller.signal, retryDelayMs: 0 }),
    ).rejects.toBeInstanceOf(DownloadCancelled);
  });

  it('deletes the partial file and the record, files first', async () => {
    /*
     * Cancel used to leave the partial file on disk AND a `state:'failed'`
     * record, and now that the cancellation path actually runs, the ORDER
     * matters: `remove()` returns early on `if (!record) return`, so deleting
     * the record first would strand the directory forever.
     *
     * The companion file is not incidental. Every vision model in the
     * catalogue has one, so a cancel during the second file leaves a COMPLETED
     * first file behind — which is why the cleanup deletes the model's whole
     * directory rather than the file it happened to be writing.
     *
     * FAULT INJECTED: `deleteModelFiles` moved after `db.models.delete`.
     * Observed: `['db:delete','fs:rmdir']`, exit 1.
     * FAULT INJECTED: `deleteModelFiles` removed entirely. Observed: the
     * model directory still existed after the cancel, companion and all —
     * `existsSync` was true where the test requires false. Exit 1.
     */
    const controller = new AbortController();
    let cancel = (): void => {};
    const server = await start({ onFirstChunk: () => cancel() });
    const m = withUrl(server.url);

    // A completed companion from earlier in the same install.
    const directory = join(dataRoot, 'models', m.engine, m.id);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'mmproj.gguf'), 'a finished companion');

    cancel = () => useModels.getState().cancelInstall(m.id);
    void controller; // the store owns the controller; this is its trigger
    await useModels.getState().install(m);

    expect(existsSync(directory)).toBe(false);
    expect(store.rows.has(m.id)).toBe(false);
    expect(useModels.getState().installed[m.id]).toBeUndefined();

    const order = bridge.events.filter((event) => event === 'fs:rmdir' || event === 'db:delete');
    expect(order).toEqual(['fs:rmdir', 'db:delete']);

    // And the user is told, calmly. Not a red toast about a stream buffer.
    expect(store.toasts.at(-1)).toEqual({
      message: 'Test Model download cancelled.',
      tone: 'info',
    });
  });

  it('leaves no failed record for the user to retry into', async () => {
    // The old behaviour: `state:'failed'` with `error: "BodyStreamBuffer was
    // aborted"`, and a Retry button where the model used to be.
    let cancel = (): void => {};
    const server = await start({ onFirstChunk: () => cancel() });
    const m = withUrl(server.url);
    cancel = () => useModels.getState().cancelInstall(m.id);

    await useModels.getState().install(m);

    expect([...store.rows.values()]).toEqual([]);
    expect(store.toasts.some((toast) => toast.tone === 'crit')).toBe(false);
  });
});

/* ── Resume ──────────────────────────────────────────────────────────── */

describe('a transfer that dies mid-stream resumes instead of restarting', () => {
  it('asks for the rest with Range and If-Range, and lands the right bytes', async () => {
    /*
     * FAULT INJECTED: the `Range` header removed from `transfer`. Observed:
     * the second request carried no range at all (the match against
     * `bytes=N-` was null), exit 1 — and the whole body was appended to the
     * partial file, which is the corruption an unguarded resume causes. That
     * is why the file is compared by HASH and not by length.
     */
    const server = await start({
      dropAfter: (attempt) => (attempt === 0 ? 5 * 1024 * 1024 : null),
    });

    const result = await downloadModel({ manifest: withUrl(server.url), retryDelayMs: 0 });

    expect(server.requests).toHaveLength(2);
    expect(server.requests[0]!.range).toBeUndefined();

    /*
     * The offset is whatever actually reached the disk, and that is MORE than
     * the last whole flush: when the read loop fails it flushes what it is
     * holding before rethrowing, so bytes that arrived are kept rather than
     * re-fetched. It is asserted as a range rather than a constant because
     * bytes still in the socket buffer when the server destroys it are lost,
     * which is a property of the network and not of this code.
     */
    const asked = /^bytes=(\d+)-$/.exec(server.requests[1]!.range ?? '');
    expect(asked, server.requests[1]!.range).not.toBeNull();
    const offset = Number(asked![1]);
    expect(offset).toBeGreaterThanOrEqual(FLUSH);
    expect(offset).toBeLessThanOrEqual(5 * 1024 * 1024);
    expect(server.requests[1]!.ifRange).toBe('"v1"');

    const written = readFileSync(modelPath(withUrl(server.url)));
    expect(sha(written)).toBe(sha(payload));
    expect(result.totalBytes).toBe(PAYLOAD_BYTES);
  });

  it('starts over when the server ignores Range and sends the whole file', async () => {
    /*
     * A 200 answering a `Range` request means the bytes on disk are a prefix
     * of something we can no longer vouch for. The sink is truncated first.
     *
     * FAULT INJECTED (in the structure this replaced, where the reset was a
     * free function): `restart()` no longer calls `sink.reset()`. Observed:
     * 13,987,273 bytes on disk instead of 9,449,529 — the partial prefix with
     * a whole file appended after it.
     *
     * RE-MEASURED AGAINST THE NEW STRUCTURE, by deleting the `intake.reset()`
     * from the arm that handles a 200 answering a `Range`: the run does not
     * produce a longer file, it throws `Error: the size of a file already
     * being written cannot be restated` out of `Intake.declare()` before a
     * byte is read. The guard that reads as a pedantic assertion is what
     * turns this particular future edit into a crash instead of a 14 MB
     * "model". Exit 1 either way.
     */
    const server = await start({
      ignoreRange: true,
      dropAfter: (attempt) => (attempt === 0 ? 5 * 1024 * 1024 : null),
    });

    await downloadModel({ manifest: withUrl(server.url), retryDelayMs: 0 });

    expect(server.requests[1]!.range).toMatch(/^bytes=\d+-$/);
    const written = readFileSync(modelPath(withUrl(server.url)));
    expect(written.length).toBe(PAYLOAD_BYTES);
    expect(sha(written)).toBe(sha(payload));
  });

  it('starts over on a 416, rather than keeping a prefix of a file that shrank', async () => {
    /*
     * The file is REPUBLISHED SHORTER between the two requests, so the resume
     * offset is past the end of what is now there. The server answers 416, and
     * the only correct move is to drop the prefix — it belongs to a file that
     * no longer exists — and take the new one whole.
     *
     * FAULT INJECTED: the 416 arm removed, so it fell through to the generic
     * `!response.ok` throw. Observed: the download failed with "Download
     * failed (416)" instead of recovering, exit 1.
     */
    const shortened = payload.subarray(0, 2 * 1024 * 1024);
    const server = await start({
      bodyAt: (attempt) => (attempt === 0 ? payload : shortened),
      dropAfter: (attempt) => (attempt === 0 ? 5 * 1024 * 1024 : null),
    });

    const result = await downloadModel({ manifest: withUrl(server.url), retryDelayMs: 0 });

    // Three requests: the one that died, the 416, and the whole new file.
    expect(server.requests).toHaveLength(3);
    expect(server.requests[2]!.range).toBeUndefined();
    const written = readFileSync(modelPath(withUrl(server.url)));
    expect(written.length).toBe(shortened.length);
    expect(sha(written)).toBe(sha(shortened));
    expect(result.totalBytes).toBe(shortened.length);
  });

  it('gives up after three attempts that make no progress at all', async () => {
    // A server that hangs up before sending a byte. Nothing is learned by
    // asking again, and the user is waiting: three consecutive failures with
    // nothing to show for them ends it.
    const server = await start({ dropAfter: () => 0 });
    await expect(
      downloadModel({ manifest: withUrl(server.url), retryDelayMs: 0 }),
    ).rejects.toThrow();
    expect(server.requests).toHaveLength(3);
  });

  it('bounds the pathological case where every attempt makes a little progress', async () => {
    /*
     * Progress refunds the retry budget, which is what lets a flaky connection
     * finish a 6 GB file — and, on its own, would let a server that sends 1 KiB
     * and hangs up loop forever. `TOTAL_ATTEMPTS` is the ceiling that makes
     * this terminate.
     *
     * FAULT INJECTED: the `attempts >= TOTAL_ATTEMPTS` clause removed.
     * Observed: the download did not fail — it ground through thousands of
     * 1 KiB attempts and RESOLVED, so the assertion "rejects" was what caught
     * it (exit 1). A user would have watched a progress bar crawl for hours
     * against a server that was never going to cooperate.
     */
    const server = await start({ dropAfter: () => 1024 });
    await expect(
      downloadModel({ manifest: withUrl(server.url), retryDelayMs: 0 }),
    ).rejects.toThrow();
    expect(server.requests.length).toBeGreaterThan(4);
    expect(server.requests.length).toBeLessThanOrEqual(40);
  });

  it('does not retry a refusal — a 404 is answered once', async () => {
    const server = await start({ status: 404 });
    await expect(downloadModel({ manifest: withUrl(server.url), retryDelayMs: 0 })).rejects.toThrow(
      /Download failed \(404\)/,
    );
    expect(server.requests).toHaveLength(1);
  });

  it('names the gate on a 403 rather than retrying past it', async () => {
    const server = await start({ status: 403 });
    await expect(downloadModel({ manifest: withUrl(server.url), retryDelayMs: 0 })).rejects.toThrow(
      /gated/,
    );
    expect(server.requests).toHaveLength(1);
  });
});

/* ── Servers that misbehave ──────────────────────────────────────────── */

/**
 * THE SECTION THE REVIEW SAID WAS MISSING.
 *
 * Seventeen of eighteen revert-checks came back MISSED on the milestone this
 * closes, and the reason was uniform: every existing test drove a WELL-BEHAVED
 * server. A server that answers 200 and sends the bytes it promised exercises
 * almost none of the code that decides whether a download becomes an installed
 * model.
 *
 * Each server below misbehaves in exactly one way, and each test asserts the
 * same two things: the download does not SUCCEED, and it TERMINATES. Where it
 * matters, the assertion goes through `useModels.install()` as well, because
 * "did not throw" and "was not recorded as installed" are different claims and
 * only the second one is what the user lives with.
 */
describe('a server that sends something other than the model', () => {
  const HTML = Buffer.from(
    '<!DOCTYPE html>\n<html><head><title>Sign in</title></head><body>Please log in to continue.</body></html>',
    'utf8',
  );

  it('refuses an HTML error page served as text/html, and installs nothing', async () => {
    /*
     * THE CASE THAT MOTIVATED THE WHOLE SECTION. A CDN interstitial is a
     * well-formed 200 with an honest `content-length`. Before this, it was
     * written to the sink and RECORDED AS AN INSTALLED MODEL; the user found
     * out days later when the engine reported a GGUF format error naming the
     * model rather than the download.
     *
     * FAULT INJECTED: the `content-type` refusal in `transfer` removed, so
     * only the first-bytes probe remained. Observed: still refused, but with
     * the probe's message — which is why BOTH are asserted, below and here.
     * FAULT INJECTED: content-type refusal AND the probe removed. Observed:
     * the download RESOLVED, 102 bytes on disk, and the store recorded
     * `state:'installed'` — the exact defect. Exit 1.
     */
    const server = await start({ instead: { body: HTML, contentType: 'text/html' } });
    const m = withUrl(server.url);

    // The DECLARED TYPE is asserted, not just the sentence. REVERT-CHECKED
    // and it mattered: with the content-type block deleted the first-bytes
    // probe caught the same page and produced the same sentence, so a test
    // matching only the sentence stayed GREEN — an unguarded check, which is
    // the whole failure mode this milestone is about. Naming `text/html` in
    // the message is what makes the two distinguishable.
    await expect(downloadModel({ manifest: m, retryDelayMs: 0 })).rejects.toThrow(
      /web page \(text\/html\) instead of the model file/,
    );
    // Not retried: asking a login page again produces a login page.
    expect(server.requests).toHaveLength(1);

    await useModels.getState().install(m);
    expect(useModels.getState().installed[m.id]?.state).toBe('failed');
    expect(useModels.getState().installed[m.id]?.state).not.toBe('installed');
  });

  it('refuses the same page dressed as application/octet-stream', async () => {
    /*
     * The content-type check alone is not enough, and this is why. A CDN that
     * labels its error document `application/octet-stream` passes the header
     * check, passes `response.ok`, and passes the length check — its
     * `content-length` is honest about the HTML. Only the first bytes give it
     * away.
     *
     * FAULT INJECTED: `DOCUMENT_OPENINGS` emptied. Observed: refused instead
     * by the GGUF magic arm, so the test was re-run with `magic` ALSO removed
     * from `downloadModel` — the download then RESOLVED with 102 bytes on
     * disk. Exit 1 on the length assertion.
     */
    const server = await start({
      instead: { body: HTML, contentType: 'application/octet-stream' },
    });
    // No parenthesised type here: this is the OTHER refusal, reached from the
    // bytes rather than the header, and the assertion says which.
    await expect(
      downloadModel({ manifest: withUrl(server.url), retryDelayMs: 0 }),
    ).rejects.toThrow(/web page instead of the model file/);
  });

  it('refuses a body that is binary but is not a GGUF', async () => {
    /*
     * A JSON error envelope, a tarball, the wrong file from the repo. Not a
     * document, so the opening check does not fire; the manifest says `gguf`,
     * and a GGUF starts with `GGUF`.
     *
     * FAULT INJECTED: `FORMAT_MAGIC` emptied to `{}`. Observed: 9,449,529
     * bytes of non-GGUF written to disk and the promise RESOLVED. Exit 1.
     */
    const notAModel = Buffer.concat([
      Buffer.from('{"error":"Repository not found"}', 'utf8'),
      randomBytes(4096),
    ]);
    const server = await start({ instead: { body: notAModel } });
    await expect(
      downloadModel({ manifest: withUrl(server.url), retryDelayMs: 0 }),
    ).rejects.toThrow(/not a GGUF model/);
  });

  it('refuses a file too short to even carry the magic', async () => {
    // A zero-length or two-byte 200. The probe runs after the loop as well as
    // inside it, so a body that never reaches `PROBE_BYTES` still gets a
    // verdict rather than being installed by default.
    const server = await start({ instead: { body: Buffer.from('GG', 'latin1') } });
    await expect(
      downloadModel({ manifest: withUrl(server.url), retryDelayMs: 0 }),
    ).rejects.toThrow(/not a GGUF model/);
  });

  it('refuses an empty 200', async () => {
    const server = await start({ instead: { body: Buffer.alloc(0) } });
    await expect(
      downloadModel({ manifest: withUrl(server.url), retryDelayMs: 0 }),
    ).rejects.toThrow(/empty file|not a GGUF/);
    const written = readFileSync(modelPath(withUrl(server.url)));
    expect(written.length).toBe(0);
  });
});

describe('a server whose length does not match its body', () => {
  it('does not install a body shorter than the content-length it declared', async () => {
    /*
     * MEASURED FIRST, then asserted. A body short of its `content-length` is
     * rejected by the HTTP CLIENT — `TypeError: terminated`, cause
     * `UND_ERR_RES_CONTENT_LENGTH_MISMATCH` — so it arrives here as a
     * retryable transport failure rather than as a clean short read. That is
     * the honest description of which check fires, and the outcome is what
     * matters either way: bounded retries, then a refusal, and NOTHING
     * RECORDED AS INSTALLED.
     */
    // A SMALL body for this one. The loop is bounded at 40 attempts and each
    // attempt re-transfers the whole file, so at the 9 MB fixture size this
    // test spends 29 seconds moving 378 MB over loopback to prove a ceiling
    // that 200 KB proves just as well. The SHAPE is what matters here — a
    // declared length the body does not honour — not the size.
    const small = Buffer.concat([Buffer.from('GGUF', 'latin1'), randomBytes(200_000)]);
    const server = await start({ body: small, lengthDelta: 4096 });
    const m = withUrl(server.url);

    await expect(downloadModel({ manifest: m, retryDelayMs: 0 })).rejects.toThrow();
    expect(server.requests.length).toBeLessThanOrEqual(40);
    expect(server.requests.length).toBeGreaterThan(1);
    // Nothing was left behind claiming to be the model.
    expect(useModels.getState().installed[m.id]).toBeUndefined();
  }, 30000);

  it('refuses a 206 that delivers more bytes than the range it answered', async () => {
    /*
     * The one over-delivery no client clamps. `content-length` longer than the
     * body is truncated by undici (MEASURED: 500 sent under `content-length:
     * 100`, 100 delivered), but nothing validates a body against
     * `content-range`. Here the resume answers `bytes N-…/TOTAL` — an HONEST
     * total, so the size on record is not contradicted and the restart arm
     * does not fire — and then sends 3 MB more than that range contains,
     * declaring them in `content-length` so the client hands them over.
     *
     * It is refused rather than retried: the extra bytes are already in the
     * sink and no `Range` request can un-write them.
     *
     * REWRITTEN THIS ROUND, and the reason matters. It used to reach this arm
     * with `rangeTotalDelta: -3_000_000` — a resume whose `/total` was three
     * megabytes SHORT of the file — which now trips the earlier rule that a
     * size stated twice must be stated the same way, and restarts. That rule
     * exists precisely so a server cannot shrink the target to match a
     * truncation, so the test was moved onto a server that over-delivers
     * WITHOUT lying about the size. The old shape is asserted below, under
     * its own name.
     *
     * FAULT INJECTED: the `received > mustDeliver` arm deleted, so an
     * over-long body falls through to `IncompleteTransfer`. Observed: the
     * download RESOLVED with `totalBytes: 9449529` — the right file, reached
     * by writing the over-long body, failing the completeness check, being
     * answered 416 on the next resume and re-fetching from zero. Exit 1 on
     * `rejects`. So the refusal is not what keeps the over-delivery out of
     * the installed file; the completeness check is. What the refusal decides
     * is that a server which sends more than it declared is not asked twice,
     * and the assertion here is on that decision.
     */
    const server = await start({
      overDeliver: 3_000_000,
      dropAfter: (attempt) => (attempt === 0 ? 5 * 1024 * 1024 : null),
    });
    const m = withUrl(server.url);

    await expect(downloadModel({ manifest: m, retryDelayMs: 0 })).rejects.toThrow(
      /where it declared/,
    );
    expect(useModels.getState().installed[m.id]).toBeUndefined();
  });

  it('starts over when a resume states a different size than the download began with', async () => {
    /*
     * A SIZE STATED TWICE MUST BE STATED THE SAME WAY.
     *
     * `state.declared` used to be overwritten by every 206 that carried a
     * `/total`, which hands a server the completeness check itself: answer the
     * resume with a total that matches what you have already sent, and
     * `written === declared` agrees that a truncated file is the whole file.
     * The size is now taken from the first response that states one and never
     * restated while bytes are on disk; a response that contradicts it is not
     * a continuation of this download, so the sink is emptied and the file is
     * fetched again.
     *
     * STATED AT ITS REAL WEIGHT, because the revert-check said so.
     *
     * FAULT INJECTED: the `!intake.agrees(stated)` clause removed from the
     * continuation arm. Observed: the download RESOLVED IN TWO REQUESTS WITH
     * THE RIGHT BYTES — `totalBytes` and the sha256 both passed, and what
     * failed was the request COUNT (`expected 2 to be greater than 2`). So
     * this clause is not what stops a shrunken `/total` installing a
     * truncated file: the size on record is immutable (`declare()` throws
     * over a non-empty sink) and each response is held to its own
     * `content-range` extent, and between them the contradicting total moves
     * nothing. What the clause adds is that a response describing a different
     * file is not stitched onto this one on the strength of 64 overlapping
     * bytes alone. Written down at that weight rather than as the guard it is
     * not — the narrowing-claim failure this file has already had three times
     * in prose is just as available in a test comment.
     */
    const server = await start({
      rangeTotalDelta: -3_000_000,
      dropAfter: (attempt) => (attempt === 0 ? 5 * 1024 * 1024 : null),
    });
    const m = withUrl(server.url);

    const result = await downloadModel({ manifest: m, retryDelayMs: 0 });

    // Restarted, then fetched whole: the file on disk is the whole model, not
    // the shorter one the resume claimed to be part of.
    expect(result.totalBytes).toBe(PAYLOAD_BYTES);
    expect(sha(readFileSync(modelPath(m)))).toBe(sha(payload));
    expect(server.requests.length).toBeGreaterThan(2);
  }, 15000);

  it('recovers from a 206 that overstates how much file is left', async () => {
    /*
     * THE ONE SHORT DELIVERY THAT ARRIVES CLEAN, and therefore the one the
     * check here actually catches. The resume answers `content-range: bytes
     * N-…/TOTAL` with a TOTAL 4 KiB larger than the file it then sends, so the
     * body ends normally, `fetch` resolves, and the read loop finishes with
     * less than was promised. Nothing rejected; nothing was going to.
     *
     * The right outcome is not a refusal — it is another attempt, which
     * eventually gets the whole file from zero and lands the right bytes.
     *
     * HOW IT RECOVERS CHANGED THIS ROUND, and the note is rewritten rather
     * than left to read as current. In the previous structure the resume was
     * consumed, came up 4 KiB short, and `IncompleteTransfer` sent the loop
     * round again. Now the contradiction is caught before the body is read —
     * a `/total` 4 KiB from the one already on record is not this file's — so
     * the sink is emptied and the next request fetches the whole thing. The
     * outcome asserted below is the same one, and it is the outcome that
     * matters: the right bytes, from more than the two requests a
     * well-behaved resume would have taken. The revert-check for the arm that
     * now does the work is on `agrees(stated)`, in the test above.
     */
    const server = await start({
      rangeTotalDelta: 4096,
      dropAfter: (attempt) => (attempt === 0 ? 5 * 1024 * 1024 : null),
    });
    const result = await downloadModel({ manifest: withUrl(server.url), retryDelayMs: 0 });
    expect(result.totalBytes).toBe(PAYLOAD_BYTES);
    expect(sha(readFileSync(modelPath(withUrl(server.url))))).toBe(sha(payload));
    // More than the two a well-behaved resume would have needed.
    expect(server.requests.length).toBeGreaterThan(2);
  }, 15000);
});

describe('a download is over when the file is whole, not when a response is', () => {
  it('keeps resuming a server that answers with a megabyte at a time', async () => {
    /*
     * THE BLIND SPOT IN EVERY PER-RESPONSE CHECK.
     *
     * `content-range: bytes N-M/*` is legal — the server is saying "here is
     * this much, I will not tell you how big the whole thing is". With no
     * total there is nothing for `consume` to compare its delivery against, so
     * the response ends cleanly having kept every promise it made. The old
     * loop broke on that and the download was 6 MiB of a 9.4 MB model.
     *
     * A final `written === declared` check turned that into a REFUSAL, which
     * was the previous round's answer and was only half right: the file was
     * available, one megabyte at a time, and the machinery for asking again is
     * sitting right there. The loop now ends when the sink holds the length
     * the first response stated — so this walks the file to the end instead,
     * and lands it byte for byte.
     *
     * FAULT INJECTED: the loop's exit changed back to `if (outcome ===
     * 'ended') break`. Observed: NOT an install — `commit()` refused with
     * "The download ended with 6291392 bytes where the server said 9449529",
     * because the loop and `commit()` consult the same predicate and the
     * second one is still standing when the first is gone. Exit 1 on the
     * download resolving at all, which is the point: the user gets an error
     * where the file was available.
     */
    const server = await start({
      dropAfter: (attempt) => (attempt === 0 ? 5 * 1024 * 1024 : null),
      starRange: (attempt) => (attempt > 0 ? 1024 * 1024 : null),
    });
    const m = withUrl(server.url);

    const result = await downloadModel({ manifest: m, retryDelayMs: 0 });

    expect(result.totalBytes).toBe(PAYLOAD_BYTES);
    expect(sha(readFileSync(modelPath(m)))).toBe(sha(payload));
    expect(server.requests.length).toBeGreaterThan(4);
  }, 20000);

  it('installs nothing when a capped server stops advancing', async () => {
    /*
     * THE SAME SERVER, STUCK. Every response is a legal `bytes N-M/*` and
     * every one of them re-sends only the overlap the resume asked for, so
     * the download makes no progress at all. Nothing per-response is wrong;
     * the DOWNLOAD is what is short, and the message says so.
     *
     * Every response here keeps its own promise — `bytes N-M/*` delivering
     * exactly M-N+1 bytes — so the per-response check has nothing to say and
     * the attempt ends 'ended'. What ends the download is the retry budget,
     * and the sentence it ends with is the DOWNLOAD's: the sink holds less
     * than the length the first response stated. That sentence and the one
     * `commit()` refuses with are the same string from the same predicate,
     * which is what keeps "finished" and "installable" from drifting apart.
     *
     * FAULT INJECTED: the ceiling arm's `intake.shortfall()` replaced by the
     * restart sentence. Observed: still rejected, but naming a server that
     * "kept restarting" a download it had never restarted — the message a
     * user would file a bug against. Exit 1 on the regex.
     */
    const server = await start({
      dropAfter: (attempt) => (attempt === 0 ? 5 * 1024 * 1024 : null),
      // Exactly `OVERLAP_BYTES`: the resume's own overlap comes back and not
      // one byte more.
      starRange: (attempt) => (attempt > 0 ? 64 : null),
    });
    const m = withUrl(server.url);

    await expect(downloadModel({ manifest: m, retryDelayMs: 0 })).rejects.toThrow(
      /where the server said/,
    );
    expect(useModels.getState().installed[m.id]).toBeUndefined();
    const written = readFileSync(modelPath(m));
    expect(sha(written)).not.toBe(sha(payload));
  }, 20000);

  it('finishes a server that caps every response at a megabyte, honestly', async () => {
    /*
     * THE TRUNCATION THAT RESOLVED SUCCESSFULLY. Every response is a 206 with
     * an honest `content-range` — `bytes 0-1048575/9449529` — an honest
     * `content-length`, and a clean end of body. There is nothing wrong with
     * any single response, which is why no per-response check ever fired: the
     * first one arrived, the loop broke, and one megabyte was installed as a
     * 9 MB model.
     *
     * FAULT INJECTED: `if (outcome === 'ended' && intake.satisfied) break`
     * reduced to `if (outcome === 'ended') break`. Observed: the loop stopped
     * after the first megabyte and `commit()` refused — "The download ended
     * with 1048576 bytes where the server said 9449529" — so the truncation
     * became an error rather than an install. That is the two layers doing
     * what they are for, and it is also why this test asserts the file lands
     * rather than only that nothing bad does: the SECOND fault, deleting
     * `satisfied` itself, takes both out at once and is caught by the shape
     * assertion in the docs block. Exit 1.
     */
    const server = await start({ capBytes: 1024 * 1024 });
    const m = withUrl(server.url);

    const result = await downloadModel({ manifest: m, retryDelayMs: 0 });

    expect(result.totalBytes).toBe(PAYLOAD_BYTES);
    expect(sha(readFileSync(modelPath(m)))).toBe(sha(payload));
    // Ten megabyte-sized answers, give or take the overlap each one re-sends.
    expect(server.requests.length).toBeGreaterThanOrEqual(9);
    expect(server.requests.length).toBeLessThanOrEqual(40);

    /*
     * THE OVERLAP, IN ARITHMETIC. Every response here ends cleanly, so the
     * byte count after the first one is exactly a megabyte and the second
     * request is the only place the resume offset can be read from the
     * outside: 64 bytes BEFORE the end of what is on disk.
     *
     * And the file is still exactly the model, so those 64 bytes were
     * compared and dropped rather than written a second time — the two halves
     * of the stitch, asserted together.
     */
    expect(server.requests[1]!.range).toBe(`bytes=${1024 * 1024 - 64}-`);
  }, 20000);

  it('installs nothing when the first response claims more file than it has', async () => {
    /*
     * A `/total` ON THE FIRST RESPONSE, PARSED AND THROWN AWAY. The 206 arm
     * only looked at `content-range` when it was resuming; on a first
     * response it checked that the range started at zero and dropped the
     * total on the floor. So `bytes 0-9449528/9453625` — a total 4 KiB larger
     * than the body it then sent — was measured against `content-length`
     * instead, agreed with itself, and installed a file the server itself
     * said was incomplete.
     *
     * The size now comes from the `/total` on a 206 whether or not the
     * request carried a `Range`, so what arrived is short of what was stated
     * and the download ends with nothing installed.
     *
     * FAULT INJECTED: `stated` computed as `declaredLength(response)` for a
     * 206 as well — the old shape, where a `content-range` on a first
     * response was read for its start and nothing else. Observed: the
     * download RESOLVED with `totalBytes: 9449529`, installed as the complete
     * file the server itself had described as 9,453,625 bytes long. Exit 1 on
     * `rejects`.
     */
    const server = await start({ capBytes: PAYLOAD_BYTES, rangeTotalDelta: 4096 });
    const m = withUrl(server.url);

    await expect(downloadModel({ manifest: m, retryDelayMs: 0 })).rejects.toThrow();
    expect(useModels.getState().installed[m.id]).toBeUndefined();
    expect(server.requests.length).toBeLessThanOrEqual(40);
  }, 20000);
});

/* ── The intake ──────────────────────────────────────────────────────── */

describe('nothing reaches the sink before the transfer is identified', () => {
  const PAGE = Buffer.from(
    '<!DOCTYPE html>\n<html><head><title>Sign in</title></head><body>Please log in.</body></html>',
    'utf8',
  );

  it('drops a prefix the connection died inside, and identifies the retry', async () => {
    /*
     * THE PROBE BYPASS, AND THE REASON THIS ROUND RESTRUCTURED RATHER THAN
     * ADDING A FIFTH CHECK.
     *
     * `identify()` was gated on `written > 0` and the failure arm of the read
     * loop flushed whatever it was holding BEFORE anything identified it. So
     * a connection dying inside the first sixteen bytes put those bytes on
     * disk unidentified, and every later attempt skipped identification
     * because the counter it was gated on had already moved. Two bytes of a
     * login page, resumed from, completed, and INSTALLED — with the
     * content-type check dodged by serving it as `application/octet-stream`
     * and the magic check dodged by never running.
     *
     * The bytes now sit in a queue the sink cannot be reached from, so the
     * failure arm has nothing to flush: it drops them, and the retry asks for
     * the WHOLE file and identifies what comes back.
     *
     * FAULT INJECTED: `abandon()` changed to move `held` into `queue` before
     * flushing — the old behaviour, two lines. Observed: the download
     * RESOLVED, `totalBytes: 91` — the login page, whole, recorded under
     * `model.gguf` as the model. Exit 1 on `rejects`.
     */
    const server = await start({
      body: PAGE,
      // One byte at a time, so the socket can die INSIDE the probe window
      // rather than between chunks of it.
      chunkBytes: 1,
      dropAfter: (attempt) => (attempt === 0 ? 2 : null),
    });
    const m = withUrl(server.url);

    await expect(downloadModel({ manifest: m, retryDelayMs: 0 })).rejects.toThrow(
      /web page instead of the model file/,
    );

    // The retry asked for the whole file: two unidentified bytes are not a
    // resume offset.
    expect(server.requests.length).toBeGreaterThan(1);
    expect(server.requests[1]!.range).toBeUndefined();
    expect(readFileSync(modelPath(m)).length).toBe(0);
    expect(useModels.getState().installed[m.id]).toBeUndefined();
  }, 15000);

  it('refetches from zero when a real model dies inside the probe window', async () => {
    // The same path with nothing wrong at the end of it: dropping an
    // unidentified prefix must cost a re-fetch, not the download.
    const server = await start({
      chunkBytes: 1,
      dropAfter: (attempt) => (attempt === 0 ? 3 : null),
    });
    const m = withUrl(server.url);

    const result = await downloadModel({ manifest: m, retryDelayMs: 0 });

    expect(server.requests[1]!.range).toBeUndefined();
    expect(result.totalBytes).toBe(PAYLOAD_BYTES);
    expect(sha(readFileSync(modelPath(m)))).toBe(sha(payload));
  }, 15000);

  it('will not stitch a continuation from a different build of the model', async () => {
    /*
     * THE SPLICE, WITH EVERY OTHER CHECK PASSING.
     *
     * The file is republished between the two requests and the server keeps
     * the SAME `ETag` — a stale CDN, or any server that does not compare
     * `If-Range` — so the resume is answered 206 with the new build's tail at
     * the offset asked for. The result has the right magic (it is not at the
     * head), the right length, an honest `content-range`, and comes apart
     * only in the middle: valid GGUF, wrong weights, and the engine reports it
     * days later as a bad model.
     *
     * This is what the docstring's "NO VALIDATOR, NO RESUME. THIS IS THE WHOLE
     * GUARD." was false about: the validator was sent and the server ignored
     * it. What catches it is the overlap — the resume asks for the last 64
     * bytes on disk again, and the new build does not have the old build's
     * bytes there.
     *
     * ASSERTED ON SHA256, because length and magic both agree with the splice.
     *
     * FAULT INJECTED: the byte comparison in `Intake.overlap()` short-
     * circuited to `false &&`, so a continuation is accepted without being
     * checked. Observed: the download RESOLVED in two requests and installed
     * a file whose sha256 matched NEITHER build — the fixtures are random per
     * run, so the digests are not quoted here; what is stable is that the
     * installed file was neither of the two the server ever served. Exit 1 on
     * the hash, the only assertion here that can tell a splice from a model.
     */
    const second = Buffer.concat([
      Buffer.from('GGUF', 'latin1'),
      randomBytes(PAYLOAD_BYTES - 4),
    ]);
    const server = await start({
      etag: '"v1"',
      bodyAt: (attempt) => (attempt === 0 ? payload : second),
      dropAfter: (attempt) => (attempt === 0 ? 5 * 1024 * 1024 : null),
    });
    const m = withUrl(server.url);

    const result = await downloadModel({ manifest: m, retryDelayMs: 0 });

    /*
     * THE HASH FIRST, deliberately. A splice has the right length and the
     * right magic; the only assertion that can tell one from the file is this
     * one, so it is the one that fails first when the stitch is gone.
     */
    const written = readFileSync(modelPath(m));
    expect(sha(written)).toBe(sha(second));
    expect(sha(written)).not.toBe(sha(payload));
    expect(written.length).toBe(PAYLOAD_BYTES);
    expect(result.totalBytes).toBe(PAYLOAD_BYTES);

    // The resume WAS attempted, with the validator the server offered.
    expect(server.requests[1]!.range).toMatch(/^bytes=\d+-$/);
    expect(server.requests[1]!.ifRange).toBe('"v1"');
    // And when its bytes did not follow on, the prefix was dropped rather
    // than built on: the third request asks for the whole file.
    expect(server.requests[2]!.range).toBeUndefined();
  }, 20000);
});

describe('a server that offers no validator to resume against', () => {
  it('refetches from zero rather than splicing two builds together', async () => {
    /*
     * THE DEFECT THIS TEST EXISTS FOR, AND THE ONE THE DOCSTRING LIED ABOUT.
     *
     * `ETag` and `Last-Modified` are both OPTIONAL. With neither, there is
     * nothing to send as `If-Range`, so a resumed `Range` request cannot
     * detect that the file was republished between attempts — and the code
     * sent the `Range` anyway, under a docstring reading "guarded by
     * `If-Range` against the file changing underneath it. That is the whole
     * claim."
     *
     * This server offers no validator AND serves DIFFERENT BYTES on the
     * retry. The correct outcome is the second body, whole. The outcome the
     * old code produced is the first body's head with the second body's tail:
     * a file with valid GGUF magic, the exactly right length, and garbage
     * inside — which is why this asserts on the HASH and why the magic check
     * added alongside it would not have caught it.
     *
     * FAULT INJECTED: the `state.written > 0 && state.validator === null`
     * restart removed, restoring `if (state.validator) headers['If-Range']`.
     * Observed: request 2 carried `Range: bytes=5242880-` and no `If-Range`;
     * the file on disk was 9,449,529 bytes — the right LENGTH — and its
     * sha256 matched NEITHER body. Exit 1 on the hash comparison.
     */
    const second = Buffer.concat([
      Buffer.from('GGUF', 'latin1'),
      randomBytes(PAYLOAD_BYTES - 4),
    ]);
    const server = await start({
      etag: undefined,
      bodyAt: (attempt) => (attempt === 0 ? payload : second),
      dropAfter: (attempt) => (attempt === 0 ? 5 * 1024 * 1024 : null),
    });

    const result = await downloadModel({ manifest: withUrl(server.url), retryDelayMs: 0 });

    // The retry asked for the WHOLE file, not for a continuation.
    expect(server.requests).toHaveLength(2);
    expect(server.requests[1]!.range).toBeUndefined();
    expect(server.requests[1]!.ifRange).toBeUndefined();

    const written = readFileSync(modelPath(withUrl(server.url)));
    expect(written.length).toBe(second.length);
    expect(sha(written)).toBe(sha(second));
    expect(sha(written)).not.toBe(sha(payload));
    expect(result.totalBytes).toBe(second.length);
  });

  it('still resumes where the server DOES offer one', async () => {
    // The control. The refusal above must be about the missing validator and
    // not about resume having quietly stopped working.
    const server = await start({
      etag: '"v1"',
      dropAfter: (attempt) => (attempt === 0 ? 5 * 1024 * 1024 : null),
    });
    await downloadModel({ manifest: withUrl(server.url), retryDelayMs: 0 });
    expect(server.requests[1]!.range).toMatch(/^bytes=\d+-$/);
    expect(server.requests[1]!.ifRange).toBe('"v1"');
  });

  it('resumes against the validator of the response the bytes on disk came from', async () => {
    /*
     * A VALIDATOR IS ABOUT A PARTICULAR BODY, and the one on disk is not
     * always the first one that arrived.
     *
     * This server ignores `Range` and answers every request with the whole
     * file — under a NEW `ETag` each time, which is what a republish looks
     * like. The prefix on disk is therefore replaced on the second attempt,
     * and the `If-Range` sent with the third must be the validator of the
     * response that replaced it. Kept as `state.validator ??= …` — set once,
     * on the first response ever seen — it describes bytes that were thrown
     * away two attempts ago, and the server is asked to compare our resume
     * against a version of the file we are no longer holding.
     *
     * FAULT INJECTED: the assignment changed back to `??=`. Observed: the
     * third request carried `If-Range: "v1"` while the disk held the body
     * that arrived under `"v2"`. Exit 1.
     */
    const server = await start({
      ignoreRange: true,
      etagAt: (attempt) => (attempt === 0 ? '"v1"' : '"v2"'),
      dropAfter: (attempt) => (attempt < 2 ? 2 * 1024 * 1024 : null),
    });
    const m = withUrl(server.url);

    await downloadModel({ manifest: m, retryDelayMs: 0 });

    expect(server.requests[1]!.ifRange).toBe('"v1"');
    expect(server.requests[2]!.ifRange).toBe('"v2"');
    expect(sha(readFileSync(modelPath(m)))).toBe(sha(payload));
  }, 15000);

  it('resumes on Last-Modified alone, which is also a validator', async () => {
    const server = await start({
      etag: undefined,
      lastModified: 'Wed, 21 Oct 2026 07:28:00 GMT',
      dropAfter: (attempt) => (attempt === 0 ? 5 * 1024 * 1024 : null),
    });
    await downloadModel({ manifest: withUrl(server.url), retryDelayMs: 0 });
    expect(server.requests[1]!.ifRange).toBe('Wed, 21 Oct 2026 07:28:00 GMT');
  });
});

describe('a server that will not let the download make progress', () => {
  it('bounds a server that answers 416 to everything', async () => {
    /*
     * THE INFINITE LOOP, EXACTLY AS IT WAS.
     *
     * The 416 arm truncates the sink and sets `written` back to zero, so the
     * next request carries no `Range`, so the next answer is another 416. The
     * restart arm was `consecutive = 0; continue;` — no budget consulted, no
     * sleep, no ceiling — and `attempts` was incremented at the top of the
     * loop and never read on this path.
     *
     * FAULT INJECTED: the restart arm restored to `consecutive = 0;
     * continue;`. Observed: the test did not fail, it HUNG — vitest killed it
     * at the 5s timeout with the server having recorded 41,000+ requests and
     * still climbing. A hang is what an unbounded loop looks like from the
     * outside, which is why this test has a request-count ceiling and not only
     * a rejects assertion. Exit 1.
     */
    const server = await start({ always416: true });
    const m = withUrl(server.url);

    await expect(downloadModel({ manifest: m, retryDelayMs: 0 })).rejects.toThrow(
      /kept restarting this download/,
    );
    expect(server.requests.length).toBeLessThanOrEqual(CONSECUTIVE_CEILING);
    expect(server.requests.length).toBeGreaterThan(1);

    await useModels.getState().install(m);
    expect(useModels.getState().installed[m.id]?.state).toBe('failed');
  }, 5000);

  it('backs off between restarts instead of spinning', async () => {
    /*
     * The other half of the same defect: the restart arm never slept, so even
     * a bounded version would hammer a struggling server as fast as the event
     * loop allows. `retryDelayMs` is the seam the tests use to avoid sleeping;
     * here it is deliberately NOT zero, so the pause is observable.
     *
     * FAULT INJECTED: the `await pause(...)` removed from the restart arm.
     * Observed: elapsed 3 ms against a 60 ms floor. Exit 1.
     */
    const server = await start({ always416: true });
    const began = Date.now();
    await expect(
      downloadModel({ manifest: withUrl(server.url), retryDelayMs: 30 }),
    ).rejects.toThrow();
    // Two sleeps before the third strike ends it.
    expect(Date.now() - began).toBeGreaterThanOrEqual(50);
  }, 5000);

  it('bounds a server that answers a resume with a range nobody asked for', async () => {
    /*
     * A 206 whose `content-range` starts somewhere else. This used to fall in
     * with the "server sent the whole file" case and its body was consumed AS
     * THE WHOLE FILE — a slice from the middle of a model written from offset
     * zero, with a `content-length` honestly describing the slice, so every
     * length check agreed with it.
     *
     * FAULT INJECTED: the mismatched-range arm restored to `restart(); return
     * consume(...)`. Observed: for the GGUF the magic probe refused it — so
     * the test was re-run with `magic` removed to model a COMPANION file,
     * which has none, and the download then resolved with a mid-file slice
     * recorded as the installed file. Exit 1.
     */
    /*
     * DRIVEN AS A FORMAT WITH NO MAGIC, on purpose. REVERT-CHECKED against the
     * GGUF fixture first and it came back MISSED: the mid-file slice does not
     * start with `GGUF`, so the probe refused it and the test stayed green
     * while the range arm it was written for was gone. A companion — an
     * mmproj, a tokenizer, a vae — has no magic at all, and that is the file
     * this arm is the only guard for.
     */
    const server = await start({
      mismatchRange: (attempt) => attempt > 0,
      dropAfter: (attempt) => (attempt === 0 ? 5 * 1024 * 1024 : null),
    });
    const m = withUrl(server.url, { format: 'onnx' });

    await expect(downloadModel({ manifest: m, retryDelayMs: 0 })).rejects.toThrow();
    expect(server.requests.length).toBeLessThanOrEqual(CONSECUTIVE_CEILING + 1);
    // And nothing that is merely a slice of the model was left behind as one.
    const written = readFileSync(modelPath(m));
    expect(sha(written)).not.toBe(sha(payload.subarray(5 * 1024 * 1024)));
  }, 10000);

  it('refuses a 206 fragment sent to a request that carried no Range', async () => {
    /*
     * The same slice, one step earlier. RFC 9110 makes 206 an ANSWER to a
     * range request, so an unsolicited one is a broken server and its body is
     * a fragment — which the resume checks never saw, because they only run
     * when `resuming` is true. A first request answered `206 content-range:
     * bytes 4096-…` had its tail written from offset zero and called the file.
     *
     * FAULT INJECTED: the unsolicited-206 arm removed. Observed: the download
     * RESOLVED, with a body starting 4096 bytes into the model recorded as the
     * installed file — and it passed the length check, because the
     * `content-length` honestly described the fragment. Exit 1.
     */
    const server = await start({ mismatchRange: () => true });
    await expect(
      downloadModel({ manifest: withUrl(server.url), retryDelayMs: 0 }),
    ).rejects.toThrow(/part of the file when the whole one was asked for/);
    expect(server.requests).toHaveLength(1);
  }, 10000);

  it('survives a connection that dies mid-body every single time, byte for byte', async () => {
    /*
     * MY OWN PREMISE WAS WRONG HERE, and the fault server said so. This was
     * first written asserting `state:'failed'`, on the assumption that a
     * connection dying on every attempt could not finish. It CAN: progress
     * refunds the retry budget by design, so twenty deaths at 512 KiB apiece
     * still walk a 9 MB file to the end. The test asserted the wrong outcome
     * and the code was right.
     *
     * So this asserts what actually matters about that path — a download
     * stitched together from twenty partial responses is BYTE FOR BYTE the
     * file the server holds, and it is stitched with resume rather than
     * restarts. A test "fixed" by lowering it to `rejects` would have removed
     * the only assertion here worth having.
     */
    const server = await start({ dropAfter: () => 512 * 1024 });
    const m = withUrl(server.url);

    const result = await downloadModel({ manifest: m, retryDelayMs: 0 });

    expect(result.totalBytes).toBe(PAYLOAD_BYTES);
    expect(sha(readFileSync(modelPath(m)))).toBe(sha(payload));
    expect(server.requests.length).toBeGreaterThan(10);
    expect(server.requests.length).toBeLessThanOrEqual(40);
    // Resumed, not restarted: every request after the first carried a Range.
    expect(server.requests.slice(1).every((r) => /^bytes=\d+-$/.test(r.range ?? ''))).toBe(true);
  }, 30000);

  it('bounds a server that ignores Range and restarts from zero every time', async () => {
    // It never resumes and never finishes, and the ceiling is what ends it.
    const server = await start({
      ignoreRange: true,
      dropAfter: () => 2 * 1024 * 1024,
    });
    await expect(
      downloadModel({ manifest: withUrl(server.url), retryDelayMs: 0 }),
    ).rejects.toThrow();
    expect(server.requests.length).toBeLessThanOrEqual(40);
  }, 20000);
});

/* ── The platform branch ─────────────────────────────────────────────── */

describe('the sink is chosen by capability, never by plugin availability', () => {
  it('web writes to OPFS and never touches the Filesystem plugin', async () => {
    /*
     * THE ORIGINAL BUG, FROM THE OTHER SIDE.
     * `Capacitor.isPluginAvailable('Filesystem')` answers TRUE on plain web,
     * because the package ships a web implementation that succeeds into
     * IndexedDB. A downloader that asked it would look principled and would
     * put every model somewhere the engine cannot read.
     *
     * FAULT INJECTED: `openSink` made unconditional on the filesystem sink.
     * Observed: seven bridge calls recorded on the WEB platform — `mkdir`,
     * `writeFile`, four `appendFile`s and `getUri` — where there must be none.
     * Exit 1.
     */
    platform.id = 'web';
    const opfs = makeOpfs();
    opfs.install();

    const server = await start();
    const m = withUrl(server.url);
    const result = await downloadModel({ manifest: m, retryDelayMs: 0 });

    expect(bridge.calls).toEqual([]);
    expect(result.paths.model).toBe(`opfs://models/${m.engine}/${m.id}/model.gguf`);

    const stored = opfs.root.dirs
      .get('models')!
      .dirs.get(m.engine)!
      .dirs.get(m.id)!
      .files.get('model.gguf')!;
    expect(sha(stored)).toBe(sha(payload));

    // And removal goes to OPFS too, not to a plugin that is not there.
    await deleteModelFiles(m);
    expect(opfs.root.dirs.get('models')!.dirs.get(m.engine)!.dirs.has(m.id)).toBe(false);
    expect(bridge.calls).toEqual([]);
  });

  it('ios takes the filesystem sink, the same one desktop does', async () => {
    platform.id = 'ios';
    const server = await start();
    await downloadModel({ manifest: withUrl(server.url), retryDelayMs: 0 });
    expect(bridge.calls.some((call) => call.method === 'appendFile')).toBe(true);
    expect(sha(readFileSync(modelPath(withUrl(server.url))))).toBe(sha(payload));
  });
});

/* ── The storage meter ───────────────────────────────────────────────── */

/**
 * THE FIFTH PLATFORM-BLIND SITE.
 *
 * `storageEstimate()` called `navigator.storage.estimate()` unconditionally,
 * and the layering guard could not see it because it names no platform — it
 * names a BROWSER API, which is the same mistake in a different disguise. The
 * origin's storage bucket is where OPFS models live and is emphatically not
 * where `Directory.Data` is: on iOS, Android and the desktop shell the meter
 * reported the webview's own allowance while gigabytes of weights sat outside
 * it. Wrong on three platforms out of four.
 */
describe('the storage meter reports the storage the models are actually in', () => {
  function stubEstimate(usage: number | undefined, quota: number | undefined): void {
    Object.defineProperty(navigator, 'storage', {
      value: { estimate: async () => ({ usage, quota }) },
      configurable: true,
    });
  }

  it('asks the browser on the web, where OPFS is the browser bucket', async () => {
    platform.id = 'web';
    stubEstimate(1_500_000, 40_000_000);
    // The known figure is IGNORED here on purpose: the bucket total includes
    // overhead this app does not track, and it is the real constraint.
    expect(await storageEstimate(7)).toEqual({ used: 1_500_000, quota: 40_000_000 });
  });

  it('never asks the browser on a platform with a real filesystem', async () => {
    /*
     * FAULT INJECTED: `storageEstimate` reverted to its unconditional
     * `navigator.storage?.estimate` form. Observed: `{used: 1500000, quota:
     * 40000000}` on 'electron', 'ios' and 'android' — a meter reading "1.5 MB
     * of 40 MB" for a device holding a 2 GB model. Exit 1 on all three.
     */
    let asked = 0;
    Object.defineProperty(navigator, 'storage', {
      value: {
        estimate: async () => {
          asked += 1;
          return { usage: 1_500_000, quota: 40_000_000 };
        },
      },
      configurable: true,
    });

    for (const id of ['electron', 'ios', 'android']) {
      platform.id = id;
      expect(await storageEstimate(2_019_377_696), id).toEqual({
        used: 2_019_377_696,
        quota: 0,
      });
    }
    expect(asked).toBe(0);
  });

  it('reports a quota of zero rather than a made-up one', async () => {
    /*
     * `quota: 0` is what `ModelsScreen` reads as "not known", and it draws a
     * plain figure instead of a bar. There IS no honest denominator here:
     * `@capacitor/filesystem` exposes no free-space call and the desktop shell
     * refuses `stat` by name (`FILESYSTEM_REFUSED`). A bar against an invented
     * maximum is worse than no bar.
     */
    platform.id = 'electron';
    const { quota } = await storageEstimate(1);
    expect(quota).toBe(0);
  });

  it('falls back to what it knows when the browser has no estimate at all', async () => {
    platform.id = 'web';
    Object.defineProperty(navigator, 'storage', { value: {}, configurable: true });
    expect(await storageEstimate(4096)).toEqual({ used: 4096, quota: 0 });
  });
});

/* ── The claim the docstring makes ───────────────────────────────────── */

describe('the downloader documents what it does and nothing more', () => {
  const source = readFileSync(join(process.cwd(), 'src/lib/download.ts'), 'utf8');
  /**
   * The same source with comments removed.
   *
   * The two guards below are about different halves of the file and must not
   * be run against the same text: the false claim was PROSE, so it is searched
   * for in the whole file; the forbidden call is CODE, and the file's header
   * explains at length why `isPluginAvailable` must not be used — which a raw
   * search would flag as the very thing it forbids.
   */
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

  it('states the boundary of the resume it claims', () => {
    /*
     * The old docstring promised downloads "streamed, resumable where the
     * server allows it" while the file contained no Range header, no 206
     * handling and no Accept-Ranges check anywhere. A false claim is worse
     * than an absent feature.
     *
     * This does NOT ban that sentence: the file now quotes it as the defect it
     * is naming, and a text ban would forbid writing the history down. What is
     * pinned instead is the limit of the claim that replaced it — resume lives
     * inside one download and does not survive the app closing, because
     * nothing persists a partial byte count or a validator to check it
     * against. The day someone implements cross-session resume, this
     * assertion is what tells them the docstring has to change with it.
     */
    const header = source.slice(0, source.indexOf('*/'));
    expect(header).toContain('does NOT survive the app being closed');
    expect(header).toMatch(/Range/);
  });

  it('backs the resume claim with the headers that implement it', () => {
    expect(code).toContain('headers.Range');
    expect(code).toContain("headers['If-Range']");
    expect(code).toContain('206');
  });

  it('has one place that writes and one place that decides', () => {
    /*
     * THE SHAPE THE INVARIANT RESTS ON, asserted here because it cannot be
     * driven from a server.
     *
     * Three of the guards below are ASSERTIONS, not checks: removing one on
     * its own changes no behaviour today, because the only caller already
     * satisfies it. `declare()` is called on an empty sink, `expectWholeFile()`
     * is called after a reset, and the loop cannot reach `commit()`
     * unsatisfied. A revert-check on all three came back MISSED against the
     * fault servers, which is the honest reason they are pinned here.
     *
     * They are not idle, and both halves were measured. Delete the
     * `intake.reset()` from the arm that handles a 200 answering a `Range`
     * and `declare()` throws before a byte is read, where the old code wrote
     * a whole file onto a partial one. Reduce the loop's exit to `outcome ===
     * 'ended'` and `commit()` refuses a truncated download the loop was
     * willing to install. What they defend against is a FUTURE caller, and
     * this is the test that would have to be deleted to add one.
     */
    // One call site for the sink's write, and it is inside the intake.
    expect([...code.matchAll(/sink\.write\(/g)]).toHaveLength(1);

    // One way to get a path, and it consults the completeness predicate.
    expect([...code.matchAll(/async commit\(/g)]).toHaveLength(1);
    const commit = code.slice(code.indexOf('async commit('), code.indexOf('async abort('));
    expect(commit).toContain('if (!this.satisfied)');
    expect(commit).toContain('await this.sink.close()');

    // A size cannot be restated over bytes already on disk, and a whole file
    // cannot be written onto a partial one.
    const declare = code.slice(code.indexOf('declare(bytes'), code.indexOf('agrees(bytes'));
    expect(declare).toContain('this.writtenBytes !== 0');
    const whole = code.slice(
      code.indexOf('expectWholeFile()'),
      code.indexOf('expectContinuation()'),
    );
    expect(whole).toContain('this.writtenBytes !== 0');
  });

  it('never asks whether the Filesystem plugin is available', () => {
    // The one capability question that must not be delegated: the answer is
    // TRUE on plain web and means IndexedDB.
    expect(code).not.toContain('isPluginAvailable');
    expect(code).toContain('capabilities().modelStore');
  });

  it('dispatches on the sink EXHAUSTIVELY, never with a ternary', () => {
    /*
     * `modelStore === 'filesystem' ? fs : opfs` gives WEB behaviour to every
     * value that is not `'filesystem'` — which is how weights reached
     * IndexedDB. A fifth `ModelStore` must be a compile error on the dispatch,
     * not a silent fallback in production.
     *
     * Asserted on the SHAPE because the compiler cannot be asserted on from
     * inside a test that has already compiled: a ternary reintroduced here
     * would typecheck perfectly and this is what notices. The `never` half is
     * proved by an actual `tsc` run in tests/platform.test.ts.
     */
    expect(code).not.toMatch(/modelStore\s*===\s*'filesystem'\s*\n?\s*\?/);
    // Both dispatches — the sink and the delete — reach the same helper.
    expect([...code.matchAll(/unreachable\(store, 'model store'\)/g)]).toHaveLength(3);
    expect([...code.matchAll(/switch \(store\)/g)]).toHaveLength(3);
  });

  it('does not ask the browser for a quota where the models are not in it', () => {
    /*
     * THE FIFTH PLATFORM-BLIND SITE. `navigator.storage.estimate()` was called
     * unconditionally, and the layering guard could not see it because it
     * names no platform. It describes the ORIGIN'S bucket — where OPFS models
     * live, and where packaged-platform models emphatically do not.
     */
    expect(code).toMatch(/case 'opfs':[\s\S]{0,400}navigator\.storage/);
    // And the filesystem arm never reaches it.
    const filesystemArm = code.slice(
      code.indexOf("case 'filesystem':", code.indexOf('storageEstimate')),
    );
    expect(filesystemArm.slice(0, 120)).not.toContain('navigator.storage');
  });
});
