/*
 * Chatterang service worker — app shell only.
 *
 * The single most important thing here is what it does NOT do.
 *
 * This app downloads multi-gigabyte model weights to device storage and keeps
 * conversations in IndexedDB. Neither belongs in the Cache API:
 *
 *   - Model weights are downloaded with Range requests and are far larger than
 *     any origin quota. A service worker that intercepted them would either
 *     blow the quota, silently corrupt a partial download by caching a 206, or
 *     hold a second copy of a 4GB file. Every heuristic below that looks
 *     paranoid is there for that reason.
 *   - IndexedDB is not touched by the Cache API at all, and must not be
 *     "helped".
 *
 * Scope is therefore: the HTML shell, the built JS/CSS, and the icons. Nothing
 * else is ever cached.
 */

const VERSION = 'v1';
const SHELL = `chatterang-shell-${VERSION}`;
const ASSETS = `chatterang-assets-${VERSION}`;

/* Anything larger than this is not an app asset. The largest real chunk is the
 * lazily-loaded shell bundle at ~1.3MB; 8MB is a wide margin that still refuses
 * anything model-shaped that slips past the checks below. */
const MAX_CACHEABLE_BYTES = 8 * 1024 * 1024;

const MODEL_EXTENSIONS = /\.(gguf|onnx|onnx_data|litertlm|bin|safetensors|task|tflite)$/i;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL).then((c) => c.addAll(['/', '/index.html', '/manifest.webmanifest'])),
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== SHELL && k !== ASSETS).map((k) => caches.delete(k))),
      )
      .then(() => self.clients.claim()),
  );
});

/** Everything this worker refuses to touch, and why. */
function isOffLimits(request, url) {
  // Only ever GET. A POST to a provider is not ours to replay.
  if (request.method !== 'GET') return true;
  // Cross-origin: provider APIs, model hosts, CDNs. Never our business.
  if (url.origin !== self.location.origin) return true;
  // A Range request is a partial download -- caching a 206 as if it were whole
  // is how you get a silently corrupt model file.
  if (request.headers.has('range')) return true;
  // Model weights, wherever they are served from.
  if (MODEL_EXTENSIONS.test(url.pathname)) return true;
  if (url.pathname.startsWith('/models/')) return true;
  return false;
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (isOffLimits(event.request, url)) return; // fall through to the network, untouched

  // Navigations: network first, so a deploy is picked up immediately, with the
  // cached shell as the offline fallback. An on-device AI app that cannot open
  // without a network would be missing its own point.
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request)
        .then((res) => {
          const copy = res.clone();
          caches.open(SHELL).then((c) => c.put('/index.html', copy));
          return res;
        })
        .catch(() => caches.match('/index.html').then((r) => r ?? Response.error())),
    );
    return;
  }

  // Built assets are content-hashed, so a hit is always correct and a miss is
  // always a new build. Cache-first, populate in the background.
  event.respondWith(
    caches.match(event.request).then(
      (hit) =>
        hit ??
        fetch(event.request).then((res) => {
          if (!res.ok || res.status !== 200 || res.type !== 'basic') return res;
          const length = Number(res.headers.get('content-length') ?? '0');
          if (length > MAX_CACHEABLE_BYTES) return res;
          const copy = res.clone();
          caches.open(ASSETS).then((c) => c.put(event.request, copy));
          return res;
        }),
    ),
  );
});
