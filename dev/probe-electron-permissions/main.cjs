// Measure the SHIPPED desktop permission policy in a real Electron window.
//
//   node_modules/.bin/electron dev/probe-electron-permissions/main.cjs
//
// It imports `installPermissionHandlers` from apps/desktop/src/permissions.ts
// itself — Electron 44 embeds Node 24 with TypeScript type stripping — so what is
// measured is the code that ships, not a copy of its rules.
//
// WRITES TO YOUR SYSTEM CLIPBOARD: the copy test needs a real write. The probe
// saves the clipboard's TEXT and writes it back afterwards; any non-text content
// (an image, rich text) is not restored. Run it with an empty or text-only
// clipboard.
const { app, BrowserWindow, protocol, session, clipboard } = require('electron');
const http = require('node:http');
const { existsSync } = require('node:fs');
const { resolve } = require('node:path');
const { registerHooks } = require('node:module');
const { pathToFileURL, fileURLToPath } = require('node:url');

const REPO = resolve(__dirname, '..', '..');
const SCHEME = 'chatterang-desktop';

// The repo writes TypeScript imports as `./x.js`, which tsc and the bundler
// resolve to `./x.ts` and Node does not. Map them, and nothing else.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && specifier.endsWith('.js') && context.parentURL) {
      const candidate = new URL(specifier.replace(/\.js$/, '.ts'), context.parentURL);
      if (existsSync(fileURLToPath(candidate))) return { url: candidate.href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

// Mirrors apps/desktop/src/main.ts exactly.
protocol.registerSchemesAsPrivileged([
  { scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);
// Electron quits when its last window closes unless something listens.
app.on('window-all-closed', () => {});

const PAGE = '<!doctype html><meta charset=utf-8><title>probe</title><body><script src="/probe.js"></script>';
const PROBE = `
const timeout = (p, ms, label) => Promise.race([p, new Promise((r) => setTimeout(() => r('TIMEOUT(' + label + ')'), ms))]);
window.runProbes = async (port, mode) => {
  const out = { hasFocus: document.hasFocus() };
  try { await navigator.clipboard.readText(); out.clipboardRead = 'granted'; } catch (e) { out.clipboardRead = 'ERR ' + e.name; }
  out.notification = await timeout(Notification.requestPermission(), 3000, 'notif');
  if (mode === 'control') return out;   // camera/location in an UNHANDLED session would raise OS prompts
  try { await navigator.clipboard.writeText('chatterang-permission-probe'); out.clipboardWrite = 'ok'; } catch (e) { out.clipboardWrite = 'ERR ' + e.name; }
  out.getUserMedia = await timeout(navigator.mediaDevices.getUserMedia({ video: true }).then((s) => { s.getTracks().forEach((t) => t.stop()); return 'granted(!)'; }, (e) => 'ERR ' + e.name), 4000, 'gum');
  out.geolocation = await timeout(new Promise((r) => navigator.geolocation.getCurrentPosition(() => r('granted(!)'), (e) => r('ERR code ' + e.code), { timeout: 2500 })), 3500, 'geo');
  out.loopbackFetch = await timeout(fetch('http://127.0.0.1:' + port + '/ping').then((res) => res.text().then((t) => 'ok ' + t), (e) => 'ERR ' + e.name), 4000, 'fetch');
  if (mode === 'open') {
    out.sandboxedIframe = await timeout(new Promise((resolve) => {
      const f = document.createElement('iframe');
      f.setAttribute('sandbox', 'allow-scripts');
      f.srcdoc = '<script>(async()=>{const o={};try{await navigator.clipboard.writeText("iframe");o.clip="ok(!)"}catch(e){o.clip="ERR "+e.name}try{const s=await navigator.mediaDevices.getUserMedia({video:true});s.getTracks().forEach(t=>t.stop());o.gum="granted(!)"}catch(e){o.gum="ERR "+e.name}parent.postMessage(o,"*")})()<\\/script>';
      addEventListener('message', (m) => resolve(m.data), { once: true });
      document.body.appendChild(f);
    }), 6000, 'iframe');
  }
  return out;
};`;

async function main() {
  const { installPermissionHandlers } = await import(pathToFileURL(resolve(REPO, 'apps/desktop/src/permissions.ts')).href);
  const { CSP_PRODUCTION } = await import(pathToFileURL(resolve(REPO, 'apps/desktop/src/security.ts')).href);

  const log = [];
  const results = {};
  // Electron 44's clipboard is asynchronous: readText and writeText return promises.
  const saved = await clipboard.readText();
  const server = http.createServer((_q, res) => { res.writeHead(200, { 'access-control-allow-origin': '*' }); res.end('pong'); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  const sessions = [];
  // THE SHIPPED POLICY, wrapped only to log what it decided.
  const shipped = session.fromPartition('probe-shipped');
  installPermissionHandlers({
    setPermissionRequestHandler: (handler) => shipped.setPermissionRequestHandler((wc, permission, callback, details) =>
      handler(wc, permission, (granted) => { log.push({ session: 'shipped', kind: 'request', permission, url: details.requestingUrl || wc.getURL(), granted }); callback(granted); }, details)),
    setPermissionCheckHandler: (handler) => shipped.setPermissionCheckHandler((wc, permission, origin, details) => {
      const granted = handler(wc, permission, origin, details);
      log.push({ session: 'shipped', kind: 'check', permission, url: details.requestingUrl || origin, granted });
      return granted;
    }),
  }, '');
  sessions.push(['shipped', shipped, ['csp', 'open']]);
  // THE CONTROL: Electron with no handler, which is what the app shipped before.
  sessions.push(['electron-default', session.fromPartition('probe-default'), ['control']]);

  try {
    for (const [name, ses, modes] of sessions) {
      ses.protocol.handle(SCHEME, (request) => {
        const u = new URL(request.url);
        if (u.pathname === '/probe.js') return new Response(PROBE, { headers: { 'content-type': 'text/javascript' } });
        const headers = { 'content-type': 'text/html' };
        if (u.pathname === '/csp.html') headers['content-security-policy'] = CSP_PRODUCTION;
        return new Response(PAGE, { headers });
      });
      for (const mode of modes) {
        const key = `${name} ${mode}`;
        const win = new BrowserWindow({ show: false, webPreferences: { session: ses, contextIsolation: true, nodeIntegration: false, sandbox: true } });
        try {
          await win.loadURL(`${SCHEME}://app/${mode === 'csp' ? 'csp' : 'open'}.html`);
          win.webContents.focus();
          await new Promise((r) => setTimeout(r, 200));
          results[key] = await win.webContents.executeJavaScript(`runProbes(${port}, ${JSON.stringify(mode)})`, true);
        } catch (e) {
          results[key] = { error: String((e && e.message) || e) };
        } finally {
          win.destroy();
          await new Promise((r) => setTimeout(r, 300));
        }
        console.log('PROBE_ROUTE ' + JSON.stringify({ key, result: results[key] }));
      }
    }
  } finally {
    try { await clipboard.writeText(saved); console.log('CLIPBOARD_RESTORED textLength=' + saved.length); }
    catch (e) { console.log('CLIPBOARD_RESTORE_FAILED ' + e); }
    server.close();
    console.log('PROBE_RESULTS ' + JSON.stringify({ versions: { electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node }, results, log }, null, 1));
  }
}

app.whenReady().then(async () => {
  if (process.platform === 'darwin') app.dock?.hide();
  const guard = setTimeout(() => { console.log('PROBE_TIMEOUT'); app.exit(2); }, 90_000);
  try { await main(); } catch (e) { console.log('PROBE_ERROR ' + (e && e.stack)); }
  clearTimeout(guard);
  app.exit(0);
});
