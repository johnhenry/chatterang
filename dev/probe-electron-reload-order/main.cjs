// BN3 item 5 (#313): the main-frame reload event order, and when the old
// document's last `ipcMain.handle` call can still arrive.
//
//   node dev/probe-electron-hidden-worker/run.cjs --probe=dev/probe-electron-reload-order/main.cjs
//   node_modules/.bin/electron dev/probe-electron-reload-order/main.cjs --only='<scenario>' -ApplePersistenceIgnoreState YES
//
// A window loads a page over a custom scheme served by `protocol.handle`, as the
// app serves `chatterang-desktop://` (apps/desktop/src/main.ts). The page calls
// `ipcRenderer.invoke` every few milliseconds with its own document id. Each
// scenario navigates the window five times one way, with the new document's
// response held back 0 or 500 ms, and records per navigation:
//
// - every webContents navigation event, and when the document request reached
//   the protocol handler;
// - every invoke, by document, with `event.senderFrame`'s identity at arrival;
// - so: how long after 'did-start-navigation' (where main.ts tears a window's
//   turns down today) the OLD document's calls keep arriving, whether any
//   arrives after the new document commits ('did-frame-navigate' /
//   'did-navigate'), and whether main could tell the two documents apart
//   without an id the page supplies.
//
// The window is hidden with backgroundThrottling:false, so its 1 ms interval
// is not throttled to once a second. It opens no socket; it checks with lsof
// that no process it started holds one bound to anything but 127.0.0.1.
'use strict';

const { app, BrowserWindow, ipcMain, protocol } = require('electron');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const lib = require('../probe-electron-hidden-worker/lib.cjs');

const { out, arg, flag, sleep, until, stats } = lib;

const SCHEME = 'probe-reload';
const ORIGIN = `${SCHEME}://app`;
const ROOT = lib.tempRoot('probe-bn3-reload-');
const ONLY = arg('only');
const LIST = flag('list');
const REPS = Number(arg('reps', '5')) || 5;

const t0 = process.hrtime.bigint();
const now = () => Number(process.hrtime.bigint() - t0) / 1e6;
const round = (n) => (n === null || n === undefined ? null : Math.round(n * 10) / 10);

