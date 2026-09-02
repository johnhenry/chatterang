import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

import pkg from './package.json' with { type: 'json' };

export default defineConfig({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      // Resolved to source, not a build artefact: the contracts package is
      // types-only, so there is nothing to compile and a build step here would
      // only add a way for the two to drift.
      '@chatterang/contracts': fileURLToPath(new URL('./packages/contracts/src', import.meta.url)),
      // Node-only, so it is never part of a web build — but the tests import
      // it, and resolving through the workspace symlink instead would make the
      // suite depend on `npm install` having linked it.
      '@chatterang/inference-node': fileURLToPath(
        new URL('./packages/inference-node/src', import.meta.url),
      ),
      // The ONNX backend. Node-only for a sharper reason than its sibling:
      // onnxruntime-node ships 283 MB of prebuilt native binaries, and there is
      // no darwin/x64 build at all. Aliased to source so the suite does not
      // depend on the workspace link, and banned from `src/` outright.
      '@chatterang/onnx-node': fileURLToPath(
        new URL('./packages/onnx-node/src', import.meta.url),
      ),
      // Same reasoning as inference-node: desktop-only, never in a web build,
      // and resolved to source so the suite does not depend on a workspace link.
      '@chatterang/cordis-aimatey': fileURLToPath(
        new URL('./packages/cordis-aimatey/src', import.meta.url),
      ),
      // The Electron shell. Desktop-only and never part of a web build —
      // nothing under `src/` imports it, and `tests/layering.test.ts` makes
      // that a rule rather than a habit. The alias exists so the bridge tests
      // can drive the real shell code without launching a window.
      '@chatterang/desktop': fileURLToPath(new URL('./apps/desktop/src', import.meta.url)),
      // The headless server (A9). Node-only in the same way and for the same
      // reason: it binds sockets and forks processes, so it is never part of a
      // web build. Aliased to source so the server tests can bind a real port
      // against the real code without a build step standing between them.
      '@chatterang/server': fileURLToPath(new URL('./apps/server/src', import.meta.url)),
    },
  },
  server: {
    port: 5273,
    host: true,
    headers: {
      // Required for threaded WASM runtimes (LiteRT-LM, ONNX Runtime Web,
      // wllama) that rely on SharedArrayBuffer.
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'credentialless',
    },
  },
  build: {
    target: 'es2022',
    sourcemap: true,
    rollupOptions: {
      /*
       * Optional peer dependencies of the aimatey backends.
       *
       * `@johnhenry/aimatey-backend-browser` declares `@litert-lm/core` as an
       * OPTIONAL peer (`peerDependenciesMeta.optional`) and imports it lazily,
       * so the package is meant to work without it. The bundler resolved that
       * lazy import eagerly anyway and, on failing, emitted a stub that throws
       * during module evaluation — which took down the whole app: React never
       * mounted and every page was blank, in the browser as well as in the
       * desktop shell. The build still exited 0, so nothing caught it.
       *
       * Marking it external restores the declared contract: the app boots, and
       * the import fails only if something actually reaches for LiteRT. Install
       * `@litert-lm/core` to enable that backend.
       */
      external: [/^@litert-lm\//, /^@opentelemetry\//],
      output: {
        // Keep the inference stack in its own chunk so the shell paints before
        // any adapter code is parsed.
        manualChunks(id: string) {
          if (id.includes('@johnhenry/aimatey')) return 'aimatey';
          return undefined;
        },
      },
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/**/*.test.{ts,tsx}'],
  },
});
