// The reload-order probe's page. Each document picks an id and keeps calling
// main through `ipcRenderer.invoke` for as long as it runs: once at start, on a
// 1 ms interval (Chromium clamps it), and from every unload-time event it gets.
// Main records which document each call came from and when it arrived, against
// the navigation events. Nothing here is a prompt or text.
'use strict';

(() => {
  const docId = crypto.randomUUID();
  let seq = 0;
  const send = (kind) => {
    const payload = { docId, seq: seq++, kind, pageWall: Date.now() };
    window.probe.decode(payload).catch(() => undefined);
  };
  send('first');
  setInterval(() => send('interval'), 1);
  addEventListener('beforeunload', () => send('beforeunload'));
  addEventListener('pagehide', () => send('pagehide'));
  addEventListener('unload', () => send('unload'));
  addEventListener('visibilitychange', () => send(`visibilitychange:${document.visibilityState}`));
})();
