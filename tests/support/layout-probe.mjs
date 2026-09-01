/**
 * The layout probe: a REAL engine, driven headlessly.
 *
 * WHY THIS EXISTS. `tests/support/css.ts` resolves the cascade, the custom
 * property graph and `calc()`, and its own docstring says it is not a layout
 * engine. That is not a quibble. The defect this file was written to catch —
 * a session column that laid out 200 chats and let the user reach nine of
 * them — is INVISIBLE to a static resolver by construction. Every declaration
 * involved is correct on its own: `.history__body` had `overflow-y: auto` and
 * `min-height: 0`, which is the whole recipe. Only a box tree knows that its
 * one child had been flex-shrunk to the fold and was clipping the rest.
 *
 * So this is Chromium, in an Electron window with `show: false`, at real
 * widths, answering with `getBoundingClientRect`, `scrollHeight` and
 * `elementFromPoint`. It is spawned by `tests/layout-engine.test.ts`, which
 * owns every assertion; this file only measures, and it measures everything in
 * ONE launch because a launch costs seconds.
 *
 * WHAT IT DRIVES. The app from the Vite dev server, in its own source — not a
 * fixture, not a hand-written copy of the markup. The chats are seeded through
 * `globalThis.__chatterang`, the development handle `src/main.tsx` publishes,
 * so the rows in the list are the rows the app renders.
 *
 * THREE HARNESS LIES, recorded here so they are not rediscovered:
 *
 *   - CDP `Input.dispatchKeyEvent` with type `'rawKeyDown'` SKIPS the key's
 *     default action, which makes a working command look broken. Nothing here
 *     synthesises keys; the probe clicks and measures.
 *   - a scripted `el.focus()` in a hidden window sets `document.activeElement`
 *     but does NOT match `:focus`, so every input looks like it has no focus
 *     ring. Focus-ring assertions therefore live in the static suite, against
 *     the declaration, and not here.
 *   - `Animation.finished` NEVER RESOLVES for the sheet's entry animation in a
 *     hidden window, and an `await` on it hangs the probe forever with no
 *     error and no output. That cost a whole run. Motion is switched off up
 *     front instead (see `KILL_MOTION`), and every evaluation carries its own
 *     deadline so a hang is a named failure rather than a silence.
 *
 * Usage:
 *   electron tests/support/layout-probe.mjs --url=<origin> --out=<file>
 *            [--chats=200] [--widths=390,900,…] [--sweep=600,640,…]
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

const numbers = (raw, fallback) =>
  (raw ?? '').trim() === ''
    ? fallback
    : raw
        .split(',')
        .map((part) => Number(part.trim()))
        .filter((value) => Number.isFinite(value));

const URL_UNDER_TEST = args.get('url') ?? '';
const OUT = args.get('out') ?? '';
/** How many chats to seed. The point is a list far longer than one screen. */
const CHATS = Number(args.get('chats') ?? '200');
/** Widths the probe visits in full. Every one is a tier boundary or a window. */
const WIDTHS = numbers(args.get('widths'), [390, 900, 1199, 1200, 1440]);
/** Widths the reading measure is swept across, in both faces. */
const SWEEP = numbers(args.get('sweep'), [600, 920, 1199, 1200, 1440, 1920]);
const HEIGHT = 800;
/** `--verbose` traces every step to stderr, which is where a hang is found. */
const VERBOSE = args.has('verbose');
const START = Date.now();
const trace = (message) => {
  if (VERBOSE) process.stderr.write(`[probe +${Date.now() - START}ms] ${message}\n`);
};

/**
 * MOTION OFF, FOR THE WHOLE MEASUREMENT.
 *
 * Not a fiction: this is the same thing `base.css` does for
 * `prefers-reduced-motion: reduce`, so it is a configuration the app already
 * ships. It is here because a sheet measured mid-slide reports a box halfway
 * off the bottom of the window — which looks EXACTLY like the clipping defect
 * this file exists to detect, and is not it. The final geometry is the same
 * either way; only the intermediate frames differ, and no assertion is about
 * an intermediate frame.
 */
