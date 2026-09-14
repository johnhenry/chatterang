// Measure whether the desktop renderer can reach a plain-http model server, and
// WHICH layer refuses it when it cannot.
//
//   node_modules/.bin/electron dev/probe-electron-csp-http/main.cjs
//
// #284 admitted `http:` in `connect-src` so self-hosted providers (Ollama, LM
// Studio, any OpenAI-compatible server) are reachable at their plain-http
// defaults. The CSP is only one of the things that can refuse such a request.
// The app scheme is registered `secure: true`, so Chromium's mixed-content rules
// apply to it independently of any policy, and the shipped permission handler
// denies every permission but clipboard write. This probe separates the three.
//
// It imports `CSP_PRODUCTION` from apps/desktop/src/security.ts and
// `installPermissionHandlers` from apps/desktop/src/permissions.ts, so it
// measures the code that ships, not a copy of its rules. The one copy is `OLD`
// below: the policy as it was before #284, kept verbatim because that is the
// "before" being measured.
//
// It does NOT touch the clipboard. It binds an http server on 0.0.0.0 on a
// random port for the length of the run, which means anyone on the same network
// can reach it for those few seconds; it answers `pong` and nothing else.
const { app, BrowserWindow, protocol, session } = require('electron');
const http = require('node:http');
const os = require('node:os');
const { existsSync } = require('node:fs');
const { resolve } = require('node:path');
const { registerHooks } = require('node:module');
const { pathToFileURL, fileURLToPath } = require('node:url');

const REPO = resolve(__dirname, '..', '..');
const SCHEME = 'chatterang-desktop';

