/**
 * The application menu, as DATA.
 *
 * WHY THIS FILE EXISTS AT ALL. `src/lib/keys.ts` built a dispatch layer with
 * two doors and shipped with nothing standing at the second one: there was no
 * menu, no accelerator and no global shortcut anywhere in `apps/desktop`, so
 * the seam was a seam between the app and nobody. This is the caller that
 * makes it real.
 *
 * WHY IT IMPORTS NO ELECTRON. Same reason as `./security.ts`: importing
 * `main.ts` needs a live Electron runtime, so anything decided there is
 * decided where no test can reach it. This module answers "what is in the
 * menu, what are its accelerators, and which command does each item send?"
 * with a plain array, and `tests/desktop-menu.test.ts` drives it directly.
 * `main.ts` does the one Electron-shaped thing left: turn `command` into a
 * `click` that sends down the bridge.
 *
 * WHY THERE IS A WHOLE MENU AND NOT JUST OUR THREE ITEMS. Calling
 * `Menu.setApplicationMenu` REPLACES the default menu, and on macOS the
 * default menu is what makes Cmd+C, Cmd+V, Cmd+Z and Cmd+Q work in a
 * sandboxed renderer — those are menu roles, not browser behaviour. A menu
 * that contained only "New Chat" would have wired one accelerator and silently
 * removed a dozen. So the standard roles are all here, and
 * `tests/desktop-menu.test.ts` asserts they stay.
 *
 * ESCAPE, AND WHAT REGISTERING IT COSTS. A menu accelerator is taken by the
 * MAIN process before the renderer sees the key, so listing `Escape` here
 * means the page's own keydown listener never runs for it. That is acceptable
 * for exactly one reason, checked rather than assumed: `layer.close` is the
 * only thing in this app bound to Escape, and it is what the menu item sends —
 * the same command, by a different road. If Escape ever acquires a second
 * meaning in the page, this item is the thing that has to change.
 */

/** A command id from `src/lib/keys.ts`. Spelled out; see the note below. */
export type MenuCommand =
  | 'chat.new'
  | 'chat.focusComposer'
  | 'chat.next'
  | 'chat.previous'
  | 'layer.close';

/**
 * One entry in an Electron menu template, plus our own `command`.
 *
 * Structurally what `Menu.buildFromTemplate` accepts, minus everything this
 * app does not use. `command` is not Electron's — `main.ts` strips it into a
 * `click`, and a template still carrying one has not been wired.
 */
export interface MenuTemplateItem {
  readonly label?: string;
  readonly role?: string;
  readonly type?: 'separator';
  readonly accelerator?: string;
  readonly command?: MenuCommand;
  readonly submenu?: readonly MenuTemplateItem[];
}

/**
 * The commands the menu can send, with the chord each one advertises.
 *
 * THE CHORDS ARE THE SAME STRINGS `COMMANDS` IN `src/lib/keys.ts` DESCRIBES,
 * in Electron's spelling. They are duplicated rather than imported because
 * `tests/layering.test.ts` forbids `apps/desktop` and `src` importing each
 * other's internals — the renderer bundle also ships as a web app and two
 * Capacitor apps, none of which have a main process. `tests/desktop-menu
 * .test.ts` reads BOTH files and asserts the two tables agree, which is the
 * check that a duplicate needs and an import would not have needed.
 *
 * `CmdOrCtrl+N` is the case worth naming: a browser eats it and there is
 * nothing a page can do about that, which is exactly why the accelerator has
 * to exist here. In the shell the main process takes the chord first and the
 * command arrives through the bridge at the same handler the key press would
 * have reached.
 */
export const MENU_COMMANDS: readonly {
  readonly command: MenuCommand;
  readonly label: string;
  readonly accelerator: string;
}[] = Object.freeze([
  { command: 'chat.new', label: 'New Chat', accelerator: 'CmdOrCtrl+N' },
  { command: 'chat.focusComposer', label: 'Focus Composer', accelerator: 'CmdOrCtrl+L' },
  { command: 'chat.next', label: 'Next Chat', accelerator: 'CmdOrCtrl+Alt+Down' },
  { command: 'chat.previous', label: 'Previous Chat', accelerator: 'CmdOrCtrl+Alt+Up' },
  { command: 'layer.close', label: 'Close Panel', accelerator: 'Escape' },
]);

const item = (command: MenuCommand): MenuTemplateItem => {
  const found = MENU_COMMANDS.find((entry) => entry.command === command);
  /* c8 ignore next */
  if (!found) throw new Error(`menu: no command named "${command}"`);
  return { label: found.label, accelerator: found.accelerator, command: found.command };
};

const SEPARATOR: MenuTemplateItem = { type: 'separator' };

/**
 * Build the whole application menu.
 *
 * @param options.appName - what the macOS application menu is titled.
 * @param options.isMac - whether to emit the macOS-shaped menu. A parameter
 *   rather than a read of `process.platform`, so both shapes are testable on
 *   one machine — which is the same reason `capabilities().id` is banned in
 *   `src/`, one process over.
 * @returns a template `Menu.buildFromTemplate` accepts once `command` is
 *   turned into a `click`.
 */
export function buildMenuTemplate(options: {
  appName: string;
  isMac: boolean;
}): readonly MenuTemplateItem[] {
  const { appName, isMac } = options;

  const appMenu: readonly MenuTemplateItem[] = isMac
    ? [
        {
          label: appName,
          submenu: [
            { role: 'about' },
            SEPARATOR,
            { role: 'services' },
            SEPARATOR,
            { role: 'hide' },
            { role: 'hideOthers' },
            { role: 'unhide' },
            SEPARATOR,
            { role: 'quit' },
          ],
        },
      ]
    : [];

  return [
    ...appMenu,
    {
      label: '&File',
      submenu: [
        item('chat.new'),
        SEPARATOR,
        item('layer.close'),
        SEPARATOR,
        // `close` on macOS (the app stays running); `quit` elsewhere, where
        // closing the last window is how the app ends.
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    {
      // THE ROLES THAT ARE NOT DECORATION. Without this submenu, Cmd+C and
      // Cmd+V do nothing at all in a sandboxed renderer on macOS.
      label: '&Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        SEPARATOR,
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: '&View',
      submenu: [
        { role: 'reload' },
        { role: 'toggleDevTools' },
        SEPARATOR,
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        SEPARATOR,
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: '&Chat',
      submenu: [
        item('chat.focusComposer'),
        SEPARATOR,
        item('chat.next'),
        item('chat.previous'),
      ],
    },
    {
      label: '&Window',
      submenu: isMac
        ? [{ role: 'minimize' }, { role: 'zoom' }, SEPARATOR, { role: 'front' }]
        : [{ role: 'minimize' }, { role: 'close' }],
    },
  ];
}

/** Every command the template actually sends. Used by the tests. */
export function commandsInTemplate(
  template: readonly MenuTemplateItem[],
): readonly MenuCommand[] {
  const found: MenuCommand[] = [];
  const walk = (items: readonly MenuTemplateItem[]): void => {
    for (const entry of items) {
      if (entry.command) found.push(entry.command);
      if (entry.submenu) walk(entry.submenu);
    }
  };
  walk(template);
  return found;
}