const KILL_MOTION = `
  (() => {
    const style = document.createElement('style');
    style.id = 'probe-kill-motion';
    style.textContent =
      '*, *::before, *::after {' +
      '  animation-duration: 0s !important;' +
      '  animation-delay: 0s !important;' +
      '  transition-duration: 0s !important;' +
      '  transition-delay: 0s !important;' +
      '}';
    document.head.append(style);
    return true;
  })()
`;

/**
 * DISMISS THE FIRST-RUN SHEET BEFORE ANYTHING IS MEASURED.
 *
 * `App.tsx` opens `Onboarding` — which IS a `Sheet` — whenever nothing is
 * installed, and a dev server has nothing installed. So `document.querySelector
 * ('.sheet')` found the welcome panel rather than the chat list, and the probe
 * spent a whole run measuring the wrong dialog and then hanging on a Close
 * button that closed a sheet it was not waiting for. Marking onboarding seen is
 * what a returning user's state looks like, which is the state every assertion
 * here is about.
 */
const DISMISS_ONBOARDING = `
  (() => {
    const store = globalThis.__chatterang.useApp;
    store.setState({ settings: { ...store.getState().settings, onboardingSeen: true } });
    return true;
  })()
`;

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

/**
 * `executeJavaScript` WITH A DEADLINE.
 *
 * Every evaluation in this file goes through here. An un-deadlined await on a
 * renderer that will never answer is not a slow probe, it is a probe that
 * writes nothing at all — which is how the previous version of this file
 * managed to fail without producing a single measurement or a single line of
 * error.
 */
async function evaluate(contents, expression, what, timeoutMs = 15000) {
  trace(`evaluating ${what}`);
  let timer;
  const deadline = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out evaluating ${what}`)), timeoutMs);
  });
  try {
    return await Promise.race([contents.executeJavaScript(expression), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/** Resolve once the page satisfies `predicate` (a JS expression), or throw. */
async function waitFor(contents, predicate, what, timeoutMs = 30000) {
  trace(`waiting for ${what}`);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let value = false;
    try {
      value = await evaluate(contents, `Boolean(${predicate})`, what, 5000);
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
  await evaluate(
    window.webContents,
    `new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(
      () => resolve(innerWidth)
    )))`,
    `the engine to settle at ${width}px`,
  );
}

/**
 * The measurement, run in the page.
 *
 * `container` is the scroll container under test. Reachability is answered
 * three ways, because each one alone has a way of being true while the user
 * still cannot get to the row:
 *
 *   - `scrolls`      — the container really is the scroller: asked to go to
 *                      the end, it went somewhere.
 *   - `lastVisible`  — after scrolling to the end, the last row's box is
 *                      inside the container's box.
 *   - `lastHit`      — `elementFromPoint` at the middle of that row lands
 *                      inside it. This is the one that fails when the row is
 *                      painted but covered, or laid out past the viewport.
 *
 * `lastHit` is the assertion that matters and the other two explain it. A row
 * can be `lastVisible` and unhittable (something is over it); it can be in a
 * container that `overflows` and still be unreachable, which is exactly the
 * shipped defect — the rows existed, at y=14016, in a box 617px tall that
 * reported `scrollHeight === clientHeight` and so had nothing to scroll.
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
    result.lastTitle = (last.querySelector('.list__title') ?? last).textContent.trim();
    result.lastTop = lastBox.top;
    result.lastBottom = lastBox.bottom;
    result.lastVisible = lastBox.bottom <= box.bottom + 1 && lastBox.top >= box.top - 1;
    const x = lastBox.left + Math.min(80, lastBox.width / 2);
    const y = lastBox.top + lastBox.height / 2;
    const hit = document.elementFromPoint(x, y);
    result.lastHit = Boolean(hit && last.contains(hit));
    result.hitTag = hit ? hit.tagName + '.' + String(hit.className).trim() : null;
    return result;
  })()
`;

