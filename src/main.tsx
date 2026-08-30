import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import '@/styles/tokens.css';
import '@/styles/base.css';
import '@/styles/components.css';

import { App } from '@/App';
import { registerShellTool } from '@/shell/register';
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

const container = document.getElementById('root');
if (!container) throw new Error('Missing #root element.');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
