import { createServer } from 'node:http';
// The VERBATIM policy from apps/server/src/policy.ts (SERVED_CSP).
const CSP = [
  "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:", "font-src 'self' data:",
  "connect-src 'self' https: wss:", "object-src 'none'", "frame-src 'none'",
  "base-uri 'self'", "form-action 'self'",
].join('; ');
const PAGE = `<!doctype html><meta charset=utf-8><title>csp probe</title><body><pre id=o>running…</pre>
<script src="probe.js"></script></body>`;
// Smallest valid wasm module: (module)
const PROBE = `
const out = [];
const log = (k, v) => { out.push(k + ': ' + v); document.getElementById('o').textContent = out.join('\\n'); };
(async () => {
  const bytes = new Uint8Array([0,97,115,109,1,0,0,0]);
  try { await WebAssembly.instantiate(bytes); log('WASM instantiate', 'ALLOWED'); }
  catch (e) { log('WASM instantiate', 'BLOCKED — ' + e.constructor.name + ': ' + String(e.message).slice(0,90)); }
  try {
    const w = new Worker(URL.createObjectURL(new Blob(['self.postMessage(1)'], {type:'application/javascript'})));
    await new Promise((res, rej) => { w.onmessage = res; w.onerror = () => rej(new Error('worker onerror (no message)')); setTimeout(() => rej(new Error('timeout')), 1500); });
    log('blob: Worker', 'ALLOWED');
  } catch (e) { log('blob: Worker', 'BLOCKED — ' + String(e.message).slice(0,90)); }
  log('policy in force', document.querySelector('meta[http-equiv]') ? 'meta' : 'header only');
})();
`;
// THE PAIRED CONTROL: `/mobile` serves the app's index.html meta policy
// instead — `img-src 'self' data: blob:` only, which is the ONLY policy in
// force at capacitor://localhost. If both probes are blocked there too, my
// probe is broken rather than the policy being strict.
const MOBILE_CSP = "img-src 'self' data: blob:";
createServer((req, res) => {
  const p = (req.url || '/').split('?')[0];
  const policy = p.startsWith('/mobile') ? MOBILE_CSP : CSP;
  if (p.endsWith('probe.js')) { res.writeHead(200, {'content-type':'text/javascript','Content-Security-Policy':policy}); return res.end(PROBE); }
  res.writeHead(200, {'content-type':'text/html; charset=utf-8','Content-Security-Policy':policy});
  res.end(PAGE);
}).listen(8931, '127.0.0.1', () => console.log('csp probe on http://127.0.0.1:8931'));
