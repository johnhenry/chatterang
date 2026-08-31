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

const { DownloadCancelled, deleteModelFiles, downloadModel } = await import('@/lib/download');
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

    const body = plan.bodyAt?.(index) ?? plan.body;
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

    const slice = body.subarray(start);
    const headers: Record<string, string> = {
      'content-length': String(slice.length),
      'accept-ranges': 'bytes',
    };
    if (plan.etag) headers.etag = plan.etag;
    if (match) {
      headers['content-range'] = `bytes ${start}-${body.length - 1}/${body.length}`;
      res.writeHead(206, headers);
    } else {
      res.writeHead(200, headers);
    }

    const limit = plan.dropAfter?.(index) ?? null;
    let sent = 0;
    let first = true;
    let gated = false;
    for (let at = 0; at < slice.length; at += CHUNK) {
      if (limit !== null && sent >= limit) {
        // A connection that dies mid-body: no FIN, no trailer, exactly what a
        // dropped Wi-Fi link looks like to `fetch`.
        res.destroy();
        return;
      }
      const piece = slice.subarray(at, at + CHUNK);
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
  payload = randomBytes(PAYLOAD_BYTES);
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
     * FAULT INJECTED: the in-loop `while (pendingBytes >= FLUSH_BYTES)` flush
     * removed, leaving only the flush after the loop. Observed: no append in
     * three seconds, the race resolved 'nothing-written-in-3s', exit 1.
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
     * FAULT INJECTED: `restart()` no longer calls `sink.reset()`. Observed:
     * 13,987,273 bytes on disk instead of 9,449,529 — the partial prefix with
     * a whole file appended after it. Exit 1.
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

  it('never asks whether the Filesystem plugin is available', () => {
    // The one capability question that must not be delegated: the answer is
    // TRUE on plain web and means IndexedDB.
    expect(code).not.toContain('isPluginAvailable');
    expect(code).toContain("capabilities().modelStore === 'filesystem'");
  });
});