protocol.registerSchemesAsPrivileged([
  { scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
]);
lib.quietApp(app, ROOT);
lib.guardListen();

const PAGE = '<!doctype html><meta charset="utf-8"><title>reload order probe</title><script src="/page.js"></script>';

/** How long the protocol handler holds a document response back, in ms. */
let documentDelayMs = 0;
const requests = [];
const invokes = [];
const events = [];

function serve() {
  protocol.handle(SCHEME, async (request) => {
    const { pathname } = new URL(request.url);
    if (pathname === '/page.js') {
      return new Response(readFileSync(join(__dirname, 'page.js')), { headers: { 'content-type': 'text/javascript' } });
    }
    if (pathname === '/index.html' || pathname === '/next.html') {
      const entry = { path: pathname, at: now(), delayMs: documentDelayMs };
      requests.push(entry);
      if (documentDelayMs > 0) await sleep(documentDelayMs);
      entry.respondedAt = now();
      return new Response(PAGE, { headers: { 'content-type': 'text/html' } });
    }
    return new Response('not found', { status: 404 });
  });
}

function frameIdentity(frame) {
  if (frame === null || frame === undefined) return null;
  try {
    return { token: frame.frameToken, processId: frame.processId, routingId: frame.routingId, detached: frame.detached };
  } catch (error) {
    return { threw: error.name };
  }
}

function record(wc) {
  const mark = (event, extra = {}) => events.push({ event, at: now(), ...extra });
  wc.on('did-start-loading', () => mark('did-start-loading'));
  wc.on('did-start-navigation', (details) =>
    mark('did-start-navigation', {
      isMainFrame: details.isMainFrame,
      isSameDocument: details.isSameDocument,
      mainFrameAtEvent: frameIdentity(wc.mainFrame),
    }),
  );
  wc.on('will-navigate', (details) => mark('will-navigate', { isMainFrame: details.isMainFrame }));
  wc.on('will-frame-navigate', (details) => mark('will-frame-navigate', { isMainFrame: details.isMainFrame }));
  wc.on('did-redirect-navigation', () => mark('did-redirect-navigation'));
  wc.on('frame-created', (_event, details) => mark('frame-created', { frame: frameIdentity(details.frame) }));
  wc.on('did-frame-navigate', (_event, _url, _code, _status, isMainFrame) =>
    mark('did-frame-navigate', { isMainFrame, mainFrameAtEvent: frameIdentity(wc.mainFrame) }),
  );
  wc.on('did-navigate', () => mark('did-navigate', { mainFrameAtEvent: frameIdentity(wc.mainFrame) }));
  wc.on('dom-ready', () => mark('dom-ready'));
  wc.on('did-frame-finish-load', (_event, isMainFrame) => mark('did-frame-finish-load', { isMainFrame }));
  wc.on('did-finish-load', () => mark('did-finish-load'));
  wc.on('did-stop-loading', () => mark('did-stop-loading'));
  wc.on('render-process-gone', (_event, details) => mark('render-process-gone', { reason: details.reason }));
}

const TRIGGERS = {
  'webContents.reload()': (wc) => wc.reload(),
  'location.reload() in the page': (wc) => void wc.executeJavaScript('location.reload()').catch(() => undefined),
  'webContents.loadURL(the same URL)': (wc) => void wc.loadURL(`${ORIGIN}/index.html`).catch(() => undefined),
  'location.href = another same-origin document': (wc) =>
    void wc.executeJavaScript(`location.href = '${ORIGIN}/next.html'`).catch(() => undefined),
};

const scenarios = new Map();
for (const [trigger, fire] of Object.entries(TRIGGERS)) {
  for (const delay of [0, 500]) {
    scenarios.set(`reload: ${trigger}, document held ${delay} ms`, { fire, delay });
  }
}

const firstEvent = (name, after, predicate = () => true) => events.find((e) => e.event === name && e.at >= after && predicate(e));

async function oneNavigation(wc, fire, delay) {
  // A steady old document first.
  await until(() => invokes.length > 0, 10_000, 'the page to call main');
  const oldDoc = invokes.at(-1).docId;
  const steadyFrom = now();
  await until(() => invokes.some((i) => i.docId === oldDoc && i.at > steadyFrom + 200), 10_000, 'the old document to keep calling');
  documentDelayMs = delay;
  const triggerAt = now();
  fire(wc);
  await until(() => invokes.some((i) => i.at > triggerAt && i.docId !== oldDoc), 15_000, 'the new document to call main');
  const newDoc = invokes.find((i) => i.at > triggerAt && i.docId !== oldDoc).docId;
  await sleep(700);
  documentDelayMs = 0;

  const start = firstEvent('did-start-navigation', triggerAt, (e) => e.isMainFrame && !e.isSameDocument);
  const frameNav = firstEvent('did-frame-navigate', triggerAt, (e) => e.isMainFrame);
  const didNavigate = firstEvent('did-navigate', triggerAt);
  const domReady = firstEvent('dom-ready', triggerAt);
  const finish = firstEvent('did-finish-load', triggerAt);
  const request = requests.find((r) => r.at >= triggerAt);
  const commitAt = frameNav?.at ?? didNavigate?.at ?? null;
  const startAt = start?.at ?? null;
  const rel = (at, base) => (at === null || at === undefined || base === null ? null : round(at - base));

  const olds = invokes.filter((i) => i.docId === oldDoc);
  const news = invokes.filter((i) => i.docId === newDoc);
  const lastOld = olds.at(-1);
  const firstNew = news[0];
  const oldAfterStart = startAt === null ? [] : olds.filter((i) => i.at > startAt);
  const oldAfterCommit = commitAt === null ? [] : olds.filter((i) => i.at > commitAt);
  const identities = (list) => [...new Set(list.map((i) => JSON.stringify(i.senderFrame && { token: i.senderFrame.token, processId: i.senderFrame.processId, routingId: i.senderFrame.routingId })))];
  const oldIds = identities(olds.filter((i) => i.at > triggerAt - 300));
  const newIds = identities(news);
  const order = events
    .filter((e) => e.at >= triggerAt && e.at <= (finish?.at ?? now()))
    .filter((e) => e.isMainFrame !== false)
    .map((e) => e.event);

  return {
    order: [...new Set(order)].length === order.length ? order : order,
    msFromDidStartNavigation: {
      documentRequestReachedHandler: rel(request?.at, startAt),
      documentResponseReturned: rel(request?.respondedAt, startAt),
      didFrameNavigate: rel(frameNav?.at, startAt),
      didNavigate: rel(didNavigate?.at, startAt),
      domReady: rel(domReady?.at, startAt),
      didFinishLoad: rel(finish?.at, startAt),
      lastOldDocumentCall: rel(lastOld?.at, startAt),
      firstNewDocumentCall: rel(firstNew?.at, startAt),
    },
    triggerToDidStartNavigationMs: rel(startAt, triggerAt),
    oldDocument: {
      callsAfterDidStartNavigation: oldAfterStart.length,
      kindsAfterDidStartNavigation: [...new Set(oldAfterStart.map((i) => i.kind))],
      callsAfterCommit: oldAfterCommit.length,
      lastCallKind: lastOld?.kind,
      lastCallMsAfterCommit: rel(lastOld?.at, commitAt),
      lastCallSenderFrameNull: lastOld?.senderFrame === null,
      unloadTimeKindsSeen: [...new Set(olds.filter((i) => !['first', 'interval'].includes(i.kind)).map((i) => i.kind))],
    },
    newDocument: {
      firstCallMsAfterCommit: rel(firstNew?.at, commitAt),
      firstCallMsAfterDomReady: rel(firstNew?.at, domReady?.at),
    },
    senderFrame: {
      oldDocumentIdentities: oldIds,
      newDocumentIdentities: newIds,
      distinguishable: oldIds.every((id) => !newIds.includes(id)),
      mainFrameAtDidStartNavigation: start?.mainFrameAtEvent ?? null,
      mainFrameAtDidFrameNavigate: frameNav?.mainFrameAtEvent ?? null,
    },
  };
}

app.whenReady().then(async () => {
  lib.accessory(app);
  serve();
  app.on('window-all-closed', () => undefined);
  if (LIST) {
    out(`PROBE_LIST ${JSON.stringify([...scenarios.keys()])}`);
    app.exit(0);
    return;
  }
  const entry = scenarios.get(ONLY);
  if (entry === undefined) {
    out(`PROBE_FAIL no scenario named ${JSON.stringify(ONLY)}`);
    app.exit(1);
    return;
  }
  const loadBefore = lib.loads();
  const loopback = [];
  const check = (label) => loopback.push({ label, ...lib.assertLoopbackOnly(app.getAppMetrics().map((m) => m.pid)) });
  const guard = setTimeout(() => {
    out(`PROBE_FAIL ${ONLY}: still running at its limit`);
    app.exit(3);
  }, 120_000);

  let data;
  let error;
  try {
    ipcMain.handle('probe-decode', (event, payload) => {
      invokes.push({
        at: now(),
        docId: payload.docId,
        seq: payload.seq,
        kind: payload.kind,
        senderFrame: frameIdentity(event.senderFrame),
        processId: event.processId,
        frameId: event.frameId,
      });
      return true;
    });
    const win = new BrowserWindow({
      show: false,
      webPreferences: {
        preload: join(__dirname, 'preload.cjs'),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
      },
    });
    const wc = win.webContents;
    record(wc);
    await win.loadURL(`${ORIGIN}/index.html`);
    check('window loaded');
    const navigations = [];
    for (let rep = 0; rep < REPS; rep += 1) navigations.push(await oneNavigation(wc, entry.fire, entry.delay));
    const pick = (fn) => navigations.map(fn).filter((n) => n !== null && n !== undefined);
    data = {
      trigger: ONLY,
      documentDelayMs: entry.delay,
      navigations: navigations.length,
      summary: {
        lastOldCallMsAfterDidStartNavigation: stats(pick((n) => n.msFromDidStartNavigation.lastOldDocumentCall)),
        lastOldCallMsAfterCommit: stats(pick((n) => n.oldDocument.lastCallMsAfterCommit)),
        oldCallsAfterDidStartNavigation: stats(pick((n) => n.oldDocument.callsAfterDidStartNavigation)),
        oldCallsAfterCommit: stats(pick((n) => n.oldDocument.callsAfterCommit)),
        didFrameNavigateMsAfterDidStartNavigation: stats(pick((n) => n.msFromDidStartNavigation.didFrameNavigate)),
        firstNewCallMsAfterCommit: stats(pick((n) => n.newDocument.firstCallMsAfterCommit)),
        senderFrameDistinguishable: pick((n) => n.senderFrame.distinguishable),
        orders: [...new Set(navigations.map((n) => n.order.join(' > ')))],
      },
      perNavigation: navigations,
      totalInvokes: invokes.length,
    };
    win.destroy();
    check('end');
  } catch (caught) {
    error = String(caught?.stack ?? caught);
  }
  clearTimeout(guard);
  const ok = error === undefined && loopback.length > 0 && loopback.every((l) => l.ok);
  out(
    `PROBE_RESULT ${JSON.stringify({
      name: ONLY,
      ok,
      error,
      loadBefore,
      loadAfter: lib.loads(),
      versions: lib.versions(),
      loopback: loopback.map((l) => ({ label: l.label, ok: l.ok, checked: l.checked.length, bound: l.bound, offending: l.offending, error: l.error })),
      data,
    })}`,
  );
  app.exit(ok ? 0 : 1);
});
