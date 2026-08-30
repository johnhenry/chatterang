import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8');
const manifest = JSON.parse(read('public/manifest.webmanifest')) as Record<string, unknown>;
const sw = read('public/sw.js');
const pwa = read('src/lib/pwa.ts');
const html = read('index.html');

describe('web app manifest', () => {
  it('declares the fields a browser needs to offer installation', () => {
    for (const key of ['name', 'start_url', 'display', 'icons', 'background_color']) {
      expect(manifest[key], `manifest.${key}`).toBeTruthy();
    }
    expect(manifest.display).toBe('standalone');
  });

  it('ships a maskable icon as well as an "any" one', () => {
    const icons = manifest.icons as { purpose: string; sizes: string }[];
    expect(icons.some((i) => i.purpose === 'maskable')).toBe(true);
    expect(icons.some((i) => i.purpose === 'any' && i.sizes === '512x512')).toBe(true);
  });

  it('does not lock orientation — a tablet with a keyboard is landscape', () => {
    expect(manifest.orientation).toBe('any');
  });

  it('is linked from the document, with the iOS tags the manifest cannot cover', () => {
    expect(html).toContain('rel="manifest"');
    expect(html).toContain('rel="apple-touch-icon"');
    expect(html).toContain('apple-mobile-web-app-capable');
  });
});

/**
 * These are the assertions that matter. This app downloads multi-gigabyte model
 * weights; a service worker that caches one would blow the origin quota, or
 * cache a 206 from a Range request as though it were a whole file and hand back
 * a corrupt model later. Every check here is a specific way that goes wrong.
 */
describe('service worker refuses everything that is not the app shell', () => {
  it('never handles a Range request', () => {
    expect(sw).toContain("headers.has('range')");
  });

  it('never handles model weight extensions', () => {
    for (const ext of ['gguf', 'onnx', 'litertlm', 'safetensors']) {
      expect(sw, `missing ${ext}`).toContain(ext);
    }
  });

  it('never handles cross-origin requests', () => {
    expect(sw).toContain('url.origin !== self.location.origin');
  });

  it('caps what it will cache well below any model size', () => {
    expect(sw).toMatch(/MAX_CACHEABLE_BYTES\s*=\s*8\s*\*\s*1024\s*\*\s*1024/);
    expect(sw).toContain('content-length');
  });

  it('serves navigations network-first so a deploy is not pinned by the cache', () => {
    const nav = sw.slice(sw.indexOf("mode === 'navigate'"));
    expect(nav.indexOf('fetch(event.request)')).toBeLessThan(nav.indexOf('caches.match'));
  });
});

describe('service worker registration', () => {
  it('does not register inside a Capacitor webview', () => {
    expect(pwa).toContain('Capacitor.isNativePlatform()');
    const body = pwa.slice(pwa.indexOf('export function registerServiceWorker'));
    // The native guard must come before the register call, not after it.
    expect(body.indexOf('isNativePlatform')).toBeLessThan(body.indexOf('.register('));
  });

  it('does not register in development', () => {
    expect(pwa).toContain('import.meta.env.PROD');
  });
});
