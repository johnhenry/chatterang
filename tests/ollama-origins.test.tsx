/**
 * THE VALUE THE OLLAMA NOTE ASKS FOR, AND WHERE IT ASKS (#284).
 *
 * Every request this app makes carries its own page origin as `Origin`, and a
 * stock Ollama 0.34.0 refuses some of those origins with 403. The owner ruled
 * that the Ollama note names `OLLAMA_ORIGINS` and shows the narrowest value that
 * still lets Ollama start, derived from this app's origin at runtime, and only
 * where one is needed.
 *
 * The expected values here are not derived from the code. Each one was measured
 * against a throwaway `ollama serve` 0.34.0, one process per value, on its own
 * loopback port with an empty models directory
 * (`dev/probe-electron-csp-http/README.md`), tabled below in line comments
 * because the values contain the characters that would close this one.
 *
 * The note is rendered into a real DOM, with `window.location` stubbed per test,
 * because the panel reads the origin when it renders.
 */
//
//   unset                          chatterang-desktop://app 403, capacitor://localhost 403,
//                                  https://localhost 200, http://localhost:5273 200,
//                                  http://192.168.1.10:5273 403, null 403
//   chatterang-desktop://app       Ollama panics before listening (so does httpx://host)
//   *chatterang-desktop://app      ://app 200, ://app-evil 403, but xchatterang-desktop://app
//                                  and evil.chatterang-desktop://app 200
//   chatterang-desktop:*//app      ://app 200; xchatterang-desktop://app, evil.…, ://app-evil,
//                                  ://evil, ://app:1, ://x.app, chatterang-desktop-x://app 403
//   capacitor:*//localhost         capacitor://localhost 200; xcapacitor://localhost,
//                                  ://localhost.evil, ://evil, ://localhost:1 403
//   http://192.168.1.10:5273       that origin 200; :5274, :52730, https://, .100 all 403
//   httpx:*//host                  starts; httpx://host 200, xhttpx://host 403

import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

/* ── The database, stubbed at the table boundary ────────────────────── */

const tables = vi.hoisted(() => ({
  models: { put: vi.fn(async () => {}), delete: vi.fn(async () => {}), toArray: async () => [] },
  settings: { get: vi.fn(async () => undefined), put: vi.fn(async () => {}) },
  chats: { put: vi.fn(async () => {}), delete: vi.fn(async () => {}), toArray: async () => [] },
  messages: {
    put: vi.fn(async () => {}),
    delete: vi.fn(async () => {}),
    where: () => ({ equals: () => ({ sortBy: async () => [], toArray: async () => [] }) }),
  },
  benchmarks: {
    put: vi.fn(async () => {}),
    delete: vi.fn(async () => {}),
    clear: vi.fn(async () => {}),
    orderBy: () => ({ reverse: () => ({ toArray: async () => [] }) }),
  },
  connections: { put: vi.fn(async () => {}), delete: vi.fn(async () => {}), toArray: async () => [] },
}));

vi.mock('@/db', () => ({
  db: tables,
  deleteChat: vi.fn(async () => {}),
  readSetting: async (_key: string, fallback: unknown) => fallback,
  writeSetting: vi.fn(async () => {}),
}));

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { PROVIDERS, getProvider, ollamaOriginsSetting } = await import('@/ai/providers');
const { ProvidersPanel } = await import('@/features/settings/ProvidersPanel');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * How Ollama 0.34.0 matched an entry in every row measured: exact, or around its
 * one `*`, the text before it as a prefix and the text after it as a suffix. A
 * leading `*` is a suffix match and a trailing one a prefix match. Used only to
 * state the look-alike rows the measurement found; the values themselves are
 * pinned.
 */
function measuredAdmits(entry: string, origin: string): boolean {
  const star = entry.indexOf('*');
  if (star === -1) return entry === origin;
  return origin.startsWith(entry.slice(0, star)) && origin.endsWith(entry.slice(star + 1));
}

/** Ollama's startup check: an entry with no `*` must name one of these schemes. */
const STARTS_WITHOUT_STAR = [
  'http://',
  'https://',
  'chrome-extension://',
  'safari-extension://',
  'moz-extension://',
  'ms-browser-extension://',
];
function ollamaStartsWith(value: string): boolean {
  return value.includes('*') || STARTS_WITHOUT_STAR.some((scheme) => value.startsWith(scheme));
}

/* ── The pure function ───────────────────────────────────────────────── */

