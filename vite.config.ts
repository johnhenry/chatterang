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
