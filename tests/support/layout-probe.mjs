/**
 * The layout probe: a REAL engine, driven headlessly.
 *
 * WHY THIS EXISTS. `tests/support/css.ts` resolves the cascade, the custom
 * property graph and `calc()`, and its own docstring says it is not a layout
 * engine. That is not a quibble: the defect this file was written to catch —
 * a grid row left at `auto`, so the session column grew past the viewport and
 * was clipped by an ancestor's `overflow: hidden` instead of scrolling — is
 * INVISIBLE to a static resolver by construction. Every declaration involved
 * is correct on its own. Only a box tree knows the row is too tall.
 *
 * So this is Chromium, in an Electron window with `show: false`, at real
 * widths, answering with `getBoundingClientRect`, `scrollHeight` and
 * `elementFromPoint`. It is spawned by `tests/layout-engine.test.ts`, which
 * owns every assertion; this file only measures, and it measures everything in
 * ONE launch because a launch costs ~2 s.
 *
 * WHAT IT DRIVES. The app from the Vite dev server, in its own source — not a
 * fixture, not a hand-written copy of the markup. The 200 chats are seeded
 * through `globalThis.__chatterang`, the development handle `src/main.tsx`
 * already publishes, so the rows in the list are the rows the app renders.
 *
 * TWO HARNESS LIES CAUGHT PREVIOUSLY, recorded here so they are not
 * rediscovered by whoever extends this file:
 *
 *   - CDP `Input.dispatchKeyEvent` with type `'rawKeyDown'` SKIPS the key's
 *     default action, which makes a working command look broken. Nothing here
 *     synthesises keys; the probe clicks and measures.
 *   - a scripted `el.focus()` in a hidden window sets `document.activeElement`
 *     but does NOT match `:focus`, so every input looks like it has no focus
 *     ring. Focus-ring assertions therefore live in the static suite, against
 *     the declaration, and not here.
 *
 * Usage: electron tests/support/layout-probe.mjs --url=<origin> --out=<file>
 */

import { writeFileSync } from 'node:fs';

import { app, BrowserWindow } from 'electron';

const args = new Map(
  process.argv
    .slice(2)
    .filter((arg) => arg.startsWith('--'))
    .map((arg) => {
      const at = arg.indexOf('=');
      return at === -1 ? [arg.slice(2), ''] : [arg.slice(2, at), arg.slice(at + 1)];
    }),
);

const URL_UNDER_TEST = args.get('url') ?? '';
const OUT = args.get('out') ?? '';
/** How many chats to seed. The point is a list far longer than one screen. */
const CHATS = Number(args.get('chats') ?? '200');

/** Widths the probe visits. Every one is a tier boundary or a real window. */
const WIDTHS = [390, 900, 1184, 1440];
const HEIGHT = 800;

const seedScript = (count) => `
  (() => {
    const store = globalThis.__chatterang.useChats;
    const now = Date.now();
    const chats = Array.from({ length: ${count} }, (_, index) => ({
      id: 'seed_' + String(index).padStart(4, '0'),
      // Numbered from the END so the last row in the list is "Seeded chat 1"
      // and the assertion can name the row it expects to reach.
      title: 'Seeded chat ' + (${count} - index),
      mode: 'chat',
      personaId: null,
      modelId: null,
      sampler: null,
      tools: [],
      showThinking: false,
      createdAt: now - index * 1000,
      updatedAt: now - index * 1000,
      pinned: false,
      messageCount: 2,
      preview: 'A seeded conversation used to prove the list is reachable.',
    }));
    // Two turns as well as the chats: without a thread the chat pane renders
    // the empty state, and the reading measure — the thing the whole tier
    // ladder is built to protect — would have no box to measure.
    const messages = [
      {
        id: 'seed_msg_user',
        chatId: chats[0].id,
        role: 'user',
        content: 'What does this app do with my conversation?',
        createdAt: now - 2000,
      },
      {
        id: 'seed_msg_assistant',
        chatId: chats[0].id,
        role: 'assistant',
        content:
          'Everything stays on this device unless you connect a remote provider, ' +
          'and a reply that came from one is marked as such in the transcript.',
        createdAt: now - 1000,
      },
    ];
    store.setState({ loaded: true, chats, activeChatId: chats[0].id, messages });
    return chats.length;
  })()
`;