/**
 * Every box wider than the document.
 *
 * A FULL SCAN, and not `body.scrollWidth <= body.clientWidth`, which is
 * VACUOUS in this app: `.app` sets `overflow: hidden`, so the body can never
 * report a scroll width larger than its client width whatever is inside it.
 * That assertion passed on every layout it was ever run against, including
 * broken ones.
 */
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
 * is checked against the WIDER one, because the wider one is the offline case
 * and the cold-start case, not a hypothetical.
 *
 * `advance` is the average advance of real prose in the same face, which is
 * what turns 66ch into a number of RENDERED characters.
 */
const fontMetrics = `
  (() => {
    const PROSE = 'The model is running on this device and nothing you type is sent anywhere.';
    /*
     * "ch" IS MEASURED AS A LENGTH, NOT AS A STRING OF ZEROES.
     *
     * Both were tried. For Archivo they agree; for the resolved fallback face
     * they do NOT — a rendered '0' against the "ch" unit differ by ~2.5%,
     * which is 15px of reading column at 66ch and enough to put the workbench
     * threshold in the wrong place. The unit is what "--measure: 66ch"
     * actually resolves through, so the unit is what is measured. The rendered
     * advance is measured too, separately, because that is what turns 66ch
     * into a number of CHARACTERS.
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
      prose: PROSE,
      declared,
      fallbackStack: fallback,
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

/** The width of the TEXT in the thread, which is what the ladder protects. */
const READING_MEASURE = `
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
    const toggle = document.querySelector('.chat__history-toggle');
    return {
      viewport: { width: innerWidth, height: innerHeight },
      rail: box('.tabbar'),
      history: box('.history'),
      chatMain: box('.chat__main'),
      body: box('.app__body--split'),
      thread: box('.thread'),
      measure: ${READING_MEASURE},
      rows: document.querySelectorAll('.history .list__item').length,
      // What a row in the session column actually gives the title, which is
      // the number tokens.css derives the column's width from. Measured, not
      // reasoned: the derivation in that comment omitted .history__body's own
      // padding and the card's borders, and was wrong by 30px because of it.
      historyRow: (() => {
        const item = document.querySelector('.history .list__item');
        const title = document.querySelector('.history .list__item .list__title');
        const body = document.querySelector('.history__body');
        if (!item || !title || !body) return null;
        const bodyStyle = getComputedStyle(body);
        const iconButton = document.querySelector('.history .list__item .icon-btn');
        return {
          columnWidth: document.querySelector('.history').getBoundingClientRect().width,
          bodyPaddingInline:
            parseFloat(bodyStyle.paddingLeft) + parseFloat(bodyStyle.paddingRight),
          bodyClientWidth: body.clientWidth,
          itemWidth: item.getBoundingClientRect().width,
          titleWidth: title.getBoundingClientRect().width,
          iconButton: iconButton ? iconButton.getBoundingClientRect().width : null,
        };
      })(),
      historyToggleShown: toggle ? getComputedStyle(toggle).display !== 'none' : false,
    };
  })()