// The production policy before #284, verbatim. Only `connect-src` differs.
const OLD = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "img-src 'self' data: blob:",
  "font-src 'self' data: https://fonts.gstatic.com",
  "connect-src 'self' https: wss:",
  "object-src 'none'",
  "frame-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

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
const violations = [];
addEventListener('securitypolicyviolation', (e) => violations.push({ directive: e.effectiveDirective, blocked: e.blockedURI }));
window.fetchOnce = async (url) => {
  violations.length = 0;
  const timer = new Promise((r) => setTimeout(() => r({ outcome: 'timeout' }), 5000));
  const attempt = fetch(url, { mode: 'cors', cache: 'no-store' }).then(
    (res) => res.text().then((body) => ({ outcome: 'ok', status: res.status, body })),
    (e) => ({ outcome: 'error', name: e.name, message: String(e.message) }),
  );
  const result = await Promise.race([attempt, timer]);
  // securitypolicyviolation is dispatched asynchronously; give it a moment.
  await new Promise((r) => setTimeout(r, 150));
  return { ...result, hasFocus: document.hasFocus(), violations: violations.slice() };
};`;

/** RFC 1918, CGNAT, link-local, or other — so the README can name the class without the address. */
function addressClass(ip) {
  const [a, b] = ip.split('.').map(Number);
  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return 'RFC 1918 private';
  if (a === 100 && b >= 64 && b <= 127) return 'CGNAT 100.64/10';
  if (a === 169 && b === 254) return 'link-local';
  return 'public';
}

async function main() {
  const { CSP_PRODUCTION } = await import(pathToFileURL(resolve(REPO, 'apps/desktop/src/security.ts')).href);
  const { installPermissionHandlers } = await import(pathToFileURL(resolve(REPO, 'apps/desktop/src/permissions.ts')).href);

  const hits = [];
  const server = http.createServer((req, res) => {
    hits.push({ method: req.method, url: req.url, origin: req.headers.origin ?? null });
    // Permissive on purpose: CORS is not the variable being measured.
    const headers = {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': '*',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-private-network': 'true',
    };
    if (req.method === 'OPTIONS') { res.writeHead(204, headers); res.end(); return; }
    res.writeHead(200, { ...headers, 'content-type': 'text/plain' });
    res.end('pong');
  });
  await new Promise((r) => server.listen(0, '0.0.0.0', r));
  const port = server.address().port;

  const targets = [
    { label: '127.0.0.1', url: `http://127.0.0.1:${port}/ping` },
    { label: 'localhost', url: `http://localhost:${port}/ping` },
  ];
  const lan = [];
  for (const [name, addresses] of Object.entries(os.networkInterfaces())) {
    for (const a of addresses ?? []) {
      if (a.family === 'IPv4' && !a.internal) lan.push({ label: `${name} (${addressClass(a.address)})`, url: `http://${a.address}:${port}/ping` });
    }
  }
  if (lan.length === 0) console.log('PROBE_NOTE this machine has no non-loopback IPv4 address; the LAN case is NOT measured');
  targets.push(...lan);

  const policies = [
    ['old', OLD],
    ['new', CSP_PRODUCTION],
    ['none', null],
  ];

  const permissionLog = [];
  const sessions = [];
  // THE SHIPPED PERMISSION HANDLER, wrapped only to log what it decided — it is
  // what a packaged build runs, and it would refuse a Local Network Access prompt.
  const shipped = session.fromPartition('probe-csp-http-shipped');
  installPermissionHandlers({
    setPermissionRequestHandler: (handler) => shipped.setPermissionRequestHandler((wc, permission, callback, details) =>
      handler(wc, permission, (granted) => { permissionLog.push({ session: 'shipped', kind: 'request', permission, granted }); callback(granted); }, details)),
    setPermissionCheckHandler: (handler) => shipped.setPermissionCheckHandler((wc, permission, origin, details) => {
      const granted = handler(wc, permission, origin, details);
      permissionLog.push({ session: 'shipped', kind: 'check', permission, granted });
      return granted;
    }),
  }, '');
  sessions.push(['shipped-handler', shipped]);
  // THE CONTROL: no handler, so a refusal here cannot be the handler's.
  const control = session.fromPartition('probe-csp-http-default');
  control.setPermissionRequestHandler((_wc, permission, callback) => { permissionLog.push({ session: 'no-handler', kind: 'request', permission, granted: true }); callback(true); });
  sessions.push(['no-handler', control]);

  const rows = [];
  const serve = (request) => {
    const u = new URL(request.url);
    if (u.pathname === '/probe.js') return new Response(PROBE, { headers: { 'content-type': 'text/javascript' } });
    const headers = { 'content-type': 'text/html' };
    const policy = policies.find(([name]) => u.pathname === `/${name}.html`)?.[1];
    if (policy) headers['content-security-policy'] = policy;
    return new Response(PAGE, { headers });
  };

  /** Load one page, fetch every target from it, classify each result. */
  async function runPage(sessionName, ses, pageUrl, policyName) {
    const win = new BrowserWindow({ show: false, webPreferences: { session: ses, contextIsolation: true, nodeIntegration: false, sandbox: true } });
    const consoleLines = [];
    win.webContents.on('console-message', (event, _level, message) => {
      consoleLines.push(String((event && event.message) ?? message ?? ''));
    });
    try {
      await win.loadURL(pageUrl);
      win.webContents.focus();
      await new Promise((r) => setTimeout(r, 200));
      for (const target of targets) {
        consoleLines.length = 0;
        const hitsBefore = hits.length;
        const result = await win.webContents.executeJavaScript(`fetchOnce(${JSON.stringify(target.url)})`, true);
        await new Promise((r) => setTimeout(r, 150));
        const mixed = consoleLines.filter((line) => line.includes('Mixed Content'));
        const reached = hits.slice(hitsBefore);
        let verdict;
        if (result.outcome === 'ok' && result.body === 'pong') verdict = 'success';
        else if (result.violations.some((v) => v.directive === 'connect-src')) verdict = 'refused by CSP';
        else if (mixed.length > 0) verdict = 'refused as mixed content';
        else verdict = `other error (${result.outcome}${result.name ? ` ${result.name}` : ''})`;
        const row = {
          session: sessionName,
          policy: policyName,
          target: target.label,
          verdict,
          reachedServer: reached.length > 0,
          originSeen: reached[0]?.origin ?? null,
          hasFocus: result.hasFocus,
          violations: result.violations.map((v) => v.directive),
          console: consoleLines.slice(0, 4).map((line) => line.replace(/\d{1,3}(\.\d{1,3}){3}/g, '<ip>').slice(0, 220)),
        };
        rows.push(row);
        console.log('PROBE_ROW ' + JSON.stringify(row));
      }
    } catch (e) {
      console.log('PROBE_PAGE_ERROR ' + JSON.stringify({ session: sessionName, policy: policyName, error: String((e && e.message) || e) }));
    } finally {
      win.destroy();
      await new Promise((r) => setTimeout(r, 300));
    }
  }

  try {
    for (const [sessionName, ses] of sessions) {
      ses.protocol.handle(SCHEME, serve);
      for (const [policyName] of policies) await runPage(sessionName, ses, `${SCHEME}://app/${policyName}.html`, policyName);
    }

    // THE DETECTOR'S OWN CONTROL. A row above can read "success" because mixed
    // content never fires on the app scheme — or because this probe cannot see
    // it when it does. So the same fetches run once more, with no CSP, from a
    // page whose URL is genuinely `https:`. The session intercepts that host, so
    // nothing leaves the machine. If "refused as mixed content" never appears
    // here either, the classifier is blind and every "success" above is unproven.
    const mixedControl = session.fromPartition('probe-csp-http-mixed-control');
    mixedControl.protocol.handle('https', serve);
    sessions.push(['https-page-control', mixedControl]);
    await runPage('https-page-control', mixedControl, 'https://mixed-control.invalid/none.html', 'none');
  } finally {
    server.close();
  }

  const versions = { electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node };
  console.log('PROBE_VERSIONS ' + JSON.stringify(versions));
  console.log('PROBE_PERMISSIONS ' + JSON.stringify(permissionLog));
  console.log('\nPROBE_TABLE');
  for (const [sessionName] of sessions) {
    console.log(`\n${sessionName}`);
    console.log(`| target | old policy | new CSP_PRODUCTION | no CSP |`);
    console.log(`|---|---|---|---|`);
    for (const target of targets) {
      const cell = (policyName) => rows.find((r) => r.session === sessionName && r.policy === policyName && r.target === target.label)?.verdict ?? 'not run';
      console.log(`| ${target.label} | ${cell('old')} | ${cell('new')} | ${cell('none')} |`);
    }
  }
}

app.whenReady().then(async () => {
  if (process.platform === 'darwin') app.dock?.hide();
  const guard = setTimeout(() => { console.log('PROBE_TIMEOUT'); app.exit(2); }, 120_000);
  try { await main(); } catch (e) { console.log('PROBE_ERROR ' + (e && e.stack)); }
  clearTimeout(guard);
  app.exit(0);
});