/** Resolve once the page satisfies `predicate` (a JS expression), or throw. */
async function waitFor(contents, predicate, what, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let value = false;
    try {
      value = await contents.executeJavaScript(`Boolean(${predicate})`);
    } catch {
      value = false;
    }
    if (value) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/**
 * Set the viewport and let the engine finish with it.
 *
 * Two animation frames rather than one: the first flushes the resize into
 * style and layout, the second guarantees anything React scheduled in response
 * has committed before a rect is read.
 */
async function setWidth(window, width) {
  window.setContentSize(width, HEIGHT);
  await window.webContents.executeJavaScript(`
    new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(
      () => resolve(innerWidth)
    )))
  `);
}

/**
 * The measurement, run in the page.
 *
 * `container` is the scroll container under test and `owner` the box that is
 * supposed to bound it. Reachability is answered three ways, because each one
 * alone has a way of being true while the user still cannot get to the row:
 *
 *   - `scrolls`      — the container really is the scroller (it has overflow
 *                      to give AND a clientHeight to scroll within).
 *   - `lastVisible`  — after scrolling to the end, the last row's box is
 *                      inside the container's box.
 *   - `lastHit`      — `elementFromPoint` at the middle of that row lands
 *                      inside it. This is the one that fails when the row is
 *                      painted but covered, or laid out past the viewport.
 */
const probeList = (containerSelector, rowSelector) => `
  (() => {
    const container = document.querySelector(${JSON.stringify(containerSelector)});
    if (!container) return { present: false };
    container.scrollTop = container.scrollHeight;
    const rows = container.querySelectorAll(${JSON.stringify(rowSelector)});
    const box = container.getBoundingClientRect();
    const result = {
      present: true,
      rows: rows.length,
      scrollHeight: container.scrollHeight,
      clientHeight: container.clientHeight,
      scrollTop: container.scrollTop,
      overflows: container.scrollHeight > container.clientHeight + 1,
      scrolls: container.scrollTop > 0,
      top: box.top,
      bottom: box.bottom,
      viewportHeight: innerHeight,
      withinViewport: box.bottom <= innerHeight + 0.5 && box.top >= -0.5,
    };
    const last = rows[rows.length - 1];
    if (!last) return { ...result, lastVisible: false, lastHit: false };
    const lastBox = last.getBoundingClientRect();
    result.lastTitle = (last.textContent ?? '').trim().slice(0, 40);
    result.lastTop = lastBox.top;
    result.lastBottom = lastBox.bottom;
    result.lastVisible = lastBox.bottom <= box.bottom + 1 && lastBox.top >= box.top - 1;
    const x = lastBox.left + Math.min(80, lastBox.width / 2);
    const y = lastBox.top + lastBox.height / 2;
    const hit = document.elementFromPoint(x, y);
    result.lastHit = Boolean(hit && last.contains(hit));
    result.hitTag = hit ? hit.tagName + '.' + hit.className : null;
    return result;
  })()
`;

/** Every box wider than the document. `body { overflow: hidden }` hides this. */
const overflowScan = `
  (() => {
    const room = document.documentElement.clientWidth;
    const wide = [];
    for (const el of document.querySelectorAll('*')) {
      const box = el.getBoundingClientRect();
      if (box.width === 0) continue;
      if (box.right > room + 1 || box.left < -1) {
        wide.push(el.tagName + '.' + String(el.className).trim().replace(/\\s+/g, '.'));
      }
    }
    return [...new Set(wide)];
  })()
`;

/**
 * `1ch` for each face the stack can resolve to, measured rather than assumed.
 *
 * `ch` is the advance of "0" IN THE FONT THAT ACTUALLY RENDERED. The reading
 * measure is 66ch, so the width of the text column — and therefore the width
 * at which a third column can open without stealing from it — depends on
 * whether the web font is resident. Both ends are measured here and the tier
 * is checked against the wider one, because the wider one is the offline case
 * and the cold-start case, not a hypothetical.
 *
 * `advance` is the average advance of real prose in the same face, which is
 * what turns 66ch into a number of RENDERED characters.
 */
const fontMetrics = `
  (() => {
    const PROSE = 'The model is running on this device and nothing you type is sent anywhere.';
    /*
     * `ch` IS MEASURED AS A LENGTH, NOT AS A STRING OF ZEROES.
     *
     * Both were tried. For Archivo they agree; for the resolved fallback face
     * they do NOT — 9.2139px for a rendered '0' against 9.4482px for the
     * `ch` unit, a 2.5% gap, which is 15px of reading column at 66ch and
     * enough to put the workbench threshold in the wrong place. The unit is
     * what `--measure: 66ch` actually resolves through, so the unit is what is
     * measured here. The rendered advance is measured too, separately, because
     * that is what turns 66ch into a number of CHARACTERS.
     */
    const measure = (family) => {
      const box = document.createElement('div');
      box.style.cssText =
        'position:absolute;visibility:hidden;width:100ch;font-size:15px;font-family:' + family;
      document.body.append(box);
      const unit = box.getBoundingClientRect().width / 100;
      box.remove();

      const probe = document.createElement('span');
      probe.style.cssText =
        'position:absolute;visibility:hidden;white-space:pre;font-size:15px;font-family:' + family;
      probe.textContent = '0'.repeat(100);
      document.body.append(probe);
      const zero = probe.getBoundingClientRect().width / 100;
      probe.textContent = PROSE;
      const prose = probe.getBoundingClientRect().width / PROSE.length;
      probe.remove();
      return { ch: unit, renderedZero: zero, advance: prose };
    };
    const declared = getComputedStyle(document.documentElement)
      .getPropertyValue('--font-ui')
      .trim();
    // The same stack with the web font removed: what renders offline, on a
    // cold start before the swap, and for anyone who blocks web fonts.
    const fallback = declared
      .split(',')
      .filter((name) => !name.toLowerCase().includes('archivo'))
      .join(',');
    return {
      declared,
      archivoResident: document.fonts.check('15px Archivo'),
      withArchivo: measure(declared),
      fallback: measure(fallback),
    };
  })()
`;

/** What a control that has to hold a fixed string actually does with it. */
const placeholderFit = `
  (() => {
    const field = document.querySelector('.composer__input');
    if (!field) return { present: false };
    const style = getComputedStyle(field);
    const probe = document.createElement('span');
    probe.style.cssText =
      'position:absolute;visibility:hidden;white-space:pre;font:' + style.font;
    probe.textContent = field.placeholder;
    document.body.append(probe);
    const textWidth = probe.getBoundingClientRect().width;
    probe.remove();
    const room =
      field.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    return {
      present: true,
      placeholder: field.placeholder,
      textWidth,
      room,
      fits: textWidth <= room,
      fieldHeight: field.getBoundingClientRect().height,
      lineHeight: parseFloat(style.lineHeight),
    };
  })()
`;

const geometry = `
  (() => {
    const box = (selector) => {
      const el = document.querySelector(selector);
      if (!el) return null;
      const rect = el.getBoundingClientRect();
      return {
        width: rect.width,
        height: rect.height,
        left: rect.left,
        top: rect.top,
        bottom: rect.bottom,
        display: getComputedStyle(el).display,
      };
    };
    const thread = document.querySelector('.thread');
    const threadStyle = thread ? getComputedStyle(thread) : null;
    // The reading MEASURE is the text's width, not the container's: each
    // container adds its own gutters on top, and it is the text edge the tier
    // ladder is written to hold steady.
    const measure = thread
      ? thread.getBoundingClientRect().width -
        parseFloat(threadStyle.paddingLeft) -
        parseFloat(threadStyle.paddingRight)
      : null;
    return {
      viewport: { width: innerWidth, height: innerHeight },
      rail: box('.tabbar'),
      history: box('.history'),
      chatMain: box('.chat__main'),
      body: box('.app__body--split'),
      thread: thread
        ? {
            width: thread.getBoundingClientRect().width,
            left: thread.getBoundingClientRect().left,
            measure,
          }
        : null,
      rows: document.querySelectorAll('.history .list__item').length,
      // What a row in the session column actually gives the title, which is
      // the number tokens.css derives the column's 304px from.
      historyRow: (() => {
        const item = document.querySelector('.history .list__item');
        const title = document.querySelector('.history .list__item .list__title');
        const body = document.querySelector('.history__body');
        if (!item || !title || !body) return null;
        const bodyStyle = getComputedStyle(body);
        return {
          bodyPaddingInline:
            parseFloat(bodyStyle.paddingLeft) + parseFloat(bodyStyle.paddingRight),
          itemWidth: item.getBoundingClientRect().width,
          titleWidth: title.getBoundingClientRect().width,
          iconButton: document
            .querySelector('.history .list__item .icon-btn')
            ?.getBoundingClientRect().width,
        };
      })(),
      historyToggleShown:
        getComputedStyle(document.querySelector('.chat__history-toggle')).display !== 'none',
    };
  })()
`;

/** Filled as the probe goes, so a failure still reports what it did measure. */
const out = { seeded: 0, widths: {}, consoleErrors: [] };

async function run() {
  const window = new BrowserWindow({
    show: false,
    frame: false,
    width: 1440,
    height: HEIGHT,
    webPreferences: { backgroundThrottling: false },
  });
  const contents = window.webContents;
  contents.on('console-message', (event) => {
    if (event.level === 'error') out.consoleErrors.push(String(event.message).slice(0, 300));
  });

  await contents.loadURL(URL_UNDER_TEST);
  await waitFor(contents, `document.querySelector('.app')`, 'the app shell to mount');
  // The boot effect opens the most recent chat or creates one. Seeding before
  // it settles would be overwritten by whatever it does next.
  await waitFor(
    contents,
    `globalThis.__chatterang && __chatterang.useChats.getState().activeChatId`,
    'the chat store to settle',
  );
  out.seeded = await contents.executeJavaScript(seedScript(CHATS));
  await waitFor(
    contents,
    `document.querySelectorAll('.history .list__item, .sheet .list__item').length > 0 ||
     document.querySelectorAll('.list__item').length > 0`,
    'the seeded rows to render',
  );

  for (const width of WIDTHS) {
    await setWidth(window, width);
    const record = {
      geometry: await contents.executeJavaScript(geometry),
      column: await contents.executeJavaScript(probeList('.history__body', '.list__item')),
      overflowing: await contents.executeJavaScript(overflowScan),
      placeholder: await contents.executeJavaScript(placeholderFit),
    };

    // The sheet, opened the way a user opens it: the rail's button. Below the
    // workbench tier that button is the only route to the list, so a clipped
    // sheet is the same defect wearing a different container.
    const toggleShown = record.geometry.historyToggleShown;
    if (toggleShown) {
      await contents.executeJavaScript(
        `document.querySelector('.chat__history-toggle').click(), true`,
      );
      await waitFor(contents, `document.querySelector('.sheet')`, 'the chat sheet to open');
      // The sheet slides up over --dur-slow. Measuring during the transform
      // reports a box halfway off the bottom of the window, which looks
      // exactly like the clipping defect and is not it.
      await contents.executeJavaScript(`
        Promise.all(
          document.querySelector('.sheet').getAnimations().map((a) => a.finished.catch(() => null)),
        ).then(() => true)
      `);
      await setWidth(window, width);
      record.sheet = await contents.executeJavaScript(probeList('.sheet__body', '.list__item'));
      record.sheetBox = await contents.executeJavaScript(`
        (() => {
          const sheet = document.querySelector('.sheet').getBoundingClientRect();
          return { top: sheet.top, bottom: sheet.bottom, height: sheet.height, viewport: innerHeight };
        })()
      `);
      await contents.executeJavaScript(
        `document.querySelector('.sheet [aria-label="Close"]').click(), true`,
      );
      await waitFor(contents, `!document.querySelector('.sheet')`, 'the chat sheet to close');
    }
    out.widths[width] = record;
  }

  out.fonts = await contents.executeJavaScript(fontMetrics);

  /*
   * THE SWEEP, in both faces.
   *
   * The ladder's one promise is that the reading measure never gets SMALLER as
   * the window gets bigger. The static suite computes that from the sheet; this
   * measures the box, at every threshold boundary, and it does it twice —
   * once with whatever face is resident, and once with the web font removed
   * from the stack, which is what renders offline, during the swap on a cold
   * load, and for anyone who blocks web fonts. The fallback face is the wider
   * one, so it is the one that decides where a third column may open.
   */
  const SWEEP = [
    600, 640, 767, 900, 919, 920, 921, 1024, 1151, 1152, 1183, 1184, 1185, 1199, 1200, 1201, 1280,
    1440, 1680, 1920,
  ];
  out.sweep = {};
  for (const face of ['declared', 'fallback']) {
    if (face === 'fallback') {
      await contents.executeJavaScript(`
        (() => {
          const declared = getComputedStyle(document.documentElement)
            .getPropertyValue('--font-ui');
          const without = declared
            .split(',')
            .filter((name) => !name.toLowerCase().includes('archivo'))
            .join(',');
          document.documentElement.style.setProperty('--font-ui', without);
          return without;
        })()
      `);
    }
    const measures = {};
    for (const width of SWEEP) {
      await setWidth(window, width);
      measures[width] = await contents.executeJavaScript(`
        (() => {
          const thread = document.querySelector('.thread');
          if (!thread) return null;
          const style = getComputedStyle(thread);
          return (
            thread.getBoundingClientRect().width -
            parseFloat(style.paddingLeft) -
            parseFloat(style.paddingRight)
          );
        })()
      `);
    }
    out.sweep[face] = measures;
  }
  await contents.executeJavaScript(
    `document.documentElement.style.removeProperty('--font-ui'), true`,
  );
}

app.whenReady().then(async () => {
  let failed = false;
  try {
    await run();
  } catch (error) {
    // Partial measurements are still written. A probe that reported nothing on
    // the way to failing would make every failure a mystery.
    out.error = String(error && error.stack ? error.stack : error);
    failed = true;
  }
  writeFileSync(OUT, JSON.stringify(out, null, 2));
  app.exit(failed ? 1 : 0);
});