`;

/** Filled as the probe goes, so a failure still reports what it did measure. */
const out = { seeded: 0, widths: {}, sweep: {}, consoleErrors: [] };

/**
 * Open the sheet the way a user does — the rail's button — and measure it.
 *
 * Below the workbench tier that button is the only route to the list, so a
 * clipped sheet is the same defect wearing a different container. Geometry is
 * read only once the sheet's box has stopped moving: motion is already off,
 * and this is the belt to that pair of braces.
 */
async function measureSheet(contents) {
  await evaluate(
    contents,
    `document.querySelector('.chat__history-toggle').click(), true`,
    'the history toggle to be clicked',
  );
  // The sheet holding the LIST, named by its content rather than by being the
  // only `.sheet` on the page — which it has not always been.
  await waitFor(
    contents,
    `document.querySelector('.sheet .list__item')`,
    'the chat sheet and its rows to appear',
  );
  await waitFor(
    contents,
    `(() => {
       const sheet = document.querySelector('.sheet');
       if (!sheet) return false;
       const top = sheet.getBoundingClientRect().top;
       const settled = globalThis.__probeSheetTop === top;
       globalThis.__probeSheetTop = top;
       return settled;
     })()`,
    'the sheet geometry to stop moving',
    5000,
  );
  const sheet = await evaluate(
    contents,
    probeList('.sheet__body', '.list__item'),
    'the sheet list',
  );
  const sheetBox = await evaluate(
    contents,
    `(() => {
       const sheet = document.querySelector('.sheet').getBoundingClientRect();
       return {
         top: sheet.top,
         bottom: sheet.bottom,
         height: sheet.height,
         viewport: innerHeight,
       };
     })()`,
    'the sheet box',
  );
  await evaluate(
    contents,
    `document.querySelector('.sheet [aria-label="Close"]').click(), true`,
    'the sheet to be closed',
  );
  await waitFor(contents, `!document.querySelector('.sheet')`, 'the chat sheet to close');
  return { sheet, sheetBox };
}

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

  try {
    trace(`loading ${URL_UNDER_TEST}`);
    await contents.loadURL(URL_UNDER_TEST);
    trace('loaded');
    await waitFor(contents, `document.querySelector('.app')`, 'the app shell to mount');
    // The boot effect opens the most recent chat or creates one. Seeding before
    // it settles would be overwritten by whatever it does next.
    await waitFor(
      contents,
      `globalThis.__chatterang && __chatterang.useChats.getState().activeChatId`,
      'the chat store to settle',
    );
    await evaluate(contents, KILL_MOTION, 'motion to be switched off');
    await evaluate(contents, DISMISS_ONBOARDING, 'the first-run sheet to be dismissed');
    await waitFor(contents, `!document.querySelector('.sheet')`, 'no dialog to be open');
    out.seeded = await evaluate(contents, seedScript(CHATS), 'the chats to be seeded');
    await waitFor(
      contents,
      `document.querySelectorAll('.list__item').length >= ${CHATS} &&
       document.querySelector('.thread')`,
      'the seeded rows and thread to render',
    );

    for (const width of WIDTHS) {
      await setWidth(window, width);
      const record = {
        geometry: await evaluate(contents, geometry, `geometry at ${width}px`),
        column: await evaluate(contents, probeList('.history__body', '.list__item'), 'the column'),
        overflowing: await evaluate(contents, overflowScan, `the overflow scan at ${width}px`),
        placeholder: await evaluate(contents, placeholderFit, `the placeholder at ${width}px`),
      };
      if (record.geometry.historyToggleShown) {
        Object.assign(record, await measureSheet(contents));
      }
      out.widths[width] = record;
    }

    out.fonts = await evaluate(contents, fontMetrics, 'the font metrics');

    /*
     * THE SWEEP, IN BOTH FACES.
     *
     * The ladder's one promise is that the reading measure never gets SMALLER
     * as the window gets bigger. The static suite computes that from the
     * sheet; this measures the box, and it does it twice — once with whatever
     * face is resident, and once with the web font removed from the stack,
     * which is what renders offline, during the swap on a cold load, and for
     * anyone who blocks web fonts. The fallback face is the wider one, so it
     * is the one that decides where a third column may open.
     */
    for (const face of ['declared', 'fallback']) {
      if (face === 'fallback') {
        await evaluate(
          contents,
          `(() => {
            const declared = getComputedStyle(document.documentElement)
              .getPropertyValue('--font-ui');
            const without = declared
              .split(',')
              .filter((name) => !name.toLowerCase().includes('archivo'))
              .join(',');
            document.documentElement.style.setProperty('--font-ui', without);
            return without;
          })()`,
          'the web font to be removed from the stack',
        );
      }
      const measures = {};
      for (const width of SWEEP) {
        await setWidth(window, width);
        measures[width] = await evaluate(
          contents,
          READING_MEASURE,
          `the reading measure at ${width}px (${face})`,
        );
      }
      out.sweep[face] = measures;
    }
    await evaluate(
      contents,
      `document.documentElement.style.removeProperty('--font-ui'), true`,
      'the web font to be restored',
    );
  } finally {
    // Destroyed explicitly. A live window has kept `app.exit()` waiting on
    // this machine, and a probe that has measured everything and then hangs is
    // indistinguishable from one that measured nothing.
    if (!window.isDestroyed()) window.destroy();
  }
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
