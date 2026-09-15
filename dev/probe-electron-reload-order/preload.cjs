// The reload-order probe's preload: one invoke, as the app's preload exposes
// `ipcRenderer.invoke` to the page. Sandboxed and context-isolated.
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('probe', {
  decode: (payload) => ipcRenderer.invoke('probe-decode', payload),
});