describe('ollamaOriginsSetting', () => {
  it('asks for nothing where Ollama already answers the origin', () => {
    // The four shipped web origins Ollama allows by default, and the non-http
    // defaults its `server config` line lists. Each measured 200 with nothing set.
    for (const origin of [
      'https://localhost',
      'http://localhost:5273',
      'http://127.0.0.1',
      'https://0.0.0.0:8443',
      'app://-',
      'tauri://localhost',
      'vscode-webview://abc',
      'vscode-file://vscode-app',
    ]) {
      expect(ollamaOriginsSetting(origin), origin).toEqual({ kind: 'none-needed' });
    }
  });

  it('gives an http(s) origin outside the defaults as itself, exactly', () => {
    expect(ollamaOriginsSetting('http://192.168.1.10:5273')).toEqual({
      kind: 'add',
      value: 'http://192.168.1.10:5273',
    });
    expect(ollamaOriginsSetting('http://[::1]:5273')).toEqual({
      kind: 'add',
      value: 'http://[::1]:5273',
    });
    expect(ollamaOriginsSetting('https://chat.example.com')).toEqual({
      kind: 'add',
      value: 'https://chat.example.com',
    });
    // Starts with a default's letters, and is not one: measured 403 unset.
    expect(ollamaOriginsSetting('http://localhost.evil.example')).toEqual({
      kind: 'add',
      value: 'http://localhost.evil.example',
    });
  });

  it('gives any other scheme the star after its colon, never the bare origin', () => {
    expect(ollamaOriginsSetting('chatterang-desktop://app')).toEqual({
      kind: 'add',
      value: 'chatterang-desktop:*//app',
    });
    expect(ollamaOriginsSetting('capacitor://localhost')).toEqual({
      kind: 'add',
      value: 'capacitor:*//localhost',
    });
    // Measured to start and admit that origin alone, port included.
    expect(ollamaOriginsSetting('x-custom+scheme.v2://host:8080')).toEqual({
      kind: 'add',
      value: 'x-custom+scheme.v2:*//host:8080',
    });
    // An exact value on an extension scheme also starts; the middle form admits
    // the same one origin (measured: xchrome-extension://abcdef and
    // chrome-extension://abcdefg 403), so one rule covers it.
    expect(ollamaOriginsSetting('chrome-extension://abcdef')).toEqual({
      kind: 'add',
      value: 'chrome-extension:*//abcdef',
    });
  });

  it('gives no value for an opaque origin', () => {
    expect(ollamaOriginsSetting('null')).toEqual({ kind: 'unknown' });
  });

  it('gives no value for anything that is not exactly a serialized origin', () => {
    for (const garbage of [
      '',
      ' ',
      'file://',
      'about:blank',
      'javascript:alert(1)',
      'chatterang-desktop://app/',
      'http://localhost:5273/settings',
      'https://user@localhost',
      ' https://localhost',
      'HTTP://LOCALHOST',
      // Not what a browser sends: the default port, and a numeric host it rewrites.
      'http://localhost:80',
      'http://192.168.1.10:80',
      'http://0x7f.1',
      'http://192.168.1.10:99999',
      // A comma splits OLLAMA_ORIGINS into two entries; a star widens the match.
      'http://a,b',
      'chatterang-desktop://app,http://evil.example',
      'http://*.example.com',
      'chatterang-desktop://*',
    ]) {
      expect(ollamaOriginsSetting(garbage), JSON.stringify(garbage)).toEqual({ kind: 'unknown' });
    }
  });

  it('never prints a value that stops Ollama starting', () => {
    // The crash class: `OLLAMA_ORIGINS=chatterang-desktop://app` panics with
    // "origins must contain '*' or include http://,https://,…".
    const origins = [
      'chatterang-desktop://app',
      'capacitor://localhost',
      'ionic://localhost',
      'chrome-extension://abcdef',
      'x-custom+scheme.v2://host:8080',
      // Schemes that begin with the letters "http" but are not http(s): a bare
      // `httpx://host` measured a panic.
      'httpx://host',
      'https+x://host',
      'http-foo://x',
      'http://192.168.1.10:5273',
      'https://chat.example.com',
      'http://[::1]:5273',
    ];
    for (const origin of origins) {
      const setting = ollamaOriginsSetting(origin);
      expect(setting.kind, origin).toBe('add');
      if (setting.kind !== 'add') continue;
      expect(ollamaStartsWith(setting.value), setting.value).toBe(true);
      // One entry, never split or padded by what OLLAMA_ORIGINS is parsed with.
      expect(setting.value, origin).not.toMatch(/[,\s]/);
      if (/^https?:\/\//.test(origin)) {
        expect(setting.value, origin).toBe(origin);
      } else {
        expect(setting.value, origin).toContain('*');
        expect(setting.value, origin).toBe(origin.replace('://', ':*//'));
      }
    }
  });

  it('prints the measured value, which admits this app and refuses every measured look-alike', () => {
    const desktop = ollamaOriginsSetting('chatterang-desktop://app');
    const ios = ollamaOriginsSetting('capacitor://localhost');
    if (desktop.kind !== 'add' || ios.kind !== 'add') throw new Error('expected values');
    expect(measuredAdmits(desktop.value, 'chatterang-desktop://app')).toBe(true);
    for (const lookAlike of [
      'xchatterang-desktop://app',
      'evil.chatterang-desktop://app',
      'chatterang-desktop://app-evil',
      'chatterang-desktop://evil',
      'chatterang-desktop://app:1',
      'chatterang-desktop://x.app',
      'chatterang-desktop-x://app',
      'capacitor://localhost',
    ]) {
      expect(measuredAdmits(desktop.value, lookAlike), lookAlike).toBe(false);
    }
    expect(measuredAdmits(ios.value, 'capacitor://localhost')).toBe(true);
    for (const lookAlike of [
      'xcapacitor://localhost',
      'capacitor://localhost.evil',
      'capacitor://evil',
      'capacitor://localhost:1',
      'chatterang-desktop://app',
    ]) {
      expect(measuredAdmits(ios.value, lookAlike), lookAlike).toBe(false);
    }
    // Why not a leading star: `*chatterang-desktop://app` measured 200 for both
    // of these, and the value printed refuses them.
    for (const lookAlike of ['xchatterang-desktop://app', 'evil.chatterang-desktop://app']) {
      expect(measuredAdmits('*chatterang-desktop://app', lookAlike), lookAlike).toBe(true);
    }
  });
});

