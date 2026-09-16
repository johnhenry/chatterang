import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import '@/styles/tokens.css';
import '@/styles/base.css';
import '@/styles/components.css';

import { App } from '@/App';
import { registerShellTool } from '@/shell/register';
import { captureInstallPrompt, registerServiceWorker } from '@/lib/pwa';
import { useApp } from '@/state/app';
import { useModels } from '@/state/models';
import { useChats } from '@/state/chat';
import { usePersonas } from '@/state/personas';
import { useBench } from '@/state/bench';
import { useImages } from '@/state/images';

// Development-only handle on the stores. Inference bugs are usually state
// bugs, and being able to inspect the engine from the console beats adding
// log statements to a streaming loop.
if (import.meta.env.DEV) {
  Object.assign(globalThis, {
    __chatterang: { useApp, useModels, useChats, usePersonas, useBench, useImages },
  });
}

// Registered here rather than from a store module: the shell reads every
// store, and a store importing it back would close an import cycle that only
// fails at runtime. The entry point runs after all modules are initialised.
registerShellTool();

// Offline shell + install prompt. Both no-op inside a Capacitor webview and in
// dev; see src/lib/pwa.ts for why.
registerServiceWorker();
captureInstallPrompt();

/*
 * S4 (#296): a hidden Electron window loads this exact bundle with
 * `?peerTurnWorker=1` to run a paired phone's turns
 * (`apps/desktop/src/bridge/peer-turn-window.ts` sets the flag;
 * `apps/desktop/src/bridge/peer-turns.ts` is the far end). Dynamically
 * imported so the mobile bundle, which never sets this flag, never fetches
 * `peer-turn-worker.ts` or the desktop-only bridge modules it reaches into.
 */
if (new URLSearchParams(window.location.search).get('peerTurnWorker') === '1') {
  void import('@/peer-turn-worker').then((worker) => worker.startPeerTurnWorker());
}

const container = document.getElementById('root');
if (!container) throw new Error('Missing #root element.');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
