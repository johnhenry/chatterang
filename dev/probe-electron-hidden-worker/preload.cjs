// The hidden worker's preload, for the BN3 probe. Sandboxed, context-isolated,
// as a worker window in apps/desktop would be.
//
// It does one thing: hand the MessagePort main transferred (webContents.postMessage)
// to the page's main world, where the host runtime and a turn runner live. The
// port is handed only when the page asks, so neither side has to win a race
// with the other's load.
'use strict';

const { ipcRenderer } = require('electron');

let held = null;
let wanted = false;

function hand() {
  if (held === null || !wanted) return;
  const port = held;
  held = null;
  window.postMessage('probe-port', '*', [port]);
}

ipcRenderer.on('probe-port', (event) => {
  held = event.ports[0] ?? null;
  hand();
});

window.addEventListener('message', (event) => {
  if (event.data !== 'probe-want-port') return;
  wanted = true;
  hand();
});