/* ── The note, rendered ──────────────────────────────────────────────── */

function renderPanelAt(origin: string): { body: HTMLElement; unmount: () => void } {
  vi.stubGlobal('location', { origin, href: `${origin}/` });
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(createElement(ProvidersPanel));
  });
  return {
    body: document.body,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

function providerItem(body: HTMLElement, label: string): HTMLElement {
  const item = [...body.querySelectorAll<HTMLElement>('button.list__item')].find(
    (button) => button.querySelector('.list__title')?.textContent === label,
  );
  if (!item) throw new Error(`no list item for ${label}`);
  return item;
}

function codes(element: Element): string[] {
  return [...element.querySelectorAll('code')].map((code) => code.textContent ?? '');
}

/** The Ollama list item's words and code values at one origin, rendered and torn down. */
function ollamaAt(origin: string): { text: string; codes: string[] } {
  const page = renderPanelAt(origin);
  try {
    const ollama = providerItem(page.body, 'Ollama');
    return { text: ollama.textContent ?? '', codes: codes(ollama) };
  } finally {
    page.unmount();
    vi.unstubAllGlobals();
  }
}

describe('the Ollama note in the Providers panel', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  it('shows the value for the origin the page is at when it renders', () => {
    const desktop = renderPanelAt('chatterang-desktop://app');
    const ollamaOnDesktop = providerItem(desktop.body, 'Ollama');
    expect(codes(ollamaOnDesktop)).toEqual(['OLLAMA_ORIGINS', 'chatterang-desktop:*//app']);
    expect(ollamaOnDesktop.textContent).toContain(
      'Requests go to the address you give. Nothing here checks that it is on your network. Ollama refuses this app until its OLLAMA_ORIGINS setting allows it. Add chatterang-desktop:*//app to that setting. If it already has a value, put a comma between them, with no spaces. If you set it from a shell, put the value in quotes. Restart Ollama for the change to take effect.',
    );
    desktop.unmount();

    // Same module, same import, another origin: the value follows it.
    const ios = renderPanelAt('capacitor://localhost');
    const ollamaOnIos = providerItem(ios.body, 'Ollama');
    expect(codes(ollamaOnIos)).toEqual(['OLLAMA_ORIGINS', 'capacitor:*//localhost']);
    expect(ollamaOnIos.textContent).not.toContain('chatterang-desktop');
    expect(ollamaOnIos.textContent).toContain(
      'Requests go to the address you give. Nothing here checks that it is on your network. Ollama refuses this app until its OLLAMA_ORIGINS setting allows it. Add capacitor:*//localhost to that setting. Other iOS apps built on the same framework send the same origin as this app by default, so this value also lets them reach Ollama if they can reach the machine it runs on. If it already has a value, put a comma between them, with no spaces. If you set it from a shell, put the value in quotes. Restart Ollama for the change to take effect.',
    );
    ios.unmount();

    const lan = renderPanelAt('http://192.168.1.10:5273');
    expect(codes(providerItem(lan.body, 'Ollama'))).toEqual([
      'OLLAMA_ORIGINS',
      'http://192.168.1.10:5273',
    ]);
    lan.unmount();
  });

  it('says the value is shared only at the default Capacitor iOS origin', () => {
    // `capacitor://localhost` is every default-configured Capacitor iOS app's
    // origin, so its value (`capacitor:*//localhost`) admits them all. Any other
    // origin that gets a value, look-alikes on the same scheme included, does
    // not get that sentence: its value admits that origin alone.
    const shared = 'Other iOS apps built on the same framework';
    expect(ollamaAt('capacitor://localhost').text).toContain(shared);
    for (const origin of [
      'chatterang-desktop://app',
      'http://192.168.1.10:5273',
      'https://chat.example.com',
      'capacitor://evil',
      'capacitor://localhost:8080',
      'xcapacitor://localhost',
      'ionic://localhost',
      'null',
      'https://localhost',
    ]) {
      const { text } = ollamaAt(origin);
      expect(text, origin).not.toContain(shared);
      expect(text, origin).not.toContain('iOS');
    }
  });

  it('says to quote the value exactly when it shows one', () => {
    // A value holding `*` unquoted in zsh fails with "no matches found".
    const quote = 'If you set it from a shell, put the value in quotes.';
    for (const origin of [
      'chatterang-desktop://app',
      'capacitor://localhost',
      'http://192.168.1.10:5273',
      'http://[::1]:5273',
    ]) {
      const page = ollamaAt(origin);
      expect(page.codes, origin).toHaveLength(2);
      expect(page.text, origin).toContain(quote);
    }
    // No value: Ollama already allows the origin, or the app cannot tell.
    for (const origin of ['https://localhost', 'http://localhost:5273', 'vscode-file://vscode-app', 'null']) {
      const page = ollamaAt(origin);
      expect(page.codes.length, origin).toBeLessThan(2);
      expect(page.text, origin).not.toContain('quotes');
    }
  });

  it('asks for no setting where Ollama already allows the origin', () => {
    for (const origin of ['https://localhost', 'http://localhost:5273']) {
      const page = renderPanelAt(origin);
      const ollama = providerItem(page.body, 'Ollama');
      expect(ollama.textContent, origin).toContain(
        'Requests go to the address you give. Nothing here checks that it is on your network.',
      );
      expect(page.body.textContent, origin).not.toContain('OLLAMA_ORIGINS');
      expect(codes(page.body), origin).toEqual([]);
      page.unmount();
      vi.unstubAllGlobals();
    }
  });

  it('says it cannot tell, and prints no value, for an opaque origin', () => {
    const page = renderPanelAt('null');
    const ollama = providerItem(page.body, 'Ollama');
    expect(ollama.textContent).toContain(
      'This app cannot tell which origin it sends, so it cannot say what, if anything, Ollama’s OLLAMA_ORIGINS setting needs.',
    );
    expect(codes(ollama)).toEqual(['OLLAMA_ORIGINS']);
    expect(ollama.textContent).not.toMatch(/\bnull\b/);
    expect(ollama.textContent).not.toContain('Add ');
    page.unmount();
  });

  it('is the only provider that mentions OLLAMA_ORIGINS', () => {
    const page = renderPanelAt('chatterang-desktop://app');
    for (const provider of PROVIDERS) {
      const text = providerItem(page.body, provider.label).textContent ?? '';
      if (provider.id === 'ollama') expect(text).toContain('OLLAMA_ORIGINS');
      else expect(text, provider.id).not.toContain('OLLAMA_ORIGINS');
    }
    page.unmount();

    // And in the catalog: no other note or origin note, at any shipped origin.
    for (const provider of PROVIDERS) {
      if (provider.id === 'ollama') continue;
      expect(provider.note, provider.id).not.toContain('OLLAMA_ORIGINS');
      expect(provider.originNote, provider.id).toBeUndefined();
    }
    expect(getProvider('ollama')?.note).not.toContain('OLLAMA_ORIGINS');
  });

  it('carries the value onto the add-connection sheet too', () => {
    const page = renderPanelAt('capacitor://localhost');
    act(() => {
      providerItem(page.body, 'Ollama').click();
    });
    const sheet = page.body.querySelector('[role="dialog"]');
    expect(sheet, 'the Connect Ollama sheet').not.toBeNull();
    expect(sheet?.textContent).toContain('Connect Ollama');
    // The "What this means" card; the address field's hint has its own <code>.
    const meaning = sheet?.querySelector('.card--remote');
    expect(meaning?.textContent).toContain('What this means');
    expect(codes(meaning!)).toEqual(['OLLAMA_ORIGINS', 'capacitor:*//localhost']);
    // The sheet is where the connection is made, so it carries both rulings too.
    expect(meaning?.textContent).toContain('Other iOS apps built on the same framework');
    expect(meaning?.textContent).toContain('If you set it from a shell, put the value in quotes.');
    page.unmount();
  });
});
